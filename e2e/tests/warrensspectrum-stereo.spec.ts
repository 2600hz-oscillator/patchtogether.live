// e2e/tests/warrensspectrum-stereo.spec.ts
//
// WARREN'S SPECTRUM phase 2 — the STEREO claim, in a REAL AudioWorkletNode.
//
// ── WHY THIS SPEC HAS TO EXIST ────────────────────────────────────────────
// Phase 2's headline is that the module became stereo. Two things carry that
// claim and NEITHER can run under vitest:
//
//   1. `outputChannelCount: [2]` on the AudioWorkletNode. jsdom has no
//      AudioWorklet at all, so every unit gate in this repo is structurally
//      blind to whether the node actually produces two channels — the DSP
//      tests call `processSampleStereo` directly and would pass identically
//      against a node still declared mono.
//   2. The band table, which does NOT travel as AudioParams. It rides
//      `port.postMessage` and lives in `node.data`, so the only proof that
//      an edited band reaches the DSP is a real MessagePort round trip.
//      DX7 shipped exactly this bridge broken once (a Yjs proxy is not
//      structured-cloneable, so the worklet kept playing a stale patch while
//      the UI showed the new one) and nothing caught it for a release.
//
// A green unit lane plus a green per-port sweep would therefore report
// "stereo works" for a module that is mono in the browser. That is the
// green-but-silent shape this repo has been burned by (POLYHELM #674).
//
// ── THE MEASUREMENT: A DIFFERENCE NODE, NOT TWO ANALYSERS ─────────────────
// The obvious approach — an analyser on L, an analyser on R, compare their
// RMS — is a bad instrument twice over. It samples the two channels at
// DIFFERENT instants (two `getFloatTimeDomainData` calls), so realtime
// jitter alone makes them differ; and RMS is invariant to a pure
// left/right SWAP, so a channel-crossing bug reads as perfectly correct.
//
// Instead the graph itself computes L − R (a splitter, a gain of −1 on the
// right leg, summed into one analyser). That is SAMPLE-ALIGNED by
// construction and needs no tolerance at the mono end: if L and R carry the
// same signal the difference is not "small", it is EXACTLY zero. And it is
// not swap-invariant — a swap leaves a non-zero difference.
//
// Both directions are asserted on every run, so the instrument is
// negative-controlled permanently rather than once at authoring time:
// mono default → difference is silent; bands panned → difference is loud.

import { test, expect } from './_fixtures';
import { spawnPatch } from './_helpers';

const SUT = 'ws';
const SRC = 'src';

/** Installs the L−R difference probe on the module's `out` port and returns
 *  a page-side reader. Everything stays IN THE PAGE: a Playwright-side poll
 *  loop would be one protocol round trip per sample on the same main thread
 *  as the audio graph it is measuring. */
async function installDiffProbe(page: import('@playwright/test').Page): Promise<void> {
  await page.evaluate((sut) => {
    const w = globalThis as unknown as {
      // `__engine()` is the PatchEngine (the cross-domain dispatcher);
      // `getOutputNode` lives on the AudioEngine it routes to.
      __engine: () => {
        getDomain(domain: string): {
          getOutputNode(nodeId: string, portId: string): { node: AudioNode; output: number } | null;
        };
      };
      __wsProbe?: {
        channels: number;
        diff: AnalyserNode;
        left: AnalyserNode;
      };
    };
    const out = w.__engine().getDomain('audio').getOutputNode(sut, 'out');
    if (!out) throw new Error('warrensspectrum `out` port has no audio node');
    const ctx = out.node.context as AudioContext;

    const splitter = ctx.createChannelSplitter(2);
    out.node.connect(splitter, out.output);

    // L − R. `invert` is a plain gain of -1; summing both legs into one
    // analyser makes the subtraction happen in the audio graph, sample
    // aligned, with no cross-thread sampling at all.
    const invert = ctx.createGain();
    invert.gain.value = -1;
    const diffSum = ctx.createGain();
    diffSum.gain.value = 1;
    splitter.connect(diffSum, 0);
    splitter.connect(invert, 1);
    invert.connect(diffSum);

    const diff = ctx.createAnalyser();
    diff.fftSize = 2048;
    diffSum.connect(diff);

    // LEFT on its own — the "is there any signal at all" control. Without it
    // a silent difference is indistinguishable from a silent module, and the
    // mono assertion would pass against a module producing nothing.
    const left = ctx.createAnalyser();
    left.fftSize = 2048;
    splitter.connect(left, 0);

    w.__wsProbe = {
      channels: (out.node as AudioNode & { channelCount: number }).channelCount,
      diff,
      left,
    };
  }, SUT);
}

/**
 * Accumulate peak |L−R| and peak |L| over `ms`, sampling INSIDE the page on
 * a timer finer than one analyser window. The accumulator survives a main-
 * thread stall, so a loaded runner reports every value it managed to
 * compute rather than "we never looked" — and it reports its own sample
 * count so a red run is diagnosable instead of a coin flip.
 */
async function measure(
  page: import('@playwright/test').Page,
  ms: number,
): Promise<{ diffPeak: number; leftPeak: number; samples: number; channels: number }> {
  return page.evaluate(
    ({ ms }) =>
      new Promise<{ diffPeak: number; leftPeak: number; samples: number; channels: number }>((resolve) => {
        const w = globalThis as unknown as {
          __wsProbe: { channels: number; diff: AnalyserNode; left: AnalyserNode };
        };
        const p = w.__wsProbe;
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
          resolve({ diffPeak, leftPeak, samples, channels: p.channels });
        }, ms);
      }),
    { ms },
  );
}

test.describe("warren's spectrum — stereo comes from the filterbank (phase 2)", () => {
  test('mono at the DEFAULT, stereo once the bands are panned', async ({ page }) => {
    await page.goto('/rack?seed=none');

    // A noise source into `audio_in` — the module is an EFFECT and generates
    // nothing on its own, so an unpatched SUT would make every assertion
    // below vacuously true.
    await spawnPatch(
      page,
      [
        { id: SRC, type: 'noise', params: {} },
        { id: SUT, type: 'warrensspectrum', params: {} },
      ],
      [
        {
          id: 'e1',
          from: { nodeId: SRC, portId: 'white' },
          to: { nodeId: SUT, portId: 'audio_in' },
        },
      ],
    );

    await installDiffProbe(page);

    // ── LEG 1: the shipped default. BANK WET is 0, so the bank is out of
    //    circuit and both channels carry the identical mono resynth.
    const mono = await measure(page, 1500);

    expect(
      mono.channels,
      'the worklet output must present TWO channels even while it is carrying mono',
    ).toBe(2);
    expect(
      mono.leftPeak,
      `the module must actually be making sound, or every assertion here is vacuous ` +
        `(samples=${mono.samples})`,
    ).toBeGreaterThan(0.001);
    expect(
      mono.diffPeak,
      `peak |L-R| at the DEFAULT must be EXACTLY 0 — both channels are the same ` +
        `sample (left=${mono.leftPeak.toFixed(4)}, samples=${mono.samples})`,
    ).toBe(0);

    // ── LEG 2: open the bank and pan the bands apart. This drives the WHOLE
    //    phase-2 path — the `resynthLevel` AudioParam AND the postMessage
    //    band table — so a break in either shows up here.
    await page.evaluate((sut) => {
      const w = globalThis as unknown as {
        __patch: { nodes: Record<string, { params: Record<string, number>; data?: Record<string, unknown> }> };
        __ydoc: { transact: (fn: () => void) => void };
      };
      w.__ydoc.transact(() => {
        const n = w.__patch.nodes[sut]!;
        n.params.resynthLevel = 1;
        // Low four bands hard left, high four hard right.
        //
        // ⚠ `n.data = n.data ?? {}` is NOT equivalent and throws here:
        // syncedStore rejects "reassigning object that already occurs in the
        // tree". Only create the map when it is genuinely absent, then write
        // keys IN PLACE — the repo's standing Y.Doc rule.
        if (!n.data) n.data = {};
        n.data.wsBands = [60, 120, 250, 500, 1000, 2000, 4000, 8000].map((hz, i) => ({
          cutoffHz: hz,
          q: 0.7071,
          type: 0.5,
          pan: i < 4 ? -1 : 1,
          send: 1,
        }));
        n.data.wsBandsRev = Number(n.data.wsBandsRev ?? 0) + 1;
      });
    }, SUT);

    // The factory polls the revision every 120 ms and the WET smoother needs
    // ~70 ms to arrive; 1.5 s of accumulation is many multiples of both, and
    // the accumulator keeps the peak so a slow poll only delays it.
    const stereo = await measure(page, 1500);

    expect(
      stereo.leftPeak,
      `the bank must still pass audio (samples=${stereo.samples})`,
    ).toBeGreaterThan(0.001);
    expect(
      stereo.diffPeak,
      `peak |L-R| with the bands panned apart — this is the whole phase-2 claim, and ` +
        `it also proves the postMessage band table reached the worklet ` +
        `(left=${stereo.leftPeak.toFixed(4)}, samples=${stereo.samples})`,
    ).toBeGreaterThan(0.001);
  });
});
