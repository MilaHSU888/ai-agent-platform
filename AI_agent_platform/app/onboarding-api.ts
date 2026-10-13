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
};
export type VulnItem = {
  id: string; severity: string; category: string; title: string; description: string; url: string | null;
  published: string | null; fixable: boolean; packages: { name: string; installed: string; fixed: string | null }[];
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
  confirm: (id: string, note: string) => call<{ submission: Submission }>('POST', `/submissions/${id}/confirmations`, { note }),
  exception: (id: string, cveId: string, reason: string) => call<{ submission: Submission }>('POST', `/submissions/${id}/exceptions`, { cveId, reason }),
  approve: (id: string, reason: string) => call<{ submission: Submission }>('POST', `/submissions/${id}/approvals`, { reason }),
};
