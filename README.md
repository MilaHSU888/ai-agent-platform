# AI Agent Platform：企業智慧工具平台

本專案提供約 300–350 位員工使用的企業智慧工具入口。平台依「全公司共用」及各部門分類工具，並讓管理者追蹤使用人數、執行次數與預估效益。

目前版本聚焦 Phase 1：統一入口、核心工具、使用成效及部門知識庫體驗。

## 使用部門

- 全公司共用
- 財務部、資訊部、人力資源部、總務部
- 研發部、採購部、業務部、資材部
- 製造一部、製造二部、經營管理室

## 主要功能

### WorkHub 工具中心

- 依全公司及 11 個部門分類工具
- AI／非 AI 工具篩選及名稱搜尋
- 顯示部門人數、活躍使用者與工具數量
- 顯示工具使用人數、執行次數及預估節省工時
- 進入工具前顯示個別工具使用成效

### 管理者成效儀表板

- 本月活躍使用者及平台採用率
- 工具執行次數及預估節省工時
- 部門採用排名與個別工具成效
- 本月、近三個月及本年度期間切換

### AI 識圖大師

- 使用客戶提供的真實 AI 球標辨識報告案例
- 球標 1、13、2、3、4、5、6、7 逐筆人工覆核
- 中央圖面、框選位置與右側辨識結果同步
- 支援確認、修正、標記問題及核對進度
- 支援鍵盤快速操作及完成後匯出流程

### 採購報價匯整工具

- 採購案編號必填驗證與數量區間設定
- XLSX、XLS、DOC、DOCX、PDF、EML、MSG 多檔上傳
- 檔案清單、單筆移除及清空重來
- 比較表匯出狀態、使用說明及歷史查價
- 本機安全執行提示

### 企業／部門知識庫

- 全公司與所有部門皆提供知識庫問答入口
- 自動附加「全公司共用＋目前部門」知識庫
- 使用者不需在每次對話手動選擇知識庫
- 回答顯示引用來源及原始文件入口
- 不同部門提供不同的建議問題與查詢範圍

### Prompt 範本

- 個人、部門共用及全公司共用 Prompt
- Prompt 搜尋、新增及一鍵套用
- 輸入 `/` 顯示目前有權限使用的 Prompt
- 輸入前幾個字後即時縮小選擇範圍
- 支援方向鍵、Enter、Tab 及 Esc 操作

### 部門知識庫管理

- 部門管理員可新增知識庫及上傳文件
- 可啟用或暫停部門知識來源
- 顯示知識庫數量、文件數、更新時間及索引狀態
- 全公司必備來源由平台管理員控管，部門管理員不能關閉
- 異動後自動套用至下一次提問

## 專案位置

主要平台程式位於 [`AI_agent_platform/`](AI_agent_platform/)。

| 路徑 | 用途 |
|---|---|
| `AI_agent_platform/app/page.tsx` | 平台、儀表板及各工具互動 |
| `AI_agent_platform/app/globals.css` | 全站與各工具版面樣式 |
| `AI_agent_platform/public/ai-balloon-s*.png` | AI 識圖真實案例局部圖 |
| `AI_agent_platform/.openai/hosting.json` | Sites 部署與資源宣告 |

## 本機啟動

### 系統需求

- Node.js `>=22.13.0`
- pnpm

### 安裝與執行

```bash
cd AI_agent_platform
pnpm install
pnpm dev -- --port 3002
```

開啟 [http://localhost:3002](http://localhost:3002)。

### 建置驗證

```bash
cd AI_agent_platform
pnpm build
```

## Phase 1 串接範圍

目前 OpenWebUI 問答、Prompt、知識庫自動綁定及管理介面為前端整合展示。正式串接需要：

- OpenWebUI URL 與 API Token
- 使用模型 ID
- 全公司及各部門 Knowledge Base ID
- AD 群組與 OpenWebUI 權限對應
- Prompt 與知識庫管理 API 權限

## 基準版本

會議前 Phase 1 基準標籤：`meeting-baseline-phase1-2026-08-14`

更完整的操作及技術說明請參考 [`AI_agent_platform/README.md`](AI_agent_platform/README.md)。
