# Old Knowledge Database：舊版知識庫（保留）

此資料夾保存舊版知識庫與進階整合介面，現階段暫不使用但保留供日後參考，不應刪除。

## 規劃方向

- 部門專屬 Agent 與多 Agent 工作流程
- Prompt、Skill、MCP 與工具權限治理
- OpenWebUI 知識庫正式串接
- AD／SSO、群組及角色權限整合
- ERP、CRM、MES、文件系統等內部資料唯讀查詢
- 使用歷程、品質、成本及效益分析
- Prompt 與知識庫版本控制及稽核
- 品保文件核對與跨文件比較

## 本機執行

### 系統需求

- Node.js `>=22.13.0`
- pnpm

### 安裝、啟動與建置

```bash
pnpm install
pnpm dev
pnpm build
```

## 主要目錄

| 路徑 | 用途 |
|---|---|
| `app/` | 舊版知識庫頁面與互動功能 |
| `db/schema.ts` | 未來資料庫結構 |
| `drizzle.config.ts` | Drizzle 遷移設定 |
| `.openai/hosting.json` | Sites 資源與部署宣告 |
| `examples/d1/` | 可選用的 D1 範例 |

## 驗證指令

```bash
pnpm build
```

## 相關技術

- [vinext](https://github.com/cloudflare/vinext)
- [Drizzle ORM D1 指南](https://orm.drizzle.team/docs/get-started/d1-new)
