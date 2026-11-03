const settling = 0.88;
const pixelMm = 0.12;

const kernels = [
  { name: 'requested 0.95 mm', radiusMm: 0.95 },
  { name: 'current source 0.62 mm', radiusMm: 0.62 },
];

const wavelengths = [1.0, 1.28, 1.9, 3.0, 3.8, 5.0, 7.6, 12.0, 20.0];

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

function quantizedRadius(kernel) {
  const currentClamp = kernel.radiusMm < 0.8 ? [2, 8] : [3, 11];
  return clamp(Math.round(kernel.radiusMm / pixelMm), ...currentClamp) * pixelMm;
}

function axisGain(radiusMm, wavelengthMm) {
  const phase = 2 * Math.PI * radiusMm / wavelengthMm;
  const localMean = (2 + Math.cos(phase)) / 3;
  return 1 - settling + settling * localMean;
}

function diagonalGain(radiusMm, wavelengthMm) {
  const phase = Math.SQRT2 * 2 * Math.PI * radiusMm / wavelengthMm;
  const localMean = (1 + 2 * Math.cos(phase)) / 3;
  return 1 - settling + settling * localMean;
}

function edgeSlope(thicknessMm, bevelMm) {
  return 1.5 * thicknessMm / bevelMm;
}

console.log('## Cross-kernel gain retained by the 0.88 mix');
console.log('');
console.log('| Wavelength (mm) | 0.95 mm axis | 0.95 mm diagonal | 0.62 mm axis | 0.62 mm diagonal |');
console.log('|---:|---:|---:|---:|---:|');

for (const wavelength of wavelengths) {
  const requested = quantizedRadius(kernels[0]);
  const current = quantizedRadius(kernels[1]);
  const values = [
    axisGain(requested, wavelength),
    diagonalGain(requested, wavelength),
    axisGain(current, wavelength),
    diagonalGain(current, wavelength),
  ].map((value) => value.toFixed(3));
  console.log(`| ${wavelength.toFixed(2)} | ${values.join(' | ')} |`);
}

console.log('');
console.log('## Edge slope from the current smoothstep support');
console.log('');
console.log('| Thickness (mm) | Flat bevel 0.34 mm | Flat bevel 0.52 mm | Proposed 0.80 mm |');
console.log('|---:|---:|---:|---:|');

for (const thickness of [0.03, 1.5, 3.0, 4.7]) {
  const values = [0.34, 0.52, 0.80]
    .map((bevel) => edgeSlope(thickness, bevel).toFixed(2));
  console.log(`| ${thickness.toFixed(2)} | ${values.join(' | ')} |`);
}

console.log('');
console.log(`Effective radii after pixel quantization: requested ${quantizedRadius(kernels[0]).toFixed(2)} mm, current ${quantizedRadius(kernels[1]).toFixed(2)} mm.`);
