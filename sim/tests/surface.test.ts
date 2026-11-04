import test from 'node:test';
import assert from 'node:assert/strict';
import { PaintCanvas } from '../src/canvas.ts';
import { paintStroke, Tool } from '../src/tool.ts';
import { decodeSurface, encodeSurface, SURFACE_VERSION, surfaceFromCanvas, type ImpastoSurface } from '../src/surface.ts';

function smallSurface(): ImpastoSurface {
  const c = new PaintCanvas(30, 20, 0.1, [0.58, 0.47, 0.37], 7);
  const knife = new Tool({ kind: 'knife', widthMm: 8, nodes: 64, seed: 5 });
  knife.load(6, [0.86, 0.30, 0.20], [0.97, 0.88, 0.70], 0.28, 11);
  paintStroke(c, knife, { points: [[3, 10], [10, 8], [18, 11], [27, 9]], gapMm: 1.0, seed: 3 });
  return surfaceFromCanvas(c);
}

test('encodeSurface / decodeSurface round-trip is bit-exact', () => {
  const s = smallSurface();
  assert.ok(s.maxH > 0.1, 'the stroke left relief');
  const bytes = encodeSurface(s);
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

test('the format is little-endian with a fixed header', () => {
  const s: ImpastoSurface = { w: 2, h: 1, dx: 0.1, maxH: 1.5, height: new Float32Array([1, 2, 3, 4]), color: new Float32Array([0.5, 0.25, 0.125, 0.06, 1, 0, 0, 0.1]) };
  const b = encodeSurface(s), v = new DataView(b.buffer);
  assert.equal(v.getUint32(8, true), SURFACE_VERSION);
  assert.equal(v.getUint32(12, true), 48);
  assert.equal(v.getUint32(16, true), 2); assert.equal(v.getUint32(20, true), 1);
  assert.equal(v.getFloat64(32, true), 0.1); assert.equal(v.getFloat64(40, true), 1.5);
  assert.equal(v.getFloat32(48, true), 1); assert.equal(v.getFloat32(48 + 12, true), 4);
  assert.equal(v.getFloat32(48 + 16, true), 0.5);
});

test('decodeSurface rejects bad input with a clear message', () => {
  const b = encodeSurface(smallSurface());
  assert.throws(() => decodeSurface(new Uint8Array(10)), /bad magic/);
  assert.throws(() => decodeSurface(new Uint8Array([0x1f, 0x8b, 8, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0])), /gzip/);
  assert.throws(() => decodeSurface(b.subarray(0, b.length - 4)), /expected/);
  const v2 = b.slice(); new DataView(v2.buffer).setUint32(8, 2, true);
  assert.throws(() => decodeSurface(v2), /unsupported version 2/);
  assert.throws(() => encodeSurface({ w: 2, h: 2, dx: 0.1, maxH: 0, height: new Float32Array(3), color: new Float32Array(16) }), /do not match/);
});
