/**
 * Diagnostic benchmark: wall-clock time per pipeline stage across the benchmark scenes.
 *
 *   npm run bench -- [--scenes lake,portrait,flowers,building] [--width scene|<mm>[,<mm>...]]
 *                    [--look oil|locked] [--repeat N] [--quick] [--plan-only] [--gpu]
 *                    [--gpu-frames N] [--json out/bench/<name>.json]
 *
 * The parent process runs every (scene, width, repeat) in a fresh child process (this file with
 * --worker), so peak RSS is per run, one run's crash does not end the benchmark and runs do not
 * share JIT or GC state. The worker mirrors the `npm run paint` pipeline (paint-image.ts):
 *
 *   load       readPng (PNG decode)
 *   setup      new Planner(): resample + OKLab, painting maps, knife scale, form hierarchy
 *     resample   resampleLinear + toOklab          } measured standalone with the planner's own
 *     analysis   paintingMaps + knifeScale         } inputs, for the breakdown (the planner
 *     forms      formHierarchy                     } constructor repeats them; see setup)
 *   planning   Planner.planLayer for every layer + flushDeferred, minus nothing: painting is not
 *              inside it, because the feedback runs between layers, as planPainting does
 *   canvas     startPainting (PaintCanvas allocation and weave)
 *   painting   paintStrokes, the simulation, timed inside the feedback callback
 *   readback   canvasColour, the canvas colour fed back to the planner after each layer
 *   relight    relight(canvas, light, 'paint'): one CPU frame, what one light change costs
 *   surface    surfaceFromCanvas: packing for a viewer (not in the paint CLI; reported apart)
 *   total      load + setup + planning + canvas + painting + readback + relight (CLI-equivalent,
 *              with one relit view instead of the CLI's four, and no PNG writing)
 *
 * Denominators for "ms per megapixel": input image pixels, planner analysis-grid cells
 * (widthMm / analysisMm squared-ish, 0.5 mm cells) and simulation canvas cells (widthMm / dx x
 * heightMm / dx, dx = 0.1 mm). All are reported as millions (MP / Mcells).
 *
 * --gpu times the WebGPU relight shader (RELIGHT_WGSL) in headless Chromium through Playwright,
 * as gpu-parity.ts does, on the same canvas: median per frame after warm-up. In this sandbox
 * Chromium's WebGPU runs on SwiftShader (a CPU Vulkan implementation), so those numbers say how a
 * software rasteriser fares, not a real GPU; the adapter is reported with the timing.
 *
 * Writes <json> (default out/bench/latest.json), <json>.md and summary.md next to it.
 */
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { readPng } from './png.ts';
import { DEFAULT_SETTINGS, knifeScale, Planner, type PlannedStroke, type PlanSettings } from '../src/planner.ts';
import { resampleLinear, toOklab, type RgbImage } from '../src/image.ts';
import { paintingMaps } from '../src/structure.ts';
import { formHierarchy } from '../src/forms.ts';
import { canvasColour, paintStrokes, startPainting, type Painting } from '../src/execute.ts';
import { DEFAULT_LIGHT, relight, type LightSettings } from '../src/relight.ts';
import { surfaceFromCanvas, type ImpastoSurface } from '../src/surface.ts';
import { RELIGHT_WGSL, relightUniforms } from '../src/relight-gpu.ts';

const SIM_DIR = fileURLToPath(new URL('../', import.meta.url));
const SELF = fileURLToPath(import.meta.url);
const SCENES: Record<string, { image: string; widthMm: number }> = JSON.parse(readFileSync(new URL('./scenes.json', import.meta.url), 'utf8'));
/** Simulation cell size, mm (startPainting's default, as in the paint CLI). */
const DX = 0.1;
/** Mirrors planner.ts FEATURE_MM (not exported); only used for the standalone forms breakdown. */
const FEATURE_MM = 5;
const STAGES = ['load', 'setup', 'resample', 'analysis', 'forms', 'planning', 'canvas', 'painting', 'readback', 'relight', 'surface', 'total'] as const;
type Stage = typeof STAGES[number];

interface Job { scene: string; widthMm: number; look: 'oil' | 'locked'; planOnly: boolean; repeat: number; gpu: boolean; gpuFrames: number }
interface GpuResult { available: boolean; reason?: string; adapter?: string; uploadMs?: number; firstFrameMs?: number; frameMs?: number[]; medianMs?: number; minMs?: number; readbackFrameMs?: number }
interface RunResult {
  job: Job; ok: boolean; error?: string;
  image?: { w: number; h: number; mp: number };
  grid?: { w: number; h: number; mcells: number };
  canvas?: { w: number; h: number; mcells: number; dx: number };
  heightMm?: number; knifeScale?: number; strokes?: number; planHash?: string;
  ms?: Partial<Record<Stage, number>>;
  layers?: { name: string; strokes: number; planMs: number; paintMs: number; readbackMs: number }[];
  memory?: { peakRssMb: number; peakHeapUsedMb: number; peakExternalMb: number };
  formsCheck?: string;
  gpu?: GpuResult;
  wallMs?: number;
}

const args = process.argv.slice(2);

// ---------------------------------------------------------------------------------------------
// Worker: one scene at one width, one repeat.

/** A small synthetic landscape (as in planner.test.ts), for smoke tests that need no fixture. */
export function synthetic(w = 240, h = 120): RgbImage {
  const data = new Uint8Array(w * h * 3);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const t = y / h;
    let c = [150 + 60 * t, 190 + 40 * t, 235];
    if (y > 30 + Math.abs(x - 90) * 0.9 && y < 70) c = [95, 100, 115];
    if (y >= 70) c = [40, 170, 190];
    if (y >= 100) c = [140, 120, 95];
    if (x >= 170 && x < 176 && y > 25 && y < 105) c = [30, 70, 40];
    data.set(c.map((v) => Math.max(0, Math.min(255, Math.round(v)))), (y * w + x) * 3);
  }
  return { w, h, data };
}

async function worker(job: Job): Promise<void> {
  const r: RunResult = { job, ok: false };
  const ms: Partial<Record<Stage, number>> = {};
  let peakHeap = 0, peakExt = 0;
  const mem = () => { const m = process.memoryUsage(); peakHeap = Math.max(peakHeap, m.heapUsed); peakExt = Math.max(peakExt, m.external); };
  const timed = <T>(stage: Stage, f: () => T): T => { const t = performance.now(); const v = f(); ms[stage] = (ms[stage] ?? 0) + performance.now() - t; mem(); return v; };
  const t0 = performance.now();
  try {
    const img = timed('load', () => job.scene === 'synthetic' ? synthetic() : readPng(path.join(SIM_DIR, SCENES[job.scene].image)));
    const settings: PlanSettings = { ...DEFAULT_SETTINGS, widthMm: job.widthMm, look: job.look };
    const heightMm = job.widthMm * img.h / img.w;
    r.image = { w: img.w, h: img.h, mp: img.w * img.h / 1e6 };
    r.heightMm = heightMm;

    // The planner constructor: everything before the first layer.
    const planner = timed('setup', () => new Planner(img, settings));
    r.grid = { w: planner.gw, h: planner.gh, mcells: planner.gw * planner.gh / 1e6 };
    r.knifeScale = planner.knifeScale;
    progress(job, `setup ${(ms.setup! / 1000).toFixed(1)} s, grid ${planner.gw}x${planner.gh}, knife scale ${planner.knifeScale}`);

    // Standalone breakdown of the constructor, with the same inputs it used. In a function of its
    // own so its grids are garbage by the time the canvas is allocated (peak RSS stays the CLI's).
    r.formsCheck = ((): string => {
      const lin = timed('resample', () => resampleLinear(img, planner.gw, planner.gh));
      const lab = timed('resample', () => toOklab(lin));
      const maps = timed('analysis', () => paintingMaps(lab, settings.analysisMm));
      const ks = timed('analysis', () => job.look === 'oil' && settings.autoScale ? knifeScale(maps) : 1);
      const sizes = planner.s.formSizesMm, areaMm2 = settings.widthMm * heightMm, fc = FEATURE_MM * ks / settings.analysisMm;
      const forms = timed('forms', () => formHierarchy(lab, sizes.map((d) => Math.max(3, Math.round(areaMm2 / (d * d)))), sizes.length ? fc * fc : 0));
      // The breakdown is only meaningful if it rebuilt what the planner built.
      const same = forms.levels.length === planner.forms.levels.length && forms.levels.every((lv, i) => lv.count === planner.forms.levels[i].count) && forms.features.count === planner.forms.features.count;
      return same ? 'matches planner' : 'MISMATCH (planner.ts changed? breakdown approximate)';
    })();

    // planPainting, with the feedback timed apart (as `npm run paint` does).
    let painting: Painting | null = null;
    const layers: NonNullable<RunResult['layers']> = [];
    const feedback = (l: number, strokes: PlannedStroke[]) => {
      if (job.planOnly) return;
      painting ??= timed('canvas', () => startPainting(planner.plan, planner.s.ground));
      const a = performance.now();
      timed('painting', () => paintStrokes(painting!, strokes));
      const b = performance.now();
      planner.current = timed('readback', () => canvasColour(painting!.canvas, planner.current.w, planner.current.h));
      layers[l].paintMs += b - a; layers[l].readbackMs += performance.now() - b;
    };
    for (let l = 0; l < planner.s.layers.length; l++) {
      const a = performance.now();
      const strokes = timed('planning', () => planner.planLayer(l));
      layers.push({ name: planner.plan.layerNames[l], strokes: strokes.length, planMs: performance.now() - a, paintMs: 0, readbackMs: 0 });
      feedback(l, strokes);
      progress(job, `layer ${l} ${layers[l].name}: ${strokes.length} strokes, plan ${(layers[l].planMs / 1000).toFixed(1)} s, paint ${(layers[l].paintMs / 1000).toFixed(1)} s`);
    }
    const last = timed('planning', () => planner.flushDeferred());
    if (last.length) { const L = layers[layers.length - 1]; L.strokes += last.length; feedback(planner.s.layers.length - 1, last); }
    const plan = planner.plan;
    r.strokes = plan.strokes.length;
    r.planHash = createHash('sha256').update(JSON.stringify(plan.strokes)).digest('hex').slice(0, 16);
    r.layers = layers;

    let surface: ImpastoSurface | null = null;
    const light: LightSettings = { ...DEFAULT_LIGHT, look: job.look };
    if (painting) {
      const { canvas } = painting as Painting;
      r.canvas = { w: canvas.w, h: canvas.h, mcells: canvas.n / 1e6, dx: canvas.dx };
      timed('relight', () => relight(canvas, light, 'paint'));
      surface = timed('surface', () => surfaceFromCanvas(canvas));
    } else {
      const w = Math.round(job.widthMm / DX), h = Math.round(heightMm / DX);
      r.canvas = { w, h, mcells: w * h / 1e6, dx: DX };
    }
    ms.total = (['load', 'setup', 'planning', 'canvas', 'painting', 'readback', 'relight'] as Stage[]).reduce((s, k) => s + (ms[k] ?? 0), 0);
    r.ms = ms;
    r.wallMs = performance.now() - t0;
    r.memory = { peakRssMb: process.resourceUsage().maxRSS / 1024, peakHeapUsedMb: peakHeap / 2 ** 20, peakExternalMb: peakExt / 2 ** 20 };
    painting = null;
    if (job.gpu) {
      if (!surface) r.gpu = { available: false, reason: 'no canvas (--plan-only)' };
      else {
        progress(job, 'GPU relight timing');
        r.gpu = await gpuRelight(surface, light, job.gpuFrames).catch((e) => ({ available: false, reason: `error: ${String(e?.message ?? e).split('\n')[0]}` }));
      }
    }
    r.ok = true;
  } catch (e) {
    r.error = String((e as Error)?.stack ?? e);
  }
  process.stdout.write(`\nBENCH_RESULT ${JSON.stringify(r)}\n`);
}

function progress(job: Job, msg: string): void {
  process.stderr.write(`  [${job.scene} ${job.widthMm} mm #${job.repeat + 1}] ${msg}\n`);
}

/**
 * Times the WebGPU relight shader on `s` in headless Chromium (as gpu-parity.ts launches it). Each
 * frame changes the light azimuth, writes the uniforms, renders both passes (shading and the glow
 * composite) and waits for the queue to finish. Never throws for a missing WebGPU.
 */
async function gpuRelight(s: ImpastoSurface, light: LightSettings, frames: number): Promise<GpuResult> {
  let chromium;
  try { chromium = createRequire(import.meta.url)('playwright').chromium; } catch { return { available: false, reason: 'playwright not installed' }; }
  const bin: Record<string, Buffer> = {
    '/height.bin': Buffer.from(s.height.buffer, s.height.byteOffset, s.height.byteLength),
    '/color.bin': Buffer.from(s.color.buffer, s.color.byteOffset, s.color.byteLength),
  };
  const server = http.createServer((q, res) => {
    const b = bin[q.url ?? ''];
    if (b) { res.setHeader('content-type', 'application/octet-stream'); res.end(b); return; }
    res.setHeader('content-type', 'text/html'); res.end('<!doctype html><title>bench</title>');
  }).listen(0);
  const port = (server.address() as { port: number }).port;
  let browser;
  try {
    browser = await chromium.launch({ args: ['--enable-unsafe-webgpu', '--ignore-gpu-blocklist', '--enable-features=Vulkan', '--use-vulkan=swiftshader', '--use-webgpu-adapter=swiftshader'] });
    const page = await browser.newPage();
    await page.goto(`http://localhost:${port}/`);
    const uniforms = [0, 1, 2, 3, 4, 5, 6, 7].map((k) => Array.from(relightUniforms(s.w, s.h, s.dx, s.maxH, { ...light, azimuth: (light.azimuth + k * 45) % 360 }, 0)));
    const run = page.evaluate(async ({ W, H, uniforms, wgsl, frames }) => {
      if (!navigator.gpu) return { available: false, reason: 'navigator.gpu missing (no WebGPU)' };
      const a = await navigator.gpu.requestAdapter();
      if (!a) return { available: false, reason: 'no WebGPU adapter' };
      const info = a.info ?? {};
      const adapter = [info.vendor, info.architecture, info.device, info.description].filter(Boolean).join(' / ') || 'unknown';
      const maxDim = a.limits.maxTextureDimension2D;
      if (W > maxDim || H > maxDim) return { available: false, adapter, reason: `canvas ${W}x${H} exceeds maxTextureDimension2D ${maxDim}` };
      const d = await a.requestDevice({ requiredLimits: { maxTextureDimension2D: maxDim } });
      const t0 = performance.now();
      const [hb, cb] = await Promise.all(['/height.bin', '/color.bin'].map((u) => fetch(u).then((x) => x.arrayBuffer())));
      const tex = (f: GPUTextureFormat, bytes: number, arr: ArrayBuffer) => {
        const t = d.createTexture({ size: [W, H], format: f, usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
        d.queue.writeTexture({ texture: t }, arr, { bytesPerRow: W * bytes }, [W, H]);
        return t;
      };
      const ht = tex('rg32float', 8, hb), ct = tex('rgba32float', 16, cb);
      const m = d.createShaderModule({ code: wgsl });
      const ci = await m.getCompilationInfo();
      const errs = ci.messages.filter((x) => x.type === 'error');
      if (errs.length) return { available: false, adapter, reason: 'WGSL: ' + errs.map((x) => `${x.lineNum}:${x.linePos} ${x.message}`).join('; ') };
      const hdr = d.createTexture({ size: [W, H], format: 'rgba32float', usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING });
      const out = d.createTexture({ size: [W, H], format: 'rgba8unorm', usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC });
      const p = d.createRenderPipeline({ layout: 'auto', vertex: { module: m, entryPoint: 'vs' }, fragment: { module: m, entryPoint: 'fs', targets: [{ format: 'rgba32float' }] } });
      const q = d.createRenderPipeline({ layout: 'auto', vertex: { module: m, entryPoint: 'vs' }, fragment: { module: m, entryPoint: 'composite', targets: [{ format: 'rgba8unorm' }] } });
      const ub = d.createBuffer({ size: uniforms[0].length * 4, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
      const bg = d.createBindGroup({ layout: p.getBindGroupLayout(0), entries: [{ binding: 0, resource: ht.createView() }, { binding: 1, resource: ct.createView() }, { binding: 2, resource: { buffer: ub } }] });
      const bq = d.createBindGroup({ layout: q.getBindGroupLayout(0), entries: [{ binding: 2, resource: { buffer: ub } }, { binding: 3, resource: hdr.createView() }] });
      await d.queue.onSubmittedWorkDone();
      const uploadMs = performance.now() - t0;
      const bpr = Math.ceil(W * 4 / 256) * 256, buf = d.createBuffer({ size: bpr * H, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
      const frame = async (k: number, readback: boolean) => {
        const t = performance.now();
        d.queue.writeBuffer(ub, 0, new Float32Array(uniforms[k % uniforms.length]));
        const e = d.createCommandEncoder();
        const r1 = e.beginRenderPass({ colorAttachments: [{ view: hdr.createView(), loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 0] }] });
        r1.setPipeline(p); r1.setBindGroup(0, bg); r1.draw(3); r1.end();
        const r2 = e.beginRenderPass({ colorAttachments: [{ view: out.createView(), loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 1] }] });
        r2.setPipeline(q); r2.setBindGroup(0, bq); r2.draw(3); r2.end();
        if (readback) e.copyTextureToBuffer({ texture: out }, { buffer: buf, bytesPerRow: bpr }, [W, H]);
        d.queue.submit([e.finish()]);
        if (readback) { await buf.mapAsync(GPUMapMode.READ); buf.unmap(); } else await d.queue.onSubmittedWorkDone();
        return performance.now() - t;
      };
      const firstFrameMs = await frame(0, false); // pipeline compile and first use: the warm-up
      const frameMs: number[] = [];
      for (let k = 1; k <= frames; k++) frameMs.push(await frame(k, false));
      const readbackFrameMs = await frame(frames + 1, true);
      d.destroy();
      return { available: true, adapter, uploadMs, firstFrameMs, frameMs, readbackFrameMs };
    }, { W: s.w, H: s.h, uniforms, wgsl: RELIGHT_WGSL, frames });
    const limit = 20 * 60_000;
    const res = await Promise.race([run, new Promise<GpuResult>((ok) => setTimeout(() => ok({ available: false, reason: `timed out after ${limit / 60000} min` }), limit).unref())]) as GpuResult;
    if (res.frameMs?.length) { const f = res.frameMs.slice().sort((x, y) => x - y); res.medianMs = median(f); res.minMs = f[0]; }
    return res;
  } catch (e) {
    return { available: false, reason: `browser: ${String((e as Error)?.message ?? e).split('\n')[0]}` };
  } finally {
    await browser?.close().catch(() => {});
    server.close();
  }
}

// ---------------------------------------------------------------------------------------------
// Parent: jobs, aggregation, report.

function median(v: number[]): number { const s = v.slice().sort((a, b) => a - b), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; }

async function main(): Promise<void> {
  const opt = (n: string, d: string) => { const i = args.indexOf(`--${n}`); return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : d; };
  const flag = (n: string) => args.includes(`--${n}`);
  if (flag('help') || flag('h')) { console.log(readFileSync(SELF, 'utf8').split('*/')[0]); return; }
  const quick = flag('quick');
  const scenes = opt('scenes', quick ? 'lake' : 'lake,portrait,flowers,building').split(',').filter(Boolean);
  const widthTokens = opt('width', quick ? '60' : 'scene').split(',').filter(Boolean);
  const look = opt('look', 'oil');
  if (look !== 'oil' && look !== 'locked') throw new Error(`--look must be oil or locked, not ${look}`);
  const repeat = Math.max(1, +opt('repeat', '1') | 0);
  const planOnly = flag('plan-only'), gpu = flag('gpu'), gpuFrames = Math.max(1, +opt('gpu-frames', '5') | 0);
  for (const s of scenes) if (s !== 'synthetic' && !SCENES[s]) throw new Error(`no scene ${s}; have ${Object.keys(SCENES).join(', ')}, synthetic`);
  const jsonPath = path.resolve(opt('json', 'out/bench/latest.json'));
  mkdirSync(path.dirname(jsonPath), { recursive: true });

  const jobs: Job[] = [];
  for (const scene of scenes) {
    // 'scene' is the scene's own width (scenes.json), '0.5x' a fraction of it, a number is mm.
    const def = SCENES[scene]?.widthMm ?? 120;
    const widths = [...new Set(widthTokens.map((t) => t === 'scene' ? def : t.endsWith('x') ? Math.round(def * +t.slice(0, -1)) : +t))].sort((a, b) => a - b);
    for (const w of widths) {
      if (!(w > 0)) throw new Error(`bad --width ${widthTokens.join(',')}: use mm, 'scene' or a fraction like 0.5x`);
      // The GPU relight is timed once per scene, at its largest width: the size a viewer would show.
      for (let k = 0; k < repeat; k++) jobs.push({ scene, widthMm: w, look, planOnly, repeat: k, gpu: gpu && k === 0 && w === widths[widths.length - 1], gpuFrames });
    }
  }
  const machine = machineInfo();
  console.log(`bench: ${jobs.length} run(s): scenes ${scenes.join(',')}; widths ${widthTokens.join(',')} mm; look ${look}; repeat ${repeat}${planOnly ? '; plan only' : ''}${gpu ? '; gpu' : ''}`);
  console.log(`machine: ${machine.cpu} x${machine.cores}, ${machine.totalRamGb.toFixed(1)} GB, node ${machine.node}, commit ${machine.commit}; load average ${machine.loadAvgStart.map((x) => x.toFixed(2)).join(' ')}`);
  if (machine.loadAvgStart[0] > machine.cores * 0.5) console.log(`WARNING: 1-min load average ${machine.loadAvgStart[0].toFixed(2)} on ${machine.cores} cores: other work is running, timings will be inflated.`);

  const t0 = Date.now();
  const runs: RunResult[] = [];
  for (const [i, job] of jobs.entries()) {
    console.log(`\n[${i + 1}/${jobs.length}] ${job.scene} at ${job.widthMm} mm, ${job.look}${job.planOnly ? ', plan only' : ''}, repeat ${job.repeat + 1}/${repeat}  (${((Date.now() - t0) / 60000).toFixed(1)} min elapsed)`);
    const r = await runWorker(job);
    runs.push(r);
    if (!r.ok) console.log(`  FAILED: ${r.error?.split('\n').slice(0, 3).join(' | ')}`);
    else console.log(`  done in ${(r.wallMs! / 1000).toFixed(1)} s: ${r.strokes} strokes, canvas ${r.canvas!.w}x${r.canvas!.h}, peak RSS ${r.memory!.peakRssMb.toFixed(0)} MB`);
  }
  machine.loadAvgEnd = os.loadavg();
  const elapsedMin = (Date.now() - t0) / 60000;

  const groups = aggregate(runs);
  const fits = fitScaling(groups);
  const projections = project(groups, fits);
  const report = { kind: 'impasto-bench', version: 1, date: new Date().toISOString(), elapsedMin, command: `npm run bench -- ${args.join(' ')}`.trim(), machine, options: { scenes, widths: widthTokens, look, repeat, planOnly, gpu, gpuFrames, dxMm: DX, analysisMm: DEFAULT_SETTINGS.analysisMm }, results: groups, fits, projections, runs };
  const md = markdown(report);
  console.log('\n' + md);
  writeFileSync(jsonPath, JSON.stringify(report, null, 1));
  writeFileSync(jsonPath.replace(/\.json$/, '') + '.md', md);
  writeFileSync(path.join(path.dirname(jsonPath), 'summary.md'), md);
  console.log(`wrote ${path.relative(process.cwd(), jsonPath)}, ${path.relative(process.cwd(), jsonPath.replace(/\.json$/, '') + '.md')} and ${path.relative(process.cwd(), path.join(path.dirname(jsonPath), 'summary.md'))} (${elapsedMin.toFixed(1)} min)`);
  if (runs.some((r) => !r.ok)) process.exitCode = 1;
}

function runWorker(job: Job): Promise<RunResult> {
  return new Promise((done) => {
    const child = spawn(process.execPath, ['--experimental-strip-types', '--no-warnings', '--max-old-space-size=6000', SELF, '--worker', Buffer.from(JSON.stringify(job)).toString('base64')], { cwd: SIM_DIR, stdio: ['ignore', 'pipe', 'inherit'] });
    let out = '';
    child.stdout.on('data', (b) => { out += b; });
    child.on('close', (code, signal) => {
      const line = out.split('\n').find((l) => l.startsWith('BENCH_RESULT '));
      if (line) done(JSON.parse(line.slice('BENCH_RESULT '.length)));
      else done({ job, ok: false, error: `worker exited with ${signal ?? code} and no result (out of memory?)\n${out.slice(-2000)}` });
    });
  });
}

interface Machine { cpu: string; cores: number; node: string; v8: string; platform: string; totalRamGb: number; commit: string; date: string; loadAvgStart: number[]; loadAvgEnd?: number[] }
function machineInfo(): Machine {
  const git = (a: string[]) => { try { return execFileSync('git', a, { cwd: SIM_DIR, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return ''; } };
  const commit = git(['rev-parse', '--short', 'HEAD']) || 'unknown', dirty = git(['status', '--porcelain', '--untracked-files=no', '--', 'src', 'tests']) ? ' (with uncommitted changes)' : '';
  return { cpu: os.cpus()[0]?.model ?? 'unknown', cores: os.availableParallelism?.() ?? os.cpus().length, node: process.version, v8: process.versions.v8, platform: `${os.type()} ${os.release()} ${os.arch()}`, totalRamGb: os.totalmem() / 2 ** 30, commit: commit + dirty, date: new Date().toISOString(), loadAvgStart: os.loadavg() };
}

interface Group {
  scene: string; widthMm: number; look: string; planOnly: boolean; runs: number; failed: number;
  imageMp: number; gridMcells: number; canvasMcells: number; canvas: string; strokes: number; knifeScale: number; planHash: string; formsCheck: string;
  /** Per stage over successful repeats: median and min ms. */
  ms: Partial<Record<Stage, { median: number; min: number }>>;
  peakRssMb: number; peakHeapUsedMb: number; peakExternalMb: number;
  layers: RunResult['layers'];
  gpu?: GpuResult; cpuRelightMs?: number;
}

function aggregate(runs: RunResult[]): Group[] {
  const keys = [...new Set(runs.map((r) => `${r.job.scene}|${r.job.widthMm}`))];
  return keys.map((key) => {
    const all = runs.filter((r) => `${r.job.scene}|${r.job.widthMm}` === key), ok = all.filter((r) => r.ok), r0 = ok[0];
    const g: Group = { scene: all[0].job.scene, widthMm: all[0].job.widthMm, look: all[0].job.look, planOnly: all[0].job.planOnly, runs: ok.length, failed: all.length - ok.length,
      imageMp: r0?.image?.mp ?? 0, gridMcells: r0?.grid?.mcells ?? 0, canvasMcells: r0?.canvas?.mcells ?? 0, canvas: r0 ? `${r0.canvas!.w}x${r0.canvas!.h}${all[0].job.planOnly ? ' (not painted)' : ''}` : '-', strokes: r0?.strokes ?? 0,
      knifeScale: r0?.knifeScale ?? 0, planHash: r0?.planHash ?? '', formsCheck: r0?.formsCheck ?? '', ms: {},
      peakRssMb: Math.max(0, ...ok.map((r) => r.memory!.peakRssMb)), peakHeapUsedMb: Math.max(0, ...ok.map((r) => r.memory!.peakHeapUsedMb)), peakExternalMb: Math.max(0, ...ok.map((r) => r.memory!.peakExternalMb)),
      layers: r0?.layers, gpu: all.find((r) => r.gpu)?.gpu };
    for (const s of STAGES) { const v = ok.map((r) => r.ms![s]).filter((x): x is number => x !== undefined); if (v.length) g.ms[s] = { median: median(v), min: Math.min(...v) }; }
    if (new Set(ok.map((r) => r.planHash)).size > 1) g.planHash += ' (DIFFERS between repeats)';
    if (g.gpu) g.cpuRelightMs = g.ms.relight?.median;
    return g;
  });
}

interface Fit { scene: string; stage: string; a: number; b: number; r2: number; points: number; cellsMin: number; cellsMax: number }
/** Least squares on log t = log a + b log(canvas Mcells), per scene and stage, over the width sweep. */
function fitScaling(groups: Group[]): Fit[] {
  const fits: Fit[] = [];
  for (const scene of [...new Set(groups.map((g) => g.scene))]) {
    const gs = groups.filter((g) => g.scene === scene && g.runs > 0);
    if (new Set(gs.map((g) => g.canvasMcells)).size < 2) continue;
    for (const stage of ['total', 'setup', 'planning', 'painting', 'relight'] as Stage[]) {
      const pts = gs.filter((g) => (g.ms[stage]?.median ?? 0) > 0).map((g) => [Math.log(g.canvasMcells), Math.log(g.ms[stage]!.median)]);
      if (pts.length < 2) continue;
      const n = pts.length, mx = pts.reduce((s, p) => s + p[0], 0) / n, my = pts.reduce((s, p) => s + p[1], 0) / n;
      let sxx = 0, sxy = 0, syy = 0;
      for (const [x, y] of pts) { sxx += (x - mx) ** 2; sxy += (x - mx) * (y - my); syy += (y - my) ** 2; }
      const b = sxy / sxx, a = Math.exp(my - b * mx), r2 = syy > 0 ? (sxy * sxy) / (sxx * syy) : 1;
      fits.push({ scene, stage, a, b, r2, points: n, cellsMin: Math.min(...gs.map((g) => g.canvasMcells)), cellsMax: Math.max(...gs.map((g) => g.canvasMcells)) });
    }
  }
  return fits;
}

/** Sim canvas sizes (millions of 0.1 mm cells) to project to. 1 cell per photo pixel: "an N MP canvas". */
const PROJECT_MCELLS = [1, 4, 12, 24];
const PROJECT_PHOTO_MP = [1, 4, 12];
interface Projection { scene: string; measuredMaxMcells: number; byCanvas: { mcells: number; widthMm: number; ms: Record<string, number> }[]; byPhoto?: { photoMp: number; widthMm: number; ms: number; loadResampleMs: number }[] }
function project(groups: Group[], fits: Fit[]): Projection[] {
  const out: Projection[] = [];
  for (const scene of [...new Set(fits.map((f) => f.scene))]) {
    const fs = fits.filter((f) => f.scene === scene), g0 = groups.find((g) => g.scene === scene && g.runs > 0)!;
    const aspect = g0.canvasMcells > 0 ? (g0.widthMm / DX) ** 2 / (g0.canvasMcells * 1e6) : 1.5; // w/h
    const at = (stage: string, mc: number) => { const f = fs.find((x) => x.stage === stage); return f ? f.a * mc ** f.b : NaN; };
    const p: Projection = { scene, measuredMaxMcells: fs[0].cellsMax, byCanvas: PROJECT_MCELLS.map((mc) => ({ mcells: mc, widthMm: Math.round(Math.sqrt(mc * 1e6 * aspect) * DX), ms: Object.fromEntries(['total', 'setup', 'planning', 'painting', 'relight'].map((s) => [s, at(s, mc)])) })) };
    // Photo resolution only changes decoding and resampling (linear in input pixels); the canvas is
    // fixed by the physical width. Default width from scenes.json.
    const def = SCENES[scene]?.widthMm;
    const gd = groups.filter((g) => g.scene === scene && g.runs > 0);
    const lr = gd.map((g) => ((g.ms.load?.median ?? 0) + (g.ms.resample?.median ?? 0)) / g.imageMp);
    if (def && lr.length) {
      const perMp = median(lr), mc = Math.round(def / DX) * Math.round(def / aspect / DX) / 1e6, base = at('total', mc) - perMp * g0.imageMp;
      p.byPhoto = PROJECT_PHOTO_MP.map((mp) => ({ photoMp: mp, widthMm: def, ms: base + perMp * mp, loadResampleMs: perMp * mp }));
    }
    out.push(p);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Report.

const fmtMs = (v?: number) => v === undefined || !Number.isFinite(v) ? '-' : v >= 7_200_000 ? `${(v / 3_600_000).toFixed(1)} h` : v >= 100_000 ? `${(v / 60000).toFixed(1)} min` : v >= 10_000 ? `${(v / 1000).toFixed(0)} s` : v >= 1000 ? `${(v / 1000).toFixed(1)} s` : `${v.toFixed(v < 10 ? 1 : 0)} ms`;
const fmtN = (v: number, d = 1) => Number.isFinite(v) ? v.toFixed(d) : '-';
const row = (cells: (string | number)[]) => `| ${cells.join(' | ')} |`;

function markdown(r: { date: string; elapsedMin: number; command: string; machine: Machine; options: { look: string; repeat: number; planOnly: boolean }; results: Group[]; fits: Fit[]; projections: Projection[] }): string {
  const m = r.machine, L: string[] = [];
  L.push('# Impasto benchmark', '');
  L.push(`- Date: ${r.date} (${r.elapsedMin.toFixed(1)} min); command: \`${r.command}\``);
  L.push(`- Machine: ${m.cpu}, ${m.cores} cores, ${m.totalRamGb.toFixed(1)} GB RAM, ${m.platform}; Node ${m.node} (V8 ${m.v8}); commit ${m.commit}`);
  L.push(`- Load average (1/5/15 min) at start ${m.loadAvgStart.map((x) => x.toFixed(2)).join(' / ')}, at end ${(m.loadAvgEnd ?? []).map((x) => x.toFixed(2)).join(' / ')}${m.loadAvgStart[0] > m.cores * 0.5 ? ' — **machine was busy: timings inflated**' : ''}`);
  L.push(`- Look ${r.options.look}; ${r.options.repeat} repeat(s) per size, median shown (min in the JSON)${r.options.planOnly ? '; **plan only** (no simulation: the planner uses its own canvas estimate, so plans differ from a painted run)' : ''}`);
  L.push(`- Units: image MP = input photo pixels / 1e6; grid Mc = planner analysis cells (${DEFAULT_SETTINGS.analysisMm} mm) / 1e6; canvas Mc = simulation cells (${DX} mm) / 1e6.`, '');

  L.push('## Overview', '');
  L.push(row(['scene', 'width mm', 'image MP', 'grid Mc', 'canvas', 'canvas Mc', 'strokes', 'setup', 'planning', 'painting', 'relight (CPU)', 'total', 'peak RSS MB']));
  L.push(row(Array(13).fill('---')));
  for (const g of r.results) {
    if (!g.runs) { L.push(row([g.scene, g.widthMm, '**failed**', '', '', '', '', '', '', '', '', '', ''])); continue; }
    L.push(row([g.scene, g.widthMm, fmtN(g.imageMp, 2), fmtN(g.gridMcells, 2), g.canvas, fmtN(g.canvasMcells, 2), g.strokes, fmtMs(g.ms.setup?.median), fmtMs(g.ms.planning?.median), fmtMs(g.ms.painting?.median), fmtMs(g.ms.relight?.median), fmtMs(g.ms.total?.median), fmtN(g.peakRssMb, 0)]));
  }
  L.push('');

  for (const g of r.results.filter((x) => x.runs)) {
    L.push(`## ${g.scene}, ${g.widthMm} mm`, '');
    L.push(`Image ${fmtN(g.imageMp, 2)} MP, grid ${fmtN(g.gridMcells, 3)} Mc, canvas ${g.canvas} = ${fmtN(g.canvasMcells, 2)} Mc; ${g.strokes} strokes; knife scale ${g.knifeScale}; plan ${g.planHash}; forms breakdown ${g.formsCheck}. Peak RSS ${fmtN(g.peakRssMb, 0)} MB, heap used ${fmtN(g.peakHeapUsedMb, 0)} MB, external (typed arrays) ${fmtN(g.peakExternalMb, 0)} MB (heap and external sampled at stage boundaries).`, '');
    L.push(row(['stage', 'ms (median)', 'ms (min)', 'ms / image MP', 'ms / grid Mc', 'ms / canvas Mc', 'note']));
    L.push(row(Array(7).fill('---')));
    const note: Partial<Record<Stage, string>> = {
      setup: 'Planner constructor = resample + analysis + forms', resample: 'standalone (in setup)', analysis: 'standalone (in setup)', forms: 'standalone (in setup)',
      painting: g.strokes ? `${fmtN((g.ms.painting?.median ?? 0) / g.strokes, 2)} ms/stroke` : '', readback: 'canvasColour per layer', surface: 'not in total', total: 'load+setup+planning+canvas+painting+readback+relight',
    };
    for (const s of STAGES) {
      const v = g.ms[s]; if (!v) continue;
      L.push(row([s, fmtN(v.median, 0), fmtN(v.min, 0), fmtN(v.median / g.imageMp, 0), fmtN(v.median / g.gridMcells, 0), fmtN(v.median / g.canvasMcells, 0), note[s] ?? '']));
    }
    L.push('');
    if (g.layers?.length) {
      if (g.planOnly) {
        L.push(row(['layer', 'strokes', 'plan ms'])); L.push(row(Array(3).fill('---')));
        for (const l of g.layers) L.push(row([l.name, l.strokes, fmtN(l.planMs, 0)]));
      } else {
        L.push(row(['layer', 'strokes', 'plan ms', 'paint ms', 'paint ms/stroke', 'readback ms'])); L.push(row(Array(6).fill('---')));
        for (const l of g.layers) L.push(row([l.name, l.strokes, fmtN(l.planMs, 0), fmtN(l.paintMs, 0), l.strokes ? fmtN(l.paintMs / l.strokes, 2) : '-', fmtN(l.readbackMs, 0)]));
      }
      L.push('');
    }
    if (g.gpu) {
      const u = g.gpu;
      if (!u.available) L.push(`GPU relight: unavailable (${u.reason})${u.adapter ? `, adapter ${u.adapter}` : ''}.`, '');
      else L.push(`GPU relight (WebGPU, adapter ${u.adapter}): ${fmtN(u.medianMs!, 1)} ms per frame median (min ${fmtN(u.minMs!, 1)}, ${u.frameMs!.length} frames after one warm-up of ${fmtN(u.firstFrameMs!, 0)} ms; upload ${fmtN(u.uploadMs!, 0)} ms; a frame with readback ${fmtN(u.readbackFrameMs!, 0)} ms) against CPU relight ${fmtMs(g.cpuRelightMs)}: ${fmtN((g.cpuRelightMs ?? 0) / u.medianMs!, 1)}x.${/swiftshader/i.test(u.adapter ?? '') ? ' SwiftShader is a CPU implementation of Vulkan: a real GPU is far faster.' : ''}`, '');
    }
  }

  if (r.fits.length) {
    L.push('## Scaling with canvas size', '', 'Fit of time = a x (canvas Mc)^b over the width sweep (b = 1 is linear in canvas area).', '');
    L.push(row(['scene', 'stage', 'b', 'R²', 'points', 'fitted range Mc'])); L.push(row(Array(6).fill('---')));
    for (const f of r.fits) L.push(row([f.scene, f.stage, fmtN(f.b, 2), f.points > 2 ? fmtN(f.r2, 3) : '- (2 points)', f.points, `${fmtN(f.cellsMin, 2)}-${fmtN(f.cellsMax, 2)}`]));
    L.push('');
    L.push('### Projected (EXTRAPOLATED from the fit, not measured)', '');
    L.push(`By simulation canvas size. One canvas cell per photo pixel, so "N Mc" is also an N MP photo painted at ${DX} mm per pixel; the width is at the scene's aspect ratio.`, '');
    L.push(row(['scene', 'canvas Mc', 'width mm', 'setup', 'planning', 'painting', 'relight (CPU)', 'total', 'x largest measured'])); L.push(row(Array(9).fill('---')));
    for (const p of r.projections) for (const c of p.byCanvas) {
      const k = c.mcells / p.measuredMaxMcells;
      L.push(row([p.scene, c.mcells, c.widthMm, fmtMs(c.ms.setup), fmtMs(c.ms.planning), fmtMs(c.ms.painting), fmtMs(c.ms.relight), fmtMs(c.ms.total), k <= 1 ? 'within range' : k > 4 ? `**${fmtN(k, 1)}x (unreliable)**` : `${fmtN(k, 1)}x`]));
    }
    L.push('');
    const ph = r.projections.filter((p) => p.byPhoto);
    if (ph.length) {
      L.push('By input photo resolution at the scene\'s default width. The canvas is fixed by the physical width, so photo resolution only changes PNG decoding and resampling (scaled linearly from the measured ms per image MP).', '');
      L.push(row(['scene', 'width mm', ...PROJECT_PHOTO_MP.map((x) => `${x} MP photo`), 'of which load+resample at 12 MP'])); L.push(row(Array(PROJECT_PHOTO_MP.length + 3).fill('---')));
      for (const p of ph) L.push(row([p.scene, p.byPhoto![0].widthMm, ...p.byPhoto!.map((b) => fmtMs(b.ms)), fmtMs(p.byPhoto![p.byPhoto!.length - 1].loadResampleMs)]));
      L.push('');
    }
  } else L.push('No scaling fit: give at least two widths per scene (e.g. `--width 120,240,360`).', '');
  return L.join('\n');
}

// Dispatch last, so every module-level constant above is initialised. Importing this file runs nothing.
const isMain = !!process.argv[1] && path.resolve(process.argv[1]) === SELF;
if (isMain && args[0] === '--worker') await worker(JSON.parse(Buffer.from(args[1], 'base64').toString('utf8')) as Job);
else if (isMain) await main();
