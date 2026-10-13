import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig } from './config.ts';
import { Store } from './db.ts';
import { DockerRuntime } from './runtime.ts';
import { Secrets } from './secrets.ts';
import { JobQueue } from './queue.ts';
import { createApp } from './server.ts';

const cfg = loadConfig();
mkdirSync(cfg.dataDir, { recursive: true, mode: 0o700 });
const store = new Store(join(cfg.dataDir, 'onboarding.db'));
const interrupted = store.markInterrupted('system');
const secrets = new Secrets(cfg.dataDir);
const rt = new DockerRuntime(cfg);
const queue = new JobQueue(store, cfg, rt, secrets);
const { server } = createApp(store, cfg, queue, rt, secrets);

const avail = await rt.available();
server.listen(cfg.port, cfg.host, () => {
  const line = '─'.repeat(56);
  console.log(line);
  console.log(' WorkHub 上架服務（本機試點）已啟動');
  console.log(` 位址      http://${cfg.host}:${cfg.port}（只接受本機連線）`);
  console.log(` 環境      ${cfg.environment}　操作者 ${cfg.operator}`);
  console.log(` 資料目錄  ${cfg.dataDir}`);
  console.log(` 容器      ${avail.docker ? '可用' : '不可用'}　漏洞掃描 ${avail.trivy ? '可用' : '不可用'}（${avail.detail}）`);
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
