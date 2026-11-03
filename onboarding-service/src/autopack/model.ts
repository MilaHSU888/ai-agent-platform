/**
 * 原始碼自動打包：地端模型（平台預設模型，5090）補程式與修正錯誤。
 * - 指令改寫自上架資料包的「給 AI 的打包指令」，拆成一次只做一件事的小步驟（地端 27B 模型能力比雲端 AI 弱）。
 * - 模型只能回傳「改哪個檔、改成什麼（完整內容）」，由平台檢查後套用；不能刪檔、不能改測試資料、不能修改專案原有的測試。
 * - 送給模型前遮掉金鑰；只送需要的檔案。
 */
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Config } from '../config.ts';
import type { Store } from '../db.ts';
import { defaultModel } from '../models.ts';
import type { Secrets } from '../secrets.ts';
import { SECRET_CONTENT } from '../zip-intake.ts';

export type Edit = { path: string; content: string };
export type ModelReply = { edits: Edit[]; note: string; raw: string };
/** 呼叫模型的介面（測試時替換成假模型） */
export type ModelFn = (system: string, user: string, signal: AbortSignal) => Promise<string>;

const SYSTEM = [
  '你是協助把公司內部小工具打包到 WorkHub 平台的工程助手。WorkHub 會把工具放進 Linux 容器執行。',
  '平台規則（上架 SOP）：',
  '1. 工具資料只能寫到環境變數 DATA_DIR 指定的資料夾（容器內是 /data），寫在其他地方的資料在更新後會不見。',
  '2. 呼叫 AI 模型只能用環境變數 OPENAI_BASE_URL、OPENAI_API_KEY、OPENAI_MODEL（OpenAI 相容的 /chat/completions 介面），不能寫死模型網址或金鑰；沒設定時要能正常啟動，只是 AI 功能顯示未設定。',
  '3. 工具要接受外部連線（監聽 0.0.0.0），並有健康檢查網址。',
  '4. 專案原有的測試檔一律不能修改（測試是驗收標準），要讓程式通過原本的測試；不可以刪除或跳過測試。',
  '5. 不要放任何金鑰、密碼或真實資料。',
  '回覆格式：只回一個 JSON 物件，不要其他文字：',
  '{"edits":[{"path":"相對於專案根目錄的路徑","content":"修改後的完整檔案內容"}],"note":"一句話說明改了什麼"}',
  '只修改必要的檔案；每個檔案都要回完整內容，不要只回片段；保留原本的註解與功能。',
].join('\n');

export function systemPrompt() { return SYSTEM; }

/** 遮掉疑似金鑰的內容 */
export function maskSecrets(text: string): string {
  let out = text;
  for (const s of SECRET_CONTENT) out = out.replace(new RegExp(s.re.source, s.re.flags.includes('g') ? s.re.flags : s.re.flags + 'g'), '[已遮蔽]');
  return out;
}

/** 從模型回覆取出 JSON（容忍前後有說明文字或 ```json 區塊） */
export function parseReply(raw: string): ModelReply {
  const cleaned = raw.replace(/<think>[\s\S]*?<\/think>/g, '');
  const fence = /```(?:json)?\s*([\s\S]*?)```/.exec(cleaned);
  const candidates = [fence?.[1], cleaned.slice(cleaned.indexOf('{'), cleaned.lastIndexOf('}') + 1)].filter((x): x is string => !!x && x.trim().startsWith('{'));
  for (const c of candidates) {
    try {
      const j = JSON.parse(c) as { edits?: { path?: unknown; content?: unknown }[]; note?: unknown };
      const edits = (j.edits ?? []).filter((e) => typeof e.path === 'string' && typeof e.content === 'string').map((e) => ({ path: String(e.path), content: String(e.content) }));
      return { edits, note: typeof j.note === 'string' ? j.note : '', raw };
    } catch { /* 試下一個 */ }
  }
  return { edits: [], note: '', raw };
}

const EDITABLE = /\.(py|js|mjs|cjs|ts|tsx|jsx|json|java|kt|kts|cs|go|php|html?|css|ya?ml|toml|txt|cfg|ini|xml|gradle|properties|sh|md|csproj|mod|sum)$|(^|\/)(Dockerfile|\.dockerignore|requirements[\w.-]*\.txt|Procfile)$/i;
const TEST_FILE = /(^|\/)(tests?|__tests__|spec)\/|(^|\/)(test_[^/]+|[^/]+_test)\.py$|\.(test|spec)\.[jt]sx?$|Tests?\.(java|cs)$|_test\.go$/;
const countSkips = (t: string) => (t.match(/pytest\.mark\.skip|pytest\.skip\(|unittest\.skip|\.skip\(|\bxit\(|\bxdescribe\(|@Disabled|@Ignore|\[Ignore\]|t\.Skip\(|\.only\(/g) ?? []).length;

/** 檢查模型的修改能不能套用；回傳可套用的修改與被擋下的原因 */
export function vetEdits(edits: Edit[], opts: { exists: (p: string) => boolean; read: (p: string) => string | null; testData: Set<string>; allowNew: (p: string) => boolean }): { ok: Edit[]; rejected: { path: string; reason: string }[] } {
  const ok: Edit[] = [];
  const rejected: { path: string; reason: string }[] = [];
  for (const e of edits) {
    const p = e.path.replace(/^\.?\//, '').replace(/\\/g, '/');
    if (!p || p.includes('..') || p.startsWith('/') || p.includes('\0')) { rejected.push({ path: e.path, reason: '路徑不安全' }); continue; }
    if (opts.testData.has(p)) { rejected.push({ path: p, reason: '不能修改測試資料' }); continue; }
    if (!EDITABLE.test(p)) { rejected.push({ path: p, reason: '只能修改程式碼與打包設定檔' }); continue; }
    if (!e.content.trim()) { rejected.push({ path: p, reason: '不能清空或刪除檔案' }); continue; }
    if (Buffer.byteLength(e.content) > 256 * 1024) { rejected.push({ path: p, reason: '檔案太大（超過 256 KB）' }); continue; }
    if (/^workhub\.yaml$/.test(p)) { rejected.push({ path: p, reason: 'workhub.yaml 由平台產生，模型不能修改' }); continue; }
    if (!opts.exists(p) && !opts.allowNew(p)) { rejected.push({ path: p, reason: '不能新增這個檔案' }); continue; }
    // 專案原有的測試是驗收標準：模型一律不能修改（2026/11/03 實測：模型改測試檔反而改出語法錯誤）
    if (TEST_FILE.test(p) && opts.exists(p)) { rejected.push({ path: p, reason: '專案原有的測試不能修改' }); continue; }
    if (TEST_FILE.test(p) && (countSkips(e.content) > 0)) { rejected.push({ path: p, reason: '不能跳過測試' }); continue; }
    ok.push({ path: p, content: e.content });
  }
  return { ok, rejected };
}

/** 實際呼叫平台預設模型（OpenAI 相容 /chat/completions）；呼叫紀錄寫進轉接服務的用量日誌（標為測試用量，不含內容） */
export function platformModel(cfg: Config, store: Store, secrets: Secrets, toolId: string): ModelFn | null {
  const ref = defaultModel(store);
  if (!ref) return null;
  const ep = secrets.endpoint(ref.endpoint);
  if (!ep?.env.OPENAI_BASE_URL || !ep.env.OPENAI_API_KEY) return null;
  const base = ep.env.OPENAI_BASE_URL.replace(/\/$/, '');
  return async (system, user, signal) => {
    const t0 = Date.now();
    const timeout = AbortSignal.any([signal, AbortSignal.timeout(cfg.autopack.modelTimeoutMs)]);
    let status = 0; let usage: { prompt_tokens?: number; completion_tokens?: number } = {};
    try {
      const r = await fetch(`${base}/chat/completions`, {
        method: 'POST', signal: timeout,
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ep.env.OPENAI_API_KEY}` },
        body: JSON.stringify({ model: ref.model, temperature: 0.1, max_tokens: 16000, messages: [{ role: 'system', content: system }, { role: 'user', content: user }] }),
      });
      status = r.status;
      if (!r.ok) throw new Error(`模型回應 ${r.status}`);
      const j = await r.json() as { choices?: { message?: { content?: string } }[]; usage?: typeof usage };
      usage = j.usage ?? {};
      return j.choices?.[0]?.message?.content ?? '';
    } finally {
      try {
        const dir = join(cfg.dataDir, 'relay-logs');
        mkdirSync(dir, { recursive: true });
        const day = new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10).replace(/-/g, '');
        appendFileSync(join(dir, `relay-${day}.jsonl`), JSON.stringify({ ts: new Date().toISOString(), stage: 'test', tool: toolId, source: 'autopack', endpoint: ref.endpoint, model: ref.model, path: '/v1/chat/completions', method: 'POST', status, ms: Date.now() - t0, prompt_tokens: usage.prompt_tokens ?? null, completion_tokens: usage.completion_tokens ?? null }) + '\n');
      } catch { /* 用量紀錄失敗不影響打包 */ }
    }
  };
}

/** 組一個任務的提示：說明要做的事＋相關檔案內容 */
export function taskPrompt(task: string, files: { path: string; content: string }[], extra = ''): string {
  return [
    `任務：${task}`,
    extra,
    '以下是相關檔案（金鑰已遮蔽）：',
    ...files.map((f) => `===== ${f.path} =====\n${maskSecrets(f.content)}`),
    '請依系統說明的 JSON 格式回覆。',
  ].filter(Boolean).join('\n\n');
}
