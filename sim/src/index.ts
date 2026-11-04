/**
 * impasto-sim library entry: photo in, palette-knife oil painting out.
 *
 *   const result = await renderImpasto(imageData, { preset: 'oil', widthMm: 240 });
 *   ctx.putImageData(new ImageData(result.image.data, result.image.width), 0, 0);
 *
 * Runs in browsers, workers and Node. No Node or DOM modules are imported: browser image sources
 * are feature-detected at run time. The work is synchronous CPU work between `await`s (one layer at
 * a time, a few seconds to a minute each), so on a page's main thread the tab stays only partly
 * responsive; use `impasto-sim/worker` (see `renderInWorker`) to keep it off the main thread.
 */
import { type Plan, type PlanSettings } from './planner.ts';
import { relight, type LightSettings } from './relight.ts';
import { surfaceFromCanvas, type ImpastoSurface } from './surface.ts';
import type { RgbImage } from './image.ts';
import { paintPipeline, type PipelineEvent, type PipelineResult } from './pipeline.ts';
import { PRESET_NAMES, resolvePreset, type PresetName } from './presets.ts';
import { DEFAULT_SNAPSHOT_MAX_SIDE, snapshotFactor, strokesToJSON, surfaceSnapshot, type ImpastoStroke } from './snapshot.ts';

export type { ImpastoSurface } from './surface.ts';
export type { LightSettings, LookName } from './relight.ts';
export type { Plan, PlanSettings, PlannedStroke, LayerSpec } from './planner.ts';
export { DEFAULT_LIGHT, relightSurface } from './relight.ts';
export { DEFAULT_SETTINGS } from './planner.ts';
export { PRESETS, PRESET_NAMES, resolvePreset, type PresetName, type Preset } from './presets.ts';
export { surfaceFromCanvas, encodeSurface, decodeSurface, SURFACE_VERSION, SURFACE_FLAG_OCCLUSION, type EncodeSurfaceOptions } from './surface.ts';
export { DEFAULT_SNAPSHOT_MAX_SIDE, downsampleSurface, snapshotFactor, strokesToJSON, type ImpastoStroke, type Rgb01 } from './snapshot.ts';

// ---------------------------------------------------------------------------------------------
// Errors

export type ImpastoErrorCode =
  /** Not an image the library can read (wrong type, or a browser source outside a browser). */
  | 'UNSUPPORTED_SOURCE'
  /** Width or height is zero, negative or not an integer. */
  | 'EMPTY_IMAGE'
  /** `data` is not a Uint8Array / Uint8ClampedArray of width x height x 3 (RGB) or x 4 (RGBA) bytes. */
  | 'BAD_DATA'
  /** One side is more than MAX_ASPECT times the other. */
  | 'BAD_ASPECT'
  /** More than MAX_PIXELS pixels or a side longer than MAX_SIDE_PX. Downscale first; detail comes from widthMm, not pixels. */
  | 'IMAGE_TOO_LARGE'
  /** The browser could not decode the image. */
  | 'DECODE_FAILED'
  /** An option has the wrong type or value. */
  | 'BAD_OPTION'
  /** renderInWorker / planInWorker: the worker failed to load, crashed, or sent something unreadable. */
  | 'WORKER_FAILED';

export class ImpastoError extends Error {
  readonly code: ImpastoErrorCode;
  constructor(code: ImpastoErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'ImpastoError';
    this.code = code;
  }
}

// ---------------------------------------------------------------------------------------------
// Inputs

/** Decoded pixels, row-major, 8-bit sRGB. ImageData fits. */
export interface ImpastoPixels {
  width: number;
  height: number;
  /** RGBA (4 bytes per pixel) or RGB (3). Alpha below 255 is composited over white. */
  data: Uint8Array | Uint8ClampedArray;
  /** Bytes per pixel. Inferred from data.length when omitted. */
  channels?: 3 | 4;
}
/**
 * Browser sources, typed structurally so the types work without the DOM lib: ImageBitmap,
 * HTMLImageElement, HTMLCanvasElement or OffscreenCanvas (anything a 2D canvas can draw), or a
 * Blob / File of an encoded image (needs createImageBitmap). Not available in Node: decode there
 * yourself (e.g. with sharp or pngjs) and pass ImpastoPixels.
 */
export interface DrawableLike { readonly width: number; readonly height: number }
export interface BlobLike { readonly size: number; readonly type: string; arrayBuffer(): Promise<ArrayBuffer> }
export type ImpastoImageSource = ImpastoPixels | DrawableLike | BlobLike;

/** Largest accepted image, in pixels (an 8K photo). Larger images gain nothing: see widthMm. */
export const MAX_PIXELS = 50_000_000;
export const MAX_SIDE_PX = 16384;
/** Largest ratio of the long side to the short side. */
export const MAX_ASPECT = 8;
/** Canvas width range, mm. Below ~120 mm the knives (2.4-15 mm, scaled up for close-ups) leave little detail. */
export const MIN_WIDTH_MM = 20;
/**
 * Longest canvas side, mm. The canvas is simulated at 0.1 mm per cell, so time and memory grow with
 * area. Measured: the 1440 x 692 lake photo at the default 240 mm (240 x 115 mm) took 1 min 45 s
 * of CPU (4 min wall on a busy machine) and 0.8 GB; 360 x 240 mm is about three times that.
 */
export const MAX_SIDE_MM = 480;

export interface ProgressInfo {
  /** 'analyse': reading the image; 'paint': planning and painting layer `layer` of `layers`; 'relight': shading; 'done'. */
  stage: 'analyse' | 'paint' | 'relight' | 'done';
  layer?: number;
  layers?: number;
  /** Name of the layer being painted (underpaint, block-in, masses, ...). */
  layerName?: string;
  /** Share of the work done, 0-1, never decreasing. Layers count equally, so it is a rough guide to time. */
  fraction: number;
}

/**
 * The canvas after one layer, for showing the painting come together (renderImpasto's onLayer).
 * Plain data: structured-cloneable, and everything except `surface` is JSON-serialisable.
 */
export interface LayerSnapshot {
  /** Layer index, 0-based, and the number of layers. */
  layer: number;
  layers: number;
  /** Layer name: underpaint, block-in, masses, presses, forms, detail, contours, accents. */
  name: string;
  /**
   * True for the one extra snapshot after the thin lights held back by PlanSettings.deferThin (off
   * by default), painted last with the last layer: then `layer` is layers - 1 a second time.
   */
  deferred: boolean;
  /** Progress at the end of this layer, 0-1 (the same scale as onProgress). */
  fraction: number;
  /** This layer's strokes in paint order. */
  strokes: ImpastoStroke[];
  /**
   * The canvas after this layer, box-downsampled so its longest side is at most snapshot.maxSide
   * cells (`dx` is the snapshot's cell size in mm; `scale` full-size cells per snapshot cell).
   * At full size (scale 1) it is exactly what surfaceFromCanvas gives, as the result's surface.
   * Fresh buffers for every snapshot: keep them, upload them or transfer them.
   */
  surface: ImpastoSurface;
  scale: number;
  /** Canvas size, mm. The snapshot covers surface.w x surface.dx mm, which can exceed widthMm by less than one snapshot cell. */
  widthMm: number;
  heightMm: number;
  /** Milliseconds spent planning and simulating this layer. */
  planMs: number;
  paintMs: number;
}

export interface SnapshotOptions {
  /**
   * Longest side of the snapshot surface, in cells (default DEFAULT_SNAPSHOT_MAX_SIDE, 600).
   * The canvas is shrunk by the smallest whole factor that fits. Infinity gives full resolution
   * (0.1 mm cells: 2400 x 1150 for a 240 mm landscape, 24 bytes a cell).
   */
  maxSide?: number;
}

export interface ImpastoOptions {
  /** 'oil' (default) the intended look; 'locked' the round-3 reference; 'smooth' calmer and more blended. */
  preset?: PresetName;
  /**
   * Canvas width in mm (default DEFAULT_SETTINGS.widthMm, 240); the height follows the image.
   * Knives have physical sizes, so this sets how much detail the painting has: 240 reads as a
   * small painting, 360 resolves a landscape's trees. Clamped to MIN_WIDTH_MM and to a longest side
   * of MAX_SIDE_MM; time grows with area (see MAX_SIDE_MM). The result reports the width used.
   */
  widthMm?: number;
  /** Integer seed (default 1). The same image, options and seed give the same painting, on any engine. */
  seed?: number;
  /** Light for the returned image, over the preset's light (azimuth, elevation, relief, exposure, glow, look). */
  light?: Partial<LightSettings>;
  onProgress?: (info: ProgressInfo) => void;
  /**
   * renderImpasto only: called after each layer is painted, in order, with the canvas so far and
   * the layer's strokes (see LayerSnapshot). Snapshots are only computed when this is set, and they
   * never change the painting. If it throws, the error is reported (globalThis.reportError where
   * there is one, as for an uncaught error in an event listener, else console.error) and the render
   * carries on. Through renderInWorker it is called on the page with the worker's snapshots.
   */
  onLayer?: (snapshot: LayerSnapshot) => void;
  /** Size of the onLayer snapshots. */
  snapshot?: SnapshotOptions;
  /** Checked between stages and layers; aborting rejects with signal.reason (an AbortError DOMException by default). */
  signal?: AbortSignal;
  /**
   * UNSTABLE escape hatch: raw planner settings over the preset (PlanSettings in planner.ts). Names
   * and meanings change between versions without notice. widthMm and seed here win over the options.
   */
  advanced?: Partial<PlanSettings>;
}

export interface ImpastoImage {
  width: number;
  height: number;
  /**
   * RGBA, 8-bit sRGB, alpha 255: the CPU relight at `light`. Fits `new ImageData(data, width)`
   * (typed as backed by a plain ArrayBuffer, which TypeScript 5.7+ DOM types require there).
   */
  data: Uint8ClampedArray<ArrayBuffer>;
}

export interface ImpastoResult {
  /** The painting lit at `light`, one pixel per simulation cell (0.1 mm). */
  image: ImpastoImage;
  /** Height and colour buffers for relighting live (WebGPU viewer). Same size as image. */
  surface: ImpastoSurface;
  widthMm: number;
  heightMm: number;
  preset: PresetName;
  seed: number;
  /** The light `image` was rendered with (preset light plus options.light). */
  light: LightSettings;
  /** Number of knife and brush strokes painted. */
  strokes: number;
  /** Every stroke in paint order as plain data (JSON.stringify gives a downloadable stroke list). */
  strokeList: ImpastoStroke[];
  /** Layer names, indexed by ImpastoStroke.layer. */
  layerNames: string[];
  /** Milliseconds: analyse, plan, paint (simulation), snapshot (onLayer snapshots; 0 without), relight, surface, total. */
  timings: Record<'analyse' | 'plan' | 'paint' | 'snapshot' | 'relight' | 'surface' | 'total', number>;
}

export interface ImpastoPlanResult {
  /** The ordered stroke plan (planned against the planner's own estimate, not a simulated canvas). */
  plan: Plan;
  widthMm: number;
  heightMm: number;
  preset: PresetName;
  seed: number;
  strokes: number;
  timings: Record<'analyse' | 'plan' | 'total', number>;
}

// ---------------------------------------------------------------------------------------------
// Image normalisation

const isU8 = (d: unknown): d is Uint8Array | Uint8ClampedArray => d instanceof Uint8Array || d instanceof Uint8ClampedArray;

function checkSize(width: unknown, height: unknown): void {
  if (typeof width !== 'number' || typeof height !== 'number' || !Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw new ImpastoError('EMPTY_IMAGE', `image size must be positive integers, got ${String(width)} x ${String(height)}`);
  }
  if (width > MAX_SIDE_PX || height > MAX_SIDE_PX || width * height > MAX_PIXELS) {
    throw new ImpastoError('IMAGE_TOO_LARGE', `image is ${width} x ${height}; the limit is ${MAX_SIDE_PX} px a side and ${MAX_PIXELS / 1e6} megapixels. Downscale it: detail comes from widthMm, not from pixels`);
  }
  const aspect = Math.max(width / height, height / width);
  if (aspect > MAX_ASPECT) throw new ImpastoError('BAD_ASPECT', `image is ${width} x ${height} (${aspect.toFixed(1)}:1); at most ${MAX_ASPECT}:1 is supported`);
}

/** Validates decoded pixels; returns the bytes per pixel. */
function checkPixels(src: ImpastoPixels): 3 | 4 {
  const { width, height, data } = src;
  checkSize(width, height);
  if (!isU8(data)) throw new ImpastoError('BAD_DATA', 'image data must be a Uint8Array or Uint8ClampedArray (RGBA or RGB bytes)');
  const n = width * height;
  const channels = src.channels ?? (data.length === n * 4 ? 4 : data.length === n * 3 ? 3 : 0);
  if ((channels !== 3 && channels !== 4) || data.length !== n * channels) {
    throw new ImpastoError('BAD_DATA', `image data has ${data.length} bytes; ${width} x ${height} needs ${n * 4} (RGBA) or ${n * 3} (RGB)${src.channels ? ` (channels: ${src.channels} gives ${n * src.channels})` : ''}`);
  }
  return channels;
}

/** Validated pixels as the planner's RGB image (RGB data is used as it is, not copied). */
function pixelsToRgb(src: ImpastoPixels): RgbImage {
  const { width, height, data } = src, n = width * height;
  if (checkPixels(src) === 3) return { w: width, h: height, data };
  const rgb = new Uint8Array(n * 3);
  for (let i = 0; i < n; i++) {
    const a = data[i * 4 + 3];
    for (let k = 0; k < 3; k++) {
      const c = data[i * 4 + k];
      // Straight (non-premultiplied) alpha, as in ImageData, over white.
      rgb[i * 3 + k] = a === 255 ? c : Math.round((c * a + 255 * (255 - a)) / 255);
    }
  }
  return { w: width, h: height, data: rgb };
}

type G = Record<string, unknown>;
const ctor = (name: string): (abstract new (...a: never[]) => unknown) | undefined => {
  const c = (globalThis as G)[name];
  return typeof c === 'function' ? (c as abstract new (...a: never[]) => unknown) : undefined;
};
const isInstance = (v: unknown, name: string): boolean => { const C = ctor(name); return !!C && v instanceof C; };

interface Ctx2D { drawImage(src: unknown, x: number, y: number): void; getImageData(x: number, y: number, w: number, h: number): { data: Uint8ClampedArray } }

function context2d(w: number, h: number): Ctx2D {
  const g = globalThis as G;
  const Off = g.OffscreenCanvas as (new (w: number, h: number) => { getContext(t: '2d', o?: object): Ctx2D | null }) | undefined;
  let ctx: Ctx2D | null = null;
  if (typeof Off === 'function') ctx = new Off(w, h).getContext('2d', { willReadFrequently: true });
  else {
    const doc = g.document as { createElement(t: 'canvas'): { width: number; height: number; getContext(t: '2d', o?: object): Ctx2D | null } } | undefined;
    if (!doc) throw new ImpastoError('UNSUPPORTED_SOURCE', 'drawing a browser image needs OffscreenCanvas or document; pass decoded { width, height, data } pixels instead');
    const c = doc.createElement('canvas');
    c.width = w; c.height = h;
    ctx = c.getContext('2d', { willReadFrequently: true });
  }
  if (!ctx) throw new ImpastoError('UNSUPPORTED_SOURCE', 'could not get a 2D canvas context to read the image');
  return ctx;
}

/**
 * Reads any accepted source into RGBA pixels: ImpastoPixels pass through (validated), browser
 * sources are drawn on a 2D canvas. Useful before posting an HTMLImageElement to a worker.
 */
export async function imageToPixels(src: ImpastoImageSource): Promise<ImpastoPixels> {
  if (src === null || typeof src !== 'object') throw new ImpastoError('UNSUPPORTED_SOURCE', `expected an image, got ${src === null ? 'null' : typeof src}`);
  if ('data' in src) { checkPixels(src as ImpastoPixels); return src as ImpastoPixels; }
  let drawable: unknown = src, width = 0, height = 0, close: (() => void) | null = null;
  if (isInstance(src, 'Blob')) {
    const cib = (globalThis as G).createImageBitmap as ((b: unknown) => Promise<{ width: number; height: number; close(): void }>) | undefined;
    if (typeof cib !== 'function') throw new ImpastoError('UNSUPPORTED_SOURCE', 'decoding a Blob needs createImageBitmap (browsers and workers); in Node, decode the image and pass { width, height, data }');
    let bmp;
    try { bmp = await cib(src); } catch (e) { throw new ImpastoError('DECODE_FAILED', `could not decode the image blob (${(src as BlobLike).type || 'unknown type'})`, { cause: e }); }
    drawable = bmp; width = bmp.width; height = bmp.height; close = () => bmp.close();
  } else if (isInstance(src, 'HTMLImageElement')) {
    const img = src as unknown as { complete: boolean; naturalWidth: number; naturalHeight: number; decode(): Promise<void> };
    if (!img.complete || !img.naturalWidth) {
      try { await img.decode(); } catch (e) { throw new ImpastoError('DECODE_FAILED', 'the image element failed to load or decode', { cause: e }); }
    }
    width = img.naturalWidth; height = img.naturalHeight;
  } else if (['ImageBitmap', 'HTMLCanvasElement', 'OffscreenCanvas', 'VideoFrame', 'SVGImageElement'].some((n) => isInstance(src, n))) {
    const d = src as unknown as { width: number; height: number; displayWidth?: number; displayHeight?: number };
    width = d.displayWidth ?? d.width; height = d.displayHeight ?? d.height;
  } else {
    throw new ImpastoError('UNSUPPORTED_SOURCE', 'expected { width, height, data } pixels, ImageData, or in a browser an ImageBitmap, HTMLImageElement, canvas or Blob');
  }
  try {
    checkSize(width, height);
    const ctx = context2d(width, height);
    ctx.drawImage(drawable, 0, 0);
    return { width, height, data: ctx.getImageData(0, 0, width, height).data, channels: 4 };
  } finally { close?.(); }
}

// ---------------------------------------------------------------------------------------------
// Options

/**
 * The canvas width renderImpasto uses for an image of `width` x `height` pixels when asked for
 * `widthMm`: clamped to MIN_WIDTH_MM and so that neither side exceeds MAX_SIDE_MM.
 */
export function canvasWidthMm(width: number, height: number, widthMm: number): number {
  return Math.max(MIN_WIDTH_MM, Math.min(widthMm, MAX_SIDE_MM, MAX_SIDE_MM * width / height));
}

interface Resolved { preset: PresetName; settings: PlanSettings; light: LightSettings; widthMm: number; heightMm: number; seed: number }

function resolveOptions(img: RgbImage, o: ImpastoOptions): Resolved {
  if (o === null || typeof o !== 'object') throw new ImpastoError('BAD_OPTION', 'options must be an object');
  const preset = o.preset ?? 'oil';
  if (!PRESET_NAMES.includes(preset)) throw new ImpastoError('BAD_OPTION', `unknown preset ${JSON.stringify(preset)}; use ${PRESET_NAMES.map((p) => `'${p}'`).join(', ')}`);
  const adv = o.advanced === undefined ? {} : o.advanced;
  if (adv === null || typeof adv !== 'object') throw new ImpastoError('BAD_OPTION', 'advanced must be an object of PlanSettings');
  if (adv.layers !== undefined && (!Array.isArray(adv.layers) || adv.layers.length === 0)) throw new ImpastoError('BAD_OPTION', 'advanced.layers must be a non-empty array of LayerSpec');
  const light = o.light === undefined ? {} : o.light;
  if (light === null || typeof light !== 'object') throw new ImpastoError('BAD_OPTION', 'light must be an object of LightSettings');
  for (const [k, v] of Object.entries(light)) {
    if (k === 'look' ? v !== 'locked' && v !== 'oil' : typeof v !== 'number' || !Number.isFinite(v)) throw new ImpastoError('BAD_OPTION', `light.${k} is invalid: ${String(v)}`);
  }
  if (o.onProgress !== undefined && typeof o.onProgress !== 'function') throw new ImpastoError('BAD_OPTION', 'onProgress must be a function');
  if (o.onLayer !== undefined && typeof o.onLayer !== 'function') throw new ImpastoError('BAD_OPTION', 'onLayer must be a function');
  if (o.snapshot !== undefined) {
    const m = o.snapshot === null || typeof o.snapshot !== 'object' ? NaN : o.snapshot.maxSide ?? DEFAULT_SNAPSHOT_MAX_SIDE;
    if (typeof m !== 'number' || !(m >= 1)) throw new ImpastoError('BAD_OPTION', `snapshot must be { maxSide?: number >= 1 or Infinity }, got ${JSON.stringify(o.snapshot)}`);
  }
  const r = resolvePreset(preset, adv, light);
  const seed = adv.seed ?? o.seed ?? r.settings.seed;
  if (typeof seed !== 'number' || !Number.isSafeInteger(seed)) throw new ImpastoError('BAD_OPTION', `seed must be an integer, got ${String(seed)}`);
  const w0 = adv.widthMm ?? o.widthMm ?? r.settings.widthMm;
  if (typeof w0 !== 'number' || !Number.isFinite(w0)) throw new ImpastoError('BAD_OPTION', `widthMm must be a number, got ${String(w0)}`);
  const widthMm = canvasWidthMm(img.w, img.h, w0);
  return { preset, settings: { ...r.settings, widthMm, seed }, light: r.light, widthMm, heightMm: widthMm * img.h / img.w, seed };
}

// ---------------------------------------------------------------------------------------------
// Rendering

const now = (): number => performance.now();
/** A macrotask turn, so pending input, paints and timers run between layers. */
const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

function abortError(signal: AbortSignal): unknown {
  if (signal.reason !== undefined) return signal.reason;
  const D = (globalThis as G).DOMException as (new (m: string, n: string) => Error) | undefined;
  if (D) return new D('The render was aborted', 'AbortError');
  const e = new Error('The render was aborted'); e.name = 'AbortError'; return e;
}
function checkAbort(signal?: AbortSignal): void { if (signal?.aborted) throw abortError(signal); }

/** Reports an error thrown by a user callback without stopping the render (as an event listener's would be). */
function reportCallbackError(err: unknown): void {
  const re = (globalThis as G).reportError;
  if (typeof re === 'function') { try { (re as (e: unknown) => void)(err); return; } catch { /* fall through */ } }
  console.error('impasto-sim: the onLayer callback threw; the render carries on.', err);
}

/** Calls onLayer, which must not break the render (see ImpastoOptions.onLayer). */
function callOnLayer(onLayer: (s: LayerSnapshot) => void, snap: LayerSnapshot): void {
  try { onLayer(snap); } catch (err) { reportCallbackError(err); }
}

/** Runs the pipeline step by step, yielding to the event loop and checking `signal` between steps. */
async function drive(img: RgbImage, r: Resolved, o: ImpastoOptions, simulate: boolean, paintShare: number): Promise<PipelineResult & { snapshotMs: number }> {
  const report = (info: ProgressInfo): void => o.onProgress?.(info);
  const it = paintPipeline(img, r.settings, { simulate });
  const A = 0.05; // analysis share of the fraction
  const onLayer = simulate ? o.onLayer : undefined, maxSide = o.snapshot?.maxSide ?? DEFAULT_SNAPSHOT_MAX_SIDE;
  let snapshotMs = 0;
  report({ stage: 'analyse', fraction: 0 });
  await tick(); checkAbort(o.signal);
  let layers = 0, names: string[] = [];
  for (;;) {
    const step = it.next();
    if (step.done) return { ...step.value, snapshotMs };
    const e: PipelineEvent = step.value;
    if (e.stage === 'analysed') { layers = e.layers; names = e.names; }
    else if (onLayer && e.painting) {
      // Read-only: the snapshot copies out of the canvas and plan, so the painting is unchanged.
      const t = now(), c = e.painting.canvas;
      const surface = surfaceSnapshot(c, maxSide), scale = snapshotFactor(c.w, c.h, maxSide);
      const snap: LayerSnapshot = {
        layer: e.layer, layers: e.layers, name: e.name, deferred: e.stage === 'deferred',
        fraction: A + (paintShare - A) * (e.layer + 1) / e.layers,
        strokes: strokesToJSON(e.plan, e.strokes), surface, scale,
        widthMm: e.plan.widthMm, heightMm: e.plan.heightMm, planMs: Math.round(e.planMs), paintMs: Math.round(e.simMs),
      };
      snapshotMs += now() - t;
      callOnLayer(onLayer, snap);
    }
    const next = e.stage === 'analysed' ? 0 : e.layer + 1;
    if (e.stage !== 'deferred' && next < layers) {
      report({ stage: 'paint', layer: next, layers, layerName: names[next], fraction: A + (paintShare - A) * next / layers });
    }
    await tick(); checkAbort(o.signal);
  }
}

/**
 * Paints `image` with the palette-knife simulation and lights it.
 *
 * Throws ImpastoError (with a `code`) for bad input or options, and rejects with the signal's
 * reason when aborted. Deterministic: the same pixels, options and seed give the same result.
 */
export async function renderImpasto(image: ImpastoImageSource, options: ImpastoOptions = {}): Promise<ImpastoResult> {
  const t0 = now();
  checkAbort(options?.signal);
  const img = pixelsToRgb(await imageToPixels(image));
  const r = resolveOptions(img, options);
  const res = await drive(img, r, options, true, 0.9);
  const painting = res.painting!;
  options.onProgress?.({ stage: 'relight', fraction: 0.9 });
  await tick(); checkAbort(options.signal);
  let t = now();
  const rgb = relight(painting.canvas, r.light, 'paint');
  const relightMs = now() - t;
  const { w, h, n } = painting.canvas;
  const rgba = new Uint8ClampedArray(n * 4);
  for (let i = 0; i < n; i++) { rgba[i * 4] = rgb[i * 3]; rgba[i * 4 + 1] = rgb[i * 3 + 1]; rgba[i * 4 + 2] = rgb[i * 3 + 2]; rgba[i * 4 + 3] = 255; }
  t = now();
  const surface = surfaceFromCanvas(painting.canvas);
  const surfaceMs = now() - t;
  const strokeList = strokesToJSON(res.plan);
  checkAbort(options.signal);
  options.onProgress?.({ stage: 'done', fraction: 1 });
  const ms = (v: number) => Math.round(v);
  return {
    image: { width: w, height: h, data: rgba }, surface,
    widthMm: r.widthMm, heightMm: res.plan.heightMm, preset: r.preset, seed: r.seed, light: r.light, strokes: res.plan.strokes.length,
    strokeList, layerNames: [...res.plan.layerNames],
    timings: { analyse: ms(res.analyseMs), plan: ms(res.planMs), paint: ms(res.simMs), snapshot: ms(res.snapshotMs), relight: ms(relightMs), surface: ms(surfaceMs), total: ms(now() - t0) },
  };
}

/**
 * Plans the strokes without painting them: seconds instead of minutes, for previews. Without the
 * simulation each layer is planned against the planner's own estimate of the canvas, so the plan
 * differs from the one renderImpasto paints.
 */
export async function planImpasto(image: ImpastoImageSource, options: ImpastoOptions = {}): Promise<ImpastoPlanResult> {
  const t0 = now();
  checkAbort(options?.signal);
  const img = pixelsToRgb(await imageToPixels(image));
  const r = resolveOptions(img, options);
  const res = await drive(img, r, options, false, 1);
  options.onProgress?.({ stage: 'done', fraction: 1 });
  return {
    plan: res.plan, widthMm: r.widthMm, heightMm: res.plan.heightMm, preset: r.preset, seed: r.seed, strokes: res.plan.strokes.length,
    timings: { analyse: Math.round(res.analyseMs), plan: Math.round(res.planMs), total: Math.round(now() - t0) },
  };
}

// ---------------------------------------------------------------------------------------------
// Worker client (the worker side is src/worker.ts, `impasto-sim/worker`)

/** A Worker running `impasto-sim/worker`, or a MessagePort served by `serveImpasto`. */
export interface ImpastoWorkerLike {
  postMessage(message: unknown, transfer?: unknown[]): void;
  addEventListener(type: 'message' | 'error' | 'messageerror', listener: (e: any) => void): void;
  removeEventListener(type: 'message' | 'error' | 'messageerror', listener: (e: any) => void): void;
  start?(): void;
}

let nextId = 1;

function callWorker<T>(worker: ImpastoWorkerLike, type: 'render' | 'plan', image: ImpastoImageSource, options: ImpastoOptions): Promise<T> {
  const { signal, onProgress, onLayer, ...rest } = options ?? {};
  // Functions cannot cross to the worker: check here what renderImpasto would check there.
  if (onLayer !== undefined && typeof onLayer !== 'function') return Promise.reject(new ImpastoError('BAD_OPTION', 'onLayer must be a function'));
  return new Promise<T>((resolve, reject) => {
    if (signal?.aborted) { reject(abortError(signal)); return; }
    const id = nextId++;
    let settled = false;
    const done = (): void => {
      settled = true;
      worker.removeEventListener('message', onMessage);
      worker.removeEventListener('error', onError);
      worker.removeEventListener('messageerror', onError);
      signal?.removeEventListener('abort', onAbort);
    };
    const fail = (err: unknown): void => { if (!settled) { done(); reject(err); } };
    const onAbort = (): void => { try { worker.postMessage({ type: 'abort', id }); } catch { /* the worker is gone */ } fail(abortError(signal!)); };
    // A worker that fails to load, throws at top level or runs out of memory reports here, not on 'message'.
    const onError = (e: { message?: string; type?: string }): void => {
      fail(new ImpastoError('WORKER_FAILED', `the impasto worker failed${e?.message ? `: ${e.message}` : e?.type === 'messageerror' ? ': a message could not be deserialised' : ''}`));
    };
    const onMessage = (e: { data: unknown }): void => {
      const m = e.data as { type: string; id: number; info?: ProgressInfo; snapshot?: LayerSnapshot; result?: T; error?: { name: string; message: string; code?: string } };
      if (!m || m.id !== id) return;
      if (m.type === 'progress') onProgress?.(m.info!);
      else if (m.type === 'layer') { if (onLayer && m.snapshot) callOnLayer(onLayer, m.snapshot); }
      else if (m.type === 'result') { done(); resolve(m.result!); }
      else if (m.type === 'error') {
        done();
        const er = m.error!;
        if (er.name === 'ImpastoError') reject(new ImpastoError(er.code as ImpastoErrorCode, er.message));
        else { const x = new Error(er.message); x.name = er.name; reject(x); }
      }
    };
    worker.addEventListener('message', onMessage);
    worker.addEventListener('error', onError);
    worker.addEventListener('messageerror', onError);
    worker.start?.();
    signal?.addEventListener('abort', onAbort, { once: true });
    // Pixels, Blobs and ImageBitmaps can be posted; image elements and canvases are read here first.
    const cloneable = 'data' in (image as object) || isInstance(image, 'Blob') || isInstance(image, 'ImageBitmap');
    (cloneable ? Promise.resolve(image) : imageToPixels(image)).then(
      (img) => {
        if (settled || signal?.aborted) return;
        // postMessage throws synchronously for what it cannot clone (a Proxy, e.g. a Vue reactive object, or a function).
        // `layers` asks the worker for onLayer snapshots (a worker from before them ignores it, and no snapshots arrive).
        try { worker.postMessage(type === 'render' && onLayer ? { type, id, image: img, options: rest, layers: true } : { type, id, image: img, options: rest }); }
        catch (e) { fail(new ImpastoError('BAD_OPTION', `could not send the job to the worker: ${(e as Error).message} (pass plain data, not reactive proxies or functions)`)); }
      },
      fail,
    );
  });
}

/**
 * renderImpasto in a worker: same options and result; progress, abort and onLayer snapshots are
 * forwarded (snapshot and result buffers are transferred, not copied).
 */
export function renderInWorker(worker: ImpastoWorkerLike, image: ImpastoImageSource, options: ImpastoOptions = {}): Promise<ImpastoResult> {
  return callWorker<ImpastoResult>(worker, 'render', image, options);
}

/** planImpasto in a worker. */
export function planInWorker(worker: ImpastoWorkerLike, image: ImpastoImageSource, options: ImpastoOptions = {}): Promise<ImpastoPlanResult> {
  return callWorker<ImpastoPlanResult>(worker, 'plan', image, options);
}
