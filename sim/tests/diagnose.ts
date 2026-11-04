/**
 * Controlled diagnosis on three crops of one painting: mountains, a spruce and the lake.
 *
 *   node --experimental-strip-types tests/diagnose.ts [--width 360] [--fresh] [--fast] [--name tag]
 *
 * --fast plans with the planner's own canvas estimate (no simulation feedback) and simulates only
 * the strokes that touch each crop, in seconds instead of minutes. Use it to compare changes; use
 * the full run to confirm them.
 *
 * Paints the whole fixture once (cached in out/diag/), then for each crop writes the original,
 * the stroke plan, the painted colour, height, normals, cavity term and shaded render, and
 * prints metrics. Comparing the plan's error with the painted colour's error shows whether
 * detail is lost in planning or in the paint; the height and stroke statistics show relief
 * hierarchy and stroke-shape diversity.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { readPng, writePng } from './png.ts';
import { rasterizePlan, strokeMap } from './plan-raster.ts';
import { DEFAULT_SETTINGS, Planner, planPainting, type Plan } from '../src/planner.ts';
import { contactProfile } from '../src/tool.ts';
import { canvasColour, paintStrokes, startPainting, type Painting } from '../src/execute.ts';
import { albedoField, DEFAULT_LIGHT, relight, type View } from '../src/relight.ts';
import { linearToSrgb, srgbToLinear } from '../src/pigment.ts';
import { oklab } from '../src/image.ts';

const args = process.argv.slice(2);
const opt = (n: string, d: string) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : d; };
// A scene from tests/scenes.json: image, canvas width and the crops to examine.
const sceneName = opt('scene', 'lake');
const scenes = JSON.parse(readFileSync(new URL('./scenes.json', import.meta.url), 'utf8'));
const scene = scenes[sceneName];
if (!scene) throw new Error(`no scene ${sceneName}; have ${Object.keys(scenes).join(', ')}`);
const widthMm = +opt('width', String(scene.widthMm));
const fast = args.includes('--fast');
const out = new URL(`../out/diag${sceneName === 'lake' ? '' : '-' + sceneName}${args.includes('--name') ? '-' + opt('name', '') : ''}/`, import.meta.url).pathname;
mkdirSync(out, { recursive: true });
const img = readPng(new URL(`../${scene.image}`, import.meta.url).pathname);
const look = opt('look', 'locked') as 'locked' | 'oil';
// --forms 0 turns the form hierarchy off, --streaks 0 the streaked loads, --tone 0 the toned underpainting,
// --restraint 0 restraint, --presses 0 the press layer and short strokes, --scale 0 the knife scaling;
// --shading, --bands and --press-restraint set the shading direction, value bands and press restraint;
// --stiffness the paint's stiffness (0 for the wet paint of earlier rounds) and --thickness the knife paint's thickness.
const formSizesMm = opt('forms', '') === '0' ? [] : DEFAULT_SETTINGS.formSizesMm;
const settings = { ...DEFAULT_SETTINGS, widthMm, look, formSizesMm, streaks: opt('streaks', '1') !== '0', underTone: +opt('tone', String(DEFAULT_SETTINGS.underTone)), restraint: +opt('restraint', String(DEFAULT_SETTINGS.restraint)), presses: opt('presses', '1') !== '0', autoScale: opt('scale', '1') !== '0', deferThin: opt('defer', DEFAULT_SETTINGS.deferThin ? '1' : '0') === '1',
  shading: +opt('shading', String(DEFAULT_SETTINGS.shading)), valueBands: +opt('bands', String(DEFAULT_SETTINGS.valueBands)), pressRestraint: +opt('press-restraint', String(DEFAULT_SETTINGS.pressRestraint)),
  stiffness: +opt('stiffness', String(DEFAULT_SETTINGS.stiffness)), thickness: +opt('thickness', String(DEFAULT_SETTINGS.thickness)) };
const LIGHT = { ...DEFAULT_LIGHT, look };
const VIEWS: View[] = ['paint', 'normal', 'cavity'];

// Crops as fractions of the image: chosen to stress ridgelines, a thin tree, and broad water.
export const CROPS: { name: string; x0: number; y0: number; x1: number; y1: number }[] = scene.crops;

/** Per stroke (by plan index): paint laid, and how much went to berms and the heap, mm^3. */
interface StrokeVolumes { [index: number]: { laid: number; berm: number; heap: number } }
interface State { plan: Plan; w: number; h: number; dx: number; height: Float32Array; thick: Float32Array; albedo: Float32Array; views: Record<string, Uint8Array>; volumes: StrokeVolumes; ledger: number; }

/** Run strokes, recording per-stroke volumes and the paint ledger (loaded minus accounted for, relative). */
function paintRecorded(painting: Painting, strokes: Plan['strokes'], volumes: StrokeVolumes): void {
  for (const st of strokes) {
    const tool = painting.tools[st.tool], before = tool.loaded - tool.residual() - tool.wiped;
    paintStrokes(painting, [st]);
    const s = painting.stats[painting.stats.length - 1];
    volumes[st.index] = { laid: tool.loaded - tool.residual() - tool.wiped - before, berm: s.bermVolume, heap: s.heapVolume };
  }
}
function ledgerOf(p: Painting): number {
  let loaded = 0, held = p.canvas.totalVolume() + p.canvas.lost;
  for (const t of p.tools) { loaded += t.loaded; held += t.residual() + t.wiped; }
  return loaded > 0 ? Math.abs(loaded - held) / loaded : 0;
}

/** Fast mode: plan without feedback, then paint each crop (plus a margin) on its own small canvas. */
function paintCrops(): Record<string, State> {
  const t0 = Date.now();
  const plan = planPainting(img, settings);
  const pw = Math.round(plan.widthMm / 0.1), ph = Math.round(plan.heightMm / 0.1), n = pw * ph;
  const states: Record<string, State> = {};
  const margin = 12;
  for (const c of CROPS) {
    // Crops overlap, so each gets its own full-size buffers (only its window is filled).
    const st: State = { plan, w: pw, h: ph, dx: 0.1, height: new Float32Array(n), thick: new Float32Array(n), albedo: new Float32Array(n * 3), views: {}, volumes: {}, ledger: 0 };
    for (const v of VIEWS) st.views[v] = new Uint8Array(n * 3);
    states[c.name] = st;
    const ox = Math.max(0, c.x0 * plan.widthMm - margin), oy = Math.max(0, c.y0 * plan.heightMm - margin);
    const ex = Math.min(plan.widthMm, c.x1 * plan.widthMm + margin), ey = Math.min(plan.heightMm, c.y1 * plan.heightMm + margin);
    const strokes = plan.strokes.filter((s) => s.points.some(([x, y]) => x > ox - s.widthMm - s.lengthMm && x < ex + s.widthMm + s.lengthMm && y > oy - s.widthMm - s.lengthMm && y < ey + s.widthMm + s.lengthMm))
      .map((s) => ({ ...s, points: s.points.map(([x, y]) => [x - ox, y - oy] as [number, number]) }));
    const painting = startPainting({ ...plan, widthMm: ex - ox, heightMm: ey - oy }, settings.ground);
    paintRecorded(painting, strokes, st.volumes);
    st.ledger = ledgerOf(painting);
    const { canvas } = painting, A = albedoField(canvas);
    const V: Record<string, Uint8ClampedArray> = {};
    for (const v of VIEWS) V[v] = relight(canvas, LIGHT, v);
    const gx0 = Math.round(ox / 0.1), gy0 = Math.round(oy / 0.1);
    for (let y = 0; y < canvas.h; y++) for (let x = 0; x < canvas.w; x++) {
      const gx = gx0 + x, gy = gy0 + y;
      if (gx >= pw || gy >= ph) continue;
      const g = gy * pw + gx, c2 = y * canvas.w + x;
      st.thick[g] = canvas.top[c2] + canvas.under[c2]; st.height[g] = st.thick[g] + canvas.tooth[c2];
      for (let k = 0; k < 3; k++) { st.albedo[g * 3 + k] = A[c2 * 3 + k]; for (const v of VIEWS) st.views[v][g * 3 + k] = V[v][c2 * 3 + k]; }
    }
    console.log(`${c.name}: ${strokes.length} strokes`);
  }
  console.log('fast crops painted in', ((Date.now() - t0) / 1000).toFixed(0), 's');
  return states;
}

function paintOrLoad(): State {
  const key = createHash('sha256').update(readFileSync(new URL('../src/planner.ts', import.meta.url))).update(readFileSync(new URL('../src/tool.ts', import.meta.url)))
    .update(readFileSync(new URL('../src/canvas.ts', import.meta.url))).update(readFileSync(new URL('../src/relight.ts', import.meta.url)))
    .update(readFileSync(new URL('../src/structure.ts', import.meta.url))).update(readFileSync(new URL('../src/forms.ts', import.meta.url)))
    .update(readFileSync(new URL('../src/execute.ts', import.meta.url))).update(readFileSync(new URL('../src/image.ts', import.meta.url)))
    .update(String(widthMm) + look + sceneName + JSON.stringify(settings)).digest('hex').slice(0, 12);
  const meta = `${out}state-${key}.json`;
  if (existsSync(meta) && !args.includes('--fresh')) {
    const m = JSON.parse(readFileSync(meta, 'utf8'));
    const f32 = (n: string) => new Float32Array(readFileSync(`${out}state-${key}-${n}.bin`).buffer.slice(0));
    const views: Record<string, Uint8Array> = {};
    for (const v of VIEWS) views[v] = new Uint8Array(readFileSync(`${out}state-${key}-${v}.bin`));
    console.log('using cached painting', key);
    return { plan: m.plan, w: m.w, h: m.h, dx: m.dx, height: f32('height'), thick: f32('thick'), albedo: f32('albedo'), views, volumes: m.volumes ?? {}, ledger: m.ledger ?? 0 };
  }
  const t0 = Date.now();
  let painting: Painting | null = null;
  const volumes: StrokeVolumes = {};
  const plan = planPainting(img, settings, (_l, strokes, estimate, partial) => {
    painting ??= startPainting(partial, settings.ground);
    paintRecorded(painting, strokes, volumes);
    return canvasColour(painting.canvas, estimate.w, estimate.h);
  });
  const { canvas } = painting as unknown as Painting;
  console.log('painted', plan.strokes.length, 'strokes in', ((Date.now() - t0) / 1000).toFixed(0), 's');
  const height = new Float32Array(canvas.n), thick = new Float32Array(canvas.n);
  for (let i = 0; i < canvas.n; i++) { thick[i] = canvas.top[i] + canvas.under[i]; height[i] = thick[i] + canvas.tooth[i]; }
  const albedo = albedoField(canvas);
  const views: Record<string, Uint8Array> = {};
  for (const v of VIEWS) views[v] = new Uint8Array(relight(canvas, LIGHT, v).buffer);
  const ledger = ledgerOf(painting as unknown as Painting);
  writeFileSync(meta, JSON.stringify({ plan, w: canvas.w, h: canvas.h, dx: canvas.dx, volumes, ledger }));
  writeFileSync(`${out}state-${key}-height.bin`, Buffer.from(height.buffer));
  writeFileSync(`${out}state-${key}-thick.bin`, Buffer.from(thick.buffer));
  writeFileSync(`${out}state-${key}-albedo.bin`, Buffer.from(albedo.buffer));
  for (const v of VIEWS) writeFileSync(`${out}state-${key}-${v}.bin`, Buffer.from(views[v]));
  writePng(`${out}full-paint.png`, canvas.w, canvas.h, new Uint8ClampedArray(views.paint.buffer));
  writePng(`${out}full-colour.png`, canvas.w, canvas.h, relight(canvas, LIGHT, 'color'));
  writeFileSync(`${out}plan.json`, JSON.stringify(plan));
  console.log('per layer', plan.counts, plan.stats.map((s) => s.primitives));
  return { plan, w: canvas.w, h: canvas.h, dx: canvas.dx, height, thick, albedo, views, volumes, ledger };
}

const perCrop = fast ? paintCrops() : null, full = fast ? null : paintOrLoad();
const first = (perCrop ? perCrop[CROPS[0].name] : full)!;
const { w, h, dx } = first;

// The photo resampled to the canvas grid (bilinear), as sRGB bytes.
const photo = new Uint8ClampedArray(w * h * 3);
for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
  const sx = Math.min(img.w - 1.001, Math.max(0, (x + 0.5) * img.w / w - 0.5)), sy = Math.min(img.h - 1.001, Math.max(0, (y + 0.5) * img.h / h - 0.5));
  const ix = Math.floor(sx), iy = Math.floor(sy), fx = sx - ix, fy = sy - iy;
  for (let k = 0; k < 3; k++) {
    const p = (yy: number, xx: number) => img.data[(yy * img.w + xx) * 3 + k];
    photo[(y * w + x) * 3 + k] = (p(iy, ix) * (1 - fx) + p(iy, ix + 1) * fx) * (1 - fy) + (p(iy + 1, ix) * (1 - fx) + p(iy + 1, ix + 1) * fx) * fy;
  }
}

const crop = (src: ArrayLike<number>, x0: number, y0: number, cw: number, ch: number, toByte = (v: number) => v) => {
  const o = new Uint8ClampedArray(cw * ch * 3);
  for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) for (let k = 0; k < 3; k++) o[(y * cw + x) * 3 + k] = toByte(src[((y0 + y) * w + x0 + x) * 3 + k]);
  return o;
};
const labOf = (px: ArrayLike<number>, n: number) => {
  const L = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { const c = oklab(srgbToLinear(px[i * 3] / 255), srgbToLinear(px[i * 3 + 1] / 255), srgbToLinear(px[i * 3 + 2] / 255)); L.set(c, i * 3); }
  return L;
};
/** Box blur of a 3-channel float image, radius r, used to compare at painting scale. */
const blur3 = (a: Float32Array, cw: number, ch: number, r: number) => {
  const t = new Float32Array(a.length), o = new Float32Array(a.length);
  for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) for (let k = 0; k < 3; k++) {
    let s = 0, n = 0;
    for (let d = -r; d <= r; d++) { const xx = x + d; if (xx >= 0 && xx < cw) { s += a[(y * cw + xx) * 3 + k]; n++; } }
    t[(y * cw + x) * 3 + k] = s / n;
  }
  for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) for (let k = 0; k < 3; k++) {
    let s = 0, n = 0;
    for (let d = -r; d <= r; d++) { const yy = y + d; if (yy >= 0 && yy < ch) { s += t[(yy * cw + x) * 3 + k]; n++; } }
    o[(y * cw + x) * 3 + k] = s / n;
  }
  return o;
};
const meanDE = (a: Float32Array, b: Float32Array, n: number) => { let s = 0; for (let i = 0; i < n; i++) s += Math.hypot(a[i * 3] - b[i * 3], a[i * 3 + 1] - b[i * 3 + 1], a[i * 3 + 2] - b[i * 3 + 2]); return s / n; };
/** Colour gradient magnitude (OKLab, central differences). */
const grad = (a: Float32Array, cw: number, ch: number) => {
  const g = new Float32Array(cw * ch);
  for (let y = 1; y < ch - 1; y++) for (let x = 1; x < cw - 1; x++) {
    let s = 0;
    for (let k = 0; k < 3; k++) {
      const gx = a[(y * cw + x + 1) * 3 + k] - a[(y * cw + x - 1) * 3 + k], gy = a[((y + 1) * cw + x) * 3 + k] - a[((y - 1) * cw + x) * 3 + k];
      s += gx * gx + gy * gy;
    }
    g[y * cw + x] = Math.sqrt(s) * 0.5;
  }
  return g;
};
/** Max filter over a square of radius r. */
const dilate = (g: Float32Array, cw: number, ch: number, r: number) => {
  const t = new Float32Array(g.length), o = new Float32Array(g.length);
  for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) { let m = 0; for (let d = -r; d <= r; d++) { const xx = x + d; if (xx >= 0 && xx < cw && g[y * cw + xx] > m) m = g[y * cw + xx]; } t[y * cw + x] = m; }
  for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) { let m = 0; for (let d = -r; d <= r; d++) { const yy = y + d; if (yy >= 0 && yy < ch && t[yy * cw + x] > m) m = t[yy * cw + x]; } o[y * cw + x] = m; }
  return o;
};
const pct = (a: ArrayLike<number>, q: number) => { const s = Array.from(a).sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(q * s.length))]; };

// The painting maps on the canvas grid, to split relief into structured and flat areas.
const maps = new Planner(img, settings).maps;
const mapAtCell = (m: Float64Array, x: number, y: number) => m[Math.min(maps.h - 1, Math.floor(y * dx / settings.analysisMm)) * maps.w + Math.min(maps.w - 1, Math.floor(x * dx / settings.analysisMm))];
const report: Record<string, unknown> = {};
for (const c of CROPS) {
  const st = perCrop ? perCrop[c.name] : full!;
  const x0 = Math.floor(c.x0 * w), y0 = Math.floor(c.y0 * h), cw = Math.floor((c.x1 - c.x0) * w), ch = Math.floor((c.y1 - c.y0) * h), n = cw * ch;
  const ph = crop(photo, x0, y0, cw, ch);
  const plan = rasterizePlan(st.plan, settings.ground, dx, false, { x0, y0, w: cw, h: ch }).px;
  const strokes = rasterizePlan(st.plan, settings.ground, dx, true, { x0, y0, w: cw, h: ch }).px;
  const colour = crop(st.albedo, x0, y0, cw, ch, (v) => linearToSrgb(v) * 255 + 0.5);
  const heightPx = crop(Array.from({ length: w * h * 3 }, (_, i) => st.height[Math.floor(i / 3)]) as unknown as number[], x0, y0, cw, ch, (s) => s / (s + 2.2) * 255 + 0.5);
  const images: Record<string, Uint8ClampedArray> = { '1-photo': ph, '2-plan': plan, '3-strokes': strokes, '4-colour': colour, '5-height': heightPx };
  for (const v of VIEWS) images[`${v === 'normal' ? '6' : v === 'cavity' ? '7' : '8'}-${v}`] = crop(st.views[v], x0, y0, cw, ch);
  for (const [k, px] of Object.entries(images)) writePng(`${out}${c.name}-${k}.png`, cw, ch, px);

  // 1. Local error at painting scale (1 mm blur), so stroke texture itself isn't counted as error.
  const r = Math.round(1 / dx);
  const Lp = blur3(labOf(ph, n), cw, ch, r), Lplan = blur3(labOf(plan, n), cw, ch, r), Lcol = blur3(labOf(colour, n), cw, ch, r), Lshade = blur3(labOf(images['8-paint'], n), cw, ch, r);
  // 2. Silhouettes: strong photo edges (top 6% gradient at 0.5 mm scale) and whether the output has an edge within 1 mm.
  const r5 = Math.round(0.5 / dx);
  const Gp = grad(blur3(labOf(ph, n), cw, ch, r5), cw, ch), T = pct(Gp, 0.94);
  const edgeScore = (px: Uint8ClampedArray) => {
    const G = grad(blur3(labOf(px, n), cw, ch, r5), cw, ch), D = dilate(G, cw, ch, Math.round(1 / dx));
    let hit = 0, tot = 0, outE = 0, outHit = 0;
    const Pd = dilate(Gp, cw, ch, Math.round(1 / dx));
    for (let i = 0; i < n; i++) {
      if (Gp[i] > T) { tot++; if (D[i] > T * 0.5) hit++; }
      if (G[i] > T) { outE++; if (Pd[i] > T * 0.5) outHit++; }
    }
    return { recall: +(hit / tot).toFixed(3), precision: +(outHit / Math.max(1, outE)).toFixed(3) };
  };
  // 3. Height: thickness distribution, relief (height minus its 3 mm mean), and how much relief varies across 5 mm tiles.
  const thick: number[] = [], H = new Float32Array(n * 3);
  for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) { const v = st.height[(y0 + y) * w + x0 + x]; H[(y * cw + x) * 3] = v; thick.push(st.thick[(y0 + y) * w + x0 + x]); }
  const Hb = blur3(H, cw, ch, Math.round(1.5 / dx));
  const tile = Math.round(5 / dx), tileRelief: number[] = [];
  let relief = 0;
  for (let i = 0; i < n; i++) relief += (H[i * 3] - Hb[i * 3]) ** 2;
  for (let ty = 0; ty + tile <= ch; ty += tile) for (let tx = 0; tx + tile <= cw; tx += tile) {
    let s = 0;
    for (let y = ty; y < ty + tile; y++) for (let x = tx; x < tx + tile; x++) s += (H[(y * cw + x) * 3] - Hb[(y * cw + x) * 3]) ** 2;
    tileRelief.push(Math.sqrt(s / (tile * tile)));
  }
  const tm = tileRelief.reduce((a, b) => a + b, 0) / tileRelief.length;
  const tsd = Math.sqrt(tileRelief.reduce((a, b) => a + (b - tm) ** 2, 0) / tileRelief.length);
  // 4. Strokes whose midpoint lies in the crop: widths, lengths, straightness, direction spread.
  const mm = { x0: x0 * dx, y0: y0 * dx, x1: (x0 + cw) * dx, y1: (y0 + ch) * dx };
  const S = st.plan.strokes.filter((s) => { const m = s.footprint[Math.floor(s.footprint.length / 2)]; return m[0] >= mm.x0 && m[0] < mm.x1 && m[1] >= mm.y0 && m[1] < mm.y1; });
  const lens = S.map((s) => s.lengthMm), widths = S.map((s) => s.widthMm);
  const cv = (a: number[]) => { const m = a.reduce((x, y) => x + y, 0) / a.length; return Math.sqrt(a.reduce((x, y) => x + (y - m) ** 2, 0) / a.length) / m; };
  const straight = S.map((s) => { const f = s.footprint, a = f[0], b = f[f.length - 1]; let arc = 0; for (let i = 1; i < f.length; i++) arc += Math.hypot(f[i][0] - f[i - 1][0], f[i][1] - f[i - 1][1]); return Math.hypot(b[0] - a[0], b[1] - a[1]) / (arc || 1); });
  const bins = new Array(12).fill(0);
  for (const s of S) { const f = s.footprint, dxv = f[f.length - 1][0] - f[0][0], dyv = f[f.length - 1][1] - f[0][1]; let ang = Math.atan2(dyv, dxv); if (ang < 0) ang += Math.PI; bins[Math.min(11, Math.floor(ang / Math.PI * 12))]++; }
  const ent = -bins.filter((b) => b > 0).reduce((a, b) => a + (b / S.length) * Math.log(b / S.length), 0) / Math.log(12);
  // 5. Expressiveness: turning, width variation along the stroke, variety of primitives.
  const turnDeg = S.map((s) => { const f = s.footprint; let t = 0; for (let i = 2; i < f.length; i++) { const a = Math.atan2(f[i - 1][1] - f[i - 2][1], f[i - 1][0] - f[i - 2][0]), b = Math.atan2(f[i][1] - f[i - 1][1], f[i][0] - f[i - 1][0]); let d = Math.abs(b - a); if (d > Math.PI) d = 2 * Math.PI - d; t += d; } return t * 180 / Math.PI; });
  const widthVar = S.map((s) => { const c = contactProfile(s, s.lengthMm, 9); const mx = Math.max(...c), mn = Math.min(...c); return mx > 0 ? (mx - mn) / mx : 0; });
  const prim: Record<string, number> = {};
  for (const s of S) prim[s.primitive] = (prim[s.primitive] ?? 0) + 1;
  const primEnt = -Object.values(prim).reduce((a, k) => a + (k / S.length) * Math.log(k / S.length), 0) / Math.log(8);
  const avg = (a: number[]) => a.reduce((x, y) => x + y, 0) / Math.max(1, a.length);
  // 6. Relief hierarchy: relief in structured against flat areas; sculptural peaks.
  const rel = new Float32Array(n);
  let rDet = 0, nDet = 0, rFlat = 0, nFlat = 0;
  for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) {
    const i = y * cw + x, r = Math.abs(H[i * 3] - Hb[i * 3]);
    rel[i] = r;
    if (mapAtCell(maps.detail, x0 + x, y0 + y) > 0.6) { rDet += r * r; nDet++; }
    if (mapAtCell(maps.flat, x0 + x, y0 + y) > 0.6) { rFlat += r * r; nFlat++; }
  }
  const medRel = pct(rel, 0.5);
  let peaks = 0;
  for (let i = 0; i < n; i++) if (rel[i] > 3 * medRel && rel[i] > 0.15) peaks++;
  // 7. Physical realism: where the paint went; fine ripple (grooves) against form relief;
  //    glints as few long sheens or many beads; steep walls.
  const Hf = blur3(H, cw, ch, Math.round(0.3 / dx)), Hm = blur3(H, cw, ch, Math.round(2 / dx));
  let fine = 0, form = 0, steep = 0;
  for (let i = 0; i < n; i++) { fine += (H[i * 3] - Hf[i * 3]) ** 2; form += (Hf[i * 3] - Hm[i * 3]) ** 2; }
  for (let y = 1; y < ch - 1; y++) for (let x = 1; x < cw - 1; x++) {
    const gx = (H[(y * cw + x + 1) * 3] - H[(y * cw + x - 1) * 3]) / (2 * dx), gy = (H[((y + 1) * cw + x) * 3] - H[((y - 1) * cw + x) * 3]) / (2 * dx);
    if (gx * gx + gy * gy > 1) steep++;
  }
  let laid = 0, berm = 0, heap = 0;
  for (const s of S) { const v = st.volumes[s.index]; if (v) { laid += v.laid; berm += v.berm; heap += v.heap; } }
  const shade = images['8-paint'];
  const isGlint = (i: number) => shade[i * 3] > 240 && shade[i * 3 + 1] > 235 && shade[i * 3 + 2] > 220;
  const seen = new Uint8Array(n);
  let comps = 0, glintPx = 0;
  for (let i = 0; i < n; i++) {
    if (seen[i] || !isGlint(i)) continue;
    comps++;
    const stack = [i]; seen[i] = 1;
    while (stack.length) {
      const q = stack.pop()!; glintPx++;
      const qx = q % cw, qy = (q - qx) / cw;
      for (const [ax, ay] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { const xx = qx + ax, yy = qy + ay; if (xx >= 0 && yy >= 0 && xx < cw && yy < ch) { const j = yy * cw + xx; if (!seen[j] && isGlint(j)) { seen[j] = 1; stack.push(j); } } }
    }
  }
  let glint = 0, dark = 0;
  for (let i = 0; i < n; i++) { if (shade[i * 3] > 240 && shade[i * 3 + 1] > 235 && shade[i * 3 + 2] > 220) glint++; if (shade[i * 3] + shade[i * 3 + 1] + shade[i * 3 + 2] < 150) dark++; }
  // Pigment within strokes: colour gradient (OKLab per mm, at 0.3 mm) inside knife-stroke interiors,
  // across the stroke against along it (streaks run along, so they show as gradient across), and
  // how much of the crop no knife stroke covers (underpainting left to show).
  const sm = strokeMap(st.plan, dx, { x0, y0, w: cw, h: ch }), r3 = Math.max(1, Math.round(0.3 / dx));
  const Lc3 = blur3(labOf(colour, n), cw, ch, r3), Lp3 = blur3(labOf(ph, n), cw, ch, r3);
  let gIn = 0, gPh = 0, gAcross = 0, gAlong = 0, nIn = 0, bare = 0;
  const gvec = (A: Float32Array, i: number, x: number, y: number, ax: number, ay: number) => {
    const xm = x > 0 ? i - 1 : i, xp = x + 1 < cw ? i + 1 : i, ym = y > 0 ? i - cw : i, yp = y + 1 < ch ? i + cw : i;
    let s2 = 0;
    for (let k = 0; k < 3; k++) { const gx = (A[xp * 3 + k] - A[xm * 3 + k]) / ((xp - xm) * dx || 1), gy = (A[yp * 3 + k] - A[ym * 3 + k]) / (((yp - ym) / cw) * dx || 1); const v = gx * ax + gy * ay; s2 += v * v; }
    return Math.sqrt(s2);
  };
  for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) {
    const i = y * cw + x;
    if (sm.top[i] < 0) { bare++; continue; }
    if (!sm.interior[i]) continue;
    const tx = sm.tx[i], ty = sm.ty[i];
    const ac = gvec(Lc3, i, x, y, -ty, tx), al = gvec(Lc3, i, x, y, tx, ty);
    gAcross += ac; gAlong += al; gIn += Math.sqrt(ac * ac + al * al);
    const pa = gvec(Lp3, i, x, y, -ty, tx), pl = gvec(Lp3, i, x, y, tx, ty);
    gPh += Math.sqrt(pa * pa + pl * pl); nIn++;
  }
  report[c.name] = {
    pigment: {
      withinStroke: nIn ? +(gIn / nIn).toFixed(4) : null, photoThere: nIn ? +(gPh / nIn).toFixed(4) : null,
      streakAnisotropy: gAlong > 0 ? +(gAcross / gAlong).toFixed(2) : null, underExposedPct: +(100 * bare / n).toFixed(2),
    },
    sizeMm: [+(cw * dx).toFixed(1), +(ch * dx).toFixed(1)],
    error: { plan: +meanDE(Lp, Lplan, n).toFixed(4), paintedColour: +meanDE(Lp, Lcol, n).toFixed(4), shaded: +meanDE(Lp, Lshade, n).toFixed(4) },
    silhouettes: { plan: edgeScore(plan), paintedColour: edgeScore(colour), shaded: edgeScore(shade) },
    thicknessMm: { mean: +(thick.reduce((a, b) => a + b, 0) / n).toFixed(2), p5: +pct(thick, 0.05).toFixed(2), p50: +pct(thick, 0.5).toFixed(2), p95: +pct(thick, 0.95).toFixed(2) },
    reliefMm: { rms: +Math.sqrt(relief / n).toFixed(3), tileCv: +(tsd / tm).toFixed(3), tileP10: +pct(tileRelief, 0.1).toFixed(3), tileP90: +pct(tileRelief, 0.9).toFixed(3) },
    strokes: { count: S.length, widthsMm: [...new Set(widths.map((v) => +v.toFixed(1)))].sort((a, b) => b - a), lengthCv: +cv(lens).toFixed(3), straightness: +(straight.reduce((a, b) => a + b, 0) / S.length).toFixed(3), directionEntropy: +ent.toFixed(3) },
    shading: { glintPct: +(100 * glint / n).toFixed(2), darkPct: +(100 * dark / n).toFixed(2) },
    expressiveness: {
      meanTurnDeg: +avg(turnDeg).toFixed(1), curvedShare: +(turnDeg.filter((t) => t > 20).length / Math.max(1, S.length)).toFixed(3),
      widthVariation: +avg(widthVar).toFixed(3), primitiveEntropy: +primEnt.toFixed(3), primitives: prim,
    },
    reliefHierarchy: {
      structuredRms: +Math.sqrt(rDet / Math.max(1, nDet)).toFixed(3), flatRms: +Math.sqrt(rFlat / Math.max(1, nFlat)).toFixed(3),
      ratio: nFlat && nDet ? +(Math.sqrt(rDet / nDet) / Math.max(1e-6, Math.sqrt(rFlat / nFlat))).toFixed(2) : null,
      peakShare: +(100 * peaks / n).toFixed(2),
    },
    realism: {
      bermShare: laid > 0 ? +(berm / laid).toFixed(3) : null, heapShare: laid > 0 ? +(heap / laid).toFixed(3) : null,
      grooveIndex: +(Math.sqrt(fine / Math.max(1e-12, form))).toFixed(3), beadIndex: glintPx ? +(1000 * comps / glintPx).toFixed(1) : null,
      steepPct: +(100 * steep / n).toFixed(2), ledger: +st.ledger.toExponential(1),
    },
  };
}
writeFileSync(`${out}metrics.json`, JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
