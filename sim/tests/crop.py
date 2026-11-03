#!/usr/bin/env python3
"""Make JPEG previews and 1:1 crops from the PNG renders in out/."""
from PIL import Image
import sys
for name, box in [('one-stroke-paint', None), ('patch-paint', None), ('patch-light-opposite', None),
                  ('one-stroke-paint', (760, 80, 1160, 400)), ('one-stroke-paint', (70, 90, 470, 410)), ('patch-paint', (480, 380, 980, 780))]:
    im = Image.open(f'out/{name}.png').convert('RGB')
    if box:
        im = im.crop(box).resize(((box[2] - box[0]) * 2, (box[3] - box[1]) * 2), Image.NEAREST)
        im.save(f'out/{name}-crop-{box[0]}-{box[1]}.jpg', quality=92)
    else:
        im.save(f'out/{name}.jpg', quality=90)
