// Small-sample statistics for compliance rates.
//
// The whole point of an ablation is to distinguish three outcomes, and a bare
// percentage distinguishes none of them:
//   1. the rule measurably changes behaviour
//   2. the rule measurably does NOT change behaviour
//   3. we did not run enough trials to tell
// Reporting (2) when the truth is (3) is how a linter earns a retraction.

const Z = 1.96; // 95%

/** Wilson score interval — behaves at n < 30 and at p near 0 or 1, unlike normal approximation. */
export function wilson(successes, n, z = Z) {
  if (!n) return { p: 0, lo: 0, hi: 1 };
  const p = successes / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const centre = (p + z2 / (2 * n)) / denom;
  const half = (z / denom) * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n));
  return { p, lo: Math.max(0, centre - half), hi: Math.min(1, centre + half) };
}

/**
 * Difference of two independent proportions (with arm minus without arm), with
 * a normal-approximation interval. Wide intervals are the honest answer at low
 * n; we do not narrow them by pretending the trials are paired.
 */
export function diffProportions(withSucc, withN, withoutSucc, withoutN, z = Z) {
  if (!withN || !withoutN) return { delta: 0, lo: -1, hi: 1, half: 1, decided: false };
  const p1 = withSucc / withN;
  const p2 = withoutSucc / withoutN;
  const delta = p1 - p2;
  const se = Math.sqrt((p1 * (1 - p1)) / withN + (p2 * (1 - p2)) / withoutN);
  // A zero standard error (both arms unanimous) still carries sampling
  // uncertainty. Floor the half-width with the rule of three — with no
  // failures in n trials the 95% bound on the failure rate is 3/n — so
  // 5/5 vs 5/5 never reads as a decided result.
  const floorHalf = 3 / Math.min(withN, withoutN);
  const half = Math.max(z * se, floorHalf);
  return { delta, lo: delta - half, hi: delta + half, half, decided: Math.abs(delta) > half };
}

/**
 * Verdict for one rule.
 * - `carries-weight`: the interval excludes zero.
 * - `no-effect`: the interval contains zero AND is tight enough that a
 *   practically meaningful effect would have shown up.
 * - `inconclusive`: the interval contains zero and is too wide to conclude.
 */
export function verdict(diff, { meaningful = 0.15, significant = diff.decided } = {}) {
  // Conservative by construction: a rule "carries weight" only if the interval
  // excludes zero AND it survives the family-wise correction below.
  if (diff.decided && significant) return diff.delta > 0 ? 'carries-weight' : 'harmful';
  return diff.half <= meaningful ? 'no-effect' : 'inconclusive';
}

/** Normal CDF (Abramowitz & Stegun 7.1.26); no dependency, ~1e-7 accurate. */
export function normalCdf(z) {
  const sign = z < 0 ? -1 : 1;
  const x = Math.abs(z) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * x);
  const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return 0.5 * (1 + sign * y);
}

/** Two-sided p for a pooled two-proportion z-test. */
export function twoProportionP(aSucc, aN, bSucc, bN) {
  if (!aN || !bN) return 1;
  const pooled = (aSucc + bSucc) / (aN + bN);
  const se = Math.sqrt(pooled * (1 - pooled) * (1 / aN + 1 / bN));
  if (se === 0) return aSucc / aN === bSucc / bN ? 1 : 0;
  const z = (aSucc / aN - bSucc / bN) / se;
  return 2 * (1 - normalCdf(Math.abs(z)));
}

/**
 * Holm-Bonferroni across the rules in one run.
 *
 * Every rule is tested against the SAME control arm, so a run of n rules is n
 * hypothesis tests. At 95% each, eight rules carry a ~34% chance that at least
 * one inert rule looks significant. Holm fixes the family-wise error rate
 * without assuming the tests are independent — which, sharing a control, they
 * are not.
 *
 * @returns {{p:number, adjusted:number, significant:boolean}[]} in input order
 */
export function holm(pValues, alpha = 0.05) {
  const m = pValues.length;
  const order = pValues.map((p, i) => ({ p, i })).sort((a, b) => a.p - b.p);
  const out = new Array(m);
  let running = 0;
  order.forEach(({ p, i }, rank) => {
    running = Math.min(1, Math.max(running, p * (m - rank)));
    out[i] = { p, adjusted: running, significant: running <= alpha };
  });
  return out;
}

/**
 * Trials per arm needed to resolve an effect of `effect` at the worst-case
 * variance. Printed alongside inconclusive rows so "run more" has a number.
 */
export function trialsNeeded(effect = 0.3, z = Z) {
  return Math.ceil((2 * z * z * 0.25) / (effect * effect));
}
