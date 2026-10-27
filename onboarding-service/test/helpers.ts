import { deflateRawSync, crc32 } from 'node:zlib';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, type Config } from '../src/config.ts';
import type { ExecResult } from '../src/exec.ts';
import type { Ctx, RelaySpec, Runtime, ServiceSpec } from '../src/runtime.ts';

export type ZipFile = { name: string; data?: string | Buffer; symlink?: boolean; store?: boolean; lieSize?: number };

/** 產生測試用 ZIP（可做出符號連結、謊報大小等惡意情境） */
export function makeZip(files: ZipFile[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const f of files) {
    const name = Buffer.from(f.name, 'utf8');
    const data = Buffer.isBuffer(f.data) ? f.data : Buffer.from(f.data ?? '', 'utf8');
    const isDir = f.name.endsWith('/');
    const method = f.store || isDir ? 0 : 8;
    const comp = method === 8 ? deflateRawSync(data) : data;
    const crc = crc32(data) >>> 0;
    const size = f.lieSize ?? data.length;
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x0800, 6); lh.writeUInt16LE(method, 8);
    lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(size, 22); lh.writeUInt16LE(name.length, 26);
    locals.push(lh, name, comp);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE((3 << 8) | 20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(0x0800, 8);
    ch.writeUInt16LE(method, 10); ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(comp.length, 20); ch.writeUInt32LE(size, 24);
    ch.writeUInt16LE(name.length, 28);
    const mode = f.symlink ? 0o120777 : isDir ? 0o040755 : 0o100644;
    ch.writeUInt32LE((mode << 16) >>> 0, 38); ch.writeUInt32LE(offset, 42);
    centrals.push(ch, name);
    offset += 30 + name.length + comp.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(files.length, 8); eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(cd.length, 12); eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}

export const MANIFEST = `schemaVersion: workhub/v1
tool:
  id: demo-tool
  name: 示範工具
  version: 1.0.0
  description: 測試用
build:
  dockerfile: Dockerfile
  context: .
  platforms: [linux/arm64, linux/amd64]
run:
  port: 8080
  healthCheck:
    path: /health
    expectStatus: 200
    startPeriodSeconds: 1
  persistentData:
    - path: /data
      purpose: 資料
  resources:
    cpu: "1"
    memory: 256Mi
test:
  command: ["npm", "test"]
  timeoutSeconds: 60
  network: none
env:
  required: []
  optional: []
model:
  uses: false
`;

export function validZip(extra: ZipFile[] = [], manifest = MANIFEST): Buffer {
  return makeZip([
    { name: 'workhub.yaml', data: manifest },
    { name: 'Dockerfile', data: 'FROM node:22-alpine\nCOPY . .\nCMD ["node","server.js"]\n' },
    { name: 'server.js', data: 'console.log("hi")\n' },
    ...extra,
  ]);
}

export function testConfig(overrides: Partial<Config> = {}): Config {
  const dataDir = mkdtempSync(join(tmpdir(), 'wh-onb-'));
  return loadConfig({ dataDir, port: 4399, ...overrides });
}

const ok = (stdout = ''): ExecResult => ({ code: 0, timedOut: false, cancelled: false, stdout, stderr: '' });

export type FakeOpts = { build?: boolean; trivy?: 'clean' | 'critical' | 'missing'; healthy?: boolean; businessExit?: number; slowBuildMs?: number; badImages?: Set<string>; backupOk?: boolean; urlReachable?: boolean };

export class FakeRuntime implements Runtime {
  opts: FakeOpts;
  started: ServiceSpec[] = [];
  ran: Omit<ServiceSpec, 'hostPort' | 'containerPort'>[] = [];
  removed: string[] = [];
  running = new Map<string, ServiceSpec>();
  stopped: string[] = [];
  backups: string[] = [];
  restores: string[] = [];
  networks = new Map<string, boolean>();
  relays: RelaySpec[] = [];
  constructor(opts: FakeOpts = {}) { this.opts = { build: true, trivy: 'clean', healthy: true, businessExit: 0, badImages: new Set(), backupOk: true, ...opts }; }
  async available() { return { docker: true, trivy: this.opts.trivy !== 'missing', detail: 'fake' }; }
  async build(_c: string, _d: string, tag: string, _l: Record<string, string>, _p: string, _t: number, ctx: Ctx) {
    if (this.opts.slowBuildMs) {
      await new Promise<void>((r) => {
        const t = setTimeout(r, this.opts.slowBuildMs);
        ctx.signal.addEventListener('abort', () => { clearTimeout(t); r(); }, { once: true });
      });
      if (ctx.signal.aborted) return { ok: false, result: { ...ok(), code: null, cancelled: true } };
    }
    return this.opts.build ? { ok: true, digest: `sha256:${Buffer.from(tag).toString('hex').slice(-40)}`, result: ok() } : { ok: false, result: { ...ok(), code: 1 } };
  }
  async scan() {
    if (this.opts.trivy === 'missing') return { available: false, ok: false };
    const vulns = this.opts.trivy === 'critical'
      ? [{ VulnerabilityID: 'CVE-2026-6653', PkgName: 'libxml2', InstalledVersion: '2.9', Severity: 'CRITICAL', Title: 'x' }, { VulnerabilityID: 'CVE-1', PkgName: 'a', InstalledVersion: '1', Severity: 'HIGH' }]
      : [{ VulnerabilityID: 'CVE-1', PkgName: 'a', InstalledVersion: '1', Severity: 'HIGH' }];
    return { available: true, ok: true, json: { Results: [{ Vulnerabilities: vulns }] } };
  }
  async runOnce(spec: Omit<ServiceSpec, 'hostPort' | 'containerPort'>) { this.ran.push(spec); return { ...ok('1 passed'), code: this.opts.businessExit ?? 0 }; }
  async start(spec: ServiceSpec) { this.started.push(spec); this.running.set(spec.name, spec); return ok('cid'); }
  async remove(name: string) { this.removed.push(name); this.running.delete(name); }
  async stop(name: string) { this.stopped.push(name); this.running.delete(name); }
  async backupVolume(volume: string, file: string) { this.backups.push(file); return this.opts.backupOk ?? true; }
  async restoreVolume(volume: string, file: string) { this.restores.push(file); return true; }
  async removeVolume(name: string) { this.removed.push(name); }
  async logs() { /* noop */ }
  restarted: string[] = [];
  async restart(name: string) { this.restarted.push(name); return ok(); }
  async logsText(name: string, tail: number, mask: (s: string) => string) { return mask(`fake log for ${name} (${tail}) Bearer whr_secret_token_value`); }
  async ensureNetwork(name: string, internal: boolean) { this.networks.set(name, internal); return true; }
  async ensureRelay(spec: RelaySpec) { this.relays.push(spec); return { ok: true, detail: 'fake relay' }; }
  urlChecks: string[] = [];
  async checkUrl(url: string) {
    this.urlChecks.push(url);
    return this.opts.urlReachable === false
      ? { reachable: false, status: null, finalUrl: url, redirects: [], tls: 'n/a' as const, error: 'ENOTFOUND', ms: 5 }
      : { reachable: true, status: 200, finalUrl: url, redirects: [], tls: url.startsWith('https:') ? 'ok' as const : 'n/a' as const, ms: 5 };
  }
  async probe(url: string) {
    if (!/^http:\/\/127\.0\.0\.1:/.test(url)) return this.opts.urlReachable === false ? null : 200;
    const port = Number(new URL(url).port);
    const spec = [...this.running.values()].find((s) => s.hostPort === port);
    if (spec && this.opts.badImages?.has(spec.image)) return 503;
    return this.opts.healthy ? 200 : 503;
  }
}
