"use client";
import { useCallback, useEffect, useState } from 'react';
import { ApiError, onboardingApi, type CatalogTool } from './onboarding-api';
import { canSeeTrial, type Role } from './role';

const newEventId = () => `evt_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;

/**
 * 試用中（未公開）的工具（DEC-032）。開發者中心用：列出目前身分看得到的試用工具。
 * 開發者只看得到自己當 Owner 的；AI Team 看得到全部。
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
  return <section id="trial-panel" className="mg-panel onb-review">
    <div className="mg-row"><div><h2>試用中（未公開）</h2>
      <p className="mg-muted">只有該工具的 Owner（開發者）與 AI Team 看得到。開發者試用沒問題後按「試用通過」，AI Team 再按「公開」，一般使用者才看得到。{role === 'developer' && `目前顯示 ${developer || '（未選擇開發者）'} 當 Owner 的工具；公開由 AI Team 操作。`}</p></div>
      <button onClick={() => void load()}>重新整理</button></div>
    {items.length === 0 ? <p className="mg-submission-empty">目前沒有試用中的工具或版本。</p> : items.map((t) => <TrialCard key={t.toolId} tool={t} role={role} notice={notice} onDone={load} />)}
  </section>;
}

/** 工具是否有試用中的版本：尚未公開的工具本身，或已公開工具的並行試用版 */
export const isTrialing = (t: CatalogTool) => !!t.trial || (t.visibility === 'trial' && !t.offline);
/** 試用版本的最近一次結果（試用通過／測試未通過），沒有結果為 null */
export const trialResultOf = (t: CatalogTool) => (t.trial ? t.trial.result : t.trialResult) ?? null;
export const trialVersionOf = (t: CatalogTool) => (t.trial ? t.trial.version : t.version);

/** 開發者中心最上方的提醒：有工具已進入試用、還沒填測試結果。點擊直接捲到該工具的試用卡片。 */
export function TrialNotice({ role, developer = '' }: { role: Role; developer?: string }) {
  const [tools, setTools] = useState<CatalogTool[]>([]);
  useEffect(() => {
    let alive = true;
    const load = () => { void onboardingApi.catalog().then((r) => { if (alive) setTools(r); }).catch(() => { if (alive) setTools([]); }); };
    load();
    const timer = setInterval(load, 20000);
    window.addEventListener('workhub:catalog-refresh', load);
    return () => { alive = false; clearInterval(timer); window.removeEventListener('workhub:catalog-refresh', load); };
  }, []);
  const waiting = tools.filter((t) => isTrialing(t) && canSeeTrial(role, developer, t.owner) && !trialResultOf(t));
  if (!waiting.length) return null;
  const go = (toolId: string) => {
    const el = document.getElementById(`trial-${toolId}`) ?? document.getElementById('trial-panel');
    el?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    el?.classList.add('onb-flash');
    setTimeout(() => el?.classList.remove('onb-flash'), 2400);
  };
  return <div className="onb-notice" role="status">
    <div><b>有 {waiting.length} 個工具已核准發布，可以開始試用</b>
      <p>請開啟試用版測試，並填寫測試結果（試用通過或測試未通過）。工具尚未公開，一般使用者看不到。</p></div>
    <div className="onb-notice-links">{waiting.map((t) => <button key={t.toolId} onClick={() => go(t.toolId)}>{t.name} {trialVersionOf(t)}：前往填寫測試結果 ↓</button>)}</div>
  </div>;
}

/** 單一工具的試用卡片：開啟試用版、試用通過（開發者）、公開（AI Team）、結束試用。 */
export function TrialCard({ tool: t, role, notice, onDone, bare = false }: { tool: CatalogTool; role: Role; notice: (m: string) => void; onDone: () => Promise<unknown> | void; bare?: boolean }) {
  const [note, setNote] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<Record<string, string[]>>({});
  const [watch, setWatch] = useState(0);
  // 公開新版會跑更新流程：完成前每 3 秒更新一次（最多 2 分鐘）
  useEffect(() => {
    if (!watch) return;
    const timer = setInterval(() => { void onDone(); window.dispatchEvent(new Event('workhub:catalog-refresh')); }, 3000);
    const stop = setTimeout(() => setWatch(0), 120000);
    return () => { clearInterval(timer); clearTimeout(stop); };
  }, [watch, onDone]);
  const parallel = t.trial;
  const version = parallel ? parallel.version : t.version;
  const url = parallel ? parallel.url : t.url;
  const healthy = parallel ? parallel.healthy : t.healthy;
  const result = trialResultOf(t);
  const passed = result?.result === 'passed';
  const failed = result?.result === 'failed';
  const key = t.toolId;
  const act = async (k: string, fn: () => Promise<unknown>, ok: string, after?: () => void) => {
    setBusy(true); setErrors({ ...errors, [k]: [] });
    try { await fn(); notice(ok); setNote({ ...note, [k]: '' }); after?.(); await onDone(); window.dispatchEvent(new Event('workhub:catalog-refresh')); }
    catch (e) { const r = e instanceof ApiError ? (e.reasons.length ? e.reasons : [e.message]) : ['上架服務沒有回應，請確認服務已啟動']; setErrors({ ...errors, [k]: r }); notice(r[0]); }
    finally { setBusy(false); }
  };
  const open = (u: string) => { void onboardingApi.entryEvent({ clientEventId: newEventId(), toolId: t.toolId, kind: 'click', trial: true }).catch(() => {}); window.open(u, '_blank', 'noopener,noreferrer'); };
  const errs = (k: string) => (errors[k]?.length ?? 0) > 0 && <ul className="onb-error">{errors[k].map((r) => <li key={r}>{r}</li>)}</ul>;
  return <article id={`trial-${t.toolId}`} className={bare ? 'onb-trial-card' : 'onb-review-item'}>
    <div className="mg-row"><div>{!bare && <h3>{t.name} · {version}</h3>}{bare && <h3>試用版 {version}</h3>}
      <small className="mg-muted">{parallel ? `新版並行試用：一般使用者仍使用 ${t.version}；試用版從空白資料開始，請自行上傳測試資料（公開時捨棄）` : '首次上架：工具尚未公開，一般使用者看不到'} · Owner {t.owner}</small>
      {t.model && <p className="mm-model-line">模型：<b>{t.model.ref?.model ?? '尚未設定（請聯絡 AI Team）'}</b>{t.model.ref && (t.model.source === 'default' ? '（平台預設）' : '（AI Team 指定）')}</p>}</div>
      <span className={`mg-status ${passed ? 'good' : failed ? 'bad' : 'warn'}`}>{passed ? '開發者已試用通過，待 AI Team 公開' : failed ? '測試未通過' : '待開發者試用'}</span></div>
    {result && <p className={failed ? 'onb-error' : 'mg-muted'}>測試結果（{result.actor}，{new Date(result.at).toLocaleString('zh-TW')}）：{result.result === 'passed' ? '試用通過' : '測試未通過'}{result.note ? `：${result.note}` : ''}{failed && '。請修正後提交新版本，或重新測試後按「試用通過」。'}</p>}
    <div className="mg-actions">
      {url && <button className="onb-link" disabled={!healthy} onClick={() => open(url)}>{healthy ? `開啟試用版 ${version} ↗` : '試用版服務未回應'}</button>}
    </div>
    {!passed && <div className="onb-gate"><h3>填寫測試結果（開發者）</h3>
      <textarea aria-label={`${t.name} 測試結果說明`} value={note.p ?? ''} onChange={(e) => setNote({ ...note, p: e.target.value })} placeholder="測試結果說明：試用通過可不填；測試未通過請寫原因，例如：匯出檔案欄位錯位" />
      <div className="mg-actions">
        <button className="onb-primary-sm" disabled={busy} onClick={() => void act('p', () => onboardingApi.passTrial(key, note.p ?? ''), `${t.name} ${version} 試用通過，等待 AI Team 公開`)}>試用通過</button>
        <button className="onb-danger" disabled={busy || !(note.p ?? '').trim()} title={(note.p ?? '').trim() ? undefined : '請先寫下未通過的原因'} onClick={() => void act('p', () => onboardingApi.failTrial(key, note.p ?? ''), parallel ? `${t.name} ${version} 測試未通過，已結束試用；正式版本不受影響` : `${t.name} ${version} 測試未通過，已記錄`)}>測試未通過</button>
      </div>
      <small className="mg-muted">{parallel ? '按「測試未通過」會結束這個試用版（正式版本不受影響），修正後請提交新版本。' : '按「測試未通過」會記錄結果，工具維持試用中；修正後提交新版本，或重新測試後按「試用通過」。'}</small>
      {errs('p')}</div>}
    {role === 'aiteam' && <div className="onb-gate"><h3>公開（AI Team）</h3>
      <p className="mg-muted">{parallel ? `公開後，正式版本會從 ${t.version} 更新為 ${version}：先備份資料，健康檢查失敗自動還原；完成後移除試用版。` : '公開後依部門權限開放給一般使用者。'}</p>
      <div className="mg-row"><input aria-label={`${t.name} 公開說明`} value={note.u ?? ''} onChange={(e) => setNote({ ...note, u: e.target.value })} placeholder="公開說明（會留在稽核紀錄），例如試用結果" />
        <button disabled={busy || !passed || !(note.u ?? '').trim()} title={passed ? undefined : '需先由開發者按「試用通過」'} onClick={() => void act('u', () => onboardingApi.publish(key, note.u ?? ''), parallel ? `開始公開 ${t.name} ${version}（更新正式版本）` : `${t.name} 已公開`, parallel ? () => setWatch(Date.now()) : undefined)}>公開</button></div>
      {errs('u')}</div>}
    {parallel && <div className="onb-gate"><h3>結束試用</h3>
      <p className="mg-muted">試用發現問題時使用：捨棄這個試用版，正式版本不受影響；修正後重新提交新版本。</p>
      <div className="mg-row"><input aria-label={`${t.name} 結束試用原因`} value={note.e ?? ''} onChange={(e) => setNote({ ...note, e: e.target.value })} placeholder="結束試用原因（會留在稽核紀錄）" />
        <button className="onb-danger" disabled={busy || !(note.e ?? '').trim()} onClick={() => void act('e', () => onboardingApi.endTrial(key, note.e ?? ''), `已結束 ${t.name} ${version} 的試用`)}>結束試用</button></div>
      {errs('e')}</div>}
  </article>;
}

/** 發布管理：已公開工具可「取消公開」，退回試用中（容器照跑，一般使用者看不到）。 */
export function VisibilityControl({ tool, notice, onDone }: { tool: CatalogTool | undefined; notice: (m: string) => void; onDone: () => Promise<unknown> | void }) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  if (!tool || tool.offline) return null;
  if (tool.visibility !== 'public') return <div className="onb-gate"><h3>公開狀態：試用中（未公開）</h3><p className="mg-muted">只有 Owner 與 AI Team 看得到。請在上方「試用中」區塊由開發者試用通過後公開。</p></div>;
  const go = async () => {
    setBusy(true); setError('');
    try { await onboardingApi.unpublish(tool.toolId, reason); notice(`${tool.name} 已取消公開，一般使用者看不到`); setReason(''); window.dispatchEvent(new Event('workhub:catalog-refresh')); await onDone(); }
    catch (e) { setError(e instanceof ApiError ? (e.reasons[0] ?? e.message) : '上架服務沒有回應'); }
    finally { setBusy(false); }
  };
  return <div className="onb-gate"><h3>公開狀態：公開</h3>
    <p className="mg-muted">取消公開後退回試用中：服務照常運作，但只有 Owner 與 AI Team 看得到。</p>
    <div className="mg-row"><input aria-label="取消公開原因" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="取消公開原因（會留在稽核紀錄）" />
      <button className="onb-danger" disabled={busy || !reason.trim()} onClick={() => void go()}>取消公開</button></div>
    {error && <p className="onb-error">{error}</p>}
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

