import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { Store } from '../src/db.ts';
import { JobQueue } from '../src/queue.ts';
import { Secrets } from '../src/secrets.ts';
import { createApp } from '../src/server.ts';
import { runReleaseJob } from '../src/releases.ts';
import { AutopackWorker, importedNames, slugFrom } from '../src/autopack/job.ts';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { analyze } from '../src/autopack/analyze.ts';
import { loadTree } from '../src/autopack/files.ts';
import { parseReply, vetEdits } from '../src/autopack/model.ts';
import { lineDiff } from '../src/autopack/diff.ts';
import { FakeRuntime, makeZip, testConfig, type FakeOpts, type ZipFile } from './helpers.ts';

const TOKEN = 'test-proxy-token-ap01';
const ORIGIN = 'http://localhost:3002';

type Fake = { calls: { system: string; user: string }[]; reply: (user: string) => string };

async function setup(opts: FakeOpts = {}, fake?: Fake) {
  const cfg0 = testConfig();
  const store = new Store(join(cfg0.dataDir, 'db.sqlite'));
  const rt = new FakeRuntime(opts);
  const secrets = new Secrets(cfg0.dataDir);
  const cfg = { ...cfg0, timeouts: { ...cfg0.timeouts, healthMs: 300 } };
  const queue = new JobQueue(store, cfg, rt, secrets);
  for (const k of ['release', 'rollback', 'redeploy', 'trial', 'publish']) queue.extraKinds[k] = (id, signal) => runReleaseJob(store, cfg, rt, secrets, id, signal);
  const worker = new AutopackWorker(store, cfg, rt, secrets, { model: fake ? () => async (system, user) => { fake.calls.push({ system, user }); return fake.reply(user); } : () => null, retryDelayScale: 0 });
  const app = createApp(store, cfg, queue, rt, secrets, TOKEN, worker);
  await new Promise<void>((r) => app.server.listen(0, '127.0.0.1', () => r()));
  cfg.port = (app.server.address() as AddressInfo).port;
  const base = `http://127.0.0.1:${cfg.port}`;
  const call = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
    const isBuf = Buffer.isBuffer(body);
    const r = await fetch(base + path, { method, headers: { ...(method !== 'GET' ? { Origin: ORIGIN } : {}), 'X-WorkHub-Proxy-Token': TOKEN, ...(isBuf ? { 'Content-Type': 'application/zip' } : body ? { 'Content-Type': 'application/json' } : {}), ...headers },
      body: isBuf ? new Uint8Array(body as Buffer) : body ? JSON.stringify(body) : undefined });
    const text = await r.text();
    let data: Record<string, any> = {};
    try { data = JSON.parse(text); } catch { data = { text }; }
    return { status: r.status, data };
  };
  const runWorker = async () => { await worker.tick(); await worker.idle; };
  const runQueue = async () => { await queue.tick(); await queue.idle; };
  const close = () => new Promise<void>((r) => app.server.close(() => r()));
  return { cfg, store, rt, secrets, call, runWorker, runQueue, close, worker };
}

/** 仿採購工具：Windows VM 安裝包（外層有 install.ps1、wheels），裡面 app/ 才是 Streamlit 專案 */
const SOURCE: ZipFile[] = [
  { name: 'pkg/install.ps1', data: 'Write-Host install' },
  { name: 'pkg/requirements_win_py314.txt', data: 'streamlit==1.64.0' },
  { name: 'pkg/wheels/numpy-2.5.3-cp314-cp314-win_amd64.whl', data: Buffer.from([0x50, 0x4b, 0, 1, 2, 3]) },
  { name: 'pkg/app/requirements.txt', data: 'streamlit==1.64.0\nrequests==2.34.2\npytest==9.1.1\n' },
  { name: 'pkg/app/.env', data: 'OLLAMA_URL=http://localhost:11434\n' },
  { name: 'pkg/app/app.py', data: 'import streamlit as st\nfrom settings import DB_PATH\nst.title("報價")\n' },
  { name: 'pkg/app/settings.py', data: 'import os\nfrom pathlib import Path\nPROJECT_ROOT = Path(__file__).parent.resolve()\nDATA_DIR = Path(os.getenv("DATA_DIR", PROJECT_ROOT / "data")).resolve()\nDB_PATH = DATA_DIR / "quote.db"\nCACHE_DIR = DATA_DIR / "_cache"\nOLLAMA_URL = os.getenv("OLLAMA_URL", "http://localhost:11434")\n' },
  { name: 'pkg/app/core/exporter.py', data: "from pathlib import Path\nOUTBOX_DIR = Path(__file__).parent.parent / 'data' / 'outbox'\n\ndef export(name):\n    OUTBOX_DIR.mkdir(parents=True, exist_ok=True)\n    return OUTBOX_DIR / name\n" },
  { name: 'pkg/app/core/ai.py', data: "import requests\nfrom settings import OLLAMA_URL\n\ndef ask(p):\n    return requests.post(f'{OLLAMA_URL}/api/chat', json={'prompt': p}).json()\n" },
  { name: 'pkg/app/core/erp.py', data: 'ERP = "https://erp.company.com.tw/api/quote"\nTOKEN = "sk-abcdefghijklmnopqrstuvwxyz0123"\n' },
  { name: 'pkg/app/data/templates/比較表範本.xlsx', data: Buffer.from([0x50, 0x4b, 3, 4, 9, 9]) },
  { name: 'pkg/app/tests/test_export.py', data: 'def test_one():\n    assert True\n\ndef test_two():\n    assert True\n' },
  { name: 'pkg/app/tests/fixtures/米妮.xlsx', data: Buffer.from([0x50, 0x4b, 3, 4, 1, 1]) },
  { name: 'pkg/app/tests/fixtures/v2/艾爾莎.pdf', data: '%PDF-1.4 fake' },
];

const upload = (t: Awaited<ReturnType<typeof setup>>, files = SOURCE, q = 'mode=new&name=報價彙整&department=purchase&owner=林開發&usesAi=yes&filename=quote_aggregator_winvm_20261001.zip') =>
  t.call('POST', `/api/onboarding/autopack?${q}`, makeZip(files), { 'X-WorkHub-Actor': encodeURIComponent('林開發') });

/** 假的地端模型：依任務回傳修改；也故意夾帶會被擋下的修改（刪測試、改測試資料） */
function fakeModel(extra: (user: string) => string | null = () => null): Fake {
  return {
    calls: [],
    reply: (user) => {
      const x = extra(user);
      if (x !== null) return x;
      if (user.includes('OPENAI_BASE_URL')) return '好的，以下是修改：\n```json\n' + JSON.stringify({ note: '改用平台模型設定', edits: [
        { path: 'core/ai.py', content: "import os, requests\n\ndef ask(p):\n    base = os.getenv('OPENAI_BASE_URL')\n    if not base:\n        return {'error': 'AI 未設定'}\n    return requests.post(f'{base}/chat/completions', headers={'Authorization': f\"Bearer {os.getenv('OPENAI_API_KEY')}\"}, json={'model': os.getenv('OPENAI_MODEL'), 'messages': [{'role': 'user', 'content': p}]}).json()\n" },
        { path: 'tests/test_export.py', content: 'def test_one():\n    assert True\n' },
        { path: 'tests/fixtures/米妮.xlsx', content: 'x' },
      ] }) + '\n```';
      if (user.includes('寫死了金鑰')) return JSON.stringify({ note: '金鑰改讀環境變數', edits: [{ path: 'core/erp.py', content: 'import os\nERP = "https://erp.company.com.tw/api/quote"\nTOKEN = os.getenv("ERP_TOKEN", "")\n' }] });
      if (user.includes('DATA_DIR')) return JSON.stringify({ note: '匯出改存到資料目錄', edits: [{ path: 'core/exporter.py', content: "from settings import DATA_DIR\nOUTBOX_DIR = DATA_DIR / 'outbox'\n\ndef export(name):\n    OUTBOX_DIR.mkdir(parents=True, exist_ok=True)\n    return OUTBOX_DIR / name\n" }] });
      return JSON.stringify({ note: '沒有修改', edits: [] });
    },
  };
}

test('分析：找出 Windows 安裝包裡的專案、框架、資料、AI、測試資料與要問的事（不用 AI）', () => {
  const cfg = testConfig();
  const dir = join(cfg.dataDir, 'src');
  for (const f of SOURCE) { const p = join(dir, f.name); mkdirSync(join(p, '..'), { recursive: true }); writeFileSync(p, f.data ?? ''); }
  const { files, skippedDirs, hints } = loadTree(dir);
  const a = analyze(files, skippedDirs, hints);
  assert.equal(a.root, 'pkg/app');
  assert.equal(a.language, 'python');
  assert.equal(a.framework, 'streamlit');
  assert.equal(a.port, 8501);
  assert.equal(a.healthPath, '/_stcore/health');
  assert.equal(a.runtimeVersion, '3.14', '從離線套件 cp314 判斷 Python 版本');
  assert.ok(a.excluded.some((e) => e.path === 'pkg/install.ps1'));
  assert.ok(a.excluded.some((e) => e.path === 'pkg/wheels/'));
  assert.ok(a.excluded.some((e) => e.path === 'pkg/app/.env'), '.env 直接排除，不用問');
  assert.deepEqual(a.secrets.map((s) => s.file), ['core/erp.py']);
  assert.deepEqual(a.external.map((h) => h.host), ['erp.company.com.tw'], 'localhost 的 Ollama 不算對外連線');
  assert.ok(a.ai.uses);
  assert.deepEqual(a.ai.rewriteFiles.sort(), ['core/ai.py', 'settings.py']);
  assert.equal(a.data.defaultDir, 'data');
  assert.deepEqual(a.data.keep.map((k) => k.path), ['quote.db']);
  assert.deepEqual(a.data.temp.map((k) => k.path), ['_cache']);
  assert.deepEqual(a.data.outside.map((o) => o.path), ['data/outbox']);
  assert.deepEqual(a.data.seeds, ['data/templates/比較表範本.xlsx']);
  assert.deepEqual(a.testData.sort(), ['tests/fixtures/v2/艾爾莎.pdf', 'tests/fixtures/米妮.xlsx']);
  assert.deepEqual(a.tests.command, ['python', '-m', 'pytest', '-q', '-p', 'no:cacheprovider', 'tests']);
});

test('不支援的類型：一開始就說明原因並轉給 AI Team', () => {
  const cases: [ZipFile[], RegExp][] = [
    [[{ name: 'app.py', data: 'import tkinter as tk\ntk.Tk().mainloop()\n' }, { name: 'requirements.txt', data: 'pillow\n' }], /桌面視窗程式/],
    [[{ name: 'Tool.csproj', data: '<Project><PropertyGroup><TargetFramework>net48</TargetFramework></PropertyGroup></Project>' }, { name: 'Program.cs', data: 'class P {}' }], /\.NET Framework/],
    [[{ name: 'Win.csproj', data: '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net8.0-windows</TargetFramework><UseWindowsForms>true</UseWindowsForms></PropertyGroup></Project>' }], /WinForms/],
    [[{ name: '報表.xlsm', data: 'x' }, { name: 'Module1.bas', data: 'Sub A()\nEnd Sub' }], /VBA/],
    [[{ name: 'reader.py', data: 'import serial\nimport flask\n' }, { name: 'requirements.txt', data: 'flask\npyserial\n' }], /實體設備/],
    [[{ name: 'README.md', data: '# 說明' }], /看不出/],
  ];
  for (const [files, re] of cases) {
    const cfg = testConfig();
    for (const f of files) writeFileSync(join(cfg.dataDir, f.name), f.data ?? '');
    const a = analyze(loadTree(cfg.dataDir).files);
    assert.match(a.unsupported?.reason ?? '', re, JSON.stringify(files.map((f) => f.name)));
  }
});

test('支援 7 種語言：判斷框架並產生對應的打包檔', async () => {
  const { generate } = await import('../src/autopack/templates.ts');
  const cases: [string, ZipFile[], RegExp, number][] = [
    ['python', [{ name: 'main.py', data: 'from fastapi import FastAPI\napp = FastAPI()\n' }, { name: 'requirements.txt', data: 'fastapi\n' }], /uvicorn/, 8000],
    ['node', [{ name: 'package.json', data: JSON.stringify({ name: 'my-api', dependencies: { express: '4' }, scripts: { start: 'node server.js' } }) }, { name: 'server.js', data: 'require("express")().listen(3000)' }], /npm/, 3000],
    ['java', [{ name: 'pom.xml', data: '<project><parent><artifactId>spring-boot-starter-parent</artifactId></parent><properties><java.version>21</java.version></properties></project>' }, { name: 'src/main/java/App.java', data: 'class App {}' }], /maven/, 8080],
    ['dotnet', [{ name: 'Api.csproj', data: '<Project Sdk="Microsoft.NET.Sdk.Web"><PropertyGroup><TargetFramework>net8.0</TargetFramework></PropertyGroup></Project>' }, { name: 'Program.cs', data: 'var app = WebApplication.Create();' }], /dotnet\/aspnet:8\.0/, 8080],
    ['go', [{ name: 'go.mod', data: 'module x\n\ngo 1.22\n' }, { name: 'main.go', data: 'package main\nimport "net/http"\nfunc main(){ http.ListenAndServe(":8080", nil) }' }], /golang:1\.22/, 8080],
    ['php', [{ name: 'index.php', data: '<?php echo "hi";' }], /php:8\.3-cli/, 8080],
    ['static', [{ name: 'index.html', data: '<h1>hi</h1>' }], /nginx-unprivileged/, 8080],
  ];
  for (const [lang, files, re, port] of cases) {
    const cfg = testConfig();
    for (const f of files) { const p = join(cfg.dataDir, f.name); mkdirSync(join(p, '..'), { recursive: true }); writeFileSync(p, f.data ?? ''); }
    const a = analyze(loadTree(cfg.dataDir).files);
    assert.equal(a.language, lang);
    assert.equal(a.unsupported, null, lang);
    assert.equal(a.port, port, lang);
    const g = generate(a, { toolId: 'x-tool', description: '', platforms: ['linux/arm64'], reqFile: lang === 'python' ? 'requirements.txt' : null, hasLock: false, date: '2026-11-03' });
    assert.match(g.files.Dockerfile, re, lang);
    assert.match(g.files['workhub.yaml'], /schemaVersion: workhub\/v1/);
    assert.match(g.files['workhub.yaml'], /network: none/);
  }
});

test('模型回覆：容忍說明文字；不能刪測試、跳過測試、改測試資料、清空檔案或改 workhub.yaml', () => {
  const r = parseReply('<think>想一下</think>好的\n```json\n{"edits":[{"path":"a.py","content":"x=1"}],"note":"ok"}\n```');
  assert.equal(r.edits.length, 1);
  assert.equal(r.note, 'ok');
  assert.equal(parseReply('不是 JSON').edits.length, 0);
  const files: Record<string, string> = { 'tests/test_a.py': 'def test_a():\n    pass\n\ndef test_b():\n    pass\n', 'a.py': 'x=0' };
  const v = vetEdits([
    { path: 'a.py', content: 'x=1' },
    { path: 'tests/test_a.py', content: 'def test_a():\n    pass\n' },
    { path: 'tests/test_a.py', content: 'import pytest\n@pytest.mark.skip\ndef test_a():\n    pass\n\ndef test_b():\n    pass\n' },
    { path: 'tests/fixtures/a.xlsx', content: 'x' },
    { path: '../etc/passwd', content: 'x' },
    { path: 'b.py', content: '' },
    { path: 'workhub.yaml', content: 'x' },
    { path: 'new.exe', content: 'MZ' },
  ], { exists: (p) => p in files, read: (p) => files[p] ?? null, testData: new Set(['tests/fixtures/a.xlsx']), allowNew: () => true });
  assert.deepEqual(v.ok.map((e) => e.path), ['a.py']);
  assert.deepEqual(v.rejected.map((x) => x.reason), ['專案原有的測試不能修改', '專案原有的測試不能修改', '不能修改測試資料', '路徑不安全', '不能清空或刪除檔案', 'workhub.yaml 由平台產生，模型不能修改', '只能修改程式碼與打包設定檔']);
  const d = lineDiff('a\nb\nc\n', 'a\nB\nc\nd\n');
  assert.equal(d.add, 2); assert.equal(d.del, 1);
  assert.equal(slugFrom('quote_aggregator_winvm_20261001.zip'), 'quote-aggregator');
  assert.match(slugFrom('報價工具.zip'), /^tool-/);
});

test('自動打包完整流程：暫停提問 → 模型補程式 → 建置測試 → 報告 → 確認送出進上架流程 → 公開後刪除測試資料', async () => {
  const fake = fakeModel();
  const t = await setup({}, fake);
  try {
    const up = await upload(t);
    assert.equal(up.status, 201, JSON.stringify(up.data));
    const id = up.data.autopack.id as string;
    await t.runWorker();
    let v = (await t.call('GET', `/api/onboarding/autopack/${id}`)).data.autopack;
    assert.equal(v.status, 'awaiting_answer');
    assert.equal(v.toolId, 'quote-aggregator');
    assert.ok(!existsSync(join(t.cfg.dataDir, 'autopack', id, 'upload.zip')), '原始上傳檔解壓後就刪除（可能有真實資料）');
    assert.deepEqual(v.questions.map((q: any) => q.kind).sort(), ['data_keep', 'external', 'secret']);
    assert.ok(!JSON.stringify(v.questions).includes('abcdefghijklmnop'), '不顯示金鑰內容');
    // 沒回答完不能繼續
    assert.equal((await t.call('POST', `/api/onboarding/autopack/${id}/answers`, { answers: { sec1: 'env' } })).status, 409);
    const answers = Object.fromEntries(v.questions.map((q: any) => [q.id, q.kind === 'secret' ? 'env' : q.kind === 'external' ? 'not_needed' : 'keep']));
    assert.equal((await t.call('POST', `/api/onboarding/autopack/${id}/answers`, { answers })).status, 200);
    await t.runWorker();
    v = (await t.call('GET', `/api/onboarding/autopack/${id}`)).data.autopack;
    assert.equal(v.status, 'awaiting_review', JSON.stringify(v.steps));
    // 模型只做兩件事：AI 連線、資料路徑；被擋下的修改留在報告
    assert.equal(fake.calls.length, 3, '模型做三件事：AI 連線、移除金鑰、資料路徑');
    assert.match(fake.calls[0].system, /DATA_DIR/);
    assert.ok(!fake.calls.some((c) => c.user.includes('abcdefghijklmnop')), '送模型前遮掉金鑰');
    const rep = v.report;
    assert.equal(rep.summary['tool.id'], 'quote-aggregator');
    assert.match(rep.summary['專案'], /Streamlit（Python 3\.14）/);
    assert.ok(rep.changes.some((c: any) => c.path === 'Dockerfile' && c.kind === 'added' && c.by === 'template'));
    assert.ok(rep.changes.some((c: any) => c.path === 'core/exporter.py' && c.kind === 'modified' && c.by === 'model' && /DATA_DIR/.test(c.diff)));
    assert.ok(rep.changes.some((c: any) => c.path === '.workhub/seed/templates/比較表範本.xlsx'), '範本第一次啟動複製到資料目錄');
    assert.ok(!rep.changes.some((c: any) => c.path.startsWith('tests/fixtures/')), '測試資料不放進工具');
    assert.deepEqual(rep.model.rejected.sort(), ['tests/fixtures/米妮.xlsx：不能修改測試資料', 'tests/test_export.py：專案原有的測試不能修改']);
    assert.equal(rep.testData.length, 2);
    assert.ok(rep.excluded.some((e: any) => e.path === 'pkg/install.ps1'));
    assert.match(rep.markdown, /# 打包報告：報價彙整/);
    assert.match(rep.markdown, /## 需要開發者確認/);
    // 業務測試時測試資料唯讀掛上
    const test = t.rt.ran.at(-1)!;
    assert.deepEqual(test.network, 'none');
    assert.deepEqual(test.command, ['python', '-m', 'pytest', '-q', '-p', 'no:cacheprovider', 'tests']);
    assert.deepEqual(test.binds!.map((b) => b.target), ['/app/tests/fixtures']);
    // 打包結果：Dockerfile 用 Python 3.14、系統套件、非 root、資料在 /data；ZIP 不含 .env、測試資料、Windows 安裝檔
    const df = readFileSync(join(t.cfg.dataDir, 'autopack', id, 'src', 'Dockerfile'), 'utf8');
    assert.match(df, /FROM python:3\.14-slim-trixie/);
    assert.match(df, /DATA_DIR=\/data/);
    assert.match(df, /USER 10001/);
    assert.match(df, /ENTRYPOINT \["\/workhub\/entrypoint\.sh"\]/);
    const files = (await import('../src/autopack/job.ts')).listFiles(join(t.cfg.dataDir, 'autopack', id, 'src'));
    assert.ok(!files.some((f) => /\.env$|fixtures|install\.ps1|wheels/.test(f)), files.join(','));
    // 確認送出 → 進原本的上架流程
    const c = await t.call('POST', `/api/onboarding/autopack/${id}/confirm`, {}, { 'X-WorkHub-Actor': encodeURIComponent('林開發') });
    assert.equal(c.status, 200, JSON.stringify(c.data));
    const subId = c.data.submission.id as string;
    assert.equal(c.data.submission.toolName, '報價彙整');
    assert.equal(c.data.submission.department, 'purchase');
    assert.equal((await t.call('POST', `/api/onboarding/autopack/${id}/confirm`, {})).status, 409, '不能重複送出');
    await t.runQueue();
    const s = (await t.call('GET', `/api/onboarding/submissions/${subId}`)).data.submission;
    assert.equal(s.steps.business_test.status, 'passed');
    assert.deepEqual(s.steps.business_test.summary.testDataMounted, ['/app/tests/fixtures']);
    const tdDir = join(t.cfg.dataDir, 'testdata', id);
    assert.ok(existsSync(join(tdDir, 'tests/fixtures/米妮.xlsx')), '測試資料保留到公開');
    // 核准 → 發布（試用中）→ 公開：刪除測試資料
    await t.call('POST', `/api/onboarding/submissions/${subId}/code-review`, { note: '看過' });
    await t.call('POST', `/api/onboarding/submissions/${subId}/confirmations`, { note: '預覽正常' });
    await t.call('POST', `/api/onboarding/submissions/${subId}/approvals`, { reason: '核准' }, { 'X-WorkHub-Actor': 'Tammy' });
    await t.call('POST', `/api/onboarding/submissions/${subId}/release`); await t.runQueue();
    assert.ok(existsSync(tdDir), '試用中仍保留');
    assert.equal((await t.call('POST', '/api/onboarding/tools/quote-aggregator/light', { target: 'public' }, { 'X-WorkHub-Actor': 'Mumu' })).status, 202);
    await t.runQueue();
    assert.ok(!existsSync(tdDir), '公開後刪除測試資料');
    const td = JSON.parse(t.store.get<{ testdata_json: string }>('SELECT testdata_json FROM submissions WHERE id=?', subId)!.testdata_json);
    assert.ok(td.purgedAt);
    assert.equal(td.files.length, 2);
    assert.ok(td.files.every((f: any) => /^[0-9a-f]{64}$/.test(f.sha256)));
    // 審核履歷
    const rows = (await t.call('GET', '/api/onboarding/tools/quote-aggregator/review-history')).data.rows as { action: string; actor: string; version: string }[];
    const acts = rows.map((r) => r.action);
    for (const x of ['上傳原始碼（自動打包）', '確認打包報告', '上傳', '核准發布', '測試資料已刪除']) assert.ok(acts.includes(x), `${x} ∈ ${acts.join(',')}`);
    assert.equal(rows.find((r) => r.action === '上傳原始碼（自動打包）')!.version, 'v1');
    assert.equal(rows.find((r) => r.action === '確認打包報告')!.actor, '林開發');
    // 工作檔清乾淨
    assert.ok(!existsSync(join(t.cfg.dataDir, 'autopack', id, 'src')));
  } finally { await t.close(); }
});

test('建置或測試失敗：交給模型修正，修好就繼續；修了 3 次還不行就轉 AI Team', async () => {
  // 第一次業務測試失敗，模型修正後通過
  let fail = true;
  const fake = fakeModel((user) => (user.includes('業務測試失敗') ? (fail = false, JSON.stringify({ note: '修正匯出路徑', edits: [{ path: 'app.py', content: 'import streamlit as st\nst.title("ok")\n' }] })) : null));
  const t = await setup({ businessExit: 1 }, fake);
  const simple: ZipFile[] = [{ name: 'app.py', data: 'import streamlit as st\n' }, { name: 'requirements.txt', data: 'streamlit\n' }, { name: 'tests/test_a.py', data: 'def test_a():\n    assert True\n' }];
  try {
    const orig = t.rt.runOnce.bind(t.rt);
    t.rt.runOnce = async (spec) => { const r = await orig(spec); return { ...r, code: fail ? 1 : 0, stdout: fail ? 'E   AssertionError: tests/test_a.py' : '1 passed' }; };
    const id = (await upload(t, simple, 'mode=new&name=小工具&department=it&owner=林開發&filename=small.zip&usesAi=unsure')).data.autopack.id;
    await t.runWorker();
    const v = (await t.call('GET', `/api/onboarding/autopack/${id}`)).data.autopack;
    assert.equal(v.status, 'awaiting_review', JSON.stringify(v.steps));
    assert.ok(v.steps.some((s: any) => s.name === '修正第 1 次' && s.status === 'passed'));
    assert.match(v.report.verification.test, /1 項通過/);
  } finally { await t.close(); }

  // 一直失敗 → 轉 AI Team，可下載紀錄與打包結果
  const fake2 = fakeModel(() => JSON.stringify({ note: '試試看', edits: [{ path: 'app.py', content: 'import streamlit as st\n# try\n' }] }));
  const t2 = await setup({ build: false }, fake2);
  try {
    const id = (await upload(t2, simple, 'mode=new&name=小工具&department=it&owner=林開發&filename=small.zip&usesAi=unsure')).data.autopack.id;
    await t2.runWorker();
    const v = (await t2.call('GET', `/api/onboarding/autopack/${id}`)).data.autopack;
    assert.equal(v.status, 'handed_off');
    assert.match(v.handoff.reason, /修了 3 次仍然建置失敗/);
    assert.equal(fake2.calls.length, 3);
    const log = await fetch(`http://127.0.0.1:${t2.cfg.port}/api/onboarding/autopack/${id}/log`, { headers: { 'X-WorkHub-Proxy-Token': TOKEN } });
    assert.match(await log.text(), /轉給 AI Team/);
    const z = await fetch(`http://127.0.0.1:${t2.cfg.port}/api/onboarding/autopack/${id}/files.zip`, { headers: { 'X-WorkHub-Proxy-Token': TOKEN } });
    assert.equal(z.status, 200);
    const notices = (await t2.call('GET', `/api/onboarding/notices?owner=${encodeURIComponent('林開發')}`)).data.notices as { message: string }[];
    assert.ok(notices.some((n) => /轉給 AI Team/.test(n.message)));
  } finally { await t2.close(); }
});

test('轉給 AI Team 的情況：不支援的類型、需要連外、真的金鑰、模型未設定、超過 60 分鐘', async () => {
  const t = await setup({}, undefined);
  try {
    const gui = (await upload(t, [{ name: 'app.py', data: 'import tkinter\n' }, { name: 'requirements.txt', data: 'pillow\n' }], 'mode=new&name=視窗&department=it&owner=A&filename=gui.zip&usesAi=unsure')).data.autopack.id;
    await t.runWorker();
    let v = (await t.call('GET', `/api/onboarding/autopack/${gui}`)).data.autopack;
    assert.equal(v.status, 'handed_off');
    assert.match(v.handoff.reason, /不支援的類型：桌面視窗程式/);
    // 需要連外 → 轉 AI Team
    const ext = (await upload(t)).data.autopack.id;
    await t.runWorker();
    v = (await t.call('GET', `/api/onboarding/autopack/${ext}`)).data.autopack;
    const ans = Object.fromEntries(v.questions.map((q: any) => [q.id, q.kind === 'external' ? 'needed' : q.kind === 'secret' ? 'env' : 'keep']));
    await t.call('POST', `/api/onboarding/autopack/${ext}/answers`, { answers: ans }); await t.runWorker();
    v = (await t.call('GET', `/api/onboarding/autopack/${ext}`)).data.autopack;
    assert.equal(v.status, 'handed_off');
    assert.match(v.handoff.reason, /需要連外部系統/);
    assert.ok(!existsSync(join(t.cfg.dataDir, 'testdata', ext)), '沒送出就刪掉測試資料');
    // 真的金鑰 → 請開發者移除後重新上傳
    const sec = (await upload(t)).data.autopack.id;
    await t.runWorker();
    v = (await t.call('GET', `/api/onboarding/autopack/${sec}`)).data.autopack;
    await t.call('POST', `/api/onboarding/autopack/${sec}/answers`, { answers: Object.fromEntries(v.questions.map((q: any) => [q.id, q.kind === 'secret' ? 'reupload' : q.kind === 'external' ? 'not_needed' : 'keep'])) }); await t.runWorker();
    assert.match((await t.call('GET', `/api/onboarding/autopack/${sec}`)).data.autopack.handoff.reason, /移除寫死的金鑰/);
    // 地端模型沒設定，但需要補程式 → 轉 AI Team
    const nom = (await upload(t)).data.autopack.id;
    await t.runWorker();
    v = (await t.call('GET', `/api/onboarding/autopack/${nom}`)).data.autopack;
    await t.call('POST', `/api/onboarding/autopack/${nom}/answers`, { answers: Object.fromEntries(v.questions.map((q: any) => [q.id, q.kind === 'secret' ? 'env' : q.kind === 'external' ? 'not_needed' : 'keep'])) }); await t.runWorker();
    assert.match((await t.call('GET', `/api/onboarding/autopack/${nom}`)).data.autopack.handoff.reason, /地端模型尚未設定/);
    // 取消
    const c = (await upload(t)).data.autopack.id;
    await t.runWorker();
    assert.equal((await t.call('POST', `/api/onboarding/autopack/${c}/cancel`, {})).status, 200);
    assert.equal((await t.call('GET', `/api/onboarding/autopack/${c}`)).data.autopack.status, 'cancelled');
    // 表單檢查
    assert.equal((await t.call('POST', '/api/onboarding/autopack?mode=new&department=it&owner=A&filename=x.zip', makeZip([{ name: 'a.py', data: '' }]))).status, 422, '新工具要填名稱');
    assert.equal((await t.call('POST', '/api/onboarding/autopack?mode=update&expectedToolId=nope&department=it&owner=A&filename=x.zip', makeZip([{ name: 'a.py', data: '' }]))).status, 422);
  } finally { await t.close(); }

  // 超過 60 分鐘（等回答的時間不算）
  const cfg0 = testConfig();
  const store = new Store(join(cfg0.dataDir, 'db.sqlite'));
  const rt = new FakeRuntime({});
  let clock = 0;
  const slow = new FakeRuntime({});
  slow.build = async (...args) => { clock += 61 * 60_000; return rt.build(...args); };
  const w = new AutopackWorker(store, cfg0, slow, new Secrets(cfg0.dataDir), { model: () => async () => '{"edits":[]}', clock: () => clock, retryDelayScale: 0 });
  const { createAutopack } = await import('../src/autopack/job.ts');
  const r = createAutopack(store, cfg0, makeZip([{ name: 'app.py', data: 'import streamlit as st\n' }, { name: 'requirements.txt', data: 'streamlit\n' }]), { mode: 'new', name: 'x', usesAi: 'no', department: 'it', owner: 'A', actor: 'A', originalFilename: 'x.zip' });
  assert.ok(r.ok);
  await w.tick(); await w.idle;
  const row = store.get<{ status: string; error: string }>('SELECT status, error FROM autopacks')!;
  assert.equal(row.status, 'handed_off');
  assert.match(row.error, /超過 60 分鐘/);
});

test('版本更新：沿用工具代號，和上一版比對資料表欄位', async () => {
  const fake = fakeModel();
  const t = await setup({}, fake);
  const v1: ZipFile[] = [{ name: 'app.py', data: 'import streamlit as st\nimport sqlite3\nsqlite3.connect("x").execute("CREATE TABLE IF NOT EXISTS quotes (id INTEGER, price REAL);")\n' }, { name: 'requirements.txt', data: 'streamlit\n' }, { name: 'tests/test_a.py', data: 'def test_a():\n    assert True\n' }];
  try {
    let id = (await upload(t, v1, 'mode=new&name=查價&department=purchase&owner=A&filename=pricing.zip&usesAi=unsure')).data.autopack.id;
    await t.runWorker();
    const sub = (await t.call('POST', `/api/onboarding/autopack/${id}/confirm`, {})).data.submission.id;
    await t.runQueue();
    await t.call('POST', `/api/onboarding/submissions/${sub}/code-review`, { note: 'ok' });
    await t.call('POST', `/api/onboarding/submissions/${sub}/confirmations`, { note: 'ok' });
    await t.call('POST', `/api/onboarding/submissions/${sub}/approvals`, { reason: 'ok' });
    await t.call('POST', `/api/onboarding/submissions/${sub}/release`); await t.runQueue();
    const v2 = v1.map((f) => (f.name === 'app.py' ? { ...f, data: String(f.data).replace('price REAL', 'price REAL, currency TEXT') } : f));
    id = (await upload(t, v2, 'mode=update&expectedToolId=pricing&department=purchase&owner=A&filename=pricing-v2.zip&usesAi=unsure')).data.autopack.id;
    await t.runWorker();
    const v = (await t.call('GET', `/api/onboarding/autopack/${id}`)).data.autopack;
    assert.equal(v.status, 'awaiting_review', JSON.stringify(v.steps));
    assert.equal(v.report.summary['類型'], '版本更新');
    assert.deepEqual(v.report.decisions.schemaChanges, ['資料表 quotes 新增欄位：currency']);
    assert.ok(v.report.confirm.some((c: string) => /資料格式有變/.test(c)));
  } finally { await t.close(); }
});

test('模型不能刪掉測試會匯入的名稱（2026/11/03 實測 OLLAMA_HINT）', () => {
  const src = mkdtempSync(join(tmpdir(), 'ap-names-'));
  mkdirSync(join(src, 'parsers'), { recursive: true }); mkdirSync(join(src, 'tests'), { recursive: true });
  writeFileSync(join(src, 'parsers/ai_parser.py'), 'OLLAMA_HINT = "x"\ndef parse(): pass\n');
  writeFileSync(join(src, 'tests/test_ai.py'), 'from parsers.ai_parser import (\n    OLLAMA_HINT,  # hint\n    parse as p,\n)\nimport os\n');
  writeFileSync(join(src, 'app.py'), 'from parsers.ai_parser import parse\nfrom settings import X\n');
  assert.deepEqual(importedNames(src, ['parsers/ai_parser.py']), { 'parsers/ai_parser.py': ['OLLAMA_HINT', 'parse'] });
});

test('已打包 ZIP 偏大：不擋，列出虛擬環境、安裝檔、大型資料檔（2026/11/03）', async () => {
  const { bulkyWarnings } = await import('../src/intake.ts');
  const e = (name: string, size: number) => ({ name, method: 8, flags: 0, crc: 0, compressedSize: size, size, localOffset: 0, isDir: false, isSymlink: false });
  const entries = [e('app/main.py', 1000), e('app/venv/lib/x.so', 30e6), e('app/wheels/a-cp314-win_amd64.whl', 20e6), e('app/setup.exe', 5e6), e('app/data/big.xlsx', 8e6)];
  assert.deepEqual(bulkyWarnings(10e6, entries, ''), []);
  const w = bulkyWarnings(70e6, entries, '');
  assert.deepEqual(w.map((x) => x.reason.replace(/^ZIP 有 \d+ MB、\d+ 個檔案，其中/, '').replace(/約.*$/, '')), ['虛擬環境、套件或快取（已自動排除）', 'Windows 安裝檔', '資料檔或影音']);
  assert.match(w[0].file, /app\/venv/);
});

test('新工具和現有工具撞名：先問是不是新版本（是 → 結束這次打包；不是 → 用自訂代號繼續）（2026/11/03）', async () => {
  const t = await setup({}, fakeModel());
  try {
    t.store.run("INSERT INTO tools(id,name,department,owner,created_at,updated_at) VALUES('quote-aggregator','採購報價單彙整工具','purchase','林開發','2026-10-01','2026-10-01')");
    const a = (await upload(t)).data.autopack.id as string;
    await t.runWorker();
    let v = (await t.call('GET', `/api/onboarding/autopack/${a}`)).data.autopack;
    assert.equal(v.questions[0].kind, 'duplicate');
    assert.match(v.questions[0].title, /採購報價單彙整工具/);
    assert.equal(v.questions[0].input.default, 'quote-aggregator-2');
    const rest = (val: string) => Object.fromEntries(v.questions.map((q: any) => [q.id, q.kind === 'duplicate' ? val : q.kind === 'secret' ? 'env' : q.kind === 'external' ? 'not_needed' : 'keep']));
    assert.equal((await t.call('POST', `/api/onboarding/autopack/${a}/answers`, { answers: rest('update') })).status, 200);
    v = (await t.call('GET', `/api/onboarding/autopack/${a}`)).data.autopack;
    assert.equal(v.status, 'cancelled');
    assert.match(v.error, /提交新版本/);
    // 另一個工具：代號不合格或已被使用會被擋；合格就沿用
    const b = (await upload(t)).data.autopack.id as string;
    await t.runWorker();
    v = (await t.call('GET', `/api/onboarding/autopack/${b}`)).data.autopack;
    assert.equal((await t.call('POST', `/api/onboarding/autopack/${b}/answers`, { answers: { ...rest('new'), 'dup.toolId': 'Quote' } })).status, 409);
    assert.equal((await t.call('POST', `/api/onboarding/autopack/${b}/answers`, { answers: { ...rest('new'), 'dup.toolId': 'quote-aggregator' } })).status, 409);
    assert.equal((await t.call('POST', `/api/onboarding/autopack/${b}/answers`, { answers: { ...rest('new'), 'dup.toolId': 'quote-compare' } })).status, 200);
    await t.runWorker();
    v = (await t.call('GET', `/api/onboarding/autopack/${b}`)).data.autopack;
    assert.equal(v.toolId, 'quote-compare');
  } finally { await t.close(); }
});

test('地端模型連線失敗：重試，仍失敗就轉 AI Team，不會沒改程式就繼續打包（2026/11/03 實測）', async () => {
  let fails = 2;
  const flaky = fakeModel((user) => { if (user.includes('OPENAI_BASE_URL') && fails-- > 0) throw new TypeError('fetch failed'); return null; });
  const t = await setup({}, flaky);
  const answerAll = async (id: string) => {
    const v = (await t.call('GET', `/api/onboarding/autopack/${id}`)).data.autopack;
    await t.call('POST', `/api/onboarding/autopack/${id}/answers`, { answers: Object.fromEntries(v.questions.map((q: any) => [q.id, q.kind === 'secret' ? 'env' : q.kind === 'external' ? 'not_needed' : 'keep'])) });
    await t.runWorker();
    return (await t.call('GET', `/api/onboarding/autopack/${id}`)).data.autopack;
  };
  try {
    const a = (await upload(t)).data.autopack.id as string;
    await t.runWorker();
    let v = await answerAll(a);
    assert.equal(v.status, 'awaiting_review', '失敗 2 次後第 3 次成功');
    assert.match(v.report.confirm[0], /已改用平台指定的模型（改了 core\/ai\.py）/);
    fails = 99;
    const b = (await upload(t)).data.autopack.id as string;
    await t.runWorker();
    v = await answerAll(b);
    assert.equal(v.status, 'handed_off');
    assert.match(v.handoff.reason, /地端模型沒有完成「AI 連線改用平台設定」/);
    assert.match(v.handoff.detail, /fetch failed/);
  } finally { await t.close(); }
});

test('專案 ZIP 檔案數放寬到 5 萬（夾帶 node_modules 等）；超過或有安全問題時上傳當下就告訴開發者，不轉 AI Team', async () => {
  const { createAutopack } = await import('../src/autopack/job.ts');
  const cfg = testConfig();
  assert.equal(cfg.autopack.entries, 50_000);
  const files = Array.from({ length: 6 }, (_, i) => ({ name: `node_modules/x${i}.js`, data: 'x' }));
  const small = { ...cfg, limits: { ...cfg.limits, entries: 3 }, autopack: { ...cfg.autopack, entries: 10 } };
  const store = new Store(join(cfg.dataDir, 'ap.db'));
  const form = { mode: 'new' as const, name: 'X', department: 'it', owner: 'A', actor: 'A', originalFilename: 'x.zip', usesAi: 'no' };
  assert.equal(createAutopack(store, small, makeZip(files), form).ok, true, '一般 ZIP 的 3 個上限不適用專案 ZIP');
  const r = createAutopack(store, { ...small, autopack: { ...small.autopack, entries: 4 } }, makeZip(files), form);
  assert.equal(r.ok, false);
  assert.match(JSON.stringify(r), /檔案數 6 超過上限 4/);
});

test('偵測 AI：網址前半段放在環境變數、只寫 /chat/completions 的 OpenAI 相容呼叫也算（2026/11/03 CNC 翻譯）', () => {
  const files = [
    { path: 'app.py', size: 1, text: 'from fastapi import FastAPI\nfrom translator import t\napp = FastAPI()\n' },
    { path: 'translator.py', size: 1, text: 'import os, requests\nBASE = os.getenv("UMT_5090_API_BASE", "http://127.0.0.1:18001/v1")\ndef t(x):\n    return requests.post(f"{BASE}/chat/completions", json={"messages": []})\n' },
    { path: 'requirements.txt', size: 1, text: 'fastapi\nuvicorn\nrequests\n' },
  ];
  const a = analyze(files, [], []);
  assert.equal(a.ai.uses, true);
  assert.deepEqual(a.ai.rewriteFiles, ['translator.py']);
});

test('上傳時回答會不會用 AI，平台對照：說會但找不到 → 問檔案；說不會但找到 → 問確認（2026/11/03）', async () => {
  const proj = [
    { name: 'app.py', data: 'import streamlit as st\nfrom svc import ask\nst.write(ask("hi"))\n' },
    { name: 'svc.py', data: 'import os, requests\nURL = os.getenv("MY_AI", "http://10.0.0.5:9000")\ndef ask(p):\n    return requests.post(URL + "/generate_text", json={"prompt": p}).json()\n' },
    { name: 'requirements.txt', data: 'streamlit\nrequests\n' },
  ];
  const fake = fakeModel((user) => user.includes('OPENAI_BASE_URL') && user.includes('svc.py') ? JSON.stringify({ note: '改用平台模型', edits: [{ path: 'svc.py', content: 'import os, requests\nURL = os.getenv("MY_AI", "http://10.0.0.5:9000")\ndef ask(p):\n    base = os.getenv("OPENAI_BASE_URL")\n    if base:\n        return requests.post(f"{base}/chat/completions", json={"model": os.getenv("OPENAI_MODEL"), "messages": [{"role": "user", "content": p}]}).json()\n    return requests.post(URL + "/generate_text", json={"prompt": p}).json()\n' }] }) : null);
  const t = await setup({}, fake);
  try {
    assert.equal((await upload(t, proj, 'mode=new&name=問答&department=it&owner=A&filename=qa.zip')).status, 422, '必填');
    const a = (await upload(t, proj, 'mode=new&name=問答&department=it&owner=A&usesAi=yes&filename=qa.zip')).data.autopack.id as string;
    await t.runWorker();
    let v = (await t.call('GET', `/api/onboarding/autopack/${a}`)).data.autopack;
    const q = v.questions.find((x: any) => x.kind === 'ai');
    assert.equal(q.id, 'ai.missing');
    const others = Object.fromEntries(v.questions.filter((x: any) => x.kind !== 'ai').map((x: any) => [x.id, x.kind === 'external' ? 'not_needed' : x.kind === 'secret' ? 'env' : 'keep']));
    assert.equal((await t.call('POST', `/api/onboarding/autopack/${a}/answers`, { answers: { ...others, 'ai.missing': 'file', 'ai.file': 'nope.py' } })).status, 409);
    assert.equal((await t.call('POST', `/api/onboarding/autopack/${a}/answers`, { answers: { ...others, 'ai.missing': 'file', 'ai.file': 'svc.py' } })).status, 200);
    await t.runWorker();
    v = (await t.call('GET', `/api/onboarding/autopack/${a}`)).data.autopack;
    assert.equal(v.status, 'awaiting_review', JSON.stringify(v.handoff));
    assert.match(v.report.summary['使用 AI'], /^是.*開發者回答：會/);
    assert.ok(v.report.changes.some((c: any) => c.path === 'svc.py' && c.by === 'model'));
    // 說不會，但平台看到呼叫模型的程式
    const b = (await upload(t, SOURCE, 'mode=new&name=報價&department=purchase&owner=A&usesAi=no&filename=quote2.zip')).data.autopack.id as string;
    await t.runWorker();
    v = (await t.call('GET', `/api/onboarding/autopack/${b}`)).data.autopack;
    assert.ok(v.questions.some((x: any) => x.id === 'ai.unexpected'));
  } finally { await t.close(); }
});
