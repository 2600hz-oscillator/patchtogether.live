// packages/web/src/lib/audio/modules/foxy.test.ts
//
// FOXY module-def shape. Pins that FOXY exposes WAVECEL's FULL param + IO
// surface (so a WAVECEL patch is drop-in compatible) plus the internal
// mini-SWOLEVCO source controls + the simplified-RUTTETRA "XYZ" controls.
// The factory itself needs a real AudioContext + the wavecel worklet —
// covered by e2e.

import { describe, expect, it, vi } from 'vitest';
import {
  foxyDef,
  FOXY_GEN_MODE_NAMES,
  FOXY_GEN_MODE_COUNT,
  FOXY_GEN_MODE_MAX,
  FOXY_SYNC_MODE_NAMES,
  FOXY_SYNC_MODE_MAX,
  foxyRatioLock,
  buildWavetableExport,
  buildWavetableExportFilename,
} from './foxy';
import type { ModuleNode } from '$lib/graph/types';
import { wavecelDef } from './wavecel';
import {
  FOXY_FIELD_SIZE,
  boxHeightfield3d,
  boxToField3d,
  fieldToWavetable,
  FOXY_XYZ_3D_DEFAULTS,
} from './foxy-map';
import { shapesPipeline } from './foxy-shapes';

describe('FOXY module def shape', () => {
  it('is an audio-domain module in the Hybrid bucket category', () => {
    expect(foxyDef.type).toBe('foxy');
    expect(foxyDef.domain).toBe('audio');
    expect(foxyDef.label).toBe('FOXY');
  });

  it('exposes WAVECEL\'s exact input IDs + types (except the poly + trigger gate inputs)', () => {
    const fIn = new Map(foxyDef.inputs.map((p) => [p.id, p.type]));
    for (const wIn of wavecelDef.inputs) {
      // FOXY deliberately does NOT expose WAVECEL's `poly` (polyPitchGate) chord
      // bus NOR its `trigger` (per-voice-ADSR gate): FOXY drives its internal
      // WAVECEL from its own mini-SWOLEVCO → XYZ pipeline, so a multi-voice chord
      // cable + an external amp-envelope gate have no meaning here. The poly-in
      // feature + the per-voice ADSR are scoped to standalone WAVECEL + CUBE; the
      // shared worklet's env is gated off (everGated=false) → FOXY's internal
      // WAVECEL stays byte-identical (same class as the HYPERCUBE/CUBE gating).
      if (wIn.id === 'poly' || wIn.id === 'trigger') continue;
      expect(fIn.get(wIn.id), `input ${wIn.id}`).toBe(wIn.type);
    }
    // Sanity: FOXY itself has no poly / trigger input (single-voice internal VCO).
    expect(fIn.has('poly'), 'FOXY should NOT expose a poly input').toBe(false);
    expect(fIn.has('trigger'), 'FOXY should NOT expose a trigger input').toBe(false);
  });

  it('exposes WAVECEL\'s exact output IDs + types (out_l/out_r/scope_out/wave3d_out)', () => {
    const fOut = new Map(foxyDef.outputs.map((p) => [p.id, p.type]));
    for (const wOut of wavecelDef.outputs) {
      expect(fOut.get(wOut.id), `output ${wOut.id}`).toBe(wOut.type);
    }
    expect(fOut.get('scope_out')).toBe('mono-video');
    expect(fOut.get('wave3d_out')).toBe('video');
  });

  it('exposes combined_out as a video output (patchable mirror of the GEN-mode visualization)', () => {
    // combined_out is FOXY's "internal world → patch cable" port. The card
    // already has the local XYZ-window preview; this output is purely about
    // making that view patchable to any video destination (VIDEO OUT,
    // BENTBOX, RUTTETRA, etc.). Mode-aware:
    //   gen_mode = 0 (XYZ)          → drawFoxyXyz(field)
    //   gen_mode = 1 (3D Shape Gen) → drawFoxyShapes(shapes)
    const fOut = new Map(foxyDef.outputs.map((p) => [p.id, p.type]));
    expect(fOut.get('combined_out'), 'combined_out output port').toBe('video');
  });

  it('does NOT remove the existing video outputs (scope_out + wave3d_out stay)', () => {
    // Pins additive — combined_out is a NEW output, the existing ones MUST
    // remain so any prior patch using scope_out / wave3d_out keeps working.
    const ids = new Set(foxyDef.outputs.map((p) => p.id));
    expect(ids.has('scope_out')).toBe(true);
    expect(ids.has('wave3d_out')).toBe(true);
    expect(ids.has('combined_out')).toBe(true);
  });

  it('keeps the WAVECEL stereo pair metadata', () => {
    expect(foxyDef.stereoPairs).toEqual([['out_l', 'out_r']]);
  });

  it('carries every WAVECEL VCO param (tune/fine/morph/spread/fold) with matching ranges', () => {
    // FOXY mirrors WAVECEL's VCO/timbre controls only. The per-voice ADSR params
    // (attack/decay/sustain/release) are deliberately NOT surfaced — FOXY's
    // internal WAVECEL is a single-voice VCO with no external gate, so its env
    // stays at the ~pass-through default (gated off). Scope: standalone WAVECEL.
    const ADSR = new Set(['attack', 'decay', 'sustain', 'release']);
    const fParams = new Map(foxyDef.params.map((p) => [p.id, p]));
    for (const wp of wavecelDef.params) {
      if (ADSR.has(wp.id)) continue;
      const fp = fParams.get(wp.id);
      expect(fp, `param ${wp.id}`).toBeDefined();
      expect(fp!.min).toBe(wp.min);
      expect(fp!.max).toBe(wp.max);
      expect(fp!.defaultValue).toBe(wp.defaultValue);
    }
    // Sanity: FOXY does NOT expose the per-voice ADSR params.
    for (const id of ADSR) {
      expect(fParams.has(id), `FOXY should NOT expose ${id}`).toBe(false);
    }
  });

  it('adds the mini-SWOLEVCO source A controls (raster A — terrain)', () => {
    const ids = foxyDef.params.map((p) => p.id);
    for (const id of ['src_tune', 'src_fine', 'src_timbre', 'src_symmetry', 'src_fold']) {
      expect(ids, `source param ${id}`).toContain(id);
    }
  });

  it('adds the SECOND mini-SWOLEVCO source B controls (raster B — Y row distribution)', () => {
    const ids = foxyDef.params.map((p) => p.id);
    for (const id of ['src2_tune', 'src2_fine', 'src2_timbre', 'src2_symmetry', 'src2_fold']) {
      expect(ids, `source-B param ${id}`).toContain(id);
    }
  });

  it('adds the THIRD mini-SWOLEVCO source C controls (raster C — Z amplitude LUT)', () => {
    const ids = foxyDef.params.map((p) => p.id);
    for (const id of ['src3_tune', 'src3_fine', 'src3_timbre', 'src3_symmetry', 'src3_fold']) {
      expect(ids, `source-C param ${id}`).toContain(id);
    }
  });

  it('source C defaults are the spec-mandated contrasting values (-12 st, 0.4/0.7/0.3)', () => {
    const byId = new Map(foxyDef.params.map((p) => [p.id, p]));
    expect(byId.get('src3_tune')?.defaultValue).toBe(-12);
    expect(byId.get('src3_fine')?.defaultValue).toBe(0);
    expect(byId.get('src3_timbre')?.defaultValue).toBe(0.4);
    expect(byId.get('src3_symmetry')?.defaultValue).toBe(0.7);
    expect(byId.get('src3_fold')?.defaultValue).toBe(0.3);
  });

  it('exposes a FREEZE RASTER C discrete toggle alongside the A/B/Table ones', () => {
    const byId = new Map(foxyDef.params.map((p) => [p.id, p]));
    for (const id of ['freezeRasterA', 'freezeRasterB', 'freezeRasterC', 'freezeTable']) {
      const p = byId.get(id);
      expect(p, `freeze param ${id}`).toBeDefined();
      expect(p!.curve).toBe('discrete');
      expect(p!.min).toBe(0);
      expect(p!.max).toBe(1);
    }
  });

  it('adds the simplified-RUTTETRA XYZ controls', () => {
    const ids = foxyDef.params.map((p) => p.id);
    for (const id of ['xyz_xshape', 'xyz_yshape', 'xyz_ydisp']) {
      expect(ids, `xyz param ${id}`).toContain(id);
    }
  });

  it('adds the v4 volumetric XYZ controls (xyz_warp + xyz_zheight)', () => {
    const byId = new Map(foxyDef.params.map((p) => [p.id, p]));
    const warp = byId.get('xyz_warp');
    expect(warp, 'xyz_warp').toBeDefined();
    expect(warp!.min).toBe(0);
    expect(warp!.max).toBe(1);
    expect(warp!.defaultValue).toBeCloseTo(0.25, 4);
    const zh = byId.get('xyz_zheight');
    expect(zh, 'xyz_zheight').toBeDefined();
    expect(zh!.min).toBe(0);
    expect(zh!.max).toBe(1);
    expect(zh!.defaultValue).toBeCloseTo(0.5, 4);
  });

  it('adds the v4.1 XYZ controls (xyz_zoom default 4, xyz_smooth default 0.5)', () => {
    // The headline v4.1 knobs — defaults match the user-requested "4× zoom +
    // 0.5 smooth" experience. User can dial them down (1 / 0) to recover
    // v4 behavior exactly.
    const byId = new Map(foxyDef.params.map((p) => [p.id, p]));
    const zoom = byId.get('xyz_zoom');
    expect(zoom, 'xyz_zoom').toBeDefined();
    expect(zoom!.min).toBe(1);
    expect(zoom!.max).toBe(8);
    expect(zoom!.curve).toBe('linear');
    expect(zoom!.defaultValue).toBeCloseTo(4, 4);
    const smooth = byId.get('xyz_smooth');
    expect(smooth, 'xyz_smooth').toBeDefined();
    expect(smooth!.min).toBe(0);
    expect(smooth!.max).toBe(1);
    expect(smooth!.curve).toBe('linear');
    expect(smooth!.defaultValue).toBeCloseTo(0.5, 4);
  });

  it('routes morph_cv/spread_cv/fold_cv to the right param targets', () => {
    const byId = new Map(foxyDef.inputs.map((p) => [p.id, p]));
    expect(byId.get('morph_cv')?.paramTarget).toBe('morph');
    expect(byId.get('spread_cv')?.paramTarget).toBe('spread');
    expect(byId.get('fold_cv')?.paramTarget).toBe('fold');
  });

  // ── 3dShapeGen mode switch ───────────────────────────────────────────
  // The new GEN knob selects between the XYZ (default, v4.1) path and the
  // experimental 3dShapeGen path. Both produce the same 64×256 number[][]
  // wavetable wire format the WAVECEL worklet expects.

  it('exposes a gen_mode discrete picker (default 0, range 0..1)', () => {
    const byId = new Map(foxyDef.params.map((p) => [p.id, p]));
    const p = byId.get('gen_mode');
    expect(p, 'gen_mode param').toBeDefined();
    expect(p!.min).toBe(0);
    expect(p!.max).toBe(FOXY_GEN_MODE_MAX);
    expect(p!.curve).toBe('discrete');
    expect(p!.defaultValue).toBe(0);
  });

  it('FOXY_GEN_MODE_NAMES has length 2 and lists XYZ + 3D Shape Gen', () => {
    expect(FOXY_GEN_MODE_NAMES.length).toBe(2);
    expect(FOXY_GEN_MODE_COUNT).toBe(2);
    expect([...FOXY_GEN_MODE_NAMES]).toEqual(['XYZ', '3D Shape Gen']);
  });

  it('MODE_NAMES length matches the gen_mode param discrete range', () => {
    const p = foxyDef.params.find((x) => x.id === 'gen_mode')!;
    expect(FOXY_GEN_MODE_NAMES.length).toBe(p.max - p.min + 1);
  });

  // setParam/readParam round-trip is exercised end-to-end via the factory
  // (which needs a real AudioContext). The pure shape test above is the
  // module-def assertion; the round-trip + audio behaviour is covered by
  // the factory branching path — verified directly via the pure pipeline
  // here, since both modes go through the SAME deterministic helpers.

  it('XYZ vs 3D Shape Gen produce DIFFERENT wavetables for the same rasters', () => {
    // Build three independent non-flat rasters so both pipelines have
    // meaningful input.
    const W = FOXY_FIELD_SIZE;
    function rgba(fill: (x: number, y: number) => number): Uint8ClampedArray {
      const out = new Uint8ClampedArray(W * W * 4);
      for (let y = 0; y < W; y++) {
        for (let x = 0; x < W; x++) {
          const v = Math.round(Math.max(0, Math.min(1, fill(x, y))) * 255);
          const o = (y * W + x) * 4;
          out[o] = v; out[o + 1] = v; out[o + 2] = v; out[o + 3] = 255;
        }
      }
      return out;
    }
    const A = rgba((x, y) => {
      // Three Gaussian bumps so generateShapes finds peaks.
      const nx = x / (W - 1), ny = y / (W - 1);
      let m = 0;
      for (const [cx, cy] of [[0.25, 0.25], [0.75, 0.25], [0.5, 0.75]]) {
        const dx = nx - cx!, dy = ny - cy!;
        m = Math.max(m, Math.exp(-(dx * dx + dy * dy) * 80));
      }
      return m;
    });
    const B = rgba((x) => x / (W - 1));
    const C = rgba((_, y) => y / (W - 1));

    // XYZ path
    const box3 = boxHeightfield3d(A, B, C, W, W);
    const xyzField = boxToField3d(box3, A, W, W, {
      ...FOXY_XYZ_3D_DEFAULTS,
      zoom: 4,
      smooth: 0.5,
    });
    const xyzWt = fieldToWavetable(xyzField);

    // 3D Shape Gen path
    const { wavetable: shapesWt } = shapesPipeline(A, B, C, W, W);

    // Both share dims.
    expect(xyzWt.length).toBe(shapesWt.length);
    expect(xyzWt[0]!.length).toBe(shapesWt[0]!.length);

    // The two paths should produce GENUINELY different tables. Compare via
    // a coarse signature — sum of |diff| across a sampled grid — and
    // assert it's well above the floor.
    let diff = 0;
    for (let f = 0; f < xyzWt.length; f += 4) {
      for (let s = 0; s < xyzWt[0]!.length; s += 16) {
        diff += Math.abs((xyzWt[f]![s] ?? 0) - (shapesWt[f]![s] ?? 0));
      }
    }
    expect(diff).toBeGreaterThan(1);
  });

  // ── VCO sync ─────────────────────────────────────────────────────────
  // sync_mode is a 3-position discrete param (OFF / X & Y / XYZ) that
  // ratio-locks swoleB (mode 1+) and swoleC (mode 2) to swoleA. The card
  // renders FOXY_SYNC_MODE_NAMES next to the knob.
  it('exposes a sync_mode discrete param (0..2, default 0)', () => {
    const byId = new Map(foxyDef.params.map((p) => [p.id, p]));
    const sm = byId.get('sync_mode');
    expect(sm, 'sync_mode').toBeDefined();
    expect(sm!.min).toBe(0);
    expect(sm!.max).toBe(2);
    expect(sm!.defaultValue).toBe(0);
    expect(sm!.curve).toBe('discrete');
  });

  it('exports FOXY_SYNC_MODE_NAMES with the 3 user-facing labels', () => {
    expect(FOXY_SYNC_MODE_NAMES.length).toBe(3);
    expect(FOXY_SYNC_MODE_NAMES[0]).toBe('Off');
    expect(FOXY_SYNC_MODE_NAMES[1]).toBe('X & Y');
    expect(FOXY_SYNC_MODE_NAMES[2]).toBe('XYZ');
    expect(FOXY_SYNC_MODE_MAX).toBe(2);
  });
});

describe('FOXY ratio-lock sync (pure-math helper)', () => {
  // foxyRatioLock snaps the slave frequency to the nearest integer ratio
  // (≥1) of the master. With master=110 Hz + slave=220 Hz, the closest
  // integer ratio is 2 → slave stays at 220 Hz. Bumping master to 120 Hz
  // preserves the ratio → slave moves to 240 Hz.
  it('locks slave=220 to ratio 2 of master=110 → 220 Hz', () => {
    expect(foxyRatioLock(110, 220)).toBeCloseTo(220, 6);
  });

  it('preserves the locked ratio when master moves (110→120 carries 220→240)', () => {
    // First lock at 110 → 220 (ratio 2). Now imagine master moved to 120
    // and slave still wants 220 — round(220/120)=2, so slave → 240.
    expect(foxyRatioLock(120, 220)).toBeCloseTo(240, 6);
  });

  it('snaps a near-ratio slave to the exact integer multiple', () => {
    // Slave at 233 Hz, master at 110: nearest integer ratio is 2 (not 2.118),
    // so we snap to 220 Hz.
    expect(foxyRatioLock(110, 233)).toBeCloseTo(220, 6);
  });

  it('clamps to ratio ≥1 (a sub-master slave gets pulled UP to master)', () => {
    // Slave at 60 Hz, master at 110: round(0.545)=1, so slave snaps to 110.
    expect(foxyRatioLock(110, 60)).toBeCloseTo(110, 6);
  });

  it('returns slave unchanged when master is non-positive / non-finite', () => {
    expect(foxyRatioLock(0, 220)).toBe(220);
    expect(foxyRatioLock(-1, 220)).toBe(220);
    expect(foxyRatioLock(Number.NaN, 220)).toBe(220);
  });
});

// ── EXPORT TABLE payload (pure helper) ────────────────────────────────
//
// The card's "EXPORT TABLE" button (visible only when FrT is on) calls
// buildWavetableExport(wtFrames, mode) → FoxyWavetableExport. Pinning the
// JSON shape here keeps the on-disk file format frozen + portable.

describe('FOXY buildWavetableExport', () => {
  function mkFrame(seed: number): Float32Array {
    const f = new Float32Array(256);
    for (let i = 0; i < 256; i++) f[i] = Math.sin(2 * Math.PI * (i / 256) * seed) * 0.5;
    return f;
  }

  it('produces a 64×256 number[][] payload with the FOXY generator tag', () => {
    const frames = Array.from({ length: 64 }, (_, k) => mkFrame(k + 1));
    const out = buildWavetableExport(frames, 'XYZ');
    expect(out.generator).toBe('FOXY');
    expect(out.mode).toBe('XYZ');
    expect(out.frames).toBe(64);
    expect(out.samples).toBe(256);
    expect(out.data.length).toBe(64);
    expect(out.data[0]!.length).toBe(256);
  });

  it('carries the 3D Shape Gen mode tag verbatim when passed', () => {
    const frames = Array.from({ length: 64 }, (_, k) => mkFrame(k + 1));
    const out = buildWavetableExport(frames, '3D Shape Gen');
    expect(out.mode).toBe('3D Shape Gen');
  });

  it('clamps every sample to [-1, 1]', () => {
    // Deliberately push values outside [-1, 1] — clamp should rein them in.
    const dirty = Array.from({ length: 64 }, () => {
      const f = new Float32Array(256);
      for (let i = 0; i < 256; i++) f[i] = i % 2 === 0 ? 2.5 : -3.1;
      return f;
    });
    const out = buildWavetableExport(dirty, 'XYZ');
    for (const row of out.data) {
      for (const v of row) {
        expect(v).toBeGreaterThanOrEqual(-1);
        expect(v).toBeLessThanOrEqual(1);
      }
    }
  });

  it('preserves the original values when already in range', () => {
    const frames = [new Float32Array([0, 0.5, -0.5, 1, -1])];
    const out = buildWavetableExport(frames, 'XYZ');
    expect(out.data[0]).toEqual([0, 0.5, -0.5, 1, -1]);
  });

  it('emits an ISO timestamp at the passed `now`', () => {
    const frames = [new Float32Array([0])];
    const fixed = new Date('2026-05-29T12:34:56.789Z');
    const out = buildWavetableExport(frames, 'XYZ', fixed);
    expect(out.createdAt).toBe(fixed.toISOString());
  });

  it('is JSON-serializable round-trip (Float32Array→number[])', () => {
    const frames = [new Float32Array([0.1, -0.2, 0.3])];
    const out = buildWavetableExport(frames, 'XYZ');
    const round = JSON.parse(JSON.stringify(out));
    expect(round.data[0]).toEqual([
      // toFixed-style cast for Float32 precision drift; toEqual with the
      // raw Float32 values would be brittle.
      expect.closeTo(0.1, 5),
      expect.closeTo(-0.2, 5),
      expect.closeTo(0.3, 5),
    ]);
  });
});

describe('FOXY buildWavetableExportFilename', () => {
  it('formats as foxy-wavetable-YYYYMMDD-HHMMSS.json', () => {
    // Use a fixed Date (LOCAL time, since the formatter pulls local parts
    // so the user's downloaded file matches their wall clock).
    const fixed = new Date(2026, 4, 29, 7, 8, 9); // 2026-05-29 07:08:09 local
    expect(buildWavetableExportFilename(fixed)).toBe('foxy-wavetable-20260529-070809.json');
  });

  it('zero-pads months / days / time-parts', () => {
    const fixed = new Date(2026, 0, 3, 1, 2, 4); // 2026-01-03 01:02:04
    expect(buildWavetableExportFilename(fixed)).toBe('foxy-wavetable-20260103-010204.json');
  });
});

// ── FREEZE TABLE end-to-end bridge behavior ───────────────────────────
//
// User-clarified intent: FREEZE TABLE freezes the WAVETABLE ONLY. Rasters
// AND the XYZ scope keep evolving so the user can preview what's queued
// for when they unfreeze. The audio worklet plays the pinned snapshot
// (no fresh loadWavetable posts) and the LIVE WAVETABLE display holds.
//
// PR #411 over-corrected (early-return on FrT halted the whole bridge,
// freezing the XYZ scope too). This test block pins the correct surgical
// gate: wtFrames REFERENCE + worklet post are gated, field/shapes keep
// being recomputed each tick.
//
// The factory needs a real-enough Web Audio surface to construct. We
// stub just what the bridge touches (OscillatorNode, GainNode, AnalyserNode,
// WaveShaperNode, AudioWorkletNode) + a fake performance.now we advance
// past the 42-ms throttle between ticks.

interface FakeAudioParam { value: number; setValueAtTime: (v: number, t: number) => void }
interface PostedMessage { type: string; frames?: number[][] }

function makeFoxyMockEnv() {
  const posted: PostedMessage[] = [];
  // Each AnalyserNode hands back a deterministic synthetic waveform when
  // asked. The bridge feeds these into the three rasters. By default we
  // hand back the SAME pattern on every call (so any drift in wtFrames
  // across ticks comes from cursor advance, which we can disable for a
  // pure freeze test).
  let analyserSeed = 0;

  function mkParam(): FakeAudioParam {
    return { value: 0, setValueAtTime(v: number) { this.value = v; } };
  }
  class FakeOsc {
    type = 'sine';
    frequency = mkParam();
    start = vi.fn();
    stop = vi.fn();
    connect = vi.fn();
    disconnect = vi.fn();
  }
  class FakeGain {
    gain = mkParam();
    connect = vi.fn();
    disconnect = vi.fn();
  }
  class FakeWaveShaper {
    oversample = 'none';
    curve: Float32Array | null = null;
    connect = vi.fn();
    disconnect = vi.fn();
  }
  class FakeAnalyser {
    fftSize = 2048;
    smoothingTimeConstant = 0;
    connect = vi.fn();
    disconnect = vi.fn();
    getFloatTimeDomainData(out: Float32Array): void {
      // Distinct deterministic pattern per call so the rasters DO change
      // tick-over-tick — exactly the condition that previously animated
      // the XYZ scope while frozen. The phase advance per seed step is
      // tuned LARGE so the bridge's wavetableSignature sees a different
      // hash on consecutive ticks (probe-sampling at 8 points).
      const s = analyserSeed++;
      const phase = s * 0.5;
      for (let i = 0; i < out.length; i++) {
        out[i] = Math.sin(i * 0.05 + phase) * 0.5 + Math.sin(i * 0.013 + phase * 1.3) * 0.4;
      }
    }
  }
  const portMock = {
    postMessage: vi.fn((m: PostedMessage) => { posted.push(m); }),
    onmessage: null as unknown,
    close: vi.fn(),
  };
  const wParamMap = new Map<string, FakeAudioParam>();
  for (const id of ['tune', 'fine', 'morph', 'spread', 'fold']) {
    wParamMap.set(id, mkParam());
  }
  class FakeAudioWorkletNode {
    port = portMock;
    parameters = { get: (k: string) => wParamMap.get(k) };
    connect = vi.fn();
    disconnect = vi.fn();
    constructor(_ctx: unknown, _name: string, _opts?: unknown) {}
  }
  const audioWorklet = { addModule: vi.fn(async (_url: string) => {}) };
  const ctx = {
    audioWorklet,
    currentTime: 0,
    sampleRate: 48000,
    state: 'running' as AudioContextState,
    createOscillator: () => new FakeOsc(),
    createGain: () => new FakeGain(),
    createWaveShaper: () => new FakeWaveShaper(),
    createAnalyser: () => new FakeAnalyser(),
  };

  // Install all the Web Audio globals foxy.ts touches.
  (globalThis as unknown as { AudioWorkletNode: typeof FakeAudioWorkletNode }).AudioWorkletNode = FakeAudioWorkletNode;
  // RasterPainter.imageData() constructs `new ImageData(...)` which jsdom
  // doesn't expose. Install a minimal stand-in (the bridge just needs the
  // .data + .width + .height read-throughs).
  class FakeImageData {
    data: Uint8ClampedArray;
    width: number;
    height: number;
    constructor(data: Uint8ClampedArray, width: number, height: number) {
      this.data = data;
      this.width = width;
      this.height = height;
    }
  }
  (globalThis as unknown as { ImageData: typeof FakeImageData }).ImageData = FakeImageData;

  return { ctx, posted };
}

function makeFoxyNode(params: Record<string, number> = {}): ModuleNode {
  return {
    id: 'foxy-test',
    type: 'foxy',
    domain: 'audio',
    position: { x: 0, y: 0 },
    params,
    data: {},
  };
}

describe('FOXY bridge: FREEZE TABLE freezes the wavetable ONLY (XYZ scope keeps moving)', () => {
  // Walk `performance.now` forward in big steps so each bridgeTick clears
  // the BRIDGE_MS=42 throttle.
  let nowMs = 0;
  function nowStep(): void { nowMs += 1000; }

  function installPerfNow(): { restore: () => void } {
    const orig = globalThis.performance;
    (globalThis as unknown as { performance: { now: () => number } }).performance = {
      now: () => nowMs,
    };
    return {
      restore: () => {
        (globalThis as unknown as { performance: Performance | undefined }).performance = orig;
      },
    };
  }

  it('freezeTable = 1 → two consecutive ticks return the SAME wtFrames reference', async () => {
    nowMs = 0;
    const perf = installPerfNow();
    try {
      const { ctx } = makeFoxyMockEnv();
      const node = makeFoxyNode();
      const handle = await foxyDef.factory(ctx as unknown as AudioContext, node);
      // First tick: build the initial wavetable while LIVE.
      nowStep();
      handle.read!('tick');
      const wt1 = handle.read!('wavetableFrames') as Float32Array[];
      expect(wt1.length).toBeGreaterThan(0);
      // Freeze. The card writes node.params[freezeTable] = 1, which the
      // reconciler diffs and routes through engine.setParam → the factory's
      // setParam(paramId, value) switch. We mirror that path here (a direct
      // node.params mutation would NOT exercise the wiring — the snapshot-
      // vs-live bug that hid this regression for two PRs).
      handle.setParam!('freezeTable', 1);
      // Second tick: rasters keep getting fresh analyser data, but the
      // bridge must hold wtFrames (field/shapes still recompute — see the
      // dedicated "keeps moving" tests below).
      nowStep();
      handle.read!('tick');
      const wt2 = handle.read!('wavetableFrames') as Float32Array[];
      // Reference equality: bridge skipped the wtFrames reassignment.
      expect(wt2).toBe(wt1);
    } finally {
      perf.restore();
    }
  });

  it('freezeTable = 1 → field (XYZ mode) KEEPS MOVING across ticks (XYZ scope animates)', async () => {
    // Opposite of PR #411's pin. The bridge keeps recomputing field on
    // every tick under FrT, so the XYZ scope canvas keeps animating while
    // the wavetable + worklet stay frozen.
    nowMs = 0;
    const perf = installPerfNow();
    try {
      const { ctx } = makeFoxyMockEnv();
      const node = makeFoxyNode();
      const handle = await foxyDef.factory(ctx as unknown as AudioContext, node);
      nowStep();
      handle.read!('tick');
      // Snapshot the field reference. Each tick reassigns `field` to a
      // fresh boxToField3d result, so reference inequality is the cleanest
      // pin that the XYZ path keeps running.
      const field1 = handle.read!('xyzField') as unknown[];
      handle.setParam!('freezeTable', 1);
      nowStep();
      handle.read!('tick');
      const field2 = handle.read!('xyzField') as unknown[];
      // Different reference → bridge ran boxToField3d again under FrT.
      expect(field2).not.toBe(field1);
    } finally {
      perf.restore();
    }
  });

  it('freezeTable = 1 in 3D Shape Gen mode → shapes KEEP MOVING across ticks', async () => {
    nowMs = 0;
    const perf = installPerfNow();
    try {
      const { ctx } = makeFoxyMockEnv();
      const node = makeFoxyNode({ gen_mode: 1 });
      const handle = await foxyDef.factory(ctx as unknown as AudioContext, node);
      nowStep();
      handle.read!('tick');
      const shapes1 = handle.read!('shapes') as unknown[];
      handle.setParam!('freezeTable', 1);
      nowStep();
      handle.read!('tick');
      const shapes2 = handle.read!('shapes') as unknown[];
      // Different reference → bridge ran generateShapes again under FrT.
      expect(shapes2).not.toBe(shapes1);
    } finally {
      perf.restore();
    }
  });

  it('freezeTable = 1 with non-frozen rasters → wtFrames CONTENTS pinned, field MOVES', async () => {
    // Sanity test pinning the full contract end-to-end: rasters keep
    // delivering fresh analyser data each tick, the wavetable display
    // holds its snapshot (reference + contents both pinned), and the
    // XYZ field recomputes so the scope animates.
    nowMs = 0;
    const perf = installPerfNow();
    try {
      const { ctx } = makeFoxyMockEnv();
      const node = makeFoxyNode();
      const handle = await foxyDef.factory(ctx as unknown as AudioContext, node);
      // Live tick to build an initial wavetable.
      nowStep();
      handle.read!('tick');
      // Freeze and capture references + a contents fingerprint.
      handle.setParam!('freezeTable', 1);
      nowStep();
      handle.read!('tick');
      const wt1 = handle.read!('wavetableFrames') as Float32Array[];
      const field1 = handle.read!('xyzField') as unknown[];
      const wt1Fingerprint = wt1.map((f) => Array.from(f).join(','));
      // Another tick: rasters get new analyser data (FakeAnalyser bumps
      // its phase each call), but the wavetable must NOT update.
      nowStep();
      handle.read!('tick');
      const wt2 = handle.read!('wavetableFrames') as Float32Array[];
      const field2 = handle.read!('xyzField') as unknown[];
      const wt2Fingerprint = wt2.map((f) => Array.from(f).join(','));
      // wtFrames pinned both by reference AND by contents.
      expect(wt2).toBe(wt1);
      expect(wt2Fingerprint).toEqual(wt1Fingerprint);
      // field re-built → XYZ scope keeps animating.
      expect(field2).not.toBe(field1);
    } finally {
      perf.restore();
    }
  });

  it('freezeTable = 0 → 1 → 0 unfreezes the bridge (re-enables loadWavetable posts)', async () => {
    // The unfreeze path's user-observable effect is that loadWavetable
    // posts resume + the change-detect path is no longer skipped. Pinning
    // that via the worklet port-message log (a behavioural assertion) is
    // more robust than asserting wtFrames reference inequality — the
    // signature comparator legitimately dedupes content-equivalent builds,
    // and that's an OPTIMIZATION orthogonal to the freeze semantics.
    nowMs = 0;
    const perf = installPerfNow();
    try {
      const { ctx, posted } = makeFoxyMockEnv();
      const node = makeFoxyNode();
      const handle = await foxyDef.factory(ctx as unknown as AudioContext, node);
      // Live tick — at least one initial loadWavetable lands.
      nowStep();
      handle.read!('tick');
      const postsAfterLive1 = posted.filter((m) => m.type === 'loadWavetable').length;
      expect(postsAfterLive1).toBeGreaterThan(0);
      // Freeze + spin a few ticks — bridge must skip all posts.
      handle.setParam!('freezeTable', 1);
      for (let i = 0; i < 3; i++) { nowStep(); handle.read!('tick'); }
      const postsAfterFreeze = posted.filter((m) => m.type === 'loadWavetable').length;
      expect(postsAfterFreeze).toBe(postsAfterLive1);
      // Unfreeze + perturb an XYZ knob so the next build produces a
      // different signature → bridge re-engages the post path.
      handle.setParam!('freezeTable', 0);
      handle.setParam!('xyz_warp', 0.9);
      handle.setParam!('xyz_zheight', 0.95);
      nowStep();
      handle.read!('tick');
      const postsAfterUnfreeze = posted.filter((m) => m.type === 'loadWavetable').length;
      expect(postsAfterUnfreeze).toBeGreaterThan(postsAfterFreeze);
    } finally {
      perf.restore();
    }
  });

  it('freezeTable = 1 → no further loadWavetable posts are sent', async () => {
    nowMs = 0;
    const perf = installPerfNow();
    try {
      const { ctx, posted } = makeFoxyMockEnv();
      const node = makeFoxyNode();
      const handle = await foxyDef.factory(ctx as unknown as AudioContext, node);
      // Live tick — at least one initial loadWavetable post.
      nowStep();
      handle.read!('tick');
      const postsBeforeFreeze = posted.filter((m) => m.type === 'loadWavetable').length;
      expect(postsBeforeFreeze).toBeGreaterThan(0);
      // Freeze, then run a few more ticks. Worklet should see zero new
      // loadWavetable messages. Route through setParam — the real engine
      // path the reconciler uses (see the snapshot-vs-live root cause
      // pinned in the "wires freeze* through setParam" block below).
      handle.setParam!('freezeTable', 1);
      for (let i = 0; i < 5; i++) {
        nowStep();
        handle.read!('tick');
      }
      const postsAfterFreeze = posted.filter((m) => m.type === 'loadWavetable').length;
      expect(postsAfterFreeze).toBe(postsBeforeFreeze);
    } finally {
      perf.restore();
    }
  });
});

// ── FREEZE wiring regression (snapshot-vs-live root cause) ────────────
//
// The factory used to read freeze* via the `num(...)` helper inside
// bridgeTick. `num` reads from `p0 = node.params ?? {}` — a SNAPSHOT
// taken at factory-mount time. Meanwhile the card writes freezes via
// the engine's setParam path: reconciler.ts diffs node.params and
// calls engine.setParam → factory.setParam(paramId, value). Because the
// setParam switch had NO cases for freezeRasterA / B / C / Table, the
// factory closure NEVER saw the click. The button visually toggled but
// the bridge was reading the mount-time value (always 0) forever.
//
// This block pins the fix end-to-end: setParam mutates a closure mirror,
// readParam round-trips it, and the bridge tick observes the live value
// (so freezeTable=1 actually skips loadWavetable + freezeRasterA=1
// actually skips painterA.paint).

describe('FOXY freeze* wiring (regression: factory must see setParam writes)', () => {
  let nowMs = 0;
  function nowStep(): void { nowMs += 1000; }
  function installPerfNow(): { restore: () => void } {
    const orig = globalThis.performance;
    (globalThis as unknown as { performance: { now: () => number } }).performance = {
      now: () => nowMs,
    };
    return {
      restore: () => {
        (globalThis as unknown as { performance: Performance | undefined }).performance = orig;
      },
    };
  }

  it('setParam(freezeTable, 1) → readParam returns 1; setParam(0) → 0 (round-trip)', async () => {
    nowMs = 0;
    const perf = installPerfNow();
    try {
      const { ctx } = makeFoxyMockEnv();
      const node = makeFoxyNode();
      const handle = await foxyDef.factory(ctx as unknown as AudioContext, node);
      // Default — closure starts from node.params snapshot (0).
      expect(handle.readParam!('freezeTable')).toBe(0);
      handle.setParam!('freezeTable', 1);
      expect(handle.readParam!('freezeTable')).toBe(1);
      handle.setParam!('freezeTable', 0);
      expect(handle.readParam!('freezeTable')).toBe(0);
    } finally {
      perf.restore();
    }
  });

  it('setParam(freezeRasterA/B/C, 1) → readParam returns 1 for each (round-trip)', async () => {
    nowMs = 0;
    const perf = installPerfNow();
    try {
      const { ctx } = makeFoxyMockEnv();
      const node = makeFoxyNode();
      const handle = await foxyDef.factory(ctx as unknown as AudioContext, node);
      for (const k of ['freezeRasterA', 'freezeRasterB', 'freezeRasterC'] as const) {
        expect(handle.readParam!(k), `${k} default`).toBe(0);
        handle.setParam!(k, 1);
        expect(handle.readParam!(k), `${k} after setParam(1)`).toBe(1);
        handle.setParam!(k, 0);
        expect(handle.readParam!(k), `${k} after setParam(0)`).toBe(0);
      }
    } finally {
      perf.restore();
    }
  });

  it('setParam(freezeTable, 1) actually halts loadWavetable posts (NOT just node.params mutation)', async () => {
    // The PRE-fix bridge would happily keep posting after this setParam
    // because the closure mirror didn't exist and the switch dropped the
    // case. This pins that setParam is the wire — the only path the
    // reconciler uses. Direct node.params mutation must NOT be required.
    nowMs = 0;
    const perf = installPerfNow();
    try {
      const { ctx, posted } = makeFoxyMockEnv();
      const node = makeFoxyNode();
      const handle = await foxyDef.factory(ctx as unknown as AudioContext, node);
      nowStep();
      handle.read!('tick');
      const initialPosts = posted.filter((m) => m.type === 'loadWavetable').length;
      expect(initialPosts).toBeGreaterThan(0);
      // ONLY setParam, not node.params. Pre-fix this no-ops; post-fix the
      // bridge halts.
      handle.setParam!('freezeTable', 1);
      for (let i = 0; i < 4; i++) { nowStep(); handle.read!('tick'); }
      const postsAfter = posted.filter((m) => m.type === 'loadWavetable').length;
      expect(postsAfter).toBe(initialPosts);
    } finally {
      perf.restore();
    }
  });

  it('setParam(freezeRasterA, 1) holds raster A while B/C keep drifting', async () => {
    // Per-raster freezes go through the same wiring. Pre-fix none of these
    // worked; post-fix each gates its own painter. We observe via the
    // raster ImageData reference: while frozen the painter's data stays
    // pinned (no new paint call → same pixel buffer), while the live
    // ones keep drifting.
    nowMs = 0;
    const perf = installPerfNow();
    try {
      const { ctx } = makeFoxyMockEnv();
      const node = makeFoxyNode();
      const handle = await foxyDef.factory(ctx as unknown as AudioContext, node);
      // Initial tick fills + caches all three.
      nowStep();
      handle.read!('tick');
      // Hash of raster A's pixel buffer (sum of bytes) — cheap fingerprint.
      const hashRaster = (key: string): number => {
        const img = handle.read!(key) as { data: Uint8ClampedArray };
        let s = 0;
        // Sample 256 spaced bytes — enough to detect ANY paint delta from
        // the next analyser pull without iterating 256 KB per tick.
        for (let i = 0; i < img.data.length; i += Math.floor(img.data.length / 256)) {
          s = (s + img.data[i]!) | 0;
        }
        return s;
      };
      const hA0 = hashRaster('rasterImageDataA');
      const hB0 = hashRaster('rasterImageDataB');
      // Freeze A; B + C stay live.
      handle.setParam!('freezeRasterA', 1);
      // Drive a few ticks — each tick the FakeAnalyser hands back a fresh
      // phase, so a live raster's fingerprint shifts while a frozen one's
      // does NOT.
      for (let i = 0; i < 4; i++) { nowStep(); handle.read!('tick'); }
      const hA1 = hashRaster('rasterImageDataA');
      const hB1 = hashRaster('rasterImageDataB');
      // Frozen raster A: identical fingerprint (paint skipped).
      expect(hA1, 'raster A pinned under freezeRasterA=1').toBe(hA0);
      // Live raster B: fingerprint changed (paint ran on fresh analyser data).
      expect(hB1, 'raster B kept moving under freezeRasterA=1').not.toBe(hB0);
    } finally {
      perf.restore();
    }
  });

  it('unfreezing a raster via setParam(0) re-engages the paint path', async () => {
    nowMs = 0;
    const perf = installPerfNow();
    try {
      const { ctx } = makeFoxyMockEnv();
      const node = makeFoxyNode();
      const handle = await foxyDef.factory(ctx as unknown as AudioContext, node);
      nowStep();
      handle.read!('tick');
      const hashRaster = (key: string): number => {
        const img = handle.read!(key) as { data: Uint8ClampedArray };
        let s = 0;
        for (let i = 0; i < img.data.length; i += Math.floor(img.data.length / 256)) {
          s = (s + img.data[i]!) | 0;
        }
        return s;
      };
      handle.setParam!('freezeRasterA', 1);
      for (let i = 0; i < 3; i++) { nowStep(); handle.read!('tick'); }
      const hAFrozen = hashRaster('rasterImageDataA');
      // Unfreeze. Subsequent ticks must repaint A → fingerprint must move.
      handle.setParam!('freezeRasterA', 0);
      for (let i = 0; i < 3; i++) { nowStep(); handle.read!('tick'); }
      const hAUnfrozen = hashRaster('rasterImageDataA');
      expect(hAUnfrozen, 'raster A repainting after setParam(freezeRasterA, 0)').not.toBe(hAFrozen);
    } finally {
      perf.restore();
    }
  });

  it('honors node.params snapshot at MOUNT (freezeTable=1 in initial params) until setParam flips', async () => {
    // The closure mirror is initialized from node.params at mount — so a
    // patch loaded with freezeTable=1 baked in must boot already frozen.
    // The bridgeTick still runs (computes field for the scope) but does
    // NOT post loadWavetable. Then setParam(freezeTable, 0) un-freezes.
    nowMs = 0;
    const perf = installPerfNow();
    try {
      const { ctx, posted } = makeFoxyMockEnv();
      const node = makeFoxyNode({ freezeTable: 1 });
      const handle = await foxyDef.factory(ctx as unknown as AudioContext, node);
      // The closure reads node.params at mount → freezeTable starts true.
      expect(handle.readParam!('freezeTable')).toBe(1);
      // Drive ticks. Because the bridge is frozen, no loadWavetable goes
      // out — wtFrames stays []
      for (let i = 0; i < 3; i++) { nowStep(); handle.read!('tick'); }
      expect(posted.filter((m) => m.type === 'loadWavetable').length).toBe(0);
      // Unfreeze + tick → at least one loadWavetable lands.
      handle.setParam!('freezeTable', 0);
      nowStep();
      handle.read!('tick');
      expect(posted.filter((m) => m.type === 'loadWavetable').length).toBeGreaterThan(0);
    } finally {
      perf.restore();
    }
  });
});
