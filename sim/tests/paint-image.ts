/**
 * Plan a painting from a photo and, unless --plan-only, paint it with the simulation.
 *
 *   node --experimental-strip-types tests/paint-image.ts [image.png] [--width 240] [--seed 1]
 *        [--layers N] [--plan-only] [--no-feedback] [--name lake]
 *
 * Writes to out/: <name>-plan.png (what the planner expects), <name>-strokes.png (stroke
 * outlines, coloured by layer), <name>-plan.json, and with the simulation <name>-paint.png,
 * -color.png, -height.png and -light-opposite.png.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { readPng, writePng } from './png.ts';
import { DEFAULT_SETTINGS, planPainting, type Plan } from '../src/planner.ts';
import { canvasColour, paintStrokes, startPainting, type Painting } from '../src/execute.ts';
import { DEFAULT_LIGHT, relight } from '../src/relight.ts';
import { linearToSrgb } from '../src/pigment.ts';

const args = process.argv.slice(2);
const opt = (name: string, def: string) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : def; };
const flag = (name: string) => args.includes(`--${name}`);
const imagePath = args[0] && !args[0].startsWith('--') ? args[0] : new URL('./fixtures/lake.png', import.meta.url).pathname;
const name = opt('name', 'lake');
const widthMm = +opt('width', '240');
const seed = +opt('seed', '1');
const layerCount = +opt('layers', String(DEFAULT_SETTINGS.layers.length));
const gapScale = +opt('gap-scale', '1');
const minLoad = +opt('min-load', String(DEFAULT_SETTINGS.minLoad));
const look = opt('look', 'locked') as 'locked' | 'oil';
const simulate = !flag('plan-only'), feedback = simulate && !flag('no-feedback');
const out = new URL('../out/', import.meta.url).pathname;
const LIGHT = { ...DEFAULT_LIGHT, look };
mkdirSync(out, { recursive: true });

const img = readPng(imagePath);
const settings = { ...DEFAULT_SETTINGS, widthMm, seed, minLoad, look, layers: DEFAULT_SETTINGS.layers.slice(0, layerCount).map((l, i) => (i === 0 ? l : { ...l, gapMm: l.gapMm * gapScale })) };
const t0 = Date.now();
let painting: Painting | null = null;
let simMs = 0;
const plan = planPainting(img, settings, simulate ? (layer, strokes, estimate, partial) => {
  const t = Date.now();
  painting ??= startPainting(partial, settings.ground);
  paintStrokes(painting, strokes);
  simMs += Date.now() - t;
  console.log(`layer ${layer} ${settings.layers[layer].name}: ${strokes.length} strokes, sim ${((Date.now() - t) / 1000).toFixed(1)} s`);
  return feedback ? canvasColour(painting.canvas, estimate.w, estimate.h) : estimate;
} : undefined);
const planMs = Date.now() - t0 - simMs;
console.log('plan', { strokes: plan.strokes.length, perLayer: plan.counts, planMs, hash: planHash(plan) });
plan.stats.forEach((st, l) => console.log(`  ${settings.layers[l].name.padEnd(10)} seeds ${st.seeds}, accepted ${st.accepted}, too short ${st.tooShort}, overlapping ${st.overlapping}, no gain ${st.noGain}; ${JSON.stringify(st.primitives)}`));

writeFileSync(`${out}${name}-plan.json`, JSON.stringify(plan));
const PS = 0.25; // mm per preview pixel
writePreview(`${out}${name}-plan.png`, plan, PS, false);
writePreview(`${out}${name}-strokes.png`, plan, PS, true);

if (painting) {
  const { canvas } = painting as Painting;
  const t = Date.now();
  const px = relight(canvas, LIGHT, 'paint');
  writePng(`${out}${name}-paint.png`, canvas.w, canvas.h, px);
  writePng(`${out}${name}-color.png`, canvas.w, canvas.h, relight(canvas, LIGHT, 'color'));
  writePng(`${out}${name}-height.png`, canvas.w, canvas.h, relight(canvas, LIGHT, 'height'));
  writePng(`${out}${name}-light-opposite.png`, canvas.w, canvas.h, relight(canvas, { ...LIGHT, azimuth: 45 }, 'paint'));
  console.log('sim s', (simMs / 1000).toFixed(1), 'relight s', ((Date.now() - t) / 4000).toFixed(1), 'per view; paint sha256', createHash('sha256').update(px).digest('hex').slice(0, 16));
  const thick = new Float64Array(canvas.n);
  for (let i = 0; i < canvas.n; i++) thick[i] = canvas.top[i] + canvas.under[i];
  const sorted = thick.slice().sort();
  let glint = 0, dark = 0, mean = 0;
  for (let i = 0; i < canvas.n; i++) {
    mean += thick[i] / canvas.n;
    if (px[i * 3] > 240 && px[i * 3 + 1] > 235 && px[i * 3 + 2] > 220) glint++;
    if (px[i * 3] + px[i * 3 + 1] + px[i * 3 + 2] < 90) dark++;
  }
  console.log('canvas', canvas.w, 'x', canvas.h, 'cells; paint mm mean', mean.toFixed(2), 'p5', sorted[Math.floor(canvas.n * 0.05)].toFixed(2), 'p95', sorted[Math.floor(canvas.n * 0.95)].toFixed(2), 'max', sorted[canvas.n - 1].toFixed(2));
  console.log('glint %', (100 * glint / canvas.n).toFixed(3), 'deep shadow %', (100 * dark / canvas.n).toFixed(2), 'lost mm3', canvas.lost.toFixed(1));
}

export function planHash(p: Plan): string {
  return createHash('sha256').update(JSON.stringify(p.strokes)).digest('hex').slice(0, 16);
}

/** Flat raster of the plan: every footprint filled with its paint colour, in order. */
function writePreview(path: string, p: Plan, mmPerPx: number, outlines: boolean): void {
  const W = Math.round(p.widthMm / mmPerPx), H = Math.round(p.heightMm / mmPerPx);
  const px = new Uint8ClampedArray(W * H * 3);
  const g = settings.ground;
  for (let i = 0; i < W * H; i++) { px[i * 3] = g[0] * 255; px[i * 3 + 1] = g[1] * 255; px[i * 3 + 2] = g[2] * 255; }
  const layerTint: [number, number, number][] = [[230, 230, 230], [255, 80, 60], [255, 190, 40], [60, 200, 90], [40, 150, 255], [200, 80, 255]];
  for (const st of p.strokes) {
    const pts = st.footprint, r = st.widthMm / 2 / mmPerPx;
    let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
    for (const [x, y] of pts) { x0 = Math.min(x0, x / mmPerPx); x1 = Math.max(x1, x / mmPerPx); y0 = Math.min(y0, y / mmPerPx); y1 = Math.max(y1, y / mmPerPx); }
    const X0 = Math.max(0, Math.floor(x0 - r)), X1 = Math.min(W - 1, Math.ceil(x1 + r)), Y0 = Math.max(0, Math.floor(y0 - r)), Y1 = Math.min(H - 1, Math.ceil(y1 + r));
    // Marbling preview: the secondary colour in bands across the stroke.
    const sec = st.secondaryFraction;
    for (let y = Y0; y <= Y1; y++) for (let x = X0; x <= X1; x++) {
      const cx = x + 0.5, cy = y + 0.5;
      let best = 1e18, across = 0;
      for (let i = 0; i < pts.length - 1; i++) {
        const ax = pts[i][0] / mmPerPx, ay = pts[i][1] / mmPerPx, bx = pts[i + 1][0] / mmPerPx, by = pts[i + 1][1] / mmPerPx;
        const vx = bx - ax, vy = by - ay, l2 = vx * vx + vy * vy;
        let t = l2 > 0 ? ((cx - ax) * vx + (cy - ay) * vy) / l2 : 0;
        if ((i === 0 && t < 0) || (i === pts.length - 2 && t > 1)) continue;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        const ex = cx - (ax + vx * t), ey = cy - (ay + vy * t), d2 = ex * ex + ey * ey;
        if (d2 < best) { best = d2; across = l2 > 0 ? (ex * -vy + ey * vx) / Math.sqrt(l2) : 0; }
      }
      if (best > r * r) continue;
      const o = (y * W + x) * 3, d = Math.sqrt(best);
      if (outlines && d > r - 1.2) { const c = layerTint[st.layer % layerTint.length]; px[o] = c[0]; px[o + 1] = c[1]; px[o + 2] = c[2]; continue; }
      const band = ((across / r + 1) * 0.5 * 3.7 + st.seed * 0.0001) % 1;
      const c = band < sec ? st.secondary : st.primary;
      px[o] = c[0] * 255; px[o + 1] = c[1] * 255; px[o + 2] = c[2] * 255;
    }
  }
  writePng(path, W, H, px);
  void linearToSrgb;
}
