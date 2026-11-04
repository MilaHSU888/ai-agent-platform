"use client";
import { useCallback, useEffect, useState } from 'react';
import { ApiError, onboardingApi, type CatalogTool, type Notice } from './onboarding-api';
import { canSeeTrial, type Role } from './role';

const newEventId = () => `evt_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;

/**
 * 試用中（未公開）的工具。開發者中心用：列出目前身分看得到的試用工具（開發者只看得到自己當 Owner 的）。
 * 2026/11/02 起開發者不用按「試用通過」，由 AI Team 切換燈號公開；2026/11/04 起提醒文字不再要求開發者通知 AI Team。
 */
export function TrialPanel({ role, developer = '', notice }: { role: Role; developer?: string; notice: (m: string) => void }) {
  const [tools, setTools] = useState<CatalogTool[] | null>(null);
  const load = useCallback(async () => { try { setTools(await onboardingApi.catalog()); } catch { setTools(null); } }, []);
  useEffect(() => {
    let alive = true;
    void onboardingApi.catalog().then((r) => { if (alive) setTools(r); }).catch(() => { if (alive) setTools(null); });
    const refresh = () => { void load(); };
    window.addEventListener('workhub:catalog-refresh', refresh);
    return () => { alive = false; window.removeEventListener('workhub:catalog-refresh', refresh); };
  }, [load]);
  if (!tools) return null;
  const items = tools.filter((t) => isTrialing(t) && canSeeTrial(role, developer, t.owner));
  void notice;
  return <section id="trial-panel" className="mg-panel onb-review">
    <div className="mg-row"><div><h2>試用中（未公開）</h2>
      <p className="mg-muted">只有該工具的 Owner（開發者）與 AI Team 看得到；AI Team 切換為「公開中」後，一般使用者才看得到。{role === 'developer' && `目前顯示 ${developer || '（未選擇開發者）'} 當 Owner 的工具。`}</p></div>
      <button onClick={() => void load()}>重新整理</button></div>
    {items.length === 0 ? <p className="mg-submission-empty">目前沒有試用中的工具或版本。</p> : items.map((t) => <TrialCard key={t.toolId} tool={t} />)}
  </section>;
}

/** 工具是否有試用中的版本：尚未公開的工具本身，或已公開工具的並行試用版 */
export const isTrialing = (t: CatalogTool) => !!t.trial || (t.visibility === 'trial' && !t.offline);
export const trialVersionOf = (t: CatalogTool) => (t.trial ? t.trial.version : t.version);

/** 開發者中心最上方的提醒：工具已可以開始試用（2026/11/04：點「前往試用」後就消失，不再一直顯示）。 */
export function TrialNotice({ developer = '' }: { role?: Role; developer?: string }) {
  const [items, setItems] = useState<Notice[]>([]);
  useEffect(() => {
    if (!developer) return;
    let alive = true;
    const load = () => { void onboardingApi.notices(developer).then((r) => { if (alive) setItems(r.filter((n) => n.kind === 'trial')); }).catch(() => {}); };
    load();
    const timer = setInterval(load, 20000);
    window.addEventListener('workhub:catalog-refresh', load);
    return () => { alive = false; clearInterval(timer); window.removeEventListener('workhub:catalog-refresh', load); };
  }, [developer]);
  if (!items.length) return null;
  const go = (n: Notice) => {
    setItems((list) => list.filter((x) => x.id !== n.id));
    void onboardingApi.readNotice(n.id).catch(() => {});
    const el = document.getElementById(`trial-${n.toolId}`) ?? document.getElementById('trial-panel');
    el?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    el?.classList.add('onb-flash');
    setTimeout(() => el?.classList.remove('onb-flash'), 2400);
  };
  return <div className="onb-notice" role="status">
    <div><b>有 {items.length} 個工具已可以開始試用</b></div>
    <div className="onb-notice-links">{items.map((n) => <button key={n.id} onClick={() => go(n)}>{n.message.replace(/ 已可以開始試用$/, '')}：前往試用 ↓</button>)}</div>
  </div>;
}

/** 單一工具的試用卡片（只顯示狀態與「開啟試用版」；公開與下架由 AI Team 用燈號切換） */
export function TrialCard({ tool: t, bare = false }: { tool: CatalogTool; bare?: boolean }) {
  const parallel = t.trial;
  const version = parallel ? parallel.version : t.version;
  const url = parallel ? parallel.url : t.url;
  const healthy = parallel ? parallel.healthy : t.healthy;
  const open = (u: string) => { void onboardingApi.entryEvent({ clientEventId: newEventId(), toolId: t.toolId, kind: 'click', trial: true }).catch(() => {}); window.open(u, '_blank', 'noopener,noreferrer'); };
  return <article id={`trial-${t.toolId}`} className={bare ? 'onb-trial-card' : 'onb-review-item'}>
    <div className="mg-row"><div>{!bare && <h3>{t.name} · {version}</h3>}{bare && <h3>試用版 {version}</h3>}
      <small className="mg-muted">{parallel ? `新版並行試用：一般使用者仍使用 ${t.version}；試用版從空白資料開始，請自行上傳測試資料（公開時捨棄）` : `首次上架：工具尚未公開，一般使用者看不到${t.kind === 'url' ? '' : '；試用資料在第一次公開時會清空'}`} · Owner {t.owner}</small>
      {t.model && <p className="mm-model-line">模型：<b>{t.model.ref?.model ?? '尚未設定（請聯絡 AI Team）'}</b>{t.model.ref && (t.model.source === 'default' ? '（平台預設）' : '（AI Team 指定）')}</p>}</div>
      <span className="mg-status warn">{t.busy ? '公開處理中…' : '試用中'}</span></div>
    <div className="mg-actions">
      {url && <button className="onb-link" disabled={!healthy} onClick={() => open(url)}>{healthy ? `開啟試用版 ${version} ↗` : '試用版服務未回應'}</button>}
    </div>
  </article>;
}

type Light = 'trial' | 'public' | 'ended';
const LIGHTS: { id: Light; label: string; dot: string }[] = [
  { id: 'trial', label: '試用中', dot: '🟡' }, { id: 'public', label: '公開中', dot: '🟢' }, { id: 'ended', label: '下架', dot: '⚪' },
];

/**
 * 發布管理 → 工具詳情：試用／公開燈號（只有 AI Team 操作，2026/11/02）。
 * 切到「公開中」或「下架」會先跳確認視窗；切回「試用中」不刪資料，直接切換。
 */
export function LightSwitch({ tool: t, notice, onDone, compact = false }: { tool: CatalogTool; notice: (m: string) => void; onDone: () => Promise<unknown> | void; compact?: boolean }) {
  const [ask, setAsk] = useState<Light | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [watch, setWatch] = useState(0);
  // 公開新版、第一次公開會跑背景工作：完成前每 3 秒更新一次（最多 3 分鐘）
  useEffect(() => {
    if (!watch) return;
    const timer = setInterval(() => { void onDone(); window.dispatchEvent(new Event('workhub:catalog-refresh')); }, 3000);
    const stop = setTimeout(() => setWatch(0), 180000);
    return () => { clearInterval(timer); clearTimeout(stop); };
  }, [watch, onDone]);
  if (t.offline) return null;
  const parallel = t.trial;
  const version = parallel ? parallel.version : t.version;
  const current: Light = parallel || t.visibility !== 'public' ? 'trial' : 'public';
  const clearsData = !parallel && t.visibility !== 'public' && !t.everPublished && t.kind !== 'url';
  const disabledWhy = (l: Light): string | undefined => {
    if (t.busy) return '公開或發布工作進行中，請稍候';
    if (l === current) return undefined;
    if (l === 'trial' && parallel) return '新版本已在試用中';
    return undefined;
  };
  const message = (l: Light) => l === 'public'
    ? (parallel ? `正式版本會從 ${t.version} 換成 ${version}：先備份資料，健康檢查失敗自動還原；完成後移除試用版。之後要退回舊版請用「回復」。`
      : `公開後一般使用者依部門權限可以使用。${clearsData ? '試用期間的資料會直接清空，公開後從空白資料開始。' : ''}`)
    : parallel ? `只下架新版 ${version} 的試用版：試用版與試用資料會刪除，一般使用者繼續使用 ${t.version}。`
      : `工具會停止服務，${t.visibility === 'public' ? '一般使用者將無法使用' : '入口關閉'}；資料保留，之後可以在「已下架」重新上架。`;
  const go = async (l: Light) => {
    setBusy(true); setError(''); setAsk(null);
    try {
      const r = await onboardingApi.light(t.toolId, l);
      if (compact) setError('');
      notice(r.jobId ? `${t.name} ${version} 公開處理中，完成後會自動更新` : l === 'public' ? `${t.name} 已公開` : l === 'trial' ? `${t.name} 已切回試用中，一般使用者看不到` : parallel ? `已下架 ${t.name} 的試用版 ${version}` : `已下架 ${t.name}，資料保留`);
      if (r.jobId) setWatch((w) => w + 1);
      window.dispatchEvent(new Event('workhub:catalog-refresh')); await onDone();
    } catch (e) { const m = e instanceof ApiError ? (e.reasons[0] ?? e.message) : '上架服務沒有回應'; setError(m); if (compact) notice(m); }
    finally { setBusy(false); }
  };
  const pick = (l: Light) => { if (l === current) return; if (l === 'trial') void go(l); else setAsk(l); };
  const sw = <div className={`rc-light-switch${compact ? ' compact' : ''}`} role="radiogroup" aria-label={`${t.name} 試用／公開`}>
    {LIGHTS.map((x) => <button key={x.id} type="button" role="radio" aria-checked={current === x.id} className={`rc-light-${x.id} ${current === x.id ? 'on' : ''}`}
      disabled={busy || !!t.busy || (current !== x.id && !!disabledWhy(x.id))} title={disabledWhy(x.id)} onClick={() => pick(x.id)}><span aria-hidden>{x.dot}</span>{x.label}</button>)}
  </div>;
  const dialog = ask && <div className="mg-overlay"><section className="mg-dialog rc-confirm" role="alertdialog" aria-modal="true" aria-labelledby={`rc-confirm-${t.toolId}`}>
    <h2 id={`rc-confirm-${t.toolId}`}>{ask === 'public' ? `確定要公開 ${t.name} ${version}？` : (parallel ? `確定要下架 ${t.name} 的試用版 ${version}？` : `確定要下架 ${t.name}？`)}</h2>
    <p>{message(ask)}</p>
    <div className="mg-actions"><button type="button" onClick={() => setAsk(null)}>取消</button>
      <button type="button" className={ask === 'public' ? 'onb-primary-sm' : 'onb-danger'} onClick={() => void go(ask)}>{ask === 'public' ? '確定公開' : '確定下架'}</button></div>
  </section></div>;
  // 總表用：只有燈號（處理中時顯示文字），錯誤改用上方通知
  if (compact) return <>{t.busy ? <span className="mg-status warn">公開處理中…</span> : sw}{dialog}</>;
  return <div className="onb-gate rc-light">
    <h3>試用／公開{parallel && <small className="mg-muted">（新版 {version}）</small>}</h3>
    {sw}
    <p className="mg-muted">{t.busy ? '公開處理中…' : current === 'public' ? '一般使用者依部門權限使用中。切回「試用中」只是暫時隱藏，版本與資料不變。' : parallel ? `一般使用者仍使用 ${t.version}；新版 ${version} 只有 Owner 與 AI Team 看得到。` : '只有 Owner 與 AI Team 看得到。'}</p>
    {error && <p className="onb-error">{error}</p>}
    {dialog}
  </div>;
}

/** 發布管理：封存工具（例如測試用工具）。停止所有容器、從網站各頁移除；資料與紀錄保留，不是永久刪除。 */
export function ArchiveControl({ toolId, name, notice, onDone }: { toolId: string; name: string; notice: (m: string) => void; onDone: () => Promise<unknown> | void }) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const go = async () => {
    setBusy(true); setError('');
    try { await onboardingApi.archive(toolId, reason); notice(`已封存 ${name}，網站上不再顯示`); setReason(''); window.dispatchEvent(new Event('workhub:catalog-refresh')); await onDone(); }
    catch (e) { setError(e instanceof ApiError ? (e.reasons[0] ?? e.message) : '上架服務沒有回應'); }
    finally { setBusy(false); }
  };
  return <div className="onb-gate"><h3>封存工具</h3>
    <p className="mg-muted">用於測試用或不再使用的工具：停止服務並從網站各頁移除。資料與紀錄保留，不是永久刪除。</p>
    <div className="mg-row"><input aria-label={`${name} 封存原因`} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="封存原因（會留在稽核紀錄）" />
      <button className="onb-danger" disabled={busy || !reason.trim()} onClick={() => void go()}>封存工具</button></div>
    {error && <p className="onb-error">{error}</p>}
  </div>;
}

