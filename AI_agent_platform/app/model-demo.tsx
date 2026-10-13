"use client";
/**
 * 模型選擇（示範）：給客戶確認畫面與規則用。
 * 正式版由 LLM Proxy 提供模型清單並實際切換；這裡的設定只存在本機瀏覽器，不呼叫模型、不收集金鑰。
 * 規則：勾選「僅限地端」的工具不能選雲端模型；換模型需填原因並留紀錄；停用的模型不能指派；使用中的模型不能停用。
 */
import { useState } from 'react';
import { modelKind, modelsOf, normalizeModel, type DemoConfig, type DemoModel, type DemoState, type DemoTool } from './demo-management';

type Change = (fn: (s: DemoState) => DemoState) => void;
const now = () => new Date().toLocaleString('zh-TW');
const audit = (s: DemoState, msg: string): DemoState => ({ ...s, audit: [`${now()}｜${msg}（示範）`, ...s.audit].slice(0, 200) });
/** 新增模型的示範選項（正式版由 LLM Proxy 提供可用清單） */
const EXAMPLES: Record<DemoModel['kind'], { models: string[]; providers: string[] }> = {
  地端: { models: ['Qwen3.8 27B Vision', 'Gemma 3 27B', 'Llama 3.3 70B'], providers: ['Wisely 5090（經 LLM Proxy）', '客戶自建 GPU 主機（經 LLM Proxy）'] },
  雲端: { models: ['GPT 系列', 'Claude 系列', 'Gemini 系列'], providers: ['Azure OpenAI', 'AWS Bedrock', 'Google Vertex AI'] },
};
const KindBadge = ({ kind }: { kind?: DemoModel['kind'] }) => kind ? <span className={`mg-status ${kind === '地端' ? 'good' : 'warn'}`}>{kind}</span> : null;

export function ModelCatalogDemo({ state, tools, change, notice }: { state: DemoState; tools: DemoTool[]; change: Change; notice: (m: string) => void }) {
  const models = modelsOf(state);
  const [form, setForm] = useState({ name: '', kind: '地端' as DemoModel['kind'], provider: '' });
  const usedBy = (name: string) => tools.filter((t) => t.type === 'AI' && normalizeModel(state.configs[t.id]?.model ?? '') === name);
  const fullName = `${form.kind}｜${form.name.trim()}`;
  const save = (next: DemoModel[], msg: string) => change((s) => audit({ ...s, models: next }, msg));
  return <section className="mg-panel md-panel">
    <div className="mg-row"><div><h2>模型端點</h2><p className="mg-muted">管理者維護可指派給工具的模型。工具一律經由 LLM Proxy 呼叫模型，換模型不需修改工具或重新上架。</p></div><span className="mg-status">示範</span></div>
    <p className="md-banner">示範畫面：正式版由 LLM Proxy 提供模型清單並實際切換；此處設定只存在本機瀏覽器，不會呼叫模型，也不收集任何金鑰。</p>
    <div className="mg-table-scroll"><table><thead><tr><th>模型</th><th>類型</th><th>提供者</th><th>說明</th><th>使用中工具</th><th>狀態</th></tr></thead><tbody>
      {models.map((m, i) => {
        const used = usedBy(m.name);
        return <tr key={m.name}><td><b>{m.name.split('｜').slice(1).join('｜') || m.name}</b></td><td><KindBadge kind={m.kind} /></td><td>{m.provider}</td><td className="onb-wrap">{m.note}</td>
          <td>{used.length ? used.map((t) => t.name).join('、') : '—'}</td>
          <td><button className={m.enabled ? undefined : 'onb-primary-sm'} onClick={() => {
            if (m.enabled && used.length) return notice(`還有 ${used.length} 個工具使用此模型，請先改用其他模型再停用`);
            save(models.map((x, j) => j === i ? { ...x, enabled: !x.enabled } : x), `${m.enabled ? '停用' : '啟用'}模型：${m.name}`);
          }}>{m.enabled ? '停用' : '啟用'}</button></td></tr>;
      })}
    </tbody></table></div>
    <h3>新增模型</h3>
    <div className="md-add">
      <label>類型<select value={form.kind} onChange={(e) => setForm({ name: '', provider: '', kind: e.target.value as DemoModel['kind'] })}><option>地端</option><option>雲端</option></select></label>
      <label>模型<select value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })}>
        <option value="">請選擇</option>
        {EXAMPLES[form.kind].models.map((n) => { const added = models.some((m) => m.name === `${form.kind}｜${n}`); return <option key={n} value={n} disabled={added}>{n}{added ? '（已新增）' : ''}</option>; })}
      </select></label>
      <label>提供者<select value={form.provider} onChange={(e) => setForm({ ...form, provider: e.target.value })}>
        <option value="">請選擇</option>
        {EXAMPLES[form.kind].providers.map((p) => <option key={p} value={p}>{p}</option>)}
      </select></label>
      <button className="onb-primary-sm" disabled={!form.name.trim() || !form.provider.trim() || models.some((m) => m.name === fullName)} onClick={() => {
        save([...models, { name: fullName, kind: form.kind, provider: form.provider.trim(), note: form.kind === '雲端' ? '資料政策、契約與金鑰管理待客戶核准' : '', enabled: form.kind === '地端' }], `新增模型：${fullName}`);
        setForm({ name: '', kind: '地端', provider: '' });
      }}>新增</button>
    </div>
    {form.kind === '雲端' && <p className="mg-muted">雲端模型新增後預設停用；客戶核准資料政策與契約後才啟用。勾選「僅限地端」的工具永遠不能指派雲端模型。</p>}
  </section>;
}

export function ToolModelDemo({ tool, config, state, change, notice }: { tool: DemoTool; config: DemoConfig; state: DemoState; change: Change; notice: (m: string) => void }) {
  const models = modelsOf(state);
  const current = normalizeModel(config.model);
  const kind = modelKind(state, current);
  const [target, setTarget] = useState('');
  const [reason, setReason] = useState('');
  const history = (state.modelHistory ?? []).filter((h) => h.tool === tool.id).slice(0, 5);
  const patchCfg = (s: DemoState, values: Partial<DemoConfig>) => ({ ...s, configs: { ...s.configs, [tool.id]: { ...config, ...values } } });
  const apply = () => {
    const m = models.find((x) => x.name === target);
    if (!m) return;
    if (config.localOnly && m.kind === '雲端') return notice('此工具僅限地端，不能指派雲端模型');
    change((s) => audit({ ...patchCfg(s, { model: m.name }), modelHistory: [{ tool: tool.id, from: current, to: m.name, reason: reason.trim(), actor: '平台管理員', time: now() }, ...(s.modelHistory ?? [])].slice(0, 200) },
      `${tool.name}：模型 ${current} → ${m.name}（${reason.trim()}）`));
    notice(`已將 ${tool.name} 改用 ${m.name}（示範）`);
    setTarget(''); setReason('');
  };
  return <div className="md-tool">
    <div className="mg-row"><h3>模型</h3><span className="mg-status">示範</span></div>
    <p><b>目前使用：</b>{current} <KindBadge kind={kind} /></p>
    {config.localOnly && kind === '雲端' && <p className="onb-error">此工具僅限地端，但目前指派的是雲端模型，請改成地端模型。</p>}
    <label className="mg-check"><input type="checkbox" checked={config.localOnly} disabled={tool.id === 'vision'} onChange={(e) => {
      if (e.target.checked && kind === '雲端') return notice('目前使用雲端模型，請先改成地端模型再勾選僅限地端');
      change((s) => audit(patchCfg(s, { localOnly: e.target.checked }), `${tool.name}：${e.target.checked ? '設為僅限地端' : '取消僅限地端'}`));
    }} />僅限地端（工具處理的資料不得送往雲端模型）</label>
    <div className="md-switch">
      <label>改用模型<select value={target} onChange={(e) => setTarget(e.target.value)}>
        <option value="">請選擇</option>
        {models.filter((m) => m.name !== current).map((m) => {
          const blocked = !m.enabled ? '已停用' : config.localOnly && m.kind === '雲端' ? '僅限地端，不可選' : '';
          return <option key={m.name} value={m.name} disabled={!!blocked}>{m.name}{blocked ? `（${blocked}）` : ''}</option>;
        })}
      </select></label>
      <label>原因<input value={reason} placeholder="例如：新模型讀圖較準確" onChange={(e) => setReason(e.target.value)} /></label>
      <button className="onb-primary-sm" disabled={!target || !reason.trim()} onClick={apply}>套用</button>
    </div>
    <p className="mg-muted">生效方式：由 LLM Proxy 把這個工具的模型請求轉到新模型，立即生效，不需重新上架或重啟工具（示範，尚未串接）。</p>
    {history.length > 0 && <><h4>變更紀錄</h4><ul className="md-history">{history.map((h, i) => <li key={i}><span>{h.time}</span> {h.actor}：{h.from} → <b>{h.to}</b>（{h.reason}）</li>)}</ul></>}
  </div>;
}
