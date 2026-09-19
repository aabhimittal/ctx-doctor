import { plain } from '../parse.js';
import { splitSentences } from '../directives.js';
import { exists } from '../context.js';

// A rule earns its tokens only if it tells the agent something it cannot
// observe. Everything below is observable: the agent can read package.json,
// list the tree, and see which config files exist. Restating it costs tokens
// on every turn and buys nothing.

const CONDITIONAL = /\b(before|after|when|unless|only|if|once|prior to|instead of|except|never|always|must)\b/i;
const SCRIPT_CALL = /\b(npm run|npm|yarn run|yarn|pnpm run|pnpm|bun run|bun|make)\s+([a-zA-Z0-9:_-]+)/g;
const BUILTIN_NPM = new Set(['test', 'start', 'install', 'ci', 'publish', 'run']);

const STRUCTURE_PROSE = [
  /(?:^|\s)`?([\w.@/-]+\/)`?\s*[-–—:]?\s*(contains|holds|houses|stores|is where|has all|includes)\b/i,
  /\bthe\s+`?([\w./-]+)`?\s+(?:directory|folder|dir)\s+(contains|holds|houses|is|has|stores)\b/i,
  /\b(?:source|test|doc)s?\s+(?:code\s+)?(?:lives?|are|is)\s+in\s+`?([\w./-]+)`?/i,
];

const STACK_PREFIX = /^(this (project|repo|repository|codebase) (uses|is (built|written) (with|in|using))|we use|the (project|codebase|repo) uses|built (with|on|using)|tech stack|stack:|written in)/i;
const STACK_CONSTRAINT = /\b(only|never|always|must|instead|rather|except|prefer|avoid|version|v?\d+\.\d+)\b/i;

const LICENSE_FACT = /\b(mit|apache|gpl|agpl|bsd|isc|mpl)\b.{0,20}\blicen[cs]e/i;

export const redundantRules = {
  id: 'repo',
  run({ blocks, ctx }) {
    const findings = [];
    const known = hasRepoKnowledge(ctx);

    for (const block of blocks) {
      if (block.type === 'heading') continue;

      if (block.type === 'code') {
        const tree = treeFinding(block, ctx);
        if (tree) findings.push(tree);
        const scriptDump = scriptDumpFinding(block, ctx);
        if (scriptDump) findings.push(scriptDump);
        continue;
      }

      for (const sentence of splitSentences(block.text)) {
        const text = plain(sentence);
        const wordCount = text.split(/\s+/).length;

        // --- restates an npm script or make target -------------------------
        if (known.scripts && !CONDITIONAL.test(text) && wordCount <= 25) {
          const hit = matchScript(sentence, ctx);
          if (hit) {
            findings.push({
              rule: 'repo/script',
              severity: 'warn',
              block,
              excerpt: text,
              message: `Restates \`${hit.command}\`, which is already declared in ${hit.source}.`,
              why: 'The agent reads the manifest before acting. Listing the command again adds tokens without adding information — unless you are stating *when* to run it, which this line does not.',
              removable: true,
            });
            continue;
          }
        }

        // --- restates the directory tree -----------------------------------
        if (known.tree && wordCount <= 30) {
          const dir = matchStructure(text, ctx);
          if (dir) {
            findings.push({
              rule: 'repo/structure',
              severity: 'warn',
              block,
              excerpt: text,
              message: `Describes \`${dir}\`, which the agent can see by listing the tree.`,
              why: 'Layout descriptions go stale silently and are re-derivable in one tool call. Keep a line about structure only when it explains a non-obvious convention, not where files are.',
              removable: true,
            });
            continue;
          }
        }

        // --- restates the stack ---------------------------------------------
        if (known.tools && STACK_PREFIX.test(text) && !STACK_CONSTRAINT.test(text) && wordCount <= 20) {
          const named = namedTools(text, ctx);
          if (named.length) {
            findings.push({
              rule: 'repo/stack',
              severity: 'warn',
              block,
              excerpt: text,
              message: `Names ${named.map((t) => `\`${t}\``).join(', ')}, already visible from config files and the manifest.`,
              why: 'Stack announcements are the most common filler in instruction files. Replace with the thing the config does not say: which of two overlapping tools wins, or which command is the blessed one.',
              removable: true,
            });
            continue;
          }
        }

        // --- restates license / readme trivia --------------------------------
        if (ctx.tools.has('license') && LICENSE_FACT.test(text) && wordCount <= 20) {
          findings.push({
            rule: 'repo/obvious',
            severity: 'info',
            block,
            excerpt: text,
            message: 'Restates the license, which is in LICENSE.',
            why: 'Licensing facts almost never change what an agent does to the code.',
            removable: true,
          });
        }
      }
    }
    return findings;
  },
};

function hasRepoKnowledge(ctx) {
  return {
    scripts: ctx.scripts.size > 0 || ctx.makeTargets.size > 0,
    tree: ctx.dirs.size > 0 || ctx.files.size > 0,
    tools: ctx.tools.size > 0,
  };
}

function matchScript(sentence, ctx) {
  SCRIPT_CALL.lastIndex = 0;
  let m;
  while ((m = SCRIPT_CALL.exec(sentence))) {
    const runner = m[1].toLowerCase();
    const name = m[2];
    if (runner === 'make') {
      if (ctx.makeTargets.has(name)) {
        return { command: `make ${name}`, source: 'the Makefile' };
      }
      continue;
    }
    if (ctx.scripts.has(name)) {
      return { command: `${runner} ${name}`, source: 'package.json scripts' };
    }
    if (BUILTIN_NPM.has(name) && ctx.scripts.has(name)) {
      return { command: `${runner} ${name}`, source: 'package.json scripts' };
    }
  }
  return null;
}

function matchStructure(text, ctx) {
  for (const re of STRUCTURE_PROSE) {
    const m = text.match(re);
    if (!m) continue;
    const candidate = (m[1] || '').replace(/[`.]$/, '');
    if (candidate && exists(ctx, candidate)) return candidate.replace(/\/$/, '');
  }
  return null;
}

function namedTools(text, ctx) {
  const words = text.toLowerCase().match(/[a-z0-9.+#-]+/g) ?? [];
  const found = new Set();
  for (const w of words) {
    const clean = w.replace(/[.,]$/, '');
    if (ctx.tools.has(clean)) found.add(clean);
  }
  return [...found];
}

// An ASCII tree in a fenced block: the single most expensive form of redundancy,
// since it is long, goes stale on the next mkdir, and is one `ls -R` away.
function treeFinding(block, ctx) {
  const lines = block.text.split('\n').filter((l) => l.trim());
  if (lines.length < 3) return null;
  const drawn = lines.filter((l) => /[│├└┬─]|^\s*[|`+\\][-\s]|^\s*[\w.@-]+\/\s*$/.test(l)).length;
  if (drawn / lines.length < 0.5) return null;

  const names = lines
    .map((l) => l.replace(/^[\s│├└─|`+\\_-]+/, '').split(/[\s#]/)[0].replace(/\/$/, ''))
    .filter((n) => n && /^[\w.@-]+$/.test(n));
  if (names.length < 3) return null;

  const seen = names.filter((n) => ctx.files.has(n) || ctx.dirs.has(n) || [...ctx.dirs].some((d) => d.endsWith(`/${n}`)) || [...ctx.files].some((f) => f.endsWith(`/${n}`)));
  if (seen.length / names.length < 0.6) return null;

  return {
    rule: 'repo/structure',
    severity: 'warn',
    block,
    excerpt: `${lines[0].trim()} …(${lines.length} lines)`,
    message: `Directory tree of ${names.length} entries; ${seen.length} of them exist on disk right now.`,
    why: 'A hand-maintained tree is the highest-token, fastest-rotting section of a typical instruction file. The agent can list the directory; it cannot know your tree is three commits out of date.',
    removable: true,
  };
}

function scriptDumpFinding(block, ctx) {
  if (!ctx.scripts.size) return null;
  const lines = block.text.split('\n').map((l) => l.trim()).filter(Boolean);
  if (lines.length < 2) return null;
  const hits = lines.filter((l) => {
    SCRIPT_CALL.lastIndex = 0;
    const m = SCRIPT_CALL.exec(l);
    return m && (ctx.scripts.has(m[2]) || ctx.makeTargets.has(m[2]));
  });
  if (hits.length < 2 || hits.length / lines.length < 0.6) return null;
  return {
    rule: 'repo/script',
    severity: 'warn',
    block,
    excerpt: `${lines[0]} …(${lines.length} lines)`,
    message: `Command block: ${hits.length}/${lines.length} lines are scripts already declared in the manifest.`,
    why: 'Copying the scripts block into the instruction file doubles the cost and creates a second source of truth that drifts.',
    removable: true,
  };
}
