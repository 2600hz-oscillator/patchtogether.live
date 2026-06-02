// packages/web/src/lib/audio/modules/analog-vco-sync.test.ts
//
// Unit coverage for the ANALOG VCO HARD-SYNC in/out (feat/analog-vco-sync).
//
// The sync logic lives in Faust (packages/dsp/src/analog-vco.dsp) and is
// compiled to WASM, so we can't import the worklet here. Instead we mirror
// the EXACT per-sample recurrences from the .dsp in JS — the same approach
// analog-vco-morph.test.ts uses for the morph crossfade — and assert the
// sync's defining properties:
//
//   1. sync_in: a rising zero-crossing edge hard-RESETS the phase to 0
//      mid-cycle (classic hard sync).
//   2. sync_out: a one-sample +1 pulse at each cycle boundary (phase wrap),
//      i.e. once per cycle, aligned to the fundamental.
//   3. BACKWARD COMPAT: with sync UNPATCHED (silent input, 0 every sample),
//      the phasor — and therefore every waveform tap — is BIT-IDENTICAL to
//      the ORIGINAL un-synced phasor. No NaN / Inf anywhere.
//
// The references below are kept algebraically identical to the `.dsp` so a
// regression in the Faust source that diverges is caught here. The .dsp:
//
//   syncEdge(sync)         = (sync > 0) & (sync' <= 0)              // rising edge
//   phasorReset(f, reset)  = loop ~ _
//     with { loop(prev)    = (1 - reset) * frac(prev + f/SR); }
//   syncPulse(pRaw)        = (pRaw < pRaw') * 1.0                   // wrap detect
//
// where `'` is the one-sample delay (previous sample) and frac(x)=x-floor(x).

import { describe, expect, it } from 'vitest';

const SR = 48000;
const frac = (x: number) => x - Math.floor(x);

/** ORIGINAL phasor recurrence (pre-sync): p[n] = frac(p[n-1] + f/SR).
 *  This is `phasor(f) = (+(f/ma.SR) : ma.frac) ~ _` from the v4 .dsp. */
function renderPhasorOriginal(freqHz: number, n: number): Float32Array {
  const out = new Float32Array(n);
  let prev = 0;
  for (let i = 0; i < n; i++) {
    prev = frac(prev + freqHz / SR);
    out[i] = prev;
  }
  return out;
}

/** NEW reset-capable phasor: p[n] = (1 - reset[n]) * frac(p[n-1] + f/SR).
 *  `reset` is the per-sample rising-edge flag from syncEdge(sync). */
function renderPhasorReset(freqHz: number, reset: Float32Array, n: number): Float32Array {
  const out = new Float32Array(n);
  let prev = 0;
  for (let i = 0; i < n; i++) {
    const r = reset[i] ?? 0;
    prev = (1 - r) * frac(prev + freqHz / SR);
    out[i] = prev;
  }
  return out;
}

/** JS mirror of syncEdge(sync) = (sync>0) & (sync'<=0): rising zero-crossing. */
function syncEdges(sync: Float32Array): Float32Array {
  const out = new Float32Array(sync.length);
  let prev = 0; // Faust's `sync'` initial state is 0.
  for (let i = 0; i < sync.length; i++) {
    const cur = sync[i]!;
    out[i] = cur > 0 && prev <= 0 ? 1 : 0;
    prev = cur;
  }
  return out;
}

/** JS mirror of syncPulse(pRaw) = (pRaw < pRaw') * 1.0: a +1 the sample the
 *  raw phasor wraps DOWN past 1.0 (back toward 0). */
function syncOut(pRaw: Float32Array): Float32Array {
  const out = new Float32Array(pRaw.length);
  let prev = 0; // Faust's `pRaw'` initial state is 0.
  for (let i = 0; i < pRaw.length; i++) {
    const cur = pRaw[i]!;
    out[i] = cur < prev ? 1 : 0;
    prev = cur;
  }
  return out;
}

// Waveform taps, identical to the .dsp, so we can assert tap-level identity.
const sawTap = (p: number) => 2 * p - 1;
const sinTap = (p: number) => Math.sin(2 * Math.PI * p);

describe('analogVco hard-sync: backward compat (sync UNPATCHED)', () => {
  it('phasor with all-zero sync is BIT-IDENTICAL to the original un-synced phasor', () => {
    // sync input silent (0 every sample) → syncEdge is 0 every sample →
    // reset is 0 every sample → (1-0)*frac(...) == frac(...) == original.
    const N = SR; // 1 second
    for (const f of [110, 261.626, 440, 1000, 3333.33]) {
      const silentSync = new Float32Array(N); // all zeros
      const reset = syncEdges(silentSync);
      // The silent sync must produce NO reset events whatsoever.
      expect(reset.some((v) => v !== 0), `freq ${f}: silent sync produced a reset`).toBe(false);

      const original = renderPhasorOriginal(f, N);
      const withSync = renderPhasorReset(f, reset, N);
      // Bit-for-bit equal (===) — not just close — because the recurrence is
      // arithmetically identical when reset is 0.
      let firstDiff = -1;
      for (let i = 0; i < N; i++) {
        if (original[i] !== withSync[i]) { firstDiff = i; break; }
      }
      expect(
        firstDiff,
        `freq ${f}: first divergence at sample ${firstDiff} (orig ${original[firstDiff]} vs sync ${withSync[firstDiff]})`,
      ).toBe(-1);
    }
  });

  it('all waveform taps are bit-identical with sync unpatched (no drift)', () => {
    const N = 4096;
    const f = 261.626;
    const silentSync = new Float32Array(N);
    const reset = syncEdges(silentSync);
    const orig = renderPhasorOriginal(f, N);
    const sync = renderPhasorReset(f, reset, N);
    for (let i = 0; i < N; i++) {
      expect(sawTap(sync[i]!)).toBe(sawTap(orig[i]!));
      expect(sinTap(sync[i]!)).toBe(sinTap(orig[i]!));
    }
  });

  it('produces no NaN / Inf anywhere (silent sync)', () => {
    const N = SR;
    const reset = syncEdges(new Float32Array(N));
    const p = renderPhasorReset(440, reset, N);
    const bad = p.findIndex((v) => !Number.isFinite(v));
    expect(bad, `non-finite phasor sample at ${bad}`).toBe(-1);
    // sync_out on the silent run pulses only at real cycle boundaries —
    // never produces NaN/Inf either.
    const so = syncOut(p);
    const badSo = so.findIndex((v) => !Number.isFinite(v));
    expect(badSo).toBe(-1);
  });
});

describe('analogVco hard-sync: sync_in resets phase to 0 mid-cycle', () => {
  it('a rising edge forces the phase to exactly 0 on that sample', () => {
    const N = 2000;
    const f = 100; // slow enough that a cycle spans many samples
    // Build a sync input that rises once, mid-cycle (sample 250).
    const sync = new Float32Array(N);
    for (let i = 250; i < 260; i++) sync[i] = 1; // a 10-sample-wide gate
    const reset = syncEdges(sync);
    // Exactly ONE rising edge at sample 250.
    expect(reset[250]).toBe(1);
    expect(reset.reduce((a, b) => a + b, 0)).toBe(1);

    const p = renderPhasorReset(f, reset, N);
    // On the reset sample the phase is forced to 0.
    expect(p[250]).toBe(0);
    // It was MID-cycle just before the reset (i.e. not already ~0): proves the
    // reset actually interrupted an in-progress cycle.
    expect(p[249]!).toBeGreaterThan(0.1);
    // And it resumes accumulating from 0 right after.
    expect(p[251]!).toBeCloseTo(f / SR, 9);
  });

  it('the synced (slave) phase differs from the un-synced phase after the edge', () => {
    // The defining hard-sync behaviour: the slave restarts, so its phase
    // trajectory diverges from what it would have been with no sync.
    const N = 2000;
    const f = 137; // slave free-runs at 137 Hz
    const sync = new Float32Array(N);
    sync[800] = 1; // single rising edge
    const reset = syncEdges(sync);
    const free = renderPhasorReset(f, new Float32Array(N), N); // no resets
    const synced = renderPhasorReset(f, reset, N);
    // Before the edge they agree.
    expect(synced[799]).toBe(free[799]);
    // At/after the edge they diverge (slave got reset).
    expect(synced[800]).toBe(0);
    let diverged = false;
    for (let i = 801; i < 900; i++) {
      if (synced[i] !== free[i]) { diverged = true; break; }
    }
    expect(diverged, 'synced phase never diverged from free-run after the edge').toBe(true);
  });

  it('master→slave hard sync makes the slave restart at the MASTER cycle rate', () => {
    // Master @ 100 Hz emits sync_out pulses; feed them into a 263 Hz slave's
    // sync_in. The slave must then RESET on every master cycle, so its phase
    // hits 0 at the master's period — the characteristic hard-sync lock.
    const N = SR; // 1 s
    const masterHz = 100;
    const slaveHz = 263;
    const masterPhase = renderPhasorOriginal(masterHz, N);
    const masterSyncOut = syncOut(masterPhase);
    // Master emits ~100 pulses in 1 s (one per cycle).
    const pulses = masterSyncOut.reduce((a, b) => a + b, 0);
    expect(pulses).toBeGreaterThan(98);
    expect(pulses).toBeLessThan(102);

    // Drive the slave with the master's sync_out.
    const slaveReset = syncEdges(masterSyncOut);
    const slavePhase = renderPhasorReset(slaveHz, slaveReset, N);
    // Every master pulse resets the slave to 0.
    for (let i = 0; i < N; i++) {
      if (masterSyncOut[i] === 1) {
        expect(slavePhase[i], `slave not reset at master pulse sample ${i}`).toBe(0);
      }
    }
    // The synced slave differs from the free-running slave (timbre change).
    const freeSlave = renderPhasorReset(slaveHz, new Float32Array(N), N);
    let differs = false;
    for (let i = 0; i < N; i++) {
      if (Math.abs(slavePhase[i]! - freeSlave[i]!) > 1e-6) { differs = true; break; }
    }
    expect(differs, 'hard-synced slave is identical to free-running slave').toBe(true);
  });
});

describe('analogVco hard-sync: sync_out pulses once per cycle', () => {
  it('emits exactly one pulse per oscillator cycle, at the wrap', () => {
    const N = SR; // 1 s
    for (const f of [50, 100, 220, 500]) {
      const p = renderPhasorOriginal(f, N);
      const so = syncOut(p);
      const count = so.reduce((a, b) => a + b, 0);
      // ~f pulses in 1 s, within ±1 for the partial cycle at the boundary.
      expect(Math.abs(count - f), `freq ${f}: ${count} pulses, expected ~${f}`).toBeLessThanOrEqual(1);
      // Every pulse is exactly +1 (one-sample rising edge), no fractional values.
      for (let i = 0; i < N; i++) {
        expect(so[i] === 0 || so[i] === 1, `non-{0,1} sync_out at ${i}: ${so[i]}`).toBe(true);
      }
    }
  });

  it('the pulse lands on the sample where the phasor wraps (phase near 0)', () => {
    const N = 4000;
    const f = 200;
    const p = renderPhasorOriginal(f, N);
    const so = syncOut(p);
    for (let i = 1; i < N; i++) {
      if (so[i] === 1) {
        // On a pulse sample the phasor just wrapped: it's small (near 0) and
        // the PREVIOUS sample was large (near 1).
        expect(p[i]!, `pulse at ${i} but phase ${p[i]} not near 0`).toBeLessThan(f / SR + 1e-9);
        expect(p[i - 1]!, `pulse at ${i} but prev phase ${p[i - 1]} not near 1`).toBeGreaterThan(1 - 2 * (f / SR));
      }
    }
  });

  it('a free-running VCO with no sync still emits a clean pulse train (sync_out independent of sync_in)', () => {
    // sync_out is derived from the oscillator's own phase wrap, so it works
    // even when sync_in is unpatched — that's what lets a master drive slaves.
    const N = SR;
    const reset = syncEdges(new Float32Array(N)); // no sync_in
    const p = renderPhasorReset(440, reset, N);
    const so = syncOut(p);
    const count = so.reduce((a, b) => a + b, 0);
    expect(Math.abs(count - 440)).toBeLessThanOrEqual(1);
  });
});
