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
