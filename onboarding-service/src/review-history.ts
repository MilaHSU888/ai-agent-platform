/**
 * 審核履歷（2026/11/02 資安稽核需求）：每個工具、每個版本「誰上傳、誰檢查程式碼、誰核准、誰公開」與時間。
 * - 資料來自提交、確認／核准與稽核紀錄（永久保存、不能刪改），這裡只整理成一列一個動作。
 * - 本機試點沒有登入：人名是網站「目前身分（示範）」選的，未經驗證，身分欄一律標示「示範，未驗證」；接上公司 AD 後改為驗證過的帳號。
 * - 不擋同一個人做多個步驟（客戶 2026/11/02 決定），只記錄是誰做的。
 */
import type { Store } from './db.ts';

export type ReviewRow = { at: string; toolId: string; toolName: string; version: string; action: string; actor: string; identity: string; note: string };

const APPROVAL_LABEL: Record<string, string> = {
  code_review: '程式碼檢查', test_confirmation: '確認測試結果', release_approval: '核准發布', vuln_exception: '核准漏洞例外',
  trial_passed: '試用通過（舊流程）', trial_failed: '測試未通過（舊流程）',
};
const AUDIT_LABEL: Record<string, string> = {
  'release.requested': '發布（試用中）', 'release.trial_requested': '發布新版試用', 'tool.publish_requested': '切換為公開中',
  'tool.published': '公開', 'tool.unpublished': '切回試用中', 'trial.ended': '下架試用版', 'tool.publish_failed': '公開失敗',
  'release.offline': '下架', 'release.rollback_requested': '回復', 'release.redeploy_requested': '重新上線',
  'submission.withdrawn': '取消提交', 'tool.archived': '封存',
  'autopack.created': '上傳原始碼（自動打包）', 'autopack.handed_off': '自動打包轉給 AI Team', 'autopack.confirmed': '確認打包報告', 'testdata.deleted': '測試資料已刪除',
};

export const identityOf = (actor: string) => (actor === 'system' ? '系統' : '示範，未驗證');

export function reviewHistory(store: Store, toolId?: string): ReviewRow[] {
  const tools = store.all<{ id: string; name: string }>(`SELECT id, name FROM tools ${toolId ? 'WHERE id=?' : ''}`, ...(toolId ? [toolId] : []));
  const rows: ReviewRow[] = [];
  for (const t of tools) {
    const subs = store.all<{ id: string; version: string; created_by: string; created_at: string; source_hash: string; kind: string; original_filename: string }>(
      'SELECT id, version, created_by, created_at, source_hash, kind, original_filename FROM submissions WHERE tool_id=? ORDER BY created_at', t.id);
    const verOfSub = new Map(subs.map((s) => [s.id, s.version]));
    const rels = store.all<{ id: string; submission_id: string }>('SELECT id, submission_id FROM releases WHERE tool_id=?', t.id);
    const verOfRel = new Map(rels.map((r) => [r.id, verOfSub.get(r.submission_id) ?? '']));
    const push = (r: Omit<ReviewRow, 'toolId' | 'toolName' | 'identity'>) => rows.push({ ...r, toolId: t.id, toolName: t.name, identity: identityOf(r.actor) });
    for (const s of subs) {
      push({ at: s.created_at, version: s.version, action: s.kind === 'url' ? '提交網址' : '上傳', actor: s.created_by, note: s.kind === 'url' ? s.original_filename : `原始碼雜湊 ${s.source_hash.slice(0, 12)}` });
      // 漏洞檢查（系統）：最近一次驗證工作的掃描結果與掃描工具版本
      const scan = store.get<{ status: string; summary_json: string; finished_at: string | null }>(
        "SELECT r.status, r.summary_json, r.finished_at FROM step_results r JOIN jobs j ON j.id=r.job_id WHERE j.submission_id=? AND j.kind='verify' AND r.step='scan' AND r.finished_at IS NOT NULL AND r.status NOT IN ('pending','not_applicable','skipped','cancelled') ORDER BY j.created_at DESC LIMIT 1", s.id);
      if (scan?.finished_at) {
        const sm = JSON.parse(scan.summary_json) as { counts?: Record<string, number>; scanner?: { version?: string | null; dbUpdatedAt?: string | null } | null; reason?: string };
        const by = sm.scanner ? `；Trivy ${sm.scanner.version ?? '版本未知'}，漏洞資料庫 ${sm.scanner.dbUpdatedAt?.slice(0, 10) ?? '未知'}` : '';
        push({ at: scan.finished_at, version: s.version, action: '漏洞檢查', actor: 'system', note: (sm.reason ?? `CRITICAL ${sm.counts?.CRITICAL ?? 0}、HIGH ${sm.counts?.HIGH ?? 0}`) + by });
      }
      for (const a of store.all<{ kind: string; subject: string | null; actor: string; reason: string; created_at: string; revoked_at: string | null }>(
        'SELECT kind, subject, actor, reason, created_at, revoked_at FROM approvals WHERE submission_id=? ORDER BY created_at, rowid', s.id)) {
        const note = [a.subject, a.reason].filter(Boolean).join('：') + (a.revoked_at ? `（已失效 ${a.revoked_at.slice(0, 10)}：上傳新版本或取消）` : '');
        push({ at: a.created_at, version: s.version, action: APPROVAL_LABEL[a.kind] ?? a.kind, actor: a.actor, note });
      }
    }
    // 自動打包：建立打包時還沒有工具代號，紀錄掛在打包編號上；以送出後的提交版本對應
    const aps = store.all<{ autopack_id: string; version: string }>('SELECT autopack_id, version FROM submissions WHERE tool_id=? AND autopack_id IS NOT NULL', t.id);
    const verOfAp = new Map(aps.map((x) => [x.autopack_id, x.version]));
    const targets = [t.id, ...subs.map((s) => s.id), ...rels.map((r) => r.id), ...aps.map((x) => x.autopack_id)];
    const ph = targets.map(() => '?').join(',');
    for (const e of store.all<{ at: string; actor: string; action: string; target: string; detail_json: string }>(
      `SELECT at, actor, action, target, detail_json FROM audit_events WHERE target IN (${ph}) AND action IN (${Object.keys(AUDIT_LABEL).map(() => '?').join(',')}) ORDER BY id`, ...targets, ...Object.keys(AUDIT_LABEL))) {
      const d = JSON.parse(e.detail_json) as Record<string, unknown>;
      const version = String(d.version ?? verOfRel.get(e.target) ?? verOfSub.get(e.target) ?? verOfAp.get(e.target) ?? verOfAp.get(String(d.autopack ?? '')) ?? '');
      let action = AUDIT_LABEL[e.action];
      if (e.action === 'tool.publish_requested') action = d.trialRelease ? '切換為公開中（換上新版）' : '切換為公開中（清空試用資料）';
      if (e.action === 'tool.published' && d.trialDataCleared) action = '公開（第一次，試用資料已清空）';
      if (e.action === 'submission.withdrawn' && /^AI Team (退回|撤銷核准並退回)：/.test(String(d.reason ?? ''))) { action = String(d.reason).startsWith('AI Team 撤銷') ? '撤銷核准並退回' : '退回（不核准）'; d.reason = String(d.reason).replace(/^AI Team [^：]+：/, ''); }
      if (e.action === 'testdata.deleted') { push({ at: e.at, version, action, actor: e.actor, note: `${(d.files as unknown[] | undefined)?.length ?? 0} 個檔案（只記檔名與檢查碼）` }); continue; }
      if (e.action === 'autopack.handed_off') { push({ at: e.at, version, action, actor: e.actor, note: String(d.reason ?? '') }); continue; }
      const note = [d.note, d.reason, d.error].filter((x) => typeof x === 'string' && x).join('；');
      push({ at: e.at, version, action, actor: e.actor, note });
    }
  }
  return rows.sort((a, b) => a.at.localeCompare(b.at));
}

/** 台北時間 YYYY-MM-DD HH:mm:ss */
const tpe = (iso: string) => new Date(new Date(iso).getTime() + 8 * 3600_000).toISOString().replace('T', ' ').slice(0, 19);
const cell = (v: string) => (/[",\n\r]/.test(v) || /^[=+\-@]/.test(v) ? `"${(/^[=+\-@]/.test(v) ? `'${v}` : v).replace(/"/g, '""')}"` : v);

/** CSV（UTF-8 BOM，Excel 直接開中文不會亂碼）；開頭為 = + - @ 的欄位加上單引號，避免被 Excel 當成公式 */
export function reviewHistoryCsv(rows: ReviewRow[]): string {
  const head = ['時間（台北）', '工具', '工具代號', '版本', '動作', '人員', '身分驗證', '說明'];
  const lines = [head, ...rows.map((r) => [tpe(r.at), r.toolName, r.toolId, r.version, r.action, r.actor === 'system' ? '系統' : r.actor, r.identity, r.note])];
  return '﻿' + lines.map((l) => l.map((v) => cell(String(v ?? ''))).join(',')).join('\r\n') + '\r\n';
}
