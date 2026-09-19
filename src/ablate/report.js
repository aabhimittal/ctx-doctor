import { makeStyle } from '../report.js';
import { trialsNeeded } from './stats.js';
import { MODELS } from '../models.js';

const VERDICT = {
  'carries-weight': { label: 'carries weight', tone: 'green' },
  harmful: { label: 'BACKFIRES', tone: 'red' },
  'no-effect': { label: 'no measurable effect', tone: 'yellow' },
  inconclusive: { label: 'inconclusive', tone: 'gray' },
};

export function formatAblation(run, { color = true } = {}) {
  const s = makeStyle(color);
  const out = [];
  const spent = costOf(run);

  out.push('');
  const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
  out.push(`${s.bold('ablation')}  ${plural(run.plan.rules.length, 'rule')} × ${plural(run.plan.tasks.length, 'task')} × ${run.trials} trials/arm`);
  out.push(s.gray(`  model ${run.model} · judge ${run.judgeModel} · ${run.usage.calls} calls · ${fmt(run.usage.input)} in / ${fmt(run.usage.output)} out tokens · $${spent.toFixed(2)} spent`));
  if (run.usage.errors) out.push(s.yellow(`  ${run.usage.errors} calls failed and were dropped`));
  out.push('');

  const width = Math.min(38, Math.max(12, ...run.results.map((r) => r.id.length)));
  out.push(s.gray(`  ${'rule'.padEnd(width)}  ${'with'.padStart(7)}  ${'without'.padStart(7)}  ${'delta'.padStart(14)}  verdict`));

  for (const r of run.results) {
    const v = VERDICT[r.verdict];
    const tone = s[v.tone] ?? s.gray;
    const delta = `${r.diff.delta >= 0 ? '+' : ''}${r.diff.delta.toFixed(2)} ±${r.diff.half.toFixed(2)}`;
    out.push(`  ${r.id.slice(0, width).padEnd(width)}  ${rate(r.with).padStart(7)}  ${rate(r.without).padStart(7)}  ${delta.padStart(14)}  ${tone(v.label)}`);
  }

  out.push('');
  const carrying = run.results.filter((r) => r.verdict === 'carries-weight').length;
  const dead = run.results.filter((r) => r.verdict === 'no-effect');
  const unsure = run.results.filter((r) => r.verdict === 'inconclusive');
  const backfiring = run.results.filter((r) => r.verdict === 'harmful');

  out.push(`  ${carrying} of ${run.results.length} rules measurably changed compliance.`);
  if (backfiring.length) {
    out.push(s.red(`  ${backfiring.length} scored WORSE with the rule present: ${backfiring.map((r) => r.id).join(', ')}`));
    out.push(s.gray('    A rule that lowers its own compliance rate is usually competing with a nearby rule, or is so long it pushes the task out of focus.'));
  }
  if (dead.length) {
    out.push(`  ${s.yellow(`${dead.length} had no measurable effect`)} ${s.gray(`at ±0.15 — deleting them is free: ${dead.map((r) => r.id).join(', ')}`)}`);
  }
  if (unsure.length) {
    out.push(s.gray(`  ${unsure.length} inconclusive: too few trials to separate from zero. Re-run with --trials ${trialsNeeded(0.3)} or more.`));
  }

  out.push('');
  out.push(s.dim('  Each arm deletes exactly one rule, so a delta is attributable to that rule alone.'));
  out.push(s.dim('  Rules that only work in combination will not show up; neither will effects on output'));
  out.push(s.dim('  quality, which this measures nothing about — only compliance with the rule itself.'));
  if (run.results.some((r) => r.judged)) {
    out.push(s.dim('  Judged rules were graded by a separate model shown only the rule and the output,'));
    out.push(s.dim('  never which arm produced it. Deterministic `check`s in the task file avoid it entirely.'));
  }
  return out.join('\n');
}

/** The one line that fits in a post. */
export function ablationHeadline(run) {
  const dead = run.results.filter((r) => r.verdict === 'no-effect').length;
  const carrying = run.results.filter((r) => r.verdict === 'carries-weight').length;
  return `${run.results.length} rules measured: ${carrying} changed the model's behaviour, ${dead} did nothing at all (${run.trials} trials/arm, ${run.model}).`;
}

function rate(arm) {
  return arm.n ? `${arm.comply}/${arm.n}` : '—';
}

function costOf(run) {
  const m = MODELS[run.model] ?? { input: 0, output: 0 };
  return (run.usage.input / 1e6) * m.input + (run.usage.output / 1e6) * m.output;
}

function fmt(n) {
  return Math.round(n).toLocaleString('en-US');
}
