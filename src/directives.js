import { plain } from './parse.js';

// Words that carry no distinguishing meaning for rule-matching. Modality and
// negation are stripped deliberately: "always use tabs" and "never use tabs"
// must normalize to the SAME key so the polarity comparison can fire.
const STOP = new Set(`a an the this that these those it its is are be being been was were
to of in on for from with without into onto at by as and or but if when while
you your we our i me my they them their he she his her
do does did doing done please kindly just also very really quite
always never must should shall will would can could may might need needs needed
not no nor dont don doesnt isnt arent cant cannot wont avoid ensure make sure
all any every each some most more less than then so such via using use used uses
here there where what which who whom whose how why
code file files repo repository project codebase`.split(/\s+/));

const NEGATIVE = /\b(never|not|don'?t|do not|does ?n'?t|avoid|refrain|forbidden|prohibited|no longer|must not|should not|shouldn'?t|cannot|can'?t|won'?t|without)\b/i;
const STRONG = /\b(always|never|must|required|mandatory|do not|don'?t|under no circumstances)\b/i;
const IMPERATIVE = /\b(always|never|must|should|do not|don'?t|avoid|prefer|use|run|write|add|remove|keep|make|ensure|follow|call|put|place|name|commit|test|check|update|only|require)\b/i;

// Choices that are mutually exclusive: two positive rules naming different
// members of one group contradict each other even though neither is negated.
const EXCLUSIVE_GROUPS = [
  ['tab', 'tabs', 'space', 'spaces'],
  ['npm', 'yarn', 'pnpm', 'bun'],
  ['rebase', 'merge', 'squash'],
];

/** Crude suffix stemmer. Good enough to match "commits"/"committing"/"commit". */
export function stem(word) {
  let w = word;
  if (w.length > 5 && w.endsWith('ing')) w = w.slice(0, -3);
  else if (w.length > 4 && w.endsWith('ed')) w = w.slice(0, -2);
  else if (w.length > 4 && w.endsWith('ies')) w = `${w.slice(0, -3)}y`;
  // Only sibilants take "-es"; everything else is a plain "-s" plural, so
  // "spaces" must stem to "space", not "spac".
  else if (w.length > 4 && /(ss|sh|ch|x|z)es$/.test(w)) w = w.slice(0, -2);
  else if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss')) w = w.slice(0, -1);
  if (w.length > 4 && /(.)\1$/.test(w)) w = w.slice(0, -1); // commit<t>
  return w;
}

/** Content-word set used as a directive's identity. */
export function keyOf(text) {
  const words = plain(text)
    .toLowerCase()
    .replace(/[^a-z0-9/._-]+/g, ' ')
    .split(' ')
    // Keep dots and slashes inside a word (they carry paths) but never at the
    // edges, where they are just sentence punctuation.
    .map((w) => w.replace(/^[._/-]+/, '').replace(/[._/-]+$/, ''))
    .filter(Boolean)
    .filter((w) => !STOP.has(w) && w.length > 1)
    .map(stem);
  return new Set(words);
}

/**
 * Does this directive carve out a scope or an exception? "Use 4 spaces **for
 * JSON files**" does not contradict a 2-space default; it narrows it. Pairs
 * where either side is scoped are reported, but as a warning, not an error.
 */
const EXCEPTION = /\b(instead|except|unless|otherwise|apart from|other than|only (?:for|in|when|if)|for (?:all )?[\w.*-]+ (?:files?|modules?|packages?|code|tests?)|in (?:the )?[\w./-]+ (?:directory|folder|files?|tests?|packages?))\b/i;

export function isScoped(text) {
  return EXCEPTION.test(text) || /^(when|if|for|in|inside|within)\b/i.test(text.trim());
}

/** Overlap coefficient: shared words over the smaller set. */
export function overlap(a, b) {
  if (!a.size || !b.size) return 0;
  let shared = 0;
  for (const x of a) if (b.has(x)) shared++;
  return shared / Math.min(a.size, b.size);
}

export function sharedCount(a, b) {
  let shared = 0;
  for (const x of a) if (b.has(x)) shared++;
  return shared;
}

export function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let shared = 0;
  for (const x of a) if (b.has(x)) shared++;
  return shared / (a.size + b.size - shared);
}

/**
 * Two positive directives that pick different members of the same exclusive
 * group (tabs vs spaces, npm vs pnpm) once their other content words match.
 */
export function exclusiveConflict(a, b) {
  for (const raw of EXCLUSIVE_GROUPS) {
    const group = [...new Set(raw.map(stem))];
    const inA = group.filter((g) => a.has(g));
    const inB = group.filter((g) => b.has(g));
    if (!inA.length || !inB.length) continue;
    const same = inA.some((x) => inB.includes(x));
    if (same) continue;
    // Require the surrounding subject to match, else "use tabs in Go" and
    // "use spaces in Python" would be reported as a conflict.
    const restA = new Set([...a].filter((w) => !group.includes(w)));
    const restB = new Set([...b].filter((w) => !group.includes(w)));
    if (restA.size === 0 && restB.size === 0) return group;
    if (jaccard(restA, restB) >= 0.5) return group;
  }
  return null;
}

/**
 * Pull rule-bearing blocks out of the parsed document.
 * @returns {{block: object, text: string, key: Set<string>, negative: boolean, strong: boolean}[]}
 */
export function extractDirectives(blocks) {
  const out = [];
  for (const block of blocks) {
    if (block.type === 'code' || block.type === 'heading') continue;
    for (const sentence of splitSentences(block.text)) {
      if (sentence.split(/\s+/).length < 2) continue;
      // A bullet in an instruction file is a rule whether or not it starts
      // with a recognizable imperative ("Indent with tabs", "2-space indent").
      // Prose only counts as a rule when it is phrased as one, otherwise
      // narrative background would be compared against real directives.
      if (block.type !== 'list' && !IMPERATIVE.test(sentence)) continue;
      out.push({
        block,
        text: sentence,
        key: keyOf(sentence),
        negative: NEGATIVE.test(sentence),
        strong: STRONG.test(sentence),
      });
    }
  }
  return out;
}

/** Split a block into sentences, but never inside inline code or a URL. */
export function splitSentences(text) {
  if (!text) return [];
  const guarded = text.replace(/`[^`]*`/g, (m) => m.replace(/[.!?]/g, '\u0001'));
  return guarded
    .split(/(?<=[.!?])\s+(?=[A-Z(`"'-])|\n+/)
    .map((s) => s.replace(/\u0001/g, '.').trim())
    .filter(Boolean);
}
