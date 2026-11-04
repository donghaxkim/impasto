/**
 * The library API (src/index.ts): input validation, options and presets, progress, abort, result
 * shapes, the worker protocol, and that it paints exactly what the CLI pipeline paints.
 * Tiny images and canvases throughout, so it stays fast.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  canvasWidthMm, DEFAULT_LIGHT, DEFAULT_SETTINGS, downsampleSurface, ImpastoError, MAX_SIDE_MM, MIN_WIDTH_MM, planImpasto, planInWorker, renderImpasto, renderInWorker, resolvePreset, PRESET_NAMES,
  strokesToJSON, type ImpastoErrorCode, type ImpastoResult, type ImpastoSurface, type LayerSnapshot, type ProgressInfo,
} from '../src/index.ts';
import { serveImpasto, type WorkerResponse } from '../src/worker.ts';
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
    { onLayer: 'yes' }, { snapshot: null }, { snapshot: { maxSide: 0 } }, { snapshot: { maxSide: 'big' } }, { snapshot: { maxSide: NaN } },
  ];
  for (const o of bad) await assert.rejects(renderImpasto(img, o as never), hasCode('BAD_OPTION'), JSON.stringify(o));
});

test('api: presets resolve over the library defaults by reference', () => {
  const oil = resolvePreset('oil'), locked = resolvePreset('locked');
  assert.deepEqual(PRESET_NAMES, ['oil', 'locked']);
  assert.deepEqual(oil.settings, { ...DEFAULT_SETTINGS, look: 'oil' });
  assert.deepEqual(oil.light, { ...DEFAULT_LIGHT, look: 'oil', glow: 0, occlusion: 0.95 });
  assert.deepEqual(locked.settings, { ...DEFAULT_SETTINGS, look: 'locked' });
  assert.deepEqual(locked.light, { ...DEFAULT_LIGHT, look: 'locked' });
  // Overrides go on top, and nothing leaks back into the defaults.
  const o = resolvePreset('oil', { restraint: 0.1 }, { azimuth: 90 });
  assert.equal(o.settings.restraint, 0.1);
  assert.equal(o.light.azimuth, 90);
  assert.equal(o.light.occlusion, 0.95);
  const before = JSON.stringify([DEFAULT_SETTINGS, DEFAULT_LIGHT]);
  for (const name of ['oil', 'locked'] as const) resolvePreset(name, { seed: 5 }, { glow: 0 });
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
  assert.deepEqual(r.light, resolvePreset('oil').light);
  assert.deepEqual(Object.keys(r.timings).sort(), ['analyse', 'paint', 'plan', 'relight', 'snapshot', 'surface', 'total']);
  assert.equal(r.timings.snapshot, 0, 'no snapshots without onLayer');
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

test('api: worker calls reject instead of hanging when the job cannot be sent or the worker fails', async () => {
  // A Proxy (e.g. a Vue reactive object) cannot be structured-cloned: postMessage throws.
  const { port1, port2 } = new MessageChannel();
  serveImpasto(port2 as never);
  try {
    const img = tiny();
    await assert.rejects(planInWorker(port1 as never, new Proxy(img, {}), { widthMm: 24 }), hasCode('BAD_OPTION'));
  } finally { port1.close(); port2.close(); }
  // A worker that errors (failed to load, crashed) rejects with WORKER_FAILED and detaches its listeners.
  const fake = new EventTarget() as EventTarget & { postMessage(): void };
  fake.postMessage = () => {};
  const job = planInWorker(fake as never, tiny(), { widthMm: 24 });
  await new Promise((r) => setTimeout(r, 0));
  fake.dispatchEvent(Object.assign(new Event('error'), { message: 'boom' }));
  await assert.rejects(job, hasCode('WORKER_FAILED'));
});

// ---------------------------------------------------------------------------------------------
// Layer snapshots (onLayer) and the plain stroke list

const surfaceSha = (s: ImpastoSurface): string => sha(JSON.stringify([s.w, s.h, s.dx, s.maxH]) + sha(new Uint8Array(s.height.buffer, s.height.byteOffset, s.height.byteLength)) + sha(new Uint8Array(s.color.buffer, s.color.byteOffset, s.color.byteLength)));
/** Everything in a result that the painting determines (not timings). */
const resultSha = (r: ImpastoResult): string => sha([sha(r.image.data), surfaceSha(r.surface), JSON.stringify(r.strokeList), JSON.stringify(r.layerNames), r.strokes].join());
const plainRoundTrip = (v: unknown): void => assert.deepEqual(JSON.parse(JSON.stringify(v)), v);

/** Checks the snapshots of one render: one per layer, in order, sized and consistent with the result. */
function checkSnapshots(snaps: LayerSnapshot[], r: ImpastoResult, maxSide: number): void {
  const layers = r.layerNames.length;
  assert.deepEqual(snaps.map((s) => s.layer), [...Array(layers).keys()], 'one snapshot per layer, in order');
  assert.deepEqual(snaps.map((s) => s.name), r.layerNames);
  for (const [i, s] of snaps.entries()) {
    assert.equal(s.layers, layers);
    assert.equal(s.deferred, false);
    assert.ok(i === 0 || s.fraction > snaps[i - 1].fraction);
    assert.ok(s.fraction > 0.05 && s.fraction <= 0.9);
    assert.equal(s.widthMm, r.widthMm);
    assert.equal(s.heightMm, r.heightMm);
    const f = s.scale, sf = s.surface;
    assert.ok(Math.max(sf.w, sf.h) <= maxSide, `${sf.w}x${sf.h} within ${maxSide}`);
    assert.equal(sf.w, Math.ceil(r.surface.w / f));
    assert.equal(sf.h, Math.ceil(r.surface.h / f));
    assert.ok(Math.abs(sf.dx - r.surface.dx * f) < 1e-12);
    assert.equal(sf.height.length, sf.w * sf.h * 2);
    assert.equal(sf.color.length, sf.w * sf.h * 4);
    let maxH = 0;
    for (let j = 1; j < sf.height.length; j += 2) maxH = Math.max(maxH, sf.height[j]);
    assert.ok(Math.abs(sf.maxH - maxH) < 1e-6, 'maxH is the highest shadow height');
    assert.ok(sf.color.every(Number.isFinite) && sf.height.every(Number.isFinite));
    assert.ok(s.strokes.every((st) => st.layer === s.layer));
    if (i > 0) assert.notEqual(snaps[i - 1].surface.height.buffer, sf.height.buffer, 'fresh buffers per snapshot');
  }
  // The layers' strokes, in order, are the whole stroke list; all of it is plain JSON.
  assert.deepEqual(snaps.flatMap((s) => s.strokes), r.strokeList);
  plainRoundTrip(snaps.map(({ surface: _s, ...rest }) => rest));
}

test('api: onLayer gives a snapshot per layer, in order, without changing the painting', async () => {
  const img = tiny(), opts = { widthMm: 30 };
  const plain = await renderImpasto(img, opts);
  // Small snapshots (factor 3), with progress interleaved.
  const snaps: LayerSnapshot[] = [], order: string[] = [];
  const small = await renderImpasto(img, {
    ...opts, snapshot: { maxSide: 100 },
    onProgress: (p) => order.push(p.stage === 'paint' ? `paint ${p.layer}` : p.stage),
    onLayer: (s) => { snaps.push(s); order.push(`layer ${s.layer}`); },
  });
  assert.equal(resultSha(small), resultSha(plain), 'same image, surface and strokes with onLayer');
  checkSnapshots(snaps, small, 100);
  assert.equal(snaps[0].scale, 3);
  assert.ok(small.timings.snapshot > 0);
  const layers = small.layerNames.length;
  assert.deepEqual(order, ['analyse', ...[...Array(layers).keys()].flatMap((l) => [`paint ${l}`, `layer ${l}`]), 'relight', 'done']);
  // The last small snapshot is the final surface, downsampled (it averages the unrounded fields, so up to float rounding).
  const down = downsampleSurface(small.surface, 100), last = snaps.at(-1)!.surface;
  assert.equal(down.w, last.w);
  assert.ok(Math.abs(down.maxH - last.maxH) < 1e-5);
  for (let i = 0; i < down.height.length; i++) assert.ok(Math.abs(down.height[i] - last.height[i]) < 1e-5);
  for (let i = 0; i < down.color.length; i++) assert.ok(Math.abs(down.color[i] - last.color[i]) < 1e-5);
  // Full resolution: the last snapshot is the result's surface, bit for bit.
  const full: LayerSnapshot[] = [];
  const fr = await renderImpasto(img, { ...opts, snapshot: { maxSide: Infinity }, onLayer: (s) => full.push(s) });
  assert.equal(resultSha(fr), resultSha(plain));
  checkSnapshots(full, fr, Infinity);
  assert.equal(full[0].scale, 1);
  assert.equal(surfaceSha(full.at(-1)!.surface), surfaceSha(fr.surface));
  // The default size fits 600 cells: this 300-cell canvas comes at full size.
  const def: LayerSnapshot[] = [];
  await renderImpasto(img, { ...opts, preset: 'locked', advanced: { layers: DEFAULT_SETTINGS.layers.slice(0, 1) }, onLayer: (s) => def.push(s) });
  assert.ok(def.length >= 1);
  assert.ok(def.every((s) => s.scale === 1 && s.surface.w === 300 && s.surface.h === 225));
  // planImpasto paints nothing, so it takes no snapshots.
  let planned = 0;
  await planImpasto(img, { ...opts, onLayer: () => { planned++; } });
  assert.equal(planned, 0);
});

test('api: a throwing onLayer is reported and the render carries on', async () => {
  const img = tiny(), opts = { widthMm: 24, advanced: { layers: DEFAULT_SETTINGS.layers.slice(0, 2) } };
  const g = globalThis as { reportError?: unknown }, had = 'reportError' in g, saved = g.reportError;
  const reported: unknown[] = [];
  g.reportError = (e: unknown) => reported.push(e);
  try {
    const plain = await renderImpasto(img, opts);
    const r = await renderImpasto(img, { ...opts, onLayer: (s) => { throw new Error(`boom ${s.layer}`); } });
    assert.equal(resultSha(r), resultSha(plain));
    assert.deepEqual(reported.map((e) => (e as Error).message), r.layerNames.map((_, l) => `boom ${l}`));
  } finally { if (had) g.reportError = saved; else delete g.reportError; }
});

test('api: downsampleSurface box-averages colour and height and scales dx', () => {
  // 5 x 3 cells by 2: blocks of 2x2, 1x2 (right), 2x1 (bottom) and 1x1 (corner).
  const w = 5, h = 3, n = w * h, height = new Float32Array(n * 2), color = new Float32Array(n * 4);
  for (let i = 0; i < n; i++) { height[i * 2] = i; height[i * 2 + 1] = 2 * i; for (let k = 0; k < 4; k++) color[i * 4 + k] = i / 100 + k; }
  const s: ImpastoSurface = { w, h, dx: 0.1, maxH: 28, height, color };
  assert.equal(downsampleSurface(s, 5), s, 'already fits');
  const d = downsampleSurface(s, 3);
  assert.deepEqual([d.w, d.h], [3, 2]);
  assert.ok(Math.abs(d.dx - 0.2) < 1e-15);
  const mean = (cells: number[]) => cells.reduce((a, b) => a + b, 0) / cells.length;
  const blocks = [[0, 1, 5, 6], [2, 3, 7, 8], [4, 9], [10, 11], [12, 13], [14]];
  blocks.forEach((cells, j) => {
    assert.ok(Math.abs(d.height[j * 2] - mean(cells)) < 1e-5, `block ${j}`);
    assert.ok(Math.abs(d.height[j * 2 + 1] - 2 * mean(cells)) < 1e-5);
    for (let k = 0; k < 4; k++) assert.ok(Math.abs(d.color[j * 4 + k] - (mean(cells) / 100 + k)) < 1e-5);
  });
  assert.equal(d.maxH, d.height[5 * 2 + 1]);
  assert.equal(d.maxH, 28);
});

test('api: result.strokeList and strokesToJSON are plain JSON in paint order', async () => {
  const r = await renderImpasto(tiny(), { preset: 'locked', widthMm: 30 });
  assert.equal(r.strokeList.length, r.strokes);
  assert.deepEqual(r.strokeList.map((s) => s.index), [...Array(r.strokes).keys()]);
  plainRoundTrip(r.strokeList);
  for (const s of r.strokeList) {
    assert.ok(s.points.length >= 2 && s.points.every((p) => p.length === 2 && p.every(Number.isFinite)));
    assert.ok(s.widthMm > 0 && s.lengthMm > 0 && s.thicknessMm > 0);
    assert.ok(s.contact.length === 11 && s.contact.every((c) => c > 0 && c <= 1.0001));
    assert.ok([s.color, s.secondary].every((c) => c.length === 3 && c.every((v) => v >= 0 && v <= 1)));
    assert.ok(s.tool === 'knife' || s.tool === 'bristle');
    assert.ok(s.layer >= 0 && s.layer < r.layerNames.length);
  }
  assert.equal(r.strokeList[0].tool, 'bristle', 'the underpainting is brushed');
  // The plan's strokes convert the same way (here the plan-only one, which differs from what was painted).
  const p = await planImpasto(tiny(), { preset: 'locked', widthMm: 30 });
  const list = strokesToJSON(p.plan);
  assert.equal(list.length, p.strokes);
  plainRoundTrip(list);
  // The oil look's streaked loads carry their colours across the blade.
  const oil = strokesToJSON((await planImpasto(tiny(), { widthMm: 30 })).plan);
  assert.ok(oil.some((s) => s.colors && s.colors.length > 1 && typeof s.mix === 'number'));
});

test('api: renderInWorker forwards layer snapshots, transferring their buffers', async () => {
  const img = tiny(), opts = { widthMm: 24, snapshot: { maxSide: 120 }, advanced: { layers: DEFAULT_SETTINGS.layers.slice(0, 2) } };
  const direct: LayerSnapshot[] = [];
  const d = await renderImpasto(img, { ...opts, onLayer: (s) => direct.push(s) });
  const { port1, port2 } = new MessageChannel();
  serveImpasto(port2 as never);
  try {
    const snaps: LayerSnapshot[] = [], order: string[] = [];
    const w = await renderInWorker(port1 as never, img, {
      ...opts, onProgress: (p) => order.push(p.stage), onLayer: (s) => { snaps.push(s); order.push('layer'); },
    });
    assert.equal(resultSha(w), resultSha(d));
    const layers = w.layerNames.length;
    assert.equal(snaps.length, layers);
    assert.equal(direct.length, layers);
    assert.deepEqual(order, ['analyse', ...Array(layers).fill(['paint', 'layer']).flat(), 'relight', 'done']);
    for (const [i, s] of snaps.entries()) {
      assert.ok(s.surface.height instanceof Float32Array && s.surface.color instanceof Float32Array);
      assert.equal(surfaceSha(s.surface), surfaceSha(direct[i].surface));
      assert.deepEqual(s.strokes, direct[i].strokes);
      assert.deepEqual({ ...s, surface: null, planMs: 0, paintMs: 0 }, { ...direct[i], surface: null, planMs: 0, paintMs: 0 });
    }
    // A throwing onLayer on the page does not break the render.
    const g = globalThis as { reportError?: unknown }, had = 'reportError' in g, saved = g.reportError, reported: unknown[] = [];
    g.reportError = (e: unknown) => reported.push(e);
    try {
      const t = await renderInWorker(port1 as never, img, { ...opts, onLayer: () => { throw new Error('page bug'); } });
      assert.equal(resultSha(t), resultSha(d));
      assert.equal(reported.length, layers);
    } finally { if (had) g.reportError = saved; else delete g.reportError; }
    // Abort from inside onLayer stops the render.
    const ac = new AbortController();
    await assert.rejects(renderInWorker(port1 as never, img, { ...opts, signal: ac.signal, onLayer: () => ac.abort() }), isAbort);
    await assert.rejects(renderInWorker(port1 as never, img, { onLayer: 'no' as never }), hasCode('BAD_OPTION'));
  } finally { port1.close(); port2.close(); }

  // The worker side: 'layer' messages only when asked (older pages never ask), with the buffers in the transfer list.
  const run = (layers: boolean | undefined) => new Promise<{ msg: WorkerResponse; transfer: unknown[] }[]>((resolve) => {
    const sent: { msg: WorkerResponse; transfer: unknown[] }[] = [];
    let listener: ((e: { data: unknown }) => void) | null = null;
    serveImpasto({
      postMessage: (msg: WorkerResponse, transfer: unknown[]) => { sent.push({ msg, transfer }); if (msg.type === 'result' || msg.type === 'error') resolve(sent); },
      addEventListener: (_t: 'message', l: (e: { data: unknown }) => void) => { listener = l; },
      removeEventListener: () => {},
    });
    listener!({ data: { type: 'render', id: 7, image: img, options: opts, ...(layers === undefined ? {} : { layers }) } });
  });
  for (const layers of [undefined, false]) {
    const sent = await run(layers);
    assert.equal(sent.at(-1)!.msg.type, 'result');
    assert.ok(!sent.some((m) => m.msg.type === 'layer'), `no layer messages for layers: ${layers}`);
  }
  const sent = await run(true), layerMsgs = sent.filter((m) => m.msg.type === 'layer');
  assert.equal(layerMsgs.length, d.layerNames.length);
  for (const { msg, transfer } of layerMsgs) {
    const snap = (msg as Extract<WorkerResponse, { type: 'layer' }>).snapshot;
    assert.equal(msg.id, 7);
    assert.deepEqual(transfer, [snap.surface.height.buffer, snap.surface.color.buffer]);
  }
  assert.equal(sent.findIndex((m) => m.msg.type === 'result'), sent.length - 1, 'snapshots come before the result');
});
