/**
 * Engine-independent math. Math.sin/pow/exp/cbrt may differ between JS engines,
 * so the simulation and relighter use only + - * / sqrt floor (exact in IEEE 754)
 * and the series below.
 */
const PI = 3.141592653589793;
const LN2 = 0.6931471805599453;

export const clamp = (x: number, a: number, b: number) => (x < a ? a : x > b ? b : x);
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
export const smooth = (t: number) => { const u = clamp(t, 0, 1); return u * u * (3 - 2 * u); };
export const radians = (d: number) => d * PI / 180;

export function dsin(x: number): number {
  let r = x - 2 * PI * Math.floor(x / (2 * PI));
  if (r > PI) r -= 2 * PI;
  const r2 = r * r;
  let term = r, sum = r;
  for (let n = 1; n <= 9; n++) { term *= -r2 / ((2 * n) * (2 * n + 1)); sum += term; }
  return sum;
}
export const dcos = (x: number) => dsin(x + PI / 2);

function dlog(x: number): number {
  let e = 0, m = x;
  while (m > 1.5) { m *= 0.5; e++; }
  while (m < 0.75) { m *= 2; e--; }
  const y = (m - 1) / (m + 1), y2 = y * y;
  let term = y, sum = 0;
  for (let n = 1; n <= 19; n += 2) { sum += term / n; term *= y2; }
  return 2 * sum + e * LN2;
}
function dexp(x: number): number {
  const k = Math.floor(x / LN2 + 0.5);
  const r = x - k * LN2;
  let term = 1, sum = 1;
  for (let n = 1; n <= 16; n++) { term *= r / n; sum += term; }
  let scale = 1;
  for (let i = 0; i < Math.abs(k); i++) scale *= k > 0 ? 2 : 0.5;
  return sum * scale;
}
export const dpow = (x: number, y: number) => (x <= 0 ? 0 : dexp(y * dlog(x)));
export function dcbrt(v: number): number {
  if (v <= 0) return 0;
  let x = v > 1 ? v : 1;
  for (let i = 0; i < 40; i++) x = (2 * x + v / (x * x)) / 3;
  return x;
}

/** Final avalanche of the integer hash: int32 in, [0,1) out. */
function hashMix(n: number): number {
  n = Math.imul(n ^ (n >>> 16), 0x45d9f3b);
  n = Math.imul(n ^ (n >>> 13), 0x45d9f3b);
  n ^= n >>> 16;
  return (n >>> 0) / 4294967296;
}
/** The (b, c) part of hash's seed mix, so a and b can be folded into one key when b and c are fixed. */
const hashKey = (b: number, c: number) => Math.imul(b | 0, 0x85ebca77) ^ Math.imul(c | 0, 0xc2b2ae3d);
/** hash(a, b, c) with key = hashKey(b, c). */
const hashWith = (a: number, key: number) => hashMix((Math.imul(a | 0, 0x9e3779b1) ^ key) | 0);

/** Integer avalanche hash in [0,1). */
export function hash(a: number, b: number, c = 0): number {
  return hashMix((Math.imul(a | 0, 0x9e3779b1) ^ Math.imul(b | 0, 0x85ebca77) ^ Math.imul(c | 0, 0xc2b2ae3d)) | 0);
}
export function noise1(x: number, seed: number, salt = 0): number {
  const i = Math.floor(x), f = x - i, key = hashKey(seed, salt);
  return lerp(hashWith(i, key), hashWith(i + 1, key), smooth(f));
}
const NOISE2_KEY = Math.imul(41, 0xc2b2ae3d);
export function noise2(x: number, y: number, seed: number): number {
  const ix = Math.floor(x), iy = Math.floor(y), u = smooth(x - ix), v = smooth(y - iy);
  const key = Math.imul(seed | 0, 0x85ebca77) ^ NOISE2_KEY;
  const r0 = Math.imul(iy, 7919), r1 = Math.imul(iy + 1, 7919);
  return lerp(lerp(hashWith(ix + r0, key), hashWith(ix + 1 + r0, key), u), lerp(hashWith(ix + r1, key), hashWith(ix + 1 + r1, key), u), v);
}
/**
 * noise2 along one row of the lattice: y and seed fixed, x varying over [xMin, xMax]. The row's
 * lattice hashes are computed once and kept while later `set` calls stay on the same row (same
 * floor(y), seed and x range), so a stroke that samples the same noise at hundreds of x positions
 * per step, and at nearly the same y step after step, pays for a few hashes per row change
 * instead of four per sample. Results are bit-identical to noise2 (the same hashes go through the
 * same lerps); x outside the range falls back to noise2.
 */
export class Noise2Row {
  private y = 0; private seed = NaN; private iy = NaN; private v = 0;
  private base = 0; private n = 0;
  private h0 = new Float64Array(0); private h1 = new Float64Array(0);
  /** Bumped whenever the row's hashes change; `fill` keys its per-x cache on it. */
  private gen = 0;
  private fillGen = -1; private fillScale = NaN; private fillCount = 0;
  /** For `fill`: the row's x-lerps at i * scale (NaN where x is outside the row and noise2 is used). */
  private fa = new Float64Array(0); private fc = new Float64Array(0);
  set(y: number, seed: number, xMin: number, xMax: number): void {
    const iy = Math.floor(y);
    this.y = y; this.v = smooth(y - iy);
    const base = Math.floor(xMin), n = Math.floor(xMax) - base + 2;
    if (iy === this.iy && seed === this.seed && base === this.base && n === this.n) return;
    this.iy = iy; this.seed = seed; this.base = base; this.gen++;
    if (!(n > 0)) { this.n = 0; return; }
    this.n = n;
    if (n > this.h0.length) { this.h0 = new Float64Array(n); this.h1 = new Float64Array(n); }
    const { h0, h1 } = this, key = Math.imul(seed | 0, 0x85ebca77) ^ NOISE2_KEY;
    const r0 = Math.imul(iy, 7919), r1 = Math.imul(iy + 1, 7919);
    for (let k = 0; k < n; k++) { const ix = base + k; h0[k] = hashWith(ix + r0, key); h1[k] = hashWith(ix + r1, key); }
  }
  at(x: number): number {
    const ix = Math.floor(x), k = ix - this.base;
    if (!(k >= 0 && k + 1 < this.n)) return noise2(x, this.y, this.seed);
    const u = smooth(x - ix), h0 = this.h0, h1 = this.h1;
    return lerp(lerp(h0[k], h0[k + 1], u), lerp(h1[k], h1[k + 1], u), this.v);
  }
  /**
   * out[i] = at(i * scale) for i in [0, count). The x-lerps of each sample depend only on the row
   * and x, so they are kept across calls while the row and scale stay the same (a stroke's steps
   * move y a little at a time), and each call is one lerp in y per sample.
   */
  fill(out: Float64Array, count: number, scale: number): void {
    if (this.fillGen !== this.gen || this.fillScale !== scale || this.fillCount !== count) {
      this.fillGen = this.gen; this.fillScale = scale; this.fillCount = count;
      if (count > this.fa.length) { this.fa = new Float64Array(count); this.fc = new Float64Array(count); }
      const { fa, fc, h0, h1 } = this;
      for (let i = 0; i < count; i++) {
        const x = i * scale, ix = Math.floor(x), k = ix - this.base;
        if (!(k >= 0 && k + 1 < this.n)) { fa[i] = NaN; continue; }
        const u = smooth(x - ix);
        fa[i] = lerp(h0[k], h0[k + 1], u); fc[i] = lerp(h1[k], h1[k + 1], u);
      }
    }
    const { fa, fc, v } = this;
    for (let i = 0; i < count; i++) {
      const a = fa[i];
      out[i] = a !== a ? noise2(i * scale, this.y, this.seed) : lerp(a, fc[i], v);
    }
  }
}
export function fbm1(x: number, seed: number, salt = 0): number {
  return (noise1(x, seed, salt) * 4 + noise1(x * 2.1, seed, salt + 1) * 2 + noise1(x * 4.3, seed, salt + 2)) / 7;
}
/** Small seeded PRNG for scene authoring. */
export function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
