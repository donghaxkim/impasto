export const surfaceShader = /* wgsl */ `
struct StrokeParams {
  document: vec4<f32>, // canvas width, canvas height, brush width, authored height (mm)
  pigment: vec4<f32>,  // sRGB r, g, b, seed
  finish: vec4<f32>,   // roughness, brush kind (0 flat, 1 filbert), arc length (px), brush width (mm)
  metrics: vec4<f32>,  // physical canvas width (mm), pigment opacity, padding
  mixture: vec4<f32>,  // secondary pigment sRGB rgb, ribbon strength
  deposition: vec4<f32>, // profile: knife 0 / filbert 1 / scumble 2, edge ridge, taper end
};

@group(0) @binding(0) var<uniform> stroke: StrokeParams;
@group(0) @binding(1) var priorSurface: texture_2d<f32>;
@group(0) @binding(2) var priorHeight: texture_2d<f32>;

struct VertexIn {
  @location(0) position: vec2<f32>,
  @location(1) uv: vec2<f32>,
};

struct VertexOut {
  @builtin(position) clipPosition: vec4<f32>,
  @location(0) uv: vec2<f32>,
};

@vertex
fn surfaceVertex(input: VertexIn) -> VertexOut {
  var out: VertexOut;
  let x = input.position.x / stroke.document.x * 2.0 - 1.0;
  let y = 1.0 - input.position.y / stroke.document.y * 2.0;
  out.clipPosition = vec4<f32>(x, y, 0.0, 1.0);
  out.uv = input.uv;
  return out;
}

fn hash21(p: vec2<f32>) -> f32 {
  let q = fract(vec3<f32>(p.xyx) * 0.1031);
  let r = q + vec3<f32>(dot(q, q.yzx + vec3<f32>(33.33)));
  return fract((r.x + r.y) * r.z);
}

fn valueNoise1D(x: f32, seed: f32) -> f32 {
  let cell = floor(x);
  let f = x - cell;
  let s = f * f * (3.0 - 2.0 * f);
  let a = hash21(vec2<f32>(cell, seed * 0.137));
  let b = hash21(vec2<f32>(cell + 1.0, seed * 0.137));
  return mix(a, b, s);
}

fn valueNoise2D(p: vec2<f32>) -> f32 {
  let i = floor(p);
  let f = fract(p);
  let s = f * f * (vec2<f32>(3.0) - 2.0 * f);
  let a = hash21(i);
  let b = hash21(i + vec2<f32>(1.0, 0.0));
  let c = hash21(i + vec2<f32>(0.0, 1.0));
  let d = hash21(i + vec2<f32>(1.0, 1.0));
  return mix(mix(a, b, s.x), mix(c, d, s.x), s.y);
}

fn fbm1D(x: f32, seed: f32) -> f32 {
  var sum = 0.0;
  var amplitude = 0.5;
  var frequency = 1.0;
  for (var octave = 0; octave < 3; octave += 1) {
    sum += amplitude * valueNoise1D(x * frequency, seed + f32(octave) * 37.0);
    amplitude *= 0.5;
    frequency *= 2.0;
  }
  return sum;
}

fn fbm2D(p: vec2<f32>, seed: f32) -> f32 {
  let offset = vec2<f32>(seed * 0.071, seed * 0.113);
  var sum = 0.0;
  var amplitude = 0.53;
  var frequency = 1.0;
  for (var octave = 0; octave < 3; octave += 1) {
    sum += amplitude * valueNoise2D(p * frequency + offset + vec2<f32>(f32(octave) * 19.7));
    amplitude *= 0.47;
    frequency *= 2.03;
  }
  return sum;
}

fn srgbToLinear(c: vec3<f32>) -> vec3<f32> {
  let lo = c / 12.92;
  let hi = pow((c + vec3<f32>(0.055)) / 1.055, vec3<f32>(2.4));
  return select(lo, hi, c > vec3<f32>(0.04045));
}

struct StrokeSpace {
  alongMm: f32,
  acrossMm: f32,
  halfWidthMm: f32,
  lengthMm: f32,
  widthMm: f32,
  pixelMm: f32,
};

struct PaintField {
  coverage: f32,
  heightCoverage: f32,
  relief: f32,
  ridges: f32,
  edgeLip: f32,
  body: f32,
  pickupScrape: f32,
};

fn strokeSpace(uv: vec2<f32>) -> StrokeSpace {
  let dims = max(stroke.document.xy, vec2<f32>(1.0));
  let pixelMm = max(stroke.metrics.x, 0.001) / max(dims.x, dims.y);
  let widthMm = max(stroke.finish.w, 0.1);
  let lengthMm = max(stroke.finish.z * pixelMm, widthMm);
  var space: StrokeSpace;
  space.alongMm = clamp(uv.x, 0.0, 1.0) * lengthMm;
  space.acrossMm = clamp(uv.y, -1.0, 1.0) * widthMm * 0.5;
  space.halfWidthMm = widthMm * 0.5;
  space.lengthMm = lengthMm;
  space.widthMm = widthMm;
  space.pixelMm = pixelMm;
  return space;
}

fn ridge1D(x: f32, seed: f32) -> f32 {
  // A zero set in a one-dimensional noise field forms irregular, finite
  // streaks rather than the evenly spaced teeth of an integer comb.
  let n = valueNoise1D(x, seed);
  return pow(1.0 - abs(n * 2.0 - 1.0), 1.55);
}

fn edgeInsetMm(space: StrokeSpace, seed: f32, flatMask: f32, side: f32) -> f32 {
  // Both contact lines are functions of distance along the stroke only. A 2D
  // noise lookup here would change the edge inset while marching across the
  // paint, producing a stair-stepped silhouette and one-pixel shadow bands.
  let salt = 31.0 + side * 43.0;
  let broad = fbm1D(space.alongMm * 0.058 + salt + seed * 0.011, seed + salt) - 0.5;
  let drag = fbm1D(space.alongMm * 0.19 + salt * 1.7 + seed * 0.019, seed + salt * 2.3) - 0.5;
  let crisp = valueNoise1D(space.alongMm * 0.72 + salt * 0.6, seed + salt * 3.7) - 0.5;
  let biteSignal = valueNoise1D(space.alongMm * 0.083 + salt * 0.31, seed + salt * 5.1);
  let amplitude = clamp(space.widthMm * 0.071, 0.22, 1.85);
  let bite = smoothstep(0.58, 0.93, biteSignal) * amplitude * (0.50 + 0.50 * crisp);
  let rag = (broad * 1.48 + drag * 0.54 + crisp * 0.17) * amplitude;
  return max(0.02, amplitude * 0.12 + rag + bite - flatMask * 0.016);
}

fn capInsetMm(space: StrokeSpace, seed: f32, flatMask: f32, startSide: f32) -> f32 {
  let q = clamp(abs(space.acrossMm) / max(space.halfWidthMm, 0.001), 0.0, 1.0);
  let v = clamp(space.acrossMm / max(space.halfWidthMm, 0.001), -1.0, 1.0);
  let round = sqrt(max(0.0, 1.0 - q * q));
  let salt = select(17.0, 59.0, startSide > 0.5);
  let load = hash21(vec2<f32>(seed + salt, startSide + 2.3));
  let broad = fbm1D(space.acrossMm * 0.48 + salt * 1.9, seed + salt) - 0.5;
  let drag = fbm1D(space.acrossMm * 1.55 + salt * 0.7, seed + salt * 3.1) - 0.5;
  let crisp = valueNoise1D(space.acrossMm * 4.2 + salt * 0.4, seed + salt * 5.7) - 0.5;
  let skew = select(-1.0, 1.0, hash21(vec2<f32>(seed + salt * 1.7, 4.9)) > 0.5);
  // A flat chisel stops on a skewed, broken line. A filbert carries a fuller
  // center and an uneven rounded arch. The small side-specific 1D tear profile
  // keeps both ends organic without making a dotted, saw-toothed boundary.
  let widthScale = clamp(space.widthMm * 0.043, 0.20, 2.15);
  let chiselSkew = skew * v * (0.12 + load * 0.36) * widthScale;
  let base = mix(0.42 + load * 0.70, 0.62 + load * 0.88, 1.0 - flatMask) * widthScale;
  let curve = mix(0.22, 2.30, 1.0 - flatMask) * widthScale * (1.0 - round);
  let tears = (broad * 0.72 + drag * 0.26 + crisp * 0.10) * widthScale;
  return max(0.0, base + chiselSkew + curve + tears);
}

fn paintField(uv: vec2<f32>) -> PaintField {
  let space = strokeSpace(uv);
  let u = clamp(uv.x, 0.0, 1.0);
  let v = clamp(uv.y, -1.0, 1.0);
  let seed = stroke.pigment.w;
  let flatMask = select(0.0, 1.0, stroke.finish.y < 0.5);
  let side = select(1.0, 2.0, v >= 0.0);
  let inset = edgeInsetMm(space, seed, flatMask, side);
  let startInset = capInsetMm(space, seed, flatMask, 0.0);
  let endInset = capInsetMm(space, seed, flatMask, 1.0);
  let edgeDepth = space.halfWidthMm - abs(space.acrossMm) - inset;
  let alongStart = space.alongMm - startInset;
  let alongEnd = space.lengthMm - space.alongMm - endInset;
  let aa = max(0.035, space.pixelMm * 0.62);
  let edgeMask = smoothstep(-aa, aa, edgeDepth);
  let startMask = smoothstep(-aa, aa, alongStart);
  let endMask = smoothstep(-aa, aa, alongEnd);
  let coverage = clamp(edgeMask * startMask * endMask, 0.0, 1.0);

  // Height uses a wider contact meniscus than pigment. Color may meet the
  // linen on a crisp edge, but paint volume has to rise over several pixels;
  // otherwise a one-pixel Sobel turns the genuine contact line into a black
  // cut-out rather than a readable squeezed edge.
  let widthBevel = mix(0.52, 0.34, flatMask) + hash21(vec2<f32>(seed, 7.1)) * 0.07;
  let endBevel = mix(1.10, 0.72, flatMask);
  let heightWidth = smoothstep(0.0, widthBevel, max(0.0, edgeDepth));
  let heightStart = smoothstep(0.0, endBevel, max(0.0, alongStart));
  let heightEnd = smoothstep(0.0, endBevel * 1.15, max(0.0, alongEnd));
  let heightCoverage = clamp(heightWidth * heightStart * heightEnd, 0.0, 1.0);

  // The brush does not lay a mathematically complete sheet. A persistent thin
  // film marks the contact patch, while a domain-warped macro mass field
  // decides where a loaded brush leaves a raised body. The warp is in millimetres,
  // so mass boundaries remain broad relative to bristle grooves.
  let warpX = fbm2D(vec2<f32>(space.alongMm * 0.034, space.acrossMm * 0.072), seed + 401.0) - 0.5;
  let warpY = fbm2D(vec2<f32>(space.alongMm * 0.043, space.acrossMm * 0.088), seed + 409.0) - 0.5;
  let warp = vec2<f32>(warpX * 2.30, warpY * 1.35);
  let massNoise = fbm2D(vec2<f32>(space.alongMm * 0.052, space.acrossMm * 0.125) + warp, seed + 331.0);
  let patchNoise = fbm2D(vec2<f32>(space.alongMm * 0.145, space.acrossMm * 0.31) + warp * 0.65, seed + 337.0);
  let heapNoise = fbm2D(vec2<f32>(space.alongMm * 0.205, space.acrossMm * 0.39) + warp * 0.90, seed + 341.0);
  let recessNoise = fbm2D(vec2<f32>(space.alongMm * 0.115, space.acrossMm * 0.245) + warp * 1.20, seed + 343.0);
  let pressure = 0.73 + fbm1D(space.alongMm * 0.061 + seed * 0.011, seed + 9.0) * 0.48;
  let pressurePatch = 0.92 + (patchNoise - 0.5) * 0.22;
  let mass = smoothstep(0.27, 0.78, massNoise * 0.78 + patchNoise * 0.22);
  let heaps = smoothstep(0.51, 0.76, heapNoise) * 0.20;
  let recesses = smoothstep(0.60, 0.84, recessNoise) * 0.12;
  // A loaded brush leaves a broad, comparatively level paste shelf. Most of
  // the visible sculpture comes from its broken edge, tracked hairs, and the
  // local heaps and scrape valleys, not from a smooth sinusoidal wave running
  // across the complete mark.
  let massBody = 0.83 + mass * 0.17 + heaps - recesses;
  let crossProfile = mix(
    0.64 + 0.36 * sqrt(max(0.0, 1.0 - v * v)),
    0.95 + 0.05 * (1.0 - v * v),
    flatMask,
  );
  let acrossTilt = 1.0 + (valueNoise1D(space.alongMm * 0.031 + seed * 0.017, seed + 101.0) - 0.5) * v * 0.32;
  let body = heightWidth * crossProfile * massBody * pressure * pressurePatch * acrossTilt;

  // Three independent anisotropic streak families provide the low-amplitude
  // drag texture. Their coordinates drift along the stroke and their lifetimes
  // are gated by unrelated noise, so they do not share a spatial period.
  let streakWarp = (fbm1D(space.alongMm * 0.037 + seed * 0.013, seed + 301.0) - 0.5) * 2.10;
  let fineWarp = (fbm1D(space.alongMm * 0.071 + seed * 0.029, seed + 307.0) - 0.5) * 1.15;
  let coarsePhase = space.acrossMm * 0.47 + streakWarp + (valueNoise1D(space.alongMm * 0.023 + seed * 0.019, seed + 311.0) - 0.5) * 1.55;
  let bristlePhase = space.acrossMm * 1.08 - streakWarp * 0.66 + fineWarp + space.alongMm * 0.0067;
  let hairPhase = space.acrossMm * 2.74 + fineWarp * 1.85 - space.alongMm * 0.011;
  let coarseStreak = ridge1D(coarsePhase, seed + 313.0);
  let bristleStreak = ridge1D(bristlePhase, seed + 317.0);
  let hairStreak = ridge1D(hairPhase, seed + 323.0);
  let streakLife = smoothstep(0.24, 0.76, fbm2D(vec2<f32>(space.alongMm * 0.042, space.acrossMm * 0.17), seed + 329.0));
  let hairLife = smoothstep(0.34, 0.80, fbm2D(vec2<f32>(space.alongMm * 0.083, space.acrossMm * 0.36), seed + 333.0));
  let breakUp = 0.72 + 0.28 * fbm1D(space.alongMm * 0.13 + seed * 0.031, seed + 347.0);
  let dragTexture = ((coarseStreak * 0.085 + bristleStreak * 0.050 + hairStreak * 0.022) - 0.050)
    * body * streakLife * breakUp;

  // Individual hog-hair tracks use random positions rather than a lattice.
  // Most are narrow, broken scrape channels cut into a flat paste shelf rather
  // than positive Gaussian cords laid on top of it. A few small crests remain,
  // but they cannot turn the complete stroke into a set of cloth folds.
  let trackCount = i32(clamp(space.widthMm / 0.78, 6.0, 22.0));
  var trackRelief = 0.0;
  var trackPeak = 0.0;
  for (var trackIndex = 0; trackIndex < 22; trackIndex += 1) {
    let ti = f32(trackIndex);
    if (i32(ti) < trackCount) {
      let random0 = hash21(vec2<f32>(ti + 3.1, seed + 1.7));
      let random1 = hash21(vec2<f32>(ti + 11.7, seed + 5.9));
      let random2 = hash21(vec2<f32>(ti + 23.3, seed + 13.1));
      let random3 = hash21(vec2<f32>(ti + 41.9, seed + 29.3));
      let random4 = hash21(vec2<f32>(ti + 79.3, seed + 43.7));
      let random5 = hash21(vec2<f32>(ti + 97.1, seed + 53.3));
      let random6 = hash21(vec2<f32>(ti + 131.7, seed + 61.9));
      let center = (random0 * 2.0 - 1.0) * space.halfWidthMm * 0.94;
      let wander = (valueNoise1D(space.alongMm * 0.115 + ti * 9.7, seed + ti * 17.3) - 0.5) * 0.46;
      let drift = (random4 * 2.0 - 1.0) * (u - 0.5) * 0.38;
      let trackCenter = center + wander + drift;
      let trackWidth = clamp(space.widthMm * mix(0.006, 0.018, random3), space.pixelMm * 1.12, 0.44)
        * (0.76 + random1 * 0.50);
      let head = smoothstep(0.0, 2.2 + random2 * 7.5, space.alongMm);
      let tail = smoothstep(0.0, 2.5 + random5 * 8.0, space.lengthMm - space.alongMm);
      let life = smoothstep(0.30, 0.72, valueNoise1D(space.alongMm * 0.075 + ti * 5.3, seed + ti * 23.9));
      let breakGate = smoothstep(0.12, 0.68, valueNoise1D(space.alongMm * 0.23 + ti * 13.1, seed + ti * 31.7));
      let presence = head * tail * life * breakGate;
      let delta = abs(space.acrossMm - trackCenter) / max(trackWidth, 0.001);
      let track = exp(-pow(delta, 4.0) * 1.35);
      if (random6 < 0.76) {
        let depth = 0.14 + random5 * random5 * 0.28;
        trackRelief -= depth * track * presence;
      } else {
        let crest = 0.045 + random5 * random5 * 0.10;
        trackRelief += crest * track * presence;
        trackPeak = max(trackPeak, crest * track * presence);
      }
    }
  }
  let ridgeRelief = dragTexture + trackRelief * body;

  // A few sub-millimetre crumbs break the smooth top of the paste where the
  // brush unloads, particularly near the terminal half of wide marks.
  let crumbField = valueNoise2D(vec2<f32>(space.alongMm * 1.85 + seed * 0.037, space.acrossMm * 2.15 + seed * 0.043));
  let crumbTail = smoothstep(0.42, 1.00, u) * smoothstep(0.18, 0.58, fbm1D(space.acrossMm * 0.34 + seed * 0.017, seed + 353.0));
  let crumbs = smoothstep(0.72, 0.88, crumbField) * crumbTail * heightWidth * 0.075;

  // Paint collects against the contact line where the brush squeezes it out.
  // The lip is unequal on the two sides and appears in interrupted runs, not
  // as a manufactured rim around the complete footprint.
  let lipCenter = 0.11 + hash21(vec2<f32>(seed, 211.0)) * 0.17;
  let lipWidth = 0.135 + hash21(vec2<f32>(seed, 223.0)) * 0.155;
  let lipAlong = smoothstep(0.20, 0.78, fbm1D(space.alongMm * 0.12 + seed * 0.019 + side * 13.0, seed + 227.0));
  let lipChunks = smoothstep(0.28, 0.82, valueNoise1D(space.alongMm * 0.33 + seed * 0.027 + side * 7.0, seed + 233.0));
  let sideLoad = select(0.58, 1.0, v >= 0.0) * select(1.0, 0.72 + 0.28 * hash21(vec2<f32>(seed, 229.0)), v >= 0.0);
  let lipBand = exp(-pow((max(0.0, edgeDepth) - lipCenter) / lipWidth, 2.0) * 1.6);
  let lip = heightWidth * (0.045 + 0.28 * lipAlong * lipChunks) * sideLoad * lipBand * (0.48 + mass * 0.86);

  let film = 0.095 + 0.025 * mass;
  let relief = heightCoverage * max(0.0, film + body * 0.88 + ridgeRelief + crumbs + lip);
  var field: PaintField;
  field.coverage = coverage;
  field.heightCoverage = heightCoverage;
  field.relief = relief;
  field.ridges = ridgeRelief + trackPeak * 0.08 + lip * 0.20;
  field.edgeLip = lip;
  field.body = body;
  field.pickupScrape = 0.0;
  return field;
}

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
    let bite = select(0.0, depth, enabled) * exp(-pow((space.alongMm - center) / halfSpan, 2.0) * 1.5);
    bitesMm = max(bitesMm, bite);
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
    0.64
      + (fbm1D(space.alongMm * 0.052 + seed * 0.011, seed + 9.0) - 0.5) * 0.56
      + (valueNoise1D(space.alongMm * 0.015 + seed * 0.007, seed + 21.0) - 0.5) * 0.16,
    0.46,
    1.04,
  );
  var mass = 0.10 + 0.12 * pressure;
  for (var i = 0u; i < 6u; i += 1u) {
    let fi = f32(i);
    let alongCenter = space.lengthMm * mix(0.06, 0.94, hash21(vec2<f32>(fi + 3.0, seed + 71.0)));
    let acrossCenter = (hash21(vec2<f32>(fi + 17.0, seed + 73.0)) * 2.0 - 1.0) * halfW * 0.64;
    let halfAlong = mix(2.0, 7.0, hash21(vec2<f32>(fi + 31.0, seed + 79.0)));
    let halfAcross = mix(1.0, halfW * 0.56, hash21(vec2<f32>(fi + 47.0, seed + 83.0)));
    let amplitude = mix(0.32, 0.96, hash21(vec2<f32>(fi + 59.0, seed + 89.0)));
    let drift = (hash21(vec2<f32>(fi + 67.0, seed + 97.0)) - 0.5) * 0.55;
    let acrossAt = acrossCenter + drift * (space.alongMm - alongCenter);
    let d = vec2<f32>(
      (space.alongMm - alongCenter) / halfAlong,
      (acrossAt - space.acrossMm) / halfAcross,
    );
    mass = max(mass, amplitude * exp(-dot(d, d) * 1.7));
  }
  let patchNoise = fbm2D(
    vec2<f32>(space.alongMm * 0.14, space.acrossMm * 0.30) + vec2<f32>(seed * 0.013, seed * 0.017),
    seed + 337.0,
  );
  let cross = mix(
    0.54 + 0.46 * sqrt(max(0.0, 1.0 - qN * qN)),
    0.91 + 0.09 * (1.0 - qN * qN),
    flatMask,
  );
  var result: MassSample;
  result.pressure = pressure * (0.92 + (patchNoise - 0.5) * 0.20);
  result.mass = clamp(mass, 0.0, 1.10);
  result.cross = cross;
  return result;
}

fn tuftFieldV2(space: StrokeSpace, seed: f32, mass: f32, qN: f32) -> vec2<f32> {
  let halfW = max(space.halfWidthMm, 0.001);
  let warp = (fbm2D(vec2<f32>(space.alongMm * 0.030, space.acrossMm * 0.12), seed + 401.0) - 0.5) * 0.60;
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
    let amplitude = mix(0.018, 0.15, randomAmp * randomAmp);
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
    let amplitude = mix(0.002, 0.022, hash21(vec2<f32>(fi + 41.0, seed + 619.0)));
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
    0.42,
    0.74,
    fbm2D(vec2<f32>(space.alongMm * 0.080 + sidePhase, space.acrossMm * 0.16), seed + 631.0 + side),
  );
  let sideAmount = select(0.72, 1.0, side > 1.5);
  let rim = body * edgeBand * sideGate * sideAmount * smoothstep(0.20, 0.72, mass) * pressure;
  let capBand = exp(-pow(max(0.0, alongEnd - 0.24) / 0.34, 2.0));
  let capChunks = smoothstep(0.30, 0.75, valueNoise1D(space.acrossMm * 0.62 + sidePhase, seed + 641.0 + side));
  let capPile = body * capBand * capChunks * 0.24 * pressure;
  return rim * 0.24 + capPile;
}

fn paintFieldV2(uv: vec2<f32>) -> PaintField {
  let space = strokeSpace(uv);
  let v = clamp(uv.y, -1.0, 1.0);
  let seed = stroke.pigment.w;
  let flatMask = select(0.0, 1.0, stroke.finish.y < 0.5);
  let side = select(1.0, 2.0, v >= 0.0);
  let inset = edgeInsetV2(space, seed, side);
  let startInset = capInsetV2(space, seed, 0.0, flatMask);
  let endInset = capInsetV2(space, seed, 1.0, flatMask);
  let edgeDepth = space.halfWidthMm - abs(space.acrossMm) - inset;
  let alongStart = space.alongMm - startInset;
  let alongEnd = space.lengthMm - space.alongMm - endInset;
  let aa = max(0.035, space.pixelMm * 0.62);
  let coverage = clamp(
    smoothstep(-aa, aa, edgeDepth) * smoothstep(-aa, aa, alongStart) * smoothstep(-aa, aa, alongEnd),
    0.0,
    1.0,
  );
  let widthBevel = mix(0.42, 0.28, flatMask) + hash21(vec2<f32>(seed, 7.1)) * 0.06;
  let endBevel = mix(0.90, 0.56, flatMask);
  let heightCoverage = clamp(
    smoothstep(0.0, widthBevel, max(0.0, edgeDepth))
      * smoothstep(0.0, endBevel, max(0.0, alongStart))
      * smoothstep(0.0, endBevel * 1.12, max(0.0, alongEnd)),
    0.0,
    1.0,
  );
  let massSample = macroMassV2(space, seed, flatMask, v);
  let body = heightCoverage * massSample.cross * massSample.mass * massSample.pressure;
  let tufts = tuftFieldV2(space, seed, massSample.mass, v);
  let tuftRelief = body * (tufts.x * 1.35 + tufts.y * 0.62);
  let lip = lipFieldV2(space, seed, side, edgeDepth, alongEnd, body, massSample.mass, massSample.pressure);
  let grain = (valueNoise2D(vec2<f32>(space.alongMm * 1.25, space.acrossMm * 1.55) + vec2<f32>(seed * 0.031, seed * 0.037)) - 0.5)
    * heightCoverage * 0.006;
  let film = heightCoverage * (0.026 + 0.012 * massSample.mass);
  let relief = max(0.0, film + body + tuftRelief + lip + grain);
  var field: PaintField;
  field.coverage = coverage;
  field.heightCoverage = heightCoverage;
  field.relief = relief;
  field.ridges = tuftRelief + lip * 0.55;
  field.edgeLip = lip;
  field.body = body;
  field.pickupScrape = 0.0;
  return field;
}

fn paintFieldV3(uv: vec2<f32>) -> PaintField {
  let space = strokeSpace(uv);
  let v = clamp(uv.y, -1.0, 1.0);
  let seed = stroke.pigment.w;
  let flatMask = select(0.0, 1.0, stroke.finish.y < 0.5);
  let side = select(1.0, 2.0, v >= 0.0);
  let inset = edgeInsetV2(space, seed, side);
  let startInset = capInsetV2(space, seed, 0.0, flatMask);
  let endInset = capInsetV2(space, seed, 1.0, flatMask);
  let edgeDepth = space.halfWidthMm - abs(space.acrossMm) - inset;
  let alongStart = space.alongMm - startInset;
  let alongEnd = space.lengthMm - space.alongMm - endInset;
  let aa = max(0.035, space.pixelMm * 0.62);
  let coverage = clamp(
    smoothstep(-aa, aa, edgeDepth) * smoothstep(-aa, aa, alongStart) * smoothstep(-aa, aa, alongEnd),
    0.0,
    1.0,
  );
  let widthBevel = mix(0.44, 0.30, flatMask) + hash21(vec2<f32>(seed, 7.1)) * 0.06;
  let endBevel = mix(0.92, 0.58, flatMask);
  let heightCoverage = clamp(
    smoothstep(0.0, widthBevel, max(0.0, edgeDepth))
      * smoothstep(0.0, endBevel, max(0.0, alongStart))
      * smoothstep(0.0, endBevel * 1.12, max(0.0, alongEnd)),
    0.0,
    1.0,
  );

  let warpX = fbm2D(vec2<f32>(space.alongMm * 0.034, space.acrossMm * 0.072), seed + 401.0) - 0.5;
  let warpY = fbm2D(vec2<f32>(space.alongMm * 0.043, space.acrossMm * 0.088), seed + 409.0) - 0.5;
  let warp = vec2<f32>(warpX * 2.10, warpY * 1.20);
  let massNoise = fbm2D(vec2<f32>(space.alongMm * 0.060, space.acrossMm * 0.145) + warp, seed + 331.0);
  let patchNoise = fbm2D(vec2<f32>(space.alongMm * 0.160, space.acrossMm * 0.34) + warp * 0.70, seed + 337.0);
  let pressure = 0.80 + (fbm1D(space.alongMm * 0.061 + seed * 0.011, seed + 9.0) - 0.5) * 0.38;
  let mass = smoothstep(0.26, 0.80, massNoise * 0.76 + patchNoise * 0.24);
  let massBody = 0.74 + mass * 0.23;
  let crossProfile = mix(
    0.62 + 0.38 * sqrt(max(0.0, 1.0 - v * v)),
    0.93 + 0.07 * (1.0 - v * v),
    flatMask,
  );
  let acrossTilt = 1.0 + (valueNoise1D(space.alongMm * 0.031 + seed * 0.017, seed + 101.0) - 0.5) * v * 0.22;
  let body = heightCoverage * crossProfile * massBody * pressure * acrossTilt;

  let tufts = tuftFieldV2(space, seed, mass, v);
  let moundNoise = fbm2D(vec2<f32>(space.alongMm * 0.31, space.acrossMm * 0.62) + warp * 0.38, seed + 347.0);
  let mounds = smoothstep(0.56, 0.70, moundNoise) * 0.11;
  let tuftRelief = body * (tufts.x * 1.75 + tufts.y * 0.68 + mounds);
  let lip = lipFieldV2(space, seed, side, edgeDepth, alongEnd, body, mass, pressure);
  let grain = (valueNoise2D(vec2<f32>(space.alongMm * 1.25, space.acrossMm * 1.55) + vec2<f32>(seed * 0.031, seed * 0.037)) - 0.5)
    * heightCoverage * 0.004;
  let film = heightCoverage * 0.028;
  let relief = max(0.0, film + body + tuftRelief + lip + grain);
  var field: PaintField;
  field.coverage = coverage;
  field.heightCoverage = heightCoverage;
  field.relief = relief;
  field.ridges = tuftRelief + lip * 0.55;
  field.edgeLip = lip;
  field.body = body;
  field.pickupScrape = 0.0;
  return field;
}

fn brushReliefV4(space: StrokeSpace, seed: f32, body: f32, mass: f32) -> vec2<f32> {
  let halfW = max(space.halfWidthMm, 0.001);
  let lengthMm = max(space.lengthMm, 0.001);
  var ridges = 0.0;
  var grooves = 0.0;
  for (var i = 0u; i < 8u; i += 1u) {
    let fi = f32(i);
    let alongCenter = lengthMm * mix(0.04, 0.96, hash21(vec2<f32>(fi + 3.0, seed + 701.0)));
    let halfAlong = lengthMm * mix(0.16, 0.42, hash21(vec2<f32>(fi + 11.0, seed + 709.0)));
    let acrossCenter = (hash21(vec2<f32>(fi + 19.0, seed + 719.0)) * 2.0 - 1.0) * halfW * 0.86;
    let halfAcross = mix(0.34, 1.15, hash21(vec2<f32>(fi + 29.0, seed + 727.0)));
    let amplitude = mix(0.09, 0.34, hash21(vec2<f32>(fi + 37.0, seed + 733.0)));
    let drift = (hash21(vec2<f32>(fi + 43.0, seed + 739.0)) - 0.5) * 0.75;
    let acrossAt = acrossCenter + drift * (space.alongMm - alongCenter);
    let q = vec2<f32>(
      (space.alongMm - alongCenter) / halfAlong,
      (space.acrossMm - acrossAt) / halfAcross,
    );
    let radius = sqrt(dot(q, q));
    let capsule = 1.0 - smoothstep(0.48, 1.0, radius);
    ridges = max(ridges, amplitude * capsule);
  }
  for (var i = 0u; i < 14u; i += 1u) {
    let fi = f32(i);
    let alongCenter = lengthMm * mix(0.03, 0.97, hash21(vec2<f32>(fi + 5.0, seed + 751.0)));
    let halfAlong = mix(2.0, 12.0, hash21(vec2<f32>(fi + 13.0, seed + 757.0)));
    let acrossCenter = (hash21(vec2<f32>(fi + 23.0, seed + 761.0)) * 2.0 - 1.0) * halfW * 0.92;
    let halfAcross = mix(0.10, 0.34, hash21(vec2<f32>(fi + 31.0, seed + 769.0)));
    let depth = mix(0.05, 0.20, hash21(vec2<f32>(fi + 41.0, seed + 773.0)));
    let drift = (hash21(vec2<f32>(fi + 47.0, seed + 787.0)) - 0.5) * 0.45;
    let acrossAt = acrossCenter + drift * (space.alongMm - alongCenter);
    let q = vec2<f32>(
      (space.alongMm - alongCenter) / halfAlong,
      (space.acrossMm - acrossAt) / halfAcross,
    );
    let radius = sqrt(dot(q, q));
    let capsule = 1.0 - smoothstep(0.58, 1.0, radius);
    grooves = max(grooves, depth * capsule);
  }
  let lumpNoise = fbm2D(vec2<f32>(space.alongMm * 0.42, space.acrossMm * 0.78), seed + 797.0) - 0.5;
  let lumps = max(0.0, lumpNoise) * 0.075 * smoothstep(0.25, 0.72, mass);
  return vec2<f32>(ridges + lumps, grooves);
}

fn paintFieldV4(uv: vec2<f32>) -> PaintField {
  let space = strokeSpace(uv);
  let v = clamp(uv.y, -1.0, 1.0);
  let seed = stroke.pigment.w;
  let flatMask = select(0.0, 1.0, stroke.finish.y < 0.5);
  let side = select(1.0, 2.0, v >= 0.0);
  let inset = edgeInsetV2(space, seed, side);
  let startInset = capInsetV2(space, seed, 0.0, flatMask);
  let endInset = capInsetV2(space, seed, 1.0, flatMask);
  let edgeDepth = space.halfWidthMm - abs(space.acrossMm) - inset;
  let alongStart = space.alongMm - startInset;
  let alongEnd = space.lengthMm - space.alongMm - endInset;
  let aa = max(0.035, space.pixelMm * 0.62);
  let coverage = clamp(
    smoothstep(-aa, aa, edgeDepth) * smoothstep(-aa, aa, alongStart) * smoothstep(-aa, aa, alongEnd),
    0.0,
    1.0,
  );
  let widthBevel = mix(0.44, 0.30, flatMask) + hash21(vec2<f32>(seed, 7.1)) * 0.06;
  let endBevel = mix(0.92, 0.58, flatMask);
  let heightCoverage = clamp(
    smoothstep(0.0, widthBevel, max(0.0, edgeDepth))
      * smoothstep(0.0, endBevel, max(0.0, alongStart))
      * smoothstep(0.0, endBevel * 1.12, max(0.0, alongEnd)),
    0.0,
    1.0,
  );

  let massNoise = fbm2D(vec2<f32>(space.alongMm * 0.075, space.acrossMm * 0.18), seed + 331.0);
  let patchNoise = fbm2D(vec2<f32>(space.alongMm * 0.19, space.acrossMm * 0.42), seed + 337.0);
  let pressure = 0.82 + (fbm1D(space.alongMm * 0.061 + seed * 0.011, seed + 9.0) - 0.5) * 0.34;
  let mass = smoothstep(0.26, 0.80, massNoise * 0.76 + patchNoise * 0.24);
  let massBody = 0.76 + mass * 0.20;
  let crossProfile = mix(
    0.62 + 0.38 * sqrt(max(0.0, 1.0 - v * v)),
    0.94 + 0.06 * (1.0 - v * v),
    flatMask,
  );
  let acrossTilt = 1.0 + (valueNoise1D(space.alongMm * 0.031 + seed * 0.017, seed + 101.0) - 0.5) * v * 0.18;
  let body = heightCoverage * crossProfile * massBody * pressure * acrossTilt;
  let reliefField = brushReliefV4(space, seed, body, mass);
  let lip = lipFieldV2(space, seed, side, edgeDepth, alongEnd, body, mass, pressure);
  let grain = (valueNoise2D(vec2<f32>(space.alongMm * 1.25, space.acrossMm * 1.55) + vec2<f32>(seed * 0.031, seed * 0.037)) - 0.5)
    * heightCoverage * 0.005;
  let film = heightCoverage * 0.028;
  let relief = max(0.0, film + body * (1.0 + reliefField.x - reliefField.y) + lip + grain);
  var field: PaintField;
  field.coverage = coverage;
  field.heightCoverage = heightCoverage;
  field.relief = relief;
  field.ridges = body * (reliefField.x - reliefField.y) + lip * 0.55;
  field.edgeLip = lip;
  field.body = body;
  field.pickupScrape = 0.0;
  return field;
}

fn edgeInsetV3(space: StrokeSpace, seed: f32, side: f32) -> f32 {
  // The silhouette is a one-dimensional contact line, not a two-dimensional
  // paint mask. Keeping the displacement a function of distance along the
  // stroke prevents the boundary from rippling backward across the painted
  // surface and producing one-pixel shadow terraces.
  let salt = 31.0 + side * 43.0;
  let broad = fbm1D(space.alongMm * 0.061 + salt + seed * 0.011, seed + salt) - 0.5;
  let drag = fbm1D(space.alongMm * 0.26 + salt * 1.7 + seed * 0.019, seed + salt * 2.3) - 0.5;
  let tooth = valueNoise1D(space.alongMm * 0.82 + salt * 0.6, seed + salt * 3.7) - 0.5;
  let chipSignal = valueNoise1D(space.alongMm * 1.12 + salt * 0.31, seed + salt * 5.1);
  let amplitude = clamp(space.widthMm * 0.105, 0.32, 2.20);
  let chips = smoothstep(0.56, 0.88, chipSignal) * amplitude * 0.34;
  let torn = smoothstep(0.52, 0.82, fbm1D(space.alongMm * 0.24 + salt * 0.8, seed + salt * 7.9));
  let tear = (fbm1D(space.alongMm * 0.48 + salt * 1.1, seed + salt * 9.3) - 0.5) * amplitude * torn * 0.18;
  return max(0.03, 0.14 + broad * amplitude * 1.45 + drag * amplitude * 0.58 + tooth * 0.16 + chips + tear);
}

fn capInsetV3(space: StrokeSpace, seed: f32, endId: f32, flatMask: f32, taperEnd: f32) -> f32 {
  let halfW = max(space.halfWidthMm, 0.001);
  let q = clamp(abs(space.acrossMm) / halfW, 0.0, 1.0);
  let v = clamp(space.acrossMm / halfW, -1.0, 1.0);
  let salt = select(17.0, 59.0, endId > 0.5);
  let load0 = hash21(vec2<f32>(seed + salt, endId + 2.1));
  let load1 = hash21(vec2<f32>(seed + salt * 1.7, endId + 7.3));
  let skewSign = select(-1.0, 1.0, load0 > 0.5);
  let roundMask = sqrt(max(0.0, 1.0 - q * q));
  let filbertShape = halfW * mix(0.50, 0.72, load1) * (1.0 - roundMask);
  let flatShape = halfW * 0.035 * (1.0 - q * q)
    + skewSign * v * halfW * mix(0.045, 0.14, load1);
  let broadTear = (valueNoise1D(space.acrossMm * 0.44 + salt, seed + salt + 13.0) - 0.5) * halfW * 0.16;
  let fineTear = (valueNoise1D(space.acrossMm * 1.35 + salt * 0.5, seed + salt + 17.0) - 0.5) * halfW * 0.055;
  let chipTear = smoothstep(0.62, 0.90, valueNoise1D(space.acrossMm * 2.50 + salt, seed + salt + 23.0)) * halfW * 0.035;
  let terminal = endId > 0.5;
  let regularBase = mix(0.42 + 0.56 * load1, 0.26 + 0.54 * load1, flatMask)
    * clamp(halfW * 0.12, 0.18, 1.58);
  let terminalBase = (0.34 + 0.46 * load1) * clamp(halfW * 0.095, 0.16, 1.28);
  let bluntShape = halfW * 0.026 * (1.0 - q * q)
    + skewSign * v * halfW * (0.055 + 0.035 * load1);
  let bermShape = halfW * 0.018 * (1.0 - q * q)
    + skewSign * v * halfW * (0.075 + 0.040 * load1);
  let terminalKnife = select(bermShape, bluntShape, taperEnd < 1.5);
  let terminalShape = select(terminalKnife, mix(filbertShape, flatShape, flatMask), abs(taperEnd - 1.0) < 0.1);
  let shape = select(mix(filbertShape, flatShape, flatMask), terminalShape, terminal);
  let base = select(regularBase, terminalBase, terminal);
  return max(0.0, base + shape + broadTear + fineTear + chipTear);
}

fn bristleLaneLayer(space: StrokeSpace, seed: f32, salt: f32, spacingMm: f32, lifeScale: f32) -> vec2<f32> {
  let warp = (fbm1D(space.alongMm * 0.105 + salt * 1.7, seed + salt) - 0.5) * spacingMm * 2.4;
  let phase = (space.acrossMm + warp) / spacingMm;
  let cell = floor(phase);
  let within = fract(phase);
  let center = 0.50 + (hash21(vec2<f32>(cell + salt, seed + 811.0)) - 0.5) * 0.34;
  let halfLane = mix(0.17, 0.36, hash21(vec2<f32>(cell + salt * 1.3, seed + 821.0)));
  let delta = abs(within - center);
  let lane = 1.0 - smoothstep(halfLane * 0.42, halfLane, delta);
  let groove = 1.0 - smoothstep(0.012, 0.105, min(within, 1.0 - within));
  let amp = mix(0.18, 0.88, hash21(vec2<f32>(cell + salt * 2.1, seed + 827.0)));
  let life = smoothstep(
    0.26,
    0.72,
    valueNoise1D(space.alongMm * lifeScale + cell * 7.31, seed + salt * 3.1),
  );
  let breakGate = smoothstep(
    0.10,
    0.56,
    valueNoise1D(space.alongMm * lifeScale * 2.05 + cell * 3.17, seed + salt * 4.7),
  );
  return vec2<f32>(lane * amp * life * breakGate, groove * (0.35 + amp * 0.65) * life);
}

fn bristleReliefV5(space: StrokeSpace, seed: f32) -> vec2<f32> {
  let fine = bristleLaneLayer(space, seed, 1.0, 0.34, 0.24);
  let medium = bristleLaneLayer(space, seed, 2.0, 0.59, 0.175);
  let broad = bristleLaneLayer(space, seed, 3.0, 1.18, 0.105);
  let drag = (fbm1D(space.alongMm * 0.20 + seed * 0.013, seed + 839.0) - 0.5) * 0.06;
  let ridges = fine.x * 0.18 + medium.x * 0.105 + broad.x * 0.050 + drag * 0.55;
  let grooves = fine.y * 0.040 + medium.y * 0.025 + broad.y * 0.012;
  return vec2<f32>(ridges, grooves);
}

fn paintFieldV5(uv: vec2<f32>) -> PaintField {
  let space = strokeSpace(uv);
  let v = clamp(uv.y, -1.0, 1.0);
  let seed = stroke.pigment.w;
  let flatMask = select(0.0, 1.0, stroke.finish.y < 0.5);
  let side = select(1.0, 2.0, v >= 0.0);
  let inset = edgeInsetV3(space, seed, side);
  let startInset = capInsetV3(space, seed, 0.0, flatMask, stroke.deposition.z);
  let endInset = capInsetV3(space, seed, 1.0, flatMask, stroke.deposition.z);
  let edgeDepth = space.halfWidthMm - abs(space.acrossMm) - inset;
  let alongStart = space.alongMm - startInset;
  let alongEnd = space.lengthMm - space.alongMm - endInset;
  let aa = max(0.050, space.pixelMm * 0.78);
  let coverage = clamp(
    smoothstep(-aa, aa, edgeDepth) * smoothstep(-aa, aa, alongStart) * smoothstep(-aa, aa, alongEnd),
    0.0,
    1.0,
  );

  // A loaded brush tapers over a physical distance related to its width. The
  // old sub-millimetre end bevel made even a round filbert stop like a routed
  // slab. The footprint contact film remains thin; only the raised paste tapers.
  let edgeBevel = clamp(space.widthMm * 0.019, 0.12, 0.48);
  let capTaper = clamp(space.widthMm * mix(0.12, 0.075, flatMask), 0.40, 2.45);
  let heightWidth = smoothstep(0.0, edgeBevel, max(0.0, edgeDepth));
  let heightStart = smoothstep(0.0, capTaper, max(0.0, alongStart));
  let heightEnd = smoothstep(0.0, capTaper * 1.18, max(0.0, alongEnd));
  let heightCoverage = clamp(heightWidth * heightStart * heightEnd, 0.0, 1.0);

  let warp = vec2<f32>(
    (fbm2D(vec2<f32>(space.alongMm * 0.041, space.acrossMm * 0.083), seed + 401.0) - 0.5) * 1.55,
    (fbm2D(vec2<f32>(space.alongMm * 0.055, space.acrossMm * 0.115), seed + 409.0) - 0.5) * 0.82,
  );
  let macroNoise = fbm2D(vec2<f32>(space.alongMm * 0.061, space.acrossMm * 0.125) + warp * 0.48, seed + 331.0);
  let swellNoise = fbm2D(vec2<f32>(space.alongMm * 0.093, space.acrossMm * 0.39) + warp * 0.28, seed + 337.0);
  let grainNoise = fbm2D(vec2<f32>(space.alongMm * 0.71, space.acrossMm * 1.16) + warp * 0.30, seed + 347.0);
  let pressure = clamp(
    0.82
      + (fbm1D(space.alongMm * 0.050 + seed * 0.011, seed + 9.0) - 0.5) * 0.28
      + (valueNoise1D(space.acrossMm * 0.095 + seed * 0.007, seed + 21.0) - 0.5) * 0.13,
    0.62,
    1.05,
  );
  let macroMass = smoothstep(0.28, 0.72, macroNoise);
  let swells = smoothstep(0.51, 0.69, swellNoise) * 0.15;
  let shallowPits = smoothstep(0.66, 0.84, 1.0 - (swellNoise * 0.55 + grainNoise * 0.45)) * 0.055;
  let crossProfile = mix(
    0.48 + 0.52 * sqrt(max(0.0, 1.0 - v * v)),
    0.91 + 0.09 * (1.0 - v * v),
    flatMask,
  );
  let acrossTilt = 1.0 + (valueNoise1D(space.alongMm * 0.029 + seed * 0.017, seed + 101.0) - 0.5) * v * 0.24;
  let massBody = clamp(0.72 + (macroMass - 0.5) * 0.18 + swells - shallowPits, 0.46, 1.0);
  var body = heightCoverage * crossProfile * massBody * pressure * acrossTilt;

  let bristles = bristleReliefV5(space, seed);
  let tuftZone = fbm2D(vec2<f32>(space.alongMm * 0.078, space.acrossMm * 0.195), seed + 857.0);
  let laneGate = smoothstep(0.30, 0.68, tuftZone * 0.64 + macroMass * 0.36);
  let laneRelief = body * (bristles.x * laneGate - bristles.y * (0.35 + laneGate * 0.65));

  let edgeRollSignal = smoothstep(
    0.43,
    0.72,
    fbm1D(space.alongMm * 0.165 + side * 19.0 + seed * 0.019, seed + 861.0 + side),
  );
  let edgeRollBand = exp(-pow((max(0.0, edgeDepth) - 0.46) / 0.48, 2.0) * 1.45);
  let sideLoad = select(0.52, 1.0, side > 1.5);
  let edgeRoll = heightCoverage * edgeRollBand * (0.035 + edgeRollSignal * 0.29)
    * sideLoad * crossProfile * mix(0.68, 1.0, pressure);

  // Local unloading heaps sit inside ragged end and side runs. They are part of
  // the same paste body, not a separate beaded outline around the footprint.
  let endHeapNoise = fbm1D(space.acrossMm * 0.32 + seed * 0.019, seed + 853.0);
  let startHeap = smoothstep(0.48, 0.88, endHeapNoise) * exp(-pow(max(0.0, alongStart - capTaper * 0.35) / (capTaper * 0.74), 2.0));
  let endHeap = smoothstep(0.40, 0.84, 1.0 - endHeapNoise) * exp(-pow(max(0.0, alongEnd - capTaper * 0.30) / (capTaper * 0.66), 2.0));
  let capHeaps = heightCoverage * (startHeap * 0.18 + endHeap * 0.28) * crossProfile * pressure;
  let lip = lipFieldV2(space, seed, side, edgeDepth, alongEnd, body, macroMass, pressure);
  let grain = (grainNoise - 0.5) * heightCoverage * 0.020;
  let film = coverage * (0.018 + macroMass * 0.020);
  let relief = max(0.0, film + body + laneRelief + capHeaps + edgeRoll + lip + grain);
  var field: PaintField;
  field.coverage = coverage;
  field.heightCoverage = heightCoverage;
  field.relief = relief;
  field.ridges = laneRelief + capHeaps + edgeRoll + lip * 0.55;
  field.edgeLip = edgeRoll + lip;
  field.body = body;
  field.pickupScrape = 0.0;
  return field;
}

struct BristleReliefV7 {
  ridges: f32,
  grooves: f32,
};

fn macroPasteV7(space: StrokeSpace, seed: f32) -> f32 {
  let halfW = max(space.halfWidthMm, 0.001);
  let lengthMm = max(space.lengthMm, 0.001);
  let warpAcross = (fbm2D(vec2<f32>(space.alongMm * 0.075, space.acrossMm * 0.16), seed + 881.0) - 0.5)
    * clamp(space.widthMm * 0.10, 0.35, 2.20);
  var dominantLoad = 0.0;
  var overlappingLoad = 0.0;
  // Broad knife deposits have a flatter face than a rounded blob. A soft
  // superellipse gives each mass a pressed plane, while the torn boundary and
  // restrained union preserve the separate deposits where they overlap.
  for (var massIndex = 0; massIndex < 5; massIndex += 1) {
    let fi = f32(massIndex);
    let r0 = hash21(vec2<f32>(fi + 3.1, seed + 901.0));
    let r1 = hash21(vec2<f32>(fi + 13.7, seed + 907.0));
    let r2 = hash21(vec2<f32>(fi + 29.3, seed + 911.0));
    let r3 = hash21(vec2<f32>(fi + 41.9, seed + 919.0));
    let r4 = hash21(vec2<f32>(fi + 67.7, seed + 929.0));
    let r5 = hash21(vec2<f32>(fi + 83.1, seed + 937.0));
    let alongCenter = lengthMm * mix(0.16, 0.84, r0);
    let halfAlong = clamp(lengthMm * mix(0.16, 0.40, r1), 3.5, 24.0);
    let acrossCenter = (r2 * 2.0 - 1.0) * halfW * 0.54;
    let halfAcross = clamp(space.widthMm * mix(0.18, 0.36, r3), 1.40, halfW * 0.78);
    let drift = (r4 - 0.5) * halfW * 0.32;
    let acrossAt = acrossCenter + drift * (space.alongMm / lengthMm - 0.5) * 2.0;
    let bend = (valueNoise1D(space.alongMm * 0.16 + fi * 8.7, seed + 943.0) - 0.5)
      * halfAcross * 0.55;
    let q = vec2<f32>(
      (space.alongMm - alongCenter) / max(halfAlong, 0.75),
      (space.acrossMm + warpAcross + bend - acrossAt) / max(halfAcross, 0.30),
    );
    let faceDistance = pow(pow(abs(q.x), 3.6) + pow(abs(q.y), 3.6), 0.27778);
    let edgeTear = (valueNoise2D(q * 2.10 + vec2<f32>(fi * 11.3, seed * 0.019)) - 0.5) * 0.17;
    let edge = mix(0.88, 1.05, valueNoise2D(q * 1.05 + vec2<f32>(fi * 7.1, seed * 0.013))) + edgeTear;
    let blob = 1.0 - smoothstep(edge - 0.17, edge + 0.035, faceDistance);
    let amplitude = mix(0.48, 0.94, r5 * r5);
    let massLoad = blob * amplitude;
    dominantLoad = max(dominantLoad, massLoad);
    overlappingLoad += massLoad;
  }
  // Most of the response follows the strongest parcel. Only a small part of
  // an overlap adds load, so several adjacent masses do not become one smooth
  // saturated mound.
  let parcelLoad = clamp(dominantLoad + min(max(0.0, overlappingLoad - dominantLoad), 0.42) * 0.22, 0.0, 1.0);

  // A flat knife spreads one broad, compressed face across most of its pass.
  // Use the parcels to modulate that face, rather than letting five rounded
  // internal crowns define the whole cross-section. The low-frequency term
  // follows tool travel and only perturbs load slightly; sharp relief is left
  // to the sparse edge lips and finite dragged deposits.
  let flatMask = select(0.0, 1.0, stroke.finish.y < 0.5);
  let faceLoadNoise = fbm2D(
    vec2<f32>(space.alongMm * 0.042, space.acrossMm * 0.095) + vec2<f32>(seed * 0.021, seed * 0.037),
    seed + 967.0,
  );
  let shearWarp = (fbm1D(space.alongMm * 0.038 + seed * 0.013, seed + 1291.0) - 0.5) * 2.8
    + (fbm1D(space.alongMm * 0.095 + seed * 0.019, seed + 1297.0) - 0.5) * 0.9;
  let shearField = fbm2D(
    vec2<f32>(space.alongMm * 0.075, (space.acrossMm * 0.72 + shearWarp) * 0.78),
    seed + 1303.0,
  );
  let pressedFaceLoad = clamp(
    0.70 + dominantLoad * 0.11 + (faceLoadNoise - 0.43) * 0.10 + (shearField - 0.5) * 0.08,
    0.64,
    0.86,
  );
  // The long, warped shear field carries the main load variation. Finite
  // superellipse parcels remain only as a small irregular perturbation, so
  // they cannot read as isolated blisters along the stroke.
  let continuousLoad = clamp(
    0.70 + (shearField - 0.5) * 0.28 + (faceLoadNoise - 0.43) * 0.12,
    0.58,
    0.84,
  );
  let parcelVariation = (parcelLoad - 0.5) * 0.12;
  return clamp(mix(continuousLoad, pressedFaceLoad, flatMask * 0.42) + parcelVariation, 0.48, 0.94);
}

fn tuftReliefV7(space: StrokeSpace, seed: f32, mass: f32) -> BristleReliefV7 {
  let halfW = max(space.halfWidthMm, 0.001);
  let warpAcross = (fbm2D(vec2<f32>(space.alongMm * 0.080, space.acrossMm * 0.19), seed + 951.0) - 0.5)
    * clamp(space.widthMm * 0.055, 0.22, 1.25);
  let zone = valueNoise2D(
    vec2<f32>(space.alongMm * 0.17, space.acrossMm * 0.30) + vec2<f32>(seed * 0.017, seed * 0.021),
  );
  let zoneGate = mix(0.68, 1.0, smoothstep(0.22, 0.74, zone)) * mix(0.82, 1.0, mass);
  var ridges = 0.0;
  var grooves = 0.0;
  // Broad bristle clumps carry most of the striated relief. Two finite
  // segments per track keep the ridges from becoming complete rails while
  // preserving the long directional smear that a loaded brush actually leaves.
  for (var clumpIndex = 0; clumpIndex < 13; clumpIndex += 1) {
    let ci = f32(clumpIndex);
    let c0 = hash21(vec2<f32>(ci + 6.7, seed + 1031.0));
    let c1 = hash21(vec2<f32>(ci + 19.3, seed + 1033.0));
    let c2 = hash21(vec2<f32>(ci + 37.1, seed + 1039.0));
    let c3 = hash21(vec2<f32>(ci + 53.9, seed + 1049.0));
    let laneJitter = (c0 - 0.5) * 1.05 / 13.0;
    let trackAcross = (-0.86 + (ci + 0.5) * 1.72 / 13.0 + laneJitter) * halfW;
    let trackDrift = (c1 - 0.5) * halfW * 0.18;
    let segmentSpacing = mix(5.6, 11.5, c2);
    let segmentHalf = clamp(mix(1.65, 4.70, c3), 1.10, 5.20);
    let clumpAcross = clamp(mix(0.48, 1.45, c1), 0.38, max(0.48, halfW * 0.24));
    let clumpLoad = mix(0.24, 0.64, c2 * c2);
    for (var clumpSegment = 0; clumpSegment < 3; clumpSegment += 1) {
      let cs = f32(clumpSegment);
      let cs0 = hash21(vec2<f32>(ci * 3.1 + cs + 2.9, seed + 1051.0));
      let cs1 = hash21(vec2<f32>(ci * 3.1 + cs + 13.7, seed + 1061.0));
      let cs2 = hash21(vec2<f32>(ci * 3.1 + cs + 29.3, seed + 1063.0));
      let rawCenter = space.lengthMm * (c2 + cs * 0.47 + (cs0 - 0.5) * 0.16);
      let alongCenter = fract(rawCenter / max(space.lengthMm, 0.001)) * space.lengthMm;
      let acrossAt = trackAcross + trackDrift * (alongCenter / max(space.lengthMm, 0.001) - 0.5)
        + (cs1 - 0.5) * clumpAcross * 0.18;
      let bend = (valueNoise1D(space.alongMm * 0.24 + ci * 5.3 + cs, seed + 1069.0) - 0.5)
        * clumpAcross * 0.22;
      let q = vec2<f32>(
        (space.alongMm - alongCenter) / max(segmentHalf, 1.6),
        (space.acrossMm + warpAcross + bend - acrossAt) / max(clumpAcross, 0.32),
      );
      let radial = sqrt(dot(q, q));
      let capsule = 1.0 - smoothstep(0.48, 1.0, radial);
      let clumpRidge = capsule * mix(0.62, 1.0, cs2);
      ridges = max(ridges, clumpLoad * clumpRidge);
    }
  }
  // Fine bristles leave interrupted scratch-scale tracks inside those clumps.
  // Each track drifts sideways and breaks into finite loaded segments.
  for (var trackIndex = 0; trackIndex < 15; trackIndex += 1) {
    let fi = f32(trackIndex);
    let r0 = hash21(vec2<f32>(fi + 4.3, seed + 961.0));
    let r1 = hash21(vec2<f32>(fi + 17.9, seed + 967.0));
    let r2 = hash21(vec2<f32>(fi + 31.1, seed + 971.0));
    let r3 = hash21(vec2<f32>(fi + 47.7, seed + 977.0));
    let r4 = hash21(vec2<f32>(fi + 59.3, seed + 983.0));
    let r5 = hash21(vec2<f32>(fi + 73.9, seed + 991.0));
    let trackAcross = (r0 * 2.0 - 1.0) * halfW * 0.87;
    let trackDrift = (r1 - 0.5) * halfW * 0.17;
    let trackPhase = space.lengthMm * r2;
    let segmentSpacing = mix(3.6, 7.6, r3);
    let halfAlong = clamp(mix(1.10, 3.70, r4 * r4), 0.72, 4.20);
    let halfAcross = clamp(mix(0.075, 0.225, r5), 0.065, max(0.085, halfW * 0.20));
    let trackAmplitude = mix(0.110, 0.440, r5 * r5);
    for (var segmentIndex = 0; segmentIndex < 3; segmentIndex += 1) {
      let si = f32(segmentIndex);
      let rs0 = hash21(vec2<f32>(fi * 4.7 + si + 2.3, seed + 1009.0));
      let rs1 = hash21(vec2<f32>(fi * 4.7 + si + 11.9, seed + 1013.0));
      let rs2 = hash21(vec2<f32>(fi * 4.7 + si + 23.7, seed + 1019.0));
      let rawCenter = trackPhase + si * segmentSpacing + (rs0 - 0.5) * segmentSpacing * 0.62;
      let alongCenter = fract(rawCenter / max(space.lengthMm, 0.001)) * space.lengthMm;
      let segmentShift = (rs1 - 0.5) * halfAcross * 0.34;
      let acrossAt = trackAcross + trackDrift * (alongCenter / max(space.lengthMm, 0.001) - 0.5)
        + segmentShift;
      let bend = (valueNoise1D(space.alongMm * 0.42 + fi * 3.9 + si, seed + 1021.0) - 0.5)
        * halfAcross * 0.30;
      let q = vec2<f32>(
        (space.alongMm - alongCenter) / max(halfAlong, 0.72),
        (space.acrossMm + warpAcross + bend - acrossAt) / max(halfAcross, 0.065),
      );
      let radial = sqrt(dot(q, q));
      let capsule = 1.0 - smoothstep(0.52, 1.0, radial);
      let segmentLoad = mix(0.34, 1.0, rs2);
      ridges = max(ridges, trackAmplitude * segmentLoad * capsule);

      if (si < 1.0) {
        let grooveAlong = clamp(mix(0.65, 2.40, rs2 * rs2), 0.45, 2.80);
        let grooveAcross = clamp(halfAcross * 0.52, 0.045, 0.13);
        let grooveCenter = acrossAt + (rs0 - 0.5) * halfAcross * 2.4;
        let gq = vec2<f32>(
          (space.alongMm - alongCenter + (rs1 - 0.5) * halfAlong * 0.55) / grooveAlong,
          (space.acrossMm + warpAcross * 0.72 + bend - grooveCenter) / grooveAcross,
        );
        let grooveCapsule = 1.0 - smoothstep(0.30, 1.0, sqrt(dot(gq, gq)));
        grooves = max(grooves, mix(0.020, 0.125, rs2 * rs2) * grooveCapsule);
      }
    }
  }
  var result: BristleReliefV7;
  result.ridges = ridges * zoneGate;
  result.grooves = grooves * zoneGate;
  return result;
}

fn paintFieldV6(uv: vec2<f32>) -> PaintField {
  let space = strokeSpace(uv);
  let v = clamp(uv.y, -1.0, 1.0);
  let seed = stroke.pigment.w;
  let flatMask = select(0.0, 1.0, stroke.finish.y < 0.5);
  let side = select(1.0, 2.0, v >= 0.0);
  let inset = edgeInsetV3(space, seed, side);
  let startInset = capInsetV3(space, seed, 0.0, flatMask, stroke.deposition.z);
  let endInset = capInsetV3(space, seed, 1.0, flatMask, stroke.deposition.z);
  let edgeDepth = space.halfWidthMm - abs(space.acrossMm) - inset;
  let alongStart = space.alongMm - startInset;
  let alongEnd = space.lengthMm - space.alongMm - endInset;
  let aa = max(0.050, space.pixelMm * 0.78);
  let coverage = clamp(
    smoothstep(-aa, aa, edgeDepth) * smoothstep(-aa, aa, alongStart) * smoothstep(-aa, aa, alongEnd),
    0.0,
    1.0,
  );
  let edgeBevel = clamp(space.widthMm * 0.022, 0.12, 0.54);
  let capTaper = clamp(space.widthMm * mix(0.13, 0.080, flatMask), 0.42, 2.70);
  let heightWidth = smoothstep(0.0, edgeBevel, max(0.0, edgeDepth));
  let heightStart = smoothstep(0.0, capTaper, max(0.0, alongStart));
  let heightEnd = smoothstep(0.0, capTaper * 1.20, max(0.0, alongEnd));
  let heightCoverage = clamp(heightWidth * heightStart * heightEnd, 0.0, 1.0);

  let warp = vec2<f32>(
    (fbm2D(vec2<f32>(space.alongMm * 0.037, space.acrossMm * 0.078), seed + 401.0) - 0.5) * 1.65,
    (fbm2D(vec2<f32>(space.alongMm * 0.051, space.acrossMm * 0.105), seed + 409.0) - 0.5) * 0.92,
  );
  let macroNoise = fbm2D(vec2<f32>(space.alongMm * 0.057, space.acrossMm * 0.118) + warp * 0.50, seed + 331.0);
  let pasteRoughness = fbm2D(vec2<f32>(space.alongMm * 0.235, space.acrossMm * 0.46) + warp * 0.66, seed + 419.0);
  let grainNoise = fbm2D(vec2<f32>(space.alongMm * 0.71, space.acrossMm * 1.16) + warp * 0.30, seed + 347.0);
  let pressure = clamp(
    0.80
      + (fbm1D(space.alongMm * 0.047 + seed * 0.011, seed + 9.0) - 0.5) * 0.32
      + (valueNoise1D(space.acrossMm * 0.085 + seed * 0.007, seed + 21.0) - 0.5) * 0.12,
    0.60,
    1.06,
  );
  let macroPaste = macroPasteV7(space, seed);
  let crossProfile = mix(
    0.46 + 0.54 * sqrt(max(0.0, 1.0 - v * v)),
    0.78 + 0.22 * (1.0 - v * v),
    flatMask,
  );
  let acrossTilt = 1.0 + (valueNoise1D(space.alongMm * 0.029 + seed * 0.017, seed + 101.0) - 0.5) * v * 0.22;
  let pasteSwells = smoothstep(0.50, 0.72, pasteRoughness) * mix(0.10, 0.24, macroPaste);
  let pasteHollows = smoothstep(0.55, 0.82, 1.0 - pasteRoughness) * 0.075;
  let massBody = clamp(
    0.20 + macroPaste * 0.64 + (macroNoise - 0.5) * 0.18 + pasteSwells - pasteHollows,
    0.19,
    1.12,
  );
  let body = heightCoverage * crossProfile * massBody * pressure * acrossTilt;

  let bristles = tuftReliefV7(space, seed, macroPaste);
  let tuftRelief = body * (bristles.ridges - bristles.grooves * 0.72);

  let edgeRollSignal = smoothstep(
    0.41,
    0.70,
    fbm1D(space.alongMm * 0.155 + side * 19.0 + seed * 0.019, seed + 861.0 + side),
  );
  let edgeRollBand = exp(-pow((max(0.0, edgeDepth) - 0.42) / 0.44, 2.0) * 1.55);
  let sideLoad = select(0.48, 1.0, side > 1.5);
  let edgeRoll = heightCoverage * edgeRollBand * (0.04 + edgeRollSignal * 0.34)
    * sideLoad * crossProfile * mix(0.70, 1.0, pressure);

  let endHeapNoise = fbm1D(space.acrossMm * 0.28 + seed * 0.019, seed + 853.0);
  let startHeap = smoothstep(0.48, 0.88, endHeapNoise)
    * exp(-pow(max(0.0, alongStart - capTaper * 0.35) / (capTaper * 0.72), 2.0));
  let endHeap = smoothstep(0.40, 0.84, 1.0 - endHeapNoise)
    * exp(-pow(max(0.0, alongEnd - capTaper * 0.28) / (capTaper * 0.62), 2.0));
  let capHeaps = heightCoverage * (startHeap * 0.20 + endHeap * 0.34) * crossProfile * pressure;
  let lip = lipFieldV2(space, seed, side, edgeDepth, alongEnd, body, macroPaste, pressure);
  let shear = draggedPaste(space, seed, macroPaste);
  let grain = (grainNoise - 0.5) * heightCoverage * 0.016;
  let film = coverage * (0.014 + macroNoise * 0.012);
  let relief = max(0.0, film + body + tuftRelief + capHeaps + edgeRoll + lip + grain
    + heightCoverage * (shear.x - shear.y * 0.58));
  var field: PaintField;
  field.coverage = coverage;
  field.heightCoverage = heightCoverage;
  field.relief = relief;
  field.ridges = tuftRelief + capHeaps + edgeRoll + lip * 0.55
    + heightCoverage * (shear.x - shear.y * 0.58);
  field.edgeLip = edgeRoll + lip;
  field.body = body;
  field.pickupScrape = 0.0;
  return field;
}

// Finite, dragged paint parcels and scrape channels. These broad, broken
// tracks follow the tool direction: raised shoulders catch light while the
// cuts reduce both fresh pigment and deposited height over the old layer.
// All dimensions remain in stroke-local millimetres.
fn draggedPaste(space: StrokeSpace, seed: f32, mass: f32) -> vec2<f32> {
  // A shared, warped longitudinal shear field joins finite facets into
  // continuous tool travel. Its broad pressure envelope prevents evenly
  // spaced rails from taking over the paint surface.
  let channelWarp = (fbm1D(space.alongMm * 0.038 + seed * 0.013, seed + 1291.0) - 0.5) * 2.8
    + (fbm1D(space.alongMm * 0.095 + seed * 0.019, seed + 1297.0) - 0.5) * 0.9;
  let shearPhase = space.acrossMm * 0.72 + channelWarp;
  let shearWarp = (fbm2D(vec2<f32>(space.alongMm * 0.052, shearPhase * 0.31), seed + 1299.0) - 0.5) * 0.62;
  let shearNoise = fbm2D(vec2<f32>(space.alongMm * 0.075, shearPhase * 0.78 + shearWarp), seed + 1303.0);
  let shearEnvelope = smoothstep(0.34, 0.70,
    fbm1D(space.alongMm * 0.031 + seed * 0.009, seed + 1309.0));
  let shearLife = shearEnvelope * smoothstep(0.14, 0.48, mass);
  var ridges = max(0.0, shearNoise - 0.57) * 0.46 * shearLife;
  var scrapes = max(0.0, 0.40 - shearNoise) * 0.46 * shearLife;
  let scale = sqrt(clamp(space.widthMm / 16.0, 0.60, 4.0));
  for (var i = 0; i < 8; i += 1) {
    let fi = f32(i);
    let r0 = hash21(vec2<f32>(fi + 3.7, seed + 1301.0));
    let r1 = hash21(vec2<f32>(fi + 11.9, seed + 1307.0));
    let r2 = hash21(vec2<f32>(fi + 23.3, seed + 1319.0));
    let r3 = hash21(vec2<f32>(fi + 37.1, seed + 1321.0));
    let r4 = hash21(vec2<f32>(fi + 49.7, seed + 1327.0));
    let r5 = hash21(vec2<f32>(fi + 61.3, seed + 1331.0));
    let alongCenter = space.lengthMm * mix(0.055, 0.945, r0);
    let halfAlong = clamp(mix(2.2, 9.0, r2) * scale, 1.45, 17.0);
    let halfAcross = clamp(space.widthMm * mix(0.035, 0.105, r3), 0.30, 4.8);
    let acrossCenter = (r1 * 2.0 - 1.0) * space.halfWidthMm * 0.76;
    let drift = (r4 - 0.5) * space.halfWidthMm * 0.20;
    let bend = (valueNoise1D(space.alongMm * 0.16 + fi * 4.9, seed + 1337.0) - 0.5) * halfAcross * 0.48;
    let q = vec2<f32>(
      (space.alongMm - alongCenter) / halfAlong,
      (space.acrossMm + bend - acrossCenter - drift * (space.alongMm / max(space.lengthMm, 0.001) - 0.5)) / halfAcross,
    );
    let faceDistance = pow(pow(abs(q.x), 3.2) + pow(abs(q.y), 3.2), 0.3125);
    let tornEdge = (valueNoise2D(q * 2.0 + vec2<f32>(fi * 7.3, seed * 0.013)) - 0.5) * 0.20;
    let mark = 1.0 - smoothstep(0.78 + tornEdge, 1.06 + tornEdge, faceDistance);
    let load = mix(0.44, 1.0, r5 * r5) * smoothstep(0.10, 0.68, mass);
    if (r4 > 0.22) {
      // The pressed paint leaves wide facets and a raised shoulder, not a
      // repeated comb of thin parallel ridges.
      ridges = max(ridges, mark * mix(0.035, 0.085, r5 * r5) * load);
    } else {
      // Sparse blade cuts expose the previous pigment and flatten the new bed.
      scrapes = max(scrapes, mark * mix(0.045, 0.10, r5) * load);
    }
  }
  return vec2<f32>(ridges, scrapes);
}

fn loadedPaintField(uv: vec2<f32>, pixel: vec2<i32>) -> PaintField {
  let space = strokeSpace(uv);
  let seed = stroke.pigment.w;
  let flatMask = select(0.0, 1.0, stroke.finish.y < 0.5);
  let profileCode = stroke.deposition.x;
  let knifeMask = select(0.0, 1.0, profileCode < 0.5);
  let scumbleMask = select(0.0, 1.0, profileCode > 1.5);
  let edgeRidge = clamp(stroke.deposition.y, 0.0, 1.0);
  let taperEnd = stroke.deposition.z;
  let heightDims = vec2<i32>(textureDimensions(priorHeight));
  let heightPixel = clamp(pixel, vec2<i32>(0), heightDims - vec2<i32>(1));
  let baseHeight = textureLoad(priorHeight, heightPixel, 0).r;
  let peakRadiusPx = i32(clamp(round(0.32 / max(space.pixelMm, 0.001)), 1.0, 6.0));
  let peakLeft = textureLoad(priorHeight, clamp(heightPixel + vec2<i32>(-peakRadiusPx, 0), vec2<i32>(0), heightDims - vec2<i32>(1)), 0).r;
  let peakRight = textureLoad(priorHeight, clamp(heightPixel + vec2<i32>(peakRadiusPx, 0), vec2<i32>(0), heightDims - vec2<i32>(1)), 0).r;
  let peakUp = textureLoad(priorHeight, clamp(heightPixel + vec2<i32>(0, -peakRadiusPx), vec2<i32>(0), heightDims - vec2<i32>(1)), 0).r;
  let peakDown = textureLoad(priorHeight, clamp(heightPixel + vec2<i32>(0, peakRadiusPx), vec2<i32>(0), heightDims - vec2<i32>(1)), 0).r;
  let localBed = (peakLeft + peakRight + peakUp + peakDown) * 0.25;
  let surfacePeak = smoothstep(0.001, 0.009, baseHeight - localBed);
  let v = clamp(uv.y, -1.0, 1.0);
  let side = select(1.0, 2.0, v >= 0.0);
  let edgeDepth = space.halfWidthMm - abs(space.acrossMm) - edgeInsetV3(space, seed, side);
  let alongStart = space.alongMm - capInsetV3(space, seed, 0.0, flatMask, taperEnd);
  let alongEnd = space.lengthMm - space.alongMm - capInsetV3(space, seed, 1.0, flatMask, taperEnd);
  // Derivatives track the actual retained texture resolution, including resize.
  let aa = max(0.025, fwidth(space.acrossMm) * 0.65);
  let endAa = max(0.025, fwidth(space.alongMm) * 0.65);
  let footprint = smoothstep(-aa, aa, edgeDepth)
    * smoothstep(-endAa, endAa, alongStart) * smoothstep(-endAa, endAa, alongEnd);
  let knifeBevel = mix(0.28, 0.15, knifeMask);
  let bevel = max(aa, mix(knifeBevel, 0.36, scumbleMask));
  let taperScale = mix(0.68, 1.25, 1.0 - abs(taperEnd - 1.0));
  let capTaper = clamp(space.widthMm * mix(0.09, 0.035, flatMask) * taperScale, 0.16, 1.80);
  let heightFootprint = smoothstep(0.0, bevel, edgeDepth)
    * smoothstep(0.0, capTaper, alongStart) * smoothstep(0.0, capTaper * 0.72, alongEnd);
  let macroLoad = macroPasteV7(space, seed);
  let drag = draggedPaste(space, seed, macroLoad);
  let thinGround = 1.0 - smoothstep(0.24, 0.62, stroke.document.w);
  let pressure = clamp(
    0.76
      + (fbm1D(space.alongMm * 0.052, seed + 1333.0) - 0.5) * 0.54
      + (valueNoise1D(space.acrossMm * 0.11 + seed * 0.023, seed + 1341.0) - 0.5) * 0.22,
    0.40,
    1.18,
  );
  // Thin underpainting is brushed and scraped into the linen. The directional
  // field is used as pigment opacity and deposited height together, letting the
  // underlying scumble and canvas show through at a few dragged passages.
  let seedOffset = vec2<f32>(seed * 0.017, seed * 0.031);
  let scumbleWarp = vec2<f32>(
    valueNoise2D(vec2<f32>(space.alongMm * 0.085, space.acrossMm * 0.16) + seedOffset) - 0.5,
    valueNoise2D(vec2<f32>(space.alongMm * 0.11, space.acrossMm * 0.22) + seedOffset.yx + vec2<f32>(7.1, 13.7)) - 0.5,
  ) * vec2<f32>(1.8, 0.72);
  let scumbleCoarse = valueNoise2D(
    vec2<f32>(space.alongMm * 0.19, space.acrossMm * 0.62) + scumbleWarp + seedOffset,
  );
  let scumbleDrag = valueNoise2D(
    vec2<f32>(space.alongMm * 0.48, space.acrossMm * 1.45) + scumbleWarp * 0.56 + seedOffset.yx,
  );
  let scumbleBody = scumbleCoarse * 0.68 + scumbleDrag * 0.32;
  let scumblePatch = smoothstep(0.12, 0.83, scumbleBody);
  let scumbleLoad = mix(1.0, 0.42 + 0.58 * scumblePatch, thinGround);
  // Loaded foreground strokes can also be cut back by a few finite brush
  // tracks. The prior pigment shows through those scraped faces instead of
  // every relief channel being painted as a dark stripe.
  let scrapeReveal = smoothstep(0.08, 0.30, drag.y) * mix(0.18, 0.94, 1.0 - thinGround);
  let loadedDeposit = smoothstep(0.10, 0.52, macroLoad * pressure);
  // A loaded impasto stroke is an opaque deposit. Its compressed areas can
  // vary in pigment density, but they should not reveal the previous stroke
  // over the whole face. Coverage only breaks up as the mark approaches a thin
  // scumble or where a real scrape channel cuts through it.
  let thickCoverage = 1.0;
  let layerCoverage = mix(scumbleLoad, thickCoverage, 1.0 - thinGround);
  let directionalStreak = valueNoise2D(
    vec2<f32>(space.alongMm * 0.13, space.acrossMm * 0.78) + vec2<f32>(seed * 0.031, seed * 0.017),
  );
  let streakSignal = smoothstep(0.12, 0.68, directionalStreak);
  let thinStreakLoad = mix(0.58, 0.94, streakSignal);
  // Loaded strokes keep directional variation in pigment value, not in alpha.
  // Gaps in thick paint come from the explicit scrape field below.
  let thickStreakLoad = 1.0;
  let streakLoad = mix(thinStreakLoad, thickStreakLoad, 1.0 - thinGround);
  let thinPressureLoad = mix(0.76, 0.96, loadedDeposit);
  let thickPressureLoad = 1.0;
  let pressureLoad = mix(thinPressureLoad, thickPressureLoad, 1.0 - thinGround);
  let strokeOpacity = clamp(stroke.metrics.y, 0.0, 1.0);
  let effectiveOpacity = mix(strokeOpacity, 1.0, 1.0 - thinGround);
  let scumbleTooth = fbm2D(
    vec2<f32>(space.alongMm * 0.23, space.acrossMm * 0.62)
      + vec2<f32>(seed * 0.021, seed * 0.037), seed + 1391.0,
  ) * 0.62 + fbm2D(
    vec2<f32>(space.alongMm * 0.71, space.acrossMm * 1.72)
      + vec2<f32>(seed * 0.017, seed * 0.029), seed + 1403.0,
  ) * 0.38;
  let scumblePeakCoverage = max(smoothstep(0.48, 0.72, scumbleTooth) * 0.34, surfacePeak);
  let brokenScumble = mix(0.025, 1.0, scumblePeakCoverage);
  let localThickness = heightFootprint * pressure * (0.10 + macroLoad * 0.84);
  let edgeHeightCoverage = mix(0.42, 1.0, smoothstep(0.025, 0.24, localThickness));
  let fractionalEdge = 1.0 - smoothstep(0.34, 0.96, footprint);
  let coverage = footprint * layerCoverage * streakLoad * pressureLoad
    * effectiveOpacity * (1.0 - scrapeReveal) * mix(1.0, brokenScumble, scumbleMask)
    * mix(1.0, edgeHeightCoverage, fractionalEdge);
  let heightCoverage = heightFootprint * scumbleLoad * (1.0 - scrapeReveal * 0.72)
    * mix(1.0, brokenScumble, scumbleMask);
  let domeProfile = 0.48 + 0.52 * sqrt(max(0.0, 1.0 - v * v));
  // Palette-knife paint is a compressed planar face. The edge berms below
  // carry its height instead of rounding the entire slab into a tube.
  let knifeProfile = 0.94 - 0.11 * smoothstep(0.64, 0.98, abs(v));
  let crossProfile = mix(domeProfile, knifeProfile, knifeMask);
  // A low contact film remains between loaded parcels. Most of the height now
  // comes from the irregular macro load, so the cross-section no longer reads
  // as one smooth extruded ribbon.
  let body = heightCoverage * crossProfile * pressure * (0.075 + macroLoad * 0.84);

  // Uneven squeeze-out forms a bank on the loaded side of the brush. Its
  // width and height vary independently and it breaks into finite deposits.
  let edgeLoad = fbm1D(space.alongMm * 0.20 + side * 29.0, seed + 1349.0);
  let edgeRun = smoothstep(0.42, 0.72,
    valueNoise1D(space.alongMm * 0.075 + side * 4.7, seed + 1353.0));
  let bankWidth = clamp(space.widthMm * 0.042, 0.25, 1.10)
    * mix(0.65, 1.35, edgeLoad);
  let bankCenter = bevel + bankWidth * 0.34;
  let bank = exp(-pow((edgeDepth - bankCenter) / bankWidth, 2.0) * 1.7);
  let sideLoad = select(0.38, 1.0, side > 1.5);
  let rimCenter = 0.835 + 0.105 * valueNoise1D(space.alongMm * 0.13 + side * 5.7, seed + 1359.0);
  let rimWander = (fbm1D(space.alongMm * 0.055 + side * 11.3, seed + 1363.0) - 0.5) * 0.07;
  let edgeBerm = exp(-pow((abs(v) - rimCenter - rimWander) / 0.075, 2.0))
    * edgeRidge * knifeMask * (0.18 + 0.36 * edgeLoad);
  let edgeLip = heightCoverage * (
    bank * smoothstep(0.34, 0.72, edgeLoad) * edgeRun * sideLoad * (0.20 + 0.46 * pressure)
    + edgeBerm
  );

  // Paint rolls up where the tool lifts: broad torn caps, with a softer entry.
  let capLoad = valueNoise1D(space.acrossMm * 0.38, seed + 1361.0);
  let capWidth = clamp(space.widthMm * 0.045, 0.22, 1.15);
  let endPile = exp(-pow((alongEnd - capTaper * 0.72) / capWidth, 2.0))
    * (0.16 + 0.40 * smoothstep(0.25, 0.80, capLoad));
  let startPile = exp(-pow((alongStart - capTaper) / (capWidth * 1.3), 2.0))
    * smoothstep(0.40, 0.85, 1.0 - capLoad) * 0.14;
  let terminalBerm = exp(-pow((alongEnd - capTaper * 0.42) / max(0.16, capWidth * 0.72), 2.0))
    * select(0.0, 1.0, taperEnd > 1.5) * edgeRidge * 0.82;
  let capHeaps = heightCoverage * ((endPile + startPile) * crossProfile + terminalBerm * knifeMask);
  let scrapedBody = body * (1.0 - drag.y * 0.62);
  let draggedRelief = heightCoverage * (drag.x * 0.30 - drag.y * 0.18);

  // Fine bristle impressions are shallow and broken by paint load. Filtering
  // fades the subpixel detail rather than turning it into a regular comb.
  let drift = (fbm1D(space.alongMm * 0.12, seed + 1373.0) - 0.5) * 0.9;
  let bristle = valueNoise2D(vec2<f32>(space.alongMm * 0.20 + seed, (space.acrossMm + drift) * 3.6));
  let bristlePatch = fbm2D(vec2<f32>(space.alongMm * 0.17, space.acrossMm * 0.32), seed + 1381.0);
  let resolvable = 1.0 - smoothstep(0.12, 0.38, fwidth(space.acrossMm));
  let striation = (bristle - 0.5) * 0.014 * smoothstep(0.25, 0.65, bristlePatch) * resolvable;
  let film = coverage * 0.010;
  var field: PaintField;
  field.coverage = coverage;
  field.heightCoverage = heightCoverage;
  field.body = body;
  field.edgeLip = edgeLip + capHeaps;
  field.ridges = draggedRelief + field.edgeLip;
  field.relief = max(0.0, film + scrapedBody + field.ridges + heightCoverage * striation)
    * mix(1.0, 0.42, scumbleMask);
  field.pickupScrape = drag.y;
  return field;
}

fn colorField(uv: vec2<f32>, pixel: vec2<i32>, field: PaintField) -> vec3<f32> {
  let space = strokeSpace(uv);
  let seed = stroke.pigment.w;
  let warp = vec2<f32>(
    fbm2D(vec2<f32>(space.alongMm * 0.041, space.acrossMm * 0.093), seed + 157.0) - 0.5,
    fbm2D(vec2<f32>(space.alongMm * 0.057, space.acrossMm * 0.071), seed + 163.0) - 0.5,
  ) * vec2<f32>(1.55, 0.72);
  let broadMix = fbm2D(vec2<f32>(space.alongMm * 0.105, space.acrossMm * 0.175) + warp, seed + 127.0) - 0.5;
  let patchMix = fbm2D(vec2<f32>(space.alongMm * 0.31, space.acrossMm * 0.46) + warp * 0.64, seed + 139.0) - 0.5;
  let granule = valueNoise2D(
    vec2<f32>(space.alongMm * 1.75, space.acrossMm * 2.15) + vec2<f32>(seed * 0.031, seed * 0.017),
  ) - 0.5;
  let laneSignal = valueNoise1D(space.acrossMm * 1.35 + warp.x * 1.8, seed + 149.0) - 0.5;
  let laneBreak = smoothstep(
    0.40,
    0.68,
    fbm2D(vec2<f32>(space.alongMm * 0.14, space.acrossMm * 0.23) + warp * 0.35, seed + 153.0),
  );
  let laneMix = laneSignal * laneBreak;
  let authoredMm = max(field.relief * stroke.document.w, 0.0001);
  let bodyDepth = smoothstep(0.06, 1.30, authoredMm);
  let valueShift = broadMix * 0.072 + patchMix * 0.026 + granule * 0.008 + laneMix * 0.006;
  let chroma = broadMix * 0.020 + patchMix * 0.010 + granule * 0.004 + laneMix * 0.006;
  var pigment = stroke.pigment.rgb;
  pigment += vec3<f32>(valueShift + chroma, valueShift - chroma * 0.35, valueShift - chroma * 0.75);
  let luma = dot(pigment, vec3<f32>(0.2126, 0.7152, 0.0722));
  let saturation = mix(0.92, 1.075, bodyDepth);
  pigment = mix(vec3<f32>(luma), pigment, saturation);
  pigment *= mix(1.025, 0.975, bodyDepth);
  let dispersion = broadMix * patchMix;
  pigment += vec3<f32>(0.006, 0.001, -0.006) * dispersion * 4.0;

  // Broad marbling follows the same warped shear channels as the relief. Its
  // low contrast and irregular field avoid the look of separate painted lines.
  let mixtureAmount = clamp(stroke.mixture.w, 0.0, 1.0);
  let shearWarp = (fbm1D(space.alongMm * 0.038 + seed * 0.013, seed + 1291.0) - 0.5) * 2.8
    + (fbm1D(space.alongMm * 0.095 + seed * 0.019, seed + 1297.0) - 0.5) * 0.9;
  let marbleWarp = (fbm2D(vec2<f32>(space.alongMm * 0.052, (space.acrossMm * 0.72 + shearWarp) * 0.31), seed + 1299.0) - 0.5) * 0.62;
  let marbleField = fbm2D(
    vec2<f32>(space.alongMm * 0.075, (space.acrossMm * 0.72 + shearWarp) * 0.78 + marbleWarp),
    seed + 1303.0,
  );
  let marbleBroad = fbm2D(
    vec2<f32>(space.alongMm * 0.043, (space.acrossMm * 0.72 + shearWarp) * 0.23 + marbleWarp * 0.60),
    seed + 1613.0,
  );
  let marbleBreak = smoothstep(0.28, 0.72, fbm2D(
    vec2<f32>(space.alongMm * 0.12, (space.acrossMm * 0.72 + shearWarp) * 0.34) + marbleWarp * 0.42,
    seed + 1627.0,
  ));
  let marbleMask = smoothstep(0.31, 0.69, marbleBroad * 0.56 + marbleField * 0.44)
    * mix(0.60, 1.0, marbleBreak)
    * smoothstep(0.045, 0.32, field.body);
  let secondaryPigment = clamp(stroke.mixture.rgb, vec3<f32>(0.0), vec3<f32>(1.0));
  let marbleStrength = clamp(pow(mixtureAmount, 0.65) * 1.65, 0.0, 0.95);
  pigment = mix(pigment, secondaryPigment, marbleStrength * marbleMask);
  let freshLinear = srgbToLinear(clamp(pigment, vec3<f32>(0.0), vec3<f32>(1.0)));

  // The retained color target is copied before this pass and fixed-function
  // src-alpha blending applies coverage once. Mix pickup into the source
  // pigment only where the stroke is thin, scraped, or at its contact edge;
  // destination blending then contributes the uncovered fraction exactly once.
  let thinGround = 1.0 - smoothstep(0.24, 0.62, stroke.document.w);
  let edgePickup = 1.0 - smoothstep(0.04, 0.38,
    space.halfWidthMm - abs(space.acrossMm));
  let priorDims = vec2<i32>(textureDimensions(priorSurface));
  let priorPixel = clamp(pixel, vec2<i32>(0), priorDims - vec2<i32>(1));
  let priorPigment = textureLoad(priorSurface, priorPixel, 0).rgb;
  let heightDims = vec2<i32>(textureDimensions(priorHeight));
  let heightPixel = clamp(pixel, vec2<i32>(0), heightDims - vec2<i32>(1));
  let priorHeightValue = textureLoad(priorHeight, heightPixel, 0).r;
  // The untouched linen ranges from 0.006 to at most about 0.031 mm
  // (0.006 base + 0.004 broad tooth + 0.014 * 1.45 thread field). Only
  // deposited paint above that range can be picked up by a later stroke.
  let priorPaintPresence = smoothstep(0.031, 0.050, priorHeightValue);
  let pickupPatch = smoothstep(0.34, 0.72, fbm2D(
    vec2<f32>(space.alongMm * 0.17, space.acrossMm * 0.34) + vec2<f32>(seed * 0.023, seed * 0.029),
    seed + 1643.0,
  ));
  let localizedPickup = clamp(max(field.pickupScrape * 0.52, thinGround * 0.20 * pickupPatch)
    + edgePickup * 0.12, 0.0, 0.42);
  return mix(freshLinear, priorPigment, localizedPickup * priorPaintPresence);
}

struct SurfaceOut {
  @location(0) value: vec4<f32>,
};

@fragment
fn colorFragment(input: VertexOut) -> SurfaceOut {
  let field = loadedPaintField(input.uv, vec2<i32>(input.clipPosition.xy));
  var out: SurfaceOut;
  out.value = vec4<f32>(colorField(input.uv, vec2<i32>(input.clipPosition.xy), field), field.coverage);
  return out;
}

@fragment
fn heightFragment(input: VertexOut) -> SurfaceOut {
  let dims = vec2<i32>(textureDimensions(priorSurface));
  let p = clamp(vec2<i32>(input.clipPosition.xy), vec2<i32>(0), dims - vec2<i32>(1));
  let old = textureLoad(priorSurface, p, 0);
  let paintSpace = strokeSpace(input.uv);
  let field = loadedPaintField(input.uv, p);
  let thickness = min(field.relief * stroke.document.w, 1.25);
  let mmPerPixel = max(stroke.metrics.x, 0.001) / f32(max(dims.x, dims.y));
  let thickAmount = smoothstep(0.16, 0.82, thickness);

  // A loaded, opaque mark does not preserve the complete corrugation of the
  // bed underneath it. It bridges and compacts that relief over its contact
  // patch before adding its own volume. An eight-point radial mean is used so
  // the operation has no screen-axis orientation and cannot create a comb of
  // transverse ghosts at a particular wavelength.
  let contactRadiusMm = clamp(stroke.finish.w * 0.30 + thickness * 0.42, 1.30, 8.00);
  let contactRadiusPx = i32(clamp(round(contactRadiusMm / mmPerPixel), 2.0, 80.0));
  var bedMean = 0.0;
  for (var ringIndex = 0; ringIndex < 8; ringIndex += 1) {
    let angle = f32(ringIndex) * 0.78539816;
    let innerAngle = angle + 0.39269908;
    let outerOffset = vec2<i32>(
      i32(round(cos(angle) * f32(contactRadiusPx))),
      i32(round(sin(angle) * f32(contactRadiusPx))),
    );
    let innerOffset = vec2<i32>(
      i32(round(cos(innerAngle) * f32(contactRadiusPx) * 0.58)),
      i32(round(sin(innerAngle) * f32(contactRadiusPx) * 0.58)),
    );
    let outerPoint = clamp(p + outerOffset, vec2<i32>(0), dims - vec2<i32>(1));
    let innerPoint = clamp(p + innerOffset, vec2<i32>(0), dims - vec2<i32>(1));
    bedMean += textureLoad(priorSurface, outerPoint, 0).r;
    bedMean += textureLoad(priorSurface, innerPoint, 0).r;
  }
  bedMean *= 0.0625;
  let settle = thickAmount * smoothstep(0.16, 0.66, field.heightCoverage) * 0.50;
  let knifeMask = select(0.0, 1.0, stroke.deposition.x < 0.5);
  let planingPressure = clamp(
    0.72 + (fbm1D(paintSpace.alongMm * 0.052, stroke.pigment.w + 1333.0) - 0.5) * 0.54,
    0.40,
    1.18,
  );
  let planing = knifeMask * planingPressure * smoothstep(0.08, 0.62, thickness)
    * smoothstep(0.24, 0.72, field.heightCoverage) * 0.24;
  let supported = mix(mix(old.r, bedMean, settle), bedMean, planing);

  // Thin paint fills valleys first. Sampling an eighth of a millimetre-ish ring
  // isolates the linen and old surface tooth from the broad height beneath it.
  let toothRadiusPx = i32(clamp(round(0.46 / mmPerPixel), 1.0, 8.0));
  let toothLeft = textureLoad(priorSurface, clamp(p + vec2<i32>(-toothRadiusPx, 0), vec2<i32>(0), dims - vec2<i32>(1)), 0).r;
  let toothRight = textureLoad(priorSurface, clamp(p + vec2<i32>(toothRadiusPx, 0), vec2<i32>(0), dims - vec2<i32>(1)), 0).r;
  let toothUp = textureLoad(priorSurface, clamp(p + vec2<i32>(0, -toothRadiusPx), vec2<i32>(0), dims - vec2<i32>(1)), 0).r;
  let toothDown = textureLoad(priorSurface, clamp(p + vec2<i32>(0, toothRadiusPx), vec2<i32>(0), dims - vec2<i32>(1)), 0).r;
  let toothMean = old.r * 0.30 + (toothLeft + toothRight + toothUp + toothDown) * 0.175;
  let crest = clamp((old.r - toothMean) / 0.012, 0.0, 1.0);
  let thinFill = mix(0.46, 1.0, 1.0 - crest);
  let deposited = clamp(supported + thickness * mix(thinFill, 1.0, thickAmount), 0.0, 6.0);
  var out: SurfaceOut;
  // Sequential deposition: the fresh paint adds its authored volume to the
  // retained surface. The only subtraction is the sub-stroke microtexture it
  // physically covers, which prevents older film edges from ghosting through
  // a thick new mark as transverse normal-map bands.
  out.value = vec4<f32>(
    deposited,
    mix(
      old.g,
      clamp(stroke.finish.x + 0.06 * (1.0 - smoothstep(0.18, 0.62, field.body))
        - 0.12 * smoothstep(0.46, 0.88, field.body)
        + 0.12 * smoothstep(0.035, 0.20, field.edgeLip), 0.10, 1.0),
      field.coverage,
    ),
    field.coverage + old.b * (1.0 - field.coverage),
    1.0,
  );
  return out;
}
`;

export const substrateShader = /* wgsl */ `
struct SubstrateParams {
  document: vec4<f32>, // width, height, canvas millimetres, ground roughness
};

@group(0) @binding(0) var<uniform> substrate: SubstrateParams;

struct FullscreenOut {
  @builtin(position) position: vec4<f32>,
  @location(0) uv: vec2<f32>,
};

@vertex
fn fullscreenVertex(@builtin(vertex_index) index: u32) -> FullscreenOut {
  var points = array<vec2<f32>, 3>(vec2<f32>(-1.0, -1.0), vec2<f32>(3.0, -1.0), vec2<f32>(-1.0, 3.0));
  var out: FullscreenOut;
  let p = points[index];
  out.position = vec4<f32>(p, 0.0, 1.0);
  out.uv = vec2<f32>((p.x + 1.0) * 0.5, (1.0 - p.y) * 0.5);
  return out;
}

fn hash21(p: vec2<f32>) -> f32 {
  let q = fract(vec3<f32>(p.xyx) * 0.1031);
  let r = q + vec3<f32>(dot(q, q.yzx + vec3<f32>(33.33)));
  return fract((r.x + r.y) * r.z);
}

fn valueNoise2D(p: vec2<f32>) -> f32 {
  let i = floor(p);
  let f = fract(p);
  let s = f * f * (vec2<f32>(3.0) - 2.0 * f);
  return mix(
    mix(hash21(i), hash21(i + vec2<f32>(1.0, 0.0)), s.x),
    mix(hash21(i + vec2<f32>(0.0, 1.0)), hash21(i + vec2<f32>(1.0, 1.0)), s.x),
    s.y,
  );
}

fn canvasThreads(worldMm: vec2<f32>) -> f32 {
  let warpPhase = worldMm.y * 5.55 + sin(worldMm.x * 0.31) * 0.62;
  let weftPhase = worldMm.x * 6.15 + sin(worldMm.y * 0.27) * 0.71;
  let warp = pow(0.5 + 0.5 * sin(warpPhase), 7.0);
  let weft = pow(0.5 + 0.5 * sin(weftPhase), 7.0);
  let crossing = warp + weft;
  let fiber = valueNoise2D(worldMm * 7.3) * 0.35;
  return crossing * 0.55 + fiber;
}

@fragment
fn substrateFragment(input: FullscreenOut) -> @location(0) vec4<f32> {
  let dims = max(substrate.document.xy, vec2<f32>(1.0));
  let mmPerPixel = substrate.document.z / max(dims.x, dims.y);
  let worldMm = input.position.xy * mmPerPixel;
  let tooth = canvasThreads(worldMm);
  let broad = valueNoise2D(worldMm * 0.68 + vec2<f32>(17.0, 31.0));
  // Linen tooth must remain legible through a thin ground film. These values
  // are millimetres, so they stay an order of magnitude below impasto relief.
  let height = 0.006 + broad * 0.004 + tooth * 0.014;
  let roughness = clamp(substrate.document.w + (tooth - 0.45) * 0.10, 0.0, 1.0);
  return vec4<f32>(height, roughness, 0.0, 1.0);
}
`;

export const lightingShader = /* wgsl */ `
struct LightingParams {
  document: vec4<f32>, // width, height, millimetres across, relief multiplier
  light: vec4<f32>,    // azimuth degrees, elevation degrees, roughness, exposure
  view: vec4<f32>,     // mode: paint 0, color 1, height 2, normal 3
};

@group(0) @binding(0) var colorTexture: texture_2d<f32>;
@group(0) @binding(1) var heightTexture: texture_2d<f32>;
@group(0) @binding(2) var<uniform> params: LightingParams;

struct FullscreenOut {
  @builtin(position) position: vec4<f32>,
  @location(0) uv: vec2<f32>,
};

@vertex
fn fullscreenVertex(@builtin(vertex_index) index: u32) -> FullscreenOut {
  var points = array<vec2<f32>, 3>(vec2<f32>(-1.0, -1.0), vec2<f32>(3.0, -1.0), vec2<f32>(-1.0, 3.0));
  var out: FullscreenOut;
  let p = points[index];
  out.position = vec4<f32>(p, 0.0, 1.0);
  out.uv = vec2<f32>((p.x + 1.0) * 0.5, (1.0 - p.y) * 0.5);
  return out;
}

fn heightAt(p: vec2<i32>, size: vec2<i32>) -> f32 {
  let safe = clamp(p, vec2<i32>(0), size - vec2<i32>(1));
  return textureLoad(heightTexture, safe, 0).r;
}

fn linearToSrgb(c: vec3<f32>) -> vec3<f32> {
  let lo = c * 12.92;
  let hi = 1.055 * pow(max(c, vec3<f32>(0.0)), vec3<f32>(1.0 / 2.4)) - vec3<f32>(0.055);
  return select(lo, hi, c > vec3<f32>(0.0031308));
}

fn distributionGGX(nDotH: f32, alpha: f32) -> f32 {
  let alpha2 = alpha * alpha;
  let denominator = nDotH * nDotH * (alpha2 - 1.0) + 1.0;
  return alpha2 / max(0.00001, 3.14159265 * denominator * denominator);
}

fn visibilitySmith(nDotV: f32, nDotL: f32, alpha: f32) -> f32 {
  let k = alpha * 0.5;
  let geometryV = nDotV / max(0.001, nDotV * (1.0 - k) + k);
  let geometryL = nDotL / max(0.001, nDotL * (1.0 - k) + k);
  return geometryV * geometryL;
}

fn shadowVisibility(p: vec2<i32>, dims: vec2<i32>, h: f32, azimuth: f32, elevation: f32) -> f32 {
  if (params.document.w <= 0.0001) { return 1.0; }
  let mmPerPixel = params.document.z / f32(max(dims.x, dims.y));
  let direction = vec2<f32>(cos(azimuth), -sin(azimuth));
  // Keep cast shadows broad and moderate. The height map is a paint surface,
  // not a blockout mesh: a small sampling error at a steep deposited edge can
  // otherwise produce an ink-dark outline around every stroke.
  let reachMm = clamp(8.0 / max(tan(elevation), 0.10), 4.0, 32.0);
  var occlusion = 0.0;
  for (var i = 1; i <= 28; i += 1) {
    let t = f32(i) / 28.0;
    let distanceMm = max(mmPerPixel, 0.08) + reachMm * t * t;
    let sampleP = vec2<f32>(p) + direction * distanceMm / mmPerPixel;
    if (any(sampleP < vec2<f32>(0.0)) || any(sampleP > vec2<f32>(dims - vec2<i32>(1)))) { break; }
    let base = vec2<i32>(floor(sampleP));
    let f = fract(sampleP);
    let sampleH = mix(
      mix(heightAt(base, dims), heightAt(base + vec2<i32>(1, 0), dims), f.x),
      mix(heightAt(base + vec2<i32>(0, 1), dims), heightAt(base + vec2<i32>(1, 1), dims), f.x),
      f.y,
    ) * params.document.w;
    let rayH = h + distanceMm * tan(elevation);
    let bias = max(0.045, mmPerPixel * 0.28);
    let penumbra = 0.09 + distanceMm * 0.075;
    let blocker = smoothstep(bias, bias + penumbra, sampleH - rayH);
    occlusion = max(occlusion, blocker);
  }
  return 1.0 - 0.52 * occlusion;
}

fn cavityVisibility(p: vec2<i32>, dims: vec2<i32>, h: f32, mmPerPixel: f32) -> f32 {
  // Millimetre-scale hollows under folds receive less fill light. This samples
  // actual deposited relief, without tracing a dark line around each bristle.
  var enclosure = 0.0;
  for (var i = 0; i < 8; i += 1) {
    let angle = f32(i) * 0.78539816;
    let direction = vec2<f32>(cos(angle), sin(angle));
    var horizon = 0.0;
    for (var ring = 0; ring < 2; ring += 1) {
      let distanceMm = select(0.55, 1.65, ring == 1);
      let offset = vec2<i32>(round(direction * distanceMm / mmPerPixel));
      let rise = (heightAt(p + offset, dims) - h) * params.document.w;
      horizon = max(horizon, clamp((rise - 0.04) / distanceMm, 0.0, 1.0));
    }
    enclosure += horizon;
  }
  return 1.0 - enclosure * (0.22 / 8.0);
}

@fragment
fn lightingFragment(input: FullscreenOut) -> @location(0) vec4<f32> {
  let dims = vec2<i32>(textureDimensions(colorTexture));
  let p = clamp(vec2<i32>(input.position.xy), vec2<i32>(0), dims - vec2<i32>(1));
  let color = textureLoad(colorTexture, p, 0).rgb;
  let h = heightAt(p, dims);
  let mode = i32(params.view.x + 0.5);
  if (mode == 1) {
    return vec4<f32>(linearToSrgb(color), 1.0);
  }
  if (mode == 2) {
    // Keep stacked thick marks legible instead of clipping everything at 3 mm.
    let mapped = 1.0 - exp(-max(0.0, h) / 3.0);
    return vec4<f32>(vec3<f32>(mapped), 1.0);
  }

  // A 3x3 Sobel stencil resolves one-pixel paint ridges without the diagonal
  // bias of a wide central difference. Relief is float32 now, so the earlier
  // quantization reason for a two-pixel span no longer applies.
  let hLeft = heightAt(p + vec2<i32>(-1, 0), dims);
  let hRight = heightAt(p + vec2<i32>(1, 0), dims);
  let hUp = heightAt(p + vec2<i32>(0, -1), dims);
  let hDown = heightAt(p + vec2<i32>(0, 1), dims);
  let hUpLeft = heightAt(p + vec2<i32>(-1, -1), dims);
  let hUpRight = heightAt(p + vec2<i32>(1, -1), dims);
  let hDownLeft = heightAt(p + vec2<i32>(-1, 1), dims);
  let hDownRight = heightAt(p + vec2<i32>(1, 1), dims);
  let dx = (hUpRight + 2.0 * hRight + hDownRight) - (hUpLeft + 2.0 * hLeft + hDownLeft);
  let dyDown = (hDownLeft + 2.0 * hDown + hDownRight) - (hUpLeft + 2.0 * hUp + hUpRight);
  let mmPerPixel = params.document.z / f32(max(dims.x, dims.y));
  let slopeX = dx * params.document.w / max(0.0001, 8.0 * mmPerPixel);
  let slopeYUp = -dyDown * params.document.w / max(0.0001, 8.0 * mmPerPixel);
  let normal = normalize(vec3<f32>(-slopeX, -slopeYUp, 1.0));
  if (mode == 3) {
    return vec4<f32>(normal * 0.5 + vec3<f32>(0.5), 1.0);
  }

  let az = radians(params.light.x);
  let el = radians(clamp(params.light.y, 2.0, 88.0));
  let lightDirection = normalize(vec3<f32>(cos(az) * cos(el), sin(az) * cos(el), sin(el)));
  let viewDirection = vec3<f32>(0.0, 0.0, 1.0);
  let halfDirection = normalize(lightDirection + viewDirection);
  let noL = max(0.0, dot(normal, lightDirection));
  let noH = max(0.0, dot(normal, halfDirection));
  let noV = max(0.06, dot(normal, viewDirection));
  let voH = max(0.0, dot(viewDirection, halfDirection));
  let material = textureLoad(heightTexture, p, 0);
  // The deposited material owns most of its finish: thin scumbles stay matte,
  // while thick, compressed paint carries a softer binder sheen. The control
  // remains available as a smaller global adjustment.
  let paintRoughness = clamp(mix(material.g, params.light.z, 0.40), 0.18, 0.92);
  // A moderately sharper binder coat catches broad oil highlights while the
  // floor keeps the lobe resolvable at ordinary canvas zoom levels.
  let coatRoughness = clamp(mix(0.31, 0.62, paintRoughness), 0.29, 0.66);
  let paintAlpha = max(0.012, paintRoughness * paintRoughness);
  let coatAlpha = max(0.0100, coatRoughness * coatRoughness);
  let fresnel0 = 0.045;
  let fresnel = fresnel0 + (1.0 - fresnel0) * pow(1.0 - voH, 5.0);

  let coatDistribution = distributionGGX(noH, coatAlpha);
  let coatVisibility = visibilitySmith(noV, noL, coatAlpha);
  let coatBrdf = coatDistribution * coatVisibility * fresnel / max(0.001, 4.0 * noV * noL);
  let coatKey = select(0.0, coatBrdf * noL * 0.52, noL > 0.0);

  // The softer binder lobe approximates a broad studio source. It remains
  // visible on wide crowns where the sharp clearcoat lobe falls between pixels.
  let paintDistribution = distributionGGX(noH, paintAlpha);
  let paintVisibility = visibilitySmith(noV, noL, paintAlpha);
  let paintBrdf = paintDistribution * paintVisibility * fresnel / max(0.001, 4.0 * noV * noL);
  let paintKey = select(0.0, paintBrdf * noL * 0.34, noL > 0.0);

  let visibility = shadowVisibility(p, dims, h * params.document.w, az, el);
  let cavity = cavityVisibility(p, dims, h, mmPerPixel);
  let upward = clamp(0.5 + 0.5 * normal.z, 0.0, 1.0);
  let fillVisibility = mix(0.72, 1.0, visibility);
  let skyFill = color * (0.115 + 0.075 * upward) * fillVisibility * cavity;

  // Wrapped diffuse keeps pigment color alive in the shadow side. The key and
  // height-driven contact occlusion still determine the visible sculpture.
  let wrappedNdotL = clamp((noL + 0.15) / 1.15, 0.0, 1.0);
  let keyDiffuse = color * wrappedNdotL * visibility * cavity * 0.82;

  // Thin, steep paint edges transmit a small amount of saturated pigment
  // color. The height and normal gates keep this local to scraped edges rather
  // than creating a broad colored halo around an entire stroke.
  let materialCoverage = clamp(material.b, 0.0, 1.0);
  let thinFilm = 1.0 - smoothstep(0.035, 0.34, h * params.document.w);
  let steepEdge = smoothstep(0.16, 0.54, 1.0 - normal.z);
  let edgeTransmission = thinFilm * steepEdge * materialCoverage * 0.11;
  let pigmentLuma = dot(color, vec3<f32>(0.2126, 0.7152, 0.0722));
  let transmittedPigment = color + (color - vec3<f32>(pigmentLuma)) * 0.18;
  let transmission = transmittedPigment * edgeTransmission * (0.35 + 0.65 * upward);

  let reflectionDirection = normalize(reflect(-viewDirection, normal));
  let horizon = clamp(0.5 + 0.5 * reflectionDirection.z, 0.0, 1.0);
  let skyReflection = mix(vec3<f32>(0.045, 0.052, 0.060), vec3<f32>(0.120, 0.132, 0.145), horizon);
  let windowDirection = normalize(vec3<f32>(cos(az) * 0.82, sin(az) * 0.82, 0.70));
  let windowCos = clamp(dot(reflectionDirection, windowDirection), 0.0, 1.0);
  let windowBroad = smoothstep(0.38, 0.94, windowCos);
  let windowCore = smoothstep(0.92, 0.998, windowCos);
  let windowLobe = windowBroad * 0.34 + windowCore * 0.20;
  let fresnelNoV = fresnel0 + (1.0 - fresnel0) * pow(1.0 - noV, 5.0);
  let environment = (skyReflection + vec3<f32>(0.15, 0.155, 0.16) * windowLobe)
    * fresnelNoV * mix(0.58, 1.0, visibility);

  let glintVisibility = mix(0.35, 1.0, visibility);
  let glint = (coatKey + paintKey) * glintVisibility;
  let lightTint = vec3<f32>(1.0, 0.975, 0.935);
  let exposed = clamp((skyFill + keyDiffuse * lightTint + glint * lightTint + environment + transmission) * max(0.05, params.light.w), vec3<f32>(0.0), vec3<f32>(1.0));
  return vec4<f32>(linearToSrgb(exposed), 1.0);
}
`;
