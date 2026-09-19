# agentsmd-doctor

```
$ npx agentsmd-doctor --headline
AGENTS.md (~339 tokens) costs $0.042 per 25-turn session, contradicts itself in 4 places, points at 1 file that does not exist, and 57% of it is removable.
```

<sub>Real output, against <a href="examples/messy-repo">examples/messy-repo</a>.</sub>

A linter for agent instruction files — `AGENTS.md`, `CLAUDE.md`, `.cursorrules`,
`.github/copilot-instructions.md`. It reads your file and your repository and
reports what the file costs, what it repeats, and what it contradicts. Then it
writes a minimized version and shows you the diff.

With `ablate`, it goes further and measures which of your rules actually change
what the model does.

Zero dependencies. No build step. The linter never makes a network call.

```bash
npx agentsmd-doctor            # lint every instruction file in the repo
npx agentsmd-doctor --diff     # show the minimized version as a patch
npx agentsmd-doctor --fix      # apply it
npx agentsmd-doctor ablate     # measure which rules earn their tokens
```

## Why this is worth running

Three of the things it finds are not matters of opinion, and need no research to
justify:

1. **Cost.** The file is prepended to every request and re-sent as input on
   every turn. A 4,000-token `AGENTS.md` on a 25-turn session is 100,000 input
   tokens before the agent reads a line of your code. That is arithmetic.
2. **Contradictions.** Two rules that cannot both be obeyed. The agent picks
   one, possibly a different one each run, and you read the result as "it
   ignored my instructions."
3. **Rules pointing at files that do not exist.** Nobody thinks an agent should
   be told to follow `docs/CONTRIBUTING.md` when there is no such file. It
   raises no error; the agent just improvises.

A fourth category — that filler competes for attention with the task — is a
claim, not arithmetic. `ablate` is how you check it on your own file instead of
taking anyone's word for it.

## The static linter

| Rule | Finds |
|---|---|
| `budget/tokens` | File over its token budget; reports per-turn and per-session cost |
| `repo/script` | Commands already declared in `package.json` scripts or the Makefile |
| `repo/structure` | Directory descriptions and hand-maintained ASCII trees |
| `repo/stack` | "This project uses X" where X is visible from config files |
| `repo/cross-file` | `AGENTS.md` and `CLAUDE.md` restating each other — billed twice |
| `logic/contradiction` | Opposite-polarity rules, mutually exclusive choices, numeric conflicts |
| `logic/unsatisfiable` | Rules pointing at files or directories that do not exist |
| `style/duplicate` | The same rule stated twice |
| `style/vague` | Instructions no output could violate |
| `style/persona` | Persona preambles in a repository file |

`--list-rules` prints them; `--ignore repo/stack,style/persona` turns them off,
as does an `ignore` array in `ctx-doctor.config.json`.

Against [`examples/messy-repo`](examples/messy-repo):

```
AGENTS.md  ~339 tokens · 1.2 KB · budget 1,500
  cost  $0.0017/turn · $0.042/session (25 turns, Claude Opus 5) · $0.006 if cached

   warn AGENTS.md:11  repo/structure
        Directory tree of 6 entries; 6 of them exist on disk right now.
        > src/ …(6 lines)
  error AGENTS.md:37  logic/contradiction
        Conflicts with line 36 ("Always add JSDoc comments to exported functions.") — opposite polarity on the same subject.
        > Never add comments; the code should speak for itself.
  error AGENTS.md:51  logic/unsatisfiable
        References `docs/CONTRIBUTING.md`, which does not exist in this repository.
        > See the contribution guide in docs/CONTRIBUTING.md for the full workflow.

  minimized 339 → 145 tokens (-57%), 23 lines removed
            saves ~$0.024 per 25-turn session on Claude Opus 5
```

### What `--fix` will and will not do

It removes blocks where *every* rule-bearing sentence was flagged removable:
redundancy, duplicates, filler, persona lines. It never touches contradictions
(choosing which rule survives is a decision about your project), dangling
references (either the file should exist or the rule should not), or a paragraph
that mixes filler with a real rule. Run `--diff` first.

## `ablate` — which rules actually do anything

The linter tells you a rule is redundant or unfalsifiable. It cannot tell you a
rule changes behaviour. `ablate` measures that directly:

> For each rule: run your tasks with the intact file, run them again with that
> one rule deleted, grade both against that rule alone, and report the
> difference with a confidence interval.

```bash
npx agentsmd-doctor ablate --init          # scaffold a task file from your bullets
$EDITOR ctx-doctor.tasks.json              # fill in real tasks
npx agentsmd-doctor ablate --dry-run       # see the plan and the price
npx agentsmd-doctor ablate --trials 22 --yes
```

The output has this shape. **The numbers below come from this package's test
stub, not from a real measurement.** No honest sample exists until you run it on
your own file and your own tasks — quoting someone else's ablation as if it were
yours is precisely the error this subcommand exists to prevent.

```
ablation  3 rules × 1 task × 22 trials/arm
  model claude-opus-5 · judge claude-sonnet-5 · 88 calls · $0.31 spent

  rule                 with  without           delta  verdict
  no-comments         22/22     0/22     +1.00 ±0.14  carries weight
  write-clean-code    22/22    22/22     +0.00 ±0.14  no measurable effect
  persona             22/22    22/22     +0.00 ±0.14  no measurable effect

  1 of 3 rules measurably changed compliance.
  2 had no measurable effect at ±0.15 — deleting them is free
```

Design decisions that matter for whether you believe the numbers:

- **One rule per arm.** Every arm differs from the control by exactly one
  deleted block, so a delta is attributable. Measuring every subset would be
  2ⁿ runs; this is n+1. The cost is that rules which only matter *together* are
  invisible, and the report says so.
- **Three verdicts, not two.** `carries-weight`, `no-effect`, and
  `inconclusive` are distinct. A wide interval around zero means *you did not
  run enough trials* — it is never reported as evidence the rule is useless.
  Unanimous arms get a rule-of-three floor on the interval, so 5/5 vs 5/5 reads
  as inconclusive, which it is.
- **Blind grading.** Rules with a deterministic `check` (a regex) are graded
  for free and exactly. Everything else goes to a judge model that sees one
  rule and one output and never learns which arm produced it.
- **`na` is not a violation.** An output that had no occasion to apply the rule
  is dropped from the denominator rather than scored against it.
- **Nothing runs without `--yes`.** The estimated cost is printed first, every
  time.

What it does **not** measure: output quality. It measures compliance with each
rule, which is the question "is this line doing anything?" — not "is my agent
better?" Those are different studies and conflating them would be dishonest.

Task file format:

```json
{
  "tasks": [{ "id": "health", "prompt": "Add a GET /health endpoint to src/server.ts." }],
  "rules": [
    { "id": "no-comments", "match": "Never add comments", "check": { "notRegex": "//" } },
    { "id": "write-clean-code", "match": "Write clean, maintainable code", "check": null }
  ]
}
```

`match` is any substring of the rule as written in your file. `check` keys:
`contains`, `notContains`, `regex`, `notRegex`, `applies`, `flags`. A `null`
check falls back to the judge. Omit `rules` entirely and every bullet in the
file becomes a candidate.

Requires `ANTHROPIC_API_KEY`. Honours `ANTHROPIC_BASE_URL` if you route through
a gateway.

## Options

```
ctx-doctor [files...]
  --root <dir>       repository root to analyze against  (default: cwd)
  --model <id>       pricing model                       (default: claude-opus-5)
  --turns <n>        turns per session for cost math     (default: 25)
  --budget <n>       token budget before warning         (default: 1500)
  --headline         print only the one-line summary
  --diff             print the minimized file as a unified diff
  --fix              write the minimized file in place
  --json             machine-readable output
  --ignore <ids>     comma-separated rule ids to skip
  --fail-on <level>  error | warn | never                (default: error)
  --no-scan          do not read the repo; skips repo/* rules
  --verbose, -v      include the rationale for each finding

ctx-doctor ablate [file]
  --init             scaffold a task file from your bullets
  --tasks <file>     task file            (default: ctx-doctor.tasks.json)
  --trials <n>       trials per arm       (default: 8; 22+ resolves a 0.3 effect)
  --model <id>       model under test     (default: claude-opus-5)
  --judge-model <id> grader               (default: claude-sonnet-5)
  --concurrency <n>  parallel requests    (default: 4)
  --dry-run          print the plan and cost, call nothing
  --yes              actually run it
  --out <file>       write the full run record as JSON
```

Exit code is `1` when something at or above `--fail-on` is found, `0` otherwise,
`2` on a usage error:

```yaml
- run: npx agentsmd-doctor --fail-on error
```

## Where the numbers come from

**Token counts are estimated, not exact.** This package ships no tokenizer:
every vendor's BPE vocabulary differs, and a linter that needs a multi-megabyte
wasm blob does not get run in CI. The estimator models word, number and
punctuation behaviour directly and lands within roughly ±15% on prose-heavy
markdown, over-estimating on dense code fences. For an exact figure, use your
vendor's token-counting endpoint; this tool's job is to tell you whether a file
is 300 tokens or 3,000.

**Prices are Anthropic first-party rates**, in `src/models.js`, per million
tokens. Cached figures assume a cached read at 10% of the base input rate and
that your file lands inside the cached prefix — which depends on your harness,
so both numbers are shown.

**Budgets are advisory.** The 1,500-token default is an opinion, not a vendor
limit. No major agent harness publishes a size at which it truncates your
instruction file, and this tool will not invent one.

## Honest limitations

- **The static heuristics are opinionated and will produce false positives.** A
  structure note can be load-bearing precisely because the layout is
  surprising. Read the diff; `--ignore` what does not apply.
- **The repo scan is shallow** — 5 levels, 8,000 entries, skipping
  `node_modules` and friends. The CLI says so when it hits the cap.
- **Ablation measures compliance, not quality**, one rule at a time, on the
  tasks you supply. Different tasks give different answers; that is a property
  of the question, not a bug.
- **Small runs prove little.** At 8 trials per arm only large effects separate
  from zero. The report tells you how many trials you need.

## Use as a library

```js
import { analyzeFiles } from 'agentsmd-doctor';

const { results } = analyzeFiles(['AGENTS.md'], { root: process.cwd() });
console.log(results[0].tokensBefore, results[0].findings);
```

## Development

```bash
npm test             # node:test, no dependencies; network code runs against a local stub
npm run selfcheck    # the tool lints its own AGENTS.md
```

MIT.
