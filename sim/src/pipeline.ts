/**
 * The image -> plan -> paint pipeline, as a sequence of steps.
 *
 * `paintPipeline` is a synchronous generator: it yields after the image analysis and after every
 * layer is planned and painted, so a caller can report progress, check for cancellation or give
 * the event loop a turn between steps (the library's `renderImpasto` does all three), while the
 * CLI (`tests/paint-image.ts`) simply runs it to the end. Pure: no Node or DOM APIs.
 *
 * It does exactly what `planPainting(img, settings, feedback)` does with the CLI's feedback (paint
 * each layer, then plan the next one against the simulated canvas); `tests/api.test.ts` checks
 * that the two give the same plan and canvas.
 */
import { DEFAULT_SETTINGS, Planner, type Plan, type PlanSettings, type PlannedStroke } from './planner.ts';
import { canvasColour, paintStrokes, startPainting, type Painting } from './execute.ts';
import type { RgbImage } from './image.ts';

export interface PipelineOptions {
  /** Paint each layer with the simulation (default true). False gives the stroke plan alone, in seconds. */
  simulate?: boolean;
  /** Plan each layer against the simulated canvas rather than the planner's own estimate (default true; needs simulate). */
  feedback?: boolean;
}

export type PipelineEvent =
  /** The image is analysed (maps, forms) and the layers are known. */
  | { stage: 'analysed'; layers: number; names: string[]; ms: number }
  /** Layer `layer` of `layers` is planned and, when simulating, painted. */
  | { stage: 'layer'; layer: number; layers: number; name: string; strokes: PlannedStroke[]; planMs: number; simMs: number }
  /** Held-back strokes (PlanSettings.deferThin) were planned and painted last, with the last layer. */
  | { stage: 'deferred'; layer: number; layers: number; name: string; strokes: PlannedStroke[]; planMs: number; simMs: number };

export interface PipelineResult {
  plan: Plan;
  /** The simulated painting, or null when not simulating. */
  painting: Painting | null;
  /** The settings as resolved (defaults filled in), before the planner's own per-look adjustments. */
  settings: PlanSettings;
  /** Milliseconds spent analysing the image, planning strokes and simulating paint. */
  analyseMs: number; planMs: number; simMs: number;
}

const now = (): number => performance.now();

export function* paintPipeline(img: RgbImage, settings: Partial<PlanSettings> = {}, opts: PipelineOptions = {}): Generator<PipelineEvent, PipelineResult, void> {
  const s: PlanSettings = { ...DEFAULT_SETTINGS, ...settings };
  const simulate = opts.simulate ?? true, feedback = simulate && (opts.feedback ?? true);
  let t = now();
  const planner = new Planner(img, s);
  const analyseMs = now() - t, layers = planner.s.layers.length;
  yield { stage: 'analysed', layers, names: planner.plan.layerNames, ms: analyseMs };

  let painting: Painting | null = null, planMs = 0, simMs = 0;
  // As planPainting's feedback callback: paint the strokes, then let the planner see the canvas.
  const paint = (strokes: PlannedStroke[]): number => {
    if (!simulate) return 0;
    const t0 = now();
    painting ??= startPainting(planner.plan, s.ground);
    paintStrokes(painting, strokes);
    if (feedback) planner.current = canvasColour(painting.canvas, planner.current.w, planner.current.h);
    const ms = now() - t0;
    simMs += ms;
    return ms;
  };

  for (let l = 0; l < layers; l++) {
    t = now();
    const strokes = planner.planLayer(l);
    const lp = now() - t;
    planMs += lp;
    const ls = paint(strokes);
    yield { stage: 'layer', layer: l, layers, name: planner.plan.layerNames[l], strokes, planMs: lp, simMs: ls };
  }
  // Thin high-contrast marks held back by deferThin go on last, over settled paint (as in planPainting).
  t = now();
  const last = planner.flushDeferred();
  const lp = now() - t;
  planMs += lp;
  if (last.length) {
    const ls = paint(last);
    yield { stage: 'deferred', layer: layers - 1, layers, name: planner.plan.layerNames[layers - 1], strokes: last, planMs: lp, simMs: ls };
  }
  return { plan: planner.plan, painting, settings: s, analyseMs, planMs, simMs };
}

/** Runs the pipeline to the end, calling `onEvent` after each step. */
export function runPipeline(img: RgbImage, settings: Partial<PlanSettings> = {}, opts: PipelineOptions = {}, onEvent?: (e: PipelineEvent) => void): PipelineResult {
  const it = paintPipeline(img, settings, opts);
  for (;;) {
    const r = it.next();
    if (r.done) return r.value;
    onEvent?.(r.value);
  }
}
