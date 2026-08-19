// packages/web/src/lib/ui/modules/mirrorpool-face-model.test.ts
//
// THE PERMANENT NEGATIVE CONTROLS for mirrorpool's one derived readout.
//
// The bar (module-faceplates.md): a derived readout is negative-controlled on
// the input a knob readback would be BLIND to, permanently — not once at
// authoring time. `mirrorpool-eye-place` is a JOIN over `orbit_el` and
// `orbit_dist` (the eye's horizontal radius is `dist·cos el`), so the control
// is that each dial moves it while the OTHER is held, and that nothing else on
// the module moves it at all.
//
// ⚠ THE READOUT THIS FILE DOES NOT DEFEND. The queue's §25.4 proposed an
// ABOVE/BELOW `eye-side` readout instead. It was refused because it is
// `sign(orbit_el)` relabelled — `eye.y = dist·sin el` and `dist` is clamped
// strictly positive — so no honest negative control exists for it. The sweep
// that establishes it is kept below as a permanent leg, because it is the
// reason this file's readout is shaped the way it is: if a later change ever
// made the sign depend on something else, that assumption should fail loudly
// rather than silently justify a readout nobody re-examined.

import { describe, it, expect } from 'vitest';
import {
  mirrorpoolEyePlace,
  mirrorpoolEyePlaceText,
  mirrorpoolCameraParams,
} from './mirrorpool-face-model';
import { mirrorpoolDef, MIRRORPOOL_DEFAULTS } from '$lib/video/modules/mirrorpool';
import { cameraBasis, POOL_RADIUS } from '$lib/video/mirrorpool-core';

/** A param reader over an explicit override map, defaulting to the def. */
function reader(over: Record<string, number> = {}) {
  return (id: string): number | undefined =>
    id in over ? over[id] : (MIRRORPOOL_DEFAULTS as Record<string, number>)[id];
}

/** A reader for a FRESH node — nothing written yet. */
const emptyReader = (): number | undefined => undefined;

describe('mirrorpool eye-place readout: the JOIN its two dials cannot each see', () => {
  it('reads OUTSIDE at the shipped defaults', () => {
    // The framing the module was designed around: above the water, beyond the
    // rim. If this ever changes, the module's first impression changed.
    expect(mirrorpoolEyePlaceText(reader())).toBe('OUTSIDE');
  });

  // ── The negative control, run in BOTH directions ────────────────────────
  it('MOVES on orbit_dist while orbit_el is held', () => {
    const el = MIRRORPOOL_DEFAULTS.orbit_el; // 0.55
    expect(mirrorpoolEyePlace(reader({ orbit_el: el, orbit_dist: 2.6 }))).toBe('OUTSIDE');
    expect(mirrorpoolEyePlace(reader({ orbit_el: el, orbit_dist: 1 }))).toBe('OVER');
    expect(mirrorpoolEyePlace(reader({ orbit_el: el, orbit_dist: 0.4 }))).toBe('OVER');
  });

  it('MOVES on orbit_el while orbit_dist is held — the half a dist readback is blind to', () => {
    // Same distance, three elevations, three different placements. A readout
    // of `orbit_dist` alone would print one number for all three.
    expect(mirrorpoolEyePlace(reader({ orbit_dist: 1, orbit_el: 0.55 }))).toBe('OVER');
    expect(mirrorpoolEyePlace(reader({ orbit_dist: 1, orbit_el: 0 }))).toBe('OUTSIDE');
    expect(mirrorpoolEyePlace(reader({ orbit_dist: 1, orbit_el: -0.55 }))).toBe('UNDER');
  });

  it('is INVARIANT to every other param on the module', () => {
    // Everything that is not orbit_el / orbit_dist: the other four camera
    // controls (which move the eye's direction or its position AROUND the
    // axis, never its height or radius) and all five weather/surface dials.
    const base = { orbit_el: 0.55, orbit_dist: 1 };
    const expected = mirrorpoolEyePlace(reader(base));
    const moved: string[] = [];
    const sweeps: Record<string, number[]> = {
      orbit_az: [-Math.PI, -1, 0, 1, Math.PI],
      look_yaw: [-Math.PI, 0, Math.PI],
      look_pitch: [-1.45, 0, 1.45],
      zoom: [0, 0.5, 1],
      wind_speed: [0, 0.3, 1],
      wind_dir: [-Math.PI, 0, Math.PI],
      rain: [0, 0.2, 1],
      brightness: [0, 1, 2],
      surface_mode: [0, 0.5, 1],
    };
    for (const [id, values] of Object.entries(sweeps)) {
      for (const v of values) {
        const got = mirrorpoolEyePlace(reader({ ...base, [id]: v }));
        if (got !== expected) moved.push(`${id}=${v} -> ${got} (expected ${expected})`);
      }
    }
    expect(moved, 'params that moved a readout derived from orbit_el + orbit_dist alone').toEqual([]);
  });

  // ── The two boundaries, which is where a plausible implementation is wrong ──
  it('orbit_el EXACTLY 0 is ABOVE the water, not under it', () => {
    // eye.y = dist·sin(0) = 0 BIT-EXACTLY, and the shader's underwater branch
    // is `eye.y < 0`. A readout written with `<=` would disagree with the
    // picture at exactly this point.
    const eye = cameraBasis(mirrorpoolCameraParams(reader({ orbit_el: 0 }))).eye;
    expect(eye[1], 'eye.y at orbit_el = 0').toBe(0);
    expect(mirrorpoolEyePlace(reader({ orbit_el: 0 }))).not.toBe('UNDER');
  });

  it('one ten-thousandth of a radian below zero IS under', () => {
    const eye = cameraBasis(mirrorpoolCameraParams(reader({ orbit_el: -0.0001 }))).eye;
    expect(eye[1]).toBeLessThan(0);
    expect(mirrorpoolEyePlace(reader({ orbit_el: -0.0001 }))).toBe('UNDER');
  });

  it('a radius EXACTLY on the rim reads OUTSIDE, not over', () => {
    // el = 0, dist = 1 → radius = 1·cos(0) = POOL_RADIUS exactly.
    const eye = cameraBasis(mirrorpoolCameraParams(reader({ orbit_el: 0, orbit_dist: 1 }))).eye;
    expect(Math.hypot(eye[0], eye[2]), 'horizontal radius at el=0, dist=1').toBe(POOL_RADIUS);
    expect(mirrorpoolEyePlace(reader({ orbit_el: 0, orbit_dist: 1 }))).toBe('OUTSIDE');
  });

  // ── Totality: the function runs on every render ─────────────────────────
  it('is TOTAL — a fresh node, NaN and ±Infinity all produce a state, never a throw', () => {
    expect(mirrorpoolEyePlaceText(emptyReader)).toBe('OUTSIDE'); // falls back to the def
    for (const bad of [NaN, Infinity, -Infinity]) {
      for (const id of ['orbit_el', 'orbit_dist', 'orbit_az', 'zoom', 'look_yaw', 'look_pitch']) {
        const text = mirrorpoolEyePlaceText(reader({ [id]: bad }));
        expect(['UNDER', 'OVER', 'OUTSIDE'], `${id}=${bad} produced ${text}`).toContain(text);
      }
    }
  });

  // ── The instrument's own control ────────────────────────────────────────
  it('the sweep it is measured over reaches all three states (instrument control)', () => {
    const seen = new Set(
      [
        { orbit_el: 0.55, orbit_dist: 2.6 },
        { orbit_el: 0.55, orbit_dist: 1 },
        { orbit_el: -0.55, orbit_dist: 1 },
      ].map((o) => mirrorpoolEyePlace(reader(o))),
    );
    expect(seen).toEqual(new Set(['OUTSIDE', 'OVER', 'UNDER']));
  });

  // ── The refuted readout, kept as a permanent leg ────────────────────────
  it('eye HEIGHT is sign-identical to orbit_el across every other camera input', () => {
    // This is why there is no ABOVE/BELOW readout: it would be one dial's sign
    // wearing a name. If this ever stops holding, the §25.4 proposal deserves
    // re-reading rather than staying refused on a stale measurement.
    const disagreements: string[] = [];
    for (const el of [1.45, 0.55, 0.0001, -0.0001, -0.55, -1.45]) {
      for (const az of [-Math.PI, 0, Math.PI]) {
        for (const dist of [0.4, 1, 2.6, 5]) {
          for (const lookYaw of [-Math.PI, 0, Math.PI]) {
            for (const lookPitch of [-1.45, 0, 1.45]) {
              for (const zoom of [0, 0.5, 1]) {
                const y = cameraBasis({ az, el, dist, lookYaw, lookPitch, zoom }).eye[1];
                if (y < 0 !== el < 0) {
                  disagreements.push(`el=${el} az=${az} dist=${dist} -> eye.y=${y}`);
                }
              }
            }
          }
        }
      }
    }
    expect(disagreements, 'camera settings where sign(eye.y) !== sign(orbit_el)').toEqual([]);
  });
});

describe('mirrorpool face declaration', () => {
  const face = mirrorpoolDef.face!;

  it('declares both camera pads, and both axes of each are ranked', () => {
    // module-face-lint enforces this too; asserted here because the PAIRING is
    // the point of the cell and a missing partner is silence, not an error.
    expect(face.xyPads?.map((p) => [p.x, p.y])).toEqual([
      ['orbit_az', 'orbit_el'],
      ['look_yaw', 'look_pitch'],
    ]);
    for (const pad of face.xyPads ?? []) {
      expect(face.order, `${pad.x} ranked`).toContain(pad.x);
      expect(face.order, `${pad.y} ranked`).toContain(pad.y);
    }
  });

  it('declares FADER for every non-pad control — the card draws throws, not dials', () => {
    // A face that does not declare them silently repaints all seven as knobs,
    // which is a look regression the shell cannot infer from a ParamDef.
    const padKeys = new Set((face.xyPads ?? []).flatMap((p) => [p.x, p.y]));
    const nonPad = mirrorpoolDef.params.map((p) => p.id).filter((id) => !padKeys.has(id));
    const undeclared = nonPad.filter((id) => face.paramCells?.[id] !== 'fader');
    expect(undeclared, 'non-pad params not declared as faders').toEqual([]);
  });

  it('routes its SCREEN toggle through the extension slot, not the card', () => {
    // The #1928 class: promotion deletes the card, so a toggle that lives only
    // there is deleted by the promotion meant to keep it.
    expect(face.extension).toBe('mirrorpool');
  });
});
