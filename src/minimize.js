import { splitSentences } from './directives.js';
import { plain } from './parse.js';

/**
 * Produce the minimized file.
 *
 * Deliberately conservative. A block is dropped only when every rule-bearing
 * sentence in it was flagged removable — one flagged sentence inside a
 * paragraph that also carries real instruction is left alone and reported as
 * manual. Contradictions are never auto-resolved: picking the surviving rule
 * is a decision about the project, not about the text.
 */
export function minimize(source, blocks, findings) {
  const lines = source.split('\n');
  const drop = new Set();
  const byBlock = new Map();

  for (const f of findings) {
    if (!f.block || !f.removable) continue;
    if (!byBlock.has(f.block)) byBlock.set(f.block, []);
    byBlock.get(f.block).push(f);
  }

  const removedBlocks = new Set();
  const manual = [];

  for (const [block, blockFindings] of byBlock) {
    if (block.type === 'code' || coversWholeBlock(block, blockFindings)) {
      for (let l = block.start; l <= block.end; l++) drop.add(l);
      removedBlocks.add(block);
    } else {
      manual.push(...blockFindings);
    }
  }

  // Drop headings whose entire section is gone.
  for (let i = 0; i < blocks.length; i++) {
    const h = blocks[i];
    if (h.type !== 'heading') continue;
    let sawContent = false;
    let emptied = true;
    for (let j = i + 1; j < blocks.length; j++) {
      const next = blocks[j];
      if (next.type === 'heading' && next.level <= h.level) break;
      if (next.type === 'heading') continue;
      sawContent = true;
      if (!removedBlocks.has(next)) { emptied = false; break; }
    }
    if (sawContent && emptied) {
      drop.add(h.start);
      removedBlocks.add(h);
    }
  }

  const kept = lines.filter((_, idx) => !drop.has(idx + 1));
  const collapsed = [];
  for (const line of kept) {
    if (line.trim() === '' && collapsed.length && collapsed[collapsed.length - 1].trim() === '') continue;
    collapsed.push(line);
  }
  while (collapsed.length && collapsed[collapsed.length - 1].trim() === '') collapsed.pop();

  return {
    text: collapsed.length ? `${collapsed.join('\n')}\n` : '',
    removedBlocks: removedBlocks.size,
    removedLines: drop.size,
    manual,
  };
}

function coversWholeBlock(block, blockFindings) {
  const sentences = splitSentences(block.text).map(plain);
  if (!sentences.length) return true;
  const flagged = new Set(blockFindings.map((f) => plain(f.excerpt ?? '')));
  return sentences.every((s) => flagged.has(s));
}
