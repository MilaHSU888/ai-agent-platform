/**
 * WorkHub 提交包預檢（離線、不需上傳）：與平台收件使用同一套檢查程式（inspectZip）。
 * 用法：node workhub-check.mjs <工具.zip>
 * 結束碼：0＝可以上傳（可能有提醒）；1＝會被平台拒收；2＝用法錯誤
 * 只做收件檢查（結構、禁止內容、workhub.yaml、密鑰掃描）；建置、健康檢查與業務測試請依 SOP 在本機另外驗證。
 */
import { readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { inspectZip } from '../src/intake.ts';
import { loadConfig } from '../src/config.ts';

const file = process.argv[2];
if (!file) { console.log('用法：node workhub-check.mjs <工具.zip>'); process.exit(2); }
let buf: Buffer;
try { if (!statSync(file).isFile()) throw new Error('不是檔案'); buf = readFileSync(file); }
catch (e) { console.log(`讀不到 ${file}：${(e as Error).message}`); process.exit(2); }

// 預檢以試點平台的條件為準（linux/arm64），不論在哪台電腦執行
const cfg = loadConfig({ dataDir: tmpdir(), hostPlatform: 'linux/arm64' });
const r = inspectZip(buf, cfg);
const line = (i: { file: string; field?: string; reason: string; fix: string }) => `  - ${i.file}${i.field ? ` · ${i.field}` : ''}：${i.reason}\n    → ${i.fix}`;
console.log(`WorkHub 提交包預檢（workhub/v1）：${file}`);
if (r.manifest) console.log(`工具 ${r.manifest.tool.id}${r.manifest.tool.name ? `（${r.manifest.tool.name}）` : ''}・埠 ${r.manifest.run.port}・健康檢查 ${r.manifest.run.healthCheck.path}・業務測試 ${r.manifest.test ? r.manifest.test.command.join(' ') : '未提供'}・模型 ${r.manifest.model.uses ? '使用（由 WorkHub 指定）' : '不使用'}`);
if (r.issues.length) {
  console.log(`\n✗ 會被拒收（${r.issues.length} 項）：`);
  console.log(r.issues.map(line).join('\n'));
}
if (r.warnings.length) {
  console.log(`\n! 提醒（${r.warnings.length} 項，不擋上傳）：`);
  console.log(r.warnings.map(line).join('\n'));
}
if (!r.issues.length) console.log(`\n✓ 通過收件檢查，可以上傳。${r.warnings.length ? '（請先看上面的提醒）' : ''}\n  提醒：建置、健康檢查與業務測試在平台上才會執行，請依 SOP 第 12 節先在本機驗證。`);
process.exit(r.issues.length ? 1 : 0);
