// packages/web/src/lib/audio/modules/twotracks.ts
//
// TWOTRACKS — two-reel tape loop emulator. Phase 1: reel A only.
//
// A tape-style record/play/overdub looper. Records live audio into an
// internal ring buffer with destructive or additive write, varispeed
// playback, draggable playhead scrub, and WAV export.
//
// Phase 1 surface (reel A only):
//   inputs:
//     audio_l_in_a  — left audio input
//     audio_r_in_a  — right audio input (normalizes to L when unpatched)
//     rec_start_a   — gate: rising edge begins recording (REC or OVERDUB)
//     rec_arm_a     — gate: rising edge arms (waits for loop-start crossing)
//     overdub_a     — gate: rising edge toggles overdub flag
//   outputs:
//     out_l         — left audio output
//     out_r         — right audio output
//
//   params:
//     rate_a        — varispeed rate (–3..+3, default 1.0 = forward unity)
//     mode_a        — 0=one-shot, 1=loop tape (default 1)
//     decay_a       — overdub decay amount (0..1, maps to 0.90..0.50 factor)
//     start_a       — normalized window start (0..1, default 0)
//     end_a         — normalized window end (0..1, default 1)
//     playhead_a    — read-only: worklet posts playhead position back to host
//     overdub_flag_a — 0/1 toggle: 0=destructive REC, 1=additive OVERDUB
//
// The worklet (`twotracks.ts` processor) handles both play and record.
// No separate tap worklet needed for P1.
//
// Data shape on node.data:
//   tapeA?: {
//     bufL: number[]; // Float32 PCM for display waveform (L channel)
//     bufR: number[]; // Float32 PCM for display waveform (R channel)
//     bufLen: number; // active sample count
//   }
//   transportState_a?: 'idle'|'play'|'armed'|'rec'|'overdub'
//   playhead_a?: number; // 0..1 normalized, updated from worklet postMessage

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
  /** Tape buffer for display (waveform canvas). Populated by the card
   *  on recording stop — NOT written per-frame by the worklet (to avoid
   *  the Y.Doc write-storm trap). The card copies samples out via a
   *  port message from the worklet when needed. */
  tapeA?: {
    bufL: number[];
    bufR: number[];
    bufLen: number;
  };
  /** Most recent transport state, posted back from the worklet. Read by
   *  the card to show REC / ARM / PLAY LEDs. */
  transportState_a?: 'idle' | 'play' | 'armed' | 'rec' | 'overdub';
  /** Most recent normalized playhead position (0..1 within the window).
   *  Posted from the worklet; read by the card to position the line. */
  playhead_a?: number;
}

export const twotracksDef: AudioModuleDef = {
  type: 'twotracks',
  label: 'twotracks', // MUST be lowercase (card CSS uppercases for display)
  palette: { top: 'Audio modules', sub: 'Samplers' },
  domain: 'audio',
  category: 'effects',
  schemaVersion: 1,

  inputs: [
    { id: 'audio_l_in_a', type: 'audio' },
    { id: 'audio_r_in_a', type: 'audio' },
    { id: 'rec_start_a',  type: 'gate' },
    { id: 'rec_arm_a',    type: 'gate' },
    { id: 'overdub_a',    type: 'gate' },
  ],

  outputs: [
    { id: 'out_l', type: 'audio' },
    { id: 'out_r', type: 'audio' },
  ],

  params: [
    { id: 'rate_a',        label: 'Rate',    defaultValue: 1,   min: -3, max: 3, curve: 'linear' },
    { id: 'mode_a',        label: 'Mode',    defaultValue: 1,   min: 0,  max: 1, curve: 'discrete' },
    { id: 'decay_a',       label: 'Decay',   defaultValue: 0,   min: 0,  max: 1, curve: 'linear' },
    { id: 'start_a',       label: 'Start',   defaultValue: 0,   min: 0,  max: 1, curve: 'linear' },
    { id: 'end_a',         label: 'End',     defaultValue: 1,   min: 0,  max: 1, curve: 'linear' },
    // overdub_flag_a: 0 = destructive REC, 1 = additive OVERDUB.
    // Written by the card's overdub toggle button via setNodeParam.
    { id: 'overdub_flag_a', label: 'Overdub', defaultValue: 0,  min: 0,  max: 1, curve: 'discrete' },
    // playhead_a: read-only display param (0..1 normalized cursor position).
    // Updated via worklet postMessage → node.data.playhead_a (NOT via AudioParam
    // writes per-frame — avoids the Y.Doc write-storm, see cv-modulation memory).
    { id: 'playhead_a',    label: 'Playhead', defaultValue: 0,  min: 0,  max: 1, curve: 'linear' },
  ],

  async factory(ctx, node): Promise<AudioDomainNodeHandle> {
    if (!loadedContexts.has(ctx)) {
      await ctx.audioWorklet.addModule(workletUrl);
      loadedContexts.add(ctx);
    }

    // Two audio inputs (L + R) + three gate inputs as separate worklet inputs.
    // We map the gate inputs as AudioParams (rec_start, rec_arm, overdub_toggle)
    // because gates route as audio-rate connections to AudioParams in the engine.
    // The worklet detects rising edges on those params.
    const workletNode = new AudioWorkletNode(ctx, 'twotracks', {
      numberOfInputs: 2, // [0] = L audio, [1] = R audio
      numberOfOutputs: 1,
      outputChannelCount: [2], // stereo: [0]=L, [1]=R in the buffer
    });

    // Muted keep-alive: connect output to a 0-gain destination so the worklet
    // process() is always called (a node with no downstream may be paused by
    // some browser implementations).
    const sink = ctx.createGain();
    sink.gain.value = 0;
    try {
      workletNode.connect(sink);
      sink.connect(ctx.destination);
    } catch { /* ignore if context already closed */ }

    const params = workletNode.parameters as unknown as Map<string, AudioParam>;

    // Apply initial param values from node.params.
    for (const def of twotracksDef.params) {
      const v = (node.params ?? {})[def.id] ?? def.defaultValue;
      // Map twotracks card params → worklet AudioParam names.
      const wParamId = cardParamToWorkletParam(def.id);
      if (wParamId) {
        params.get(wParamId)?.setValueAtTime(v, ctx.currentTime);
      }
    }

    // Handle worklet → host messages (playhead updates, state).
    workletNode.port.onmessage = (e: MessageEvent) => {
      const msg = e.data as { type: string; pos?: number; state?: string } | null;
      if (!msg) return;
      if (msg.type === 'playhead') {
        // Update node.data.playhead_a and transportState_a — local writes
        // via livePatch (NOT per-frame Y.Doc transact) to avoid write-storm.
        // The card reads these via $derived(node?.data) reactive bindings.
        try {
          const live = livePatch.nodes[node.id];
          if (!live) return;
          if (!live.data) (live as { data: TwoTracksData }).data = {} as TwoTracksData;
          const d = live.data as TwoTracksData;
          if (typeof msg.pos === 'number' && d.playhead_a !== msg.pos) {
            d.playhead_a = msg.pos;
          }
          if (typeof msg.state === 'string' && d.transportState_a !== msg.state) {
            d.transportState_a = msg.state as TwoTracksData['transportState_a'];
          }
        } catch { /* node may be deleted */ }
      }
    };

    // Poll node.data for overdub_flag_a changes from the card UI toggle.
    let lastOverdubFlag = -1;
    let alive = true;
    let pollTimer: ReturnType<typeof setTimeout> | null = null;

    function pollParams(): void {
      if (!alive) return;
      const live = livePatch.nodes[node.id];
      if (live) {
        const p = live.params as Record<string, number>;
        const rate    = p.rate_a    ?? 1;
        const mode    = p.mode_a    ?? 1;
        const decay   = p.decay_a   ?? 0;
        const start   = p.start_a   ?? 0;
        const end     = p.end_a     ?? 1;
        const ovFlag  = p.overdub_flag_a ?? 0;

        params.get('rate')?. setValueAtTime(rate,  ctx.currentTime);
        params.get('mode')?. setValueAtTime(mode,  ctx.currentTime);
        params.get('decay')?.setValueAtTime(decay, ctx.currentTime);
        params.get('start')?.setValueAtTime(start, ctx.currentTime);
        params.get('end')?. setValueAtTime(end,   ctx.currentTime);

        // Only post overdub toggle message when flag changes.
        if (ovFlag !== lastOverdubFlag) {
          lastOverdubFlag = ovFlag;
          // Post a brief "1" pulse to the worklet's overdub_toggle param
          // by scheduling a value change. The worklet detects rising edge.
          // Use a short AudioParam ramp so the edge is clean.
          const tp = params.get('overdub_toggle');
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
        // Audio L + R go to the worklet's two audio inputs.
        ['audio_l_in_a', { node: workletNode, input: 0 }],
        ['audio_r_in_a', { node: workletNode, input: 1 }],
        // Gate inputs route to AudioParams on the worklet.
        ['rec_start_a', { node: workletNode, input: 0, param: params.get('rec_start')! }],
        ['rec_arm_a',   { node: workletNode, input: 0, param: params.get('rec_arm')! }],
        ['overdub_a',   { node: workletNode, input: 0, param: params.get('overdub_toggle')! }],
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
        return undefined;
      },

      dispose() {
        alive = false;
        if (pollTimer !== null) clearTimeout(pollTimer);
        try { workletNode.port.onmessage = null; } catch { /* */ }
        try { workletNode.disconnect(); } catch { /* */ }
        try { sink.disconnect(); } catch { /* */ }
      },
    };
  },
};

/**
 * Map a card-side param ID (e.g. 'rate_a') to the worklet AudioParam name
 * (e.g. 'rate'). Returns null for display-only params like 'playhead_a'
 * that are NOT backed by a worklet AudioParam.
 */
function cardParamToWorkletParam(cardId: string): string | null {
  const MAP: Record<string, string> = {
    rate_a:   'rate',
    mode_a:   'mode',
    decay_a:  'decay',
    start_a:  'start',
    end_a:    'end',
    // overdub_flag_a is handled via a toggling pulse, not a steady AudioParam value.
    // playhead_a is display-only — no worklet AudioParam.
  };
  return MAP[cardId] ?? null;
}
