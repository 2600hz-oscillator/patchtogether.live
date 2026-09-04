// e2e/tests/stereo-mono-normal.spec.ts
//
// A MONO SOURCE INTO A STEREO MODULE'S LEFT INPUT MUST NOT LEAVE ITS RIGHT
// OUTPUT AT DIGITAL SILENCE.
//
// ── WHAT SHIPPED ─────────────────────────────────────────────────────────
// Five modules declared a mono normal in their DSP (`inputs[1]?.[0] ??
// inputs[0]?.[0]`, cofefve even commenting "// R normals to L") and then
// defeated it in their FACTORY. Four pinned a 0-valued ConstantSource to
// worklet input 1 for "liveness" — a connected input is never absent, so
// Chrome handed the processor a permanently-silent channel and the `??` could
// never fall through. resofilter carries stereo on two CHANNELS of one input
// and set `channelInterpretation: 'discrete'`, whose up-mix ZERO-FILLS
// channel 1 for a mono source, with the same result by a different route.
//
// Measured OUT R peak for a mono source into L, before → after:
//   clouds 0.0000e+0 → 6.8858e-1 | shimmershine 0.0000e+0 → 4.4212e-1
//   charlottes-echos 0.0000e+0 → 8.5852e-1 | cofefve 0.0000e+0 → 9.3254e-1
//   resofilter 0.0000e+0 → 4.9990e-1
//
// ── WHY NO EXISTING LANE CAUGHT IT ───────────────────────────────────────
// The ART scenarios for all four pinned modules drive the DSP class DIRECTLY
// (`renderWorklet(new Proc(), { inputs: [input, null] })`, or a pure-TS core
// mirror) and never call `def.factory()` — charlottes-echos' ART actually
// EXERCISES the normal and passes, because the layer it tests was never
// broken. The per-port sweep measures through a SCOPE against a fixed floor
// and never compares a module's own L to its own R. So this spec is the only
// place the REAL factory, the REAL worklet and a REAL cable meet.
//
// The source-level counterpart is
// packages/web/src/lib/audio/mono-normal-not-defeated.test.ts, which stops a
// sixth module joining the class.
//
// ── THE INSTRUMENT ───────────────────────────────────────────────────────
// Both jacks are resolved through `getOutputNode(nodeId, portId)` — the same
// seam the patch engine uses to materialise a cable — so this measures what a
// user's cable receives, not an internal node. Sampling happens INSIDE the
// page on a timer finer than one analyser window: a Playwright-side poll loop
// would be one protocol round trip per sample on the same main thread as the
// audio graph it measures, and a stalled thread would report "silent" and
// "never looked" identically.
//
// Every module runs BOTH legs on EVERY execution, so the instrument is
// negative-controlled permanently rather than once at authoring time:
//   leg 1  nothing patched → OUT R silent  (a probe that manufactures signal,
//                                           or a self-oscillating module,
//                                           would make leg 2 vacuous)
//   leg 2  mono into L     → OUT R AUDIBLE (the claim; 0.0000 before the fix)

import { test, expect } from './_fixtures';
import { spawnPatch } from './_helpers';

const SUT = 'sut';
const SRC = 'src';

/** Below this, a jack is silence for our purposes (the defect read EXACTLY 0). */
const SILENT_MAX = 1e-5;
/** Above this, a jack is audibly making sound (matches the per-port sweep floor). */
const AUDIBLE_MIN = 0.005;
/** Sampling window per leg. */
const WINDOW_MS = 1500;

interface Sut {
  /** Registry type. */
  type: string;
  /** The LEFT audio input a mono source gets patched into. */
  inL: string;
  /** The two output jacks. */
  outL: string;
  outR: string;
  /** Why an unpatched R used to be silent — quoted in the failure message. */
  mechanism: string;
  /**
   * Params needed to OPEN the module's own signal path, applied to BOTH legs.
   *
   * This is not tuning. Some modules are *designed* to be silent at their
   * defaults, so without this the mono-normal claim is untestable rather than
   * false — the vacuity guard fires and the run reads as a regression in a
   * module that is behaving exactly as documented. Keep it to the minimum that
   * opens the path, and say WHY in a comment on the row.
   *
   * ⚠ It is applied to leg 1 as well, on purpose: the negative control must
   * hold in the SAME configuration the claim is made in. A param that opened
   * the path only for leg 2 would weaken the control to a different module.
   */
  openPath?: Record<string, number>;
}

const SUTS: readonly Sut[] = [
  { type: 'clouds',          inL: 'in_l',  outL: 'out_l', outR: 'out_r', mechanism: 'ConstantSource pinned to worklet input 1' },
  { type: 'shimmershine',    inL: 'in_l',  outL: 'out_l', outR: 'out_r', mechanism: 'ConstantSource pinned to worklet input 1' },
  { type: 'charlottesEchos', inL: 'L',     outL: 'L',     outR: 'R',     mechanism: 'ConstantSource pinned to worklet input 1' },
  { type: 'cofefve',         inL: 'inL',   outL: 'outL',  outR: 'outR',  mechanism: 'ConstantSource pinned to worklet input 1' },
  // resofilter's stereo is two CHANNELS of ONE input, so it has no in_r to
  // patch at all — the normal is the ONLY way its OUT R can ever speak.
  { type: 'resofilter',      inL: 'audio', outL: 'out_l', outR: 'out_r', mechanism: "channelInterpretation: 'discrete' zero-filling channel 1" },
  // stereovca was NEVER BROKEN, and that is precisely why it was missing. This
  // roster is hand-written, like the VRT FACES set, so a module absent from it
  // is unmeasured in every lane — and the SOURCE gate could not have prompted
  // anyone to add it either, because stereovca spells its normal through
  // intermediate consts (`const inR = inRRaw ?? inLBuf;`) and the gate's regex
  // only matched the literal `inputs[1]?.[0] ?? inputs[0]?.[0]` form. Two
  // independent blind spots lined up on one module.
  //
  // ⚠ stereovca NEEDS `offset: 1`, and the first version of this row omitted it
  // and went red on CI at the vacuity guard with L=0.0000e+0 EXACTLY. That
  // reading was CORRECT and the row was wrong. stereovca is a ring modulator:
  //
  //     stL = (strength_l ?? 0) + offset
  //     outL = in_l * stL * level
  //
  // With no strength CV patched and `offset` at its 0.0 default, stL is 0 and
  // the output is silence BY DESIGN — the module's own docs say so verbatim:
  // "At 0 an unpatched strength (0 V) mutes the channel; turn offset up toward
  // +1 to lift the floor so the channel stays open at unity even with no
  // modulator." So the sweep was asserting something the contract documents as
  // impossible. `offset: 1` gives stL = 1 and unity passthrough, which is the
  // ONLY configuration in which "does OUT R follow IN L?" is a real question.
  //
  // The negative control is unharmed: with offset lifted but NOTHING patched,
  // in_l is 0, so out = 0 * 1 * 1 = 0 and leg 1 still demands silence.
  //
  // Roster drift is now itself gated —
  // packages/web/src/lib/audio/mono-normal-not-defeated.test.ts requires every
  // normal-bearing module to appear here or carry a named exemption.
  { type: 'stereovca',       inL: 'in_l',  outL: 'out_l', outR: 'out_r', openPath: { offset: 1 }, mechanism: 'never defeated — the normal is spelled through intermediate consts, so the source gate could not see it' },
  // vstFx routes audio through the vst-bridge helper when connected, but with
  // no helper (CI, this sweep) its worklet LOCAL BYPASS carries in→out, and
  // the mono normal (`inputs[IN_R]?.[0] ?? inL`) applies to both paths — so
  // the bypass leg is what this row measures, and it needs no helper.
  { type: 'vstFx',           inL: 'in_l',  outL: 'out_l', outR: 'out_r', mechanism: 'worklet-local normal (inputs[IN_R] ?? inL) feeding both the bridge ring write and the not-connected local bypass' },
];

interface Probe { outL: AnalyserNode; outR: AnalyserNode; sameEdge: boolean }

/** Hang an analyser on each output PORT, via the cable-materialising seam. */
async function installProbe(page: import('@playwright/test').Page, sut: Sut): Promise<void> {
  // ⚠ WAIT FOR THE PORTS TO EXIST FIRST — this is a RACE, not a slow machine.
  // `spawnPatch` resolves when the graph is written; a WORKLET-backed module's
  // `AudioWorkletNode` only exists after its `addModule` promise settles, so
  // `getOutputNode` can legitimately return null for a few frames afterwards.
  // The probe below THROWS on null (`port has no audio node`), which reads as
  // a broken module rather than a probe that looked too early — and it is why
  // `vstFx` reddened a PR whose diff was entirely outside packages/web, and
  // why `charlottesEchos` recovered on retry twice in the #1847 census. Both
  // SUTs are worklet-backed; nothing else in SUTS is.
  //
  // This waits on OBSERVABLE STATE (the ports resolve), never a fixed delay,
  // and it cannot mask the defect it replaces: if a port never materialises
  // the wait times out and names which one, instead of throwing on frame one.
  await page.waitForFunction(
    ({ SUT, outL, outR }) => {
      const w = globalThis as unknown as {
        __engine?: () => {
          getDomain(d: string): {
            getOutputNode(nodeId: string, portId: string): { node: AudioNode; output: number } | null;
          };
        };
      };
      try {
        const audio = w.__engine?.().getDomain('audio');
        return !!audio?.getOutputNode(SUT, outL) && !!audio?.getOutputNode(SUT, outR);
      } catch {
        return false;
      }
    },
    { SUT, outL: sut.outL, outR: sut.outR },
    { timeout: 15_000 },
  );

  await page.evaluate(({ SUT, outL, outR }) => {
    const w = globalThis as unknown as {
      __engine: () => {
        getDomain(d: string): {
          getOutputNode(nodeId: string, portId: string): { node: AudioNode; output: number } | null;
        };
      };
      __mnProbe?: Probe;
    };
    const audio = w.__engine().getDomain('audio');
    const l = audio.getOutputNode(SUT, outL);
    const r = audio.getOutputNode(SUT, outR);
    if (!l) throw new Error(`\`${outL}\` port has no audio node`);
    if (!r) throw new Error(`\`${outR}\` port has no audio node`);
    const ctx = l.node.context as AudioContext;

    // Reported, not asserted: if both jacks were ONE edge, "R follows L" would
    // be trivially true for the wrong reason. That is a different defect
    // (twotracks-stereo.spec.ts owns it) and must be distinguishable here.
    const sameEdge = l.node === r.node && l.output === r.output;

    const mk = (ref: { node: AudioNode; output: number }) => {
      const a = ctx.createAnalyser();
      a.fftSize = 2048;
      ref.node.connect(a, ref.output);
      return a;
    };
    w.__mnProbe = { outL: mk(l), outR: mk(r), sameEdge };
  }, { SUT, outL: sut.outL, outR: sut.outR });
}

/**
 * Peak-hold both jacks over `ms`, accumulating IN the page. The accumulator
 * survives a main-thread stall, so a loaded runner reports every value it
 * managed to compute — and reports its own sample count, so "silent" and
 * "never sampled" are never confused for one another.
 */
async function measure(
  page: import('@playwright/test').Page,
  ms: number,
): Promise<{ lPeak: number; rPeak: number; samples: number; sameEdge: boolean }> {
  return page.evaluate(
    ({ ms }) =>
      new Promise<{ lPeak: number; rPeak: number; samples: number; sameEdge: boolean }>((resolve) => {
        const p = (globalThis as unknown as { __mnProbe: Probe }).__mnProbe;
        const lBuf = new Float32Array(p.outL.fftSize);
        const rBuf = new Float32Array(p.outR.fftSize);
        let lPeak = 0, rPeak = 0, samples = 0;
        const peak = (b: Float32Array) => {
          let m = 0;
          for (let i = 0; i < b.length; i++) { const a = Math.abs(b[i]!); if (a > m) m = a; }
          return m;
        };
        const timer = setInterval(() => {
          p.outL.getFloatTimeDomainData(lBuf);
          p.outR.getFloatTimeDomainData(rBuf);
          lPeak = Math.max(lPeak, peak(lBuf));
          rPeak = Math.max(rPeak, peak(rBuf));
          samples++;
        }, 10);
        setTimeout(() => { clearInterval(timer); resolve({ lPeak, rPeak, samples, sameEdge: p.sameEdge }); }, ms);
      }),
    { ms },
  );
}

test.describe('stereo modules: an unpatched R output follows L (mono normal)', () => {
  // ── ↩ UN-PARKED from FLAKE-PARK #1847 (2026-09-04) ────────────────────────
  // The park's stated condition was a ROOT CAUSE, and "it passes now" was
  // explicitly not one. The root cause is now found, and it was never in
  // charlottesEchos: `installProbe` read `getOutputNode` on the frame after
  // `spawnPatch`, and a WORKLET-backed module's node does not exist until its
  // `addModule` promise settles. The probe threw on null, which printed as
  // "`L` port has no audio node" — a broken module, not a probe that looked
  // too early.
  //
  // The corroboration is that it reached a SECOND subject: `vstFx` — the only
  // other worklet-backed SUT in this file — failed the same way on 2026-09-04
  // (run 33903601247) on a PR whose diff was entirely inside `apps/desktop/`,
  // a tree that lane never even loads. Two worklet SUTs, one seam, zero
  // non-worklet SUTs affected.
  //
  // `installProbe` now waits for both ports to resolve before reading them.
  // The assertion body below is UNCHANGED from the park.
  //
  // The park map and its `test.fixme` branch are DELETED rather than left empty:
  // an unreachable skip site is still a skip site to `e2e-skip-budget`, which is
  // deny-by-default and reds on any site no entry claims. Every SUT now runs.

  for (const sut of SUTS) {
    test(`${sut.type}: a MONO source into ${sut.inL} makes ${sut.outR} audible`, async ({ page }) => {
      // ── LEG 1: NOTHING PATCHED. The permanent negative control. If the probe
      //    manufactured signal of its own, or the module self-oscillated, leg 2
      //    would pass no matter what the factory did.
      await page.goto('/rack?shell=legacy&seed=none');
      await spawnPatch(page, [{ id: SUT, type: sut.type, ...(sut.openPath ? { params: sut.openPath } : {}) }]);
      await installProbe(page, sut);
      const idle = await measure(page, WINDOW_MS);

      expect(
        idle.samples,
        `${sut.type}: the probe never sampled — instrument failure, not a reading `
        + `(sameEdge=${idle.sameEdge})`,
      ).toBeGreaterThan(0);
      expect(
        idle.rPeak,
        `${sut.type}: with NOTHING patched, ${sut.outR} must be silent. A non-zero value here `
        + `means this probe manufactures signal, which would make the real assertion below `
        + `vacuous (L=${idle.lPeak.toExponential(4)}, R=${idle.rPeak.toExponential(4)}, `
        + `samples=${idle.samples})`,
      ).toBeLessThan(SILENT_MAX);

      // ── LEG 2: MONO SOURCE INTO L ONLY. `noise` declares no stereoPairs, so
      //    the stereo auto-wire correctly writes ONE edge — the exact patch the
      //    defect made half-silent. Nothing is connected to the R input, so the
      //    DSP's own normal is the only thing that can make OUT R speak.
      await page.goto('/rack?shell=legacy&seed=none');
      await spawnPatch(
        page,
        [
          { id: SRC, type: 'noise', params: { level: 0.8 } },
          { id: SUT, type: sut.type, ...(sut.openPath ? { params: sut.openPath } : {}) },
        ],
        [{ id: 'e1', from: { nodeId: SRC, portId: 'white' }, to: { nodeId: SUT, portId: sut.inL } }],
      );
      await installProbe(page, sut);
      const mono = await measure(page, WINDOW_MS);

      const vitals =
        `L=${mono.lPeak.toExponential(4)}, R=${mono.rPeak.toExponential(4)}, `
        + `samples=${mono.samples}, sameEdge=${mono.sameEdge}`;

      // Vacuity guard first: a silent module would pass any claim about R.
      expect(
        mono.lPeak,
        `${sut.type}: ${sut.outL} must be making sound at all, or the claim about `
        + `${sut.outR} is vacuous (${vitals})`,
      ).toBeGreaterThan(AUDIBLE_MIN);

      // THE CLAIM. Read exactly 0.0000e+0 before the fix, for all five modules.
      expect(
        mono.rPeak,
        `${sut.type}: a MONO source patched into ${sut.inL} alone must drive ${sut.outR} via the `
        + `DSP's mono normal. Digital silence here means the factory defeated that normal again `
        + `(${sut.mechanism}) and half of this module's output is dead for every mono patch `
        + `a user can build (${vitals})`,
      ).toBeGreaterThan(AUDIBLE_MIN);

      // Diagnosis LAST, so a regression fails on what a listener would notice
      // rather than short-circuiting on graph shape before measuring a sample.
      expect(
        mono.sameEdge,
        `${sut.type}: ${sut.outL} and ${sut.outR} must not resolve to the same node+output — `
        + `that would make "R follows L" true for the wrong reason (${vitals})`,
      ).toBe(false);
    });
  }
});
