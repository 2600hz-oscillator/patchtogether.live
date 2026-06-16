#!/usr/bin/env python3
"""Downscale a large scanned page then run oemer with the numpy-2.0 compat
shim. The full 4954x5291 image OOM-killed oemer at symbol extraction; a
~2400px-wide image keeps the staff/notehead detail while cutting peak memory
by ~4x.

Usage: python3 run_oemer_small.py <src.png> <out_dir> [target_width]
"""
import sys
import numpy as np
from PIL import Image

# Restore aliases removed in NumPy 1.24+/2.0 (oemer 0.1.5 needs them).
for name, target in [("int", int), ("float", float), ("bool", bool),
                     ("object", object), ("str", str)]:
    if not hasattr(np, name):
        setattr(np, name, target)

src = sys.argv[1]
out_dir = sys.argv[2]
target_w = int(sys.argv[3]) if len(sys.argv) > 3 else 2400

im = Image.open(src).convert("RGB")
w, h = im.size
if w > target_w:
    nh = int(h * target_w / w)
    im = im.resize((target_w, nh), Image.LANCZOS)
small = src.rsplit(".", 1)[0] + "_small.png"
im.save(small)
print("downscaled to", im.size, "->", small, flush=True)

sys.argv = ["oemer", "--without-deskew", "-o", out_dir, small]
from oemer import ete  # noqa: E402
ete.main()
print("OEMER_SMALL_OK", flush=True)
