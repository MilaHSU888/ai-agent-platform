/**
 * 設定核准模型端點 wisely-5090（階段 D）。由 Mila 在自己的終端機執行：
 * - 金鑰從標準輸入讀取（.command 以隱藏輸入收取後經管線傳入），不出現在指令列、畫面或日誌
 * - 先以金鑰呼叫 GET /models 驗證，再做一次文字與一次圖片的最小測試，通過才寫入 secrets.json（權限 0600）
 * - 只印出狀態碼、模型名稱與耗時，不印回應內容以外的任何憑證資訊
 */
import { createInterface } from 'node:readline';
import { openSync, createReadStream } from 'node:fs';
import { loadConfig } from '../src/config.ts';
import { Secrets } from '../src/secrets.ts';

const ENDPOINT_ID = 'wisely-5090';
// 端點網址不寫在程式裡：由 .command 詢問（Enter＝沿用已儲存的網址），經環境變數 MODEL_BASE_URL 傳入
const BASE = (process.env.MODEL_BASE_URL ?? '').trim().replace(/\/$/, '');
const UA = 'WorkHub-Onboarding/0.1';
// 64x32 PNG：左半紅、右半藍，用於確認模型能讀圖
const IMG = 'iVBORw0KGgoAAAANSUhEUgAAAEAAAAAgCAIAAAAt/+nTAAAAOElEQVR4nO3PsQkAAAzDsPz/dHpFliLwbFCaTBvvu94DAAAAAAAAAAAAAAAAAAAAAAAAAAAAPAQcOkv4asq/aw0AAAAASUVORK5CYII=';

async function readKey(): Promise<string> {
  let data = '';
  for await (const chunk of process.stdin) data += chunk;
  return data.split(/\r?\n/)[0].trim();
}

async function ask(q: string): Promise<string> {
  const tty = createReadStream('', { fd: openSync('/dev/tty', 'r') });
  const rl = createInterface({ input: tty, output: process.stdout });
  const a = await new Promise<string>((r) => rl.question(q, r));
  rl.close(); tty.destroy();
  return a.trim();
}

async function call(path: string, key: string, body?: unknown, timeoutMs = 125_000) {
  const t0 = Date.now();
  try {
    const res = await fetch(BASE + path, {
      method: body ? 'POST' : 'GET',
      headers: { Authorization: `Bearer ${key}`, 'User-Agent': UA, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text();
    let json: any = null; try { json = JSON.parse(text); } catch { /* 非 JSON */ }
    return { status: res.status, json, seconds: ((Date.now() - t0) / 1000).toFixed(1) };
  } catch (e) {
    return { status: 0, json: null, seconds: ((Date.now() - t0) / 1000).toFixed(1), error: (e as Error).name === 'TimeoutError' ? '逾時' : (e as Error).message };
  }
}

const key = await readKey();
if (key.length < 16) { console.log('✗ 沒有收到金鑰（或長度不足），未做任何變更。'); process.exit(1); }
if (!/^https?:\/\//.test(BASE)) { console.log('✗ 沒有收到端點網址（需以 https:// 開頭），未做任何變更。'); process.exit(1); }
console.log(`\n端點：${BASE}`);

const models = await call('/models', key, undefined, 20_000);
if (models.status !== 200) {
  console.log(`✗ 取得模型清單失敗：HTTP ${models.status}${'error' in models && models.error ? `（${models.error}）` : ''}`);
  console.log(models.status === 401 ? '  金鑰無效或已更換，請向 Wisely 確認。' : models.status === 0 ? '  Mac 連不到端點，請確認網路／VPN。' : '');
  process.exit(1);
}
const ids: string[] = (models.json?.data ?? []).map((m: { id: string }) => m.id);
console.log(`✓ 金鑰有效，模型清單 ${ids.length} 個（${models.seconds} 秒）：`);
ids.forEach((id, i) => console.log(`  ${i + 1}. ${id}`));
const def = Math.max(0, ids.findIndex((id) => /qwen.*vision|vision.*qwen|huihui/i.test(id)));
const pick = await ask(`\n選擇工具要用的模型編號（直接按 Enter＝${def + 1}）：`);
const model = ids[(pick ? Number(pick) : def + 1) - 1];
if (!model) { console.log('✗ 編號不正確，未做任何變更。'); process.exit(1); }

console.log(`\n測試 ${model}…`);
const text = await call('/chat/completions', key, { model, messages: [{ role: 'user', content: '只回覆 OK 兩個字母' }], max_tokens: 10, temperature: 0 });
const textOut = String(text.json?.choices?.[0]?.message?.content ?? '').trim();
console.log(`${text.status === 200 ? '✓' : '✗'} 文字測試：HTTP ${text.status}，${text.seconds} 秒${text.status === 200 ? `，回覆「${textOut.slice(0, 20)}」` : ''}`);
const img = await call('/chat/completions', key, { model, max_tokens: 20, temperature: 0, messages: [{ role: 'user', content: [
  { type: 'text', text: '這張圖左邊和右邊各是什麼顏色？用「左X右Y」回答。' },
  { type: 'image_url', image_url: { url: `data:image/png;base64,${IMG}` } }] }] });
const imgOut = String(img.json?.choices?.[0]?.message?.content ?? '').trim();
console.log(`${img.status === 200 ? '✓' : '✗'} 圖片測試：HTTP ${img.status}，${img.seconds} 秒${img.status === 200 ? `，回覆「${imgOut.slice(0, 30)}」` : ''}`);
if (text.status !== 200 || img.status !== 200) { console.log('\n✗ 測試未通過，未寫入設定。'); process.exit(1); }

const cfg = loadConfig();
new Secrets(cfg.dataDir).set(ENDPOINT_ID, { OPENAI_BASE_URL: BASE, OPENAI_API_KEY: key, OPENAI_MODEL: model }, ['OPENAI_API_KEY']);
console.log(`\n✓ 已寫入 ${ENDPOINT_ID} 設定（${cfg.dataDir}/secrets.json，權限 0600）。`);
console.log('  請重新啟動上架服務讓設定生效。');
