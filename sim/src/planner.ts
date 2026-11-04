/**
 * Image -> ordered stroke plan.
 *
 * Layered and coarse to fine, after Hertzmann (1998): each layer compares a blurred reference
 * with what is already on the canvas and only paints where the difference is large. Strokes are
 * traced along an edge-following direction field (colour structure tensor), so they follow the
 * image's edges and forms. Seeds are taken greedily by error, and a stroke is dropped when most of
 * its footprint is already covered in the same layer (Paint Transformer's occlusion rule) or when
 * it would not bring the canvas closer to the reference. Uncovered gaps are found again on the next
 * pass of the same layer (Im2Oil's hole filling).
 *
 * Palette-knife constraints come from the simulation: a knife stroke shorter than ~9 mm deposits
 * almost nothing, so every layer has a minimum length, and fine detail comes from narrow knives,
 * not from dabs.
 *
 * Deterministic: only + - * / sqrt floor, dmath, stable sorts with total-order keys, and hashing
 * instead of a stateful random generator. The same image, settings and seed always give the same plan.
 */
import { hash } from './dmath.ts';
import { linearToSrgb, srgbToLinear, type RGB } from './pigment.ts';
import { directionAt, directionField, gaussBlur, makeGrid, mergeFields, resampleLinear, sample, shadingField, toOklab, oklab, type Grid, type RgbImage } from './image.ts';
import { yieldVolume, type ToolSpec, type Vec2 } from './tool.ts';
import { mapAt, paintingMaps, type PaintingMaps } from './structure.ts';
import { clearance, formHierarchy, regionsAtScale, splitRegions, type FormHierarchy, type FormLevel, type Regions } from './forms.ts';

export interface LayerSpec {
  name: string;
  tool: 'knife' | 'bristle';
  widthMm: number;
  /** Nodes across the tool (see ToolSpec). */
  nodes: number;
  /** Stroke length range, mm. The minimum is a hard floor; the maximum caps tracing. */
  minLenMm: number; maxLenMm: number;
  /** Seed grid pitch as a multiple of the tool width. */
  spacing: number;
  /** Mean OKLab difference a grid cell must exceed to get a stroke. 0 covers everything. */
  threshold: number;
  /** A stroke stops growing where the reference differs from its colour by more than this (OKLab). */
  tolerance: number;
  /** Reference blur, as a multiple of the tool width (standard deviation). */
  blur: number;
  /** Direction-field smoothing, as a multiple of the tool width. */
  flowBlur: number;
  /** Paint left under the tool, mm. Lighter paint is laid thicker (see PlanSettings.lightBoost). */
  gapMm: number;
  /** Largest turn from a stroke's starting direction, degrees. */
  maxTurnDeg: number;
  /** Drop a stroke when this share of its footprint is already covered in the same layer. */
  coverSkip: number;
  /** Seeding passes; later passes only fill what earlier ones missed. */
  passes: number;
  /**
   * Say of the blade's sides, against its centreline, when judging colour (0-1). At 1 a stroke
   * stops as soon as either side crosses an edge; low values let a narrow knife paint a feature
   * thinner than itself, such as a trunk or a ridge.
   */
  sideWeight: number;
  /**
   * Structure needed before this layer adds strokes, as edge strength relative to the image's
   * mean (flat sky is about 0.05, a mountain face 0.35, broken rock 2). Below it, error is
   * discounted, so smooth gradients stay in broad strokes and small strokes go where the forms
   * are (after Im2Oil's edge-density sampling). 0 turns the gate off.
   */
  detail: number;
  /**
   * 'fill' (default) paints areas. 'contour' paints along silhouettes, offset to one side so the
   * blade's edge cuts a crisp boundary: the painter's "cutting in".
   */
  kind?: 'fill' | 'contour' | 'press';
  /** 'press' layers: the knife widths to choose from, mm (one tool per width and colour family). */
  sizesMm?: number[];
  /** Choose a stroke primitive per stroke from the painting maps (default true; off for underpainting). */
  primitives?: boolean;
  /**
   * Form level whose forms this layer's strokes stay inside (0 coarsest; see PlanSettings.formSizesMm).
   * A stroke ends where its centreline would leave its form, or, past its minimum length, where a
   * blade edge would, so a broad knife never paints across a smaller shape: that shape is left to
   * the finer layers. Omitted or -1: no form constraint.
   */
  formLevel?: number;
}

/**
 * General stroke primitives, chosen per stroke from the painting maps (structure.ts), never from
 * what the subject is:
 * - underpaint: thin bristle layer.
 * - sweep: flat areas; wide, thin, pressed flat, soft ends, almost no heap.
 * - plane: broad knife plane with square ends; relief follows the area's target relief.
 * - mark: fine coherent structure (lines, trunks, ridges); tapered both ends, narrower contact.
 * - scumble: fine incoherent texture (foliage, broken rock); broken, starved, little heap.
 * - contour: along a silhouette, one side, tapered tail.
 * - pat: high-relief incoherent texture; a short, heavy press and lift that leaves an irregular deposit.
 * - accent: a plane or mark in a light, structured area, laid thick with a full heap.
 *
 * Primitives set the hand, not the result: a pressure profile along the stroke, the blade's angle,
 * speed and how much paint is picked up. With physical deposition the berms and heap then follow
 * from the simulation. Curvature comes from the seed's surroundings: marks and contours follow the
 * fine edge field and may turn a long way, sweeps follow the broad form field, planes stay stiff.
 */
export type Primitive = 'underpaint' | 'sweep' | 'plane' | 'mark' | 'scumble' | 'pat' | 'contour' | 'accent' | 'press';

export interface PlanSettings {
  /** Canvas width in mm; the height follows the image's aspect ratio. */
  widthMm: number;
  layers: LayerSpec[];
  seed: number;
  /** Cell size of the analysis grid, mm. */
  analysisMm: number;
  /** Stroke direction where the image has no clear edges, and how strongly it pulls elsewhere. */
  flatDirection: Vec2; flatBias: number;
  /** Say of the larger form (a field smoothed 3x wider) in stroke direction, against fine edges. */
  formWeight: number;
  /**
   * Typical size of a form at each level of the form hierarchy, coarse first, mm. The image is split
   * into about canvas area / size^2 forms per level (forms.ts).
   */
  formSizesMm: number[];
  /** Colour of the bare canvas, sRGB 0-1. */
  ground: RGB;
  /** Multiplier on OKLab chroma of the paint. 1 keeps the photo's saturation. */
  chroma: number;
  /** Extra thickness for light paint: gap x (1 - lightBoost/2 + lightBoost x L). */
  lightBoost: number;
  /** Load per node as a multiple of the volume the stroke needs. */
  loadFactor: number;
  /**
   * Smallest load per node, as a multiple of the simulation's yield volume. Near 1 the knife
   * starves within millimetres and leaves pitted, broken paint; well above it the stroke stays
   * wet and breaks up only toward its tail.
   */
  minLoad: number;
  /** The knife travels this far past the planned footprint, so its lift and heap land beyond it. */
  tailMm: number;
  /**
   * 'locked' keeps the knife's full edge profile on every stroke (the reference look). 'oil' scales
   * it per primitive, so broad planes and sweeps lose the parallel grooves while scumbles and
   * accents keep some texture. Pair it with the renderer's look of the same name.
   */
  look: 'locked' | 'oil';
  /**
   * With the 'oil' look: load each knife with the colours found across its path, in streaks, rather
   * than one colour (Tool.loadProfile).
   */
  streaks: boolean;
  /**
   * Restraint inside shapes, 0-1: how much the form-bound layers discount their error deep inside a
   * shape (more than two blade widths from its edge), so a shape painted as a broad plane stays one
   * and detail gathers at edges and small shapes. 0 is off.
   */
  restraint: number;
  /**
   * With the 'oil' look: add a layer of shape-sized presses after the masses (one wide knife press
   * per small or medium shape, the knife chosen to fit the shape), and keep strokes in the
   * form-bound layers short and wide.
   */
  presses: boolean;
  /**
   * With the 'oil' look: scale the knives by how much structure the image has, so a close-up
   * (a face, a flower) gets knives that are big against its forms. See knifeScale.
   */
  autoScale: boolean;
  /**
   * With the 'oil' look: paint thin marks and small features lighter than their surroundings after
   * every layer. Off by default: with blades wider than a mullion, the darks painted after a light
   * line are what cut it to width, and a light laid last over wet dark paint picks some of it up.
   */
  deferThin: boolean;
  /**
   * With the 'oil' look: how far the underpainting is toned toward a warm dark (0 none, 1 fully), so
   * where it shows between knife strokes it reads as underpainting.
   */
  underTone: number;
  /**
   * With the 'oil' look: say of the shading direction (image.ts shadingField) in the form-aware
   * direction blend. On smooth forms, where colour edges are weak, strokes then run along the
   * iso-luminance contours of the form-scale lightness, across the turn of the form, so successive
   * planes step down the turn instead of combing along noise. 0 is off.
   */
  shading: number;
  /**
   * With the 'oil' look and `shading`: step of the value bands (OKLab L) the press layer splits
   * shapes into where the shading cue is strong, so each press lands on one band of the turn and
   * successive presses step down it (faceting). 0 is off.
   */
  valueBands: number;
  /**
   * With the 'oil' look: how strongly the form-bound layers after the presses hold back inside a
   * press (0-1), scaled by how well the press matches the image there and fading toward the press's
   * edges, so broad planes stay clean and detail gathers at their edges. Small features (forms.ts)
   * are exempt. 0 is off.
   */
  pressRestraint: number;
  /**
   * With the 'oil' look: paint stiffness, 0-1 (StrokeSpec.stiffness). Stiff paint holds the knife's
   * shape like dried palette-knife impasto: steep walls, flat pressed plateaus, sharp lips and
   * creased peaks, later strokes sitting crisply on earlier ones with little bleed. 0 gives the
   * wet, slumping paint of earlier rounds.
   */
  stiffness: number;
  /**
   * With the 'oil' look: multiplier on the paint knife strokes leave under the blade (each layer's
   * gapMm), so slabs stand thicker. 1 keeps the layers' own thickness.
   */
  thickness: number;
}

export interface PlannedStroke {
  /** Position in the plan; strokes are painted in this order. */
  index: number;
  layer: number;
  /** Index into Plan.tools. */
  tool: number;
  /** Path for paintStroke, mm. Includes the tail. */
  points: Vec2[];
  /** Footprint centreline used for planning, mm (no tail). */
  footprint: Vec2[];
  widthMm: number; lengthMm: number;
  /** sRGB 0-1. */
  primary: RGB; secondary: RGB; secondaryFraction: number;
  /** Optional colours across the blade, node 0's end first, and how well they are mixed (0-1). */
  profile?: RGB[]; mix?: number;
  volumePerNode: number; gapMm: number; pressMm: number;
  /** Share of the residue wiped off before loading. */
  wipe: number;
  seed: number;
  primitive: Primitive;
  /** Stroke shape for paintStroke: contact share, tapered ends, broken stretches, heap size. */
  engage: number; taper: [number, number]; taperMin: number; breaks: number; heap: number;
  /** Strength of the knife's edge profile along this stroke (1 = reference). */
  edgeFlaws: number;
  /** The hand: pressure samples from start to end, blade angle to the canvas, relative speed. */
  pressure: number[]; attackDeg: number; speed: number;
  /** 'physical' when berms and heap follow the hand (the 'oil' look); 'locked' otherwise. */
  deposition: 'locked' | 'physical';
  /** Paint stiffness for paintStroke (the 'oil' look with PlanSettings.stiffness above 0; absent otherwise). */
  stiffness?: number;
}

export interface Plan {
  widthMm: number; heightMm: number;
  tools: ToolSpec[];
  strokes: PlannedStroke[];
  /** Strokes per layer. */
  counts: number[];
  /** What happened to each layer's seeds. */
  stats: LayerStats[];
  /** The layers as planned (the 'oil' look may scale them and add a press layer). */
  layerNames: string[];
  /** Knife scale applied (1 unless autoScale). */
  knifeScale: number;
}

export interface LayerStats {
  /** Seeds traced. */
  seeds: number;
  /** Dropped: colour changed before the knife's minimum length, so it would smear across an edge. */
  tooShort: number;
  /** Dropped: mostly over strokes already placed in this layer. */
  overlapping: number;
  /** Dropped: would not bring the canvas closer to the image. */
  noGain: number;
  accepted: number;
  /** Accepted strokes by primitive. */
  primitives: Partial<Record<Primitive, number>>;
}

/** Layers for a canvas about 240 mm wide. Scale with `scaleLayers` for other sizes. */
export const DEFAULT_LAYERS: LayerSpec[] = [
  { name: 'underpaint', tool: 'bristle', widthMm: 22, nodes: 110, minLenMm: 40, maxLenMm: 90, spacing: 0.9, threshold: 0, tolerance: 0.14, blur: 0.6, flowBlur: 1.0, gapMm: 0.16, maxTurnDeg: 30, coverSkip: 0.55, passes: 2, sideWeight: 1, detail: 0, primitives: false, formLevel: -1 },
  { name: 'block-in', tool: 'knife', widthMm: 15, nodes: 128, minLenMm: 16, maxLenMm: 48, spacing: 0.75, threshold: 0.02, tolerance: 0.075, blur: 0.45, flowBlur: 0.8, gapMm: 0.22, maxTurnDeg: 14, coverSkip: 0.6, passes: 2, sideWeight: 1, detail: 0, formLevel: 0 },
  { name: 'masses', tool: 'knife', widthMm: 9.5, nodes: 112, minLenMm: 11, maxLenMm: 34, spacing: 0.7, threshold: 0.035, tolerance: 0.065, blur: 0.35, flowBlur: 0.7, gapMm: 0.3, maxTurnDeg: 16, coverSkip: 0.6, passes: 2, sideWeight: 0.8, detail: 0.08, formLevel: 1 },
  { name: 'forms', tool: 'knife', widthMm: 6, nodes: 88, minLenMm: 8, maxLenMm: 26, spacing: 0.7, threshold: 0.042, tolerance: 0.058, blur: 0.3, flowBlur: 0.6, gapMm: 0.34, maxTurnDeg: 18, coverSkip: 0.62, passes: 2, sideWeight: 0.55, detail: 0.14, formLevel: 1 },
  { name: 'detail', tool: 'knife', widthMm: 3.6, nodes: 64, minLenMm: 5.5, maxLenMm: 18, spacing: 0.75, threshold: 0.05, tolerance: 0.052, blur: 0.25, flowBlur: 0.55, gapMm: 0.35, maxTurnDeg: 24, coverSkip: 0.65, passes: 2, sideWeight: 0.3, detail: 0.2, formLevel: 2 },
  { name: 'contours', tool: 'knife', widthMm: 3.6, nodes: 64, minLenMm: 6, maxLenMm: 22, spacing: 1.2, threshold: 0.03, tolerance: 0.06, blur: 0.2, flowBlur: 0.5, gapMm: 0.32, maxTurnDeg: 30, coverSkip: 0.5, passes: 1, sideWeight: 0.3, detail: 0, kind: 'contour', formLevel: -1 },
  { name: 'accents', tool: 'knife', widthMm: 2.4, nodes: 48, minLenMm: 4, maxLenMm: 14, spacing: 0.8, threshold: 0.06, tolerance: 0.05, blur: 0.2, flowBlur: 0.5, gapMm: 0.35, maxTurnDeg: 30, coverSkip: 0.65, passes: 1, sideWeight: 0.2, detail: 0.26, formLevel: 2 },
];

export const DEFAULT_SETTINGS: PlanSettings = {
  widthMm: 240, layers: DEFAULT_LAYERS, seed: 1, analysisMm: 0.5,
  flatDirection: [1, 0], flatBias: 0.12, formWeight: 1.5, formSizesMm: [80, 35, 15], ground: [0.58, 0.47, 0.37], chroma: 1.06,
  lightBoost: 0.5, loadFactor: 1.15, minLoad: 6, tailMm: 3, look: 'locked', streaks: true, restraint: 0.5, presses: true, autoScale: true, deferThin: false, underTone: 0.3, shading: 3, valueBands: 0.09, pressRestraint: 0.8, stiffness: 1, thickness: 1.2,
};

/** Scale every length in the layers, for canvases larger or smaller than ~240 mm. */
export function scaleLayers(layers: LayerSpec[], k: number): LayerSpec[] {
  // Lengths have a physical floor (the knife's lift), so they shrink more slowly than widths.
  return layers.map((l) => ({ ...l, widthMm: l.widthMm * k, minLenMm: Math.max(9, l.minLenMm * k), maxLenMm: Math.max(12, l.maxLenMm * k) }));
}

/**
 * Current canvas colour, as linear RGB on the analysis grid. The planner keeps its own estimate,
 * or the caller can return the simulated canvas so later layers correct what the paint really did.
 */
export type CanvasFeedback = (layer: number, strokes: PlannedStroke[], estimate: Grid, plan: Plan) => Grid;

/** Plan a whole painting. */
export function planPainting(img: RgbImage, settings: Partial<PlanSettings> = {}, feedback?: CanvasFeedback): Plan {
  const planner = new Planner(img, { ...DEFAULT_SETTINGS, ...settings });
  for (let l = 0; l < planner.s.layers.length; l++) {
    const strokes = planner.planLayer(l);
    if (feedback) planner.current = feedback(l, strokes, planner.current, planner.plan);
  }
  // Thin high-contrast marks (mullions, stems, the white of an eye) go on last, over settled paint.
  const last = planner.flushDeferred();
  if (feedback && last.length) planner.current = feedback(planner.s.layers.length - 1, last, planner.current, planner.plan);
  return planner.plan;
}

const STEP = 0.25; // Tracing step as a share of the tool width.
const MIN_RADIUS = 2.5; // Tightest turn a knife makes, in blade widths.
/** A form-bound stroke keeps its centre this many blade widths inside its form (the blade reaches 0.5). */
const FORM_FIT = 0.3;
/** Smallest shape a form-bound blade respects, in square blade widths. */
const REGION_MIN = 1.5;
/** How short, as a share of the layer's minimum length, a press that meets a shape's edge may be. */
const SHORT_PRESS = 0.5;
/** Parts of a shape narrower than this many blade widths (half-width) bind no stroke of that blade. */
const OPEN = 0.3;
/**
 * Colour families, each with its own knife: twelve 30-degree hue sectors (turquoise and sky blue
 * are only about 30 degrees apart), each split into dark and light, then dark and light neutrals.
 */
export const FAMILIES = 26;
const HUES: readonly (readonly [number, number])[] = [
  [1, 0], [0.8660254, 0.5], [0.5, 0.8660254], [0, 1], [-0.5, 0.8660254], [-0.8660254, 0.5],
  [-1, 0], [-0.8660254, -0.5], [-0.5, -0.8660254], [0, -1], [0.5, -0.8660254], [0.8660254, -0.5],
];
/** Colour family of an OKLab colour (see FAMILIES). Nearest hue direction, without angles. */
export function colourFamily(lab: ArrayLike<number>): number {
  const a = lab[1], b = lab[2], light = lab[0] >= 0.72 ? 1 : 0;
  if (a * a + b * b < 0.025 * 0.025) return 24 + light;
  let best = 0, bestDot = -1e9;
  for (let i = 0; i < 12; i++) { const d = HUES[i][0] * a + HUES[i][1] * b; if (d > bestDot) { bestDot = d; best = i; } }
  return best * 2 + light;
}
const SIDE = 0.36;
/** Edge-profile strength per primitive in the 'oil' look. */
const EDGE_FLAWS: Record<Primitive, number> = { underpaint: 1, sweep: 0.15, plane: 0.35, mark: 0.5, contour: 0.4, scumble: 0.65, pat: 0.7, accent: 0.6, press: 0.3 };
/** How well the paint on the knife is mixed per primitive with streaks on: broad sweeps blend, quick presses stay streaky. */
const MIX: Record<Primitive, number> = { underpaint: 1, sweep: 0.75, plane: 0.35, mark: 0.45, contour: 0.6, scumble: 0.3, pat: 0.5, accent: 0.25, press: 0.4 };
/** Press knife widths, as multiples of the masses knife (4 to 18 mm beside a 9.5 mm masses knife). */
const PRESS_REL = [0.42, 0.63, 0.95, 1.37, 1.9];
/** Longest press, in its own widths: a press is a short, wide plane. */
const PRESS_ASPECT = 2.2;
/** Longest stroke in a form-bound layer under 'oil', in blade widths. */
const ASPECT_MAX = 3.2;
/** Largest small feature (sclera, catchlight) guarded from restraint, mm across. */
const FEATURE_MM = 5;
/** Share of the canvas with structure (detail map above 0.45) at which knives keep their sizes. */
const STRUCTURE_REF = 0.6;
/** Colours sampled across the blade for a streaked load. */
const PROFILE = 5;
/** Smallest blur for the shading direction, mm, and the lightness gradient (OKLab L per mm) it starts to count at. */
const SHADE_MIN_MM = 4, SHADE_GRAD = 0.004;
/** Shading cue above which a shape is split into value bands for presses. */
const BAND_CUE = 0.3;
/** Share of a shape on a strong shading cue for it to be pressed as planes (see planPresses). */
const PLANE_SHARE = 0.1;
/** A plane on a smooth form ignores texture finer than itself, but stops at a difference this many tolerances strong. */
const LINE_TOL = 2.5;
/** A warm dark (burnt-sienna-like, OKLab) that the underpainting is toned toward. */
const UNDER_TONE = [0.42, 0.05, 0.07];

export class Planner {
  readonly s: PlanSettings;
  readonly gw: number; readonly gh: number;
  /** Source in linear RGB and OKLab on the analysis grid. */
  readonly lin: Grid; readonly lab: Grid;
  /** What the canvas currently looks like, linear RGB. Updated after each layer. */
  current: Grid;
  readonly plan: Plan;
  /** The painting representation: detail, coherence, silhouettes, flatness, target relief. */
  readonly maps: PaintingMaps;
  /** The form hierarchy (forms.ts), coarse level first. */
  readonly forms: FormHierarchy;
  private readonly cell: number;
  /** Lightly blurred image for sampling colour across a stroke (streaked loads), this layer. */
  private profRef: Grid | null = null;
  /** Knife scale applied to the layers (see knifeScale). */
  readonly knifeScale: number;
  /** First tool of each layer in Plan.tools. */
  private readonly toolBase: number[] = [];
  /** Strokes held back to be painted last: thin high-contrast marks and features, with their layer. */
  private deferred: { t: Traced; l: number; W: number }[] = [];

  constructor(img: RgbImage, s0: PlanSettings) {
    this.cell = s0.analysisMm;
    const heightMm = s0.widthMm * img.h / img.w;
    this.gw = Math.max(8, Math.round(s0.widthMm / s0.analysisMm));
    this.gh = Math.max(8, Math.round(heightMm / s0.analysisMm));
    this.lin = resampleLinear(img, this.gw, this.gh);
    this.lab = toOklab(this.lin);
    this.maps = paintingMaps(this.lab, s0.analysisMm);
    // 'locked' keeps the round-3 plan: no shapes, no presses, no scaling. 'oil' gets all of them.
    const oil = s0.look === 'oil';
    let s: PlanSettings = oil ? s0 : { ...s0, formSizesMm: [] };
    this.knifeScale = oil && s.autoScale ? knifeScale(this.maps) : 1;
    if (this.knifeScale !== 1) s = { ...s, layers: scaleGraded(s.layers, this.knifeScale), formSizesMm: s.formSizesMm.map((d) => d * this.knifeScale) };
    if (oil && s.presses && s.formSizesMm.length) s = { ...s, layers: withPresses(s.layers) };
    this.s = s;
    const areaMm2 = s.widthMm * heightMm, fc = FEATURE_MM * this.knifeScale / s.analysisMm;
    this.forms = formHierarchy(this.lab, s.formSizesMm.map((d) => Math.max(3, Math.round(areaMm2 / (d * d)))), s.formSizesMm.length ? fc * fc : 0);
    this.current = makeGrid(this.gw, this.gh, 3);
    const g = [srgbToLinear(s.ground[0]), srgbToLinear(s.ground[1]), srgbToLinear(s.ground[2])];
    for (let i = 0; i < this.gw * this.gh; i++) for (let k = 0; k < 3; k++) this.current.data[i * 3 + k] = g[k];
    // Each layer keeps one knife per colour family, as a painter keeps a knife for each pile on the
    // palette, so residue left on a knife only ever mixes into like paint.
    const tools: ToolSpec[] = [];
    s.layers.forEach((l, i) => {
      this.toolBase.push(tools.length);
      if (l.kind === 'press') {
        // One knife per size and colour family; seeds as for the other layers, offset by size.
        l.sizesMm!.forEach((w, z) => { for (let f = 0; f < FAMILIES; f++) tools.push({ kind: 'knife', widthMm: w, nodes: pressNodes(w), seed: (s.seed * 7919 + 101 + i * 37 + f * 1543 + z * 7) | 0 }); });
      } else for (let f = 0; f < FAMILIES; f++) tools.push({ kind: l.tool, widthMm: l.widthMm, nodes: l.nodes, seed: (s.seed * 7919 + 101 + i * 37 + f * 1543) | 0 });
    });
    this.plan = { widthMm: s.widthMm, heightMm, tools, strokes: [], counts: [], stats: [], layerNames: s.layers.map((l) => l.name), knifeScale: this.knifeScale };
  }

  /**
   * The shading direction (image.ts shadingField) at the scale of a blade W cells wide: lightness
   * blurred to half a blade, but never below 4 mm, where skin texture would take over. Null when off.
   */
  private shadeAt(W: number): Grid | null {
    if (this.s.look !== 'oil' || !(this.s.shading > 0)) return null;
    const sigma = Math.max(0.5 * W, SHADE_MIN_MM / this.cell), key = Math.round(sigma * 100);
    let g = this.shadeCache.get(key);
    if (!g) { g = shadingField(this.lab, sigma, SHADE_GRAD * this.cell); this.shadeCache.set(key, g); }
    return g;
  }
  private readonly shadeCache = new Map<number, Grid>();
  /**
   * Per cell, after the press layer: how firmly a press holds it (0-1): the press's match to the
   * image there times how far inside the press the cell lies. Read by pressRestraint.
   */
  private pressHold: Float64Array | null = null;

  /**
   * Value band per cell for splitRegions: form-scale lightness (blurred as for the shading direction
   * at blade width W) quantised in steps of `valueBands`, centred on each shape's mean so a shape's
   * own value sits in the middle of a band. Where the shading cue is weak (flat or textured areas),
   * band 0: the shape is not split there. Only shapes whose own lightness turns by at least one band
   * (15th to 85th percentile inside the shape) are split: blurred lightness bleeds
   * across a flat shape's silhouette and would otherwise read as a turn. `turns` marks their cells.
   */
  private valueBands(region: Regions, shade: Grid, W: number): { band: Int32Array; turns: Uint8Array } {
    const n = this.gw * this.gh, sigma = Math.max(0.5 * W, SHADE_MIN_MM / this.cell), Lg = makeGrid(this.gw, this.gh, 1);
    for (let i = 0; i < n; i++) Lg.data[i] = this.lab.data[i * 3];
    const Lb = gaussBlur(Lg, sigma).data, sum = new Map<number, number>(), vals = new Map<number, number[]>();
    for (let i = 0; i < n; i++) {
      const lb = region.label[i];
      if (lb < 0) continue;
      sum.set(lb, (sum.get(lb) ?? 0) + Lb[i]);
      let v = vals.get(lb);
      if (!v) vals.set(lb, (v = []));
      v.push(Lg.data[i]);
    }
    const step = this.s.valueBands, turning = new Set<number>();
    for (const [lb, v] of vals) {
      const a = Float64Array.from(v).sort();
      if (a[Math.floor(0.85 * (a.length - 1))] - a[Math.floor(0.15 * (a.length - 1))] >= step) turning.add(lb);
    }
    const band = new Int32Array(n), turns = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      const lb = region.label[i];
      if (lb < 0 || !turning.has(lb)) continue;
      turns[i] = 1;
      if (shade.data[i * 4 + 2] < BAND_CUE) continue;
      band[i] = Math.floor((Lb[i] - sum.get(lb)! / vals.get(lb)!.length) / step + 0.5);
    }
    return { band, turns };
  }

  /** Plan one layer against `this.current`, append it to the plan, and update the estimate. */
  planLayer(l: number): PlannedStroke[] {
    if (this.s.layers[l].kind === 'press') return this.planPresses(l);
    const L = this.s.layers[l], { gw, gh, cell } = this, n = gw * gh, seed = this.s.seed;
    const W = L.widthMm / cell; // tool width in cells
    const ref = toOklab(gaussBlur(this.lin, L.blur * W));
    this.profRef = this.s.look === 'oil' && this.s.streaks ? toOklab(gaussBlur(this.lin, Math.max(0.6, 0.12 * W))) : null;
    const base = gaussBlur(this.lab, 0.6);
    const flow = mergeFields(
      directionField(base, L.flowBlur * W, this.s.flatDirection, this.s.flatBias),
      directionField(base, L.flowBlur * W * 3, this.s.flatDirection, this.s.flatBias), this.s.formWeight);
    // Marks and contours follow the fine edge field (organic contours); planes and sweeps the merged one.
    const fineFlow0 = directionField(base, Math.max(1.5, L.flowBlur * W * 0.6), this.s.flatDirection, this.s.flatBias * 0.5);
    // Inside a form, strokes also follow the form itself: its axis where it is elongated, its contour
    // near its boundary, image edges where they are clear.
    const level = L.formLevel !== undefined && L.formLevel >= 0 && L.threshold > 0 && this.forms.levels.length ? this.forms.levels[Math.min(L.formLevel, this.forms.levels.length - 1)] : null;
    const shade = level ? this.shadeAt(W) : null;
    const flowF = level ? formFlow(flow, level, W, 1, shade, this.s.shading) : flow;
    const fineFlow = level ? formFlow(fineFlow0, level, W, 0.5, shade, this.s.shading) : fineFlow0;
    // The shapes this blade respects: distinct in colour and big enough for it.
    const region = level ? regionsAtScale(level, gw, gh, L.tolerance, REGION_MIN * W * W, OPEN * W) : null;
    const fit = FORM_FIT * W + 0.75;
    // Shapes narrower than the finest blades (a mullion, a stem) bind no blade; the finest layers
    // still paint them, narrowing their marks to fit (widthRatios).
    const thinSeeds = !!level && L.formLevel! >= this.forms.levels.length - 1;
    const cur = toOklab(this.current);
    const err = new Float64Array(n);
    for (let i = 0; i < n; i++) err[i] = dist(ref.data, i * 3, cur.data, i * 3);
    // Seeding error: discounted where the image has little structure at this scale.
    const seedErr = err.slice();
    if (L.detail > 0) for (let i = 0; i < n; i++) seedErr[i] *= smoothstep((flow.data[i * 4 + 3] - L.detail * 0.5) / L.detail);
    // Restraint: deep inside a shape, leave the broad plane alone.
    if (region && this.s.restraint > 0 && L.detail > 0) for (let i = 0; i < n; i++) {
      const lb = region.label[i];
      // Small high-contrast features (the white of an eye, a catchlight) are never held back.
      if (lb >= 0 && this.forms.features.label[i] < 0) seedErr[i] *= 1 - this.s.restraint * smoothstep((clearance(region, i, lb) - W) / W);
    }
    // Inside a press that already matches the image, hold back further: the plane stays clean.
    // It also counts as partly covered, so a stroke lying mostly inside such presses is dropped like
    // one lying over strokes of its own layer.
    let held: Float64Array | null = null;
    if (this.pressHold && region && this.s.pressRestraint > 0 && L.detail > 0) {
      held = new Float64Array(n);
      for (let i = 0; i < n; i++) if (this.forms.features.label[i] < 0) held[i] = this.s.pressRestraint * this.pressHold[i];
      for (let i = 0; i < n; i++) seedErr[i] *= 1 - held[i];
    }

    const covered = new Uint8Array(n);
    const st: LayerStats = { seeds: 0, tooShort: 0, overlapping: 0, noGain: 0, accepted: 0, primitives: {} };
    const accepted: Traced[] = [];
    const cosTurn = cosDeg(L.maxTurnDeg);
    if (L.kind === 'contour') this.seedContours(l, W, ref, fineFlow, err, covered, accepted, st, cosDeg(Math.max(L.maxTurnDeg, 75)));
    // Coverage layers (threshold 0) keep adding fill passes until no cell is left bare.
    let bare = n;
    for (let pass = 0; L.kind !== 'contour' && (pass < L.passes || (L.threshold <= 0 && bare > 0 && pass < L.passes + 12)); pass++) {
      const fill = pass >= L.passes;
      // Each pass shifts the seed grid by half a cell, so its seeds fall between the last pass's.
      const step = Math.max(2, Math.floor((fill ? 0.5 : L.spacing) * W + 0.5)), off = pass % 2 ? step >> 1 : 0;
      const cands: { x: number; y: number; e: number; tie: number }[] = [];
      for (let by = -off; by < gh; by += step) for (let bx = -off; bx < gw; bx += step) {
        let sum = 0, cnt = 0, best = -1, bestE = -1, open = 0;
        for (let y = by < 0 ? 0 : by; y < by + step && y < gh; y++) for (let x = bx < 0 ? 0 : bx; x < bx + step && x < gw; x++) {
          const i = y * gw + x;
          sum += seedErr[i]; cnt++;
          // Seeds go where the blade fits inside its shape.
          if (!covered[i]) { open++; if (seedErr[i] > bestE && (!region || (region.label[i] >= 0 ? clearance(region, i, region.label[i]) >= fit : thinSeeds))) { bestE = seedErr[i]; best = i; } }
        }
        if (!cnt || best < 0 || (!fill && open < cnt * 0.25)) continue;
        const mean = sum / cnt;
        if (mean < L.threshold) continue;
        const x = best % gw, y = (best - x) / gw;
        cands.push({ x, y, e: mean, tie: hash(seed, l * 1009 + pass, bx * 7 + by * 131071) });
      }
      // Worst areas first. Where every area must be covered, order by hash so no direction is favoured.
      cands.sort(L.threshold > 0 ? (a, b) => b.e - a.e || a.tie - b.tie || a.y - b.y || a.x - b.x : (a, b) => a.tie - b.tie || a.y - b.y || a.x - b.x);
      for (const c of cands) {
        if (covered[c.y * gw + c.x]) continue;
        st.seeds++;
        const style = this.seedStyle(c.x + 0.5, c.y + 0.5, L);
        // On a smooth form turning in the light, a plane stays straight: facets, not a curving ribbon.
        const stiff = shade ? 1 - 0.7 * smoothstep((shade.data[(c.y * gw + c.x) * 4 + 2] - 0.2) / 0.5) : 1;
        const turnDeg = style.turnDeg * stiff;
        const t = this.trace(c.x + 0.5, c.y + 0.5, W, L, ref, style.fine ? fineFlow : flowF, turnDeg === L.maxTurnDeg ? cosTurn : cosDeg(turnDeg), style.lenMul, region);
        if (!t) { st.tooShort++; continue; }
        // A bristle brush has round ends; a knife has square ones.
        const fp = this.footprint(t.pts, W, L.tool === 'bristle');
        let cov = 0;
        if (held) for (const i of fp) cov += covered[i] ? 1 : held[i];
        else for (const i of fp) cov += covered[i];
        // A fill pass takes any stroke that closes a hole, however much it overlaps.
        if (fill ? cov >= fp.length : cov > fp.length * L.coverSkip) { st.overlapping++; continue; }
        // Keep a stroke only if it brings the canvas closer to the reference (Learning to Paint's reward).
        if (L.threshold > 0) {
          let before = 0, after = 0;
          for (const i of fp) { before += err[i]; after += dist(ref.data, i * 3, t.lab, 0); }
          if (after >= before * 0.92) { st.noGain++; continue; }
        }
        for (const i of fp) covered[i] = 1;
        t.cells = fp;
        accepted.push(t); st.accepted++;
      }
      bare = 0;
      for (let i = 0; i < n; i++) bare += covered[i] ^ 1;
    }
    // The finest fill layer gives every small high-contrast feature its own mark.
    if (region && l === this.finestFill()) this.featureMarks(W, L, ref, fineFlow, covered, accepted, st);
    return this.emit(l, accepted, ref, W, st);
  }

  /** Order a layer's strokes, append them to the plan (holding back the ones painted last), stamp the estimate. */
  private emit(l: number, accepted: Traced[], ref: Grid, W: number, st: LayerStats): PlannedStroke[] {
    this.plan.stats.push(st);
    const ordered = this.orderLayer(accepted, ref, l);
    const out: PlannedStroke[] = [];
    for (const t of ordered) {
      if ((t.thin || t.feature) && this.s.deferThin && this.standsOut(t, ref, W)) { this.deferred.push({ t, l, W }); this.stamp(t, l); continue; }
      const k = this.plan.strokes.length;
      const ps = this.toStroke(t, l, k, t.w ?? W);
      this.plan.strokes.push(ps);
      out.push(ps);
      st.primitives[ps.primitive] = (st.primitives[ps.primitive] ?? 0) + 1;
      this.stamp(t, l);
    }
    this.plan.counts.push(out.length);
    return out;
  }

  /**
   * The held-back strokes, appended to the plan after every layer, dark to light, so bright
   * mullions, stems and eye whites go on over settled paint.
   */
  flushDeferred(): PlannedStroke[] {
    const d = this.deferred.map((e, k) => ({ ...e, k, band: Math.min(3, Math.floor(clamp01(e.t.lab[0]) * 4)) }));
    this.deferred = [];
    d.sort((a, b) => a.band - b.band || a.k - b.k);
    const out: PlannedStroke[] = [];
    for (const e of d) {
      const ps = this.toStroke(e.t, e.l, this.plan.strokes.length, e.W);
      this.plan.strokes.push(ps);
      out.push(ps);
      this.plan.counts[e.l]++;
      const pr = this.plan.stats[e.l].primitives;
      pr[ps.primitive] = (pr[ps.primitive] ?? 0) + 1;
    }
    return out;
  }

  /**
   * Whether a thin mark is lighter than the paint either side of it (a bright mullion, a stem in
   * light, the white of an eye): those go on last. Dark lines are left in their layer, where the
   * lights painted after them keep them crisp.
   */
  private standsOut(t: Traced, ref: Grid, W: number): boolean {
    const p = t.pts, n = p.length >> 1;
    let side = 0, cnt = 0;
    for (let i = 0; i < n; i++) {
      const a = Math.max(0, i - 1), b = Math.min(n - 1, i + 1);
      let tx = p[b * 2] - p[a * 2], ty = p[b * 2 + 1] - p[a * 2 + 1];
      const tl = Math.sqrt(tx * tx + ty * ty);
      if (tl < 1e-9) continue;
      tx /= tl; ty /= tl;
      side += sampleE(ref, p[i * 2] - ty * W, p[i * 2 + 1] + tx * W, 0) + sampleE(ref, p[i * 2] + ty * W, p[i * 2 + 1] - tx * W, 0);
      cnt += 2;
    }
    return cnt > 0 && t.lab[0] > side / cnt + 0.15;
  }

  /** The last form-bound fill layer: the one that gives small features their marks. */
  private finestFill(): number {
    let f = -1;
    this.s.layers.forEach((L, i) => { if ((L.kind ?? 'fill') === 'fill' && (L.formLevel ?? -1) >= 0 && L.threshold > 0) f = i; });
    return f;
  }

  /**
   * A mark for every small high-contrast feature (forms.ts) this layer has not touched: traced from
   * the feature's middle like any stroke, or, where it is too small for that, a short straight
   * mark across it. Painted last, in the feature's own colour; the mark narrows to fit (widthRatios).
   */
  private featureMarks(W: number, L: LayerSpec, ref: Grid, flow: Grid, covered: Uint8Array, accepted: Traced[], st: LayerStats): void {
    const F = this.forms.features, gw = this.gw, d = new Float64Array(2);
    for (let f = 0; f < F.count; f++) {
      const cells = F.cells[f];
      let cx = 0, cy = 0;
      for (const i of cells) { const x = i % gw; cx += x; cy += (i - x) / gw; }
      cx /= cells.length; cy /= cells.length;
      let best = cells[0], bd = 1e18;
      for (const i of cells) { const x = i % gw, y = (i - x) / gw, dd = (x - cx) * (x - cx) + (y - cy) * (y - cy); if (dd < bd) { bd = dd; best = i; } }
      if (covered[best]) continue;
      st.seeds++;
      const x0 = best % gw + 0.5, y0 = (best - (best % gw)) / gw + 0.5;
      let t = this.trace(x0, y0, W, L, ref, flow, cosDeg(L.maxTurnDeg + 10), 0.6, null);
      if (t && t.len > ASPECT_MAX * W) {
        // A feature's mark stays short: the part of the path within 1.6 widths of the feature's middle.
        const keep: number[] = [];
        const r = ASPECT_MAX * W * 0.5;
        for (let i = 0; i < t.pts.length; i += 2) { const dx = t.pts[i] - x0, dy = t.pts[i + 1] - y0; if (dx * dx + dy * dy <= r * r) keep.push(t.pts[i], t.pts[i + 1]); }
        t = keep.length >= 4 ? { ...t, pts: keep, len: (keep.length / 2 - 1) * W * STEP } : null;
      }
      if (!t) {
        directionAt(flow, x0 - 0.5, y0 - 0.5, 0, 0, d);
        const half = Math.max(0.25 * L.minLenMm / this.cell, Math.sqrt(cells.length)), h = W * STEP, pts: number[] = [];
        for (let q = -half; q <= half + 1e-9; q += h) pts.push(x0 + d[0] * q, y0 + d[1] * q);
        t = { pts, lab: [], alt: [], spread: 0, len: pts.length > 2 ? (pts.length / 2 - 1) * h : h, cells: [] };
      }
      const col = [F.colour[f * 3], F.colour[f * 3 + 1], F.colour[f * 3 + 2]];
      t.lab = col; t.alt = col.slice(); t.spread = 0; t.feature = true;
      // As wide as the feature (its area as a disc), with the knife's edge if need be.
      t.engage = clamp(2.2 * Math.sqrt(cells.length / 3.141592653589793) / W, 0.25, 1);
      t.cells = this.footprint(t.pts, W);
      for (const i of t.cells) covered[i] = 1;
      accepted.push(t); st.accepted++;
    }
  }

  /**
   * Shape-sized presses: in each shape (at the layer's form level, merged and freed for the
   * smallest press), the widest press that fits at its thickest uncovered point, straight along the
   * shape, at most PRESS_ASPECT of its width long; then the next thickest point, until the shape is
   * covered or too thin. A press is kept only where it brings the canvas closer to the image.
   */
  private planPresses(l: number): PlannedStroke[] {
    const L = this.s.layers[l], { gw, gh, cell } = this, n = gw * gh, sizes = L.sizesMm!;
    const st: LayerStats = { seeds: 0, tooShort: 0, overlapping: 0, noGain: 0, accepted: 0, primitives: {} };
    const accepted: Traced[] = [];
    const W0 = sizes[0] / cell;
    const ref = toOklab(gaussBlur(this.lin, L.blur * W0));
    if (!this.forms.levels.length) return this.emit(l, accepted, ref, W0, st);
    const level = this.forms.levels[Math.min(L.formLevel ?? 2, this.forms.levels.length - 1)];
    this.profRef = this.s.streaks ? toOklab(gaussBlur(this.lin, Math.max(0.6, 0.12 * W0))) : null;
    const base = gaussBlur(this.lab, 0.6);
    const shade = this.shadeAt(W0 * 2);
    const flow = formFlow(mergeFields(
      directionField(base, L.flowBlur * W0 * 2, this.s.flatDirection, this.s.flatBias),
      directionField(base, L.flowBlur * W0 * 6, this.s.flatDirection, this.s.flatBias), this.s.formWeight), level, W0 * 2, 0.6, shade, this.s.shading);
    // Nothing is freed for presses: a press never covers a thin shape (a mullion, a stem), however narrow.
    let region = regionsAtScale(level, gw, gh, L.tolerance, REGION_MIN * W0 * W0, 0);
    // On smooth forms turning in the light, each shape is split into value bands: one press per band.
    let turns: Uint8Array | null = null;
    if (shade && this.s.valueBands > 0) {
      const vb = this.valueBands(region, shade, W0 * 2);
      region = splitRegions(region, gw, gh, vb.band, REGION_MIN * W0 * W0);
      turns = vb.turns;
    }
    // On those smooth forms a knife judges its fit against the image at its own scale (a plane
    // ignores skin texture finer than itself), so wider knives can take a band.
    const planeRef = turns ? sizes.map((sz) => toOklab(gaussBlur(this.lin, L.blur * sz / cell))) : null;
    const cur = toOklab(this.current), err = new Float64Array(n);
    for (let i = 0; i < n; i++) err[i] = dist(ref.data, i * 3, cur.data, i * 3);
    const members = new Map<number, number[]>();
    for (let i = 0; i < n; i++) { const lb = region.label[i]; if (lb >= 0) { let a = members.get(lb); if (!a) members.set(lb, (a = [])); a.push(i); } }
    const covered = new Uint8Array(n), d = new Float64Array(2);
    const hold = this.s.pressRestraint > 0 ? (this.pressHold = new Float64Array(n)) : null;
    for (const lb of [...members.keys()].sort((a, b) => a - b)) {
      const cells = members.get(lb)!;
      // A shape with a real share of smooth, shaded form (a face, not a lake or a facade) is pressed
      // as planes: enough presses to cover it (a whole face is one shape), not just 32, but each at
      // least half as wide as the widest already in it.
      let smoothCells = 0;
      if (turns) for (const i of cells) if (turns[i] && shade!.data[i * 4 + 2] >= BAND_CUE) smoothCells++;
      const planes = smoothCells >= PLANE_SHARE * cells.length;
      const maxTries = planes ? Math.max(32, Math.ceil(cells.length / (W0 * W0))) : 32;
      let widest = 0;
      for (let tries = 0; tries < maxTries; tries++) {
        let best = -1, bc = -1;
        for (const i of cells) if (!covered[i]) { const c = clearance(region, i, lb); if (c > bc) { bc = c; best = i; } }
        if (best < 0) break;
        const x0 = best % gw + 0.5, y0 = (best - (best % gw)) / gw + 0.5;
        directionAt(flow, x0 - 0.5, y0 - 0.5, 0, 0, d);
        const smoothForm = !!turns && turns[best] === 1 && shade!.data[best * 4 + 2] >= BAND_CUE;
        const refOf = (q: number) => (smoothForm ? planeRef![q] : ref);
        let col = [sampleE(ref, x0, y0, 0), sampleE(ref, x0, y0, 1), sampleE(ref, x0, y0, 2)];
        // The widest knife that spans the shape here and whose two edges still land on its colour
        // (a shape may hold structure finer than itself: petals in a flower head).
        const across = (R: Grid, x: number, y: number, W: number, c: number[]) => Math.max(diffAt(R, x - d[1] * W * 0.4, y + d[0] * W * 0.4, c), diffAt(R, x + d[1] * W * 0.4, y - d[0] * W * 0.4, c));
        let z = -1;
        for (let q = 0; q < sizes.length; q++) {
          if (sizes[q] / cell > 2.1 * bc) continue;
          const R = refOf(q), c = [sampleE(R, x0, y0, 0), sampleE(R, x0, y0, 1), sampleE(R, x0, y0, 2)];
          // A plane may ignore texture finer than itself, never a strong line (a mullion, a hair).
          if (q === 0 || (across(R, x0, y0, sizes[q] / cell, c) <= L.tolerance && (R === ref || across(ref, x0, y0, sizes[q] / cell, c) <= LINE_TOL * L.tolerance))) z = q;
        }
        if (z < 0) break;
        // The slivers between planes are left to the forms layer rather than filled with small presses.
        if (planes && sizes[z] < 0.5 * widest) { const fp0 = this.footprint([x0, y0, x0 + d[0], y0 + d[1]], sizes[z] / cell); for (const i of fp0) covered[i] = 1; continue; }
        const W = sizes[z] / cell, h = W * STEP, R = refOf(z);
        if (smoothForm) col = [sampleE(R, x0, y0, 0), sampleE(R, x0, y0, 1), sampleE(R, x0, y0, 2)];
        st.seeds++;
        const ends = [0, 0], maxLen = PRESS_ASPECT * W;
        let taken = 1;
        // Straight both ways while the blade stays in the shape and the colour holds.
        for (let side = 0; side < 2; side++) {
          const sg = side ? -1 : 1;
          for (;;) {
            if (ends[0] + ends[1] + h > maxLen) break;
            const q = ends[side] + h, x = x0 + d[0] * q * sg, y = y0 + d[1] * q * sg;
            if (x < 0 || y < 0 || x >= gw || y >= gh) break;
            const j = Math.floor(y) * gw + Math.floor(x);
            if (clearance(region, j, lb) < 0.4 * W || diffAt(R, x, y, col) > L.tolerance || (z > 0 && across(R, x, y, W, col) > L.tolerance * 1.4)) break;
            if (R !== ref && (diffAt(ref, x, y, col) > LINE_TOL * L.tolerance || across(ref, x, y, W, col) > LINE_TOL * L.tolerance)) break;
            ends[side] = q; taken++;
            for (let k = 0; k < 3; k++) col[k] += (sampleE(R, x, y, k) - col[k]) / taken;
          }
        }
        const len = ends[0] + ends[1];
        const pts: number[] = [];
        for (let q = -ends[1]; q <= ends[0] + 1e-9; q += h) pts.push(x0 + d[0] * q, y0 + d[1] * q);
        const fp = this.footprint(pts.length >= 4 ? pts : [x0, y0, x0 + d[0] * h, y0 + d[1] * h], W);
        if (len < 0.6 * W) { st.tooShort++; for (const i of fp) covered[i] = 1; continue; }
        let before = 0, after = 0;
        for (const i of fp) { before += err[i]; after += dist(ref.data, i * 3, col, 0); }
        for (const i of fp) covered[i] = 1;
        if (after >= before * 0.97) { st.noGain++; continue; }
        // Marbling colour: the footprint sample farthest from the mean.
        let far = fp[0], farD = -1;
        for (const i of fp) { const dd = dist(ref.data, i * 3, col, 0); if (dd > farD) { farD = dd; far = i; } }
        accepted.push({ pts, lab: col, alt: [ref.data[far * 3], ref.data[far * 3 + 1], ref.data[far * 3 + 2]], spread: Math.min(farD, L.tolerance * 1.5), len, cells: fp, w: W, size: z, press: true, ...(smoothForm ? { plane: true } : {}) });
        st.accepted++;
        if (sizes[z] > widest) widest = sizes[z];
        if (hold && planes) {
          // Only planes of smooth forms hold (elsewhere, a lake, a facade, holding back cost edges).
          // Match at the press's own scale, and depth inside the press: full in its middle, none at its edges.
          const ax = x0 - d[0] * ends[1], ay = y0 - d[1] * ends[1];
          for (const i of fp) {
            const cx = i % gw + 0.5, cy = (i - (i % gw)) / gw + 0.5, rx = cx - ax, ry = cy - ay;
            const along = rx * d[0] + ry * d[1], perp = rx * -d[1] + ry * d[0], ap = perp < 0 ? -perp : perp;
            const depth = smoothstep((0.5 * W - ap) / (0.25 * W)) * smoothstep(along / (0.25 * W)) * smoothstep((len - along) / (0.25 * W));
            const v = (1 - smoothstep(dist(R.data, i * 3, col, 0) / L.tolerance)) * depth;
            if (v > hold[i]) hold[i] = v;
          }
        }
      }
    }
    return this.emit(l, accepted, ref, W0, st);
  }

  /**
   * Order inside a layer. Where two strokes overlap, the one that matches the image better there is
   * painted later, so it ends up on top: a tree's strokes go over the mountain behind it, not under.
   * Without a conflict, darks go before lights (lights then stay clean on top), with a hash
   * spreading strokes over the canvas. Precedence cycles are broken by that same default key.
   */
  private orderLayer(strokes: Traced[], ref: Grid, l: number): Traced[] {
    const n = strokes.length, seed = this.s.seed, cells = this.gw * this.gh;
    // Ground forms before figure forms (forms.ts), then darks before lights.
    const fl = this.forms.levels[Math.min(1, this.forms.levels.length - 1)];
    const figOf = (t: Traced) => { if (!fl) return 0; let f = 0; for (const c of t.cells) f += fl.figure[fl.label[c]]; return t.cells.length ? f / t.cells.length : 0; };
    const key = strokes.map((t, k) => ({ fig: Math.min(2, Math.floor(figOf(t) * 3)), band: Math.min(3, Math.floor(t.lab[0] * 4)), tie: hash(seed, l * 7 + 3, k), k }));
    const before = (a: number, b: number) => key[a].fig - key[b].fig || key[a].band - key[b].band || key[a].tie - key[b].tie || a - b;
    // Strokes covering each cell, as a linked list over (cell -> first entry, entry -> next).
    const head = new Int32Array(cells).fill(-1), next: number[] = [], who: number[] = [];
    strokes.forEach((t, k) => { for (const c of t.cells) { next.push(head[c]); who.push(k); head[c] = who.length - 1; } });
    // For each overlapping pair, how much better the second matches the image than the first.
    const pair = new Map<number, number>();
    for (let c = 0; c < cells; c++) {
      for (let e = head[c]; e >= 0; e = next[e]) for (let f = next[e]; f >= 0; f = next[f]) {
        const a = Math.min(who[e], who[f]), b = Math.max(who[e], who[f]);
        const d = dist(ref.data, c * 3, strokes[a].lab, 0) - dist(ref.data, c * 3, strokes[b].lab, 0);
        pair.set(a * n + b, (pair.get(a * n + b) ?? 0) + d);
      }
    }
    const succ: number[][] = strokes.map(() => []), indeg = new Int32Array(n);
    // Map iteration follows insertion order, which is fixed by the cell scan, so this is deterministic.
    for (const [ab, d] of pair) {
      if (d === 0) continue;
      const a = Math.floor(ab / n), b = ab - a * n;
      const [first, last] = d > 0 ? [a, b] : [b, a];
      succ[first].push(last); indeg[last]++;
    }
    const done = new Uint8Array(n), out: Traced[] = [];
    for (let placed = 0; placed < n; placed++) {
      // The earliest-keyed stroke that nothing unplaced must precede; on a cycle, the earliest overall.
      let pick = -1, free = false;
      for (let k = 0; k < n; k++) {
        if (done[k]) continue;
        const ready = indeg[k] === 0;
        if (pick < 0 || (ready && !free) || (ready === free && before(k, pick) < 0)) { pick = k; free = ready; }
      }
      done[pick] = 1; out.push(strokes[pick]);
      for (const m of succ[pick]) indeg[m]--;
    }
    return out;
  }

  /** Trace a stroke both ways from (x, y) along the flow. Grid coordinates. */
  /**
   * How a stroke seeded here may move, read from the maps around the seed: flat areas take broad
   * curved sweeps, fine coherent structure takes long organic marks on the fine field, incoherent
   * texture takes short strokes, everything else the layer's stiff planes.
   */
  private seedStyle(x: number, y: number, L: LayerSpec): { turnDeg: number; fine: boolean; lenMul: number } {
    if (L.tool === 'bristle' || L.primitives === false) return { turnDeg: L.maxTurnDeg, fine: false, lenMul: 1 };
    const M = this.maps, F = mapAt(M.flat, M.w, M.h, x, y), D = mapAt(M.detail, M.w, M.h, x, y), C = mapAt(M.coherence, M.w, M.h, x, y);
    if (F > 0.6) return { turnDeg: Math.max(L.maxTurnDeg, 45), fine: false, lenMul: 1.25 };
    if (D > 0.45 && C < 0.38) return { turnDeg: L.maxTurnDeg + 10, fine: true, lenMul: 0.6 };
    if (C > 0.5 && L.widthMm <= 6.5) return { turnDeg: 65, fine: true, lenMul: 1.2 };
    return { turnDeg: L.maxTurnDeg, fine: false, lenMul: 1 };
  }

  private trace(x0: number, y0: number, W: number, L: LayerSpec, ref: Grid, flow: Grid, cosTurn: number, lenMul = 1, level: Regions | null = null): Traced | null {
    const { gw, gh, cell } = this;
    // The form this stroke belongs to; it may not leave it.
    const lab0 = level ? level.label[Math.min(gh - 1, Math.max(0, Math.floor(y0))) * gw + Math.min(gw - 1, Math.max(0, Math.floor(x0)))] : -1;
    // Distance to the nearest other shape: the blade may reach into it only by its margin.
    const insetAt = (x: number, y: number) => clearance(level!, Math.min(gh - 1, Math.max(0, Math.floor(y))) * gw + Math.min(gw - 1, Math.max(0, Math.floor(x))), lab0);
    // A shape too narrow for this blade is left to a finer layer.
    // Seeded in a part too narrow to bind anybody (a mullion, a stem): free, and painted last.
    const thin = !!level && lab0 < 0;
    if (thin) level = null;
    if (level && insetAt(x0, y0) < FORM_FIT * W) return null;
    const h = W * STEP, minLen = L.minLenMm / cell;
    let maxLen = Math.max(minLen * 1.05, L.maxLenMm * lenMul / cell);
    // Inside shapes under 'oil': short, wide planes rather than long ribbons.
    if ((level || thin) && this.s.presses) maxLen = Math.min(maxLen, Math.max(minLen * 1.05, ASPECT_MAX * W));
    const col = [sampleE(ref, x0, y0, 0), sampleE(ref, x0, y0, 1), sampleE(ref, x0, y0, 2)];
    let taken = 1;
    const d = new Float64Array(2), m = new Float64Array(2);
    directionAt(flow, x0 - 0.5, y0 - 0.5, 0, 0, d);
    const d0x = d[0], d0y = d[1];
    const sides: number[][] = [[], []];
    const head = [[x0, y0, d0x, d0y], [x0, y0, -d0x, -d0y]];
    const alive = [true, true];
    let len = 0, atForm = false;
    const margin = W * 0.5;
    // Grow the two ends in turn, each stopping on its own. An end stops at the canvas edge or
    // where the colour changes. Below the minimum length it tolerates a larger colour change, and
    // if both ends stop short the stroke is dropped (except in layers that must cover everything),
    // so a knife never smears across an edge just to reach its physical minimum length.
    const loose = L.tolerance * 1.6;
    // Smallest turning radius: MIN_RADIUS blade widths. Per step of STEP widths that is STEP / MIN_RADIUS radians.
    const stepAngle = STEP / MIN_RADIUS, a2 = stepAngle * stepAngle, cosStep = 1 - a2 / 2 + a2 * a2 / 24, sinStep = Math.sqrt(1 - cosStep * cosStep);
    const S = this.maps.silhouette, mw = this.maps.w, mh = this.maps.h;
    // Coverage layers must cover everything, so they are not held back at silhouettes.
    const guard = L.threshold > 0 ? smoothstep((L.widthMm - 2.5) / 7) : 0;
    while ((alive[0] || alive[1]) && len < maxLen) {
      for (let sIdx = 0; sIdx < 2 && len < maxLen; sIdx++) {
        if (!alive[sIdx]) continue;
        const [px, py, dx, dy] = head[sIdx];
        // Midpoint (RK2) step along the field, keeping the sign of travel.
        directionAt(flow, px - 0.5, py - 0.5, dx, dy, d);
        directionAt(flow, px + d[0] * h * 0.5 - 0.5, py + d[1] * h * 0.5 - 0.5, d[0], d[1], m);
        // A knife cannot turn tighter than a few blade widths without smearing: limit the turn per
        // step to that radius, then past the total turn limit carry straight on.
        if (m[0] * dx + m[1] * dy < cosStep) {
          const sg = dx * m[1] - dy * m[0] < 0 ? -1 : 1;
          m[0] = dx * cosStep - dy * sinStep * sg; m[1] = dy * cosStep + dx * sinStep * sg;
        }
        const ref0x = sIdx ? -d0x : d0x, ref0y = sIdx ? -d0y : d0y;
        if (m[0] * ref0x + m[1] * ref0y < cosTurn) { m[0] = dx; m[1] = dy; }
        const nx = px + m[0] * h, ny = py + m[1] * h;
        if (nx < -margin || ny < -margin || nx > gw - 1 + margin || ny > gh - 1 + margin) { alive[sIdx] = false; continue; }
        // Centre and both sides of the blade must still match the stroke's colour.
        const ox = -m[1] * W * SIDE, oy = m[0] * W * SIDE;
        const sw = L.sideWeight;
        let e = (diffAt(ref, nx, ny, col) * 2 + sw * (diffAt(ref, nx + ox, ny + oy, col) + diffAt(ref, nx - ox, ny - oy, col))) / (2 + 2 * sw);
        // Silhouette protection: where a silhouette runs under the blade, each blade edge must match
        // on its own and the tolerance tightens, so a broad stroke never straddles a ridgeline or a
        // trunk. Narrow knives, which paint those features, are held to it less.
        let tol = len >= minLen ? L.tolerance : loose;
        if (guard > 0) {
          const ex = -m[1] * W * 0.48, ey = m[0] * W * 0.48;
          const p = guard * Math.max(mapAt(S, mw, mh, nx, ny), mapAt(S, mw, mh, nx + ex, ny + ey), mapAt(S, mw, mh, nx - ex, ny - ey));
          if (p > 0.05) {
            e = Math.max(e, p * Math.max(diffAt(ref, nx + ex, ny + ey, col), diffAt(ref, nx - ex, ny - ey, col)));
            tol *= 1 - 0.3 * p;
          }
        }
        if (e > tol) { alive[sIdx] = false; continue; }
        // Stay inside the form, the blade overlapping its neighbours by at most a fifth of its width.
        if (level && insetAt(nx, ny) < FORM_FIT * W) { alive[sIdx] = false; atForm = true; continue; }
        // Judge later steps against the running mean of the centreline, not the seed pixel alone:
        // in textured areas (foliage, broken rock) one pixel is a poor guide to the area's colour.
        taken++;
        for (let k = 0; k < 3; k++) col[k] += (sampleE(ref, nx, ny, k) - col[k]) / taken;
        sides[sIdx].push(nx, ny);
        head[sIdx] = [nx, ny, m[0], m[1]];
        len += h;
      }
    }
    // A stroke that fills a small shape edge to edge may be short: a single press of the knife.
    if (len < (atForm ? minLen * SHORT_PRESS : minLen * 0.98)) {
      if (L.threshold > 0) return null;
      // Coverage layers: extend straight on, alternating ends, to the minimum length.
      for (let sIdx = 0; len < minLen; sIdx ^= 1) {
        const [px, py, dx, dy] = head[sIdx];
        const nx = px + dx * h, ny = py + dy * h;
        sides[sIdx].push(nx, ny); head[sIdx] = [nx, ny, dx, dy]; len += h;
      }
    }
    // Join: backward points reversed, the seed, then forward points.
    const b = sides[1], f = sides[0], pts: number[] = [];
    for (let i = b.length - 2; i >= 0; i -= 2) pts.push(b[i], b[i + 1]);
    pts.push(x0, y0);
    for (let i = 0; i < f.length; i += 2) pts.push(f[i], f[i + 1]);
    // Colour: the mean over the footprint, plus the farthest sample for marbling.
    const samples: number[] = [], weights: number[] = [];
    for (let i = 0; i < pts.length; i += 2) {
      const j = Math.min(pts.length - 2, i + 2), k = Math.max(0, i - 2);
      let tx = pts[j] - pts[k], ty = pts[j + 1] - pts[k + 1];
      const tl = Math.sqrt(tx * tx + ty * ty) || 1; tx /= tl; ty /= tl;
      for (const o of [-SIDE, 0, SIDE]) {
        const sx = pts[i] - ty * W * o, sy = pts[i + 1] + tx * W * o;
        samples.push(sampleE(ref, sx, sy, 0), sampleE(ref, sx, sy, 1), sampleE(ref, sx, sy, 2));
        weights.push(o === 0 ? 2 : L.sideWeight);
      }
    }
    const mean = [0, 0, 0];
    let wsum = 0;
    for (let i = 0, q = 0; i < samples.length; i += 3, q++) { wsum += weights[q]; for (let k = 0; k < 3; k++) mean[k] += samples[i + k] * weights[q]; }
    for (let k = 0; k < 3; k++) mean[k] /= wsum;
    let far = 0, farD = -1;
    // The marbling colour: the sample farthest from the mean, among those the blade really carries.
    for (let i = 0, q = 0; i < samples.length; i += 3, q++) { const dd = dist(samples, i, mean, 0) * (weights[q] >= 1 ? 1 : weights[q]); if (dd > farD) { farD = dd; far = i; } }
    return { pts, lab: mean, alt: [samples[far], samples[far + 1], samples[far + 2]], spread: farD, len, cells: [], ...(thin ? { thin } : {}) };
  }

  /** Cells within half a width of the centreline, in increasing index order. */
  private footprint(pts: number[], W: number, roundEnds = false): number[] {
    const { gw, gh } = this, r = W * 0.5, r2 = r * r;
    let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
    for (let i = 0; i < pts.length; i += 2) { x0 = Math.min(x0, pts[i]); x1 = Math.max(x1, pts[i]); y0 = Math.min(y0, pts[i + 1]); y1 = Math.max(y1, pts[i + 1]); }
    const X0 = Math.max(0, Math.floor(x0 - r)), X1 = Math.min(gw - 1, Math.ceil(x1 + r));
    const Y0 = Math.max(0, Math.floor(y0 - r)), Y1 = Math.min(gh - 1, Math.ceil(y1 + r));
    const out: number[] = [];
    const last = pts.length - 2;
    for (let y = Y0; y <= Y1; y++) for (let x = X0; x <= X1; x++) {
      const cx = x + 0.5, cy = y + 0.5;
      let best = 1e18;
      for (let i = 0; i < last; i += 2) {
        const ax = pts[i], ay = pts[i + 1], bx = pts[i + 2], by = pts[i + 3];
        const vx = bx - ax, vy = by - ay, l2 = vx * vx + vy * vy;
        let t = l2 > 0 ? ((cx - ax) * vx + (cy - ay) * vy) / l2 : 0;
        // A knife has square ends: past the first and last point the footprint stops.
        if (!roundEnds && ((i === 0 && t < 0) || (i === last - 2 && t > 1))) continue;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        const ex = ax + vx * t - cx, ey = ay + vy * t - cy, d2 = ex * ex + ey * ey;
        if (d2 < best) best = d2;
      }
      if (last === 0) { const ex = pts[0] - cx, ey = pts[1] - cy; best = ex * ex + ey * ey; }
      if (best <= r2) out.push(y * gw + x);
    }
    return out;
  }

  /** The colour a stroke is mixed in: the image's, or for the underpainting under 'oil', toned. */
  private paintLab(t: Traced, L: LayerSpec): number[] {
    return this.s.look === 'oil' && L.tool === 'bristle' && this.s.underTone > 0 ? mix3(t.lab, UNDER_TONE, this.s.underTone) : t.lab;
  }

  /**
   * Colours across the blade along a path (grid coordinates, in travel order), from the blade end at
   * -normal (node 0) to +normal: each the mean along the path at that offset, re-centred on the
   * stroke's colour and limited to a moderate departure from it.
   */
  private profile(pts: number[], W: number, lab: number[]): number[][] {
    const R = this.profRef!, n = pts.length >> 1, acc = Array.from({ length: PROFILE }, () => [0, 0, 0]);
    let cnt = 0;
    for (let i = 0; i < n; i++) {
      const a = Math.max(0, i - 1), b = Math.min(n - 1, i + 1);
      let tx = pts[b * 2] - pts[a * 2], ty = pts[b * 2 + 1] - pts[a * 2 + 1];
      const tl = Math.sqrt(tx * tx + ty * ty);
      if (tl < 1e-9) continue;
      tx /= tl; ty /= tl;
      for (let k = 0; k < PROFILE; k++) {
        const q = ((k + 0.5) / PROFILE - 0.5) * W * 0.85, x = pts[i * 2] - ty * q, y = pts[i * 2 + 1] + tx * q;
        for (let c = 0; c < 3; c++) acc[k][c] += sampleE(R, x, y, c);
      }
      cnt++;
    }
    if (!cnt) return [lab];
    const mean = [0, 0, 0];
    for (const v of acc) for (let c = 0; c < 3; c++) { v[c] /= cnt; mean[c] += v[c] / PROFILE; }
    return acc.map((v) => {
      const d = [v[0] - mean[0], v[1] - mean[1], v[2] - mean[2]], m = Math.sqrt(d[0] * d[0] + d[1] * d[1] + d[2] * d[2]);
      const k = m > 0.1 ? 0.1 / m : 1;
      return [lab[0] + d[0] * k, lab[1] + d[1] * k, lab[2] + d[2] * k];
    });
  }

  /** Write the stroke's colour into the canvas estimate. */
  private stamp(t: Traced, l: number): void {
    const L = this.s.layers[l];
    // Thin underpainting lets some of what is below show through; loaded knife paint covers.
    const alpha = L.tool === 'bristle' ? 0.8 : 0.92;
    const [r, g, b] = labToLinear(mix3(this.paintLab(t, L), t.alt, 0.25));
    for (const i of t.cells) {
      const d = this.current.data;
      d[i * 3] += (r - d[i * 3]) * alpha; d[i * 3 + 1] += (g - d[i * 3 + 1]) * alpha; d[i * 3 + 2] += (b - d[i * 3 + 2]) * alpha;
    }
  }

  /**
   * Pick a stroke primitive from the painting maps under the stroke (see Primitive), and its shape:
   * multipliers on gap and load, pressure, contact share, tapers, breaks and heap.
   */
  private choosePrimitive(t: Traced, L: LayerSpec, lightness: number, h3: number, h4: number) {
    const M = this.maps;
    let D = 0, C = 0, F = 0, R = 0, S = 0;
    for (const c of t.cells) { D += M.detail[c]; C += M.coherence[c]; F += M.flat[c]; R += M.relief[c]; S += M.silhouette[c]; }
    const k = t.cells.length || 1;
    D /= k; C /= k; F /= k; R /= k; S /= k;
    const vary = 0.85 + 0.15 * h3, jit = (a: number) => a * (0.92 + 0.16 * h3);
    // How much paint to pick up follows the target relief: little for quiet areas, a lot for sculptural ones.
    const pick = 0.45 + 1.3 * R;
    type Shape = { primitive: Primitive; gap: number; load: number; press: number; engage: number; taper: [number, number]; taperMin: number; breaks: number; heap: number; pressure: number[]; attackDeg: number; speed: number };
    const shape = (o: Shape) => o;
    if (L.primitives === false || L.tool === 'bristle') {
      return shape({ primitive: 'underpaint', gap: 1, load: 1, press: 0, engage: 1, taper: [0, 0], taperMin: 0.2, breaks: 0, heap: 0.3, pressure: [1], attackDeg: 30, speed: 1 });
    }
    if (t.press && t.plane) {
      // A facet of a smooth form: laid flat and full, then lifted lightly, so the bead stays on the
      // knife and the plane ends in a clean edge rather than a heap.
      return shape({ primitive: 'press', gap: 0.85 + 0.3 * R, load: 1.3 * pick, press: 0, engage: 1, taper: [0, 0], taperMin: 0.5, breaks: 0, heap: 0.5, pressure: [0.85, jit(1.1), 1.15, 1, 0.25], attackDeg: 18 + 8 * h4, speed: 0.8 });
    }
    if (t.press) {
      // One bold, loaded press laid flat and lifted into a heap: a facet, a petal.
      return shape({ primitive: 'press', gap: 0.85 + 0.3 * R, load: 1.5 * pick, press: 0, engage: 1, taper: [0, 0], taperMin: 0.5, breaks: 0, heap: 1.2, pressure: [0.85, jit(1.15), 1.2, 1.1, 0.5 + 0.4 * R], attackDeg: 20 + 10 * h4, speed: 0.75 });
    }
    if (t.feature) {
      return shape({ primitive: 'mark', gap: 0.9, load: 1.2 * pick, press: 0, engage: t.engage ?? 1, taper: [0, 0], taperMin: 0.2, breaks: 0, heap: 0.6, pressure: [0.6, jit(1), 1.05, 0.95, 0.5], attackDeg: 35, speed: 0.9 });
    }
    if (L.kind === 'contour') {
      return shape({ primitive: 'contour', gap: 0.85 + 0.35 * R, load: 0.8 * pick, press: 0, engage: 1, taper: [0, 0], taperMin: 0.15, breaks: 0, heap: 0.3, pressure: [0.5, 0.95, jit(1), 0.9, 0.35], attackDeg: 25, speed: 1.1 });
    }
    if (F > 0.6) {
      // Flat: a broad, light, flat-bladed sweep that feathers out; little paint, little berm.
      return shape({ primitive: 'sweep', gap: 0.5, load: 0.6, press: 0.06 + 0.12 * F, engage: 1, taper: [0, 0], taperMin: 0.55, breaks: 0, heap: 0.1, pressure: [0.6, jit(0.75), 0.8, 0.7, 0.3], attackDeg: 12 + 6 * h4, speed: 1.5 });
    }
    if (D > 0.45 && C < 0.38) {
      if (R > 0.62 && h4 < 0.45) {
        // High-relief texture: press and lift, an irregular loaded deposit.
        return shape({ primitive: 'pat', gap: 0.9, load: 1.4 * pick, press: 0, engage: 1, taper: [0, 0], taperMin: 0.3, breaks: 0, heap: 1, pressure: [jit(1.3), 1.15, 0.9, 0.5, 0.2], attackDeg: 45, speed: 0.6 });
      }
      // Low-relief texture: light, broken and partly starved, catching on what is below.
      return shape({ primitive: 'scumble', gap: 0.8, load: 0.45, press: 0, engage: 0.75 * vary + 0.15, taper: [0, 0], taperMin: 0.25, breaks: 0.22 + 0.25 * smoothstep((D - 0.45) / 1.2), heap: 0.25, pressure: [0.45, jit(0.6), 0.55, 0.5, 0.3], attackDeg: 15, speed: 1.8 });
    }
    const accent = R > 0.6 && lightness > 0.62 && h4 < 0.35;
    if (accent) {
      return shape({ primitive: 'accent', gap: (0.85 + 0.4 * R) * 1.3, load: 1.6 * pick, press: 0, engage: 1, taper: [0, 0], taperMin: 0.5, breaks: 0, heap: 1.4, pressure: [0.9, jit(1.25), 1.35, 1.3, 1.15], attackDeg: 35, speed: 0.8 });
    }
    if (C > 0.5 && L.widthMm <= 6.5) {
      // Fine coherent structure: a comma-shaped mark, narrow at both ends.
      return shape({ primitive: 'mark', gap: 0.85 + 0.4 * R, load: pick, press: 0, engage: 1, taper: [0, 0], taperMin: 0.12, breaks: 0, heap: 0.35 + 0.3 * S, pressure: [0.15, jit(0.85 + 0.3 * R), 1 + 0.2 * R, 0.75, 0.12], attackDeg: 30 + 15 * h4, speed: 1.2 });
    }
    // A broad plane: square ends; pressure at the lift (and so the heap) follows the area's relief.
    return shape({ primitive: 'plane', gap: 0.6 + 0.65 * R, load: pick, press: 0.04 * F, engage: 0.12 * vary + 0.88, taper: [0, 0], taperMin: 0.5, breaks: 0, heap: 0.2 + 0.75 * R, pressure: [0.55, 1, jit(1 + 0.25 * R), 0.95, 0.3 + 0.75 * R * R], attackDeg: 22 + 16 * h4, speed: 1 });
  }

  /**
   * Width of the feature under each of n points along a path, as a share of the blade: how far the
   * stroke's colour extends either side before it changes (after Im2Oil's stroke-extent search).
   */
  private widthRatios(pts: number[], W: number, ref: Grid, col: number[], tol: number, n: number): number[] {
    const out: number[] = [], np = pts.length / 2, step = 0.5;
    for (let q = 0; q < n; q++) {
      const i = Math.min(np - 1, Math.round(q / (n - 1) * (np - 1))) * 2;
      const j = Math.min(pts.length - 2, i + 2), k = Math.max(0, i - 2);
      let tx = pts[j] - pts[k], ty = pts[j + 1] - pts[k + 1];
      const tl = Math.sqrt(tx * tx + ty * ty) || 1; tx /= tl; ty /= tl;
      let ext = 0;
      for (const sg of [1, -1]) {
        let r = 0;
        while (r < W * 0.6 && diffAt(ref, pts[i] - ty * sg * (r + step), pts[i + 1] + tx * sg * (r + step), col) < tol) r += step;
        ext += r;
      }
      out.push(ext / W);
    }
    return out;
  }

  /**
   * Seeds for a contour layer: strokes along silhouettes, centred half a blade to one side, so the
   * blade's edge lies on the silhouette. The side painted is the more uniform one (usually the
   * background), the way a painter cuts in around a shape.
   */
  private seedContours(l: number, W: number, ref: Grid, flow: Grid, err: Float64Array, covered: Uint8Array, accepted: Traced[], st: LayerStats, cosTurn: number): void {
    const L = this.s.layers[l], { gw, gh, cell } = this, seed = this.s.seed, M = this.maps, S = M.silhouette;
    const step = Math.max(2, Math.floor(L.spacing * W + 0.5));
    const cands: { x: number; y: number; e: number; tie: number }[] = [];
    for (let by = 0; by < gh; by += step) for (let bx = 0; bx < gw; bx += step) {
      let best = -1, bestS = 0.5;
      for (let y = by; y < by + step && y < gh; y++) for (let x = bx; x < bx + step && x < gw; x++) if (S[y * gw + x] > bestS) { bestS = S[y * gw + x]; best = y * gw + x; }
      if (best >= 0) cands.push({ x: best % gw, y: Math.floor(best / gw), e: bestS, tie: hash(seed, l * 1009 + 77, best) });
    }
    cands.sort((a, b) => b.e - a.e || a.tie - b.tie || a.y - b.y || a.x - b.x);
    const h = W * STEP, minLen = L.minLenMm / cell, maxLen = L.maxLenMm / cell;
    const d = new Float64Array(2), m = new Float64Array(2);
    for (const c of cands) {
      if (covered[c.y * gw + c.x]) continue;
      st.seeds++;
      // Follow the silhouette both ways while it stays strong.
      const x0 = c.x + 0.5, y0 = c.y + 0.5;
      directionAt(flow, x0 - 0.5, y0 - 0.5, 0, 0, d);
      const d0x = d[0], d0y = d[1];
      const sides: number[][] = [[], []], head = [[x0, y0, d0x, d0y], [x0, y0, -d0x, -d0y]], alive = [true, true];
      let len = 0;
      while ((alive[0] || alive[1]) && len < maxLen) for (let sIdx = 0; sIdx < 2 && len < maxLen; sIdx++) {
        if (!alive[sIdx]) continue;
        const [px, py, dx, dy] = head[sIdx];
        directionAt(flow, px - 0.5, py - 0.5, dx, dy, d);
        directionAt(flow, px + d[0] * h * 0.5 - 0.5, py + d[1] * h * 0.5 - 0.5, d[0], d[1], m);
        if (m[0] * (sIdx ? -d0x : d0x) + m[1] * (sIdx ? -d0y : d0y) < cosTurn) { alive[sIdx] = false; continue; }
        const nx = px + m[0] * h, ny = py + m[1] * h;
        if (nx < 0 || ny < 0 || nx > gw || ny > gh || mapAt(S, gw, gh, nx, ny) < 0.25) { alive[sIdx] = false; continue; }
        sides[sIdx].push(nx, ny); head[sIdx] = [nx, ny, m[0], m[1]]; len += h;
      }
      if (len < minLen) { st.tooShort++; continue; }
      const edge: number[] = [];
      for (let i = sides[1].length - 2; i >= 0; i -= 2) edge.push(sides[1][i], sides[1][i + 1]);
      edge.push(x0, y0);
      for (let i = 0; i < sides[0].length; i += 2) edge.push(sides[0][i], sides[0][i + 1]);
      // Normals along the edge, and how uniform each side is.
      const normals: number[] = [], spread = [0, 0], mean = [[0, 0, 0], [0, 0, 0]];
      const np = edge.length / 2;
      for (let i = 0; i < edge.length; i += 2) {
        const j = Math.min(edge.length - 2, i + 2), k = Math.max(0, i - 2);
        let tx = edge[j] - edge[k], ty = edge[j + 1] - edge[k + 1];
        const tl = Math.sqrt(tx * tx + ty * ty) || 1; tx /= tl; ty /= tl;
        normals.push(-ty, tx);
        for (let side = 0; side < 2; side++) {
          const sg = side ? -1 : 1;
          for (let q = 0; q < 3; q++) mean[side][q] += sampleE(ref, edge[i] - ty * sg * W * 0.6, edge[i + 1] + tx * sg * W * 0.6, q) / np;
        }
      }
      for (let i = 0, q = 0; i < edge.length; i += 2, q += 2) for (let side = 0; side < 2; side++) {
        const sg = side ? -1 : 1, ex = normals[q] * sg, ey = normals[q + 1] * sg;
        spread[side] += diffAt(ref, edge[i] + ex * W * 0.6, edge[i + 1] + ey * W * 0.6, mean[side]) + diffAt(ref, edge[i] + ex * W * 1.1, edge[i + 1] + ey * W * 1.1, mean[side]);
      }
      const side = spread[0] < spread[1] || (spread[0] === spread[1] && c.tie < 0.5) ? 0 : 1, sg = side ? -1 : 1;
      // The blade's centre half a width into that side, so its edge runs along the silhouette.
      const pts: number[] = [];
      for (let i = 0, q = 0; i < edge.length; i += 2, q += 2) pts.push(edge[i] + normals[q] * sg * W * 0.5, edge[i + 1] + normals[q + 1] * sg * W * 0.5);
      const col = [0, 0, 0], samples: number[] = [];
      for (let i = 0, q = 0; i < edge.length; i += 2, q += 2) for (const o of [0.25, 0.5, 0.75]) {
        const sx = edge[i] + normals[q] * sg * W * o, sy = edge[i + 1] + normals[q + 1] * sg * W * o;
        const v = [sampleE(ref, sx, sy, 0), sampleE(ref, sx, sy, 1), sampleE(ref, sx, sy, 2)];
        samples.push(...v);
        for (let k = 0; k < 3; k++) col[k] += v[k];
      }
      for (let k = 0; k < 3; k++) col[k] /= samples.length / 3;
      let far = 0, farD = -1;
      for (let i = 0; i < samples.length; i += 3) { const dd = dist(samples, i, col, 0); if (dd > farD) { farD = dd; far = i; } }
      const t: Traced = { pts, lab: col, alt: [samples[far], samples[far + 1], samples[far + 2]], spread: farD, len, cells: [] };
      const fp = this.footprint(pts, W);
      let cov = 0, before = 0, after = 0;
      for (const i of fp) { cov += covered[i]; before += err[i]; after += dist(ref.data, i * 3, col, 0); }
      if (cov > fp.length * L.coverSkip) { st.overlapping++; continue; }
      if (after >= before * 0.95) { st.noGain++; continue; }
      for (const i of fp) covered[i] = 1;
      t.cells = fp;
      accepted.push(t); st.accepted++;
    }
  }

  private toStroke(t: Traced, l: number, index: number, W: number): PlannedStroke {
    const L = this.s.layers[l], s = this.s, { cell } = this, seed = s.seed;
    let pts = t.pts;
    // Travel toward the end where the colour carries on, so the terminal heap lands on like paint.
    const n = pts.length;
    const endScore = (i: number, j: number) => {
      const dx = pts[i] - pts[j], dy = pts[i + 1] - pts[j + 1], dl = Math.sqrt(dx * dx + dy * dy) || 1;
      const ahead = (W * 0.8) / dl;
      return diffAt(this.lab, pts[i] + dx * ahead, pts[i + 1] + dy * ahead, t.lab);
    };
    const forward = n < 4 ? true : endScore(n - 2, n - 4) <= endScore(0, 2) + (hash(seed, index, 5) - 0.5) * 0.01;
    if (!forward) { const r: number[] = []; for (let i = n - 2; i >= 0; i -= 2) r.push(pts[i], pts[i + 1]); pts = r; }
    const footprint = simplify(pts, turnOf(pts) > 0.5 ? 8 : 6).map(([x, y]) => [x * cell, y * cell] as Vec2);
    // The path runs past the footprint by the tail, along the last direction.
    const [ax, ay] = footprint[footprint.length - 2], [bx, by] = footprint[footprint.length - 1];
    const dl = Math.sqrt((bx - ax) * (bx - ax) + (by - ay) * (by - ay)) || 1;
    const points = footprint.slice(0, -1).concat([[bx, by], [bx + (bx - ax) / dl * s.tailMm, by + (by - ay) / dl * s.tailMm]]);
    // Re-space so Catmull-Rom has evenly spaced control points.
    const path = simplify(points.flatMap((p) => [p[0], p[1]]), Math.min(footprint.length, points.length));
    const lengthMm = t.len * cell + s.tailMm;
    const lightness = t.lab[0] < 0 ? 0 : t.lab[0] > 1 ? 1 : t.lab[0];
    const widthMm = t.size !== undefined ? L.sizesMm![t.size] : L.widthMm, nodes = t.size !== undefined ? pressNodes(widthMm) : L.nodes, pitch = widthMm / nodes;
    const h1 = hash(seed, index, 11), h2 = hash(seed, index, 12), h3 = hash(seed, index, 14), h4 = hash(seed, index, 15);
    const shape = this.choosePrimitive(t, L, lightness, h3, h4);
    // Narrow features narrow the mark: pressure follows the measured width along the path.
    let pressure = shape.pressure;
    if ((shape.primitive === 'mark' || shape.primitive === 'scumble') && !t.feature) {
      const ratios = this.widthRatios(pts, W, this.lab, t.lab, L.tolerance * 1.4, pressure.length);
      pressure = pressure.map((p, q) => p * clamp((ratios[q] - 0.2) / 0.8, 0.3, 1.15));
    }
    pressure = pressure.map((p) => Math.round(p * 1000) / 1000);
    const thick = s.look === 'oil' && L.tool === 'knife' && s.thickness !== 1 ? s.thickness : 1;
    const gap = L.gapMm * (1 - s.lightBoost * 0.5 + s.lightBoost * lightness) * shape.gap * thick;
    const minLoad = s.minLoad * shape.load;
    return {
      index, layer: l, tool: this.toolBase[l] + (t.size ?? 0) * FAMILIES + colourFamily(t.lab), points: path, footprint,
      widthMm, lengthMm,
      primary: labToSrgb(this.paintLab(t, L), s.chroma), secondary: labToSrgb(mix3(this.paintLab(t, L), t.alt, 0.7), s.chroma),
      ...(this.profRef && L.tool === 'knife' ? { profile: this.profile(pts, W, t.lab).map((c) => labToSrgb(c, s.chroma)), mix: MIX[shape.primitive] } : {}),
      secondaryFraction: 0.12 + 0.3 * clamp01(t.spread / (L.tolerance * 1.5)),
      volumePerNode: Math.max(pitch * gap * lengthMm * s.loadFactor, yieldVolume(L.tool, pitch, lengthMm) * minLoad) * (0.9 + 0.2 * h1),
      gapMm: gap, pressMm: shape.press, wipe: 0.9 + 0.08 * h2,
      primitive: shape.primitive, engage: shape.engage, taper: shape.taper, taperMin: shape.taperMin, breaks: shape.breaks,
      heap: s.look === 'oil' ? 1 : shape.heap,
      edgeFlaws: s.look === 'oil' ? EDGE_FLAWS[shape.primitive] : 1,
      pressure, attackDeg: Math.round(shape.attackDeg * 10) / 10, speed: shape.speed,
      deposition: s.look === 'oil' ? 'physical' : 'locked',
      // Knife paint is stiff; the thinned bristle underpainting stays fluid.
      ...(s.look === 'oil' && s.stiffness > 0 && L.tool === 'knife' ? { stiffness: clamp01(s.stiffness) } : {}),
      seed: (Math.floor(hash(seed, index, 13) * 2147483647) | 0) + 1,
    };
  }
}

interface Traced {
  pts: number[]; lab: number[]; alt: number[]; spread: number; len: number; cells: number[];
  /** Presses: blade width in cells and index into the layer's sizes. */
  w?: number; size?: number; press?: boolean;
  /** A press on a value band of a smooth form: a facet, lifted lightly so it leaves no crusty heap. */
  plane?: boolean;
  /** Seeded in a freed narrow part; a dedicated mark for a small feature. Both painted last. */
  thin?: boolean; feature?: boolean;
  /** Features: the share of the blade in contact, so the mark is as wide as the feature. */
  engage?: number;
}

const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);
const clamp = (x: number, a: number, b: number) => (x < a ? a : x > b ? b : x);
/** Total turning of a polyline, as 1 - cos of the angle between its first and last segments. */
function turnOf(pts: number[]): number {
  const n = pts.length;
  if (n < 6) return 0;
  const ax = pts[2] - pts[0], ay = pts[3] - pts[1], bx = pts[n - 2] - pts[n - 4], by = pts[n - 1] - pts[n - 3];
  const la = Math.sqrt(ax * ax + ay * ay), lb = Math.sqrt(bx * bx + by * by);
  return la > 0 && lb > 0 ? 1 - (ax * bx + ay * by) / (la * lb) : 0;
}
const smoothstep = (x: number) => { const u = clamp01(x); return u * u * (3 - 2 * u); };
function dist(a: ArrayLike<number>, i: number, b: ArrayLike<number>, j: number): number {
  const d0 = a[i] - b[j], d1 = a[i + 1] - b[j + 1], d2 = a[i + 2] - b[j + 2];
  return Math.sqrt(d0 * d0 + d1 * d1 + d2 * d2);
}
/**
 * Planner coordinates are cell-edge based (cell i spans [i, i + 1), so its centre is i + 0.5,
 * matching millimetres / analysisMm). The grid sampler is centre based, hence the half-cell shift.
 */
const sampleE = (g: Grid, x: number, y: number, k: number) => sample(g, x - 0.5, y - 0.5, k);
function diffAt(g: Grid, x: number, y: number, c: ArrayLike<number>): number {
  const d0 = sampleE(g, x, y, 0) - c[0], d1 = sampleE(g, x, y, 1) - c[1], d2 = sampleE(g, x, y, 2) - c[2];
  return Math.sqrt(d0 * d0 + d1 * d1 + d2 * d2);
}
const mix3 = (a: number[], b: number[], t: number) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

/** cos of an angle in degrees, by its Taylor series (no Math.cos). */
function cosDeg(deg: number): number {
  const x = deg * 3.141592653589793 / 180, x2 = x * x;
  let term = 1, sum = 1;
  for (let k = 1; k <= 10; k++) { term *= -x2 / ((2 * k - 1) * (2 * k)); sum += term; }
  return sum;
}

/** OKLab -> linear RGB, clamped to 0-1. */
export function labToLinear(c: ArrayLike<number>): [number, number, number] {
  const L = c[0], a = c[1], b = c[2];
  const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = L - 0.0894841775 * a - 1.2914855480 * b;
  const l = l_ * l_ * l_, m = m_ * m_ * m_, s = s_ * s_ * s_;
  return [
    clamp01(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
    clamp01(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
    clamp01(-0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s),
  ];
}
function labToSrgb(c: number[], chroma: number): RGB {
  const [r, g, b] = labToLinear([c[0], c[1] * chroma, c[2] * chroma]);
  return [linearToSrgb(r), linearToSrgb(g), linearToSrgb(b)];
}
export { oklab };

/** Resample a polyline (flat x,y list) to k points evenly spaced along its length. */
function simplify(pts: number[], k: number): Vec2[] {
  const n = pts.length / 2;
  if (n <= 1) return [[pts[0], pts[1]]];
  const cum = [0];
  for (let i = 1; i < n; i++) { const dx = pts[i * 2] - pts[i * 2 - 2], dy = pts[i * 2 + 1] - pts[i * 2 - 1]; cum.push(cum[i - 1] + Math.sqrt(dx * dx + dy * dy)); }
  const total = cum[n - 1], out: Vec2[] = [];
  let j = 0;
  for (let q = 0; q < k; q++) {
    const target = total * q / (k - 1);
    while (j < n - 2 && cum[j + 1] < target) j++;
    const seg = cum[j + 1] - cum[j], f = seg > 0 ? (target - cum[j]) / seg : 0;
    out.push([pts[j * 2] + (pts[j * 2 + 2] - pts[j * 2]) * f, pts[j * 2 + 1] + (pts[j * 2 + 3] - pts[j * 2 + 1]) * f]);
  }
  return out;
}

/**
 * A direction field that also follows forms: image edges weighted by their coherence, the form's
 * principal axis weighted by its elongation, and the form's contour near its boundary (within
 * about a blade width). With `shade` (shadingField), also the iso-luminance direction, weighted by
 * the shading cue and down where colour edges are coherent. All in doubled-angle form, so opposite
 * signs agree.
 */
function formFlow(flow: Grid, level: FormLevel, W: number, axisWeight: number, shade: Grid | null = null, shadeGain = 0): Grid {
  const n = flow.w * flow.h, out = makeGrid(flow.w, flow.h, 4);
  for (let i = 0; i < n; i++) {
    const f = level.label[i], coh = flow.data[i * 4 + 2];
    const wImg = 0.25 + coh, wAxis = axisWeight * level.elongation[f] * level.elongation[f] * 1.5;
    const wCont = 1.2 * (1 - smoothstep(level.inset[i] / (1.2 * W)));
    let c = flow.data[i * 4] * wImg + level.axis[f * 2] * wAxis + level.contour[i * 2] * wCont;
    let s = flow.data[i * 4 + 1] * wImg + level.axis[f * 2 + 1] * wAxis + level.contour[i * 2 + 1] * wCont;
    if (shade && shadeGain > 0) {
      // How the form turns in the light: strongest on smooth forms whose colour edges are weak.
      const wShade = shadeGain * shade.data[i * 4 + 2] * (1 - smoothstep((coh - 0.3) / 0.4));
      c += shade.data[i * 4] * wShade; s += shade.data[i * 4 + 1] * wShade;
    }
    const m = Math.sqrt(c * c + s * s);
    if (m > 1e-12) { c /= m; s /= m; } else { c = flow.data[i * 4]; s = flow.data[i * 4 + 1]; }
    out.data[i * 4] = c; out.data[i * 4 + 1] = s; out.data[i * 4 + 2] = coh; out.data[i * 4 + 3] = flow.data[i * 4 + 3];
  }
  return out;
}

/** Nodes across a press knife of width w mm (as the layers: about ten per mm, 48 to 128). */
function pressNodes(w: number): number { return Math.max(48, Math.min(128, Math.round(w * 10))); }

/**
 * Knife scale from the image itself: the share of the canvas with structure at painting scale
 * (detail map above 0.45). A busy scene (a lake with trees and rock, a glass facade) keeps the
 * knives as they are; a close-up with few, large forms (a face, a flower) gets knives up to 2.2x
 * as big, so its forms are laid in a few broad planes. (STRUCTURE_REF / share)^2, rounded.
 */
export function knifeScale(maps: PaintingMaps): number {
  const n = maps.w * maps.h;
  let c = 0;
  for (let i = 0; i < n; i++) if (maps.detail[i] > 0.45) c++;
  const share = c / n, r = share > 1e-6 ? STRUCTURE_REF / share : 2;
  return Math.round(clamp(r * r, 1, 2.2) * 100) / 100;
}

/** The layers with a press layer after the first middle-level (masses) layer, its knives sized from that layer's. */
function withPresses(layers: LayerSpec[]): LayerSpec[] {
  let at = layers.findIndex((L) => L.formLevel === 1);
  at = at < 0 ? Math.min(2, layers.length) : at + 1;
  const sizes = PRESS_REL.map((r) => Math.round(r * layers[at - 1].widthMm * 100) / 100);
  const press: LayerSpec = {
    name: 'presses', tool: 'knife', widthMm: sizes[2], nodes: pressNodes(sizes[2]), minLenMm: sizes[0], maxLenMm: sizes[sizes.length - 1] * PRESS_ASPECT,
    spacing: 1, threshold: 0.03, tolerance: 0.07, blur: 0.3, flowBlur: 0.6, gapMm: 0.3, maxTurnDeg: 0, coverSkip: 0.5, passes: 1,
    sideWeight: 0.5, detail: 0, kind: 'press', formLevel: 2, sizesMm: sizes,
  };
  return [...layers.slice(0, at), press, ...layers.slice(at)];
}

/**
 * Knife scaling graded by size: the broad knives (the masses knife and wider) take the full scale,
 * the finest keep their size, those between take a share. A close-up gets broad planes and still
 * has a fine knife for an eye or a stem.
 */
function scaleGraded(layers: LayerSpec[], k: number): LayerSpec[] {
  const knives = layers.filter((L) => L.tool === 'knife');
  const wMin = Math.min(...knives.map((L) => L.widthMm)), ref = layers.find((L) => L.formLevel === 1)?.widthMm ?? Math.max(...knives.map((L) => L.widthMm));
  return layers.map((L) => {
    const share = ref > wMin ? clamp((L.widthMm - wMin) / (ref - wMin), 0, 1) : 1, f = 1 + (k - 1) * share;
    // Growing only, so no floors on the lengths (scaleLayers has them for shrinking).
    return f === 1 ? L : { ...L, widthMm: L.widthMm * f, minLenMm: L.minLenMm * f, maxLenMm: L.maxLenMm * f };
  });
}
