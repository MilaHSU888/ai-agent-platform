# WorkHub 本機上架服務（onboarding-service）

本機試點用的上架管理服務：接收原始碼 ZIP → 驗證 → 建置 image → 漏洞檢查 → 人工程式碼檢查（開發者按「已檢查」）→ 平台共通檢查 → 工具業務測試 → 預覽 → 使用者確認測試 → 發布核准 → 發布／更新／版本切換／下架，以及維運（維護模式、重新啟動、日誌）。開發者規格見 [上架 SOP](../docs/sop/WorkHub工具上架SOP.md)，需求對照見 [PRD §9](../docs/phase1/PRD.md#9-20261013-採購工具本機試點實作補充)。
網站開發者中心經由 Vite 同源代理（`/api/onboarding` → `127.0.0.1:4310`）呼叫本服務。

## 啟動

雙擊 `pilot/啟動上架服務.command`（需 Docker Desktop 與 Node.js 22.13+），再雙擊 `pilot/啟動WorkHub網站.command`，從 http://localhost:3002 的開發者中心上傳。不需登入。

```bash
npm ci
npm start          # 只綁 127.0.0.1:4310
npm test           # node:test，使用假容器執行器，不需 Docker
npm run typecheck
npm run test:relay # 模型轉接服務（Python）測試
npm run build:kit  # 重新打包資料包內的離線預檢程式 dist-kit/workhub-check.mjs
```

設定模型端點（金鑰以隱藏輸入寫入 `onboarding-data/secrets.json`，不經網頁、不進 ZIP）：雙擊 `pilot/設定模型端點.command`，或

```bash
MODEL_BASE_URL=https://… node --experimental-strip-types tools/set-model-endpoint.ts
```

## 設計重點

- **只綁 loopback，不需登入碼**：服務啟動時產生代理通行碼寫入 `onboarding-data/proxy-token`（0600），網站開發伺服器的代理在伺服器端讀取並附在轉送請求上，瀏覽器拿不到；沒有通行碼的直接連線一律拒絕。寫入動作另檢查 Origin，並以 Host 檢查擋 DNS rebinding。正式環境改由 AD／SSO 取代（TBD-AUTH-001）。
- **ZIP 收件**先讀中央目錄檢查：大小、檔數、解壓總量、壓縮比、路徑穿越、符號連結、巢狀壓縮檔、`.git`、密鑰檔與寫死的金鑰；解壓時限量並驗 CRC。缺件逐項列出「檔案／欄位、原因、補正方法」並停止建置。
- **workhub.yaml v1**：工具 ID、版本、埠、健康檢查、測試命令、持久資料與資源需求都從驗證後的設定取得，平台不寫死任何工具或框架；Owner、部門由平台表單決定。
- **單工執行器**：工作狀態全在 SQLite（`pilot/onboarding-data/onboarding.db`），瀏覽器關閉不影響；服務重啟時執行中的工作標為「中斷」，不自動判成功。
- **送審容器**：不掛主機目錄與 Docker socket、`--cap-drop ALL`、`no-new-privileges`、記憶體與 CPU 上限；業務測試 `--network none` 並使用空白資料卷；預覽使用獨立資料卷、只綁 127.0.0.1。
- **建置不注入模型憑證**；模型連線參數存於 `onboarding-data/secrets.json`（0600），只注入工具在 `env` 宣告的變數名稱。
- **核准綁定版本**：測試確認、漏洞例外、發布核准都綁定 source_hash + image_digest；新修訂使舊的確認與核准失效。
- **程式碼檢查為人工確認（DEC-019）**：不使用 AI、原始碼不送模型。漏洞檢查完成後步驟為 `awaiting`，開發者按「已檢查」（`POST /submissions/:id/code-review`，備註選填）才變 `passed`；未檢查不能確認測試、不能核准發布。
- **漏洞政策（DEC-020）**：只記錄、不阻擋（CRITICAL 標 `warning`）；掃描器無法執行時才阻擋。
- **隔離網路與模型轉接**：每個工具一個 internal docker 網路 `wh-net-<toolId>`，瀏覽器經 `<容器>-gw` 閘道開啟；工具只連得到 `wh-llm-relay`（`http://llm-relay:8080/v1`），拿到工具專用通行碼 `whr_…`，真實金鑰只在轉接服務。轉接只允許模型清單與對話 API、限制可用模型，記錄中繼資料到 `onboarding-data/relay-logs`。
- **發布**：發布同一份已測試 image；更新前停舊版並備份資料卷，健康檢查失敗自動還原；可切換到任何曾上線版本（保留資料／還原備份）、下架與重新上架。
- **試用／公開（DEC-032）**：工具有 `visibility`（trial／public）。首次發布後為 trial；開發者 `POST /tools/:id/trial-passed`、AI Team `POST /tools/:id/publish` 後為 public；`/unpublish` 退回 trial。已公開工具的新版以 `wh-trial-<tool>` 並行（空白資料卷、另一個埠；Owner 自行上傳測試資料），publish 時才走一般更新流程並移除試用版；`/end-trial` 捨棄試用版；開發者 `/trial-failed`（需原因）記錄測試未通過，並行試用版會自動結束。catalog 回傳 `visibility`、`trialPassed`、`trial`，由網站依角色過濾：開發者只看得到自己當 Owner 的試用工具，AI Team 看得到全部（本機無登入，後端不檢查角色）。
- **封存**：`POST /tools/:id/archive`（發布管理「封存工具」）停止工具的正式、試用、預覽容器，並從入口、開發者中心、發布管理、維運中心移除；資料卷與所有紀錄保留，不是永久刪除。
- **URL 上架（DEC-037）**：`POST /submissions/url`（JSON）登錄既有網站；`tools.kind`／`submissions.kind`＝`url`，設定存在 `manifest_json`，`image_digest` 為 `url:<hash>`。檢查工作只跑表單與連線檢查（`platform_test`，連不上為 `warning`、不阻擋），其餘步驟 `not_applicable`，完成後直接 `awaiting_approval`。發布、試用、公開、下架、版本切換只切換入口網址（不啟動容器）；`restart`／`logs` 對 URL 工具回 409。
- **工具圖示與說明（DEC-038）**：`POST /tools/:id/icon`（symbol 0～5、6 種內建顏色）與 `POST /tools/:id/profile`（用途說明必填、適用情境選填，各 80 字）；catalog 回傳 `kind`、`icon`、`description`、`scenario`。網站只讓 AI Team 使用（本機後端不檢查角色）。
- **資料包**：`GET /api/onboarding/kit` 下載上架資料包（新工具與版更同一份；2026/10/27 起不再有預填版號的更新資料包）。
- **版本號（DEC-039）**：平台每次收件自動給 `v<n>`（同一工具已用過的 v 號最大值 +1；失敗、取消的提交也占號），ZIP 與 URL 工具相同；已上架工具的舊語意化版號保留，下一次從 v1 開始。`workhub.yaml` 的 `tool.version` 改為不用填，有寫只提醒並忽略。

## 尚未實作

- AD／SSO 登入與權限（目前只綁本機，不可對外開放）。
- 正式 LLM Proxy（配額、雲端模型、資料政策）；管理者選模型目前只有網站 Demo。
- 多台主機、amd64、平台設定備份與還原演練。
