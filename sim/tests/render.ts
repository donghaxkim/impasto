import { mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { writePng } from './png.ts';
import { oneStrokeScene, patchScene } from './scenes.ts';
import { DEFAULT_LIGHT, relight, type View } from '../src/relight.ts';

const which = process.argv[2] ?? 'all';
const out = new URL('../out/', import.meta.url).pathname;
mkdirSync(out, { recursive: true });
for (const [name, build] of [['one-stroke', oneStrokeScene], ['patch', patchScene]] as const) {
  if (which !== 'all' && which !== name) continue;
  const t0 = Date.now();
  const scene = build();
  const t1 = Date.now();
  const { canvas } = scene;
  let totalBerm = 0, heap = 0, plowed = 0, stick = 0, wet = 0;
  for (const s of scene.stats) { totalBerm += s.bermVolume; heap += s.heapVolume; plowed += s.plowedVolume; stick += s.stickCells; wet += s.wetCells; }
  console.log(name, 'sim ms', t1 - t0, { strokes: scene.stats.length, berm: +totalBerm.toFixed(1), heap: +heap.toFixed(1), plowed: +plowed.toFixed(1), wet, stick });
  for (const view of ['paint', 'color', 'height', 'normal', 'cavity'] as View[]) {
    const px = relight(canvas, DEFAULT_LIGHT, view);
    writePng(`${out}${name}-${view}.png`, canvas.w, canvas.h, px);
    if (view === 'paint') {
      let glint = 0, dark = 0;
      for (let i = 0; i < canvas.n; i++) {
        if (px[i * 3] > 240 && px[i * 3 + 1] > 235 && px[i * 3 + 2] > 220) glint++;
        if (px[i * 3] + px[i * 3 + 1] + px[i * 3 + 2] < 90) dark++;
      }
      console.log(name, 'sha256', createHash('sha256').update(px).digest('hex').slice(0, 16), 'glint %', (100 * glint / canvas.n).toFixed(3), 'deep shadow %', (100 * dark / canvas.n).toFixed(2));
    }
  }
  writePng(`${out}${name}-light-opposite.png`, canvas.w, canvas.h, relight(canvas, { ...DEFAULT_LIGHT, azimuth: 45 }, 'paint'));
  let peak = 0; for (let i = 0; i < canvas.n; i++) peak = Math.max(peak, canvas.top[i] + canvas.under[i]);
  console.log(name, 'max paint mm', peak.toFixed(2), 'total ms', Date.now() - t0);
}
