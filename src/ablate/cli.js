import fs from 'node:fs';
import path from 'node:path';

import { runAblation, buildPlan, estimatePlan, trialsNeeded, DEFAULT_TASK_SUFFIX } from './index.js';
import { complete, countTokens, requireApiKey } from './api.js';
import { estimateTokens } from '../tokens.js';
import { formatAblation, ablationHeadline } from './report.js';
import { makeStyle } from '../report.js';
import { parseBlocks } from '../parse.js';
import { extractDirectives } from '../directives.js';
import { discoverTargets } from '../index.js';
import { MODELS, DEFAULT_MODEL, DEFAULT_JUDGE_MODEL } from '../models.js';

const HELP = `ctx-doctor ablate — measure whether each rule changes the model's behaviour

  Usage
    ctx-doctor ablate [file] [options]

  Runs every task twice per rule: once with the intact instruction file, once
  with that one rule deleted. Grades each output against that rule alone and
  reports the difference with a confidence interval.

  This spends real money. The cost is printed first and nothing runs without --yes.

  Options
    --check            make ONE minimal live call to verify the wire format, then exit
    --calibrate        count this file's tokens via the API and report the
                       estimator's real error (counting is not billed)
    --init             write a starter ctx-doctor.tasks.json and exit
    --root <dir>       repository root      (default: cwd)
    --tasks <file>     task file            (default: ctx-doctor.tasks.json)
    --trials <n>       trials per arm       (default: 8; ${trialsNeeded(0.3)}+ to resolve a 0.3 effect)
    --model <id>       model under test     (default: ${DEFAULT_MODEL})
    --judge-model <id> grader               (default: ${DEFAULT_JUDGE_MODEL})
    --concurrency <n>  parallel requests    (default: 4)
    --max-tokens <n>   per answer           (default: 1024)
    --dry-run          print the plan and the cost estimate, call nothing
    --yes              actually run it
    --no-suffix        do not append the "answer only" instruction to task prompts
    --out <file>       write the full run record as JSON
    --json             print the result as JSON
    --headline         print only the one-line summary
    --no-color         plain output

  Requires ANTHROPIC_API_KEY.
`;

export async function ablateCommand(argv, { root: initialRoot = process.cwd() } = {}) {
  let root = initialRoot;
  const opts = {
    file: null, tasks: 'ctx-doctor.tasks.json', trials: 8, model: DEFAULT_MODEL,
    judgeModel: DEFAULT_JUDGE_MODEL, concurrency: 4, maxTokens: 1024,
    yes: false, dryRun: false, init: false, json: false, headline: false, out: null,
    check: false, calibrate: false, suffix: undefined,
    color: process.stdout.isTTY && !process.env.NO_COLOR,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => argv[++i];
    switch (arg) {
      case '-h': case '--help': process.stdout.write(HELP); return 0;
      case '--root': root = path.resolve(next()); break;
      case '--check': opts.check = true; break;
      case '--calibrate': opts.calibrate = true; break;
      case '--no-suffix': opts.suffix = ''; break;
      case '--init': opts.init = true; break;
      case '--tasks': opts.tasks = next(); break;
      case '--trials': opts.trials = Number(next()); break;
      case '--model': opts.model = next(); break;
      case '--judge-model': opts.judgeModel = next(); break;
      case '--concurrency': opts.concurrency = Number(next()); break;
      case '--max-tokens': opts.maxTokens = Number(next()); break;
      case '--dry-run': opts.dryRun = true; break;
      case '--yes': opts.yes = true; break;
      case '--out': opts.out = next(); break;
      case '--json': opts.json = true; opts.color = false; break;
      case '--headline': opts.headline = true; break;
      case '--no-color': opts.color = false; break;
      default:
        if (arg.startsWith('-')) return die(`unknown option: ${arg}`);
        opts.file = arg;
    }
  }

  const s = makeStyle(opts.color);
  for (const [flag, id] of [['--model', opts.model], ['--judge-model', opts.judgeModel]]) {
    if (!MODELS[id]) return die(`unknown model for ${flag}: ${id}\nknown: ${Object.keys(MODELS).join(', ')}`);
  }
  if (!Number.isFinite(opts.trials) || opts.trials < 1) return die('--trials must be a positive integer');

  if (opts.check) return liveCheck(opts, s);

  const file = opts.file ?? discoverTargets(root)[0];
  if (!file) return die('no instruction file found; pass one explicitly');
  const fullPath = path.resolve(root, file);
  if (!fs.existsSync(fullPath)) return die(`${file} not found`);
  const source = fs.readFileSync(fullPath, 'utf8');

  if (opts.calibrate) return calibrate({ source, file, model: opts.model, style: s, json: opts.json });

  if (opts.init) {
    const target = path.resolve(root, opts.tasks);
    if (fs.existsSync(target)) return die(`${opts.tasks} already exists; delete it or pass --tasks <other>`);
    fs.writeFileSync(target, scaffold(source, file));
    process.stdout.write(`${s.green('wrote')} ${opts.tasks}\n`);
    process.stdout.write(s.gray('Fill in the tasks — they should be jobs you actually give the agent.\nAdd a `check` to any rule you can grade with a regex; the rest fall back to a blind judge.\n'));
    return 0;
  }

  const tasksPath = path.resolve(root, opts.tasks);
  if (!fs.existsSync(tasksPath)) {
    return die(`${opts.tasks} not found. Run \`ctx-doctor ablate --init\` to scaffold one.`);
  }
  let spec;
  try {
    spec = JSON.parse(fs.readFileSync(tasksPath, 'utf8'));
  } catch (err) {
    return die(`could not parse ${opts.tasks}: ${err.message}`);
  }

  let plan;
  try {
    plan = buildPlan({ source, spec, trials: opts.trials });
  } catch (err) {
    return die(err.message);
  }

  const m = MODELS[opts.model];
  const j = MODELS[opts.judgeModel];
  const est = estimatePlan({
    plan, spec, inputRate: m.input, outputRate: m.output,
    judgeInputRate: j.input, judgeOutputRate: j.output, maxTokens: opts.maxTokens,
  });

  const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
  process.stderr.write(`${s.bold('plan')}  ${plural(plan.rules.length, 'rule')} × ${plural(plan.tasks.length, 'task')} × ${opts.trials} trials × 2 arms\n`);
  process.stderr.write(s.gray(`      ~${est.calls} API calls · estimated $${est.cost.toFixed(2)} on ${m.label}\n`));
  if (opts.trials < trialsNeeded(0.3)) {
    process.stderr.write(s.yellow(`      at ${opts.trials} trials/arm only large effects will separate from zero; ${trialsNeeded(0.3)}+ resolves a 0.3 difference\n`));
  }

  if (opts.dryRun) {
    if (opts.json) process.stdout.write(`${JSON.stringify({ estimate: est, rules: plan.rules.map((r) => ({ id: r.id, text: r.text, judged: !r.check })) }, null, 2)}\n`);
    return 0;
  }
  if (!opts.yes) {
    process.stderr.write(`${s.yellow('not running')} — this spends real money. Re-run with --yes, or --dry-run to see the plan only.\n`);
    return 2;
  }

  let last = '';
  const run = await runAblation({
    source,
    spec,
    ...(opts.suffix === undefined ? {} : { suffix: opts.suffix }),
    trials: opts.trials,
    model: opts.model,
    judgeModel: opts.judgeModel,
    concurrency: opts.concurrency,
    maxTokens: opts.maxTokens,
    onProgress: ({ phase, done, total }) => {
      const line = `  ${phase} ${done}/${total}`;
      if (line !== last && process.stderr.isTTY) {
        process.stderr.write(`\r${line.padEnd(30)}`);
        last = line;
      }
    },
  });
  if (process.stderr.isTTY) process.stderr.write('\r'.padEnd(32) + '\r');

  if (opts.out) {
    fs.writeFileSync(path.resolve(root, opts.out), `${JSON.stringify(run, null, 2)}\n`);
    process.stderr.write(`${s.green('wrote')} ${opts.out}\n`);
  }
  if (opts.headline) process.stdout.write(`${ablationHeadline(run)}\n`);
  else if (opts.json) process.stdout.write(`${JSON.stringify(run, null, 2)}\n`);
  else process.stdout.write(`${formatAblation(run, { color: opts.color })}\n`);

  return run.results.some((r) => r.verdict === 'harmful') ? 1 : 0;
}

/**
 * One minimal live request. The rest of this file is exercised against a local
 * stub, which proves our assumptions about the wire format, not Anthropic's.
 * This is the cheapest possible way to find out they agree.
 */
async function liveCheck(opts, s) {
  let key;
  try {
    key = requireApiKey();
  } catch (err) {
    process.stderr.write(`ctx-doctor ablate: ${err.message}\n`);
    return 2;
  }
  process.stderr.write(s.gray(`checking ${opts.model} … (one call, a few tokens)\n`));
  try {
    const res = await complete({
      apiKey: key, model: opts.model, system: 'Reply with the single word OK.',
      prompt: 'Ready?', maxTokens: 16,
      effort: MODELS[opts.model]?.effort ? 'low' : undefined,
    });
    process.stdout.write(`${s.green('ok')} ${opts.model} replied (${res.usage.input_tokens ?? '?'} in / ${res.usage.output_tokens ?? '?'} out)\n`);
    return 0;
  } catch (err) {
    process.stderr.write(`${s.red('failed')} ${err.message}\n`);
    return 1;
  }
}

/** Measure the estimator instead of asserting its error bar. */
async function calibrate({ source, file, model, style: s, json }) {
  let key;
  try {
    key = requireApiKey();
  } catch (err) {
    process.stderr.write(`ctx-doctor ablate: ${err.message}\n`);
    return 2;
  }
  const estimated = estimateTokens(source);
  let actual;
  try {
    actual = await countTokens({ apiKey: key, model, text: source });
  } catch (err) {
    process.stderr.write(`${s.red('failed')} ${err.message}\n`);
    return 1;
  }
  // count_tokens includes the message envelope; the estimator sees only text.
  const errPct = ((estimated - actual) / actual) * 100;
  if (json) {
    process.stdout.write(`${JSON.stringify({ file, model, estimated, actual, errorPct: Number(errPct.toFixed(1)) }, null, 2)}\n`);
  } else {
    process.stdout.write(`${file}  estimated ${estimated} · actual ${actual} (${model})\n`);
    process.stdout.write(`${Math.abs(errPct) <= 15 ? s.green('within ±15%') : s.yellow('outside ±15%')}  ${errPct >= 0 ? '+' : ''}${errPct.toFixed(1)}%\n`);
  }
  return 0;
}

/** Starter task file: every bullet becomes a candidate rule, tasks are left to the author. */
function scaffold(source, file) {
  const rules = extractDirectives(parseBlocks(source))
    .filter((d) => d.block.type === 'list')
    .slice(0, 25)
    .map((d) => ({
      id: d.text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').split('-').slice(0, 4).join('-'),
      match: d.text.slice(0, 60),
      check: null,
    }));

  return `${JSON.stringify({
    _README: [
      `Ablation spec for ${file}.`,
      'tasks: real jobs you give the agent. Three to five beats one.',
      'rules: each is deleted from the file in turn and measured on its own.',
      '  match  - a substring of the rule as written in the file',
      '  check  - optional deterministic grade, e.g. {"notRegex": "^\\\\s*//", "flags": "m"}',
      '           keys: contains, notContains, regex, notRegex, applies, flags',
      '           leave null to have a separate model grade it, shown only the rule and the output',
      'Delete rules you do not want measured; every one costs trials x tasks x 2 calls.',
    ],
    tasks: [
      { id: 'example-1', prompt: 'Replace this with a task you actually give the agent, e.g. "Add a retry with backoff to the HTTP client."' },
    ],
    rules,
  }, null, 2)}\n`;
}

function die(message) {
  process.stderr.write(`ctx-doctor ablate: ${message}\n`);
  return 2;
}
