// packages/dsp/src/lib/helm-engine.test.ts
//
// Unit tests for the shared HELM engine (packages/dsp/src/lib/helm-engine.ts)
// as used by POLYHELM. The engine is pure JS (no AudioWorkletGlobalScope) so we
// drive it directly: feed poly-lane / mono-CV / MIDI note events, render blocks,
// and assert the voice allocator + render math.
//
// Coverage (the POLYHELM correctness bar):
//   - poly → N voices: gating N lanes activates N voices.
//   - chord ≠ single note: a 3-lane chord has energy at 3 fundamentals; a
//     single note has energy at one (Goertzel probes).
//   - mono path unchanged: the mono pitch_cv/gate fallback drives one voice.
//   - RELEASE HOLDS PITCH: a released poly voice's ADSR tail sounds at the
//     PLAYED pitch (held on the voice), not C4 — the cube release-tail bug must
//     NOT exist here. Proven by measuring the release tail's fundamental.

import { describe, it, expect } from 'vitest';
import {
  HelmEngine,
  EnvState,
  C4_HZ,
  type HelmParams,
} from './helm-engine';

const SR = 48000;

/** Default-ish param block (matches helmParameterDescriptors defaults), with a
 *  long sustain + slow release so a held / released voice stays audible. */
function params(over: Partial<HelmParams> = {}): HelmParams {
  return {
    voiceCount: 8,
    volume: 0.7,
    osc1Wave: 0, osc1Trans: 0, osc1Tune: 0, osc1Unison: 1, osc1Detune: 10, osc1Vol: 0.8,
    osc2Wave: 1, osc2Trans: 0, osc2Tune: 0, osc2Unison: 1, osc2Detune: 10, osc2Vol: 0.0,
    subWave: 3, subVol: 0.0,
    noiseVol: 0.0,
    filterCutoff: 18000, filterRes: 0.7, filterBlend: 0, filterStyle: 0, filterDrive: 1, filterKeyTrack: 0,
    ampAttack: 0.002, ampDecay: 0.05, ampSustain: 1.0, ampRelease: 1.0,
    filAttack: 0.002, filDecay: 0.05, filSustain: 1.0, filRelease: 0.3, filEnvDepth: 0,
    modAttack: 0.002, modDecay: 0.05, modSustain: 0, modRelease: 0.3, modEnvDepth: 0,
    lfo1Wave: 3, lfo1Freq: 1, lfo1Amp: 0,
    lfo2Wave: 3, lfo2Freq: 4, lfo2Amp: 0,
    stepNumSteps: 8, stepSmooth: 0, stepDepth: 0,
    spread: 0,
    ...over,
  };
}

/** MIDI note → V/oct (0V = C4 = MIDI 60). */
function midiToVOct(m: number): number {
  return (m - 60) / 12;
}
function midiToHz(m: number): number {
  return C4_HZ * Math.pow(2, (m - 60) / 12);
}

/** Build a 10-channel poly-bus block input: one Float32Array per channel, each
 *  filled with the per-lane pitch/gate constant (block-rate). */
function polyBlock(lanes: Array<{ pitch: number; gate: number }>, blockLen: number): Float32Array[] {
  const chans: Float32Array[] = [];
  for (let lane = 0; lane < 5; lane++) {
    const l = lanes[lane] ?? { pitch: 0, gate: 0 };
    const pitchCh = new Float32Array(blockLen).fill(l.pitch);
    const gateCh = new Float32Array(blockLen).fill(l.gate);
    chans.push(pitchCh, gateCh);
  }
  return chans;
}

/** Drive the poly bus directly (mirrors polyhelm.ts's per-lane edge logic) and
 *  render `seconds` of mono-summed audio. Returns the rendered Float32Array. */
function renderPoly(
  engine: HelmEngine,
  p: HelmParams,
  lanes: Array<{ pitch: number; gate: number }>,
  seconds: number,
  blockLen = 128,
): Float32Array {
  const total = Math.floor((SR * seconds) / blockLen) * blockLen;
  const out = new Float32Array(total);
  const prev = new Float32Array(5);
  for (let off = 0; off < total; off += blockLen) {
    // Per-lane edge detection (the polyhelm worklet's logic).
    for (let lane = 0; lane < 5; lane++) {
      const l = lanes[lane] ?? { pitch: 0, gate: 0 };
      const was = prev[lane]! > 0.5;
      const is = l.gate > 0.5;
      const midi = Math.round(60 + l.pitch * 12);
      if (is && !was) engine.noteOnLane(lane, midi, 1.0);
      else if (!is && was) engine.noteOffLane(lane);
      else if (is) engine.updateLanePitch(lane, midi);
      prev[lane] = l.gate;
    }
    engine.tickSequencerEdges(false, false, p.stepNumSteps);
    const outL = new Float32Array(blockLen);
    const outR = new Float32Array(blockLen);
    engine.renderBlock(outL, outR, p, SR);
    out.set(outL, off);
  }
  return out;
}

/** Goertzel single-bin magnitude at `freq`. */
function goertzel(buf: Float32Array, freq: number, sr: number): number {
  const w = (2 * Math.PI * freq) / sr;
  const cw = Math.cos(w);
  const coeff = 2 * cw;
  let s0 = 0, s1 = 0, s2 = 0;
  for (let i = 0; i < buf.length; i++) {
    s0 = buf[i]! + coeff * s1 - s2;
    s2 = s1;
    s1 = s0;
  }
  return Math.sqrt(s1 * s1 + s2 * s2 - coeff * s1 * s2) / buf.length;
}

function rms(buf: Float32Array): number {
  let s = 0;
  for (let i = 0; i < buf.length; i++) s += buf[i]! * buf[i]!;
  return Math.sqrt(s / buf.length);
}

function countActiveVoices(engine: HelmEngine): number {
  return engine.voices.filter((v) => v.active).length;
}

// ----------------------------------------------------------------------------

describe('HelmEngine / poly bus → voice allocator', () => {
  it('gating N lanes activates N voices (1, 3, 5)', () => {
    for (const n of [1, 3, 5]) {
      const engine = new HelmEngine();
      const lanes = Array.from({ length: 5 }, (_, lane) =>
        lane < n ? { pitch: midiToVOct(60 + lane * 4), gate: 1 } : { pitch: 0, gate: 0 },
      );
      // One block to process the rising edges.
      renderPoly(engine, params(), lanes, 0.01);
      expect(countActiveVoices(engine), `${n} gated lanes → ${n} voices`).toBe(n);
      // Each active voice owned by a distinct lane 0..n-1.
      const owners = engine.voices.filter((v) => v.active).map((v) => v.laneOwner).sort();
      expect(owners).toEqual(Array.from({ length: n }, (_, i) => i));
    }
  });

  it('a 3-note chord has spectral energy at all 3 fundamentals; a single note has one peak', () => {
    // C major triad: C4(60), E4(64), G4(67).
    const chordMidis = [60, 64, 67];
    const chordEngine = new HelmEngine();
    const chordLanes = chordMidis.map((m) => ({ pitch: midiToVOct(m), gate: 1 }));
    while (chordLanes.length < 5) chordLanes.push({ pitch: 0, gate: 0 });
    const chord = renderPoly(chordEngine, params(), chordLanes, 0.4);

    for (const m of chordMidis) {
      const f = midiToHz(m);
      const peak = goertzel(chord, f, SR);
      const noise = Math.max(goertzel(chord, f + 90, SR), goertzel(chord, Math.max(20, f - 90), SR), 1e-9);
      expect(peak / noise, `chord peak at ${f.toFixed(1)}Hz (${m})`).toBeGreaterThan(3);
    }

    // Single note C4 only: strong peak at C4, but NOT at E4/G4.
    const singleEngine = new HelmEngine();
    const singleLanes = [{ pitch: midiToVOct(60), gate: 1 }, ...Array(4).fill({ pitch: 0, gate: 0 })];
    const single = renderPoly(singleEngine, params(), singleLanes, 0.4);
    const c4 = goertzel(single, midiToHz(60), SR);
    const e4 = goertzel(single, midiToHz(64), SR);
    const g4 = goertzel(single, midiToHz(67), SR);
    expect(c4, 'single note has C4 energy').toBeGreaterThan(1e-4);
    // The triad's 3rd/5th are clearly present in the chord but absent (relative
    // to the fundamental) in the single note → chord ≠ single note.
    expect(c4 / Math.max(e4, g4, 1e-9), 'single note: fundamental dominates the chord tones').toBeGreaterThan(8);
  });

  it('chord RMS clearly exceeds a single voice (multiple voices sum)', () => {
    const single = renderPoly(new HelmEngine(), params(),
      [{ pitch: midiToVOct(60), gate: 1 }, ...Array(4).fill({ pitch: 0, gate: 0 })], 0.3);
    const chord = renderPoly(new HelmEngine(), params(),
      [60, 64, 67].map((m) => ({ pitch: midiToVOct(m), gate: 1 })).concat(Array(2).fill({ pitch: 0, gate: 0 })), 0.3);
    expect(rms(chord)).toBeGreaterThan(rms(single) * 1.3);
  });
});

describe('HelmEngine / mono CV/gate fallback path (unchanged HELM behavior)', () => {
  it('a mono gate rising edge triggers exactly one voice (laneOwner = -1)', () => {
    const engine = new HelmEngine();
    const p = params();
    const blockLen = 128;
    // Block 1: gate high at pitch C4.
    engine.handleNoteOn(60, 100, 0);
    engine.tickSequencerEdges(true, false, p.stepNumSteps);
    engine.renderBlock(new Float32Array(blockLen), new Float32Array(blockLen), p, SR);
    expect(countActiveVoices(engine)).toBe(1);
    const v = engine.voices.find((x) => x.active)!;
    expect(v.laneOwner, 'mono/MIDI path uses non-lane slot').toBe(-1);
    expect(v.midi).toBe(60);
  });

  it('the mono path produces audible C4 energy', () => {
    const engine = new HelmEngine();
    const p = params();
    const blockLen = 128;
    engine.handleNoteOn(60, 100, 0);
    const total = Math.floor((SR * 0.3) / blockLen) * blockLen;
    const out = new Float32Array(total);
    for (let off = 0; off < total; off += blockLen) {
      engine.tickSequencerEdges(true, false, p.stepNumSteps);
      const outL = new Float32Array(blockLen);
      engine.renderBlock(outL, new Float32Array(blockLen), p, SR);
      out.set(outL, off);
    }
    const peak = goertzel(out, midiToHz(60), SR);
    expect(peak).toBeGreaterThan(1e-4);
  });

  it('MIDI + poly bus coexist (separate allocator slots)', () => {
    const engine = new HelmEngine();
    const p = params();
    // MIDI note (laneOwner -1) + a poly lane note.
    engine.handleNoteOn(72, 100, 0);
    engine.noteOnLane(0, 60, 1.0);
    engine.tickSequencerEdges(false, false, p.stepNumSteps);
    engine.renderBlock(new Float32Array(128), new Float32Array(128), p, SR);
    expect(countActiveVoices(engine)).toBe(2);
    const owners = engine.voices.filter((v) => v.active).map((v) => v.laneOwner).sort((a, b) => a - b);
    expect(owners).toEqual([-1, 0]);
  });
});

describe('HelmEngine / RELEASE HOLDS PITCH (no cube release-tail C4 bug)', () => {
  // A released poly voice keeps SOUNDING while its envelope decays; its
  // fundamental must stay at the PLAYED pitch, not snap to C4 (= 0 V/oct). The
  // pitch lives on the persistent voice (v.midi), which note-off never resets —
  // so this is correct by construction (the DX7 pattern, not the cube gated-
  // cache bug). These tests prove it for lane 0 (single note) AND a higher lane.

  /** Render the RELEASE TAIL only: gate the lane, hold to sustain, then release
   *  and render `tailSeconds` of the decaying tail; return that tail audio.
   *
   *  Drives the engine in ONE continuous block loop (persistent gate-edge
   *  state) so the gate's falling edge is detected — the polyhelm worklet keeps
   *  laneGatePrev across blocks the same way. */
  function releaseTail(lane: number, midi: number, holdSeconds = 0.15, tailSeconds = 0.25): Float32Array {
    const engine = new HelmEngine();
    // Long release so the tail is clearly audible + measurable.
    const p = params({ ampAttack: 0.001, ampDecay: 0.01, ampSustain: 1.0, ampRelease: 2.0 });
    const blockLen = 128;
    const prev = new Float32Array(5);
    let heldChecked = false;

    function step(gate: number): Float32Array {
      const was = prev[lane]! > 0.5;
      const is = gate > 0.5;
      const m = midi;
      if (is && !was) engine.noteOnLane(lane, m, 1.0);
      else if (!is && was) engine.noteOffLane(lane);
      else if (is) engine.updateLanePitch(lane, m);
      prev[lane] = gate;
      engine.tickSequencerEdges(false, false, p.stepNumSteps);
      const outL = new Float32Array(blockLen);
      engine.renderBlock(outL, new Float32Array(blockLen), p, SR);
      return outL;
    }

    // Phase 1: hold the gate to reach sustain.
    const holdBlocks = Math.floor((SR * holdSeconds) / blockLen);
    for (let i = 0; i < holdBlocks; i++) {
      step(1);
      if (!heldChecked) {
        const hv = engine.voices.find((v) => v.active && v.laneOwner === lane);
        if (hv) { expect(hv.midi, 'gated voice holds the played MIDI').toBe(midi); heldChecked = true; }
      }
    }

    // Phase 2: release (gate → 0) + collect the decaying tail.
    const tailBlocks = Math.floor((SR * tailSeconds) / blockLen);
    const tail = new Float32Array(tailBlocks * blockLen);
    for (let i = 0; i < tailBlocks; i++) {
      const out = step(0);
      tail.set(out, i * blockLen);
    }

    // The voice must STILL be active (releasing) and STILL hold the played
    // pitch — note-off only set Release, never reset v.midi.
    const rv = engine.voices.find((v) => v.laneOwner === lane && v.active);
    expect(rv, 'voice still releasing (audible tail)').toBeTruthy();
    expect(rv!.ampEnv.state, 'voice is in Release').toBe(EnvState.Release);
    expect(rv!.midi, 'release tail keeps the PLAYED pitch (not C4)').toBe(midi);
    return tail;
  }

  it('lane 0 (single note): release tail sounds at the PLAYED pitch, not C4', () => {
    // Play C5 (72 = +1 octave). The tail must ring at ~523 Hz (C5), NOT 261 (C4).
    const tail = releaseTail(0, 72);
    const peakAtPlayed = goertzel(tail, midiToHz(72), SR);
    const peakAtC4 = goertzel(tail, C4_HZ, SR);
    expect(peakAtPlayed, 'tail has energy at the played pitch C5').toBeGreaterThan(1e-4);
    // The played-pitch peak dominates the C4 (bug) probe by a wide margin.
    expect(peakAtPlayed / Math.max(peakAtC4, 1e-9), 'played-pitch energy ≫ C4 energy').toBeGreaterThan(8);
  });

  it('a higher lane (lane 3): release tail keeps its OWN played pitch (not C4 / lane-0)', () => {
    // Lane 3 plays E5 (76). The tail must ring at E5, not C4.
    const tail = releaseTail(3, 76);
    const peakAtPlayed = goertzel(tail, midiToHz(76), SR);
    const peakAtC4 = goertzel(tail, C4_HZ, SR);
    expect(peakAtPlayed, 'tail has energy at the played pitch E5').toBeGreaterThan(1e-4);
    expect(peakAtPlayed / Math.max(peakAtC4, 1e-9), 'lane-3 played-pitch energy ≫ C4 energy').toBeGreaterThan(8);
  });

  it('a held lane tracks pitch-bend live; release holds the LAST bent pitch', () => {
    const engine = new HelmEngine();
    const p = params({ ampAttack: 0.001, ampSustain: 1.0, ampRelease: 1.0 });
    const blockLen = 128;
    // Gate lane 0 at C4, then bend up to D4 (62) while held.
    engine.noteOnLane(0, 60, 1.0);
    engine.renderBlock(new Float32Array(blockLen), new Float32Array(blockLen), p, SR);
    engine.updateLanePitch(0, 62);
    engine.renderBlock(new Float32Array(blockLen), new Float32Array(blockLen), p, SR);
    const v = engine.voices.find((x) => x.active && x.laneOwner === 0)!;
    expect(v.midi, 'held voice tracked the bend to D4').toBe(62);
    // Release: the bent pitch is held (note-off never resets v.midi).
    engine.noteOffLane(0);
    engine.renderBlock(new Float32Array(blockLen), new Float32Array(blockLen), p, SR);
    const rv = engine.voices.find((x) => x.active && x.laneOwner === 0)!;
    expect(rv.ampEnv.state).toBe(EnvState.Release);
    expect(rv.midi, 'release holds the bent pitch D4').toBe(62);
  });

  it('re-gating a lane retriggers the SAME voice slot (lane ownership)', () => {
    const engine = new HelmEngine();
    const p = params();
    engine.noteOnLane(2, 64, 1.0);
    engine.renderBlock(new Float32Array(128), new Float32Array(128), p, SR);
    const first = engine.voices.find((v) => v.active && v.laneOwner === 2)!;
    // New note on the same lane (without releasing) → reuses the lane's voice.
    engine.noteOnLane(2, 67, 1.0);
    engine.renderBlock(new Float32Array(128), new Float32Array(128), p, SR);
    const ownedByLane2 = engine.voices.filter((v) => v.active && v.laneOwner === 2);
    expect(ownedByLane2.length, 'one voice per lane (retrigger, not double-alloc)').toBe(1);
    expect(ownedByLane2[0], 'same physical voice slot reused').toBe(first);
    expect(ownedByLane2[0]!.midi).toBe(67);
  });
});

describe('HelmEngine / voice lifecycle', () => {
  it('a fully-released voice frees its slot + clears lane ownership', () => {
    const engine = new HelmEngine();
    // Very fast release so the voice idles quickly.
    const p = params({ ampAttack: 0.001, ampDecay: 0.001, ampSustain: 1.0, ampRelease: 0.001 });
    const blockLen = 128;
    engine.noteOnLane(1, 60, 1.0);
    engine.renderBlock(new Float32Array(blockLen), new Float32Array(blockLen), p, SR);
    expect(countActiveVoices(engine)).toBe(1);
    engine.noteOffLane(1);
    // Render enough blocks for the (1 ms) release to fully decay to Idle.
    for (let i = 0; i < 50; i++) {
      engine.renderBlock(new Float32Array(blockLen), new Float32Array(blockLen), p, SR);
    }
    expect(countActiveVoices(engine), 'voice freed after release').toBe(0);
    expect(engine.voices.every((v) => v.laneOwner === -1), 'lane ownership cleared').toBe(true);
  });
});
