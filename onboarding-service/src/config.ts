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
    limits: {
      uploadBytes: 100 * 1024 * 1024,
      entries: 5000,
      totalUncompressedBytes: 500 * 1024 * 1024,
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
  };
  return { ...base, ...overrides };
}
