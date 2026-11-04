import { clamp, dcbrt, fbm1, hash, lerp, noise1, noise2, smooth } from './dmath.ts';
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

export function paintStroke(canvas: PaintCanvas, tool: Tool, stroke: StrokeSpec): StrokeStats {
  const { dx } = canvas;
  const { N, pitch, v, p, wv, wp, z, offset } = tool;
  const W = tool.spec.widthMm, knife = tool.spec.kind === 'knife';
  const seed = stroke.seed;
  const ds = dx * 0.4;
  const { xs, ys } = resample(stroke.points, ds);
  const steps = xs.length;
  const L = (steps - 1) * ds;
  const stats: StrokeStats = { lengthMm: L, steps, bermVolume: 0, heapVolume: 0, plowedVolume: 0, wetCells: 0, stickCells: 0, stickDeposited: 0, stickSkipped: 0 };
  if (steps < 4) return stats;

  canvas.beginStroke();
  let stamp = stamps.get(canvas);
  if (!stamp) { stamp = new Int32Array(canvas.n); stamps.set(canvas, stamp); }
  let pass = passStamps.get(canvas);
  if (!pass) { pass = new Int32Array(canvas.n); passStamps.set(canvas, pass); }
  const passId = ++passCounter;
  let face = faceStamps.get(canvas);
  if (!face) { face = new Int32Array(canvas.n); faceStamps.set(canvas, face); }
  const area = dx * dx;
  const M = Math.ceil(W / (dx * 0.45));

  // Paint behaviour. Knife: stiff edge, strong plow. Bristle: flexible hairs, more retained.
  const flex = knife ? 0.02 : 0.62;
  const lateral = knife ? 0.42 : 0.16;
  const pickupFraction = knife ? 0.14 : 0.30;
  const swapRate = knife ? 0.92 : 0.8;
  const squeezeRate = knife ? 0.0022 : 0.0009;
  const contactLen = contactLength(tool.spec.kind, L);
  const liftLen = Math.min(knife ? 3.5 : 6, L * 0.25);
  // Touch-down and lift-off scale with the stroke below FULL_LIFT_LENGTH, so short marks deposit.
  const lift = L < FULL_LIFT_LENGTH ? L / FULL_LIFT_LENGTH : 1;
  const engage = clamp(stroke.engage ?? 1, 0.05, 1), taperHead = stroke.taper?.[0] ?? 0, taperTail = stroke.taper?.[1] ?? 0;
  const taperMin = clamp(stroke.taperMin ?? 0.2, 0.02, 1), breaks = clamp(stroke.breaks ?? 0, 0, 1);
  const flaws = clamp(stroke.edgeFlaws ?? 1, 0, 1);
  const sideBias = 0.5 + (hash(seed, 3, 91) - 0.5) * 0.56;
  // Yield stress is a property of the paint, so this is an absolute load, not a share of the start;
  // only the contact patch shrinks for a short mark made with the tip.
  const volThreshold = yieldVolume(tool.spec.kind, pitch, L);
  const heapScale = clamp(stroke.heap ?? 1, 0, 1.5);
  const squeezeShare = knife ? 0.17 : 0.06;
  const press = stroke.pressMm ?? 0;
  const ringR = Math.max(2, Math.round(0.45 / dx));

  const start = new Float64Array(N), end = new Float64Array(N), dumped = new Uint8Array(N);
  for (let i = 0; i < N; i++) {
    const q = (i + 0.5) * pitch;
    start[i] = fbm1(q * 0.5, seed, 31) * (knife ? 1.2 : 3.0) * lift;
    end[i] = L - (fbm1(q * 0.3, seed, 32) * (knife ? 6.0 : 12.0) + noise1(q * 1.6, seed, 33) * (knife ? 2.0 : 4.0)) * lift;
  }

  let support = NaN, x1 = canvas.w, y1 = canvas.h, x2 = 0, y2 = 0;
  const S = new Float64Array(N), blur = new Float64Array(N);
  const look = 1.0; // Support is read ahead of the edge, before this stroke has touched it.
  const moving = new Float64Array(4);
  const allowance = [0.1, 0.1], sinceEmit = [0, 0], bermArea = [0, 0];
  const edgeStoreCap = knife ? 2.2 : 1.2;
  const waveCap = pitch * (knife ? 2.2 : 1.1);
  const shedCap = pitch * (knife ? 7.0 : 2.4);
  const zPrev = new Float64Array(N), texture = new Float64Array(N);
  // Flow map: each node draws paint from the reservoir position carried here by the shear flow.
  const map = new Float64Array(N);
  for (let i = 0; i < N; i++) map[i] = i;
  const turbulence = knife ? 3.0 : 1.4, crossMix = knife ? 0.0005 : 0.0003, stir = knife ? 15 : 6;
  const faceCells: number[] = [];

  for (let step = 0; step < steps; step++) {
    const s = step * ds;
    const j0 = Math.max(0, step - 6), j1 = Math.min(steps - 1, step + 6);
    let tx = xs[j1] - xs[j0], ty = ys[j1] - ys[j0];
    const tl = Math.sqrt(tx * tx + ty * ty) || 1;
    tx /= tl; ty /= tl;
    const nx = -ty, ny = tx, px = xs[step], py = ys[step];

    // Each edge of the tool wanders, so the silhouette is never a clean ribbon.
    const wobL = (fbm1(s * 0.16, seed, 41) - 0.5) * (knife ? 0.09 : 0.14) + (noise1(s * 1.1, seed, 42) - 0.5) * 0.025;
    const wobR = (fbm1(s * 0.16, seed, 43) - 0.5) * (knife ? 0.09 : 0.14) + (noise1(s * 1.1, seed, 44) - 0.5) * 0.025;
    // Contact width: the engaged share of the blade, narrowed further toward tapered ends.
    let contact = engage;
    if (taperHead > 0 && s < taperHead * L) contact *= taperMin + (1 - taperMin) * smooth(s / (taperHead * L));
    if (taperTail > 0 && s > L - taperTail * L) contact *= taperMin + (1 - taperMin) * smooth((L - s) / (taperTail * L));
    const off = contact < 1 ? Math.floor((1 - contact) * 0.5 * N) : 0;
    const iL = Math.max(off, Math.floor((Math.max(0, wobL)) * N));
    const iR = Math.min(N - 1 - off, N - 1 - Math.floor((Math.max(0, wobR)) * N));
    // A broken stroke skips where the blade rides up over the paint: ragged patches that vary
    // across the blade as well as along it, never a clean cut.
    const breaking = breaks > 0 && s > 1.5 && s < L - 1.5;

    // Blade support: the surface ahead of the edge, heavily smoothed for a stiff knife.
    let sum = 0;
    for (let i = 0; i < N; i++) {
      const q = ((i + 0.5) / N - 0.5) * W;
      const c = canvas.cellAt(px + nx * q + tx * look, py + ny * q + ty * look);
      S[i] = c >= 0 ? canvas.surface(c) : 0;
      sum += S[i];
    }
    const mean = sum / N;
    support = Number.isNaN(support) ? mean : lerp(support, mean, knife ? 0.012 : 0.03);
    const radius = knife ? 8 : 4;
    for (let i = 0; i < N; i++) {
      let t = 0, cnt = 0;
      for (let a = Math.max(0, i - radius); a <= Math.min(N - 1, i + radius); a++) { t += S[a]; cnt++; }
      blur[i] = t / cnt;
    }

    const liftT = clamp((s - (L - liftLen)) / liftLen, 0, 1);
    const load = 1 + (fbm1(s * 0.11, seed, 45) - 0.5) * 0.5;
    const stickSlip = noise1(s * 0.14, seed, 48);
    const chatterBase = knife ? (noise1(s * 0.9, seed, 46) - 0.5) * (0.03 + 0.16 * stickSlip * stickSlip) + (noise1(s * 3.3, seed, 47) - 0.5) * 0.02 : 0;
    const roll = (noise1(s * 0.055, seed, 49) - 0.5) * 1.5 + (hash(seed, 7, 92) - 0.5) * 0.6;
    const gap = Math.max(0.04, stroke.gapMm * load * (1 + 0.9 * liftT * liftT));

    if (step === 0) z.fill(0);
    zPrev.set(z);
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
      const nickGate = smooth((noise2(i * 0.045, s * 0.07, seed + 9) - 0.34) / 0.3);
      // Pressure compacts wet paint: over a thick bed the tool sinks in and plows it.
      const bed = lerp(support, blur[i], flex);
      const local = bed - Math.max(0, bed - 2.2) * (knife ? 0.55 : 0.4) - press;
      const wander = knife ? 0 : (noise2(i * 0.31, s * 0.09, seed) - 0.5) * 0.34;
      // The knife's edge profile (its fixed waviness and nicks) prints along the whole stroke as
      // parallel grooves; edgeFlaws scales it. The blade's gentle camber stays.
      const nickNow = tool.nick[i] * nickGate * (0.1 + 0.9 * texture[i]);
      const camber = knife ? 0.05 * (1 - (2 * u) * (2 * u)) : 0;
      const available = flaws === 1
        ? Math.min(gap + offset[i] + nickNow + wander, loadThickness * 0.75)
        : Math.min(gap + (camber + (offset[i] - camber) * flaws + nickNow * flaws) + wander, loadThickness * 0.75);
      z[i] = local + Math.max(0, available) + chatterBase * texture[i] + tilt * gap;
    }

    if (step === 0) zPrev.set(z);

    // Turbulent shear: advect the flow map with the s-derivative of a stream function, and let
    // nodes it has brought together trade paint, volume for volume.
    if (step % 4 === 0) {
      const e = 0.6, dt = ds * 4;
      for (let i = 0; i < N; i++) {
        const q = map[i] * pitch;
        const psi = (at: number) => 0.9 * noise2(q * 0.38 + 11, at * 0.085, seed + 15) + 0.38 * noise2(q * 1.05, at * 0.24, seed + 16) + 0.13 * noise2(q * 2.7, at * 0.7, seed + 17);
        const velocity = turbulence * (psi(s + e) - psi(s - e)) / (2 * e);
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

    // Deposit, scrape and exchange at each cell under the edge.
    for (let j = 0; j < M; j++) {
      const q0 = ((j + 0.5) / M - 0.5) * W;
      const c = canvas.cellAt(px + nx * q0, py + ny * q0);
      if (c < 0 || stamp[c] === stampCounter) continue;
      const ix = c % canvas.w, iy = (c - ix) / canvas.w;
      // Height comes from where this cell's centre sits under the tool, not from the sample
      // that found it. Otherwise any angled stroke prints the grid as fine hatching.
      const ex = (ix + 0.5) * dx - px, ey = (iy + 0.5) * dx - py;
      const q = ex * nx + ey * ny, along = ex * tx + ey * ty;
      const f = clamp(q / W + 0.5, 0, 0.999999), i = Math.floor(f * N);
      if (i < iL || i > iR || s < start[i] || s > end[i]) continue;
      if (breaking && noise2(q * 0.35 + 3, s * 0.42, seed + 34) + 0.45 * noise2(q * 1.4, s * 1.6, seed + 35) < 0.2 + breaks * 0.75) continue;
      stamp[c] = stampCounter;
      const X = ix * dx, Y = iy * dx;
      const fi = f * N - 0.5, i0 = fi < 0 ? 0 : Math.floor(fi), i1 = i0 + 1 < N ? i0 + 1 : i0, ft = fi < 0 ? 0 : fi - i0;
      const zNow = z[i0] + (z[i1] - z[i0]) * ft, zOld = zPrev[i0] + (zPrev[i1] - zPrev[i0]) * ft;
      const zHere = zNow + (zNow - zOld) * clamp(along / ds, -2, 2);

      if (ix < x1) x1 = ix; if (ix > x2) x2 = ix; if (iy < y1) y1 = iy; if (iy > y2) y2 = iy;
      if (knife && texture[i] < 0.05 && face[c] !== passId) { face[c] = passId; faceCells.push(c); }

      canvas.mark(c);
      const ni = i * 3;
      const surf0 = canvas.surface(c);

      // Requirement 1: paint above the edge is displaced into the plow wave.
      if (surf0 > zHere) {
        const r = canvas.remove(c, surf0 - zHere);
        if (r[0] > 0) {
          const vol = r[0] * area;
          const take = pickupFraction;
          v[i] += vol * take; wv[i] += vol * (1 - take);
          stats.plowedVolume += vol * (1 - take);
          for (let k = 0; k < 3; k++) { const m = r[k + 1] * area; p[ni + k] += m * take; wp[ni + k] += m * (1 - take); }
          canvas.rough[c] = 0.06 + 0.05 * hash(c, seed, 3);
        }
      }

      const surf = canvas.surface(c);

      // Requirement 3: yield-stress breakup.
      const g = zHere - surf;
      const loadT = v[i] / (pitch * contactLen);
      const threshold = volThreshold * (0.45 + 0.65 * noise2(i * 0.14, s * 0.18, seed + 5) + 0.45 * noise2(i * 0.8, s * 1.5, seed + 6));
      const wet = v[i] > threshold && g <= loadT;
      if (wet) {
        stats.wetCells++;
        // Colour comes from the sheared position in the reservoir, blended between its two
        // nearest nodes so streaks stay continuous.
        // On top of the accumulated flow, a slower swirl folds neighbouring streaks across each other.
        const swirl = (noise2(q * 0.45 + 5, s * 0.06, seed + 18) - 0.5) + 0.6 * (noise2(q * 1.2 + 2, s * 0.17, seed + 19) - 0.5) + 0.4 * (noise2(q * 3.1 + 8, s * 0.32, seed + 20) - 0.5);
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
            const ca = [p[a * 3] * ka, p[a * 3 + 1] * ka, p[a * 3 + 2] * ka], cb = [p[b * 3] * kb, p[b * 3 + 1] * kb, p[b * 3 + 2] * kb];
            const own = [own0, own1, own2];
            for (let k = 0; k < 3; k++) {
              p[ni + k] -= own[k] * vol;
              p[a * 3 + k] += (own[k] - ca[k]) * da;
              p[b * 3 + k] += (own[k] - cb[k]) * db;
            }
          } else {
            canvas.add(c, h, own0, own1, own2);
            p[ni] -= own0 * vol; p[ni + 1] -= own1 * vol; p[ni + 2] -= own2 * vol;
          }
          v[i] -= vol;
          // squeezedLoad: pressing paint under the edge forces a share of it out sideways.
          if (v[i] > 0) {
            const out = Math.min(v[i], vol * squeezeShare), share = out / v[i];
            v[i] -= out; wv[i] += out;
            for (let k = 0; k < 3; k++) { const m = p[ni + k] * share; p[ni + k] -= m; wp[ni + k] += m; }
          }
          canvas.rough[c] = 0.06 + 0.10 * noise2(X * 1.3, Y * 1.3, seed);
        }
        // Requirement 2: two-way wet exchange, volume for volume, once per pass. Running it after
        // the deposit means a loaded tool covers what it crosses and thin fills don't turn translucent.
        if (pass[c] !== passId && canvas.top[c] > 1e-6 && canvas.surface(c) >= zHere - 0.03 && v[i] > volThreshold) {
          pass[c] = passId;
          const v2a = v[a], v2b = v[b], la = v2a > 1e-9 ? 1 / v2a : 0, lb = v2b > 1e-9 ? 1 / v2b : 0;
          const u = v2a <= 1e-9 ? 1 : v2b <= 1e-9 ? 0 : w;
          const room = u <= 0 ? v2a : u >= 1 ? v2b : Math.min(v2a / (1 - u), v2b / u);
          const h = Math.min(canvas.top[c] * swapRate, room / area * 0.5);
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
        const ax = ix, ay = iy, w = canvas.w, H = canvas.h;
        let localMean = 0, cnt = 0;
        for (const [ox, oy] of RING) {
          const bx = ax + Math.round(ox * ringR), by = ay + Math.round(oy * ringR);
          if (bx >= 0 && by >= 0 && bx < w && by < H) { localMean += canvas.surface(by * w + bx); cnt++; }
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
          canvas.rough[c] = 0.34;
          stats.stickDeposited++;
        } else stats.stickSkipped++;
      }
    }
    stampCounter++;

    // Squeeze: a node over its capacity sheds into the wave (squeezedLoad).
    const pressureCap = tool.capacity * (0.65 + 0.35 * clamp(stroke.gapMm / 1.2, 0, 1.6));
    for (let i = 0; i < N; i++) {
      const excess = v[i] - pressureCap;
      if (excess > 0) {
        const vol = excess * squeezeRate, frac = vol / v[i];
        v[i] -= vol; wv[i] += vol;
        for (let k = 0; k < 3; k++) { const m = p[i * 3 + k] * frac; p[i * 3 + k] -= m; wp[i * 3 + k] += m; }
      } else if (wv[i] > 0) {
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

    // Wave moves outward along the edge. It leaves only through the two sides.
    const split = Math.floor(N * sideBias);
    for (let i = iL; i < split; i++) moveWave(tool, i, i === iL ? -1 : i - 1, 0, lateral);
    for (let i = iR; i >= split; i--) moveWave(tool, i, i === iR ? -2 : i + 1, 1, lateral);
    for (let i = 0; i < iL; i++) moveWave(tool, i, -1, 0, 1);
    for (let i = N - 1; i > iR; i--) moveWave(tool, i, -2, 1, 1);

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

    // Side berms: the edge stores release irregular chunks just outside the footprint.
    // A berm can only be so large in cross-section; the rest rides on to the terminal heap.
    for (let side = 0; side < 2; side++) {
      allowance[side] = Math.min(allowance[side] + ds * (knife ? 1.5 : 0.8) * (0.2 + 1.6 * fbm1(s * 0.3, seed, 57 + side)), 0.6);
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
        canvas.cone(cx, cy, R, vol, tool.edgeP[pi] * conc, tool.edgeP[pi + 1] * conc, tool.edgeP[pi + 2] * conc, 0.10 + 0.06 * noise1(s * 0.7, seed, 55), 2);
        stats.bermVolume += vol;
        tool.edgeV[side] -= vol;
        for (let k = 0; k < 3; k++) tool.edgeP[pi + k] -= tool.edgeP[pi + k] * emitFrac;
        const rr = Math.ceil(R / dx) + 1;
        const ix = Math.floor(cx / dx), iy = Math.floor(cy / dx);
        if (ix - rr < x1) x1 = ix - rr; if (ix + rr > x2) x2 = ix + rr;
        if (iy - rr < y1) y1 = iy - rr; if (iy + rr > y2) y2 = iy + rr;
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

    // Terminal heap: as each node lifts, its wave and part of its load drop ahead of the tip.
    // A node a taper has already lifted off the paint sheds nothing; its bead went to the side.
    for (let i = 0; i < N; i++) {
      if (dumped[i] || s < end[i]) continue;
      dumped[i] = 1;
      if (i < iL - 1 || i > iR + 1) continue;
      // A clean lift keeps part of the bead on the knife instead of dropping it.
      const keep = heapScale < 1 ? 1 - heapScale : 0;
      if (keep > 0 && wv[i] > 0) {
        const kv = wv[i] * keep;
        for (let k = 0; k < 3; k++) { const m = wp[i * 3 + k] * keep; wp[i * 3 + k] -= m; p[i * 3 + k] += m; }
        wv[i] -= kv; v[i] += kv;
      }
      // A short mark sheds in proportion to its length; `heap` scales it further.
      const shed = v[i] > volThreshold ? Math.min(0.9, (knife ? 0.42 : 0.16) * (0.6 + 0.8 * hash(i, seed, 61)) * lift * heapScale) : 0;
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
      for (let part = 0; part < 4; part++) {
        const a = (part + 1) / 4;
        const jitter = (hash(i, seed, 65 + part) - 0.5) * R * 0.9;
        canvas.cone(px + nx * (q + jitter) + tx * fwd * a, py + ny * (q + jitter) + ty * fwd * a, R * 0.8, vol * 0.25, c0, c1, c2, rough, 1);
      }
      const cx = px + nx * q + tx * fwd, cy = py + ny * q + ty * fwd;
      stats.heapVolume += vol;
      const rr = Math.ceil((R + fwd) / dx) + 2, ix = Math.floor(cx / dx), iy = Math.floor(cy / dx);
      if (ix - rr < x1) x1 = ix - rr; if (ix + rr > x2) x2 = ix + rr;
      if (iy - rr < y1) y1 = iy - rr; if (iy + rr > y2) y2 = iy + rr;
    }
  }

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
  canvas.slump(x1 - pad, y1 - pad, x2 + pad, y2 + pad, knife ? 2.8 : 2.3, 3);
  canvas.level(x1 - pad, y1 - pad, x2 + pad, y2 + pad, 0.1, 1);
  canvas.levelFace(faceCells, face, passId, 0.22, 7);
  // Rounded peaks are recut into crests; a knife leaves harder, larger planes than a brush.
  canvas.facet(1, knife ? 0.6 : 0.5, knife ? 0.7 : 0.5, seed + 501);
  canvas.blendWetContact(seed);
  return stats;
}

const RING: readonly (readonly [number, number])[] = [[1, 0], [-1, 0], [0, 1], [0, -1], [0.7, 0.7], [-0.7, 0.7], [0.7, -0.7], [-0.7, -0.7]].map(([a, b]) => [a, b] as const);

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
