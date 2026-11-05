/**
 * Builds dist/ (JavaScript + declarations) with the TypeScript installed in this package.
 *
 *   node scripts/build.js            # npm run build
 *   node scripts/build.js --prepare  # npm's prepare hook
 *
 * npm runs `prepare` for a `file:` dependency when a project that depends on it is installed, but
 * it does not install this package's devDependencies there, so TypeScript is only available once
 * `npm install` has been run in this folder. With --prepare and no TypeScript, an existing dist/ is
 * kept; without one the install stops with instructions instead of a bare "tsc: not found".
 */
import { existsSync, renameSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const prepare = process.argv.includes('--prepare');
let tsc = null;
try { tsc = createRequire(import.meta.url).resolve('typescript/bin/tsc'); } catch { /* not installed */ }

if (!tsc) {
  if (prepare && existsSync(`${root}dist/index.js`)) {
    console.warn('tryimpasto: TypeScript is not installed in tryimpasto, keeping the existing dist/. Run `npm install` there to rebuild it.');
    process.exit(0);
  }
  console.error(`tryimpasto: dist/ needs building and TypeScript is not installed in ${root}.\n  Run \`npm install\` in ${root} once (it builds dist/), then install again.`);
  process.exit(1);
}
// Build into a fresh folder and swap it in only on success, so a failed build leaves the last
// good dist/ in place (and drops nothing stale into it).
const next = `${root}dist.next`;
rmSync(next, { recursive: true, force: true });
const r = spawnSync(process.execPath, [tsc, '-p', 'tsconfig.build.json', '--outDir', next], { cwd: root, stdio: 'inherit' });
if (r.status !== 0) { rmSync(next, { recursive: true, force: true }); process.exit(r.status ?? 1); }
rmSync(`${root}dist`, { recursive: true, force: true });
renameSync(next, `${root}dist`);
