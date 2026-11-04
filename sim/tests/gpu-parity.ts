/**
 * Renders a scene with the WebGPU shader (RELIGHT_WGSL, offscreen, SwiftShader in headless
 * Chromium) and with the CPU reference, for each look, and reports how far the pixels differ.
 *   node --experimental-strip-types tests/gpu-parity.ts
 * Exit code 0 when the mean difference is under one 8-bit level, 2 when WebGPU is unavailable.
 */
import { createRequire } from 'node:module';
import http from 'node:http';
import { PaintCanvas } from '../src/canvas.ts';
import { paintStroke, Tool } from '../src/tool.ts';
import { albedoField, DEFAULT_LIGHT, occlusionField, relight, surfaceField, type LookName } from '../src/relight.ts';
import { RELIGHT_WGSL, relightUniforms } from '../src/relight-gpu.ts';

const { chromium } = createRequire(import.meta.url)('playwright');

// A small scene with crests, heaps, berms and a crevice.
const c = new PaintCanvas(40, 30, 0.1, [0.58, 0.47, 0.37], 7);
const knife = new Tool({ kind: 'knife', widthMm: 12, nodes: 112, seed: 5 });
knife.load(12, [0.86, 0.30, 0.20], [0.97, 0.88, 0.70], 0.28, 11);
paintStroke(c, knife, { points: [[3, 10], [14, 8], [26, 11], [38, 9]], gapMm: 1.0, seed: 3 });
knife.load(10, [0.12, 0.42, 0.47], [0.86, 0.66, 0.28], 0.25, 12);
paintStroke(c, knife, { points: [[3, 21], [14, 17], [26, 22], [38, 18]], gapMm: 0.9, seed: 4 });

const S = surfaceField(c), O = occlusionField(c), A = albedoField(c);
const height = new Float32Array(c.n * 2), color = new Float32Array(c.n * 4);
let maxH = 0;
for (let i = 0; i < c.n; i++) {
  height[i * 2] = S[i]; height[i * 2 + 1] = O[i]; if (O[i] > maxH) maxH = O[i];
  color[i * 4] = A[i * 3]; color[i * 4 + 1] = A[i * 3 + 1]; color[i * 4 + 2] = A[i * 3 + 2]; color[i * 4 + 3] = c.rough[i];
}

// WebGPU needs a secure context; localhost counts, about:blank does not.
const server = http.createServer((_q, r) => { r.setHeader('content-type', 'text/html'); r.end('<!doctype html><title>parity</title>'); }).listen(0);
const port = (server.address() as { port: number }).port;
const browser = await chromium.launch({ args: ['--enable-unsafe-webgpu', '--ignore-gpu-blocklist', '--enable-features=Vulkan', '--use-vulkan=swiftshader', '--use-webgpu-adapter=swiftshader'] });
const page = await browser.newPage();
await page.goto(`http://localhost:${port}/`);

let worst = 0;
for (const look of ['locked', 'oil'] as LookName[]) {
  const light = { ...DEFAULT_LIGHT, look };
  const gpu: number[] | string = await page.evaluate(async ({ W, H, height, color, uniforms, wgsl }) => {
    if (!navigator.gpu) return 'no WebGPU';
    const a = await navigator.gpu.requestAdapter();
    if (!a) return 'no adapter';
    const d = await a.requestDevice();
    const tex = (f: GPUTextureFormat, bytes: number, arr: Float32Array) => {
      const t = d.createTexture({ size: [W, H], format: f, usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
      d.queue.writeTexture({ texture: t }, arr, { bytesPerRow: W * bytes }, [W, H]);
      return t;
    };
    const ht = tex('rg32float', 8, new Float32Array(height)), ct = tex('rgba32float', 16, new Float32Array(color));
    const m = d.createShaderModule({ code: wgsl });
    const info = await m.getCompilationInfo();
    const errs = info.messages.filter((x) => x.type === 'error');
    if (errs.length) return 'WGSL: ' + errs.map((x) => `${x.lineNum}:${x.linePos} ${x.message}`).join('; ');
    const hdr = d.createTexture({ size: [W, H], format: 'rgba32float', usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING });
    const out = d.createTexture({ size: [W, H], format: 'rgba8unorm', usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC });
    const p = d.createRenderPipeline({ layout: 'auto', vertex: { module: m, entryPoint: 'vs' }, fragment: { module: m, entryPoint: 'fs', targets: [{ format: 'rgba32float' }] } });
    const q = d.createRenderPipeline({ layout: 'auto', vertex: { module: m, entryPoint: 'vs' }, fragment: { module: m, entryPoint: 'composite', targets: [{ format: 'rgba8unorm' }] } });
    const ub = d.createBuffer({ size: uniforms.length * 4, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    d.queue.writeBuffer(ub, 0, new Float32Array(uniforms));
    const bg = d.createBindGroup({ layout: p.getBindGroupLayout(0), entries: [{ binding: 0, resource: ht.createView() }, { binding: 1, resource: ct.createView() }, { binding: 2, resource: { buffer: ub } }] });
    const bq = d.createBindGroup({ layout: q.getBindGroupLayout(0), entries: [{ binding: 2, resource: { buffer: ub } }, { binding: 3, resource: hdr.createView() }] });
    const bpr = Math.ceil(W * 4 / 256) * 256, buf = d.createBuffer({ size: bpr * H, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    const e = d.createCommandEncoder();
    const r1 = e.beginRenderPass({ colorAttachments: [{ view: hdr.createView(), loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 0] }] });
    r1.setPipeline(p); r1.setBindGroup(0, bg); r1.draw(3); r1.end();
    const r2 = e.beginRenderPass({ colorAttachments: [{ view: out.createView(), loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 1] }] });
    r2.setPipeline(q); r2.setBindGroup(0, bq); r2.draw(3); r2.end();
    e.copyTextureToBuffer({ texture: out }, { buffer: buf, bytesPerRow: bpr }, [W, H]);
    d.queue.submit([e.finish()]);
    await buf.mapAsync(GPUMapMode.READ);
    const src = new Uint8Array(buf.getMappedRange()), px: number[] = new Array(W * H * 3);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) for (let k = 0; k < 3; k++) px[(y * W + x) * 3 + k] = src[y * bpr + x * 4 + k];
    return px;
  }, { W: c.w, H: c.h, height: Array.from(height), color: Array.from(color), uniforms: Array.from(relightUniforms(c.w, c.h, c.dx, maxH, light, 0)), wgsl: RELIGHT_WGSL });
  if (typeof gpu === 'string') { console.log('WebGPU unavailable:', gpu); await browser.close(); server.close(); process.exit(2); }
  const cpu = relight(c, light, 'paint');
  let sum = 0, max = 0, over4 = 0;
  for (let i = 0; i < cpu.length; i++) { const dl = Math.abs(cpu[i] - gpu[i]); sum += dl; if (dl > max) max = dl; if (dl > 4) over4++; }
  console.log(`${look.padEnd(6)} mean |diff| ${(sum / cpu.length).toFixed(3)} levels, max ${max}, ${(100 * over4 / cpu.length).toFixed(3)}% of channels differ by more than 4`);
  worst = Math.max(worst, sum / cpu.length);
}
await browser.close();
server.close();
process.exit(worst < 1 ? 0 : 1);
