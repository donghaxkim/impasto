/**
 * Renders a small scene through the browser viewer (`src/viewer.ts`, the WebGPU path running
 * RELIGHT_WGSL on SwiftShader in headless Chromium) and with the CPU reference, for each look and
 * one non-default light, and reports how far the pixels differ.
 *   node --experimental-strip-types tests/gpu-parity.ts
 * Exit code 0 when every mean difference is under one 8-bit level, 2 when WebGPU is unavailable.
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

if (import.meta.url === `file://${process.argv[1]}`) {
  const c = parityCanvas();
  const surfaceB64 = Buffer.from(encodeSurface(surfaceFromCanvas(c), { version: 1 })).toString('base64'); // lossless: compare renderers, not the file format
  const h = await startHarness(WEBGPU_ARGS);
  const page = await h.page();
  let worst = 0;
  for (const { name, light, view } of PARITY_CASES) {
    const r = await page.evaluate(RENDER_IN_PAGE, { surfaceB64, opts: {}, light, view });
    if (r.mode !== 'webgpu') { console.log('WebGPU unavailable:', r.reason); await h.close(); process.exit(2); }
    const d = compareRgb(relight(c, light, view), r.pixels);
    console.log(`${name.padEnd(42)} mean |diff| ${d.mean.toFixed(3)} levels, max ${d.max}, ${(100 * d.over4).toFixed(3)}% of channels differ by more than 4`);
    worst = Math.max(worst, d.mean);
    await page.evaluate(() => (window as any).__v.destroy());
  }
  await h.close();
  process.exit(worst < 1 ? 0 : 1);
}
