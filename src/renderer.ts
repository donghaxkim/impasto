import { buildStrokeMesh } from './geometry';
import type { PaintingDocument, RenderSettings, Stroke } from './types';
import { lightingShader, substrateShader, surfaceShader } from './shaders';

const colorFormat: GPUTextureFormat = 'rgba16float';
const heightFormat: GPUTextureFormat = 'rgba32float';
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

function strokeParams(stroke: Stroke, document: PaintingDocument, arcLength: number): Float32Array<ArrayBuffer> {
  const brush = stroke.brush === 'flat' ? 0 : 1;
  const widthMm = stroke.width / Math.max(document.width, document.height) * document.canvasMm;
  const secondaryColor = stroke.secondaryColor ?? [0, 0, 0];
  const profile = stroke.profile ?? (stroke.height <= 0.20 && stroke.opacity !== undefined && stroke.opacity < 1
    ? 'dry-scumble'
    : stroke.brush === 'flat' ? 'knife' : 'loaded-filbert');
  const profileCode = profile === 'knife' ? 0 : profile === 'loaded-filbert' ? 1 : 2;
  const edgeRidge = stroke.edgeRidge ?? (profile === 'knife' ? 0.72 : profile === 'loaded-filbert' ? 0.34 : 0.10);
  const taperEnd = stroke.taperEnd ?? (profile === 'knife' ? 'blunt' : 'lifted');
  const taperCode = taperEnd === 'blunt' ? 0 : taperEnd === 'lifted' ? 1 : 2;
  return new Float32Array([
    document.width, document.height, stroke.width, stroke.height,
    stroke.color[0], stroke.color[1], stroke.color[2], stroke.seed,
    stroke.roughness, brush, arcLength, widthMm,
    document.canvasMm, stroke.opacity ?? 1, 0, 0,
    secondaryColor[0], secondaryColor[1], secondaryColor[2], stroke.secondaryMix ?? 0,
    profileCode, Math.max(0, Math.min(1, edgeRidge)), taperCode, 0,
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
  const createTexture = (width: number, height: number, label: string, format: GPUTextureFormat) => device.createTexture({
    label,
    size: { width, height, depthOrArrayLayers: 1 },
    format,
    usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC | GPUTextureUsage.COPY_DST,
  });

  const surfaceModule = device.createShaderModule({ label: 'impasto surface shader', code: surfaceShader });
  const substrateModule = device.createShaderModule({ label: 'impasto substrate shader', code: substrateShader });
  const lightingModule = device.createShaderModule({ label: 'impasto relighting shader', code: lightingShader });

  const strokeBindGroupLayout = device.createBindGroupLayout({
    entries: [
      { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
      { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'unfilterable-float' } },
      { binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'unfilterable-float' } },
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
  const makeSurfacePipeline = (entryPoint: string, label: string, format: GPUTextureFormat, blend?: GPUBlendState): Promise<GPURenderPipeline> => device.createRenderPipelineAsync({
    label,
    layout: surfacePipelineLayout,
    vertex: { module: surfaceModule, entryPoint: 'surfaceVertex', buffers: vertexBuffers },
    fragment: { module: surfaceModule, entryPoint, targets: [{ format, ...(blend ? { blend } : {}) }] },
    primitive: { topology: 'triangle-list', frontFace: 'ccw', cullMode: 'none' },
  });
  const shaderModules = [surfaceModule, substrateModule, lightingModule];
  for (const module of shaderModules) {
    const info = await module.getCompilationInfo();
    const errors = info.messages.filter((message) => message.type === 'error');
    if (errors.length) {
      const details = errors.map((message) => `${message.lineNum}:${message.linePos} ${message.message}`).join('\n');
      throw new Error(`WebGPU shader compilation failed:\n${details}`);
    }
  }
  const pipelineResults = await Promise.allSettled([
    makeSurfacePipeline('colorFragment', 'paint pigment pass', colorFormat, colorBlend),
    makeSurfacePipeline('heightFragment', 'paint relief pass', heightFormat),
  ]);
  const pipelineFailure = pipelineResults.find((result) => result.status === 'rejected');
  if (pipelineFailure?.status === 'rejected') {
    throw new Error(`WebGPU surface pipeline creation failed: ${String(pipelineFailure.reason)}`);
  }
  const colorPipeline = (pipelineResults[0] as PromiseFulfilledResult<GPURenderPipeline>).value;
  const heightPipeline = (pipelineResults[1] as PromiseFulfilledResult<GPURenderPipeline>).value;

  const substrateBindGroupLayout = device.createBindGroupLayout({ entries: [
    { binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
  ] });
  const lightingBindGroupLayout = device.createBindGroupLayout({ entries: [
    { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'unfilterable-float' } },
    { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'unfilterable-float' } },
    { binding: 2, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
  ] });
  let substratePipeline: GPURenderPipeline;
  let lightingPipeline: GPURenderPipeline;
  try {
    substratePipeline = await device.createRenderPipelineAsync({
      label: 'retained linen substrate',
      layout: device.createPipelineLayout({ bindGroupLayouts: [substrateBindGroupLayout] }),
      vertex: { module: substrateModule, entryPoint: 'fullscreenVertex' },
      fragment: { module: substrateModule, entryPoint: 'substrateFragment', targets: [{ format: heightFormat }] },
      primitive: { topology: 'triangle-list' },
    });
    lightingPipeline = await device.createRenderPipelineAsync({
    label: 'full canvas relighting',
    layout: device.createPipelineLayout({ bindGroupLayouts: [lightingBindGroupLayout] }),
    vertex: { module: lightingModule, entryPoint: 'fullscreenVertex' },
    fragment: { module: lightingModule, entryPoint: 'lightingFragment', targets: [{ format: presentationFormat }] },
    primitive: { topology: 'triangle-list' },
    });
  } catch (error) {
    throw new Error(`WebGPU fullscreen pipeline creation failed: ${String(error)}`);
  }

  const strokeGpu: StrokeGpu[] = [];
  for (const stroke of document.strokes) {
    const mesh = buildStrokeMesh(stroke);
    if (mesh.indices.length === 0 || mesh.vertices.length === 0) continue;
    const vertex = device.createBuffer({ label: `stroke ${stroke.id} vertices`, size: mesh.vertices.byteLength, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
    const index = device.createBuffer({ label: `stroke ${stroke.id} indices`, size: mesh.indices.byteLength, usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST });
    device.queue.writeBuffer(vertex, 0, mesh.vertices);
    device.queue.writeBuffer(index, 0, mesh.indices);
    const uniform = device.createBuffer({ label: `stroke ${stroke.id} parameters`, size: 96, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    device.queue.writeBuffer(uniform, 0, strokeParams(stroke, document, mesh.arcLength));
    strokeGpu.push({ vertex, index, indexCount: mesh.indices.length, uniform });
  }

  const initialWidth = Math.max(1, canvas.width);
  const initialHeight = Math.max(1, canvas.height);
  let width = initialWidth;
  let height = initialHeight;
  let colorTarget = createTexture(width, height, 'retained pigment surface', colorFormat);
  let colorSpare = createTexture(width, height, 'pigment deposition scratch', colorFormat);
  let heightTarget = createTexture(width, height, 'retained sculptural relief', heightFormat);
  let heightSpare = createTexture(width, height, 'relief deposition scratch', heightFormat);
  const lightingUniform = device.createBuffer({ label: 'live lighting parameters', size: 48, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  const substrateUniform = device.createBuffer({ label: 'canvas substrate parameters', size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  device.queue.writeBuffer(substrateUniform, 0, new Float32Array([document.width, document.height, document.canvasMm, 0.82]));
  const substrateBindGroup = device.createBindGroup({
    layout: substrateBindGroupLayout,
    entries: [{ binding: 0, resource: { buffer: substrateUniform } }],
  });
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
    const clearPigment = encoder.beginRenderPass({
      label: 'clear retained pigment surface',
      colorAttachments: [{ view: colorTarget.createView(), clearValue: clearColor, loadOp: 'clear', storeOp: 'store' }],
    });
    clearPigment.end();
    const substratePass = encoder.beginRenderPass({
      label: 'draw linen substrate into retained relief',
      colorAttachments: [{ view: heightTarget.createView(), loadOp: 'clear', storeOp: 'store', clearValue: { r: 0, g: 0.82, b: 0, a: 1 } }],
    });
    substratePass.setPipeline(substratePipeline);
    substratePass.setBindGroup(0, substrateBindGroup);
    substratePass.draw(3);
    substratePass.end();

    let currentColor = colorTarget;
    let nextColor = colorSpare;
    let currentHeight = heightTarget;
    let nextHeight = heightSpare;
    for (let strokeIndex = 0; strokeIndex < strokeGpu.length; strokeIndex += 1) {
      const stroke = strokeGpu[strokeIndex];
      if (stroke.indexCount === 0) continue;

      const surfaceBindGroup = (priorSurface: GPUTexture, priorHeight: GPUTexture) => device.createBindGroup({
        layout: strokeBindGroupLayout,
        entries: [
          { binding: 0, resource: { buffer: stroke.uniform } },
          { binding: 1, resource: priorSurface.createView() },
          { binding: 2, resource: priorHeight.createView() },
        ],
      });

      encoder.copyTextureToTexture({ texture: currentColor }, { texture: nextColor }, { width, height, depthOrArrayLayers: 1 });
      const pigmentPass = encoder.beginRenderPass({
        label: `deposit pigment layer ${strokeIndex + 1}`,
        colorAttachments: [{ view: nextColor.createView(), loadOp: 'load', storeOp: 'store' }],
      });
      pigmentPass.setPipeline(colorPipeline);
      pigmentPass.setBindGroup(0, surfaceBindGroup(currentColor, currentHeight));
      pigmentPass.setVertexBuffer(0, stroke.vertex);
      pigmentPass.setIndexBuffer(stroke.index, 'uint32');
      pigmentPass.drawIndexed(stroke.indexCount);
      pigmentPass.end();

      encoder.copyTextureToTexture({ texture: currentHeight }, { texture: nextHeight }, { width, height, depthOrArrayLayers: 1 });
      const reliefPass = encoder.beginRenderPass({
        label: `deposit relief layer ${strokeIndex + 1}`,
        colorAttachments: [{ view: nextHeight.createView(), loadOp: 'load', storeOp: 'store' }],
      });
      reliefPass.setPipeline(heightPipeline);
      reliefPass.setBindGroup(0, surfaceBindGroup(currentHeight, currentHeight));
      reliefPass.setVertexBuffer(0, stroke.vertex);
      reliefPass.setIndexBuffer(stroke.index, 'uint32');
      reliefPass.drawIndexed(stroke.indexCount);
      reliefPass.end();

      [currentColor, nextColor] = [nextColor, currentColor];
      [currentHeight, nextHeight] = [nextHeight, currentHeight];
    }
    colorTarget = currentColor;
    colorSpare = nextColor;
    heightTarget = currentHeight;
    heightSpare = nextHeight;
    device.queue.submit([encoder.finish()]);
    stats.surfacePasses += 2 + strokeGpu.length * 2;
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
      colorSpare.destroy();
      heightTarget.destroy();
      heightSpare.destroy();
      colorTarget = createTexture(width, height, 'retained pigment surface', colorFormat);
      colorSpare = createTexture(width, height, 'pigment deposition scratch', colorFormat);
      heightTarget = createTexture(width, height, 'retained sculptural relief', heightFormat);
      heightSpare = createTexture(width, height, 'relief deposition scratch', heightFormat);
      updateLightingBindGroup();
      renderSurface();
      updateLightingBindGroup();
      present();
    },
    async readHeight() {
      const rowBytes = width * 16;
      const bytesPerRow = Math.ceil(rowBytes / 256) * 256;
      const buffer = device.createBuffer({ label: 'relief readback', size: bytesPerRow * height, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
      const encoder = device.createCommandEncoder({ label: 'read retained relief' });
      encoder.copyTextureToBuffer({ texture: heightTarget }, { buffer, bytesPerRow, rowsPerImage: height }, { width, height, depthOrArrayLayers: 1 });
      device.queue.submit([encoder.finish()]);
      await buffer.mapAsync(GPUMapMode.READ);
      const packed = new DataView(buffer.getMappedRange());
      const out = new Float32Array(width * height);
      for (let y = 0; y < height; y += 1) {
        for (let x = 0; x < width; x += 1) {
          out[y * width + x] = packed.getFloat32(y * bytesPerRow + x * 16, true);
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
      colorSpare.destroy();
      heightTarget.destroy();
      heightSpare.destroy();
      context.unconfigure();
      device.destroy();
    },
    stats,
  };
}
