import { test } from 'node:test';
import assert from 'node:assert/strict';

import { lint, rules } from './helpers.js';
import { addCrossFileFindings } from '../src/index.js';
import { estimateTokens } from '../src/tokens.js';
import { parseBlocks } from '../src/parse.js';
import { unifiedDiff } from '../src/diff.js';
import { budgetReport } from '../src/rules/budget.js';

test('token estimate is in the right neighbourhood', () => {
  assert.equal(estimateTokens(''), 0);
  const sentence = 'Always run the test suite before committing changes.';
  const t = estimateTokens(sentence);
  assert.ok(t >= 7 && t <= 14, `expected 7..14, got ${t}`);
  // Monotonic in length.
  assert.ok(estimateTokens(sentence.repeat(4)) > estimateTokens(sentence.repeat(2)));
});

test('parser keeps line numbers and separates code from prose', () => {
  const blocks = parseBlocks('# Title\n\nA paragraph.\n\n- item one\n- item two\n\n```sh\nnpm test\n```\n');
  assert.deepEqual(blocks.map((b) => b.type), ['heading', 'para', 'list', 'list', 'code']);
  assert.equal(blocks[0].start, 1);
  assert.equal(blocks[2].start, 5);
  assert.equal(blocks[4].start, 8);
  assert.equal(blocks[4].end, 10);
  assert.equal(blocks[2].heading[0], 'Title');
});

test('flags a rule that only restates a package.json script', () => {
  const r = lint('Run `npm test` to run the test suite.\n', { scripts: { test: 'node --test' } });
  assert.ok(rules(r).includes('repo/script'));
  assert.ok(r.findings[0].removable);
});

test('keeps a script mention that adds a condition', () => {
  const r = lint('Run `npm test` before every commit.\n', { scripts: { test: 'node --test' } });
  assert.ok(!rules(r).includes('repo/script'));
});

test('flags a directory description the agent could list for itself', () => {
  const r = lint('The `src/` directory contains the source code.\n', { dirs: ['src'] });
  assert.ok(rules(r).includes('repo/structure'));
});

test('flags a hand-maintained tree', () => {
  const text = '```\nsrc/\n├── index.js\n├── parse.js\n└── tokens.js\n```\n';
  const r = lint(text, { dirs: ['src'], files: ['src/index.js', 'src/parse.js', 'src/tokens.js'] });
  assert.ok(rules(r).includes('repo/structure'));
});

test('flags a stack announcement, keeps a stack preference', () => {
  const visible = { tools: ['typescript', 'vitest'] };
  assert.ok(rules(lint('This project uses TypeScript and Vitest.\n', visible)).includes('repo/stack'));
  assert.ok(!rules(lint('Use Vitest, never Jest, for new tests.\n', visible)).includes('repo/stack'));
});

test('detects opposite-polarity contradictions', () => {
  const r = lint('- Always add comments to exported functions.\n- Never add comments to exported functions.\n');
  const c = r.findings.find((f) => f.rule === 'logic/contradiction');
  assert.ok(c, 'expected a contradiction');
  assert.equal(c.severity, 'error');
  assert.equal(c.removable, false, 'contradictions must never be auto-removed');
});

test('detects a blanket rule that cancels a specific one', () => {
  const r = lint('- Always add JSDoc comments to exported functions.\n- Never add comments; the code should speak for itself.\n');
  const c = r.findings.find((f) => f.rule === 'logic/contradiction');
  assert.ok(c, 'expected a contradiction');
  assert.equal(c.severity, 'error');
});

test('downgrades a scoped exception to a warning', () => {
  const r = lint('- Indent with 2 spaces.\n- Use a 4 space indent for JSON files.\n');
  const c = r.findings.find((f) => f.rule === 'logic/contradiction');
  assert.ok(c);
  assert.equal(c.severity, 'warn');
  assert.match(c.message, /exception/);
});

test('detects mutually exclusive choices without negation', () => {
  const r = lint('- Indent with tabs.\n- Indent with spaces.\n');
  assert.ok(rules(r).includes('logic/contradiction'));
});

test('detects numeric conflicts on the same property', () => {
  const r = lint('- Keep line length under 80 characters.\n- Line length limit is 120 characters.\n');
  assert.ok(rules(r).includes('logic/contradiction'));
});

test('detects a rule pointing at a file that does not exist', () => {
  const r = lint('Follow the style rules in docs/STYLE.md.\n', { dirs: ['docs'], files: ['docs/README.md'] });
  const f = r.findings.find((x) => x.rule === 'logic/unsatisfiable');
  assert.ok(f);
  assert.equal(f.severity, 'error');
});

test('does not flag paths that do exist', () => {
  const r = lint('Follow the style rules in docs/STYLE.md.\n', { dirs: ['docs'], files: ['docs/STYLE.md'] });
  assert.ok(!rules(r).includes('logic/unsatisfiable'));
});

test('detects duplicate rules', () => {
  const r = lint('- Always write tests for new behaviour.\n- Always write tests for new behaviour.\n');
  assert.ok(rules(r).includes('style/duplicate'));
});

test('flags unfalsifiable instructions but not anchored ones', () => {
  assert.ok(rules(lint('Write clean, maintainable code.\n')).includes('style/vague'));
  assert.ok(!rules(lint('Keep modules under 200 lines so they stay readable.\n')).includes('style/vague'));
});

test('flags a persona preamble', () => {
  assert.ok(rules(lint('You are an expert senior TypeScript engineer.\n')).includes('style/persona'));
});

test('budget rule reports cost and scales with turns', () => {
  const text = 'Write clean code. '.repeat(200);
  const a = budgetReport(text, { model: 'claude-opus-5', turns: 10 });
  const b = budgetReport(text, { model: 'claude-opus-5', turns: 20 });
  assert.ok(a.tokens > 500);
  assert.ok(Math.abs(b.costPerSession - a.costPerSession * 2) < 1e-9);
  assert.ok(b.costPerSessionCached < b.costPerSession);
  const r = lint(text, {}, { budget: 100 });
  assert.ok(rules(r).includes('budget/tokens'));
});

test('minimizer removes redundancy, keeps contradictions, and produces a diff', () => {
  const text = [
    '# Rules',
    '',
    'This project uses TypeScript.',
    '',
    '- Always add comments to exported functions.',
    '- Never add comments to exported functions.',
    '- Write clean code.',
    '',
  ].join('\n');
  const r = lint(text, { tools: ['typescript'] });

  assert.ok(!r.minimized.includes('This project uses TypeScript'));
  assert.ok(!r.minimized.includes('Write clean code'));
  assert.ok(r.minimized.includes('Always add comments'));
  assert.ok(r.minimized.includes('Never add comments'));
  assert.ok(r.tokensAfter < r.tokensBefore);

  const patch = unifiedDiff(r.text, r.minimized, { fromFile: 'a', toFile: 'b' });
  assert.match(patch, /^--- a\n\+\+\+ b\n@@ /);
  assert.match(patch, /^-This project uses TypeScript\./m);
});

test('minimizer leaves a paragraph that mixes filler with real instruction', () => {
  const text = 'Write clean code. Never commit directly to `main`; open a pull request instead.\n';
  const r = lint(text);
  assert.ok(r.minimized.includes('Never commit directly'));
  assert.equal(r.removedLines, 0);
});

test('a clean file produces no findings', () => {
  const text = [
    '# Conventions',
    '',
    '- Tests live next to the code they cover, as `*.test.js`.',
    '- Public functions return `Result` objects, never throw.',
    '',
  ].join('\n');
  const r = lint(text, { dirs: ['src'], tools: ['jest'] });
  assert.deepEqual(r.findings, [], JSON.stringify(r.findings, null, 2));
});

test('flags two instruction files that restate each other', () => {
  const text = '- Always run the linter before opening a pull request.\n- Prefer composition over inheritance in the transport layer.\n';
  const a = lint(text);
  const b = lint(text);
  b.file = 'CLAUDE.md';
  addCrossFileFindings([a, b]);
  const f = b.findings.find((x) => x.rule === 'repo/cross-file');
  assert.ok(f);
  assert.match(f.message, /2 of 2 rules/);
  assert.equal(a.findings.length, 0, 'the first file should not be blamed for the overlap');
});

test('unifiedDiff returns empty string for identical input', () => {
  assert.equal(unifiedDiff('a\nb\n', 'a\nb\n'), '');
});
