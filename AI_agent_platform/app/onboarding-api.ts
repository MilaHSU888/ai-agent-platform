// WorkHub 上架服務的前端呼叫。所有狀態以後端回應為準；本機通行碼由網站開發伺服器的代理在伺服器端附上，瀏覽器不持有任何憑證。
export type Issue = { file: string; field?: string; reason: string; fix: string };
export type StepState = { status: string; summary: Record<string, unknown> };
export type Approval = { kind: string; subject: string | null; actor: string; reason: string; created_at: string; revoked_at: string | null };
export type Submission = {
  id: string; toolId: string; toolName: string; department: string; owner: string; version: string; revision: number;
  status: string; sourceHash: string; imageRef: string | null; imageDigest: string | null; originalFilename: string;
  previewUrl: string | null; warnings: Issue[]; createdBy: string; createdAt: string; updatedAt: string;
  job: { id: string; status: string; current_step: string | null; error: string | null } | null;
  steps: Record<string, StepState>; approvals: Approval[]; pendingExceptions: string[]; releaseBlockers: string[];
  release: { id: string; status: string; updated_at: string } | null;
  /** zip＝上傳原始碼的小工具；url＝登錄既有網站（PRD §10） */ kind?: 'zip' | 'url'; urlConfig?: UrlConfig | null; icon?: ToolIcon | null;
  /** 工具層級的用途說明與適用情境（AI Team 可修改） */ profile?: ToolProfile;
  /** 使用模型的工具目前用哪個模型 */ model?: ToolModelInfo | null;
};
export type ToolProfile = { description: string | null; scenario: string | null };
export type UrlConfig = { url: string; description: string; usesAi: boolean; aiConfirmed: boolean; guide: string; tool: { id: string; version: string } };
export type UrlForm = { mode: 'new' | 'update'; toolId?: string; name?: string; department?: string; owner?: string; url: string; description: string; scenario?: string; usesAi: boolean; aiConfirmed: boolean; guide: string };
/** 工具圖示：symbol 為平台內建圖示 0～5，color 為內建顏色；只有 AI Team 可設定 */
export type ToolIcon = { symbol: number; color: string };
export type VulnItem = {
  id: string; severity: string; category: string; title: string; description: string; url: string | null;
  published: string | null; fixable: boolean; packages: { name: string; installed: string; fixed: string | null }[];
};
export type TrialInfo = { releaseId: string; submissionId: string; version: string; url: string | null; healthy: boolean; since: string };
export type CatalogTool = { toolId: string; name: string; department: string; owner: string; version: string; releaseId: string; url: string | null; healthy: boolean; offline?: boolean; maintenance?: { at: string; actor: string; reason: string } | null; usesModel: boolean; releasedAt: string;
  /** trial＝試用中（未公開，只有開發者與 AI Team 看得到）；public＝公開 */ visibility: 'trial' | 'public'; trial: TrialInfo | null;
  /** 是否公開過（第一次公開會清空試用資料）；是否有發布／公開工作進行中 */ everPublished?: boolean; busy?: boolean;
  kind?: 'zip' | 'url'; icon?: ToolIcon | null; description?: string | null; scenario?: string | null; guide?: string | null;
  /** 使用模型的 ZIP 工具：目前用哪個模型（AI Team 指定或平台預設）與是否僅限地端 */ model?: ToolModelInfo | null };
/** 模型管理（DEC-040） */
export type ModelRef = { endpoint: string; model: string };
export type ToolModelInfo = { ref: ModelRef | null; source: 'tool' | 'default' | 'none'; localOnly: boolean };
export type EndpointInfo = { id: string; location: 'local' | 'cloud'; reachable: boolean; error?: string; models: { id: string; enabled: boolean; isDefault: boolean; available: boolean; usedBy: string[] }[] };
export type UsageView = { calls: number; errors: number; promptTokens: number; completionTokens: number; tokens: number; avgMs: number | null };
export type ModelUsage = { from: string; to: string; hours: number; totals: UsageView; local: UsageView; cloud: UsageView;
  /** 預覽與試用版的用量（不含在 totals；2026/11/02 起才分得出來） */ test?: UsageView; testByTool?: (UsageView & { toolId: string; name: string })[];
  byTool: (UsageView & { toolId: string; name: string; lastAt: string; models: string[] })[]; byDay: (UsageView & { date: string })[] };
export type Notice = { id: string; toolId: string; toolName: string | null; kind: string; message: string; createdAt: string };
export type OpsEvent = { at: string; actor: string; action: string; label: string; toolId?: string; toolName: string | null; bad: boolean; reason?: string; version?: string };
export type ReleaseStep = { name: string; status: 'passed' | 'failed' | 'skipped'; at: string; detail?: string };
export type ReleaseRecord = {
  id: string; toolId: string; submissionId: string; name: string; version: string; status: string; url: string | null; createdAt: string; updatedAt: string; previousReleaseId: string | null;
  detail: { kind: 'release' | 'rollback' | 'redeploy' | 'trial'; fromTrial?: string; ended?: { at: string; actor: string; reason: string; promotedTo?: string }; steps: ReleaseStep[]; backupBefore?: string | null; dataMode?: 'keep' | 'restore'; error?: string; reason?: string; actor?: string; offline?: { at: string; actor: string; reason: string } };
};
export type Session = { authenticated: boolean; actor?: string; environment?: string };
/** 原始碼自動打包（2026/11/03） */
export type AutopackRef = { file: string; line?: number; detail: string };
export type AutopackQuestion = { id: string; kind: 'duplicate' | 'ai' | 'secret' | 'external' | 'windows' | 'data_keep'; title: string; detail: string; refs: AutopackRef[]; options: { value: string; label: string }[];
  input?: { key: string; when: string; label: string; default: string; hint: string } };
export type AutopackChange = { path: string; kind: 'added' | 'modified'; diff: string; add: number; del: number; by: 'template' | 'model' };
export type AutopackReport = {
  summary: Record<string, string>;
  decisions: { keep: string[]; temp: string[]; fixed: string[]; seeds: string[]; liveData: string[]; schemaChanges: string[]; ai: string; network: string };
  changes: AutopackChange[]; testData: { path: string; size: number }[]; excluded: { path: string; why: string }[];
  verification: { build: string; test: string; health: string; preflight: string };
  model: { calls: number; notes: string[]; rejected: string[] }; confirm: string[]; warnings: string[]; markdown: string;
};
export type Autopack = {
  id: string; mode: 'new' | 'update'; toolId: string | null; name: string | null; department: string; owner: string; actor: string; filename: string;
  status: 'queued' | 'running' | 'awaiting_answer' | 'awaiting_review' | 'submitted' | 'handed_off' | 'cancelled' | 'failed'; stage: string;
  steps: { name: string; status: 'passed' | 'failed' | 'skipped' | 'running' | 'waiting'; at: string; detail?: string }[];
  questions: AutopackQuestion[]; report: AutopackReport | null; handoff: { reason: string; detail: string; at: string } | null; error: string | null;
  submissionId: string | null; version: string | null; activeMinutes: number; createdAt: string; updatedAt: string;
};
/** 漏洞掃描器（2026/11/02）：版本與本機漏洞資料庫時間；正式環境不連網，不查最新版 */
export type ScannerInfo = { tool: 'trivy'; version: string | null; dbUpdatedAt: string | null; dbDownloadedAt: string | null; offline: boolean; cacheDir?: string };
export type ScannerStatus = { scanner: ScannerInfo | null; available: boolean; dbAgeDays: number | null; lastScanAt: string | null; offline: boolean };

export class ApiError extends Error {
  status: number; issues: Issue[]; reasons: string[]; warnings: Issue[];
  constructor(status: number, body: Record<string, unknown>) {
    super(String(body.error ?? `上架服務回應 ${status}`));
    this.status = status;
    this.issues = (body.issues as Issue[]) ?? [];
    this.reasons = (body.reasons as string[]) ?? [];
    this.warnings = (body.warnings as Issue[]) ?? [];
  }
}

const BASE = '/api/onboarding';

/**
 * 示範身分（2026/11/02）：網站「目前身分（示範）」選的人，每個請求帶給上架服務，寫進審核履歷與稽核紀錄。
 * 本機試點沒有登入，名字未經驗證，紀錄上一律標示「示範，未驗證」；接上公司 AD 後由登入身分取代。
 */
let demoActor = '';
export function setDemoActor(name: string) { demoActor = name; }

export type ReviewRow = { at: string; toolId: string; toolName: string; version: string; action: string; actor: string; identity: string; note: string };

/** 下載審核履歷 CSV（不傳 toolId＝全部工具） */
export async function downloadReviewCsv(toolId?: string) {
  const r = await fetch(`${BASE}/review-history.csv${toolId ? `?toolId=${encodeURIComponent(toolId)}` : ''}`, { credentials: 'same-origin' });
  if (!r.ok) throw new ApiError(r.status, { error: `匯出失敗（${r.status}）` });
  const name = decodeURIComponent(/filename\*=UTF-8''([^;]+)/.exec(r.headers.get('content-disposition') ?? '')?.[1] ?? 'WorkHub審核履歷.csv');
  const url = URL.createObjectURL(await r.blob());
  const a = document.createElement('a'); a.href = url; a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function call<T>(method: string, path: string, body?: BodyInit | object, contentType?: string): Promise<T> {
  const isRaw = body instanceof Blob || body instanceof ArrayBuffer;
  const res = await fetch(BASE + path, {
    method,
    credentials: 'same-origin',
    headers: {
      ...(body ? { 'Content-Type': contentType ?? (isRaw ? 'application/zip' : 'application/json') } : {}),
      ...(demoActor ? { 'X-WorkHub-Actor': encodeURIComponent(demoActor) } : {}),
    },
    body: body ? (isRaw ? (body as BodyInit) : JSON.stringify(body)) : undefined,
  });
  const text = await res.text();
  let data: Record<string, unknown> = {};
  try { data = text ? JSON.parse(text) : {}; } catch { data = { text }; }
  if (!res.ok) throw new ApiError(res.status, data);
  return data as T;
}

export const onboardingApi = {
  session: () => call<Session>('GET', '/session'),
  health: () => call<{ ok: boolean; docker: boolean; trivy: boolean; environment: string; queue: string }>('GET', '/health'),
  list: () => call<{ submissions: Submission[] }>('GET', '/submissions').then((r) => r.submissions),
  get: (id: string) => call<{ submission: Submission }>('GET', `/submissions/${id}`).then((r) => r.submission),
  upload: (file: File, department: string, owner: string, expectedToolId?: string, name?: string, profile?: { description: string; scenario: string }) =>
    call<{ submission: Submission; warnings: Issue[] }>('POST',
      `/submissions?department=${encodeURIComponent(department)}&owner=${encodeURIComponent(owner)}&filename=${encodeURIComponent(file.name)}&mode=${expectedToolId ? 'update' : 'new'}${expectedToolId ? `&expectedToolId=${encodeURIComponent(expectedToolId)}` : ''}${name ? `&name=${encodeURIComponent(name.trim())}` : ''}${profile ? `&description=${encodeURIComponent(profile.description.trim())}&scenario=${encodeURIComponent(profile.scenario.trim())}` : ''}`,
      file, 'application/zip'),
  submitUrl: (f: UrlForm) => call<{ submission: Submission; warnings: Issue[] }>('POST', '/submissions/url', f),
  setProfile: (toolId: string, p: { description: string; scenario: string }) => call<{ toolId: string }>('POST', `/tools/${toolId}/profile`, p),
  models: () => call<{ endpoints: EndpointInfo[]; default: ModelRef | null }>('GET', '/models'),
  setModelEnabled: (r: ModelRef, enabled: boolean) => call<{ ok: boolean }>('POST', '/models/enabled', { ...r, enabled }),
  setDefaultModel: (r: ModelRef, reason: string) => call<{ default: ModelRef }>('POST', '/models/default', { ...r, reason }),
  setToolModel: (toolId: string, r: ModelRef | null, reason: string) => call<ToolModelInfo>('POST', `/tools/${toolId}/model`, r ? { ...r, reason } : { useDefault: true, reason }),
  setLocalOnly: (toolId: string, on: boolean) => call<{ localOnly: boolean }>('POST', `/tools/${toolId}/local-only`, { on }),
  scanner: () => call<ScannerStatus>('GET', '/scanner'),
  autopackUpload: (file: File, f: { mode: 'new' | 'update'; expectedToolId?: string; name?: string; department: string; owner: string; description?: string; usesAi: 'yes' | 'no' | 'unsure' }) =>
    call<{ autopack: Autopack }>('POST', `/autopack?mode=${f.mode}&usesAi=${f.usesAi}&department=${encodeURIComponent(f.department)}&owner=${encodeURIComponent(f.owner)}&filename=${encodeURIComponent(file.name)}${f.expectedToolId ? `&expectedToolId=${encodeURIComponent(f.expectedToolId)}` : ''}${f.name ? `&name=${encodeURIComponent(f.name.trim())}` : ''}${f.description ? `&description=${encodeURIComponent(f.description.trim())}` : ''}`, file, 'application/zip').then((r) => r.autopack),
  autopacks: () => call<{ autopacks: Autopack[] }>('GET', '/autopack').then((r) => r.autopacks),
  answerAutopack: (id: string, answers: Record<string, string>) => call<{ autopack: Autopack }>('POST', `/autopack/${id}/answers`, { answers }),
  confirmAutopack: (id: string) => call<{ autopack: Autopack; submission: Submission }>('POST', `/autopack/${id}/confirm`, {}),
  cancelAutopack: (id: string) => call<{ autopack: Autopack }>('POST', `/autopack/${id}/cancel`, {}),
  reviewHistory: (toolId: string) => call<{ rows: ReviewRow[] }>('GET', `/tools/${toolId}/review-history`).then((r) => r.rows),
  modelUsage: (hours: number, toolId?: string) => call<ModelUsage>('GET', `/model-usage?hours=${hours}${toolId ? `&toolId=${encodeURIComponent(toolId)}` : ''}`),
  notices: (owner: string) => call<{ notices: Notice[] }>('GET', `/notices?owner=${encodeURIComponent(owner)}`).then((r) => r.notices),
  readNotice: (id: string) => call<{ ok: boolean }>('POST', `/notices/${id}/read`),
  setIcon: (toolId: string, icon: ToolIcon) => call<{ toolId: string; icon: ToolIcon }>('POST', `/tools/${toolId}/icon`, icon),
  retry: (id: string) => call<{ submission: Submission }>('POST', `/submissions/${id}/retry`),
  cancel: (jobId: string) => call('POST', `/jobs/${jobId}/cancel`),
  log: async (jobId: string, step: string) => {
    const r = await fetch(`${BASE}/jobs/${jobId}/logs/${step}`, { credentials: 'same-origin' });
    return r.text();
  },
  vulns: (id: string) => call<{ scannedAt: string; items: VulnItem[] }>('GET', `/submissions/${id}/vulnerabilities`),
  release: (id: string) => call<{ releaseId: string }>('POST', `/submissions/${id}/release`),
  rollback: (toolId: string, reason: string, dataMode: 'keep' | 'restore') => call<{ releaseId: string }>('POST', `/tools/${toolId}/rollback`, { reason, dataMode }),
  redeploy: (toolId: string, releaseId: string, reason: string) => call<{ releaseId: string }>('POST', `/tools/${toolId}/redeploy`, { releaseId, reason }),
  offline: (toolId: string, reason: string) => call<{ releaseId: string }>('POST', `/tools/${toolId}/offline`, { reason }),
  online: (toolId: string, reason: string) => call<{ releaseId: string }>('POST', `/tools/${toolId}/online`, { reason }),
  maintenance: (toolId: string, on: boolean, reason = '') => call<{ maintenance: unknown }>('POST', `/tools/${toolId}/maintenance`, { on, reason }),
  restart: (toolId: string, reason = '') => call<{ ok: boolean; seconds: number; error?: string }>('POST', `/tools/${toolId}/restart`, { reason }),
  toolLogs: async (toolId: string) => (await fetch(`${BASE}/tools/${toolId}/logs?tail=200`, { credentials: 'same-origin' })).text(),
  opsEvents: () => call<{ events: OpsEvent[] }>('GET', '/ops/events').then((r) => r.events),
  rename: (toolId: string, name: string) => call<{ toolId: string; name: string }>('POST', `/tools/${toolId}/name`, { name }),
  releases: (toolId?: string) => call<{ releases: ReleaseRecord[] }>('GET', `/releases${toolId ? `?toolId=${encodeURIComponent(toolId)}` : ''}`).then((r) => r.releases),
  releaseLog: async (id: string) => (await fetch(`${BASE}/releases/${id}/log`, { credentials: 'same-origin' })).text(),
  catalog: () => call<{ tools: CatalogTool[] }>('GET', '/catalog').then((r) => r.tools),
  entryEvent: (e: { clientEventId: string; toolId: string; kind: 'click' | 'blocked'; reason?: string; trial?: boolean }) => call<{ recorded: boolean }>('POST', '/entry-events', e),
  /** 試用／公開燈號（AI Team）：trial＝試用中、public＝公開中、ended＝下架；有 jobId 表示背景處理中 */
  light: (toolId: string, target: 'trial' | 'public' | 'ended', note = '') => call<{ mode: 'visibility' | 'promote' | 'first_publish' | 'ended' | 'offline'; version: string; jobId?: string }>('POST', `/tools/${toolId}/light`, { target, note }),
  archive: (toolId: string, reason: string) => call<{ toolId: string; archived: boolean }>('POST', `/tools/${toolId}/archive`, { reason }),

  withdraw: (id: string, reason: string) => call<{ submission: Submission }>('POST', `/submissions/${id}/withdraw`, { reason }),
  codeReview: (id: string, note: string) => call<{ submission: Submission }>('POST', `/submissions/${id}/code-review`, { note }),
  confirm: (id: string, note: string) => call<{ submission: Submission }>('POST', `/submissions/${id}/confirmations`, { note }),
  exception: (id: string, cveId: string, reason: string) => call<{ submission: Submission }>('POST', `/submissions/${id}/exceptions`, { cveId, reason }),
  approve: (id: string, reason: string) => call<{ submission: Submission }>('POST', `/submissions/${id}/approvals`, { reason }),
};
