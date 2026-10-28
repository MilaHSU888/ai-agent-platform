import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deflateRawSync } from 'node:zlib';
import { inspectZip } from '../src/intake.ts';
import { readCentralDirectory, readEntry } from '../src/zip-intake.ts';
import { makeZip, MANIFEST, testConfig, validZip } from './helpers.ts';

const cfg = testConfig();
const reasons = (buf: Buffer) => inspectZip(buf, cfg).issues.map((i) => `${i.file}|${i.reason}`).join('\n');

test('合法提交包通過，且回傳驗證後的設定', () => {
  const r = inspectZip(validZip(), cfg);
  assert.deepEqual(r.issues, []);
  assert.equal(r.manifest?.tool.id, 'demo-tool');
  assert.equal(r.manifest?.run.port, 8080);
});

test('Finder 多包一層資料夾時自動辨識，並忽略 __MACOSX 與 .DS_Store', () => {
  const buf = makeZip([
    { name: 'pkg/workhub.yaml', data: MANIFEST },
    { name: 'pkg/Dockerfile', data: 'FROM x' },
    { name: '__MACOSX/pkg/._Dockerfile', data: 'junk' },
    { name: 'pkg/.DS_Store', data: 'junk' },
  ]);
  const r = inspectZip(buf, cfg);
  assert.deepEqual(r.issues, []);
  assert.equal(r.prefix, 'pkg/');
});

test('拒絕路徑穿越與絕對路徑', () => {
  assert.match(reasons(validZip([{ name: '../evil.sh', data: 'x' }])), /路徑不安全/);
  assert.match(reasons(validZip([{ name: '/etc/passwd', data: 'x' }])), /路徑不安全/);
  assert.match(reasons(validZip([{ name: 'a\\..\\b', data: 'x' }])), /路徑不安全/);
});

test('拒絕符號連結、巢狀壓縮檔與 .git', () => {
  assert.match(reasons(validZip([{ name: 'link', data: '/etc/passwd', symlink: true }])), /符號連結/);
  assert.match(reasons(validZip([{ name: 'vendor/inner.zip', data: 'PK' }])), /巢狀壓縮檔/);
  assert.match(reasons(validZip([{ name: '.git/config', data: '[core]' }])), /\.git/);
});

test('拒絕密鑰檔，但允許 .env.example', () => {
  assert.match(reasons(validZip([{ name: '.env', data: 'A=1' }])), /環境設定檔/);
  assert.match(reasons(validZip([{ name: 'app/.env.local', data: 'A=1' }])), /環境設定檔/);
  assert.match(reasons(validZip([{ name: 'certs/server.key', data: 'x' }])), /私鑰/);
  assert.deepEqual(inspectZip(validZip([{ name: '.env.example', data: '# OPENAI_API_KEY=' }]), cfg).issues, []);
});

test('偵測寫死的金鑰，但回報中不出現金鑰內容', () => {
  const secret = 'sk-' + 'A1b2C3d4E5f6G7h8I9j0K1l2';
  const issues = inspectZip(validZip([{ name: 'src/config.py', data: `\n\nKEY = "${secret}"\n` }]), cfg).issues;
  assert.equal(issues.length, 1);
  assert.equal(issues[0].file, 'src/config.py:3');
  assert.ok(!JSON.stringify(issues).includes(secret));
  assert.match(reasons(validZip([{ name: 'k.txt', data: '-----BEGIN OPENSSH PRIVATE KEY-----\nabc' }])), /私鑰內容/);
});

test('拒絕壓縮炸彈（異常壓縮比）與超過檔數上限', () => {
  const zeros = Buffer.alloc(5 * 1024 * 1024);
  assert.match(reasons(validZip([{ name: 'bomb.bin', data: zeros }])), /壓縮比異常/);
  const small = testConfig({ limits: { ...cfg.limits, entries: 3 } });
  assert.match(inspectZip(validZip([{ name: 'x', data: '1' }]), small).issues[0].reason, /檔案數/);
});

test('謊報解壓大小時解壓失敗，不會無限制寫出', () => {
  const data = Buffer.alloc(100_000, 1);
  const buf = makeZip([{ name: 'a.bin', data, lieSize: 10 }]);
  const { entries } = readCentralDirectory(buf, cfg);
  assert.throws(() => readEntry(buf, entries[0]));
  assert.ok(deflateRawSync(data).length < data.length);
});

test('損毀檔案、不是 ZIP、缺少 workhub.yaml 都會拒收並給補正方法', () => {
  assert.match(reasons(Buffer.from('not a zip at all, definitely not')), /ZIP/);
  const truncated = validZip().subarray(0, 60);
  assert.ok(inspectZip(truncated, cfg).issues.length > 0);
  const r = inspectZip(makeZip([{ name: 'Dockerfile', data: 'FROM x' }]), cfg);
  assert.match(r.issues[0].reason, /workhub\.yaml/);
  assert.ok(r.issues[0].fix.length > 0);
});

test('workhub.yaml 驗證：缺件逐欄列出原因與補正方法', () => {
  const bad = MANIFEST.replace('port: 8080', 'port: 80').replace('id: demo-tool', 'id: Demo Tool').replace('network: none', 'network: bridge');
  const issues = inspectZip(validZip([], bad), cfg).issues;
  const fields = issues.map((i) => i.field);
  assert.ok(fields.includes('run.port'));
  assert.ok(fields.includes('tool.id'));
  assert.ok(fields.includes('test.network'));
  assert.ok(issues.every((i) => i.fix));
});

test('workhub.yaml 驗證：退回端點、寫入環境變數值都拒絕；approvedEndpoint 改由平台指定，只提醒', () => {
  const m = MANIFEST.replace('model:\n  uses: false', 'model:\n  uses: true\n  approvedEndpoint: random-cloud\n  fallback: ollama')
    .replace('optional: []', 'optional:\n    - name: OPENAI_API_KEY\n      value: abc');
  const r = inspectZip(validZip([], m), cfg);
  const fields = r.issues.map((i) => i.field);
  assert.ok(!fields.includes('model.approvedEndpoint'));
  assert.ok(r.warnings.some((w) => w.field === 'model.approvedEndpoint'));
  assert.ok(fields.includes('model.fallback'));
  assert.ok(fields.includes('env.optional[0]'));
});

test('workhub.yaml 驗證：未提供業務測試只發警告，宣告不支援本機架構則拒絕', () => {
  const noTest = MANIFEST.replace(/test:\n(?: {2}.*\n)+/, '');
  const r = inspectZip(validZip([], noTest), cfg);
  assert.deepEqual(r.issues, []);
  assert.ok(r.warnings.some((w) => w.field === 'test'));
  const other = cfg.hostPlatform === 'linux/arm64' ? 'linux/amd64' : 'linux/arm64';
  const wrong = MANIFEST.replace('platforms: [linux/arm64, linux/amd64]', `platforms: [${other}]`);
  assert.ok(inspectZip(validZip([], wrong), cfg).issues.some((i) => i.field === 'build.platforms'));
});

test('漏洞清單：同一 CVE 合併、CRITICAL 與有修正版者優先、附中文類型', async () => {
  const { vulnerabilityList } = await import('../src/pipeline.ts');
  const list = vulnerabilityList({ Results: [{ Vulnerabilities: [
    { VulnerabilityID: 'CVE-B', PkgName: 'mount', InstalledVersion: '1', Severity: 'HIGH', Title: 'util-linux: privilege escalation via mount helper' },
    { VulnerabilityID: 'CVE-B', PkgName: 'libmount1', InstalledVersion: '1', Severity: 'HIGH', Title: 'util-linux: privilege escalation via mount helper' },
    { VulnerabilityID: 'CVE-C', PkgName: 'urllib3', InstalledVersion: '2.7.0', FixedVersion: '2.8.0', Severity: 'HIGH', Title: 'urllib3: Denial of Service via unbounded memory allocation' },
    { VulnerabilityID: 'CVE-A', PkgName: 'libxml2', InstalledVersion: '2.9', Severity: 'CRITICAL', Title: 'libxml2: Denial of Service via crafted XML input due to use-after-free', PrimaryURL: 'https://avd.aquasec.com/nvd/cve-a' },
  ] }] });
  assert.deepEqual(list.map((v) => v.id), ['CVE-A', 'CVE-C', 'CVE-B']);
  assert.equal(list[2].packages.length, 2);
  assert.equal(list[0].category, '阻斷服務（可能使程式當掉）');
  assert.equal(list[2].category, '權限提升');
  assert.equal(list[1].fixable, true);
  assert.equal(list[0].url, 'https://avd.aquasec.com/nvd/cve-a');
});
