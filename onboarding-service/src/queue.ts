/** 單工執行器：同一時間只跑一個工作；工作狀態全在 SQLite，不依賴瀏覽器保持開啟。 */
import type { Config } from './config.ts';
import { now, type Store } from './db.ts';
import { runVerifyJob } from './pipeline.ts';
import type { Runtime } from './runtime.ts';
import type { Secrets } from './secrets.ts';

export class JobQueue {
  store: Store; cfg: Config; rt: Runtime; secrets: Secrets;
  current: { id: string; ctrl: AbortController } | null = null;
  timer: NodeJS.Timeout | null = null;
  stopped = false;
  idle: Promise<void> = Promise.resolve();
  extraKinds: Record<string, (jobId: string, signal: AbortSignal) => Promise<void>> = {};

  constructor(store: Store, cfg: Config, rt: Runtime, secrets: Secrets) {
    this.store = store; this.cfg = cfg; this.rt = rt; this.secrets = secrets;
  }

  start(intervalMs = 1000) {
    this.timer = setInterval(() => { void this.tick(); }, intervalMs);
    this.timer.unref();
    void this.tick();
  }

  stop() {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.current?.ctrl.abort();
  }

  async tick() {
    if (this.current || this.stopped) {
      // 輪詢取消旗標（例如提交被新修訂取代）
      if (this.current) {
        const j = this.store.get<{ cancel_requested: number }>('SELECT cancel_requested FROM jobs WHERE id=?', this.current.id);
        if (j?.cancel_requested) this.current.ctrl.abort();
      }
      return;
    }
    const next = this.store.get<{ id: string; kind: string; cancel_requested: number; submission_id: string }>(
      "SELECT id, kind, cancel_requested, submission_id FROM jobs WHERE status='queued' ORDER BY created_at LIMIT 1");
    if (!next) return;
    if (next.cancel_requested) {
      this.store.run("UPDATE jobs SET status='cancelled', finished_at=? WHERE id=?", now(), next.id);
      const s = this.store.get<{ status: string }>('SELECT status FROM submissions WHERE id=?', next.submission_id);
      if (s && !['superseded', 'withdrawn'].includes(s.status)) this.store.setSubmissionStatus(next.submission_id, 'cancelled');
      return;
    }
    const ctrl = new AbortController();
    this.current = { id: next.id, ctrl };
    let resolveIdle!: () => void;
    this.idle = new Promise((r) => { resolveIdle = r; });
    try {
      if (next.kind === 'verify') await runVerifyJob(this.store, this.cfg, this.rt, this.secrets, next.id, ctrl.signal);
      else if (this.extraKinds[next.kind]) await this.extraKinds[next.kind](next.id, ctrl.signal);
      else this.store.run("UPDATE jobs SET status='failed', error=?, finished_at=? WHERE id=?", `未知的工作類型：${next.kind}`, now(), next.id);
    } catch (e) {
      this.store.run("UPDATE jobs SET status='failed', error=?, finished_at=? WHERE id=?", (e as Error).message, now(), next.id);
    } finally {
      this.current = null;
      resolveIdle();
    }
  }

  cancel(jobId: string): boolean {
    const j = this.store.get<{ status: string }>('SELECT status FROM jobs WHERE id=?', jobId);
    if (!j || !['queued', 'running'].includes(j.status)) return false;
    this.store.run('UPDATE jobs SET cancel_requested=1 WHERE id=?', jobId);
    if (this.current?.id === jobId) this.current.ctrl.abort();
    return true;
  }
}
