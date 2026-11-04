/** Runs a stroke plan through the paint simulation. */
import { PaintCanvas } from './canvas.ts';
import { paintStroke, Tool, type StrokeStats } from './tool.ts';
import { albedoField } from './relight.ts';
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

/** The canvas's unlit paint colour (linear reflectance), averaged onto a gw x gh grid. */
export function canvasColour(canvas: PaintCanvas, gw: number, gh: number): Grid {
  const A = albedoField(canvas), out = makeGrid(gw, gh, 3), cnt = new Float64Array(gw * gh);
  for (let y = 0; y < canvas.h; y++) {
    const gy = Math.min(gh - 1, Math.floor(y * gh / canvas.h));
    for (let x = 0; x < canvas.w; x++) {
      const g = gy * gw + Math.min(gw - 1, Math.floor(x * gw / canvas.w)), c = y * canvas.w + x;
      out.data[g * 3] += A[c * 3]; out.data[g * 3 + 1] += A[c * 3 + 1]; out.data[g * 3 + 2] += A[c * 3 + 2]; cnt[g]++;
    }
  }
  for (let g = 0; g < gw * gh; g++) for (let k = 0; k < 3; k++) out.data[g * 3 + k] /= cnt[g] || 1;
  return out;
}
