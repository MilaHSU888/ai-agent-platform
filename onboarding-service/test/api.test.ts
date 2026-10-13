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
  return { cfg, store, rt, queue, call, login, runQueue, close, base, setToken: (v: string) => { token = v; } };
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
    assert.equal(s1.steps.ai_review.status, 'skipped');
    assert.match(s1.steps.ai_review.summary.reason, /未執行，不是通過/);
    assert.equal(s1.steps.platform_test.status, 'passed');
    assert.equal(s1.steps.business_test.status, 'passed');
    assert.equal(s1.steps.preview.status, 'passed');
    assert.match(s1.previewUrl, /^http:\/\/127\.0\.0\.1:186\d\d\/$/);
    // 業務測試在無網路容器執行；預覽容器埠只綁本機（由 runtime 以 127.0.0.1 綁定）
    assert.equal(t.rt.ran[0].network, 'none');
    assert.equal((await t.call('POST', `/api/onboarding/submissions/${id}/approvals`, { reason: 'ok' })).status, 409);
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

