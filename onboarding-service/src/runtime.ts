/**
 * 容器執行介面。正式實作呼叫 docker／trivy CLI；測試以假實作替換。
 * 送審容器一律：不掛主機目錄、不掛 Docker socket、cap-drop ALL、no-new-privileges、只綁 127.0.0.1。
 */
import { createServer } from 'node:net';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { run, type ExecResult } from './exec.ts';
import type { Config } from './config.ts';

export type Ctx = { logFile: string; signal: AbortSignal; mask: (s: string) => string };

export type ServiceSpec = {
  image: string;
  name: string;
  labels: Record<string, string>;
  hostPort: number;
  containerPort: number;
  volume?: string;
  mountPath?: string;
  env: Record<string, string>;
  memoryBytes: number;
  cpus: string;
  command?: string[];
  /** none＝完全斷網（業務測試）；wh-net-<tool>＝工具專屬隔離網路，只連得到模型轉接服務 */
  network: string;
  /** 正式發布：Docker 重啟後自動恢復 */
  restart?: boolean;
};

export interface Runtime {
  available(): Promise<{ docker: boolean; trivy: boolean; detail: string }>;
  build(contextDir: string, dockerfile: string, tag: string, labels: Record<string, string>, platform: string, timeoutMs: number, ctx: Ctx): Promise<{ ok: boolean; digest?: string; result: ExecResult }>;
  scan(image: string, outFile: string, timeoutMs: number, ctx: Ctx): Promise<{ available: boolean; ok: boolean; json?: unknown; result?: ExecResult }>;
  runOnce(spec: Omit<ServiceSpec, 'hostPort' | 'containerPort'>, timeoutMs: number, ctx: Ctx): Promise<ExecResult>;
  start(spec: ServiceSpec, ctx: Ctx): Promise<ExecResult>;
  remove(name: string, ctx?: Ctx): Promise<void>;
  stop(name: string, ctx?: Ctx): Promise<void>;
  /** 以平台自帶的 busybox 小映像備份／還原資料卷（不使用提交的 image） */
  backupVolume(volume: string, file: string, ctx: Ctx): Promise<boolean>;
  /** URL 工具：檢查網址能否連上（逐步跟隨轉址，最多 5 次） */
  checkUrl(url: string): Promise<import('./url-tools.ts').UrlCheck>;
  /** 向模型端點查詢模型清單（GET <base>/models）；金鑰只在服務端使用 */
  listModels(base: string, key: string): Promise<{ ok: true; ids: string[] } | { ok: false; error: string }>;
  restoreVolume(volume: string, file: string, ctx: Ctx): Promise<boolean>;
  removeVolume(name: string, ctx?: Ctx): Promise<void>;
  logs(name: string, ctx: Ctx): Promise<void>;
  probe(url: string): Promise<number | null>;
  /** 建立隔離網路（--internal：無對外路由） */
  ensureNetwork(name: string, internal: boolean, ctx?: Ctx): Promise<boolean>;
  /** 重啟容器（資料保留） */
  restart(name: string, ctx?: Ctx): Promise<ExecResult>;
  /** 讀取容器最近的日誌（已遮罩） */
  logsText(name: string, tail: number, mask: (s: string) => string): Promise<string>;
  /** 確保模型轉接服務容器在跑、設定一致，並接上所有工具的隔離網路 */
  ensureRelay(spec: RelaySpec, ctx?: Ctx): Promise<{ ok: boolean; detail: string }>;
}

export type RelaySpec = { name: string; image: string; script: string; logsDir: string; routesDir: string; env: Record<string, string>; hash: string; networks: string[]; alias: string };

export function freePort(): Promise<number> {
  return new Promise((res, rej) => {
    const s = createServer();
    s.once('error', rej);
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => res(port));
    });
  });
}

export function portInUse(port: number): Promise<boolean> {
  return new Promise((res) => {
    const s = createServer();
    s.once('error', () => res(true));
    s.listen(port, '127.0.0.1', () => s.close(() => res(false)));
  });
}

const GATEWAY_SCRIPT = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'relay', 'tcp_gateway.py');
/** 隔離網路上的工具由入口轉接容器 <name>-gw 開放本機埠 */
export const gatewayName = (name: string) => `${name}-gw`;
const isolated = (network: string) => network !== 'none' && network !== 'bridge';

function hardening(): string[] {
  return ['--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--pids-limit', '512'];
}

export class DockerRuntime implements Runtime {
  cfg: Config;
  constructor(cfg: Config) { this.cfg = cfg; }

  async available() {
    const d = await run(this.cfg.docker, ['version', '--format', '{{.Server.Version}} {{.Server.Arch}}'], { timeoutMs: 20000 });
    const t = await run(this.cfg.trivy, ['--version'], { timeoutMs: 20000 });
    return { docker: d.code === 0, trivy: t.code === 0, detail: `docker ${d.stdout.trim() || d.stderr.trim().slice(0, 120)} / trivy ${t.stdout.split('\n')[0] || 'unavailable'}` };
  }

  async build(contextDir: string, dockerfile: string, tag: string, labels: Record<string, string>, platform: string, timeoutMs: number, ctx: Ctx) {
    const args = ['build', '--platform', platform, '-f', dockerfile, '-t', tag, '--progress', 'plain'];
    for (const [k, v] of Object.entries(labels)) args.push('--label', `${k}=${v}`);
    args.push(contextDir);
    const result = await run(this.cfg.docker, args, { timeoutMs, signal: ctx.signal, logFile: ctx.logFile, mask: ctx.mask });
    if (result.code !== 0) return { ok: false, result };
    const ins = await run(this.cfg.docker, ['image', 'inspect', '--format', '{{.Id}}', tag], { timeoutMs: 30000 });
    return { ok: ins.code === 0, digest: ins.stdout.trim(), result };
  }

  async scan(image: string, outFile: string, timeoutMs: number, ctx: Ctx) {
    const v = await run(this.cfg.trivy, ['--version'], { timeoutMs: 20000 });
    if (v.code !== 0) return { available: false, ok: false };
    const result = await run(this.cfg.trivy, ['image', '--quiet', '--scanners', 'vuln', '--severity', 'HIGH,CRITICAL', '--format', 'json', '--output', outFile, '--timeout', `${Math.floor(timeoutMs / 60000)}m`, image],
      { timeoutMs, signal: ctx.signal, logFile: ctx.logFile, mask: ctx.mask });
    if (result.code !== 0) return { available: true, ok: false, result };
    const { readFileSync } = await import('node:fs');
    return { available: true, ok: true, json: JSON.parse(readFileSync(outFile, 'utf8')), result };
  }

  private baseArgs(spec: Omit<ServiceSpec, 'hostPort' | 'containerPort'>): string[] {
    const args = ['--name', spec.name, ...hardening(), '--memory', String(spec.memoryBytes), '--cpus', spec.cpus, '--network', spec.network];
    for (const [k, v] of Object.entries(spec.labels)) args.push('--label', `${k}=${v}`);
    if ((spec as ServiceSpec).restart) args.push('--restart', 'unless-stopped');
    if (spec.volume && spec.mountPath) args.push('-v', `${spec.volume}:${spec.mountPath}`);
    for (const k of Object.keys(spec.env)) args.push('-e', k); // 值經由子程序環境傳入，不出現在命令列
    return args;
  }

  async runOnce(spec: Omit<ServiceSpec, 'hostPort' | 'containerPort'>, timeoutMs: number, ctx: Ctx) {
    await this.remove(spec.name);
    const args = ['run', '--rm', ...this.baseArgs(spec), spec.image, ...(spec.command ?? [])];
    return run(this.cfg.docker, args, {
      timeoutMs, signal: ctx.signal, logFile: ctx.logFile, mask: ctx.mask,
      env: { ...process.env, ...spec.env },
      onAbort: () => { void run(this.cfg.docker, ['rm', '-f', spec.name], { timeoutMs: 30000 }); },
    });
  }

  async start(spec: ServiceSpec, ctx: Ctx) {
    await this.remove(spec.name);
    const opts = { timeoutMs: 120000, signal: ctx.signal, logFile: ctx.logFile, mask: ctx.mask };
    if (!isolated(spec.network)) {
      const args = ['run', '-d', ...this.baseArgs(spec), '-p', `127.0.0.1:${spec.hostPort}:${spec.containerPort}`, spec.image, ...(spec.command ?? [])];
      return run(this.cfg.docker, args, { ...opts, env: { ...process.env, ...spec.env } });
    }
    // 隔離網路：工具本身不開埠；由平台的入口轉接容器（一邊本機埠、一邊工具網路）只做 TCP 轉送
    if (!(await this.ensureImage(this.cfg.relay.image, ctx))) return { code: 1, timedOut: false, cancelled: false, stdout: '', stderr: `無法取得入口轉接映像 ${this.cfg.relay.image}` };
    const tool = await run(this.cfg.docker, ['run', '-d', ...this.baseArgs(spec), spec.image, ...(spec.command ?? [])], { ...opts, env: { ...process.env, ...spec.env } });
    if (tool.code !== 0) return tool;
    const gw = gatewayName(spec.name);
    const g = await run(this.cfg.docker, ['run', '-d', '--name', gw, ...hardening(), '--read-only', '--user', '10001:10001', '--memory', '64m', '--cpus', '0.25',
      '--network', 'bridge', '-p', `127.0.0.1:${spec.hostPort}:8000`, '--label', 'workhub.kind=gateway', '--label', `workhub.for=${spec.name}`,
      ...(spec.restart ? ['--restart', 'unless-stopped'] : []), '-v', `${GATEWAY_SCRIPT}:/app/tcp_gateway.py:ro`,
      this.cfg.relay.image, 'python', '-I', '/app/tcp_gateway.py', spec.name, String(spec.containerPort)], opts);
    if (g.code !== 0) return { ...g, stderr: `入口轉接啟動失敗：${g.stderr}` };
    const c = await run(this.cfg.docker, ['network', 'connect', spec.network, gw], opts);
    if (c.code !== 0) return { ...c, stderr: `入口轉接無法接上 ${spec.network}：${c.stderr}` };
    return tool;
  }

  async remove(name: string, ctx?: Ctx) {
    await run(this.cfg.docker, ['rm', '-f', gatewayName(name), name], { timeoutMs: 60000, logFile: ctx?.logFile, mask: ctx?.mask });
  }

  async stop(name: string, ctx?: Ctx) {
    await run(this.cfg.docker, ['stop', '-t', '20', gatewayName(name), name], { timeoutMs: 60000, logFile: ctx?.logFile, mask: ctx?.mask });
  }

  async backupVolume(volume: string, file: string, ctx: Ctx) {
    const { dirname, basename } = await import('node:path');
    const { mkdirSync } = await import('node:fs');
    mkdirSync(dirname(file), { recursive: true });
    const r = await run(this.cfg.docker, ['run', '--rm', '--network', 'none', '-v', `${volume}:/vol:ro`, '-v', `${dirname(file)}:/backup`, this.cfg.helperImage,
      'tar', 'czf', `/backup/${basename(file)}`, '-C', '/vol', '.'], { timeoutMs: 10 * 60 * 1000, signal: ctx.signal, logFile: ctx.logFile, mask: ctx.mask });
    return r.code === 0;
  }

  async restoreVolume(volume: string, file: string, ctx: Ctx) {
    const { dirname, basename } = await import('node:path');
    const r = await run(this.cfg.docker, ['run', '--rm', '--network', 'none', '-v', `${volume}:/vol`, '-v', `${dirname(file)}:/backup:ro`, this.cfg.helperImage,
      'sh', '-c', `find /vol -mindepth 1 -delete && tar xzf /backup/${basename(file)} -C /vol`], { timeoutMs: 10 * 60 * 1000, signal: ctx.signal, logFile: ctx.logFile, mask: ctx.mask });
    return r.code === 0;
  }

  async removeVolume(name: string, ctx?: Ctx) {
    await run(this.cfg.docker, ['volume', 'rm', '-f', name], { timeoutMs: 60000, logFile: ctx?.logFile, mask: ctx?.mask });
  }

  async restart(name: string, ctx?: Ctx) {
    return run(this.cfg.docker, ['restart', '-t', '20', name], { timeoutMs: 120000, logFile: ctx?.logFile, mask: ctx?.mask });
  }

  async logsText(name: string, tail: number, mask: (s: string) => string) {
    const r = await run(this.cfg.docker, ['logs', '--timestamps', '--tail', String(tail), name], { timeoutMs: 30000 });
    return mask(r.code === 0 ? `${r.stdout}${r.stderr}` : `無法讀取日誌：${r.stderr.slice(0, 300)}`);
  }

  async logs(name: string, ctx: Ctx) {
    await run(this.cfg.docker, ['logs', '--tail', '200', name], { timeoutMs: 30000, logFile: ctx.logFile, mask: ctx.mask });
  }

  async ensureNetwork(name: string, internal: boolean, ctx?: Ctx) {
    const ins = await run(this.cfg.docker, ['network', 'inspect', '--format', '{{.Internal}}', name], { timeoutMs: 20000 });
    if (ins.code === 0) {
      if ((ins.stdout.trim() === 'true') === internal) return true;
      // 設定改變（隔離 ↔ 可連外）：網路上沒有容器時重建
      await run(this.cfg.docker, ['network', 'rm', name], { timeoutMs: 30000, logFile: ctx?.logFile, mask: ctx?.mask });
    }
    const r = await run(this.cfg.docker, ['network', 'create', ...(internal ? ['--internal'] : []), '--label', 'workhub.kind=tool-network', name], { timeoutMs: 30000, logFile: ctx?.logFile, mask: ctx?.mask });
    return r.code === 0;
  }

  /** 平台自己用的映像（轉接服務、入口轉接）不在本機時先下載 */
  private async ensureImage(image: string, ctx?: Ctx) {
    const ins = await run(this.cfg.docker, ['image', 'inspect', '--format', '{{.Id}}', image], { timeoutMs: 20000 });
    if (ins.code === 0) return true;
    const p = await run(this.cfg.docker, ['pull', image], { timeoutMs: 10 * 60 * 1000, logFile: ctx?.logFile, mask: ctx?.mask });
    return p.code === 0;
  }

  async ensureRelay(spec: RelaySpec, ctx?: Ctx) {
    const d = this.cfg.docker;
    const opts = { timeoutMs: 60000, logFile: ctx?.logFile, mask: ctx?.mask };
    if (!(await this.ensureImage(spec.image, ctx))) return { ok: false, detail: `無法取得轉接服務映像 ${spec.image}` };
    const ins = await run(d, ['inspect', '--format', '{{index .Config.Labels "workhub.relay-hash"}} {{.State.Running}}', spec.name], { timeoutMs: 20000 });
    const [hash, running] = ins.stdout.trim().split(' ');
    if (ins.code !== 0 || hash !== spec.hash || running !== 'true') {
      await run(d, ['rm', '-f', spec.name], opts);
      const { mkdirSync } = await import('node:fs');
      mkdirSync(spec.logsDir, { recursive: true });
      mkdirSync(spec.routesDir, { recursive: true });
      const args = ['run', '-d', '--name', spec.name, '--restart', 'unless-stopped', ...hardening(), '--read-only', '--user', '10001:10001',
        '--memory', '256m', '--cpus', '0.5', '--network', 'bridge', '--label', 'workhub.kind=llm-relay', '--label', `workhub.relay-hash=${spec.hash}`,
        '-v', `${spec.script}:/app/llm_relay.py:ro`, '-v', `${spec.logsDir}:/logs`, '-v', `${spec.routesDir}:/routes:ro`];
      for (const k of Object.keys(spec.env)) args.push('-e', k); // 金鑰經子程序環境傳入，不出現在命令列
      args.push(spec.image, 'python', '-I', '/app/llm_relay.py');
      const r = await run(d, args, { ...opts, env: { ...process.env, ...spec.env } });
      if (r.code !== 0) return { ok: false, detail: `轉接服務啟動失敗：${r.stderr.slice(0, 200)}` };
    }
    const nets = await run(d, ['inspect', '--format', '{{range $k, $v := .NetworkSettings.Networks}}{{$k}} {{end}}', spec.name], { timeoutMs: 20000 });
    const joined = new Set(nets.stdout.trim().split(/\s+/));
    for (const n of spec.networks) {
      if (joined.has(n)) continue;
      const c = await run(d, ['network', 'connect', '--alias', spec.alias, n, spec.name], opts);
      if (c.code !== 0) return { ok: false, detail: `轉接服務無法接上 ${n}：${c.stderr.slice(0, 200)}` };
    }
    return { ok: true, detail: `轉接服務運作中（${spec.networks.length} 個工具網路）` };
  }

  async listModels(base: string, key: string) {
    try {
      const res = await fetch(`${base.replace(/\/$/, '')}/models`, { headers: { Authorization: `Bearer ${key}`, 'User-Agent': 'WorkHub-Onboarding/0.1' }, signal: AbortSignal.timeout(10000) });
      if (res.status !== 200) return { ok: false as const, error: `端點回應 HTTP ${res.status}` };
      const j = await res.json() as { data?: { id: string }[] };
      return { ok: true as const, ids: (j.data ?? []).map((m) => m.id).filter(Boolean) };
    } catch (e) {
      return { ok: false as const, error: (e as Error).name === 'TimeoutError' ? '連線逾時' : '連不到模型端點' };
    }
  }

  async checkUrl(url: string) {
    const t0 = Date.now();
    const redirects: string[] = [];
    let current = url;
    try {
      for (let i = 0; i < 6; i++) {
        const r = await fetch(current, { method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(10000), headers: { 'User-Agent': 'WorkHub-URL-Check/0.1' } });
        const loc = r.headers.get('location');
        if (r.status >= 300 && r.status < 400 && loc && i < 5) { current = new URL(loc, current).href; redirects.push(current); continue; }
        return { reachable: true, status: r.status, finalUrl: current, redirects, tls: current.startsWith('https:') ? 'ok' as const : 'n/a' as const, ms: Date.now() - t0 };
      }
      return { reachable: true, status: null, finalUrl: current, redirects, tls: 'n/a' as const, error: '轉址次數過多', ms: Date.now() - t0 };
    } catch (e) {
      const cause = (e as { cause?: { code?: string; message?: string } }).cause;
      const tlsErr = /CERT|SSL|TLS/i.test(`${cause?.code ?? ''} ${cause?.message ?? ''}`);
      return { reachable: false, status: null, finalUrl: current, redirects, tls: tlsErr ? 'error' as const : current.startsWith('https:') ? 'n/a' as const : 'n/a' as const, error: cause?.code ?? (e as Error).message, ms: Date.now() - t0 };
    }
  }

  async probe(url: string) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(4000), redirect: 'manual' });
      return r.status;
    } catch {
      return null;
    }
  }
}
