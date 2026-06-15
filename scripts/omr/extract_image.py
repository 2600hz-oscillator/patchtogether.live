#!/usr/bin/env python3
"""Extract embedded DCTDecode (JPEG) page images from a 'Print to PDF' scanned
music PDF without poppler/mutool. Writes pageN.jpg + normalized pageN.png.
Usage: python3 extract_image.py <pdf> <out_dir>
"""
import os
import re
import sys


def extract(pdf_path, out_dir):
    data = open(pdf_path, "rb").read()
    os.makedirs(out_dir, exist_ok=True)
    count = 0
    for m in re.finditer(rb"/Filter\s*/DCTDecode", data):
        s = data.find(b"stream", m.end())
        if s == -1:
            continue
        p = s + len("stream")
        if data[p:p + 2] == b"\r\n":
            p += 2
        elif data[p:p + 1] in (b"\n", b"\r"):
            p += 1
        e = data.find(b"endstream", p)
        if e == -1:
            continue
        blob = data[p:e].rstrip(b"\r\n")
        soi = blob.find(b"\xff\xd8")
        if soi == -1:
            continue
        eoi = blob.rfind(b"\xff\xd9")
        blob = blob[soi:eoi + 2] if eoi != -1 else blob[soi:]
        count += 1
        jpg = os.path.join(out_dir, "page%d.jpg" % count)
        open(jpg, "wb").write(blob)
        print("wrote", jpg, len(blob), "bytes")
        try:
            from PIL import Image
            im = Image.open(jpg)
            print("  size", im.size, "mode", im.mode)
            png = os.path.join(out_dir, "page%d.png" % count)
            im.convert("RGB").save(png)
            print("  wrote", png)
        except Exception as ex:
            print("  PIL failed:", ex)
    print("total images:", count)
    return 0 if count else 1


if __name__ == "__main__":
    pdf = sys.argv[1] if len(sys.argv) > 1 else \
        "/Users/2600hz/Downloads/687031678-moonlight-in-vermont-tenor.pdf"
    out = sys.argv[2] if len(sys.argv) > 2 else "/tmp/omr/img"
    sys.exit(extract(pdf, out))
