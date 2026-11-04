import { clamp, dcbrt, fbm1, hash, lerp, noise1, noise2, Noise2Row, smooth } from './dmath.ts';
import type { PaintCanvas } from './canvas.ts';
import { ksFromSrgb, type RGB } from './pigment.ts';

export type Vec2 = readonly [number, number];

export interface ToolSpec {
  kind: 'knife' | 'bristle';
  widthMm: number;
  /** Nodes across the blade or ferrule (64-128). */
  nodes: number;
  seed: number;
}

export interface StrokeSpec {
  points: Vec2[];
  /** Target paint thickness left under the tool, mm. */
  gapMm: number;
  /** Extra depth the tool is pressed below the surface it rides on, mm. Plows wet paint. */
  pressMm?: number;
  seed: number;
  /** Share of the blade in contact, centred (0-1, default 1). A narrower mark from the same tool. */
  engage?: number;
  /**
   * Tapered ends: the share of the stroke's length over which contact narrows to `taperMin` of
   * the engaged width at the head and at the tail. Default [0, 0], square ends.
   */
  taper?: readonly [number, number];
  /** Contact width at the very tip of a taper, as a share of the engaged width (default 0.2). */
  taperMin?: number;
  /** Broken stroke: 0 continuous (default); toward 1 the tool lifts off in more and longer gaps. */
  breaks?: number;
  /**
   * Size of the terminal heap relative to the usual (0-1.5, default 1). Below 1 the knife lifts
   * cleanly and keeps the rest of its bead; above 1 it sheds more of its load at the tip.
   */
  heap?: number;
  /** Strength of the knife's edge profile and nicks, which print as grooves along the stroke (0-1, default 1). */
  edgeFlaws?: number;
  /**
   * Hand pressure along the stroke, as samples spread evenly from start to end (linear between;
   * default [1]). Below 1 only part of the blade touches, so pressure also sets the mark's width
   * (a light touch is narrow, as with a flexing knife tip). With `deposition: 'physical'` it also
   * sets how deep the blade sits, how much paint squeezes out into berms and how much is shed at
   * the lift.
   */
  pressure?: readonly number[];
  /** Blade angle to the canvas, degrees (default 30). Flatter squeezes more paint sideways into berms. */
  attackDeg?: number;
  /** Relative speed (default 1). A fast pass leaves less time for paint to squeeze out sideways. */
  speed?: number;
  /**
   * 'locked' (default): the reference deposition. 'physical': berms and the terminal heap follow
   * pressure, attack angle, speed and the path's curvature (paint is thrown to the outside of a
   * turn). Volume and pigment are conserved either way.
   */
  deposition?: 'locked' | 'physical';
  /**
   * Paint stiffness (yield stress), 0-1 (default 0, the reference wet paint). Stiff paint holds the
   * shape the knife gives it: little slumping or levelling, no fillet where it meets earlier paint
   * and little pigment bleed or pickup there, berms and heaps that stand as sharp-crested lips and
   * creased peaks, and a blade face pressed flat. Volume and pigment are conserved either way.
   */
  stiffness?: number;
}

/** Pressure at a fraction t (0-1) of the stroke, from a sample profile. */
export function pressureAt(profile: readonly number[] | undefined, t: number): number {
  if (!profile || profile.length === 0) return 1;
  if (profile.length === 1) return profile[0];
  const x = clamp(t, 0, 1) * (profile.length - 1), i = Math.floor(x), f = x - i;
  return i >= profile.length - 1 ? profile[profile.length - 1] : profile[i] + (profile[i + 1] - profile[i]) * f;
}
/** Share of the (engaged) blade in contact at a given pressure: a light touch lands only part of the edge. */
export const contactFromPressure = (p: number) => (p >= 1 ? 1 : p <= 0 ? 0.2 : 0.2 + 0.8 * p);

/**
 * Contact width along a stroke as a share of the tool width, at n points from start to end:
 * engagement, tapers and pressure together (edge wobble aside). The simulation uses the same rule.
 */
export function contactProfile(stroke: StrokeSpec, lengthMm: number, n: number): number[] {
  const engage = clamp(stroke.engage ?? 1, 0.05, 1), th = stroke.taper?.[0] ?? 0, tt = stroke.taper?.[1] ?? 0, tm = clamp(stroke.taperMin ?? 0.2, 0.02, 1);
  const out: number[] = [];
  for (let k = 0; k < n; k++) {
    const t = n === 1 ? 0.5 : k / (n - 1), s = t * lengthMm;
    let c = engage;
    if (th > 0 && s < th * lengthMm) c *= tm + (1 - tm) * smooth(s / (th * lengthMm));
    if (tt > 0 && s > lengthMm - tt * lengthMm) c *= tm + (1 - tm) * smooth((lengthMm - s) / (tt * lengthMm));
    if (stroke.pressure) c *= contactFromPressure(pressureAt(stroke.pressure, t));
    out.push(c);
  }
  return out;
}

/**
 * Below this length (mm), a stroke's touch-down and lift-off shrink in proportion, so a short
 * mark still lays paint instead of lifting away before it starts. Longer strokes are unaffected.
 */
export const FULL_LIFT_LENGTH = 24;

export interface StrokeStats {
  lengthMm: number; steps: number;
  /** Volume sent into the side berms and terminal heap, mm^3. */
  bermVolume: number; heapVolume: number; plowedVolume: number;
  /** Cell visits that took the wet path, and the stiction path. */
  wetCells: number; stickCells: number; stickDeposited: number; stickSkipped: number;
}

const OUT = new Float64Array(4);

/**
 * Tool with N nodes. Each node has a reservoir v (mm^3) with pigment p, and a
 * plow wave (the rolling bead pushed along by that part of the edge).
 */
export class Tool {
  readonly spec: ToolSpec; readonly N: number; readonly pitch: number;
  readonly v: Float64Array; readonly p: Float64Array;
  readonly wv: Float64Array; readonly wp: Float64Array;
  readonly offset: Float64Array; readonly nick: Float64Array; readonly z: Float64Array;
  readonly edgeV = [0, 0]; readonly edgeP = [0, 0, 0, 0, 0, 0];
  loaded = 0; readonly loadedP = [0, 0, 0];
  wiped = 0; readonly wipedP = [0, 0, 0];
  capacity = 1; initialLoad = 1;

  constructor(spec: ToolSpec) {
    this.spec = spec; this.N = spec.nodes; this.pitch = spec.widthMm / spec.nodes;
    this.v = new Float64Array(this.N); this.p = new Float64Array(this.N * 3);
    this.wv = new Float64Array(this.N); this.wp = new Float64Array(this.N * 3);
    this.offset = new Float64Array(this.N); this.nick = new Float64Array(this.N); this.z = new Float64Array(this.N);
    this.buildEdge();
  }

  /** Permanent edge profile: nicks on a knife, clumps and splay on a bristle brush. */
  private buildEdge(): void {
    const { N } = this, { seed, kind, widthMm } = this.spec;
    for (let i = 0; i < N; i++) {
      const u = (i + 0.5) / N * 2 - 1, q = u * widthMm * 0.5;
      if (kind === 'knife') {
        const o = 0.05 * (1 - u * u) + (noise1(q * 0.9, seed, 5) - 0.5) * 0.05;
        this.nick[i] = (noise1(q * 7, seed, 6) - 0.5) * 0.012;
        for (let k = 0; k < 4; k++) {
          const center = (hash(seed, k, 11) * 2 - 1) * widthMm * 0.46;
          const wide = 0.12 + hash(seed, k, 12) * 0.32;
          const depth = 0.06 + hash(seed, k, 13) * hash(seed, k, 14) * 0.42;
          const d = (q - center) / wide;
          if (d * d < 9) this.nick[i] += depth / (1 + d * d * d * d);
        }
        this.offset[i] = o;
      } else {
        const clump = noise1(q * 0.75, seed, 5) * 0.62 + noise1(q * 1.9, seed, 6) * 0.38;
        this.offset[i] = (clump - 0.5) * 0.7 + (noise1(q * 3.1, seed, 7) - 0.5) * 0.24 + (noise1(q * 7.5, seed, 8) - 0.5) * 0.16;
      }
    }
  }

  /**
   * Pre-load unmixed bands of primary and secondary pigment. Each node starts with
   * one pigment only, so colour mixes on the canvas and not on the palette.
   */
  load(volumePerNode: number, primary: RGB, secondary: RGB, secondaryFraction: number, seed: number, capacityRatio = 0.9): void {
    const a = ksFromSrgb(primary), b = ksFromSrgb(secondary);
    const { N } = this, { kind, widthMm } = this.spec;
    const bandFreq = kind === 'knife' ? 0.45 : 1.5;
    for (let i = 0; i < N; i++) {
      const q = (i + 0.5) / N * widthMm;
      const band = fbm1(q * bandFreq, seed, 21);
      const pigment = band < 0.5 + (secondaryFraction - 0.5) * 0.42 ? b : a;
      const vol = volumePerNode * (0.62 + 0.76 * noise1(q * (kind === 'knife' ? 0.55 : 1.4), seed, 22));
      this.v[i] += vol; this.loaded += vol;
      for (let k = 0; k < 3; k++) { this.p[i * 3 + k] += pigment[k] * vol; this.loadedP[k] += pigment[k] * vol; }
    }
    this.capacity = volumePerNode * capacityRatio;
    this.initialLoad = volumePerNode;
  }

  /**
   * Load paint whose colour varies across the blade, the way a knife picks up a partly mixed pile:
   * `profile` gives colours from one blade end (node 0) to the other, and streaks of `secondary`
   * run through it as in `load`. `mix` 0 keeps the colours in crisp interleaved streaks; 1 blends
   * them into a smooth gradient with soft-edged streaks.
   */
  loadProfile(volumePerNode: number, profile: readonly RGB[], secondary: RGB, secondaryFraction: number, mix: number, seed: number, capacityRatio = 0.9): void {
    const K = profile.length, ks = profile.map((c) => ksFromSrgb(c)), b = ksFromSrgb(secondary);
    const { N } = this, { kind, widthMm } = this.spec;
    const bandFreq = kind === 'knife' ? 0.45 : 1.5, m = mix < 0 ? 0 : mix > 1 ? 1 : mix;
    const thr = 0.5 + (secondaryFraction - 0.5) * 0.42, soft = 0.02 + 0.2 * m;
    const pig = [0, 0, 0];
    for (let i = 0; i < N; i++) {
      const q = (i + 0.5) / N * widthMm;
      // Where across the blade this node draws from: wandering a little, in streaks.
      const u = ((i + 0.5) / N + (fbm1(q * 0.8, seed, 23) - 0.5) * 0.35 * (1 - m)) * K - 0.5;
      const k0 = u <= 0 ? 0 : u >= K - 1 ? K - 2 : Math.floor(u), f = K < 2 ? 0 : u <= 0 ? 0 : u >= K - 1 ? 1 : u - k0;
      // Crisp: the nearer sample; mixed: the blend of the two.
      const near = f < 0.5 ? 0 : 1, wgt = K < 2 ? 0 : near + (f - near) * m;
      const a0 = ks[K < 2 ? 0 : k0], a1 = ks[K < 2 ? 0 : k0 + 1];
      const band = fbm1(q * bandFreq, seed, 21);
      const t = band < thr - soft ? 1 : band > thr + soft ? 0 : (thr + soft - band) / (2 * soft);
      for (let k = 0; k < 3; k++) pig[k] = (a0[k] + (a1[k] - a0[k]) * wgt) * (1 - t) + b[k] * t;
      const vol = volumePerNode * (0.62 + 0.76 * noise1(q * (kind === 'knife' ? 0.55 : 1.4), seed, 22));
      this.v[i] += vol; this.loaded += vol;
      for (let k = 0; k < 3; k++) { this.p[i * 3 + k] += pig[k] * vol; this.loadedP[k] += pig[k] * vol; }
    }
    this.capacity = volumePerNode * capacityRatio;
    this.initialLoad = volumePerNode;
  }

  /** Wipe a fraction of the remaining paint off on a rag. */
  wipe(fraction: number): void {
    for (let i = 0; i < this.N; i++) {
      const dv = this.v[i] * fraction;
      this.wiped += dv; this.v[i] -= dv;
      for (let k = 0; k < 3; k++) { const m = this.p[i * 3 + k] * fraction; this.wipedP[k] += m; this.p[i * 3 + k] -= m; }
    }
  }

  residual(): number {
    let s = this.edgeV[0] + this.edgeV[1];
    for (let i = 0; i < this.N; i++) s += this.v[i] + this.wv[i];
    return s;
  }
  residualPigment(): [number, number, number] {
    const out: [number, number, number] = [this.edgeP[0] + this.edgeP[3], this.edgeP[1] + this.edgeP[4], this.edgeP[2] + this.edgeP[5]];
    for (let i = 0; i < this.N; i++) for (let k = 0; k < 3; k++) out[k] += this.p[i * 3 + k] + this.wp[i * 3 + k];
    return out;
  }
}

function catmull(a: number, b: number, c: number, d: number, t: number): number {
  return 0.5 * (2 * b + (c - a) * t + (2 * a - 5 * b + 4 * c - d) * t * t + (3 * b - a - 3 * c + d) * t * t * t);
}
function resample(points: Vec2[], ds: number) {
  const dense: number[] = [];
  for (let s = 0; s < points.length - 1; s++) {
    const p0 = points[Math.max(0, s - 1)], p1 = points[s], p2 = points[s + 1], p3 = points[Math.min(points.length - 1, s + 2)];
    for (let i = 0; i < 64; i++) { const t = i / 64; dense.push(catmull(p0[0], p1[0], p2[0], p3[0], t), catmull(p0[1], p1[1], p2[1], p3[1], t)); }
  }
  const last = points[points.length - 1]; dense.push(last[0], last[1]);
  const xs: number[] = [dense[0]], ys: number[] = [dense[1]];
  let carry = 0;
  for (let i = 2; i < dense.length; i += 2) {
    let ax = dense[i - 2], ay = dense[i - 1];
    const bx = dense[i], by = dense[i + 1];
    let seg = Math.sqrt((bx - ax) * (bx - ax) + (by - ay) * (by - ay));
    while (carry + seg >= ds) {
      const f = (ds - carry) / seg;
      ax += (bx - ax) * f; ay += (by - ay) * f;
      xs.push(ax); ys.push(ay);
      seg = Math.sqrt((bx - ax) * (bx - ax) + (by - ay) * (by - ay));
      carry = 0;
    }
    carry += seg;
  }
  return { xs, ys };
}

/**
 * Length of tool face in contact with the paint, mm. A short mark is made with the tip, so below
 * FULL_LIFT_LENGTH the contact shortens with the stroke (down to 35%).
 */
export const contactLength = (kind: ToolSpec['kind'], strokeMm = Infinity) =>
  (kind === 'knife' ? 12 : 10) * (strokeMm < FULL_LIFT_LENGTH ? Math.max(0.35, strokeMm / FULL_LIFT_LENGTH) : 1);
/**
 * Load a node needs, mm^3, before paint yields and flows off it as a wet sheet. Below this the
 * tool drags and only touches peaks. Planners should load well above it.
 */
export const yieldVolume = (kind: ToolSpec['kind'], pitch: number, strokeMm = Infinity) => pitch * contactLength(kind, strokeMm) * 0.3;

let stampCounter = 1;
const stamps = new Map<PaintCanvas, Int32Array>();
const passStamps = new Map<PaintCanvas, Int32Array>();
const faceStamps = new Map<PaintCanvas, Int32Array>();
let passCounter = 0;
/** Per-cell cache of the wet-face roughness noise for the current stroke (keyed by passId). */
const roughStamps = new Map<PaintCanvas, Int32Array>();
const roughNoise = new Map<PaintCanvas, Float64Array>();

// Noise rows reused by every stroke: the step's noise along the blade is one row of the lattice,
// so its hashes are computed once per step instead of once per cell or node (see Noise2Row).
const nickRow = new Noise2Row(), wanderRow = new Noise2Row();
const thrRowA = new Noise2Row(), thrRowB = new Noise2Row();
const swirlRow0 = new Noise2Row(), swirlRow1 = new Noise2Row(), swirlRow2 = new Noise2Row();
const breakRow0 = new Noise2Row(), breakRow1 = new Noise2Row();
const psiRowP0 = new Noise2Row(), psiRowP1 = new Noise2Row(), psiRowP2 = new Noise2Row();
const psiRowM0 = new Noise2Row(), psiRowM1 = new Noise2Row(), psiRowM2 = new Noise2Row();
/** The lateral swirl at blade offset q, from the step's three swirl rows (the same sum as before). */
const swirlAt = (q: number) => (swirlRow0.at(q * 0.45 + 5) - 0.5) + 0.6 * (swirlRow1.at(q * 1.2 + 2) - 0.5) + 0.4 * (swirlRow2.at(q * 3.1 + 8) - 0.5);
/**
 * out[i] = psi(map[i] * pitch) for the stream function psi(q, at) = 0.9 n2(q*0.38+11, at*0.085) +
 * 0.38 n2(q*1.05, at*0.24) + 0.13 n2(q*2.7, at*0.7), given its three rows at one `at`.
 */
function psiFill(out: Float64Array, map: Float64Array, pitch: number, N: number, r0: Noise2Row, r1: Noise2Row, r2: Noise2Row): void {
  for (let i = 0; i < N; i++) {
    const q = map[i] * pitch;
    out[i] = 0.9 * r0.at(q * 0.38 + 11) + 0.38 * r1.at(q * 1.05) + 0.13 * r2.at(q * 2.7);
  }
}
/** Neighbour ring for the stiction test, as (x, y) unit offsets. */
const RING_X = [1, -1, 0, 0, 0.7, -0.7, 0.7, -0.7], RING_Y = [0, 0, 1, -1, 0.7, 0.7, -0.7, -0.7];
const ringDx = new Int32Array(8), ringDy = new Int32Array(8);

/**
 * The state of one stroke in progress, shared by the per-step passes below. Keeping each pass a
 * function of its own (rather than one 500-line body) keeps every optimised unit small, so the
 * JIT compiles each quickly, a rarely taken branch in one pass does not throw away the compiled
 * code of the others, and the small helpers each pass calls still get inlined into it.
 */
class StrokeRun {
  // Fixed for the stroke.
  readonly canvas: PaintCanvas; readonly tool: Tool; readonly stroke: StrokeSpec; readonly stats: StrokeStats;
  readonly N: number; readonly M: number; readonly CW: number; readonly CH: number;
  readonly dx: number; readonly ds: number; readonly W: number; readonly pitch: number; readonly area: number; readonly L: number;
  readonly knife: boolean; readonly physical: boolean; readonly seed: number; readonly stiff: number;
  readonly steps: number; readonly xs: number[]; readonly ys: number[];
  readonly flex: number; readonly lateral: number; readonly swapRate: number; readonly squeezeRate: number; readonly squeezeShare: number;
  readonly contactLen: number; readonly lift: number; readonly breaks: number; readonly flaws: number; readonly sideBias: number;
  readonly volThreshold: number; readonly heapScale: number; readonly attackF: number; readonly speedF: number; readonly liftP: number;
  readonly take: number; readonly edgeStoreCap: number; readonly waveCap: number; readonly shedCap: number;
  readonly turbulence: number; readonly crossMix: number; readonly stir: number;
  readonly qLo: number; readonly qHi: number; readonly qMax: number;
  readonly passId: number; readonly stamp: Int32Array; readonly pass: Int32Array; readonly face: Int32Array;
  readonly roughStamp: Int32Array; readonly roughCache: Float64Array;
  readonly start: Float64Array; readonly end: Float64Array; readonly dumped: Uint8Array;
  readonly S: Float64Array; readonly blur: Float64Array; readonly zPrev: Float64Array; readonly texture: Float64Array;
  readonly map: Float64Array; readonly thrA: Float64Array; readonly thrB: Float64Array; readonly gate: Float64Array; readonly wanderN: Float64Array;
  readonly psiP: Float64Array; readonly psiM: Float64Array; readonly moving: Float64Array;
  readonly allowance: number[]; readonly sinceEmit: number[]; readonly bermArea: number[];
  readonly faceCells: number[] = [];
  // Running state.
  support = NaN;
  x1: number; y1: number; x2 = 0; y2 = 0;

  constructor(canvas: PaintCanvas, tool: Tool, stroke: StrokeSpec, stats: StrokeStats, xs: number[], ys: number[], ds: number, L: number) {
    const { dx } = canvas;
    const { N, pitch } = tool;
    const W = tool.spec.widthMm, knife = tool.spec.kind === 'knife';
    const seed = stroke.seed;
    this.canvas = canvas; this.tool = tool; this.stroke = stroke; this.stats = stats;
    this.xs = xs; this.ys = ys; this.steps = xs.length; this.ds = ds; this.L = L;
    this.N = N; this.pitch = pitch; this.W = W; this.knife = knife; this.seed = seed; this.dx = dx;
    this.CW = canvas.w; this.CH = canvas.h;

    let stamp = stamps.get(canvas);
    if (!stamp) { stamp = new Int32Array(canvas.n); stamps.set(canvas, stamp); }
    let pass = passStamps.get(canvas);
    if (!pass) { pass = new Int32Array(canvas.n); passStamps.set(canvas, pass); }
    this.passId = ++passCounter;
    let face = faceStamps.get(canvas);
    if (!face) { face = new Int32Array(canvas.n); faceStamps.set(canvas, face); }
    let roughStamp = roughStamps.get(canvas);
    if (!roughStamp) { roughStamp = new Int32Array(canvas.n); roughStamps.set(canvas, roughStamp); }
    let roughCache = roughNoise.get(canvas);
    if (!roughCache) { roughCache = new Float64Array(canvas.n); roughNoise.set(canvas, roughCache); }
    this.stamp = stamp; this.pass = pass; this.face = face; this.roughStamp = roughStamp; this.roughCache = roughCache;
    this.area = dx * dx;
    this.M = Math.ceil(W / (dx * 0.45));

    // Paint behaviour. Knife: stiff edge, strong plow. Bristle: flexible hairs, more retained.
    this.flex = knife ? 0.02 : 0.62;
    this.lateral = knife ? 0.42 : 0.16;
    const pickupFraction = knife ? 0.14 : 0.30;
    this.swapRate = knife ? 0.92 : 0.8;
    this.squeezeRate = knife ? 0.0022 : 0.0009;
    this.contactLen = contactLength(tool.spec.kind, L);
    // Touch-down and lift-off scale with the stroke below FULL_LIFT_LENGTH, so short marks deposit.
    const lift = L < FULL_LIFT_LENGTH ? L / FULL_LIFT_LENGTH : 1;
    this.lift = lift;
    this.breaks = clamp(stroke.breaks ?? 0, 0, 1);
    this.flaws = clamp(stroke.edgeFlaws ?? 1, 0, 1);
    this.sideBias = 0.5 + (hash(seed, 3, 91) - 0.5) * 0.56;
    // Yield stress is a property of the paint, so this is an absolute load, not a share of the start;
    // only the contact patch shrinks for a short mark made with the tip.
    this.volThreshold = yieldVolume(tool.spec.kind, pitch, L);
    this.heapScale = clamp(stroke.heap ?? 1, 0, 1.5);
    this.squeezeShare = knife ? 0.17 : 0.06;
    // Physical deposition: how much paint a blade squeezes sideways grows as it lies flatter
    // (attack 30 degrees is the reference) and shrinks for a quick pass.
    const physical = stroke.deposition === 'physical';
    this.physical = physical;
    this.attackF = physical ? clamp((90 - (stroke.attackDeg ?? 30)) / 60, 0.25, 1.4) : 1;
    this.speedF = physical ? 1 / Math.sqrt(clamp(stroke.speed ?? 1, 0.25, 4)) : 1;
    // Pressure at the lift decides how much of the bead and load drops as the terminal heap.
    this.liftP = physical ? clamp(pressureAt(stroke.pressure, 1), 0, 1.5) : 1;
    const ringR = Math.max(2, Math.round(0.45 / dx));
    for (let k = 0; k < 8; k++) { ringDx[k] = Math.round(RING_X[k] * ringR); ringDy[k] = Math.round(RING_Y[k] * ringR); }
    const stiff = clamp(stroke.stiffness ?? 0, 0, 1);
    this.stiff = stiff;
    // Stiff paint: less of what the knife plows up joins its load, so its colour stays clean.
    this.take = stiff > 0 ? pickupFraction * (1 - 0.7 * stiff) : pickupFraction;

    const start = new Float64Array(N), end = new Float64Array(N);
    for (let i = 0; i < N; i++) {
      const q = (i + 0.5) * pitch;
      start[i] = fbm1(q * 0.5, seed, 31) * (knife ? 1.2 : 3.0) * lift;
      end[i] = L - (fbm1(q * 0.3, seed, 32) * (knife ? 6.0 : 12.0) + noise1(q * 1.6, seed, 33) * (knife ? 2.0 : 4.0)) * lift;
    }
    this.start = start; this.end = end; this.dumped = new Uint8Array(N);

    this.x1 = canvas.w; this.y1 = canvas.h;
    this.S = new Float64Array(N); this.blur = new Float64Array(N);
    this.moving = new Float64Array(4);
    this.allowance = [0.1, 0.1]; this.sinceEmit = [0, 0]; this.bermArea = [0, 0];
    this.edgeStoreCap = knife ? 2.2 : 1.2;
    this.waveCap = pitch * (knife ? 2.2 : 1.1);
    this.shedCap = pitch * (knife ? 7.0 : 2.4);
    this.zPrev = new Float64Array(N); this.texture = new Float64Array(N);
    // Flow map: each node draws paint from the reservoir position carried here by the shear flow.
    const map = new Float64Array(N);
    for (let i = 0; i < N; i++) map[i] = i;
    this.map = map;
    this.turbulence = knife ? 3.0 : 1.4; this.crossMix = knife ? 0.0005 : 0.0003; this.stir = knife ? 15 : 6;
    // Per-step noise along the blade, one value per node: the yield-threshold factors, the nick gate
    // and (bristle) the wander. Every cell under a node shares them, so they are filled once per step.
    this.thrA = new Float64Array(N); this.thrB = new Float64Array(N); this.gate = new Float64Array(N); this.wanderN = new Float64Array(N);
    this.psiP = new Float64Array(N); this.psiM = new Float64Array(N);
    // Lateral range of cell centres under the blade (samples span the blade; a centre lies within a cell of its sample).
    this.qLo = -W * 0.5 - dx; this.qHi = W * 0.5 + dx; this.qMax = (N - 1) * pitch;
  }
}

export function paintStroke(canvas: PaintCanvas, tool: Tool, stroke: StrokeSpec): StrokeStats {
  const { dx } = canvas;
  const { N, z } = tool;
  const knife = tool.spec.kind === 'knife';
  const seed = stroke.seed;
  const ds = dx * 0.4;
  const { xs, ys } = resample(stroke.points, ds);
  const steps = xs.length;
  const L = (steps - 1) * ds;
  const stats: StrokeStats = { lengthMm: L, steps, bermVolume: 0, heapVolume: 0, plowedVolume: 0, wetCells: 0, stickCells: 0, stickDeposited: 0, stickSkipped: 0 };
  if (steps < 4) return stats;

  canvas.beginStroke();
  const r = new StrokeRun(canvas, tool, stroke, stats, xs, ys, ds, L);
  const { W, physical, qLo, qHi, breaks, zPrev } = r;
  const liftLen = Math.min(knife ? 3.5 : 6, L * 0.25);
  const engage = clamp(stroke.engage ?? 1, 0.05, 1), taperHead = stroke.taper?.[0] ?? 0, taperTail = stroke.taper?.[1] ?? 0;
  const taperMin = clamp(stroke.taperMin ?? 0.2, 0.02, 1);
  const profile = stroke.pressure;
  const press = stroke.pressMm ?? 0;

  for (let step = 0; step < steps; step++) {
    const s = step * ds;
    // This step's noise rows (y fixed along the blade), so each lattice hash is computed once.
    nickRow.set(s * 0.07, seed + 9, 0, (N - 1) * 0.045); nickRow.fill(r.gate, N, 0.045);
    if (!knife) { wanderRow.set(s * 0.09, seed, 0, (N - 1) * 0.31); wanderRow.fill(r.wanderN, N, 0.31); }
    thrRowA.set(s * 0.18, seed + 5, 0, (N - 1) * 0.14); thrRowA.fill(r.thrA, N, 0.14);
    thrRowB.set(s * 1.5, seed + 6, 0, (N - 1) * 0.8); thrRowB.fill(r.thrB, N, 0.8);
    swirlRow0.set(s * 0.06, seed + 18, qLo * 0.45 + 5, qHi * 0.45 + 5);
    swirlRow1.set(s * 0.17, seed + 19, qLo * 1.2 + 2, qHi * 1.2 + 2);
    swirlRow2.set(s * 0.32, seed + 20, qLo * 3.1 + 8, qHi * 3.1 + 8);
    const j0 = Math.max(0, step - 6), j1 = Math.min(steps - 1, step + 6);
    let tx = xs[j1] - xs[j0], ty = ys[j1] - ys[j0];
    const tl = Math.sqrt(tx * tx + ty * ty) || 1;
    tx /= tl; ty /= tl;
    const nx = -ty, ny = tx, px = xs[step], py = ys[step];

    // Each edge of the tool wanders, so the silhouette is never a clean ribbon.
    const wobL = (fbm1(s * 0.16, seed, 41) - 0.5) * (knife ? 0.09 : 0.14) + (noise1(s * 1.1, seed, 42) - 0.5) * 0.025;
    const wobR = (fbm1(s * 0.16, seed, 43) - 0.5) * (knife ? 0.09 : 0.14) + (noise1(s * 1.1, seed, 44) - 0.5) * 0.025;
    // Hand pressure here. A light touch lands only part of the blade.
    const pr = profile ? pressureAt(profile, s / L) : 1;
    // Contact width: the engaged share of the blade, narrowed further toward tapered ends.
    let contact = engage;
    if (profile) contact *= contactFromPressure(pr);
    if (taperHead > 0 && s < taperHead * L) contact *= taperMin + (1 - taperMin) * smooth(s / (taperHead * L));
    if (taperTail > 0 && s > L - taperTail * L) contact *= taperMin + (1 - taperMin) * smooth((L - s) / (taperTail * L));
    const off = contact < 1 ? Math.floor((1 - contact) * 0.5 * N) : 0;
    const iL = Math.max(off, Math.floor((Math.max(0, wobL)) * N));
    const iR = Math.min(N - 1 - off, N - 1 - Math.floor((Math.max(0, wobR)) * N));
    // A broken stroke skips where the blade rides up over the paint: ragged patches that vary
    // across the blade as well as along it, never a clean cut.
    const breaking = breaks > 0 && s > 1.5 && s < L - 1.5;
    if (breaking) { breakRow0.set(s * 0.42, seed + 34, qLo * 0.35 + 3, qHi * 0.35 + 3); breakRow1.set(s * 1.6, seed + 35, qLo * 1.4, qHi * 1.4); }

    readSupport(r, px, py, tx, ty, nx, ny);

    const liftT = clamp((s - (L - liftLen)) / liftLen, 0, 1);
    const load = 1 + (fbm1(s * 0.11, seed, 45) - 0.5) * 0.5;
    const stickSlip = noise1(s * 0.14, seed, 48);
    const chatterBase = knife ? (noise1(s * 0.9, seed, 46) - 0.5) * (0.03 + 0.16 * stickSlip * stickSlip) + (noise1(s * 3.3, seed, 47) - 0.5) * 0.02 : 0;
    const roll = (noise1(s * 0.055, seed, 49) - 0.5) * 1.5 + (hash(seed, 7, 92) - 0.5) * 0.6;
    // Physical: light pressure floats the blade on the paint (thicker film); hard pressure sinks it in.
    const gap = Math.max(0.04, stroke.gapMm * load * (1 + 0.9 * liftT * liftT) * (physical && pr < 1 ? 1 + 0.6 * (1 - pr) : 1));
    const pressNow = physical && pr > 1 ? press + (pr - 1) * 0.35 : press;

    if (step === 0) z.fill(0);
    zPrev.set(z);
    setHeights(r, s, gap, pressNow, chatterBase, roll);
    if (step === 0) zPrev.set(z);

    // Turbulent shear: advect the flow map with the s-derivative of a stream function, and let
    // nodes it has brought together trade paint, volume for volume.
    if (step % 4 === 0) shearFlow(r, s);

    // Deposit, scrape and exchange at each cell under the edge.
    passCells(r, s, px, py, tx, ty, nx, ny, iL, iR, breaking, pr);
    stampCounter++;

    squeezeAndMoveWave(r, step, j0, j1, nx, ny, iL, iR, pr);
    shedBerms(r, s, px, py, nx, ny, iL, iR, pr);
    shedHeap(r, s, px, py, tx, ty, nx, ny, iL, iR);
  }

  finishStroke(r);
  return stats;
}

/** Blade support: the surface ahead of the edge, heavily smoothed for a stiff knife. */
function readSupport(r: StrokeRun, px: number, py: number, tx: number, ty: number, nx: number, ny: number): void {
  const { N, W, dx, CW, CH, knife, S, blur } = r;
  const { tooth, top, under } = r.canvas;
  const look = 1.0; // Support is read ahead of the edge, before this stroke has touched it.
  let sum = 0, cPrev = -2, sPrev = 0;
  for (let i = 0; i < N; i++) {
    const q = ((i + 0.5) / N - 0.5) * W;
    const cx = Math.floor((px + nx * q + tx * look) / dx), cy = Math.floor((py + ny * q + ty * look) / dx);
    const c = cx >= 0 && cy >= 0 && cx < CW && cy < CH ? cy * CW + cx : -1;
    // Nodes are finer than cells, so neighbours often read the same cell.
    if (c !== cPrev) { sPrev = c >= 0 ? tooth[c] + top[c] + under[c] : 0; cPrev = c; }
    S[i] = sPrev;
    sum += sPrev;
  }
  const mean = sum / N;
  const support = r.support;
  r.support = Number.isNaN(support) ? mean : support + (mean - support) * (knife ? 0.012 : 0.03);
  const radius = knife ? 8 : 4;
  for (let i = 0; i < N; i++) {
    let t = 0, cnt = 0;
    const lo = i - radius > 0 ? i - radius : 0, hi = i + radius < N - 1 ? i + radius : N - 1;
    for (let a = lo; a <= hi; a++) { t += S[a]; cnt++; }
    blur[i] = t / cnt;
  }
}

/** The height of each node's edge above the canvas at this step. */
function setHeights(r: StrokeRun, s: number, gap: number, pressNow: number, chatterBase: number, roll: number): void {
  const { N, pitch, knife, flex, flaws, contactLen, support, blur, end, texture, gate, wanderN, tool } = r;
  const { v, z, offset, nick } = tool;
  for (let i = 0; i < N; i++) {
    const u = (i + 0.5) / N - 0.5;
    const loadThickness = v[i] / (pitch * contactLen);
    // A loaded knife shears a smooth plane. Chatter and edge flaws show only near its sides,
    // toward the tail, or where the load has thinned.
    if (knife) {
      const edgeMm = Math.min(i, N - 1 - i) * pitch;
      const nearEdge = 1 - smooth((edgeMm - 0.7) / 1.5);
      const nearTail = smooth((s - (end[i] - 13)) / 13);
      const starving = 1 - smooth((loadThickness - gap * 0.9) / (gap * 0.8));
      texture[i] = Math.max(nearEdge, nearTail, starving);
    } else texture[i] = 1;
    const tilt = u * roll;
    // Dried paint on the edge comes and goes, so a nick never makes an endless rail.
    const nickGate = smooth((gate[i] - 0.34) / 0.3);
    // Pressure compacts wet paint: over a thick bed the tool sinks in and plows it.
    const bed = support + (blur[i] - support) * flex;
    const local = bed - Math.max(0, bed - 2.2) * (knife ? 0.55 : 0.4) - pressNow;
    const wander = knife ? 0 : (wanderN[i] - 0.5) * 0.34;
    // The knife's edge profile (its fixed waviness and nicks) prints along the whole stroke as
    // parallel grooves; edgeFlaws scales it. The blade's gentle camber stays.
    const nickNow = nick[i] * nickGate * (0.1 + 0.9 * texture[i]);
    const camber = knife ? 0.05 * (1 - (2 * u) * (2 * u)) : 0;
    const available = flaws === 1
      ? Math.min(gap + offset[i] + nickNow + wander, loadThickness * 0.75)
      : Math.min(gap + (camber + (offset[i] - camber) * flaws + nickNow * flaws) + wander, loadThickness * 0.75);
    z[i] = local + Math.max(0, available) + chatterBase * texture[i] + tilt * gap;
  }
}

/**
 * Turbulent shear: advect the flow map with the s-derivative of a stream function, and let nodes
 * it has brought together trade paint, volume for volume.
 */
function shearFlow(r: StrokeRun, s: number): void {
  const { N, pitch, ds, seed, qMax, turbulence, crossMix, map, psiP, psiM, tool } = r;
  const { v, p } = tool;
  const e = 0.6, dt = ds * 4;
  // Stream function psi(q, at) = 0.9 n2(q*0.38+11, at*0.085) + 0.38 n2(q*1.05, at*0.24) + 0.13 n2(q*2.7, at*0.7),
  // sampled at s +- e: six noise rows for the step, one per octave and side.
  const sP = s + e, sM = s - e;
  psiRowP0.set(sP * 0.085, seed + 15, 11, qMax * 0.38 + 11); psiRowP1.set(sP * 0.24, seed + 16, 0, qMax * 1.05); psiRowP2.set(sP * 0.7, seed + 17, 0, qMax * 2.7);
  psiRowM0.set(sM * 0.085, seed + 15, 11, qMax * 0.38 + 11); psiRowM1.set(sM * 0.24, seed + 16, 0, qMax * 1.05); psiRowM2.set(sM * 0.7, seed + 17, 0, qMax * 2.7);
  // Each node's psi is read before any node of this pass has moved (node i moves at its own turn only).
  psiFill(psiP, map, pitch, N, psiRowP0, psiRowP1, psiRowP2);
  psiFill(psiM, map, pitch, N, psiRowM0, psiRowM1, psiRowM2);
  for (let i = 0; i < N; i++) {
    const velocity = turbulence * (psiP[i] - psiM[i]) / (2 * e);
    let m = map[i] + velocity * dt / pitch + (i - map[i]) * 0.0025;
    if (m < 0) m = -m;
    if (m > N - 1) m = 2 * (N - 1) - m;
    map[i] = m < 0 ? 0 : m > N - 1 ? N - 1 : m;
    const a = Math.floor(map[i] + 0.5);
    if (a !== i && v[i] > 1e-9 && v[a] > 1e-9) {
      const vol = Math.min(v[i], v[a]) * crossMix, ci = vol / v[i], ca = vol / v[a];
      for (let k = 0; k < 3; k++) {
        const mi = p[i * 3 + k] * ci, ma = p[a * 3 + k] * ca;
        p[i * 3 + k] += ma - mi; p[a * 3 + k] += mi - ma;
      }
    }
  }
}

/** Deposit, scrape and exchange at each cell under the edge. */
function passCells(r: StrokeRun, s: number, px: number, py: number, tx: number, ty: number, nx: number, ny: number, iL: number, iR: number, breaking: boolean, pr: number): void {
  const { N, M, W, dx, ds, CW, CH, area, knife, physical, seed, take, pitch, contactLen, volThreshold, squeezeShare, attackF, speedF, swapRate, stir, breaks, passId } = r;
  const { stamp, pass, face, roughStamp, roughCache, start, end, zPrev, texture, map, thrA, thrB, faceCells, stats, canvas, tool } = r;
  const { tooth, top, under, rough } = canvas;
  const { v, p, wv, wp, z } = tool;
  let { x1, y1, x2, y2 } = r;
  for (let j = 0; j < M; j++) {
    const q0 = ((j + 0.5) / M - 0.5) * W;
    const ix = Math.floor((px + nx * q0) / dx), iy = Math.floor((py + ny * q0) / dx);
    if (!(ix >= 0 && iy >= 0 && ix < CW && iy < CH)) continue;
    const c = iy * CW + ix;
    if (stamp[c] === stampCounter) continue;
    // Height comes from where this cell's centre sits under the tool, not from the sample
    // that found it. Otherwise any angled stroke prints the grid as fine hatching.
    const ex = (ix + 0.5) * dx - px, ey = (iy + 0.5) * dx - py;
    const q = ex * nx + ey * ny, along = ex * tx + ey * ty;
    const fq = q / W + 0.5, f = fq < 0 ? 0 : fq > 0.999999 ? 0.999999 : fq, i = Math.floor(f * N);
    if (i < iL || i > iR || s < start[i] || s > end[i]) continue;
    if (breaking && breakRow0.at(q * 0.35 + 3) + 0.45 * breakRow1.at(q * 1.4) < 0.2 + breaks * 0.75) continue;
    stamp[c] = stampCounter;
    const X = ix * dx, Y = iy * dx;
    const fi = f * N - 0.5, i0 = fi < 0 ? 0 : Math.floor(fi), i1 = i0 + 1 < N ? i0 + 1 : i0, ft = fi < 0 ? 0 : fi - i0;
    const zNow = z[i0] + (z[i1] - z[i0]) * ft, zOld = zPrev[i0] + (zPrev[i1] - zPrev[i0]) * ft;
    const ad = along / ds;
    const zHere = zNow + (zNow - zOld) * (ad < -2 ? -2 : ad > 2 ? 2 : ad);

    if (ix < x1) x1 = ix; if (ix > x2) x2 = ix; if (iy < y1) y1 = iy; if (iy > y2) y2 = iy;
    if (knife && texture[i] < 0.05 && face[c] !== passId) { face[c] = passId; faceCells.push(c); }

    canvas.mark(c);
    const ni = i * 3;
    const surf0 = tooth[c] + top[c] + under[c];

    // Requirement 1: paint above the edge is displaced into the plow wave.
    if (surf0 > zHere) {
      const rm = canvas.remove(c, surf0 - zHere);
      if (rm[0] > 0) {
        const vol = rm[0] * area;
        v[i] += vol * take; wv[i] += vol * (1 - take);
        stats.plowedVolume += vol * (1 - take);
        for (let k = 0; k < 3; k++) { const m = rm[k + 1] * area; p[ni + k] += m * take; wp[ni + k] += m * (1 - take); }
        rough[c] = 0.06 + 0.05 * hash(c, seed, 3);
      }
    }

    const surf = tooth[c] + top[c] + under[c];

    // Requirement 3: yield-stress breakup.
    const g = zHere - surf;
    const loadT = v[i] / (pitch * contactLen);
    const threshold = volThreshold * (0.45 + 0.65 * thrA[i] + 0.45 * thrB[i]);
    const wet = v[i] > threshold && g <= loadT;
    if (wet) {
      stats.wetCells++;
      // Colour comes from the sheared position in the reservoir, blended between its two
      // nearest nodes so streaks stay continuous.
      // On top of the accumulated flow, a slower swirl folds neighbouring streaks across each other.
      const swirl = swirlAt(q);
      const mappedRaw = map[i0] + (map[i1] - map[i0]) * ft + swirl * stir;
      const mapped = mappedRaw < 0 ? -mappedRaw : mappedRaw > N - 1 ? Math.max(0, 2 * (N - 1) - mappedRaw) : mappedRaw;
      const a = Math.min(N - 1, Math.floor(mapped)), b = a + 1 < N ? a + 1 : a;
      let w = mapped - a;
      if (v[a] <= 1e-9) w = 1; else if (v[b] <= 1e-9) w = 0;
      const va = v[a], vb = v[b];
      const ka = va > 1e-9 ? 1 / va : 0, kb = vb > 1e-9 ? 1 / vb : 0;
      const c0 = p[a * 3] * ka * (1 - w) + p[b * 3] * kb * w;
      const c1 = p[a * 3 + 1] * ka * (1 - w) + p[b * 3 + 1] * kb * w;
      const c2 = p[a * 3 + 2] * ka * (1 - w) + p[b * 3 + 2] * kb * w;
      if (g > 0 && v[i] > 1e-12) {
        // Volume always leaves this node, so load depletes where the tool actually is and the
        // flow can't open holes. Only colour comes from the sheared position: the source trades
        // its pigment for an equal volume of this node's paint.
        const h = Math.min(g, v[i] / area), vol = h * area, ki = 1 / v[i];
        const da = vol * (1 - w), db = vol * w;
        const own0 = p[ni] * ki, own1 = p[ni + 1] * ki, own2 = p[ni + 2] * ki;
        if (va >= da * 1.5 && vb >= db * 1.5 && (va > 1e-9 || vb > 1e-9)) {
          canvas.add(c, h, c0, c1, c2);
          // Source concentrations are read before any of the three channels is updated (as before).
          const ca0 = p[a * 3] * ka, ca1 = p[a * 3 + 1] * ka, ca2 = p[a * 3 + 2] * ka;
          const cb0 = p[b * 3] * kb, cb1 = p[b * 3 + 1] * kb, cb2 = p[b * 3 + 2] * kb;
          p[ni] -= own0 * vol; p[a * 3] += (own0 - ca0) * da; p[b * 3] += (own0 - cb0) * db;
          p[ni + 1] -= own1 * vol; p[a * 3 + 1] += (own1 - ca1) * da; p[b * 3 + 1] += (own1 - cb1) * db;
          p[ni + 2] -= own2 * vol; p[a * 3 + 2] += (own2 - ca2) * da; p[b * 3 + 2] += (own2 - cb2) * db;
        } else {
          canvas.add(c, h, own0, own1, own2);
          p[ni] -= own0 * vol; p[ni + 1] -= own1 * vol; p[ni + 2] -= own2 * vol;
        }
        v[i] -= vol;
        // squeezedLoad: pressing paint under the edge forces a share of it out sideways.
        if (v[i] > 0) {
          const out = Math.min(v[i], vol * (physical ? squeezeShare * (pr < 1.5 ? pr : 1.5) * attackF * speedF : squeezeShare)), share = out / v[i];
          v[i] -= out; wv[i] += out;
          for (let k = 0; k < 3; k++) { const m = p[ni + k] * share; p[ni + k] -= m; wp[ni + k] += m; }
        }
        // The same cell gets the same roughness noise on every step of this stroke: compute it once.
        if (roughStamp[c] === passId) rough[c] = roughCache[c];
        else { const rv = 0.06 + 0.10 * noise2(X * 1.3, Y * 1.3, seed); roughCache[c] = rv; roughStamp[c] = passId; rough[c] = rv; }
      }
      // Requirement 2: two-way wet exchange, volume for volume, once per pass. Running it after
      // the deposit means a loaded tool covers what it crosses and thin fills don't turn translucent.
      if (pass[c] !== passId && top[c] > 1e-6 && tooth[c] + top[c] + under[c] >= zHere - 0.03 && v[i] > volThreshold) {
        pass[c] = passId;
        const v2a = v[a], v2b = v[b], la = v2a > 1e-9 ? 1 / v2a : 0, lb = v2b > 1e-9 ? 1 / v2b : 0;
        const u = v2a <= 1e-9 ? 1 : v2b <= 1e-9 ? 0 : w;
        const room = u <= 0 ? v2a : u >= 1 ? v2b : Math.min(v2a / (1 - u), v2b / u);
        const h = Math.min(top[c] * swapRate, room / area * 0.5);
        const m0 = p[a * 3] * la * (1 - u) + p[b * 3] * lb * u;
        const m1 = p[a * 3 + 1] * la * (1 - u) + p[b * 3 + 1] * lb * u;
        const m2 = p[a * 3 + 2] * la * (1 - u) + p[b * 3 + 2] * lb * u;
        canvas.exchange(c, h, m0, m1, m2, OUT);
        if (OUT[0] > 0) {
          const vol = OUT[0] * area;
          for (let k = 0; k < 3; k++) {
            p[a * 3 + k] += OUT[k + 1] * area * (1 - u) - p[a * 3 + k] * la * vol * (1 - u);
            p[b * 3 + k] += OUT[k + 1] * area * u - p[b * 3 + k] * lb * vol * u;
          }
        }
      }
    } else if (v[i] > volThreshold * 0.1) {
      stats.stickCells++;
      let localMean = 0, cnt = 0;
      for (let k = 0; k < 8; k++) {
        const bx = ix + ringDx[k], by = iy + ringDy[k];
        if (bx >= 0 && by >= 0 && bx < CW && by < CH) { const d = by * CW + bx; localMean += tooth[d] + top[d] + under[d]; cnt++; }
      }
      localMean = cnt ? localMean / cnt : surf;
      // A little noise in the test breaks the weave's regular grid into irregular clumps.
      if (surf > localMean + (noise2(X * 0.9, Y * 0.9, seed + 78) - 0.5) * 0.045) {
        const film = (0.02 + 0.07 * noise2(X * 1.1, Y * 1.1, seed + 77)) * clamp((surf - localMean + 0.02) / 0.03, 0.25, 1);
        const h = Math.min(film, v[i] / area);
        const vol = h * area, frac = vol / v[i], ci = 1 / v[i];
        canvas.add(c, h, p[ni] * ci, p[ni + 1] * ci, p[ni + 2] * ci);
        for (let k = 0; k < 3; k++) p[ni + k] -= p[ni + k] * frac;
        v[i] -= vol;
        rough[c] = 0.34;
        stats.stickDeposited++;
      } else stats.stickSkipped++;
    }
  }
  r.x1 = x1; r.y1 = y1; r.x2 = x2; r.y2 = y2;
}

/** Squeeze over-full nodes into the wave, cap the wave, move it outward along the edge, and diffuse volume along the edge. */
function squeezeAndMoveWave(r: StrokeRun, step: number, j0: number, j1: number, nx: number, ny: number, iL: number, iR: number, pr: number): void {
  const { N, W, physical, squeezeRate, waveCap, sideBias, lateral, xs, ys, tool, stroke } = r;
  const { v, p, wv, wp } = tool;
  // Squeeze: a node over its capacity sheds into the wave (squeezedLoad).
  const pressureCap = tool.capacity * (0.65 + 0.35 * clamp(stroke.gapMm / 1.2, 0, 1.6));
  for (let i = 0; i < N; i++) {
    const excess = v[i] - pressureCap;
    // Physical: only blade in contact squeezes, and harder pressure squeezes faster.
    const squeezeHere = !physical ? squeezeRate : i < iL || i > iR ? 0 : squeezeRate * (pr < 1.5 ? pr : 1.5);
    if (excess > 0 && squeezeHere > 0) {
      const vol = excess * squeezeHere, frac = vol / v[i];
      v[i] -= vol; wv[i] += vol;
      for (let k = 0; k < 3; k++) { const m = p[i * 3 + k] * frac; p[i * 3 + k] -= m; wp[i * 3 + k] += m; }
    } else if (excess <= 0 && wv[i] > 0) {
      // A starving node draws a little back from the bead in front of it.
      const vol = Math.min(wv[i] * 0.01, -excess), frac = wv[i] > 0 ? vol / wv[i] : 0;
      wv[i] -= vol; v[i] += vol;
      for (let k = 0; k < 3; k++) { const m = wp[i * 3 + k] * frac; wp[i * 3 + k] -= m; p[i * 3 + k] += m; }
    }
  }

  // A bead has a limited size; beyond it paint folds back into the node's load.
  for (let i = 0; i < N; i++) {
    const over = wv[i] - waveCap;
    if (over > 0) {
      const frac = over / wv[i];
      wv[i] -= over; v[i] += over;
      for (let k = 0; k < 3; k++) { const m = wp[i * 3 + k] * frac; wp[i * 3 + k] -= m; p[i * 3 + k] += m; }
    }
  }

  // Wave moves outward along the edge. It leaves only through the two sides. Physical: on a
  // curve the bead is thrown to the outside of the turn, and pressure drives it outward faster.
  let bias = sideBias, lat = lateral;
  if (physical) {
    const ax = xs[step] - xs[j0], ay = ys[step] - ys[j0], bx = xs[j1] - xs[step], by = ys[j1] - ys[step];
    const la = Math.sqrt(ax * ax + ay * ay), lb = Math.sqrt(bx * bx + by * by);
    if (la > 1e-9 && lb > 1e-9) {
      // Turn toward +n (the side-1 direction) per mm; the outside of that turn is side 0.
      const turn = ((bx / lb - ax / la) * nx + (by / lb - ay / la) * ny) / ((la + lb) * 0.5);
      bias = clamp(sideBias + turn * W * 1.5, 0.1, 0.9);
    }
    lat = lateral * (0.5 + 0.5 * (pr < 1.5 ? pr : 1.5));
  }
  const split = Math.floor(N * bias);
  moveWaveRun(tool, iL, split - 1, 0, lat);
  moveWaveRun(tool, iR, split, 1, lat);
  moveWaveOut(tool, 0, iL - 1, 0);
  moveWaveOut(tool, N - 1, iR + 1, 1);

  // Slow volume diffusion along the edge keeps nodes from going dry one by one.
  if (step % 4 === 0) for (let i = 0; i < N - 1; i++) {
    const diff = v[i] - v[i + 1];
    const flux = diff * 0.012;
    const from = flux > 0 ? i : i + 1, to = flux > 0 ? i + 1 : i;
    const vol = flux > 0 ? flux : -flux;
    if (vol > 0 && v[from] > 0) {
      const frac = vol / v[from];
      v[from] -= vol; v[to] += vol;
      for (let k = 0; k < 3; k++) { const m = p[from * 3 + k] * frac; p[from * 3 + k] -= m; p[to * 3 + k] += m; }
    }
  }
}

/**
 * Side berms: the edge stores release irregular chunks just outside the footprint. A berm can
 * only be so large in cross-section; the rest rides on to the terminal heap. Then a saturated
 * bead rolls back under the edge and is laid down with the load.
 */
function shedBerms(r: StrokeRun, s: number, px: number, py: number, nx: number, ny: number, iL: number, iR: number, pr: number): void {
  const { N, W, dx, ds, knife, physical, seed, stiff, edgeStoreCap, allowance, sinceEmit, bermArea, stats, canvas, tool } = r;
  const { v, p } = tool;
  for (let side = 0; side < 2; side++) {
    allowance[side] = Math.min(allowance[side] + ds * (knife ? 1.5 : 0.8) * (0.2 + 1.6 * fbm1(s * 0.3, seed, 57 + side)) * (physical ? (pr < 1.5 ? pr : 1.5) : 1), 0.6);
    sinceEmit[side] += ds;
    const ev = Math.min(tool.edgeV[side], allowance[side]);
    const chunk = (knife ? 0.004 : 0.003) * (1 + 3 * noise1(s * 2.3, seed, 51 + side));
    if (ev >= chunk) {
      // The bead can only shed so fast; the rest rides along and lands in the heap.
      const stored = tool.edgeV[side];
      const vol = ev, pi = side * 3, emitFrac = vol / stored;
      allowance[side] -= vol;
      const crossSection = vol / Math.max(ds, sinceEmit[side]);
      bermArea[side] = bermArea[side] === 0 ? crossSection : lerp(bermArea[side], crossSection, 0.08);
      sinceEmit[side] = 0;
      const R = Math.max(0.2, Math.sqrt(bermArea[side] / (knife ? 2.3 : 1.8)), Math.sqrt(vol / 0.4));
      const edgeIndex = side === 0 ? iL : iR + 1;
      const q = (edgeIndex / N - 0.5) * W + (side === 0 ? -1 : 1) * R * 0.25;
      const cx = px + nx * q, cy = py + ny * q;
      const conc = 1 / stored;
      canvas.cone(cx, cy, R, vol, tool.edgeP[pi] * conc, tool.edgeP[pi + 1] * conc, tool.edgeP[pi + 2] * conc, 0.10 + 0.06 * noise1(s * 0.7, seed, 55), 2, stiff);
      stats.bermVolume += vol;
      tool.edgeV[side] -= vol;
      for (let k = 0; k < 3; k++) tool.edgeP[pi + k] -= tool.edgeP[pi + k] * emitFrac;
      const rr = Math.ceil(R / dx) + 1;
      const ix = Math.floor(cx / dx), iy = Math.floor(cy / dx);
      if (ix - rr < r.x1) r.x1 = ix - rr; if (ix + rr > r.x2) r.x2 = ix + rr;
      if (iy - rr < r.y1) r.y1 = iy - rr; if (iy + rr > r.y2) r.y2 = iy + rr;
    }
  }

  // A saturated bead rolls back under the edge and is laid down with the load.
  for (let side = 0; side < 2; side++) {
    const over = tool.edgeV[side] - edgeStoreCap;
    if (over <= 0) continue;
    const frac = over / tool.edgeV[side], target = side === 0 ? iL + 2 : iR - 2, pi = side * 3;
    tool.edgeV[side] -= over; v[target] += over;
    for (let k = 0; k < 3; k++) { const m = tool.edgeP[pi + k] * frac; tool.edgeP[pi + k] -= m; p[target * 3 + k] += m; }
  }
}

/**
 * Terminal heap: as each node lifts, its wave and part of its load drop ahead of the tip. A node
 * a taper has already lifted off the paint sheds nothing; its bead went to the side.
 */
function shedHeap(r: StrokeRun, s: number, px: number, py: number, tx: number, ty: number, nx: number, ny: number, iL: number, iR: number): void {
  const { N, W, dx, pitch, knife, physical, seed, stiff, lift, liftP, heapScale, volThreshold, shedCap, end, dumped, moving, stats, canvas, tool } = r;
  const { v, p, wv, wp } = tool;
  for (let i = 0; i < N; i++) {
    if (dumped[i] || s < end[i]) continue;
    dumped[i] = 1;
    if (i < iL - 1 || i > iR + 1) continue;
    // A clean lift keeps part of the bead on the knife instead of dropping it.
    // Physically, a light lift keeps more of the bead on the blade than a hard one.
    const dropShare = heapScale * (physical ? clamp(0.25 + 0.75 * liftP, 0, 1) : 1);
    const keep = dropShare < 1 ? 1 - dropShare : 0;
    if (keep > 0 && wv[i] > 0) {
      const kv = wv[i] * keep;
      for (let k = 0; k < 3; k++) { const m = wp[i * 3 + k] * keep; wp[i * 3 + k] -= m; p[i * 3 + k] += m; }
      wv[i] -= kv; v[i] += kv;
    }
    // A short mark sheds in proportion to its length; `heap` scales it further.
    const shed = v[i] > volThreshold ? Math.min(0.9, (knife ? 0.42 : 0.16) * (0.6 + 0.8 * hash(i, seed, 61)) * lift * heapScale * liftP) : 0;
    const fromLoad = Math.min(v[i] * shed, shedCap * lift * (heapScale > 1 ? heapScale : 1));
    const frac = v[i] > 0 ? fromLoad / v[i] : 0;
    const vol = wv[i] + fromLoad;
    if (vol <= 1e-9) continue;
    for (let k = 0; k < 3; k++) moving[k] = wp[i * 3 + k] + p[i * 3 + k] * frac;
    for (let k = 0; k < 3; k++) { p[i * 3 + k] -= p[i * 3 + k] * frac; wp[i * 3 + k] = 0; }
    v[i] -= fromLoad; wv[i] = 0;
    // Neighbouring nodes overlap, so size each cone from the heap's cross-section.
    const q = ((i + 0.5) / N - 0.5) * W;
    const R = Math.sqrt(vol / (pitch * 1.9));
    const fwd = R * 0.7 + 1.3 * hash(i, seed, 62) + (fbm1(i * 0.12, seed, 63) - 0.5) * 2.2;
    // The bead slides off as a short tongue, not a ball.
    const c0 = moving[0] / vol, c1 = moving[1] / vol, c2 = moving[2] / vol;
    const rough = 0.12 + 0.04 * hash(i, seed, 64);
    // Stiff paint is pulled up by the lifting blade: the tongue rises to a narrower crest at its
    // front instead of spreading evenly, so the stroke ends in a raised, ragged lip.
    const Rh = stiff > 0 ? R * 0.8 * (1 - 0.25 * stiff) : R * 0.8;
    for (let part = 0; part < 4; part++) {
      const a = (part + 1) / 4;
      const jitter = (hash(i, seed, 65 + part) - 0.5) * R * 0.9;
      const share = stiff > 0 ? 0.25 + (0.1 * (part + 1) - 0.25) * stiff : 0.25;
      canvas.cone(px + nx * (q + jitter) + tx * fwd * a, py + ny * (q + jitter) + ty * fwd * a, Rh, vol * share, c0, c1, c2, rough, 1, stiff);
    }
    const cx = px + nx * q + tx * fwd, cy = py + ny * q + ty * fwd;
    stats.heapVolume += vol;
    const rr = Math.ceil((R + fwd) / dx) + 2, ix = Math.floor(cx / dx), iy = Math.floor(cy / dx);
    if (ix - rr < r.x1) r.x1 = ix - rr; if (ix + rr > r.x2) r.x2 = ix + rr;
    if (iy - rr < r.y1) r.y1 = iy - rr; if (iy + rr > r.y2) r.y2 = iy + rr;
  }
}

/** After the last step: residue stays on the tool, then the canvas settles the touched region. */
function finishStroke(r: StrokeRun): void {
  const { N, dx, knife, seed, stiff, passId, faceCells, face, x1, y1, x2, y2, canvas, tool } = r;
  const { v, p, wv, wp } = tool;
  // Whatever is still in the side stores or wave stays on the tool as residue.
  for (let side = 0; side < 2; side++) {
    const target = side === 0 ? 0 : N - 1, pi = side * 3;
    v[target] += tool.edgeV[side]; tool.edgeV[side] = 0;
    for (let k = 0; k < 3; k++) { p[target * 3 + k] += tool.edgeP[pi + k]; tool.edgeP[pi + k] = 0; }
  }
  for (let i = 0; i < N; i++) {
    v[i] += wv[i]; wv[i] = 0;
    for (let k = 0; k < 3; k++) { p[i * 3 + k] += wp[i * 3 + k]; wp[i * 3 + k] = 0; }
  }

  const pad = Math.ceil(2 / dx);
  if (stiff > 0) {
    // Stiff paint: only near-vertical slopes give way, levelling just takes the voxel step off,
    // and the blade face is pressed flatter. More of each heap is recut into creased planes.
    canvas.slump(x1 - pad, y1 - pad, x2 + pad, y2 + pad, (knife ? 2.8 : 2.3) * (1 + 1.5 * stiff), 3);
    canvas.level(x1 - pad, y1 - pad, x2 + pad, y2 + pad, 0.1 * (1 - 0.7 * stiff), 1);
    canvas.levelFace(faceCells, face, passId, 0.22, 7 + Math.round(5 * stiff));
    canvas.facet(1, knife ? 0.6 : 0.5, (knife ? 0.7 : 0.5) * (1 + 0.5 * stiff), seed + 501, 0.3 - 0.15 * stiff);
  } else {
    canvas.slump(x1 - pad, y1 - pad, x2 + pad, y2 + pad, knife ? 2.8 : 2.3, 3);
    canvas.level(x1 - pad, y1 - pad, x2 + pad, y2 + pad, 0.1, 1);
    canvas.levelFace(faceCells, face, passId, 0.22, 7);
    // Rounded peaks are recut into crests; a knife leaves harder, larger planes than a brush.
    canvas.facet(1, knife ? 0.6 : 0.5, knife ? 0.7 : 0.5, seed + 501);
  }
  canvas.blendWetContact(seed, stiff);
}

/**
 * Wave moves one node outward along a run of the edge: from node `first` (which sheds into the
 * side store) through to `last`, each node passing its share to the one before it, in that order.
 * Side 0 runs toward lower indices (last >= first), side 1 toward higher (last <= first).
 */
function moveWaveRun(tool: Tool, first: number, last: number, side: number, rate: number): void {
  if (side === 0) for (let i = first; i <= last; i++) moveWave(tool, i, i === first ? -1 : i - 1, 0, rate);
  else for (let i = first; i >= last; i--) moveWave(tool, i, i === first ? -2 : i + 1, 1, rate);
}
/** Nodes off the contact, from `first` to `last` in that order, shed their whole wave into the side store. */
function moveWaveOut(tool: Tool, first: number, last: number, side: number): void {
  if (side === 0) for (let i = first; i <= last; i++) moveWave(tool, i, -1, 0, 1);
  else for (let i = first; i >= last; i--) moveWave(tool, i, -2, 1, 1);
}
/** to: node index, or -1/-2 for the left/right edge store. */
function moveWave(tool: Tool, i: number, to: number, side: number, rate: number): void {
  const vol = tool.wv[i] * rate;
  if (vol <= 0) return;
  const frac = rate;
  for (let k = 0; k < 3; k++) {
    const m = tool.wp[i * 3 + k] * frac;
    tool.wp[i * 3 + k] -= m;
    if (to >= 0) tool.wp[to * 3 + k] += m; else tool.edgeP[side * 3 + k] += m;
  }
  tool.wv[i] -= vol;
  if (to >= 0) tool.wv[to] += vol; else tool.edgeV[side] += vol;
}
