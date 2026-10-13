# 專案執行指引

## 專案目的

本專案建置「企業 AI Agent 統一管理平台」，將公司內部分散的 AI 與非 AI 工具整合至 WorkHub，提供最多 100 位 Phase 1 使用者一致的入口與使用體驗。

Phase 1 的核心目標是：

- 將公司目前已完成的 AI 與非 AI 小工具整合至 WorkHub，統一入口、權限與使用紀錄，同時保留各工具原有功能。
- 將 OpenWebUI URL 整合至 WorkHub，由平台依權限提供入口與導流，同時保留 OpenWebUI 原有介面與功能。
- 使用者透過 AD／SSO 登入後，只看到並使用具備權限的工具。
- IT 統一管理工具入口、角色權限、AI 模型流量、資料政策與必要稽核紀錄。
- AI 工具經 LLM Proxy 連接地端或核准的雲端模型；非 AI 工具另行記錄使用事件。
- 主管透過彙總分析了解工具採用與效益，不查看員工完整 Prompt、附件或回應內容。
- 完成 AI 識圖的圖面檢視、辨識、人工修正、最終確認與 Excel 匯出流程，AI 不取代最終人工覆核。

完整產品需求、驗收條件與待決策事項以 Phase 1 PRD 及附件為準，本文件不重複保存詳細需求。

## 需求來源優先序

1. `docs/phase1/[UMT] AI ahent platform_phase1_PRD.md` 及已核准的附件。
2. `docs/phase1/DECISIONS.md` 中已同步回 PRD 的正式決策。
3. `企業AI_Agent統一管理平台_Proposal.md` v0.4 與 `會議記錄/0821-會議記錄.md` 作為背景資料。
4. `ai-agent-platform/README.md` 與 `http://localhost:3002/` 只作前端 Demo 與流程參考。

不得將 Demo 示意資料、舊版計畫或尚未決策的 TBD 直接視為正式產品需求。

## Phase 1 範圍

- Phase 1 最多 100 位使用者；同時在線量仍是待確認事項。
- 建置 WorkHub 統一入口、AD／SSO 與權限、既有工具及 OpenWebUI URL 導流整合、LLM Proxy 串接、非 AI 使用紀錄、主管分析及 AI 識圖覆核／匯出。
- 平台開放上架，不限定工具清單、類型或數量；專案團隊完成 1–2 個工具全流程試點及技術移轉，後續由客戶 AI 團隊自行上架。
- Phase 1 納入自主管理後台、Container、AI 程式碼檢查、發布／版本回復；保留工具業務功能，允許必要接入改造。
- 使用 LLM 的工具可由後台切換相容且符合資料政策的核准地端／雲端模型；AI 識圖地端 5090 規格持續適用。
- OpenWebUI URL 入口與導流納入 Phase 1；其知識庫正式整合、Prompt／Skill／MCP 平台功能及 ERP 寫回不屬於 Phase 1。

## 執行規則

- 從需求 ID 開始工作，並閱讀對應附件、決策閘門與 UAT 案例。
- 若實作需要自行猜測角色、資料政策、外部介面、計算公式或驗收門檻，停止該項實作並回報阻塞的 TBD。
- 權限必須由 Backend 驗證；隱藏前端元件不能作為唯一的權限保護。
- 正式需求異動時，同步更新測試與需求追蹤資料。

## 開發與驗證方式

前端 Demo 與應用程式位於 `ai-agent-platform/AI_agent_platform`。進行程式開發或驗證時，先切換到此目錄。

- 第一次安裝或依賴異動時：`pnpm install`
- 啟動本機 Demo：`pnpm dev -- --port 3002`
- 檢查程式規範：`pnpm lint`
- 執行自動測試：`pnpm test`
- 驗證 production build：`pnpm build`

以 `package.json` 實際存在的 scripts 為準。文件或 PRD 修改不需要執行前端指令；只有程式或設定異動時，才依影響範圍執行相關檢查。

## 完成條件

- 驗證本次修改涉及的需求、錯誤流程與權限流程。
- 應用程式異動需執行相關測試及 production build。
- Secret、Token、客戶文件與敏感 Prompt 不得寫入原始碼或一般 Log。
- 交付摘要需列出完成的需求 ID、執行的測試、未關閉的決策閘門與同步更新的文件。
