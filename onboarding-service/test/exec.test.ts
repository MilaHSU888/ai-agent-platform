import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeMasker, run } from '../src/exec.ts';
import { testConfig } from './helpers.ts';

test('日誌遮罩：已知機密值與常見 token 樣式都不寫入', async () => {
  const cfg = testConfig();
  const log = join(cfg.dataDir, 'x.log');
  const secret = 'proxy-key-1234567890abcdef';
  const mask = makeMasker([secret]);
  await run('sh', ['-c', `echo "key=${secret}"; echo "Authorization: Bearer abc.def.ghi"; echo "sk-ABCDEFGHIJKLMNOPQRST"`], { timeoutMs: 5000, logFile: log, mask });
  const text = readFileSync(log, 'utf8');
  assert.ok(!text.includes(secret));
  assert.ok(!text.includes('abc.def.ghi'));
  assert.ok(!text.includes('sk-ABCDEFGHIJKLMNOPQRST'));
});

test('逾時會終止程序並標記 timedOut', async () => {
  const r = await run('sh', ['-c', 'sleep 5'], { timeoutMs: 200 });
  assert.equal(r.timedOut, true);
});

test('取消會終止程序並標記 cancelled', async () => {
  const ctrl = new AbortController();
  setTimeout(() => ctrl.abort(), 100);
  const r = await run('sh', ['-c', 'sleep 5'], { timeoutMs: 5000, signal: ctrl.signal });
  assert.equal(r.cancelled, true);
});
