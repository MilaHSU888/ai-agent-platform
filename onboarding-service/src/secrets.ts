/**
 * 平台安全設定：核准模型端點的連線參數。只存在本機資料目錄（權限 0600），
 * 不進 ZIP、不進 localStorage、不經網頁傳送；由 tools/set-model-endpoint 指令在終端機輸入。
 */
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export type EndpointSecret = { env: Record<string, string>; secretKeys: string[]; updatedAt: string };
type SecretFile = { endpoints: Record<string, EndpointSecret> };

export class Secrets {
  path: string;
  constructor(dataDir: string) { this.path = join(dataDir, 'secrets.json'); }

  private read(): SecretFile {
    if (!existsSync(this.path)) return { endpoints: {} };
    return JSON.parse(readFileSync(this.path, 'utf8')) as SecretFile;
  }

  endpoint(id: string): EndpointSecret | undefined {
    return this.read().endpoints[id];
  }

  configured(): string[] {
    return Object.keys(this.read().endpoints);
  }

  set(id: string, env: Record<string, string>, secretKeys: string[]) {
    const f = this.read();
    f.endpoints[id] = { env, secretKeys, updatedAt: new Date().toISOString() };
    writeFileSync(this.path, JSON.stringify(f, null, 2), { mode: 0o600 });
    chmodSync(this.path, 0o600);
  }

  /** 所有機密值，用於日誌遮罩 */
  allSecretValues(): string[] {
    return Object.values(this.read().endpoints).flatMap((e) => e.secretKeys.map((k) => e.env[k]).filter(Boolean));
  }
}
