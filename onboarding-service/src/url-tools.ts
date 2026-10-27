/**
 * URL 上架（PRD §10，2026/10/27）：登錄已在其他地方運作的網站（OpenWebUI、n8n 等），不需 ZIP、Dockerfile 或建置。
 * - 開發者填表 → 平台檢查網址（格式、連線、HTTPS、轉址）→ AI Team 核准 → 發布為試用中 → 試用通過 → AI Team 公開。
 * - 建置、漏洞、程式碼檢查、業務測試不適用（not_applicable），不會顯示成通過。
 * - 平台只控制入口；知道網址的人仍可直接開啟外部網站，權限要靠網站本身的登入。
 * - 網域不限制，由 AI Team 審核判斷（Mila，2026/10/27）。
 * - 不記錄登入方式：權限由平台依部門（之後依 AD 群組）控制入口；處理敏感資料的網站，網站端也要限制 AD 群組，由 AI Team 審核判斷（Mila，2026/10/27）。
 */
import { createHash } from 'node:crypto';
import type { Config } from './config.ts';
import { newId, now, STEPS, type Store } from './db.ts';
import { nextAutoVersion, validToolName } from './intake.ts';
import type { Issue } from './zip-intake.ts';
import type { Runtime } from './runtime.ts';

export type UrlConfig = { kind: 'url'; tool: { id: string; version: string }; url: string; description: string; usesAi: boolean; aiConfirmed: boolean; guide: string };
export type UrlForm = { mode: 'new' | 'update'; toolId?: string; name?: string; department?: string; owner?: string; url: string; description: string; scenario?: string; usesAi: boolean; aiConfirmed: boolean; guide?: string; actor: string };
export type UrlCheck = { reachable: boolean; status: number | null; finalUrl: string | null; redirects: string[]; tls: 'ok' | 'error' | 'n/a'; error?: string; ms: number };

/** 只接受 http(s)，網址裡不可帶帳號密碼 */
export function normalizeUrl(raw: string): { url?: string; error?: string } {
  const v = raw.trim();
  if (!v) return { error: '請填寫網址' };
  let u: URL;
  try { u = new URL(v); } catch { return { error: '網址格式不正確，請填完整網址，例如 https://chat.example.com/' }; }
  if (!['http:', 'https:'].includes(u.protocol)) return { error: '只接受 http:// 或 https:// 開頭的網址' };
  if (u.username || u.password) return { error: '網址裡不能包含帳號或密碼' };
  if (v.length > 500) return { error: '網址過長' };
  return { url: u.href };
}

export function isUrlTool(store: Store, toolId: string) {
  return store.get<{ kind: string }>('SELECT kind FROM tools WHERE id=?', toolId)?.kind === 'url';
}

export function submitUrlTool(store: Store, cfg: Config, f: UrlForm): { ok: true; submissionId: string } | { ok: false; issues: Issue[] } {
  const issues: Issue[] = [];
  const bad = (field: string, reason: string, fix: string) => issues.push({ file: '(URL 上架表單)', field, reason, fix });
  const nu = normalizeUrl(f.url);
  if (nu.error) bad('url', nu.error, '填寫使用者實際開啟的網頁網址');
  if (f.usesAi && !f.aiConfirmed) bad('aiConfirmed', '使用 AI 的工具需確認模型與資料流符合公司規定', '確認後勾選；外部網站不會自動改走平台的 LLM Proxy');
  let toolId = f.toolId ?? '';
  if (f.mode === 'new') {
    const nameErr = validToolName(f.name ?? '');
    if (nameErr) bad('name', nameErr, '填寫使用者看得懂的工具名稱');
    if (!f.department?.trim()) bad('department', '缺少部門', '選擇工具所屬部門');
    if (!f.owner?.trim()) bad('owner', '缺少工具負責人', '填寫 Owner');
    if (!f.description.trim()) bad('description', '缺少用途說明', '一句話說明這個工具做什麼');
    if (f.description.trim().length > 80 || (f.scenario ?? '').trim().length > 80) bad('description', '用途說明與適用情境各限 80 字', '精簡成一句話');
    toolId = `url-${Date.now().toString(36)}`;
  } else {
    const tool = store.get<{ kind: string; archived_json: string | null; description: string | null }>('SELECT kind, archived_json, description FROM tools WHERE id=?', toolId);
    if (!tool || tool.archived_json) bad('toolId', '找不到此工具', '從工具清單選擇要修改的 URL 工具');
    else if (tool.kind !== 'url') bad('toolId', '這個工具是 ZIP 上架的工具', '請用「提交新版本」上傳 ZIP');
    if (store.get("SELECT id FROM releases WHERE tool_id=? AND status='trial'", toolId)) bad('toolId', '此工具有新設定正在試用中', '請先結束試用或由 AI Team 公開後再修改');
  }
  if (issues.length) return { ok: false, issues };
  const t = now();
  const submissionId = newId('sub');
  let result: { ok: true; submissionId: string } | { ok: false; issues: Issue[] } = { ok: true, submissionId };
  store.tx(() => {
    if (f.mode === 'new') {
      store.run("INSERT INTO tools(id,name,department,owner,created_at,updated_at,visibility,kind,description,scenario) VALUES (?,?,?,?,?,?,'trial','url',?,?)", toolId, f.name!.trim(), f.department!.trim(), f.owner!.trim(), t, t, f.description.trim(), (f.scenario ?? '').trim() || null);
    }
    const revision = store.get<{ r: number }>('SELECT COALESCE(MAX(revision),0)+1 AS r FROM submissions WHERE tool_id=?', toolId)!.r;
    const config: UrlConfig = { kind: 'url', tool: { id: toolId, version: nextAutoVersion(store, toolId) }, url: nu.url!, description: f.mode === 'new' ? f.description.trim() : (store.get<{ description: string | null }>('SELECT description FROM tools WHERE id=?', toolId)?.description ?? ''), usesAi: f.usesAi, aiConfirmed: f.aiConfirmed, guide: (f.guide ?? '').trim() };
    // 用途說明屬於工具層級（AI Team 可直接改），不算在設定變更內
    const hash = createHash('sha256').update(JSON.stringify({ ...config, description: undefined, tool: { id: toolId } })).digest('hex');
    if (store.get("SELECT id FROM submissions WHERE tool_id=? AND source_hash=? AND status NOT IN ('superseded','withdrawn')", toolId, hash)) {
      result = { ok: false, issues: [{ file: '(URL 上架表單)', reason: '設定和目前送審或上線中的相同', fix: '有修改的欄位才需要重新送審' }] };
      return;
    }
    for (const o of store.all<{ id: string }>("SELECT id FROM submissions WHERE tool_id=? AND status NOT IN ('released','superseded','withdrawn','trial')", toolId)) {
      store.setSubmissionStatus(o.id, 'superseded');
      store.run('UPDATE approvals SET revoked_at=? WHERE submission_id=? AND revoked_at IS NULL', t, o.id);
      store.run("UPDATE jobs SET cancel_requested=1 WHERE submission_id=? AND status IN ('queued','running')", o.id);
      store.audit(f.actor, 'submission.superseded', o.id, { by: submissionId });
    }
    const warnings: Issue[] = [];
    store.run(`INSERT INTO submissions(id,tool_id,version,revision,status,source_hash,source_path,original_filename,manifest_json,warnings_json,created_by,created_at,updated_at,kind,image_digest)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,'url',?)`, submissionId, toolId, config.tool.version, revision, 'queued', hash, '', config.url, JSON.stringify(config), JSON.stringify(warnings), f.actor, t, t, `url:${hash}`);
    store.run("INSERT INTO jobs(id,submission_id,kind,status,created_at) VALUES (?,?,'verify','queued',?)", newId('job'), submissionId, t);
    store.audit(f.actor, f.mode === 'new' ? 'url_tool.submitted' : 'url_tool.updated', submissionId, { tool: toolId, url: config.url });
  });
  void cfg;
  return result;
}

/** URL 工具的檢查工作：網址格式（收件時已檢查）＋實際連線；建置等步驟標示不適用。連不上只提醒，不阻擋（內部網站可能只在公司網路連得到）。 */
export async function runUrlCheckJob(store: Store, rt: Runtime, jobId: string, subId: string) {
  const sub = store.get<{ manifest_json: string; source_hash: string; revision: number }>('SELECT manifest_json, source_hash, revision FROM submissions WHERE id=?', subId)!;
  const c = JSON.parse(sub.manifest_json) as UrlConfig;
  for (const s of STEPS) store.setStep(jobId, s, 'not_applicable', { reason: 'URL 工具不適用' });
  store.run("UPDATE jobs SET status='running', started_at=? WHERE id=?", now(), jobId);
  store.setSubmissionStatus(subId, 'running');
  store.setStep(jobId, 'validate', 'passed', { url: c.url, sourceHash: sub.source_hash, revision: sub.revision });
  store.setStep(jobId, 'platform_test', 'running');
  const r = await rt.checkUrl(c.url);
  const ok = r.reachable && r.status !== null && r.status < 400 && r.tls !== 'error';
  store.setStep(jobId, 'platform_test', ok ? 'passed' : 'warning', { ...r, url: c.url, note: ok ? '連線正常' : '連線檢查未通過：不阻擋送審，請 AI Team 判斷（內部網站可能只在公司網路連得到）' });
  store.tx(() => {
    store.setSubmissionStatus(subId, 'awaiting_approval');
    store.run("UPDATE jobs SET status='succeeded', finished_at=?, current_step=NULL WHERE id=?", now(), jobId);
    store.audit('system', 'url_tool.checked', subId, { url: c.url, reachable: r.reachable, status: r.status, tls: r.tls });
  });
}

/** 工具圖示：只有 AI Team 設定（本機以示範身分在網站端限制）。symbol 對應網站內建圖示 0～5，color 為內建顏色。 */
export const ICON_COLORS = ['blue', 'violet', 'cyan', 'orange', 'green', 'pink'] as const;
export function setToolIcon(store: Store, toolId: string, actor: string, symbol: number, color: string) {
  if (!store.get('SELECT id FROM tools WHERE id=?', toolId)) return ['找不到此工具'];
  if (!Number.isInteger(symbol) || symbol < 0 || symbol > 5) return ['圖示不在平台內建清單中'];
  if (!(ICON_COLORS as readonly string[]).includes(color)) return ['顏色不在平台內建清單中'];
  store.tx(() => {
    store.run('UPDATE tools SET icon_json=?, updated_at=? WHERE id=?', JSON.stringify({ symbol, color }), now(), toolId);
    store.audit(actor, 'tool.icon_changed', toolId, { symbol, color });
  });
  return [];
}
