"use client";

import { useMemo, useState } from "react";

type Department = {
  id: string;
  name: string;
  short: string;
  count: number;
  active: number;
  tools: number;
  saved: number;
};

type Tool = {
  id: string;
  name: string;
  description: string;
  department: string;
  type: "AI" | "非 AI";
  badge?: string;
  users: number;
  runs: number;
  saved: number;
  color: string;
  icon: string;
};

const departments: Department[] = [
  { id: "shared", name: "全公司共用", short: "全", count: 328, active: 286, tools: 6, saved: 916 },
  { id: "finance", name: "財務部", short: "財", count: 18, active: 16, tools: 4, saved: 138 },
  { id: "it", name: "資訊部", short: "資", count: 14, active: 14, tools: 5, saved: 171 },
  { id: "hr", name: "人力資源部", short: "人", count: 12, active: 10, tools: 4, saved: 96 },
  { id: "general", name: "總務部", short: "總", count: 15, active: 11, tools: 3, saved: 72 },
  { id: "rd", name: "研發部", short: "研", count: 56, active: 47, tools: 6, saved: 384 },
  { id: "purchase", name: "採購部", short: "採", count: 21, active: 18, tools: 4, saved: 142 },
  { id: "sales", name: "業務部", short: "業", count: 38, active: 34, tools: 5, saved: 318 },
  { id: "material", name: "資材部", short: "材", count: 26, active: 22, tools: 4, saved: 186 },
  { id: "mfg1", name: "製造一部", short: "一", count: 52, active: 41, tools: 4, saved: 264 },
  { id: "mfg2", name: "製造二部", short: "二", count: 48, active: 39, tools: 4, saved: 247 },
  { id: "management", name: "經營管理室", short: "經", count: 8, active: 8, tools: 5, saved: 121 },
];

const tools: Tool[] = [
  { id: "meeting", name: "會議紀錄助手", description: "自動整理逐字稿、待辦事項與決策摘要", department: "shared", type: "AI", badge: "熱門", users: 214, runs: 846, saved: 286, color: "violet", icon: "記" },
  { id: "translate", name: "多語翻譯助手", description: "中英日文件翻譯與企業用語校正", department: "shared", type: "AI", users: 186, runs: 638, saved: 192, color: "blue", icon: "譯" },
  { id: "document", name: "文件格式轉換", description: "PDF、Word、Excel 檔案快速轉換", department: "shared", type: "非 AI", users: 172, runs: 512, saved: 84, color: "cyan", icon: "轉" },
  { id: "mail", name: "郵件草稿助手", description: "依情境產生專業郵件與回覆建議", department: "shared", type: "AI", users: 149, runs: 427, saved: 118, color: "orange", icon: "郵" },
  { id: "search", name: "內規快速查詢", description: "搜尋公司規章、表單與標準流程", department: "shared", type: "AI", users: 132, runs: 391, saved: 129, color: "green", icon: "查" },
  { id: "image", name: "圖片壓縮工具", description: "批次壓縮與調整常用圖片格式", department: "shared", type: "非 AI", users: 94, runs: 246, saved: 42, color: "pink", icon: "圖" },

  { id: "invoice", name: "發票核對助手", description: "比對發票、請款單與付款條件", department: "finance", type: "AI", badge: "本月新增", users: 15, runs: 184, saved: 62, color: "blue", icon: "核" },
  { id: "expense", name: "費用分析儀表板", description: "依成本中心彙整費用與異常項目", department: "finance", type: "非 AI", users: 12, runs: 96, saved: 28, color: "green", icon: "費" },
  { id: "budget", name: "預算差異說明助手", description: "產生預算與實績差異初稿", department: "finance", type: "AI", users: 9, runs: 74, saved: 34, color: "violet", icon: "算" },
  { id: "reconcile", name: "對帳檔整理工具", description: "合併銀行與 ERP 對帳資料", department: "finance", type: "非 AI", users: 11, runs: 128, saved: 39, color: "cyan", icon: "帳" },

  { id: "ticket", name: "IT 服務台助手", description: "問題分類、相似案例與處理步驟建議", department: "it", type: "AI", users: 14, runs: 212, saved: 68, color: "blue", icon: "修" },
  { id: "account", name: "帳號權限申請", description: "整合 AD 帳號與系統權限申請", department: "it", type: "非 AI", users: 14, runs: 89, saved: 19, color: "cyan", icon: "權" },
  { id: "log", name: "系統日誌分析", description: "彙整錯誤日誌並標示可能原因", department: "it", type: "AI", users: 10, runs: 108, saved: 41, color: "orange", icon: "誌" },
  { id: "asset", name: "資訊資產盤點", description: "查詢設備、授權與保固狀態", department: "it", type: "非 AI", users: 12, runs: 65, saved: 18, color: "green", icon: "盤" },
  { id: "code", name: "程式碼審查助手", description: "檢查變更、風險與測試覆蓋", department: "it", type: "AI", users: 8, runs: 76, saved: 35, color: "violet", icon: "碼" },

  { id: "jd", name: "職缺文案助手", description: "依職務需求產生招募文案初稿", department: "hr", type: "AI", users: 8, runs: 68, saved: 24, color: "violet", icon: "徵" },
  { id: "onboard", name: "新人報到清單", description: "跨部門報到任務與進度追蹤", department: "hr", type: "非 AI", users: 10, runs: 54, saved: 18, color: "green", icon: "新" },
  { id: "policy", name: "人事規章問答", description: "查詢差勤、福利與內部人事規章", department: "hr", type: "AI", users: 9, runs: 124, saved: 37, color: "blue", icon: "問" },
  { id: "attendance", name: "差勤異常彙整", description: "彙整待確認的差勤與加班紀錄", department: "hr", type: "非 AI", users: 7, runs: 62, saved: 17, color: "orange", icon: "勤" },

  { id: "repair", name: "修繕申請中心", description: "廠區修繕通報、分派與進度查詢", department: "general", type: "非 AI", users: 11, runs: 76, saved: 17, color: "orange", icon: "繕" },
  { id: "contract", name: "合約摘要助手", description: "整理行政合約重點與到期日", department: "general", type: "AI", users: 8, runs: 49, saved: 22, color: "violet", icon: "約" },
  { id: "room", name: "會議室資源管理", description: "空間、設備與借用衝突查詢", department: "general", type: "非 AI", users: 9, runs: 88, saved: 13, color: "cyan", icon: "室" },

  { id: "spec", name: "規格文件助手", description: "摘要規格、比對版本與標示變更", department: "rd", type: "AI", badge: "熱門", users: 42, runs: 318, saved: 126, color: "violet", icon: "規" },
  { id: "patent", name: "專利檢索助手", description: "整理技術關鍵字與相似專利", department: "rd", type: "AI", users: 31, runs: 186, saved: 84, color: "blue", icon: "專" },
  { id: "testreport", name: "測試報告產生器", description: "彙整測試數據與報告格式", department: "rd", type: "非 AI", users: 38, runs: 241, saved: 71, color: "green", icon: "測" },
  { id: "bom", name: "BOM 差異比對", description: "快速標示版本間料件差異", department: "rd", type: "非 AI", users: 29, runs: 164, saved: 49, color: "cyan", icon: "料" },
  { id: "risk", name: "設計風險檢查", description: "依歷史案例提示潛在設計風險", department: "rd", type: "AI", users: 24, runs: 127, saved: 41, color: "orange", icon: "險" },
  { id: "tech", name: "技術知識搜尋", description: "跨專案搜尋核准的技術文件", department: "rd", type: "AI", users: 35, runs: 223, saved: 68, color: "pink", icon: "知" },

  { id: "quote", name: "報價比較助手", description: "彙整供應商報價與差異說明", department: "purchase", type: "AI", users: 17, runs: 164, saved: 58, color: "blue", icon: "價" },
  { id: "supplier", name: "供應商評核", description: "品質、交期與服務績效彙整", department: "purchase", type: "非 AI", users: 14, runs: 82, saved: 24, color: "green", icon: "供" },
  { id: "po", name: "採購單查詢", description: "依料號、廠商與日期查詢 PO", department: "purchase", type: "非 AI", users: 19, runs: 202, saved: 35, color: "cyan", icon: "購" },
  { id: "clause", name: "採購條款檢查", description: "提示付款、交期與責任條款", department: "purchase", type: "AI", users: 12, runs: 91, saved: 25, color: "violet", icon: "款" },

  { id: "crm", name: "CRM 業務助理", description: "查詢客戶、案件、機會與歷史互動", department: "sales", type: "AI", badge: "最常使用", users: 34, runs: 428, saved: 118, color: "blue", icon: "客" },
  { id: "rfq", name: "RFQ／PO 查詢", description: "依客戶、料號與單號唯讀查詢", department: "sales", type: "非 AI", users: 31, runs: 286, saved: 54, color: "cyan", icon: "單" },
  { id: "brief", name: "拜訪摘要助手", description: "整理客戶拜訪重點與後續行動", department: "sales", type: "AI", users: 29, runs: 218, saved: 73, color: "violet", icon: "訪" },
  { id: "market", name: "市場情報助手", description: "彙整市場、客戶、競品與新聞", department: "sales", type: "AI", users: 25, runs: 156, saved: 49, color: "orange", icon: "情" },
  { id: "forecast", name: "業績預測看板", description: "機會進度、預測金額與落差追蹤", department: "sales", type: "非 AI", users: 18, runs: 94, saved: 24, color: "green", icon: "績" },

  { id: "inventory", name: "庫存異常助手", description: "標示呆滯、短缺與異常異動", department: "material", type: "AI", users: 21, runs: 196, saved: 66, color: "orange", icon: "庫" },
  { id: "stock", name: "即時庫存查詢", description: "依廠別、儲位與料號查詢存量", department: "material", type: "非 AI", users: 24, runs: 382, saved: 48, color: "cyan", icon: "存" },
  { id: "label", name: "標籤批次產生", description: "批次產生入出庫與料件標籤", department: "material", type: "非 AI", users: 18, runs: 142, saved: 31, color: "green", icon: "標" },
  { id: "demand", name: "需求彙整助手", description: "彙整交期、需求變更與缺料項目", department: "material", type: "AI", users: 16, runs: 118, saved: 41, color: "violet", icon: "需" },

  { id: "shift1", name: "交班摘要助手", description: "彙整生產、異常與待處理事項", department: "mfg1", type: "AI", users: 38, runs: 304, saved: 92, color: "blue", icon: "班" },
  { id: "daily1", name: "生產日報整併", description: "合併線別日報並計算達成率", department: "mfg1", type: "非 AI", users: 41, runs: 266, saved: 61, color: "green", icon: "日" },
  { id: "issue1", name: "異常通報中心", description: "通報設備、品質與物料異常", department: "mfg1", type: "非 AI", users: 35, runs: 182, saved: 42, color: "orange", icon: "異" },
  { id: "sop1", name: "SOP 快速查詢", description: "依站別與機種取得核准版 SOP", department: "mfg1", type: "AI", users: 32, runs: 215, saved: 69, color: "violet", icon: "程" },

  { id: "shift2", name: "交班摘要助手", description: "彙整生產、異常與待處理事項", department: "mfg2", type: "AI", users: 36, runs: 288, saved: 86, color: "blue", icon: "班" },
  { id: "daily2", name: "生產日報整併", description: "合併線別日報並計算達成率", department: "mfg2", type: "非 AI", users: 38, runs: 248, saved: 58, color: "green", icon: "日" },
  { id: "issue2", name: "異常通報中心", description: "通報設備、品質與物料異常", department: "mfg2", type: "非 AI", users: 34, runs: 174, saved: 41, color: "orange", icon: "異" },
  { id: "sop2", name: "SOP 快速查詢", description: "依站別與機種取得核准版 SOP", department: "mfg2", type: "AI", users: 29, runs: 202, saved: 62, color: "violet", icon: "程" },

  { id: "kpi", name: "經營 KPI 看板", description: "彙整部門目標、實績與變化趨勢", department: "management", type: "非 AI", users: 8, runs: 128, saved: 27, color: "green", icon: "標" },
  { id: "report", name: "管理報告助手", description: "依指標產生月報重點與初稿", department: "management", type: "AI", users: 8, runs: 94, saved: 36, color: "violet", icon: "報" },
  { id: "benefit", name: "工具效益分析", description: "比較採用率、節省工時與任務成果", department: "management", type: "非 AI", users: 8, runs: 78, saved: 18, color: "blue", icon: "效" },
  { id: "project", name: "專案進度摘要", description: "跨部門彙整里程碑、風險與待決策", department: "management", type: "AI", users: 7, runs: 62, saved: 28, color: "orange", icon: "進" },
  { id: "decision", name: "決策資料搜尋", description: "搜尋歷次會議、決議與追蹤狀態", department: "management", type: "AI", users: 7, runs: 54, saved: 22, color: "cyan", icon: "決" },
];

const trend = [42, 47, 51, 55, 59, 63, 68, 72, 76, 79, 82, 85];

function formatNumber(value: number) {
  return new Intl.NumberFormat("zh-TW").format(value);
}

export default function Home() {
  const [activeDepartment, setActiveDepartment] = useState("shared");
  const [view, setView] = useState<"tools" | "analytics">("tools");
  const [query, setQuery] = useState("");
  const [type, setType] = useState<"全部" | "AI" | "非 AI">("全部");
  const [selectedTool, setSelectedTool] = useState<Tool | null>(null);

  const department = departments.find((item) => item.id === activeDepartment) ?? departments[0];
  const visibleTools = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return tools.filter((tool) => {
      const matchesDepartment = tool.department === activeDepartment;
      const matchesType = type === "全部" || tool.type === type;
      const matchesQuery = !normalized || `${tool.name}${tool.description}`.toLowerCase().includes(normalized);
      return matchesDepartment && matchesType && matchesQuery;
    });
  }, [activeDepartment, query, type]);

  const totalRuns = tools.reduce((sum, tool) => sum + tool.runs, 0);
  const totalSaved = departments.slice(1).reduce((sum, item) => sum + item.saved, 0);

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand" aria-label="企業工具平台首頁">
          <div className="brand-mark"><span></span><span></span><span></span><span></span></div>
          <div>
            <strong>WorkHub</strong>
            <small>企業智慧工具平台</small>
          </div>
        </div>
        <nav className="topnav" aria-label="主要功能">
          <button className={view === "tools" ? "active" : ""} onClick={() => setView("tools")}>工具中心</button>
          <button className={view === "analytics" ? "active" : ""} onClick={() => setView("analytics")}>管理者後台</button>
        </nav>
        <div className="user-area">
          <button className="icon-button" aria-label="通知"><span className="notification-dot"></span>◎</button>
          <div className="avatar">王</div>
          <div className="user-copy"><strong>王大明</strong><small>資訊部・管理者</small></div>
          <span className="chevron">⌄</span>
        </div>
      </header>

      <aside className="sidebar">
        <div className="sidebar-heading"><span>部門工具</span><small>12 個分類</small></div>
        <nav className="department-list" aria-label="部門分類">
          {departments.map((item, index) => (
            <button
              key={item.id}
              className={activeDepartment === item.id ? "active" : ""}
              onClick={() => { setActiveDepartment(item.id); setView("tools"); setQuery(""); }}
            >
              <span className={`dept-icon ${index === 0 ? "shared" : ""}`}>{item.short}</span>
              <span>{item.name}</span>
              <small>{item.tools}</small>
            </button>
          ))}
        </nav>
        <div className="sidebar-footer">
          <div className="status-row"><span className="status-dot"></span><span>服務運作正常</span></div>
          <p>最後更新 08/13 14:32</p>
        </div>
      </aside>

      <main className="main-content">
        {view === "tools" ? (
          <>
            <section className="welcome-row">
              <div>
                <p className="eyebrow">工具中心</p>
                <h1>{department.name}</h1>
                <p>{department.id === "shared" ? "所有同仁都能使用的日常效率工具" : `提供 ${department.name} 同仁使用的專屬工具與工作流程`}</p>
              </div>
              <div className="compact-metrics" aria-label="部門使用概況">
                <div><strong>{department.count}</strong><span>部門人數</span></div>
                <div><strong>{department.active}</strong><span>本月活躍</span></div>
                <div><strong>{department.tools}</strong><span>可用工具</span></div>
              </div>
            </section>

            <section className="toolbar" aria-label="工具搜尋與篩選">
              <label className="search-box">
                <span>⌕</span>
                <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜尋工具名稱或用途…" aria-label="搜尋工具" />
                <kbd>⌘ K</kbd>
              </label>
              <div className="segmented" aria-label="工具類型">
                {(["全部", "AI", "非 AI"] as const).map((item) => (
                  <button key={item} className={type === item ? "active" : ""} onClick={() => setType(item)}>{item === "AI" ? "AI 工具" : item === "非 AI" ? "非 AI" : item}</button>
                ))}
              </div>
            </section>

            <section className="section-title">
              <div><h2>{department.id === "shared" ? "共用工具" : `${department.name}工具`}</h2><span>{visibleTools.length} 項</span></div>
              <p>依您的 AD 權限顯示</p>
            </section>

            {visibleTools.length > 0 ? (
              <section className="tool-grid">
                {visibleTools.map((tool) => (
                  <article className="tool-card" key={tool.id}>
                    <div className="tool-top">
                      <div className={`tool-icon ${tool.color}`}>{tool.icon}</div>
                      <div className="tool-tags"><span className={tool.type === "AI" ? "ai-tag" : "plain-tag"}>{tool.type}</span>{tool.badge && <span className="hot-tag">{tool.badge}</span>}</div>
                    </div>
                    <h3>{tool.name}</h3>
                    <p>{tool.description}</p>
                    <div className="tool-stats"><span><b>{tool.users}</b> 人使用</span><span><b>{formatNumber(tool.runs)}</b> 次執行</span></div>
                    <button className="launch-button" onClick={() => setSelectedTool(tool)}>開啟工具 <span>→</span></button>
                  </article>
                ))}
              </section>
            ) : (
              <div className="empty-state"><strong>找不到符合的工具</strong><p>請調整搜尋字詞或工具類型。</p></div>
            )}

            <section className="privacy-note"><span>盾</span><div><strong>資料安全由平台統一控管</strong><p>AI 請求依公司政策選用地端或核准的雲端模型；平台會記錄使用事件，不會顯示個人輸入內容給主管。</p></div></section>
          </>
        ) : (
          <Analytics totalRuns={totalRuns} totalSaved={totalSaved} />
        )}
      </main>

      {selectedTool && (
        <div className="modal-backdrop" role="presentation" onMouseDown={() => setSelectedTool(null)}>
          <section className="tool-modal" role="dialog" aria-modal="true" aria-labelledby="tool-modal-title" onMouseDown={(event) => event.stopPropagation()}>
            <button className="modal-close" onClick={() => setSelectedTool(null)} aria-label="關閉">×</button>
            <div className={`tool-icon ${selectedTool.color} large`}>{selectedTool.icon}</div>
            <span className={selectedTool.type === "AI" ? "ai-tag" : "plain-tag"}>{selectedTool.type} 工具</span>
            <h2 id="tool-modal-title">{selectedTool.name}</h2>
            <p>{selectedTool.description}</p>
            <div className="modal-kpis">
              <div><strong>{selectedTool.users}</strong><span>本月使用者</span></div>
              <div><strong>{formatNumber(selectedTool.runs)}</strong><span>執行次數</span></div>
              <div><strong>{selectedTool.saved}h</strong><span>預估節省</span></div>
            </div>
            <div className="launch-panel">
              <div><strong>準備就緒</strong><span>{selectedTool.type === "AI" ? "由 LLM Proxy 套用公司資料政策" : "使用事件將寫入統一遙測服務"}</span></div>
              <button onClick={() => setSelectedTool(null)}>進入工具 <span>↗</span></button>
            </div>
          </section>
        </div>
      )}
    </div>
  );
}

function Analytics({ totalRuns, totalSaved }: { totalRuns: number; totalSaved: number }) {
  const [period, setPeriod] = useState("本月");
  const [detailDepartment, setDetailDepartment] = useState("sales");
  const ranked = [...departments.slice(1)].sort((a, b) => b.active / b.count - a.active / a.count);
  const detail = departments.find((item) => item.id === detailDepartment) ?? departments[7];
  const detailTools = tools.filter((tool) => tool.department === detailDepartment);
  const detailRuns = detailTools.reduce((sum, tool) => sum + tool.runs, 0);
  const detailSaved = detailTools.reduce((sum, tool) => sum + tool.saved, 0);
  return (
    <div className="analytics-view">
      <section className="analytics-header">
        <div><p className="eyebrow">管理者視角</p><h1>平台成效儀表板</h1><p>追蹤 300–350 位同仁的採用狀況與量化效益</p></div>
        <label className="period-select"><span>期間</span><select value={period} onChange={(event) => setPeriod(event.target.value)}><option>本月</option><option>近 3 個月</option><option>本年度</option></select></label>
      </section>

      <section className="kpi-grid">
        <article><div className="kpi-label"><span className="mini-icon blue">人</span>本月活躍使用者</div><strong>286 <small>/ 328 人</small></strong><p className="positive">↑ 12.4% <span>較上月</span></p></article>
        <article><div className="kpi-label"><span className="mini-icon violet">用</span>整體採用率</div><strong>87.2%</strong><p className="positive">↑ 5.8% <span>較上月</span></p></article>
        <article><div className="kpi-label"><span className="mini-icon cyan">次</span>工具執行次數</div><strong>{formatNumber(totalRuns)}</strong><p className="positive">↑ 18.6% <span>較上月</span></p></article>
        <article className="highlight"><div className="kpi-label"><span className="mini-icon orange">時</span>預估節省工時</div><strong>{formatNumber(totalSaved)} <small>小時</small></strong><p>約當 <b>{Math.round(totalSaved / 160)} 人月</b> 工作量</p></article>
      </section>

      <section className="analytics-grid">
        <article className="panel usage-trend">
          <div className="panel-header"><div><h2>平台採用趨勢</h2><p>近 12 週不重複活躍使用者</p></div><span className="legend"><i></i> 活躍使用者</span></div>
          <div className="chart-wrap">
            <div className="y-axis"><span>300</span><span>200</span><span>100</span><span>0</span></div>
            <div className="line-chart" role="img" aria-label="活躍使用者由第一週 138 人成長至第十二週 286 人">
              {[100, 67, 34, 0].map((pos) => <i className="grid-line" style={{ top: `${pos}%` }} key={pos}></i>)}
              <div className="trend-bars">{trend.map((value, index) => <div className="trend-column" key={index}><i style={{ height: `${value}%` }}><b></b></i></div>)}</div>
              <div className="x-axis">{["5/25", "6/01", "6/08", "6/15", "6/22", "6/29", "7/06", "7/13", "7/20", "7/27", "8/03", "8/10"].map((label) => <span key={label}>{label}</span>)}</div>
            </div>
          </div>
        </article>

        <article className="panel type-share">
          <div className="panel-header"><div><h2>工具類型分布</h2><p>依本月執行次數</p></div></div>
          <div className="donut" style={{ background: "conic-gradient(#615bd7 0 68%, #2fb6aa 68% 100%)" }}><div><strong>68%</strong><span>AI 工具</span></div></div>
          <div className="donut-legend"><div><span><i className="purple-dot"></i>AI 工具</span><strong>6,284 次</strong></div><div><span><i className="teal-dot"></i>非 AI 工具</span><strong>2,957 次</strong></div></div>
        </article>
      </section>

      <section className="panel department-performance">
        <div className="panel-header"><div><h2>部門採用與效益</h2><p>點選部門可查看該部門的工具</p></div><span className="data-note">資料截至 08/13 14:32</span></div>
        <div className="performance-table" role="table" aria-label="部門採用與效益">
          <div className="table-row table-head" role="row"><span>部門</span><span>活躍使用者</span><span>採用率</span><span>使用次數</span><span>可用工具</span><span>節省工時</span><span>狀態</span><span></span></div>
          {ranked.map((item) => {
            const rate = Math.round(item.active / item.count * 100);
            const runs = tools.filter((tool) => tool.department === item.id).reduce((sum, tool) => sum + tool.runs, 0);
            return <button className={`table-row ${detailDepartment === item.id ? "selected" : ""}`} role="row" key={item.id} onClick={() => setDetailDepartment(item.id)}>
              <span className="dept-cell"><i>{item.short}</i><strong>{item.name}</strong></span>
              <span><b>{item.active}</b> / {item.count} 人</span>
              <span className="rate-cell"><i><b style={{ width: `${rate}%` }}></b></i><strong>{rate}%</strong></span>
              <span><b>{formatNumber(runs)}</b> 次</span><span>{item.tools} 項</span><span><b>{item.saved}h</b></span>
              <span><em className={rate >= 85 ? "excellent" : rate >= 75 ? "steady" : "attention"}>{rate >= 85 ? "表現優異" : rate >= 75 ? "穩定成長" : "需關注"}</em></span>
              <span className="row-arrow">→</span>
            </button>;
          })}
        </div>
      </section>

      <section className="panel tool-detail-panel">
        <div className="detail-header">
          <div><p className="eyebrow">部門工具明細</p><h2>{detail.name}｜使用次數與成效</h2><p>比較每一項工具的實際使用與可量化效益</p></div>
          <label><span>切換部門</span><select value={detailDepartment} onChange={(event) => setDetailDepartment(event.target.value)}>{departments.slice(1).map((item) => <option value={item.id} key={item.id}>{item.name}</option>)}</select></label>
        </div>
        <div className="detail-summary">
          <div><span>部門活躍人數</span><strong>{detail.active} <small>/ {detail.count} 人</small></strong></div>
          <div><span>部門工具使用次數</span><strong>{formatNumber(detailRuns)} <small>次</small></strong></div>
          <div><span>預估節省工時</span><strong>{formatNumber(detailSaved)} <small>小時</small></strong></div>
          <div><span>人均節省工時</span><strong>{(detailSaved / Math.max(detail.active, 1)).toFixed(1)} <small>小時</small></strong></div>
        </div>
        <div className="tool-detail-table" role="table" aria-label={`${detail.name}工具使用與效益`}>
          <div className="tool-detail-row tool-detail-head" role="row"><span>工具名稱</span><span>類型</span><span>使用人數</span><span>使用次數</span><span>任務完成率</span><span>節省工時</span><span>效益判讀</span></div>
          {detailTools.sort((a, b) => b.runs - a.runs).map((tool, index) => {
            const completion = Math.max(88, 98 - index * 2);
            const reach = Math.round(tool.users / detail.count * 100);
            const impact = tool.saved >= 60 ? "高效益" : tool.saved >= 30 ? "效益穩定" : reach < 45 ? "推廣中" : "持續觀察";
            return <div className="tool-detail-row" role="row" key={tool.id}>
              <span className="detail-tool-name"><i className={`tool-icon ${tool.color}`}>{tool.icon}</i><span><strong>{tool.name}</strong><small>{tool.description}</small></span></span>
              <span><em className={tool.type === "AI" ? "ai-tag" : "plain-tag"}>{tool.type}</em></span>
              <span><b>{tool.users}</b> 人 <small>({reach}%)</small></span>
              <span><b>{formatNumber(tool.runs)}</b> 次</span>
              <span className="completion-cell"><i><b style={{ width: `${completion}%` }}></b></i><strong>{completion}%</strong></span>
              <span><b>{tool.saved}h</b></span>
              <span><em className={impact === "高效益" ? "impact-high" : impact === "效益穩定" ? "impact-steady" : "impact-watch"}>{impact}</em></span>
            </div>;
          })}
        </div>
        <div className="detail-footer"><span>i</span><p><strong>管理建議：</strong>{detailTools.some((tool) => tool.saved >= 60) ? `${detailTools.sort((a,b) => b.saved - a.saved)[0]?.name}帶來最高節省工時，可評估擴大使用情境。` : "目前工具使用穩定，建議持續觀察完成率與使用覆蓋。"} 低於 50% 覆蓋率的工具可安排教育訓練或訪談。</p></div>
      </section>

      <section className="measurement-note"><span>i</span><div><strong>效益估算方式</strong><p>由工具負責人設定每次成功任務的基準節省時間，平台只計入「完成」事件。實際效益可在第二階段加入任務成果與主管覆核。</p></div></section>
    </div>
  );
}
