/**
 * 原始碼自動打包：分析原始碼（不用 AI）。
 * - 語言、框架、進入點、服務埠、健康檢查網址（預設值取自上架 SOP 12.3 常見框架對照）
 * - 不支援的類型（Windows 專用、Excel 巨集、Access、桌面視窗程式、接實體設備）→ 一開始就說明原因並轉 AI Team
 * - 寫死的金鑰、對外連線、Windows 專用套件（找到就暫停問人，SOP 12.5）
 * - 資料保存：哪些要保存、哪些是暫存、哪些寫在程式資料夾（容器重開會不見）
 * - 是否使用 AI、測試資料檔、現有測試、需要的系統套件
 */
import { lineOf, SKIP_DIR, splitRoot, WINDOWS_DEPLOY, findRoot, type SrcFile } from './files.ts';
import { SECRET_CONTENT, SECRET_FILES } from '../zip-intake.ts';

export type Lang = 'python' | 'node' | 'java' | 'dotnet' | 'go' | 'php' | 'static';
export type Ref = { file: string; line?: number; detail: string };
export type DataItem = { path: string; kind: '資料庫' | '資料夾' | '檔案'; ref: Ref };
export type OutsideWrite = { id: string; path: string; ref: Ref };
/** 寫在程式資料夾、可以直接「連到資料目錄」的路徑（相對專案資料夾），不用改程式 */
export const linkablePath = (p: string) => !!p && !p.includes('..') && !p.startsWith('/') && /^[\w.\-/]+$/.test(p);

export type Analysis = {
  root: string;
  /** 專案資料夾裡沒有套件清單、上一層才有時，借來放到專案最上層（例如 Docker版/requirements.txt + Docker版/app/） */
  borrowed: { from: string; to: string }[];
  /** 完全沒有套件清單時，依 import 推斷的套件（平台產生 requirements.txt，報告請開發者確認） */
  inferredDeps: string[];
  language: Lang | null;
  framework: string | null;
  frameworkLabel: string;
  entry: string | null;
  port: number;
  healthPath: string;
  healthBuiltin: boolean;
  runtimeVersion: string | null;
  unsupported: { reason: string; detail: string } | null;
  secrets: Ref[];
  external: { host: string; refs: Ref[] }[];
  windowsDeps: { name: string; refs: Ref[] }[];
  ai: { uses: boolean; refs: Ref[]; rewriteFiles: string[];
    /** 程式本來就是 OpenAI 相容介面、只是設定名稱不同：平台在啟動時把這些環境變數填成平台模型，不改程式（2026/11/03） */
    envMap: { base: string; key: string | null; model: string | null; stripV1: boolean } | null };
  data: { readsDataDirEnv: boolean; defaultDir: string | null; keep: DataItem[]; temp: DataItem[]; outside: OutsideWrite[]; seeds: string[]; liveData: string[] };
  testData: string[];
  tests: { command: string[] | null; files: string[]; label: string };
  systemPackages: { pkg: string; why: string }[];
  excluded: { path: string; why: string }[];
  manifest: { name: string | null; deps: string[] };
};

const CODE_EXT = /\.(py|js|mjs|cjs|ts|tsx|jsx|java|kt|cs|go|php)$/i;
const TEST_DIR = /(^|\/)(tests?|__tests__|spec|testdata|test_data|fixtures?)(\/|$)/i;
const DATA_EXT = /\.(xlsx|xls|xlsm|csv|tsv|pdf|doc|docx|ppt|pptx|eml|msg|png|jpe?g|gif|bmp|tiff?|zip|txt|json|xml|dat|db|sqlite3?|parquet|html?)$/i;
const LIVE_DATA = /\.(db|sqlite3?|accdb|mdb)$/i;
const isComment = (line: string) => /^\s*(#|\/\/|\*|\/\*|<!--|')/.test(line);

/** 每一行都跑 regex（略過註解行），回傳命中位置 */
function grep(files: SrcFile[], re: RegExp, opts: { code?: boolean; skipTests?: boolean; comments?: boolean } = {}): { f: SrcFile; line: number; m: RegExpExecArray }[] {
  const out: { f: SrcFile; line: number; m: RegExpExecArray }[] = [];
  for (const f of files) {
    if (f.text === null) continue;
    if (opts.code && !CODE_EXT.test(f.path)) continue;
    if (opts.skipTests && TEST_DIR.test(f.path)) continue;
    const lines = f.text.split('\n');
    lines.forEach((l, i) => {
      if (!opts.comments && isComment(l)) return;
      const r = new RegExp(re.source, re.flags.replace('g', ''));
      const m = r.exec(l);
      if (m) out.push({ f, line: i + 1, m });
    });
  }
  return out;
}

/** 專案裡已經有、可以拿來當健康檢查的網址（不用改程式）：優先 /health 類，其次首頁 / */
export function existingRoute(files: SrcFile[], lang: 'py' | 'js'): string | null {
  const re = lang === 'py' ? /@\w+\.(?:get|route|api_route)\(\s*["'](\/[\w/-]*)["']/g : /\b\w+\.(?:get|all)\(\s*["'`](\/[\w/-]*)["'`]/g;
  const paths = new Set<string>();
  for (const f of files.filter((x) => x.text && (lang === 'py' ? x.path.endsWith('.py') : /\.[cm]?[jt]s$/.test(x.path)) && !/(^|\/)(tests?|__tests__)\//.test(x.path)))
    for (const m of f.text!.matchAll(re)) paths.add(m[1]);
  return ['/health', '/healthz', '/api/health', '/api/healthz', '/ping', '/status', '/'].find((p) => paths.has(p)) ?? null;
}

/** OpenAI 相容呼叫的網址、金鑰、模型若從環境變數讀，回傳變數名稱；Ollama 等非 OpenAI 介面回傳 null */
export function openaiEnvMap(files: SrcFile[], aiFiles: string[]): Analysis['ai']['envMap'] {
  const texts = files.filter((f) => aiFiles.includes(f.path) || /(^|\/)(settings|config|conf)\.py$/.test(f.path)).map((f) => f.text ?? '');
  const all = texts.join('\n');
  if (/ollama|\/api\/chat|\/api\/generate/i.test(all) || !/chat\/completions|chat\.completions\.create/.test(all)) return null;
  const names = [...all.matchAll(/(?:getenv|environ\.get|environ\[|process\.env\.|process\.env\[)\(?\s*["'`]?([A-Z][A-Z0-9_]{2,})/g)].map((m) => m[1]);
  const pick = (re: RegExp, not?: RegExp) => names.find((n) => re.test(n) && !(not && not.test(n))) ?? null;
  const base = pick(/(API_?BASE|BASE_?URL|ENDPOINT|API_?URL|LLM_?URL|HOST)/, /OPENAI_BASE_URL/);
  if (!base) return null;
  return { base, key: pick(/(API_?KEY|TOKEN|SECRET)/, /OPENAI_API_KEY/), model: pick(/MODEL/, /(OPENAI_MODEL|PATH|DIR)/), stripV1: /["'`]\/v1\/chat\/completions/.test(all) };
}

const DEP_FILE = /^(requirements[\w.-]*\.txt|pyproject\.toml|setup\.py|setup\.cfg|Pipfile|package\.json|package-lock\.json|composer\.json|go\.mod|pom\.xml)$/i;

/** import 名稱和套件名稱不同的常見對照 */
const PIP_NAME: Record<string, string> = { PIL: 'pillow', cv2: 'opencv-python-headless', yaml: 'pyyaml', fitz: 'pymupdf', sklearn: 'scikit-learn', bs4: 'beautifulsoup4', docx: 'python-docx', pptx: 'python-pptx', dotenv: 'python-dotenv', jwt: 'pyjwt', dateutil: 'python-dateutil', multipart: 'python-multipart', Crypto: 'pycryptodome', magic: 'python-magic', serial: 'pyserial', win32com: 'pywin32', pytesseract: 'pytesseract', pdf2image: 'pdf2image' };
const STDLIB = new Set('__future__ abc argparse array ast asyncio base64 binascii bisect builtins bz2 calendar cgi cmath codecs collections colorsys concurrent configparser contextlib contextvars copy csv ctypes dataclasses datetime decimal difflib dis email enum errno faulthandler fcntl filecmp fnmatch fractions ftplib functools gc getpass gettext glob gzip hashlib heapq hmac html http imaplib importlib inspect io ipaddress itertools json keyword linecache locale logging lzma mailbox math mimetypes mmap multiprocessing netrc numbers operator os pathlib pickle pkgutil platform plistlib poplib posixpath pprint profile pstats queue quopri random re readline reprlib resource sched secrets select selectors shelve shlex shutil signal site smtplib socket socketserver sqlite3 ssl stat statistics string stringprep struct subprocess sys sysconfig tarfile tempfile textwrap threading time timeit tkinter token tokenize tomllib trace traceback tracemalloc types typing unicodedata unittest urllib uuid venv warnings wave weakref webbrowser winreg wsgiref xml xmlrpc zipfile zipimport zlib zoneinfo'.split(' '));

/** 沒有 requirements.txt 時，依 import 推斷要裝的套件（排除標準函式庫與專案自己的模組） */
export function inferPythonDeps(files: SrcFile[]): string[] {
  const local = new Set(files.filter((f) => f.path.endsWith('.py') || f.path.endsWith('/__init__.py')).flatMap((f) => [f.path.split('/')[0].replace(/\.py$/, ''), f.path.split('/').pop()!.replace(/\.py$/, '')]));
  const out = new Set<string>();
  for (const f of files.filter((x) => x.path.endsWith('.py') && x.text && !/(^|\/)tests?\//.test(x.path))) {
    for (const m of f.text!.matchAll(/^\s*(?:from\s+([A-Za-z_]\w*)[\w.]*\s+import|import\s+([A-Za-z_]\w*))/gm)) {
      const mod = m[1] ?? m[2];
      if (!mod || STDLIB.has(mod) || local.has(mod) || mod.startsWith('_')) continue;
      out.add(PIP_NAME[mod] ?? mod.replace(/_/g, '-'));
    }
  }
  return [...out].sort();
}

const text = (files: SrcFile[], name: string) => files.find((f) => f.path === name)?.text ?? null;

function pythonDeps(files: SrcFile[]): string[] {
  const deps = new Set<string>();
  for (const f of files.filter((x) => /^requirements[\w.-]*\.txt$/i.test(x.path) && x.text)) {
    for (const l of f.text!.split('\n')) {
      const m = /^\s*([A-Za-z0-9_.-]+)/.exec(l.replace(/#.*/, ''));
      if (m && !l.trim().startsWith('-')) deps.add(m[1].toLowerCase().replace(/_/g, '-'));
    }
  }
  const py = text(files, 'pyproject.toml');
  if (py) for (const m of py.matchAll(/^\s*"([A-Za-z0-9_.-]+)[^"]*",?\s*$/gm)) deps.add(m[1].toLowerCase().replace(/_/g, '-'));
  return [...deps];
}

function nodePkg(files: SrcFile[]): { name: string | null; deps: string[]; scripts: Record<string, string>; main: string | null; engines: string | null } {
  const t = text(files, 'package.json');
  if (!t) return { name: null, deps: [], scripts: {}, main: null, engines: null };
  try {
    const j = JSON.parse(t) as { name?: string; dependencies?: Record<string, string>; devDependencies?: Record<string, string>; scripts?: Record<string, string>; main?: string; engines?: { node?: string } };
    return { name: j.name ?? null, deps: [...Object.keys(j.dependencies ?? {}), ...Object.keys(j.devDependencies ?? {})], scripts: j.scripts ?? {}, main: j.main ?? null, engines: j.engines?.node ?? null };
  } catch { return { name: null, deps: [], scripts: {}, main: null, engines: null }; }
}

/** Python 版本：專案宣告 > 上傳包裡的離線套件（cp314 之類）> 3.12 */
function pythonVersion(all: SrcFile[], files: SrcFile[], hints: string[]): string {
  const pv = text(files, '.python-version')?.trim();
  if (pv && /^3\.\d+/.test(pv)) return pv.split('.').slice(0, 2).join('.');
  const req = /requires-python\s*=\s*["'][>=~^]*\s*(3\.\d+)/.exec(text(files, 'pyproject.toml') ?? '');
  if (req) return req[1];
  const counts = new Map<string, number>();
  for (const name of [...all.map((f) => f.path), ...hints]) { const m = /-cp3(\d{2})-/.exec(name); if (m) counts.set(`3.${m[1]}`, (counts.get(`3.${m[1]}`) ?? 0) + 1); }
  for (const f of all.filter((x) => x.text && /readme|安裝|install/i.test(x.path))) {
    const m = /Python\s*(3\.1\d)/i.exec(f.text!); if (m) counts.set(m[1], (counts.get(m[1]) ?? 0) + 1);
  }
  const best = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  return best && Number(best.split('.')[1]) >= 10 ? best : '3.12';
}

export function analyze(allFiles: SrcFile[], skippedDirs: string[] = [], hints: string[] = []): Analysis {
  const root = findRoot(allFiles);
  const { inside: files, outside } = splitRoot(allFiles, root);
  // 2026/11/03 實測（材質審核平台）：程式在 app/，requirements.txt 在上一層 → 借上來，不然建置找不到套件
  const borrowed: { from: string; to: string }[] = [];
  if (root && !files.some((f) => !f.path.includes('/') && DEP_FILE.test(f.path))) {
    const parts = root.split('/');
    for (let k = parts.length - 1; k >= 0 && !borrowed.length; k--) {
      const anc = parts.slice(0, k).join('/');
      for (const c of outside.filter((f) => (f.path.includes('/') ? f.path.slice(0, f.path.lastIndexOf('/')) : '') === anc && DEP_FILE.test(f.path.split('/').pop()!))) {
        const name = c.path.split('/').pop()!;
        borrowed.push({ from: c.path, to: name });
        files.push({ ...c, path: name });
      }
    }
  }
  const borrowedFrom = new Set(borrowed.map((b) => b.from));
  const excluded: { path: string; why: string }[] = [];
  for (const f of outside.filter((x) => !borrowedFrom.has(x.path))) excluded.push({ path: f.path, why: WINDOWS_DEPLOY.test(f.path) || /wheels\//.test(f.path) ? 'Windows 安裝用的檔案，平台用不到' : '在專案資料夾外（安裝包或說明文件），不放進工具' });
  for (const d of skippedDirs) excluded.push({ path: `${d}/`, why: /wheels|site-packages|node_modules|venv/.test(d) ? '套件或虛擬環境，平台建置時會重新安裝' : '快取、建置產物或版控資料' });
  for (const f of files) if (WINDOWS_DEPLOY.test(f.path)) excluded.push({ path: root ? `${root}/${f.path}` : f.path, why: 'Windows 安裝或啟動用的檔案，平台用不到' });
  const keepFiles = files.filter((f) => !WINDOWS_DEPLOY.test(f.path));

  const a: Analysis = {
    root, borrowed, inferredDeps: [], language: null, framework: null, frameworkLabel: '', entry: null, port: 8080, healthPath: '/health', healthBuiltin: false, runtimeVersion: null,
    unsupported: null, secrets: [], external: [], windowsDeps: [], ai: { uses: false, refs: [], rewriteFiles: [], envMap: null },
    data: { readsDataDirEnv: false, defaultDir: null, keep: [], temp: [], outside: [], seeds: [], liveData: [] },
    testData: [], tests: { command: null, files: [], label: '' }, systemPackages: [], excluded, manifest: { name: null, deps: [] },
  };
  const has = (re: RegExp) => keepFiles.some((f) => re.test(f.path));
  const rootHas = (re: RegExp) => keepFiles.some((f) => !f.path.includes('/') && re.test(f.path));

  // ── 語言判斷 ──
  const csproj = keepFiles.filter((f) => /\.csproj$/i.test(f.path));
  if (rootHas(/^(pyproject\.toml|setup\.py|Pipfile|manage\.py)$/) || rootHas(/^requirements[\w.-]*\.txt$/i) || (rootHas(/\.py$/) && !rootHas(/^package\.json$/))) a.language = 'python';
  else if (rootHas(/^package\.json$/)) a.language = 'node';
  else if (rootHas(/^(pom\.xml|build\.gradle(\.kts)?)$/)) a.language = 'java';
  else if (csproj.length) a.language = 'dotnet';
  else if (rootHas(/^go\.mod$/)) a.language = 'go';
  else if (rootHas(/^composer\.json$/) || has(/\.php$/)) a.language = 'php';
  else if (has(/(^|\/)index\.html?$/i)) a.language = 'static';

  // ── 不支援的類型 ──
  const vbaOnly = has(/\.(xlsm|xlam|bas|frm|cls|dotm|docm)$/i) && !a.language;
  const accessOnly = has(/\.(accdb|mdb)$/i) && !a.language;
  if (vbaOnly) a.unsupported = { reason: 'Excel／Office 巨集（VBA）', detail: '巨集要在 Office 裡執行，不是獨立的網頁程式，平台跑不起來。需要改寫成網頁版工具。' };
  else if (accessOnly) a.unsupported = { reason: 'Access 資料庫程式', detail: 'Access 要在 Windows 的 Office 裡執行，平台跑不起來。需要改寫成網頁版工具。' };
  for (const c of csproj) {
    const t = c.text ?? '';
    if (/<TargetFramework(Version)?>\s*(v4\.|net4\d)/i.test(t)) a.unsupported = { reason: '舊版 .NET Framework（Windows 專用）', detail: `${c.path} 使用 .NET Framework 4.x，只能在 Windows 執行。需要升級到新版 .NET（.NET 6 以上）。` };
    else if (/<Use(WindowsForms|WPF)>\s*true/i.test(t)) a.unsupported = { reason: 'Windows 桌面程式（WinForms／WPF）', detail: `${c.path} 是 Windows 桌面視窗程式，沒有網頁介面。需要改寫成網頁版（例如 ASP.NET Core）。` };
  }
  if (!a.language && !a.unsupported) a.unsupported = { reason: '看不出是哪一種專案', detail: '找不到 Python、Node、Java、.NET、Go、PHP 或網頁的專案檔（例如 requirements.txt、package.json、pom.xml、.csproj、go.mod、index.html）。' };

  // ── 各語言的框架、進入點、埠與健康檢查（SOP 12.3） ──
  if (a.language === 'python') {
    let deps = pythonDeps(keepFiles);
    if (!deps.length && !rootHas(/^(pyproject\.toml|setup\.py|setup\.cfg|Pipfile)$/)) { a.inferredDeps = inferPythonDeps(keepFiles); deps = a.inferredDeps.map((d) => d.toLowerCase()); }
    a.manifest.deps = deps;
    a.runtimeVersion = pythonVersion(allFiles, keepFiles, hints);
    const imports = (mod: string) => grep(keepFiles.filter((f) => f.path.endsWith('.py') && !TEST_DIR.test(f.path)), new RegExp(`^\\s*(import|from)\\s+${mod}\\b`));
    const rootPy = (pref: string[]) => pref.find((p) => keepFiles.some((f) => f.path === p)) ?? null;
    if (deps.includes('streamlit') || imports('streamlit').length) {
      const cands = imports('streamlit').map((h) => h.f.path).filter((p) => !p.includes('/'));
      a.framework = 'streamlit'; a.frameworkLabel = 'Streamlit';
      a.entry = rootPy(['app.py', 'main.py', 'streamlit_app.py', 'Home.py', 'home.py']) && cands.includes(rootPy(['app.py', 'main.py', 'streamlit_app.py', 'Home.py', 'home.py'])!) ? rootPy(['app.py', 'main.py', 'streamlit_app.py', 'Home.py', 'home.py']) : cands[0] ?? 'app.py';
      a.port = 8501; a.healthPath = '/_stcore/health'; a.healthBuiltin = true;
    } else if (deps.includes('fastapi') || imports('fastapi').length) {
      const h = grep(keepFiles.filter((f) => f.path.endsWith('.py')), /^(\w+)\s*=\s*FastAPI\(/)[0];
      a.framework = 'fastapi'; a.frameworkLabel = 'FastAPI'; a.port = 8000;
      a.entry = h ? `${h.f.path.replace(/\.py$/, '').replace(/\//g, '.')}:${h.m[1]}` : 'main:app';
    } else if (deps.includes('flask') || imports('flask').length) {
      const h = grep(keepFiles.filter((f) => f.path.endsWith('.py')), /^(\w+)\s*=\s*Flask\(/)[0];
      a.framework = 'flask'; a.frameworkLabel = 'Flask'; a.port = 8000;
      a.entry = h ? `${h.f.path.replace(/\.py$/, '').replace(/\//g, '.')}:${h.m[1]}` : 'app:app';
    } else if (deps.includes('django') || rootHas(/^manage\.py$/)) {
      const wsgi = keepFiles.find((f) => /(^|\/)wsgi\.py$/.test(f.path));
      a.framework = 'django'; a.frameworkLabel = 'Django'; a.port = 8000;
      a.entry = wsgi ? `${wsgi.path.replace(/\.py$/, '').replace(/\//g, '.')}:application` : null;
    } else if (deps.includes('gradio') || imports('gradio').length) {
      a.framework = 'gradio'; a.frameworkLabel = 'Gradio'; a.port = 7860; a.healthPath = '/'; a.healthBuiltin = true;
      a.entry = imports('gradio').map((h) => h.f.path).find((p) => !p.includes('/')) ?? 'app.py';
    } else if (deps.includes('dash') || imports('dash').length) {
      a.framework = 'dash'; a.frameworkLabel = 'Dash'; a.port = 8050; a.healthPath = '/'; a.healthBuiltin = true;
      a.entry = imports('dash').map((h) => h.f.path).find((p) => !p.includes('/')) ?? 'app.py';
    }
    const gui = imports('(tkinter|Tkinter|PyQt5|PyQt6|PySide2|PySide6|wx|kivy|pygame)');
    if (!a.framework && !a.unsupported) {
      a.unsupported = gui.length
        ? { reason: '桌面視窗程式', detail: `${gui[0].f.path}:${gui[0].line} 使用 ${gui[0].m[2]} 做視窗介面，使用者沒辦法從瀏覽器開啟。需要改寫成網頁版（例如 Streamlit、Flask）。` }
        : { reason: '沒有網頁介面', detail: '找不到 Streamlit、Flask、FastAPI、Django、Gradio 或 Dash 等網頁框架；平台上的工具要能從瀏覽器開啟。' };
    }
    const hw = imports('(serial|usb|hid|pyvisa|bluetooth|win32print)');
    if (hw.length && !a.unsupported) a.unsupported = { reason: '需要接實體設備', detail: `${hw[0].f.path}:${hw[0].line} 使用 ${hw[0].m[2]}（序列埠、USB、印表機等設備），平台上的工具碰不到電腦上的設備。` };
    if (a.framework && !a.healthBuiltin) { const r = existingRoute(keepFiles, 'py'); if (r) { a.healthBuiltin = true; a.healthPath = r; } }
    // 現有測試
    const tf = keepFiles.filter((f) => /(^|\/)(test_[^/]+|[^/]+_test)\.py$/.test(f.path)).map((f) => f.path);
    if (tf.length) {
      const dir = tf.every((p) => p.startsWith('tests/')) ? 'tests' : tf.every((p) => p.startsWith('test/')) ? 'test' : '.';
      a.tests = { command: ['python', '-m', 'pytest', '-q', '-p', 'no:cacheprovider', ...(dir === '.' ? [] : [dir])], files: tf, label: `專案原有的 pytest 測試（${tf.length} 個檔案）` };
    }
  } else if (a.language === 'node') {
    const pkg = nodePkg(keepFiles);
    a.manifest = { name: pkg.name, deps: pkg.deps };
    a.runtimeVersion = /(\d{2})/.exec(pkg.engines ?? '')?.[1] ?? '22';
    const d = (n: string) => pkg.deps.includes(n);
    if (d('electron')) a.unsupported = { reason: '桌面視窗程式（Electron）', detail: 'Electron 是桌面應用程式，使用者沒辦法從瀏覽器開啟。' };
    else if (d('next')) { a.framework = 'next'; a.frameworkLabel = 'Next.js'; a.port = 3000; a.healthPath = '/'; a.healthBuiltin = true; }
    else if (d('express') || d('fastify') || d('koa') || d('@nestjs/core') || d('@hapi/hapi')) {
      a.framework = ['express', 'fastify', 'koa', '@nestjs/core', '@hapi/hapi'].find(d)!; a.frameworkLabel = { express: 'Express', fastify: 'Fastify', koa: 'Koa', '@nestjs/core': 'NestJS', '@hapi/hapi': 'hapi' }[a.framework]!;
      a.port = 3000;
    } else if (pkg.scripts.build && (d('vite') || d('react-scripts') || d('@vue/cli-service') || d('@angular/cli'))) {
      a.framework = 'spa'; a.frameworkLabel = '前端網頁（建置後以 nginx 提供）'; a.port = 8080; a.healthPath = '/'; a.healthBuiltin = true;
    } else if (grep(keepFiles, /createServer\(|\.listen\(/, { code: true, skipTests: true }).length) { a.framework = 'node-http'; a.frameworkLabel = 'Node.js（http）'; a.port = 3000; }
    else a.unsupported = { reason: '沒有網頁介面', detail: '找不到 Express、Next.js 等網頁框架或 http 伺服器；平台上的工具要能從瀏覽器開啟。' };
    const listen = grep(keepFiles, /\.listen\(\s*(\d{4,5})/, { code: true, skipTests: true })[0] ?? grep(keepFiles, /PORT\s*\|\|\s*(\d{4,5})/, { code: true, skipTests: true })[0];
    if (listen && a.framework !== 'spa') a.port = Number(listen.m[1]);
    a.entry = pkg.scripts.start ? 'npm start' : pkg.main ?? ['server.js', 'index.js', 'app.js', 'main.js'].find((p) => keepFiles.some((f) => f.path === p)) ?? null;
    if (a.framework && !a.healthBuiltin) { const r = existingRoute(keepFiles, 'js'); if (r) { a.healthBuiltin = true; a.healthPath = r; } }
    if (pkg.scripts.test && !/no test specified/.test(pkg.scripts.test)) a.tests = { command: ['npm', 'test'], files: keepFiles.filter((f) => /\.(test|spec)\.[jt]sx?$/.test(f.path)).map((f) => f.path), label: '專案原有的 npm test' };
  } else if (a.language === 'java') {
    const pom = text(keepFiles, 'pom.xml') ?? '';
    const gradle = text(keepFiles, 'build.gradle') ?? text(keepFiles, 'build.gradle.kts') ?? '';
    const both = pom + gradle;
    a.runtimeVersion = /<java\.version>(\d+)/.exec(pom)?.[1] ?? /(?:sourceCompatibility|languageVersion)[^\d]*(\d{2})/.exec(gradle)?.[1] ?? '21';
    if (/javafx|swing/i.test(both)) a.unsupported = { reason: '桌面視窗程式（JavaFX／Swing）', detail: '這是桌面視窗程式，使用者沒辦法從瀏覽器開啟。' };
    else if (/spring-boot/.test(both)) {
      a.framework = pom ? 'spring-maven' : 'spring-gradle'; a.frameworkLabel = `Spring Boot（${pom ? 'Maven' : 'Gradle'}）`; a.port = 8080;
      if (/spring-boot-starter-actuator/.test(both)) { a.healthPath = '/actuator/health'; a.healthBuiltin = true; }
    } else a.unsupported = { reason: '看不出 Java 網頁框架', detail: '目前支援 Spring Boot（Maven 或 Gradle）。其他 Java 專案請轉 AI Team 協助。' };
    const p = /server\.port\s*[=:]\s*(\d+)/.exec(keepFiles.filter((f) => /application\.(properties|ya?ml)$/.test(f.path)).map((f) => f.text ?? '').join('\n'));
    if (p) a.port = Number(p[1]);
    if (a.framework && !a.healthBuiltin && grep(keepFiles, /["']\/(health|healthz)["']/, { code: true }).length) a.healthBuiltin = true;
    a.entry = 'app.jar';
  } else if (a.language === 'dotnet' && !a.unsupported) {
    const web = csproj.find((c) => /Sdk="Microsoft\.NET\.Sdk\.Web"/i.test(c.text ?? ''));
    a.runtimeVersion = /<TargetFramework>\s*net(\d+)\.0/i.exec(csproj.map((c) => c.text).join('\n'))?.[1] ?? '8';
    if (!web) a.unsupported = { reason: '不是網頁程式（.NET）', detail: '找不到 ASP.NET Core 網頁專案（Microsoft.NET.Sdk.Web）；平台上的工具要能從瀏覽器開啟。' };
    else { a.framework = 'aspnetcore'; a.frameworkLabel = `ASP.NET Core（.NET ${a.runtimeVersion}）`; a.port = 8080; a.entry = web.path; }
    if (a.framework && grep(keepFiles, /["']\/(health|healthz)["']|MapHealthChecks/, { code: true }).length) a.healthBuiltin = true;
  } else if (a.language === 'go') {
    a.runtimeVersion = /^go\s+(\d+\.\d+)/m.exec(text(keepFiles, 'go.mod') ?? '')?.[1] ?? '1.23';
    if (grep(keepFiles, /net\/http|gin-gonic|labstack\/echo|gofiber|go-chi/, { code: true }).length) { a.framework = 'go-http'; a.frameworkLabel = 'Go（網頁服務）'; a.port = 8080; }
    else a.unsupported = { reason: '沒有網頁介面', detail: '找不到 Go 的網頁服務（net/http、Gin、Echo…）；平台上的工具要能從瀏覽器開啟。' };
    const l = grep(keepFiles, /["']:(\d{4,5})["']/, { code: true, skipTests: true })[0];
    if (l) a.port = Number(l.m[1]);
    if (a.framework && grep(keepFiles, /["']\/(health|healthz)["']/, { code: true }).length) a.healthBuiltin = true;
    a.entry = '.';
  } else if (a.language === 'php') {
    a.framework = 'php'; a.frameworkLabel = 'PHP（內建網頁伺服器）'; a.port = 8080; a.healthPath = '/'; a.healthBuiltin = true; a.runtimeVersion = '8.3';
    a.entry = keepFiles.some((f) => f.path === 'public/index.php') ? 'public' : '.';
    if (/laravel\/framework/.test(text(keepFiles, 'composer.json') ?? '')) { a.frameworkLabel = 'Laravel'; a.entry = 'public'; }
  } else if (a.language === 'static') {
    a.framework = 'static'; a.frameworkLabel = '純靜態網頁（nginx）'; a.port = 8080; a.healthPath = '/'; a.healthBuiltin = true;
    a.entry = keepFiles.find((f) => /(^|\/)index\.html?$/i.test(f.path))!.path.replace(/\/?index\.html?$/i, '') || '.';
  }

  // ── 寫死的金鑰（SOP 12.5：只回報位置，不顯示內容） ──
  for (const f of keepFiles) {
    if (/\.env\.(example|sample|template)$/i.test(f.path)) continue;
    const sf = SECRET_FILES.find((s) => s.re.test(f.path));
    // 真正的 .env 直接不放進工具（SOP 第 3 節），不用問；其他金鑰檔（私鑰、憑證）要問
    if (sf && /(^|\/)\.env(\.[^/]+)?$/i.test(f.path)) { a.excluded.push({ path: root ? `${root}/${f.path}` : f.path, why: '環境設定檔（.env）可能有密碼，不放進工具；設定改由平台注入' }); continue; }
    if (sf) a.secrets.push({ file: f.path, detail: sf.label });
    if (f.text === null || TEST_DIR.test(f.path)) continue;
    for (const s of SECRET_CONTENT) {
      const m = new RegExp(s.re.source, s.re.flags).exec(f.text);
      if (!m) continue;
      const line = lineOf(f.text, m.index);
      if (!a.secrets.some((x) => x.file === f.path && x.line === line)) a.secrets.push({ file: f.path, line, detail: s.label });
    }
  }

  // ── 對外連線（工具在平台上不能連外） ──
  const SAFE_HOST = /^(localhost|127\.\d+\.\d+\.\d+|0\.0\.0\.0|.*\.?example\.(com|org|net)|.*\.local|www\.w3\.org|schemas\.[\w.]+|purl\.org|json-schema\.org|.*\.?openxmlformats\.org|.*\.?xmlsoap\.org|ns\.adobe\.com|xmlns\.com|host\.docker\.internal)$/i;
  const hosts = new Map<string, Ref[]>();
  const addHost = (h: string, r: Ref) => hosts.set(h, [...(hosts.get(h) ?? []), r]);
  for (const h of grep(keepFiles, /https?:\/\/([A-Za-z0-9.-]+)(?::\d+)?/, { code: true, skipTests: true })) {
    const host = h.m[1].toLowerCase();
    if (!SAFE_HOST.test(host) && !isModelHost(h.f.text!.split('\n')[h.line - 1])) addHost(host, { file: h.f.path, line: h.line, detail: h.m[0] });
  }
  for (const h of grep(keepFiles, /\b(mysql|postgres(?:ql)?|mssql|sqlserver|mongodb(?:\+srv)?|redis|oracle|amqp)[\w+]*:\/\/(?:[^@'"\s]*@)?([A-Za-z0-9.-]+)/, { code: true, skipTests: true })) {
    if (!SAFE_HOST.test(h.m[2])) addHost(`${h.m[2]}（${h.m[1]} 資料庫）`, { file: h.f.path, line: h.line, detail: `${h.m[1]} 連線` });
  }
  for (const h of grep(keepFiles, /["'](\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})(?::\d+)?["'/]/, { code: true, skipTests: true })) {
    const ip = h.m[1];
    if (ip.split('.').every((o) => Number(o) <= 255) && !/^(127\.|0\.0\.0\.0)/.test(ip)) addHost(ip, { file: h.f.path, line: h.line, detail: ip });
  }
  a.external = [...hosts.entries()].map(([host, refs]) => ({ host, refs }));

  // ── Windows 專用套件 ──
  const win = new Map<string, Ref[]>();
  const addWin = (n: string, r: Ref) => win.set(n, [...(win.get(n) ?? []), r]);
  if (a.language === 'python') {
    for (const h of grep(keepFiles.filter((f) => f.path.endsWith('.py')), /^\s*(?:import|from)\s+(win32\w*|pywintypes|pythoncom|winreg|_winreg|comtypes|wmi|msvcrt|winsound|pywinauto)\b/)) addWin(h.m[1], { file: h.f.path, line: h.line, detail: h.m[0].trim() });
    for (const h of grep(keepFiles.filter((f) => f.path.endsWith('.py')), /ctypes\.windll|ctypes\.WinDLL/)) addWin('ctypes.windll', { file: h.f.path, line: h.line, detail: 'Windows DLL 呼叫' });
    for (const dep of a.manifest.deps.filter((d) => /^(pywin32|pypiwin32|comtypes|wmi|pywinauto|pyodbc-access)$/.test(d))) addWin(dep, { file: 'requirements.txt', detail: `套件 ${dep}` });
  }
  if (a.language === 'node') for (const dep of a.manifest.deps.filter((d) => /^(winax|node-windows|edge-js|windows-registry|ffi-napi)$/.test(d))) addWin(dep, { file: 'package.json', detail: `套件 ${dep}` });
  a.windowsDeps = [...win.entries()].map(([name, refs]) => ({ name, refs }));

  // ── AI 模型 ──
  // 2026/11/03 實測：CNC 翻譯以 f"{api_base}/chat/completions" 呼叫，網址前半段在環境變數，原本的規則沒抓到
  const aiRe = /(OLLAMA_URL|ollama|\/api\/chat|\/api\/generate|\/chat\/completions|\/v1\/completions|chat\.completions\.create|from openai|import openai|require\(['"]openai['"]\)|from ['"]openai['"]|langchain|ChatOpenAI|OpenAIClient|openai-java|Azure\.AI\.OpenAI)/i;
  const aiHits = grep(keepFiles, aiRe, { code: true, skipTests: true });
  a.ai.uses = aiHits.length > 0;
  a.ai.refs = [...new Map(aiHits.map((h) => [h.f.path, { file: h.f.path, line: h.line, detail: h.m[1] }])).values()].slice(0, 8);
  const usesPlatformEnv = keepFiles.some((f) => f.text && CODE_EXT.test(f.path) && /OPENAI_BASE_URL/.test(f.text));
  if (a.ai.uses && !usesPlatformEnv) {
    a.ai.envMap = openaiEnvMap(keepFiles, aiHits.map((h) => h.f.path));
    if (!a.ai.envMap) a.ai.rewriteFiles = [...new Set(aiHits.map((h) => h.f.path))].slice(0, 4);
  }

  // ── 資料保存 ──
  analyzeData(a, keepFiles);

  // ── 測試資料：測試資料夾裡的資料檔（不放進工具，只在業務測試時掛上，公開後刪除） ──
  a.testData = keepFiles.filter((f) => TEST_DIR.test(f.path) && DATA_EXT.test(f.path) && !CODE_EXT.test(f.path) && !/(^|\/)(package(-lock)?|tsconfig|jest\.config)\.json$/.test(f.path)).map((f) => f.path);

  // ── 系統套件 ──
  a.systemPackages = systemPackages(a, keepFiles);
  return a;
}

/** 這一行是不是模型端點（例如 Ollama 的 localhost:11434 已排除；openai.com 之類的雲端模型改由平台轉接，不算一般對外連線） */
function isModelHost(line: string): boolean {
  return /api\.openai\.com|openai\.azure\.com|api\.anthropic\.com|generativelanguage\.googleapis\.com/.test(line);
}

function analyzeData(a: Analysis, files: SrcFile[]) {
  const py = files.filter((f) => f.path.endsWith('.py') && f.text && !TEST_DIR.test(f.path));
  a.data.readsDataDirEnv = files.some((f) => f.text && CODE_EXT.test(f.path) && /(getenv|environ(?:\.get)?|process\.env|Environment\.GetEnvironmentVariable|os\.Getenv|getenv)\s*[([]?\s*\.?["']?DATA_DIR/.test(f.text));
  // DATA_DIR 預設值（例如 PROJECT_ROOT / "data"）
  for (const f of py) {
    const m = /DATA_DIR\s*=.*?["']([\w.-]+)["']\s*\)*\s*\)?\s*(\.resolve\(\))?\s*$/m.exec(f.text!);
    if (m) { a.data.defaultDir = m[1]; break; }
  }
  // 從 DATA_DIR 往下的路徑：X = DATA_DIR / "a"、Y = X / "b"
  const base = new Map<string, string>([['DATA_DIR', '']]);
  for (let pass = 0; pass < 3; pass++) {
    for (const f of py) {
      for (const m of f.text!.matchAll(/^(\w+)\s*=\s*(\w+)\s*\/\s*["']([^"']+)["']/gm)) {
        if (base.has(m[2]) && !base.has(m[1])) base.set(m[1], [base.get(m[2]), m[3]].filter(Boolean).join('/'));
      }
    }
  }
  for (const f of py) {
    for (const m of f.text!.matchAll(/^(\w+)\s*=\s*(\w+)\s*\/\s*["']([^"']+)["']/gm)) {
      if (!base.has(m[2]) || m[1] === 'DATA_DIR') continue;
      const path = base.get(m[1])!;
      const item: DataItem = { path, kind: /\.(db|sqlite3?)$/.test(path) ? '資料庫' : /\.\w{2,5}$/.test(path) ? '檔案' : '資料夾', ref: { file: f.path, line: lineOf(f.text!, m.index!), detail: m[1] } };
      (/(^|\/)(_[^/]*|tmp|temp|cache|caches)(\/|$)|extracted/i.test(path) ? a.data.temp : a.data.keep).push(item);
    }
  }
  // 寫在程式資料夾（沒有經過 DATA_DIR），容器重開或更新後會不見
  const outRe = /^(\s*\w+\s*=\s*)?.*(Path\(__file__\)|os\.path\.dirname\(\s*(?:os\.path\.abspath\()?__file__)[^\n]*?["'](data|outbox|output|outputs|uploads?|exports?|logs?|results?|downloads?|storage)["'][^\n]*$/;
  let n = 0;
  for (const f of py) {
    f.text!.split('\n').forEach((l, i) => {
      if (isComment(l) || /DATA_DIR|PROJECT_ROOT\s*=/.test(l)) return;
      const m = outRe.exec(l);
      if (!m) return;
      // 只算「會寫入」的路徑（例如匯出資料夾）；只讀的範本檔不算
      const v = /^\s*(\w+)\s*=/.exec(l)?.[1];
      if (v && !writesTo(f.text!, v)) return;
      const parts = [...l.matchAll(/["']([\w.-]+)["']/g)].map((x) => x[1]);
      a.data.outside.push({ id: `out${++n}`, path: parts.join('/'), ref: { file: f.path, line: i + 1, detail: l.trim().slice(0, 140) } });
    });
  }
  // 其他語言：有寫檔但沒有用 DATA_DIR
  if (a.language !== 'python' && !a.data.readsDataDirEnv) {
    for (const h of grep(files, /(fs\.(?:writeFile|createWriteStream|mkdir)|new Database\(|sqlite3?\.|File\.Write|Files\.write|os\.(?:WriteFile|Create)\(|file_put_contents|fopen\([^)]*["']w)/, { code: true, skipTests: true }).slice(0, 5)) {
      a.data.outside.push({ id: `out${++n}`, path: '', ref: { file: h.f.path, line: h.line, detail: h.f.text!.split('\n')[h.line - 1].trim().slice(0, 140) } });
    }
  }
  // 預設資料夾裡隨程式附帶的檔案（例如範本）：第一次啟動時複製到資料目錄；看起來是正式資料的（.db）不放進工具
  const dd = a.data.defaultDir ?? (files.some((f) => f.path.startsWith('data/')) ? 'data' : null);
  if (dd) {
    for (const f of files.filter((x) => x.path.startsWith(`${dd}/`))) {
      if (LIVE_DATA.test(f.path)) a.data.liveData.push(f.path);
      else a.data.seeds.push(f.path);
    }
  }
}

/** 這個變數有沒有被拿來寫檔（建資料夾、存檔、開啟寫入） */
function writesTo(src: string, v: string): boolean {
  return new RegExp(`\\b${v}\\b[^\\n]*\\.(mkdir|write_text|write_bytes|touch|makedirs)\\(|\\b(makedirs|mkdir|save|to_excel|to_csv|savefig)\\([^\\n]*\\b${v}\\b|\\b(copy|copyfile|copy2|move|copytree)\\([^,\\n]*,[^\\n]*\\b${v}\\b|open\\(\\s*[^\\n]*\\b${v}\\b[^\\n]*["'][wa]b?["']|=\\s*${v}\\s*/`).test(src);
}

function systemPackages(a: Analysis, files: SrcFile[]): { pkg: string; why: string }[] {
  const out = new Map<string, string>();
  const src = files.filter((f) => f.text && CODE_EXT.test(f.path) && !TEST_DIR.test(f.path)).map((f) => f.text).join('\n');
  const deps = a.manifest.deps;
  if (a.language === 'python' || a.language === 'node') out.set('tzdata', '時區（台北時間）');
  if (/soffice|libreoffice/i.test(src)) out.set('libreoffice-writer-nogui', '把舊版 Word（.doc）轉檔（程式呼叫 LibreOffice）');
  if (/ocrmypdf|tesseract|pytesseract/i.test(src) || deps.includes('ocrmypdf') || deps.includes('pytesseract')) {
    out.set('tesseract-ocr', '文字辨識（OCR）');
    out.set('ghostscript', 'OCR 處理 PDF');
    for (const [lang, pkg] of [['chi_tra', 'tesseract-ocr-chi-tra'], ['chi_sim', 'tesseract-ocr-chi-sim'], ['jpn', 'tesseract-ocr-jpn']]) if (src.includes(lang)) out.set(pkg, `OCR 語言包（${lang}）`);
    if (deps.includes('ocrmypdf')) { out.set('pngquant', 'ocrmypdf 壓縮圖片'); out.set('unpaper', 'ocrmypdf 清理掃描頁'); }
  }
  if (/pdftoppm|pdf2image|pdftotext/i.test(src) || deps.includes('pdf2image')) out.set('poppler-utils', 'PDF 轉圖片');
  if (/wkhtmltopdf|pdfkit/i.test(src)) out.set('wkhtmltopdf', '網頁轉 PDF');
  if (/ffmpeg/i.test(src)) out.set('ffmpeg', '影音轉檔');
  if (deps.some((d) => /^opencv-python$/.test(d))) { out.set('libgl1', 'OpenCV'); out.set('libglib2.0-0', 'OpenCV'); }
  if (deps.includes('pyzbar')) out.set('libzbar0', '條碼辨識');
  if (deps.includes('psycopg2')) { out.set('libpq-dev', 'PostgreSQL 驅動編譯'); out.set('build-essential', '編譯 Python 套件'); }
  if (deps.includes('mysqlclient')) { out.set('default-libmysqlclient-dev', 'MySQL 驅動編譯'); out.set('build-essential', '編譯 Python 套件'); out.set('pkg-config', '編譯 Python 套件'); }
  if (/matplotlib/.test(deps.join(' ')) && /[一-鿿]/.test(src)) out.set('fonts-noto-cjk', '圖表顯示中文字');
  void SKIP_DIR;
  return [...out.entries()].map(([pkg, why]) => ({ pkg, why }));
}
