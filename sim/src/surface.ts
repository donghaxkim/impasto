import type { PaintCanvas } from './canvas.ts';
import { albedoField, occlusionField, surfaceField } from './relight.ts';

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
 *
 * Layout, all little-endian (version 1):
 *   0  8 bytes  magic "IMPASTO" followed by 0x1A
 *   8  u32      version (1)
 *  12  u32      header size in bytes (48); data starts here, so later versions can grow the header
 *  16  u32      w (cells)
 *  20  u32      h (cells)
 *  24  u32      flags (0; reserved)
 *  28  u32      reserved (0)
 *  32  f64      dx (mm per cell)
 *  40  f64      maxH (mm)
 *  48  f32[w*h*2]  height, as in ImpastoSurface.height
 *      f32[w*h*4]  color, as in ImpastoSurface.color
 * Floats are stored bit-exact, so decode(encode(s)) reproduces s exactly.
 */
export const SURFACE_MAGIC = [0x49, 0x4d, 0x50, 0x41, 0x53, 0x54, 0x4f, 0x1a] as const;
export const SURFACE_VERSION = 1;
const SURFACE_HEADER_BYTES = 48;

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

/** Serialises a surface to the versioned `.impasto` binary format (see above). */
export function encodeSurface(s: ImpastoSurface): Uint8Array {
  const n = s.w * s.h;
  if (!(Number.isInteger(s.w) && Number.isInteger(s.h) && s.w > 0 && s.h > 0)) throw new Error(`encodeSurface: bad size ${s.w}x${s.h}`);
  if (s.height.length !== n * 2 || s.color.length !== n * 4) throw new Error(`encodeSurface: buffers do not match ${s.w}x${s.h}`);
  const bytes = new Uint8Array(SURFACE_HEADER_BYTES + n * 24);
  const view = new DataView(bytes.buffer);
  bytes.set(SURFACE_MAGIC, 0);
  view.setUint32(8, SURFACE_VERSION, true);
  view.setUint32(12, SURFACE_HEADER_BYTES, true);
  view.setUint32(16, s.w, true);
  view.setUint32(20, s.h, true);
  view.setFloat64(32, s.dx, true);
  view.setFloat64(40, s.maxH, true);
  writeFloats(view, bytes, SURFACE_HEADER_BYTES, s.height);
  writeFloats(view, bytes, SURFACE_HEADER_BYTES + n * 8, s.color);
  return bytes;
}

/** Parses an `.impasto` file. Throws with a readable message on anything it does not recognise. */
export function decodeSurface(bytes: Uint8Array | ArrayBuffer): ImpastoSurface {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (b.length < 16 || SURFACE_MAGIC.some((m, i) => b[i] !== m)) {
    throw new Error(b[0] === 0x1f && b[1] === 0x8b ? 'decodeSurface: data is gzip-compressed; decompress it first' : 'decodeSurface: not an .impasto surface (bad magic)');
  }
  const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const version = view.getUint32(8, true), header = view.getUint32(12, true);
  if (version !== SURFACE_VERSION) throw new Error(`decodeSurface: unsupported version ${version} (this build reads ${SURFACE_VERSION})`);
  if (header < SURFACE_HEADER_BYTES || b.length < header) throw new Error('decodeSurface: truncated header');
  const w = view.getUint32(16, true), h = view.getUint32(20, true), n = w * h;
  if (!w || !h) throw new Error(`decodeSurface: bad size ${w}x${h}`);
  if (b.length !== header + n * 24) throw new Error(`decodeSurface: expected ${header + n * 24} bytes for ${w}x${h}, got ${b.length}`);
  return {
    w, h, dx: view.getFloat64(32, true), maxH: view.getFloat64(40, true),
    height: readFloats(view, b, header, n * 2),
    color: readFloats(view, b, header + n * 8, n * 4),
  };
}
