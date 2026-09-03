// art/scenarios/mixmstrs/rec-tap-points.test.ts
//
// THE THREE `recTap` POINTS, DELIVERED AND MEASURED — the slice-3b scenario.
//
// Slice 3 shipped the `recTap` roster with one live option (BOARD IN) and a
// flagged obligation: the slice that wires the recorder must refuse a tap it
// cannot deliver. This slice DISCHARGES that obligation the other way — it
// makes every roster entry deliverable — and this file is where "deliverable"
// is a measurement rather than a claim:
//
//   BOARD IN     the unity insert heads (asserted for identity and reach by
//                board-insert-identity.test.ts). Here: it SURVIVES the fader,
//                which is the property that separates it from POST FADER.
//   POST FADER   the DSP's per-channel taps, now STEREO (outputs 6..21). The
//                mono `(L+R)*0.5` predecessors were measurably phase-blind —
//                an anti-phase channel read rms 0.0000e+0 while masterL and
//                masterR each carried 0.184216 — so a recording off them would
//                have captured the CANCELLATION rather than the channel.
//                Stereo-preserved is the whole reason this tap can ship.
//   MASTER       the mix bus pair — the same splitter outputs the masterL/R
//                jacks publish, asserted by IDENTITY (same node, same output),
//                so the tap cannot drift from the jack.
//
// Two instruments, deliberately:
//   - `renderFaustOffline` drives the SHIPPED wasm and reads the tap OUTPUTS
//     by Faust index — the DSP-level truth about what the taps carry.
//   - `node-web-audio-api` + the REAL factory reads `read('recTaps')` — the
//     seam the recorder slice actually wires from — and proves the published
//     legs carry (or, for POST FADER at fader 0, correctly do NOT carry) the
//     driven signal. board-insert-identity.test.ts is the template.
//
// ASSERTION SCENARIO — no baseline, no `.sha`, nothing pinned. The mixmstrs
// pins (masterL/send1L/send2L, dspSourceSha over mixmstrs.dsp) live in
// profile.test.ts; this file asserts INVARIANTS about the taps.

import { describe, expect, it } from 'vitest';
import { OfflineAudioContext } from 'node-web-audio-api';
import { SAMPLE_RATE } from '../../setup/capture';
import { vcoTestSignal, C4_HZ } from '../../setup/drivers';
import { renderFaustOffline } from '../../setup/faust-offline';
import {
  mixmstrsDef,
  mixmstrsRecTapPair,
  type MixmstrsRecTaps,
} from '$lib/audio/modules/mixmstrs';

const SR = SAMPLE_RATE;
const DUR_S = 0.5;
const N = Math.round(SR * DUR_S);
/** Skip the Faust `si.smoo` ramp-in before measuring. */
const SETTLE = Math.round(0.15 * SR);

const fmt = (v: number) => (v === 0 ? '0.0000e+0' : v.toExponential(4));

function rms(buf: Float32Array, from = SETTLE): number {
  let acc = 0;
  for (let i = from; i < buf.length; i++) acc += buf[i]! * buf[i]!;
  return Math.sqrt(acc / Math.max(1, buf.length - from));
}

const saw = vcoTestSignal({ totalS: DUR_S, shape: 'saw', freqHz: C4_HZ, amp: 0.5 });
const sawInv = (() => {
  const out = new Float32Array(saw.length);
  for (let i = 0; i < saw.length; i++) out[i] = -saw[i]!;
  return out;
})();

/** Output-name prefix long enough to reach the named tap legs. Position k =
 *  Faust output index k — the same index order the factory's splitter uses. */
const OUT_NAMES = [
  'masterL', 'masterR', 'send1L', 'send1R', 'send2L', 'send2R',
  'tap1L', 'tap1R', 'tap2L', 'tap2R', 'tap3L', 'tap3R',
] as const;

describe('ART mixmstrs / rec tap points (slice 3b)', () => {
  it('POST FADER is STEREO: an anti-phase channel arrives intact, not cancelled', async () => {
    // The signal that DEFINED the defect: ch1L = saw, ch1R = −saw. The old
    // mono tap emitted (L+R)*0.5 = digital silence for it; the stereo pair
    // must carry both legs at full level, still in anti-phase.
    const inputs: (Float32Array | null)[] = new Array(20).fill(null);
    inputs[0] = saw;
    inputs[1] = sawInv;
    const out = await renderFaustOffline({
      name: 'mixmstrs',
      totalSamples: N,
      inputs,
      params: { ch1_volume: 0.8, master_volume: 0.9 },
      outputs: OUT_NAMES.slice(0, 8),
    });
    const l = rms(out.tap1L!);
    const r = rms(out.tap1R!);
    // eslint-disable-next-line no-console
    console.log(`[rec-tap-points] anti-phase ch1 tap rms L=${fmt(l)} R=${fmt(r)}`);
    expect(l, 'tap L leg must be audible').toBeGreaterThan(0.05);
    expect(r, 'tap R leg must be audible').toBeGreaterThan(0.05);
    expect(r, 'symmetric chains → equal leg levels').toBeCloseTo(l, 3);
    // The pair is still anti-phase — the tap did not sneak a mono fold in
    // anywhere. Max |L+R| over the settled window is the OLD tap's output,
    // and it must be (near-)silence exactly as the incident measured.
    let maxSum = 0;
    for (let i = SETTLE; i < N; i++) {
      maxSum = Math.max(maxSum, Math.abs(out.tap1L![i]! + out.tap1R![i]!));
    }
    expect(maxSum, 'the legs stay equal-and-opposite; their sum is the dead mono tap').toBeLessThan(1e-5);
    // Vacuity guard: the channel is genuinely reaching the master bus (each
    // master leg carries its own side; anti-phase L/R do NOT cancel there).
    expect(rms(out.masterL!), 'masterL must carry the L side').toBeGreaterThan(0.05);
    expect(rms(out.masterR!), 'masterR must carry the R side').toBeGreaterThan(0.05);
  }, 120_000);

  it('the tap is POST-fader: the fader scales it and fader 0 silences it', async () => {
    const inputs: (Float32Array | null)[] = new Array(20).fill(null);
    inputs[0] = saw;
    inputs[1] = saw;
    const at = async (vol: number) =>
      renderFaustOffline({
        name: 'mixmstrs',
        totalSamples: N,
        inputs,
        params: { ch1_volume: vol, master_volume: 0.9 },
        outputs: OUT_NAMES.slice(0, 8),
      });
    const [full, half, muted] = await Promise.all([at(0.8), at(0.4), at(0)]);
    const rFull = rms(full!.tap1L!);
    const rHalf = rms(half!.tap1L!);
    const rMuted = rms(muted!.tap1L!);
    // eslint-disable-next-line no-console
    console.log(
      `[rec-tap-points] tap1L rms @vol 0.8=${fmt(rFull)} @0.4=${fmt(rHalf)} @0=${fmt(rMuted)}`,
    );
    expect(rFull, 'driven tap must be audible (positive control)').toBeGreaterThan(0.05);
    // EQ flat + comp bypassed → the tap tracks the fader linearly.
    expect(rHalf / rFull, 'half the fader is half the tap').toBeCloseTo(0.5, 2);
    // Fader at 0 → the tap prints silence. That is the SEMANTIC of this tap —
    // a muted channel records silence here, where BOARD IN still records the
    // input (asserted at the factory seam below).
    expect(rMuted, 'fader 0 must silence the POST FADER tap').toBeLessThan(1e-4);
  }, 180_000);

  it('tap pair N carries channel N and ONLY channel N', async () => {
    // Drive ch3 alone; tap3 must carry it and tap1/tap2 must stay silent — a
    // one-off-by-one in the (now stereo) index math would put channel 3 on a
    // neighbour's pair and this is the leg that reddens.
    const inputs: (Float32Array | null)[] = new Array(20).fill(null);
    inputs[4] = saw; // ch3L
    inputs[5] = saw; // ch3R
    const out = await renderFaustOffline({
      name: 'mixmstrs',
      totalSamples: N,
      inputs,
      params: { ch3_volume: 0.8, master_volume: 0.9 },
      outputs: OUT_NAMES,
    });
    expect(rms(out.tap3L!), 'tap3L carries ch3').toBeGreaterThan(0.05);
    expect(rms(out.tap3R!), 'tap3R carries ch3').toBeGreaterThan(0.05);
    for (const quiet of ['tap1L', 'tap1R', 'tap2L', 'tap2R'] as const) {
      expect(rms(out[quiet]!), `${quiet} must stay silent`).toBeLessThan(1e-6);
    }
  }, 120_000);

  it('read("recTaps"): MASTER IS the master jacks; BOARD IN survives the fader, POST FADER obeys it', async () => {
    // The seam the recorder slice wires from, on the REAL factory. One render,
    // four destination channels: ch1's POST FADER pair on 0/1 and its BOARD IN
    // pair on 2/3, with the fader at 0 — the one setting where the two taps
    // MUST disagree. BOARD IN is upstream of fader (and duck); POST FADER is
    // the channel as the mix hears it.
    const ctx = new OfflineAudioContext({ numberOfChannels: 4, length: N, sampleRate: SR });
    const node = {
      id: 'rec-taps',
      type: 'mixmstrs',
      position: { x: 0, y: 0 },
      params: { ch1_volume: 0 },
    } as never;
    const handle = await mixmstrsDef.factory(ctx as unknown as AudioContext, node);
    handle.setParam?.('ch1_volume', 0);

    const taps = handle.read?.('recTaps') as MixmstrsRecTaps;
    expect(taps, 'the factory must publish the tap rosters').toBeTruthy();
    expect(taps.board).toHaveLength(16);
    expect(taps.postFader).toHaveLength(16);

    // MASTER by IDENTITY: the exact node+output the masterL/R jacks publish.
    // Identity, not equivalence — the tap cannot drift from the jack.
    const jackL = handle.outputs.get('masterL')!;
    const jackR = handle.outputs.get('masterR')!;
    const master = mixmstrsRecTapPair(taps, 2, 0);
    expect(master.l.node, 'MASTER L node is the master jack node').toBe(jackL.node);
    expect(master.l.output, 'MASTER L output index').toBe(jackL.output);
    expect(master.r.node, 'MASTER R node is the master jack node').toBe(jackR.node);
    expect(master.r.output, 'MASTER R output index').toBe(jackR.output);

    // Drive ch1 through its input PORT (the jack path, not a private node).
    for (const portId of ['ch1L', 'ch1R'] as const) {
      const ref = handle.inputs.get(portId)!;
      const osc = ctx.createOscillator();
      osc.type = 'sawtooth';
      osc.frequency.value = 220;
      const trim = ctx.createGain();
      trim.gain.value = 0.35;
      osc.connect(trim);
      trim.connect(ref.node, 0, ref.input);
      osc.start(0);
    }

    const post = mixmstrsRecTapPair(taps, 1, 0);
    const board = mixmstrsRecTapPair(taps, 0, 0);
    const merger = ctx.createChannelMerger(4);
    ([post.l, post.r, board.l, board.r] as const).forEach((leg, k) => {
      leg.node.connect(merger, leg.output, k);
    });
    merger.connect(ctx.destination);

    const buf = await ctx.startRendering();
    const postRms = Math.max(rms(buf.getChannelData(0)), rms(buf.getChannelData(1)));
    const boardRms = Math.min(rms(buf.getChannelData(2)), rms(buf.getChannelData(3)));
    // eslint-disable-next-line no-console
    console.log(
      `[rec-tap-points] fader 0: POST FADER rms=${fmt(postRms)} BOARD IN rms=${fmt(boardRms)}`,
    );
    // BOARD IN records what you PLAYED — the fader cannot touch it. This is
    // also the positive control proving the render carried signal at all.
    expect(boardRms, 'BOARD IN must survive fader 0 on BOTH legs').toBeGreaterThan(0.05);
    // POST FADER prints the channel as the mix hears it — fader 0 is silence.
    expect(postRms, 'POST FADER must print silence at fader 0').toBeLessThan(1e-3);
    handle.dispose?.();
  }, 180_000);
});
