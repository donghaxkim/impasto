import type { PaintingDocument, RGB, Stroke, Vec2 } from './types';

const C = {
  linen: [0.86, 0.81, 0.71] as RGB,
  deepTeal: [0.105, 0.205, 0.205] as RGB,
  teal: [0.20, 0.36, 0.32] as RGB,
  sage: [0.39, 0.48, 0.36] as RGB,
  olive: [0.56, 0.47, 0.27] as RGB,
  ochre: [0.83, 0.55, 0.24] as RGB,
  paleOchre: [0.94, 0.75, 0.41] as RGB,
  coral: [0.83, 0.30, 0.23] as RGB,
  paleCoral: [0.94, 0.53, 0.38] as RGB,
  cream: [0.97, 0.88, 0.68] as RGB,
  blue: [0.22, 0.39, 0.54] as RGB,
  paleBlue: [0.48, 0.62, 0.67] as RGB,
} as const;

function mark(
  id: string,
  points: Vec2[],
  width: number,
  color: RGB,
  brush: Stroke['brush'],
  seed: number,
  height: number,
  roughness = 0.45,
): Stroke {
  return { id, points, width, color, brush, seed, height, roughness };
}

/** A deliberately authored, layered abstract botanical still life. */
export function createDemoDocument(): PaintingDocument {
  const strokes: Stroke[] = [
    // Quiet ground and the broad, slightly rising tabletop.
    mark('table-shadow', [[0, 653], [235, 633], [535, 648], [810, 623], [1000, 637]], 158, C.olive, 'flat', 101, 0.95),
    mark('table-light', [[7, 706], [256, 677], [558, 692], [838, 660], [1002, 674]], 83, C.paleOchre, 'flat', 102, 0.85),

    // Tall vase: layered, overlapping blue-green ribbons make a single broad vessel.
    mark('vase-body-left', [[423, 454], [437, 510], [430, 579], [449, 640], [475, 684]], 65, C.deepTeal, 'filbert', 201, 2.8),
    mark('vase-body-center', [[473, 451], [492, 501], [485, 560], [493, 623], [510, 681]], 71, C.teal, 'filbert', 202, 3.2),
    mark('vase-body-right', [[532, 454], [548, 510], [547, 569], [534, 629], [539, 682]], 62, C.deepTeal, 'filbert', 203, 2.7),
    mark('vase-rim', [[421, 455], [466, 440], [517, 443], [558, 456]], 27, C.paleBlue, 'flat', 204, 1.6),
    mark('vase-glaze', [[461, 493], [475, 546], [472, 598], [492, 642]], 14, C.paleBlue, 'filbert', 205, 0.8),
    mark('vase-lip-shadow', [[430, 469], [469, 478], [516, 474], [548, 468]], 12, C.deepTeal, 'flat', 206, 0.7),

    // Stems rise through the arrangement, some disappearing behind petals.
    mark('stem-left', [[480, 454], [431, 410], [396, 352], [354, 300]], 12, C.deepTeal, 'filbert', 301, 1.2),
    mark('stem-middle', [[496, 449], [512, 395], [526, 330], [545, 266]], 13, C.deepTeal, 'filbert', 302, 1.3),
    mark('stem-right', [[514, 452], [579, 412], [633, 358], [675, 311]], 11, C.deepTeal, 'filbert', 303, 1.15),

    // Broad leaves pull the eye across the vase and balance the flower heads.
    mark('leaf-left-low', [[468, 522], [417, 509], [368, 478], [337, 445]], 38, C.teal, 'filbert', 401, 2.1),
    mark('leaf-left-ridge', [[420, 507], [391, 479], [366, 457]], 7, C.sage, 'flat', 402, 0.7),
    mark('leaf-left-high', [[456, 469], [407, 446], [379, 408], [362, 378]], 31, C.sage, 'filbert', 403, 1.9),
    mark('leaf-left-high-vein', [[407, 444], [390, 420], [370, 392]], 6, C.paleOchre, 'flat', 404, 0.6),
    mark('leaf-right-low', [[537, 524], [593, 514], [645, 485], [680, 453]], 40, C.sage, 'filbert', 405, 2.2),
    mark('leaf-right-ridge', [[591, 512], [631, 488], [663, 466]], 7, C.paleOchre, 'flat', 406, 0.7),
    mark('leaf-right-high', [[560, 465], [601, 436], [624, 396], [644, 369]], 29, C.teal, 'filbert', 407, 1.9),
    mark('leaf-upper', [[520, 419], [493, 385], [478, 343], [475, 314]], 28, C.sage, 'filbert', 408, 1.7),

    // Five open, imperfect blooms. Petals are laid as distinct broad dabs.
    mark('bloom-left-petal-a', [[352, 291], [326, 271], [305, 242]], 31, C.coral, 'filbert', 501, 2.4),
    mark('bloom-left-petal-b', [[350, 288], [314, 290], [285, 280]], 27, C.paleCoral, 'filbert', 502, 2.0),
    mark('bloom-left-petal-c', [[355, 287], [362, 254], [354, 229]], 28, C.coral, 'filbert', 503, 2.3),
    mark('bloom-left-center', [[345, 282], [352, 282]], 22, C.cream, 'flat', 504, 1.8),

    mark('bloom-top-petal-a', [[543, 264], [516, 239], [506, 210]], 30, C.paleCoral, 'filbert', 511, 2.2),
    mark('bloom-top-petal-b', [[544, 263], [565, 231], [589, 221]], 29, C.coral, 'filbert', 512, 2.6),
    mark('bloom-top-petal-c', [[546, 265], [547, 225], [536, 199]], 26, C.paleOchre, 'filbert', 513, 2.0),
    mark('bloom-top-center', [[540, 260], [548, 265]], 19, C.cream, 'flat', 514, 1.7),

    mark('bloom-right-petal-a', [[674, 306], [679, 269], [698, 245]], 29, C.paleOchre, 'filbert', 521, 2.2),
    mark('bloom-right-petal-b', [[678, 307], [712, 295], [739, 302]], 27, C.paleCoral, 'filbert', 522, 2.0),
    mark('bloom-right-petal-c', [[674, 308], [698, 333], [724, 341]], 26, C.coral, 'filbert', 523, 2.2),
    mark('bloom-right-center', [[671, 301], [678, 309]], 18, C.cream, 'flat', 524, 1.6),

    // Two fruit-like masses in front of the vase, painted with curved, broad marks.
    mark('fruit-left-shadow', [[226, 588], [251, 542], [298, 532], [335, 560], [342, 601]], 49, C.coral, 'filbert', 601, 2.4),
    mark('fruit-left-light', [[253, 558], [282, 548], [308, 558]], 17, C.paleCoral, 'filbert', 602, 1.4),
    mark('fruit-left-stem', [[286, 543], [292, 527]], 8, C.deepTeal, 'flat', 603, 0.6),
    mark('fruit-right-shadow', [[661, 581], [689, 541], [732, 537], [767, 565], [766, 604]], 47, C.ochre, 'filbert', 611, 2.4),
    mark('fruit-right-light', [[694, 558], [720, 547], [747, 560]], 16, C.paleOchre, 'filbert', 612, 1.3),
    mark('fruit-right-stem', [[720, 542], [718, 526]], 8, C.deepTeal, 'flat', 613, 0.6),

    // A few decisive foreground accents keep the composition loose and tactile.
    mark('foreground-blue', [[284, 719], [371, 706], [427, 713]], 18, C.blue, 'flat', 701, 1.1),
    mark('foreground-cream', [[588, 719], [676, 700], [757, 704]], 15, C.cream, 'filbert', 702, 1.1),
  ];

  return { width: 1000, height: 800, canvasMm: 300, ground: C.linen, strokes };
}

/**
 * Compact material/readability check split into four controlled zones:
 * equal-colour crossing, nearby non-overlapping strokes, irregular brush
 * ends, and a loaded dab with a thin accent for lighting comparison.
 */
export function createDiagnosticDocument(): PaintingDocument {
  const warmGround: RGB = [0.91, 0.86, 0.76];
  const ochre: RGB = [0.76, 0.43, 0.16];
  const coral: RGB = [0.87, 0.27, 0.18];
  const cream: RGB = [0.98, 0.88, 0.68];
  const teal: RGB = [0.105, 0.205, 0.205];
  const paleOchre: RGB = [0.94, 0.75, 0.41];
  const strokes = [
    // Q1: equal-colour crossing (top-left).
    mark('diag-base-ochre', [[-40, 150], [260, 170], [540, 160]], 160, ochre, 'flat', 801, 2.6, 0.45),
    mark('diag-cross-ochre', [[100, 30], [320, 190], [500, 350]], 120, ochre, 'filbert', 802, 3.0, 0.55),

    // Q2: nearby non-overlapping strokes with a ~30px gap (top-right).
    mark('diag-near-a', [[560, 90], [940, 110]], 70, cream, 'flat', 803, 2.6, 0.5),
    mark('diag-near-b', [[560, 190], [940, 210]], 70, coral, 'flat', 804, 2.8, 0.5),

    // Q3: irregular brush ends (bottom-left): blunt flat vs tapered filbert.
    mark('diag-flat-blunt', [[40, 480], [460, 500]], 100, teal, 'flat', 805, 2.6, 0.6),
    mark('diag-filbert-taper', [[40, 650], [460, 630]], 90, paleOchre, 'filbert', 806, 2.8, 0.6),

    // Q4: loaded dab with a thin dark accent for lighting (bottom-right).
    mark('diag-loaded-dab', [[600, 720], [780, 650], [920, 600]], 220, cream, 'filbert', 807, 4.8, 0.85),
    mark('diag-accent', [[560, 520], [720, 500], [900, 470]], 24, teal, 'flat', 808, 1.4, 0.35),
  ];
  return { width: 1000, height: 800, canvasMm: 100, ground: warmGround, strokes };
}

