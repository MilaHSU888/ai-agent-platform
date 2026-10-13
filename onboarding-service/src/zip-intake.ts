/**
 * ZIP 安全收件：先讀中央目錄做結構與限量檢查，不先解壓；通過後才逐檔限量解壓並驗 CRC。
 * 只支援 stored／deflate、非加密、非 ZIP64。所有問題都以「檔案／原因／補正方法」回報。
 */
import { inflateRawSync, crc32 } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import type { Config } from './config.ts';

export type Issue = { file: string; field?: string; reason: string; fix: string };

export type ZipEntry = {
  name: string;
  method: number;
  flags: number;
  crc: number;
  compressedSize: number;
  size: number;
  localOffset: number;
  isDir: boolean;
  isSymlink: boolean;
};

const ARCHIVE_EXT = /\.(zip|tar|tgz|gz|bz2|xz|7z|rar|zst|tbz2?)$/i;
const SECRET_FILES: { re: RegExp; label: string }[] = [
  { re: /(^|\/)\.env(\.(?!example$|sample$|template$)[^/]+)?$/i, label: '環境設定檔（.env）' },
  { re: /\.(pem|key|p12|pfx|keystore|jks)$/i, label: '私鑰或憑證檔' },
  { re: /(^|\/)id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/i, label: 'SSH 金鑰' },
  { re: /(^|\/)\.(npmrc|pypirc|netrc|git-credentials)$/i, label: '套件庫或 Git 認證檔' },
  { re: /(^|\/)(credentials|secrets?)\.(json|ya?ml|txt|env)$/i, label: '憑證檔' },
  { re: /(^|\/)\.aws\/credentials$/i, label: 'AWS 認證檔' },
];
const SECRET_CONTENT: { re: RegExp; label: string }[] = [
  { re: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |ENCRYPTED )?PRIVATE KEY-----/, label: '私鑰內容' },
  { re: /\bAKIA[0-9A-Z]{16}\b/, label: 'AWS Access Key' },
  { re: /\bsk-[A-Za-z0-9_-]{20,}/, label: 'API 金鑰（sk-）' },
  { re: /\b(?:ghp_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{40,})/, label: 'GitHub Token' },
  { re: /\bxox[abprs]-[A-Za-z0-9-]{10,}/, label: 'Slack Token' },
  { re: /(?:api[_-]?key|secret|token|passw(?:or)?d|access[_-]?key)["']?\s*[:=]\s*["'][A-Za-z0-9_\-/+=]{20,}["']/i, label: '寫死的金鑰或密碼' },
];
const IGNORED = (name: string) => name.startsWith('__MACOSX/') || /(^|\/)\.DS_Store$/.test(name);

export function readCentralDirectory(buf: Buffer, cfg: Config): { entries: ZipEntry[]; issues: Issue[] } {
  const issues: Issue[] = [];
  const fail = (reason: string, fix: string) => ({ entries: [], issues: [{ file: '(ZIP)', reason, fix }] });
  if (buf.length < 22) return fail('檔案太小，不是有效的 ZIP', '請重新壓縮原始碼資料夾後上傳');
  if (buf.length > cfg.limits.uploadBytes) {
    return fail(`ZIP 超過 ${cfg.limits.uploadBytes / 1024 / 1024} MB 上限`, '移除資料檔、虛擬環境或套件快取後重新壓縮');
  }
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65535); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) return fail('找不到 ZIP 目錄結尾，檔案可能損毀或不是 ZIP', '請重新壓縮後上傳');
  const total = buf.readUInt16LE(eocd + 10);
  const cdSize = buf.readUInt32LE(eocd + 12);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  if (total === 0xffff || cdOffset === 0xffffffff || cdSize === 0xffffffff) {
    return fail('不支援 ZIP64 格式', '請用一般 ZIP 壓縮，並把檔案控制在大小上限內');
  }
  if (buf.readUInt16LE(eocd + 4) !== 0 || buf.readUInt16LE(eocd + 6) !== 0) {
    return fail('不支援分割 ZIP', '請壓縮成單一 ZIP 檔');
  }
  if (cdOffset + cdSize > eocd) return fail('ZIP 目錄位置異常，檔案可能損毀', '請重新壓縮後上傳');
  if (total > cfg.limits.entries) {
    return fail(`檔案數 ${total} 超過上限 ${cfg.limits.entries}`, '移除 node_modules、虛擬環境、快取或測試產物後重新壓縮');
  }

  const entries: ZipEntry[] = [];
  let p = cdOffset;
  for (let i = 0; i < total; i++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) {
      return fail('ZIP 目錄項目損毀', '請重新壓縮後上傳');
    }
    const madeBy = buf.readUInt16LE(p + 4);
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    const compressedSize = buf.readUInt32LE(p + 20);
    const size = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const ext = buf.readUInt32LE(p + 38);
    const localOffset = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString('utf8');
    const isSymlink = (madeBy >> 8) === 3 && ((ext >>> 16) & 0o170000) === 0o120000;
    entries.push({ name, method, flags, crc, compressedSize, size, localOffset, isDir: name.endsWith('/'), isSymlink });
    p += 46 + nameLen + extraLen + commentLen;
  }

  let totalSize = 0;
  const seen = new Set<string>();
  for (const e of entries) {
    if (IGNORED(e.name)) continue;
    const segs = e.name.replace(/\/$/, '').split('/');
    if (e.name.includes('\\') || e.name.includes('\0') || e.name.startsWith('/') || /^[A-Za-z]:/.test(e.name) || segs.some((s) => s === '..' || s === '.' || s === '')) {
      issues.push({ file: e.name, reason: '檔案路徑不安全（絕對路徑、.. 或反斜線）', fix: '只用相對路徑重新壓縮，不要包含上層目錄' });
      continue;
    }
    if (segs.some((s) => Buffer.byteLength(s) > 255)) {
      issues.push({ file: e.name, reason: '檔名過長', fix: '縮短檔名後重新壓縮' });
    }
    const key = e.name.toLowerCase();
    if (seen.has(key)) issues.push({ file: e.name, reason: '重複的檔案路徑（不分大小寫）', fix: '移除重複檔案後重新壓縮' });
    seen.add(key);
    if (e.isSymlink) issues.push({ file: e.name, reason: '包含符號連結', fix: '把連結換成實際檔案，或移除該連結' });
    if (e.flags & 0x1) issues.push({ file: e.name, reason: '檔案有加密', fix: '請用不加密的 ZIP 上傳' });
    if (!e.isDir && ![0, 8].includes(e.method)) {
      issues.push({ file: e.name, reason: `不支援的壓縮方式（${e.method}）`, fix: '請用一般 ZIP（deflate）重新壓縮' });
    }
    if (segs[0] === '.git' || segs.includes('.git')) {
      issues.push({ file: e.name, reason: '包含 .git 版本庫資料（可能夾帶歷史中的機密）', fix: '壓縮前排除 .git 資料夾' });
    }
    if (!e.isDir && ARCHIVE_EXT.test(e.name)) {
      issues.push({ file: e.name, reason: '包含巢狀壓縮檔', fix: '解開後以一般檔案放入，或從提交包移除' });
    }
    const secret = SECRET_FILES.find((s) => s.re.test(e.name));
    if (!e.isDir && secret) {
      issues.push({ file: e.name, reason: `疑似${secret.label}，不可放入提交包`, fix: '移除此檔；連線參數與憑證改由平台安全設定注入' });
    }
    if (e.size > cfg.limits.singleFileBytes) {
      issues.push({ file: e.name, reason: `單檔解壓後超過 ${cfg.limits.singleFileBytes / 1024 / 1024} MB`, fix: '移除大型資料檔' });
    }
    if (e.size > 1024 * 1024 && e.compressedSize > 0 && e.size / e.compressedSize > cfg.limits.compressionRatio) {
      issues.push({ file: e.name, reason: '壓縮比異常（疑似壓縮炸彈）', fix: '移除此檔後重新壓縮' });
    }
    totalSize += e.size;
  }
  if (totalSize > cfg.limits.totalUncompressedBytes) {
    issues.push({ file: '(ZIP)', reason: `解壓後總量超過 ${cfg.limits.totalUncompressedBytes / 1024 / 1024} MB`, fix: '移除資料檔、虛擬環境或套件快取' });
  }
  return { entries, issues };
}

/** 偵測 Finder 等工具多包一層資料夾的情形：全部檔案都在同一個頂層資料夾下時，回傳該前綴。 */
export function detectPrefix(entries: ZipEntry[]): string {
  const names = entries.map((e) => e.name).filter((n) => !IGNORED(n));
  if (names.includes('workhub.yaml')) return '';
  const tops = new Set(names.map((n) => n.split('/')[0]));
  if (tops.size === 1) {
    const top = [...tops][0];
    if (names.includes(`${top}/workhub.yaml`)) return `${top}/`;
  }
  return '';
}

export function readEntry(buf: Buffer, e: ZipEntry): Buffer {
  const p = e.localOffset;
  if (buf.readUInt32LE(p) !== 0x04034b50) throw new Error(`本地檔頭損毀：${e.name}`);
  const start = p + 30 + buf.readUInt16LE(p + 26) + buf.readUInt16LE(p + 28);
  const raw = buf.subarray(start, start + e.compressedSize);
  const data = e.method === 0 ? Buffer.from(raw) : inflateRawSync(raw, { maxOutputLength: Math.max(e.size, 1) });
  if (data.length !== e.size) throw new Error(`解壓大小與宣告不符：${e.name}`);
  if ((crc32(data) >>> 0) !== (e.crc >>> 0)) throw new Error(`CRC 檢查失敗：${e.name}`);
  return data;
}

function looksText(data: Buffer) {
  return !data.subarray(0, 8000).includes(0);
}

export function scanSecrets(buf: Buffer, entries: ZipEntry[], prefix: string): Issue[] {
  const issues: Issue[] = [];
  for (const e of entries) {
    if (e.isDir || IGNORED(e.name) || e.size > 2 * 1024 * 1024 || /\.(xlsx|docx|pdf|png|jpe?g|gif|msg|eml|doc|xls)$/i.test(e.name)) continue;
    let data: Buffer;
    try { data = readEntry(buf, e); } catch { continue; }
    if (!looksText(data)) continue;
    const text = data.toString('utf8');
    for (const s of SECRET_CONTENT) {
      const m = s.re.exec(text);
      if (m) {
        const line = text.slice(0, m.index).split('\n').length;
        issues.push({ file: `${e.name.slice(prefix.length)}:${line}`, reason: `疑似${s.label}（內容不顯示）`, fix: '移除寫死的憑證，改由平台安全設定以環境變數注入' });
      }
    }
  }
  return issues;
}

/** 解壓到 dest；路徑再確認一次不會跳出 dest。回傳寫出的檔案數。 */
export function extract(buf: Buffer, entries: ZipEntry[], prefix: string, dest: string): number {
  const root = resolve(dest);
  let count = 0;
  for (const e of entries) {
    if (IGNORED(e.name) || !e.name.startsWith(prefix)) continue;
    const rel = e.name.slice(prefix.length);
    if (!rel) continue;
    const target = resolve(join(root, rel));
    if (target !== root && !target.startsWith(root + sep)) throw new Error(`路徑跳出解壓目錄：${e.name}`);
    if (e.isDir) { mkdirSync(target, { recursive: true }); continue; }
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, readEntry(buf, e), { mode: 0o644 });
    count++;
  }
  return count;
}
