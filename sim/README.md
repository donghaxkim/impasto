# Impasto CPU simulation

A deterministic paint simulation in plain TypeScript, separate from the WebGPU prototype in `../src`. It needs Node 22 and has no dependencies. `tests/crop.py` also needs Python with Pillow.

```sh
npm run render   # writes PNGs to out/
npm run paint    # plans and paints tests/fixtures/lake.png (about 4 min at --width 360)
npm run paint -- photo.png --width 360 --plan-only   # just the stroke plan, in seconds
npm run paint -- --look oil   # the same, with the new semi-gloss look
npm run diagnose -- --fast    # three crops (mountains, spruce, lake): plan, colour, height, normals, render, metrics
npm run diagnose -- --fast --scene portrait --look oil   # other scenes in tests/scenes.json (flowers, building, portrait with eye, nose, beard and cheek crops; images in scenes/, not committed)
npm run diagnose -- --fast --look oil --forms 0 --streaks 0 --tone 0 --restraint 0 --presses 0 --scale 0 --shading 0 --bands 0 --press-restraint 0   # round 3's plan under the oil look
# also --defer 1 to paint thin lights last
python3 tests/diag-sheet.py out/diag && python3 tests/diag-compare.py out/diag out/diag-<name>
npm run gpu-parity            # WebGPU and WebGL2 viewer against the CPU reference, both looks (headless Chromium)
npm run gpu-parity -- --time  # also the frame time of each backend at 1200 x 900
npm run test:viewer           # browser tests for the live viewer: GPU parity, fallbacks, demo page (about 2.5 min)
```

The diagnostic reports, per crop: colour error and silhouettes kept at the plan, painted-colour and shaded stages; **expressiveness** (mean turn per stroke, share of curved strokes, width variation along strokes, variety of primitives); **relief hierarchy** (relief in structured against flat areas, sculptural peaks); and **physical realism** (share of paint in berms and heaps, groove index of fine ripple against form relief, bead index of glints breaking into specks, steep walls, and the volume ledger)); and **pigment** (colour gradient inside knife strokes against the photo's there, streak anisotropy as gradient across the stroke over gradient along it, and the share of the crop no knife stroke covers).

```sh
npm test         # physics, stroke primitives, planner and determinism checks
npm run viewer   # writes out/viewer-*.html for moving the light live (see Live viewer below)
python3 tests/crop.py   # JPEG previews and 1:1 crops
```

## Library API

`src/index.ts` (package `impasto-sim`) wraps the same pipeline as `npm run paint` (`src/pipeline.ts`) in a promise. It runs in browsers, workers and Node and imports no Node or DOM modules.

```ts
import { renderImpasto, ImpastoError } from 'impasto-sim';

const result = await renderImpasto(file, {        // ImageData, { width, height, data } RGB/RGBA bytes,
  preset: 'oil',                                  // or in a browser a Blob/File, ImageBitmap, <img>, <canvas>
  widthMm: 240,                                   // canvas width; detail and time both grow with it
  seed: 1,
  light: { azimuth: 225, elevation: 30 },
  onProgress: ({ stage, layer, layers, fraction }) => bar.value = fraction,
  signal: controller.signal,                      // checked between layers; rejects with an AbortError
});
ctx.putImageData(new ImageData(result.image.data, result.image.width), 0, 0); // RGBA, lit on the CPU

// Live light: WebGPU, else WebGL2, else the CPU image above (see "Live viewer").
import { createImpastoViewer, attachPointerLight } from 'impasto-sim/viewer';
const viewer = await createImpastoViewer(canvasEl, result.surface, { look: result.light.look, light: result.light, fallback: result.image });
attachPointerLight(viewer);
```

`impasto-sim/viewer` is a separate entry so pages that only render never load it. `encodeSurface` / `decodeSurface` (exported from `impasto-sim`) save and load a result's `surface` as an `.impasto` file (quantised version 2, about 6 bytes per cell; `{ version: 1 }` for lossless floats, see `.impasto` files). The viewer's declarations mention WebGPU types: a TypeScript website either has `skipLibCheck` on (Vite's templates do) or adds `@webgpu/types`.

- **Result:** `image` (RGBA `Uint8ClampedArray`, one pixel per 0.1 mm cell, lit at `light`), `surface` (`ImpastoSurface`, see `src/surface.ts`), `widthMm`, `heightMm`, `preset`, `seed`, `light` (as used), `strokes` (the count), `strokeList` (every stroke as plain data, below), `layerNames`, and `timings` in ms (`analyse`, `plan`, `paint`, `snapshot`, `relight`, `surface`, `total`).
- **Stroke list:** `result.strokeList` is `ImpastoStroke[]` in paint order, plain JSON (`JSON.stringify(result.strokeList)` is a downloadable stroke list). `strokesToJSON(plan)` converts a `planImpasto` plan the same way. Each stroke, in mm from the canvas's top-left corner (x right, y down), points rounded to 0.001 mm and colours and samples to 1e-4:

  ```ts
  interface ImpastoStroke {
    index: number; layer: number;            // paint order; layerNames[layer]
    tool: 'knife' | 'bristle';
    primitive: 'underpaint' | 'sweep' | 'plane' | 'mark' | 'scumble' | 'pat' | 'contour' | 'accent' | 'press';
    points: [number, number][];              // the blade centre's path; the last stretch is the lift-off tail
    widthMm: number; lengthMm: number;       // blade width, path length
    contact: number[];                       // 11 samples start to end: mark width there ≈ widthMm × contact
    pressure: number[];                      // hand pressure samples start to end
    color: [r, g, b]; secondary: [r, g, b]; secondaryFraction: number;   // sRGB 0-1
    colors?: [r, g, b][]; mix?: number;      // streaked loads: colours across the blade, 0 streaky - 1 blended
    thicknessMm: number; heap: number;       // paint left under the blade; terminal heap (0-1.5)
  }
  ```
- **Layer snapshots** (`onLayer`, for showing the painting come together): after each layer is painted, `onLayer(snapshot)` gets the canvas so far and that layer's strokes. Snapshots are computed only when `onLayer` is set, never change the painting (a test checks the image, surface and strokes are identical with and without it), and `planImpasto` takes none (it paints nothing).

  ```ts
  const result = await renderImpasto(file, {
    snapshot: { maxSide: 600 },     // default: longest side at most 600 cells; Infinity for full resolution (0.1 mm)
    onLayer: (s) => {               // s: LayerSnapshot
      showSurface(s.surface);                   // your page: relight it, e.g. with createImpastoViewer
      animateStrokes(s.strokes, s.surface.dx);  // your page: s.strokes in paint order; mm / dx = snapshot cells
      label.textContent = `${s.layer + 1}/${s.layers} ${s.name}`;
    },
  });
  ```

  ```ts
  interface LayerSnapshot {
    layer: number; layers: number; name: string;  // underpaint, block-in, masses, presses, forms, detail, contours, accents
    deferred: boolean;    // true only for one extra snapshot after PlanSettings.deferThin's held-back lights (off by default)
    fraction: number;     // progress at the end of this layer (onProgress's scale)
    strokes: ImpastoStroke[];
    surface: ImpastoSurface;  // the canvas after this layer, at most maxSide cells a side; fresh buffers each time
    scale: number;            // full-size cells per snapshot cell (1 at full size)
    widthMm: number; heightMm: number; planMs: number; paintMs: number;
  }
  ```

  The surface is shrunk by the smallest whole factor that fits `maxSide`: colour (linear albedo, roughness) and both height channels are box-averaged over each block (partial blocks on the right and bottom edges), `dx` grows by the factor so slopes and shadows keep their scale, and `maxH` is recomputed. At full size it is exactly `surfaceFromCanvas`, so the last snapshot equals `result.surface` (without `deferThin`). `downsampleSurface(surface, maxSide)` does the same to any surface, for example the final one to match the snapshots. Cost: the full canvas's height, shadow and colour fields once per layer, measured at 2.5-4% of the render on a 30 mm test canvas and about 3% at 120 mm (150 ms a snapshot at 1.1 M cells, mostly the full-size shadow-height filter), and about 0.4 s a snapshot at 4.3 M cells (240 x 180 mm), against several seconds to a minute of painting per layer. If `onLayer` throws, the error goes to `globalThis.reportError` (a browser's uncaught-error reporting; `console.error` where there is none) and the render carries on.
- **Presets** (`src/presets.ts`), each a few overrides on `DEFAULT_SETTINGS` and `DEFAULT_LIGHT`, so planner defaults flow through:
  - `'oil'` (default): the planner's `oil` look with all its defaults, semi-gloss renderer.
  - `'locked'`: the round-3 reference look, identical to `npm run paint -- --look locked` (a test pins it).
  - `'smooth'`: `oil` with more restraint, single-colour (unstreaked) loads, thinner knife paint (except the presses layer, which the planner adds with its own thickness), lights laid less thick, fewer detail and accent marks, slightly less saturation, a higher lamp, shallower shadows, less shading relief and glow.
- `options.advanced` takes raw `PlanSettings` over the preset. It is unstable: names and meanings change without notice.
- **Size and time:** the canvas is simulated at 0.1 mm, so time and memory grow with its area: the 1440 x 692 lake photo at the default 240 mm width (240 x 115 mm, 1487 strokes) took 1 min 45 s of CPU (4 min wall on a busy 2-core machine) and 0.8 GB peak; 360 x 240 mm is about three times the area. `widthMm` is clamped to 20 mm and to a longest side of 480 mm (`canvasWidthMm` gives the width that will be used). Images up to 50 megapixels and 8:1 are accepted; pixels beyond the canvas's 0.5 mm analysis grid add nothing, so downscale large photos first.
- **Errors:** bad input rejects with `ImpastoError` and a `code`: `UNSUPPORTED_SOURCE`, `EMPTY_IMAGE`, `BAD_DATA`, `BAD_ASPECT`, `IMAGE_TOO_LARGE`, `DECODE_FAILED`, `BAD_OPTION`, and from the worker helpers `WORKER_FAILED` (the worker failed to load or crashed). Alpha is composited over white.
- `planImpasto(image, options)` returns just the stroke plan in seconds (planned without the simulation, so it differs from what `renderImpasto` paints).
- **Off the main thread:** between layers the render yields to the event loop, but each layer is seconds to a minute of synchronous work, so on a page use the worker:

  ```ts
  import ImpastoWorker from 'impasto-sim/worker?worker';   // Vite syntax
  import { renderInWorker } from 'impasto-sim';
  const worker = new ImpastoWorker();
  const result = await renderInWorker(worker, file, { preset: 'oil', onProgress, signal });
  ```

  Same options and result; progress, abort and `onLayer` are forwarded, and the result and snapshot buffers are transferred. `<img>` and canvas sources are read on the page first; Blobs and ImageBitmaps are decoded in the worker.

  ```ts
  const result = await renderInWorker(worker, file, {
    preset: 'oil', signal, onProgress,
    snapshot: { maxSide: 600 },
    onLayer: (s) => showLayer(s),   // runs on the page; s.surface's Float32Arrays were transferred, not copied
  });
  ```

  With `onLayer` set, the page's request carries `layers: true` and the worker posts a `{ type: 'layer', id, snapshot }` message after each layer, before the next `progress`, transferring `snapshot.surface.height` and `.color`. The protocol stays compatible both ways: an older worker ignores `layers` (no snapshots arrive, the render still works), and an older page ignores `layer` messages. A throwing `onLayer` on the page is reported as above and the render carries on; aborting (even from inside `onLayer`) works as before.

### Using it from the website

With the website and this repo side by side (`website/`, `impasto/`):

1. Once, in `impasto/sim`: `npm install`. That installs TypeScript and builds `dist/` (the `prepare` script).
2. In the website's `package.json`: `"impasto-sim": "file:../impasto/sim"`, then `npm install`. npm (10.x, checked) links the folder (a symlink, so `files` does not apply) and runs its `prepare` script on every `npm install` in the website, even when everything is up to date, which rebuilds `dist/` (about 10 s). It does not install `impasto/sim`'s devDependencies, so TypeScript comes from step 1; if that was skipped and there is no `dist/` yet, the install stops with a message saying to run it.
3. After changing the simulation, run `npm run build` in `impasto/sim` (or `npm install` in the website); a running Vite dev server does not rebuild it. Or, for development, let Vite read the TypeScript sources directly through the package's `source` export condition (no build step, and edits hot-reload):

   ```ts
   // website/vite.config.ts
   import { defineConfig, defaultClientConditions } from 'vite';
   export default defineConfig({ resolve: { conditions: ['source', ...defaultClientConditions] } });
   ```

Types ship as `.d.ts` in `dist/` and need TypeScript 5.7 or newer (`Uint8ClampedArray<ArrayBuffer>`). `npm run typecheck` checks the library sources; `npm run test:api` runs the API tests alone.

## How it works

Pipeline: image → `image.ts` analysis → `planner.ts` ordered stroke plan → `execute.ts` runs it through `tool.ts`/`canvas.ts` → `relight.ts`.

- `src/image.ts`: resamples the photo onto a millimetre grid, OKLab colour, blurs, and an edge-following direction field from the colour structure tensor (no angles, so no trig).
- `src/structure.ts`: the painting representation: detail, coherence, silhouettes, flatness and target relief maps.
- `src/planner.ts`: the image-to-strokes planner (below).
- `src/execute.ts`: wipes, loads and drags each planned knife, and reads the canvas colour back for the planner.

- `src/tool.ts`: tool nodes, plowing, wet exchange, stiction and the terminal heap.
- `src/canvas.ts`: canvas weave, two paint layers per cell, mass-conserving moves and slumping.
- `src/relight.ts`: the reference renderer, with GGX clearcoat, ray-marched shadows and horizon occlusion; `relight(canvas)`, or `relightSurface(surface)` for a packed or decoded surface.
- `src/relight-gpu.ts`: WebGPU port of the renderer.
- `src/relight-gl.ts`: WebGL2 (GLSL ES 3.00) port of the WebGPU shader, for browsers without WebGPU.
- `src/surface.ts`: `ImpastoSurface`, the packed height and colour buffers a renderer needs, and the `.impasto` file format.
- `src/snapshot.ts`: per-layer snapshots for the library's `onLayer` (box-downsampled surfaces) and strokes as plain JSON (`ImpastoStroke`).
- `src/viewer.ts`: the browser viewer (live WebGPU or WebGL2 relighting with a static fallback); `src/viewer-bundle.ts` inlines it into pages.
- `src/dmath.ts`: math that gives the same result on any JS engine. Paint code must not call `Math.sin`, `Math.pow`, `Math.exp` or `Math.random`.
- `src/pigment.ts`: colour conversion. Node and cell RGB are stored as Kubelka-Munk K/S, so mixing behaves more like pigment.

## Live viewer

`src/viewer.ts` is a browser-only module, no dependencies, that relights a painted surface live. Nothing in the paint path imports it, so the simulation runs the same with no GPU.

```ts
import { createImpastoViewer, attachPointerLight } from 'impasto-sim/viewer';   // or './viewer.ts' inside this repo
const viewer = await createImpastoViewer(canvasEl, surface /* ImpastoSurface */, {
  light: { azimuth: 225, elevation: 30 },   // Partial<LightSettings>; defaults to DEFAULT_LIGHT
  look: 'oil', view: 'paint',
  fallback: { width, height, data },        // RGBA or RGB bytes, e.g. relight(canvas, DEFAULT_LIGHT)
  onFallback: (reason) => console.warn(reason),
  backends: ['webgpu', 'webgl2', 'static'], // the default order; ['webgl2'] forces WebGL2 (then static)
});
viewer.mode;                 // 'webgpu' | 'webgl2' | 'static'; fallbackReason says why it is static
viewer.skipped;              // why earlier backends were passed over, e.g. ['webgpu: no WebGPU adapter ...']
viewer.setLight({ azimuth: 45 }); viewer.setLook('locked'); viewer.setView('height'); // redraw on the next frame
viewer.render();             // draw now
await viewer.readPixels();   // RGBA, canvas width x height (tests)
const detach = attachPointerLight(viewer, undefined, { mapping: 'linear', onChange: (l) => {} });
viewer.destroy();
```

- **WebGPU path:** the surface's buffers go up as an `rg32float` height texture and an `rgba32float` colour texture, and `RELIGHT_WGSL` runs its two passes (HDR `fs`, then `composite` with the glow) on every change, at one canvas pixel per cell (scale with CSS). `npm run gpu-parity` and `npm run test:viewer` check it against the CPU `relight()`: mean difference about 0.5 of an 8-bit level for both looks, a low side light with more relief, and the colour view.
- **WebGL2 path** (`src/relight-gl.ts`), for browsers without WebGPU (older Safari and Firefox, many Linux and some Windows setups): the same two passes in GLSL ES 3.00, fed the same `relightUniforms()` block (as `uniform vec4 P[6]`), so both looks and every view (paint, colour, height, normals, highlights, cavities, glow) match. Height and colour go up as `RG32F` and `RGBA32F` textures read only with `texelFetch`, so no float-filtering extension is needed. The HDR target is `RGBA32F` with `EXT_color_buffer_float`, else `RGBA16F` (with that or `EXT_color_buffer_half_float`; specular is capped at 60000, far above where the composite saturates); with neither, WebGL2 is skipped. Shaders compile in the background where `KHR_parallel_shader_compile` exists. `readPixels()` renders the composite into an offscreen `RGBA8` target and returns it top-down. Parity against the CPU `relight()` (`npm run gpu-parity`, also in `test:viewer`): mean difference 0.503 levels for `locked`, 0.503 for `oil`, 0.500 for the low side light with relief 1.6, 0.474 for the colour view (0.467 with the half-float target, the paint cases unchanged to three decimals), and at most 0.57 for the other views (`oil`: height 0.495, highlights 0.565, cavities 0.126, glow 0.003, normals 0.000): the same as WebGPU.
- **Backends:** `backends` (default `['webgpu', 'webgl2', 'static']`) is the order to try; the first that sets up is used. 'static' always ends the list, so `['webgl2']` forces WebGL2 and still never fails to draw; `forceStatic: true` is `['static']`. `viewer.skipped` lists why each earlier backend was passed over (a page in 'webgl2' mode can say why WebGPU was not used). If WebGPU took the canvas and then failed, WebGL2 gets a fresh twin canvas (`viewer.canvas` follows), since a canvas holds one kind of context for life.
- **Software GL:** by default the viewer refuses a WebGL2 context on a software rasteriser (SwiftShader, llvmpipe: `failIfMajorPerformanceCaveat`, then the renderer string), because it is slower than the static fallback: in headless Chromium here, SwiftShader WebGL2 took 3.4-6.3 s per frame at 1200 x 900 against 0.09 s for the static approximation. `webgl: { software: true }` accepts one (the tests, and the demo page when WebGL2 is picked by hand).
- **Fallback:** the viewer goes to `mode: 'static'` when no live backend sets up: for WebGPU, `navigator.gpu` is missing, `requestAdapter()` gives null or throws, the surface is larger than the GPU's texture limit, or device creation or pipeline setup fails; for WebGL2, there is no context, it is software, the surface exceeds `MAX_TEXTURE_SIZE` or `MAX_VIEWPORT_DIMS` (or the browser shrinks the drawing buffer), no float target is renderable, a shader fails to compile, or setup raises a GL error such as `OUT_OF_MEMORY`. It also goes static if a live backend is later lost: a lost WebGPU device, or a `webglcontextlost` event (not cancelled, so the browser does not restore it; `render()` and `readPixels()` also notice a lost context before the event arrives). It never throws for these; it calls `onFallback(reason)` once and fires a `modechange` event (`onFallback` is for static mode only; a viewer that settles on WebGL2 lists the WebGPU reason in `skipped`). A canvas that has had a WebGPU or WebGL context cannot give a 2D one, so after a loss the viewer swaps an identical fresh `<canvas>` into the DOM (`viewer.canvas` follows; `attachPointerLight` without an element follows too).
- **Static drawing:** with a `fallback` image, the 'paint' view shows it as is (`interactive` is false: the light controls cannot change it); other views use the approximation. Without one, the viewer shades the height field itself: wrapped Lambert key, soft fill and a Blinn-Phong coat from the stored roughness. No shadows, occlusion or glow, so it is flatter than the reference, but the light still moves it (about 0.2 s per frame at 1200 x 900).
- **Pointer drag:** `mapping: 'linear'` (default, as Milestone 0): horizontal position sets azimuth (left 360°, right 0°), vertical sets elevation (top 85°, bottom 5°). `'radial'`: the light comes from where you point, seen from the centre; the centre is overhead, the edge grazing.

### `.impasto` files

`encodeSurface(s, opts?)` / `decodeSurface(bytes)` in `surface.ts`, so a site can ship prerendered paintings. `encodeSurface` writes version 2 (quantised) unless given `{ version: 1 }` (lossless); `decodeSurface` reads both and throws a clear error on a wrong magic, gzip data, an unknown version or flag, a truncated or oversized file, or corrupt header ranges. The same surface always gives the same bytes, and decoding gives the same floats on every engine (plain arithmetic and table lookups, no `Math.pow`).

All versions are little-endian and share the first 48 bytes: 8-byte magic `IMPASTO\x1a`, u32 version, u32 header size (data starts there, so a version can grow its header), u32 w, u32 h, u32 flags, u32 reserved, f64 dx, f64 maxH.

**Version 2** (default), 6 bytes per cell: header size 96, then f64 ranges at byte 48: visible height min, max (mm); occlusion min, max (0, 0 unless stored); roughness min, max. Then planes of w·h values, row-major:

| plane | encoding |
| --- | --- |
| visible height | u16, `round((v - min) / (max - min) · 65535)`: the w·h low bytes, then the w·h high bytes |
| occlusion height | only when flag bit 0 is set; u16 as above. Otherwise the decoder rebuilds it from the visible height with `occlusionFilter` (`relight.ts`), which is how `surfaceFromCanvas` makes it |
| albedo r, g, b | u8 each: the sRGB transfer of the linear value (clamped to 0..1), to the nearest code; decoded through a 256-entry `srgbToLinear` table |
| roughness | u8, `round((v - min) / (max - min) · 255)` |

Every plane is stored with PNG's Sub filter (within a row, each value minus its left neighbour, modulo 2^16 for heights, before the byte split, or 2^8; the first value of a row as is), which roughly halves the gzipped size. The encoder checks whether the surface's occlusion channel is what the decoder would rebuild (within 1/2^20 of the height range); if not, it sets flag bit 0 and stores it (8 bytes per cell).

Measured on the lake painted at 120 mm (1200 x 577 cells): height error at most half a step (5e-5 mm over a 6.4 mm range), rebuilt occlusion within 2.3e-5 mm. Relit with `relightSurface` against the lossless surface, the mean difference is 0.21 of an 8-bit level at the default light and 0.18 at a 10° grazing light (both looks), almost all from the 8-bit albedo; the maximum (up to about 100 levels) is a handful of pinpoint crest glints, 0.001% of channels, whose very narrow lobes flip with a sub-micron height change. Roughness at 8 bits adds under 0.001 of a level. The colour view differs by 0.5 on average because `relight` writes `x · 255 + 0.5` into a clamped array, and decoded albedo sits exactly on its rounding ties; it is never off by more than 1.

**Version 1** (legacy, lossless), 24 bytes per cell: header size 48, flags 0, then `height` (w·h·2 f32) and `color` (w·h·4 f32), bit-exact. `npm run gpu-parity` and `test:viewer` use it so they compare renderers, not the file format.

| canvas at 0.1 mm | cells | v1 | v1 gzip | v2 | v2 gzip | v2 brotli |
| --- | --- | --- | --- | --- | --- | --- |
| lake, 120 x 58 mm (measured) | 0.69 M | 16.6 MB | 14.3 MB | 4.2 MB | 1.9 MB | 1.7 MB |
| 120 x 90 mm | 1.08 M | 26 MB | about 22 MB | 6.5 MB | about 3.0 MB | about 2.7 MB |
| 360 x 270 mm | 9.72 M | 233 MB | about 200 MB | 58 MB | about 27 MB | about 24 MB |

The compressed sizes for 120 x 90 and 360 x 270 scale the lake's per cell (v2: 2.7 bytes gzip -9, 2.8 at the default level, 2.5 brotli); busier paintings compress less. The demo pages open `.impasto.gz` (`gzip -k out/lake.impasto`); a server can also send `.impasto` with `Content-Encoding: gzip` or `br`.

### Demo pages

```sh
npm run viewer                                  # out/viewer-one-stroke.html, viewer-patch.html, and an empty viewer.html
npm run paint -- --width 240 --export-surface   # also writes out/<name>.impasto
npm run viewer -- out/lake.impasto              # out/viewer-lake.html, with out/lake-paint.png as its static fallback
```

Each page is self-contained (open it from disk): it inlines `viewer.ts` and its imports through an import map of `data:` URLs (`src/viewer-bundle.ts` strips the types with Node's own `stripTypeScriptTypes`, so no bundler is needed), and has sliders for azimuth, elevation, relief, glow and exposure, a light dial, look, view and drag-mapping menus, a Renderer menu (Auto, WebGPU, WebGL2, Static fallback; `?backend=webgl2`, `webgpu` or `static` in the URL does the same, so `viewer-lake.html?backend=webgl2` opens on WebGL2), a badge showing live WebGPU, live WebGL2 or static mode with the reason (and, when live on WebGL2, why WebGPU was not used), and a button to open an `.impasto` or `.impasto.gz` file. Scene pages carry a CPU render at the default light as their fallback. Pages open on the 'locked' look; for a painting made with `--look oil`, pick Oil (its `-paint.png` fallback is already in that look).

GPU memory is about 40 bytes per cell (two float textures plus the HDR target; 32 with a half-float HDR target in WebGL2, plus 4 for `readPixels`): about 43 MB at 1200 x 900, about 390 MB at 3600 x 2700, which some integrated or mobile GPUs may refuse; that ends in the static fallback.

Headless Chromium here exposes WebGPU through SwiftShader. Presenting to an on-screen WebGPU canvas needs `--use-angle=swiftshader --enable-unsafe-swiftshader` as well; without them Chromium loses the device on the first frame, which `test:viewer` uses as a real device-loss case. WebGL2 runs through ANGLE on SwiftShader with any of these flags (even `--disable-gpu`), with `EXT_color_buffer_float`, `EXT_color_buffer_half_float` and `WEBGL_lose_context`; the half-float path is tested by hiding `EXT_color_buffer_float` (`webgl.hideExtensions`), context loss with `WEBGL_lose_context`.

Frame times at 1200 x 900 (`npm run gpu-parity -- --time`: the parity scene tiled 3 x 3, median of three light changes, each drawn and waited for), on SwiftShader, a CPU rasteriser on a 2-core machine shared with other jobs (load 2.6-2.9), so they say nothing about real GPUs, which are expected to be far faster: WebGL2 3.4-6.3 s per frame over two runs (setup about 9.5 s, mostly the shader compile on SwiftShader), WebGPU 20-32 s, the static approximation 0.09 s.

## Modelling choices

- A saturated plow bead folds its excess back into the node's load instead of growing without limit.
- Paint left on the tool when it lifts stays on the tool and counts in the mass ledger.
- `pressMm` on a stroke pushes the tool below the surface it rides on, for scraping through wet paint.
- Knife faces: chatter and edge flaws are masked to the sides, tail and thinning load. Cell height comes from each cell's own centre under the tool, and a final pass relaxes the body under the visible layer, which leaves colour alone.
- Colour: nodes draw from a position carried by a noise-driven lateral flow, in the spirit of curl noise. Only 1D lateral motion across the tool is modelled. Volume always leaves the local node; colour is traded with the source node, so totals balance.
- Clearcoat: flat faces keep the stored roughness of 0.06-0.16. Where slope changes quickly it falls to 0.03-0.08 across four jittered micro-facets per pixel, which break crest highlights into points. A small filter stops narrow lobes vanishing between pixels. A trace broad lobe at roughness 0.30 keeps a little body sheen.
- Contact shadows: shadow and occlusion queries use a slightly filtered height, with a wider penumbra and a partly lit first millimetre. A wrapped lamp and a soft bounce from the opposite side keep open back-facing lips coloured.
- Cavities: the renderer separates contours from crevices. Opposing rises on the unfiltered height measure enclosure, and a tall nearby rise counts as an overlapping lip. Inside that term, bounce, fill and interreflection drop, and colour deepens, with a small floor so cavities stay coloured. Shallow one-sided contours are unaffected. The `cavity` view shows the term.
- Wet contacts: where a stroke meets existing paint, the step relaxes into a short fillet and pigment bleeds in irregular fingers. Mass and pigment are conserved. Edges on bare canvas stay steep. All paint is treated as wet, because the simulation has no drying yet.
- Heaps: the upper part of each terminal heap is recut into tilted planes that join at sharp creases. Their flanks stay smooth.
- Highlights: specular is kept unclipped until the end. A second, softer window catches ridges at other angles, and convex wet crests above a recess get a boost of up to 3.5x. Dry drag and bare canvas stay matte.
- Glow: a display effect, not a paint property. Only light above display white spreads, over 0.7 mm at most, and `glow: 0` turns it off. The kernel uses plain arithmetic so it stays deterministic.

## Stroke shapes

`StrokeSpec` options, all off by default so existing strokes are unchanged:

- `engage`: share of the blade in contact, for a narrower mark from the same knife.
- `taper` / `taperMin`: contact narrows toward the head and tail; a tapered tip sheds no heap.
- `breaks`: the blade rides up in ragged patches that vary across and along the stroke.
- `heap`: terminal heap size (0 lifts cleanly and keeps the bead on the knife; up to 1.5).
- `edgeFlaws`: strength of the knife's edge profile, which prints as parallel grooves.
- `pressure`: hand pressure samples from start to end. Below 1 only part of the blade touches, so pressure also sets the mark's width: `[0.2, 1, 1, 1, 0.2]` is a comma, narrow at both ends.
- `attackDeg`, `speed`: blade angle to the canvas (30 by default) and relative speed.
- `deposition`: `'locked'` (default) or `'physical'`.

### Physical deposition

With `deposition: 'physical'`, berms and the terminal heap follow what the hand does instead of fixed rates. Volume and pigment stay conserved (the tests check the ledger to 1e-9):

- Only blade in contact squeezes paint into the bead, and harder pressure squeezes faster.
- Sideways squeeze-out, which feeds the berms, grows with pressure and as the blade lies flatter, and shrinks for a quick pass.
- Light pressure floats the blade on the paint (a thicker film); hard pressure sinks it in and plows.
- On a curve the bead is thrown to the outside of the turn, so the berm builds there.
- Pressure at the lift decides how much of the bead and load drops as the heap; a light lift keeps it on the blade.
- Load still matters most: a heavily loaded stroke builds large berms and a heap whatever the hand does.

Below 24 mm (`FULL_LIFT_LENGTH`) a stroke's touch-down, lift-off, contact length and heap scale with its length, so a 3-5 mm mark lays paint instead of a blob. Longer strokes are exactly as before.

## Looks

`LightSettings.look` (and `PlanSettings.look`): `'locked'` (default) is the reference look, pixel-identical to before, kept for regression comparison. `'oil'` is the intended replacement and also switches the planner's strokes to physical deposition; it becomes the default only once it is consistently better across several scenes. `'oil'` is semi-gloss: rougher coat, highlights filtered by how fast the normal turns within a pixel (Kaplanyan's geometric specular anti-aliasing) so crests carry continuous sheens instead of beads, weaker crest boost and second highlight window, gentler cavities, and a weaker knife edge profile on broad strokes. The WebGPU and WebGL2 ports take the same parameters (`relightUniforms`); `npm run gpu-parity` checks both looks on both.

## Stroke planner

Research behind it: `docs/prior-art-research.md`.

- **Layers, coarse to fine** (Hertzmann 1998): a thin bristle underpainting, then knives of 15, 9.5, 6 and 3.6 mm, a 3.6 mm contour layer and 2.4 mm accents. Each layer compares a reference blurred to its scale with what is already on the canvas and only paints where the difference is large.
- **Feedback:** with `npm run paint`, each layer is painted by the simulation before the next is planned, so later layers correct what the paint really did (berms, heaps, pickup), not what the planner assumed.
- **Forms** (`forms.ts`): the image is split into a hierarchy of shapes, independent of subject. First Felzenszwalb–Huttenlocher superpixels, then Ward agglomerative merging (the pair whose union adds the least colour variance merges first). Snapshots are taken at about canvas area / d² shapes for d = 80, 35 and 15 mm. Each shape records its colour, principal axis, elongation, a figure-against-ground score, and per cell the distance to its edge and the edge's direction. `npm run forms -- --scene lake` writes `out/forms-<scene>.png`.
- **Shapes bind strokes at their own scale:** block-in uses the coarse shapes, masses and forms the middle ones, and detail and accents the fine ones.
  - For each layer, neighbours closer in colour than the layer's tolerance are merged, and shapes smaller than 1.5 square blade widths are absorbed. Parts narrower than 0.6 blade widths (lake between branches, a branch against the lake) are freed: they bind no stroke.
  - A stroke stays in its shape's core, and its blade may reach at most a fifth of its width into a neighbour's.
  - Seeds go only where the blade fits. A shape too narrow for a blade is left to a finer one, and a stroke that meets its shape's edge may be a single short press.
  - The finest layers also seed in freed narrow parts (mullions, stems), narrowing their marks to fit.
  - So the broad knives block in masses without eating smaller shapes, and each scale refines the one before it.
- **Strokes per shape** (`oil`):
  - *Presses:* after the masses, a layer of shape-sized presses. In each shape, the planner takes its thickest uncovered point and picks the widest of five knives (0.42 to 1.9 times the masses knife) that spans the shape there with both edges still on its colour. It lays one straight, loaded press along the shape, at most 2.2 of its own widths long, then moves to the next thickest point. A petal or a facet becomes one or two bold presses rather than five narrow passes. Thin shapes (a mullion, a stem) count as edges for presses.
  - *Short, wide strokes:* in the form-bound layers, strokes are at most 3.2 blade widths long, so surfaces are built from planes rather than long ribbons.
  - *Restraint* (0.5): the form-bound layers discount their error more than two blade widths inside a shape, so broad planes stay broad and detail gathers at edges.
  - *How forms turn in the light* (`shading`, `image.ts shadingField`): on smooth forms the colour structure tensor is weak or noisy (skin pores, fine wrinkles), so strokes used to comb along arbitrary iso-lines. Lightness (OKLab L) blurred to half a blade (at least 4 mm) gives the turn of the form; its iso-luminance contours are the direction a knife painter lays planes, across the turn, so each plane keeps one value and the next steps down the turn. The cue's weight is the coherence of the blurred gradient, times its smoothness (the share of fine lightness-gradient energy that survives the blur: about 1 on a clean turn, near 0 on hair, foliage or water ripple), times its significance (gradient above 0.004 L per mm). It joins the direction blend below with weight `shading` x cue, less where colour edges are coherent. Where the cue is strong a stroke is also stiffer (its turn limit falls to 30%), so it lays a straight plane rather than a curving ribbon.
  - *Value bands* (`valueBands`): where the cue is strong, and only in shapes whose own lightness spans at least one band (15th to 85th percentile; blurred lightness bleeds across a flat shape's silhouette and would otherwise read as a turn), the press layer splits each shape into bands of form-scale lightness `valueBands` apart (centred on the shape's mean; bands smaller than the smallest press join a neighbour, `forms.ts splitRegions`). Each band gets its own presses, laid along it, so a nose bridge becomes a lit front plane and a darker side plane, and a cheek steps down in a few planes. On those smooth bands a press judges its fit against the image blurred to its own width, so skin texture finer than the knife no longer forces the smallest knife; it still stops at a difference 2.5 tolerances strong in the unblurred image (a mullion, a hair). A shape with at least 10% of its cells on a strong cue (a face, not a lake or a facade) is pressed as planes: it gets enough presses to cover it (one try per square smallest-knife width, at least 32, where other shapes keep 32), and a later press in it is at least half as wide as the widest already there, so the slivers between planes go to the forms layer instead of a mosaic of small presses. Presses on a band are laid full and lifted lightly, so the bead stays on the knife and the facet ends in a clean edge rather than a heap.
  - *Press restraint* (`pressRestraint`): after the presses, the form-bound layers discount their error inside a press of a shape pressed as planes (above) by `pressRestraint` x how well the press matches the image there (at its own scale) x how deep inside the press the cell lies (none at its edges), and count that share of the cell as covered when deciding whether a stroke mostly overlaps others. Broad planes stay clean; detail gathers at their edges. Small features are exempt. Applied to every press, it cost edges on the lake (edges kept in the painted colour 0.70 against 0.75 without it), so it is limited to planes of smooth forms.
  - Defaults under `oil`: `shading` 3, `valueBands` 0.09, `pressRestraint` 0.8. `npm run diagnose -- --shading 0 --bands 0 --press-restraint 0` gives round 4's plan.
  - *Small features* (`forms.ts`): superpixels up to 5 mm across whose colour stands at least 0.12 OKLab off their neighbours (the white of an eye, a catchlight, a fleck) are exempt from restraint. Each gets its own mark in the finest layer, as wide as itself and in its own colour.
- **Knife size from the image** (`oil`, `autoScale`): knives are scaled by how much of the canvas has structure at painting scale (detail above 0.45). The factor is (0.6 / share)², from 1 to 2.2: about 1.8 for the portrait and flowers, 1.16 for the building, 1 for the lake. The scaling is graded by knife size. The masses knife and wider take all of it, the finest knives keep their size, so a close-up gets broad planes and still has a small knife for an eye.
- **Deferring thin lights** (`deferThin`, off): this paints thin marks lighter than their surroundings after every layer. Tested on the glass facade, it made the mullions worse (0.53 against 0.67 of the edges kept in the painted colour). The blades are wider than a mullion, so it is the darks painted after a light line that cut it to width, and a light laid last over wet dark paint picks some of it up.
- **`locked` is the round-3 plan:** with the `locked` look the planner ignores shapes, presses, scaling, restraint, streaks and toning, and a test pins its plan to the round-3 digest.
- **Form-aware direction:** inside a shape, the direction blends:
  - image edges, weighted by their coherence;
  - the shape's principal axis, weighted by its elongation;
  - near its edge, the edge itself;
  - with `shading`, how the form turns in the light (above), strongest on smooth forms whose colour edges are weak.
- **Direction:** strokes are traced both ways along the direction field. A fine field (edges) and a field three times wider (forms) are merged by coherence, so a tree is painted along its silhouette, not along each branch. Flat areas fall back to horizontal.
- **Where small strokes go:** a layer's error is discounted where the image has little structure at its scale (after Im2Oil), so the sky and lake stay in broad strokes.
- **Painting representation** (`structure.ts`): detail, coherence, silhouettes (strong, coherent, large-scale edges such as ridgelines, trunks and shores), flatness and a target relief map. The planner reads these, never what the subject is.
- **Silhouette protection:** where a silhouette runs under a broad blade, each blade edge must match on its own and the tolerance tightens, so a broad stroke never straddles a ridgeline or a trunk.
- **Contour layer:** narrow strokes along silhouettes, centred half a blade to one side so the blade's edge lies on the silhouette (cutting in). The more uniform side is painted.
- **Stroke paths:** a seed reads the maps around it. Flat areas take broad curved sweeps on the form field, fine coherent structure takes long organic marks on the fine edge field, texture takes short strokes, and the rest stiff planes. No stroke turns tighter than 2.5 blade widths (a knife cannot), and each has a total turn limit.
- **The hand:** each primitive sets a pressure profile, blade angle, speed and how much paint to pick up (which follows the target relief). Marks and scumbles scale their pressure by the measured width of the feature under each point, so a mark is wide where the form is wide and narrow at a tip.
- **Primitives:** each stroke picks one from the maps under it, plus `pat` (a short, heavy press-and-lift for high-relief texture): `sweep` (flat areas: thin, pressed, almost no heap), `plane` (square ends, relief following the area), `mark` (fine coherent structure: tapered), `scumble` (fine incoherent texture: broken and partly starved), `contour`, and `accent` (light structured areas: thick with a full heap). Relief therefore has a hierarchy: quiet water and sky, emphatic rock and lights.
- **Knife limits:** a stroke that cannot reach its layer's minimum length without crossing a colour edge is dropped instead of smearing. Narrow knives judge colour mostly by their centreline, so they can still paint a trunk thinner than the blade.
- **Seeding:** worst error first on a grid, skipping strokes mostly over ones already placed (Paint Transformer's occlusion rule) or that would not bring the canvas closer to the image. Coverage layers add fill passes until no cell is bare.
- **Order:** layer by layer, large to small (underpaint, block-in, masses, forms, detail, contours, accents). Inside a layer, where two strokes overlap, the one that matches the image better there is painted later, so it ends up on top. Otherwise ground shapes go before figure shapes, then darks before lights.
- **Loading:** each layer keeps one knife per colour family (twelve hue sectors, each dark and light, plus dark and light neutrals), so residue never carries teal into grey rock or turquoise lake into pale sky. Loads are at least 6x the simulation's yield volume (`yieldVolume` in `tool.ts`); near 1x the knife starves within millimetres and leaves pitted, broken paint. Lighter paint is laid thicker.
- **Paint on the knife** (`oil` look, `streaks`): a knife is loaded with the colours found across its path, sampled at five points across the blade along the stroke. They are re-centred on the stroke's colour and kept within 0.1 OKLab of it. They go on in streaks, like paint picked up from a partly mixed pile (`Tool.loadProfile`). How well they are mixed depends on the primitive: quick presses and accents stay streaky, broad sweeps blend. A stroke crossing a light-to-dark turn of form carries both, as in faceted knife portraits. The underpainting is toned toward a warm dark (`underTone`, 0.3), so where it shows between knife strokes it reads as underpainting rather than as a gap.
- **Deterministic:** only `+ - * / sqrt floor`, `dmath`, stable sorts with total-order keys, and hashing instead of a stateful random generator. `npm test` checks the plan and the painted canvas are identical across runs.

Scale matters: knife sizes are physical, so a wider canvas gives more detail. At 240 mm the trees and peaks are smaller than the smallest stroke a knife can make; 360 mm reads well; 480 mm is finer still but takes about twice as long.

## Performance

`npm run bench` times the `npm run paint` pipeline stage by stage on the benchmark scenes (lake, portrait, flowers, building in `tests/scenes.json`; `synthetic` is a tiny built-in image for smoke tests). Each scene and width runs in its own child process, so peak memory is per run and a crash in one run does not stop the others. Results go to the console, to `out/bench/<name>.json`, `out/bench/<name>.md` and `out/bench/summary.md` (latest run), with the machine (CPU, cores, RAM, Node, git commit, date) and the load average at start and end. A busy machine (1-minute load above half the cores) is flagged, because its timings are inflated.

```sh
npm run bench -- --quick            # lake at 60 mm, about 15 s on a quiet machine
npm run bench -- --scenes lake,portrait --width 120,240,scene --look oil --repeat 3 --json out/bench/mine.json
npm run bench -- --plan-only        # planning only: no simulation, relight or surface
npm run bench -- --quick --gpu      # also time the WebGPU relight in headless Chromium
```

Options: `--scenes` (comma list), `--width` (mm, `scene` for the scene's own width, or a fraction of it such as `0.5x`; several give a sweep), `--look oil|locked` (default `oil`), `--repeat N` (median shown, min in the JSON), `--quick`, `--plan-only`, `--gpu`, `--gpu-frames N` (default 5), `--json path`.

Stages (ms, median of the repeats):

- **load**: PNG decode. **setup**: the `Planner` constructor, which is **resample** (area-average onto the 0.5 mm analysis grid and OKLab), **analysis** (`paintingMaps`, knife scale) and **forms** (`formHierarchy`). Those three are timed standalone with the planner's own inputs, as a breakdown of setup; "forms breakdown matches planner" confirms they rebuilt what the planner built.
- **planning**: `planLayer` for every layer and the deferred strokes. The bench drives the `Planner` layer by layer as `planPainting` does (a test checks it plans the same), so the simulation run between layers is not counted.
- **canvas**: `startPainting` (allocating the canvas and its weave). **painting**: `paintStrokes`, the simulation. **readback**: `canvasColour`, the painted colour fed back to the planner after each layer. A per-layer table splits planning and painting by layer, with ms per stroke.
- **relight**: one CPU `relight()` frame of the `paint` view, which is what one light change costs. **surface**: `surfaceFromCanvas`, packing for a viewer (not in total).
- **total**: load + setup + planning + canvas + painting + readback + relight: the paint CLI with one relit view instead of four and no PNG output.

Each stage is also given per million of three denominators: **image MP** (input photo pixels), **grid Mc** (planner cells, 0.5 mm) and **canvas Mc** (simulation cells, `widthMm / 0.1` x `heightMm / 0.1`). Canvas cells are the meaningful one: painting and relight scale with the canvas, and photo resolution only affects load and resample. Memory: peak RSS for the run, and heap used and external (typed arrays) sampled at stage boundaries.

**Scaling and projections.** With two or more widths per scene, the bench fits time = a x (canvas Mc)^b per stage and projects to canvases of 1, 4, 12 and 24 Mc (at 0.1 mm per cell, an N MP photo painted one cell per pixel), and to 1, 4 and 12 MP photos at the scene's default width. These are labelled extrapolated, and rows more than 4x past the largest measured canvas are marked unreliable.

**GPU relight** (`--gpu`): renders the WebGPU shader (`RELIGHT_WGSL`) on the same canvas in headless Chromium through Playwright, as `npm run gpu-parity` does, once per scene at its largest width: a warm-up frame, then the median of `--gpu-frames` frames (each changes the light azimuth, renders both passes and waits for the queue), plus one frame with readback, against the CPU `relight()`. Without WebGPU it reports "unavailable" and the reason. Headless Chromium here runs WebGPU on SwiftShader, a CPU implementation of Vulkan: its frame times describe a software rasteriser, not a GPU. A real GPU is expected to be orders of magnitude faster.

**Full benchmark** (for a quiet 2-core machine; about 35-45 min expected, under 60):

```sh
npm run bench -- --scenes lake,portrait,flowers,building --width 0.33x,0.67x,1x --look oil --gpu --gpu-frames 3 --json out/bench/full.json
```

This paints each scene at a third, two thirds and all of its default width (about 0.7, 2.7 and 6 Mc each, as the defaults are all near 6 Mc), so each scene gets a three-point scaling fit. The GPU timing at full size takes about 2-3 min per scene on SwiftShader; drop `--gpu` to save it. Peak RSS at 6 Mc is about 2 GB, plus Chromium with `--gpu`.

Calibration taken while three other jobs shared the machine (load average 4-9 on 2 cores, so roughly 2.5-3x slower than a quiet machine; not results): lake, `oil`, 120 mm (0.69 Mc, 487 strokes) 75 s in total, of which painting 57 s and CPU relight 10 s; 240 mm (2.77 Mc, 1487 strokes) 4.1 min, painting 3.0 min (122 ms per stroke), planning 19 s, setup 3.9 s, CPU relight 37 s, peak RSS 826 MB. Painting scaled with canvas cells to the power 0.84 and relight 0.94. The WebGPU shader on SwiftShader took 33 s per frame at 2.77 Mc. A light change on the CPU costs about 13 s per canvas Mc under that load, so live relighting needs the GPU path; the CPU renderer suits stills.
