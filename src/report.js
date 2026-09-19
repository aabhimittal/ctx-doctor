const CODES = {
  reset: '\u001b[0m', bold: '\u001b[1m', dim: '\u001b[2m',
  red: '\u001b[31m', yellow: '\u001b[33m', blue: '\u001b[34m',
  green: '\u001b[32m', cyan: '\u001b[36m', gray: '\u001b[90m',
};

export function makeStyle(enabled) {
  const wrap = (code) => (s) => (enabled ? `${code}${s}${CODES.reset}` : String(s));
  return {
    bold: wrap(CODES.bold), dim: wrap(CODES.dim), red: wrap(CODES.red),
    yellow: wrap(CODES.yellow), blue: wrap(CODES.blue), green: wrap(CODES.green),
    cyan: wrap(CODES.cyan), gray: wrap(CODES.gray),
  };
}

const LABEL = { error: 'error', warn: ' warn', info: ' info' };

export function formatResult(result, { color = true, verbose = false } = {}) {
  const s = makeStyle(color);
  const b = result.budget;
  const out = [];
  const over = b.tokens > b.budget;

  out.push('');
  out.push(`${s.bold(result.file)}  ${over ? s.yellow(`~${fmt(b.tokens)} tokens`) : s.green(`~${fmt(b.tokens)} tokens`)} ${s.gray(`· ${fmtBytes(b.bytes)} · budget ${fmt(b.budget)}`)}`);
  out.push(s.gray(`  cost  $${b.costPerTurn.toFixed(4)}/turn · $${b.costPerSession.toFixed(3)}/session (${b.turns} turns, ${b.modelLabel}) · $${b.costPerSessionCached.toFixed(3)} if cached`));

  if (!result.findings.length) {
    out.push(`  ${s.green('✓')} no findings`);
    return out.join('\n');
  }
  out.push('');

  for (const f of result.findings) {
    const tone = f.severity === 'error' ? s.red : f.severity === 'warn' ? s.yellow : s.blue;
    out.push(`  ${tone(LABEL[f.severity])} ${s.gray(`${result.file}:${f.line}`)}  ${s.cyan(f.rule)}`);
    out.push(`        ${f.message}`);
    if (f.excerpt) out.push(s.gray(`        > ${oneLine(f.excerpt)}`));
    if (verbose) out.push(s.dim(wrapText(f.why, 8)));
  }

  out.push('');
  const pct = result.tokensBefore ? Math.round((result.tokensSaved / result.tokensBefore) * 100) : 0;
  if (result.tokensSaved > 0) {
    const savedSession = (result.tokensSaved / 1e6) * rateOf(b) * b.turns;
    out.push(`  ${s.green('minimized')} ${fmt(result.tokensBefore)} → ${fmt(result.tokensAfter)} tokens (${s.green(`-${pct}%`)}), ${result.removedLines} lines removed`);
    out.push(s.gray(`            saves ~$${savedSession.toFixed(3)} per ${b.turns}-turn session on ${b.modelLabel}`));
  } else {
    out.push(s.gray('  nothing safely removable — every finding needs a human decision'));
  }
  return out.join('\n');
}

export function formatSummary(results, { color = true } = {}) {
  const s = makeStyle(color);
  const totals = results.reduce((acc, r) => {
    acc.error += r.counts.error; acc.warn += r.counts.warn; acc.info += r.counts.info;
    acc.before += r.tokensBefore; acc.after += r.tokensAfter;
    return acc;
  }, { error: 0, warn: 0, info: 0, before: 0, after: 0 });

  const parts = [];
  if (totals.error) parts.push(s.red(`${totals.error} error`));
  if (totals.warn) parts.push(s.yellow(`${totals.warn} warn`));
  if (totals.info) parts.push(s.blue(`${totals.info} info`));
  const head = parts.length ? parts.join(' · ') : s.green('clean');

  const lines = ['', `${head}  ${s.gray(`across ${results.length} file${results.length === 1 ? '' : 's'}`)}`];
  if (totals.before > totals.after) {
    const pct = Math.round(((totals.before - totals.after) / totals.before) * 100);
    lines.push(s.gray(`${fmt(totals.before)} → ${fmt(totals.after)} tokens (-${pct}%) if minimized`));
    lines.push(s.gray('run with --diff to review, --fix to apply'));
  }
  return lines.join('\n');
}

function rateOf(budget) {
  return budget.costPerTurn && budget.tokens ? (budget.costPerTurn / budget.tokens) * 1e6 : 0;
}

function oneLine(text) {
  const t = String(text).replace(/\s+/g, ' ').trim();
  return t.length > 96 ? `${t.slice(0, 95)}…` : t;
}

function wrapText(text, indent) {
  const pad = ' '.repeat(indent);
  const words = String(text).split(/\s+/);
  const lines = [];
  let line = pad;
  for (const w of words) {
    if (line.length + w.length + 1 > 88) { lines.push(line); line = pad; }
    line += (line === pad ? '' : ' ') + w;
  }
  if (line.trim()) lines.push(line);
  return lines.join('\n');
}

function fmt(n) {
  return n.toLocaleString('en-US');
}

function fmtBytes(n) {
  return n < 1024 ? `${n} B` : `${(n / 1024).toFixed(1)} KB`;
}
