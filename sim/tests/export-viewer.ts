/**
 * Writes self-contained pages that relight a painting live, using the same module a site would
 * (`src/viewer.ts`, inlined through an import map by `src/viewer-bundle.ts`):
 *
 *   npm run viewer                        # out/viewer-one-stroke.html, out/viewer-patch.html, out/viewer.html
 *   npm run viewer -- painting.impasto    # out/viewer-painting.html with that surface embedded
 *
 * Every page can also open an `.impasto` (or gzipped `.impasto.gz`) file from disk. Scene pages
 * carry a CPU `relight()` render as the static fallback; a file page uses the `<name>-paint.png`
 * that `npm run paint -- --export-surface` writes beside it, else the viewer's approximate shading.
 * The Renderer menu, or `?backend=webgpu|webgl2|static` in the URL, forces a backend.
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { readPng } from './png.ts';
import { basename } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { oneStrokeScene, patchScene } from './scenes.ts';
import { DEFAULT_LIGHT, relight } from '../src/relight.ts';
import { decodeSurface, encodeSurface, surfaceFromCanvas, type ImpastoSurface } from '../src/surface.ts';
import { viewerImportMap } from '../src/viewer-bundle.ts';
import type { PaintCanvas } from '../src/canvas.ts';

export interface PageOptions {
  title?: string;
  /** Static fallback at the default light: RGB or RGBA bytes. */
  fallback?: { width: number; height: number; data: Uint8Array | Uint8ClampedArray };
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
const b64 = (b: Uint8Array | Uint8ClampedArray) => Buffer.from(b.buffer, b.byteOffset, b.byteLength).toString('base64');

/** A self-contained viewer page. Without a surface it opens empty, ready to load a file. */
export function viewerPage(surface: ImpastoSurface | null, opts: PageOptions = {}): string {
  const title = opts.title ?? 'Impasto light viewer';
  const fb = opts.fallback;
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<style>
:root{--wall:#27302b;--wall-deep:#1d2420;--linen:#e4dccb;--linen-dim:#a9a393;--brass:#c99a3e;--slate:#8c96a3;--alarm:#e08a6d;color-scheme:dark}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;background:radial-gradient(120% 90% at 30% 20%,#2f3a33 0%,var(--wall) 45%,var(--wall-deep) 100%);color:var(--linen);
 font:15px/1.5 "Avenir Next","Segoe UI",system-ui,sans-serif;display:grid;grid-template-columns:minmax(0,1fr) 300px;gap:32px;padding:32px}
@media (max-width:820px){body{grid-template-columns:1fr;padding:16px;gap:20px}}
h1{font-weight:500;font-size:22px;letter-spacing:.01em;margin:0 0 4px}
.stage{display:flex;flex-direction:column;gap:12px;min-width:0}
.frame{align-self:flex-start;max-width:100%;padding:10px;background:#141815;box-shadow:0 30px 60px -20px #000c,0 0 0 1px #0006;line-height:0}
.frame canvas{max-width:100%;max-height:calc(100vh - 150px);width:auto;height:auto;display:block;cursor:crosshair;touch-action:none}
.empty{line-height:1.5;padding:48px 32px;color:var(--linen-dim);max-width:46ch}
.meta{color:var(--linen-dim);font-size:13px}
#mode{display:inline-flex;align-items:center;gap:8px;font-size:13px;padding:3px 10px 3px 8px;border-radius:99px;border:1px solid currentColor}
#mode::before{content:"";width:8px;height:8px;border-radius:50%;background:currentColor}
#mode.webgpu,#mode.webgl2{color:var(--brass)} #mode.static{color:var(--slate)} #mode.pending{color:var(--linen-dim)}
#reason{color:var(--alarm);font-size:13px;max-width:70ch} #reason.note{color:var(--linen-dim)}
aside{display:flex;flex-direction:column;gap:14px}
.dial{align-self:center;width:150px;height:150px;cursor:crosshair;touch-action:none}
label{display:grid;grid-template-columns:84px 1fr 40px;align-items:center;gap:8px;font-size:14px}
label output{color:var(--linen-dim);font-variant-numeric:tabular-nums;text-align:right}
label.wide{grid-template-columns:84px 1fr} label.wide select{min-width:0;width:100%}
input[type=range]{accent-color:var(--brass);width:100%}
select,button,.file{font:inherit;font-size:14px;color:var(--linen);background:#ffffff0d;border:1px solid #ffffff2a;border-radius:6px;padding:5px 8px}
button,.file{cursor:pointer;text-align:center} button:hover,.file:hover{background:#ffffff1a}
:focus-visible{outline:2px solid var(--brass);outline-offset:2px}
.file input{position:absolute;opacity:0;width:1px;height:1px}
.check{grid-template-columns:auto 1fr;font-size:14px}
.hint{font-size:13px;color:var(--linen-dim);margin:0}
#err{color:var(--alarm);font-size:13px}
</style>
<main class="stage">
 <div><h1>${esc(title)}</h1><span id="mode" class="pending">Starting</span> <span class="meta" id="size"></span></div>
 <div id="reason" hidden></div>
 <div class="frame" id="frame">${surface ? '' : '<p class="empty">Open an <b>.impasto</b> surface to relight it. Write one with <code>npm run paint -- --export-surface</code>.</p>'}</div>
 <p class="hint" id="hint">Drag across the painting to move the light.</p>
</main>
<aside>
 <svg class="dial" id="dial" viewBox="-60 -60 120 120" aria-label="Light direction: click or drag to aim the light">
  <circle r="54" fill="#0003" stroke="#ffffff30"/><circle r="36" fill="none" stroke="#ffffff18"/><circle r="18" fill="none" stroke="#ffffff18"/>
  <line id="ray" x1="0" y1="0" x2="0" y2="0" stroke="#c99a3e88" stroke-width="1.5"/><circle id="lamp" r="6" fill="#c99a3e"/>
 </svg>
 <label>Azimuth <input id="azimuth" type="range" min="0" max="359" value="${DEFAULT_LIGHT.azimuth}"><output></output></label>
 <label>Elevation <input id="elevation" type="range" min="5" max="85" value="${DEFAULT_LIGHT.elevation}"><output></output></label>
 <label>Relief <input id="relief" type="range" min="0" max="2" step="0.05" value="${DEFAULT_LIGHT.relief}"><output></output></label>
 <label>Glow <input id="glow" type="range" min="0" max="2" step="0.05" value="${DEFAULT_LIGHT.glow}"><output></output></label>
 <label>Exposure <input id="exposure" type="range" min="0.4" max="1.8" step="0.05" value="${DEFAULT_LIGHT.exposure}"><output></output></label>
 <label class="wide">Look <select id="look"><option value="locked">Locked (reference)</option><option value="oil">Oil (semi-gloss)</option></select></label>
 <label class="wide">View <select id="view"><option value="paint">Paint</option><option value="color">Colour</option><option value="height">Height</option><option value="normal">Normals</option><option value="spec">Highlights</option><option value="cavity">Cavities</option><option value="glow">Glow</option></select></label>
 <label class="wide">Drag <select id="mapping"><option value="linear">Across: x turns, y raises</option><option value="radial">Toward the light</option></select></label>
 <label class="wide">Renderer <select id="backend"><option value="auto">Auto (best available)</option><option value="webgpu">WebGPU</option><option value="webgl2">WebGL2</option><option value="static">Static fallback</option></select></label>
 <button id="reset" type="button">Reset light</button>
 <span class="file" role="button" tabindex="0">Open .impasto file<input id="file" type="file" accept=".impasto,.gz,application/octet-stream"></span>
 <div id="err" role="alert"></div>
</aside>
${surface ? `<script type="application/octet-stream" id="surface-data">${b64(encodeSurface(surface))}</script>` : ''}
${fb ? `<script type="application/json" id="fallback-meta">${JSON.stringify({ width: fb.width, height: fb.height })}</script><script type="application/octet-stream" id="fallback-data">${b64(fb.data)}</script>` : ''}
${viewerImportMap()}
<script type="module">
import { createImpastoViewer, attachPointerLight } from 'impasto/viewer';
import { decodeSurface } from 'impasto/surface';
const $ = (id) => document.getElementById(id);
const DEFAULT = ${JSON.stringify(DEFAULT_LIGHT)};
const bytesOf = async (b64) => new Uint8Array(await (await fetch('data:application/octet-stream;base64,' + b64)).arrayBuffer());
let surface = null, fallback = null, viewer = null, detach = null, seq = 0;
// ?backend=webgpu|webgl2|static forces a renderer (the Renderer menu does the same).
const asked = new URLSearchParams(location.search).get('backend');
if ([...$('backend').options].some((o) => o.value === asked)) $('backend').value = asked;
if ($('surface-data')) surface = decodeSurface(await bytesOf($('surface-data').textContent));
if ($('fallback-data')) fallback = { ...JSON.parse($('fallback-meta').textContent), data: await bytesOf($('fallback-data').textContent) };

const sliders = ['azimuth', 'elevation', 'relief', 'glow', 'exposure'];
const show = () => { for (const id of sliders) $(id).nextElementSibling.textContent = id === 'azimuth' || id === 'elevation' ? $(id).value + '°' : String(+(+$(id).value).toFixed(2)); dial(); };
const lightFromUi = () => Object.fromEntries(sliders.map((id) => [id, +$(id).value]));
function dial() {
  const az = +$('azimuth').value * Math.PI / 180, el = +$('elevation').value, r = 54 * (85 - el) / 80;
  const x = Math.cos(az) * r, y = Math.sin(az) * r;
  $('lamp').setAttribute('cx', x); $('lamp').setAttribute('cy', y); $('ray').setAttribute('x2', x); $('ray').setAttribute('y2', y);
}
function syncFromViewer(l) { $('azimuth').value = l.azimuth; $('elevation').value = l.elevation; show(); }
function status() {
  const m = $('mode');
  if (!viewer) { m.className = 'pending'; m.textContent = surface ? 'Starting' : 'No painting'; return; }
  m.className = viewer.mode;
  m.textContent = viewer.mode === 'webgpu' ? 'Live WebGPU' : viewer.mode === 'webgl2' ? 'Live WebGL2' : viewer.interactive ? 'Static fallback, approximate shading' : 'Static fallback image';
  // Static: why. Live on a later backend: why the earlier ones were passed over.
  const live = viewer.mode !== 'static';
  $('reason').hidden = live && !viewer.skipped.length;
  $('reason').className = live ? 'note' : '';
  $('reason').textContent = live ? 'Not used: ' + viewer.skipped.join('; ') : viewer.fallbackReason ?? '';
  $('hint').textContent = viewer.interactive ? 'Drag across the painting to move the light.' : 'This is a fixed render at the default light; other views use approximate shading.';
  const s = viewer.surface;
  $('size').textContent = s.w + ' × ' + s.h + ' cells, ' + +(s.w * s.dx).toFixed(1) + ' × ' + +(s.h * s.dx).toFixed(1) + ' mm';
}
async function start() {
  const mine = ++seq;
  detach?.(); viewer?.destroy(); viewer = null; status();
  if (!surface) return;
  const canvas = document.createElement('canvas');
  $('frame').replaceChildren(canvas);
  const backend = $('backend').value;
  const v = await createImpastoViewer(canvas, surface, {
    light: lightFromUi(), look: $('look').value, view: $('view').value, fallback: fallback ?? undefined,
    backends: backend === 'auto' ? undefined : [backend],
    // Chosen by hand, WebGL2 runs even on a software rasteriser (slow, but it shows the shader).
    webgl: { software: backend === 'webgl2' },
    onFallback: (why) => { console.warn('impasto viewer:', why); status(); },
  });
  if (mine !== seq) { v.destroy(); return; }
  viewer = window.__viewer = v;
  detach = attachPointerLight(v, undefined, { mapping: $('mapping').value, onChange: syncFromViewer });
  v.addEventListener('modechange', status);
  status();
  window.__ready = true;
}
for (const id of sliders) $(id).addEventListener('input', () => { show(); viewer?.setLight({ [id]: +$(id).value }); });
$('look').addEventListener('change', () => viewer?.setLook($('look').value));
$('view').addEventListener('change', () => { viewer?.setView($('view').value); status(); });
$('mapping').addEventListener('change', () => { detach?.(); if (viewer) detach = attachPointerLight(viewer, undefined, { mapping: $('mapping').value, onChange: syncFromViewer }); });
$('backend').addEventListener('change', () => {
  const u = new URL(location.href);
  if ($('backend').value === 'auto') u.searchParams.delete('backend'); else u.searchParams.set('backend', $('backend').value);
  try { history.replaceState(null, '', u); } catch { /* opaque origins */ }
  start();
});
$('reset').addEventListener('click', () => { for (const id of sliders) $(id).value = DEFAULT[id]; show(); viewer?.setLight(lightFromUi()); });
// The dial aims the light the radial way: the centre is overhead, the rim grazing.
let aiming = false;
const aim = (e) => {
  const r = $('dial').getBoundingClientRect(), x = (e.clientX - r.left) / r.width * 120 - 60, y = (e.clientY - r.top) / r.height * 120 - 60;
  $('azimuth').value = Math.round((Math.atan2(y, x) * 180 / Math.PI + 360) % 360);
  $('elevation').value = Math.round(85 - 80 * Math.min(1, Math.hypot(x, y) / 54));
  show(); viewer?.setLight(lightFromUi());
};
$('dial').addEventListener('pointerdown', (e) => { aiming = true; $('dial').setPointerCapture(e.pointerId); aim(e); });
$('dial').addEventListener('pointermove', (e) => { if (aiming) aim(e); });
$('dial').addEventListener('pointerup', () => { aiming = false; });
async function load(bytes, name) {
  $('err').textContent = '';
  try {
    if (bytes[0] === 0x1f && bytes[1] === 0x8b) bytes = new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer());
    surface = decodeSurface(bytes); fallback = null;
    document.querySelector('h1').textContent = name;
    await start();
  } catch (e) { $('err').textContent = 'Could not open ' + name + ': ' + e.message; }
}
window.__load = (bytes, name = 'surface') => load(bytes, name);
$('file').addEventListener('change', async () => { const f = $('file').files[0]; if (f) await load(new Uint8Array(await f.arrayBuffer()), f.name); });
document.querySelector('.file').addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); $('file').click(); } });
show();
await start();
if (!surface) window.__ready = true;
</script></html>`;
}

/** The page for a painted canvas, with a CPU render at the default light as its static fallback. */
export function viewerHtml(c: PaintCanvas, title?: string): string {
  return viewerPage(surfaceFromCanvas(c), { title, fallback: { width: c.w, height: c.h, data: relight(c, DEFAULT_LIGHT, 'paint') } });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const out = new URL('../out/', import.meta.url).pathname;
  mkdirSync(out, { recursive: true });
  const write = (file: string, html: string) => { writeFileSync(out + file, html); console.log(file, (html.length / 1e6).toFixed(1), 'MB'); };
  const files = process.argv.slice(2).filter((a) => !a.startsWith('--'));
  if (files.length) {
    for (const f of files) {
      let bytes: Uint8Array = readFileSync(f);
      if (bytes[0] === 0x1f && bytes[1] === 0x8b) bytes = gunzipSync(bytes);
      const name = basename(f).replace(/\.impasto(\.gz)?$/, ''), surface = decodeSurface(bytes);
      // paint-image.ts writes <name>-paint.png (a CPU render at the default light) beside <name>.impasto.
      const png = f.replace(/\.impasto(\.gz)?$/, '-paint.png');
      const img = existsSync(png) ? readPng(png) : null;
      const fallback = img && img.w === surface.w && img.h === surface.h ? { width: img.w, height: img.h, data: img.data } : undefined;
      if (fallback) console.log('static fallback:', png);
      write(`viewer-${name}.html`, viewerPage(surface, { title: name, fallback }));
    }
  } else {
    write('viewer-one-stroke.html', viewerHtml(oneStrokeScene().canvas, 'One stroke'));
    write('viewer-patch.html', viewerHtml(patchScene().canvas, 'Patch'));
    write('viewer.html', viewerPage(null));
  }
}
