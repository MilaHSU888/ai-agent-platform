/**
 * 本機管理工作階段（不需輸入登入碼）：
 * 服務啟動時產生代理通行碼，寫入資料目錄的 proxy-token（權限 0600）。WorkHub 網站的開發伺服器代理
 * 在伺服器端讀取此檔，轉送 /api/onboarding 請求時自動附上 X-WorkHub-Proxy-Token；瀏覽器碰不到通行碼。
 * - 直接連到 127.0.0.1:4310 而沒有通行碼的請求一律拒絕（擋住其他本機程式與網頁）
 * - 寫入動作另需 Origin 在允許清單內（擋住經由網站代理的跨站請求）
 * - Host 檢查擋住 DNS rebinding
 * 正式環境改由 AD／SSO 取代（TBD-AUTH-001）。
 */
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { chmodSync, writeFileSync } from 'node:fs';
import type { IncomingMessage } from 'node:http';
import { join } from 'node:path';
import type { Config } from './config.ts';

export const TOKEN_HEADER = 'x-workhub-proxy-token';

export class Auth {
  cfg: Config;
  token: string;
  tokenFile: string;
  constructor(cfg: Config, token?: string) {
    this.cfg = cfg;
    this.token = token ?? randomBytes(32).toString('base64url');
    this.tokenFile = join(cfg.dataDir, 'proxy-token');
    writeFileSync(this.tokenFile, this.token, { mode: 0o600 });
    chmodSync(this.tokenFile, 0o600);
  }

  hostAllowed(req: IncomingMessage): boolean {
    const host = (req.headers.host ?? '').toLowerCase();
    return host === `127.0.0.1:${this.cfg.port}` || host === `localhost:${this.cfg.port}`;
  }

  originAllowed(req: IncomingMessage): boolean {
    const origin = req.headers.origin;
    return typeof origin === 'string' && this.cfg.allowedOrigins.includes(origin);
  }

  /** 經由網站代理（帶正確通行碼）的請求才視為本機操作者 */
  session(req: IncomingMessage): { actor: string } | null {
    const h = req.headers[TOKEN_HEADER];
    if (typeof h !== 'string') return null;
    const a = Buffer.from(h);
    const b = Buffer.from(this.token);
    return a.length === b.length && timingSafeEqual(a, b) ? { actor: this.cfg.operator } : null;
  }
}
