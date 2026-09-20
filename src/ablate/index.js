import { complete, pool, requireApiKey } from './api.js';
import { grade } from './grade.js';
import { buildPlan, estimatePlan } from './plan.js';
import { wilson, diffProportions, verdict, trialsNeeded, twoProportionP, holm } from './stats.js';
import { MODELS, DEFAULT_MODEL, DEFAULT_JUDGE_MODEL } from '../models.js';

export { buildPlan, estimatePlan, trialsNeeded };

/**
 * Appended to every task prompt so answers are comparable. It is itself an
 * instruction, so it competes with any rule about explaining or commenting —
 * override it with `suffix` in the task file, or `--no-suffix`, when a rule
 * under test is about verbosity.
 */
export const DEFAULT_TASK_SUFFIX = '\n\nReply with the code or answer only. Do not explain what you did.';

/**
 * Run the ablation.
 *
 * For each rule: N trials of every task with the intact instruction file, N
 * trials with that one rule deleted, graded against that rule alone. The
 * comparison is between two arms that differ by exactly one block, which is
 * what makes the delta attributable.
 */
export async function runAblation({
  source, spec, trials = 8, model = DEFAULT_MODEL, judgeModel = DEFAULT_JUDGE_MODEL,
  concurrency = 4, maxTokens = 1024, apiKey = null, onProgress = () => {},
  suffix = spec.suffix ?? DEFAULT_TASK_SUFFIX,
}) {
  const key = apiKey ?? requireApiKey();
  const plan = buildPlan({ source, spec, trials });
  const armById = new Map(plan.arms.map((a) => [a.id, a]));
  const taskById = new Map(plan.tasks.map((t) => [t.id, t]));
  const ruleById = new Map(plan.rules.map((r) => [r.id, r]));

  const usage = { input: 0, output: 0, calls: 0, errors: 0 };
  let done = 0;

  // Phase 1: generate. Every cell is produced once and graded against whichever
  // rule that arm is testing; the `full` arm is graded against every rule, so
  // one intact-file run serves as the control for all of them.
  const outputs = await pool(plan.cells, concurrency, async (cell) => {
    const arm = armById.get(cell.armId);
    const task = taskById.get(cell.taskId);
    try {
      const res = await complete({
        apiKey: key,
        model,
        system: arm.system,
        prompt: task.prompt + suffix,
        maxTokens,
        effort: MODELS[model]?.effort ? 'low' : undefined,
      });
      usage.input += res.usage.input_tokens ?? 0;
      usage.output += res.usage.output_tokens ?? 0;
      usage.calls++;
      return { cell, text: res.text, error: null };
    } catch (err) {
      usage.errors++;
      return { cell, text: '', error: String(err.message ?? err) };
    } finally {
      onProgress({ phase: 'generate', done: ++done, total: plan.cells.length });
    }
  });

  // Phase 2: grade. Each rule needs its control arm graded too, so a `full`
  // output is graded once per rule.
  const jobs = [];
  for (const out of outputs) {
    if (out.error) continue;
    const rules = out.cell.ruleId ? [ruleById.get(out.cell.ruleId)] : plan.rules;
    for (const rule of rules) jobs.push({ out, rule });
  }

  done = 0;
  const graded = await pool(jobs, concurrency, async (job) => {
    try {
      const g = await grade(job.out.text, job.rule, {
        apiKey: key, model: judgeModel, effort: MODELS[judgeModel]?.effort ? 'low' : undefined,
      });
      if (g.usage) {
        usage.input += g.usage.input_tokens ?? 0;
        usage.output += g.usage.output_tokens ?? 0;
        usage.calls++;
      }
      return { ...job, ...g };
    } catch (err) {
      usage.errors++;
      return { ...job, grade: 'na', reason: `grading failed: ${err.message ?? err}` };
    } finally {
      onProgress({ phase: 'grade', done: ++done, total: jobs.length });
    }
  });

  return {
    plan,
    usage,
    model,
    judgeModel,
    trials,
    suffix,
    results: aggregate(plan, graded),
    failures: outputs.filter((o) => o.error).map((o) => ({ ...o.cell, error: o.error })),
  };
}

function aggregate(plan, graded) {
  const rows = [];
  for (const rule of plan.rules) {
    const mine = graded.filter((g) => g.rule.id === rule.id);
    const withArm = tally(mine.filter((g) => g.out.cell.armId === 'full'));
    const withoutArm = tally(mine.filter((g) => g.out.cell.armId === `without:${rule.id}`));
    const diff = diffProportions(withArm.comply, withArm.n, withoutArm.comply, withoutArm.n);
    rows.push({
      id: rule.id,
      text: rule.text,
      judged: mine.some((g) => g.judged),
      with: { ...withArm, ...wilson(withArm.comply, withArm.n) },
      without: { ...withoutArm, ...wilson(withoutArm.comply, withoutArm.n) },
      diff,
    });
  }

  // Every rule was tested against the same control arm, so this is a family of
  // n tests, not n independent ones. Correct for that before calling anything
  // significant.
  const adjusted = holm(rows.map((r) => twoProportionP(r.with.comply, r.with.n, r.without.comply, r.without.n)));
  rows.forEach((row, i) => {
    row.p = adjusted[i].p;
    row.adjustedP = adjusted[i].adjusted;
    row.verdict = verdict(row.diff, { significant: adjusted[i].significant });
  });

  // Loudest signal first, then the ones that measurably do nothing.
  const order = { harmful: 0, 'carries-weight': 1, inconclusive: 2, 'no-effect': 3 };
  rows.sort((a, b) => order[a.verdict] - order[b.verdict] || Math.abs(b.diff.delta) - Math.abs(a.diff.delta));
  return rows;
}

function tally(entries) {
  const comply = entries.filter((e) => e.grade === 'comply').length;
  const violate = entries.filter((e) => e.grade === 'violate').length;
  const na = entries.filter((e) => e.grade === 'na').length;
  return { comply, violate, na, n: comply + violate };
}
