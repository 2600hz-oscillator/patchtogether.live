// art/scenarios/cube/slice-readout.test.ts
//
// ART scenario for CUBE — the 3D wavetable-navigator oscillator. Two layers:
//
//   1. Repo-standard build-toolchain pin: the compiled worklet artifact exists
//      + the built .sha still matches the source .ts (catches a stale dist/).
//   2. DETERMINISTIC per-config .f32 baselines: render the SURFACE-HEIGHT SCAN
//      slice waveform via the pure cube-dsp.sampleSlice() helper (the SAME math
//      the worklet runs per render block) through a synthetic floor/wall/ceiling
//      table set, for several canonical slice configs (axis-aligned, rotated,
//      morphed to ceiling, HARD material, CRUSHed, WRAP outside the cube), and
//      pin each rendered waveform as a .f32 baseline + a few qualitative
//      properties so a future DSP change surfaces as a waveform diff.
//
// On first run (or UPDATE_BASELINES=1) the .f32 baselines are written; later
// runs compare (RMS tier B). Regenerate with `npm run art:update -w art`.

import { describe, it, expect } from 'vitest';
import {
  sampleSlice,
  isDegenerateWave,
  CUBE_SLICE_SIZE,
  WAVETABLE_FRAME_SIZE,
  type SliceParams,
} from '../../../packages/dsp/src/lib/cube-dsp';
import {
  readBaseline,
  writeBaseline,
  compareBuffers,
  builtSha,
  moduleSourceSha,
  SHOULD_UPDATE_BASELINES,
} from '../../setup/render';

const FRAMES = 64;
const COLS = WAVETABLE_FRAME_SIZE; // 256

// ── Synthetic, hand-predictable tables (deterministic across runs/machines) ──

/** Flat table at a constant height. */
function constTable(value: number): Float32Array[] {
  const t: Float32Array[] = [];
  for (let f = 0; f < FRAMES; f++) t.push(new Float32Array(COLS).fill(value));
  return t;
}
/** Height ramps along the column axis (x = sample-phase): lo→hi. */
function rampInXTable(lo: number, hi: number): Float32Array[] {
  const t: Float32Array[] = [];
  for (let f = 0; f < FRAMES; f++) {
    const row = new Float32Array(COLS);
    for (let c = 0; c < COLS; c++) row[c] = lo + (hi - lo) * (c / (COLS - 1));
    t.push(row);
  }
  return t;
}
/** A single sinusoidal relief along x (one cycle), frame-independent. */
function sineInXTable(): Float32Array[] {
  const t: Float32Array[] = [];
  for (let f = 0; f < FRAMES; f++) {
    const row = new Float32Array(COLS);
    for (let c = 0; c < COLS; c++) row[c] = Math.sin((2 * Math.PI * c) / COLS);
    t.push(row);
  }
  return t;
}

// Fixed table set used by every config so the baselines are comparable.
const FLOOR = constTable(-1.0); // floorH = 0.0
const WALL = sineInXTable(); //    wallH  = sinusoidal relief across x
const CEIL = rampInXTable(-1, 1); // ceilH ramps 0→1 across x

const baseSlice = (over: Partial<SliceParams> = {}): SliceParams => ({
  sliceY: 0.5,
  rx: 0,
  ry: 0,
  rz: 0,
  morphFC: 0,
  connect: 0,
  material: 'smooth',
  crush: 0,
  wrap: false,
  ...over,
});

const CONFIGS: Array<{ id: string; sp: SliceParams; depthOffset?: number }> = [
  { id: 'axis-aligned',  sp: baseSlice() },
  { id: 'rotated',       sp: baseSlice({ rx: 0.7, ry: 0.4, rz: 0.2 }) },
  { id: 'morph-ceiling', sp: baseSlice({ morphFC: 1 }) },
  { id: 'connect-vee',   sp: baseSlice({ connect: 1, morphFC: 0.5 }) },
  { id: 'hard-material',  sp: baseSlice({ material: 'hard', morphFC: 0.5 }) },
  // ── RESTORED. 'crushed' and 'space-diffuse-max' (below) were removed as
  // "byte-identical duplicates" flagged by the baseline-uniqueness guard, with
  // a note that both extremes collapsing to the DC floor "may be worth a DSP
  // review". They were duplicates because they were BOTH the constant −1.0 —
  // the uniqueness guard was reporting a real DSP fault as a baseline-hygiene
  // problem, and deleting the baselines removed the only artifact that would
  // have caught it coming back.
  //
  // The endpoints are now capped (CUBE_CRUSH_MIN_LEVELS / CUBE_DIFFUSE_MAX_PULL)
  // so both render real waveforms and are distinct from each other again. These
  // two baselines are the regression pin for the DC faults: if either endpoint
  // ever collapses again, they go red as a waveform diff rather than
  // disappearing into a duplicate-baseline exemption.
  { id: 'crushed',       sp: baseSlice({ crush: 1 }) },
  { id: 'wrap-outside',  sp: baseSlice({ sliceY: 1.4, wrap: true }) },
  { id: 'spread-right',  sp: baseSlice({ rx: 0.7 }), depthOffset: 0.05 },
  // ── SPACE CRUSH — voxelize the field LOOKUP coords (independent of CRUSH). ──
  { id: 'space-crush-mid',       sp: baseSlice({ spaceCrush: 0.5, morphFC: 0.5 }) },
  { id: 'space-crush-max',       sp: baseSlice({ spaceCrush: 1, morphFC: 0.5 }) },
  { id: 'space-crush-and-crush', sp: baseSlice({ spaceCrush: 0.6, crush: 0.6 }) },
  // ── SPACE DIFFUSE — gravity toward the emptiest wall (latched target). ──
  { id: 'space-diffuse-mid',     sp: baseSlice({ spaceDiffuse: 0.5, morphFC: 0.5 }) },
  // Restored alongside 'crushed' — see the note there.
  { id: 'space-diffuse-max',     sp: baseSlice({ spaceDiffuse: 1 }) },
  { id: 'space-diffuse-rotated', sp: baseSlice({ spaceDiffuse: 0.7, rx: 0.7, ry: 0.4 }) },
  { id: 'space-diffuse-wrap',    sp: baseSlice({ spaceDiffuse: 0.7, wrap: true, morphFC: 0.5 }) },
  // ── CONNECT STRENGTH — overshoot the connector's interior control point. ──
  { id: 'connect-strength-circle', sp: baseSlice({ connect: 0, connectStrength: 1, morphFC: 0.5 }) },
  { id: 'connect-strength-vee',    sp: baseSlice({ connect: 1, connectStrength: 1, morphFC: 0.5 }) },
  { id: 'connect-strength-hard',   sp: baseSlice({ connect: 0.5, connectStrength: 1, material: 'hard', morphFC: 0.5 }) },
];

describe('cube / build-toolchain pin', () => {
  it('built artifact SHA matches the source SHA (refresh dist/ if it fails)', async () => {
    const src = await moduleSourceSha('cube');
    const built = await builtSha('cube');
    expect(built, 'forgot `task dsp:build`?').toBe(src);
  });
});

describe('cube / surface-height slice readout — deterministic baselines', () => {
  for (const { id, sp, depthOffset } of CONFIGS) {
    it(`${id}: length 256, in [-1,1], matches .f32 baseline`, async () => {
      const wave = sampleSlice(FLOOR, WALL, CEIL, sp, depthOffset ?? 0);
      expect(wave.length).toBe(CUBE_SLICE_SIZE);
      for (const v of wave) {
        expect(v).toBeGreaterThanOrEqual(-1);
        expect(v).toBeLessThanOrEqual(1);
        expect(Number.isFinite(v)).toBe(true);
      }

      const scenarioId = `cube/${id}`;
      const existing = await readBaseline(scenarioId);
      if (SHOULD_UPDATE_BASELINES || !existing) {
        await writeBaseline(scenarioId, wave);
        return;
      }
      const cmp = compareBuffers(wave, existing, 'B');
      expect(cmp.pass, cmp.detail).toBe(true);
    });
  }

  it('CRUSH at k=1 produces far fewer distinct levels than the clean slice', () => {
    const clean = sampleSlice(FLOOR, WALL, CEIL, baseSlice());
    const crushed = sampleSlice(FLOOR, WALL, CEIL, baseSlice({ crush: 1 }));
    const lv = (w: Float32Array) => new Set(Array.from(w).map((v) => Math.round(v * 1e4))).size;
    expect(lv(crushed)).toBeLessThan(lv(clean));
    // …but FEWER is not ONE. "Maximally crushed" must still be a waveform, not
    // a DC step — the fault that made this config's baseline get deleted.
    expect(lv(crushed), 'crush at maximum must still be a signal').toBeGreaterThan(1);
  });

  it('neither ENDPOINT collapses to the DC floor (the fault the baselines pin)', () => {
    // Stated as a property beside the baselines, because a .f32 comparison can
    // only catch a CHANGE — it cannot tell you the pinned wave was garbage. The
    // deleted baselines were "stable" for exactly as long as they were wrong.
    for (const [id, sp] of [
      ['crushed', baseSlice({ crush: 1 })],
      ['space-diffuse-max', baseSlice({ spaceDiffuse: 1 })],
    ] as const) {
      const w = sampleSlice(FLOOR, WALL, CEIL, sp);
      expect(isDegenerateWave(w), `${id} renders a constant — the DC fault is back`).toBe(false);
    }
    // …and the two are not each other, which is why they were culled before.
    const a = sampleSlice(FLOOR, WALL, CEIL, baseSlice({ crush: 1 }));
    const b = sampleSlice(FLOOR, WALL, CEIL, baseSlice({ spaceDiffuse: 1 }));
    let differs = false;
    for (let i = 0; i < a.length; i++) if (Math.abs(a[i]! - b[i]!) > 1e-6) { differs = true; break; }
    expect(differs, 'the two endpoint baselines must be distinct waveforms').toBe(true);
  });

  it('HARD material differs from SMOOTH for the same patch', () => {
    const smooth = sampleSlice(FLOOR, WALL, CEIL, baseSlice({ morphFC: 0.5 }));
    const hard = sampleSlice(FLOOR, WALL, CEIL, baseSlice({ morphFC: 0.5, material: 'hard' }));
    let differs = false;
    for (let i = 0; i < smooth.length; i++) {
      if (Math.abs(smooth[i]! - hard[i]!) > 1e-6) { differs = true; break; }
    }
    expect(differs).toBe(true);
  });

  it('an out-of-cube slice without WRAP reads the silent DC floor (-1)', () => {
    const silent = sampleSlice(FLOOR, WALL, CEIL, baseSlice({ sliceY: 5 }));
    for (const v of silent) expect(v).toBeCloseTo(-1, 6);
    // …and WRAP lifts it off the floor somewhere (the field gets sampled).
    const wrapped = sampleSlice(FLOOR, WALL, CEIL, baseSlice({ sliceY: 1.4, wrap: true }));
    let maxW = -Infinity;
    for (const v of wrapped) maxW = Math.max(maxW, v);
    expect(maxW).toBeGreaterThan(-1 + 0.01);
  });
});
