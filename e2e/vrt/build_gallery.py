#!/usr/bin/env python3
"""build_gallery.py — render the static HTML catalog of VRT baselines
(docs/vrt), plus a machine-readable coverage.json for the gate that checks it.

---------------------------------------------------------------------------
WHAT CHANGED (2026-08-02) AND WHY IT MATTERED
---------------------------------------------------------------------------
This gallery used to key every entry by the PNG's BARE STEM:

    found[category][png.stem] = png          # <- darwin and linux collide

`__screenshots__/<spec>/darwin/adsr.png` and `.../linux/adsr.png` have the same
stem, so the second one walked overwrote the first. 416 committed PNGs
collapsed into 282 cards, each showing ONE arbitrary platform (whichever
`rglob` yielded last), and the page said "282 baselines" — a count of SCENES
presented as a count of BASELINES.

That is the exact failure this repo has now hit four times: a metric blind to
the dimension under test returns a clean, plausible number. The dimension under
test here is PLATFORM. CI renders on LINUX, so a scene captured on darwin and
never captured on linux contributes ZERO regression protection — and the old
gallery rendered it identically to a fully-covered scene. A parity gap was not
merely un-highlighted, it was structurally invisible.

So the inventory is now keyed by `(spec_dir, stem)` and holds BOTH platforms,
every card shows darwin and linux SIDE BY SIDE, and a missing platform renders
as a loud MISSING tile rather than as nothing at all.

---------------------------------------------------------------------------
DIRECTORY SCOPE — STATED, BECAUSE AN UNSTATED SCOPE READS AS FULL COVERAGE
---------------------------------------------------------------------------
Two gates in this repo were silently narrow because they only ever built the
`__screenshots__/vrt.spec.ts/…` path and nothing said so (CLAUDE.md: "state a
gate's directory scope in the gate"). This one walks EVERY
`__screenshots__/*/<platform>/*.png`, the category assignment is TOTAL (every
entry lands in exactly one tab — asserted, not assumed), and the scope is
printed on the page itself along with the per-directory table.

What this gallery can and cannot tell you:
  ✓ which scenes have a committed baseline, and on which platforms
  ✓ where darwin and linux disagree about what is covered
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
two required tiers), plus the REAR card where one exists, each on BOTH
platforms. A module is `1:1` only when every required tier is pinned on darwin
AND linux.

⚠ A parser that silently matches nothing returns a clean-looking empty page, so
`parse_strict_faces()` HARD-FAILS on an empty parse, and the parsed list is
written into coverage.json where `build-gallery.test.ts` compares it against the
TypeScript module imported for real. A regex that drifts from the source is a
red test, not a quietly missing tab.

---------------------------------------------------------------------------
Inputs / outputs
---------------------------------------------------------------------------
  --baseline-dir   e2e/vrt/__screenshots__/<spec>/<platform>/<stem>.png
  --results-dir    e2e/vrt/test-results  (optional; a green run has none)
  --strict-faces   packages/web/src/lib/ui/workflow/strict-faces.ts
  --output-dir     docs/vrt

  <output-dir>/index.html
  <output-dir>/coverage.json                        — the machine summary
  <output-dir>/baselines/<platform>/<spec>/<stem>.png
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

# The platform CI gates on, and the one most baselines are authored on first.
# Kept in the same order everywhere so the two thumbnails never swap places.
PLATFORMS: Tuple[str, str] = ("darwin", "linux")
GATING_PLATFORM = "linux"
AUTHORING_PLATFORM = "darwin"

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
    "warrenspectrum": "Stereo 8-band filterbank + acidwarp viz.",
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
        "compact lane tile + dock full-view (+ rear card where one exists), "
        "on both platforms.",
    ),
    (
        "modules",
        "Modules",
        "Per-card solo baselines from vrt.spec.ts — one scene per registered module.",
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
    if spec_dir == "vrt.spec.ts":
        return "modules"
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
    """One SCENE — a `(spec_dir, stem)` pair — and its per-platform baselines.

    The old gallery had no such object: it had a dict keyed by stem alone, so
    the platform dimension had nowhere to live and the second PNG overwrote the
    first. Everything about parity visibility follows from this shape.
    """

    __slots__ = ("spec", "stem", "images", "category")

    def __init__(self, spec: str, stem: str) -> None:
        self.spec = spec
        self.stem = stem
        self.images: Dict[str, Path] = {}
        self.category = "composite"

    @property
    def key(self) -> str:
        return "{}/{}".format(self.spec, self.stem)

    @property
    def platforms(self) -> List[str]:
        return [p for p in PLATFORMS if p in self.images]

    @property
    def parity(self) -> str:
        """`both` | `darwin-only` | `linux-only`. `darwin-only` is the one that
        matters: CI gates on linux, so that scene is never diffed where it
        counts."""
        have = self.platforms
        if len(have) == len(PLATFORMS):
            return "both"
        return "{}-only".format(have[0]) if have else "none"


def list_entries(baseline_dir: Path, strict_faces: frozenset) -> List[Entry]:
    """Walk EVERY `<baseline_dir>/<spec>/<platform>/<stem>.png`.

    Deliberately walks the whole tree rather than a known list of spec dirs —
    a directory nobody registered still shows up (in `composite`, the catch-all)
    instead of vanishing.
    """
    entries: Dict[Tuple[str, str], Entry] = {}
    for spec_path in sorted(p for p in baseline_dir.iterdir() if p.is_dir()):
        for platform in PLATFORMS:
            pdir = spec_path / platform
            if not pdir.is_dir():
                continue
            for png in sorted(pdir.glob("*.png")):
                k = (spec_path.name, png.stem)
                e = entries.get(k)
                if e is None:
                    e = Entry(spec_path.name, png.stem)
                    e.category = categorize(spec_path.name, png.stem, strict_faces)
                    entries[k] = e
                e.images[platform] = png
    return [entries[k] for k in sorted(entries)]


def unexpected_platform_dirs(baseline_dir: Path) -> List[str]:
    """Platform dirs under a spec dir that are neither darwin nor linux.

    A THIRD platform would be silently dropped by every loop above, and the
    counts would still look consistent. Report it instead.
    """
    odd: List[str] = []
    for spec_path in sorted(p for p in baseline_dir.iterdir() if p.is_dir()):
        for child in sorted(spec_path.iterdir()):
            if child.is_dir() and child.name not in PLATFORMS:
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
    the only handle is the stem — a run artifact carries no spec-dir. Stems are
    unique across the tree today (vrt-platform-gaps' `collidingSceneStems()`
    asserts it), so the attach is unambiguous; if that ever stops being true
    the worst case is a card showing a sibling's diff, never a false "match".
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


def rel_image(entry: Entry, platform: str) -> str:
    """Output-relative href. Includes the platform AND the spec dir, so two
    scenes can never overwrite each other on the way out — the collapse this
    rewrite fixes happened on the way IN, and re-introducing it on the way out
    would be the same bug wearing a different hat."""
    return "baselines/{}/{}/{}.png".format(platform, entry.spec, entry.stem)


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


def _platform_thumbs(entry: Entry) -> str:
    out: List[str] = []
    for p in PLATFORMS:
        if p in entry.images:
            out.append(_thumb(rel_image(entry, p), p, "{} on {}".format(entry.stem, p)))
        else:
            why = (
                "no {} baseline committed for {} — this scene is NEVER diffed on "
                "the platform CI gates on".format(p, entry.stem)
                if p == GATING_PLATFORM
                else "no {} baseline committed for {}".format(p, entry.stem)
            )
            out.append(_missing(p, why))
    return "".join(out)


def _blurb_for(entry: Entry) -> str:
    if entry.category == "modules":
        return MODULE_BLURB.get(entry.stem, "")
    return COMPOSITE_BLURB.get(entry.stem, "")


def render_scene_cards(
    entries: List[Entry], artifacts: Dict[str, Dict[str, Path]]
) -> str:
    cards: List[str] = []
    for e in entries:
        art = artifacts.get(e.stem, {})
        parity = e.parity
        status_cls = "pass" if parity == "both" else "gap"
        thumbs = [_platform_thumbs(e)]
        for kind in ("actual", "diff"):
            if kind in art:
                thumbs.append(_thumb("{}/{}.png".format(kind, e.stem), kind, e.stem))
        blurb = _blurb_for(e)
        cards.append(
            """
    <article id="{anchor}" class="card card-{cls}">
        <h3>{stem} <span class="status status-{cls}">{parity}</span></h3>
        <p class="blurb"><code>{spec}</code>{blurb}</p>
        <div class="row">{thumbs}</div>
    </article>""".format(
                anchor=html.escape(e.key),
                stem=html.escape(e.stem),
                cls=status_cls,
                parity=html.escape(parity),
                spec=html.escape(e.spec),
                blurb=(" · " + html.escape(blurb)) if blurb else "",
                thumbs="".join(thumbs),
            )
        )
    return "".join(cards)


def render_ui_v2(
    strict_faces: List[str], by_face: Dict[Tuple[str, str], Entry]
) -> Tuple[str, Dict[str, object]]:
    """The UI v2 tab: one section per STRICT_FACES module, a row per tier,
    darwin and linux side by side. Returns (html, summary)."""
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
                cells = "".join(
                    _missing(p, "no {} baseline for face {} ({})".format(p, module, tier))
                    for p in PLATFORMS
                )
                if required:
                    missing.append("{}: no baseline on either platform".format(tier))
            else:
                cells = _platform_thumbs(entry)
                if required and entry.parity != "both":
                    missing.append("{}: {}".format(tier, entry.parity))
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
    summary = {
        "strictFaces": strict_faces,
        "fullParity": full_parity,
        "gapped": gapped,
    }
    return "".join(sections), summary


def render_coverage_table(entries: List[Entry], baseline_dir: Path) -> str:
    per_spec: Dict[str, List[int]] = {}
    for e in entries:
        row = per_spec.setdefault(e.spec, [0, 0, 0])
        if AUTHORING_PLATFORM in e.images:
            row[0] += 1
        if GATING_PLATFORM in e.images:
            row[1] += 1
        if e.parity != "both":
            row[2] += 1
    rows = []
    for spec in sorted(per_spec):
        d, l, gap = per_spec[spec]
        rows.append(
            '<tr class="{cls}"><td><code>{s}</code></td><td>{d}</td><td>{l}</td>'
            "<td>{g}</td></tr>".format(
                cls="row-gap" if gap else "row-ok",
                s=html.escape(spec),
                d=d,
                l=l,
                g=gap or "—",
            )
        )
    td = sum(1 for e in entries if AUTHORING_PLATFORM in e.images)
    tl = sum(1 for e in entries if GATING_PLATFORM in e.images)
    tg = sum(1 for e in entries if e.parity != "both")
    return """
        <h2>Directory scope</h2>
        <p class="scope">This gallery reads <strong>every</strong>
        <code>{root}/&lt;spec&gt;/&lt;platform&gt;/*.png</code> — all
        <strong>{n}</strong> spec directories below, not just
        <code>vrt.spec.ts</code>. Two gates in this repo were silently narrow
        because they only ever resolved that one directory and nothing said so;
        an unstated scope reads as full coverage.</p>
        <p class="scope">It reports what is <em>committed</em>. It cannot tell
        you whether a committed PNG still <em>matches</em> today's render — only
        a VRT run does that, and a sub-tolerance drift is invisible to that run
        too.</p>
        <table class="cov">
          <thead><tr><th>spec directory</th><th>darwin</th><th>linux</th><th>gap</th></tr></thead>
          <tbody>{rows}</tbody>
          <tfoot><tr><th>TOTAL ({n} dirs)</th><th>{td}</th><th>{tl}</th><th>{tg}</th></tr></tfoot>
        </table>""".format(
        root=html.escape(str(baseline_dir)),
        n=len(per_spec),
        rows="".join(rows),
        td=td,
        tl=tl,
        tg=tg,
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
    commit: str,
    baseline_dir: Path,
) -> str:
    by_cat: Dict[str, List[Entry]] = {cid: [] for cid, _, _ in CATEGORIES}
    for e in entries:
        by_cat[e.category].append(e)

    n_scenes = len(entries)
    n_images = sum(len(e.images) for e in entries)
    n_gap = sum(1 for e in entries if e.parity != "both")
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
        '<p class="summary">{scenes} scenes · {images} baseline PNGs · '
        '<span class="{gcls}">{gap} platform gap{plural}</span>'
        "{diff} · {faces} curated faces</p>".format(
            scenes=n_scenes,
            images=n_images,
            gcls="bad" if n_gap else "ok",
            gap=n_gap,
            plural="" if n_gap == 1 else "s",
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
        every scene on <strong>both</strong> platforms, side by side</p>
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

    odd = unexpected_platform_dirs(args.baseline_dir)
    if odd:
        sys.stderr.write(
            "warning: platform dir(s) that are neither darwin nor linux and are "
            "therefore NOT rendered: {}\n".format(", ".join(odd))
        )

    if not entries:
        sys.stderr.write(
            "warning: no baselines under {} — run `task vrt:update` first.\n".format(
                args.baseline_dir
            )
        )

    for sub in ("baselines", "actual", "diff"):
        (args.output_dir / sub).mkdir(parents=True, exist_ok=True)

    for e in entries:
        for platform, src in e.images.items():
            copy_image(src, args.output_dir / rel_image(e, platform))

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
        "platforms": list(PLATFORMS),
        "gatingPlatform": GATING_PLATFORM,
        "scenes": len(entries),
        "images": sum(len(e.images) for e in entries),
        "byPlatform": {
            p: sum(1 for e in entries if p in e.images) for p in PLATFORMS
        },
        "gaps": sorted(e.key for e in entries if e.parity != "both"),
        "byCategory": {
            cid: sorted(e.key for e in entries if e.category == cid)
            for cid, _, _ in CATEGORIES
        },
        "rendered": sorted(e.key for e in entries),
        "unexpectedPlatformDirs": odd,
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
            repo_short_sha(),
            args.baseline_dir,
        ),
        encoding="utf8",
    )

    gaps = len(coverage["gaps"])
    print(
        "  wrote {} ({} scenes / {} PNGs across {} spec dirs; {} darwin, {} linux, "
        "{} platform gap(s); {} curated faces, {} at 1:1)".format(
            index,
            coverage["scenes"],
            coverage["images"],
            len(coverage["specDirs"]),
            coverage["byPlatform"][AUTHORING_PLATFORM],
            coverage["byPlatform"][GATING_PLATFORM],
            gaps,
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
