import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';

export type SubmissionStatus =
  | 'queued' | 'running' | 'failed' | 'cancelled' | 'interrupted'
  | 'awaiting_confirmation' | 'awaiting_approval' | 'approved' | 'released' | 'superseded' | 'withdrawn';

export type StepStatus =
  | 'pending' | 'running' | 'passed' | 'warning' | 'failed' | 'blocked' | 'skipped'
  | 'not_verified' | 'incomplete' | 'cancelled' | 'interrupted';

export const STEPS = ['validate', 'build', 'scan', 'ai_review', 'platform_test', 'business_test', 'preview'] as const;
export type StepName = (typeof STEPS)[number];

const SCHEMA = `
CREATE TABLE IF NOT EXISTS tools (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, department TEXT NOT NULL, owner TEXT NOT NULL,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS submissions (
  id TEXT PRIMARY KEY, tool_id TEXT NOT NULL REFERENCES tools(id), version TEXT NOT NULL,
  revision INTEGER NOT NULL, status TEXT NOT NULL, source_hash TEXT NOT NULL, source_path TEXT NOT NULL,
  original_filename TEXT NOT NULL, manifest_json TEXT NOT NULL, warnings_json TEXT NOT NULL,
  image_ref TEXT, image_digest TEXT, preview_port INTEGER, preview_container TEXT,
  created_by TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY, submission_id TEXT NOT NULL REFERENCES submissions(id), kind TEXT NOT NULL,
  status TEXT NOT NULL, current_step TEXT, error TEXT, cancel_requested INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL, started_at TEXT, finished_at TEXT
);
CREATE TABLE IF NOT EXISTS step_results (
  id TEXT PRIMARY KEY, job_id TEXT NOT NULL REFERENCES jobs(id), step TEXT NOT NULL, status TEXT NOT NULL,
  summary_json TEXT NOT NULL DEFAULT '{}', log_path TEXT, started_at TEXT, finished_at TEXT,
  UNIQUE(job_id, step)
);
CREATE TABLE IF NOT EXISTS approvals (
  id TEXT PRIMARY KEY, submission_id TEXT NOT NULL REFERENCES submissions(id), kind TEXT NOT NULL,
  subject TEXT, actor TEXT NOT NULL, reason TEXT NOT NULL, source_hash TEXT NOT NULL, image_digest TEXT,
  created_at TEXT NOT NULL, revoked_at TEXT
);
CREATE TABLE IF NOT EXISTS releases (
  id TEXT PRIMARY KEY, tool_id TEXT NOT NULL REFERENCES tools(id), submission_id TEXT NOT NULL REFERENCES submissions(id),
  image_digest TEXT NOT NULL, status TEXT NOT NULL, container_name TEXT, port INTEGER, volume TEXT,
  previous_release_id TEXT, detail_json TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS audit_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, actor TEXT NOT NULL, action TEXT NOT NULL,
  target TEXT, detail_json TEXT NOT NULL DEFAULT '{}'
);
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY, csrf TEXT NOT NULL, actor TEXT NOT NULL, created_at TEXT NOT NULL, expires_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS entry_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT, client_event_id TEXT NOT NULL UNIQUE, tool_id TEXT NOT NULL, kind TEXT NOT NULL,
  reason TEXT, release_id TEXT, version TEXT, actor TEXT NOT NULL, at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status);
CREATE INDEX IF NOT EXISTS idx_releases_tool ON releases(tool_id, status);
CREATE INDEX IF NOT EXISTS idx_sub_tool ON submissions(tool_id);
`;

export const now = () => new Date().toISOString();
export const newId = (prefix: string) => `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 16)}`;

export type Row = Record<string, unknown>;

export class Store {
  db: DatabaseSync;
  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
    this.db.exec(SCHEMA);
    // 既有資料庫遷移：發布／回復工作需記錄對應的 release
    const cols = this.all<{ name: string }>('PRAGMA table_info(jobs)').map((c) => c.name);
    if (!cols.includes('release_id')) this.db.exec('ALTER TABLE jobs ADD COLUMN release_id TEXT');
    // 維運：工具維護旗標（入口關閉、容器照跑）
    const tcols = this.all<{ name: string }>('PRAGMA table_info(tools)').map((c) => c.name);
    if (!tcols.includes('maintenance_json')) this.db.exec('ALTER TABLE tools ADD COLUMN maintenance_json TEXT');
  }

  get<T = Row>(sql: string, ...params: unknown[]): T | undefined {
    return this.db.prepare(sql).get(...(params as never[])) as T | undefined;
  }
  all<T = Row>(sql: string, ...params: unknown[]): T[] {
    return this.db.prepare(sql).all(...(params as never[])) as T[];
  }
  run(sql: string, ...params: unknown[]) {
    return this.db.prepare(sql).run(...(params as never[]));
  }
  tx<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const out = fn();
      this.db.exec('COMMIT');
      return out;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  audit(actor: string, action: string, target: string | null, detail: unknown = {}) {
    this.run('INSERT INTO audit_events(at,actor,action,target,detail_json) VALUES (?,?,?,?,?)',
      now(), actor, action, target, JSON.stringify(detail));
  }

  setSubmissionStatus(id: string, status: SubmissionStatus) {
    this.run('UPDATE submissions SET status=?, updated_at=? WHERE id=?', status, now(), id);
  }

  setStep(jobId: string, step: StepName, status: StepStatus, summary?: unknown, logPath?: string) {
    const existing = this.get<{ id: string }>('SELECT id FROM step_results WHERE job_id=? AND step=?', jobId, step);
    const t = now();
    if (!existing) {
      this.run('INSERT INTO step_results(id,job_id,step,status,summary_json,log_path,started_at,finished_at) VALUES (?,?,?,?,?,?,?,?)',
        newId('step'), jobId, step, status, JSON.stringify(summary ?? {}), logPath ?? null,
        status === 'pending' ? null : t, ['pending', 'running'].includes(status) ? null : t);
      return;
    }
    this.run(`UPDATE step_results SET status=?,
      summary_json=COALESCE(?,summary_json), log_path=COALESCE(?,log_path),
      started_at=CASE WHEN ?='running' THEN ? ELSE COALESCE(started_at, ?) END,
      finished_at=CASE WHEN ? IN ('pending','running') THEN NULL ELSE ? END
      WHERE id=?`,
      status, summary === undefined ? null : JSON.stringify(summary), logPath ?? null,
      status, t, t, status, t, existing.id);
  }

  /** 服務重啟時：執行中的工作一律標為中斷，不自動判成功。 */
  markInterrupted(actor: string): number {
    const running = this.all<{ id: string; submission_id: string }>("SELECT id, submission_id FROM jobs WHERE status='running'");
    for (const j of running) {
      this.tx(() => {
        this.run("UPDATE jobs SET status='interrupted', finished_at=?, error=? WHERE id=?", now(), '服務重啟時工作仍在執行，已標為中斷', j.id);
        this.run("UPDATE step_results SET status='interrupted', finished_at=? WHERE job_id=? AND status='running'", now(), j.id);
        this.setSubmissionStatus(j.submission_id, 'interrupted');
        this.audit(actor, 'job.interrupted', j.id, { submission: j.submission_id });
      });
    }
    return running.length;
  }
}
