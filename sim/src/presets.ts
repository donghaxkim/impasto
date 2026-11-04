/**
 * Named presets: the engineer flags of PlanSettings and LightSettings (look, restraint, presses,
 * autoScale, deferThin, formSizesMm, streaks, underTone, layers, ...) collapsed into three looks.
 *
 * Every preset is a small set of overrides spread over the library's own defaults
 * (DEFAULT_SETTINGS, DEFAULT_LIGHT) when it is resolved, never a copy of their numbers, so changes
 * to the planner's defaults flow through to the presets.
 */
import { DEFAULT_SETTINGS, type PlanSettings } from './planner.ts';
import { DEFAULT_LIGHT, type LightSettings } from './relight.ts';

export type PresetName = 'oil' | 'locked' | 'smooth';
export const PRESET_NAMES: readonly PresetName[] = ['oil', 'locked', 'smooth'];

export interface Preset {
  /** Overrides on DEFAULT_SETTINGS. */
  plan: (defaults: PlanSettings) => Partial<PlanSettings>;
  /** Overrides on DEFAULT_LIGHT. */
  light: Partial<LightSettings>;
}

export const PRESETS: Record<PresetName, Preset> = {
  /**
   * The intended look: the planner's 'oil' look with all of its defaults (shapes, presses, knife
   * scaling, restraint, streaked loads, toned underpainting) and the semi-gloss renderer.
   */
  oil: { plan: () => ({ look: 'oil' }), light: { look: 'oil' } },

  /**
   * The round-3 reference look, exactly what `npm run paint -- --look locked` produces: the
   * planner ignores shapes, presses, scaling, restraint, streaks and toning, and the renderer
   * uses the glossy reference look.
   */
  locked: { plan: () => ({ look: 'locked' }), light: { look: 'locked' } },

  /** Calmer and more blended than 'oil': broader planes, mixed loads, thinner paint, softer light. */
  smooth: {
    plan: (d) => ({
      look: 'oil',
      // More restraint (0.5 in oil): the form-bound layers leave the inside of a shape alone more,
      // so it stays one broad plane and detail gathers only at edges.
      restraint: Math.min(1, d.restraint + 0.35),
      // One colour per knife instead of streaks picked up from across the path: blended loads.
      streaks: false,
      // Lights laid less thick than darks (lightBoost 0.5 in oil), so relief evens out.
      lightBoost: d.lightBoost * 0.5,
      // A little less saturation than the photo-boosted default.
      chroma: 1 + (d.chroma - 1) * 0.5,
      layers: d.layers.map((l) => {
        // Thinner paint everywhere except the underpainting: lower relief, smaller berms and heaps.
        const thin = l.tool === 'knife' ? { ...l, gapMm: l.gapMm * 0.8 } : l;
        // Fewer, only the clearest accents and detail marks: a higher error threshold to seed one.
        if (l.name === 'accents') return { ...thin, threshold: l.threshold * 1.6 };
        if (l.name === 'detail') return { ...thin, threshold: l.threshold * 1.25 };
        return thin;
      }),
    }),
    // Gentler light: the lamp higher (30 degrees by default), so shadows are shorter; shallower
    // cast shadows, less height in the shading, and a weaker glow on the brightest highlights.
    light: { look: 'oil', elevation: 40, occlusion: 0.7, relief: 0.8, glow: 0.5 },
  },
};

/** Plan and light settings for a preset, with optional overrides on top (both unstable). */
export function resolvePreset(name: PresetName, plan: Partial<PlanSettings> = {}, light: Partial<LightSettings> = {}): { settings: PlanSettings; light: LightSettings } {
  const p = PRESETS[name];
  return {
    settings: { ...DEFAULT_SETTINGS, ...p.plan(DEFAULT_SETTINGS), ...plan },
    light: { ...DEFAULT_LIGHT, ...p.light, ...light },
  };
}
