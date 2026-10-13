/**
 * 階段 D 驗證：用「目前上線中的採購工具映像」在工具隔離網路裡跑樣本，所有 AI 呼叫都經過模型轉接服務。
 *   ai-check  ：米老鼠_PDF版.pdf，確認真實 AI 呼叫（D4）
 *   samples   ：七封去識別化 .msg（D5）
 *   failures  ：假模型的斷線／500／非 JSON／缺欄位／逾時（D6），確認錯誤不會被當成成功
 * 結果寫到 pilot/quote-aggregator/evidence/D4…D6；不記錄提示詞與模型原始回應。
 */
import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { loadConfig } from '../src/config.ts';
import { Secrets } from '../src/secrets.ts';
import { DockerRuntime } from '../src/runtime.ts';
import { run } from '../src/exec.ts';
import { RELAY_URL, syncRelay, toolNetwork } from '../src/relay.ts';

const TOOL = 'quote-aggregator';
const mode = process.argv[2];
if (!['ai-check', 'samples', 'failures'].includes(mode)) { console.log('用法：stage-d.ts ai-check | samples | failures'); process.exit(1); }

const cfg = loadConfig();
const secrets = new Secrets(cfg.dataDir);
const rt = new DockerRuntime(cfg);
const pilot = resolve(cfg.dataDir, '..');
const runnerDir = join(pilot, 'quote-aggregator', 'tools', 'stage_d');
const samplesDir = resolve(pilot, '..', '給mumu 採購報價單彙整工具', '(去識別化)採購部報價單');
const evidence = join(pilot, 'quote-aggregator', 'evidence');
const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);

const db = new DatabaseSync(join(cfg.dataDir, 'onboarding.db'), { readOnly: true });
const rel = db.prepare("SELECT r.image_digest, s.version FROM releases r JOIN submissions s ON s.id=r.submission_id WHERE r.tool_id=? AND r.status='active'").get(TOOL) as { image_digest: string; version: string } | undefined;
if (!rel) { console.log('✗ 採購工具目前沒有上線中的版本，請先在發布管理上線（建議 pilot.4）。'); process.exit(1); }
const ep = secrets.endpoint(cfg.approvedModelEndpoints[0]);
if (mode !== 'failures' && !ep) { console.log('✗ 尚未設定模型端點，請先雙擊「設定模型端點.command」。'); process.exit(1); }
console.log(`工具版本 ${rel.version}　映像 ${rel.image_digest.slice(0, 19)}…　網路 ${toolNetwork(TOOL)}${cfg.toolNetworkInternal ? '（隔離）' : '（可連外）'}`);

const token = secrets.relayToken(TOOL);
const net = toolNetwork(TOOL);
await rt.ensureNetwork(net, cfg.toolNetworkInternal);
if (ep) {
  const r = await syncRelay(cfg, rt, secrets);
  if (!r.ok) { console.log(`✗ ${r.detail}`); process.exit(1); }
  console.log(`模型轉接：${r.detail}　模型 ${ep.env.OPENAI_MODEL}`);
}
const maskValues = [token, ep?.env.OPENAI_API_KEY].filter((v): v is string => !!v);
const mask = (s: string): string => maskValues.reduce((a, v) => a.split(v).join('***'), s);

async function runSamples(targets: string[], env: Record<string, string>, extraMounts: string[] = []) {
  const args = ['run', '--rm', '--network', net, '--read-only', '--tmpfs', '/tmp', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
    '--memory', '3g', '-e', 'DATA_DIR=/tmp/data', '-e', 'HOME=/tmp', ...Object.keys(env).flatMap((k) => ['-e', k]),
    '-v', `${runnerDir}:/probe:ro`, ...extraMounts, rel!.image_digest, 'python', '/probe/run_samples.py', '-', ...targets];
  const r = await run(cfg.docker, args, { timeoutMs: 60 * 60 * 1000, env: { ...process.env, ...env }, mask });
  const out = r.stdout.split('===RESULTS_JSON===');
  process.stdout.write(mask(out[0]));
  if (out.length < 2) { console.log(mask(r.stderr.slice(-1500))); throw new Error('執行器沒有產出結果'); }
  return JSON.parse(out[1]);
}

function relayLogSince(startIso: string) {
  const dir = join(cfg.dataDir, 'relay-logs');
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith('.jsonl')).flatMap((f) => readFileSync(join(dir, f), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)))
    .filter((e) => e.ts >= startIso && e.tool === TOOL);
}

const modelEnv = { OPENAI_BASE_URL: RELAY_URL, OPENAI_API_KEY: token, OPENAI_MODEL: ep?.env.OPENAI_MODEL ?? 'none', AI_TIMEOUT: '120' };
const started = new Date().toISOString();

if (mode === 'ai-check' || mode === 'samples') {
  const dir = join(evidence, mode === 'ai-check' ? 'D4-real-ai' : 'D5-samples', stamp);
  mkdirSync(dir, { recursive: true });
  const targets = mode === 'ai-check' ? ['/app/tests/fixtures/米老鼠_PDF版.pdf'] : ['/samples'];
  const mounts = mode === 'samples' ? ['-v', `${samplesDir}:/samples:ro`] : [];
  const data = await runSamples(targets, modelEnv, mounts);
  const relayCalls = relayLogSince(started);
  writeFileSync(join(dir, 'results.json'), JSON.stringify({ tool: TOOL, version: rel.version, image: rel.image_digest, network: net, model: ep!.env.OPENAI_MODEL, ...data, relay_calls: relayCalls }, null, 1));
  const ok = data.results.filter((r: any) => r.ok).length;
  const aiCalls = data.results.flatMap((r: any) => r.ai_calls);
  console.log(`\n${ok}/${data.results.length} 個檔案有解析結果；工具端 AI 呼叫 ${aiCalls.length} 次（成功 ${aiCalls.filter((c: any) => c.ok).length}）；轉接服務記錄 ${relayCalls.length} 筆（HTTP ${[...new Set(relayCalls.map((c: any) => c.status))].join('/') || '—'}）`);
  console.log(`證據：${dir}`);
} else {
  const dir = join(evidence, 'D6-failures', stamp);
  mkdirSync(dir, { recursive: true });
  const fake = 'wh-fake-model';
  await run(cfg.docker, ['rm', '-f', fake], { timeoutMs: 30000 });
  const st = await run(cfg.docker, ['run', '-d', '--name', fake, '--network', net, '--network-alias', 'fake-model', '--read-only', '--cap-drop', 'ALL', '--user', '10001:10001',
    '-v', `${join(runnerDir, 'fake_model.py')}:/app/fake_model.py:ro`, cfg.relay.image, 'python', '-I', '/app/fake_model.py'], { timeoutMs: 60000 });
  if (st.code !== 0) { console.log(`✗ 假模型啟動失敗：${st.stderr.slice(0, 300)}`); process.exit(1); }
  await new Promise((r) => setTimeout(r, 2000));
  const cases: [string, string, Record<string, string>][] = [
    ['斷線（連不到模型）', 'http://fake-model:9/v1', {}],
    ['模型回 500', 'http://fake-model:8080/error500/v1', {}],
    ['回應不是 JSON', 'http://fake-model:8080/badjson/v1', {}],
    ['缺少料號／單價', 'http://fake-model:8080/nofields/v1', {}],
    ['逾時（工具等 10 秒）', 'http://fake-model:8080/timeout/v1', { AI_TIMEOUT: '10' }],
    ['轉接通行碼無效', RELAY_URL, { OPENAI_API_KEY: 'whr_invalid_token_for_test' }],
  ];
  const summary: any[] = [];
  for (const [name, base, extra] of cases) {
    if (base === RELAY_URL && !ep) { summary.push({ case: name, skipped: '模型端點未設定' }); continue; }
    console.log(`\n── ${name}`);
    const data = await runSamples(['/app/tests/fixtures/米老鼠_PDF版.pdf'], { ...modelEnv, OPENAI_BASE_URL: base, ...extra });
    const r = data.results[0];
    const passed = !r.ok && r.quotes.length === 0 && !!(r.note || r.error);
    summary.push({ case: name, expected: '不產生報價、顯示錯誤訊息', ok_flag: r.ok, quotes: r.quotes.length, message: r.note ?? r.error, ai_calls: r.ai_calls, verdict: passed ? '通過（錯誤沒有被當成成功）' : '未通過' });
    console.log(`   判定：${passed ? '✓ 通過' : '✗ 未通過'}　訊息：${String(r.note ?? r.error ?? '').slice(0, 80)}`);
  }
  await run(cfg.docker, ['rm', '-f', fake], { timeoutMs: 30000 });
  writeFileSync(join(dir, 'results.json'), JSON.stringify({ tool: TOOL, version: rel.version, image: rel.image_digest, network: net, cases: summary }, null, 1));
  console.log(`\n${summary.filter((s) => String(s.verdict ?? '').startsWith('通過')).length}/${summary.length} 個失敗情境通過。證據：${dir}`);
}
