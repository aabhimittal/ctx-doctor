# AGENTS.md

Lint this file with `node bin/cli.js --fail-on warn` before committing changes to it.

## Constraints

- No runtime dependencies, ever. `package.json` must have no `dependencies` block.
- No build step: `bin/cli.js` runs the sources in `src/` directly.
- Node 18 is the floor. Do not use APIs newer than that.
- Only `src/ablate/` may make network calls, and only behind an explicit opt-in
  flag: `--yes`, `--check` or `--calibrate`.

## Adding a rule

- A rule module exports `{ id, run({ blocks, text, ctx, options, file }) }` and returns findings.
- Every finding needs a `why` that names the cost, not just the smell. A finding
  a reader cannot act on is noise.
- Register the rule in `RULES` and its ids in `RULE_IDS`, both in `src/index.js`.
- Set `removable: true` only when deleting the block loses no information. A
  contradiction is never removable: choosing the surviving rule is the author's call.
- Add a test that the rule fires, and a test that a near-miss does not.

## Heuristics

- Prefer a missed finding over a false one. A linter that cries wolf gets turned off.
- Widen a pattern only with a test for the case that made you widen it.

## Measurement

- Never report a wide confidence interval as evidence of no effect. `inconclusive`
  and `no-effect` are different verdicts and must stay that way.
- The judge sees one rule and one output, never which arm produced it.
- Tests for network code run against a local stub over `ANTHROPIC_BASE_URL`.
- Rules in one ablation share a control arm, so correct for multiple comparisons
  before calling any of them significant.
- Quote a cost estimate only from exact call arithmetic, never a rounded guess.
