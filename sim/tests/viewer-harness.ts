/**
 * Headless-Chromium harness for the browser viewer (`src/viewer.ts`): serves a page that imports
 * the real module through the same import map the demo pages use, and drives it from Node.
 * Chromium and Playwright come preinstalled; nothing here installs anything.
 */
import { createRequire } from 'node:module';
import http from 'node:http';
import { PaintCanvas } from '../src/canvas.ts';
import { paintStroke, Tool } from '../src/tool.ts';
import { viewerImportMap } from '../src/viewer-bundle.ts';

const { chromium } = createRequire(import.meta.url)('playwright');

/**
 * Flags that give headless Chromium a software (SwiftShader) WebGPU adapter. The ANGLE flags matter
 * for on-screen canvases: without them, presenting a WebGPU canvas in headless Chromium loses the
 * device ("A valid external Instance reference no longer exists"); offscreen rendering works either way.
 */
export const WEBGPU_ARGS = ['--enable-unsafe-webgpu', '--ignore-gpu-blocklist', '--enable-features=Vulkan', '--use-vulkan=swiftshader', '--use-webgpu-adapter=swiftshader', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'];
/** WebGPU flags without the ANGLE ones: the device is lost on the first present, which exercises the device-loss fallback. */
export const WEBGPU_LOSSY_ARGS = WEBGPU_ARGS.slice(0, 5);
/** Flags that turn WebGPU off, for the fallback tests. */
export const NO_WEBGPU_ARGS = ['--disable-features=WebGPU,Vulkan', '--disable-gpu'];

/** A small canvas with crests, heaps, berms and a crevice (the gpu-parity scene). */
export function parityCanvas(): PaintCanvas {
  const c = new PaintCanvas(40, 30, 0.1, [0.58, 0.47, 0.37], 7);
  const knife = new Tool({ kind: 'knife', widthMm: 12, nodes: 112, seed: 5 });
  knife.load(12, [0.86, 0.30, 0.20], [0.97, 0.88, 0.70], 0.28, 11);
  paintStroke(c, knife, { points: [[3, 10], [14, 8], [26, 11], [38, 9]], gapMm: 1.0, seed: 3 });
  knife.load(10, [0.12, 0.42, 0.47], [0.86, 0.66, 0.28], 0.25, 12);
  paintStroke(c, knife, { points: [[3, 21], [14, 17], [26, 22], [38, 18]], gapMm: 0.9, seed: 4 });
  return c;
}

/** A 120 x 90 cell canvas with one loaded knife stroke, for the quicker behaviour tests. */
export function tinyCanvas(): PaintCanvas {
  const c = new PaintCanvas(12, 9, 0.1, [0.58, 0.47, 0.37], 3);
  const knife = new Tool({ kind: 'knife', widthMm: 5, nodes: 48, seed: 9 });
  knife.load(4, [0.20, 0.45, 0.70], [0.95, 0.90, 0.75], 0.25, 2);
  paintStroke(c, knife, { points: [[1.5, 4.5], [4.5, 3.6], [7.5, 5.2], [10.5, 4.2]], gapMm: 0.8, seed: 8 });
  return c;
}

export interface Harness {
  browser: any;
  /** A fresh page with `window.V` (viewer module) and `window.S` (surface module) loaded. */
  page(opts?: { initScript?: string }): Promise<any>;
  /** Serves `html` at a fresh path on the local server (WebGPU needs a secure context, which localhost is). */
  serve(html: string): string;
  close(): Promise<void>;
}

export async function startHarness(args: string[]): Promise<Harness> {
  const pages = new Map<string, string>();
  pages.set('/', `<!doctype html><meta charset="utf-8"><title>viewer test</title><body>${viewerImportMap()}
<script type="module">import * as V from 'impasto/viewer'; import * as S from 'impasto/surface'; window.V = V; window.S = S; window.__ready = true;</script>`);
  const server = http.createServer((q, r) => {
    const body = pages.get((q.url ?? '/').split('?')[0]);
    if (body === undefined) { r.statusCode = 404; r.end(); return; }
    r.setHeader('content-type', 'text/html'); r.end(body);
  }).listen(0);
  await new Promise((ok) => server.once('listening', ok));
  const base = `http://localhost:${(server.address() as { port: number }).port}`;
  const browser = await chromium.launch({ args });
  let n = 0;
  return {
    browser,
    async page(opts = {}) {
      const p = await browser.newPage();
      p.on('pageerror', (e: Error) => console.error('[page error]', e.message));
      if (opts.initScript) await p.addInitScript(opts.initScript);
      await p.goto(base + '/');
      await p.waitForFunction('window.__ready === true');
      return p;
    },
    serve(html) { const path = `/page${++n}`; pages.set(path, html); return base + path; },
    async close() { await browser.close(); server.close(); },
  };
}

/** Mean and max absolute difference between two RGB (CPU) and RGBA (viewer) byte arrays. */
export function compareRgb(cpuRgb: ArrayLike<number>, rgba: ArrayLike<number>): { mean: number; max: number; over4: number } {
  let sum = 0, max = 0, over4 = 0;
  const n = cpuRgb.length / 3;
  for (let i = 0; i < n; i++) for (let k = 0; k < 3; k++) {
    const d = Math.abs(cpuRgb[i * 3 + k] - rgba[i * 4 + k]);
    sum += d; if (d > max) max = d; if (d > 4) over4++;
  }
  return { mean: sum / (n * 3), max, over4: over4 / (n * 3) };
}

/** Script run in the page: builds a viewer from base64 `.impasto` bytes and returns its state and pixels. */
export const RENDER_IN_PAGE = async ({ surfaceB64, opts, light, view, look }: { surfaceB64: string; opts: Record<string, unknown>; light?: object; view?: string; look?: string }) => {
  const w = window as any;
  const bytes = Uint8Array.from(atob(surfaceB64), (c) => c.charCodeAt(0));
  const surface = w.S.decodeSurface(bytes);
  const canvas = document.createElement('canvas');
  document.body.append(canvas);
  const reasons: string[] = [];
  const o: any = { ...opts, onFallback: (r: string) => reasons.push(r) };
  if (o.fallbackB64) { o.fallback = { width: surface.w, height: surface.h, data: Uint8Array.from(atob(o.fallbackB64), (c) => c.charCodeAt(0)) }; delete o.fallbackB64; }
  if (o.nullAdapter) { o.gpu = { requestAdapter: async () => null, getPreferredCanvasFormat: () => 'rgba8unorm' }; delete o.nullAdapter; }
  const v = await w.V.createImpastoViewer(canvas, surface, o);
  w.__v = v;
  if (light) v.setLight(light);
  if (look) v.setLook(look);
  if (view) v.setView(view);
  const px: Uint8ClampedArray = await v.readPixels();
  return { mode: v.mode, reason: v.fallbackReason, reasons, interactive: v.interactive, w: v.canvas.width, h: v.canvas.height, pixels: Array.from(px) };
};
