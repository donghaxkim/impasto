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
  opacity = 1,
  secondaryColor?: RGB,
  secondaryMix = 0,
  surface: Pick<Stroke, 'profile' | 'edgeRidge' | 'taperEnd'> = {},
): Stroke {
  const profile = surface.profile ?? (
    height <= 0.2 && opacity < 1
      ? 'dry-scumble'
      : brush === 'flat' ? 'knife' : 'loaded-filbert'
  );
  return {
    id, points, width, color, brush, seed, height, roughness, opacity,
    profile,
    edgeRidge: surface.edgeRidge ?? (profile === 'dry-scumble' ? 0.12 : profile === 'knife' ? 0.72 : 0.48),
    taperEnd: surface.taperEnd ?? (profile === 'knife' ? 'blunt' : 'lifted'),
    ...(secondaryColor ? { secondaryColor, secondaryMix } : {}),
    ...surface,
  };
}

/** A deliberately authored, layered abstract botanical still life. */
export function createDemoDocument(): PaintingDocument {
  const groundWarm: RGB = [0.83, 0.77, 0.67];
  const groundLight: RGB = [0.87, 0.81, 0.71];
  const groundCool: RGB = [0.79, 0.78, 0.69];
  const groundOchre: RGB = [0.84, 0.77, 0.65];
  const strokes: Stroke[] = [
    // Broad, shallow underpainting covers the linen with overlapping brush
    // drags. Their warm, close-valued pigments keep the ground tactile while
    // leaving the higher-relief still life in front as the focal point.
    mark('ground-upper', [[-200, 28], [120, 8], [430, 38], [760, 12], [1200, 24]], 310, groundWarm, 'flat', 11, 0.18, 0.84),
    mark('ground-upper-middle', [[-200, 184], [120, 210], [430, 172], [760, 207], [1200, 178]], 310, groundLight, 'filbert', 12, 0.17, 0.85),
    mark('ground-middle', [[-200, 351], [120, 326], [430, 365], [760, 330], [1200, 348]], 310, groundCool, 'flat', 13, 0.18, 0.82),
    mark('ground-lower-middle', [[-200, 520], [120, 550], [430, 507], [760, 541], [1200, 512]], 310, groundOchre, 'filbert', 14, 0.16, 0.86),
    mark('ground-lower', [[-200, 690], [120, 660], [430, 708], [760, 676], [1200, 696]], 310, groundWarm, 'flat', 15, 0.17, 0.84),
    // Crosswise scumbles interrupt the long ground drags and share their same
    // pigment and relief pipeline; they stay thin enough to sit beneath forms.
    mark('ground-cross-cool', [[-120, 553], [170, 438], [470, 353], [770, 239], [1120, 122]], 176, groundCool, 'filbert', 16, 0.13, 0.86),
    mark('ground-cross-light', [[-160, 115], [130, 207], [430, 302], [760, 414], [1160, 526]], 148, groundLight, 'flat', 17, 0.12, 0.87),
    // Smaller dry passes interrupt the broad ground bands. They use a thin,
    // translucent deposit so the linen and neighboring underpainting remain
    // visible through broken brushwork rather than a single filled backdrop.
    mark('ground-scumble-upper-left', [[42, 82], [150, 95], [274, 76], [354, 93]], 76, [0.92, 0.86, 0.75], 'flat', 18, 0.085, 0.91, 0.72),
    mark('ground-scumble-upper-right', [[628, 102], [742, 84], [886, 110], [1038, 86]], 93, [0.79, 0.76, 0.68], 'filbert', 19, 0.095, 0.90, 0.70),
    mark('ground-scumble-mid-left', [[60, 354], [176, 330], [294, 346]], 91, [0.76, 0.75, 0.67], 'filbert', 20, 0.11, 0.88, 0.73),
    mark('ground-scumble-mid-right', [[726, 316], [830, 340], [968, 312]], 83, [0.91, 0.82, 0.70], 'flat', 21, 0.10, 0.89, 0.68),
    mark('ground-scumble-low-left', [[82, 590], [208, 574], [318, 601]], 72, [0.74, 0.72, 0.63], 'flat', 22, 0.085, 0.91, 0.66),
    mark('ground-scumble-low-right', [[716, 570], [852, 586], [1006, 558]], 104, [0.90, 0.82, 0.70], 'filbert', 23, 0.10, 0.90, 0.70),

    // The tabletop is assembled from overlapping short shingle deposits.
    mark('table-shadow-a', [[0, 653], [92, 643], [183, 637]], 116, C.olive, 'flat', 101, 3.6, 0.52, 1, undefined, 0, { taperEnd: 'berm', edgeRidge: 0.82 }),
    mark('table-shadow-b', [[152, 641], [248, 633], [345, 640]], 121, C.olive, 'flat', 103, 3.8, 0.52, 1, C.deepTeal, 0.12),
    mark('table-shadow-c', [[318, 640], [414, 647], [510, 642]], 126, C.olive, 'flat', 104, 3.7),
    mark('table-shadow-d', [[487, 643], [584, 635], [681, 630]], 122, C.olive, 'flat', 105, 3.6),
    mark('table-shadow-e', [[654, 631], [748, 622], [842, 630]], 120, C.olive, 'flat', 106, 3.8, 0.52, 1, C.deepTeal, 0.10),
    mark('table-shadow-f', [[817, 630], [909, 637], [1000, 637]], 116, C.olive, 'flat', 107, 3.6),
    mark('table-light-a', [[7, 706], [103, 693], [199, 686]], 62, C.paleOchre, 'flat', 108, 3.5, 0.50, 1, [0.97, 0.84, 0.53], 0.14),
    mark('table-light-b', [[170, 689], [271, 679], [369, 685]], 65, C.paleOchre, 'flat', 109, 3.7),
    mark('table-light-c', [[340, 685], [443, 692], [542, 685]], 61, C.paleOchre, 'flat', 110, 3.6),
    mark('table-light-d', [[513, 685], [614, 675], [713, 669]], 63, C.paleOchre, 'flat', 111, 3.8),
    mark('table-light-e', [[684, 670], [782, 660], [881, 666]], 60, C.paleOchre, 'flat', 112, 3.5),
    mark('table-light-f', [[849, 666], [925, 671], [1002, 674]], 58, C.paleOchre, 'flat', 113, 3.6),

    // The vase is built from short, overlapping faceted deposits instead of continuous ribbons.
    mark('vase-left-shoulder', [[423, 454], [438, 481], [446, 511]], 62, C.deepTeal, 'filbert', 201, 3.8, 0.56, 1, C.teal, 0.15),
    mark('vase-left-upper', [[436, 492], [430, 527], [433, 557]], 64, C.deepTeal, 'filbert', 207, 4.1, 0.55, 1, C.teal, 0.14),
    mark('vase-left-middle', [[432, 541], [440, 575], [448, 603]], 68, C.deepTeal, 'filbert', 208, 4.0, 0.56, 1, C.blue, 0.12),
    mark('vase-left-foot', [[443, 588], [458, 625], [478, 653]], 72, C.teal, 'filbert', 209, 4.4, 0.52, 1, C.paleBlue, 0.1, { taperEnd: 'berm', edgeRidge: 0.78 }),
    mark('vase-center-neck', [[464, 451], [493, 477], [520, 478]], 61, C.teal, 'filbert', 202, 4.2, 0.58, 1, C.paleBlue, 0.16),
    mark('vase-center-upper', [[474, 474], [493, 509], [504, 538]], 72, C.teal, 'filbert', 210, 4.6),
    mark('vase-center-middle', [[489, 524], [482, 559], [488, 589]], 74, C.teal, 'filbert', 211, 4.3, 0.54, 1, C.deepTeal, 0.12),
    mark('vase-center-lower', [[486, 576], [497, 612], [508, 643]], 76, C.teal, 'filbert', 212, 4.8, 0.54, 1, C.paleBlue, 0.12, { taperEnd: 'berm', edgeRidge: 0.86 }),
    mark('vase-right-shoulder', [[520, 478], [544, 493], [551, 520]], 59, C.deepTeal, 'filbert', 203, 3.9),
    mark('vase-right-upper', [[546, 506], [550, 541], [549, 568]], 63, C.deepTeal, 'filbert', 213, 4.2, 0.57, 1, C.teal, 0.15),
    mark('vase-right-middle', [[550, 555], [543, 589], [536, 615]], 67, C.deepTeal, 'filbert', 214, 4.1, 0.55, 1, C.blue, 0.11),
    mark('vase-right-foot', [[542, 603], [539, 638], [539, 670]], 72, C.deepTeal, 'filbert', 215, 4.4),
    mark('vase-rim-left', [[421, 455], [450, 446], [478, 444]], 27, C.paleBlue, 'flat', 204, 3.8, 0.48, 1, C.cream, 0.16),
    mark('vase-rim-right', [[474, 444], [516, 445], [558, 456]], 27, C.paleBlue, 'flat', 216, 4.0, 0.48, 1, C.cream, 0.14),
    mark('vase-glaze-a', [[461, 493], [470, 518], [475, 544]], 15, C.paleBlue, 'filbert', 205, 1.2, 0.58, 0.9),
    mark('vase-glaze-b', [[474, 538], [472, 568], [480, 595]], 14, C.paleBlue, 'filbert', 217, 1.15, 0.58, 0.88),
    mark('vase-glaze-c', [[479, 584], [491, 615], [500, 642]], 16, C.paleBlue, 'filbert', 218, 1.3, 0.54, 0.9),
    mark('vase-lip-shadow-a', [[430, 469], [459, 476], [486, 477]], 13, C.deepTeal, 'flat', 206, 3.5),
    mark('vase-lip-shadow-b', [[480, 477], [516, 474], [548, 468]], 13, C.deepTeal, 'flat', 219, 3.5),

    // Stems rise through the arrangement, some disappearing behind petals.
    mark('stem-left', [[480, 454], [431, 410], [396, 352], [354, 300]], 12, C.deepTeal, 'filbert', 301, 1.2),
    mark('stem-middle', [[496, 449], [512, 395], [526, 330], [545, 266]], 13, C.deepTeal, 'filbert', 302, 1.3),
    mark('stem-right', [[514, 452], [579, 412], [633, 358], [675, 311]], 11, C.deepTeal, 'filbert', 303, 1.15),

    // Broad leaves pull the eye across the vase and balance the flower heads.
    mark('leaf-left-low', [[468, 522], [417, 509], [368, 478], [337, 445]], 38, C.teal, 'filbert', 401, 2.1, 0.48, 1, C.sage, 0.16),
    mark('leaf-left-ridge', [[420, 507], [391, 479], [366, 457]], 7, C.sage, 'flat', 402, 0.7),
    mark('leaf-left-high', [[456, 469], [407, 446], [379, 408], [362, 378]], 31, C.sage, 'filbert', 403, 1.9, 0.48, 1, C.teal, 0.15),
    mark('leaf-left-high-vein', [[407, 444], [390, 420], [370, 392]], 6, C.paleOchre, 'flat', 404, 0.6),
    mark('leaf-right-low', [[537, 524], [593, 514], [645, 485], [680, 453]], 40, C.sage, 'filbert', 405, 2.2, 0.48, 1, C.teal, 0.15),
    mark('leaf-right-ridge', [[591, 512], [631, 488], [663, 466]], 7, C.paleOchre, 'flat', 406, 0.7),
    mark('leaf-right-high', [[560, 465], [601, 436], [624, 396], [644, 369]], 29, C.teal, 'filbert', 407, 1.9, 0.48, 1, C.sage, 0.15),
    mark('leaf-upper', [[520, 419], [493, 385], [478, 343], [475, 314]], 28, C.sage, 'filbert', 408, 1.7, 0.49, 1, C.teal, 0.16),

    // The left bloom uses short overlapping petal shingles, with warm secondary pigment on focal dabs.
    mark('bloom-left-petal-a', [[352, 291], [337, 277], [326, 260]], 33, C.coral, 'filbert', 501, 3.8, 0.55, 1, C.paleCoral, 0.18),
    mark('bloom-left-petal-a-tip', [[330, 266], [315, 251], [305, 242]], 30, C.coral, 'filbert', 505, 4.0),
    mark('bloom-left-petal-b', [[350, 288], [329, 288], [310, 285]], 30, C.paleCoral, 'filbert', 502, 3.6, 0.56, 1, C.coral, 0.16),
    mark('bloom-left-petal-b-tip', [[317, 285], [299, 282], [285, 280]], 27, C.paleCoral, 'filbert', 506, 3.8),
    mark('bloom-left-petal-c', [[355, 287], [359, 269], [361, 251]], 30, C.coral, 'filbert', 503, 4.1),
    mark('bloom-left-petal-c-tip', [[360, 257], [358, 241], [354, 229]], 26, C.coral, 'filbert', 507, 3.7, 0.52, 1, C.paleOchre, 0.12),
    mark('bloom-left-center', [[345, 282], [351, 280], [358, 283]], 23, C.cream, 'flat', 504, 4.0, 0.46, 1, C.paleOchre, 0.22),

    mark('bloom-top-petal-a', [[543, 264], [516, 239], [506, 210]], 30, C.paleCoral, 'filbert', 511, 3.6, 0.53, 1, C.coral, 0.18),
    mark('bloom-top-petal-b', [[544, 263], [565, 231], [589, 221]], 29, C.coral, 'filbert', 512, 3.8, 0.52, 1, C.paleCoral, 0.17),
    mark('bloom-top-petal-c', [[546, 265], [547, 225], [536, 199]], 26, C.paleOchre, 'filbert', 513, 3.5, 0.53, 1, C.paleCoral, 0.14),
    mark('bloom-top-center', [[540, 260], [548, 265]], 19, C.cream, 'flat', 514, 3.7, 0.45, 1, C.paleOchre, 0.20),

    mark('bloom-right-petal-a', [[674, 306], [679, 269], [698, 245]], 29, C.paleOchre, 'filbert', 521, 3.6, 0.52, 1, C.cream, 0.14),
    mark('bloom-right-petal-b', [[678, 307], [712, 295], [739, 302]], 27, C.paleCoral, 'filbert', 522, 3.5, 0.54, 1, C.coral, 0.16),
    mark('bloom-right-petal-c', [[674, 308], [698, 333], [724, 341]], 26, C.coral, 'filbert', 523, 3.8, 0.53, 1, C.paleCoral, 0.14),
    mark('bloom-right-center', [[671, 301], [678, 309]], 18, C.cream, 'flat', 524, 3.6, 0.45, 1, C.paleOchre, 0.18),

    // Two fruit-like masses in front of the vase, painted with curved, broad marks.
    mark('fruit-left-shadow', [[226, 588], [251, 542], [298, 532], [335, 560], [342, 601]], 49, C.coral, 'filbert', 601, 3.8, 0.55, 1, C.paleCoral, 0.15),
    mark('fruit-left-light', [[253, 558], [282, 548], [308, 558]], 17, C.paleCoral, 'filbert', 602, 1.4),
    mark('fruit-left-stem', [[286, 543], [292, 527]], 8, C.deepTeal, 'flat', 603, 0.6),
    mark('fruit-right-shadow', [[661, 581], [689, 541], [732, 537], [767, 565], [766, 604]], 47, C.ochre, 'filbert', 611, 3.8, 0.54, 1, C.paleOchre, 0.15),
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

/**
 * Close-range material study. The broad underpainting establishes a thin,
 * continuous film; the central crossing strokes carry the sculptural relief
 * and expose overlap, end-shape, bristle, and lighting behavior at 1:1.
 */
export function createCloseupDocument(): PaintingDocument {
  const warmGround: RGB = [0.46, 0.41, 0.32];
  const groundPaint: RGB = [0.62, 0.55, 0.42];
  const groundOlive: RGB = [0.51, 0.48, 0.37];
  const groundRose: RGB = [0.64, 0.51, 0.40];
  const loadedCream: RGB = [0.88, 0.79, 0.61];
  const strokes = [
    // Thin, overlapping scumbles leave no bare linen in the crop. Their broad
    // drags remain subordinate to the loaded marks, but still carry canvas
    // tooth and small contact ridges through the same height field.
    mark('close-ground-warm', [[-240, 760], [180, 690], [520, 718], [850, 646], [1160, 704]], 430, groundPaint, 'flat', 901, 0.065, 0.86),
    mark('close-ground-cool', [[-220, 180], [180, 218], [500, 126], [780, 186], [1160, 120]], 410, groundOlive, 'flat', 902, 0.055, 0.86),
    mark('close-ground-earth', [[-220, 440], [165, 372], [465, 424], [750, 354], [1160, 424]], 450, groundPaint, 'flat', 903, 0.070, 0.84),
    mark('close-ground-rose', [[-180, 600], [220, 546], [540, 584], [830, 512], [1160, 568]], 390, groundRose, 'filbert', 904, 0.055, 0.87),
    mark('close-ground-olive', [[-180, 300], [220, 338], [520, 274], [810, 322], [1160, 268]], 390, groundOlive, 'flat', 905, 0.060, 0.85),
    mark('close-ground-upper', [[-150, 18], [280, 76], [620, 28], [900, 92], [1160, 42]], 370, groundPaint, 'filbert', 906, 0.055, 0.87),
    mark('close-ground-lower', [[-150, 790], [280, 710], [620, 766], [900, 696], [1160, 748]], 380, groundPaint, 'flat', 907, 0.065, 0.85),

    // The loaded crop is dominated by broad, short marks. They overlap as
    // physical deposits, with both flat chisel and filbert terminations in view.
    mark('close-coral-slab', [[18, 282], [218, 246], [448, 270], [690, 232]], 242, C.coral, 'flat', 911, 3.2, 0.62),
    mark('close-ochre-bed', [[-170, 604], [120, 552], [398, 532], [676, 478], [1160, 516]], 280, C.ochre, 'flat', 912, 2.8, 0.58),
    mark('close-teal-pillar', [[590, 58], [640, 246], [588, 432], [624, 744]], 188, C.teal, 'filbert', 913, 3.6, 0.66),
    mark('close-cream-load', [[138, 770], [324, 632], [532, 608], [760, 484]], 208, loadedCream, 'filbert', 914, 4.6, 0.70),
    mark('close-sage-wall', [[862, 292], [826, 470], [864, 642], [896, 808]], 152, C.sage, 'flat', 915, 3.1, 0.60),
    mark('close-blue-edge', [[-34, 386], [110, 356], [274, 388]], 124, C.blue, 'filbert', 916, 2.4, 0.56),
    mark('close-pale-sweep', [[252, 438], [424, 404], [598, 430], [748, 390]], 76, C.paleOchre, 'flat', 917, 2.7, 0.48),

    // Small loaded accents cross the broad deposits and make the shared relief
    // and wet edge response legible without brightening the whole surface.
    mark('close-deep-accent', [[246, 226], [410, 204], [562, 246]], 36, C.deepTeal, 'flat', 921, 0.75, 0.40),
    mark('close-coral-accent', [[536, 700], [644, 636], [754, 606]], 44, C.paleCoral, 'filbert', 922, 0.95, 0.46),
    mark('close-gold-accent', [[664, 760], [748, 690], [824, 658]], 30, C.paleOchre, 'filbert', 923, 0.75, 0.42),
    mark('close-sage-accent', [[690, 356], [768, 330], [850, 348]], 26, C.sage, 'flat', 924, 0.65, 0.40),
  ];
  return { width: 1000, height: 800, canvasMm: 100, ground: warmGround, strokes };
}

/**
 * Close-up material study arranged as three distinct paint samples: loaded
 * knife work, sparse dry-brush scumble, and crossing color films.
 */
export function createMaterialStudyDocument(): PaintingDocument {
  const ground: RGB = [0.61, 0.55, 0.45];
  const strokes = [
    // Left: thick knife loads. Broad, offset slabs keep their own blunt edges;
    // thin, shallow drags across their faces suggest paint scraped by the blade.
    mark('material-knife-underlay', [[-28, 206], [118, 180], [296, 200]], 176, C.ochre, 'flat', 1001, 3.8, 0.70),
    mark('material-knife-red-slab', [[-20, 306], [120, 278], [300, 300]], 156, C.coral, 'flat', 1002, 4.4, 0.67),
    mark('material-knife-cream-slab', [[18, 402], [145, 378], [322, 397]], 150, C.cream, 'flat', 1003, 4.0, 0.66),
    mark('material-knife-teal-slab', [[8, 514], [140, 486], [292, 508]], 150, C.deepTeal, 'flat', 1004, 4.2, 0.69),
    mark('material-knife-blade-face', [[40, 284], [147, 273], [248, 286]], 28, C.paleCoral, 'flat', 1005, 0.55, 0.58),
    mark('material-knife-squeeze-lip', [[68, 342], [142, 326], [225, 338]], 24, C.paleOchre, 'filbert', 1006, 1.35, 0.62),
    mark('material-knife-scrape', [[52, 485], [146, 467], [247, 480]], 20, C.sage, 'flat', 1007, 0.42, 0.60),
    mark('material-knife-lip', [[85, 552], [158, 536], [232, 544]], 22, C.paleBlue, 'filbert', 1008, 1.25, 0.61),

    // Center: restrained dry-brush strokes. The broken, narrow passes leave
    // plenty of ground showing and stay low compared with the knife deposits.
    mark('material-scumble-ground', [[370, 328], [468, 300], [566, 317], [630, 291]], 104, [0.70, 0.64, 0.52], 'flat', 1011, 0.22, 0.88, 0.66),
    mark('material-scumble-ochre', [[365, 302], [430, 281], [487, 293]], 48, C.paleOchre, 'flat', 1012, 0.28, 0.91, 0.59),
    mark('material-scumble-blue', [[470, 374], [523, 350], [589, 357]], 43, C.paleBlue, 'filbert', 1013, 0.25, 0.92, 0.54),
    mark('material-scumble-coral', [[382, 414], [438, 395], [491, 402]], 38, C.paleCoral, 'flat', 1014, 0.20, 0.90, 0.62),
    mark('material-scumble-sage', [[510, 451], [566, 430], [627, 437]], 45, C.sage, 'flat', 1015, 0.26, 0.91, 0.56),
    mark('material-scumble-cream', [[386, 500], [448, 478], [510, 487]], 40, C.cream, 'filbert', 1016, 0.23, 0.89, 0.58),

    // Right: opaque pigment films cross over a thin ground tint. Narrow ribbons
    // of each color interrupt the crossing faces, so the mixture reads as
    // dragged pigment rather than a broad translucent wash.
    mark('material-mix-ground', [[690, 518], [796, 474], [900, 493], [1008, 450]], 142, [0.67, 0.57, 0.46], 'flat', 1021, 0.36, 0.81),
    mark('material-mix-ochre-film', [[680, 318], [770, 356], [862, 398], [982, 432]], 116, [0.79, 0.47, 0.26], 'filbert', 1022, 1.05, 0.76),
    mark('material-mix-blue-film', [[728, 474], [806, 421], [880, 364], [982, 309]], 108, [0.27, 0.43, 0.50], 'filbert', 1023, 0.92, 0.78),
    mark('material-mix-ochre-ribbon', [[748, 370], [826, 404], [904, 423]], 23, [0.94, 0.61, 0.31], 'flat', 1025, 0.62, 0.52),
    mark('material-mix-blue-ribbon', [[798, 426], [865, 378], [929, 338]], 19, [0.39, 0.54, 0.58], 'flat', 1026, 0.56, 0.56),
    mark('material-mix-warm-edge', [[758, 351], [837, 385], [916, 408]], 24, C.paleOchre, 'flat', 1024, 0.32, 0.72),
  ];

  return { width: 1000, height: 800, canvasMm: 100, ground, strokes };
}

/** Reference-matching macro crop: compressed horizontal knife planes and torn, overlapping paint lips. */
export function createMaterialBenchmarkDocument(): PaintingDocument {
  const ground: RGB = [0.53, 0.41, 0.33];
  const warmUnderpaint: RGB = [0.69, 0.55, 0.43];
  const coolUnderpaint: RGB = [0.34, 0.39, 0.39];
  const oliveUnderpaint: RGB = [0.33, 0.34, 0.19];
  const sand: RGB = [0.72, 0.58, 0.47];
  const cream: RGB = [0.88, 0.79, 0.70];
  const taupe: RGB = [0.55, 0.43, 0.42];
  const rust: RGB = [0.65, 0.19, 0.12];
  const scarlet: RGB = [0.79, 0.12, 0.09];
  const orange: RGB = [0.91, 0.31, 0.08];
  const gold: RGB = [0.92, 0.57, 0.12];
  const blue: RGB = [0.24, 0.47, 0.65];
  const paleBlue: RGB = [0.45, 0.68, 0.79];
  const plum: RGB = [0.39, 0.085, 0.25];
  const strokes = [
    // Warm and cool underpainting cross the crop before the loaded passes.
    // The thin films leave small gaps and linen tooth between the knife work.
    mark('benchmark-ground-warm', [[-150, 166], [120, 135], [388, 182], [706, 137], [1140, 166]], 300, warmUnderpaint, 'filbert', 1101, 0.07, 0.88, 0.84, undefined, 0, { profile: 'dry-scumble', edgeRidge: 0.08, taperEnd: 'lifted' }),
    mark('benchmark-ground-cool', [[-130, 384], [145, 351], [430, 397], [745, 348], [1140, 386]], 238, coolUnderpaint, 'flat', 1102, 0.06, 0.90, 0.78, undefined, 0, { profile: 'dry-scumble', edgeRidge: 0.06, taperEnd: 'lifted' }),
    mark('benchmark-ground-olive', [[-130, 720], [164, 689], [455, 731], [781, 690], [1140, 721]], 246, oliveUnderpaint, 'flat', 1103, 0.05, 0.91, 0.80, undefined, 0, { profile: 'dry-scumble', edgeRidge: 0.05, taperEnd: 'lifted' }),

    // The upper crop is a stack of broad, compressed pale knife faces. Each
    // path drifts slightly so their torn margins overlap instead of making
    // evenly spaced vector stripes.
    mark('benchmark-upper-cream-bed', [[-140, 28], [120, 18], [395, 56], [704, 19], [1145, 43]], 250, cream, 'flat', 1111, 3.5, 0.66, 1, undefined, 0, { edgeRidge: 0.88, taperEnd: 'blunt' }),
    mark('benchmark-upper-sand-plane', [[-120, 159], [142, 124], [407, 174], [704, 126], [1140, 158]], 224, sand, 'flat', 1112, 3.6, 0.63, 1, [0.82, 0.66, 0.55], 0.18, { edgeRidge: 0.94, taperEnd: 'berm' }),
    mark('benchmark-upper-taupe-sweep', [[-75, 260], [168, 231], [430, 271], [714, 226], [1088, 253]], 176, taupe, 'filbert', 1113, 3.15, 0.70, 1, undefined, 0, { edgeRidge: 0.42, taperEnd: 'lifted' }),
    mark('benchmark-upper-pale-fold', [[350, 306], [555, 276], [764, 317], [1008, 273], [1150, 289]], 126, [0.81, 0.71, 0.63], 'flat', 1114, 3.25, 0.60),
    // Shorter tool passes interrupt those long slabs. They follow the same
    // broad direction, but their unequal lengths, angle changes and overlap
    // create the broken knife facets visible in the reference crop.
    mark('benchmark-upper-rose-deposit', [[112, 55], [214, 74], [302, 49], [376, 63]], 78, [0.67, 0.34, 0.27], 'filbert', 1115, 1.85, 0.68, 1, [0.82, 0.61, 0.52], 0.18),
    mark('benchmark-upper-left-pale-gash', [[-18, 102], [58, 79], [136, 93], [194, 73]], 43, [0.94, 0.86, 0.78], 'flat', 1116, 0.92, 0.47),
    mark('benchmark-upper-tan-facet', [[588, 88], [684, 67], [793, 81], [871, 69]], 66, [0.66, 0.52, 0.44], 'flat', 1117, 1.65, 0.68, 1, [0.84, 0.72, 0.63], 0.15),
    mark('benchmark-upper-right-slate', [[739, 239], [827, 218], [916, 235], [1014, 206]], 55, [0.42, 0.37, 0.39], 'flat', 1118, 1.22, 0.72),
    mark('benchmark-upper-cream-lip', [[457, 297], [516, 282], [572, 297], [634, 280]], 18, [0.97, 0.87, 0.75], 'flat', 1119, 0.82, 0.42),
    mark('benchmark-upper-blue-chip', [[296, 258], [346, 244], [391, 257]], 14, [0.42, 0.60, 0.65], 'filbert', 1120, 0.38, 0.86, 0.72),

    // A broken, warm middle shelf carries red and orange deposits. The yellow
    // pass catches on its front edge; the dark red below stays visible in the
    // natural gaps and scraped cuts.
    mark('benchmark-middle-rust-bed', [[-150, 451], [88, 420], [328, 463], [565, 425], [836, 469], [1140, 430]], 207, rust, 'flat', 1121, 3.7, 0.57),
    mark('benchmark-middle-gold-load', [[-130, 453], [91, 431], [311, 464], [528, 430], [758, 468]], 112, gold, 'flat', 1122, 3.9, 0.52, 1, [0.78, 0.25, 0.13], 0.20),
    mark('benchmark-middle-orange-blade', [[310, 493], [478, 462], [648, 501], [802, 467], [1000, 497], [1150, 473]], 142, orange, 'flat', 1123, 4.0, 0.51, 1, [0.96, 0.55, 0.18], 0.18, { edgeRidge: 0.9, taperEnd: 'berm' }),
    mark('benchmark-middle-scarlet', [[-140, 567], [127, 542], [389, 574], [641, 539], [895, 575], [1140, 541]], 153, scarlet, 'filbert', 1124, 3.6, 0.52, 1, [0.90, 0.34, 0.17], 0.18),
    mark('benchmark-middle-warm-knife-edge', [[515, 529], [648, 512], [775, 540], [902, 516]], 46, [0.97, 0.71, 0.36], 'flat', 1125, 1.3, 0.48),
    // The warm middle is assembled from short overlapping knife pushes, with
    // thin, sharp catches at a few margins rather than one continuous ridge.
    mark('benchmark-middle-left-sienna-plate', [[-24, 431], [74, 407], [166, 421], [248, 397]], 84, [0.58, 0.16, 0.11], 'flat', 1126, 2.65, 0.55),
    mark('benchmark-middle-gold-ridge', [[32, 458], [107, 437], [184, 449], [238, 430]], 26, [0.99, 0.72, 0.24], 'flat', 1127, 1.18, 0.45, 1, [0.90, 0.30, 0.12], 0.22),
    mark('benchmark-middle-orange-chisel', [[423, 449], [500, 430], [577, 442], [662, 414]], 71, [0.94, 0.35, 0.09], 'flat', 1128, 2.40, 0.48, 1, [0.98, 0.67, 0.22], 0.20),
    mark('benchmark-middle-tangerine-peak', [[703, 492], [755, 461], [817, 478], [870, 451]], 37, [0.97, 0.46, 0.10], 'filbert', 1129, 1.38, 0.48),
    mark('benchmark-middle-crimson-drag', [[278, 555], [349, 531], [427, 548], [503, 520]], 48, [0.55, 0.075, 0.095], 'flat', 1130, 1.82, 0.50, 1, [0.88, 0.22, 0.12], 0.16),
    mark('benchmark-middle-cream-blade', [[510, 508], [570, 486], [636, 497], [704, 477]], 22, [0.96, 0.82, 0.64], 'flat', 1135, 0.90, 0.50),
    mark('benchmark-middle-coral-lip', [[662, 573], [724, 553], [798, 566], [866, 543]], 20, [0.88, 0.25, 0.16], 'filbert', 1136, 0.96, 0.48),
    mark('benchmark-middle-turquoise-chip', [[404, 579], [455, 554], [516, 566], [561, 546]], 30, [0.28, 0.54, 0.66], 'flat', 1137, 0.96, 0.62),

    // The lower blue sheet rides over plum and olive paint. Its long flat face
    // is interrupted by two colored streaks and lifted, irregular margins.
    mark('benchmark-lower-olive-bed', [[-140, 773], [133, 744], [416, 778], [720, 738], [1140, 768]], 187, oliveUnderpaint, 'flat', 1131, 2.65, 0.69),
    mark('benchmark-lower-plum-load', [[-140, 714], [138, 685], [421, 722], [704, 682], [1008, 719], [1140, 692]], 154, plum, 'flat', 1132, 3.7, 0.49, 1, [0.48, 0.18, 0.28], 0.16),
    mark('benchmark-lower-blue-sheet', [[-125, 650], [142, 623], [400, 656], [668, 616], [922, 649], [1140, 619]], 129, blue, 'flat', 1133, 3.8, 0.48, 1, [0.57, 0.77, 0.84], 0.24, { edgeRidge: 0.82, taperEnd: 'blunt' }),
    mark('benchmark-lower-pale-blue-ridge', [[-25, 605], [174, 584], [378, 614], [588, 581], [795, 609]], 37, paleBlue, 'filbert', 1134, 1.35, 0.45),
    // Smaller, directionally related marks articulate the blue/plum/olive
    // stack: raised palette ridges, color fragments and a few scraped seams.
    mark('benchmark-lower-cobalt-face', [[74, 669], [157, 649], [244, 665], [325, 643]], 62, [0.18, 0.39, 0.59], 'flat', 1138, 2.12, 0.48, 1, [0.53, 0.73, 0.82], 0.22),
    mark('benchmark-lower-ice-edge', [[36, 622], [128, 604], [219, 619], [286, 598]], 23, [0.62, 0.79, 0.84], 'flat', 1139, 0.86, 0.43),
    mark('benchmark-lower-plum-squeeze', [[371, 711], [468, 687], [566, 704], [678, 680]], 43, [0.47, 0.10, 0.29], 'flat', 1140, 1.72, 0.48),
    mark('benchmark-lower-violet-fragment', [[735, 697], [815, 679], [887, 693], [964, 668]], 52, [0.35, 0.07, 0.24], 'filbert', 1143, 1.66, 0.50),
    mark('benchmark-lower-olive-scrape', [[682, 754], [777, 735], [869, 750], [969, 726]], 15, [0.53, 0.45, 0.23], 'flat', 1144, 0.34, 0.86, 0.73),
    mark('benchmark-lower-cream-tear', [[271, 757], [328, 739], [381, 751], [426, 730]], 21, [0.85, 0.79, 0.68], 'flat', 1145, 0.72, 0.47),
    mark('benchmark-lower-blue-cut', [[779, 650], [847, 633], [908, 647], [970, 628]], 17, [0.54, 0.76, 0.83], 'flat', 1146, 0.43, 0.80, 0.70),

    // A few thin scumbles and knife scrapes expose the earlier warm/cool bed.
    // Opaque neighboring strokes remain the dominant material.
    mark('benchmark-thin-cool-scrape', [[244, 590], [370, 568], [481, 592]], 25, [0.45, 0.59, 0.61], 'flat', 1141, 0.30, 0.86, 0.72),
    mark('benchmark-dry-ground-scumble', [[32, 783], [191, 758], [337, 787], [480, 755]], 50, [0.55, 0.48, 0.35], 'flat', 1142, 0.06, 0.93, 0.66, undefined, 0, { profile: 'dry-scumble', edgeRidge: 0.04, taperEnd: 'lifted' }),
  ];
  return { width: 1000, height: 800, canvasMm: 78, ground, strokes };
}

