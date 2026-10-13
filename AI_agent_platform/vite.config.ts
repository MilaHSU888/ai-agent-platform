import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import vinext from "vinext";
import { defineConfig } from "vite";
import hostingConfig from "./.openai/hosting.json";
import { sites } from "./build/sites-vite-plugin";

const SITE_CREATOR_PLACEHOLDER_DATABASE_ID =
  "00000000-0000-4000-8000-000000000000";

const { d1, r2 } = hostingConfig;

// macOS Seatbelt blocks FSEvents, so Codex previews need polling for HMR.
const isCodexSeatbeltSandbox = process.env.CODEX_SANDBOX === "seatbelt";

// 本機上架服務的代理通行碼：上架服務啟動時寫入（0600），代理在伺服器端讀取後附在轉送請求上，瀏覽器不會拿到。
const onboardingTokenFile =
  process.env.ONBOARDING_TOKEN_FILE ??
  fileURLToPath(new URL("../../pilot/onboarding-data/proxy-token", import.meta.url));
function readOnboardingToken(): string {
  try {
    return readFileSync(onboardingTokenFile, "utf8").trim();
  } catch {
    return "";
  }
}

const localBindingConfig = {
  main: "./worker/index.ts",
  compatibility_flags: ["nodejs_compat"],
  d1_databases: d1
    ? [
        {
          binding: d1,
          database_name: "site-creator-d1",
          database_id: SITE_CREATOR_PLACEHOLDER_DATABASE_ID,
        },
      ]
    : [],
  r2_buckets: r2
    ? [
        {
          binding: r2,
          bucket_name: "site-creator-r2",
        },
      ]
    : [],
};

export default defineConfig(async () => {
  // Keep Wrangler and Miniflare state project-local. These are non-secret tool
  // settings; application environment belongs in ignored `.env*` files.
  process.env.WRANGLER_WRITE_LOGS ??= "false";
  process.env.WRANGLER_LOG_PATH ??= ".wrangler/logs";
  process.env.MINIFLARE_REGISTRY_PATH ??= ".wrangler/registry";

  // Wrangler snapshots its log path while the Cloudflare plugin is imported.
  const { cloudflare } = await import("@cloudflare/vite-plugin");

  return {
    server: {
      ...(isCodexSeatbeltSandbox
        ? { watch: { useFsEvents: false, usePolling: true } }
        : {}),
      // 本機上架服務（onboarding-service）只綁 127.0.0.1；同源代理讓登入 cookie 與 CSRF 檢查維持 same-origin。
      proxy: {
        "/api/onboarding": {
          target: process.env.ONBOARDING_URL ?? "http://127.0.0.1:4310",
          changeOrigin: true,
          configure: (proxy) => {
            // 在建立轉送請求前改寫來源標頭：先移除瀏覽器自帶的同名標頭，再附上伺服器端讀到的通行碼。
            // （於 start 事件處理，大型上傳帶 Expect: 100-continue 時標頭也不會先被送出）
            proxy.on("start", (req) => {
              delete req.headers["x-workhub-proxy-token"];
              const token = readOnboardingToken();
              if (token) req.headers["x-workhub-proxy-token"] = token;
            });
          },
        },
      },
    },
    plugins: [
      vinext(),
      sites(),
      cloudflare({
        viteEnvironment: { name: "rsc", childEnvironments: ["ssr"] },
        config: localBindingConfig,
      }),
    ],
  };
});
