/** 收件：檢查 ZIP 與 workhub.yaml → 保存原檔與解壓工作區 → 建立提交與工作。檢查不過就整筆拒收。 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Config } from './config.ts';
import { newId, now, type Store } from './db.ts';
import { validateManifest, type Manifest } from './manifest.ts';
import { detectPrefix, extract, readCentralDirectory, readEntry, scanSecrets, type Issue } from './zip-intake.ts';

export type IntakeForm = { department: string; owner: string; actor: string; originalFilename: string; mode?: string; expectedToolId?: string };
export type IntakeResult =
  | { ok: true; submissionId: string; jobId: string; toolId: string; version: string; revision: number; warnings: Issue[] }
  | { ok: false; issues: Issue[]; warnings: Issue[] };

export function inspectZip(buf: Buffer, cfg: Config): { issues: Issue[]; warnings: Issue[]; manifest?: Manifest; prefix: string } {
  const { entries, issues } = readCentralDirectory(buf, cfg);
  if (!entries.length) return { issues, warnings: [], prefix: '' };
  const prefix = detectPrefix(entries);
  const files = new Set(entries.filter((e) => !e.isDir && e.name.startsWith(prefix)).map((e) => e.name.slice(prefix.length)));
  const manifestEntry = entries.find((e) => e.name === `${prefix}workhub.yaml`);
  if (!manifestEntry) {
    issues.push({ file: 'workhub.yaml', reason: 'ZIP 最上層找不到 workhub.yaml', fix: '用開發者中心「下載上架資料包」裡的 workhub.yaml 範本，放在 ZIP 最上層（與 Dockerfile 同一層）' });
    return { issues, warnings: [], prefix };
  }
  let text = '';
  try { text = readEntry(buf, manifestEntry).toString('utf8'); } catch (e) {
    issues.push({ file: 'workhub.yaml', reason: `無法讀取：${(e as Error).message}`, fix: '重新壓縮後上傳' });
    return { issues, warnings: [], prefix };
  }
  const m = validateManifest(text, files, cfg);
  issues.push(...m.issues);
  if (!issues.length) issues.push(...scanSecrets(buf, entries.filter((e) => e.name.startsWith(prefix)), prefix));
  return { issues, warnings: m.warnings, manifest: m.manifest, prefix };
}

export function intake(store: Store, cfg: Config, buf: Buffer, form: IntakeForm): IntakeResult {
  const formIssues: Issue[] = [];
  if (!form.department.trim()) formIssues.push({ file: '(平台表單)', field: 'department', reason: '缺少部門', fix: '在上架表單選擇部門' });
  if (!form.owner.trim()) formIssues.push({ file: '(平台表單)', field: 'owner', reason: '缺少工具負責人', fix: '在上架表單填寫 Owner' });
  const inspected = inspectZip(buf, cfg);
  const issues = [...formIssues, ...inspected.issues];
  if (issues.length || !inspected.manifest) return { ok: false, issues, warnings: inspected.warnings };
  const m = inspected.manifest;
  const existingTool = store.get<{ id: string }>('SELECT id FROM tools WHERE id=?', m.tool.id);
  const rejectTarget = (reason: string, fix: string): IntakeResult => ({ ok: false, warnings: inspected.warnings, issues: [{ file: 'workhub.yaml', field: 'tool.id', reason, fix }] });
  if (form.mode && !['new', 'update'].includes(form.mode)) return rejectTarget('不支援的提交方式', '請重新開啟新增工具或提交新版本表單');
  if (form.mode === 'new' && existingTool) return rejectTarget('此工具已存在', '請在該工具的提交詳情選擇「提交新版本」，或為新工具使用不同的 tool.id');
  if (form.mode === 'update' && (!form.expectedToolId || m.tool.id !== form.expectedToolId || !existingTool)) return rejectTarget('ZIP 的工具識別與選取的更新工具不符', '請上傳所選工具的 ZIP，並確認 tool.id 相同；新工具請使用「新增工具」');
  const sourceHash = createHash('sha256').update(buf).digest('hex');

  const released = store.get<{ id: string }>("SELECT id FROM submissions WHERE tool_id=? AND version=? AND status='released'", m.tool.id, m.tool.version);
  if (released) {
    return { ok: false, warnings: inspected.warnings, issues: [{ file: 'workhub.yaml', field: 'tool.version', reason: `版本 ${m.tool.version} 已發布過`, fix: '提交更新時請遞增版本號' }] };
  }
  const dup = store.get<{ id: string }>("SELECT id FROM submissions WHERE tool_id=? AND source_hash=? AND status NOT IN ('superseded','failed','cancelled','interrupted','withdrawn')", m.tool.id, sourceHash);
  if (dup) {
    return { ok: false, warnings: inspected.warnings, issues: [{ file: '(ZIP)', reason: `相同內容已在處理中或已完成（${dup.id}）`, fix: '若要重跑請使用「重試」；若有修改請重新打包' }] };
  }

  const submissionId = newId('sub');
  const jobId = newId('job');
  const sourceDir = join(cfg.dataDir, 'sources');
  const workDir = join(cfg.dataDir, 'workspaces', submissionId);
  mkdirSync(sourceDir, { recursive: true });
  const sourcePath = join(sourceDir, `${sourceHash}.zip`);
  if (!existsSync(sourcePath)) writeFileSync(sourcePath, buf, { mode: 0o444 });
  try {
    extract(buf, [...readCentralDirectory(buf, cfg).entries], inspected.prefix, join(workDir, 'src'));
  } catch (e) {
    rmSync(workDir, { recursive: true, force: true });
    return { ok: false, warnings: inspected.warnings, issues: [{ file: '(ZIP)', reason: `解壓失敗：${(e as Error).message}`, fix: '重新壓縮後上傳' }] };
  }

  const t = now();
  let revision = 1;
  store.tx(() => {
    const tool = store.get<{ id: string }>('SELECT id FROM tools WHERE id=?', m.tool.id);
    if (!tool) {
      store.run('INSERT INTO tools(id,name,department,owner,created_at,updated_at) VALUES (?,?,?,?,?,?)', m.tool.id, m.tool.name, form.department, form.owner, t, t);
      store.audit(form.actor, 'tool.registered', m.tool.id, { department: form.department, owner: form.owner });
    } else {
      store.run('UPDATE tools SET name=?, updated_at=? WHERE id=?', m.tool.name, t, m.tool.id);
    }
    revision = (store.get<{ r: number }>('SELECT COALESCE(MAX(revision),0)+1 AS r FROM submissions WHERE tool_id=?', m.tool.id)?.r) ?? 1;
    // 新修訂使舊提交（未發布者）的測試確認與核准失效
    const older = store.all<{ id: string }>("SELECT id FROM submissions WHERE tool_id=? AND status NOT IN ('released','superseded','withdrawn')", m.tool.id);
    for (const o of older) {
      store.setSubmissionStatus(o.id, 'superseded');
      store.run('UPDATE approvals SET revoked_at=? WHERE submission_id=? AND revoked_at IS NULL', t, o.id);
      store.run("UPDATE jobs SET cancel_requested=1 WHERE submission_id=? AND status IN ('queued','running')", o.id);
      store.audit(form.actor, 'submission.superseded', o.id, { by: submissionId });
    }
    store.run(`INSERT INTO submissions(id,tool_id,version,revision,status,source_hash,source_path,original_filename,manifest_json,warnings_json,created_by,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      submissionId, m.tool.id, m.tool.version, revision, 'queued', sourceHash, sourcePath, form.originalFilename.slice(0, 200),
      JSON.stringify(m), JSON.stringify(inspected.warnings), form.actor, t, t);
    store.run("INSERT INTO jobs(id,submission_id,kind,status,created_at) VALUES (?,?,'verify','queued',?)", jobId, submissionId, t);
    store.audit(form.actor, 'submission.created', submissionId, { tool: m.tool.id, version: m.tool.version, revision, sourceHash });
  });
  return { ok: true, submissionId, jobId, toolId: m.tool.id, version: m.tool.version, revision, warnings: inspected.warnings };
}
