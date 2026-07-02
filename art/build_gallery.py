#!/usr/bin/env python3
"""build_gallery.py — render a static HTML gallery of the ART audio baselines.

The ART sibling of e2e/vrt/build_gallery.py. Where the VRT gallery shows a
per-card screenshot baseline, this shows a per-baseline AUDIO fingerprint: for
every `art/baselines/<scenario>/<name>.f32` (raw 32-bit little-endian float PCM,
MONO, 48 kHz — confirmed by `art/setup/render.ts` SAMPLE_RATE=48000 + the
scenario specs) it renders a single combined PNG:

  * a WAVEFORM plot (amplitude vs time) on top, and
  * a SPECTROGRAM (STFT magnitude, log-frequency, dB) below,

then emits an `index.html` grouping the cards by scenario, styled to mirror the
VRT gallery (dark theme, banner header/footer, card grid), with a small stats
line per baseline (peak, RMS, crest factor, spectral centroid, spectral
flatness, duration — the audio-profile fingerprint stats, owner decision §6b.5
of .myrobots/plans/art-backfill-audio-profiles-2026-07-01.md).

DETERMINISM: fixed figure size + DPI, a fixed STFT (Hann window, 3/4 overlap,
power-of-two segment), a fixed colormap + dB range, and NO timestamps baked into
the image. Re-running over the same baselines produces byte-stable PNGs, so the
gallery is a pure function of the committed `.f32` set.

Inputs:
  --baseline-dir   art/baselines/<scenario>/<name>.f32
  --output-dir     docs/art

Output layout:
  <output-dir>/index.html                    — landing page + per-scenario grids
  <output-dir>/img/<scenario>__<name>.png    — combined waveform+spectrogram

Deps: numpy + matplotlib (both in the flox env). No git, no LFS smudge — the
`.f32` files are read directly (CI pulls the LFS objects first).
"""

from __future__ import annotations

import argparse
import html
import subprocess
import sys
from pathlib import Path

import numpy as np

# Headless, deterministic rendering — set the backend BEFORE importing pyplot.
import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402

SAMPLE_RATE = 48000  # matches art/setup/render.ts SAMPLE_RATE

# --- deterministic render knobs -------------------------------------------
FIG_W_IN = 7.0
FIG_H_IN = 4.6
DPI = 110
DB_FLOOR = -80.0  # spectrogram dynamic range below per-image peak
CMAP = "magma"

# Dark palette matching the VRT gallery cards.
BG = "#15151a"
PANEL = "#0c0c10"
FG = "#c8c8d0"
GRID = "#33333c"
WAVE = "#66bbff"


def repo_short_sha() -> str:
    """HEAD short SHA, or '' if unavailable. Read-only; mirrors the VRT gallery."""
    try:
        out = subprocess.check_output(
            ["git", "rev-parse", "--short", "HEAD"], stderr=subprocess.DEVNULL
        )
        return out.decode().strip()
    except (subprocess.CalledProcessError, FileNotFoundError):
        return ""


def list_baselines(baseline_dir: Path) -> dict[str, list[Path]]:
    """Group every `<scenario>/<name>.f32` under baseline_dir by scenario."""
    grouped: dict[str, list[Path]] = {}
    for f32 in sorted(baseline_dir.rglob("*.f32")):
        try:
            rel = f32.relative_to(baseline_dir)
        except ValueError:
            continue
        if len(rel.parts) < 2:
            continue
        scenario = rel.parts[0]
        grouped.setdefault(scenario, []).append(f32)
    for scenario in grouped:
        grouped[scenario].sort(key=lambda p: p.stem)
    return dict(sorted(grouped.items()))


def read_f32(path: Path) -> np.ndarray:
    """Raw little-endian float32 mono PCM → float32 array (finite, no NaNs)."""
    x = np.fromfile(str(path), dtype="<f4")
    return np.nan_to_num(x, nan=0.0, posinf=0.0, neginf=0.0).astype(np.float32)


def stft_db(x: np.ndarray, nperseg: int, noverlap: int):
    """Deterministic STFT magnitude in dB (relative to per-image peak).

    Returns (freqs, times, db) with db shaped (freq, time)."""
    hop = nperseg - noverlap
    if x.size < nperseg:
        x = np.pad(x, (0, nperseg - x.size))
    win = np.hanning(nperseg).astype(np.float64)
    n_frames = 1 + (x.size - nperseg) // hop
    idx = np.arange(nperseg)[None, :] + hop * np.arange(n_frames)[:, None]
    frames = x[idx].astype(np.float64) * win[None, :]
    spec = np.fft.rfft(frames, axis=1)
    mag = np.abs(spec).T  # (freq, time)
    freqs = np.fft.rfftfreq(nperseg, 1.0 / SAMPLE_RATE)
    times = (np.arange(n_frames) * hop + nperseg / 2.0) / SAMPLE_RATE
    peak = mag.max()
    if not np.isfinite(peak) or peak <= 0:
        db = np.full_like(mag, DB_FLOOR)
    else:
        db = 20.0 * np.log10(np.maximum(mag, 1e-12) / peak)
        db = np.clip(db, DB_FLOOR, 0.0)
    return freqs, times, db


def pick_nperseg(n: int) -> int:
    """Largest power-of-two window (64..1024) that still yields several STFT
    frames. Targeting ~n/2 keeps even the shortest baselines (256 smp) at a
    handful of frames instead of a single degenerate column."""
    target = min(1024, max(64, n // 2))
    nperseg = 64
    while nperseg * 2 <= target:
        nperseg *= 2
    return nperseg


def waveform_xy(x: np.ndarray):
    """Time axis + a plot-friendly series. For long signals draw a min/max
    envelope so the PNG stays readable without changing the underlying data."""
    n = x.size
    t = np.arange(n) / SAMPLE_RATE
    if n <= 4000:
        return t, x, None
    buckets = 2000
    edges = np.linspace(0, n, buckets + 1, dtype=int)
    tb, lo, hi = [], [], []
    for i in range(buckets):
        a, b = edges[i], edges[i + 1]
        if b <= a:
            continue
        seg = x[a:b]
        tb.append((a + b) / 2.0 / SAMPLE_RATE)
        lo.append(float(seg.min()))
        hi.append(float(seg.max()))
    return np.array(tb), np.array(lo), np.array(hi)


def spectral_stats(x: np.ndarray) -> tuple[float, float]:
    """Deterministic (spectral_centroid_hz, spectral_flatness) over the full
    signal's rFFT POWER spectrum, DC bin dropped. Centroid = power-weighted
    mean frequency (brightness); flatness = geometric/arithmetic mean of the
    power spectrum (0 = pure tone … 1 = white noise). Pure numpy on the raw
    `.f32` — no windowing knobs, so re-runs are byte-stable."""
    if x.size < 4:
        return 0.0, 0.0
    spec = np.fft.rfft(x.astype(np.float64))
    power = (spec.real**2 + spec.imag**2)[1:]  # drop DC
    total = float(power.sum())
    if not np.isfinite(total) or total <= 0.0:
        return 0.0, 0.0
    freqs = np.fft.rfftfreq(x.size, 1.0 / SAMPLE_RATE)[1:]
    centroid = float((power * freqs).sum() / total)
    p = np.maximum(power, 1e-20)
    flatness = float(np.exp(np.mean(np.log(p))) / np.mean(p))
    return centroid, flatness


def stats(x: np.ndarray) -> dict[str, float]:
    n = x.size
    peak = float(np.max(np.abs(x))) if n else 0.0
    rms = float(np.sqrt(np.mean(x.astype(np.float64) ** 2))) if n else 0.0
    centroid_hz, flatness = spectral_stats(x)
    return {
        "n": n,
        "dur": n / SAMPLE_RATE,
        "peak": peak,
        "peak_db": 20.0 * np.log10(peak) if peak > 0 else float("-inf"),
        "rms": rms,
        "rms_db": 20.0 * np.log10(rms) if rms > 0 else float("-inf"),
        # Crest factor (peak/RMS, dB) — transient-ness of the profile.
        "crest_db": 20.0 * np.log10(peak / rms) if peak > 0 and rms > 0 else float("-inf"),
        "centroid_hz": centroid_hz,
        "flatness": flatness,
    }


def render_png(x: np.ndarray, out_path: Path) -> None:
    """Combined waveform (top) + spectrogram (bottom) → deterministic PNG."""
    n = x.size
    fig, (ax_w, ax_s) = plt.subplots(
        2,
        1,
        figsize=(FIG_W_IN, FIG_H_IN),
        dpi=DPI,
        sharex=True,
        gridspec_kw={"height_ratios": [1.0, 1.4], "hspace": 0.12},
    )
    fig.patch.set_facecolor(BG)

    dur = max(n / SAMPLE_RATE, 1e-6)

    # --- waveform ---------------------------------------------------------
    ax_w.set_facecolor(PANEL)
    t, a, b = waveform_xy(x)
    if b is None:
        ax_w.plot(t, a, color=WAVE, linewidth=0.7)
    else:
        ax_w.fill_between(t, a, b, color=WAVE, linewidth=0.0)
    peak = float(np.max(np.abs(x))) if n else 0.0
    ylim = max(peak * 1.1, 1e-3)
    ax_w.set_ylim(-ylim, ylim)
    ax_w.set_xlim(0, dur)
    ax_w.axhline(0, color=GRID, linewidth=0.6)
    ax_w.set_ylabel("amp", color=FG, fontsize=8)
    ax_w.tick_params(colors=FG, labelsize=7)
    for s in ax_w.spines.values():
        s.set_color(GRID)
    ax_w.grid(True, color=GRID, linewidth=0.4, alpha=0.5)

    # --- spectrogram (log-frequency, dB) ----------------------------------
    ax_s.set_facecolor(PANEL)
    nperseg = pick_nperseg(n)
    noverlap = (nperseg * 3) // 4
    freqs, times, db = stft_db(x, nperseg, noverlap)
    # Drop the DC bin so the log-frequency axis is well defined.
    f = freqs[1:]
    d = db[1:, :]
    if times.size >= 2 and f.size >= 2:
        mesh = ax_s.pcolormesh(
            times, f, d, cmap=CMAP, vmin=DB_FLOOR, vmax=0.0, shading="auto"
        )
        ax_s.set_yscale("log")
        ax_s.set_ylim(max(20.0, float(f[0])), SAMPLE_RATE / 2.0)
        cbar = fig.colorbar(mesh, ax=ax_s, pad=0.01, fraction=0.046)
        cbar.ax.tick_params(colors=FG, labelsize=6)
        cbar.set_label("dB", color=FG, fontsize=7)
        cbar.outline.set_edgecolor(GRID)
    else:
        ax_s.text(
            0.5, 0.5, "signal too short for STFT", color=FG,
            ha="center", va="center", transform=ax_s.transAxes, fontsize=8,
        )
    ax_s.set_xlim(0, dur)
    ax_s.set_xlabel("time (s)", color=FG, fontsize=8)
    ax_s.set_ylabel("freq (Hz)", color=FG, fontsize=8)
    ax_s.tick_params(colors=FG, labelsize=7)
    for s in ax_s.spines.values():
        s.set_color(GRID)

    fig.subplots_adjust(left=0.11, right=0.99, top=0.98, bottom=0.12)
    fig.savefig(out_path, facecolor=BG, dpi=DPI)
    plt.close(fig)


def _fmt_db(v: float) -> str:
    return "-inf" if v == float("-inf") else f"{v:.1f}"


def render_card(scenario: str, f32: Path, img_rel: str, st: dict) -> str:
    name = f32.stem
    stat_line = (
        f"peak {st['peak']:.3f} ({_fmt_db(st['peak_db'])} dBFS) · "
        f"rms {_fmt_db(st['rms_db'])} dBFS · "
        f"crest {_fmt_db(st['crest_db'])} dB · "
        f"centroid {st['centroid_hz']:.0f} Hz · "
        f"flat {st['flatness']:.3f} · "
        f"{st['dur'] * 1000:.0f} ms · {st['n']} smp"
    )
    anchor = html.escape(f"{scenario}--{name}")
    return f"""
      <article id="{anchor}" class="card">
        <h3>{html.escape(name)}</h3>
        <a href="{html.escape(img_rel)}" class="thumb">
          <img loading="lazy" src="{html.escape(img_rel)}" alt="{html.escape(scenario)}/{html.escape(name)} waveform + spectrogram">
        </a>
        <p class="stats">{html.escape(stat_line)}</p>
      </article>"""


def render_html(sections: list[tuple[str, list[str]]], n_total: int, commit: str) -> str:
    nav = "".join(
        f'<a href="#scenario-{html.escape(s)}">{html.escape(s)} ({len(cards)})</a>'
        for s, cards in sections
    )
    body_sections = "".join(
        f"""
      <section class="scenario" id="scenario-{html.escape(s)}">
        <h2>{html.escape(s)} <span class="count">({len(cards)})</span></h2>
        <div class="grid">{''.join(cards)}
        </div>
      </section>"""
        for s, cards in sections
    )
    commit_strip = (
        f'<p class="commit">Generated from <code>{html.escape(commit)}</code></p>'
        if commit
        else ""
    )
    summary = (
        f'<p class="summary">{n_total} audio baselines · '
        f"{len(sections)} scenarios · waveform + log-freq spectrogram</p>"
    )
    return f"""<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>patchtogether.live — ART gallery</title>
    <style>
        * {{ margin: 0; padding: 0; box-sizing: border-box; }}
        body {{
            background: #1a1a1a;
            color: #e0e0e0;
            font-family: 'Courier New', monospace;
            line-height: 1.5;
        }}
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
        .nav {{
            display: flex;
            flex-wrap: wrap;
            justify-content: center;
            gap: 8px;
            margin: 18px 0 6px;
        }}
        .nav a {{
            background: #232323;
            border: 1px solid #333;
            border-radius: 4px;
            padding: 6px 12px;
            color: #ddd;
            font-size: 0.8em;
            letter-spacing: 0.03em;
        }}
        .nav a:hover {{ border-color: #66bbff; text-decoration: none; }}
        .scenario {{ margin-top: 30px; }}
        .scenario h2 {{
            color: #8ab4f8;
            font-size: 1.1em;
            text-transform: uppercase;
            letter-spacing: 1.2px;
            border-bottom: 1px solid #333;
            padding-bottom: 6px;
            margin-bottom: 4px;
        }}
        .scenario h2 .count {{ color: #6b7178; }}
        .grid {{
            display: grid;
            grid-template-columns: repeat(auto-fill, minmax(360px, 1fr));
            gap: 14px;
            margin-top: 14px;
        }}
        .card {{
            background: #232323;
            border: 1px solid #333;
            border-radius: 4px;
            padding: 12px;
        }}
        .card h3 {{ font-size: 1.0em; margin-bottom: 8px; color: #ddd; word-break: break-all; }}
        .thumb {{
            display: block;
            border: 1px solid #333;
            background: #000;
            overflow: hidden;
        }}
        .thumb img {{ display: block; width: 100%; image-rendering: auto; }}
        .thumb:hover {{ border-color: #66bbff; }}
        .stats {{ color: #9aa; font-size: 0.78em; margin-top: 8px; }}
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
</head>
<body>
    <img class="banner banner-header" src="../assets/header.png" alt="patchtogether.live header banner">
    <div class="container">
        <h1>ART GALLERY</h1>
        <p class="subtitle">Audio Regression Test baselines — waveform + spectrogram fingerprints</p>
        {summary}
        {commit_strip}
        <nav class="nav">{nav}</nav>
        {body_sections if body_sections else '<div class="empty-state">No ART baselines found — run `flox activate -- task art:update` first.</div>'}
        <footer>
            <p><a href="../">&laquo; back</a> &middot; <a href="../vrt/">VRT gallery</a> &middot; <a href="https://github.com/2600hz-oscillator/patchtogether.live">repo</a></p>
        </footer>
    </div>
    <img class="banner banner-footer" src="../assets/footer.png" alt="patchtogether.live footer banner" loading="lazy">
</body>
</html>
"""


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--baseline-dir", type=Path, required=True)
    p.add_argument("--output-dir", type=Path, required=True)
    args = p.parse_args()

    if not args.baseline_dir.is_dir():
        sys.stderr.write(f"error: baseline dir not found: {args.baseline_dir}\n")
        return 1

    img_dir = args.output_dir / "img"
    img_dir.mkdir(parents=True, exist_ok=True)

    grouped = list_baselines(args.baseline_dir)
    n_total = sum(len(v) for v in grouped.values())
    if n_total == 0:
        sys.stderr.write(
            f"warning: no .f32 baselines under {args.baseline_dir} — "
            "run `task art:update` first.\n"
        )

    sections: list[tuple[str, list[str]]] = []
    n_rendered = 0
    for scenario, files in grouped.items():
        cards: list[str] = []
        for f32 in files:
            x = read_f32(f32)
            img_name = f"{scenario}__{f32.stem}.png"
            render_png(x, img_dir / img_name)
            n_rendered += 1
            cards.append(
                render_card(scenario, f32, f"img/{img_name}", stats(x))
            )
        sections.append((scenario, cards))

    index = args.output_dir / "index.html"
    index.write_text(render_html(sections, n_total, repo_short_sha()))
    print(
        f"  wrote {index} "
        f"(scenarios={len(sections)}, baselines={n_total}, pngs={n_rendered})"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
