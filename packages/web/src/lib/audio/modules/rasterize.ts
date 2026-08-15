// packages/web/src/lib/audio/modules/rasterize.ts
//
// RASTERIZE — audio → video raster mapper (slice 1 of "crossing the
// streams";, "Locked
// decisions").
//
// An explicit, draggable module: audio in → mono-video out. Each video
// frame it takes a fixed run of audio samples (samplesPerFrame, ~800 at
// 48k/60fps) and writes them as voltage-per-pixel into the 640×480 video
// frame in raster order; a scan cursor advances + WRAPS through the
// frame across frames (~1.25 scanlines/frame at the default). Audio
// sample value (~-1..+1 after gain) → pixel luminance. This is the
// FAITHFUL raster mapping, NOT an oscilloscope trace — a steady tone
// paints horizontal bands whose spacing/drift tracks the audio frequency
// vs the line/frame rate.
//
// Fully untamed: no limiter, no anti-alias, no feedback guard. The
// harshness is the point. The ONLY clip is the inherent 8-bit pixel
// saturation in the luminance map.
//
// Architecture mirrors SCOPE (scope.ts): an AnalyserNode taps the audio
// input; the cross-domain audio→video texture bridge calls our
// `drawFrame(canvas)` each video frame (videoSources entry); we paint via
// a single RasterPainter so the on-card canvas + the video-out texture
// share one accumulated framebuffer.
//
// Inputs:
//   in (audio): the audio to rasterize.
//   cursor (cv, paramTarget=cursor): displaces the scan cursor (pixel offset into the frame).
//   samplesPerFrame (cv, paramTarget=samplesPerFrame): displaces samples-painted-per-frame.
//   gain (cv, paramTarget=gain): displaces the input-gain knob before luminance mapping.
//   wrap (cv, paramTarget=wrap): displaces the wrap-mode toggle.
//
// Outputs:
//   thru (audio): clean audio passthrough (raster path is non-destructive).
//   out (mono-video): the painted raster frame.
//
// Params:
//   cursor (linear 0..VIDEO_RES.width*height px, default 0): start position of the scan cursor.
//   samplesPerFrame (log 16..8000, default 800): how many samples paint per frame.
//   gain (log 0..8, default 1): input gain pre-luminance map.
//   wrap (discrete 0..1, default 0): 0 = scan wraps + accumulates, 1 = clear-on-wrap.

import type { AudioDomainNodeHandle } from '$lib/audio/engine';
import type { AudioModuleDef } from '$lib/audio/module-registry';
import { VIDEO_RES } from '$lib/video/engine';
import { createCvShadow, type CvShadow } from '$lib/audio/cv-shadow';
import { RasterPainter, type RasterizeDrawParams } from './rasterize-draw';

export const rasterizeDef: AudioModuleDef = {
  type: 'rasterize',
  palette: { top: 'Hybrid', sub: 'Hybrid' },
  domain: 'audio',
  label: 'rasterize',
  category: 'utilities',

  inputs: [
    // The audio signal to rasterize.
    { id: 'in', type: 'audio' },
    // CV inputs mirror every param 1:1 (port id == param id). A
    // cross-domain cable arrives per video frame through setParam(portId);
    // a same-domain cable is summed at audio rate into the AudioParam by
    // AudioEngine.addEdge. The factory's per-port shadows are the one
    // junction both land on (#1664).
    // cvScale per ADR-004: ±1 sweeps the param's FULL natural range —
    // without it a cable moves SCAN by one pixel out of 786 432, which is
    // not the scrubbing the docs promise. Withheld until now because the
    // CV landed on a stub AudioParam nobody read. `gain` takes LINEAR
    // rather than log despite its log curve: its min is 0, and log scaling
    // needs positive bounds (cv-scale.ts falls back to linear anyway).
    { id: 'cursor',          type: 'cv', paramTarget: 'cursor',          cvScale: { mode: 'linear' } },
    { id: 'samplesPerFrame', type: 'cv', paramTarget: 'samplesPerFrame', cvScale: { mode: 'log' } },
    { id: 'gain',            type: 'cv', paramTarget: 'gain',            cvScale: { mode: 'linear' } },
    { id: 'wrap',            type: 'cv', paramTarget: 'wrap',            cvScale: { mode: 'discrete' } },
  ],
  outputs: [
    // Audio passthrough so RASTERIZE can sit inline on a signal chain.
    { id: 'thru', type: 'audio' },
    // The raster frame as a GL texture for downstream video consumers.
    { id: 'out', type: 'mono-video' },
  ],
  params: [
    // Scan cursor start offset, in pixels into the engine-res frame
    // (VIDEO_RES.width × VIDEO_RES.height pixels). Moving it scrubs the running
    // cursor; otherwise the cursor drifts on its own.
    { id: 'cursor',          label: 'Scan',   defaultValue: 0,   min: 0,   max: VIDEO_RES.width * VIDEO_RES.height, curve: 'linear', units: 'px' },
    // Samples painted per frame. Default 800 ≈ 48k/60fps ≈ 1.25 scanlines.
    { id: 'samplesPerFrame', label: 'Samp/F', defaultValue: 800, min: 16,  max: 8000,   curve: 'log' },
    // Linear gain applied to each sample before the luminance map.
    { id: 'gain',            label: 'Gain',   defaultValue: 1,   min: 0,   max: 8,      curve: 'log' },
    // 0 = wrap (toroidal drift), 1 = clamp (top-to-bottom repaint sweep).
    { id: 'wrap',            label: 'Wrap',   defaultValue: 0,   min: 0,   max: 1,      curve: 'discrete' },
  ],

  docs: {
    explanation:
      "An audio→video raster mapper — it crosses the streams by writing your audio signal directly into a video frame as voltage-per-pixel. Every video frame it takes a fixed run of audio samples and paints them, in raster (left-to-right, top-to-bottom) scan order, into the 640×480 frame: each sample's value becomes a pixel's brightness, and a scan cursor advances and wraps through the frame across frames. This is the FAITHFUL raster mapping (like an analog scan-converter), NOT an oscilloscope trace — a steady tone paints horizontal bands whose spacing and drift track the audio frequency against the line/frame rate, and anything noisy paints texture. It is deliberately untamed: no limiter, no anti-aliasing, no feedback guard — the only ceiling is the 8-bit pixel saturation. The audio also passes through clean (THRU), so RASTERIZE can sit inline on a signal chain while feeding a video module from its OUT.",
    inputs: {
      in: "The audio signal to rasterize — its samples are painted as pixel brightness into the video frame.",
      cursor:
        "CV that displaces the SCAN cursor (the pixel offset where painting starts each frame), so you can scrub the running scan position with an envelope or LFO.",
      samplesPerFrame:
        "CV that displaces the SAMP/F control (how many samples are painted per frame), modulating how fast the scan sweeps the frame.",
      gain:
        "CV that displaces the GAIN applied to each sample before the brightness map, so a modulator can swing the image from dim to blown-out.",
      wrap:
        "CV that toggles the WRAP mode (accumulate-and-wrap vs. clear-on-wrap) under gate control.",
    },
    outputs: {
      thru: "Clean audio passthrough — the input signal unchanged (the raster path is non-destructive), so RASTERIZE can sit inline in an audio chain.",
      out: "The painted raster frame as a mono video texture for downstream video modules.",
    },
    controls: {
      cursor: "SCAN — the starting pixel offset of the scan cursor into the 640×480 frame; move it to scrub where painting begins, or leave it and let the cursor drift on its own.",
      samplesPerFrame: "SAMP/F — how many audio samples are painted per video frame (16–8000, default ~800 ≈ one-and-a-quarter scanlines at 48k/60fps); higher values sweep the frame faster and pack more signal per frame.",
      gain: "GAIN — a linear gain applied to each sample before it's mapped to pixel brightness; raise it to brighten/clip the image, lower it to darken (0–8).",
      wrap: "WRAP — what happens when the scan cursor reaches the end of the frame: 0 wraps around and keeps accumulating (toroidal drift), 1 clears on wrap for a clean top-to-bottom repaint sweep.",
    },
  },

  async factory(ctx, node): Promise<AudioDomainNodeHandle> {
    // Audio input → gain (passthrough) → thru output, with an analyser tap
    // for the per-frame sample run.
    const inGain = ctx.createGain();
    const analyser = ctx.createAnalyser();
    // 2048-sample window: at 48kHz that's ~43ms, comfortably more than the
    // default 800-samples-per-frame run, so a frame always has fresh data
    // even if the video frame rate lags the analyser refill.
    analyser.fftSize = 2048;
    analyser.smoothingTimeConstant = 0;
    inGain.connect(analyser);
    // analyser is a sink (not connected onward); inGain feeds the thru out.

    const buf = new Float32Array(analyser.fftSize);

    // ── CV SHADOWS: where the knob and the cable meet (#1664) ────────
    // Every raster param is applied in JS by the painter, so none of them
    // is a Web Audio node's AudioParam. Each therefore gets its OWN
    // shadow — a ConstantSource(1) → GainNode whose `.gain` is published
    // as the port's param and whose OUTPUT is the combined (knob + CV)
    // value, read back per frame. See $lib/audio/cv-shadow.
    //
    // What was here before: all four ports published `inGain.gain` — ONE
    // AudioParam, and the live in→thru passthrough gain at that. So a
    // cable into SCAN did not move the cursor, it multiplied the audio
    // (measured 3.146e+5 peak against a 5.0e-1 baseline), and `setParam`
    // wrote a JS record nothing in the CV path ever reached.
    const shadows: Record<string, CvShadow> = {
      cursor:          createCvShadow(ctx, (node.params ?? {}).cursor          ?? 0),
      samplesPerFrame: createCvShadow(ctx, (node.params ?? {}).samplesPerFrame ?? 800),
      gain:            createCvShadow(ctx, (node.params ?? {}).gain            ?? 1),
      wrap:            createCvShadow(ctx, (node.params ?? {}).wrap            ?? 0),
    };

    /** The painter's parameters for THIS frame: knob + CV, sampled once so
     *  every read inside one paint sees the same instant. */
    function liveParams(): RasterizeDrawParams {
      return {
        cursor:          shadows.cursor!.read(),
        samplesPerFrame: shadows.samplesPerFrame!.read(),
        gain:            shadows.gain!.read(),
        wrap:            shadows.wrap!.read(),
      };
    }

    // Single painter at the engine's video resolution. The cross-domain
    // bridge's drawFrame() advances it each video frame; the on-card
    // canvas reads its accumulated framebuffer via read('imageData') so
    // both render paths share one drifting cursor + one painting.
    const painter = new RasterPainter(VIDEO_RES.width, VIDEO_RES.height);

    /** Pull the newest `samplesPerFrame` run from the analyser. The
     *  analyser's getFloatTimeDomainData returns its whole window; the
     *  TAIL is newest, so we take the last `count` samples as this
     *  frame's run. */
    function frameRun(samplesPerFrame: number): Float32Array {
      analyser.getFloatTimeDomainData(buf);
      const count = Math.max(1, Math.min(buf.length, Math.floor(samplesPerFrame)));
      return buf.subarray(buf.length - count);
    }

    // ── DETERMINISTIC VRT SEED ───────────────────────────────────────
    // The live raster fill drifts with wall-clock timing: how many rAF
    // ticks land before the VRT freeze (AudioContext.suspend) varies
    // run-to-run by ±a few frames, and at default samplesPerFrame=800
    // each frame advances the cursor ~1.25 scanlines. Over a 900ms
    // settle that's ~50 lines of cursor wander → the band pattern
    // visually matches across runs (same input frequency) but is
    // shifted vertically by tens of rows, which busts the VRT pixel
    // tolerance even with the freeze-on-suspend guard below. Same class
    // of flake as FOXY's `__foxyVrtSeed` and PEAKSTATE's
    // `__peakstateVrtSeed` (see those modules).
    //
    // When the harness sets `__rasterizeVrtSeed`, we RESET the painter
    // then paint one deterministic full-frame fill from a fixed
    // synthetic waveform (independent of the analyser + wall clock), and
    // subsequent advance calls short-circuit — so every read('imageData')
    // and bridge drawFrame returns the SAME pixels run-to-run. Fix for
    // task #198.
    let vrtSeeded = false;
    function vrtSeedActive(): boolean {
      return !!(globalThis as unknown as { __rasterizeVrtSeed?: boolean })
        .__rasterizeVrtSeed;
    }
    function paintSeeded(): void {
      painter.reset();
      // Fixed synthetic sine — independent of any wall-clock / analyser
      // refill. 261 Hz over the engine's video resolution at 48 kHz
      // (matches the VRT scene's 261 Hz analogVco source so the BAND
      // SPACING in the seeded baseline still looks like the live one).
      const total = VIDEO_RES.width * VIDEO_RES.height;
      const sr = 48000;
      const freq = 261;
      const buf = new Float32Array(total);
      for (let i = 0; i < total; i++) {
        buf[i] = Math.sin((2 * Math.PI * freq * i) / sr) * 0.9;
      }
      // Paint ONE full-frame fill. samplesPerFrame=total so the cursor
      // sweeps the WHOLE frame in this one paint (no run-to-run cursor
      // wander), and wrap=0 + cursor=0 means the next call (if any) would
      // re-fill identically — but the early-return below means the
      // painter is touched exactly once.
      const seededParams: RasterizeDrawParams = {
        cursor: 0,
        samplesPerFrame: total,
        gain: 1,
        wrap: 0,
      };
      painter.paint(buf, seededParams);
    }

    // Frame-advance dedup: both the cross-domain bridge's drawFrame() AND
    // the on-card canvas's read('imageData') want a fresh frame, and when
    // both fire in the same animation frame we must advance the painter
    // (and thus the drifting cursor) only ONCE — otherwise the cursor
    // races at 2× and the banding is wrong. We coalesce on the rAF clock:
    // calls within the same ~16ms slice paint at most once.
    let lastPaintMs = -1;
    function advanceOncePerFrame(): void {
      // VRT seed mode: paint one deterministic frame, then HOLD it across
      // subsequent calls so the snapshot is pixel-stable run-to-run.
      if (vrtSeedActive()) {
        if (!vrtSeeded) { vrtSeeded = true; paintSeeded(); }
        return;
      }
      // Freeze the painting when the AudioContext is suspended: there's no
      // fresh audio arriving, so advancing the drifting cursor would just
      // smear stale samples across the frame. Mirrors SCOPE's analyser-
      // freezes-on-suspend behaviour and makes the VRT baseline pixel-
      // stable (the harness suspends the context before snapshotting).
      if (ctx.state === 'suspended') return;
      const now =
        typeof performance !== 'undefined' && typeof performance.now === 'function'
          ? performance.now()
          : Date.now();
      // 8ms guard (< one 60fps frame) so a bridge+card pair in the same
      // tick coalesces, but genuinely separate frames still advance.
      if (now - lastPaintMs < 8) return;
      lastPaintMs = now;
      const p = liveParams();
      painter.paint(frameRun(p.samplesPerFrame), p);
    }

    // The cross-domain bridge calls this each video frame with its own
    // 640×480 canvas. Advance (deduped) then blit onto the bridge's canvas.
    function drawFrame(canvas: OffscreenCanvas | HTMLCanvasElement): void {
      advanceOncePerFrame();
      painter.blitTo(canvas);
    }

    return {
      domain: 'audio',
      inputs: new Map<string, { node: AudioNode; input: number; param?: AudioParam }>([
        ['in', { node: inGain, input: 0 }],
        // One shadow per port — never shared, never in the audio path. The
        // engine sums each cable into that port's own `.gain`, and the
        // painter reads the combined value back through the shadow's
        // analyser. `node` is the shadow too, so even the engine's
        // no-param fallback branch cannot land a cable on live audio.
        ['cursor',          { node: shadows.cursor!.node,          input: 0, param: shadows.cursor!.param }],
        ['samplesPerFrame', { node: shadows.samplesPerFrame!.node, input: 0, param: shadows.samplesPerFrame!.param }],
        ['gain',            { node: shadows.gain!.node,            input: 0, param: shadows.gain!.param }],
        ['wrap',            { node: shadows.wrap!.node,            input: 0, param: shadows.wrap!.param }],
      ]),
      outputs: new Map([
        ['thru', { node: inGain, output: 0 }],
      ]),
      // Cross-domain: the video texture bridge calls drawFrame() each
      // video frame. analyser is handed back to satisfy the bridge type
      // (legacy GL-renderer path) but isn't used when drawFrame is set.
      videoSources: new Map([
        ['out', { analyser, sampleRate: ctx.sampleRate, drawFrame }],
      ]),
      setParam(paramId, value) {
        // A knob move lands on the SAME junction a cable does — the
        // shadow's `.gain` intrinsic — so the two sum instead of racing.
        shadows[paramId]?.set(value);
      },
      readParam(paramId) {
        // The knob alone. The engine folds in the modulator tap on top of
        // this for the motorized fader (see AudioEngine.readParam), so
        // returning the combined value here would double-count the CV.
        return shadows[paramId]?.knob();
      },
      read(key) {
        if (key === 'imageData') {
          // The card asks for the current frame. advanceOncePerFrame() so
          // the on-card canvas animates even when no video consumer is
          // patched (the bridge's drawFrame only runs when a downstream
          // video edge exists), while coalescing with the bridge when both
          // drive in the same rAF tick.
          advanceOncePerFrame();
          return painter.imageData();
        }
        if (key === 'cursor') {
          return painter.currentCursor;
        }
        // The COMBINED (knob + CV) raster params — what the painter is
        // actually drawing with. Exposed so a card or a test can read the
        // same truth the frame does, rather than re-deriving it from the
        // knob (which is blind to every patched cable).
        if (key === 'drawParams') {
          return liveParams();
        }
        return undefined;
      },
      // The inverse of read('drawParams'). A consumer holding the engine pushes
      // `PatchEngine.readParam` (the knob PLUS the engine's own per-port CV tap)
      // back in, so the painter draws the modulated value while this module owns
      // NO AnalyserNode per port — which is what a permanently retained Blink
      // AudioHandler per port would have cost. See $lib/audio/cv-shadow.
      write(key, value) {
        if (key !== 'cvCombined' || typeof value !== 'object' || value === null) return;
        for (const [id, v] of Object.entries(value as Record<string, number>)) {
          shadows[id]?.setCombined(v);
        }
      },
      dispose() {
        inGain.disconnect();
        analyser.disconnect();
        for (const s of Object.values(shadows)) s.dispose();
      },
    };
  },
};
