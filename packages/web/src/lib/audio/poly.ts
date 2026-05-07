// packages/web/src/lib/audio/poly.ts
//
// Stage 1 of the polyphony architecture (see .myrobots/plans/dx7-and-polyphony.md
// §5). The single concept here is the `polyPitchGate` cable: 5 voice-pairs of
// (pitch_v_oct, gate) packed into one 10-channel audio-rate connection.
//
// Layout, channel-major:
//   ch 0 = lane 0 pitch (V/oct, 0V = C4)
//   ch 1 = lane 0 gate  (0 / 1)
//   ch 2 = lane 1 pitch
//   ch 3 = lane 1 gate
//   ...
//   ch 8 = lane 4 pitch
//   ch 9 = lane 4 gate
//
// Lane 0 is "the root note" by convention; backward-compat routing pulls
// channel 0 when a polyPitchGate source is connected to a mono `pitch` sink.
//
// User-confirmed adjustments to the §5 spec:
//   - 5 lanes (not 4) — "5 is good enough for jazz"; 7ths/9ths use the 5th.
//   - Stage 1 sequencers/cartesian only emit triads, so lane 4 stays gate=0
//     and is reserved for a future allocator/extension.
//   - Voice stealing = oldest-note (when an allocator is needed; sequencers
//     don't need one because chord lanes are deterministic).

import { midiToVOct, MAX_MIDI, MIN_MIDI } from '$lib/audio/note-entry';

// ---------------- Constants ----------------

export const POLY_CHANNEL_PAIRS = 5;
export const POLY_CHANNELS = POLY_CHANNEL_PAIRS * 2;

/** Voice lane index (0..POLY_CHANNEL_PAIRS-1). */
export type Lane = 0 | 1 | 2 | 3 | 4;

// ---------------- Chord quality ----------------

export type ChordQuality = 'mono' | 'maj' | 'min';

/** All allowed chord qualities, in cycle-tap order (mono → maj → min → mono). */
export const CHORD_QUALITIES: ReadonlyArray<ChordQuality> = ['mono', 'maj', 'min'];

/** Cycle to the next chord quality in the picker order. */
export function nextChordQuality(q: ChordQuality | undefined): ChordQuality {
  const cur = q ?? 'mono';
  const idx = CHORD_QUALITIES.indexOf(cur);
  // Unknown values fall back to 'mono'; otherwise advance.
  if (idx < 0) return 'mono';
  return CHORD_QUALITIES[(idx + 1) % CHORD_QUALITIES.length] as ChordQuality;
}

// ---------------- Chord math ----------------

/** Per-lane voicing produced by chordVoicing(). */
export interface VoicingLane {
  midi: number | null;
  gate: 0 | 1;
}

/**
 * Compute the per-lane (midi, gate) voicing for a given base MIDI note and
 * chord quality. Always returns POLY_CHANNEL_PAIRS entries.
 *
 * Voicings:
 *   mono: lane 0 = root (gate=1); lanes 1..4 silent (gate=0).
 *   maj:  lane 0 = root, 1 = +4 (M3), 2 = +7 (P5), 3 = +12 (octave).
 *         lane 4 silent (reserved for 7ths/9ths in a later stage).
 *   min:  lane 0 = root, 1 = +3 (m3), 2 = +7 (P5), 3 = +12 (octave). Lane 4 silent.
 *
 * If baseMidi is null (empty step) all lanes return midi=null gate=0.
 *
 * If a triad lane would exceed MAX_MIDI / fall below MIN_MIDI, that lane
 * drops to gate=0; the rest of the chord still plays. We drop the octave
 * doubling (lane 3) before the 3rd or 5th — body before color.
 */
export function chordVoicing(
  baseMidi: number | null,
  quality: ChordQuality,
): ReadonlyArray<VoicingLane> {
  const empty: VoicingLane = { midi: null, gate: 0 };
  if (baseMidi === null || !Number.isFinite(baseMidi)) {
    return [empty, empty, empty, empty, empty];
  }
  const root = Math.round(baseMidi);
  const rootInRange = root >= MIN_MIDI && root <= MAX_MIDI;
  if (!rootInRange) {
    // Out-of-range root: nothing plays. Defensive — note-entry already clamps.
    return [empty, empty, empty, empty, empty];
  }

  if (quality === 'mono') {
    return [
      { midi: root, gate: 1 },
      empty,
      empty,
      empty,
      empty,
    ];
  }

  const thirdSemis = quality === 'maj' ? 4 : 3;
  const fifthSemis = 7;
  const octaveSemis = 12;

  function laneFor(offset: number): VoicingLane {
    const m = root + offset;
    if (m < MIN_MIDI || m > MAX_MIDI) return empty;
    return { midi: m, gate: 1 };
  }

  return [
    { midi: root, gate: 1 },
    laneFor(thirdSemis),
    laneFor(fifthSemis),
    laneFor(octaveSemis),
    empty,
  ];
}

/** Convert a voicing's MIDI ints to V/oct (0V = C4 = MIDI 60). Lanes whose
 *  gate is 0 emit pitch=0 (the param's default value); doesn't matter
 *  audibly because gate is closed. */
export function voicingToVOct(
  voicing: ReadonlyArray<VoicingLane>,
): ReadonlyArray<{ pitch: number; gate: 0 | 1 }> {
  return voicing.map((v) =>
    v.gate === 1 && v.midi !== null
      ? { pitch: midiToVOct(v.midi), gate: 1 as const }
      : { pitch: 0, gate: 0 as const },
  );
}

// ---------------- Sender (one polyPitchGate output port) ----------------

export interface PolyVoiceSlot {
  pitchSrc: ConstantSourceNode;
  gateSrc: ConstantSourceNode;
}

export interface PolySender {
  /** The 10-channel ChannelMergerNode. Use this as the source AudioNode in
   *  the engine's outputs map for the poly output port. */
  output: ChannelMergerNode;
  /** Per-lane ConstantSource handles. Lane i's pitch = voices[i].pitchSrc.offset,
   *  gate = voices[i].gateSrc.offset. Both AudioParams; setValueAtTime works. */
  voices: ReadonlyArray<PolyVoiceSlot>;
  /** Convenience: schedule one chord step's lanes at audio time `at`.
   *  Pass POLY_CHANNEL_PAIRS entries (typically the result of voicingToVOct()).
   *  `gateOffSec` (>0) schedules a gate-down event at `at + gateOffSec`; pass
   *  0 to leave the gates high indefinitely (e.g. for sustained tests). */
  scheduleStep(
    at: number,
    lanes: ReadonlyArray<{ pitch: number; gate: 0 | 1 }>,
    gateOffSec: number,
  ): void;
  /** Force every lane's gate to 0 immediately (cancels future gate events). */
  silence(now: number): void;
  /** Tear down. Stops the constant sources and disconnects the merger. */
  dispose(): void;
}

export function createPolySender(ctx: BaseAudioContext): PolySender {
  const merger = ctx.createChannelMerger(POLY_CHANNELS);
  // ChannelMergerNode forces channelCount=1 per input + interpretation 'speakers'
  // by default. We want each input to land on its own output channel without
  // upmixing. The defaults already do this for createChannelMerger(N).
  const voices: PolyVoiceSlot[] = [];
  for (let i = 0; i < POLY_CHANNEL_PAIRS; i++) {
    const pitchSrc = ctx.createConstantSource();
    const gateSrc = ctx.createConstantSource();
    pitchSrc.offset.value = 0;
    gateSrc.offset.value = 0;
    pitchSrc.start();
    gateSrc.start();
    pitchSrc.connect(merger, 0, i * 2);
    gateSrc.connect(merger, 0, i * 2 + 1);
    voices.push({ pitchSrc, gateSrc });
  }

  function scheduleStep(
    at: number,
    lanes: ReadonlyArray<{ pitch: number; gate: 0 | 1 }>,
    gateOffSec: number,
  ): void {
    for (let i = 0; i < POLY_CHANNEL_PAIRS; i++) {
      const v = voices[i]!;
      const lane = lanes[i] ?? { pitch: 0, gate: 0 as const };
      v.pitchSrc.offset.setValueAtTime(lane.pitch, at);
      v.gateSrc.offset.setValueAtTime(lane.gate, at);
      if (lane.gate === 1 && gateOffSec > 0) {
        v.gateSrc.offset.setValueAtTime(0, at + gateOffSec);
      }
    }
  }

  function silence(now: number): void {
    for (const v of voices) {
      v.gateSrc.offset.cancelScheduledValues(now);
      v.gateSrc.offset.setValueAtTime(0, now);
    }
  }

  function dispose(): void {
    for (const v of voices) {
      try { v.pitchSrc.stop(); } catch { /* already stopped */ }
      try { v.gateSrc.stop(); } catch { /* already stopped */ }
      try { v.pitchSrc.disconnect(); } catch { /* */ }
      try { v.gateSrc.disconnect(); } catch { /* */ }
    }
    try { merger.disconnect(); } catch { /* */ }
  }

  return { output: merger, voices, scheduleStep, silence, dispose };
}

// ---------------- Receiver (one polyPitchGate input port) ----------------

export interface PolyReceiver {
  /** The 10-channel ChannelSplitterNode. Use this as the input AudioNode in
   *  the engine's inputs map for the poly input port. */
  input: ChannelSplitterNode;
  /** Splitter outputs at the per-lane channels. Use these to wire individual
   *  lanes into AudioParams or downstream nodes (via standard
   *  splitter.connect(target, output) calls). */
  laneOutput(lane: Lane, kind: 'pitch' | 'gate'): { node: AudioNode; output: number };
  dispose(): void;
}

/** A receiver helper for a downstream module that wants per-lane signals.
 *  Stage 1 doesn't materialize any of these (only the sequencers emit poly,
 *  and they emit; no module receives poly natively yet). Stage 2 (DX7) will. */
export function createPolyReceiver(ctx: BaseAudioContext): PolyReceiver {
  const splitter = ctx.createChannelSplitter(POLY_CHANNELS);
  return {
    input: splitter,
    laneOutput(lane, kind) {
      const ch = lane * 2 + (kind === 'gate' ? 1 : 0);
      return { node: splitter, output: ch };
    },
    dispose() {
      try { splitter.disconnect(); } catch { /* */ }
    },
  };
}

// ---------------- Backward-compat resolver (pure planning) ----------------

/**
 * One step of a connection plan — describes a single .connect() that the
 * engine should perform. `srcChannel` is the channel index to pull off the
 * source's output node (for splitters); `dstChannel` is which input on the
 * destination to feed (for mergers / multi-input nodes). For AudioParam
 * targets, `dstChannel` is unused.
 *
 * The engine performs:
 *   srcNode.connect(dstNode, srcChannel, dstChannel)
 *   OR
 *   srcNode.connect(audioParam, srcChannel)
 */
export interface ConnectStep {
  srcChannel: number;
  /** Set when the destination is an AudioParam (CV → AudioParam routing). */
  paramTarget: boolean;
  /** Used only when paramTarget is false. */
  dstChannel: number;
}

export interface ResolvedConnection {
  /** Whether the engine needs an interposed splitter node between source and
   *  destination. Set when the source is a multi-channel polyPitchGate and
   *  the destination wants only specific channels. */
  needSplitter: boolean;
  /** Whether the engine needs an interposed merger between source and
   *  destination (mono source → polyPitchGate destination). */
  needMerger: boolean;
  /** Whether the engine needs an interposed gate-summing pseudo-OR node
   *  (polyPitchGate → mono gate; we sum the 5 gate channels with a
   *  ChannelMergerNode of channelCount=1, channelCountMode='explicit',
   *  channelInterpretation='discrete' — which mixes them down to mono). */
  needGateSum: boolean;
  /** When needSplitter is true, the channels (in source-side numbering) to
   *  route from the splitter to the destination. */
  splitChannels: ReadonlyArray<number>;
  /** When needMerger is true, the merger inputs the source should drive. */
  mergeInputs: ReadonlyArray<number>;
  /** Note: a string explanation of the chosen route, useful for logs. */
  rule: string;
}

/**
 * Pure function: given a source/target cable type pair, return the
 * connection plan the engine must execute. Doesn't touch Web Audio.
 *
 * Rules (per §5a of the plan + Stage-1 user adjustments):
 *
 *   polyPitchGate → polyPitchGate  : direct merger→splitter (10ch passthrough).
 *   polyPitchGate → pitch          : pull lane-0 pitch (channel 0).
 *   polyPitchGate → gate           : sum lanes' gate channels (1,3,5,7,9).
 *   pitch         → polyPitchGate  : drive lane-0 pitch (merger input 0); other lanes silent.
 *   gate          → polyPitchGate  : drive lane-0 gate  (merger input 1); other lanes silent.
 *   audio/cv ↔ polyPitchGate       : same shape as pitch/gate above. Treat
 *                                    audio/cv as "drive lane-0 pitch" by
 *                                    default — Stage 1 doesn't expose any
 *                                    such patches but this keeps the resolver
 *                                    total.
 *   anything else                  : direct connect (existing behavior).
 */
export function resolveConnection(
  sourceType: string,
  targetType: string,
): ResolvedConnection {
  const isSrcPoly = sourceType === 'polyPitchGate';
  const isDstPoly = targetType === 'polyPitchGate';

  if (isSrcPoly && isDstPoly) {
    return {
      needSplitter: false,
      needMerger: false,
      needGateSum: false,
      splitChannels: [],
      mergeInputs: [],
      rule: 'poly→poly: direct 10ch connect',
    };
  }

  if (isSrcPoly && !isDstPoly) {
    if (targetType === 'pitch' || targetType === 'cv' || targetType === 'audio') {
      // Pull lane 0 pitch.
      return {
        needSplitter: true,
        needMerger: false,
        needGateSum: false,
        splitChannels: [0],
        mergeInputs: [],
        rule: 'poly→mono pitch/cv/audio: route lane 0 pitch (channel 0)',
      };
    }
    if (targetType === 'gate') {
      // Sum lane gate channels (1, 3, 5, 7, 9). Web Audio's connection summing
      // adds them — since each lane gate is 0 or 1, sum ∈ [0, 5]; downstream
      // gate consumers threshold at 0.5 so this is OR semantics in practice.
      const gateChannels: number[] = [];
      for (let i = 0; i < POLY_CHANNEL_PAIRS; i++) gateChannels.push(i * 2 + 1);
      return {
        needSplitter: true,
        needMerger: false,
        needGateSum: true,
        splitChannels: gateChannels,
        mergeInputs: [],
        rule: 'poly→mono gate: OR-sum of all lane gate channels',
      };
    }
    // Unknown target — default: lane 0 pitch.
    return {
      needSplitter: true,
      needMerger: false,
      needGateSum: false,
      splitChannels: [0],
      mergeInputs: [],
      rule: `poly→${targetType} (unknown): default to lane 0 pitch`,
    };
  }

  if (!isSrcPoly && isDstPoly) {
    if (sourceType === 'pitch' || sourceType === 'cv' || sourceType === 'audio') {
      // Drive lane 0 pitch only. Other lanes' inputs see no source → silent.
      return {
        needSplitter: false,
        needMerger: true,
        needGateSum: false,
        splitChannels: [],
        mergeInputs: [0],
        rule: 'mono pitch/cv/audio→poly: drive lane 0 pitch (merger input 0)',
      };
    }
    if (sourceType === 'gate') {
      // Drive lane 0 gate only.
      return {
        needSplitter: false,
        needMerger: true,
        needGateSum: false,
        splitChannels: [],
        mergeInputs: [1],
        rule: 'mono gate→poly: drive lane 0 gate (merger input 1)',
      };
    }
    return {
      needSplitter: false,
      needMerger: true,
      needGateSum: false,
      splitChannels: [],
      mergeInputs: [0],
      rule: `${sourceType}→poly (unknown): default to lane 0 pitch`,
    };
  }

  // Both mono: direct.
  return {
    needSplitter: false,
    needMerger: false,
    needGateSum: false,
    splitChannels: [],
    mergeInputs: [],
    rule: 'direct mono connect',
  };
}
