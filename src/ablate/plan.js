import { parseBlocks } from '../parse.js';
import { extractDirectives } from '../directives.js';
import { estimateTokens } from '../tokens.js';
import { dropLines } from '../minimize.js';

/**
 * Turn an instruction file plus a task set into the grid of API calls an
 * ablation needs.
 *
 * Design: one arm per rule, not one arm per combination. Measuring every
 * subset is 2^n runs; measuring each rule against the intact file is n+1 and
 * answers the question people actually have — "is this line earning its
 * tokens?" It cannot detect rules that only matter together, which the report
 * says out loud.
 */
export function buildPlan({ source, spec, trials = 8 }) {
  const blocks = parseBlocks(source);
  const rules = resolveRules(source, blocks, spec);
  const tasks = spec.tasks ?? [];
  if (!tasks.length) throw new Error('the task file has no tasks');
  if (!rules.length) throw new Error('no rules to ablate: add a `rules` array, or leave it out to ablate every bullet');

  const arms = [{ id: 'full', ruleId: null, system: source }];
  for (const rule of rules) {
    arms.push({ id: `without:${rule.id}`, ruleId: rule.id, system: dropLines(source, rule.lines) });
  }

  const cells = [];
  for (const arm of arms) {
    for (const task of tasks) {
      for (let trial = 0; trial < trials; trial++) {
        cells.push({ armId: arm.id, ruleId: arm.ruleId, taskId: task.id, trial });
      }
    }
  }
  return { blocks, rules, tasks, arms, cells, trials };
}

function resolveRules(source, blocks, spec) {
  const lines = source.split('\n');

  if (Array.isArray(spec.rules) && spec.rules.length) {
    return spec.rules.map((rule, i) => {
      const located = locate(rule, blocks, lines);
      return {
        id: rule.id ?? `rule-${i + 1}`,
        text: located.text,
        lines: located.lines,
        check: rule.check ?? null,
      };
    });
  }

  // No explicit rules: every bullet is a candidate, judged against its own text.
  return extractDirectives(blocks)
    .filter((d) => d.block.type === 'list')
    .map((d, i) => ({
      id: slug(d.text, i),
      text: d.text,
      lines: rangeOf(d.block),
      check: null,
    }));
}

function locate(rule, blocks, lines) {
  if (rule.line != null) {
    const block = blocks.find((b) => rule.line >= b.start && rule.line <= b.end);
    return block
      ? { text: block.text, lines: rangeOf(block) }
      : { text: lines[rule.line - 1] ?? '', lines: new Set([rule.line]) };
  }
  if (rule.match) {
    const block = blocks.find((b) => b.text.includes(rule.match));
    if (!block) throw new Error(`rule ${JSON.stringify(rule.id ?? rule.match)}: no block in the instruction file contains ${JSON.stringify(rule.match)}`);
    return { text: block.text, lines: rangeOf(block) };
  }
  throw new Error(`rule ${JSON.stringify(rule.id ?? '?')} needs either "match" or "line"`);
}

function rangeOf(block) {
  const set = new Set();
  for (let l = block.start; l <= block.end; l++) set.add(l);
  return set;
}

function slug(text, i) {
  const s = text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').split('-').slice(0, 4).join('-');
  return s || `rule-${i + 1}`;
}

/**
 * Tokens and dollars this plan will spend, before anyone is charged for it.
 *
 * Call arithmetic, which an earlier version got wrong in both directions:
 *   generation = (rules + 1) arms x tasks x trials
 *   grading    = 2 x judged_rules x tasks x trials
 * The factor of two is the control: each full-arm output is graded once per
 * judged rule, because one intact-file run serves as the control for all of
 * them. Deterministic `check`s cost nothing.
 */
export function estimatePlan({ plan, inputRate, outputRate, judgeInputRate, judgeOutputRate, maxTokens = 1024 }) {
  const systemBy = new Map(plan.arms.map((a) => [a.id, estimateTokens(a.system)]));
  const taskTokens = new Map(plan.tasks.map((t) => [t.id, estimateTokens(t.prompt)]));

  let input = 0;
  for (const cell of plan.cells) input += (systemBy.get(cell.armId) ?? 0) + (taskTokens.get(cell.taskId) ?? 0);

  const perAnswer = maxTokens * 0.6; // most answers come in well under the cap
  const output = plan.cells.length * perAnswer;

  const perArm = plan.tasks.length * plan.trials;
  const judgedRules = plan.rules.filter((r) => !r.check);
  const judgeCalls = 2 * judgedRules.length * perArm;
  const ruleTokens = judgedRules.reduce((sum, r) => sum + estimateTokens(r.text), 0) / (judgedRules.length || 1);
  const judgeInput = judgeCalls * (perAnswer + ruleTokens + JUDGE_SYSTEM_TOKENS);
  const judgeOutput = judgeCalls * 40;

  const cost = (input / 1e6) * inputRate
    + (output / 1e6) * outputRate
    + (judgeInput / 1e6) * judgeInputRate
    + (judgeOutput / 1e6) * judgeOutputRate;

  return {
    calls: plan.cells.length + judgeCalls,
    generateCalls: plan.cells.length,
    judgeCalls,
    input,
    output,
    judgeInput,
    judgeOutput,
    cost,
  };
}

// The judge system prompt is fixed; measured once rather than guessed.
const JUDGE_SYSTEM_TOKENS = 130;
