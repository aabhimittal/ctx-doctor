// Input prices in USD per million tokens. Instruction files are input-only:
// they are prepended to the request and re-sent on every turn of a session,
// so output pricing never applies to them.
//
// Cached reads are billed at 10% of the base input rate on Anthropic models;
// whether your instruction file actually lands inside a cached prefix depends
// on the harness, so ctx-doctor reports both the cached and uncached figure.
export const CACHE_READ_MULTIPLIER = 0.1;

export const MODELS = {
  'claude-opus-5': { label: 'Claude Opus 5', input: 5.0 },
  'claude-opus-4-8': { label: 'Claude Opus 4.8', input: 5.0 },
  'claude-sonnet-5': { label: 'Claude Sonnet 5', input: 2.0 },
  'claude-sonnet-4-6': { label: 'Claude Sonnet 4.6', input: 3.0 },
  'claude-haiku-4-5': { label: 'Claude Haiku 4.5', input: 1.0 },
  'claude-fable-5-1': { label: 'Claude Fable 5.1', input: 10.0 },
};

export const DEFAULT_MODEL = 'claude-opus-5';

/**
 * Advisory budgets, in estimated tokens.
 *
 * These are NOT vendor-published hard limits. No major agent harness documents
 * a byte or token cap at which it truncates an instruction file, and claiming
 * otherwise would be making numbers up. What is documented, and what these
 * budgets encode, is that the file is loaded into every session and competes
 * with the actual task for attention and context. Override with --budget.
 */
export const BUDGETS = {
  good: 500,
  warn: 1500,
  error: 4000,
};

/** Instruction files that agent harnesses load automatically. */
export const KNOWN_TARGETS = [
  'AGENTS.md',
  'CLAUDE.md',
  '.cursorrules',
  '.windsurfrules',
  '.clinerules',
  '.github/copilot-instructions.md',
  '.claude/CLAUDE.md',
  '.cursor/rules/index.mdc',
];
