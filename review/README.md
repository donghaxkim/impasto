# Impasto · Visual review snapshot

This directory holds the current renderer's visual output for the two authored scenes.
No rendering algorithms were changed for this review.

## Capture inventory

All captures are the live `#paint-canvas` element, captured through a headed Chrome (WebGPU) session at a `1700 x 1200` window.
The canvas element was rendered at `1132 x 906` CSS pixels in that layout.

- `composition-paint-neutral.png` - Composition, paint view, neutral light.
- `composition-color-neutral.png` - Composition, color view.
- `composition-height-neutral.png` - Composition, height view.
- `composition-normal-neutral.png` - Composition, normal view.
- `composition-paint-enhanced.png` - Composition, paint view, enhanced light.
- `diagnostics-paint-neutral.png` - Diagnostics, paint view, neutral light.
- `diagnostics-color-neutral.png` - Diagnostics, color view.
- `diagnostics-height-neutral.png` - Diagnostics, height view.
- `diagnostics-normal-neutral.png` - Diagnostics, normal view.
- `diagnostics-paint-enhanced.png` - Diagnostics, paint view, enhanced light.

## Capture settings

Neutral is the app's Reset state defined in `src/main.ts`:
`lightAzimuth 315`, `lightElevation 34`, `relief 1`, `roughness 0.48`, `exposure 1`.

Enhanced keeps the light direction fixed and makes the relief more legible:
`lightAzimuth 315`, `lightElevation 14`, `relief 2.2`, `roughness 0.25`, `exposure 1.1`.

Height, color, and normal views are independent of light direction, so only the paint view has a neutral/enhanced pair.

## Height deposition behavior

Relief is accumulated stroke by stroke in `src/renderer.ts`.
Each stroke is drawn into one of two ping-ponged `rgba16float` relief textures, copying the current accumulated relief into the spare before each stroke (`src/renderer.ts:219`).

The deposition math lives in `heightFragment` (`src/shaders.ts:168`).

- `pixelRadius` is `max(3, max(textureWidth, textureHeight) * 0.012)`, which is 12 px for the 1000 x 800 surface (`src/shaders.ts:172`).
- `step` is half that radius, 6 px (`src/shaders.ts:173`).
- The pass samples a 5 x 5 grid at offsets `-2..2` grid steps, so samples reach 12 px from the current texel in x and y, up to about 17 px on the diagonals.
- Each sample is a bilinear read of the prior relief, weighted by a Gaussian `exp(-distanceSq / 2.5)` over the grid index (`src/shaders.ts:176` to `src/shaders.ts:189`).
- `support` is the weighted average of that prior relief (`src/shaders.ts:193`).
- The new deposit is `support + max(0.04, heightField * strokeHeightMm)` (`src/shaders.ts:195`).
- The final stored red channel alpha-blends that deposit over the previous texel value (`src/shaders.ts:197`).

In short, each new stroke is first lifted to a blurred local average of the relief already on the canvas, then its own positive height profile is added on top.

## Does a smaller support radius fix compositing?

No. Reducing the support radius limits the spatial range of the artifact, it does not eliminate it.

The root cause is the deposition formula itself, not the radius.
Because `deposit = support + ownHeight`, every new stroke is anchored to an average of the prior relief within the support neighborhood.
A smaller radius only shrinks that neighborhood, so a nearby raised stroke stops pulling the new stroke upward from far away.
But the new stroke is still lifted by the local prior average at its own footprint, so the anchoring behavior remains.

Removing the support term entirely, or replacing the average-plus-add with an independent composition such as a max blend or a physically separate layer, would be needed to remove the artifact.
Reducing `pixelRadius` should be read as a way to shrink how far the averaging reaches, not as a fix for the underlying compositing model.

This matches the visual evidence in the height and paint frames: strokes that cross an existing raised mass inherit its average height and read as fused into it, and the enhanced-light frames exaggerate that fusing rather than separating the marks.
