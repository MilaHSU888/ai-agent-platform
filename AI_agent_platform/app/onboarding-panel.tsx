"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ApiError, onboardingApi, type Issue, type Session, type Submission, type VulnItem } from './onboarding-api';

const STEP_LABELS: [string, string][] = [
  ['validate', '提交驗證'], ['build', '建置 image'], ['scan', '漏洞檢查'], ['ai_review', '程式碼 AI review'],
  ['platform_test', '平台共通檢查'], ['business_test', '工具業務測試'], ['preview', '預覽'],
];
const STEP_STATUS: Record<string, string> = {
  pending: '等待中', running: '執行中', passed: '通過', warning: '有 CRITICAL 漏洞（不阻擋）', failed: '失敗', blocked: '需核准例外', skipped: '略過',
  not_verified: '未驗證', incomplete: '未完成', cancelled: '已取消', interrupted: '已中斷',
};
const SUB_STATUS: Record<string, string> = {
  queued: '排隊中', running: '建置與測試中', failed: '未通過', cancelled: '已取消', interrupted: '已中斷（可重試）',
  awaiting_confirmation: '待使用者確認測試', awaiting_approval: '待發布核准', approved: '已核准（待發布）', released: '已發布', superseded: '已被新版本取代',
};
const tone = (s: string) => (['passed', 'approved', 'released', 'awaiting_approval'].includes(s) ? 'good' : ['failed', 'interrupted', 'incomplete', 'not_verified'].includes(s) ? 'bad' : ['blocked', 'warning', 'skipped', 'awaiting_confirmation'].includes(s) ? 'warn' : '');
const ACTIVE = ['queued', 'running'];

type Props = { departments: { id: string; name: string }[]; notice: (m: string) => void };
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
  if (step === 'ai_review') return String(s.reason ?? '');
  if (step === 'platform_test') return s.gotStatus ? `健康檢查 ${String(s.healthPath)} → ${String(s.gotStatus)}（${String(s.secondsToHealthy)} 秒）` : `健康檢查未回應（${String(s.healthPath)}）`;
  if (step === 'business_test') return s.reason ? String(s.reason) : `無網路容器執行 ${(s.command as string[] | undefined)?.join(' ') ?? ''} → exit ${String(s.exitCode)}${s.timedOut ? '（逾時）' : ''}`;
  if (step === 'preview') return s.url ? `${String(s.url)}${s.modelConfigured === false ? '（尚未設定模型連線，AI 功能不可用）' : ''}` : String(s.reason ?? '');
  if (step === 'validate') return `來源雜湊 ${String(s.sourceHash ?? '').slice(0, 12)}… · 第 ${String(s.revision ?? '')} 版提交`;
  return s.error ? String(s.error) : '';
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

export function OnboardingPanel({ departments, notice }: Props) {
  const [conn, setConn] = useState<Conn>('checking');
  const [session, setSession] = useState<Session>({ authenticated: false });
  const [items, setItems] = useState<Submission[]>([]);
  const [selectedId, setSelectedId] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [submissionForm, setSubmissionForm] = useState<{ tool: Submission | null } | null>(null);
  const formRef = useRef<HTMLElement | null>(null);
  // 開啟新增／新版本表單時捲到表單並聚焦檔案欄位（表單在頁面上方，按鈕常在下方的提交詳情）
  useEffect(() => {
    if (!submissionForm || !formRef.current) return;
    formRef.current.scrollIntoView({ behavior: 'smooth', block: 'start' });
    formRef.current.querySelector<HTMLInputElement>('input[type="file"]')?.focus({ preventScroll: true });
  }, [submissionForm]);
  const [department, setDepartment] = useState(departments.find((d) => d.id === 'purchase')?.id ?? departments[0]?.id ?? '');
  const [owner, setOwner] = useState('');
  const [busy, setBusy] = useState(false);
  const [issues, setIssues] = useState<Issue[]>([]);
  const [warnings, setWarnings] = useState<Issue[]>([]);
  const [reasons, setReasons] = useState<string[]>([]);
  const [log, setLog] = useState<{ step: string; text: string } | null>(null);
  const [vulns, setVulns] = useState<{ tool: string; scannedAt: string; items: VulnItem[] } | null>(null);
  const [vulnFilter, setVulnFilter] = useState<'all' | 'CRITICAL' | 'fixable'>('all');
  const [note, setNote] = useState('');
  const [health, setHealth] = useState<{ docker: boolean; trivy: boolean } | null>(null);

  const selected = useMemo(() => items.find((s) => s.id === selectedId) ?? items[0], [items, selectedId]);

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

  const openSubmission = (tool: Submission | null) => {
    setSubmissionForm({ tool }); setFile(null); setIssues([]); setWarnings([]); setReasons([]);
    setOwner(tool?.owner ?? '');
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

  return <div className="onb">
    <section className="mg-panel"><div className="mg-row"><div><h2>工具提交</h2><p className="mg-muted">第一次上架請新增工具；更新既有工具，請從下方提交詳情選擇「提交新版本」。</p></div><button disabled={busy} onClick={() => openSubmission(null)}>＋ 新增工具</button></div></section>
    {submissionForm && <section ref={formRef} className="mg-panel" aria-label={submissionForm.tool ? '提交新版本' : '新增工具'}>
      <div className="mg-row"><div><h2>{submissionForm.tool ? `提交新版本：${submissionForm.tool.toolName}` : '新增工具'}</h2><p className="mg-muted">ZIP 最上層需有 <code>workhub.yaml</code> 與 <code>Dockerfile</code>。上傳後由上架服務自動驗證、建置、檢查、測試並啟動預覽；關閉瀏覽器不影響進度。</p></div>
        <a className="onb-link" href="/api/onboarding/template" download>下載 workhub.yaml 範本 ↓</a></div>
      {health && (!health.docker || !health.trivy) && <p className="onb-error">{!health.docker ? '找不到 Docker，無法建置。' : ''}{!health.trivy ? '找不到漏洞掃描器（trivy），掃描步驟會顯示「未完成」且不能送交。' : ''}</p>}
      {submissionForm.tool && <p className="onb-note">更新工具：<code>{submissionForm.tool.toolId}</code>。ZIP 中的 tool.id 必須相同，並填寫新版本號。<b>送出後，目前這一版的測試確認、漏洞例外與核准都會失效</b>，需重新建置、測試與核准；只想繼續目前這一版，請按「取消」並在下方提交詳情操作。</p>}
      <form key={submissionForm.tool?.id ?? 'new'} className="mg-fields onb-upload" onSubmit={(e) => {
        e.preventDefault(); if (!file) return;
        void act(async () => { const r = await onboardingApi.upload(file, department, owner, submissionForm.tool?.toolId); setWarnings(r.warnings); setSelectedId(r.submission.id); setFile(null); setSubmissionForm(null); setLog(null); setNote(''); }, '已收件，開始建置與測試');
      }}>
        <label>部門（以平台表單為準）<select disabled={!!submissionForm.tool} value={department} onChange={(e) => setDepartment(e.target.value)}>{departments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}</select></label>
        <label>工具負責人（Owner）<input readOnly={!!submissionForm.tool} value={owner} onChange={(e) => setOwner(e.target.value)} placeholder="例如 Mila" /></label>
        <label>原始碼 ZIP<input type="file" accept=".zip,application/zip" onChange={(e) => setFile(e.target.files?.[0] ?? null)} /></label>
        <button disabled={!file || !owner.trim() || busy}>{busy ? '處理中…' : '上傳並開始建置'}</button>
        <button type="button" disabled={busy} onClick={() => { setSubmissionForm(null); setFile(null); setIssues([]); setWarnings([]); }}>取消</button>
      </form>
      <IssueTable title="提交包未通過檢查（已停止建置）" issues={issues} />
      <IssueTable title="提醒" issues={warnings} />
    </section>}

    <div className="onb-grid">
      <section className="mg-panel"><div className="mg-row"><h2>我的提交</h2><button onClick={() => void refresh()} disabled={busy}>重新整理</button></div>
        {items.length === 0 ? <p className="mg-submission-empty">尚無提交紀錄，請從「新增工具」上傳第一個 ZIP。</p> : items.map((s) =>
          <button key={s.id} className={`mg-submission ${selected?.id === s.id ? 'current' : ''}`} onClick={() => { setSelectedId(s.id); setLog(null); setReasons([]); setNote(''); }}>
            <span><b>{s.toolName}</b><small>{s.version} · 第 {s.revision} 版 · {new Date(s.createdAt).toLocaleString('zh-TW')}</small></span>
            <span className={`mg-status ${tone(s.status)}`}>{SUB_STATUS[s.status] ?? s.status}</span>
          </button>)}
      </section>

      {selected && <section className="mg-panel onb-detail">
        <div className="mg-row"><div><h2>提交詳情</h2><h3>{selected.toolName} · {selected.version}</h3>
          <p className="mg-muted">第 {selected.revision} 版提交 · {selected.originalFilename} · 來源雜湊 <code>{selected.sourceHash.slice(0, 12)}</code>{selected.imageDigest && <> · image <code>{selected.imageDigest.slice(0, 19)}</code></>}</p></div>
          <span className={`mg-status ${tone(selected.status)}`}>{SUB_STATUS[selected.status] ?? selected.status}</span></div>
        <p className="onb-note">本機試點：程式碼 AI review 未執行（標示為略過，不是通過）；僅允許本機發布。</p>
        <ol className="onb-steps">{STEP_LABELS.map(([key, label]) => {
          const st = steps[key];
          const status = st?.status ?? 'pending';
          // 漏洞檢查：CRITICAL 全部核准本機例外後顯示「已核准例外」（後端原始狀態仍為 blocked，發布時會再檢查）
          const excepted = key === 'scan' && status === 'blocked' && selected.pendingExceptions.length === 0;
          const shown = excepted ? 'good' : tone(status);
          return <li key={key} className={`onb-step ${shown}`}>
            <div><b>{label}</b><span className={`mg-status ${shown}`}>{excepted ? '已核准例外' : STEP_STATUS[status] ?? status}</span></div>
            <small>{stepDetail(key, st?.summary ?? {})}</small>
            <div className="onb-step-links">
              {key === 'scan' && ['passed', 'warning', 'blocked'].includes(status) &&
                <button className="onb-link" onClick={() => void onboardingApi.vulns(selected.id).then((r) => { setVulnFilter('all'); setVulns({ tool: `${selected.toolName} · ${selected.version}`, ...r }); }).catch(fail)}>查看漏洞清單</button>}
              {selected.job && !['pending', 'skipped'].includes(status) && key !== 'ai_review' &&
                <button className="onb-link" onClick={() => void onboardingApi.log(selected.job!.id, key).then((text) => setLog({ step: label, text }))}>查看日誌</button>}
            </div>
          </li>;
        })}</ol>
        {selected.job?.error && <p className="onb-error">{selected.job.error}</p>}
        <div className="mg-actions">
          <button disabled={busy || items.some((s) => s.toolId === selected.toolId && ACTIVE.includes(s.status))} onClick={() => openSubmission(selected)}>提交新版本</button>
          {selected.job && ACTIVE.includes(selected.status) && <button disabled={busy} onClick={() => void act(() => onboardingApi.cancel(selected.job!.id), '已要求取消')}>取消工作</button>}
          {['failed', 'cancelled', 'interrupted'].includes(selected.status) && <button disabled={busy} onClick={() => void act(() => onboardingApi.retry(selected.id), '已重新排隊')}>重試</button>}
          {selected.previewUrl && <a className="onb-button" href={selected.previewUrl} target="_blank" rel="noreferrer">開啟預覽 ↗</a>}
        </div>

        {selected.status === 'awaiting_confirmation' && <div className="onb-gate"><h3>使用者測試確認</h3>
          <p>請在預覽中實際操作、核對業務結果後再確認。確認只對這個版本（目前的 image）有效。</p>
          <textarea aria-label="核對說明" value={note} onChange={(e) => setNote(e.target.value)} placeholder="例如：以 Q01～Q07 核對料號、數量、單價與幣別，匯出 Excel 可開啟" />
          <button disabled={busy || !note.trim()} onClick={() => void act(async () => { await onboardingApi.confirm(selected.id, note); setNote(''); }, '已記錄測試確認')}>確認測試結果</button></div>}


        {selected.status === 'awaiting_approval' && <p className="onb-note">已確認測試結果，等待管理者在「發布管理」審核發布。</p>}

        {reasons.length > 0 && <ul className="onb-error">{reasons.map((r) => <li key={r}>{r}</li>)}</ul>}
        {selected.approvals.length > 0 && <div><h3>確認與核准紀錄</h3>{selected.approvals.map((a, i) =>
          <p key={i} className="mg-event">{new Date(a.created_at).toLocaleString('zh-TW')}｜{a.actor}｜{({ test_confirmation: '測試確認', vuln_exception: '漏洞例外', release_approval: '發布核准' } as Record<string, string>)[a.kind] ?? a.kind}{a.subject ? ` ${a.subject}` : ''}：{a.reason}{a.revoked_at ? '（已失效）' : ''}</p>)}</div>}
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

/** 發布管理：管理者審核開發者確認過測試的提交，核准發布（後端再檢查所有條件）。 */
export function ReleaseReview({ notice }: { notice: (m: string) => void }) {
  const [state, setState] = useState<'checking' | 'offline' | 'ready'>('checking');
  const [items, setItems] = useState<Submission[]>([]);
  const [reason, setReason] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<Record<string, string[]>>({});

  const fetchReview = async (): Promise<{ state: 'offline' | 'ready'; items: Submission[] }> => {
    try {
      const s = await onboardingApi.session();
      if (!s.authenticated) return { state: 'offline', items: [] };
      const all = await onboardingApi.list();
      return { state: 'ready', items: all.filter((x) => ['awaiting_approval', 'approved'].includes(x.status)) };
    } catch { return { state: 'offline', items: [] }; }
  };
  const load = async () => { const r = await fetchReview(); setItems(r.items); setState(r.state); };
  useEffect(() => {
    let alive = true;
    void fetchReview().then((r) => { if (alive) { setItems(r.items); setState(r.state); } });
    return () => { alive = false; };
  }, []);

  const approve = async (sub: Submission) => {
    setBusy(true); setErrors({ ...errors, [sub.id]: [] });
    try { await onboardingApi.approve(sub.id, reason[sub.id] ?? ''); setReason({ ...reason, [sub.id]: '' }); notice(`已核准發布：${sub.toolName} ${sub.version}`); await load(); }
    catch (e) { if (e instanceof ApiError) { setErrors({ ...errors, [sub.id]: e.reasons.length ? e.reasons : [e.message] }); notice(e.message); } else setState('offline'); }
    finally { setBusy(false); }
  };

  if (state === 'checking') return null;
  if (state === 'offline') return <section className="mg-panel"><h2>待審核的發佈申請</h2><p className="mg-muted">上架服務未啟動，或網站不是從 http://localhost:3002 開啟，無法讀取發佈申請。</p></section>;

  return <section className="mg-panel onb-review"><div className="mg-row"><div><h2>待審核的發佈申請</h2><p className="mg-muted">開發者已在預覽中確認測試結果的提交。核准前請確認測試說明、漏洞處理與檢查結果；核准只對該版本的 image 有效。</p></div><button disabled={busy} onClick={() => void load()}>重新整理</button></div>
    {items.length === 0 ? <p className="mg-submission-empty">目前沒有待審核的發佈申請。</p> : items.map((sub) => {
      const confirmNote = sub.approvals.filter((a) => a.kind === 'test_confirmation' && !a.revoked_at).at(-1);
      const exceptions = sub.approvals.filter((a) => a.kind === 'vuln_exception' && !a.revoked_at);
      const scan = (sub.steps.scan?.summary ?? {}) as { counts?: Record<string, number> };
      const ok = (k: string) => sub.steps[k]?.status === 'passed';
      return <article key={sub.id} className="onb-review-item">
        <div className="mg-row"><div><h3>{sub.toolName} · {sub.version}</h3><small className="mg-muted">第 {sub.revision} 版提交 · Owner {sub.owner} · image <code>{(sub.imageDigest ?? '').slice(0, 19)}</code></small></div>
          <span className={`mg-status ${sub.status === 'approved' ? 'good' : 'warn'}`}>{sub.status === 'approved' ? '已核准（待發布）' : '待管理者審核'}</span></div>
        <ul className="onb-review-facts">
          <li>建置 {ok('build') ? '通過' : '未通過'} · 平台共通檢查 {ok('platform_test') ? '通過' : '未通過'} · 業務測試 {ok('business_test') ? '通過' : '未通過'} · 程式碼 AI review 略過（本機試點）</li>
          <li className={(scan.counts?.CRITICAL ?? 0) > 0 ? 'onb-error' : undefined}>漏洞（僅記錄，不阻擋）：CRITICAL {scan.counts?.CRITICAL ?? 0} · HIGH {scan.counts?.HIGH ?? 0}{(scan.counts?.CRITICAL ?? 0) > 0 && '，請先在開發者中心查看漏洞清單再核准'}{exceptions.length > 0 && `；已核准例外 ${exceptions.map((e) => e.subject).join('、')}`}{sub.pendingExceptions.length > 0 && `；尚待核准例外 ${sub.pendingExceptions.join('、')}`}</li>
          {confirmNote && <li>測試確認（{confirmNote.actor}，{new Date(confirmNote.created_at).toLocaleString('zh-TW')}）：{confirmNote.reason}</li>}
        </ul>
        {sub.status === 'awaiting_approval' && <>
          {sub.releaseBlockers.length > 0 && <ul className="onb-error">{sub.releaseBlockers.map((r) => <li key={r}>{r}</li>)}</ul>}
          {(errors[sub.id]?.length ?? 0) > 0 && <ul className="onb-error">{errors[sub.id].map((r) => <li key={r}>{r}</li>)}</ul>}
          <div className="mg-row"><input aria-label={`${sub.toolName} 核准說明`} value={reason[sub.id] ?? ''} onChange={(e) => setReason({ ...reason, [sub.id]: e.target.value })} placeholder="核准說明（會留在稽核紀錄）" />
            <button disabled={busy || !(reason[sub.id] ?? '').trim() || sub.releaseBlockers.length > 0} onClick={() => void approve(sub)}>核准發布</button></div>
        </>}
      </article>;
    })}
  </section>;
}
