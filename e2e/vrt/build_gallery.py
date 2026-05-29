#!/usr/bin/env python3
"""build_gallery.py — render a static HTML gallery of VRT baselines + the
latest run's actual / diff images, modeled on doom_viz's build_gallery.py.

Inputs:
  --baseline-dir   e2e/vrt/__screenshots__/<spec-path>/<arg>.png
  --results-dir    e2e/vrt/test-results (Playwright outputDir)
  --output-dir     docs/vrt

Output layout:
  <output-dir>/index.html               — landing grid (baselines)
  <output-dir>/baselines/<type>.png     — copied from baselines
  <output-dir>/actual/<type>.png        — present iff the last run failed
  <output-dir>/diff/<type>.png          — present iff the last run failed

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


def repo_short_sha() -> str:
    """HEAD short SHA, or '' if not a repo."""
    try:
        out = subprocess.check_output(
            ["git", "rev-parse", "--short", "HEAD"], stderr=subprocess.DEVNULL,
        )
        return out.decode().strip()
    except (subprocess.CalledProcessError, FileNotFoundError):
        return ""


def list_baselines(baseline_dir: Path) -> dict[str, Path]:
    """Map module type → baseline PNG path."""
    found: dict[str, Path] = {}
    for png in baseline_dir.rglob("*.png"):
        # filename is `<type>.png`. Drop the suffix.
        found[png.stem] = png
    return found


# Playwright writes failure artifacts under
#   test-results/<file>-<test>-chromium-vrt/<arg>-actual.png
#   test-results/<file>-<test>-chromium-vrt/<arg>-diff.png
# The <test> slug is sanitised from the test title — for our suite it
# starts with the module type. We resolve back to the type by parsing the
# arg filename which is `<type>-actual.png` / `<type>-diff.png`.
_ARTIFACT_RE = re.compile(r"^(?P<type>[a-zA-Z0-9]+)-(?P<kind>actual|diff)\.png$")


def list_run_artifacts(results_dir: Path) -> dict[str, dict[str, Path]]:
    """Map module type → {"actual": Path, "diff": Path} for last failed run."""
    found: dict[str, dict[str, Path]] = {}
    if not results_dir.is_dir():
        return found
    for png in results_dir.rglob("*.png"):
        m = _ARTIFACT_RE.match(png.name)
        if not m:
            continue
        t = m.group("type")
        kind = m.group("kind")
        found.setdefault(t, {})[kind] = png
    return found


def copy_image(src: Path, dst: Path) -> None:
    dst.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(src, dst)


def render_html(
    baselines: dict[str, Path],
    artifacts: dict[str, dict[str, Path]],
    commit: str,
) -> str:
    types = sorted(baselines.keys())
    n_total = len(types)
    n_failed = sum(1 for t in types if t in artifacts)

    cards: list[str] = []
    for t in types:
        blurb = MODULE_BLURB.get(t, "")
        has_diff = t in artifacts
        status_cls = "fail" if has_diff else "pass"
        status_label = "DIFF" if has_diff else "match"

        # baseline always present (we list from baselines/)
        b = f"baselines/{t}.png"
        thumbs = [
            f'<a href="{b}" class="thumb"><img loading="lazy" src="{b}" alt="{t} baseline"><span>baseline</span></a>'
        ]
        if has_diff:
            if "actual" in artifacts[t]:
                a = f"actual/{t}.png"
                thumbs.append(
                    f'<a href="{a}" class="thumb"><img loading="lazy" src="{a}" alt="{t} actual"><span>actual</span></a>'
                )
            if "diff" in artifacts[t]:
                d = f"diff/{t}.png"
                thumbs.append(
                    f'<a href="{d}" class="thumb"><img loading="lazy" src="{d}" alt="{t} diff"><span>diff</span></a>'
                )

        cards.append(f"""
    <article id="{html.escape(t)}" class="card card-{status_cls}">
        <h3>{html.escape(t)} <span class="status status-{status_cls}">{status_label}</span></h3>
        <p class="blurb">{html.escape(blurb)}</p>
        <div class="row">{''.join(thumbs)}</div>
    </article>""")

    commit_strip = (
        f'<p class="commit">Generated from <code>{html.escape(commit)}</code></p>'
        if commit
        else ""
    )
    summary = (
        f'<p class="summary">{n_total} modules · '
        f'<span class="ok">{n_total - n_failed} passing</span>'
        + (f' · <span class="bad">{n_failed} diffed</span>' if n_failed else "")
        + "</p>"
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
        footer {{ text-align: center; color: #555; margin-top: 50px; padding: 20px; border-top: 1px solid #333; }}
    </style>
</head>
<body>
    <img class="banner banner-header" src="../assets/header.png" alt="patchtogether.live header banner">
    <div class="container">
        <h1>VRT GALLERY</h1>
        <p class="subtitle">Per-module Playwright screenshot baselines for patchtogether.live</p>
        {summary}
        {commit_strip}
        <div class="grid">{''.join(cards)}
        </div>
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

    baselines = list_baselines(args.baseline_dir)
    if not baselines:
        sys.stderr.write(
            f"warning: no baselines under {args.baseline_dir} — "
            "run `task vrt:update` first.\n"
        )

    for t, src in baselines.items():
        copy_image(src, args.output_dir / "baselines" / f"{t}.png")

    artifacts = (
        list_run_artifacts(args.results_dir) if args.results_dir else {}
    )
    for t, kinds in artifacts.items():
        for kind, src in kinds.items():
            copy_image(src, args.output_dir / kind / f"{t}.png")

    index = args.output_dir / "index.html"
    index.write_text(render_html(baselines, artifacts, repo_short_sha()))
    print(
        f"  wrote {index} "
        f"(baselines={len(baselines)}, failed={len(artifacts)})"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
