import { plain } from '../parse.js';
import { splitSentences } from '../directives.js';

// A rule is worth its tokens only if a reviewer could look at a diff and say
// whether it was followed. "Use `node:test`, not jest" is checkable. "Write
// clean code" is not — it competes for attention with the rules that are.

const VAGUE = [
  /\bclean code\b/i,
  /\bbest practices?\b/i,
  /\bgood (code|practices?|quality)\b/i,
  /\b(high[- ]quality|quality code)\b/i,
  /\bidiomatic\b/i,
  /\b(readable|maintainable|robust|scalable|performant|elegant|professional|modern)\b/i,
  /\b(properly|appropriately|correctly|as needed|as necessary|where appropriate|when appropriate)\b/i,
  /\b(be (careful|thorough|mindful|diligent|helpful)|think carefully|do your best|use (your )?judgge?ment)\b/i,
  /\bfollow (the )?(conventions|standards|guidelines)\b(?!.*\b(in|at|from)\b)/i,
  /\b(don'?t break (anything|things)|make sure everything works|keep it simple)\b/i,
  /\bwrite (good|clear|nice) (code|tests)\b/i,
];

const PERSONA = /^(you are|act as|assume the role of|imagine you)\b.{0,80}\b(expert|engineer|developer|assistant|specialist|architect|programmer)\b/i;

const ANCHOR = /`[^`]+`|\b\d+\b|[\w-]+\.\w{1,5}\b|\/|\b[A-Z]{2,}\b|\b[a-z]+[A-Z][a-zA-Z]*\b/;

export const styleRules = {
  id: 'style',
  run({ blocks }) {
    const findings = [];
    for (const block of blocks) {
      if (block.type === 'code' || block.type === 'heading') continue;

      for (const sentence of splitSentences(block.text)) {
        const text = plain(sentence);
        const words = text.split(/\s+/).length;

        if (PERSONA.test(text)) {
          findings.push({
            rule: 'style/persona',
            severity: 'info',
            block,
            excerpt: text,
            message: 'Persona preamble.',
            why: 'The harness already supplies a system prompt. A persona line in a repo file adds per-turn tokens and, unlike a rule, changes nothing an agent can be held to.',
            removable: true,
          });
          continue;
        }

        if (words > 20) continue;
        const matched = VAGUE.find((re) => re.test(text));
        if (!matched) continue;
        if (ANCHOR.test(sentence)) continue; // has something checkable in it

        findings.push({
          rule: 'style/vague',
          severity: 'warn',
          block,
          excerpt: text,
          message: 'Unfalsifiable instruction — no reviewer could say whether it was followed.',
          why: 'Rules like this cannot change behaviour, because every possible output complies. Their real cost is dilution: they occupy the same context as the rules that do constrain the model.',
          removable: true,
        });
      }
    }
    return findings;
  },
};
