/**
 * 維運中心的實際操作（已發布工具）：
 * - 維護模式：工具入口關閉、顯示維護中；容器照跑，管理者仍可用原網址測試。與「下架」不同（下架會停容器）。
 * - 重新啟動：重啟上線中的容器（資料保留），健康檢查通過才算完成，否則回報失敗。
 * - 查看日誌：讀取上線中容器最近的日誌，遮罩金鑰與通行碼。
 * - 封存：停止工具的所有容器（正式、試用、預覽），並從網站各頁移除；資料卷與紀錄保留，不是永久刪除。
 * 每個動作都寫入稽核紀錄，維運中心的「近期事件」由此讀取。
 */
import type { Config } from './config.ts';
import { now, type Store } from './db.ts';
import { GateError } from './approvals.ts';
import { makeMasker } from './exec.ts';
import type { Manifest } from './manifest.ts';
import { waitHealthy } from './pipeline.ts';
import { activeRelease, containerName, trialContainerName } from './releases.ts';
import type { Runtime } from './runtime.ts';
import type { Secrets } from './secrets.ts';

export type Maintenance = { at: string; actor: string; reason: string };

/** 封存工具：停止並移除容器（資料卷保留）、未完成的提交改為已取消、從入口與管理頁移除。 */
export async function archiveTool(store: Store, rt: Runtime, toolId: string, actor: string, reason: string) {
  if (!reason.trim()) throw new GateError(['請說明封存原因']);
  const tool = store.get<{ archived_json: string | null }>('SELECT archived_json FROM tools WHERE id=?', toolId);
  if (!tool) throw new GateError(['找不到此工具']);
  if (tool.archived_json) throw new GateError(['此工具已封存']);
  if (store.get("SELECT id FROM releases WHERE tool_id=? AND status IN ('pending','starting')", toolId)
    || store.get("SELECT j.id FROM jobs j JOIN submissions s ON s.id=j.submission_id WHERE s.tool_id=? AND j.status IN ('queued','running')", toolId)) {
    throw new GateError(['此工具有工作正在進行，請等完成後再封存']);
  }
  for (const name of [containerName(toolId), trialContainerName(toolId), `wh-preview-${toolId}`]) await rt.remove(name);
  const t = now();
  const info = { at: t, actor, reason: reason.trim() };
  store.tx(() => {
    for (const r of store.all<{ id: string; status: string; detail_json: string }>("SELECT id, status, detail_json FROM releases WHERE tool_id=? AND status IN ('active','trial')", toolId)) {
      const d = JSON.parse(r.detail_json) as Record<string, unknown>;
      if (r.status === 'active') d.offline = { ...info, reason: `封存：${info.reason}` }; else d.ended = { ...info, reason: `封存：${info.reason}` };
      store.run('UPDATE releases SET status=?, detail_json=?, updated_at=? WHERE id=?', r.status === 'active' ? 'offline' : 'trial_ended', JSON.stringify(d), t, r.id);
    }
    for (const s of store.all<{ id: string }>("SELECT id FROM submissions WHERE tool_id=? AND status NOT IN ('released','superseded','withdrawn')", toolId)) {
      store.run('UPDATE approvals SET revoked_at=? WHERE submission_id=? AND revoked_at IS NULL', t, s.id);
      store.setSubmissionStatus(s.id, 'withdrawn');
    }
    store.run('UPDATE tools SET archived_json=?, updated_at=? WHERE id=?', JSON.stringify(info), t, toolId);
    store.audit(actor, 'tool.archived', toolId, { reason: info.reason });
  });
}

export function maintenanceOf(store: Store, toolId: string): Maintenance | null {
  const row = store.get<{ maintenance_json: string | null }>('SELECT maintenance_json FROM tools WHERE id=?', toolId);
  return row?.maintenance_json ? JSON.parse(row.maintenance_json) as Maintenance : null;
}

function busy(store: Store, toolId: string) {
  return !!store.get("SELECT id FROM releases WHERE tool_id=? AND status IN ('pending','starting')", toolId);
}

export function setMaintenance(store: Store, toolId: string, on: boolean, actor: string, reason: string) {
  if (!activeRelease(store, toolId)) throw new GateError(['此工具目前沒有上線中的版本']);
  if (on && !reason.trim()) throw new GateError(['請說明進入維護的原因']);
  const cur = maintenanceOf(store, toolId);
  if (on && cur) throw new GateError(['此工具已在維護中']);
  if (!on && !cur) throw new GateError(['此工具不在維護中']);
  const m: Maintenance | null = on ? { at: now(), actor, reason: reason.trim() } : null;
  store.tx(() => {
    store.run('UPDATE tools SET maintenance_json=?, updated_at=? WHERE id=?', m ? JSON.stringify(m) : null, now(), toolId);
    store.audit(actor, on ? 'ops.maintenance_on' : 'ops.maintenance_off', toolId, { reason: reason.trim() || undefined, since: cur?.at });
  });
  return { maintenance: m };
}

export async function restartTool(store: Store, cfg: Config, rt: Runtime, toolId: string, actor: string, reason: string) {
  const rel = activeRelease(store, toolId);
  if (!rel?.port) throw new GateError(['此工具目前沒有上線中的版本']);
  if (busy(store, toolId)) throw new GateError(['此工具已有發布或回復工作進行中']);
  const sub = store.get<{ manifest_json: string; version: string }>('SELECT manifest_json, version FROM submissions WHERE id=?', rel.submission_id)!;
  const m = JSON.parse(sub.manifest_json) as Manifest;
  store.audit(actor, 'ops.restart_requested', toolId, { version: sub.version, reason: reason.trim() || undefined });
  const t0 = Date.now();
  const r = await rt.restart(containerName(toolId));
  const h = r.code === 0
    ? await waitHealthy(rt, `http://127.0.0.1:${rel.port}${m.run.healthCheck.path}`, m.run.healthCheck.expectStatus, m.run.healthCheck.startPeriodSeconds * 1000 + cfg.timeouts.healthMs, new AbortController().signal)
    : { ok: false, status: null, seconds: 0 };
  const result = { ok: h.ok, seconds: Math.round((Date.now() - t0) / 1000), healthStatus: h.status, error: r.code !== 0 ? r.stderr.slice(0, 300) : h.ok ? undefined : '健康檢查未通過' };
  store.audit(actor, h.ok ? 'ops.restart_succeeded' : 'ops.restart_failed', toolId, { version: sub.version, ...result });
  return result;
}

export async function toolLogs(store: Store, rt: Runtime, secrets: Secrets, toolId: string, tail = 200) {
  const rel = activeRelease(store, toolId);
  if (!rel) throw new GateError(['此工具目前沒有上線中的版本']);
  return rt.logsText(containerName(toolId), Math.min(Math.max(tail, 20), 1000), makeMasker(secrets.allSecretValues()));
}

const LABELS: Record<string, string> = {
  'ops.maintenance_on': '進入維護', 'ops.maintenance_off': '恢復服務', 'ops.restart_requested': '重新啟動', 'ops.restart_succeeded': '重新啟動完成，健康檢查通過',
  'ops.restart_failed': '重新啟動失敗', 'release.offline': '下架', 'release.succeeded': '發布成功', 'release.failed': '發布失敗',
  'rollback.succeeded': '回復版本完成', 'rollback.failed': '回復版本失敗', 'redeploy.succeeded': '重新上線完成', 'redeploy.failed': '重新上線失敗',
};

/** 維運中心「近期事件」：工具的維運、發布與回復紀錄（新的在前） */
export function opsEvents(store: Store, limit = 50) {
  const rows = store.all<{ at: string; actor: string; action: string; target: string | null; detail_json: string }>(
    `SELECT at, actor, action, target, detail_json FROM audit_events WHERE action IN (${Object.keys(LABELS).map(() => '?').join(',')}) ORDER BY id DESC LIMIT ?`,
    ...Object.keys(LABELS), limit);
  const names = new Map(store.all<{ id: string; name: string }>('SELECT id, name FROM tools').map((t) => [t.id, t.name]));
  const relTool = (id: string | null) => id ? store.get<{ tool_id: string }>('SELECT tool_id FROM releases WHERE id=?', id)?.tool_id : undefined;
  const archived = new Set(store.all<{ id: string }>('SELECT id FROM tools WHERE archived_json IS NOT NULL').map((t) => t.id));
  return rows.map((r) => {
    const d = JSON.parse(r.detail_json) as Record<string, unknown>;
    const toolId = (typeof d.tool === 'string' ? d.tool : undefined) ?? (names.has(r.target ?? '') ? r.target! : relTool(r.target));
    return { at: r.at, actor: r.actor, action: r.action, label: LABELS[r.action], toolId, toolName: toolId ? names.get(toolId) ?? toolId : null,
      bad: /failed|maintenance_on|offline/.test(r.action), reason: (d.reason as string) ?? (d.error as string) ?? undefined, version: d.version as string | undefined };
  }).filter((e) => !e.toolId || !archived.has(e.toolId));
}
