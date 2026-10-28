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

export function promptText(approved: string[]): string {
  const base = existsSync(PROMPT) ? readFileSync(PROMPT, 'utf8') : '{{TARGET}}\n\n{{ENDPOINTS}}\n';
  // 只有一種資料包（DEC-039）：版本號由平台自動編號；版更沿用原本的 workhub.yaml
  const t = ['第一次上架（新工具）：',
    '- tool.id 請和我確認：3～41 個小寫英數字或連字號、英文字母開頭，上架後不能更改',
    '- 工具名稱不用寫進 workhub.yaml，我上傳時會在 WorkHub 表單填寫',
    '- 版本號不用填，WorkHub 會自動編號（v1、v2…）',
    '',
    '版本更新（既有工具）：',
    '- 沿用專案裡原本的 workhub.yaml，不要更改 tool.id，也不用改版本號',
    '- 上傳時請在 WorkHub 開發者中心該工具那一列按「提交新版本」'].join('\n');
  void approved;
  const e = ['模型：工具需要呼叫 AI 模型時，把 model.uses 設為 true；用哪個模型由 WorkHub 的 AI Team 指定（沒指定就用平台預設模型），不用填 approvedEndpoint。',
    '工具不使用 AI 時，model.uses 設為 false。程式裡呼叫模型時，model 參數直接用環境變數 OPENAI_MODEL。',
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

export function buildKit(template: string, approved: string[]): { zip: Buffer; missing: string[] } {
  const missing = SOURCES.filter(([, p]) => !existsSync(p)).map(([n]) => n);
  const files = SOURCES.filter(([, p]) => existsSync(p)).map(([n, p]) => ({ name: `workhub-kit/${n}`, data: readFileSync(p) }));
  files.push({ name: 'workhub-kit/給AI的打包指令.txt', data: Buffer.from(promptText(approved), 'utf8') });
  files.push({ name: 'workhub-kit/workhub.yaml', data: Buffer.from(template, 'utf8') });
  return { zip: makeZip(files), missing };
}
