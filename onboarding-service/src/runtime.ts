/**
 * 容器執行介面。正式實作呼叫 docker／trivy CLI；測試以假實作替換。
 * 送審容器一律：不掛主機目錄、不掛 Docker socket、cap-drop ALL、no-new-privileges、只綁 127.0.0.1。
 */
import { createServer } from 'node:net';
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
  network: 'none' | 'bridge';
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
  restoreVolume(volume: string, file: string, ctx: Ctx): Promise<boolean>;
  removeVolume(name: string, ctx?: Ctx): Promise<void>;
  logs(name: string, ctx: Ctx): Promise<void>;
  probe(url: string): Promise<number | null>;
}

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
    const args = ['run', '-d', ...this.baseArgs(spec), '-p', `127.0.0.1:${spec.hostPort}:${spec.containerPort}`, spec.image, ...(spec.command ?? [])];
    return run(this.cfg.docker, args, { timeoutMs: 120000, signal: ctx.signal, logFile: ctx.logFile, mask: ctx.mask, env: { ...process.env, ...spec.env } });
  }

  async remove(name: string, ctx?: Ctx) {
    await run(this.cfg.docker, ['rm', '-f', name], { timeoutMs: 60000, logFile: ctx?.logFile, mask: ctx?.mask });
  }

  async stop(name: string, ctx?: Ctx) {
    await run(this.cfg.docker, ['stop', '-t', '20', name], { timeoutMs: 60000, logFile: ctx?.logFile, mask: ctx?.mask });
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

  async logs(name: string, ctx: Ctx) {
    await run(this.cfg.docker, ['logs', '--tail', '200', name], { timeoutMs: 30000, logFile: ctx.logFile, mask: ctx.mask });
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
