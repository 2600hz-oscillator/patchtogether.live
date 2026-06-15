#!/usr/bin/env python3
"""Probe a PDF: engraved-vector vs scanned-raster + software origin. Pure stdlib.
Usage: python3 probe_pdf.py <pdf>
"""
import re
import sys


def main(path):
    data = open(path, "rb").read()
    print("=== FILE ===")
    print("size_bytes:", len(data))
    print("header:", data[:16])

    markers = [
        b"Producer", b"Creator", b"Sibelius", b"Finale", b"MuseScore",
        b"Dorico", b"LilyPond", b"MusicXML", b"score-partwise", b"MThd",
        b"Bravura", b"Maestro", b"Leland", b"Emmentaler",
        b"DCTDecode", b"JPXDecode", b"CCITTFaxDecode", b"JBIG2Decode",
        b"FlateDecode", b"/Type1", b"/TrueType", b"/Type0", b"/Type3",
        b"BaseFont", b"/Font", b"/XObject", b"/EmbeddedFile",
    ]
    print("\n=== MARKER COUNTS ===")
    for kw in markers:
        n = len(re.findall(re.escape(kw), data))
        if n:
            print("  %-18s %d" % (kw.decode(errors="replace"), n))

    print("\n=== METADATA ===")
    for kw in [b"/Producer", b"/Creator", b"/CreationDate", b"/Title"]:
        i = data.find(kw)
        if i != -1:
            print("  ", repr(data[i:i + 110]))

    print("\n=== BASEFONTS ===")
    for m in re.finditer(rb"/BaseFont\s*/([A-Za-z0-9+\-,.]+)", data):
        print("  ", m.group(1).decode(errors="replace"))

    print("\n=== VERDICT ===")
    img = len(re.findall(rb"/Subtype\s*/Image", data))
    fonts = len(re.findall(rb"/Type\s*/Font", data))
    print("  images=%d fonts=%d" % (img, fonts))
    if img >= 1 and fonts == 0:
        print("  scanned raster (image-only) -> OMR required")
    elif fonts > 0 and img == 0:
        print("  engraved vector w/ embedded fonts -> glyph/text extraction possible")
    else:
        print("  mixed; inspect basefonts (music font name => engraved)")


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else
         "/Users/2600hz/Downloads/687031678-moonlight-in-vermont-tenor.pdf")
