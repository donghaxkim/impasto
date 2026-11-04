/**
 * Live lighting layer for the browser. It takes the CPU simulation's packed surface
 * (`ImpastoSurface`) and relights it with the WebGPU port of the reference renderer
 * (`RELIGHT_WGSL`: an HDR pass, then a glow/composite pass). Where WebGPU is missing or fails, it
 * falls back to a 2D canvas: a supplied static image (normally a CPU `relight()` render at the
 * default light), or else a cheap CPU shading of the height field so the light still moves.
 *
 * Browser-only, no dependencies. Nothing in the paint path imports this file.
 *
 *   const viewer = await createImpastoViewer(canvas, surface, { fallback, onFallback: console.warn });
 *   attachPointerLight(viewer);           // drag on the canvas to move the light
 *   viewer.setLight({ azimuth: 45 });     // redraws on the next animation frame
 *   viewer.mode;                          // 'webgpu' | 'static'
 */
import { DEFAULT_LIGHT, LOOKS, type LightSettings, type LookName, type View } from './relight.ts';
import { RELIGHT_WGSL, relightUniforms } from './relight-gpu.ts';
import { linearToSrgb } from './pigment.ts';
import type { ImpastoSurface } from './surface.ts';

export type ViewerMode = 'webgpu' | 'static';

/** An RGBA (or RGB) 8-bit image, row-major. `ImageData` fits. */
export interface FallbackImage { width: number; height: number; data: Uint8ClampedArray | Uint8Array }

export interface ViewerOptions {
  light?: Partial<LightSettings>;
  look?: LookName;
  view?: View;
  /** Shown in static mode for the 'paint' view. Normally `relight(canvas, DEFAULT_LIGHT)` from the CPU. */
  fallback?: FallbackImage;
  /** Called once, with the reason, when the viewer ends up in (or later switches to) static mode. */
  onFallback?: (reason: string) => void;
  /** Skip WebGPU entirely (for testing the fallback, or to save power). */
  forceStatic?: boolean;
  /** WebGPU entry point to use instead of `navigator.gpu` (tests; `null` means unavailable). */
  gpu?: GPU | null;
}

export interface ImpastoViewer extends EventTarget {
  /** 'webgpu' while the shader is live; 'static' after any fallback. Fires 'modechange' when it changes. */
  readonly mode: ViewerMode;
  /** Why the viewer is static, if it is. */
  readonly fallbackReason: string | null;
  /** The element being drawn to. It changes once if the GPU device is lost (see 'modechange'). */
  readonly canvas: HTMLCanvasElement;
  readonly surface: ImpastoSurface;
  readonly light: Readonly<LightSettings>;
  readonly look: LookName;
  readonly view: View;
  /** True when moving the light changes the picture (false when a fixed fallback image is shown). */
  readonly interactive: boolean;
  /** The GPU device in webgpu mode, else null. */
  readonly gpuDevice: GPUDevice | null;
  /** Merges into the light and redraws on the next animation frame. */
  setLight(light: Partial<LightSettings>): void;
  setLook(look: LookName): void;
  setView(view: View): void;
  /** Draws now (setters already schedule a draw; call this for a synchronous frame). */
  render(): void;
  /** Draws, then reads back the canvas as RGBA (canvas width x height). */
  readPixels(): Promise<Uint8ClampedArray>;
  /** Releases the GPU device and cancels pending frames. The canvas keeps its last frame. */
  destroy(): void;
}

export const VIEW_INDEX: Record<View, number> = { paint: 0, color: 1, height: 2, normal: 3, spec: 4, cavity: 5, glow: 6 };

interface Gpu {
  /** Held so the adapter (and with it Dawn's instance) is not collected while the device lives. */
  adapter: GPUAdapter;
  device: GPUDevice; context: GPUCanvasContext; format: GPUTextureFormat;
  uniforms: GPUBuffer; hdr: GPUTexture; textures: GPUTexture[];
  fsPipe: GPURenderPipeline; fsGroup: GPUBindGroup;
  outPipe: GPURenderPipeline; outGroup: GPUBindGroup;
  readPipe: GPURenderPipeline | null; readGroup: GPUBindGroup | null;
}

function checkSurface(s: ImpastoSurface): void {
  const n = s.w * s.h;
  if (!(n > 0) || !Number.isInteger(s.w) || !Number.isInteger(s.h)) throw new TypeError(`ImpastoSurface: bad size ${s.w}x${s.h}`);
  if (s.height.length !== n * 2 || s.color.length !== n * 4) throw new TypeError(`ImpastoSurface: height needs ${n * 2} floats and color ${n * 4} for ${s.w}x${s.h}`);
}

/** Creates the WebGPU pipeline, or explains why it can't. */
async function initGpu(gpu: GPU | null | undefined, canvas: HTMLCanvasElement, s: ImpastoSurface): Promise<Gpu | string> {
  if (!gpu) return 'WebGPU is not available in this browser (navigator.gpu is missing)';
  let adapter: GPUAdapter | null;
  try { adapter = await gpu.requestAdapter(); } catch (e) { return `requestAdapter failed: ${(e as Error).message}`; }
  if (!adapter) return 'no WebGPU adapter (requestAdapter returned null)';
  const maxDim = adapter.limits.maxTextureDimension2D;
  if (s.w > maxDim || s.h > maxDim) return `surface ${s.w}x${s.h} exceeds this GPU's texture limit of ${maxDim}`;
  let device: GPUDevice;
  try { device = await adapter.requestDevice(); } catch (e) { return `requestDevice failed: ${(e as Error).message}`; }
  const fail = (why: string) => { device.destroy(); return why; };
  const context = canvas.getContext('webgpu');
  if (!context) return fail('the canvas has no WebGPU context (it may already hold a 2D one)');
  try {
    device.pushErrorScope('out-of-memory');
    device.pushErrorScope('validation');
    const format = gpu.getPreferredCanvasFormat();
    canvas.width = s.w; canvas.height = s.h;
    context.configure({ device, format, alphaMode: 'opaque' });
    const { w: W, h: H } = s;
    const texture = (format: GPUTextureFormat, bytes: number, data: Float32Array) => {
      const t = device.createTexture({ size: [W, H], format, usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
      device.queue.writeTexture({ texture: t }, data as Float32Array<ArrayBuffer>, { bytesPerRow: W * bytes }, [W, H]);
      return t;
    };
    const ht = texture('rg32float', 8, s.height), ct = texture('rgba32float', 16, s.color);
    const module = device.createShaderModule({ code: RELIGHT_WGSL });
    const info = await module.getCompilationInfo();
    const errors = info.messages.filter((m) => m.type === 'error');
    if (errors.length) { context.unconfigure(); return fail('WGSL: ' + errors.map((m) => `${m.lineNum}:${m.linePos} ${m.message}`).join('; ')); }
    const hdr = device.createTexture({ size: [W, H], format: 'rgba32float', usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING });
    const fsPipe = device.createRenderPipeline({ layout: 'auto', vertex: { module, entryPoint: 'vs' }, fragment: { module, entryPoint: 'fs', targets: [{ format: 'rgba32float' }] } });
    const outPipe = device.createRenderPipeline({ layout: 'auto', vertex: { module, entryPoint: 'vs' }, fragment: { module, entryPoint: 'composite', targets: [{ format }] } });
    const uniforms = device.createBuffer({ size: 96, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    const fsGroup = device.createBindGroup({ layout: fsPipe.getBindGroupLayout(0), entries: [{ binding: 0, resource: ht.createView() }, { binding: 1, resource: ct.createView() }, { binding: 2, resource: { buffer: uniforms } }] });
    const outGroup = device.createBindGroup({ layout: outPipe.getBindGroupLayout(0), entries: [{ binding: 2, resource: { buffer: uniforms } }, { binding: 3, resource: hdr.createView() }] });
    const validation = await device.popErrorScope(), oom = await device.popErrorScope();
    const err = validation ?? oom;
    if (err) { context.unconfigure(); return fail(`WebGPU setup failed: ${err.message}`); }
    return { adapter, device, context, format, uniforms, hdr, textures: [ht, ct, hdr], fsPipe, fsGroup, outPipe, outGroup, readPipe: null, readGroup: null };
  } catch (e) {
    try { context.unconfigure(); } catch { /* already gone */ }
    return fail(`WebGPU setup failed: ${(e as Error).message}`);
  }
}

/**
 * Cheap display-only shading for the static fallback when no image was supplied: wrapped Lambert
 * key, soft fill and a Blinn-Phong clearcoat from the surface's roughness. No shadows, occlusion
 * or glow; the 'cavity' and 'glow' views fall back to 'paint'.
 */
export class ApproxShader {
  readonly s: ImpastoSurface;
  #gx: Float32Array; #gy: Float32Array;
  constructor(s: ImpastoSurface) {
    this.s = s;
    const { w, h, dx, height } = s, n = w * h;
    this.#gx = new Float32Array(n); this.#gy = new Float32Array(n);
    const at = (x: number, y: number) => height[((y < 0 ? 0 : y >= h ? h - 1 : y) * w + (x < 0 ? 0 : x >= w ? w - 1 : x)) * 2];
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = y * w + x;
      this.#gx[i] = ((at(x + 1, y - 1) + 2 * at(x + 1, y) + at(x + 1, y + 1)) - (at(x - 1, y - 1) + 2 * at(x - 1, y) + at(x - 1, y + 1))) / (8 * dx);
      this.#gy[i] = ((at(x - 1, y + 1) + 2 * at(x, y + 1) + at(x + 1, y + 1)) - (at(x - 1, y - 1) + 2 * at(x, y - 1) + at(x + 1, y - 1))) / (8 * dx);
    }
  }
  /** Writes RGBA into `out` (w * h * 4). */
  shade(light: LightSettings, view: View, out: Uint8ClampedArray): void {
    const { w, h, height, color } = this.s, n = w * h, gx = this.#gx, gy = this.#gy;
    const look = LOOKS[light.look ?? 'locked'], r = light.relief, expo = light.exposure;
    const az = light.azimuth * Math.PI / 180, el = light.elevation * Math.PI / 180;
    const cel = Math.cos(el), sel = Math.sin(el), lx = Math.cos(az) * cel, ly = Math.sin(az) * cel, lz = sel;
    const hl = Math.hypot(lx, ly, lz + 1), hx = lx / hl, hy = ly / hl, hz = (lz + 1) / hl;
    const se = Math.max(sel, 0.25), wrap = 0.3, keyGain = 0.72 * (1 + wrap) / (se + wrap), irradiance = 0.72 / se * Math.PI;
    const fc = 1 - hz, fresnel = 0.045 + 0.955 * fc * fc * fc * fc * fc;
    for (let i = 0; i < n; i++) {
      const o = i * 4;
      out[o + 3] = 255;
      const ar = color[i * 4], ag = color[i * 4 + 1], ab = color[i * 4 + 2];
      if (view === 'color') { out[o] = linearToSrgb(ar) * 255 + 0.5; out[o + 1] = linearToSrgb(ag) * 255 + 0.5; out[o + 2] = linearToSrgb(ab) * 255 + 0.5; continue; }
      if (view === 'height') { const s = height[i * 2] * r, v = s / (s + 2.2) * 255 + 0.5; out[o] = out[o + 1] = out[o + 2] = v; continue; }
      const sx = gx[i] * r, sy = gy[i] * r, nl = Math.sqrt(sx * sx + sy * sy + 1);
      const nx = -sx / nl, ny = -sy / nl, nz = 1 / nl;
      if (view === 'normal') { out[o] = (nx * 0.5 + 0.5) * 255; out[o + 1] = (ny * 0.5 + 0.5) * 255; out[o + 2] = (nz * 0.5 + 0.5) * 255; continue; }
      const noL = nx * lx + ny * ly + nz * lz;
      const diffuse = Math.min(1, Math.max(0, (noL + wrap) / (1 + wrap)));
      const lit = 0.14 * (0.65 + 0.35 * nz) + diffuse * keyGain;
      let spec = 0;
      if (noL > 0) {
        const coat = Math.max(color[i * 4 + 3], look.coatMin, 0.04), a = coat * coat;
        const shin = Math.min(2 / (a * a) - 2, 400), noH = Math.max(0, nx * hx + ny * hy + nz * hz);
        spec = (shin + 8) / (8 * Math.PI) * Math.pow(noH, shin) * fresnel * noL * irradiance * look.specGain;
      }
      if (view === 'spec') { const v = linearToSrgb(spec) * 255 + 0.5; out[o] = out[o + 1] = out[o + 2] = v; continue; }
      out[o] = linearToSrgb((ar * lit + spec) * expo) * 255 + 0.5;
      out[o + 1] = linearToSrgb((ag * lit + spec * 0.985) * expo) * 255 + 0.5;
      out[o + 2] = linearToSrgb((ab * lit + spec * 0.95) * expo) * 255 + 0.5;
    }
  }
}

class Viewer extends EventTarget implements ImpastoViewer {
  mode: ViewerMode = 'static';
  fallbackReason: string | null = null;
  canvas: HTMLCanvasElement;
  readonly surface: ImpastoSurface;
  light: LightSettings;
  view: View;
  #gpu: Gpu | null = null;
  #ctx2d: CanvasRenderingContext2D | null = null;
  #fallback: FallbackImage | undefined;
  #fallbackData: ImageData | null = null;
  #approx: ApproxShader | null = null;
  #approxPixels: ImageData | null = null;
  #onFallback: ((reason: string) => void) | undefined;
  #frame = 0;
  #destroyed = false;

  constructor(canvas: HTMLCanvasElement, surface: ImpastoSurface, opts: ViewerOptions) {
    super();
    this.canvas = canvas;
    this.surface = surface;
    this.light = { ...DEFAULT_LIGHT, ...opts.light, look: opts.look ?? opts.light?.look ?? 'locked' };
    this.view = opts.view ?? 'paint';
    this.#fallback = opts.fallback;
    this.#onFallback = opts.onFallback;
  }
  get look(): LookName { return this.light.look ?? 'locked'; }
  get gpuDevice(): GPUDevice | null { return this.#gpu?.device ?? null; }
  get interactive(): boolean { return this.mode === 'webgpu' || !(this.#fallback && this.view === 'paint'); }

  async init(opts: ViewerOptions): Promise<void> {
    const result = opts.forceStatic ? 'static mode requested (forceStatic)'
      : await initGpu('gpu' in opts ? opts.gpu : (globalThis.navigator as Navigator | undefined)?.gpu, this.canvas, this.surface).catch((e: Error) => `WebGPU setup failed: ${e.message}`);
    if (typeof result === 'string') { this.#toStatic(result, false); return; }
    this.#gpu = result;
    this.mode = 'webgpu';
    result.device.lost.then((info) => {
      if (this.#destroyed || this.#gpu?.device !== result.device) return;
      this.#gpu = null;
      this.#toStatic(`WebGPU device lost (${info.reason}${info.message ? ': ' + info.message : ''})`, true);
    });
    this.render();
  }

  #toStatic(reason: string, replaceCanvas: boolean): void {
    this.mode = 'static';
    this.fallbackReason = reason;
    let ctx = replaceCanvas ? null : this.canvas.getContext('2d');
    if (!ctx) {
      // A canvas that has handed out a WebGPU context can never give a 2D one, so swap in a twin.
      const fresh = this.canvas.cloneNode(false) as HTMLCanvasElement;
      this.canvas.replaceWith(fresh);
      this.canvas = fresh;
      ctx = fresh.getContext('2d');
    }
    this.#ctx2d = ctx;
    this.render();
    this.dispatchEvent(new Event('modechange'));
    try { this.#onFallback?.(reason); } catch (e) { console.error(e); }
  }

  setLight(light: Partial<LightSettings>): void { Object.assign(this.light, light); this.#schedule(); }
  setLook(look: LookName): void { this.light.look = look; this.#schedule(); }
  setView(view: View): void { this.view = view; this.#schedule(); }

  #schedule(): void {
    if (this.#frame || this.#destroyed) return;
    const raf = globalThis.requestAnimationFrame ?? ((f: FrameRequestCallback) => setTimeout(() => f(0), 16) as unknown as number);
    this.#frame = raf(() => { this.#frame = 0; this.render(); });
  }

  render(): void {
    if (this.#destroyed) return;
    if (this.#gpu) { this.#renderGpu(this.#gpu, this.#gpu.context.getCurrentTexture(), this.#gpu.outPipe, this.#gpu.outGroup); return; }
    this.#renderStatic();
  }

  #renderGpu(g: Gpu, target: GPUTexture, pipe: GPURenderPipeline, group: GPUBindGroup): GPUCommandEncoder {
    const s = this.surface;
    g.device.queue.writeBuffer(g.uniforms, 0, relightUniforms(s.w, s.h, s.dx, s.maxH, this.light, VIEW_INDEX[this.view]) as Float32Array<ArrayBuffer>);
    const e = g.device.createCommandEncoder();
    const p1 = e.beginRenderPass({ colorAttachments: [{ view: g.hdr.createView(), loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 0] }] });
    p1.setPipeline(g.fsPipe); p1.setBindGroup(0, g.fsGroup); p1.draw(3); p1.end();
    const p2 = e.beginRenderPass({ colorAttachments: [{ view: target.createView(), loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 1] }] });
    p2.setPipeline(pipe); p2.setBindGroup(0, group); p2.draw(3); p2.end();
    if (pipe === g.outPipe) g.device.queue.submit([e.finish()]);
    return e;
  }

  #renderStatic(): void {
    const ctx = this.#ctx2d;
    if (!ctx) return;
    const img = this.#fallback;
    if (img && this.view === 'paint') {
      if (!this.#fallbackData) {
        const { width: w, height: h, data } = img, rgba = new Uint8ClampedArray(w * h * 4);
        if (data.length === w * h * 4) rgba.set(data);
        else if (data.length === w * h * 3) for (let i = 0; i < w * h; i++) { rgba[i * 4] = data[i * 3]; rgba[i * 4 + 1] = data[i * 3 + 1]; rgba[i * 4 + 2] = data[i * 3 + 2]; rgba[i * 4 + 3] = 255; }
        else throw new TypeError(`fallback image: ${data.length} bytes is neither RGBA nor RGB for ${w}x${h}`);
        this.#fallbackData = new ImageData(rgba, w, h);
      }
      this.#put(ctx, this.#fallbackData);
      return;
    }
    const s = this.surface;
    this.#approx ??= new ApproxShader(s);
    this.#approxPixels ??= new ImageData(s.w, s.h);
    this.#approx.shade(this.light, this.view, this.#approxPixels.data);
    this.#put(ctx, this.#approxPixels);
  }

  #put(ctx: CanvasRenderingContext2D, img: ImageData): void {
    if (this.canvas.width !== img.width || this.canvas.height !== img.height) { this.canvas.width = img.width; this.canvas.height = img.height; }
    ctx.putImageData(img, 0, 0);
  }

  async readPixels(): Promise<Uint8ClampedArray> {
    const g = this.#gpu;
    if (!g) {
      this.render();
      const ctx = this.#ctx2d;
      if (!ctx) return new Uint8ClampedArray(0);
      return ctx.getImageData(0, 0, this.canvas.width, this.canvas.height).data;
    }
    const { w: W, h: H } = this.surface, d = g.device;
    if (!g.readPipe) {
      const module = d.createShaderModule({ code: RELIGHT_WGSL });
      g.readPipe = d.createRenderPipeline({ layout: 'auto', vertex: { module, entryPoint: 'vs' }, fragment: { module, entryPoint: 'composite', targets: [{ format: 'rgba8unorm' }] } });
      g.readGroup = d.createBindGroup({ layout: g.readPipe.getBindGroupLayout(0), entries: [{ binding: 2, resource: { buffer: g.uniforms } }, { binding: 3, resource: g.hdr.createView() }] });
    }
    const target = d.createTexture({ size: [W, H], format: 'rgba8unorm', usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC });
    const bpr = Math.ceil(W * 4 / 256) * 256;
    const buf = d.createBuffer({ size: bpr * H, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    const e = this.#renderGpu(g, target, g.readPipe, g.readGroup!);
    e.copyTextureToBuffer({ texture: target }, { buffer: buf, bytesPerRow: bpr }, [W, H]);
    d.queue.submit([e.finish()]);
    try {
      await buf.mapAsync(GPUMapMode.READ);
      const src = new Uint8Array(buf.getMappedRange()), out = new Uint8ClampedArray(W * H * 4);
      for (let y = 0; y < H; y++) out.set(src.subarray(y * bpr, y * bpr + W * 4), y * W * 4);
      buf.unmap();
      return out;
    } finally {
      buf.destroy(); target.destroy();
      this.render();
    }
  }

  destroy(): void {
    if (this.#destroyed) return;
    this.#destroyed = true;
    if (this.#frame) (globalThis.cancelAnimationFrame ?? clearTimeout)(this.#frame);
    const g = this.#gpu;
    this.#gpu = null;
    if (g) { for (const t of g.textures) t.destroy(); g.uniforms.destroy(); g.device.destroy(); }
  }
}

/**
 * Creates a viewer on `canvasEl`, sized to the surface (one canvas pixel per cell; scale it with
 * CSS). Resolves in 'webgpu' mode when the shader is running, else in 'static' mode with the
 * reason in `fallbackReason` (and `onFallback`). Missing WebGPU never rejects; a malformed
 * surface does (TypeError).
 */
export async function createImpastoViewer(canvasEl: HTMLCanvasElement, surface: ImpastoSurface, opts: ViewerOptions = {}): Promise<ImpastoViewer> {
  checkSurface(surface);
  const v = new Viewer(canvasEl, surface, opts);
  await v.init(opts);
  return v;
}

export interface PointerLightOptions {
  /**
   * 'linear' (default, as Milestone 0): horizontal position sets azimuth (left edge 360°, right
   * edge 0°), vertical sets elevation (top = max, bottom = min). 'radial': the light comes from
   * where you point, seen from the canvas centre; the centre is overhead, the edge grazing.
   */
  mapping?: 'linear' | 'radial';
  minElevation?: number;
  maxElevation?: number;
  /** Called after each change, e.g. to move sliders. */
  onChange?: (light: Readonly<LightSettings>) => void;
}

/**
 * Drag on `el` (default: the viewer's canvas, followed across a device-loss swap) to move the
 * light. Returns a function that removes the listeners.
 */
export function attachPointerLight(viewer: ImpastoViewer, el?: HTMLElement, opts: PointerLightOptions = {}): () => void {
  const minEl = opts.minElevation ?? 5, maxEl = opts.maxElevation ?? 85;
  let target: HTMLElement | null = null, dragging = false;
  const move = (e: PointerEvent) => {
    const r = target!.getBoundingClientRect();
    if (!r.width || !r.height) return;
    const fx = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), fy = Math.min(1, Math.max(0, (e.clientY - r.top) / r.height));
    let azimuth: number, elevation: number;
    if (opts.mapping === 'radial') {
      const dx = (fx - 0.5) * r.width, dy = (fy - 0.5) * r.height, reach = Math.min(r.width, r.height) / 2;
      azimuth = (Math.atan2(dy, dx) * 180 / Math.PI + 360) % 360;
      elevation = maxEl - (maxEl - minEl) * Math.min(1, Math.hypot(dx, dy) / reach);
    } else {
      azimuth = ((1 - fx) * 360) % 360;
      elevation = maxEl - fy * (maxEl - minEl);
    }
    viewer.setLight({ azimuth: Math.round(azimuth), elevation: Math.round(elevation) });
    opts.onChange?.(viewer.light);
  };
  const down = (e: PointerEvent) => { dragging = true; try { target!.setPointerCapture(e.pointerId); } catch { /* synthetic events */ } move(e); e.preventDefault(); };
  const over = (e: PointerEvent) => { if (dragging) move(e); };
  const up = () => { dragging = false; };
  const bind = (t: HTMLElement) => {
    target = t;
    t.style.touchAction = 'none';
    t.addEventListener('pointerdown', down); t.addEventListener('pointermove', over);
    t.addEventListener('pointerup', up); t.addEventListener('pointercancel', up);
  };
  const unbind = () => {
    if (!target) return;
    target.removeEventListener('pointerdown', down); target.removeEventListener('pointermove', over);
    target.removeEventListener('pointerup', up); target.removeEventListener('pointercancel', up);
    target = null;
  };
  const follow = () => { if (target !== viewer.canvas) { unbind(); bind(viewer.canvas); } };
  if (el) bind(el);
  else { bind(viewer.canvas); viewer.addEventListener('modechange', follow); }
  return () => { unbind(); viewer.removeEventListener('modechange', follow); };
}
