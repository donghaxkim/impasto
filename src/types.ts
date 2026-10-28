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
