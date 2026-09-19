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
export function verdict(diff, meaningful = 0.15) {
  if (diff.decided) return diff.delta > 0 ? 'carries-weight' : 'harmful';
  return diff.half <= meaningful ? 'no-effect' : 'inconclusive';
}

/**
 * Trials per arm needed to resolve an effect of `effect` at the worst-case
 * variance. Printed alongside inconclusive rows so "run more" has a number.
 */
export function trialsNeeded(effect = 0.3, z = Z) {
  return Math.ceil((2 * z * z * 0.25) / (effect * effect));
}
