/**
 * Browser tests for the live viewer (`src/viewer.ts`) and the demo page, in headless Chromium.
 * Not part of `npm test` (they need Chromium and take a minute or two): `npm run test:viewer`.
 *
 * - WebGPU (SwiftShader): the viewer's GPU path matches the CPU reference, the on-screen canvas
 *   shows it, light changes and pointer drags move the light, and a lost device falls back.
 * - No WebGPU (navigator.gpu removed, a null adapter, forceStatic, a browser with WebGPU off):
 *   the viewer reports 'static', draws the supplied fallback image exactly, or else its own
 *   approximate shading, which still answers the light.
 * - The demo page from export-viewer.ts: mode indicator, drag-to-light, opening .impasto files.
 */
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readPng } from './png.ts';
import { DEFAULT_LIGHT, relight } from '../src/relight.ts';
import { encodeSurface, surfaceFromCanvas } from '../src/surface.ts';
import { viewerHtml, viewerPage } from './export-viewer.ts';
import { PARITY_CASES } from './gpu-parity.ts';
import { compareRgb, NO_WEBGPU_ARGS, parityCanvas, RENDER_IN_PAGE, startHarness, tinyCanvas, WEBGPU_ARGS, WEBGPU_LOSSY_ARGS, type Harness } from './viewer-harness.ts';

const NO_GPU = 'Object.defineProperty(Navigator.prototype, "gpu", { get: () => undefined, configurable: true });';
const tiny = tinyCanvas();
// Lossless (version 1) so the renderer is compared, not the quantised file format.
const tinyB64 = Buffer.from(encodeSurface(surfaceFromCanvas(tiny), { version: 1 })).toString('base64');
const tinyRef = relight(tiny, DEFAULT_LIGHT, 'paint');
const tinyRefB64 = Buffer.from(tinyRef).toString('base64');
const rgbToRgba = (rgb: Uint8ClampedArray) => { const o: number[] = []; for (let i = 0; i < rgb.length; i += 3) o.push(rgb[i], rgb[i + 1], rgb[i + 2], 255); return o; };
const distinct = (px: number[]) => new Set(px.filter((_, i) => i % 4 === 0)).size;

describe('WebGPU path', () => {
  let h: Harness, page: any, gpuOk = false;
  before(async () => {
    h = await startHarness(WEBGPU_ARGS);
    page = await h.page();
    gpuOk = await page.evaluate(async () => !!(navigator.gpu && await navigator.gpu.requestAdapter()));
    if (!gpuOk) console.log('# WebGPU is not available in this headless Chromium; GPU tests are skipped');
  });
  after(async () => { await h.close(); });

  test('matches the CPU reference renderer (both looks, another light, colour view)', async (t) => {
    if (!gpuOk) return t.skip('no WebGPU');
    const c = parityCanvas(), surfaceB64 = Buffer.from(encodeSurface(surfaceFromCanvas(c), { version: 1 })).toString('base64');
    for (const { name, light, view } of PARITY_CASES) {
      const r = await page.evaluate(RENDER_IN_PAGE, { surfaceB64, opts: {}, light, view });
      assert.equal(r.mode, 'webgpu', r.reason);
      const d = compareRgb(relight(c, light, view), r.pixels);
      t.diagnostic(`${name}: mean ${d.mean.toFixed(3)}, max ${d.max}`);
      assert.ok(d.mean < 1, `${name}: mean difference ${d.mean} levels`);
      assert.ok(d.over4 < 0.001, `${name}: ${d.over4} of channels differ by more than 4`);
      await page.evaluate(() => (window as any).__v.destroy());
    }
  });

  test('the on-screen canvas shows what readPixels returns, and the light moves it', async (t) => {
    if (!gpuOk) return t.skip('no WebGPU');
    const r = await page.evaluate(RENDER_IN_PAGE, { surfaceB64: tinyB64, opts: {} });
    assert.equal(r.mode, 'webgpu', r.reason);
    assert.equal(r.w, tiny.w); assert.equal(r.h, tiny.h);
    assert.ok(compareRgb(tinyRef, r.pixels).mean < 1);
    // Presented frame: a screenshot of the canvas element at 1:1.
    await page.evaluate(() => { const c = (window as any).__v.canvas; c.style.cssText = 'position:fixed;left:0;top:0;width:' + c.width + 'px;height:' + c.height + 'px'; (window as any).__v.render(); });
    await page.waitForTimeout(200);
    const file = join(mkdtempSync(join(tmpdir(), 'viewer-')), 'shot.png');
    await page.screenshot({ path: file, clip: { x: 0, y: 0, width: tiny.w, height: tiny.h } });
    const shot = rgbToRgba(readPng(file).data as unknown as Uint8ClampedArray);
    const d = compareRgb(tinyRef, shot);
    t.diagnostic(`screen vs CPU: mean ${d.mean.toFixed(3)}, max ${d.max}`);
    assert.ok(d.mean < 2, `presented canvas differs by ${d.mean} levels on average`);
    const moved = await page.evaluate(async () => { const v = (window as any).__v; v.setLight({ azimuth: 45, elevation: 60 }); return Array.from(await v.readPixels()); });
    assert.ok(compareRgb(tinyRef, moved).mean > 3, 'moving the light changes the picture');
    const lookDiff = await page.evaluate(async () => { const v = (window as any).__v; const a = await v.readPixels(); v.setLook('oil'); const b = await v.readPixels(); v.setView('height'); const c = await v.readPixels(); let ab = 0, bc = 0; for (let i = 0; i < a.length; i++) { ab += Math.abs(a[i] - b[i]); bc += Math.abs(b[i] - c[i]); } return [ab / a.length, bc / a.length]; });
    assert.ok(lookDiff[0] > 0.05 && lookDiff[1] > 5, `look and view change the picture (${lookDiff})`);
    await page.evaluate(() => (window as any).__v.destroy());
  });

  test('dragging on the canvas moves the light (linear and radial mappings)', async (t) => {
    if (!gpuOk) return t.skip('no WebGPU');
    await page.evaluate(RENDER_IN_PAGE, { surfaceB64: tinyB64, opts: {} });
    await page.evaluate(() => { const w = window as any, c = w.__v.canvas; c.style.cssText = 'position:fixed;left:0;top:0;width:240px;height:180px'; w.__detach = w.V.attachPointerLight(w.__v); });
    await page.mouse.move(60, 45); await page.mouse.down(); await page.mouse.move(180, 135, { steps: 3 }); await page.mouse.up();
    let l = await page.evaluate(() => ({ ...(window as any).__v.light }));
    assert.equal(l.azimuth, 90); assert.equal(l.elevation, 25); // x 3/4 -> (1 - 0.75) * 360; y 3/4 -> 85 - 0.75 * 80
    await page.evaluate(() => { const w = window as any; w.__detach(); w.__detach = w.V.attachPointerLight(w.__v, undefined, { mapping: 'radial' }); });
    await page.mouse.move(0, 0); await page.mouse.down(); await page.mouse.up(); // upper-left corner: light from the upper left, grazing
    l = await page.evaluate(() => ({ ...(window as any).__v.light }));
    assert.equal(l.elevation, 5); assert.ok(Math.abs(l.azimuth - 217) <= 1, `azimuth ${l.azimuth}`);
    await page.evaluate(() => { const w = window as any; w.__detach(); w.__v.destroy(); });
  });

  test('a lost device falls back to the static image on a fresh canvas', async (t) => {
    if (!gpuOk) return t.skip('no WebGPU');
    const r = await page.evaluate(async ({ surfaceB64, fallbackB64 }) => {
      const w = window as any;
      const surface = w.S.decodeSurface(Uint8Array.from(atob(surfaceB64), (c) => c.charCodeAt(0)));
      const canvas = document.createElement('canvas'); canvas.id = 'lossy'; document.body.append(canvas);
      const reasons: string[] = [];
      const v = await w.V.createImpastoViewer(canvas, surface, { fallback: { width: surface.w, height: surface.h, data: Uint8Array.from(atob(fallbackB64), (c) => c.charCodeAt(0)) }, onFallback: (x: string) => reasons.push(x) });
      const before = v.mode;
      const changed = new Promise((ok) => v.addEventListener('modechange', ok, { once: true }));
      v.gpuDevice.destroy();
      await Promise.race([changed, new Promise((ok) => setTimeout(ok, 5000))]);
      const px = await v.readPixels();
      return { before, mode: v.mode, reason: v.fallbackReason, reasons, swapped: v.canvas !== canvas, inDom: document.getElementById('lossy') === v.canvas, gpu: v.gpuDevice, pixels: Array.from(px) };
    }, { surfaceB64: tinyB64, fallbackB64: tinyRefB64 });
    assert.equal(r.before, 'webgpu');
    assert.equal(r.mode, 'static');
    assert.match(r.reason, /device lost/);
    assert.equal(r.reasons.length, 1);
    assert.ok(r.swapped && r.inDom, 'the canvas is replaced in place');
    assert.equal(r.gpu, null);
    assert.deepEqual(r.pixels, rgbToRgba(tinyRef));
  });
});

describe('static fallback', () => {
  let h: Harness;
  before(async () => { h = await startHarness(WEBGPU_ARGS); });
  after(async () => { await h.close(); });

  test('without navigator.gpu it shows the supplied image exactly', async () => {
    const page = await h.page({ initScript: NO_GPU });
    const r = await page.evaluate(RENDER_IN_PAGE, { surfaceB64: tinyB64, opts: { fallbackB64: tinyRefB64 } });
    assert.equal(r.mode, 'static');
    assert.match(r.reason, /navigator\.gpu/);
    assert.deepEqual(r.reasons, [r.reason]);
    assert.equal(r.interactive, false);
    assert.deepEqual(r.pixels, rgbToRgba(tinyRef));
    // Other views still render, from the approximation.
    const color = await page.evaluate(async () => { const v = (window as any).__v; v.setView('color'); return Array.from(await v.readPixels()); });
    assert.ok(compareRgb(relight(tiny, DEFAULT_LIGHT, 'color'), color).mean < 1, 'colour view matches the CPU one');
    await page.close();
  });

  test('without an image it shades the surface itself, and the light still moves it', async () => {
    const page = await h.page({ initScript: NO_GPU });
    const r = await page.evaluate(RENDER_IN_PAGE, { surfaceB64: tinyB64, opts: {} });
    assert.equal(r.mode, 'static');
    assert.equal(r.interactive, true);
    assert.equal(r.w, tiny.w);
    assert.ok(distinct(r.pixels) > 20, 'shaded, not flat');
    const d = compareRgb(tinyRef, r.pixels);
    assert.ok(d.mean < 25, `roughly like the reference (mean ${d.mean.toFixed(1)} levels)`);
    const moved = await page.evaluate(async () => { const v = (window as any).__v; v.setLight({ azimuth: 45, elevation: 20 }); await new Promise((ok) => requestAnimationFrame(() => ok(0))); return Array.from(await v.readPixels()); });
    assert.ok(compareRgb(tinyRef, moved).mean > d.mean + 2, 'moving the light changes the shading');
    await page.close();
  });

  test('a null adapter and forceStatic both end in static mode without throwing', async () => {
    const page = await h.page();
    const a = await page.evaluate(RENDER_IN_PAGE, { surfaceB64: tinyB64, opts: { nullAdapter: true } });
    assert.equal(a.mode, 'static'); assert.match(a.reason, /no WebGPU adapter/);
    const b = await page.evaluate(RENDER_IN_PAGE, { surfaceB64: tinyB64, opts: { forceStatic: true, fallbackB64: tinyRefB64 } });
    assert.equal(b.mode, 'static'); assert.match(b.reason, /forceStatic/);
    assert.deepEqual(b.pixels, rgbToRgba(tinyRef));
    const bad = await page.evaluate(async () => { try { await (window as any).V.createImpastoViewer(document.createElement('canvas'), { w: 2, h: 2, dx: 0.1, maxH: 0, height: new Float32Array(3), color: new Float32Array(16) }); return 'no error'; } catch (e) { return (e as Error).name; } });
    assert.equal(bad, 'TypeError', 'a malformed surface is a programming error');
    await page.close();
  });
});

describe('browsers without working WebGPU', () => {
  test('WebGPU switched off: static, with pixels drawn', async () => {
    const h = await startHarness(NO_WEBGPU_ARGS);
    try {
      const page = await h.page();
      const r = await page.evaluate(RENDER_IN_PAGE, { surfaceB64: tinyB64, opts: { fallbackB64: tinyRefB64 } });
      assert.equal(r.mode, 'static', 'expected no adapter with WebGPU disabled');
      assert.deepEqual(r.pixels, rgbToRgba(tinyRef));
    } finally { await h.close(); }
  });

  test('a device lost on its first present (headless Chromium without ANGLE) falls back', async (t) => {
    const h = await startHarness(WEBGPU_LOSSY_ARGS);
    try {
      const page = await h.page();
      const r = await page.evaluate(async ({ surfaceB64 }) => {
        const w = window as any;
        const surface = w.S.decodeSurface(Uint8Array.from(atob(surfaceB64), (c) => c.charCodeAt(0)));
        const canvas = document.createElement('canvas'); document.body.append(canvas);
        const v = await w.V.createImpastoViewer(canvas, surface);
        const first = v.mode;
        if (first === 'webgpu') await Promise.race([new Promise((ok) => v.addEventListener('modechange', ok, { once: true })), new Promise((ok) => setTimeout(ok, 5000))]);
        return { first, mode: v.mode, reason: v.fallbackReason, pixels: Array.from(await v.readPixels()) };
      }, { surfaceB64: tinyB64 });
      if (r.first !== 'webgpu' || r.mode === 'webgpu') return t.skip(`this Chromium did not lose the device (first ${r.first}, now ${r.mode}: ${r.reason})`);
      t.diagnostic(r.reason);
      assert.equal(r.mode, 'static');
      assert.ok(distinct(r.pixels) > 20, 'the approximation is drawn');
    } finally { await h.close(); }
  });
});

describe('demo page', () => {
  let h: Harness;
  const html = viewerHtml(tiny, 'Tiny');
  before(async () => { h = await startHarness(WEBGPU_ARGS); });
  after(async () => { await h.close(); });

  test('shows the mode, follows drags, toggles static and opens .impasto files', async () => {
    const page = await h.browser.newPage();
    const errors: string[] = [];
    page.on('pageerror', (e: Error) => errors.push(e.message));
    await page.goto(h.serve(html));
    await page.waitForFunction('window.__ready === true');
    const mode = await page.evaluate(() => (window as any).__viewer.mode);
    assert.equal(await page.textContent('#mode'), mode === 'webgpu' ? 'Live WebGPU' : 'Static fallback image');
    // Drag across the canvas: the azimuth slider follows the viewer.
    const box = await page.locator('#frame canvas').boundingBox();
    await page.mouse.move(box.x + box.width * 0.75, box.y + box.height * 0.5); await page.mouse.down(); await page.mouse.up();
    if (mode === 'webgpu') assert.equal(await page.inputValue('#azimuth'), '90');
    // Force the static fallback: indicator and image switch.
    await page.check('#static');
    await page.waitForFunction(() => (window as any).__viewer?.mode === 'static');
    assert.equal(await page.textContent('#mode'), 'Static fallback image');
    assert.deepEqual(Array.from(await page.evaluate(async () => Array.from(await (window as any).__viewer.readPixels()))), rgbToRgba(tinyRef));
    await page.uncheck('#static');
    // Open a gzipped .impasto file through the file input.
    const other = surfaceFromCanvas(parityCanvas());
    await page.setInputFiles('#file', { name: 'parity.impasto.gz', mimeType: 'application/octet-stream', buffer: gzipSync(encodeSurface(other)) });
    await page.waitForFunction((w: number) => (window as any).__viewer?.surface.w === w, other.w);
    assert.equal(await page.textContent('h1'), 'parity.impasto.gz');
    assert.match(await page.textContent('#size') ?? '', /400 × 300 cells, 40 × 30 mm/);
    await page.setInputFiles('#file', { name: 'junk.impasto', mimeType: 'application/octet-stream', buffer: Buffer.from('not a surface') });
    await page.waitForFunction(() => document.getElementById('err')!.textContent !== '');
    assert.match(await page.textContent('#err') ?? '', /bad magic/);
    assert.deepEqual(errors, []);
    await page.close();
  });

  test('without WebGPU the page says so and still draws', async () => {
    const page = await h.browser.newPage();
    await page.addInitScript(NO_GPU);
    await page.goto(h.serve(html));
    await page.waitForFunction('window.__ready === true');
    assert.equal(await page.getAttribute('#mode', 'class'), 'static');
    assert.match(await page.textContent('#reason') ?? '', /navigator\.gpu/);
    // A loaded file has no CPU render, so the page switches to approximate shading.
    await page.evaluate((b64: string) => (window as any).__load(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)), 'tiny.impasto'), tinyB64);
    await page.waitForFunction(() => (window as any).__viewer?.interactive === true);
    assert.equal(await page.textContent('#mode'), 'Static fallback, approximate shading');
    await page.close();
  });

  test('an empty page offers to open a file', async () => {
    const page = await h.browser.newPage();
    await page.goto(h.serve(viewerPage(null)));
    await page.waitForFunction('window.__ready === true');
    assert.equal(await page.textContent('#mode'), 'No painting');
    await page.evaluate((b64: string) => (window as any).__load(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)), 'tiny.impasto'), tinyB64);
    await page.waitForFunction(() => !!(window as any).__viewer);
    assert.ok(['Live WebGPU', 'Static fallback, approximate shading'].includes((await page.textContent('#mode'))!));
    await page.close();
  });
});
