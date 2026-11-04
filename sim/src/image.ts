/**
 * Image analysis for the stroke planner: resampling onto a millimetre grid, colour conversion,
 * blurs and an edge-following direction field. Uses only + - * / sqrt floor and dmath, so the
 * same image gives the same analysis on any JS engine.
 */
import { srgbToLinear } from './pigment.ts';

/** 8-bit sRGB pixels, 3 bytes per pixel, row-major. */
export interface RgbImage { w: number; h: number; data: Uint8Array | Uint8ClampedArray; }

/** A multi-channel float grid. Channel k of cell i is at data[i * ch + k]. */
export interface Grid { w: number; h: number; ch: number; data: Float64Array; }

export const makeGrid = (w: number, h: number, ch: number): Grid => ({ w, h, ch, data: new Float64Array(w * h * ch) });

// sRGB byte -> linear, computed once with the deterministic pow.
const LIN = new Float64Array(256);
for (let i = 0; i < 256; i++) LIN[i] = srgbToLinear(i / 255);

/**
 * Area-average the image onto a gw x gh grid in linear RGB. Each output cell takes the exact
 * overlap-weighted mean of the source pixels it covers, so nothing aliases.
 */
export function resampleLinear(img: RgbImage, gw: number, gh: number): Grid {
  const out = makeGrid(gw, gh, 3);
  const sx = img.w / gw, sy = img.h / gh;
  // Per-axis overlap tables: for each output index, the source range and the weights at its ends.
  const spans = (n: number, s: number, src: number) => {
    const lo = new Int32Array(n), hi = new Int32Array(n), wlo = new Float64Array(n), whi = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const a = i * s, b = Math.min(src, (i + 1) * s);
      lo[i] = Math.floor(a); hi[i] = Math.min(src - 1, Math.ceil(b) - 1);
      wlo[i] = lo[i] + 1 - a; whi[i] = b - hi[i];
      if (lo[i] === hi[i]) wlo[i] = whi[i] = b - a;
    }
    return { lo, hi, wlo, whi };
  };
  const X = spans(gw, sx, img.w), Y = spans(gh, sy, img.h);
  const row = new Float64Array(gw * 3);
  for (let gy = 0; gy < gh; gy++) {
    row.fill(0);
    let wy = 0;
    for (let y = Y.lo[gy]; y <= Y.hi[gy]; y++) {
      const fy = y === Y.lo[gy] ? Y.wlo[gy] : y === Y.hi[gy] ? Y.whi[gy] : 1;
      wy += fy;
      for (let gx = 0; gx < gw; gx++) {
        let r = 0, g = 0, b = 0, wx = 0;
        for (let x = X.lo[gx]; x <= X.hi[gx]; x++) {
          const fx = x === X.lo[gx] ? X.wlo[gx] : x === X.hi[gx] ? X.whi[gx] : 1;
          const p = (y * img.w + x) * 3;
          r += LIN[img.data[p]] * fx; g += LIN[img.data[p + 1]] * fx; b += LIN[img.data[p + 2]] * fx; wx += fx;
        }
        row[gx * 3] += r / wx * fy; row[gx * 3 + 1] += g / wx * fy; row[gx * 3 + 2] += b / wx * fy;
      }
    }
    for (let i = 0; i < gw * 3; i++) out.data[gy * gw * 3 + i] = row[i] / wy;
  }
  return out;
}

/** Box blur of radius r along both axes, clamped at the borders. Three passes approximate a Gaussian. */
export function boxBlur(src: Grid, r: number): Grid {
  if (r <= 0) return { ...src, data: src.data.slice() };
  const { w, h, ch } = src, tmp = new Float64Array(src.data.length), out = new Float64Array(src.data.length);
  const norm = 1 / (2 * r + 1);
  for (let y = 0; y < h; y++) for (let k = 0; k < ch; k++) {
    let sum = 0;
    for (let x = -r; x <= r; x++) sum += src.data[(y * w + (x < 0 ? 0 : x >= w ? w - 1 : x)) * ch + k];
    for (let x = 0; x < w; x++) {
      tmp[(y * w + x) * ch + k] = sum * norm;
      const add = x + r + 1, sub = x - r;
      sum += src.data[(y * w + (add >= w ? w - 1 : add)) * ch + k] - src.data[(y * w + (sub < 0 ? 0 : sub)) * ch + k];
    }
  }
  // Column sweep row by row, one running sum per column and channel: the same additions in the
  // same order as a per-column loop (so the same bits), reading memory sequentially.
  const wc = w * ch, sums = new Float64Array(wc);
  for (let y = -r; y <= r; y++) {
    const row = (y < 0 ? 0 : y >= h ? h - 1 : y) * wc;
    for (let j = 0; j < wc; j++) sums[j] += tmp[row + j];
  }
  for (let y = 0; y < h; y++) {
    const row = y * wc, add = y + r + 1, sub = y - r;
    const rowAdd = (add >= h ? h - 1 : add) * wc, rowSub = (sub < 0 ? 0 : sub) * wc;
    for (let j = 0; j < wc; j++) {
      out[row + j] = sums[j] * norm;
      sums[j] += tmp[rowAdd + j] - tmp[rowSub + j];
    }
  }
  return { w, h, ch, data: out };
}

/**
 * Approximate Gaussian blur with standard deviation sigma (in cells). Small sigmas use a
 * three-tap kernel [a, 1 - 2a, a] with variance 2a; larger ones use three box passes, whose
 * smallest step (a 3-wide box, three times) would already be sigma = 1.4 and erase thin features.
 */
export function gaussBlur(src: Grid, sigma: number): Grid {
  if (sigma < 0.3) return { ...src, data: src.data.slice() };
  if (sigma < 1) return tap3(src, sigma * sigma * 0.5);
  // Box width for three passes: w = sqrt(12 sigma^2 / 3 + 1).
  const r = Math.max(1, Math.floor((Math.sqrt(4 * sigma * sigma + 1) - 1) / 2 + 0.5));
  return boxBlur(boxBlur(boxBlur(src, r), r), r);
}
function tap3(src: Grid, a: number): Grid {
  const { w, h, ch } = src, tmp = new Float64Array(src.data.length), out = new Float64Array(src.data.length), b = 1 - 2 * a, d = src.data;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) for (let k = 0; k < ch; k++) {
    const l = x > 0 ? x - 1 : 0, r = x < w - 1 ? x + 1 : x;
    tmp[(y * w + x) * ch + k] = a * d[(y * w + l) * ch + k] + b * d[(y * w + x) * ch + k] + a * d[(y * w + r) * ch + k];
  }
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) for (let k = 0; k < ch; k++) {
    const u = y > 0 ? y - 1 : 0, v = y < h - 1 ? y + 1 : y;
    out[(y * w + x) * ch + k] = a * tmp[(u * w + x) * ch + k] + b * tmp[(y * w + x) * ch + k] + a * tmp[(v * w + x) * ch + k];
  }
  return { w, h, ch, data: out };
}

/**
 * dmath's dcbrt to the bit, with fewer iterations: dcbrt runs Newton's step 40 times from
 * max(v, 1); after a few steps the iterate either stops changing (a fixed point, so every later
 * step gives the same value) or alternates between two values (then step 40's value is decided by
 * parity). Both are detected and the 40th iterate returned; anything else runs all 40 steps.
 * `tests/planner.test.ts` checks it against dcbrt.
 */
export function cbrtFast(v: number): number {
  if (v <= 0) return 0;
  let x = v > 1 ? v : 1, prev = NaN;
  for (let i = 0; i < 40; i++) {
    const y = (2 * x + v / (x * x)) / 3;
    if (y === x) return y;
    if (y === prev) return (40 - (i + 1)) % 2 === 0 ? y : x;
    prev = x; x = y;
  }
  return x;
}

/** Linear RGB -> OKLab. Distances in OKLab track perceived colour difference. */
export function toOklab(lin: Grid): Grid {
  const out = makeGrid(lin.w, lin.h, 3), n = lin.w * lin.h, d = lin.data, o = out.data;
  for (let i = 0; i < n; i++) {
    const r = d[i * 3], g = d[i * 3 + 1], b = d[i * 3 + 2];
    const l = cbrtFast(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
    const m = cbrtFast(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
    const s = cbrtFast(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
    o[i * 3] = 0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s;
    o[i * 3 + 1] = 1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s;
    o[i * 3 + 2] = 0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s;
  }
  return out;
}
export function oklab(r: number, g: number, b: number): [number, number, number] {
  const l = cbrtFast(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = cbrtFast(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = cbrtFast(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s,
  ];
}

/**
 * Edge-following direction field from the colour structure tensor (Di Zenzo: tensors of the
 * three OKLab channels are summed, so an edge between equally bright colours still counts).
 *
 * Result per cell: [c, s, coherence, strength]. (c, s) is the doubled-angle unit vector
 * (cos 2a, sin 2a) of the direction along edges and forms; read it with `directionAt`, which
 * interpolates in doubled-angle space so opposite signs never cancel. Coherence is 0 for flat or
 * isotropic areas and 1 for a clean edge. Where coherence is low the field leans toward `flat`,
 * a fallback direction (horizontal suits most landscapes).
 *
 * Smoothing happens on the tensor, which is the same as averaging doubled angles, so opposite
 * directions reinforce instead of cancelling. No angles or trig are used.
 */
export function directionField(lab: Grid, sigma: number, flat: readonly [number, number], flatBias: number): Grid {
  const { w, h } = lab, n = w * h;
  const T = makeGrid(w, h, 3);
  const at = (x: number, y: number, k: number) => lab.data[((y < 0 ? 0 : y >= h ? h - 1 : y) * w + (x < 0 ? 0 : x >= w ? w - 1 : x)) * 3 + k];
  // Scharr derivatives: better rotational symmetry than Sobel.
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let E = 0, F = 0, G = 0;
    for (let k = 0; k < 3; k++) {
      // Lightness carries form; chroma channels get a little less say.
      const wk = k === 0 ? 1 : 0.6;
      const gx = (3 * (at(x + 1, y - 1, k) - at(x - 1, y - 1, k)) + 10 * (at(x + 1, y, k) - at(x - 1, y, k)) + 3 * (at(x + 1, y + 1, k) - at(x - 1, y + 1, k))) / 32;
      const gy = (3 * (at(x - 1, y + 1, k) - at(x - 1, y - 1, k)) + 10 * (at(x, y + 1, k) - at(x, y - 1, k)) + 3 * (at(x + 1, y + 1, k) - at(x + 1, y - 1, k))) / 32;
      E += wk * gx * gx; F += wk * gx * gy; G += wk * gy * gy;
    }
    const i = (y * w + x) * 3;
    T.data[i] = E; T.data[i + 1] = F; T.data[i + 2] = G;
  }
  const S = gaussBlur(T, sigma);
  // Typical tensor magnitude, for a strength value that is comparable across images.
  let meanTrace = 0;
  for (let i = 0; i < n; i++) meanTrace += S.data[i * 3] + S.data[i * 3 + 2];
  meanTrace = meanTrace / n + 1e-12;
  const out = makeGrid(w, h, 4);
  const fl = Math.sqrt(flat[0] * flat[0] + flat[1] * flat[1]) || 1;
  // Doubled-angle form of the fallback direction: (cos 2a, sin 2a) = (x^2 - y^2, 2xy) for a unit vector.
  const fx = flat[0] / fl, fy = flat[1] / fl, fc = fx * fx - fy * fy, fs = 2 * fx * fy;
  for (let i = 0; i < n; i++) {
    const E = S.data[i * 3], F = S.data[i * 3 + 1], G = S.data[i * 3 + 2];
    const tr = E + G, aniso = Math.sqrt((E - G) * (E - G) + 4 * F * F);
    const coherence = tr > 1e-12 ? aniso / tr : 0;
    // The tangent is perpendicular to the gradient, so its doubled angle is the gradient's plus 180 degrees.
    let c = tr > 1e-12 ? (G - E) / tr : 0, s = tr > 1e-12 ? -2 * F / tr : 0;
    c += fc * flatBias; s += fs * flatBias;
    const m = Math.sqrt(c * c + s * s);
    if (m > 1e-12) { c /= m; s /= m; } else { c = fc; s = fs; }
    out.data[i * 4] = c; out.data[i * 4 + 1] = s; out.data[i * 4 + 2] = coherence;
    out.data[i * 4 + 3] = tr / meanTrace;
  }
  return out;
}

/**
 * Direction across the turn of a form, from how it turns in the light: along the iso-luminance
 * contours of the image's lightness (OKLab L) blurred to form scale, so a stroke laid along it keeps
 * one value and the next stroke steps down the turn (a knife painter's faceting).
 *
 * The cue is meant for smooth forms, where the colour structure tensor is weak or noisy (skin pores,
 * fine wrinkles) and strokes would otherwise comb along arbitrary iso-lines. Its weight is the
 * product of:
 * - coherence of the blurred lightness gradient over the window (one clear turn, not a dimple);
 * - smoothness: the share of the window's fine lightness-gradient energy that survives blurring
 *   (about 1 for a pure ramp, near 0 for texture such as hair or foliage);
 * - significance: the blurred gradient against `minGrad` (lightness per cell), so flat areas, where
 *   any direction is noise, get no say.
 *
 * Result per cell: [c, s, weight, gradient] with (c, s) the doubled-angle unit direction along the
 * contours (read with `directionAt`), weight 0-1, and the blurred lightness gradient per cell.
 * Only + - * / sqrt, so deterministic.
 */
export function shadingField(lab: Grid, sigma: number, minGrad: number): Grid {
  const { w, h } = lab, n = w * h;
  const L = makeGrid(w, h, 1);
  for (let i = 0; i < n; i++) L.data[i] = lab.data[i * 3];
  // Gradient tensor (central differences) of a single-channel grid.
  const tensor = (src: Grid) => {
    const T = makeGrid(w, h, 3), d = src.data;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const gx = ((x + 1 < w ? d[i + 1] : d[i]) - (x > 0 ? d[i - 1] : d[i])) * 0.5;
      const gy = ((y + 1 < h ? d[i + w] : d[i]) - (y > 0 ? d[i - w] : d[i])) * 0.5;
      T.data[i * 3] = gx * gx; T.data[i * 3 + 1] = gx * gy; T.data[i * 3 + 2] = gy * gy;
    }
    return T;
  };
  const S = gaussBlur(tensor(gaussBlur(L, sigma)), sigma), Fn = gaussBlur(tensor(gaussBlur(L, 0.8)), sigma);
  const out = makeGrid(w, h, 4);
  for (let i = 0; i < n; i++) {
    const E = S.data[i * 3], F = S.data[i * 3 + 1], G = S.data[i * 3 + 2], tr = E + G;
    const fine = Fn.data[i * 3] + Fn.data[i * 3 + 2];
    if (tr < 1e-14) { out.data[i * 4] = 1; continue; }
    const coherence = Math.sqrt((E - G) * (E - G) + 4 * F * F) / tr;
    const smooth = fine > 1e-14 ? tr / fine : 0, grad = Math.sqrt(tr);
    // Tangent perpendicular to the gradient: doubled angle of the gradient plus 180 degrees.
    let c = (G - E) / tr, s = -2 * F / tr;
    const m = Math.sqrt(c * c + s * s);
    if (m > 1e-12) { c /= m; s /= m; } else { c = 1; s = 0; }
    out.data[i * 4] = c; out.data[i * 4 + 1] = s;
    out.data[i * 4 + 2] = smoothstepI((coherence - 0.3) / 0.5) * smoothstepI((smooth - 0.02) / 0.08) * smoothstepI((grad - minGrad) / minGrad);
    out.data[i * 4 + 3] = grad;
  }
  return out;
}
const smoothstepI = (x: number) => { const u = x < 0 ? 0 : x > 1 ? 1 : x; return u * u * (3 - 2 * u); };

/** Bilinear sample of channel k at grid coordinates (x, y), clamped at the borders. */
export function sample(g: Grid, x: number, y: number, k: number): number {
  const { w, h, ch } = g;
  const xc = x < 0 ? 0 : x > w - 1 ? w - 1 : x, yc = y < 0 ? 0 : y > h - 1 ? h - 1 : y;
  const x0 = Math.floor(xc), y0 = Math.floor(yc), x1 = x0 + 1 < w ? x0 + 1 : x0, y1 = y0 + 1 < h ? y0 + 1 : y0;
  const fx = xc - x0, fy = yc - y0, d = g.data;
  const a = d[(y0 * w + x0) * ch + k], b = d[(y0 * w + x1) * ch + k], c = d[(y1 * w + x0) * ch + k], e = d[(y1 * w + x1) * ch + k];
  return (a + (b - a) * fx) + ((c + (e - c) * fx) - (a + (b - a) * fx)) * fy;
}

/**
 * Unit direction along forms at grid coordinates (x, y), with its sign chosen to agree with
 * (px, py) when that is non-zero. Writes into out[0], out[1].
 */
export function directionAt(field: Grid, x: number, y: number, px: number, py: number, out: Float64Array): void {
  let c = sample(field, x, y, 0), s = sample(field, x, y, 1);
  const m = Math.sqrt(c * c + s * s);
  if (m < 1e-9) { c = 1; s = 0; } else { c /= m; s /= m; }
  // Halve the angle: cos a = sqrt((1 + cos 2a) / 2), and sin a takes the sign of sin 2a.
  let tx = Math.sqrt((1 + c) * 0.5), ty = Math.sqrt((1 - c) * 0.5);
  if (s < 0) ty = -ty;
  if (tx * px + ty * py < 0) { tx = -tx; ty = -ty; }
  out[0] = tx; out[1] = ty;
}

/**
 * Two direction fields merged cell by cell, each weighted by its coherence squared. A fine field
 * follows small edges but is swamped by texture (branches, strata); a coarse one sees the larger
 * form (a tree's silhouette). Where the coarse form is clean it wins; where only the fine one is
 * coherent, it keeps its say. Strength and coherence come from the fine field.
 */
export function mergeFields(fine: Grid, coarse: Grid, coarseWeight: number): Grid {
  const out = makeGrid(fine.w, fine.h, 4), n = fine.w * fine.h;
  for (let i = 0; i < n; i++) {
    const cf = fine.data[i * 4 + 2], cc = coarse.data[i * 4 + 2];
    const wf = cf * cf + 1e-6, wc = cc * cc * coarseWeight;
    let c = fine.data[i * 4] * wf + coarse.data[i * 4] * wc, s = fine.data[i * 4 + 1] * wf + coarse.data[i * 4 + 1] * wc;
    const m = Math.sqrt(c * c + s * s);
    if (m > 1e-12) { c /= m; s /= m; } else { c = fine.data[i * 4]; s = fine.data[i * 4 + 1]; }
    out.data[i * 4] = c; out.data[i * 4 + 1] = s; out.data[i * 4 + 2] = cf; out.data[i * 4 + 3] = fine.data[i * 4 + 3];
  }
  return out;
}
