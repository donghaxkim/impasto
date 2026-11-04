import type { PaintCanvas } from './canvas.ts';
import { albedoField, occlusionField, occlusionFilter, surfaceField } from './relight.ts';
import { srgbToLinear } from './pigment.ts';

/**
 * A painted canvas packed for relighting: everything a renderer needs to light the paint from
 * any direction, without the simulation's internal state. This is the hand-off between the
 * CPU simulation and a live viewer (WebGPU, or the CPU fallback), and what the library returns.
 *
 * Layouts match the WebGPU relight shader (`RELIGHT_WGSL`): `height` is rg32float, `color` is
 * rgba32float, both row-major, `w * h` texels.
 */
export interface ImpastoSurface {
  /** Size in cells. */
  w: number; h: number;
  /** Cell size in mm. */
  dx: number;
  /** Highest value in the occlusion channel, in mm (scales shadow queries). */
  maxH: number;
  /** Per cell: [visible surface height mm, slightly filtered height for shadows/occlusion mm]. */
  height: Float32Array;
  /** Per cell: [linear albedo r, g, b, clearcoat roughness]. */
  color: Float32Array;
}

/** Packs a painted canvas into an ImpastoSurface. Pure data, so it can cross a worker or a file. */
export function surfaceFromCanvas(c: PaintCanvas): ImpastoSurface {
  const S = surfaceField(c), O = occlusionField(c), A = albedoField(c);
  const height = new Float32Array(c.n * 2), color = new Float32Array(c.n * 4);
  let maxH = 0;
  for (let i = 0; i < c.n; i++) {
    height[i * 2] = S[i]; height[i * 2 + 1] = O[i]; if (O[i] > maxH) maxH = O[i];
    color[i * 4] = A[i * 3]; color[i * 4 + 1] = A[i * 3 + 1]; color[i * 4 + 2] = A[i * 3 + 2]; color[i * 4 + 3] = c.rough[i];
  }
  return { w: c.w, h: c.h, dx: c.dx, maxH, height, color };
}

/*
 * Binary transport (`.impasto` files), so a site can ship prerendered paintings as files.
 * All little-endian. Every version starts with the same 48 bytes:
 *   0  8 bytes  magic "IMPASTO" followed by 0x1A
 *   8  u32      version (1 or 2)
 *  12  u32      header size in bytes; data starts here, so later versions can grow the header
 *  16  u32      w (cells)
 *  20  u32      h (cells)
 *  24  u32      flags
 *  28  u32      reserved (0)
 *  32  f64      dx (mm per cell)
 *  40  f64      maxH (mm)
 *
 * Version 1 (lossless, 24 bytes per cell): header size 48, flags 0, then
 *  48  f32[w*h*2]  height, as in ImpastoSurface.height
 *      f32[w*h*4]  color, as in ImpastoSurface.color
 * Floats are stored bit-exact, so decode(encode(s, { version: 1 })) reproduces s exactly.
 *
 * Version 2 (quantised, 6 bytes per cell, 8 with the occlusion channel): header size 96, and
 *  24  flags: bit 0 set when the occlusion channel is stored; clear when the decoder rebuilds it
 *      from the visible height with occlusionFilter (what surfaceFromCanvas wrote). Other bits 0.
 *  48  f64      visible height min (mm)    56  f64  visible height max (mm)
 *  64  f64      occlusion min (mm, 0 if not stored)    72  f64  occlusion max (mm, 0 if not stored)
 *  80  f64      roughness min    88  f64  roughness max
 *  96  planes, each w*h values in row-major order:
 *      visible height   u16, round((v - min) / (max - min) * 65535): the w*h low bytes, then the w*h high bytes
 *      occlusion        u16 as above, only when flag bit 0 is set
 *      albedo r, g, b   u8 each, the sRGB transfer of the linear value (clamped to 0..1) rounded to 1/255
 *      roughness        u8, round((v - min) / (max - min) * 255)
 *   Every plane is stored with PNG's "Sub" filter, which roughly halves its gzipped size: within
 *   each row, a value is stored as itself minus its left neighbour, modulo 2^16 (heights, before
 *   the byte split) or 2^8; the first value of each row is stored as is.
 *   Decoding gives min + q * (max - min) / 65535 (or / 255), and the albedo through a 256-entry
 *   sRGB-to-linear table (srgbToLinear, engine-independent), so the result is the same bits on
 *   every engine.
 */
export const SURFACE_MAGIC = [0x49, 0x4d, 0x50, 0x41, 0x53, 0x54, 0x4f, 0x1a] as const;
/** The version encodeSurface writes by default (the newest). decodeSurface reads 1 and 2. */
export const SURFACE_VERSION = 2;
const V1_HEADER_BYTES = 48, V2_HEADER_BYTES = 96;
/** Flag bit (version 2): the occlusion channel is stored rather than rebuilt from the visible height. */
export const SURFACE_FLAG_OCCLUSION = 1;
/** Plausible cell sizes in mm. Outside this a header is corrupt or hostile: renderers and the occlusion filter scale with 1/dx. */
export const SURFACE_DX_MIN = 1e-3;
export const SURFACE_DX_MAX = 100;
/** Default `maxCells` for `decodeSurface`: 32M cells (e.g. 640 x 500 mm at 0.1 mm). A decoded surface keeps 24 bytes per cell. */
export const SURFACE_MAX_CELLS = 32_000_000;
const plausibleDx = (dx: number): boolean => dx >= SURFACE_DX_MIN && dx <= SURFACE_DX_MAX;

export interface DecodeSurfaceOptions {
  /** Reject surfaces with more cells than this before allocating anything (default SURFACE_MAX_CELLS). */
  maxCells?: number;
}

export interface EncodeSurfaceOptions {
  /**
   * 2 (default): quantised, 6 bytes per cell, within a fraction of an 8-bit level when relit.
   * 1: lossless float32, 24 bytes per cell.
   */
  version?: 1 | 2;
}

const littleEndian = new Uint8Array(new Uint32Array([1]).buffer)[0] === 1;

function writeFloats(view: DataView, bytes: Uint8Array, offset: number, src: Float32Array): void {
  if (littleEndian) bytes.set(new Uint8Array(src.buffer, src.byteOffset, src.byteLength), offset);
  else for (let i = 0; i < src.length; i++) view.setFloat32(offset + i * 4, src[i], true);
}
function readFloats(view: DataView, bytes: Uint8Array, offset: number, count: number): Float32Array {
  const out = new Float32Array(count);
  if (littleEndian) new Uint8Array(out.buffer).set(bytes.subarray(offset, offset + count * 4));
  else for (let i = 0; i < count; i++) out[i] = view.getFloat32(offset + i * 4, true);
  return out;
}

/** Linear albedo for each 8-bit sRGB code, and the linear value halfway (in sRGB) between codes k and k+1. */
let srgbTables: { decode: Float32Array; mid: Float64Array } | null = null;
function srgb8(): { decode: Float32Array; mid: Float64Array } {
  if (!srgbTables) {
    const decode = new Float32Array(256), mid = new Float64Array(255);
    for (let k = 0; k < 256; k++) decode[k] = srgbToLinear(k / 255);
    for (let k = 0; k < 255; k++) mid[k] = srgbToLinear((k + 0.5) / 255);
    srgbTables = { decode, mid };
  }
  return srgbTables;
}
/** Nearest 8-bit sRGB code to a linear value, by binary search on the midpoints (no pow). */
function linearToSrgb8(v: number, mid: Float64Array): number {
  let lo = 0, hi = 255; // answer = number of midpoints <= v
  while (lo < hi) { const m = (lo + hi) >> 1; if (mid[m] <= v) lo = m + 1; else hi = m; }
  return lo;
}

function range(src: Float32Array, stride: number, offset: number, n: number): [number, number] {
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < n; i++) { const v = src[i * stride + offset]; if (v < lo) lo = v; if (v > hi) hi = v; }
  return [lo, hi];
}
/** Quantises one interleaved channel to `levels` (255 or 65535) steps over [lo, hi]. */
function quantise(src: Float32Array, stride: number, offset: number, lo: number, hi: number, levels: number, n: number): Uint32Array {
  const q = new Uint32Array(n), scale = hi > lo ? levels / (hi - lo) : 0;
  for (let i = 0; i < n; i++) {
    const t = Math.round((src[i * stride + offset] - lo) * scale);
    q[i] = t < 0 ? 0 : t > levels ? levels : t;
  }
  return q;
}
function writePlane16(bytes: Uint8Array, offset: number, q: Uint32Array, w: number, n: number): void {
  for (let i = 0; i < n; i++) {
    const d = (i % w === 0 ? q[i] : q[i] - q[i - 1]) & 0xffff;
    bytes[offset + i] = d & 0xff; bytes[offset + n + i] = d >>> 8;
  }
}
function writePlane8(bytes: Uint8Array, offset: number, q: ArrayLike<number>, w: number, n: number): void {
  for (let i = 0; i < n; i++) bytes[offset + i] = (i % w === 0 ? q[i] : q[i] - q[i - 1]) & 0xff;
}
function readPlane16(bytes: Uint8Array, offset: number, w: number, n: number): Uint16Array {
  const q = new Uint16Array(n);
  for (let i = 0; i < n; i++) {
    const d = bytes[offset + i] | (bytes[offset + n + i] << 8);
    q[i] = i % w === 0 ? d : (q[i - 1] + d) & 0xffff;
  }
  return q;
}
function readPlane8(bytes: Uint8Array, offset: number, w: number, n: number): Uint8Array {
  const q = new Uint8Array(n);
  for (let i = 0; i < n; i++) q[i] = i % w === 0 ? bytes[offset + i] : (q[i - 1] + bytes[offset + i]) & 0xff;
  return q;
}

function writeCommonHeader(view: DataView, bytes: Uint8Array, s: ImpastoSurface, version: number, header: number, flags: number): void {
  bytes.set(SURFACE_MAGIC, 0);
  view.setUint32(8, version, true);
  view.setUint32(12, header, true);
  view.setUint32(16, s.w, true);
  view.setUint32(20, s.h, true);
  view.setUint32(24, flags, true);
  view.setFloat64(32, s.dx, true);
  view.setFloat64(40, s.maxH, true);
}

/**
 * Serialises a surface to the `.impasto` binary format (see above): version 2, quantised, by
 * default; `{ version: 1 }` for lossless floats. The same surface always gives the same bytes.
 */
export function encodeSurface(s: ImpastoSurface, opts: EncodeSurfaceOptions = {}): Uint8Array {
  const version = opts.version ?? SURFACE_VERSION;
  if (version !== 1 && version !== 2) throw new Error(`encodeSurface: unsupported version ${version} (can write 1 or 2)`);
  if (!(Number.isInteger(s.w) && Number.isInteger(s.h) && s.w > 0 && s.h > 0 && s.w <= 0xffffffff && s.h <= 0xffffffff)) throw new Error(`encodeSurface: bad size ${s.w}x${s.h}`);
  const n = s.w * s.h;
  if (s.height.length !== n * 2 || s.color.length !== n * 4) throw new Error(`encodeSurface: buffers do not match ${s.w}x${s.h}`);
  if (!plausibleDx(s.dx) || !Number.isFinite(s.maxH)) throw new Error(`encodeSurface: bad dx ${s.dx} (must be ${SURFACE_DX_MIN} to ${SURFACE_DX_MAX} mm) or maxH ${s.maxH}`);
  if (version === 1) {
    const bytes = new Uint8Array(V1_HEADER_BYTES + n * 24);
    const view = new DataView(bytes.buffer);
    writeCommonHeader(view, bytes, s, 1, V1_HEADER_BYTES, 0);
    writeFloats(view, bytes, V1_HEADER_BYTES, s.height);
    writeFloats(view, bytes, V1_HEADER_BYTES + n * 8, s.color);
    return bytes;
  }

  for (let i = 0; i < n * 2; i++) if (!Number.isFinite(s.height[i])) throw new Error(`encodeSurface: height is not finite at cell ${i >> 1}`);
  for (let i = 0; i < n * 4; i++) if (!Number.isFinite(s.color[i])) throw new Error(`encodeSurface: color is not finite at cell ${i >> 2}`);
  const [h0, h1] = range(s.height, 2, 0, n), [r0, r1] = range(s.color, 4, 3, n);
  // The occlusion channel is dropped when it is what the decoder would rebuild from the visible
  // height (as surfaceFromCanvas writes it); anything else is stored.
  const rebuilt = occlusionFilter(heightChannel(s.height, 0, n), s.w, s.h, s.dx);
  const tol = Math.max(1e-6, (h1 - h0) / 1048576);
  let storeOcc = false;
  for (let i = 0; i < n && !storeOcc; i++) if (Math.abs(rebuilt[i] - s.height[i * 2 + 1]) > tol) storeOcc = true;
  const [o0, o1] = storeOcc ? range(s.height, 2, 1, n) : [0, 0];

  const header = V2_HEADER_BYTES, bytes = new Uint8Array(header + n * (storeOcc ? 8 : 6));
  const view = new DataView(bytes.buffer);
  writeCommonHeader(view, bytes, s, 2, header, storeOcc ? SURFACE_FLAG_OCCLUSION : 0);
  view.setFloat64(48, h0, true); view.setFloat64(56, h1, true);
  view.setFloat64(64, o0, true); view.setFloat64(72, o1, true);
  view.setFloat64(80, r0, true); view.setFloat64(88, r1, true);
  let at = header;
  writePlane16(bytes, at, quantise(s.height, 2, 0, h0, h1, 65535, n), s.w, n); at += n * 2;
  if (storeOcc) { writePlane16(bytes, at, quantise(s.height, 2, 1, o0, o1, 65535, n), s.w, n); at += n * 2; }
  const { mid } = srgb8(), q = new Uint8Array(n);
  for (let k = 0; k < 3; k++) {
    for (let i = 0; i < n; i++) q[i] = linearToSrgb8(s.color[i * 4 + k], mid);
    writePlane8(bytes, at, q, s.w, n); at += n;
  }
  writePlane8(bytes, at, quantise(s.color, 4, 3, r0, r1, 255, n), s.w, n);
  return bytes;
}

function heightChannel(height: Float32Array, k: number, n: number): Float32Array {
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = height[i * 2 + k];
  return out;
}

/**
 * Parses an `.impasto` file, version 1 or 2. Throws with a readable message on anything it does
 * not recognise: wrong magic, gzip data, unknown version or flags, or a size that does not match.
 */
export function decodeSurface(bytes: Uint8Array | ArrayBuffer, opts: DecodeSurfaceOptions = {}): ImpastoSurface {
  const maxCells = opts.maxCells ?? SURFACE_MAX_CELLS;
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (b.length < 16 || SURFACE_MAGIC.some((m, i) => b[i] !== m)) {
    throw new Error(b[0] === 0x1f && b[1] === 0x8b ? 'decodeSurface: data is gzip-compressed; decompress it first' : 'decodeSurface: not an .impasto surface (bad magic)');
  }
  const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const version = view.getUint32(8, true), header = view.getUint32(12, true);
  if (version !== 1 && version !== 2) throw new Error(`decodeSurface: unsupported version ${version} (this build reads 1 and 2)`);
  const minHeader = version === 1 ? V1_HEADER_BYTES : V2_HEADER_BYTES;
  if (header < minHeader) throw new Error(`decodeSurface: header size ${header} is too small for version ${version} (at least ${minHeader})`);
  if (b.length < header) throw new Error(`decodeSurface: truncated header (${b.length} of ${header} bytes)`);
  const w = view.getUint32(16, true), h = view.getUint32(20, true), n = w * h, flags = view.getUint32(24, true);
  if (!w || !h) throw new Error(`decodeSurface: bad size ${w}x${h}`);
  if (n > maxCells) throw new Error(`decodeSurface: ${w}x${h} is ${n} cells, more than maxCells ${maxCells}`);
  const dx = view.getFloat64(32, true), maxH = view.getFloat64(40, true);
  if (!plausibleDx(dx) || !Number.isFinite(maxH)) throw new Error(`decodeSurface: bad dx ${dx} (must be ${SURFACE_DX_MIN} to ${SURFACE_DX_MAX} mm) or maxH ${maxH}`);
  const known = version === 1 ? 0 : SURFACE_FLAG_OCCLUSION;
  if (flags & ~known) throw new Error(`decodeSurface: unknown flags 0x${flags.toString(16)} for version ${version}`);
  const storeOcc = (flags & SURFACE_FLAG_OCCLUSION) !== 0;
  const expected = header + n * (version === 1 ? 24 : storeOcc ? 8 : 6);
  if (b.length !== expected) throw new Error(`decodeSurface: expected ${expected} bytes for a ${w}x${h} version ${version} surface, got ${b.length}${b.length < expected ? ' (truncated)' : ''}`);
  if (version === 1) {
    return { w, h, dx, maxH, height: readFloats(view, b, header, n * 2), color: readFloats(view, b, header + n * 8, n * 4) };
  }

  const ranges = [48, 56, 64, 72, 80, 88].map((o) => view.getFloat64(o, true));
  const [h0, h1, o0, o1, r0, r1] = ranges;
  if (ranges.some((v) => !Number.isFinite(v)) || h1 < h0 || o1 < o0 || r1 < r0 || ![h1 - h0, o1 - o0, r1 - r0].every(Number.isFinite)) throw new Error('decodeSurface: corrupt value ranges in the header');
  const height = new Float32Array(n * 2), color = new Float32Array(n * 4);
  let at = header;
  const hq = readPlane16(b, at, w, n), hs = (h1 - h0) / 65535; at += n * 2;
  for (let i = 0; i < n; i++) height[i * 2] = h0 + hq[i] * hs;
  if (storeOcc) {
    const oq = readPlane16(b, at, w, n), os = (o1 - o0) / 65535; at += n * 2;
    for (let i = 0; i < n; i++) height[i * 2 + 1] = o0 + oq[i] * os;
  } else {
    const occ = occlusionFilter(heightChannel(height, 0, n), w, h, dx);
    for (let i = 0; i < n; i++) height[i * 2 + 1] = occ[i];
  }
  const { decode } = srgb8();
  for (let k = 0; k < 3; k++) {
    const q = readPlane8(b, at, w, n); at += n;
    for (let i = 0; i < n; i++) color[i * 4 + k] = decode[q[i]];
  }
  const rq = readPlane8(b, at, w, n), rs = (r1 - r0) / 255;
  for (let i = 0; i < n; i++) color[i * 4 + 3] = r0 + rq[i] * rs;
  return { w, h, dx, maxH, height, color };
}
