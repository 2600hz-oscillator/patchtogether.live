#!/usr/bin/env python3
"""Parse an OMR-produced MusicXML into a monophonic note list, measure by
measure, printing "Bb4 quarter, G4 eighth, ..." Confident-notes-only:
- monophonic: if a measure has chords/voices, keep only the TOP note of each
  vertical (highest pitch) so we stay single-line.
- IGNORE everything we don't understand: articulations, dynamics, slurs,
  lyrics, rehearsal marks, ornaments, text. music21 hands us notes/rests; we
  read ONLY pitch name + octave + quarterLength, mapped to the nearest SCORE
  NoteDuration. Unknown/odd durations are flagged, not invented.

Usage: python3 notes_from_musicxml.py <musicxml> [--json out.json]
"""
import json
import sys

import music21 as m21


# SCORE's supported durations in quarterLength units (from score-data.ts
# DURATION_TICKS, TICKS_PER_BAR=48 => 1 quarter = 12 ticks).
#   whole=4.0, half=2.0, quarter=1.0, eighth=0.5, 16th=0.25, triplet8th=1/3
SCORE_DURATIONS = {
    "whole": 4.0,
    "half": 2.0,
    "quarter": 1.0,
    "eighth": 0.5,
    "16th": 0.25,
    "triplet8th": 1.0 / 3.0,
}


def nearest_score_duration(ql):
    best, berr = None, 1e9
    for name, val in SCORE_DURATIONS.items():
        e = abs(val - ql)
        if e < berr:
            berr, best = e, name
    # Flag if it's not a clean match (dotted notes, etc. snap with a warning).
    clean = berr < 1e-3
    return best, clean


def main(path, json_out=None):
    score = m21.converter.parse(path)
    parts = score.parts if hasattr(score, "parts") and len(score.parts) else [score]
    part = parts[0]  # monophonic: take the first part only

    # Key / time signature / tempo if present.
    ks = part.recurse().getElementsByClass(m21.key.KeySignature)
    ts = part.recurse().getElementsByClass(m21.meter.TimeSignature)
    mm = part.recurse().getElementsByClass(m21.tempo.MetronomeMark)
    print("=== HEADER ===")
    print("key_signature_sharps:", ks[0].sharps if len(ks) else "n/a")
    print("time_signature:", ts[0].ratioString if len(ts) else "n/a")
    print("tempo_bpm:", (mm[0].number if len(mm) else "n/a"))

    measures = part.getElementsByClass(m21.stream.Measure)
    if not measures:
        # Some OMR output is flat; bail to a single pseudo-measure.
        measures = [part]

    out_notes = []
    print("\n=== NOTES (measure by measure) ===")
    for mi, meas in enumerate(measures, start=1):
        cells = []
        for el in meas.notesAndRests:
            if isinstance(el, m21.note.Rest):
                dur, clean = nearest_score_duration(el.quarterLength)
                cells.append("rest:%s%s" % (dur, "" if clean else "?"))
                continue
            if isinstance(el, m21.chord.Chord):
                top = max(el.notes, key=lambda n: n.pitch.midi)  # monophonic: top voice
                p = top.pitch
            else:
                p = el.pitch
            dur, clean = nearest_score_duration(el.quarterLength)
            name = p.nameWithOctave.replace("-", "b")  # music21 'B-4' -> 'Bb4'
            cells.append("%s %s%s" % (name, dur, "" if clean else "?"))
            out_notes.append({
                "measure": mi, "pitch": name, "midi": p.midi,
                "duration": dur, "clean": clean,
                "quarterLength": float(el.quarterLength),
            })
        print("m%-3d | %s" % (mi, ", ".join(cells) if cells else "(empty)"))

    print("\n=== SUMMARY ===")
    print("measures:", len(measures), "notes:", len(out_notes))
    flagged = [n for n in out_notes if not n["clean"]]
    print("duration-mismatch (flagged '?'):", len(flagged))
    if out_notes:
        midis = [n["midi"] for n in out_notes]
        print("midi range:", min(midis), "-", max(midis),
              "(SCORE supports 60-84; out-of-range need clamping/octave-fold)")
        oor = [n for n in out_notes if n["midi"] < 60 or n["midi"] > 84]
        print("out-of-SCORE-range notes:", len(oor))

    if json_out:
        json.dump(out_notes, open(json_out, "w"), indent=2)
        print("wrote", json_out)


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("usage: notes_from_musicxml.py <musicxml> [--json out.json]")
        sys.exit(2)
    jo = None
    if "--json" in sys.argv:
        jo = sys.argv[sys.argv.index("--json") + 1]
    main(sys.argv[1], jo)
