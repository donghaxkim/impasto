# Stroke Relief and Silhouette Study

## Scope

This review covers only the physical shape of a retained oil-paint stroke: its silhouette, end mask, macro paste masses, pressure variation, bristle clumps, and squeezed paint accumulation.

It does not propose pigment conversion, background generation, lighting changes, renderer structure changes, or a new height-compositing model.

The target is a stroke that reads as deposited paste at close range, not as a smooth extruded ribbon with a decorative texture applied to its top.

## Evidence inspected

- Current relief field: `src/shaders.ts`, especially `strokeSpace()`, `edgeInsetMm()`, `capInsetMm()`, `paintField()`, and the three streak families.
- Current ribbon geometry: `src/geometry.ts`, especially `endShape()`, `pressureEnvelope()`, `edgeModulation()`, and `buildStrokeMesh()`.
- Current captures: `/tmp/closeup-r7-paint.png`, `/tmp/closeup-r7-normal.png`, `/tmp/closeup-r7-height.png`, and `/tmp/closeup-r7-color.png`.
- Reference crops: `/tmp/ref-brushstrokes.jpg`, `/tmp/ref-impasto-montcarta.jpg`, and `/tmp/ref-impasto-paolo.jpg`.
- Audit crops: `/tmp/stroke-audit/current-paint-crop.png`, `/tmp/stroke-audit/current-normal-crop.png`, `/tmp/stroke-audit/ref-brush-crop.jpg`, and `/tmp/stroke-audit/ref-montcarta-crop.jpg`.

## Verified observations

### Scale and current constraints

- The close-up document is `1000 x 800` canvas pixels with `canvasMm = 120`, so one internal canvas pixel is `0.12 mm` based on the larger dimension (`src/renderer.ts:38` and `src/scene.ts:165`).
- The large close-up marks are `100-154 px` wide, which is `12.0-18.5 mm`, with authored heights of `2.9-4.7 mm`.
- Stroke-local shading already has physical coordinates: `alongMm`, `acrossMm`, `halfWidthMm`, `lengthMm`, and `pixelMm` (`src/shaders.ts:107`).
- Geometry sections are two vertices wide with independent left and right widths (`src/geometry.ts:276`).
- Geometry end shaping narrows the ribbon to only about `88-98%` of full width near each terminus (`src/geometry.ts:189`).
- The shader, not the mesh, is therefore responsible for most of the visible flat/filbert end shape.

### Current visual defects

- The r7 paint and normal captures show a continuous, nearly uniform-height body across each broad stroke.
- The r7 normal capture shows one dominant family of long parallel ridges with similar spacing and few convincing terminations.
- The r7 height capture shows broad plates with long groove rails rather than a few loaded mounds separated by irregular valleys.
- The r7 color capture shows broad rectangular or blunt tapered caps, but flat and filbert ends are not strongly differentiated at silhouette scale.
- The r7 paint capture shows edge lifts and rounded shoulders, but not enough accumulated paint beads, torn deposits, or corner piles to explain the silhouette physically.
- The current filbert cap adds only about `1.2-1.8 mm` of recession from center to shoulder for these brush widths, while the brush half-width is `6-9.25 mm`, so the cap cannot form a convincing round arch (`src/shaders.ts:144`).
- The current body uses a near-constant cross-section for flat brushes and a smooth 2D mass field layered above it (`src/shaders.ts:195` to `src/shaders.ts:216`).
- The current bristle structure is three long coordinate-based ridge families summed across the full body (`src/shaders.ts:216` to `src/shaders.ts:233`).
- The current ridge coordinates use non-integer noise, but their quasi-periodic zero crossings still create a regular corduroy cadence across the stroke.
- The current lip is a Gaussian band tied to edge depth and broken mainly along the stroke axis (`src/shaders.ts:241` to `src/shaders.ts:250`).
- That lip can still read as a manufactured rim because it samples every loaded cross-section along both side edges and uses similar accumulation behavior on both sides.

### Reference observations

- The brushstroke reference contains fine longitudinal striations, but they occur in irregular clumps and often terminate, merge, or disappear into smoother loaded areas.
- The Montcarta reference shows separate broad paste masses, torn edges, heavy menisci, and localized peaks instead of a single even sheet.
- The Paolo reference shows ragged accumulation at the contact edge, one dominant ridge, and small detached or semi-detached paste fragments.
- The references do not show a global uniform comb.
- The references do not show a repeated full-height railing around each mark.
- The references do not show a mathematically centered, bilaterally symmetric cap.

## Inferred conclusions

- The sheet read comes primarily from the body being continuous and nearly constant in cross-section before the streak field is applied.
- The comb read comes primarily from painting longitudinal ridges over that full body, rather than constructing the body from irregular loaded clumps.
- The blunt end read comes primarily from cap recession scaling with only a small fraction of brush width.
- The weak silhouette read comes primarily from edge accumulation being distributed around the perimeter instead of forming a few local paint piles.
- The proposed millimetre values below are calibrated starting points, not yet rendered acceptance values.
- The distinction between physically deposited paint and a merely noisy height field must be judged in the render, not by this document alone.

## Ordered visual hierarchy

The height field should be read in this order at normal viewing distance.

1. Footprint and cap shape: the viewer must first perceive a torn, loaded edge and a recognizable flat or filbert end.
2. Macro paste mass: one to three dominant loaded regions must establish the stroke's weight and direction.
3. Pressure and overlap accumulation: thinning, squeezing, and local beads must explain how the mass meets the canvas and neighboring paint.
4. Bristle clumps and grooves: these may modulate the macro mass, but must not replace it.
5. Fine hairs and crumbs: these are final-scale evidence only and must remain sparse.

Approximate contribution budgets for a fully loaded stroke are:

- Contact film: `2-5%` of authored stroke height.
- Macro paste mass: `70-90%` of authored stroke height.
- Bristle and groove modulation: `8-18%` of local body height.
- Edge and cap accumulation: `8-25%` of local body height.
- Fine hairs and crumbs: less than `3%` of authored stroke height.

If bristle modulation becomes the most visible feature, the hierarchy has failed regardless of how detailed the normal map appears.

## Features to omit

- Omit all global lane indices, fixed lane pitch, and one-tuft-per-bin strategies.
- Omit any texture that spans the entire stroke with constant width and spacing.
- Omit a full-height flat cross-section across the complete brush width.
- Omit a complete perimeter lip and bilaterally symmetric cap bead.
- Omit cap tears at frequencies above `2 cycles/mm` in the close-up scale.
- Omit sub-pixel detail below roughly `0.24 mm` at the current `0.12 mm` pixel scale.
- Omit isotropic 2D noise as a substitute for bristle structure.
- Omit crumbs and detached flecks from the first implementation pass.
- Omit visually uniform film thickness across the entire contact patch.
- Do not use lighting, pigment noise, or normal-map contrast to hide a weak silhouette.

## Physical coordinate contract

Work entirely in stroke-local millimetres.

| Quantity | Definition | Close-up starting range |
| --- | --- | --- |
| `s` | Arc length along the stroke | `0` to `L` |
| `q` | Signed distance across the stroke | `-W/2` to `W/2` |
| `W` | Brush width | `12-18.5 mm` for major marks |
| `L` | Arc length | Derived from `arcLengthPx * pixelMm` |
| `pixelMm` | Canvas sampling scale | `0.12 mm/px` |
| Macro mass half-length | Gaussian radius along stroke | `2-7 mm` |
| Macro mass half-width | Gaussian radius across stroke | `1.0-4.5 mm` |
| Pressure feature length | Broad load change along stroke | `8-25 mm` |
| Broad tuft half-width | Across-stroke clump radius | `0.12-0.38 mm` |
| Broad tuft half-length | Along-stroke clump radius | `1.0-4.5 mm` |
| Fine hair half-width | Across-stroke hair radius | `0.08-0.18 mm` |
| Fine hair half-length | Along-stroke hair radius | `0.5-2.5 mm` |
| Edge lip width | Gaussian meniscus half-width | `0.10-0.22 mm` |
| Edge lip depth | Fraction of local body height | `0.10-0.28` |
| Flat cap skew | Across-width end slant | `0.04-0.13 * W` |
| Filbert cap recession | Extra edge recession at cap | `0.45-0.68 * W/2` |
| Filbert cap projection | Center beyond shoulders | `3-5 mm` for a `16 mm` brush |

The current internal pixel scale resolves roughly two samples per `0.24 mm`.

Features smaller than that should be expressed through antialiased coverage or subtle sub-pixel slope, not through hard rail geometry.

## Proposed algorithm

### A. Build the footprint from two independent edge curves

Keep the current one-dimensional edge curve approach because it avoids stair-stepped shadows.

Replace the many threshold crossings from noise with a smooth broad wobble plus zero to two discrete bites per side.

Use frequencies no higher than about `0.30 cycles/mm` for the most detailed edge wobble.

A discrete bite should have a Gaussian width of `0.8-2.8 mm` and a depth of `0.15-0.55 mm`.

This produces occasional torn sections instead of a dotted boundary.

The height coverage should remain inset relative to the color coverage by `0.25-0.50 mm`, so the color edge can be crisp while the paste volume rises into a meniscus.

### B. Make the cap physically different for flat and filbert brushes

The cap boundary must recede in millimetres as a function of normalized cross-position.

For a flat brush, use a skewed chisel line with a small crown.

The skew should shift one corner by roughly `4-13%` of the brush width.

The cap should have one deep notch or torn corner, not a regularly scalloped edge.

For a filbert brush, use an elliptical recession whose depth at the side edge is roughly half the brush half-width.

For a `16 mm` brush, the center should project about `3-5 mm` farther than the shoulders.

Add low-frequency tears of `0.15-0.45 mm` along the cap boundary.

The flat and filbert cases must remain distinguishable in the color view before lighting is applied.

### C. Build the body from discrete macro paste parcels

Replace the near-constant cross-section with a small set of irregular elliptical load parcels.

Use four to seven candidate parcels in stroke-local coordinates.

Each parcel has an independent along-center, across-center, half-length, half-width, amplitude, and cross-axis drift.

Take the maximum of the parcel falloffs rather than summing an unlimited field.

This preserves gaps and pinched areas instead of accumulating into a uniform slab.

Parcel centers should be distributed by hash, not by a regular grid.

Multiply the parcel field by a low-frequency pressure curve of period `8-25 mm`.

Keep a thin contact film of only `2-5%` of authored height so the stroke still contacts the canvas between loaded parcels.

For a flat brush, use a broad crown with a slight across-axis tilt.

For a filbert brush, use a rounded cross-section, but still allow the macro parcels to break its symmetry.

### D. Generate finite bristle clumps, not lanes

Generate a fixed set of candidate tuft capsules with seeded centers distributed uniformly over the stroke-local rectangle.

Do not derive one tuft from every across-axis integer.

Do not use a shared across-axis pitch.

Each tuft should have:

- An independent center along the stroke.
- An independent center across the stroke.
- A half-length of `1.0-4.5 mm`.
- A half-width of `0.12-0.38 mm`.
- A slight lateral drift along its length.
- An amplitude drawn from a squared random distribution so most tufts are weak.
- A Gaussian or smooth capsule falloff.

Combine tufts with `max`, not sum, so overlapping candidates form one broad clump rather than an increasingly tall uniform ridge.

Gate tuft visibility with a separate low-frequency 2D field.

This creates clustered bristle zones separated by smoother paint.

Add fine hairs only inside existing broad tufts.

Fine hairs should be the same kind of finite capsule at `0.08-0.18 mm` half-width and should affect no more than `2-3%` of the local height.

The resulting relief should contain long interruptions, split ridges, and smooth patches.

A single visible groove should rarely span more than `65%` of the stroke length.

### E. Accumulate paint at local lips and cap shoulders

Compute a meniscus band from distance to the contact edge.

Gate that band with a low-frequency 2D field along and across the stroke.

Use different side phases so the two sides do not accumulate in sync.

Drive lip amplitude from local macro mass and pressure, not from a constant edge term.

Allow only one or two substantial lip runs per side.

Add a separate cap accumulation term inside the end boundary.

Place cap accumulation on one shoulder more strongly than the other.

This should form a squeezed bead or corner pile, not a complete loop around the stroke.

For strokes crossing existing raised paint, the height pass may add a small spill term where the new contact line crosses an elevated bed.

That spill must be local and must not reintroduce neighborhood averaging across the whole stroke.

### F. Add micro evidence last

Use sparse crumb blobs only after the macro mass, clumps, lips, and caps pass visual review.

Limit crumbs to the late half of the stroke and to loaded areas.

Use blobs of `0.15-0.50 mm` rather than a high-frequency noise threshold across the whole body.

## WGSL-ready pseudocode

The following functions are intended to replace the current body, streak, lip, and cap calculations inside `paintField()`.

They assume the existing helpers `hash21`, `valueNoise1D`, `valueNoise2D`, `fbm1D`, and `fbm2D`.

They assume the existing `StrokeSpace` fields and the existing `PaintField` return shape.

```wgsl
fn edgeInsetV2(space: StrokeSpace, seed: f32, side: f32) -> f32 {
  let salt = 31.0 + side * 43.0;
  let wobble = fbm1D(space.alongMm * 0.055 + seed * 0.011 + salt, seed + salt) - 0.5;
  let drag = valueNoise1D(space.alongMm * 0.28 + salt * 1.7, seed + salt + 7.0) - 0.5;
  let wobbleMm = clamp(space.widthMm * 0.045, 0.15, 0.80);
  let dragMm = clamp(space.widthMm * 0.012, 0.05, 0.22);
  var bitesMm = 0.0;

  for (var k = 0u; k < 2u; k += 1u) {
    let fk = f32(k);
    let center = space.lengthMm * mix(0.12, 0.88, hash21(vec2<f32>(fk + 3.0, seed + salt)));
    let halfSpan = mix(0.8, 2.8, hash21(vec2<f32>(fk + 11.0, seed + salt + 2.0)));
    let enabled = hash21(vec2<f32>(fk + 19.0, seed + salt + 4.0)) > 0.42;
    let depth = mix(0.15, 0.55, hash21(vec2<f32>(fk + 29.0, seed + salt + 6.0)));
    let bite = select(0.0, depth, enabled);
    bitesMm = max(bitesMm, bite * exp(-pow((space.alongMm - center) / halfSpan, 2.0) * 1.5));
  }

  return max(0.04, 0.10 + wobble * wobbleMm + drag * dragMm + bitesMm);
}

fn capInsetV2(space: StrokeSpace, seed: f32, endId: f32, flatMask: f32) -> f32 {
  let halfW = max(space.halfWidthMm, 0.001);
  let q = clamp(abs(space.acrossMm) / halfW, 0.0, 1.0);
  let v = clamp(space.acrossMm / halfW, -1.0, 1.0);
  let salt = select(17.0, 59.0, endId > 0.5);
  let r0 = hash21(vec2<f32>(seed + salt, endId + 2.1));
  let r1 = hash21(vec2<f32>(seed + salt * 1.7, endId + 7.3));
  let skewSign = select(-1.0, 1.0, r0 > 0.5);
  let roundMask = sqrt(max(0.0, 1.0 - q * q));

  let filbertShape = halfW * mix(0.45, 0.68, r1) * (1.0 - roundMask);
  let flatShape = halfW * 0.035 * (1.0 - q * q)
    + skewSign * v * halfW * mix(0.04, 0.13, r1);

  let broadTear = (valueNoise1D(space.acrossMm * 0.75 + salt, seed + salt + 13.0) - 0.5) * 0.42;
  let smallTear = (valueNoise1D(space.acrossMm * 1.80 + salt * 0.5, seed + salt + 17.0) - 0.5) * 0.13;
  let tear = broadTear + smallTear;

  let base = mix(0.32 + 0.36 * r1, 0.24 + 0.44 * r1, flatMask);
  let shape = mix(filbertShape, flatShape, flatMask);
  return max(0.0, base + shape + tear);
}

struct MassSample {
  pressure: f32,
  mass: f32,
  cross: f32,
};

fn macroMassV2(space: StrokeSpace, seed: f32, flatMask: f32, qN: f32) -> MassSample {
  let halfW = max(space.halfWidthMm, 0.001);
  let pressure = clamp(
    0.58
      + (fbm1D(space.alongMm * 0.052 + seed * 0.011, seed + 9.0) - 0.5) * 0.62
      + (valueNoise1D(space.alongMm * 0.015 + seed * 0.007, seed + 21.0) - 0.5) * 0.20,
    0.42,
    1.06,
  );

  var mass = 0.10 + 0.10 * pressure;

  for (var i = 0u; i < 6u; i += 1u) {
    let fi = f32(i);
    let alongCenter = space.lengthMm * mix(0.06, 0.94, hash21(vec2<f32>(fi + 3.0, seed + 71.0)));
    let acrossCenter = (hash21(vec2<f32>(fi + 17.0, seed + 73.0)) * 2.0 - 1.0) * halfW * 0.64;
    let halfAlong = mix(2.0, 7.0, hash21(vec2<f32>(fi + 31.0, seed + 79.0)));
    let halfAcross = mix(1.0, halfW * 0.56, hash21(vec2<f32>(fi + 47.0, seed + 83.0)));
    let amplitude = mix(0.30, 0.88, hash21(vec2<f32>(fi + 59.0, seed + 89.0)));
    let drift = (hash21(vec2<f32>(fi + 67.0, seed + 97.0)) - 0.5) * 0.55;
    let acrossAt = acrossCenter + drift * (space.alongMm - alongCenter);
    let d = vec2<f32>(
      (space.alongMm - alongCenter) / halfAlong,
      (acrossAt - space.acrossMm) / halfAcross,
    );
    let parcel = amplitude * exp(-dot(d, d) * 1.7);
    mass = max(mass, parcel);
  }

  let patch = fbm2D(
    vec2<f32>(space.alongMm * 0.14, space.acrossMm * 0.30) + vec2<f32>(seed * 0.013, seed * 0.017),
    seed + 337.0,
  );
  let cross = mix(
    0.54 + 0.46 * sqrt(max(0.0, 1.0 - qN * qN)),
    0.86 + 0.14 * (1.0 - qN * qN),
    flatMask,
  );

  var result: MassSample;
  result.pressure = pressure * (0.92 + (patch - 0.5) * 0.20);
  result.mass = clamp(mass, 0.0, 1.15);
  result.cross = cross;
  return result;
}

fn tuftFieldV2(space: StrokeSpace, seed: f32, mass: f32, qN: f32) -> vec2<f32> {
  let halfW = max(space.halfWidthMm, 0.001);
  let warp = (fbm2D(
    vec2<f32>(space.alongMm * 0.030, space.acrossMm * 0.12),
    seed + 401.0,
  ) - 0.5) * 0.60;
  let qWarped = space.acrossMm + warp;
  let zone = fbm2D(
    vec2<f32>(space.alongMm * 0.055, qN * 0.52) + vec2<f32>(seed * 0.019, seed * 0.023),
    seed + 409.0,
  );
  let zoneGate = smoothstep(0.40, 0.72, zone) * smoothstep(0.18, 0.55, mass);
  var ridges = 0.0;
  var hairs = 0.0;

  for (var i = 0u; i < 12u; i += 1u) {
    let fi = f32(i);
    let alongCenter = space.lengthMm * mix(0.03, 0.97, hash21(vec2<f32>(fi + 3.0, seed + 501.0)));
    let acrossCenter = (hash21(vec2<f32>(fi + 11.0, seed + 503.0)) * 2.0 - 1.0) * halfW * 0.86;
    let halfAlong = mix(1.0, 4.5, hash21(vec2<f32>(fi + 19.0, seed + 509.0)));
    let halfAcross = mix(0.12, 0.38, hash21(vec2<f32>(fi + 29.0, seed + 521.0)));
    let randomAmp = hash21(vec2<f32>(fi + 37.0, seed + 523.0));
    let amplitude = mix(0.018, 0.13, randomAmp * randomAmp);
    let drift = (hash21(vec2<f32>(fi + 43.0, seed + 541.0)) - 0.5) * 1.20;
    let acrossAt = acrossCenter + drift * (space.alongMm - alongCenter) / max(space.lengthMm, 0.001);
    let d = vec2<f32>(
      (space.alongMm - alongCenter) / halfAlong,
      (qWarped - acrossAt) / halfAcross,
    );
    ridges = max(ridges, amplitude * exp(-dot(d, d) * 1.7));
  }

  for (var i = 0u; i < 10u; i += 1u) {
    let fi = f32(i);
    let alongCenter = space.lengthMm * mix(0.05, 0.95, hash21(vec2<f32>(fi + 5.0, seed + 601.0)));
    let acrossCenter = (hash21(vec2<f32>(fi + 13.0, seed + 607.0)) * 2.0 - 1.0) * halfW * 0.76;
    let halfAlong = mix(0.5, 2.5, hash21(vec2<f32>(fi + 23.0, seed + 613.0)));
    let halfAcross = mix(0.08, 0.18, hash21(vec2<f32>(fi + 31.0, seed + 617.0)));
    let amplitude = mix(0.002, 0.018, hash21(vec2<f32>(fi + 41.0, seed + 619.0)));
    let d = vec2<f32>(
      (space.alongMm - alongCenter) / halfAlong,
      (qWarped - acrossCenter) / halfAcross,
    );
    hairs = max(hairs, amplitude * exp(-dot(d, d) * 1.8));
  }

  return vec2<f32>(ridges * zoneGate, hairs * zoneGate);
}

fn lipFieldV2(
  space: StrokeSpace,
  seed: f32,
  side: f32,
  edgeDepth: f32,
  alongEnd: f32,
  body: f32,
  mass: f32,
  pressure: f32,
) -> f32 {
  let lipCenter = 0.16 + hash21(vec2<f32>(seed, 211.0 + side)) * 0.12;
  let lipWidth = 0.10 + hash21(vec2<f32>(seed, 223.0 + side)) * 0.12;
  let edgeBand = exp(-pow((max(0.0, edgeDepth) - lipCenter) / lipWidth, 2.0) * 1.5);
  let sidePhase = select(0.0, 23.0, side > 1.5);
  let sideGate = smoothstep(
    0.44,
    0.74,
    fbm2D(
      vec2<f32>(space.alongMm * 0.080 + sidePhase, space.acrossMm * 0.16),
      seed + 631.0 + side,
    ),
  );
  let sideAmount = select(0.72, 1.0, side > 1.5);
  let rim = body * edgeBand * sideGate * sideAmount * smoothstep(0.20, 0.72, mass) * pressure;

  let capBand = exp(-pow(max(0.0, alongEnd - 0.24) / 0.34, 2.0));
  let capChunks = smoothstep(
    0.30,
    0.75,
    valueNoise1D(space.acrossMm * 0.62 + sidePhase, seed + 641.0 + side),
  );
  let capPile = body * capBand * capChunks * 0.22 * pressure;
  return rim * 0.20 + capPile;
}
```

## Integration into `paintField()`

The replacement flow should be ordered as follows.

1. Compute `edgeInsetV2`, `capInsetV2`, `edgeDepth`, `alongStart`, and `alongEnd`.
2. Build color `coverage` and wider `heightCoverage` masks from those values.
3. Compute `qN = clamp(v, -1.0, 1.0)` in normalized across coordinates.
4. Compute `macro = macroMassV2(space, seed, flatMask, qN)`.
5. Compute `body = heightCoverage * macro.cross * macro.mass * macro.pressure`.
6. Compute `tufts = tuftFieldV2(space, seed, macro.mass, qN)`.
7. Compute a normalized clump mask from `tufts.x` and use it for only `8-18%` height modulation around the body.
8. Add fine hairs only where the broad clump mask is already positive.
9. Compute `lip = lipFieldV2(...)` from local `body`, `mass`, `pressure`, and `edgeDepth`.
10. Add a thin film of `0.02-0.05` normalized height, not a second full body.
11. Return `relief = heightCoverage * max(0.0, film + body + ridgeRelief + lip)`.

The final normalized relief multiplier should remain near `0.85-1.10` in fully loaded regions, so authored stroke heights retain their current physical meaning.

## Calibration targets

### Flat end

- The cap should meet one corner earlier than the other.
- The end line should slope by `0.5-2.0 mm` across a typical `16 mm` brush.
- One notch of `0.3-0.7 mm` should interrupt the line.
- The cap may be slightly crowned but must not become a rounded filbert.

### Filbert end

- The center of the paint boundary should project `3-5 mm` beyond the shoulders on a `16 mm` brush.
- The shoulder transition should be convex and asymmetric.
- No more than one shoulder should carry the strongest cap pile.
- The arch should still contain one broad tear or uneven recession.

### Bristle structure

- A `16 mm` stroke should show roughly `2-5` clump groups across its width, not `20-30` equal rails.
- At least `30%` of the width should contain interrupted, faint, or smooth paint.
- Individual grooves should vary in width by at least a factor of two.
- Individual grooves should terminate, split, or fade over the stroke.
- No single groove family should dominate every stroke at the same cadence.

### Paint accumulation

- Each side should have one or two prominent lip runs separated by thin or smooth contact.
- Lip strength should correlate with macro mass, not exist uniformly around the footprint.
- Cap accumulation should be concentrated at a shoulder or corner.
- The paint should visibly thin between loaded parcels.

## Validation plan

- Render the close-up in paint, color, height, and normal views using the existing capture harness.
- Inspect at full resolution and in a `500-700 px` crop around each flat and filbert end.
- Compare the normal view at grazing light against `/tmp/stroke-audit/ref-brush-crop.jpg`.
- Compare the torn edges and menisci against `/tmp/stroke-audit/ref-montcarta-crop.jpg`.
- Reject the result if a transverse comb survives at more than one lighting azimuth.
- Reject the result if the top-down color view alone cannot distinguish flat from filbert ends.
- Reject the result if a stroke's body height is visually flat for more than half its length.
- Reject the result if cap tears read as regular saw teeth or isolated dots.

## Verified versus inferred summary

Verified from source and images:

- The current body is a smooth full-footprint mass with thin film.
- The current bristle field is three summed longitudinal ridge families.
- The current cap recession is too small relative to brush half-width.
- The current lip is a Gaussian side-edge band with along-stroke breakup.
- The r7 normal and height captures show regular corduroy and plate-like bodies.
- The references contain irregular clump structure, torn edges, and stronger local menisci.

Inferred and requiring render validation:

- The proposed mm ranges for parcels, tufts, lips, and caps will read correctly at the current close-up scale.
- A capped random tuft field will eliminate the comb without looking like random noise.
- A filbert cap recession of `45-68%` of half-width will read as a rounded loaded end rather than a cut semicircle.
- One to two edge bite events per side will read as torn paint rather than damage.
- The contribution budgets will preserve the authored stroke heights.

## Changed files

- `review/stroke-relief-study.md`
