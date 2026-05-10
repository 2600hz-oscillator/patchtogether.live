// packages/web/src/lib/audio/modules/buggles.ts
//
// BUGGLES — chaotic random voltage source. Functional clean-room
// implementation of the Buchla / Make Noise wogglebug archetype:
// an internal "woggle clock" emits triggers at a knob-set rate (with
// optional jitter), and the resulting random voltages spray out across
// five correlated outputs:
//
//   smooth — slowly-shifting random voltage (slewed stepped). Like a
//            slow random LFO; good for warbling pitch / filter modulation.
//   stepped — sample-and-held random voltage that updates on each woggle
//            clock pulse. Brittle, jumpy modulation.
//   clock  — gate output, 5ms pulses on each woggle event. Use as a
//            chaotic clock for sequencers / drum triggers.
//   burst  — clusters of 3-7 closely-spaced triggers fired at probability
//            burst_probability per woggle event.
//   ring   — audio-rate output that mixes the smooth voltage with a
//            sub-harmonic sine via ring modulation. Buchla's signature
//            "complex random" texture.
//
// Inputs:
//   clock_cv      — CV → woggle rate. Sums onto the rate knob value.
//   chaos_cv      — CV → chaos amount. Sums onto the chaos knob value.
//   external_clock — gate input. When patched, replaces the internal
//                   woggle clock (rising edges advance state instead).
//
// CV inputs aren't routed to AudioParams (the rate/chaos values aren't
// AudioParams — they're plain JS shadows read by the setTimeout-driven
// woggle scheduler). Instead, each CV input lands on an AnalyserNode
// tap; on every woggle event we read the latest sample and add it to
// the shadowed knob value.
//
// Knobs:
//   rate              — log-mapped 0.1..50 Hz internal clock rate.
//   chaos             — 0..1 chaos depth. At 0 the stepped output is a
//                       clean S&H of a stable random walk; at 1, each
//                       step is a fresh independent uniform value.
//   smoothness        — 0..1 slew rate on smooth output (higher = slower).
//   burst_probability — 0..1 chance of a burst on each woggle event.
//   level             — 0..1 output scaling for ALL five outputs.
//
// Implementation: pure-JS ScriptProcessorNode-style via AudioWorklet
// would be the "right" thing to do for sample-accurate behavior, but
// the spec asks for "rich" wogglebug behavior, not sample-accurate
// timing. We implement the woggle clock as a setInterval-driven
// orchestrator that schedules ConstantSource ramps + gate pulses on the
// audio thread. This keeps the DSP simple, sounds correct, and avoids
// shipping a new worklet for what is fundamentally a low-frequency
// random-event generator.
//
// All five outputs are driven from a small set of internal state:
//   * `currentStepped`   — the current S&H value (-1..+1)
//   * `targetStepped`    — the next S&H value (used so we can ramp the
//                          smooth output toward it)
//   * `wogglePeriodS`    — current period in seconds (rate + chaos jitter)
//
// On each woggle event:
//   1. Pick a new `targetStepped` (random in [-1..+1], or correlated
//      walk when chaos is low).
//   2. Step the stepped ConstantSource to targetStepped (no ramp).
//   3. Schedule a linearRampToValueAtTime on the smooth ConstantSource
//      from its current value to targetStepped, over a duration that
//      depends on `smoothness`.
//   4. Pulse the clock gate (fire setValueAtTime(1) → setValueAtTime(0)
//      after 5ms).
//   5. Roll burst_probability; on hit, schedule 3-7 closely-spaced
//      gate pulses on the burst output.
//   6. Pick the next woggle period: base 1/rate + jitter scaled by
//      chaos. Schedule the next woggle via setTimeout.
//
// External clock: when `external_clock` is patched and a rising edge
// arrives (above 0.5), we fire the same woggle-event handler. The
// internal setTimeout is suppressed while external clock is active.

import type { AudioDomainNodeHandle } from '$lib/audio/engine';
import type { AudioModuleDef } from '$lib/audio/module-registry';

/** Pure helpers exposed for unit tests. The actual woggle event
 *  generation runs in the factory (where we have an AudioContext). */
export const bugglesMath = {
  /** Map a 0..1 knob value to 0.1..50 Hz log scale.
   *  rate=0   → 0.1 Hz
   *  rate=0.5 → ~2.24 Hz (log midpoint)
   *  rate=1   → 50 Hz */
  rateKnobToHz(knob: number): number {
    const minHz = 0.1;
    const maxHz = 50;
    const k = Math.max(0, Math.min(1, knob));
    return minHz * Math.pow(maxHz / minHz, k);
  },

  /** Compute the next stepped value, given the previous stepped and a
   *  chaos amount in [0, 1]. At chaos=0 the next value is a small
   *  perturbation of the previous (correlated walk); at chaos=1 it's
   *  a fresh uniform pull. */
  nextStepped(previous: number, chaos: number, rand: () => number): number {
    const fresh = rand() * 2 - 1; // uniform in [-1, +1]
    const c = Math.max(0, Math.min(1, chaos));
    // Linear interpolation between a small perturbation and a fresh value.
    // walk = previous + 0.2 * fresh, clamped — keeps the trajectory bounded.
    const walk = clamp(previous + 0.2 * fresh, -1, 1);
    return walk * (1 - c) + fresh * c;
  },

  /** Compute the next woggle period in seconds. Base = 1/rate; jitter
   *  ranges from 0% (chaos=0) up to ±50% of the base period (chaos=1). */
  nextPeriodS(rateHz: number, chaos: number, rand: () => number): number {
    const base = 1 / Math.max(rateHz, 1e-6);
    const c = Math.max(0, Math.min(1, chaos));
    const jitter = (rand() * 2 - 1) * 0.5 * c; // ±50% × chaos
    return base * (1 + jitter);
  },

  /** Roll burst probability. Returns the burst length (3..7) on hit, 0 otherwise. */
  rollBurst(probability: number, rand: () => number): number {
    const p = Math.max(0, Math.min(1, probability));
    if (rand() >= p) return 0;
    return 3 + Math.floor(rand() * 5); // 3..7 inclusive
  },
};

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

/** Tiny seeded PRNG so tests can control randomness without monkey-
 *  patching Math.random. Same algorithm as noise.ts for consistency. */
export function bugglesPrng(seed: number): () => number {
  let s = seed >>> 0;
  return function () {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const CLOCK_PULSE_MS = 5;
const BURST_GAP_MS = 18;     // spacing between burst pulses
const BURST_PULSE_MS = 4;    // each burst pulse width

export const bugglesDef: AudioModuleDef = {
  type: 'buggles',
  domain: 'audio',
  label: 'BUGGLES',
  category: 'modulation',
  schemaVersion: 1,

  inputs: [
    // No paramTarget — these are sampled into the JS shadow each woggle
    // event rather than routed onto an AudioParam. Engine still treats
    // them as cv inputs (cable colour, type-check), just connects them
    // node→node into the analyser tap.
    { id: 'clock_cv',       type: 'cv' },
    { id: 'chaos_cv',       type: 'cv' },
    { id: 'external_clock', type: 'gate' },
  ],
  outputs: [
    { id: 'smooth', type: 'cv' },
    { id: 'stepped', type: 'cv' },
    { id: 'clock',  type: 'gate' },
    { id: 'burst',  type: 'gate' },
    { id: 'ring',   type: 'audio' },
  ],
  params: [
    // rate is exposed in normalised 0..1 knob units; the factory log-maps
    // it to Hz internally. This keeps the AudioParam sum (knob + CV)
    // mathematically meaningful (CV in cv range adds to knob range).
    { id: 'rate',              label: 'Rate',   defaultValue: 0.4, min: 0, max: 1, curve: 'linear' },
    { id: 'chaos',             label: 'Chaos',  defaultValue: 0.3, min: 0, max: 1, curve: 'linear' },
    { id: 'smoothness',        label: 'Smooth', defaultValue: 0.5, min: 0, max: 1, curve: 'linear' },
    { id: 'burst_probability', label: 'Burst',  defaultValue: 0.2, min: 0, max: 1, curve: 'linear' },
    { id: 'level',             label: 'Level',  defaultValue: 0.7, min: 0, max: 1, curve: 'linear' },
  ],

  async factory(ctx, node): Promise<AudioDomainNodeHandle> {
    // Per-instance PRNG seeded from the node id so two BUGGLES on the
    // same canvas produce different sequences (and a single BUGGLES is
    // reproducible across reloads when the patch is saved/loaded with
    // the same id).
    let seed = 0;
    for (let i = 0; i < node.id.length; i++) {
      seed = ((seed << 5) - seed + node.id.charCodeAt(i)) | 0;
    }
    if (seed === 0) seed = 1;
    const rand = bugglesPrng(seed);

    // ---------------- Internal state (param shadows) ----------------
    //
    // We shadow the knob values in plain JS so the woggle scheduler
    // (which runs off setTimeout, NOT on the audio thread) can read them
    // without going through the AudioParam. The setParam handler keeps
    // both the AudioParam and the shadow in sync.
    let rateKnob = (node.params ?? {}).rate ?? 0.4;
    let chaos = (node.params ?? {}).chaos ?? 0.3;
    let smoothness = (node.params ?? {}).smoothness ?? 0.5;
    let burstProb = (node.params ?? {}).burst_probability ?? 0.2;
    let level = (node.params ?? {}).level ?? 0.7;

    // ---------------- ConstantSource outputs ----------------
    //
    // smooth + stepped are CV outputs driven by ConstantSourceNodes.
    // We mutate their .offset.value (or schedule ramps) on each woggle
    // event. clock + burst are gate outputs driven the same way (just
    // with very short pulse widths).
    const steppedSrc = ctx.createConstantSource();
    steppedSrc.offset.value = 0;
    steppedSrc.start();

    const smoothSrc = ctx.createConstantSource();
    smoothSrc.offset.value = 0;
    smoothSrc.start();

    const clockSrc = ctx.createConstantSource();
    clockSrc.offset.value = 0;
    clockSrc.start();

    const burstSrc = ctx.createConstantSource();
    burstSrc.offset.value = 0;
    burstSrc.start();

    // Per-output gain stages so LEVEL scales every output uniformly.
    // Gates (clock, burst) bypass LEVEL — gate consumers expect a
    // clean 0/1 swing regardless of the level knob.
    const steppedGain = ctx.createGain();
    steppedGain.gain.value = level;
    const smoothGain = ctx.createGain();
    smoothGain.gain.value = level;
    steppedSrc.connect(steppedGain);
    smoothSrc.connect(smoothGain);

    // ---------------- Ring output ----------------
    //
    // ring = smooth × suboscillator. The suboscillator is a slow sine
    // running at rate/4 — slow enough that the smooth voltage shapes
    // it visibly, but fast enough to be audible-rate. Implemented via
    // an OscillatorNode + GainNode multiplier (the audio×param trick:
    // gain.value = 0; smooth → gain.gain; oscillator → gain input).
    const subOsc = ctx.createOscillator();
    subOsc.type = 'sine';
    // Initial frequency from the rate knob; updated as rate changes.
    subOsc.frequency.value = bugglesMath.rateKnobToHz(rateKnob) / 4;
    subOsc.start();

    const ringMul = ctx.createGain();
    ringMul.gain.value = 0; // pure multiplier (zero intrinsic gain)
    subOsc.connect(ringMul);          // audio path
    smoothSrc.connect(ringMul.gain);  // modulator path

    // Output stage for ring — apply LEVEL.
    const ringGain = ctx.createGain();
    ringGain.gain.value = level;
    ringMul.connect(ringGain);

    // ---------------- CV input taps ----------------
    //
    // clock_cv and chaos_cv each route into an AnalyserNode (shared
    // pattern with the engine's per-param tap). The woggle scheduler
    // samples the latest value on each event and adds it to the
    // shadowed knob to produce the effective rate / chaos.
    const clockCvAnalyser = ctx.createAnalyser();
    clockCvAnalyser.fftSize = 32;
    clockCvAnalyser.smoothingTimeConstant = 0;
    const clockCvBuf = new Float32Array(32);
    function readClockCv(): number {
      clockCvAnalyser.getFloatTimeDomainData(clockCvBuf);
      return clockCvBuf[clockCvBuf.length - 1] ?? 0;
    }

    const chaosCvAnalyser = ctx.createAnalyser();
    chaosCvAnalyser.fftSize = 32;
    chaosCvAnalyser.smoothingTimeConstant = 0;
    const chaosCvBuf = new Float32Array(32);
    function readChaosCv(): number {
      chaosCvAnalyser.getFloatTimeDomainData(chaosCvBuf);
      return chaosCvBuf[chaosCvBuf.length - 1] ?? 0;
    }

    function effectiveRateKnob(): number {
      return clamp(rateKnob + readClockCv(), 0, 1);
    }
    function effectiveChaos(): number {
      return clamp(chaos + readChaosCv(), 0, 1);
    }

    // ---------------- External-clock detection ----------------
    //
    // When external_clock is patched, an AnalyserNode samples the
    // incoming gate signal each setInterval tick. A rising-edge
    // detection (last < 0.5 && current >= 0.5) fires a woggle event
    // and disables the internal scheduler until the gate input falls
    // back to silence (no edges for 1 second).
    const extClockAnalyser = ctx.createAnalyser();
    extClockAnalyser.fftSize = 32;
    extClockAnalyser.smoothingTimeConstant = 0;
    const extClockBuf = new Float32Array(32);
    let lastExtSample = 0;
    // -Infinity so externalClockActive() returns false until a real edge
    // arrives. (Initial 0 made the helper return true for the first
    // second, which suppressed the internal scheduler reschedule and
    // froze every output at its first-event value.)
    let lastExtEdgeT = -Infinity;
    function checkExternalClock(): boolean {
      // Reads the most recent 32 samples; returns true if a rising edge
      // is detected since the last check, false otherwise. Side effect:
      // updates lastExtSample.
      extClockAnalyser.getFloatTimeDomainData(extClockBuf);
      let edge = false;
      for (let i = 0; i < extClockBuf.length; i++) {
        const s = extClockBuf[i]!;
        if (lastExtSample < 0.5 && s >= 0.5) {
          edge = true;
          lastExtEdgeT = ctx.currentTime;
        }
        lastExtSample = s;
      }
      return edge;
    }
    function externalClockActive(): boolean {
      // Consider external clock "active" if we've seen any edge in the
      // last 1 second. Drops back to internal after a 1s gap.
      return ctx.currentTime - lastExtEdgeT < 1;
    }

    // ---------------- Woggle event handler ----------------
    //
    // Runs on every internal-clock tick (or external rising edge).
    // Updates internal state, schedules ramps + gate pulses, picks
    // the next internal period.
    let timer: ReturnType<typeof setTimeout> | null = null;
    let extClockPoller: ReturnType<typeof setInterval> | null = null;

    function fireWoggleEvent(): void {
      const now = ctx.currentTime;
      const effRate = effectiveRateKnob();
      const effChaos = effectiveChaos();
      const rateHz = bugglesMath.rateKnobToHz(effRate);

      // 1. Pick next stepped value.
      const previous = steppedSrc.offset.value;
      const next = bugglesMath.nextStepped(previous, effChaos, rand);

      // 2. Hard step on stepped output.
      steppedSrc.offset.cancelScheduledValues(now);
      steppedSrc.offset.setValueAtTime(next, now);

      // 3. Smooth ramp toward `next`. Smoothness 0 = ~10ms ramp (almost
      //    a step); smoothness 1 = ~2× the woggle period (very lazy).
      const periodS = 1 / Math.max(rateHz, 1e-6);
      const slewS = 0.01 + smoothness * 2 * periodS;
      smoothSrc.offset.cancelScheduledValues(now);
      smoothSrc.offset.setValueAtTime(smoothSrc.offset.value, now);
      smoothSrc.offset.linearRampToValueAtTime(next, now + slewS);

      // 4. Clock gate: 1 for CLOCK_PULSE_MS, then back to 0.
      clockSrc.offset.cancelScheduledValues(now);
      clockSrc.offset.setValueAtTime(1, now);
      clockSrc.offset.setValueAtTime(0, now + CLOCK_PULSE_MS / 1000);

      // 5. Burst roll. On hit, schedule 3..7 closely-spaced 4ms pulses
      //    on the burst output, separated by BURST_GAP_MS.
      const burstLen = bugglesMath.rollBurst(burstProb, rand);
      burstSrc.offset.cancelScheduledValues(now);
      burstSrc.offset.setValueAtTime(0, now);
      for (let i = 0; i < burstLen; i++) {
        const t0 = now + (i * BURST_GAP_MS) / 1000;
        const t1 = t0 + BURST_PULSE_MS / 1000;
        burstSrc.offset.setValueAtTime(1, t0);
        burstSrc.offset.setValueAtTime(0, t1);
      }

      // 6. Update sub-osc frequency to track the new rate (smoothly).
      subOsc.frequency.cancelScheduledValues(now);
      subOsc.frequency.linearRampToValueAtTime(rateHz / 4, now + 0.05);

      // 7. Schedule next internal woggle (if external clock isn't active).
      if (!externalClockActive()) {
        const nextPeriodS = bugglesMath.nextPeriodS(rateHz, effChaos, rand);
        timer = setTimeout(fireWoggleEvent, nextPeriodS * 1000);
      }
    }

    // Kick off the internal scheduler. First woggle fires immediately so
    // the user sees movement on the smooth/stepped outputs without
    // waiting up to 10 seconds at the lowest rate.
    timer = setTimeout(fireWoggleEvent, 50);

    // External-clock polling: 30Hz check rate. If a rising edge arrives,
    // fire a woggle event AND clear the internal timer so we don't get
    // double-triggers.
    extClockPoller = setInterval(() => {
      if (checkExternalClock()) {
        if (timer !== null) {
          clearTimeout(timer);
          timer = null;
        }
        fireWoggleEvent();
      } else if (!externalClockActive() && timer === null) {
        // External clock dropped out — restart internal scheduler.
        const nextPeriodS = bugglesMath.nextPeriodS(
          bugglesMath.rateKnobToHz(effectiveRateKnob()),
          effectiveChaos(),
          rand,
        );
        timer = setTimeout(fireWoggleEvent, nextPeriodS * 1000);
      }
    }, 33);

    return {
      domain: 'audio',
      inputs: new Map([
        // CV inputs feed into AnalyserNodes that the woggle scheduler
        // samples per event (NOT routed to AudioParams — see top-of-file
        // comment). external_clock feeds its own analyser for rising-
        // edge detection on each scheduler tick.
        ['clock_cv',       { node: clockCvAnalyser, input: 0 }],
        ['chaos_cv',       { node: chaosCvAnalyser, input: 0 }],
        ['external_clock', { node: extClockAnalyser, input: 0 }],
      ]),
      outputs: new Map([
        ['smooth',  { node: smoothGain,  output: 0 }],
        ['stepped', { node: steppedGain, output: 0 }],
        ['clock',   { node: clockSrc,    output: 0 }],
        ['burst',   { node: burstSrc,    output: 0 }],
        ['ring',    { node: ringGain,    output: 0 }],
      ]),
      setParam(paramId, value) {
        switch (paramId) {
          case 'rate':              rateKnob = value; return;
          case 'chaos':             chaos = value; return;
          case 'smoothness':        smoothness = value; return;
          case 'burst_probability': burstProb = value; return;
          case 'level':
            level = value;
            steppedGain.gain.setValueAtTime(value, ctx.currentTime);
            smoothGain.gain.setValueAtTime(value, ctx.currentTime);
            ringGain.gain.setValueAtTime(value, ctx.currentTime);
            return;
        }
      },
      readParam(paramId) {
        switch (paramId) {
          case 'rate':              return rateKnob;
          case 'chaos':             return chaos;
          case 'smoothness':        return smoothness;
          case 'burst_probability': return burstProb;
          case 'level':             return level;
        }
        return undefined;
      },
      dispose() {
        if (timer !== null) {
          clearTimeout(timer);
          timer = null;
        }
        if (extClockPoller !== null) {
          clearInterval(extClockPoller);
          extClockPoller = null;
        }
        try { steppedSrc.stop(); } catch { /* */ }
        try { smoothSrc.stop();  } catch { /* */ }
        try { clockSrc.stop();   } catch { /* */ }
        try { burstSrc.stop();   } catch { /* */ }
        try { subOsc.stop();     } catch { /* */ }
        steppedSrc.disconnect();
        smoothSrc.disconnect();
        clockSrc.disconnect();
        burstSrc.disconnect();
        subOsc.disconnect();
        ringMul.disconnect();
        ringGain.disconnect();
        steppedGain.disconnect();
        smoothGain.disconnect();
        extClockAnalyser.disconnect();
        clockCvAnalyser.disconnect();
        chaosCvAnalyser.disconnect();
      },
    };
  },
};
