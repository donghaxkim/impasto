import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { PaintCanvas } from '../src/canvas.ts';
import { paintStroke, Tool, yieldVolume, type StrokeSpec } from '../src/tool.ts';

const GROUND = [0.58, 0.47, 0.37] as const, BLUE = [0.2, 0.5, 0.75] as const, CREAM = [0.9, 0.9, 0.85] as const;
const fingerprint = (c: PaintCanvas) => createHash('sha256').update(Buffer.from(c.top.buffer)).update(Buffer.from(c.under.buffer)).update(Buffer.from(c.topP.buffer)).digest('hex');

/** One horizontal knife mark from (10, 20), loaded the way the planner loads it. */
function mark(W: number, L: number, extra: Partial<StrokeSpec> = {}) {
  const canvas = new PaintCanvas(L + 30, 40, 0.1, GROUND, 3);
  const tool = new Tool({ kind: 'knife', widthMm: W, nodes: Math.max(48, Math.min(128, Math.round(W * 12))), seed: 7 });
  tool.load(Math.max(tool.pitch * 0.45 * L * 1.15, 6 * yieldVolume('knife', tool.pitch, L)), BLUE, CREAM, 0.2, 5);
  const stats = paintStroke(canvas, tool, { points: [[10, 20], [10 + L / 3, 20], [10 + 2 * L / 3, 20], [10 + L, 20]], gapMm: 0.45, seed: 99, ...extra });
  return { canvas, tool, stats };
}
const conserved = ({ canvas, tool }: ReturnType<typeof mark>) => {
  const held = canvas.totalVolume() + canvas.lost + tool.residual() + tool.wiped;
  assert.ok(Math.abs(tool.loaded - held) / tool.loaded < 1e-9, `volume ${tool.loaded} vs ${held}`);
};
/** Painted width (mm) of the column at x mm: cells with more than 0.05 mm of paint. */
const widthAt = (c: PaintCanvas, xMm: number) => {
  const x = Math.round(xMm / c.dx);
  let n = 0;
  for (let y = 0; y < c.h; y++) if (c.top[y * c.w + x] + c.under[y * c.w + x] > 0.05) n++;
  return n * c.dx;
};

test('short marks: a 3 x 5 mm knife mark lays its paint, with a heap in proportion', () => {
  const m = mark(3, 5);
  conserved(m);
  const laid = m.canvas.totalVolume();
  assert.ok(laid > 3, `only ${laid.toFixed(2)} mm3 laid`);
  assert.ok(m.stats.heapVolume < laid * 0.4, `heap ${m.stats.heapVolume.toFixed(2)} of ${laid.toFixed(2)} mm3`);
  assert.ok(widthAt(m.canvas, 12) > 2.4, `mark is ${widthAt(m.canvas, 12).toFixed(1)} mm wide`);
});

test('defaults: explicit default options paint exactly what the plain stroke paints', () => {
  const a = mark(12, 40), b = mark(12, 40, { engage: 1, taper: [0, 0], breaks: 0, heap: 1 });
  assert.equal(fingerprint(a.canvas), fingerprint(b.canvas));
});

test('taper: a stroke narrows toward tapered ends and keeps its full width between', () => {
  const m = mark(8, 30, { taper: [0.35, 0.35], taperMin: 0.15 });
  conserved(m);
  const mid = widthAt(m.canvas, 25), head = widthAt(m.canvas, 11.5);
  assert.ok(mid > 7, `middle ${mid.toFixed(1)} mm`);
  assert.ok(head < mid * 0.5, `head ${head.toFixed(1)} mm vs middle ${mid.toFixed(1)} mm`);
});

test('engage: half the blade in contact paints a mark about half as wide', () => {
  const full = widthAt(mark(10, 30).canvas, 22), half = widthAt(mark(10, 30, { engage: 0.5 }).canvas, 22);
  assert.ok(half > full * 0.35 && half < full * 0.65, `half ${half.toFixed(1)} mm vs full ${full.toFixed(1)} mm`);
});

test('breaks: a broken stroke leaves ragged gaps that vary across the blade', () => {
  const m = mark(10, 40, { breaks: 0.45 });
  conserved(m);
  const { canvas } = m, y0 = Math.round(16 / canvas.dx), y1 = Math.round(24 / canvas.dx);
  let bare = 0, all = 0, partialColumns = 0, gapColumns = 0;
  for (let x = Math.round(14 / canvas.dx); x < Math.round(40 / canvas.dx); x++) {
    let b = 0;
    for (let y = y0; y < y1; y++) { all++; if (canvas.top[y * canvas.w + x] + canvas.under[y * canvas.w + x] < 0.02) { bare++; b++; } }
    if (b > 0) gapColumns++;
    if (b > 0 && b < y1 - y0) partialColumns++;
  }
  assert.ok(bare / all > 0.05 && bare / all < 0.6, `bare share ${(bare / all).toFixed(2)}`);
  assert.ok(partialColumns > gapColumns * 0.8, `${partialColumns} of ${gapColumns} gap columns are partial`);
});

test('heap: 0 lifts cleanly, 1.5 sheds more than the usual heap, and paint is conserved', () => {
  const none = mark(9, 30, { heap: 0 }), usual = mark(9, 30), big = mark(9, 30, { heap: 1.5 });
  for (const m of [none, usual, big]) conserved(m);
  assert.equal(none.stats.heapVolume, 0);
  assert.ok(big.stats.heapVolume > usual.stats.heapVolume * 1.2, `${big.stats.heapVolume.toFixed(1)} vs ${usual.stats.heapVolume.toFixed(1)}`);
});
