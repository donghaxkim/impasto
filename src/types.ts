export type Vec2 = readonly [number, number];
export type RGB = readonly [number, number, number];

export interface Stroke {
  id: string;
  points: Vec2[];
  width: number;
  /** Linear scene-independent sRGB channel values in the range 0–1. */
  color: RGB;
  brush: 'flat' | 'filbert';
  seed: number;
  /** Impasto height in millimetres. */
  height: number;
  roughness: number;
  /** Pigment coverage for thin, scumbled, or partially mixed paint films. */
  opacity?: number;
  /** Optional second pigment deposited as narrow, along-stroke ribbons. */
  secondaryColor?: RGB;
  /** Strength of the secondary pigment ribbon, from 0 (off) to 1 (full color). */
  secondaryMix?: number;
  /** Cross-section of the deposited paint, independent of the tool shape. */
  profile?: 'knife' | 'loaded-filbert' | 'dry-scumble';
  /** Amount of squeezed paint accumulated at the stroke perimeter (0–1). */
  edgeRidge?: number;
  /** How paint terminates at the end of a retained stroke. */
  taperEnd?: 'blunt' | 'lifted' | 'berm';
}

export interface PaintingDocument {
  width: number;
  height: number;
  canvasMm: number;
  ground: RGB;
  strokes: Stroke[];
}

export interface RenderSettings {
  lightAzimuth: number;
  lightElevation: number;
  relief: number;
  roughness: number;
  exposure: number;
  view: 'paint' | 'color' | 'height' | 'normal';
}
