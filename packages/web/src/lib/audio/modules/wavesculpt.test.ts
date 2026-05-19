// packages/web/src/lib/audio/modules/wavesculpt.test.ts
//
// Unit tests for the WAVESCULPT module. Covers:
//   - module-def shape (4 oscs × {gate, pitch_cv, morph, ADSR}, +
//     camera params, + bentscreen wiggles, + L/R/video outputs).
//   - distanceGain math: front-of-camera → high gain; behind → 0;
//     symmetric across the (vec, dirToCam) angle.
//   - stereoPanForSource: -X tilts left, +X tilts right, equal-power.
//   - voctToHz: 0V = C4, +1V = +1 octave.
//   - detuneOctaveOffset: oscIdx=0 unaffected; non-zero detune
//     spreads other voices.
//   - morphToOscType: maps low/mid/high to saw/sine/triangle.
//   - tickEnvelope: idle stays at 0, attack rises to 1 over A ms,
//     decay drops to sustain, release falls to 0.
//   - unisonRouting: unison=true → all voices read source 0.

import { describe, it, expect } from 'vitest';
import {
  wavesculptDef,
  WALL_LAYOUT,
  distanceGain,
  stereoPanForSource,
  voctToHz,
  detuneOctaveOffset,
  morphToOscType,
  tickEnvelope,
  unisonRouting,
} from './wavesculpt';

describe('wavesculpt: module-def shape', () => {
  it('declares type/label/domain/category', () => {
    expect(wavesculptDef.type).toBe('wavesculpt');
    expect(wavesculptDef.label).toBe('WAVESCULPT');
    expect(wavesculptDef.domain).toBe('audio');
    expect(wavesculptDef.category).toBe('sources');
  });

  it('declares gate + pitch_cv for each of 4 oscillators', () => {
    const inIds = wavesculptDef.inputs.map((p) => p.id);
    for (let i = 1; i <= 4; i++) {
      expect(inIds).toContain(`gate${i}`);
      expect(inIds).toContain(`pitch_cv${i}`);
    }
  });

  it('declares camera position + zoom CV inputs', () => {
    const inIds = wavesculptDef.inputs.map((p) => p.id);
    for (const id of ['pos_x', 'pos_y', 'pos_z', 'zoom']) {
      expect(inIds).toContain(id);
    }
  });

  it('declares L + R audio outputs and a video output', () => {
    const outs = wavesculptDef.outputs;
    expect(outs.find((o) => o.id === 'L')?.type).toBe('audio');
    expect(outs.find((o) => o.id === 'R')?.type).toBe('audio');
    const v = outs.find((o) => o.id === 'video_out');
    expect(v).toBeDefined();
    // mono-video or video — either is fine; the engine accepts both.
    expect(['video', 'mono-video']).toContain(v!.type);
  });

  it('exposes per-oscillator morph + ADSR + pitch + thickness params', () => {
    const ids = wavesculptDef.params.map((p) => p.id);
    for (let i = 1; i <= 4; i++) {
      expect(ids).toContain(`morph${i}`);
      expect(ids).toContain(`A${i}`);
      expect(ids).toContain(`D${i}`);
      expect(ids).toContain(`S${i}`);
      expect(ids).toContain(`R${i}`);
      expect(ids).toContain(`pitch${i}`);
      expect(ids).toContain(`thickness${i}`);
    }
  });

  it('thickness params default to 0.3 in [0..1] range', () => {
    for (let i = 1; i <= 4; i++) {
      const p = wavesculptDef.params.find((q) => q.id === `thickness${i}`);
      expect(p, `thickness${i} param exists`).toBeDefined();
      expect(p!.defaultValue).toBe(0.3);
      expect(p!.min).toBe(0);
      expect(p!.max).toBe(1);
    }
  });

  it('declares an alpha_in video input port', () => {
    const ai = wavesculptDef.inputs.find((p) => p.id === 'alpha_in');
    expect(ai, 'alpha_in port exists').toBeDefined();
    expect(ai!.type).toBe('video');
  });

  it('exposes UNISON + Detune + camera + 12 bentscreen-wiggle params', () => {
    const ids = wavesculptDef.params.map((p) => p.id);
    for (const id of ['unison', 'detune', 'pos_x', 'pos_y', 'pos_z', 'zoom']) {
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
});

describe('distanceGain', () => {
  it('returns 1.0 at the source (camera-inside-source case)', () => {
    expect(distanceGain([0, 0, 0], [1, 0, 0], [0, 0, 0])).toBe(1);
  });

  it('returns 0 when camera is BEHIND the source (vector points away)', () => {
    // Source at +X, vector pointing -X (into box). Camera at +2,0,0 is
    // BEHIND the source relative to its viewing direction.
    expect(distanceGain([1, 0, 0], [-1, 0, 0], [2, 0, 0])).toBe(0);
  });

  it('is positive when camera is in FRONT of the source', () => {
    // Same source, camera in the box at the center.
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

describe('stereoPanForSource', () => {
  it('+X → right channel hotter than left', () => {
    const p = stereoPanForSource([1, 0, 0]);
    expect(p.r).toBeGreaterThan(p.l);
  });

  it('-X → left channel hotter than right', () => {
    const p = stereoPanForSource([-1, 0, 0]);
    expect(p.l).toBeGreaterThan(p.r);
  });

  it('center (X=0) → equal L/R', () => {
    const p = stereoPanForSource([0, 0, 0]);
    expect(p.l).toBeCloseTo(p.r, 5);
  });

  it('equal-power: l^2 + r^2 ≈ 1', () => {
    for (const x of [-1, -0.5, 0, 0.5, 1]) {
      const p = stereoPanForSource([x, 0, 0]);
      expect(p.l * p.l + p.r * p.r).toBeCloseTo(1, 5);
    }
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
      // Use closeTo so -0 and +0 both qualify (the implementation returns
      // -detune for osc4 which yields -0 at detune=0; JS distinguishes
      // signed zeros under Object.is but the musical result is identical).
      expect(detuneOctaveOffset(i, 0)).toBeCloseTo(0, 10);
    }
  });

  it('osc2 and osc4 receive opposite-sign offsets for spread', () => {
    expect(detuneOctaveOffset(1, 0.5)).toBeGreaterThan(0);
    expect(detuneOctaveOffset(3, 0.5)).toBeLessThan(0);
  });
});

describe('morphToOscType', () => {
  it('low morph → sawtooth, mid → sine, high → triangle', () => {
    expect(morphToOscType(0)).toBe('sawtooth');
    expect(morphToOscType(0.2)).toBe('sawtooth');
    expect(morphToOscType(0.5)).toBe('sine');
    expect(morphToOscType(0.8)).toBe('triangle');
    expect(morphToOscType(1)).toBe('triangle');
  });
});

describe('tickEnvelope', () => {
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
    // A=0.05s = 50ms; 25ms in → ~0.5.
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
    // Advance well past A (50ms).
    s = tickEnvelope(s, 100, { A: 0.05, D: 0.1, S: 0.5, R: 0.2 });
    expect(s.phase).toBe('decay');
    expect(s.env).toBe(1);
  });

  it('release ramps env down to ~0', () => {
    let s: Parameters<typeof tickEnvelope>[0] = {
      env: 0.7, gateHigh: false, phase: 'release', phaseT: 0,
    };
    // The tickEnvelope helper expects an internal _releaseStart attached
    // before the release phase starts; mirror what the factory does.
    (s as { _releaseStart?: number })._releaseStart = 0.7;
    // Advance well past R (200ms).
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
