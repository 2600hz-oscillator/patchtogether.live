// packages/web/src/lib/ui/modules/wavesculpt-face-model.test.ts
//
// The permanent negative-control leg for WAVESCULPT's faceplate model.
//
// The bar (face-readout-values.ts): "a derived readout must be
// negative-controlled on the input a knob readback would be BLIND to,
// permanently — not once at authoring time." On this module the blind input is
// specific and nameable: `rot` reads 0.00 at spawn and 0.30 at the VRT scene's
// camera, and BOTH of those are positions where the BLUE voice is exactly
// silent. A `paramId: 'rot'` readout would print a confident number at every
// camera this face exists to describe and say nothing about any of them.
//
// So every readout below is checked in BOTH directions: it must MOVE on the
// input that matters, and it must NOT move on an input it has no business
// tracking.

import { describe, it, expect } from 'vitest';
import {
  WAVESCULPT_VOICES,
  WAVESCULPT_TAPS,
  ROOM_PLAN_EXTENT,
  wavesculptCamera,
  wavesculptCameraCaption,
  wavesculptDragToCamera,
  wavesculptEye,
  wavesculptGainText,
  wavesculptLiveCount,
  wavesculptLiveSpreadDb,
  wavesculptQuietest,
  wavesculptQuietestText,
  wavesculptRoomPlan,
  wavesculptScaleBites,
  wavesculptSpreadText,
  wavesculptTapCaption,
  wavesculptViewComboText,
  wavesculptVoiceGains,
  wavesculptVoicesLiveText,
  type WavesculptCamera,
} from './wavesculpt-face-model';
import {
  BLINK_MODE_OPTIONS,
  VIDEO_MODE_OPTIONS,
  WALL_LAYOUT,
  distanceGain,
  eyeFromCamera,
  wavesculptDef,
} from '$lib/audio/modules/wavesculpt';

/** The def's own defaults, never re-typed here. */
const SPAWN: WavesculptCamera = wavesculptCamera(() => undefined);

/** A reader over an explicit param bag, with everything else falling back to
 *  the def default — the same sparse-overlay shape `node.params` has. */
const reader =
  (bag: Record<string, number>) =>
  (id: string): number | undefined =>
    bag[id];

describe('wavesculpt face model — the camera', () => {
  it('resolves the DEF DEFAULT for every untouched axis (node.params is SPARSE)', () => {
    // The failure this guards is not cosmetic: coercing an untouched `zoom` to
    // 0 puts it outside its own declared 0.3..3 and draws a room nobody is in.
    expect(SPAWN).toEqual({ pos_x: 0, pos_y: 0, pos_z: 0, zoom: 1, rot: 0 });
    for (const [id, v] of Object.entries(SPAWN)) {
      expect(wavesculptDef.params.find((p) => p.id === id)?.defaultValue, id).toBe(v);
    }
  });

  it('reads a TOUCHED axis and leaves the rest at their defaults', () => {
    const cam = wavesculptCamera(reader({ zoom: 2.5 }));
    expect(cam).toEqual({ ...SPAWN, zoom: 2.5 });
  });

  it('the eye is the module’s OWN helper, not a re-derivation', () => {
    expect(wavesculptEye(SPAWN)).toEqual(eyeFromCamera(0, 0, 0, 1, 0));
    // …and at spawn that is 2.5 units out along +Z, which is the whole story.
    expect(wavesculptEye(SPAWN)).toEqual([0, 0, 2.5]);
  });
});

describe('wavesculpt face model — the four gains', () => {
  it('MEASURED at the spawn camera: BLUE is EXACTLY zero, the other three are not', () => {
    const g = wavesculptVoiceGains(SPAWN);
    // Recomputed through the same two exports the factory calls.
    expect(g).toEqual(WALL_LAYOUT.map((w) => distanceGain(w.src, w.vec, [0, 0, 2.5])));
    expect(g[0]).toBeCloseTo(5.3229e-2, 6); // RED
    expect(g[1]).toBeCloseTo(4.8029e-2, 6); // GREEN
    expect(g[2]).toBe(0); // BLUE — the eye stands directly behind it
    expect(g[3]).toBeCloseTo(7.0273e-2, 6); // ALPHA
  });

  it('BLUE is dark across 36.7 % of the ROT knob — it is not a knife edge', () => {
    // Sweep at fine resolution rather than the round steps a design note would
    // pick: an even lag against a symmetric function is exactly the sampling
    // that hides a boundary.
    //
    // ⚠ THE FACE SPEC SAID 74 %. The dead WINDOW is 0.74 wide (|rot| < 0.370)
    // but `rot` spans −1..+1, so the FRACTION is half that. This assertion is
    // the correction, pinned: 0.74 / 2.0 = 37 %.
    const N = 401;
    let dark = 0;
    for (let i = 0; i < N; i++) {
      const rot = -1 + (2 * i) / (N - 1);
      if (wavesculptVoiceGains({ ...SPAWN, rot })[2] === 0) dark++;
    }
    const frac = dark / N;
    expect(frac, `BLUE silent over ${(frac * 100).toFixed(1)} % of ROT`).toBeGreaterThan(0.35);
    expect(frac).toBeLessThan(0.39);
    // The measured boundary: dark at |rot| < 0.370, live just past it.
    expect(wavesculptVoiceGains({ ...SPAWN, rot: 0.36 })[2]).toBe(0);
    expect(wavesculptVoiceGains({ ...SPAWN, rot: 0.38 })[2]).toBeGreaterThan(0);
  });

  it('NEGATIVE CONTROL: the gains MOVE on zoom — BLUE comes back at zoom 3', () => {
    // If the derivation only read `rot` (the tempting shortcut) this leg is
    // where it dies: rot is held at its spawn value throughout.
    expect(wavesculptVoiceGains({ ...SPAWN, zoom: 2 })[2]).toBe(0);
    expect(wavesculptVoiceGains({ ...SPAWN, zoom: 3 })[2]).toBeGreaterThan(0.9);
  });

  it('NEGATIVE CONTROL: the gains are INVARIANT to master_gain (it is a bus trim)', () => {
    // `wavesculptCamera` never reads it, and this is the leg that keeps it that
    // way — a balance metric that tracked the output trim would be measuring
    // level, not balance.
    const a = wavesculptVoiceGains(wavesculptCamera(reader({ master_gain: 0 })));
    const b = wavesculptVoiceGains(wavesculptCamera(reader({ master_gain: 2 })));
    expect(a).toEqual(b);
    expect(a).toEqual(wavesculptVoiceGains(SPAWN));
  });
});

describe('wavesculpt face model — the three hero readouts', () => {
  it('voices live prints 3 of 4 at spawn', () => {
    expect(wavesculptVoicesLiveText(SPAWN)).toBe('3 of 4');
  });

  it('voices live MOVES on zoom with rot held — the knob-readback control', () => {
    // A `paramId: 'rot'` readout is CONSTANT across this pair. This one is not.
    expect(wavesculptVoicesLiveText({ ...SPAWN, zoom: 2 })).toBe('3 of 4');
    expect(wavesculptVoicesLiveText({ ...SPAWN, zoom: 3 })).toBe('4 of 4');
  });

  it('quietest names BLUE dark at spawn, and a DIFFERENT voice as the camera orbits', () => {
    expect(wavesculptQuietestText(SPAWN)).toBe('BLUE dark');
    // A readout stuck on BLUE would be reading the wall layout, not the camera.
    const names = new Set<string>();
    for (let i = 0; i <= 20; i++) {
      names.add(wavesculptQuietestText({ ...SPAWN, rot: -1 + i / 10 }).split(' ')[0]!);
    }
    expect(names.size, `quietest named ${[...names].join('/')} across a ROT sweep`).toBeGreaterThan(1);
  });

  it('quietest prints a real dB figure — never `dark` — where all four are live', () => {
    const all = { ...SPAWN, zoom: 3 };
    expect(wavesculptLiveCount(wavesculptVoiceGains(all))).toBe(4);
    expect(wavesculptQuietestText(all)).toMatch(/^(RED|GREEN|BLUE|ALPHA) -?\d+\.\d dB$/);
    expect(wavesculptQuietestText(all)).not.toContain('dark');
  });

  it('spread prints the LIVE span plus the dark count, and 3.31 dB at spawn', () => {
    expect(wavesculptSpreadText(SPAWN)).toBe('3.31 dB · 1 dark');
    expect(wavesculptLiveSpreadDb(wavesculptVoiceGains(SPAWN))).toBeCloseTo(3.31, 2);
  });

  it('spread MOVES on pos_y while voices-live does NOT — the two must be able to disagree', () => {
    // If they always agreed one of them would be redundant. pos_y is the only
    // axis that never changes the audible-voice count.
    const lo = { ...SPAWN, pos_y: -1 };
    const hi = { ...SPAWN, pos_y: 1 };
    expect(wavesculptVoicesLiveText(lo)).toBe(wavesculptVoicesLiveText(hi));
    expect(wavesculptSpreadText(lo)).not.toBe(wavesculptSpreadText(hi));
  });

  it('spread is INVARIANT to master_gain (negative control on the bus trim)', () => {
    const withTrim = wavesculptCamera(reader({ master_gain: 1.9 }));
    expect(wavesculptSpreadText(withTrim)).toBe(wavesculptSpreadText(SPAWN));
  });

  it('a gain of exactly zero reads `dark`, never `-Infinity dB`', () => {
    expect(wavesculptGainText(0)).toBe('dark');
    expect(wavesculptGainText(-0)).toBe('dark');
    expect(wavesculptGainText(1)).toBe('0.0 dB');
    expect(wavesculptGainText(0.5)).toBe('-6.0 dB');
  });
});

describe('wavesculpt face model — the VIEW × BLINK grid', () => {
  it('all NINE combinations render a distinct, named string', () => {
    const seen = new Set<string>();
    for (const v of VIDEO_MODE_OPTIONS) {
      for (const b of BLINK_MODE_OPTIONS) {
        const text = wavesculptViewComboText(reader({ video_mode: v.value, blink_mode: b.value }));
        expect(text, `${v.label} × ${b.label}`).toContain(v.label);
        expect(text).toContain(b.label);
        seen.add(text);
      }
    }
    expect(seen.size, 'nine combinations, nine captions').toBe(9);
  });

  it('BLINK is marked `idle` outside PROXIMITY — and only there', () => {
    // Measured against the card: `tick()` returns early for video_mode 1 and 2
    // before the WebGL path, so `drawScopes` (the only BLINK reader) is
    // unreachable from either.
    expect(wavesculptViewComboText(reader({ video_mode: 0, blink_mode: 1 }))).toBe(
      'PROXIMITY · SCOPES TRIAL',
    );
    expect(wavesculptViewComboText(reader({ video_mode: 1, blink_mode: 1 }))).toBe(
      'BIRDSEYE · SCOPES TRIAL idle',
    );
    expect(wavesculptViewComboText(reader({ video_mode: 2, blink_mode: 2 }))).toBe(
      'SPECTROGRAPH · REALITY BASED COMMUNITY idle',
    );
  });

  it('the combo defaults to the def’s own defaults with nothing touched', () => {
    expect(wavesculptViewComboText(() => undefined)).toBe('PROXIMITY · RIBBONS');
  });

  it('SCALE bites in exactly two of the nine cells', () => {
    const biting: string[] = [];
    for (const v of VIDEO_MODE_OPTIONS) {
      for (const b of BLINK_MODE_OPTIONS) {
        if (wavesculptScaleBites(v.value, b.value)) biting.push(`${v.label}/${b.label}`);
      }
    }
    expect(biting).toEqual(['PROXIMITY/SCOPES TRIAL', 'PROXIMITY/REALITY BASED COMMUNITY']);
  });
});

describe('wavesculpt face model — the room plan and its drag', () => {
  it('places every emitter from WALL_LAYOUT, never from a typed copy', () => {
    const plan = wavesculptRoomPlan(SPAWN);
    expect(plan.emitters).toHaveLength(WALL_LAYOUT.length);
    plan.emitters.forEach((e, i) => {
      expect(e.px).toBeCloseTo(WALL_LAYOUT[i]!.src[0] / ROOM_PLAN_EXTENT, 12);
      expect(e.py).toBeCloseTo(WALL_LAYOUT[i]!.src[2] / ROOM_PLAN_EXTENT, 12);
      expect(Math.hypot(e.dx, e.dy)).toBeCloseTo(1, 12);
    });
    expect(plan.emitters[2]!.dark, 'BLUE is drawn dark at spawn').toBe(true);
    expect(plan.emitters.filter((e) => e.dark)).toHaveLength(1);
  });

  it('the WALL tags are DERIVED — a layout edit cannot leave them stale', () => {
    expect(WAVESCULPT_VOICES.map((v) => `${v.label} ${v.wall}`)).toEqual([
      'RED +X wall · y −1.0',
      'GREEN −X wall · y −0.5',
      'BLUE +Z wall · y +0.0',
      'ALPHA −Z wall · y +0.5',
    ]);
  });

  it('the drag inverts eyeFromCamera EXACTLY — the marker lands where you drop it', () => {
    for (const zoom of [0.5, 1, 2, 3]) {
      for (const rot of [-0.7, 0, 0.4]) {
        const cam = { ...SPAWN, zoom, rot };
        const target = { px: 0.2, py: -0.35 };
        const next = wavesculptDragToCamera(cam, target.px, target.py);
        const eye = wavesculptEye({ ...cam, ...next });
        // Only assert the round trip where the target was actually reachable
        // (the params clamp at ±1, which is the boundary behaviour we want).
        if (Math.abs(next.pos_x) < 1 && Math.abs(next.pos_z) < 1) {
          expect(eye[0] / ROOM_PLAN_EXTENT).toBeCloseTo(target.px, 10);
          expect(eye[2] / ROOM_PLAN_EXTENT).toBeCloseTo(target.py, 10);
        }
      }
    }
  });

  it('the drag CLAMPS to the params’ declared range rather than writing out of it', () => {
    const out = wavesculptDragToCamera(SPAWN, -1, -1);
    expect(out.pos_x).toBeGreaterThanOrEqual(-1);
    expect(out.pos_z).toBeGreaterThanOrEqual(-1);
    for (const id of ['pos_x', 'pos_z'] as const) {
      const pd = wavesculptDef.params.find((p) => p.id === id)!;
      expect(out[id]).toBeGreaterThanOrEqual(pd.min);
      expect(out[id]).toBeLessThanOrEqual(pd.max);
    }
  });

  it('the eye marker is FLAGGED when the camera leaves the drawn frame', () => {
    expect(wavesculptRoomPlan(SPAWN).eyeClamped).toBe(false);
    // zoom 0.3 puts the eye 8.33 units out — well past the ±3 frame.
    expect(wavesculptRoomPlan({ ...SPAWN, zoom: 0.3 }).eyeClamped).toBe(true);
  });
});

describe('wavesculpt face model — the output tap', () => {
  it('every tap names a REAL declared output on the def', () => {
    const outs = new Set(wavesculptDef.outputs.map((o) => o.id));
    for (const t of WAVESCULPT_TAPS) {
      for (const p of t.ports.split(' + ')) {
        expect(outs.has(p), `${t.label} names '${p}'`).toBe(true);
      }
    }
  });

  it('the five tap captions are PAIRWISE DISTINCT — this is what makes the panel probe non-vacuous', () => {
    // faces-parity clicks a tap chip and demands the caption change. If two
    // chips could render the same string the probe would be a coin flip, which
    // is the "a control that only relabels itself" hole shell-cells warns about.
    const caps = WAVESCULPT_TAPS.map((t) => wavesculptTapCaption(SPAWN, t.id));
    expect(new Set(caps).size).toBe(caps.length);
    // …and at EVERY camera, not just spawn: two dark voices read the same gain.
    for (const zoom of [0.3, 1, 3]) {
      for (const rot of [-1, -0.4, 0, 0.4, 1]) {
        const c = WAVESCULPT_TAPS.map((t) => wavesculptTapCaption({ ...SPAWN, zoom, rot }, t.id));
        expect(new Set(c).size, `zoom ${zoom} rot ${rot}`).toBe(c.length);
      }
    }
  });

  it('a voice caption states PRE master gain and the mix caption states POST', () => {
    expect(wavesculptTapCaption(SPAWN, 'mix')).toContain('post master gain');
    expect(wavesculptTapCaption(SPAWN, 'blu')).toContain('pre master gain');
    expect(wavesculptTapCaption(SPAWN, 'blu')).toContain('out_blu');
    expect(wavesculptTapCaption(SPAWN, 'blu')).toContain('dark');
  });

  it('the camera caption prints BOTH spaces — knob and room are different numbers', () => {
    expect(wavesculptCameraCaption(SPAWN)).toBe('x +0.00  z +0.00  ·  eye +0.00, +2.50');
    // Moving the knob by 1 moves the eye by 1.5 — the factor nothing else shows.
    expect(wavesculptCameraCaption({ ...SPAWN, pos_x: 1 })).toBe(
      'x +1.00  z +0.00  ·  eye +1.50, +2.50',
    );
  });
});

describe('wavesculpt face model — totality', () => {
  it('every text formatter is TOTAL over a coarse sweep of the whole camera space', () => {
    // A FaceReadoutValue runs on every animation frame; a throw takes the
    // faceplate down and keeps it down.
    for (const pos_x of [-1, 0, 1]) {
      for (const pos_y of [-1, 0, 1]) {
        for (const pos_z of [-1, 0, 1]) {
          for (const zoom of [0.3, 1, 3]) {
            for (const rot of [-1, -0.5, 0, 0.5, 1]) {
              const cam = { pos_x, pos_y, pos_z, zoom, rot };
              for (const s of [
                wavesculptVoicesLiveText(cam),
                wavesculptQuietestText(cam),
                wavesculptSpreadText(cam),
                wavesculptCameraCaption(cam),
                ...WAVESCULPT_TAPS.map((t) => wavesculptTapCaption(cam, t.id)),
              ]) {
                expect(s.length, JSON.stringify(cam)).toBeGreaterThan(0);
                expect(s).not.toContain('NaN');
                expect(s).not.toContain('Infinity');
              }
            }
          }
        }
      }
    }
  });

  it('quietest resolves a TIE deterministically (two dark voices both read 0)', () => {
    expect(wavesculptQuietest([0, 0.5, 0, 0.2])).toEqual({ idx: 0, gain: 0 });
  });
});
