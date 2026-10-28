/**
 * 模型管理（DEC-040，2026/10/28）：
 * - 端點：平台安全設定（secrets.json，由「設定模型端點」指令輸入）裡的每個端點，標示地端／雲端；網站看不到金鑰。
 * - 模型清單：即時向端點查詢 GET /models，AI Team 勾選哪些可以用（model_catalog）。
 * - 平台預設模型：沒被指定的工具都用它；只能是地端模型。
 * - 工具指定模型：AI Team 在發布管理指定，立即生效（轉接服務每次請求依 routes.json 改送），不需重啟工具或重新審核；
 *   留稽核紀錄並在開發者中心提醒工具 Owner。勾「僅限地端」的工具不能用雲端模型。
 * - 開發者不必寫端點代號：workhub.yaml 只要 model.uses: true。
 */
import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Config } from './config.ts';
import { newId, now, type Store } from './db.ts';
import type { Runtime } from './runtime.ts';
import type { Secrets } from './secrets.ts';

export type Location = 'local' | 'cloud';
export type ModelRef = { endpoint: string; model: string };
export type EndpointInfo = { id: string; location: Location; reachable: boolean; error?: string; models: { id: string; enabled: boolean; isDefault: boolean; available: boolean; usedBy: string[] }[] };

const KEY_DEFAULT = 'default_model';
export const routesDir = (cfg: Config) => join(cfg.dataDir, 'relay-routes');

/** 端點位置：secrets 內有標示就用；wisely-5090 為地端（Mila 2026/10/28 確認）；其他未標示的一律視為雲端（較安全） */
export function locationOf(secrets: Secrets, endpoint: string): Location {
  const loc = secrets.endpoint(endpoint)?.location;
  if (loc === 'local' || loc === 'cloud') return loc;
  return endpoint === 'wisely-5090' ? 'local' : 'cloud';
}

export function configuredEndpoints(secrets: Secrets): string[] {
  return secrets.configured().filter((id) => { const e = secrets.endpoint(id); return !!(e?.env.OPENAI_BASE_URL && e.env.OPENAI_API_KEY); });
}

export function defaultModel(store: Store): ModelRef | null {
  const v = store.get<{ value: string }>('SELECT value FROM platform_settings WHERE key=?', KEY_DEFAULT)?.value;
  return v ? JSON.parse(v) as ModelRef : null;
}

export function toolModel(store: Store, toolId: string): { ref: ModelRef | null; source: 'tool' | 'default' | 'none'; localOnly: boolean } {
  const t = store.get<{ model_json: string | null; local_only: number }>('SELECT model_json, local_only FROM tools WHERE id=?', toolId);
  const own = t?.model_json ? JSON.parse(t.model_json) as ModelRef : null;
  if (own) return { ref: own, source: 'tool', localOnly: !!t?.local_only };
  const d = defaultModel(store);
  return { ref: d, source: d ? 'default' : 'none', localOnly: !!t?.local_only };
}

const enabled = (store: Store, r: ModelRef) => !!store.get('SELECT 1 FROM model_catalog WHERE endpoint=? AND model=? AND enabled=1', r.endpoint, r.model);
const same = (a: ModelRef | null, b: ModelRef | null) => !!a && !!b && a.endpoint === b.endpoint && a.model === b.model;
const label = (r: ModelRef | null) => r ? r.model : '（未設定）';

/** 轉接服務讀的路由檔（不含金鑰）：每次變更以暫存檔＋rename 原子更新，轉接服務依修改時間即時重新載入 */
export function writeRoutes(cfg: Config, store: Store) {
  const tools = Object.fromEntries(store.all<{ id: string; model_json: string }>('SELECT id, model_json FROM tools WHERE model_json IS NOT NULL').map((t) => [t.id, JSON.parse(t.model_json)]));
  const dir = routesDir(cfg);
  mkdirSync(dir, { recursive: true });
  const tmp = join(dir, `.routes-${process.pid}.tmp`);
  writeFileSync(tmp, JSON.stringify({ default: defaultModel(store), tools, updatedAt: now() }, null, 2), { mode: 0o644 });
  renameSync(tmp, join(dir, 'routes.json'));
}

/** 即時查詢每個端點的模型清單，合併 AI Team 勾選狀態與使用中的工具 */
export async function listEndpoints(store: Store, rt: Runtime, secrets: Secrets): Promise<EndpointInfo[]> {
  const def = defaultModel(store);
  const tools = store.all<{ id: string; name: string; model_json: string | null }>("SELECT id, name, model_json FROM tools WHERE archived_json IS NULL");
  const out: EndpointInfo[] = [];
  for (const id of configuredEndpoints(secrets)) {
    const e = secrets.endpoint(id)!;
    const live = await rt.listModels(e.env.OPENAI_BASE_URL, e.env.OPENAI_API_KEY).catch((err: Error) => ({ ok: false as const, error: err.message }));
    const liveIds = live.ok ? live.ids : [];
    const cat = store.all<{ model: string; enabled: number }>('SELECT model, enabled FROM model_catalog WHERE endpoint=?', id);
    const ids = [...new Set([...liveIds, ...cat.map((c) => c.model)])];
    out.push({
      id, location: locationOf(secrets, id), reachable: live.ok, error: live.ok ? undefined : live.error,
      models: ids.map((m) => {
        const ref = { endpoint: id, model: m };
        const usedBy = tools.filter((t) => t.model_json && same(JSON.parse(t.model_json), ref)).map((t) => t.name);
        return { id: m, enabled: !!cat.find((c) => c.model === m && c.enabled), isDefault: same(def, ref), available: liveIds.includes(m), usedBy };
      }),
    });
  }
  return out;
}

/** 第一次使用時設定預設模型：優先 Huihui Qwen … Vision（Mila 2026/10/28 指定），否則用端點設定時選的模型 */
export async function seedDefault(cfg: Config, store: Store, rt: Runtime, secrets: Secrets) {
  if (defaultModel(store)) return;
  for (const id of configuredEndpoints(secrets).filter((x) => locationOf(secrets, x) === 'local')) {
    const e = secrets.endpoint(id)!;
    const live = await rt.listModels(e.env.OPENAI_BASE_URL, e.env.OPENAI_API_KEY).catch(() => ({ ok: false as const, error: '' }));
    const ids = live.ok ? live.ids : [];
    const pick = ids.find((m) => /huihui/i.test(m) && /vision/i.test(m)) ?? ids.find((m) => /huihui/i.test(m)) ?? e.env.OPENAI_MODEL;
    if (!pick) continue;
    store.tx(() => {
      store.run('INSERT INTO model_catalog(endpoint, model, enabled, updated_at, actor) VALUES (?,?,1,?,?) ON CONFLICT(endpoint, model) DO UPDATE SET enabled=1, updated_at=excluded.updated_at', id, pick, now(), 'system');
      store.run('INSERT INTO platform_settings(key, value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', KEY_DEFAULT, JSON.stringify({ endpoint: id, model: pick }));
      store.audit('system', 'model.default_seeded', null, { endpoint: id, model: pick });
    });
    writeRoutes(cfg, store);
    return;
  }
}

export function setEnabled(cfg: Config, store: Store, secrets: Secrets, actor: string, r: ModelRef, on: boolean): string[] {
  if (!configuredEndpoints(secrets).includes(r.endpoint)) return ['找不到此模型端點'];
  if (!r.model.trim()) return ['缺少模型名稱'];
  if (!on) {
    if (same(defaultModel(store), r)) return ['這是平台預設模型，請先改用其他預設模型再停用'];
    const users = store.all<{ name: string; model_json: string }>('SELECT name, model_json FROM tools WHERE model_json IS NOT NULL AND archived_json IS NULL').filter((t) => same(JSON.parse(t.model_json), r));
    if (users.length) return [`還有工具指定使用這個模型：${users.map((u) => u.name).join('、')}，請先改用其他模型`];
  }
  store.tx(() => {
    store.run('INSERT INTO model_catalog(endpoint, model, enabled, updated_at, actor) VALUES (?,?,?,?,?) ON CONFLICT(endpoint, model) DO UPDATE SET enabled=excluded.enabled, updated_at=excluded.updated_at, actor=excluded.actor', r.endpoint, r.model, on ? 1 : 0, now(), actor);
    store.audit(actor, on ? 'model.enabled' : 'model.disabled', null, r);
  });
  void cfg;
  return [];
}

export function setDefault(cfg: Config, store: Store, secrets: Secrets, actor: string, r: ModelRef, reason: string): string[] {
  if (!configuredEndpoints(secrets).includes(r.endpoint)) return ['找不到此模型端點'];
  if (!enabled(store, r)) return ['請先勾選這個模型為可用'];
  if (locationOf(secrets, r.endpoint) !== 'local') return ['平台預設模型必須是地端模型'];
  const before = defaultModel(store);
  if (same(before, r)) return [];
  // 跟著預設走的工具會一起換：通知這些工具的 Owner
  const followers = store.all<{ id: string; name: string; owner: string; manifest_json: string }>(
    `SELECT t.id, t.name, t.owner, s.manifest_json FROM tools t JOIN submissions s ON s.id=(SELECT id FROM submissions WHERE tool_id=t.id ORDER BY revision DESC LIMIT 1)
     WHERE t.model_json IS NULL AND t.archived_json IS NULL AND t.kind='zip'`).filter((t) => (JSON.parse(t.manifest_json) as { model?: { uses?: boolean } }).model?.uses);
  store.tx(() => {
    store.run('INSERT INTO platform_settings(key, value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', KEY_DEFAULT, JSON.stringify(r));
    store.audit(actor, 'model.default_changed', null, { from: before, to: r, reason: reason.trim() || undefined });
    for (const t of followers) notify(store, t.id, t.owner, 'model', `平台預設模型由 ${label(before)} 改為 ${r.model}，${t.name} 跟著預設，已改用新模型${reason.trim() ? `（原因：${reason.trim()}）` : ''}`);
  });
  writeRoutes(cfg, store);
  return [];
}

/** ref 為 null 代表改回「使用平台預設」 */
export function setToolModel(cfg: Config, store: Store, secrets: Secrets, actor: string, toolId: string, ref: ModelRef | null, reason: string): string[] {
  const tool = store.get<{ name: string; owner: string; kind: string; archived_json: string | null }>('SELECT name, owner, kind, archived_json FROM tools WHERE id=?', toolId);
  if (!tool || tool.archived_json) return ['找不到此工具'];
  if (tool.kind === 'url') return ['URL 工具的模型由該網站自行設定，平台無法指定'];
  if (!reason.trim()) return ['請說明更換原因（會留在紀錄並通知工具 Owner）'];
  const cur = toolModel(store, toolId);
  if (ref) {
    if (!configuredEndpoints(secrets).includes(ref.endpoint)) return ['找不到此模型端點'];
    if (!enabled(store, ref)) return ['這個模型尚未設為可用'];
    if (cur.localOnly && locationOf(secrets, ref.endpoint) !== 'local') return ['此工具設定為「僅限地端」，不能使用雲端模型'];
  }
  const next = ref ?? defaultModel(store);
  store.tx(() => {
    store.run('UPDATE tools SET model_json=?, updated_at=? WHERE id=?', ref ? JSON.stringify(ref) : null, now(), toolId);
    store.audit(actor, 'tool.model_changed', toolId, { from: cur.ref, fromSource: cur.source, to: ref, useDefault: !ref, reason: reason.trim() });
    notify(store, toolId, tool.owner, 'model', `AI Team 已將 ${tool.name} 改用 ${label(next)}${ref ? '' : '（平台預設）'}（原因：${reason.trim()}）`);
  });
  writeRoutes(cfg, store);
  return [];
}

export function setLocalOnly(store: Store, secrets: Secrets, actor: string, toolId: string, on: boolean): string[] {
  if (!store.get('SELECT 1 FROM tools WHERE id=? AND archived_json IS NULL', toolId)) return ['找不到此工具'];
  const cur = toolModel(store, toolId);
  if (on && cur.ref && locationOf(secrets, cur.ref.endpoint) !== 'local') return ['此工具目前使用雲端模型，請先改用地端模型再勾選「僅限地端」'];
  store.tx(() => {
    store.run('UPDATE tools SET local_only=?, updated_at=? WHERE id=?', on ? 1 : 0, now(), toolId);
    store.audit(actor, on ? 'tool.local_only_on' : 'tool.local_only_off', toolId, {});
  });
  return [];
}

export function notify(store: Store, toolId: string, owner: string, kind: string, message: string) {
  store.run('INSERT INTO notices(id, tool_id, owner, kind, message, created_at) VALUES (?,?,?,?,?,?)', newId('ntc'), toolId, owner, kind, message, now());
}
