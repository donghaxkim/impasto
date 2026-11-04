import { clamp, dcos, dsin, hash, radians, smooth } from './dmath.ts';
import type { PaintCanvas } from './canvas.ts';
import type { ImpastoSurface } from './surface.ts';
import { linearToSrgb, reflectanceFromKs } from './pigment.ts';

export interface LightSettings {
  /** Direction toward the light in image space: 0 = right, 90 = down, 225 = upper left. */
  azimuth: number;
  /** Angle above the canvas plane. */
  elevation: number;
  /** Depth of cast and horizon shadows, 0.75-0.85. */
  occlusion: number;
  /** Multiplier on the height field. */
  relief: number;
  exposure: number;
  /** Strength of the display glow around the brightest highlights. 0 turns it off. */
  glow: number;
  /** Surface look (see LOOKS). Defaults to 'locked', the reference look. */
  look?: LookName;
}

/**
 * Surface look. 'locked' is the reference: glossy wet paint, pin-prick crest glints, deep cavities.
 * 'oil' is dried, cured paint with a satin sheen: a rough coat (0.38 floor), no wet micro-facet
 * glints or crest flash, highlights filtered by how fast the normal turns within a pixel
 * (Kaplanyan's geometric specular anti-aliasing) so ridges carry broad soft sheens, and slightly
 * deeper crevices.
 */
export interface LookParams {
  /** Floor on clearcoat roughness. */
  coatMin: number;
  /** Micro-facet jitter on curved paint (1 = reference pin-pricks). */
  micro: number;
  /** Extra specular on convex crests above a recess. */
  crestBoost: number;
  /** Strength of the second, softer highlight window. */
  window2: number;
  /** Overall clearcoat strength. */
  specGain: number;
  /** Weight of geometric specular anti-aliasing (0 = off). */
  specAA: number;
  /** How much cavities cut the key and the fill light, and deepen colour. */
  cavityKey: number; cavityFill: number; richness: number;
}
export type LookName = 'locked' | 'oil';
export const LOOKS: Record<LookName, LookParams> = {
  locked: { coatMin: 0, micro: 1, crestBoost: 2.5, window2: 0.55, specGain: 1, specAA: 0, cavityKey: 0.6, cavityFill: 0.72, richness: 0.35 },
  // Dried paint: a satin coat (no wet micro-glints, no crest flash), a weak second window,
  // and crevices that read a little deeper, as on cured knife work.
  oil: { coatMin: 0.38, micro: 0, crestBoost: 0, window2: 0.1, specGain: 0.45, specAA: 1, cavityKey: 0.5, cavityFill: 0.6, richness: 0.3 },
};
export const DEFAULT_LIGHT: LightSettings = { azimuth: 225, elevation: 30, occlusion: 0.8, relief: 1, exposure: 1, glow: 1 };

/**
 * Clearcoat roughness at a pixel. Faces keep what the simulation stored (0.06-0.16); where the
 * slope changes quickly, as on crests and lips, it falls to wet micro-facets at 0.03-0.08.
 */
export function clearcoatRoughness(stored: number, slopeChange: number, x: number, y: number): number {
  // Dry drag and bare canvas stay matte however bumpy they are. Only wet paint flashes.
  const curved = smooth((slopeChange - 0.15) / 0.5) * (1 - smooth((stored - 0.2) / 0.1));
  if (curved <= 0) return stored;
  const micro = 0.03 + 0.05 * hash(x, y, 17);
  return stored + (micro - stored) * curved;
}

export type View = 'paint' | 'color' | 'height' | 'normal' | 'spec' | 'cavity' | 'glow';

export function surfaceField(c: PaintCanvas, relief = 1): Float64Array {
  const S = new Float64Array(c.n);
  for (let i = 0; i < c.n; i++) S[i] = (c.tooth[i] + c.top[i] + c.under[i]) * relief;
  return S;
}

/** Height used for shadow and occlusion queries. Filtering it feathers the kernel, so a one-cell wall can't print a hard line. */
export function occlusionField(c: PaintCanvas, relief = 1): Float64Array {
  return occlusionFilter(surfaceField(c, relief), c.w, c.h, c.dx);
}

/**
 * The filter behind occlusionField, on any visible height field: two box passes of radius 0.22 mm.
 * Plain sums and divisions, so it gives the same bits on every engine (`.impasto` version 2
 * rebuilds the occlusion channel with it on decode).
 */
export function occlusionFilter(S: ArrayLike<number>, w: number, h: number, dx: number): Float64Array {
  const n = w * h, r = Math.max(1, Math.round(0.22 / dx)), div = 2 * r + 1;
  let src: ArrayLike<number> = S;
  // Two buffers for both passes: the second pass's row sweep reads the first's result into tmp
  // before its column sweep overwrites that result (every element is written before it is read).
  const tmp = new Float64Array(n), out = new Float64Array(n), sums = new Float64Array(w);
  for (let pass = 0; pass < 2; pass++) {
    for (let y = 0; y < h; y++) {
      const row = y * w;
      let sum = 0;
      for (let x = -r; x <= r; x++) sum += src[row + (x < 0 ? 0 : x >= w ? w - 1 : x)];
      // Only the first and last r + 1 cells of a row need the window clamped.
      const inner = w - r - 1;
      let x = 0;
      for (; x < r && x < w; x++) {
        tmp[row + x] = sum / div;
        const add = x + r + 1, sub = x - r;
        sum += src[row + (add >= w ? w - 1 : add)] - src[row + (sub < 0 ? 0 : sub)];
      }
      for (; x < inner; x++) {
        tmp[row + x] = sum / div;
        sum += src[row + x + r + 1] - src[row + x - r];
      }
      for (; x < w; x++) {
        tmp[row + x] = sum / div;
        const add = x + r + 1, sub = x - r;
        sum += src[row + (add >= w ? w - 1 : add)] - src[row + (sub < 0 ? 0 : sub)];
      }
    }
    // The column sweep runs row by row with one running sum per column (the same additions in
    // the same order per column, so the same bits), reading memory sequentially.
    sums.fill(0);
    for (let y = -r; y <= r; y++) {
      const row = (y < 0 ? 0 : y >= h ? h - 1 : y) * w;
      for (let x = 0; x < w; x++) sums[x] += tmp[row + x];
    }
    for (let y = 0; y < h; y++) {
      const row = y * w, add = y + r + 1, sub = y - r;
      const rowAdd = (add >= h ? h - 1 : add) * w, rowSub = (sub < 0 ? 0 : sub) * w;
      for (let x = 0; x < w; x++) {
        out[row + x] = sums[x] / div;
        sums[x] += tmp[rowAdd + x] - tmp[rowSub + x];
      }
    }
    src = out;
  }
  return src as Float64Array;
}

export function albedoField(c: PaintCanvas): Float32Array {
  const out = new Float32Array(c.n * 3);
  const gr = [reflectanceFromKs(c.groundKs[0]), reflectanceFromKs(c.groundKs[1]), reflectanceFromKs(c.groundKs[2])];
  for (let i = 0; i < c.n; i++) {
    const t = c.top[i], total = t + c.under[i];
    // Thin paint is translucent over the ground.
    const alpha = total / (total + 0.018);
    for (let k = 0; k < 3; k++) {
      const paint = t > 1e-9 ? reflectanceFromKs(c.topP[i * 3 + k] / t) : gr[k];
      out[i * 3 + k] = gr[k] + (paint - gr[k]) * alpha;
    }
  }
  return out;
}

/** The fields relight() derives from a canvas (at `relief`): visible height, shadow height and albedo. */
export interface CanvasFields { S: Float64Array; O: Float64Array; A: Float32Array }
export function canvasFields(c: PaintCanvas, relief = 1): CanvasFields {
  return { S: surfaceField(c, relief), O: occlusionField(c, relief), A: albedoField(c) };
}

/**
 * Lights a canvas. `fields` (from canvasFields at light.relief) lets a caller that also packs the
 * surface derive the height and albedo fields once; `out` / `stride` write straight into an RGBA
 * buffer (stride 4, alpha set to 255) instead of the RGB one returned by default.
 */
export function relight(c: PaintCanvas, light: LightSettings = DEFAULT_LIGHT, view: View = 'paint', fields?: CanvasFields, out?: Uint8ClampedArray, stride: 3 | 4 = 3): Uint8ClampedArray {
  const f = fields ?? canvasFields(c, light.relief);
  return relightFields(c.w, c.h, c.dx, f.S, f.O, f.A, c.rough, light, view, out, stride);
}

/**
 * The same renderer on a packed surface (`ImpastoSurface`, e.g. a decoded `.impasto` file)
 * instead of a live canvas. Heights are float32 there, so it can differ from relight() on the
 * canvas by rounding, far below an 8-bit level.
 */
export function relightSurface(s: ImpastoSurface, light: LightSettings = DEFAULT_LIGHT, view: View = 'paint'): Uint8ClampedArray {
  const n = s.w * s.h, S = new Float64Array(n), O = new Float64Array(n), A = new Float32Array(n * 3), rough = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    S[i] = s.height[i * 2] * light.relief; O[i] = s.height[i * 2 + 1] * light.relief;
    A[i * 3] = s.color[i * 4]; A[i * 3 + 1] = s.color[i * 4 + 1]; A[i * 3 + 2] = s.color[i * 4 + 2]; rough[i] = s.color[i * 4 + 3];
  }
  return relightFields(s.w, s.h, s.dx, S, O, A, rough, light, view);
}

/** Cells per block of the shadow march's block-maximum table. */
const SHADOW_BLOCK = 8;

/**
 * The renderer proper. Every expression is evaluated in the same order as the reference it grew
 * from, so a change here that only skips work (a shadow sample that cannot block, a clamp that
 * cannot bind, a micro-facet jitter of zero) leaves the bytes identical; `tests/api.test.ts` pins
 * the images.
 */
function relightFields(w: number, h: number, dx: number, S: Float64Array, O: Float64Array, A: Float32Array, rough: Float32Array, light: LightSettings, view: View, out?: Uint8ClampedArray, stride: 3 | 4 = 3): Uint8ClampedArray {
  const n = w * h;
  out ??= new Uint8ClampedArray(n * 3);
  if (stride === 4) for (let i = 0; i < n; i++) out[i * 4 + 3] = 255;
  const az = radians(light.azimuth), el = radians(light.elevation);
  const cel = dcos(el), sel = dsin(el), lx = dcos(az) * cel, ly = dsin(az) * cel, lz = sel;
  const tanEl = sel / cel, hdx = dcos(az), hdy = dsin(az);
  // Half vector for a viewer straight above.
  const hl = Math.sqrt(lx * lx + ly * ly + (lz + 1) * (lz + 1));
  const hx = lx / hl, hy = ly / hl, hz = (lz + 1) / hl;
  const voh = hz;
  const fc = 1 - voh, fc5 = fc * fc * fc * fc * fc;
  const fresnel = 0.045 + (1 - 0.045) * fc5;
  const at = (x: number, y: number) => S[(y < 0 ? 0 : y >= h ? h - 1 : y) * w + (x < 0 ? 0 : x >= w ? w - 1 : x)];
  // A second, softer window for the glints only, so ridges at other angles catch light too.
  const az2 = radians(light.azimuth + 70), el2 = radians(light.elevation + 14 > 75 ? 75 : light.elevation + 14);
  const cel2 = dcos(el2), lx2 = dcos(az2) * cel2, ly2 = dsin(az2) * cel2, lz2 = dsin(el2);
  const hl2 = Math.sqrt(lx2 * lx2 + ly2 * ly2 + (lz2 + 1) * (lz2 + 1));
  const hx2 = lx2 / hl2, hy2 = ly2 / hl2, hz2 = (lz2 + 1) / hl2;
  const fc2 = 1 - hz2, fresnel2 = 0.045 + (1 - 0.045) * fc2 * fc2 * fc2 * fc2 * fc2;
  const atO = (x: number, y: number) => O[(y < 0 ? 0 : y >= h ? h - 1 : y) * w + (x < 0 ? 0 : x >= w ? w - 1 : x)];
  let maxH = 0;
  for (let i = 0; i < n; i++) if (O[i] > maxH) maxH = O[i];

  const dirs: [number, number][] = [];
  for (let a = 0; a < 8; a++) dirs.push([dcos(a * 0.7853981633974483), dsin(a * 0.7853981633974483)]);
  const radii = [0.45, 1.1, 2.4].map((r) => Math.max(1, Math.round(r / dx)));
  const radiiMm = radii.map((r) => r * dx);
  const tightRadii = [0.2, 0.45, 1.0].map((r) => Math.max(1, Math.round(r / dx))), tightMm = tightRadii.map((r) => r * dx), tallRadius = Math.max(1, Math.round(1.2 / dx));
  // Integer offsets of the fixed-radius lookups, rounded once. Pixels at least `margin` cells from
  // every edge read them unclamped (identical values, no clamping); the rest clamp as before.
  const occX = new Int32Array(24), occY = new Int32Array(24), occI = new Int32Array(24);
  const tightX = new Int32Array(12), tightY = new Int32Array(12), tightI = new Int32Array(12);
  const tallX = new Int32Array(8), tallY = new Int32Array(8), tallI = new Int32Array(8);
  let margin = 2; // the crest Laplacian's reach, and the slope filter's one cell
  for (let a = 0; a < 8; a++) {
    for (let q = 0; q < 3; q++) {
      const ox = Math.round(dirs[a][0] * radii[q]), oy = Math.round(dirs[a][1] * radii[q]), k = a * 3 + q;
      occX[k] = ox; occY[k] = oy; occI[k] = oy * w + ox;
      if (Math.abs(ox) > margin) margin = Math.abs(ox);
      if (Math.abs(oy) > margin) margin = Math.abs(oy);
      if (a < 4) {
        const px_ = Math.round(dirs[a][0] * tightRadii[q]), py_ = Math.round(dirs[a][1] * tightRadii[q]);
        tightX[k] = px_; tightY[k] = py_; tightI[k] = py_ * w + px_;
        if (Math.abs(px_) > margin) margin = Math.abs(px_);
        if (Math.abs(py_) > margin) margin = Math.abs(py_);
      }
    }
    const sx = Math.round(dirs[a][0] * tallRadius), sy = Math.round(dirs[a][1] * tallRadius);
    tallX[a] = sx; tallY[a] = sy; tallI[a] = sy * w + sx;
    if (Math.abs(sx) > margin) margin = Math.abs(sx);
    if (Math.abs(sy) > margin) margin = Math.abs(sy);
  }

  // Block maxima of the shadow height, each block dilated by two cells, so a block bounds the
  // bilinear sample of any point whose floor lies in it or one cell outside it. A shadow sample
  // whose block cannot reach the ray is skipped: the bilinear value is a convex combination of
  // four cells, so it stays below the block's maximum (plus rounding, far under the 1e-9 margin),
  // and the march's result is unchanged. The ray's threshold only rises with distance, so once a
  // block passes, every later sample still within a cell of it passes too, and the march jumps
  // over them by distance alone.
  const MB = SHADOW_BLOCK, mw = Math.ceil(w / MB), mh = Math.ceil(h / MB);
  const rowMax = new Float64Array(mw * h);
  for (let y = 0; y < h; y++) for (let bx = 0; bx < mw; bx++) {
    const x0 = bx * MB - 2 < 0 ? 0 : bx * MB - 2, x1 = bx * MB + MB + 1 > w - 1 ? w - 1 : bx * MB + MB + 1;
    let m = -Infinity;
    for (let x = x0; x <= x1; x++) if (O[y * w + x] > m) m = O[y * w + x];
    rowMax[y * mw + bx] = m;
  }
  const mip = new Float64Array(mw * mh);
  for (let by = 0; by < mh; by++) {
    const y0 = by * MB - 2 < 0 ? 0 : by * MB - 2, y1 = by * MB + MB + 1 > h - 1 ? h - 1 : by * MB + MB + 1;
    for (let bx = 0; bx < mw; bx++) {
      let m = -Infinity;
      for (let y = y0; y <= y1; y++) if (rowMax[y * mw + bx] > m) m = rowMax[y * mw + bx];
      mip[by * mw + bx] = m;
    }
  }
  // The march's sample spacing: d = dx + reach * T[q] * F[q], as the reference wrote it.
  const T = new Float64Array(73), F = new Float64Array(73);
  for (let q = 1; q <= 72; q++) { T[q] = q / 72; F[q] = 0.35 + 0.65 * T[q]; }
  // Half a cell of slack on the block windows absorbs the rounding of the distance limits.
  const blockLo = (b: number) => (b === 0 ? -Infinity : b * MB - 0.5), blockHi = (b: number, count: number) => (b === count - 1 ? Infinity : b * MB + MB + 0.5);

  // Slopes stored up front: the highlight filter needs neighbouring normals.
  const GX = new Float32Array(n), GY = new Float32Array(n), d8 = 8 * dx;
  for (let y = 0; y < h; y++) {
    const rm = (y > 0 ? y - 1 : 0) * w, r0 = y * w, rp = (y + 1 < h ? y + 1 : h - 1) * w;
    for (let x = 0; x < w; x++) {
      const i = r0 + x, xm = x > 0 ? x - 1 : 0, xp = x + 1 < w ? x + 1 : w - 1;
      GX[i] = ((S[rm + xp] + 2 * S[r0 + xp] + S[rp + xp]) - (S[rm + xm] + 2 * S[r0 + xm] + S[rp + xm])) / d8;
      GY[i] = ((S[rp + xm] + 2 * S[rp + x] + S[rp + xp]) - (S[rm + xm] + 2 * S[rm + x] + S[rm + xp])) / d8;
    }
  }
  const encode = (i: number, r: number, g: number, b: number) => {
    out![i * stride] = linearToSrgb(r) * 255 + 0.5; out![i * stride + 1] = linearToSrgb(g) * 255 + 0.5; out![i * stride + 2] = linearToSrgb(b) * 255 + 0.5;
  };
  const expo = light.exposure;
  const look = LOOKS[light.look ?? 'locked'];
  const irradiance = 0.72 / (sel > 0.25 ? sel : 0.25) * 3.141592653589793;
  // GGX lobe and the four jittered micro-facets, hoisted out of the pixel loop.
  const lobe = (rough: number, noH: number, nDotL: number, f: number, pixelVariance: number) => {
    const alpha = rough * rough, a2 = alpha * alpha + pixelVariance;
    const den = noH * noH * (a2 - 1) + 1;
    const D = a2 / (3.141592653589793 * den * den);
    const k = alpha * 0.5;
    const gv = nz_ / (nz_ * (1 - k) + k), gl = nDotL / (nDotL * (1 - k) + k);
    return D * gv * gl * f / Math.max(0.001, 4 * nz_ * nDotL) * nDotL;
  };
  const facets = (qx: number, qy: number, qz: number, nDotL: number, f: number, x: number, y: number, gx: number, gy: number, jitter: number, coat: number, pixelVariance: number) => {
    let sum = 0;
    if (jitter === 0) {
      // No jitter (dried looks): the four facets are the same facet, summed as the loop would.
      const jl = Math.sqrt(gx * gx + gy * gy + 1);
      const one = lobe(coat, Math.max(0, (-gx * qx - gy * qy + qz) / jl), nDotL, f, pixelVariance);
      sum += one; sum += one; sum += one; sum += one;
      return sum * 0.25;
    }
    for (let m = 0; m < 4; m++) {
      const jx = gx + (hash(x, y, 23 + m * 2) - 0.5) * jitter, jy = gy + (hash(x, y, 24 + m * 2) - 0.5) * jitter;
      const jl = Math.sqrt(jx * jx + jy * jy + 1);
      sum += lobe(coat, Math.max(0, (-jx * qx - jy * qy + qz) / jl), nDotL, f, pixelVariance);
    }
    return sum * 0.25;
  };
  let nz_ = 1; // the current pixel's normal z, read by lobe
  // Without display glow the composite is per pixel: no HDR buffers, one pass.
  const direct = view === 'paint' && light.glow === 0;
  const base = direct ? null : new Float32Array(n * 3), hdrSpec = direct ? null : new Float32Array(n);
  const wrap = 0.3;
  // Key light is calibrated so a flat surface at this elevation reaches about 0.72, leaving room for slopes that face the lamp.
  const se = sel > 0.25 ? sel : 0.25;
  const keyGain = 0.72 * (1 + wrap) / (se + wrap);
  const xEnd = w - margin, yEnd = h - margin;

  for (let y = 0; y < h; y++) {
    const yIn = y >= margin && y < yEnd;
    for (let x = 0; x < w; x++) {
      const i = y * w + x, s = S[i];
      const ar = A[i * 3], ag = A[i * 3 + 1], ab = A[i * 3 + 2];
      if (view === 'color') { encode(i, ar, ag, ab); continue; }
      if (view === 'height') { const v = s / (s + 2.2); out[i * stride] = out[i * stride + 1] = out[i * stride + 2] = v * 255 + 0.5; continue; }
      const gx = GX[i], gy = GY[i];
      const nl = Math.sqrt(gx * gx + gy * gy + 1);
      const nx = -gx / nl, ny = -gy / nl, nz = 1 / nl;
      if (view === 'normal') { out[i * stride] = (nx * 0.5 + 0.5) * 255; out[i * stride + 1] = (ny * 0.5 + 0.5) * 255; out[i * stride + 2] = (nz * 0.5 + 0.5) * 255; continue; }
      const inner = yIn && x >= margin && x < xEnd;

      // Ray-marched cast shadow toward the light.
      let block = 0;
      const so = O[i];
      const reach = Math.min((maxH - so) / tanEl, 40);
      if (reach > dx) {
        for (let q = 1; q <= 72; q++) {
          const d = dx + reach * T[q] * F[q];
          const fx = x + hdx * d / dx, fy = y + hdy * d / dx;
          const bx = Math.floor(fx), by = Math.floor(fy);
          const cx = bx < 0 ? 0 : bx >= w ? w - 1 : bx, cy = by < 0 ? 0 : by >= h ? h - 1 : by;
          const thr = so + d * tanEl + 0.03;
          const bbx = cx >> 3, bby = cy >> 3;
          if (mip[bby * mw + bbx] - thr < -1e-9) {
            // Clear here, so clear for every later sample that stays within a cell of this block.
            const dLimX = hdx > 0 ? (blockHi(bbx, mw) - x) * dx / hdx : hdx < 0 ? (blockLo(bbx) - x) * dx / hdx : Infinity;
            const dLimY = hdy > 0 ? (blockHi(bby, mh) - y) * dx / hdy : hdy < 0 ? (blockLo(bby) - y) * dx / hdy : Infinity;
            const dLim = dLimX < dLimY ? dLimX : dLimY;
            while (q < 72 && dx + reach * T[q + 1] * F[q + 1] < dLim) q++;
            continue;
          }
          const ax = fx - bx, ay = fy - by;
          const cx1 = bx + 1 < 0 ? 0 : bx + 1 >= w ? w - 1 : bx + 1, cy1 = by + 1 < 0 ? 0 : by + 1 >= h ? h - 1 : by + 1;
          const r0 = cy * w, r1 = cy1 * w;
          const a0 = O[r0 + cx], a1 = O[r0 + cx1], a2 = O[r1 + cx], a3 = O[r1 + cx1];
          const sh = a0 + (a1 - a0) * ax + (a2 - a0) * ay + (a0 - a1 - a2 + a3) * ax * ay;
          const over = sh - thr;
          if (over > 0) {
            // A wider penumbra, and the first millimetre of a contact stays partly lit.
            const pen = 0.09 + d * 0.07;
            const b = (over >= pen ? 1 : over / pen) * (0.62 + 0.38 * smooth(d / 1.4));
            if (b > block) block = b;
            if (block >= 1) break;
          }
        }
      }
      const visibility = 1 - light.occlusion * block;

      // Horizon occlusion: how much of the sky each point can see.
      let sky = 0;
      if (inner) {
        for (let a = 0; a < 8; a++) {
          let tan = 0;
          for (let q = 0; q < 3; q++) {
            const rise = (O[i + occI[a * 3 + q]] - so) / radiiMm[q];
            if (rise > tan) tan = rise;
          }
          sky += 1 / (1 + tan * tan);
        }
      } else {
        for (let a = 0; a < 8; a++) {
          let tan = 0;
          for (let q = 0; q < 3; q++) {
            const rise = (atO(x + occX[a * 3 + q], y + occY[a * 3 + q]) - so) / radiiMm[q];
            if (rise > tan) tan = rise;
          }
          sky += 1 / (1 + tan * tan);
        }
      }
      sky /= 8;
      const ambient = 1 - light.occlusion * (1 - sky);

      // Cavity term. A contour has a wall on one side; a crevice has walls on opposite sides, so
      // opposing rises measure enclosure. It uses the unfiltered height, because tight crevices are
      // narrower than the shadow filter. A tall lip counts too, however one-sided it is.
      let opposed = 0, tallest = 0, deepest = 0;
      if (inner) {
        for (let a = 0; a < 4; a++) {
          let one = 0, two = 0;
          for (let q = 0; q < 3; q++) {
            const k = a * 3 + q;
            const ra = (S[i + tightI[k]] - s) / tightMm[q], rb = (S[i - tightI[k]] - s) / tightMm[q];
            if (ra > one) one = ra;
            if (rb > two) two = rb;
          }
          opposed += smooth(((one < two ? one : two) - 0.14) / 0.55);
        }
        for (let a = 0; a < 8; a++) {
          const rise = O[i + tallI[a]] - so;
          if (rise > tallest) tallest = rise;
          if (-rise > deepest) deepest = -rise;
        }
      } else {
        for (let a = 0; a < 4; a++) {
          let one = 0, two = 0;
          for (let q = 0; q < 3; q++) {
            const k = a * 3 + q, px_ = tightX[k], py_ = tightY[k];
            const ra = (at(x + px_, y + py_) - s) / tightMm[q], rb = (at(x - px_, y - py_) - s) / tightMm[q];
            if (ra > one) one = ra;
            if (rb > two) two = rb;
          }
          opposed += smooth(((one < two ? one : two) - 0.14) / 0.55);
        }
        for (let a = 0; a < 8; a++) {
          const rise = atO(x + tallX[a], y + tallY[a]) - so;
          if (rise > tallest) tallest = rise;
          if (-rise > deepest) deepest = -rise;
        }
      }
      const enclosed = opposed / 4;
      const lip = smooth((tallest - 0.75) / 1.5) * 0.6;
      const cavity = enclosed > lip ? enclosed : lip;
      if (view === 'cavity') { const v = cavity * 255 + 0.5; out[i * stride] = out[i * stride + 1] = out[i * stride + 2] = v; continue; }

      const noL = nx * lx + ny * ly + nz * lz;
      // The lamp has some size, so light wraps past the terminator and back-facing lips don't go dead.
      const diffuse = clamp((noL + wrap) / (1 + wrap), 0, 1);
      // Broad fill stays soft on open paint and falls away inside cavities.
      const open = 1 - cavity;
      const fill = 0.14 * ambient * (0.65 + 0.35 * nz) * (1 - look.cavityFill * cavity);
      // Soft bounce from the side opposite the lamp. Lips that face away pick up colour here and
      // read as turning form, where they used to read as drawn lines. It casts no shadow.
      const bounceN = -lx * nx * 0.82 / cel - ly * ny * 0.82 / cel + 0.57 * nz;
      const bounce = (bounceN > 0 ? bounceN : 0) * 0.17 * open * open;
      const key = diffuse * keyGain * visibility * (0.7 + 0.3 * ambient) * (1 - look.cavityKey * cavity);
      // Light bouncing between paint walls keeps crevices coloured, not black.
      // A small floor inside cavities leaves them a rich, dark colour, never pure black.
      const lit = fill + key + bounce + 0.14 * (1 - ambient) * open + 0.05 * cavity;

      // GGX clearcoat. Roughness is written per cell by the simulation.
      let spec = 0;
      const noL2 = nx * lx2 + ny * ly2 + nz * lz2;
      if (noL > 0 || noL2 > 0) {
        const xp = x + 1 < w ? i + 1 : i, xm = x > 0 ? i - 1 : i, yp = y + 1 < h ? i + w : i, ym = y > 0 ? i - w : i;
        const dg1 = GX[xp] - GX[xm], dg2 = GX[yp] - GX[ym], dg3 = GY[xp] - GY[xm], dg4 = GY[yp] - GY[ym];
        const changeSq = dg1 * dg1 + dg2 * dg2 + dg3 * dg3 + dg4 * dg4, change = Math.sqrt(changeSq);
        const coat0 = clearcoatRoughness(rough[i], change, x, y), coat = coat0 > look.coatMin ? coat0 : look.coatMin;
        // A pixel covers a small range of normals. This keeps narrow lobes from vanishing between
        // pixels. The cap is low so the highlight stays a sharp point. Geometric specular AA adds the
        // normal's spread across the pixel to the lobe (sigma^2 = 1 / 2pi, kappa = 0.18).
        const nz4 = nz * nz * nz * nz;
        const aa = changeSq * 0.25 * nz4 * 0.3183098861837907 * 2, pixelVariance = Math.min(0.0009, changeSq * nz4 * 0.004) + look.specAA * (aa < 0.18 ? aa : 0.18);
        nz_ = nz;
        // Curved paint is not perfectly smooth. Four micro-facets per pixel, each tilted a little,
        // break a highlight along a crest into separate points. Flat faces take one smooth sample.
        const curved = smooth((change - 0.15) / 0.5), jitter = 0.5 * curved * look.micro;
        if (noL > 0) {
          const smoothNoH = Math.max(0, nx * hx + ny * hy + nz * hz);
          const sharp = curved > 0 ? facets(hx, hy, hz, noL, fresnel, x, y, gx, gy, jitter, coat, pixelVariance) : lobe(coat, smoothNoH, noL, fresnel, pixelVariance);
          spec += (sharp * irradiance + lobe(0.30, smoothNoH, noL, fresnel, pixelVariance) * irradiance * 0.05) * visibility;
        }
        if (curved > 0 && noL2 > 0) spec += facets(hx2, hy2, hz2, noL2, fresnel2, x, y, gx, gy, jitter, coat, pixelVariance) * irradiance * look.window2 * (0.6 + 0.4 * visibility);
        // Crest boost: convex paint standing above a recess flashes hardest. Spec stays unclipped here.
        if (curved > 0 && spec > 0) {
          const r2 = 2;
          const lap = (inner ? S[i + r2] + S[i - r2] + S[i + r2 * w] + S[i - r2 * w] - 4 * s : at(x + r2, y) + at(x - r2, y) + at(x, y + r2) + at(x, y - r2) - 4 * s) / (4 * dx * dx);
          const crest = curved * smooth(-lap / 3) * smooth((deepest - 0.3) / 1.1);
          spec *= 1 + look.crestBoost * crest;
        }
        spec *= look.specGain;
      }
      // Weak sky reflection at grazing normals keeps deep shadows from going dead black.
      // Light that reaches a crevice has bounced off pigment on the way, so its colour deepens.
      const richness = look.richness * cavity;
      const fv = 1 - nz, env = (0.02 + 0.2 * fv * fv) * ambient * 0.22;
      if (view === 'spec') { encode(i, spec, spec, spec); continue; }
      const br = ar * (1 - richness + ar * richness) * lit + env;
      const bg = ag * (1 - richness + ag * richness) * lit + env * 0.985;
      const bb = ab * (1 - richness + ab * richness) * lit + env * 0.95;
      if (direct) {
        // As the buffered path below with zero glow: the float32 stores are kept as fround.
        const sp = Math.fround(spec);
        encode(i,
          clamp((Math.fround(br) + sp) * expo, 0, 1),
          clamp((Math.fround(bg) + sp * 0.985) * expo, 0, 1),
          clamp((Math.fround(bb) + sp * 0.95) * expo, 0, 1));
        continue;
      }
      base![i * 3] = br; base![i * 3 + 1] = bg; base![i * 3 + 2] = bb;
      hdrSpec![i] = spec;
    }
  }
  if (!direct && (view === 'paint' || view === 'glow')) {
    // Micro-bloom. Only light above display white spreads, over well under a millimetre, so open
    // paint keeps its value. The kernel uses plain arithmetic, so it is identical on every engine.
    const glow = new Float32Array(n);
    const R = Math.ceil(0.7 / dx - 1e-6), R2 = R * R;
    const s1 = 0.1 / dx, s2 = 0.3 / dx, a1 = s1 * s1, a2 = s2 * s2;
    const kernel = new Float32Array((2 * R + 1) * (2 * R + 1));
    for (let b = -R; b <= R; b++) for (let a = -R; a <= R; a++) {
      const d2 = a * a + b * b;
      if (d2 >= R2) continue;
      const t1 = 1 + d2 / a1, t2 = 1 + d2 / a2, win = 1 - d2 / R2;
      kernel[(b + R) * (2 * R + 1) + a + R] = (0.12 / (t1 * t1) + 0.018 / (t2 * t2)) * win * win;
    }
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const v = hdrSpec![y * w + x];
      if (v <= 1) continue;
      const e = v - 1 > 8 ? 8 : v - 1;
      for (let b = -R; b <= R; b++) {
        const Y = y + b;
        if (Y < 0 || Y >= h) continue;
        for (let a = -R; a <= R; a++) {
          const X = x + a;
          if (X < 0 || X >= w) continue;
          glow[Y * w + X] += e * kernel[(b + R) * (2 * R + 1) + a + R];
        }
      }
    }
    const strength = light.glow;
    for (let i = 0; i < n; i++) {
      const g = glow[i] * strength * expo, sp = hdrSpec![i];
      if (view === 'glow') { encode(i, g, g * 0.97, g * 0.92); continue; }
      encode(i,
        clamp((base![i * 3] + sp) * expo + g, 0, 1),
        clamp((base![i * 3 + 1] + sp * 0.985) * expo + g * 0.97, 0, 1),
        clamp((base![i * 3 + 2] + sp * 0.95) * expo + g * 0.92, 0, 1));
    }
  }
  return out;
}
