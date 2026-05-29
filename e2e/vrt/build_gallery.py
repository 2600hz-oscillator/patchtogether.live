#!/usr/bin/env python3
"""build_gallery.py — render a static HTML gallery of VRT baselines + the
latest run's actual / diff images, modeled on doom_viz's build_gallery.py.

The gallery has TWO categories, surfaced as a top-of-page nav (tab toggle
inside a single HTML page — keeps the build trivially static + the URL
stable for deep links via `#<entry-id>`):

  1. Modules         — per-card VRT baselines (the original gallery).
                       Captured by `vrt.spec.ts` + `vrt-wavesculpt-blink.spec.ts`.
  2. Composite States — multi-module scenes wired with a patch cord,
                       showing one module's signal driving another into a
                       deterministic state. Captured by
                       `vrt-composite.spec.ts`. New in this PR; first
                       entries are the NIBBLES.length_cv → QBRT.cutoff_cv
                       5-step CV sweep.

Inputs:
  --baseline-dir   e2e/vrt/__screenshots__/<spec-path>/<platform>/<arg>.png
  --results-dir    e2e/vrt/test-results (Playwright outputDir)
  --output-dir     docs/vrt

Output layout:
  <output-dir>/index.html               — landing page with nav + grids
  <output-dir>/baselines/<id>.png       — copied from baselines
  <output-dir>/actual/<id>.png          — present iff the last run failed
  <output-dir>/diff/<id>.png            — present iff the last run failed

Note: the gallery is content-addressed by stem (the `<arg>.png` basename).
Stems must be unique across the entire baseline tree — they are today
(module types vs. composite scene ids).

Playwright's failure artifacts naming, per test-results-by-default:
  test-results/<config-name>-<file>-<test>-chromium-vrt/
    <arg>-actual.png
    <arg>-diff.png
    <arg>-expected.png

We resolve module type from the snapshot filename (`<type>.png`), copy or
link the latest actual/diff into <output-dir>/actual + diff, then emit the
gallery. If --results-dir is missing or empty (green run), we only render
baselines — that's the steady-state view.

Pure-stdlib: no Pillow needed (PNGs are passed through, not transcoded).
"""

from __future__ import annotations

import argparse
import html
import re
import shutil
import subprocess
import sys
from pathlib import Path


# Per-module blurb. Drives the alt text + gallery section subtitle.
# Keep terse; the gallery is for reviewers, not first-time users.
MODULE_BLURB: dict[str, str] = {
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
    "riotgirls": "Wavefolder / shaper chain.",
    "score": "Step-score module (4x4x4 pages).",
    "drumseqz": "4-channel drum sequencer.",
    "polyseqz": "Polyphonic step sequencer.",
    "vizvco": "VIZVCO — VCO + wavefolder + waveform video out.",
    "wavviz": "WAVVIZ — sister VCO with video out.",
    "swolevco": "SWOLEVCO — Buchla-259-style complex VCO.",
    "illogic": "Attenuverter + math + logic.",
    "unityscalemathematik": "Bipolar CV-shaper.",
    "dx7": "DX7 — pure-TS 6-op FM synth.",
    "noise": "Noise source (white/pink/brown).",
    "buggles": "Wogglebug-style chaotic CV.",
    "wavecel": "WAVECEL — stereo wavetable VCO + 3D viz.",
    "warrenspectrum": "Stereo 8-band filterbank + acidwarp viz.",
    "stereovca": "Stereo VCA + ring modulator.",
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
}


# Per-composite-scene blurb. Composite scenes are signal-flow demos —
# the blurb should call out what's wired to what + why the screenshot is
# the "interesting" state.
COMPOSITE_BLURB: dict[str, str] = {
    "nibbles-qbrt-cv-min": (
        "NIBBLES.length_cv ≈ −0.98 → QBRT.cutoff_cv. CV minimum (snake length=1)."
    ),
    "nibbles-qbrt-cv-25": (
        "NIBBLES.length_cv ≈ −0.50 → QBRT.cutoff_cv. CV at 25% of the sweep (length=30)."
    ),
    "nibbles-qbrt-cv-50": (
        "NIBBLES.length_cv ≈ +0.01 → QBRT.cutoff_cv. CV at the midpoint (length=60)."
    ),
    "nibbles-qbrt-cv-75": (
        "NIBBLES.length_cv ≈ +0.50 → QBRT.cutoff_cv. CV at 75% of the sweep (length=89)."
    ),
    "nibbles-qbrt-cv-max": (
        "NIBBLES.length_cv = +1.00 → QBRT.cutoff_cv. CV maximum (snake length=119)."
    ),
}


# Spec-file basename → category id. Anything not matched falls back to
# "modules" so a future spec auto-enrols there if someone forgets to
# register it.
_SPEC_TO_CATEGORY: dict[str, str] = {
    "vrt.spec.ts": "modules",
    "vrt-wavesculpt-blink.spec.ts": "modules",
    "vrt-composite.spec.ts": "composite",
}


def repo_short_sha() -> str:
    """HEAD short SHA, or '' if not a repo."""
    try:
        out = subprocess.check_output(
            ["git", "rev-parse", "--short", "HEAD"], stderr=subprocess.DEVNULL,
        )
        return out.decode().strip()
    except (subprocess.CalledProcessError, FileNotFoundError):
        return ""


def list_baselines(baseline_dir: Path) -> dict[str, dict[str, Path]]:
    """Walk `baseline_dir` and bucket each baseline PNG into a category.

    Returns a dict shaped:
      {
        "modules":   { "<stem>": <path>, ... },
        "composite": { "<stem>": <path>, ... },
      }

    The path layout is `<baseline_dir>/<spec-file>/<platform>/<stem>.png`;
    we resolve the category by looking at the spec-file parent. Unknown
    specs fall back to "modules" (the historical bucket).
    """
    found: dict[str, dict[str, Path]] = {"modules": {}, "composite": {}}
    for png in baseline_dir.rglob("*.png"):
        # Resolve the spec-file dir relative to baseline_dir. Layout:
        #   <baseline_dir>/<spec.spec.ts>/<platform>/<stem>.png
        try:
            rel = png.relative_to(baseline_dir)
        except ValueError:
            continue
        parts = rel.parts
        if len(parts) < 2:
            continue
        spec_dir = parts[0]
        category = _SPEC_TO_CATEGORY.get(spec_dir, "modules")
        found[category][png.stem] = png
    return found


# Playwright writes failure artifacts under
#   test-results/<file>-<test>-chromium-vrt/<arg>-actual.png
#   test-results/<file>-<test>-chromium-vrt/<arg>-diff.png
# The <test> slug is sanitised from the test title — for our suite it
# starts with the module type. We resolve back to the type by parsing the
# arg filename which is `<type>-actual.png` / `<type>-diff.png`.
_ARTIFACT_RE = re.compile(r"^(?P<stem>[a-zA-Z0-9_-]+)-(?P<kind>actual|diff)\.png$")


def list_run_artifacts(results_dir: Path) -> dict[str, dict[str, Path]]:
    """Map baseline stem → {"actual": Path, "diff": Path} for last failed run.

    The stem is shared across the Modules + Composite categories (we assume
    stem uniqueness across the baseline tree — true today). When in doubt
    the gallery falls back to "match" status, not a false-positive DIFF.
    """
    found: dict[str, dict[str, Path]] = {}
    if not results_dir.is_dir():
        return found
    for png in results_dir.rglob("*.png"):
        m = _ARTIFACT_RE.match(png.name)
        if not m:
            continue
        stem = m.group("stem")
        kind = m.group("kind")
        found.setdefault(stem, {})[kind] = png
    return found


def copy_image(src: Path, dst: Path) -> None:
    dst.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(src, dst)


def _render_cards(
    stems: list[str],
    artifacts: dict[str, dict[str, Path]],
    blurbs: dict[str, str],
) -> tuple[str, int, int]:
    """Render the cards grid for one category. Returns (html, total, failed)."""
    cards: list[str] = []
    n_total = len(stems)
    n_failed = 0
    for s in stems:
        blurb = blurbs.get(s, "")
        has_diff = s in artifacts
        if has_diff:
            n_failed += 1
        status_cls = "fail" if has_diff else "pass"
        status_label = "DIFF" if has_diff else "match"

        # baseline always present (we list from baselines/)
        b = f"baselines/{s}.png"
        thumbs = [
            f'<a href="{b}" class="thumb"><img loading="lazy" src="{b}" alt="{s} baseline"><span>baseline</span></a>'
        ]
        if has_diff:
            if "actual" in artifacts[s]:
                a = f"actual/{s}.png"
                thumbs.append(
                    f'<a href="{a}" class="thumb"><img loading="lazy" src="{a}" alt="{s} actual"><span>actual</span></a>'
                )
            if "diff" in artifacts[s]:
                d = f"diff/{s}.png"
                thumbs.append(
                    f'<a href="{d}" class="thumb"><img loading="lazy" src="{d}" alt="{s} diff"><span>diff</span></a>'
                )

        cards.append(f"""
    <article id="{html.escape(s)}" class="card card-{status_cls}">
        <h3>{html.escape(s)} <span class="status status-{status_cls}">{status_label}</span></h3>
        <p class="blurb">{html.escape(blurb)}</p>
        <div class="row">{''.join(thumbs)}</div>
    </article>""")
    return "".join(cards), n_total, n_failed


def render_html(
    bucketed: dict[str, dict[str, Path]],
    artifacts: dict[str, dict[str, Path]],
    commit: str,
) -> str:
    module_stems = sorted(bucketed["modules"].keys())
    composite_stems = sorted(bucketed["composite"].keys())

    modules_html, modules_total, modules_failed = _render_cards(
        module_stems, artifacts, MODULE_BLURB,
    )
    composite_html, composite_total, composite_failed = _render_cards(
        composite_stems, artifacts, COMPOSITE_BLURB,
    )

    n_total = modules_total + composite_total
    n_failed = modules_failed + composite_failed

    commit_strip = (
        f'<p class="commit">Generated from <code>{html.escape(commit)}</code></p>'
        if commit
        else ""
    )
    summary = (
        f'<p class="summary">{n_total} baselines · '
        f'<span class="ok">{n_total - n_failed} passing</span>'
        + (f' · <span class="bad">{n_failed} diffed</span>' if n_failed else "")
        + f' · {modules_total} modules · {composite_total} composite</p>'
    )

    return f"""<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>patchtogether.live — VRT gallery</title>
    <style>
        * {{ margin: 0; padding: 0; box-sizing: border-box; }}
        body {{
            background: #1a1a1a;
            color: #e0e0e0;
            font-family: 'Courier New', monospace;
            line-height: 1.5;
        }}
        /* Banners are full-bleed — they cross the 1400px content gutter
           on wide screens because the kaleidoscope X-shape reads better
           edge-to-edge than constrained to the column width. */
        .banner {{ display: block; width: 100%; height: auto; }}
        .banner-header {{ margin-bottom: 2rem; }}
        .banner-footer {{ margin-top: 2rem; }}
        .container {{ max-width: 1400px; margin: 0 auto; padding: 20px; }}
        a {{ color: #66bbff; text-decoration: none; }}
        a:hover {{ text-decoration: underline; }}
        h1 {{
            color: #66ccff;
            font-size: 2.4em;
            text-align: center;
            margin: 24px 0 6px;
            text-shadow: 0 0 14px rgba(102, 204, 255, 0.4);
        }}
        .subtitle {{ text-align: center; color: #888; font-size: 1em; margin-bottom: 4px; }}
        .commit, .summary {{ text-align: center; color: #888; font-size: 0.9em; margin-bottom: 8px; }}
        .commit code {{ background: #2a2a2a; padding: 2px 6px; border-radius: 3px; }}
        .summary .ok {{ color: #6ce26c; }}
        .summary .bad {{ color: #ff6644; }}
        /* Top-of-page nav: tab toggles between Modules + Composite States.
           Pure CSS via :target — no JS so the gallery stays a flat static
           file. The default (no fragment) shows Modules. */
        .nav {{
            display: flex;
            justify-content: center;
            gap: 8px;
            margin: 18px 0 6px;
        }}
        .nav a {{
            background: #232323;
            border: 1px solid #333;
            border-radius: 4px;
            padding: 8px 18px;
            color: #ddd;
            font-weight: bold;
            text-transform: uppercase;
            font-size: 0.85em;
            letter-spacing: 0.04em;
        }}
        .nav a:hover {{ border-color: #66bbff; text-decoration: none; }}
        .nav a.active {{
            background: #66bbff;
            color: #111;
            border-color: #66bbff;
        }}
        /* Tab visibility: CSS-only via :target. Default shows .tab-modules. */
        .tab {{ display: none; }}
        .tab-modules {{ display: block; }}
        body:target .tab-modules {{ display: none; }}
        body#composite .tab-modules {{ display: none; }}
        body#composite .tab-composite {{ display: block; }}
        body#modules .tab-modules {{ display: block; }}
        body#modules .tab-composite {{ display: none; }}
        .grid {{
            display: grid;
            grid-template-columns: repeat(auto-fill, minmax(360px, 1fr));
            gap: 14px;
            margin-top: 24px;
        }}
        .card {{
            background: #232323;
            border: 1px solid #333;
            border-radius: 4px;
            padding: 12px;
        }}
        .card-fail {{ border-color: #c03; }}
        .card h3 {{ font-size: 1.05em; margin-bottom: 4px; color: #ddd; }}
        .status {{ float: right; font-size: 0.75em; padding: 1px 6px; border-radius: 3px; font-weight: bold; }}
        .status-pass {{ background: #1a4; color: #e8ffe8; }}
        .status-fail {{ background: #c33; color: #fee; }}
        .blurb {{ color: #888; font-size: 0.85em; margin-bottom: 8px; min-height: 1.2em; }}
        .row {{ display: flex; gap: 6px; }}
        .thumb {{
            position: relative;
            flex: 1;
            display: block;
            border: 1px solid #333;
            background: #000;
            overflow: hidden;
        }}
        .thumb img {{ display: block; width: 100%; image-rendering: auto; }}
        .thumb span {{
            position: absolute;
            top: 4px;
            left: 4px;
            background: rgba(0,0,0,0.75);
            color: #f0d878;
            padding: 1px 5px;
            font-size: 0.7em;
            font-weight: bold;
            text-transform: uppercase;
        }}
        .thumb:hover {{ border-color: #66bbff; }}
        .empty-state {{
            text-align: center;
            color: #666;
            padding: 60px 20px;
            border: 1px dashed #333;
            border-radius: 6px;
            margin-top: 24px;
        }}
        footer {{ text-align: center; color: #555; margin-top: 50px; padding: 20px; border-top: 1px solid #333; }}
    </style>
    <script>
        // Tiny enhancer: when a nav link is clicked, set body id so CSS
        // can toggle the visible tab. Falls back gracefully without JS
        // (default = Modules tab; deep-link to composite via #composite).
        document.addEventListener('DOMContentLoaded', function () {{
            var links = document.querySelectorAll('.nav a[data-tab]');
            function activate(tab) {{
                document.body.id = tab;
                links.forEach(function (a) {{
                    a.classList.toggle('active', a.getAttribute('data-tab') === tab);
                }});
            }}
            links.forEach(function (a) {{
                a.addEventListener('click', function (ev) {{
                    ev.preventDefault();
                    activate(a.getAttribute('data-tab'));
                }});
            }});
            // Honour an existing #composite/#modules hash on initial load.
            var hash = (location.hash || '').replace('#', '');
            activate(hash === 'composite' ? 'composite' : 'modules');
        }});
    </script>
</head>
<body id="modules">
    <img class="banner banner-header" src="../assets/header.png" alt="patchtogether.live header banner">
    <div class="container">
        <h1>VRT GALLERY</h1>
        <p class="subtitle">Playwright screenshot baselines for patchtogether.live</p>
        {summary}
        {commit_strip}
        <nav class="nav">
            <a href="#modules" data-tab="modules" class="active">Modules ({modules_total})</a>
            <a href="#composite" data-tab="composite">Composite States ({composite_total})</a>
        </nav>
        <section class="tab tab-modules">
            <div class="grid">{modules_html}
            </div>
        </section>
        <section class="tab tab-composite">
            {('<div class="grid">' + composite_html + '</div>') if composite_html else '<div class="empty-state">No composite-state baselines yet — capture some via `task vrt:update`.</div>'}
        </section>
        <footer>
            <p><a href="../">&laquo; back</a> &middot; <a href="https://github.com/2600hz-oscillator/patchtogether.live">repo</a></p>
        </footer>
    </div>
    <img class="banner banner-footer" src="../assets/footer.png" alt="patchtogether.live footer banner" loading="lazy">
</body>
</html>
"""


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--baseline-dir", type=Path, required=True)
    p.add_argument("--results-dir", type=Path, required=False)
    p.add_argument("--output-dir", type=Path, required=True)
    args = p.parse_args()

    if not args.baseline_dir.is_dir():
        sys.stderr.write(f"error: baseline dir not found: {args.baseline_dir}\n")
        return 1

    args.output_dir.mkdir(parents=True, exist_ok=True)
    (args.output_dir / "baselines").mkdir(parents=True, exist_ok=True)
    (args.output_dir / "actual").mkdir(parents=True, exist_ok=True)
    (args.output_dir / "diff").mkdir(parents=True, exist_ok=True)

    bucketed = list_baselines(args.baseline_dir)
    total = sum(len(v) for v in bucketed.values())
    if total == 0:
        sys.stderr.write(
            f"warning: no baselines under {args.baseline_dir} — "
            "run `task vrt:update` first.\n"
        )

    # Flatten for the copy pass. Stems are assumed unique across categories
    # (true today — module types vs. composite scene ids don't collide).
    for category in bucketed.values():
        for stem, src in category.items():
            copy_image(src, args.output_dir / "baselines" / f"{stem}.png")

    artifacts = (
        list_run_artifacts(args.results_dir) if args.results_dir else {}
    )
    for stem, kinds in artifacts.items():
        for kind, src in kinds.items():
            copy_image(src, args.output_dir / kind / f"{stem}.png")

    index = args.output_dir / "index.html"
    index.write_text(render_html(bucketed, artifacts, repo_short_sha()))
    n_modules = len(bucketed["modules"])
    n_composite = len(bucketed["composite"])
    print(
        f"  wrote {index} "
        f"(modules={n_modules}, composite={n_composite}, failed={len(artifacts)})"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
