// packages/web/src/lib/video/toybox-feedback.test.ts
//
// Pure-function coverage for the TOYBOX FEEDBACK node model: the 12-mode
// catalogue (FEEDBACK_MODES) + the param→uniform mapping (feedbackUniforms,
// clampFeedbackMode). The shader + ping-pong buffers are exercised by E2E/VRT
// (jsdom can't render); here we pin the data shape + clamp math so a regression
// (a dropped mode, an off-by-one id, a range that drifts from OP_PARAMS) fails a
// fast unit test.

import { describe, it, expect } from 'vitest';
import {
  FEEDBACK_MODES,
  FEEDBACK_MODE_COUNT,
  clampFeedbackMode,
  feedbackModeById,
  feedbackUniforms,
  feedbackResetState,
  FEEDBACK_MODE_PARAMS,
  feedbackParamsForMode,
  tunnelTap,
  simulateTunnel,
} from './toybox-feedback';
import { OP_PARAMS } from './toybox-combine-graph';

describe('FEEDBACK_MODES', () => {
  it('lists exactly 12 modes', () => {
    expect(FEEDBACK_MODES).toHaveLength(12);
    expect(FEEDBACK_MODE_COUNT).toBe(12);
  });
  it('ids are contiguous 0..11 and equal the array index (append-only contract)', () => {
    FEEDBACK_MODES.forEach((m, i) => expect(m.id).toBe(i));
  });
  it('every mode has a non-empty unique label', () => {
    const labels = FEEDBACK_MODES.map((m) => m.label);
    for (const l of labels) expect(l.length).toBeGreaterThan(0);
    expect(new Set(labels).size).toBe(labels.length);
  });
  it('includes the headline modes from the spec', () => {
    const byId = Object.fromEntries(FEEDBACK_MODES.map((m) => [m.id, m.label]));
    expect(byId[0]).toBe('TUNNEL');
    expect(byId[3]).toBe('ADDITIVE');
    expect(byId[9]).toBe('REACTION');
    expect(byId[11]).toBe('VECTOR');
  });
});

describe('clampFeedbackMode', () => {
  it('rounds + clamps into 0..11', () => {
    expect(clampFeedbackMode(0)).toBe(0);
    expect(clampFeedbackMode(11)).toBe(11);
    expect(clampFeedbackMode(11.4)).toBe(11);
    expect(clampFeedbackMode(2.6)).toBe(3);
    expect(clampFeedbackMode(-5)).toBe(0);
    expect(clampFeedbackMode(99)).toBe(11);
  });
  it('degrades non-finite / non-number to mode 0 (safe default, never NaN)', () => {
    expect(clampFeedbackMode(NaN)).toBe(0);
    expect(clampFeedbackMode(Infinity)).toBe(0); // non-finite → default 0 (not garbage)
    expect(clampFeedbackMode(undefined)).toBe(0);
    expect(clampFeedbackMode('3' as unknown)).toBe(0);
  });
  it('feedbackModeById returns the clamped mode def', () => {
    expect(feedbackModeById(3).label).toBe('ADDITIVE');
    expect(feedbackModeById(-1).id).toBe(0);
    expect(feedbackModeById(50).id).toBe(11);
  });
});

describe('feedbackUniforms', () => {
  it('fills every uniform from defaults when params are absent', () => {
    const u = feedbackUniforms(undefined);
    expect(u).toMatchObject({
      mode: 0,
      zoom: 0.95,
      rotate: 0,
      scaleP: 1,
      tx: 0,
      ty: 0,
      decay: 0.9,
      gain: 1,
      thresh: 0.5,
      hue: 0,
      blur: 1,
      slitPos: 0.5,
      slitWidth: 0.1,
      flow: 0,
      intensity: 0.5,
    });
  });
  it('passes through in-range values unchanged', () => {
    const u = feedbackUniforms({ mode: 5, zoom: 0.7, decay: 1.2, gain: 1.5, blur: 3, flow: 0.4 });
    expect(u.mode).toBe(5);
    expect(u.zoom).toBeCloseTo(0.7);
    expect(u.decay).toBeCloseTo(1.2);
    expect(u.gain).toBeCloseTo(1.5);
    expect(u.blur).toBeCloseTo(3);
    expect(u.flow).toBeCloseTo(0.4);
  });
  it('clamps out-of-range floats to the OP_PARAMS bounds', () => {
    const u = feedbackUniforms({ zoom: 2, decay: -1, gain: 99, thresh: 5, slitWidth: -3, blur: 100 });
    expect(u.zoom).toBe(1); // max .5..1
    expect(u.decay).toBe(0); // min 0..1.5
    expect(u.gain).toBe(2); // max 0..2
    expect(u.thresh).toBe(1); // max 0..1
    expect(u.slitWidth).toBe(0); // min 0..1
    expect(u.blur).toBe(4); // max 0..4
  });
  it('rounds + clamps mode (CV writes land as floats)', () => {
    expect(feedbackUniforms({ mode: 3.7 }).mode).toBe(4);
    expect(feedbackUniforms({ mode: -2 }).mode).toBe(0);
    expect(feedbackUniforms({ mode: 200 }).mode).toBe(11);
  });
  it('degrades non-finite floats to the default (never propagates NaN/Inf to GLSL)', () => {
    const u = feedbackUniforms({ zoom: NaN, gain: Infinity, rotate: NaN });
    expect(u.zoom).toBe(0.95);
    expect(u.gain).toBe(1); // non-finite → default (NOT clamped to max — Inf is unsafe)
    expect(u.rotate).toBe(0);
  });
  it('clamps the new intensity (wet/dry) param into 0..1 with a 0.5 default', () => {
    expect(feedbackUniforms(undefined).intensity).toBe(0.5); // default = half-wet
    expect(feedbackUniforms({ intensity: 0.3 }).intensity).toBeCloseTo(0.3); // in range
    expect(feedbackUniforms({ intensity: 2 }).intensity).toBe(1); // clamp max
    expect(feedbackUniforms({ intensity: -1 }).intensity).toBe(0); // clamp min
    expect(feedbackUniforms({ intensity: NaN }).intensity).toBe(0.5); // non-finite → default
  });

  // The uniform ranges/defaults MUST stay in lock-step with OP_PARAMS['feedback']
  // so a CV write (range-mapped against OP_PARAMS) and a manual knob land
  // identically. This guards the two sources of truth from drifting apart.
  it('default uniforms match OP_PARAMS["feedback"] defaults exactly', () => {
    const u = feedbackUniforms(undefined) as unknown as Record<string, number>;
    for (const def of OP_PARAMS.feedback) {
      expect(u[def.id], `default for ${def.id}`).toBe(def.default);
    }
  });
  it('clamp bounds match OP_PARAMS["feedback"] min/max for each float', () => {
    for (const def of OP_PARAMS.feedback) {
      if (def.id === 'mode') continue; // discrete — covered by clampFeedbackMode
      const lo = feedbackUniforms({ [def.id]: def.min - 1000 }) as unknown as Record<string, number>;
      const hi = feedbackUniforms({ [def.id]: def.max + 1000 }) as unknown as Record<string, number>;
      expect(lo[def.id], `${def.id} clamps to min`).toBe(def.min);
      expect(hi[def.id], `${def.id} clamps to max`).toBe(def.max);
    }
  });
});

// The "Reset feedback" menu action's load-bearing logic. The GL clear that
// blacks the ping-pong textures can only be observed in e2e/VRT, but THIS — the
// token diff that decides whether to clear this frame + which token to remember
// — is the pure carrier of the reset, and it must be deterministic. (The e2e
// pixel assertion on a recursive feedback is inherently racy: with a frozen
// iTime + static input, modes like TUNNEL re-converge to a UNIQUE fixed point,
// so a cleared buffer becomes byte-identical to the accumulated one within a few
// uncontrolled background frames — there is no reliable visual transient to
// catch. We prove the reset contract HERE instead.)
describe('feedbackResetState — the Reset-feedback token diff', () => {
  it('does NOT clear when the token is unchanged (steady state)', () => {
    expect(feedbackResetState(0, { mode: 0 })).toEqual({ clear: false, token: 0 });
    expect(feedbackResetState(3, { mode: 0, _reset: 3 })).toEqual({ clear: false, token: 3 });
  });

  it('clears on the frame the token increments, and remembers the new token', () => {
    // A fresh buffer (resetToken 0) sees the first bump → clear once.
    expect(feedbackResetState(0, { _reset: 1 })).toEqual({ clear: true, token: 1 });
    // Subsequent bumps each clear exactly once.
    expect(feedbackResetState(1, { _reset: 2 })).toEqual({ clear: true, token: 2 });
  });

  it('clears exactly once per bump (idempotent until the next bump)', () => {
    let token = 0;
    const params = { mode: 0, _reset: 0 };
    // No reset yet: many frames, never clears.
    for (let i = 0; i < 5; i++) {
      const r = feedbackResetState(token, params);
      expect(r.clear).toBe(false);
      token = r.token;
    }
    // Menu action bumps the token.
    params._reset = 1;
    const first = feedbackResetState(token, params);
    expect(first.clear).toBe(true); // the clear fires this frame
    token = first.token;
    // Every later frame at the SAME token must NOT re-clear (else the buffer
    // would be stuck black, never accumulating).
    for (let i = 0; i < 5; i++) {
      const r = feedbackResetState(token, params);
      expect(r.clear).toBe(false);
      token = r.token;
    }
  });

  it('treats absent / NaN / non-number _reset as token 0 (no spurious clear)', () => {
    expect(feedbackResetState(0, undefined)).toEqual({ clear: false, token: 0 });
    expect(feedbackResetState(0, null)).toEqual({ clear: false, token: 0 });
    expect(feedbackResetState(0, {})).toEqual({ clear: false, token: 0 });
    expect(feedbackResetState(0, { _reset: NaN })).toEqual({ clear: false, token: 0 });
    expect(feedbackResetState(0, { _reset: 'x' } as unknown as Record<string, number>)).toEqual({ clear: false, token: 0 });
    // A buffer that had been reset (token 2) then loses its _reset key → token
    // collapses to 0, which IS a change → one clear (safe: a corrupt/absent
    // param re-initialises the buffer rather than freezing stale state).
    expect(feedbackResetState(2, {})).toEqual({ clear: true, token: 0 });
  });
});

// The "Configure feedback" popover renders the per-mode relevant param subset.
// This map MUST stay in lock-step with the modes + the OP_PARAMS schema, or the
// popover would render knobs for params the engine doesn't read (or miss ones it
// does). Pure data → deterministic guard.
describe('FEEDBACK_MODE_PARAMS — per-mode relevant param subset', () => {
  const validIds = new Set(OP_PARAMS.feedback.map((p) => p.id));

  it('maps every one of the 12 modes (0..11)', () => {
    for (let m = 0; m < FEEDBACK_MODE_COUNT; m++) {
      expect(FEEDBACK_MODE_PARAMS[m], `mode ${m} mapped`).toBeDefined();
      expect(FEEDBACK_MODE_PARAMS[m]!.length, `mode ${m} non-empty`).toBeGreaterThan(0);
    }
  });

  it('only references real OP_PARAMS["feedback"] float param ids (never `mode`)', () => {
    for (const [m, ids] of Object.entries(FEEDBACK_MODE_PARAMS)) {
      for (const id of ids) {
        expect(validIds.has(id), `mode ${m} param "${id}" exists in schema`).toBe(true);
        expect(id, `mode ${m} must not list the discrete "mode"`).not.toBe('mode');
      }
    }
  });

  it('has no duplicate param ids within a mode', () => {
    for (const [m, ids] of Object.entries(FEEDBACK_MODE_PARAMS)) {
      expect(new Set(ids).size, `mode ${m} has no dupes`).toBe(ids.length);
    }
  });

  it('includes `decay` for every mode (the loop persistence is always relevant)', () => {
    for (let m = 0; m < FEEDBACK_MODE_COUNT; m++) {
      expect(FEEDBACK_MODE_PARAMS[m], `mode ${m} includes decay`).toContain('decay');
    }
  });

  it('exposes the new `intensity` (wet/dry) knob for the modes that use it', () => {
    // The shader reads uIntensity in TUNNEL(0), GEOMETRIC(1), COLOR(7),
    // DISPLACE(8), VECTOR(11); the popover must surface the knob for exactly
    // those so the wet/dry mix is reachable. (Owner: at least TUNNEL + GEOMETRIC.)
    for (const m of [0, 1, 7, 8, 11]) {
      expect(FEEDBACK_MODE_PARAMS[m], `mode ${m} exposes intensity`).toContain('intensity');
    }
    // TUNNEL + GEOMETRIC are the explicitly-required ones.
    expect(FEEDBACK_MODE_PARAMS[0]).toContain('intensity');
    expect(FEEDBACK_MODE_PARAMS[1]).toContain('intensity');
  });

  it('feedbackParamsForMode clamps + falls back safely', () => {
    expect(feedbackParamsForMode(0)).toEqual(FEEDBACK_MODE_PARAMS[0]);
    expect(feedbackParamsForMode(11)).toEqual(FEEDBACK_MODE_PARAMS[11]);
    // out-of-range / garbage → clamped to a valid mode, never empty
    expect(feedbackParamsForMode(999).length).toBeGreaterThan(0);
    expect(feedbackParamsForMode(-5).length).toBeGreaterThan(0);
    expect(feedbackParamsForMode(NaN).length).toBeGreaterThan(0);
    expect(feedbackParamsForMode('x' as unknown as number).length).toBeGreaterThan(0);
  });
});

// TUNNEL (mode 0) — the recursive Droste hall-of-mirrors. The bug this guards
// against: the old TUNNEL blended a flat fraction (0.12 + 0.5·src.a, i.e. up to
// ~62% for an opaque source) of the FULL-FRAME source into EVERY pixel, so the
// interior was dominated by the flat source colour — never a real tunnel. The
// fix makes the source enter ONLY at the new outer ring the zoom vacates, leaving
// the interior to pure recursive feedback (a camera pointed at its own monitor).
// These tests mirror the GLSL (FEEDBACK_FRAG_SRC `uMode == 0`) via the pure
// reference (tunnelTap / simulateTunnel) — keep them in lock-step.
describe('TUNNEL hall-of-mirrors (mode 0) — zero flat-source bleed in the interior', () => {
  const ZOOM = 0.95;   // default; zoom factor 1/0.95 ≈ 1.0526 (recedes inward)
  const DECAY = 0.9;   // default loop persistence
  const SRC: [number, number, number] = [1, 0, 0]; // flat opaque RED source

  it('tunnelTap: the centre samples the previous frame (interior), NOT the ring', () => {
    // Dead centre: d = 0 → fuv = centre → never leaves [0,1] → interior tap.
    const c = tunnelTap([0.5, 0.5], ZOOM, 0);
    expect(c.ring, 'centre is always interior (pure feedback, no source)').toBe(false);
    expect(c.fuv[0]).toBeCloseTo(0.5);
    expect(c.fuv[1]).toBeCloseTo(0.5);
  });

  it('tunnelTap: the extreme edge falls OUTSIDE the prev frame → the new ring (source)', () => {
    // Corner: d = (0.5,0.5); fuv = 0.5 + 0.5·1.0526 = 1.026 > 1 → ring.
    const corner = tunnelTap([1, 1], ZOOM, 0);
    expect(corner.ring, 'the zoom vacates an outer band → the live source enters there').toBe(true);
  });

  it('tunnelTap: a zoom factor > 1 sends interior taps FURTHER from centre (recede inward)', () => {
    // A point right of centre taps even further right last frame → content shrinks
    // toward the centre over frames (the Droste recession).
    const p = tunnelTap([0.7, 0.5], ZOOM, 0);
    expect(p.fuv[0]).toBeGreaterThan(0.7); // sampled further out than where it lands
    expect(p.ring).toBe(false);
  });

  it('the ring is a THIN outer band — the interior dominates the frame area', () => {
    // Count ring vs interior pixels over the whole grid at the default zoom.
    const size = 64;
    let ring = 0;
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const uv: [number, number] = [(x + 0.5) / size, (y + 0.5) / size];
        if (tunnelTap(uv, ZOOM, 0).ring) ring++;
      }
    }
    const frac = ring / (size * size);
    expect(frac, 'source enters only a thin outer ring').toBeLessThan(0.2);
    expect(frac, 'but the ring is non-empty (the loop always gets fresh content)').toBeGreaterThan(0);
  });

  // Mean RED over the central 25% region (the interior the old bug flooded).
  const meanInteriorRed = (uZoom: number, uDecay: number, frames = 60): number => {
    const size = 48;
    const buf = simulateTunnel(size, SRC, uZoom, 0, uDecay, frames);
    const lo = Math.floor(size * 0.375);
    const hi = Math.ceil(size * 0.625);
    let sum = 0;
    let n = 0;
    for (let y = lo; y < hi; y++) {
      for (let x = lo; x < hi; x++) {
        sum += buf[(y * size + x) * 3]!; // red channel
        n++;
      }
    }
    return sum / n;
  };

  it('THE FIX: at full wet, the INTERIOR is NOT dominated by the flat source colour', () => {
    // Drive the recursion with a flat opaque RED source (1,0,0) for many frames.
    // If the old "blend the full-frame source into every pixel" bug were present,
    // the interior would be ~flat red (R ≈ 1) everywhere. With the fix the source
    // only ever enters via the thin outer ring and is dimmed by DECAY as it
    // recedes, so the interior is FAR below the flat-source level — proof the flat
    // full-frame source does NOT own the interior. (At the default zoom the deep
    // interior is very dim recursive content; we assert it is nowhere near flat.)
    expect(
      meanInteriorRed(ZOOM, DECAY),
      'default-zoom interior is not flooded by the flat source (≈0, not ≈1)',
    ).toBeLessThan(0.3);

    // At a deeper-tunnel zoom the recursive nest actually FILLS the interior with
    // dimmed recursive content — present (>0, the hall-of-mirrors owns it) yet
    // still clearly below the flat source level (<<1 — the bug would read ≈1).
    const deep = meanInteriorRed(0.85, DECAY);
    expect(deep, 'recursive content fills the interior (the hall-of-mirrors)').toBeGreaterThan(0.05);
    expect(deep, 'but the interior is still NOT the flat full-frame source').toBeLessThan(0.85);
  });

  it('the OUTER RING does carry the live source (the source still enters somewhere)', () => {
    // The opposite guard: the source must NOT be eliminated entirely — it enters
    // at the ring. The top-left corner pixel is in the ring → flat source red ≈ 1.
    const size = 48;
    const buf = simulateTunnel(size, SRC, ZOOM, 0, DECAY, 60);
    expect(buf[0]!, 'the new outer ring shows the live source').toBeGreaterThan(0.8);
  });

  it('DECAY governs how deep/persistent the recursion is (a meaningful knob)', () => {
    // Higher decay → the receding nest stays brighter deeper in → a brighter
    // interior. Lower decay → it dims to the vanishing point faster (darker
    // interior). Proves DECAY still does something meaningful for TUNNEL. Use the
    // deeper-tunnel zoom where the interior is well-filled so the ordering is clear.
    expect(meanInteriorRed(0.85, 0.95)).toBeGreaterThan(meanInteriorRed(0.85, 0.6));
  });
});
