# 企業 AI Agent 統一管理平台

本 repository 同時保存 Phase 1 與 Phase 2 的前端介面，方便會議討論、版本比較與後續功能調整。

## 專案結構

| 資料夾 | 階段 | 主要內容 |
|---|---|---|
| [`phase1/`](phase1/) | Phase 1：統一入口與現有工具整合 | 統一工具首頁、權限入口、AI／非 AI 工具使用紀錄、基礎儀表板、工具上架與 Code Review 流程 |
| [`phase2/`](phase2/) | Phase 2：知識管理與進階應用 | 部門 Agent、知識庫、Prompt／Skill／MCP、歷史資料查詢、進階分析與品保文件核對 |

兩個階段各自保有完整的程式、相依套件設定及啟動指令，可分別開發與測試。

## 本機啟動

Phase 1：

```bash
cd phase1
pnpm install
pnpm dev
```

Phase 2：

```bash
cd phase2
pnpm install
pnpm dev
```

## 會議前基準版本

- Phase 1：`meeting-baseline-phase1-2026-08-14`
- Phase 2：`meeting-baseline-phase2-2026-08-14`

後續修改可持續提交至 `main`；如需查看或還原會議前版本，可使用上述 Git 標籤。
