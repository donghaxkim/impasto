# Impasto CPU simulation

A deterministic paint simulation in plain TypeScript, separate from the WebGPU prototype in `../src`. It needs Node 22 and has no dependencies. `tests/crop.py` also needs Python with Pillow.

```sh
npm run render   # writes PNGs to out/
npm test         # physics and determinism checks
npm run viewer   # writes out/viewer-*.html for moving the light live in a WebGPU browser
python3 tests/crop.py   # JPEG previews and 1:1 crops
```

## How it works

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
