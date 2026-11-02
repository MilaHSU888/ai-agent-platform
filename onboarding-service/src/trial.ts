/**
 * 試用／公開燈號（2026/11/02 客戶回饋，取代 DEC-032 的「開發者試用通過 → AI Team 公開」）：
 * - 只有 AI Team 操作，三種狀態：試用中／公開中／下架。開發者不再按「試用通過」或「測試未通過」。
 * - 切到「公開中」：
 *   - 已公開工具的試用版（新版並行試用）→ 走一般更新流程換上正式版本（先備份、健康檢查失敗自動還原），完成後移除試用版。
 *   - 新工具第一次公開 → 直接清空試用期間的資料，以空白資料重新啟動後公開（runFirstPublishJob）。
 *   - 公開過、被切回試用中的工具 → 直接恢復公開，資料不動。
 * - 切到「試用中」：已公開的工具改為只有 Owner 與 AI Team 看得到；版本與資料不動（要退回舊版請用「回復」）。
 * - 切到「下架」（原稱「結束試用」，11/02 改名）：
 *   - 已公開工具的新版試用 → 只下架試用版（刪除容器與試用資料），一般使用者繼續用正式版本。
 *   - 其他（新工具、已公開的工具）→ 下架工具：停止容器、入口關閉，資料保留，之後可在「已下架」重新上架。
 * 每次切換都留稽核紀錄。本機試點沒有登入，身分由網站傳入的示範身分記錄（正式環境須依登入身分在後端檢查，P1-AUTH-006）。
 */
import type { Config } from './config.ts';
import { newId, now, type Store } from './db.ts';
import { GateError } from './approvals.ts';
import { activeRelease, busy, everPublished, takeOffline, trialContainerName, trialRelease, trialVolumeName, visibilityOf, type Detail } from './releases.ts';
import type { Runtime } from './runtime.ts';

type Sub = { id: string; tool_id: string; version: string; status: string; source_hash: string; image_digest: string | null; manifest_json: string; kind: string };
type Rel = { id: string; submission_id: string; image_digest: string; detail_json: string; volume: string | null; port: number | null };

export type LightTarget = 'trial' | 'public' | 'ended';
export type LightResult = { mode: 'visibility' | 'promote' | 'first_publish' | 'ended' | 'offline'; version: string; jobId?: string; releaseId?: string };

function tool(store: Store, toolId: string) {
  const t = store.get<{ id: string; kind: string; archived_json: string | null }>('SELECT id, kind, archived_json FROM tools WHERE id=?', toolId);
  if (!t || t.archived_json) throw new GateError(['找不到此工具']);
  return t;
}

/** AI Team 切換燈號。回傳 mode；promote／first_publish 會排入工作，完成後才生效。 */
export async function setLight(store: Store, cfg: Config, rt: Runtime, toolId: string, target: LightTarget, actor: string, note = ''): Promise<LightResult> {
  if (!['trial', 'public', 'ended'].includes(target)) throw new GateError(['燈號只能切換為試用中、公開中或下架']);
  const t = tool(store, toolId);
  if (busy(store, toolId)) throw new GateError(['此工具已有發布、公開或回復工作進行中，請稍候']);
  const parallel = trialRelease(store, toolId) as Rel | undefined;
  const active = activeRelease(store, toolId) as Rel | undefined;
  const vis = visibilityOf(store, toolId);
  const reason = note.trim();

  if (target === 'public') {
    if (parallel) return promote(store, cfg, toolId, parallel, actor, reason);
    if (vis === 'public') throw new GateError(['此工具已經是公開中']);
    if (!active) throw new GateError(['此工具目前沒有上線中的版本，無法公開']);
    const sub = store.get<Sub>('SELECT * FROM submissions WHERE id=?', active.submission_id)!;
    // 新工具第一次公開、且有資料卷：清空試用資料後重新啟動（排入工作）
    if (!everPublished(store, toolId) && t.kind !== 'url' && active.volume) {
      if (cfg.environment !== 'local') throw new GateError(['正式環境發布流程尚未開放（本機試點）']);
      const jobId = newId('job');
      store.tx(() => {
        store.run("INSERT INTO jobs(id,submission_id,kind,status,created_at,release_id) VALUES (?,?,'publish','queued',?,?)", jobId, sub.id, now(), active.id);
        store.audit(actor, 'tool.publish_requested', toolId, { version: sub.version, clearTrialData: true, note: reason || undefined });
      });
      return { mode: 'first_publish', version: sub.version, jobId };
    }
    const t0 = now();
    store.tx(() => {
      store.run('UPDATE tools SET visibility=\'public\', first_published_at=COALESCE(first_published_at, ?), updated_at=? WHERE id=?', t0, t0, toolId);
      store.audit(actor, 'tool.published', toolId, { version: sub.version, note: reason || undefined });
    });
    return { mode: 'visibility', version: sub.version };
  }

  if (target === 'trial') {
    if (parallel) throw new GateError(['新版本已在試用中；要公開請切到「公開中」，要捨棄請切到「下架」']);
    if (vis !== 'public') throw new GateError(['此工具已經是試用中']);
    const version = active ? store.get<{ version: string }>('SELECT version FROM submissions WHERE id=?', active.submission_id)?.version ?? '' : '';
    store.tx(() => {
      store.run("UPDATE tools SET visibility='trial', updated_at=? WHERE id=?", now(), toolId);
      store.audit(actor, 'tool.unpublished', toolId, { version, note: reason || undefined });
    });
    return { mode: 'visibility', version };
  }

  // 下架
  if (parallel) {
    const version = await endTrial(store, rt, toolId, actor, reason || '下架試用版');
    return { mode: 'ended', version };
  }
  if (!active) throw new GateError(['此工具目前沒有上線中的版本']);
  const version = store.get<{ version: string }>('SELECT version FROM submissions WHERE id=?', active.submission_id)?.version ?? '';
  await takeOffline(store, cfg, rt, toolId, actor, reason || (vis === 'public' ? '下架（已公開的工具）' : '下架（試用中的工具）'));
  return { mode: 'offline', version };
}

/** 已公開工具的試用版切到公開中：以一般更新流程換上正式版本（先備份、健康檢查失敗自動還原），完成後移除試用版 */
function promote(store: Store, cfg: Config, toolId: string, parallel: Rel, actor: string, note: string): LightResult {
  if (cfg.environment !== 'local') throw new GateError(['正式環境發布流程尚未開放（本機試點）']);
  const sub = store.get<Sub>('SELECT * FROM submissions WHERE id=?', parallel.submission_id)!;
  const approval = store.get("SELECT id FROM approvals WHERE submission_id=? AND kind='release_approval' AND revoked_at IS NULL AND source_hash=? AND image_digest IS ?", sub.id, sub.source_hash, sub.image_digest);
  if (!approval || !sub.image_digest) throw new GateError(['找不到對應這份 image 的發布核准']);
  const prev = activeRelease(store, toolId);
  const relId = newId('rel');
  const jobId = newId('job');
  const t = now();
  store.tx(() => {
    store.run('INSERT INTO releases(id,tool_id,submission_id,image_digest,status,previous_release_id,detail_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)',
      relId, toolId, sub.id, sub.image_digest, 'pending', prev?.id ?? null, JSON.stringify({ kind: 'release', fromTrial: parallel.id, steps: [], actor, reason: note || '切換為公開中' } satisfies Detail), t, t);
    store.run("INSERT INTO jobs(id,submission_id,kind,status,created_at,release_id) VALUES (?,?,'release','queued',?,?)", jobId, sub.id, t, relId);
    store.audit(actor, 'tool.publish_requested', relId, { tool: toolId, version: sub.version, trialRelease: parallel.id, note: note || undefined });
  });
  return { mode: 'promote', version: sub.version, releaseId: relId, jobId };
}

/** 下架試用版：捨棄已公開工具的試用版（容器與試用資料），該提交改為已取消；正式版本不受影響。 */
export async function endTrial(store: Store, rt: Runtime, toolId: string, actor: string, reason: string): Promise<string> {
  const tr = trialRelease(store, toolId) as Rel | undefined;
  if (!tr) throw new GateError(['此工具目前沒有試用中的新版本']);
  await rt.remove(trialContainerName(toolId));
  if (tr.volume) await rt.removeVolume(trialVolumeName(toolId));
  const d = JSON.parse(tr.detail_json) as Detail;
  const t = now();
  d.ended = { at: t, actor, reason };
  const version = store.get<{ version: string }>('SELECT version FROM submissions WHERE id=?', tr.submission_id)?.version ?? '';
  store.tx(() => {
    store.run("UPDATE releases SET status='trial_ended', detail_json=?, updated_at=? WHERE id=?", JSON.stringify(d), t, tr.id);
    store.run('UPDATE approvals SET revoked_at=? WHERE submission_id=? AND revoked_at IS NULL', t, tr.submission_id);
    store.setSubmissionStatus(tr.submission_id, 'withdrawn');
    store.audit(actor, 'trial.ended', tr.id, { tool: toolId, version, reason });
  });
  return version;
}
