import { extractDirectives, jaccard, overlap, sharedCount, exclusiveConflict, isScoped } from '../directives.js';
import { exists } from '../context.js';
import { plain } from '../parse.js';

const CONFLICT_SIMILARITY = 0.6;
const DUPLICATE_SIMILARITY = 0.85;

// Properties where two rules can disagree numerically without sharing any
// negation. "Indent with 2 spaces" and "use a 4-space indent" both read as
// positive instructions; only the number reveals the conflict.
const NUMERIC_PROPS = [
  { id: 'line length', re: /\b(line[- ](?:length|width)|max(?:imum)? line|columns?|char(?:acter)?s? per line)\b/i },
  { id: 'indent width', re: /\b(indent(?:ation)?|tab width|tab size)\b/i },
  { id: 'file length', re: /\b(lines per file|file (?:length|size)|max(?:imum)? file)\b/i },
  { id: 'function length', re: /\b(lines per function|function (?:length|size))\b/i },
];

const REFERENCE_VERB = /\b(see|follow|read|refer to|per|described in|documented in|defined in|listed in|according to|as in)\b/i;
const PATH_CANDIDATE = /(?:^|[\s(`"'[])((?:\.\/)?[\w.@-]+(?:\/[\w.@*-]+)+\/?|[\w.@-]+\.(?:md|mdx|json|ya?ml|toml|cfg|ini|txt))/g;
const PLACEHOLDER = /(^|\/)(path|dir|folder|your|some|example|foo|bar|baz|my)([-_/]|$)/i;
const DOC_EXT = /\.(md|mdx|json|ya?ml|toml|cfg|ini|txt)$/i;

export const logicRules = {
  id: 'logic',
  run({ blocks, ctx }) {
    const findings = [];
    const directives = extractDirectives(blocks);

    for (let i = 0; i < directives.length; i++) {
      for (let j = i + 1; j < directives.length; j++) {
        const a = directives[i];
        const b = directives[j];
        if (a.block === b.block && a.text === b.text) continue;

        const sim = jaccard(a.key, b.key);

        // Opposite polarity needs a looser similarity test than duplication:
        // "Always add JSDoc comments to exported functions" and "Never add
        // comments" share only two content words, yet cannot both be obeyed.
        // The overlap coefficient (shared / smaller set) catches the case
        // where one rule is a short blanket version of the other.
        if (a.negative !== b.negative
            && (sim >= CONFLICT_SIMILARITY
              || (overlap(a.key, b.key) >= 0.5 && sharedCount(a.key, b.key) >= 2))) {
          findings.push(conflict(a, b, 'opposite polarity on the same subject'));
          continue;
        }

        if (!a.negative && !b.negative) {
          const group = exclusiveConflict(a.key, b.key);
          if (group) {
            findings.push(conflict(a, b, `mutually exclusive choice (${group.join(' / ')})`));
            continue;
          }
        }

        const num = numericConflict(a, b);
        if (num) {
          findings.push(conflict(a, b, `${num.prop}: ${num.left} vs ${num.right}`));
          continue;
        }

        if (sim >= DUPLICATE_SIMILARITY && a.negative === b.negative) {
          findings.push({
            rule: 'style/duplicate',
            severity: 'warn',
            block: b.block,
            excerpt: b.text,
            message: `Repeats the rule on line ${a.block.start} ("${truncate(a.text)}").`,
            why: 'Repetition does not increase compliance; it increases the per-turn token bill and the odds that the two copies drift apart.',
            removable: true,
            related: a.block.start,
          });
        }
      }
    }

    findings.push(...danglingReferences(blocks, ctx));
    return findings;
  },
};

function conflict(a, b, reason) {
  const scoped = isScoped(a.text) || isScoped(b.text);
  return {
    rule: 'logic/contradiction',
    severity: scoped ? 'warn' : 'error',
    block: b.block,
    excerpt: b.text,
    message: scoped
      ? `Overlaps line ${a.block.start} ("${truncate(a.text)}") — ${reason}; one of them is scoped, so this may be an exception rather than a conflict.`
      : `Conflicts with line ${a.block.start} ("${truncate(a.text)}") — ${reason}.`,
    why: scoped
      ? 'If this is an exception, say so in the rule itself ("…except in X") so the agent does not have to infer the precedence. If it is not, one of the two has to go.'
      : 'No file can satisfy both rules. The agent will silently pick one, and which one it picks may vary between runs — which looks like the agent ignoring your instructions.',
    // Never auto-resolved: choosing the surviving rule is the author's call.
    removable: false,
    related: a.block.start,
  };
}

function numericConflict(a, b) {
  for (const prop of NUMERIC_PROPS) {
    if (!prop.re.test(a.text) || !prop.re.test(b.text)) continue;
    const left = firstNumber(a.text);
    const right = firstNumber(b.text);
    if (left == null || right == null || left === right) continue;
    return { prop: prop.id, left, right };
  }
  return null;
}

function firstNumber(text) {
  const m = plain(text).match(/\b(\d{1,4})\b/);
  return m ? Number(m[1]) : null;
}

// "Rules no file could satisfy": a directive that points at something which is
// not in the repository. These are the quietest failure mode — the agent reads
// the pointer, finds nothing, and improvises.
function danglingReferences(blocks, ctx) {
  if (!ctx.files.size && !ctx.dirs.size) return [];
  const findings = [];
  const seen = new Set();

  for (const block of blocks) {
    if (block.type === 'code' || block.type === 'heading') continue;
    const text = block.text;
    PATH_CANDIDATE.lastIndex = 0;
    let m;
    while ((m = PATH_CANDIDATE.exec(text))) {
      const raw = m[1].replace(/[.,)`'"\]]+$/, '');
      if (!isCheckable(raw, text, ctx)) continue;
      if (exists(ctx, raw)) continue;
      const key = `${block.start}:${raw}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const directive = REFERENCE_VERB.test(text);
      findings.push({
        rule: 'logic/unsatisfiable',
        severity: directive ? 'error' : 'warn',
        block,
        excerpt: plain(text).slice(0, 160),
        message: `References \`${raw}\`, which does not exist in this repository.`,
        why: directive
          ? 'The agent is told to follow a document it cannot open. It will either ask, or guess and carry on — usually the second.'
          : 'A path that no longer exists teaches the agent a layout the repo does not have.',
        removable: false,
      });
    }
  }
  return findings;
}

function isCheckable(raw, context, ctx) {
  if (/^(https?:|mailto:|\/\/)/.test(raw) || raw.includes('://')) return false;
  if (/[*?<>{}$]/.test(raw)) return false;
  if (PLACEHOLDER.test(raw)) return false;
  if (raw.startsWith('node_modules/') || raw.startsWith('~/') || raw.startsWith('/')) return false;
  if (/^\d/.test(raw)) return false;
  const first = raw.replace(/^\.\//, '').split('/')[0];
  // Only check paths we have grounds to believe are repo-relative.
  if (ctx.dirs.has(first) || ctx.files.has(first)) return true;
  if (DOC_EXT.test(raw) && REFERENCE_VERB.test(context)) return true;
  return false;
}

function truncate(text, max = 60) {
  const t = plain(text);
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}
