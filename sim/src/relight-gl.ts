/**
 * WebGL2 (GLSL ES 3.00) port of RELIGHT_WGSL in src/relight-gpu.ts, for browsers without WebGPU.
 * Same two passes and the same uniform block (`relightUniforms`, uploaded as `uniform vec4 P[6]`):
 * `RELIGHT_GLSL_FS` writes base colour and unclipped specular into a float target,
 * `RELIGHT_GLSL_COMPOSITE` adds the glow and encodes to sRGB. Every texture read is a `texelFetch`
 * of an unfiltered float texture, so no float-filtering extension is needed; only the HDR target
 * must be renderable (EXT_color_buffer_float, or EXT_color_buffer_half_float for RGBA16F).
 *
 * Rows: textures hold surface row 0 in texel row 0, and the HDR pass writes cell (x, y) at
 * gl_FragCoord (x, y), so both passes index cells directly. Only the composite into the canvas
 * (whose row 0 is at the bottom) flips: `uFlip` = 1 there, 0 into an offscreen read target, which
 * glReadPixels then returns top-down.
 *
 * Keep this in step with RELIGHT_WGSL; `npm run gpu-parity` checks both against the CPU `relight()`.
 */

/** Full-screen triangle from gl_VertexID; no attributes. */
export const RELIGHT_GLSL_VS = /* glsl */ `#version 300 es
void main() {
  vec2 p = vec2(gl_VertexID == 1 ? 3.0 : -1.0, gl_VertexID == 2 ? 3.0 : -1.0);
  gl_Position = vec4(p, 0.0, 1.0);
}`;

/** The relightUniforms() block, named as in the WGSL Params struct. */
const PARAMS = /* glsl */ `
uniform vec4 P[6];
#define uSize (P[0].xy)
#define uDx (P[0].z)
#define uRelief (P[0].w)
#define uAzimuth (P[1].x)
#define uElevation (P[1].y)
#define uOcclusion (P[1].z)
#define uExposure (P[1].w)
#define uMaxH (P[2].x)
#define uView (P[2].y)
#define uGlow (P[2].z)
#define uCoatMin (P[3].x)
#define uMicro (P[3].y)
#define uCrestBoost (P[3].z)
#define uWindow2 (P[3].w)
#define uSpecGain (P[4].x)
#define uSpecAA (P[4].y)
#define uCavityKey (P[4].z)
#define uCavityFill (P[4].w)
#define uRichness (P[5].x)
float encode(float c) {
  float v = clamp(c, 0.0, 1.0);
  if (v <= 0.0031308) { return v * 12.92; }
  return 1.055 * pow(v, 1.0 / 2.4) - 0.055;
}`;

export const RELIGHT_GLSL_FS = /* glsl */ `#version 300 es
precision highp float;
precision highp int;
${PARAMS}
uniform highp sampler2D heightTex;
uniform highp sampler2D colorTex;
out vec4 outColor;
float at(int x, int y) {
  ivec2 c = clamp(ivec2(x, y), ivec2(0), ivec2(uSize) - ivec2(1));
  return texelFetch(heightTex, c, 0).r * uRelief;
}
float atO(int x, int y) {
  ivec2 c = clamp(ivec2(x, y), ivec2(0), ivec2(uSize) - ivec2(1));
  return texelFetch(heightTex, c, 0).g * uRelief;
}
vec2 slopeAt(int x, int y) {
  float gx = (at(x+1,y-1) + 2.0*at(x+1,y) + at(x+1,y+1)) - (at(x-1,y-1) + 2.0*at(x-1,y) + at(x-1,y+1));
  float gy = (at(x-1,y+1) + 2.0*at(x,y+1) + at(x+1,y+1)) - (at(x-1,y-1) + 2.0*at(x,y-1) + at(x+1,y-1));
  return vec2(gx, gy) / (8.0 * uDx);
}
// Math.round rounds halves up; both renderers must pick the same cell.
float jsRound(float v) { return floor(v + 0.5); }
float hash(int a, int b, int c) {
  uint n = (uint(a) * 0x9e3779b1u) ^ (uint(b) * 0x85ebca77u) ^ (uint(c) * 0xc2b2ae3du);
  n = (n ^ (n >> 16u)) * 0x45d9f3bu;
  n = (n ^ (n >> 13u)) * 0x45d9f3bu;
  n = n ^ (n >> 16u);
  return float(n) / 4294967296.0;
}
float smooth01(float t) { float u = clamp(t, 0.0, 1.0); return u * u * (3.0 - 2.0 * u); }
float lobe(float rough, float variance, float noH, float noL, float nz, float fresnel) {
  float alpha = rough * rough;
  float a2 = alpha * alpha + variance;
  float den = noH * noH * (a2 - 1.0) + 1.0;
  float D = a2 / (3.14159265 * den * den);
  float k = alpha * 0.5;
  float gv = nz / (nz * (1.0 - k) + k);
  float gl = noL / (noL * (1.0 - k) + k);
  return D * gv * gl * fresnel / max(0.001, 4.0 * nz * noL) * noL;
}
void main() {
  int x = int(gl_FragCoord.x); int y = int(gl_FragCoord.y);
  float s = at(x, y);
  vec4 tex = texelFetch(colorTex, ivec2(x, y), 0);
  vec3 albedo = tex.rgb; float coat = tex.a;
  float az = radians(uAzimuth); float el = radians(uElevation);
  float cel = cos(el); float sel = sin(el);
  vec3 L = vec3(cos(az) * cel, sin(az) * cel, sel);
  float tanEl = sel / cel;
  vec3 H = normalize(L + vec3(0.0, 0.0, 1.0));
  float fc = 1.0 - H.z;
  float fresnel = 0.045 + 0.955 * fc * fc * fc * fc * fc;
  vec2 g = slopeAt(x, y);
  float nl = sqrt(g.x * g.x + g.y * g.y + 1.0);
  vec3 N = vec3(-g.x, -g.y, 1.0) / nl;
  if (uView > 0.5 && uView < 1.5) { outColor = vec4(encode(albedo.r), encode(albedo.g), encode(albedo.b), 1.0); return; }
  if (uView > 1.5 && uView < 2.5) { float v = s / (s + 2.2); outColor = vec4(v, v, v, 1.0); return; }
  if (uView > 2.5 && uView < 3.5) { outColor = vec4(N * 0.5 + vec3(0.5), 1.0); return; }

  float block = 0.0;
  float so = atO(x, y);
  float reach = min((uMaxH * uRelief - so) / tanEl, 40.0);
  if (reach > uDx) {
    for (int q = 1; q <= 72; q++) {
      float t = float(q) / 72.0;
      float d = uDx + reach * t * (0.35 + 0.65 * t);
      vec2 fp = vec2(float(x), float(y)) + vec2(cos(az), sin(az)) * d / uDx;
      vec2 b = floor(fp); vec2 a = fp - b; ivec2 bi = ivec2(b);
      float a0 = atO(bi.x, bi.y); float a1 = atO(bi.x+1, bi.y); float a2 = atO(bi.x, bi.y+1); float a3 = atO(bi.x+1, bi.y+1);
      float sh = a0 + (a1-a0)*a.x + (a2-a0)*a.y + (a0-a1-a2+a3)*a.x*a.y;
      float over = sh - (so + d * tanEl + 0.03);
      if (over > 0.0) {
        block = max(block, clamp(over / (0.09 + d * 0.07), 0.0, 1.0) * (0.62 + 0.38 * smooth01(d / 1.4)));
        if (block >= 1.0) { break; }
      }
    }
  }
  float visibility = 1.0 - uOcclusion * block;

  float sky = 0.0;
  float radii[3] = float[3](0.45, 1.1, 2.4);
  for (int a = 0; a < 8; a++) {
    float angle = float(a) * 0.78539816;
    float tanH = 0.0;
    for (int q = 0; q < 3; q++) {
      float r = max(1.0, jsRound(radii[q] / uDx + 0.0001));
      int sx = x + int(jsRound(cos(angle) * r)); int sy = y + int(jsRound(sin(angle) * r));
      tanH = max(tanH, (atO(sx, sy) - so) / (r * uDx));
    }
    sky += 1.0 / (1.0 + tanH * tanH);
  }
  sky /= 8.0;
  float ambient = 1.0 - uOcclusion * (1.0 - sky);

  float deepest = 0.0;
  float opposed = 0.0;
  float tightRadii[3] = float[3](0.2, 0.45, 1.0);
  for (int a = 0; a < 4; a++) {
    float angle = float(a) * 0.78539816;
    float one = 0.0; float two = 0.0;
    for (int q = 0; q < 3; q++) {
      float r = max(1.0, jsRound(tightRadii[q] / uDx + 0.0001));
      int ox = int(jsRound(cos(angle) * r)); int oy = int(jsRound(sin(angle) * r));
      one = max(one, (at(x + ox, y + oy) - s) / (r * uDx));
      two = max(two, (at(x - ox, y - oy) - s) / (r * uDx));
    }
    opposed += smooth01((min(one, two) - 0.14) / 0.55);
  }
  float tallest = 0.0;
  float tallR = max(1.0, jsRound(1.2 / uDx + 0.0001));
  for (int a = 0; a < 8; a++) {
    float angle = float(a) * 0.78539816;
    float rise = atO(x + int(jsRound(cos(angle) * tallR)), y + int(jsRound(sin(angle) * tallR))) - so;
    tallest = max(tallest, rise);
    deepest = max(deepest, -rise);
  }
  float cavity = max(opposed / 4.0, smooth01((tallest - 0.75) / 1.5) * 0.6);
  if (uView > 4.5 && uView < 5.5) { outColor = vec4(cavity, cavity, cavity, 1.0); return; }
  float open = 1.0 - cavity;

  float noL = dot(N, L);
  float wrap = 0.3;
  float se = max(sel, 0.25);
  float keyGain = 0.72 * (1.0 + wrap) / (se + wrap);
  float diffuse = clamp((noL + wrap) / (1.0 + wrap), 0.0, 1.0);
  float bounceN = -L.x * N.x * 0.82 / cel - L.y * N.y * 0.82 / cel + 0.57 * N.z;
  float lit = 0.14 * ambient * (0.65 + 0.35 * N.z) * (1.0 - uCavityFill * cavity) + diffuse * keyGain * visibility * (0.7 + 0.3 * ambient) * (1.0 - uCavityKey * cavity) + max(bounceN, 0.0) * 0.17 * open * open + 0.14 * (1.0 - ambient) * open + 0.05 * cavity;
  float spec = 0.0;
  float az2 = radians(uAzimuth + 70.0); float el2 = radians(min(uElevation + 14.0, 75.0));
  vec3 L2 = vec3(cos(az2) * cos(el2), sin(az2) * cos(el2), sin(el2));
  vec3 H2 = normalize(L2 + vec3(0.0, 0.0, 1.0));
  float fc2 = 1.0 - H2.z;
  float fresnel2 = 0.045 + 0.955 * fc2 * fc2 * fc2 * fc2 * fc2;
  float noL2 = dot(N, L2);
  if (noL > 0.0 || noL2 > 0.0) {
    float smoothNoH = max(0.0, dot(N, H));
    vec2 d1 = slopeAt(x+1, y) - slopeAt(x-1, y);
    vec2 d2 = slopeAt(x, y+1) - slopeAt(x, y-1);
    float changeSq = dot(d1, d1) + dot(d2, d2);
    float curved = smooth01((sqrt(changeSq) - 0.15) / 0.5);
    float z2 = N.z * N.z;
    float aa = changeSq * 0.25 * z2 * z2 * 0.3183098861837907 * 2.0;
    float variance = min(0.0009, changeSq * z2 * z2 * 0.004) + uSpecAA * min(aa, 0.18);
    float irradiance = 0.72 / se * 3.14159265;
    float micro = 0.03 + 0.05 * hash(x, y, 17);
    float rough = max(coat + (micro - coat) * curved * (1.0 - smooth01((coat - 0.2) / 0.1)), uCoatMin);
    float sharp1 = 0.0; float sharp2 = 0.0;
    if (curved > 0.0) {
      for (int m = 0; m < 4; m++) {
        float jx = g.x + (hash(x, y, 23 + m * 2) - 0.5) * 0.5 * curved * uMicro;
        float jy = g.y + (hash(x, y, 24 + m * 2) - 0.5) * 0.5 * curved * uMicro;
        float jl = sqrt(jx * jx + jy * jy + 1.0);
        if (noL > 0.0) { sharp1 += lobe(rough, variance, max(0.0, (-jx * H.x - jy * H.y + H.z) / jl), noL, N.z, fresnel); }
        if (noL2 > 0.0) { sharp2 += lobe(rough, variance, max(0.0, (-jx * H2.x - jy * H2.y + H2.z) / jl), noL2, N.z, fresnel2); }
      }
      sharp1 *= 0.25; sharp2 *= 0.25;
    } else if (noL > 0.0) {
      sharp1 = lobe(max(coat, uCoatMin), variance, smoothNoH, noL, N.z, fresnel);
    }
    if (noL > 0.0) { spec += (sharp1 + lobe(0.30, variance, smoothNoH, noL, N.z, fresnel) * 0.05) * irradiance * visibility; }
    if (curved > 0.0 && noL2 > 0.0) { spec += sharp2 * irradiance * uWindow2 * (0.6 + 0.4 * visibility); }
    if (curved > 0.0 && spec > 0.0) {
      float lap = (at(x + 2, y) + at(x - 2, y) + at(x, y + 2) + at(x, y - 2) - 4.0 * s) / (4.0 * uDx * uDx);
      float crest = curved * smooth01(-lap / 3.0) * smooth01((deepest - 0.3) / 1.1);
      spec *= 1.0 + uCrestBoost * crest;
    }
    spec *= uSpecGain;
  }
  float fv = 1.0 - N.z;
  float env = (0.02 + 0.2 * fv * fv) * ambient * 0.22;
  if (uView > 3.5 && uView < 4.5) { float v = encode(spec); outColor = vec4(v, v, v, 1.0); return; }
  float richness = uRichness * cavity;
  vec3 deep = albedo * (vec3(1.0 - richness) + albedo * richness);
  // Above 9 the composite saturates anyway (glow takes min(v - 1, 8)); the cap keeps a half-float
  // target finite.
  outColor = vec4(deep.r * lit + env, deep.g * lit + env * 0.985, deep.b * lit + env * 0.95, min(spec, 60000.0));
}`;

export const RELIGHT_GLSL_COMPOSITE = /* glsl */ `#version 300 es
precision highp float;
precision highp int;
${PARAMS}
uniform highp sampler2D hdrTex;
/** 1 when drawing into the canvas (row 0 at the bottom), 0 into an offscreen read target. */
uniform int uFlip;
out vec4 outColor;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  if (uFlip == 1) { p.y = int(uSize.y) - 1 - p.y; }
  vec4 here = texelFetch(hdrTex, p, 0);
  if (uView > 0.5 && uView < 5.5) { outColor = vec4(here.rgb, 1.0); return; }
  int R = int(ceil(0.7 / uDx - 0.0001));
  float R2 = float(R * R);
  float s1 = 0.1 / uDx; float s2 = 0.3 / uDx;
  float glow = 0.0;
  ivec2 top = ivec2(uSize) - ivec2(1);
  for (int b = -R; b <= R; b++) {
    for (int a = -R; a <= R; a++) {
      float d2 = float(a * a + b * b);
      if (d2 >= R2) { continue; }
      ivec2 q = p + ivec2(a, b);
      if (q.x < 0 || q.y < 0 || q.x > top.x || q.y > top.y) { continue; }
      float v = texelFetch(hdrTex, q, 0).a;
      if (v <= 1.0) { continue; }
      float t1 = 1.0 + d2 / (s1 * s1); float t2 = 1.0 + d2 / (s2 * s2); float win = 1.0 - d2 / R2;
      glow += min(v - 1.0, 8.0) * (0.12 / (t1 * t1) + 0.018 / (t2 * t2)) * win * win;
    }
  }
  float g = glow * uGlow * uExposure;
  if (uView > 5.5) { outColor = vec4(encode(g), encode(g * 0.97), encode(g * 0.92), 1.0); return; }
  outColor = vec4(
    encode((here.r + here.a) * uExposure + g),
    encode((here.g + here.a * 0.985) * uExposure + g * 0.97),
    encode((here.b + here.a * 0.95) * uExposure + g * 0.92),
    1.0);
}`;

/** Context attributes for the viewer's canvas: no MSAA, depth or alpha; one canvas pixel per cell. */
const CONTEXT_ATTRS: WebGLContextAttributes = { alpha: false, antialias: false, depth: false, stencil: false, premultipliedAlpha: false, preserveDrawingBuffer: false };

/** Renderer strings of software rasterisers, which are slower than the viewer's static fallback. */
const SOFTWARE_RENDERER = /swiftshader|llvmpipe|softpipe|lavapipe|software|basic render/i;

export interface GlOptions {
  /** Accept a context that runs on a software rasteriser (SwiftShader, llvmpipe). */
  software?: boolean;
  /** Test hook: pretend these extensions are missing. */
  hideExtensions?: string[];
}

/**
 * The relight passes on a WebGL2 context: the surface as RG32F height and RGBA32F colour textures,
 * an RGBA32F (else RGBA16F) HDR target, and the two programs. Created by `initWebGl2`.
 */
export class GlRelight {
  readonly gl: WebGL2RenderingContext;
  readonly w: number; readonly h: number;
  /** Internal format of the HDR target. */
  readonly hdrFormat: 'RGBA32F' | 'RGBA16F';
  #fs: WebGLProgram; #out: WebGLProgram; #vao: WebGLVertexArrayObject;
  #fsP: WebGLUniformLocation | null; #outP: WebGLUniformLocation | null; #outFlip: WebGLUniformLocation | null;
  #textures: WebGLTexture[]; #hdr: WebGLTexture; #fbo: WebGLFramebuffer;
  #readTex: WebGLTexture | null = null; #readFbo: WebGLFramebuffer | null = null;

  constructor(gl: WebGL2RenderingContext, w: number, h: number, hdrFormat: 'RGBA32F' | 'RGBA16F', fs: WebGLProgram, out: WebGLProgram, vao: WebGLVertexArrayObject, textures: WebGLTexture[], hdr: WebGLTexture, fbo: WebGLFramebuffer) {
    this.gl = gl; this.w = w; this.h = h; this.hdrFormat = hdrFormat;
    this.#fs = fs; this.#out = out; this.#vao = vao; this.#textures = textures; this.#hdr = hdr; this.#fbo = fbo;
    this.#fsP = gl.getUniformLocation(fs, 'P'); this.#outP = gl.getUniformLocation(out, 'P'); this.#outFlip = gl.getUniformLocation(out, 'uFlip');
    gl.useProgram(fs);
    gl.uniform1i(gl.getUniformLocation(fs, 'heightTex'), 0);
    gl.uniform1i(gl.getUniformLocation(fs, 'colorTex'), 1);
    gl.useProgram(out);
    gl.uniform1i(gl.getUniformLocation(out, 'hdrTex'), 2);
  }

  /** Both passes, the composite into the canvas or (`read`) into an RGBA8 target. */
  draw(uniforms: Float32Array, read = false): void {
    const gl = this.gl;
    gl.bindVertexArray(this.#vao);
    gl.viewport(0, 0, this.w, this.h);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.#fbo);
    gl.useProgram(this.#fs);
    gl.uniform4fv(this.#fsP, uniforms);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.#textures[0]);
    gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, this.#textures[1]);
    // The HDR texture is the target here: keep it off every unit while the first pass writes it.
    gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_2D, null);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.bindFramebuffer(gl.FRAMEBUFFER, read ? this.#readTarget() : null);
    gl.useProgram(this.#out);
    gl.uniform4fv(this.#outP, uniforms);
    gl.uniform1i(this.#outFlip, read ? 0 : 1);
    gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_2D, this.#hdr);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  /** Renders offscreen and returns RGBA, top row first, w x h. */
  read(uniforms: Float32Array): Uint8ClampedArray {
    const gl = this.gl;
    this.draw(uniforms, true);
    const out = new Uint8ClampedArray(this.w * this.h * 4);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.#readFbo);
    gl.pixelStorei(gl.PACK_ALIGNMENT, 1);
    gl.readPixels(0, 0, this.w, this.h, gl.RGBA, gl.UNSIGNED_BYTE, out);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return out;
  }

  #readTarget(): WebGLFramebuffer {
    if (this.#readFbo) return this.#readFbo;
    const gl = this.gl;
    this.#readTex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, this.#readTex);
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, this.w, this.h);
    this.#readFbo = gl.createFramebuffer()!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.#readFbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.#readTex, 0);
    gl.bindTexture(gl.TEXTURE_2D, null);
    return this.#readFbo;
  }

  /** Deletes every GL object. The canvas keeps its last frame. */
  dispose(): void {
    const gl = this.gl;
    for (const t of [...this.#textures, this.#hdr, this.#readTex]) if (t) gl.deleteTexture(t);
    gl.deleteFramebuffer(this.#fbo); if (this.#readFbo) gl.deleteFramebuffer(this.#readFbo);
    gl.deleteProgram(this.#fs); gl.deleteProgram(this.#out); gl.deleteVertexArray(this.#vao);
  }
}

interface Pending { p: WebGLProgram; vs: WebGLShader; fs: WebGLShader; name: string }

/** Starts compiling and linking; `finish` reads the result (which waits for it). */
function startProgram(gl: WebGL2RenderingContext, fsSource: string, name: string): Pending {
  const shader = (type: number, src: string) => {
    const s = gl.createShader(type)!;
    gl.shaderSource(s, src); gl.compileShader(s);
    return s;
  };
  const vs = shader(gl.VERTEX_SHADER, RELIGHT_GLSL_VS), fs = shader(gl.FRAGMENT_SHADER, fsSource);
  const p = gl.createProgram()!;
  gl.attachShader(p, vs); gl.attachShader(p, fs); gl.linkProgram(p);
  return { p, vs, fs, name };
}

function finishProgram(gl: WebGL2RenderingContext, { p, vs, fs, name }: Pending): string | null {
  let err: string | null = null;
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
    err = `${name}: ` + ([vs, fs].map((s) => gl.getShaderParameter(s, gl.COMPILE_STATUS) ? '' : gl.getShaderInfoLog(s)).join(' ').trim() || gl.getProgramInfoLog(p) || 'link failed');
  }
  gl.deleteShader(vs); gl.deleteShader(fs);
  return err;
}

const GL_ERRORS: Record<number, string> = { 0x0500: 'INVALID_ENUM', 0x0501: 'INVALID_VALUE', 0x0502: 'INVALID_OPERATION', 0x0505: 'OUT_OF_MEMORY', 0x0506: 'INVALID_FRAMEBUFFER_OPERATION', 0x9242: 'CONTEXT_LOST_WEBGL' };

/**
 * Sets up the relight passes on a WebGL2 context of `canvas` (sized to the surface), or explains
 * why it can't. On failure after the context was created, the context is released and the canvas
 * cannot give another kind of context.
 */
export async function initWebGl2(canvas: HTMLCanvasElement, s: { w: number; h: number; height: Float32Array; color: Float32Array }, opts: GlOptions = {}): Promise<GlRelight | string> {
  if (typeof WebGL2RenderingContext === 'undefined') return 'WebGL2 is not available in this browser';
  let gl: WebGL2RenderingContext | null;
  // failIfMajorPerformanceCaveat lets a browser that knows it would fall back to software say so.
  try { gl = canvas.getContext('webgl2', { ...CONTEXT_ATTRS, failIfMajorPerformanceCaveat: !opts.software }) as WebGL2RenderingContext | null; } catch (e) { return `getContext('webgl2') failed: ${(e as Error).message}`; }
  if (!gl) return 'no WebGL2 context (unsupported or blocked, a software-only renderer, or the canvas already holds another kind of context)';
  const ctx = gl, hidden = new Set(opts.hideExtensions ?? []);
  const ext = <T>(name: string): T | null => hidden.has(name) ? null : ctx.getExtension(name) as T | null;
  const objects: { textures: WebGLTexture[]; programs: WebGLProgram[]; fbos: WebGLFramebuffer[]; vao: WebGLVertexArrayObject | null } = { textures: [], programs: [], fbos: [], vao: null };
  const fail = (why: string) => {
    for (const t of objects.textures) ctx.deleteTexture(t);
    for (const p of objects.programs) ctx.deleteProgram(p);
    for (const f of objects.fbos) ctx.deleteFramebuffer(f);
    if (objects.vao) ctx.deleteVertexArray(objects.vao);
    // Hand the context back now rather than at garbage collection: browsers cap live contexts.
    ctx.getExtension('WEBGL_lose_context')?.loseContext();
    return why;
  };
  try {
    if (ctx.isContextLost()) return fail('the WebGL2 context was lost during setup');
    if (!opts.software) {
      // Chromium and Safari report a masked RENDERER ("WebKit WebGL"); Firefox reports a sanitised
      // real one and deprecates the debug extension, so it is only asked for when masked.
      let renderer = String(ctx.getParameter(ctx.RENDERER) ?? '');
      if (/^webkit webgl$/i.test(renderer)) {
        const dbg = ext<WEBGL_debug_renderer_info>('WEBGL_debug_renderer_info');
        if (dbg) renderer = String(ctx.getParameter(dbg.UNMASKED_RENDERER_WEBGL) ?? renderer);
      }
      if (SOFTWARE_RENDERER.test(renderer)) return fail(`WebGL2 runs on a software renderer (${renderer}), slower than the static fallback`);
    }
    const { w: W, h: H } = s;
    const maxTex = ctx.getParameter(ctx.MAX_TEXTURE_SIZE) as number, vp = ctx.getParameter(ctx.MAX_VIEWPORT_DIMS) as Int32Array;
    const maxDim = Math.min(maxTex, vp[0], vp[1]);
    if (W > maxDim || H > maxDim) return fail(`surface ${W}x${H} exceeds this GPU's WebGL2 texture limit of ${maxDim}`);
    // RGBA32F is renderable with EXT_color_buffer_float; RGBA16F with that or EXT_color_buffer_half_float.
    const formats: ['RGBA32F' | 'RGBA16F', number][] = [];
    const cbf = !!ext('EXT_color_buffer_float'), half = cbf || !!ext('EXT_color_buffer_half_float');
    if (cbf) formats.push(['RGBA32F', ctx.RGBA32F]);
    if (half) formats.push(['RGBA16F', ctx.RGBA16F]);
    if (!formats.length) return fail('WebGL2 has no renderable float target (EXT_color_buffer_float and EXT_color_buffer_half_float are both missing)');

    canvas.width = W; canvas.height = H;
    if (ctx.drawingBufferWidth !== W || ctx.drawingBufferHeight !== H) return fail(`the browser limits this WebGL2 canvas to ${ctx.drawingBufferWidth}x${ctx.drawingBufferHeight}, smaller than the surface's ${W}x${H}`);
    const texture = (format: number, components: number, data: Float32Array) => {
      const t = ctx.createTexture()!;
      objects.textures.push(t);
      ctx.bindTexture(ctx.TEXTURE_2D, t);
      // Unfiltered: float textures are only complete with NEAREST unless OES_texture_float_linear.
      ctx.texParameteri(ctx.TEXTURE_2D, ctx.TEXTURE_MIN_FILTER, ctx.NEAREST);
      ctx.texParameteri(ctx.TEXTURE_2D, ctx.TEXTURE_MAG_FILTER, ctx.NEAREST);
      ctx.texParameteri(ctx.TEXTURE_2D, ctx.TEXTURE_WRAP_S, ctx.CLAMP_TO_EDGE);
      ctx.texParameteri(ctx.TEXTURE_2D, ctx.TEXTURE_WRAP_T, ctx.CLAMP_TO_EDGE);
      ctx.texStorage2D(ctx.TEXTURE_2D, 1, format, W, H);
      if (data) ctx.texSubImage2D(ctx.TEXTURE_2D, 0, 0, 0, W, H, components === 2 ? ctx.RG : ctx.RGBA, ctx.FLOAT, data);
      return t;
    };
    ctx.pixelStorei(ctx.UNPACK_ALIGNMENT, 4);
    ctx.pixelStorei(ctx.UNPACK_FLIP_Y_WEBGL, false);
    ctx.pixelStorei(ctx.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    const ht = texture(ctx.RG32F, 2, s.height), ct = texture(ctx.RGBA32F, 4, s.color);
    let hdr: WebGLTexture | null = null, fbo: WebGLFramebuffer | null = null, hdrFormat: 'RGBA32F' | 'RGBA16F' | null = null;
    const tried: string[] = [];
    for (const [name, format] of formats) {
      const t = ctx.createTexture()!;
      ctx.bindTexture(ctx.TEXTURE_2D, t);
      ctx.texParameteri(ctx.TEXTURE_2D, ctx.TEXTURE_MIN_FILTER, ctx.NEAREST);
      ctx.texParameteri(ctx.TEXTURE_2D, ctx.TEXTURE_MAG_FILTER, ctx.NEAREST);
      ctx.texStorage2D(ctx.TEXTURE_2D, 1, format, W, H);
      const f = ctx.createFramebuffer()!;
      ctx.bindFramebuffer(ctx.FRAMEBUFFER, f);
      ctx.framebufferTexture2D(ctx.FRAMEBUFFER, ctx.COLOR_ATTACHMENT0, ctx.TEXTURE_2D, t, 0);
      const status = ctx.checkFramebufferStatus(ctx.FRAMEBUFFER);
      ctx.bindFramebuffer(ctx.FRAMEBUFFER, null);
      if (status === ctx.FRAMEBUFFER_COMPLETE) { hdr = t; fbo = f; hdrFormat = name; break; }
      tried.push(`${name} 0x${status.toString(16)}`);
      ctx.deleteTexture(t); ctx.deleteFramebuffer(f);
    }
    ctx.bindTexture(ctx.TEXTURE_2D, null);
    if (!hdr || !fbo || !hdrFormat) return fail(`no complete float render target (${tried.join(', ')})`);
    objects.textures.push(hdr); objects.fbos.push(fbo);
    const pending = [startProgram(ctx, RELIGHT_GLSL_FS, 'GLSL relight'), startProgram(ctx, RELIGHT_GLSL_COMPOSITE, 'GLSL composite')];
    objects.programs.push(...pending.map((q) => q.p));
    // The relight shader is long (loops of texel fetches); where the browser can compile it in the
    // background, wait without blocking the page. Otherwise reading LINK_STATUS blocks until done.
    const parallel = ext<{ COMPLETION_STATUS_KHR: number }>('KHR_parallel_shader_compile');
    if (parallel) {
      while (!pending.every((q) => ctx.getProgramParameter(q.p, parallel.COMPLETION_STATUS_KHR))) {
        if (ctx.isContextLost()) return fail('the WebGL2 context was lost while compiling shaders');
        await new Promise((ok) => setTimeout(ok, 8));
      }
    }
    for (const q of pending) { const err = finishProgram(ctx, q); if (err) return fail(err); }
    const [fs, out] = pending.map((q) => q.p);
    const vao = objects.vao = ctx.createVertexArray()!;
    const r = new GlRelight(ctx, W, H, hdrFormat, fs, out, vao, [ht, ct], hdr, fbo);
    const err = ctx.getError();
    if (err !== ctx.NO_ERROR) return fail(`WebGL2 setup failed: ${GL_ERRORS[err] ?? '0x' + err.toString(16)}`);
    if (ctx.isContextLost()) return fail('the WebGL2 context was lost during setup');
    return r;
  } catch (e) {
    return fail(`WebGL2 setup failed: ${(e as Error).message}`);
  }
}
