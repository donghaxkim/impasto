/** Glint density, how often glints sit beside dark recesses, and whether the rest of the image stayed put. */
import { writeFileSync } from 'node:fs';
import { DEFAULT_LIGHT, relight } from '../src/relight.ts';
import { srgbToLinear } from '../src/pigment.ts';
import { patchScene } from './scenes.ts';

const luma = (px: Uint8ClampedArray, i: number) => 0.2126 * srgbToLinear(px[i * 3] / 255) + 0.7152 * srgbToLinear(px[i * 3 + 1] / 255) + 0.0722 * srgbToLinear(px[i * 3 + 2] / 255);

export function highlightMetrics() {
  const { canvas: c } = patchScene();
  const px = relight(c, DEFAULT_LIGHT, 'paint'), spec = relight(c, DEFAULT_LIGHT, 'spec');
  const L = new Float64Array(c.n);
  let sum = 0, clipped = 0, white = 0;
  for (let i = 0; i < c.n; i++) {
    L[i] = luma(px, i); sum += L[i];
    if (px[i * 3] >= 254 && px[i * 3 + 1] >= 254 && px[i * 3 + 2] >= 254) clipped++;
    if (px[i * 3] > 245 && px[i * 3 + 1] > 240 && px[i * 3 + 2] > 225) white++;
  }
  const glint = (i: number) => spec[i * 3] > 235;
  const seen = new Uint8Array(c.n), sizes: number[] = [];
  let glints = 0, beside = 0, contrast = 0;
  const reach = 15;
  for (let y = reach; y < c.h - reach; y++) for (let x = reach; x < c.w - reach; x++) {
    const i = y * c.w + x;
    if (!glint(i)) continue;
    glints++;
    let darkest = 1e9;
    for (let a = -reach; a <= reach; a += 3) for (let b = -reach; b <= reach; b += 3) darkest = Math.min(darkest, L[i + a + b * c.w]);
    if (darkest < 0.06) beside++;
    contrast += L[i] / (darkest + 0.01);
    if (seen[i]) continue;
    const stack = [i]; seen[i] = 1; let size = 0;
    while (stack.length) { const a = stack.pop()!; size++; for (const b of [a - 1, a + 1, a - c.w, a + c.w]) if (b >= 0 && b < c.n && !seen[b] && glint(b)) { seen[b] = 1; stack.push(b); } }
    sizes.push(size);
  }
  sizes.sort((a, b) => a - b);
  return {
    glintPercent: +(100 * glints / c.n).toFixed(3), glintCount: sizes.length, p95GlintPixels: sizes[Math.floor(sizes.length * 0.95)] ?? 0, largestGlintPixels: sizes[sizes.length - 1] ?? 0,
    glintsBesideRecessPercent: +(100 * beside / Math.max(1, glints)).toFixed(1), glintToRecessContrast: +(contrast / Math.max(1, glints)).toFixed(1),
    whitePercent: +(100 * white / c.n).toFixed(3), clippedPercent: +(100 * clipped / c.n).toFixed(3), meanBrightness: +(sum / c.n).toFixed(4),
  };
}
if (import.meta.url === `file://${process.argv[1]}`) {
  const r = highlightMetrics();
  console.log(JSON.stringify(r, null, 1));
  if (process.argv[2]) writeFileSync(process.argv[2], JSON.stringify(r, null, 1));
}
