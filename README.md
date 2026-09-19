# ctx-doctor

A static linter for agent instruction files — `AGENTS.md`, `CLAUDE.md`, `.cursorrules`,
`.github/copilot-instructions.md` and friends.

It reads the file and the repository, and reports what the file costs, what it
repeats, and what it contradicts. Then it writes a minimized version and shows
you the diff.

No agent runs. No API key. No dependencies.

```bash
npx ctx-doctor            # lint every instruction file in the repo
npx ctx-doctor --diff     # show the minimized version as a patch
npx ctx-doctor --fix      # apply it
```

## The claim

An instruction file is not documentation. It is a prefix that gets prepended to
every request in a session and re-sent as input on every turn. That makes three
things true at once:

1. **It has a recurring price.** A 4,000-token `AGENTS.md` on a 25-turn session
   is 100,000 input tokens, before the agent has read a single line of your code.
2. **It competes with the task.** Every token spent telling the model what
   `src/` contains is a token not spent on the bug you asked it to fix.
3. **Its worst failures are silent.** A rule pointing at a deleted file, or two
   rules that cannot both be obeyed, does not raise an error. The agent picks
   one, or improvises, and you read the result as "it ignored my instructions".

Most instruction files in the wild are majority filler: the stack (visible in
`package.json`), the layout (visible from `ls`), the commands (visible in
`scripts`), and unfalsifiable advice ("write clean code"). ctx-doctor finds that
mechanically, and everything it flags, it explains.

## What it checks

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

`ctx-doctor --list-rules` prints this list. `--ignore repo/stack,style/persona`
turns rules off; so does an `ignore` array in `ctx-doctor.config.json`.

## Example

Against [`examples/messy-repo`](examples/messy-repo):

```
AGENTS.md  ~339 tokens · 1.2 KB · budget 1,500
  cost  $0.0017/turn · $0.042/session (25 turns, Claude Opus 5) · $0.006 if cached

   warn AGENTS.md:7   repo/stack
        Names `typescript`, `vitest`, `eslint`, already visible from config files and the manifest.
        > This project uses TypeScript, Vitest and ESLint.
   warn AGENTS.md:11  repo/structure
        Directory tree of 6 entries; 6 of them exist on disk right now.
        > src/ …(6 lines)
  error AGENTS.md:37  logic/contradiction
        Conflicts with line 36 ("Always add JSDoc comments to exported functions.") — opposite polarity on the same subject.
        > Never add comments; the code should speak for itself.
  error AGENTS.md:41  logic/contradiction
        Conflicts with line 40 ("Keep line length under 80 characters.") — line length: 80 vs 120.
        > The maximum line length is 120 characters.
  error AGENTS.md:51  logic/unsatisfiable
        References `docs/CONTRIBUTING.md`, which does not exist in this repository.
        > See the contribution guide in docs/CONTRIBUTING.md for the full workflow.

  minimized 339 → 145 tokens (-57%), 23 lines removed
            saves ~$0.024 per 25-turn session on Claude Opus 5
```

`--diff` turns that into a patch you can review line by line. `-v` adds the
rationale for every finding.

## What `--fix` will and will not do

It removes blocks where *every* rule-bearing sentence was flagged removable:
redundancy, duplicates, filler, persona lines.

It never touches:

- **Contradictions.** Choosing which of two rules survives is a decision about
  your project, not about your text.
- **Dangling references.** Either the file should exist or the rule should not;
  a linter cannot know which.
- **Mixed blocks.** A paragraph with one filler sentence and one real rule is
  left alone and reported as manual work.

Run `--diff` first. The heuristics are opinionated and will occasionally be
wrong about your file.

## Options

```
--root <dir>       repository root to analyze against  (default: cwd)
--model <id>       pricing model                       (default: claude-opus-5)
--turns <n>        turns per session for cost math     (default: 25)
--budget <n>       token budget before warning         (default: 1500)
--diff             print the minimized file as a unified diff
--fix              write the minimized file in place
--json             machine-readable output
--ignore <ids>     comma-separated rule ids to skip
--fail-on <level>  error | warn | never                (default: error)
--no-scan          do not read the repo; skips repo/* rules
--verbose, -v      include the rationale for each finding
--list-rules       print rule ids and exit
```

Exit code is `1` when something at or above `--fail-on` is found, `0` otherwise,
`2` on a usage error — so it drops into CI unchanged:

```yaml
- run: npx ctx-doctor --fail-on error
```

Optional `ctx-doctor.config.json` at the repo root:

```json
{ "model": "claude-sonnet-5", "turns": 40, "budget": 1200, "ignore": ["style/persona"] }
```

## Where the numbers come from, and how much to trust them

**Token counts are estimated, not exact.** ctx-doctor ships no tokenizer: every
vendor's BPE vocabulary differs, and a linter that needs a multi-megabyte wasm
blob does not get run in CI. The estimator models word, number and punctuation
behaviour directly and lands within roughly ±15% on prose-heavy markdown. It
over-estimates on dense code fences, where real BPE merges common n-grams. If
you need an exact figure for a specific model, use that vendor's token-counting
endpoint; ctx-doctor's job is to tell you whether a file is 300 tokens or 3,000,
and for that the estimate is more than good enough.

**Prices are Anthropic first-party input rates**, in `src/models.js`, per million
tokens. Cached figures assume a cached read at 10% of the base input rate and
that your file actually lands inside the cached prefix — which depends on your
harness, so both numbers are shown. Output pricing never applies: an instruction
file is input only.

**Budgets are advisory.** The `--budget` default of 1,500 tokens is an opinion,
not a vendor limit. No major agent harness publishes a size at which it
truncates your instruction file, and ctx-doctor will not invent one. What is not
an opinion is that the file is re-sent every turn and competes for attention
with the task. Set `--budget` to whatever your team will actually hold to.

## Honest limitations

- **The heuristics are opinionated and will produce false positives.** A
  structure note can be load-bearing precisely because the layout is
  surprising. A "we use X" line can matter when two competing tools are both
  installed. Read the diff; `--ignore` what does not apply.
- **It measures cost and consistency, not effect.** ctx-doctor cannot tell you
  that removing a rule improved your agent's output — only that the rule was
  redundant, contradictory, or unfalsifiable. Establishing that a rule changes
  behaviour needs an ablation: run the same task with and without it, many
  times, and score the results. That is expensive, it needs an API key, and it
  is out of scope for v1.
- **The repo scan is shallow.** It walks up to 5 levels and 8,000 entries,
  skipping `node_modules` and friends. In a very large monorepo some `repo/*`
  checks will be incomplete; the CLI says so when the cap is hit.
- **It only reads one repo's files.** Rules that restate something true of your
  organization rather than your repository will not be detected as redundant.

## Use as a library

```js
import { analyzeFiles } from 'ctx-doctor';

const { results } = analyzeFiles(['AGENTS.md'], { root: process.cwd() });
console.log(results[0].tokensBefore, results[0].findings);
```

## Development

```bash
npm test             # node:test, no dependencies
npm run selfcheck    # ctx-doctor lints its own AGENTS.md
```

MIT.
