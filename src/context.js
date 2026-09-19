import fs from 'node:fs';
import path from 'node:path';

const SKIP_DIRS = new Set([
  '.git', 'node_modules', 'dist', 'build', 'out', 'coverage', 'vendor',
  'target', '.next', '.nuxt', '.venv', 'venv', '__pycache__', '.mypy_cache',
  '.pytest_cache', '.turbo', '.cache', '.terraform',
]);

const MAX_ENTRIES = 8000;
const MAX_DEPTH = 5;

// file-marker -> the names people actually write in prose for that tool
const TOOL_MARKERS = [
  [/^tsconfig(\..+)?\.json$/, ['typescript', 'ts']],
  [/^\.eslintrc/, ['eslint']],
  [/^eslint\.config\./, ['eslint']],
  [/^\.prettierrc/, ['prettier']],
  [/^prettier\.config\./, ['prettier']],
  [/^(jest\.config\.|jest\.setup\.)/, ['jest']],
  [/^vitest\.config\./, ['vitest']],
  [/^(vite\.config\.)/, ['vite']],
  [/^webpack\.config\./, ['webpack']],
  [/^(pytest\.ini|conftest\.py)$/, ['pytest']],
  [/^(ruff\.toml|\.ruff\.toml)$/, ['ruff']],
  [/^(setup\.py|pyproject\.toml|requirements.*\.txt)$/, ['python']],
  [/^Cargo\.toml$/, ['cargo', 'rust']],
  [/^go\.mod$/, ['go', 'golang']],
  [/^(Gemfile)$/, ['ruby', 'bundler']],
  [/^(Dockerfile|docker-compose\.ya?ml)$/, ['docker']],
  [/^(Makefile|makefile|GNUmakefile)$/, ['make']],
  [/^(pnpm-lock\.yaml)$/, ['pnpm']],
  [/^(yarn\.lock)$/, ['yarn']],
  [/^(package-lock\.json)$/, ['npm']],
  [/^(bun\.lockb?)$/, ['bun']],
  [/^(LICENSE|LICENCE|LICENSE\..+)$/, ['license']],
  [/^(\.editorconfig)$/, ['editorconfig']],
];

/**
 * Everything ctx-doctor knows about the repo without running anything.
 * This is what an agent can see for itself, and therefore what an instruction
 * file does not need to tell it.
 */
export function scanRepo(root) {
  const files = new Set();
  const dirs = new Set();
  const tools = new Set();
  let truncated = false;
  let count = 0;

  const walk = (dir, rel, depth) => {
    if (depth > MAX_DEPTH || count > MAX_ENTRIES) {
      truncated = truncated || count > MAX_ENTRIES;
      return;
    }
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (count++ > MAX_ENTRIES) { truncated = true; return; }
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name)) continue;
        dirs.add(childRel);
        walk(path.join(dir, e.name), childRel, depth + 1);
      } else {
        files.add(childRel);
        for (const [re, names] of TOOL_MARKERS) {
          if (re.test(e.name)) names.forEach((n) => tools.add(n));
        }
      }
    }
  };
  walk(root, '', 0);

  const pkg = readJson(path.join(root, 'package.json'));
  const scripts = new Map(Object.entries(pkg?.scripts ?? {}));
  for (const dep of Object.keys({ ...pkg?.dependencies, ...pkg?.devDependencies })) {
    const base = dep.replace(/^@[^/]+\//, '');
    tools.add(base.toLowerCase());
  }
  if (pkg?.packageManager) tools.add(String(pkg.packageManager).split('@')[0]);

  return {
    root,
    files,
    dirs,
    tools,
    scripts,
    makeTargets: readMakeTargets(root),
    pkg,
    truncated,
  };
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function readMakeTargets(root) {
  const targets = new Set();
  for (const name of ['Makefile', 'makefile', 'GNUmakefile']) {
    const file = path.join(root, name);
    if (!fs.existsSync(file)) continue;
    let text = '';
    try { text = fs.readFileSync(file, 'utf8'); } catch { continue; }
    for (const line of text.split('\n')) {
      const m = line.match(/^([A-Za-z0-9_.-]+)\s*:(?!=)/);
      if (m) targets.add(m[1]);
    }
  }
  return targets;
}

/** Does this repo-relative path exist as a file or directory? */
export function exists(ctx, rel) {
  const clean = rel.replace(/^\.\//, '').replace(/\/$/, '');
  return ctx.files.has(clean) || ctx.dirs.has(clean);
}

/** An empty context — used when linting a file with no repo to compare against. */
export function emptyContext(root = process.cwd()) {
  return {
    root,
    files: new Set(),
    dirs: new Set(),
    tools: new Set(),
    scripts: new Map(),
    makeTargets: new Set(),
    pkg: null,
    truncated: false,
  };
}
