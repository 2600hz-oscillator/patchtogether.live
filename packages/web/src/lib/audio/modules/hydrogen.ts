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
//
// Inputs:
//   clock_in (gate): external clock; rising edges advance one step.
//   reset_in (gate): rising edge resets the playhead.
//   play_cv (cv): bipolar transport CV (≥0.5 → play, <0.5 → stop).
//   reset_cv (cv): bipolar reset CV (≥0.5 → reset).
//   queue1_cv..queue4_cv (cv): scene-slot recall CVs (≥0.5 → recall that slot).
//
// Outputs:
//   out_l / out_r (audio): stereo master mix.
//
// Params (per kit + per-voice):
//   bpm (linear 30..300, default 120): internal tempo.
//   swing (linear 0..0.75, default 0): off-step time shift.
//   gain (linear 0..2, default 1): master gain.
//   isPlaying (discrete 0..1, default 0): transport state.
//   kit (discrete 0..N, default DEFAULT_KIT_INDEX): kit picker (TR-808 / TR-909 / FM-PERC / 8BIT).
//   per-voice × 16 (volume, pan, pitch, cutoff, resonance, attack, decay, sustain, release,
//     mute, solo) — exposed via the shared VoiceOpts contract; built programmatically.

import type { AudioDomainNodeHandle } from '$lib/audio/engine';
import type { AudioModuleDef } from '$lib/audio/module-registry';
import { patch as livePatch } from '$lib/graph/store';
import { getSchedulerClock } from '$lib/audio/scheduler-clock';
import { createEdgeCounter, type EdgeCounter } from '$lib/audio/edge-detect';
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

/** Per-voice CV-input slot descriptors. Each voice exposes 9 CV inputs
 *  (one per param the user can dial on the card's expanded voice strip).
 *  The port-id naming pattern is `cv_<short>_<voice-index>` to keep id
 *  strings short — the cable-router uses them verbatim. cvScale matches
 *  the param's curve so a -1..+1 CV sweeps the param's full natural
 *  range (cv-range-standard.md). */
export const PER_VOICE_CV_SLOTS = [
  { short: 'vol', paramPrefix: 'vol',    cvScale: 'linear' as const },
  { short: 'pan', paramPrefix: 'pan',    cvScale: 'linear' as const },
  { short: 'pi',  paramPrefix: 'pitch',  cvScale: 'linear' as const },
  { short: 'cf',  paramPrefix: 'cutoff', cvScale: 'log'    as const },
  { short: 'q',   paramPrefix: 'q',      cvScale: 'log'    as const },
  { short: 'a',   paramPrefix: 'A',      cvScale: 'log'    as const },
  { short: 'd',   paramPrefix: 'D',      cvScale: 'log'    as const },
  { short: 's',   paramPrefix: 'S',      cvScale: 'linear' as const },
  { short: 'r',   paramPrefix: 'R',      cvScale: 'log'    as const },
] as const;

/** Port id for the CV input wired to voice `idx`'s `slot.paramPrefix`. */
export function perVoiceCvPortId(slotShort: string, idx: number): string {
  return `cv_${slotShort}_${idx}`;
}

/** Param id the CV input drives. Pure helper so the def, factory, and
 *  card row all agree on the mapping. */
export function perVoiceCvParamTarget(slotPrefix: string, idx: number): string {
  return `${slotPrefix}${idx}`;
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
 *    * cv_<param>_<i> per voice  — 9 per-voice CV inputs × 16 voices =
 *                                  144 inputs that drive vol/pan/pitch/
 *                                  cutoff/Q/A/D/S/R for each instrument.
 *                                  Each declares paramTarget so the
 *                                  cv-range-standard scaler runs and a
 *                                  -1..+1 LFO sweeps the param's full
 *                                  natural range.
 *
 *  The manifest-builder's literal-array extractor can't read spreads, so
 *  we hide the full list behind this builder + let the synthesizer in
 *  module-manifest.ts produce the equivalent shape (same RIOTGIRLS
 *  pattern). */
function buildHydrogenInputs() {
  const inputs: Array<{
    id: string;
    type: 'gate' | 'cv';
    paramTarget?: string;
    cvScale?: { mode: 'linear' | 'log' };
  }> = [
    { id: 'clock_in', type: 'gate' },
    { id: 'reset_in', type: 'gate' },
  ];
  for (const p of TRANSPORT_CV_PORT_DEFS) {
    inputs.push({ id: p.id, type: 'gate' });
  }
  for (let i = 0; i < HYDROGEN_INSTRUMENT_COUNT; i++) {
    inputs.push({ id: `trig${i}`, type: 'gate' });
  }
  for (let i = 0; i < HYDROGEN_INSTRUMENT_COUNT; i++) {
    for (const slot of PER_VOICE_CV_SLOTS) {
      inputs.push({
        id: perVoiceCvPortId(slot.short, i),
        type: 'cv',
        paramTarget: perVoiceCvParamTarget(slot.paramPrefix, i),
        cvScale: { mode: slot.cvScale },
      });
    }
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
  palette: { top: 'Audio modules', sub: 'VCOs' },
  label: 'hydrogen',
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

  docs: (() => {
    const inputs: Record<string, string> = {
      clock_in:
        "External clock: each rising edge advances the pattern playhead one step (16th-note cell). Patch a clock here and the internal BPM is ignored — the incoming pulses set the pace.",
      reset_in: "A rising edge snaps the pattern playhead back to step 1 (the downbeat) without stopping playback.",
      play_cv: "A rising edge toggles play/stop (each pulse flips the run state). Hands-free transport from a patched gate.",
      reset_cv: "A rising edge resets the playhead to step 1 — an alias of RESET IN (both reset on a rising edge); use whichever port is convenient.",
      queue1_cv: "A rising edge queues preset slot 1 — the pattern + tempo swap cleanly at the end of the current loop (does nothing if slot 1 is empty).",
      queue2_cv: "A rising edge queues preset slot 2 — applied at the next loop wrap (no-op if slot 2 is empty).",
      queue3_cv: "A rising edge queues preset slot 3 — applied at the next loop wrap (no-op if slot 3 is empty).",
      queue4_cv: "A rising edge queues preset slot 4 — applied at the next loop wrap (no-op if slot 4 is empty).",
    };
    const controls: Record<string, string> = {
      bpm: "Internal tempo in BPM (30..300, default 120). Each pattern step is a 16th note. Used only when nothing is patched into CLOCK IN; an external clock overrides it.",
      swing: "Shuffle amount (0..0.75) — delays the off-beat (even) steps relative to the on-beats for a swung groove. 0 = dead straight. Internal-clock only.",
      gain: "Master output gain (0..2, default 1) on the summed stereo mix (out_l/out_r); 1 = unity, above 1 boosts.",
      isPlaying: "Run/stop state (the PLAY button): 1 plays, 0 stops and silences the playhead. Starting playback resets to step 1. An external clock can still advance steps while stopped.",
      kit: "Drum-kit selector (discrete) — switches the loaded sample/synth kit (TR-808, TR-909, LinnDrum, CR-78, and others). Per-instrument tuning (vol/pan/pitch/env/etc.) PERSISTS across kit swaps, like a hardware drum machine where 'channel 5 volume' doesn't reset when you load a new kit.",
      'hydrogen-cell-{n}':
        "A single step cell in the 16×16 pattern grid (instrument row × 16 steps). Click to toggle whether that instrument fires on that step — lit = a hit, unlit = a rest. The playhead walks the 16 steps and plays every lit cell of every row; the currently-sounding step is highlighted. CLEAR empties the whole grid.",
    };
    for (let i = 0; i < HYDROGEN_INSTRUMENT_COUNT; i++) {
      const ch = i + 1; // human-facing 1-based channel number
      // Per-instrument knobs (expand a row by clicking its name on the card).
      controls[`vol${i}`]    = `Instrument ${ch} VOLUME (0..2) — the channel's level into the master mix. CV via the cv_vol_${i} input.`;
      controls[`pan${i}`]    = `Instrument ${ch} PAN (−1 left .. +1 right) in the stereo field. CV via the cv_pan_${i} input.`;
      controls[`pitch${i}`]  = `Instrument ${ch} PITCH offset in semitones (−24..+24) — repitch the drum sample/voice up or down. CV via the cv_pi_${i} input.`;
      controls[`cutoff${i}`] = `Instrument ${ch} per-voice low-pass CUTOFF (20 Hz..20 kHz, log; default fully open) — darkens this voice. CV via the cv_cf_${i} input.`;
      controls[`q${i}`]      = `Instrument ${ch} filter RESONANCE/Q (0.1..20) — emphasis at the cutoff frequency. CV via the cv_q_${i} input.`;
      controls[`A${i}`]      = `Instrument ${ch} amp-envelope ATTACK (0..2 s, log) — how fast each hit rises. CV via the cv_a_${i} input.`;
      controls[`D${i}`]      = `Instrument ${ch} amp-envelope DECAY (0..2 s, log) — fall time from the attack peak to the sustain level. CV via the cv_d_${i} input.`;
      controls[`S${i}`]      = `Instrument ${ch} amp-envelope SUSTAIN level (0..1) — the level held while the trigger is high. CV via the cv_s_${i} input.`;
      controls[`R${i}`]      = `Instrument ${ch} amp-envelope RELEASE (0.01..5 s, log) — fade time after the trigger ends; sets how long the tail rings. CV via the cv_r_${i} input.`;
      controls[`mute${i}`]   = `Instrument ${ch} MUTE (the row's M button) — silences this instrument when on, without erasing its pattern.`;
      controls[`solo${i}`]   = `Instrument ${ch} SOLO (the row's S button) — when any instrument is soloed only soloed instruments sound; un-solo to hear the full kit again.`;
      // Per-voice trig + the 9 per-voice CV inputs.
      inputs[`trig${i}`] = `Instrument ${ch} direct TRIGGER — a rising edge fires this voice once (one hit), independent of the step grid. Patch a sequencer/clock here to play this drum directly.`;
      inputs[`cv_vol_${i}`] = `CV that offsets instrument ${ch}'s VOLUME (linear).`;
      inputs[`cv_pan_${i}`] = `CV that offsets instrument ${ch}'s PAN (linear).`;
      inputs[`cv_pi_${i}`]  = `CV that offsets instrument ${ch}'s PITCH (linear).`;
      inputs[`cv_cf_${i}`]  = `CV that offsets instrument ${ch}'s filter CUTOFF (log).`;
      inputs[`cv_q_${i}`]   = `CV that offsets instrument ${ch}'s filter RESONANCE/Q (log).`;
      inputs[`cv_a_${i}`]   = `CV that offsets instrument ${ch}'s envelope ATTACK (log).`;
      inputs[`cv_d_${i}`]   = `CV that offsets instrument ${ch}'s envelope DECAY (log).`;
      inputs[`cv_s_${i}`]   = `CV that offsets instrument ${ch}'s envelope SUSTAIN (linear).`;
      inputs[`cv_r_${i}`]   = `CV that offsets instrument ${ch}'s envelope RELEASE (log).`;
    }
    return {
      explanation:
        "A multi-kit 16-instrument × 16-step drum machine (named after the open-source Hydrogen sequencer). Each of 16 instrument rows holds a 16-step on/off pattern grid; the playhead walks the steps at the BPM tempo (or an external CLOCK IN) and fires each lit step's drum voice. Pick a kit (TR-808 / TR-909 / LinnDrum / CR-78 / …) with the kit button; every instrument has its own VOLUME, PAN, PITCH, a per-voice low-pass FILTER (cutoff + Q), a full amp ADSR, and MUTE/SOLO — exposed by clicking an instrument's name to expand its knob strip (the patch panel also carries every per-voice CV input + direct TRIG). The whole transport (play/stop, reset, 4 preset slots) is drivable hands-free via the CV inputs, and SWING shuffles the groove. Output is a stereo mix (out_l/out_r) through the master GAIN. Each instrument can also be triggered directly by a gate on its trig{i} input, bypassing the grid — so you can drive HYDROGEN purely as a 16-voice sample player from external sequencers.",
      inputs,
      outputs: {
        out_l: "Left channel of the stereo drum mix — all 16 instruments summed (post per-voice vol/pan/filter/env and master GAIN).",
        out_r: "Right channel of the stereo drum mix, the partner of out_l (carries the pan-positioned right side).",
      },
      controls,
    };
  })(),

  controlFamilies: [
    // The 16×16 pattern grid: each instrument row has 16 step cells
    // (data-testid `hydrogen-cell-<nodeId>-<step>`). Click a cell to toggle
    // that step's hit on/off for that instrument. DOM-only state (lives on
    // node.data.tracks), not a ParamDef — declared so the docs layer + the
    // contract signature see the grid.
    { id: 'hydrogen-cell', label: 'Step pattern grid (16 instruments × 16 steps)', kind: 'step-grid', testidPrefix: 'hydrogen-cell' },
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

    // ---------- Per-voice CV inputs (144 = 16 × 9) ----------
    //
    // Each per-voice CV input is backed by a ConstantSource whose `offset`
    // AudioParam acts as the AudioParam the engine sums external CV into
    // (the engine's CV bridge does cvScale → param routing whenever the
    // PortDef declares cvScale + paramTarget). We expose the AudioParam
    // to the engine via the inputs Map's `param` field; we read the
    // current modulated value back via an AnalyserNode tap each tick and
    // fold it into readParam(). The constant-source's INITIAL offset is
    // 0 (CV is additive) — the knob value provides the base in readParam.
    //
    // Same pattern as POLYSEQZ.humanizeCV — just scaled to 144 voices
    // worth of slots. Tap fftSize is 256 (we don't need fine resolution;
    // a knob is read at tick rate, not audio rate).
    interface VoiceCvSlot {
      source: ConstantSourceNode;
      analyser: AnalyserNode;
      buf: Float32Array<ArrayBuffer>;
    }
    const voiceCvSlots = new Map<string, VoiceCvSlot>();
    function makeVoiceCv(): VoiceCvSlot {
      const source = ctx.createConstantSource();
      source.offset.value = 0;
      source.start();
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 256;
      source.connect(analyser);
      const buf = new Float32Array(new ArrayBuffer(analyser.fftSize * 4));
      return { source, analyser, buf };
    }
    for (let i = 0; i < HYDROGEN_INSTRUMENT_COUNT; i++) {
      for (const slot of PER_VOICE_CV_SLOTS) {
        voiceCvSlots.set(perVoiceCvParamTarget(slot.paramPrefix, i), makeVoiceCv());
      }
    }
    /** Read the latest modulated CV value for a given paramId. Returns 0
     *  if no slot exists (i.e. caller asked about a non-voice param like
     *  bpm/swing/gain). Averages a short tail of the analyser buffer for
     *  a stable read — the tick polls at ~SCHEDULER_TICK_MS, no need for
     *  per-sample fidelity. */
    function readVoiceCv(paramId: string): number {
      const slot = voiceCvSlots.get(paramId);
      if (!slot) return 0;
      slot.analyser.getFloatTimeDomainData(slot.buf);
      let sum = 0;
      const N = Math.min(slot.buf.length, 64);
      for (let i = slot.buf.length - N; i < slot.buf.length; i++) sum += slot.buf[i] ?? 0;
      return sum / N;
    }

    // ---------- Per-instrument trig{i} input handling ----------
    const trigGains: GainNode[] = [];
    const trigAnalysers: AnalyserNode[] = [];
    const trigSilences: ConstantSourceNode[] = [];
    // Per-instrument windowed edge counters — one strike per rising edge, no
    // overlap double-count (the shared seam; replaces the old peak-over-buffer
    // scan that could miss closely-spaced strikes).
    const trigCounters: EdgeCounter[] = [];
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
      trigCounters.push(createEdgeCounter({ ctx, analyser: a }));
    }

    // ---------- clock_in / reset_in detection ----------
    const clockInGain = ctx.createGain();
    const clockInAnalyser = ctx.createAnalyser();
    clockInAnalyser.fftSize = 2048;
    clockInGain.connect(clockInAnalyser);
    const clockInSilence = ctx.createConstantSource();
    clockInSilence.offset.value = 0;
    clockInSilence.start();
    clockInSilence.connect(clockInGain);
    const clockCounter = createEdgeCounter({ ctx, analyser: clockInAnalyser });

    const resetInGain = ctx.createGain();
    const resetInAnalyser = ctx.createAnalyser();
    resetInAnalyser.fftSize = 2048;
    resetInGain.connect(resetInAnalyser);
    const resetInSilence = ctx.createConstantSource();
    resetInSilence.offset.value = 0;
    resetInSilence.start();
    resetInSilence.connect(resetInGain);
    const resetCounter = createEdgeCounter({ ctx, analyser: resetInAnalyser });

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
      const base = typeof v === 'number' ? v : fallback;
      // Fold in per-voice CV modulation when this param has a CV input
      // wired to it. The engine already routes a -1..+1 CV through the
      // cvScale chain so the value we read here is already in the
      // param's natural range — additive on top of the knob value.
      // Clamp to the param's min/max so out-of-range modulation doesn't
      // bake weird negatives into log curves downstream.
      const cv = readVoiceCv(id);
      if (cv === 0) return base;
      const sum = base + cv;
      const paramDef = hydrogenDef.params.find((p) => p.id === id);
      if (!paramDef) return sum;
      const min = (paramDef as { min?: number }).min ?? -Infinity;
      const max = (paramDef as { max?: number }).max ?? Infinity;
      return sum < min ? min : sum > max ? max : sum;
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
      const now = ctx.currentTime;
      for (let i = 0; i < HYDROGEN_INSTRUMENT_COUNT; i++) {
        // One strike per rising edge, windowed to new-samples-since-last-tick:
        // a held/slow trig fires exactly once (not once per tick).
        const edges = trigCounters[i]!.poll(now);
        for (let e = 0; e < edges; e++) fireInstrument(i, now + 0.005);
      }
    }

    function pollResetInput(): void {
      if (resetCounter.poll(ctx.currentTime) > 0) {
        stepIndex = 0;
        playhead.reset();
        nextStepTime = ctx.currentTime + 0.005;
      }
    }

    function pollExternalClockEdges(): number {
      return clockCounter.poll(ctx.currentTime);
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
          if (typeof v === 'number') live.params[k] = v; // guard:allow-raw-write — sequencer slot-restore during the playback tick, not a user edit
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

    const inputs = new Map<string, { node: AudioNode; input: number; param?: AudioParam }>([
      ['clock_in', { node: clockInGain, input: 0 }],
      ['reset_in', { node: resetInGain, input: 0 }],
    ]);
    for (const [portId, entry] of transportCv.inputs.entries()) {
      inputs.set(portId, entry);
    }
    for (let i = 0; i < HYDROGEN_INSTRUMENT_COUNT; i++) {
      inputs.set(`trig${i}`, { node: trigGains[i]!, input: 0 });
    }
    // 144 per-voice CV inputs — each port id maps to a backing
    // ConstantSource whose `offset` AudioParam serves as the engine's
    // sum target. The engine's CV bridge connects external CV through a
    // cvScale chain (see engine.ts:getCvScaleForTarget) into this
    // AudioParam, and the tick reads back the modulated value via
    // readVoiceCv() above.
    for (let i = 0; i < HYDROGEN_INSTRUMENT_COUNT; i++) {
      for (const slot of PER_VOICE_CV_SLOTS) {
        const paramId = perVoiceCvParamTarget(slot.paramPrefix, i);
        const cvSlot = voiceCvSlots.get(paramId)!;
        inputs.set(perVoiceCvPortId(slot.short, i), {
          node: cvSlot.source,
          input: 0,
          param: cvSlot.source.offset,
        });
      }
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
        for (const slot of voiceCvSlots.values()) {
          try { slot.source.stop(); } catch { /* */ }
          try { slot.source.disconnect(); } catch { /* */ }
          try { slot.analyser.disconnect(); } catch { /* */ }
        }
        voiceCvSlots.clear();
        for (const set of voicesByMuteGroup.values()) {
          for (const v of set) { try { v.stop(ctx.currentTime); } catch { /* */ } }
        }
        voicesByMuteGroup.clear();
      },
    };
  },
};

