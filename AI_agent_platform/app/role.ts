"use client";
import { useCallback, useEffect, useState } from 'react';

/**
 * 示範用身分（DEC-032）：本機試點沒有登入，用「目前身分」切換示範誰看得到什麼、能按哪些按鈕。
 * 任何人都能切換，所以不是安全保護；正式環境改由公司 AD 帳密登入，AI Team 名單在 WorkHub 後台設定（DEC-031），並由後端檢查。
 */
export type Role = 'employee' | 'developer' | 'aiteam';
export const ROLES: { id: Role; label: string; person: string; unit: string; avatar: string; department: string }[] = [
  { id: 'employee', label: '一般員工', person: '陳小華', unit: '一般員工', avatar: '陳', department: 'purchase' },
  { id: 'developer', label: '開發者', person: '林開發', unit: '資訊部・開發者', avatar: '林', department: 'it' },
  { id: 'aiteam', label: 'AI Team', person: '王大明', unit: '資訊部・AI Team', avatar: '王', department: 'it' },
];
const KEY = 'workhub-demo-role';
const isRole = (v: unknown): v is Role => v === 'employee' || v === 'developer' || v === 'aiteam';

export function useRole(): [Role, (r: Role) => void] {
  const [role, setRoleState] = useState<Role>('aiteam');
  useEffect(() => {
    queueMicrotask(() => { try { const v = localStorage.getItem(KEY); if (isRole(v)) setRoleState(v); } catch { /* 無法讀取時用預設身分 */ } });
    const sync = (e: Event) => { const v = (e as CustomEvent).detail; if (isRole(v)) setRoleState(v); };
    window.addEventListener('workhub:role', sync);
    return () => window.removeEventListener('workhub:role', sync);
  }, []);
  const setRole = useCallback((r: Role) => {
    setRoleState(r);
    try { localStorage.setItem(KEY, r); } catch { /* 只影響這個分頁 */ }
    window.dispatchEvent(new CustomEvent('workhub:role', { detail: r }));
  }, []);
  return [role, setRole];
}

/** 示範用：目前的開發者是誰（對應工具的 Owner）。開發者只看得到自己當 Owner 的試用工具（2026/10/27 決定）。 */
const DEV_KEY = 'workhub-demo-developer';
export function useDeveloperName(): [string, (n: string) => void] {
  const [name, setName] = useState('');
  useEffect(() => {
    queueMicrotask(() => { try { const v = localStorage.getItem(DEV_KEY); if (v) setName(v); } catch { /* 用預設 */ } });
    const sync = (e: Event) => { const v = (e as CustomEvent).detail; if (typeof v === 'string') setName(v); };
    window.addEventListener('workhub:developer', sync);
    return () => window.removeEventListener('workhub:developer', sync);
  }, []);
  const set = useCallback((n: string) => {
    setName(n);
    try { localStorage.setItem(DEV_KEY, n); } catch { /* 只影響這個分頁 */ }
    window.dispatchEvent(new CustomEvent('workhub:developer', { detail: n }));
  }, []);
  return [name, set];
}

/** 這個身分看不看得到某工具的試用內容：AI Team 全部；開發者只有自己當 Owner 的；一般員工都看不到 */
export function canSeeTrial(role: Role, developer: string, owner: string) {
  return role === 'aiteam' || (role === 'developer' && !!developer && developer === owner);
}

/** 示範用：一般員工所屬的部門（正式環境在 WorkHub 後台設定，DEC-031） */
const DEPT_KEY = 'workhub-demo-employee-department';
export function useEmployeeDepartment(): [string, (d: string) => void] {
  const [dept, setDept] = useState('purchase');
  useEffect(() => {
    queueMicrotask(() => { try { const v = localStorage.getItem(DEPT_KEY); if (v) setDept(v); } catch { /* 用預設 */ } });
  }, []);
  const set = useCallback((d: string) => { setDept(d); try { localStorage.setItem(DEPT_KEY, d); } catch { /* 只影響這個分頁 */ } }, []);
  return [dept, set];
}

/**
 * 使用權限（DEC-033，2026/10/27）：所有人都看得到全部已公開的工具，但只有該部門同仁能使用；其他部門只能看、不能申請。
 * 全公司共用工具大家都能用；AI Team 全部能用；開發者另外能用自己當 Owner 的工具。
 */
export function canUseTool(role: Role, myDepartment: string, toolDepartment: string, developer: string, owner?: string) {
  if (role === 'aiteam' || toolDepartment === 'shared' || toolDepartment === myDepartment) return true;
  return role === 'developer' && !!owner && owner === developer;
}

/** 各身分看得到的管理頁籤 */
export const VIEWS_BY_ROLE: Record<Role, string[]> = {
  employee: ['tools', 'issues'],
  developer: ['tools', 'developer', 'issues'],
  aiteam: ['tools', 'analytics', 'developer', 'releases', 'monitor', 'issues', 'categories', 'settings'],
};
