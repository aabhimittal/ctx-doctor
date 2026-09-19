#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

import { analyzeFiles, discoverTargets, RULE_IDS } from '../src/index.js';
import { formatResult, formatSummary, headline, makeStyle } from '../src/report.js';
import { unifiedDiff } from '../src/diff.js';
import { MODELS, DEFAULT_MODEL, BUDGETS } from '../src/models.js';

const HELP = `ctx-doctor — static linter for agent instruction files

  Usage
    ctx-doctor [files...] [options]
    ctx-doctor ablate [file] [options]   measure which rules actually change behaviour

  With no files, lints every instruction file it finds in the repo
  (AGENTS.md, CLAUDE.md, .cursorrules, .github/copilot-instructions.md, ...).

  Options
    --root <dir>       repository root to analyze against  (default: cwd)
    --model <id>       pricing model                       (default: ${DEFAULT_MODEL})
    --turns <n>        turns per session for cost math     (default: 25)
    --budget <n>       token budget before warning         (default: ${BUDGETS.warn})
    --headline         print only the one-line summary, for sharing or CI
    --diff             print the minimized file as a unified diff
    --fix              write the minimized file in place
    --json             machine-readable output
    --ignore <ids>     comma-separated rule ids to skip
    --fail-on <level>  error | warn | never                (default: error)
    --no-scan          do not read the repo; skips repo/* rules
    --verbose, -v      include the rationale for each finding
    --no-color         plain output
    --list-rules       print rule ids and exit
    --version          print version and exit

  Models: ${Object.keys(MODELS).join(', ')}
`;

const argv = process.argv.slice(2);

// Subcommand: everything after `ablate` belongs to it.
if (argv[0] === 'ablate') {
  const { ablateCommand } = await import('../src/ablate/cli.js');
  process.exit(await ablateCommand(argv.slice(1)));
}

const opts = {
  files: [], root: process.cwd(), model: DEFAULT_MODEL, turns: 25,
  budget: undefined, diff: false, fix: false, json: false, ignore: [],
  failOn: 'error', scan: true, verbose: false, headline: false,
  color: process.stdout.isTTY && !process.env.NO_COLOR,
};

for (let i = 0; i < argv.length; i++) {
  const arg = argv[i];
  const next = () => argv[++i];
  switch (arg) {
    case '-h': case '--help': process.stdout.write(HELP); process.exit(0); break;
    case '--version': printVersion(); process.exit(0); break;
    case '--list-rules':
      for (const [id, desc] of RULE_IDS) process.stdout.write(`${id.padEnd(22)} ${desc}\n`);
      process.exit(0);
      break;
    case '--root': opts.root = path.resolve(next()); break;
    case '--model': opts.model = next(); break;
    case '--turns': opts.turns = Number(next()); break;
    case '--budget': opts.budget = Number(next()); break;
    case '--headline': opts.headline = true; break;
    case '--diff': opts.diff = true; break;
    case '--fix': opts.fix = true; break;
    case '--json': opts.json = true; opts.color = false; break;
    case '--ignore': opts.ignore.push(...String(next()).split(',').map((s) => s.trim()).filter(Boolean)); break;
    case '--fail-on': opts.failOn = next(); break;
    case '--no-scan': opts.scan = false; break;
    case '-v': case '--verbose': opts.verbose = true; break;
    case '--no-color': opts.color = false; break;
    default:
      if (arg.startsWith('-')) fail(`unknown option: ${arg}`);
      opts.files.push(arg);
  }
}

const style = makeStyle(opts.color);

if (!MODELS[opts.model]) {
  fail(`unknown model: ${opts.model}\nknown: ${Object.keys(MODELS).join(', ')}`);
}
if (!['error', 'warn', 'never'].includes(opts.failOn)) {
  fail(`--fail-on must be error, warn, or never`);
}

applyConfigFile(opts);

let files = opts.files.length ? opts.files.map((f) => path.relative(opts.root, path.resolve(f)) || f) : discoverTargets(opts.root);
files = files.filter((f) => {
  if (fs.existsSync(path.resolve(opts.root, f))) return true;
  process.stderr.write(`${style.yellow('skipped')} ${f} (not found)\n`);
  return false;
});

if (!files.length) {
  process.stderr.write(`${style.yellow('no instruction files found')} under ${opts.root}\n`);
  process.stderr.write(`Looked for: AGENTS.md, CLAUDE.md, .cursorrules, .github/copilot-instructions.md and friends.\n`);
  process.exit(0);
}

const { results, ctx } = analyzeFiles(files, {
  root: opts.root,
  scan: opts.scan,
  options: { model: opts.model, turns: opts.turns, budget: opts.budget, ignore: opts.ignore },
});

if (opts.json) {
  process.stdout.write(`${JSON.stringify({
    root: opts.root,
    model: opts.model,
    turns: opts.turns,
    repoScanned: opts.scan,
    repoTruncated: ctx.truncated,
    files: results.map((r) => ({
      file: r.file,
      tokensBefore: r.tokensBefore,
      tokensAfter: r.tokensAfter,
      tokensSaved: r.tokensSaved,
      bytes: r.budget.bytes,
      costPerSession: round(r.budget.costPerSession),
      costPerSessionCached: round(r.budget.costPerSessionCached),
      counts: r.counts,
      findings: r.findings.map((f) => ({
        rule: f.rule, severity: f.severity, line: f.line, endLine: f.block?.end ?? f.line,
        message: f.message, why: f.why, excerpt: f.excerpt ?? null,
        removable: Boolean(f.removable), related: f.related ?? null,
      })),
    })),
  }, null, 2)}\n`);
} else if (opts.headline) {
  for (const r of results) process.stdout.write(`${headline(r)}\n`);
} else {
  for (const r of results) process.stdout.write(`${formatResult(r, { color: opts.color, verbose: opts.verbose })}\n`);
  if (opts.diff) {
    for (const r of results) {
      const patch = unifiedDiff(r.text, r.minimized, { fromFile: `${r.file}`, toFile: `${r.file} (minimized)` });
      if (patch) process.stdout.write(`\n${colorizeDiff(patch, opts.color)}`);
    }
  }
  process.stdout.write(`${formatSummary(results, { color: opts.color })}\n`);
  if (ctx.truncated) {
    process.stdout.write(style.gray('note: repository scan hit its entry cap; some repo/* checks may be incomplete\n'));
  }
}

if (opts.fix) {
  for (const r of results) {
    if (r.minimized === r.text) continue;
    fs.writeFileSync(path.resolve(opts.root, r.file), r.minimized);
    if (!opts.json) process.stdout.write(`${style.green('wrote')} ${r.file} (-${r.removedLines} lines)\n`);
  }
}

const worst = results.reduce((acc, r) => ({
  error: acc.error + r.counts.error,
  warn: acc.warn + r.counts.warn,
}), { error: 0, warn: 0 });

if (opts.failOn === 'error' && worst.error > 0) process.exit(1);
if (opts.failOn === 'warn' && (worst.error > 0 || worst.warn > 0)) process.exit(1);
process.exit(0);

function applyConfigFile(target) {
  const file = path.join(target.root, 'ctx-doctor.config.json');
  if (!fs.existsSync(file)) return;
  let cfg;
  try {
    cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    fail(`could not parse ctx-doctor.config.json: ${err.message}`);
  }
  // CLI flags win; the config only fills in what was not passed explicitly.
  if (cfg.model && !argv.includes('--model')) target.model = cfg.model;
  if (cfg.turns && !argv.includes('--turns')) target.turns = cfg.turns;
  if (cfg.budget && target.budget === undefined) target.budget = cfg.budget;
  if (cfg.failOn && !argv.includes('--fail-on')) target.failOn = cfg.failOn;
  if (Array.isArray(cfg.ignore)) target.ignore.push(...cfg.ignore);
  if (Array.isArray(cfg.files) && !target.files.length) target.files.push(...cfg.files);
  if (!MODELS[target.model]) fail(`unknown model in config: ${target.model}`);
}

function printVersion() {
  const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  process.stdout.write(`${pkg.version}\n`);
}

function colorizeDiff(patch, color) {
  if (!color) return patch;
  const s = makeStyle(true);
  return `${patch.split('\n').map((l) => {
    if (l.startsWith('+++') || l.startsWith('---')) return s.bold(l);
    if (l.startsWith('@@')) return s.cyan(l);
    if (l.startsWith('+')) return s.green(l);
    if (l.startsWith('-')) return s.red(l);
    return l;
  }).join('\n')}`;
}

function round(n) {
  return Math.round(n * 1e6) / 1e6;
}

function fail(message) {
  process.stderr.write(`ctx-doctor: ${message}\n`);
  process.exit(2);
}
