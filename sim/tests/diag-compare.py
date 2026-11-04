"""Side-by-side metrics for two diagnostic runs: python3 tests/diag-compare.py out/diag out/diag-v2"""
import json, sys
a, b = (json.load(open(f'{d}/metrics.json')) for d in sys.argv[1:3])
rows = [('plan error', lambda m: m['error']['plan']), ('painted colour error', lambda m: m['error']['paintedColour']), ('shaded error', lambda m: m['error']['shaded']),
        ('edges kept: plan', lambda m: m['silhouettes']['plan']['recall']), ('edges kept: colour', lambda m: m['silhouettes']['paintedColour']['recall']),
        ('shaded edge precision', lambda m: m['silhouettes']['shaded']['precision']), ('mean thickness mm', lambda m: m['thicknessMm']['mean']),
        ('relief rms mm', lambda m: m['reliefMm']['rms']), ('relief tile CV', lambda m: m['reliefMm']['tileCv']), ('relief p90/p10', lambda m: round(m['reliefMm']['tileP90'] / max(1e-6, m['reliefMm']['tileP10']), 2)),
        ('strokes', lambda m: m['strokes']['count']), ('length CV', lambda m: m['strokes']['lengthCv']), ('straightness', lambda m: m['strokes']['straightness']),
        ('direction entropy', lambda m: m['strokes']['directionEntropy']), ('glint %', lambda m: m['shading']['glintPct']), ('dark %', lambda m: m['shading']['darkPct'])]
print(f"{'':24}" + ''.join(f'{c:>22}' for c in a))
for name, f in rows:
    print(f'{name:24}' + ''.join(f'{f(a[c]):>10} -> {f(b[c]):<9}' for c in a))
