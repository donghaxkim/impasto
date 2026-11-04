"""Labelled contact sheets for the diagnostic crops: python3 tests/diag-sheet.py [out/diag]"""
import sys, json, os
from PIL import Image, ImageDraw
d = sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(__file__), '..', 'out', 'diag')
names = ['1-photo', '2-plan', '3-strokes', '4-colour', '5-height', '6-normal', '7-cavity', '8-paint']
labels = ['photo', 'stroke plan', 'plan outlines', 'painted colour', 'height', 'normals', 'cavity term', 'shaded render']
for crop in ['mountains', 'spruce', 'lake']:
    ims = [Image.open(os.path.join(d, f'{crop}-{n}.png')).convert('RGB') for n in names]
    w, h = ims[0].size
    s = min(1.0, 520 / max(w, h)) if w > h else min(1.0, 700 / h)
    tw, th = int(w * s), int(h * s)
    cols = 4
    sheet = Image.new('RGB', (cols * (tw + 6) + 6, 2 * (th + 28) + 6), (245, 244, 240))
    dr = ImageDraw.Draw(sheet)
    for k, im in enumerate(ims):
        x, y = 6 + (k % cols) * (tw + 6), 6 + (k // cols) * (th + 28)
        sheet.paste(im.resize((tw, th), Image.LANCZOS), (x, y + 22))
        dr.text((x + 2, y + 4), labels[k], fill=(30, 30, 30))
    sheet.save(os.path.join(d, f'{crop}-sheet.jpg'), quality=90)
    print(os.path.join(d, f'{crop}-sheet.jpg'), sheet.size)
