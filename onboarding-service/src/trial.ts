/**
 * 試用／公開（DEC-032，2026/10/27 客戶需求）：
 * - 發布後的新工具、或已公開工具的新版，先是「試用中（未公開）」，只有該工具的 Owner（開發者）與 AI Team 看得到。
 * - 已公開工具的試用版從空白資料開始，由 Owner 自行上傳測試資料（不複製正式資料）。
 * - 開發者在試用版確認沒問題後按「試用通過」；AI Team 再按「公開」。
 * - 公開：新工具 → 工具改為公開；已公開工具的試用版 → 走一般更新流程把新版換上正式版本，再移除試用版。
 * - 取消公開：工具退回試用中（容器照跑，一般使用者看不到）。結束試用：捨棄試用版，該提交改為已取消。
 * 本機試點沒有登入，角色只在網站端示範；正式環境須依登入身分在後端檢查（P1-AUTH-006）。
 */
import type { Config } from './config.ts';
import { newId, now, type Store } from './db.ts';
import { GateError } from './approvals.ts';
import { activeRelease, trialContainerName, trialPassed, trialRelease, trialVolumeName, visibilityOf, type Detail } from './releases.ts';
import type { Runtime } from './runtime.ts';

type Sub = { id: string; tool_id: string; version: string; status: string; source_hash: string; image_digest: string | null };
type Rel = { id: string; submission_id: string; image_digest: string; detail_json: string; volume: string | null };

/** 目前要試用的版本：已公開工具的並行試用版；或尚未公開工具的上線版本 */
function target(store: Store, toolId: string): { sub: Sub; parallel: Rel | undefined } {
  if (!store.get('SELECT id FROM tools WHERE id=?', toolId)) throw new GateError(['找不到此工具']);
  const parallel = trialRelease(store, toolId) as Rel | undefined;
  const rel = parallel ?? (visibilityOf(store, toolId) === 'trial' ? activeRelease(store, toolId) as Rel | undefined : undefined);
  if (!rel) throw new GateError([visibilityOf(store, toolId) === 'public' ? '此工具已公開，目前沒有試用中的新版本' : '此工具目前沒有上線中的版本可以試用']);
  return { sub: store.get<Sub>('SELECT * FROM submissions WHERE id=?', rel.submission_id)!, parallel };
}

/** 開發者：試用通過（備註選填）。綁定該版原始碼與 image。 */
export function passTrial(store: Store, toolId: string, actor: string, note: string) {
  const { sub } = target(store, toolId);
  if (trialPassed(store, sub.id)) throw new GateError([`${sub.version} 已按過試用通過`]);
  store.tx(() => {
    store.run('INSERT INTO approvals(id,submission_id,kind,subject,actor,reason,source_hash,image_digest,created_at) VALUES (?,?,?,?,?,?,?,?,?)',
      newId('apv'), sub.id, 'trial_passed', null, actor, note.trim(), sub.source_hash, sub.image_digest, now());
    store.audit(actor, 'trial.passed', sub.id, { tool: toolId, version: sub.version, note: note.trim() });
  });
  return { version: sub.version };
}

/**
 * 開發者：測試未通過（需填原因）。
 * - 已公開工具的並行試用版：自動結束試用（捨棄試用版，該提交改為已取消），正式版本不受影響，開發者修正後提交新版本。
 * - 尚未公開的工具：記錄結果，工具維持試用中；開發者可提交修正版，或重新測試後按「試用通過」。
 */
export async function failTrial(store: Store, rt: Runtime, toolId: string, actor: string, reason: string) {
  if (!reason.trim()) throw new GateError(['請說明測試未通過的原因']);
  const { sub, parallel } = target(store, toolId);
  store.tx(() => {
    store.run('INSERT INTO approvals(id,submission_id,kind,subject,actor,reason,source_hash,image_digest,created_at) VALUES (?,?,?,?,?,?,?,?,?)',
      newId('apv'), sub.id, 'trial_failed', null, actor, reason.trim(), sub.source_hash, sub.image_digest, now());
    store.audit(actor, 'trial.failed_by_developer', sub.id, { tool: toolId, version: sub.version, reason: reason.trim() });
  });
  if (parallel) await endTrial(store, rt, toolId, actor, `測試未通過：${reason.trim()}`);
  return { version: sub.version, ended: !!parallel };
}

/** AI Team：公開（需填說明）。 */
export function publish(store: Store, cfg: Config, toolId: string, actor: string, note: string) {
  if (!note.trim()) throw new GateError(['請填寫公開說明（例如試用結果）']);
  const { sub, parallel } = target(store, toolId);
  if (!trialPassed(store, sub.id)) throw new GateError(['開發者尚未按「試用通過」']);
  if (!parallel) {
    store.tx(() => {
      store.run("UPDATE tools SET visibility='public', updated_at=? WHERE id=?", now(), toolId);
      store.audit(actor, 'tool.published', toolId, { version: sub.version, note: note.trim() });
    });
    return { mode: 'visibility' as const, version: sub.version };
  }
  // 已公開工具的新版：以一般更新流程換上正式版本（先備份、健康檢查失敗自動還原），完成後移除試用版
  if (cfg.environment !== 'local') throw new GateError(['正式環境發布流程尚未開放（本機試點）']);
  if (store.get("SELECT id FROM releases WHERE tool_id=? AND status IN ('pending','starting')", toolId)) throw new GateError(['此工具已有發布或回復工作進行中']);
  const approval = store.get("SELECT id FROM approvals WHERE submission_id=? AND kind='release_approval' AND revoked_at IS NULL AND source_hash=? AND image_digest IS ?", sub.id, sub.source_hash, sub.image_digest);
  if (!approval || !sub.image_digest) throw new GateError(['找不到對應這份 image 的發布核准']);
  const prev = activeRelease(store, toolId);
  const relId = newId('rel');
  const jobId = newId('job');
  const t = now();
  store.tx(() => {
    store.run('INSERT INTO releases(id,tool_id,submission_id,image_digest,status,previous_release_id,detail_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)',
      relId, toolId, sub.id, sub.image_digest, 'pending', prev?.id ?? null, JSON.stringify({ kind: 'release', fromTrial: parallel.id, steps: [], actor, reason: note.trim() } satisfies Detail), t, t);
    store.run("INSERT INTO jobs(id,submission_id,kind,status,created_at,release_id) VALUES (?,?,'release','queued',?,?)", jobId, sub.id, t, relId);
    store.audit(actor, 'tool.publish_requested', relId, { tool: toolId, version: sub.version, trialRelease: parallel.id, note: note.trim() });
  });
  return { mode: 'promote' as const, version: sub.version, releaseId: relId, jobId };
}

/** AI Team：取消公開，工具退回試用中（容器照跑，一般使用者看不到）。 */
export function unpublish(store: Store, toolId: string, actor: string, reason: string) {
  if (!reason.trim()) throw new GateError(['請說明取消公開的原因']);
  if (visibilityOf(store, toolId) !== 'public') throw new GateError(['此工具目前不是公開狀態']);
  store.tx(() => {
    store.run("UPDATE tools SET visibility='trial', updated_at=? WHERE id=?", now(), toolId);
    store.audit(actor, 'tool.unpublished', toolId, { reason: reason.trim() });
  });
}

/** 結束試用：捨棄已公開工具的試用版（容器與試用資料），該提交改為已取消；正式版本不受影響。 */
export async function endTrial(store: Store, rt: Runtime, toolId: string, actor: string, reason: string) {
  if (!reason.trim()) throw new GateError(['請說明結束試用的原因']);
  const tr = trialRelease(store, toolId) as Rel | undefined;
  if (!tr) throw new GateError(['此工具目前沒有試用中的新版本']);
  if (store.get("SELECT id FROM releases WHERE tool_id=? AND status IN ('pending','starting')", toolId)) throw new GateError(['此工具已有發布工作進行中']);
  await rt.remove(trialContainerName(toolId));
  if (tr.volume) await rt.removeVolume(trialVolumeName(toolId));
  const d = JSON.parse(tr.detail_json) as Detail;
  const t = now();
  d.ended = { at: t, actor, reason: reason.trim() };
  store.tx(() => {
    store.run("UPDATE releases SET status='trial_ended', detail_json=?, updated_at=? WHERE id=?", JSON.stringify(d), t, tr.id);
    store.run('UPDATE approvals SET revoked_at=? WHERE submission_id=? AND revoked_at IS NULL', t, tr.submission_id);
    store.setSubmissionStatus(tr.submission_id, 'withdrawn');
    store.audit(actor, 'trial.ended', tr.id, { tool: toolId, reason: reason.trim() });
  });
}
