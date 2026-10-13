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
};
export type VulnItem = {
  id: string; severity: string; category: string; title: string; description: string; url: string | null;
  published: string | null; fixable: boolean; packages: { name: string; installed: string; fixed: string | null }[];
};
export type CatalogTool = { toolId: string; name: string; department: string; owner: string; version: string; releaseId: string; url: string | null; healthy: boolean; offline?: boolean; maintenance?: { at: string; actor: string; reason: string } | null; usesModel: boolean; releasedAt: string };
export type OpsEvent = { at: string; actor: string; action: string; label: string; toolId?: string; toolName: string | null; bad: boolean; reason?: string; version?: string };
export type ReleaseStep = { name: string; status: 'passed' | 'failed' | 'skipped'; at: string; detail?: string };
export type ReleaseRecord = {
  id: string; toolId: string; submissionId: string; name: string; version: string; status: string; url: string | null; createdAt: string; updatedAt: string; previousReleaseId: string | null;
  detail: { kind: 'release' | 'rollback' | 'redeploy'; steps: ReleaseStep[]; backupBefore?: string | null; dataMode?: 'keep' | 'restore'; error?: string; reason?: string; actor?: string; offline?: { at: string; actor: string; reason: string } };
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
  upload: (file: File, department: string, owner: string, expectedToolId?: string) =>
    call<{ submission: Submission; warnings: Issue[] }>('POST',
      `/submissions?department=${encodeURIComponent(department)}&owner=${encodeURIComponent(owner)}&filename=${encodeURIComponent(file.name)}&mode=${expectedToolId ? 'update' : 'new'}${expectedToolId ? `&expectedToolId=${encodeURIComponent(expectedToolId)}` : ''}`,
      file, 'application/zip'),
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
  releases: (toolId?: string) => call<{ releases: ReleaseRecord[] }>('GET', `/releases${toolId ? `?toolId=${encodeURIComponent(toolId)}` : ''}`).then((r) => r.releases),
  releaseLog: async (id: string) => (await fetch(`${BASE}/releases/${id}/log`, { credentials: 'same-origin' })).text(),
  catalog: () => call<{ tools: CatalogTool[] }>('GET', '/catalog').then((r) => r.tools),
  entryEvent: (e: { clientEventId: string; toolId: string; kind: 'click' | 'blocked'; reason?: string }) => call<{ recorded: boolean }>('POST', '/entry-events', e),
  withdraw: (id: string, reason: string) => call<{ submission: Submission }>('POST', `/submissions/${id}/withdraw`, { reason }),
  confirm: (id: string, note: string) => call<{ submission: Submission }>('POST', `/submissions/${id}/confirmations`, { note }),
  exception: (id: string, cveId: string, reason: string) => call<{ submission: Submission }>('POST', `/submissions/${id}/exceptions`, { cveId, reason }),
  approve: (id: string, reason: string) => call<{ submission: Submission }>('POST', `/submissions/${id}/approvals`, { reason }),
};
