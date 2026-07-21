<!--
  ScopeScreen.svelte — a small dark rounded "screen" (the WAVE / DECAY reference
  glyphs) with a bright trace on near-black and a subtle inner bevel. Renders a
  signal path in one of three MODES onto a DPR-aware <canvas> (per the design
  guidance: canvas for generative graphics, not hand-authored SVG paths).

  MODES + their data source:
    • waveform — a LIVE time-domain trace from an analyser. `getSamples` returns
      a Float32Array (or {data}) each frame; polled on the SHARED `onMeterFrame`
      ticker (the same seam the scope module / AnalogVco card use — a thin
      renderer over the existing tap, NOT a new analyser). WAVE-screen look.
    • envelope — an ADSR curve computed from attack/decay/sustain/release, redrawn
      on param change. DECAY-screen look.
    • wave — one cycle of the oscillator's wave shape: a saw↔pulse `morph` (TIDY
      VCO's shape law) or an explicit single-cycle `waveform` buffer.

  The canvas re-sizes to its box (DPR-aware) and cleans up its frame subscription
  on unmount. For the LIVE waveform mode the current frame's peak amplitude is
  mirrored to `data-trace-peak` on the root so tests can assert a non-flat trace
  WITHOUT a GPU/pixel read (capability-safe).
-->
<script lang="ts">
  import { onMeterFrame } from '$lib/ui/meter-frame';
  import {
    envelopeCurvePoints,
    morphWavePoints,
    samplesToPoints,
    peakAmplitude,
    type ScreenPoint,
  } from './scope-screen-model';

  type Mode = 'waveform' | 'envelope' | 'wave';

  interface Props {
    mode: Mode;
    /** CSS pixel size of the screen. */
    width?: number;
    height?: number;
    /** Trace stroke color. Defaults per-mode (cyan for wave/waveform, amber for envelope). */
    color?: string;
    // ── waveform mode ──
    /** Live sample source, polled each frame. */
    getSamples?: () => Float32Array | { data: Float32Array } | ArrayLike<number> | undefined;
    // ── envelope mode ──
    attack?: number;
    decay?: number;
    sustain?: number;
    release?: number;
    // ── wave mode ──
    /** Saw↔pulse morph 0..1 (TIDY VCO shape law). */
    morph?: number;
    /** Pulse duty for the morph (0..1). */
    pw?: number;
    /** Explicit single-cycle buffer (overrides `morph` when present). */
    waveform?: ArrayLike<number>;
    testid?: string;
    ariaLabel?: string;
  }

  let {
    mode,
    width = 120,
    height = 64,
    color,
    getSamples,
    attack = 0.01,
    decay = 0.1,
    sustain = 0.7,
    release = 0.3,
    morph = 0,
    pw = 0.5,
    waveform,
    testid,
    ariaLabel,
  }: Props = $props();

  let canvasEl: HTMLCanvasElement | null = $state(null);
  let tracePeak = $state(0);

  const CYAN = '#38e0d4';
  const AMBER = '#f5b642';
  const BG_TOP = '#0d1013';
  const BG_BOTTOM = '#060809';
  const GRID = '#1b2026';
  const traceColor = $derived(color ?? (mode === 'envelope' ? AMBER : CYAN));

  function asArray(
    s: Float32Array | { data: Float32Array } | ArrayLike<number> | undefined,
  ): ArrayLike<number> | undefined {
    if (!s) return undefined;
    if (s instanceof Float32Array) return s;
    if (typeof (s as { data?: unknown }).data !== 'undefined') return (s as { data: Float32Array }).data;
    return s as ArrayLike<number>;
  }

  /** Size the backing store to the box × DPR (idempotent). Returns the 2D ctx
   *  already scaled to CSS pixels, or null. */
  function prepCtx(c: HTMLCanvasElement): CanvasRenderingContext2D | null {
    const dpr = typeof devicePixelRatio === 'number' && devicePixelRatio > 0 ? devicePixelRatio : 1;
    const bw = Math.max(1, Math.round(width * dpr));
    const bh = Math.max(1, Math.round(height * dpr));
    if (c.width !== bw) c.width = bw;
    if (c.height !== bh) c.height = bh;
    const ctx = c.getContext('2d');
    if (!ctx) return null;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return ctx;
  }

  function drawScreen(ctx: CanvasRenderingContext2D): void {
    // Dark screen with a top-lit vertical gradient + centerline + inner bevel.
    const grad = ctx.createLinearGradient(0, 0, 0, height);
    grad.addColorStop(0, BG_TOP);
    grad.addColorStop(1, BG_BOTTOM);
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, width, height);
    // Zero / mid reference line.
    ctx.strokeStyle = GRID;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, height / 2);
    ctx.lineTo(width, height / 2);
    ctx.stroke();
    // Inner bevel: a faint light top-edge + dark inset frame.
    ctx.strokeStyle = 'rgba(255,255,255,0.05)';
    ctx.beginPath();
    ctx.moveTo(0.5, 0.5);
    ctx.lineTo(width - 0.5, 0.5);
    ctx.stroke();
    ctx.strokeStyle = 'rgba(0,0,0,0.5)';
    ctx.strokeRect(0.5, 0.5, width - 1, height - 1);
  }

  function strokePath(ctx: CanvasRenderingContext2D, pts: ScreenPoint[]): void {
    if (pts.length < 2) return;
    ctx.save();
    ctx.strokeStyle = traceColor;
    ctx.lineWidth = 1.6;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.shadowColor = traceColor;
    ctx.shadowBlur = 4;
    ctx.beginPath();
    ctx.moveTo(pts[0]!.x, pts[0]!.y);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i]!.x, pts[i]!.y);
    ctx.stroke();
    ctx.restore();
  }

  function pointsFor(): { pts: ScreenPoint[]; peak: number } {
    if (mode === 'envelope') {
      return { pts: envelopeCurvePoints({ attack, decay, sustain, release }, width, height), peak: 0 };
    }
    if (mode === 'wave') {
      if (waveform && waveform.length > 0) {
        return { pts: samplesToPoints(waveform, width, height), peak: peakAmplitude(waveform) };
      }
      return { pts: morphWavePoints(morph, width, height, 128, pw), peak: 1 };
    }
    // waveform (live)
    const data = asArray(getSamples?.());
    if (!data || data.length === 0) return { pts: [], peak: 0 };
    return { pts: samplesToPoints(data, width, height), peak: peakAmplitude(data) };
  }

  function paint(): void {
    if (!canvasEl) return;
    const ctx = prepCtx(canvasEl);
    if (!ctx) return;
    drawScreen(ctx);
    const { pts, peak } = pointsFor();
    strokePath(ctx, pts);
    if (mode === 'waveform') tracePeak = peak;
  }

  // LIVE waveform: repaint on the shared frame, gated by on-screen visibility.
  $effect(() => {
    if (mode !== 'waveform' || !canvasEl) return;
    const h = onMeterFrame(canvasEl, () => paint());
    return () => h.stop();
  });

  // Static modes (envelope / wave): repaint whenever a driving prop changes.
  // Referencing the reactive inputs here registers the dependency.
  $effect(() => {
    if (mode === 'waveform') return;
    // touch deps
    void [mode, width, height, traceColor, attack, decay, sustain, release, morph, pw, waveform, canvasEl];
    paint();
  });
</script>

<div
  class="scope-screen"
  style="width:{width}px; height:{height}px;"
  data-testid={testid}
  data-mode={mode}
  data-trace-peak={mode === 'waveform' ? tracePeak.toFixed(4) : undefined}
  role="img"
  aria-label={ariaLabel ?? `${mode} display`}
>
  <canvas bind:this={canvasEl}></canvas>
</div>

<style>
  .scope-screen {
    display: block;
    border-radius: 5px;
    overflow: hidden;
    line-height: 0;
    box-shadow:
      inset 0 1px 2px rgba(0, 0, 0, 0.7),
      0 0 0 1px rgba(0, 0, 0, 0.4);
  }
  canvas {
    display: block;
    width: 100%;
    height: 100%;
  }
</style>
