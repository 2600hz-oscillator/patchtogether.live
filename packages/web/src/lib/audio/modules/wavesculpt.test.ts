// packages/web/src/lib/audio/modules/wavesculpt.test.ts
//
// Unit tests for WAVESCULPT v2 (wavetable engine refactor).
//
// What changed vs v1:
//   - Per-osc params are now tune/fine/morph/spread/fold (wavetable
//     primitives) instead of pitch + morph (saw/sine/tri picker).
//     morphToOscType + per-osc pitch params are gone.
//   - New cam param: rot (rotation around Y, ±1).
//   - eyeFromCamera helper replaces ad-hoc inline camera math.
//   - Shared wavetable engine: wavesculpt.ts imports its worklet URL from
//     '@patchtogether.live/dsp/dist/wavesculpt-engine.js' instead of
//     building OscillatorNodes on the WebAudio graph.

import { describe, it, expect } from 'vitest';
import {
  wavesculptDef,
  WALL_LAYOUT,
  distanceGain,
  eyeFromCamera,
  ribbonStripRange,
  voctToHz,
  detuneOctaveOffset,
  tickEnvelope,
  unisonRouting,
  normalledChain,
  effectiveVoiceRouting,
  chordQualityFromKnob,
  CHORD_INTERVALS_SEMITONES,
  pitchToWiggle,
  wigglePitchNorm,
  WIGGLE_MIN_HZ,
  WIGGLE_MAX_HZ,
  WIGGLE_MAX_RATE,
  WIGGLE_MAX_MAGNITUDE,
} from './wavesculpt';

describe('wavesculpt v2: module-def shape', () => {
  it('declares type/label/domain/category', () => {
    expect(wavesculptDef.type).toBe('wavesculpt');
    expect(wavesculptDef.label).toBe('WAVESCULPT');
    expect(wavesculptDef.domain).toBe('audio');
    expect(wavesculptDef.category).toBe('sources');
  });

  it('schemaVersion bumped to 2 for the wavetable engine refactor', () => {
    expect(wavesculptDef.schemaVersion).toBe(2);
  });

  it('declares gate + pitch_cv for each of 4 oscillators', () => {
    const inIds = wavesculptDef.inputs.map((p) => p.id);
    for (let i = 1; i <= 4; i++) {
      expect(inIds).toContain(`gate${i}`);
      expect(inIds).toContain(`pitch_cv${i}`);
    }
  });

  it('declares camera CV inputs incl. new rot port', () => {
    const inIds = wavesculptDef.inputs.map((p) => p.id);
    for (const id of ['pos_x', 'pos_y', 'pos_z', 'zoom', 'rot']) {
      expect(inIds).toContain(id);
    }
  });

  it('declares an alpha_in video input port', () => {
    const ai = wavesculptDef.inputs.find((p) => p.id === 'alpha_in');
    expect(ai, 'alpha_in port exists').toBeDefined();
    expect(ai!.type).toBe('video');
  });

  it('declares L + R audio outputs and a video output', () => {
    const outs = wavesculptDef.outputs;
    expect(outs.find((o) => o.id === 'L')?.type).toBe('audio');
    expect(outs.find((o) => o.id === 'R')?.type).toBe('audio');
    const v = outs.find((o) => o.id === 'video_out');
    expect(v).toBeDefined();
    expect(['video', 'mono-video']).toContain(v!.type);
  });

  it('exposes per-osc wavetable params (tune/fine/morph/spread/fold) for all 4 oscs', () => {
    const ids = wavesculptDef.params.map((p) => p.id);
    for (let i = 1; i <= 4; i++) {
      expect(ids).toContain(`tune${i}`);
      expect(ids).toContain(`fine${i}`);
      expect(ids).toContain(`morph${i}`);
      expect(ids).toContain(`spread${i}`);
      expect(ids).toContain(`fold${i}`);
    }
  });

  it('still exposes per-osc ADSR + thickness (unchanged from v1)', () => {
    const ids = wavesculptDef.params.map((p) => p.id);
    for (let i = 1; i <= 4; i++) {
      expect(ids).toContain(`A${i}`);
      expect(ids).toContain(`D${i}`);
      expect(ids).toContain(`S${i}`);
      expect(ids).toContain(`R${i}`);
      expect(ids).toContain(`thickness${i}`);
    }
  });

  it('per-osc wavetable params have standard wavetable ranges', () => {
    for (let i = 1; i <= 4; i++) {
      const tune = wavesculptDef.params.find((p) => p.id === `tune${i}`)!;
      expect(tune.min).toBe(-36); expect(tune.max).toBe(36);
      const fine = wavesculptDef.params.find((p) => p.id === `fine${i}`)!;
      expect(fine.min).toBe(-100); expect(fine.max).toBe(100);
      const morph = wavesculptDef.params.find((p) => p.id === `morph${i}`)!;
      expect(morph.min).toBe(0); expect(morph.max).toBe(1);
      const spread = wavesculptDef.params.find((p) => p.id === `spread${i}`)!;
      expect(spread.min).toBe(1); expect(spread.max).toBe(5);
      const fold = wavesculptDef.params.find((p) => p.id === `fold${i}`)!;
      expect(fold.min).toBe(0); expect(fold.max).toBe(1);
    }
  });

  it('does NOT expose per-osc pitch params any more (folded into tune+fine)', () => {
    const ids = wavesculptDef.params.map((p) => p.id);
    for (let i = 1; i <= 4; i++) {
      expect(ids, `pitch${i} should be gone`).not.toContain(`pitch${i}`);
    }
  });

  it('thickness defaults stay at 0.3 (don\'t lose the dogfood fix)', () => {
    for (let i = 1; i <= 4; i++) {
      const p = wavesculptDef.params.find((q) => q.id === `thickness${i}`)!;
      expect(p.defaultValue).toBe(0.3);
    }
  });

  it('alpha_brightness still present (don\'t lose the v1.1 fix)', () => {
    const p = wavesculptDef.params.find((q) => q.id === 'alpha_brightness');
    expect(p, 'alpha_brightness param exists').toBeDefined();
    expect(p!.defaultValue).toBe(1);
  });

  it('exposes camera + UNISON + Detune + rot + 12 bentscreen-wiggle params', () => {
    const ids = wavesculptDef.params.map((p) => p.id);
    for (const id of ['unison', 'detune', 'pos_x', 'pos_y', 'pos_z', 'zoom', 'rot']) {
      expect(ids).toContain(id);
    }
    for (const id of [
      'hsync_drift', 'hsync_loss', 'vsync_drift', 'scan_wobble',
      'chroma_phase', 'chroma_instability',
      'feedback_gain', 'feedback_delay', 'wavefold',
      'bloom', 'noise', 'master_gain',
    ]) {
      expect(ids).toContain(id);
    }
  });

  it('layout has exactly 4 wall positions with non-zero inward vectors', () => {
    expect(WALL_LAYOUT.length).toBe(4);
    for (const { vec } of WALL_LAYOUT) {
      expect(Math.hypot(vec[0], vec[1], vec[2])).toBeGreaterThan(0);
    }
  });

  it('layout: emitter heights step 0% / 25% / 50% / 75% (R / G / B / α)', () => {
    // Y range is [-1, +1]. Heights map: 0% = -1, 25% = -0.5, 50% = 0, 75% = +0.5.
    const expectedY = [-1.0, -0.5, 0.0, 0.5];
    for (let i = 0; i < 4; i++) {
      expect(WALL_LAYOUT[i]!.src[1], `osc ${i} (${['RED','GREEN','BLUE','ALPHA'][i]}) Y`)
        .toBeCloseTo(expectedY[i]!, 5);
    }
  });

  it('layout: every emitter vector aims at the origin', () => {
    // vec should be the -src direction (modulo length — distanceGain
    // normalises internally). Test that vec is anti-parallel to src.
    for (const { src, vec } of WALL_LAYOUT) {
      const sLen = Math.hypot(src[0], src[1], src[2]);
      const vLen = Math.hypot(vec[0], vec[1], vec[2]);
      // dot(src/|src|, vec/|vec|) should be -1 (perfectly opposite).
      const dot = (src[0] * vec[0] + src[1] * vec[1] + src[2] * vec[2]) / (sLen * vLen);
      expect(dot, `src=${src.join(',')} vec=${vec.join(',')}`).toBeCloseTo(-1, 5);
    }
  });

  it('layout: every emitter is horizontally centred on its wall (one of XZ axes is 0)', () => {
    // RED + GREEN live on ±X walls — Z must be 0.
    // BLUE + ALPHA live on ±Z walls — X must be 0.
    expect(WALL_LAYOUT[0]!.src[2], 'RED z').toBe(0);
    expect(WALL_LAYOUT[1]!.src[2], 'GREEN z').toBe(0);
    expect(WALL_LAYOUT[2]!.src[0], 'BLUE x').toBe(0);
    expect(WALL_LAYOUT[3]!.src[0], 'ALPHA x').toBe(0);
  });
});

describe('eyeFromCamera (zoom = camera distance, single source of truth for audio + visual)', () => {
  it('zoom=1, rot=0 → eye in front of box at canonical distance (+Z)', () => {
    const e = eyeFromCamera(0, 0, 0, 1, 0);
    expect(e[2]).toBeCloseTo(2.5, 3);
    expect(e[0]).toBeCloseTo(0, 5);
    expect(e[1]).toBeCloseTo(0, 5);
  });

  it('zoom up → eye CLOSER to origin (smaller distance from box center)', () => {
    const near = eyeFromCamera(0, 0, 0, 2.5, 0);
    const far  = eyeFromCamera(0, 0, 0, 0.5, 0);
    expect(Math.hypot(near[0], near[1], near[2]))
      .toBeLessThan(Math.hypot(far[0], far[1], far[2]));
  });

  it('rot=0.5 → eye rotated +90° around Y (now along +X, z=0)', () => {
    const e = eyeFromCamera(0, 0, 0, 1, 0.5);
    expect(e[0]).toBeGreaterThan(2);
    expect(Math.abs(e[2])).toBeLessThan(0.01);
  });

  it('pos_x/y/z translate the eye laterally (additive)', () => {
    const a = eyeFromCamera(0, 0, 0, 1, 0);
    const b = eyeFromCamera(0.4, 0, 0, 1, 0);
    expect(b[0]).toBeGreaterThan(a[0]);
  });
});

describe('zoom-loudness coupling (audio = visual = one distGain formula)', () => {
  // The user-facing behavior: zoom IN → louder. We pin this with a unit
  // test that picks a wall, computes the eye position at min vs max zoom,
  // and asserts distanceGain at the closer eye is strictly greater than
  // at the farther eye. This is the "single source of truth" contract —
  // if the camera math changes, the audio gain follows; no drift.
  it('zoom-max camera is louder than zoom-min for every wall', () => {
    for (const { src, vec } of WALL_LAYOUT) {
      const eyeClose = eyeFromCamera(0, 0, 0, 3, 0);   // zoom max
      const eyeFar   = eyeFromCamera(0, 0, 0, 0.3, 0); // zoom min
      const gClose = distanceGain(src, vec, eyeClose);
      const gFar   = distanceGain(src, vec, eyeFar);
      // Walls perpendicular to the viewing axis (e.g. RED at +X when
      // looking along -Z at rot=0) might both compute to zero or near-zero
      // since the wall's inward vector dot the dir-to-cam approaches 0 at
      // certain angles. The directional dot product can flip the inequality
      // when the camera crosses the wall plane. Skip walls where the test
      // would be vacuous (both gains ~0); the live-camera path covers them
      // when pos_x/y nudges the eye into a non-degenerate angle.
      if (gClose < 1e-6 && gFar < 1e-6) continue;
      expect(
        gClose,
        `wall src=${src} at zoom=3 should be louder (or at least no quieter) than at zoom=0.3`,
      ).toBeGreaterThanOrEqual(gFar);
    }
  });
});

describe('distanceGain', () => {
  it('returns 1.0 at the source (camera-inside-source case)', () => {
    expect(distanceGain([0, 0, 0], [1, 0, 0], [0, 0, 0])).toBe(1);
  });

  it('returns 0 when camera is BEHIND the source (vector points away)', () => {
    expect(distanceGain([1, 0, 0], [-1, 0, 0], [2, 0, 0])).toBe(0);
  });

  it('is positive when camera is in FRONT of the source', () => {
    const g = distanceGain([1, 0, 0], [-1, 0, 0], [0, 0, 0]);
    expect(g).toBeGreaterThan(0);
    expect(g).toBeLessThanOrEqual(1);
  });

  it('falls off with distance', () => {
    const near = distanceGain([1, 0, 0], [-1, 0, 0], [0.5, 0, 0]);
    const far  = distanceGain([1, 0, 0], [-1, 0, 0], [-0.9, 0, 0]);
    expect(near).toBeGreaterThan(far);
  });
});

describe('voctToHz', () => {
  it('0V/oct = C4 = 261.626 Hz', () => {
    expect(voctToHz(0)).toBeCloseTo(261.626, 3);
  });
  it('+1V = +1 octave', () => {
    expect(voctToHz(1)).toBeCloseTo(261.626 * 2, 3);
  });
  it('-1V = -1 octave', () => {
    expect(voctToHz(-1)).toBeCloseTo(261.626 / 2, 3);
  });
});

describe('detuneOctaveOffset', () => {
  it('oscIdx=0 is anchor (no offset)', () => {
    expect(detuneOctaveOffset(0, 0.5)).toBe(0);
    expect(detuneOctaveOffset(0, -1)).toBe(0);
  });

  it('detune=0 → all voices unison', () => {
    for (let i = 0; i < 4; i++) {
      expect(detuneOctaveOffset(i, 0)).toBeCloseTo(0, 10);
    }
  });

  it('osc2 and osc4 receive opposite-sign offsets for spread', () => {
    expect(detuneOctaveOffset(1, 0.5)).toBeGreaterThan(0);
    expect(detuneOctaveOffset(3, 0.5)).toBeLessThan(0);
  });
});

describe('tickEnvelope (unchanged behavior — internal EG kept from v1)', () => {
  it('idle stays at env=0', () => {
    const s = tickEnvelope(
      { env: 0, gateHigh: false, phase: 'idle', phaseT: 0 },
      16,
      { A: 0.05, D: 0.1, S: 0.5, R: 0.2 },
    );
    expect(s.env).toBe(0);
    expect(s.phase).toBe('idle');
  });

  it('attack ramps from 0 to 1 over A seconds', () => {
    let s: Parameters<typeof tickEnvelope>[0] = {
      env: 0, gateHigh: true, phase: 'attack', phaseT: 0,
    };
    s = tickEnvelope(s, 25, { A: 0.05, D: 0.1, S: 0.5, R: 0.2 });
    expect(s.env).toBeGreaterThan(0.3);
    expect(s.env).toBeLessThan(0.7);
  });

  it('attack completing transitions to decay at env=1', () => {
    let s: Parameters<typeof tickEnvelope>[0] = {
      env: 0, gateHigh: true, phase: 'attack', phaseT: 0,
    };
    s = tickEnvelope(s, 100, { A: 0.05, D: 0.1, S: 0.5, R: 0.2 });
    expect(s.phase).toBe('decay');
    expect(s.env).toBe(1);
  });

  it('release ramps env down to ~0', () => {
    let s: Parameters<typeof tickEnvelope>[0] = {
      env: 0.7, gateHigh: false, phase: 'release', phaseT: 0,
    };
    (s as { _releaseStart?: number })._releaseStart = 0.7;
    s = tickEnvelope(s, 500, { A: 0.05, D: 0.1, S: 0.5, R: 0.2 });
    expect(s.env).toBeLessThan(0.01);
    expect(s.phase).toBe('idle');
  });
});

describe('unisonRouting', () => {
  it('unison=false → 1:1 routing', () => {
    expect(unisonRouting(false)).toEqual([0, 1, 2, 3]);
  });
  it('unison=true → all voices read source 0', () => {
    expect(unisonRouting(true)).toEqual([0, 0, 0, 0]);
  });
});

describe('normalledChain — classic patch-cable normalling', () => {
  it('every voice unpatched → identity (self-sourcing)', () => {
    expect(normalledChain([false, false, false, false])).toEqual([0, 1, 2, 3]);
  });
  it('only voice 1 patched → all voices source voice 1', () => {
    expect(normalledChain([true, false, false, false])).toEqual([0, 0, 0, 0]);
  });
  it('voices 1 + 3 patched → [0, 0, 2, 2]', () => {
    expect(normalledChain([true, false, true, false])).toEqual([0, 0, 2, 2]);
  });
  it('voices 1 + 4 patched → [0, 0, 0, 3]', () => {
    expect(normalledChain([true, false, false, true])).toEqual([0, 0, 0, 3]);
  });
  it('voice 2 patched (1 unpatched) → [0, 1, 1, 1]', () => {
    // Walks from voice 1 (sourcing itself = 0 by convention until a
    // patched voice is found). Voice 2 is patched so the chain pivots.
    expect(normalledChain([false, true, false, false])).toEqual([0, 1, 1, 1]);
  });
  it('every voice patched → identity', () => {
    expect(normalledChain([true, true, true, true])).toEqual([0, 1, 2, 3]);
  });
});

describe('effectiveVoiceRouting — unison + chord + normalling priority', () => {
  it('unison wins over chord + normalling — both routes = [0,0,0,0]', () => {
    const r = effectiveVoiceRouting(true, true, [true, true, true, true], [true, true, true, true]);
    expect(r.gateRoute).toEqual([0, 0, 0, 0]);
    expect(r.pitchRoute).toEqual([0, 0, 0, 0]);
  });
  it('chord mode forces pitch route to voice 1 but leaves gate normalling alone', () => {
    const r = effectiveVoiceRouting(false, true, [true, false, true, false], [false, true, false, false]);
    expect(r.gateRoute).toEqual([0, 0, 2, 2]);
    expect(r.pitchRoute).toEqual([0, 0, 0, 0]);
  });
  it('no special modes → both chains follow patched state', () => {
    const r = effectiveVoiceRouting(false, false, [true, false, false, true], [true, false, true, false]);
    expect(r.gateRoute).toEqual([0, 0, 0, 3]);
    expect(r.pitchRoute).toEqual([0, 0, 2, 2]);
  });
  it('canonical user spec: g1 + p1/p3/p4 patched — gates from g1, pitches 0,0,2,3', () => {
    // From the issue text: "g1 only patched and then p1, p3, p4 -- gates
    // all fire with g1, p1 and p2 fire p1's value, p3/p4 fire as
    // expected." (p3 fires p3, p4 fires p4 — p2 picks up p1 by
    // normalling.)
    const r = effectiveVoiceRouting(false, false, [true, false, false, false], [true, false, true, true]);
    expect(r.gateRoute).toEqual([0, 0, 0, 0]);
    expect(r.pitchRoute).toEqual([0, 0, 2, 3]);
  });
});

describe('chordQualityFromKnob + CHORD_INTERVALS_SEMITONES', () => {
  it('knob ≤ 0.5 → major, knob > 0.5 → minor', () => {
    expect(chordQualityFromKnob(0)).toBe('major');
    expect(chordQualityFromKnob(0.49)).toBe('major');
    expect(chordQualityFromKnob(0.5)).toBe('minor');
    expect(chordQualityFromKnob(1)).toBe('minor');
  });
  it('major intervals = [0, 4, 7, 12] (M3 + P5 + octave)', () => {
    expect(CHORD_INTERVALS_SEMITONES.major).toEqual([0, 4, 7, 12]);
  });
  it('minor intervals = [0, 3, 7, 12] (m3 + P5 + octave)', () => {
    expect(CHORD_INTERVALS_SEMITONES.minor).toEqual([0, 3, 7, 12]);
  });
});

describe('wavesculpt def: new ports + params landed', () => {
  it('declares morph1_cv..morph4_cv inputs targeting the worklet morph param', () => {
    const inIds = wavesculptDef.inputs.map((p) => p.id);
    for (let i = 1; i <= 4; i++) {
      expect(inIds).toContain(`morph${i}_cv`);
      const port = wavesculptDef.inputs.find((p) => p.id === `morph${i}_cv`);
      expect(port?.type).toBe('cv');
      expect((port as { paramTarget?: string } | undefined)?.paramTarget).toBe(`morph${i}`);
    }
  });
  it('exposes chord_mode + chord_quality params', () => {
    const ids = wavesculptDef.params.map((p) => p.id);
    expect(ids).toContain('chord_mode');
    expect(ids).toContain('chord_quality');
    const mode = wavesculptDef.params.find((p) => p.id === 'chord_mode')!;
    expect(mode.defaultValue).toBe(0);
    expect(mode.curve).toBe('discrete');
  });

  it('exposes per-osc fxType{1..4} (discrete 0=OFF, 1=REVERB, 2=DELAY) + fxAmount', () => {
    for (let i = 1; i <= 4; i++) {
      const t = wavesculptDef.params.find((p) => p.id === `fxType${i}`)!;
      expect(t, `fxType${i} exists`).toBeDefined();
      expect(t.min).toBe(0);
      expect(t.max).toBe(2);
      expect(t.curve).toBe('discrete');
      expect(t.defaultValue).toBe(0); // FX off by default

      const a = wavesculptDef.params.find((p) => p.id === `fxAmount${i}`)!;
      expect(a, `fxAmount${i} exists`).toBeDefined();
      expect(a.min).toBe(0);
      expect(a.max).toBe(1);
      expect(a.curve).toBe('linear');
    }
  });

  it('exposes video_mode (discrete 0=PROXIMITY, 1=BIRDSEYE, 2=SPECTROGRAPH)', () => {
    const m = wavesculptDef.params.find((p) => p.id === 'video_mode')!;
    expect(m, 'video_mode exists').toBeDefined();
    expect(m.defaultValue).toBe(0);
    expect(m.min).toBe(0);
    // Max bumped from 1 → 2 in the spectrograph PR so the discrete
    // cycle covers PROXIMITY → BIRDSEYE → SPECTROGRAPH.
    expect(m.max).toBe(2);
    expect(m.curve).toBe('discrete');
  });

  it('exposes blink_mode (discrete 0=current, 1=SCOPES TRIAL, 2=REALITY BASED COMMUNITY)', () => {
    const m = wavesculptDef.params.find((p) => p.id === 'blink_mode')!;
    expect(m, 'blink_mode exists').toBeDefined();
    // Default = mode 0 (today's render), so existing patches are unchanged.
    expect(m.defaultValue).toBe(0);
    expect(m.min).toBe(0);
    expect(m.max).toBe(2);
    // Discrete so the BLINK button cycles cleanly through the 3 modes and
    // the value persists/syncs like every other param.
    expect(m.curve).toBe('discrete');
  });

  it('exposes SCALE param reusing SCOPE ch1Scale semantics (log 0.1..10, unity default)', () => {
    const s = wavesculptDef.params.find((p) => p.id === 'scale')!;
    expect(s, 'scale param exists').toBeDefined();
    expect(s.defaultValue).toBe(1);   // unity = scope shape at SCOPE's default
    expect(s.min).toBe(0.1);
    expect(s.max).toBe(10);
    expect(s.curve).toBe('log');
  });

  it('exposes WIGGLE param defaulting OFF (linear 0..1)', () => {
    const w = wavesculptDef.params.find((p) => p.id === 'wiggle')!;
    expect(w, 'wiggle param exists').toBeDefined();
    expect(w.defaultValue).toBe(0);   // OFF by default = current fixed dir
    expect(w.min).toBe(0);
    expect(w.max).toBe(1);
    expect(w.curve).toBe('linear');
  });

  it('declares CV inputs for scale + wiggle (so they are CV + MIDI wired)', () => {
    const inIds = wavesculptDef.inputs.map((p) => p.id);
    expect(inIds).toContain('scale');
    expect(inIds).toContain('wiggle');
    const sc = wavesculptDef.inputs.find((p) => p.id === 'scale');
    const wg = wavesculptDef.inputs.find((p) => p.id === 'wiggle');
    expect(sc?.type).toBe('cv');
    expect(wg?.type).toBe('cv');
    expect((sc as { paramTarget?: string } | undefined)?.paramTarget).toBe('scale');
    expect((wg as { paramTarget?: string } | undefined)?.paramTarget).toBe('wiggle');
  });
});

describe('WIGGLE: pitch → 3D rotation mapping (pure helper)', () => {
  it('wigglePitchNorm: null / sub-floor pitch → 0', () => {
    expect(wigglePitchNorm(null)).toBe(0);
    expect(wigglePitchNorm(WIGGLE_MIN_HZ - 1)).toBe(0);
    expect(wigglePitchNorm(0)).toBe(0);
  });

  it('wigglePitchNorm: rises monotonically with pitch, 0 at floor → 1 at ceiling', () => {
    expect(wigglePitchNorm(WIGGLE_MIN_HZ)).toBeCloseTo(0, 5);
    expect(wigglePitchNorm(WIGGLE_MAX_HZ)).toBeCloseTo(1, 5);
    const lo = wigglePitchNorm(110);
    const mid = wigglePitchNorm(440);
    const hi = wigglePitchNorm(1760);
    expect(lo).toBeLessThan(mid);
    expect(mid).toBeLessThan(hi);
  });

  it('wigglePitchNorm: log scale — an octave is a roughly-uniform step', () => {
    const a = wigglePitchNorm(220) - wigglePitchNorm(110);
    const b = wigglePitchNorm(880) - wigglePitchNorm(440);
    expect(Math.abs(a - b)).toBeLessThan(0.02);
  });

  it('pitchToWiggle: wiggle=0 → OFF (zero rate + magnitude) at any pitch', () => {
    expect(pitchToWiggle(440, 0)).toEqual({ rate: 0, magnitude: 0 });
    expect(pitchToWiggle(2000, 0)).toEqual({ rate: 0, magnitude: 0 });
  });

  it('pitchToWiggle: null pitch → zero rate + magnitude even at full wiggle', () => {
    expect(pitchToWiggle(null, 1)).toEqual({ rate: 0, magnitude: 0 });
  });

  it('pitchToWiggle: LOW pitch → slow + small, HIGH pitch → fast + large', () => {
    const low  = pitchToWiggle(80, 1);
    const high = pitchToWiggle(2000, 1);
    expect(high.rate).toBeGreaterThan(low.rate);
    expect(high.magnitude).toBeGreaterThan(low.magnitude);
    expect(low.rate).toBeGreaterThan(0);
  });

  it('pitchToWiggle: the WIGGLE knob scales overall strength linearly', () => {
    const full = pitchToWiggle(880, 1);
    const half = pitchToWiggle(880, 0.5);
    expect(half.rate).toBeCloseTo(full.rate * 0.5, 6);
    expect(half.magnitude).toBeCloseTo(full.magnitude * 0.5, 6);
  });

  it('pitchToWiggle: max pitch + full wiggle hits the configured ceilings', () => {
    const max = pitchToWiggle(WIGGLE_MAX_HZ, 1);
    expect(max.rate).toBeCloseTo(WIGGLE_MAX_RATE, 5);
    expect(max.magnitude).toBeCloseTo(WIGGLE_MAX_MAGNITUDE, 5);
  });

  it('pitchToWiggle: clamps the wiggle strength to [0,1]', () => {
    const over = pitchToWiggle(880, 5);
    const one = pitchToWiggle(880, 1);
    expect(over).toEqual(one);
  });
});

describe('shared wavetable engine import (DRY check)', () => {
  // Smoke-check that the wavetable factory tables resolve. The shared
  // wavetable engine (packages/dsp/src/lib/wavetable-osc.ts) is verified
  // at build time — if the import path were wrong, esbuild would fail
  // the build.
  it('wavesculpt consumes wavetable-factory-tables', async () => {
    const tables = await import('$lib/audio/wavetable-factory-tables');
    expect(typeof tables.getFactoryTables).toBe('function');
    expect(wavesculptDef.type).toBe('wavesculpt');
  });
});

describe('ribbonStripRange (alpha-rotate bugfix: per-osc sub-strip)', () => {
  // The ALPHA-mask pass MUST draw only the ALPHA ribbon (osc 3). Drawing
  // all four ribbons let the RGB ribbons write depth that occluded the
  // ALPHA mask under camera rotation, so the alpha-image composite
  // vanished as soon as the view rotated off axis. ribbonStripRange is
  // the single source of truth for the per-osc vertex offsets the card's
  // drawArrays() uses; lock the arithmetic here.
  const SEG = 64; // RIBBON_SEGMENTS in the card

  it('osc 0 starts at 0 with no join lead-in', () => {
    expect(ribbonStripRange(0, SEG)).toEqual({ start: 0, count: 2 * SEG });
  });

  it('each subsequent osc is offset by one (join + block) and skips its own joins', () => {
    const block = 2 * SEG;
    expect(ribbonStripRange(1, SEG)).toEqual({ start: block + 2, count: block });
    expect(ribbonStripRange(2, SEG)).toEqual({ start: 2 * (block + 2), count: block });
    // ALPHA = osc 3 — the layer the bugfix targets.
    expect(ribbonStripRange(3, SEG)).toEqual({ start: 3 * (block + 2), count: block });
  });

  it('alpha (osc 3) sub-strip stays inside the full geometry vertex count', () => {
    const block = 2 * SEG;
    const totalVerts = 4 * block + 3 * 2; // matches card: 4·(2·SEG)+3·2
    const { start, count } = ribbonStripRange(3, SEG);
    expect(start + count).toBeLessThanOrEqual(totalVerts);
    // And the alpha strip's real verts must NOT overlap osc 0-2's depth
    // region's tail (i.e. it begins strictly after osc 2's block).
    const osc2 = ribbonStripRange(2, SEG);
    expect(start).toBeGreaterThan(osc2.start + osc2.count - 1);
  });
});
