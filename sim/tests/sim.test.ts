import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { PaintCanvas } from '../src/canvas.ts';
import { paintStroke, Tool } from '../src/tool.ts';
import { albedoField, clearcoatRoughness, DEFAULT_LIGHT, relight, surfaceField } from '../src/relight.ts';
import { reflectanceFromKs, srgbToLinear } from '../src/pigment.ts';
import { oneStrokeScene, patchScene } from './scenes.ts';
import { featureRatios } from './depth-metrics.ts';

const GROUND = [0.58, 0.47, 0.37] as const;
const RED = [0.85, 0.2, 0.15] as const, CREAM = [0.95, 0.9, 0.75] as const, BLUE = [0.1, 0.3, 0.6] as const;

function ledger(canvas: PaintCanvas, tools: Tool[]) {
  let loaded = 0, held = canvas.totalVolume() + canvas.lost;
  const pl = [0, 0, 0], ph = [...canvas.totalPigment()];
  for (let k = 0; k < 3; k++) ph[k] += canvas.lostP[k];
  for (const t of tools) {
    loaded += t.loaded; held += t.residual() + t.wiped;
    const r = t.residualPigment();
    for (let k = 0; k < 3; k++) { pl[k] += t.loadedP[k]; ph[k] += r[k] + t.wipedP[k]; }
  }
  return { loaded, held, pl, ph };
}
function assertConserved(canvas: PaintCanvas, tools: Tool[]) {
  const l = ledger(canvas, tools);
  assert.ok(Math.abs(l.loaded - l.held) / l.loaded < 1e-9, `volume ${l.loaded} vs ${l.held}`);
  for (let k = 0; k < 3; k++) assert.ok(Math.abs(l.pl[k] - l.ph[k]) / l.pl[k] < 1e-9, `pigment ${k}: ${l.pl[k]} vs ${l.ph[k]}`);
}
const fingerprint = (c: PaintCanvas) => createHash('sha256')
  .update(Buffer.from(c.top.buffer)).update(Buffer.from(c.under.buffer)).update(Buffer.from(c.topP.buffer)).update(Buffer.from(c.underP.buffer))
  .digest('hex');
const paintAt = (c: PaintCanvas, i: number) => c.top[i] + c.under[i];

function straightKnife(load = 19, gap = 1.1) {
  const canvas = new PaintCanvas(100, 50, 0.1, GROUND, 3);
  const tool = new Tool({ kind: 'knife', widthMm: 20, nodes: 128, seed: 7 });
  tool.load(load, RED, CREAM, 0.2, 5);
  const stats = paintStroke(canvas, tool, { points: [[10, 25], [35, 25], [60, 25], [85, 25]], gapMm: gap, seed: 99 });
  return { canvas, tool, stats };
}
/** Cross-section of paint thickness down the column at x mm. */
function column(c: PaintCanvas, xMm: number) {
  const x = Math.round(xMm / c.dx), out: number[] = [];
  for (let y = 0; y < c.h; y++) out.push(paintAt(c, y * c.w + x));
  return out;
}
const median = (a: number[]) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];

test('1. volume and pigment are conserved over every stroke in both scenes', () => {
  for (const scene of [oneStrokeScene(), patchScene()]) assertConserved(scene.canvas, scene.tools);
});

test('1. plowing: side berms stand above the sheared face', () => {
  const { canvas, stats } = straightKnife();
  assert.ok(stats.bermVolume > 0);
  let sidesHigher = 0, samples = 0;
  for (let x = 25; x <= 60; x += 5) {
    const col = column(canvas, x), painted = col.filter((h) => h > 0.1);
    const face = median(painted);
    const first = col.findIndex((h) => h > 0.1), last = col.length - 1 - [...col].reverse().findIndex((h) => h > 0.1);
    const edge = Math.max(...col.slice(first, first + 25), ...col.slice(last - 24, last + 1));
    samples++;
    if (edge > face * 1.25) sidesHigher++;
  }
  assert.ok(sidesHigher >= samples * 0.75, `berm above face at ${sidesHigher}/${samples} sections`);
});

test('1. plowing: lifting the tool leaves a terminal heap ahead of the tip', () => {
  const { canvas, stats } = straightKnife();
  assert.ok(stats.heapVolume > 0);
  const face = median(column(canvas, 40).filter((h) => h > 0.1));
  let tipPeak = 0;
  for (let x = 65; x <= 95; x += 0.1) tipPeak = Math.max(tipPeak, ...column(canvas, x).slice(120, 380));
  assert.ok(tipPeak > face * 1.5, `tip ${tipPeak.toFixed(2)} mm vs face ${face.toFixed(2)} mm`);
});

test('1. plowing: a tool pressed into a thick bed removes paint and conserves it', () => {
  const canvas = new PaintCanvas(100, 50, 0.1, GROUND, 3);
  const bed = new Tool({ kind: 'knife', widthMm: 34, nodes: 128, seed: 1 });
  bed.load(70, BLUE, BLUE, 0, 3);
  paintStroke(canvas, bed, { points: [[8, 25], [35, 25], [60, 25], [92, 25]], gapMm: 3.2, seed: 2 });
  const before = median(column(canvas, 50).slice(150, 350).filter((h) => h > 0.5));
  const tool = new Tool({ kind: 'knife', widthMm: 12, nodes: 96, seed: 4 });
  tool.load(1.2, RED, RED, 0, 6);
  const stats = paintStroke(canvas, tool, { points: [[50, 5], [50, 18], [50, 32], [50, 45]], gapMm: 0.2, pressMm: 1.6, seed: 5 });
  assert.ok(stats.plowedVolume > 10, `plowed ${stats.plowedVolume}`);
  const after = paintAt(canvas, 250 * canvas.w + 500);
  assert.ok(after < before * 0.8, `track ${after.toFixed(2)} vs bed ${before.toFixed(2)}`);
  assertConserved(canvas, [bed, tool]);
});

test('2. nodes start with unmixed primary and secondary bands', () => {
  const tool = new Tool({ kind: 'knife', widthMm: 20, nodes: 128, seed: 7 });
  assert.ok(tool.N >= 64 && tool.N <= 128);
  tool.load(10, RED, BLUE, 0.35, 5);
  const concentrations = new Set<string>();
  for (let i = 0; i < tool.N; i++) concentrations.add((tool.p[i * 3] / tool.v[i]).toFixed(8));
  assert.equal(concentrations.size, 2, 'every node holds exactly one of the two pigments');
});

test('2. pickup and deposition run both ways on wet paint', () => {
  const canvas = new PaintCanvas(100, 50, 0.1, GROUND, 3);
  const bed = new Tool({ kind: 'knife', widthMm: 34, nodes: 128, seed: 1 });
  bed.load(30, BLUE, BLUE, 0, 3);
  paintStroke(canvas, bed, { points: [[8, 25], [35, 25], [60, 25], [92, 25]], gapMm: 1.2, seed: 2 });
  const tool = new Tool({ kind: 'knife', widthMm: 12, nodes: 96, seed: 4 });
  tool.load(10, CREAM, CREAM, 0, 6);
  const creamKs = tool.p[0] / tool.v[0];
  const c = 250 * canvas.w + 500;
  const bedBefore = canvas.topP[c * 3] / canvas.top[c];
  paintStroke(canvas, tool, { points: [[50, 8], [50, 18], [50, 30], [50, 42]], gapMm: 0.3, seed: 5 });
  // Cream K/S is small and blue's red-channel K/S is large, so dirt raises the tool's value.
  let dirty = 0;
  for (let i = 0; i < tool.N; i++) if (tool.v[i] > 0 && tool.p[i * 3] / tool.v[i] > creamKs * 1.05) dirty++;
  assert.ok(dirty > tool.N * 0.5, `${dirty}/${tool.N} nodes picked up the bed colour`);
  assert.ok(canvas.topP[c * 3] / canvas.top[c] < bedBefore * 0.7, 'the tool left its own colour on the bed');
});

test('3. a starved tool deposits only on peaks and leaves valleys bare', () => {
  const canvas = new PaintCanvas(100, 50, 0.1, GROUND, 3);
  const tooth = canvas.tooth.slice();
  const tool = new Tool({ kind: 'knife', widthMm: 20, nodes: 128, seed: 7 });
  tool.load(0.42, RED, RED, 0, 5);
  const stats = paintStroke(canvas, tool, { points: [[10, 25], [35, 25], [60, 25], [85, 25]], gapMm: 1.0, seed: 99 });
  assert.ok(stats.stickCells > stats.wetCells, `stiction ${stats.stickCells}, wet ${stats.wetCells}`);
  assert.ok(stats.stickDeposited > 0 && stats.stickSkipped > 0);
  let hit = 0, hitAbove = 0, bare = 0, inside = 0;
  const r = 4;
  for (let y = 170; y < 330; y++) for (let x = 150; x < 700; x++) {
    const i = y * canvas.w + x, mean = (tooth[i - r] + tooth[i + r] + tooth[i - r * canvas.w] + tooth[i + r * canvas.w]) / 4;
    inside++;
    if (canvas.top[i] + canvas.under[i] > 0.015) { hit++; if (tooth[i] > mean) hitAbove++; } else bare++;
  }
  assert.ok(bare > inside * 0.15, `${(100 * bare / inside).toFixed(0)}% bare`);
  assert.ok(hitAbove / hit > 0.6, `${(100 * hitAbove / hit).toFixed(0)}% of paint sits on peaks`);
});

test('3. a fully loaded stroke breaks up toward its tail, not at its head', () => {
  const { canvas } = straightKnife(10);
  const coverage = (x0: number, x1: number) => {
    let hit = 0, all = 0;
    for (let x = x0; x < x1; x++) for (let y = 170; y < 330; y++) { all++; if (paintAt(canvas, y * canvas.w + x) > 0.05) hit++; }
    return hit / all;
  };
  const head = coverage(200, 350), tail = coverage(700, 820);
  assert.ok(head > 0.98, `head ${head.toFixed(2)}`);
  assert.ok(tail < head * 0.85, `tail ${tail.toFixed(2)} vs head ${head.toFixed(2)}`);
});

test('4. sheared faces carry GGX roughness 0.06-0.16', () => {
  const { canvas } = straightKnife();
  const S = surfaceField(canvas);
  let checked = 0, inRange = 0;
  for (let y = 180; y < 320; y++) for (let x = 250; x < 600; x++) {
    const i = y * canvas.w + x;
    if (paintAt(canvas, i) > 0.5 && Math.abs(S[i + 1] - S[i - 1]) < 0.1) { checked++; if (canvas.rough[i] >= 0.06 - 1e-6 && canvas.rough[i] <= 0.16 + 1e-6) inRange++; }
  }
  assert.ok(checked > 10000);
  assert.ok(inRange / checked > 0.995, `${(100 * inRange / checked).toFixed(2)}% in range`);
});

test('4. default occlusion is in 0.75-0.85 and sloped paint catches white glints', () => {
  assert.ok(DEFAULT_LIGHT.occlusion >= 0.75 && DEFAULT_LIGHT.occlusion <= 0.85);
  const scene = patchScene();
  const c = scene.canvas, px = relight(c, DEFAULT_LIGHT, 'paint');
  const S = surfaceField(c);
  let whiteSteep = 0, white = 0;
  for (let y = 2; y < c.h - 2; y++) for (let x = 2; x < c.w - 2; x++) {
    const i = y * c.w + x, r = px[i * 3], g = px[i * 3 + 1], b = px[i * 3 + 2];
    if (r > 240 && g > 235 && b > 220) {
      white++;
      const slope = Math.sqrt((S[i + 1] - S[i - 1]) ** 2 + (S[i + c.w] - S[i - c.w]) ** 2) / (2 * c.dx);
      if (slope > 0.25) whiteSteep++;
    }
  }
  assert.ok(white > c.n * 0.001, `${white} white pixels`);
  assert.ok(whiteSteep / white > 0.6, `${(100 * whiteSteep / white).toFixed(0)}% of glints on sloped paint`);
});

test('knife faces stay smooth at any angle, with texture left to edges and tail', () => {
  for (const slope of [0, 0.09, 0.55, 1]) {
    const c = new PaintCanvas(100, 90, 0.1, GROUND, 3);
    const t = new Tool({ kind: 'knife', widthMm: 20, nodes: 128, seed: 7 });
    t.load(24, BLUE, BLUE, 0, 5);
    const P = (u: number): [number, number] => [50 + (u - 0.5) * 70 / Math.sqrt(1 + slope * slope), 45 + (u - 0.5) * 70 * slope / Math.sqrt(1 + slope * slope)];
    paintStroke(c, t, { points: [P(0), P(1 / 3), P(2 / 3), P(1)], gapMm: 1.1, seed: 99 });
    const S = surfaceField(c), A = albedoField(c);
    let sum = 0, colour = 0, n = 0;
    for (let y = 425; y < 475; y++) for (let x = 450; x < 550; x++) {
      const i = y * c.w + x;
      sum += ((S[i + 1] - 2 * S[i] + S[i - 1]) / c.dx) ** 2 + ((S[i + c.w] - 2 * S[i] + S[i - c.w]) / c.dx) ** 2;
      colour += (A[i * 3] - A[(i + 1) * 3]) ** 2 + (A[i * 3] - A[(i + c.w) * 3]) ** 2;
      n++;
    }
    assert.ok(Math.sqrt(sum / n) < 0.02, `slope ${slope}: fine relief ${Math.sqrt(sum / n).toFixed(4)}`);
    assert.ok(Math.sqrt(colour / n) < 0.002, `slope ${slope}: colour hatching ${Math.sqrt(colour / n).toFixed(5)}`);
    // The sides of the same stroke keep their texture.
    let edgePeak = 0;
    for (let i = 0; i < c.n; i++) edgePeak = Math.max(edgePeak, c.top[i] + c.under[i]);
    assert.ok(edgePeak > 1.6, `edges ${edgePeak.toFixed(2)} mm`);
  }
});

test('colour streaks wander along the stroke and keep their contrast', () => {
  const c = new PaintCanvas(100, 50, 0.1, GROUND, 3);
  const t = new Tool({ kind: 'knife', widthMm: 22, nodes: 128, seed: 7 });
  t.load(22, RED, CREAM, 0.4, 5);
  paintStroke(c, t, { points: [[8, 25], [35, 25], [60, 25], [92, 25]], gapMm: 1.1, seed: 99 });
  assert.ok(Math.abs(c.totalVolume() + c.lost + t.residual() - t.loaded) / t.loaded < 1e-9);
  const A = albedoField(c);
  const profile = (x: number) => { const o: number[] = []; for (let y = 170; y < 330; y++) o.push(A[(y * c.w + x) * 3 + 2]); return o; };
  const mean = (a: number[]) => a.reduce((s, v) => s + v, 0) / a.length;
  const corr = (a: number[], b: number[]) => {
    const ma = mean(a), mb = mean(b);
    let n = 0, da = 0, db = 0;
    for (let i = 0; i < a.length; i++) { n += (a[i] - ma) * (b[i] - mb); da += (a[i] - ma) ** 2; db += (b[i] - mb) ** 2; }
    return n / Math.sqrt(da * db + 1e-12);
  };
  let far = 0, near = 0, spread = 0, k = 0;
  for (let x = 180; x + 200 <= 640; x += 20) {
    far += corr(profile(x), profile(x + 200)); near += corr(profile(x), profile(x + 4));
    const p = profile(x), m = mean(p); spread += Math.sqrt(mean(p.map((v) => (v - m) ** 2))); k++;
  }
  assert.ok(far / k < 0.9, `20 mm correlation ${(far / k).toFixed(3)}`);
  assert.ok(near / k > 0.9, `streaks stay continuous: ${(near / k).toFixed(3)}`);
  assert.ok(spread / k > 0.08, `contrast ${(spread / k).toFixed(3)}`);
});

test('high-curvature micro-facets use roughness 0.03-0.08 and glints are pin-pricks', () => {
  for (let x = 0; x < 300; x++) for (let y = 0; y < 300; y += 7) {
    const r = clearcoatRoughness(0.14, 2, x, y);
    assert.ok(r >= 0.03 && r <= 0.08, `${r}`);
  }
  assert.equal(clearcoatRoughness(0.14, 0.05, 3, 4), 0.14, 'flat faces keep their stored roughness');
  const { canvas: c } = patchScene();
  const spec = relight(c, DEFAULT_LIGHT, 'spec'), S = surfaceField(c);
  const seen = new Uint8Array(c.n), white = (i: number) => spec[i * 3] > 235;
  const sizes: number[] = [];
  let flatSum = 0, flat = 0;
  for (let y = 2; y < c.h - 2; y++) for (let x = 2; x < c.w - 2; x++) {
    const i = y * c.w + x;
    if (Math.sqrt((S[i + 1] - S[i - 1]) ** 2 + (S[i + c.w] - S[i - c.w]) ** 2) / (2 * c.dx) < 0.1) { flatSum += spec[i * 3]; flat++; }
    if (!white(i) || seen[i]) continue;
    const stack = [i]; seen[i] = 1; let size = 0;
    while (stack.length) { const a = stack.pop()!; size++; for (const b of [a - 1, a + 1, a - c.w, a + c.w]) if (b >= 0 && b < c.n && !seen[b] && white(b)) { seen[b] = 1; stack.push(b); } }
    sizes.push(size);
  }
  sizes.sort((a, b) => a - b);
  assert.ok(sizes.length > 1000, `${sizes.length} glints`);
  assert.ok(sizes[Math.floor(sizes.length * 0.95)] <= 6, `95th percentile ${sizes[Math.floor(sizes.length * 0.95)]} pixels`);
  assert.ok(flatSum / flat < 2.5, `flat sheen ${(flatSum / flat).toFixed(2)}`);
});

test('wet contacts relax into fillets while edges on bare canvas stay steep', () => {
  const steepest = (c: PaintCanvas, x: number, y0: number, y1: number) => {
    const S = surfaceField(c); let m = 0;
    for (let y = y0; y < y1; y++) { const i = y * c.w + x; m = Math.max(m, Math.abs(S[i + c.w] - S[i - c.w]) / (2 * c.dx)); }
    return m;
  };
  const stroke = (c: PaintCanvas) => {
    const t = new Tool({ kind: 'knife', widthMm: 18, nodes: 128, seed: 7 });
    t.load(22, CREAM, CREAM, 0, 5);
    paintStroke(c, t, { points: [[12, 35], [38, 35], [62, 35], [88, 35]], gapMm: 1.0, seed: 99 });
    return t;
  };
  const bare = new PaintCanvas(100, 70, 0.1, GROUND, 3);
  stroke(bare);
  const wet = new PaintCanvas(100, 70, 0.1, GROUND, 3);
  const bed = new Tool({ kind: 'knife', widthMm: 42, nodes: 128, seed: 21 });
  bed.load(40, BLUE, BLUE, 0, 3);
  paintStroke(wet, bed, { points: [[6, 35], [35, 35], [65, 35], [94, 35]], gapMm: 1.4, seed: 301 });
  const t = stroke(wet);
  assertConserved(wet, [bed, t]);
  let bareSum = 0, wetSum = 0, k = 0;
  for (let x = 300; x <= 620; x += 16) { bareSum += steepest(bare, x, 200, 290); wetSum += steepest(wet, x, 200, 290); k++; }
  assert.ok(bareSum / k > 2, `bare canvas edge ${(bareSum / k).toFixed(2)}`);
  assert.ok(wetSum / k < bareSum / k * 0.75, `wet ${(wetSum / k).toFixed(2)} vs bare ${(bareSum / k).toFixed(2)}`);
});

test('near-black stays rare and out of thin lines, and a tall undercut still casts a deep shadow', () => {
  const { canvas: c } = patchScene();
  const px = relight(c, DEFAULT_LIGHT, 'paint');
  let black = 0;
  for (let i = 0; i < c.n; i++) if (0.2126 * px[i * 3] + 0.7152 * px[i * 3 + 1] + 0.0722 * px[i * 3 + 2] < 45) black++;
  assert.ok(black / c.n < 0.01, `${(100 * black / c.n).toFixed(3)}% near black`);
  // A 5 mm wall on a flat layer. Light comes from the upper left, so the shadow falls to the lower right.
  const w = new PaintCanvas(60, 60, 0.1, GROUND, 3);
  const ks = 0.3;
  for (let y = 0; y < w.h; y++) for (let x = 0; x < w.w; x++) {
    const i = y * w.w + x, tall = x + y < 500;
    w.top[i] = 0.06; w.topP[i * 3] = w.topP[i * 3 + 1] = w.topP[i * 3 + 2] = 0.06 * ks;
    w.under[i] = tall ? 5 : 0.5; w.underP[i * 3] = w.underP[i * 3 + 1] = w.underP[i * 3 + 2] = w.under[i] * ks;
  }
  const lit = relight(w, DEFAULT_LIGHT, 'paint');
  const at = (x: number, y: number) => lit[(y * w.w + x) * 3];
  const open = at(520, 520), shadowed = at(280, 280);
  // Compare light, not encoded pixel values: bounce and fill still reach into the shadow.
  const linear = (v: number) => srgbToLinear(v / 255);
  assert.ok(linear(shadowed) < linear(open) * 0.5, `shadow ${linear(shadowed).toFixed(3)} vs open ${linear(open).toFixed(3)}`);
});

test('heaps are recut into crests: creased, not pillowy, and catching glints', () => {
  const { canvas: c, stats } = straightKnife();
  assert.ok(stats.heapVolume > 0);
  const S = surfaceField(c), spec = relight(c, DEFAULT_LIGHT, 'spec');
  const lap: number[] = [];
  let glints = 0;
  for (let y = 120; y < 380; y++) for (let x = 650; x < 960; x++) {
    const i = y * c.w + x;
    if (c.top[i] + c.under[i] < 1.4) continue;
    lap.push((S[i + 1] + S[i - 1] + S[i + c.w] + S[i - c.w] - 4 * S[i]) / (c.dx * c.dx));
    if (spec[i * 3] > 235) glints++;
  }
  const m = lap.reduce((s, v) => s + v, 0) / lap.length;
  let v2 = 0, v4 = 0;
  for (const v of lap) { v2 += (v - m) ** 2; v4 += (v - m) ** 4; }
  v2 /= lap.length; v4 /= lap.length;
  assert.ok(lap.length > 500, `${lap.length} thick cells`);
  assert.ok(v4 / (v2 * v2) > 6, `curvature kurtosis ${(v4 / (v2 * v2)).toFixed(1)}`);
  assert.ok(glints > 0, `${glints} glints on the heap`);
});

test('enclosed cavities go dark while shallow one-sided contours stay soft', () => {
  const f = featureRatios();
  assert.ok(f.grooveDarkest < 0.2, `groove ${f.grooveDarkest}`);
  assert.ok(f.tallLipDarkest < 0.2, `tall lip ${f.tallLipDarkest}`);
  assert.ok(f.shallowStepDarkest > 0.35, `shallow step ${f.shallowStepDarkest}`);
  assert.ok(f.shallowStepDarkest > f.grooveDarkest * 2.5, 'a contour must stay well above a crevice');
});

test('glints flash on wet crests; dry drag and bare canvas stay matte', () => {
  assert.equal(clearcoatRoughness(0.34, 2, 3, 4), 0.34, 'dry drag keeps its roughness');
  assert.equal(clearcoatRoughness(0.62, 2, 3, 4), 0.62, 'canvas keeps its roughness');
  const { canvas: c } = oneStrokeScene();
  const spec = relight(c, DEFAULT_LIGHT, 'spec');
  let bare = 0, onPaint = 0;
  for (let i = 0; i < c.n; i++) {
    if (spec[i * 3] <= 235) continue;
    if (c.top[i] + c.under[i] < 0.005) bare++; else onPaint++;
  }
  assert.ok(onPaint > 300, `${onPaint} glints on paint`);
  assert.ok(bare < onPaint * 0.01, `${bare} glints on bare canvas`);
});

test('the glow stays local, leaves open paint alone and can be turned off', () => {
  const { canvas: c } = oneStrokeScene();
  const on = relight(c, DEFAULT_LIGHT, 'paint'), off = relight(c, { ...DEFAULT_LIGHT, glow: 0 }, 'paint');
  const glow = relight(c, DEFAULT_LIGHT, 'glow'), spec = relight(c, { ...DEFAULT_LIGHT, glow: 0 }, 'spec');
  let glowing = 0, far = 0;
  const R = 7;
  // Any pixel with glow must have a pixel above display white within the kernel radius.
  const hot = new Uint8Array(c.n);
  for (let i = 0; i < c.n; i++) if (spec[i * 3] >= 254) hot[i] = 1;
  for (let y = R; y < c.h - R; y += 2) for (let x = R; x < c.w - R; x += 2) {
    const i = y * c.w + x;
    if (glow[i * 3] === 0) continue;
    glowing++;
    let found = false;
    for (let b = -R; b <= R && !found; b++) for (let a = -R; a <= R && !found; a++) if (hot[i + a + b * c.w]) found = true;
    if (!found) far++;
  }
  assert.ok(glowing > 0, 'some glow exists');
  assert.equal(far, 0, 'glow never appears away from a highlight');
  let changed = 0;
  for (let i = 0; i < c.n * 3; i++) if (on[i] !== off[i]) changed++;
  assert.ok(changed > 0, 'glow changes the image');
  assert.ok(changed / (c.n * 3) < 0.25, `${(100 * changed / (c.n * 3)).toFixed(1)}% of channels changed`);
  const none = relight(c, { ...DEFAULT_LIGHT, glow: 0 }, 'glow');
  assert.ok(none.every((v) => v === 0), 'glow 0 produces nothing');
});

test('the whole image does not clip', () => {
  const { canvas: c } = patchScene();
  const px = relight(c, DEFAULT_LIGHT, 'paint');
  let clipped = 0;
  for (let i = 0; i < c.n; i++) if (px[i * 3] >= 254 && px[i * 3 + 1] >= 254 && px[i * 3 + 2] >= 254) clipped++;
  assert.ok(clipped / c.n < 0.015, `${(100 * clipped / c.n).toFixed(2)}% clipped`);
});

test('determinism: same input gives identical paint and pixels; a new seed differs', () => {
  const a = oneStrokeScene(), b = oneStrokeScene();
  assert.equal(fingerprint(a.canvas), fingerprint(b.canvas));
  assert.deepEqual(relight(a.canvas), relight(b.canvas));
  const one = straightKnife().canvas;
  const other = new PaintCanvas(100, 50, 0.1, GROUND, 3);
  const t = new Tool({ kind: 'knife', widthMm: 20, nodes: 128, seed: 8 });
  t.load(16, RED, CREAM, 0.2, 5);
  paintStroke(other, t, { points: [[10, 25], [35, 25], [60, 25], [85, 25]], gapMm: 1.1, seed: 100 });
  assert.notEqual(fingerprint(one), fingerprint(other));
  void reflectanceFromKs;
});
