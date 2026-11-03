/**
 * 原始碼自動打包（第 7 項，2026/11/03）：上傳原始碼 → 平台檢查與分析 → 範本產生打包檔 → 地端模型補程式
 * → 建置、斷網業務測試、健康檢查（失敗由模型修正，最多 3 次）→ 預檢 → 打包報告 → 開發者確認 → 進原本的上架流程。
 *
 * - 獨立排隊線（AutopackWorker）：一次打包一件，不卡住原本的上架檢查（JobQueue）。
 * - 遇到要問人的事（SOP 12.5：寫死的金鑰、對外連線、Windows 專用套件、資料要不要保存）就暫停，在網頁上問開發者。
 * - 一件最多 60 分鐘（等開發者回答的時間不算）；超過或修了 3 次仍失敗就轉 AI Team。
 * - 上傳的原始碼解壓後立刻刪除原檔；測試資料另外存放（testdata.ts），不放進 ZIP。
 */
import { createHash } from 'node:crypto';
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import type { Config } from '../config.ts';
import { newId, now, type Store } from '../db.ts';
import { GateError } from '../approvals.ts';
import { inspectZip, intake } from '../intake.ts';
import { makeZip } from '../kit.ts';
import { memoryToBytes } from '../manifest.ts';
import { notify } from '../models.ts';
import { waitHealthy } from '../pipeline.ts';
import { toolNetwork } from '../relay.ts';
import { freePort, type Ctx, type Runtime } from '../runtime.ts';
import type { Secrets } from '../secrets.ts';
import { extract, readCentralDirectory, type Issue } from '../zip-intake.ts';
import { analyze, type Analysis, type Ref } from './analyze.ts';
import { lineDiff } from './diff.ts';
import { loadTree, splitRoot } from './files.ts';
import { parseReply, platformModel, systemPrompt, taskPrompt, vetEdits, type ModelFn } from './model.ts';
import { generate } from './templates.ts';
import type { TestDataInfo } from './testdata.ts';

export type AutopackStatus = 'queued' | 'running' | 'awaiting_answer' | 'awaiting_review' | 'submitted' | 'handed_off' | 'cancelled' | 'failed';
type Stage = 'extract' | 'ask' | 'generate' | 'model' | 'verify' | 'report' | 'done';
export type Question = { id: string; kind: 'duplicate' | 'secret' | 'external' | 'windows' | 'data_keep'; title: string; detail: string; refs: Ref[]; options: { value: string; label: string }[];
  /** 選某個選項時要另外填的欄位（例如自訂 tool.id），答案存在 answers[key] */
  input?: { key: string; when: string; label: string; default: string; hint: string } };
type Step = { name: string; status: 'passed' | 'failed' | 'skipped' | 'running' | 'waiting'; at: string; detail?: string };
export type Change = { path: string; kind: 'added' | 'modified'; diff: string; add: number; del: number; by: 'template' | 'model' };
export type Report = {
  summary: Record<string, string>;
  decisions: { keep: string[]; temp: string[]; fixed: string[]; seeds: string[]; liveData: string[]; schemaChanges: string[]; ai: string; network: string };
  changes: Change[];
  testData: { path: string; size: number }[];
  excluded: { path: string; why: string }[];
  verification: { build: string; test: string; health: string; preflight: string };
  model: { calls: number; notes: string[]; rejected: string[] };
  confirm: string[];
  warnings: string[];
  markdown: string;
};
export type Detail = {
  steps: Step[];
  /** 這一輪開始處理的時間（處理中時網站即時算已用時間） */
  runStartedAt?: string;
  analysis?: Analysis;
  questions?: Question[];
  answers?: Record<string, string>;
  toolId?: string;
  description?: string;
  prevSubmission?: string | null;
  schemaChanges?: string[];
  generated?: { command: string[]; test: { command: string[]; label: string; smoke: boolean }; dataDir: string | null; notes: string[] };
  modelLog: { task: string; note: string; applied: string[]; rejected: { path: string; reason: string }[]; error?: string }[];
  fixRounds: number;
  verify?: { build?: string; test?: string; health?: string; testTail?: string[] };
  testData?: TestDataInfo;
  report?: Report;
  handoff?: { reason: string; detail: string; at: string };
  issues?: Issue[];
  version?: string;
};
type Row = { id: string; mode: 'new' | 'update'; tool_id: string | null; name: string | null; department: string; owner: string; actor: string; original_filename: string; status: AutopackStatus; stage: Stage; detail_json: string; active_ms: number; submission_id: string | null; error: string | null; created_at: string; updated_at: string };

export class HandOff extends Error { detail: string; constructor(reason: string, detail: string) { super(reason); this.detail = detail; } }
class Paused extends Error {}

export const autopackDir = (cfg: Config, id: string) => join(cfg.dataDir, 'autopack', id);
const TEST_DATA_DIR = (id: string) => join('testdata', id);

// ───────────────────────── 建立、回答、確認、取消 ─────────────────────────

export type CreateForm = { mode: 'new' | 'update'; expectedToolId?: string; name?: string; department: string; owner: string; actor: string; originalFilename: string; description?: string };

export function createAutopack(store: Store, cfg: Config, buf: Buffer, f: CreateForm): { ok: true; id: string } | { ok: false; issues: Issue[] } {
  const issues: Issue[] = [];
  const bad = (field: string, reason: string, fix: string) => issues.push({ file: '(平台表單)', field, reason, fix });
  if (!f.department.trim()) bad('department', '缺少部門', '選擇工具所屬部門');
  if (!f.owner.trim()) bad('owner', '缺少工具負責人', '填寫 Owner');
  if (f.mode === 'new' && !(f.name ?? '').trim()) bad('name', '請填寫工具名稱', '填寫使用者看得懂的工具名稱');
  if (f.mode === 'update') {
    const t = store.get<{ kind: string; archived_json: string | null }>('SELECT kind, archived_json FROM tools WHERE id=?', f.expectedToolId ?? '');
    if (!t || t.archived_json) bad('toolId', '找不到要更新的工具', '從工具清單選擇「提交新版本」');
    else if (t.kind === 'url') bad('toolId', '這是 URL 上架的工具', '請用「修改網址設定」');
  }
  if (buf.length < 22) issues.push({ file: '(上傳檔)', reason: '檔案太小，不是有效的 ZIP', fix: '把原始碼資料夾壓縮成 ZIP 後上傳' });
  if (issues.length) return { ok: false, issues };
  const id = newId('ap');
  const dir = autopackDir(cfg, id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'upload.zip'), buf, { mode: 0o600 });
  const t = now();
  store.tx(() => {
    store.run(`INSERT INTO autopacks(id,mode,tool_id,name,department,owner,actor,original_filename,status,stage,detail_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      id, f.mode, f.mode === 'update' ? f.expectedToolId! : null, (f.name ?? '').trim() || null, f.department, f.owner, f.actor, f.originalFilename.slice(0, 200), 'queued', 'extract',
      JSON.stringify({ steps: [], modelLog: [], fixRounds: 0, description: (f.description ?? '').trim() } satisfies Detail), t, t);
    store.audit(f.actor, 'autopack.created', f.mode === 'update' ? f.expectedToolId! : id, { autopack: id, filename: f.originalFilename, mode: f.mode });
  });
  return { ok: true, id };
}

const row = (store: Store, id: string) => store.get<Row>('SELECT * FROM autopacks WHERE id=?', id);
const save = (store: Store, id: string, patch: { status?: AutopackStatus; stage?: Stage; detail?: Detail; error?: string | null; submission?: string; tool?: string; addMs?: number }) => {
  const r = row(store, id)!;
  store.run('UPDATE autopacks SET status=?, stage=?, detail_json=?, error=?, submission_id=?, tool_id=?, active_ms=active_ms+?, updated_at=? WHERE id=?',
    patch.status ?? r.status, patch.stage ?? r.stage, JSON.stringify(patch.detail ?? JSON.parse(r.detail_json)), patch.error === undefined ? r.error : patch.error,
    patch.submission ?? r.submission_id, patch.tool ?? r.tool_id, patch.addMs ?? 0, now(), id);
};


export function answerAutopack(store: Store, cfg: Config, id: string, actor: string, answers: Record<string, string>) {
  const r = row(store, id);
  if (!r) throw new GateError(['找不到這筆自動打包']);
  if (r.status !== 'awaiting_answer') throw new GateError(['目前不需要回答問題']);
  const d = JSON.parse(r.detail_json) as Detail;
  const merged = { ...(d.answers ?? {}), ...answers };
  const missing = (d.questions ?? []).filter((q) => !q.options.some((o) => o.value === merged[q.id]));
  if (missing.length) throw new GateError(missing.map((q) => `請回答：${q.title}`));
  const dupQ = (d.questions ?? []).find((q) => q.kind === 'duplicate');
  // 是現有工具的新版本：結束這次打包，請開發者到該工具按「提交新版本」（才會沿用原本的資料與權限）
  if (dupQ && merged[dupQ.id] === 'update') {
    cleanup(cfg, id, { keepWork: false });
    store.tx(() => {
      save(store, id, { status: 'cancelled', error: `${dupQ.title.replace(/^平台上已經有/, '這是').replace(/，.*$/, '')}的新版本：請到該工具按「提交新版本」，選「上傳專案 ZIP，平台自動打包」重新上傳` });
      store.audit(actor, 'autopack.cancelled', r.tool_id ?? id, { autopack: id, reason: 'duplicate_tool' });
    });
    return;
  }
  if (dupQ && merged[dupQ.id] === 'new') {
    const t = (merged['dup.toolId'] ?? '').trim() || dupQ.input!.default;
    if (!/^[a-z][a-z0-9-]{2,39}$/.test(t)) throw new GateError(['工具代號只能用小寫英文、數字與 -，以英文開頭，3～40 個字']);
    if (t !== r.tool_id && (store.get('SELECT id FROM tools WHERE id=?', t) || store.get("SELECT id FROM autopacks WHERE tool_id=? AND id<>? AND status NOT IN ('cancelled','handed_off','failed')", t, id))) throw new GateError([`工具代號 ${t} 已經有人使用，請換一個`]);
    merged['dup.toolId'] = t;
  }
  d.answers = merged;
  store.tx(() => {
    save(store, id, { status: 'queued', detail: d });
    store.audit(actor, 'autopack.answered', r.tool_id ?? id, { autopack: id, answers: merged });
  });
}

export function cancelAutopack(store: Store, cfg: Config, id: string, actor: string) {
  const r = row(store, id);
  if (!r) throw new GateError(['找不到這筆自動打包']);
  if (['submitted', 'cancelled'].includes(r.status)) throw new GateError(['這筆自動打包已結束']);
  if (r.status === 'running') throw new GateError(['正在打包中，請等這一步完成後再取消']);
  cleanup(cfg, id, { keepWork: false });
  store.tx(() => { save(store, id, { status: 'cancelled', error: '已取消' }); store.audit(actor, 'autopack.cancelled', r.tool_id ?? id, { autopack: id }); });
}

/** 開發者確認打包報告 → 直接送進原本的上架流程（收件 → 建置 → 漏洞 → 程式碼檢查 → 預覽…） */
export function confirmAutopack(store: Store, cfg: Config, id: string, actor: string): { submissionId: string } {
  const r = row(store, id);
  if (!r) throw new GateError(['找不到這筆自動打包']);
  if (r.status !== 'awaiting_review') throw new GateError(['打包報告還沒完成，或已經送出']);
  const d = JSON.parse(r.detail_json) as Detail;
  const buf = readFileSync(join(autopackDir(cfg, id), 'out.zip'));
  const res = intake(store, cfg, buf, { department: r.department, owner: r.owner, actor, originalFilename: `自動打包-${r.original_filename}`, mode: r.mode, expectedToolId: r.mode === 'update' ? r.tool_id! : undefined, name: r.name ?? undefined, description: d.description });
  if (!res.ok) throw new GateError(res.issues.map((i) => `${i.file}：${i.reason}`));
  store.tx(() => {
    store.run('UPDATE submissions SET autopack_id=?, testdata_json=? WHERE id=?', id, d.testData && d.testData.files.length ? JSON.stringify(d.testData) : null, res.submissionId);
    d.version = res.version;
    save(store, id, { status: 'submitted', stage: 'done', detail: d, submission: res.submissionId, tool: res.toolId });
    store.audit(actor, 'autopack.confirmed', res.toolId, { autopack: id, submission: res.submissionId, version: res.version, testDataFiles: d.testData?.files.length ?? 0 });
  });
  cleanup(cfg, id, { keepWork: false, keepTestData: true });
  return { submissionId: res.submissionId };
}

/** 結束時清掉工作檔：原始上傳檔（可能含真實資料）一律刪；測試資料只在送出後保留到公開為止 */
function cleanup(cfg: Config, id: string, o: { keepWork: boolean; keepTestData?: boolean }) {
  const dir = autopackDir(cfg, id);
  rmSync(join(dir, 'upload.zip'), { force: true });
  rmSync(join(dir, 'raw'), { recursive: true, force: true });
  rmSync(join(dir, 'original'), { recursive: true, force: true });
  if (!o.keepWork) { rmSync(join(dir, 'src'), { recursive: true, force: true }); rmSync(join(dir, 'out.zip'), { force: true }); }
  if (!o.keepTestData) rmSync(join(cfg.dataDir, TEST_DATA_DIR(id)), { recursive: true, force: true });
}

// ───────────────────────── 排隊與執行 ─────────────────────────

export type WorkerOpts = { model?: (toolId: string) => ModelFn | null; clock?: () => number };

/** 自動打包的獨立排隊線：一次一件；狀態都在 SQLite，服務重開後繼續 */
export class AutopackWorker {
  store: Store; cfg: Config; rt: Runtime; secrets: Secrets; opts: WorkerOpts;
  current: { id: string; ctrl: AbortController } | null = null;
  idle: Promise<void> = Promise.resolve();
  timer: NodeJS.Timeout | null = null;
  constructor(store: Store, cfg: Config, rt: Runtime, secrets: Secrets, opts: WorkerOpts = {}) {
    this.store = store; this.cfg = cfg; this.rt = rt; this.secrets = secrets; this.opts = opts;
    // 服務重開時執行中的打包改回排隊（從目前階段重新開始）
    store.run("UPDATE autopacks SET status='queued' WHERE status='running'");
  }
  start(ms = 1500) { this.timer = setInterval(() => void this.tick(), ms); this.timer.unref(); void this.tick(); }
  stop() { if (this.timer) clearInterval(this.timer); this.current?.ctrl.abort(); }
  async tick() {
    if (this.current) return;
    const next = this.store.get<{ id: string }>("SELECT id FROM autopacks WHERE status='queued' ORDER BY created_at LIMIT 1");
    if (!next) return;
    const ctrl = new AbortController();
    this.current = { id: next.id, ctrl };
    let done!: () => void;
    this.idle = new Promise((r) => { done = r; });
    try { await runAutopack(this.store, this.cfg, this.rt, this.secrets, next.id, ctrl.signal, this.opts); }
    finally { this.current = null; done(); }
  }
}

export async function runAutopack(store: Store, cfg: Config, rt: Runtime, secrets: Secrets, id: string, signal: AbortSignal, opts: WorkerOpts = {}) {
  const clock = opts.clock ?? Date.now;
  const r = row(store, id)!;
  const d = JSON.parse(r.detail_json) as Detail;
  const dir = autopackDir(cfg, id);
  const logFile = join(dir, 'log.txt');
  mkdirSync(dir, { recursive: true });
  const log = (s: string) => appendFileSync(logFile, `[${new Date().toLocaleString('zh-TW', { hour12: false })}] ${s}\n`);
  const started = clock();
  const budgetMs = cfg.autopack.maxMinutes * 60_000;
  const used = () => r.active_ms + (clock() - started);
  const remaining = () => budgetMs - used();
  const checkTime = () => { if (remaining() <= 0) throw new HandOff(`超過 ${cfg.autopack.maxMinutes} 分鐘還沒打包完成`, '打包時間超過上限（等你回答問題的時間不算），已轉給 AI Team 協助。'); };
  const step = (name: string, status: Step['status'], detail?: string) => {
    const i = d.steps.findIndex((s) => s.name === name);
    const s = { name, status, at: now(), detail };
    if (i >= 0) d.steps[i] = s; else d.steps.push(s);
    save(store, id, { detail: d });
    log(`${name}：${{ passed: '完成', failed: '失敗', skipped: '略過', running: '進行中', waiting: '等待回答' }[status]}${detail ? `（${detail}）` : ''}`);
  };
  d.runStartedAt = new Date(started).toISOString();
  save(store, id, { status: 'running', detail: d });
  let stage: Stage = r.stage;
  try {
    if (stage === 'extract') { await stageExtract(); stage = 'ask'; save(store, id, { stage, detail: d }); }
    if (stage === 'ask') { stageAsk(); stage = 'generate'; save(store, id, { stage, detail: d }); }
    if (stage === 'generate') { stageGenerate(); stage = 'model'; save(store, id, { stage, detail: d }); }
    if (stage === 'model') { await stageModel(); stage = 'verify'; save(store, id, { stage, detail: d }); }
    if (stage === 'verify') { await stageVerify(); stage = 'report'; save(store, id, { stage, detail: d }); }
    if (stage === 'report') { stageReport(); }
    save(store, id, { status: 'awaiting_review', stage: 'report', detail: d, addMs: clock() - started });
    store.audit('system', 'autopack.ready', d.toolId ?? id, { autopack: id });
    notify(store, d.toolId ?? id, r.owner, 'autopack', `「${r.name ?? d.toolId}」自動打包完成，請到開發者中心確認打包報告`);
  } catch (e) {
    const ms = clock() - started;
    if (e instanceof Paused) { save(store, id, { status: 'awaiting_answer', stage, detail: d, addMs: ms }); notify(store, d.toolId ?? id, r.owner, 'autopack', `「${r.name ?? d.toolId}」自動打包需要你回答問題`); return; }
    if (signal.aborted) { save(store, id, { status: 'queued', addMs: ms }); return; }
    if (e instanceof HandOff) {
      d.handoff = { reason: e.message, detail: e.detail, at: now() };
      log(`轉給 AI Team：${e.message}`);
      cleanup(cfg, id, { keepWork: true });
      save(store, id, { status: 'handed_off', detail: d, error: e.message, addMs: ms });
      store.audit('system', 'autopack.handed_off', d.toolId ?? id, { autopack: id, reason: e.message });
      notify(store, d.toolId ?? id, r.owner, 'autopack', `「${r.name ?? d.toolId}」自動打包已轉給 AI Team：${e.message}`);
      return;
    }
    const msg = (e as Error).message;
    log(`錯誤：${msg}`);
    d.handoff = { reason: '打包時發生錯誤', detail: msg, at: now() };
    cleanup(cfg, id, { keepWork: true });
    save(store, id, { status: 'handed_off', detail: d, error: msg, addMs: ms });
    store.audit('system', 'autopack.handed_off', d.toolId ?? id, { autopack: id, reason: msg });
  }

  // ── 1. 解壓、分析（不用 AI） ──
  async function stageExtract() {
    step('解壓與安全檢查', 'running');
    const buf = readFileSync(join(dir, 'upload.zip'));
    const lim = { ...cfg, limits: { ...cfg.limits, uploadBytes: cfg.autopack.uploadBytes, totalUncompressedBytes: cfg.autopack.totalUncompressedBytes } };
    const cd = readCentralDirectory(buf, lim, false);
    if (cd.issues.length) { d.issues = cd.issues; throw new HandOff('上傳的檔案沒有通過安全檢查', cd.issues.map((i) => `${i.file}：${i.reason}`).join('\n')); }
    const raw = join(dir, 'raw');
    rmSync(raw, { recursive: true, force: true });
    extract(buf, cd.entries, '', raw);
    rmSync(join(dir, 'upload.zip'), { force: true }); // 原始上傳檔可能有真實資料，解壓後就刪
    step('解壓與安全檢查', 'passed', `${cd.entries.filter((e) => !e.isDir).length} 個檔案`);

    step('判斷專案類型', 'running');
    const tree = loadTree(raw);
    const a = analyze(tree.files, tree.skippedDirs, tree.hints);
    d.analysis = a;
    if (a.unsupported) { step('判斷專案類型', 'failed', a.unsupported.reason); throw new HandOff(`不支援的類型：${a.unsupported.reason}`, a.unsupported.detail); }
    step('判斷專案類型', 'passed', `${a.frameworkLabel}${a.runtimeVersion ? `（${langName(a)} ${a.runtimeVersion}）` : ''}${a.root ? `，專案資料夾 ${a.root}/` : ''}`);

    // 工具代號：版更沿用；新工具由平台產生
    // 2026/11/03 Mila：新工具的代號或名稱和現有工具相同時，先問是不是那個工具的新版本，不自動另開一個
    let dup: { id: string; name: string } | undefined;
    if (r.mode === 'update') d.toolId = r.tool_id!;
    else {
      const base = slugFrom(a.manifest.name ?? r.original_filename);
      dup = store.get<{ id: string; name: string }>('SELECT id, name FROM tools WHERE (id=? OR lower(name)=lower(?)) AND archived_json IS NULL ORDER BY id=? DESC LIMIT 1', base, (r.name ?? '').trim(), base);
      d.toolId = uniqueToolId(store, base);
    }
    save(store, id, { tool: d.toolId, detail: d });

    // 工作資料夾：original（對照用）、src（打包）、testdata（另外存放）
    const { inside } = splitRoot(tree.files, a.root);
    const rootAbs = join(raw, a.root);
    const original = join(dir, 'original'), src = join(dir, 'src'), td = join(cfg.dataDir, TEST_DATA_DIR(id));
    for (const p of [original, src, td]) rmSync(p, { recursive: true, force: true });
    const testSet = new Set(a.testData);
    const live = new Set(a.data.liveData);
    const excludedPaths = new Set(a.excluded.map((e) => e.path));
    const tdFiles: TestDataInfo['files'] = [];
    for (const f of inside) {
      const fullRel = a.root ? `${a.root}/${f.path}` : f.path;
      if (excludedPaths.has(fullRel)) continue;
      if (/(^|\/)\.env$/.test(f.path)) continue; // 真正的 .env 不放進工具（SOP 第 3 節）
      const from = join(rootAbs, f.path);
      if (testSet.has(f.path)) {
        const to = join(td, f.path);
        mkdirSync(dirname(to), { recursive: true });
        copyFileSync(from, to);
        tdFiles.push({ path: f.path, size: f.size, sha256: createHash('sha256').update(readFileSync(from)).digest('hex') });
        continue;
      }
      if (live.has(f.path)) continue;
      for (const base of [original, src]) { const to = join(base, f.path); mkdirSync(dirname(to), { recursive: true }); copyFileSync(from, to); }
    }
    rmSync(raw, { recursive: true, force: true });
    const workdir = ['python', 'node'].includes(a.language!) ? '/app' : null;
    const mountDirs = [...new Set(tdFiles.map((f) => topTestDir(f.path)))];
    d.testData = { dir: TEST_DATA_DIR(id), files: tdFiles, mounts: workdir ? mountDirs.map((m) => ({ from: m, target: `${workdir}/${m}` })) : [] };
    if (!tdFiles.length) rmSync(td, { recursive: true, force: true });

    // 版更：和上一版比對資料結構
    const prev = r.mode === 'update' ? store.get<{ id: string; manifest_json: string }>("SELECT id, manifest_json FROM submissions WHERE tool_id=? AND status IN ('released','trial') ORDER BY created_at DESC LIMIT 1", r.tool_id) : undefined;
    d.prevSubmission = prev?.id ?? null;
    if (prev) d.schemaChanges = schemaDiff(join(cfg.dataDir, 'workspaces', prev.id, 'src'), src);
    step('分析程式碼', 'passed', summaryLine(a, tdFiles.length));

    // 要問人的事（SOP 12.5）
    d.questions = [...(dup ? [duplicateQuestion(dup, d.toolId!)] : []), ...buildQuestions(a)];
    d.answers = d.answers ?? {};
  }

  // ── 2. 暫停提問（等開發者在網頁上回答） ──
  function stageAsk() {
    const qs = d.questions ?? [];
    const open = qs.filter((q) => !d.answers?.[q.id]);
    if (open.length) { step('等待開發者回答', 'waiting', `${open.length} 個問題`); throw new Paused(); }
    if (qs.length) step('等待開發者回答', 'passed', `已回答 ${qs.length} 題`);
    for (const q of qs) {
      const v = d.answers![q.id];
      if (q.kind === 'duplicate' && v === 'new' && d.answers!['dup.toolId'] && d.answers!['dup.toolId'] !== d.toolId) { d.toolId = d.answers!['dup.toolId']; save(store, id, { tool: d.toolId, detail: d }); }
      if (q.kind === 'secret' && v === 'reupload') throw new HandOff('需要先移除寫死的金鑰', `${q.refs.map(refText).join('、')}：請把金鑰改成環境變數後，重新上傳原始碼。`);
      if (q.kind === 'external' && v === 'needed') throw new HandOff('工具需要連外部系統', `${q.title}。工具在平台上不能連外，需要 AI Team 協助申請或評估。`);
      if (q.kind === 'windows' && v === 'needed') throw new HandOff('需要 Windows 專用套件', `${q.title}。平台是 Linux，需要 AI Team 協助評估改寫方式。`);
    }
  }

  // ── 3. 依範本產生打包檔（SOP 12.3） ──
  function stageGenerate() {
    checkTime();
    const a = d.analysis!;
    const src = join(dir, 'src');
    const prevManifest = d.prevSubmission ? (JSON.parse(store.get<{ manifest_json: string }>('SELECT manifest_json FROM submissions WHERE id=?', d.prevSubmission)!.manifest_json)) : null;
    const reqFile = a.language === 'python' ? (existsSync(join(src, 'requirements.txt')) ? 'requirements.txt' : readdirSync(src).find((f) => /^requirements[\w.-]*\.txt$/i.test(f)) ?? null)
      : a.language === 'php' && existsSync(join(src, 'composer.json')) ? 'composer.json' : null;
    const g = generate(a, { toolId: d.toolId!, description: d.description || r.name || '', platforms: [...new Set([cfg.hostPlatform, 'linux/arm64', 'linux/amd64'])], reqFile, hasLock: existsSync(join(src, 'package-lock.json')), prev: prevManifest, date: now().slice(0, 10) });
    const replaced = ['Dockerfile', 'workhub.yaml'].filter((p) => existsSync(join(src, p)));
    for (const [p, content] of Object.entries(g.files)) { mkdirSync(dirname(join(src, p)), { recursive: true }); writeFileSync(join(src, p), content); }
    if (g.dataDir && a.data.seeds.length) {
      const base = a.data.defaultDir ?? 'data';
      for (const s of a.data.seeds) { const to = join(src, '.workhub', 'seed', s.slice(base.length + 1)); mkdirSync(dirname(to), { recursive: true }); copyFileSync(join(src, s), to); }
    }
    d.generated = { command: g.command, test: g.test, dataDir: g.dataDir, notes: [...g.notes, ...(replaced.length ? [`原本的 ${replaced.join('、')} 已換成平台版本`] : [])] };
    step('產生打包檔', 'passed', `Dockerfile、workhub.yaml${a.data.seeds.length ? '、初始資料' : ''}`);
  }

  // ── 4. 地端模型補程式（一次一件小事） ──
  async function stageModel() {
    const a = d.analysis!;
    const src = join(dir, 'src');
    const tasks: { name: string; task: string; files: string[]; extra?: string }[] = [];
    if (a.ai.rewriteFiles.length) tasks.push({ name: 'AI 連線改用平台設定', files: a.ai.rewriteFiles,
      task: '讓這個工具在平台上改用平台的 AI 模型，用「新增」的方式，不要拆掉原本的寫法：有設定環境變數 OPENAI_BASE_URL 時，改走 OpenAI 相容介面（POST {OPENAI_BASE_URL}/chat/completions，金鑰讀 OPENAI_API_KEY 放在 Authorization: Bearer，模型名稱讀 OPENAI_MODEL；需要結構化輸出時用 response_format 或在提示詞要求 JSON，回覆內容在 choices[0].message.content）；檢查 AI 是否可用時，有 OPENAI_BASE_URL 就改查 GET {OPENAI_BASE_URL}/models。沒設定 OPENAI_BASE_URL 時，原本的呼叫方式（例如 Ollama 的 /api/chat）完全照舊，讓專案原有的測試照常通過。原本的函式、常數、參數、提示詞、回傳格式與錯誤處理都要保留，不要改名或刪除。' });
    for (const o of a.data.outside) if (d.answers?.[o.id] === 'keep') tasks.push({ name: `資料改存到資料目錄（${o.ref.file}）`, files: [o.ref.file, ...(existsSync(join(src, 'settings.py')) && o.ref.file !== 'settings.py' ? ['settings.py'] : [])],
      task: `${o.ref.file} 第 ${o.ref.line} 行把資料寫在程式資料夾（${o.ref.detail}），容器更新後會不見。改成寫到環境變數 DATA_DIR 指定的資料夾底下（例如 DATA_DIR/${o.path.replace(/^data\//, '')}）；若專案已有集中設定（例如 settings.py 的 DATA_DIR 或對應的變數），直接沿用。只改路徑，不改其他邏輯。` });
    for (const [i, q] of (d.questions ?? []).entries()) if (q.kind === 'secret' && d.answers?.[q.id] === 'env') tasks.push({ name: `移除寫死的金鑰（${q.refs[0].file}）`, files: [q.refs[0].file],
      task: `${q.refs[0].file} 第 ${q.refs.map((x) => x.line).filter(Boolean).join('、')} 行寫死了金鑰或密碼（已遮蔽成 [已遮蔽]）。把它改成讀環境變數（變數名稱用大寫英數字與底線，例如 ERP_TOKEN），沒設定時用空字串，程式照常啟動。不要在程式或註解留下任何金鑰。`, extra: `（第 ${i + 1} 個金鑰問題）` });
    for (const w of a.windowsDeps) if (d.answers?.[`win:${w.name}`] === 'remove') tasks.push({ name: `移除 Windows 專用套件 ${w.name}`, files: [...new Set(w.refs.map((x) => x.file))].filter((f) => existsSync(join(src, f))),
      task: `移除對 Windows 專用套件 ${w.name} 的使用（開發者已確認不需要）。相關功能改成在 Linux 也能執行，或在非 Windows 時略過。` });
    if (!a.healthBuiltin && a.framework && !['streamlit', 'gradio', 'dash', 'static', 'php', 'spa', 'next'].includes(a.framework)) {
      const entryFile = healthTarget(a, src);
      if (entryFile) tasks.push({ name: '加上健康檢查網址', files: [entryFile], task: `在 ${a.frameworkLabel} 程式加上 GET ${a.healthPath}，回傳 HTTP 200 與 {"status":"ok"}；不要改其他路由。` });
    }
    if (!tasks.length) { step('地端模型補程式', 'skipped', '不需要修改程式'); return; }
    const model = (opts.model ?? ((t) => platformModel(cfg, store, secrets, t)))(d.toolId!);
    if (!model) throw new HandOff('地端模型尚未設定', '平台預設模型還沒設定或連不到，無法自動補程式。請 AI Team 到「平台設定 → 模型端點」設定預設模型。');
    for (const t of tasks) {
      checkTime();
      step(`地端模型：${t.name}`, 'running');
      await runModelTask(model, t.task, t.files, t.extra ?? '', t.name);
      const last = d.modelLog.at(-1)!;
      step(`地端模型：${t.name}`, last.applied.length ? 'passed' : 'failed', last.applied.length ? `改了 ${last.applied.join('、')}` : last.error ?? '模型沒有提出可套用的修改');
    }
  }

  async function runModelTask(model: ModelFn, task: string, files: string[], extra: string, name: string) {
    const src = join(dir, 'src');
    const contents = files.filter((f) => existsSync(join(src, f))).map((f) => ({ path: f, content: readFileSync(join(src, f), 'utf8') }));
    // 其他檔案（含測試）從這些檔案匯入的名稱：模型不能刪掉或改名（2026/11/03 實測：模型刪了 OLLAMA_HINT，測試匯入失敗）
    const keep = importedNames(src, contents.map((c) => c.path));
    const keepNote = Object.entries(keep).filter(([, n]) => n.length).map(([f, n]) => `${f} 必須保留這些名稱（其他檔案或測試會匯入，不能刪除或改名，必要時保留為相容用的常數或函式）：${n.join('、')}`).join('\n');
    if (keepNote) extra = `${extra}\n${keepNote}`.trim();
    const entry: Detail['modelLog'][number] = { task: name, note: '', applied: [], rejected: [] };
    try {
      const ctrl = AbortSignal.any([signal, AbortSignal.timeout(Math.max(1000, Math.min(cfg.autopack.modelTimeoutMs, remaining())))]);
      const raw = await model(systemPrompt(), taskPrompt(task, contents, extra), ctrl);
      const reply = parseReply(raw);
      entry.note = reply.note;
      const testData = new Set(d.testData?.files.map((f) => f.path) ?? []);
      const vet = vetEdits(reply.edits, {
        exists: (p) => existsSync(join(src, p)),
        read: (p) => (existsSync(join(src, p)) ? readFileSync(join(src, p), 'utf8') : null),
        testData,
        allowNew: (p) => /^tests?\//.test(p) || /^\.workhub\//.test(p) || /(^|\/)(health|healthcheck)\.\w+$/.test(p),
      });
      for (const e of [...vet.ok]) {
        const missing = (keep[e.path] ?? []).filter((n) => !new RegExp(`\\b${n}\\b`).test(e.content));
        if (missing.length) { vet.ok.splice(vet.ok.indexOf(e), 1); vet.rejected.push({ path: e.path, reason: `刪掉了其他檔案或測試會用到的名稱：${missing.join('、')}` }); }
      }
      for (const e of vet.ok) { mkdirSync(dirname(join(src, e.path)), { recursive: true }); writeFileSync(join(src, e.path), e.content); entry.applied.push(e.path); }
      entry.rejected = vet.rejected;
      if (!reply.edits.length) entry.error = '模型回覆看不懂（不是約定的 JSON 格式）';
    } catch (e) {
      if (signal.aborted) throw e;
      entry.error = `呼叫模型失敗：${(e as Error).message}`;
    }
    d.modelLog.push(entry);
    save(store, id, { detail: d });
  }

  // ── 5. 建置 → 斷網業務測試 → 健康檢查；失敗交給模型修正，最多 3 次 ──
  async function stageVerify() {
    const a = d.analysis!;
    const src = join(dir, 'src');
    const tag = `workhub-autopack/${d.toolId}:${id.slice(-8)}`;
    for (;;) {
      checkTime();
      const round = d.fixRounds;
      const ctx = (name: string): Ctx => ({ logFile: join(dir, `${name}-${round}.log`), signal, mask: (s) => s });
      const fail = async (what: string, tail: string) => {
        if (d.fixRounds >= cfg.autopack.maxFixRounds) throw new HandOff(`修了 ${cfg.autopack.maxFixRounds} 次仍然${what}失敗`, `最後一次的錯誤：\n${tail.slice(-1500)}`);
        d.fixRounds++;
        const model = (opts.model ?? ((t) => platformModel(cfg, store, secrets, t)))(d.toolId!);
        if (!model) throw new HandOff('地端模型尚未設定', `${what}失敗，但平台預設模型還沒設定，無法自動修正。\n${tail.slice(-800)}`);
        step(`修正第 ${d.fixRounds} 次`, 'running', `${what}失敗，交給地端模型修正`);
        const files = ['Dockerfile', ...referencedFiles(tail, src)].slice(0, 5);
        await runModelTask(model, `${what}失敗。請找出原因並修正程式碼或 Dockerfile，讓專案原有的測試通過。測試檔只供參考，一律不能修改（測試就是驗收標準）；也不可以修改 workhub.yaml。常見原因：先前修改時刪掉或改名了測試會用到的函式、常數，或改變了原本的行為——請恢復原本的行為，新增的平台設定只在有對應環境變數時才生效。`, files,
          `錯誤訊息（最後一段）：\n${tail.slice(-4000)}\n\n專案檔案清單：\n${listFiles(src).slice(0, 150).join('\n')}`, `修正第 ${d.fixRounds} 次`);
        const last = d.modelLog.at(-1)!;
        step(`修正第 ${d.fixRounds} 次`, last.applied.length ? 'passed' : 'failed', last.applied.length ? `改了 ${last.applied.join('、')}` : last.error ?? '模型沒有提出修改');
      };
      // 建置
      step('建置', 'running', round ? `第 ${round + 1} 次` : undefined);
      const b = await rt.build(src, join(src, 'Dockerfile'), tag, { 'workhub.autopack': id }, cfg.hostPlatform, Math.min(cfg.timeouts.buildMs, Math.max(1000, remaining())), ctx('build'));
      if (signal.aborted) throw new Error('已中斷');
      if (!b.ok) { step('建置', 'failed'); await fail('建置', readTail(join(dir, `build-${round}.log`), b.result.stderr + b.result.stdout)); continue; }
      step('建置', 'passed');
      checkTime();
      const manifest = readFileSync(join(src, 'workhub.yaml'), 'utf8');
      const mem = memoryToBytes(/memory:\s*(\S+)/.exec(manifest)?.[1] ?? '1Gi') ?? 1024 ** 3;
      // 斷網業務測試（測試資料唯讀掛上）
      step('斷網業務測試', 'running', d.generated!.test.label);
      const vol = `wh-autopack-${id.slice(-10)}-data`.toLowerCase();
      const binds = (d.testData?.mounts ?? []).map((m) => ({ host: join(cfg.dataDir, d.testData!.dir, m.from), target: m.target })).filter((x) => existsSync(x.host));
      const t = await rt.runOnce({ image: tag, name: `wh-autopack-test-${id.slice(-10)}`.toLowerCase(), labels: { 'workhub.autopack': id }, volume: d.generated!.dataDir ? vol : undefined, mountPath: d.generated!.dataDir ?? undefined,
        env: {}, memoryBytes: mem, cpus: '1', command: d.generated!.test.command, network: 'none', binds }, Math.min(900_000, Math.max(1000, remaining())), ctx('test'));
      if (d.generated!.dataDir) await rt.removeVolume(vol);
      const out = (t.stdout + t.stderr).trim();
      d.verify = { ...(d.verify ?? {}), testTail: out.split('\n').slice(-8) };
      if (t.code !== 0 || t.timedOut) { step('斷網業務測試', 'failed', t.timedOut ? '逾時' : `結束碼 ${t.code}`); await fail('業務測試', readTail(join(dir, `test-${round}.log`), out)); continue; }
      d.verify.test = summarizeTest(out, d.generated!.test.smoke);
      step('斷網業務測試', 'passed', d.verify.test);
      checkTime();
      // 啟動後健康檢查（隔離網路，跟平台上架時一樣）
      step('健康檢查', 'running');
      const port = Number(/port:\s*(\d+)/.exec(manifest)?.[1] ?? a.port);
      const health = /path:\s*(\S+)/.exec(manifest)?.[1] ?? a.healthPath;
      const name = `wh-autopack-run-${id.slice(-10)}`.toLowerCase();
      const hp = await freePort();
      const net = toolNetwork(d.toolId!);
      await rt.ensureNetwork(net, cfg.toolNetworkInternal);
      const st = await rt.start({ image: tag, name, labels: { 'workhub.autopack': id }, hostPort: hp, containerPort: port, volume: d.generated!.dataDir ? vol : undefined, mountPath: d.generated!.dataDir ?? undefined, env: {}, memoryBytes: mem, cpus: '1', network: net }, ctx('run'));
      const startPeriod = Number(/startPeriodSeconds:\s*(\d+)/.exec(manifest)?.[1] ?? 30);
      const h = st.code === 0 ? await waitHealthy(rt, `http://127.0.0.1:${hp}${health}`, 200, Math.min(startPeriod * 1000 + cfg.timeouts.healthMs, Math.max(1000, remaining())), signal) : { ok: false, status: null, seconds: 0 };
      await rt.logs(name, ctx('run'));
      await rt.remove(name);
      if (d.generated!.dataDir) await rt.removeVolume(vol);
      if (!h.ok) { step('健康檢查', 'failed', `${health} 回應 ${h.status ?? '無'}`); await fail('啟動後的健康檢查', readTail(join(dir, `run-${round}.log`), '')); continue; }
      d.verify.build = '成功'; d.verify.health = `${health} → ${h.status}（${h.seconds} 秒）`;
      step('健康檢查', 'passed', d.verify.health);
      return;
    }
  }

  // ── 6. 預檢（與平台收件同一套檢查）＋ 打包報告（SOP 12.6） ──
  function stageReport() {
    checkTime();
    const src = join(dir, 'src');
    const files = listFiles(src);
    const zip = makeZip(files.map((p) => ({ name: p, data: readFileSync(join(src, p)) })));
    const pre = inspectZip(zip, cfg);
    if (pre.issues.length) { d.issues = pre.issues; step('預檢', 'failed', `${pre.issues.length} 項`); throw new HandOff('打包結果沒有通過預檢', pre.issues.map((i) => `${i.file}：${i.reason}`).join('\n')); }
    step('預檢', 'passed', pre.warnings.length ? `通過（提醒 ${pre.warnings.length} 項）` : '通過收件檢查');
    writeFileSync(join(dir, 'out.zip'), zip);
    d.report = buildReport(d, r, join(dir, 'original'), src, files, zip.length, pre.warnings);
    step('打包報告', 'passed');
  }
}

// ───────────────────────── 小工具 ─────────────────────────

const langName = (a: Analysis) => ({ python: 'Python', node: 'Node', java: 'Java', dotnet: '.NET', go: 'Go', php: 'PHP', static: '網頁' }[a.language!] ?? '');
const refText = (x: Ref) => `${x.file}${x.line ? `:${x.line}` : ''}`;

function summaryLine(a: Analysis, nTest: number) {
  return [`${a.data.keep.length + a.data.outside.length} 項要保存的資料`, a.ai.uses ? '有用 AI' : '沒有用 AI', a.external.length ? `${a.external.length} 個對外連線` : '不需連外', `測試資料 ${nTest} 個檔案`].join('、');
}

export function slugFrom(s: string): string {
  const tokens = s.replace(/\.zip$/i, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').split('-').filter(Boolean)
    .filter((t) => !/^\d{6,}$/.test(t) && !/^(winvm|win|windows|vm|final|release|package|pkg|src|source|code|v\d+(\.\d+)*)$/.test(t));
  let id = tokens.join('-').slice(0, 36).replace(/-+$/, '');
  if (!/^[a-z][a-z0-9-]{2,}$/.test(id)) id = `tool-${Date.now().toString(36)}`;
  return id;
}
function uniqueToolId(store: Store, base: string) {
  let id = base, n = 2;
  while (store.get('SELECT id FROM tools WHERE id=?', id) || store.get("SELECT id FROM autopacks WHERE tool_id=? AND status NOT IN ('cancelled','handed_off','failed')", id)) id = `${base.slice(0, 36)}-${n++}`;
  return id;
}

/** 測試資料要掛上的資料夾：取最上層的測試資料夾（例如 tests/fixtures） */
function topTestDir(p: string) {
  const parts = p.split('/');
  const i = parts.findIndex((x) => /^(fixtures?|testdata|test_data|samples?|data)$/i.test(x));
  return parts.slice(0, i >= 0 ? i + 1 : parts.length - 1).join('/') || '.';
}

function duplicateQuestion(dup: { id: string; name: string }, suggested: string): Question {
  return { id: 'dup', kind: 'duplicate', title: `平台上已經有「${dup.name}」（${dup.id}），這次上傳的是它的新版本嗎？`,
    detail: '工具代號或名稱和現有工具相同。如果是新版本，要從該工具的「提交新版本」上傳，才會沿用原本的資料、權限與使用紀錄；如果是另一個工具，請給它一個不同的代號。', refs: [],
    options: [{ value: 'update', label: `是「${dup.name}」的新版本（結束這次打包，改到該工具按「提交新版本」）` }, { value: 'new', label: '不是，這是另一個工具，繼續打包' }],
    input: { key: 'dup.toolId', when: 'new', label: '新工具的代號（tool.id）', default: suggested, hint: '小寫英文、數字與 -，例如 quote-compare；上架後不能改' } };
}

function buildQuestions(a: Analysis): Question[] {
  const qs: Question[] = [];
  const bySecretFile = new Map<string, Ref[]>();
  for (const s of a.secrets) bySecretFile.set(s.file, [...(bySecretFile.get(s.file) ?? []), s]);
  let n = 0;
  for (const [file, refs] of bySecretFile) qs.push({ id: `sec${++n}`, kind: 'secret', title: `${file} 疑似寫死的金鑰或密碼`, detail: `位置：${refs.map(refText).join('、')}（${refs[0].detail}；內容不顯示）。金鑰不能放進工具，要改成由平台以環境變數注入。`, refs,
    options: [{ value: 'env', label: '請平台改成讀環境變數（程式裡不留金鑰），繼續打包' }, { value: 'reupload', label: '我自己移除後重新上傳' }] });
  for (const h of a.external) qs.push({ id: `ext:${h.host}`, kind: 'external', title: `程式會連到 ${h.host}`, detail: `位置：${h.refs.slice(0, 5).map(refText).join('、')}。工具在平台上不能連外部網站或公司其他系統。`, refs: h.refs,
    options: [{ value: 'not_needed', label: '不需要（只是範例、註解或不會用到的功能），繼續打包' }, { value: 'needed', label: '需要，這是必要功能（轉給 AI Team 協助申請）' }] });
  for (const w of a.windowsDeps) qs.push({ id: `win:${w.name}`, kind: 'windows', title: `使用 Windows 專用套件 ${w.name}`, detail: `位置：${w.refs.slice(0, 5).map(refText).join('、')}。平台是 Linux，這個套件無法執行。`, refs: w.refs,
    options: [{ value: 'remove', label: '不需要，請平台移除相關程式碼' }, { value: 'needed', label: '需要（轉給 AI Team 評估）' }] });
  for (const o of a.data.outside) qs.push({ id: o.id, kind: 'data_keep', title: `${o.ref.file} 會把檔案寫到程式資料夾${o.path ? `的 ${o.path}` : ''}`, detail: `第 ${o.ref.line} 行：${o.ref.detail}\n放在程式資料夾的檔案，工具更新或重新啟動後會不見。這些檔案要保留嗎？`, refs: [o.ref],
    options: [{ value: 'keep', label: '要保留（請平台改存到資料目錄）' }, { value: 'temp', label: '不用保留（只是暫存）' }] });
  return qs;
}

function healthTarget(a: Analysis, src: string): string | null {
  const e = a.entry ?? '';
  if (a.language === 'python' && e.includes(':')) { const f = `${e.split(':')[0].replace(/\./g, '/')}.py`; return existsSync(join(src, f)) ? f : null; }
  if (a.language === 'node') return [e, 'server.js', 'index.js', 'app.js', 'src/index.js', 'src/server.js', 'src/main.ts'].find((f) => f && f !== 'npm start' && existsSync(join(src, f))) ?? null;
  if (a.language === 'dotnet') return ['Program.cs'].find((f) => existsSync(join(src, f))) ?? null;
  if (a.language === 'go') return ['main.go', 'cmd/server/main.go'].find((f) => existsSync(join(src, f))) ?? null;
  if (a.language === 'java') { const app = listFiles(src).find((f) => f.endsWith('Application.java')); return app ?? null; }
  return null;
}

export function listFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => { for (const e of readdirSync(d, { withFileTypes: true })) { const p = join(d, e.name); if (e.isDirectory()) walk(p); else if (e.isFile()) out.push(relative(dir, p).split(sep).join('/')); } };
  if (existsSync(dir)) walk(dir);
  return out.sort();
}

function referencedFiles(tail: string, src: string): string[] {
  const out = new Set<string>();
  for (const m of tail.matchAll(/(?:File "\/app\/([^"]+)"|\/app\/([\w./-]+\.\w+)|^\s*([\w./-]+\.(?:py|js|ts|java|cs|go|php)):\d+)/gm)) {
    const p = m[1] ?? m[2] ?? m[3];
    if (p && existsSync(join(src, p)) && !p.includes('site-packages')) out.add(p);
  }
  if (/requirements|pip install|No matching distribution|ModuleNotFoundError/i.test(tail) && existsSync(join(src, 'requirements.txt'))) out.add('requirements.txt');
  if (/npm (ERR|error)|Cannot find module/i.test(tail) && existsSync(join(src, 'package.json'))) out.add('package.json');
  return [...out].slice(0, 4);
}

function readTail(file: string, fallback: string) {
  try { const t = readFileSync(file, 'utf8'); return t.slice(-6000); } catch { return fallback.slice(-6000); }
}

function summarizeTest(out: string, smoke: boolean) {
  if (smoke) return '啟動測試通過';
  const m = /(\d+) passed(?:, (\d+) skipped)?/.exec(out);
  if (m) return `${m[1]} 項通過${m[2] ? `、${m[2]} 項略過` : ''}`;
  const j = /Tests:\s+(?:\d+ skipped, )?(\d+) passed/.exec(out);
  return j ? `${j[1]} 項通過` : '通過';
}

/** 版更：比對新舊版的資料表欄位（CREATE TABLE） */
function schemaDiff(oldDir: string, newDir: string): string[] {
  const tables = (dir: string) => {
    const map = new Map<string, Set<string>>();
    for (const f of listFiles(dir).filter((p) => /\.(py|sql|js|ts|php|go|cs|java)$/.test(p))) {
      let t = '';
      try { t = readFileSync(join(dir, f), 'utf8'); } catch { continue; }
      for (const m of t.matchAll(/CREATE TABLE(?: IF NOT EXISTS)?\s+["`]?(\w+)["`]?\s*\(([\s\S]*?)\)\s*[;'"`]/gi)) {
        const cols = new Set(m[2].split(',').map((c) => c.trim().split(/\s+/)[0]?.replace(/["`]/g, '')).filter((c) => c && !/^(PRIMARY|FOREIGN|UNIQUE|CHECK|CONSTRAINT)$/i.test(c)));
        map.set(m[1], cols);
      }
    }
    return map;
  };
  if (!existsSync(oldDir)) return [];
  const a = tables(oldDir), b = tables(newDir);
  const out: string[] = [];
  for (const [t, cols] of b) {
    if (!a.has(t)) { out.push(`新增資料表 ${t}`); continue; }
    const added = [...cols].filter((c) => !a.get(t)!.has(c));
    const removed = [...a.get(t)!].filter((c) => !cols.has(c));
    if (added.length) out.push(`資料表 ${t} 新增欄位：${added.join('、')}`);
    if (removed.length) out.push(`資料表 ${t} 移除欄位：${removed.join('、')}`);
  }
  for (const t of a.keys()) if (!b.has(t)) out.push(`移除資料表 ${t}`);
  return out;
}

function buildReport(d: Detail, r: Row, originalDir: string, srcDir: string, files: string[], zipBytes: number, warnings: Issue[]): Report {
  const a = d.analysis!;
  const g = d.generated!;
  const modelFiles = new Set(d.modelLog.flatMap((m) => m.applied));
  const changes: Change[] = [];
  for (const p of files) {
    const after = readFileSync(join(srcDir, p));
    const beforePath = join(originalDir, p);
    if (!existsSync(beforePath)) {
      const isText = !after.subarray(0, 8000).includes(0);
      changes.push({ path: p, kind: 'added', diff: isText ? after.toString('utf8').split('\n').map((l) => `+ ${l}`).join('\n') : `（新增二進位檔，${statSync(join(srcDir, p)).size} bytes）`, add: isText ? after.toString('utf8').split('\n').length : 0, del: 0, by: modelFiles.has(p) ? 'model' : 'template' });
      continue;
    }
    const before = readFileSync(beforePath);
    if (before.equals(after)) continue;
    const dd = lineDiff(before.toString('utf8'), after.toString('utf8'));
    changes.push({ path: p, kind: 'modified', diff: dd.text, add: dd.add, del: dd.del, by: modelFiles.has(p) ? 'model' : 'template' });
  }
  const fixed = a.data.outside.filter((o) => d.answers?.[o.id] === 'keep').map((o) => `${o.ref.file}：${o.path || '寫檔位置'} 改存到資料目錄`);
  const temp = [...a.data.temp.map((x) => `${x.path}（${x.kind}）`), ...a.data.outside.filter((o) => d.answers?.[o.id] === 'temp').map((o) => `${o.path}（${o.ref.file}，不保存）`)];
  const keep = a.data.keep.map((x) => `${x.path}（${x.kind}）`);
  const testData = (d.testData?.files ?? []).map((f) => ({ path: f.path, size: f.size }));
  const confirm: string[] = [];
  if (a.ai.uses) confirm.push(`AI 功能：已改用平台指定的模型（${a.ai.rewriteFiles.join('、') || '原本就讀平台設定'}），上線後請測試 AI 相關功能`);
  if (fixed.length) confirm.push('資料保存位置有修改，請確認匯出、上傳等功能存檔正常');
  if (g.test.smoke) confirm.push('專案沒有業務測試，目前只有啟動測試；建議之後補上');
  if (d.schemaChanges?.length) confirm.push(`和上一版相比資料格式有變（${d.schemaChanges.join('；')}），請確認新版能讀舊資料`);
  if (a.data.liveData.length) confirm.push(`${a.data.liveData.join('、')} 看起來是正式資料，沒有放進工具；需要的話請上線後再匯入`);
  confirm.push('在預覽中實際操作主要功能（上傳、解析、匯出）');
  const warn = warnings.map((w) => `${w.file}${w.field ? ` ${w.field}` : ''}：${w.reason}`);
  const network = a.external.length ? a.external.map((h) => `${h.host}（開發者確認不需要）`).join('、') : '不需要連外';
  const summary: Record<string, string> = {
    'ZIP': `${files.length} 個檔案，${(zipBytes / 1024).toFixed(0)} KB`,
    '類型': r.mode === 'update' ? '版本更新' : '第一次上架',
    'tool.id': d.toolId!,
    '專案': `${a.frameworkLabel}${a.runtimeVersion ? `（${langName(a)} ${a.runtimeVersion}）` : ''}`,
    '啟動命令': g.command.join(' '),
    '服務埠': String(a.port),
    '健康檢查': a.healthPath,
    '資料目錄': g.dataDir ?? '不保存資料',
    '使用 AI': a.ai.uses ? '是（經平台模型轉接）' : '否',
    '對外連線': network,
    '業務測試': `${g.test.label}：${d.verify?.test ?? ''}`,
  };
  const md = [
    `# 打包報告：${r.name ?? d.toolId}`,
    `- ZIP：${summary.ZIP}`,
    `- 類型：${summary['類型']}`,
    `- tool.id：${d.toolId}　埠：${a.port}　健康檢查：${a.healthPath}　資料目錄：${g.dataDir ?? '無'}　使用 AI：${a.ai.uses ? '是' : '否'}`,
    '', '## 改了什麼',
    ...changes.map((c) => `- ${c.path}：${c.kind === 'added' ? '新增' : '修改'}（${c.by === 'model' ? '地端模型' : '平台範本'}${c.kind === 'modified' ? `，+${c.add} −${c.del} 行` : ''}）`),
    ...d.modelLog.filter((m) => m.note).map((m) => `  - ${m.task}：${m.note}`),
    '', '## 驗證結果',
    `- 業務測試（不連網）：${d.verify?.test ?? ''}`,
    `- docker 建置（${'平台主機架構'}）：成功`,
    `- 健康檢查：${d.verify?.health ?? ''}`,
    `- 預檢：通過${warn.length ? `（提醒 ${warn.length} 項）` : ''}`,
    '', '## 平台的判斷',
    `- 會保存的資料：${keep.join('、') || '無'}`,
    `- 暫存、不保存：${temp.join('、') || '無'}`,
    ...(fixed.length ? [`- 已修正：${fixed.join('；')}`] : []),
    ...(a.data.seeds.length ? [`- 隨程式附帶、第一次啟動複製到資料目錄：${a.data.seeds.join('、')}`] : []),
    ...(d.schemaChanges?.length ? [`- 和上一版相比：${d.schemaChanges.join('；')}`] : []),
    `- 對外連線：${network}`,
    `- 測試資料（不放進工具，業務測試時才掛上，公開後刪除）：${testData.length} 個檔案`,
    '', '## 需要開發者確認', ...confirm.map((c) => `- ${c}`),
  ].join('\n');
  return {
    summary,
    decisions: { keep, temp, fixed, seeds: a.data.seeds, liveData: a.data.liveData, schemaChanges: d.schemaChanges ?? [], ai: a.ai.uses ? '有用 AI，已改用平台指定的模型' : '沒有用 AI', network },
    changes, testData, excluded: a.excluded,
    verification: { build: '成功', test: d.verify?.test ?? '', health: d.verify?.health ?? '', preflight: warn.length ? `通過（提醒：${warn.join('；')}）` : '通過' },
    model: { calls: d.modelLog.length, notes: d.modelLog.map((m) => `${m.task}：${m.note || m.error || ''}`), rejected: d.modelLog.flatMap((m) => m.rejected.map((x) => `${x.path}：${x.reason}`)) },
    confirm, warnings: [...warn, ...g.notes], markdown: md,
  };
}

/** 給網站看的資料（不含工作路徑） */
export function autopackView(store: Store, id: string) {
  const r = row(store, id);
  if (!r) return null;
  const d = JSON.parse(r.detail_json) as Detail;
  return {
    id: r.id, mode: r.mode, toolId: r.tool_id, name: r.name, department: r.department, owner: r.owner, actor: r.actor, filename: r.original_filename,
    status: r.status, stage: r.stage, steps: d.steps, questions: r.status === 'awaiting_answer' ? (d.questions ?? []).filter((q) => !d.answers?.[q.id]) : [],
    answers: d.answers ?? {}, report: r.status === 'awaiting_review' || r.status === 'submitted' ? d.report ?? null : null,
    handoff: d.handoff ?? null, error: r.error, submissionId: r.submission_id, version: d.version ?? null,
    analysis: d.analysis ? { framework: d.analysis.frameworkLabel, language: d.analysis.language, unsupported: d.analysis.unsupported } : null,
    activeMinutes: Math.floor((r.active_ms + (r.status === 'running' && d.runStartedAt ? Math.max(0, Date.now() - Date.parse(d.runStartedAt)) : 0)) / 60000), createdAt: r.created_at, updatedAt: r.updated_at,
  };
}

export function autopackList(store: Store) {
  return store.all<{ id: string }>('SELECT id FROM autopacks ORDER BY created_at DESC LIMIT 50').map((x) => autopackView(store, x.id)!);
}

/** AI Team 下載：打包紀錄（文字）與目前的打包結果（不含測試資料、不含原始上傳檔） */
export function autopackLog(cfg: Config, id: string): string {
  const dir = autopackDir(cfg, id);
  const parts: string[] = [];
  try { parts.push(readFileSync(join(dir, 'log.txt'), 'utf8')); } catch { parts.push('（尚無紀錄）'); }
  for (const f of existsSync(dir) ? readdirSync(dir).filter((x) => /\.log$/.test(x)).sort() : []) parts.push(`\n===== ${f} =====\n${readFileSync(join(dir, f), 'utf8').slice(-20000)}`);
  return parts.join('\n');
}
export function autopackZip(cfg: Config, id: string): Buffer | null {
  const src = join(autopackDir(cfg, id), 'src');
  if (!existsSync(src)) return null;
  return makeZip(listFiles(src).map((p) => ({ name: p, data: readFileSync(join(src, p)) })));
}

/** Python：其他檔案從指定檔案匯入的名稱（from a.b import X, Y），依檔案分組 */
export function importedNames(src: string, targets: string[]): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  const mods = new Map(targets.filter((t) => t.endsWith('.py')).map((t) => [t.replace(/\.py$/, '').replace(/\/__init__$/, '').split('/').join('.'), t]));
  if (!mods.size) return out;
  for (const f of listFiles(src).filter((x) => x.endsWith('.py') && !targets.includes(x))) {
    const text = readFileSync(join(src, f), 'utf8');
    for (const m of text.matchAll(/^\s*from\s+([\w.]+)\s+import\s+(\([^)]*\)|[^\n]+)/gm)) {
      const t = mods.get(m[1]);
      if (!t) continue;
      const names = m[2].replace(/[()]/g, '').split(',').map((x) => x.replace(/#.*$/, '').trim().split(/\s+as\s+/)[0].trim()).filter((x) => /^\w+$/.test(x) && x !== '*');
      out[t] = [...new Set([...(out[t] ?? []), ...names])].sort();
    }
  }
  return out;
}

