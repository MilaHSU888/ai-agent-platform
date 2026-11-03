/**
 * 測試資料「測完即刪」（2026/11/03，A2）：
 * - 測試資料和程式碼分開存放在 <資料目錄>/testdata/<打包編號>/，不放進 ZIP，也不放進工具映像檔。
 * - 業務測試時才以唯讀方式掛進測試容器（例如 /app/tests/fixtures）。
 * - 工具切到「公開中」後刪除；審核履歷只記檔名、檢查碼與刪除時間，不記內容。
 */
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { Config } from '../config.ts';
import { now, type Store } from '../db.ts';

export type TestDataInfo = { dir: string; mounts: { from: string; target: string }[]; files: { path: string; sha256: string; size: number }[]; purgedAt?: string };

/** 業務測試要掛上的資料夾（主機路徑、容器路徑）；已刪除或不存在時回傳空陣列 */
export function testDataBinds(cfg: Config, json: string | null | undefined): { host: string; target: string }[] {
  if (!json) return [];
  const t = JSON.parse(json) as TestDataInfo;
  if (t.purgedAt) return [];
  return t.mounts.map((m) => ({ host: join(cfg.dataDir, t.dir, m.from), target: m.target })).filter((b) => existsSync(b.host));
}

/** 工具公開後刪除這個工具所有提交的測試資料（只刪資料，紀錄保留） */
export function purgeTestData(store: Store, cfg: Config, toolId: string, actor: string): number {
  const rows = store.all<{ id: string; version: string; testdata_json: string | null }>('SELECT id, version, testdata_json FROM submissions WHERE tool_id=? AND testdata_json IS NOT NULL', toolId);
  let n = 0;
  for (const r of rows) {
    const t = JSON.parse(r.testdata_json!) as TestDataInfo;
    if (t.purgedAt) continue;
    rmSync(join(cfg.dataDir, t.dir), { recursive: true, force: true });
    t.purgedAt = now();
    store.tx(() => {
      store.run('UPDATE submissions SET testdata_json=? WHERE id=?', JSON.stringify(t), r.id);
      store.audit(actor, 'testdata.deleted', r.id, { tool: toolId, version: r.version, files: t.files.map((f) => ({ path: f.path, sha256: f.sha256 })), reason: '工具已公開' });
    });
    n++;
  }
  return n;
}
