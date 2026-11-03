/** Crevice depth on controlled shapes, and contrast across the patch. Values are linear light. */
import { writeFileSync } from 'node:fs';
import { PaintCanvas } from '../src/canvas.ts';
import { DEFAULT_LIGHT, relight } from '../src/relight.ts';
import { srgbToLinear } from '../src/pigment.ts';
import { patchScene } from './scenes.ts';

const luma = (px: Uint8ClampedArray, i: number) => 0.2126 * srgbToLinear(px[i * 3] / 255) + 0.7152 * srgbToLinear(px[i * 3 + 1] / 255) + 0.0722 * srgbToLinear(px[i * 3 + 2] / 255);

/** Flat paint with three features across x: a narrow groove, a shallow step and a tall lip. */
export function featureCanvas(): PaintCanvas {
  const c = new PaintCanvas(80, 40, 0.1, [0.58, 0.47, 0.37], 3);
  const ks = 0.3;
  for (let y = 0; y < c.h; y++) for (let x = 0; x < c.w; x++) {
    const X = x * c.dx, i = y * c.w + x;
    c.tooth[i] = 0;
    let h = 2;
    const g = Math.abs(X - 15) / 0.45;
    if (g < 1) h -= 1.3 * (1 - g);
    // A raised plateau whose right edge is a shallow one-sided step, as where two slabs lap.
    if (X > 30 && X <= 45.4) h += 0.35 * Math.min(1, (45.4 - X) / 0.4);
    // A tall slab whose right edge drops 3 mm, as under a heavy overlapping lip.
    if (X > 50 && X <= 61.3) h += 3 * Math.min(1, (X - 50) / 1.5, (61.3 - X) / 1.3);
    c.top[i] = 0.06; c.under[i] = h - 0.06;
    for (let k = 0; k < 3; k++) { c.topP[i * 3 + k] = 0.06 * ks; c.underP[i * 3 + k] = (h - 0.06) * ks; }
    c.rough[i] = 0.3;
  }
  return c;
}
export function featureRatios() {
  const c = featureCanvas();
  const px = relight(c, { ...DEFAULT_LIGHT, azimuth: 180 }, 'paint');
  const row = 200, at = (xMm: number) => luma(px, row * c.w + Math.round(xMm / c.dx));
  const open = at(22);
  const darkest = (a: number, b: number) => { let m = 1e9; for (let x = a; x <= b; x += c.dx) m = Math.min(m, at(x)); return m; };
  const mean = (a: number, b: number) => { let m = 0, n = 0; for (let x = a; x <= b; x += c.dx) { m += at(x); n++; } return m / n; };
  return { grooveDarkest: +(darkest(14, 16) / open).toFixed(3), shallowStepDarkest: +(darkest(45, 47) / open).toFixed(3), tallLipDarkest: +(darkest(60, 66) / open).toFixed(3), tallLipShadowMean: +(mean(61.5, 64) / open).toFixed(3) };
}
function patchContrast() {
  const { canvas: c } = patchScene();
  const px = relight(c, DEFAULT_LIGHT, 'paint'), spec = relight(c, DEFAULT_LIGHT, 'spec');
  const L = new Float64Array(c.n), E = new Float32Array(c.n);
  const values: number[] = [];
  let black = 0, glint = 0;
  for (let i = 0; i < c.n; i++) {
    L[i] = luma(px, i); values.push(L[i]);
    E[i] = 0.2126 * px[i * 3] + 0.7152 * px[i * 3 + 1] + 0.0722 * px[i * 3 + 2];
    if (E[i] < 45) black++;
    if (spec[i * 3] > 235) glint++;
  }
  values.sort((a, b) => a - b);
  const q = (p: number) => values[Math.min(values.length - 1, Math.floor(values.length * p))];
  // Local contrast at about 2 mm, and thin dark contours from a black top-hat of encoded values.
  const box = (src: Float64Array | Float32Array, r: number) => {
    const t = new Float64Array(c.n), o = new Float64Array(c.n);
    for (let y = 0; y < c.h; y++) { let s = 0; for (let x = -r; x <= r; x++) s += src[y * c.w + Math.max(0, x)]; for (let x = 0; x < c.w; x++) { t[y * c.w + x] = s / (2 * r + 1); s += src[y * c.w + Math.min(c.w - 1, x + r + 1)] - src[y * c.w + Math.max(0, x - r)]; } }
    for (let x = 0; x < c.w; x++) { let s = 0; for (let y = -r; y <= r; y++) s += t[Math.max(0, y) * c.w + x]; for (let y = 0; y < c.h; y++) { o[y * c.w + x] = s / (2 * r + 1); s += t[Math.min(c.h - 1, y + r + 1) * c.w + x] - t[Math.max(0, y - r) * c.w + x]; } }
    return o;
  };
  const blur = box(L, 20);
  let lc = 0;
  for (let i = 0; i < c.n; i++) { const d = (L[i] - blur[i]) / (blur[i] + 0.02); lc += d * d; }
  const r = 4;
  const morph = (src: Float32Array, pick: (a: number, b: number) => number, start: number) => {
    const tmp = new Float32Array(c.n), out = new Float32Array(c.n);
    for (let y = 0; y < c.h; y++) for (let x = 0; x < c.w; x++) { let v = start; for (let k = Math.max(0, x - r); k <= Math.min(c.w - 1, x + r); k++) v = pick(v, src[y * c.w + k]); tmp[y * c.w + x] = v; }
    for (let y = 0; y < c.h; y++) for (let x = 0; x < c.w; x++) { let v = start; for (let k = Math.max(0, y - r); k <= Math.min(c.h - 1, y + r); k++) v = pick(v, tmp[k * c.w + x]); out[y * c.w + x] = v; }
    return out;
  };
  const closed = morph(morph(E, Math.max, -1), Math.min, 1e9);
  let strong = 0, blackThin = 0;
  for (let i = 0; i < c.n; i++) { if (closed[i] - E[i] > 45) { strong++; if (E[i] < 45) blackThin++; } }
  return {
    localContrast: +Math.sqrt(lc / c.n).toFixed(3), darkestOnePercent: +q(0.01).toFixed(4), darkestFivePercent: +q(0.05).toFixed(4), median: +q(0.5).toFixed(3),
    dynamicRange: +(q(0.999) / Math.max(q(0.01), 1e-4)).toFixed(1), nearBlackPercent: +(100 * black / c.n).toFixed(3), strongContourPercent: +(100 * strong / c.n).toFixed(3), glintPercent: +(100 * glint / c.n).toFixed(3), nearBlackInThinLinesPercent: +(100 * blackThin / c.n).toFixed(3),
  };
}
if (import.meta.url === `file://${process.argv[1]}`) {
  const result = { features: featureRatios(), patch: patchContrast() };
  console.log(JSON.stringify(result, null, 1));
  if (process.argv[2]) writeFileSync(process.argv[2], JSON.stringify(result, null, 1));
}
