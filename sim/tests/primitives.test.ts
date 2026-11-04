import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { PaintCanvas } from '../src/canvas.ts';
import { contactProfile, paintStroke, Tool, yieldVolume, type StrokeSpec } from '../src/tool.ts';

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

/** Mean berm and heap volume over a few seeds, for a 10 mm knife pulled 40 mm with physical deposition. */
function physical(extra: Partial<StrokeSpec>, loadMul = 1, pts?: [number, number][]) {
  let berm = 0, heap = 0;
  for (const seed of [1, 2, 3, 4]) {
    const canvas = new PaintCanvas(70, 60, 0.1, GROUND, 3);
    const tool = new Tool({ kind: 'knife', widthMm: 10, nodes: 120, seed: 10 + seed });
    tool.load(Math.max(tool.pitch * 0.45 * 40 * 1.15, 6 * yieldVolume('knife', tool.pitch, 40)) * loadMul, BLUE, CREAM, 0.2, 100 + seed);
    const st = paintStroke(canvas, tool, { points: pts ?? [[10, 30], [23, 30], [37, 30], [50, 30]], gapMm: 0.45, seed: 1000 + seed, deposition: 'physical', ...extra });
    const held = canvas.totalVolume() + canvas.lost + tool.residual() + tool.wiped;
    assert.ok(Math.abs(tool.loaded - held) / tool.loaded < 1e-9, 'volume conserved');
    berm += st.bermVolume / 4; heap += st.heapVolume / 4;
  }
  return { berm, heap };
}

test('physical deposition: berms grow with pressure, a flatter blade and more load; the heap with lift pressure', () => {
  const p = [0.5, 1, 1.4].map((v) => physical({ pressure: [v] }));
  assert.ok(p[0].berm < p[1].berm && p[1].berm < p[2].berm, `berm by pressure ${p.map((x) => x.berm.toFixed(1))}`);
  assert.ok(p[0].heap < p[1].heap && p[1].heap < p[2].heap, `heap by pressure ${p.map((x) => x.heap.toFixed(1))}`);
  const flat = physical({ attackDeg: 10 }), steep = physical({ attackDeg: 60 });
  assert.ok(flat.berm > steep.berm * 1.15, `flat ${flat.berm.toFixed(1)} vs steep ${steep.berm.toFixed(1)}`);
  const light = physical({}, 0.6), heavy = physical({}, 2.5);
  assert.ok(heavy.berm > light.berm * 2.5 && heavy.heap > light.heap * 4, `light ${JSON.stringify(light)} heavy ${JSON.stringify(heavy)}`);
  // A light lift keeps the bead on the knife: a clean end, not a heap.
  const lifted = physical({ pressure: [1, 1, 1, 0.15] });
  assert.ok(lifted.heap < p[1].heap * 0.5, `lifted ${lifted.heap.toFixed(1)} vs ${p[1].heap.toFixed(1)}`);
});

test('physical deposition: on a curve the berm builds on the outside of the turn', () => {
  // A quarter arc turning toward +y (downward on the canvas): its outside is the upper, outer edge.
  let outside = 0, inside = 0;
  for (const seed of [1, 2, 3]) {
    const canvas = new PaintCanvas(80, 80, 0.1, GROUND, 3);
    const tool = new Tool({ kind: 'knife', widthMm: 9, nodes: 108, seed: 20 + seed });
    tool.load(6 * yieldVolume('knife', tool.pitch, 40) * 1.6, BLUE, CREAM, 0.2, 200 + seed);
    const cx = 20, cy = 60, r = 35, pts: [number, number][] = [];
    for (let k = 0; k <= 6; k++) { const a = -Math.PI / 2 + k * Math.PI / 12; pts.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]); }
    paintStroke(canvas, tool, { points: pts, gapMm: 0.45, seed: 300 + seed, deposition: 'physical' });
    // Paint beyond the blade's reach on either side, over the middle of the arc.
    for (let y = 0; y < canvas.h; y++) for (let x = 0; x < canvas.w; x++) {
      const X = (x + 0.5) * 0.1 - cx, Y = (y + 0.5) * 0.1 - cy, d = Math.hypot(X, Y), ang = Math.atan2(Y, X);
      if (ang < -Math.PI / 2 + 0.35 || ang > -0.35) continue;
      const v = canvas.top[y * canvas.w + x] + canvas.under[y * canvas.w + x];
      if (d > r + 4.7 && d < r + 8) outside += v;
      if (d < r - 4.7 && d > r - 8) inside += v;
    }
  }
  assert.ok(outside > inside * 1.3, `outside ${outside.toFixed(0)} vs inside ${inside.toFixed(0)}`);
});

test('pressure profile: a comma mark is narrow at both ends and full in the middle', () => {
  const m = mark(8, 30, { pressure: [0.2, 1, 1, 1, 0.2] });
  conserved(m);
  const mid = widthAt(m.canvas, 25), head = widthAt(m.canvas, 11), prof = contactProfile({ points: [], gapMm: 0, seed: 0, pressure: [0.2, 1, 1, 1, 0.2] }, 30, 5);
  assert.ok(head < mid * 0.6, `head ${head.toFixed(1)} vs middle ${mid.toFixed(1)}`);
  assert.deepEqual(prof.map((v) => +v.toFixed(2)), [0.36, 1, 1, 1, 0.36]);
});

test('deposition: locked is the default and paints exactly as before', () => {
  const a = mark(10, 30), b = mark(10, 30, { deposition: 'locked', attackDeg: 70, speed: 3 });
  assert.equal(fingerprint(a.canvas), fingerprint(b.canvas));
});

test('streaked load: colours across the blade land on their own side, and paint is conserved', () => {
  const DARK = [0.15, 0.1, 0.1] as const, LIGHT = [0.95, 0.9, 0.85] as const;
  const canvas = new PaintCanvas(60, 40, 0.1, GROUND, 3);
  const tool = new Tool({ kind: 'knife', widthMm: 10, nodes: 120, seed: 7 });
  tool.loadProfile(6 * yieldVolume('knife', tool.pitch, 40), [DARK, DARK, LIGHT, LIGHT, LIGHT], CREAM, 0.12, 0.3, 5);
  paintStroke(canvas, tool, { points: [[10, 20], [23, 20], [37, 20], [50, 20]], gapMm: 0.45, seed: 99, deposition: 'physical' });
  const held = canvas.totalVolume() + canvas.lost + tool.residual() + tool.wiped;
  assert.ok(Math.abs(tool.loaded - held) / tool.loaded < 1e-9, 'volume conserved');
  // Travelling +x, node 0 is at -y: the dark end is the upper side (smaller y).
  const lightness = (y0: number, y1: number) => {
    let s = 0, n = 0;
    for (let y = Math.round(y0 / 0.1); y < Math.round(y1 / 0.1); y++) for (let x = 200; x < 400; x++) {
      const c = y * canvas.w + x;
      if (canvas.top[c] > 0.05) { s += canvas.topP[c * 3] / canvas.top[c]; n++; }
    }
    return s / Math.max(1, n);
  };
  const upper = lightness(16, 18.5), lower = lightness(21.5, 24);
  assert.ok(upper > lower * 1.3, `K/S upper ${upper.toFixed(3)} vs lower ${lower.toFixed(3)} (higher is darker)`);
});
