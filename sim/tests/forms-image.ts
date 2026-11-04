/** Writes out/forms-<scene>.png: each form level as flat mean colours with outlines, plus figure scores. */
import { mkdirSync, readFileSync } from 'node:fs';
import { readPng, writePng } from './png.ts';
import { resampleLinear, toOklab } from '../src/image.ts';
import { formHierarchy } from '../src/forms.ts';
import { labToLinear } from '../src/planner.ts';
import { linearToSrgb } from '../src/pigment.ts';

const args = process.argv.slice(2), opt = (n: string, d: string) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : d; };
const scenes = JSON.parse(readFileSync(new URL('./scenes.json', import.meta.url), 'utf8')), name = opt('scene', 'lake'), scene = scenes[name];
const img = readPng(new URL(`../${scene.image}`, import.meta.url).pathname);
const cell = 0.5, gw = Math.round(scene.widthMm / cell), gh = Math.round(scene.widthMm * img.h / img.w / cell);
const lab = toOklab(resampleLinear(img, gw, gh));
const areaMm2 = scene.widthMm * scene.widthMm * img.h / img.w;
const counts = opt('sizes', '80,35,15').split(',').map(Number).map((d) => Math.max(4, Math.round(areaMm2 / (d * d))));
const t0 = Date.now();
const H = formHierarchy(lab, counts);
console.log(name, 'forms per level', H.levels.map((l) => l.count), 'ms', Date.now() - t0);
const rows = H.levels.length + 1, px = new Uint8ClampedArray(gw * gh * rows * 3);
H.levels.forEach((L, r) => {
  for (let y = 0; y < gh; y++) for (let x = 0; x < gw; x++) {
    const i = y * gw + x, f = L.label[i], o = ((r * gh + y) * gw + x) * 3;
    const edge = (x + 1 < gw && L.label[i + 1] !== f) || (y + 1 < gh && L.label[i + gw] !== f);
    const c = labToLinear([L.colour[f * 3], L.colour[f * 3 + 1], L.colour[f * 3 + 2]]);
    for (let k = 0; k < 3; k++) px[o + k] = edge ? 20 : linearToSrgb(c[k]) * 255;
  }
});
const L0 = H.levels[Math.min(1, H.levels.length - 1)];
for (let i = 0; i < gw * gh; i++) { const v = L0.figure[L0.label[i]] * 255, o = ((H.levels.length * gh) * gw + i) * 3; px[o] = v; px[o + 1] = v; px[o + 2] = v; }
mkdirSync(new URL('../out/', import.meta.url).pathname, { recursive: true });
writePng(new URL(`../out/forms-${name}.png`, import.meta.url).pathname, gw, gh * rows, px);
