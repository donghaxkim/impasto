import type { Stroke, Vec2 } from './types';

type Sample = { x: number; y: number; distance: number };

const EPSILON = 1e-5;

function distance(a: Vec2, b: Vec2): number {
  return Math.hypot(b[0] - a[0], b[1] - a[1]);
}

function finitePoint(point: Vec2): boolean {
  return Number.isFinite(point[0]) && Number.isFinite(point[1]);
}

function catmullRom(p0: Vec2, p1: Vec2, p2: Vec2, p3: Vec2, t: number): Vec2 {
  // Centripetal parameterization avoids the loops and cusps that uniform
  // Catmull–Rom can introduce when adjacent authored points are unevenly spaced.
  const alpha = 0.5;
  const knot = (a: Vec2, b: Vec2) => Math.max(EPSILON, Math.pow(distance(a, b), alpha));
  const t0 = 0;
  const t1 = t0 + knot(p0, p1);
  const t2 = t1 + knot(p1, p2);
  const t3 = t2 + knot(p2, p3);
  const u = t1 + (t2 - t1) * t;

  const blend = (a: Vec2, b: Vec2, ta: number, tb: number, at: number): Vec2 => {
    const span = Math.max(EPSILON, tb - ta);
    const q = (at - ta) / span;
    return [a[0] * (1 - q) + b[0] * q, a[1] * (1 - q) + b[1] * q];
  };
  const a1 = blend(p0, p1, t0, t1, u);
  const a2 = blend(p1, p2, t1, t2, u);
  const a3 = blend(p2, p3, t2, t3, u);
  const b1 = blend(a1, a2, t0, t2, u);
  const b2 = blend(a2, a3, t1, t3, u);
  return blend(b1, b2, t1, t2, u);
}

function sampleCenterline(points: Vec2[]): Sample[] {
  const clean: Vec2[] = [];
  for (const point of points) {
    if (!finitePoint(point)) continue;
    if (clean.length === 0 || distance(clean[clean.length - 1], point) > EPSILON) clean.push(point);
  }
  if (clean.length < 2) return [];

  const rawSamples: Sample[] = [];
  for (let segment = 0; segment < clean.length - 1; segment++) {
    const p1 = clean[segment];
    const p2 = clean[segment + 1];
    const p0 = clean[Math.max(0, segment - 1)];
    const p3 = clean[Math.min(clean.length - 1, segment + 2)];
    const length = distance(p1, p2);
    // Sample the spline densely, then resample by arc length below. Sampling
    // Catmull-Rom at even parameter steps clusters stations near duplicated
    // endpoints, which makes a very wide ribbon twist on a sub-pixel step.
    const count = Math.max(4, Math.min(1200, Math.ceil(length / 1.25)));
    for (let step = segment === 0 ? 0 : 1; step <= count; step++) {
      const [x, y] = catmullRom(p0, p1, p2, p3, step / count);
      rawSamples.push({ x, y, distance: 0 });
    }
  }

  let rawTotal = 0;
  for (let i = 1; i < rawSamples.length; i++) {
    rawTotal += Math.hypot(rawSamples[i].x - rawSamples[i - 1].x, rawSamples[i].y - rawSamples[i - 1].y);
    rawSamples[i].distance = rawTotal;
  }
  if (rawTotal <= EPSILON) return [];

  // The final grid is uniform in painted arc length. A 2.5 px maximum station
  // interval keeps width and pressure derivatives smooth while preventing
  // isolated near-duplicate rings at sharp authored corners.
  const stationCount = Math.max(2, Math.ceil(rawTotal / 2.5));
  const samples: Sample[] = [];
  let cursor = 0;
  for (let station = 0; station <= stationCount; station++) {
    const target = rawTotal * station / stationCount;
    while (cursor < rawSamples.length - 2 && rawSamples[cursor + 1].distance < target) cursor++;
    const a = rawSamples[cursor];
    const b = rawSamples[cursor + 1];
    const span = Math.max(EPSILON, b.distance - a.distance);
    const t = Math.max(0, Math.min(1, (target - a.distance) / span));
    samples.push({
      x: a.x + (b.x - a.x) * t,
      y: a.y + (b.y - a.y) * t,
      distance: target,
    });
  }
  return samples;
}

function cross(ax: number, ay: number, bx: number, by: number): number {
  return ax * by - ay * bx;
}

function segmentsIntersect(a: Sample, b: Sample, c: Sample, d: Sample): boolean {
  const abx = b.x - a.x;
  const aby = b.y - a.y;
  const cdx = d.x - c.x;
  const cdy = d.y - c.y;
  const abC = cross(abx, aby, c.x - a.x, c.y - a.y);
  const abD = cross(abx, aby, d.x - a.x, d.y - a.y);
  const cdA = cross(cdx, cdy, a.x - c.x, a.y - c.y);
  const cdB = cross(cdx, cdy, b.x - c.x, b.y - c.y);
  const eps = 1e-7;
  const onSegment = (p: Sample, q: Sample, r: Sample) =>
    q.x >= Math.min(p.x, r.x) - eps && q.x <= Math.max(p.x, r.x) + eps &&
    q.y >= Math.min(p.y, r.y) - eps && q.y <= Math.max(p.y, r.y) + eps;
  if (((abC > eps && abD < -eps) || (abC < -eps && abD > eps)) &&
      ((cdA > eps && cdB < -eps) || (cdA < -eps && cdB > eps))) return true;
  if (Math.abs(abC) <= eps && onSegment(a, c, b)) return true;
  if (Math.abs(abD) <= eps && onSegment(a, d, b)) return true;
  if (Math.abs(cdA) <= eps && onSegment(c, a, d)) return true;
  if (Math.abs(cdB) <= eps && onSegment(c, b, d)) return true;
  return false;
}

function hasNonAdjacentIntersection(samples: Sample[]): boolean {
  for (let i = 0; i < samples.length - 1; i++) {
    const a = samples[i];
    const b = samples[i + 1];
    for (let j = i + 3; j < samples.length - 1; j++) {
      const c = samples[j];
      const d = samples[j + 1];
      if (
        Math.max(a.x, b.x) < Math.min(c.x, d.x) - EPSILON ||
        Math.max(c.x, d.x) < Math.min(a.x, b.x) - EPSILON ||
        Math.max(a.y, b.y) < Math.min(c.y, d.y) - EPSILON ||
        Math.max(c.y, d.y) < Math.min(a.y, b.y) - EPSILON
      ) continue;
      if (segmentsIntersect(a, b, c, d)) return true;
    }
  }
  return false;
}

function hasNearReversal(samples: Sample[]): boolean {
  for (let i = 1; i < samples.length - 1; i++) {
    const previous = samples[i - 1];
    const current = samples[i];
    const next = samples[i + 1];
    const ix = current.x - previous.x;
    const iy = current.y - previous.y;
    const ox = next.x - current.x;
    const oy = next.y - current.y;
    const il = Math.hypot(ix, iy);
    const ol = Math.hypot(ox, oy);
    if (il < EPSILON || ol < EPSILON) continue;
    if ((ix * ox + iy * oy) / (il * ol) < -0.94) return true;
  }
  return false;
}

function curvatureHalfWidthLimit(samples: Sample[], index: number): number {
  if (index === 0 || index === samples.length - 1) return Infinity;
  const previous = samples[index - 1];
  const current = samples[index];
  const next = samples[index + 1];
  const ix = current.x - previous.x;
  const iy = current.y - previous.y;
  const ox = next.x - current.x;
  const oy = next.y - current.y;
  const incoming = Math.hypot(ix, iy);
  const outgoing = Math.hypot(ox, oy);
  if (incoming < EPSILON || outgoing < EPSILON) return 0;
  const turn = Math.atan2(Math.abs(cross(ix, iy, ox, oy)), ix * ox + iy * oy);
  if (turn < 1e-4) return Infinity;

  // Circumradius of the local three-point osculating circle. Keep the ribbon
  // below it so the inner offset cannot fold back over itself at tight bends.
  const chord = Math.hypot(next.x - previous.x, next.y - previous.y);
  const twiceTriangleArea = Math.abs(cross(ix, iy, ox, oy));
  const radius = (incoming * outgoing * chord) / (2 * twiceTriangleArea);
  return Math.max(0.25, radius * 0.78);
}

function hash01(seed: number, salt: number): number {
  // Integer avalanche hash: stable across engines and independent of Math.random.
  let n = (Math.trunc(seed) ^ salt) | 0;
  n = Math.imul(n ^ (n >>> 16), 0x45d9f3b);
  n = Math.imul(n ^ (n >>> 16), 0x45d9f3b);
  n ^= n >>> 16;
  return (n >>> 0) / 0xffffffff;
}

function smoothstep01(value: number): number {
  const t = Math.max(0, Math.min(1, value));
  return t * t * (3 - 2 * t);
}

/** Shape the generous geometric envelope at the two ends. This is not the
 * visible paint edge: the fragment cap mask carves the final chisel or round
 * silhouette inside this ribbon. Keeping the mesh wide at its terminal ring
 * prevents a top-down filbert from collapsing into a vector arrowhead before
 * that mask has a chance to form the loaded tip. */
function endShape(t: number, brush: Stroke['brush'], side: number, seed: number): number {
  const flat = brush === 'flat';
  const startSpan = flat ? 0.008 + hash01(seed, 0x6101 + side * 97) * 0.008 : 0.014 + hash01(seed, 0x6203 + side * 97) * 0.010;
  const endSpan = flat ? 0.010 + hash01(seed, 0x6305 + side * 97) * 0.010 : 0.016 + hash01(seed, 0x6407 + side * 97) * 0.012;
  const startEnvelope = 0.90 + hash01(seed, 0x6509 + side * 97) * 0.08;
  const endEnvelope = 0.88 + hash01(seed, 0x660b + side * 97) * 0.10;
  if (t < startSpan) {
    const q = smoothstep01(t / startSpan);
    return startEnvelope + (1 - startEnvelope) * q;
  }
  if (t > 1 - endSpan) {
    const q = Math.max(0, Math.min(1, (t - (1 - endSpan)) / endSpan));
    const irregular = 0.96 + valueNoise1D(q * 2.6 + side * 9.1, seed + 0x670d) * 0.08;
    return (1 - (1 - endEnvelope) * smoothstep01(q)) * irregular;
  }
  return 1;
}

/** A broad, seeded load/pressure envelope. Smooth interpolation keeps the
 * silhouette calm while uneven control points avoid the repeated sine-wave
 * profile that makes marks read like uniform vector ribbons. */
function pressureEnvelope(t: number, seed: number, side: number): number {
  const positions = [0, 0.09, 0.28, 0.52, 0.76, 0.93, 1];
  const values = positions.map((_, index) => {
    if (index === 0 || index === positions.length - 1) return 0.86 + hash01(seed, 0x6a09e6 + side * 97) * 0.16;
    const random = hash01(seed, 0x3c6ef3 + index * 131 + side * 977);
    // Occasional broad loaded shoulders, with a separate value for each edge.
    return 0.82 + random * 0.30;
  });
  let segment = 0;
  while (segment < positions.length - 2 && t > positions[segment + 1]) segment++;
  const local = (t - positions[segment]) / (positions[segment + 1] - positions[segment]);
  // Smoothstep interpolation through low-frequency stations.
  const ease = local * local * (3 - 2 * local);
  const envelope = values[segment] * (1 - ease) + values[segment + 1] * ease;
  return envelope;
}

function valueNoise1D(x: number, seed: number): number {
  const cell = Math.floor(x);
  const fraction = x - cell;
  const ease = fraction * fraction * (3 - 2 * fraction);
  const a = hash01(seed, cell);
  const b = hash01(seed, cell + 1);
  return a + (b - a) * ease;
}

/** Irregular, seeded width modulation. A few octaves of value noise break the
 * smooth vector-ribbon silhouette, while occasional broad deposits and pinched
 * necks mimic uneven brush loading. Left and right edges stay independent. */
function edgeModulation(t: number, seed: number, side: number): number {
  const salt = 0x2c1b3a + side * 0x5f3;
  let wobble = 1.0;
  for (const [frequency, amplitude] of [[2.5, 0.055], [5.5, 0.035], [11.0, 0.018]] as const) {
    wobble += (valueNoise1D(t * frequency + side * 17.3, seed + salt) * 2 - 1) * amplitude;
  }
  const deposits = hash01(seed, salt + 7);
  const depositCount = deposits > 0.28 ? 2 : 1;
  for (let k = 0; k < depositCount; k++) {
    const center = hash01(seed, salt + 101 + k * 53);
    const breadth = 0.05 + hash01(seed, salt + 149 + k * 71) * 0.11;
    const strength = (hash01(seed, salt + 197 + k * 89) - 0.35) * 0.30;
    const distanceToCenter = Math.abs(t - center);
    wobble += strength * Math.exp(-(distanceToCenter * distanceToCenter) / (breadth * breadth));
  }
  return Math.max(0.62, wobble);
}

/**
 * Build a smooth retained ribbon mesh for an authored brush stroke.
 * Vertices are packed as x, y, u (arc-length fraction), v (-1 left, +1 right).
 * Invalid/degenerate paths return empty typed arrays instead of NaN geometry.
 */
export type StrokeMesh = {
  vertices: Float32Array<ArrayBuffer>;
  indices: Uint32Array<ArrayBuffer>;
  arcLength: number;
};

export function buildStrokeMesh(stroke: Stroke): StrokeMesh {
  const centerline = sampleCenterline(stroke.points);
  if (centerline.length < 2) return { vertices: new Float32Array(), indices: new Uint32Array(), arcLength: 0 };
  if (hasNearReversal(centerline) || hasNonAdjacentIntersection(centerline)) {
    return { vertices: new Float32Array(), indices: new Uint32Array(), arcLength: 0 };
  }

  const total = centerline[centerline.length - 1].distance;
  const width = Number.isFinite(stroke.width) ? Math.max(0.5, Math.abs(stroke.width)) : 0.5;

  const vertices = new Float32Array(centerline.length * 8);
  const leftWidths = new Float32Array(centerline.length);
  const rightWidths = new Float32Array(centerline.length);
  const curvatureLimits = new Float32Array(centerline.length);
  for (let i = 0; i < centerline.length; i++) {
    const current = centerline[i];
    const t = current.distance / total;
    const loadLeft = pressureEnvelope(t, stroke.seed, 1);
    const loadRight = pressureEnvelope(t, stroke.seed, 2);
    const leftRamp = endShape(t, stroke.brush, 1, stroke.seed) * loadLeft;
    const rightRamp = endShape(t, stroke.brush, 2, stroke.seed) * loadRight;
    const curvatureLimit = curvatureHalfWidthLimit(centerline, i);
    curvatureLimits[i] = curvatureLimit;
    leftWidths[i] = Math.min(width * 0.5 * leftRamp * edgeModulation(t, stroke.seed, 1), curvatureLimit);
    rightWidths[i] = Math.min(width * 0.5 * rightRamp * edgeModulation(t, stroke.seed, 2), curvatureLimit);
  }

  // Keep pressure changes broad relative to the sampling interval. Without
  // this slope limit, an asymmetric bulge can overtake the neighboring cross
  // section on short, tightly curved dabs and flip a pair of ribbon triangles.
  for (let i = 1; i < centerline.length; i++) {
    const maxDelta = Math.hypot(centerline[i].x - centerline[i - 1].x, centerline[i].y - centerline[i - 1].y) * 0.38;
    leftWidths[i] = Math.min(leftWidths[i], leftWidths[i - 1] + maxDelta);
    rightWidths[i] = Math.min(rightWidths[i], rightWidths[i - 1] + maxDelta);
  }
  for (let i = centerline.length - 2; i >= 0; i--) {
    const maxDelta = Math.hypot(centerline[i + 1].x - centerline[i].x, centerline[i + 1].y - centerline[i].y) * 0.38;
    leftWidths[i] = Math.min(leftWidths[i], leftWidths[i + 1] + maxDelta);
    rightWidths[i] = Math.min(rightWidths[i], rightWidths[i + 1] + maxDelta);
  }
  // Smoothing is allowed to narrow a section only. Keep an explicit local cap
  // as a guard against future changes to the limiter above.
  for (let i = 0; i < centerline.length; i++) {
    leftWidths[i] = Math.min(leftWidths[i], curvatureLimits[i]);
    rightWidths[i] = Math.min(rightWidths[i], curvatureLimits[i]);
  }

  for (let i = 0; i < centerline.length; i++) {
    const current = centerline[i];
    // Use a tangent stencil several stations wide. Immediately adjacent
    // samples are only about 2.5 px apart, so a Catmull-Rom overshoot at an
    // endpoint can rotate a one-sample tangent by nearly 90 degrees. That
    // turns a very wide ribbon inside out even though the centerline itself
    // is valid. A wider centered stencil remains smooth while retaining the
    // dense stations needed for the silhouette.
    const tangentStep = Math.max(2, Math.min(4, Math.round(7 / Math.max(1, total / centerline.length))));
    const before = centerline[Math.max(0, i - tangentStep)];
    const after = centerline[Math.min(centerline.length - 1, i + tangentStep)];
    let dx = after.x - before.x;
    let dy = after.y - before.y;
    let tangentLength = Math.hypot(dx, dy);
    if (tangentLength < EPSILON) return { vertices: new Float32Array(), indices: new Uint32Array(), arcLength: 0 };
    dx /= tangentLength;
    dy /= tangentLength;
    const t = current.distance / total;
    const nx = -dy;
    const ny = dx;
    const offset = i * 8;
    vertices[offset] = current.x + nx * leftWidths[i];
    vertices[offset + 1] = current.y + ny * leftWidths[i];
    vertices[offset + 2] = t;
    vertices[offset + 3] = -1;
    vertices[offset + 4] = current.x - nx * rightWidths[i];
    vertices[offset + 5] = current.y - ny * rightWidths[i];
    vertices[offset + 6] = t;
    vertices[offset + 7] = 1;
  }

  const indices = new Uint32Array((centerline.length - 1) * 6);
  for (let i = 0; i < centerline.length - 1; i++) {
    const v = i * 2;
    const k = i * 6;
    indices[k] = v;
    indices[k + 1] = v + 1;
    indices[k + 2] = v + 2;
    indices[k + 3] = v + 1;
    indices[k + 4] = v + 3;
    indices[k + 5] = v + 2;
  }
  return { vertices, indices, arcLength: total };
}
