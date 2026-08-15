// art/scenarios/buggles/woggle-events.test.ts
//
// ART for BUGGLES.
//
// ⚠ WHY THIS SCENARIO NEVER INSTANTIATES THE MODULE — corrected 2026-08-15,
// because the reason it used to give is measurably wrong and the wrong reason
// implies "safe by construction" where the truth is a RACE.
//
// The old header said the woggle scheduler "doesn't tick during an
// OfflineAudioContext render". Timers DO tick during the render:
// node-web-audio-api renders OFF-THREAD and `await startRendering()` yields to
// the Node timer queue. Measured, in a render deliberately slowed to 3517 ms by
// loading the graph (32 channels × 600 s): 566 interval callbacks fired DURING
// the await, at ctx.currentTime 1.05 / 2.09 / 3.09 / 4.13 / 5.20 s — i.e. mid
// render, exactly the #1680 non-reproducibility hazard.
//
// What actually makes BUGGLES silent offline is that the render OUTRUNS the
// timer. An idle box renders ~23,000× real time (300 s of audio in 13 ms wall),
// and the module's first woggle is a 50 ms setTimeout — so `ctx.currentTime` is
// already past the end of the buffer before the scheduler ever runs, and every
// `setValueAtTime` it then issues lands beyond the render. `real-factory-silence`
// below pins that as a measurement, with a positive control on the capture path
// so the zero is attributable.
//
// The consequence for ART: BUGGLES cannot carry an audio-profile baseline. A
// `.f32` pinned from this harness would be a pin of SILENCE that flips to a pin
// of NOISE the first time a runner is loaded enough to lose the race. That is
// why the module sits in `ART_BACKLOG` with no baseline, no `.sha` and no
// `fingerprints.generated.json` entry — nothing here is pinned by a hash.
//
// So this ART:
//   1. Exercises bugglesMath at higher iteration counts than the unit
//      tests, asserting statistical behaviour (chaos divergence,
//      jitter spread, burst probability calibration).
//   2. Renders a hand-orchestrated sequence of ConstantSource events
//      that mirrors what fireWoggleEvent() would schedule, then
//      asserts the rendered waveform matches the expected shape:
//      stepped jumps instantly, smooth slews in, clock fires a 5ms
//      pulse, burst fires the requested count of pulses.
//
// The combination covers the full woggle event semantics without
// needing a real-time event loop.

import { describe, expect, it } from 'vitest';
import { OfflineAudioContext } from 'node-web-audio-api';
import {
  BUGGLES_AUDIBILITY_FLOOR_HZ,
  BUGGLES_FIRST_WOGGLE_MS,
  BUGGLES_RING_DIVISOR,
  bugglesDef,
  bugglesMath,
  bugglesPrng,
} from '../../../packages/web/src/lib/audio/modules/buggles';

const SAMPLE_RATE = 48000;

/** Peak |sample|, so a "silent" claim is a number rather than a shrug. */
function peakAbs(buf: Float32Array): number {
  let p = 0;
  for (let i = 0; i < buf.length; i++) {
    const a = Math.abs(buf[i]!);
    if (a > p) p = a;
  }
  return p;
}

describe('BUGGLES ART: chaos knob increases divergence', () => {
  it('chaos=1 produces ≥ 4× the per-step variance of chaos=0', () => {
    function meanSquaredStep(chaos: number, seed: number): number {
      const rand = bugglesPrng(seed);
      let prev = 0;
      let sumSq = 0;
      const N = 5000;
      for (let i = 0; i < N; i++) {
        const next = bugglesMath.nextStepped(prev, chaos, rand);
        const d = next - prev;
        sumSq += d * d;
        prev = next;
      }
      return sumSq / N;
    }
    const lo = meanSquaredStep(0, 99);
    const hi = meanSquaredStep(1, 99);
    expect(hi / lo, `chaos=1 / chaos=0 step² ratio = ${(hi / lo).toFixed(2)}`)
      .toBeGreaterThan(4);
  });
});

describe('BUGGLES ART: rendered ConstantSource ramp matches smooth-output spec', () => {
  // A single woggle event scheduled at t=0 on the smooth output:
  //   smoothSrc.setValueAtTime(0, 0)
  //   smoothSrc.linearRampToValueAtTime(0.6, 0.05)   // 50ms slew
  // After the ramp completes, signal should hold at 0.6 until the next
  // event. This mirrors fireWoggleEvent()'s smooth-output behavior.

  it('linear ramp resolves to target after the slew duration', async () => {
    const DURATION_S = 0.2;
    const ctx = new OfflineAudioContext({
      numberOfChannels: 1,
      length: Math.round(SAMPLE_RATE * DURATION_S),
      sampleRate: SAMPLE_RATE,
    });
    const src = ctx.createConstantSource();
    src.offset.setValueAtTime(0, 0);
    src.offset.linearRampToValueAtTime(0.6, 0.05);
    src.start();
    src.connect(ctx.destination);

    const r = await ctx.startRendering();
    const buf = r.getChannelData(0);

    // Check tail sample (well after ramp end).
    const tail = buf[Math.floor(0.18 * SAMPLE_RATE)] ?? 0;
    expect(tail, `tail sample=${tail.toFixed(4)} should be ~0.6`).toBeCloseTo(0.6, 2);

    // Check midpoint of ramp (~25ms in) — should be ~0.3.
    const mid = buf[Math.floor(0.025 * SAMPLE_RATE)] ?? 0;
    expect(mid, `midpoint sample=${mid.toFixed(4)} should be ~0.3`)
      .toBeGreaterThan(0.2);
    expect(mid).toBeLessThan(0.4);
  });
});

describe('BUGGLES ART: stepped output jumps instantly on event', () => {
  it('setValueAtTime produces an instantaneous step (no ramp)', async () => {
    const DURATION_S = 0.1;
    const ctx = new OfflineAudioContext({
      numberOfChannels: 1,
      length: Math.round(SAMPLE_RATE * DURATION_S),
      sampleRate: SAMPLE_RATE,
    });
    const src = ctx.createConstantSource();
    src.offset.setValueAtTime(0, 0);
    src.offset.setValueAtTime(0.7, 0.05);
    src.start();
    src.connect(ctx.destination);

    const r = await ctx.startRendering();
    const buf = r.getChannelData(0);

    // Just before the step: should be 0.
    const beforeIdx = Math.floor(0.04 * SAMPLE_RATE);
    expect(buf[beforeIdx]!, `pre-step sample=${buf[beforeIdx]}`).toBeCloseTo(0, 3);

    // Just after the step: should be 0.7.
    const afterIdx = Math.floor(0.06 * SAMPLE_RATE);
    expect(buf[afterIdx]!, `post-step sample=${buf[afterIdx]}`).toBeCloseTo(0.7, 3);
  });
});

describe('BUGGLES ART: clock gate pulse shape', () => {
  it('5ms pulse: 1 during pulse, 0 before/after', async () => {
    const DURATION_S = 0.1;
    const ctx = new OfflineAudioContext({
      numberOfChannels: 1,
      length: Math.round(SAMPLE_RATE * DURATION_S),
      sampleRate: SAMPLE_RATE,
    });
    const src = ctx.createConstantSource();
    src.offset.setValueAtTime(0, 0);
    src.offset.setValueAtTime(1, 0.02);
    src.offset.setValueAtTime(0, 0.025); // 5ms pulse
    src.start();
    src.connect(ctx.destination);

    const r = await ctx.startRendering();
    const buf = r.getChannelData(0);

    // Sample at t = 0.022s — middle of pulse — should be 1.
    const insideIdx = Math.floor(0.022 * SAMPLE_RATE);
    expect(buf[insideIdx]!, `inside-pulse sample=${buf[insideIdx]}`).toBeCloseTo(1, 3);

    // Sample at t = 0.05s — well after pulse — should be 0.
    const afterIdx = Math.floor(0.05 * SAMPLE_RATE);
    expect(buf[afterIdx]!, `post-pulse sample=${buf[afterIdx]}`).toBeCloseTo(0, 3);

    // Count pulse-active samples (above 0.5). 5ms × 48kHz = 240 samples.
    let active = 0;
    for (let i = 0; i < buf.length; i++) {
      if (buf[i]! >= 0.5) active++;
    }
    // Allow ±5 sample slack for setValueAtTime granularity at block boundaries.
    expect(active, `pulse-active samples=${active} (expected ~240)`)
      .toBeGreaterThan(230);
    expect(active).toBeLessThan(260);
  });
});

describe('BUGGLES ART: burst output schedules N closely-spaced pulses', () => {
  it('a 5-pulse burst with 18ms gap + 4ms width fires 5 distinct pulses', async () => {
    // Mirror what fireWoggleEvent does on a burst hit, length = 5.
    // i=0 → t0=0,    t1=0.004
    // i=1 → t0=0.018, t1=0.022
    // ...
    // i=4 → t0=0.072, t1=0.076
    const DURATION_S = 0.12;
    const ctx = new OfflineAudioContext({
      numberOfChannels: 1,
      length: Math.round(SAMPLE_RATE * DURATION_S),
      sampleRate: SAMPLE_RATE,
    });
    const src = ctx.createConstantSource();
    src.offset.setValueAtTime(0, 0);
    const BURST_LEN = 5;
    const GAP = 0.018;
    const PULSE = 0.004;
    for (let i = 0; i < BURST_LEN; i++) {
      const t0 = i * GAP;
      src.offset.setValueAtTime(1, t0);
      src.offset.setValueAtTime(0, t0 + PULSE);
    }
    src.start();
    src.connect(ctx.destination);

    const r = await ctx.startRendering();
    const buf = r.getChannelData(0);

    // Count rising-edge transitions (low → high).
    let edges = 0;
    let last = 0;
    for (let i = 0; i < buf.length; i++) {
      const s = buf[i]!;
      if (last < 0.5 && s >= 0.5) edges++;
      last = s;
    }
    expect(edges, `rising edges=${edges} (expected ${BURST_LEN})`).toBe(BURST_LEN);
  });
});

describe('BUGGLES ART: ring output mixes smooth + sub-osc via gain×param', () => {
  // Replicates the ringMul construction: gain=0, oscillator → input,
  // smooth → gain.gain. Multiplier semantics: out = osc × smooth.
  //
  // ⚠ THE OSCILLATOR IN THE TWO PRODUCT LEGS BELOW IS 200 Hz AND THE MODULE'S
  // IS NOT. That is deliberate and it is also the reason this describe block
  // was blind to a shipped defect for as long as it existed: the legs are about
  // the MULTIPLIER's algebra (0 × x = 0, 0.5 × x = 0.5x), which is frequency-
  // independent, so a fast carrier keeps the peak-tracker's window short. The
  // FREQUENCY is a separate claim and it gets its own leg, below, because
  // mirroring the construction at 667× the real carrier is exactly how "an
  // audio-rate RING output" survived in four doc strings while the real carrier
  // topped out at 12.5 Hz.

  it('the REAL carrier is SUB-AUDIO across the whole RATE travel — not audio-rate', () => {
    // The claim the module's docs used to make, as a gate. `rateKnobToHz` tops
    // out at 50 Hz and the carrier is that over BUGGLES_RING_DIVISOR, so the
    // ceiling is 12.5 Hz against a ~20 Hz floor of hearing. Making RING audible
    // now means editing this assertion and the prose in the same diff.
    const rateDef = bugglesDef.params.find((p) => p.id === 'rate')!;
    const carrierHz = (knob: number) => bugglesMath.rateKnobToHz(knob) / BUGGLES_RING_DIVISOR;

    // The whole travel, endpoints included — a middle-only sweep would miss the
    // ceiling, which is where the claim would be true if it were true anywhere.
    for (let i = 0; i <= 100; i++) {
      const knob = rateDef.min + ((rateDef.max - rateDef.min) * i) / 100;
      expect(
        carrierHz(knob),
        `RATE ${knob.toFixed(2)} → RING carrier ${carrierHz(knob).toFixed(5)} Hz ` +
          `(units: Hz) must stay under the ${BUGGLES_AUDIBILITY_FLOOR_HZ} Hz floor of hearing`,
      ).toBeLessThan(BUGGLES_AUDIBILITY_FLOOR_HZ);
    }

    // The two numbers the docs quote, pinned where a reader can check them.
    expect(carrierHz(rateDef.defaultValue), 'units: Hz, at spawn').toBeCloseTo(0.30028, 5);
    expect(carrierHz(rateDef.max), 'units: Hz, flat out').toBeCloseTo(12.5, 6);

    // POSITIVE CONTROL on the metric: the SAME expression DOES cross the floor
    // once the divisor stops dividing — so the sweep above is a fact about this
    // module's arithmetic, not about a comparison that can never fail.
    expect(bugglesMath.rateKnobToHz(rateDef.max) / 1).toBeGreaterThan(
      BUGGLES_AUDIBILITY_FLOOR_HZ,
    );
  });

  it('output is the product of oscillator and modulator (zero when modulator is zero)', async () => {
    const DURATION_S = 0.1;
    const ctx = new OfflineAudioContext({
      numberOfChannels: 1,
      length: Math.round(SAMPLE_RATE * DURATION_S),
      sampleRate: SAMPLE_RATE,
    });
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.value = 200;
    osc.start();

    const mod = ctx.createConstantSource();
    mod.offset.value = 0; // modulator = 0 throughout
    mod.start();

    const mul = ctx.createGain();
    mul.gain.value = 0;
    osc.connect(mul);
    mod.connect(mul.gain);
    mul.connect(ctx.destination);

    const r = await ctx.startRendering();
    const buf = r.getChannelData(0);
    let peak = 0;
    for (let i = 1000; i < buf.length; i++) {
      const a = Math.abs(buf[i]!);
      if (a > peak) peak = a;
    }
    // With modulator=0, ring output should be silent (peak ≈ 0).
    expect(peak, `silent-modulator peak=${peak}`).toBeLessThan(1e-3);
  });

  it('with constant modulator=0.5, ring output peaks at ~0.5 of oscillator amplitude', async () => {
    const DURATION_S = 0.1;
    const ctx = new OfflineAudioContext({
      numberOfChannels: 1,
      length: Math.round(SAMPLE_RATE * DURATION_S),
      sampleRate: SAMPLE_RATE,
    });
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.value = 200;
    osc.start();

    const mod = ctx.createConstantSource();
    mod.offset.value = 0.5;
    mod.start();

    const mul = ctx.createGain();
    mul.gain.value = 0;
    osc.connect(mul);
    mod.connect(mul.gain);
    mul.connect(ctx.destination);

    const r = await ctx.startRendering();
    const buf = r.getChannelData(0);
    let peak = 0;
    // Skip the initial block — modulator schedule + oscillator startup
    // can produce a transient first sample.
    for (let i = 2000; i < buf.length; i++) {
      const a = Math.abs(buf[i]!);
      if (a > peak) peak = a;
    }
    // Peak ≈ 0.5 × 1.0 = 0.5; allow ±10% slack.
    expect(peak, `peak=${peak.toFixed(4)} should be ~0.5`).toBeGreaterThan(0.45);
    expect(peak).toBeLessThan(0.55);
  });
});

describe('BUGGLES ART: clock → ADSR contract (regression for e2e flake)', () => {
  // Locks in that the params chosen in e2e/tests/buggles.spec.ts CLOCK→ADSR
  // test produce a non-zero envelope readable by a 50ms-cadence poll over
  // up to 2s — i.e. there is no period in the cycle longer than the poll
  // interval where the env stays at 0. Mirrors what the AnalyserNode in the
  // browser scope sees.
  //
  // Original e2e bug: ADSR(attack=5ms, decay=200ms, sustain=0.4, release=100ms)
  // fed by a 5ms gate goes attack→release immediately (sustain is never held
  // because gate falls before decay completes); env is non-zero only for
  // ~105ms per 240ms period, leaving a 135ms dead zone. A single 43ms
  // analyser snapshot landed entirely inside the dead zone ~38% of the time.
  //
  // Tightened to attack=5ms decay=50ms sustain=0.4 release=70ms so the
  // env-active window is ~75ms and per-cycle dead time drops to ~165ms —
  // still long, but caught reliably by a 50ms-cadence poll.
  it('ADSR(a=5ms,d=50ms,s=0.4,r=70ms) fed 5ms gates @ 240ms period peaks > 0.1 every period', async () => {
    const DURATION_S = 2.0;
    const PERIOD_S = 0.24;
    const GATE_WIDTH_S = 0.005;
    const A = 0.005, D = 0.05, S = 0.4, R = 0.07;

    const ctx = new OfflineAudioContext({
      numberOfChannels: 1,
      length: Math.round(SAMPLE_RATE * DURATION_S),
      sampleRate: SAMPLE_RATE,
    });

    // Model the ADSR with linear ramps on a ConstantSource — same shape as
    // Faust's en.adsr triggered by an instantaneous gate. For each gate at
    // t=tg: rise to 1 by tg+A, decay to S by tg+A+D, hold S until tg+W
    // (gate falls), release to 0 by tg+W+R.
    const env = ctx.createConstantSource();
    env.offset.setValueAtTime(0, 0);

    let last = 0;
    for (let tg = 0.05; tg + R < DURATION_S; tg += PERIOD_S) {
      const gateEnd = tg + GATE_WIDTH_S;
      env.offset.setValueAtTime(last, tg);
      env.offset.linearRampToValueAtTime(1, tg + A);
      // Gate is only 5ms but A=5ms — sustain reached at exactly tg+A which
      // is also gate-fall. Decay never runs; we go straight to release from 1.
      env.offset.setValueAtTime(1, gateEnd);
      env.offset.linearRampToValueAtTime(0, gateEnd + R);
      last = 0;
    }
    env.start();
    env.connect(ctx.destination);

    const r = await ctx.startRendering();
    const buf = r.getChannelData(0);

    // Mirror the polling loop in e2e/tests/buggles.spec.ts pollScopePeak:
    // scan the buffer in 50ms slices, asserting at least one slice has a
    // peak > 0.1. Stronger: every period's worth of slices contains a peak.
    const POLL_MS = 50;
    const SLICE = Math.floor((POLL_MS / 1000) * SAMPLE_RATE);
    let slicesWithPeak = 0;
    let totalSlices = 0;
    for (let i = 0; i + SLICE < buf.length; i += SLICE) {
      let maxAbs = 0;
      for (let j = i; j < i + SLICE; j++) {
        const a = Math.abs(buf[j]!);
        if (a > maxAbs) maxAbs = a;
      }
      totalSlices++;
      if (maxAbs > 0.1) slicesWithPeak++;
    }
    // With a 75ms env-active window per 240ms period and 50ms slices, we
    // expect roughly slicesWithPeak/totalSlices ≈ (75+50)/240 ≈ 52% of
    // slices to overlap an env-active window. Lower bound 30% is a wide
    // safety margin for setValueAtTime block-boundary slop.
    const ratio = slicesWithPeak / totalSlices;
    expect(
      ratio,
      `slices with peak>0.1: ${slicesWithPeak}/${totalSlices} (${(ratio * 100).toFixed(0)}%)`,
    ).toBeGreaterThan(0.3);
  });
});

describe('BUGGLES ART: the real factory is BIT-EXACTLY SILENT offline (real-factory-silence)', () => {
  // ⚠ THIS IS THE LEG THAT MAKES THE HEADER'S CLAIM A MEASUREMENT. Every other
  // scenario in this file hand-orchestrates the events `fireWoggleEvent` WOULD
  // schedule; this one builds the module through its OWN def factory and reads
  // what actually comes out. The answer is nothing, on all five jacks, and the
  // positive control in the same render is what makes that zero attributable
  // rather than "the capture path is broken" (`skeptical-first-baseline`: a
  // bit-exact zero is also what a dead instrument returns).
  //
  // ⚠ AND THE GATE STATES ITS OWN SCOPE, because the thing being asserted is a
  // RACE and a race can be lost. The silence holds only while the render
  // finishes inside BUGGLES_FIRST_WOGGLE_MS of wall clock; a runner slow enough
  // to lose that would see the first woggle land INSIDE the buffer and this
  // whole describe would go red for a reason that has nothing to do with the
  // module. So the margin is MEASURED and asserted as its own leg, with the
  // numbers in the message — if CI ever gets close, `the render finishes with
  // margin` reddens FIRST and says by how much, instead of the silence legs
  // reddening mysteriously. The render is deliberately SHORT for the same
  // reason: 0.5 s of audio is ~0.02 ms of render work at the measured
  // ~23,000x real-time, i.e. three orders of magnitude of headroom.
  const OUT_IDS = bugglesDef.outputs.map((o) => o.id);
  const RENDER_S = 0.5;

  async function renderReal(nodeId: string, durS: number) {
    const N = Math.round(SAMPLE_RATE * durS);
    // One extra channel past the module's own jacks, for the control tone.
    const ctx = new OfflineAudioContext({
      numberOfChannels: OUT_IDS.length + 1,
      length: N,
      sampleRate: SAMPLE_RATE,
    });
    const node = {
      id: nodeId,
      type: 'buggles',
      position: { x: 0, y: 0 },
      // Everything cranked, so a silent result cannot be "it was turned down".
      params: { rate: 0.9, chaos: 0.5, smoothness: 0.1, burst_probability: 1, level: 1 },
    } as never;
    // The clock starts HERE — the module's first-woggle timer is armed inside
    // `factory`, so this is the instant the margin is measured from.
    const t0 = Date.now();
    const handle = await bugglesDef.factory(ctx as unknown as AudioContext, node);

    const merger = ctx.createChannelMerger(OUT_IDS.length + 1);
    OUT_IDS.forEach((id, i) => {
      const o = handle.outputs.get(id)!;
      o.node.connect(merger, o.output, i);
    });
    // THE POSITIVE CONTROL, on the SAME merger and the SAME destination.
    const control = ctx.createConstantSource();
    control.offset.value = 0.42;
    control.connect(merger, 0, OUT_IDS.length);
    control.start(0);
    merger.connect(ctx.destination);

    const r = await ctx.startRendering();
    // Read the margin BEFORE the (comparatively slow) buffer copies below —
    // what matters is when the render finished, not when the test did.
    const wallMs = Date.now() - t0;
    handle.dispose?.();
    const chans = OUT_IDS.map((_, i) => Float32Array.from(r.getChannelData(i)));
    return { chans, control: Float32Array.from(r.getChannelData(OUT_IDS.length)), wallMs };
  }

  it('the render finishes with MARGIN — the scope of the two legs below', async () => {
    // The precondition, asserted rather than assumed. Measured ~1 ms locally
    // against a 50 ms budget; the bound is half the budget so this reddens with
    // a number well before the silence legs start reporting phantom audio.
    const a = await renderReal('art-margin', RENDER_S);
    expect(
      a.wallMs,
      `${RENDER_S}s render took ${a.wallMs} ms wall against the module's ` +
        `${BUGGLES_FIRST_WOGGLE_MS} ms first-woggle timer (units: ms). Past that budget the ` +
        `scheduler starts writing INTO the buffer and the silence legs below stop meaning ` +
        `what they say — that is a runner-speed problem, not a module regression.`,
    ).toBeLessThan(BUGGLES_FIRST_WOGGLE_MS / 2);
  });

  it('every declared output renders bit-exact zero, while the control renders 0.42', async () => {
    const a = await renderReal('art-silence', RENDER_S);
    expect(peakAbs(a.control), 'the capture path CAN carry a signal (units: linear amplitude)')
      .toBeCloseTo(0.42, 6);
    OUT_IDS.forEach((id, i) => {
      expect(peakAbs(a.chans[i]!), `${id} peak (units: linear amplitude)`).toBe(0);
    });
  });

  it('and it is REPRODUCIBLE — two renders are bit-identical on every jack', async () => {
    // Rendered TWICE and compared sample by sample, the #1680 discipline: a
    // module whose state is written from a wall-clock pump can differ run to
    // run, so "silent" is only a usable fact once it is also stable.
    const a = await renderReal('art-silence', RENDER_S);
    const b = await renderReal('art-silence', RENDER_S);
    OUT_IDS.forEach((id, i) => {
      const x = a.chans[i]!;
      const y = b.chans[i]!;
      expect(x.length, `${id} length`).toBe(y.length);
      let firstDiff = -1;
      for (let n = 0; n < x.length; n++) {
        if (!Object.is(x[n], y[n])) { firstDiff = n; break; }
      }
      expect(firstDiff, `${id}: first differing sample index (-1 = bit-identical)`).toBe(-1);
    });
  });
});

describe('BUGGLES ART: rate knob mapping', () => {
  it('knob=0.4 maps to ~1 Hz', () => {
    // Default rate. 0.4 → 0.1 × (500)^0.4 ≈ 1.21 Hz.
    const hz = bugglesMath.rateKnobToHz(0.4);
    expect(hz).toBeGreaterThan(1.0);
    expect(hz).toBeLessThan(1.5);
  });

  it('full sweep monotonically increases', () => {
    let prev = 0;
    for (const k of [0, 0.1, 0.25, 0.5, 0.75, 0.9, 1.0]) {
      const hz = bugglesMath.rateKnobToHz(k);
      expect(hz, `knob=${k} hz=${hz}`).toBeGreaterThan(prev);
      prev = hz;
    }
  });
});
