// packages/web/src/lib/audio/modules/cocoadelay.ts
//
// COCOA DELAY — port of Tilde Murray's "Cocoa Delay" (GPL-3.0) as a
// patchable stereo delay effect. TS AudioWorklet (see
// packages/dsp/src/cocoadelay.ts for the per-sample DSP).
//
// Ports:
//   in L / in R  — stereo audio in
//   out L / out R— stereo audio out
//   clock        — gate/clock CV; when patched + tempo-sync != Off, the
//                  delay time locks to the measured pulse period × division.
//   CV inputs    — time, feedback, mix(=wet), drive(=gain), lfoAmt, drift,
//                  pan, duck — the musical continuous params, per the
//                  per-param-CV convention other modules use.
//
// Tempo sync (two pieces, faithful to the brief):
//   • clockSource (dropdown): SYSTEM (TIMELORDE) vs MIDI (MIDICLOCK). These
//     route to GENUINELY different tempo references:
//       - System → the rack's TIMELORDE `bpm` (read off the live patch graph,
//         same as CLOCKED RUNNER does).
//       - MIDI   → the shared MIDI-clock source (0xF8 @ 24 PPQN → derived BPM).
//     The worklet can't read those singletons (AudioWorkletGlobalScope), so a
//     main-thread loop resolves the chosen source's seconds-per-beat and
//     bridges it via the `syncPeriod` AudioParam.
//   • tempoSync (dropdown): Off → free-running ms (the TIME knob); otherwise
//     a musical division of that beat (1/4, 1/8, dotted, triplet …) exactly
//     like the original plugin's host-tempo sync.
//   • A PATCHED `clock` gate input STILL overrides both sources — the DSP
//     measures the pulse period and uses it directly (existing behavior).
//
// Inputs:
//   inL / inR (audio): stereo input.
//   clock (gate): external clock; when patched (and tempoSync ≠ Off) the delay locks to the period.
//   time_cv / feedback_cv / mix_cv / drive_cv / lfo_cv / drift_cv / pan_cv / duck_cv
//     (cv, paramTarget=…): per-macro CV.
//
// Outputs:
//   outL / outR (audio): wet+dry stereo output.
//
// Params:
//   delayTime (log 0.001..2.0 s, default 0.2): tap time.
//   tempoSync (discrete 0..19, default 0): 0 = Off (use ms), else musical division.
//   clockSource (discrete 0..1, default 0): 0 = SYSTEM (TIMELORDE), 1 = MIDI (MIDICLOCK).
//   syncPeriod (linear 0..30 s, default 0): cached sync period.
//   lfoAmount (linear 0..0.5, default 0.0): LFO depth on time.
//   lfoFrequency (log 0.1..10.0 Hz, default 2.0): LFO rate.
//   driftAmount (linear 0..0.05, default 0.001): random drift on time.
//   driftSpeed (log 0.1..10.0, default 1.0): drift rate.
//   feedback (linear -1..1, default 0.5): tape-style feedback (negative inverts).
//   stereoOffset (linear -0.5..0.5, default 0.0): L/R time offset.
//   pan (linear -π..π, default 0.0): wet-channel rotation.
//   panMode (discrete 0..2, default 0): pan-curve mode picker.
//   duckAmount (linear 0..10.0, default 0.0): input-ducks-wet amount.
//   duckAttack / duckRelease (log 0.1..100.0, default 10.0): ducker envelope.
//   filterMode (discrete 0..3, default 0): in-loop filter mode.
//   lowCut / highCut (linear, default 0.75 / 0.001): in-loop HPF/LPF.
//   driveGain (linear 0..10.0, default 0.1): in-loop saturation drive.
//   driveMix (linear 0..1, default 1.0): wet/dry across the saturator.
//   driveCutoff (linear 0.01..1.0, default 1.0): post-saturator cutoff.
//   driveIterations (discrete 1..16, default 1): saturator iteration count.
//   dryVolume (linear 0..2.0, default 1.0): dry-bus level.
//   wetVolume (linear 0..2.0, default 0.5): wet-bus level.

import type { AudioDomainNodeHandle } from '$lib/audio/engine';
import type { AudioModuleDef } from '$lib/audio/module-registry';
import { patch as livePatch } from '$lib/graph/store';
import { getMidiClockSource } from '$lib/midi/midi-clock-source';
import workletUrl from '@patchtogether.live/dsp/dist/cocoadelay.js?url';

/** clockSource dropdown indices (must match COCOA_CLOCK_SOURCE_OPTIONS). */
const CLOCK_SOURCE_SYSTEM = 0;
const CLOCK_SOURCE_MIDI = 1;

/** Read the rack's TIMELORDE bpm off the live patch graph (mirrors
 *  CLOCKED RUNNER). Returns the default 120 when no TIMELORDE is present. */
export function readTimelordeBpm(nodes: Record<string, { type?: string; params?: Record<string, unknown> } | undefined>): number {
  for (const n of Object.values(nodes)) {
    if (n?.type === 'timelorde') {
      const bpm = n.params?.['bpm'];
      if (typeof bpm === 'number' && bpm > 0) return bpm;
    }
  }
  return 120;
}

/** Resolve seconds-per-beat for the chosen clockSource. MIDI returns null
 *  when no live MIDI clock is being received (caller leaves syncPeriod=0 so
 *  the worklet falls back to the free-running knob until clock arrives). */
export function resolveSyncPeriodS(
  clockSource: number,
  nodes: Record<string, { type?: string; params?: Record<string, unknown> } | undefined>,
  midiBeatPeriodS: number | null,
): number {
  if (clockSource === CLOCK_SOURCE_MIDI) {
    return midiBeatPeriodS !== null && midiBeatPeriodS > 0 ? midiBeatPeriodS : 0;
  }
  // System (default / index 0): TIMELORDE.
  return 60 / readTimelordeBpm(nodes);
}

const loadedContexts = new WeakSet<BaseAudioContext>();

/** Tempo-sync dropdown options (index → label). Index 0 = Off (free ms);
 *  the rest map 1:1 onto SYNC_BEATS in the worklet. */
export const COCOA_TEMPO_SYNC_OPTIONS: readonly string[] = [
  'Off',
  '1', '1/2D', '1/2', '1/2T', '1/4D', '1/4', '1/4T',
  '1/8D', '1/8', '1/8T', '1/16D', '1/16', '1/16T',
  '1/32D', '1/32', '1/32T', '1/64D', '1/64', '1/64T',
];

/** Clock-source dropdown (index → label). */
export const COCOA_CLOCK_SOURCE_OPTIONS: readonly string[] = ['System', 'MIDI'];

/** Pan-mode dropdown (index → label). */
export const COCOA_PAN_MODE_OPTIONS: readonly string[] = ['Static', 'Ping-Pong', 'Circular'];

/** Filter-mode dropdown (index → label). */
export const COCOA_FILTER_MODE_OPTIONS: readonly string[] = ['1-pole', '2-pole', '4-pole', 'State-var'];

export const cocoaDelayDef: AudioModuleDef = {
  type: 'cocoadelay',
  palette: { top: 'Audio modules', sub: 'Effects' },
  card: 'CocoaDelayCard',
  domain: 'audio',
  label: 'cocoa delay',
  category: 'effects',
  schemaVersion: 1,
  stereoPairs: [['inL', 'inR'], ['outL', 'outR']],
  ossAttribution: { author: 'Tilde Murray (Cocoa Delay, GPL-3.0)' },

  inputs: [
    { id: 'inL', type: 'audio' },
    { id: 'inR', type: 'audio' },
    // External clock for tempo sync (TIMELORDE or MIDICLOCK).
    { id: 'clock', type: 'gate' },
    // Per-param CV (range standard per .myrobots/plans/cv-range-standard.md).
    { id: 'time_cv',     type: 'cv', paramTarget: 'delayTime', cvScale: { mode: 'log' } },
    { id: 'feedback_cv', type: 'cv', paramTarget: 'feedback',  cvScale: { mode: 'linear' } },
    { id: 'mix_cv',      type: 'cv', paramTarget: 'wetVolume', cvScale: { mode: 'linear' } },
    { id: 'drive_cv',    type: 'cv', paramTarget: 'driveGain', cvScale: { mode: 'linear' } },
    { id: 'lfo_cv',      type: 'cv', paramTarget: 'lfoAmount', cvScale: { mode: 'linear' } },
    { id: 'drift_cv',    type: 'cv', paramTarget: 'driftAmount', cvScale: { mode: 'linear' } },
    { id: 'pan_cv',      type: 'cv', paramTarget: 'pan',       cvScale: { mode: 'linear' } },
    { id: 'duck_cv',     type: 'cv', paramTarget: 'duckAmount', cvScale: { mode: 'linear' } },
  ],
  outputs: [
    { id: 'outL', type: 'audio' },
    { id: 'outR', type: 'audio' },
  ],
  params: [
    // DELAY / TIME
    { id: 'delayTime',   label: 'Time',     defaultValue: 0.2,  min: 0.001, max: 2.0,  curve: 'log',      units: 's' },
    { id: 'tempoSync',   label: 'Sync',     defaultValue: 0,    min: 0,     max: 19,   curve: 'discrete' },
    { id: 'clockSource', label: 'Clk Src',  defaultValue: 0,    min: 0,     max: 1,    curve: 'discrete' },
    // Bridged from the WEB layer each frame (System=TIMELORDE / MIDI=MIDICLOCK
    // seconds-per-beat). Not user-facing — no card control. 0 = none.
    { id: 'syncPeriod',  label: 'SyncPer',  defaultValue: 0,    min: 0,     max: 30,   curve: 'linear', units: 's' },
    // LFO
    { id: 'lfoAmount',    label: 'LFO Amt',  defaultValue: 0.0,  min: 0.0,   max: 0.5,  curve: 'linear' },
    { id: 'lfoFrequency', label: 'LFO Freq', defaultValue: 2.0,  min: 0.1,   max: 10.0, curve: 'log',   units: 'hz' },
    // DRIFT
    { id: 'driftAmount', label: 'Drift Amt', defaultValue: 0.001, min: 0.0,  max: 0.05, curve: 'linear' },
    { id: 'driftSpeed',  label: 'Drift Spd', defaultValue: 1.0,   min: 0.1,  max: 10.0, curve: 'log' },
    // FEEDBACK
    { id: 'feedback',     label: 'Feedback', defaultValue: 0.5,  min: -1.0,  max: 1.0,  curve: 'linear' },
    { id: 'stereoOffset', label: 'Stereo',   defaultValue: 0.0,  min: -0.5,  max: 0.5,  curve: 'linear' },
    { id: 'pan',          label: 'Pan',      defaultValue: 0.0,  min: -Math.PI * 0.5, max: Math.PI * 0.5, curve: 'linear' },
    { id: 'panMode',      label: 'Pan Mode', defaultValue: 0,    min: 0,     max: 2,    curve: 'discrete' },
    // DUCKING
    { id: 'duckAmount',  label: 'Duck Amt', defaultValue: 0.0,  min: 0.0,   max: 10.0, curve: 'linear' },
    { id: 'duckAttack',  label: 'Attack',   defaultValue: 10.0, min: 0.1,   max: 100.0, curve: 'log' },
    { id: 'duckRelease', label: 'Release',  defaultValue: 10.0, min: 0.1,   max: 100.0, curve: 'log' },
    // FILTER (in feedback path)
    { id: 'filterMode', label: 'Filt Mode', defaultValue: 0,    min: 0,     max: 3,    curve: 'discrete' },
    { id: 'lowCut',     label: 'Low Cut',   defaultValue: 0.75, min: 0.01,  max: 1.0,  curve: 'linear' },
    { id: 'highCut',    label: 'High Cut',  defaultValue: 0.001, min: 0.001, max: 0.99, curve: 'linear' },
    // DRIVE
    { id: 'driveGain',       label: 'Gain',  defaultValue: 0.1,  min: 0.0,   max: 10.0, curve: 'linear' },
    { id: 'driveMix',        label: 'D.Mix', defaultValue: 1.0,  min: 0.0,   max: 1.0,  curve: 'linear' },
    { id: 'driveCutoff',     label: 'D.Filt',defaultValue: 1.0,  min: 0.01,  max: 1.0,  curve: 'linear' },
    { id: 'driveIterations', label: 'Iters', defaultValue: 1,    min: 1,     max: 16,   curve: 'discrete' },
    // DRY / WET
    { id: 'dryVolume', label: 'Dry', defaultValue: 1.0, min: 0.0, max: 2.0, curve: 'linear' },
    { id: 'wetVolume', label: 'Wet', defaultValue: 0.5, min: 0.0, max: 2.0, curve: 'linear' },
  ],

  async factory(ctx, node): Promise<AudioDomainNodeHandle> {
    if (!loadedContexts.has(ctx)) {
      await ctx.audioWorklet.addModule(workletUrl);
      loadedContexts.add(ctx);
    }

    const workletNode = new AudioWorkletNode(ctx, 'cocoadelay', {
      numberOfInputs: 3, // L, R, clock
      numberOfOutputs: 2,
      outputChannelCount: [1, 1],
    });

    // Keep the node alive when nothing is patched in.
    const silenceL = ctx.createConstantSource();
    const silenceR = ctx.createConstantSource();
    const silenceClk = ctx.createConstantSource();
    silenceL.offset.value = 0;
    silenceR.offset.value = 0;
    silenceClk.offset.value = 0;
    silenceL.start();
    silenceR.start();
    silenceClk.start();
    silenceL.connect(workletNode, 0, 0);
    silenceR.connect(workletNode, 0, 1);
    silenceClk.connect(workletNode, 0, 2);

    const params = workletNode.parameters as unknown as Map<string, AudioParam>;
    for (const def of cocoaDelayDef.params) {
      const v = (node.params ?? {})[def.id] ?? def.defaultValue;
      params.get(def.id)?.setValueAtTime(v, ctx.currentTime);
    }

    // --- sync-period bridge ---------------------------------------------
    // The worklet can't read TIMELORDE / the MIDI-clock singleton (it's in
    // AudioWorkletGlobalScope). Resolve the chosen clockSource's beat period
    // on the main thread and feed it to the worklet via the `syncPeriod`
    // AudioParam. ~60 Hz is plenty (tempo changes are gestural); a patched
    // `clock` gate still overrides this inside the DSP.
    //
    // The MIDI clock source is constructed here (cheap, no I/O) but we ONLY
    // READ it (getBeatPeriodS) when the user has actually selected MIDI as the
    // clockSource. Reading is what triggers navigator.requestMIDIAccess(), so
    // spawning a COCOA DELAY on the default System clock must NOT touch the
    // MIDI source — that would pop the browser permission prompt unprompted.
    const syncPeriodParam = params.get('syncPeriod');
    const nodeId = node.id;
    const midiClock = getMidiClockSource();
    let syncTimer: ReturnType<typeof setInterval> | null = null;
    function pushSyncPeriod(): void {
      if (!syncPeriodParam) return;
      const live = livePatch.nodes[nodeId];
      const clockSource = Math.round(
        (typeof live?.params?.['clockSource'] === 'number'
          ? (live.params['clockSource'] as number)
          : (node.params?.['clockSource'] as number | undefined)) ?? 0,
      );
      // Only read the MIDI tempo (and thus request MIDI access) when MIDI is
      // the selected clock. System keeps null and never prompts.
      const midiBeatPeriodS =
        clockSource === CLOCK_SOURCE_MIDI ? midiClock.getBeatPeriodS() : null;
      const period = resolveSyncPeriodS(
        clockSource,
        livePatch.nodes,
        midiBeatPeriodS,
      );
      syncPeriodParam.setValueAtTime(period, ctx.currentTime);
    }
    pushSyncPeriod();
    syncTimer = setInterval(pushSyncPeriod, 16);

    return {
      domain: 'audio',
      inputs: new Map([
        ['inL',         { node: workletNode, input: 0 }],
        ['inR',         { node: workletNode, input: 1 }],
        ['clock',       { node: workletNode, input: 2 }],
        ['time_cv',     { node: workletNode, input: 0, param: params.get('delayTime')! }],
        ['feedback_cv', { node: workletNode, input: 0, param: params.get('feedback')! }],
        ['mix_cv',      { node: workletNode, input: 0, param: params.get('wetVolume')! }],
        ['drive_cv',    { node: workletNode, input: 0, param: params.get('driveGain')! }],
        ['lfo_cv',      { node: workletNode, input: 0, param: params.get('lfoAmount')! }],
        ['drift_cv',    { node: workletNode, input: 0, param: params.get('driftAmount')! }],
        ['pan_cv',      { node: workletNode, input: 0, param: params.get('pan')! }],
        ['duck_cv',     { node: workletNode, input: 0, param: params.get('duckAmount')! }],
      ]),
      outputs: new Map([
        ['outL', { node: workletNode, output: 0 }],
        ['outR', { node: workletNode, output: 1 }],
      ]),
      setParam(paramId, value) {
        params.get(paramId)?.setValueAtTime(value, ctx.currentTime);
      },
      readParam(paramId) {
        return params.get(paramId)?.value;
      },
      dispose() {
        if (syncTimer !== null) clearInterval(syncTimer);
        try { silenceL.stop(); } catch { /* */ }
        try { silenceR.stop(); } catch { /* */ }
        try { silenceClk.stop(); } catch { /* */ }
        silenceL.disconnect();
        silenceR.disconnect();
        silenceClk.disconnect();
        workletNode.disconnect();
      },
    };
  },
};
