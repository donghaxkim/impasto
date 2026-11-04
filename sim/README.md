# Impasto CPU simulation

A deterministic paint simulation in plain TypeScript, separate from the WebGPU prototype in `../src`. It needs Node 22 and has no dependencies. `tests/crop.py` also needs Python with Pillow.

```sh
npm run render   # writes PNGs to out/
npm run paint    # plans and paints tests/fixtures/lake.png (about 4 min at --width 360)
npm run paint -- photo.png --width 360 --plan-only   # just the stroke plan, in seconds
npm run paint -- --look oil   # the same, with the new semi-gloss look
npm run diagnose -- --fast    # three crops (mountains, spruce, lake): plan, colour, height, normals, render, metrics
npm run diagnose -- --fast --scene portrait --look oil   # other scenes in tests/scenes.json (flowers, building, portrait; images in scenes/, not committed)
npm run diagnose -- --fast --look oil --forms 0 --streaks 0 --tone 0 --restraint 0 --presses 0 --scale 0   # round 3's plan under the oil look
# also --defer 1 to paint thin lights last
python3 tests/diag-sheet.py out/diag && python3 tests/diag-compare.py out/diag out/diag-<name>
npm run gpu-parity            # WebGPU viewer against the CPU reference, both looks (headless Chromium)
npm run test:viewer           # browser tests for the live viewer: GPU parity, fallbacks, demo page (about 2 min)
```

The diagnostic reports, per crop: colour error and silhouettes kept at the plan, painted-colour and shaded stages; **expressiveness** (mean turn per stroke, share of curved strokes, width variation along strokes, variety of primitives); **relief hierarchy** (relief in structured against flat areas, sculptural peaks); and **physical realism** (share of paint in berms and heaps, groove index of fine ripple against form relief, bead index of glints breaking into specks, steep walls, and the volume ledger)); and **pigment** (colour gradient inside knife strokes against the photo's there, streak anisotropy as gradient across the stroke over gradient along it, and the share of the crop no knife stroke covers).

```sh
npm test         # physics, stroke primitives, planner and determinism checks
npm run viewer   # writes out/viewer-*.html for moving the light live (see Live viewer below)
python3 tests/crop.py   # JPEG previews and 1:1 crops
```

## How it works

Pipeline: image → `image.ts` analysis → `planner.ts` ordered stroke plan → `execute.ts` runs it through `tool.ts`/`canvas.ts` → `relight.ts`.

- `src/image.ts`: resamples the photo onto a millimetre grid, OKLab colour, blurs, and an edge-following direction field from the colour structure tensor (no angles, so no trig).
- `src/structure.ts`: the painting representation: detail, coherence, silhouettes, flatness and target relief maps.
- `src/planner.ts`: the image-to-strokes planner (below).
- `src/execute.ts`: wipes, loads and drags each planned knife, and reads the canvas colour back for the planner.

- `src/tool.ts`: tool nodes, plowing, wet exchange, stiction and the terminal heap.
- `src/canvas.ts`: canvas weave, two paint layers per cell, mass-conserving moves and slumping.
- `src/relight.ts`: the reference renderer, with GGX clearcoat, ray-marched shadows and horizon occlusion.
- `src/relight-gpu.ts`: WebGPU port of the renderer.
- `src/surface.ts`: `ImpastoSurface`, the packed height and colour buffers a renderer needs, and the `.impasto` file format.
- `src/viewer.ts`: the browser viewer (live WebGPU relighting with a static fallback); `src/viewer-bundle.ts` inlines it into pages.
- `src/dmath.ts`: math that gives the same result on any JS engine. Paint code must not call `Math.sin`, `Math.pow`, `Math.exp` or `Math.random`.
- `src/pigment.ts`: colour conversion. Node and cell RGB are stored as Kubelka-Munk K/S, so mixing behaves more like pigment.

## Live viewer

`src/viewer.ts` is a browser-only module, no dependencies, that relights a painted surface live. Nothing in the paint path imports it, so the simulation runs the same with no GPU.

```ts
import { createImpastoViewer, attachPointerLight } from './viewer.ts';
const viewer = await createImpastoViewer(canvasEl, surface /* ImpastoSurface */, {
  light: { azimuth: 225, elevation: 30 },   // Partial<LightSettings>; defaults to DEFAULT_LIGHT
  look: 'oil', view: 'paint',
  fallback: { width, height, data },        // RGBA or RGB bytes, e.g. relight(canvas, DEFAULT_LIGHT)
  onFallback: (reason) => console.warn(reason),
});
viewer.mode;                 // 'webgpu' | 'static'; fallbackReason says why it is static
viewer.setLight({ azimuth: 45 }); viewer.setLook('locked'); viewer.setView('height'); // redraw on the next frame
viewer.render();             // draw now
await viewer.readPixels();   // RGBA, canvas width x height (tests)
const detach = attachPointerLight(viewer, undefined, { mapping: 'linear', onChange: (l) => {} });
viewer.destroy();
```

- **WebGPU path:** the surface's buffers go up as an `rg32float` height texture and an `rgba32float` colour texture, and `RELIGHT_WGSL` runs its two passes (HDR `fs`, then `composite` with the glow) on every change, at one canvas pixel per cell (scale with CSS). `npm run gpu-parity` and `npm run test:viewer` check it against the CPU `relight()`: mean difference about 0.5 of an 8-bit level for both looks, a low side light with more relief, and the colour view.
- **Fallback:** the viewer goes to `mode: 'static'` if `navigator.gpu` is missing, `requestAdapter()` gives null or throws, the surface is larger than the GPU's texture limit, device creation or pipeline setup fails, or the device is later lost. It never throws for these; it calls `onFallback(reason)` once and fires a `modechange` event. A canvas that has had a WebGPU context cannot give a 2D one, so after a lost device the viewer swaps an identical fresh `<canvas>` into the DOM (`viewer.canvas` follows; `attachPointerLight` without an element follows too).
- **Static drawing:** with a `fallback` image, the 'paint' view shows it as is (`interactive` is false: the light controls cannot change it); other views use the approximation. Without one, the viewer shades the height field itself: wrapped Lambert key, soft fill and a Blinn-Phong coat from the stored roughness. No shadows, occlusion or glow, so it is flatter than the reference, but the light still moves it (about 0.2 s per frame at 1200 x 900).
- **Pointer drag:** `mapping: 'linear'` (default, as Milestone 0): horizontal position sets azimuth (left 360°, right 0°), vertical sets elevation (top 85°, bottom 5°). `'radial'`: the light comes from where you point, seen from the centre; the centre is overhead, the edge grazing.

### `.impasto` files

`encodeSurface(s)` / `decodeSurface(bytes)` in `surface.ts`, so a site can ship prerendered paintings. Little-endian, version 1: 8-byte magic `IMPASTO\x1a`, u32 version, u32 header size (48; data starts there, so a later version can grow the header), u32 w, u32 h, u32 flags (0), u32 reserved, f64 dx, f64 maxH, then `height` (w·h·2 f32) and `color` (w·h·4 f32), bit-exact. That is 24 bytes per cell: 26 MB for 120 x 90 mm at 0.1 mm, 233 MB for 360 x 270 mm. gzip only saves about 12% on these floats; a quantised version 2 (f16 or 16-bit heights) is the obvious next step if files must be small.

### Demo pages

```sh
npm run viewer                                  # out/viewer-one-stroke.html, viewer-patch.html, and an empty viewer.html
npm run paint -- --width 240 --export-surface   # also writes out/<name>.impasto
npm run viewer -- out/lake.impasto              # out/viewer-lake.html, with out/lake-paint.png as its static fallback
```

Each page is self-contained (open it from disk): it inlines `viewer.ts` and its imports through an import map of `data:` URLs (`src/viewer-bundle.ts` strips the types with Node's own `stripTypeScriptTypes`, so no bundler is needed), and has sliders for azimuth, elevation, relief, glow and exposure, a light dial, look, view and drag-mapping menus, a "Use the static fallback" switch, a badge showing live WebGPU or static mode with the reason, and a button to open an `.impasto` or `.impasto.gz` file. Scene pages carry a CPU render at the default light as their fallback. Pages open on the 'locked' look; for a painting made with `--look oil`, pick Oil (its `-paint.png` fallback is already in that look).

GPU memory is about 40 bytes per cell (two float textures plus the HDR target): about 43 MB at 1200 x 900, about 390 MB at 3600 x 2700, which some integrated or mobile GPUs may refuse; that ends in the static fallback.

Headless Chromium here exposes WebGPU through SwiftShader. Presenting to an on-screen WebGPU canvas needs `--use-angle=swiftshader --enable-unsafe-swiftshader` as well; without them Chromium loses the device on the first frame, which `test:viewer` uses as a real device-loss case.

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

`LightSettings.look` (and `PlanSettings.look`): `'locked'` (default) is the reference look, pixel-identical to before, kept for regression comparison. `'oil'` is the intended replacement and also switches the planner's strokes to physical deposition; it becomes the default only once it is consistently better across several scenes. `'oil'` is semi-gloss: rougher coat, highlights filtered by how fast the normal turns within a pixel (Kaplanyan's geometric specular anti-aliasing) so crests carry continuous sheens instead of beads, weaker crest boost and second highlight window, gentler cavities, and a weaker knife edge profile on broad strokes. The WebGPU port takes the same parameters (`relightUniforms`); `npm run gpu-parity` checks both looks.

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
  - *Small features* (`forms.ts`): superpixels up to 5 mm across whose colour stands at least 0.12 OKLab off their neighbours (the white of an eye, a catchlight, a fleck) are exempt from restraint. Each gets its own mark in the finest layer, as wide as itself and in its own colour.
- **Knife size from the image** (`oil`, `autoScale`): knives are scaled by how much of the canvas has structure at painting scale (detail above 0.45). The factor is (0.6 / share)², from 1 to 2.2: about 1.8 for the portrait and flowers, 1.16 for the building, 1 for the lake. The scaling is graded by knife size. The masses knife and wider take all of it, the finest knives keep their size, so a close-up gets broad planes and still has a small knife for an eye.
- **Deferring thin lights** (`deferThin`, off): this paints thin marks lighter than their surroundings after every layer. Tested on the glass facade, it made the mullions worse (0.53 against 0.67 of the edges kept in the painted colour). The blades are wider than a mullion, so it is the darks painted after a light line that cut it to width, and a light laid last over wet dark paint picks some of it up.
- **`locked` is the round-3 plan:** with the `locked` look the planner ignores shapes, presses, scaling, restraint, streaks and toning, and a test pins its plan to the round-3 digest.
- **Form-aware direction:** inside a shape, the direction blends three things:
  - image edges, weighted by their coherence;
  - the shape's principal axis, weighted by its elongation;
  - near its edge, the edge itself.
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
