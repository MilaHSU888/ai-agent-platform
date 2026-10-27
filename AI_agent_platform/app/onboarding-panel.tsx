"use client";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ApiError, onboardingApi, type CatalogTool, type Issue, type ReleaseRecord, type Session, type Submission, type VulnItem } from './onboarding-api';
import { IconPicker } from './tool-icon';
import { ArchiveControl, isTrialing, TrialCard, trialResultOf, VisibilityControl } from './trial-panel';
import type { Role } from './role';

const STEP_LABELS: [string, string][] = [
  ['validate', '提交驗證'], ['build', '建置 image'], ['scan', '漏洞檢查'], ['code_review', '程式碼檢查'],
  ['platform_test', '平台共通檢查'], ['business_test', '工具業務測試'], ['preview', '預覽'],
];
const STEP_STATUS: Record<string, string> = {
  pending: '等待中', running: '執行中', passed: '通過', warning: '有 CRITICAL 漏洞（不阻擋）', failed: '失敗', blocked: '需核准例外', skipped: '略過',
  not_verified: '未驗證', incomplete: '未完成', not_applicable: '不適用', cancelled: '已取消', interrupted: '已中斷', awaiting: '待人工確認',
};
const SUB_STATUS: Record<string, string> = {
  queued: '排隊中', running: '建置與測試中', failed: '未通過', cancelled: '已取消', interrupted: '已中斷（可重試）',
  awaiting_confirmation: '待使用者確認測試', awaiting_approval: '待發布核准', approved: '已核准（待發布）', trial: '試用中（未公開）', released: '已發布', superseded: '已被新版本取代', withdrawn: '已取消提交',
};
const tone = (s: string) => (['passed', 'approved', 'released', 'awaiting_approval'].includes(s) ? 'good' : ['failed', 'interrupted', 'incomplete', 'not_verified'].includes(s) ? 'bad' : ['blocked', 'warning', 'skipped', 'awaiting', 'awaiting_confirmation'].includes(s) ? 'warn' : '');
const ACTIVE = ['queued', 'running'];

type Props = { departments: { id: string; name: string }[]; notice: (m: string) => void; role?: Role; developer?: string };
type Conn = 'checking' | 'offline' | 'ready';

function IssueTable({ title, issues }: { title: string; issues: Issue[] }) {
  if (!issues.length) return null;
  return <div className="onb-issues"><h3>{title}</h3><div className="mg-table-scroll"><table><thead><tr><th>檔案／欄位</th><th>原因</th><th>補正方法</th></tr></thead><tbody>
    {issues.map((i, n) => <tr key={n}><td><code>{i.file}{i.field ? ` · ${i.field}` : ''}</code></td><td>{i.reason}</td><td>{i.fix}</td></tr>)}
  </tbody></table></div></div>;
}

function stepDetail(step: string, s: Record<string, unknown>): string {
  if (!s || !Object.keys(s).length) return '';
  if (step === 'build') return s.digest ? `image ${String(s.image)} · ${String(s.digest).slice(0, 19)}…` : s.timedOut ? '建置逾時' : `建置失敗（exit ${String(s.exitCode)}）`;
  if (step === 'scan') {
    if (s.reason) return String(s.reason);
    const c = (s.counts ?? {}) as Record<string, number>;
    return `CRITICAL ${c.CRITICAL ?? 0} · HIGH ${c.HIGH ?? 0}（${String(s.uniqueCves ?? 0)} 個不重複 CVE）；僅記錄，不阻擋發布`;
  }
  if (step === 'code_review') return s.reviewer ? `${String(s.reviewer)} 已檢查${s.note ? `：${String(s.note)}` : ''}` : '請開發者看過程式碼後，在下方按「已檢查」';
  if (step === 'platform_test') return s.gotStatus ? `健康檢查 ${String(s.healthPath)} → ${String(s.gotStatus)}（${String(s.secondsToHealthy)} 秒）` : `健康檢查未回應（${String(s.healthPath)}）`;
  if (step === 'business_test') return s.reason ? String(s.reason) : `無網路容器執行 ${(s.command as string[] | undefined)?.join(' ') ?? ''} → exit ${String(s.exitCode)}${s.timedOut ? '（逾時）' : ''}`;
  if (step === 'preview') return s.url ? `${String(s.url)}${s.modelConfigured === false ? '（尚未設定模型連線，AI 功能不可用）' : ''}` : String(s.reason ?? '');
  if (step === 'validate') return `來源雜湊 ${String(s.sourceHash ?? '').slice(0, 12)}… · 第 ${String(s.revision ?? '')} 版提交`;
  return s.error ? String(s.error) : '';
}

/** URL 工具只有兩個步驟：表單檢查、連線檢查（其餘不適用，不顯示） */
const URL_STEPS: [string, string][] = [['validate', '表單檢查'], ['platform_test', '連線檢查']];
function urlStepDetail(step: string, s: Record<string, unknown>): string {
  if (!s || !Object.keys(s).length) return '';
  if (step === 'validate') return `網址格式正確 · 第 ${String(s.revision ?? '')} 版設定`;
  if (step === 'platform_test') {
    const redirects = (s.redirects as string[] | undefined) ?? [];
    if (!s.reachable) return `連不上：${String(s.error ?? '無回應')}。不阻擋送審，請 AI Team 判斷（內部網站可能只在公司網路連得到）`;
    return `HTTP ${String(s.status)}（${String(s.ms)} ms）${redirects.length ? ` · 轉址 ${redirects.length} 次 → ${String(s.finalUrl)}` : ''}${s.tls === 'ok' ? ' · HTTPS 憑證正常' : s.tls === 'n/a' ? ' · 未使用 HTTPS' : ''}${s.tls === 'error' ? ' · HTTPS 憑證有問題' : ''}`;
  }
  return '';
}

function csvCell(v: string) { return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v; }
function downloadVulnCsv(tool: string, items: VulnItem[]) {
  const rows = [['嚴重度', '漏洞編號', '類型', '受影響套件', '目前版本', '修正版本', '標題', '說明', '連結'],
    ...items.map((v) => [v.severity, v.id, v.category, v.packages.map((p) => p.name).join(' / '), [...new Set(v.packages.map((p) => p.installed))].join(' / '),
      v.packages.map((p) => p.fixed).filter(Boolean).join(' / ') || '目前無修正版', v.title, v.description, v.url ?? ''])];
  const blob = new Blob(['\ufeff' + rows.map((r) => r.map((c) => csvCell(String(c))).join(',')).join('\n')], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `漏洞清單_${tool.replace(/[^\w.-]+/g, '_')}.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

export function OnboardingPanel({ departments, notice, role = 'aiteam', developer = '' }: Props) {
  const [conn, setConn] = useState<Conn>('checking');
  const [session, setSession] = useState<Session>({ authenticated: false });
  const [items, setItems] = useState<Submission[]>([]);
  const [selectedId, setSelectedId] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [submissionForm, setSubmissionForm] = useState<{ tool: Submission | null; kind: 'zip' | 'url' } | null>(null);
  const emptyUrl = { url: '', usesAi: false, aiConfirmed: false, guide: '' };
  const [urlForm, setUrlForm] = useState(emptyUrl);
  const formRef = useRef<HTMLElement | null>(null);
  // 開啟新增／新版本表單時捲到表單並聚焦檔案欄位（表單在頁面上方，按鈕常在下方的提交詳情）
  useEffect(() => {
    if (!submissionForm || !formRef.current) return;
    formRef.current.scrollIntoView({ behavior: 'smooth', block: 'start' });
    formRef.current.querySelector<HTMLInputElement>('input[type="file"], input[type="url"]')?.focus({ preventScroll: true });
  }, [submissionForm]);
  const [department, setDepartment] = useState(departments.find((d) => d.id === 'purchase')?.id ?? departments[0]?.id ?? '');
  const [owner, setOwner] = useState('');
  const [toolName, setToolName] = useState('');
  const [profile, setProfile] = useState({ description: '', scenario: '' });
  const [busy, setBusy] = useState(false);
  const [issues, setIssues] = useState<Issue[]>([]);
  const [warnings, setWarnings] = useState<Issue[]>([]);
  const [reasons, setReasons] = useState<string[]>([]);
  const [log, setLog] = useState<{ step: string; text: string } | null>(null);
  const [vulns, setVulns] = useState<{ tool: string; scannedAt: string; items: VulnItem[] } | null>(null);
  const [vulnFilter, setVulnFilter] = useState<'all' | 'CRITICAL' | 'fixable'>('all');
  const [note, setNote] = useState('');
  const [reviewNote, setReviewNote] = useState('');
  const [withdrawOpen, setWithdrawOpen] = useState(false);
  const [withdrawReason, setWithdrawReason] = useState('');
  const [health, setHealth] = useState<{ docker: boolean; trivy: boolean } | null>(null);

  // 我的提交：開發者只看到自己當 Owner 的工具的提交；AI Team 看到全部（本機無登入，以示範身分過濾）
  const visible = useMemo(() => (role === 'aiteam' ? items : items.filter((s) => s.owner === developer)), [items, role, developer]);
  const selected = useMemo(() => visible.find((s) => s.id === selectedId) ?? visible[0], [visible, selectedId]);

  const fail = (e: unknown) => {
    if (e instanceof ApiError) {
      if (e.status === 401) setSession({ authenticated: false });
      setIssues(e.issues); setWarnings(e.warnings); setReasons(e.reasons);
      notice(e.message);
    } else {
      setConn('offline');
    }
  };

  const refresh = useCallback(async () => {
    try { setItems(await onboardingApi.list()); } catch (e) { fail(e); }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const h = await onboardingApi.health();
        const s = await onboardingApi.session();
        if (!alive) return;
        setHealth({ docker: h.docker, trivy: h.trivy }); setSession(s); setConn('ready');
        if (s.authenticated) setItems(await onboardingApi.list());
      } catch { if (alive) setConn('offline'); }
    })();
    return () => { alive = false; };
  }, []);

  // 每個工具只列最新一筆提交（items 由新到舊）
  const myTools = visible.filter((x, i) => visible.findIndex((y) => y.toolId === x.toolId) === i);
  const openSubmission = (tool: Submission | null, kind: 'zip' | 'url' = 'zip') => {
    setSubmissionForm({ tool, kind: tool ? (tool.kind === 'url' ? 'url' : 'zip') : kind }); setFile(null); setIssues([]); setWarnings([]); setReasons([]);
    const uc = tool?.urlConfig;
    setUrlForm(uc ? { url: uc.url, usesAi: uc.usesAi, aiConfirmed: uc.aiConfirmed, guide: uc.guide } : emptyUrl);
    setOwner(tool?.owner ?? '');
    setToolName(tool?.toolName ?? '');
    setProfile({ description: '', scenario: '' });
    setDepartment(tool?.department ?? departments.find((d) => d.id === 'purchase')?.id ?? departments[0]?.id ?? '');
  };

  const anyActive = items.some((s) => ACTIVE.includes(s.status));
  useEffect(() => {
    if (!session.authenticated || !anyActive) return;
    const t = setInterval(() => { void refresh(); }, 3000);
    return () => clearInterval(t);
  }, [session.authenticated, anyActive, refresh]);

  const act = async (fn: () => Promise<unknown>, ok?: string) => {
    setBusy(true); setIssues([]); setReasons([]);
    try { await fn(); if (ok) notice(ok); await refresh(); } catch (e) { fail(e); } finally { setBusy(false); }
  };

  if (conn === 'checking') return <section className="mg-panel"><p className="mg-muted">連線上架服務中…</p></section>;
  if (conn === 'offline') return <section className="mg-panel onb-offline"><h2>上架服務尚未啟動</h2>
    <p>真實上架需要在這台電腦啟動本機上架服務（負責接收 ZIP、建置、測試與預覽）。</p>
    <ol><li>確認 Docker Desktop 已開啟（左下角顯示 Engine running）。</li><li>在 Finder 雙擊 <code>pilot/啟動上架服務.command</code>。</li><li>終端機顯示「已啟動」後，重新整理此頁。</li></ol>
    <button onClick={() => location.reload()}>重新整理</button></section>;

  if (!session.authenticated) return <section className="mg-panel onb-offline"><h2>無法以本機操作者身分連線</h2>
    <p>上架服務只接受經由 WorkHub 網站（http://localhost:3002）轉送的請求。請確認：</p>
    <ol><li>網站是用 <code>pilot/啟動WorkHub網站.command</code> 啟動，並從 http://localhost:3002 開啟。</li><li>上架服務是在網站之後或之前啟動都可以；若剛重新啟動上架服務，請重新整理此頁。</li></ol>
    <button onClick={() => location.reload()}>重新整理</button></section>;

  const steps = selected?.steps ?? {};
  // 程式碼檢查：漏洞檢查完成後由開發者自行檢查程式碼並按「已檢查」；完成前不顯示測試確認
  const needsReview = !!selected && ['running', 'awaiting_confirmation'].includes(selected.status) && ['awaiting', 'skipped'].includes(steps.code_review?.status ?? '') && ['passed', 'warning'].includes(steps.scan?.status ?? '');

  return <div className="onb">
    <section className="mg-panel"><div className="mg-row"><div><h2>工具提交</h2><p className="mg-muted">第一次上架請按「新增工具」，再選擇上傳 ZIP 小工具，或登錄已經有網址的網站；已上架的工具要更新，請在下方該工具旁操作。</p></div>
      <div className="onb-head-actions"><button className="onb-primary-sm" disabled={busy} onClick={() => openSubmission(null)}>＋ 新增工具</button></div></div>
      {myTools.length > 0 && <div className="onb-tool-list">{myTools.map((t) => {
        const building = items.some((x) => x.toolId === t.toolId && ACTIVE.includes(x.status));
        return <div className="onb-tool-row" key={t.toolId}>
          <span><b>{t.toolName}</b>{t.kind === 'url' && <span className="onb-kind-tag">URL</span>}<small>{t.kind === 'url' ? <>網址 {t.urlConfig?.url}</> : <>tool.id <code>{t.toolId}</code></>} · 最新提交 {t.version} · {SUB_STATUS[t.status] ?? t.status}{building ? (t.kind === 'url' ? ' · 檢查中' : ' · 建置中，完成後才能提交新版本') : ''}</small></span>
          {t.kind === 'url' ? <span className="onb-head-actions"><button className="onb-primary-sm" disabled={busy || building} onClick={() => openSubmission(t)}>✎ 修改網址設定</button></span>
          : <span className="onb-head-actions"><a className="onb-kit" href={`/api/onboarding/kit?toolId=${encodeURIComponent(t.toolId)}`} download={`workhub-kit-${t.toolId}.zip`} title="給 AI 的指令已帶入 tool.id、目前版本、建議的新版本號與模型端點">下載更新資料包 ↓</a>
          <button className="onb-primary-sm" disabled={busy || building} onClick={() => openSubmission(t)}>↻ 提交新版本</button></span>}
        </div>;
      })}</div>}
    </section>
    {submissionForm && <section ref={formRef} className="mg-panel" aria-label={submissionForm.tool ? (submissionForm.kind === 'url' ? '修改網址設定' : '提交新版本') : '新增工具'}>
      <div className="mg-row"><div><h2>{submissionForm.tool ? (submissionForm.kind === 'url' ? `修改網址設定：${submissionForm.tool.toolName}` : `提交新版本：${submissionForm.tool.toolName}`) : '新增工具'}</h2></div></div>
      {!submissionForm.tool && <div className="onb-kind-switch" role="group" aria-label="上架方式">
        <button type="button" aria-pressed={submissionForm.kind === 'zip'} onClick={() => openSubmission(null, 'zip')}><b>小工具（上傳 ZIP）</b><small>由平台建置、檢查、測試並執行</small></button>
        <button type="button" aria-pressed={submissionForm.kind === 'url'} onClick={() => openSubmission(null, 'url')}><b>已有網址的網站（URL）</b><small>網站已在其他地方運作，例如 OpenWebUI、n8n 表單</small></button>
      </div>}
      {submissionForm.kind === 'url' ? <>
      <p className="mg-muted">登錄已經在其他地方運作的網站，不需 ZIP。送出後平台會檢查網址能否連線，再交給 AI Team 審核；核准後一樣先試用（未公開），試用通過再由 AI Team 公開。工具圖示由 AI Team 設定。</p>
      {submissionForm.tool && <p className="onb-note">工具名稱、用途說明與適用情境請由 AI Team 在發布管理修改。修改網址後需重新經 AI Team 審核。工具已公開時，新網址會先以試用入口並行，一般使用者仍使用目前網址，AI Team 公開後才切換。</p>}
      <form key={`url-${submissionForm.tool?.id ?? 'new'}`} className="mg-fields onb-url-form" onSubmit={(e) => {
        e.preventDefault();
        const t = submissionForm.tool;
        void act(async () => {
          const r = await onboardingApi.submitUrl({ mode: t ? 'update' : 'new', toolId: t?.toolId, name: toolName, department, owner, ...urlForm, description: t ? '' : profile.description, scenario: t ? '' : profile.scenario });
          setWarnings(r.warnings); setSelectedId(r.submission.id); setSubmissionForm(null); setLog(null); setNote('');
        }, '已送出，開始檢查網址');
      }}>
        <label>工具名稱（使用者看到的名稱）<input readOnly={!!submissionForm.tool} value={toolName} maxLength={40} onChange={(e) => setToolName(e.target.value)} placeholder="例如 公司 AI 問答" title={submissionForm.tool ? '要改名請到發布管理的工具發布詳情' : undefined} /></label>
        <label>部門（以平台表單為準）<select disabled={!!submissionForm.tool} value={department} onChange={(e) => setDepartment(e.target.value)}>{departments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}</select></label>
        <label>工具負責人（Owner）<input readOnly={!!submissionForm.tool} value={owner} onChange={(e) => setOwner(e.target.value)} placeholder="例如 Mila" /></label>
        <label className="onb-wide">網址（使用者實際開啟的網頁）<input type="url" value={urlForm.url} onChange={(e) => setUrlForm({ ...urlForm, url: e.target.value })} placeholder="https://chat.example.com/" /></label>
        {!submissionForm.tool && <>
          <label className="onb-wide">用途說明（顯示在工具中心）<input value={profile.description} maxLength={80} onChange={(e) => setProfile({ ...profile, description: e.target.value })} placeholder="一句話說明這個工具做什麼，例如 公司內部 AI 問答與文件摘要" /></label>
          <label className="onb-wide">適用情境（選填）<input value={profile.scenario} maxLength={80} onChange={(e) => setProfile({ ...profile, scenario: e.target.value })} placeholder="例如 查詢內規、整理文件初稿" /></label>
        </>}
        <label className="onb-wide">使用說明（選填，例如需先申請帳號、建議瀏覽器）<textarea value={urlForm.guide} maxLength={300} onChange={(e) => setUrlForm({ ...urlForm, guide: e.target.value })} /></label>
        <label className="onb-check onb-wide"><input type="checkbox" checked={urlForm.usesAi} onChange={(e) => setUrlForm({ ...urlForm, usesAi: e.target.checked, aiConfirmed: e.target.checked && urlForm.aiConfirmed })} />這個網站會使用 AI 模型</label>
        {urlForm.usesAi && <label className="onb-check onb-wide"><input type="checkbox" checked={urlForm.aiConfirmed} onChange={(e) => setUrlForm({ ...urlForm, aiConfirmed: e.target.checked })} />我確認此網站使用的模型與資料流符合公司規定（外部網站不會經過平台的 LLM Proxy）</label>}
        <div className="mg-actions onb-wide">
          <button disabled={busy || !urlForm.url.trim() || (!submissionForm.tool && !profile.description.trim()) || (urlForm.usesAi && !urlForm.aiConfirmed) || !owner.trim() || (!submissionForm.tool && !toolName.trim())}>{busy ? '處理中…' : submissionForm.tool ? '送出修改' : '送出並檢查網址'}</button>
          <button type="button" disabled={busy} onClick={() => { setSubmissionForm(null); setIssues([]); setWarnings([]); }}>取消</button>
        </div>
      </form>
      </> : <>
      <p className="mg-muted">ZIP 最上層需有 <code>workhub.yaml</code> 與 <code>Dockerfile</code>。上傳後由上架服務自動驗證、建置、檢查、測試並啟動預覽；關閉瀏覽器不影響進度。</p>
      {!submissionForm.tool && <div className="onb-note onb-kit-note"><span>還沒有 ZIP？先下載上架資料包（SOP、範本、預檢工具與給 AI 的打包指令），交給 AI agent 打包。</span><a className="onb-kit" href="/api/onboarding/kit" download="workhub-kit.zip">下載上架資料包 ↓</a></div>}
      {health && (!health.docker || !health.trivy) && <p className="onb-error">{!health.docker ? '找不到 Docker，無法建置。' : ''}{!health.trivy ? '找不到漏洞掃描器（trivy），掃描步驟會顯示「未完成」且不能送交。' : ''}</p>}
      {submissionForm.tool && <p className="onb-note">更新工具：<code>{submissionForm.tool.toolId}</code>。ZIP 中的 tool.id 必須相同，並填寫新版本號。<b>送出後，目前這一版的測試確認、漏洞例外與核准都會失效</b>，需重新建置、測試與核准；只想繼續目前這一版，請按「取消」並在下方提交詳情操作。</p>}
      <form key={submissionForm.tool?.id ?? 'new'} className="mg-fields onb-upload" onSubmit={(e) => {
        e.preventDefault(); if (!file) return;
        void act(async () => { const r = await onboardingApi.upload(file, department, owner, submissionForm.tool?.toolId, submissionForm.tool ? undefined : toolName, submissionForm.tool ? undefined : profile); setWarnings(r.warnings); setSelectedId(r.submission.id); setFile(null); setSubmissionForm(null); setLog(null); setNote(''); }, '已收件，開始建置與測試');
      }}>
        <label>工具名稱（使用者看到的名稱）<input readOnly={!!submissionForm.tool} value={toolName} maxLength={40} onChange={(e) => setToolName(e.target.value)} placeholder="例如 出貨進度查詢" title={submissionForm.tool ? '要改名請到發布管理的工具發布詳情' : undefined} /></label>
        <label>部門（以平台表單為準）<select disabled={!!submissionForm.tool} value={department} onChange={(e) => setDepartment(e.target.value)}>{departments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}</select></label>
        <label>工具負責人（Owner）<input readOnly={!!submissionForm.tool} value={owner} onChange={(e) => setOwner(e.target.value)} placeholder="例如 Mila" /></label>
        <label>原始碼 ZIP<input type="file" accept=".zip,application/zip" onChange={(e) => setFile(e.target.files?.[0] ?? null)} /></label>
        {!submissionForm.tool && <>
          <label className="onb-span2">用途說明（顯示在工具中心）<input value={profile.description} maxLength={80} onChange={(e) => setProfile({ ...profile, description: e.target.value })} placeholder="一句話說明這個工具做什麼" /></label>
          <label className="onb-span2">適用情境（選填）<input value={profile.scenario} maxLength={80} onChange={(e) => setProfile({ ...profile, scenario: e.target.value })} placeholder="例如 多家供應商報價整併、價格比較" /></label>
        </>}
        <button disabled={!file || !owner.trim() || (!submissionForm.tool && (!toolName.trim() || !profile.description.trim())) || busy}>{busy ? '處理中…' : '上傳並開始建置'}</button>
        <button type="button" disabled={busy} onClick={() => { setSubmissionForm(null); setFile(null); setIssues([]); setWarnings([]); }}>取消</button>
      </form>
      </>}
      <IssueTable title={submissionForm.kind === 'url' ? '表單未通過檢查' : '提交包未通過檢查（已停止建置）'} issues={issues} />
      <IssueTable title="提醒" issues={warnings} />
    </section>}

    <div className="onb-grid">
      <section className="mg-panel"><div className="mg-row"><div><h2>{role === 'aiteam' ? '全部提交' : '我的提交'}</h2><small className="mg-muted">{role === 'aiteam' ? 'AI Team 看得到所有開發者的提交' : `${developer || '（未選擇開發者）'} 當 Owner 的工具`}</small></div><button onClick={() => void refresh()} disabled={busy}>重新整理</button></div>
        {visible.length === 0 ? <p className="mg-submission-empty">尚無提交紀錄，請從「新增工具」上傳第一個 ZIP 或登錄網址。</p> : visible.map((s) =>
          <button key={s.id} className={`mg-submission ${selected?.id === s.id ? 'current' : ''}`} onClick={() => { setSelectedId(s.id); setLog(null); setReasons([]); setNote(''); }}>
            <span><b>{s.toolName}</b>{s.kind === 'url' && <span className="onb-kind-tag">URL</span>}<small>{s.version} · 第 {s.revision} 版 · {new Date(s.createdAt).toLocaleString('zh-TW')}</small></span>
            <span className={`mg-status ${tone(s.status)}`}>{SUB_STATUS[s.status] ?? s.status}</span>
          </button>)}
      </section>

      {selected && <section className="mg-panel onb-detail">
        <div className="mg-row"><div><h2>提交詳情</h2><h3>{selected.toolName} · {selected.version}</h3>
          {selected.kind === 'url' ? <p className="mg-muted">第 {selected.revision} 版設定 · 網址 <a href={selected.urlConfig?.url} target="_blank" rel="noreferrer">{selected.urlConfig?.url}</a></p> :
          <p className="mg-muted">第 {selected.revision} 版提交 · {selected.originalFilename} · 來源雜湊 <code>{selected.sourceHash.slice(0, 12)}</code>{selected.imageDigest && <> · image <code>{selected.imageDigest.slice(0, 19)}</code></>}</p>}</div>
          <div className="onb-head-actions"><span className={`mg-status ${tone(selected.status)}`}>{SUB_STATUS[selected.status] ?? selected.status}</span></div></div>
        <ol className="onb-steps">{(selected.kind === 'url' ? URL_STEPS : STEP_LABELS).map(([key, label]) => {
          const st = steps[key];
          const isUrl = selected.kind === 'url';
          const status = st?.status ?? 'pending';
          // 漏洞檢查：CRITICAL 全部核准本機例外後顯示「已核准例外」（後端原始狀態仍為 blocked，發布時會再檢查）
          const excepted = key === 'scan' && status === 'blocked' && selected.pendingExceptions.length === 0;
          const shown = excepted ? 'good' : tone(status);
          return <li key={key} className={`onb-step ${shown}`}>
            <div><b>{label}</b><span className={`mg-status ${shown}`}>{excepted ? '已核准例外' : isUrl && status === 'warning' ? '未通過（不阻擋）' : STEP_STATUS[status] ?? status}</span></div>
            <small>{isUrl ? urlStepDetail(key, st?.summary ?? {}) : stepDetail(key, st?.summary ?? {})}</small>
            <div className="onb-step-links">
              {key === 'scan' && ['passed', 'warning', 'blocked'].includes(status) &&
                <button className="onb-link" onClick={() => void onboardingApi.vulns(selected.id).then((r) => { setVulnFilter('all'); setVulns({ tool: `${selected.toolName} · ${selected.version}`, ...r }); }).catch(fail)}>查看漏洞清單</button>}
              {!isUrl && selected.job && !['pending', 'skipped'].includes(status) && key !== 'code_review' &&
                <button className="onb-link" onClick={() => void onboardingApi.log(selected.job!.id, key).then((text) => setLog({ step: label, text }))}>查看日誌</button>}
            </div>
          </li>;
        })}</ol>
        {selected.job?.error && <p className="onb-error">{selected.job.error}</p>}
        <div className="mg-actions">
          {selected.job && ACTIVE.includes(selected.status) && <button disabled={busy} onClick={() => void act(() => onboardingApi.cancel(selected.job!.id), '已要求取消')}>取消工作</button>}
          {['failed', 'cancelled', 'interrupted'].includes(selected.status) && <button disabled={busy} onClick={() => void act(() => onboardingApi.retry(selected.id), '已重新排隊')}>重試</button>}
          {selected.previewUrl && <a className="onb-button" href={selected.previewUrl} target="_blank" rel="noreferrer">開啟預覽 ↗</a>}
          {['queued', 'running', 'failed', 'cancelled', 'interrupted', 'awaiting_confirmation', 'awaiting_approval', 'approved'].includes(selected.status) &&
            <button className="onb-danger" disabled={busy} onClick={() => { setWithdrawReason(''); setWithdrawOpen(true); }}>取消提交</button>}
        </div>

        {withdrawOpen && <div className="onb-withdraw" role="group" aria-label="取消提交">
          <h3>取消這次提交</h3>
          <p>適用於測試失敗或不打算發布這個版本。取消後此版本的測試確認與核准都會失效、預覽會關閉，修正後可重新上傳。</p>
          <input aria-label="取消原因" value={withdrawReason} onChange={(e) => setWithdrawReason(e.target.value)} placeholder="取消原因（例如：預覽中無法匯出比較表）" />
          <div className="mg-actions"><button onClick={() => setWithdrawOpen(false)}>返回</button>
            <button className="onb-danger" disabled={busy || !withdrawReason.trim()} onClick={() => void act(async () => { await onboardingApi.withdraw(selected.id, withdrawReason); setWithdrawOpen(false); }, '已取消提交')}>確認取消提交</button></div>
        </div>}

        {needsReview && <div className="onb-cta">
          <p className="onb-cta-eyebrow">下一步：程式碼檢查</p>
          <h3>請自行檢查程式碼，沒問題就按「已檢查」</h3>
          <ol>
            <li>檢視這次上傳的原始碼（重點：是否有寫死的帳密、對外連線、刪改資料的動作）。</li>
            <li>沒問題就按「<b>已檢查</b>」（備註選填）。若有問題請改按「取消提交」，修正後重新上傳。</li>
          </ol>
          <textarea aria-label="程式碼檢查備註" value={reviewNote} onChange={(e) => setReviewNote(e.target.value)} placeholder="備註（選填），例如：已看過 app/ 與 workhub.yaml，無寫死帳密與對外連線" />
          <div className="onb-cta-actions">
            <button className="onb-primary" disabled={busy} onClick={() => void act(async () => { await onboardingApi.codeReview(selected.id, reviewNote); setReviewNote(''); }, '程式碼已檢查')}>已檢查</button>
          </div>
        </div>}

        {selected.status === 'awaiting_confirmation' && !needsReview && <div className="onb-cta">
          <p className="onb-cta-eyebrow">下一步：請完成測試並確認</p>
          <h3>在預覽中測試這個版本，確認沒問題後提交發佈申請</h3>
          <ol>
            <li>按上方「<b>開啟預覽 ↗</b>」，實際操作主要功能（例如上傳報價檔、檢查解析結果、<b>匯出比較表</b>）。</li>
            <li>在下方寫下你測試了什麼、結果如何。</li>
            <li>按「<b>確認測試結果</b>」，交給管理者審核發布。測試有問題請改按「取消提交」。</li>
          </ol>
          <textarea aria-label="核對說明" value={note} onChange={(e) => setNote(e.target.value)} placeholder="例如：以 Q01～Q07 測試上傳與匯出，料號、數量、單價、幣別與原檔一致，比較表 Excel 可開啟" />
          <div className="onb-cta-actions">
            <button className="onb-primary" disabled={busy || !note.trim()} onClick={() => void act(async () => { await onboardingApi.confirm(selected.id, note); setNote(''); }, '已確認測試結果，等待管理者審核')}>確認測試結果</button>
            {!note.trim() && <small>請先填寫測試說明，按鈕才會啟用</small>}
          </div>
        </div>}


        {selected.kind === 'url' && selected.urlConfig && <ul className="onb-review-facts">
          <li>用途：{selected.profile?.description ?? selected.urlConfig.description}{selected.profile?.scenario && ` · 適用情境：${selected.profile.scenario}`}</li>
          <li>使用 AI：{selected.urlConfig.usesAi ? '是，已確認模型與資料流符合公司規定' : '否'}</li>
          {selected.urlConfig.guide && <li>使用說明：{selected.urlConfig.guide}</li>}
        </ul>}
        {selected.status === 'awaiting_approval' && <p className="onb-note">{selected.kind === 'url' ? '網址檢查完成，等待 AI Team 在「發布管理」審核。' : '已確認測試結果，等待管理者在「發布管理」審核發布。'}</p>}

        {reasons.length > 0 && <ul className="onb-error">{reasons.map((r) => <li key={r}>{r}</li>)}</ul>}
        {selected.approvals.length > 0 && <div><h3>確認與核准紀錄</h3>{selected.approvals.map((a, i) =>
          <p key={i} className="mg-event">{new Date(a.created_at).toLocaleString('zh-TW')}｜{a.actor}｜{({ code_review: '程式碼已檢查', test_confirmation: '測試確認', vuln_exception: '漏洞例外', release_approval: '發布核准' } as Record<string, string>)[a.kind] ?? a.kind}{a.subject ? ` ${a.subject}` : ''}{a.reason ? `：${a.reason}` : ''}{a.revoked_at ? '（已失效）' : ''}</p>)}</div>}
      </section>}
    </div>

    {vulns && <div className="mg-overlay"><section className="mg-dialog onb-vulns" role="dialog" aria-modal="true" aria-labelledby="onb-vulns-title">
      <div className="mg-row"><div><h2 id="onb-vulns-title">漏洞清單</h2><p className="mg-muted">{vulns.tool} · 掃描時間 {new Date(vulns.scannedAt).toLocaleString('zh-TW')} · 共 {vulns.items.length} 個不重複漏洞（同一漏洞出現在多個子套件時合併為一列）</p></div>
        <button onClick={() => setVulns(null)} aria-label="關閉漏洞清單">×</button></div>
      <div className="mg-row"><div className="mg-release-tabs" aria-label="漏洞篩選">
        {([['all', `全部 ${vulns.items.length}`], ['CRITICAL', `CRITICAL ${vulns.items.filter((v) => v.severity === 'CRITICAL').length}`], ['fixable', `有修正版 ${vulns.items.filter((v) => v.fixable).length}`]] as const).map(([k, label]) =>
          <button key={k} aria-pressed={vulnFilter === k} onClick={() => setVulnFilter(k)}>{label}</button>)}</div>
        <button onClick={() => downloadVulnCsv(vulns.tool, vulns.items)}>下載 CSV ↓</button></div>
      <p className="mg-muted">「類型」依漏洞標題自動歸類，僅供快速判讀；是否影響本工具，請依工具實際用途評估（例如是否會處理外部提供的檔案）。</p>
      <div className="mg-table-scroll onb-vuln-table"><table><thead><tr><th>嚴重度</th><th>漏洞編號</th><th>類型</th><th>受影響套件（目前版本）</th><th>修正版本</th><th>說明</th></tr></thead><tbody>
        {vulns.items.filter((v) => vulnFilter === 'all' || (vulnFilter === 'CRITICAL' ? v.severity === 'CRITICAL' : v.fixable)).map((v) => <tr key={v.id}>
          <td><span className={`mg-status ${v.severity === 'CRITICAL' ? 'bad' : 'warn'}`}>{v.severity}</span></td>
          <td>{v.url ? <a href={v.url} target="_blank" rel="noreferrer">{v.id}</a> : v.id}{v.published && <small>公布 {v.published}</small>}</td>
          <td>{v.category}</td>
          <td>{v.packages.map((p) => <div key={p.name}><code>{p.name}</code> {p.installed}</div>)}</td>
          <td>{v.fixable ? v.packages.filter((p) => p.fixed).map((p) => <div key={p.name}>{p.fixed}</div>) : <span className="mg-muted">目前無修正版</span>}</td>
          <td><b>{v.title || v.id}</b>{v.description && <small>{v.description}</small>}</td>
        </tr>)}
      </tbody></table></div>
    </section></div>}

    {log && <div className="mg-overlay"><section className="mg-dialog onb-log" role="dialog" aria-modal="true" aria-label={`${log.step} 日誌`}>
      <div className="mg-row"><h2>{log.step} 日誌</h2><button onClick={() => setLog(null)} aria-label="關閉日誌">×</button></div>
      <pre>{log.text}</pre></section></div>}
  </div>;
}

/** 發布管理：審核發佈申請 → 發布同一份已核准 image → 版本歷程與回復。 */
const REL_STATUS: Record<string, string> = { pending: '排隊中', starting: '發布中', active: '上線中', failed: '發布失敗', superseded: '已由新版本取代', rolled_back: '已回復至前版', offline: '已下架', trial: '試用中（未公開）', trial_ended: '試用結束' };
const relTone = (s: string) => (s === 'active' ? 'good' : s === 'failed' ? 'bad' : ['pending', 'starting', 'trial'].includes(s) ? 'warn' : '');
const relKind = (h: ReleaseRecord) => h.detail.kind === 'trial' ? '新版試用部署' : h.detail.fromTrial ? '公開新版' : h.detail.kind === 'rollback' ? `回復（${h.detail.dataMode === 'restore' ? '還原備份' : '保留資料'}）` : h.detail.kind === 'redeploy' ? '重新上線（保留資料）' : '發布';

type Snapshot = { state: 'offline' | 'ready'; items: Submission[]; history: ReleaseRecord[]; health: Record<string, boolean>; catalog: CatalogTool[] };
const fetchAll = async (): Promise<Snapshot> => {
  try {
    const s = await onboardingApi.session();
    if (!s.authenticated) return { state: 'offline', items: [], history: [], health: {}, catalog: [] };
    const [all, history, cat] = await Promise.all([onboardingApi.list(), onboardingApi.releases(), onboardingApi.catalog()]);
    return { state: 'ready', items: all.filter((x) => ['awaiting_approval', 'approved'].includes(x.status)), history, health: Object.fromEntries(cat.map((c) => [c.releaseId, c.healthy])), catalog: cat };
  } catch { return { state: 'offline', items: [], history: [], health: {}, catalog: [] }; }
};

type Cat = 'pending' | 'trial' | 'public' | 'offline';
const CATS: { id: Cat; label: string; hint: string }[] = [
  { id: 'pending', label: '待審核', hint: '開發者已確認測試，等待核准或發布' },
  { id: 'trial', label: '試用中', hint: '未公開，只有 Owner 與 AI Team 看得到' },
  { id: 'public', label: '已公開', hint: '一般使用者依部門使用中' },
  { id: 'offline', label: '已下架', hint: '服務停止，資料保留' },
];
type Row = { key: string; cat: Cat; toolId: string; kind?: 'zip' | 'url'; name: string; version: string; department: string; who: string; status: string; tone: string; at: string };

/**
 * 發布管理（AI Team）：上方狀態卡片兼分頁（待審核／試用中／已公開／已下架），下方一個工具一列；點選後右側滑出工具詳情，
 * 詳情只突出「現在該做的那一步」，版本紀錄與少用的操作（下架、封存）放在下方。只列出經上架服務處理的真實工具。
 */
export function ReleaseCenter({ notice, departments = [], role, renderSettings }: { notice: (m: string) => void; departments?: { id: string; name: string }[]; role: Role; renderSettings?: (toolId: string, name: string, kind: 'zip' | 'url') => ReactNode }) {
  const [state, setState] = useState<'checking' | 'offline' | 'ready'>('checking');
  const [items, setItems] = useState<Submission[]>([]);
  const [history, setHistory] = useState<ReleaseRecord[]>([]);
  const [health, setHealth] = useState<Record<string, boolean>>({});
  const [cat, setCat] = useState<CatalogTool[]>([]);
  const [tab, setTab] = useState<Cat | ''>('');
  const [dept, setDept] = useState('all');
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState<string>('');
  const [reason, setReason] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<Record<string, string[]>>({});
  const [log, setLog] = useState<{ title: string; text: string } | null>(null);

  const apply = useCallback((r: Snapshot) => { setItems(r.items); setHistory(r.history); setHealth(r.health); setCat(r.catalog); setState(r.state); }, []);
  const load = useCallback(async () => apply(await fetchAll()), [apply]);
  useEffect(() => {
    let alive = true;
    void fetchAll().then((r) => { if (alive) apply(r); });
    const refresh = () => { void fetchAll().then((r) => { if (alive) apply(r); }); };
    window.addEventListener('workhub:catalog-refresh', refresh);
    return () => { alive = false; window.removeEventListener('workhub:catalog-refresh', refresh); };
  }, [apply]);
  const running = history.some((h) => ['pending', 'starting'].includes(h.status));
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => { void fetchAll().then(apply); }, 3000);
    return () => clearInterval(t);
  }, [running, apply]);

  const guard = async (key: string, fn: () => Promise<unknown>, ok: string) => {
    setBusy(true); setErrors({ ...errors, [key]: [] });
    try { await fn(); notice(ok); await load(); window.dispatchEvent(new Event('workhub:catalog-refresh')); }
    catch (e) { if (e instanceof ApiError) { setErrors({ ...errors, [key]: e.reasons.length ? e.reasons : [e.message] }); notice(e.message); } else setState('offline'); }
    finally { setBusy(false); }
  };
  const deptName = (id: string) => departments.find((d) => d.id === id)?.name ?? id;
  const when = (t: string) => new Date(t).toLocaleString('zh-TW', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });

  if (state === 'checking') return null;
  if (state === 'offline') return <section className="mg-panel"><h2>發布管理</h2><p className="mg-muted">上架服務未啟動，或網站不是從 http://localhost:3002 開啟，無法讀取工具與申請。</p></section>;

  // 一個工具可能同時在兩個狀態（例如已公開＋有新版待審核或試用中）
  const rows: Row[] = [];
  for (const sub of items) {
    const rel = history.find((h) => h.id === sub.release?.id);
    const inFlight = rel && ['pending', 'starting'].includes(rel.status);
    rows.push({ key: `p-${sub.id}`, cat: 'pending', toolId: sub.toolId, kind: sub.kind, name: sub.toolName, version: sub.version, department: sub.department, who: `${sub.createdBy}／${sub.owner}`,
      status: inFlight ? '發布中' : rel?.status === 'failed' ? '發布失敗' : sub.status === 'approved' ? '已核准，待發布' : '待核准', tone: rel?.status === 'failed' ? 'bad' : 'warn', at: sub.updatedAt });
  }
  for (const c of cat) {
    const base = { toolId: c.toolId, kind: c.kind, name: c.name, department: c.department, who: c.owner, at: c.releasedAt };
    if (c.offline) { rows.push({ ...base, key: `o-${c.toolId}`, cat: 'offline', version: c.version, status: '已下架', tone: '' }); continue; }
    if (c.visibility === 'public') rows.push({ ...base, key: `u-${c.toolId}`, cat: 'public', version: c.version, status: c.maintenance ? '維護中' : c.healthy ? '服務正常' : '服務未回應', tone: c.maintenance ? 'warn' : c.healthy ? 'good' : 'bad' });
    if (isTrialing(c)) {
      const res = trialResultOf(c)?.result;
      rows.push({ ...base, key: `t-${c.toolId}`, cat: 'trial', version: c.trial ? c.trial.version : c.version, at: c.trial?.since ?? c.releasedAt, status: res === 'passed' ? '試用通過，待公開' : res === 'failed' ? '測試未通過' : '待開發者試用', tone: res === 'passed' ? 'good' : res === 'failed' ? 'bad' : 'warn' });
    }
  }
  const counts = Object.fromEntries(CATS.map((x) => [x.id, rows.filter((r) => r.cat === x.id).length])) as Record<Cat, number>;
  // 最上方公告：需要 AI Team 動手的項目（待核准、已核准待發布、發布失敗、試用通過待公開）
  const todo = rows.filter((r) => (r.cat === 'pending' && r.status !== '發布中') || (r.cat === 'trial' && r.status === '試用通過，待公開'));
  const todoLabel = (r: Row) => r.cat === 'trial' ? '試用通過，請確認後公開' : r.status === '待核准' ? '待審核核准' : r.status === '發布失敗' ? '發布失敗，請查看' : '已核准，請發布';
  const current: Cat = tab || (CATS.find((x) => counts[x.id] > 0)?.id ?? 'pending');
  const q = query.trim().toLowerCase();
  const shown = rows.filter((r) => r.cat === current && (dept === 'all' || r.department === dept) && (!q || r.name.toLowerCase().includes(q) || r.toolId.includes(q)));
  const usedDepts = [...new Set(rows.map((r) => r.department))];

  // ── 工具詳情 ──
  const detail = () => {
    const c = cat.find((x) => x.toolId === open);
    const subs = items.filter((x) => x.toolId === open);
    const list = history.filter((h) => h.toolId === open);
    const name = c?.name ?? subs[0]?.toolName ?? list[0]?.name ?? open;
    const active = list.find((h) => h.status === 'active');
    const kind = c?.kind ?? subs[0]?.kind ?? 'zip';
    return <div className="mg-release-backdrop"><section className="mg-panel mg-release-drawer rc-drawer" role="dialog" aria-modal="true" aria-label={`${name} 工具詳情`}>
      <div className="mg-row"><h2>{name}</h2><button onClick={() => setOpen('')} aria-label="關閉工具詳情">×</button></div>
      <dl className="rc-meta">
        <div><dt>部門</dt><dd>{deptName(c?.department ?? subs[0]?.department ?? '')}</dd></div>
        <div><dt>Owner</dt><dd>{c?.owner ?? subs[0]?.owner ?? '—'}</dd></div>
        <div><dt>上架方式</dt><dd>{kind === 'url' ? 'URL（外部網站，平台只控制入口）' : 'ZIP（平台執行）'}</dd></div>
        <div><dt>公開狀態</dt><dd>{!c ? '尚未發布' : c.offline ? '已下架' : c.visibility === 'public' ? '公開' : '試用中（未公開）'}</dd></div>
        <div><dt>上線版本</dt><dd>{active ? <>{active.version}{active.url && <> · <a href={active.url} target="_blank" rel="noreferrer">開啟 ↗</a></>} <span className={`mg-status ${health[active.id] ? 'good' : 'bad'}`}>{health[active.id] ? '服務正常' : '服務未回應'}</span></> : '—'}</dd></div>
      </dl>

      {subs.length > 0 && <section className="rc-section"><h3 className="rc-title">待審核的申請</h3>{subs.map((sub) => approval(sub))}</section>}
      {c && isTrialing(c) && <section className="rc-section"><h3 className="rc-title">試用中</h3><TrialCard bare tool={c} role={role} notice={notice} onDone={load} /></section>}
      {c && c.visibility === 'public' && !c.offline && <section className="rc-section"><VisibilityControl tool={c} notice={notice} onDone={load} /></section>}

      {list.length > 0 && <section className="rc-section"><h3 className="rc-title">版本紀錄</h3>
        <div className="mg-table-scroll"><table><thead><tr><th>時間</th><th>動作</th><th>版本</th><th>狀態</th><th>說明</th><th></th></tr></thead><tbody>
          {list.map((h) => <tr key={h.id}><td>{when(h.createdAt)}</td><td>{relKind(h)}</td><td>{h.version}</td>
            <td><span className={`mg-status ${relTone(h.status)}`}>{REL_STATUS[h.status] ?? h.status}</span></td><td className="onb-wrap">{h.detail.error ?? (h.detail.offline ? `下架：${h.detail.offline.reason}` : h.detail.ended ? (h.detail.ended.promotedTo ? '已公開' : `結束試用：${h.detail.ended.reason}`) : h.detail.reason) ?? ''}</td>
            <td className="onb-row-actions"><button className="onb-link" onClick={() => void onboardingApi.releaseLog(h.id).then((text) => setLog({ title: `${h.name} ${h.version} 日誌`, text }))}>日誌</button></td></tr>)}
        </tbody></table></div>
        <VersionSwitch list={list} disabled={busy || running} notice={notice} onDone={load} />
      </section>}

      <section className="rc-section"><h3 className="rc-title">設定</h3>
        <ToolNameEditor key={`${open}-${name}`} toolId={open} name={name} notice={notice} />
        {(() => { const desc = c?.description ?? subs[0]?.profile?.description ?? ''; const scen = c?.scenario ?? subs[0]?.profile?.scenario ?? ''; return <ToolProfileEditor key={`${open}-${desc}-${scen}`} toolId={open} description={desc} scenario={scen} notice={notice} onDone={load} />; })()}
        {role === 'aiteam' && <IconPicker key={`icon-${open}-${JSON.stringify(c?.icon ?? subs[0]?.icon ?? null)}`} toolId={open} icon={c?.icon ?? subs[0]?.icon} notice={notice} onDone={load} />}
        {renderSettings?.(open, name, kind)}
      </section>

      {list.length > 0 && <details className="rc-more"><summary>其他操作：下架、封存</summary>
        <OfflineControl list={list} disabled={busy || running} notice={notice} onDone={load} />
        <ArchiveControl toolId={open} name={name} notice={notice} onDone={async () => { setOpen(''); await load(); }} />
      </details>}
    </section></div>;
  };

  const approval = (sub: Submission) => {
    const confirmNote = sub.approvals.filter((a) => a.kind === 'test_confirmation' && !a.revoked_at).at(-1);
    const exceptions = sub.approvals.filter((a) => a.kind === 'vuln_exception' && !a.revoked_at);
    const scan = (sub.steps.scan?.summary ?? {}) as { counts?: Record<string, number> };
    const ok = (k: string) => sub.steps[k]?.status === 'passed';
    const rel = history.find((h) => h.id === sub.release?.id);
    const inFlight = rel && ['pending', 'starting'].includes(rel.status);
    const toTrial = !!cat.find((c) => c.toolId === sub.toolId && c.visibility === 'public' && !c.offline);
    return <article key={sub.id} className="onb-trial-card">
      <div className="mg-row"><div><h3>{sub.version}</h3><p className="onb-submitter">提交：<b>{deptName(sub.department)}</b> · <b>{sub.createdBy}</b> · {new Date(sub.createdAt).toLocaleString('zh-TW')}</p><small className="mg-muted">工具 Owner {sub.owner} · 第 {sub.revision} 版提交{sub.kind === 'url' ? <> · <span className="onb-kind-tag">URL</span></> : <> · image <code>{(sub.imageDigest ?? '').slice(0, 19)}</code></>}</small></div>
        <span className={`mg-status ${inFlight ? 'warn' : sub.status === 'approved' ? 'good' : 'warn'}`}>{inFlight ? '發布中' : sub.status === 'approved' ? '已核准（待發布）' : '待核准'}</span></div>
      {sub.kind === 'url' && sub.urlConfig ? <ul className="onb-review-facts">
        <li>網址：<a href={sub.urlConfig.url} target="_blank" rel="noreferrer">{sub.urlConfig.url}</a></li>
        <li>用途：{sub.profile?.description ?? sub.urlConfig.description}{sub.profile?.scenario && ` · 適用情境：${sub.profile.scenario}`}</li>
        <li>權限：工具中心依部門開放入口（全公司共用＝所有人）。網站若處理敏感資料，請確認網站端也已限制 AD 群組，避免拿到網址的人直接開啟。</li>
        <li>使用 AI：{sub.urlConfig.usesAi ? '是（開發者已確認模型與資料流符合公司規定；外部網站不經過平台的 LLM Proxy）' : '否'}</li>
        <li className={sub.steps.platform_test?.status === 'warning' ? 'onb-error' : undefined}>連線檢查：{sub.steps.platform_test?.status === 'passed' ? '通過' : '未通過（不阻擋）'} · {urlStepDetail('platform_test', sub.steps.platform_test?.summary ?? {})}</li>
        {sub.urlConfig.guide && <li>使用說明：{sub.urlConfig.guide}</li>}
        {rel?.status === 'failed' && <li className="onb-error">上次發布失敗：{rel.detail.error}（入口維持原狀，可修正後再發布）</li>}
      </ul> : <ul className="onb-review-facts">
        <li>用途：{sub.profile?.description || '（未填）'}{sub.profile?.scenario && ` · 適用情境：${sub.profile.scenario}`}</li>
        <li>建置 {ok('build') ? '通過' : '未通過'} · 平台共通檢查 {ok('platform_test') ? '通過' : '未通過'} · 業務測試 {ok('business_test') ? '通過' : '未通過'}</li>
        <li>程式碼檢查：{(() => { const cr = sub.approvals.filter((a) => a.kind === 'code_review' && !a.revoked_at).at(-1); return cr ? `${cr.actor} 已檢查（${new Date(cr.created_at).toLocaleString('zh-TW')}）${cr.reason ? `：${cr.reason}` : ''}` : '尚未檢查'; })()}</li>
        <li className={(scan.counts?.CRITICAL ?? 0) > 0 ? 'onb-error' : undefined}>漏洞（僅記錄，不阻擋）：CRITICAL {scan.counts?.CRITICAL ?? 0} · HIGH {scan.counts?.HIGH ?? 0}{exceptions.length > 0 && `；已核准例外 ${exceptions.map((e) => e.subject).join('、')}`}</li>
        {confirmNote && <li>測試確認（{confirmNote.actor}，{new Date(confirmNote.created_at).toLocaleString('zh-TW')}）：{confirmNote.reason}</li>}
        {rel?.status === 'failed' && <li className="onb-error">上次發布失敗：{rel.detail.error}（入口維持原狀，可修正後再發布）</li>}
      </ul>}
      {rel && rel.detail.steps.length > 0 && <ol className="onb-release-steps">{rel.detail.steps.map((st, i) => <li key={i} className={st.status === 'failed' ? 'onb-error' : undefined}><b>{st.name}</b>：{st.status === 'passed' ? '完成' : st.status === 'failed' ? '失敗' : '略過'}{st.detail && ` · ${st.detail}`}</li>)}</ol>}
      {(errors[sub.id]?.length ?? 0) > 0 && <ul className="onb-error">{errors[sub.id].map((r) => <li key={r}>{r}</li>)}</ul>}
      {sub.status === 'awaiting_approval' && <>
        {sub.releaseBlockers.length > 0 && <ul className="onb-error">{sub.releaseBlockers.map((r) => <li key={r}>{r}</li>)}</ul>}
        <div className="mg-row"><input aria-label={`${sub.toolName} 核准說明`} value={reason[sub.id] ?? ''} onChange={(e) => setReason({ ...reason, [sub.id]: e.target.value })} placeholder="核准說明（會留在稽核紀錄）" />
          <button disabled={busy || !(reason[sub.id] ?? '').trim() || sub.releaseBlockers.length > 0} onClick={() => void guard(sub.id, async () => { await onboardingApi.approve(sub.id, reason[sub.id] ?? ''); setReason({ ...reason, [sub.id]: '' }); }, `已核准發布：${sub.toolName} ${sub.version}`)}>核准發布</button></div>
      </>}
      {sub.status === 'approved' && <div className="mg-actions">
        <button disabled={busy || !!inFlight} onClick={() => void guard(sub.id, () => onboardingApi.release(sub.id), toTrial ? `開始部署 ${sub.toolName} ${sub.version} 試用版（正式版本不受影響）` : `開始發布 ${sub.toolName} ${sub.version}（發布後為試用中，未公開）`)}>{inFlight ? '發布中…' : rel?.status === 'failed' ? '重新發布' : toTrial ? '發布為試用版' : '發布（先試用）'}</button>
        <small className="mg-muted">{toTrial ? '工具已公開：新版會先以試用版並行，一般使用者仍使用目前版本。' : '發布後為試用中（未公開），開發者試用通過、AI Team 公開後才開放。'}</small>
        {rel && <button className="onb-link" onClick={() => void onboardingApi.releaseLog(rel.id).then((text) => setLog({ title: `${sub.toolName} ${sub.version} 發布日誌`, text }))}>查看發布日誌</button>}
      </div>}
    </article>;
  };

  return <>
    {todo.length > 0 && <section className="onb-notice rc-todo" role="status">
      <div><b>有 {todo.length} 件需要 AI Team 處理</b><p>點選項目會直接開啟該工具的詳情。</p></div>
      <div className="onb-notice-links">{todo.map((r) => <button key={r.key} onClick={() => { setTab(r.cat); setOpen(r.toolId); }}>{r.name}{r.kind === 'url' && '（URL）'} {r.version}：{todoLabel(r)} ›</button>)}</div>
    </section>}
    <div className="rc-cards" role="tablist" aria-label="發布狀態">
      {CATS.map((x) => <button key={x.id} role="tab" aria-selected={current === x.id} className={`rc-card ${current === x.id ? 'active' : ''} ${x.id === 'pending' && counts.pending > 0 ? 'attention' : ''}`} onClick={() => setTab(x.id)}>
        <small>{x.label}</small><strong>{counts[x.id]}</strong><span>{x.hint}</span></button>)}
    </div>
    <section className="mg-panel">
      <div className="mg-row"><h2>{CATS.find((x) => x.id === current)!.label}</h2>
        <div className="rc-filters">
          <label>部門<select aria-label="部門篩選" value={dept} onChange={(e) => setDept(e.target.value)}><option value="all">全部部門</option>{usedDepts.map((d) => <option key={d} value={d}>{deptName(d)}</option>)}</select></label>
          <input aria-label="搜尋工具" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="搜尋工具名稱" />
          <button disabled={busy} onClick={() => void load()}>重新整理</button>
        </div></div>
      {shown.length === 0 ? <p className="mg-submission-empty">{rows.length === 0 ? '尚未有經上架服務處理的工具。' : '此狀態下沒有工具。'}</p> :
        <div className="mg-table-scroll"><table className="rc-table"><thead><tr><th>工具</th><th>版本</th><th>部門</th><th>{current === 'pending' ? '提交者／Owner' : 'Owner'}</th><th>狀態</th><th>更新時間</th><th></th></tr></thead><tbody>
          {shown.map((r) => <tr key={r.key} className="rc-row" tabIndex={0} onClick={() => setOpen(r.toolId)} onKeyDown={(e) => { if (e.key === 'Enter') setOpen(r.toolId); }}>
            <td><b>{r.name}</b>{r.kind === 'url' && <span className="onb-kind-tag">URL</span>}</td><td>{r.version}</td><td>{deptName(r.department)}</td><td>{r.who}</td>
            <td><span className={`mg-status ${r.tone}`}>{r.status}</span></td><td>{when(r.at)}</td><td className="rc-go">查看 ›</td></tr>)}
        </tbody></table></div>}
    </section>
    {open && detail()}
    {log && <div className="mg-overlay"><section className="mg-dialog onb-log" role="dialog" aria-modal="true" aria-label={log.title}>
      <div className="mg-row"><h2>{log.title}</h2><button onClick={() => setLog(null)} aria-label="關閉日誌">×</button></div><pre>{log.text}</pre></section></div>}
  </>;
}

/** 版本切換：選任何曾經上線過、目前不在線上的版本。
 *  選到「目前版本的前一版」時走回復流程，可選保留資料或還原到目前版本發布前的備份；其他版本一律保留目前資料（部署前照常備份）。 */
export function VersionSwitch({ list, disabled, notice, onDone }: { list: ReleaseRecord[]; disabled: boolean; notice: (m: string) => void; onDone: () => Promise<unknown> | void }) {
  const [target, setTarget] = useState('');
  const [dataMode, setDataMode] = useState<'' | 'keep' | 'restore'>('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);
  const active = list.find((h) => h.status === 'active');
  const prevSub = active?.previousReleaseId ? list.find((h) => h.id === active.previousReleaseId)?.submissionId : undefined;
  const options = list.filter((h, i) => ['superseded', 'rolled_back', 'offline'].includes(h.status) && h.submissionId !== active?.submissionId
    && list.findIndex((x) => x.submissionId === h.submissionId && ['superseded', 'rolled_back', 'offline'].includes(x.status)) === i);
  if (!list.length) return null;
  if (!options.length) return <div className="onb-gate"><h3>切換版本</h3><p className="mg-muted">目前沒有其他曾經上線過的版本可以切換。</p></div>;
  const sel = options.find((o) => o.id === target);
  const isPrev = !!sel && sel.submissionId === prevSub;
  const mode = isPrev ? dataMode : 'keep';
  const toolId = list[0].toolId;
  const go = async () => {
    if (!sel) return;
    setBusy(true); setErrors([]);
    try {
      if (isPrev) await onboardingApi.rollback(toolId, reason, mode as 'keep' | 'restore');
      else await onboardingApi.redeploy(toolId, sel.id, reason);
      notice(`開始切換 ${list[0].name} 到 ${sel.version}`);
      setTarget(''); setDataMode(''); setReason('');
      await onDone();
    } catch (e) { setErrors(e instanceof ApiError ? (e.reasons.length ? e.reasons : [e.message]) : ['上架服務沒有回應，請確認服務已啟動']); }
    finally { setBusy(false); }
  };
  return <div className="onb-gate"><h3>切換版本</h3>
    <label className="onb-field">要切換到的版本
      <select aria-label="要切換到的版本" value={target} onChange={(e) => { setTarget(e.target.value); setDataMode(''); }}>
        <option value="">請選擇版本</option>
        {options.map((o) => <option key={o.id} value={o.id}>{o.version}（{o.submissionId === prevSub ? '前一版，' : ''}{new Date(o.createdAt).toLocaleString('zh-TW')} 上線）</option>)}
      </select></label>
    {sel && (isPrev ? <div className="onb-radio">
      <label><input type="radio" name={`dm-${toolId}`} checked={dataMode === 'keep'} onChange={() => setDataMode('keep')} />保留目前資料（{sel.version} 與目前資料格式相容時）</label>
      <label><input type="radio" name={`dm-${toolId}`} disabled={!active?.detail.backupBefore} checked={dataMode === 'restore'} onChange={() => setDataMode('restore')} />還原到 {active?.version} 發布前的備份{active?.detail.backupBefore ? '（之後新增的資料會遺失）' : '（沒有備份可用）'}</label>
    </div> : <p className="mg-muted">會保留目前資料；切換前自動備份，健康檢查沒通過會自動回到{active ? ` ${active.version}` : '原狀'}。</p>)}
    <div className="mg-row"><input aria-label="切換原因" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="切換原因（會留在稽核紀錄）" />
      <button disabled={disabled || busy || !sel || !mode || !reason.trim()} onClick={() => void go()}>{sel ? `切換到 ${sel.version}` : '切換'}</button></div>
    {errors.length > 0 && <ul className="onb-error">{errors.map((r) => <li key={r}>{r}</li>)}</ul>}
  </div>;
}

/** 發布管理的工具詳情抽屜：已由上架服務發布的工具，顯示實際上線版本與版本切換（取代示範用的回復按鈕）。 */
export function ToolVersionPanel({ toolId, notice }: { toolId: string; notice: (m: string) => void }) {
  const [list, setList] = useState<ReleaseRecord[] | null>(null);
  const load = useCallback(async () => { try { setList(await onboardingApi.releases(toolId)); } catch { setList([]); } }, [toolId]);
  useEffect(() => {
    let alive = true;
    void onboardingApi.releases(toolId).then((r) => { if (alive) setList(r); }).catch(() => { if (alive) setList([]); });
    return () => { alive = false; };
  }, [toolId]);
  const running = !!list?.some((h) => ['pending', 'starting'].includes(h.status));
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => { void load(); }, 3000);
    return () => clearInterval(t);
  }, [running, load]);
  if (!list) return null;
  if (!list.length) return <p className="mg-muted">上架服務沒有回應，暫時無法讀取版本紀錄。</p>;
  const active = list.find((h) => h.status === 'active');
  const inFlight = list.find((h) => ['pending', 'starting'].includes(h.status));
  const offline = list.find((h) => h.status === 'offline');
  return <div className="onb-tool-versions">
    <p><b>{active ? '上線中：' : offline ? '已下架：' : ''}</b>{active ? active.version : offline ? `${offline.version}（入口已關閉，資料保留）` : '沒有上線中的版本'}{inFlight && <span className="mg-status warn">正在切換到 {inFlight.version}…</span>}</p>
    <OfflineControl list={list} disabled={running} notice={notice} onDone={load} />
    <VersionSwitch list={list} disabled={running} notice={notice} onDone={load} />
  </div>;
}

/** 下架／重新上架：下架只停止容器並關閉入口，資料與網址保留；重新上架部署同一版本、同一網址。 */
export function OfflineControl({ list, disabled, notice, onDone }: { list: ReleaseRecord[]; disabled: boolean; notice: (m: string) => void; onDone: () => Promise<unknown> | void }) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);
  if (!list.length) return null;
  const active = list.find((h) => h.status === 'active');
  const offline = active ? undefined : list.find((h) => h.status === 'offline');
  if (!active && !offline) return null;
  const toolId = list[0].toolId;
  const go = async () => {
    setBusy(true); setErrors([]);
    try {
      if (active) { await onboardingApi.offline(toolId, reason); notice(`已下架 ${list[0].name}，入口已關閉`); }
      else { await onboardingApi.online(toolId, reason); notice(`開始重新上架 ${list[0].name} ${offline!.version}`); }
      setReason('');
      await onDone();
    } catch (e) { setErrors(e instanceof ApiError ? (e.reasons.length ? e.reasons : [e.message]) : ['上架服務沒有回應，請確認服務已啟動']); }
    finally { setBusy(false); }
  };
  return <div className="onb-gate"><h3>{active ? '下架' : `重新上架 ${offline!.version}`}</h3>
    <p className="mg-muted">{active ? '停止工具服務並關閉入口；資料與網址都會保留，之後可重新上架或切換到其他版本。' : '把下架前的版本重新啟動，沿用原本的資料與網址；健康檢查通過才開放入口。'}</p>
    <div className="mg-row"><input aria-label={active ? '下架原因' : '重新上架原因'} value={reason} onChange={(e) => setReason(e.target.value)} placeholder={`${active ? '下架' : '重新上架'}原因（會留在稽核紀錄）`} />
      <button className={active ? 'onb-danger' : undefined} disabled={disabled || busy || !reason.trim()} onClick={() => void go()}>{active ? '下架' : '重新上架'}</button></div>
    {errors.length > 0 && <ul className="onb-error">{errors.map((r) => <li key={r}>{r}</li>)}</ul>}
  </div>;
}

/** 發布管理的工具詳情：工具名稱以平台為準，可直接改名（留稽核紀錄，不需重新上架） */
export function ToolNameEditor({ toolId, name, notice }: { toolId: string; name: string; notice: (m: string) => void }) {
  const [value, setValue] = useState(name);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const changed = value.trim() !== name;
  const save = async () => {
    setBusy(true); setError('');
    try {
      const r = await onboardingApi.rename(toolId, value);
      notice(`工具名稱已改為「${r.name}」`);
      window.dispatchEvent(new Event('workhub:catalog-refresh'));
    } catch (e) { setError(e instanceof ApiError ? (e.reasons[0] ?? e.message) : '上架服務沒有回應'); }
    finally { setBusy(false); }
  };
  return <div className="onb-rename">
    <label>工具名稱<input value={value} maxLength={40} onChange={(e) => setValue(e.target.value)} /></label>
    <button className="onb-primary-sm" disabled={busy || !changed || !value.trim()} onClick={() => void save()}>{busy ? '儲存中…' : '儲存名稱'}</button>
    <small className="mg-muted">tool.id <code>{toolId}</code> 不會改變；改名立即生效，不需重新上架。</small>
    {error && <p className="onb-error">{error}</p>}
  </div>;
}

/** 用途說明與適用情境：AI Team 在發布管理修改，立即生效、留稽核紀錄，不需重新審核；適用情境沒填時工具中心不顯示該行。 */
export function ToolProfileEditor({ toolId, description, scenario, notice, onDone }: { toolId: string; description: string; scenario: string; notice: (m: string) => void; onDone?: () => void }) {
  const [d, setD] = useState(description);
  const [sc, setSc] = useState(scenario);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const changed = d.trim() !== description || sc.trim() !== scenario;
  const save = async () => {
    setBusy(true); setError('');
    try { await onboardingApi.setProfile(toolId, { description: d, scenario: sc }); notice('已更新用途說明與適用情境'); window.dispatchEvent(new Event('workhub:catalog-refresh')); onDone?.(); }
    catch (e) { setError(e instanceof ApiError ? (e.reasons[0] ?? e.message) : '上架服務沒有回應'); }
    finally { setBusy(false); }
  };
  return <div className="onb-rename">
    <label>用途說明<input value={d} maxLength={80} onChange={(e) => setD(e.target.value)} placeholder="一句話說明這個工具做什麼" /></label>
    <label>適用情境（選填）<input value={sc} maxLength={80} onChange={(e) => setSc(e.target.value)} placeholder="沒填時工具中心不顯示「適用情境」" /></label>
    <button className="onb-primary-sm" disabled={busy || !changed || !d.trim()} onClick={() => void save()}>{busy ? '儲存中…' : '儲存說明'}</button>
    {error && <p className="onb-error">{error}</p>}
  </div>;
}
