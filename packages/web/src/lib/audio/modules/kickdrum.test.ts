// packages/web/src/lib/audio/modules/kickdrum.test.ts
//
// KICK DRUM module-def shape + worklet behavior. The per-sample DSP math is
// pinned in packages/dsp/src/lib/kickdrum-dsp.test.ts (the pure core) and the
// raw audio profile in art/scenarios/kickdrum/profile.test.ts. This file
// enforces the FROZEN module-def contract (ports incl. edge semantics, all
// 25 params, stereo outs) and the worklet-wrapper behaviors the core doesn't
// own yet: stereo L=R fan-out, the choke damp placeholder (both-edge gate),
// the accent level macro, and the dB level stage.

import { describe, it, expect, beforeAll } from 'vitest';
import { kickdrumDef } from './kickdrum';

const SR = 48000;
beforeAll(() => {
  (globalThis as unknown as { sampleRate: number }).sampleRate = SR;
});

// Capture the Processor class via the registerProcessor shim (the
// sidecar.test.ts loader pattern).
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
  await import('../../../../../dsp/src/kickdrum');
  g.registerProcessor = prev;
  if (!registered) throw new Error('kickdrum processor did not register');
  capturedProc = registered;
  return capturedProc;
}

// ───────────────────────────────────────────────────────────────────────
// Module-def shape (the frozen contract)
// ───────────────────────────────────────────────────────────────────────

describe('kickdrumDef — module def shape', () => {
  it('module id is "kickdrum" + LOWERCASE label "kick drum"', () => {
    expect(kickdrumDef.type).toBe('kickdrum');
    expect(kickdrumDef.label).toBe('kick drum');
  });

  it('declares the 4 frozen inputs with the declared edge semantics', () => {
    expect(kickdrumDef.inputs.map((i) => i.id)).toEqual([
      'trigger_in', 'accent_in', 'pitch_cv', 'choke_in',
    ]);
    const byId = Object.fromEntries(kickdrumDef.inputs.map((p) => [p.id, p] as const));
    // The STRIKE fires once per rising edge — a trigger, never level-sampled.
    expect(byId.trigger_in).toMatchObject({ type: 'gate', edge: 'trigger' });
    // CHOKE is level-sensitive (acts WHILE high, both edges) — a gate.
    expect(byId.choke_in).toMatchObject({ type: 'gate', edge: 'gate' });
    expect(byId.accent_in!.type).toBe('cv');
    expect(byId.pitch_cv!.type).toBe('cv');
  });

  it('declares separate stereo audio_l / audio_r outs + the stereo pair', () => {
    expect(kickdrumDef.outputs.map((o) => o.id)).toEqual(['audio_l', 'audio_r']);
    expect(kickdrumDef.outputs.every((o) => o.type === 'audio')).toBe(true);
    expect(kickdrumDef.stereoPairs).toEqual([['audio_l', 'audio_r']]);
  });

  it('declares all 25 params with the frozen defaults/ranges/curves', () => {
    const byId = Object.fromEntries(kickdrumDef.params.map((p) => [p.id, p] as const));
    expect(byId.tune).toMatchObject({        defaultValue: 50,   min: 20,  max: 120,  curve: 'log' });
    expect(byId.pitch_amt).toMatchObject({   defaultValue: 24,   min: 0,   max: 48,   curve: 'linear' });
    expect(byId.pitch_time).toMatchObject({  defaultValue: 30,   min: 5,   max: 120,  curve: 'log' });
    expect(byId.tension).toMatchObject({     defaultValue: 0,    min: 0,   max: 0.6,  curve: 'linear' });
    expect(byId.sub_decay).toMatchObject({   defaultValue: 450,  min: 50,  max: 800,  curve: 'log' });
    expect(byId.body_decay).toMatchObject({  defaultValue: 120,  min: 20,  max: 400,  curve: 'log' });
    expect(byId.click_len).toMatchObject({   defaultValue: 12,   min: 2,   max: 60,   curve: 'log' });
    expect(byId.sub_level).toMatchObject({   defaultValue: 0.9,  min: 0,   max: 1,    curve: 'linear' });
    expect(byId.body_level).toMatchObject({  defaultValue: 0.7,  min: 0,   max: 1,    curve: 'linear' });
    expect(byId.click_level).toMatchObject({ defaultValue: 0.4,  min: 0,   max: 1,    curve: 'linear' });
    expect(byId.body_shape).toMatchObject({  defaultValue: 0.3,  min: 0,   max: 1,    curve: 'linear' });
    expect(byId.click_tone).toMatchObject({  defaultValue: 2800, min: 500, max: 6000, curve: 'log' });
    expect(byId.drive).toMatchObject({       defaultValue: 0.4,  min: 0,   max: 1,    curve: 'linear' });
    expect(byId.hard).toMatchObject({        defaultValue: 0,    min: 0,   max: 1,    curve: 'discrete' });
    expect(byId.translate).toMatchObject({   defaultValue: 0.3,  min: 0,   max: 1,    curve: 'linear' });
    expect(byId.sub_eq).toMatchObject({      defaultValue: 0,    min: -12, max: 12,   curve: 'linear' });
    expect(byId.body_eq).toMatchObject({     defaultValue: 3,    min: -12, max: 12,   curve: 'linear' });
    expect(byId.attack_eq).toMatchObject({   defaultValue: 2,    min: -12, max: 12,   curve: 'linear' });
    expect(byId.tilt).toMatchObject({        defaultValue: 0,    min: -1,  max: 1,    curve: 'linear' });
    expect(byId.attack).toMatchObject({      defaultValue: 0.2,  min: -1,  max: 1,    curve: 'linear' });
    expect(byId.sustain).toMatchObject({     defaultValue: 0,    min: -1,  max: 1,    curve: 'linear' });
    expect(byId.glue).toMatchObject({        defaultValue: 0.3,  min: 0,   max: 1,    curve: 'linear' });
    expect(byId.ceiling).toMatchObject({     defaultValue: 0.5,  min: 0,   max: 1,    curve: 'linear' });
    expect(byId.width).toMatchObject({       defaultValue: 0.2,  min: 0,   max: 1,    curve: 'linear' });
    // The headroom fix: level spans −24..+12 dB.
    expect(byId.level).toMatchObject({       defaultValue: 0,    min: -24, max: 12,   curve: 'linear' });
    expect(Object.keys(byId)).toHaveLength(25);
  });
});

// ───────────────────────────────────────────────────────────────────────
// Worklet processor — load + behavior the wrapper owns
// ───────────────────────────────────────────────────────────────────────

const BLOCK = 128;

function makeParams(over: Record<string, number> = {}): Record<string, Float32Array> {
  const base: Record<string, number> = {};
  for (const p of kickdrumDef.params) base[p.id] = p.defaultValue;
  Object.assign(base, over);
  const out: Record<string, Float32Array> = {};
  for (const [k, v] of Object.entries(base)) out[k] = new Float32Array([v]);
  return out;
}

interface RunOpts {
  seconds: number;
  trigFn?: (n: number) => number;
  accentFn?: (n: number) => number;
  chokeFn?: (n: number) => number;
  pitchFn?: (n: number) => number;
}

/** Run the processor and capture BOTH stereo channels. */
function runProc(
  proc: { process: (i: Float32Array[][], o: Float32Array[][], p: Record<string, Float32Array>) => boolean },
  params: Record<string, Float32Array>,
  opts: RunOpts,
): { l: Float32Array; r: Float32Array } {
  const total = Math.round(SR * opts.seconds);
  const l = new Float32Array(total);
  const r = new Float32Array(total);
  let g = 0;
  while (g < total) {
    const len = Math.min(BLOCK, total - g);
    const inTrig = new Float32Array(len);
    const inAccent = new Float32Array(len);
    const inPitch = new Float32Array(len);
    const inChoke = new Float32Array(len);
    for (let i = 0; i < len; i++) {
      inTrig[i] = opts.trigFn ? opts.trigFn(g + i) : 0;
      inAccent[i] = opts.accentFn ? opts.accentFn(g + i) : 0;
      inPitch[i] = opts.pitchFn ? opts.pitchFn(g + i) : 0;
      inChoke[i] = opts.chokeFn ? opts.chokeFn(g + i) : 0;
    }
    const outL = new Float32Array(len);
    const outR = new Float32Array(len);
    proc.process([[inTrig], [inAccent], [inPitch], [inChoke]], [[outL, outR]], params);
    for (let i = 0; i < len; i++) { l[g + i] = outL[i] as number; r[g + i] = outR[i] as number; }
    g += len;
  }
  return { l, r };
}

const peakOf = (b: Float32Array, s = 0, e = b.length): number => {
  let p = 0;
  for (let i = s; i < e; i++) p = Math.max(p, Math.abs(b[i] ?? 0));
  return p;
};
const rmsOf = (b: Float32Array, s = 0, e = b.length): number => {
  let x = 0;
  for (let i = s; i < e; i++) x += (b[i] ?? 0) * (b[i] ?? 0);
  return Math.sqrt(x / Math.max(1, e - s));
};

// A 5 ms trigger pulse at sample 0 (one clean GATE_HI crossing).
const PULSE_N = Math.round(0.005 * SR);
const oneStrike = (n: number) => (n < PULSE_N ? 1 : 0);

describe('KICKDRUM worklet — load + wrapper behavior', () => {
  it('Processor class registers without throwing', async () => {
    const Proc = await loadProcessor();
    expect(Proc).toBeTruthy();
    expect(() => new Proc()).not.toThrow();
  });

  it('no trigger → silent output (no spontaneous oscillation)', async () => {
    const Proc = await loadProcessor();
    const { l } = runProc(new Proc(), makeParams(), { seconds: 0.1 });
    expect(peakOf(l)).toBeLessThan(1e-6);
  });

  it('one strike → finite, audible stereo kick; width=0 → L == R exactly, width=1 → decorrelated', async () => {
    const Proc = await loadProcessor();
    // Strike 50 ms in so the 80 Hz knob smoother has settled off the 0.2
    // width default (else the first-click samples leak a ramping side term).
    const d = Math.round(0.05 * SR);
    const strike = (n: number) => (n >= d && n < d + PULSE_N ? 1 : 0);
    // width = 0: the side term is muted → mono. The 80 Hz one-pole smoother
    // approaches 0 asymptotically, so allow sub-audible float dust (a real
    // side term at the 0.2 default measures ~5e-2 — nine orders louder).
    const mono = runProc(new Proc(), makeParams({ width: 0 }), { seconds: 0.5, trigFn: strike });
    expect(mono.l.every(Number.isFinite)).toBe(true);
    expect(peakOf(mono.l)).toBeGreaterThan(0.05);
    let maxDiff = 0;
    for (let i = 0; i < mono.l.length; i++) {
      maxDiff = Math.max(maxDiff, Math.abs((mono.l[i] ?? 0) - (mono.r[i] ?? 0)));
    }
    expect(maxDiff).toBeLessThan(1e-9);
    // width = 1: the >120 Hz decorrelated side is in — L and R must differ
    // (both audible; the mono-safe-sub law itself is pinned in the core's
    // kickdrum-dsp.test.ts).
    const wide = runProc(new Proc(), makeParams({ width: 1 }), { seconds: 0.5, trigFn: strike });
    expect(peakOf(wide.l)).toBeGreaterThan(0.05);
    expect(peakOf(wide.r)).toBeGreaterThan(0.05);
    let diff = 0;
    for (let i = 0; i < wide.l.length; i++) {
      diff = Math.max(diff, Math.abs((wide.l[i] ?? 0) - (wide.r[i] ?? 0)));
    }
    expect(diff).toBeGreaterThan(1e-4);
  });

  it('CHOKE damps WHILE high and releases on the falling edge (both-edge gate)', async () => {
    const Proc = await loadProcessor();
    // Reference: free tail.
    const free = runProc(new Proc(), makeParams(), { seconds: 0.4, trigFn: oneStrike }).l;
    // Choked: choke_in held HIGH 100..250 ms, released after.
    const c0 = Math.round(0.1 * SR);
    const c1 = Math.round(0.25 * SR);
    const choked = runProc(new Proc(), makeParams(), {
      seconds: 0.4,
      trigFn: oneStrike,
      chokeFn: (n) => (n >= c0 && n < c1 ? 1 : 0),
    }).l;
    // While high (after the ~30 ms ramp): heavily damped vs the free tail.
    const dWin0 = Math.round(0.18 * SR);
    const dWin1 = Math.round(0.24 * SR);
    const freeRms = rmsOf(free, dWin0, dWin1);
    const chokedRms = rmsOf(choked, dWin0, dWin1);
    expect(freeRms).toBeGreaterThan(1e-4); // the free tail is alive here
    expect(chokedRms).toBeLessThan(freeRms * 0.05); // ≥ 26 dB of damping
    // After the falling edge the damp RECOVERS — the (still-decaying) sub
    // becomes audible again relative to the fully-choked window.
    const rWin0 = Math.round(0.3 * SR);
    const rWin1 = Math.round(0.38 * SR);
    expect(rmsOf(choked, rWin0, rWin1)).toBeGreaterThan(chokedRms * 2);
  });

  it('ACCENT latched at the strike lands a hotter hit (per-hit drive+level macro)', async () => {
    const Proc = await loadProcessor();
    const quiet = rmsOf(runProc(new Proc(), makeParams(), { seconds: 0.3, trigFn: oneStrike }).l);
    const hot = rmsOf(runProc(new Proc(), makeParams(), {
      seconds: 0.3,
      trigFn: oneStrike,
      accentFn: () => 1,
    }).l);
    // Accent=1 raises drive ×1.3 + level +4 dB pre-ceiling — the ceiling
    // tanh compresses the peak, but the hit's energy is clearly hotter.
    expect(hot).toBeGreaterThan(quiet * 1.15);
  });

  it('LEVEL (pre-ceiling dB stage) scales the output monotonically', async () => {
    const Proc = await loadProcessor();
    // Strike 50 ms in: the 80 Hz one-pole knob smoother primes to the
    // DEFAULT (0 dB) and needs a few ms to settle on a non-default level —
    // striking at t=0 would let the attack through at partial gain.
    const d = Math.round(0.05 * SR);
    const lateStrike = (n: number) => (n >= d && n < d + PULSE_N ? 1 : 0);
    const unity = rmsOf(runProc(new Proc(), makeParams({ level: 0 }),   { seconds: 0.35, trigFn: lateStrike }).l);
    const hot   = rmsOf(runProc(new Proc(), makeParams({ level: 12 }),  { seconds: 0.35, trigFn: lateStrike }).l);
    const cold  = rmsOf(runProc(new Proc(), makeParams({ level: -24 }), { seconds: 0.35, trigFn: lateStrike }).l);
    // Level is applied BEFORE the true-peak ceiling (hot settings lean into
    // the tanh), so +12 dB is louder-but-compressed while −24 dB sits in the
    // linear region (≈ a clean 1/16 of the pre-ceiling signal). The exact
    // law is pinned in the core's own unit suite (kickdrum-dsp.test.ts).
    expect(hot).toBeGreaterThan(unity * 1.2);
    expect(cold).toBeLessThan(unity * 0.15);
    expect(cold).toBeGreaterThan(0);
  });

  it('pitch_cv transposes the voice 1V/oct (period halves at +1)', async () => {
    const Proc = await loadProcessor();
    // Long, sub-dominant render (body off) for a clean period measurement.
    const p = makeParams({ body_level: 0, pitch_amt: 0 });
    const base = runProc(new Proc(), p, { seconds: 0.4, trigFn: oneStrike }).l;
    const up = runProc(new Proc(), p, { seconds: 0.4, trigFn: oneStrike, pitchFn: () => 1 }).l;
    // Count zero-crossings over the settled tail 100..400 ms.
    const zc = (b: Float32Array): number => {
      const s0 = Math.round(0.1 * SR);
      let c = 0;
      for (let i = s0 + 1; i < b.length; i++) {
        if (((b[i - 1] ?? 0) >= 0) !== ((b[i] ?? 0) >= 0)) c++;
      }
      return c;
    };
    const ratio = zc(up) / Math.max(1, zc(base));
    expect(ratio).toBeGreaterThan(1.7);
    expect(ratio).toBeLessThan(2.3);
  });
});
