"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ToolEntry } from "./tool-entry";
import { ModelUsagePanel } from "./model-admin";
import { ManagementCenter, managementViews, type ManagementView } from "./management-center";
import { DEFAULT_LOCAL_MODEL, defaultConfig, entryBlock, initialDemo, normalizeModel, type DemoState } from "./demo-management";
import { onboardingApi, type CatalogTool } from "./onboarding-api";
import { canSeeTrial, canUseTool, ROLES, useDeveloperName, useEmployeeDepartment, useRole, VIEWS_BY_ROLE, type Role } from "./role";

const newEventId = () => `evt_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;

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
  url?: string;
  /** AI Team 在發布管理設定的內建圖示（0～5）；未設定時依卡片位置輪替 */
  symbol?: number;
  /** 適用情境（平台上的工具由開發者／AI Team 填寫） */
  scenario?: string;
};

const departments: Department[] = [
  { id: "shared", name: "全公司共用", short: "全", count: 328, active: 286, tools: 7, saved: 916 },
  { id: "finance", name: "財務部", short: "財", count: 18, active: 16, tools: 5, saved: 138 },
  { id: "it", name: "資訊部", short: "資", count: 14, active: 14, tools: 6, saved: 171 },
  { id: "hr", name: "人力資源部", short: "人", count: 12, active: 10, tools: 5, saved: 96 },
  { id: "general", name: "總務部", short: "總", count: 15, active: 11, tools: 4, saved: 72 },
  { id: "rd", name: "研發部", short: "研", count: 56, active: 47, tools: 7, saved: 496 },
  { id: "purchase", name: "採購部", short: "採", count: 21, active: 18, tools: 5, saved: 142 },
  { id: "sales", name: "業務部", short: "業", count: 38, active: 34, tools: 6, saved: 318 },
  { id: "material", name: "資材部", short: "材", count: 26, active: 22, tools: 5, saved: 186 },
  { id: "mfg1", name: "製造一部", short: "一", count: 52, active: 41, tools: 5, saved: 264 },
  { id: "mfg2", name: "製造二部", short: "二", count: 48, active: 39, tools: 6, saved: 247 },
  { id: "management", name: "經營管理室", short: "經", count: 8, active: 8, tools: 6, saved: 121 },
];

/** 示範卡片與實際上架工具的固定對照（tool.id → 示範卡片 id） */
const RELEASED_ALIAS: Record<string, string> = { 'quote-aggregator': 'quote' };

const tools: Tool[] = [
  { id: "openwebui", name: "OpenWebUI", description: "既有 AI 助理授權入口；正式 URL 待提供", department: "shared", type: "AI", users: 0, runs: 0, saved: 0, color: "blue", icon: "AI", url: "" },
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

  { id: "vision", name: "AI 識圖大師", url: "", description: "辨識 RF 工程圖規格，逐筆定位、核對與匯出", department: "mfg2", type: "AI", badge: "新工具", users: 32, runs: 274, saved: 112, color: "violet", icon: "圖" },
  { id: "spec", name: "規格文件助手", description: "摘要規格、比對版本與標示變更", department: "rd", type: "AI", badge: "熱門", users: 42, runs: 318, saved: 126, color: "violet", icon: "規" },
  { id: "patent", name: "專利檢索助手", description: "整理技術關鍵字與相似專利", department: "rd", type: "AI", users: 31, runs: 186, saved: 84, color: "blue", icon: "專" },
  { id: "testreport", name: "測試報告產生器", description: "彙整測試數據與報告格式", department: "rd", type: "非 AI", users: 38, runs: 241, saved: 71, color: "green", icon: "測" },
  { id: "bom", name: "BOM 差異比對", description: "快速標示版本間料件差異", department: "rd", type: "非 AI", users: 29, runs: 164, saved: 49, color: "cyan", icon: "料" },
  { id: "risk", name: "設計風險檢查", description: "依歷史案例提示潛在設計風險", department: "rd", type: "AI", users: 24, runs: 127, saved: 41, color: "orange", icon: "險" },
  { id: "tech", name: "技術知識搜尋", description: "跨專案搜尋核准的技術文件", department: "rd", type: "AI", users: 35, runs: 223, saved: 68, color: "pink", icon: "知" },

  { id: "quote", name: "採購報價單彙整工具", description: "將不同格式的供應商報價檔匯整為統一比較表", department: "purchase", type: "AI", users: 17, runs: 164, saved: 58, color: "blue", icon: "價" },
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

  ...departments.map((department) => ({
    id: `knowledge-${department.id}`,
    name: department.id === "shared" ? "企業知識庫問答" : `${department.name}知識庫問答`,
    description: department.id === "shared" ? "查詢全公司核准的制度、流程與共用文件" : `依權限查詢${department.name}核准的規範、流程與知識文件`,
    department: department.id,
    type: "AI" as const,
    badge: department.id === "shared" ? "全員可用" : "部門知識",
    users: department.active,
    runs: department.active * 7,
    saved: Math.max(12, Math.round(department.active * 1.6)),
    color: "violet",
    icon: "知",
  })),
];

const trend = [42, 47, 51, 55, 59, 63, 68, 72, 76, 79, 82, 85];

function formatNumber(value: number) {
  return new Intl.NumberFormat("zh-TW").format(value);
}

function getToolScenario(tool: Tool) {
  const scenarios: Record<string, string> = {
    meeting: "會議逐字稿、跨部門討論、決策與待辦追蹤",
    translate: "客戶英文郵件、外文規格書、跨國往來文件",
    document: "辦公文件轉檔、歸檔前格式統一、附件整理",
    mail: "客戶回覆、內部通知、正式商務往來",
    search: "查詢內規、申請流程、公司共用作業規範",
    image: "郵件附件、報告插圖、網站素材批次瘦身",
    vision: "RF 工程圖球標辨識、規格核對與校正匯出",
    quote: "多家供應商報價整併、數量級距與價格比較",
  };
  // 已上架工具以平台（開發者填、AI Team 可改）的適用情境為準；沒填就不顯示，不再套預設句
  return tool.scenario ?? scenarios[tool.id] ?? "";
}

export default function Home() {
  const [activeDepartment, setActiveDepartment] = useState("shared");
  const [view, setView] = useState<"tools" | "analytics" | ManagementView>("tools");
  const [query, setQuery] = useState("");
  const [type, setType] = useState<"全部" | "AI" | "非 AI">("全部");
  const [activeTool, setActiveTool] = useState<Tool | null>(null);
  const [selectedToolId, setSelectedToolId] = useState("");
  const [role, setRole] = useRole();
  const [developer, setDeveloper] = useDeveloperName();
  const [employeeDepartment, setEmployeeDepartment] = useEmployeeDepartment();
  const myDepartment = role === "employee" ? employeeDepartment : ROLES.find((r) => r.id === role)!.department;
  const allowed = VIEWS_BY_ROLE[role];
  const changeRole = (r: Role) => { setRole(r); if (!VIEWS_BY_ROLE[r].includes(view)) setView("tools"); setSelectedToolId(""); };

  const [demo, setDemo] = useState<DemoState>(initialDemo);
  const [demoLoaded, setDemoLoaded] = useState(false);
  const [message, setMessage] = useState("");
  const [categoryFilter, setCategoryFilter] = useState("全部分類");
  const [favoritesOnly, setFavoritesOnly] = useState(false);
  const [announcement, setAnnouncement] = useState(false);
  useEffect(() => {
    let cancelled = false;
    queueMicrotask(() => {
    if (cancelled) return;
    try {
      const raw = localStorage.getItem('workhub-demo-v018');
      if (raw) { const saved = JSON.parse(raw); if (saved && Array.isArray(saved.added) && saved.configs && Array.isArray(saved.categories)) setDemo({...initialDemo(), ...saved}); }
    } catch { setMessage('本機示範資料無法讀取，已使用初始內容'); }
    setDemoLoaded(true);
    });
    return () => { cancelled = true; };
  }, []);
  useEffect(() => {
    if (!demoLoaded) return;
    try { localStorage.setItem('workhub-demo-v018', JSON.stringify(demo)); }
    catch { queueMicrotask(() => setMessage('瀏覽器無法儲存；本次操作僅在目前頁面保留')); }
  }, [demo, demoLoaded]);
  // 上架服務已發布、健康檢查通過的工具：覆蓋示範設定的狀態、版本、Owner 與入口網址（服務未啟動時維持示範資料）
  const [released, setReleased] = useState<CatalogTool[]>([]);
  const [submissionOwners, setSubmissionOwners] = useState<string[]>([]);
  useEffect(() => {
    let alive = true;
    const load = () => {
      void onboardingApi.list().then((r) => { if (alive) setSubmissionOwners([...new Set(r.map((s) => s.owner))]); }).catch(() => {});
      return onboardingApi.catalog().then((r) => { if (alive) setReleased(r); }).catch(() => { if (alive) setReleased([]); });
    };
    void load();
    const timer = setInterval(load, 20000);
    // 維運動作完成後立即更新入口狀態
    window.addEventListener('workhub:catalog-refresh', load);
    return () => { alive = false; clearInterval(timer); window.removeEventListener('workhub:catalog-refresh', load); };
  }, []);
  // 已發布工具對應到示範卡片：先看固定對照（tool.id），再看名稱；名稱可在平台改，對照不受影響
  const matchDemo = useCallback((r: CatalogTool) => tools.find((t) => t.id === RELEASED_ALIAS[r.toolId]) ?? tools.find((t) => t.name === r.name) ?? demo.added.find((t) => t.name === r.name), [demo.added]);
  const releasedExtra = useMemo<Tool[]>(() => released
    .filter((r) => !matchDemo(r))
    .map((r) => ({ id: `rel-${r.toolId}`, name: r.name, description: r.description || '已透過上架服務發布的工具', department: r.department, type: r.usesModel ? 'AI' : '非 AI', users: 0, runs: 0, saved: 0, color: r.icon?.color ?? 'blue', symbol: r.icon?.symbol, icon: r.name.slice(0, 1) }) as Tool), [released, matchDemo]);
  const releasedById = useMemo(() => Object.fromEntries(released.map((r) => {
    const match = matchDemo(r);
    return [match?.id ?? `rel-${r.toolId}`, r];
  })) as Record<string, CatalogTool>, [released, matchDemo]);
  const releasedIds = useMemo(() => Object.fromEntries(Object.entries(releasedById).map(([id, r]) => [id, r.toolId])) as Record<string, string>, [releasedById]);
  const shown = useMemo<DemoState>(() => {
    const configs = { ...demo.configs };
    for (const [id, r] of Object.entries(releasedById)) {
      const tool = [...tools, ...demo.added, ...releasedExtra].find((t) => t.id === id);
      if (!tool) continue;
      configs[id] = { ...(configs[id] ?? defaultConfig(tool)), status: r.offline ? '已下架' : r.maintenance ? '維護中' : r.healthy ? '運行中' : '維護中', version: r.version, owner: r.owner, url: r.url ?? '', access: true, model: r.kind === 'url' ? (r.usesModel ? '外部網站自有模型（不經平台模型轉接）' : '不使用模型') : r.usesModel ? normalizeModel(configs[id]?.model ?? DEFAULT_LOCAL_MODEL) : '不使用模型', ...(r.description ? { description: r.description } : {}) };
    }
    return { ...demo, configs };
  }, [demo, releasedById, releasedExtra]);
  const catalog = useMemo(() => [...tools, ...demo.added, ...releasedExtra].map(tool => {
    const c = shown.configs[tool.id];
    const name = releasedById[tool.id]?.name ?? tool.name; // 已發布工具的名稱以平台為準
    const ic = releasedById[tool.id]?.icon; // 圖示以平台（AI Team 設定）為準
    const r = releasedById[tool.id];
    const look = { ...(ic ? { color: ic.color, symbol: ic.symbol } : {}), ...(r ? { scenario: r.scenario ?? '', type: (r.usesModel ? 'AI' : '非 AI') as Tool['type'] } : {}) }; // 已上架工具是否為 AI 以平台資料為準
    return c ? {...tool, name, ...look, description:c.description, ...(c.url || tool.url !== undefined ? {url:c.url} : {})} : {...tool, name, ...look};
  }), [demo.added, shown.configs, releasedExtra, releasedById]);
  const changeDemo = (fn: (s: DemoState) => DemoState) => setDemo(fn);
  const recordClick = (id:string) => {
    setDemo(s => ({...s, clicks:[...s.clicks, {tool:id,time:new Date().toLocaleString('zh-TW')}].slice(-500)}));
    const r = releasedById[id];
    if (r) void onboardingApi.entryEvent({ clientEventId: newEventId(), toolId: r.toolId, kind: 'click' }).catch(() => {});
  };
  const department = departments.find((item) => item.id === activeDepartment) ?? departments[0];
  const visibleTools = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return catalog.filter((tool) => {
      const matchesDepartment = tool.department === activeDepartment;
      const matchesType = type === "全部" || tool.type === type;
      const matchesQuery = !normalized || `${tool.name}${tool.description}`.toLowerCase().includes(normalized);
      // 試用中（未公開）的工具：一般員工看不到（示範；正式環境由後端依登入身分過濾）
      // 開發者只看得到自己當 Owner 的試用工具；AI Team 看得到全部
      const rel = releasedById[tool.id];
      if (rel?.visibility === "trial" && !canSeeTrial(role, developer, rel.owner)) return false;
      return matchesDepartment && matchesType && matchesQuery && (!favoritesOnly || demo.favorites.includes(tool.id)) && (categoryFilter === "全部分類" || (shown.configs[tool.id] ?? defaultConfig(tool)).category === categoryFilter);
    });
  }, [activeDepartment, query, type, catalog, categoryFilter, favoritesOnly, demo.favorites, shown.configs, role, developer, releasedById]);
  // 示範用開發者清單：已上架工具與提交紀錄裡出現過的 Owner
  const owners = useMemo(() => [...new Set([...released.map((r) => r.owner), ...submissionOwners])].sort(), [released, submissionOwners]);
  // 記住的開發者若已不在 Owner 清單（例如工具已封存），改用清單第一位，避免下拉選單顯示的人和實際篩選的人不一致
  const devName = (owners.includes(developer) ? developer : owners[0]) || "";
  const seesTrial = (id: string) => { const r = releasedById[id]; return !!r && canSeeTrial(role, devName, r.owner); };
  const deptName = (id: string) => departments.find((d) => d.id === id)?.name ?? id;
  const usable = (tool: Tool) => canUseTool(role, myDepartment, tool.department, devName, releasedById[tool.id]?.owner);
  const trialLabel = (id: string) => { const r = releasedById[id]; if (!r || !seesTrial(id)) return ""; return r.visibility === "trial" ? " · 試用中（未公開）" : r.trial ? ` · 有試用版 ${r.trial.version}` : ""; };

  const totalRuns = tools.reduce((sum, tool) => sum + tool.runs, 0);
  const totalSaved = departments.slice(1).reduce((sum, item) => sum + item.saved, 0);
  const selectedTool = visibleTools.find((tool) => tool.id === selectedToolId) ?? null;
  // 已發布工具服務未回應時，選取即記錄一次阻擋事件（每次選取一筆，不因定時更新重複）
  const blockedLogged = useRef('');
  useEffect(() => {
    const r = releasedById[selectedToolId];
    const tool = catalog.find((t) => t.id === selectedToolId);
    const deptBlocked = !!tool && !canUseTool(role, myDepartment, tool.department, devName, r?.owner);
    if (!r || (r.healthy && !r.maintenance && !deptBlocked)) { if (!r) blockedLogged.current = ''; return; }
    if (blockedLogged.current === selectedToolId) return;
    blockedLogged.current = selectedToolId;
    void onboardingApi.entryEvent({ clientEventId: newEventId(), toolId: r.toolId, kind: 'blocked', reason: deptBlocked ? '非所屬部門' : r.offline ? '工具已下架' : r.maintenance ? '工具維護中' : '服務健康檢查未回應' }).catch(() => {});
  }, [selectedToolId, releasedById, catalog, role, myDepartment, devName]);

  useEffect(() => {
    function focusSearch(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        document.getElementById("tool-search")?.focus();
      }
    }
    window.addEventListener("keydown", focusSearch);
    return () => window.removeEventListener("keydown", focusSearch);
  }, []);

  if (activeTool?.id === "quote") {
    return <QuoteWorkspace onBack={() => setActiveTool(null)} />;
  }
  if (activeTool?.id.startsWith("knowledge-")) {
    const toolDepartment = departments.find((item) => item.id === activeTool.department) ?? department;
    return <KnowledgeWorkspace department={toolDepartment} onBack={() => setActiveTool(null)} />;
  }
  if (activeTool) {
    return <GeneralToolWorkspace tool={activeTool} onBack={() => setActiveTool(null)} />;
  }

  return (
    <div className="app-shell branded-shell">
      <header className="topbar">
        <div className="brand" aria-label="企業工具平台首頁">
          <div><strong>昇達<span>AI工具平台</span></strong><small>UMT INTERNAL TOOLS</small></div>
        </div>
        <nav className="topnav" aria-label="主要功能">
          <button className={view === "tools" ? "active" : ""} onClick={() => setView("tools")}>工具中心</button>
          {allowed.includes("analytics") && <button className={view === "analytics" ? "active" : ""} onClick={() => setView("analytics")}>使用分析</button>}
          {managementViews.filter(item => allowed.includes(item.id)).map(item => <button key={item.id} className={view === item.id ? "active" : ""} onClick={() => setView(item.id)}>{item.label}</button>)}
        </nav>
        <div className="user-area">
          <label className="department-switcher"><span>部門別</span><select value={activeDepartment} onChange={(event) => { setActiveDepartment(event.target.value); setView("tools"); setQuery(""); setSelectedToolId(""); }}>{departments.map((item) => <option value={item.id} key={item.id}>{item.name}</option>)}</select></label>
          <label className="department-switcher" title="示範用：本機試點沒有登入，切換身分可看到不同人看得到的工具與按鈕；不是安全保護"><span>目前身分（示範）</span><select aria-label="目前身分" value={role} onChange={(event) => changeRole(event.target.value as Role)}>{ROLES.map((r) => <option value={r.id} key={r.id}>{r.label}</option>)}</select></label>
          {role === "employee" && <label className="department-switcher" title="示範用：一般員工所屬的部門；只能使用所屬部門與全公司共用的工具"><span>所屬部門（示範）</span><select aria-label="所屬部門" value={employeeDepartment} onChange={(event) => { setEmployeeDepartment(event.target.value); setSelectedToolId(""); }}>{departments.filter((d) => d.id !== "shared").map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}</select></label>}
          {role === "developer" && <label className="department-switcher" title="示範用：選擇目前的開發者（對應工具的 Owner）；開發者只看得到自己當 Owner 的試用工具"><span>開發者（Owner）</span><select aria-label="目前開發者" value={devName} onChange={(event) => setDeveloper(event.target.value)}>{owners.length ? owners.map((o) => <option key={o} value={o}>{o}</option>) : <option value="">（尚無已發布工具）</option>}</select></label>}
          <div className="avatar">{ROLES.find((r) => r.id === role)!.avatar}</div>
          <div className="user-copy"><strong>{role === "developer" && devName ? devName : ROLES.find((r) => r.id === role)!.person}</strong><small>{deptName(myDepartment)}・{ROLES.find((r) => r.id === role)!.unit.replace(/^資訊部・/, "")}</small></div>
        </div>
      </header>

      {message && <div className="demo-message" role="status">{message}<button onClick={() => setMessage("")}>關閉</button></div>}
      <main className={`main-content ${view === "tools" ? "tool-center-main" : "admin-center-main"}`}>
        {view === "tools" ? (
          <div className="tool-center-stage">
            <div className="orbit orbit-one" aria-hidden="true"></div><div className="orbit orbit-two" aria-hidden="true"></div><span className="orbit-beacon" aria-hidden="true"></span>
            <div className="satellite-watermark" aria-hidden="true"><span className="satellite-panel left"></span><span className="satellite-body"></span><span className="satellite-panel right"></span><span className="satellite-dish"></span><span className="satellite-signal one"></span><span className="satellite-signal two"></span><i></i></div>
            <section className="welcome-row">
              <div>
                <p className="eyebrow">工具中心</p>
                <h1>{department.name}</h1>
                <p>{department.id === "shared" ? "所有同仁都能使用的日常效率工具" : `提供 ${department.name} 同仁使用的專屬工具與工作流程`}</p>
              </div>
              <div className="compact-metrics" aria-label="部門使用概況">
                <div><strong>{department.count}</strong><span>部門人數</span></div>
                <div><strong>{department.active}</strong><span>本月活躍</span></div>
                <div><strong>{visibleTools.length}</strong><span>可用工具</span></div>
              </div>
            </section>

            <button className="demo-news" onClick={() => setAnnouncement(!announcement)}>更新公告：上架申請、發布維運與分類管理已加入 Demo · {announcement ? "收起" : "查看"}</button>
            {announcement && <div className="mg-panel">以採購報價單彙整工具示範全流程；AI 識圖維持獨立入口。新增工具經檢查、測試與核准後出現在對應部門。所有工具名稱與統計示例均非代建清單。</div>}
            <section className="toolbar" aria-label="工具搜尋與篩選">
              <label className="search-box">
                <span>⌕</span>
                <input id="tool-search" value={query} onChange={(event) => { setQuery(event.target.value); setSelectedToolId(""); }} placeholder="搜尋工具名稱或用途…" aria-label="搜尋工具" />
                <kbd>⌘ K</kbd>
              </label>
              <div className="segmented" aria-label="工具類型">
                {(["全部", "AI", "非 AI"] as const).map((item) => (
                  <button key={item} className={type === item ? "active" : ""} onClick={() => { setType(item); setSelectedToolId(""); }}>{item === "AI" ? "AI 工具" : item === "非 AI" ? "非 AI" : item}</button>
                ))}
              </div>
            </section>

            <div className="demo-filters"><label>功能分類<select value={categoryFilter} onChange={e => setCategoryFilter(e.target.value)}><option>全部分類</option>{demo.categories.map(c => <option key={c}>{c}</option>)}</select></label><button aria-pressed={favoritesOnly} onClick={() => setFavoritesOnly(!favoritesOnly)}>{favoritesOnly ? "★ 我的收藏" : "☆ 顯示收藏"}</button><button onClick={() => setView("issues")}>聯絡管理者／權限申請</button></div>
            <section className="section-title">
              <div><h2>{department.id === "shared" ? "共用工具" : `${department.name}工具`}</h2><span>{visibleTools.length} 項</span></div>
              <p>可瀏覽所有部門的工具；只有所屬部門同仁可以使用（示範，正式由 AD 登入與後台權限控管）</p>
            </section>

            {visibleTools.length > 0 ? (
              <section className="tool-grid">
                {visibleTools.map((tool, index) => (
                  <button className={`tool-card ${selectedToolId === tool.id ? "selected" : ""}`} key={tool.id} onClick={() => setSelectedToolId((current) => current === tool.id ? "" : tool.id)} aria-expanded={selectedToolId === tool.id}>
                    <span className={`tool-icon metal-tile ${tool.color}`}><i className={`metal-symbol symbol-${tool.symbol ?? index % 6}`}></i></span>
                    <strong>{tool.name}</strong>
                    <small>{(shown.configs[tool.id] ?? defaultConfig(tool)).status}{!(shown.configs[tool.id] ?? defaultConfig(tool)).access && " · 需申請權限"}{trialLabel(tool.id)}</small>
                  </button>
                ))}
              </section>
            ) : (
              <div className="empty-state"><strong>找不到符合的工具</strong><p>請調整搜尋字詞或工具類型。</p></div>
            )}

            {selectedTool && <section className="tool-detail-card"><span className={`tool-icon metal-tile compact ${selectedTool.color}`}><i className={`metal-symbol symbol-${selectedTool.symbol ?? 1}`}></i></span><div><div><h2>{selectedTool.name}</h2></div><p>{selectedTool.description}</p>{getToolScenario(selectedTool) && <small>適用情境：<strong>{getToolScenario(selectedTool)}</strong></small>}{seesTrial(selectedTool.id) && releasedById[selectedTool.id]?.visibility === "trial" && <small className="trial-note">試用中（未公開）：只有 Owner（{releasedById[selectedTool.id].owner}）與 AI Team 看得到；AI Team 公開後才開放給一般使用者。</small>}{seesTrial(selectedTool.id) && releasedById[selectedTool.id]?.trial?.url && <small className="trial-note">新版 {releasedById[selectedTool.id].trial!.version} 試用中（一般使用者仍使用 {releasedById[selectedTool.id].version}）：<a href={releasedById[selectedTool.id].trial!.url!} target="_blank" rel="noopener noreferrer" onClick={() => void onboardingApi.entryEvent({ clientEventId: newEventId(), toolId: releasedById[selectedTool.id].toolId, kind: "click", trial: true }).catch(() => {})}>開啟試用版 ↗</a></small>}</div><div className="demo-entry-actions"><button onClick={() => setDemo(s => ({...s,favorites:s.favorites.includes(selectedTool.id)?s.favorites.filter(id=>id!==selectedTool.id):[...s.favorites,selectedTool.id]}))}>{demo.favorites.includes(selectedTool.id)?'★ 取消收藏':'☆ 收藏'}</button>{!usable(selectedTool) ? <span>僅限{deptName(selectedTool.department)}同仁使用</span> : entryBlock(shown.configs[selectedTool.id] ?? defaultConfig(selectedTool)) ? <><span>{entryBlock(shown.configs[selectedTool.id] ?? defaultConfig(selectedTool))}</span>{!(shown.configs[selectedTool.id] ?? defaultConfig(selectedTool)).access && <button disabled={demo.requests.includes(selectedTool.id)} onClick={() => {setDemo(s=>({...s,requests:[...s.requests,selectedTool.id]}));setMessage('已加入本機權限申請，可至聯絡管理者示範核准');}}>{demo.requests.includes(selectedTool.id)?'申請中':'申請權限'}</button>}</> : <ToolEntry tool={selectedTool} onEntry={() => recordClick(selectedTool.id)} onOpenInternal={() => setActiveTool(selectedTool)} />}</div></section>}
          </div>
        ) : view === "analytics" ? (
          <Analytics totalRuns={totalRuns} totalSaved={totalSaved} />
        ) : <ManagementCenter role={role} developer={devName} view={view} state={shown} tools={catalog} departments={departments} change={changeDemo} notice={setMessage} releasedIds={releasedIds} urlToolIds={released.filter((r) => r.kind === 'url').map((r) => r.toolId)} goTo={setView} /> }
      </main>

    </div>
  );
}

const toolInputHints: Record<string, string> = {
  meeting: "貼上會議逐字稿、筆記或討論內容，系統會整理摘要、決策與待辦事項…",
  translate: "貼上要翻譯的內容，並在開頭註明目標語言…",
  mail: "輸入郵件情境、收件對象與希望傳達的重點…",
  search: "輸入想查詢的公司規章、表單或流程問題…",
};

function WorkHubToolHeader({ onBack }: { onBack: () => void }) {
  return (
    <header className="direct-tool-topbar">
      <button className="direct-tool-brand" onClick={onBack} aria-label="返回工具中心">
        <span className="umt-wordmark"><strong>昇達<span>AI工具平台</span></strong><small>UMT INTERNAL TOOLS</small></span>
      </button>
      <button className="direct-tool-back" onClick={onBack}>← 返回工具中心</button>
    </header>
  );
}

function GeneralToolWorkspace({ tool, onBack }: { tool: Tool; onBack: () => void }) {
  const [content, setContent] = useState("");
  const [attachment, setAttachment] = useState("");
  const [completed, setCompleted] = useState(false);
  const canRun = Boolean(content.trim() || attachment);
  const isMeetingTool = tool.id === "meeting";
  const placeholder = toolInputHints[tool.id] ?? `輸入要交給「${tool.name}」處理的內容或需求…`;

  function runTool() {
    if (!canRun) return;
    setCompleted(true);
  }

  return (
    <div className="direct-tool-app">
      <WorkHubToolHeader onBack={onBack} />

      <main className="direct-tool-main">
        <section className="direct-tool-intro">
          <div className={`tool-icon metal-tile ${tool.color} large`}><i className={`metal-symbol symbol-${tool.symbol ?? 1}`}></i></div>
          <div>
            <span className={tool.type === "AI" ? "ai-tag" : "plain-tag"}>{tool.type} 工具</span>
            <h1>{tool.name}</h1>
            <p>{tool.description}</p>
          </div>
        </section>

        <section className="direct-tool-workbench">
          <div className="direct-tool-input-card">
            <div className="direct-tool-card-heading">
              <div><span>1</span><strong>{isMeetingTool ? "加入會議內容" : "加入處理內容"}</strong></div>
              <small>可直接貼上文字或加入檔案</small>
            </div>

            <label className={`direct-tool-upload ${attachment ? "has-file" : ""}`}>
              <input type="file" onChange={(event) => { setAttachment(event.target.files?.[0]?.name ?? ""); setCompleted(false); }} />
              <span>{attachment ? "✓" : "＋"}</span>
              <div><strong>{attachment || "加入檔案"}</strong><small>{attachment ? "檔案已準備完成，可開始執行" : "支援文件、試算表、PDF、圖片或音訊"}</small></div>
            </label>

            <label className="direct-tool-editor">
              <span>{isMeetingTool ? "會議內容" : "工作內容"}</span>
              <textarea value={content} onChange={(event) => { setContent(event.target.value); setCompleted(false); }} placeholder={placeholder} />
              <small>{content.length} 字</small>
            </label>

            <button className="direct-tool-run" disabled={!canRun} onClick={runTool}>
              {tool.type === "AI" ? "開始 AI 處理" : "開始執行"} <span>→</span>
            </button>
          </div>

          <aside className="direct-tool-side">
            <section>
              <p className="eyebrow">使用提示</p>
              <h2>打開後即可開始</h2>
              <p>不需要再次確認或進入下一層。加入內容後直接執行，處理結果會顯示在同一頁面。</p>
              <ul>
                <li><span>✓</span>自動套用公司資料政策</li>
                <li><span>✓</span>只記錄使用事件與成效</li>
                <li><span>✓</span>主管不會看到輸入內容</li>
              </ul>
            </section>
          </aside>
        </section>

        {completed && (
          <section className="direct-tool-result" aria-live="polite">
            <header><div><span>✓</span><div><strong>處理完成</strong><small>{tool.name} 已產生可供確認的結果</small></div></div><button onClick={() => setCompleted(false)}>重新處理</button></header>
            {isMeetingTool ? (
              <div className="meeting-result-grid">
                <article><span>摘要</span><p>本次會議確認平台工具將改為點擊後直接開啟，減少一次不必要的操作。</p></article>
                <article><span>決策</span><p>移除工具啟動前的成效彈窗，使用數據改由管理者後台統一查看。</p></article>
                <article><span>待辦事項</span><p>完成所有工具入口檢查，並確認手機與桌面版皆可直接使用。</p></article>
              </div>
            ) : (
              <div className="generic-tool-result"><span>完成</span><p>已根據你提供的內容完成「{tool.name}」處理。正式串接後，這裡會呈現實際系統輸出與下載選項。</p></div>
            )}
          </section>
        )}
      </main>
    </div>
  );
}

type KnowledgeMessage = { role: "user" | "assistant"; content: string };
type SavedPrompt = { id: string; name: string; command: string; content: string; scope: "個人" | "部門共用" | "全公司共用" };
type ManagedKnowledgeBase = { id: string; name: string; description: string; scope: "全公司" | "部門"; files: number; updated: string; attached: boolean; locked: boolean };

const knowledgeSuggestions: Record<string, string[]> = {
  shared: ["查詢出差補助規定", "資訊安全事件如何通報？", "會議室與公務車如何申請？", "請假與特休規定有哪些？"],
  finance: ["請款憑證需要哪些資料？", "費用報銷的截止日是什麼時候？", "固定資產如何認列？", "付款條件變更需要誰核准？"],
  it: ["資訊設備如何申請？", "帳號權限異動流程是什麼？", "資安事件如何通報？", "軟體安裝有哪些限制？"],
  hr: ["特休假如何計算？", "加班申請的核准流程？", "新人報到需準備哪些資料？", "教育訓練補助規定？"],
  general: ["修繕申請流程是什麼？", "公務車如何預約？", "門禁卡遺失如何處理？", "會議室使用規範？"],
  rd: ["設計變更需要哪些審查？", "圖面版次如何命名？", "研發樣品如何申請採購？", "技術文件的保密等級？"],
  purchase: ["新供應商如何申請建檔？", "詢比議價需要幾家廠商？", "採購單變更流程是什麼？", "交期異常如何處理？"],
  sales: ["客戶報價的核准層級？", "RFQ 案件如何建檔？", "客訴案件如何通報？", "樣品申請需要哪些資料？"],
  material: ["領料與退料流程是什麼？", "呆滯料如何判定？", "盤點差異如何處理？", "安全庫存如何設定？"],
  mfg1: ["製造異常如何通報？", "換線前需要確認哪些項目？", "SOP 版次如何確認？", "交班紀錄要填哪些內容？"],
  mfg2: ["設備點檢的頻率？", "生產異常如何分級？", "首件檢查流程是什麼？", "工單結案需要哪些資料？"],
  management: ["月會資料的繳交期限？", "KPI 異常如何提出改善？", "專案風險如何分級？", "決策事項如何追蹤？"],
};

function getDefaultPrompts(department: Department): SavedPrompt[] {
  return [
    { id: "summary", name: "文件重點摘要", command: "/summary", content: "請依目前核准的知識內容整理重點摘要，列出適用對象、辦理步驟、核准層級與注意事項。", scope: "全公司共用" },
    { id: "compare", name: "規範版本比較", command: "/compare", content: "請比較知識庫中最新版本與前一版本的差異，依新增、刪除、修改分類整理，並說明對現行作業的影響。", scope: "全公司共用" },
    { id: `department-${department.id}`, name: `${department.name}標準問答`, command: "/dept_qa", content: `請只根據${department.name}與全公司共用知識庫回答。先給結論，再列出辦理步驟、負責角色及引用文件；資料不足時請明確說明，不要自行推測。`, scope: department.id === "shared" ? "全公司共用" : "部門共用" },
    { id: "my-checklist", name: "轉成執行清單", command: "/checklist", content: "請把查詢結果轉成可勾選的執行清單，包含負責人、必要文件、完成條件與可能風險。", scope: "個人" },
  ];
}

function getDefaultKnowledgeBases(department: Department): ManagedKnowledgeBase[] {
  const companyBase: ManagedKnowledgeBase = { id: "company-core", name: "全公司制度與共用流程", description: "人事、資訊安全、總務與跨部門共用規範", scope: "全公司", files: 42, updated: "今天 09:30", attached: true, locked: department.id !== "shared" };
  const scopedBase: ManagedKnowledgeBase = department.id === "shared"
    ? { id: "company-forms", name: "公司表單與申請指南", description: "常用表單、申請方式與核准權限說明", scope: "全公司", files: 28, updated: "昨天 16:20", attached: true, locked: false }
    : { id: `${department.id}-primary`, name: `${department.name}作業知識庫`, description: `${department.name}核准的 SOP、作業辦法與常見問題`, scope: "部門", files: Math.max(12, Math.round(department.count * .7)), updated: "今天 10:15", attached: true, locked: false };
  return [companyBase, scopedBase];
}

function KnowledgeWorkspace({ department, onBack }: { department: Department; onBack: () => void }) {
  const [input, setInput] = useState("");
  const [messages, setMessages] = useState<KnowledgeMessage[]>([]);
  const [searching, setSearching] = useState(false);
  const [showPrompts, setShowPrompts] = useState(false);
  const [creatingPrompt, setCreatingPrompt] = useState(false);
  const [promptSearch, setPromptSearch] = useState("");
  const [promptsLoaded, setPromptsLoaded] = useState(false);
  const [prompts, setPrompts] = useState<SavedPrompt[]>(() => getDefaultPrompts(department));
  const [newPrompt, setNewPrompt] = useState({ name: "", command: "", content: "", scope: "個人" as SavedPrompt["scope"] });
  const suggestions = knowledgeSuggestions[department.id] ?? knowledgeSuggestions.shared;
  const scopeName = department.id === "shared" ? "全公司知識庫" : `${department.name}知識庫`;
  const visiblePrompts = prompts.filter((prompt) => !promptSearch.trim() || `${prompt.name}${prompt.command}${prompt.content}`.toLowerCase().includes(promptSearch.trim().toLowerCase()));

  useEffect(() => {
    const saved = window.localStorage.getItem(`workhub-prompts-${department.id}`);
    if (saved) {
      try { setPrompts(JSON.parse(saved) as SavedPrompt[]); } catch { setPrompts(getDefaultPrompts(department)); }
    }
    setPromptsLoaded(true);
  }, [department]);

  useEffect(() => {
    if (promptsLoaded) window.localStorage.setItem(`workhub-prompts-${department.id}`, JSON.stringify(prompts));
  }, [department.id, prompts, promptsLoaded]);

  function submitQuestion(question = input) {
    const raw = question.trim();
    const matchedPrompt = prompts.find((prompt) => prompt.command.toLowerCase() === raw.toLowerCase());
    const trimmed = matchedPrompt?.content ?? raw;
    if (!trimmed) return;
    setMessages((current) => [...current, { role: "user", content: trimmed }, {
      role: "assistant",
      content: `根據「${scopeName}」目前核准且有效的知識內容，這個問題需要依下列原則辦理：先確認申請條件與適用對象，再依核准層級完成申請；若案件涉及跨部門，系統會同時套用全公司共用規範。若現有資訊不足，系統會明確提示向管理窗口確認。`,
    }]);
    setInput("");
    setSearching(false);
  }

  function savePrompt() {
    const command = newPrompt.command.trim().replace(/^\/*/, "/");
    if (!newPrompt.name.trim() || command === "/" || !newPrompt.content.trim()) return;
    setPrompts((current) => [...current, { id: `custom-${Date.now()}`, name: newPrompt.name.trim(), command, content: newPrompt.content.trim(), scope: newPrompt.scope }]);
    setNewPrompt({ name: "", command: "", content: "", scope: "個人" });
    setCreatingPrompt(false);
  }

  function applyPrompt(prompt: SavedPrompt) {
    setInput(prompt.content);
    setShowPrompts(false);
  }

  function newChat() {
    setMessages([]);
    setInput("");
    setSearching(false);
  }

  return (
    <div className="knowledge-shell">
      <WorkHubToolHeader onBack={onBack} />
      <div className="knowledge-app">
      <aside className="knowledge-sidebar">
        <header><button className="knowledge-logo" onClick={onBack}>知</button><strong>企業知識庫問答</strong><button className="knowledge-collapse" onClick={onBack} aria-label="返回工具中心">◧</button></header>
        <nav className="knowledge-main-nav">
          <button onClick={newChat}><span>✎</span>新增對話</button>
          <button className={searching ? "active" : ""} onClick={() => setSearching((value) => !value)}><span>⌕</span>搜尋</button>
          <button><span>▣</span>筆記</button>
          <button><span>⌘</span>工作區</button>
        </nav>
        {searching && <label className="knowledge-search"><span>⌕</span><input autoFocus placeholder="搜尋歷史對話…" /></label>}
        <div className="knowledge-group"><strong>目前問答範圍</strong></div>
        <div className="knowledge-scope-card"><span className={`dept-icon ${department.id === "shared" ? "shared" : ""}`}>{department.short}</span><div><strong>{scopeName}</strong><small>由管理者依部門權限預先設定</small></div><i>✓</i></div>
        <div className="knowledge-history">
          <p>近期對話</p>
          <button className="active"><span></span>{messages[0]?.content ?? "新的知識庫查詢"}<small>現在</small></button>
          <button><span></span>{suggestions[0]}<small>昨天</small></button>
          <button><span></span>{suggestions[1]}<small>3 天前</small></button>
          <button><span></span>整理本月常見問題<small>1 週前</small></button>
        </div>
        <div className="knowledge-user"><span>王</span><div><strong>王大明</strong><small>{department.id === "shared" ? "全公司權限" : department.name}</small></div><i></i></div>
      </aside>

      <main className="knowledge-main">
        <header className="knowledge-topbar">
          <div><strong>企業 AI 助理</strong><span>｜</span><b>{scopeName}查詢</b><button>⌄</button></div>
          <div><button className={`knowledge-prompt-trigger ${showPrompts ? "active" : ""}`} onClick={() => setShowPrompts((value) => !value)}><i>⌘</i>Prompt 範本<em>{prompts.length}</em></button><button title="查詢設定">☷</button><button className="knowledge-back" onClick={onBack}>← 返回工具中心</button></div>
        </header>

        <section className={`knowledge-chat ${messages.length ? "has-messages" : ""}`}>
          {messages.length === 0 ? (
            <div className="knowledge-empty">
              <div className="knowledge-title"><span>{department.short}</span><h1>企業 AI 助理 <i>｜</i> {scopeName}查詢</h1></div>
              <p>系統會依您的部門與權限回答問題，直接輸入問題即可。</p>
              <div className="auto-knowledge-badge"><span>✓</span><div><strong>問答範圍已由管理者設定</strong><small>系統會自動套用您有權限使用的核准知識內容</small></div><em>直接提問</em></div>
              <KnowledgeComposer input={input} setInput={setInput} submitQuestion={submitQuestion} onOpenPrompts={() => setShowPrompts(true)} prompts={prompts} />
              <div className="knowledge-suggestions"><small>ϟ 建議問題</small>{suggestions.map((item) => <button key={item} onClick={() => submitQuestion(item)}>{item}<span>↗</span></button>)}</div>
            </div>
          ) : (
            <div className="knowledge-conversation">
              <div className="conversation-scope"><span>{department.short}</span><div><strong>{scopeName}</strong><small>已套用您的部門與權限範圍</small></div><em>權限套用 ✓</em></div>
              {messages.map((message, index) => <article key={index} className={`knowledge-message ${message.role}`}>
                <span>{message.role === "user" ? "王" : "AI"}</span><div><strong>{message.role === "user" ? "您" : "企業 AI 助理"}</strong><p>{message.content}</p></div>
              </article>)}
              <KnowledgeComposer input={input} setInput={setInput} submitQuestion={submitQuestion} onOpenPrompts={() => setShowPrompts(true)} prompts={prompts} compact />
            </div>
          )}
        </section>

        {showPrompts && <div className="prompt-drawer-backdrop" onMouseDown={() => setShowPrompts(false)}><aside className="prompt-drawer" onMouseDown={(event) => event.stopPropagation()}>
          <header><div><span>⌘</span><div><strong>Prompt 範本</strong><small>儲存一次，之後一鍵套用或輸入 / 指令</small></div></div><button onClick={() => setShowPrompts(false)} aria-label="關閉 Prompt 範本">×</button></header>
          <div className="prompt-drawer-tools"><label><span>⌕</span><input value={promptSearch} onChange={(event) => setPromptSearch(event.target.value)} placeholder="搜尋名稱或 / 指令…" /></label><button onClick={() => setCreatingPrompt(true)}>＋ 新增 Prompt</button></div>
          {creatingPrompt && <section className="prompt-create-form"><div><strong>新增 Prompt</strong><button onClick={() => setCreatingPrompt(false)}>×</button></div><label>名稱<input value={newPrompt.name} onChange={(event) => setNewPrompt((current) => ({ ...current, name: event.target.value }))} placeholder="例如：會議紀錄整理" /></label><label>指令<input value={newPrompt.command} onChange={(event) => setNewPrompt((current) => ({ ...current, command: event.target.value }))} placeholder="/meeting" /></label><label>使用範圍<select value={newPrompt.scope} onChange={(event) => setNewPrompt((current) => ({ ...current, scope: event.target.value as SavedPrompt["scope"] }))}><option>個人</option><option>部門共用</option><option>全公司共用</option></select></label><label>Prompt 內容<textarea value={newPrompt.content} onChange={(event) => setNewPrompt((current) => ({ ...current, content: event.target.value }))} placeholder="輸入要重複使用的完整指令，也可預留 {{變數}}…" /></label><button className="prompt-save" disabled={!newPrompt.name.trim() || !newPrompt.command.trim() || !newPrompt.content.trim()} onClick={savePrompt}>儲存 Prompt</button></section>}
          <div className="prompt-list">
            {visiblePrompts.map((prompt) => <article key={prompt.id}><div className="prompt-card-top"><span>{prompt.scope === "個人" ? "我" : prompt.scope === "部門共用" ? department.short : "全"}</span><div><strong>{prompt.name}</strong><code>{prompt.command}</code></div><em className={prompt.scope === "個人" ? "personal" : prompt.scope === "部門共用" ? "department" : "company"}>{prompt.scope}</em></div><p>{prompt.content}</p><div><small>支援變數與版本紀錄</small><button onClick={() => applyPrompt(prompt)}>套用到對話 →</button></div></article>)}
            {visiblePrompts.length === 0 && <div className="prompt-empty">找不到符合的 Prompt</div>}
          </div>
          <footer><span>提示</span><p>也可以在輸入框直接輸入 <code>/summary</code> 等指令執行已儲存 Prompt。</p></footer>
        </aside></div>}
      </main>
      </div>
    </div>
  );
}

function KnowledgeComposer({ input, setInput, submitQuestion, onOpenPrompts, prompts, compact = false }: { input: string; setInput: (value: string) => void; submitQuestion: (value?: string) => void; onOpenPrompts: () => void; prompts: SavedPrompt[]; compact?: boolean }) {
  const [activePromptIndex, setActivePromptIndex] = useState(0);
  const [dismissedValue, setDismissedValue] = useState("");
  const slashQuery = input.trim().toLowerCase();
  const slashMode = /^\/[^\s]*$/.test(slashQuery) && dismissedValue !== input;
  const matchingPrompts = slashMode ? prompts.filter((prompt) => `${prompt.command} ${prompt.name}`.toLowerCase().includes(slashQuery.slice(1))) : [];
  const safeActiveIndex = matchingPrompts.length ? Math.min(activePromptIndex, matchingPrompts.length - 1) : 0;

  function choosePrompt(prompt: SavedPrompt) {
    setInput(prompt.content);
    setActivePromptIndex(0);
    setDismissedValue("");
  }

  return <form className={`knowledge-composer ${compact ? "compact" : ""}`} onSubmit={(event) => { event.preventDefault(); submitQuestion(); }}>
    {slashMode && <div className="slash-prompt-menu" role="listbox" aria-label="可用 Prompt">
      <header><span>⌘</span><div><strong>可用的 Prompt</strong><small>{slashQuery === "/" ? `顯示全部 ${matchingPrompts.length} 個範本` : `依「${slashQuery}」篩選出 ${matchingPrompts.length} 個`}</small></div><kbd>↑↓ 選擇・Enter 套用</kbd></header>
      <div>{matchingPrompts.map((prompt, index) => <button type="button" role="option" aria-selected={safeActiveIndex === index} className={safeActiveIndex === index ? "active" : ""} key={prompt.id} onMouseDown={(event) => { event.preventDefault(); choosePrompt(prompt); }} onMouseEnter={() => setActivePromptIndex(index)}><span>{prompt.scope === "個人" ? "我" : prompt.scope === "部門共用" ? "部" : "全"}</span><div><strong>{prompt.command}</strong><small>{prompt.name}</small></div><em>{prompt.scope}</em><i>↵</i></button>)}</div>
      {matchingPrompts.length === 0 && <p>找不到相符的 Prompt，請換一個關鍵字或開啟範本庫。</p>}
      <footer><button type="button" onMouseDown={(event) => { event.preventDefault(); onOpenPrompts(); }}>管理所有 Prompt →</button></footer>
    </div>}
    <textarea value={input} onChange={(event) => { setInput(event.target.value); setActivePromptIndex(0); setDismissedValue(""); }} onKeyDown={(event) => {
      if (slashMode && matchingPrompts.length) {
        if (event.key === "ArrowDown") { event.preventDefault(); setActivePromptIndex((value) => (value + 1) % matchingPrompts.length); return; }
        if (event.key === "ArrowUp") { event.preventDefault(); setActivePromptIndex((value) => (value - 1 + matchingPrompts.length) % matchingPrompts.length); return; }
        if (event.key === "Enter" || event.key === "Tab") { event.preventDefault(); choosePrompt(matchingPrompts[safeActiveIndex]); return; }
      }
      if (event.key === "Escape" && slashMode) { event.preventDefault(); setDismissedValue(input); return; }
      if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); submitQuestion(); }
    }} placeholder="今天我能為您查詢什麼？輸入 / 可使用已儲存 Prompt" aria-label="輸入知識庫問題" aria-expanded={slashMode} />
    <div><span><button type="button" aria-label="加入附件">＋</button><button type="button" onClick={onOpenPrompts} aria-label="開啟 Prompt 範本">⌘</button><small>問答權限由管理者設定・輸入 / 搜尋 Prompt</small></span><button className="knowledge-send" type="submit" disabled={!input.trim()} aria-label="送出問題">↑</button></div>
  </form>;
}

function QuoteWorkspace({ onBack }: { onBack: () => void }) {
  const [section, setSection] = useState<"app" | "guide" | "history">("app");
  const [projectCode, setProjectCode] = useState("");
  const [quantityRanges, setQuantityRanges] = useState("2, 10, 20, 50, 100");
  const [files, setFiles] = useState<File[]>([]);
  const [dragging, setDragging] = useState(false);
  const [attempted, setAttempted] = useState(false);
  const [generated, setGenerated] = useState(false);

  const canExport = projectCode.trim().length > 0 && files.length > 0;

  function addFiles(incoming: FileList | null) {
    if (!incoming) return;
    setFiles((current) => {
      const merged = [...current];
      Array.from(incoming).forEach((file) => {
        if (!merged.some((item) => item.name === file.name && item.size === file.size)) merged.push(file);
      });
      return merged;
    });
    setGenerated(false);
  }

  function buildComparison() {
    setAttempted(true);
    if (!canExport) return;
    setGenerated(true);
  }

  return (
    <div className="quote-app">
      <WorkHubToolHeader onBack={onBack} />
      <aside className="quote-sidebar">
        <nav aria-label="採購報價工具功能">
          <button className={section === "app" ? "active" : ""} onClick={() => setSection("app")}><span>價</span>採購報價匯整</button>
          <button className={section === "guide" ? "active" : ""} onClick={() => setSection("guide")}><span>?</span>使用說明</button>
          <button className={section === "history" ? "active" : ""} onClick={() => setSection("history")}><span>時</span>歷史查價</button>
        </nav>
        <div className="quote-local-note"><span>✓</span><div><strong>本機安全執行</strong><small>報價檔不會上傳外部雲端</small></div></div>
      </aside>

      <main className="quote-main">
        {section === "app" && (
          <div className="quote-content">
            <section className="quote-intro">
              <p className="eyebrow">PURCHASE QUOTATION CONSOLIDATOR</p>
              <h1>採購報價匯整工具</h1>
              <p>把廠商雜亂的報價檔自動彙整成統一格式的比較表 <span>｜</span> 本機執行不上雲</p>
            </section>

            <section className="quote-form" aria-label="建立採購報價比較表">
              <div className="quote-field-row">
                <label htmlFor="project-code">專案號碼<small>必填</small></label>
                <div>
                  <input id="project-code" value={projectCode} onChange={(event) => { setProjectCode(event.target.value); setGenerated(false); }} placeholder="輸入採購案編號，例如 RFQ-2025-001" aria-invalid={attempted && !projectCode.trim()} />
                  {attempted && !projectCode.trim() && <p className="quote-error">△ 必填，未填寫無法匯出比較表</p>}
                </div>
                <button className="quote-export" disabled={!canExport} onClick={buildComparison}>匯出比較表</button>
              </div>

              <div className="quote-field-row quantity-row">
                <label htmlFor="quantity-ranges">數量區間</label>
                <div><input id="quantity-ranges" value={quantityRanges} onChange={(event) => { setQuantityRanges(event.target.value); setGenerated(false); }} aria-describedby="quantity-help" /><p id="quantity-help">以逗號分隔，匯整時會依各數量級距比較單價。</p></div>
                <span />
              </div>

              <div className="quote-divider" />

              <div className="quote-upload-row">
                <label
                  className={`quote-dropzone ${dragging ? "dragging" : ""}`}
                  onDragOver={(event) => { event.preventDefault(); setDragging(true); }}
                  onDragLeave={() => setDragging(false)}
                  onDrop={(event) => { event.preventDefault(); setDragging(false); addFiles(event.dataTransfer.files); }}
                >
                  <input type="file" multiple accept=".xlsx,.xls,.doc,.docx,.pdf,.eml,.msg" onChange={(event) => addFiles(event.target.files)} />
                  <span className="quote-upload-icon">↥</span>
                  <div><strong>將報價單檔案拖曳到此處</strong><p>或點擊選擇檔案・單檔上限 200MB</p><small>XLSX、XLS、DOC、DOCX、PDF、EML、MSG</small></div>
                </label>
                <button className="quote-clear" disabled={files.length === 0} onClick={() => { setFiles([]); setGenerated(false); }}>↻ 清空重來</button>
              </div>

              {files.length > 0 && (
                <div className="quote-file-list">
                  <div><strong>已加入 {files.length} 份報價檔</strong><small>系統將依檔名建立供應商來源，並保留原始檔案追溯資訊。</small></div>
                  {files.map((file, index) => <span key={`${file.name}-${file.size}`}><b>{index + 1}</b><em>{file.name}</em><small>{file.size ? `${(file.size / 1024 / 1024).toFixed(1)} MB` : "待讀取"}</small><button onClick={() => { setFiles((current) => current.filter((item) => item !== file)); setGenerated(false); }} aria-label={`移除 ${file.name}`}>×</button></span>)}
                </div>
              )}

              {attempted && projectCode.trim() && files.length === 0 && <p className="quote-error upload-error">△ 請至少加入一份供應商報價檔</p>}

              {generated && (
                <section className="quote-result" aria-live="polite">
                  <div><span>✓</span><div><strong>比較表已建立</strong><p>{projectCode}・已匯整 {files.length} 份檔案・{quantityRanges.split(",").filter(Boolean).length} 個數量區間</p></div></div>
                  <button>下載 Excel 比較表 ↓</button>
                </section>
              )}
            </section>
          </div>
        )}

        {section === "guide" && (
          <div className="quote-secondary"><p className="eyebrow">使用說明</p><h1>三步驟完成報價匯整</h1><div className="quote-guide-grid"><article><span>1</span><strong>設定採購案</strong><p>輸入專案號碼與要比較的數量區間。</p></article><article><span>2</span><strong>加入廠商報價</strong><p>可混合上傳試算表、文件、PDF 或郵件。</p></article><article><span>3</span><strong>建立比較表</strong><p>統一料號、幣別、單價、交期與付款條件。</p></article></div></div>
        )}

        {section === "history" && (
          <div className="quote-secondary"><p className="eyebrow">歷史查價</p><h1>近期採購案件</h1><div className="quote-history-table"><div><span>專案號碼</span><span>報價檔</span><span>建立日期</span><span>狀態</span></div><div><strong>RFQ-2026-018</strong><span>4 份</span><span>2026/08/12</span><em>已完成</em></div><div><strong>RFQ-2026-017</strong><span>3 份</span><span>2026/08/08</span><em>已完成</em></div><div><strong>RFQ-2026-016</strong><span>5 份</span><span>2026/08/03</span><em>已完成</em></div></div></div>
        )}
      </main>
    </div>
  );
}

function KnowledgeAdminPanel() {
  const [selectedDepartmentId, setSelectedDepartmentId] = useState("shared");
  const [knowledgeBases, setKnowledgeBases] = useState<ManagedKnowledgeBase[]>(() => getDefaultKnowledgeBases(departments[0]));
  const [loadedDepartment, setLoadedDepartment] = useState("");
  const [creatingKnowledgeBase, setCreatingKnowledgeBase] = useState(false);
  const [newKnowledgeBase, setNewKnowledgeBase] = useState({ name: "", description: "" });
  const selectedDepartment = departments.find((item) => item.id === selectedDepartmentId) ?? departments[0];
  const enabledBases = knowledgeBases.filter((base) => base.attached);
  const totalFiles = knowledgeBases.reduce((sum, base) => sum + base.files, 0);

  useEffect(() => {
    const saved = window.localStorage.getItem(`workhub-knowledge-${selectedDepartmentId}`);
    if (saved) {
      try { setKnowledgeBases(JSON.parse(saved) as ManagedKnowledgeBase[]); } catch { setKnowledgeBases(getDefaultKnowledgeBases(selectedDepartment)); }
    } else {
      setKnowledgeBases(getDefaultKnowledgeBases(selectedDepartment));
    }
    setLoadedDepartment(selectedDepartmentId);
    setCreatingKnowledgeBase(false);
    setNewKnowledgeBase({ name: "", description: "" });
  }, [selectedDepartmentId]);

  useEffect(() => {
    if (loadedDepartment === selectedDepartmentId) window.localStorage.setItem(`workhub-knowledge-${selectedDepartmentId}`, JSON.stringify(knowledgeBases));
  }, [knowledgeBases, loadedDepartment, selectedDepartmentId]);

  function saveKnowledgeBase() {
    if (!newKnowledgeBase.name.trim()) return;
    setKnowledgeBases((current) => [...current, {
      id: `knowledge-${Date.now()}`,
      name: newKnowledgeBase.name.trim(),
      description: newKnowledgeBase.description.trim() || `${selectedDepartment.name}新增知識內容`,
      scope: selectedDepartment.id === "shared" ? "全公司" : "部門",
      files: 0,
      updated: "剛剛建立",
      attached: true,
      locked: false,
    }]);
    setNewKnowledgeBase({ name: "", description: "" });
    setCreatingKnowledgeBase(false);
  }

  function addKnowledgeFiles(id: string, incoming: FileList | null) {
    if (!incoming?.length) return;
    setKnowledgeBases((current) => current.map((base) => base.id === id ? { ...base, files: base.files + incoming.length, updated: "剛剛更新" } : base));
  }

  return (
    <section className="knowledge-admin-view">
      <header className="knowledge-admin-header">
        <div><p className="eyebrow">知識治理</p><h2>知識庫管理</h2><p>集中維護全公司與各部門的問答內容；一般同仁只會看到問答介面。</p></div>
        <label><span>管理範圍</span><select value={selectedDepartmentId} onChange={(event) => setSelectedDepartmentId(event.target.value)}>{departments.map((item) => <option value={item.id} key={item.id}>{item.name}</option>)}</select></label>
      </header>

      <div className="knowledge-admin-summary">
        <article><span>目前範圍</span><strong>{selectedDepartment.name}</strong><small>依入口與 AD 權限套用</small></article>
        <article><span>知識庫</span><strong>{knowledgeBases.length}</strong><small>{enabledBases.length} 個已啟用</small></article>
        <article><span>文件總數</span><strong>{totalFiles}</strong><small>支援 Office、PDF 與純文字</small></article>
        <article><span>套用方式</span><strong>自動</strong><small>下一次提問立即生效</small></article>
      </div>

      <div className="knowledge-admin-layout">
        <aside className="knowledge-admin-scopes">
          <div><strong>權限範圍</strong><small>選擇要維護的入口</small></div>
          <nav>{departments.map((item) => <button key={item.id} className={selectedDepartmentId === item.id ? "active" : ""} onClick={() => setSelectedDepartmentId(item.id)}><span className={`dept-icon ${item.id === "shared" ? "shared" : ""}`}>{item.short}</span><div><strong>{item.name}</strong><small>{item.id === "shared" ? "平台管理員" : "部門管理員"}</small></div><i>→</i></button>)}</nav>
        </aside>

        <div className="knowledge-admin-content">
          <section className="knowledge-admin-policy"><span>✓</span><div><strong>前台與資料來源已分離</strong><p>一般使用者不會看到知識庫名稱、文件數或引用來源；管理者在此調整的啟用狀態與文件，會套用至下一次問答。</p></div></section>
          <div className="knowledge-admin-actions"><div><strong>{selectedDepartment.name}知識內容</strong><small>共 {knowledgeBases.length} 個知識庫・{totalFiles} 份文件</small></div><button onClick={() => setCreatingKnowledgeBase(true)}>＋ 新增知識庫</button></div>

          {creatingKnowledgeBase && <section className="kb-create-form admin-form"><div><strong>建立{selectedDepartment.id === "shared" ? "全公司" : selectedDepartment.name}知識庫</strong><button onClick={() => setCreatingKnowledgeBase(false)}>×</button></div><label>知識庫名稱<input value={newKnowledgeBase.name} onChange={(event) => setNewKnowledgeBase((current) => ({ ...current, name: event.target.value }))} placeholder={`例如：${selectedDepartment.name}品質作業規範`} /></label><label>用途說明<textarea value={newKnowledgeBase.description} onChange={(event) => setNewKnowledgeBase((current) => ({ ...current, description: event.target.value }))} placeholder="說明收錄的規範、SOP 或常見問題" /></label><button disabled={!newKnowledgeBase.name.trim()} onClick={saveKnowledgeBase}>建立並啟用</button></section>}

          <div className="knowledge-admin-list">
            {knowledgeBases.map((base) => <article key={base.id} className={base.attached ? "active" : "inactive"}><div className="kb-card-head"><span>{base.scope === "全公司" ? "全" : selectedDepartment.short}</span><div><strong>{base.name}</strong><small>{base.description}</small></div><em>{base.scope}</em></div><div className="kb-card-stats"><span><b>{base.files}</b> 份文件</span><span>更新：{base.updated}</span><i>索引完成 ✓</i></div><div className="kb-card-actions"><label className={base.locked ? "locked" : ""}><input type="checkbox" checked={base.attached} disabled={base.locked} onChange={(event) => setKnowledgeBases((current) => current.map((item) => item.id === base.id ? { ...item, attached: event.target.checked, updated: "剛剛調整" } : item))} /><span></span>{base.locked ? "公司必備內容" : base.attached ? "問答使用中" : "已停用"}</label><label className={base.locked ? "disabled" : "upload"}>＋ 新增文件<input type="file" multiple disabled={base.locked} accept=".pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.txt,.md" onChange={(event) => addKnowledgeFiles(base.id, event.target.files)} /></label></div></article>)}
          </div>
          <footer className="knowledge-admin-footer"><span>權限說明</span><p>{selectedDepartment.id === "shared" ? "全公司知識內容由平台管理員維護，會套用至所有部門入口。" : `${selectedDepartment.name}管理員可維護部門內容；全公司必備內容僅能由平台管理員調整。`}</p></footer>
        </div>
      </div>
    </section>
  );
}

function Analytics({ totalRuns, totalSaved }: { totalRuns: number; totalSaved: number }) {
  const [adminSection, setAdminSection] = useState<"usage" | "models" | "knowledge">("usage");
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
        <div><p className="eyebrow">管理者視角</p><h1>{adminSection === "usage" ? "平台成效儀表板" : adminSection === "models" ? "模型用量" : "知識庫管理後台"}</h1><p>{adminSection === "usage" ? "以下為舊版示意統計；正式容量與效益公式待客戶核准" : adminSection === "models" ? "各工具呼叫 AI 模型的次數、token 與回應時間（真實資料，來自平台模型轉接服務）" : "集中維護全公司與各部門的問答內容、文件與啟用狀態"}</p></div>
        {adminSection === "usage" && <label className="period-select"><span>期間</span><select value={period} onChange={(event) => setPeriod(event.target.value)}><option>本月</option><option>近 3 個月</option><option>本年度</option></select></label>}
      </section>

      <nav className="admin-section-tabs" aria-label="管理者後台功能">
        <button className={adminSection === "usage" ? "active" : ""} onClick={() => setAdminSection("usage")}><span>效</span><div><strong>使用成效</strong><small>採用率與節省工時</small></div></button>
        <button className={adminSection === "models" ? "active" : ""} onClick={() => setAdminSection("models")}><span>模</span><div><strong>模型用量</strong><small>真實資料・各工具呼叫與 token</small></div></button>
        <button className={adminSection === "knowledge" ? "active" : ""} onClick={() => setAdminSection("knowledge")}><span>知</span><div><strong>知識庫管理</strong><small>全公司與部門內容</small></div></button>
      </nav>

      {adminSection === "usage" ? <>
      <section className="kpi-grid">
        <article><div className="kpi-label"><span className="mini-icon blue">人</span>本月活躍使用者</div><strong>286 <small>/ 328 人</small></strong><p className="positive">↑ 12.4% <span>較上月</span></p></article>
        <article><div className="kpi-label"><span className="mini-icon violet">用</span>整體採用率</div><strong>87.2%</strong><p className="positive">↑ 5.8% <span>較上月</span></p></article>
        <article><div className="kpi-label"><span className="mini-icon cyan">次</span>有效入口點擊（示例）</div><strong>{formatNumber(totalRuns)}</strong><p className="positive">↑ 18.6% <span>較上月</span></p></article>
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
          <div className="panel-header"><div><h2>工具類型分布</h2><p>依示例入口點擊</p></div></div>
          <div className="donut" style={{ background: "conic-gradient(#1e2c49 0 68%, #93a5ba 68% 100%)" }}><div><strong>68%</strong><span>AI 工具</span></div></div>
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
          <div className="tool-detail-row tool-detail-head" role="row"><span>工具名稱</span><span>類型</span><span>使用人數</span><span>使用次數</span><span>紀錄口徑</span><span>節省工時</span><span>效益判讀</span></div>
          {detailTools.sort((a, b) => b.runs - a.runs).map((tool, index) => {
            const reach = Math.round(tool.users / detail.count * 100);
            const impact = tool.saved >= 60 ? "高效益" : tool.saved >= 30 ? "效益穩定" : reach < 45 ? "推廣中" : "持續觀察";
            return <div className="tool-detail-row" role="row" key={tool.id}>
              <span className="detail-tool-name"><i className="tool-icon metal-tile admin-tool-icon"><span className={`metal-symbol symbol-${tool.symbol ?? index % 6}`}></span></i><span><strong>{tool.name}</strong><small>{tool.description}</small></span></span>
              <span><em className={tool.type === "AI" ? "ai-tag" : "plain-tag"}>{tool.type}</em></span>
              <span><b>{tool.users}</b> 人 <small>({reach}%)</small></span>
              <span><b>{formatNumber(tool.runs)}</b> 次</span>
              <span>入口點擊</span>
              <span><b>{tool.saved}h</b></span>
              <span><em className={impact === "高效益" ? "impact-high" : impact === "效益穩定" ? "impact-steady" : "impact-watch"}>{impact}</em></span>
            </div>;
          })}
        </div>
        <div className="detail-footer"><span>i</span><p><strong>管理建議：</strong>{detailTools.some((tool) => tool.saved >= 60) ? `${detailTools.sort((a,b) => b.saved - a.saved)[0]?.name}帶來最高節省工時，可評估擴大使用情境。` : "示例數值僅供版面展示，正式效益尚待量測。"} 低於 50% 覆蓋率的工具可安排教育訓練或訪談。</p></div>
      </section>

      <section className="measurement-note"><span>i</span><div><strong>效益估算方式</strong><p>正式紀錄只計通過權限與入口狀態檢查的有效入口點擊，不推定工作完成。節省時間依客戶核准基準與公式計算；本頁歷史數字僅為版面示例，正式效益尚無資料。</p></div></section>
      </> : adminSection === "models" ? <ModelUsagePanel /> : <KnowledgeAdminPanel />}
    </div>
  );
}
