// Small unified-diff generator. Instruction files are a few hundred lines, so
// the quadratic LCS table is free and a dependency would not be.

function lcsTable(a, b) {
  const n = a.length;
  const m = b.length;
  const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  return dp;
}

/** @returns {{op:' '|'-'|'+', text:string, a:number, b:number}[]} */
export function diffLines(a, b) {
  const dp = lcsTable(a, b);
  const out = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      out.push({ op: ' ', text: a[i], a: i, b: j });
      i++; j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      out.push({ op: '-', text: a[i], a: i, b: j });
      i++;
    } else {
      out.push({ op: '+', text: b[j], a: i, b: j });
      j++;
    }
  }
  while (i < a.length) out.push({ op: '-', text: a[i], a: i++, b: j });
  while (j < b.length) out.push({ op: '+', text: b[j], a: i, b: j++ });
  return out;
}

export function unifiedDiff(oldText, newText, { fromFile = 'a', toFile = 'b', context = 3 } = {}) {
  const a = oldText.split('\n');
  const b = newText.split('\n');
  const ops = diffLines(a, b);
  if (!ops.some((o) => o.op !== ' ')) return '';

  const changed = ops.map((o) => o.op !== ' ');
  const keep = new Array(ops.length).fill(false);
  for (let i = 0; i < ops.length; i++) {
    if (!changed[i]) continue;
    for (let k = Math.max(0, i - context); k <= Math.min(ops.length - 1, i + context); k++) keep[k] = true;
  }

  const lines = [`--- ${fromFile}`, `+++ ${toFile}`];
  let i = 0;
  while (i < ops.length) {
    if (!keep[i]) { i++; continue; }
    let j = i;
    while (j < ops.length && keep[j]) j++;
    const chunk = ops.slice(i, j);
    const aStart = chunk[0].a + 1;
    const bStart = chunk[0].b + 1;
    const aCount = chunk.filter((o) => o.op !== '+').length;
    const bCount = chunk.filter((o) => o.op !== '-').length;
    lines.push(`@@ -${aStart},${aCount} +${bStart},${bCount} @@`);
    for (const o of chunk) lines.push(o.op + o.text);
    i = j;
  }
  return `${lines.join('\n')}\n`;
}
