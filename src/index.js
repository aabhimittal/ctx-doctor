import fs from 'node:fs';
import path from 'node:path';

import { parseBlocks } from './parse.js';
import { estimateTokens } from './tokens.js';
import { scanRepo, emptyContext } from './context.js';
import { extractDirectives, jaccard } from './directives.js';
import { minimize } from './minimize.js';
import { budgetRules, budgetReport } from './rules/budget.js';
import { redundantRules } from './rules/redundant.js';
import { logicRules } from './rules/logic.js';
import { styleRules } from './rules/style.js';
import { KNOWN_TARGETS } from './models.js';

export const RULES = [budgetRules, redundantRules, logicRules, styleRules];

export const RULE_IDS = [
  ['budget/tokens', 'File exceeds its token budget; reports per-session cost.'],
  ['repo/script', 'Restates a command already declared in package.json or the Makefile.'],
  ['repo/structure', 'Describes a layout the agent can see by listing the tree.'],
  ['repo/stack', 'Names tools already visible from config files and the manifest.'],
  ['repo/obvious', 'Restates license or README trivia.'],
  ['repo/cross-file', 'Two instruction files in one repo restating each other.'],
  ['logic/contradiction', 'Two rules that cannot both be satisfied.'],
  ['logic/unsatisfiable', 'Points at a file or directory that does not exist.'],
  ['style/duplicate', 'Same rule stated twice.'],
  ['style/vague', 'Unfalsifiable instruction — no output could violate it.'],
  ['style/persona', 'Persona preamble in a repository file.'],
];

const SEVERITY_RANK = { info: 0, warn: 1, error: 2 };

export function analyzeText({ file, text, ctx, options = {} }) {
  const blocks = parseBlocks(text);
  const ignore = new Set(options.ignore ?? []);
  const findings = [];

  for (const rule of RULES) {
    if (ignore.has(rule.id)) continue;
    for (const f of rule.run({ blocks, text, ctx, options, file })) {
      if (ignore.has(f.rule)) continue;
      findings.push({ ...f, line: f.line ?? f.block?.start ?? 1, file });
    }
  }

  findings.sort((a, b) => a.line - b.line || SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity]);

  const budget = budgetReport(text, options);
  const min = minimize(text, blocks, findings);
  const afterTokens = estimateTokens(min.text);

  return {
    file,
    text,
    blocks,
    findings,
    budget,
    minimized: min.text,
    removedBlocks: min.removedBlocks,
    removedLines: min.removedLines,
    tokensBefore: budget.tokens,
    tokensAfter: afterTokens,
    tokensSaved: Math.max(0, budget.tokens - afterTokens),
    directives: extractDirectives(blocks),
    counts: countBy(findings),
  };
}

export function analyzeFiles(files, { root = process.cwd(), options = {}, scan = true } = {}) {
  const ctx = scan ? scanRepo(root) : emptyContext(root);
  const results = files.map((file) => analyzeText({
    file,
    text: fs.readFileSync(path.resolve(root, file), 'utf8'),
    ctx,
    options,
  }));
  addCrossFileFindings(results, options);
  return { ctx, results };
}

/**
 * Two instruction files in one repo (AGENTS.md and CLAUDE.md is the usual
 * pair) are frequently near-copies. Both get loaded, so the overlap is billed
 * twice per turn — and the copies drift.
 */
export function addCrossFileFindings(results, options = {}) {
  if (results.length < 2 || (options.ignore ?? []).includes('repo/cross-file')) return;
  for (let i = 0; i < results.length; i++) {
    for (let j = i + 1; j < results.length; j++) {
      const a = results[i];
      const b = results[j];
      const shared = [];
      for (const db of b.directives) {
        const hit = a.directives.find((da) => jaccard(da.key, db.key) >= 0.85);
        if (hit) shared.push({ a: hit, b: db });
      }
      if (!shared.length || shared.length / Math.max(1, b.directives.length) < 0.3) continue;
      const line = shared[0].b.block.start;
      b.findings.push({
        rule: 'repo/cross-file',
        severity: 'warn',
        file: b.file,
        line,
        block: null,
        excerpt: null,
        removable: false,
        message: `${shared.length} of ${b.directives.length} rules also appear in ${a.file}.`,
        why: 'Both files are loaded by their respective harnesses, so shared rules are paid for twice and drift apart independently. Keep one source of truth and have the other file point at it.',
      });
      b.findings.sort((x, y) => x.line - y.line);
      b.counts = countBy(b.findings);
    }
  }
}

/** Instruction files present in a repo, in load order. */
export function discoverTargets(root) {
  const found = [];
  for (const rel of KNOWN_TARGETS) {
    if (fs.existsSync(path.join(root, rel))) found.push(rel);
  }
  return found;
}

function countBy(findings) {
  const counts = { error: 0, warn: 0, info: 0 };
  for (const f of findings) counts[f.severity] = (counts[f.severity] ?? 0) + 1;
  return counts;
}

export { budgetReport, estimateTokens, scanRepo, parseBlocks, minimize };
