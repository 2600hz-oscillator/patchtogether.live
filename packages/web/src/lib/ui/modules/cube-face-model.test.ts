// packages/web/src/lib/ui/modules/cube-face-model.test.ts
//
// The PERMANENT negative controls behind cube's faceplate.
//
// Every number this face prints is DERIVED, and a derived readout is only worth
// more than a relabelled knob if it is negative-controlled on the input the
// knob readback would be BLIND to — permanently, on every run, not once at
// authoring time. That is the whole content of this file, plus one more leg
// the cube face specifically needs:
//
// ⚠ THE FACE'S OWN PROSE CITES MEASURED NUMBERS, AND THIS FILE RE-DERIVES THEM
// FROM THE REAL DSP. cube's pre-#1448 defect list was partly repaired by the
// DSP wave that preceded this face — CRUSH and SPACE DIFFUSE no longer collapse
// to DC at their maximum, and the two-table pigeonhole that killed CONNECT is
// gone — so a face copied from that spec would have documented three REPAIRED
// controls as broken. Worse than saying nothing. The claims below run
// `sampleSlice` over the shipped default tables, so if the DSP moves again the
// face's prose goes red instead of going stale.

import { describe, it, expect } from 'vitest';
import {
  sampleSlice,
  isDegenerateWave,
  CUBE_SPREAD_DEPTH,
  type SliceParams,
} from '../../../../../dsp/src/lib/cube-dsp';
import { getFactoryTable, getFactoryTables } from '$lib/audio/wavetable-factory-tables';
import { CUBE_DEFAULT_TABLES, cubeDef } from '$lib/audio/modules/cube';
import { shellCellFor } from '$lib/ui/workflow/shell-cells';
import { resolveFaceControl } from '$lib/ui/workflow/curated-face';
import {
  CUBE_FLAT_TILT_DEG,
  cubeCutTiltDeg,
  cubeFaceParams,
  cubeHeroCaption,
  cubeHeroWave,
  cubeSliceParams,
  cubeWaveSignature,
  cubeWaveStats,
} from './cube-face-model';

// ── the reader every readout is driven through ─────────────────────────────
//
// It resolves the DEF DEFAULT for anything the caller does not override, which
// is exactly what ModuleShell's own reader does — so a readout that only works
// on a fully-populated params map cannot pass here and fail in the dock.
function read(over: Record<string, number> = {}): (id: string) => number | undefined {
  return (id) => {
    if (id in over) return over[id];
    return cubeDef.params.find((p) => p.id === id)?.defaultValue;
  };
}
const value = (id: string, over: Record<string, number> = {}): string =>
  faceReadoutValueFor(id)!(read(over));

// ── the DSP, at the shipped defaults ───────────────────────────────────────
const FLOOR = getFactoryTable(CUBE_DEFAULT_TABLES.floor)!.frames;
const WALL = getFactoryTable(CUBE_DEFAULT_TABLES.wall)!.frames;
const CEIL = getFactoryTable(CUBE_DEFAULT_TABLES.ceiling)!.frames;
const BASE: SliceParams = {
  sliceY: 0.5, rx: 0, ry: 0, rz: 0,
  morphFC: 0, connect: 0, connectStrength: 0,
  crush: 0, spaceCrush: 0, spaceDiffuse: 0,
  material: 'smooth', wrap: false,
};
const render = (over: Partial<SliceParams>): Float32Array =>
  sampleSlice(FLOOR, WALL, CEIL, { ...BASE, ...over }, 0);
function rmsDelta(a: Float32Array, b: Float32Array): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += ((a[i] ?? 0) - (b[i] ?? 0)) ** 2;
  return Math.sqrt(s / a.length);
}
function maxAbsDiff(a: Float32Array, b: Float32Array): number {
  let m = 0;
  for (let i = 0; i < a.length; i++) m = Math.max(m, Math.abs((a[i] ?? 0) - (b[i] ?? 0)));
  return m;
}
/** Max rmsΔ across the whole of `slice_y` at one plane orientation. */
function yAuthority(rx: number, ry: number): number {
  const ref = render({ rx, ry, sliceY: 0.5 });
  let max = 0;
  for (let i = 0; i <= 40; i++) max = Math.max(max, rmsDelta(ref, render({ rx, ry, sliceY: i / 40 })));
  return max;
}
/** …the same, turned only about Z (which does NOT tilt the plane — see below). */
function yAuthorityRz(rz: number): number {
  const ref = render({ rz, sliceY: 0.5 });
  let max = 0;
  for (let i = 0; i <= 40; i++) max = Math.max(max, rmsDelta(ref, render({ rz, sliceY: i / 40 })));
  return max;
}

describe('cube face — the instrument itself', () => {
  it('sampleSlice is deterministic, and rmsΔ MOVES on the thing it measures', () => {
    // The negative control on the measuring stick, before any claim made with
    // it. A metric that cannot move is a metric that will report anything.
    expect(maxAbsDiff(render({}), render({}))).toBe(0);
    expect(rmsDelta(render({}), render({ ry: 1e-3 }))).toBeGreaterThan(1e-3);
  });
});

describe('cube face — `cube-y-live`, the readout a knob readback cannot be', () => {
  // THE MODULE'S SINGLE MOST IMPORTANT FACT. `slice_y` is a real control that
  // is inert in exactly ONE state — the state cube spawns in — because the ray
  // march integrates over a window CENTRED ON THE RAY ORIGIN, so sliding the
  // plane along its own normal moves the window and its contents together, and
  // at spawn the normal IS the axis Y translates along.

  it('THE DSP CLAIM: Y is weak flat and strong tilted (re-derived, not quoted)', () => {
    const flat = yAuthority(0, 0);
    const tilted = yAuthority(0.8, 0);
    expect(flat, `flat Y authority = ${flat.toFixed(5)}`).toBeLessThan(0.2);
    expect(tilted, `tilted Y authority = ${tilted.toFixed(5)}`).toBeGreaterThan(0.6);
    expect(
      tilted / flat,
      `tilting the plane must multiply Y's authority (flat ${flat.toFixed(5)} → ` +
        `rx 0.8 ${tilted.toFixed(5)}); if this ratio collapses the face's whole ` +
        `"asleep / live" story is no longer true and the readout must be re-argued`,
    ).toBeGreaterThan(4);
  });

  it('the FLAT threshold is a statement about the normal, not a taste', () => {
    // At the threshold the normal's z component is still ~0.99996, i.e. Y is a
    // normal-translation to four decimals. Both sides of the boundary asserted
    // so a widened threshold cannot pass silently.
    const justUnder = cubeFaceParams(read({ slice_ry: 0.008 }));
    const justOver = cubeFaceParams(read({ slice_ry: 0.02 }));
    expect(cubeCutTiltDeg(justUnder)).toBeLessThan(CUBE_FLAT_TILT_DEG);
    expect(cubeCutTiltDeg(justOver)).toBeGreaterThan(CUBE_FLAT_TILT_DEG);
    expect(Math.cos((CUBE_FLAT_TILT_DEG * Math.PI) / 180)).toBeGreaterThan(0.9999);
  });
});

describe('cube face — `cube-crush-levels` and the DC fault that is NO LONGER THERE', () => {

  it('NEGATIVE CONTROL: the guard still catches a genuinely degenerate wave', () => {
    // Otherwise the assertion above is only evidence that `isDegenerateWave`
    // returns false for everything.
    expect(isDegenerateWave(new Float32Array(256).fill(-1))).toBe(true);
    expect(isDegenerateWave(new Float32Array(256))).toBe(true);
  });

  it('THE REPAIRED DEFECT: space_diffuse at 1.0 is AUDIO, not a DC step', () => {
    const s = cubeWaveStats(render({ spaceDiffuse: 1 }));
    expect(s.acRms, `space_diffuse=1 acRms=${s.acRms.toFixed(6)}`).toBeGreaterThan(0.1);
    expect(isDegenerateWave(render({ spaceDiffuse: 1 }))).toBe(false);
  });
});

describe('cube face — the hero caption', () => {
  it('reports the DC-over-audio ratio the ports actually carry', () => {
    // cube's L and R carry MORE DC THAN SIGNAL at the defaults, and nothing
    // else in the module says so.
    const s = cubeWaveStats(render({}));
    expect(Math.abs(s.dc) / s.acRms, `|DC|/acRms = ${(Math.abs(s.dc) / s.acRms).toFixed(3)}`)
      .toBeGreaterThan(1);
    expect(cubeHeroCaption(s)).toMatch(/DC -?\d\.\d{3} \(\d+\.\d{2}× the audio\)/);
  });

  it('WRAP is the control that re-centres it — the caption shows the move', () => {
    const off = cubeWaveStats(render({}));
    const on = cubeWaveStats(render({ wrap: true }));
    expect(Math.abs(on.dc) / on.acRms).toBeLessThan(Math.abs(off.dc) / off.acRms / 4);
    expect(on.solidPct).toBeGreaterThan(off.solidPct);
  });

  it('the caption is computed WITHOUT an engine, and is not empty at rest', () => {
    // The reason it is a pure mirror: a suspended graph (every VRT face
    // capture) has no posted snapshot, so a tapped caption would read `—` in
    // exactly the frames a baseline is taken.
    const w = cubeHeroWave(cubeFaceParams(read()), FLOOR, WALL, CEIL);
    expect(w.length).toBe(256);
    expect(cubeHeroCaption(cubeWaveStats(w))).toMatch(/^solid \d+\.\d %/);
  });

  it('a degenerate wave is NAMED, not divided by zero', () => {
    expect(cubeHeroCaption(cubeWaveStats(new Float32Array(256).fill(-1)))).toContain('NO audio');
  });
});

describe('cube face — the claims the face PROSE makes about the DSP', () => {
  it('the SLICE outranks the SOLID, which is the whole band order', () => {
    const spawn = render({});
    let ry = 0;
    for (let i = 0; i <= 40; i++) {
      ry = Math.max(ry, rmsDelta(spawn, render({ ry: -Math.PI + (i / 40) * 2 * Math.PI })));
    }
    const morph = rmsDelta(render({ morphFC: 0 }), render({ morphFC: 1 }));
    expect(ry / morph, `slice_ry ${ry.toFixed(3)} vs morph_fc ${morph.toFixed(3)}`).toBeGreaterThan(3);
  });

  it('`slice_rx` is bit-exactly π-periodic — the reason it is NOT in the lane', () => {
    for (const a of [0.3, 0.7, 1.1, 1.5, 2.5, 3.0]) {
      expect(rmsDelta(render({ rx: a }), render({ rx: a - Math.PI })), `rx=${a}`).toBe(0);
    }
    // ⚠ THE CONTROL LEG. Without it the six zeros above are equally consistent
    // with "the renderer ignores every rotation".
    for (const a of [0.7, 1.5, 2.5]) {
      expect(rmsDelta(render({ ry: a }), render({ ry: a - Math.PI })), `ry=${a}`).toBeGreaterThan(0.2);
    }
    // …and it is NOT even, which is why the range cannot simply be halved
    // without also re-mapping every saved patch.
    expect(rmsDelta(render({ rx: 0.7 }), render({ rx: -0.7 }))).toBeGreaterThan(0.05);
  });

  it('THE PIGEONHOLE IS FIXED — all three default slots differ and nothing is dead', () => {
    const s = new Set(Object.values(CUBE_DEFAULT_TABLES));
    expect(s.size, 'three DISTINCT default tables').toBe(3);
    expect(rmsDelta(render({ morphFC: 0 }), render({ morphFC: 1 }))).toBeGreaterThan(0.05);
    for (const m of [0, 1]) {
      expect(
        maxAbsDiff(render({ morphFC: m, connect: 0 }), render({ morphFC: m, connect: 1 })),
        `CONNECT must be alive at morph=${m} (it was bit-exactly 0 on the old two-table defaults)`,
      ).toBeGreaterThan(0.05);
      expect(
        maxAbsDiff(
          render({ morphFC: m, connect: 0.5, connectStrength: 0 }),
          render({ morphFC: m, connect: 0.5, connectStrength: 1 }),
        ),
        `CONNECT STRENGTH must be alive at morph=${m}`,
      ).toBeGreaterThan(0.05);
    }
  });

  it('SPACE DIFFUSE is non-monotonic — the grain band says so, so it must stay true', () => {
    // The band hint states this. If the DSP is ever smoothed, the hint becomes
    // a lie and this goes red.
    const at = (k: number) => cubeWaveStats(render({ spaceDiffuse: k })).acRms;
    expect(at(0.9)).toBeLessThan(at(0.5));
    expect(at(1.0)).toBeGreaterThan(at(0.9));
  });
});

describe('cube face — the WAVE SIGNATURE that gates the 1.4 ms hero scan', () => {
  // `cubeHeroWave` is the real 256-ray x 96-step scan: 1.421 ms measured. The
  // hero's `$derived` chain re-runs on every node-version bump — ~60 a second
  // during any drag — so it is gated on this signature. Both failure modes are
  // invisible from the UI and opposite:
  //
  //   too COARSE (misses a param the wave reads) -> the caption FREEZES on that
  //     param. It still prints three plausible numbers. Nothing looks wrong.
  //   too FINE (includes a param the wave ignores) -> the gate does nothing and
  //     85 ms/s of main thread goes to recomputing an identical answer, most
  //     visibly while dragging THIS PANEL'S OWN orbit affordance.
  //
  // So both directions are asserted, over the whole declared param list rather
  // than a hand-picked few.

  /** Every param whose value `cubeHeroWave` genuinely reads. */
  const WAVE_PARAMS = [
    'slice_y', 'slice_rx', 'slice_ry', 'slice_rz',
    'morph_fc', 'connect', 'connect_strength',
    'crush', 'space_crush', 'space_diffuse',
    'material', 'wrap', 'fold',
  ];
  const sig = (over: Record<string, number> = {}) => cubeWaveSignature(cubeFaceParams(read(over)));

  it('is INVARIANT to every param the scan does NOT read — including the camera', () => {
    // The direction that makes the gate worth having. `view_rot_x/y` matter most:
    // the hero's drag-to-orbit writes them at pointer rate.
    const base = sig();
    const leaked: string[] = [];
    for (const p of cubeDef.params) {
      if (WAVE_PARAMS.includes(p.id)) continue;
      const v = p.defaultValue === p.max ? p.min : p.max;
      if (sig({ [p.id]: v }) !== base) leaked.push(`${p.id} (${p.defaultValue} -> ${v})`);
    }
    expect(
      leaked.join(', '),
      'a param the wave IGNORES invalidates its signature — the gate is a no-op ' +
        'and an orbit drag pays 1.4 ms x 60/s for an identical answer',
    ).toBe('');
  });

  it('the two sets TOGETHER cover every declared param (no third bucket)', () => {
    // Otherwise a param added later could sit in neither list and be asserted
    // by neither direction — the classification going stale in silence.
    const covered = new Set(WAVE_PARAMS);
    const all = cubeDef.params.map((p) => p.id);
    expect(all.filter((id) => covered.has(id)).sort()).toEqual([...WAVE_PARAMS].sort());
    expect(all.length).toBeGreaterThan(WAVE_PARAMS.length);
  });

  it('ANCHORED TO `cubeSliceParams` — a new SliceParams field is covered for free', () => {
    // The signature enumerates the object's own keys rather than a hand-typed
    // list, so it cannot go stale against the thing it describes. Assert the
    // anchor itself: every key of the real SliceParams appears in the string.
    const p = cubeFaceParams(read());
    const s = cubeWaveSignature(p);
    for (const key of Object.keys(cubeSliceParams(p))) {
      expect(s, `SliceParams key '${key}' must appear in the signature`).toContain(`${key}=`);
    }
    expect(s, '`fold` is post-scan and not in SliceParams — appended explicitly').toContain('fold=');
  });

  it('the gated recompute AGREES with an ungated one (the gate changes nothing but cost)', () => {
    // A gate that also changed the answer would be a correctness bug wearing a
    // performance costume. Same params -> same signature -> same stats.
    const a = cubeWaveStats(cubeHeroWave(cubeFaceParams(read({ slice_rx: 0.8 })), FLOOR, WALL, CEIL));
    const b = cubeWaveStats(cubeHeroWave(cubeFaceParams(read({ slice_rx: 0.8, view_rot_y: 2.1 })), FLOOR, WALL, CEIL));
    expect(sig({ slice_rx: 0.8 })).toBe(sig({ slice_rx: 0.8, view_rot_y: 2.1 }));
    expect(b).toEqual(a);
  });
});

describe('cube face — the panel probes cannot be vacuous', () => {

  it('the hero probe drags the picture and watches a DIFFERENT element', () => {
    const cell = shellCellFor('cube', resolveFaceControl('cube-view-{n}', cubeDef));
    expect(cell?.kind).toBe('panel');
    const probe = cell?.kind === 'panel' ? cell.probe : undefined;
    expect(probe?.action).toBe('drag');
    expect(probe?.effect.kind).toBe('text');
    // A control that only relabels itself is a dead control.
    if (probe?.effect.kind === 'text') expect(probe.effect.testid).not.toBe(probe.testid);
  });
});
