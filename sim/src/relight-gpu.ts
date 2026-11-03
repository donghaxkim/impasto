/**
 * WebGPU port of src/relight.ts for live light control. The CPU version is the reference.
 * Two passes: `fs` writes base colour and unclipped specular, `composite` adds the glow.
 */
export const RELIGHT_WGSL = /* wgsl */ `
struct Params { size: vec2<f32>, dx: f32, relief: f32, azimuth: f32, elevation: f32, occlusion: f32, exposure: f32, maxH: f32, view: f32, glow: f32, pad: f32 };
@group(0) @binding(0) var heightTex: texture_2d<f32>;
@group(0) @binding(1) var colorTex: texture_2d<f32>;
@group(0) @binding(2) var<uniform> u: Params;
@group(0) @binding(3) var hdrTex: texture_2d<f32>;
@vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4<f32> {
  var p = array<vec2<f32>, 3>(vec2<f32>(-1.0, -1.0), vec2<f32>(3.0, -1.0), vec2<f32>(-1.0, 3.0));
  return vec4<f32>(p[i], 0.0, 1.0);
}
fn at(x: i32, y: i32) -> f32 {
  let c = clamp(vec2<i32>(x, y), vec2<i32>(0), vec2<i32>(u.size) - vec2<i32>(1));
  return textureLoad(heightTex, c, 0).r * u.relief;
}
fn atO(x: i32, y: i32) -> f32 {
  let c = clamp(vec2<i32>(x, y), vec2<i32>(0), vec2<i32>(u.size) - vec2<i32>(1));
  return textureLoad(heightTex, c, 0).g * u.relief;
}
fn slopeAt(x: i32, y: i32) -> vec2<f32> {
  let gx = (at(x+1,y-1) + 2.0*at(x+1,y) + at(x+1,y+1)) - (at(x-1,y-1) + 2.0*at(x-1,y) + at(x-1,y+1));
  let gy = (at(x-1,y+1) + 2.0*at(x,y+1) + at(x+1,y+1)) - (at(x-1,y-1) + 2.0*at(x,y-1) + at(x+1,y-1));
  return vec2<f32>(gx, gy) / (8.0 * u.dx);
}
// Math.round rounds halves up, unlike WGSL round; both renderers must pick the same cell.
fn jsRound(v: f32) -> f32 { return floor(v + 0.5); }
fn encode(c: f32) -> f32 {
  let v = clamp(c, 0.0, 1.0);
  if (v <= 0.0031308) { return v * 12.92; }
  return 1.055 * pow(v, 1.0 / 2.4) - 0.055;
}
fn hash(a: i32, b: i32, c: i32) -> f32 {
  var n = (u32(a) * 0x9e3779b1u) ^ (u32(b) * 0x85ebca77u) ^ (u32(c) * 0xc2b2ae3du);
  n = (n ^ (n >> 16u)) * 0x45d9f3bu;
  n = (n ^ (n >> 13u)) * 0x45d9f3bu;
  n = n ^ (n >> 16u);
  return f32(n) / 4294967296.0;
}
fn smooth01(t: f32) -> f32 { let u = clamp(t, 0.0, 1.0); return u * u * (3.0 - 2.0 * u); }
fn lobe(rough: f32, variance: f32, noH: f32, noL: f32, nz: f32, fresnel: f32) -> f32 {
  let alpha = rough * rough;
  let a2 = alpha * alpha + variance;
  let den = noH * noH * (a2 - 1.0) + 1.0;
  let D = a2 / (3.14159265 * den * den);
  let k = alpha * 0.5;
  let gv = nz / (nz * (1.0 - k) + k);
  let gl = noL / (noL * (1.0 - k) + k);
  return D * gv * gl * fresnel / max(0.001, 4.0 * nz * noL) * noL;
}
@fragment fn fs(@builtin(position) pos: vec4<f32>) -> @location(0) vec4<f32> {
  let x = i32(pos.x); let y = i32(pos.y);
  let s = at(x, y);
  let tex = textureLoad(colorTex, vec2<i32>(x, y), 0);
  let albedo = tex.rgb; let coat = tex.a;
  let az = radians(u.azimuth); let el = radians(u.elevation);
  let cel = cos(el); let sel = sin(el);
  let L = vec3<f32>(cos(az) * cel, sin(az) * cel, sel);
  let tanEl = sel / cel;
  let H = normalize(L + vec3<f32>(0.0, 0.0, 1.0));
  let fc = 1.0 - H.z;
  let fresnel = 0.045 + 0.955 * fc * fc * fc * fc * fc;
  let g = slopeAt(x, y);
  let nl = sqrt(g.x * g.x + g.y * g.y + 1.0);
  let N = vec3<f32>(-g.x, -g.y, 1.0) / nl;
  if (u.view > 0.5 && u.view < 1.5) { return vec4<f32>(encode(albedo.r), encode(albedo.g), encode(albedo.b), 1.0); }
  if (u.view > 1.5 && u.view < 2.5) { let v = s / (s + 2.2); return vec4<f32>(v, v, v, 1.0); }
  if (u.view > 2.5 && u.view < 3.5) { return vec4<f32>(N * 0.5 + vec3<f32>(0.5), 1.0); }

  var block = 0.0;
  let so = atO(x, y);
  let reach = min((u.maxH * u.relief - so) / tanEl, 40.0);
  if (reach > u.dx) {
    for (var q = 1; q <= 72; q += 1) {
      let t = f32(q) / 72.0;
      let d = u.dx + reach * t * (0.35 + 0.65 * t);
      let fp = vec2<f32>(f32(x), f32(y)) + vec2<f32>(cos(az), sin(az)) * d / u.dx;
      let b = floor(fp); let a = fp - b; let bi = vec2<i32>(b);
      let a0 = atO(bi.x, bi.y); let a1 = atO(bi.x+1, bi.y); let a2 = atO(bi.x, bi.y+1); let a3 = atO(bi.x+1, bi.y+1);
      let sh = a0 + (a1-a0)*a.x + (a2-a0)*a.y + (a0-a1-a2+a3)*a.x*a.y;
      let over = sh - (so + d * tanEl + 0.03);
      if (over > 0.0) {
        block = max(block, clamp(over / (0.09 + d * 0.07), 0.0, 1.0) * (0.62 + 0.38 * smooth01(d / 1.4)));
        if (block >= 1.0) { break; }
      }
    }
  }
  let visibility = 1.0 - u.occlusion * block;

  var sky = 0.0;
  let radii = array<f32, 3>(0.45, 1.1, 2.4);
  for (var a = 0; a < 8; a += 1) {
    let angle = f32(a) * 0.78539816;
    var tanH = 0.0;
    for (var q = 0; q < 3; q += 1) {
      let r = max(1.0, jsRound(radii[q] / u.dx + 0.0001));
      let sx = x + i32(jsRound(cos(angle) * r)); let sy = y + i32(jsRound(sin(angle) * r));
      tanH = max(tanH, (atO(sx, sy) - so) / (r * u.dx));
    }
    sky += 1.0 / (1.0 + tanH * tanH);
  }
  sky /= 8.0;
  let ambient = 1.0 - u.occlusion * (1.0 - sky);

  var deepest = 0.0;
  var opposed = 0.0;
  let tightRadii = array<f32, 3>(0.2, 0.45, 1.0);
  for (var a = 0; a < 4; a += 1) {
    let angle = f32(a) * 0.78539816;
    var one = 0.0; var two = 0.0;
    for (var q = 0; q < 3; q += 1) {
      let r = max(1.0, jsRound(tightRadii[q] / u.dx + 0.0001));
      let ox = i32(jsRound(cos(angle) * r)); let oy = i32(jsRound(sin(angle) * r));
      one = max(one, (at(x + ox, y + oy) - s) / (r * u.dx));
      two = max(two, (at(x - ox, y - oy) - s) / (r * u.dx));
    }
    opposed += smooth01((min(one, two) - 0.14) / 0.55);
  }
  var tallest = 0.0;
  let tallR = max(1.0, jsRound(1.2 / u.dx + 0.0001));
  for (var a = 0; a < 8; a += 1) {
    let angle = f32(a) * 0.78539816;
    let rise = atO(x + i32(jsRound(cos(angle) * tallR)), y + i32(jsRound(sin(angle) * tallR))) - so;
    tallest = max(tallest, rise);
    deepest = max(deepest, -rise);
  }
  let cavity = max(opposed / 4.0, smooth01((tallest - 0.75) / 1.5) * 0.6);
  if (u.view > 4.5 && u.view < 5.5) { return vec4<f32>(cavity, cavity, cavity, 1.0); }
  let open = 1.0 - cavity;

  let noL = dot(N, L);
  let wrap = 0.3;
  let se = max(sel, 0.25);
  let keyGain = 0.72 * (1.0 + wrap) / (se + wrap);
  let diffuse = clamp((noL + wrap) / (1.0 + wrap), 0.0, 1.0);
  let bounceN = -L.x * N.x * 0.82 / cel - L.y * N.y * 0.82 / cel + 0.57 * N.z;
  let lit = 0.14 * ambient * (0.65 + 0.35 * N.z) * (1.0 - 0.72 * cavity) + diffuse * keyGain * visibility * (0.7 + 0.3 * ambient) * (1.0 - 0.6 * cavity) + max(bounceN, 0.0) * 0.17 * open * open + 0.14 * (1.0 - ambient) * open + 0.05 * cavity;
  var spec = 0.0;
  let az2 = radians(u.azimuth + 70.0); let el2 = radians(min(u.elevation + 14.0, 75.0));
  let L2 = vec3<f32>(cos(az2) * cos(el2), sin(az2) * cos(el2), sin(el2));
  let H2 = normalize(L2 + vec3<f32>(0.0, 0.0, 1.0));
  let fc2 = 1.0 - H2.z;
  let fresnel2 = 0.045 + 0.955 * fc2 * fc2 * fc2 * fc2 * fc2;
  let noL2 = dot(N, L2);
  if (noL > 0.0 || noL2 > 0.0) {
    let smoothNoH = max(0.0, dot(N, H));
    let d1 = slopeAt(x+1, y) - slopeAt(x-1, y);
    let d2 = slopeAt(x, y+1) - slopeAt(x, y-1);
    let changeSq = dot(d1, d1) + dot(d2, d2);
    let curved = smooth01((sqrt(changeSq) - 0.15) / 0.5);
    let z2 = N.z * N.z;
    let variance = min(0.0009, changeSq * z2 * z2 * 0.004);
    let irradiance = 0.72 / se * 3.14159265;
    let micro = 0.03 + 0.05 * hash(x, y, 17);
    let rough = coat + (micro - coat) * curved * (1.0 - smooth01((coat - 0.2) / 0.1));
    var sharp1 = 0.0; var sharp2 = 0.0;
    if (curved > 0.0) {
      for (var m = 0; m < 4; m += 1) {
        let jx = g.x + (hash(x, y, 23 + m * 2) - 0.5) * 0.5 * curved;
        let jy = g.y + (hash(x, y, 24 + m * 2) - 0.5) * 0.5 * curved;
        let jl = sqrt(jx * jx + jy * jy + 1.0);
        if (noL > 0.0) { sharp1 += lobe(rough, variance, max(0.0, (-jx * H.x - jy * H.y + H.z) / jl), noL, N.z, fresnel); }
        if (noL2 > 0.0) { sharp2 += lobe(rough, variance, max(0.0, (-jx * H2.x - jy * H2.y + H2.z) / jl), noL2, N.z, fresnel2); }
      }
      sharp1 *= 0.25; sharp2 *= 0.25;
    } else if (noL > 0.0) {
      sharp1 = lobe(coat, variance, smoothNoH, noL, N.z, fresnel);
    }
    if (noL > 0.0) { spec += (sharp1 + lobe(0.30, variance, smoothNoH, noL, N.z, fresnel) * 0.05) * irradiance * visibility; }
    if (curved > 0.0 && noL2 > 0.0) { spec += sharp2 * irradiance * 0.55 * (0.6 + 0.4 * visibility); }
    if (curved > 0.0 && spec > 0.0) {
      let lap = (at(x + 2, y) + at(x - 2, y) + at(x, y + 2) + at(x, y - 2) - 4.0 * s) / (4.0 * u.dx * u.dx);
      let crest = curved * smooth01(-lap / 3.0) * smooth01((deepest - 0.3) / 1.1);
      spec *= 1.0 + 2.5 * crest;
    }
  }
  let fv = 1.0 - N.z;
  let env = (0.02 + 0.2 * fv * fv) * ambient * 0.22;
  if (u.view > 3.5 && u.view < 4.5) { let v = encode(spec); return vec4<f32>(v, v, v, 1.0); }
  let richness = 0.35 * cavity;
  let deep = albedo * (vec3<f32>(1.0 - richness) + albedo * richness);
  return vec4<f32>(deep.r * lit + env, deep.g * lit + env * 0.985, deep.b * lit + env * 0.95, spec);
}
@fragment fn composite(@builtin(position) pos: vec4<f32>) -> @location(0) vec4<f32> {
  let p = vec2<i32>(pos.xy);
  let here = textureLoad(hdrTex, p, 0);
  if (u.view > 0.5 && u.view < 5.5) { return vec4<f32>(here.rgb, 1.0); }
  let R = i32(ceil(0.7 / u.dx - 0.0001));
  let R2 = f32(R * R);
  let s1 = 0.1 / u.dx; let s2 = 0.3 / u.dx;
  var glow = 0.0;
  let top = vec2<i32>(u.size) - vec2<i32>(1);
  for (var b = -R; b <= R; b += 1) {
    for (var a = -R; a <= R; a += 1) {
      let d2 = f32(a * a + b * b);
      if (d2 >= R2) { continue; }
      let q = p + vec2<i32>(a, b);
      if (q.x < 0 || q.y < 0 || q.x > top.x || q.y > top.y) { continue; }
      let v = textureLoad(hdrTex, q, 0).a;
      if (v <= 1.0) { continue; }
      let t1 = 1.0 + d2 / (s1 * s1); let t2 = 1.0 + d2 / (s2 * s2); let win = 1.0 - d2 / R2;
      glow += min(v - 1.0, 8.0) * (0.12 / (t1 * t1) + 0.018 / (t2 * t2)) * win * win;
    }
  }
  let g = glow * u.glow * u.exposure;
  if (u.view > 5.5) { return vec4<f32>(encode(g), encode(g * 0.97), encode(g * 0.92), 1.0); }
  return vec4<f32>(
    encode((here.r + here.a) * u.exposure + g),
    encode((here.g + here.a * 0.985) * u.exposure + g * 0.97),
    encode((here.b + here.a * 0.95) * u.exposure + g * 0.92),
    1.0,
  );
}`;
