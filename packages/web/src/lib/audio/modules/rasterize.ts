// packages/web/src/lib/audio/modules/rasterize.ts
//
// RASTERIZE — audio → video raster mapper (slice 1 of "crossing the
// streams"; see .myrobots/plans/audio-video-crossing.md, "Locked
// decisions").
//
// An explicit, draggable module: audio in → mono-video out. Each video
// frame it takes a fixed run of audio samples (samplesPerFrame, ~800 at
// 48k/60fps) and writes them as voltage-per-pixel into the 640×360 video
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

import type { AudioDomainNodeHandle } from '$lib/audio/engine';
import type { AudioModuleDef } from '$lib/audio/module-registry';
import { VIDEO_RES } from '$lib/video/engine';
import { RasterPainter, type RasterizeDrawParams } from './rasterize-draw';

export const rasterizeDef: AudioModuleDef = {
  type: 'rasterize',
  domain: 'audio',
  label: 'Rasterize',
  category: 'utilities',
  schemaVersion: 1,

  inputs: [
    // The audio signal to rasterize.
    { id: 'in', type: 'audio' },
    // CV inputs mirror every param 1:1 (port id == param id) so the
    // cross-domain CV bridge routes straight into setParam(portId).
    { id: 'cursor',          type: 'cv', paramTarget: 'cursor' },
    { id: 'samplesPerFrame', type: 'cv', paramTarget: 'samplesPerFrame' },
    { id: 'gain',            type: 'cv', paramTarget: 'gain' },
    { id: 'wrap',            type: 'cv', paramTarget: 'wrap' },
  ],
  outputs: [
    // Audio passthrough so RASTERIZE can sit inline on a signal chain.
    { id: 'thru', type: 'audio' },
    // The raster frame as a GL texture for downstream video consumers.
    { id: 'out', type: 'mono-video' },
  ],
  params: [
    // Scan cursor start offset, in pixels into the 640×360 = 230400-pixel
    // frame. Moving it scrubs the running cursor; otherwise the cursor
    // drifts on its own.
    { id: 'cursor',          label: 'Scan',   defaultValue: 0,   min: 0,   max: 230400, curve: 'linear', units: 'px' },
    // Samples painted per frame. Default 800 ≈ 48k/60fps ≈ 1.25 scanlines.
    { id: 'samplesPerFrame', label: 'Samp/F', defaultValue: 800, min: 16,  max: 8000,   curve: 'log' },
    // Linear gain applied to each sample before the luminance map.
    { id: 'gain',            label: 'Gain',   defaultValue: 1,   min: 0,   max: 8,      curve: 'log' },
    // 0 = wrap (toroidal drift), 1 = clamp (top-to-bottom repaint sweep).
    { id: 'wrap',            label: 'Wrap',   defaultValue: 0,   min: 0,   max: 1,      curve: 'discrete' },
  ],

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

    // Live param cache (single source of truth for both render paths;
    // see SCOPE for the rationale). setParam updates it; the card mirrors
    // patch.nodes[].params for its own faders.
    const params: RasterizeDrawParams = {
      cursor:          (node.params ?? {}).cursor          ?? 0,
      samplesPerFrame: (node.params ?? {}).samplesPerFrame ?? 800,
      gain:            (node.params ?? {}).gain            ?? 1,
      wrap:            (node.params ?? {}).wrap            ?? 0,
    };

    // Single painter at the engine's video resolution. The cross-domain
    // bridge's drawFrame() advances it each video frame; the on-card
    // canvas reads its accumulated framebuffer via read('imageData') so
    // both render paths share one drifting cursor + one painting.
    const painter = new RasterPainter(VIDEO_RES.width, VIDEO_RES.height);

    /** Pull the newest `samplesPerFrame` run from the analyser. The
     *  analyser's getFloatTimeDomainData returns its whole window; the
     *  TAIL is newest, so we take the last `count` samples as this
     *  frame's run. */
    function frameRun(): Float32Array {
      analyser.getFloatTimeDomainData(buf);
      const count = Math.max(1, Math.min(buf.length, Math.floor(params.samplesPerFrame)));
      return buf.subarray(buf.length - count);
    }

    // Frame-advance dedup: both the cross-domain bridge's drawFrame() AND
    // the on-card canvas's read('imageData') want a fresh frame, and when
    // both fire in the same animation frame we must advance the painter
    // (and thus the drifting cursor) only ONCE — otherwise the cursor
    // races at 2× and the banding is wrong. We coalesce on the rAF clock:
    // calls within the same ~16ms slice paint at most once.
    let lastPaintMs = -1;
    function advanceOncePerFrame(): void {
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
      painter.paint(frameRun(), params);
    }

    // The cross-domain bridge calls this each video frame with its own
    // 640×360 canvas. Advance (deduped) then blit onto the bridge's canvas.
    function drawFrame(canvas: OffscreenCanvas | HTMLCanvasElement): void {
      advanceOncePerFrame();
      painter.blitTo(canvas);
    }

    return {
      domain: 'audio',
      inputs: new Map<string, { node: AudioNode; input: number; param?: AudioParam }>([
        ['in', { node: inGain, input: 0 }],
        // CV inputs live on a stable internal AudioParam (inGain.gain) so
        // the engine's per-param tap analyser picks them up; the actual
        // VALUE flows through setParam(portId). We never write to
        // inGain.gain from setParam — it stays at unity passthrough.
        ['cursor',          { node: inGain, input: 0, param: inGain.gain }],
        ['samplesPerFrame', { node: inGain, input: 0, param: inGain.gain }],
        ['gain',            { node: inGain, input: 0, param: inGain.gain }],
        ['wrap',            { node: inGain, input: 0, param: inGain.gain }],
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
        if (paramId === 'cursor') params.cursor = value;
        else if (paramId === 'samplesPerFrame') params.samplesPerFrame = value;
        else if (paramId === 'gain') params.gain = value;
        else if (paramId === 'wrap') params.wrap = value;
      },
      readParam(paramId) {
        switch (paramId) {
          case 'cursor': return params.cursor;
          case 'samplesPerFrame': return params.samplesPerFrame;
          case 'gain': return params.gain;
          case 'wrap': return params.wrap;
          default: return undefined;
        }
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
        return undefined;
      },
      dispose() {
        inGain.disconnect();
        analyser.disconnect();
      },
    };
  },
};
