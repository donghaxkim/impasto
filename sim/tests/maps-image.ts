/** Writes the painting maps as one image: node --experimental-strip-types tests/maps-image.ts [--width 360] */
import { mkdirSync } from 'node:fs';
import { readPng, writePng } from './png.ts';
import { DEFAULT_SETTINGS, Planner } from '../src/planner.ts';

const args = process.argv.slice(2);
const i = args.indexOf('--width'), widthMm = i >= 0 ? +args[i + 1] : 360;
const img = readPng(new URL('./fixtures/lake.png', import.meta.url).pathname);
const p = new Planner(img, { ...DEFAULT_SETTINGS, widthMm });
const { w, h } = p.maps;
const names = ['detail', 'coherence', 'silhouette', 'flat', 'relief'] as const;
const px = new Uint8ClampedArray(w * h * names.length * 3);
names.forEach((name, k) => {
  const m = p.maps[name], scale = name === 'detail' ? 0.5 : 1;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const v = Math.min(1, Math.max(0, m[y * w + x] * scale)) * 255, o = (((k * h) + y) * w + x) * 3;
    px[o] = v; px[o + 1] = v; px[o + 2] = v;
  }
});
const out = new URL('../out/', import.meta.url).pathname;
mkdirSync(out, { recursive: true });
writePng(`${out}maps.png`, w, h * names.length, px);
const stats = (m: Float64Array) => { const s = Array.from(m).sort((a, b) => a - b); return [0.1, 0.5, 0.9].map((q) => s[Math.floor(q * s.length)].toFixed(2)).join('/'); };
for (const n of names) console.log(n.padEnd(10), 'p10/p50/p90', stats(p.maps[n]));
