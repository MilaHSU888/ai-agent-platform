/**
 * 上架資料包（開發者中心「下載上架資料包」）：一個 ZIP，解開後是 workhub-kit/ 資料夾，內含
 * - WorkHub工具上架SOP.md（docs/sop，由線上正本匯出）
 * - workhub.yaml（範本）
 * - workhub-check.mjs（離線預檢，與平台收件同一套檢查；由 npm run build:kit 產生）
 * - 給AI的打包指令.txt（貼給 AI agent 的指令範本）
 */
import { existsSync, readFileSync } from 'node:fs';
import { deflateRawSync, crc32 } from 'node:zlib';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SOURCES: [string, string][] = [
  ['WorkHub工具上架SOP.md', join(ROOT, '..', 'docs', 'sop', 'WorkHub工具上架SOP.md')],
  ['workhub-check.mjs', join(ROOT, 'dist-kit', 'workhub-check.mjs')],
];
const PROMPT = join(ROOT, 'kit', '給AI的打包指令.txt');

/** 版更資料包要帶入的工具資訊；沒有就是第一次上架用的通用資料包 */
export type KitTarget = { toolId: string; name: string; released: string | null; latest: string; approvedEndpoint: string | null } | null;

/** 建議的下一個版本號：預覽版尾碼數字 +1（2.12.0-pilot.5 → 2.12.0-pilot.6），否則第三碼 +1 */
export function nextVersion(v: string): string {
  const pre = v.match(/^(.*[.-])(\d+)$/);
  if (v.includes('-') && pre) return `${pre[1]}${Number(pre[2]) + 1}`;
  const m = v.match(/^(\d+)\.(\d+)\.(\d+)/);
  return m ? `${m[1]}.${m[2]}.${Number(m[3]) + 1}` : v;
}

export function promptText(target: KitTarget, approved: string[]): string {
  const base = existsSync(PROMPT) ? readFileSync(PROMPT, 'utf8') : '{{TARGET}}\n\n{{ENDPOINTS}}\n';
  const t = target
    ? [`這次是：版本更新（請勿更改 tool.id）`,
       `- 工具：${target.name}`,
       `- tool.id：${target.toolId}`,
       `- 目前上線版本：${target.released ?? '（尚未上線）'}`,
       `- 最新提交版本：${target.latest}`,
       `- 新版本號必須大於最新提交版本，建議：${nextVersion(target.latest)}`,
       `- 上傳時請在 WorkHub 開發者中心該工具那一列按「提交新版本」`].join('\n')
    : ['這次是：第一次上架（新工具）',
       '- tool.id 請和我確認：3～41 個小寫英數字或連字號、英文字母開頭，上架後不能更改',
       '- 工具名稱不用寫進 workhub.yaml，我上傳時會在 WorkHub 表單填寫',
       '- 版本號從 1.0.0 開始',
       '- 若其實是更新既有工具，請改用該工具在 WorkHub 開發者中心的「下載更新資料包」，裡面會帶入 tool.id 與版本號'].join('\n');
  const e = [`模型端點：工具如果需要呼叫 AI 模型，model.approvedEndpoint 只能填平台核准的代號：${approved.join('、') || '（目前沒有）'}。`,
    target?.approvedEndpoint ? `此工具目前使用：${target.approvedEndpoint}（沿用即可）。` : '工具不使用 AI 時，model.uses 設為 false。',
    '實際網址、金鑰與模型名稱由平台注入 OPENAI_BASE_URL／OPENAI_API_KEY／OPENAI_MODEL，不要寫在程式或 ZIP 裡。'].join('\n');
  return base.replace('{{TARGET}}', t).replace('{{ENDPOINTS}}', e);
}

/** 最小 ZIP 產生器：deflate、UTF-8 檔名（中文檔名在 Mac／Windows 都正確） */
export function makeZip(files: { name: string; data: Buffer }[]): Buffer {
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  const dosTime = 0, dosDate = ((2026 - 1980) << 9) | (1 << 5) | 1;
  for (const f of files) {
    const name = Buffer.from(f.name, 'utf8');
    const comp = deflateRawSync(f.data);
    const crc = crc32(f.data);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x0800, 6); lh.writeUInt16LE(8, 8);
    lh.writeUInt16LE(dosTime, 10); lh.writeUInt16LE(dosDate, 12); lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(f.data.length, 22); lh.writeUInt16LE(name.length, 26); lh.writeUInt16LE(0, 28);
    locals.push(lh, name, comp);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(0x0800, 8); ch.writeUInt16LE(8, 10);
    ch.writeUInt16LE(dosTime, 12); ch.writeUInt16LE(dosDate, 14); ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(comp.length, 20);
    ch.writeUInt32LE(f.data.length, 24); ch.writeUInt16LE(name.length, 28); ch.writeUInt32LE((0o644 << 16) >>> 0, 38); ch.writeUInt32LE(offset, 42);
    central.push(ch, name);
    offset += 30 + name.length + comp.length;
  }
  const cd = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(files.length, 8); eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(cd.length, 12); eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}

export function buildKit(template: string, approved: string[], target: KitTarget = null): { zip: Buffer; missing: string[] } {
  const missing = SOURCES.filter(([, p]) => !existsSync(p)).map(([n]) => n);
  const files = SOURCES.filter(([, p]) => existsSync(p)).map(([n, p]) => ({ name: `workhub-kit/${n}`, data: readFileSync(p) }));
  files.push({ name: 'workhub-kit/給AI的打包指令.txt', data: Buffer.from(promptText(target, approved), 'utf8') });
  const yaml = target ? template.replace(/id: my-tool\b/, `id: ${target.toolId}`).replace(/  # name: 我的工具[^\n]*/, `  # 工具名稱：${target.name}（以 WorkHub 平台為準，要改名請在發布管理修改）`).replace(/version: 1\.0\.0/, `version: ${nextVersion(target.latest)}`) : template;
  files.push({ name: 'workhub-kit/workhub.yaml', data: Buffer.from(yaml, 'utf8') });
  return { zip: makeZip(files), missing };
}
