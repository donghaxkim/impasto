/** Numbers for the three surface artifacts: plaid on knife faces, rigid colour bands, and glint shape. */
import { writeFileSync } from 'node:fs';
import { PaintCanvas } from '../src/canvas.ts';
import { paintStroke, Tool } from '../src/tool.ts';
import { albedoField, DEFAULT_LIGHT, relight, surfaceField } from '../src/relight.ts';
import { patchScene } from './scenes.ts';

const GROUND = [0.58, 0.47, 0.37] as const;
const RED = [0.85, 0.2, 0.15] as const, CREAM = [0.95, 0.9, 0.75] as const, BLUE = [0.1, 0.3, 0.6] as const, TEAL = [0.1, 0.45, 0.5] as const;

function boxBlur(a: Float64Array, w: number, h: number, r: number): Float64Array {
  const out = new Float64Array(w * h), tmp = new Float64Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let s = 0, n = 0;
    for (let k = Math.max(0, x - r); k <= Math.min(w - 1, x + r); k++) { s += a[y * w + k]; n++; }
    tmp[y * w + x] = s / n;
  }
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let s = 0, n = 0;
    for (let k = Math.max(0, y - r); k <= Math.min(h - 1, y + r); k++) { s += tmp[k * w + x]; n++; }
    out[y * w + x] = s / n;
  }
  return out;
}
/** High-pass RMS inside a rectangle, split into all detail and detail finer than about 1 mm. */
function faceDetail(c: PaintCanvas, x0: number, y0: number, x1: number, y1: number) {
  const S = surfaceField(c), A = albedoField(c), lum = new Float64Array(c.n);
  for (let i = 0; i < c.n; i++) lum[i] = 0.2126 * A[i * 3] + 0.7152 * A[i * 3 + 1] + 0.0722 * A[i * 3 + 2];
  const blurS = boxBlur(S, c.w, c.h, 6), blurL = boxBlur(lum, c.w, c.h, 6);
  let hs = 0, hl = 0, sl = 0, n = 0;
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
    const i = y * c.w + x;
    const a = S[i] - blurS[i], b = lum[i] - blurL[i];
    const dx = (a - (S[i - 1] - blurS[i - 1])) / c.dx, dy = (a - (S[i - c.w] - blurS[i - c.w])) / c.dx;
    hs += a * a; hl += b * b; sl += dx * dx + dy * dy; n++;
  }
  return { heightMicrons: +(1000 * Math.sqrt(hs / n)).toFixed(1), slopeRms: +Math.sqrt(sl / n).toFixed(4), albedoRms: +Math.sqrt(hl / n).toFixed(5) };
}
function knifeOverBed(angle: number) {
  const c = new PaintCanvas(100, 60, 0.1, GROUND, 3);
  const bed = new Tool({ kind: 'knife', widthMm: 14, nodes: 112, seed: 21 });
  for (const [x, seed] of [[35, 301], [62, 302]] as const) {
    bed.load(12, BLUE, BLUE, 0, seed);
    paintStroke(c, bed, { points: [[x, 6], [x, 22], [x, 38], [x, 54]], gapMm: 1.3, seed });
    bed.wipe(0.98);
  }
  const t = new Tool({ kind: 'knife', widthMm: 20, nodes: 128, seed: 7 });
  t.load(22, TEAL, TEAL, 0, 5);
  const P = (u: number): [number, number] => [50 + (u - 0.5) * 80, 30 + (u - 0.5) * 80 * angle];
  paintStroke(c, t, { points: [P(0), P(1 / 3), P(2 / 3), P(1)], gapMm: 1.1, seed: 99 });
  return { c, rect: (angle > 0.3 ? [445, 275, 555, 325] : [320, 270, 620, 330]) as readonly [number, number, number, number] };
}
function bands() {
  const c = new PaintCanvas(100, 50, 0.1, GROUND, 3);
  const t = new Tool({ kind: 'knife', widthMm: 22, nodes: 128, seed: 7 });
  t.load(22, RED, CREAM, 0.4, 5);
  paintStroke(c, t, { points: [[8, 25], [35, 25], [60, 25], [92, 25]], gapMm: 1.1, seed: 99 });
  const A = albedoField(c);
  const profile = (x: number) => { const o: number[] = []; for (let y = 170; y < 330; y++) o.push(A[(y * c.w + x) * 3 + 2]); return o; };
  const corr = (a: number[], b: number[]) => {
    const ma = a.reduce((s, v) => s + v, 0) / a.length, mb = b.reduce((s, v) => s + v, 0) / b.length;
    let n = 0, da = 0, db = 0;
    for (let i = 0; i < a.length; i++) { n += (a[i] - ma) * (b[i] - mb); da += (a[i] - ma) ** 2; db += (b[i] - mb) ** 2; }
    return n / Math.sqrt(da * db + 1e-12);
  };
  const measure = (gap: number) => { let s = 0, k = 0; for (let x = 180; x + gap <= 640; x += 20) { s += corr(profile(x), profile(x + gap)); k++; } return +(s / k).toFixed(3); };
  let contrast = 0, k = 0;
  for (let x = 180; x <= 640; x += 20) { const p = profile(x), m = p.reduce((s, v) => s + v, 0) / p.length; contrast += Math.sqrt(p.reduce((s, v) => s + (v - m) ** 2, 0) / p.length); k++; }
  return { correlationAt5mm: measure(50), correlationAt20mm: measure(200), colourContrast: +(contrast / k).toFixed(4) };
}
function glints() {
  const { canvas: c } = patchScene();
  const px = relight(c, DEFAULT_LIGHT, 'paint'), spec = relight(c, DEFAULT_LIGHT, 'spec'), S = surfaceField(c);
  void px;
  // A glint is a pixel whose specular term alone reaches near white, whatever the paint under it.
  const seen = new Uint8Array(c.n), white = (i: number) => spec[i * 3] > 235;
  const sizes: number[] = [];
  let flatSpec = 0, flatN = 0, midSpec = 0, whiteFlat = 0, whiteN = 0;
  for (let y = 2; y < c.h - 2; y++) for (let x = 2; x < c.w - 2; x++) {
    const i = y * c.w + x;
    const slope = Math.sqrt((S[i + 1] - S[i - 1]) ** 2 + (S[i + c.w] - S[i - c.w]) ** 2) / (2 * c.dx);
    if (slope < 0.1) { flatSpec += spec[i * 3]; flatN++; }
    if (spec[i * 3] > 60 && spec[i * 3] < 200) midSpec++;
    if (white(i)) { whiteN++; if (slope < 0.1) whiteFlat++; }
    if (!white(i) || seen[i]) continue;
    const stack = [i]; seen[i] = 1; let size = 0;
    while (stack.length) {
      const a = stack.pop()!; size++;
      for (const b of [a - 1, a + 1, a - c.w, a + c.w]) if (b >= 0 && b < c.n && !seen[b] && white(b)) { seen[b] = 1; stack.push(b); }
    }
    sizes.push(size);
  }
  sizes.sort((a, b) => a - b);
  return {
    whitePercent: +(100 * whiteN / c.n).toFixed(3), glintCount: sizes.length,
    medianGlintPixels: sizes[Math.floor(sizes.length / 2)] ?? 0, p95GlintPixels: sizes[Math.floor(sizes.length * 0.95)] ?? 0, largestGlintPixels: sizes[sizes.length - 1] ?? 0,
    glintsOnFlatPaintPercent: +(100 * whiteFlat / Math.max(1, whiteN)).toFixed(1),
    flatSheenLevel: +(flatSpec / flatN).toFixed(2), satinPixelsPercent: +(100 * midSpec / c.n).toFixed(2),
  };
}
const shallow = knifeOverBed(0.09), steep = knifeOverBed(0.55);
const result = {
  plaidNearlyHorizontal: faceDetail(shallow.c, ...shallow.rect),
  plaidDiagonal: faceDetail(steep.c, ...steep.rect),
  bands: bands(),
  glints: glints(),
};
console.log(JSON.stringify(result, null, 1));
if (process.argv[2]) writeFileSync(process.argv[2], JSON.stringify(result, null, 1));
