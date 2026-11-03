'use client';
/**
 * 原始碼自動打包（2026/11/03）：開發者上傳原始碼 → 平台分析、產生 Dockerfile／workhub.yaml、地端模型修正、
 * 斷網業務測試 → 打包報告 → 開發者確認後直接進一般上架流程。
 * 看不懂的地方才暫停發問；做不到的類型或超過 60 分鐘轉給 AI Team。
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ApiError, onboardingApi, type Autopack } from './onboarding-api';
import type { Role } from './role';

const STATUS: Record<Autopack['status'], [string, string]> = {
  queued: ['排隊中', 'warn'], running: ['打包中', 'warn'], awaiting_answer: ['等你回答', 'warn'], awaiting_review: ['等你確認報告', 'warn'],
  submitted: ['已送出上架', 'ok'], handed_off: ['已轉給 AI Team', 'bad'], cancelled: ['已取消', ''], failed: ['失敗', 'bad'],
};
const STEP_ICON: Record<string, string> = { passed: '✓', failed: '✕', skipped: '－', running: '…', waiting: '？' };
const LIVE: Autopack['status'][] = ['queued', 'running'];

type Props = { role: Role; developer: string; notice: (m: string) => void; onSubmitted: (submissionId: string) => void };

export function AutopackPanel({ role, developer, notice, onSubmitted }: Props) {
  const [items, setItems] = useState<Autopack[]>([]);
  const [openId, setOpenId] = useState('');
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    try { setItems(await onboardingApi.autopacks()); } catch { /* 上架服務離線時由外層顯示 */ }
  }, []);
  useEffect(() => {
    let alive = true;
    void onboardingApi.autopacks().then((x) => { if (alive) setItems(x); }).catch(() => {});
    const h = () => { void refresh(); };
    window.addEventListener('workhub:autopack', h);
    return () => { alive = false; window.removeEventListener('workhub:autopack', h); };
  }, [refresh]);

  // 開發者只看自己當 Owner 的；AI Team 看全部（轉給 AI Team 的排最前面）
  const visible = useMemo(() => {
    const v = role === 'aiteam' ? items : items.filter((x) => x.owner === developer || x.actor === developer);
    return role === 'aiteam' ? [...v].sort((a, b) => Number(b.status === 'handed_off') - Number(a.status === 'handed_off')) : v;
  }, [items, role, developer]);
  const open = visible.find((x) => x.id === openId) ?? visible.find((x) => !['submitted', 'cancelled'].includes(x.status));

  const live = items.some((x) => LIVE.includes(x.status));
  useEffect(() => {
    if (!live) return;
    const t = setInterval(() => { void refresh(); }, 3000);
    return () => clearInterval(t);
  }, [live, refresh]);

  const act = async (fn: () => Promise<unknown>, ok: string) => {
    setBusy(true);
    try { await fn(); notice(ok); await refresh(); } catch (e) { notice(e instanceof ApiError ? e.message : '上架服務沒有回應'); } finally { setBusy(false); }
  };

  if (visible.length === 0) return null;
  return <section className="mg-panel ap" aria-label="自動打包">
    <div className="mg-row"><div><h2>自動打包</h2><p className="mg-muted">上傳專案 ZIP 後由平台打包；需要你決定的事會在這裡發問，完成後請看報告並確認送出。</p></div><button onClick={() => void refresh()} disabled={busy}>重新整理</button></div>
    <div className="ap-list">{visible.map((x) => <button key={x.id} className={`mg-submission ${open?.id === x.id ? 'current' : ''}`} onClick={() => { setOpenId(x.id); setAnswers({}); }}>
      <span><b>{x.name ?? x.toolId ?? x.filename}</b><small>{x.mode === 'update' ? '版本更新' : '第一次上架'} · {x.filename} · {x.owner} · {new Date(x.createdAt).toLocaleString('zh-TW')}</small></span>
      <span className={`mg-status ${STATUS[x.status][1]}`}>{STATUS[x.status][0]}</span>
    </button>)}</div>
    {open && <AutopackDetail key={open.id} ap={open} role={role} busy={busy} answers={answers} setAnswers={setAnswers}
      onAnswer={() => void act(() => onboardingApi.answerAutopack(open.id, answers).then(() => setAnswers({})), '已送出回答，繼續打包')}
      onConfirm={() => void act(async () => { const r = await onboardingApi.confirmAutopack(open.id); onSubmitted(r.submission.id); }, '已確認報告，進入上架流程（建置、漏洞檢查、測試）')}
      onCancel={() => { if (window.confirm('確定取消這次自動打包？上傳的原始碼與測試資料會一併刪除。')) void act(() => onboardingApi.cancelAutopack(open.id), '已取消自動打包'); }} />}
  </section>;
}

function AutopackDetail({ ap, role, busy, answers, setAnswers, onAnswer, onConfirm, onCancel }: {
  ap: Autopack; role: Props['role']; busy: boolean; answers: Record<string, string>; setAnswers: (a: Record<string, string>) => void;
  onAnswer: () => void; onConfirm: () => void; onCancel: () => void;
}) {
  const r = ap.report;
  const canCancel = ['queued', 'running', 'awaiting_answer', 'awaiting_review'].includes(ap.status);
  return <div className="ap-detail">
    <ol className="ap-steps">{ap.steps.map((s, i) => <li key={i} className={`ap-step ${s.status}`}><span aria-hidden>{STEP_ICON[s.status] ?? '·'}</span><b>{s.name}</b>{s.detail && <small>{s.detail}</small>}</li>)}
      {LIVE.includes(ap.status) && <li className="ap-step running"><span aria-hidden>…</span><b>{ap.status === 'queued' ? '排隊中，前面還有其他打包' : '處理中'}</b><small>已用 {ap.activeMinutes} 分鐘（上限 60 分鐘，等你回答的時間不算）</small></li>}
    </ol>

    {ap.status === 'awaiting_answer' && ap.questions.length > 0 && <form className="ap-questions" onSubmit={(e) => { e.preventDefault(); onAnswer(); }}>
      <h3>平台看不出來，需要你決定（{ap.questions.length} 題）</h3>
      {ap.questions.map((q) => <fieldset key={q.id} className="ap-q">
        <legend>{q.title}</legend>
        <p>{q.detail}</p>
        {q.refs.length > 0 && <ul className="ap-refs">{q.refs.map((x, i) => <li key={i}><code>{x.file}{x.line ? `:${x.line}` : ''}</code> {x.detail}</li>)}</ul>}
        {q.options.map((o) => <label key={o.value} className="onb-check"><input type="radio" name={q.id} checked={answers[q.id] === o.value} onChange={() => setAnswers({ ...answers, [q.id]: o.value })} />{o.label}</label>)}
      </fieldset>)}
      <div className="mg-actions"><button className="onb-primary-sm" disabled={busy || ap.questions.some((q) => !answers[q.id])}>送出回答，繼續打包</button></div>
    </form>}

    {ap.status === 'handed_off' && ap.handoff && <div className="onb-error ap-handoff">
      <b>已轉給 AI Team：{ap.handoff.reason}</b>
      {ap.handoff.detail && <pre className="ap-handoff-detail">{ap.handoff.detail}</pre>}
      <p>{role === 'aiteam' ? '請下載打包紀錄與目前的打包結果，協助開發者完成上架。' : 'AI Team 會和你聯絡，不需要重新上傳。'}</p>
      {role === 'aiteam' && <p className="ap-downloads"><a className="ap-dl" href={`/api/onboarding/autopack/${ap.id}/log`} download><span aria-hidden>⬇</span>下載打包紀錄<small>.txt：每一步的結果、建置與測試輸出、模型改了什麼</small></a><a className="ap-dl" href={`/api/onboarding/autopack/${ap.id}/files.zip`} download><span aria-hidden>⬇</span>下載目前的打包結果<small>.zip：平台做好的專案（含 Dockerfile、workhub.yaml），不含測試資料</small></a></p>}
    </div>}
    {ap.status === 'failed' && <p className="onb-error">打包失敗：{ap.error}</p>}

    {r && <div className="ap-report">
      <h3>打包報告</h3>
      <table className="ap-summary"><tbody>{Object.entries(r.summary).map(([k, v]) => <tr key={k}><th>{k}</th><td>{v}</td></tr>)}</tbody></table>

      <h4>平台的判斷</h4>
      <ul>
        <li>會保存的資料：{r.decisions.keep.join('、') || '無'}</li>
        <li>暫存、不保存：{r.decisions.temp.join('、') || '無'}</li>
        {r.decisions.fixed.length > 0 && <li>已修正：{r.decisions.fixed.join('；')}</li>}
        {r.decisions.seeds.length > 0 && <li>隨程式附帶、第一次啟動複製到資料目錄：{r.decisions.seeds.join('、')}</li>}
        {r.decisions.schemaChanges.length > 0 && <li>和上一版相比：{r.decisions.schemaChanges.join('；')}</li>}
        <li>AI：{r.decisions.ai}</li>
        <li>對外連線：{r.decisions.network}</li>
      </ul>

      <h4>驗證結果</h4>
      <ul>
        <li>docker 建置：{r.verification.build}</li>
        <li>業務測試（不連網）：{r.verification.test}</li>
        <li>健康檢查：{r.verification.health}</li>
        <li>預檢：{r.verification.preflight}</li>
      </ul>

      <h4>改了什麼（{r.changes.length} 個檔案）</h4>
      <div className="ap-changes">{r.changes.map((c) => <details key={c.path}>
        <summary><code>{c.path}</code> <span className={`ap-by ${c.by}`}>{c.by === 'model' ? '地端模型修改' : '平台範本'}</span> {c.kind === 'added' ? '新增' : <>修改 <span className="ap-add">+{c.add}</span> <span className="ap-del">−{c.del}</span></>}</summary>
        <pre className="ap-diff">{c.diff.split('\n').map((l, i) => <span key={i} className={l.startsWith('+') ? 'ap-add' : l.startsWith('-') ? 'ap-del' : ''}>{l}{'\n'}</span>)}</pre>
      </details>)}</div>
      {r.model.rejected.length > 0 && <p className="mg-muted">地端模型有 {r.model.rejected.length} 項修改不符規則，平台沒有採用：{r.model.rejected.join('；')}</p>}

      <h4>測試資料（{r.testData.length} 個檔案）</h4>
      <p className="mg-muted">不放進工具，業務測試時才唯讀掛上；工具切到「公開中」後刪除，審核履歷只留檔名與檢查碼。版本更新時請重新附上。</p>
      {r.testData.length > 0 && <details><summary>檔案清單</summary><ul>{r.testData.map((f) => <li key={f.path}><code>{f.path}</code>（{(f.size / 1024).toFixed(1)} KB）</li>)}</ul></details>}

      {r.excluded.length > 0 && <><h4>沒有放進工具的檔案（{r.excluded.length}）</h4>
        <details><summary>檔案清單</summary><ul>{r.excluded.map((x) => <li key={x.path}><code>{x.path}</code>：{x.why}</li>)}</ul></details></>}

      {r.warnings.length > 0 && <><h4>提醒</h4><ul>{r.warnings.map((w, i) => <li key={i}>{w}</li>)}</ul></>}

      {ap.status === 'awaiting_review' && <div className="onb-note ap-confirm">
        <b>請確認以下事項後送出：</b>
        <ul>{r.confirm.map((c, i) => <li key={i}>{c}</li>)}</ul>
        <small>送出後直接進入一般上架流程：建置、漏洞檢查、程式碼檢查、預覽與確認測試結果，再由 AI Team 審核。</small>
      </div>}
      {ap.status === 'submitted' && <p className="onb-note">已送出上架（{ap.version}），請在下方「我的提交」繼續後面的步驟。</p>}
    </div>}

    <div className="mg-actions">
      {ap.status === 'awaiting_review' && <button className="onb-primary-sm" disabled={busy} onClick={onConfirm}>確認報告並送出上架</button>}
      {canCancel && <button type="button" disabled={busy} onClick={onCancel}>取消打包</button>}
    </div>
  </div>;
}
