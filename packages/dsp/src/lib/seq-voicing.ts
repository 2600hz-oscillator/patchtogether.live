// packages/dsp/src/lib/seq-voicing.ts
//
// SEQ VOICING — the sequencer's mono/maj/min chord voicing, ported pure into the
// DSP package so the seq-clock AudioWorklet core can emit the SAME poly lanes
// the main-thread sequencer does (clock-worklet-scheduler plan, PR-B).
//
// SOURCE OF TRUTH: packages/web/src/lib/audio/poly.ts (`chordVoicing` +
// `voicingToVOct`) + note-entry.ts (`midiToVOct`, MIN/MAX_MIDI). That code can't
// be imported here — packages/dsp has no dependency on packages/web — so this is
// a faithful copy of the dependency-free math. It is tiny + stable (a triad is a
// triad); seq-voicing.test.ts pins the exact lane output so a drift from the web
// definition is caught. Keep the two in sync if poly.ts's voicing ever changes.
//
// Layout matches poly.ts: 5 lanes, lane 0 = root. maj/min = [root, third, fifth,
// root+oct, —]; mono = [root, —, —, —, —]. Lanes out of MIDI range, or surplus to
// the chord, are silent (gate 0). 0 V/oct = C4 = MIDI 60; +1 V per octave.

/** Voice lanes the sequencer's pitch (polyPitchGate) cable carries. */
export const SEQ_POLY_LANES = 5;

/** Playable MIDI range (note-entry.ts MIN_MIDI/MAX_MIDI). */
export const SEQ_MIN_MIDI = 12; // C0
export const SEQ_MAX_MIDI = 108; // C8

/** MIDI note that maps to 0 V/oct (C4). */
export const SEQ_C4_MIDI = 60;

/** The sequencer's chord qualities (poly.ts ChordQuality). */
export type SeqChordQuality = 'mono' | 'maj' | 'min';

/** A resolved voice lane in V/oct (what the worklet emits per lane). */
export interface VoiceLaneVOct {
  pitch: number; // V/oct (only meaningful when gate === 1)
  gate: 0 | 1;
}

/** MIDI int → V/oct (1 V per octave; C4=60 ⇒ 0 V). Mirrors note-entry midiToVOct. */
export function midiToVOct(midi: number): number {
  return (midi - SEQ_C4_MIDI) / 12;
}

const SILENT: VoiceLaneVOct = { pitch: 0, gate: 0 };

/**
 * Resolve a chord step to its 5 V/oct voice lanes, with the octave param folded
 * in (added to every GATED lane, in V/oct = whole octaves) — exactly the
 * sequencer's `voicingToVOct(chordVoicing(base, quality)).map(+octave)` pipeline.
 *
 * `baseMidi` null / out-of-range / a rest ⇒ all lanes silent.
 */
export function chordLanesVOct(
  baseMidi: number | null,
  quality: SeqChordQuality,
  octaveVOct: number,
): VoiceLaneVOct[] {
  if (baseMidi === null || !Number.isFinite(baseMidi)) {
    return [{ ...SILENT }, { ...SILENT }, { ...SILENT }, { ...SILENT }, { ...SILENT }];
  }
  const root = Math.round(baseMidi);
  if (root < SEQ_MIN_MIDI || root > SEQ_MAX_MIDI) {
    return [{ ...SILENT }, { ...SILENT }, { ...SILENT }, { ...SILENT }, { ...SILENT }];
  }

  // Build the MIDI voicing (poly.ts chordVoicing), then convert each gated lane
  // to V/oct + octave. A lane whose MIDI falls outside the range is silent.
  const laneVOct = (offset: number): VoiceLaneVOct => {
    const m = root + offset;
    if (m < SEQ_MIN_MIDI || m > SEQ_MAX_MIDI) return { ...SILENT };
    return { pitch: midiToVOct(m) + octaveVOct, gate: 1 };
  };

  if (quality === 'mono') {
    return [laneVOct(0), { ...SILENT }, { ...SILENT }, { ...SILENT }, { ...SILENT }];
  }

  const third = quality === 'maj' ? 4 : 3;
  return [laneVOct(0), laneVOct(third), laneVOct(7), laneVOct(12), { ...SILENT }];
}
