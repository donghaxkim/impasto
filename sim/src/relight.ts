import { clamp, dcos, dsin, hash, radians, smooth } from './dmath.ts';
import type { PaintCanvas } from './canvas.ts';
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
}
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
  const { w, h, dx } = c, r = Math.max(1, Math.round(0.22 / dx));
  let src = surfaceField(c, relief);
  for (let pass = 0; pass < 2; pass++) {
    const tmp = new Float64Array(c.n), out = new Float64Array(c.n);
    for (let y = 0; y < h; y++) {
      let sum = 0;
      for (let x = -r; x <= r; x++) sum += src[y * w + (x < 0 ? 0 : x >= w ? w - 1 : x)];
      for (let x = 0; x < w; x++) {
        tmp[y * w + x] = sum / (2 * r + 1);
        const add = x + r + 1, sub = x - r;
        sum += src[y * w + (add >= w ? w - 1 : add)] - src[y * w + (sub < 0 ? 0 : sub)];
      }
    }
    for (let x = 0; x < w; x++) {
      let sum = 0;
      for (let y = -r; y <= r; y++) sum += tmp[(y < 0 ? 0 : y >= h ? h - 1 : y) * w + x];
      for (let y = 0; y < h; y++) {
        out[y * w + x] = sum / (2 * r + 1);
        const add = y + r + 1, sub = y - r;
        sum += tmp[(add >= h ? h - 1 : add) * w + x] - tmp[(sub < 0 ? 0 : sub) * w + x];
      }
    }
    src = out;
  }
  return src;
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

export function relight(c: PaintCanvas, light: LightSettings = DEFAULT_LIGHT, view: View = 'paint'): Uint8ClampedArray {
  const { w, h, dx, n } = c;
  const S = surfaceField(c, light.relief);
  const O = occlusionField(c, light.relief);
  const A = albedoField(c);
  const out = new Uint8ClampedArray(n * 3);
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
  const base = new Float32Array(n * 3), hdrSpec = new Float32Array(n);
  const atO = (x: number, y: number) => O[(y < 0 ? 0 : y >= h ? h - 1 : y) * w + (x < 0 ? 0 : x >= w ? w - 1 : x)];
  let maxH = 0;
  for (let i = 0; i < n; i++) if (O[i] > maxH) maxH = O[i];

  const dirs: [number, number][] = [];
  for (let a = 0; a < 8; a++) dirs.push([dcos(a * 0.7853981633974483), dsin(a * 0.7853981633974483)]);
  const radii = [0.45, 1.1, 2.4].map((r) => Math.max(1, Math.round(r / dx)));
  const radiiMm = radii.map((r) => r * dx);
  const tightRadii = [0.2, 0.45, 1.0].map((r) => Math.max(1, Math.round(r / dx))), tightMm = tightRadii.map((r) => r * dx), tallRadius = Math.max(1, Math.round(1.2 / dx));

  // Slopes stored up front: the highlight filter needs neighbouring normals.
  const GX = new Float32Array(n), GY = new Float32Array(n);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x;
    GX[i] = ((at(x + 1, y - 1) + 2 * at(x + 1, y) + at(x + 1, y + 1)) - (at(x - 1, y - 1) + 2 * at(x - 1, y) + at(x - 1, y + 1))) / (8 * dx);
    GY[i] = ((at(x - 1, y + 1) + 2 * at(x, y + 1) + at(x + 1, y + 1)) - (at(x - 1, y - 1) + 2 * at(x, y - 1) + at(x + 1, y - 1))) / (8 * dx);
  }
  const encode = (i: number, r: number, g: number, b: number) => {
    out[i * 3] = linearToSrgb(r) * 255 + 0.5; out[i * 3 + 1] = linearToSrgb(g) * 255 + 0.5; out[i * 3 + 2] = linearToSrgb(b) * 255 + 0.5;
  };
  const expo = light.exposure;

  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x, s = S[i];
    const ar = A[i * 3], ag = A[i * 3 + 1], ab = A[i * 3 + 2];
    if (view === 'color') { encode(i, ar, ag, ab); continue; }
    if (view === 'height') { const v = s / (s + 2.2); out[i * 3] = out[i * 3 + 1] = out[i * 3 + 2] = v * 255 + 0.5; continue; }
    const gx = GX[i], gy = GY[i];
    const nl = Math.sqrt(gx * gx + gy * gy + 1);
    const nx = -gx / nl, ny = -gy / nl, nz = 1 / nl;
    if (view === 'normal') { out[i * 3] = (nx * 0.5 + 0.5) * 255; out[i * 3 + 1] = (ny * 0.5 + 0.5) * 255; out[i * 3 + 2] = (nz * 0.5 + 0.5) * 255; continue; }

    // Ray-marched cast shadow toward the light.
    let block = 0;
    const so = O[i];
    const reach = Math.min((maxH - so) / tanEl, 40);
    if (reach > dx) {
      for (let q = 1; q <= 72; q++) {
        const t = q / 72, d = dx + reach * t * (0.35 + 0.65 * t);
        const fx = x + hdx * d / dx, fy = y + hdy * d / dx;
        const bx = Math.floor(fx), by = Math.floor(fy), ax = fx - bx, ay = fy - by;
        const a0 = atO(bx, by), a1 = atO(bx + 1, by), a2 = atO(bx, by + 1), a3 = atO(bx + 1, by + 1);
        const sh = a0 + (a1 - a0) * ax + (a2 - a0) * ay + (a0 - a1 - a2 + a3) * ax * ay;
        const over = sh - (so + d * tanEl + 0.03);
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
    for (let a = 0; a < 8; a++) {
      let tan = 0;
      for (let q = 0; q < 3; q++) {
        const sx = x + Math.round(dirs[a][0] * radii[q]), sy = y + Math.round(dirs[a][1] * radii[q]);
        const rise = (atO(sx, sy) - so) / radiiMm[q];
        if (rise > tan) tan = rise;
      }
      sky += 1 / (1 + tan * tan);
    }
    sky /= 8;
    const ambient = 1 - light.occlusion * (1 - sky);

    // Cavity term. A contour has a wall on one side; a crevice has walls on opposite sides, so
    // opposing rises measure enclosure. It uses the unfiltered height, because tight crevices are
    // narrower than the shadow filter. A tall lip counts too, however one-sided it is.
    let opposed = 0, tallest = 0, deepest = 0;
    for (let a = 0; a < 4; a++) {
      let one = 0, two = 0;
      for (let q = 0; q < 3; q++) {
        const px_ = Math.round(dirs[a][0] * tightRadii[q]), py_ = Math.round(dirs[a][1] * tightRadii[q]);
        const ra = (at(x + px_, y + py_) - s) / tightMm[q], rb = (at(x - px_, y - py_) - s) / tightMm[q];
        if (ra > one) one = ra;
        if (rb > two) two = rb;
      }
      opposed += smooth(((one < two ? one : two) - 0.14) / 0.55);
    }
    for (let a = 0; a < 8; a++) {
      const sx = x + Math.round(dirs[a][0] * tallRadius), sy = y + Math.round(dirs[a][1] * tallRadius);
      const rise = atO(sx, sy) - so;
      if (rise > tallest) tallest = rise;
      if (-rise > deepest) deepest = -rise;
    }
    const enclosed = opposed / 4;
    const lip = smooth((tallest - 0.75) / 1.5) * 0.6;
    const cavity = enclosed > lip ? enclosed : lip;
    if (view === 'cavity') { const v = cavity * 255 + 0.5; out[i * 3] = out[i * 3 + 1] = out[i * 3 + 2] = v; continue; }

    const noL = nx * lx + ny * ly + nz * lz;
    // The lamp has some size, so light wraps past the terminator and back-facing lips don't go dead.
    const wrap = 0.3;
    const diffuse = clamp((noL + wrap) / (1 + wrap), 0, 1);
    // Key light is calibrated so a flat surface at this elevation reaches about 0.72, leaving room for slopes that face the lamp.
    const se = sel > 0.25 ? sel : 0.25;
    const keyGain = 0.72 * (1 + wrap) / (se + wrap);
    // Broad fill stays soft on open paint and falls away inside cavities.
    const open = 1 - cavity;
    const fill = 0.14 * ambient * (0.65 + 0.35 * nz) * (1 - 0.72 * cavity);
    // Soft bounce from the side opposite the lamp. Lips that face away pick up colour here and
    // read as turning form, where they used to read as drawn lines. It casts no shadow.
    const bounceN = -lx * nx * 0.82 / cel - ly * ny * 0.82 / cel + 0.57 * nz;
    const bounce = (bounceN > 0 ? bounceN : 0) * 0.17 * open * open;
    const key = diffuse * keyGain * visibility * (0.7 + 0.3 * ambient) * (1 - 0.6 * cavity);
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
      const coat = clearcoatRoughness(c.rough[i], change, x, y);
      // A pixel covers a small range of normals. This keeps narrow lobes from vanishing between
      // pixels. The cap is low so the highlight stays a sharp point.
      const pixelVariance = Math.min(0.0009, changeSq * nz * nz * nz * nz * 0.004);
      const lobe = (rough: number, noH: number, nDotL: number, f: number) => {
        const alpha = rough * rough, a2 = alpha * alpha + pixelVariance;
        const den = noH * noH * (a2 - 1) + 1;
        const D = a2 / (3.141592653589793 * den * den);
        const k = alpha * 0.5;
        const gv = nz / (nz * (1 - k) + k), gl = nDotL / (nDotL * (1 - k) + k);
        return D * gv * gl * f / Math.max(0.001, 4 * nz * nDotL) * nDotL;
      };
      // Curved paint is not perfectly smooth. Four micro-facets per pixel, each tilted a little,
      // break a highlight along a crest into separate points. Flat faces take one smooth sample.
      const curved = smooth((change - 0.15) / 0.5);
      const irradiance = 0.72 / se * 3.141592653589793;
      const facets = (qx: number, qy: number, qz: number, nDotL: number, f: number) => {
        let sum = 0;
        for (let m = 0; m < 4; m++) {
          const jx = gx + (hash(x, y, 23 + m * 2) - 0.5) * 0.5 * curved, jy = gy + (hash(x, y, 24 + m * 2) - 0.5) * 0.5 * curved;
          const jl = Math.sqrt(jx * jx + jy * jy + 1);
          sum += lobe(coat, Math.max(0, (-jx * qx - jy * qy + qz) / jl), nDotL, f);
        }
        return sum * 0.25;
      };
      if (noL > 0) {
        const smoothNoH = Math.max(0, nx * hx + ny * hy + nz * hz);
        const sharp = curved > 0 ? facets(hx, hy, hz, noL, fresnel) : lobe(coat, smoothNoH, noL, fresnel);
        spec += (sharp * irradiance + lobe(0.30, smoothNoH, noL, fresnel) * irradiance * 0.05) * visibility;
      }
      if (curved > 0 && noL2 > 0) spec += facets(hx2, hy2, hz2, noL2, fresnel2) * irradiance * 0.55 * (0.6 + 0.4 * visibility);
      // Crest boost: convex paint standing above a recess flashes hardest. Spec stays unclipped here.
      if (curved > 0 && spec > 0) {
        const r2 = 2;
        const lap = (at(x + r2, y) + at(x - r2, y) + at(x, y + r2) + at(x, y - r2) - 4 * s) / (4 * dx * dx);
        const crest = curved * smooth(-lap / 3) * smooth((deepest - 0.3) / 1.1);
        spec *= 1 + 2.5 * crest;
      }
    }
    // Weak sky reflection at grazing normals keeps deep shadows from going dead black.
    // Light that reaches a crevice has bounced off pigment on the way, so its colour deepens.
    const richness = 0.35 * cavity;
    const rich = (a: number) => a * (1 - richness + a * richness);
    const fv = 1 - nz, env = (0.02 + 0.2 * fv * fv) * ambient * 0.22;
    if (view === 'spec') { encode(i, spec, spec, spec); continue; }
    base[i * 3] = rich(ar) * lit + env;
    base[i * 3 + 1] = rich(ag) * lit + env * 0.985;
    base[i * 3 + 2] = rich(ab) * lit + env * 0.95;
    hdrSpec[i] = spec;
  }
  if (view === 'paint' || view === 'glow') {
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
      const v = hdrSpec[y * w + x];
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
      const g = glow[i] * strength * expo, sp = hdrSpec[i];
      if (view === 'glow') { encode(i, g, g * 0.97, g * 0.92); continue; }
      encode(i,
        clamp((base[i * 3] + sp) * expo + g, 0, 1),
        clamp((base[i * 3 + 1] + sp * 0.985) * expo + g * 0.97, 0, 1),
        clamp((base[i * 3 + 2] + sp * 0.95) * expo + g * 0.92, 0, 1));
    }
  }
  return out;
}
