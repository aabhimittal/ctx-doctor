import { estimateTokens, costOf } from '../tokens.js';
import { MODELS, DEFAULT_MODEL, BUDGETS, CACHE_READ_MULTIPLIER } from '../models.js';

/**
 * Cost model. An instruction file is not paid for once: the harness prepends
 * it to the request, and every turn of the session re-sends the whole
 * conversation as input. So the per-session cost scales with turn count, not
 * with file count — which is why a 4,000-token AGENTS.md is a recurring bill,
 * not a one-off.
 */
export function budgetReport(text, options = {}) {
  const model = MODELS[options.model] ? options.model : DEFAULT_MODEL;
  const turns = options.turns ?? 25;
  const budget = options.budget ?? BUDGETS.warn;
  const hard = options.hardBudget ?? Math.max(budget * 2, BUDGETS.error);
  const rate = MODELS[model].input;

  const tokens = estimateTokens(text);
  const perTurn = costOf(tokens, rate);
  const uncached = perTurn * turns;
  const cached = perTurn + perTurn * CACHE_READ_MULTIPLIER * (turns - 1);

  return {
    model,
    modelLabel: MODELS[model].label,
    turns,
    budget,
    hard,
    tokens,
    bytes: Buffer.byteLength(text, 'utf8'),
    costPerTurn: perTurn,
    costPerSession: uncached,
    costPerSessionCached: cached,
    over: tokens > budget,
    wayOver: tokens > hard,
  };
}

export const budgetRules = {
  id: 'budget',
  run({ text, options }) {
    const r = budgetReport(text, options);
    if (!r.over) return [];
    return [{
      rule: 'budget/tokens',
      severity: r.wayOver ? 'error' : 'warn',
      block: null,
      line: 1,
      excerpt: null,
      message: `~${r.tokens} tokens, over the ${r.budget}-token budget${r.wayOver ? ` and past the ${r.hard}-token ceiling` : ''}.`,
      why: `At ${r.turns} turns on ${r.modelLabel} this file alone costs ~$${r.costPerSession.toFixed(3)} per session (~$${r.costPerSessionCached.toFixed(3)} if it stays inside a cached prefix). The budget is advisory, not a vendor limit — no major harness publishes a truncation point. The cost that is not advisory is attention: every token here is a token the model spends on something other than the task.`,
      removable: false,
    }];
  },
};
