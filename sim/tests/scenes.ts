import { PaintCanvas } from '../src/canvas.ts';
import { paintStroke, Tool, type StrokeStats } from '../src/tool.ts';
import { dcos, dsin, rng } from '../src/dmath.ts';
import type { RGB } from '../src/pigment.ts';

export interface SceneResult { canvas: PaintCanvas; tools: Tool[]; stats: StrokeStats[]; }

const GROUND: RGB = [0.58, 0.47, 0.37];

/** One knife stroke above one bristle stroke, on bare toned canvas. */
export function oneStrokeScene(): SceneResult {
  const canvas = new PaintCanvas(120, 90, 0.1, GROUND, 7);
  const knife = new Tool({ kind: 'knife', widthMm: 20, nodes: 128, seed: 101 });
  knife.load(15, [0.86, 0.30, 0.20], [0.97, 0.88, 0.70], 0.28, 11);
  const a = paintStroke(canvas, knife, { points: [[12, 30], [40, 22], [72, 29], [108, 21]], gapMm: 1.1, seed: 1001 });
  const brush = new Tool({ kind: 'bristle', widthMm: 16, nodes: 128, seed: 202 });
  brush.load(9.6, [0.12, 0.42, 0.47], [0.86, 0.66, 0.28], 0.25, 22);
  const b = paintStroke(canvas, brush, { points: [[12, 68], [42, 60], [74, 69], [108, 61]], gapMm: 0.95, seed: 2002 });
  return { canvas, tools: [knife, brush], stats: [a, b] };
}

/** Thin underpainting, then many overlapping loaded marks that plow through one another. */
export function patchScene(): SceneResult {
  const canvas = new PaintCanvas(120, 90, 0.1, GROUND, 9);
  const palette: [RGB, RGB][] = [
    [[0.09, 0.40, 0.49], [0.55, 0.80, 0.80]],
    [[0.16, 0.56, 0.60], [0.93, 0.92, 0.82]],
    [[0.83, 0.25, 0.15], [0.97, 0.66, 0.24]],
    [[0.93, 0.56, 0.14], [0.98, 0.90, 0.62]],
    [[0.95, 0.91, 0.79], [0.70, 0.82, 0.82]],
    [[0.09, 0.40, 0.49], [0.93, 0.92, 0.82]],
  ];
  const r = rng(424242);
  const tools: Tool[] = [], stats: StrokeStats[] = [];
  const pick = (a: number, b: number) => a + (b - a) * r();
  const under = new Tool({ kind: 'bristle', widthMm: 22, nodes: 110, seed: 303 });
  tools.push(under);
  for (let i = 0; i < 9; i++) {
    const y = 8 + i * 9.5 + pick(-2, 2);
    under.load(2.0, i % 2 ? [0.30, 0.34, 0.34] : [0.62, 0.42, 0.28], [0.75, 0.62, 0.48], 0.3, 500 + i);
    stats.push(paintStroke(canvas, under, { points: [[-4, y], [40, y + pick(-4, 4)], [80, y + pick(-4, 4)], [124, y + pick(-3, 3)]], gapMm: 0.16, seed: 700 + i }));
    under.wipe(0.5);
  }
  const knives: Tool[] = [], brushes: Tool[] = [];
  for (let i = 0; i < 3; i++) knives.push(new Tool({ kind: 'knife', widthMm: 8 + i * 5, nodes: 96 + i * 16, seed: 400 + i }));
  for (let i = 0; i < 2; i++) brushes.push(new Tool({ kind: 'bristle', widthMm: 6 + i * 4, nodes: 72 + i * 16, seed: 450 + i }));
  tools.push(...knives, ...brushes);
  const order = [0, 2, 4, 1, 3, 5, 2, 4, 0, 3];
  for (let i = 0; i < 110; i++) {
    const useKnife = r() < 0.68;
    const tool = useKnife ? knives[Math.floor(r() * knives.length)] : brushes[Math.floor(r() * brushes.length)];
    // Every colour gets its turn, and the last marks favour the light, warm paints.
    const late = i > 70;
    const [p, s] = palette[late ? [2, 3, 4, 4, 1][i % 5] : order[i % order.length]];
    const W = tool.spec.widthMm;
    const len = W * pick(1.4, 3.6) + pick(4, 18);
    const cx = pick(0, 120), cy = pick(0, 90);
    const flow = 0.34 * dsin(cx * 0.035 + cy * 0.05);
    const angle = flow + pick(-0.42, 0.42) + (r() < 0.5 ? 3.14159265 : 0);
    const dirx = dcos(angle), diry = dsin(angle);
    const bend = pick(-0.14, 0.14) * len;
    const P = (t: number): [number, number] => [cx + dirx * len * t - diry * bend * (1 - 4 * t * t), cy + diry * len * t + dirx * bend * (1 - 4 * t * t)];
    const gap = useKnife ? pick(0.45, 1.25) : pick(0.45, 0.95);
    const volume = (tool.pitch * gap * len) * pick(0.9, 1.35);
    // Now and then the knife is dragged hard through wet paint with little on it.
    const scrape = useKnife && r() < 0.16;
    tool.wipe(pick(0.88, 0.99));
    tool.load(scrape ? volume * 0.25 : volume, p, s, pick(0.08, 0.26), 900 + i);
    stats.push(paintStroke(canvas, tool, { points: [P(-0.5), P(-0.17), P(0.17), P(0.5)], gapMm: scrape ? 0.25 : gap, pressMm: scrape ? pick(0.3, 0.9) : 0, seed: 3000 + i * 13 }));
  }
  return { canvas, tools, stats };
}
