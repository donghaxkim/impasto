# Impasto CPU simulation

A deterministic paint simulation in plain TypeScript, separate from the WebGPU prototype in `../src`. It needs Node 22 and has no dependencies. `tests/crop.py` also needs Python with Pillow.

```sh
npm run render   # writes PNGs to out/
npm run paint    # plans and paints tests/fixtures/lake.png (about 4 min at --width 360)
npm run paint -- photo.png --width 360 --plan-only   # just the stroke plan, in seconds
npm run paint -- --look oil   # the same, with the new semi-gloss look
npm run diagnose -- --fast    # three crops (mountains, spruce, lake): plan, colour, height, normals, render, metrics
python3 tests/diag-sheet.py out/diag && python3 tests/diag-compare.py out/diag out/diag-<name>
npm run gpu-parity            # WebGPU shader against the CPU reference, both looks (headless Chromium)
npm test         # physics, stroke primitives, planner and determinism checks
npm run viewer   # writes out/viewer-*.html for moving the light live in a WebGPU browser
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
- `src/dmath.ts`: math that gives the same result on any JS engine. Paint code must not call `Math.sin`, `Math.pow`, `Math.exp` or `Math.random`.
- `src/pigment.ts`: colour conversion. Node and cell RGB are stored as Kubelka-Munk K/S, so mixing behaves more like pigment.

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

Below 24 mm (`FULL_LIFT_LENGTH`) a stroke's touch-down, lift-off, contact length and heap scale with its length, so a 3-5 mm mark lays paint instead of a blob. Longer strokes are exactly as before.

## Looks

`LightSettings.look` (and `PlanSettings.look`): `'locked'` (default) is the reference look, pixel-identical to before. `'oil'` is semi-gloss: rougher coat, highlights filtered by how fast the normal turns within a pixel (Kaplanyan's geometric specular anti-aliasing) so crests carry continuous sheens instead of beads, weaker crest boost and second highlight window, gentler cavities, and a weaker knife edge profile on broad strokes. The WebGPU port takes the same parameters (`relightUniforms`); `npm run gpu-parity` checks both looks.

## Stroke planner

Research behind it: `docs/prior-art-research.md`.

- **Layers, coarse to fine** (Hertzmann 1998): a thin bristle underpainting, then knives of 15, 9.5, 6 and 3.6 mm, a 3.6 mm contour layer and 2.4 mm accents. Each layer compares a reference blurred to its scale with what is already on the canvas and only paints where the difference is large.
- **Feedback:** with `npm run paint`, each layer is painted by the simulation before the next is planned, so later layers correct what the paint really did (berms, heaps, pickup), not what the planner assumed.
- **Direction:** strokes are traced both ways along the direction field. A fine field (edges) and a field three times wider (forms) are merged by coherence, so a tree is painted along its silhouette, not along each branch. Flat areas fall back to horizontal.
- **Where small strokes go:** a layer's error is discounted where the image has little structure at its scale (after Im2Oil), so the sky and lake stay in broad strokes.
- **Painting representation** (`structure.ts`): detail, coherence, silhouettes (strong, coherent, large-scale edges such as ridgelines, trunks and shores), flatness and a target relief map. The planner reads these, never what the subject is.
- **Silhouette protection:** where a silhouette runs under a broad blade, each blade edge must match on its own and the tolerance tightens, so a broad stroke never straddles a ridgeline or a trunk.
- **Contour layer:** narrow strokes along silhouettes, centred half a blade to one side so the blade's edge lies on the silhouette (cutting in). The more uniform side is painted.
- **Primitives:** each stroke picks one from the maps under it: `sweep` (flat areas: thin, pressed, almost no heap), `plane` (square ends, relief following the area), `mark` (fine coherent structure: tapered), `scumble` (fine incoherent texture: broken and partly starved), `contour`, and `accent` (light structured areas: thick with a full heap). Relief therefore has a hierarchy: quiet water and sky, emphatic rock and lights.
- **Knife limits:** a stroke that cannot reach its layer's minimum length without crossing a colour edge is dropped instead of smearing. Narrow knives judge colour mostly by their centreline, so they can still paint a trunk thinner than the blade.
- **Seeding:** worst error first on a grid, skipping strokes mostly over ones already placed (Paint Transformer's occlusion rule) or that would not bring the canvas closer to the image. Coverage layers add fill passes until no cell is bare.
- **Order:** layer by layer, large to small (underpaint, block-in, masses, forms, detail, contours, accents). Inside a layer, where two strokes overlap, the one that matches the image better there is painted later, so it ends up on top; otherwise darks go before lights.
- **Loading:** each layer keeps one knife per colour family (twelve hue sectors, each dark and light, plus dark and light neutrals), so residue never carries teal into grey rock or turquoise lake into pale sky. Loads are at least 6x the simulation's yield volume (`yieldVolume` in `tool.ts`); near 1x the knife starves within millimetres and leaves pitted, broken paint. Lighter paint is laid thicker.
- **Deterministic:** only `+ - * / sqrt floor`, `dmath`, stable sorts with total-order keys, and hashing instead of a stateful random generator. `npm test` checks the plan and the painted canvas are identical across runs.

Scale matters: knife sizes are physical, so a wider canvas gives more detail. At 240 mm the trees and peaks are smaller than the smallest stroke a knife can make; 360 mm reads well; 480 mm is finer still but takes about twice as long.
