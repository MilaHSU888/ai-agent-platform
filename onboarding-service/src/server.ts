import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { Config } from './config.ts';
import { newId, now, type Store } from './db.ts';
import { Auth } from './auth.ts';
import { intake, validToolName } from './intake.ts';
import type { JobQueue } from './queue.ts';
import { vulnerabilityList } from './pipeline.ts';
import { catalog, recordEntryEvent, releaseHistory, requestRedeploy, requestRelease, requestRollback, offlineRelease, takeOffline } from './releases.ts';
import { opsEvents, restartTool, setMaintenance, toolLogs } from './ops.ts';
import { buildKit, type KitTarget } from './kit.ts';
import { approvalsFor, approveException, approveRelease, confirmTest, GateError, latestSteps, missingExceptions, releaseBlockers, withdraw } from './approvals.ts';
import type { Runtime } from './runtime.ts';
import type { Secrets } from './secrets.ts';

export const TEMPLATE = `# WorkHub 提交規格 v1 範本（不要放任何密鑰）
schemaVersion: workhub/v1
tool:
  id: my-tool                 # 小寫英數字與連字號
  # name: 我的工具            # 選填；工具名稱以 WorkHub 上傳表單為準
  version: 1.0.0              # 每次提交更新請遞增
  description: 一句話說明用途
build:
  dockerfile: Dockerfile
  context: .
  platforms: [linux/arm64]
run:
  port: 8080                  # 容器內監聽的埠
  # command: ["node", "server.js"]   # 省略則用 Dockerfile 的 CMD
  healthCheck:
    path: /health
    expectStatus: 200
    startPeriodSeconds: 30
  persistentData:
    - path: /data
      purpose: 工具需要保存的資料
  resources:
    cpu: "1"
    memory: 512Mi
test:
  command: ["npm", "test"]    # 在無網路、空白資料卷的容器內執行
  timeoutSeconds: 600
  network: none
env:
  required: []
  optional: []
model:
  uses: false                 # 使用 LLM 時改為 true，並填 approvedEndpoint
`;

type Ctx = { req: IncomingMessage; res: ServerResponse; url: URL; session: { actor: string } | null };

function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  const text = Buffer.isBuffer(body) || typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': typeof body === 'string' ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...headers,
  });
  res.end(text);
}

function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  return new Promise((resolveP, reject) => {
    const declared = Number(req.headers['content-length'] ?? 0);
    if (declared > limit) { reject(Object.assign(new Error('上傳檔案超過大小上限'), { status: 413 })); req.resume(); return; }
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > limit) { reject(Object.assign(new Error('上傳檔案超過大小上限'), { status: 413 })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolveP(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function json(req: IncomingMessage): Promise<Record<string, unknown>> {
  const b = await readBody(req, 64 * 1024);
  if (!b.length) return {};
  try { return JSON.parse(b.toString('utf8')) as Record<string, unknown>; } catch { throw Object.assign(new Error('JSON 格式錯誤'), { status: 400 }); }
}

export type App = { server: Server; auth: Auth };

export function createApp(store: Store, cfg: Config, queue: JobQueue, rt: Runtime, secrets: Secrets, proxyToken?: string): App {
  const auth = new Auth(cfg, proxyToken);

  const submissionView = (id: string) => {
    const s = store.get<Record<string, unknown>>('SELECT s.*, t.name AS tool_name, t.department, t.owner FROM submissions s JOIN tools t ON t.id=s.tool_id WHERE s.id=?', id);
    if (!s) return null;
    const job = store.get<Record<string, unknown>>("SELECT id,status,current_step,error,created_at,started_at,finished_at FROM jobs WHERE submission_id=? ORDER BY created_at DESC LIMIT 1", id);
    const steps = latestSteps(store, id);
    const sub = { id, status: String(s.status), source_hash: String(s.source_hash), image_digest: (s.image_digest as string | null), tool_id: String(s.tool_id), version: String(s.version) };
    return {
      id, toolId: s.tool_id, toolName: s.tool_name, department: s.department, owner: s.owner, version: s.version, revision: s.revision,
      status: s.status, sourceHash: s.source_hash, imageRef: s.image_ref, imageDigest: s.image_digest, originalFilename: s.original_filename,
      previewUrl: s.preview_port && ['awaiting_confirmation', 'awaiting_approval', 'approved'].includes(String(s.status)) ? `http://127.0.0.1:${s.preview_port}/` : null,
      warnings: JSON.parse(String(s.warnings_json)), createdBy: s.created_by, createdAt: s.created_at, updatedAt: s.updated_at,
      job, steps, approvals: approvalsFor(store, id),
      pendingExceptions: missingExceptions(store, sub),
      releaseBlockers: ['awaiting_approval', 'awaiting_confirmation'].includes(sub.status) ? releaseBlockers(store, cfg, sub) : [],
      release: store.get<{ id: string; status: string; updated_at: string }>('SELECT id, status, updated_at FROM releases WHERE submission_id=? ORDER BY created_at DESC LIMIT 1', id) ?? null,
    };
  };

  const routes: { method: string; re: RegExp; auth: boolean; fn: (c: Ctx, m: RegExpExecArray) => Promise<void> | void }[] = [
    { method: 'GET', re: /^\/api\/onboarding\/health$/, auth: false, fn: async ({ res }) => {
      const a = await rt.available();
      send(res, 200, { ok: true, environment: cfg.environment, docker: a.docker, trivy: a.trivy, queue: queue.current ? 'busy' : 'idle' });
    } },
    { method: 'GET', re: /^\/api\/onboarding\/session$/, auth: false, fn: ({ res, session }) => {
      send(res, 200, session ? { authenticated: true, actor: session.actor, environment: cfg.environment } : { authenticated: false, environment: cfg.environment });
    } },
    { method: 'POST', re: /^\/api\/onboarding\/tools\/([\w-]+)\/name$/, auth: true, fn: async ({ req, res, session }, m) => {
      const body = await json(req);
      const name = String(body.name ?? '').trim();
      const err = validToolName(name);
      if (err) throw new GateError([err]);
      const tool = store.get<{ name: string }>('SELECT name FROM tools WHERE id=?', m[1]);
      if (!tool) throw new GateError(['找不到此工具']);
      if (tool.name !== name) {
        store.tx(() => {
          store.run('UPDATE tools SET name=?, updated_at=? WHERE id=?', name, now(), m[1]);
          store.audit(session!.actor, 'tool.renamed', m[1], { from: tool.name, to: name });
        });
      }
      send(res, 200, { toolId: m[1], name });
    } },
    { method: 'GET', re: /^\/api\/onboarding\/kit$/, auth: true, fn: ({ res, url }) => {
      const toolId = url.searchParams.get('toolId');
      let target: KitTarget = null;
      if (toolId) {
        const tool = store.get<{ id: string; name: string }>('SELECT id, name FROM tools WHERE id=?', toolId);
        if (!tool) throw new GateError(['找不到此工具']);
        const latest = store.get<{ version: string; manifest_json: string }>('SELECT version, manifest_json FROM submissions WHERE tool_id=? ORDER BY revision DESC LIMIT 1', toolId)!;
        const live = store.get<{ version: string }>("SELECT s.version FROM releases r JOIN submissions s ON s.id=r.submission_id WHERE r.tool_id=? AND r.status IN ('active','offline') ORDER BY r.updated_at DESC LIMIT 1", toolId);
        const model = (JSON.parse(latest.manifest_json) as { model?: { uses?: boolean; approvedEndpoint?: string } }).model;
        target = { toolId, name: tool.name, released: live?.version ?? null, latest: latest.version, approvedEndpoint: model?.uses ? model.approvedEndpoint ?? null : null };
      }
      const { zip, missing } = buildKit(TEMPLATE, cfg.approvedModelEndpoints, target);
      const fname = toolId ? `workhub-kit-${toolId}.zip` : 'workhub-kit.zip';
      send(res, 200, zip, { 'Content-Type': 'application/zip', 'Content-Disposition': `attachment; filename="${fname}"`, ...(missing.length ? { 'X-Kit-Missing': encodeURIComponent(missing.join(',')) } : {}) });
    } },
    { method: 'GET', re: /^\/api\/onboarding\/template$/, auth: true, fn: ({ res }) => {
      send(res, 200, TEMPLATE, { 'Content-Type': 'text/yaml; charset=utf-8', 'Content-Disposition': 'attachment; filename="workhub.yaml"' });
    } },
    { method: 'GET', re: /^\/api\/onboarding\/submissions$/, auth: true, fn: ({ res }) => {
      const rows = store.all<{ id: string }>('SELECT id FROM submissions ORDER BY created_at DESC LIMIT 100');
      send(res, 200, { submissions: rows.map((r) => submissionView(r.id)) });
    } },
    { method: 'POST', re: /^\/api\/onboarding\/submissions$/, auth: true, fn: async ({ req, res, url, session }) => {
      if (!String(req.headers['content-type'] ?? '').startsWith('application/zip')) { send(res, 415, { error: '請以 application/zip 上傳 ZIP 檔' }); return; }
      const buf = await readBody(req, cfg.limits.uploadBytes);
      const r = intake(store, cfg, buf, {
        department: url.searchParams.get('department') ?? '', owner: url.searchParams.get('owner') ?? '',
        originalFilename: url.searchParams.get('filename') ?? 'upload.zip', actor: session!.actor,
        mode: url.searchParams.get('mode') ?? undefined, expectedToolId: url.searchParams.get('expectedToolId') ?? undefined,
        name: url.searchParams.get('name') ?? undefined,
      });
      if (!r.ok) {
        store.audit(session!.actor, 'submission.rejected', null, { filename: url.searchParams.get('filename'), issues: r.issues.slice(0, 50) });
        send(res, 422, { error: '提交包未通過檢查，已停止建置', issues: r.issues, warnings: r.warnings });
        return;
      }
      send(res, 201, { submission: submissionView(r.submissionId), warnings: r.warnings });
    } },
    { method: 'GET', re: /^\/api\/onboarding\/submissions\/([\w-]+)$/, auth: true, fn: ({ res }, m) => {
      const v = submissionView(m[1]);
      if (!v) { send(res, 404, { error: '找不到此提交' }); return; }
      send(res, 200, { submission: v });
    } },
    { method: 'POST', re: /^\/api\/onboarding\/submissions\/([\w-]+)\/retry$/, auth: true, fn: ({ res, session }, m) => {
      const s = store.get<{ status: string }>('SELECT status FROM submissions WHERE id=?', m[1]);
      if (!s) { send(res, 404, { error: '找不到此提交' }); return; }
      if (!['failed', 'cancelled', 'interrupted'].includes(s.status)) { send(res, 409, { error: `目前狀態（${s.status}）不需要重試` }); return; }
      const jobId = newId('job');
      store.tx(() => {
        store.run("INSERT INTO jobs(id,submission_id,kind,status,created_at) VALUES (?,?,'verify','queued',?)", jobId, m[1], now());
        store.setSubmissionStatus(m[1], 'queued');
        store.audit(session!.actor, 'job.retry', jobId, { submission: m[1] });
      });
      send(res, 202, { submission: submissionView(m[1]) });
    } },
    { method: 'POST', re: /^\/api\/onboarding\/jobs\/([\w-]+)\/cancel$/, auth: true, fn: ({ res, session }, m) => {
      if (!queue.cancel(m[1])) { send(res, 409, { error: '此工作已結束，無法取消' }); return; }
      store.audit(session!.actor, 'job.cancel_requested', m[1]);
      send(res, 202, { ok: true });
    } },
    { method: 'GET', re: /^\/api\/onboarding\/jobs\/([\w-]+)\/logs\/(\w+)$/, auth: true, fn: ({ res }, m) => {
      const job = store.get<{ submission_id: string }>('SELECT submission_id FROM jobs WHERE id=?', m[1]);
      if (!job) { send(res, 404, { error: '找不到工作' }); return; }
      const file = join(cfg.dataDir, 'evidence', job.submission_id, m[1], `${m[2]}.log`);
      if (!existsSync(file)) { send(res, 200, '（此步驟尚無日誌）'); return; }
      const size = statSync(file).size;
      const text = readFileSync(file).subarray(Math.max(0, size - 256 * 1024)).toString('utf8');
      send(res, 200, (size > 256 * 1024 ? '…（僅顯示最後 256 KB）\n' : '') + text);
    } },
    { method: 'GET', re: /^\/api\/onboarding\/submissions\/([\w-]+)\/vulnerabilities$/, auth: true, fn: ({ res }, m) => {
      const job = store.get<{ id: string }>("SELECT id FROM jobs WHERE submission_id=? AND kind='verify' ORDER BY created_at DESC LIMIT 1", m[1]);
      const file = job ? join(cfg.dataDir, 'evidence', m[1], job.id, 'trivy.json') : '';
      if (!job || !existsSync(file)) { send(res, 404, { error: '此提交尚無漏洞掃描結果' }); return; }
      const items = vulnerabilityList(JSON.parse(readFileSync(file, 'utf8')));
      send(res, 200, { scannedAt: statSync(file).mtime.toISOString(), items });
    } },
    { method: 'POST', re: /^\/api\/onboarding\/submissions\/([\w-]+)\/confirmations$/, auth: true, fn: async ({ req, res, session }, m) => {
      const body = await json(req);
      confirmTest(store, cfg, m[1], session!.actor, String(body.note ?? ''));
      send(res, 200, { submission: submissionView(m[1]) });
    } },
    { method: 'POST', re: /^\/api\/onboarding\/submissions\/([\w-]+)\/withdraw$/, auth: true, fn: async ({ req, res, session }, m) => {
      const body = await json(req);
      withdraw(store, m[1], session!.actor, String(body.reason ?? ''));
      queue.tick();
      const s = store.get<{ preview_container: string | null; tool_id: string; revision: number }>('SELECT preview_container, tool_id, revision FROM submissions WHERE id=?', m[1]);
      if (s?.preview_container) {
        await rt.remove(s.preview_container);
        await rt.removeVolume(`wh-preview-${s.tool_id}-r${s.revision}-data`);
        store.run('UPDATE submissions SET preview_port=NULL, preview_container=NULL WHERE id=?', m[1]);
      }
      send(res, 200, { submission: submissionView(m[1]) });
    } },
    { method: 'POST', re: /^\/api\/onboarding\/submissions\/([\w-]+)\/exceptions$/, auth: true, fn: async ({ req, res, session }, m) => {
      const body = await json(req);
      approveException(store, cfg, m[1], session!.actor, String(body.cveId ?? ''), String(body.reason ?? ''));
      send(res, 200, { submission: submissionView(m[1]) });
    } },
    { method: 'POST', re: /^\/api\/onboarding\/submissions\/([\w-]+)\/approvals$/, auth: true, fn: async ({ req, res, session }, m) => {
      const body = await json(req);
      approveRelease(store, cfg, m[1], session!.actor, String(body.reason ?? ''));
      send(res, 200, { submission: submissionView(m[1]) });
    } },
    { method: 'POST', re: /^\/api\/onboarding\/submissions\/([\w-]+)\/release$/, auth: true, fn: ({ res, session }, m) => {
      const r = requestRelease(store, cfg, m[1], session!.actor);
      send(res, 202, { ...r, submission: submissionView(m[1]) });
    } },
    { method: 'POST', re: /^\/api\/onboarding\/tools\/([\w-]+)\/rollback$/, auth: true, fn: async ({ req, res, session }, m) => {
      const body = await json(req);
      send(res, 202, requestRollback(store, cfg, m[1], session!.actor, String(body.reason ?? ''), String(body.dataMode ?? '')));
    } },
    { method: 'POST', re: /^\/api\/onboarding\/tools\/([\w-]+)\/redeploy$/, auth: true, fn: async ({ req, res, session }, m) => {
      const body = await json(req);
      send(res, 202, requestRedeploy(store, cfg, m[1], String(body.releaseId ?? ''), session!.actor, String(body.reason ?? '')));
    } },
    { method: 'POST', re: /^\/api\/onboarding\/tools\/([\w-]+)\/offline$/, auth: true, fn: async ({ req, res, session }, m) => {
      const body = await json(req);
      send(res, 200, await takeOffline(store, cfg, rt, m[1], session!.actor, String(body.reason ?? '')));
    } },
    { method: 'POST', re: /^\/api\/onboarding\/tools\/([\w-]+)\/online$/, auth: true, fn: async ({ req, res, session }, m) => {
      const body = await json(req);
      const off = offlineRelease(store, m[1]);
      if (!off) throw new GateError(['此工具目前不是下架狀態']);
      send(res, 202, requestRedeploy(store, cfg, m[1], off.id, session!.actor, String(body.reason ?? '')));
    } },
    { method: 'POST', re: /^\/api\/onboarding\/tools\/([\w-]+)\/maintenance$/, auth: true, fn: async ({ req, res, session }, m) => {
      const body = await json(req);
      send(res, 200, setMaintenance(store, m[1], body.on === true, session!.actor, String(body.reason ?? '')));
    } },
    { method: 'POST', re: /^\/api\/onboarding\/tools\/([\w-]+)\/restart$/, auth: true, fn: async ({ req, res, session }, m) => {
      const body = await json(req);
      send(res, 200, await restartTool(store, cfg, rt, m[1], session!.actor, String(body.reason ?? '')));
    } },
    { method: 'GET', re: /^\/api\/onboarding\/tools\/([\w-]+)\/logs$/, auth: true, fn: async ({ res, url }, m) => {
      send(res, 200, await toolLogs(store, rt, secrets, m[1], Number(url.searchParams.get('tail') ?? 200)));
    } },
    { method: 'GET', re: /^\/api\/onboarding\/ops\/events$/, auth: true, fn: ({ res }) => {
      send(res, 200, { events: opsEvents(store) });
    } },
    { method: 'GET', re: /^\/api\/onboarding\/releases$/, auth: true, fn: ({ res, url }) => {
      send(res, 200, { releases: releaseHistory(store, url.searchParams.get('toolId') ?? undefined) });
    } },
    { method: 'GET', re: /^\/api\/onboarding\/releases\/([\w-]+)\/log$/, auth: true, fn: ({ res }, m) => {
      const job = store.get<{ id: string; submission_id: string }>('SELECT id, submission_id FROM jobs WHERE release_id=? ORDER BY created_at DESC LIMIT 1', m[1]);
      const file = job ? join(cfg.dataDir, 'evidence', job.submission_id, job.id, 'release.log') : '';
      send(res, 200, job && existsSync(file) ? readFileSync(file, 'utf8').slice(-256 * 1024) : '（尚無日誌）');
    } },
    { method: 'GET', re: /^\/api\/onboarding\/catalog$/, auth: true, fn: async ({ res }) => {
      send(res, 200, { tools: await catalog(store, rt) });
    } },
    { method: 'POST', re: /^\/api\/onboarding\/entry-events$/, auth: true, fn: async ({ req, res, session }) => {
      const body = await json(req);
      send(res, 200, recordEntryEvent(store, session!.actor, { clientEventId: String(body.clientEventId ?? ''), toolId: String(body.toolId ?? ''), kind: String(body.kind ?? ''), reason: body.reason ? String(body.reason) : undefined }));
    } },
    { method: 'GET', re: /^\/api\/onboarding\/entry-events$/, auth: true, fn: ({ res, url }) => {
      const toolId = url.searchParams.get('toolId');
      send(res, 200, { events: store.all(`SELECT tool_id, kind, reason, version, actor, at FROM entry_events ${toolId ? 'WHERE tool_id=?' : ''} ORDER BY id DESC LIMIT 200`, ...(toolId ? [toolId] : [])) });
    } },
    { method: 'GET', re: /^\/api\/onboarding\/tools$/, auth: true, fn: ({ res }) => {
      send(res, 200, { tools: store.all('SELECT * FROM tools ORDER BY created_at') });
    } },
    { method: 'GET', re: /^\/api\/onboarding\/audit$/, auth: true, fn: ({ res, url }) => {
      const limit = Math.min(500, Number(url.searchParams.get('limit') ?? 100));
      send(res, 200, { events: store.all('SELECT at,actor,action,target,detail_json FROM audit_events ORDER BY id DESC LIMIT ?', limit) });
    } },
  ];

  const server = createServer(async (req, res) => {
    try {
      if (!auth.hostAllowed(req)) { send(res, 421, { error: 'Host 不允許' }); return; }
      const url = new URL(req.url ?? '/', `http://127.0.0.1:${cfg.port}`);
      const method = req.method ?? 'GET';
      const route = routes.find((r) => r.method === method && r.re.test(url.pathname));
      if (!route) { send(res, 404, { error: '找不到此 API' }); return; }
      const mutating = method !== 'GET';
      if (mutating && !auth.originAllowed(req)) { send(res, 403, { error: '跨來源請求已拒絕' }); return; }
      const session = auth.session(req);
      if (route.auth && !session) { send(res, 401, { error: '請從 WorkHub 網站操作上架（直接連線不接受）' }); return; }
      await route.fn({ req, res, url, session }, route.re.exec(url.pathname)!);
    } catch (e) {
      if (res.headersSent) { res.end(); return; }
      if (e instanceof GateError) { send(res, 409, { error: '條件未滿足', reasons: e.reasons }); return; }
      const status = (e as { status?: number }).status ?? 500;
      send(res, status, { error: status === 500 ? '上架服務內部錯誤' : (e as Error).message });
      if (status === 500) console.error(e);
    }
  });
  return { server, auth };
}
