/** Numbers for dark contours, wet-on-wet contacts and how faceted the thick peaks are. */
import { writeFileSync } from 'node:fs';
import { PaintCanvas } from '../src/canvas.ts';
import { paintStroke, Tool } from '../src/tool.ts';
import { albedoField, DEFAULT_LIGHT, relight, surfaceField } from '../src/relight.ts';
import { patchScene } from './scenes.ts';

const GROUND = [0.58, 0.47, 0.37] as const;
const BLUE = [0.1, 0.3, 0.6] as const, CREAM = [0.95, 0.9, 0.75] as const;
const luminance = (px: Uint8ClampedArray, i: number) => 0.2126 * px[i * 3] + 0.7152 * px[i * 3 + 1] + 0.0722 * px[i * 3 + 2];

/** Black top-hat: how far a pixel sits below a closing of the image, which isolates thin dark lines. */
function darkContours(c: PaintCanvas, px: Uint8ClampedArray) {
  const { w, h, n } = c, L = new Float32Array(n);
  for (let i = 0; i < n; i++) L[i] = luminance(px, i);
  const r = 4;
  const pass = (src: Float32Array, pick: (a: number, b: number) => number, start: number) => {
    const tmp = new Float32Array(n), out = new Float32Array(n);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { let v = start; for (let k = Math.max(0, x - r); k <= Math.min(w - 1, x + r); k++) v = pick(v, src[y * w + k]); tmp[y * w + x] = v; }
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { let v = start; for (let k = Math.max(0, y - r); k <= Math.min(h - 1, y + r); k++) v = pick(v, tmp[k * w + x]); out[y * w + x] = v; }
    return out;
  };
  const closed = pass(pass(L, Math.max, -1), Math.min, 1e9);
  let strong = 0, sum = 0, black = 0;
  for (let i = 0; i < n; i++) { const d = closed[i] - L[i]; sum += d; if (d > 45) strong++; if (L[i] < 45) black++; }
  return { strongContourPercent: +(100 * strong / n).toFixed(3), meanContourDepth: +(sum / n).toFixed(2), nearBlackPercent: +(100 * black / n).toFixed(3) };
}

/** A cream stroke crossing thick blue paint, read across its upper and lower edges. */
function wetContact() {
  const c = new PaintCanvas(100, 70, 0.1, GROUND, 3);
  const bed = new Tool({ kind: 'knife', widthMm: 42, nodes: 128, seed: 21 });
  bed.load(40, BLUE, BLUE, 0, 3);
  paintStroke(c, bed, { points: [[6, 35], [35, 35], [65, 35], [94, 35]], gapMm: 1.4, seed: 301 });
  const t = new Tool({ kind: 'knife', widthMm: 18, nodes: 128, seed: 7 });
  t.load(22, CREAM, CREAM, 0, 5);
  paintStroke(c, t, { points: [[12, 35], [38, 35], [62, 35], [88, 35]], gapMm: 1.0, seed: 99 });
  const px = relight(c, DEFAULT_LIGHT, 'paint'), A = albedoField(c), S = surfaceField(c);
  const col = (x: number) => { const a: number[] = []; for (let y = 200; y < 500; y++) a.push(y * c.w + x); return a; };
  let depth = 0, width = 0, steep = 0, k = 0;
  for (let x = 300; x <= 620; x += 16) {
    const cells = col(x);
    const blue = cells.map((i) => A[i * 3 + 0]);
    // Each edge is where red reflectance crosses the middle of blue and cream.
    const lo = Math.min(...blue.slice(0, 40)), hi = Math.max(...blue.slice(120, 180));
    const mid = (lo + hi) / 2;
    for (const [from, step] of [[0, 1], [cells.length - 1, -1]] as const) {
      let e = from; while (e >= 0 && e < cells.length && blue[e] < mid) e += step;
      const a10 = lo + (hi - lo) * 0.1, a90 = lo + (hi - lo) * 0.9;
      let p = e; while (p >= 0 && p < cells.length && blue[p] > a10) p -= step;
      let q = e; while (q >= 0 && q < cells.length && blue[q] < a90) q += step;
      width += Math.abs(q - p) * c.dx;
      const near = (ii: number) => luminance(px, cells[Math.max(0, Math.min(cells.length - 1, ii))]);
      const outside = near(e - step * 45), inside = near(e + step * 45);
      let darkest = 1e9;
      for (let o = -30; o <= 30; o++) darkest = Math.min(darkest, near(e + o * step));
      depth += 1 - darkest / Math.min(outside, inside);
      let m = 0;
      for (let o = -30; o <= 30; o++) { const u = cells[Math.max(0, Math.min(cells.length - 1, e + o * step))]; m = Math.max(m, Math.abs(S[u + c.w] - S[u - c.w]) / (2 * c.dx)); }
      steep += m;
      k++;
    }
  }
  return { contactDarkening: +(depth / k).toFixed(3), colourTransitionMm: +(width / k).toFixed(2), steepestContactSlope: +(steep / k).toFixed(2) };
}

function peaks(c: PaintCanvas, px: Uint8ClampedArray) {
  const spec = relight(c, DEFAULT_LIGHT, 'spec'), S = surfaceField(c);
  const lap: number[] = [];
  let thick = 0, glints = 0;
  for (let y = 2; y < c.h - 2; y++) for (let x = 2; x < c.w - 2; x++) {
    const i = y * c.w + x;
    // A peak stands well above the paint around it, whatever the total build-up.
    let around = 0;
    for (const o of [-8, 8, -8 * c.w, 8 * c.w]) around += S[i + o] ?? S[i];
    if (S[i] - around / 4 < 0.45) continue;
    thick++;
    if (spec[i * 3] > 235) glints++;
    lap.push((S[i + 1] + S[i - 1] + S[i + c.w] + S[i - c.w] - 4 * S[i]) / (c.dx * c.dx));
  }
  const m = lap.reduce((s, v) => s + v, 0) / lap.length;
  let v2 = 0, v4 = 0;
  for (const v of lap) { const d = v - m; v2 += d * d; v4 += d * d * d * d; }
  v2 /= lap.length; v4 /= lap.length;
  void px;
  // Facets are flat planes split by sharp creases, so curvature is either about zero or very large.
  return { thickCells: thick, glintsPer1000ThickCells: +(1000 * glints / thick).toFixed(2), curvatureKurtosis: +(v4 / (v2 * v2)).toFixed(1) };
}

const { canvas } = patchScene();
const px = relight(canvas, DEFAULT_LIGHT, 'paint');
const result = { contours: darkContours(canvas, px), wetContact: wetContact(), peaks: peaks(canvas, px) };
console.log(JSON.stringify(result, null, 1));
if (process.argv[2]) writeFileSync(process.argv[2], JSON.stringify(result, null, 1));
