// packages/web/src/lib/audio/modules/foxy.test.ts
//
// FOXY module-def shape. Pins that FOXY exposes WAVECEL's FULL param + IO
// surface (so a WAVECEL patch is drop-in compatible) plus the internal
// mini-SWOLEVCO source controls + the simplified-RUTTETRA "XYZ" controls.
// The factory itself needs a real AudioContext + the wavecel worklet —
// covered by e2e.

import { describe, expect, it } from 'vitest';
import { foxyDef, FOXY_SYNC_MODE_NAMES, FOXY_SYNC_MODE_MAX, foxyRatioLock } from './foxy';
import { wavecelDef } from './wavecel';

describe('FOXY module def shape', () => {
  it('is an audio-domain module in the Hybrid bucket category', () => {
    expect(foxyDef.type).toBe('foxy');
    expect(foxyDef.domain).toBe('audio');
    expect(foxyDef.label).toBe('FOXY');
  });

  it('exposes WAVECEL\'s exact input IDs + types', () => {
    const fIn = new Map(foxyDef.inputs.map((p) => [p.id, p.type]));
    for (const wIn of wavecelDef.inputs) {
      expect(fIn.get(wIn.id), `input ${wIn.id}`).toBe(wIn.type);
    }
  });

  it('exposes WAVECEL\'s exact output IDs + types (out_l/out_r/scope_out/wave3d_out)', () => {
    const fOut = new Map(foxyDef.outputs.map((p) => [p.id, p.type]));
    for (const wOut of wavecelDef.outputs) {
      expect(fOut.get(wOut.id), `output ${wOut.id}`).toBe(wOut.type);
    }
    expect(fOut.get('scope_out')).toBe('mono-video');
    expect(fOut.get('wave3d_out')).toBe('video');
  });

  it('keeps the WAVECEL stereo pair metadata', () => {
    expect(foxyDef.stereoPairs).toEqual([['out_l', 'out_r']]);
  });

  it('carries every WAVECEL param (tune/fine/morph/spread/fold) with matching ranges', () => {
    const fParams = new Map(foxyDef.params.map((p) => [p.id, p]));
    for (const wp of wavecelDef.params) {
      const fp = fParams.get(wp.id);
      expect(fp, `param ${wp.id}`).toBeDefined();
      expect(fp!.min).toBe(wp.min);
      expect(fp!.max).toBe(wp.max);
      expect(fp!.defaultValue).toBe(wp.defaultValue);
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
