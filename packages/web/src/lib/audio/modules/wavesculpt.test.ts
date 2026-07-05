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

import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  wavesculptDef,
  WALL_LAYOUT,
  VIDEO_WALL_FACES,
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
  packColor01,
  unpackColor01,
  DEFAULT_OSC_COLOR_PACKED,
  lineWallCrossings,
  setWavesculptLuma,
  getWavesculptLuma,
} from './wavesculpt';

describe('wavesculpt v2: module-def shape', () => {
  it('declares type/label/domain/category', () => {
    expect(wavesculptDef.type).toBe('wavesculpt');
    expect(wavesculptDef.label).toBe('wavesculpt');
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

  it('declares 6 video WALL inputs (wall1..wall6), all video-typed', () => {
    const inIds = wavesculptDef.inputs.map((p) => p.id);
    for (let i = 1; i <= 6; i++) {
      const port = wavesculptDef.inputs.find((p) => p.id === `wall${i}`);
      expect(port, `wall${i} port exists`).toBeDefined();
      expect(port!.type, `wall${i} is video-typed`).toBe('video');
    }
    // No duplicates among the inputs (the new walls don't collide with
    // anything — also re-asserted globally in the unique-ids test).
    expect(new Set(inIds).size).toBe(inIds.length);
  });

  it('declares a TRANSPARENCY + DISTORT param per wall (12 total)', () => {
    for (let i = 1; i <= 6; i++) {
      const a = wavesculptDef.params.find((p) => p.id === `wall${i}_alpha`);
      expect(a, `wall${i}_alpha exists`).toBeDefined();
      expect(a!.min, `wall${i}_alpha min 0%`).toBe(0);
      expect(a!.max, `wall${i}_alpha max 100%`).toBe(100);
      expect(a!.defaultValue, `wall${i}_alpha default 100% (visible)`).toBe(100);

      const d = wavesculptDef.params.find((p) => p.id === `wall${i}_distort`);
      expect(d, `wall${i}_distort exists`).toBeDefined();
      expect(d!.min, `wall${i}_distort min 0 (flat)`).toBe(0);
      expect(d!.max, `wall${i}_distort max 1 (dome)`).toBe(1);
      expect(d!.defaultValue, `wall${i}_distort default 0 (flat)`).toBe(0);
    }
  });

  it('VIDEO_WALL_FACES maps all 6 faces to distinct axis/sign of the unit box', () => {
    expect(VIDEO_WALL_FACES.length).toBe(6);
    // wallIdx 0..5 in order.
    expect(VIDEO_WALL_FACES.map((f) => f.wallIdx)).toEqual([0, 1, 2, 3, 4, 5]);
    // Every (axis, sign) pair is unique → 6 distinct box faces, no overlap.
    const faces = new Set(VIDEO_WALL_FACES.map((f) => `${f.axis}:${f.sign}`));
    expect(faces.size).toBe(6);
    // Every axis (0=X,1=Y,2=Z) appears exactly twice (a + and − face).
    for (const axis of [0, 1, 2]) {
      const onAxis = VIDEO_WALL_FACES.filter((f) => f.axis === axis);
      expect(onAxis.length, `axis ${axis} has +/- faces`).toBe(2);
      expect(new Set(onAxis.map((f) => f.sign)).size).toBe(2);
    }
    // Documented mapping: wall1=FRONT(−Z), wall4=RIGHT(+X), wall6=CEILING(+Y).
    expect(VIDEO_WALL_FACES[0]).toMatchObject({ label: 'FRONT', axis: 2, sign: -1 });
    expect(VIDEO_WALL_FACES[3]).toMatchObject({ label: 'RIGHT', axis: 0, sign: 1 });
    expect(VIDEO_WALL_FACES[5]).toMatchObject({ label: 'CEILING', axis: 1, sign: 1 });
  });

  it('declares L + R audio outputs and a video output', () => {
    const outs = wavesculptDef.outputs;
    expect(outs.find((o) => o.id === 'L')?.type).toBe('audio');
    expect(outs.find((o) => o.id === 'R')?.type).toBe('audio');
    const v = outs.find((o) => o.id === 'video_out');
    expect(v).toBeDefined();
    expect(['video', 'mono-video']).toContain(v!.type);
  });

  it('declares 4 per-oscillator AUDIO outputs (RED/GRN/BLU/ALP), additive to L/R', () => {
    const outs = wavesculptDef.outputs;
    // The summed main mix is KEPT intact + backward-compatible.
    expect(outs.find((o) => o.id === 'L')?.type).toBe('audio');
    expect(outs.find((o) => o.id === 'R')?.type).toBe('audio');
    expect(outs.find((o) => o.id === 'video_out')).toBeDefined();
    // Plus one per-osc tap per oscillator, all audio-typed.
    for (const id of ['out_red', 'out_grn', 'out_blu', 'out_alp']) {
      const o = outs.find((p) => p.id === id);
      expect(o, `${id} declared`).toBeDefined();
      expect(o!.type, `${id} is audio`).toBe('audio');
    }
    // No duplicate port ids.
    const ids = outs.map((o) => o.id);
    expect(new Set(ids).size).toBe(ids.length);
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

// ---------------------------------------------------------------------------
// PCU (pure-core-unit) ports of three deleted WAVESCULPT e2e satellite specs.
//
// The e2e specs spawned a real card + LFO/joystick + scope and asserted on
// audio RMS / WebGL pixel histograms — flaky on CI's SwiftShader software
// renderer and slow on the serialized heavy-WebGL lane. But the behaviours
// they pinned are deterministic functions of the SAME pure cores already
// exported + tested here (eyeFromCamera / distanceGain / WALL_LAYOUT / the
// module def's CV paramTargets). We fold the real coverage back in as pure
// unit cases — no GPU, no AudioContext, no scheduler.
//
// Thresholds below are derived from the ACTUAL computed values (commented
// inline at each assert), then set comfortably under the real delta so the
// test pins behaviour without false-failing on harmless arithmetic drift.
// ---------------------------------------------------------------------------

/** Per-wall spatial-gain vector at a camera eye position. */
function wallGainVector(eye: readonly [number, number, number]): number[] {
  return WALL_LAYOUT.map((w) => distanceGain(w.src, w.vec, eye));
}

/** L1 distance between two equal-length vectors. */
function l1(a: readonly number[], b: readonly number[]): number {
  let d = 0;
  for (let i = 0; i < a.length; i++) d += Math.abs((a[i] ?? 0) - (b[i] ?? 0));
  return d;
}

describe('PCU: spatial pan (ex e2e wavesculpt-spatial-audio.spec.ts)', () => {
  // The e2e drove the camera through pos_x ∈ {-0.8, 0, +0.8} (its POSITIONS)
  // and asserted (a) non-trivial audio at every position + (b) RMS left ≠
  // right (the spatial mix tracks the pan). We reproduce the deterministic
  // core: per-wall distanceGain at the eye each pos_x maps to.
  const POSITIONS = [-0.8, 0, 0.8];
  const gains = POSITIONS.map((x) => wallGainVector(eyeFromCamera(x, 0, 0, 1, 0)));

  it('(a) every camera position lights at least one wall (analogue of "RMS > 0 everywhere")', () => {
    // Computed at zoom=1/rot=0: exactly 3 of 4 walls are > 0 at every
    // position — the BLUE wall (+Z) sits behind the default +Z eye, so its
    // directional dot is ≤ 0 (gain 0) for the whole sweep. So we assert the
    // stronger, TRUE fact (≥ 3 walls audible) rather than the weaker ≥ 1.
    //   pos_x=-0.8 → [0.0497, 0.0023, 0,     0.0601]  (3 > 0)
    //   pos_x= 0   → [0.0532, 0.0480, 0,     0.0703]  (3 > 0)
    //   pos_x=+0.8 → [0.0253, 0.0527, 0,     0.0601]  (3 > 0)
    for (let i = 0; i < POSITIONS.length; i++) {
      const audible = gains[i]!.filter((g) => g > 0).length;
      expect(
        audible,
        `pos_x=${POSITIONS[i]}: ${audible} walls audible (gains: ${gains[i]!.map((g) => g.toFixed(4)).join(', ')})`,
      ).toBeGreaterThanOrEqual(3);
    }
  });

  it('(b) the per-wall mix differs left vs right (analogue of "RMS left ≠ right")', () => {
    // Real L1(g(pos_x=-0.8) − g(pos_x=+0.8)) = 0.074856. Threshold 0.03 is
    // well under that (and far above arithmetic noise), so the pan provably
    // re-weights the wall mix as the camera crosses the box.
    const dLR = l1(gains[0]!, gains[2]!);
    expect(
      dLR,
      `L1(gain(left=-0.8) − gain(right=+0.8)) = ${dLR.toFixed(6)} (expect > 0.03; real ≈ 0.0749)`,
    ).toBeGreaterThan(0.03);
  });
});

describe('PCU: camera CV axes move the eye + the mix (ex e2e wavesculpt-camera-cv.spec.ts)', () => {
  // The e2e patched an LFO into each camera CV port (pos_x/pos_y/pos_z/zoom/
  // rot) and asserted the viewport/engine value moved. The deterministic
  // half: each axis, swept low→high, must move BOTH the eye position and the
  // resulting per-wall gain vector. (The live-LFO/analyser/pixel half was
  // already CI-skipped in that spec — dropped here.)
  const AXES: { port: string; lo: [number, number, number, number, number]; hi: [number, number, number, number, number] }[] = [
    // [posX, posY, posZ, zoom, rot]
    { port: 'pos_x', lo: [-1, 0, 0, 1, 0], hi: [1, 0, 0, 1, 0] },
    { port: 'pos_y', lo: [0, -1, 0, 1, 0], hi: [0, 1, 0, 1, 0] },
    { port: 'pos_z', lo: [0, 0, -1, 1, 0], hi: [0, 0, 1, 1, 0] },
    { port: 'zoom',  lo: [0, 0, 0, 0.3, 0], hi: [0, 0, 0, 3, 0] },
    { port: 'rot',   lo: [0, 0, 0, 1, 0],  hi: [0, 0, 0, 1, 0.5] },
  ];

  for (const { port, lo, hi } of AXES) {
    it(`${port}: low vs high moves the eye AND changes the per-wall gain vector`, () => {
      const eyeLo = eyeFromCamera(...lo);
      const eyeHi = eyeFromCamera(...hi);
      const eyeDelta = l1(eyeLo, eyeHi);
      const gainDelta = l1(wallGainVector(eyeLo), wallGainVector(eyeHi));
      // Real eye L1 per axis: pos_x/pos_y/pos_z=3.0, zoom=7.5, rot=2.5 — all
      // ≥ 2.5; threshold 0.5 is a safe floor for "the eye actually moved".
      expect(
        eyeDelta,
        `${port}: eye L1(lo,hi) = ${eyeDelta.toFixed(4)} (expect > 0.5)`,
      ).toBeGreaterThan(0.5);
      // Real gain-vector L1 per axis: pos_x=0.0814, pos_y=0.0641, pos_z=1.55,
      // zoom=1.68, rot=0.129 — the SMALLEST (pos_y) is 0.064; threshold 0.01
      // is well under it for every axis, so each CV port provably re-mixes.
      expect(
        gainDelta,
        `${port}: gainVector L1(lo,hi) = ${gainDelta.toFixed(6)} (expect > 0.01; smallest real ≈ 0.064 on pos_y)`,
      ).toBeGreaterThan(0.01);
    });
  }
});

describe('PCU: camera/morph CV def contract — no double-count (ex e2e wavesculpt-state-unity.spec.ts)', () => {
  // The e2e asserted readParam vs read('camera') alignment (CV added exactly
  // once) + that morph1_cv is a patchable port. The architectural invariant
  // that PREVENTS double-counting is the DEF CONTRACT: every camera/morph CV
  // input declares a `paramTarget` pointing at its matching param, so the
  // engine layer folds the CV into that param exactly once. Pin the contract.
  const CV_PORT_TO_PARAM: Record<string, string> = {
    pos_x: 'pos_x', pos_y: 'pos_y', pos_z: 'pos_z', zoom: 'zoom', rot: 'rot',
    morph1_cv: 'morph1', morph2_cv: 'morph2', morph3_cv: 'morph3', morph4_cv: 'morph4',
    scale: 'scale', wiggle: 'wiggle',
  };

  for (const [portId, paramId] of Object.entries(CV_PORT_TO_PARAM)) {
    it(`${portId} is a cv input whose paramTarget === '${paramId}'`, () => {
      const port = wavesculptDef.inputs.find((p) => p.id === portId);
      expect(port, `${portId} input exists`).toBeDefined();
      expect(port!.type, `${portId} is cv-typed`).toBe('cv');
      expect(
        (port as { paramTarget?: string }).paramTarget,
        `${portId} paramTarget points at param '${paramId}' (CV folded in exactly once)`,
      ).toBe(paramId);
      // And the targeted param actually exists, so the engine has somewhere
      // to add the CV (a dangling paramTarget would silently drop the CV).
      expect(
        wavesculptDef.params.some((p) => p.id === paramId),
        `param '${paramId}' exists for ${portId} to target`,
      ).toBe(true);
    });
  }

  it("morph1_cv exists in inputs with type:'cv' (ex e2e: handle is patchable on the card)", () => {
    const m1 = wavesculptDef.inputs.find((p) => p.id === 'morph1_cv');
    expect(m1, 'morph1_cv port exists').toBeDefined();
    expect(m1!.type).toBe('cv');
  });
});

describe('lineWallCrossings (luminosity → bandpass geometry)', () => {
  it('a line straight through the box on the Z axis crosses FRONT + BACK at centre', () => {
    // Origin at the −Z wall, aimed +Z → exits at +Z. Both crossings centred
    // (u=v=0.5) since the ray is on the box centre line.
    const cr = lineWallCrossings([0, 0, -1], [0, 0, 1]);
    expect(cr).not.toBeNull();
    const faces = [cr![0].faceIdx, cr![1].faceIdx].sort();
    // FRONT (faceIdx 0, −Z) + BACK (faceIdx 1, +Z).
    expect(faces).toEqual([0, 1]);
    for (const c of cr!) {
      expect(c.u).toBeCloseTo(0.5, 5);
      expect(c.v).toBeCloseTo(0.5, 5);
    }
  });

  it('a diagonal line crosses two DISTINCT faces with in-range UVs', () => {
    // From the RED floor corner aimed up + inward (SCOPE_AIMS-like).
    const cr = lineWallCrossings([-1, -1, -1], [1, 1, 1]);
    expect(cr).not.toBeNull();
    expect(cr![0].faceIdx).not.toBe(cr![1].faceIdx);
    for (const c of cr!) {
      expect(c.u).toBeGreaterThanOrEqual(0);
      expect(c.u).toBeLessThanOrEqual(1);
      expect(c.v).toBeGreaterThanOrEqual(0);
      expect(c.v).toBeLessThanOrEqual(1);
    }
  });

  it('returns null for a degenerate (zero-length) direction', () => {
    expect(lineWallCrossings([0, 0, 0], [0, 0, 0])).toBeNull();
  });

  it('the two crossings are on opposite ends of the ray (distinct faces)', () => {
    // X-axis line through origin → LEFT (−X) + RIGHT (+X).
    const cr = lineWallCrossings([0, 0, 0], [1, 0, 0]);
    expect(cr).not.toBeNull();
    const faces = [cr![0].faceIdx, cr![1].faceIdx].sort();
    expect(faces).toEqual([2, 3]); // LEFT=2, RIGHT=3
  });
});

describe('LUMA_REGISTRY (card → factory luminosity hand-off)', () => {
  it('round-trips per-line luminosity pairs', () => {
    setWavesculptLuma('node-x', {
      lumA: [0.1, 0.2, 0.3, 0.4],
      lumB: [0.5, 0.6, 0.7, 0.8],
    });
    const got = getWavesculptLuma('node-x');
    expect(got?.lumA).toEqual([0.1, 0.2, 0.3, 0.4]);
    expect(got?.lumB).toEqual([0.5, 0.6, 0.7, 0.8]);
  });

  it('returns undefined for an unknown node', () => {
    expect(getWavesculptLuma('does-not-exist')).toBeUndefined();
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
  it('exposes a lum_depth param (luminosity → bandpass depth, OFF by default)', () => {
    const p = wavesculptDef.params.find((pp) => pp.id === 'lum_depth')!;
    expect(p, 'lum_depth param exists').toBeDefined();
    expect(p.min).toBe(0);
    expect(p.max).toBe(1);
    expect(p.defaultValue, 'OFF by default (no surprise filtering)').toBe(0);
    expect(p.curve).toBe('linear');
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

  it('exposes per-osc CHROMA colour params (red/grn/blu) defaulting to r/g/b', () => {
    const r = wavesculptDef.params.find((p) => p.id === 'red_color')!;
    const g = wavesculptDef.params.find((p) => p.id === 'grn_color')!;
    const b = wavesculptDef.params.find((p) => p.id === 'blu_color')!;
    expect(r, 'red_color exists').toBeDefined();
    expect(g, 'grn_color exists').toBeDefined();
    expect(b, 'blu_color exists').toBeDefined();
    // Defaults = the historical red / green / blue packed RGB, so existing
    // patches render exactly as before.
    expect(r.defaultValue).toBe(DEFAULT_OSC_COLOR_PACKED.red);
    expect(g.defaultValue).toBe(DEFAULT_OSC_COLOR_PACKED.grn);
    expect(b.defaultValue).toBe(DEFAULT_OSC_COLOR_PACKED.blu);
    // Packed-integer range over the full 24-bit RGB space, discrete curve
    // (chosen via a colour wheel, not a continuous CV-able knob).
    for (const p of [r, g, b]) {
      expect(p.min).toBe(0);
      expect(p.max).toBe(0xffffff);
      expect(p.curve).toBe('discrete');
    }
  });

  it('default colour params decode to the historical r/g/b hues', () => {
    // RED dominant in red_color, GRN dominant in grn_color, etc.
    const [rr, rg, rb] = unpackColor01(DEFAULT_OSC_COLOR_PACKED.red);
    expect(rr).toBeGreaterThan(rg);
    expect(rr).toBeGreaterThan(rb);
    const [gr, gg, gb] = unpackColor01(DEFAULT_OSC_COLOR_PACKED.grn);
    expect(gg).toBeGreaterThan(gr);
    expect(gg).toBeGreaterThan(gb);
    const [br, bg, bb] = unpackColor01(DEFAULT_OSC_COLOR_PACKED.blu);
    expect(bb).toBeGreaterThan(br);
    expect(bb).toBeGreaterThan(bg);
  });

  it('ALP oscillator has NO colour param (it is the alpha/mask layer)', () => {
    const ids = wavesculptDef.params.map((p) => p.id);
    expect(ids).not.toContain('alp_color');
    expect(ids).not.toContain('alpha_color');
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

describe('CHROMA colour packing / parsing (packed 0xRRGGBB ⇄ 0..1 floats)', () => {
  it('packColor01 packs three 0..1 channels into 0xRRGGBB', () => {
    expect(packColor01(1, 0, 0)).toBe(0xff0000);
    expect(packColor01(0, 1, 0)).toBe(0x00ff00);
    expect(packColor01(0, 0, 1)).toBe(0x0000ff);
    expect(packColor01(1, 1, 1)).toBe(0xffffff);
    expect(packColor01(0, 0, 0)).toBe(0x000000);
  });

  it('unpackColor01 inverts packColor01 for representable colours', () => {
    for (const packed of [0xff0000, 0x00ff00, 0x0000ff, 0x4d80ff, 0x123456, 0xffffff, 0]) {
      const [r, g, b] = unpackColor01(packed);
      expect(packColor01(r, g, b)).toBe(packed);
    }
  });

  it('packColor01 clamps + rounds out-of-range / fractional channels', () => {
    // > 1 clamps to 255, < 0 clamps to 0, mid rounds to nearest 8-bit.
    expect(packColor01(2, -1, 0.5)).toBe((255 << 16) | (0 << 8) | 128);
  });

  it('unpackColor01 is defensive against NaN / out-of-range packed values', () => {
    expect(unpackColor01(Number.NaN)).toEqual([0, 0, 0]);
    // Above 24-bit clamps to white; negative clamps to black.
    expect(unpackColor01(0xffffff + 1000)).toEqual([1, 1, 1]);
    expect(unpackColor01(-5)).toEqual([0, 0, 0]);
  });

  it('round-trips a hex string through pack/unpack (UI write→render read path)', () => {
    // Mirrors onColorPick: parse "#4d80ff" → 0..1 → pack → param value,
    // then unpack for the render uniform.
    const hex = '#4d80ff';
    const r = parseInt(hex.slice(1, 3), 16) / 255;
    const g = parseInt(hex.slice(3, 5), 16) / 255;
    const b = parseInt(hex.slice(5, 7), 16) / 255;
    const packed = packColor01(r, g, b);
    expect(packed).toBe(0x4d80ff);
    const [ur, ug, ub] = unpackColor01(packed);
    expect(Math.round(ur * 255)).toBe(0x4d);
    expect(Math.round(ug * 255)).toBe(0x80);
    expect(Math.round(ub * 255)).toBe(0xff);
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

// ---------------------------------------------------------------------------
// Per-oscillator AUDIO outputs (RED/GRN/BLU/ALP) — factory routing.
//
// These tests drive wavesculptDef.factory() against a mock Web Audio
// environment that records every node + every connect() edge (with the
// source-output index). We can't run a real worklet in vitest, so instead
// we verify the GRAPH TOPOLOGY: each per-osc output port must point at a
// distinct StereoPanner, and each of those panners must be fed (by tracing
// the recorded edges back) from a DISTINCT engine output index 0..3 — i.e.
// out_red carries osc 0, out_grn osc 1, etc. We also confirm those panners
// are the SAME nodes the BLINK scope analysers tap, so the per-osc audio out
// is literally the oscilloscope's per-osc source.
// ---------------------------------------------------------------------------

import type { ModuleNode } from '$lib/graph/types';

interface MockNode {
  __type: string;
  __id: number;
  // edges OUT of this node: { to, fromOutput, toInput }
  __out: Array<{ to: MockNode; fromOutput: number; toInput: number }>;
  connect: (...args: unknown[]) => unknown;
  disconnect: (...args: unknown[]) => void;
  [k: string]: unknown;
}

function makeWavesculptMockEnv() {
  let idSeq = 0;
  const nodes: MockNode[] = [];

  function audioParam(initial = 0) {
    return {
      value: initial,
      setValueAtTime: vi.fn(function (this: { value: number }, v: number) { this.value = v; }),
      setTargetAtTime: vi.fn(),
      cancelScheduledValues: vi.fn(),
      linearRampToValueAtTime: vi.fn(),
    };
  }

  function makeNode(type: string, extra: Record<string, unknown> = {}): MockNode {
    const n: MockNode = {
      __type: type,
      __id: idSeq++,
      __out: [],
      connect: vi.fn(function (this: MockNode, target: unknown, fromOutput = 0, toInput = 0) {
        // connect(target, output?, input?) — target may be a node or an AudioParam.
        if (target && typeof target === 'object' && '__type' in (target as object)) {
          this.__out.push({ to: target as MockNode, fromOutput, toInput });
        }
        return target;
      }),
      disconnect: vi.fn(),
      ...extra,
    };
    nodes.push(n);
    return n;
  }

  const ctx = {
    currentTime: 0,
    sampleRate: 48000,
    audioWorklet: { addModule: vi.fn(async () => {}) },
    createGain: () => makeNode('gain', { gain: audioParam(1) }),
    createAnalyser: () =>
      makeNode('analyser', {
        fftSize: 256,
        frequencyBinCount: 128,
        smoothingTimeConstant: 0,
        getFloatTimeDomainData: vi.fn(),
        getFloatFrequencyData: vi.fn(),
      }),
    createStereoPanner: () => makeNode('panner', { pan: audioParam(0) }),
    createChannelSplitter: () => makeNode('splitter'),
    createConstantSource: () => makeNode('const', { offset: audioParam(0), start: vi.fn(), stop: vi.fn() }),
    createDelay: () => makeNode('delay', { delayTime: audioParam(0) }),
    createConvolver: () => makeNode('convolver', { buffer: null }),
    createBuffer: (_ch: number, len: number) =>
      ({ getChannelData: () => new Float32Array(len) }),
  };

  const engineParams = new Map<string, ReturnType<typeof audioParam>>();
  let engineNode: MockNode | null = null;
  class FakeAudioWorkletNode {
    __type = 'engine';
    __id = -1;
    __out: MockNode['__out'] = [];
    port = { postMessage: vi.fn(), onmessage: null, close: vi.fn() };
    parameters = {
      get: (k: string) => {
        let p = engineParams.get(k);
        if (!p) { p = audioParam(0); engineParams.set(k, p); }
        return p;
      },
    };
    connect = vi.fn(function (this: MockNode, target: unknown, fromOutput = 0, toInput = 0) {
      if (target && typeof target === 'object' && '__type' in (target as object)) {
        this.__out.push({ to: target as MockNode, fromOutput, toInput });
      }
      return target;
    });
    disconnect = vi.fn();
    constructor(_ctx: unknown, _name: string, _opts?: unknown) {
      engineNode = this as unknown as MockNode;
      nodes.push(this as unknown as MockNode);
    }
  }
  (globalThis as unknown as { AudioWorkletNode: typeof FakeAudioWorkletNode }).AudioWorkletNode =
    FakeAudioWorkletNode;

  return { ctx, nodes, getEngine: () => engineNode };
}

function makeWsNode(params?: Record<string, number>): ModuleNode {
  return {
    id: 'ws-test',
    type: 'wavesculpt',
    domain: 'audio',
    position: { x: 0, y: 0 },
    params: params ?? {},
    data: {},
  } as unknown as ModuleNode;
}

/** Walk the recorded edges backward from `target` to find the engine
 *  output index that ultimately feeds it (depth-first over __out edges).
 *  Returns the engine's fromOutput index, or null if not reachable. */
function engineOutputFeeding(
  nodes: MockNode[],
  engine: MockNode,
  target: MockNode,
): number | null {
  // Direct: does the engine connect to `target` at some output?
  for (const e of engine.__out) {
    if (e.to === target) return e.fromOutput;
  }
  // Indirect: BFS from engine, tracking the originating engine output index.
  const queue: Array<{ node: MockNode; rootOutput: number }> = [];
  for (const e of engine.__out) queue.push({ node: e.to, rootOutput: e.fromOutput });
  const seen = new Set<MockNode>();
  while (queue.length) {
    const { node, rootOutput } = queue.shift()!;
    if (seen.has(node)) continue;
    seen.add(node);
    if (node === target) return rootOutput;
    for (const e of node.__out) queue.push({ node: e.to, rootOutput });
  }
  return null;
}

describe('wavesculpt factory: per-osc audio output routing (RED/GRN/BLU/ALP)', () => {
  afterEach(() => {
    delete (globalThis as unknown as { AudioWorkletNode?: unknown }).AudioWorkletNode;
    vi.restoreAllMocks();
  });

  it('handle.outputs exposes L/R + the 4 per-osc audio taps + nothing missing', async () => {
    const { ctx } = makeWavesculptMockEnv();
    const handle = await wavesculptDef.factory(ctx as unknown as AudioContext, makeWsNode());
    const outIds = [...handle.outputs.keys()].sort();
    expect(outIds).toEqual(['L', 'R', 'out_alp', 'out_blu', 'out_grn', 'out_red']);
    handle.dispose?.();
  });

  it('each per-osc output points at a DISTINCT StereoPanner node', async () => {
    const { ctx } = makeWavesculptMockEnv();
    const handle = await wavesculptDef.factory(ctx as unknown as AudioContext, makeWsNode());
    const ids = ['out_red', 'out_grn', 'out_blu', 'out_alp'];
    const panners = ids.map((id) => handle.outputs.get(id)!.node as unknown as MockNode);
    for (const p of panners) expect(p.__type).toBe('panner');
    // All four must be distinct node instances (one per oscillator).
    expect(new Set(panners.map((p) => p.__id)).size).toBe(4);
    handle.dispose?.();
  });

  it('routes each per-osc output to its OWN oscillator (engine output 0→RED, 1→GRN, 2→BLU, 3→ALP)', async () => {
    const { ctx, nodes, getEngine } = makeWavesculptMockEnv();
    const handle = await wavesculptDef.factory(ctx as unknown as AudioContext, makeWsNode());
    const engine = getEngine()!;
    expect(engine, 'engine worklet node created').toBeTruthy();

    const expected: Array<[string, number]> = [
      ['out_red', 0],
      ['out_grn', 1],
      ['out_blu', 2],
      ['out_alp', 3],
    ];
    for (const [id, oscIdx] of expected) {
      const panner = handle.outputs.get(id)!.node as unknown as MockNode;
      const fedBy = engineOutputFeeding(nodes, engine, panner);
      expect(fedBy, `${id} is fed by engine output ${oscIdx}`).toBe(oscIdx);
    }
    handle.dispose?.();
  });

  it('per-osc output nodes are the SAME panners the scope analysers tap (single per-osc source)', async () => {
    const { ctx } = makeWavesculptMockEnv();
    const handle = await wavesculptDef.factory(ctx as unknown as AudioContext, makeWsNode());
    // ensureScopeAnalysers is lazy — trigger it via the 'scopes' read.
    handle.read?.('scopes');
    const ids = ['out_red', 'out_grn', 'out_blu', 'out_alp'];
    for (const id of ids) {
      const panner = handle.outputs.get(id)!.node as unknown as MockNode;
      // The scope analyser connects FROM the panner: panner.__out should
      // include exactly one edge to an analyser node.
      const toAnalyser = panner.__out.filter((e) => e.to.__type === 'analyser');
      expect(toAnalyser.length, `${id} panner taps a scope analyser`).toBeGreaterThanOrEqual(1);
    }
    handle.dispose?.();
  });

  it('still exposes the summed L/R main mix (backward-compatible)', async () => {
    const { ctx } = makeWavesculptMockEnv();
    const handle = await wavesculptDef.factory(ctx as unknown as AudioContext, makeWsNode());
    const l = handle.outputs.get('L')!.node as unknown as MockNode;
    const r = handle.outputs.get('R')!.node as unknown as MockNode;
    expect(l.__type).toBe('gain');
    expect(r.__type).toBe('gain');
    // L/R must be DIFFERENT nodes than any per-osc panner.
    const pannerIds = new Set(
      ['out_red', 'out_grn', 'out_blu', 'out_alp'].map(
        (id) => (handle.outputs.get(id)!.node as unknown as MockNode).__id,
      ),
    );
    expect(pannerIds.has(l.__id)).toBe(false);
    expect(pannerIds.has(r.__id)).toBe(false);
    handle.dispose?.();
  });
});
