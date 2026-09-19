import { complete } from './api.js';

/**
 * Two ways to score one output against one rule.
 *
 * Deterministic checks are preferred: they are free, exactly reproducible, and
 * cannot be talked into an answer. The judge exists because most rules people
 * actually write ("explain non-obvious decisions in a comment") have no cheap
 * regex, and a harness nobody can run on their real file measures nothing.
 *
 * Either way the grade is one of:
 *   'comply' | 'violate' | 'na'
 * `na` means the rule had no occasion to apply to this output. It is excluded
 * from the denominator — scoring it as a violation would make every rule look
 * load-bearing on tasks it never touched.
 */

export function gradeDeterministic(output, check) {
  if (check.applies) {
    const re = new RegExp(check.applies, check.flags ?? '');
    if (!re.test(output)) return { grade: 'na', reason: 'applies pattern did not match' };
  }
  const fail = (reason) => ({ grade: 'violate', reason });

  if (check.contains != null && !output.includes(check.contains)) return fail(`missing ${JSON.stringify(check.contains)}`);
  if (check.notContains != null && output.includes(check.notContains)) return fail(`contains ${JSON.stringify(check.notContains)}`);
  if (check.regex != null && !new RegExp(check.regex, check.flags ?? '').test(output)) return fail(`did not match /${check.regex}/`);
  if (check.notRegex != null && new RegExp(check.notRegex, check.flags ?? '').test(output)) return fail(`matched /${check.notRegex}/`);
  return { grade: 'comply', reason: '' };
}

const JUDGE_SYSTEM = `You grade whether a piece of model output complies with a single written rule.

You will be shown one RULE and one OUTPUT. Reply with exactly one word on the first line:

COMPLY  - the output had an occasion to follow the rule and followed it
VIOLATE - the output had an occasion to follow the rule and did not
NA      - the rule had no occasion to apply to this output at all

Then, on a second line, give a reason of at most 15 words.

Judge only the rule you are given. Do not reward or punish anything else about
the output: not its quality, not its style, not other rules it may break.`;

/**
 * Blind judge: it never learns which arm produced the output, or that an
 * ablation is running at all. If it did, the measurement would be worthless.
 */
export async function gradeWithJudge(output, ruleText, { apiKey, model, effort }) {
  const prompt = `RULE:\n${ruleText}\n\nOUTPUT:\n<<<\n${output}\n>>>`;
  const res = await complete({
    apiKey, model, system: JUDGE_SYSTEM, prompt, maxTokens: 200, effort,
  });
  const lines = res.text.trim().split('\n');
  const head = (lines[0] ?? '').trim().toUpperCase();
  const reason = (lines[1] ?? '').trim();
  const grade = head.startsWith('COMPLY') ? 'comply'
    : head.startsWith('VIOLATE') ? 'violate'
      : head.startsWith('NA') ? 'na'
        : 'na';
  return { grade, reason: grade === 'na' && !head.startsWith('NA') ? `unparsed judge reply: ${head.slice(0, 40)}` : reason, usage: res.usage };
}

export async function grade(output, rule, opts) {
  if (rule.check) return { ...gradeDeterministic(output, rule.check), judged: false };
  const r = await gradeWithJudge(output, rule.text, opts);
  return { ...r, judged: true };
}
