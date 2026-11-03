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

/** Integer avalanche hash in [0,1). */
export function hash(a: number, b: number, c = 0): number {
  let n = (Math.imul(a | 0, 0x9e3779b1) ^ Math.imul(b | 0, 0x85ebca77) ^ Math.imul(c | 0, 0xc2b2ae3d)) | 0;
  n = Math.imul(n ^ (n >>> 16), 0x45d9f3b);
  n = Math.imul(n ^ (n >>> 13), 0x45d9f3b);
  n ^= n >>> 16;
  return (n >>> 0) / 4294967296;
}
export function noise1(x: number, seed: number, salt = 0): number {
  const i = Math.floor(x), f = x - i;
  return lerp(hash(i, seed, salt), hash(i + 1, seed, salt), smooth(f));
}
export function noise2(x: number, y: number, seed: number): number {
  const ix = Math.floor(x), iy = Math.floor(y), u = smooth(x - ix), v = smooth(y - iy);
  const h = (a: number, b: number) => hash(a + Math.imul(b, 7919), seed, 41);
  return lerp(lerp(h(ix, iy), h(ix + 1, iy), u), lerp(h(ix, iy + 1), h(ix + 1, iy + 1), u), v);
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
