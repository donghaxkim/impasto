# Height compositing and overlap audit

## Scope and evidence status

[Verified] This audit covers only retained-height deposition, overlap behavior, contact edges, and thin-film relief.

[Verified] `/tmp/closeup-r7-paint.png` and `/tmp/closeup-r7-normal.png` are dated `2026-10-28 16:24`.

[Verified] `src/shaders.ts` is dated `2026-10-28 16:30`, so the r7 captures were made before the current source revision.

[Verified] The current `heightFragment` uses a `0.62 mm` bridge with a `2-8 px` clamp (`src/shaders.ts:300`).

[Verified] The requested `0.95 mm` bridge is not present in the current source.

[Verified] The current `heightFragment` samples only four cardinal neighbors at that radius plus the center texel (`src/shaders.ts:301-310`).

[Verified] It mixes the old height toward that local mean by up to `0.88` (`src/shaders.ts:311-312`), then adds the fresh thickness (`src/shaders.ts:313`).

[Verified] A fresh render of the current source still shows the broad ghost bands, dark contact outlines, and nearly planar ground visible in the r7 captures (`review/height-current-paint.png`, `review/height-current-normal.png`).

[Inferred] The exact r7 bridge version cannot be recovered from the files, so the 0.95 mm evaluation below is mathematical and uses the stated radius plus the current clamp and blend behavior.

[Verified] The reference photos show opaque, merged paint masses at overlaps, contact rims that curl and catch light, and canvas weave remaining visible through thin paint.

[Inferred] The reference comparison is qualitative because the photos have different scale, lighting, and medium consistency.

## 1. Old-stroke ghost bands

[Verified] The dark horizontal bands crossing the vertical green stroke in `closeup-r7-paint.png` also appear as coherent slope bands in `closeup-r7-normal.png`.

[Verified] Those bands are transverse to the green stroke's own bristle streaks, so they cannot be explained by its stroke-local ridge field.

[Inferred] They are relief inherited from the older ochre, coral, and ground marks.

[Verified] The compositor always returns `old + fresh thickness` (`src/shaders.ts:313`).

[Verified] Opaque color does not remove the old height, because pigment and height are separate retained targets.

[Verified] The resulting normal is the gradient of the sum, so every old broad ridge remains a normal-map ridge unless the compositor explicitly compacts it.

[Verified] The four-tap cross average is not a high-pass filter.

[Verified] For a wave along a screen axis, its local-mean gain is `(2 + cos(kR)) / 3`, and after the `0.88` mix the retained gain is `0.12 + 0.88 * (2 + cos(kR)) / 3`.

[Verified] At `R = 0.96 mm`, the retained axis-aligned gain is approximately `0.991` at 1 mm wavelength, `0.707` at 1.28 mm, `0.413` at 1.9 mm, `0.702` at 3.8 mm, and `0.912` at 7.6 mm.

[Verified] The filter therefore behaves as a narrow, non-monotonic comb rather than a monotonic high-pass.

[Verified] The response depends on orientation because the stencil samples only screen X and Y.

[Verified] Along the diagonal, the same `0.96 mm` radius produces gains near `0.046` at 1 mm, `-0.141` at 1.9 mm, and `-0.147` at 3 mm.

[Inferred] Negative gain can reverse a diagonal old ridge into a trough, producing phase-inverted or worm-like ghost bands rather than clean removal.

[Verified] The full-width response table and the current `0.62 mm` comparison are reproducible with `node review/height-bridge-response.mjs`.

[Inferred] The visible 5-20 mm ghost bands survive because the 0.95 mm kernel passes 67-95 percent of their axis-aligned amplitude.

[Verified] The settling blend is also reduced near the contact edge by `smoothstep(0.20, 0.88, heightCoverage)` (`src/shaders.ts:311`), so inherited relief is strongest exactly where the fresh edge meets the old mark.

[Inferred] A fixed 0.95 mm radius has no clear physical correspondence in oil paint.

[Inferred] Wet loaded paint levels relief over a distance related to its layer thickness, contact pressure, and brush footprint, not a constant sub-millimetre radius.

[Inferred] A 4 mm fresh layer crossing an 8-20 mm old ridge should compact or fill part of that ridge, not reproduce it at 70-90 percent amplitude.

## 2. Dark one-pixel contact seams

[Verified] Color coverage uses `aa = max(0.035, pixelMm * 0.62)` (`src/shaders.ts:178`).

[Verified] At the close-up scale, `pixelMm = 0.12 mm`, so the color transition spans only about `0.74 px` on each side of the silhouette.

[Verified] Height uses a wider bevel of roughly `0.34-0.59 mm` (`src/shaders.ts:188-193`), which is about 3-5 px at this scale.

[Verified] The visual dark line is therefore not a literal one-pixel height step.

[Verified] The flat-brush height support still rises through roughly `3.1-3.9 mm` for the 3.1 mm ochre mark and `4.0-5.0 mm` for the 4.0-4.7 mm marks.

[Verified] A smoothstep of that thickness over 0.34-0.54 mm has a maximum slope of about `8.6-20.7` (`review/height-bridge-response.mjs`).

[Inferred] At the 34 degree default light, most of that bevel faces away from the light, so diffuse illumination collapses toward ambient and the 3 x 3 Sobel normal turns it into a dark outline.

[Inferred] The 0.74 px color cut is then superimposed on that dark slope, which makes the transition read as a vector cut-out rather than a physical contact.

[Verified] The current paint is screened by `heightCoverage` inside the bevel (`src/shaders.ts:252-253`), while the squeezed lip is also multiplied by that support (`src/shaders.ts:249-250`).

[Inferred] The lip is therefore strongest where the edge support is already falling, and it cannot form a readable rounded contact bead.

[Verified] The reference contact edges are broken, rounded, and locally curled; they do not form a uniform dark outline around the whole footprint.

[Inferred] The correct fix is a physically wider, load-dependent meniscus plus a visible lip, not a wider blur applied to the normal map.

## 3. Flat slabs and lost linen tooth

[Verified] The r7 height view shows broad near-planar stroke tops with sharp stepped overlaps, while the normal view shows the old ridge pattern crossing fresh strokes.

[Verified] The paint field adds a persistent normalized film floor of `0.105 + 0.025 * mass` (`src/shaders.ts:252`).

[Verified] That floor is multiplied by the authored stroke height and therefore adds a smooth layer over the entire footprint, including regions where the macro mass is low.

[Verified] The flat-brush cross profile remains within `0.87-1.0` across the width (`src/shaders.ts:208-212`), so the center is a broad plateau rather than a loaded crown with real valleys.

[Inferred] Together, the film floor and plateau make thick marks read as raised sheets even before overlap smoothing.

[Verified] Thin ground marks use authored heights of `0.024-0.034 mm` (`src/scene.ts:139-147`).

[Verified] The analytic linen tooth contributes at most about `0.014 mm` before the broad ground term (`src/shaders.ts:426`).

[Verified] The bridge begins settling at `0.012 mm` fresh thickness (`src/shaders.ts:311`), so thin ground films are not excluded from the smoothing path.

[Inferred] Several overlapping ground films apply that smoothing repeatedly, compounding the loss of tooth despite the small per-stroke effect.

[Verified] At the 1.0-1.13 mm fundamental thread spacing, the 0.95 mm cross kernel is nearly transparent along the screen axes.

[Inferred] The bridge alone cannot explain all tooth loss at the fundamental weave frequency.

[Inferred] The larger causes are the smooth film offset, the repeated application of the bridge to accumulated thin films, and the bridge's stronger diagonal and harmonic response.

[Inferred] A thin oil film should settle into weave valleys and leave high thread crowns partially exposed; the current model adds a mostly uniform offset and therefore lowers the tooth's relative visual contribution.

## Recommended formulas and parameters

### Thick-paint overlap compaction

[Inferred] Replace the fixed-radius cross average with an isotropic pressure compaction whose scale follows the brush contact patch and fresh layer thickness.

[Inferred] Use eight symmetric radial samples so a linear support plane is preserved and only local curvature and ridges are compacted.

[Inferred] Use a radius of roughly `Rmm = clamp(0.28 * widthMm + 0.25 * thicknessMm, 1.4, 6.0)`.

[Inferred] At the close-up scale this is about 4-6 mm for the 12-19 mm loaded brushes.

[Inferred] Apply compaction only under thick paint and only where the bed already contains paint.

```wgsl
let thick = smoothstep(0.45, 1.30, thickness);
let settle = 0.55 * thick
  * smoothstep(0.25, 0.90, field.heightCoverage)
  * smoothstep(0.15, 0.85, old.b);

let radiusPx = clamp(
  1, i32(round(Rmm / mmPerPixel)), 40,
);
var bedMean = 0.0;
for (var i = 0; i < 8; i += 1) {
  let angle = f32(i) * 0.78539816;
  let offset = vec2<i32>(
    round(cos(angle) * f32(radiusPx)),
    round(sin(angle) * f32(radiusPx)),
  );
  bedMean += textureLoad(
    priorSurface,
    clamp(p + offset, vec2<i32>(0), dims - vec2<i32>(1)),
    0,
  ).r;
}
bedMean *= 0.125;

let bed = mix(old.r, bedMean, settle);
let deposited = bed + thickness;
```

[Inferred] A settle fraction of `0.45-0.60` is preferable to `0.88`; it removes most inherited ridge contrast without erasing the old mark's broad support.

[Inferred] Do not clamp the physical radius to 2-8 px, because that turns an intended millimetre scale into a canvas-resolution scale.

### Thin-film tooth preservation

[Inferred] Do not apply thick-paint bed compaction when fresh thickness is below roughly `0.20-0.25 mm`.

[Inferred] For thin films, bias deposition toward existing valleys instead of adding a uniform smooth offset.

```wgsl
let toothRadiusPx = max(1, i32(round(0.45 / mmPerPixel)));
let toothMean = 0.25 * (
  textureLoad(priorSurface, clamp(p + vec2<i32>(toothRadiusPx, 0), vec2<i32>(0), dims - vec2<i32>(1)), 0).r +
  textureLoad(priorSurface, clamp(p - vec2<i32>(toothRadiusPx, 0), vec2<i32>(0), dims - vec2<i32>(1)), 0).r +
  textureLoad(priorSurface, clamp(p + vec2<i32>(0, toothRadiusPx), vec2<i32>(0), dims - vec2<i32>(1)), 0).r +
  textureLoad(priorSurface, clamp(p - vec2<i32>(0, toothRadiusPx), vec2<i32>(0), dims - vec2<i32>(1)), 0).r
);
let peak = clamp((old.r - toothMean) / 0.012, 0.0, 1.0);
let thinFill = thickness * mix(0.35, 1.0, 1.0 - peak);
```

[Inferred] A ground-film contribution of `0.35-1.0` times the base thickness keeps thread crowns exposed while filling weave valleys.

[Inferred] This preserves the linen signal under a semi-transparent film without faking it in the lighting pass.

### Contact bevel and lip

[Inferred] Make the height bevel scale with paint thickness rather than using only brush kind.

[Inferred] A useful starting point is `bevelMm = clamp(0.38 + 0.10 * thicknessMm, 0.48, 0.95)`.

[Inferred] Widen pigment anti-aliasing to at least `aa = max(0.095, pixelMm * 1.10)`.

[Inferred] Move the squeezed lip to `0.55-1.05 mm` inside the silhouette and give it a `0.18-0.30 mm` width.

[Inferred] Add the lip after the main support attenuation so it can produce a rounded bead around the contact instead of being suppressed by the same mask that drops the body to zero.

### Remove the slab floor on thick marks

[Inferred] Gate the persistent film floor by authored stroke height so loaded impasto can return to near-zero thickness in its valleys.

```wgsl
let impasto = smoothstep(1.20, 3.00, stroke.document.w);
let film = mix(0.105 + 0.025 * mass, 0.012, impasto);
```

[Inferred] This is a field-level complement to the compositor fix; the retained deposition architecture remains unchanged.

## Verification boundaries

[Verified] No files under `src/` were edited.

[Verified] The 0.95 mm response table is model output, not a rendered A/B comparison.

[Verified] The current renders show that reducing the bridge to 0.62 mm did not eliminate the broad ghost bands.

[Inferred] The recommended radial compaction and thin-film split should remove more broad inherited relief while preserving linen tooth, but this has not been implemented or visually verified.
