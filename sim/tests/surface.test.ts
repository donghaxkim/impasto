import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { PaintCanvas } from '../src/canvas.ts';
import { paintStroke, Tool } from '../src/tool.ts';
import { dcos, dsin, hash } from '../src/dmath.ts';
import { linearToSrgb } from '../src/pigment.ts';
import { DEFAULT_LIGHT, occlusionFilter, relight, relightSurface, type LightSettings } from '../src/relight.ts';
import { decodeSurface, encodeSurface, SURFACE_FLAG_OCCLUSION, SURFACE_VERSION, surfaceFromCanvas, type ImpastoSurface } from '../src/surface.ts';

let small: ImpastoSurface | null = null;
/** A short knife stroke, painted once (callers must not modify it). */
function smallSurface(): ImpastoSurface {
  if (small) return small;
  const c = new PaintCanvas(30, 20, 0.1, [0.58, 0.47, 0.37], 7);
  const knife = new Tool({ kind: 'knife', widthMm: 8, nodes: 64, seed: 5 });
  knife.load(6, [0.86, 0.30, 0.20], [0.97, 0.88, 0.70], 0.28, 11);
  paintStroke(c, knife, { points: [[3, 10], [10, 8], [18, 11], [27, 9]], gapMm: 1.0, seed: 3 });
  return (small = surfaceFromCanvas(c));
}

/** A surface made with plain arithmetic only (no simulation), so its bytes can be pinned. Occlusion is rebuildable unless `occ` is given. */
function syntheticSurface(w = 37, h = 23, occ?: (x: number, y: number) => number): ImpastoSurface {
  const n = w * h, dx = 0.1, height = new Float32Array(n * 2), color = new Float32Array(n * 4), S = new Float32Array(n);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x;
    S[i] = 0.3 + 1.2 * dsin(x * 0.31) * dcos(y * 0.27) + 0.8 * hash(x, y, 1) * (x > w / 2 ? 1 : 0.05);
    const t = x / (w - 1);
    color[i * 4] = t * t * t;                       // reaches deep darks, where linear 8-bit would band
    color[i * 4 + 1] = 0.0004 + 0.9 * hash(x, y, 2);
    color[i * 4 + 2] = y / (h - 1);
    color[i * 4 + 3] = 0.06 + 0.25 * hash(x, y, 3);
  }
  const O = occlusionFilter(S, w, h, dx);
  let maxH = 0;
  for (let i = 0; i < n; i++) {
    height[i * 2] = S[i];
    height[i * 2 + 1] = occ ? occ(i % w, Math.floor(i / w)) : O[i];
    if (height[i * 2 + 1] > maxH) maxH = height[i * 2 + 1];
  }
  return { w, h, dx, maxH, height, color };
}

const sha = (...parts: ArrayBufferView[]) => { const hh = createHash('sha256'); for (const p of parts) hh.update(new Uint8Array(p.buffer, p.byteOffset, p.byteLength)); return hh.digest('hex').slice(0, 16); };
const range = (a: Float32Array, stride: number, k: number) => { let lo = Infinity, hi = -Infinity; for (let i = k; i < a.length; i += stride) { if (a[i] < lo) lo = a[i]; if (a[i] > hi) hi = a[i]; } return [lo, hi]; };
function relightDiff(a: ImpastoSurface, b: ImpastoSurface, light: LightSettings) {
  const pa = relightSurface(a, light), pb = relightSurface(b, light);
  let sum = 0, max = 0;
  for (let i = 0; i < pa.length; i++) { const d = Math.abs(pa[i] - pb[i]); sum += d; if (d > max) max = d; }
  return { mean: sum / pa.length, max };
}

test('version 1 round-trip is bit-exact', () => {
  const s = smallSurface();
  assert.ok(s.maxH > 0.1, 'the stroke left relief');
  const bytes = encodeSurface(s, { version: 1 });
  assert.equal(bytes.length, 48 + s.w * s.h * 24);
  assert.equal(String.fromCharCode(...bytes.subarray(0, 7)), 'IMPASTO');
  const d = decodeSurface(bytes);
  assert.equal(d.w, s.w); assert.equal(d.h, s.h); assert.equal(d.dx, s.dx); assert.equal(d.maxH, s.maxH);
  assert.deepEqual(Buffer.from(d.height.buffer), Buffer.from(s.height.buffer));
  assert.deepEqual(Buffer.from(d.color.buffer), Buffer.from(s.color.buffer));
  // Also from an ArrayBuffer and from an unaligned view into a larger buffer (as fetch or a file slice may give).
  assert.deepEqual(decodeSurface(bytes.slice().buffer).height, s.height);
  const padded = new Uint8Array(bytes.length + 3); padded.set(bytes, 3);
  assert.deepEqual(decodeSurface(padded.subarray(3)).color, s.color);
});

test('version 1 is little-endian with a fixed header, and hand-written v1 files still decode', () => {
  const s: ImpastoSurface = { w: 2, h: 1, dx: 0.1, maxH: 1.5, height: new Float32Array([1, 2, 3, 4]), color: new Float32Array([0.5, 0.25, 0.125, 0.06, 1, 0, 0, 0.1]) };
  const b = encodeSurface(s, { version: 1 }), v = new DataView(b.buffer);
  assert.equal(v.getUint32(8, true), 1);
  assert.equal(v.getUint32(12, true), 48);
  assert.equal(v.getUint32(16, true), 2); assert.equal(v.getUint32(20, true), 1);
  assert.equal(v.getFloat64(32, true), 0.1); assert.equal(v.getFloat64(40, true), 1.5);
  assert.equal(v.getFloat32(48, true), 1); assert.equal(v.getFloat32(48 + 12, true), 4);
  assert.equal(v.getFloat32(48 + 16, true), 0.5);
  // A file as an older build wrote it, built byte by byte here, independent of encodeSurface.
  const old = new Uint8Array(48 + 24), ov = new DataView(old.buffer);
  old.set([0x49, 0x4d, 0x50, 0x41, 0x53, 0x54, 0x4f, 0x1a]);
  ov.setUint32(8, 1, true); ov.setUint32(12, 48, true); ov.setUint32(16, 1, true); ov.setUint32(20, 1, true);
  ov.setFloat64(32, 0.25, true); ov.setFloat64(40, 2, true);
  [2.5, 2, 0.2, 0.3, 0.4, 0.07].forEach((f, k) => ov.setFloat32(48 + k * 4, f, true));
  const d = decodeSurface(old);
  assert.deepEqual([d.w, d.h, d.dx, d.maxH], [1, 1, 0.25, 2]);
  assert.deepEqual(Array.from(d.height), [2.5, 2]);
  assert.deepEqual(Array.from(d.color), Array.from(new Float32Array([0.2, 0.3, 0.4, 0.07])));
});

test('version 2 is the default: 6 bytes per cell, header with ranges, Sub-filtered planes', () => {
  assert.equal(SURFACE_VERSION, 2);
  const s = syntheticSurface(), n = s.w * s.h;
  const b = encodeSurface(s), v = new DataView(b.buffer);
  assert.equal(b.length, 96 + n * 6);
  assert.equal(String.fromCharCode(...b.subarray(0, 7)), 'IMPASTO'); assert.equal(b[7], 0x1a);
  assert.equal(v.getUint32(8, true), 2);
  assert.equal(v.getUint32(12, true), 96);
  assert.equal(v.getUint32(16, true), s.w); assert.equal(v.getUint32(20, true), s.h);
  assert.equal(v.getUint32(24, true), 0, 'occlusion is rebuilt, not stored');
  assert.equal(v.getFloat64(32, true), s.dx); assert.equal(v.getFloat64(40, true), s.maxH);
  const [h0, h1] = range(s.height, 2, 0), [r0, r1] = range(s.color, 4, 3);
  assert.equal(v.getFloat64(48, true), h0); assert.equal(v.getFloat64(56, true), h1);
  assert.equal(v.getFloat64(64, true), 0); assert.equal(v.getFloat64(72, true), 0);
  assert.equal(v.getFloat64(80, true), r0); assert.equal(v.getFloat64(88, true), r1);
  // First cell of row 1: its height is stored as is (low byte plane, then high byte plane).
  const q = Math.round((s.height[s.w * 2] - h0) / (h1 - h0) * 65535);
  assert.equal(b[96 + s.w] | (b[96 + n + s.w] << 8), q);
  // Second cell: the difference from its left neighbour, modulo 2^16.
  const q1 = Math.round((s.height[s.w * 2 + 2] - h0) / (h1 - h0) * 65535);
  assert.equal(b[96 + s.w + 1] | (b[96 + n + s.w + 1] << 8), (q1 - q) & 0xffff);
  // Red is the first colour plane, in sRGB codes: cell 0 is black, the last cell of row 0 white.
  assert.equal(b[96 + n * 2], 0);
  let red = 0;
  for (let x = 0; x < s.w; x++) red = (red + b[96 + n * 2 + x]) & 0xff;
  assert.equal(red, 255);
});

test('a hand-written version 2 file decodes as documented', () => {
  // 2 x 2 cells; heights 0..2 mm; occlusion stored (flag 1); roughness 0.1..0.3.
  const n = 4, b = new Uint8Array(96 + n * 8), v = new DataView(b.buffer);
  b.set([0x49, 0x4d, 0x50, 0x41, 0x53, 0x54, 0x4f, 0x1a]);
  v.setUint32(8, 2, true); v.setUint32(12, 96, true); v.setUint32(16, 2, true); v.setUint32(20, 2, true); v.setUint32(24, SURFACE_FLAG_OCCLUSION, true);
  v.setFloat64(32, 0.1, true); v.setFloat64(40, 1, true);
  [0, 2, 0, 1, 0.1, 0.3].forEach((f, k) => v.setFloat64(48 + k * 8, f, true));
  const heights = [0, 65535, 32768, 1], occ = [65535, 0, 0, 0];
  const put16 = (at: number, q: number[]) => q.forEach((_, i) => { const d = (i % 2 === 0 ? q[i] : q[i] - q[i - 1]) & 0xffff; b[at + i] = d & 255; b[at + n + i] = d >> 8; });
  const put8 = (at: number, q: number[]) => q.forEach((_, i) => { b[at + i] = (i % 2 === 0 ? q[i] : q[i] - q[i - 1]) & 255; });
  put16(96, heights); put16(96 + n * 2, occ);
  put8(96 + n * 4, [0, 255, 128, 10]); put8(96 + n * 5, [0, 0, 0, 0]); put8(96 + n * 6, [255, 255, 255, 255]); put8(96 + n * 7, [0, 255, 51, 0]);
  const d = decodeSurface(b);
  assert.deepEqual([d.w, d.h, d.dx, d.maxH], [2, 2, 0.1, 1]);
  const f = (x: number) => Math.fround(x);
  assert.deepEqual(Array.from(d.height), [0, 1, f(2), 0, f(32768 * 2 / 65535), 0, f(2 / 65535), 0]);
  assert.equal(d.color[0], 0); assert.equal(d.color[4], 1); assert.equal(d.color[2], 1);
  assert.ok(Math.abs(d.color[8] - 0.2158605) < 1e-6, `sRGB 128 is linear 0.2159, got ${d.color[8]}`);
  assert.ok(Math.abs(d.color[12] - 10 / 255 / 12.92) < 1e-7, 'dark codes use the linear segment');
  assert.deepEqual([d.color[3], d.color[7], d.color[11]], [f(0.1), f(0.3), f(0.1 + 51 * 0.2 / 255)]);
});

test('version 2 round trip stays within its quantisation steps', () => {
  for (const s of [smallSurface(), syntheticSurface()]) {
    const n = s.w * s.h, d = decodeSurface(encodeSurface(s));
    assert.deepEqual([d.w, d.h, d.dx, d.maxH], [s.w, s.h, s.dx, s.maxH]);
    const [h0, h1] = range(s.height, 2, 0), [r0, r1] = range(s.color, 4, 3), hStep = (h1 - h0) / 65535, rStep = (r1 - r0) / 255;
    let hErr = 0, oErr = 0, cErr = 0, rErr = 0;
    for (let i = 0; i < n; i++) {
      hErr = Math.max(hErr, Math.abs(d.height[i * 2] - s.height[i * 2]));
      oErr = Math.max(oErr, Math.abs(d.height[i * 2 + 1] - s.height[i * 2 + 1]));
      for (let k = 0; k < 3; k++) cErr = Math.max(cErr, Math.abs(linearToSrgb(d.color[i * 4 + k]) - linearToSrgb(s.color[i * 4 + k])));
      rErr = Math.max(rErr, Math.abs(d.color[i * 4 + 3] - s.color[i * 4 + 3]));
    }
    assert.ok(hErr <= hStep * 0.5 + 1e-6, `height error ${hErr} > half a step ${hStep / 2}`);
    assert.ok(oErr <= hStep * 0.5 + 2e-6, `rebuilt occlusion error ${oErr}`);
    assert.ok(cErr <= 0.6 / 255, `albedo error ${cErr * 255} sRGB levels`);
    assert.ok(rErr <= rStep * 0.5 + 1e-6, `roughness error ${rErr} > half a step ${rStep / 2}`);
  }
});

test('version 2 relights within half an 8-bit level of the original, at the default and a grazing light', () => {
  const s = smallSurface(), d = decodeSurface(encodeSurface(s));
  for (const light of [DEFAULT_LIGHT, { ...DEFAULT_LIGHT, look: 'oil' as const }, { ...DEFAULT_LIGHT, elevation: 10 }, { ...DEFAULT_LIGHT, elevation: 10, azimuth: 20, look: 'oil' as const }]) {
    const r = relightDiff(s, d, light);
    assert.ok(r.mean < 0.5, `mean ${r.mean} levels at ${JSON.stringify(light)}`);
  }
});

test('relightSurface renders a lossless surface like relight renders its canvas', () => {
  const c = new PaintCanvas(20, 12, 0.1, [0.58, 0.47, 0.37], 7);
  const knife = new Tool({ kind: 'knife', widthMm: 6, nodes: 48, seed: 5 });
  knife.load(5, [0.2, 0.4, 0.7], [0.9, 0.9, 0.8], 0.3, 2);
  paintStroke(c, knife, { points: [[2, 6], [9, 5], [18, 7]], gapMm: 1.0, seed: 4 });
  const a = relight(c, DEFAULT_LIGHT), b = relightSurface(surfaceFromCanvas(c), DEFAULT_LIGHT);
  let max = 0;
  for (let i = 0; i < a.length; i++) max = Math.max(max, Math.abs(a[i] - b[i]));
  assert.ok(max <= 1, `float32 heights change pixels by ${max}`);
});

test('version 2 stores the occlusion channel when it cannot be rebuilt', () => {
  const s = syntheticSurface(19, 11, (x, y) => 2 + 0.1 * x - 0.05 * y), n = s.w * s.h;
  const b = encodeSurface(s), v = new DataView(b.buffer);
  assert.equal(v.getUint32(24, true), SURFACE_FLAG_OCCLUSION);
  assert.equal(b.length, 96 + n * 8);
  const [o0, o1] = range(s.height, 2, 1);
  assert.equal(v.getFloat64(64, true), o0); assert.equal(v.getFloat64(72, true), o1);
  const d = decodeSurface(b);
  for (let i = 0; i < n; i++) assert.ok(Math.abs(d.height[i * 2 + 1] - s.height[i * 2 + 1]) <= (o1 - o0) / 65535, `occlusion at ${i}`);
});

test('version 2 handles flat channels and clamps albedo outside 0..1', () => {
  const s: ImpastoSurface = { w: 3, h: 1, dx: 0.1, maxH: 0.5, height: new Float32Array([0.5, 0.5, 0.5, 0.5, 0.5, 0.5]), color: new Float32Array([-0.1, 0.5, 1.2, 0.1, 0, 0, 0, 0.1, 1, 1, 1, 0.1]) };
  const d = decodeSurface(encodeSurface(s));
  assert.deepEqual(Array.from(d.height), Array.from(s.height));
  assert.deepEqual([d.color[0], d.color[2], d.color[3], d.color[7]], [0, 1, Math.fround(0.1), Math.fround(0.1)]);
});

test('encoding and decoding are deterministic (pinned bytes)', () => {
  const s = syntheticSurface();
  const a = encodeSurface(s), b = encodeSurface(syntheticSurface());
  assert.deepEqual(a, b);
  const d1 = decodeSurface(a), d2 = decodeSurface(a.slice());
  assert.deepEqual(d1.height, d2.height); assert.deepEqual(d1.color, d2.color);
  assert.deepEqual(encodeSurface(d1), a, 're-encoding a decoded file gives the same bytes');
  // Pinned so a change in the format or in the arithmetic behind it shows up here.
  assert.equal(sha(a), '05f400adabb69438');
  assert.equal(sha(d1.height, d1.color), '4bab64afd6742d4f');
  const occ = encodeSurface(syntheticSurface(19, 11, (x, y) => 2 + 0.1 * x - 0.05 * y));
  assert.equal(sha(occ), '4f29b34488a41cfb');
});

test('decodeSurface rejects bad input with a clear message', () => {
  const b1 = encodeSurface(smallSurface(), { version: 1 }), b2 = encodeSurface(smallSurface());
  const patch = (b: Uint8Array, f: (v: DataView) => void) => { const c = b.slice(); f(new DataView(c.buffer)); return c; };
  assert.throws(() => decodeSurface(new Uint8Array(10)), /bad magic/);
  assert.throws(() => decodeSurface(new Uint8Array([0x1f, 0x8b, 8, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0])), /gzip/);
  for (const b of [b1, b2]) {
    assert.throws(() => decodeSurface(b.subarray(0, b.length - 4)), /expected .* bytes.*truncated/);
    assert.throws(() => decodeSurface(b.subarray(0, 40)), /truncated header/);
    const longer = new Uint8Array(b.length + 1); longer.set(b);
    assert.throws(() => decodeSurface(longer), /expected/);
    assert.throws(() => decodeSurface(patch(b, (v) => v.setUint32(8, 3, true))), /unsupported version 3/);
    assert.throws(() => decodeSurface(patch(b, (v) => v.setUint32(16, 0, true))), /bad size/);
    assert.throws(() => decodeSurface(patch(b, (v) => v.setUint32(20, 1 << 30, true))), /expected/);
    assert.throws(() => decodeSurface(patch(b, (v) => v.setFloat64(32, NaN, true))), /bad dx/);
    assert.throws(() => decodeSurface(patch(b, (v) => v.setUint32(24, 4, true))), /unknown flags/);
  }
  assert.throws(() => decodeSurface(patch(b1, (v) => v.setUint32(24, 1, true))), /unknown flags 0x1 for version 1/);
  assert.throws(() => decodeSurface(patch(b2, (v) => v.setUint32(12, 48, true))), /header size 48 is too small for version 2/);
  // A v2 file claiming a stored occlusion channel it does not have.
  assert.throws(() => decodeSurface(patch(b2, (v) => v.setUint32(24, 1, true))), /expected/);
  assert.throws(() => decodeSurface(patch(b2, (v) => v.setFloat64(56, NaN, true))), /corrupt value ranges/);
  assert.throws(() => decodeSurface(patch(b2, (v) => { v.setFloat64(80, 1, true); v.setFloat64(88, 0, true); })), /corrupt value ranges/);
  // A larger header than this build knows is skipped (later versions can grow it).
  const grown = new Uint8Array(b2.length + 8); grown.set(b2.subarray(0, 96)); grown.set(b2.subarray(96), 104);
  new DataView(grown.buffer).setUint32(12, 104, true);
  assert.deepEqual(decodeSurface(grown).height, decodeSurface(b2).height);
});

test('encodeSurface rejects surfaces it cannot write', () => {
  const s = syntheticSurface(4, 3);
  assert.throws(() => encodeSurface({ w: 2, h: 2, dx: 0.1, maxH: 0, height: new Float32Array(3), color: new Float32Array(16) }), /do not match/);
  assert.throws(() => encodeSurface({ ...s, w: 0 }), /bad size/);
  assert.throws(() => encodeSurface({ ...s, dx: 0 }), /bad dx/);
  assert.throws(() => encodeSurface(s, { version: 3 as 2 }), /unsupported version 3/);
  const nan = { ...s, height: s.height.slice() }; nan.height[5] = NaN;
  assert.throws(() => encodeSurface(nan), /height is not finite at cell 2/);
  const inf = { ...s, color: s.color.slice() }; inf.color[9] = Infinity;
  assert.throws(() => encodeSurface(inf), /color is not finite at cell 2/);
  assert.equal(encodeSurface(nan, { version: 1 }).length, 48 + 12 * 24, 'version 1 stores any float as is');
});
