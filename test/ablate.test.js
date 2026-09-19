import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { buildPlan, estimatePlan } from '../src/ablate/plan.js';
import { gradeDeterministic } from '../src/ablate/grade.js';
import { runAblation } from '../src/ablate/index.js';
import { ablationHeadline, formatAblation } from '../src/ablate/report.js';

const INSTRUCTIONS = [
  '# AGENTS.md',
  '',
  '## Code style',
  '',
  '- Never add comments; the code should speak for itself.',
  '- Write clean, maintainable code.',
  '',
].join('\n');

const SPEC = {
  tasks: [{ id: 't1', prompt: 'Write a function that adds two numbers.' }],
  rules: [
    { id: 'no-comments', match: 'Never add comments', check: { notRegex: '//' } },
    { id: 'clean-code', match: 'Write clean, maintainable code', check: { contains: 'function' } },
  ],
};

/**
 * Stub API. `no-comments` is a rule that works: the answer contains a comment
 * exactly when the rule is missing from the system prompt. `clean-code` is a
 * rule that does nothing: the answer is the same either way.
 */
function stubServer() {
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const payload = JSON.parse(body);
      const system = payload.system ?? '';
      const rulePresent = system.includes('Never add comments');
      const text = rulePresent
        ? 'function add(a, b) { return a + b; }'
        : '// adds two numbers\nfunction add(a, b) { return a + b; }';
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        content: [{ type: 'text', text }],
        usage: { input_tokens: 100, output_tokens: 20 },
        stop_reason: 'end_turn',
      }));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, url: `http://127.0.0.1:${server.address().port}` }));
  });
}

test('buildPlan removes exactly one rule per arm', () => {
  const plan = buildPlan({ source: INSTRUCTIONS, spec: SPEC, trials: 2 });
  assert.equal(plan.arms.length, 3); // full + one per rule
  const full = plan.arms.find((a) => a.id === 'full');
  const without = plan.arms.find((a) => a.id === 'without:no-comments');
  assert.ok(full.system.includes('Never add comments'));
  assert.ok(!without.system.includes('Never add comments'));
  assert.ok(without.system.includes('Write clean, maintainable code'), 'other rules must survive');
  assert.equal(plan.cells.length, 3 * 1 * 2);
});

test('buildPlan falls back to every bullet when no rules are given', () => {
  const plan = buildPlan({ source: INSTRUCTIONS, spec: { tasks: SPEC.tasks }, trials: 1 });
  assert.equal(plan.rules.length, 2);
  assert.ok(plan.rules.every((r) => r.check === null), 'auto-derived rules are judged, not regexed');
});

test('buildPlan rejects a rule it cannot find', () => {
  assert.throws(
    () => buildPlan({ source: INSTRUCTIONS, spec: { tasks: SPEC.tasks, rules: [{ id: 'x', match: 'nope' }] } }),
    /no block in the instruction file contains/,
  );
});

test('estimatePlan prices the run before anything is spent', () => {
  const plan = buildPlan({ source: INSTRUCTIONS, spec: SPEC, trials: 4 });
  const est = estimatePlan({ plan, spec: SPEC, inputRate: 5, outputRate: 25, judgeInputRate: 2, judgeOutputRate: 10 });
  assert.equal(est.calls, plan.cells.length, 'deterministic checks need no judge calls');
  assert.ok(est.cost > 0);
});

test('deterministic grading covers each check kind', () => {
  assert.equal(gradeDeterministic('a // b', { notRegex: '//' }).grade, 'violate');
  assert.equal(gradeDeterministic('clean', { notRegex: '//' }).grade, 'comply');
  assert.equal(gradeDeterministic('has function', { contains: 'function' }).grade, 'comply');
  assert.equal(gradeDeterministic('nope', { contains: 'function' }).grade, 'violate');
  assert.equal(gradeDeterministic('x', { notContains: 'x' }).grade, 'violate');
  assert.equal(gradeDeterministic('abc', { regex: '^a' }).grade, 'comply');
  // `applies` gates the rule out entirely rather than scoring it a violation.
  assert.equal(gradeDeterministic('prose only', { applies: 'function', contains: 'return' }).grade, 'na');
});

test('end to end: separates a rule that works from one that does nothing', async () => {
  const { server, url } = await stubServer();
  const prev = process.env.ANTHROPIC_BASE_URL;
  process.env.ANTHROPIC_BASE_URL = url;
  try {
    const run = await runAblation({
      source: INSTRUCTIONS, spec: SPEC, trials: 20, apiKey: 'test-key',
      model: 'claude-opus-5', judgeModel: 'claude-sonnet-5', concurrency: 8,
    });

    const works = run.results.find((r) => r.id === 'no-comments');
    assert.equal(works.verdict, 'carries-weight');
    assert.equal(works.with.comply, 20);
    assert.equal(works.without.comply, 0);
    assert.ok(works.diff.delta > 0.9);

    const inert = run.results.find((r) => r.id === 'clean-code');
    assert.equal(inert.verdict, 'no-effect', `expected no-effect, got ${inert.verdict}`);
    assert.equal(inert.diff.delta, 0);

    // The rule that matters is reported first.
    assert.equal(run.results[0].id, 'no-comments');
    assert.equal(run.usage.errors, 0);
    assert.match(ablationHeadline(run), /2 rules measured: 1 changed/);
    assert.match(formatAblation(run, { color: false }), /carries weight/);
  } finally {
    if (prev === undefined) delete process.env.ANTHROPIC_BASE_URL; else process.env.ANTHROPIC_BASE_URL = prev;
    server.close();
  }
});

test('retries a 429 instead of dropping the cell', async () => {
  let hits = 0;
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      hits++;
      if (hits === 1) {
        res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '1' });
        res.end('{"type":"error"}');
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 1, output_tokens: 1 } }));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const prev = process.env.ANTHROPIC_BASE_URL;
  process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${server.address().port}`;
  try {
    const { complete } = await import('../src/ablate/api.js');
    const res = await complete({ apiKey: 'k', model: 'claude-opus-5', prompt: 'hi', maxTokens: 10 });
    assert.equal(res.text, 'ok');
    assert.equal(hits, 2);
  } finally {
    if (prev === undefined) delete process.env.ANTHROPIC_BASE_URL; else process.env.ANTHROPIC_BASE_URL = prev;
    server.close();
  }
});

test('cli: --init scaffolds, --dry-run prices, and nothing runs without --yes', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-ablate-'));
  fs.writeFileSync(path.join(dir, 'AGENTS.md'), INSTRUCTIONS);
  fs.writeFileSync(path.join(dir, 'package.json'), '{"name":"x"}');
  const cli = new URL('../bin/cli.js', import.meta.url).pathname;
  // The plan and the cost estimate go to stderr so that --json stays pipeable.
  const run = (args, expectFail = false) => {
    const r = spawnSync(process.execPath, [cli, 'ablate', ...args], { cwd: dir, encoding: 'utf8' });
    assert.equal(r.status !== 0, expectFail, `exit ${r.status}: ${r.stderr}`);
    return `${r.stdout}${r.stderr}`;
  };

  run(['--init']);
  const spec = JSON.parse(fs.readFileSync(path.join(dir, 'ctx-doctor.tasks.json'), 'utf8'));
  assert.equal(spec.rules.length, 2);
  assert.ok(spec.tasks.length >= 1);

  const dry = run(['--dry-run', '--no-color']);
  assert.match(dry, /API calls/);

  const refused = run(['--no-color'], true);
  assert.match(refused, /not running/);
});
