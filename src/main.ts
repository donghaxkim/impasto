import './style.css';
import { createRenderer } from './renderer';
import {
  createCloseupDocument,
  createDemoDocument,
  createDiagnosticDocument,
  createMaterialBenchmarkDocument,
  createMaterialStudyDocument,
} from './scene';
import type { PaintingDocument, RenderSettings } from './types';

const defaults: RenderSettings = {
  lightAzimuth: 315,
  lightElevation: 34,
  relief: 1,
  roughness: 0.48,
  exposure: 1,
  view: 'paint',
};

const app = document.querySelector<HTMLDivElement>('#app')!;
app.innerHTML = `
  <div class="shell">
    <header class="topbar">
      <a class="wordmark" href="#" aria-label="Impasto studio home">
        <span class="mark" aria-hidden="true"><i></i><i></i><i></i><i></i></span>
        <span>IMPASTO<span class="wordmark-dot">.</span></span>
      </a>
      <div class="topbar-center"><span class="eyebrow">MATERIAL STUDY</span><span class="topbar-divider"></span><span>Milestone 0 · Light &amp; relief</span></div>
      <div class="topbar-right"><span class="gpu-indicator" id="gpu-indicator"><i></i><span id="gpu-label">Preparing GPU</span></span><span class="version">WEBGPU</span></div>
    </header>

    <main class="workspace">
      <section class="stage-column" aria-label="Canvas viewport">
        <div class="stage-heading">
          <div><p class="kicker">STUDY 01 <span>—</span> PALETTE-KNIFE MATERIAL</p><h1>Paint, layered<br class="mobile-break"> up close.</h1></div>
          <div class="stage-heading-note"><span class="tiny-orb"></span><span>Relightable impasto<br>surface prototype</span></div>
        </div>

        <div class="viewport-shell" id="viewport-shell">
          <div class="viewport-topline"><span><span class="live-dot"></span>LIVE CANVAS</span><span>1000 × 800 px</span></div>
          <div class="canvas-wrap">
            <canvas id="paint-canvas" width="1000" height="800" aria-label="GPU rendered impasto painting"></canvas>
            <div class="canvas-message" id="canvas-message" role="status"><span class="loader"></span><span>Warming the paint surface…</span></div>
            <div class="light-hint" id="light-hint"><span class="sun-icon">✳</span><span>DRAG TO MOVE LIGHT</span></div>
          </div>
          <div class="viewport-bottomline"><span id="scene-caption">REFERENCE CROP · PALETTE-KNIFE DETAIL</span><span class="zoom-readout">1:1 <span>·</span> FIT</span></div>
        </div>
        <div class="stage-footnote"><span>01</span><span class="footnote-line"></span><span>Surface color and relief are rendered in separate passes.</span></div>
      </section>

      <aside class="inspector" aria-label="Material controls">
        <div class="inspector-head"><div><p class="kicker">INSPECTOR</p><h2>Material &amp; light</h2></div><button class="reset-button" id="reset-button" title="Restore default settings"><span>↺</span> Reset</button></div>

        <section class="control-section scene-section">
          <div class="section-label"><span>SCENE</span><span class="section-index">01</span></div>
          <div class="segmented scene-toggle" role="group" aria-label="Scene"><button data-scene="composition">Composition</button><button data-scene="diagnostics">Diagnostics</button><button data-scene="closeup">Close-up</button><button data-scene="materials">Paint studies</button><button class="selected" data-scene="benchmark">Reference crop</button></div>
          <p class="control-note" id="scene-note">A detailed close-up of overlapping palette-knife paint.</p>
        </section>

        <section class="control-section">
          <div class="section-label"><span>ILLUMINATION</span><span class="section-index">02</span></div>
          <label class="slider-control" for="azimuth"><span class="control-name">Light azimuth <output id="azimuth-value">315°</output></span><input id="azimuth" type="range" min="0" max="360" step="1" value="315"><span class="range-ends"><span>NORTH</span><span>ROTATE</span><span>360°</span></span></label>
          <label class="slider-control" for="elevation"><span class="control-name">Light elevation <output id="elevation-value">34°</output></span><input id="elevation" type="range" min="5" max="85" step="1" value="34"><span class="range-ends"><span>GRAZING</span><span>OVERHEAD</span></span></label>
        </section>

        <section class="control-section">
          <div class="section-label"><span>SURFACE</span><span class="section-index">03</span></div>
          <label class="slider-control" for="relief"><span class="control-name">Relief depth <output id="relief-value">1.00×</output></span><input id="relief" type="range" min="0" max="2.5" step="0.01" value="1"><span class="range-ends"><span>FLAT</span><span>RAISED</span></span></label>
          <label class="slider-control" for="roughness"><span class="control-name">Surface roughness <output id="roughness-value">0.48</output></span><input id="roughness" type="range" min="0" max="1" step="0.01" value="0.48"><span class="range-ends"><span>GLOSS</span><span>MATTE</span></span></label>
        </section>

        <section class="control-section view-section">
          <div class="section-label"><span>VIEW MODE</span><span class="section-index">04</span></div>
          <div class="view-grid" role="group" aria-label="View mode">
            <button class="view-option selected" data-view="paint"><span class="view-swatch swatch-paint"><i></i></span><span>Paint</span></button>
            <button class="view-option" data-view="color"><span class="view-swatch swatch-color"><i></i></span><span>Color</span></button>
            <button class="view-option" data-view="height"><span class="view-swatch swatch-height"><i></i></span><span>Height</span></button>
            <button class="view-option" data-view="normal"><span class="view-swatch swatch-normal"><i></i></span><span>Normal</span></button>
          </div>
        </section>

        <div class="inspector-bottom">
          <div class="stats-title"><span>RENDER PASS MONITOR</span><span class="stats-live"><i></i> LIVE</span></div>
          <div class="stats-grid"><div><span class="stat-value" id="surface-passes">—</span><span class="stat-label">SURFACE PASSES</span></div><div><span class="stat-value" id="lighting-passes">—</span><span class="stat-label">LIGHTING PASSES</span></div><div><span class="stat-value" id="stroke-count">—</span><span class="stat-label">STROKES</span></div></div>
          <p class="gpu-footnote">WebGPU · Linear height field · Screen-space lighting</p>
        </div>
      </aside>
    </main>
    <footer class="footer"><span>IMPasto Studio <span class="footer-separator">/</span> Rendering prototype</span><span>Built for close looking <span class="footer-spark">✳</span></span></footer>
  </div>
`;

const canvas = document.querySelector<HTMLCanvasElement>('#paint-canvas')!;
const message = document.querySelector<HTMLDivElement>('#canvas-message')!;
const gpuLabel = document.querySelector<HTMLSpanElement>('#gpu-label')!;
const gpuIndicator = document.querySelector<HTMLSpanElement>('#gpu-indicator')!;
let settings: RenderSettings = { ...defaults };
let currentDocument: PaintingDocument;
let renderer: Awaited<ReturnType<typeof createRenderer>> | undefined;
type SceneId = 'composition' | 'diagnostics' | 'closeup' | 'materials' | 'benchmark';
let activeScene: SceneId = 'benchmark';
let initGeneration = 0;
let initializationQueue: Promise<void> = Promise.resolve();

function setMessage(text: string, error = false) {
  message.classList.toggle('error', error);
  message.replaceChildren();
  const indicator = document.createElement('span');
  indicator.className = error ? 'error-symbol' : 'loader';
  if (error) indicator.textContent = '!';
  const label = document.createElement('span');
  label.textContent = text;
  message.append(indicator, label);
  message.classList.remove('hidden');
}

function showRuntimeFailure() {
  gpuIndicator.classList.add('failed');
  gpuLabel.textContent = 'Preview error';
  setMessage('The preview hit an unexpected error. Reload this page to try again.', true);
}

// Keep browser-level failures visible even when they happen after startup. The
// browser still reports the original exception in its console.
window.addEventListener('error', showRuntimeFailure);
window.addEventListener('unhandledrejection', showRuntimeFailure);

function syncStats() {
  if (!renderer) return;
  const stats = renderer.stats;
  document.querySelector('#surface-passes')!.textContent = String(stats.surfacePasses);
  document.querySelector('#lighting-passes')!.textContent = String(stats.lightingPasses);
  document.querySelector('#stroke-count')!.textContent = String(stats.strokeCount);
}

function update(partial: Partial<RenderSettings>) {
  settings = { ...settings, ...partial };
  renderer?.setSettings(partial);
  syncStats();
  document.querySelector('#azimuth-value')!.textContent = `${Math.round(settings.lightAzimuth)}°`;
  document.querySelector('#elevation-value')!.textContent = `${Math.round(settings.lightElevation)}°`;
  document.querySelector('#relief-value')!.textContent = `${settings.relief.toFixed(2)}×`;
  document.querySelector('#roughness-value')!.textContent = settings.roughness.toFixed(2);
  document.querySelectorAll<HTMLInputElement>('input[type="range"]').forEach((input) => {
    const progress = (Number(input.value) - Number(input.min)) / (Number(input.max) - Number(input.min)) * 100;
    input.style.setProperty('--range-progress', `${progress}%`);
  });
}

function setScene(scene: SceneId) {
  activeScene = scene;
  currentDocument = scene === 'composition'
    ? createDemoDocument()
    : scene === 'diagnostics' ? createDiagnosticDocument()
      : scene === 'materials' ? createMaterialStudyDocument()
        : scene === 'benchmark' ? createMaterialBenchmarkDocument() : createCloseupDocument();
  document.querySelector('#scene-caption')!.textContent = scene === 'composition'
    ? 'COMPOSITION · OIL ON LINEN'
    : scene === 'diagnostics' ? 'DIAGNOSTICS · MATERIAL FIELD'
      : scene === 'materials' ? 'PAINT STUDIES · KNIFE / SCUMBLE / MIX'
        : scene === 'benchmark' ? 'REFERENCE CROP · LOADED PAINT'
          : 'CLOSE-UP · IMPASTO CROSSING';
  document.querySelector('#scene-note')!.textContent = scene === 'composition'
    ? 'A small study in layered pigment and directional light.'
    : scene === 'diagnostics'
      ? 'Separate color and height patterns reveal the material inputs.'
      : scene === 'materials'
        ? 'Compare loaded knife faces, dry scumbling, and partially mixed color films.'
        : scene === 'benchmark'
          ? 'Opaque knife deposits, narrow pigment ribbons, and sparse scraped ground.'
          : 'Large overlapping marks reveal paint contact, bristles, and edge relief.';
  renderer?.dispose();
  renderer = undefined;
  if (navigator.gpu) {
    setMessage('Rebuilding the surface…');
    void initialize();
  }
  document.querySelectorAll<HTMLButtonElement>('[data-scene]').forEach((button) => button.classList.toggle('selected', button.dataset.scene === scene));
}

function initialize() {
  const generation = ++initGeneration;
  const run = async () => {
    if (generation !== initGeneration) return;
    try {
      const rendererPromise = createRenderer(canvas, currentDocument);
      let timedOut = false;
      let timeoutId: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<never>((_, reject) => {
        timeoutId = setTimeout(() => {
          timedOut = true;
          reject(new Error('WebGPU is taking too long to start. Reload, or open this preview in Chrome on a desktop computer.'));
        }, 15_000);
      });
      let nextRenderer: Awaited<ReturnType<typeof createRenderer>>;
      try {
        nextRenderer = await Promise.race([rendererPromise, timeout]);
      } finally {
        if (timeoutId !== undefined) clearTimeout(timeoutId);
        // A timed out creation cannot be cancelled; dispose its renderer if it
        // eventually completes so it does not leave GPU resources behind.
        if (timedOut) void rendererPromise.then((lateRenderer) => lateRenderer.dispose(), () => undefined);
      }
      if (generation !== initGeneration) {
        nextRenderer.dispose();
        return;
      }
      // The document texture is rendered during creation; setSettings presents once
      // using the current controls without rebuilding either surface pass.
      nextRenderer.setSettings(settings);
      renderer = nextRenderer;
      message.classList.add('hidden');
      gpuIndicator.classList.add('ready');
      gpuIndicator.classList.remove('failed');
      gpuLabel.textContent = 'WebGPU ready';
      syncStats();
      if (import.meta.env.DEV) {
        (window as Window & { __impasto?: unknown }).__impasto = {
          get renderer() { return renderer; }, get document() { return currentDocument; },
          setSettings: (next: Partial<RenderSettings>) => update(next),
          readHeight: () => nextRenderer.readHeight(),
        };
      }
    } catch (error) {
      if (generation !== initGeneration) return;
      gpuIndicator.classList.add('failed');
      gpuLabel.textContent = 'GPU unavailable';
      setMessage(error instanceof Error ? error.message : 'WebGPU could not initialize on this device.', true);
    }
  };
  initializationQueue = initializationQueue.then(run, run);
  return initializationQueue;
}

currentDocument = createMaterialBenchmarkDocument();
if (!('gpu' in navigator)) {
  gpuIndicator.classList.add('failed');
  gpuLabel.textContent = 'WebGPU unavailable';
  setMessage('This browser does not support WebGPU. Open the playground in a WebGPU capable browser to view the material.', true);
} else {
  void initialize();
}

document.querySelector<HTMLInputElement>('#azimuth')!.addEventListener('input', (event) => update({ lightAzimuth: Number((event.target as HTMLInputElement).value) }));
document.querySelector<HTMLInputElement>('#elevation')!.addEventListener('input', (event) => update({ lightElevation: Number((event.target as HTMLInputElement).value) }));
document.querySelector<HTMLInputElement>('#relief')!.addEventListener('input', (event) => update({ relief: Number((event.target as HTMLInputElement).value) }));
document.querySelector<HTMLInputElement>('#roughness')!.addEventListener('input', (event) => update({ roughness: Number((event.target as HTMLInputElement).value) }));
document.querySelectorAll<HTMLButtonElement>('[data-view]').forEach((button) => button.addEventListener('click', () => {
  const view = button.dataset.view as RenderSettings['view'];
  update({ view });
  document.querySelectorAll('[data-view]').forEach((option) => option.classList.toggle('selected', option === button));
}));
document.querySelectorAll<HTMLButtonElement>('[data-scene]').forEach((button) => button.addEventListener('click', () => setScene(button.dataset.scene as typeof activeScene)));
document.querySelector<HTMLButtonElement>('#reset-button')!.addEventListener('click', () => {
  settings = { ...defaults };
  for (const [id, value] of [['azimuth', defaults.lightAzimuth], ['elevation', defaults.lightElevation], ['relief', defaults.relief], ['roughness', defaults.roughness]] as const) {
    document.querySelector<HTMLInputElement>(`#${id}`)!.value = String(value);
  }
  document.querySelectorAll<HTMLButtonElement>('[data-view]').forEach((button) => button.classList.toggle('selected', button.dataset.view === defaults.view));
  update(settings);
});
document.querySelectorAll<HTMLInputElement>('input[type="range"]').forEach((input) => {
  const progress = (Number(input.value) - Number(input.min)) / (Number(input.max) - Number(input.min)) * 100;
  input.style.setProperty('--range-progress', `${progress}%`);
});

// Dragging across the image is a direct manipulation for azimuth and elevation.
let dragging = false;
canvas.addEventListener('pointerdown', (event) => { dragging = true; canvas.setPointerCapture(event.pointerId); moveLight(event); });
canvas.addEventListener('pointermove', (event) => { if (dragging) moveLight(event); });
canvas.addEventListener('pointerup', () => { dragging = false; });
canvas.addEventListener('pointercancel', () => { dragging = false; });
function moveLight(event: PointerEvent) {
  const bounds = canvas.getBoundingClientRect();
  const x = Math.max(0, Math.min(1, (event.clientX - bounds.left) / bounds.width));
  const y = Math.max(0, Math.min(1, (event.clientY - bounds.top) / bounds.height));
  const azimuthInput = document.querySelector<HTMLInputElement>('#azimuth')!;
  const elevationInput = document.querySelector<HTMLInputElement>('#elevation')!;
  const lightAzimuth = Math.round((1 - x) * 360) % 360;
  const lightElevation = Math.round(85 - y * 80);
  azimuthInput.value = String(lightAzimuth);
  elevationInput.value = String(lightElevation);
  update({ lightAzimuth, lightElevation });
}

