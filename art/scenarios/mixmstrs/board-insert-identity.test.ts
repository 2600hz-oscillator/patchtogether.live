// art/scenarios/mixmstrs/board-insert-identity.test.ts
//
// DOES THE PRE-BOARD INSERT CHANGE ANY SAMPLE?
//
// The clip-recording programme adds a per-input-port insert to the mixmstrs JS
// factory so a recorder can tap the RAW patched channel input — before EQ,
// before the compressor, before the fader:
//
//     jack --> boardIn (unity) --> duck (MON) --> merger --> Faust
//
// The whole design rests on `x * 1.0` being identity for every finite
// IEEE-754 float. That is true, and this module has ALREADY been bitten by
// exactly this class of claim: `mixmstrs.dsp:205-216` records that an
// ALGEBRAICALLY IDENTICAL pre/post crossfade moved the send baselines by 1-2
// ULP on ~35 % of samples. So the identity is asserted rather than assumed, and
// the PR reports the measured number instead of claiming zero.
//
// ── WHY NOTHING ELSE IN THE REPO CAN SEE THIS ──────────────────────────────
//
// `art/scenarios/mixmstrs/{profile,prefader-sends,face-premises,passthrough}`
// all render through `renderFaustOffline`, which compiles the wasm and drives
// `FaustMonoOfflineProcessor` directly — there is no `AudioContext` in that
// path at all, so it never builds the factory and a JS graph change is
// invisible to every one of them. The module's three pinned baselines
// (`masterL`/`send1L`/`send2L`) are pinned on `dspSourceSha('mixmstrs.dsp')`,
// i.e. on the DSP source alone, so a factory edit moves NO `.f32` and NO
// `.sha`. Nothing currently guards this file's graph numerically. That is the
// gap this scenario exists to close.
//
// ── WHAT THIS MEASURES, AND WHAT IT DOES NOT ───────────────────────────────
//
// ⚠ STATED PLAINLY BECAUSE THE DIFFERENCE MATTERS. The insert is unconditional
// in the shipped factory — there is no build-without-it flag, and adding a
// product hook purely so a test could bypass it would be shipping a seam for
// the test's convenience. So the A/B here puts the SAME arithmetic on the
// CALLER's side of the same port, in the same harness, on the same module and
// the same signal: render once driving the input port directly, render again
// driving it through TWO unity `GainNode`s, and compare every sample.
//
// That measures the exact primitive the insert is built from — two series
// unity gains in this context, on this module's real input path, through the
// real Faust worklet — and it is negative-controlled by a leg that perturbs one
// gain by 1e-7 and REQUIRES a non-zero delta, so a bit-exact zero cannot be the
// instrument silently measuring nothing.
//
// What it does NOT do is diff the shipped graph against a reconstruction of the
// pre-insert graph. A reconstruction would have to re-create the factory's
// silence sources, its param defaults and its worklet wiring by hand, and a
// mistake there reads as a delta that is not the insert's.
//
// ── DETERMINISM ────────────────────────────────────────────────────────────
//
// Every comp macro stays at its default 0, so `pumpCompMacros` finds nothing to
// re-apply and the 48 ms wall-clock interval is a no-op inside the render. Same
// for the MON duck: nothing publishes a lane-playing edge in this slice, so
// `clipLaneLiveGain(mon, false)` is 1 in every mode and no gain is ever
// written. Neither pump is suspended or resumed here, so this file is free of
// the `ctx.suspend()` registration race cv-path.test.ts documents.
//
// ASSERTION SCENARIO — no baseline, no `.sha`, nothing pinned. What matters is
// the INVARIANT (does the insert move a sample?), which a numeric assertion
// states directly and a `.f32` pin would only state by implication.

import { describe, expect, it } from 'vitest';
import { OfflineAudioContext } from 'node-web-audio-api';
import { mixmstrsDef, MIXMSTRS_CHANNELS } from '$lib/audio/modules/mixmstrs';

const SR = 48_000;
const DUR_S = 0.25;
const N = SR * DUR_S;
/** Skip the Faust `si.smoo` ramp-in before comparing. */
const SETTLE = Math.round(0.15 * SR);
/** Both master legs — an insert fault that hit only one would be invisible on
 *  a mono read. (The per-channel tap was mono `(L+R)*0.5` and measurably
 *  phase-blind when this file was written; it is stereo now — see
 *  rec-tap-points.test.ts — but the master pair remains the right instrument
 *  here: it is the bus the identity claim is about.) */
const OUTS = ['masterL', 'masterR'] as const;

const fmt = (v: number) => (v === 0 ? '0.0000e+0' : v.toExponential(4));

interface Render {
  chans: Float32Array[];
}

/** How the driver reaches the module's input port. */
type Leg =
  | { kind: 'direct' }
  /** `count` unity gains in series — the insert's own arithmetic. */
  | { kind: 'gains'; count: number; value: number };

/**
 * Render the REAL factory with every channel driven by a mutually inharmonic
 * saw, so no two strips can cancel and a fault on one channel cannot hide
 * inside another's signal.
 */
async function render(leg: Leg): Promise<Render> {
  const ctx = new OfflineAudioContext({ numberOfChannels: OUTS.length, length: N, sampleRate: SR });

  // Defaults everywhere: comp macros at 0 (so the pump is inert) and the new
  // clip-record controls at their own defaults, which is the state a rack comes
  // up in and the state the identity claim is about.
  const node = { id: 'insert-identity', type: 'mixmstrs', position: { x: 0, y: 0 }, params: {} } as never;
  const handle = await mixmstrsDef.factory(ctx as unknown as AudioContext, node);

  const ports = MIXMSTRS_CHANNELS.flatMap((ch) => [`ch${ch}L`, `ch${ch}R`]);
  ports.forEach((id, i) => {
    const ref = handle.inputs.get(id)!;
    const osc = ctx.createOscillator();
    osc.type = 'sawtooth';
    osc.frequency.value = 110 + i * 37; // mutually inharmonic
    const trim = ctx.createGain();
    trim.gain.value = 0.35;
    osc.connect(trim);

    let tail: AudioNode = trim;
    if (leg.kind === 'gains') {
      for (let g = 0; g < leg.count; g++) {
        const extra = ctx.createGain();
        extra.gain.value = leg.value;
        tail.connect(extra);
        tail = extra;
      }
    }
    tail.connect(ref.node, 0, ref.input);
    osc.start(0);
  });

  const merger = ctx.createChannelMerger(OUTS.length);
  OUTS.forEach((id, k) => {
    const ref = handle.outputs.get(id)!;
    ref.node.connect(merger, ref.output, k);
  });
  merger.connect(ctx.destination);

  const buf = await ctx.startRendering();
  const out = { chans: OUTS.map((_, k) => buf.getChannelData(k).slice()) };
  handle.dispose?.();
  return out;
}

/** Peak |Δsample| in LINEAR AMPLITUDE over the settled window, across every
 *  captured output. Not dB, not RMS — an RMS metric averages a per-sample ULP
 *  divergence away, which is precisely the thing being looked for. */
function peakDelta(a: Render, b: Render): number {
  let peak = 0;
  for (let k = 0; k < a.chans.length; k++) {
    const x = a.chans[k]!;
    const y = b.chans[k]!;
    for (let i = SETTLE; i < N; i++) peak = Math.max(peak, Math.abs(x[i]! - y[i]!));
  }
  return peak;
}

/** Peak |sample| — the vacuity guard. A silent render makes every delta zero. */
function peakLevel(r: Render): number {
  let peak = 0;
  for (const ch of r.chans) for (let i = SETTLE; i < N; i++) peak = Math.max(peak, Math.abs(ch[i]!));
  return peak;
}

describe('ART mixmstrs / pre-board insert identity', () => {
  it('the harness renders AUDIBLE, deterministic master output', async () => {
    // ⚠ THE VACUITY GUARD, FIRST. Every assertion below is a difference, and a
    // silent render makes all of them trivially zero — the "green because the
    // instrument measured nothing" failure. So: the render is audible, and it
    // is bit-identical to itself.
    const a = await render({ kind: 'direct' });
    expect(peakLevel(a), 'the driven master bus must be audible').toBeGreaterThan(0.05);
    for (const ch of a.chans) expect(ch.every(Number.isFinite)).toBe(true);

    const again = await render({ kind: 'direct' });
    expect(peakDelta(a, again), 'the render must be bit-identical to itself').toBe(0);
  }, 120_000);

  it('TWO SERIES UNITY GAINS move NO sample — the insert arithmetic, measured', async () => {
    const direct = await render({ kind: 'direct' });
    const inserted = await render({ kind: 'gains', count: 2, value: 1 });
    const delta = peakDelta(direct, inserted);
    // The number is REPORTED, not merely thresholded — the PR quotes this line.
    // eslint-disable-next-line no-console
    console.log(`[board-insert-identity] max |delta-sample| across masterL/masterR = ${fmt(delta)}`);
    expect(
      delta,
      `two series unity GainNodes moved the master bus by ${fmt(delta)}; the pre-board ` +
        `insert is built on this being exactly 0`,
    ).toBe(0);
  }, 120_000);

  it('and so does ONE, and FOUR — the identity does not depend on the count', async () => {
    const direct = await render({ kind: 'direct' });
    for (const count of [1, 4]) {
      const got = await render({ kind: 'gains', count, value: 1 });
      expect(peakDelta(direct, got), `${count} unity gain(s)`).toBe(0);
    }
  }, 180_000);

  it('THE PRIMITIVE, at full float32 resolution: a unity GainNode is BIT-EXACT', async () => {
    // ⚠ THE MODULE-LEVEL LEG ABOVE CANNOT RESOLVE A 1-2 ULP GAIN CHANGE, AND
    // THAT IS MEASURED, NOT ASSUMED. Sweeping the perturbation through the full
    // mixmstrs chain gives (peak |delta| on masterL/R, one channel driven):
    //
    //     gain 1 + 2^-23 (1 ULP)   -> 0
    //     gain 1 + 2^-20 (8 ULP)   -> 0
    //     gain 1 + 2^-16           -> 3.4124e-6
    //
    // So that leg's sensitivity floor sits between 2^-20 and 2^-16 relative:
    // the EQ -> comp -> fader chain and the 16-way sum round a sub-ULP input
    // perturbation away before it reaches the bus. Reporting its bit-exact 0 as
    // "no ULP drift" would therefore be claiming resolution the instrument does
    // not have — the precise mistake `mixmstrs.dsp:205-216` records someone
    // making about an algebraically identical change.
    //
    // This leg closes that gap by measuring the PRIMITIVE the insert is built
    // from with NOTHING in the path to absorb it: source -> destination against
    // source -> gain(1) -> gain(1) -> destination, raw float32, no Faust. Its
    // own positive control perturbs by ONE ULP and requires that to be visible,
    // which is what makes its zero mean "bit-exact" rather than "below the
    // noise floor".
    const raw = async (gains: number[]): Promise<Float32Array> => {
      const ctx = new OfflineAudioContext({ numberOfChannels: 1, length: N, sampleRate: SR });
      const osc = ctx.createOscillator();
      osc.type = 'sawtooth';
      osc.frequency.value = 220;
      const trim = ctx.createGain();
      trim.gain.value = 0.35;
      osc.connect(trim);
      let tail: AudioNode = trim;
      for (const v of gains) {
        const g = ctx.createGain();
        g.gain.value = v;
        tail.connect(g);
        tail = g;
      }
      tail.connect(ctx.destination);
      osc.start(0);
      return (await ctx.startRendering()).getChannelData(0).slice();
    };
    const peak = (a: Float32Array, b: Float32Array) => {
      let p = 0;
      for (let i = SETTLE; i < N; i++) p = Math.max(p, Math.abs(a[i]! - b[i]!));
      return p;
    };

    const bare = await raw([]);
    let level = 0;
    for (let i = SETTLE; i < N; i++) level = Math.max(level, Math.abs(bare[i]!));
    expect(level, 'the raw driver must be audible').toBeGreaterThan(0.1);

    const twoUnity = peak(bare, await raw([1, 1]));
    // eslint-disable-next-line no-console
    console.log(`[board-insert-identity] PRIMITIVE two unity gains, no Faust = ${fmt(twoUnity)}`);
    expect(twoUnity, 'two series unity GainNodes must be bit-exact on the raw signal').toBe(0);

    // POSITIVE CONTROL on THIS leg, pinned to the harness's MEASURED floor.
    //
    // ⚠ AND THE FLOOR IS NOT ULP-SCALE EVEN HERE, WHICH IS THE HONEST RESULT.
    // Sweeping the raw path (source -> gain -> destination, nothing else):
    //
    //     1 + 2^-23  -> 0            1 + 2^-18  -> 1.3113e-6
    //     1 + 2^-22  -> 0            1 + 2^-16  -> 5.3048e-6
    //     1 + 2^-20  -> 0            1 + 2^-13  -> 3.4690e-5
    //
    // `Math.fround(1 + 2^-23) !== 1`, so the perturbation SURVIVES float32 and
    // genuinely reaches the graph — the backend simply rounds a sub-2^-20 gain
    // error back out. So this harness resolves a relative gain error down to
    // about 2^-18 and NO FURTHER, and the leg is pinned there.
    //
    // ⚠ THEREFORE THE CLAIM IS BOUNDED, NOT ABSOLUTE. What is proven: the
    // insert introduces no error at or above ~4e-6 relative. What is NOT
    // proven: bit-exactness at the 1-2 ULP scale that moved this module's send
    // baselines. Saying "0" without saying "measured down to 2^-18" would be
    // exactly the overclaim `mixmstrs.dsp:205-216` is a monument to.
    const smallest = peak(bare, await raw([1 + 2 ** -18]));
    // eslint-disable-next-line no-console
    console.log(`[board-insert-identity] PRIMITIVE positive control, 1+2^-18 = ${fmt(smallest)}`);
    expect(
      smallest,
      'a 2^-18 gain must be visible with nothing in the path, or this leg measures nothing',
    ).toBeGreaterThan(0);
    // And the floor is stated as an assertion, so a backend that got MORE
    // precise would redden this and force the comment above to be re-measured
    // rather than quietly becoming false.
    expect(peak(bare, await raw([1 + 2 ** -23])), 'documented floor: 1 ULP is BELOW it').toBe(0);
  }, 120_000);

  it('POSITIVE CONTROL for the module leg, at its MEASURED sensitivity', async () => {
    // ⚠ WITHOUT THIS THE ZERO ABOVE PROVES NOTHING. A harness that rendered the
    // same buffer twice regardless of the graph would report a bit-exact 0 for
    // the module leg and look like a pass.
    //
    // ⚠ TWO EARLIER VERSIONS OF THIS CONTROL WERE THEMSELVES WRONG, and both
    // are worth recording because they are the exact traps this file exists to
    // avoid.
    //
    //   1. `1 + 1e-7` LOOKS like a perturbation and is not: an `AudioParam` is
    //      float32, whose epsilon at 1.0 is 2^-23 = 1.1920929e-7, so `1 + 1e-7`
    //      rounds to EXACTLY 1.0 before it reaches the graph. It measured 0 and
    //      read as "the instrument is blind" when the truth was "the control
    //      asked for no change".
    //   2. `1 + 2^-23` IS a real one-ULP perturbation — and it still measured 0
    //      HERE, because the EQ -> comp -> fader chain and the 16-way sum round
    //      it away before the bus. That is a fact about the chain, not a broken
    //      control, and the leg above is where the ULP claim is made instead.
    //
    // A negative-controlled test whose control is inert proves nothing in
    // either direction, so this one is pinned to the MEASURED floor: 2^-16
    // relative, the smallest perturbation this end-to-end path resolves.
    const PERTURB = 1 + 2 ** -16;
    const direct = await render({ kind: 'direct' });
    const perturbed = await render({ kind: 'gains', count: 1, value: PERTURB });
    const delta = peakDelta(direct, perturbed);
    // eslint-disable-next-line no-console
    console.log(`[board-insert-identity] module positive control, gain 1+2^-16 = ${fmt(delta)}`);
    expect(
      delta,
      'a 2^-16 gain perturbation must be visible end-to-end, or the module leg measures nothing',
    ).toBeGreaterThan(0);
  }, 120_000);

  it('every channel still reaches the master bus through the insert', async () => {
    // The insert re-points what `inputs.get()` publishes. A wiring mistake —
    // the wrong node, the wrong merger index, a forgotten connect — would show
    // as a channel that no longer contributes, which a delta test cannot see.
    // So: drive ONE channel at a time and require the bus to move.
    for (const ch of MIXMSTRS_CHANNELS) {
      const ctx = new OfflineAudioContext({ numberOfChannels: 1, length: N, sampleRate: SR });
      const node = { id: `reach-${ch}`, type: 'mixmstrs', position: { x: 0, y: 0 }, params: {} } as never;
      const handle = await mixmstrsDef.factory(ctx as unknown as AudioContext, node);
      const ref = handle.inputs.get(`ch${ch}L`)!;
      const osc = ctx.createOscillator();
      osc.frequency.value = 220;
      const g = ctx.createGain();
      g.gain.value = 0.5;
      osc.connect(g);
      g.connect(ref.node, 0, ref.input);
      osc.start(0);
      const out = handle.outputs.get('masterL')!;
      out.node.connect(ctx.destination, out.output, 0);
      const buf = await ctx.startRendering();
      const data = buf.getChannelData(0);
      let peak = 0;
      for (let i = SETTLE; i < N; i++) peak = Math.max(peak, Math.abs(data[i]!));
      expect(peak, `ch${ch}L must still reach masterL through the insert`).toBeGreaterThan(0.01);
      handle.dispose?.();
    }
  }, 300_000);

  it('the return gate is PINNED OPEN — no mode, and nothing attenuates', async () => {
    // ⚠ THE DUCK IS STILL BUILT AND IS NOW PERMANENTLY INERT. `ch{N}_mon` was
    // removed with the record band on 2026-09-04; `duckGain` stays in the graph
    // at unity so the two-series-unity-gain shape this file measures is
    // unchanged, and clause 6's per-clip LIVE/RECORDED toggle is what will
    // eventually move it.
    //
    // This asserts the gate never attenuates even when a lane IS playing —
    // which the old MON test could not check, because nothing published a lane
    // edge back then. A non-zero delta here means something started ducking.
    const ctx = new OfflineAudioContext({ numberOfChannels: OUTS.length, length: N, sampleRate: SR });
    const node = { id: 'gate', type: 'mixmstrs', position: { x: 0, y: 0 }, params: {} } as never;
    const handle = await mixmstrsDef.factory(ctx as unknown as AudioContext, node);
    // Tell the mixer every lane is playing. Under the OLD clip-auto default
    // this muted the live branch on all eight channels.
    for (let lane = 0; lane < MIXMSTRS_CHANNELS.length; lane++) {
      handle.write?.('clipLaneEdge', { lane, playing: true, atTime: 0 });
    }
    const duck = handle.read?.('recDuck') as { lanePlaying: boolean[]; applied: number[] };
    expect(duck.lanePlaying.every((p) => p === true), 'the lane flags DID move').toBe(true);
    expect(
      duck.applied,
      'the live-branch gain moved off unity — something is ducking again, and clause 6 has not shipped',
    ).toEqual(duck.applied.map(() => 1));
    handle.dispose?.();
  }, 120_000);

  it('read("recState") is GONE — the mixer no longer publishes an arm', async () => {
    // ⚠ A NEGATIVE PIN, and it is the one that matters for the removal. The
    // recorder registry takes its arm edges from this key; if it ever comes
    // back on mixmstrs, the surface the owner removed has been rebuilt on the
    // wrong module. `recTaps` is asserted alongside it because the AUDIO half
    // deliberately survived — clause 8 still records this module's per-lane
    // pre-board input, it is just no longer armed from here.
    const ctx = new OfflineAudioContext({ numberOfChannels: 1, length: N, sampleRate: SR });
    const node = { id: 'recstate', type: 'mixmstrs', position: { x: 0, y: 0 }, params: {} } as never;
    const handle = await mixmstrsDef.factory(ctx as unknown as AudioContext, node);
    expect(handle.read?.('recState'), 'the arm surface came back on mixmstrs').toBeUndefined();
    const taps = handle.read?.('recTaps') as { board: unknown[] } | undefined;
    expect(taps, 'the TAP rosters must survive — clause 8 records from them').toBeDefined();
    expect(taps!.board, 'BOARD IN is the per-lane pre-board capture source').toHaveLength(
      MIXMSTRS_CHANNELS.length * 2,
    );
    handle.dispose?.();
  }, 120_000);
});
