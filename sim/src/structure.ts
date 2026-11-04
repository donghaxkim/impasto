/**
 * The painting representation: what a painter reads in a photo before laying paint. All maps are
 * on the planner's analysis grid, in 0-1 unless noted, and depend only on the image, so the same
 * photo always gives the same maps. Nothing here knows about subjects (trees, water, rock); the
 * planner chooses stroke primitives from these general properties.
 */
import { directionField, gaussBlur, makeGrid, type Grid } from './image.ts';

export interface PaintingMaps {
  w: number; h: number;
  /** Fine structure strength relative to the image mean (0 = flat; 1 = typical; can exceed 1). */
  detail: Float64Array;
  /** Coherence of that structure: 1 for a clean line or edge, 0 for isotropic texture. */
  coherence: Float64Array;
  /** Strong, coherent, large-scale edges that make shapes recognisable: ridgelines, trunks, shores. */
  silhouette: Float64Array;
  /** Areas with little structure, where paint should be laid broad and quiet. */
  flat: Float64Array;
  /** How much relief an area deserves: low in flat areas, high in structured and light ones. */
  relief: Float64Array;
}

const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);
const smoothstep = (x: number) => { const u = clamp01(x); return u * u * (3 - 2 * u); };

/** Percentile of a typed array, by sorting a copy (deterministic). */
function percentile(a: Float64Array, q: number): number {
  const s = a.slice().sort();
  return s[Math.min(s.length - 1, Math.floor(q * s.length))];
}

/**
 * @param lab OKLab image on the analysis grid.
 * @param cellMm analysis cell size, mm.
 */
export function paintingMaps(lab: Grid, cellMm: number): PaintingMaps {
  const { w, h } = lab, n = w * h;
  // Fine structure at about 1 mm.
  const fine = directionField(gaussBlur(lab, 0.5 / cellMm), 1 / cellMm, [1, 0], 0);
  const detail = new Float64Array(n), coherence = new Float64Array(n);
  for (let i = 0; i < n; i++) { detail[i] = fine.data[i * 4 + 3]; coherence[i] = fine.data[i * 4 + 2]; }

  // Silhouettes: colour gradient at about 1.2 mm, among the strongest in this image, and coherent at
  // about 3 mm (so a ridge or a trunk counts, a patch of foliage texture does not).
  const blurred = gaussBlur(lab, 1.2 / cellMm);
  const grad = new Float64Array(n);
  const at = (x: number, y: number, k: number) => blurred.data[((y < 0 ? 0 : y >= h ? h - 1 : y) * w + (x < 0 ? 0 : x >= w ? w - 1 : x)) * 3 + k];
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let s = 0;
    for (let k = 0; k < 3; k++) {
      const gx = (at(x + 1, y, k) - at(x - 1, y, k)) * 0.5, gy = (at(x, y + 1, k) - at(x, y - 1, k)) * 0.5;
      s += (k === 0 ? 1 : 0.6) * (gx * gx + gy * gy);
    }
    grad[y * w + x] = Math.sqrt(s);
  }
  const g92 = percentile(grad, 0.92) + 1e-9;
  const wide = directionField(blurred, 3 / cellMm, [1, 0], 0);
  const silhouette = new Float64Array(n);
  for (let i = 0; i < n; i++) silhouette[i] = smoothstep((grad[i] / g92 - 0.55) / 0.7) * smoothstep((wide.data[i * 4 + 2] - 0.25) / 0.4);

  // Flatness and target relief, smoothed so neighbouring strokes agree.
  const flatRaw = makeGrid(w, h, 1), reliefRaw = makeGrid(w, h, 1);
  for (let i = 0; i < n; i++) {
    const L = lab.data[i * 3];
    flatRaw.data[i] = 1 - smoothstep((detail[i] - 0.08) / 0.3);
    // Structure earns relief; light paint is laid thicker; silhouettes get a ridge of paint.
    reliefRaw.data[i] = clamp01(smoothstep((detail[i] - 0.12) / 0.9) * (0.65 + 0.35 * clamp01((L - 0.3) / 0.6)) + 0.25 * silhouette[i]);
  }
  const flatS = gaussBlur(flatRaw, 2 / cellMm), reliefS = gaussBlur(reliefRaw, 2 / cellMm);
  return { w, h, detail, coherence, silhouette, flat: flatS.data, relief: reliefS.data };
}

/** Bilinear sample of a single-channel map at cell-edge coordinates (cell i spans [i, i + 1)). */
export function mapAt(m: Float64Array, w: number, h: number, x: number, y: number): number {
  const xc = x - 0.5 < 0 ? 0 : x - 0.5 > w - 1 ? w - 1 : x - 0.5, yc = y - 0.5 < 0 ? 0 : y - 0.5 > h - 1 ? h - 1 : y - 0.5;
  const x0 = Math.floor(xc), y0 = Math.floor(yc), x1 = x0 + 1 < w ? x0 + 1 : x0, y1 = y0 + 1 < h ? y0 + 1 : y0, fx = xc - x0, fy = yc - y0;
  const a = m[y0 * w + x0], b = m[y0 * w + x1], c = m[y1 * w + x0], d = m[y1 * w + x1];
  return a + (b - a) * fx + ((c + (d - c) * fx) - (a + (b - a) * fx)) * fy;
}
