/**
 * Node-only helper that ships the browser modules (`viewer.ts`, `surface.ts` and what they import)
 * inside a single HTML page, without a bundler or dependencies: each file has its types stripped
 * with Node's own `stripTypeScriptTypes`, its relative imports renamed to bare `impasto/<name>`
 * specifiers, and an import map points those at `data:` URLs. Pages then write
 *   <script type="module">import { createImpastoViewer } from 'impasto/viewer'; ...</script>
 * Any non-relative import (node:fs, a package) in the graph is an error, so a browser module
 * that grows a Node dependency fails at export time rather than in the browser.
 */
import { readFileSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as nodeModule from 'node:module';

const SRC = dirname(fileURLToPath(import.meta.url));
const strip = (nodeModule as unknown as { stripTypeScriptTypes?: (code: string, o?: { mode: 'strip' }) => string }).stripTypeScriptTypes;

/** Every `import ... from '...'` / `export ... from '...'` / `import '...'` that survives type stripping. */
const IMPORT_RE = /(\b(?:import|export)\b[^'";]*?\bfrom\s*|\bimport\s*)(['"])([^'"]+)\2/g;

/** Strips types and renames relative imports; returns the module graph as specifier -> JS. */
export function browserModuleGraph(entries: string[] = ['viewer.ts', 'surface.ts']): Map<string, string> {
  if (!strip) throw new Error('node:module stripTypeScriptTypes is missing; Node 22.13 or newer is needed to export the viewer');
  const out = new Map<string, string>();
  const visit = (file: string) => {
    const spec = `impasto/${basename(file, '.ts')}`;
    if (out.has(spec)) return spec;
    out.set(spec, '');
    const js = strip(readFileSync(file, 'utf8'), { mode: 'strip' }).replace(IMPORT_RE, (_m, head: string, q: string, from: string) => {
      if (!from.startsWith('./') || !from.endsWith('.ts')) throw new Error(`${basename(file)} imports '${from}', which cannot run in the browser viewer bundle`);
      return `${head}${q}${visit(resolve(dirname(file), from))}${q}`;
    });
    out.set(spec, js);
    return spec;
  };
  for (const e of entries) visit(resolve(SRC, e));
  return out;
}

/** An `<script type="importmap">` tag that makes `impasto/viewer`, `impasto/surface`, ... importable. */
export function viewerImportMap(entries?: string[]): string {
  const imports: Record<string, string> = {};
  for (const [spec, js] of browserModuleGraph(entries)) imports[spec] = 'data:text/javascript;base64,' + Buffer.from(js).toString('base64');
  return `<script type="importmap">${JSON.stringify({ imports })}</script>`;
}
