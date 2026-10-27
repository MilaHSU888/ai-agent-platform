import { mkdirSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { loadConfig } from './config.ts';
import { Store } from './db.ts';
import { DockerRuntime } from './runtime.ts';
import { Secrets } from './secrets.ts';
import { JobQueue } from './queue.ts';
import { createApp } from './server.ts';
import { runReleaseJob } from './releases.ts';
import { relayEnv, syncRelay } from './relay.ts';

const cfg = loadConfig();

// 先確認埠沒被占用，再碰資料庫與通行碼：重複啟動時若先覆寫 proxy-token、把工作標為中斷，
// 會讓正在執行的那一份服務認不得網站送來的通行碼（網站顯示「無法以本機操作者身分連線」）。
const portFree = await new Promise<boolean>((resolve) => {
  const probe = createServer();
  probe.once('error', () => resolve(false));
  probe.listen(cfg.port, cfg.host, () => probe.close(() => resolve(true)));
});
if (!portFree) {
  console.error(`上架服務已經在執行（${cfg.host}:${cfg.port} 已被占用），這次啟動已取消，原本的服務不受影響。`);
  console.error('若要重新啟動：先關閉原本的上架服務視窗（或按 Ctrl+C），再雙擊「啟動上架服務.command」。');
  process.exit(1);
}

mkdirSync(cfg.dataDir, { recursive: true, mode: 0o700 });
const store = new Store(join(cfg.dataDir, 'onboarding.db'));
const interrupted = store.markInterrupted('system');
const secrets = new Secrets(cfg.dataDir);
const rt = new DockerRuntime(cfg);
const queue = new JobQueue(store, cfg, rt, secrets);
queue.extraKinds.release = (id, signal) => runReleaseJob(store, cfg, rt, secrets, id, signal);
queue.extraKinds.rollback = (id, signal) => runReleaseJob(store, cfg, rt, secrets, id, signal);
queue.extraKinds.redeploy = (id, signal) => runReleaseJob(store, cfg, rt, secrets, id, signal);
queue.extraKinds.trial = (id, signal) => runReleaseJob(store, cfg, rt, secrets, id, signal);
const { server } = createApp(store, cfg, queue, rt, secrets);

const avail = await rt.available();
// 模型轉接服務：設定改變（例如換金鑰）時重新套用；尚未有工具使用模型時不啟動
const relay = avail.docker && relayEnv(cfg, secrets) && Object.keys(secrets.relayTokens()).length
  ? await syncRelay(cfg, rt, secrets).catch((e: Error) => ({ ok: false, detail: e.message }))
  : { ok: false, detail: relayEnv(cfg, secrets) ? '尚無工具使用模型，第一次預覽或發布時啟動' : '核准模型端點尚未設定（雙擊「設定模型端點.command」）' };
server.on('error', (e: NodeJS.ErrnoException) => {
  console.error(e.code === 'EADDRINUSE' ? `埠 ${cfg.port} 剛被其他程式占用，上架服務無法啟動。請關閉另一個上架服務視窗後再試。` : `上架服務無法啟動：${e.message}`);
  process.exit(1);
});
server.listen(cfg.port, cfg.host, () => {
  const line = '─'.repeat(56);
  console.log(line);
  console.log(' WorkHub 上架服務（本機試點）已啟動');
  console.log(` 位址      http://${cfg.host}:${cfg.port}（只接受本機連線）`);
  console.log(` 環境      ${cfg.environment}　操作者 ${cfg.operator}`);
  console.log(` 資料目錄  ${cfg.dataDir}`);
  console.log(` 容器      ${avail.docker ? '可用' : '不可用'}　漏洞掃描 ${avail.trivy ? '可用' : '不可用'}（${avail.detail}）`);
  console.log(` 模型轉接  ${relay.detail}`);
  console.log(` 工具網路  ${cfg.toolNetworkInternal ? '隔離（工具只能連模型轉接服務）' : '可連外（ONBOARDING_TOOL_NETWORK=open）'}`);
  if (interrupted) console.log(` 注意      上次關閉時有 ${interrupted} 個工作在執行，已標為「中斷」，可在網站重試`);
  console.log('');
  console.log('  請開啟 WorkHub 網站 → 開發者中心 上傳 ZIP（網站代理會自動帶入本機通行碼，不需登入）');
  console.log('');
  console.log(' 關閉此視窗會停止上架服務；已排隊的工作下次啟動時會繼續。');
  console.log(line);
  queue.start();
});

const shutdown = () => {
  queue.stop();
  server.close();
  setTimeout(() => process.exit(0), 3000).unref();
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
