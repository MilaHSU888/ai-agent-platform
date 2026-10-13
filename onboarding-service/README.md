# WorkHub 本機上架服務（onboarding-service）

本機試點用的上架管理服務：接收原始碼 ZIP → 驗證 → 建置 image → 漏洞檢查 → 平台共通檢查 → 工具業務測試 → 預覽 → 使用者確認 → 發布核准。
網站開發者中心經由 Vite 同源代理（`/api/onboarding` → `127.0.0.1:4310`）呼叫本服務。

## 啟動

雙擊 `pilot/啟動上架服務.command`（需 Docker Desktop 與 Node.js 22.13+），再雙擊 `pilot/啟動WorkHub網站.command`，從 http://localhost:3002 的開發者中心上傳。不需登入。

```bash
npm ci
npm start          # 只綁 127.0.0.1:4310
npm test           # node:test，使用假容器執行器，不需 Docker
npm run typecheck
```

## 設計重點

- **只綁 loopback，不需登入碼**：服務啟動時產生代理通行碼寫入 `onboarding-data/proxy-token`（0600），網站開發伺服器的代理在伺服器端讀取並附在轉送請求上，瀏覽器拿不到；沒有通行碼的直接連線一律拒絕。寫入動作另檢查 Origin，並以 Host 檢查擋 DNS rebinding。正式環境改由 AD／SSO 取代（TBD-AUTH-001）。
- **ZIP 收件**先讀中央目錄檢查：大小、檔數、解壓總量、壓縮比、路徑穿越、符號連結、巢狀壓縮檔、`.git`、密鑰檔與寫死的金鑰；解壓時限量並驗 CRC。缺件逐項列出「檔案／欄位、原因、補正方法」並停止建置。
- **workhub.yaml v1**：工具 ID、版本、埠、健康檢查、測試命令、持久資料與資源需求都從驗證後的設定取得，平台不寫死任何工具或框架；Owner、部門由平台表單決定。
- **單工執行器**：工作狀態全在 SQLite（`pilot/onboarding-data/onboarding.db`），瀏覽器關閉不影響；服務重啟時執行中的工作標為「中斷」，不自動判成功。
- **送審容器**：不掛主機目錄與 Docker socket、`--cap-drop ALL`、`no-new-privileges`、記憶體與 CPU 上限；業務測試 `--network none` 並使用空白資料卷；預覽使用獨立資料卷、只綁 127.0.0.1。
- **建置不注入模型憑證**；模型連線參數存於 `onboarding-data/secrets.json`（0600），只注入工具在 `env` 宣告的變數名稱。
- **核准綁定版本**：測試確認、漏洞例外、發布核准都綁定 source_hash + image_digest；新修訂使舊的確認與核准失效。
- **本機試點例外**：程式碼 AI review 標示 `skipped`（不是 passed）並記錄原因與操作者；`ONBOARDING_ENVIRONMENT=production` 時後端禁止略過。
- **漏洞政策（2026-10-13 決策）**：只阻擋 CRITICAL；HIGH 記錄不阻擋；無修正版的 CRITICAL 須逐一核准本機例外。

## 尚未實作（後續階段）

- 階段 D：模型端點設定指令、本機最小模型轉接服務與對外路由限制。
- 階段 E：正式發布（同一 image digest）、WorkHub 入口更新、更新失敗保留前版、回復與一致性備份、入口點擊紀錄。
