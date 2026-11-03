# Impasto: raised walls and loaded brushstrokes

November 3, 2026. First implementation pass; visual acceptance remains pending.

## Reference collection

These are original paintings used as material references, not generated images. Artwork and photography belong to their respective artists. Images below link to the artists' or sellers' published photographs and require an internet connection.

| Painting | Artist | What to study |
| --- | --- | --- |
| [Mediterranean Coast](https://www.etsy.com/ca/listing/4374195252/mediterranean-coast-oil-painting) | Yurii Lyskov / LyskovART | The strongest close-up: relatively smooth scraped faces beside steep, irregular lips. Tiny highlights sit on the crests; shadows reveal the lifted paint. |
| [Rocky Mountain National Park](https://hanna-art.com/products/rocky-mountain-national-park-oil-painting-original-impasto-fall-landscape-art) | Hanna Hryharenka | Broad knife marks in the sky, stacked angular deposits in the trees, and a painted background with its own relief. |
| [Golden Forest Soirée](https://www.annmariecoolick.com/product-page/autumnal-dance-20-x16) | Ann Marie Coolick | Dense, short, chunky deposits at varied orientations. Unequal paint loads create a hierarchy of peaks and low areas. |
| [Autumn Forest](https://hanna-art.com/products/impasto-autumn-forest-oil-painting-rustic-fall-landscape-wall-art) | Hanna Hryharenka | Original project reference, retained alongside the three additional examples. |

### Mediterranean Coast — surface detail

![Yurii Lyskov: turquoise impasto with scraped faces, raised lips, and contact shadows](https://i.etsystatic.com/60467161/r/il/1a40a5/7269502987/il_794xN.7269502987_bhxy.jpg)

### Rocky Mountain National Park

![Hanna Hryharenka: heavily layered mountain landscape](https://hanna-art.com/cdn/shop/files/il_fullxfull.7377303535_hpmd.jpg?v=1763284149&width=1946)

### Golden Forest Soirée

![Ann Marie Coolick: dense yellow, orange, and pink impasto foliage](https://static.wixstatic.com/media/ea2373_0a581d55e4bb45739ef7b9e792691454~mv2.jpg/v1/fill/w_895%2Ch_1114%2Cal_c%2Cq_85%2Cenc_avif%2Cquality_auto/ea2373_0a581d55e4bb45739ef7b9e792691454~mv2.jpg)

### Autumn Forest — original reference

![Hanna Hryharenka: original autumn forest reference](https://hanna-art.com/cdn/shop/files/il_fullxfull.7237566281_meow.jpg?v=1758696146&width=1946)

## Material interpretation

The three additional references were inspected visually. The raised appearance comes from the distribution of paint volume, not uniform surface roughness. Smooth faces make adjacent ridges readable. Uneven squeeze-out, torn ends, layered deposits, and directional shadows are more important than adding more fine noise.

The archived `lighting-current-paint-1to1.png` was inspected as historical evidence. It shows long ribbons and repeated grooves, but it predates some existing source changes and is not a freshly captured baseline.

## Implementation in this pass

- `src/shaders.ts`: added a shared `loadedPaintField` for pigment coverage and deposited height. It uses a thicker body, finite asymmetric folds, varying side banks, and locally loaded end caps. Fine bristle detail is shallow and fades below pixel resolution.
- `src/shaders.ts`: shadows now sample out to 4–32 mm depending on light elevation, with denser sampling near contact and bilinear height lookup. The old reach was approximately 3.4 mm. Cavity shading uses millimetre-scale neighboring relief rather than outlining every narrow groove.
- `src/shaders.ts`: the height diagnostic uses an exponential mapping so thick overlaps no longer all clip to white at 3 mm. Height data remains in millimetres; only its visualization changed.
- `src/scene.ts`: raised the seven main Close-up stroke height parameters from 0.95–2.05 mm to 2.4–4.6 mm. These are authored scale parameters, not measurements of final peak heights. Final deposits vary with the local shape and supporting layers.
- `preview.html`: rebuilt the self-contained preview from current source.

Retained strokes, separate color and height surfaces, deterministic seeds, and existing lighting controls remain intact. No photo pipeline or animation was added. Earlier experimental shader functions remain available, but fragment entry points now use `loadedPaintField`.

## Verification and remaining work

Follow-up correction: the user's browser screenshot exposed WGSL compilation failures because `macro` and `patch` are reserved identifiers. Renamed them to `macroLoad` and `bristlePatch`, expanded the regression check across all three shaders, and rebuilt the standalone preview. The corrected build and all eight tests pass. This fixes the two reported errors; a successful GPU render is still unverified here.

Passed: TypeScript checking, Vite production build, all eight existing Node tests, and standalone preview generation.

Not verified: GPU compilation of the new WGSL, current browser appearance, visual similarity, or rendering performance. The test suite checks geometry and a limited shader identifier rule; it is not a WGSL compiler. Local server startup failed with `EPERM`. Native browser access timed out, and browser policy blocked the `file:` preview. No new renderer screenshots were captured, and this pass is not visually accepted.

For the next browser review, open `preview.html` in a WebGPU-capable browser and select **Close-up**. Start at Reset values (azimuth 315°, elevation 34°, relief 1, roughness 0.48), then compare elevations 20° and 65° and azimuth 135°. Inspect Paint, Color, Height, and Normal. Confirm that moving the light changes highlights and cast shadows without rebuilding retained surfaces. Also check Diagnostics, especially the same-color crossing, and Composition.

Reject the pass if folds look like repeated plastic cords, side banks form continuous decorative outlines, shadows become uniformly black, or older grooves visibly print through thick new marks. Check relief 0 for a flat, unoccluded result and resizing for stable texture scale. Capture actual before/after evidence before claiming a reference match.

This is still a top-down height-field approximation: it can depict steep slopes and cast shadows, but it cannot represent a true overhang, reveal vertical side faces from a tilted camera, or simulate paint transport. Dense, short-dab compositions and fully textured underpainting across the Composition scene remain separate follow-up work.
