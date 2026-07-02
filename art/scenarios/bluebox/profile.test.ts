// art/scenarios/bluebox/profile.test.ts
//
// AUDIO PROFILE for BLUEBOX (backfill batch 1 — spec §4.1/§4.3,
// .myrobots/plans/art-backfill-audio-profiles-2026-07-01.md), through the
// shared capture harness (art/setup/capture.ts).
//
// Category: gate-driven SOURCE (12 push-to-talk tone buttons). The driver
// is the module's own story: dial 2-6-0-0 (four DTMF digit presses), then
// hold the BLUEBOX button — the 2600 Hz supervisory tone. 150 ms per digit
// with 50 ms gaps, 300 ms of 2600 Hz, 1.2 s total.
//
// Rendering path: the REAL worklet processor class. bluebox.ts has no
// separate render core (lib/bluebox-dsp.ts is the tone TABLE; the sine
// bank lives in process()), but the worklet entry is self-contained pure
// math (shared phase per unique freq + 1 ms one-pole click ramp, no RNG),
// so we capture the class via the registerProcessor shim — the exact
// pattern of packages/web/src/lib/audio/modules/bluebox.test.ts — and pump
// process() in 128-sample blocks. Zero mirror, zero drift: this IS the
// shipping DSP. Buttons are driven through the btn_* AudioParams (full
// a-rate arrays, so segment edges are sample-exact); the gate inputs are
// the OR'd equivalent path.
//
// SIGNATURE output (owner decision §6b.2): the single mono `out`.
//
// The .sha pins BOTH the worklet entry and the tone-table lib
// (combinedSourceSha discipline) so a change in either forces an
// intentional `task art:update`.

import { describe, expect, it } from 'vitest';
import { BLUEBOX_BUTTON_NAMES } from '../../../packages/dsp/src/lib/bluebox-dsp';
import { dspSourceSha, pinAll, SAMPLE_RATE } from '../../setup/capture';

const SR = SAMPLE_RATE;
const DURATION_S = 1.2;
const BLOCK = 128;

// The dialed sequence: button name → [onS, offS). 2-6-0-0, then 2600 Hz.
const SCHEDULE: ReadonlyArray<readonly [string, number, number]> = [
  ['2', 0.0, 0.15],
  ['6', 0.2, 0.35],
  ['0', 0.4, 0.55],
  ['0', 0.6, 0.75],
  ['bluebox', 0.8, 1.1],
];

// ── Capture the processor class via the registerProcessor shim ─────────────
interface WorkletLike {
  process(
    inputs: Float32Array[][],
    outputs: Float32Array[][],
    parameters: Record<string, Float32Array>,
  ): boolean;
}
type ProcCtor = new (opts?: unknown) => WorkletLike;

let capturedProc: ProcCtor | null = null;
async function loadProcessor(): Promise<ProcCtor> {
  if (capturedProc) return capturedProc;
  const g = globalThis as unknown as {
    sampleRate?: number;
    registerProcessor?: (n: string, c: ProcCtor) => void;
  };
  g.sampleRate = SR; // the worklet ctor reads the global sampleRate
  const prev = g.registerProcessor;
  let registered: ProcCtor | null = null;
  g.registerProcessor = (_n, ctor) => {
    registered = ctor;
  };
  await import('../../../packages/dsp/src/bluebox');
  g.registerProcessor = prev;
  if (!registered) throw new Error('bluebox.ts did not registerProcessor()');
  capturedProc = registered;
  return capturedProc;
}

// ── Render ──────────────────────────────────────────────────────────────────

/** Full-length per-button param schedules (sample-exact segment edges). */
function buttonSchedules(n: number): Map<string, Float32Array> {
  const m = new Map<string, Float32Array>();
  for (const [name, onS, offS] of SCHEDULE) {
    const key = `btn_${name}`;
    let buf = m.get(key);
    if (!buf) {
      buf = new Float32Array(n);
      m.set(key, buf);
    }
    buf.fill(1, Math.round(onS * SR), Math.round(offS * SR));
  }
  return m;
}

async function renderProfile(): Promise<Record<string, Float32Array>> {
  const Proc = await loadProcessor();
  const proc = new Proc();
  const n = Math.round(SR * DURATION_S);
  const schedules = buttonSchedules(n);
  const zeroBlock = new Float32Array(BLOCK); // shared all-off a-rate array
  const out = new Float32Array(n);
  const block = new Float32Array(BLOCK);
  for (let start = 0; start < n; start += BLOCK) {
    const len = Math.min(BLOCK, n - start);
    block.fill(0);
    const params: Record<string, Float32Array> = {};
    for (const name of BLUEBOX_BUTTON_NAMES) {
      const sched = schedules.get(`btn_${name}`);
      params[`btn_${name}`] = sched
        ? sched.subarray(start, start + len)
        : zeroBlock.subarray(0, len);
    }
    proc.process([], [[block.subarray(0, len)]], params);
    out.set(block.subarray(0, len), start);
  }
  return { out };
}

// ── Assertions ──────────────────────────────────────────────────────────────

/** Goertzel magnitude (normalized 2/N) of freqHz over buf[s, e). */
function goertzel(buf: Float32Array, s: number, e: number, freqHz: number): number {
  const N = e - s;
  const w = (2 * Math.PI * freqHz) / SR;
  const coeff = 2 * Math.cos(w);
  let q1 = 0;
  let q2 = 0;
  for (let i = s; i < e; i++) {
    const q0 = coeff * q1 - q2 + buf[i]!;
    q2 = q1;
    q1 = q0;
  }
  const re = q1 - q2 * Math.cos(w);
  const im = q2 * Math.sin(w);
  return (2 / N) * Math.sqrt(re * re + im * im);
}

function rms(b: Float32Array, s = 0, e = b.length): number {
  let x = 0;
  for (let i = s; i < e; i++) x += b[i]! * b[i]!;
  return Math.sqrt(x / Math.max(1, e - s));
}

describe('ART bluebox / audio profile (dial 2-6-0-0, then the 2600 Hz tone)', () => {
  it('renders each segment with its exact tones, silence in the gaps', async () => {
    const out = (await renderProfile()).out!;
    const at = (s: number) => Math.round(s * SR);
    expect(out.length).toBe(Math.round(SR * DURATION_S));
    expect(out.every(Number.isFinite)).toBe(true);
    // '2' = DTMF 697 + 1336 Hz (and NO 2600) — probe mid-segment.
    expect(goertzel(out, at(0.03), at(0.13), 697)).toBeGreaterThan(0.15);
    expect(goertzel(out, at(0.03), at(0.13), 1336)).toBeGreaterThan(0.15);
    expect(goertzel(out, at(0.03), at(0.13), 2600)).toBeLessThan(0.01);
    // '0' = 941 + 1336 Hz.
    expect(goertzel(out, at(0.43), at(0.53), 941)).toBeGreaterThan(0.15);
    // BLUEBOX = the lone 2600 Hz supervisory tone (no DTMF rows).
    expect(goertzel(out, at(0.9), at(1.05), 2600)).toBeGreaterThan(0.2);
    expect(goertzel(out, at(0.9), at(1.05), 697)).toBeLessThan(0.01);
    // Gaps are silent (1 ms click ramp has fully settled ~20 ms in).
    expect(rms(out, at(0.17), at(0.19))).toBeLessThan(0.005);
    expect(rms(out, at(0.77), at(0.79))).toBeLessThan(0.005);
    // Deterministic re-render is bit-identical (fresh processor instance).
    const again = (await renderProfile()).out!;
    let diff = 0;
    for (let i = 0; i < out.length; i++) diff = Math.max(diff, Math.abs(out[i]! - again[i]!));
    expect(diff).toBe(0);
  });

  it('pins the out profile baseline (SHA-gated, RMS tier B)', async () => {
    const srcSha = await dspSourceSha('bluebox.ts', 'lib/bluebox-dsp.ts');
    await pinAll('bluebox', srcSha, await renderProfile());
  });
});
