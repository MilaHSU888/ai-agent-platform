import { spawn } from 'node:child_process';
import { appendFileSync } from 'node:fs';

export type ExecResult = { code: number | null; timedOut: boolean; cancelled: boolean; stdout: string; stderr: string };

const MAX_CAPTURE = 4 * 1024 * 1024;

/** 遮罩：已知機密值一律替換，另外遮掉常見 token 樣式。日誌永遠不寫明文憑證。 */
export function makeMasker(secrets: string[]) {
  const values = secrets.filter((s) => s && s.length >= 6).sort((a, b) => b.length - a.length);
  return (text: string) => {
    let out = text;
    for (const v of values) out = out.split(v).join('****');
    return out
      .replace(/(Authorization:\s*Bearer\s+)[^\s"']+/gi, '$1****')
      .replace(/\bsk-[A-Za-z0-9_-]{12,}/g, 'sk-****')
      .replace(/\bBearer\s+[A-Za-z0-9._~+/-]{12,}/g, 'Bearer ****')
      .replace(/\bwhr_[A-Za-z0-9_-]{8,}/g, 'whr_****')
      .replace(/((?:api[_-]?key|token|secret|password)["']?\s*[:=]\s*["']?)[^\s"',]{8,}/gi, '$1****');
  };
}

export type RunOptions = {
  timeoutMs: number;
  signal?: AbortSignal;
  logFile?: string;
  mask?: (s: string) => string;
  env?: NodeJS.ProcessEnv;
  /** 逾時或取消時額外執行的清理（例如 docker rm -f） */
  onAbort?: () => void;
};

export function run(cmd: string, args: string[], opts: RunOptions): Promise<ExecResult> {
  const mask = opts.mask ?? ((s: string) => s);
  return new Promise((resolveP) => {
    if (opts.signal?.aborted) {
      resolveP({ code: null, timedOut: false, cancelled: true, stdout: '', stderr: 'cancelled before start' });
      return;
    }
    if (opts.logFile) appendFileSync(opts.logFile, mask(`$ ${[cmd, ...args].join(' ')}\n`));
    const child = spawn(cmd, args, { env: opts.env ?? process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let cancelled = false;
    const write = (chunk: Buffer, which: 'out' | 'err') => {
      const s = chunk.toString('utf8');
      if (which === 'out' && stdout.length < MAX_CAPTURE) stdout += s;
      if (which === 'err' && stderr.length < MAX_CAPTURE) stderr += s;
      if (opts.logFile) appendFileSync(opts.logFile, mask(s));
    };
    child.stdout.on('data', (c: Buffer) => write(c, 'out'));
    child.stderr.on('data', (c: Buffer) => write(c, 'err'));
    const kill = () => {
      try { child.kill('SIGTERM'); } catch { /* already gone */ }
      setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } }, 5000).unref();
      opts.onAbort?.();
    };
    const timer = setTimeout(() => { timedOut = true; kill(); }, opts.timeoutMs);
    const onAbort = () => { cancelled = true; kill(); };
    opts.signal?.addEventListener('abort', onAbort, { once: true });
    child.on('error', (err) => {
      stderr += String(err);
      if (opts.logFile) appendFileSync(opts.logFile, mask(`\n[spawn error] ${err.message}\n`));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
      if (opts.logFile) {
        appendFileSync(opts.logFile, `\n[exit ${code}${timedOut ? ' timeout' : ''}${cancelled ? ' cancelled' : ''}]\n`);
      }
      resolveP({ code, timedOut, cancelled, stdout: mask(stdout), stderr: mask(stderr) });
    });
  });
}
