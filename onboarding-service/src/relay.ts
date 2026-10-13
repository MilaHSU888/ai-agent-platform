/**
 * 階段 D：工具的模型存取。
 * - 每個工具在自己的隔離網路 wh-net-<tool>（--internal，沒有對外路由），只連得到模型轉接服務（別名 llm-relay）。
 * - 工具環境變數拿到的是：轉接服務網址、該工具專用的轉接通行碼、核准模型名稱。真正的模型金鑰只在轉接服務裡。
 * - 核准端點未設定時，工具照常啟動但沒有模型設定（工具會顯示「AI 未設定」），不會退回其他端點。
 */
import { createHash } from 'node:crypto';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Config } from './config.ts';
import type { Manifest } from './manifest.ts';
import type { Ctx, Runtime } from './runtime.ts';
import type { Secrets } from './secrets.ts';

export const RELAY_NAME = 'wh-llm-relay';
export const RELAY_ALIAS = 'llm-relay';
export const RELAY_URL = `http://${RELAY_ALIAS}:8080/v1`;
const RELAY_SCRIPT = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'relay', 'llm_relay.py');

export const toolNetwork = (toolId: string) => `wh-net-${toolId}`;

export type ModelAccess = { env: Record<string, string>; network: string; note: string };

/** 計算給轉接服務的設定；回傳 null 表示核准端點尚未設定 */
export function relayEnv(cfg: Config, secrets: Secrets): Record<string, string> | null {
  const ep = secrets.endpoint(cfg.approvedModelEndpoints[0]);
  if (!ep?.env.OPENAI_BASE_URL || !ep.env.OPENAI_API_KEY) return null;
  const tokens = Object.fromEntries(Object.entries(secrets.relayTokens()).map(([tool, tok]) => [tok, tool]));
  return {
    RELAY_UPSTREAM: ep.env.OPENAI_BASE_URL,
    RELAY_UPSTREAM_KEY: ep.env.OPENAI_API_KEY,
    RELAY_TOKENS: JSON.stringify(tokens),
    RELAY_MODELS: ep.env.OPENAI_MODEL ?? '',
    RELAY_TIMEOUT_SECONDS: String(cfg.relay.timeoutSeconds),
  };
}

/** 讓轉接服務與目前設定一致（金鑰、模型、工具清單）。服務啟動時與每次啟動工具前呼叫。 */
export async function syncRelay(cfg: Config, rt: Runtime, secrets: Secrets, ctx?: Ctx): Promise<{ ok: boolean; detail: string }> {
  const env = relayEnv(cfg, secrets);
  if (!env) return { ok: false, detail: '核准模型端點尚未設定' };
  const networks = Object.keys(secrets.relayTokens()).map(toolNetwork);
  for (const n of networks) await rt.ensureNetwork(n, cfg.toolNetworkInternal, ctx);
  const hash = createHash('sha256').update(JSON.stringify(env)).update(cfg.relay.image).digest('hex').slice(0, 16);
  return rt.ensureRelay({ name: RELAY_NAME, image: cfg.relay.image, script: RELAY_SCRIPT, logsDir: join(cfg.dataDir, 'relay-logs'), env, hash, networks, alias: RELAY_ALIAS }, ctx);
}

/** 啟動工具容器前呼叫：準備隔離網路與轉接服務，回傳要給容器的網路與環境變數 */
export async function prepareModelAccess(cfg: Config, rt: Runtime, secrets: Secrets, m: Manifest, toolId: string, ctx?: Ctx): Promise<ModelAccess> {
  const network = toolNetwork(toolId);
  if (!(await rt.ensureNetwork(network, cfg.toolNetworkInternal, ctx))) throw new Error(`無法建立工具隔離網路 ${network}`);
  if (!m.model.uses) return { env: {}, network, note: '此工具不使用模型' };
  if (!m.model.approvedEndpoint || !cfg.approvedModelEndpoints.includes(m.model.approvedEndpoint)) {
    return { env: {}, network, note: `模型端點 ${m.model.approvedEndpoint ?? '（未指定）'} 未核准，工具不會拿到模型設定` };
  }
  const token = secrets.relayToken(toolId);
  const env = relayEnv(cfg, secrets);
  if (!env) return { env: {}, network, note: '核准模型端點尚未設定（請執行「設定模型端點」），工具的 AI 功能會顯示未設定' };
  const r = await syncRelay(cfg, rt, secrets, ctx);
  if (!r.ok) throw new Error(r.detail);
  const wanted = new Set([...m.env.required, ...m.env.optional].map((e) => e.name));
  const all: Record<string, string> = { OPENAI_BASE_URL: RELAY_URL, OPENAI_API_KEY: token, OPENAI_MODEL: env.RELAY_MODELS };
  return { env: Object.fromEntries(Object.entries(all).filter(([k, v]) => wanted.has(k) && v)), network, note: `模型經轉接服務連到 ${m.model.approvedEndpoint}（${env.RELAY_MODELS || '未指定模型'}）` };
}
