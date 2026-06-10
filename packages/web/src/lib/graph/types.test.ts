// packages/web/src/lib/graph/types.test.ts
//
// Unit tests for canConnect — the type-level compatibility gate the UI
// uses to filter the "Patch to..." cascade and the inline drag-connect
// preview. The rule set encodes both the trivially-allowed (equal types)
// and the upcasts that mirror what the engine actually permits at
// runtime — see the canConnect docstring for the full rule list.
//
// Regression history:
//   * Patch-to cascade hid gate→cv / pitch→cv / cv→gate / cv→pitch
//     candidates even though the engine routes them at runtime — added
//     CV_FAMILY interchange to canConnect (Hydrogen-PR-feedback bundle).
//   * polyPitchGate ↔ pitch / gate / cv: the engine's resolveConnection
//     interposes a splitter / merger; this test set asserts the UI gate
//     mirrors that permissiveness.

import { describe, expect, it } from 'vitest';
import { canConnect, canConnectToPort, isVideoCableType } from './types';

describe('canConnect — equal types always pass', () => {
  for (const t of ['audio', 'cv', 'pitch', 'gate', 'polyPitchGate', 'mono-video', 'video', 'keys', 'image'] as const) {
    it(`${t} → ${t}`, () => {
      expect(canConnect(t, t)).toBe(true);
    });
  }
});

describe('canConnect — CV family (cv / pitch / gate) interchange', () => {
  // Every pair within {cv, pitch, gate} must succeed in both directions.
  // Real-world patches that previously failed at the UI level despite
  // working at the engine level:
  //   * SEQUENCER.gate → ADSR.attack (gate-pulse modulating attack)
  //   * SEQUENCER.pitch → AnalogVCO.fmAmount (pitch driving FM depth)
  //   * LFO.phase0 → AnalogVCO.pitch_cv (LFO as pitch modulation)
  //   * LFO.phase0 → ADSR.gate (threshold-detected envelope retrig)
  for (const src of ['cv', 'pitch', 'gate'] as const) {
    for (const dst of ['cv', 'pitch', 'gate'] as const) {
      it(`${src} → ${dst}`, () => {
        expect(canConnect(src, dst)).toBe(true);
      });
    }
  }
});

describe('canConnect — polyPitchGate ↔ CV family (engine-side splitter/merger)', () => {
  for (const t of ['cv', 'pitch', 'gate'] as const) {
    it(`polyPitchGate → ${t} (splitter picks channel 0)`, () => {
      expect(canConnect('polyPitchGate', t)).toBe(true);
    });
    it(`${t} → polyPitchGate (merger fills channel 0, rest silent)`, () => {
      expect(canConnect(t, 'polyPitchGate')).toBe(true);
    });
  }
});

describe('canConnect — video-domain upcasts', () => {
  it('keys → mono-video (single-channel still → animated)', () => {
    expect(canConnect('keys', 'mono-video')).toBe(true);
  });
  it('keys → image (single-channel still → RGB still)', () => {
    expect(canConnect('keys', 'image')).toBe(true);
  });
  it('image → video (RGB still → animated)', () => {
    expect(canConnect('image', 'video')).toBe(true);
  });
  it('mono-video → video (single-channel → RGB)', () => {
    expect(canConnect('mono-video', 'video')).toBe(true);
  });
  it('does not upcast the other direction (video → image)', () => {
    expect(canConnect('video', 'image')).toBe(false);
  });
  it('does not upcast keys → video directly (must hop via mono-video / image)', () => {
    // The runtime resolver only knows about the two-step chain; we
    // intentionally don't shortcut here so the cable-type stays
    // single-hop predictable at the UI level.
    expect(canConnect('keys', 'video')).toBe(false);
  });
});

describe('canConnect — cv → video cross-domain bridge', () => {
  for (const v of ['keys', 'image', 'mono-video', 'video'] as const) {
    it(`cv → ${v} (frame-rate sample-and-hold, deferred Phase-1 bridge)`, () => {
      expect(canConnect('cv', v)).toBe(true);
    });
  }
  it('rejects pitch → mono-video (only cv has the cross-domain pass)', () => {
    // pitch / gate are CV-family but the cv → video cross-domain bridge
    // is intentionally cv-specific so the Phase-1 implementation has
    // only one cable type to lower.
    expect(canConnect('pitch', 'mono-video')).toBe(false);
    expect(canConnect('gate', 'mono-video')).toBe(false);
  });
});

describe('canConnect — strict rejections', () => {
  it('rejects audio → cv (audio bus is bipolar full-range, would clip params)', () => {
    expect(canConnect('audio', 'cv')).toBe(false);
  });
  it('rejects cv → audio (CV at audio rate plus a master limiter = click track)', () => {
    expect(canConnect('cv', 'audio')).toBe(false);
  });
  it('rejects audio → gate', () => {
    expect(canConnect('audio', 'gate')).toBe(false);
  });
  it('rejects gate → audio', () => {
    expect(canConnect('gate', 'audio')).toBe(false);
  });
  it('rejects video → audio in every flavor', () => {
    for (const v of ['keys', 'image', 'mono-video', 'video'] as const) {
      expect(canConnect(v, 'audio')).toBe(false);
    }
  });
  it('rejects pitch → audio (V/oct is bipolar, would land as DC offset)', () => {
    expect(canConnect('pitch', 'audio')).toBe(false);
  });
});

describe('canConnectToPort — per-port `accepts` widening (SCOPE probe)', () => {
  it('falls through to canConnect when the port has no accepts list', () => {
    expect(canConnectToPort('cv', { type: 'audio' })).toBe(false);     // global rule
    expect(canConnectToPort('audio', { type: 'audio' })).toBe(true);   // equal types
    expect(canConnectToPort('cv', { type: 'cv' })).toBe(true);         // equal types
  });
  it('lets an audio probe accept the CV family without changing the global rule', () => {
    const probe = { type: 'audio' as const, accepts: ['cv', 'pitch', 'gate'] as const };
    expect(canConnectToPort('cv', probe)).toBe(true);
    expect(canConnectToPort('pitch', probe)).toBe(true);
    expect(canConnectToPort('gate', probe)).toBe(true);
    expect(canConnectToPort('audio', probe)).toBe(true); // still via canConnect (equal)
    // The GLOBAL rule is untouched — cv→audio is still rejected everywhere else.
    expect(canConnect('cv', 'audio')).toBe(false);
  });
  it('does NOT accept a type that is neither canConnect-allowed nor in accepts', () => {
    const probe = { type: 'audio' as const, accepts: ['cv'] as const };
    expect(canConnectToPort('video', probe)).toBe(false);  // video → audio probe: no
    expect(canConnectToPort('gate', probe)).toBe(false);   // gate not in this accepts list
  });
});

describe('canConnect — modsignal (TOYBOX 6-input modulation) accepts cv/gate/audio', () => {
  it('accepts cv → modsignal', () => {
    expect(canConnect('cv', 'modsignal')).toBe(true);
  });
  it('accepts gate → modsignal', () => {
    expect(canConnect('gate', 'modsignal')).toBe(true);
  });
  it('accepts audio → modsignal (envelope-followed by the bridge)', () => {
    expect(canConnect('audio', 'modsignal')).toBe(true);
  });
  it('accepts modsignal → modsignal (equal types)', () => {
    expect(canConnect('modsignal', 'modsignal')).toBe(true);
  });
  it('does NOT widen audio→cv: a normal cv input still rejects audio', () => {
    // The whole point of a dedicated `modsignal` type: audio→cv stays rejected
    // EVERYWHERE except a modsignal input.
    expect(canConnect('audio', 'cv')).toBe(false);
    expect(canConnect('audio', 'pitch')).toBe(false);
  });
  it('rejects video / pitch sources into a modsignal input', () => {
    expect(canConnect('video', 'modsignal')).toBe(false);
    expect(canConnect('image', 'modsignal')).toBe(false);
    // pitch is CV-family but the bridge only handles cv/gate/audio; pitch is not
    // a documented modulation source for the section.
    expect(canConnect('pitch', 'modsignal')).toBe(false);
  });
});

describe('isVideoCableType', () => {
  it('returns true for the four video-domain types', () => {
    for (const t of ['keys', 'image', 'mono-video', 'video'] as const) {
      expect(isVideoCableType(t)).toBe(true);
    }
  });
  it('returns false for audio-domain types', () => {
    for (const t of ['audio', 'cv', 'pitch', 'gate', 'polyPitchGate'] as const) {
      expect(isVideoCableType(t)).toBe(false);
    }
  });
});
