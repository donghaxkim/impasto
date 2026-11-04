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

export type PresetName = 'oil' | 'locked';
export const PRESET_NAMES: readonly PresetName[] = ['oil', 'locked'];

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
  // Dried paint shows no display glow (nothing on a satin coat is brighter than white for long) and
  // keeps full-strength cast shadows under its lips and slabs. The lamp starts low (15 degrees) so
  // it rakes across the relief, as dried knife work is usually shown.
  oil: { plan: () => ({ look: 'oil' }), light: { look: 'oil', glow: 0, occlusion: 0.95, elevation: 15 } },

  /**
   * The round-3 reference look, exactly what `npm run paint -- --look locked` produces: the
   * planner ignores shapes, presses, scaling, restraint, streaks and toning, and the renderer
   * uses the glossy reference look.
   */
  locked: { plan: () => ({ look: 'locked' }), light: { look: 'locked' } },
};

/** Plan and light settings for a preset, with optional overrides on top (both unstable). */
export function resolvePreset(name: PresetName, plan: Partial<PlanSettings> = {}, light: Partial<LightSettings> = {}): { settings: PlanSettings; light: LightSettings } {
  const p = PRESETS[name];
  return {
    settings: { ...DEFAULT_SETTINGS, ...p.plan(DEFAULT_SETTINGS), ...plan },
    light: { ...DEFAULT_LIGHT, ...p.light, ...light },
  };
}
