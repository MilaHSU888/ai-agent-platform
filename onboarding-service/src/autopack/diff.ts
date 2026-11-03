/** 打包報告的改動對照：逐行比對（LCS），輸出類似 unified diff 的文字，前後保留 3 行。 */
export function lineDiff(before: string, after: string, context = 3): { text: string; add: number; del: number } {
  const a = before.split('\n');
  const b = after.split('\n');
  if (a.length * b.length > 4_000_000) {
    return { text: `（檔案太大，只列統計：原本 ${a.length} 行，修改後 ${b.length} 行）`, add: Math.max(0, b.length - a.length), del: Math.max(0, a.length - b.length) };
  }
  // LCS 表（只存長度）
  const n = a.length, m = b.length;
  const dp: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const ops: { t: ' ' | '-' | '+'; s: string; ai: number; bi: number }[] = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { ops.push({ t: ' ', s: a[i], ai: i, bi: j }); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { ops.push({ t: '-', s: a[i], ai: i, bi: j }); i++; }
    else { ops.push({ t: '+', s: b[j], ai: i, bi: j }); j++; }
  }
  while (i < n) { ops.push({ t: '-', s: a[i], ai: i, bi: j }); i++; }
  while (j < m) { ops.push({ t: '+', s: b[j], ai: i, bi: j }); j++; }
  const changed = ops.map((o, k) => (o.t !== ' ' ? k : -1)).filter((k) => k >= 0);
  if (!changed.length) return { text: '', add: 0, del: 0 };
  const keep = new Set<number>();
  for (const k of changed) for (let x = Math.max(0, k - context); x <= Math.min(ops.length - 1, k + context); x++) keep.add(x);
  const out: string[] = [];
  let prev = -2;
  for (let k = 0; k < ops.length; k++) {
    if (!keep.has(k)) continue;
    if (k !== prev + 1) out.push(`@@ 第 ${ops[k].ai + 1} 行附近 @@`);
    out.push(`${ops[k].t} ${ops[k].s}`);
    prev = k;
  }
  return { text: out.join('\n'), add: ops.filter((o) => o.t === '+').length, del: ops.filter((o) => o.t === '-').length };
}
