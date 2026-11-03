# V7 lighting and pigment audit

## Scope and evidence

This audit covers lighting and pigment variation only.
It does not modify `src`.

Reviewed evidence:

- `/tmp/closeup-r25-paint.png`
- `/tmp/closeup-r25-normal.png`
- `/tmp/closeup-r25-height.png`
- `/tmp/closeup-r25-color.png`
- `/tmp/ref-impasto-montcarta.jpg`
- `/tmp/ref-impasto-paolo.jpg`
- `/tmp/ref-brushstrokes.jpg`

The supplied r25 set contained paint and normal, but no height file.
I captured the missing height and color views from the unchanged live r25 source at `/tmp/closeup-r25-height.png` and `/tmp/closeup-r25-color.png`.
No source file was changed for those captures.

The current source still uses `paintFieldV6`, `ridgeMassV6`, and `bristleReliefV5`.
This audit therefore treats r25 as the last rail-based geometry and asks which shader behavior must change before finite tufts replace those rails.

## Findings

### The height field is still a rail field

The height view is a set of continuous parallel swells with shallow lateral connections.
The normal view turns each swell into a long colored rail.
The paint view then places a narrow specular bead on many of those rails.

This is not only a geometry problem.
Two shader-side systems currently reinforce the same longitudinal pattern:

- `colorField` mixes pigment with a one-dimensional across-stroke lane.
- `colorField` also tints pigment from `field.ridges`, which is the rail relief itself.
- `lightingFragment` uses one narrow window lobe, so rail normals produce repeated small reflections.
- The one-pixel `valley` term accents every narrow rail gap instead of tuft-scale depressions.

Those cues will survive a geometry replacement unless they are removed or broken up.
A tuft geometry shaded with the current color and lighting model will still show colored and glossy rails.

### Pigment is nearly flat in the color view

The color view has little broad mottling or thickness-dependent mixing.
Most focal strokes sit near full `bodyDepth`, so their saturation and value multipliers are effectively constant.
The remaining visible variation is mostly the one-dimensional lane signal, which is the wrong signal for finite tufts.

The references show irregular pigment concentration, small warm and cool shifts, and local mixtures.
They do not show a continuous colored stripe following every brush groove.

### The coat is too point-like for wet oil

The current clearcoat uses:

- `coatRoughness` from `0.20` to `0.46`
- `coatKey` energy of `1.35`
- a single `pow(dot(reflectionDirection, windowDirection), 5.0)` window lobe

That combination creates small, high-intensity beads wherever a rail normal crosses the half-vector or window direction.
The references instead show broad, connected reflections over crowns, folds, and menisci, with only a few sharper white peaks.

Reducing only the reflection intensity would make the paint matte.
The lobe needs to become broader and more area-like while retaining a restrained sharp core.

### Cavity shading is too fine-grained

The current `valley` measure compares the center sample with immediate neighbors.
It therefore emphasizes each narrow groove as a separate line.
For finite tufts, cavity should primarily describe the larger depression between tuft clusters, with fine cavity only as a small secondary term.

### Contact shadows are acceptable, but they need a softer transition

The dark troughs in r25 are mostly real geometry and directional shading.
The large dark arc is an authored dark stroke, not a lighting cutout.
Still, the contact shadow transition can produce hard charcoal cracks around newly separated tufts.
The shadow should remain physical and stay tied to the shared height field, but its penumbra should be a little wider.

## Reference comparison

### `/tmp/ref-impasto-montcarta.jpg`

The montcarta reference has broad white and lavender reflections over rounded paint crowns.
Those reflections flow across a whole ridge or fold and break only where the surface tears or changes direction.
The r25 paint view instead puts small bright beads along many parallel rails.
The montcarta shadows are also chromatic and slightly transparent at the edges, while r25 narrow grooves tend toward neutral charcoal.

### `/tmp/ref-impasto-paolo.jpg`

The Paolo reference has a strong central highlight, but it is a continuous wet sheet over an irregular orange ridge.
The highlight changes width with the underlying mass and includes a few brighter local peaks.
The r25 highlight has similar intensity but much smaller spatial support, so it reads as a repeated point light on each rail.

### `/tmp/ref-brushstrokes.jpg`

The brushstrokes reference contains many fine bristle structures, yet adjacent grooves do not each receive an equal highlight.
The sheen is broad, low contrast, and interrupted by pigment variation and uneven paint load.
The r25 normal map shows equal-weight rail normals, and the paint view confirms a repeating highlight response on nearly every rail.

### Pigment comparison

The references show local warm and cool dispersion and uneven pigment concentration.
These changes form irregular patches and small flecks rather than a continuous stripe.
The r25 color view is much flatter, while its one-dimensional lane signal is the only strong directional color cue.

## Recommended pigment revision

Replace `colorField` with this exact function.
It removes `field.ridges` from the pigment path, breaks the lane signal into patches, and adds broad and fine two-dimensional mixing.

```wgsl
fn colorField(uv: vec2<f32>, field: PaintField) -> vec3<f32> {
  let space = strokeSpace(uv);
  let seed = stroke.pigment.w;

  let warp = vec2<f32>(
    fbm2D(
      vec2<f32>(space.alongMm * 0.041, space.acrossMm * 0.093),
      seed + 157.0,
    ) - 0.5,
    fbm2D(
      vec2<f32>(space.alongMm * 0.057, space.acrossMm * 0.071),
      seed + 163.0,
    ) - 0.5,
  ) * vec2<f32>(1.55, 0.72);

  let broadMix = fbm2D(
    vec2<f32>(space.alongMm * 0.105, space.acrossMm * 0.175) + warp,
    seed + 127.0,
  ) - 0.5;
  let patchMix = fbm2D(
    vec2<f32>(space.alongMm * 0.31, space.acrossMm * 0.46) + warp * 0.64,
    seed + 139.0,
  ) - 0.5;
  let granule = valueNoise2D(
    vec2<f32>(space.alongMm * 1.75, space.acrossMm * 2.15)
      + vec2<f32>(seed * 0.031, seed * 0.017),
  ) - 0.5;

  let laneSignal = valueNoise1D(
    space.acrossMm * 1.35 + warp.x * 1.8,
    seed + 149.0,
  ) - 0.5;
  let laneBreak = smoothstep(
    0.40,
    0.68,
    fbm2D(
      vec2<f32>(space.alongMm * 0.14, space.acrossMm * 0.23) + warp * 0.35,
      seed + 153.0,
    ),
  );
  let laneMix = laneSignal * laneBreak;

  let authoredMm = max(field.relief * stroke.document.w, 0.0001);
  let bodyDepth = smoothstep(0.06, 1.30, authoredMm);

  let valueShift =
    broadMix * 0.072
    + patchMix * 0.026
    + granule * 0.008
    + laneMix * 0.006;
  let chroma =
    broadMix * 0.020
    + patchMix * 0.010
    + granule * 0.004
    + laneMix * 0.006;

  var pigment = stroke.pigment.rgb;
  pigment += vec3<f32>(
    valueShift + chroma,
    valueShift - chroma * 0.35,
    valueShift - chroma * 0.72,
  );

  let luma = dot(pigment, vec3<f32>(0.2126, 0.7152, 0.0722));
  let saturation = mix(0.92, 1.075, bodyDepth);
  pigment = mix(vec3<f32>(luma), pigment, saturation);
  pigment *= mix(1.025, 0.975, bodyDepth);

  let dispersion = broadMix * patchMix;
  pigment += vec3<f32>(0.006, 0.001, -0.006) * dispersion * 4.0;

  return srgbToLinear(clamp(
    pigment,
    vec3<f32>(0.0),
    vec3<f32>(1.0),
  ));
}
```

Expected effects:

- The color view gains visible but low-frequency pigmentation differences.
- Continuous longitudinal pigment lanes disappear.
- Thick marks become slightly denser and more chromatic while thin films remain lighter and less saturated.
- No pigment contour is drawn around a tuft, so geometry remains the source of edge and relief definition.

## Recommended lighting revision

### 1. Broaden the clearcoat and restrain its peak

Replace the roughness and specular-energy lines with this version:

```wgsl
let coatRoughness = clamp(
  mix(0.26, 0.52, clamp(params.light.z, 0.0, 1.0)),
  0.24,
  0.54,
);
let coatAlpha = max(
  0.0050,
  coatRoughness * coatRoughness,
);

let coatKey = select(
  0.0,
  coatBrdf * noL * 1.02,
  noL > 0.0,
);

let paintKey = select(
  0.0,
  paintBrdf * noL * 0.46,
  noL > 0.0,
);
```

The wider coat spreads highlight energy over rounded tufts.
The reduced sharp core removes the metallic bead effect.
The stronger binder lobe retains an oil-like sheen between sharp highlights.

### 2. Replace the point window with a soft area window

Replace the current reflection block from `windowDirection` through `environment` with this exact block:

```wgsl
let windowDirection = normalize(vec3<f32>(
  cos(az) * 0.82,
  sin(az) * 0.82,
  0.70,
));
let windowCos = clamp(
  dot(reflectionDirection, windowDirection),
  0.0,
  1.0,
);
let windowBroad = smoothstep(0.38, 0.94, windowCos);
let windowCore = smoothstep(0.92, 0.998, windowCos);
let windowLobe = windowBroad * 0.46 + windowCore * 0.34;
let fresnelNoV = fresnel0
  + (1.0 - fresnel0) * pow(1.0 - noV, 5.0);
let environment = (
  skyReflection
  + vec3<f32>(0.15, 0.155, 0.16) * windowLobe
)
  * fresnelNoV
  * mix(0.58, 1.0, visibility);
```

The broad term covers a range of tuft orientations.
The core term preserves a smaller wet peak.
The reflection stays attached to the Sobel normal and the shared height field, so it reveals the tuft surface rather than painting a decorative sheen over it.

The slight cool tint separates environmental reflection from the warm key light.
That separation is visible in the references, where highlights are closer to neutral white while the paint shadows retain warm or chromatic color.

### 3. Add a two-scale cavity measure

Insert these samples after the existing `hDownRight` load:

```wgsl
let hWideLeft = heightAt(p + vec2<i32>(-3, 0), dims);
let hWideRight = heightAt(p + vec2<i32>(3, 0), dims);
let hWideUp = heightAt(p + vec2<i32>(0, -3), dims);
let hWideDown = heightAt(p + vec2<i32>(0, 3), dims);
```

Replace the existing cavity line with:

```wgsl
let wideMean = (
  hWideLeft + hWideRight + hWideUp + hWideDown
) * 0.25;
let wideValley = clamp(
  (wideMean - h) / max(0.001, 2.2 * mmPerPixel),
  0.0,
  1.0,
);
let cavity = 1.0
  - 0.14 * wideValley
  - 0.035 * valley;
```

This favors occlusion between tuft clusters.
It preserves real contact and undercut shading without engraving a dark outline around every narrow ridge.

### 4. Soften contact-shadow onset slightly

If the tuft geometry produces charcoal pinholes, replace the `blocker` and return clamp inside `shadowVisibility` with:

```wgsl
let blocker = 1.0 - smoothstep(
  -0.085,
  0.190,
  rayH - sampleH,
);
occlusion = max(
  occlusion,
  blocker * (1.0 - f32(i) / 12.5),
);
```

And return:

```wgsl
return clamp(1.0 - 0.38 * occlusion, 0.60, 1.0);
```

Expected effects:

- Contact under a tuft remains visibly darker than the surrounding body.
- The shadow becomes a soft penumbra rather than a one-pixel black crack.
- The cavity still follows the actual height field.

## What not to change

- Keep the Sobel normal path unchanged.
- Keep the color, height, and normal diagnostic views unchanged.
- Do not multiply the specular by `crest` or `field.ridges`, because that creates a shader-side rail accent.
- Do not add dark pigment edges at stroke boundaries.
- Do not replace the shared height field with a separate lighting-only bump.

## Expected combined result

Compared with the r25 captures:

- The normal view should remain an honest record of the new tuft geometry.
- The color view should show irregular pigment mixing without continuous lane stripes.
- The paint view should show broader connected reflections across tuft crowns instead of one bead per rail.
- Broad cavity should separate tuft clusters while narrow grooves remain subordinate.
- Dark contact regions should stay chromatic instead of becoming neutral black cuts.
- The references' wet crowns, broad meniscus reflections, and local pigment variation should become more plausible without hiding malformed geometry.

## Validation for the next render

Capture the next close-up iteration in paint, color, height, and normal.
Inspect 450 to 650 pixel crops at 1:1, not only the full frame.

Accept the iteration when:

- The color view contains no continuous colored rail.
- The paint view contains no repeating specular beads along one stroke axis.
- Highlights bend across multiple tufts and break at real gaps.
- Normal and height still agree after the lighting change.
- Moving the light through two or three azimuths reveals the same tuft forms rather than a rotating fixed band pattern.

If the surface becomes too uniformly glossy, reduce `windowBroad` first.
If the tufts lose their wet peaks, raise `windowCore` or the coat energy slightly rather than narrowing the whole lobe.

## Verification status

This was a read-only audit of source and captures.
The proposed WGSL was not applied to `src` or compiled during this audit.
