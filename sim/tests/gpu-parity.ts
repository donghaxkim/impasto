/**
 * Renders a small scene through the browser viewer (`src/viewer.ts`) on each live backend, WebGPU
 * (RELIGHT_WGSL) and WebGL2 (relight-gl.ts, with an RGBA32F and, hiding EXT_color_buffer_float,
 * an RGBA16F HDR target), in headless Chromium where both run on SwiftShader, and with the CPU
 * reference, for each look and one non-default light, and reports how far the pixels differ.
 *   node --experimental-strip-types tests/gpu-parity.ts            # npm run gpu-parity
 *   node --experimental-strip-types tests/gpu-parity.ts --time     # also frame times at 1200 x 900
 * Exit code 0 when every mean difference is under one 8-bit level, 1 when one is not, 2 when a
 * backend is unavailable.
 */
import { DEFAULT_LIGHT, relight, type LightSettings, type View } from '../src/relight.ts';
import { encodeSurface, surfaceFromCanvas } from '../src/surface.ts';
import { compareRgb, parityCanvas, RENDER_IN_PAGE, startHarness, WEBGPU_ARGS } from './viewer-harness.ts';

export const PARITY_CASES: { name: string; light: LightSettings; view: View }[] = [
  { name: 'locked', light: { ...DEFAULT_LIGHT, look: 'locked' }, view: 'paint' },
  { name: 'oil', light: { ...DEFAULT_LIGHT, look: 'oil' }, view: 'paint' },
  { name: 'oil, low light from the right, relief 1.6', light: { ...DEFAULT_LIGHT, look: 'oil', azimuth: 20, elevation: 18, relief: 1.6, glow: 1.5 }, view: 'paint' },
  { name: 'colour view', light: { ...DEFAULT_LIGHT }, view: 'color' },
];

/**
 * Viewer options that force each live backend. Headless Chromium only has software (SwiftShader)
 * WebGL, which the viewer refuses unless `webgl.software` is set.
 */
export const LIVE_BACKENDS: { name: string; mode: 'webgpu' | 'webgl2'; opts: Record<string, unknown> }[] = [
  { name: 'WebGPU', mode: 'webgpu', opts: { backends: ['webgpu'] } },
  { name: 'WebGL2', mode: 'webgl2', opts: { backends: ['webgl2'], webgl: { software: true } } },
  { name: 'WebGL2 half-float', mode: 'webgl2', opts: { backends: ['webgl2'], webgl: { software: true, hideExtensions: ['EXT_color_buffer_float'] } } },
];

/**
 * In the page: tiles the decoded surface `tiles` x `tiles`, makes a viewer with `opts`, and times
 * `frames` light changes after one warm-up frame, each drawn and waited for (a 1-pixel readback
 * for WebGL2, the queue for WebGPU, nothing for the synchronous static path).
 */
export const TIME_IN_PAGE = async ({ surfaceB64, opts, tiles, frames }: { surfaceB64: string; opts: Record<string, unknown>; tiles: number; frames: number }) => {
  const w = window as any;
  const s = w.S.decodeSurface(Uint8Array.from(atob(surfaceB64), (c) => c.charCodeAt(0)));
  const W = s.w * tiles, H = s.h * tiles, height = new Float32Array(W * H * 2), color = new Float32Array(W * H * 4);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = y * W + x, j = (y % s.h) * s.w + (x % s.w);
    height.set(s.height.subarray(j * 2, j * 2 + 2), i * 2); color.set(s.color.subarray(j * 4, j * 4 + 4), i * 4);
  }
  const canvas = document.createElement('canvas'); document.body.append(canvas);
  let t = performance.now();
  const v = await w.V.createImpastoViewer(canvas, { w: W, h: H, dx: s.dx, maxH: s.maxH, height, color }, opts);
  const setupMs = performance.now() - t;
  const px = new Uint8Array(4);
  const frame = async (k: number) => {
    const t0 = performance.now();
    v.setLight({ azimuth: (225 + 37 * k) % 360 });
    v.render();
    if (v.mode === 'webgl2') v.glContext.readPixels(0, 0, 1, 1, v.glContext.RGBA, v.glContext.UNSIGNED_BYTE, px);
    else if (v.mode === 'webgpu') await v.gpuDevice.queue.onSubmittedWorkDone();
    return performance.now() - t0;
  };
  const first = await frame(0), times: number[] = [];
  for (let k = 1; k <= frames; k++) times.push(await frame(k));
  const mode = v.mode, reason = v.fallbackReason;
  v.destroy(); canvas.remove();
  times.sort((a, b) => a - b);
  return { mode, reason, w: W, h: H, setupMs, firstMs: first, medianMs: times[times.length >> 1], minMs: times[0] };
};

if (import.meta.url === `file://${process.argv[1]}`) {
  const c = parityCanvas();
  const surfaceB64 = Buffer.from(encodeSurface(surfaceFromCanvas(c))).toString('base64');
  const h = await startHarness(WEBGPU_ARGS);
  const page = await h.page();
  let worst = 0, missing = false;
  for (const b of LIVE_BACKENDS) {
    console.log(`${b.name}:`);
    for (const { name, light, view } of PARITY_CASES) {
      const r = await page.evaluate(RENDER_IN_PAGE, { surfaceB64, opts: b.opts, light, view });
      if (r.mode !== b.mode) { console.log(`  unavailable: ${r.reason}`); missing = true; break; }
      const d = compareRgb(relight(c, light, view), r.pixels);
      console.log(`  ${name.padEnd(42)} mean |diff| ${d.mean.toFixed(3)} levels, max ${d.max}, ${(100 * d.over4).toFixed(3)}% of channels differ by more than 4`);
      worst = Math.max(worst, d.mean);
      await page.evaluate(() => (window as any).__v.destroy());
    }
  }
  if (process.argv.includes('--time')) {
    const frames = 3;
    console.log(`\nFrame time, parity scene tiled 3 x 3 (${c.w * 3} x ${c.h * 3} cells), median of ${frames} light changes after a warm-up (SwiftShader: a CPU rasteriser, not a GPU):`);
    for (const b of [...LIVE_BACKENDS.slice(0, 2), { name: 'static (approximate shading)', mode: 'static', opts: { backends: ['static'] } }]) {
      const r = await page.evaluate(TIME_IN_PAGE, { surfaceB64, opts: b.opts, tiles: 3, frames });
      if (r.mode !== b.mode) { console.log(`  ${b.name}: unavailable (${r.reason})`); continue; }
      console.log(`  ${b.name.padEnd(30)} ${r.medianMs.toFixed(0)} ms per frame (min ${r.minMs.toFixed(0)}; first ${r.firstMs.toFixed(0)}; setup ${r.setupMs.toFixed(0)} ms)`);
    }
  }
  await h.close();
  process.exit(missing ? 2 : worst < 1 ? 0 : 1);
}
