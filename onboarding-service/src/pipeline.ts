/**
 * 驗證工作：validate → build → scan → code_review（人工程式碼檢查，等待確認）→ platform_test → business_test → preview。
 * 每步寫入 step_results 與證據檔；任何一步失敗、未驗證或掃描未完成，提交都不可送交確認。
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Config } from './config.ts';
import { now, STEPS, type StepName, type StepStatus, type Store } from './db.ts';
import { makeMasker } from './exec.ts';
import { memoryToBytes, type Manifest } from './manifest.ts';
import { freePort, portInUse, type Ctx, type Runtime } from './runtime.ts';
import type { Secrets } from './secrets.ts';
import { prepareModelAccess, toolNetwork } from './relay.ts';

type Sub = { id: string; tool_id: string; version: string; revision: number; source_hash: string; manifest_json: string };

export type CriticalFinding = { id: string; pkg: string; installed: string; fixed: string | null; title: string };

export function summarizeTrivy(json: unknown): { counts: Record<string, number>; critical: CriticalFinding[]; uniqueCves: number } {
  const counts: Record<string, number> = {};
  const critical: CriticalFinding[] = [];
  const ids = new Set<string>();
  const results = (json as { Results?: { Vulnerabilities?: Record<string, string>[] }[] })?.Results ?? [];
  for (const r of results) {
    for (const v of r.Vulnerabilities ?? []) {
      counts[v.Severity] = (counts[v.Severity] ?? 0) + 1;
      ids.add(v.VulnerabilityID);
      if (v.Severity === 'CRITICAL' && !critical.some((c) => c.id === v.VulnerabilityID && c.pkg === v.PkgName)) {
        critical.push({ id: v.VulnerabilityID, pkg: v.PkgName, installed: v.InstalledVersion, fixed: v.FixedVersion || null, title: (v.Title ?? '').slice(0, 160) });
      }
    }
  }
  return { counts, critical, uniqueCves: ids.size };
}

export type VulnItem = {
  id: string; severity: string; category: string; title: string; description: string; url: string | null;
  published: string | null; fixable: boolean; packages: { name: string; installed: string; fixed: string | null }[];
};

const CATEGORIES: [RegExp, string][] = [
  [/remote code execution|arbitrary code|code execution|code injection|execute arbitrary/i, '可能執行任意程式'],
  [/privilege escalation|escalate privileges|gain (?:root|privileges)/i, '權限提升'],
  [/bypass|spoof|verification|certificate|hostname/i, '繞過驗證'],
  [/information disclosure|disclos|leak|exposure|sensitive information/i, '資訊外洩'],
  [/path traversal|directory traversal|symlink/i, '路徑穿越'],
  [/insecure connection|tls|ssl|connection reuse|unauthorized connection|interception/i, '不安全連線'],
  [/injection/i, '注入攻擊'],
  [/denial of service|\bdos\b|crash|infinite loop|resource exhaustion|memory exhaustion|unbounded|hash flooding|quadratic/i, '阻斷服務（可能使程式當掉）'],
  [/overflow|out-of-bounds|use-after-free|double[- ]free|memory corruption|heap|stack/i, '記憶體錯誤'],
];
export function vulnCategory(text: string): string {
  return CATEGORIES.find(([re]) => re.test(text))?.[1] ?? '其他';
}

/** Trivy 結果整理成每個 CVE 一列（同一漏洞出現在多個子套件時合併），CRITICAL 優先，其次有修正版者。 */
export function vulnerabilityList(json: unknown): VulnItem[] {
  const map = new Map<string, VulnItem>();
  const results = (json as { Results?: { Vulnerabilities?: Record<string, string>[] }[] })?.Results ?? [];
  for (const r of results) {
    for (const v of r.Vulnerabilities ?? []) {
      const id = v.VulnerabilityID;
      let item = map.get(id);
      if (!item) {
        const title = (v.Title ?? '').trim();
        const description = (v.Description ?? '').replace(/\s+/g, ' ').trim();
        item = { id, severity: v.Severity, category: vulnCategory(title) !== '其他' ? vulnCategory(title) : vulnCategory(description), title, description: description.slice(0, 400),
          url: v.PrimaryURL || null, published: v.PublishedDate ? v.PublishedDate.slice(0, 10) : null, fixable: false, packages: [] };
        map.set(id, item);
      }
      if (!item.packages.some((p) => p.name === v.PkgName)) item.packages.push({ name: v.PkgName, installed: v.InstalledVersion, fixed: v.FixedVersion || null });
      if (v.FixedVersion) item.fixable = true;
    }
  }
  const rank = (s: string) => (s === 'CRITICAL' ? 0 : s === 'HIGH' ? 1 : 2);
  return [...map.values()].sort((a, b) => rank(a.severity) - rank(b.severity) || Number(b.fixable) - Number(a.fixable) || a.id.localeCompare(b.id));
}

export async function allocatePort(store: Store, start: number, end: number, column: 'preview_port' | 'port'): Promise<number> {
  const used = new Set(
    column === 'preview_port'
      ? store.all<{ p: number }>("SELECT preview_port AS p FROM submissions WHERE preview_port IS NOT NULL AND status NOT IN ('superseded','failed','cancelled','withdrawn')").map((r) => r.p)
      : store.all<{ p: number }>("SELECT port AS p FROM releases WHERE port IS NOT NULL AND status IN ('active','starting','offline')").map((r) => r.p),
  );
  for (let p = start; p <= end; p++) if (!used.has(p) && !(await portInUse(p))) return p;
  throw new Error('沒有可用的本機埠');
}

export async function waitHealthy(rt: Runtime, url: string, expect: number, timeoutMs: number, signal: AbortSignal): Promise<{ ok: boolean; status: number | null; seconds: number }> {
  const t0 = Date.now();
  let status: number | null = null;
  while (Date.now() - t0 < timeoutMs && !signal.aborted) {
    status = await rt.probe(url);
    if (status === expect) return { ok: true, status, seconds: Math.round((Date.now() - t0) / 1000) };
    await new Promise((r) => setTimeout(r, 2000));
  }
  return { ok: false, status, seconds: Math.round((Date.now() - t0) / 1000) };
}


export async function runVerifyJob(store: Store, cfg: Config, rt: Runtime, secrets: Secrets, jobId: string, signal: AbortSignal) {
  const job = store.get<{ submission_id: string }>('SELECT submission_id FROM jobs WHERE id=?', jobId)!;
  const sub = store.get<Sub>('SELECT * FROM submissions WHERE id=?', job.submission_id)!;
  const m = JSON.parse(sub.manifest_json) as Manifest;
  const evDir = join(cfg.dataDir, 'evidence', sub.id, jobId);
  mkdirSync(evDir, { recursive: true });
  const mask = makeMasker(secrets.allSecretValues());
  const ctxFor = (step: StepName): Ctx => ({ logFile: join(evDir, `${step}.log`), signal, mask });
  const set = (step: StepName, status: StepStatus, summary?: unknown) => {
    store.setStep(jobId, step, status, summary, join(evDir, `${step}.log`));
    store.run('UPDATE jobs SET current_step=? WHERE id=?', step, jobId);
  };
  const evidence = (name: string, data: unknown) => writeFileSync(join(evDir, name), JSON.stringify(data, null, 2));
  for (const s of STEPS) store.setStep(jobId, s, 'pending');
  store.run("UPDATE jobs SET status='running', started_at=? WHERE id=?", now(), jobId);
  store.setSubmissionStatus(sub.id, 'running');

  const results: Partial<Record<StepName, StepStatus>> = {};
  const stopIfCancelled = () => signal.aborted;
  const skipRest = (from: StepName, reason: string) => {
    for (const s of STEPS.slice(STEPS.indexOf(from))) if (!results[s]) { results[s] = 'skipped'; set(s, 'skipped', { reason }); }
  };
  const labels = { 'workhub.tool': m.tool.id, 'workhub.submission': sub.id, 'workhub.source_sha256': sub.source_hash };
  const memoryBytes = memoryToBytes(m.run.resources.memory) ?? 1024 ** 3;
  const mount = m.run.persistentData[0]?.path;

  try {
    // 1. validate：工作區與設定仍一致（收件時已完成完整檢查）
    set('validate', 'running');
    const srcDir = join(cfg.dataDir, 'workspaces', sub.id, 'src');
    const ok = existsSync(join(srcDir, 'workhub.yaml')) && existsSync(join(srcDir, m.build.dockerfile));
    results.validate = ok ? 'passed' : 'failed';
    set('validate', results.validate, { sourceHash: sub.source_hash, tool: m.tool.id, version: m.tool.version, revision: sub.revision });
    if (!ok) { skipRest('build', '提交內容不完整'); return; }

    // 2. build（不注入任何模型憑證）
    if (stopIfCancelled()) return;
    set('build', 'running');
    const tag = `workhub/${m.tool.id}:${m.tool.version}-r${sub.revision}`;
    const b = await rt.build(join(srcDir, m.build.context === '.' ? '' : m.build.context), join(srcDir, m.build.dockerfile), tag, labels, cfg.hostPlatform, cfg.timeouts.buildMs, ctxFor('build'));
    if (stopIfCancelled()) return;
    results.build = b.ok ? 'passed' : 'failed';
    set('build', results.build, { image: tag, digest: b.digest ?? null, timedOut: b.result.timedOut, exitCode: b.result.code, platform: cfg.hostPlatform });
    if (!b.ok) { skipRest('scan', '建置失敗'); return; }
    store.run('UPDATE submissions SET image_ref=?, image_digest=?, updated_at=? WHERE id=?', tag, b.digest, now(), sub.id);

    // 3. scan：照常掃描並記錄，不阻擋發布（2026-10-13 Mila 決策）；有 CRITICAL 標為 warning；掃描器不可用 = 未完成（仍阻擋）
    if (stopIfCancelled()) return;
    set('scan', 'running');
    const sc = await rt.scan(tag, join(evDir, 'trivy.json'), cfg.timeouts.scanMs, ctxFor('scan'));
    if (stopIfCancelled()) return;
    if (!sc.available || !sc.ok) {
      results.scan = 'incomplete';
      set('scan', 'incomplete', { reason: sc.available ? '掃描執行失敗' : '找不到漏洞掃描器（trivy）' });
    } else {
      const s = summarizeTrivy(sc.json);
      results.scan = s.critical.length ? 'warning' : 'passed';
      set('scan', results.scan, { policy: 'record only; not blocking', ...s, needsException: [] });
    }

    // 4. 程式碼檢查：改由客戶人工審查（DEC-019）。自動流程不代審，標為「待確認」，由開發者在網站按「已檢查」才算通過
    results.code_review = 'awaiting';
    set('code_review', 'awaiting', { reason: '等待開發者人工程式碼檢查', mode: 'manual' });

    // 5. platform_test：獨立容器＋空白資料卷，健康檢查與入口可達性
    if (stopIfCancelled()) return;
    set('platform_test', 'running');
    const ptName = `wh-ptest-${jobId}`.toLowerCase();
    const ptVol = `${ptName}-data`;
    const ptPort = await freePort();
    const ptCtx = ctxFor('platform_test');
    const ptNet = toolNetwork(m.tool.id);
    if (!(await rt.ensureNetwork(ptNet, cfg.toolNetworkInternal, ptCtx))) throw new Error(`無法建立工具隔離網路 ${ptNet}`);
    const st = await rt.start({ image: tag, name: ptName, labels: { ...labels, 'workhub.kind': 'platform-test' }, hostPort: ptPort, containerPort: m.run.port, volume: mount ? ptVol : undefined, mountPath: mount, env: {}, memoryBytes, cpus: m.run.resources.cpu, command: m.run.command, network: ptNet }, ptCtx);
    let health = { ok: false, status: null as number | null, seconds: 0 };
    if (st.code === 0) {
      health = await waitHealthy(rt, `http://127.0.0.1:${ptPort}${m.run.healthCheck.path}`, m.run.healthCheck.expectStatus, (m.run.healthCheck.startPeriodSeconds * 1000) + cfg.timeouts.healthMs, signal);
    }
    await rt.logs(ptName, ptCtx);
    await rt.remove(ptName, ptCtx);
    if (mount) await rt.removeVolume(ptVol, ptCtx);
    if (stopIfCancelled()) return;
    results.platform_test = health.ok ? 'passed' : 'failed';
    const platformSummary = { layer: 'platform', started: st.code === 0, healthPath: m.run.healthCheck.path, expectStatus: m.run.healthCheck.expectStatus, gotStatus: health.status, secondsToHealthy: health.seconds, persistentData: mount ?? null };
    set('platform_test', results.platform_test, platformSummary);
    evidence('platform_test.json', platformSummary);

    // 6. business_test：提交包自帶測試；無網路、空白資料卷；未提供 = 未驗證
    if (stopIfCancelled()) return;
    if (!m.test) {
      results.business_test = 'not_verified';
      set('business_test', 'not_verified', { reason: '提交包未提供業務測試，請在 workhub.yaml 補上 test.command' });
    } else {
      set('business_test', 'running');
      const btName = `wh-btest-${jobId}`.toLowerCase();
      const btVol = `${btName}-data`;
      const r = await rt.runOnce({ image: tag, name: btName, labels: { ...labels, 'workhub.kind': 'business-test' }, volume: mount ? btVol : undefined, mountPath: mount, env: {}, memoryBytes, cpus: m.run.resources.cpu, command: m.test.command, network: 'none' }, m.test.timeoutSeconds * 1000, ctxFor('business_test'));
      if (mount) await rt.removeVolume(btVol);
      if (stopIfCancelled()) return;
      results.business_test = r.code === 0 && !r.timedOut ? 'passed' : 'failed';
      const tail = (r.stdout + r.stderr).trim().split('\n').slice(-6);
      const summary = { layer: 'business', command: m.test.command, exitCode: r.code, timedOut: r.timedOut, network: 'none', tail };
      set('business_test', results.business_test, summary);
      evidence('business_test.json', summary);
    }

    // 7. preview：前面都通過才啟動；獨立資料卷，與已發布資料隔離；只綁 127.0.0.1
    if (stopIfCancelled()) return;
    if (results.platform_test !== 'passed' || results.business_test !== 'passed' || results.scan === 'incomplete') {
      results.preview = 'skipped';
      set('preview', 'skipped', { reason: '平台檢查、業務測試或漏洞掃描未通過，不啟動預覽' });
      return;
    }
    set('preview', 'running');
    const pvCtx = ctxFor('preview');
    const pvName = `wh-preview-${m.tool.id}`;
    const pvVol = `wh-preview-${m.tool.id}-r${sub.revision}-data`;
    const port = await allocatePort(store, cfg.ports.previewStart, cfg.ports.previewEnd, 'preview_port');
    const access = await prepareModelAccess(cfg, rt, secrets, m, m.tool.id, pvCtx);
    const env = access.env;
    const pst = await rt.start({ image: tag, name: pvName, labels: { ...labels, 'workhub.kind': 'preview' }, hostPort: port, containerPort: m.run.port, volume: mount ? pvVol : undefined, mountPath: mount, env, memoryBytes, cpus: m.run.resources.cpu, command: m.run.command, network: access.network }, pvCtx);
    const ph = pst.code === 0
      ? await waitHealthy(rt, `http://127.0.0.1:${port}${m.run.healthCheck.path}`, m.run.healthCheck.expectStatus, (m.run.healthCheck.startPeriodSeconds * 1000) + cfg.timeouts.healthMs, signal)
      : { ok: false, status: null, seconds: 0 };
    results.preview = ph.ok ? 'passed' : 'failed';
    if (ph.ok) store.run('UPDATE submissions SET preview_port=?, preview_container=?, updated_at=? WHERE id=?', port, pvName, now(), sub.id);
    else { await rt.logs(pvName, pvCtx); await rt.remove(pvName, pvCtx); }
    set('preview', results.preview, { url: ph.ok ? `http://127.0.0.1:${port}/` : null, volume: mount ? pvVol : null, modelEnvInjected: Object.keys(env), modelConfigured: m.model.uses ? Object.keys(env).length > 0 : null, model: access.note, network: access.network });
  } catch (e) {
    const current = store.get<{ current_step: StepName }>('SELECT current_step FROM jobs WHERE id=?', jobId)?.current_step ?? 'validate';
    results[current] = 'failed';
    set(current, 'failed', { error: (e as Error).message });
    skipRest(current, '前一步發生錯誤');
    store.run('UPDATE jobs SET error=? WHERE id=?', (e as Error).message, jobId);
  } finally {
    finalize(store, jobId, sub.id, results, signal.aborted);
  }
}

function finalize(store: Store, jobId: string, subId: string, results: Partial<Record<StepName, StepStatus>>, aborted: boolean) {
  const t = now();
  if (aborted) {
    store.run("UPDATE step_results SET status='cancelled', finished_at=? WHERE job_id=? AND status IN ('running','pending')", t, jobId);
    store.run("UPDATE jobs SET status='cancelled', finished_at=? WHERE id=?", t, jobId);
    const cur = store.get<{ status: string }>('SELECT status FROM submissions WHERE id=?', subId);
    if (!['superseded', 'withdrawn'].includes(cur?.status ?? '')) store.setSubmissionStatus(subId, 'cancelled');
    return;
  }
  const failed = ['build', 'platform_test', 'business_test', 'preview', 'validate'].some((s) => ['failed', 'not_verified', 'skipped'].includes(results[s as StepName] ?? 'failed'))
    || results.scan === 'incomplete';
  store.run('UPDATE jobs SET status=?, finished_at=? WHERE id=?', failed ? 'failed' : 'succeeded', t, jobId);
  const cur = store.get<{ status: string }>('SELECT status FROM submissions WHERE id=?', subId);
  if (!['superseded', 'withdrawn'].includes(cur?.status ?? '')) store.setSubmissionStatus(subId, failed ? 'failed' : 'awaiting_confirmation');
  store.audit('system', failed ? 'job.failed' : 'job.succeeded', jobId, { submission: subId, results });
}
