// packages/web/src/lib/audio/modules/rasterize.ts
//
// RASTERIZE — audio → video raster mapper (slice 1 of "crossing the
// streams";, "Locked
// decisions").
//
// An explicit, draggable module: audio in → mono-video out. Each video
// frame it takes a fixed run of audio samples (samplesPerFrame, ~800 at
// 48k/60fps) and writes them as voltage-per-pixel into the VIDEO_RES
// (1024×768) video frame in raster order; a scan cursor advances + WRAPS
// through the frame across frames (~0.78 scanlines/frame at the
// default — 800 samples over a 1024 px line). Audio
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
    // Samples painted per frame. Default 800 ≈ 48k/60fps ≈ 0.78 scanlines
    // (800 / VIDEO_RES.width = 800/1024). See #2001 — this read "1.25" for
    // as long as the prose said the frame was 640 px wide.
    { id: 'samplesPerFrame', label: 'Samp/F', defaultValue: 800, min: 16,  max: 8000,   curve: 'log' },
    // Linear gain applied to each sample before the luminance map.
    { id: 'gain',            label: 'Gain',   defaultValue: 1,   min: 0,   max: 8,      curve: 'log' },
    // 0 = wrap (toroidal drift), 1 = clamp (top-to-bottom repaint sweep).
    //
    // ⚠ THE ROSTER IS WHAT KEEPS THE STATE NAMED THROUGH PROMOTION, and without
    // it this is the `fourplexer` control loss exactly. `paintsReadout` is
    // `!format && (options || landmarks)`, so an undeclared discrete param
    // paints an ANONYMOUS switch — while the card it replaces prints the state
    // itself as the button's caption (`{wrap ? 'CLAMP' : 'WRAP'}`). Promotion
    // would therefore have deleted the only place either word appears, on a
    // control whose two states are the module's two looks. With the roster the
    // dock renders a captioned `segmented` pair (2 ≤ SEGMENTED_MAX_OPTIONS) and
    // the lane dial paints the NAME — verbatim parity with the card.
    //
    // A NAME, NOT A NUMBER: option labels are permitted resting text precisely
    // because they disambiguate a control's own position, which `0`/`1` cannot.
    // The behaviour behind them is real rather than cosmetic — measured at the
    // frame boundary, CLAMP discards 700 of an 800-sample run where WRAP paints
    // all 800 and continues toroidally.
    {
      id: 'wrap', label: 'Wrap', defaultValue: 0, min: 0, max: 1, curve: 'discrete',
      options: [
        { value: 0, label: 'WRAP',  title: 'Wrap around and keep accumulating — toroidal drift.' },
        { value: 1, label: 'CLAMP', title: 'Clear on wrap — a clean top-to-bottom repaint sweep.' },
      ],
    },
  ],

  // ── THE FACEPLATE (PF-20) ────────────────────────────────────────────
  //
  // WHAT IT IS FOR: this is the audio→picture bridge. You patch a signal in
  // and the module PAINTS it — sample as brightness, in raster scan order —
  // so a steady tone becomes horizontal bands whose spacing tracks the
  // frequency against the line rate. The verb a player performs is "dial how
  // much signal lands per frame, and how hard it burns".
  //
  // THE TIER LADDER, as a sentence: at `compact` (3 cells, no glyph) you get
  // SAMP/F, GAIN and WRAP — the three controls that change the picture; the
  // dock adds SCAN, which is the one that cannot be trusted.
  //
  // THE RANKING, argued against the DSP rather than declaration order:
  //
  //  1 SAMP/F — the only control that changes the picture's STRUCTURE. It
  //    sets band spacing, how fast the frame fills, and how much signal a
  //    frame carries; it is live and audible-as-visible across its whole
  //    16..8000 log range. The headline gesture.
  //  2 GAIN   — changes how the picture READS (brightness/contrast) but not
  //    what it is. Ranked below SAMP/F rather than beside it because its
  //    useful travel is SIGNAL-DEPENDENT: against a source already at ±1,
  //    gain 1/2/4/8 all saturate to the same 0/255, so the upper reaches are
  //    indistinguishable on hot material and it is live only on quiet
  //    material (#2002).
  //  3 WRAP   — a real mode switch (toroidal accumulate vs clear-on-wrap
  //    sweep), two visually distinct behaviours, and a 0/1 discrete param so
  //    `looksLikeToggle` renders it as a named toggle rather than a dial.
  //  4 SCAN   — LAST, and this is the rank worth defending because it
  //    INVERTS declaration order. SCAN is a CHANGE DETECTOR, not a position
  //    control (#2000): the painter re-seats only when the FLOORED knob value
  //    differs from the last one it saw, while the running cursor advances on
  //    its own, so re-selecting a value the knob already displays is a no-op
  //    and the number diverges permanently from the real scan position. On
  //    top of that no gesture can move it by its own declared unit — the
  //    finest (ctrl-drag) moves ~39 px of a 786 432 px range. A control that
  //    cannot address its declared unit and cannot return to a position it is
  //    already showing is the LEAST trustworthy thing on this module, so it
  //    ranks last. ⚠ That argument would be WRONG for a module whose scrub
  //    actually scrubs — which is the test of whether a rank is defended.
  //
  // NO READOUT, AND NOTHING WAS LOST BY THAT. The resting faceplate paints no
  // derived-state text, so the running cursor has no surface — and here that
  // is a correctness win rather than a cost: a readout of the scan position
  // is exactly the divergence #2000 measures (knob 1000 vs cursor 49 800),
  // so painting it would have shipped a number that is wrong by construction.
  // The one derived quantity worth knowing (a frame's run in scanlines) stays
  // pinned in `scanlinesPerFrame` + its unit test.
  //
  // NOT CONTROL-HEAVY (2026-08-18 tabbed ruling): four params, one honest
  // idea, so ONE unlabelled band and no rail. `pages` is deliberately omitted
  // — splitting 4 cells into "scan"/"image" bands would buy two headers at
  // ~81 px each and say nothing the captions do not.
  //
  // ⚠ `glyph: 'none'` IS A CHOICE HERE, NOT A FORCED ONE, and the reason is a
  // NEW FAILURE CLASS worth naming. This module HAS an `audio` output, so
  // `primaryAudioOutPortId` returns `thru` and a `scope`/`meter` glyph would
  // resolve `live-audio` — legally, and looking perfectly healthy.
  //
  // But `thru` is the factory's `inGain` output, a bare `ctx.createGain()`
  // whose `.gain` `setParam` never writes (it writes the four CV shadows
  // instead). So THRU is BIT-EXACTLY THE MODULE'S INPUT, and that trace would
  // be INVARIANT TO ALL FOUR OF THIS MODULE'S CONTROLS: it would move with the
  // music, look alive, and say nothing whatsoever about the module. Every
  // previous glyph refused here resolved `static` and was caught by the
  // dead-glyph clause; this is the first that resolves LIVE AND IS STILL BLIND,
  // which no gate looks for. It would also be a live moving surface in the
  // compact VRT baseline — what got `analogVco` dropped from batch 3.
  //
  // The picture that IS this module is the raster frame; it is `mono-video` and
  // matches no glyph kind, so it arrives at the dock through `fullViewBody`
  // (below). The lane tile shows controls, strictly more than the placeholder
  // an un-promoted module shows today.
  //
  // ⚠ THE PREVIEW NEEDS THE EXTENSION SLOT, AND WITHOUT IT PROMOTION IS A
  // LOOK LOSS. `hasVideoSurface(def)` is literally `domain === 'video'`, and
  // this module is `domain: 'audio'` with a `mono-video` OUT — a case that
  // predicate's own doc-comment names. So the shell has NO generic route to
  // this module's picture, and promoting it would have replaced the card's
  // live raster with four knobs. `fullViewBody` (#1726, wired) is the seam
  // `videoOut` and `backdraft` already use. Contract- and attest-transparent:
  // `face` is a stripped property and `extension` is a STRING, so the shell
  // imports nothing from this module.
  // ⚠ THE THREE CONTINUOUS CONTROLS ARE FADERS, DECLARED, because the card
  // mounts three `<NeonFader>`s and nothing in a `ParamDef` separates "a throw"
  // from any other continuous scalar. An undeclared face silently swaps the
  // throw for a dial — the `noise` regression `'fader'` exists for, and a real
  // parity loss even though the value semantics are identical. `wrap` is NOT in
  // the map: it is a button on the card and a named `segmented` cell here.
  face: {
    // ⚠ REVISIT THIS RANK WHEN #2000 IS DECIDED. `cursor` sits last because
    // that issue documents it as a change detector that cannot be returned to
    // the value it is displaying — i.e. the rank encodes a DEFECT, not a
    // judgement about what a scan-position control is worth. If #2000 is fixed
    // so SCAN re-seats on any write and addresses a sane unit, it becomes an
    // ordinary position control and belongs well above `wrap`; the B10.2 spec
    // ranked it third for exactly that reading of the module. Left last for now
    // because a 3-cell compact tile must not lead with an untrustworthy
    // control. Pointer left deliberately so this is re-decided rather than
    // fossilised by inheritance.
    order: ['samplesPerFrame', 'gain', 'wrap', 'cursor'],
    glyph: 'none',
    paramCells: { samplesPerFrame: 'fader', gain: 'fader', cursor: 'fader' },
    extension: 'rasterize',
  },

  docs: {
    explanation:
      "An audio→video raster mapper — it crosses the streams by writing your audio signal directly into a video frame as voltage-per-pixel. Every video frame it takes a fixed run of audio samples and paints them, in raster (left-to-right, top-to-bottom) scan order, into the 1024×768 frame: each sample's value becomes a pixel's brightness, and a scan cursor advances and wraps through the frame across frames. This is the FAITHFUL raster mapping (like an analog scan-converter), NOT an oscilloscope trace — a steady tone paints horizontal bands whose spacing and drift track the audio frequency against the line/frame rate, and anything noisy paints texture. It is deliberately untamed: no limiter, no anti-aliasing, no feedback guard — the only ceiling is the 8-bit pixel saturation. The audio also passes through clean (THRU), so RASTERIZE can sit inline on a signal chain while feeding a video module from its OUT.",
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
      cursor: "SCAN — the starting pixel offset of the scan cursor into the 1024×768 frame. It RE-SEATS the running cursor on each change, so it scrubs by moving; the running cursor then drifts on by itself, and re-selecting a value it already shows does nothing (#2000).",
      samplesPerFrame: "SAMP/F — how many audio samples are painted per video frame (16–8000, default ~800 ≈ four-fifths of a scanline at 48k/60fps, since a line is 1024 px); higher values sweep the frame faster and pack more signal per frame.",
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
    // each frame advances the cursor ~0.78 scanlines. Over a 900ms
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
    // VIDEO_RES canvas. Advance (deduped) then blit onto the bridge's canvas.
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
