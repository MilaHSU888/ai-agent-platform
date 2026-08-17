"use client";

import { useMemo, useRef, useState } from "react";
import * as XLSX from "xlsx";

type View = "departments" | "chat" | "prompts" | "qa" | "admin" | "access" | "analytics";
type Permission = "view" | "upload" | "review" | "admin";
type Account = {
  id: string;
  name: string;
  email: string;
  title: string;
  initials: string;
  permissions: Record<string, Permission[]>;
};
type Department = {
  id: string;
  name: string;
  short: string;
  description: string;
  documents: number;
  entries: string;
  updated: string;
  color: string;
  topics: string[];
  starters: string[];
};

type KnowledgeDocument = {
  id: string;
  name: string;
  department: string;
  type: string;
  version: string;
  rows: number;
  updated: string;
  owner: string;
  status: "已發布" | "索引中" | "待審核";
};

type Message = {
  id: number;
  role: "user" | "assistant";
  content: string;
  citations?: string[];
};

const departments: Department[] = [
  { id: "finance", name: "財務部", short: "財", description: "費用、預算、請款與會計制度", documents: 36, entries: "12.8K", updated: "12 分鐘前", color: "indigo", topics: ["費用報支", "預算規範", "付款流程"], starters: ["國內出差的住宿費上限是多少？", "請款單需要哪些附件？", "今年預算調整的申請流程"] },
  { id: "hr", name: "人力資源部", short: "人", description: "差勤、福利、招募與內部規章", documents: 28, entries: "8.6K", updated: "今天 09:24", color: "rose", topics: ["差勤規章", "員工福利", "招募流程"], starters: ["家庭照顧假如何申請？", "新人試用期的考核流程", "年度健檢補助規定"] },
  { id: "purchase", name: "採購部", short: "採", description: "供應商、採購條款與詢比議價", documents: 42, entries: "15.1K", updated: "昨天 16:40", color: "amber", topics: ["詢比議價", "供應商評核", "採購條款"], starters: ["哪些採購案需要三家比價？", "供應商年度評核標準", "緊急採購的核准層級"] },
  { id: "quality", name: "品保部", short: "品", description: "品質標準、檢驗規範與異常處理", documents: 64, entries: "21.4K", updated: "38 分鐘前", color: "teal", topics: ["檢驗標準", "8D 報告", "客訴處理"], starters: ["來料尺寸超差的處理流程", "8D 報告完成期限", "最新版抽樣檢驗規範"] },
  { id: "rd", name: "研發部", short: "研", description: "產品規格、設計標準與技術文件", documents: 87, entries: "31.2K", updated: "今天 10:05", color: "violet", topics: ["設計規範", "BOM 版本", "技術標準"], starters: ["ECN 變更需要哪些審核？", "查詢 A 系列的材料規格", "設計驗證需要保留哪些紀錄"] },
  { id: "manufacturing", name: "製造部", short: "製", description: "SOP、設備操作與生產異常", documents: 73, entries: "26.7K", updated: "1 小時前", color: "blue", topics: ["作業 SOP", "設備點檢", "異常通報"], starters: ["產線換線前要做哪些確認？", "設備每日點檢項目", "缺料停線的通報流程"] },
  { id: "sales", name: "業務部", short: "業", description: "產品資訊、報價原則與客戶服務", documents: 31, entries: "10.3K", updated: "昨天 14:18", color: "cyan", topics: ["產品資訊", "報價原則", "客戶服務"], starters: ["標準報價的有效期限", "客戶樣品申請流程", "產品 A 的交期說明"] },
  { id: "it", name: "資訊部", short: "資", description: "系統操作、帳號權限與資安政策", documents: 39, entries: "11.9K", updated: "今天 08:42", color: "slate", topics: ["系統手冊", "權限申請", "資安政策"], starters: ["VPN 無法連線如何排除？", "新增 ERP 權限的申請流程", "外部檔案交換的資安規範"] },
];

const permissionMeta: Record<Permission, { label: string; detail: string }> = {
  view: { label: "查看問答", detail: "進入知識庫並使用 Agent" },
  upload: { label: "上傳資料", detail: "新增與更新知識文件" },
  review: { label: "審核發布", detail: "確認內容並發布版本" },
  admin: { label: "管理員", detail: "管理部門成員與全部設定" },
};

const seedAccounts: Account[] = [
  { id: "mila", name: "Mila Chang", email: "mila.chang@company.com", title: "平台管理員", initials: "MC", permissions: Object.fromEntries(departments.map((department) => [department.id, ["view", "upload", "review", "admin"] as Permission[]])) },
  { id: "finance-owner", name: "林怡君", email: "yijun.lin@company.com", title: "財務知識維護者", initials: "林", permissions: { finance: ["view", "upload", "review"], hr: ["view"] } },
  { id: "quality-reviewer", name: "王志豪", email: "zhihao.wang@company.com", title: "品保審核人", initials: "王", permissions: { quality: ["view", "upload", "review", "admin"], manufacturing: ["view"] } },
  { id: "rd-editor", name: "張博凱", email: "bokai.chang@company.com", title: "研發文件維護者", initials: "張", permissions: { rd: ["view", "upload"], quality: ["view"], manufacturing: ["view"] } },
  { id: "sales-viewer", name: "李佳玲", email: "jialing.li@company.com", title: "業務專員", initials: "李", permissions: { sales: ["view"], purchase: ["view"] } },
];

const departmentAnalytics: Record<string, { questions: number; users: number; adoption: number; citation: number; helpful: number; hours: number }> = {
  finance: { questions: 1286, users: 32, adoption: 84, citation: 96, helpful: 91, hours: 118 },
  hr: { questions: 934, users: 27, adoption: 78, citation: 94, helpful: 89, hours: 86 },
  purchase: { questions: 742, users: 23, adoption: 69, citation: 93, helpful: 87, hours: 71 },
  quality: { questions: 1648, users: 41, adoption: 88, citation: 98, helpful: 93, hours: 146 },
  rd: { questions: 1872, users: 54, adoption: 82, citation: 95, helpful: 90, hours: 172 },
  manufacturing: { questions: 2154, users: 83, adoption: 73, citation: 97, helpful: 88, hours: 204 },
  sales: { questions: 1136, users: 36, adoption: 76, citation: 92, helpful: 86, hours: 105 },
  it: { questions: 986, users: 29, adoption: 81, citation: 94, helpful: 92, hours: 94 },
};

const popularQuestions = [
  { question: "費用報支需要哪些附件？", department: "finance", count: 186, helpful: 94 },
  { question: "最新版抽樣檢驗規範", department: "quality", count: 164, helpful: 96 },
  { question: "產線換線前要做哪些確認？", department: "manufacturing", count: 152, helpful: 91 },
  { question: "ECN 變更需要哪些審核？", department: "rd", count: 141, helpful: 93 },
  { question: "VPN 無法連線如何排除？", department: "it", count: 128, helpful: 89 },
  { question: "家庭照顧假如何申請？", department: "hr", count: 119, helpful: 92 },
  { question: "哪些採購案需要三家比價？", department: "purchase", count: 108, helpful: 90 },
  { question: "標準報價的有效期限", department: "sales", count: 104, helpful: 88 },
];

const seedDocuments: KnowledgeDocument[] = [
  { id: "KB-0241", name: "國內外出差費用標準.xlsx", department: "finance", type: "Excel", version: "v3.2", rows: 184, updated: "2026/08/13 10:28", owner: "林怡君", status: "已發布" },
  { id: "KB-0240", name: "費用報支作業辦法.pdf", department: "finance", type: "PDF", version: "v5.0", rows: 68, updated: "2026/08/13 09:52", owner: "林怡君", status: "已發布" },
  { id: "KB-0239", name: "供應商年度評核表.xlsx", department: "purchase", type: "Excel", version: "v2.4", rows: 326, updated: "2026/08/12 16:40", owner: "陳冠宇", status: "已發布" },
  { id: "KB-0238", name: "抽樣檢驗規範.xlsx", department: "quality", type: "Excel", version: "v4.1", rows: 512, updated: "2026/08/13 09:18", owner: "王志豪", status: "索引中" },
  { id: "KB-0237", name: "員工差勤管理辦法.docx", department: "hr", type: "Word", version: "v6.0", rows: 92, updated: "2026/08/13 09:24", owner: "許雅雯", status: "已發布" },
  { id: "KB-0236", name: "A 系列產品規格.xlsx", department: "rd", type: "Excel", version: "v1.8", rows: 840, updated: "2026/08/13 10:05", owner: "張博凱", status: "待審核" },
];

const promptCards = [
  { title: "規章快速摘要", category: "全公司共用", text: "請將下列規章整理成適用對象、申請條件、操作步驟與注意事項。", used: 126 },
  { title: "表格差異比對", category: "已核准 Skill", text: "比對兩份表格，列出新增、刪除、數值異動與可能影響。", used: 89 },
  { title: "會議決議追蹤", category: "我的 Prompt", text: "依會議紀錄擷取決議、負責人、期限與未決事項。", used: 42 },
];

const answerByDepartment: Record<string, string> = {
  finance: "依《國內外出差費用標準 v3.2》，國內出差住宿費需依職等與地區上限核銷；請款時應附住宿發票、出差申請單與行程證明。若超過標準，需在報支前取得部門主管核准並註明原因。",
  hr: "依《員工差勤管理辦法 v6.0》，申請人應先於人資系統選擇假別、填寫期間與事由；需要佐證的假別須同步上傳文件。送出後依直屬主管及人資單位順序核准。",
  purchase: "依採購管理規範，達公告門檻的採購原則上需完成三家詢比價；若為獨家來源、緊急需求或指定相容性，可檢附例外說明並依金額層級核准。",
  quality: "依《抽樣檢驗規範 v4.1》，發現尺寸超差時應先隔離批次、停止放行並建立異常單；品保完成複驗後，依結果啟動退料、特採或供應商改善流程。",
  rd: "ECN 變更需包含變更原因、影響料號、BOM 與圖面版本、庫存處置及驗證結果，並由研發、品保、製造與相關權責單位完成會簽後發布。",
  manufacturing: "換線前請確認工單、料號、治具、程式版本與首件檢驗要求；清線完成後由線長覆核，首件經品保確認才可正式量產。",
  sales: "標準報價單的有效期限為 30 天；若涉及原物料價格波動、客製規格或特殊交期，應於備註欄載明適用條件並由業務主管覆核。",
  it: "請先確認網路、帳號狀態與 MFA 驗證，再重新啟動 VPN 用戶端。仍無法連線時，請附上錯誤畫面與發生時間建立 IT 服務單，資訊部將比對系統日誌。",
};

const Icon = ({ name }: { name: string }) => <span className="line-icon" aria-hidden="true">{name}</span>;

export default function Home() {
  const [view, setView] = useState<View>("departments");
  const [accounts, setAccounts] = useState(seedAccounts);
  const [currentAccountId, setCurrentAccountId] = useState("mila");
  const [selectedAccessAccountId, setSelectedAccessAccountId] = useState("finance-owner");
  const [activeDepartmentId, setActiveDepartmentId] = useState("finance");
  const [messages, setMessages] = useState<Message[]>([]);
  const [question, setQuestion] = useState("");
  const [documents, setDocuments] = useState(seedDocuments);
  const [query, setQuery] = useState("");
  const [adminDepartment, setAdminDepartment] = useState("all");
  const [analyticsDepartment, setAnalyticsDepartment] = useState("all");
  const [analyticsPeriod, setAnalyticsPeriod] = useState<"7" | "30" | "90">("30");
  const [uploadOpen, setUploadOpen] = useState(false);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [uploadDepartment, setUploadDepartment] = useState("finance");
  const [sheetPreview, setSheetPreview] = useState<string[][]>([]);
  const [uploading, setUploading] = useState(false);
  const [toast, setToast] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);

  const currentAccount = accounts.find((account) => account.id === currentAccountId) ?? accounts[0];
  const selectedAccessAccount = accounts.find((account) => account.id === selectedAccessAccountId) ?? accounts[0];
  const accessibleDepartmentIds = departments.filter((department) => currentAccount.permissions[department.id]?.includes("view")).map((department) => department.id);
  const manageableDepartmentIds = departments.filter((department) => currentAccount.permissions[department.id]?.some((permission) => permission === "upload" || permission === "review" || permission === "admin")).map((department) => department.id);
  const uploadableDepartmentIds = departments.filter((department) => currentAccount.permissions[department.id]?.some((permission) => permission === "upload" || permission === "admin")).map((department) => department.id);
  const canManageAccounts = departments.some((department) => currentAccount.permissions[department.id]?.includes("admin"));
  const analyticsDepartments = departments.filter((department) => accessibleDepartmentIds.includes(department.id) && (analyticsDepartment === "all" || department.id === analyticsDepartment));
  const analyticsMultiplier = analyticsPeriod === "7" ? 0.27 : analyticsPeriod === "90" ? 2.62 : 1;
  const analyticsSummary = analyticsDepartments.reduce((summary, department) => {
    const data = departmentAnalytics[department.id];
    return { questions: summary.questions + data.questions, users: summary.users + data.users, citation: summary.citation + data.citation, helpful: summary.helpful + data.helpful, hours: summary.hours + data.hours };
  }, { questions: 0, users: 0, citation: 0, helpful: 0, hours: 0 });
  const analyticsDivisor = Math.max(analyticsDepartments.length, 1);
  const trendValues = analyticsPeriod === "7" ? [48, 63, 58, 72, 68, 82, 91] : analyticsPeriod === "90" ? [42, 49, 46, 56, 61, 59, 67, 72, 70, 79, 84, 91] : [44, 50, 55, 52, 64, 69, 63, 76, 73, 82, 88, 94];
  const activeDepartment = departments.find((item) => item.id === activeDepartmentId) ?? departments[0];
  const filteredDepartments = departments.filter((department) =>
    accessibleDepartmentIds.includes(department.id) && `${department.name}${department.description}${department.topics.join("")}`.toLowerCase().includes(query.toLowerCase()),
  );
  const filteredDocuments = useMemo(() => documents.filter((document) => {
    const matchesDepartment = manageableDepartmentIds.includes(document.department) && (adminDepartment === "all" || document.department === adminDepartment);
    return matchesDepartment && document.name.toLowerCase().includes(query.toLowerCase());
  }), [documents, adminDepartment, query, manageableDepartmentIds]);

  function flash(message: string) {
    setToast(message);
    window.setTimeout(() => setToast(""), 2600);
  }

  function openDepartment(id: string) {
    if (!accessibleDepartmentIds.includes(id)) {
      flash("此帳號沒有該部門知識庫的查看權限");
      return;
    }
    setActiveDepartmentId(id);
    setMessages([]);
    setQuestion("");
    setView("chat");
  }

  function ask(text = question) {
    const cleaned = text.trim();
    if (!cleaned) return;
    const base = Date.now();
    const userMessage: Message = { id: base, role: "user", content: cleaned };
    const response: Message = {
      id: base + 1,
      role: "assistant",
      content: answerByDepartment[activeDepartment.id],
      citations: activeDepartment.id === "finance" ? ["國內外出差費用標準.xlsx · 費用標準", "費用報支作業辦法.pdf · 第 4.2 節"] : [`${activeDepartment.name}知識手冊 · 最新核准版`, `${activeDepartment.topics[0]}作業規範 · 第 3 節`],
    };
    setMessages((current) => [...current, userMessage, response]);
    setQuestion("");
  }

  async function inspectFile(file: File) {
    setSelectedFile(file);
    try {
      const workbook = XLSX.read(await file.arrayBuffer(), { type: "array" });
      const sheet = workbook.Sheets[workbook.SheetNames[0]];
      const rows = XLSX.utils.sheet_to_json<(string | number | boolean)[]>(sheet, { header: 1, defval: "" });
      setSheetPreview(rows.slice(0, 5).map((row) => row.slice(0, 6).map(String)));
    } catch {
      setSheetPreview([]);
      flash("檔案已選取，系統將於上傳後進行內容解析");
    }
  }

  async function uploadFile() {
    if (!selectedFile) return;
    if (!uploadableDepartmentIds.includes(uploadDepartment)) {
      flash("此帳號沒有該部門知識庫的上傳權限");
      return;
    }
    setUploading(true);
    const department = departments.find((item) => item.id === uploadDepartment)!;
    const nextId = `KB-${String(242 + documents.length - seedDocuments.length).padStart(4, "0")}`;
    const nextDocument: KnowledgeDocument = {
      id: nextId,
      name: selectedFile.name,
      department: uploadDepartment,
      type: selectedFile.name.toLowerCase().endsWith(".xlsx") || selectedFile.name.toLowerCase().endsWith(".xls") ? "Excel" : selectedFile.name.split(".").pop()?.toUpperCase() || "檔案",
      version: "v1.0",
      rows: Math.max(sheetPreview.length - 1, 0),
      updated: new Intl.DateTimeFormat("zh-TW", { dateStyle: "short", timeStyle: "short" }).format(new Date()),
      owner: currentAccount.name,
      status: "索引中",
    };

    try {
      const form = new FormData();
      form.append("file", selectedFile);
      form.append("department", uploadDepartment);
      form.append("rowCount", String(nextDocument.rows));
      await fetch("/api/knowledge/documents", { method: "POST", body: form, headers: { "x-demo-user-id": currentAccount.id } });
    } catch {
      // The optimistic record keeps the prototype usable when local storage bindings are offline.
    }

    setDocuments((current) => [nextDocument, ...current]);
    setUploading(false);
    setUploadOpen(false);
    setSelectedFile(null);
    setSheetPreview([]);
    flash(`${department.name}的「${nextDocument.name}」已上傳，正在建立索引`);
  }

  function switchAccount(accountId: string) {
    const account = accounts.find((item) => item.id === accountId) ?? accounts[0];
    const firstDepartment = departments.find((department) => account.permissions[department.id]?.includes("view"));
    setCurrentAccountId(account.id);
    setView("departments");
    setMessages([]);
    setQuery("");
    setAdminDepartment("all");
    setAnalyticsDepartment("all");
    if (firstDepartment) {
      setActiveDepartmentId(firstDepartment.id);
      const firstUploadDepartment = departments.find((department) => account.permissions[department.id]?.some((permission) => permission === "upload" || permission === "admin"));
      if (firstUploadDepartment) setUploadDepartment(firstUploadDepartment.id);
    }
    flash(`已切換為 ${account.name}，顯示其帳號權限`);
  }

  function setDepartmentRole(accountId: string, departmentId: string, role: "none" | Permission) {
    const hierarchy: Record<Exclude<typeof role, "none">, Permission[]> = {
      view: ["view"],
      upload: ["view", "upload"],
      review: ["view", "upload", "review"],
      admin: ["view", "upload", "review", "admin"],
    };
    setAccounts((current) => current.map((account) => account.id !== accountId ? account : {
      ...account,
      permissions: { ...account.permissions, [departmentId]: role === "none" ? [] : hierarchy[role] },
    }));
    const department = departments.find((item) => item.id === departmentId)!;
    flash(`${selectedAccessAccount.name}的${department.name}權限已更新`);
  }

  function approveDocument(documentId: string) {
    const document = documents.find((item) => item.id === documentId);
    if (!document || !currentAccount.permissions[document.department]?.some((permission) => permission === "review" || permission === "admin")) {
      flash("此帳號沒有審核發布權限");
      return;
    }
    setDocuments((current) => current.map((item) => item.id === documentId ? { ...item, status: "已發布" } : item));
    flash(`「${document.name}」已由 ${currentAccount.name} 確認並發布`);
  }

  function exportDocuments() {
    const rows = filteredDocuments.map((document) => ({
      文件編號: document.id,
      文件名稱: document.name,
      所屬部門: departments.find((item) => item.id === document.department)?.name,
      類型: document.type,
      版本: document.version,
      資料筆數: document.rows,
      更新時間: document.updated,
      維護人: document.owner,
      狀態: document.status,
    }));
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(rows), "知識庫清冊");
    XLSX.writeFile(workbook, `知識庫清冊_${new Date().toISOString().slice(0, 10)}.xlsx`);
    flash("知識庫清冊已匯出為 Excel");
  }

  function exportConversation() {
    if (!messages.length) return flash("請先開始一段問答再匯出");
    const workbook = XLSX.utils.book_new();
    const rows = messages.map((message, index) => ({
      序號: index + 1,
      角色: message.role === "user" ? "使用者" : "AI 助理",
      內容: message.content,
      引用來源: message.citations?.join("；") ?? "",
    }));
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(rows), "問答紀錄");
    XLSX.writeFile(workbook, `${activeDepartment.name}_問答紀錄.xlsx`);
    flash("本次問答已匯出為 Excel");
  }

  const pageTitle = view === "departments" ? "部門知識庫" : view === "chat" ? `${activeDepartment.name}知識助理` : view === "prompts" ? "Prompt / Skill 中心" : view === "qa" ? "品保文件核對" : view === "access" ? "帳號與部門權限" : view === "analytics" ? "使用分析" : "知識庫管理";

  return (
    <div className="app-shell">
      <aside className="app-sidebar">
        <button className="brand" onClick={() => setView("departments")} aria-label="回到首頁">
          <span className="brand-mark">知</span>
          <span><strong>智匯</strong><small>KNOWLEDGE OS</small></span>
        </button>

        <nav className="main-nav" aria-label="主要功能">
          <p>工作空間</p>
          <button className={view === "departments" || view === "chat" ? "active" : ""} onClick={() => setView("departments")}><Icon name="⌂" /><span>部門知識庫</span></button>
          <button className={view === "prompts" ? "active" : ""} onClick={() => setView("prompts")}><Icon name="✦" /><span>Prompt / Skill</span><em>12</em></button>
          <button className={view === "qa" ? "active" : ""} onClick={() => setView("qa")}><Icon name="✓" /><span>品保文件核對</span></button>
          <p>維運管理</p>
          {manageableDepartmentIds.length > 0 && <button className={view === "admin" ? "active" : ""} onClick={() => setView("admin")}><Icon name="▦" /><span>知識庫管理</span></button>}
          {canManageAccounts && <button className={view === "access" ? "active" : ""} onClick={() => setView("access")}><Icon name="♙" /><span>帳號與權限</span></button>}
          <button className={view === "analytics" ? "active" : ""} onClick={() => setView("analytics")}><Icon name="↗" /><span>使用分析</span></button>
        </nav>

        <div className="sidebar-status">
          <div><span className="pulse" /><strong>知識服務正常</strong></div>
          <small>8 個知識庫 · 最後同步 2 分鐘前</small>
        </div>
        <div className="profile">
          <span className="avatar">{currentAccount.initials}</span>
          <span><strong>{currentAccount.name}</strong><small>{currentAccount.title}</small></span>
          <b>DEMO</b>
        </div>
      </aside>

      <main className={`workspace ${view === "chat" ? "chat-workspace" : ""}`}>
        <header className="topbar">
          <div className="breadcrumb"><button onClick={() => setView("departments")}>智匯</button><span>/</span><strong>{pageTitle}</strong></div>
          <div className="top-actions">
            <label className="account-switcher"><span>Demo 帳號</span><select value={currentAccount.id} onChange={(event) => switchAccount(event.target.value)} aria-label="切換展示帳號">{accounts.map((account) => <option value={account.id} key={account.id}>{account.name}｜{account.title}</option>)}</select></label>
            <button className="icon-button" aria-label="說明" onClick={() => flash("這是保留供日後參考的舊版知識問答平台")}>?</button>
            <button className="icon-button notification" aria-label="通知" onClick={() => flash("有 3 份文件等待審核")}>♢<i>3</i></button>
          </div>
        </header>

        {view === "departments" && (
          <section className="page-content department-page">
            <div className="hero-row">
              <div>
                <div className="eyebrow"><span /> PHASE 2 · KNOWLEDGE HUB</div>
                <h1>今天想從哪個部門找答案？</h1>
                <p>選擇部門後，系統會自動連結您有權限的專屬知識庫。</p>
              </div>
              <div className="summary-pill"><span><b>400</b> 份文件</span><i /><span><b>138K</b> 筆知識</span><i /><span className="healthy"><b>99.8%</b> 可用率</span></div>
            </div>

            <label className="global-search">
              <Icon name="⌕" />
              <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜尋部門、知識主題或文件內容…" />
              <kbd>⌘ K</kbd>
            </label>

            <div className="section-heading"><div><h2>部門專屬知識庫</h2><p>{currentAccount.name} 可進入 {accessibleDepartmentIds.length} 個部門知識庫</p></div><span>帳號權限已套用</span></div>
            <div className="department-grid">
              {filteredDepartments.map((department) => (
                <button className="department-card" key={department.id} onClick={() => openDepartment(department.id)}>
                  <div className="card-top">
                    <span className={`dept-avatar ${department.color}`}>{department.short}</span>
                    <span className="open-arrow">↗</span>
                  </div>
                  <h3>{department.name}<span>{currentAccount.permissions[department.id]?.includes("admin") ? "管理員" : currentAccount.permissions[department.id]?.includes("review") ? "可審核" : currentAccount.permissions[department.id]?.includes("upload") ? "可上傳" : "可查看"}</span></h3>
                  <p>{department.description}</p>
                  <div className="topic-list">{department.topics.map((topic) => <span key={topic}>{topic}</span>)}</div>
                  <div className="card-data"><span><b>{department.documents}</b> 份文件</span><span><b>{department.entries}</b> 筆知識</span></div>
                  <div className="card-footer"><span><i className="status-dot" />{department.updated}更新</span><strong>開始提問 <b>→</b></strong></div>
                </button>
              ))}
            </div>
            {!filteredDepartments.length && <div className="empty-search"><strong>找不到符合的知識庫</strong><p>請換一個關鍵字再試一次。</p></div>}
          </section>
        )}

        {view === "chat" && (
          <section className="chat-layout">
            <aside className="conversation-sidebar">
              <button className="new-chat" onClick={() => setMessages([])}><span>＋</span>新增對話</button>
              <div className="conversation-search"><Icon name="⌕" /><input aria-label="搜尋對話" placeholder="搜尋對話" /></div>
              <p>今天</p>
              <button className="conversation-item active"><span>{messages[0]?.content || "新的知識問答"}</span><b>•••</b></button>
              <p>最近 7 天</p>
              <button className="conversation-item"><span>費用報支需要哪些附件？</span></button>
              <button className="conversation-item"><span>年度預算調整流程</span></button>
              <button className="conversation-item"><span>出差住宿費用上限</span></button>
              <div className="scope-card"><span className={`dept-avatar small ${activeDepartment.color}`}>{activeDepartment.short}</span><div><strong>{activeDepartment.name}知識範圍</strong><small>已鎖定 · 無法切換至未授權資料</small></div></div>
            </aside>

            <div className="chat-panel">
              <div className="chat-header">
                <div><span className={`dept-avatar small ${activeDepartment.color}`}>{activeDepartment.short}</span><div><strong>{activeDepartment.name}知識助理</strong><small><i className="status-dot" /> 已連線 · {activeDepartment.documents} 份核准文件</small></div></div>
                <div><button className="secondary-button" onClick={exportConversation}>⇩ 匯出 Excel</button><button className="icon-button" onClick={() => flash("已複製本頁專屬連結")}>↗</button></div>
              </div>

              <div className={`message-stream ${messages.length ? "has-messages" : ""}`}>
                {!messages.length ? (
                  <div className="chat-welcome">
                    <span className={`agent-orb ${activeDepartment.color}`}>{activeDepartment.short}<i>✦</i></span>
                    <h1>您好，我是{activeDepartment.name}知識助理</h1>
                    <p>我只會依據您已獲授權的{activeDepartment.name}文件回答，並在每則答案標示引用來源。</p>
                    <div className="starter-grid">{activeDepartment.starters.map((starter, index) => <button key={starter} onClick={() => ask(starter)}><span>{["⌕", "▤", "↗"][index]}</span><strong>{starter}</strong><b>→</b></button>)}</div>
                  </div>
                ) : messages.map((message) => (
                  <article className={`message ${message.role}`} key={message.id}>
                    <div className="message-avatar">{message.role === "user" ? "MC" : "知"}</div>
                    <div className="message-body"><strong>{message.role === "user" ? "您" : `${activeDepartment.name}知識助理`}</strong><p>{message.content}</p>{message.citations && <div className="inline-citations">{message.citations.map((citation, index) => <button key={citation}><span>{index + 1}</span>{citation}</button>)}</div>}</div>
                  </article>
                ))}
              </div>

              <div className="composer-wrap">
                <div className="composer">
                  <textarea value={question} onChange={(event) => setQuestion(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); ask(); } }} placeholder={`詢問${activeDepartment.name}的規章、流程或資料…`} aria-label="輸入問題" />
                  <div><button aria-label="上傳附件" onClick={() => flash("可上傳附件進行單次問答，不會自動寫入知識庫")}>＋</button><span>僅搜尋 {activeDepartment.name}知識庫</span><button className="send-button" onClick={() => ask()} disabled={!question.trim()}>↑</button></div>
                </div>
                <small>AI 可能產生錯誤，重要資訊請以引用原始文件為準。</small>
              </div>
            </div>

            <aside className="source-panel">
              <div className="source-header"><strong>引用來源</strong><span>{messages.length ? "2" : "0"}</span></div>
              {messages.length ? <>
                <article className="source-card selected"><div><span className="file-badge excel">XLS</span><p><strong>國內外出差費用標準.xlsx</strong><small>v3.2 · 2026/08/13</small></p><b>1</b></div><blockquote>國內住宿費應依職等與地區標準核實報支，超額應事前取得核准…</blockquote><button>開啟原始文件 ↗</button></article>
                <article className="source-card"><div><span className="file-badge pdf">PDF</span><p><strong>費用報支作業辦法.pdf</strong><small>v5.0 · 第 4.2 節</small></p><b>2</b></div><blockquote>報支時應檢附合法憑證、核准單據及必要之行程證明…</blockquote><button>開啟原始文件 ↗</button></article>
              </> : <div className="no-sources"><span>▱</span><strong>尚無引用來源</strong><p>開始提問後，這裡會顯示回答所依據的文件與原文片段。</p></div>}
              <div className="source-policy"><span>✓</span><p><strong>企業資料保護</strong><small>本次問答使用地端模型處理，資料不會送往未授權的雲端服務。</small></p></div>
            </aside>
          </section>
        )}

        {view === "admin" && (
          <section className="page-content admin-page">
            <div className="admin-heading"><div><div className="eyebrow"><span /> KNOWLEDGE OPERATIONS</div><h1>知識庫管理</h1><p>{currentAccount.name} 可維護 {manageableDepartmentIds.length} 個部門知識庫。</p></div><div><button className="secondary-button" onClick={exportDocuments}>⇩ 匯出 Excel</button>{uploadableDepartmentIds.length > 0 && <button className="primary-button" onClick={() => { setUploadDepartment(uploadableDepartmentIds[0]); setUploadOpen(true); }}>＋ 上傳知識文件</button>}</div></div>
            <div className="admin-stats">
              <article><span className="stat-icon indigo">▤</span><div><small>知識文件</small><strong>{documents.length + 394}</strong><p><b>+18</b> 本月新增</p></div></article>
              <article><span className="stat-icon teal">✓</span><div><small>已發布</small><strong>389</strong><p>97.2% 可供問答</p></div></article>
              <article><span className="stat-icon amber">↻</span><div><small>處理中</small><strong>8</strong><p>索引 5 · 審核 3</p></div></article>
              <article><span className="stat-icon rose">!</span><div><small>需要處理</small><strong>3</strong><p>版本或欄位待確認</p></div></article>
            </div>

            <div className="admin-panel">
              <div className="panel-toolbar">
                <div className="tabs"><button className="active">全部文件 <span>{documents.length + 394}</span></button><button>待處理 <span>8</span></button><button>版本紀錄</button></div>
                <div><label className="table-search"><Icon name="⌕" /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜尋文件" /></label><select value={adminDepartment} onChange={(event) => setAdminDepartment(event.target.value)} aria-label="依部門篩選"><option value="all">我的全部部門</option>{departments.filter((department) => manageableDepartmentIds.includes(department.id)).map((department) => <option value={department.id} key={department.id}>{department.name}</option>)}</select><button className="icon-button">☷</button></div>
              </div>
              <div className="document-table">
                <div className="document-row document-head"><span>文件名稱</span><span>部門知識庫</span><span>版本</span><span>資料量</span><span>更新時間</span><span>維護人</span><span>狀態</span><span>操作</span></div>
                {filteredDocuments.map((document) => {
                  const department = departments.find((item) => item.id === document.department)!;
                  return <div className="document-row" key={document.id}>
                    <div className="document-name"><span className={`file-badge ${document.type.toLowerCase()}`}>{document.type === "Excel" ? "XLS" : document.type === "PDF" ? "PDF" : "DOC"}</span><p><strong>{document.name}</strong><small>{document.id} · {document.type}</small></p></div>
                    <span className="department-label"><i className={department.color}>{department.short}</i>{department.name}</span>
                    <strong>{document.version}</strong><span>{document.rows.toLocaleString()} 筆</span><span>{document.updated}</span><span>{document.owner}</span>
                    <span className={`status-badge ${document.status === "已發布" ? "published" : document.status === "索引中" ? "indexing" : "review"}`}><i />{document.status}</span>
                    {document.status === "待審核" && currentAccount.permissions[document.department]?.some((permission) => permission === "review" || permission === "admin") ? <button className="review-action" onClick={() => approveDocument(document.id)}>確認發布</button> : <button className="more-button" onClick={() => flash(`${document.name}：可查看版本、停用或重新索引`)}>•••</button>}
                  </div>;
                })}
              </div>
              <div className="table-footer"><span>顯示 1–{filteredDocuments.length} 筆，共 {documents.length + 394} 筆</span><div><button disabled>‹</button><button className="active">1</button><button>2</button><button>3</button><span>…</span><button>42</button><button>›</button></div></div>
            </div>
          </section>
        )}

        {view === "access" && (
          <section className="page-content access-page">
            <div className="admin-heading"><div><div className="eyebrow"><span /> ACCOUNT × KNOWLEDGE BASE</div><h1>帳號與部門權限</h1><p>決定每個帳號可以進入、上傳、確認及管理哪些部門知識庫。</p></div><button className="primary-button" onClick={() => flash("已建立新帳號邀請草稿")}>＋ 新增帳號</button></div>
            <div className="access-layout">
              <aside className="account-list">
                <div className="access-panel-title"><strong>公司帳號</strong><span>{accounts.length} 人</span></div>
                {accounts.map((account) => {
                  const accessCount = Object.values(account.permissions).filter((permissions) => permissions.includes("view")).length;
                  return <button className={selectedAccessAccount.id === account.id ? "active" : ""} onClick={() => setSelectedAccessAccountId(account.id)} key={account.id}><span className="account-avatar">{account.initials}</span><span><strong>{account.name}</strong><small>{account.email}</small><em>{account.title} · {accessCount} 個知識庫</em></span><b>›</b></button>;
                })}
              </aside>
              <div className="permission-panel">
                <div className="permission-user"><span className="account-avatar large">{selectedAccessAccount.initials}</span><div><h2>{selectedAccessAccount.name}</h2><p>{selectedAccessAccount.email} · {selectedAccessAccount.title}</p></div><span className="account-state"><i />帳號啟用中</span></div>
                <div className="permission-help"><span>i</span><p><strong>權限逐級包含</strong><small>上傳包含查看；審核包含上傳；管理員可維護成員與全部設定。</small></p></div>
                <div className="permission-matrix">
                  <div className="permission-row permission-head"><span>部門知識庫</span><span>目前權限</span><span>權限包含</span></div>
                  {departments.map((department) => {
                    const permissions = selectedAccessAccount.permissions[department.id] ?? [];
                    const role: "none" | Permission = permissions.includes("admin") ? "admin" : permissions.includes("review") ? "review" : permissions.includes("upload") ? "upload" : permissions.includes("view") ? "view" : "none";
                    return <div className="permission-row" key={department.id}>
                      <div className="permission-department"><span className={`dept-avatar small ${department.color}`}>{department.short}</span><p><strong>{department.name}</strong><small>{department.description}</small></p></div>
                      <select value={role} onChange={(event) => setDepartmentRole(selectedAccessAccount.id, department.id, event.target.value as "none" | Permission)} aria-label={`${department.name}權限`}><option value="none">無權限</option><option value="view">查看問答</option><option value="upload">上傳資料</option><option value="review">審核發布</option><option value="admin">知識庫管理員</option></select>
                      <div className="permission-chips">{role === "none" ? <span className="none">不可進入</span> : permissions.map((permission) => <span className={permission} key={permission}>{permissionMeta[permission].label}</span>)}</div>
                    </div>;
                  })}
                </div>
                <div className="permission-footer"><span>所有異動都會保留帳號、時間與修改前後內容的稽核紀錄。</span><button className="primary-button" onClick={() => flash(`${selectedAccessAccount.name}的權限設定已儲存`)}>儲存權限設定</button></div>
              </div>
            </div>
          </section>
        )}

        {view === "analytics" && (
          <section className="page-content analytics-page">
            <div className="analytics-heading">
              <div><div className="eyebrow"><span /> KNOWLEDGE IMPACT</div><h1>使用分析</h1><p>掌握部門採用、問答品質、文件效益與節省工時。</p></div>
              <div className="analytics-filters"><label>部門<select value={analyticsDepartment} onChange={(event) => setAnalyticsDepartment(event.target.value)}><option value="all">我的全部部門</option>{departments.filter((department) => accessibleDepartmentIds.includes(department.id)).map((department) => <option value={department.id} key={department.id}>{department.name}</option>)}</select></label><label>統計期間<select value={analyticsPeriod} onChange={(event) => setAnalyticsPeriod(event.target.value as "7" | "30" | "90")}><option value="7">最近 7 天</option><option value="30">最近 30 天</option><option value="90">最近 90 天</option></select></label><button className="secondary-button" onClick={() => flash("分析報表已匯出")}>⇩ 匯出報表</button></div>
            </div>

            <div className="analytics-kpis">
              <article><div><span className="analytics-icon indigo">✦</span><small>知識問答次數</small></div><strong>{Math.round(analyticsSummary.questions * analyticsMultiplier).toLocaleString()}</strong><p><b>↑ 18.6%</b> 較前一期間</p></article>
              <article><div><span className="analytics-icon blue">♙</span><small>活躍帳號</small></div><strong>{Math.round(analyticsSummary.users * Math.min(analyticsMultiplier, 1.45)).toLocaleString()}</strong><p><b>↑ 9.2%</b> 使用率持續成長</p></article>
              <article><div><span className="analytics-icon teal">◎</span><small>附引用回答率</small></div><strong>{Math.round(analyticsSummary.citation / analyticsDivisor)}<em>%</em></strong><p>目標 95% · <b>品質穩定</b></p></article>
              <article><div><span className="analytics-icon amber">◷</span><small>預估節省工時</small></div><strong>{Math.round(analyticsSummary.hours * analyticsMultiplier).toLocaleString()}<em> hr</em></strong><p><b>相當於 {Math.round(analyticsSummary.hours * analyticsMultiplier / 8)} 個工作日</b></p></article>
            </div>

            <div className="analytics-main-grid">
              <article className="analytics-card trend-card">
                <div className="analytics-card-head"><div><h2>問答使用趨勢</h2><p>依所選範圍彙整每日知識問答</p></div><span><i /> 問答次數</span></div>
                <div className="bar-chart"><div className="chart-y"><span>1,200</span><span>900</span><span>600</span><span>300</span><span>0</span></div><div className="chart-bars">{trendValues.map((value, index) => <div className="bar-column" key={`${analyticsPeriod}-${index}`}><span className="bar-value">{Math.round(value * analyticsDepartments.length * analyticsMultiplier)}</span><i style={{ height: `${value}%` }} /><small>{analyticsPeriod === "7" ? ["一", "二", "三", "四", "五", "六", "日"][index] : `${index + 1}日`}</small></div>)}</div></div>
              </article>
              <article className="analytics-card quality-card">
                <div className="analytics-card-head"><div><h2>回答品質</h2><p>使用者回饋與來源完整性</p></div></div>
                <div className="quality-score"><div style={{ background: `conic-gradient(#625bd2 ${Math.round(analyticsSummary.helpful / analyticsDivisor) * 3.6}deg,#ececf4 0)` }}><span><strong>{Math.round(analyticsSummary.helpful / analyticsDivisor)}%</strong><small>有幫助</small></span></div></div>
                <div className="quality-metrics"><p><span><i className="teal" />附引用回答</span><strong>{Math.round(analyticsSummary.citation / analyticsDivisor)}%</strong></p><p><span><i className="violet" />首次解決率</span><strong>87%</strong></p><p><span><i className="amber" />需要人工轉介</span><strong>6.4%</strong></p></div>
              </article>
            </div>

            <div className="analytics-bottom-grid">
              <article className="analytics-card adoption-card">
                <div className="analytics-card-head"><div><h2>部門採用狀況</h2><p>僅顯示目前帳號有權查看的知識庫</p></div><button onClick={() => setAnalyticsDepartment("all")}>檢視全部</button></div>
                <div className="adoption-table"><div className="adoption-row adoption-head"><span>部門</span><span>活躍帳號</span><span>問答次數</span><span>採用率</span><span>成效</span></div>{analyticsDepartments.sort((a, b) => departmentAnalytics[b.id].adoption - departmentAnalytics[a.id].adoption).map((department) => { const data = departmentAnalytics[department.id]; return <button className="adoption-row" onClick={() => setAnalyticsDepartment(department.id)} key={department.id}><span className="adoption-dept"><i className={department.color}>{department.short}</i><strong>{department.name}</strong></span><span>{Math.round(data.users * Math.min(analyticsMultiplier, 1.45))} 人</span><span>{Math.round(data.questions * analyticsMultiplier).toLocaleString()}</span><span className="adoption-rate"><i><b style={{ width: `${data.adoption}%` }} /></i><strong>{data.adoption}%</strong></span><em className={data.adoption >= 80 ? "excellent" : data.adoption >= 72 ? "steady" : "watch"}>{data.adoption >= 80 ? "表現優良" : data.adoption >= 72 ? "穩定採用" : "建議推廣"}</em></button>; })}</div>
              </article>
              <article className="analytics-card popular-card">
                <div className="analytics-card-head"><div><h2>熱門知識問題</h2><p>最常被查詢的工作問題</p></div></div>
                <div className="popular-list">{popularQuestions.filter((item) => accessibleDepartmentIds.includes(item.department) && (analyticsDepartment === "all" || item.department === analyticsDepartment)).slice(0, 5).map((item, index) => { const department = departments.find((entry) => entry.id === item.department)!; return <button onClick={() => openDepartment(item.department)} key={item.question}><span>{index + 1}</span><p><strong>{item.question}</strong><small>{department.name} · {Math.round(item.count * analyticsMultiplier)} 次提問</small></p><em>{item.helpful}% 有幫助</em></button>; })}</div>
              </article>
            </div>
            <div className="analytics-note"><span>i</span><p><strong>Demo 數據說明</strong>目前為模擬分析資料；正式串接後將由 LLM Proxy、引用紀錄與使用者回饋即時彙整。</p></div>
          </section>
        )}

        {view === "prompts" && (
          <section className="page-content simple-page">
            <div className="hero-row"><div><div className="eyebrow"><span /> APPROVED WORKFLOWS</div><h1>Prompt / Skill 中心</h1><p>從已核准的工作範本開始任務，或管理自己的常用提示。</p></div><button className="primary-button" onClick={() => flash("已建立新的 Prompt 草稿")}>＋ 新增我的 Prompt</button></div>
            <div className="prompt-grid">{promptCards.map((prompt) => <article key={prompt.title}><span>{prompt.category}</span><h3>{prompt.title}</h3><p>{prompt.text}</p><div><small>已使用 {prompt.used} 次</small><button onClick={() => { setView("chat"); setQuestion(prompt.text); }}>開始使用 →</button></div></article>)}</div>
          </section>
        )}

        {view === "qa" && (
          <section className="page-content simple-page">
            <div className="hero-row"><div><div className="eyebrow"><span /> HUMAN-IN-THE-LOOP QA</div><h1>品保文件核對</h1><p>保留人工覆核、簽名、版本與完整稽核紀錄。</p></div><button className="primary-button" onClick={() => flash("已建立一筆新的文件核對任務")}>＋ 建立核對任務</button></div>
            <div className="qa-board"><div className="qa-document"><div className="mock-document"><span>QA INSPECTION REPORT</span><h3>進料檢驗報告</h3><div className="mock-lines" /><div className="mock-table">{Array.from({ length: 18 }).map((_, index) => <i key={index} />)}</div></div></div><div className="qa-results"><div><span>AI 擷取結果</span><b>信心度 96.4%</b></div>{["供應商料號：SP-2408-A", "檢驗批號：IN-260813-07", "抽樣數量：80 pcs", "判定結果：允收"].map((item, index) => <label key={item}><input type="checkbox" defaultChecked={index < 3} /><span><small>欄位 {index + 1}</small><strong>{item}</strong></span><button>修改</button></label>)}<textarea placeholder="新增覆核備註…" /><button className="primary-button" onClick={() => flash("覆核結果已簽名並保留稽核紀錄")}>完成覆核與簽名</button></div></div>
          </section>
        )}
      </main>

      {uploadOpen && <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setUploadOpen(false); }}>
        <section className="upload-modal" role="dialog" aria-modal="true" aria-labelledby="upload-title">
          <div className="modal-header"><div><span className="stat-icon indigo">⇧</span><div><h2 id="upload-title">上傳知識文件</h2><p>支援 Excel、PDF、Word 與 CSV</p></div></div><button onClick={() => setUploadOpen(false)} aria-label="關閉">×</button></div>
          <div className="modal-body">
            <label>發布至部門知識庫<select value={uploadDepartment} onChange={(event) => setUploadDepartment(event.target.value)}>{departments.filter((department) => uploadableDepartmentIds.includes(department.id)).map((department) => <option value={department.id} key={department.id}>{department.name}</option>)}</select></label>
            <input ref={fileRef} type="file" accept=".xlsx,.xls,.csv,.pdf,.doc,.docx" hidden onChange={(event) => { const file = event.target.files?.[0]; if (file) inspectFile(file); }} />
            <button className={`dropzone ${selectedFile ? "has-file" : ""}`} onClick={() => fileRef.current?.click()}>
              {selectedFile ? <><span className="file-badge excel">XLS</span><strong>{selectedFile.name}</strong><small>{(selectedFile.size / 1024).toFixed(1)} KB · 點擊可更換檔案</small></> : <><span>⇧</span><strong>拖放檔案到這裡，或點擊選擇</strong><small>Excel 每個工作表都會建立欄位索引 · 單檔上限 25 MB</small></>}
            </button>
            {sheetPreview.length > 0 && <div className="sheet-preview"><div><strong>Excel 內容預覽</strong><span>前 {sheetPreview.length} 列 · {sheetPreview[0]?.length || 0} 欄</span></div><div className="preview-scroll">{sheetPreview.map((row, rowIndex) => <div className={rowIndex === 0 ? "preview-head" : ""} key={rowIndex}>{row.map((cell, cellIndex) => <span key={cellIndex}>{cell || "—"}</span>)}</div>)}</div></div>}
            <div className="upload-settings"><label><input type="checkbox" defaultChecked /> 自動建立全文與欄位索引</label><label><input type="checkbox" defaultChecked /> 完成後發布至 Agent</label></div>
          </div>
          <div className="modal-footer"><button className="secondary-button" onClick={() => setUploadOpen(false)}>取消</button><button className="primary-button" disabled={!selectedFile || uploading} onClick={uploadFile}>{uploading ? "上傳與解析中…" : "上傳並建立索引"}</button></div>
        </section>
      </div>}

      {toast && <div className="toast"><span>✓</span>{toast}</div>}
    </div>
  );
}
