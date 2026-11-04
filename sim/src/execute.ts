/** Runs a stroke plan through the paint simulation. */
import { PaintCanvas } from './canvas.ts';
import { paintStroke, Tool, type StrokeStats } from './tool.ts';
import { reflectanceFromKs } from './pigment.ts';
import { makeGrid, type Grid } from './image.ts';
import type { Plan, PlannedStroke } from './planner.ts';
import type { RGB } from './pigment.ts';

export interface Painting { canvas: PaintCanvas; tools: Tool[]; stats: StrokeStats[]; }

export function startPainting(plan: Plan, ground: RGB, dx = 0.1, canvasSeed = 7): Painting {
  return { canvas: new PaintCanvas(plan.widthMm, plan.heightMm, dx, ground, canvasSeed), tools: plan.tools.map((t) => new Tool(t)), stats: [] };
}

/** Paint the given strokes in order. Each one wipes the tool, reloads it and makes one pass. */
export function paintStrokes(p: Painting, strokes: readonly PlannedStroke[]): void {
  for (const st of strokes) {
    const tool = p.tools[st.tool];
    tool.wipe(st.wipe);
    if (st.profile) tool.loadProfile(st.volumePerNode, st.profile, st.secondary, st.secondaryFraction, st.mix ?? 1, st.seed ^ 0x5bd1e995);
    else tool.load(st.volumePerNode, st.primary, st.secondary, st.secondaryFraction, st.seed ^ 0x5bd1e995);
    p.stats.push(paintStroke(p.canvas, tool, { points: st.points, gapMm: st.gapMm, pressMm: st.pressMm, seed: st.seed, engage: st.engage, taper: st.taper, taperMin: st.taperMin, breaks: st.breaks, heap: st.heap, edgeFlaws: st.edgeFlaws, pressure: st.pressure, attackDeg: st.attackDeg, speed: st.speed, deposition: st.deposition, stiffness: st.stiffness }));
  }
}

/**
 * The canvas's unlit paint colour (linear reflectance), averaged onto a gw x gh grid. The per-cell
 * albedo is albedoField's, computed here as it is summed (rounded to float32 as that field stored
 * it) rather than through a whole-canvas buffer, in the same raster order, so the sums are identical.
 */
export function canvasColour(canvas: PaintCanvas, gw: number, gh: number): Grid {
  const { w, h, top, under, topP } = canvas, out = makeGrid(gw, gh, 3), o = out.data, cnt = new Float64Array(gw * gh);
  const gr = [reflectanceFromKs(canvas.groundKs[0]), reflectanceFromKs(canvas.groundKs[1]), reflectanceFromKs(canvas.groundKs[2])];
  const g0 = gr[0], g1 = gr[1], g2 = gr[2];
  const col = new Int32Array(w);
  for (let x = 0; x < w; x++) col[x] = Math.min(gw - 1, Math.floor(x * gw / w));
  for (let y = 0; y < h; y++) {
    const gy = Math.min(gh - 1, Math.floor(y * gh / h)) * gw;
    for (let x = 0; x < w; x++) {
      const c = y * w + x, g = gy + col[x];
      const t = top[c], total = t + under[c];
      // Thin paint is translucent over the ground.
      const alpha = total / (total + 0.018);
      const thick = t > 1e-9;
      const p0 = thick ? reflectanceFromKs(topP[c * 3] / t) : g0, p1 = thick ? reflectanceFromKs(topP[c * 3 + 1] / t) : g1, p2 = thick ? reflectanceFromKs(topP[c * 3 + 2] / t) : g2;
      o[g * 3] += Math.fround(g0 + (p0 - g0) * alpha); o[g * 3 + 1] += Math.fround(g1 + (p1 - g1) * alpha); o[g * 3 + 2] += Math.fround(g2 + (p2 - g2) * alpha);
      cnt[g]++;
    }
  }
  for (let g = 0; g < gw * gh; g++) for (let k = 0; k < 3; k++) o[g * 3 + k] /= cnt[g] || 1;
  return out;
}
