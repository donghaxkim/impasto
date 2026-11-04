import type { Plan } from '../src/planner.ts';
import type { RGB } from '../src/pigment.ts';

/**
 * What the planner expects the canvas to look like: each footprint filled with its paint colour,
 * in plan order, with the secondary colour as bands across the stroke. sRGB bytes.
 * `x0, y0, w, h` select a window in output pixels; mmPerPx sets the resolution.
 */
export function rasterizePlan(p: Plan, ground: RGB, mmPerPx: number, outlines = false, win?: { x0: number; y0: number; w: number; h: number }): { w: number; h: number; px: Uint8ClampedArray } {
  const fullW = Math.round(p.widthMm / mmPerPx), fullH = Math.round(p.heightMm / mmPerPx);
  const { x0: ox, y0: oy, w: W, h: H } = win ?? { x0: 0, y0: 0, w: fullW, h: fullH };
  const px = new Uint8ClampedArray(W * H * 3);
  for (let i = 0; i < W * H; i++) { px[i * 3] = ground[0] * 255; px[i * 3 + 1] = ground[1] * 255; px[i * 3 + 2] = ground[2] * 255; }
  const tint: [number, number, number][] = [[230, 230, 230], [255, 80, 60], [255, 190, 40], [60, 200, 90], [40, 150, 255], [200, 80, 255]];
  for (const st of p.strokes) {
    const pts = st.footprint.map(([x, y]) => [x / mmPerPx - ox, y / mmPerPx - oy]), r = st.widthMm / 2 / mmPerPx;
    let bx0 = 1e9, by0 = 1e9, bx1 = -1e9, by1 = -1e9;
    for (const [x, y] of pts) { bx0 = Math.min(bx0, x); bx1 = Math.max(bx1, x); by0 = Math.min(by0, y); by1 = Math.max(by1, y); }
    const X0 = Math.max(0, Math.floor(bx0 - r)), X1 = Math.min(W - 1, Math.ceil(bx1 + r)), Y0 = Math.max(0, Math.floor(by0 - r)), Y1 = Math.min(H - 1, Math.ceil(by1 + r));
    for (let y = Y0; y <= Y1; y++) for (let x = X0; x <= X1; x++) {
      const cx = x + 0.5, cy = y + 0.5;
      let best = 1e18, across = 0;
      for (let i = 0; i < pts.length - 1; i++) {
        const [ax, ay] = pts[i], [bx, by] = pts[i + 1], vx = bx - ax, vy = by - ay, l2 = vx * vx + vy * vy;
        let t = l2 > 0 ? ((cx - ax) * vx + (cy - ay) * vy) / l2 : 0;
        if ((i === 0 && t < 0) || (i === pts.length - 2 && t > 1)) continue;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        const ex = cx - (ax + vx * t), ey = cy - (ay + vy * t), d2 = ex * ex + ey * ey;
        if (d2 < best) { best = d2; across = l2 > 0 ? (ex * -vy + ey * vx) / Math.sqrt(l2) : 0; }
      }
      if (best > r * r) continue;
      const o = (y * W + x) * 3;
      if (outlines && Math.sqrt(best) > r - 1.2) { const c = tint[st.layer % tint.length]; px[o] = c[0]; px[o + 1] = c[1]; px[o + 2] = c[2]; continue; }
      const band = ((across / r + 1) * 0.5 * 3.7 + st.seed * 0.0001) % 1;
      const c = band < st.secondaryFraction ? st.secondary : st.primary;
      px[o] = c[0] * 255; px[o + 1] = c[1] * 255; px[o + 2] = c[2] * 255;
    }
  }
  return { w: W, h: H, px };
}
