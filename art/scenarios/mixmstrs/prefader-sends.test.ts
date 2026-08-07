// art/scenarios/mixmstrs/prefader-sends.test.ts
//
// PRE/POST-FADER AUX SENDS + RETURN strips (owner 2026-08-06).
//
// The requirement in one sentence: "sends need to be pre-fader, so we always
// send at the input level × the send amount — in this way the returns can carry
// sound even if the channel they're on is muted", switchable per send, so
// send 1 and send 2 can be in different configs.
//
// This is an ASSERTION scenario, not a pinned baseline: what matters is the
// ROUTING INVARIANT (does a muted channel still feed the bus?), which a
// numeric assertion states directly and a .f32 pin only states by implication.
// The pinned signature baselines stay in profile.test.ts.
//
// Every leg is NEGATIVE-CONTROLLED — each "pre-fader carries the muted channel"
// assertion is paired with the same render at POST proving the bus is silent.
// Without that pairing a send that ignored the fader entirely, or a `send1Pre`
// that did nothing at all, would pass the positive half on its own.

import { describe, expect, it } from 'vitest';
import { SAMPLE_RATE } from '../../setup/capture';
import { vcoTestSignal, C4_HZ } from '../../setup/drivers';
import { renderFaustOffline } from '../../setup/faust-offline';

const SR = SAMPLE_RATE;
const DURATION_S = 0.3;
const N = Math.round(SR * DURATION_S);
const SETTLE = Math.round(0.15 * SR); // skip si.smoo ramp-in on the flags/faders

const saw = vcoTestSignal({ totalS: DURATION_S, shape: 'saw', freqHz: C4_HZ, amp: 0.5 });

/** RMS over the settled window — the level the bus is actually carrying. */
function rms(buf: Float32Array): number {
  let s = 0;
  for (let i = SETTLE; i < N; i++) s += buf[i]! * buf[i]!;
  return Math.sqrt(s / (N - SETTLE));
}

/** Render mixmstrs with ch1 fed a saw and `params` applied over the defaults. */
async function render(params: Record<string, number>): Promise<Record<string, Float32Array>> {
  const inputs: (Float32Array | null)[] = new Array(20).fill(null);
  inputs[0] = saw; inputs[1] = saw; // ch1 L/R
  return renderFaustOffline({
    name: 'mixmstrs',
    totalSamples: N,
    inputs,
    params: { master_volume: 0.9, ...params },
    outputs: ['masterL', 'masterR', 'send1L', 'send1R', 'send2L', 'send2R'],
  });
}

/** ch1 fully MUTED (fader at 0) but sending to both buses at full. */
const MUTED_CH1_SENDING = { ch1_volume: 0, ch1_send1: 1, ch1_send2: 1 };

describe('ART mixmstrs / PRE-fader aux sends (a muted channel still feeds the bus)', () => {
  it('POST-fader (the DEFAULT) — muting the channel silences its sends', async () => {
    const b = await render(MUTED_CH1_SENDING);
    // This is the negative control for every assertion below AND the proof the
    // default is unchanged: at ch1_volume = 0 the post-fader tap is 0 × signal.
    expect(rms(b.send1L!), 'send1 must be silent when a POST-fader channel is muted').toBeLessThan(1e-6);
    expect(rms(b.send2L!), 'send2 must be silent when a POST-fader channel is muted').toBeLessThan(1e-6);
    expect(rms(b.masterL!), 'master is silent too — the channel is muted').toBeLessThan(1e-6);
  });

  it('PRE-fader — the send carries the muted channel at input level × send amount', async () => {
    const b = await render({ ...MUTED_CH1_SENDING, send1Pre: 1, send2Pre: 1 });
    // The owner's actual requirement: audible on the bus THROUGH a mute.
    expect(rms(b.send1L!), 'send1 PRE must carry the muted channel').toBeGreaterThan(0.05);
    expect(rms(b.send2L!), 'send2 PRE must carry the muted channel').toBeGreaterThan(0.05);
    // …while the MASTER stays silent. That is the whole point: the channel is
    // muted in the mix and alive in the returns, not merely un-muted.
    expect(rms(b.masterL!), 'master must STAY muted — pre-fader must not leak into the mix').toBeLessThan(1e-6);
  });

  it('the two buses are INDEPENDENT — send1 PRE while send2 stays POST', async () => {
    // The owner asked for this case by name ("we can have send1 and send2 in
    // different configs"), and it is the one a single shared flag would fail.
    const b = await render({ ...MUTED_CH1_SENDING, send1Pre: 1, send2Pre: 0 });
    expect(rms(b.send1L!), 'send1 is PRE → carries the muted channel').toBeGreaterThan(0.05);
    expect(rms(b.send2L!), 'send2 is POST → silent on the same muted channel').toBeLessThan(1e-6);

    // …and the mirror image, so neither flag is secretly driving both.
    const m = await render({ ...MUTED_CH1_SENDING, send1Pre: 0, send2Pre: 1 });
    expect(rms(m.send1L!), 'send1 is POST → silent').toBeLessThan(1e-6);
    expect(rms(m.send2L!), 'send2 is PRE → carries the muted channel').toBeGreaterThan(0.05);
  });

  it('PRE-fader level is INDEPENDENT of the fader, POST-fader tracks it', async () => {
    // Sweep the fader and watch what each mode does to the bus. This is what
    // distinguishes "pre-fader" from "the flag makes the send louder".
    const pre: number[] = [];
    const post: number[] = [];
    for (const vol of [0, 0.25, 0.5, 1]) {
      pre.push(rms((await render({ ch1_volume: vol, ch1_send1: 1, send1Pre: 1 })).send1L!));
      post.push(rms((await render({ ch1_volume: vol, ch1_send1: 1, send1Pre: 0 })).send1L!));
    }
    // PRE: flat across the whole fader sweep (within smoothing tolerance).
    const spread = Math.max(...pre) - Math.min(...pre);
    expect(spread / Math.max(...pre), `PRE must not track the fader; got ${pre.join(', ')}`).toBeLessThan(0.02);
    // POST: strictly increasing with the fader, and silent at 0.
    expect(post[0]!, 'POST at fader 0 is silence').toBeLessThan(1e-6);
    for (let i = 1; i < post.length; i++) {
      expect(post[i]!, `POST must rise with the fader: ${post.join(', ')}`).toBeGreaterThan(post[i - 1]!);
    }
    // At a FULL fader the two modes agree — pre-fader is a tap point, not a gain.
    expect(Math.abs(pre[3]! - post[3]!) / pre[3]!, 'at fader 1.0 PRE ≈ POST').toBeLessThan(0.02);
  });

  it('the send amount still scales a PRE-fader send (it is level × amount)', async () => {
    const full = rms((await render({ ch1_volume: 0, ch1_send1: 1, send1Pre: 1 })).send1L!);
    const half = rms((await render({ ch1_volume: 0, ch1_send1: 0.5, send1Pre: 1 })).send1L!);
    const off = rms((await render({ ch1_volume: 0, ch1_send1: 0, send1Pre: 1 })).send1L!);
    expect(half / full, 'send amount 0.5 ≈ half the level').toBeGreaterThan(0.45);
    expect(half / full, 'send amount 0.5 ≈ half the level').toBeLessThan(0.55);
    expect(off, 'send amount 0 is silent even PRE-fader').toBeLessThan(1e-6);
  });
});

describe('ART mixmstrs / RETURN strips (the level control that makes pre-fader sends usable)', () => {
  /** Feed the RETURN inputs directly (Faust inputs 16,17 = return 1 L/R). */
  async function renderReturn(params: Record<string, number>): Promise<Record<string, Float32Array>> {
    const inputs: (Float32Array | null)[] = new Array(20).fill(null);
    inputs[16] = saw; inputs[17] = saw; // return 1 L/R
    return renderFaustOffline({
      name: 'mixmstrs',
      totalSamples: N,
      inputs,
      params: { master_volume: 1, ...params },
      outputs: ['masterL', 'masterR', 'send1L', 'send1R', 'send2L', 'send2R'],
    });
  }

  it('RETURN volume defaults to UNITY — an existing patch is unchanged', async () => {
    const dflt = rms((await renderReturn({})).masterL!);
    const unity = rms((await renderReturn({ ret1_volume: 1 })).masterL!);
    expect(dflt).toBeGreaterThan(0.05); // the return reaches the master at all
    // Defaulting to the channels' 0.8 instead would quietly drop every existing
    // patch's return level by 2 dB — this pins that it did not happen.
    expect(Math.abs(dflt - unity) / unity, 'default return level IS unity').toBeLessThan(1e-6);
  });

  it('RETURN volume attenuates the wet coming back, down to silence', async () => {
    const full = rms((await renderReturn({ ret1_volume: 1 })).masterL!);
    const half = rms((await renderReturn({ ret1_volume: 0.5 })).masterL!);
    const zero = rms((await renderReturn({ ret1_volume: 0 })).masterL!);
    expect(half / full).toBeGreaterThan(0.45);
    expect(half / full).toBeLessThan(0.55);
    expect(zero, 'return at 0 is fully out of the mix').toBeLessThan(1e-6);
  });

  it('RETURN 1 and RETURN 2 are independent strips', async () => {
    // Return 2 turned down must not touch return 1's signal.
    const r1Only = rms((await renderReturn({ ret1_volume: 1, ret2_volume: 0 })).masterL!);
    const both = rms((await renderReturn({ ret1_volume: 1, ret2_volume: 1 })).masterL!);
    expect(Math.abs(r1Only - both) / both, 'ret2_volume must not affect return 1').toBeLessThan(1e-6);
  });

  it('a RETURN does NOT feed the sends — no send/return feedback loop', async () => {
    // Structural guarantee, not a tuning choice: routing a return back into the
    // send that feeds it would howl. Signal on return 1 must never appear on a
    // send bus, even with every send amount wide open and PRE engaged.
    const b = await renderReturn({
      ret1_volume: 1,
      ch1_send1: 1, ch1_send2: 1, send1Pre: 1, send2Pre: 1,
    });
    expect(rms(b.masterL!), 'the return IS in the master').toBeGreaterThan(0.05);
    expect(rms(b.send1L!), 'return must not reach send 1').toBeLessThan(1e-6);
    expect(rms(b.send2L!), 'return must not reach send 2').toBeLessThan(1e-6);
  });
});
