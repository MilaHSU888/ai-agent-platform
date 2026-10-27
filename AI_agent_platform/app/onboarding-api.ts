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
export type TrialResult = { result: 'passed' | 'failed'; note: string; actor: string; at: string };
export type TrialInfo = { releaseId: string; submissionId: string; version: string; url: string | null; healthy: boolean; passed: boolean; result: TrialResult | null; since: string };
export type CatalogTool = { toolId: string; name: string; department: string; owner: string; version: string; releaseId: string; url: string | null; healthy: boolean; offline?: boolean; maintenance?: { at: string; actor: string; reason: string } | null; usesModel: boolean; releasedAt: string;
  /** trial＝試用中（未公開，只有開發者與 AI Team 看得到）；public＝公開 */ visibility: 'trial' | 'public'; trialPassed?: boolean; trialResult?: TrialResult | null; trial: TrialInfo | null;
  kind?: 'zip' | 'url'; icon?: ToolIcon | null; description?: string | null; scenario?: string | null; guide?: string | null };
export type OpsEvent = { at: string; actor: string; action: string; label: string; toolId?: string; toolName: string | null; bad: boolean; reason?: string; version?: string };
export type ReleaseStep = { name: string; status: 'passed' | 'failed' | 'skipped'; at: string; detail?: string };
export type ReleaseRecord = {
  id: string; toolId: string; submissionId: string; name: string; version: string; status: string; url: string | null; createdAt: string; updatedAt: string; previousReleaseId: string | null;
  detail: { kind: 'release' | 'rollback' | 'redeploy' | 'trial'; fromTrial?: string; ended?: { at: string; actor: string; reason: string; promotedTo?: string }; steps: ReleaseStep[]; backupBefore?: string | null; dataMode?: 'keep' | 'restore'; error?: string; reason?: string; actor?: string; offline?: { at: string; actor: string; reason: string } };
};
export type Session = { authenticated: boolean; actor?: string; environment?: string };

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

async function call<T>(method: string, path: string, body?: BodyInit | object, contentType?: string): Promise<T> {
  const isRaw = body instanceof Blob || body instanceof ArrayBuffer;
  const res = await fetch(BASE + path, {
    method,
    credentials: 'same-origin',
    headers: {
      ...(body ? { 'Content-Type': contentType ?? (isRaw ? 'application/zip' : 'application/json') } : {}),
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
  passTrial: (toolId: string, note: string) => call<{ version: string }>('POST', `/tools/${toolId}/trial-passed`, { note }),
  failTrial: (toolId: string, reason: string) => call<{ version: string; ended: boolean }>('POST', `/tools/${toolId}/trial-failed`, { reason }),
  publish: (toolId: string, note: string) => call<{ mode: 'visibility' | 'promote'; version: string }>('POST', `/tools/${toolId}/publish`, { note }),
  archive: (toolId: string, reason: string) => call<{ toolId: string; archived: boolean }>('POST', `/tools/${toolId}/archive`, { reason }),
  unpublish: (toolId: string, reason: string) => call<{ toolId: string }>('POST', `/tools/${toolId}/unpublish`, { reason }),
  endTrial: (toolId: string, reason: string) => call<{ toolId: string }>('POST', `/tools/${toolId}/end-trial`, { reason }),
  withdraw: (id: string, reason: string) => call<{ submission: Submission }>('POST', `/submissions/${id}/withdraw`, { reason }),
  codeReview: (id: string, note: string) => call<{ submission: Submission }>('POST', `/submissions/${id}/code-review`, { note }),
  confirm: (id: string, note: string) => call<{ submission: Submission }>('POST', `/submissions/${id}/confirmations`, { note }),
  exception: (id: string, cveId: string, reason: string) => call<{ submission: Submission }>('POST', `/submissions/${id}/exceptions`, { cveId, reason }),
  approve: (id: string, reason: string) => call<{ submission: Submission }>('POST', `/submissions/${id}/approvals`, { reason }),
};
