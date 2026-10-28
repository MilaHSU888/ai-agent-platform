/**
 * 階段 D：工具的模型存取。
 * - 每個工具在自己的隔離網路 wh-net-<tool>（--internal，沒有對外路由），只連得到模型轉接服務（別名 llm-relay）。
 * - 工具環境變數拿到的是：轉接服務網址、該工具專用的轉接通行碼、核准模型名稱。真正的模型金鑰只在轉接服務裡。
 * - 端點或預設模型未設定時，工具照常啟動但沒有模型設定（工具會顯示「AI 未設定」），不會退回其他端點。
 * - 哪個工具用哪個端點／模型由平台決定（models.ts），轉接服務依 routes.json 即時改送，不需重啟工具。
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Config } from './config.ts';
import type { Manifest } from './manifest.ts';
import type { Ctx, Runtime } from './runtime.ts';
import type { Secrets } from './secrets.ts';
import type { Store } from './db.ts';
import { configuredEndpoints, routesDir, toolModel, writeRoutes } from './models.ts';

export const RELAY_NAME = 'wh-llm-relay';
export const RELAY_ALIAS = 'llm-relay';
export const RELAY_URL = `http://${RELAY_ALIAS}:8080/v1`;
const RELAY_SCRIPT = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'relay', 'llm_relay.py');

export const toolNetwork = (toolId: string) => `wh-net-${toolId}`;

export type ModelAccess = { env: Record<string, string>; network: string; note: string };

/** 計算給轉接服務的設定（所有已設定的端點與金鑰、工具通行碼）；回傳 null 表示還沒有任何端點 */
export function relayEnv(cfg: Config, secrets: Secrets): Record<string, string> | null {
  const ids = configuredEndpoints(secrets);
  if (!ids.length) return null;
  const endpoints = Object.fromEntries(ids.map((id) => { const e = secrets.endpoint(id)!; return [id, { base: e.env.OPENAI_BASE_URL, key: e.env.OPENAI_API_KEY }]; }));
  const tokens = Object.fromEntries(Object.entries(secrets.relayTokens()).map(([tool, tok]) => [tok, tool]));
  return {
    RELAY_ENDPOINTS: JSON.stringify(endpoints),
    RELAY_TOKENS: JSON.stringify(tokens),
    RELAY_ROUTES_FILE: '/routes/routes.json',
    RELAY_TIMEOUT_SECONDS: String(cfg.relay.timeoutSeconds),
  };
}

/** 讓轉接服務與目前設定一致（端點金鑰、工具清單）。路由（哪個工具用哪個模型）放在 routes.json，轉接服務即時重新載入，不需重啟。 */
export async function syncRelay(cfg: Config, rt: Runtime, secrets: Secrets, store: Store, ctx?: Ctx): Promise<{ ok: boolean; detail: string }> {
  const env = relayEnv(cfg, secrets);
  if (!env) return { ok: false, detail: '模型端點尚未設定' };
  writeRoutes(cfg, store);
  const networks = Object.keys(secrets.relayTokens()).map(toolNetwork);
  for (const n of networks) await rt.ensureNetwork(n, cfg.toolNetworkInternal, ctx);
  // 設定、映像或轉接程式本身有變都重建轉接服務（程式更新後重開上架服務即生效）
  const hash = createHash('sha256').update(JSON.stringify(env)).update(cfg.relay.image).update(existsSync(RELAY_SCRIPT) ? readFileSync(RELAY_SCRIPT) : '').digest('hex').slice(0, 16);
  return rt.ensureRelay({ name: RELAY_NAME, image: cfg.relay.image, script: RELAY_SCRIPT, logsDir: join(cfg.dataDir, 'relay-logs'), routesDir: routesDir(cfg), env, hash, networks, alias: RELAY_ALIAS }, ctx);
}

/** 啟動工具容器前呼叫：準備隔離網路與轉接服務，回傳要給容器的網路與環境變數。
 *  用哪個模型由平台決定（AI Team 指定，否則平台預設）；workhub.yaml 的 approvedEndpoint 不再需要（DEC-040）。 */
export async function prepareModelAccess(cfg: Config, rt: Runtime, secrets: Secrets, store: Store, m: Manifest, toolId: string, ctx?: Ctx): Promise<ModelAccess> {
  const network = toolNetwork(toolId);
  if (!(await rt.ensureNetwork(network, cfg.toolNetworkInternal, ctx))) throw new Error(`無法建立工具隔離網路 ${network}`);
  if (!m.model.uses) return { env: {}, network, note: '此工具不使用模型' };
  if (!relayEnv(cfg, secrets)) return { env: {}, network, note: '模型端點尚未設定（請執行「設定模型端點」），工具的 AI 功能會顯示未設定' };
  const resolved = toolModel(store, toolId).ref;
  if (!resolved) return { env: {}, network, note: '平台預設模型尚未設定（請 AI Team 在平台設定 → 模型端點選擇預設模型），工具的 AI 功能會顯示未設定' };
  const token = secrets.relayToken(toolId);
  const r = await syncRelay(cfg, rt, secrets, store, ctx);
  if (!r.ok) throw new Error(r.detail);
  const wanted = new Set([...m.env.required, ...m.env.optional].map((e) => e.name));
  const all: Record<string, string> = { OPENAI_BASE_URL: RELAY_URL, OPENAI_API_KEY: token, OPENAI_MODEL: resolved.model };
  return { env: Object.fromEntries(Object.entries(all).filter(([k, v]) => wanted.has(k) && v)), network, note: `模型經轉接服務連到 ${resolved.endpoint}（${resolved.model}；換模型由轉接服務即時套用）` };
}
