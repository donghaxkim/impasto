/** Writes out/viewer-<scene>.html: a self-contained page for moving the light live with WebGPU. */
import { writeFileSync } from 'node:fs';
import { oneStrokeScene, patchScene } from './scenes.ts';
import { albedoField, DEFAULT_LIGHT, LOOKS, occlusionField, surfaceField } from '../src/relight.ts';
import { RELIGHT_WGSL } from '../src/relight-gpu.ts';

import type { PaintCanvas } from '../src/canvas.ts';

/** A self-contained page that relights this canvas live with WebGPU. */
export function viewerHtml(c: PaintCanvas): string {
  const S = surfaceField(c), O = occlusionField(c), A = albedoField(c);
  const height = new Float32Array(c.n * 2), color = new Float32Array(c.n * 4);
  let maxH = 0;
  for (let i = 0; i < c.n; i++) {
    height[i * 2] = S[i]; height[i * 2 + 1] = O[i]; if (O[i] > maxH) maxH = O[i];
    color[i * 4] = A[i * 3]; color[i * 4 + 1] = A[i * 3 + 1]; color[i * 4 + 2] = A[i * 3 + 2]; color[i * 4 + 3] = c.rough[i];
  }
  const html = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Impasto light viewer</title>
<style>body{margin:0;background:#1c1a18;color:#ddd;font:13px system-ui;padding:12px}canvas{max-width:100%;display:block;margin-bottom:10px;cursor:crosshair}
label{margin-right:14px;white-space:nowrap}#e{color:#f88}</style>
<canvas id="c" width="${c.w}" height="${c.h}"></canvas>
<label>Azimuth <input id="azimuth" type="range" min="0" max="360" value="${DEFAULT_LIGHT.azimuth}"></label>
<label>Elevation <input id="elevation" type="range" min="8" max="85" value="${DEFAULT_LIGHT.elevation}"></label>
<label>Relief <input id="relief" type="range" min="0" max="2" step="0.05" value="1"></label>
<label>Glow <input id="glow" type="range" min="0" max="2" step="0.05" value="${DEFAULT_LIGHT.glow}"></label>
<label>Look <select id="look"><option value="locked">Locked</option><option value="oil">Oil (new)</option></select></label>
<label>View <select id="view"><option value="0">Paint</option><option value="1">Color</option><option value="2">Height</option><option value="3">Normal</option><option value="4">Highlights</option><option value="5">Cavities</option><option value="6">Glow</option></select></label>
<div id="e"></div>
<script>
const b64=s=>Uint8Array.from(atob(s),x=>x.charCodeAt(0)).buffer;
const height=new Float32Array(b64("${Buffer.from(height.buffer).toString('base64')}"));
const color=new Float32Array(b64("${Buffer.from(color.buffer).toString('base64')}"));
const W=${c.w},H=${c.h},DX=${c.dx},MAXH=${maxH},OCC=${DEFAULT_LIGHT.occlusion},LOOKS=${JSON.stringify(LOOKS)};
const WGSL=${JSON.stringify(RELIGHT_WGSL)};
(async()=>{try{
 if(!navigator.gpu)throw new Error('WebGPU is not available in this browser.');
 const a=await navigator.gpu.requestAdapter();const d=await a.requestDevice();window.__a=a;window.__d=d;
 const cv=document.getElementById('c'),x=cv.getContext('webgpu'),fmt=navigator.gpu.getPreferredCanvasFormat();
 x.configure({device:d,format:fmt,alphaMode:'opaque',usage:GPUTextureUsage.RENDER_ATTACHMENT|GPUTextureUsage.COPY_SRC});window.__x=x;window.__fmt=fmt;
 const tex=(f,bytes,arr)=>{const t=d.createTexture({size:[W,H],format:f,usage:GPUTextureUsage.TEXTURE_BINDING|GPUTextureUsage.COPY_DST});d.queue.writeTexture({texture:t},arr,{bytesPerRow:W*bytes},[W,H]);return t};
 const ht=tex('rg32float',8,height),ct=tex('rgba32float',16,color);
 const m=d.createShaderModule({code:WGSL});
 const hdr=d.createTexture({size:[W,H],format:'rgba32float',usage:GPUTextureUsage.RENDER_ATTACHMENT|GPUTextureUsage.TEXTURE_BINDING});
 const p=d.createRenderPipeline({layout:'auto',vertex:{module:m,entryPoint:'vs'},fragment:{module:m,entryPoint:'fs',targets:[{format:'rgba32float'}]}});
 const q=d.createRenderPipeline({layout:'auto',vertex:{module:m,entryPoint:'vs'},fragment:{module:m,entryPoint:'composite',targets:[{format:fmt}]}});
 const ub=d.createBuffer({size:96,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST});
 const bg=d.createBindGroup({layout:p.getBindGroupLayout(0),entries:[{binding:0,resource:ht.createView()},{binding:1,resource:ct.createView()},{binding:2,resource:{buffer:ub}}]});
 const bq=d.createBindGroup({layout:q.getBindGroupLayout(0),entries:[{binding:2,resource:{buffer:ub}},{binding:3,resource:hdr.createView()}]});
 const v=i=>+document.getElementById(i).value;
 const draw=window.__draw=()=>{d.queue.writeBuffer(ub,0,(k=>new Float32Array([W,H,DX,v('relief'),v('azimuth'),v('elevation'),OCC,1,MAXH,v('view'),v('glow'),0,k.coatMin,k.micro,k.crestBoost,k.window2,k.specGain,k.specAA,k.cavityKey,k.cavityFill,k.richness,0,0,0]))(LOOKS[document.getElementById('look').value]));
  const e=d.createCommandEncoder();
  const r=e.beginRenderPass({colorAttachments:[{view:hdr.createView(),loadOp:'clear',storeOp:'store',clearValue:[0,0,0,0]}]});
  r.setPipeline(p);r.setBindGroup(0,bg);r.draw(3);r.end();
  const c=e.beginRenderPass({colorAttachments:[{view:x.getCurrentTexture().createView(),loadOp:'clear',storeOp:'store',clearValue:[0,0,0,1]}]});
  c.setPipeline(q);c.setBindGroup(0,bq);c.draw(3);c.end();
  d.queue.submit([e.finish()])};
 // Test hook: draw, composite into an offscreen texture and read the bytes back (RGBA).
 const q8=d.createRenderPipeline({layout:'auto',vertex:{module:m,entryPoint:'vs'},fragment:{module:m,entryPoint:'composite',targets:[{format:'rgba8unorm'}]}});
 const bq8=d.createBindGroup({layout:q8.getBindGroupLayout(0),entries:[{binding:2,resource:{buffer:ub}},{binding:3,resource:hdr.createView()}]});
 window.__readback=async()=>{draw();const t=d.createTexture({size:[W,H],format:'rgba8unorm',usage:GPUTextureUsage.RENDER_ATTACHMENT|GPUTextureUsage.COPY_SRC});
  const bpr=Math.ceil(W*4/256)*256,buf=d.createBuffer({size:bpr*H,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ});
  const e=d.createCommandEncoder();const r=e.beginRenderPass({colorAttachments:[{view:t.createView(),loadOp:'clear',storeOp:'store',clearValue:[0,0,0,1]}]});
  r.setPipeline(q8);r.setBindGroup(0,bq8);r.draw(3);r.end();e.copyTextureToBuffer({texture:t},{buffer:buf,bytesPerRow:bpr},[W,H]);d.queue.submit([e.finish()]);
  await buf.mapAsync(GPUMapMode.READ);const src=new Uint8Array(buf.getMappedRange()),out=new Array(W*H*3);
  for(let y=0;y<H;y++)for(let x=0;x<W;x++)for(let k=0;k<3;k++)out[(y*W+x)*3+k]=src[y*bpr+x*4+k];buf.unmap();return out};
 for(const i of ['azimuth','elevation','relief','glow','view','look'])document.getElementById(i).addEventListener('input',draw);
 draw();window.__ready=true;
}catch(err){document.getElementById('e').textContent=err.message}})();
</script>`;
  return html;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const out = new URL('../out/', import.meta.url).pathname;
  for (const [name, build] of [['one-stroke', oneStrokeScene], ['patch', patchScene]] as const) {
    const html = viewerHtml(build().canvas);
    writeFileSync(`${out}viewer-${name}.html`, html);
    console.log(`viewer-${name}.html`, (html.length / 1e6).toFixed(1), 'MB');
  }
}
