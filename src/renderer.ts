import { buildStrokeMesh } from './geometry';
import type { PaintingDocument, RenderSettings, Stroke } from './types';
import { lightingShader, surfaceShader } from './shaders';

const surfaceFormat: GPUTextureFormat = 'rgba16float';
const modes: Record<RenderSettings['view'], number> = {
  paint: 0,
  color: 1,
  height: 2,
  normal: 3,
};

type StrokeGpu = {
  vertex: GPUBuffer;
  index: GPUBuffer;
  indexCount: number;
  uniform: GPUBuffer;
};

export type Renderer = {
  setSettings(partial: Partial<RenderSettings>): void;
  render(): void;
  resize(width: number, height: number): void;
  dispose(): void;
  /** Dev aid: returns the retained relief heights in millimetres, row-major. */
  readHeight(): Promise<Float32Array>;
  stats: { surfacePasses: number; lightingPasses: number; strokeCount: number };
};

function srgbChannelToLinear(value: number): number {
  const c = Math.min(1, Math.max(0, value));
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function strokeParams(stroke: Stroke, document: PaintingDocument): Float32Array<ArrayBuffer> {
  const brush = stroke.brush === 'flat' ? 0 : 1;
  return new Float32Array([
    document.width, document.height, stroke.width, stroke.height,
    stroke.color[0], stroke.color[1], stroke.color[2], stroke.seed,
    stroke.roughness, brush, 0, 0,
  ]);
}

export async function createRenderer(canvas: HTMLCanvasElement, document: PaintingDocument): Promise<Renderer> {
  if (!navigator.gpu) throw new Error('WebGPU is not available in this browser.');
  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) throw new Error('No WebGPU adapter is available.');
  const device = await adapter.requestDevice();
  const context = canvas.getContext('webgpu');
  if (!context) throw new Error('Could not create a WebGPU canvas context.');

  const presentationFormat = navigator.gpu.getPreferredCanvasFormat();
  const canvasUsage = GPUTextureUsage.RENDER_ATTACHMENT;
  const createTexture = (width: number, height: number, label: string) => device.createTexture({
    label,
    size: { width, height, depthOrArrayLayers: 1 },
    format: surfaceFormat,
    usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC | GPUTextureUsage.COPY_DST,
  });

  const surfaceModule = device.createShaderModule({ label: 'impasto surface shader', code: surfaceShader });
  const lightingModule = device.createShaderModule({ label: 'impasto relighting shader', code: lightingShader });

  const strokeBindGroupLayout = device.createBindGroupLayout({
    entries: [
      { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
      { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
    ],
  });
  const surfacePipelineLayout = device.createPipelineLayout({ bindGroupLayouts: [strokeBindGroupLayout] });
  const colorBlend: GPUBlendState = {
    color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' },
    alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
  };
  const vertexBuffers: GPUVertexBufferLayout[] = [{
    arrayStride: 16,
    attributes: [
      { shaderLocation: 0, offset: 0, format: 'float32x2' },
      { shaderLocation: 1, offset: 8, format: 'float32x2' },
    ],
  }];
  const makeSurfacePipeline = (entryPoint: string, label: string, blend?: GPUBlendState): Promise<GPURenderPipeline> => device.createRenderPipelineAsync({
    label,
    layout: surfacePipelineLayout,
    vertex: { module: surfaceModule, entryPoint: 'surfaceVertex', buffers: vertexBuffers },
    fragment: { module: surfaceModule, entryPoint, targets: [{ format: surfaceFormat, ...(blend ? { blend } : {}) }] },
    primitive: { topology: 'triangle-list', frontFace: 'ccw', cullMode: 'none' },
  });
  const shaderModules = [surfaceModule, lightingModule];
  for (const module of shaderModules) {
    const info = await module.getCompilationInfo();
    const errors = info.messages.filter((message) => message.type === 'error');
    if (errors.length) {
      const details = errors.map((message) => `${message.lineNum}:${message.linePos} ${message.message}`).join('\n');
      throw new Error(`WebGPU shader compilation failed:\n${details}`);
    }
  }
  const pipelineResults = await Promise.allSettled([
    makeSurfacePipeline('colorFragment', 'paint pigment pass', colorBlend),
    makeSurfacePipeline('heightFragment', 'paint relief pass'),
  ]);
  const pipelineFailure = pipelineResults.find((result) => result.status === 'rejected');
  if (pipelineFailure?.status === 'rejected') {
    throw new Error(`WebGPU surface pipeline creation failed: ${String(pipelineFailure.reason)}`);
  }
  const colorPipeline = (pipelineResults[0] as PromiseFulfilledResult<GPURenderPipeline>).value;
  const heightPipeline = (pipelineResults[1] as PromiseFulfilledResult<GPURenderPipeline>).value;

  const lightingBindGroupLayout = device.createBindGroupLayout({ entries: [
    { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
    { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
    { binding: 2, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
  ] });
  let lightingPipeline: GPURenderPipeline;
  try {
    lightingPipeline = await device.createRenderPipelineAsync({
    label: 'full canvas relighting',
    layout: device.createPipelineLayout({ bindGroupLayouts: [lightingBindGroupLayout] }),
    vertex: { module: lightingModule, entryPoint: 'fullscreenVertex' },
    fragment: { module: lightingModule, entryPoint: 'lightingFragment', targets: [{ format: presentationFormat }] },
    primitive: { topology: 'triangle-list' },
    });
  } catch (error) {
    throw new Error(`WebGPU lighting pipeline creation failed: ${String(error)}`);
  }

  const strokeGpu: StrokeGpu[] = [];
  for (const stroke of document.strokes) {
    const mesh = buildStrokeMesh(stroke);
    if (mesh.indices.length === 0 || mesh.vertices.length === 0) continue;
    const vertex = device.createBuffer({ label: `stroke ${stroke.id} vertices`, size: mesh.vertices.byteLength, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
    const index = device.createBuffer({ label: `stroke ${stroke.id} indices`, size: mesh.indices.byteLength, usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST });
    device.queue.writeBuffer(vertex, 0, mesh.vertices);
    device.queue.writeBuffer(index, 0, mesh.indices);
    const uniform = device.createBuffer({ label: `stroke ${stroke.id} parameters`, size: 48, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    device.queue.writeBuffer(uniform, 0, strokeParams(stroke, document));
    strokeGpu.push({ vertex, index, indexCount: mesh.indices.length, uniform });
  }

  const initialWidth = Math.max(1, canvas.width);
  const initialHeight = Math.max(1, canvas.height);
  let width = initialWidth;
  let height = initialHeight;
  let colorTarget = createTexture(width, height, 'retained pigment surface');
  let heightTarget = createTexture(width, height, 'retained sculptural relief');
  let heightSpare = createTexture(width, height, 'relief deposition scratch');
  const makeColorBindGroups = () => strokeGpu.map((stroke) => device.createBindGroup({
      layout: strokeBindGroupLayout,
      entries: [
        { binding: 0, resource: { buffer: stroke.uniform } },
        { binding: 1, resource: heightTarget.createView() },
      ],
    }));
  let colorBindGroups = makeColorBindGroups();
  const lightingUniform = device.createBuffer({ label: 'live lighting parameters', size: 48, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  const ground = new Float32Array([
    srgbChannelToLinear(document.ground[0]), srgbChannelToLinear(document.ground[1]), srgbChannelToLinear(document.ground[2]), 1,
  ]);
  const clearColor: GPURenderPassColorAttachment['clearValue'] = { r: ground[0], g: ground[1], b: ground[2], a: 1 };
  let settings: RenderSettings = {
    lightAzimuth: 35,
    lightElevation: 48,
    relief: 1,
    roughness: 0.75,
    exposure: 1,
    view: 'paint',
  };
  let disposed = false;
  let lightingBindGroup: GPUBindGroup;
  const stats = { surfacePasses: 0, lightingPasses: 0, strokeCount: document.strokes.length };

  const writeLighting = () => {
    const packed = new Float32Array([
      document.width, document.height, document.canvasMm, settings.relief,
      settings.lightAzimuth, settings.lightElevation, settings.roughness, settings.exposure,
      modes[settings.view], 0, 0, 0,
    ]);
    device.queue.writeBuffer(lightingUniform, 0, packed);
  };
  const updateLightingBindGroup = () => {
    lightingBindGroup = device.createBindGroup({
      layout: lightingBindGroupLayout,
      entries: [
        { binding: 0, resource: colorTarget.createView() },
        { binding: 1, resource: heightTarget.createView() },
        { binding: 2, resource: { buffer: lightingUniform } },
      ],
    });
  };

  const renderSurface = () => {
    const encoder = device.createCommandEncoder({ label: 'rasterize retained paint surfaces' });
    const drawSurface = (target: GPUTexture, pipeline: GPURenderPipeline, label: string, clear: GPURenderPassColorAttachment['clearValue']) => {
      const pass = encoder.beginRenderPass({
        label,
        colorAttachments: [{ view: target.createView(), clearValue: clear, loadOp: 'clear', storeOp: 'store' }],
      });
      pass.setPipeline(pipeline);
      for (let strokeIndex = 0; strokeIndex < strokeGpu.length; strokeIndex += 1) {
        const stroke = strokeGpu[strokeIndex];
        if (stroke.indexCount === 0) continue;
        pass.setBindGroup(0, colorBindGroups[strokeIndex]);
        pass.setVertexBuffer(0, stroke.vertex);
        pass.setIndexBuffer(stroke.index, 'uint32');
        pass.drawIndexed(stroke.indexCount);
      }
      pass.end();
    };
    drawSurface(colorTarget, colorPipeline, 'ordered pigment compositing', clearColor);
    let current = heightTarget;
    let next = heightSpare;
    const clearPass = encoder.beginRenderPass({
      label: 'clear starting relief',
      colorAttachments: [{ view: current.createView(), clearValue: { r: 0, g: 0.8, b: 0, a: 1 }, loadOp: 'clear', storeOp: 'store' }],
    });
    clearPass.end();
    for (let strokeIndex = 0; strokeIndex < strokeGpu.length; strokeIndex += 1) {
      const stroke = strokeGpu[strokeIndex];
      encoder.copyTextureToTexture({ texture: current }, { texture: next }, { width, height, depthOrArrayLayers: 1 });
      const pass = encoder.beginRenderPass({
        label: `deposit relief layer ${strokeIndex + 1}`,
        colorAttachments: [{ view: next.createView(), loadOp: 'load', storeOp: 'store' }],
      });
      pass.setPipeline(heightPipeline);
      pass.setBindGroup(0, device.createBindGroup({
        layout: strokeBindGroupLayout,
        entries: [
          { binding: 0, resource: { buffer: stroke.uniform } },
          { binding: 1, resource: current.createView() },
        ],
      }));
      pass.setVertexBuffer(0, stroke.vertex);
      pass.setIndexBuffer(stroke.index, 'uint32');
      pass.drawIndexed(stroke.indexCount);
      pass.end();
      [current, next] = [next, current];
    }
    if (current !== heightTarget) [heightTarget, heightSpare] = [heightSpare, heightTarget];
    device.queue.submit([encoder.finish()]);
    stats.surfacePasses += 2 + strokeGpu.length;
  };

  const present = () => {
    if (disposed) return;
    writeLighting();
    const encoder = device.createCommandEncoder({ label: 'relight impasto painting' });
    const pass = encoder.beginRenderPass({
      label: 'fullscreen normal and lighting evaluation',
      colorAttachments: [{ view: context!.getCurrentTexture().createView(), loadOp: 'clear', storeOp: 'store', clearValue: clearColor }],
    });
    pass.setPipeline(lightingPipeline);
    pass.setBindGroup(0, lightingBindGroup);
    pass.draw(3);
    pass.end();
    device.queue.submit([encoder.finish()]);
    stats.lightingPasses += 1;
  };

  context.configure({ device, format: presentationFormat, alphaMode: 'opaque', usage: canvasUsage });
  updateLightingBindGroup();
  renderSurface();
  updateLightingBindGroup();

  return {
    setSettings(partial) {
      if (disposed) return;
      settings = { ...settings, ...partial };
      present();
    },
    render() {
      present();
    },
    resize(nextWidth, nextHeight) {
      if (disposed) return;
      const w = Math.max(1, Math.floor(nextWidth));
      const h = Math.max(1, Math.floor(nextHeight));
      canvas.width = w;
      canvas.height = h;
      if (w === width && h === height) {
        present();
        return;
      }
      width = w;
      height = h;
      colorTarget.destroy();
      heightTarget.destroy();
      heightSpare.destroy();
      colorTarget = createTexture(width, height, 'retained pigment surface');
      heightTarget = createTexture(width, height, 'retained sculptural relief');
      heightSpare = createTexture(width, height, 'relief deposition scratch');
      colorBindGroups = makeColorBindGroups();
      updateLightingBindGroup();
      renderSurface();
      updateLightingBindGroup();
      present();
    },
    async readHeight() {
      const rowBytes = width * 8;
      const bytesPerRow = Math.ceil(rowBytes / 256) * 256;
      const buffer = device.createBuffer({ label: 'relief readback', size: bytesPerRow * height, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
      const encoder = device.createCommandEncoder({ label: 'read retained relief' });
      encoder.copyTextureToBuffer({ texture: heightTarget }, { buffer, bytesPerRow, rowsPerImage: height }, { width, height, depthOrArrayLayers: 1 });
      device.queue.submit([encoder.finish()]);
      await buffer.mapAsync(GPUMapMode.READ);
      const packed = new Uint16Array(buffer.getMappedRange());
      const out = new Float32Array(width * height);
      const halfToFloat = (bits: number): number => {
        const sign = bits & 0x8000 ? -1 : 1;
        const exponent = (bits >> 10) & 0x1f;
        const mantissa = bits & 0x3ff;
        if (exponent === 0) return sign * Math.pow(2, -14) * (mantissa / 1024);
        if (exponent === 31) return mantissa ? NaN : sign * Infinity;
        return sign * Math.pow(2, exponent - 15) * (1 + mantissa / 1024);
      };
      for (let y = 0; y < height; y += 1) {
        for (let x = 0; x < width; x += 1) {
          out[y * width + x] = halfToFloat(packed[(y * bytesPerRow + x * 8) / 2]);
        }
      }
      buffer.unmap();
      buffer.destroy();
      return out;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const stroke of strokeGpu) {
        stroke.vertex.destroy();
        stroke.index.destroy();
        stroke.uniform.destroy();
      }
      lightingUniform.destroy();
      colorTarget.destroy();
      heightTarget.destroy();
      heightSpare.destroy();
      context.unconfigure();
      device.destroy();
    },
    stats,
  };
}
