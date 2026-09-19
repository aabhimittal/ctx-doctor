import { emptyContext } from '../src/context.js';
import { analyzeText } from '../src/index.js';

export function fakeCtx({ files = [], dirs = [], tools = [], scripts = {}, make = [] } = {}) {
  const ctx = emptyContext('/repo');
  files.forEach((f) => ctx.files.add(f));
  dirs.forEach((d) => ctx.dirs.add(d));
  tools.forEach((t) => ctx.tools.add(t));
  make.forEach((t) => ctx.makeTargets.add(t));
  ctx.scripts = new Map(Object.entries(scripts));
  return ctx;
}

export function lint(text, ctxInit = {}, options = {}) {
  return analyzeText({
    file: 'AGENTS.md',
    text,
    ctx: fakeCtx(ctxInit),
    options: { budget: 100000, ...options },
  });
}

export const rules = (result) => result.findings.map((f) => f.rule);
