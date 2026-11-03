/**
 * 原始碼自動打包：讀取上傳的原始碼樹。
 * - 不需要放進工具的東西（虛擬環境、套件快取、Windows 安裝檔與離線套件）先排除，報告裡會列出。
 * - 找出專案根目錄：有專案標記檔（requirements.txt、package.json、pom.xml…）的最淺資料夾；外層的安裝包檔案不放進工具。
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

export type SrcFile = { path: string; size: number; text: string | null };

/** 打包時一律略過的資料夾（相依套件、快取、建置產物、版控） */
export const SKIP_DIR = /^(\.git|\.svn|\.hg|node_modules|\.venv|venv|env|\.env\.d|__pycache__|\.pytest_cache|\.mypy_cache|\.ruff_cache|\.tox|\.idea|\.vscode|\.next|\.nuxt|coverage|htmlcov|dist|build|target|bin|obj|out|wheels|site-packages|__MACOSX|\.gradle|\.dart_tool)$/;
/** Windows 部署用的檔案：平台用不到，不放進工具（報告列出） */
export const WINDOWS_DEPLOY = /\.(ps1|bat|cmd|exe|dll|msi|msix|lnk|vbs|reg)$/i;
const SKIP_FILE = /(^|\/)(\.DS_Store|Thumbs\.db|desktop\.ini)$/;
const MAX_TEXT = 512 * 1024;

const looksText = (b: Buffer) => !b.subarray(0, 8000).includes(0);

/** 讀取資料夾下所有檔案（略過的資料夾不進去，但記下名稱） */
export function loadTree(dir: string): { files: SrcFile[]; skippedDirs: string[]; hints: string[] } {
  const files: SrcFile[] = [];
  const skippedDirs: string[] = [];
  const hints: string[] = []; // 略過的資料夾裡的檔名（例如離線套件 xxx-cp314-win_amd64.whl，用來判斷 Python 版本）
  const walk = (d: string) => {
    for (const ent of readdirSync(d, { withFileTypes: true })) {
      const abs = join(d, ent.name);
      const rel = relative(dir, abs).split(sep).join('/');
      if (ent.isSymbolicLink()) continue;
      if (ent.isDirectory()) {
        if (SKIP_DIR.test(ent.name)) { skippedDirs.push(rel); if (/^wheels$/i.test(ent.name)) hints.push(...readdirSync(abs).slice(0, 300)); continue; }
        walk(abs);
        continue;
      }
      if (!ent.isFile() || SKIP_FILE.test(rel)) continue;
      const size = statSync(abs).size;
      let text: string | null = null;
      if (size <= MAX_TEXT) {
        const b = readFileSync(abs);
        if (looksText(b)) text = b.toString('utf8');
      }
      files.push({ path: rel, size, text });
    }
  };
  walk(dir);
  return { files: files.sort((a, b) => a.path.localeCompare(b.path)), skippedDirs: skippedDirs.sort(), hints };
}

/** 專案標記檔：強標記（本身就代表專案）與弱標記（同資料夾還要有程式檔才算，避免把外層安裝包的 requirements_win.txt 當成專案） */
const STRONG = [/^pyproject\.toml$/, /^setup\.py$/, /^Pipfile$/, /^package\.json$/, /^pom\.xml$/, /^build\.gradle(\.kts)?$/, /\.csproj$/i, /^go\.mod$/, /^composer\.json$/, /^manage\.py$/];
const WEAK = [/^requirements[\w.-]*\.txt$/i, /^app\.py$/, /^main\.py$/, /^index\.html?$/i, /^index\.php$/i];
const CODE = /\.(py|js|mjs|cjs|ts|java|kt|cs|go|php|html?)$/i;
const NOT_ROOT = /^(tests?|docs?|examples?|samples?|fixtures?|scripts?|templates?)$/i;

/** 專案根目錄：有標記檔的最淺資料夾（同深度時以標記較多者為準）。回傳相對路徑（'' 表示最上層）。 */
export function findRoot(files: SrcFile[]): string {
  const byDir = new Map<string, string[]>();
  for (const f of files) {
    const parts = f.path.split('/');
    const name = parts.pop()!;
    const dir = parts.join('/');
    byDir.set(dir, [...(byDir.get(dir) ?? []), name]);
  }
  const score = new Map<string, number>();
  for (const [dir, names] of byDir) {
    if (dir.split('/').some((p) => NOT_ROOT.test(p))) continue;
    const strong = names.filter((n) => STRONG.some((m) => m.test(n))).length;
    const weak = names.filter((n) => WEAK.some((m) => m.test(n))).length;
    const hasCode = names.some((n) => CODE.test(n));
    const s = strong * 2 + (hasCode ? weak : 0);
    if (s > 0) score.set(dir, s);
  }
  if (!score.size) return '';
  return [...score.entries()].sort((a, b) => a[0].split('/').filter(Boolean).length - b[0].split('/').filter(Boolean).length || b[1] - a[1])[0][0];
}

/** 把整份清單切成「專案根目錄裡的檔案（路徑改成相對根目錄）」與「根目錄外的檔案」 */
export function splitRoot(files: SrcFile[], root: string): { inside: SrcFile[]; outside: SrcFile[] } {
  if (!root) return { inside: files, outside: [] };
  const pre = `${root}/`;
  return {
    inside: files.filter((f) => f.path.startsWith(pre)).map((f) => ({ ...f, path: f.path.slice(pre.length) })),
    outside: files.filter((f) => !f.path.startsWith(pre)),
  };
}

/** 依行號找出 regex 命中位置（給報告顯示「檔案:行」） */
export function lineOf(text: string, index: number): number {
  return text.slice(0, index).split('\n').length;
}
