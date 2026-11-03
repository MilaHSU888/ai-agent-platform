import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const serviceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = resolve(serviceRoot, '..');

function list(value: string | undefined, fallback: string[]): string[] {
  return value ? value.split(',').map((s) => s.trim()).filter(Boolean) : fallback;
}

function findBinary(name: string): string {
  const candidates = [
    process.env[`ONBOARDING_${name.toUpperCase()}_PATH`],
    `/opt/homebrew/bin/${name}`,
    `/usr/local/bin/${name}`,
    `/usr/bin/${name}`,
    `/Applications/Docker.app/Contents/Resources/bin/${name}`,
  ].filter((p): p is string => !!p);
  return candidates.find((p) => existsSync(p)) ?? name;
}

export type Environment = 'local' | 'production';

export type Config = {
  host: string;
  port: number;
  environment: Environment;
  operator: string;
  dataDir: string;
  allowedOrigins: string[];
  approvedModelEndpoints: string[];
  hostPlatform: string;
  docker: string;
  trivy: string;
  /** 漏洞掃描不連網：只用本機現有的漏洞資料庫（正式環境不能上網；資料庫由 AI Team 手動更新，見 SOP） */
  trivyOffline: boolean;
  /** 備份／還原資料卷用的平台輔助映像（固定版本） */
  helperImage: string;
  limits: {
    uploadBytes: number;
    entries: number;
    totalUncompressedBytes: number;
    singleFileBytes: number;
    compressionRatio: number;
  };
  timeouts: {
    buildMs: number;
    scanMs: number;
    healthMs: number;
    testMaxMs: number;
  };
  ports: { previewStart: number; previewEnd: number; releaseStart: number; releaseEnd: number };
  sessionHours: number;
  /** 模型轉接服務：使用本機已有的 Python 映像跑標準函式庫腳本，不另外下載 */
  relay: { image: string; timeoutSeconds: number };
  /** 工具網路是否隔離（無對外路由）。true：工具只連得到模型轉接服務 */
  toolNetworkInternal: boolean;
  /** 漏洞資料庫固定放在平台資料夾（2026/11/03，B6）：本機 pilot/onboarding-data/trivy-cache，正式環境 <平台資料目錄>/trivy-cache */
  trivyCacheDir: string;
  /** 原始碼自動打包（2026/11/03）：上傳上限、一件最多幾分鐘、修正幾次、每次呼叫模型的逾時 */
  autopack: { uploadBytes: number; totalUncompressedBytes: number; entries: number; maxMinutes: number; maxFixRounds: number; modelTimeoutMs: number };
};

export function loadConfig(overrides: Partial<Config> = {}): Config {
  const environment = (process.env.ONBOARDING_ENVIRONMENT === 'production' ? 'production' : 'local') as Environment;
  const base: Config = {
    // 只綁 loopback，不提供設定改成 0.0.0.0
    host: '127.0.0.1',
    port: Number(process.env.ONBOARDING_PORT ?? 4310),
    environment,
    operator: process.env.ONBOARDING_OPERATOR ?? 'Mila',
    dataDir: resolve(process.env.ONBOARDING_DATA_DIR ?? join(repoRoot, '..', 'pilot', 'onboarding-data')),
    allowedOrigins: list(process.env.ONBOARDING_ALLOWED_ORIGINS, ['http://localhost:3002', 'http://127.0.0.1:3002']),
    approvedModelEndpoints: list(process.env.ONBOARDING_APPROVED_MODELS, ['wisely-5090']),
    hostPlatform: process.arch === 'arm64' ? 'linux/arm64' : 'linux/amd64',
    docker: findBinary('docker'),
    trivy: findBinary('trivy'),
    // 2026/11/02 起本機試點也比照正式環境（不能上網）：預設不連網掃描；要恢復連網自動更新設 ONBOARDING_TRIVY_OFFLINE=0
    trivyOffline: process.env.ONBOARDING_TRIVY_OFFLINE !== '0',
    helperImage: process.env.ONBOARDING_HELPER_IMAGE ?? 'busybox:1.36.1',
    limits: {
      // 2026/11/03 Mila：已打包 ZIP 與專案 ZIP 上限統一 1 GB（虛擬環境、套件等平台會略過）；偏大時不擋，列出可能不需要的檔案
      uploadBytes: 1024 ** 3,
      entries: 50_000, // 2026/11/03：與專案 ZIP 一致；檔案多時不擋，列出可能不需要的資料夾
      totalUncompressedBytes: 1024 ** 3,
      singleFileBytes: 200 * 1024 * 1024,
      compressionRatio: 200,
    },
    timeouts: {
      buildMs: 45 * 60 * 1000,
      scanMs: 20 * 60 * 1000,
      healthMs: 3 * 60 * 1000,
      testMaxMs: 60 * 60 * 1000,
    },
    ports: { previewStart: 18600, previewEnd: 18699, releaseStart: 18700, releaseEnd: 18799 },
    sessionHours: 12,
    relay: { image: process.env.ONBOARDING_RELAY_IMAGE ?? 'python:3.14-slim-trixie', timeoutSeconds: 125 },
    toolNetworkInternal: process.env.ONBOARDING_TOOL_NETWORK !== 'open',
    trivyCacheDir: '',
    autopack: { uploadBytes: 1024 ** 3, totalUncompressedBytes: 1024 ** 3, entries: 50_000, maxMinutes: 60, maxFixRounds: 3, modelTimeoutMs: 10 * 60 * 1000 },
  };
  const merged = { ...base, ...overrides };
  if (!merged.trivyCacheDir) merged.trivyCacheDir = join(merged.dataDir, 'trivy-cache');
  return merged;
}
