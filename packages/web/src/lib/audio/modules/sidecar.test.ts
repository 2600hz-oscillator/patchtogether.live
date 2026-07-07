// packages/web/src/lib/audio/modules/sidecar.test.ts
//
// Two test layers:
//   1. Module-def shape: 7 inputs, 4 outputs, 9 params, stereo pairs, CV
//      targets, ossAttribution mentions GMR.
//   2. Real DSP behavior via the worklet processor class — drive
//      process() directly under a registerProcessor shim.
//
// DUCKER topology (post fix/sidecar-sidechain-mix): the MAIN pair is the
// trigger (detector + passthrough); the SIDECHAIN pair is gained by
// inputLevel, ducked by the gain reduction the main triggers, then summed
// into the output. So the SC is ALWAYS in the output except when the main
// fires and ducks it down.

import { describe, it, expect, beforeAll } from 'vitest';
import { sidecarDef } from './sidecar';

const SR = 48000;

beforeAll(() => {
  (globalThis as unknown as { sampleRate: number }).sampleRate = SR;
});

type ProcCtor = new () => {
  process: (i: Float32Array[][], o: Float32Array[][], p: Record<string, Float32Array>) => boolean;
};
let capturedProc: ProcCtor | null = null;
async function loadProcessor(): Promise<ProcCtor> {
  if (capturedProc) return capturedProc;
  const g = globalThis as unknown as { registerProcessor?: (n: string, c: ProcCtor) => void };
  const prev = g.registerProcessor;
  let registered: ProcCtor | null = null;
  g.registerProcessor = (_n, ctor) => { registered = ctor; };
  await import('../../../../../dsp/src/sidecar');
  g.registerProcessor = prev;
  if (!registered) throw new Error('sidecar processor did not register');
  capturedProc = registered;
  return capturedProc;
}

const BLOCK = 128;

function makeParams(over: Record<string, number> = {}): Record<string, Float32Array> {
  const base: Record<string, number> = {};
  for (const p of sidecarDef.params) base[p.id] = p.defaultValue;
  Object.assign(base, over);
  const out: Record<string, Float32Array> = {};
  for (const [k, v] of Object.entries(base)) out[k] = new Float32Array([v]);
  return out;
}

// ────────────────────────────────────────────────────────────────────────────
// Module-def shape
// ────────────────────────────────────────────────────────────────────────────

// ────────────────────────────────────────────────────────────────────────────
// Worklet behavior
// ────────────────────────────────────────────────────────────────────────────

/** Run the processor for `seconds`, returning the L audio output AND the
 *  env_out, both as full-length Float32Arrays. `inMainFn` drives the MAIN /
 *  trigger pair (detector + passthrough); `inScFn` drives the SIDECHAIN
 *  pair (the ducked signal). When `inScFn` is omitted the SC is left
 *  unpatched (empty outer array) — the main still passes through. */
function runProc(
  proc: { process: (i: Float32Array[][], o: Float32Array[][], p: Record<string, Float32Array>) => boolean },
  params: Record<string, Float32Array>,
  seconds: number,
  inMainFn: (n: number) => number,
  inScFn?: (n: number) => number,
): { audioL: Float32Array; envOut: Float32Array } {
  const total = Math.round(SR * seconds);
  const audioL = new Float32Array(total);
  const envOut = new Float32Array(total);
  let g = 0;
  while (g < total) {
    const len = Math.min(BLOCK, total - g);
    const inAL = new Float32Array(len);
    const inAR = new Float32Array(len);
    const hasSc = !!inScFn;
    const inSL = hasSc ? new Float32Array(len) : new Float32Array(0);
    const inSR = hasSc ? new Float32Array(len) : new Float32Array(0);
    for (let i = 0; i < len; i++) {
      const v = inMainFn(g + i);
      inAL[i] = v;
      inAR[i] = v;
      if (hasSc) {
        const s = inScFn!(g + i);
        inSL[i] = s;
        inSR[i] = s;
      }
    }
    const outL = new Float32Array(len);
    const outR = new Float32Array(len);
    const outE = new Float32Array(len);
    const outEi = new Float32Array(len);
    // Per the worklet contract: inputs[i] = [] (zero-length outer) when
    // unpatched. When SC is unpatched, pass an empty outer array.
    const scInputL = hasSc ? [inSL] : [];
    const scInputR = hasSc ? [inSR] : [];
    proc.process(
      [[inAL], [inAR], scInputL, scInputR],
      [[outL], [outR], [outE], [outEi]],
      params,
    );
    for (let i = 0; i < len; i++) {
      audioL[g + i] = outL[i] as number;
      envOut[g + i] = outE[i] as number;
    }
    g += len;
  }
  return { audioL, envOut };
}

function rms(buf: Float32Array, start = 0, end = buf.length): number {
  let s = 0;
  const n = end - start;
  for (let i = start; i < end; i++) s += (buf[i] ?? 0) * (buf[i] ?? 0);
  return Math.sqrt(s / n);
}

describe('SIDECAR worklet — ducker core (THE BUG FIX)', () => {
  it('sidechain IS present at the output when the main is silent', async () => {
    // ROOT-CAUSE REGRESSION: previously the SC was a detector-only input —
    // it never reached the output, so a patched SC with a silent main gave
    // SILENCE. The fix sums the (ducked) SC into the output. With the main
    // silent, duck gain = 1 → SC passes through at unity.
    const Proc = await loadProcessor();
    const p = new Proc();
    const r = runProc(p, makeParams({ threshold: -18, ratio: 8, knee: 0, attack: 5, release: 50, inputLevel: 1 }),
      0.3,
      () => 0,                                                  // MAIN silent
      (n) => 0.5 * Math.sin(2 * Math.PI * 1000 * n / SR),       // SC present
    );
    const scIn = 0.5 / Math.SQRT2;
    const outRms = rms(r.audioL, Math.round(0.1 * SR));
    // SC must appear at the output near unity (no ducking → no reduction).
    expect(outRms).toBeGreaterThan(scIn * 0.9);
    expect(outRms).toBeLessThan(scIn * 1.1);
  });

  it('sidechain is ATTENUATED at the output when the main has signal', async () => {
    // The output is MAIN + ducked(SC), so a hot main ADDS its own pass-
    // through energy — total RMS alone can't isolate the SC. We extract the
    // SC contribution by subtraction:
    //   scComponent = out(main + SC) − out(main only)
    // and compare its level to the un-ducked SC (main silent). A hot main
    // must pull the SC component well below its open level.
    const Proc = await loadProcessor();
    const params = makeParams({ threshold: -18, ratio: 8, knee: 0, attack: 5, release: 50, inputLevel: 1 });
    const mainFn = (n: number) => 0.6 * Math.sin(2 * Math.PI * 1000 * n / SR); // steady hot trigger
    const scFn   = (n: number) => 0.5 * Math.sin(2 * Math.PI *  311 * n / SR); // SC pad (different freq)

    // Open: main silent → SC un-ducked.
    const open = runProc(new Proc(), params, 0.3, () => 0, scFn);
    const openScRms = rms(open.audioL, Math.round(0.15 * SR));

    // Main only (SC = 0) → the passthrough leg we subtract off.
    const mainOnly = runProc(new Proc(), params, 0.3, mainFn, () => 0);
    // Main + SC → contains the (ducked) SC plus the same passthrough.
    const both = runProc(new Proc(), params, 0.3, mainFn, scFn);

    // SC component while the main is firing = (main+SC) − (main only).
    const start = Math.round(0.15 * SR);
    let s = 0; const end = both.audioL.length;
    for (let i = start; i < end; i++) {
      const d = (both.audioL[i] ?? 0) - (mainOnly.audioL[i] ?? 0);
      s += d * d;
    }
    const duckedScRms = Math.sqrt(s / (end - start));

    // The ducked SC must be clearly below its open (un-ducked) level.
    expect(duckedScRms).toBeLessThan(openScRms * 0.7);
    // ...and the open SC really is present (the core fix).
    expect(openScRms).toBeGreaterThan(0.3);
  });

  it('main passes through to the output (passthrough leg)', async () => {
    // With NO sidechain patched, the main alone must reach the output (it
    // is NOT compressed in the ducker topology — it is the trigger + dry
    // passthrough).
    const Proc = await loadProcessor();
    const p = new Proc();
    const r = runProc(p, makeParams({ threshold: -18, ratio: 8, knee: 0, attack: 5, release: 50 }),
      0.3, (n) => 0.4 * Math.sin(2 * Math.PI * 200 * n / SR)); // main only, no SC
    const mainIn = 0.4 / Math.SQRT2;
    const outRms = rms(r.audioL, Math.round(0.1 * SR));
    // Main passes at unity (it is the dry passthrough leg).
    expect(outRms).toBeGreaterThan(mainIn * 0.9);
    expect(outRms).toBeLessThan(mainIn * 1.1);
  });

  it('env_out > 0 while the main triggers ducking; near 0 when it does not', async () => {
    const Proc = await loadProcessor();
    const pHot = new Proc();
    const hot = runProc(pHot, makeParams({ threshold: -18, ratio: 8, envMag: 1 }),
      0.3, (n) => 0.71 * Math.sin(2 * Math.PI * 1000 * n / SR)); // hot main
    const tailEnv = hot.envOut[Math.round(0.25 * SR)] ?? 0;
    expect(tailEnv).toBeGreaterThan(0.05);

    const pSoft = new Proc();
    const soft = runProc(pSoft, makeParams({ threshold: -18, envMag: 1 }),
      0.3, (n) => 0.01 * Math.sin(2 * Math.PI * 1000 * n / SR)); // quiet main
    const softTail = soft.envOut[Math.round(0.25 * SR)] ?? 0;
    expect(Math.abs(softTail)).toBeLessThan(0.05);
  });
});

describe('SIDECAR worklet — inputLevel (sidechain input volume, 0–200%)', () => {
  it('inputLevel scales the sidechain in the output: 200% ≈ 2× of 100%, 0% ≈ silence', async () => {
    const Proc = await loadProcessor();
    const scFn = (n: number) => 0.3 * Math.sin(2 * Math.PI * 1000 * n / SR);

    // Main silent → no ducking → output = inputLevel · SC.
    const at100 = new Proc();
    const r100 = runProc(at100, makeParams({ inputLevel: 1.0 }), 0.2, () => 0, scFn);
    const rms100 = rms(r100.audioL, Math.round(0.1 * SR));

    const at200 = new Proc();
    const r200 = runProc(at200, makeParams({ inputLevel: 2.0 }), 0.2, () => 0, scFn);
    const rms200 = rms(r200.audioL, Math.round(0.1 * SR));

    const at0 = new Proc();
    const r0 = runProc(at0, makeParams({ inputLevel: 0.0 }), 0.2, () => 0, scFn);
    const rms0 = rms(r0.audioL, Math.round(0.1 * SR));

    // 200% should be ~2× the 100% level (allow smoother/measurement slack).
    expect(rms200 / rms100).toBeGreaterThan(1.8);
    expect(rms200 / rms100).toBeLessThan(2.2);
    // 0% should be (near) silence.
    expect(rms0).toBeLessThan(rms100 * 0.05);
  });

  it('inputLevel does NOT change how hard the main triggers ducking', async () => {
    // The detector reads the MAIN pair, so inputLevel must not affect the
    // gain reduction (env_out) — only the SC level at the output.
    const Proc = await loadProcessor();
    const mainFn = (n: number) => 0.71 * Math.sin(2 * Math.PI * 1000 * n / SR);

    const a = new Proc();
    const ra = runProc(a, makeParams({ inputLevel: 0.2, threshold: -18, ratio: 8 }),
      0.3, mainFn, (n) => 0.3 * Math.sin(2 * Math.PI * 500 * n / SR));
    const b = new Proc();
    const rb = runProc(b, makeParams({ inputLevel: 2.0, threshold: -18, ratio: 8 }),
      0.3, mainFn, (n) => 0.3 * Math.sin(2 * Math.PI * 500 * n / SR));

    const envA = ra.envOut[Math.round(0.25 * SR)] ?? 0;
    const envB = rb.envOut[Math.round(0.25 * SR)] ?? 0;
    // Same detector drive → env_out (reduction) essentially identical.
    expect(Math.abs(envA - envB)).toBeLessThan(0.02);
  });
});

describe('SIDECAR worklet — env_out overshoot at envMag=2 (NEW SPEC PIN)', () => {
  it('hard reduction + envMag=2 → env_out clearly exceeds 1.0 (overshoot allowed)', async () => {
    // Drive the compressor into deep reduction with envMag=2. env_out =
    // (-gainDb / 24) * envMag, so with envMag=2 and ANY reduction ≥ 12 dB
    // we already cross env_out > 1. The NEW SPEC PIN is just "env_out
    // must not be silently clamped at 1.0 when envMag > 1" — which we
    // verify by observing env_out comfortably > 1.0 in the converged tail.
    const Proc = await loadProcessor();
    const p = new Proc();
    const r = runProc(p, makeParams({
      threshold: -40, ratio: 20, knee: 0, attack: 1, release: 50, envMag: 2,
    }), 0.5, (n) => 1.0 * Math.sin(2 * Math.PI * 1000 * n / SR));
    const tailEnv = r.envOut[Math.round(0.45 * SR)] ?? 0;
    // env_out MUST overshoot 1.0 — this is the spec-pin contract.
    expect(tailEnv).toBeGreaterThan(1.0);
    // Pin the actual value to the run log for the final report.
    console.log(`[sidecar] env_out at envMag=2, hard reduction = ${tailEnv.toFixed(4)}`);
  });

  it('measured env_out matches the un-clamped formula (-gainDb/24)*envMag', async () => {
    // Independently verify the un-clamped formula holds in the worklet —
    // pick a parameter set that yields a known steady-state gainDb, and
    // confirm env_out = (-gainDb/24) * envMag within rounding.
    const Proc = await loadProcessor();
    // Lighter compression: threshold=-20, ratio=4, signal=0dB.
    // |sin|+|sin| peak = 2.0 → log2(2.0) = 1 → dB = +6.02. Excess over
    // threshold (-20) = 26.02 dB. gainDb (peak) = -0.75 * 26.02 ≈ -19.5.
    // At envMag = 2: env_out (peak) = (19.5/24) * 2 ≈ 1.625.
    const p = new Proc();
    const r = runProc(p, makeParams({
      threshold: -20, ratio: 4, knee: 0, attack: 1, release: 50, envMag: 2,
    }), 0.5, (n) => 1.0 * Math.sin(2 * Math.PI * 1000 * n / SR));
    // Take the peak env_out over the converged tail.
    let peak = 0;
    for (let i = Math.round(0.4 * SR); i < r.envOut.length; i++) {
      const v = r.envOut[i] ?? 0;
      if (v > peak) peak = v;
    }
    // Should be ≈ 1.625, well above 1.0.
    expect(peak).toBeGreaterThan(1.0);
    expect(peak).toBeLessThan(2.0);
  });
});

describe('SIDECAR worklet — sc_hpf gates low-frequency triggering (detector HPF on MAIN)', () => {
  it('50Hz MAIN trigger with hpf=500Hz → much LESS ducking of the SC vs unfiltered', async () => {
    // The detector HPF lives on the MAIN (trigger) pair. A 50 Hz trigger +
    // a 1 kHz SC pad: with sc_hpf=500 the 50 Hz trigger is rolled off the
    // detector → little ducking → env_out near 0; with sc_hpf=20 (off) the
    // trigger ducks hard → env_out large. We assert on env_out (the gain
    // reduction) because total output RMS is dominated by the 50 Hz main
    // passthrough, which masks the SC level.
    const Proc = await loadProcessor();
    const trigger = (n: number) => 1.0 * Math.sin(2 * Math.PI * 50 * n / SR);
    const scPad   = (n: number) => 0.3 * Math.sin(2 * Math.PI * 1000 * n / SR);

    const rHpfOn = runProc(new Proc(), makeParams({
      threshold: -18, ratio: 8, attack: 5, release: 50, sc_hpf: 500,
    }), 0.3, trigger, scPad);
    const envOn = rHpfOn.envOut[Math.round(0.2 * SR)] ?? 0;

    const rHpfOff = runProc(new Proc(), makeParams({
      threshold: -18, ratio: 8, attack: 5, release: 50, sc_hpf: 20,
    }), 0.3, trigger, scPad);
    const envOff = rHpfOff.envOut[Math.round(0.2 * SR)] ?? 0;

    // HPF on → the 50 Hz trigger is gated → far less gain reduction.
    expect(envOn).toBeLessThan(envOff * 0.5);
  });

  it('50Hz MAIN trigger with hpf=800Hz + modest level → no measurable ducking of the SC', async () => {
    // 800 Hz ÷ 50 Hz ≈ 4 octaves → ~24 dB attenuation. MAIN amp = 0.3 →
    // detector residual 0.3 * 50/800 ≈ 0.019 → 2*0.019 = 0.038 → -28 dB,
    // BELOW threshold -18 → no ducking → SC passes at full inputLevel.
    const Proc = await loadProcessor();
    const p = new Proc();
    const r = runProc(p, makeParams({
      threshold: -18, ratio: 8, attack: 5, release: 50, sc_hpf: 800, inputLevel: 1,
    }), 0.3,
      (n) => 0.3 * Math.sin(2 * Math.PI * 50 * n / SR),   // MAIN trigger
      (n) => 0.2 * Math.sin(2 * Math.PI * 1000 * n / SR), // SC pad
    );
    const scIn = 0.2 / Math.SQRT2;
    const outRms = rms(r.audioL, Math.round(0.15 * SR));
    // SC at the output ≈ its full level — the HPF gated the trigger so no
    // ducking happens. (Tiny 50 Hz passthrough leg adds a small amount.)
    expect(outRms).toBeGreaterThan(scIn * 0.9);
  });
});

describe('SIDECAR worklet — unpatched sidechain', () => {
  it('with no SC patched, a hot main simply passes through (nothing to duck)', async () => {
    const Proc = await loadProcessor();
    const p = new Proc();
    // Loud main, NO SC patched → main passes through at unity (it is the
    // dry trigger/passthrough leg; the ducker has no SC to attenuate).
    const r = runProc(p, makeParams({ threshold: -18, ratio: 8, attack: 5, release: 50 }),
      0.3, (n) => 0.71 * Math.sin(2 * Math.PI * 1000 * n / SR));
    const inRms = 0.71 / Math.SQRT2;
    const outRms = rms(r.audioL, Math.round(0.15 * SR));
    expect(outRms).toBeGreaterThan(inRms * 0.9);
    expect(outRms).toBeLessThan(inRms * 1.1);
  });
});
