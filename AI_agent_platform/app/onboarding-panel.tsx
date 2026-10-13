"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ApiError, onboardingApi, type Issue, type ReleaseRecord, type Session, type Submission, type VulnItem } from './onboarding-api';

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
  awaiting_confirmation: '待使用者確認測試', awaiting_approval: '待發布核准', approved: '已核准（待發布）', released: '已發布', superseded: '已被新版本取代', withdrawn: '已取消提交',
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
  const [withdrawOpen, setWithdrawOpen] = useState(false);
  const [withdrawReason, setWithdrawReason] = useState('');
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

  // 每個工具只列最新一筆提交（items 由新到舊）
  const myTools = items.filter((x, i) => items.findIndex((y) => y.toolId === x.toolId) === i);
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
    <section className="mg-panel"><div className="mg-row"><div><h2>工具提交</h2><p className="mg-muted">第一次上架請按「新增工具」；已上架的工具要更新，請在下方該工具旁按「提交新版本」。</p></div><button className="onb-primary-sm" disabled={busy} onClick={() => openSubmission(null)}>＋ 新增工具</button></div>
      {myTools.length > 0 && <div className="onb-tool-list">{myTools.map((t) => {
        const building = items.some((x) => x.toolId === t.toolId && ACTIVE.includes(x.status));
        return <div className="onb-tool-row" key={t.toolId}>
          <span><b>{t.toolName}</b><small>最新提交 {t.version} · {SUB_STATUS[t.status] ?? t.status}{building ? ' · 建置中，完成後才能提交新版本' : ''}</small></span>
          <button className="onb-primary-sm" disabled={busy || building} onClick={() => openSubmission(t)}>↻ 提交新版本</button>
        </div>;
      })}</div>}
    </section>
    {submissionForm && <section ref={formRef} className="mg-panel" aria-label={submissionForm.tool ? '提交新版本' : '新增工具'}>
      <div className="mg-row"><div><h2>{submissionForm.tool ? `提交新版本：${submissionForm.tool.toolName}` : '新增工具'}</h2><p className="mg-muted">ZIP 最上層需有 <code>workhub.yaml</code> 與 <code>Dockerfile</code>。上傳後由上架服務自動驗證、建置、檢查、測試並啟動預覽；關閉瀏覽器不影響進度。</p></div>
        <a className="onb-link" href="/api/onboarding/kit" download="workhub-kit.zip" title="內含上架 SOP、workhub.yaml 範本、預檢工具與給 AI 的打包指令">下載上架資料包 ↓</a></div>
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
          <div className="onb-head-actions"><span className={`mg-status ${tone(selected.status)}`}>{SUB_STATUS[selected.status] ?? selected.status}</span></div></div>
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

        {selected.status === 'awaiting_confirmation' && <div className="onb-cta">
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

/** 發布管理：審核發佈申請 → 發布同一份已核准 image → 版本歷程與回復。 */
const REL_STATUS: Record<string, string> = { pending: '排隊中', starting: '發布中', active: '上線中', failed: '發布失敗', superseded: '已由新版本取代', rolled_back: '已回復至前版', offline: '已下架' };
const relTone = (s: string) => (s === 'active' ? 'good' : s === 'failed' ? 'bad' : ['pending', 'starting'].includes(s) ? 'warn' : '');

type Snapshot = { state: 'offline' | 'ready'; items: Submission[]; history: ReleaseRecord[]; health: Record<string, boolean> };
const fetchAll = async (): Promise<Snapshot> => {
  try {
    const s = await onboardingApi.session();
    if (!s.authenticated) return { state: 'offline', items: [], history: [], health: {} };
    const [all, history, cat] = await Promise.all([onboardingApi.list(), onboardingApi.releases(), onboardingApi.catalog()]);
    return { state: 'ready', items: all.filter((x) => ['awaiting_approval', 'approved'].includes(x.status)), history, health: Object.fromEntries(cat.map((c) => [c.releaseId, c.healthy])) };
  } catch { return { state: 'offline', items: [], history: [], health: {} }; }
};

export function ReleaseReview({ notice }: { notice: (m: string) => void }) {
  const [state, setState] = useState<'checking' | 'offline' | 'ready'>('checking');
  const [items, setItems] = useState<Submission[]>([]);
  const [history, setHistory] = useState<ReleaseRecord[]>([]);
  const [health, setHealth] = useState<Record<string, boolean>>({});
  const [reason, setReason] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<Record<string, string[]>>({});
  const [log, setLog] = useState<{ title: string; text: string } | null>(null);

  const apply = useCallback((r: Snapshot) => { setItems(r.items); setHistory(r.history); setHealth(r.health); setState(r.state); }, []);
  const load = async () => apply(await fetchAll());
  useEffect(() => {
    let alive = true;
    void fetchAll().then((r) => { if (alive) apply(r); });
    return () => { alive = false; };
  }, [apply]);
  const running = history.some((h) => ['pending', 'starting'].includes(h.status));
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => { void fetchAll().then(apply); }, 3000);
    return () => clearInterval(t);
  }, [running, apply]);

  const guard = async (key: string, fn: () => Promise<unknown>, ok: string) => {
    setBusy(true); setErrors({ ...errors, [key]: [] });
    try { await fn(); notice(ok); await load(); }
    catch (e) { if (e instanceof ApiError) { setErrors({ ...errors, [key]: e.reasons.length ? e.reasons : [e.message] }); notice(e.message); } else setState('offline'); }
    finally { setBusy(false); }
  };

  if (state === 'checking') return null;
  if (state === 'offline') return <section className="mg-panel"><h2>待審核的發佈申請</h2><p className="mg-muted">上架服務未啟動，或網站不是從 http://localhost:3002 開啟，無法讀取發佈申請。</p></section>;

  const tools = [...new Set(history.map((h) => h.toolId))];

  return <>
    <section className="mg-panel onb-review"><div className="mg-row"><div><h2>待審核的發佈申請</h2><p className="mg-muted">開發者已在預覽中確認測試結果的提交。核准只對該版本的 image 有效；發布時部署同一份 image，健康檢查通過後才切換工具入口。</p></div><button disabled={busy} onClick={() => void load()}>重新整理</button></div>
      {items.length === 0 ? <p className="mg-submission-empty">目前沒有待審核或待發布的申請。</p> : items.map((sub) => {
        const confirmNote = sub.approvals.filter((a) => a.kind === 'test_confirmation' && !a.revoked_at).at(-1);
        const exceptions = sub.approvals.filter((a) => a.kind === 'vuln_exception' && !a.revoked_at);
        const scan = (sub.steps.scan?.summary ?? {}) as { counts?: Record<string, number> };
        const ok = (k: string) => sub.steps[k]?.status === 'passed';
        const rel = history.find((h) => h.id === sub.release?.id);
        const inFlight = rel && ['pending', 'starting'].includes(rel.status);
        return <article key={sub.id} className="onb-review-item">
          <div className="mg-row"><div><h3>{sub.toolName} · {sub.version}</h3><small className="mg-muted">第 {sub.revision} 版提交 · Owner {sub.owner} · image <code>{(sub.imageDigest ?? '').slice(0, 19)}</code></small></div>
            <span className={`mg-status ${inFlight ? 'warn' : sub.status === 'approved' ? 'good' : 'warn'}`}>{inFlight ? '發布中' : sub.status === 'approved' ? '已核准（待發布）' : '待管理者審核'}</span></div>
          <ul className="onb-review-facts">
            <li>建置 {ok('build') ? '通過' : '未通過'} · 平台共通檢查 {ok('platform_test') ? '通過' : '未通過'} · 業務測試 {ok('business_test') ? '通過' : '未通過'} · 程式碼 AI review 略過（本機試點）</li>
            <li className={(scan.counts?.CRITICAL ?? 0) > 0 ? 'onb-error' : undefined}>漏洞（僅記錄，不阻擋）：CRITICAL {scan.counts?.CRITICAL ?? 0} · HIGH {scan.counts?.HIGH ?? 0}{(scan.counts?.CRITICAL ?? 0) > 0 && '，請先在開發者中心查看漏洞清單再核准'}{exceptions.length > 0 && `；已核准例外 ${exceptions.map((e) => e.subject).join('、')}`}</li>
            {confirmNote && <li>測試確認（{confirmNote.actor}，{new Date(confirmNote.created_at).toLocaleString('zh-TW')}）：{confirmNote.reason}</li>}
            {rel?.status === 'failed' && <li className="onb-error">上次發布失敗：{rel.detail.error}（入口維持原狀，可修正後再發布）</li>}
          </ul>
          {rel && rel.detail.steps.length > 0 && <ol className="onb-release-steps">{rel.detail.steps.map((st, i) => <li key={i} className={st.status === 'failed' ? 'onb-error' : undefined}><b>{st.name}</b>：{st.status === 'passed' ? '完成' : st.status === 'failed' ? '失敗' : '略過'}{st.detail && ` · ${st.detail}`}</li>)}</ol>}
          {(errors[sub.id]?.length ?? 0) > 0 && <ul className="onb-error">{errors[sub.id].map((r) => <li key={r}>{r}</li>)}</ul>}
          {sub.status === 'awaiting_approval' && <>
            {sub.releaseBlockers.length > 0 && <ul className="onb-error">{sub.releaseBlockers.map((r) => <li key={r}>{r}</li>)}</ul>}
            <div className="mg-row"><input aria-label={`${sub.toolName} 核准說明`} value={reason[sub.id] ?? ''} onChange={(e) => setReason({ ...reason, [sub.id]: e.target.value })} placeholder="核准說明（會留在稽核紀錄）" />
              <button disabled={busy || !(reason[sub.id] ?? '').trim() || sub.releaseBlockers.length > 0} onClick={() => void guard(sub.id, async () => { await onboardingApi.approve(sub.id, reason[sub.id] ?? ''); setReason({ ...reason, [sub.id]: '' }); }, `已核准發布：${sub.toolName} ${sub.version}`)}>核准發布</button></div>
          </>}
          {sub.status === 'approved' && <div className="mg-actions">
            <button disabled={busy || !!inFlight} onClick={() => void guard(sub.id, () => onboardingApi.release(sub.id), `開始發布 ${sub.toolName} ${sub.version}`)}>{inFlight ? '發布中…' : rel?.status === 'failed' ? '重新發布' : '發布'}</button>
            {rel && <button className="onb-link" onClick={() => void onboardingApi.releaseLog(rel.id).then((text) => setLog({ title: `${sub.toolName} ${sub.version} 發布日誌`, text }))}>查看發布日誌</button>}
          </div>}
        </article>;
      })}
    </section>

    {tools.length > 0 && <section className="mg-panel onb-review"><h2>上線版本與回復</h2><p className="mg-muted">可切換到任何曾經上線過的版本（部署當初測試、核准過的同一份 image）。每次切換前會先停止目前版本並備份資料。</p>
      {tools.map((toolId) => {
        const list = history.filter((h) => h.toolId === toolId);
        const active = list.find((h) => h.status === 'active');
        return <article key={toolId} className="onb-review-item">
          <div className="mg-row"><div><h3>{list[0].name}</h3><small className="mg-muted">{active ? <>上線中：{active.version} · <a href={active.url ?? '#'} target="_blank" rel="noreferrer">{active.url}</a></> : list.some((h) => h.status === 'offline') ? `已下架：${list.find((h) => h.status === 'offline')!.version}（入口已關閉，資料保留）` : '目前沒有上線中的版本'}</small></div>
            {active && <span className={`mg-status ${health[active.id] ? 'good' : 'bad'}`}>{health[active.id] ? '服務正常' : '服務未回應'}</span>}</div>
          <div className="mg-table-scroll"><table><thead><tr><th>時間</th><th>動作</th><th>版本</th><th>狀態</th><th>說明</th><th></th></tr></thead><tbody>
            {list.map((h) => <tr key={h.id}><td>{new Date(h.createdAt).toLocaleString('zh-TW')}</td><td>{h.detail.kind === 'rollback' ? `回復（${h.detail.dataMode === 'restore' ? '還原備份' : '保留資料'}）` : h.detail.kind === 'redeploy' ? '重新上線（保留資料）' : '發布'}</td><td>{h.version}</td>
              <td><span className={`mg-status ${relTone(h.status)}`}>{REL_STATUS[h.status] ?? h.status}</span></td><td className="onb-wrap">{h.detail.error ?? (h.detail.offline ? `下架：${h.detail.offline.reason}` : h.detail.reason) ?? ''}</td>
              <td className="onb-row-actions"><button className="onb-link" onClick={() => void onboardingApi.releaseLog(h.id).then((text) => setLog({ title: `${h.name} ${h.version} 日誌`, text }))}>日誌</button></td></tr>)}
          </tbody></table></div>
          <OfflineControl list={list} disabled={busy || running} notice={notice} onDone={load} />
          <VersionSwitch list={list} disabled={busy || running} notice={notice} onDone={load} />
        </article>;
      })}
    </section>}

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
