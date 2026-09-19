// Tokenizer-free estimate. We deliberately ship no tokenizer dependency:
// every BPE vocab differs per vendor, and a linter that needs a 2MB wasm blob
// does not get run. The model below is calibrated against BPE behaviour on
// markdown and is accurate to roughly +/-15% on prose-heavy instruction files.
// It over-estimates on dense code fences (BPE merges common code n-grams).

const PIECE = /[A-Za-z]+|[0-9]+|\n|[^\sA-Za-z0-9]/g;

/**
 * @param {string} text
 * @returns {number} estimated BPE tokens
 */
export function estimateTokens(text) {
  if (!text) return 0;
  // Blank-line runs collapse into a single token in practice.
  const pieces = text.replace(/\n[ \t]*\n[\s]*/g, '\n').match(PIECE);
  if (!pieces) return 0;
  let total = 0;
  for (const p of pieces) {
    const c = p.charCodeAt(0);
    if (c >= 65 && c <= 122 && /[A-Za-z]/.test(p[0])) {
      // Common words are one token; long/rare words split into subwords.
      total += 1 + Math.floor((p.length - 1) / 6);
    } else if (c >= 48 && c <= 57) {
      total += Math.ceil(p.length / 3);
    } else {
      total += 1; // newline, punctuation, symbol
    }
  }
  return total;
}

/** Cost of one token count, in USD. */
export function costOf(tokens, usdPerMillion) {
  return (tokens / 1e6) * usdPerMillion;
}
