#!/usr/bin/env python3
"""scripts/vrt-diff-explain.py <expected.png> <actual.png>

Explain a VRT diff instead of eyeballing it: the differing-pixel count, the
bounding box of the difference, and — the part that names the bug — the
DISTRIBUTION of the per-pixel deltas.

WHY: "the trace moved" and "the whole region got brighter" and "one element
alternates between two renders" all print as one number ("N pixels differ") and
need completely different fixes. The channel-delta histogram separates them:

  * a handful of large deltas concentrated in a small box  -> content moved
  * a uniform small delta over a large box                 -> level/colour shift
  * an exactly-repeatable delta count across runs          -> a DISCRETE second
                                                              render state, not
                                                              drift

Pure stdlib + zlib (no numpy/PIL) so it runs anywhere the repo does.
"""
import sys
import zlib
import struct
from collections import Counter


def read_png(path):
    data = open(path, 'rb').read()
    assert data[:8] == b'\x89PNG\r\n\x1a\n', f'{path}: not a PNG'
    pos = 8
    idat = b''
    w = h = bitdepth = colortype = None
    while pos < len(data):
        (length,) = struct.unpack('>I', data[pos:pos + 4])
        ctype = data[pos + 4:pos + 8]
        body = data[pos + 8:pos + 8 + length]
        if ctype == b'IHDR':
            w, h, bitdepth, colortype = struct.unpack('>IIBB', body[:10])
        elif ctype == b'IDAT':
            idat += body
        elif ctype == b'IEND':
            break
        pos += 12 + length
    assert bitdepth == 8, f'{path}: only 8-bit supported (got {bitdepth})'
    channels = {0: 1, 2: 3, 4: 2, 6: 4}[colortype]
    raw = zlib.decompress(idat)
    stride = w * channels
    out = bytearray(h * stride)
    prev = bytearray(stride)
    p = 0
    for y in range(h):
        f = raw[p]
        p += 1
        line = bytearray(raw[p:p + stride])
        p += stride
        if f == 1:
            for i in range(channels, stride):
                line[i] = (line[i] + line[i - channels]) & 0xFF
        elif f == 2:
            for i in range(stride):
                line[i] = (line[i] + prev[i]) & 0xFF
        elif f == 3:
            for i in range(stride):
                a = line[i - channels] if i >= channels else 0
                line[i] = (line[i] + ((a + prev[i]) >> 1)) & 0xFF
        elif f == 4:
            for i in range(stride):
                a = line[i - channels] if i >= channels else 0
                b = prev[i]
                c = prev[i - channels] if i >= channels else 0
                pp = a + b - c
                pa, pb, pc = abs(pp - a), abs(pp - b), abs(pp - c)
                pr = a if (pa <= pb and pa <= pc) else (b if pb <= pc else c)
                line[i] = (line[i] + pr) & 0xFF
        out[y * stride:(y + 1) * stride] = line
        prev = line
    return w, h, channels, bytes(out)


def main():
    ap, bp = sys.argv[1], sys.argv[2]
    aw, ah, ac, a = read_png(ap)
    bw, bh, bc, b = read_png(bp)
    if (aw, ah) != (bw, bh):
        print(f'SIZE MISMATCH {aw}x{ah} vs {bw}x{bh}')
        return
    n = 0
    x0, y0, x1, y1 = aw, ah, -1, -1
    hist = Counter()
    for y in range(ah):
        ra = y * aw * ac
        rb = y * bw * bc
        for x in range(aw):
            pa = a[ra + x * ac:ra + x * ac + 3]
            pb = b[rb + x * bc:rb + x * bc + 3]
            if pa != pb:
                d = max(abs(pa[i] - pb[i]) for i in range(3))
                n += 1
                hist[min(255, (d // 16) * 16)] += 1
                if x < x0: x0 = x
                if x > x1: x1 = x
                if y < y0: y0 = y
                if y > y1: y1 = y
    print(f'image        {aw}x{bh}  ({aw * ah} px)')
    print(f'differing    {n} px  (ratio {n / (aw * ah):.4f})')
    if n:
        print(f'bbox         ({x0},{y0})-({x1},{y1})  {x1 - x0 + 1}x{y1 - y0 + 1}')
        print('max-channel-delta histogram (bucket -> px):')
        for k in sorted(hist):
            print(f'  {k:3d}-{k + 15:3d}  {hist[k]}')


main()
