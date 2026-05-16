// packages/web/src/lib/audio/modules/samsloop.ts
//
// SAMSLOOP — loop-based sample player. User uploads a small audio file
// (≤250 KB) — anything the browser's AudioContext.decodeAudioData accepts:
// wav, mp3, m4a/aac, ogg, flac, opus, weba. The file is decoded into a
// Float32Array, mono-mixed if stereo, and posted into the worklet at
// packages/dsp/src/samsloop.ts.
// Playback runs via a fractional read-cursor with linear interpolation in
// the worklet so varispeed (including reverse) doesn't need a separate
// playback path.
//
// I/O surface:
//   inputs:
//     trig      Gate. Rising edge retriggers the sample at the window edge
//               (start for forward playback, end-1 for reverse).
//     rate_cv   CV → rate AudioParam. ±1 V CV maps to ±1 in rate units, so
//               a ±1V LFO swings the rate by ±100% — combined with the
//               slider this can run between −2 (full-left slider + −1 V CV)
//               and +3 (full-right slider + +1 V CV); the worklet clamps
//               to its declared [−3, +3] range.
//   outputs:
//     out       Mono audio.
//
// Slider mapping (documented in the card panel too):
//   slider full left  = −2.0 → reverse 2×
//   slider center      = +1.0 → forward unity   ← centered "no-op"
//   slider full right = +2.0 → forward 2×
//   So the slider's range is [-2, +2] with default value 1. Negative
//   values play in reverse.
//
// Data shape on node.data:
//   samples: number[]          // mono PCM as a plain JS array — Yjs-safe.
//   sampleRate: number         // source rate; used in the waveform card.
//   sampleLength: number       // samples.length, cached.
//   fileName?: string          // for display.
//
// Hard limit: 250 KB on the raw upload file. Larger files are rejected.
// (Compressed formats at 250 KB decode to roughly 5–15 s of audio at
// typical bitrates, which is the intended scope for a sample looper.)

import type { AudioDomainNodeHandle } from '$lib/audio/engine';
import type { AudioModuleDef } from '$lib/audio/module-registry';
import { patch as livePatch } from '$lib/graph/store';
import workletUrl from '@patchtogether.live/dsp/dist/samsloop.js?url';

const loadedContexts = new WeakSet<BaseAudioContext>();

/** Hard size cap on the uploaded audio file. 250 KB — see card UI. */
export const SAMSLOOP_MAX_FILE_BYTES = 250 * 1024;

export interface SamsloopData {
  samples?: number[];
  sampleRate?: number;
  sampleLength?: number;
  fileName?: string;
}

/** Result of attempting to decode + size-check an audio upload. The card
 *  consumes this — `error` populated means the upload was rejected and
 *  the message is suitable for display. */
export interface SamsloopLoadResult {
  ok: boolean;
  error?: string;
  samples?: Float32Array;
  sampleRate?: number;
}

/** Validate + decode an uploaded audio file (any format the browser's
 *  decodeAudioData accepts — wav, mp3, m4a/aac, ogg, flac, opus, weba).
 *  Decoupled from the card so unit tests can exercise the rejection path
 *  without a DOM. Pass an AudioContext that supports decodeAudioData (a
 *  real one or an OfflineAudioContext) — the function signs the contract;
 *  we don't mock the decoder. */
export async function loadSamsloopWav(
  file: { size: number; arrayBuffer(): Promise<ArrayBuffer> },
  ctx: BaseAudioContext,
): Promise<SamsloopLoadResult> {
  if (file.size > SAMSLOOP_MAX_FILE_BYTES) {
    return {
      ok: false,
      error: `File too large: ${(file.size / 1024).toFixed(1)} KB exceeds the ${
        SAMSLOOP_MAX_FILE_BYTES / 1024
      } KB limit.`,
    };
  }
  let buf: AudioBuffer;
  try {
    const ab = await file.arrayBuffer();
    buf = await ctx.decodeAudioData(ab.slice(0));
  } catch (err) {
    return {
      ok: false,
      error: `Could not decode audio: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  // Mono-mix if stereo. The worklet plays one channel; stereo modules
  // downstream (StereoVCA, mixmstrs) handle widening.
  const len = buf.length;
  const channels = buf.numberOfChannels;
  const mono = new Float32Array(len);
  for (let c = 0; c < channels; c++) {
    const ch = buf.getChannelData(c);
    for (let i = 0; i < len; i++) mono[i]! += ch[i]! / channels;
  }
  return { ok: true, samples: mono, sampleRate: buf.sampleRate };
}

/** Slider position semantics — exported so the card AND the unit tests
 *  share one source of truth. See the comment block at the top of the
 *  file for the convention. */
export const SAMSLOOP_RATE_RANGE = { min: -2, max: 2, defaultValue: 1 } as const;

/** Pure-math helpers — call site is unit tests + the card. Mirrors the
 *  worklet's playback logic (cursor with linear interpolation, wrap on
 *  loop, silence on one-shot exit). Keep in sync with the worklet at
 *  packages/dsp/src/samsloop.ts. */
export const samsloopMath = {
  /** Convert the slider value to a playback rate. Slider center = 1.0
   *  forward; full left = −2 (reverse 2×); full right = +2 (forward 2×).
   *  CV is added on top by the worklet's a-rate `rate` AudioParam, not
   *  here — this is just the slider mapping for tests and labels. */
  sliderToRate(sliderValue: number): number {
    if (!Number.isFinite(sliderValue)) return 1;
    return Math.max(SAMSLOOP_RATE_RANGE.min, Math.min(SAMSLOOP_RATE_RANGE.max, sliderValue));
  },

  /** Clamp start/end indices to a valid window inside `[0, len]`. Caller
   *  passes raw slider-derived values; we enforce start < end and both
   *  inside the buffer. Returns the clamped pair. */
  clampWindow(startRaw: number, endRaw: number, len: number): { start: number; end: number } {
    if (len <= 1) return { start: 0, end: Math.max(1, len) };
    let s = Math.max(0, Math.min(len - 1, Math.floor(startRaw)));
    let e = Math.max(s + 1, Math.min(len, Math.floor(endRaw)));
    return { start: s, end: e };
  },

  /** Render `n` output samples for a given buffer + rate + window + mode.
   *  Used by unit tests to verify forward / reverse / loop / one-shot
   *  semantics without spinning up a real AudioContext. */
  render(
    buf: Float32Array,
    n: number,
    rate: number,
    start: number,
    end: number,
    mode: 'loop' | 'one-shot',
  ): { out: Float32Array; finalCursor: number; active: boolean } {
    const out = new Float32Array(n);
    if (buf.length === 0) return { out, finalCursor: 0, active: false };
    const { start: s, end: e } = samsloopMath.clampWindow(start, end, buf.length);
    let cursor = rate >= 0 ? s : e - 1;
    let active = true;
    for (let i = 0; i < n; i++) {
      if (!active) { out[i] = 0; continue; }
      const ipos = Math.floor(cursor);
      const f = cursor - ipos;
      if (ipos >= 0 && ipos < buf.length - 1) {
        const a = buf[ipos] ?? 0;
        const b = buf[ipos + 1] ?? 0;
        out[i] = a + (b - a) * f;
      } else if (ipos === buf.length - 1) {
        out[i] = buf[ipos] ?? 0;
      } else {
        out[i] = 0;
      }
      cursor += rate;
      if (cursor >= e) {
        if (mode === 'loop') {
          const winLen = e - s;
          cursor = s + ((cursor - s) % winLen);
        } else {
          cursor = e;
          active = false;
        }
      } else if (cursor < s) {
        if (mode === 'loop') {
          const winLen = e - s;
          const overshoot = s - cursor;
          cursor = e - (overshoot % winLen);
        } else {
          cursor = s;
          active = false;
        }
      }
    }
    return { out, finalCursor: cursor, active };
  },
};

const POLL_MS = 200;

export const samsloopDef: AudioModuleDef = {
  type: 'samsloop',
  domain: 'audio',
  label: 'SAMSLOOP',
  category: 'sources',
  schemaVersion: 1,

  inputs: [
    { id: 'trig',    type: 'gate' },
    { id: 'rate_cv', type: 'cv', paramTarget: 'rate', cvScale: { mode: 'linear' } },
  ],
  outputs: [
    { id: 'out', type: 'audio' },
  ],
  params: [
    // Slider value: ±2 maps to ±2× playback. Default = 1 (forward unity).
    // The CV sums into the AudioParam through the linear cvScale, so a
    // ±1V LFO swings the rate by ±1 unit on top of the slider value.
    { id: 'rate',  label: 'Rate',
      defaultValue: SAMSLOOP_RATE_RANGE.defaultValue,
      min: SAMSLOOP_RATE_RANGE.min, max: SAMSLOOP_RATE_RANGE.max,
      curve: 'linear' },
    { id: 'mode',  label: 'Mode',
      defaultValue: 1, min: 0, max: 1, curve: 'discrete' },
    // Start/end ranges are dynamically clamped client-side to the loaded
    // sample length; the param's declared max is a generous ceiling so
    // the slider doesn't need to be re-bounded on every upload.
    { id: 'start', label: 'Start', defaultValue: 0,    min: 0, max: 1e6, curve: 'linear' },
    { id: 'end',   label: 'End',   defaultValue: 1e6,  min: 0, max: 1e6, curve: 'linear' },
  ],

  async factory(ctx, node): Promise<AudioDomainNodeHandle> {
    if (!loadedContexts.has(ctx)) {
      await ctx.audioWorklet.addModule(workletUrl);
      loadedContexts.add(ctx);
    }

    // 1 input slot for the trig gate; rate CV rides into the AudioParam
    // through the engine's cvScale routing (same pattern as macrooscillator).
    const workletNode = new AudioWorkletNode(ctx, 'samsloop', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [1],
    });

    const params = workletNode.parameters as unknown as Map<string, AudioParam>;
    for (const def of samsloopDef.params) {
      const v = (node.params ?? {})[def.id] ?? def.defaultValue;
      params.get(def.id)?.setValueAtTime(v, ctx.currentTime);
    }

    // Send the initial sample (if present in node.data — typically not on
    // first spawn, but rehydrated from a saved patch envelope or multiplayer
    // join). Same poll-on-data-change pattern as WAVECEL — when the card's
    // upload handler mutates node.data, the loop picks it up within POLL_MS
    // and reposts to the worklet.
    let lastSignature: string | null = null;
    function pushSampleIfChanged(): void {
      const live = livePatch.nodes[node.id];
      const d = live?.data as SamsloopData | undefined;
      const samples = d?.samples;
      const sig = samples ? `${samples.length}:${d?.fileName ?? ''}` : 'empty';
      if (sig === lastSignature) return;
      lastSignature = sig;
      if (!samples || samples.length === 0) return;
      // Transfer the underlying buffer to the worklet (zero-copy when the
      // browser supports transferables — falls back to structuredClone
      // otherwise).
      const f32 = new Float32Array(samples);
      workletNode.port.postMessage(
        { type: 'loadSample', samples: f32.buffer },
        [f32.buffer],
      );
    }
    pushSampleIfChanged();

    let alive = true;
    let pollTimer: ReturnType<typeof setTimeout> | null = null;
    function poll(): void {
      if (!alive) return;
      pushSampleIfChanged();
      pollTimer = setTimeout(poll, POLL_MS);
    }
    pollTimer = setTimeout(poll, POLL_MS);

    return {
      domain: 'audio',
      inputs: new Map<string, { node: AudioNode; input: number; param?: AudioParam }>([
        ['trig',    { node: workletNode, input: 0 }],
        ['rate_cv', { node: workletNode, input: 0, param: params.get('rate')! }],
      ]),
      outputs: new Map([
        ['out', { node: workletNode, output: 0 }],
      ]),
      setParam(paramId, value) {
        params.get(paramId)?.setValueAtTime(value, ctx.currentTime);
      },
      readParam(paramId) {
        return params.get(paramId)?.value;
      },
      read(key) {
        if (key === 'sampleLength') {
          const live = livePatch.nodes[node.id];
          return (live?.data as SamsloopData | undefined)?.sampleLength ?? 0;
        }
        return undefined;
      },
      dispose() {
        alive = false;
        if (pollTimer !== null) clearTimeout(pollTimer);
        try { workletNode.disconnect(); } catch { /* */ }
      },
    };
  },
};
