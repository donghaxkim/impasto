/**
 * Per-layer snapshots for showing a painting come together: the canvas after each layer as a
 * (downsampled) ImpastoSurface, and the strokes as plain, JSON-serialisable data.
 *
 * Everything here only reads the simulation: snapshots taken or not, the painting is the same.
 * Plain arithmetic only (no Math.sin / pow / exp / random), like the paint code.
 */
import type { PaintCanvas } from './canvas.ts';
import type { Plan, PlannedStroke, Primitive } from './planner.ts';
import { albedoField, occlusionField, surfaceField } from './relight.ts';
import { surfaceFromCanvas, type ImpastoSurface } from './surface.ts';
import { contactProfile, type ToolSpec } from './tool.ts';

/** Default longest side of a snapshot surface, in cells. */
export const DEFAULT_SNAPSHOT_MAX_SIDE = 600;

/** sRGB, 0-1, as a plain array. */
export type Rgb01 = [number, number, number];

/**
 * One knife or brush stroke as plain data: the stable, documented part of the planner's
 * PlannedStroke, for drawing a stroke reveal or downloading the stroke list (JSON.stringify it).
 * Coordinates are mm from the canvas's top-left corner, x right and y down (cell column = x / dx).
 * Points are rounded to 0.001 mm and colours and samples to 1e-4.
 */
export interface ImpastoStroke {
  /** Position in the whole painting's paint order (0-based). */
  index: number;
  /** Layer index (see the result's `layerNames` / the snapshot's `name`). */
  layer: number;
  /** 'knife' (the palette knives) or 'bristle' (the underpainting brush). */
  tool: 'knife' | 'bristle';
  /** How the stroke was made: 'underpaint', 'sweep', 'plane', 'mark', 'scumble', 'pat', 'contour', 'accent' or 'press'. */
  primitive: Primitive;
  /** Path the blade's centre follows, mm, in order; the last stretch is the lift-off tail. */
  points: [number, number][];
  /** Blade (or brush) width, mm. */
  widthMm: number;
  /** Path length, mm, including the tail. */
  lengthMm: number;
  /**
   * Share of the blade in contact at evenly spaced points from start to end (engagement, tapered
   * ends and hand pressure together): the mark's width there is about widthMm x contact.
   */
  contact: number[];
  /** Hand pressure samples from start to end (1 = full; below 1 also narrows the mark). */
  pressure: number[];
  /** Main paint colour. */
  color: Rgb01;
  /** Second colour mixed into the load, and its share (0-1). */
  secondary: Rgb01;
  secondaryFraction: number;
  /**
   * When the knife was loaded with streaks: the colours across the blade, from one edge to the
   * other, and how well they are mixed (0 streaky, 1 blended). Absent for single-colour loads.
   */
  colors?: Rgb01[];
  mix?: number;
  /** Paint thickness the blade leaves under it, mm. */
  thicknessMm: number;
  /** Size of the terminal heap where the blade lifts (0 none, up to 1.5). */
  heap: number;
}

/** Samples in ImpastoStroke.contact. */
const CONTACT_SAMPLES = 11;

const r3 = (v: number): number => Math.round(v * 1000) / 1000;
const r4 = (v: number): number => Math.round(v * 10000) / 10000;
const rgb = (c: readonly number[]): Rgb01 => [r4(c[0]), r4(c[1]), r4(c[2])];

/** One planned stroke as an ImpastoStroke. `tools` is the plan's tool list. */
export function toImpastoStroke(st: PlannedStroke, tools: readonly ToolSpec[]): ImpastoStroke {
  const out: ImpastoStroke = {
    index: st.index, layer: st.layer, tool: tools[st.tool]?.kind ?? 'knife', primitive: st.primitive,
    points: st.points.map((p) => [r3(p[0]), r3(p[1])]),
    widthMm: r3(st.widthMm), lengthMm: r3(st.lengthMm),
    contact: contactProfile(st, st.lengthMm, CONTACT_SAMPLES).map(r4),
    pressure: st.pressure.map(r4),
    color: rgb(st.primary), secondary: rgb(st.secondary), secondaryFraction: r4(st.secondaryFraction),
    thicknessMm: r4(st.gapMm), heap: r4(st.heap),
  };
  if (st.profile) { out.colors = st.profile.map(rgb); out.mix = r4(st.mix ?? 1); }
  return out;
}

/**
 * A plan's strokes in paint order as plain ImpastoStrokes, ready for JSON.stringify (for example
 * `planImpasto`'s `plan`). `renderImpasto` results already carry them as `strokeList`.
 */
export function strokesToJSON(plan: Pick<Plan, 'strokes' | 'tools'>, strokes: readonly PlannedStroke[] = plan.strokes): ImpastoStroke[] {
  return strokes.map((st) => toImpastoStroke(st, plan.tools));
}

/**
 * Cells of the full canvas per snapshot cell (along each side) to fit `maxSide`: the smallest
 * integer factor f with ceil(max(w, h) / f) <= maxSide. 1 for Infinity or a maxSide >= the canvas.
 */
export function snapshotFactor(w: number, h: number, maxSide: number): number {
  const side = Math.max(w, h), m = Math.max(1, Math.floor(maxSide));
  return m >= side ? 1 : Math.ceil(side / m);
}

type Floats = Float32Array | Float64Array;

/**
 * Box filter by an integer factor f: each output cell is the mean of the f x f input cells it
 * covers (fewer along the right and bottom edges when f does not divide the size). Inputs: visible
 * height `s0` and shadow height `s1` at stride `hs` (offsets 0 and `h1off`), linear albedo `alb`
 * at stride `as` (r, g, b at 0-2), and roughness `rough` at stride `rs`, offset `roff`.
 */
function boxReduce(w: number, h: number, dx: number, f: number, s0: Floats, s1: Floats, hs: number, h1off: number, alb: Float32Array, as: number, rough: Float32Array, rs: number, roff: number): ImpastoSurface {
  const ow = Math.ceil(w / f), oh = Math.ceil(h / f);
  const height = new Float32Array(ow * oh * 2), color = new Float32Array(ow * oh * 4);
  const acc = new Float64Array(ow * 6);
  let maxH = 0;
  for (let oy = 0; oy < oh; oy++) {
    acc.fill(0);
    const y0 = oy * f, y1 = Math.min(h, y0 + f);
    for (let y = y0; y < y1; y++) {
      for (let ox = 0; ox < ow; ox++) {
        const x1 = Math.min(w, ox * f + f), o = ox * 6;
        let a0 = 0, a1 = 0, a2 = 0, a3 = 0, a4 = 0, a5 = 0;
        for (let i = y * w + ox * f, end = y * w + x1; i < end; i++) {
          a0 += s0[i * hs]; a1 += s1[i * hs + h1off];
          a2 += alb[i * as]; a3 += alb[i * as + 1]; a4 += alb[i * as + 2];
          a5 += rough[i * rs + roff];
        }
        acc[o] += a0; acc[o + 1] += a1; acc[o + 2] += a2; acc[o + 3] += a3; acc[o + 4] += a4; acc[o + 5] += a5;
      }
    }
    for (let ox = 0; ox < ow; ox++) {
      const cols = Math.min(w, ox * f + f) - ox * f, inv = 1 / (cols * (y1 - y0)), o = ox * 6, j = oy * ow + ox;
      height[j * 2] = acc[o] * inv;
      height[j * 2 + 1] = acc[o + 1] * inv;
      if (height[j * 2 + 1] > maxH) maxH = height[j * 2 + 1];
      for (let k = 0; k < 4; k++) color[j * 4 + k] = acc[o + 2 + k] * inv;
    }
  }
  return { w: ow, h: oh, dx: dx * f, maxH, height, color };
}

/**
 * Shrinks a surface so its longest side is at most `maxSide` cells, for relighting at a lower
 * resolution. Colour (linear albedo and roughness) and both height channels are box-averaged over
 * whole f x f blocks, `dx` grows by f so slopes and shadows keep their physical scale, and `maxH`
 * is recomputed. Returns `s` itself when it already fits.
 */
export function downsampleSurface(s: ImpastoSurface, maxSide: number): ImpastoSurface {
  const f = snapshotFactor(s.w, s.h, maxSide);
  if (f === 1) return s;
  return boxReduce(s.w, s.h, s.dx, f, s.height, s.height, 2, 1, s.color, 4, s.color, 4, 3);
}

/**
 * The canvas as an ImpastoSurface at most `maxSide` cells on its longest side: exactly
 * surfaceFromCanvas(c) when it fits, otherwise downsampleSurface(surfaceFromCanvas(c), maxSide)
 * (up to float rounding: it averages the unrounded fields, without packing the full-size surface
 * first). Fresh buffers on every call, so they are safe to keep or transfer.
 */
export function surfaceSnapshot(c: PaintCanvas, maxSide: number = DEFAULT_SNAPSHOT_MAX_SIDE): ImpastoSurface {
  const f = snapshotFactor(c.w, c.h, maxSide);
  if (f === 1) return surfaceFromCanvas(c);
  const S = surfaceField(c), O = occlusionField(c), A = albedoField(c);
  return boxReduce(c.w, c.h, c.dx, f, S, O, 1, 0, A, 3, c.rough, 1, 0);
}
