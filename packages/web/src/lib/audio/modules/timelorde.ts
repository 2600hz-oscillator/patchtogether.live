// packages/web/src/lib/audio/modules/timelorde.ts
//
// TIMELORDE — central time source per rackspace. TS AudioWorklet for
// sample-accurate phase counters. See packages/dsp/src/timelorde.ts.
//
// Singleton: maxInstances = 1. The whole point is "one canonical clock per
// patch"; multiple TIMELORDEs would invite ambiguity over which is the
// master. TIMELORDE emits a fanout of gate outputs at standard musical
// divisions of the master BPM (1x = quarter; 2x/4x/8x = subdivisions;
// 1/2..1/64 = multiples of the bar) so any module that needs clocking
// can patch the appropriate division directly without a clock-divider
// helper in between.
//
// Inputs:
//   clock (gate):    external clock-in; when patched, the master BPM is locked to its measured period.
//   start_in (gate): rising edge STARTS the clock (running ← 1). Internal phase resumes from
//                    wherever the last stop halted it — musical position is preserved (DAW
//                    transport semantics).
//                    Wire MIDICLOCK.midistart → TIMELORDE.start_in to slave transport to a hardware MIDI device.
//   stop_in (gate):  rising edge HALTS the clock (running ← 0). Phase accumulator + sample
//                    counter + pending pulses all freeze; outputs go low. This is DIFFERENT from
//                    the card's MUTE button (which silences outputs but keeps the clock turning
//                    for LIVECODE). A patched stop is a real transport stop.
//                    Wire MIDICLOCK.midistop → TIMELORDE.stop_in for the matching stop side.
//
// Outputs:
//   1x (gate): quarter-note pulse at the master BPM.
//   2x / 4x / 8x (gate): faster subdivisions of the quarter (eighth / sixteenth / 32nd).
//   1/2 / 1/3 / 1/4 / 1/8 / 1/12 / 1/16 / 1/32 / 1/64 (gate): multiples of the quarter (half-note .. 64-bar).
//   swing (gate): same as 2x but offset by the swingAmount; use as a swung 8th-note clock.
//
// Params:
//   bpm (log 10..300, default 120): master tempo.
//   swingAmount (linear 0..90°, default 0): swing offset applied to the `swing` output.
//   swingSource (discrete 0..10, default 0): which division feeds the swing tap.
//   muteOutputs (discrete 0..1, default 0): 1 = silence every gate output but the internal
//                clock keeps running for LIVECODE / tick subscribers. Bound to the card's
//                MUTE button.
//   running     (discrete 0..1, default 1): 1 = clock advances, 0 = clock HALTED (phase
//                accumulator + sample-counter freeze). Bound to start_in / stop_in transport
//                gates. Distinct from muteOutputs: a stopped clock has no ticks to mute.

import type { AudioDomainNodeHandle } from '$lib/audio/engine';
import type { AudioModuleDef } from '$lib/audio/module-registry';
import { patch as livePatch } from '$lib/graph/store';
import workletUrl from '@patchtogether.live/dsp/dist/timelorde.js?url';
import { getSchedulerClock } from '$lib/audio/scheduler-clock';
import { createRisingEdgeDetector } from './transport-helpers';

const loadedContexts = new WeakSet<BaseAudioContext>();

// ---------------- Pure transport-event helper ----------------
//
// Given how many start_in / stop_in rising edges fired in the most recent
// poll window and the CURRENT running value, decide the next running
// value. This is a real transport halt/resume — NOT the card's mute. A
// stop_in rising edge sets running ← 0 (clock phase freezes); start_in
// sets running ← 1 (resumes from the frozen position). Pure + sync —
// runs in vitest without an AudioContext.
//
// Ordering: if both edges fired inside the same poll window (unusual
// but possible at high tick periods), stop wins — matches the
// conservative "if a stop happened, honor it" interpretation. The
// pulse-per-call shape means a redundant start while already running
// is a no-op (idempotent), and likewise a stop while already halted.
export function transportEventsToRunState(args: {
  startEdges: number;
  stopEdges: number;
  prevRunning: 0 | 1;
}): 0 | 1 {
  if (args.stopEdges > 0) return 0;
  if (args.startEdges > 0) return 1;
  return args.prevRunning;
}

export const timelordeDef: AudioModuleDef = {
  type: 'timelorde',
  domain: 'audio',
  label: 'TIMELORDE',
  category: 'modulation',
  schemaVersion: 2,
  maxInstances: 1,
  // TIMELORDE is the rack's system clock — every sequencer + LIVECODE's
  // clocked() function ride on it. Can't be deleted; if a rack is opened
  // without one, the auto-spawn path (see Canvas.svelte init effect) drops
  // one in at a fixed position so the rack is always musically coherent.
  undeletable: true,

  inputs: [
    // External clock — when patched, snaps 1x to incoming rising edges and
    // measures period for multiplier prediction. Disconnect → falls back
    // to internal BPM after ~2 master periods.
    { id: 'clock', type: 'gate' },
    // start_in / stop_in: transport gates that mirror the card's
    // ON / MUTE button. Designed for MIDICLOCK.midistart →
    // TIMELORDE.start_in + MIDICLOCK.midistop → TIMELORDE.stop_in so a
    // hardware MIDI device can drive the rack's transport. Rising-edge
    // detection runs on a scheduler-clock poll (same TICK_MS the rest
    // of the sequencer transport uses); idempotent — a start while
    // already running is a no-op, same for stop while already muted.
    { id: 'start_in', type: 'gate' },
    { id: 'stop_in',  type: 'gate' },
  ],
  outputs: [
    // Order MUST match dsp/timelorde.ts OUT_* indices.
    { id: '1x',    type: 'gate' },
    { id: '8x',    type: 'gate' },
    { id: '4x',    type: 'gate' },
    { id: '2x',    type: 'gate' },
    { id: '1/2',   type: 'gate' },
    { id: '1/3',   type: 'gate' },
    { id: '1/4',   type: 'gate' },
    { id: '1/8',   type: 'gate' },
    { id: '1/12',  type: 'gate' },
    { id: '1/16',  type: 'gate' },
    { id: '1/32',  type: 'gate' },
    { id: '1/64',  type: 'gate' },
    { id: 'swing', type: 'gate' },
  ],
  params: [
    { id: 'bpm',          label: 'BPM',   defaultValue: 120, min: 10, max: 300, curve: 'log',      units: 'bpm' },
    { id: 'swingAmount',  label: 'Swing', defaultValue: 0,   min: 0,  max: 90,  curve: 'linear',   units: 'deg' },
    { id: 'swingSource',  label: 'Src',   defaultValue: 0,   min: 0,  max: 10,  curve: 'discrete' },
    // muteOutputs (v2): 0 (default) = running + gates fire normally;
    // 1 = gates muted but the INTERNAL clock keeps generating so
    // LIVECODE's clocked() callbacks + any other consumers stay
    // alive. v1's `isPlaying` was inverted in meaning AND stopped
    // the internal clock entirely; LIVECODE needs the clock to
    // outlive the gates, so v2 splits "is the clock running" (always
    // true) from "are gates audible" (the new muteOutputs param).
    // Patches saved on v1 carry `params.isPlaying`; the factory
    // converts inline (see readMuteOutputs() below) so old racks
    // start MUTED iff the user had explicitly stopped them.
    { id: 'muteOutputs',  label: 'Mute',  defaultValue: 0,   min: 0,  max: 1,   curve: 'discrete' },
    // running (v3): driven exclusively by start_in / stop_in transport
    // gate inputs. Default 1 = clock advances. When 0 the worklet
    // freezes phase + sample-count + pending pulses; on resume the
    // counters pick up from the halted position (musical position
    // preserved). The card has no button for this — only the external
    // gates can flip it. Patches save it so a stopped rack stays
    // stopped on reload.
    { id: 'running',      label: 'Run',   defaultValue: 1,   min: 0,  max: 1,   curve: 'discrete' },
  ],

  // Module-grouping Phase 4 — surface every knob (BPM / Swing / Src) so a
  // containing GROUP! can opt to expose any subset on its bar. The play
  // toggle is intentionally NOT exposable here because TIMELORDE's local
  // play UI hides itself whenever an external clock is patched; the same
  // gating logic would have to be ported into the group bar to avoid
  // surprises. v1 covers knobs only; the button can be added later.
  exposableControls: [
    { id: 'bpm',         label: 'BPM',   kind: 'knob', paramId: 'bpm' },
    { id: 'swingAmount', label: 'Swing', kind: 'knob', paramId: 'swingAmount' },
    { id: 'swingSource', label: 'Src',   kind: 'knob', paramId: 'swingSource' },
  ],

  async factory(ctx, node): Promise<AudioDomainNodeHandle> {
    if (!loadedContexts.has(ctx)) {
      await ctx.audioWorklet.addModule(workletUrl);
      loadedContexts.add(ctx);
    }

    const workletNode = new AudioWorkletNode(ctx, 'timelorde', {
      numberOfInputs: 1,
      numberOfOutputs: 13,
      outputChannelCount: [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1],
    });

    // The worklet's clock input always exists; tests + the engine plug a
    // ConstantSource of silence in so the node sees an active inbound to
    // remain in the graph even when no cable is patched.
    const silence = ctx.createConstantSource();
    silence.offset.value = 0;
    silence.start();
    silence.connect(workletNode, 0, 0);

    const params = workletNode.parameters as unknown as Map<string, AudioParam>;
    for (const def of timelordeDef.params) {
      const v = (node.params ?? {})[def.id] ?? def.defaultValue;
      params.get(def.id)?.setValueAtTime(v, ctx.currentTime);
    }
    const bpmParam = params.get('bpm');
    const swAmt = params.get('swingAmount');
    const swSrc = params.get('swingSource');
    const muteOutputsParam = params.get('muteOutputs');
    const runningParam = params.get('running');
    const hasExt = params.get('hasExternalClock');

    // v1 → v2 inline migration: existing patches saved `isPlaying`
    // (1=playing/0=stopped). v2 renamed to `muteOutputs` (inverted
    // semantic). If the loaded params carry the legacy field, copy it
    // forward at spawn time so the user's intent survives.
    const legacyIsPlaying = (node.params ?? {})['isPlaying'];
    if (
      typeof legacyIsPlaying === 'number' &&
      (node.params?.['muteOutputs'] === undefined) &&
      muteOutputsParam
    ) {
      const muted = legacyIsPlaying >= 0.5 ? 0 : 1;
      muteOutputsParam.setValueAtTime(muted, ctx.currentTime);
    }

    const nodeId = node.id;

    // hasExternalClock is reflected from the live patch every ~250 ms so the
    // worklet knows when to honor isPlaying vs force always-on.
    let timer: ReturnType<typeof setInterval> | null = null;
    function syncExternalFlag() {
      let hasEdge = false;
      for (const edge of Object.values(livePatch.edges)) {
        if (!edge) continue;
        if (edge.target.nodeId === nodeId && edge.target.portId === 'clock') {
          hasEdge = true;
          break;
        }
      }
      if (hasExt) hasExt.setValueAtTime(hasEdge ? 1 : 0, ctx.currentTime);
    }
    syncExternalFlag();
    timer = setInterval(syncExternalFlag, 250);

    // The worklet posts { type: 'measuredBpm', bpm } whenever the locked
    // external tempo drifts (>0.1 BPM) and posts bpm:0 on dropout. We
    // cache the latest value here and surface it via read('measuredBpm')
    // so TimelordeCard can show the tempo TIMELORDE is actually locked
    // to, not the stale internal knob.
    let measuredBpm = 0;
    workletNode.port.onmessage = (e: MessageEvent) => {
      const m = e.data as { type?: string; bpm?: number } | undefined;
      if (m && m.type === 'measuredBpm' && typeof m.bpm === 'number') {
        measuredBpm = m.bpm;
      }
    };

    // -------- start_in / stop_in: transport gate inputs --------
    //
    // Each input is a Gain → Analyser tap (same shape transport-cv uses
    // for play_cv / reset_cv on sequencer-style modules). A silence
    // ConstantSource keeps the node graph-alive even when no cable is
    // patched, so the analyser doesn't see ghost edges from a torn-down
    // connection. A scheduler-clock subscription drains them every tick
    // and routes rising-edge counts through transportEventsToRunState(),
    // mirroring the result back to BOTH the engine-side `running`
    // AudioParam (so the worklet sees the change immediately) AND the
    // patch store (so any UI + remote rack-mates pick up the new state
    // via Y.Doc sync). Note: these gates HALT the clock, distinct from
    // the card's MUTE button which only silences output gates.
    const startGain = ctx.createGain();
    const startAna = ctx.createAnalyser();
    startAna.fftSize = 2048;
    startAna.smoothingTimeConstant = 0;
    startGain.connect(startAna);
    const startSilence = ctx.createConstantSource();
    startSilence.offset.value = 0;
    startSilence.start();
    startSilence.connect(startGain);
    const startBuf = new Float32Array(2048);
    const startDet = createRisingEdgeDetector(0.5);

    const stopGain = ctx.createGain();
    const stopAna = ctx.createAnalyser();
    stopAna.fftSize = 2048;
    stopAna.smoothingTimeConstant = 0;
    stopGain.connect(stopAna);
    const stopSilence = ctx.createConstantSource();
    stopSilence.offset.value = 0;
    stopSilence.start();
    stopSilence.connect(stopGain);
    const stopBuf = new Float32Array(2048);
    const stopDet = createRisingEdgeDetector(0.5);

    let lastTransportPollTime = ctx.currentTime;
    function pollTransportGates(): void {
      const nowAt = ctx.currentTime;
      const elapsed = Math.max(0, nowAt - lastTransportPollTime);
      lastTransportPollTime = nowAt;
      startAna.getFloatTimeDomainData(startBuf);
      stopAna.getFloatTimeDomainData(stopBuf);
      const newSamples = Math.min(
        startBuf.length,
        Math.max(1, Math.ceil(elapsed * ctx.sampleRate)),
      );
      const start = startBuf.length - newSamples;
      const startEdges = startDet.scan(startBuf, start, startBuf.length);
      const stopEdges  = stopDet.scan(stopBuf,  start, stopBuf.length);
      if (startEdges === 0 && stopEdges === 0) return;

      const live = livePatch.nodes[nodeId];
      // Default running=1 if unset (matches the param's defaultValue).
      // running is NOT muteOutputs — it actually halts the worklet's
      // phase accumulator. muteOutputs stays untouched here.
      const prevRaw = live?.params?.running;
      const prevRunning: 0 | 1 =
        typeof prevRaw === 'number' ? (prevRaw >= 0.5 ? 1 : 0) : 1;
      const nextRunning = transportEventsToRunState({
        startEdges,
        stopEdges,
        prevRunning,
      });
      if (nextRunning === prevRunning) return;
      // Write through both layers: AudioParam so the worklet sees it
      // on the next process() block (phase accumulator freezes /
      // resumes); livePatch.params so any UI + remote rack-mates pick
      // up the new state via Y.Doc sync.
      runningParam?.setValueAtTime(nextRunning, ctx.currentTime);
      if (live?.params) live.params.running = nextRunning;
    }
    const transportUnsub = getSchedulerClock().subscribe(pollTransportGates);

    return {
      domain: 'audio',
      inputs: new Map<string, { node: AudioNode; input: number }>([
        ['clock',    { node: workletNode, input: 0 }],
        ['start_in', { node: startGain,   input: 0 }],
        ['stop_in',  { node: stopGain,    input: 0 }],
      ]),
      outputs: new Map([
        ['1x',    { node: workletNode, output: 0 }],
        ['8x',    { node: workletNode, output: 1 }],
        ['4x',    { node: workletNode, output: 2 }],
        ['2x',    { node: workletNode, output: 3 }],
        ['1/2',   { node: workletNode, output: 4 }],
        ['1/3',   { node: workletNode, output: 5 }],
        ['1/4',   { node: workletNode, output: 6 }],
        ['1/8',   { node: workletNode, output: 7 }],
        ['1/12',  { node: workletNode, output: 8 }],
        ['1/16',  { node: workletNode, output: 9 }],
        ['1/32',  { node: workletNode, output: 10 }],
        ['1/64',  { node: workletNode, output: 11 }],
        ['swing', { node: workletNode, output: 12 }],
      ]),
      setParam(paramId, value) {
        params.get(paramId)?.setValueAtTime(value, ctx.currentTime);
      },
      readParam(paramId) {
        return params.get(paramId)?.value;
      },
      read(key) {
        if (key === 'hasExternalClock') {
          return hasExt?.value ?? 0;
        }
        if (key === 'measuredBpm') {
          return measuredBpm;
        }
        if (key === 'running') {
          // Reflects the transport-gate state. start_in/stop_in flip
          // this; muteOutputs is independent (the card's mute doesn't
          // halt the clock).
          const v = runningParam?.value ?? 1;
          return v >= 0.5 ? 1 : 0;
        }
        return undefined;
      },
      dispose() {
        if (timer !== null) clearInterval(timer);
        try { transportUnsub(); } catch { /* */ }
        try { silence.stop(); } catch { /* */ }
        try { startSilence.stop(); } catch { /* */ }
        try { stopSilence.stop(); } catch { /* */ }
        silence.disconnect();
        startSilence.disconnect();
        stopSilence.disconnect();
        startGain.disconnect();
        stopGain.disconnect();
        startAna.disconnect();
        stopAna.disconnect();
        workletNode.disconnect();
      },
    };
  },
};
