/**
 * 給開發者（工具 Owner）的試用／公開提醒（2026/11/04，Mila）：
 * - 工具進入試用（新工具首次發布、或已公開工具的新版並行試用）→ 提醒「已可以開始試用」，開發者點了就消失、不再出現。
 * - AI Team 把同一個版本公開 → 再提醒一次「已公開」，一樣點了就消失。
 * 不在每個發布流程裡各寫一次，而是每次查詢提醒時依目前狀態補上（ref 唯一，不會重複）：
 *   試用中的工具＋版本 → trial:<tool>:<version>；曾有試用提醒、現在公開的同一版本 → published:<tool>:<version>。
 */
import { newId, now, type Store } from './db.ts';
import { activeRelease, trialRelease, visibilityOf } from './releases.ts';

const versionOf = (store: Store, subId: string) => store.get<{ version: string }>('SELECT version FROM submissions WHERE id=?', subId)?.version ?? '';

function add(store: Store, ref: string, toolId: string, owner: string, kind: string, message: string) {
  store.run('INSERT OR IGNORE INTO notices(id, tool_id, owner, kind, message, created_at, ref) VALUES (?,?,?,?,?,?,?)', newId('ntc'), toolId, owner, kind, message, now(), ref);
}

export function syncDeveloperNotices(store: Store) {
  const tools = store.all<{ id: string; name: string; owner: string }>('SELECT id, name, owner FROM tools WHERE archived_json IS NULL');
  store.tx(() => {
    for (const t of tools) {
      const parallel = trialRelease(store, t.id);
      const active = activeRelease(store, t.id);
      const vis = visibilityOf(store, t.id);
      // 試用中：已公開工具的新版試用版，或尚未公開、正在執行的工具
      const trialVersion = parallel ? versionOf(store, parallel.submission_id) : vis === 'trial' && active ? versionOf(store, active.submission_id) : '';
      if (trialVersion) add(store, `trial:${t.id}:${trialVersion}`, t.id, t.owner, 'trial', `${t.name} ${trialVersion} 已可以開始試用`);
      // 公開：目前公開的版本曾經試用過（有試用提醒）→ 通知已公開
      if (vis === 'public' && active) {
        const v = versionOf(store, active.submission_id);
        if (store.get('SELECT 1 FROM notices WHERE ref=?', `trial:${t.id}:${v}`)) add(store, `published:${t.id}:${v}`, t.id, t.owner, 'published', `${t.name} ${v} 已由 AI Team 公開，一般使用者現在可以使用`);
      }
    }
  });
}
