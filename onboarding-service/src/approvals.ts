/**
 * 人工確認與核准。每筆都綁定 source_hash + image_digest；提交修訂後舊確認與核准一律失效。
 * - test_confirmation：使用者（Mila）確認測試與預覽結果
 * - vuln_exception：無修正版 CRITICAL 的本機例外，逐一 CVE 核准
 * - release_approval：發布核准（後端檢查所有條件）
 */
import type { Config } from './config.ts';
import { newId, now, type Store } from './db.ts';

type Sub = { id: string; status: string; source_hash: string; image_digest: string | null; tool_id: string; version: string };
type StepRow = { step: string; status: string; summary_json: string };

export class GateError extends Error {
  reasons: string[];
  constructor(reasons: string[]) { super(reasons.join('；')); this.reasons = reasons; }
}

export function latestSteps(store: Store, subId: string): Record<string, { status: string; summary: Record<string, unknown> }> {
  const job = store.get<{ id: string }>("SELECT id FROM jobs WHERE submission_id=? AND kind='verify' ORDER BY created_at DESC LIMIT 1", subId);
  if (!job) return {};
  return Object.fromEntries(store.all<StepRow>('SELECT step,status,summary_json FROM step_results WHERE job_id=?', job.id)
    .map((r) => [r.step, { status: r.status, summary: JSON.parse(r.summary_json) as Record<string, unknown> }]));
}

function activeApprovals(store: Store, sub: Sub, kind: string) {
  return store.all<{ id: string; subject: string | null; actor: string; reason: string; created_at: string }>(
    'SELECT id,subject,actor,reason,created_at FROM approvals WHERE submission_id=? AND kind=? AND revoked_at IS NULL AND source_hash=? AND image_digest IS ?',
    sub.id, kind, sub.source_hash, sub.image_digest);
}

export function missingExceptions(store: Store, sub: Sub): string[] {
  const steps = latestSteps(store, sub.id);
  const needed = (steps.scan?.summary.needsException as string[] | undefined) ?? [];
  const have = new Set(activeApprovals(store, sub, 'vuln_exception').map((a) => a.subject));
  return needed.filter((id) => !have.has(id));
}

export function releaseBlockers(store: Store, cfg: Config, sub: Sub): string[] {
  const s = latestSteps(store, sub.id);
  const reasons: string[] = [];
  if (!sub.image_digest) reasons.push('尚未建置成功');
  if (s.build?.status !== 'passed') reasons.push('建置未通過');
  if (s.platform_test?.status !== 'passed') reasons.push('平台共通檢查未通過');
  if (s.business_test?.status !== 'passed') reasons.push(s.business_test?.status === 'not_verified' ? '業務測試未提供（未驗證）' : '業務測試未通過');
  if (s.scan?.status === 'incomplete' || !s.scan) reasons.push('漏洞掃描未完成');
  // 漏洞檢查只記錄、不阻擋（2026-10-13 決策）；舊紀錄若標為 blocked 仍需完成例外核准
  if (s.scan?.status === 'blocked') {
    const miss = missingExceptions(store, sub);
    if (miss.length) reasons.push(`CRITICAL 漏洞尚未核准例外：${miss.join(', ')}`);
  }
  const ai = s.ai_review?.status;
  if (!(ai === 'passed' || (ai === 'skipped' && cfg.environment === 'local'))) reasons.push('程式碼 AI review 未完成（正式環境不可略過）');
  if (!activeApprovals(store, sub, 'test_confirmation').length) reasons.push('使用者尚未確認測試結果');
  return reasons;
}

function getSub(store: Store, id: string): Sub {
  const sub = store.get<Sub>('SELECT id,status,source_hash,image_digest,tool_id,version FROM submissions WHERE id=?', id);
  if (!sub) throw new GateError(['找不到此提交']);
  return sub;
}

export function confirmTest(store: Store, cfg: Config, id: string, actor: string, note: string) {
  const sub = getSub(store, id);
  if (sub.status !== 'awaiting_confirmation') throw new GateError([`目前狀態（${sub.status}）不能確認測試`]);
  const s = latestSteps(store, id);
  const reasons: string[] = [];
  if (s.business_test?.status !== 'passed') reasons.push('業務測試未通過');
  if (s.platform_test?.status !== 'passed') reasons.push('平台共通檢查未通過');
  if (s.preview?.status !== 'passed') reasons.push('預覽未啟動，無法人工核對');
  if (!note.trim()) reasons.push('請填寫核對說明（例如核對了哪些樣本）');
  if (reasons.length) throw new GateError(reasons);
  store.tx(() => {
    store.run('INSERT INTO approvals(id,submission_id,kind,subject,actor,reason,source_hash,image_digest,created_at) VALUES (?,?,?,?,?,?,?,?,?)',
      newId('apv'), id, 'test_confirmation', null, actor, note.trim(), sub.source_hash, sub.image_digest, now());
    store.setSubmissionStatus(id, 'awaiting_approval');
    store.audit(actor, 'submission.test_confirmed', id, { note: note.trim(), imageDigest: sub.image_digest });
  });
}

export function approveException(store: Store, cfg: Config, id: string, actor: string, cveId: string, reason: string) {
  const sub = getSub(store, id);
  if (cfg.environment !== 'local') throw new GateError(['正式環境的漏洞例外需另行定義核准流程']);
  if (!['awaiting_confirmation', 'awaiting_approval'].includes(sub.status)) throw new GateError([`目前狀態（${sub.status}）不能核准例外`]);
  const needed = (latestSteps(store, id).scan?.summary.needsException as string[] | undefined) ?? [];
  if (!needed.includes(cveId)) throw new GateError([`${cveId} 不在此版本的待核准清單中`]);
  if (!reason.trim()) throw new GateError(['請說明核准理由']);
  store.run('INSERT INTO approvals(id,submission_id,kind,subject,actor,reason,source_hash,image_digest,created_at) VALUES (?,?,?,?,?,?,?,?,?)',
    newId('apv'), id, 'vuln_exception', cveId, actor, reason.trim(), sub.source_hash, sub.image_digest, now());
  store.audit(actor, 'submission.vuln_exception', id, { cveId, reason: reason.trim(), scope: 'local-only', imageDigest: sub.image_digest });
}

export function approveRelease(store: Store, cfg: Config, id: string, actor: string, reason: string) {
  const sub = getSub(store, id);
  if (sub.status !== 'awaiting_approval') throw new GateError([`目前狀態（${sub.status}）不能核准發布`]);
  const reasons = releaseBlockers(store, cfg, sub);
  if (!reason.trim()) reasons.push('請填寫核准說明');
  if (reasons.length) throw new GateError(reasons);
  store.tx(() => {
    store.run('INSERT INTO approvals(id,submission_id,kind,subject,actor,reason,source_hash,image_digest,created_at) VALUES (?,?,?,?,?,?,?,?,?)',
      newId('apv'), id, 'release_approval', null, actor, reason.trim(), sub.source_hash, sub.image_digest, now());
    store.setSubmissionStatus(id, 'approved');
    store.audit(actor, 'submission.release_approved', id, { reason: reason.trim(), imageDigest: sub.image_digest, aiReview: cfg.environment === 'local' ? 'skipped(local)' : 'passed' });
  });
}

/** 取消提交（測試失敗等）：撤回尚未發布的提交，撤銷其確認與核准；預覽容器由呼叫端關閉。 */
export function withdraw(store: Store, id: string, actor: string, reason: string) {
  const sub = getSub(store, id);
  if (!['queued', 'running', 'failed', 'cancelled', 'interrupted', 'awaiting_confirmation', 'awaiting_approval', 'approved'].includes(sub.status)) {
    throw new GateError([sub.status === 'released' ? '已發布的版本不能取消提交，請改用回復' : `目前狀態（${sub.status}）不能取消提交`]);
  }
  if (store.get("SELECT id FROM releases WHERE submission_id=? AND status IN ('pending','starting')", id)) throw new GateError(['此版本正在發布中，不能取消提交']);
  if (!reason.trim()) throw new GateError(['請說明取消原因']);
  const t = now();
  store.tx(() => {
    store.run("UPDATE jobs SET cancel_requested=1 WHERE submission_id=? AND status IN ('queued','running')", id);
    store.run('UPDATE approvals SET revoked_at=? WHERE submission_id=? AND revoked_at IS NULL', t, id);
    store.setSubmissionStatus(id, 'withdrawn');
    store.audit(actor, 'submission.withdrawn', id, { reason: reason.trim(), previousStatus: sub.status });
  });
}

export function approvalsFor(store: Store, id: string) {
  return store.all('SELECT kind,subject,actor,reason,created_at,revoked_at,image_digest FROM approvals WHERE submission_id=? ORDER BY created_at', id);
}
