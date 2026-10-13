"use client";

export type ToolEntryConfig = { id: string; url?: string };

/** Only explicit absolute HTTP(S) URLs are valid external tool entries. */
export function resolveToolUrl(value?: string): string | null {
  if (!value?.trim()) return null;
  try {
    const url = new URL(value.trim());
    return ["https:", "http:"].includes(url.protocol) && !url.username && !url.password ? url.href : null;
  } catch {
    return null;
  }
}

export function ToolEntry({ tool, onOpenInternal, onEntry }: { tool: ToolEntryConfig; onOpenInternal: () => void; onEntry?: () => void }) {
  const url = resolveToolUrl(tool.url);
  if (url) return <a className="tool-entry-link" href={url} onClick={onEntry} target="_blank" rel="noopener noreferrer">開啟工具 <span>↗</span></a>;
  if (tool.id === "vision" || tool.url !== undefined) return <button disabled title="尚未設定有效的工具網址">待設定入口</button>;
  return <button onClick={() => { onEntry?.(); onOpenInternal(); }}>開啟工具 <span>→</span></button>;
}
