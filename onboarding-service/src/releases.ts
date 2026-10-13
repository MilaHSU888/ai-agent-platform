/**
 * 階段 E：本機發布、更新與回復。
 * - 發布同一份已測試、已核准的 image（以 digest 指定），不重新建置。
 * - 健康檢查通過後才把工具入口切到新版本；首次發布失敗時入口維持不可用並記錄原因。
 * - 更新前先停止舊版並做一致性備份；新版失敗時還原備份並重新啟動前一版，前一版入口不受影響。
 * - 回復需明確選擇資料策略：keep（資料格式相容時保留目前資料）或 restore（還原到該版本發布前的備份）。
 * - 重新上線：把曾經上線過的版本（被取代或被回復掉的）再部署一次，保留目前資料，流程與更新相同（先備份）。
 * - 下架：停止上線中的容器（資料卷保留、埠號保留），入口關閉；重新上架＝把該版本再部署一次（同埠號、同資料）。
 * - 正式資料卷 wh-rel-<tool>-data 與預覽、測試資料卷分開。
 */
import { join } from 'node:path';
import type { Config } from './config.ts';
import { newId, now, type Store } from './db.ts';
import { GateError } from './approvals.ts';
import { makeMasker } from './exec.ts';
import { memoryToBytes, type Manifest } from './manifest.ts';
import { allocatePort, waitHealthy } from './pipeline.ts';
import { prepareModelAccess } from './relay.ts';
import type { Ctx, Runtime, ServiceSpec } from './runtime.ts';
import type { Secrets } from './secrets.ts';

export type ReleaseStatus = 'pending' | 'starting' | 'active' | 'failed' | 'superseded' | 'rolled_back' | 'offline';
type Rel = { id: string; tool_id: string; submission_id: string; image_digest: string; status: ReleaseStatus; port: number | null; container_name: string | null; volume: string | null; previous_release_id: string | null; detail_json: string; created_at: string; updated_at: string };
type Sub = { id: string; tool_id: string; version: string; revision: number; status: string; source_hash: string; image_digest: string | null; manifest_json: string };
type Step = { name: string; status: 'passed' | 'failed' | 'skipped'; at: string; detail?: string };
type Detail = { kind: 'release' | 'rollback' | 'redeploy'; steps: Step[]; backupBefore?: string | null; dataMode?: 'keep' | 'restore'; from?: string | null; error?: string; reason?: string; url?: string; actor?: string; offline?: { at: string; actor: string; reason: string } };

export const containerName = (toolId: string) => `wh-rel-${toolId}`;
export const volumeName = (toolId: string) => `wh-rel-${toolId}-data`;

export function activeRelease(store: Store, toolId: string): Rel | undefined {
  return store.get<Rel>("SELECT * FROM releases WHERE tool_id=? AND status='active' ORDER BY created_at DESC LIMIT 1", toolId);
}

function busy(store: Store, toolId: string) {
  return store.get("SELECT r.id FROM releases r WHERE r.tool_id=? AND r.status IN ('pending','starting')", toolId);
}

/** 管理者按「發布」：只接受已核准、核准綁定同一份 image 的提交；同一工具同時只跑一個發布工作。 */
export function requestRelease(store: Store, cfg: Config, subId: string, actor: string) {
  const sub = store.get<Sub>('SELECT * FROM submissions WHERE id=?', subId);
  if (!sub) throw new GateError(['找不到此提交']);
  if (sub.status !== 'approved') throw new GateError([`目前狀態（${sub.status}）不能發布，需先完成發布核准`]);
  const approval = store.get("SELECT id FROM approvals WHERE submission_id=? AND kind='release_approval' AND revoked_at IS NULL AND source_hash=? AND image_digest IS ?", subId, sub.source_hash, sub.image_digest);
  if (!approval || !sub.image_digest) throw new GateError(['找不到對應這份 image 的發布核准']);
  if (busy(store, sub.tool_id)) throw new GateError(['此工具已有發布或回復工作進行中']);
  if (cfg.environment !== 'local') throw new GateError(['正式環境發布流程尚未開放（本機試點）']);
  const prev = activeRelease(store, sub.tool_id);
  const relId = newId('rel');
  const jobId = newId('job');
  const t = now();
  store.tx(() => {
    store.run('INSERT INTO releases(id,tool_id,submission_id,image_digest,status,previous_release_id,detail_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)',
      relId, sub.tool_id, subId, sub.image_digest, 'pending', prev?.id ?? null, JSON.stringify({ kind: 'release', steps: [], actor } satisfies Detail), t, t);
    store.run("INSERT INTO jobs(id,submission_id,kind,status,created_at,release_id) VALUES (?,?,'release','queued',?,?)", jobId, subId, t, relId);
    store.audit(actor, 'release.requested', relId, { submission: subId, version: sub.version, imageDigest: sub.image_digest, previous: prev?.id ?? null });
  });
  return { releaseId: relId, jobId };
}

/** 回復到前一個曾經上線的版本。dataMode 必須明確選擇。 */
export function requestRollback(store: Store, cfg: Config, toolId: string, actor: string, reason: string, dataMode: string) {
  if (!['keep', 'restore'].includes(dataMode)) throw new GateError(['請選擇資料處理方式：保留目前資料，或還原到目前版本發布前的備份']);
  if (!reason.trim()) throw new GateError(['請說明回復原因']);
  const current = activeRelease(store, toolId);
  if (!current) throw new GateError(['此工具目前沒有上線中的版本']);
  if (busy(store, toolId)) throw new GateError(['此工具已有發布或回復工作進行中']);
  const target = current.previous_release_id ? store.get<Rel>('SELECT * FROM releases WHERE id=?', current.previous_release_id) : undefined;
  if (!target) throw new GateError(['沒有可回復的前一版']);
  const cur = JSON.parse(current.detail_json) as Detail;
  if (dataMode === 'restore' && !cur.backupBefore) throw new GateError(['目前版本發布前沒有備份可還原，只能選擇保留目前資料']);
  const relId = newId('rel');
  const jobId = newId('job');
  const t = now();
  store.tx(() => {
    store.run('INSERT INTO releases(id,tool_id,submission_id,image_digest,status,previous_release_id,detail_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)',
      relId, toolId, target.submission_id, target.image_digest, 'pending', target.previous_release_id, JSON.stringify({ kind: 'rollback', steps: [], from: current.id, dataMode: dataMode as 'keep' | 'restore', reason: reason.trim(), actor } satisfies Detail), t, t);
    store.run("INSERT INTO jobs(id,submission_id,kind,status,created_at,release_id) VALUES (?,?,'rollback','queued',?,?)", jobId, target.submission_id, t, relId);
    store.audit(actor, 'release.rollback_requested', relId, { tool: toolId, from: current.id, to: target.id, dataMode, reason: reason.trim() });
  });
  return { releaseId: relId, jobId };
}

/** 重新上線：選一個曾經上線過的版本（已被取代或已被回復）再部署一次；保留目前資料，部署前照常備份。 */
export function requestRedeploy(store: Store, cfg: Config, toolId: string, targetReleaseId: string, actor: string, reason: string) {
  if (!reason.trim()) throw new GateError(['請說明重新上線的原因']);
  if (cfg.environment !== 'local') throw new GateError(['正式環境發布流程尚未開放（本機試點）']);
  const target = store.get<Rel>('SELECT * FROM releases WHERE id=? AND tool_id=?', targetReleaseId, toolId);
  if (!target || !['superseded', 'rolled_back', 'offline'].includes(target.status)) throw new GateError(['只能重新上線曾經成功上線過的版本']);
  const current = activeRelease(store, toolId);
  const offline = offlineRelease(store, toolId);
  if (current && current.submission_id === target.submission_id) throw new GateError(['這個版本目前已在上線中']);
  if (busy(store, toolId)) throw new GateError(['此工具已有發布或回復工作進行中']);
  const relId = newId('rel');
  const jobId = newId('job');
  const t = now();
  store.tx(() => {
    store.run('INSERT INTO releases(id,tool_id,submission_id,image_digest,status,previous_release_id,detail_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)',
      relId, toolId, target.submission_id, target.image_digest, 'pending', current?.id ?? null, JSON.stringify({ kind: 'redeploy', steps: [], from: current?.id ?? offline?.id ?? null, dataMode: 'keep', reason: reason.trim(), actor } satisfies Detail), t, t);
    store.run("INSERT INTO jobs(id,submission_id,kind,status,created_at,release_id) VALUES (?,?,'redeploy','queued',?,?)", jobId, target.submission_id, t, relId);
    store.audit(actor, 'release.redeploy_requested', relId, { tool: toolId, from: current?.id ?? null, target: target.id, reason: reason.trim() });
  });
  return { releaseId: relId, jobId };
}

export function offlineRelease(store: Store, toolId: string): Rel | undefined {
  return store.get<Rel>("SELECT * FROM releases WHERE tool_id=? AND status='offline' ORDER BY updated_at DESC LIMIT 1", toolId);
}

/** 下架：停止上線中的容器，入口關閉。資料卷與埠號保留，之後可重新上架或切換到其他版本。 */
export async function takeOffline(store: Store, cfg: Config, rt: Runtime, toolId: string, actor: string, reason: string) {
  if (!reason.trim()) throw new GateError(['請說明下架原因']);
  const current = activeRelease(store, toolId);
  if (!current) throw new GateError(['此工具目前沒有上線中的版本']);
  if (busy(store, toolId)) throw new GateError(['此工具已有發布或回復工作進行中']);
  const dir = join(cfg.dataDir, 'evidence', current.submission_id, `offline-${Date.now()}`);
  const { mkdirSync } = await import('node:fs');
  mkdirSync(dir, { recursive: true });
  await rt.stop(containerName(toolId), { logFile: join(dir, 'release.log'), signal: new AbortController().signal, mask: (s: string) => s });
  const detail = JSON.parse(current.detail_json) as Detail;
  detail.offline = { at: now(), actor, reason: reason.trim() };
  store.tx(() => {
    store.run("UPDATE releases SET status='offline', detail_json=?, updated_at=? WHERE id=?", JSON.stringify(detail), now(), current.id);
    store.audit(actor, 'release.offline', current.id, { tool: toolId, reason: reason.trim() });
  });
  return { releaseId: current.id };
}

async function specFor(cfg: Config, rt: Runtime, secrets: Secrets, sub: Sub, port: number, ctx: Ctx): Promise<ServiceSpec> {
  const m = JSON.parse(sub.manifest_json) as Manifest;
  const mount = m.run.persistentData[0]?.path;
  const access = await prepareModelAccess(cfg, rt, secrets, m, sub.tool_id, ctx);
  return {
    image: sub.image_digest!, name: containerName(sub.tool_id),
    labels: { 'workhub.tool': sub.tool_id, 'workhub.submission': sub.id, 'workhub.kind': 'release', 'workhub.version': sub.version },
    hostPort: port, containerPort: m.run.port, volume: mount ? volumeName(sub.tool_id) : undefined, mountPath: mount,
    env: access.env, memoryBytes: memoryToBytes(m.run.resources.memory) ?? 1024 ** 3, cpus: m.run.resources.cpu,
    command: m.run.command, network: access.network, restart: true,
  };
}

async function healthy(rt: Runtime, cfg: Config, sub: Sub, port: number, signal: AbortSignal) {
  const m = JSON.parse(sub.manifest_json) as Manifest;
  return waitHealthy(rt, `http://127.0.0.1:${port}${m.run.healthCheck.path}`, m.run.healthCheck.expectStatus, m.run.healthCheck.startPeriodSeconds * 1000 + cfg.timeouts.healthMs, signal);
}

export async function runReleaseJob(store: Store, cfg: Config, rt: Runtime, secrets: Secrets, jobId: string, signal: AbortSignal) {
  const job = store.get<{ release_id: string; kind: string }>('SELECT release_id, kind FROM jobs WHERE id=?', jobId)!;
  const rel = store.get<Rel>('SELECT * FROM releases WHERE id=?', job.release_id)!;
  const detail = JSON.parse(rel.detail_json) as Detail;
  const sub = store.get<Sub>('SELECT * FROM submissions WHERE id=?', rel.submission_id)!;
  const m = JSON.parse(sub.manifest_json) as Manifest;
  const mount = m.run.persistentData[0]?.path;
  const ctx: Ctx = { logFile: join(cfg.dataDir, 'evidence', sub.id, jobId, 'release.log'), signal, mask: makeMasker(secrets.allSecretValues()) };
  const { mkdirSync } = await import('node:fs');
  mkdirSync(join(cfg.dataDir, 'evidence', sub.id, jobId), { recursive: true });
  const step = (name: string, status: Step['status'], d?: string) => {
    detail.steps.push({ name, status, at: now(), detail: d });
    store.run('UPDATE releases SET detail_json=?, updated_at=? WHERE id=?', JSON.stringify(detail), now(), rel.id);
  };
  store.run("UPDATE jobs SET status='running', started_at=? WHERE id=?", now(), jobId);
  store.run("UPDATE releases SET status='starting', updated_at=? WHERE id=?", now(), rel.id);

  // 目前上線中的版本（發布：前一版；回復：要被換下的版本）
  const current = detail.kind === 'rollback' ? store.get<Rel>('SELECT * FROM releases WHERE id=?', detail.from!) : activeRelease(store, sub.tool_id);
  const currentSub = current ? store.get<Sub>('SELECT * FROM submissions WHERE id=?', current.submission_id) : undefined;
  // 重新上架（目前沒有上線版本、從下架狀態恢復）：沿用下架前的埠號，入口網址不變
  const wasOffline = !current && detail.from ? store.get<Rel>("SELECT * FROM releases WHERE id=? AND status='offline'", detail.from) : undefined;
  let port = current?.port ?? wasOffline?.port ?? null;
  let backup: string | null = null;
  let ok = false;
  let error = '';

  const restartCurrent = async (why: string) => {
    if (!current || !currentSub || !port) return;
    await rt.remove(containerName(sub.tool_id), ctx);
    if (backup && mount) {
      const restored = await rt.restoreVolume(volumeName(sub.tool_id), backup, ctx);
      step('還原資料', restored ? 'passed' : 'failed', restored ? `已還原 ${why}前的備份` : '備份還原失敗，請人工處理');
    }
    const r = await rt.start(await specFor(cfg, rt, secrets, currentSub, port, ctx), ctx);
    const h = r.code === 0 ? await healthy(rt, cfg, currentSub, port, new AbortController().signal) : { ok: false };
    step('恢復前一版', h.ok ? 'passed' : 'failed', `${currentSub.version}${h.ok ? ' 已恢復服務' : ' 恢復失敗，入口暫停'}`);
    if (!h.ok) store.run("UPDATE releases SET status='failed', updated_at=? WHERE id=?", now(), current.id);
  };

  try {
    if (!port) port = await allocatePort(store, cfg.ports.releaseStart, cfg.ports.releaseEnd, 'port');

    // 1. 一致性備份：先停止目前版本再備份資料卷
    if (current && mount) {
      await rt.stop(containerName(sub.tool_id), ctx);
      backup = join(cfg.dataDir, 'backups', sub.tool_id, `${now().replace(/[:.]/g, '-')}-before-${detail.kind}-${sub.version}.tgz`);
      const b = await rt.backupVolume(volumeName(sub.tool_id), backup, ctx);
      if (!b) { step('備份資料', 'failed', '資料卷備份失敗，未進行更新'); backup = null; throw new Error('資料卷備份失敗'); }
      step('備份資料', 'passed', backup.split('/').slice(-1)[0]);
      if (detail.kind !== 'rollback') detail.backupBefore = backup;
    } else step('備份資料', 'skipped', current ? '此工具沒有持久資料目錄' : '首次發布，無既有資料');

    // 回復且選擇還原：還原到目前版本發布前的備份
    if (detail.kind === 'rollback' && detail.dataMode === 'restore' && mount) {
      const before = (JSON.parse(current!.detail_json) as Detail).backupBefore!;
      const r = await rt.restoreVolume(volumeName(sub.tool_id), before, ctx);
      step('還原資料', r ? 'passed' : 'failed', r ? `還原到 ${currentSub?.version ?? ''} 發布前的資料` : '還原失敗');
      if (!r) throw new Error('回復時還原資料失敗');
    }

    // 2. 部署同一份已測試 image
    await rt.remove(containerName(sub.tool_id), ctx);
    const st = await rt.start(await specFor(cfg, rt, secrets, sub, port, ctx), ctx);
    if (st.code !== 0) { step('啟動容器', 'failed', st.stderr.slice(0, 300)); throw new Error('容器啟動失敗'); }
    step('啟動容器', 'passed', `image ${sub.image_digest!.slice(0, 19)}… · 127.0.0.1:${port}`);

    // 3. 健康檢查通過才切換入口
    const h = await healthy(rt, cfg, sub, port, signal);
    if (!h.ok) { step('健康檢查', 'failed', `${m.run.healthCheck.path} 回應 ${h.status ?? '無'}`); throw new Error('健康檢查未通過'); }
    step('健康檢查', 'passed', `${m.run.healthCheck.path} → ${h.status}（${h.seconds} 秒）`);
    ok = true;
  } catch (e) {
    error = (e as Error).message;
    await rt.logs(containerName(sub.tool_id), ctx);
    if (current) await restartCurrent(detail.kind === 'rollback' ? '回復' : '更新');
    else { await rt.remove(containerName(sub.tool_id), ctx); step('入口', 'skipped', '首次發布失敗，入口維持不可用'); }
  }

  const t = now();
  detail.url = ok ? `http://127.0.0.1:${port}/` : undefined;
  detail.error = ok ? undefined : error;
  store.tx(() => {
    if (ok) {
      if (current) store.run('UPDATE releases SET status=?, updated_at=? WHERE id=?', detail.kind === 'rollback' ? 'rolled_back' : 'superseded', t, current.id);
      if (wasOffline) store.run("UPDATE releases SET status='superseded', updated_at=? WHERE id=?", t, wasOffline.id);
      store.run("UPDATE releases SET status='active', port=?, container_name=?, volume=?, detail_json=?, updated_at=? WHERE id=?",
        port, containerName(sub.tool_id), mount ? volumeName(sub.tool_id) : null, JSON.stringify(detail), t, rel.id);
      store.setSubmissionStatus(sub.id, 'released');
    } else {
      store.run("UPDATE releases SET status='failed', detail_json=?, updated_at=? WHERE id=?", JSON.stringify(detail), t, rel.id);
    }
    store.run('UPDATE jobs SET status=?, finished_at=?, error=? WHERE id=?', ok ? 'succeeded' : 'failed', t, ok ? null : error, jobId);
    store.audit(detail.actor ?? 'system', ok ? `${detail.kind}.succeeded` : `${detail.kind}.failed`, rel.id, { tool: sub.tool_id, version: sub.version, error: ok ? undefined : error, backup });
  });
}

/** WorkHub 入口：只列出健康檢查通過、上線中的版本；並即時探測服務是否回應。 */
export async function catalog(store: Store, rt: Runtime) {
  const rows = store.all<Rel & { name: string; department: string; owner: string; version: string; manifest_json: string; maintenance_json: string | null }>(
    `SELECT r.*, t.name, t.department, t.owner, t.maintenance_json, s.version, s.manifest_json FROM releases r
     JOIN tools t ON t.id=r.tool_id JOIN submissions s ON s.id=r.submission_id
     WHERE r.status='active' OR (r.status='offline' AND NOT EXISTS (SELECT 1 FROM releases a WHERE a.tool_id=r.tool_id AND a.status='active'))`);
  return Promise.all(rows.map(async (r) => {
    const m = JSON.parse(r.manifest_json) as Manifest;
    const offline = r.status === 'offline';
    const status = r.port && !offline ? await rt.probe(`http://127.0.0.1:${r.port}${m.run.healthCheck.path}`) : null;
    return {
      toolId: r.tool_id, name: r.name, department: r.department, owner: r.owner, version: r.version, releaseId: r.id,
      url: r.port && !offline ? `http://127.0.0.1:${r.port}/` : null, healthy: !offline && status === m.run.healthCheck.expectStatus, offline,
      maintenance: r.maintenance_json ? JSON.parse(r.maintenance_json) as { at: string; actor: string; reason: string } : null,
      usesModel: m.model.uses, releasedAt: r.updated_at,
    };
  }));
}

export function releaseHistory(store: Store, toolId?: string) {
  return store.all<Rel & { version: string; name: string }>(
    `SELECT r.*, s.version, t.name FROM releases r JOIN submissions s ON s.id=r.submission_id JOIN tools t ON t.id=r.tool_id
     ${toolId ? 'WHERE r.tool_id=?' : ''} ORDER BY r.created_at DESC LIMIT 100`, ...(toolId ? [toolId] : []))
    .map((r) => ({ id: r.id, toolId: r.tool_id, submissionId: r.submission_id, name: r.name, version: r.version, status: r.status, url: r.port ? `http://127.0.0.1:${r.port}/` : null,
      createdAt: r.created_at, updatedAt: r.updated_at, previousReleaseId: r.previous_release_id, detail: JSON.parse(r.detail_json) as Detail }));
}

/** 入口點擊與阻擋事件：同一 clientEventId 重送不重複計數。 */
export function recordEntryEvent(store: Store, actor: string, e: { clientEventId: string; toolId: string; kind: string; reason?: string }) {
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(e.clientEventId)) throw new GateError(['事件識別碼格式不正確']);
  if (!['click', 'blocked'].includes(e.kind)) throw new GateError(['事件類型只能是 click 或 blocked']);
  const rel = activeRelease(store, e.toolId);
  const version = rel ? store.get<{ version: string }>('SELECT version FROM submissions WHERE id=?', rel.submission_id)?.version : null;
  const r = store.run('INSERT OR IGNORE INTO entry_events(client_event_id,tool_id,kind,reason,release_id,version,actor,at) VALUES (?,?,?,?,?,?,?,?)',
    e.clientEventId, e.toolId, e.kind, e.reason?.slice(0, 200) ?? null, rel?.id ?? null, version ?? null, actor, now());
  return { recorded: Number(r.changes) > 0 };
}
