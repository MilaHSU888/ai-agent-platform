"use client";
/**
 * 模型管理（DEC-040，2026/10/28）：真實功能，接本機上架服務。
 * - ModelSettings：平台設定 → 模型端點（可用模型、平台預設模型）
 * - ToolModelSetting：發布管理 → 工具詳情 → 設定 → 模型（指定模型立即生效、僅限地端、近 7 天用量）
 * - ModelUsagePanel：使用分析 → 模型用量
 * - ToolUsageLine：維運中心 → 近 24 小時模型呼叫
 * - ModelNotices：開發者中心最上方給工具 Owner 的提醒
 * 金鑰與新增端點不在網站上處理，請用 pilot/設定模型端點.command。
 */
import { useCallback, useEffect, useState } from 'react';
import { ApiError, onboardingApi, type EndpointInfo, type ModelRef, type ModelUsage, type Notice, type ToolModelInfo } from './onboarding-api';

const LOC: Record<string, string> = { local: '地端', cloud: '雲端' };
const fmt = (n: number) => n.toLocaleString('zh-TW');
const sec = (ms: number | null) => (ms === null ? '—' : `${(ms / 1000).toFixed(1)} 秒`);
const errMsg = (e: unknown) => (e instanceof ApiError ? (e.reasons[0] ?? e.message) : '上架服務沒有回應');

export function ModelSettings({ notice }: { notice: (m: string) => void }) {
  const [data, setData] = useState<{ endpoints: EndpointInfo[]; default: ModelRef | null } | null>(null);
  const [state, setState] = useState<'loading' | 'offline' | 'ready'>('loading');
  const [busy, setBusy] = useState(false);
  const [reason, setReason] = useState('');
  const load = useCallback(async () => {
    try { setData(await onboardingApi.models()); setState('ready'); } catch { setState('offline'); }
  }, []);
  useEffect(() => {
    let alive = true;
    onboardingApi.models().then((r) => { if (alive) { setData(r); setState('ready'); } }).catch(() => { if (alive) setState('offline'); });
    return () => { alive = false; };
  }, []);
  const act = async (fn: () => Promise<unknown>, ok: string) => {
    setBusy(true);
    try { await fn(); notice(ok); await load(); window.dispatchEvent(new Event('workhub:catalog-refresh')); } catch (e) { notice(errMsg(e)); } finally { setBusy(false); }
  };
  if (state === 'loading') return <section className="mg-panel"><h2>模型端點</h2><p className="mg-muted">讀取模型清單中…</p></section>;
  if (state === 'offline' || !data) return <section className="mg-panel"><h2>模型端點</h2><p className="mg-muted">上架服務未啟動，或網站不是從 http://localhost:3002 開啟，無法讀取模型設定。</p></section>;
  return <section className="mg-panel">
    <div className="mg-row"><div><h2>模型端點</h2><p className="mg-muted">工具一律經平台的模型轉接服務呼叫模型。勾選「可用」的模型才能指派給工具；沒被指定的工具都用<b>平台預設模型</b>（只能是地端模型）。換預設模型立即生效，跟著預設的工具 Owner 會收到提醒。</p></div>
      <button disabled={busy} onClick={() => void load()}>重新整理</button></div>
    <p className="onb-note">目前預設：<b>{data.default ? `${data.default.model}（${data.default.endpoint}）` : '尚未設定'}</b>。新增端點或更換金鑰請在這台電腦執行 <code>pilot/設定模型端點.command</code>，網站上不顯示也不輸入金鑰。</p>
    {data.endpoints.length === 0 && <p className="onb-error">尚未設定任何模型端點。</p>}
    {data.endpoints.map((ep) => <div key={ep.id} className="mm-endpoint">
      <div className="mg-row"><h3>{ep.id} <span className={`mm-loc ${ep.location}`}>{LOC[ep.location]}</span></h3>
        <span className={`mg-status ${ep.reachable ? 'good' : 'bad'}`}>{ep.reachable ? `連線正常・${ep.models.filter((m) => m.available).length} 個模型` : `無法取得模型清單：${ep.error ?? ''}`}</span></div>
      <div className="mg-table-scroll"><table><thead><tr><th>模型</th><th>可用</th><th>平台預設</th><th>指定使用的工具</th></tr></thead><tbody>
        {ep.models.map((m) => <tr key={m.id}>
          <td><code>{m.id}</code>{!m.available && <small className="onb-error">（端點目前沒有提供）</small>}</td>
          <td><input type="checkbox" aria-label={`${m.id} 可用`} checked={m.enabled} disabled={busy || m.isDefault || m.usedBy.length > 0}
            title={m.isDefault ? '平台預設模型不能停用' : m.usedBy.length ? '還有工具指定使用，不能停用' : undefined}
            onChange={(e) => void act(() => onboardingApi.setModelEnabled({ endpoint: ep.id, model: m.id }, e.target.checked), `${m.id} 已${e.target.checked ? '設為可用' : '停用'}`)} /></td>
          <td>{m.isDefault ? <span className="mg-status good">預設</span> : ep.location === 'local' && m.enabled && m.available
            ? <button className="onb-link" disabled={busy} onClick={() => void act(() => onboardingApi.setDefaultModel({ endpoint: ep.id, model: m.id }, reason), `平台預設模型已改為 ${m.id}`)}>設為預設</button>
            : <small className="mg-muted">{ep.location === 'cloud' ? '雲端不能當預設' : '先勾選可用'}</small>}</td>
          <td>{m.usedBy.join('、') || '—'}</td>
        </tr>)}
      </tbody></table></div>
    </div>)}
    <label className="mm-reason">更換預設模型的原因（選填，會寫進給 Owner 的提醒）<input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="例如 新模型辨識圖片較準確" /></label>
  </section>;
}

/** 發布管理 → 工具詳情 → 設定 → 模型 */
export function ToolModelSetting({ toolId, info, notice, onDone }: { toolId: string; info: ToolModelInfo; notice: (m: string) => void; onDone: () => void }) {
  const [eps, setEps] = useState<{ endpoints: EndpointInfo[]; default: ModelRef | null } | null>(null);
  const [pick, setPick] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [usage, setUsage] = useState<ModelUsage | null>(null);
  useEffect(() => {
    void onboardingApi.models().then(setEps).catch(() => setEps(null));
    void onboardingApi.modelUsage(24 * 7, toolId).then(setUsage).catch(() => setUsage(null));
  }, [toolId]);
  const options = (eps?.endpoints ?? []).flatMap((ep) => ep.models.filter((m) => m.enabled).map((m) => ({ value: `${ep.id}\n${m.id}`, label: `${m.id}（${ep.id}・${LOC[ep.location]}）`, cloud: ep.location === 'cloud' })));
  const current = info.source === 'tool' && info.ref ? `${info.ref.endpoint}\n${info.ref.model}` : '__default';
  const value = pick || current;
  const changed = value !== current;
  const save = async () => {
    setBusy(true);
    try {
      const [endpoint, model] = value.split('\n');
      await onboardingApi.setToolModel(toolId, value === '__default' ? null : { endpoint, model }, reason);
      notice('已更換模型，立即生效，並已提醒工具 Owner'); setPick(''); setReason(''); onDone();
    } catch (e) { notice(errMsg(e)); } finally { setBusy(false); }
  };
  const t = usage?.totals;
  return <div className="mm-tool">
    <div className="mg-row"><h3>模型</h3><small className="mg-muted">目前使用：<b>{info.ref?.model ?? '（未設定）'}</b>{info.source === 'default' ? '（平台預設）' : '（AI Team 指定）'}</small></div>
    <div className="mm-tool-row">
      <select aria-label="選擇模型" value={value} disabled={busy || !eps} onChange={(e) => setPick(e.target.value)}>
        <option value="__default">使用平台預設{eps?.default ? `（${eps.default.model}）` : ''}</option>
        {options.map((o) => <option key={o.value} value={o.value} disabled={o.cloud && info.localOnly}>{o.label}{o.cloud && info.localOnly ? '・僅限地端不可選' : ''}</option>)}
      </select>
      <input aria-label="更換原因" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="更換原因（必填，會通知工具 Owner）" />
      <button className="onb-primary-sm" disabled={busy || !changed || !reason.trim()} onClick={() => void save()}>{busy ? '儲存中…' : '更換模型'}</button>
    </div>
    <label className="onb-check"><input type="checkbox" checked={info.localOnly} disabled={busy}
      onChange={(e) => { setBusy(true); void onboardingApi.setLocalOnly(toolId, e.target.checked).then(() => { notice(e.target.checked ? '已設為僅限地端' : '已取消僅限地端'); onDone(); }).catch((err) => notice(errMsg(err))).finally(() => setBusy(false)); }} />
      僅限地端（處理敏感資料的工具勾選後，不能改用雲端模型）</label>
    <small className="mg-muted">換模型立即生效，工具不用重啟或重新上架。{t ? ` 近 7 天：呼叫 ${fmt(t.calls)} 次・失敗 ${fmt(t.errors)} 次・平均 ${sec(t.avgMs)}・token ${fmt(t.tokens)}` : ''}</small>
  </div>;
}

/** 維運中心：選定工具近 24 小時的模型呼叫 */
export function ToolUsageLine({ toolId }: { toolId: string }) {
  const [u, setU] = useState<ModelUsage | null>(null);
  useEffect(() => { let alive = true; void onboardingApi.modelUsage(24, toolId).then((r) => { if (alive) setU(r); }).catch(() => {}); return () => { alive = false; }; }, [toolId]);
  if (!u) return null;
  const t = u.totals;
  return <p className={`mm-usage-line ${t.errors > 0 ? 'warn' : ''}`}>近 24 小時模型呼叫 <b>{fmt(t.calls)}</b> 次・失敗 <b>{fmt(t.errors)}</b> 次・平均回應 <b>{sec(t.avgMs)}</b>{t.calls === 0 ? '（沒有呼叫紀錄）' : ''}</p>;
}

/** 使用分析 → 模型用量（真實資料） */
export function ModelUsagePanel() {
  const [hours, setHours] = useState(24 * 30);
  const [u, setU] = useState<ModelUsage | null>(null);
  const [state, setState] = useState<'loading' | 'offline' | 'ready'>('loading');
  useEffect(() => { let alive = true; void onboardingApi.modelUsage(hours).then((r) => { if (alive) { setU(r); setState('ready'); } }).catch(() => { if (alive) setState('offline'); }); return () => { alive = false; }; }, [hours]);
  if (state === 'offline') return <section className="panel mm-usage"><h2>模型用量</h2><p>上架服務未啟動，或網站不是從 http://localhost:3002 開啟，讀不到用量。</p></section>;
  if (!u) return <section className="panel mm-usage"><h2>模型用量</h2><p>讀取中…</p></section>;
  const max = Math.max(1, ...u.byDay.map((d) => d.calls));
  return <section className="panel mm-usage">
    <div className="panel-header"><div><h2>模型用量 <span className="mm-real">真實資料</span></h2><p>來源：平台模型轉接服務的呼叫紀錄（不含提示詞與回應內容；只看得出哪個工具，看不出哪位使用者；串流回應沒有 token 數）</p></div>
      <label className="period-select"><span>期間</span><select value={hours} onChange={(e) => setHours(Number(e.target.value))}><option value={24}>近 24 小時</option><option value={24 * 7}>近 7 天</option><option value={24 * 30}>近 30 天</option><option value={24 * 90}>近 90 天</option></select></label></div>
    <div className="mm-kpis">
      <div><small>呼叫次數</small><strong>{fmt(u.totals.calls)}</strong></div>
      <div><small>token 用量</small><strong>{fmt(u.totals.tokens)}</strong><span>輸入 {fmt(u.totals.promptTokens)}・輸出 {fmt(u.totals.completionTokens)}</span></div>
      <div><small>失敗</small><strong>{fmt(u.totals.errors)}</strong><span>{u.totals.calls ? `${((u.totals.errors / u.totals.calls) * 100).toFixed(1)}%` : '—'}</span></div>
      <div><small>平均回應時間</small><strong>{sec(u.totals.avgMs)}</strong></div>
      <div><small>地端／雲端</small><strong>{fmt(u.local.calls)}／{fmt(u.cloud.calls)}</strong><span>次</span></div>
    </div>
    {u.byDay.length > 0 && <div className="mm-bars" role="img" aria-label="每日呼叫次數">{u.byDay.map((d) => <div key={d.date} title={`${d.date}：${d.calls} 次，失敗 ${d.errors} 次`}><i style={{ height: `${Math.max(4, (d.calls / max) * 100)}%` }} /><small>{d.date.slice(5)}</small></div>)}</div>}
    <div className="mg-table-scroll"><table className="mm-table"><thead><tr><th>工具</th><th>呼叫</th><th>失敗</th><th>token</th><th>平均回應</th><th>模型</th><th>最後呼叫</th></tr></thead><tbody>
      {u.byTool.length === 0 ? <tr><td colSpan={7}>這段期間沒有模型呼叫紀錄。</td></tr> : u.byTool.map((r) => <tr key={r.toolId}>
        <td><b>{r.name}</b></td><td>{fmt(r.calls)}</td><td className={r.errors ? 'onb-error' : undefined}>{fmt(r.errors)}</td><td>{fmt(r.tokens)}</td><td>{sec(r.avgMs)}</td>
        <td>{r.models.join('、') || '—'}</td><td>{new Date(r.lastAt).toLocaleString('zh-TW')}</td></tr>)}
    </tbody></table></div>
  </section>;
}

/** 開發者中心最上方：給工具 Owner 的提醒（例如 AI Team 換了模型） */
export function ModelNotices({ owner }: { owner: string }) {
  const [items, setItems] = useState<Notice[]>([]);
  useEffect(() => { if (!owner) return; let alive = true; void onboardingApi.notices(owner).then((r) => { if (alive) setItems(r); }).catch(() => {}); return () => { alive = false; }; }, [owner]);
  if (!items.length) return null;
  return <section className="onb-notice mm-notices" role="status">
    <div><b>AI Team 通知</b>{items.map((n) => <p key={n.id}>{new Date(n.createdAt).toLocaleString('zh-TW', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}｜{n.message}</p>)}</div>
    <button onClick={() => { const ids = items.map((n) => n.id); setItems([]); void Promise.all(ids.map((id) => onboardingApi.readNotice(id))).catch(() => {}); }}>知道了</button>
  </section>;
}
