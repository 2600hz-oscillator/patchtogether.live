#!/usr/bin/env python3
"""build_gallery.py — render the static HTML catalog of VRT baselines
(docs/vrt), plus a machine-readable coverage.json for the gate that checks it.

---------------------------------------------------------------------------
WHAT IT DOES
---------------------------------------------------------------------------
Walks EVERY `<baseline_dir>/<spec>/<stem>.png`, keys the inventory by the
`(spec_dir, stem)` SCENE — never by the bare stem, which is not unique across
spec dirs — files each scene into exactly one tab (TOTAL: asserted, not
assumed), and writes an `index.html` catalog plus the machine-readable
`coverage.json` that `scripts/vrt-gallery.test.ts` compares against its own
independent walk of the same tree.

---------------------------------------------------------------------------
HISTORICAL NOTE — THE PLATFORM DIMENSION WAS REMOVED (2026-08-10)
---------------------------------------------------------------------------
Baselines used to be captured per platform (`<spec>/darwin/<stem>.png` AND
`<spec>/linux/<stem>.png`). This gallery rendered the two side by side, badged
a darwin-only scene as a parity GAP and summed a per-spec darwin/linux/gap
table. All of that went with the `{platform}` segment of `vrt.config.ts`'s
`snapshotPathTemplate`: CI renders on LINUX, so a darwin-only baseline was
never diffed where it counted — ZERO regression protection while still reading
as "covered" everywhere. There is now ONE baseline set, authored by linux CI,
and nothing left to compare it against.

The bug that motivated the platform-aware rewrite is kept in one line because
its SHAPE recurs: the inventory was keyed by the bare stem, so `darwin/adsr.png`
and `linux/adsr.png` collided, 416 PNGs rendered as 282 cards, and the page
reported a count of SCENES as a count of BASELINES. The `(spec_dir, stem)` key
outlives the collapse — it is why two spec dirs sharing a stem still cannot
overwrite each other, on the way in or on the way out.

---------------------------------------------------------------------------
DIRECTORY SCOPE — STATED, BECAUSE AN UNSTATED SCOPE READS AS FULL COVERAGE
---------------------------------------------------------------------------
Two gates in this repo were silently narrow because they only ever built the
`__screenshots__/vrt.spec.ts/…` path and nothing said so (CLAUDE.md: "state a
gate's directory scope in the gate"). This one walks EVERY
`__screenshots__/*/*.png`, the category assignment is TOTAL, and the scope is
printed on the page itself along with the per-directory table.

`unexpected_subdirs()` guards the other end of that scope: a spec dir holds
PNGs and nothing else, so a DIRECTORY found inside one (a leftover `darwin/` or
`linux/` from before the collapse) would hold baselines that no loop reads and
no page shows, with every count staying internally consistent. It is reported
loudly instead.

What this gallery can and cannot tell you:
  ✓ which scenes have a committed baseline, and which curated faces do not
  ✗ whether a committed PNG still MATCHES today's render — only a VRT run
    answers that, and a sub-tolerance drift is invisible to it too

---------------------------------------------------------------------------
THE "UI v2" TAB
---------------------------------------------------------------------------
The curated-faceplate catalog, driven from the LIVE ratchet set
`packages/web/src/lib/ui/workflow/strict-faces.ts` (STRICT_FACES) rather than a
hand-copied list — so a newly promoted face appears with no edit here and a
demoted one disappears. Same registry-driven discipline as
`e2e/tests/faces-parity.spec.ts`, which imports the same set.

Per module it shows the COMPACT lane tile and the DOCK full-view faceplate (the
two required tiers), plus the REAR card where one exists. A module is `1:1`
only when every required tier has a committed baseline; a required tier with
none renders a loud MISSING tile rather than nothing at all, so a face promoted
before its baselines land reads as a GAP instead of as an absence.

⚠ A parser that silently matches nothing returns a clean-looking empty page, so
`parse_strict_faces()` HARD-FAILS on an empty parse, and the parsed list is
written into coverage.json where `build-gallery.test.ts` compares it against the
TypeScript module imported for real. A regex that drifts from the source is a
red test, not a quietly missing tab.

---------------------------------------------------------------------------
Inputs / outputs
---------------------------------------------------------------------------
  --baseline-dir   e2e/vrt/__screenshots__/<spec>/<stem>.png
  --results-dir    e2e/vrt/test-results  (optional; a green run has none)
  --strict-faces   packages/web/src/lib/ui/workflow/strict-faces.ts
  --output-dir     docs/vrt

  <output-dir>/index.html
  <output-dir>/coverage.json                        — the machine summary
  <output-dir>/baselines/<spec>/<stem>.png
  <output-dir>/actual/<stem>.png                    — iff the last run failed
  <output-dir>/diff/<stem>.png                      — iff the last run failed

Pure-stdlib (PNGs are copied, never transcoded); Python 3.9-compatible.
"""

from __future__ import annotations

import argparse
import html
import json
import re
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Dict, List, Optional, Tuple

# The two face tiers every STRICT_FACES module must pin, and the optional one.
# `workflow-shell-faces.spec.ts` writes `face-<type>-<tier>.png`;
# `workflow-rear-card.spec.ts` writes `rear-<type>.png`.
REQUIRED_FACE_TIERS: Tuple[str, str] = ("compact", "dock")
OPTIONAL_FACE_TIERS: Tuple[str] = ("rear",)


# Per-module blurb. Drives the alt text + card subtitle.
# Keep terse; the gallery is for reviewers, not first-time users.
MODULE_BLURB: Dict[str, str] = {
    # Audio domain
    "analogVco": "Analog VCO — saw/sq/tri/sine + FM + PM CV inputs.",
    "audioOut": "Stereo audio out + master gain.",
    "vca": "VCA with phase-flipped tap output.",
    "mixer": "4-channel mono mixer.",
    "adsr": "ADSR envelope + inverted envelope output.",
    "filter": "Multi-mode filter.",
    "reverb": "Reverb (Schroeder-ish).",
    "scope": "Stereo scope + scope→mono-video bridge.",
    "sequencer": "Step sequencer + transport CV ports.",
    "wavetableVco": "Wavetable VCO (LFS-tracked WAV banks).",
    "lfo": "Synced LFO (state-deterministic).",
    "cartesian": "X/Y CV + clock router.",
    "destroy": "Per-rackspace destroy gate.",
    "qbrt": "Quad bipolar attenuverter.",
    "drummergirl": "Drum voice (per-rackspace singleton).",
    "meowbox": "MEOWBOX — chaotic glitch voice.",
    "mixmstrs": "Master mix bus + sends.",
    "timelorde": "Clock divider + euclidean gen.",
    "charlottesEchos": "Stereo delay + feedback echo.",
    "score": "Step-score module (4x4x4 pages).",
    "drumseqz": "4-channel drum sequencer.",
    "polyseqz": "Polyphonic step sequencer.",
    "vizvco": "VIZVCO — VCO + wavefolder + waveform video out.",
    "swolevco": "SWOLEVCO — Buchla-259-style complex VCO.",
    "illogic": "Attenuverter + math + logic.",
    "unityscalemathematik": "Bipolar CV-shaper.",
    "dx7": "DX7 — pure-TS 6-op FM synth.",
    "noise": "Noise source (white/pink/brown).",
    "buggles": "Wogglebug-style chaotic CV.",
    "wavecel": "WAVECEL — stereo wavetable VCO + 3D viz.",
    "warrensspectrum": "Spectral resynth — partial tracker + SMS residual.",
    "stereovca": "Stereo VCA + ring modulator.",
    "kickdrum": "KICKDRUM — synthesized kick voice.",
    "snaredrum": "SNAREDRUM — banded snare voice.",
    "tomtom": "TOMTOM — membrane tom voice.",
    "karplus": "KARPLUS — extended Karplus-Strong string voice.",
    "tidyVco": "TIDY VCO — the flagship VA subtractive voice.",
    "cloudseed": "CLOUDSEED — algorithmic reverb.",
    "shimmershine": "SHIMMERSHINE — pitch-shifted shimmer processor.",
    "sixstrum": "SIXSTRUM — six-string strummed voice.",
    "delay": "DELAY — the workhorse delay line.",
    "ringback": "RINGBACK — stereo ring-mod crush.",
    "clipplayer": "CLIPPLAYER — clip launcher + piano-roll editor.",
    "kria": "KRIA — 4-track grid sequencer.",
    "spectrograph": "SPECTROGRAPH — scrolling sonogram.",
    "featurecv": "FEATURECV — audio→CV feature extractor.",
    # Video domain
    "lines": "LINES — animated line geometry.",
    "videoOut": "Video out / preview canvas.",
    "inwards": "INWARDS — recursive zoom.",
    "picturebox": "PICTUREBOX — image-loader source.",
    "destructor": "DESTRUCTOR — pixel-degrader.",
    "chroma": "CHROMA — hue-shifter / colorizer.",
    "luma": "LUMA — posterize / contrast / gamma.",
    "chromakey": "CHROMAKEY — 2-input chroma-key compositor.",
    "lumakey": "LUMAKEY — 2-input luma-key compositor.",
    "colorizer": "COLORIZER — palette remap.",
    "feedback": "FEEDBACK — frame echo / VHS feedback.",
    "videoMixer": "Video mixer.",
    "shapes": "SHAPES — geometry source.",
    "monoglitch": "MONOGLITCH — luma-driven scanline displacement.",
    "reshaper": "RESHAPER — raster-scan coordinate-remap (formerly RUTTETRA).",
    "ruttetra": "RUTTETRA — authentic forward-scatter Rutt-Etra scope.",
    "shapedramps": "SHAPEDRAMPS — synced ramp generator.",
    "vdelay": "VDELAY — video delay + feedback echo.",
    "posterbox": "POSTERBOX — retro palette crush.",
    "cellshade": "CELLSHADE — 4-pass cel shader.",
    "toybox": "TOYBOX — shader/geometry playground.",
    "wavesculpt": "WAVESCULPT — 3D waveform sculpture.",
}


# Per-composite-scene blurb. Composite scenes are signal-flow demos — the blurb
# should call out what's wired to what + why the screenshot is the
# "interesting" state.
COMPOSITE_BLURB: Dict[str, str] = {
    "nibbles-cv-min": "NIBBLES.length_cv ≈ −0.98 → SCOPE.ch1. CV minimum (snake length=1).",
    "nibbles-cv-25": "NIBBLES.length_cv ≈ −0.50 → SCOPE.ch1. CV at 25% of the sweep (length=30).",
    "nibbles-cv-50": "NIBBLES.length_cv ≈ +0.01 → SCOPE.ch1. CV at the midpoint (length=60).",
    "nibbles-cv-75": "NIBBLES.length_cv ≈ +0.50 → SCOPE.ch1. CV at 75% of the sweep (length=89).",
    "nibbles-cv-max": "NIBBLES.length_cv = +1.00 → SCOPE.ch1. CV maximum (snake length=119).",
}


# ---------------------------------------------------------------------------
# CATEGORIES
# ---------------------------------------------------------------------------
# Assignment is by SPEC DIRECTORY and it is TOTAL: `categorize()` always
# returns a real tab, and `assert_total_categorization()` proves the union of
# the tabs equals the whole inventory. The old map named three directories and
# silently funnelled the other twenty-seven into "modules", which is how 27
# toybox scenes and every workflow scene came to be filed as "Modules".
CATEGORIES: List[Tuple[str, str, str]] = [
    (
        "ui-v2",
        "UI v2",
        "The curated faceplates — every module on the STRICT_FACES ratchet, "
        "compact lane tile + dock full-view (+ rear card where one exists).",
    ),
    (
        "composite",
        "Composite States",
        "Multi-module scenes wired with a patch cord: one module's signal driving "
        "another into a deterministic state.",
    ),
    (
        "workflow",
        "Workflow Shell",
        "The `?shell=1` workflow mode — rack zoom, the dock full-view, the audio-I/O "
        "panel and the rear card.",
    ),
    (
        "chrome",
        "App Chrome",
        "Everything outside a module card: landing, dashboard, top bar, groups, "
        "the playhead and the direct-manipulation menus.",
    ),
]

_CHROME_SPECS = {
    "dashboard.spec.ts",
    "groups.spec.ts",
    "interactions.spec.ts",
    "landing.spec.ts",
    "playhead.spec.ts",
    "topbar.spec.ts",
}


def categorize(spec_dir: str, stem: str, strict_faces: frozenset) -> str:
    """Which tab does this baseline belong to? TOTAL — always returns a tab."""
    if face_key(spec_dir, stem, strict_faces) is not None:
        return "ui-v2"
    if spec_dir in _CHROME_SPECS:
        return "chrome"
    if spec_dir.startswith("workflow-"):
        return "workflow"
    # Everything else is a multi-module / multi-state scene captured by a
    # bespoke spec (cellshade-composite, vrt-toybox, vrt-quadralogical, …).
    return "composite"


def face_key(
    spec_dir: str, stem: str, strict_faces: frozenset
) -> Optional[Tuple[str, str]]:
    """`(module, tier)` when this stem is a curated-face scene for a module on
    the STRICT_FACES ratchet, else None.

    Anchored on the ratchet set, NOT on the filename shape: a `face-foo-dock`
    baseline for a module that is not (or is no longer) promoted deliberately
    does NOT claim a UI v2 slot — it surfaces as an ORPHAN in coverage.json
    instead, which is the direction a hand-copied list can never fail in.
    """
    if spec_dir == "workflow-shell-faces.spec.ts" and stem.startswith("face-"):
        body = stem[len("face-") :]
        for tier in REQUIRED_FACE_TIERS + OPTIONAL_FACE_TIERS:
            suffix = "-" + tier
            if body.endswith(suffix):
                module = body[: -len(suffix)]
                return (module, tier) if module in strict_faces else None
        return None
    if spec_dir == "workflow-rear-card.spec.ts" and stem.startswith("rear-"):
        module = stem[len("rear-") :]
        return (module, "rear") if module in strict_faces else None
    return None


# ---------------------------------------------------------------------------
# INVENTORY
# ---------------------------------------------------------------------------


class Entry:
    """One SCENE — a `(spec_dir, stem)` pair — and its committed baseline.

    Keyed by the PAIR, never by the stem alone: two spec dirs are free to use
    the same scene name and the second walked must not overwrite the first.
    (That collision is what the platform dimension used to trigger; the key
    survives it because the hazard does.)

    `image` is Optional because a scene can be OWED a baseline it does not
    have — the UI v2 tab enumerates the STRICT_FACES ratchet, not the disk, so
    a face promoted before its baselines land is rendered as a MISSING tile.
    """

    __slots__ = ("spec", "stem", "image", "category")

    def __init__(self, spec: str, stem: str) -> None:
        self.spec = spec
        self.stem = stem
        self.image: Optional[Path] = None
        self.category = "composite"

    @property
    def key(self) -> str:
        return "{}/{}".format(self.spec, self.stem)


def list_entries(baseline_dir: Path, strict_faces: frozenset) -> List[Entry]:
    """Walk EVERY `<baseline_dir>/<spec>/<stem>.png`.

    Deliberately walks the whole tree rather than a known list of spec dirs —
    a directory nobody registered still shows up (in `composite`, the catch-all)
    instead of vanishing.
    """
    entries: Dict[Tuple[str, str], Entry] = {}
    for spec_path in sorted(p for p in baseline_dir.iterdir() if p.is_dir()):
        for png in sorted(spec_path.glob("*.png")):
            k = (spec_path.name, png.stem)
            e = entries.get(k)
            if e is None:
                e = Entry(spec_path.name, png.stem)
                e.category = categorize(spec_path.name, png.stem, strict_faces)
                entries[k] = e
            e.image = png
    return [entries[k] for k in sorted(entries)]


def unexpected_subdirs(baseline_dir: Path) -> List[str]:
    """DIRECTORIES sitting inside a spec dir, where only `*.png` belongs.

    Repurposed 2026-08-10 from `unexpected_platform_dirs()`, which flagged a
    third platform dir for exactly this reason: whatever it holds is dropped by
    every loop above while the counts stay internally consistent. Post-collapse
    the same hazard wears a new hat — a leftover `darwin/` or `linux/` from
    before the flattening is a pile of baselines that nothing reads and nothing
    renders. Report it instead of walking past it.
    """
    odd: List[str] = []
    for spec_path in sorted(p for p in baseline_dir.iterdir() if p.is_dir()):
        for child in sorted(spec_path.iterdir()):
            if child.is_dir():
                odd.append("{}/{}".format(spec_path.name, child.name))
    return odd


def assert_total_categorization(entries: List[Entry]) -> None:
    """Every entry lands in exactly one DECLARED tab. A typo in `categorize()`
    would otherwise create a phantom bucket that nothing renders, and the page
    would simply be short a few cards with no error anywhere."""
    known = {cid for cid, _, _ in CATEGORIES}
    stray = sorted({e.category for e in entries} - known)
    if stray:
        raise SystemExit(
            "build_gallery: categorize() returned undeclared tab(s) {} — those "
            "baselines would render in NO tab. Add them to CATEGORIES.".format(stray)
        )


# ---------------------------------------------------------------------------
# STRICT_FACES — parsed from the live TypeScript ratchet set
# ---------------------------------------------------------------------------

_STRICT_FACES_RE = re.compile(
    r"export\s+const\s+STRICT_FACES\s*:[^=]*=\s*new Set<string>\(\[(.*?)\]\)",
    re.S,
)


def parse_strict_faces(path: Path) -> List[str]:
    """Module types on the face-curation ratchet, read from strict-faces.ts.

    HARD-FAILS on an empty parse. A regex that drifts from the source would
    otherwise return `[]`, the UI v2 tab would render empty, and an empty tab
    reads exactly like "no faces are promoted yet" — the silent-zero failure
    mode this repo keeps re-learning. The parsed list also goes into
    coverage.json so `build-gallery.test.ts` can compare it against the real
    TypeScript module rather than trusting this regex.
    """
    if not path.is_file():
        raise SystemExit(
            "build_gallery: STRICT_FACES source not found at {} — the UI v2 tab "
            "is driven from it and must never fall back to a hand-copied "
            "list.".format(path)
        )
    src = path.read_text(encoding="utf8")
    m = _STRICT_FACES_RE.search(src)
    if not m:
        raise SystemExit(
            "build_gallery: could not find `export const STRICT_FACES = new "
            "Set<string>([…])` in {}. The declaration was reshaped and this "
            "parser did not follow; refusing to render an empty UI v2 tab that "
            "would look like 'no promoted faces'.".format(path)
        )
    body = "\n".join(
        line for line in m.group(1).split("\n") if not line.strip().startswith("//")
    )
    faces = re.findall(r"'([^']+)'", body)
    if not faces:
        raise SystemExit(
            "build_gallery: STRICT_FACES parsed to ZERO entries from {}. Either "
            "the ratchet set is genuinely empty (it never is) or the parse "
            "drifted.".format(path)
        )
    return sorted(faces)


# ---------------------------------------------------------------------------
# RUN ARTIFACTS (unchanged semantics — a green run has none)
# ---------------------------------------------------------------------------

_ARTIFACT_RE = re.compile(r"^(?P<stem>[a-zA-Z0-9_-]+)-(?P<kind>actual|diff)\.png$")


def list_run_artifacts(results_dir: Optional[Path]) -> Dict[str, Dict[str, Path]]:
    """Map baseline stem → {"actual": Path, "diff": Path} for the last run.

    Playwright names failure artifacts `<arg>-actual.png` / `<arg>-diff.png`, so
    the only handle is the stem — a run artifact carries no spec-dir. Two spec
    dirs sharing a stem would therefore attach the same artifact to both cards;
    the worst case is a card showing a sibling's diff, never a false "match",
    which is why the inventory itself is keyed by `(spec, stem)` and only this
    attach falls back to the stem.
    """
    found: Dict[str, Dict[str, Path]] = {}
    if results_dir is None or not results_dir.is_dir():
        return found
    for png in results_dir.rglob("*.png"):
        m = _ARTIFACT_RE.match(png.name)
        if m:
            found.setdefault(m.group("stem"), {})[m.group("kind")] = png
    return found


def repo_short_sha() -> str:
    try:
        out = subprocess.check_output(
            ["git", "rev-parse", "--short", "HEAD"], stderr=subprocess.DEVNULL
        )
        return out.decode().strip()
    except (subprocess.CalledProcessError, FileNotFoundError, OSError):
        return ""


def copy_image(src: Path, dst: Path) -> None:
    dst.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(src, dst)


def rel_image(entry: Entry) -> str:
    """Output-relative href. Includes the SPEC DIR, so two scenes sharing a
    stem can never overwrite each other on the way out — the historical
    collapse happened on the way IN, and re-introducing it on the way out would
    be the same bug wearing a different hat."""
    return "baselines/{}/{}.png".format(entry.spec, entry.stem)


# ---------------------------------------------------------------------------
# RENDER
# ---------------------------------------------------------------------------


def _thumb(href: str, label: str, alt: str) -> str:
    return (
        '<a href="{h}" class="thumb"><img loading="lazy" src="{h}" alt="{a}">'
        "<span>{l}</span></a>".format(h=href, l=html.escape(label), a=html.escape(alt))
    )


def _missing(label: str, why: str) -> str:
    return (
        '<div class="thumb thumb-missing" title="{w}"><div class="missing-body">'
        "MISSING</div><span>{l}</span></div>".format(
            l=html.escape(label), w=html.escape(why)
        )
    )


def _baseline_thumb(entry: Entry, what: str) -> str:
    """The scene's ONE baseline, or the MISSING tile standing in for it.

    `entry.image` is None only where the tab enumerates something the disk does
    not (a promoted face with no capture yet) — and that case is the whole
    reason the MISSING tile exists: an absent required baseline must LOOK
    absent, not simply be left out of the page.
    """
    if entry.image is not None:
        return _thumb(rel_image(entry), "baseline", entry.stem)
    return _missing("baseline", "no baseline committed for {}".format(what))


def _blurb_for(entry: Entry) -> str:
    # `categorize()` can no longer return "modules" — that tab was the per-card
    # `vrt.spec.ts` sweep, deleted with the fleet. MODULE_BLURB itself survives:
    # the UI v2 tab still keys it by MODULE TYPE for the faceplate sections.
    return COMPOSITE_BLURB.get(entry.stem, "")


def render_scene_cards(
    entries: List[Entry], artifacts: Dict[str, Dict[str, Path]]
) -> str:
    cards: List[str] = []
    for e in entries:
        art = artifacts.get(e.stem, {})
        # A scene card exists BECAUSE its PNG does, so there is no coverage
        # verdict left to badge here — the only status worth painting is
        # whether the last run left a diff behind for it.
        status_cls = "gap" if art else "pass"
        thumbs = [_baseline_thumb(e, e.key)]
        for kind in ("actual", "diff"):
            if kind in art:
                thumbs.append(_thumb("{}/{}.png".format(kind, e.stem), kind, e.stem))
        blurb = _blurb_for(e)
        cards.append(
            """
    <article id="{anchor}" class="card card-{cls}">
        <h3>{stem} <span class="status status-{cls}">{label}</span></h3>
        <p class="blurb"><code>{spec}</code>{blurb}</p>
        <div class="row">{thumbs}</div>
    </article>""".format(
                anchor=html.escape(e.key),
                stem=html.escape(e.stem),
                cls=status_cls,
                label="diffed" if art else "pinned",
                spec=html.escape(e.spec),
                blurb=(" · " + html.escape(blurb)) if blurb else "",
                thumbs="".join(thumbs),
            )
        )
    return "".join(cards)


def render_ui_v2(
    strict_faces: List[str], by_face: Dict[Tuple[str, str], Entry]
) -> Tuple[str, Dict[str, object]]:
    """The UI v2 tab: one section per STRICT_FACES module, a row per tier.

    Driven by the RATCHET, not by the disk — so a module promoted before its
    baselines land owes a MISSING row rather than quietly enumerating to
    nothing. Returns (html, summary)."""
    sections: List[str] = []
    full_parity: List[str] = []
    gapped: Dict[str, List[str]] = {}
    for module in strict_faces:
        tiers: List[str] = list(REQUIRED_FACE_TIERS)
        # The rear card only exists for a handful of modules; showing an empty
        # row for the other fourteen would be fourteen false alarms, so it is
        # rendered only when a baseline exists somewhere.
        for opt in OPTIONAL_FACE_TIERS:
            if (module, opt) in by_face:
                tiers.append(opt)

        missing: List[str] = []
        rows: List[str] = []
        for tier in tiers:
            entry = by_face.get((module, tier))
            required = tier in REQUIRED_FACE_TIERS
            if entry is None:
                cells = _missing(
                    "baseline", "no baseline for face {} ({})".format(module, tier)
                )
                if required:
                    missing.append("{}: no baseline committed".format(tier))
            else:
                cells = _baseline_thumb(entry, entry.key)
            rows.append(
                '<div class="face-row"><span class="tier">{t}{req}</span>'
                '<div class="row">{c}</div></div>'.format(
                    t=html.escape(tier),
                    req="" if required else " <em>(optional)</em>",
                    c=cells,
                )
            )

        ok = not missing
        if ok:
            full_parity.append(module)
        else:
            gapped[module] = missing
        sections.append(
            """
    <article id="face-{mid}" class="card card-{cls}">
        <h3>{name} <span class="status status-{cls}">{label}</span></h3>
        <p class="blurb">{note}</p>
        {rows}
    </article>""".format(
                mid=html.escape(module),
                name=html.escape(module),
                cls="pass" if ok else "gap",
                label="1:1" if ok else "gap",
                note=html.escape(
                    MODULE_BLURB.get(module, "")
                    if ok
                    else "; ".join(missing)
                ),
                rows="".join(rows),
            )
        )
    # `fullParity` keeps its name across the platform collapse: it is still the
    # "1:1" set, but the parity is now between the module's REQUIRED TIERS and
    # what is pinned, not between two platforms.
    summary = {
        "strictFaces": strict_faces,
        "fullParity": full_parity,
        "gapped": gapped,
    }
    return "".join(sections), summary


def render_coverage_table(entries: List[Entry], baseline_dir: Path) -> str:
    """Per-directory inventory — enumerated from the DISK, not from `entries`.

    A spec dir with zero committed baselines has no entries, so listing the
    table from `entries` would make it VANISH from the page: the one state
    where the directory most needs saying. It gets a row reading 0 instead.
    """
    per_spec: Dict[str, int] = {}
    for e in entries:
        per_spec[e.spec] = per_spec.get(e.spec, 0) + 1
    on_disk = sorted(p.name for p in baseline_dir.iterdir() if p.is_dir())
    rows = []
    for spec in on_disk:
        n = per_spec.get(spec, 0)
        rows.append(
            '<tr class="{cls}"><td><code>{s}</code></td><td>{n}</td></tr>'.format(
                cls="row-gap" if n == 0 else "row-ok", s=html.escape(spec), n=n
            )
        )
    empty = sum(1 for spec in on_disk if per_spec.get(spec, 0) == 0)
    return """
        <h2>Directory scope</h2>
        <p class="scope">This gallery reads <strong>every</strong>
        <code>{root}/&lt;spec&gt;/*.png</code> — all
        <strong>{n}</strong> spec directories below, not just
        <code>vrt.spec.ts</code>. Two gates in this repo were silently narrow
        because they only ever resolved that one directory and nothing said so;
        an unstated scope reads as full coverage. {empty_note}</p>
        <p class="scope">There is ONE baseline per scene (2026-08-10): the
        <code>{{platform}}</code> segment is gone, because CI renders on linux
        and a darwin-only baseline was never diffed where it counted.</p>
        <p class="scope">It reports what is <em>committed</em>. It cannot tell
        you whether a committed PNG still <em>matches</em> today's render — only
        a VRT run does that, and a sub-tolerance drift is invisible to that run
        too.</p>
        <table class="cov">
          <thead><tr><th>spec directory</th><th>baselines</th></tr></thead>
          <tbody>{rows}</tbody>
          <tfoot><tr><th>TOTAL ({n} dirs)</th><th>{total}</th></tr></tfoot>
        </table>""".format(
        root=html.escape(str(baseline_dir)),
        n=len(on_disk),
        empty_note=(
            "Directories holding <strong>no</strong> committed baseline are "
            "listed too ({} of them) rather than quietly omitted.".format(empty)
            if empty
            else ""
        ),
        rows="".join(rows),
        total=len(entries),
    )


_STYLE = """
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { background: #1a1a1a; color: #e0e0e0; font-family: 'Courier New', monospace; line-height: 1.5; }
        .banner { display: block; width: 100%; height: auto; }
        .banner-header { margin-bottom: 2rem; }
        .banner-footer { margin-top: 2rem; }
        .container { max-width: 1400px; margin: 0 auto; padding: 20px; }
        a { color: #66bbff; text-decoration: none; }
        a:hover { text-decoration: underline; }
        h1 { color: #66ccff; font-size: 2.4em; text-align: center; margin: 24px 0 6px; text-shadow: 0 0 14px rgba(102,204,255,.4); }
        h2 { color: #9cf; font-size: 1.2em; margin: 28px 0 8px; }
        .subtitle { text-align: center; color: #888; font-size: 1em; margin-bottom: 4px; }
        .commit, .summary { text-align: center; color: #888; font-size: .9em; margin-bottom: 8px; }
        .commit code { background: #2a2a2a; padding: 2px 6px; border-radius: 3px; }
        .summary .ok { color: #6ce26c; }
        .summary .bad { color: #ff6644; }
        .nav { display: flex; justify-content: center; gap: 8px; margin: 18px 0 6px; flex-wrap: wrap; }
        .nav a { background: #232323; border: 1px solid #333; border-radius: 4px; padding: 8px 18px; color: #ddd; font-weight: bold; text-transform: uppercase; font-size: .85em; letter-spacing: .04em; }
        .nav a:hover { border-color: #66bbff; text-decoration: none; }
        .nav a.active { background: #66bbff; color: #111; border-color: #66bbff; }
        .tab { display: none; }
        .tab-desc { text-align: center; color: #999; font-size: .85em; margin: 10px auto 0; max-width: 900px; }
        .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(420px, 1fr)); gap: 14px; margin-top: 24px; }
        .card { background: #232323; border: 1px solid #333; border-radius: 4px; padding: 12px; }
        .card-gap { border-color: #a60; }
        .card h3 { font-size: 1.05em; margin-bottom: 4px; color: #ddd; }
        .status { float: right; font-size: .75em; padding: 1px 6px; border-radius: 3px; font-weight: bold; }
        .status-pass { background: #1a4; color: #e8ffe8; }
        .status-gap { background: #a60; color: #fff3e0; }
        .blurb { color: #888; font-size: .85em; margin-bottom: 8px; min-height: 1.2em; }
        .blurb code { color: #7a7; }
        .row { display: flex; gap: 6px; }
        .face-row { display: flex; align-items: center; gap: 10px; margin-bottom: 8px; }
        .face-row .tier { flex: 0 0 88px; font-size: .78em; text-transform: uppercase; color: #f0d878; letter-spacing: .05em; }
        .face-row .tier em { color: #777; text-transform: none; }
        .face-row .row { flex: 1; }
        .thumb { position: relative; flex: 1; display: block; border: 1px solid #333; background: #000; overflow: hidden; }
        .thumb img { display: block; width: 100%; image-rendering: auto; }
        .thumb span { position: absolute; top: 4px; left: 4px; background: rgba(0,0,0,.75); color: #f0d878; padding: 1px 5px; font-size: .7em; font-weight: bold; text-transform: uppercase; }
        .thumb:hover { border-color: #66bbff; }
        .thumb-missing { border-style: dashed; border-color: #a60; background: repeating-linear-gradient(45deg, #241c10, #241c10 8px, #1d1710 8px, #1d1710 16px); min-height: 92px; }
        .missing-body { display: flex; align-items: center; justify-content: center; height: 100%; min-height: 92px; color: #d97; font-size: .8em; font-weight: bold; letter-spacing: .1em; }
        .cov { border-collapse: collapse; width: 100%; font-size: .85em; margin-top: 10px; }
        .cov th, .cov td { border: 1px solid #333; padding: 4px 10px; text-align: right; }
        .cov th:first-child, .cov td:first-child { text-align: left; }
        .cov thead th { background: #2a2a2a; color: #9cf; }
        .cov tfoot th { background: #2a2a2a; color: #ddd; }
        .cov .row-gap td { color: #e9a; }
        .scope { color: #999; font-size: .85em; max-width: 900px; }
        .scope code { color: #7a7; }
        .empty-state { text-align: center; color: #666; padding: 60px 20px; border: 1px dashed #333; border-radius: 6px; margin-top: 24px; }
        footer { text-align: center; color: #555; margin-top: 50px; padding: 20px; border-top: 1px solid #333; }
"""

_SCRIPT = """
        document.addEventListener('DOMContentLoaded', function () {
            var links = document.querySelectorAll('.nav a[data-tab]');
            var tabs  = document.querySelectorAll('section.tab');
            function activate(tab) {
                var known = false;
                tabs.forEach(function (s) {
                    var on = s.getAttribute('data-tab') === tab;
                    if (on) known = true;
                    s.style.display = on ? 'block' : 'none';
                });
                if (!known) return activate(DEFAULT_TAB);
                links.forEach(function (a) {
                    a.classList.toggle('active', a.getAttribute('data-tab') === tab);
                });
                document.body.id = tab;
            }
            links.forEach(function (a) {
                a.addEventListener('click', function (ev) { ev.preventDefault(); activate(a.getAttribute('data-tab')); });
            });
            activate((location.hash || '').replace('#', '') || DEFAULT_TAB);
        });
"""


def render_html(
    entries: List[Entry],
    artifacts: Dict[str, Dict[str, Path]],
    strict_faces: List[str],
    ui_v2_html: str,
    ui_v2_summary: Dict[str, object],
    commit: str,
    baseline_dir: Path,
) -> str:
    by_cat: Dict[str, List[Entry]] = {cid: [] for cid, _, _ in CATEGORIES}
    for e in entries:
        by_cat[e.category].append(e)

    n_scenes = len(entries)
    # The only coverage verdict left after the platform collapse: a promoted
    # face whose required tiers are not all pinned. Every OTHER card on the page
    # exists because its PNG does, so it cannot be a gap.
    n_gap = len(ui_v2_summary["gapped"])  # type: ignore[arg-type]
    n_diff = sum(1 for e in entries if e.stem in artifacts)

    nav: List[str] = []
    sections: List[str] = []
    for cid, label, desc in CATEGORIES:
        group = by_cat[cid]
        nav.append(
            '<a href="#{cid}" data-tab="{cid}">{label} ({n})</a>'.format(
                cid=cid, label=html.escape(label), n=len(group)
            )
        )
        if cid == "ui-v2":
            body = (
                '<div class="grid">{}</div>'.format(ui_v2_html)
                if ui_v2_html
                else '<div class="empty-state">STRICT_FACES is empty.</div>'
            )
        elif group:
            body = '<div class="grid">{}</div>'.format(
                render_scene_cards(group, artifacts)
            )
        else:
            body = (
                '<div class="empty-state">No baselines in this category yet — '
                "capture some via <code>task vrt:update</code>.</div>"
            )
        sections.append(
            '<section class="tab" data-tab="{cid}"><p class="tab-desc">{desc}</p>{body}</section>'.format(
                cid=cid, desc=html.escape(desc), body=body
            )
        )

    nav.append('<a href="#coverage" data-tab="coverage">Coverage</a>')
    sections.append(
        '<section class="tab" data-tab="coverage">{}</section>'.format(
            render_coverage_table(entries, baseline_dir)
        )
    )

    commit_strip = (
        '<p class="commit">Generated from <code>{}</code></p>'.format(
            html.escape(commit)
        )
        if commit
        else ""
    )
    summary = (
        '<p class="summary">{scenes} scenes · one committed baseline each · '
        '{faces} curated faces, <span class="{gcls}">{gap} with a missing '
        "tier</span>{diff}</p>".format(
            scenes=n_scenes,
            gcls="bad" if n_gap else "ok",
            gap=n_gap,
            diff=(
                ' · <span class="bad">{} diffed</span>'.format(n_diff) if n_diff else ""
            ),
            faces=len(strict_faces),
        )
    )

    return """<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>patchtogether.live — VRT gallery</title>
    <style>{style}</style>
    <script>
        var DEFAULT_TAB = 'ui-v2';
{script}
    </script>
</head>
<body id="ui-v2">
    <img class="banner banner-header" src="../assets/header.png" alt="patchtogether.live header banner">
    <div class="container">
        <h1>VRT GALLERY</h1>
        <p class="subtitle">Playwright screenshot baselines for patchtogether.live —
        <strong>one</strong> committed baseline per scene, captured by linux CI</p>
        {summary}
        {commit_strip}
        <nav class="nav">{nav}</nav>
        {sections}
        <footer>
            <p><a href="../">&laquo; back</a> &middot;
            <a href="https://github.com/2600hz-oscillator/patchtogether.live">repo</a></p>
        </footer>
    </div>
    <img class="banner banner-footer" src="../assets/footer.png" alt="patchtogether.live footer banner" loading="lazy">
</body>
</html>
""".format(
        style=_STYLE,
        script=_SCRIPT,
        summary=summary,
        commit_strip=commit_strip,
        nav="".join(nav),
        sections="".join(sections),
    )


# ---------------------------------------------------------------------------
# MAIN
# ---------------------------------------------------------------------------


def main() -> int:
    here = Path(__file__).resolve().parent
    default_faces = (
        here.parent.parent / "packages/web/src/lib/ui/workflow/strict-faces.ts"
    )

    p = argparse.ArgumentParser(description="Render the VRT baseline gallery.")
    p.add_argument("--baseline-dir", type=Path, required=True)
    p.add_argument("--results-dir", type=Path, required=False)
    p.add_argument("--output-dir", type=Path, required=True)
    p.add_argument(
        "--strict-faces",
        type=Path,
        default=default_faces,
        help="strict-faces.ts — the LIVE source for the UI v2 tab (never a copy).",
    )
    args = p.parse_args()

    if not args.baseline_dir.is_dir():
        sys.stderr.write("error: baseline dir not found: {}\n".format(args.baseline_dir))
        return 1

    strict_faces = parse_strict_faces(args.strict_faces)
    entries = list_entries(args.baseline_dir, frozenset(strict_faces))
    assert_total_categorization(entries)

    odd = unexpected_subdirs(args.baseline_dir)
    if odd:
        sys.stderr.write(
            "warning: SUBDIRECTORY(ies) inside a spec dir, where only *.png belongs "
            "— anything they hold is NOT rendered and NOT counted. A leftover "
            "darwin/ or linux/ from before the 2026-08-10 platform collapse is the "
            "likely cause: {}\n".format(", ".join(odd))
        )

    if not entries:
        sys.stderr.write(
            "warning: no baselines under {} — capture them via `task vrt:commit` "
            "(vrt-update.yml on linux CI) first.\n".format(args.baseline_dir)
        )

    for sub in ("baselines", "actual", "diff"):
        (args.output_dir / sub).mkdir(parents=True, exist_ok=True)

    for e in entries:
        if e.image is not None:
            copy_image(e.image, args.output_dir / rel_image(e))

    artifacts = list_run_artifacts(args.results_dir)
    for stem, kinds in artifacts.items():
        for kind, src in kinds.items():
            copy_image(src, args.output_dir / kind / "{}.png".format(stem))

    by_face: Dict[Tuple[str, str], Entry] = {}
    for e in entries:
        fk = face_key(e.spec, e.stem, frozenset(strict_faces))
        if fk is not None:
            by_face[fk] = e
    ui_v2_html, ui_v2_summary = render_ui_v2(strict_faces, by_face)

    # ORPHANS, both directions. A `face-<x>-dock` baseline whose module is not
    # on the ratchet is reported here rather than silently filed under
    # "composite" — that is the direction a hand-copied list can never fail in,
    # and it is the one that goes stale after a demotion.
    orphan_faces = sorted(
        e.key
        for e in entries
        if (
            e.spec in ("workflow-shell-faces.spec.ts", "workflow-rear-card.spec.ts")
            and face_key(e.spec, e.stem, frozenset(strict_faces)) is None
        )
    )

    coverage = {
        "baselineDir": str(args.baseline_dir),
        "specDirs": sorted({e.spec for e in entries}),
        "scenes": len(entries),
        "byCategory": {
            cid: sorted(e.key for e in entries if e.category == cid)
            for cid, _, _ in CATEGORIES
        },
        "rendered": sorted(e.key for e in entries),
        "unexpectedSubdirs": odd,
        "orphanFaceScenes": orphan_faces,
        "uiV2": ui_v2_summary,
    }
    (args.output_dir / "coverage.json").write_text(
        json.dumps(coverage, indent=2, sort_keys=True) + "\n", encoding="utf8"
    )

    index = args.output_dir / "index.html"
    index.write_text(
        render_html(
            entries,
            artifacts,
            strict_faces,
            ui_v2_html,
            ui_v2_summary,
            repo_short_sha(),
            args.baseline_dir,
        ),
        encoding="utf8",
    )

    print(
        "  wrote {} ({} scenes across {} spec dirs; {} curated faces, {} at 1:1)".format(
            index,
            coverage["scenes"],
            len(coverage["specDirs"]),
            len(strict_faces),
            len(ui_v2_summary["fullParity"]),
        )
    )
    if orphan_faces:
        print("  ORPHAN face scenes (not on the STRICT_FACES ratchet): {}".format(
            ", ".join(orphan_faces)
        ))
    return 0


if __name__ == "__main__":
    sys.exit(main())
