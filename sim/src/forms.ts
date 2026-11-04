/**
 * The form hierarchy: the image split into forms at several scales, coarse to fine, so a stroke at
 * each scale can respect the shape it belongs to (a tree against a mountain, a petal against the
 * next), not only the nearest edge.
 *
 * Segmentation is Felzenszwalb and Huttenlocher's graph method (2004) on the analysis grid, run
 * with increasing scale on the same union-find, so every coarse form is a union of finer ones and
 * the levels nest exactly. Edges are sorted with a typed-array sort on a key that ends in the edge's
 * index, so ties always break the same way. Nothing here knows what the subject is.
 */
import { gaussBlur, type Grid } from './image.ts';

export interface FormLevel {
  /** Form id per analysis cell, 0..count-1, numbered in scan order of first appearance. */
  label: Int32Array;
  count: number;
  /** Per form: cell count, mean OKLab colour, principal axis as a doubled-angle unit vector, elongation 0-1. */
  area: Float64Array; colour: Float64Array; axis: Float64Array; elongation: Float64Array;
  /** Per form: 0 for ground (large, open, low contrast) to 1 for figure (compact, enclosed, contrasting). */
  figure: Float64Array;
  /** Per cell: distance to the form's boundary, cells (chamfer). */
  inset: Float64Array;
  /** Per cell: direction along the form's contour (perpendicular to the inset gradient), doubled-angle. */
  contour: Float64Array;
}

export interface FormHierarchy { w: number; h: number; levels: FormLevel[]; }

/**
 * @param lab OKLab image on the analysis grid.
 * @param counts target number of forms per level, coarse first (e.g. from the canvas area).
 */
export function formHierarchy(lab: Grid, counts: number[]): FormHierarchy {
  const { w, h } = lab, n = w * h;
  const img = gaussBlur(lab, 0.8);
  // 1. Superpixels: Felzenszwalb-Huttenlocher with a small scale. Edges to the right, down,
  //    down-right and down-left neighbour, sorted by weight with the edge index breaking ties.
  const ea = new Int32Array(n * 4), eb = new Int32Array(n * 4), ew = new Float64Array(n * 4);
  let m = 0;
  const d = (a: number, b: number) => {
    const x = img.data[a * 3] - img.data[b * 3], y = img.data[a * 3 + 1] - img.data[b * 3 + 1], z = img.data[a * 3 + 2] - img.data[b * 3 + 2];
    return Math.sqrt(x * x + y * y + z * z);
  };
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x;
    if (x + 1 < w) { ea[m] = i; eb[m] = i + 1; ew[m] = d(i, i + 1); m++; }
    if (y + 1 < h) { ea[m] = i; eb[m] = i + w; ew[m] = d(i, i + w); m++; }
    if (x + 1 < w && y + 1 < h) { ea[m] = i; eb[m] = i + w + 1; ew[m] = d(i, i + w + 1) * 0.7071067811865476; m++; }
    if (x > 0 && y + 1 < h) { ea[m] = i; eb[m] = i + w - 1; ew[m] = d(i, i + w - 1) * 0.7071067811865476; m++; }
  }
  const keys = new Float64Array(m);
  for (let e = 0; e < m; e++) keys[e] = Math.floor(ew[e] * 1e7) * 8388608 + e;
  keys.sort();
  const order = new Int32Array(m);
  for (let e = 0; e < m; e++) order[e] = keys[e] % 8388608;
  const parent = new Int32Array(n), size = new Int32Array(n).fill(1), internal = new Float64Array(n);
  for (let i = 0; i < n; i++) parent[i] = i;
  const find = (i: number) => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
  const unite = (a: number, b: number, wgt: number) => {
    if (size[a] < size[b] || (size[a] === size[b] && b < a)) { const t = a; a = b; b = t; }
    parent[b] = a; size[a] += size[b];
    const mx = internal[a] > internal[b] ? internal[a] : internal[b];
    internal[a] = wgt > mx ? wgt : mx;
  };
  const k = 0.35, minSize = 12;
  for (let q = 0; q < m; q++) {
    const e = order[q], a = find(ea[e]), b = find(eb[e]);
    if (a !== b && ew[e] <= Math.min(internal[a] + k / size[a], internal[b] + k / size[b])) unite(a, b, ew[e]);
  }
  for (let q = 0; q < m; q++) {
    const e = order[q], a = find(ea[e]), b = find(eb[e]);
    if (a !== b && (size[a] < minSize || size[b] < minSize)) unite(a, b, ew[e]);
  }
  const sp = new Int32Array(n), spMap = new Map<number, number>();
  for (let i = 0; i < n; i++) { const r = find(i); let id = spMap.get(r); if (id === undefined) { id = spMap.size; spMap.set(r, id); } sp[i] = id; }
  const S = spMap.size;

  // 2. Agglomerative merging of superpixels (Ward: the pair whose union adds least colour
  //    variance merges first), recording a level each time the count reaches a target.
  const area = new Float64Array(S), sum = new Float64Array(S * 3);
  for (let i = 0; i < n; i++) { const f = sp[i]; area[f]++; for (let c = 0; c < 3; c++) sum[f * 3 + c] += lab.data[i * 3 + c]; }
  const adj: Map<number, number>[] = Array.from({ length: S }, () => new Map());
  for (let e = 0; e < m; e++) {
    const a = sp[ea[e]], b = sp[eb[e]];
    if (a !== b) { adj[a].set(b, (adj[a].get(b) ?? 0) + 1); adj[b].set(a, (adj[b].get(a) ?? 0) + 1); }
  }
  const ward = (a: number, b: number) => {
    let d2 = 0;
    for (let c = 0; c < 3; c++) { const x = sum[a * 3 + c] / area[a] - sum[b * 3 + c] / area[b]; d2 += x * x; }
    return area[a] * area[b] / (area[a] + area[b]) * d2;
  };
  // Binary heap of (cost, a, b) with stale entries skipped by version numbers.
  const version = new Int32Array(S), alive = new Uint8Array(S).fill(1), up = new Int32Array(S);
  for (let i = 0; i < S; i++) up[i] = i;
  const top = (i: number) => { while (up[i] !== i) { up[i] = up[up[i]]; i = up[i]; } return i; };
  type Item = [number, number, number, number, number];
  const heap: Item[] = [];
  const less = (p: Item, q: Item) => p[0] < q[0] || (p[0] === q[0] && (p[1] < q[1] || (p[1] === q[1] && p[2] < q[2])));
  const push = (it: Item) => { heap.push(it); let i = heap.length - 1; while (i > 0) { const pi = (i - 1) >> 1; if (!less(heap[i], heap[pi])) break; [heap[i], heap[pi]] = [heap[pi], heap[i]]; i = pi; } };
  const pop = (): Item => {
    const r = heap[0], last = heap.pop()!;
    if (heap.length) { heap[0] = last; let i = 0; for (;;) { const l = 2 * i + 1, rr = l + 1; let s = i; if (l < heap.length && less(heap[l], heap[s])) s = l; if (rr < heap.length && less(heap[rr], heap[s])) s = rr; if (s === i) break; [heap[i], heap[s]] = [heap[s], heap[i]]; i = s; } }
    return r;
  };
  for (let a = 0; a < S; a++) for (const b of adj[a].keys()) if (a < b) push([ward(a, b), a, b, 0, 0]);
  const targets = counts.slice().sort((x, y) => y - x); // fine (most forms) first
  const snapshots: Int32Array[] = [];
  let live = S, t = 0;
  const snap = () => { const lab2 = new Int32Array(S); for (let i = 0; i < S; i++) lab2[i] = top(i); snapshots.push(lab2); };
  while (t < targets.length && live <= targets[t]) { snap(); t++; }
  while (t < targets.length && heap.length) {
    const [, a, b, va, vb] = pop();
    if (!alive[a] || !alive[b] || version[a] !== va || version[b] !== vb) continue;
    // Merge b into a.
    alive[b] = 0; up[b] = a; area[a] += area[b];
    for (let c = 0; c < 3; c++) sum[a * 3 + c] += sum[b * 3 + c];
    for (const [nb, len] of adj[b]) {
      if (nb === a) continue;
      adj[a].set(nb, (adj[a].get(nb) ?? 0) + len);
      adj[nb].delete(b); adj[nb].set(a, (adj[nb].get(a) ?? 0) + len);
    }
    adj[a].delete(b); adj[b].clear();
    version[a]++;
    for (const nb of adj[a].keys()) { const lo = a < nb ? a : nb, hi = a < nb ? nb : a; push([ward(lo, hi), lo, hi, version[lo], version[hi]]); }
    live--;
    while (t < targets.length && live <= targets[t]) { snap(); t++; }
  }
  while (snapshots.length < targets.length) snap();
  const levels = snapshots.map((s2) => describe(w, h, lab, (i: number) => s2[sp[i]]));
  levels.reverse(); // coarse first
  return { w, h, levels };
}

function describe(w: number, h: number, lab: Grid, find: (i: number) => number): FormLevel {
  const n = w * h, label = new Int32Array(n), map = new Map<number, number>();
  for (let i = 0; i < n; i++) {
    const r = find(i);
    let id = map.get(r);
    if (id === undefined) { id = map.size; map.set(r, id); }
    label[i] = id;
  }
  const count = map.size;
  const area = new Float64Array(count), colour = new Float64Array(count * 3), mx = new Float64Array(count), my = new Float64Array(count);
  const sxx = new Float64Array(count), syy = new Float64Array(count), sxy = new Float64Array(count);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x, f = label[i];
    area[f]++; mx[f] += x; my[f] += y;
    for (let k = 0; k < 3; k++) colour[f * 3 + k] += lab.data[i * 3 + k];
  }
  for (let f = 0; f < count; f++) { mx[f] /= area[f]; my[f] /= area[f]; for (let k = 0; k < 3; k++) colour[f * 3 + k] /= area[f]; }
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const f = label[y * w + x], dx = x - mx[f], dy = y - my[f];
    sxx[f] += dx * dx; syy[f] += dy * dy; sxy[f] += dx * dy;
  }
  const axis = new Float64Array(count * 2), elongation = new Float64Array(count);
  for (let f = 0; f < count; f++) {
    const a = sxx[f] / area[f], b = syy[f] / area[f], c = sxy[f] / area[f];
    const tr = a + b, an = Math.sqrt((a - b) * (a - b) + 4 * c * c);
    elongation[f] = tr > 1e-9 ? an / tr : 0;
    // Major axis as doubled angle: (cos 2t, sin 2t) = ((a - b), 2c) / an.
    axis[f * 2] = an > 1e-12 ? (a - b) / an : 1; axis[f * 2 + 1] = an > 1e-12 ? 2 * c / an : 0;
  }
  const inset = chamfer(w, h, label);
  // Contour direction: perpendicular to the inset gradient, as a doubled angle (smoothed a little).
  const g = { w, h, ch: 3, data: new Float64Array(n * 3) };
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x;
    const gx = (x + 1 < w ? inset[i + 1] : inset[i]) - (x > 0 ? inset[i - 1] : inset[i]);
    const gy = (y + 1 < h ? inset[i + w] : inset[i]) - (y > 0 ? inset[i - w] : inset[i]);
    // The tangent t = (-gy, gx); doubled angle of t is (tx^2 - ty^2, 2 tx ty) = (gy^2 - gx^2, -2 gx gy).
    g.data[i * 3] = gy * gy - gx * gx; g.data[i * 3 + 1] = -2 * gx * gy; g.data[i * 3 + 2] = gx * gx + gy * gy;
  }
  const gs = gaussBlur(g, 1.5), contour = new Float64Array(n * 2);
  for (let i = 0; i < n; i++) {
    const c = gs.data[i * 3], s = gs.data[i * 3 + 1], mag = Math.sqrt(c * c + s * s);
    contour[i * 2] = mag > 1e-12 ? c / mag : 1; contour[i * 2 + 1] = mag > 1e-12 ? s / mag : 0;
  }
  // Figure against ground: compact, enclosed by one neighbour, contrasting, and not huge.
  const border = new Map<number, number>(), perim = new Float64Array(count);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x, f = label[i];
    for (const j of [x + 1 < w ? i + 1 : -1, y + 1 < h ? i + w : -1]) {
      if (j < 0 || label[j] === f) continue;
      const g2 = label[j];
      perim[f]++; perim[g2]++;
      border.set(f * count + g2, (border.get(f * count + g2) ?? 0) + 1);
      border.set(g2 * count + f, (border.get(g2 * count + f) ?? 0) + 1);
    }
  }
  const mainNeighbour = new Int32Array(count).fill(-1), mainShare = new Float64Array(count);
  for (const [key, len] of border) {
    const f = Math.floor(key / count), g2 = key - f * count;
    if (len > mainShare[f] || (len === mainShare[f] && g2 < mainNeighbour[f])) { mainShare[f] = len; mainNeighbour[f] = g2; }
  }
  const figure = new Float64Array(count), total = n;
  for (let f = 0; f < count; f++) {
    const enclosed = perim[f] > 0 ? mainShare[f] / perim[f] : 0;
    const nb = mainNeighbour[f];
    let contrast = 0;
    if (nb >= 0) for (let k = 0; k < 3; k++) { const dc = colour[f * 3 + k] - colour[nb * 3 + k]; contrast += dc * dc; }
    contrast = Math.sqrt(contrast);
    const compact = perim[f] > 0 ? Math.min(1, 4 * 3.141592653589793 * area[f] / (perim[f] * perim[f]) * 4) : 0;
    const small = 1 - Math.min(1, area[f] / (total * 0.15));
    const s = 0.35 * enclosed + 0.25 * Math.min(1, contrast / 0.15) + 0.2 * compact + 0.2 * small;
    figure[f] = s < 0 ? 0 : s > 1 ? 1 : s;
  }
  return { label, count, area, colour, axis, elongation, figure, inset, contour };
}

/** Per cell: chamfer distance (3-4 weights, in cells) to the nearest cell with another label. */
export function chamfer(w: number, h: number, label: Int32Array): Float64Array {
  const n = w * h;
  const inset = new Float64Array(n).fill(1e9);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x, f = label[i];
    if ((x > 0 && label[i - 1] !== f) || (x + 1 < w && label[i + 1] !== f) || (y > 0 && label[i - w] !== f) || (y + 1 < h && label[i + w] !== f)) inset[i] = 0;
  }
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x, f = label[i];
    let v = inset[i];
    if (x > 0 && label[i - 1] === f && inset[i - 1] + 3 < v) v = inset[i - 1] + 3;
    if (y > 0 && label[i - w] === f && inset[i - w] + 3 < v) v = inset[i - w] + 3;
    if (x > 0 && y > 0 && label[i - w - 1] === f && inset[i - w - 1] + 4 < v) v = inset[i - w - 1] + 4;
    if (x + 1 < w && y > 0 && label[i - w + 1] === f && inset[i - w + 1] + 4 < v) v = inset[i - w + 1] + 4;
    inset[i] = v;
  }
  for (let y = h - 1; y >= 0; y--) for (let x = w - 1; x >= 0; x--) {
    const i = y * w + x, f = label[i];
    let v = inset[i];
    if (x + 1 < w && label[i + 1] === f && inset[i + 1] + 3 < v) v = inset[i + 1] + 3;
    if (y + 1 < h && label[i + w] === f && inset[i + w] + 3 < v) v = inset[i + w] + 3;
    if (x + 1 < w && y + 1 < h && label[i + w + 1] === f && inset[i + w + 1] + 4 < v) v = inset[i + w + 1] + 4;
    if (x > 0 && y + 1 < h && label[i + w - 1] === f && inset[i + w - 1] + 4 < v) v = inset[i + w - 1] + 4;
    inset[i] = v;
  }
  for (let i = 0; i < n; i++) inset[i] = inset[i] >= 1e8 ? Math.max(w, h) : inset[i] / 3;
  return inset;
}

/** Shape cores for one blade size: each cell's core label (-1 where free) and its two nearest cores. */
export interface Regions { label: Int32Array; l1: Int32Array; d1: Float64Array; l2: Int32Array; d2: Float64Array }

/**
 * The forms a stroke of a given size respects: the level's forms with neighbours closer in colour
 * than `tolerance` merged (a painter carries a stroke across an edge he can't see), then forms
 * smaller than `minArea` cells absorbed into their closest neighbour in colour (shapes smaller than
 * the blade are detail, left to a finer blade), then parts narrower than `openRadius` freed (see
 * below). Returns each cell's shape core (-1 where free) and its two nearest cores.
 */

export function regionsAtScale(level: FormLevel, w: number, h: number, tolerance: number, minArea: number, openRadius: number): Regions {
  const n = w * h, F = level.count, parent = new Int32Array(F), area = new Float64Array(F), sum = new Float64Array(F * 3);
  for (let f = 0; f < F; f++) { parent[f] = f; area[f] = level.area[f]; for (let k = 0; k < 3; k++) sum[f * 3 + k] = level.colour[f * 3 + k] * level.area[f]; }
  const find = (i: number) => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
  const dist = (a: number, b: number) => {
    let d2 = 0;
    for (let k = 0; k < 3; k++) { const x = sum[a * 3 + k] / area[a] - sum[b * 3 + k] / area[b]; d2 += x * x; }
    return Math.sqrt(d2);
  };
  const unite = (a: number, b: number) => {
    if (area[a] < area[b] || (area[a] === area[b] && b < a)) { const t = a; a = b; b = t; }
    parent[b] = a; area[a] += area[b];
    for (let k = 0; k < 3; k++) sum[a * 3 + k] += sum[b * 3 + k];
  };
  // Adjacent pairs, once each, in a fixed order.
  const seen = new Set<number>(), pairs: [number, number][] = [];
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x, f = level.label[i];
    for (const j of [x + 1 < w ? i + 1 : -1, y + 1 < h ? i + w : -1]) {
      if (j < 0) continue;
      const g = level.label[j];
      if (g === f) continue;
      const lo = f < g ? f : g, hi = f < g ? g : f, key = lo * F + hi;
      if (!seen.has(key)) { seen.add(key); pairs.push([lo, hi]); }
    }
  }
  // 1. Merge low-contrast neighbours, closest pairs first.
  const d0 = pairs.map(([a, b], k) => ({ d: dist(a, b), k }));
  d0.sort((p, q) => p.d - q.d || p.k - q.k);
  for (const { k } of d0) {
    const a = find(pairs[k][0]), b = find(pairs[k][1]);
    if (a !== b && dist(a, b) < tolerance) unite(a, b);
  }
  // 2. Absorb small forms into their closest neighbour, smallest first, until none is left.
  for (let round = 0; round < 8; round++) {
    const nb = new Map<number, number[]>();
    for (const [p0, p1] of pairs) {
      const a = find(p0), b = find(p1);
      if (a === b) continue;
      if (!nb.has(a)) nb.set(a, []);
      if (!nb.has(b)) nb.set(b, []);
      nb.get(a)!.push(b); nb.get(b)!.push(a);
    }
    const small: number[] = [];
    for (let f = 0; f < F; f++) if (find(f) === f && area[f] < minArea && nb.has(f)) small.push(f);
    if (!small.length) break;
    small.sort((a, b) => area[a] - area[b] || a - b);
    for (const f0 of small) {
      const f = find(f0);
      if (area[f] >= minArea) continue;
      let best = -1, bestD = 1e18;
      for (const g0 of nb.get(f0)!) {
        const g = find(g0);
        if (g === f) continue;
        const dd = dist(f, g);
        if (dd < bestD || (dd === bestD && g < best)) { bestD = dd; best = g; }
      }
      if (best >= 0) unite(f, best);
    }
  }
  const label = new Int32Array(n);
  for (let i = 0; i < n; i++) label[i] = find(level.label[i]);
  // 3. Opening: parts of a shape narrower than `openRadius` (a lake seen between branches, a
  //    branch against the lake) bind no stroke; only each shape's core does.
  const inset0 = chamfer(w, h, label), core = new Float64Array(n).fill(1e9), r3 = openRadius * 3;
  for (let i = 0; i < n; i++) if (inset0[i] >= openRadius) core[i] = 0;
  for (let pass = 0; pass < 2; pass++) {
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) relax(core, label, w, h, x, y, 1);
    for (let y = h - 1; y >= 0; y--) for (let x = w - 1; x >= 0; x--) relax(core, label, w, h, x, y, -1);
  }
  for (let i = 0; i < n; i++) if (core[i] > r3) label[i] = -1;
  return { label, ...nearestTwo(w, h, label) };
}

/** One chamfer step at (x, y) within one label, from the neighbours a sweep has already visited (dir 1: left and above; -1: right and below). */
function relax(d: Float64Array, label: Int32Array, w: number, h: number, x: number, y: number, dir: number): void {
  const i = y * w + x, f = label[i], px = x - dir, py = y - dir;
  let v = d[i];
  if (px >= 0 && px < w && label[i - dir] === f && d[i - dir] + 3 < v) v = d[i - dir] + 3;
  if (py >= 0 && py < h) {
    const j = py * w + x;
    if (label[j] === f && d[j] + 3 < v) v = d[j] + 3;
    if (x > 0 && label[j - 1] === f && d[j - 1] + 4 < v) v = d[j - 1] + 4;
    if (x + 1 < w && label[j + 1] === f && d[j + 1] + 4 < v) v = d[j + 1] + 4;
  }
  d[i] = v;
}

/**
 * For every cell, the two nearest shape cores with different labels and their distances (cells,
 * chamfer). A stroke of shape A stays at least its fit inside A by keeping the distance to the
 * nearest core that is not A large enough; free cells (label -1) bind nobody.
 */
function nearestTwo(w: number, h: number, label: Int32Array): { l1: Int32Array; d1: Float64Array; l2: Int32Array; d2: Float64Array } {
  const n = w * h, l1 = new Int32Array(n).fill(-1), l2 = new Int32Array(n).fill(-1), d1 = new Float64Array(n).fill(1e9), d2 = new Float64Array(n).fill(1e9);
  for (let i = 0; i < n; i++) if (label[i] >= 0) { l1[i] = label[i]; d1[i] = 0; }
  const offer = (i: number, l: number, d: number) => {
    if (l < 0) return;
    if (l === l1[i]) { if (d < d1[i]) d1[i] = d; return; }
    if (d < d1[i]) { l2[i] = l1[i]; d2[i] = d1[i]; l1[i] = l; d1[i] = d; return; }
    if (l === l2[i]) { if (d < d2[i]) d2[i] = d; return; }
    if (d < d2[i]) { l2[i] = l; d2[i] = d; }
  };
  const from = (i: number, j: number, wgt: number) => { offer(i, l1[j], d1[j] + wgt); offer(i, l2[j], d2[j] + wgt); };
  for (let pass = 0; pass < 2; pass++) {
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (x > 0) from(i, i - 1, 3);
      if (y > 0) { from(i, i - w, 3); if (x > 0) from(i, i - w - 1, 4); if (x + 1 < w) from(i, i - w + 1, 4); }
    }
    for (let y = h - 1; y >= 0; y--) for (let x = w - 1; x >= 0; x--) {
      const i = y * w + x;
      if (x + 1 < w) from(i, i + 1, 3);
      if (y + 1 < h) { from(i, i + w, 3); if (x + 1 < w) from(i, i + w + 1, 4); if (x > 0) from(i, i + w - 1, 4); }
    }
  }
  for (let i = 0; i < n; i++) { d1[i] /= 3; d2[i] /= 3; }
  return { l1, d1, l2, d2 };
}

/** Distance from cell i to the nearest core of a shape other than `own`, cells. */
export function clearance(r: { l1: Int32Array; d1: Float64Array; l2: Int32Array; d2: Float64Array }, i: number, own: number): number {
  return r.l1[i] === own ? r.d2[i] : r.d1[i];
}
