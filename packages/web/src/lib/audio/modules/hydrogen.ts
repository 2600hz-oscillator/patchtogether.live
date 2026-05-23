// packages/web/src/lib/audio/modules/hydrogen.ts
//
// HYDROGEN — TR-808 drum machine module. First pass of a larger "port
// Hydrogen drum machine into the rack" effort: bundles the stock
// TR808EmulationKit from the Hydrogen project (GPL-2.0+, ArtemioLabs)
// and ships a 16-instrument × 16-step pattern sequencer + sample
// player. Drumkit picker, song-mode, multi-layer velocity samples, and
// the .h2drumkit loader are deferred to follow-up modules (see the
// design notes in the PR discussion).
//
// Architecture (pure JS Web Audio — no Faust, no AudioWorklet):
//
//   per-instrument bus:    instrumentGain[i] → instrumentPan[i] ─┐
//                                                                 ↓
//   per-trigger voice:     BufferSource → voiceGain (vel × env) → instrumentGain[i]
//                                                                 ↑
//   master:                       … 16 buses → masterGain[L|R] → out_l/out_r
//
// Pattern + transport: the shared scheduler-clock (Worker tick, jank-
// immune) ticks every SCHEDULER_TICK_MS, and the factory schedules a
// 200 ms lookahead of upcoming step-fire events. Same lookahead
// architecture as DRUMSEQZ / RIOTGIRLS — keeps audio-thread events
// sample-accurate under main-thread jank.
//
// Transport contract (v1):
//   * isPlaying param drives play/stop (toggle exposed to GROUP! bar).
//   * Optional external `clock_in` gate input — when patched, each
//     rising edge advances one step (DRUMSEQZ-parity).
//   * Optional `reset_in` gate input — rising edge resets the playhead.
//
// Deferred (v2+):
//   - Per-step velocity (v1 is binary on/off, velocity defaults to 1.0)
//   - Pattern pages / song mode
//   - Per-step micro-shift (humanize)
//   - Drumkit picker (load other Hydrogen kits)
//   - .h2drumkit asset loader
//   - Multi-layer velocity samples (TR-808 is single-layer per inst)
//   - LADSPA / per-channel FX bus (use SHIMMERSHINE / CHARLOTTES ECHOS
//     downstream of the stereo out instead)

import type { AudioDomainNodeHandle } from '$lib/audio/engine';
import type { AudioModuleDef } from '$lib/audio/module-registry';
import { patch as livePatch } from '$lib/graph/store';
import { getSchedulerClock, SCHEDULER_TICK_MS } from '$lib/audio/scheduler-clock';
import {
  isInputPortConnected,
  shouldSequencerRun,
  coerceSlotKey,
  coerceSlots,
} from './transport-helpers';
import {
  createTransportCv,
  TRANSPORT_CV_PORT_DEFS,
  pickQueuedSlotFromEvents,
} from './transport-cv';
import { createPlayheadTracker } from './playhead-tracker';
import {
  TR808_INSTRUMENTS,
  TR808_INSTRUMENT_COUNT,
  loadTR808Sample,
  preloadTR808Kit,
} from './hydrogen-tr808-kit-data';

export const STEP_COUNT = 16;

export interface HydrogenCell {
  on: boolean;
}

export type HydrogenTrack = HydrogenCell[]; // length STEP_COUNT

export interface HydrogenData {
  /** Length TR808_INSTRUMENT_COUNT, each track length STEP_COUNT. */
  tracks: HydrogenTrack[];
}

function defaultCell(): HydrogenCell {
  return { on: false };
}

export function defaultTrack(): HydrogenTrack {
  return Array.from({ length: STEP_COUNT }, defaultCell);
}

export function defaultTracks(): HydrogenTrack[] {
  return Array.from({ length: TR808_INSTRUMENT_COUNT }, defaultTrack);
}

export function coerceCell(raw: unknown): HydrogenCell {
  if (!raw || typeof raw !== 'object') return defaultCell();
  return { on: !!(raw as { on?: unknown }).on };
}

export function coerceTracks(raw: unknown): HydrogenTrack[] {
  if (!Array.isArray(raw)) return defaultTracks();
  const out: HydrogenTrack[] = [];
  for (let t = 0; t < TR808_INSTRUMENT_COUNT; t++) {
    const tr = raw[t];
    if (Array.isArray(tr)) {
      const cells: HydrogenTrack = [];
      for (let i = 0; i < STEP_COUNT; i++) cells.push(coerceCell(tr[i]));
      out.push(cells);
    } else {
      out.push(defaultTrack());
    }
  }
  return out;
}

/** Per-instrument param ids — derived once so the def + factory + card
 *  all agree on the shape. Pattern: vol{i}, pan{i}, A{i}, D{i}, S{i},
 *  R{i}, mute{i}, solo{i} for i ∈ [0..15]. */
function instrumentParamIds(): string[] {
  const ids: string[] = [];
  for (let i = 0; i < TR808_INSTRUMENT_COUNT; i++) {
    ids.push(`vol${i}`, `pan${i}`, `A${i}`, `D${i}`, `S${i}`, `R${i}`, `mute${i}`, `solo${i}`);
  }
  return ids;
}

/** Build the full input port list. Includes:
 *
 *    * clock_in + reset_in       — pre-existing gate inputs
 *    * play_cv + queue1..4_cv    — shared transport CV (sequencer-style
 *                                  preset-slot switching). reset_cv from
 *                                  TRANSPORT_CV_PORT_DEFS is folded into
 *                                  reset_in semantically (both reset the
 *                                  playhead on rising edge); we keep
 *                                  reset_in as the primary port name for
 *                                  backwards compatibility and add
 *                                  reset_cv as an alias.
 *    * trig{i} per instrument    — pre-existing per-voice direct trigger
 *
 *  The manifest-builder's literal-array extractor can't read spreads, so
 *  we hide the full list behind this builder + let the synthesizer in
 *  module-manifest.ts produce the equivalent shape (same RIOTGIRLS
 *  pattern). */
function buildHydrogenInputs() {
  const inputs: Array<{ id: string; type: 'gate' }> = [
    { id: 'clock_in', type: 'gate' },
    { id: 'reset_in', type: 'gate' },
  ];
  // Shared transport ports — same shape as SCORE / SEQUENCER / DRUMSEQZ /
  // POLYSEQZ. Play toggles isPlaying on rising edge; queue{N} stages
  // slot N to load at the next pattern-end; reset_cv jumps the playhead
  // back to step 0 (alias of reset_in).
  for (const p of TRANSPORT_CV_PORT_DEFS) {
    inputs.push({ id: p.id, type: 'gate' });
  }
  for (const inst of TR808_INSTRUMENTS) {
    inputs.push({ id: `trig${inst.id}`, type: 'gate' });
  }
  return inputs;
}

export const hydrogenDef: AudioModuleDef = {
  type: 'hydrogen',
  label: 'HYDROGEN',
  domain: 'audio',
  category: 'sources',
  schemaVersion: 1,
  inputs: buildHydrogenInputs(),
  outputs: [
    { id: 'out_l', type: 'audio' },
    { id: 'out_r', type: 'audio' },
  ],
  params: [
    { id: 'bpm',       label: 'BPM',  defaultValue: 120, min: 30,  max: 300, curve: 'linear' },
    { id: 'swing',     label: 'Sw',   defaultValue: 0,   min: 0,   max: 0.75, curve: 'linear' },
    { id: 'gain',      label: 'Gain', defaultValue: 1,   min: 0,   max: 2,   curve: 'linear' },
    { id: 'isPlaying', label: 'Play', defaultValue: 0,   min: 0,   max: 1,   curve: 'discrete' },
    // Per-instrument params (vol/pan/pitch/cutoff/Q/A/D/S/R/mute/solo
    // × 16). Defaults come from the kit's drumkit.xml — see
    // hydrogen-tr808-kit-data.ts. pitch/cutoff/Q match Hydrogen's
    // "Instrument Properties" panel — semitones, lowpass cutoff, Q.
    ...TR808_INSTRUMENTS.flatMap((inst) => [
      { id: `vol${inst.id}`,    label: `${inst.label}V`,  defaultValue: inst.defaultGain, min: 0,    max: 2,     curve: 'linear' as const },
      { id: `pan${inst.id}`,    label: `${inst.label}P`,  defaultValue: inst.defaultPan,  min: -1,   max: 1,     curve: 'linear' as const },
      { id: `pitch${inst.id}`,  label: `${inst.label}Pi`, defaultValue: 0,                min: -24,  max: 24,    curve: 'linear' as const, units: 'st' as const },
      { id: `cutoff${inst.id}`, label: `${inst.label}Cf`, defaultValue: 20000,            min: 20,   max: 20000, curve: 'log'    as const, units: 'Hz' as const },
      { id: `q${inst.id}`,      label: `${inst.label}Q`,  defaultValue: 0.7,              min: 0.1,  max: 20,    curve: 'log'    as const },
      { id: `A${inst.id}`,      label: `${inst.label}A`,  defaultValue: inst.defaultA,    min: 0,    max: 2,     curve: 'log'    as const },
      { id: `D${inst.id}`,      label: `${inst.label}D`,  defaultValue: inst.defaultD,    min: 0,    max: 2,     curve: 'log'    as const },
      { id: `S${inst.id}`,      label: `${inst.label}S`,  defaultValue: inst.defaultS,    min: 0,    max: 1,     curve: 'linear' as const },
      { id: `R${inst.id}`,      label: `${inst.label}R`,  defaultValue: inst.defaultR,    min: 0.01, max: 5,     curve: 'log'    as const },
      { id: `mute${inst.id}`,   label: `${inst.label}M`,  defaultValue: 0,                min: 0,    max: 1,     curve: 'discrete' as const },
      { id: `solo${inst.id}`,   label: `${inst.label}S`,  defaultValue: 0,                min: 0,    max: 1,     curve: 'discrete' as const },
    ]),
  ],

  exposableControls: [
    { id: 'playStop', label: 'Play', kind: 'button', paramId: 'isPlaying' },
  ],
  exposesSequence: true,

  async factory(ctx, node): Promise<AudioDomainNodeHandle> {
    const nodeId = node.id;

    // ---------- Output bus + per-instrument mix ----------
    const masterGain = ctx.createGain();
    masterGain.gain.value = node.params?.gain as number ?? 1;
    const splitter = ctx.createChannelSplitter(2);
    masterGain.connect(splitter);

    // Per-instrument: gain (with mute/solo applied) → stereo panner →
    // master. The voice path (one BufferSource per trigger) connects to
    // instrumentGain, so changing vol/pan/mute mid-play affects ALL
    // future + currently-sustained samples for that instrument.
    const instrumentGain: GainNode[] = [];
    const instrumentPan: StereoPannerNode[] = [];
    for (let i = 0; i < TR808_INSTRUMENT_COUNT; i++) {
      const g = ctx.createGain();
      g.gain.value = node.params?.[`vol${i}`] as number ?? TR808_INSTRUMENTS[i]!.defaultGain;
      const p = ctx.createStereoPanner();
      p.pan.value = node.params?.[`pan${i}`] as number ?? TR808_INSTRUMENTS[i]!.defaultPan;
      g.connect(p);
      p.connect(masterGain);
      instrumentGain.push(g);
      instrumentPan.push(p);
    }

    // Pre-decode every sample. The factory function is async — callers
    // await it (PatchEngine.addNode does), so the first user gesture that
    // triggers a step finds the buffers already in the cache.
    const samples: Array<AudioBuffer | null> = new Array(TR808_INSTRUMENT_COUNT).fill(null);
    try {
      await preloadTR808Kit(ctx);
      for (let i = 0; i < TR808_INSTRUMENT_COUNT; i++) {
        samples[i] = await loadTR808Sample(ctx, TR808_INSTRUMENTS[i]!.sampleUrl);
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn('[hydrogen] sample preload failed; voices will be silent until network recovers', err);
    }

    // ---------- Voice scheduling + mute-group choke ----------
    //
    // Each fired voice gets a BufferSource + GainNode (amp env). We
    // keep a per-mute-group set of "currently-sounding" voices so a
    // new trigger in the same group can choke its predecessors (the
    // closed-hat → open-hat case). Group 0 == "no group" and never
    // chokes. Voice records self-cleanup on the BufferSource's `ended`
    // event so the set stays bounded.

    interface ActiveVoice {
      source: AudioBufferSourceNode;
      env: GainNode;
      muteGroup: number;
    }
    const voicesByMuteGroup = new Map<number, Set<ActiveVoice>>();

    function chokeGroup(group: number, atTime: number) {
      if (group <= 0) return;
      const set = voicesByMuteGroup.get(group);
      if (!set) return;
      const FAST_RELEASE = 0.005;
      for (const v of set) {
        try {
          v.env.gain.cancelScheduledValues(atTime);
          v.env.gain.setValueAtTime(v.env.gain.value, atTime);
          v.env.gain.linearRampToValueAtTime(0, atTime + FAST_RELEASE);
          v.source.stop(atTime + FAST_RELEASE + 0.01);
        } catch { /* already stopped */ }
      }
      set.clear();
    }

    function fireInstrument(idx: number, atTime: number, velocity = 1) {
      const inst = TR808_INSTRUMENTS[idx];
      if (!inst) return;
      const buf = samples[idx];
      if (!buf) return;

      // Mute / solo gating — if any instrument is soloed, only soloed
      // voices fire; otherwise mute keeps the voice silent.
      if (readParam(`mute${idx}`, 0) >= 0.5) return;
      const anySolo = TR808_INSTRUMENTS.some((j) => readParam(`solo${j.id}`, 0) >= 0.5);
      if (anySolo && readParam(`solo${idx}`, 0) < 0.5) return;

      chokeGroup(inst.muteGroup, atTime);

      const source = ctx.createBufferSource();
      source.buffer = buf;
      // Per-voice pitch — semitone offset from the recorded sample
      // pitch, via playbackRate. Same semantics as Hydrogen's
      // Instrument Properties "Pitch" knob: positive = up, negative =
      // down. detune is not used (would compound with playbackRate);
      // the semitone math here is canonical.
      const pitchSt = readParam(`pitch${idx}`, 0);
      source.playbackRate.value = Math.pow(2, pitchSt / 12);

      // Per-voice lowpass filter (matches Hydrogen's per-instrument
      // filter section). Default cutoff 20 kHz + Q 0.7 → effectively
      // bypass; the user dials the cutoff down or Q up to shape the
      // voice. Fixed-type lowpass (not switchable) for now — Hydrogen's
      // hardware also exposes a single LPF on the instrument-properties
      // panel.
      const filter = ctx.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.value = readParam(`cutoff${idx}`, 20000);
      filter.Q.value = readParam(`q${idx}`, 0.7);

      const env = ctx.createGain();
      const A = readParam(`A${idx}`, inst.defaultA);
      const D = readParam(`D${idx}`, inst.defaultD);
      const S = readParam(`S${idx}`, inst.defaultS);
      const R = readParam(`R${idx}`, inst.defaultR);

      // A=D=0 + S=1 (TR-808 default) collapses to "vel for the whole
      // sample duration, R-second release at the end" — i.e. plays the
      // sample dry. Non-zero A/D/S/R lets the user shape the natural
      // tail without re-recording the sample.
      const peak = velocity;
      const sustain = S * peak;
      env.gain.setValueAtTime(0, atTime);
      env.gain.linearRampToValueAtTime(peak, atTime + Math.max(0.001, A));
      env.gain.linearRampToValueAtTime(sustain, atTime + Math.max(0.001, A) + Math.max(0.001, D));

      source.connect(filter);
      filter.connect(env);
      env.connect(instrumentGain[idx]!);
      source.start(atTime);

      // Schedule the release ramp to start when the sample naturally
      // ends; if R extends past the buffer's duration we just let the
      // BufferSource stop on its own (no harm — env keeps ramping but
      // there's no signal to envelope).
      const dur = buf.duration;
      const releaseStart = atTime + dur;
      try {
        env.gain.setValueAtTime(sustain, releaseStart);
        env.gain.linearRampToValueAtTime(0, releaseStart + Math.max(0.005, R));
      } catch { /* envelope past end-of-sample is harmless */ }

      const voice: ActiveVoice = { source, env, muteGroup: inst.muteGroup };
      if (inst.muteGroup > 0) {
        let set = voicesByMuteGroup.get(inst.muteGroup);
        if (!set) {
          set = new Set();
          voicesByMuteGroup.set(inst.muteGroup, set);
        }
        set.add(voice);
      }
      source.onended = () => {
        if (inst.muteGroup > 0) voicesByMuteGroup.get(inst.muteGroup)?.delete(voice);
        try { source.disconnect(); env.disconnect(); } catch { /* already disconnected */ }
      };
    }

    // ---------- Per-instrument trig{i} input handling ----------
    //
    // Each `trig{i}` cable lets the rack drive an instrument directly
    // (DRUMSEQZ → HYDROGEN, or a sequencer's clock_out hand-wired into
    // one drum). We expose a sink GainNode + AnalyserNode per input so
    // we can detect rising edges on the audio-rate trig signal.

    const trigGains: GainNode[] = [];
    const trigAnalysers: AnalyserNode[] = [];
    const trigAnalyserBuf = new Float32Array(2048);
    const trigSilences: ConstantSourceNode[] = [];
    const lastTrigSample: number[] = new Array(TR808_INSTRUMENT_COUNT).fill(0);
    for (let i = 0; i < TR808_INSTRUMENT_COUNT; i++) {
      const g = ctx.createGain();
      const a = ctx.createAnalyser();
      a.fftSize = 2048;
      a.smoothingTimeConstant = 0;
      g.connect(a);
      const silence = ctx.createConstantSource();
      silence.offset.value = 0;
      silence.start();
      silence.connect(g);
      trigGains.push(g);
      trigAnalysers.push(a);
      trigSilences.push(silence);
    }

    // ---------- clock_in / reset_in detection ----------
    const clockInGain = ctx.createGain();
    const clockInAnalyser = ctx.createAnalyser();
    clockInAnalyser.fftSize = 2048;
    clockInGain.connect(clockInAnalyser);
    const clockInBuffer = new Float32Array(clockInAnalyser.fftSize);
    const clockInSilence = ctx.createConstantSource();
    clockInSilence.offset.value = 0;
    clockInSilence.start();
    clockInSilence.connect(clockInGain);

    const resetInGain = ctx.createGain();
    const resetInAnalyser = ctx.createAnalyser();
    resetInAnalyser.fftSize = 2048;
    resetInGain.connect(resetInAnalyser);
    const resetInBuffer = new Float32Array(resetInAnalyser.fftSize);
    const resetInSilence = ctx.createConstantSource();
    resetInSilence.offset.value = 0;
    resetInSilence.start();
    resetInSilence.connect(resetInGain);

    let lastClockSample = 0;
    let lastResetSample = 0;
    const CLOCK_THRESHOLD = 0.5;

    // ---------- Shared transport CV inputs (play/queue/reset). ----------
    // Same machinery the other sequencers (SCORE / DRUMSEQZ / POLYSEQZ)
    // use. transportCv.drain() returns per-port rising-edge counts each
    // tick; we toggle isPlaying / reset stepIndex / stage queuedSlot
    // accordingly.
    const transportCv = createTransportCv(ctx);
    let lastTransportPollTime = ctx.currentTime;

    // ---------- Step scheduler ----------
    let stepIndex = 0;
    let nextStepTime = ctx.currentTime + 0.05;
    let prevPlaying = false;
    let alive = true;
    let unsubscribeTick: (() => void) | null = null;
    const LOOKAHEAD_S = 0.2;
    const playhead = createPlayheadTracker();

    function readParam(id: string, fallback: number): number {
      const live = livePatch.nodes[nodeId];
      const v = live?.params?.[id];
      return typeof v === 'number' ? v : fallback;
    }

    function readTracks(): HydrogenTrack[] {
      const live = livePatch.nodes[nodeId];
      const raw = (live?.data as Record<string, unknown> | undefined)?.tracks;
      return coerceTracks(raw);
    }

    function isClockInConnected(): boolean {
      return isInputPortConnected(Object.values(livePatch.edges), nodeId, 'clock_in');
    }

    function emitStep(idx: number, atTime: number) {
      const tracks = readTracks();
      playhead.schedule(idx, atTime);
      for (let i = 0; i < TR808_INSTRUMENT_COUNT; i++) {
        const cell = tracks[i]?.[idx] ?? defaultCell();
        if (cell.on) fireInstrument(i, atTime);
      }
    }

    function pollTrigInputs(): void {
      // Cheap edge detect on every trig{i} input — rising-edge fires the
      // instrument. Audio-rate trig (e.g. driven from a DRUMSEQZ gate)
      // arrives via the AnalyserNode tap; we peak across the recent
      // window for jitter immunity.
      for (let i = 0; i < TR808_INSTRUMENT_COUNT; i++) {
        trigAnalysers[i]!.getFloatTimeDomainData(trigAnalyserBuf);
        let peak = 0;
        for (let s = 0; s < trigAnalyserBuf.length; s++) {
          const v = trigAnalyserBuf[s]!;
          if (v > peak) peak = v;
        }
        const high = peak >= CLOCK_THRESHOLD ? 1 : 0;
        if (high && !lastTrigSample[i]) {
          fireInstrument(i, ctx.currentTime + 0.005);
        }
        lastTrigSample[i] = high;
      }
    }

    function pollResetInput(): void {
      resetInAnalyser.getFloatTimeDomainData(resetInBuffer);
      let peak = 0;
      for (let s = 0; s < resetInBuffer.length; s++) {
        const v = resetInBuffer[s]!;
        if (v > peak) peak = v;
      }
      const high = peak >= CLOCK_THRESHOLD ? 1 : 0;
      if (high && !lastResetSample) {
        stepIndex = 0;
        playhead.reset();
        nextStepTime = ctx.currentTime + 0.005;
      }
      lastResetSample = high;
    }

    function pollExternalClockEdges(): number {
      // Returns the number of rising edges seen since last poll.
      clockInAnalyser.getFloatTimeDomainData(clockInBuffer);
      let edges = 0;
      for (let s = 0; s < clockInBuffer.length; s++) {
        const v = clockInBuffer[s]!;
        const high = v >= CLOCK_THRESHOLD ? 1 : 0;
        if (high && !lastClockSample) edges++;
        lastClockSample = high;
      }
      return edges;
    }

    /** Drain the shared transport-CV inputs once per tick and dispatch
     *  rising edges. PLAY toggles isPlaying. RESET zeros the playhead.
     *  QUEUE-N stages slot N to load on the next pattern wrap. */
    function pollTransportCv(): boolean {
      const nowAt = ctx.currentTime;
      const elapsed = nowAt - lastTransportPollTime;
      lastTransportPollTime = nowAt;
      const ev = transportCv.drain(elapsed);
      const live = livePatch.nodes[nodeId];
      let isPlaying = readParam('isPlaying', 0) >= 0.5;
      if (ev.play % 2 === 1) {
        isPlaying = !isPlaying;
        if (live?.params) live.params.isPlaying = isPlaying ? 1 : 0;
      }
      if (ev.reset > 0) {
        stepIndex = 0;
        playhead.reset();
        nextStepTime = ctx.currentTime + 0.05;
      }
      const queued = pickQueuedSlotFromEvents(ev);
      if (queued !== null && live) {
        if (!live.data) live.data = {};
        (live.data as Record<string, unknown>).queuedSlot = queued;
      }
      return isPlaying;
    }

    /** Apply queued slot's snapshot to node.data + node.params.
     *
     *  HYDROGEN snapshot shape:
     *    { tracks: HydrogenTrack[],         // the pattern grid
     *      bpm, swing, gain }               // transport-level knobs
     *
     *  Per-instrument knobs (vol/pan/pitch/cutoff/Q/A/D/S/R/mute/solo)
     *  are NOT in the snapshot — users dial in their kit once + want
     *  preset slots to swap PATTERNS not the kit state. Same posture
     *  as a hardware drum machine. */
    function maybeApplyQueuedSlot(): boolean {
      const live = livePatch.nodes[nodeId];
      if (!live) return false;
      const data = live.data as Record<string, unknown> | undefined;
      const queued = coerceSlotKey(data?.queuedSlot);
      if (!queued) return false;
      const slots = coerceSlots(data?.slots);
      const snap = slots[queued];
      if (!snap) {
        if (data) data.queuedSlot = null;
        return false;
      }
      if (!live.data) live.data = {};
      const d = live.data as Record<string, unknown>;
      // Deep-clone the tracks so we don't reassign a Y-tree-resident
      // object from slots[N] into data.tracks — Yjs throws on that.
      if (Array.isArray(snap.tracks)) {
        d.tracks = (snap.tracks as Array<Array<Record<string, unknown>>>).map((tr) =>
          (Array.isArray(tr) ? tr : []).map((c) => ({ ...c })),
        );
      }
      if (live.params) {
        for (const k of ['bpm', 'swing', 'gain'] as const) {
          const v = snap[k];
          if (typeof v === 'number') live.params[k] = v;
        }
      }
      d.lastLoadedSlot = queued;
      d.queuedSlot = null;
      stepIndex = 0;
      playhead.reset();
      nextStepTime = ctx.currentTime + 0.005;
      return true;
    }

    function tick() {
      if (!alive) return;
      try {
        masterGain.gain.value = readParam('gain', 1);

        // Per-instrument mix follow.
        for (let i = 0; i < TR808_INSTRUMENT_COUNT; i++) {
          instrumentGain[i]!.gain.value = readParam(`vol${i}`, TR808_INSTRUMENTS[i]!.defaultGain);
          instrumentPan[i]!.pan.value = readParam(`pan${i}`, TR808_INSTRUMENTS[i]!.defaultPan);
        }

        const transportIsPlaying = pollTransportCv();
        pollResetInput();
        pollTrigInputs();

        const isPlaying = transportIsPlaying;
        const externalClock = isClockInConnected();
        const shouldRun = shouldSequencerRun(isPlaying, externalClock, false);

        if (shouldRun && !prevPlaying) {
          stepIndex = 0;
          playhead.reset();
          nextStepTime = ctx.currentTime + 0.05;
        }
        prevPlaying = shouldRun;

        if (!shouldRun) return;

        if (externalClock) {
          // One step per rising edge of clock_in. We deliberately don't
          // pre-schedule any future steps in this mode — TIMELORDE
          // upstream owns timing.
          const edges = pollExternalClockEdges();
          for (let e = 0; e < edges; e++) {
            // Apply queued slot at the start of a new pattern (step 0).
            if (stepIndex === 0) maybeApplyQueuedSlot();
            emitStep(stepIndex, ctx.currentTime + 0.005);
            stepIndex = (stepIndex + 1) % STEP_COUNT;
          }
          return;
        }

        const bpm = Math.max(30, readParam('bpm', 120));
        const swing = Math.min(0.75, Math.max(0, readParam('swing', 0)));
        // 16-step = one bar at 4/4 = 16 sixteenths. Step duration in
        // seconds = (60 / bpm) / 4.
        const baseStepS = (60 / bpm) / 4;
        const horizon = ctx.currentTime + LOOKAHEAD_S;
        while (nextStepTime < horizon) {
          // Apply queued slot at the start of a new pattern (step 0).
          // The new tracks + bpm/swing/gain take effect from this step
          // forward; the lookahead may have already scheduled future
          // steps from the OLD pattern up to horizon — those stay (no
          // glitchy mid-bar swap).
          if (stepIndex === 0) maybeApplyQueuedSlot();
          // Swing: shift every odd 16th later by `swing * baseStepS / 2`.
          // 0 swing == straight, 0.5 == strong triplet feel, 0.75 ==
          // very loose.
          const isOddStep = (stepIndex % 2) === 1;
          const swungAt = isOddStep ? nextStepTime + swing * baseStepS * 0.5 : nextStepTime;
          emitStep(stepIndex, swungAt);
          stepIndex = (stepIndex + 1) % STEP_COUNT;
          nextStepTime += baseStepS;
        }
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn('[hydrogen] tick error', err);
      }
    }

    const clock = getSchedulerClock();
    unsubscribeTick = clock.subscribe(tick);

    // Build the gate-input map: clock + reset + transport CV +
    // per-instrument trig ports each route to their own Gain sink so
    // the engine's edge-validation accepts gate cables.
    const inputs = new Map<string, { node: AudioNode; input: number }>([
      ['clock_in', { node: clockInGain, input: 0 }],
      ['reset_in', { node: resetInGain, input: 0 }],
    ]);
    // Transport CV inputs: play_cv, reset_cv, queue1..4_cv. Each rising
    // edge gets drained by transportCv.drain() inside tick() and
    // dispatched (play toggles isPlaying; reset_cv jumps stepIndex
    // to 0; queue{N} stages slot N to load at the next pattern wrap).
    for (const [portId, entry] of transportCv.inputs.entries()) {
      inputs.set(portId, entry);
    }
    for (let i = 0; i < TR808_INSTRUMENT_COUNT; i++) {
      inputs.set(`trig${i}`, { node: trigGains[i]!, input: 0 });
    }

    return {
      domain: 'audio',
      inputs,
      outputs: new Map<string, { node: AudioNode; output: number }>([
        ['out_l', { node: splitter, output: 0 }],
        ['out_r', { node: splitter, output: 1 }],
      ]),
      setParam(_paramId, _value) {
        // No AudioParam to write — tick re-reads node.params each iteration.
      },
      readParam(paramId) {
        const live = livePatch.nodes[nodeId];
        const v = live?.params?.[paramId];
        return typeof v === 'number' ? v : undefined;
      },
      read(key: string): unknown {
        if (key === 'currentStep') return playhead.currentAt(ctx.currentTime);
        if (key === 'stepIndex') return stepIndex;
        return undefined;
      },
      dispose() {
        alive = false;
        unsubscribeTick?.();
        try { masterGain.disconnect(); } catch { /* */ }
        for (const g of instrumentGain) try { g.disconnect(); } catch { /* */ }
        for (const p of instrumentPan) try { p.disconnect(); } catch { /* */ }
        for (const g of trigGains) try { g.disconnect(); } catch { /* */ }
        try { clockInGain.disconnect(); } catch { /* */ }
        try { resetInGain.disconnect(); } catch { /* */ }
        try { clockInSilence.stop(); } catch { /* */ }
        try { resetInSilence.stop(); } catch { /* */ }
        try { transportCv.dispose(); } catch { /* */ }
        for (const s of trigSilences) try { s.stop(); } catch { /* */ }
        for (const set of voicesByMuteGroup.values()) {
          for (const v of set) { try { v.source.stop(); } catch { /* */ } }
        }
        voicesByMuteGroup.clear();
      },
    };
  },
};

export { instrumentParamIds };
