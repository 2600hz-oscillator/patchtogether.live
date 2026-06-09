// packages/web/src/lib/audio/modules/twotracks.ts
//
// TWOTRACKS — two-reel tape loop emulator. Phase 4: live waveform + WAV export.
//
// Phase 1 surface (reel A):
//   inputs:  audio_l_in_a, audio_r_in_a, rec_start_a, rec_arm_a, overdub_a
//   outputs: out_l, out_r
//   params:  rate_a, mode_a, decay_a, start_a, end_a, overdub_flag_a, playhead_a
//
// Phase 2 additions:
//   inputs (reel B): audio_l_in_b, audio_r_in_b, rec_start_b, rec_arm_b, overdub_b
//   params (reel B): rate_b, mode_b, decay_b, start_b, end_b, overdub_flag_b,
//                    playhead_b
//   per-reel EQ (both reels):
//     eqLow_a, eqMid_a, eqHigh_a  — reel A 3-band EQ (dB ±12, default 0)
//     eqLow_b, eqMid_b, eqHigh_b  — reel B 3-band EQ
//   per-reel filter (both reels):
//     filterMode_a, cutoff_a, reso_a — reel A HP/LP/BP filter
//     filterMode_b, cutoff_b, reso_b — reel B HP/LP/BP filter
//   global:
//     ab — A/B crossfade: 0=A only, 0.5=both unity, 1=B only
//
// Single worklet node handles both reels.
// Playhead messages: { type:'playhead', reel:'a'|'b', pos:0..1, state }

import type { AudioDomainNodeHandle } from '$lib/audio/engine';
import type { AudioModuleDef } from '$lib/audio/module-registry';
import { patch as livePatch } from '$lib/graph/store';
import workletUrl from '@patchtogether.live/dsp/dist/twotracks.js?url';

const loadedContexts = new WeakSet<BaseAudioContext>();

/** Maximum tape buffer length in samples (≈30 s at 48 kHz). */
export const TWOTRACKS_MAX_SAMPLES = 1_440_000;

/** How often to poll node.data for param changes (ms). */
const POLL_MS = 100;

export interface TwoTracksData {
  /** Reel A transport state (posted from worklet). */
  transportState_a?: 'idle' | 'play' | 'armed' | 'rec' | 'overdub';
  /** Reel B transport state (posted from worklet). */
  transportState_b?: 'idle' | 'play' | 'armed' | 'rec' | 'overdub';
  /** Reel A normalized playhead position 0..1. */
  playhead_a?: number;
  /** Reel B normalized playhead position 0..1. */
  playhead_b?: number;
  /** How many samples reel A's ring buffer holds (for duration display + SAVE enabled). */
  bufLenA?: number;
  /** How many samples reel B's ring buffer holds. */
  bufLenB?: number;
}

/** Exported pure A/B gain law — used by the card and unit tests. */
export function abGains(ab: number): { gainA: number; gainB: number } {
  const t = ab < 0 ? 0 : ab > 1 ? 1 : ab;
  if (t <= 0.5) {
    return { gainA: 1.0, gainB: t * 2 };
  } else {
    return { gainA: (1 - t) * 2, gainB: 1.0 };
  }
}

/** Download a stereo WAV file from raw Float32Array buffers. */
function downloadWav(bufL: Float32Array, bufR: Float32Array, bufLen: number, label: string): void {
  const sr = 48000;
  const numChannels = 2;
  const bitsPerSample = 16;
  const numFrames = Math.min(bufLen, bufL.length, bufR.length);
  const byteRate = sr * numChannels * (bitsPerSample / 8);
  const blockAlign = numChannels * (bitsPerSample / 8);
  const dataBytes = numFrames * blockAlign;
  const ab = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(ab);
  const enc = new TextEncoder();
  const w4 = (offset: number, str: string) => {
    const bytes = enc.encode(str);
    for (let i = 0; i < 4; i++) view.setUint8(offset + i, bytes[i] ?? 0);
  };
  w4(0, 'RIFF'); view.setUint32(4, 36 + dataBytes, true);
  w4(8, 'WAVE'); w4(12, 'fmt '); view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); view.setUint16(22, numChannels, true);
  view.setUint32(24, sr, true); view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true); view.setUint16(34, bitsPerSample, true);
  w4(36, 'data'); view.setUint32(40, dataBytes, true);
  let off = 44;
  for (let i = 0; i < numFrames; i++) {
    view.setInt16(off, Math.round(Math.max(-1, Math.min(1, bufL[i] ?? 0)) * 0x7fff), true); off += 2;
    view.setInt16(off, Math.round(Math.max(-1, Math.min(1, bufR[i] ?? 0)) * 0x7fff), true); off += 2;
  }
  const blob = new Blob([ab], { type: 'audio/wav' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = `${label}-${Date.now()}.wav`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

export const twotracksDef: AudioModuleDef = {
  type: 'twotracks',
  label: 'twotracks', // MUST be lowercase (card CSS uppercases for display)
  palette: { top: 'Audio modules', sub: 'VCOs' },
  domain: 'audio',
  category: 'effects',
  schemaVersion: 4,

  inputs: [
    // Reel A
    { id: 'audio_l_in_a', type: 'audio' },
    { id: 'audio_r_in_a', type: 'audio' },
    { id: 'rec_start_a',  type: 'gate' },
    { id: 'rec_arm_a',    type: 'gate' },
    { id: 'overdub_a',    type: 'gate' },
    // Reel B
    { id: 'audio_l_in_b', type: 'audio' },
    { id: 'audio_r_in_b', type: 'audio' },
    { id: 'rec_start_b',  type: 'gate' },
    { id: 'rec_arm_b',    type: 'gate' },
    { id: 'overdub_b',    type: 'gate' },
  ],

  outputs: [
    { id: 'out_l', type: 'audio' },
    { id: 'out_r', type: 'audio' },
  ],

  params: [
    // ---- Reel A ----
    { id: 'rate_a',         label: 'Rate A',    defaultValue: 1,     min: -3,  max: 3,     curve: 'linear' },
    { id: 'mode_a',         label: 'Mode A',    defaultValue: 1,     min: 0,   max: 1,     curve: 'discrete' },
    { id: 'decay_a',        label: 'Decay A',   defaultValue: 0,     min: 0,   max: 1,     curve: 'linear' },
    { id: 'start_a',        label: 'Start A',   defaultValue: 0,     min: 0,   max: 1,     curve: 'linear' },
    { id: 'end_a',          label: 'End A',     defaultValue: 1,     min: 0,   max: 1,     curve: 'linear' },
    { id: 'overdub_flag_a', label: 'Overdub A', defaultValue: 0,     min: 0,   max: 1,     curve: 'discrete' },
    { id: 'playhead_a',     label: 'Playhead A',defaultValue: 0,     min: 0,   max: 1,     curve: 'linear' },
    // EQ reel A
    { id: 'eqLow_a',        label: 'EQ Low A',  defaultValue: 0,     min: -12, max: 12,    curve: 'linear', units: 'dB' },
    { id: 'eqMid_a',        label: 'EQ Mid A',  defaultValue: 0,     min: -12, max: 12,    curve: 'linear', units: 'dB' },
    { id: 'eqHigh_a',       label: 'EQ Hi A',   defaultValue: 0,     min: -12, max: 12,    curve: 'linear', units: 'dB' },
    // Filter reel A
    { id: 'filterMode_a',   label: 'Flt Mode A',defaultValue: 0,     min: 0,   max: 3,     curve: 'discrete' },
    { id: 'cutoff_a',       label: 'Cutoff A',  defaultValue: 20000, min: 20,  max: 20000, curve: 'log', units: 'Hz' },
    { id: 'reso_a',         label: 'Reso A',    defaultValue: 0,     min: 0,   max: 1,     curve: 'linear' },

    // ---- Reel B ----
    { id: 'rate_b',         label: 'Rate B',    defaultValue: 1,     min: -3,  max: 3,     curve: 'linear' },
    { id: 'mode_b',         label: 'Mode B',    defaultValue: 1,     min: 0,   max: 1,     curve: 'discrete' },
    { id: 'decay_b',        label: 'Decay B',   defaultValue: 0,     min: 0,   max: 1,     curve: 'linear' },
    { id: 'start_b',        label: 'Start B',   defaultValue: 0,     min: 0,   max: 1,     curve: 'linear' },
    { id: 'end_b',          label: 'End B',     defaultValue: 1,     min: 0,   max: 1,     curve: 'linear' },
    { id: 'overdub_flag_b', label: 'Overdub B', defaultValue: 0,     min: 0,   max: 1,     curve: 'discrete' },
    { id: 'playhead_b',     label: 'Playhead B',defaultValue: 0,     min: 0,   max: 1,     curve: 'linear' },
    // EQ reel B
    { id: 'eqLow_b',        label: 'EQ Low B',  defaultValue: 0,     min: -12, max: 12,    curve: 'linear', units: 'dB' },
    { id: 'eqMid_b',        label: 'EQ Mid B',  defaultValue: 0,     min: -12, max: 12,    curve: 'linear', units: 'dB' },
    { id: 'eqHigh_b',       label: 'EQ Hi B',   defaultValue: 0,     min: -12, max: 12,    curve: 'linear', units: 'dB' },
    // Filter reel B
    { id: 'filterMode_b',   label: 'Flt Mode B',defaultValue: 0,     min: 0,   max: 3,     curve: 'discrete' },
    { id: 'cutoff_b',       label: 'Cutoff B',  defaultValue: 20000, min: 20,  max: 20000, curve: 'log', units: 'Hz' },
    { id: 'reso_b',         label: 'Reso B',    defaultValue: 0,     min: 0,   max: 1,     curve: 'linear' },

    // ---- Global ----
    { id: 'ab',             label: 'A/B',       defaultValue: 0,     min: 0,   max: 1,     curve: 'linear' },
    { id: 'lofi',           label: 'Lofi',      defaultValue: 0,     min: 0,   max: 3,     curve: 'discrete' },
  ],

  async factory(ctx, node): Promise<AudioDomainNodeHandle> {
    if (!loadedContexts.has(ctx)) {
      await ctx.audioWorklet.addModule(workletUrl);
      loadedContexts.add(ctx);
    }

    // 4 audio inputs: [0]=A-L, [1]=A-R, [2]=B-L, [3]=B-R
    // Gate inputs route as AudioParams (rec_start, rec_arm, overdub_toggle per reel).
    const workletNode = new AudioWorkletNode(ctx, 'twotracks', {
      numberOfInputs: 4, // [0]=A-L, [1]=A-R, [2]=B-L, [3]=B-R
      numberOfOutputs: 1,
      outputChannelCount: [2], // stereo
    });

    // Muted keep-alive
    const sink = ctx.createGain();
    sink.gain.value = 0;
    try {
      workletNode.connect(sink);
      sink.connect(ctx.destination);
    } catch { /* ignore if context already closed */ }

    const params = workletNode.parameters as unknown as Map<string, AudioParam>;

    // Apply initial param values
    for (const def of twotracksDef.params) {
      const v = (node.params ?? {})[def.id] ?? def.defaultValue;
      const wId = cardParamToWorkletParam(def.id);
      if (wId) params.get(wId)?.setValueAtTime(v, ctx.currentTime);
    }

    // Local volatile render state — Float32Array must NOT go through Y.Doc
    // (Y.Doc can't encode typed arrays; peaks are per-frame, not synced state).
    // Card polls these via eng.read(node, 'peaksA'/'peaksB'), same pattern as SCOPE.
    let localPeaksA: Float32Array | null = null;
    let localPeaksB: Float32Array | null = null;
    // Playhead position is per-frame, transient render state — it must NOT be
    // written to the live Y.Doc (a ~90 Hz proxy write during playback is the
    // render-storm class from cv-modulation-live-store-write-storm). Kept local
    // and read by the card's rAF poll, exactly like peaks.
    let localPlayheadA = 0;
    let localPlayheadB = 0;

    // Handle worklet → host messages (playhead + peaks; tape-data for WAV export)
    workletNode.port.onmessage = (e: MessageEvent) => {
      const msg = e.data as {
        type: string;
        reel?: 'a' | 'b';
        pos?: number;
        state?: string;
        bufLen?: number;
        peaks?: Float32Array;
        // tape-data fields (transferred buffers arrive as ArrayBuffer)
      } | null;
      if (!msg) return;

      if (msg.type === 'playhead') {
        const reelId = msg.reel ?? 'a';
        // Peaks stay local — never written to Y.Doc to avoid Float32Array encoding
        // issues and write-storm on every 11ms playhead interval.
        if (msg.peaks instanceof Float32Array) {
          if (reelId === 'a') localPeaksA = msg.peaks;
          else localPeaksB = msg.peaks;
        }
        // Playhead position → local volatile only (polled by the card's rAF).
        if (typeof msg.pos === 'number') {
          if (reelId === 'a') localPlayheadA = msg.pos;
          else localPlayheadB = msg.pos;
        }
        try {
          const live = livePatch.nodes[node.id];
          if (!live) return;
          if (!live.data) (live as { data: TwoTracksData }).data = {} as TwoTracksData;
          const d = live.data as TwoTracksData;
          // ONLY transport state + bufLen go to the Y.Doc — both change rarely
          // (on transport transitions / record growth), not per frame. The
          // worklet already posts these only on change.
          if (reelId === 'a') {
            if (typeof msg.state === 'string' && d.transportState_a !== msg.state) {
              d.transportState_a = msg.state as TwoTracksData['transportState_a'];
            }
            if (typeof msg.bufLen === 'number' && d.bufLenA !== msg.bufLen) d.bufLenA = msg.bufLen;
          } else {
            if (typeof msg.state === 'string' && d.transportState_b !== msg.state) {
              d.transportState_b = msg.state as TwoTracksData['transportState_b'];
            }
            if (typeof msg.bufLen === 'number' && d.bufLenB !== msg.bufLen) d.bufLenB = msg.bufLen;
          }
        } catch { /* node may be deleted */ }

      } else if (msg.type === 'tape-data') {
        // Transferred buffers arrive as plain objects with array data after structured clone
        const raw = e.data as { type: string; reel: 'a' | 'b'; bufLen: number; bufL?: ArrayBuffer; bufR?: ArrayBuffer };
        if (raw.bufL && raw.bufR) {
          downloadWav(
            new Float32Array(raw.bufL),
            new Float32Array(raw.bufR),
            raw.bufLen,
            `twotracks-reel-${raw.reel}`,
          );
        }
      }
    };

    // Poll node.params for changes (overdub flags + all continuous params)
    let lastOverdubFlagA = -1;
    let lastOverdubFlagB = -1;
    let alive = true;
    let pollTimer: ReturnType<typeof setTimeout> | null = null;

    function pollParams(): void {
      if (!alive) return;
      const live = livePatch.nodes[node.id];
      if (live) {
        const p = live.params as Record<string, number>;

        // Reel A continuous params
        params.get('rate')?.setValueAtTime(p.rate_a ?? 1, ctx.currentTime);
        params.get('mode')?.setValueAtTime(p.mode_a ?? 1, ctx.currentTime);
        params.get('decay')?.setValueAtTime(p.decay_a ?? 0, ctx.currentTime);
        params.get('start')?.setValueAtTime(p.start_a ?? 0, ctx.currentTime);
        params.get('end')?.setValueAtTime(p.end_a ?? 1, ctx.currentTime);
        params.get('eqLow_a')?.setValueAtTime(p.eqLow_a ?? 0, ctx.currentTime);
        params.get('eqMid_a')?.setValueAtTime(p.eqMid_a ?? 0, ctx.currentTime);
        params.get('eqHigh_a')?.setValueAtTime(p.eqHigh_a ?? 0, ctx.currentTime);
        params.get('filterMode_a')?.setValueAtTime(p.filterMode_a ?? 0, ctx.currentTime);
        params.get('cutoff_a')?.setValueAtTime(p.cutoff_a ?? 20000, ctx.currentTime);
        params.get('reso_a')?.setValueAtTime(p.reso_a ?? 0, ctx.currentTime);

        // Reel B continuous params
        params.get('rate_b')?.setValueAtTime(p.rate_b ?? 1, ctx.currentTime);
        params.get('mode_b')?.setValueAtTime(p.mode_b ?? 1, ctx.currentTime);
        params.get('decay_b')?.setValueAtTime(p.decay_b ?? 0, ctx.currentTime);
        params.get('start_b')?.setValueAtTime(p.start_b ?? 0, ctx.currentTime);
        params.get('end_b')?.setValueAtTime(p.end_b ?? 1, ctx.currentTime);
        params.get('eqLow_b')?.setValueAtTime(p.eqLow_b ?? 0, ctx.currentTime);
        params.get('eqMid_b')?.setValueAtTime(p.eqMid_b ?? 0, ctx.currentTime);
        params.get('eqHigh_b')?.setValueAtTime(p.eqHigh_b ?? 0, ctx.currentTime);
        params.get('filterMode_b')?.setValueAtTime(p.filterMode_b ?? 0, ctx.currentTime);
        params.get('cutoff_b')?.setValueAtTime(p.cutoff_b ?? 20000, ctx.currentTime);
        params.get('reso_b')?.setValueAtTime(p.reso_b ?? 0, ctx.currentTime);

        // Global A/B
        params.get('ab')?.setValueAtTime(p.ab ?? 0, ctx.currentTime);

        // Global Lofi
        params.get('lofi')?.setValueAtTime(p.lofi ?? 0, ctx.currentTime);

        // Overdub toggle pulses (rising-edge driven)
        const ovFlagA = p.overdub_flag_a ?? 0;
        if (ovFlagA !== lastOverdubFlagA) {
          lastOverdubFlagA = ovFlagA;
          const tp = params.get('overdub_toggle');
          if (tp) {
            tp.setValueAtTime(0, ctx.currentTime);
            tp.setValueAtTime(1, ctx.currentTime + 0.001);
            tp.setValueAtTime(0, ctx.currentTime + 0.002);
          }
        }
        const ovFlagB = p.overdub_flag_b ?? 0;
        if (ovFlagB !== lastOverdubFlagB) {
          lastOverdubFlagB = ovFlagB;
          const tp = params.get('overdub_toggle_b');
          if (tp) {
            tp.setValueAtTime(0, ctx.currentTime);
            tp.setValueAtTime(1, ctx.currentTime + 0.001);
            tp.setValueAtTime(0, ctx.currentTime + 0.002);
          }
        }
      }
      pollTimer = setTimeout(pollParams, POLL_MS);
    }
    pollTimer = setTimeout(pollParams, POLL_MS);

    return {
      domain: 'audio',

      inputs: new Map<string, { node: AudioNode; input: number; param?: AudioParam }>([
        // Reel A audio + gates
        ['audio_l_in_a', { node: workletNode, input: 0 }],
        ['audio_r_in_a', { node: workletNode, input: 1 }],
        ['rec_start_a',  { node: workletNode, input: 0, param: params.get('rec_start')! }],
        ['rec_arm_a',    { node: workletNode, input: 0, param: params.get('rec_arm')! }],
        ['overdub_a',    { node: workletNode, input: 0, param: params.get('overdub_toggle')! }],
        // Reel B audio + gates
        ['audio_l_in_b', { node: workletNode, input: 2 }],
        ['audio_r_in_b', { node: workletNode, input: 3 }],
        ['rec_start_b',  { node: workletNode, input: 0, param: params.get('rec_start_b')! }],
        ['rec_arm_b',    { node: workletNode, input: 0, param: params.get('rec_arm_b')! }],
        ['overdub_b',    { node: workletNode, input: 0, param: params.get('overdub_toggle_b')! }],
      ]),

      outputs: new Map([
        ['out_l', { node: workletNode, output: 0 }],
        ['out_r', { node: workletNode, output: 0 }],
      ]),

      setParam(paramId: string, value: number) {
        const wId = cardParamToWorkletParam(paramId);
        if (wId) params.get(wId)?.setValueAtTime(value, ctx.currentTime);
      },

      readParam(paramId: string) {
        const wId = cardParamToWorkletParam(paramId);
        if (wId) return params.get(wId)?.value;
        return undefined;
      },

      read(key: string) {
        if (key === 'workletPort') return workletNode.port;
        if (key === 'sampleRate') return ctx.sampleRate;
        if (key === 'peaksA') return localPeaksA;
        if (key === 'peaksB') return localPeaksB;
        if (key === 'playheadA') return localPlayheadA;
        if (key === 'playheadB') return localPlayheadB;
        return undefined;
      },

      dispose() {
        alive = false;
        localPeaksA = null;
        localPeaksB = null;
        localPlayheadA = 0;
        localPlayheadB = 0;
        if (pollTimer !== null) clearTimeout(pollTimer);
        try { workletNode.port.onmessage = null; } catch { /* */ }
        try { workletNode.disconnect(); } catch { /* */ }
        try { sink.disconnect(); } catch { /* */ }
      },
    };
  },
};

/**
 * Map a card-side param ID to the worklet AudioParam name.
 * Returns null for display-only params (playhead_{a,b}).
 */
function cardParamToWorkletParam(cardId: string): string | null {
  const MAP: Record<string, string> = {
    // Reel A — core (keep backward-compat worklet param names)
    rate_a:          'rate',
    mode_a:          'mode',
    decay_a:         'decay',
    start_a:         'start',
    end_a:           'end',
    // EQ reel A (worklet param names match card IDs)
    eqLow_a:         'eqLow_a',
    eqMid_a:         'eqMid_a',
    eqHigh_a:        'eqHigh_a',
    // Filter reel A
    filterMode_a:    'filterMode_a',
    cutoff_a:        'cutoff_a',
    reso_a:          'reso_a',
    // Reel B — all params use _b suffix in worklet too
    rate_b:          'rate_b',
    mode_b:          'mode_b',
    decay_b:         'decay_b',
    start_b:         'start_b',
    end_b:           'end_b',
    eqLow_b:         'eqLow_b',
    eqMid_b:         'eqMid_b',
    eqHigh_b:        'eqHigh_b',
    filterMode_b:    'filterMode_b',
    cutoff_b:        'cutoff_b',
    reso_b:          'reso_b',
    // Global
    ab:              'ab',
    lofi:            'lofi',
    // Transient scrub-velocity params (not in def.params, not persisted)
    scrubVelocity_a: 'scrubVelocity_a',
    scrubVelocity_b: 'scrubVelocity_b',
    // Display-only / toggle-handled params — no direct AudioParam
    // overdub_flag_a: handled via pulsed overdub_toggle
    // overdub_flag_b: handled via pulsed overdub_toggle_b
    // playhead_a: display-only
    // playhead_b: display-only
  };
  return MAP[cardId] ?? null;
}
