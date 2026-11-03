import { dpow } from './dmath.ts';
export type RGB = readonly [number, number, number];

/** Paint is stored and mixed per channel as Kubelka-Munk K/S, which is linear in volume. */
export const srgbToLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : dpow((c + 0.055) / 1.055, 2.4));
export const ksFromReflectance = (r: number) => { const R = r < 0.002 ? 0.002 : r > 0.995 ? 0.995 : r; return (1 - R) * (1 - R) / (2 * R); };
export const reflectanceFromKs = (k: number) => 1 + k - Math.sqrt(k * k + 2 * k);
export const ksFromSrgb = (c: RGB): RGB => [ksFromReflectance(srgbToLinear(c[0])), ksFromReflectance(srgbToLinear(c[1])), ksFromReflectance(srgbToLinear(c[2]))];

const LUT = new Float64Array(4097);
for (let i = 0; i <= 4096; i++) {
  const c = i / 4096;
  LUT[i] = c <= 0.0031308 ? c * 12.92 : 1.055 * dpow(c, 1 / 2.4) - 0.055;
}
export function linearToSrgb(c: number): number {
  const x = (c < 0 ? 0 : c > 1 ? 1 : c) * 4096, i = Math.floor(x), f = x - i;
  return i >= 4096 ? LUT[4096] : LUT[i] + (LUT[i + 1] - LUT[i]) * f;
}
