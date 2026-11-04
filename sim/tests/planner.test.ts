import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { DEFAULT_SETTINGS, FAMILIES, labToLinear, Planner, planPainting, scaleLayers, type PlannedStroke, type PlanSettings } from '../src/planner.ts';
import { directionAt, directionField, gaussBlur, makeGrid, sample, toOklab, type RgbImage } from '../src/image.ts';
import { canvasColour, paintStrokes, startPainting } from '../src/execute.ts';
import { clearance, regionsAtScale } from '../src/forms.ts';
import { srgbToLinear } from '../src/pigment.ts';

/** A small synthetic landscape: sky gradient, a dark peak, a lake band and a thin vertical tree. */
function landscape(w = 240, h = 120, treeW = 6): RgbImage {
  const data = new Uint8Array(w * h * 3);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const t = y / h;
    let c = [150 + 60 * t, 190 + 40 * t, 235];                     // sky
    const peak = 30 + Math.abs(x - 90) * 0.9;                       // a triangular mountain
    if (y > peak && y < 70) c = [95, 100, 115];
    if (y >= 70) c = [40, 170, 190];                                // lake
    if (y >= 100) c = [140, 120, 95];                               // shore
    if (x >= 170 && x < 170 + treeW && y > 25 && y < 105) c = [30, 70, 40]; // tree
    data.set(c.map((v) => Math.max(0, Math.min(255, Math.round(v)))), (y * w + x) * 3);
  }
  return { w, h, data };
}

const SMALL: Partial<PlanSettings> = { widthMm: 120, layers: scaleLayers(DEFAULT_SETTINGS.layers, 0.6), analysisMm: 0.5 };
const digest = (o: unknown) => createHash('sha256').update(JSON.stringify(o)).digest('hex');

test('planner: same image, settings and seed give an identical plan; a new seed differs', () => {
  const img = landscape();
  const a = planPainting(img, { ...SMALL, seed: 3 }), b = planPainting(img, { ...SMALL, seed: 3 }), c = planPainting(img, { ...SMALL, seed: 4 });
  assert.equal(digest(a), digest(b));
  assert.notEqual(digest(a), digest(c));
  assert.ok(a.strokes.length > 40, `only ${a.strokes.length} strokes`);
});

test('planner: large strokes first, small strokes last, and every stroke is paintable', () => {
  const plan = planPainting(landscape(), SMALL);
  let prevLayer = 0, prevWidth = Infinity;
  for (const st of plan.strokes) {
    assert.ok(st.layer >= prevLayer, 'layers are in order');
    assert.ok(st.widthMm <= prevWidth, 'widths never grow');
    prevLayer = st.layer; prevWidth = st.widthMm;
    const L = SMALL.layers![st.layer];
    // The knife's physical floor: shorter strokes deposit almost nothing.
    assert.ok(st.lengthMm >= L.minLenMm * 0.98, `stroke ${st.index} is ${st.lengthMm.toFixed(1)} mm, below ${L.minLenMm}`);
    assert.ok(st.points.length >= 2 && st.volumePerNode > 0 && st.gapMm > 0);
    for (const c of [...st.primary, ...st.secondary]) assert.ok(c >= 0 && c <= 1);
    for (const [x, y] of st.footprint) assert.ok(x > -L.widthMm && y > -L.widthMm && x < plan.widthMm + L.widthMm && y < plan.heightMm + L.widthMm);
  }
  assert.deepEqual(plan.counts.reduce((a, b) => a + b, 0), plan.strokes.length);
  assert.ok(plan.counts[plan.counts.length - 1] > 0, 'the finest layer adds strokes');
});

test('planner: each layer brings the canvas closer to the image', () => {
  const img = landscape();
  const s = { ...DEFAULT_SETTINGS, ...SMALL };
  const p = new Planner(img, s);
  const ref = p.lab;
  const err = () => {
    const cur = toOklab(p.current);
    let e = 0;
    for (let i = 0; i < p.gw * p.gh; i++) {
      const d0 = cur.data[i * 3] - ref.data[i * 3], d1 = cur.data[i * 3 + 1] - ref.data[i * 3 + 1], d2 = cur.data[i * 3 + 2] - ref.data[i * 3 + 2];
      e += Math.sqrt(d0 * d0 + d1 * d1 + d2 * d2);
    }
    return e / (p.gw * p.gh);
  };
  const errors = [err()];
  for (let l = 0; l < s.layers.length; l++) { p.planLayer(l); errors.push(err()); }
  for (let l = 1; l < errors.length; l++) assert.ok(errors[l] <= errors[l - 1] + 1e-9, `layer ${l - 1} made it worse: ${errors.map((e) => e.toFixed(4))}`);
  assert.ok(errors[errors.length - 1] < errors[1] * 0.8, `fine layers barely helped: ${errors.map((e) => e.toFixed(4))}`);
  assert.ok(errors[errors.length - 1] < 0.06, `mean OKLab error ${errors[errors.length - 1].toFixed(4)}`);
});

test('planner: the thin tree gets narrow vertical strokes in its own colour', () => {
  const plan = planPainting(landscape(), SMALL);
  const mmPerPx = 120 / 240, tree = { x0: 170 * mmPerPx, x1: 176 * mmPerPx, y0: 25 * mmPerPx, y1: 105 * mmPerPx };
  const darkGreen = plan.strokes.filter((st) => {
    const mid = st.footprint[Math.floor(st.footprint.length / 2)];
    // Dark green like the tree (30, 70, 40). A stroke that also carried the lake beside it turns blue.
    const ok = st.primary[1] < 0.4 && st.primary[1] > st.primary[2] + 0.04 && st.primary[1] > st.primary[0];
    return mid[0] > tree.x0 - 1 && mid[0] < tree.x1 + 1 && mid[1] > tree.y0 && mid[1] < tree.y1 && ok;
  });
  assert.ok(darkGreen.length >= 2, `${darkGreen.length} tree strokes`);
  for (const st of darkGreen) {
    const a = st.footprint[0], b = st.footprint[st.footprint.length - 1];
    const dx = b[0] - a[0], dy = b[1] - a[1];
    assert.ok(Math.abs(dy) > 2.5 * Math.abs(dx), `tree stroke ${st.index} runs at (${dx.toFixed(1)}, ${dy.toFixed(1)})`);
  }
});

test('planner: a sapling thinner than any knife still gets painted in its own colour', () => {
  // Close to the sapling's colour (30, 70, 40); a stroke that let the lake beside it in would be
  // much bluer and lighter (the lake is 40, 170, 190), around 85 away or more.
  const closerToTree = (c: readonly number[]) => Math.hypot(c[0] * 255 - 30, c[1] * 255 - 70, c[2] * 255 - 40) < 70;
  // 1 mm wide: narrower than the finest blade (1.44 mm here), so the stroke must trust its centreline.
  const plan = planPainting(landscape(240, 120, 2), SMALL);
  const hits = plan.strokes.filter((st) => {
    const mid = st.footprint[Math.floor(st.footprint.length / 2)];
    const a = st.footprint[0], b = st.footprint[st.footprint.length - 1];
    const vertical = Math.abs(b[1] - a[1]) > 2.5 * Math.abs(b[0] - a[0]);
    return vertical && mid[0] > 84.5 && mid[0] < 86.5 && mid[1] > 14 && mid[1] < 52 && closerToTree(st.primary);
  });
  assert.ok(hits.length >= 1, `${hits.length} sapling strokes`);
});

test('planner: detail strokes never smear across a colour edge', () => {
  const img = landscape();
  const s = { ...DEFAULT_SETTINGS, ...SMALL };
  const plan = planPainting(img, s);
  const p = new Planner(img, s);
  let checked = 0;
  for (const st of plan.strokes) {
    const L = s.layers[st.layer];
    // Coverage layers may cross edges; contour strokes hug one by design (blade edge on the silhouette).
    if (L.threshold <= 0 || L.kind === 'contour') continue;
    // The reference this layer was planned against, sampled along the stroke's centreline.
    const ref = toOklab(gaussBlur(p.lin, L.blur * L.widthMm / s.analysisMm));
    const lab = toOklab((() => { const g = makeGrid(1, 1, 3); g.data.set(st.primary.map(srgbToLinear)); return g; })()).data;
    // Undo the chroma boost to compare like with like.
    lab[1] /= s.chroma; lab[2] /= s.chroma;
    let worst = 0;
    for (const [x, y] of st.footprint) {
      const gx = x / s.analysisMm - 0.5, gy = y / s.analysisMm - 0.5; // grid samples are cell-centred
      const d = Math.hypot(sample(ref, gx, gy, 0) - lab[0], sample(ref, gx, gy, 1) - lab[1], sample(ref, gx, gy, 2) - lab[2]);
      worst = Math.max(worst, d);
    }
    // The centreline may drift by the loose tolerance below the minimum length; never by a whole edge.
    assert.ok(worst < L.tolerance * 2.6, `stroke ${st.index} (${L.name}) crosses an edge: ${worst.toFixed(3)}`);
    checked++;
    if (checked > 400) break;
  }
  assert.ok(checked > 30);
  assert.ok(plan.stats.some((st) => st.tooShort > 0), 'some seeds are refused as too short');
});

/** Analysis cells covered by these strokes' footprints (knife-ended capsules). */
function coverage(strokes: PlannedStroke[], w: number, h: number, cell: number, roundEnds = false): Uint8Array {
  const out = new Uint8Array(w * h);
  for (const st of strokes) {
    const r = st.widthMm / 2 / cell, pts = st.footprint.map(([x, y]) => [x / cell, y / cell]);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const cx = x + 0.5, cy = y + 0.5;
      for (let i = 0; i < pts.length - 1; i++) {
        const [ax, ay] = pts[i], [bx, by] = pts[i + 1], vx = bx - ax, vy = by - ay, l2 = vx * vx + vy * vy;
        let t = l2 > 0 ? ((cx - ax) * vx + (cy - ay) * vy) / l2 : 0;
        if (!roundEnds && ((i === 0 && t < 0) || (i === pts.length - 2 && t > 1))) continue;
        t = Math.max(0, Math.min(1, t));
        if (Math.hypot(ax + vx * t - cx, ay + vy * t - cy) <= r) { out[y * w + x] = 1; break; }
      }
    }
  }
  return out;
}

test('planner: the underpainting leaves no bare canvas', () => {
  const plan = planPainting(landscape(), SMALL);
  const cell = SMALL.analysisMm!, w = Math.round(plan.widthMm / cell), h = Math.round(plan.heightMm / cell);
  // The underpainting is a bristle brush, whose footprint has round ends.
  const cov = coverage(plan.strokes.filter((st) => st.layer === 0), w, h, cell, true);
  let bare = 0;
  for (const c of cov) bare += c ^ 1;
  assert.equal(bare, 0, `${bare} bare cells`);
});

test('planner: each colour family has its own knife, so residue never crosses families', () => {
  const plan = planPainting(landscape(), SMALL);
  assert.equal(plan.tools.length, SMALL.layers!.length * FAMILIES);
  const lake = plan.strokes.filter((st) => st.primary[2] > st.primary[0] + 0.25);   // cyan
  const shore = plan.strokes.filter((st) => st.primary[0] > st.primary[2] + 0.08); // warm brown
  assert.ok(lake.length > 5 && shore.length > 5);
  const lakeTools = new Set(lake.map((st) => st.tool));
  for (const st of shore) assert.ok(!lakeTools.has(st.tool), `shore stroke ${st.index} shares a knife with the lake`);
  // Pale sky and turquoise lake share a hue but not a knife.
  const sky = plan.strokes.filter((st) => st.primary[0] > 0.55 && st.primary[2] > 0.85);
  const deepLake = plan.strokes.filter((st) => st.primary[0] < 0.35 && st.primary[2] > st.primary[0] + 0.3);
  assert.ok(sky.length > 5 && deepLake.length > 5, `${sky.length} sky, ${deepLake.length} lake strokes`);
  const deepTools = new Set(deepLake.map((st) => st.tool));
  for (const st of sky) assert.ok(!deepTools.has(st.tool), `sky stroke ${st.index} shares a knife with the lake`);
  for (const st of plan.strokes) assert.equal(plan.tools[st.tool].widthMm, st.widthMm);
});

test('planner: where strokes overlap, the one that matches the image better goes on top', () => {
  const img = landscape(), s = { ...DEFAULT_SETTINGS, ...SMALL };
  const plan = planPainting(img, s);
  const p = new Planner(img, s), ref = p.lab, cell = s.analysisMm, w = p.gw, h = p.gh;
  const labOf = (c: readonly number[]) => {
    const g = makeGrid(1, 1, 3); g.data.set(c.map(srgbToLinear));
    const l = toOklab(g).data; l[1] /= s.chroma; l[2] /= s.chroma; return l;
  };
  // Over all overlapping pairs in each layer, weighted by shared area: is the later stroke the
  // better match for the photo where they overlap?
  let shared = 0, laterBetter = 0;
  for (let l = 1; l < plan.counts.length; l++) {
    const layer = plan.strokes.filter((st) => st.layer === l);
    const cov = layer.map((st) => coverage([st], w, h, cell)), lab = layer.map((st) => labOf(st.primary));
    for (let a = 0; a < layer.length; a++) for (let b = a + 1; b < layer.length; b++) {
      let ea = 0, eb = 0, n = 0;
      for (let i = 0; i < w * h; i++) {
        if (!(cov[a][i] & cov[b][i])) continue;
        n++;
        ea += Math.hypot(ref.data[i * 3] - lab[a][0], ref.data[i * 3 + 1] - lab[a][1], ref.data[i * 3 + 2] - lab[a][2]);
        eb += Math.hypot(ref.data[i * 3] - lab[b][0], ref.data[i * 3 + 1] - lab[b][1], ref.data[i * 3 + 2] - lab[b][2]);
      }
      if (n < 3 || Math.abs(ea - eb) < 0.02 * n) continue;
      shared += n;
      // Strokes are listed in painting order, so b is painted after a.
      if (eb < ea) laterBetter += n;
    }
  }
  assert.ok(shared > 200, `only ${shared} shared cells`);
  assert.ok(laterBetter > shared * 0.7, `later stroke matches better over ${laterBetter} of ${shared} shared cells`);
});

test('painting maps: silhouettes on the ridge and the tree, flat sky, more relief where the forms are', () => {
  const p = new Planner(landscape(), { ...DEFAULT_SETTINGS, ...SMALL });
  const { w } = p.maps, at = (m: Float64Array, xPx: number, yPx: number) => m[Math.floor(yPx * 120 / 240 / 0.5) * w + Math.floor(xPx * 120 / 240 / 0.5)];
  // The mountain's left flank crosses y = 50 at x = 90 - 20 / 0.9; the tree's edge is at x = 170.
  assert.ok(at(p.maps.silhouette, 90 - 20 / 0.9, 50) > 0.5, 'ridge');
  assert.ok(at(p.maps.silhouette, 170, 60) > 0.5, 'tree edge');
  assert.ok(at(p.maps.silhouette, 40, 10) < 0.05, 'open sky');
  assert.ok(at(p.maps.flat, 40, 10) > 0.8 && at(p.maps.flat, 120, 85) > 0.8, 'sky and lake are flat');
  assert.ok(at(p.maps.relief, 172, 60) > at(p.maps.relief, 40, 10) + 0.3, 'more relief on the tree than in the sky');
});

test('primitives: flat areas get thin quiet strokes, structured ones thicker; the look sets the edge profile', () => {
  const plan = planPainting(landscape(), SMALL), oil = planPainting(landscape(), { ...SMALL, look: 'oil', underTone: 0 });
  const knives = plan.strokes.filter((st) => st.primitive !== 'underpaint');
  const kinds = new Set(knives.map((st) => st.primitive));
  for (const k of ['plane', 'mark', 'contour'] as const) assert.ok(kinds.has(k), `no ${k} strokes`);
  // Sky (top band, above the peak at 15 mm) against everything else.
  const inSky = (st: PlannedStroke) => { const m = st.footprint[Math.floor(st.footprint.length / 2)]; return m[1] < 10 && st.footprint.every(([, y]) => y < 13); };
  const sky = knives.filter(inSky), rest = knives.filter((st) => !inSky(st) && st.primitive !== 'sweep');
  assert.ok(sky.length >= 2, `${sky.length} sky strokes`);
  const mean = (a: PlannedStroke[], f: (st: PlannedStroke) => number) => a.reduce((s, st) => s + f(st), 0) / a.length;
  assert.ok(mean(sky, (st) => st.heap) < mean(rest, (st) => st.heap) * 0.7, 'sky heaps are smaller');
  assert.ok(mean(sky, (st) => st.gapMm / SMALL.layers![st.layer].gapMm) < mean(rest, (st) => st.gapMm / SMALL.layers![st.layer].gapMm), 'sky paint is thinner');
  for (const st of plan.strokes) assert.equal(st.edgeFlaws, 1);
  assert.ok(oil.strokes.some((st) => st.edgeFlaws < 0.5));
  // Untoned, the look changes the paint and not where it goes. (A toned underpainting changes what
  // the later layers see, and so the plan.)
  assert.deepEqual(oil.strokes.map((st) => st.points), plan.strokes.map((st) => st.points), 'the look does not change the plan');
});

test('strokes: curved paths, varying pressure and width, and physical deposition in the oil look', () => {
  // A smooth ring: its edge curves continuously, so marks along it should bend.
  const w = 240, h = 120, data = new Uint8Array(w * h * 3);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const d = Math.hypot(x - 120, y - 60), v = d > 30 && d < 42 ? [40, 90, 60] : [200, 205, 190];
    data.set(v, (y * w + x) * 3);
  }
  const plan = planPainting({ w, h, data }, { ...SMALL, look: 'oil' });
  const knives = plan.strokes.filter((st) => st.primitive !== 'underpaint');
  const turn = (st: PlannedStroke) => {
    const f = st.footprint; let t = 0;
    for (let i = 2; i < f.length; i++) {
      const ax = f[i - 1][0] - f[i - 2][0], ay = f[i - 1][1] - f[i - 2][1], bx = f[i][0] - f[i - 1][0], by = f[i][1] - f[i - 1][1];
      t += Math.acos(Math.max(-1, Math.min(1, (ax * bx + ay * by) / (Math.hypot(ax, ay) * Math.hypot(bx, by) || 1))));
    }
    return t * 180 / Math.PI;
  };
  const curved = knives.filter((st) => turn(st) > 20);
  assert.ok(curved.length > knives.length * 0.25, `${curved.length} of ${knives.length} strokes turn more than 20 degrees`);
  // No tighter than the knife's minimum turning radius: at most about STEP/MIN_RADIUS per quarter blade.
  for (const st of knives) assert.ok(turn(st) < 120, `stroke ${st.index} turns ${turn(st).toFixed(0)} degrees`);
  const varied = knives.filter((st) => Math.max(...st.pressure) - Math.min(...st.pressure) > 0.4);
  assert.ok(varied.length > knives.length * 0.5, `${varied.length} of ${knives.length} strokes vary in pressure`);
  for (const st of knives) { assert.equal(st.deposition, 'physical'); assert.equal(st.heap, 1); }
  const locked = planPainting({ w, h, data }, SMALL);
  for (const st of locked.strokes) assert.equal(st.deposition, 'locked');
});

test('direction field follows a straight edge and falls back to horizontal on flat colour', () => {
  // A diagonal edge at about 30 degrees from horizontal, then flat colour.
  const w = 120, h = 80, data = new Uint8Array(w * h * 3);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const v = x < 60 ? (y > 20 + x * 0.577 ? 200 : 40) : 128;
    data.set([v, v, v], (y * w + x) * 3);
  }
  const lin = makeGrid(w, h, 3);
  for (let i = 0; i < w * h; i++) for (let k = 0; k < 3; k++) lin.data[i * 3 + k] = srgbToLinear(data[i * 3 + k] / 255);
  const field = directionField(toOklab(lin), 3, [1, 0], 0.12);
  const d = new Float64Array(2);
  directionAt(field, 30, 20 + 30 * 0.577, 1, 0, d);
  assert.ok(d[0] * 0.866 + d[1] * 0.5 > 0.97, `edge direction (${d[0].toFixed(3)}, ${d[1].toFixed(3)})`);
  directionAt(field, 95, 40, 1, 0, d);
  assert.ok(d[0] > 0.999, `flat direction (${d[0].toFixed(3)}, ${d[1].toFixed(3)})`);
});

test('OKLab round trip is accurate', () => {
  const lin = makeGrid(1, 1, 3);
  for (const c of [[0.02, 0.5, 0.9], [0.8, 0.1, 0.3], [0.5, 0.5, 0.5]]) {
    lin.data.set(c);
    const back = labToLinear(toOklab(lin).data);
    for (let k = 0; k < 3; k++) assert.ok(Math.abs(back[k] - c[k]) < 1e-4, `${c} -> ${back}`);
  }
});

test('a plan paints through the simulation deterministically and conserves paint', () => {
  const img = landscape(120, 60);
  const settings: Partial<PlanSettings> = { widthMm: 60, layers: scaleLayers(DEFAULT_SETTINGS.layers.slice(0, 3), 0.5), analysisMm: 0.5, seed: 9 };
  const run = () => {
    let painting = null as ReturnType<typeof startPainting> | null;
    const plan = planPainting(img, settings, (layer, strokes, estimate, partial) => {
      painting ??= startPainting(partial, DEFAULT_SETTINGS.ground);
      paintStrokes(painting, strokes);
      return canvasColour(painting.canvas, estimate.w, estimate.h);
    });
    return { plan, painting: painting! };
  };
  const a = run(), b = run();
  const fp = (c: typeof a.painting.canvas) => createHash('sha256').update(Buffer.from(c.top.buffer)).update(Buffer.from(c.under.buffer)).update(Buffer.from(c.topP.buffer)).digest('hex');
  assert.equal(digest(a.plan), digest(b.plan));
  assert.equal(fp(a.painting.canvas), fp(b.painting.canvas));
  const { canvas, tools } = a.painting;
  let loaded = 0, held = canvas.totalVolume() + canvas.lost;
  for (const t of tools) { loaded += t.loaded; held += t.residual() + t.wiped; }
  assert.ok(Math.abs(loaded - held) / loaded < 1e-9, `volume ${loaded} vs ${held}`);
});

test('planner and analysis code avoid engine-dependent math', () => {
  for (const f of ['planner.ts', 'image.ts', 'structure.ts', 'execute.ts', 'tool.ts', 'canvas.ts', 'relight.ts', 'pigment.ts', 'dmath.ts']) {
    const src = readFileSync(new URL(`../src/${f}`, import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    const bad = src.match(/Math\.(sin|cos|tan|atan2?|asin|acos|pow|exp|log\w*|cbrt|random|hypot|tanh)\b/g);
    assert.equal(bad, null, `${f} uses ${bad}`);
    // The exponent operator has Math.pow's engine-dependent rounding too.
    assert.equal(src.match(/[\w)\]]\s*\*\*\s*[\w(]/g), null, `${f} uses **`);
  }
});

/** A pale ground with an upright dark-red ellipse in the middle, 15 x 25 mm at 120 mm wide. */
function figure(w = 240, h = 160): RgbImage {
  const data = new Uint8Array(w * h * 3);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const ex = (x - 120) / 15, ey = (y - 80) / 25, inside = ex * ex + ey * ey < 1;
    data.set(inside ? [120, 30, 35] : [205 + Math.round(10 * y / h), 210, 220], (y * w + x) * 3);
  }
  return { w, h, data };
}

test('forms: nested shapes; broad knives stay out of a shape they do not fit and paint shapes along their axis', () => {
  const img = figure(), planner = new Planner(img, { ...DEFAULT_SETTINGS, ...SMALL });
  const [coarse, mid, fine] = planner.forms.levels;
  assert.ok(coarse.count <= mid.count && mid.count <= fine.count, `${coarse.count} ${mid.count} ${fine.count}`);
  // Nested: every fine shape lies inside one middle shape.
  const parent = new Map<number, number>();
  for (let i = 0; i < fine.label.length; i++) {
    const p = parent.get(fine.label[i]);
    if (p === undefined) parent.set(fine.label[i], mid.label[i]); else assert.equal(p, mid.label[i]);
  }
  // At a blade's scale: the figure binds a narrow blade (a core, with room for it) and binds nothing
  // for a blade much wider than itself (freed); a faint ripple in the ground binds neither.
  const centre = 80 * 240 + 120, W3 = 3 / 0.5, W40 = 40 / 0.5;
  let checked = 0;
  for (const L of planner.forms.levels) {
    const r3 = regionsAtScale(L, 240, 160, 0.06, 1.5 * W3 * W3, 0.3 * W3), r40 = regionsAtScale(L, 240, 160, 0.06, 1.5 * W40 * W40, 0.3 * W40);
    if (L.label[centre] === L.label[0]) continue; // a level too coarse to hold the figure
    assert.ok(r3.label[centre] >= 0 && clearance(r3, centre, r3.label[centre]) > 0.3 * W3, 'the figure is a core for a 3 mm blade');
    assert.ok(r40.label[centre] < 0 || r40.label[centre] === r40.label[0], 'a 40 mm blade is not bound by the figure');
    const ground = new Set<number>();
    for (let y = 0; y < 160; y += 4) for (let x = 0; x < 60; x += 4) ground.add(r3.label[y * 240 + x]);
    assert.equal(ground.size, 1, 'the ground, 10 levels of grey from top to bottom, is one shape');
    checked++;
  }
  assert.ok(checked >= 2, `the figure is its own shape at ${checked} levels`);
  const plan = planPainting(img, SMALL);
  const inEllipse = (x: number, y: number, grow: number) => { const ex = (x / 0.5 - 120) / (15 + grow), ey = (y / 0.5 - 80) / (25 + grow); return ex * ex + ey * ey < 1; };
  let intruding = 0, figureStrokes = 0, vertical = 0;
  for (const st of plan.strokes) {
    if (st.primitive === 'underpaint' || st.primitive === 'contour') continue;
    const red = st.primary[0] > st.primary[2] + 0.15;
    if (!red && st.footprint.some(([x, y]) => inEllipse(x, y, -3))) intruding++;
    if (red && st.footprint.every(([x, y]) => inEllipse(x, y, 2))) {
      figureStrokes++;
      const [ax, ay] = st.footprint[0], [bx, by] = st.footprint[st.footprint.length - 1];
      if (Math.abs(by - ay) > Math.abs(bx - ax)) vertical++;
    }
  }
  assert.equal(intruding, 0, 'ground strokes running through the figure');
  assert.ok(figureStrokes >= 3, `${figureStrokes} figure strokes`);
  // A flat upright shape has no edges inside to follow; its strokes follow its long axis.
  assert.ok(vertical >= figureStrokes * 0.6, `${vertical} of ${figureStrokes} figure strokes run along its axis`);
});

test('pigment: under the oil look, knives carry the colours across their path; the underpainting is toned', () => {
  const img = figure();
  const plain = planPainting(img, { ...SMALL, look: 'oil', streaks: false }), oil = planPainting(img, { ...SMALL, look: 'oil' });
  assert.ok(plain.strokes.every((st) => !st.profile));
  const knives = oil.strokes.filter((st) => st.primitive !== 'underpaint');
  assert.ok(knives.every((st) => st.profile && st.profile.length === 5 && st.mix! >= 0 && st.mix! <= 1));
  // A stroke along the figure's edge has its two blade ends in different colours.
  const spread = knives.map((st) => Math.abs(st.profile![0][0] - st.profile![4][0]) + Math.abs(st.profile![0][2] - st.profile![4][2]));
  assert.ok(spread.some((d) => d > 0.08), `largest end-to-end difference ${Math.max(...spread).toFixed(3)}`);
  const under = oil.strokes.filter((st) => st.primitive === 'underpaint'), locked = planPainting(img, SMALL).strokes.filter((st) => st.primitive === 'underpaint');
  const lum = (s: PlannedStroke[]) => s.reduce((a, st) => a + st.primary[0] + st.primary[1] + st.primary[2], 0) / s.length;
  assert.ok(lum(under) < lum(locked) - 0.1, `toned ${lum(under).toFixed(2)} vs ${lum(locked).toFixed(2)}`);
});
