// packages/web/src/lib/audio/modules/spectrograph.ts
//
// SPECTROGRAPH — a real-time scrolling sonogram video generator. Takes a
// MONO audio input and renders a log-binned spectrograph (frequency on
// the vertical axis, log scale, 20 Hz at the bottom .. 20 kHz at the
// top; time scrolling horizontally with the NEWEST column at the RIGHT).
//
// TWO video outputs over the SAME binned dB plane, two colormaps:
//   * color — the WAVESCULPT blue→cyan→yellow→red heat ramp.
//   * bw    — INVERTED grayscale (quiet = white, loud = black): the
//     classic printed-sonogram look (light page, dark traces).
//
// ARCHITECTURE (modeled on SYNESTHESIA / WAVESCULPT): a `domain: 'audio'`
// module that exposes VIDEO outputs by tapping an AnalyserNode and
// publishing `videoSources` (one per video-out port) whose `drawFrame`
// the VideoEngine's audio→video texture bridge calls each frame. The
// log-binning + colormaps live in the pure spectrograph-draw core
// (GPU-free, unit-tested). The scroll buffer is owned HERE and advanced
// at most once per ~frame (time-gated) so that BOTH outputs being
// patched — each gets its own drawFrame call within one bridge tick —
// does NOT double-advance the scroll (the WARRENSPECTRUM/scope precedent
// for a shared analyser tap; the gate keeps a steady scroll rate
// independent of how many outputs are patched).
//
// REUSE: the FFT tap (ensureSpectrumAnalyser + read('spectrum')) is the
// WAVESCULPT pattern; the log-bin + heat colormap are lifted verbatim
// from WavesculptCard.drawSpectrograph (video_mode 2).
//
// Inputs:
//   in (audio): the mono signal to analyse.
// Outputs:
//   color (mono-video): the heat-ramp spectrograph.
//   bw    (mono-video): the inverted-grayscale (printed-sonogram) spectrograph.
// Params:
//   gain (linear 0.25..4, default 1): pre-analysis input trim — boosts a
//     quiet source up into the -90..-10 dB display window (and tames a
//     hot one). Applied by a GainNode BEFORE the analyser tap.

import type { AudioDomainNodeHandle } from '$lib/audio/engine';
import type { AudioModuleDef } from '$lib/audio/module-registry';
import {
  SPEC_W,
  SPEC_H,
  heatmapRgb,
  grayscaleInvRgb,
  renderSpectrographInto,
  writeSpectrumColumn,
  type Colormap,
} from './spectrograph-draw';

// ---- DETERMINISTIC render seam (VRT / render-smoke) — zero prod impact ----
// The spectrograph is a SCROLLING temporal buffer driven by a live
// AnalyserNode: its contents never bit-stabilize across runs (the column
// count + buffered FFT both depend on wall-clock scheduling). When the
// flag is set we (1) override the live FFT readout with a FIXED synthetic
// spectrum and (2) drive a FIXED number of columns so the rendered frame
// is reproducible by construction. Asserts stay FLOOR-based (non-black +
// the expected colormap channel), never bit-equality. Flag never set in
// production. Parallels WAVESCULPT's __wavesculptVrtFreeze.
function spectrographVrtFrozen(): boolean {
  return (
    (globalThis as unknown as { __spectrographVrtFreeze?: boolean }).__spectrographVrtFreeze === true
  );
}

// A fixed synthetic spectrum: three loud peaks (low / mid / high) over a
// quiet floor, in the getFloatFrequencyData dBFS convention (≈ -100..0).
// Built once on demand for a given (binCount). Distinct peak bins give
// the frozen frame visible horizontal traces in BOTH colormaps (non-black
// for heat; non-white/dark traces for the inverted grayscale).
let frozenSpectrum: Float32Array | null = null;
function buildFrozenSpectrum(binCount: number): Float32Array {
  if (frozenSpectrum && frozenSpectrum.length === binCount) return frozenSpectrum;
  const a = new Float32Array(binCount).fill(-100);
  const peaks = [
    Math.floor(binCount * 0.04), // low
    Math.floor(binCount * 0.22), // mid
    Math.floor(binCount * 0.55), // high
  ];
  for (const p of peaks) {
    for (let d = -2; d <= 2; d++) {
      const i = p + d;
      if (i >= 1 && i < binCount) a[i] = -12 - Math.abs(d) * 6; // -12 dB peak, falling skirts
    }
  }
  frozenSpectrum = a;
  return a;
}

export interface SpectrumRead {
  bins: Float32Array;
  sampleRate: number;
  fftSize: number;
}

export const spectrographDef: AudioModuleDef = {
  type: 'spectrograph',
  palette: { top: 'Hybrid', sub: 'Hybrid' },
  domain: 'audio',
  label: 'spectrograph',
  category: 'hybrid',
  schemaVersion: 1,

  inputs: [{ id: 'in', type: 'audio' }],
  outputs: [
    { id: 'color', type: 'mono-video' },
    { id: 'bw', type: 'mono-video' },
  ],
  params: [
    { id: 'gain', label: 'Gain', defaultValue: 1, min: 0.25, max: 4, curve: 'log' },
  ],

  docs: {
    explanation:
      "A real-time scrolling spectrograph (sonogram) — it turns any audio signal into a video image of its frequency content over time. The mono input is FFT-analysed and rendered as a log-binned plot: frequency runs up the vertical axis (20 Hz at the bottom to 20 kHz at the top, log scale), time scrolls horizontally with the newest column on the RIGHT, and the loudness at each frequency sets each pixel's brightness/color. It produces the SAME spectrograph as two simultaneous video outputs over two colormaps — a COLOR heat ramp (blue→cyan→yellow→red, loud = hot) and an INVERTED B/W (quiet = white, loud = black, the classic printed-sonogram look). The card shows a live preview with a button to flip the preview between the two looks (preview only — both outputs are always live). Patch COLOR or B/W into VIDEO OUT or any video module. GAIN trims the input level into the analyser's display window.",
    inputs: {
      in: "The mono audio signal to analyse — its frequency content is FFT-analysed and drawn as the scrolling spectrograph. Patch any audio source here (a synth voice, a mix, a drum bus).",
    },
    outputs: {
      color:
        "The spectrograph rendered with the COLOR heat ramp — quiet = dark blue, getting louder through cyan → yellow → red. A mono-video output; patch it into VIDEO OUT or any video module for a vivid, colorful sonogram.",
      bw:
        "The SAME spectrograph rendered as INVERTED grayscale — quiet = white, loud = black — the classic printed-sonogram look (light page, dark traces). A mono-video output, drawn from the same FFT plane as COLOR, so the two are time-aligned.",
    },
    controls: {
      gain:
        "Pre-analysis input trim (0.25..4, log, default 1) — boosts a quiet source up into the −90..−10 dB display window so its traces are visible (or tames a hot one). Applied before the FFT tap; it shapes the IMAGE contrast, not the audio (there's no audio output).",
    },
  },

  async factory(ctx, node): Promise<AudioDomainNodeHandle> {
    // Input trim → analyser tap. A muted keep-alive path is NOT needed:
    // an AnalyserNode is a passive tap (it doesn't need a path to
    // destination to fill its buffer the way an AudioWorkletNode needs
    // one to run process()). We read it on demand from drawFrame.
    const inGain = ctx.createGain();
    const nodeParams = node.params ?? {};
    inGain.gain.value = typeof nodeParams.gain === 'number' ? nodeParams.gain : 1;

    const analyser = ctx.createAnalyser();
    // 1024-pt FFT (matches WAVESCULPT's spectrograph analyser): enough
    // low-end bin resolution to discriminate sub-bass log rows.
    analyser.fftSize = 1024;
    analyser.smoothingTimeConstant = 0.4;
    inGain.connect(analyser);

    const spectrumBuf = new Float32Array(analyser.frequencyBinCount);

    // ---- Scrolling column buffer (owned here, advanced ≤ once per frame) ----
    const specBuf = new Float32Array(SPEC_W * SPEC_H).fill(-100);
    let writeCol = 0;
    // Time-gate the advance so two drawFrame calls in one bridge tick
    // (both outputs patched) don't double-scroll. ~16 ms ≈ one 60 fps
    // column; steady scroll regardless of patch count.
    const COLUMN_INTERVAL_MS = 16;
    let lastAdvanceMs = -Infinity;
    // Frozen-render guard: under the freeze seam we fill the WHOLE buffer
    // ONCE from the fixed synthetic spectrum, then hold, so the frame is
    // reproducible in a single advance() (a couple rAFs suffice for VRT —
    // no 256-frame warm-up). Idempotent across drawFrame calls.
    let frozenFilled = false;

    function now(): number {
      return typeof performance !== 'undefined' ? performance.now() : Date.now();
    }

    /** Bin the latest FFT (or the frozen synthetic spectrum) into a new
     *  column, advancing the scroll head. Time-gated in live mode; one-shot
     *  full-buffer fill in frozen mode. Returns true if anything changed. */
    function advance(): boolean {
      if (spectrographVrtFrozen()) {
        if (frozenFilled) return false;
        // Fill EVERY column from the fixed synthetic spectrum so the whole
        // frame is deterministic immediately (no scroll warm-up). The
        // synthetic spectrum is column-invariant, so all columns identical
        // → stable horizontal traces at the peak rows.
        const frozen = buildFrozenSpectrum(analyser.frequencyBinCount);
        for (let c = 0; c < SPEC_W; c++) {
          writeSpectrumColumn(specBuf, c, frozen, ctx.sampleRate, analyser.fftSize);
        }
        writeCol = 0;
        frozenFilled = true;
        return true;
      }
      const t = now();
      if (t - lastAdvanceMs < COLUMN_INTERVAL_MS) return false;
      lastAdvanceMs = t;
      analyser.getFloatFrequencyData(spectrumBuf);
      writeSpectrumColumn(specBuf, writeCol, spectrumBuf, ctx.sampleRate, analyser.fftSize);
      writeCol = (writeCol + 1) % SPEC_W;
      return true;
    }

    // Per-output scaled-blit scratch (ImageData → drawImage scale). One
    // per colormap so the two outputs never fight over a shared scratch.
    function makeDrawFrame(colormap: Colormap): (c: OffscreenCanvas | HTMLCanvasElement) => void {
      let scratch: OffscreenCanvas | HTMLCanvasElement | null = null;
      let scratchCtx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null = null;
      let imageData: ImageData | null = null;
      return (canvas: OffscreenCanvas | HTMLCanvasElement): void => {
        const c2d = canvas.getContext('2d') as
          | CanvasRenderingContext2D
          | OffscreenCanvasRenderingContext2D
          | null;
        if (!c2d) return;
        // Advance the scroll (time-gated; idempotent within a frame).
        advance();
        // 1:1 SPEC_W×SPEC_H scratch, then scale-blit to the real canvas.
        if (!scratch || !scratchCtx) {
          if (typeof OffscreenCanvas !== 'undefined') {
            scratch = new OffscreenCanvas(SPEC_W, SPEC_H);
          } else if (typeof document !== 'undefined') {
            const el = document.createElement('canvas');
            el.width = SPEC_W;
            el.height = SPEC_H;
            scratch = el;
          } else {
            return;
          }
          scratchCtx = scratch.getContext('2d') as
            | CanvasRenderingContext2D
            | OffscreenCanvasRenderingContext2D
            | null;
          if (!scratchCtx) return;
        }
        if (!imageData) {
          try {
            imageData = scratchCtx.createImageData(SPEC_W, SPEC_H);
          } catch {
            return;
          }
        }
        renderSpectrographInto(specBuf, writeCol, imageData.data, colormap);
        scratchCtx.putImageData(imageData, 0, 0);
        const cw = canvas.width;
        const ch = canvas.height;
        c2d.imageSmoothingEnabled = true;
        c2d.drawImage(scratch as CanvasImageSource, 0, 0, SPEC_W, SPEC_H, 0, 0, cw, ch);
      };
    }

    const videoSources = new Map<
      string,
      { analyser: AnalyserNode; sampleRate: number; drawFrame: (c: OffscreenCanvas | HTMLCanvasElement) => void }
    >();
    videoSources.set('color', { analyser, sampleRate: ctx.sampleRate, drawFrame: makeDrawFrame(heatmapRgb) });
    videoSources.set('bw', { analyser, sampleRate: ctx.sampleRate, drawFrame: makeDrawFrame(grayscaleInvRgb) });

    const inputs = new Map<string, { node: AudioNode; input: number; param?: AudioParam }>();
    inputs.set('in', { node: inGain, input: 0 });

    return {
      domain: 'audio',
      inputs,
      outputs: new Map(), // no audio outputs; the two ports are video-only
      videoSources,
      setParam(paramId, value) {
        if (paramId === 'gain') inGain.gain.setValueAtTime(value, ctx.currentTime);
      },
      readParam(paramId) {
        if (paramId === 'gain') return inGain.gain.value;
        return undefined;
      },
      read(key) {
        // WAVESCULPT-style spectrum tap: { bins (dBFS), sampleRate, fftSize }.
        // Lets the on-card preview (or any consumer) pull the SAME FFT the
        // scroll buffer is binned from.
        if (key === 'spectrum') {
          analyser.getFloatFrequencyData(spectrumBuf);
          return { bins: spectrumBuf, sampleRate: ctx.sampleRate, fftSize: analyser.fftSize } satisfies SpectrumRead;
        }
        return undefined;
      },
      dispose() {
        analyser.disconnect();
        inGain.disconnect();
      },
    };
  },
};
