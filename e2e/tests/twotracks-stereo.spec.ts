// e2e/tests/twotracks-stereo.spec.ts
//
// TWOTRACKS — the two output JACKS must carry two DIFFERENT signals.
//
// ── WHY THIS SPEC HAS TO EXIST ────────────────────────────────────────────
// The worklet is `numberOfOutputs: 1, outputChannelCount: [2]` — ONE output
// carrying TWO channels. The factory mapped BOTH port handles at
// `{ node: workletNode, output: 0 }`, so `out_l` and `out_r` were literally
// the same graph edge. Patch them into two mono destinations and Web Audio
// down-mixes the 2-channel bus to (L+R)/2 at each: the stereo image is not
// separable at the patch points. The fix interposes a ChannelSplitter.
//
// NOTHING in the unit lane can render a sample — vitest runs `node`, with no
// AudioContext and no AudioWorklet — so the graph-shape assertions in
// `packages/web/src/lib/audio/modules/twotracks-stereo.test.ts` are the most
// that lane can say. This spec is the other half: a REAL AudioWorkletNode,
// real channels, and a measurement of what the jacks actually emit.
//
// ── THE MEASUREMENT: A DIFFERENCE NODE, NOT TWO ANALYSERS ─────────────────
// Two analysers (one per jack) compared by RMS is a bad instrument twice
// over: it samples the two jacks at DIFFERENT instants, so realtime jitter
// alone makes them differ, and RMS is invariant to an L/R SWAP, so a
// channel-crossing bug reads as perfectly correct.
//
// Instead the graph computes out_l − out_r (a gain of −1 on the right leg,
// both summed into one analyser). That is SAMPLE-ALIGNED by construction and
// needs no tolerance at the mono end: if the two jacks carry the same signal
// the difference is not "small", it is EXACTLY zero. It is also not
// swap-invariant. Critically, when both handles name the SAME node+output —
// the bug — the difference is exactly zero NO MATTER WHAT the module plays,
// which is precisely what makes leg 2 below a real test rather than a
// restatement of leg 1.
//
// Both directions run on EVERY execution, so the instrument is
// negative-controlled permanently rather than once at authoring time:
//   leg 1  mono drive   → difference EXACTLY 0   (guards a fake-stereo probe)
//   leg 2  stereo drive → difference LOUD        (the fix; RED before it)
//
// ── HOW TWOTRACKS IS MADE TO SOUND ────────────────────────────────────────
// No recording is needed. `monitor: 1` passes the live input through to the
// output regardless of transport (worklet: `reelOutSample(tape, inputPath,
// monitorOn, …)`, and an IDLE reel contributes tape = 0). `ab` defaults to 0
// → gainA = 1, gainB = 0, so reel A alone is heard. Reel A's worklet inputs
// are 0 (L) and 1 (R), and an UNCONNECTED right input normals to the left
// (`const dryR = inR ? … : dryL`) — which is exactly why a mono patch gives
// L === R, and why this bug survived every casual listen.

import { test, expect } from './_fixtures';
import { spawnPatch } from './_helpers';

const SUT = 'tt';
const SRC = 'noise1';

/**
 * Install the (out_l − out_r) probe on the module's two OUTPUT PORTS.
 *
 * It resolves each jack through `getOutputNode(nodeId, portId)` — the same
 * seam the patch engine uses to materialise a cable — so it measures what a
 * user's cable would actually receive, not some internal node. Everything
 * stays IN THE PAGE: a Playwright-side poll loop would be one protocol round
 * trip per sample on the same main thread as the audio graph it measures.
 */
async function installDiffProbe(page: import('@playwright/test').Page): Promise<void> {
  await page.evaluate((sut) => {
    const w = globalThis as unknown as {
      __engine: () => {
        getDomain(domain: string): {
          getOutputNode(nodeId: string, portId: string): { node: AudioNode; output: number } | null;
        };
      };
      __ttProbe?: { diff: AnalyserNode; left: AnalyserNode; sameEdge: boolean };
    };
    const audio = w.__engine().getDomain('audio');
    const l = audio.getOutputNode(sut, 'out_l');
    const r = audio.getOutputNode(sut, 'out_r');
    if (!l) throw new Error('twotracks `out_l` port has no audio node');
    if (!r) throw new Error('twotracks `out_r` port has no audio node');
    const ctx = l.node.context as AudioContext;

    // Reported (not asserted here) so a red run says WHICH failure it is:
    // "the jacks are the same edge" and "the module is silent" produce the
    // same zero difference and must be distinguishable from the output.
    const sameEdge = l.node === r.node && l.output === r.output;

    // out_l + (−1)·out_r, summed in the audio graph — sample-aligned, no
    // cross-thread sampling of either leg.
    const invert = ctx.createGain();
    invert.gain.value = -1;
    const diffSum = ctx.createGain();
    diffSum.gain.value = 1;
    l.node.connect(diffSum, l.output);
    r.node.connect(invert, r.output);
    invert.connect(diffSum);

    const diff = ctx.createAnalyser();
    diff.fftSize = 2048;
    diffSum.connect(diff);

    // LEFT on its own — the "is there any signal at all" control. Without it
    // a silent difference is indistinguishable from a silent module, and the
    // mono assertion would pass against a module producing nothing.
    const left = ctx.createAnalyser();
    left.fftSize = 2048;
    l.node.connect(left, l.output);

    w.__ttProbe = { diff, left, sameEdge };
  }, SUT);
}

/**
 * Accumulate peak |out_l − out_r| and peak |out_l| over `ms`, sampling INSIDE
 * the page on a timer finer than one analyser window. The accumulator
 * survives a main-thread stall, so a loaded runner reports every value it
 * managed to compute rather than "we never looked" — and it reports its own
 * sample count so a red run is diagnosable instead of a coin flip.
 */
async function measure(
  page: import('@playwright/test').Page,
  ms: number,
): Promise<{ diffPeak: number; leftPeak: number; samples: number; sameEdge: boolean }> {
  return page.evaluate(
    ({ ms }) =>
      new Promise<{ diffPeak: number; leftPeak: number; samples: number; sameEdge: boolean }>((resolve) => {
        const w = globalThis as unknown as {
          __ttProbe: { diff: AnalyserNode; left: AnalyserNode; sameEdge: boolean };
        };
        const p = w.__ttProbe;
        const dBuf = new Float32Array(p.diff.fftSize);
        const lBuf = new Float32Array(p.left.fftSize);
        let diffPeak = 0;
        let leftPeak = 0;
        let samples = 0;
        const peak = (b: Float32Array) => {
          let m = 0;
          for (let i = 0; i < b.length; i++) {
            const a = Math.abs(b[i]!);
            if (a > m) m = a;
          }
          return m;
        };
        const timer = setInterval(() => {
          p.diff.getFloatTimeDomainData(dBuf);
          p.left.getFloatTimeDomainData(lBuf);
          diffPeak = Math.max(diffPeak, peak(dBuf));
          leftPeak = Math.max(leftPeak, peak(lBuf));
          samples++;
        }, 10);
        setTimeout(() => {
          clearInterval(timer);
          resolve({ diffPeak, leftPeak, samples, sameEdge: p.sameEdge });
        }, ms);
      }),
    { ms },
  );
}

test.describe('twotracks — OUT L and OUT R are two separable jacks', () => {
  test('mono drive → jacks identical; stereo drive → jacks differ', async ({ page }) => {
    await page.goto('/rack?shell=legacy&seed=none');

    // ── LEG 1: MONO DRIVE. One noise output into reel A's LEFT input only.
    //    The worklet normals the unconnected right input to the left, so both
    //    channels carry the identical sample and the difference must be
    //    EXACTLY zero. This is the permanent negative control: it fails if
    //    the probe ever manufactures a difference of its own (a mis-wired
    //    inverter, an unaligned tap, two analysers instead of one).
    await spawnPatch(
      page,
      [
        { id: SRC, type: 'noise', params: { level: 0.8 } },
        // monitor: 1 = pass the live input through; no recording needed.
        { id: SUT, type: 'twotracks', params: { monitor: 1 } },
      ],
      [{ id: 'e1', from: { nodeId: SRC, portId: 'white' }, to: { nodeId: SUT, portId: 'audio_l_in_a' } }],
    );
    await installDiffProbe(page);

    const mono = await measure(page, 1500);

    expect(
      mono.leftPeak,
      `OUT L must actually be making sound on a mono drive, or every assertion here ` +
        `is vacuous (samples=${mono.samples}, sameEdge=${mono.sameEdge})`,
    ).toBeGreaterThan(0.001);
    expect(
      mono.diffPeak,
      `peak |OUT L − OUT R| on a MONO drive must be EXACTLY 0 — the worklet normals ` +
        `the unconnected right input to the left, so both jacks carry the same sample. ` +
        `A non-zero value here means the PROBE is manufacturing a difference ` +
        `(left=${mono.leftPeak.toFixed(4)}, samples=${mono.samples})`,
    ).toBe(0);

    // ── LEG 2: STEREO DRIVE. white → reel A LEFT, brown → reel A RIGHT.
    //    Two genuinely different signals from one noise source (brown is
    //    1/f², heavily low-passed against flat white), so the two channels
    //    cannot coincide. THIS is the assertion the bug fails: while both
    //    handles named `{ workletNode, output: 0 }` they were one edge, and
    //    out_l − out_r was exactly 0 regardless of what the module played.
    await spawnPatch(
      page,
      [
        { id: SRC, type: 'noise', params: { level: 0.8 } },
        { id: SUT, type: 'twotracks', params: { monitor: 1 } },
      ],
      [
        { id: 'e1', from: { nodeId: SRC, portId: 'white' }, to: { nodeId: SUT, portId: 'audio_l_in_a' } },
        { id: 'e2', from: { nodeId: SRC, portId: 'brown' }, to: { nodeId: SUT, portId: 'audio_r_in_a' } },
      ],
    );
    await installDiffProbe(page);

    const stereo = await measure(page, 1500);

    // Order matters: vacuity guard, then the AUDIBLE claim, then the structural
    // diagnosis. `sameEdge` is deliberately asserted LAST so a regression fails
    // on what a listener would notice — the jacks carrying identical audio —
    // rather than short-circuiting on graph shape and never measuring a sample.
    expect(
      stereo.leftPeak,
      `OUT L must still be making sound on the stereo drive (samples=${stereo.samples})`,
    ).toBeGreaterThan(0.001);
    expect(
      stereo.diffPeak,
      `peak |OUT L − OUT R| with DIFFERENT signals on the two reel-A inputs — this is ` +
        `the whole claim. Exactly 0 here means the two jacks are still one edge ` +
        `(left=${stereo.leftPeak.toFixed(4)}, samples=${stereo.samples}, ` +
        `sameEdge=${stereo.sameEdge})`,
    ).toBeGreaterThan(0.001);
    expect(
      stereo.sameEdge,
      'OUT L and OUT R must not resolve to the same node+output — one 2-channel bus ' +
        'behind both jacks down-mixes to (L+R)/2 at every mono destination',
    ).toBe(false);
  });
});
