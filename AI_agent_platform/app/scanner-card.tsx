"use client";
/**
 * 平台設定 → 檢查工具版本（2026/11/02 客戶需求）：漏洞掃描用哪個工具、哪一版，以及本機漏洞資料庫已經幾天沒更新。
 * 正式環境不能上網，所以不查最新版、不自動更新；由 AI Team 依 SOP 手動更新。
 */
import { useCallback, useEffect, useState } from 'react';
import { onboardingApi, type ScannerStatus } from './onboarding-api';

const day = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleString('zh-TW') : '未知');

export function ScannerVersionCard() {
  const [data, setData] = useState<ScannerStatus | null>(null);
  const [state, setState] = useState<'loading' | 'offline' | 'ready'>('loading');
  const load = useCallback(async () => {
    setState('loading');
    try { setData(await onboardingApi.scanner()); setState('ready'); } catch { setState('offline'); }
  }, []);
  useEffect(() => {
    let alive = true;
    onboardingApi.scanner().then((r) => { if (alive) { setData(r); setState('ready'); } }).catch(() => { if (alive) setState('offline'); });
    return () => { alive = false; };
  }, []);
  return <section className="mg-panel">
    <div className="mg-row"><div><h2>檢查工具版本</h2><p className="mg-muted">工具上架時用來做漏洞檢查的工具。正式環境不能上網，平台不查最新版、也不自動更新；需要更新時由 AI Team 依上架 SOP「手動更新漏洞檢查工具」操作。</p></div>
      <button disabled={state === 'loading'} onClick={() => void load()}>重新整理</button></div>
    {state === 'loading' && <p className="mg-muted">讀取中…</p>}
    {state === 'offline' && <p className="mg-muted">上架服務未啟動，無法讀取檢查工具版本。</p>}
    {state === 'ready' && data && (!data.available || !data.scanner
      ? <p className="onb-error">找不到漏洞掃描器（Trivy）。在裝好之前，工具上架的漏洞檢查會顯示「未完成」。</p>
      : <div className="mg-table-scroll"><table><tbody>
        <tr><th>漏洞掃描工具</th><td>Trivy {data.scanner.version ?? '（版本未知）'}</td></tr>
        <tr><th>漏洞資料庫更新時間</th><td>{day(data.scanner.dbUpdatedAt)}{data.dbAgeDays !== null && `（已 ${data.dbAgeDays} 天沒更新）`}</td></tr>
        <tr><th>資料庫下載到本機</th><td>{day(data.scanner.dbDownloadedAt)}</td></tr>
        {data.scanner.cacheDir && <tr><th>漏洞資料庫位置</th><td><code>{data.scanner.cacheDir}/db</code>（手動更新時把新的資料庫放在這裡）</td></tr>}
        <tr><th>更新方式</th><td>{data.offline ? '手動更新：不能上網，用這台電腦裡現有的漏洞清單；需要 AI Team 定期更新' : '自動更新：每次檢查前會先下載最新的漏洞清單'}</td></tr>
        <tr><th>最近一次掃描</th><td>{day(data.lastScanAt)}</td></tr>
      </tbody></table></div>)}
  </section>;
}
