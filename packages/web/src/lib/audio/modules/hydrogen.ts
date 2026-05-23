// packages/web/src/lib/audio/modules/hydrogen.ts
//
// HYDROGEN — multi-kit 16-instrument × 16-step drum machine. Ships
// four kits today:
//
//   * TR-808 (sample, GPL'd Hydrogen-music data)
//   * TR-909 (synthesized, original-design)
//   * FM-PERC (synthesized FM percussion)
//   * 8BIT (synthesized chiptune drums)
//
// The KitDef abstraction (hydrogen-kit-types.ts + hydrogen-kit-registry.ts)
// lets a single factory handle both sample-based and synthesized
// instruments uniformly. Per-voice user knobs (Vol/Pan/Pitch/Cutoff/Q/
// A/D/S/R) bite the same way across kit types via the shared VoiceOpts
// contract.
//
// Architecture (pure JS Web Audio — no Faust, no AudioWorklet):
//
//   per-instrument bus:    instrumentGain[i] → instrumentPan[i] ─┐
//                                                                 ↓
//   per-trigger voice:     <kit-specific source chain> → instrumentGain[i]
//                                                                 ↑
//   master:                       … 16 buses → masterGain[L|R] → out_l/out_r
//
// For sample kits the source chain is BufferSource → BiquadFilter → ampEnv;
// for synth kits it's whatever the kit's synth fn builds (see
// hydrogen-kit-synth-utils.ts for the primitives). Both paths produce
// a SynthVoice-shaped handle for the choke + cleanup machinery.
//
// Pattern + transport: the shared scheduler-clock (Worker tick, jank-
// immune) ticks every SCHEDULER_TICK_MS, and the factory schedules a
// 200 ms lookahead of upcoming step-fire events. Same lookahead
// architecture as DRUMSEQZ / RIOTGIRLS — keeps audio-thread events
// sample-accurate under main-thread jank.
//
// Transport contract:
//   * isPlaying param drives play/stop (toggle exposed to GROUP! bar).
//   * Optional external `clock_in` gate input — when patched, each
//     rising edge advances one step (DRUMSEQZ-parity).
//   * Optional `reset_in` gate input — rising edge resets the playhead.
//   * Transport CV: play_cv / reset_cv / queue{1..4}_cv — same shape as
//     SCORE / DRUMSEQZ / POLYSEQZ. Per-instrument tuning is kept across
//     slot swaps (matches a hardware drum machine).

import type { AudioDomainNodeHandle } from '$lib/audio/engine';
import type { AudioModuleDef } from '$lib/audio/module-registry';
import { patch as livePatch } from '$lib/graph/store';
import { getSchedulerClock } from '$lib/audio/scheduler-clock';
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
import { TR808_INSTRUMENTS, loadTR808Sample } from './hydrogen-tr808-kit-data';
import { KITS, KIT_COUNT, DEFAULT_KIT_INDEX, kitByIndex } from './hydrogen-kit-registry';
import type { KitInstrument, VoiceOpts } from './hydrogen-kit-types';

export const STEP_COUNT = 16;

/** All HYDROGEN kits ship exactly 16 instruments — the pattern grid +
 *  per-instrument params bake this in. New kits must match. */
export const HYDROGEN_INSTRUMENT_COUNT = 16;

export interface HydrogenCell {
  on: boolean;
}

export type HydrogenTrack = HydrogenCell[]; // length STEP_COUNT

export interface HydrogenData {
  /** Length HYDROGEN_INSTRUMENT_COUNT, each track length STEP_COUNT. */
  tracks: HydrogenTrack[];
}

function defaultCell(): HydrogenCell {
  return { on: false };
}

export function defaultTrack(): HydrogenTrack {
  return Array.from({ length: STEP_COUNT }, defaultCell);
}

export function defaultTracks(): HydrogenTrack[] {
  return Array.from({ length: HYDROGEN_INSTRUMENT_COUNT }, defaultTrack);
}

export function coerceCell(raw: unknown): HydrogenCell {
  if (!raw || typeof raw !== 'object') return defaultCell();
  return { on: !!(raw as { on?: unknown }).on };
}

export function coerceTracks(raw: unknown): HydrogenTrack[] {
  if (!Array.isArray(raw)) return defaultTracks();
  const out: HydrogenTrack[] = [];
  for (let t = 0; t < HYDROGEN_INSTRUMENT_COUNT; t++) {
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
export function instrumentParamIds(): string[] {
  const ids: string[] = [];
  for (let i = 0; i < HYDROGEN_INSTRUMENT_COUNT; i++) {
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
  for (const p of TRANSPORT_CV_PORT_DEFS) {
    inputs.push({ id: p.id, type: 'gate' });
  }
  for (let i = 0; i < HYDROGEN_INSTRUMENT_COUNT; i++) {
    inputs.push({ id: `trig${i}`, type: 'gate' });
  }
  return inputs;
}

/** Per-instrument default getters — pulled from the TR-808 kit since
 *  it's the historical first kit + has the most opinion-laden values
 *  (pans for toms, mute group for hats). Synth kits get their own
 *  defaults via the KitDef; the param's fallback is the TR-808 value
 *  so legacy saves keep working. */
function tr808Default(i: number, key: 'gain' | 'pan' | 'A' | 'D' | 'S' | 'R'): number {
  const inst = TR808_INSTRUMENTS[i];
  if (!inst) return key === 'S' ? 1 : 0;
  switch (key) {
    case 'gain': return inst.defaultGain;
    case 'pan':  return inst.defaultPan;
    case 'A':    return inst.defaultA;
    case 'D':    return inst.defaultD;
    case 'S':    return inst.defaultS;
    case 'R':    return inst.defaultR;
  }
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
    // Kit selector — discrete 0..KIT_COUNT-1 indexing into KITS.
    // 0 = TR-808 (matches legacy single-kit behaviour).
    { id: 'kit',       label: 'Kit',  defaultValue: DEFAULT_KIT_INDEX, min: 0, max: Math.max(0, KIT_COUNT - 1), curve: 'discrete' },
    // Per-instrument params. Defaults reference the TR-808 table for
    // backwards compatibility; the active kit may override at runtime.
    ...Array.from({ length: HYDROGEN_INSTRUMENT_COUNT }, (_, i) => [
      { id: `vol${i}`,    label: `${i}V`,  defaultValue: tr808Default(i, 'gain'), min: 0,    max: 2,     curve: 'linear' as const },
      { id: `pan${i}`,    label: `${i}P`,  defaultValue: tr808Default(i, 'pan'),  min: -1,   max: 1,     curve: 'linear' as const },
      { id: `pitch${i}`,  label: `${i}Pi`, defaultValue: 0,                       min: -24,  max: 24,    curve: 'linear' as const, units: 'st' as const },
      { id: `cutoff${i}`, label: `${i}Cf`, defaultValue: 20000,                   min: 20,   max: 20000, curve: 'log'    as const, units: 'Hz' as const },
      { id: `q${i}`,      label: `${i}Q`,  defaultValue: 0.7,                     min: 0.1,  max: 20,    curve: 'log'    as const },
      { id: `A${i}`,      label: `${i}A`,  defaultValue: tr808Default(i, 'A'),    min: 0,    max: 2,     curve: 'log'    as const },
      { id: `D${i}`,      label: `${i}D`,  defaultValue: tr808Default(i, 'D'),    min: 0,    max: 2,     curve: 'log'    as const },
      { id: `S${i}`,      label: `${i}S`,  defaultValue: tr808Default(i, 'S'),    min: 0,    max: 1,     curve: 'linear' as const },
      { id: `R${i}`,      label: `${i}R`,  defaultValue: tr808Default(i, 'R'),    min: 0.01, max: 5,     curve: 'log'    as const },
      { id: `mute${i}`,   label: `${i}M`,  defaultValue: 0,                       min: 0,    max: 1,     curve: 'discrete' as const },
      { id: `solo${i}`,   label: `${i}S`,  defaultValue: 0,                       min: 0,    max: 1,     curve: 'discrete' as const },
    ]).flat(),
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

    const instrumentGain: GainNode[] = [];
    const instrumentPan: StereoPannerNode[] = [];
    for (let i = 0; i < HYDROGEN_INSTRUMENT_COUNT; i++) {
      const g = ctx.createGain();
      g.gain.value = node.params?.[`vol${i}`] as number ?? tr808Default(i, 'gain');
      const p = ctx.createStereoPanner();
      p.pan.value = node.params?.[`pan${i}`] as number ?? tr808Default(i, 'pan');
      g.connect(p);
      p.connect(masterGain);
      instrumentGain.push(g);
      instrumentPan.push(p);
    }

    // ---------- Sample preload ----------
    //
    // Eagerly fetch every sample-kit instrument's audio so the first
    // trigger lands on a hot cache. Synth kits don't need a preload —
    // their voices are built from oscillators / noise at trigger time.
    const sampleCache = new Map<string, AudioBuffer>();
    async function preloadAllSamples() {
      const urls = new Set<string>();
      for (const kit of KITS) {
        for (const inst of kit.instruments) {
          if (inst.kind === 'sample') urls.add(inst.sampleUrl);
        }
      }
      try {
        await Promise.all([...urls].map(async (url) => {
          const buf = await loadTR808Sample(ctx, url);
          sampleCache.set(url, buf);
        }));
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn('[hydrogen] sample preload failed; sample voices will be silent', err);
      }
    }
    await preloadAllSamples();

    // ---------- Voice scheduling + mute-group choke ----------
    //
    // ActiveVoice abstracts over sample (BufferSource + GainNode) and
    // synth (whatever the kit's voice fn built) — both implement a
    // common `stop(atTime)` so chokeGroup() works uniformly.

    interface ActiveVoice {
      stop(atTime: number): void;
      muteGroup: number;
    }
    const voicesByMuteGroup = new Map<number, Set<ActiveVoice>>();

    function chokeGroup(group: number, atTime: number) {
      if (group <= 0) return;
      const set = voicesByMuteGroup.get(group);
      if (!set) return;
      for (const v of set) {
        try { v.stop(atTime); } catch { /* */ }
      }
      set.clear();
    }

    function readActiveKitIndex(): number {
      const v = livePatch.nodes[nodeId]?.params?.kit;
      const n = typeof v === 'number' ? v : DEFAULT_KIT_INDEX;
      return Math.max(0, Math.min(KIT_COUNT - 1, Math.round(n)));
    }

    function activeKitInstruments(): readonly KitInstrument[] {
      return kitByIndex(readActiveKitIndex()).instruments;
    }

    /** Build the VoiceOpts for instrument idx — pulled from live params
     *  (knob OR engine CV). The synth path uses these directly; the
     *  sample path applies them to its biquad + envelope. */
    function voiceOptsFor(idx: number, velocity: number): VoiceOpts {
      return {
        velocity,
        pitchSt: readParam(`pitch${idx}`, 0),
        cutoffHz: readParam(`cutoff${idx}`, 20000),
        q: readParam(`q${idx}`, 0.7),
        attackS: readParam(`A${idx}`, tr808Default(idx, 'A')),
        decayS: readParam(`D${idx}`, tr808Default(idx, 'D')),
        sustain: readParam(`S${idx}`, tr808Default(idx, 'S')),
        releaseS: readParam(`R${idx}`, tr808Default(idx, 'R')),
      };
    }

    function fireSampleInstrument(
      inst: KitInstrument & { kind: 'sample' },
      idx: number,
      atTime: number,
      opts: VoiceOpts,
    ): ActiveVoice | null {
      const buf = sampleCache.get(inst.sampleUrl);
      if (!buf) return null;

      const source = ctx.createBufferSource();
      source.buffer = buf;
      source.playbackRate.value = Math.pow(2, opts.pitchSt / 12);

      const filter = ctx.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.value = opts.cutoffHz;
      filter.Q.value = opts.q;

      const env = ctx.createGain();
      const peak = opts.velocity;
      const sustainV = opts.sustain * peak;
      env.gain.setValueAtTime(0, atTime);
      env.gain.linearRampToValueAtTime(peak, atTime + Math.max(0.001, opts.attackS));
      env.gain.linearRampToValueAtTime(
        sustainV,
        atTime + Math.max(0.001, opts.attackS) + Math.max(0.001, opts.decayS),
      );

      source.connect(filter);
      filter.connect(env);
      env.connect(instrumentGain[idx]!);
      source.start(atTime);

      const dur = buf.duration;
      const releaseStart = atTime + dur;
      try {
        env.gain.setValueAtTime(sustainV, releaseStart);
        env.gain.linearRampToValueAtTime(0, releaseStart + Math.max(0.005, opts.releaseS));
      } catch { /* */ }

      const voice: ActiveVoice = {
        muteGroup: inst.muteGroup,
        stop(at: number) {
          const FAST = 0.005;
          try {
            env.gain.cancelScheduledValues(at);
            env.gain.setValueAtTime(env.gain.value, at);
            env.gain.linearRampToValueAtTime(0, at + FAST);
            source.stop(at + FAST + 0.01);
          } catch { /* */ }
        },
      };

      source.onended = () => {
        if (inst.muteGroup > 0) voicesByMuteGroup.get(inst.muteGroup)?.delete(voice);
        try { source.disconnect(); filter.disconnect(); env.disconnect(); } catch { /* */ }
      };

      return voice;
    }

    function fireSynthInstrument(
      inst: KitInstrument & { kind: 'synth' },
      idx: number,
      atTime: number,
      opts: VoiceOpts,
    ): ActiveVoice {
      const synthVoice = inst.synth(ctx, instrumentGain[idx]!, atTime, opts);
      const voice: ActiveVoice = {
        muteGroup: inst.muteGroup,
        stop(at: number) { synthVoice.stop(at); },
      };
      synthVoice.ended.then(() => {
        if (inst.muteGroup > 0) voicesByMuteGroup.get(inst.muteGroup)?.delete(voice);
      });
      return voice;
    }

    function fireInstrument(idx: number, atTime: number, velocity = 1) {
      const instruments = activeKitInstruments();
      const inst = instruments[idx];
      if (!inst) return;

      // Mute / solo gating.
      if (readParam(`mute${idx}`, 0) >= 0.5) return;
      const anySolo = instruments.some((_, j) => readParam(`solo${j}`, 0) >= 0.5);
      if (anySolo && readParam(`solo${idx}`, 0) < 0.5) return;

      chokeGroup(inst.muteGroup, atTime);

      const opts = voiceOptsFor(idx, velocity);
      const voice = inst.kind === 'sample'
        ? fireSampleInstrument(inst, idx, atTime, opts)
        : fireSynthInstrument(inst, idx, atTime, opts);
      if (!voice) return;

      if (inst.muteGroup > 0) {
        let set = voicesByMuteGroup.get(inst.muteGroup);
        if (!set) {
          set = new Set();
          voicesByMuteGroup.set(inst.muteGroup, set);
        }
        set.add(voice);
      }
    }

    // ---------- Per-instrument trig{i} input handling ----------
    const trigGains: GainNode[] = [];
    const trigAnalysers: AnalyserNode[] = [];
    const trigAnalyserBuf = new Float32Array(2048);
    const trigSilences: ConstantSourceNode[] = [];
    const lastTrigSample: number[] = new Array(HYDROGEN_INSTRUMENT_COUNT).fill(0);
    for (let i = 0; i < HYDROGEN_INSTRUMENT_COUNT; i++) {
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
      for (let i = 0; i < HYDROGEN_INSTRUMENT_COUNT; i++) {
        const cell = tracks[i]?.[idx] ?? defaultCell();
        if (cell.on) fireInstrument(i, atTime);
      }
    }

    function pollTrigInputs(): void {
      for (let i = 0; i < HYDROGEN_INSTRUMENT_COUNT; i++) {
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

        for (let i = 0; i < HYDROGEN_INSTRUMENT_COUNT; i++) {
          instrumentGain[i]!.gain.value = readParam(`vol${i}`, tr808Default(i, 'gain'));
          instrumentPan[i]!.pan.value = readParam(`pan${i}`, tr808Default(i, 'pan'));
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
          const edges = pollExternalClockEdges();
          for (let e = 0; e < edges; e++) {
            if (stepIndex === 0) maybeApplyQueuedSlot();
            emitStep(stepIndex, ctx.currentTime + 0.005);
            stepIndex = (stepIndex + 1) % STEP_COUNT;
          }
          return;
        }

        const bpm = Math.max(30, readParam('bpm', 120));
        const swing = Math.min(0.75, Math.max(0, readParam('swing', 0)));
        const baseStepS = (60 / bpm) / 4;
        const horizon = ctx.currentTime + LOOKAHEAD_S;
        while (nextStepTime < horizon) {
          if (stepIndex === 0) maybeApplyQueuedSlot();
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

    const inputs = new Map<string, { node: AudioNode; input: number }>([
      ['clock_in', { node: clockInGain, input: 0 }],
      ['reset_in', { node: resetInGain, input: 0 }],
    ]);
    for (const [portId, entry] of transportCv.inputs.entries()) {
      inputs.set(portId, entry);
    }
    for (let i = 0; i < HYDROGEN_INSTRUMENT_COUNT; i++) {
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
          for (const v of set) { try { v.stop(ctx.currentTime); } catch { /* */ } }
        }
        voicesByMuteGroup.clear();
      },
    };
  },
};

