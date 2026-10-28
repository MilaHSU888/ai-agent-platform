/**
 * 模型用量統計（DEC-040）：彙整轉接服務的中繼資料日誌（relay-logs/relay-YYYYMMDD.jsonl）。
 * 日誌只有工具、模型、狀態、耗時與 token 數，沒有提示詞或回應內容；只算得出「哪個工具」，算不出「哪個使用者」。
 * 串流回應沒有 token 數（上游不在串流中回報），只計次數與耗時。
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Config } from './config.ts';
import type { Store } from './db.ts';
import { locationOf } from './models.ts';
import type { Secrets } from './secrets.ts';

type Entry = { ts: string; tool?: string | null; model?: string | null; endpoint?: string | null; path?: string; method?: string; status?: number; error?: string; ms?: number; prompt_tokens?: number | null; completion_tokens?: number | null };
type Agg = { calls: number; errors: number; promptTokens: number; completionTokens: number; totalMs: number; timed: number };
const blank = (): Agg => ({ calls: 0, errors: 0, promptTokens: 0, completionTokens: 0, totalMs: 0, timed: 0 });
const add = (a: Agg, e: Entry) => {
  a.calls++;
  if ((e.status ?? 0) >= 400 || e.error) a.errors++;
  a.promptTokens += e.prompt_tokens ?? 0;
  a.completionTokens += e.completion_tokens ?? 0;
  if (typeof e.ms === 'number') { a.totalMs += e.ms; a.timed++; }
};
const view = (a: Agg) => ({ calls: a.calls, errors: a.errors, promptTokens: a.promptTokens, completionTokens: a.completionTokens, tokens: a.promptTokens + a.completionTokens, avgMs: a.timed ? Math.round(a.totalMs / a.timed) : null });

/** 時區以台北（UTC+8）切日，跟網站顯示一致 */
const dayOf = (ts: string) => new Date(new Date(ts).getTime() + 8 * 3600_000).toISOString().slice(0, 10);

export function modelUsage(cfg: Config, store: Store, secrets: Secrets, opts: { hours: number; toolId?: string }) {
  const to = new Date();
  const from = new Date(to.getTime() - opts.hours * 3600_000);
  const dir = join(cfg.dataDir, 'relay-logs');
  const fromDay = from.toISOString().slice(0, 10).replace(/-/g, '');
  const files = existsSync(dir) ? readdirSync(dir).filter((f) => /^relay-\d{8}\.jsonl$/.test(f) && f.slice(6, 14) >= String(Number(fromDay) - 1)) : [];
  const names = Object.fromEntries(store.all<{ id: string; name: string }>('SELECT id, name FROM tools').map((t) => [t.id, t.name]));
  const total = blank(), local = blank(), cloud = blank();
  const byTool = new Map<string, Agg & { last: string; models: Set<string> }>();
  const byDay = new Map<string, Agg>();
  for (const f of files.sort()) {
    for (const line of readFileSync(join(dir, f), 'utf8').split('\n')) {
      if (!line.trim()) continue;
      let e: Entry;
      try { e = JSON.parse(line) as Entry; } catch { continue; }
      if (!e.tool || e.path !== '/v1/chat/completions' || !e.ts) continue;
      const t = new Date(e.ts);
      if (t < from || t > to) continue;
      if (opts.toolId && e.tool !== opts.toolId) continue;
      add(total, e);
      add(locationOf(secrets, e.endpoint ?? 'wisely-5090') === 'local' ? local : cloud, e); // 改版前的紀錄沒有 endpoint，當時只有 wisely-5090
      const bt = byTool.get(e.tool) ?? Object.assign(blank(), { last: e.ts, models: new Set<string>() });
      add(bt, e); if (e.ts > bt.last) bt.last = e.ts; if (e.model) bt.models.add(e.model);
      byTool.set(e.tool, bt);
      const d = dayOf(e.ts);
      const bd = byDay.get(d) ?? blank(); add(bd, e); byDay.set(d, bd);
    }
  }
  return {
    from: from.toISOString(), to: to.toISOString(), hours: opts.hours,
    totals: view(total), local: view(local), cloud: view(cloud),
    byTool: [...byTool.entries()].map(([toolId, a]) => ({ toolId, name: names[toolId] ?? toolId, ...view(a), lastAt: a.last, models: [...a.models] })).sort((a, b) => b.calls - a.calls),
    byDay: [...byDay.entries()].map(([date, a]) => ({ date, ...view(a) })).sort((a, b) => a.date.localeCompare(b.date)),
  };
}
