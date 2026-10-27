import { test } from 'node:test';
import { request } from 'node:http';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { existsSync, statSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { Store } from '../src/db.ts';
import { JobQueue } from '../src/queue.ts';
import { Secrets } from '../src/secrets.ts';
import { createApp } from '../src/server.ts';
import { runReleaseJob } from '../src/releases.ts';
import { FakeRuntime, MANIFEST, testConfig, validZip, type FakeOpts } from './helpers.ts';

const ORIGIN = 'http://localhost:3002';
const TOKEN = 'test-proxy-token-0001';

async function setup(opts: FakeOpts = {}) {
  const cfg0 = testConfig();
  const store = new Store(join(cfg0.dataDir, 'db.sqlite'));
  const rt = new FakeRuntime(opts);
  const secrets = new Secrets(cfg0.dataDir);
  // 先以 0 埠啟動取得實際埠，再讓 Host 檢查使用該埠
  const cfg = { ...cfg0, timeouts: { ...cfg0.timeouts, healthMs: 300 } };
  const queue = new JobQueue(store, cfg, rt, secrets);
  queue.extraKinds.release = (id, signal) => runReleaseJob(store, cfg, rt, secrets, id, signal);
  queue.extraKinds.rollback = (id, signal) => runReleaseJob(store, cfg, rt, secrets, id, signal);
  queue.extraKinds.redeploy = (id, signal) => runReleaseJob(store, cfg, rt, secrets, id, signal);
  queue.extraKinds.trial = (id, signal) => runReleaseJob(store, cfg, rt, secrets, id, signal);
  const app = createApp(store, cfg, queue, rt, secrets, TOKEN);
  await new Promise<void>((r) => app.server.listen(0, '127.0.0.1', () => r()));
  cfg.port = (app.server.address() as AddressInfo).port;
  const base = `http://127.0.0.1:${cfg.port}`;
  let token = TOKEN;
  const call = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
    const isBuf = Buffer.isBuffer(body);
    const r = await fetch(base + path, {
      method,
      headers: {
        ...(method !== 'GET' ? { Origin: ORIGIN } : {}),
        ...(token ? { 'X-WorkHub-Proxy-Token': token } : {}),
        ...(isBuf ? { 'Content-Type': 'application/zip' } : body ? { 'Content-Type': 'application/json' } : {}),
        ...headers,
      },
      body: isBuf ? new Uint8Array(body as Buffer) : body ? JSON.stringify(body) : undefined,
    });
    const text = await r.text();
    let data: Record<string, unknown> = {};
    try { data = JSON.parse(text); } catch { data = { text }; }
    return { status: r.status, data, headers: r.headers };
  };
  const login = async () => { token = TOKEN; };
  const runQueue = async () => { await queue.tick(); await queue.idle; };
  const close = () => new Promise<void>((r) => app.server.close(() => r()));
  return { cfg, store, rt, queue, secrets, call, login, runQueue, close, base, setToken: (v: string) => { token = v; } };
}

const upload = (call: Awaited<ReturnType<typeof setup>>['call'], buf: Buffer, q = 'department=purchase&owner=Mila&filename=demo.zip') =>
  call('POST', `/api/onboarding/submissions?${q}`, buf);

test('安全：Host 不符、沒有或錯誤的代理通行碼、跨來源寫入都拒絕；不需登入碼', async () => {
  const t = await setup();
  try {
    const wrongHost = await new Promise<number>((res, rej) => {
      const u = new URL(t.base);
      const r = request({ host: '127.0.0.1', port: u.port, path: '/api/onboarding/session', headers: { Host: 'evil.example:80' } }, (resp) => { resp.resume(); res(resp.statusCode ?? 0); });
      r.on('error', rej); r.end();
    });
    assert.equal(wrongHost, 421);
    t.setToken('');
    assert.equal((await t.call('GET', '/api/onboarding/submissions')).status, 401);
    assert.deepEqual((await t.call('GET', '/api/onboarding/session')).data.authenticated, false);
    t.setToken('wrong-token-wrong-token-wrong-tok');
    assert.equal((await upload(t.call, validZip())).status, 401);
    t.setToken('test-proxy-token-0001');
    assert.equal((await t.call('GET', '/api/onboarding/session')).data.authenticated, true);
    assert.equal((await upload(t.call, validZip(), 'department=x&owner=y')).status, 201);
    assert.equal((await t.call('POST', '/api/onboarding/submissions?department=x&owner=y', validZip([{ name: 'v2.txt', data: '2' }]), { Origin: 'http://evil.example' })).status, 403);
    const noOrigin = await fetch(`${t.base}/api/onboarding/submissions?department=x&owner=y`, { method: 'POST', headers: { 'X-WorkHub-Proxy-Token': 'test-proxy-token-0001', 'Content-Type': 'application/zip' }, body: new Uint8Array(validZip([{ name: 'v3.txt', data: '3' }])) });
    assert.equal(noOrigin.status, 403);
    assert.ok(existsSync(join(t.cfg.dataDir, 'proxy-token')));
    assert.equal((statSync(join(t.cfg.dataDir, 'proxy-token')).mode & 0o077), 0);
  } finally { await t.close(); }
});

test('完整流程：上傳 → 建置 → 掃描 → 測試 → 預覽 → 測試確認 → 發布核准', async () => {
  const t = await setup();
  try {
    await t.login();
    const up = await upload(t.call, validZip());
    assert.equal(up.status, 201);
    const id = (up.data.submission as { id: string }).id;
    await t.runQueue();
    const s1 = (await t.call('GET', `/api/onboarding/submissions/${id}`)).data.submission as Record<string, any>;
    assert.equal(s1.status, 'awaiting_confirmation');
    assert.equal(s1.steps.build.status, 'passed');
    assert.equal(s1.steps.scan.status, 'passed');
    assert.equal(s1.steps.code_review.status, 'awaiting');
    assert.match(s1.steps.code_review.summary.reason, /開發者人工程式碼檢查/);
    assert.equal(s1.steps.platform_test.status, 'passed');
    assert.equal(s1.steps.business_test.status, 'passed');
    assert.equal(s1.steps.preview.status, 'passed');
    assert.match(s1.previewUrl, /^http:\/\/127\.0\.0\.1:186\d\d\/$/);
    // 業務測試在無網路容器執行；預覽容器埠只綁本機（由 runtime 以 127.0.0.1 綁定）
    assert.equal(t.rt.ran[0].network, 'none');
    assert.equal((await t.call('POST', `/api/onboarding/submissions/${id}/approvals`, { reason: 'ok' })).status, 409);
    assert.equal((await t.call('POST', `/api/onboarding/submissions/${id}/confirmations`, { note: '核對 Q01～Q07' })).status, 409, '未做程式碼檢查不能確認測試');
    const cr = await t.call('POST', `/api/onboarding/submissions/${id}/code-review`, {});  // 開發者直接按「已檢查」，備註選填
    assert.equal(cr.status, 200);
    const s2 = cr.data.submission as Record<string, any>;
    assert.equal(s2.steps.code_review.status, 'passed');
    assert.equal(s2.steps.code_review.summary.reviewer, 'Mila');
    assert.equal((await t.call('POST', `/api/onboarding/submissions/${id}/code-review`, { note: '再按一次' })).status, 409, '同一版不重複確認');
    assert.equal((await t.call('POST', `/api/onboarding/submissions/${id}/confirmations`, { note: '' })).status, 409);
    assert.equal((await t.call('POST', `/api/onboarding/submissions/${id}/confirmations`, { note: '核對 Q01～Q07' })).status, 200);
    const ap = await t.call('POST', `/api/onboarding/submissions/${id}/approvals`, { reason: '本機試點發布' });
    assert.equal(ap.status, 200);
    assert.equal((ap.data.submission as { status: string }).status, 'approved');
  } finally { await t.close(); }
});

test('壞提交包整筆拒收，不建立提交也不建置', async () => {
  const t = await setup();
  try {
    await t.login();
    const r = await upload(t.call, validZip([{ name: '.env', data: 'OPENAI_API_KEY=sk-abcdefghijklmnopqrstuvwxyz' }]));
    assert.equal(r.status, 422);
    assert.ok((r.data.issues as unknown[]).length > 0);
    assert.ok(!JSON.stringify(r.data).includes('sk-abcdefghijklmnopqrstuvwxyz'));
    assert.equal((await t.call('GET', '/api/onboarding/submissions')).data.submissions instanceof Array, true);
    assert.equal(((await t.call('GET', '/api/onboarding/submissions')).data.submissions as unknown[]).length, 0);
    assert.equal((await t.call('POST', '/api/onboarding/submissions?department=a&owner=b', Buffer.from('x'), { 'Content-Type': 'text/plain' })).status, 415);
  } finally { await t.close(); }
});

test('失敗不可送交：建置失敗、業務測試失敗、未提供測試、掃描器不可用', async () => {
  for (const [opts, manifest, expectStep, expectStatus] of [
    [{ build: false }, MANIFEST, 'build', 'failed'],
    [{ businessExit: 1 }, MANIFEST, 'business_test', 'failed'],
    [{}, MANIFEST.replace(/test:\n(?: {2}.*\n)+/, ''), 'business_test', 'not_verified'],
    [{ trivy: 'missing' }, MANIFEST, 'scan', 'incomplete'],
    [{ healthy: false }, MANIFEST, 'platform_test', 'failed'],
  ] as [FakeOpts, string, string, string][]) {
    const t = await setup(opts);
    try {
      await t.login();
      const id = ((await upload(t.call, validZip([], manifest))).data.submission as { id: string }).id;
      await t.runQueue();
      const s = (await t.call('GET', `/api/onboarding/submissions/${id}`)).data.submission as Record<string, any>;
      assert.equal(s.steps[expectStep].status, expectStatus, `${expectStep} should be ${expectStatus}`);
      assert.equal(s.status, 'failed');
      assert.equal(s.steps.preview.status, 'skipped');
      assert.equal((await t.call('POST', `/api/onboarding/submissions/${id}/confirmations`, { note: '試圖確認' })).status, 409);
      assert.equal((await t.call('POST', `/api/onboarding/submissions/${id}/retry`)).status, 202);
    } finally { await t.close(); }
  }
});

test('漏洞檢查只記錄不阻擋：有 CRITICAL 標為 warning，不需例外即可核准；掃描器不可用仍阻擋', async () => {
  const t = await setup({ trivy: 'critical' });
  try {
    await t.login();
    const id = ((await upload(t.call, validZip())).data.submission as { id: string }).id;
    await t.runQueue();
    let s = (await t.call('GET', `/api/onboarding/submissions/${id}`)).data.submission as Record<string, any>;
    assert.equal(s.steps.scan.status, 'warning');
    assert.equal(s.steps.scan.summary.counts.CRITICAL, 1);
    assert.deepEqual(s.pendingExceptions, []);
    assert.equal(s.status, 'awaiting_confirmation');
    await t.call('POST', `/api/onboarding/submissions/${id}/code-review`, { note: '已看過程式碼' });
    await t.call('POST', `/api/onboarding/submissions/${id}/confirmations`, { note: '已核對' });
    s = (await t.call('POST', `/api/onboarding/submissions/${id}/approvals`, { reason: '發布' })).data.submission as Record<string, any>;
    assert.equal(s.status, 'approved');
  } finally { await t.close(); }
});

test('新修訂使舊提交失效，舊的確認與核准一併撤銷；同內容重複提交拒收', async () => {
  const t = await setup();
  try {
    await t.login();
    const a = ((await upload(t.call, validZip())).data.submission as { id: string }).id;
    await t.runQueue();
    await t.call('POST', `/api/onboarding/submissions/${a}/code-review`, { note: '已看過程式碼' });
    await t.call('POST', `/api/onboarding/submissions/${a}/confirmations`, { note: '已核對' });
    assert.equal((await upload(t.call, validZip())).status, 422);
    const b = await upload(t.call, validZip([{ name: 'fix.txt', data: 'v2' }]));
    assert.equal(b.status, 201);
    assert.equal((b.data.submission as { revision: number }).revision, 2);
    const old = (await t.call('GET', `/api/onboarding/submissions/${a}`)).data.submission as Record<string, any>;
    assert.equal(old.status, 'superseded');
    assert.ok(old.approvals.every((x: { revoked_at: string | null }) => x.revoked_at));
  } finally { await t.close(); }
});

test('取消執行中的工作；服務重啟時執行中工作標為中斷，不判成功', async () => {
  const t = await setup({ slowBuildMs: 5000 });
  try {
    await t.login();
    const id = ((await upload(t.call, validZip())).data.submission as { id: string }).id;
    const running = t.queue.tick();
    await new Promise((r) => setTimeout(r, 100));
    const job = t.store.get<{ id: string }>('SELECT id FROM jobs WHERE submission_id=?', id)!;
    assert.equal((await t.call('POST', `/api/onboarding/jobs/${job.id}/cancel`)).status, 202);
    await running;
    const s = (await t.call('GET', `/api/onboarding/submissions/${id}`)).data.submission as Record<string, any>;
    assert.equal(s.status, 'cancelled');
    assert.notEqual(s.steps.build.status, 'passed');

    // 模擬重啟：把工作狀態設為 running 後呼叫 markInterrupted
    t.store.run("UPDATE jobs SET status='running' WHERE id=?", job.id);
    t.store.run("UPDATE step_results SET status='running' WHERE job_id=? AND step='build'", job.id);
    assert.equal(t.store.markInterrupted('system'), 1);
    const s2 = (await t.call('GET', `/api/onboarding/submissions/${id}`)).data.submission as Record<string, any>;
    assert.equal(s2.status, 'interrupted');
    assert.equal(s2.steps.build.status, 'interrupted');
  } finally { await t.close(); }
});

test('日誌 API 只回傳遮罩後內容，並提供範本下載', async () => {
  const t = await setup();
  try {
    await t.login();
    const tpl = await t.call('GET', '/api/onboarding/template');
    assert.match(String(tpl.data.text), /schemaVersion: workhub\/v1/);
    const audit = await t.call('GET', '/api/onboarding/audit');
    assert.ok(Array.isArray(audit.data.events));
  } finally { await t.close(); }
});

test('新增工具與提交新版本驗證目標，錯誤 ZIP 不建立工具或取代舊提交', async () => {
  const t = await setup();
  try {
    await t.login();
    const first = await upload(t.call, validZip(), 'department=purchase&owner=Mila&mode=new');
    assert.equal(first.status, 201);
    const duplicate = await upload(t.call, validZip(), 'department=purchase&owner=Mila&mode=new');
    assert.equal(duplicate.status, 422);
    const mismatch = await upload(t.call, validZip(), 'department=purchase&owner=Mila&mode=update&expectedToolId=other-tool');
    assert.equal(mismatch.status, 422);
    const missing = await upload(t.call, validZip(), 'department=purchase&owner=Mila&mode=update');
    assert.equal(missing.status, 422);
    assert.equal(t.store.all('SELECT id FROM submissions').length, 1);
    assert.equal(t.store.get<{ status: string }>('SELECT status FROM submissions')?.status, 'queued');
    const updated = validZip([], MANIFEST.replace('version: 1.0.0', 'version: 1.0.1'));
    const next = await upload(t.call, updated, 'department=purchase&owner=Mila&mode=update&expectedToolId=demo-tool');
    assert.equal(next.status, 201);
    assert.equal(t.store.all('SELECT id FROM tools').length, 1);
    assert.equal(t.store.all('SELECT id FROM submissions').length, 2);
  } finally { await t.close(); }
});

// ── 階段 E：發布、更新、回復與入口 ──────────────────────────────────
async function approvedVersion(t: Awaited<ReturnType<typeof setup>>, version: string, mode = 'new') {
  const zip = validZip([{ name: `v-${version}.txt`, data: version }], MANIFEST.replace('version: 1.0.0', `version: ${version}`));
  const up = await upload(t.call, zip, `department=purchase&owner=Mila&mode=${mode}${mode === 'update' ? '&expectedToolId=demo-tool' : ''}`);
  assert.equal(up.status, 201, JSON.stringify(up.data));
  const id = (up.data.submission as { id: string }).id;
  await t.runQueue();
  await t.call('POST', `/api/onboarding/submissions/${id}/code-review`, { note: '已看過程式碼' });
  assert.equal((await t.call('POST', `/api/onboarding/submissions/${id}/confirmations`, { note: '已核對' })).status, 200);
  assert.equal((await t.call('POST', `/api/onboarding/submissions/${id}/approvals`, { reason: '核准' })).status, 200);
  const sub = (await t.call('GET', `/api/onboarding/submissions/${id}`)).data.submission as Record<string, any>;
  return { id, digest: sub.imageDigest as string };
}
const catalogOf = async (t: Awaited<ReturnType<typeof setup>>) => (await t.call('GET', '/api/onboarding/catalog')).data.tools as Record<string, any>[];

test('發布：未核准不能發布；核准後發布同一份 image，健康檢查通過才出現在入口', async () => {
  const t = await setup();
  try {
    const up = await upload(t.call, validZip(), 'department=purchase&owner=Mila&mode=new');
    const pending = (up.data.submission as { id: string }).id;
    await t.runQueue();
    assert.equal((await t.call('POST', `/api/onboarding/submissions/${pending}/release`)).status, 409);
    await t.call('POST', `/api/onboarding/submissions/${pending}/code-review`, { note: '已看過程式碼' });
    await t.call('POST', `/api/onboarding/submissions/${pending}/confirmations`, { note: '已核對' });
    await t.call('POST', `/api/onboarding/submissions/${pending}/approvals`, { reason: '核准' });
    const digest = ((await t.call('GET', `/api/onboarding/submissions/${pending}`)).data.submission as Record<string, any>).imageDigest;
    assert.equal((await catalogOf(t)).length, 0);
    assert.equal((await t.call('POST', `/api/onboarding/submissions/${pending}/release`)).status, 202);
    assert.equal((await t.call('POST', `/api/onboarding/submissions/${pending}/release`)).status, 409);
    await t.runQueue();
    const cat = await catalogOf(t);
    assert.equal(cat.length, 1);
    assert.equal(cat[0].version, '1.0.0');
    assert.equal(cat[0].healthy, true);
    assert.match(cat[0].url, /^http:\/\/127\.0\.0\.1:187\d\d\/$/);
    const spec = t.rt.running.get('wh-rel-demo-tool')!;
    assert.equal(spec.image, digest);
    assert.equal(spec.restart, true);
    assert.equal(spec.volume, 'wh-rel-demo-tool-data');
    assert.equal(((await t.call('GET', `/api/onboarding/submissions/${pending}`)).data.submission as Record<string, any>).status, 'released');
    assert.equal(t.rt.backups.length, 0);
  } finally { await t.close(); }
});

test('更新：先停止舊版並備份，新版通過後切換；同一個入口埠', async () => {
  const t = await setup();
  try {
    const v1 = await approvedVersion(t, '1.0.0');
    await t.call('POST', `/api/onboarding/submissions/${v1.id}/release`); await t.runQueue();
    const port1 = (await catalogOf(t))[0].url;
    const v2 = await approvedVersion(t, '1.0.1', 'update');
    await t.call('POST', `/api/onboarding/submissions/${v2.id}/release`); await t.runQueue();
    const cat = await catalogOf(t);
    assert.equal(cat[0].version, '1.0.1');
    assert.equal(cat[0].url, port1);
    assert.deepEqual(t.rt.stopped, ['wh-rel-demo-tool']);
    assert.equal(t.rt.backups.length, 1);
    const hist = (await t.call('GET', '/api/onboarding/releases?toolId=demo-tool')).data.releases as Record<string, any>[];
    assert.deepEqual(hist.map((r) => [r.version, r.status]), [['1.0.1', 'active'], ['1.0.0', 'superseded']]);
    assert.ok(hist[0].detail.backupBefore);
  } finally { await t.close(); }
});

test('更新失敗：還原備份並恢復前一版，入口仍是前一版；首次發布失敗則入口不可用', async () => {
  const t = await setup();
  try {
    const v1 = await approvedVersion(t, '1.0.0');
    await t.call('POST', `/api/onboarding/submissions/${v1.id}/release`); await t.runQueue();
    const v2 = await approvedVersion(t, '1.0.1', 'update');
    t.rt.opts.badImages!.add(v2.digest);
    await t.call('POST', `/api/onboarding/submissions/${v2.id}/release`); await t.runQueue();
    const cat = await catalogOf(t);
    assert.equal(cat[0].version, '1.0.0');
    assert.equal(cat[0].healthy, true);
    assert.equal(t.rt.restores.length, 1);
    assert.equal(t.rt.running.get('wh-rel-demo-tool')!.image, v1.digest);
    const hist = (await t.call('GET', '/api/onboarding/releases?toolId=demo-tool')).data.releases as Record<string, any>[];
    assert.equal(hist[0].status, 'failed');
    assert.match(hist[0].detail.error, /健康檢查/);
    assert.equal(((await t.call('GET', `/api/onboarding/submissions/${v2.id}`)).data.submission as Record<string, any>).status, 'approved');
  } finally { await t.close(); }
  const t2 = await setup();
  try {
    const v1 = await approvedVersion(t2, '1.0.0');
    t2.rt.opts.badImages!.add(v1.digest);
    await t2.call('POST', `/api/onboarding/submissions/${v1.id}/release`); await t2.runQueue();
    assert.equal((await catalogOf(t2)).length, 0);
    const hist = (await t2.call('GET', '/api/onboarding/releases')).data.releases as Record<string, any>[];
    assert.equal(hist[0].status, 'failed');
  } finally { await t2.close(); }
});

test('回復：需選資料處理方式與原因；保留資料回到前一版；還原則用發布前備份', async () => {
  const t = await setup();
  try {
    const v1 = await approvedVersion(t, '1.0.0');
    await t.call('POST', `/api/onboarding/submissions/${v1.id}/release`); await t.runQueue();
    assert.equal((await t.call('POST', '/api/onboarding/tools/demo-tool/rollback', { reason: '測試', dataMode: 'keep' })).status, 409);
    const v2 = await approvedVersion(t, '1.0.1', 'update');
    await t.call('POST', `/api/onboarding/submissions/${v2.id}/release`); await t.runQueue();
    assert.equal((await t.call('POST', '/api/onboarding/tools/demo-tool/rollback', { reason: '測試' })).status, 409);
    assert.equal((await t.call('POST', '/api/onboarding/tools/demo-tool/rollback', { dataMode: 'keep' })).status, 409);
    assert.equal((await t.call('POST', '/api/onboarding/tools/demo-tool/rollback', { reason: '新版匯出欄位錯誤', dataMode: 'restore' })).status, 202);
    await t.runQueue();
    const cat = await catalogOf(t);
    assert.equal(cat[0].version, '1.0.0');
    assert.equal(t.rt.restores.length, 1);
    const hist = (await t.call('GET', '/api/onboarding/releases?toolId=demo-tool')).data.releases as Record<string, any>[];
    assert.deepEqual(hist.map((r) => r.status), ['active', 'rolled_back', 'superseded']);
    assert.equal(hist[0].detail.kind, 'rollback');
  } finally { await t.close(); }
});

test('重新上線：回復後可再把較新的版本上線，需原因、不能選目前版本，部署前會備份', async () => {
  const t = await setup();
  try {
    const v1 = await approvedVersion(t, '1.0.0');
    await t.call('POST', `/api/onboarding/submissions/${v1.id}/release`); await t.runQueue();
    const v2 = await approvedVersion(t, '1.0.1', 'update');
    await t.call('POST', `/api/onboarding/submissions/${v2.id}/release`); await t.runQueue();
    await t.call('POST', '/api/onboarding/tools/demo-tool/rollback', { reason: '測試回復', dataMode: 'keep' }); await t.runQueue();
    let hist = (await t.call('GET', '/api/onboarding/releases?toolId=demo-tool')).data.releases as Record<string, any>[];
    const v2rel = hist.find((r) => r.version === '1.0.1')!;
    const v1rel = hist.find((r) => r.version === '1.0.0' && r.status === 'superseded')!;
    assert.equal((await t.call('POST', '/api/onboarding/tools/demo-tool/redeploy', { releaseId: v2rel.id })).status, 409);
    assert.equal((await t.call('POST', '/api/onboarding/tools/demo-tool/redeploy', { releaseId: v1rel.id, reason: '同版本' })).status, 409);
    assert.equal((await t.call('POST', '/api/onboarding/tools/demo-tool/redeploy', { releaseId: v2rel.id, reason: '回復測試完成，回到新版' })).status, 202);
    await t.runQueue();
    assert.equal((await catalogOf(t))[0].version, '1.0.1');
    hist = (await t.call('GET', '/api/onboarding/releases?toolId=demo-tool')).data.releases as Record<string, any>[];
    assert.equal(hist[0].status, 'active');
    assert.equal(hist[0].detail.kind, 'redeploy');
    assert.ok(hist[0].detail.backupBefore);
    assert.equal(hist[1].status, 'superseded');
    // 重新上線後仍可再回復到前一個上線版本
    assert.equal((await t.call('POST', '/api/onboarding/tools/demo-tool/rollback', { reason: '再測一次', dataMode: 'keep' })).status, 202);
    await t.runQueue();
    assert.equal((await catalogOf(t))[0].version, '1.0.0');
  } finally { await t.close(); }
});

test('下架與重新上架：停止容器、入口顯示下架、資料與埠號保留；重新上架回到同一網址', async () => {
  const t = await setup();
  try {
    const v1 = await approvedVersion(t, '1.0.0');
    await t.call('POST', `/api/onboarding/submissions/${v1.id}/release`); await t.runQueue();
    const url = (await catalogOf(t))[0].url;
    assert.equal((await t.call('POST', '/api/onboarding/tools/demo-tool/online', { reason: '不在下架狀態' })).status, 409);
    assert.equal((await t.call('POST', '/api/onboarding/tools/demo-tool/offline', {})).status, 409);
    assert.equal((await t.call('POST', '/api/onboarding/tools/demo-tool/offline', { reason: '供應商格式調整，暫停使用' })).status, 200);
    assert.ok(t.rt.stopped.includes('wh-rel-demo-tool'));
    let cat = await catalogOf(t);
    assert.equal(cat[0].offline, true);
    assert.equal(cat[0].url, null);
    assert.equal(cat[0].healthy, false);
    assert.equal((await t.call('POST', '/api/onboarding/tools/demo-tool/rollback', { reason: 'x', dataMode: 'keep' })).status, 409);
    assert.equal((await t.call('POST', '/api/onboarding/tools/demo-tool/online', { reason: '格式調整完成' })).status, 202);
    await t.runQueue();
    cat = await catalogOf(t);
    assert.equal(cat[0].offline, false);
    assert.equal(cat[0].url, url);
    assert.equal(cat[0].version, '1.0.0');
    const hist = (await t.call('GET', '/api/onboarding/releases?toolId=demo-tool')).data.releases as Record<string, any>[];
    assert.deepEqual(hist.map((r) => r.status), ['active', 'superseded']);
    assert.equal(hist[1].detail.offline.reason, '供應商格式調整，暫停使用');
  } finally { await t.close(); }
});

const AI_MANIFEST = MANIFEST.replace('  optional: []\nmodel:\n  uses: false', `  optional:
    - name: OPENAI_BASE_URL
      purpose: 端點
      secret: false
    - name: OPENAI_API_KEY
      purpose: 憑證
      secret: true
    - name: OPENAI_MODEL
      purpose: 模型
      secret: false
model:
  uses: true
  provider: openai-compatible
  approvedEndpoint: wisely-5090
  fallback: none`);

test('模型轉接：工具只拿到轉接網址與工具專用通行碼、跑在隔離網路；真正金鑰只給轉接服務；業務測試仍斷網', async () => {
  const t = await setup();
  try {
    assert.ok(AI_MANIFEST.includes('uses: true'));
    // 尚未設定端點：預覽照常啟動，但沒有模型設定
    await upload(t.call, validZip([], AI_MANIFEST)); await t.runQueue();
    let pv = t.rt.started.find((s) => s.labels['workhub.kind'] === 'preview')!;
    assert.deepEqual(pv.env, {});
    assert.equal(pv.network, 'wh-net-demo-tool');
    assert.equal(t.rt.networks.get('wh-net-demo-tool'), true);
    assert.equal(t.rt.relays.length, 0);
    const real = 'real-upstream-key-abcdefghijklmnop';
    t.secrets.set('wisely-5090', { OPENAI_BASE_URL: 'https://llm.example/v1', OPENAI_API_KEY: real, OPENAI_MODEL: 'vision-model' }, ['OPENAI_API_KEY']);
    const v2 = (await upload(t.call, validZip([], AI_MANIFEST.replace('version: 1.0.0', 'version: 1.0.1')), 'department=purchase&owner=Mila&filename=demo.zip&mode=update&expectedToolId=demo-tool')).data.submission as Record<string, any>;
    assert.ok(v2, 'update upload accepted');
    await t.runQueue();
    pv = t.rt.started.filter((s) => s.labels['workhub.kind'] === 'preview').at(-1)!;
    assert.equal(pv.env.OPENAI_BASE_URL, 'http://llm-relay:8080/v1');
    assert.match(pv.env.OPENAI_API_KEY, /^whr_/);
    assert.equal(pv.env.OPENAI_MODEL, 'vision-model');
    assert.ok(!Object.values(pv.env).includes(real));
    assert.equal(pv.network, 'wh-net-demo-tool');
    const relay = t.rt.relays.at(-1)!;
    assert.equal(relay.env.RELAY_UPSTREAM_KEY, real);
    assert.deepEqual(JSON.parse(relay.env.RELAY_TOKENS), { [pv.env.OPENAI_API_KEY]: 'demo-tool' });
    assert.deepEqual(relay.networks, ['wh-net-demo-tool']);
    const bt = t.rt.ran.at(-1)!;
    assert.equal(bt.network, 'none');
    assert.deepEqual(bt.env, {});
    const pt = t.rt.started.filter((s) => s.labels['workhub.kind'] === 'platform-test').at(-1)!;
    assert.deepEqual(pt.env, {});
    assert.equal(pt.network, 'wh-net-demo-tool');
    // 日誌遮罩包含工具通行碼
    assert.ok(t.secrets.allSecretValues().includes(pv.env.OPENAI_API_KEY));
  } finally { await t.close(); }
});

test('維運：維護模式只關入口不停容器；重新啟動經健康檢查；日誌遮罩通行碼；事件列在近期事件', async () => {
  const t = await setup();
  try {
    assert.equal((await t.call('POST', '/api/onboarding/tools/demo-tool/maintenance', { on: true, reason: 'x' })).status, 409);
    const v1 = await approvedVersion(t, '1.0.0');
    await t.call('POST', `/api/onboarding/submissions/${v1.id}/release`); await t.runQueue();
    assert.equal((await t.call('POST', '/api/onboarding/tools/demo-tool/maintenance', { on: true })).status, 409);
    assert.equal((await t.call('POST', '/api/onboarding/tools/demo-tool/maintenance', { on: true, reason: '資料庫連線逾時' })).status, 200);
    let cat = await catalogOf(t);
    assert.equal(cat[0].maintenance.reason, '資料庫連線逾時');
    assert.equal(cat[0].healthy, true, '容器照跑');
    assert.ok(!t.rt.stopped.includes('wh-rel-demo-tool'));
    assert.equal((await t.call('POST', '/api/onboarding/tools/demo-tool/maintenance', { on: true, reason: '重複' })).status, 409);
    const rs = await t.call('POST', '/api/onboarding/tools/demo-tool/restart', {});
    assert.equal(rs.status, 200); assert.equal(rs.data.ok, true);
    assert.deepEqual(t.rt.restarted, ['wh-rel-demo-tool']);
    const logs = await t.call('GET', '/api/onboarding/tools/demo-tool/logs');
    assert.equal(logs.status, 200);
    assert.ok(String(logs.data.text).includes('fake log'));
    assert.ok(!String(logs.data.text).includes('whr_secret_token_value'), '日誌遮罩');
    assert.equal((await t.call('POST', '/api/onboarding/tools/demo-tool/maintenance', { on: false })).status, 200);
    cat = await catalogOf(t);
    assert.equal(cat[0].maintenance, null);
    const ev = (await t.call('GET', '/api/onboarding/ops/events')).data.events as Record<string, any>[];
    assert.deepEqual(ev.slice(0, 4).map((e) => e.label), ['恢復服務', '重新啟動完成，健康檢查通過', '重新啟動', '進入維護']);
    assert.equal(ev[3].toolName, '示範工具'); assert.equal(ev[3].bad, true);
    assert.ok(ev.some((e) => e.label === '發布成功' && e.toolId === 'demo-tool'));
  } finally { await t.close(); }
});

test('上架資料包：一個 ZIP 內含 SOP、範本、預檢工具與給 AI 的指令，中文檔名正確', async () => {
  const t = await setup();
  try {
    const r = await fetch(`${t.base}/api/onboarding/kit`, { headers: { 'X-WorkHub-Proxy-Token': 'test-proxy-token-0001' } });
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('content-type'), 'application/zip');
    const buf = Buffer.from(await r.arrayBuffer());
    const { readCentralDirectory, readEntry } = await import('../src/zip-intake.ts');
    const { entries, issues } = readCentralDirectory(buf, t.cfg);
    assert.deepEqual(issues, []);
    const names = entries.map((e) => e.name).sort();
    assert.deepEqual(names, ['workhub-kit/WorkHub工具上架SOP.md', 'workhub-kit/workhub-check.mjs', 'workhub-kit/workhub.yaml', 'workhub-kit/給AI的打包指令.txt'].sort());
    const sop = readEntry(buf, entries.find((e) => e.name.endsWith('.md'))!).toString('utf8');
    assert.match(sop, /## 12\. 交給 AI agent 打包/);
    assert.match(readEntry(buf, entries.find((e) => e.name.endsWith('workhub.yaml'))!).toString('utf8'), /schemaVersion: workhub\/v1/);
    const prompt = readEntry(buf, entries.find((e) => e.name.endsWith('.txt'))!).toString('utf8');
    assert.match(prompt, /第一次上架/); assert.match(prompt, /wisely-5090/); assert.ok(!prompt.includes('{{'));
    // 版更資料包：帶入 tool.id、上線版本與建議版本
    const v1 = await approvedVersion(t, '1.0.0');
    await t.call('POST', `/api/onboarding/submissions/${v1.id}/release`); await t.runQueue();
    const r2 = await fetch(`${t.base}/api/onboarding/kit?toolId=demo-tool`, { headers: { 'X-WorkHub-Proxy-Token': 'test-proxy-token-0001' } });
    assert.equal(r2.status, 200);
    const buf2 = Buffer.from(await r2.arrayBuffer());
    const e2 = readCentralDirectory(buf2, t.cfg).entries;
    const p2 = readEntry(buf2, e2.find((e) => e.name.endsWith('.txt'))!).toString('utf8');
    assert.match(p2, /tool\.id：demo-tool/); assert.match(p2, /目前上線版本：1\.0\.0/); assert.match(p2, /建議：1\.0\.1/);
    assert.match(readEntry(buf2, e2.find((e) => e.name.endsWith('workhub.yaml'))!).toString('utf8'), /id: demo-tool[\s\S]*version: 1\.0\.1/);
    assert.equal((await fetch(`${t.base}/api/onboarding/kit?toolId=nope`, { headers: { 'X-WorkHub-Proxy-Token': 'test-proxy-token-0001' } })).status, 409);
  } finally { await t.close(); }
});

test('工具名稱以平台表單為準：新增時表單優先、未填才用 workhub.yaml；更新不覆蓋；可在平台改名並留紀錄', async () => {
  const t = await setup();
  try {
    const noName = MANIFEST.replace('  name: 示範工具\n', '');
    const r0 = await upload(t.call, validZip([], noName));
    assert.equal(r0.status, 422);
    assert.ok((r0.data.issues as any[]).some((i) => i.field === 'name'));
    const r1 = await upload(t.call, validZip([], noName), 'department=purchase&owner=Mila&filename=demo.zip&name=' + encodeURIComponent('出貨查詢'));
    assert.equal(r1.status, 201);
    assert.equal((r1.data.submission as any).toolName, '出貨查詢');
    await t.runQueue();
    const r2 = await upload(t.call, validZip([], MANIFEST.replace('version: 1.0.0', 'version: 1.0.1')), 'department=purchase&owner=Mila&filename=demo.zip&mode=update&expectedToolId=demo-tool');
    assert.equal(r2.status, 201);
    assert.equal((r2.data.submission as any).toolName, '出貨查詢', 'workhub.yaml 的 tool.name 不覆蓋平台名稱');
    assert.equal((await t.call('POST', '/api/onboarding/tools/demo-tool/name', { name: '  ' })).status, 409);
    const rn = await t.call('POST', '/api/onboarding/tools/demo-tool/name', { name: '出貨進度查詢' });
    assert.equal(rn.status, 200);
    const sub = (await t.call('GET', `/api/onboarding/submissions/${(r2.data.submission as any).id}`)).data.submission as any;
    assert.equal(sub.toolName, '出貨進度查詢');
    const audit = t.store.all<{ action: string }>("SELECT action FROM audit_events WHERE action='tool.renamed'");
    assert.equal(audit.length, 1);
  } finally { await t.close(); }
});

test('入口事件：點擊與阻擋分開記錄，同一事件重送不重複計數', async () => {
  const t = await setup();
  try {
    const v1 = await approvedVersion(t, '1.0.0');
    await t.call('POST', `/api/onboarding/submissions/${v1.id}/release`); await t.runQueue();
    const e = { clientEventId: 'evt_0123456789', toolId: 'demo-tool', kind: 'click' };
    assert.equal((await t.call('POST', '/api/onboarding/entry-events', e)).data.recorded, true);
    assert.equal((await t.call('POST', '/api/onboarding/entry-events', e)).data.recorded, false);
    assert.equal((await t.call('POST', '/api/onboarding/entry-events', { ...e, clientEventId: 'evt_blocked_01', kind: 'blocked', reason: '服務未回應' })).data.recorded, true);
    assert.equal((await t.call('POST', '/api/onboarding/entry-events', { ...e, clientEventId: 'evt_x_0000001', kind: 'open' })).status, 409);
    const events = (await t.call('GET', '/api/onboarding/entry-events?toolId=demo-tool')).data.events as Record<string, any>[];
    assert.deepEqual(events.map((x) => x.kind).sort(), ['blocked', 'click']);
    assert.equal(events[0].version, '1.0.0');
  } finally { await t.close(); }
});

test('取消提交：測試失敗時撤回，撤銷確認並關閉預覽；已發布版本不能取消；撤回後可重新上傳同一份 ZIP', async () => {
  const t = await setup();
  try {
    const up = await upload(t.call, validZip(), 'department=purchase&owner=Mila&mode=new');
    const id = (up.data.submission as { id: string }).id;
    await t.runQueue();
    await t.call('POST', `/api/onboarding/submissions/${id}/code-review`, { note: '已看過程式碼' });
    await t.call('POST', `/api/onboarding/submissions/${id}/confirmations`, { note: '已核對' });
    assert.equal((await t.call('POST', `/api/onboarding/submissions/${id}/withdraw`, { reason: '  ' })).status, 409);
    const w = await t.call('POST', `/api/onboarding/submissions/${id}/withdraw`, { reason: '匯出比較表失敗' });
    assert.equal(w.status, 200);
    const s = w.data.submission as Record<string, any>;
    assert.equal(s.status, 'withdrawn');
    assert.equal(s.previewUrl, null);
    assert.ok(s.approvals.every((a: { revoked_at: string | null }) => a.revoked_at));
    assert.ok(t.rt.removed.includes('wh-preview-demo-tool'));
    assert.equal((await t.call('POST', `/api/onboarding/submissions/${id}/confirmations`, { note: '再確認' })).status, 409);
    assert.equal((await upload(t.call, validZip(), 'department=purchase&owner=Mila&mode=update&expectedToolId=demo-tool')).status, 201);
    await t.runQueue();
    const v = await approvedVersion(t, '1.0.1', 'update');
    await t.call('POST', `/api/onboarding/submissions/${v.id}/release`); await t.runQueue();
    assert.equal((await t.call('POST', `/api/onboarding/submissions/${v.id}/withdraw`, { reason: '測試' })).status, 409);
  } finally { await t.close(); }
});

// ── 試用／公開（DEC-032） ──────────────────────────────────────────
test('試用與公開：新工具發布後是試用中；開發者試用通過、AI Team 公開後才公開；可取消公開', async () => {
  const t = await setup();
  try {
    const v1 = await approvedVersion(t, '1.0.0');
    assert.equal((await t.call('POST', `/api/onboarding/submissions/${v1.id}/release`)).status, 202);
    await t.runQueue();
    let cat = (await catalogOf(t))[0];
    assert.equal(cat.visibility, 'trial');
    assert.equal(cat.trialPassed, false);
    assert.equal(cat.trial, null);
    // 未按試用通過不能公開；公開需說明
    assert.equal((await t.call('POST', '/api/onboarding/tools/demo-tool/publish', { note: '試用 OK' })).status, 409);
    assert.equal((await t.call('POST', '/api/onboarding/tools/demo-tool/trial-passed', {})).status, 200);
    assert.equal((await t.call('POST', '/api/onboarding/tools/demo-tool/trial-passed', {})).status, 409, '同一版不重複按');
    assert.equal((await t.call('POST', '/api/onboarding/tools/demo-tool/publish', { note: ' ' })).status, 409);
    assert.equal((await t.call('POST', '/api/onboarding/tools/demo-tool/publish', { note: '試用 OK' })).status, 200);
    cat = (await catalogOf(t))[0];
    assert.equal(cat.visibility, 'public');
    // 試用中點擊另外標記
    await t.call('POST', '/api/onboarding/entry-events', { clientEventId: 'evt_public01', toolId: 'demo-tool', kind: 'click' });
    assert.equal((await t.call('POST', '/api/onboarding/tools/demo-tool/unpublish', { reason: '' })).status, 409);
    assert.equal((await t.call('POST', '/api/onboarding/tools/demo-tool/unpublish', { reason: '發現問題' })).status, 200);
    assert.equal((await catalogOf(t))[0].visibility, 'trial');
    await t.call('POST', '/api/onboarding/entry-events', { clientEventId: 'evt_trial0001', toolId: 'demo-tool', kind: 'click' });
    const ev = (await t.call('GET', '/api/onboarding/entry-events?toolId=demo-tool')).data.events as Record<string, any>[];
    assert.deepEqual(ev.map((e) => e.trial), [1, 0]);
    // 尚未公開的工具版更：直接更新，仍是試用中，需重新試用通過
    const v2 = await approvedVersion(t, '1.0.1', 'update');
    await t.call('POST', `/api/onboarding/submissions/${v2.id}/release`); await t.runQueue();
    cat = (await catalogOf(t))[0];
    assert.equal(cat.version, '1.0.1');
    assert.equal(cat.visibility, 'trial');
    assert.equal(cat.trialPassed, false);
  } finally { await t.close(); }
});

test('已公開工具的版更：新版並行試用（空白資料、另一個容器），公開時才走更新流程並移除試用版；可結束試用', async () => {
  const t = await setup();
  try {
    const v1 = await approvedVersion(t, '1.0.0');
    await t.call('POST', `/api/onboarding/submissions/${v1.id}/release`); await t.runQueue();
    await t.call('POST', '/api/onboarding/tools/demo-tool/trial-passed', {});
    await t.call('POST', '/api/onboarding/tools/demo-tool/publish', { note: '首版公開' });
    const live = t.rt.running.get('wh-rel-demo-tool')!;
    // 新版 → 試用版
    const v2 = await approvedVersion(t, '1.1.0', 'update');
    assert.equal((await t.call('POST', `/api/onboarding/submissions/${v2.id}/release`)).status, 202);
    await t.runQueue();
    const trial = t.rt.running.get('wh-trial-demo-tool')!;
    assert.ok(trial, '試用版容器在跑');
    assert.equal(trial.image, v2.digest);
    assert.equal(trial.volume, 'wh-trial-demo-tool-data');
    assert.notEqual(trial.hostPort, live.hostPort);
    assert.equal(t.rt.running.get('wh-rel-demo-tool')!.image, v1.digest, '正式版本不受影響');
    assert.equal(t.rt.stopped.includes('wh-rel-demo-tool'), false, '部署試用版不停止正式版本');
    assert.equal(t.rt.restores.length, 0, '試用版從空白資料開始，不複製正式資料');
    assert.equal(t.rt.backups.length, 0, '不備份正式資料給試用版');
    assert.ok(t.rt.removed.includes('wh-trial-demo-tool-data'), '先清空試用資料卷');
    let cat = (await catalogOf(t))[0];
    assert.equal(cat.visibility, 'public');
    assert.equal(cat.version, '1.0.0');
    assert.equal(cat.trial.version, '1.1.0');
    assert.equal(cat.trial.passed, false);
    assert.match(cat.trial.url, /^http:\/\/127\.0\.0\.1:187\d\d\/$/);
    assert.equal(((await t.call('GET', `/api/onboarding/submissions/${v2.id}`)).data.submission as Record<string, any>).status, 'trial');
    // 試用中不能再上傳新版本
    const blocked = await upload(t.call, validZip([{ name: 'v.txt', data: '1.2.0' }], MANIFEST.replace('version: 1.0.0', 'version: 1.2.0')), 'department=purchase&owner=Mila&mode=update&expectedToolId=demo-tool');
    assert.equal(blocked.status, 422);
    assert.match(JSON.stringify(blocked.data), /試用中/);
    // 公開新版
    assert.equal((await t.call('POST', '/api/onboarding/tools/demo-tool/publish', { note: '試用 OK' })).status, 409, '需先試用通過');
    await t.call('POST', '/api/onboarding/tools/demo-tool/trial-passed', { note: '主要功能正常' });
    assert.equal((await t.call('POST', '/api/onboarding/tools/demo-tool/publish', { note: '試用 OK' })).status, 202);
    await t.runQueue();
    cat = (await catalogOf(t))[0];
    assert.equal(cat.version, '1.1.0');
    assert.equal(cat.trial, null);
    assert.equal(cat.visibility, 'public');
    assert.equal(t.rt.running.get('wh-rel-demo-tool')!.image, v2.digest);
    assert.equal(t.rt.running.get('wh-rel-demo-tool')!.hostPort, live.hostPort, '入口網址不變');
    assert.equal(t.rt.running.has('wh-trial-demo-tool'), false);
    assert.ok(t.rt.removed.includes('wh-trial-demo-tool-data'));
    assert.equal(t.rt.backups.length, 1, '公開時照常先備份正式資料');
    const hist = (await t.call('GET', '/api/onboarding/releases?toolId=demo-tool')).data.releases as Record<string, any>[];
    assert.ok(hist.some((h) => h.status === 'trial_ended' && h.detail.ended.promotedTo));
    // 再一版：結束試用 → 捨棄試用版，提交改為已取消，正式版本不變
    const v3 = await approvedVersion(t, '1.2.0', 'update');
    await t.call('POST', `/api/onboarding/submissions/${v3.id}/release`); await t.runQueue();
    assert.ok(t.rt.running.has('wh-trial-demo-tool'));
    assert.equal((await t.call('POST', '/api/onboarding/tools/demo-tool/end-trial', { reason: '' })).status, 409);
    assert.equal((await t.call('POST', '/api/onboarding/tools/demo-tool/end-trial', { reason: '匯出有誤' })).status, 200);
    assert.equal(t.rt.running.has('wh-trial-demo-tool'), false);
    assert.equal(((await t.call('GET', `/api/onboarding/submissions/${v3.id}`)).data.submission as Record<string, any>).status, 'withdrawn');
    cat = (await catalogOf(t))[0];
    assert.equal(cat.version, '1.1.0');
    assert.equal(cat.trial, null);
  } finally { await t.close(); }
});

test('封存：停止所有容器、從入口與管理頁移除，資料卷與紀錄保留', async () => {
  const t = await setup();
  try {
    const v1 = await approvedVersion(t, '1.0.0');
    await t.call('POST', `/api/onboarding/submissions/${v1.id}/release`); await t.runQueue();
    assert.equal((await catalogOf(t)).length, 1);
    assert.equal((await t.call('POST', '/api/onboarding/tools/demo-tool/archive', { reason: '' })).status, 409);
    assert.equal((await t.call('POST', '/api/onboarding/tools/demo-tool/archive', { reason: '測試用工具' })).status, 200);
    assert.equal((await t.call('POST', '/api/onboarding/tools/demo-tool/archive', { reason: '再一次' })).status, 409);
    assert.equal(t.rt.running.has('wh-rel-demo-tool'), false);
    assert.ok(!t.rt.removed.includes('wh-rel-demo-tool-data'), '資料卷保留');
    assert.equal((await catalogOf(t)).length, 0);
    assert.equal(((await t.call('GET', '/api/onboarding/releases')).data.releases as unknown[]).length, 0);
    assert.equal(((await t.call('GET', '/api/onboarding/submissions')).data.submissions as unknown[]).length, 0);
    assert.equal(((await t.call('GET', '/api/onboarding/tools')).data.tools as unknown[]).length, 0);
    assert.equal(t.store.get<{ n: number }>("SELECT COUNT(*) AS n FROM submissions WHERE tool_id='demo-tool'")!.n, 1, '紀錄保留');
  } finally { await t.close(); }
});

test('測試未通過：未公開工具記錄結果、不能公開、可重新測試後通過；並行試用版自動結束試用', async () => {
  const t = await setup();
  try {
    const v1 = await approvedVersion(t, '1.0.0');
    await t.call('POST', `/api/onboarding/submissions/${v1.id}/release`); await t.runQueue();
    assert.equal((await t.call('POST', '/api/onboarding/tools/demo-tool/trial-failed', { reason: ' ' })).status, 409, '需填原因');
    const f = await t.call('POST', '/api/onboarding/tools/demo-tool/trial-failed', { reason: '匯出檔案欄位錯位' });
    assert.equal(f.status, 200);
    assert.equal((f.data as Record<string, any>).ended, false);
    let cat = (await catalogOf(t))[0];
    assert.equal(cat.visibility, 'trial');
    assert.equal(cat.trialResult.result, 'failed');
    assert.equal(cat.trialResult.note, '匯出檔案欄位錯位');
    assert.equal((await t.call('POST', '/api/onboarding/tools/demo-tool/publish', { note: '公開' })).status, 409, '未通過不能公開');
    assert.equal((await t.call('POST', '/api/onboarding/tools/demo-tool/trial-passed', { note: '修正設定後正常' })).status, 200);
    cat = (await catalogOf(t))[0];
    assert.equal(cat.trialResult.result, 'passed');
    assert.equal((await t.call('POST', '/api/onboarding/tools/demo-tool/publish', { note: '公開' })).status, 200);
    const v2 = await approvedVersion(t, '1.1.0', 'update');
    await t.call('POST', `/api/onboarding/submissions/${v2.id}/release`); await t.runQueue();
    assert.ok(t.rt.running.has('wh-trial-demo-tool'));
    const f2 = await t.call('POST', '/api/onboarding/tools/demo-tool/trial-failed', { reason: '新功能無法使用' });
    assert.equal((f2.data as Record<string, any>).ended, true);
    assert.equal(t.rt.running.has('wh-trial-demo-tool'), false);
    assert.equal(((await t.call('GET', `/api/onboarding/submissions/${v2.id}`)).data.submission as Record<string, any>).status, 'withdrawn');
    cat = (await catalogOf(t))[0];
    assert.equal(cat.version, '1.0.0');
    assert.equal(cat.trial, null);
    const hist = (await t.call('GET', '/api/onboarding/releases?toolId=demo-tool')).data.releases as Record<string, any>[];
    assert.ok(hist.some((h) => h.status === 'trial_ended' && /測試未通過/.test(h.detail.ended.reason)));
  } finally { await t.close(); }
});

// ── URL 上架（PRD §10） ─────────────────────────────────────────────
const urlForm = (over: Record<string, unknown> = {}) => ({ mode: 'new', name: 'OpenWebUI', department: 'shared', owner: 'Mila', url: 'https://chat.example.com/', description: '公司 AI 問答', usesAi: true, aiConfirmed: true, guide: '', ...over });

test('URL 上架：表單檢查、網址檢查不適用的步驟標示不適用、核准 → 試用 → 公開；圖示只能從內建清單選', async () => {
  const t = await setup();
  try {
    // 表單檢查
    const bad = await t.call('POST', '/api/onboarding/submissions/url', urlForm({ url: 'ftp://x', description: '', usesAi: true, aiConfirmed: false }));
    assert.equal(bad.status, 422);
    const fields = (bad.data.issues as { field: string }[]).map((i) => i.field);
    assert.ok(fields.includes('url') && fields.includes('description') && fields.includes('aiConfirmed'));
    assert.equal((await t.call('POST', '/api/onboarding/submissions/url', urlForm({ url: 'https://user:pw@chat.example.com/' }))).status, 422, '網址不可帶帳密');
    // 送審 → 網址檢查
    const up = await t.call('POST', '/api/onboarding/submissions/url', urlForm());
    assert.equal(up.status, 201);
    const sub0 = up.data.submission as Record<string, any>;
    assert.equal(sub0.kind, 'url');
    await t.runQueue();
    let sub = (await t.call('GET', `/api/onboarding/submissions/${sub0.id}`)).data.submission as Record<string, any>;
    assert.equal(sub.status, 'awaiting_approval', 'URL 工具不需開發者確認測試，檢查完直接待核准');
    assert.equal(sub.steps.platform_test.status, 'passed');
    assert.equal(sub.steps.build.status, 'not_applicable');
    assert.equal(sub.steps.code_review.status, 'not_applicable');
    assert.deepEqual(sub.releaseBlockers, []);
    assert.deepEqual(t.rt.urlChecks, ['https://chat.example.com/']);
    // 核准 → 發布 → 試用中（不啟動容器）
    assert.equal((await t.call('POST', `/api/onboarding/submissions/${sub0.id}/approvals`, { reason: '核准' })).status, 200);
    assert.equal((await t.call('POST', `/api/onboarding/submissions/${sub0.id}/release`)).status, 202);
    await t.runQueue();
    let cat = (await catalogOf(t)).find((c) => c.toolId === sub0.toolId)!;
    assert.equal(cat.kind, 'url');
    assert.equal(cat.url, 'https://chat.example.com/');
    assert.equal(cat.healthy, true);
    assert.equal(cat.visibility, 'trial');
    assert.equal(t.rt.started.length, 0, 'URL 工具不啟動容器');
    await t.call('POST', `/api/onboarding/tools/${sub0.toolId}/trial-passed`, {});
    assert.equal((await t.call('POST', `/api/onboarding/tools/${sub0.toolId}/publish`, { note: '公開' })).status, 200);
    // 重新啟動、日誌不適用
    assert.equal((await t.call('POST', `/api/onboarding/tools/${sub0.toolId}/restart`, { reason: 'x' })).status, 409);
    // 修改網址 → 已公開工具：新網址以試用入口並行，公開後才切換
    const same = await t.call('POST', '/api/onboarding/submissions/url', urlForm({ mode: 'update', toolId: sub0.toolId }));
    assert.equal(same.status, 422, '設定沒變更不需送審');
    const up2 = await t.call('POST', '/api/onboarding/submissions/url', urlForm({ mode: 'update', toolId: sub0.toolId, url: 'https://chat2.example.com/' }));
    assert.equal(up2.status, 201);
    const id2 = (up2.data.submission as { id: string }).id;
    await t.runQueue();
    await t.call('POST', `/api/onboarding/submissions/${id2}/approvals`, { reason: '核准新網址' });
    await t.call('POST', `/api/onboarding/submissions/${id2}/release`); await t.runQueue();
    cat = (await catalogOf(t)).find((c) => c.toolId === sub0.toolId)!;
    assert.equal(cat.url, 'https://chat.example.com/', '一般使用者仍用舊網址');
    assert.equal(cat.trial.url, 'https://chat2.example.com/');
    await t.call('POST', `/api/onboarding/tools/${sub0.toolId}/trial-passed`, {});
    assert.equal((await t.call('POST', `/api/onboarding/tools/${sub0.toolId}/publish`, { note: '公開新網址' })).status, 202);
    await t.runQueue();
    cat = (await catalogOf(t)).find((c) => c.toolId === sub0.toolId)!;
    assert.equal(cat.url, 'https://chat2.example.com/');
    assert.equal(cat.trial, null);
    // 圖示
    assert.equal((await t.call('POST', `/api/onboarding/tools/${sub0.toolId}/icon`, { symbol: 9, color: 'blue' })).status, 409);
    assert.equal((await t.call('POST', `/api/onboarding/tools/${sub0.toolId}/icon`, { symbol: 2, color: 'black' })).status, 409);
    assert.equal((await t.call('POST', `/api/onboarding/tools/${sub0.toolId}/icon`, { symbol: 2, color: 'green' })).status, 200);
    assert.deepEqual((await catalogOf(t)).find((c) => c.toolId === sub0.toolId)!.icon, { symbol: 2, color: 'green' });
    // 用途說明與適用情境：第一次上架由表單帶入，AI Team 可修改；修改網址時不影響
    assert.equal((await catalogOf(t)).find((c) => c.toolId === sub0.toolId)!.description, '公司 AI 問答');
    assert.equal((await catalogOf(t)).find((c) => c.toolId === sub0.toolId)!.scenario, null);
    assert.equal((await t.call('POST', `/api/onboarding/tools/${sub0.toolId}/profile`, { description: '', scenario: 'x' })).status, 409);
    assert.equal((await t.call('POST', `/api/onboarding/tools/${sub0.toolId}/profile`, { description: '公司內部 AI 問答', scenario: '查詢內規、整理文件初稿' })).status, 200);
    cat = (await catalogOf(t)).find((c) => c.toolId === sub0.toolId)!;
    assert.equal(cat.description, '公司內部 AI 問答');
    assert.equal(cat.scenario, '查詢內規、整理文件初稿');
    // 下架 → 重新上線 → 封存
    assert.equal((await t.call('POST', `/api/onboarding/tools/${sub0.toolId}/offline`, { reason: '暫停使用' })).status, 200);
    cat = (await catalogOf(t)).find((c) => c.toolId === sub0.toolId)!;
    assert.equal(cat.offline, true);
    assert.equal(cat.url, null, '下架後入口關閉');
    assert.equal((await t.call('POST', `/api/onboarding/tools/${sub0.toolId}/online`, { reason: '恢復' })).status, 202);
    await t.runQueue();
    cat = (await catalogOf(t)).find((c) => c.toolId === sub0.toolId)!;
    assert.equal(cat.offline, false);
    assert.equal(cat.url, 'https://chat2.example.com/');
    assert.equal((await t.call('POST', `/api/onboarding/tools/${sub0.toolId}/archive`, { reason: '測試工具' })).status, 200);
    assert.equal((await catalogOf(t)).find((c) => c.toolId === sub0.toolId), undefined, '封存後不再出現');
  } finally { await t.close(); }
});

test('URL 上架：連不上只提醒不阻擋', async () => {
  const t = await setup({ urlReachable: false });
  try {
    const up = await t.call('POST', '/api/onboarding/submissions/url', urlForm({ url: 'http://n8n.intra.local/form/abc', usesAi: false, aiConfirmed: false }));
    assert.equal(up.status, 201);
    const id = (up.data.submission as { id: string }).id;
    await t.runQueue();
    const sub = (await t.call('GET', `/api/onboarding/submissions/${id}`)).data.submission as Record<string, any>;
    assert.equal(sub.steps.platform_test.status, 'warning');
    assert.equal(sub.status, 'awaiting_approval');
    assert.equal(sub.urlConfig.url, 'http://n8n.intra.local/form/abc');
  } finally { await t.close(); }
});

