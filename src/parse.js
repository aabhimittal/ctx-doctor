// Minimal markdown block splitter. We only need enough structure to (a) keep
// line ranges so findings are clickable and a diff is producible, and (b) know
// which lines are prose rules versus code that must never be rewritten.

const FENCE = /^(\s*)(```+|~~~+)(.*)$/;
const HEADING = /^(#{1,6})\s+(.*)$/;
const BULLET = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;

/**
 * @typedef {object} Block
 * @property {'heading'|'list'|'para'|'code'|'blank'} type
 * @property {string} text      normalized single-line text (markers stripped)
 * @property {string[]} lines   raw source lines
 * @property {number} start     1-indexed first line
 * @property {number} end       1-indexed last line
 * @property {string[]} heading heading path this block sits under
 * @property {number} depth     list nesting depth (0 for non-list)
 */

/** @returns {Block[]} */
export function parseBlocks(source) {
  const lines = source.split('\n');
  /** @type {Block[]} */
  const blocks = [];
  let headingPath = [];
  let i = 0;

  const push = (b) => blocks.push({ heading: [...headingPath], depth: 0, ...b });

  while (i < lines.length) {
    const line = lines[i];

    if (line.trim() === '') {
      i++;
      continue;
    }

    const fence = line.match(FENCE);
    if (fence) {
      const closer = fence[2][0];
      const start = i;
      i++;
      while (i < lines.length && !new RegExp(`^\\s*${closer}{3,}\\s*$`).test(lines[i])) i++;
      if (i < lines.length) i++; // consume closing fence
      const raw = lines.slice(start, i);
      push({
        type: 'code',
        text: raw.slice(1, -1).join('\n'),
        lines: raw,
        start: start + 1,
        end: i,
        lang: (fence[3] || '').trim(),
      });
      continue;
    }

    const h = line.match(HEADING);
    if (h) {
      const level = h[1].length;
      headingPath = headingPath.slice(0, level - 1);
      headingPath[level - 1] = h[2].trim();
      headingPath = headingPath.filter(Boolean);
      push({
        type: 'heading',
        text: h[2].trim(),
        lines: [line],
        start: i + 1,
        end: i + 1,
        level,
      });
      i++;
      continue;
    }

    const b = line.match(BULLET);
    if (b) {
      const start = i;
      const indent = b[1].length;
      const parts = [b[3]];
      i++;
      // Absorb lazy continuation lines (indented, not a new bullet/heading).
      while (i < lines.length) {
        const next = lines[i];
        if (next.trim() === '' || HEADING.test(next) || FENCE.test(next)) break;
        const nb = next.match(BULLET);
        if (nb && nb[1].length <= indent) break;
        if (nb) break;
        if (next.search(/\S/) <= indent) break;
        parts.push(next.trim());
        i++;
      }
      push({
        type: 'list',
        text: parts.join(' ').trim(),
        lines: lines.slice(start, i),
        start: start + 1,
        end: i,
        depth: Math.floor(indent / 2),
      });
      continue;
    }

    // Paragraph: run to the next blank line or structural marker.
    const start = i;
    const parts = [];
    while (i < lines.length) {
      const next = lines[i];
      if (next.trim() === '' || HEADING.test(next) || BULLET.test(next) || FENCE.test(next)) break;
      parts.push(next.trim());
      i++;
    }
    push({
      type: 'para',
      text: parts.join(' ').trim(),
      lines: lines.slice(start, i),
      start: start + 1,
      end: i,
    });
  }

  return blocks;
}

/** Strip markdown emphasis/links so lexical rules see plain words. */
export function plain(text) {
  return text
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[*_]{1,3}([^*_]+)[*_]{1,3}/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}
