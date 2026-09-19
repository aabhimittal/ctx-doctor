import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CLI = new URL('../bin/cli.js', import.meta.url).pathname;

function makeRepo(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-doctor-'));
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  return dir;
}

function run(args, { cwd, expectFail = false } = {}) {
  try {
    const stdout = execFileSync(process.execPath, [CLI, ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    assert.ok(!expectFail, 'expected a non-zero exit');
    return { stdout, code: 0 };
  } catch (err) {
    assert.ok(expectFail, `unexpected failure (${err.status}): ${err.stderr || err.stdout}`);
    return { stdout: err.stdout ?? '', code: err.status };
  }
}

const DIRTY = [
  '# Project',
  '',
  'This project uses TypeScript.',
  '',
  '- Run `npm test` to run the tests.',
  '- Always use tabs for indentation.',
  '- Always use spaces for indentation.',
  '- Write clean code.',
  '',
].join('\n');

test('lints discovered targets and exits 1 on an error-level finding', () => {
  const dir = makeRepo({
    'AGENTS.md': DIRTY,
    'package.json': JSON.stringify({ name: 'x', scripts: { test: 'node --test' } }),
    'tsconfig.json': '{}',
  });
  const { stdout } = run(['--no-color'], { cwd: dir, expectFail: true });
  assert.match(stdout, /AGENTS\.md/);
  assert.match(stdout, /logic\/contradiction/);
  assert.match(stdout, /repo\/script/);
  assert.match(stdout, /minimized/);
});

test('--json emits a parseable report', () => {
  const dir = makeRepo({
    'AGENTS.md': DIRTY,
    'package.json': JSON.stringify({ name: 'x', scripts: { test: 'node --test' } }),
  });
  const { stdout } = run(['--json'], { cwd: dir, expectFail: true });
  const report = JSON.parse(stdout);
  assert.equal(report.files.length, 1);
  assert.ok(report.files[0].tokensBefore > report.files[0].tokensAfter);
  assert.ok(report.files[0].findings.some((f) => f.rule === 'logic/contradiction'));
  assert.ok(report.files[0].costPerSession > 0);
});

test('--fix rewrites the file and the result lints cleaner', () => {
  const dir = makeRepo({
    'AGENTS.md': DIRTY,
    'package.json': JSON.stringify({ name: 'x', scripts: { test: 'node --test' } }),
    'tsconfig.json': '{}',
  });
  run(['--fix'], { cwd: dir, expectFail: true });
  const after = fs.readFileSync(path.join(dir, 'AGENTS.md'), 'utf8');
  assert.ok(!after.includes('This project uses TypeScript'));
  assert.ok(!after.includes('Write clean code'));
  assert.ok(after.includes('tabs'), 'the contradiction must survive --fix');
});

test('--diff prints a unified patch without touching the file', () => {
  const dir = makeRepo({ 'AGENTS.md': DIRTY, 'package.json': '{"name":"x"}' });
  const before = fs.readFileSync(path.join(dir, 'AGENTS.md'), 'utf8');
  const { stdout } = run(['--diff', '--no-color'], { cwd: dir, expectFail: true });
  assert.match(stdout, /^--- AGENTS\.md$/m);
  assert.match(stdout, /^@@ /m);
  assert.equal(fs.readFileSync(path.join(dir, 'AGENTS.md'), 'utf8'), before);
});

test('a clean file exits 0', () => {
  const dir = makeRepo({
    'AGENTS.md': '# Conventions\n\n- Tests live beside the code as `*.test.js`.\n',
    'package.json': '{"name":"x"}',
  });
  const { stdout, code } = run(['--no-color'], { cwd: dir });
  assert.equal(code, 0);
  assert.match(stdout, /no findings/);
});

test('--ignore silences a rule', () => {
  const dir = makeRepo({ 'AGENTS.md': DIRTY, 'package.json': '{"name":"x"}' });
  const { stdout } = run(['--json', '--ignore', 'logic/contradiction,style/vague'], { cwd: dir });
  const report = JSON.parse(stdout);
  const ids = report.files[0].findings.map((f) => f.rule);
  assert.ok(!ids.includes('logic/contradiction'));
  assert.ok(!ids.includes('style/vague'));
});

test('--list-rules and --version work', () => {
  assert.match(run(['--list-rules']).stdout, /budget\/tokens/);
  assert.match(run(['--version']).stdout.trim(), /^\d+\.\d+\.\d+$/);
});

test('rejects an unknown model', () => {
  const { code } = run(['--model', 'gpt-nope'], { expectFail: true });
  assert.equal(code, 2);
});
