"use client";
/**
 * 維運中心（示範）：偵測 → 隔離 → 處理 → 驗證 → 恢復。
 * 由上架服務發布的工具：維護、重新啟動、日誌是真的操作（呼叫上架服務）；其他工具是示範。版本與下架在發布管理操作。
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ApiError, onboardingApi, type OpsEvent } from './onboarding-api';
import { ToolUsageLine } from './model-admin';
import { defaultConfig, modelKind, modelsOf, normalizeModel, type DemoConfig, type DemoState, type DemoStatus, type DemoTool } from './demo-management';

type Change = (fn: (s: DemoState) => DemoState) => void;
type Props = { state: DemoState; tools: DemoTool[]; change: Change; notice: (m: string) => void; releasedIds: Record<string, string>; urlToolIds?: string[]; openRelease: (t: DemoTool) => void };

const STEPS: [string, string][] = [['偵測', '監控與告警'], ['隔離', '切換維護模式'], ['處理', '重啟或回復版本'], ['驗證', '健康檢查'], ['恢復', '重新開放使用']];
const SERVICES = ['入口網站', '存取代理', 'LLM 閘道', '地端模型'];
const stamp = () => new Date().toLocaleString('zh-TW');

export function MonitorCenter({ state, tools, change, notice, releasedIds, urlToolIds = [], openRelease }: Props) {
  const managed = tools.filter((t) => !t.id.startsWith('knowledge-'));
  const [selected, setSelected] = useState(managed.find((t) => (state.configs[t.id]?.status ?? '運行中') === '維護中')?.id ?? managed[0]?.id ?? '');
  const [showAll, setShowAll] = useState(false);
  const tool = managed.find((t) => t.id === selected) ?? managed[0];
  const cfg: DemoConfig = state.configs[tool.id] ?? defaultConfig(tool);
  const realId = releasedIds[tool.id];
  const real = !!realId;
  // URL 工具不在平台上執行：只能進入維護／恢復（關閉或開放入口），不能重新啟動或查看日誌
  const isUrl = urlToolIds.includes(realId);
  const [ops, setOps] = useState<OpsEvent[]>([]);
  const [working, setWorking] = useState('');
  const [maintForm, setMaintForm] = useState(false);
  const [maintReason, setMaintReason] = useState('');
  const [logView, setLogView] = useState<{ title: string; text: string } | null>(null);
  const loadOps = useCallback(() => onboardingApi.opsEvents().then(setOps).catch(() => setOps([])), []);
  useEffect(() => { void loadOps(); }, [loadOps]);
  const realRun = async (key: string, fn: () => Promise<string>) => {
    setWorking(key);
    try { notice(await fn()); }
    catch (e) { notice(e instanceof ApiError ? (e.reasons[0] ?? e.message) : '上架服務沒有回應，請確認服務已啟動'); }
    finally { setWorking(''); window.dispatchEvent(new Event('workhub:catalog-refresh')); void loadOps(); }
  };

  const log = (s: DemoState, msg: string): DemoState => ({ ...s, audit: [`${stamp()}｜${msg}（示範）`, ...s.audit].slice(0, 200) });
  const patch = (values: Partial<DemoConfig>, msg: string) => change((s) => log({ ...s, configs: { ...s.configs, [tool.id]: { ...(s.configs[tool.id] ?? defaultConfig(tool)), ...values } } }, `${tool.name}：${msg}`));
  const setStatus = (status: DemoStatus, msg: string) => patch({ status }, msg);


  // 模型用量：依各 AI 工具目前指派的模型，以使用次數加權
  const modelUse = useMemo(() => {
    const sums = new Map<string, number>();
    for (const t of managed.filter((x) => x.type === 'AI')) {
      const m = normalizeModel((state.configs[t.id] ?? defaultConfig(t)).model);
      sums.set(m, (sums.get(m) ?? 0) + Math.max(1, t.runs));
    }
    const all = [...sums.values()].reduce((a, b) => a + b, 0) || 1;
    return [...sums.entries()].map(([m, v]) => ({ m, pct: Math.round((v / all) * 100), kind: modelKind(state, m) })).sort((a, b) => b.pct - a.pct).slice(0, 5);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.configs, state.models, managed.length]);

  const down = managed.filter((t) => ['維護中', '已下架'].includes((state.configs[t.id] ?? defaultConfig(t)).status));
  const events = [
    ...ops.map((e) => ({ time: new Date(e.at).toLocaleString('zh-TW'), text: `${e.toolName ?? ''}：${e.label}${e.version ? `（${e.version}）` : ''}${e.reason ? `｜${e.reason}` : ''}`, bad: e.bad, sub: `${e.actor}・上架服務紀錄` })),
    ...state.audit.map((a) => { const [time, ...rest] = a.split('｜'); const text = rest.join('｜'); return { time, text, bad: /維護|下架|失敗|異常/.test(text), sub: '' }; }),
  ];
  const shownEvents = showAll ? events.slice(0, 30) : events.slice(0, 4);

  const advice = cfg.status === '維護中' ? '工具目前已隔離。請查看日誌，視情況重新啟動；需要回復版本請到發布管理。驗證正常後再按「恢復服務」。'
    : cfg.status === '已下架' ? '工具已下架，使用者無法進入。問題排除後按「恢復服務」重新開放，或到發布管理重新上架。'
    : '工具運作中。發現異常時先按「進入維護」阻擋新使用者，再進行處理。';

  type Action = { key: string; icon: string; title: string; desc: string; tone?: 'ok' | 'danger'; enabled: boolean; run: () => void };
  const inMaint = cfg.status !== '運行中';
  const realActions: Action[] = [
    inMaint
      ? { key: 'resume', icon: '✓', title: working === 'resume' ? '恢復中…' : '恢復服務', desc: '重新開放入口', tone: 'ok', enabled: !working && cfg.status === '維護中',
          run: () => void realRun('resume', async () => { await onboardingApi.maintenance(realId, false); return `${tool.name} 已恢復服務，入口重新開放`; }) }
      : { key: 'maint', icon: '⚒', title: '進入維護', desc: '關閉入口，容器照跑', enabled: !working, run: () => setMaintForm(true) },
    { key: 'restart', icon: '↻', title: working === 'restart' ? '重新啟動中…' : '重新啟動', desc: isUrl ? 'URL 工具不在平台上執行，請聯絡該網站維運人員' : '保留資料，健康檢查通過才完成', enabled: !isUrl && !working && cfg.status !== '已下架',
      run: () => void realRun('restart', async () => { const r = await onboardingApi.restart(realId); return r.ok ? `${tool.name} 已重新啟動（${r.seconds} 秒，健康檢查通過）${cfg.status === '維護中' ? '。目前仍在維護中，確認正常後請按「恢復服務」開放入口' : ''}` : `${tool.name} 重新啟動後健康檢查未通過：${r.error ?? ''}`; }) },
    { key: 'logs', icon: '≡', title: working === 'logs' ? '讀取中…' : '查看日誌', desc: isUrl ? 'URL 工具沒有平台日誌' : '容器最近 200 行（金鑰已遮罩）', enabled: !isUrl && !working && cfg.status !== '已下架',
      run: () => void realRun('logs', async () => { setLogView({ title: `${tool.name} 日誌`, text: await onboardingApi.toolLogs(realId) }); return `已讀取 ${tool.name} 日誌`; }) },
  ];
  const actions: Action[] = [
    inMaint
      ? { key: 'resume', icon: '✓', title: '恢復服務', desc: '健康檢查通過後重新開放', tone: 'ok', enabled: true, run: () => setStatus('運行中', '健康檢查通過，恢復服務') }
      : { key: 'maint', icon: '⚒', title: '進入維護', desc: '先阻擋新使用者進入', enabled: true, run: () => setStatus('維護中', '進入維護') },
    { key: 'restart', icon: '↻', title: '重新啟動', desc: '保留資料並重建容器', enabled: cfg.status !== '已下架', run: () => { change((s) => log(s, `${tool.name}：重新啟動`)); notice(`已記錄 ${tool.name} 重新啟動（示範，未操作真實容器）`); } },
    { key: 'logs', icon: '≡', title: '查看日誌', desc: '檢查錯誤與異常流量', enabled: true, run: () => setShowAll(true) },
  ];

  return <div className="oc">
    <div className="mg-flow oc-steps">{STEPS.map(([t, d], i) => <span key={t}><b>0{i + 1}</b>{t}<small>{d}</small></span>)}</div>

    <section className="mg-panel">
      <div className="mg-row"><h2>平台核心服務</h2><span className={`mg-status ${down.length ? 'warn' : 'good'}`}>{down.length ? `${down.length} 個工具暫停開放` : '運作正常'}</span></div>
      <div className="oc-core">{SERVICES.map((sv) => <div key={sv}><span>{sv}</span><span className="mg-status good">正常</span></div>)}</div>
      <p className="mg-muted oc-tight">最後檢查：剛剛（示範）</p>
    </section>

    <section className="mg-panel">
      <div className="mg-row"><div><h2>工具維運操作台</h2><p className="mg-muted oc-tight">先選擇工具，再執行安全維運動作</p></div>
        <label className="oc-select">目前工具<select value={tool.id} onChange={(e) => setSelected(e.target.value)}>{managed.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</select></label></div>
      <div className="oc-tool">
        <span className="oc-icon">{tool.name.slice(0, 1)}</span>
        <div><b>{tool.name}</b><small>{cfg.version}・Owner {cfg.owner}</small></div>
        <span className={`mg-status ${cfg.status === '運行中' ? 'good' : cfg.status === '已下架' ? 'bad' : 'warn'}`}>{cfg.status}</span>
      </div>
      {real && !isUrl && tool.type === 'AI' && <ToolUsageLine key={realId} toolId={realId} />}
      {real ? <>
        <div className="oc-actions">{realActions.map((a) => <button key={a.key} className={`oc-action ${a.tone ?? ''}`} disabled={!a.enabled} onClick={a.run}>
          <span>{a.icon}</span><div><b>{a.title}</b><small>{a.desc}</small></div></button>)}</div>
        {maintForm && <div className="oc-maint"><input aria-label="維護原因" value={maintReason} placeholder="維護原因（會通知 Owner 並留在稽核紀錄）" onChange={(e) => setMaintReason(e.target.value)} />
          <button className="onb-primary-sm" disabled={!maintReason.trim() || !!working} onClick={() => void realRun('maint', async () => { await onboardingApi.maintenance(realId, true, maintReason); setMaintForm(false); setMaintReason(''); return `${tool.name} 已進入維護，入口關閉`; })}>確認進入維護</button>
          <button disabled={!!working} onClick={() => { setMaintForm(false); setMaintReason(''); }}>取消</button></div>}
        <p className="oc-advice"><b>建議操作：</b>{cfg.status === '已下架' ? '工具已下架，請到發布管理重新上架。' : advice}</p>
        <p className="mg-muted oc-goto">此工具由上架服務管理，上面三個動作會實際操作容器。需要回復版本或下架，請到發布管理。<button className="onb-link" onClick={() => openRelease(tool)}>開啟 {tool.name} 的發布詳情 →</button></p>
      </> : <>
        <div className="oc-actions">{actions.map((a) => <button key={a.key} className={`oc-action ${a.tone ?? ''}`} disabled={!a.enabled} onClick={a.run}>
          <span>{a.icon}</span><div><b>{a.title}</b><small>{a.desc}</small></div></button>)}</div>
        <p className="oc-advice"><b>建議操作：</b>{advice}</p>
        <p className="mg-muted oc-goto">需要回復版本或下架，請到發布管理。<button className="onb-link" onClick={() => openRelease(tool)}>開啟 {tool.name} 的發布詳情 →</button></p>
      </>}
    </section>

    <div>
      <section className="mg-panel">
        <div><h2>模型用量</h2><p className="mg-muted oc-tight">本月 LLM 路由分布</p></div>
        <ul className="oc-models">{modelUse.map((u) => <li key={u.m}>
          <div><span>{u.m.split('｜').slice(-1)[0]}{u.kind && <span className={`mg-status ${u.kind === '地端' ? 'good' : 'warn'}`}>{u.kind}</span>}</span><small>{u.pct}%</small></div>
          <span className="oc-bar"><i style={{ width: `${u.pct}%` }} /></span></li>)}</ul>
        {modelsOf(state).some((m) => m.kind === '雲端' && m.enabled) && <p className="mg-muted">已啟用雲端模型，請確認僅限地端的工具未被指派。</p>}
      </section>
    </div>

    <section className="mg-panel">
      <div className="mg-row"><div><h2>近期事件</h2><p className="mg-muted oc-tight">平台與工具的異常、維護及回復紀錄</p></div>{events.length > 4 && <button onClick={() => setShowAll(!showAll)}>{showAll ? '收合' : '查看全部'}</button>}</div>
      {shownEvents.length === 0 ? <p className="mg-muted">尚無事件。試著在上方把工具切換為「進入維護」。</p> :
        <ul className="oc-events">{shownEvents.map((e, i) => <li key={i}><span className={`mg-status ${e.bad ? 'bad' : 'good'}`}>{e.bad ? '!' : '✓'}</span>
          <div><b>{e.text.replace(/（示範）$/, '')}</b><small>{e.sub || (e.bad ? 'Owner 已收到通知（示範）' : '已記錄於稽核紀錄')}</small></div><time>{e.time}</time></li>)}</ul>}
    </section>
    {logView && <div className="mg-overlay"><section className="mg-dialog onb-log" role="dialog" aria-modal="true" aria-label={logView.title}>
      <div className="mg-row"><h2>{logView.title}</h2><button onClick={() => setLogView(null)} aria-label="關閉日誌">×</button></div><pre>{logView.text || '（沒有日誌）'}</pre></section></div>}
    <p className="mg-muted oc-foot">示範資料：平台服務狀態、模型用量與未上架工具的操作為本機示範；已上架工具的維護、重啟、日誌與事件來自上架服務；正式版由監控、LLM Proxy 與稽核紀錄提供。</p>
  </div>;
}
