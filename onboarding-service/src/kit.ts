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
  ['給AI的打包指令.txt', join(ROOT, 'kit', '給AI的打包指令.txt')],
];

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

export function buildKit(template: string): { zip: Buffer; missing: string[] } {
  const missing = SOURCES.filter(([, p]) => !existsSync(p)).map(([n]) => n);
  const files = SOURCES.filter(([, p]) => existsSync(p)).map(([n, p]) => ({ name: `workhub-kit/${n}`, data: readFileSync(p) }));
  files.push({ name: 'workhub-kit/workhub.yaml', data: Buffer.from(template, 'utf8') });
  return { zip: makeZip(files), missing };
}
