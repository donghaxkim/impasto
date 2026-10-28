export const surfaceShader = /* wgsl */ `
struct StrokeParams {
  document: vec4<f32>, // width, height, brush width, stroke height (mm)
  pigment: vec4<f32>,  // sRGB r, g, b, seed
  finish: vec4<f32>,   // roughness, brush kind (0 flat, 1 filbert), unused, unused
};

@group(0) @binding(0) var<uniform> stroke: StrokeParams;
@group(0) @binding(1) var priorHeight: texture_2d<f32>;

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

fn srgbToLinear(c: vec3<f32>) -> vec3<f32> {
  let lo = c / 12.92;
  let hi = pow((c + vec3<f32>(0.055)) / 1.055, vec3<f32>(2.4));
  return select(lo, hi, c > vec3<f32>(0.04045));
}

fn laneNoise(u: f32, v: f32, seed: f32, scale: f32) -> f32 {
  let cell = vec2<f32>(u * scale + seed * 0.17, v * 3.0 + seed * 2.7);
  let i = floor(cell);
  let f = fract(cell);
  let smoothWeight = f * f * (vec2<f32>(3.0) - 2.0 * f);
  let a = hash21(i);
  let b = hash21(i + vec2<f32>(1.0, 0.0));
  let c = hash21(i + vec2<f32>(0.0, 1.0));
  let d = hash21(i + vec2<f32>(1.0, 1.0));
  return mix(mix(a, b, smoothWeight.x), mix(c, d, smoothWeight.x), smoothWeight.y);
}

fn valueNoise1D(x: f32, seed: f32) -> f32 {
  let cell = floor(x);
  let f = x - cell;
  let s = f * f * (3.0 - 2.0 * f);
  let a = hash21(vec2<f32>(cell, seed));
  let b = hash21(vec2<f32>(cell + 1.0, seed));
  return mix(a, b, s);
}

fn fbm1D(x: f32, seed: f32) -> f32 {
  var sum = 0.0;
  var amp = 0.5;
  var freq = 1.0;
  for (var octave = 0; octave < 3; octave += 1) {
    sum += amp * valueNoise1D(x * freq, seed + f32(octave) * 37.0);
    amp *= 0.5;
    freq *= 2.0;
  }
  return sum;
}

fn strokeCoverage(uv: vec2<f32>) -> f32 {
  let u = clamp(uv.x, 0.0, 1.0);
  let v = abs(uv.y);
  let seed = stroke.pigment.w;
  let edgeLimit = 0.955 + 0.03 * laneNoise(u * 11.0, 0.5, seed + 77.0, 1.0);
  let edge = 1.0 - smoothstep(edgeLimit, 1.0, v);
  let start = smoothstep(0.0, 0.03, u);
  let end = smoothstep(0.0, 0.08, 1.0 - u);
  return clamp(edge * start * end, 0.0, 1.0);
}

fn colorField(uv: vec2<f32>) -> vec3<f32> {
  // Pigment variation is deliberately unrelated to the impasto height field.
  let u = uv.x;
  let v = uv.y;
  let seed = stroke.pigment.w;
  let broad = laneNoise(u, v, seed + 4.3, 9.0) - 0.5;
  let along = valueNoise1D(u * 3.2, seed + 12.0) - 0.5;
  let variation = vec3<f32>(broad * 0.075 + along * 0.05, broad * 0.055 + along * 0.04, broad * 0.040 + along * 0.03);
  return max(vec3<f32>(0.0), srgbToLinear(clamp(stroke.pigment.rgb + variation, vec3<f32>(0.0), vec3<f32>(1.0))));
}

fn heightField(uv: vec2<f32>) -> f32 {
  let u = clamp(uv.x, 0.0, 1.0);
  let v = clamp(uv.y, -1.0, 1.0);
  let vv = clamp(abs(v), 0.0, 1.0);
  let seed = stroke.pigment.w;
  let flatBrush = stroke.finish.y < 0.5;

  // Cross-section. A rounded filbert dome and a slightly crowned flat top
  // both keep a defined shoulder so the full width carries surface slope.
  let filbertDome = cos(vv * 1.5708);
  let flatBox = 1.0 - smoothstep(0.68, 0.98, vv);
  let profile = select(filbertDome, mix(flatBox, filbertDome, 0.28), flatBrush);
  let crownScale = select(0.80, 0.72, flatBrush);

  // Uneven paint loading along the stroke gives broad deposits and pinched
  // necks, so thickness never reads as a constant ribbon.
  let deposit = 0.74 + 0.34 * fbm1D(u * 3.0, seed + 9.0);
  let body = crownScale * profile * deposit;

  // A few broad folds. The first two are dominant, the rest read as faint
  // partial creases rather than an even comb.
  var folds = 0.0;
  for (var i = 0; i < 4; i += 1) {
    let fi = f32(i);
    let center = (hash21(vec2<f32>(fi + 3.0, seed + 11.0)) - 0.5) * 1.3;
    let width = 0.10 + 0.30 * hash21(vec2<f32>(fi + 29.0, seed + 5.0));
    let amplitude = select(
      select(0.22 + 0.08 * hash21(vec2<f32>(fi + 83.0, seed + 19.0)), 0.15 + 0.07 * hash21(vec2<f32>(fi + 47.0, seed + 17.0)), fi > 0.5),
      0.05 + 0.04 * hash21(vec2<f32>(fi + 107.0, seed + 29.0)),
      fi > 1.5);
    let uStart = 0.04 + 0.42 * hash21(vec2<f32>(fi + 61.0, seed + 2.0));
    let lifespan = 0.38 + 0.50 * hash21(vec2<f32>(fi + 79.0, seed + 31.0));
    let tilt = (hash21(vec2<f32>(fi + 97.0, seed + 43.0)) - 0.5) * 0.45;
    let driftingCenter = center + (u - uStart) * tilt;
    let alongFade = smoothstep(uStart, uStart + 0.18, u) * (1.0 - smoothstep(uStart + lifespan - 0.22, uStart + lifespan, u));
    folds += amplitude * exp(-pow((v - driftingCenter) / width, 2.0) * 1.7) * alongFade;
  }

  // Continuous bristle grooves running most of the stroke. Depth is strongly
  // skewed so only one or two read as prominent ridges while the rest nearly
  // vanish into the paint.
  var bristles = 0.0;
  for (var j = 0; j < 6; j += 1) {
    let ji = f32(j);
    let y = (hash21(vec2<f32>(ji + 101.0, seed + 7.0)) - 0.5) * 1.4;
    let acrossWidth = 0.05 + 0.15 * hash21(vec2<f32>(ji + 157.0, seed + 13.0));
    let depth = 0.05 + 0.24 * pow(hash21(vec2<f32>(ji + 269.0, seed + 61.0)), 3.0);
    let tilt = (hash21(vec2<f32>(ji + 283.0, seed + 67.0)) - 0.5) * 0.6;
    let driftingY = y + (u - 0.5) * tilt;
    let depthProfile = 0.30 + 0.70 * smoothstep(0.12, 0.9, fbm1D(u * 2.2 + ji * 13.7, seed + 71.0));
    let across = exp(-pow((v - driftingY) / acrossWidth, 2.0) * 2.4);
    bristles += depth * depthProfile * across;
  }

  return max(0.0, body + folds + bristles);
}

struct SurfaceOut {
  @location(0) value: vec4<f32>,
};

@fragment
fn colorFragment(input: VertexOut) -> SurfaceOut {
  let alpha = strokeCoverage(input.uv);
  var out: SurfaceOut;
  out.value = vec4<f32>(colorField(input.uv), alpha);
  return out;
}

@fragment
fn heightFragment(input: VertexOut) -> SurfaceOut {
  let alpha = strokeCoverage(input.uv);
  let dims = vec2<i32>(textureDimensions(priorHeight));
  let p = clamp(vec2<i32>(input.clipPosition.xy), vec2<i32>(0), dims - vec2<i32>(1));
  let pixelRadius = max(3.0, f32(max(dims.x, dims.y)) * 0.012);
  let step = pixelRadius * 0.5;
  var support = 0.0;
  var totalWeight = 0.0;
  for (var oy = -2; oy <= 2; oy += 1) {
    for (var ox = -2; ox <= 2; ox += 1) {
      let offset = vec2<f32>(f32(ox) * step, f32(oy) * step);
      let samplePosition = vec2<f32>(p) + offset;
      let p0 = vec2<i32>(floor(samplePosition));
      let f = fract(samplePosition);
      let a = textureLoad(priorHeight, clamp(p0, vec2<i32>(0), dims - vec2<i32>(1)), 0).r;
      let b = textureLoad(priorHeight, clamp(p0 + vec2<i32>(1, 0), vec2<i32>(0), dims - vec2<i32>(1)), 0).r;
      let c = textureLoad(priorHeight, clamp(p0 + vec2<i32>(0, 1), vec2<i32>(0), dims - vec2<i32>(1)), 0).r;
      let d = textureLoad(priorHeight, clamp(p0 + vec2<i32>(1, 1), vec2<i32>(0), dims - vec2<i32>(1)), 0).r;
      let bilinear = mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
      let distanceSq = f32(ox * ox + oy * oy);
      let weight = exp(-distanceSq / 2.5);
      support += bilinear * weight;
      totalWeight += weight;
    }
  }
  support /= totalWeight;
  let oldValue = textureLoad(priorHeight, p, 0);
  let deposit = support + max(0.04, heightField(input.uv) * stroke.document.w);
  var out: SurfaceOut;
  out.value = vec4<f32>(mix(oldValue.r, deposit, alpha), mix(oldValue.g, clamp(stroke.finish.x, 0.0, 1.0), alpha), 0.0, 1.0);
  return out;
}
`;

export const lightingShader = /* wgsl */ `
struct LightingParams {
  document: vec4<f32>, // width, height, millimeters across, relief multiplier
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

fn shadowVisibility(p: vec2<i32>, dims: vec2<i32>, h: f32, azimuth: f32, elevation: f32) -> f32 {
  let mmPerPixel = params.document.z / f32(max(dims.x, dims.y));
  let direction = vec2<f32>(cos(azimuth), -sin(azimuth));
  var occlusion = 0.0;
  for (var i = 1; i <= 6; i += 1) {
    let distanceMm = f32(i) * 0.55;
    let offset = vec2<i32>(round(direction * (distanceMm / max(mmPerPixel, 0.0001))));
    let sampleH = heightAt(p + offset, dims) * params.document.w;
    let rayH = h + distanceMm * tan(elevation);
    let blocker = 1.0 - smoothstep(-0.025, 0.09, rayH - sampleH);
    occlusion = max(occlusion, blocker * (1.0 - f32(i) / 8.0));
  }
  return 1.0 - 0.55 * occlusion;
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
    let mapped = clamp(h / 12.0, 0.0, 1.0);
    return vec4<f32>(vec3<f32>(mapped), 1.0);
  }

  let dx = heightAt(p + vec2<i32>(1, 0), dims) - heightAt(p - vec2<i32>(1, 0), dims);
  let dyDown = heightAt(p + vec2<i32>(0, 1), dims) - heightAt(p - vec2<i32>(0, 1), dims);
  let mmPerPixel = params.document.z / f32(max(dims.x, dims.y));
  let slopeX = dx * params.document.w / max(0.0001, 2.0 * mmPerPixel);
  let slopeYUp = -dyDown * params.document.w / max(0.0001, 2.0 * mmPerPixel);
  let normal = normalize(vec3<f32>(-slopeX, -slopeYUp, 1.0));
  if (mode == 3) {
    return vec4<f32>(normal * 0.5 + vec3<f32>(0.5), 1.0);
  }

  // Local relief curvature and valley occlusion from the retained height field.
  let hLeft = heightAt(p + vec2<i32>(1, 0), dims);
  let hRight = heightAt(p - vec2<i32>(1, 0), dims);
  let hUp = heightAt(p - vec2<i32>(0, 1), dims);
  let hDown = heightAt(p + vec2<i32>(0, 1), dims);
  let laplacian = hLeft + hRight + hUp + hDown - 4.0 * h;
  let crest = clamp(-laplacian * params.document.w / max(0.001, 6.0 * mmPerPixel), -1.0, 1.0);
  let neighborMax = max(max(hLeft, hRight), max(hUp, hDown));
  let valley = clamp((neighborMax - h) / max(0.001, 1.5 * mmPerPixel), 0.0, 1.0);

  let az = radians(params.light.x);
  let el = radians(clamp(params.light.y, 2.0, 88.0));
  let lightDirection = normalize(vec3<f32>(cos(az) * cos(el), sin(az) * cos(el), sin(el)));
  let noL = max(0.0, dot(normal, lightDirection));
  let strokeRoughness = textureLoad(heightTexture, p, 0).g;
  let roughness = clamp(0.30 * params.light.z + 0.35 * strokeRoughness, 0.12, 0.55);
  let halfVector = normalize(lightDirection + vec3<f32>(0.0, 0.0, 1.0));
  let noH = max(0.0, dot(normal, halfVector));
  let voH = max(0.0, dot(vec3<f32>(0.0, 0.0, 1.0), halfVector));
  // Broad, glossy oil sheen. Blinn-Phong gives the raised edges a visible
  // highlight while the Fresnel-like term keeps flat tops more matte.
  let shininess = mix(30.0, 6.0, roughness);
  let sheen = pow(noH, shininess);
  let edge = 0.15 + 0.85 * pow(1.0 - voH, 3.0);
  let specular = vec3<f32>(1.4 * sheen * edge);
  let crestBoost = 1.0 + 1.8 * max(0.0, crest);
  let valleyShade = 1.0 - 0.55 * valley;
  let visibility = shadowVisibility(p, dims, h, az, el);
  let diffuse = color * (1.0 / 3.14159265) * valleyShade * noL * visibility * 2.3;
  let direct = diffuse + specular * crestBoost * noL * visibility * 1.4;
  let ambient = color * 0.13;
  let exposed = clamp((ambient + direct) * max(0.05, params.light.w), vec3<f32>(0.0), vec3<f32>(1.0));
  return vec4<f32>(linearToSrgb(exposed), 1.0);
}
`;
