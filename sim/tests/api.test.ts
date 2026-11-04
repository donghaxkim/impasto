/**
 * The library API (src/index.ts): input validation, options and presets, progress, abort, result
 * shapes, the worker protocol, and that it paints exactly what the CLI pipeline paints.
 * Tiny images and canvases throughout, so it stays fast.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  canvasWidthMm, DEFAULT_LIGHT, DEFAULT_SETTINGS, ImpastoError, MAX_SIDE_MM, MIN_WIDTH_MM, planImpasto, planInWorker, renderImpasto, renderInWorker, resolvePreset,
  type ImpastoErrorCode, type ProgressInfo,
} from '../src/index.ts';
import { serveImpasto } from '../src/worker.ts';
import { runPipeline } from '../src/pipeline.ts';
import { planPainting, type PlanSettings } from '../src/planner.ts';
import { canvasColour, paintStrokes, startPainting, type Painting } from '../src/execute.ts';
import type { PaintCanvas } from '../src/canvas.ts';

/** 48 x 36 RGBA: sky gradient, a grey peak, a lake and a thin dark tree (the same pixels as the CLI fixture below). */
function tiny(): { width: number; height: number; data: Uint8ClampedArray } {
  const w = 48, h = 36, data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let c = [150 + 60 * y / h, 190 + 40 * y / h, 235];
    if (y > 8 + Math.abs(x - 18) * 0.6 && y < 22) c = [95, 100, 115];
    if (y >= 22) c = [40, 170, 190];
    if (x >= 34 && x < 36 && y > 6 && y < 32) c = [30, 70, 40];
    data.set([...c.map(Math.round), 255], (y * w + x) * 4);
  }
  return { width: w, height: h, data };
}
const rgbOf = (rgba: Uint8ClampedArray): Uint8Array => { const n = rgba.length / 4, o = new Uint8Array(n * 3); for (let i = 0; i < n; i++) o.set(rgba.subarray(i * 4, i * 4 + 3), i * 3); return o; };
const sha = (b: Uint8Array | string): string => createHash('sha256').update(b).digest('hex');
const fingerprint = (c: PaintCanvas): string => createHash('sha256').update(Buffer.from(c.top.buffer)).update(Buffer.from(c.under.buffer)).update(Buffer.from(c.topP.buffer)).digest('hex');
const hasCode = (code: ImpastoErrorCode) => (e: unknown): boolean => {
  assert.ok(e instanceof ImpastoError, `expected ImpastoError, got ${String(e)}`);
  assert.equal(e.name, 'ImpastoError');
  assert.equal(e.code, code, e.message);
  return true;
};
const isAbort = (e: unknown): boolean => { assert.equal((e as Error).name, 'AbortError'); return true; };

test('api: invalid images reject with typed ImpastoErrors', async () => {
  const bad: [unknown, ImpastoErrorCode][] = [
    [null, 'UNSUPPORTED_SOURCE'],
    ['photo.png', 'UNSUPPORTED_SOURCE'],
    [{ width: 10, height: 10 }, 'UNSUPPORTED_SOURCE'],
    [new Blob([new Uint8Array(8)], { type: 'image/png' }), 'UNSUPPORTED_SOURCE'], // no createImageBitmap in Node
    [{ width: 0, height: 0, data: new Uint8Array(0) }, 'EMPTY_IMAGE'],
    [{ width: 4, height: -1, data: new Uint8Array(0) }, 'EMPTY_IMAGE'],
    [{ width: 2.5, height: 2, data: new Uint8Array(20) }, 'EMPTY_IMAGE'],
    [{ width: 4, height: 4, data: new Uint8Array(4 * 4 * 4 - 1) }, 'BAD_DATA'],
    [{ width: 4, height: 4, data: new Uint8Array(4 * 4 * 3), channels: 4 }, 'BAD_DATA'],
    [{ width: 4, height: 4, data: new Array(64).fill(0) }, 'BAD_DATA'],
    [{ width: 4, height: 4, data: new Float32Array(64) }, 'BAD_DATA'],
    [{ width: 900, height: 100, data: new Uint8Array(900 * 100 * 4) }, 'BAD_ASPECT'],
    [{ width: 20000, height: 10000, data: new Uint8Array(0) }, 'IMAGE_TOO_LARGE'],
    [{ width: 8000, height: 7000, data: new Uint8Array(0) }, 'IMAGE_TOO_LARGE'],
  ];
  for (const [src, code] of bad) await assert.rejects(renderImpasto(src as never), hasCode(code), `${code} for ${JSON.stringify(src)?.slice(0, 60)}`);
  // planImpasto validates the same way.
  await assert.rejects(planImpasto({ width: 0, height: 3, data: new Uint8Array(0) }), hasCode('EMPTY_IMAGE'));
});

test('api: invalid options reject with BAD_OPTION', async () => {
  const img = tiny();
  const bad: unknown[] = [
    { preset: 'watercolour' }, { widthMm: NaN }, { widthMm: '200' }, { seed: 1.5 }, { seed: Infinity },
    { light: { azimuth: 'left' } }, { light: { look: 'matte' } }, { light: null }, { advanced: 3 }, { advanced: { layers: [] } }, { onProgress: 'yes' }, null,
  ];
  for (const o of bad) await assert.rejects(renderImpasto(img, o as never), hasCode('BAD_OPTION'), JSON.stringify(o));
});

test('api: presets resolve over the library defaults by reference', () => {
  const oil = resolvePreset('oil'), locked = resolvePreset('locked'), smooth = resolvePreset('smooth');
  assert.deepEqual(oil.settings, { ...DEFAULT_SETTINGS, look: 'oil' });
  assert.deepEqual(oil.light, { ...DEFAULT_LIGHT, look: 'oil' });
  assert.deepEqual(locked.settings, { ...DEFAULT_SETTINGS, look: 'locked' });
  assert.deepEqual(locked.light, { ...DEFAULT_LIGHT, look: 'locked' });
  // smooth: oil with more restraint, blended loads, thinner paint, fewer accents and softer light.
  const s = smooth.settings;
  assert.equal(s.look, 'oil');
  assert.ok(s.restraint > DEFAULT_SETTINGS.restraint && s.restraint <= 1);
  assert.equal(s.streaks, false);
  assert.ok(s.lightBoost < DEFAULT_SETTINGS.lightBoost);
  assert.deepEqual(s.layers.map((l) => l.name), DEFAULT_SETTINGS.layers.map((l) => l.name));
  const by = (name: string, ls = s.layers) => ls.find((l) => l.name === name)!;
  assert.ok(by('accents').threshold > by('accents', DEFAULT_SETTINGS.layers).threshold);
  assert.ok(by('masses').gapMm < by('masses', DEFAULT_SETTINGS.layers).gapMm);
  assert.equal(by('underpaint').gapMm, by('underpaint', DEFAULT_SETTINGS.layers).gapMm);
  assert.ok(smooth.light.elevation > DEFAULT_LIGHT.elevation && smooth.light.relief < DEFAULT_LIGHT.relief && smooth.light.look === 'oil');
  // Overrides go on top, and nothing leaks back into the defaults.
  const o = resolvePreset('smooth', { restraint: 0.1 }, { azimuth: 90 });
  assert.equal(o.settings.restraint, 0.1);
  assert.equal(o.light.azimuth, 90);
  assert.equal(o.light.elevation, smooth.light.elevation);
  const before = JSON.stringify([DEFAULT_SETTINGS, DEFAULT_LIGHT]);
  for (const name of ['oil', 'locked', 'smooth'] as const) resolvePreset(name, { seed: 5 }, { glow: 0 });
  assert.equal(JSON.stringify([DEFAULT_SETTINGS, DEFAULT_LIGHT]), before);
});

test('api: canvas width defaults, clamps and caps the long side', async () => {
  assert.equal(canvasWidthMm(48, 36, DEFAULT_SETTINGS.widthMm), DEFAULT_SETTINGS.widthMm);
  assert.equal(canvasWidthMm(48, 36, 1), MIN_WIDTH_MM);
  assert.equal(canvasWidthMm(48, 36, 5000), MAX_SIDE_MM);
  assert.equal(canvasWidthMm(100, 400, 300), MAX_SIDE_MM / 4); // tall: the height is capped
  const one = DEFAULT_SETTINGS.layers.slice(0, 1);
  const p = await planImpasto(tiny(), { preset: 'locked', widthMm: 3, advanced: { layers: one } });
  assert.equal(p.widthMm, MIN_WIDTH_MM);
  assert.equal(p.heightMm, MIN_WIDTH_MM * 36 / 48);
  assert.equal(p.plan.widthMm, MIN_WIDTH_MM);
  // advanced wins over the plain options.
  const q = await planImpasto(tiny(), { preset: 'locked', widthMm: 40, seed: 3, advanced: { widthMm: 25, seed: 4, layers: one } });
  assert.equal(q.widthMm, 25);
  assert.equal(q.seed, 4);
});

test('api: abort before start and between layers', async () => {
  const img = tiny();
  await assert.rejects(renderImpasto(img, { signal: AbortSignal.abort() }), isAbort);
  // A custom reason is passed through, as fetch does.
  const reason = new Error('user left'); reason.name = 'AbortError';
  await assert.rejects(planImpasto(img, { signal: AbortSignal.abort(reason) }), (e) => e === reason);
  const ac = new AbortController(), seen: ProgressInfo[] = [];
  const t = performance.now();
  await assert.rejects(renderImpasto(img, {
    widthMm: 30, signal: ac.signal,
    onProgress: (p) => { seen.push(p); if (p.stage === 'paint') ac.abort(); },
  }), isAbort);
  assert.deepEqual(seen.map((p) => p.stage), ['analyse', 'paint'], 'no progress after the abort');
  assert.ok(performance.now() - t < 15000, 'stopped before painting');
});

test('api: oil render gives RGBA, a matching surface and monotonic progress', async () => {
  const events: ProgressInfo[] = [];
  const r = await renderImpasto(tiny(), { widthMm: 30, onProgress: (p) => events.push(p) });
  // Progress: analyse, every layer once in order, relight, done; fractions never decrease.
  const layers = events.find((e) => e.stage === 'paint')!.layers!;
  assert.deepEqual(events.map((e) => e.stage), ['analyse', ...Array(layers).fill('paint'), 'relight', 'done']);
  assert.deepEqual(events.filter((e) => e.stage === 'paint').map((e) => e.layer), [...Array(layers).keys()]);
  assert.ok(events.filter((e) => e.stage === 'paint').every((e) => e.layers === layers && typeof e.layerName === 'string'));
  for (let i = 1; i < events.length; i++) assert.ok(events[i].fraction > events[i - 1].fraction, `fraction ${events[i - 1].fraction} -> ${events[i].fraction}`);
  assert.equal(events[0].fraction, 0);
  assert.equal(events.at(-1)!.fraction, 1);
  // Result shapes: 0.1 mm cells, RGBA image and surface buffers of the same size.
  assert.equal(r.preset, 'oil');
  assert.equal(r.widthMm, 30);
  assert.equal(r.heightMm, 22.5);
  assert.equal(r.image.width, 300);
  assert.equal(r.image.height, 225);
  assert.ok(r.image.data instanceof Uint8ClampedArray);
  assert.equal(r.image.data.length, 300 * 225 * 4);
  for (let i = 3; i < r.image.data.length; i += 4) if (r.image.data[i] !== 255) assert.fail(`alpha ${r.image.data[i]} at ${i}`);
  assert.equal(r.surface.w, r.image.width);
  assert.equal(r.surface.h, r.image.height);
  assert.equal(r.surface.height.length, r.surface.w * r.surface.h * 2);
  assert.equal(r.surface.color.length, r.surface.w * r.surface.h * 4);
  assert.ok(r.surface.maxH > 0.1, `maxH ${r.surface.maxH}`);
  assert.ok(r.strokes > 10, `${r.strokes} strokes`);
  assert.deepEqual(r.light, { ...DEFAULT_LIGHT, look: 'oil' });
  assert.deepEqual(Object.keys(r.timings).sort(), ['analyse', 'paint', 'plan', 'relight', 'surface', 'total']);
});

test('api: the locked preset paints exactly what the CLI paints', async () => {
  // `npm run paint -- <tiny()-as-PNG> --width 30` (locked look) at commit 394c1e5, before the CLI
  // moved onto src/pipeline.ts: 36 strokes, plan 5e0d4110642e6f4d, paint sha256 1f4a3b3abdcc1694.
  const r = await renderImpasto(tiny(), { preset: 'locked', widthMm: 30 });
  assert.equal(r.strokes, 36);
  assert.equal(sha(rgbOf(r.image.data)).slice(0, 16), '1f4a3b3abdcc1694');
});

test('api: the pipeline matches planPainting with the CLI feedback, plan and canvas', () => {
  const img = { w: 48, h: 36, data: rgbOf(tiny().data) };
  const settings: Partial<PlanSettings> = { widthMm: 30, look: 'oil', deferThin: true, layers: DEFAULT_SETTINGS.layers.slice(1, 3) };
  let painting: Painting | null = null;
  const plan = planPainting(img, settings, (_l, strokes, estimate, partial) => {
    painting ??= startPainting(partial, DEFAULT_SETTINGS.ground);
    paintStrokes(painting, strokes);
    return canvasColour(painting.canvas, estimate.w, estimate.h);
  });
  const res = runPipeline(img, settings);
  assert.equal(sha(JSON.stringify(res.plan)), sha(JSON.stringify(plan)));
  assert.equal(fingerprint(res.painting!.canvas), fingerprint(painting!.canvas));
  // Plan only: no painting, the planner's own estimate.
  const est = runPipeline(img, settings, { simulate: false });
  assert.equal(est.painting, null);
  assert.equal(sha(JSON.stringify(est.plan)), sha(JSON.stringify(planPainting(img, settings))));
});

test('api: worker protocol over a MessageChannel', async () => {
  const { port1, port2 } = new MessageChannel();
  serveImpasto(port2 as never);
  try {
    const img = tiny(), opts = { widthMm: 24, advanced: { layers: DEFAULT_SETTINGS.layers.slice(0, 2) } };
    const events: ProgressInfo[] = [];
    const viaWorker = await planInWorker(port1 as never, img, { ...opts, onProgress: (p) => events.push(p) });
    const direct = await planImpasto(img, opts);
    assert.equal(sha(JSON.stringify(viaWorker.plan)), sha(JSON.stringify(direct.plan)));
    assert.equal(events.at(-1)!.stage, 'done');
    await assert.rejects(renderInWorker(port1 as never, { width: 0, height: 1, data: new Uint8Array(0) }), hasCode('EMPTY_IMAGE'));
    await assert.rejects(planInWorker(port1 as never, img, { signal: AbortSignal.abort() }), isAbort);
    const ac = new AbortController();
    await assert.rejects(planInWorker(port1 as never, img, { ...opts, signal: ac.signal, onProgress: (p) => { if (p.stage === 'paint') ac.abort(); } }), isAbort);
  } finally { port1.close(); port2.close(); }
});
