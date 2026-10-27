"use client";
import { useState } from 'react';
import { ApiError, onboardingApi, type ToolIcon } from './onboarding-api';

/** 平台內建圖示（對應 globals.css 的 .metal-symbol.symbol-0～5）與顏色；只能從這裡選，不開放上傳。 */
export const ICON_SYMBOLS = ['文件', '多份文件', '信件', '搜尋', '書本', '清單'];
export const ICON_COLORS: { id: string; name: string }[] = [
  { id: 'blue', name: '藍' }, { id: 'violet', name: '紫' }, { id: 'cyan', name: '青' }, { id: 'orange', name: '橘' }, { id: 'green', name: '綠' }, { id: 'pink', name: '粉' },
];

export function IconTile({ icon, size = 'sm' }: { icon: ToolIcon; size?: 'sm' | 'xs' }) {
  return <span className={`icon-tile ${size} tool-icon ${icon.color}`} aria-hidden="true"><i className={`metal-symbol symbol-${icon.symbol}`}></i></span>;
}

/** 發布管理 → 工具詳情 → 設定：AI Team 選擇工具圖示。改了立即生效、會留稽核紀錄，不需重新審核。 */
export function IconPicker({ toolId, icon, notice, onDone }: { toolId: string; icon: ToolIcon | null | undefined; notice: (m: string) => void; onDone?: () => void }) {
  const [sel, setSel] = useState<ToolIcon>(icon ?? { symbol: 0, color: 'blue' });
  const [busy, setBusy] = useState(false);
  const changed = !icon || icon.symbol !== sel.symbol || icon.color !== sel.color;
  const save = async () => {
    setBusy(true);
    try { await onboardingApi.setIcon(toolId, sel); notice('已更新工具圖示'); window.dispatchEvent(new Event('workhub:catalog-refresh')); onDone?.(); }
    catch (e) { notice(e instanceof ApiError ? (e.reasons[0] ?? e.message) : '上架服務未回應'); }
    finally { setBusy(false); }
  };
  return <div className="icon-picker">
    <div className="icon-picker-head"><IconTile icon={sel} /><div><b>工具圖示</b><small>{icon ? '工具中心卡片上顯示的圖示' : '尚未設定，工具中心目前顯示預設圖示'}；只能從平台內建圖示選擇，改了立即生效。</small></div></div>
    <div className="icon-picker-row" role="radiogroup" aria-label="圖示">
      {ICON_SYMBOLS.map((label, i) => <button key={label} type="button" role="radio" aria-checked={sel.symbol === i} aria-label={label} title={label} className={sel.symbol === i ? 'on' : ''} onClick={() => setSel({ ...sel, symbol: i })}><IconTile size="xs" icon={{ symbol: i, color: sel.color }} /></button>)}
    </div>
    <div className="icon-picker-row" role="radiogroup" aria-label="顏色">
      {ICON_COLORS.map((c) => <button key={c.id} type="button" role="radio" aria-checked={sel.color === c.id} aria-label={c.name} title={c.name} className={`icon-swatch tool-icon ${c.id} ${sel.color === c.id ? 'on' : ''}`} onClick={() => setSel({ ...sel, color: c.id })}><span /></button>)}
    </div>
    <div className="mg-actions"><button className="onb-primary-sm" disabled={busy || !changed} onClick={() => void save()}>{busy ? '儲存中…' : '儲存圖示'}</button></div>
  </div>;
}
