import { dsin, hash, noise2, smooth } from './dmath.ts';
import { ksFromSrgb, type RGB } from './pigment.ts';

/**
 * Height and pigment grid. A cell holds two paint layers: `top` (what the eye sees,
 * at most TOP_CAP thick) and `under`. Thickness is in mm; pigment fields hold
 * K/S x mm so they can be moved between cells without loss.
 */
export const TOP_CAP = 0.06;

export class PaintCanvas {
  readonly w: number; readonly h: number; readonly dx: number; readonly n: number;
  readonly tooth: Float64Array; readonly top: Float64Array; readonly under: Float64Array;
  readonly topP: Float64Array; readonly underP: Float64Array;
  /** Clearcoat GGX roughness last written to each cell. */
  readonly rough: Float32Array;
  readonly groundKs: RGB;
  /** Paint that landed outside the canvas. */
  lost = 0; readonly lostP = [0, 0, 0];
  readonly out = new Float64Array(4);
  /** Per-stroke bookkeeping: cells this stroke touched, and which belong to heaps and berms. */
  private strokeId = 0;
  private touch: Int32Array; private band: Int32Array; private bandDist: Int16Array;
  private touched: number[] = [];
  private heapCells: number[] = []; private bermCells: number[] = [];
  private facetMark: Int32Array;
  /** Scratch buffers reused across strokes, so the hot passes allocate nothing per cell. */
  private frontier: number[] = [];
  private pairNbr = new Int32Array(0); private pairLim = new Float64Array(0);
  private bleedStrength = new Float64Array(0); private bleedOn = new Uint8Array(0);
  private coneW = new Float64Array(0); private coneExx = new Float64Array(0);
  private facetTarget: Float64Array | null = null;

  constructor(widthMm: number, heightMm: number, dx: number, ground: RGB, seed = 1) {
    this.dx = dx;
    this.w = Math.round(widthMm / dx); this.h = Math.round(heightMm / dx); this.n = this.w * this.h;
    const n = this.n;
    this.tooth = new Float64Array(n); this.top = new Float64Array(n); this.under = new Float64Array(n);
    this.topP = new Float64Array(n * 3); this.underP = new Float64Array(n * 3);
    this.rough = new Float32Array(n).fill(0.62);
    this.groundKs = ksFromSrgb(ground);
    this.touch = new Int32Array(n); this.band = new Int32Array(n); this.bandDist = new Int16Array(n); this.facetMark = new Int32Array(n);
    // Plain-weave canvas: threads pass over and under about every 0.9 mm.
    const pitch = 0.62, PI = 3.141592653589793;
    for (let y = 0; y < this.h; y++) for (let x = 0; x < this.w; x++) {
      const X = x * dx, Y = y * dx;
      const u = X / pitch + 0.18 * dsin(Y * 0.23), v = Y / pitch + 0.18 * dsin(X * 0.19);
      const iu = Math.floor(u), iv = Math.floor(v);
      const au = dsin(PI * (u - iu)), av = dsin(PI * (v - iv));
      const thread = (iu + iv) & 1 ? au * (0.55 + 0.45 * av) : av * (0.55 + 0.45 * au);
      const fiber = noise2(X * 6, Y * 6, seed) * 0.35 + noise2(X * 0.5, Y * 0.5, seed + 3) * 0.5;
      this.tooth[y * this.w + x] = 0.034 * thread * (0.7 + 0.6 * noise2(iu * 0.37, iv * 0.41, seed + 8)) + 0.028 * fiber;
    }
  }

  surface(c: number): number { return this.tooth[c] + this.top[c] + this.under[c]; }
  inBounds(x: number, y: number) { return x >= 0 && y >= 0 && x < this.w && y < this.h; }
  cellAt(xMm: number, yMm: number): number {
    const x = Math.floor(xMm / this.dx), y = Math.floor(yMm / this.dx);
    return x >= 0 && y >= 0 && x < this.w && y < this.h ? y * this.w + x : -1;
  }

  /** Deposit thickness h with K/S concentration (c0,c1,c2). */
  add(c: number, h: number, c0: number, c1: number, c2: number): void {
    if (h <= 0) return;
    const { top, under, topP, underP } = this;
    const i = c * 3;
    const spill = Math.min(top[c], Math.max(0, top[c] + h - TOP_CAP));
    if (spill > 0) {
      const f = spill / top[c];
      let m = topP[i] * f; topP[i] -= m; underP[i] += m;
      m = topP[i + 1] * f; topP[i + 1] -= m; underP[i + 1] += m;
      m = topP[i + 2] * f; topP[i + 2] -= m; underP[i + 2] += m;
      top[c] -= spill; under[c] += spill;
    }
    top[c] += h; topP[i] += c0 * h; topP[i + 1] += c1 * h; topP[i + 2] += c2 * h;
    if (top[c] > TOP_CAP) {
      const over = top[c] - TOP_CAP, f = over / top[c];
      let m = topP[i] * f; topP[i] -= m; underP[i] += m;
      m = topP[i + 1] * f; topP[i + 1] -= m; underP[i + 1] += m;
      m = topP[i + 2] * f; topP[i + 2] -= m; underP[i + 2] += m;
      top[c] = TOP_CAP; under[c] += over;
    }
  }

  /** Remove up to h from the top down. Result in out: [thickness, p0, p1, p2]. */
  remove(c: number, h: number): Float64Array {
    const { top, under, topP, underP, out } = this;
    const i = c * 3;
    out[0] = out[1] = out[2] = out[3] = 0;
    const total = Math.min(h, top[c] + under[c]);
    if (total <= 0) return out;
    const fromTop = Math.min(total, top[c]);
    if (fromTop > 0) {
      const f = fromTop >= top[c] ? 1 : fromTop / top[c];
      let m = topP[i] * f; topP[i] -= m; out[1] += m;
      m = topP[i + 1] * f; topP[i + 1] -= m; out[2] += m;
      m = topP[i + 2] * f; topP[i + 2] -= m; out[3] += m;
      top[c] = f === 1 ? 0 : top[c] - fromTop;
    }
    const fromUnder = total - fromTop;
    if (fromUnder > 0 && under[c] > 0) {
      const f = fromUnder >= under[c] ? 1 : fromUnder / under[c];
      let m = underP[i] * f; underP[i] -= m; out[1] += m;
      m = underP[i + 1] * f; underP[i + 1] -= m; out[2] += m;
      m = underP[i + 2] * f; underP[i + 2] -= m; out[3] += m;
      under[c] = f === 1 ? 0 : under[c] - fromUnder;
    }
    out[0] = total;
    // Whatever lies below becomes the visible layer again.
    if (top[c] < TOP_CAP && under[c] > 0) {
      const pull = Math.min(TOP_CAP - top[c], under[c]);
      const f = pull >= under[c] ? 1 : pull / under[c];
      let m = underP[i] * f; underP[i] -= m; topP[i] += m;
      m = underP[i + 1] * f; underP[i + 1] -= m; topP[i + 1] += m;
      m = underP[i + 2] * f; underP[i + 2] -= m; topP[i + 2] += m;
      top[c] += pull; under[c] = f === 1 ? 0 : under[c] - pull;
    }
    return out;
  }

  /** Swap thickness h of the visible layer for paint of concentration (c0,c1,c2); volume is unchanged. */
  exchange(c: number, h: number, c0: number, c1: number, c2: number, out: Float64Array): void {
    const i = c * 3, t = this.top[c];
    out[0] = out[1] = out[2] = out[3] = 0;
    if (h <= 0 || t <= 0) return;
    const f = h >= t ? 1 : h / t, moved = t * f;
    const { topP } = this;
    let m = topP[i] * f, inc = c0 * moved;
    topP[i] += inc - m; out[1] = m;
    m = topP[i + 1] * f; inc = c1 * moved;
    topP[i + 1] += inc - m; out[2] = m;
    m = topP[i + 2] * f; inc = c2 * moved;
    topP[i + 2] += inc - m; out[3] = m;
    out[0] = moved;
  }

  beginStroke(): void {
    this.strokeId++;
    this.touched = []; this.heapCells = []; this.bermCells = [];
  }
  mark(c: number): void {
    if (this.touch[c] !== this.strokeId) { this.touch[c] = this.strokeId; this.touched.push(c); }
  }

  /**
   * Mass-conserving rounded dome of paint with a definite contact edge, used for berms and heaps.
   * `sharp` (0-1, stiff paint) blends the dome toward a peaked cone that keeps a steep skirt at its contact edge,
   * so overlapping cones build a ridge with a crisp crest instead of a rounded bead.
   */
  cone(xMm: number, yMm: number, radiusMm: number, volume: number, c0: number, c1: number, c2: number, rough: number, kind: 0 | 1 | 2 = 0, sharp = 0): void {
    if (volume <= 0) return;
    const { dx, w: W, h: H } = this;
    const R = Math.max(radiusMm, dx * 1.2), RR = R * R;
    const x0 = Math.floor((xMm - R) / dx), x1 = Math.ceil((xMm + R) / dx);
    const y0 = Math.floor((yMm - R) / dx), y1 = Math.ceil((yMm + R) / dx);
    const nx = x1 - x0 + 1, ny = y1 - y0 + 1;
    // Weights are computed once into a scratch buffer and read back in the deposit pass.
    let ws = this.coneW, exx = this.coneExx;
    if (ws.length < nx * ny) ws = this.coneW = new Float64Array(Math.max(nx * ny, ws.length * 2));
    if (exx.length < nx) exx = this.coneExx = new Float64Array(Math.max(nx, exx.length * 2));
    for (let x = x0; x <= x1; x++) { const ex = (x + 0.5) * dx - xMm; exx[x - x0] = ex * ex; }
    // Weights cover the whole cone: whatever falls past the canvas edge is recorded as lost
    // and never piled onto the few cells that remain inside.
    let sum = 0, inside = 0, i = 0;
    for (let y = y0; y <= y1; y++) {
      const ey = (y + 0.5) * dx - yMm, eyy = ey * ey, yin = y >= 0 && y < H;
      if (sharp > 0) {
        for (let x = x0; x <= x1; x++, i++) {
          const rr = 1 - (exx[x - x0] + eyy) / RR;
          let w = 0;
          if (!(rr <= 0.15)) { const dome = Math.sqrt(rr); w = dome + (1 - 0.7 * Math.sqrt(1 - rr) - dome) * sharp; }
          ws[i] = w;
          if (w > 0) { sum += w; if (x >= 0 && yin && x < W) inside += w; }
        }
      } else {
        for (let x = x0; x <= x1; x++, i++) {
          const rr = 1 - (exx[x - x0] + eyy) / RR;
          const w = rr > 0.15 ? Math.sqrt(rr) : 0;
          ws[i] = w;
          if (w > 0) { sum += w; if (x >= 0 && yin && x < W) inside += w; }
        }
      }
    }
    if (sum <= 0) sum = inside = 1;
    const lostVolume = volume * (1 - inside / sum);
    if (lostVolume > 0) {
      this.lost += lostVolume; this.lostP[0] += c0 * lostVolume; this.lostP[1] += c1 * lostVolume; this.lostP[2] += c2 * lostVolume;
    }
    if (inside <= 0) return;
    const thick = volume / (sum * dx * dx);
    const { rough: roughA, facetMark } = this, fid = this.strokeId * 2 + kind;
    const facetList = kind === 1 ? this.heapCells : this.bermCells;
    const ya = Math.max(y0, 0), yb = Math.min(y1, H - 1), xa = Math.max(x0, 0), xb = Math.min(x1, W - 1);
    for (let y = ya; y <= yb; y++) {
      let i = (y - y0) * nx + (xa - x0);
      for (let x = xa; x <= xb; x++, i++) {
        const w = ws[i];
        if (w > 0) {
          const c = y * W + x;
          this.mark(c);
          this.add(c, thick * w, c0, c1, c2); roughA[c] = rough;
          if (kind !== 0 && facetMark[c] !== fid) { facetMark[c] = fid; facetList.push(c); }
        }
      }
    }
  }

  /** Yield-stress relaxation: only slopes steeper than maxSlope move. Conserves mass. */
  slump(x0: number, y0: number, x1: number, y1: number, maxSlope: number, iterations: number): void {
    const { w, h, dx } = this;
    const X0 = Math.max(1, x0), Y0 = Math.max(1, y0), X1 = Math.min(w - 2, x1), Y1 = Math.min(h - 2, y1);
    const limit = maxSlope * dx;
    const { tooth, top, under } = this;
    for (let it = 0; it < iterations; it++) {
      for (let y = Y0; y <= Y1; y++) for (let x = X0; x <= X1; x++) {
        const c = y * w + x;
        // The cell's own height is read once for both neighbours, as before.
        const sc = tooth[c] + top[c] + under[c];
        let d = c + 1;
        let diff = sc - (tooth[d] + top[d] + under[d]);
        if (diff > limit) this.moveTo(c, d, (diff - limit) * 0.5);
        else if (-diff > limit) this.moveTo(d, c, (-diff - limit) * 0.5);
        d = c + w;
        diff = sc - (tooth[d] + top[d] + under[d]);
        if (diff > limit) this.moveTo(c, d, (diff - limit) * 0.5);
        else if (-diff > limit) this.moveTo(d, c, (-diff - limit) * 0.5);
      }
    }
  }
  /** Slight viscous leveling so a one-cell step never reads as a voxel. Conserves mass. */
  level(x0: number, y0: number, x1: number, y1: number, rate: number, iterations: number): void {
    const { w, h } = this;
    const X0 = Math.max(1, x0), Y0 = Math.max(1, y0), X1 = Math.min(w - 2, x1), Y1 = Math.min(h - 2, y1);
    const { tooth, top, under } = this;
    for (let it = 0; it < iterations; it++) {
      for (let y = Y0; y <= Y1; y++) for (let x = X0; x <= X1; x++) {
        const c = y * w + x;
        // The cell's height is re-read for the second neighbour: the first move may have changed it.
        let d = c + 1;
        let diff = (tooth[c] + top[c] + under[c]) - (tooth[d] + top[d] + under[d]);
        if (diff > 0.004 && top[c] + under[c] > 0) this.moveTo(c, d, diff * rate);
        else if (diff < -0.004 && top[d] + under[d] > 0) this.moveTo(d, c, -diff * rate);
        d = c + w;
        diff = (tooth[c] + top[c] + under[c]) - (tooth[d] + top[d] + under[d]);
        if (diff > 0.004 && top[c] + under[c] > 0) this.moveTo(c, d, diff * rate);
        else if (diff < -0.004 && top[d] + under[d] > 0) this.moveTo(d, c, -diff * rate);
      }
    }
  }
  /** Moves paint from below the visible layer where possible, so relaxing height doesn't smear colour. */
  private moveTo(from: number, to: number, h: number): void {
    const { top, under, underP } = this;
    const body = Math.min(h, under[from]);
    if (body > 0 && top[to] >= TOP_CAP * 0.5) {
      const f = body >= under[from] ? 1 : body / under[from], f3 = from * 3, t3 = to * 3;
      let m = underP[f3] * f; underP[f3] -= m; underP[t3] += m;
      m = underP[f3 + 1] * f; underP[f3 + 1] -= m; underP[t3 + 1] += m;
      m = underP[f3 + 2] * f; underP[f3 + 2] -= m; underP[t3 + 2] += m;
      under[from] = f === 1 ? 0 : under[from] - body;
      under[to] += body;
      h -= body;
      if (h <= 0) return;
    }
    const r = this.remove(from, h);
    if (r[0] > 0) {
      const t = r[0];
      this.add(to, t, r[1] / t, r[2] / t, r[3] / t);
    }
  }

  /** Relaxes the sheared face of a knife stroke to a smooth plane. Only moves paint under the visible layer. */
  levelFace(cells: number[], mask: Int32Array, id: number, rate: number, iterations: number): void {
    const { w, n, tooth, top, under, underP } = this;
    for (let it = 0; it < iterations; it++) {
      for (let ci = 0, nc = cells.length; ci < nc; ci++) {
        const c = cells[ci];
        for (let q = 0; q < 2; q++) {
          const d = q === 0 ? c + 1 : c + w;
          if (d >= n || mask[d] !== id || (q === 0 && d % w === 0)) continue;
          const diff = (tooth[c] + top[c] + under[c]) - (tooth[d] + top[d] + under[d]);
          const from = diff > 0 ? c : d, to = diff > 0 ? d : c;
          const h = Math.min((diff > 0 ? diff : -diff) * rate, under[from]);
          if (h <= 0) continue;
          const f = h >= under[from] ? 1 : h / under[from];
          const f3 = from * 3, t3 = to * 3;
          let m = underP[f3] * f; underP[f3] -= m; underP[t3] += m;
          m = underP[f3 + 1] * f; underP[f3 + 1] -= m; underP[t3 + 1] += m;
          m = underP[f3 + 2] * f; underP[f3 + 2] -= m; underP[t3 + 2] += m;
          under[from] = f === 1 ? 0 : under[from] - h;
          under[to] += h;
        }
      }
    }
  }

  /**
   * Recuts rounded peaks into crests: each patch of a jittered grid gets a best-fit plane with a
   * random tilt, and the surface takes the lowest plane nearby. Taking the minimum keeps it
   * continuous and turns every join into a sharp ridge. Volume is preserved within each tile.
   */
  facet(kind: 1 | 2, sizeMm: number, tilt: number, seed: number, crest = 0.3): void {
    const cells = kind === 1 ? this.heapCells : this.bermCells;
    if (cells.length < 12) return;
    const { w, dx } = this, id = this.strokeId * 2 + kind;
    const siteOf = (X: number, Y: number) => {
      const gi = Math.floor(X / sizeMm), gj = Math.floor(Y / sizeMm);
      let best = -1, bestD = 1e18;
      for (let a = gi - 1; a <= gi + 1; a++) for (let b = gj - 1; b <= gj + 1; b++) {
        const sx = (a + hash(a, b, seed)) * sizeMm, sy = (b + hash(a, b, seed + 1)) * sizeMm;
        const d = (sx - X) * (sx - X) + (sy - Y) * (sy - Y);
        if (d < bestD) { bestD = d; best = a * 100000 + b; }
      }
      return best;
    };
    // Least-squares plane for each patch.
    const sums = new Map<number, Float64Array>();
    for (const c of cells) {
      const x = c % w, y = (c - x) / w, X = x * dx, Y = y * dx, S = this.surface(c), site = siteOf(X, Y);
      let a = sums.get(site);
      if (!a) { a = new Float64Array(9); sums.set(site, a); }
      a[0]++; a[1] += X; a[2] += Y; a[3] += S; a[4] += X * X; a[5] += Y * Y; a[6] += X * Y; a[7] += X * S; a[8] += Y * S;
    }
    const planes = new Map<number, Float64Array>();
    for (const [site, a] of sums) {
      const n = a[0], mx = a[1] / n, my = a[2] / n, ms = a[3] / n;
      const xx = a[4] / n - mx * mx, yy = a[5] / n - my * my, xy = a[6] / n - mx * my, xs = a[7] / n - mx * ms, ys = a[8] / n - my * ms;
      const det = xx * yy - xy * xy;
      let gx = 0, gy = 0;
      if (n >= 5 && det > 1e-9) { gx = (yy * xs - xy * ys) / det; gy = (xx * ys - xy * xs) / det; }
      const gi = Math.floor(site / 100000 + 0.0000001), gj = site - gi * 100000;
      gx += (hash(gi, gj, seed + 2) - 0.5) * tilt; gy += (hash(gi, gj, seed + 3) - 0.5) * tilt;
      // Lift each plane by half a patch of slope, so taking the minimum leaves crests and not a dent.
      planes.set(site, Float64Array.of(mx, my, ms + (Math.abs(gx) + Math.abs(gy)) * sizeMm * 0.18, gx, gy));
    }
    const tiles = new Map<number, number[]>();
    // Target heights live in a canvas-sized scratch array (every cell in `cells` is written before it is read).
    let target = this.facetTarget;
    if (!target) target = this.facetTarget = new Float64Array(this.n);
    for (const c of cells) {
      const x = c % w, y = (c - x) / w, X = x * dx, Y = y * dx, S = this.surface(c);
      const gi = Math.floor(X / sizeMm), gj = Math.floor(Y / sizeMm);
      let T = 1e18;
      for (let a = gi - 1; a <= gi + 1; a++) for (let b = gj - 1; b <= gj + 1; b++) {
        const p = planes.get(a * 100000 + b);
        if (!p) continue;
        const ex = X - p[0], ey = Y - p[1];
        if (ex * ex + ey * ey > 2.6 * sizeMm * sizeMm) continue;
        const v = p[2] + p[3] * ex + p[4] * ey;
        if (v < T) T = v;
      }
      if (T > 1e17) T = S;
      T = T < S - 0.8 ? S - 0.8 : T > S + 0.8 ? S + 0.8 : T;
      target[c] = T;
      const tile = Math.floor(X / 6) * 1000 + Math.floor(Y / 6);
      let list = tiles.get(tile);
      if (!list) { list = []; tiles.set(tile, list); }
      list.push(c);
    }
    // Only the upper part of a heap is recut. Its flanks stay wet and meet the paint around them.
    for (const list of tiles.values()) {
      let lo = 1e18, hi = -1e18;
      for (const c of list) { const S = this.surface(c); if (S < lo) lo = S; if (S > hi) hi = S; }
      for (const c of list) {
        const S = this.surface(c), share = smooth(((S - lo) / (hi - lo + 1e-6) - crest) / 0.35);
        target[c] = S + (target[c] - S) * share;
        if (share > 0.5) this.rough[c] = 0.06 + 0.04 * hash(c, seed, 5);
      }
    }
    for (const list of tiles.values()) this.redistribute(list, target);
  }

  /** Moves paint within these cells toward their target heights. Whatever is taken is put back. */
  private redistribute(list: number[], target: Float64Array): void {
    let drift = 0;
    for (const c of list) drift += this.surface(c) - target[c];
    drift /= list.length;
    const pool = [0, 0, 0, 0];
    const short: number[] = [], need: number[] = [];
    let wanted = 0;
    for (const c of list) {
      const T = Math.max(this.tooth[c], target[c] + drift), delta = T - this.surface(c);
      if (delta >= 0) { if (delta > 0) { short.push(c); need.push(delta); wanted += delta; } continue; }
      let take = -delta;
      const body = Math.min(take, this.under[c]);
      if (body > 0) {
        const f = body >= this.under[c] ? 1 : body / this.under[c];
        for (let k = 0; k < 3; k++) { const m = this.underP[c * 3 + k] * f; this.underP[c * 3 + k] -= m; pool[k + 1] += m; }
        this.under[c] = f === 1 ? 0 : this.under[c] - body;
        pool[0] += body; take -= body;
      }
      if (take > 0) {
        const r = this.remove(c, take);
        pool[0] += r[0]; pool[1] += r[1]; pool[2] += r[2]; pool[3] += r[3];
      }
    }
    if (pool[0] <= 0) return;
    if (wanted <= 0) { short.push(list[0]); need.push(1); wanted = 1; }
    const k0 = pool[1] / pool[0], k1 = pool[2] / pool[0], k2 = pool[3] / pool[0];
    const place = (c: number, h: number) => {
      if (this.top[c] >= TOP_CAP * 0.5) {
        this.under[c] += h; this.underP[c * 3] += k0 * h; this.underP[c * 3 + 1] += k1 * h; this.underP[c * 3 + 2] += k2 * h;
      } else this.add(c, h, k0, k1, k2);
    };
    // No cell takes much more than it asked for. Any remainder spreads evenly, so nothing spikes.
    let left = pool[0];
    for (let i = 0; i < short.length; i++) {
      const h = Math.min(pool[0] * need[i] / wanted, need[i] * 1.5);
      place(short[i], h); left -= h;
    }
    if (left > 0) for (const c of list) place(c, left / list.length);
  }

  /**
   * Where a stroke meets paint that is already there, wet paint flows together: the step relaxes
   * into a fillet and pigment bleeds across the join. Edges on bare canvas are left steep.
   */
  blendWetContact(seed: number, stiffness = 0): void {
    const { w, n, dx, tooth, top, under, band, bandDist, touch } = this, id = this.strokeId;
    // Stiff paint (high yield stress) holds a real step: where neighbouring cells differ by more
    // than `tall`, the fillet only knocks off what is steeper than about 80 degrees. Smaller steps
    // (thin films caught on the weave, the skirt of a berm) still relax, so nothing reads as voxels.
    // Pigment barely bleeds across the join.
    const hold = stiffness > 0 ? 1 + 5 * stiffness : 1, bleed = stiffness > 0 ? 1 - 0.9 * stiffness : 1;
    const tall = stiffness > 0 ? 1.5 * dx : 0;
    const radius = Math.max(3, Math.round(0.8 / dx));
    const frontier = this.frontier; frontier.length = 0;
    // Seeds: touched cells with paint next to untouched paint, in the order right, left, down, up.
    const touched = this.touched;
    for (let i = 0, nt = touched.length; i < nt; i++) {
      const c = touched[i];
      if (top[c] + under[c] <= 0.04) continue;
      const x = c % w;
      for (let q = 0; q < 4; q++) {
        const d = q === 0 ? (x + 1 < w ? c + 1 : -1) : q === 1 ? (x > 0 ? c - 1 : -1) : q === 2 ? (c + w < n ? c + w : -1) : (c - w >= 0 ? c - w : -1);
        if (d >= 0 && touch[d] !== id && top[d] + under[d] > 0.12) {
          if (band[c] !== id) { band[c] = id; bandDist[c] = 0; frontier.push(c); }
          if (band[d] !== id) { band[d] = id; bandDist[d] = 0; frontier.push(d); }
        }
      }
    }
    if (!frontier.length) return;
    for (let i = 0; i < frontier.length; i++) {
      const c = frontier[i], dist = bandDist[c];
      if (dist >= radius) continue;
      const x = c % w;
      for (let q = 0; q < 4; q++) {
        const d = q === 0 ? (x + 1 < w ? c + 1 : -1) : q === 1 ? (x > 0 ? c - 1 : -1) : q === 2 ? (c + w < n ? c + w : -1) : (c - w >= 0 ? c - w : -1);
        if (d >= 0 && band[d] !== id && top[d] + under[d] > 0.04) { band[d] = id; bandDist[d] = dist + 1; frontier.push(d); }
      }
    }
    // The band is fixed from here on, so each cell's right and down partners and the base of their
    // slope limit are worked out once instead of on every pass.
    const nf = frontier.length;
    let nbr = this.pairNbr, lim = this.pairLim;
    if (nbr.length < nf * 2) { nbr = this.pairNbr = new Int32Array(Math.max(nf * 2, nbr.length * 2)); lim = this.pairLim = new Float64Array(nbr.length); }
    for (let i = 0; i < nf; i++) {
      const c = frontier[i], x = c % w;
      for (let q = 0; q < 2; q++) {
        const d = q === 0 ? (x + 1 < w ? c + 1 : -1) : (c + w < n ? c + w : -1);
        if (d < 0 || band[d] !== id) { nbr[i * 2 + q] = -1; continue; }
        nbr[i * 2 + q] = d;
        const near = Math.min(bandDist[c], bandDist[d]) / radius;
        lim[i * 2 + q] = dx * (0.75 + 1.0 * near);
      }
    }
    // The fillet: steepness allowed grows with distance from the join.
    for (let it = 0; it < 9; it++) {
      for (let i = 0; i < nf; i++) {
        const c = frontier[i];
        for (let q = 0; q < 2; q++) {
          const d = nbr[i * 2 + q];
          if (d < 0) continue;
          const diff = (tooth[c] + top[c] + under[c]) - (tooth[d] + top[d] + under[d]);
          const base = lim[i * 2 + q];
          const limit = diff > tall || -diff > tall ? base * hold : base;
          if (diff > limit) this.moveTo(c, d, (diff - limit) * 0.5);
          else if (-diff > limit) this.moveTo(d, c, (-diff - limit) * 0.5);
        }
      }
    }
    // Colour bleed: short irregular fingers along the join, not a uniform blur. Conserves pigment.
    // The gate depends only on the cell, so it is evaluated once rather than on each of the 8 passes.
    const reach = Math.max(2, Math.round(0.45 / dx));
    const { topP } = this;
    let strength = this.bleedStrength, on = this.bleedOn;
    if (strength.length < nf) { strength = this.bleedStrength = new Float64Array(Math.max(nf, strength.length * 2)); on = this.bleedOn = new Uint8Array(strength.length); }
    for (let i = 0; i < nf; i++) {
      const c = frontier[i], dist = bandDist[c];
      on[i] = 0;
      if (dist > reach) continue;
      const x = c % w, y = (c - x) / w;
      const gate = smooth((noise2(x * dx * 1.3, y * dx * 1.3, seed + 31) - 0.42) / 0.16);
      if (gate <= 0) continue;
      strength[i] = 0.2 * (1 - dist / (reach + 1)) * gate * bleed;
      on[i] = 1;
    }
    for (let it = 0; it < 8; it++) {
      for (let i = 0; i < nf; i++) {
        if (on[i] === 0) continue;
        const c = frontier[i], s = strength[i], c3 = c * 3;
        for (let q = 0; q < 2; q++) {
          const d = nbr[i * 2 + q];
          if (d < 0 || top[c] <= 1e-6 || top[d] <= 1e-6) continue;
          const shared = Math.min(top[c], top[d]) * s, d3 = d * 3;
          for (let k = 0; k < 3; k++) {
            const flux = shared * (topP[c3 + k] / top[c] - topP[d3 + k] / top[d]);
            topP[c3 + k] -= flux; topP[d3 + k] += flux;
          }
        }
      }
    }
  }

  totalVolume(): number {
    let v = 0;
    for (let c = 0; c < this.n; c++) v += this.top[c] + this.under[c];
    return v * this.dx * this.dx;
  }
  totalPigment(): [number, number, number] {
    const p: [number, number, number] = [0, 0, 0];
    for (let c = 0; c < this.n; c++) for (let k = 0; k < 3; k++) p[k] += this.topP[c * 3 + k] + this.underP[c * 3 + k];
    const a = this.dx * this.dx;
    return [p[0] * a, p[1] * a, p[2] * a];
  }
}
