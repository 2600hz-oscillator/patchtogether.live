// art/scenarios/mixmstrs/cv-path.test.ts
//
// DOES A CV CABLE ON A `paramTarget` INPUT CHANGE THE AUDIO?
//
// The gate owed by the #1661 defect class (`swolevco`: four declared CV inputs
// that were bit-exactly audio-inert because the factory published an AudioParam
// on a node whose output was connected to nothing). #1661 named this file's
// module as using the same vocabulary, unverified. It DID — for its eight
// `comp{N}` macros, and only for those; every other declared CV input was
// always live. FIXED in #1737, and this file now asserts the fixed behaviour
// where it used to characterize the defect: the sweep below covers EVERY
// declared paramTarget input with no filter, and the leg that used to name the
// comp macros as the uncertifiable set is now a permanent negative control that
// requires them to be BOTH structurally off-worklet AND audibly live.
//
// WHY NO EXISTING GATE SEES THIS (module-adversarial-audit.md step 3):
//  * `art/scenarios/mixmstrs/{profile,prefader-sends,passthrough}.test.ts` all
//    render through `renderFaustOffline`, which sets Faust UI params DIRECTLY on
//    the DSP. They never build the module's factory, so no publish-an-AudioParam
//    seam exists in them at all.
//  * `packages/web/src/lib/audio/modules/mixmstrs.test.ts` covers the pure
//    helpers (`mapCompMacro`, `rmsLevel`) — correct, and blind to the wiring.
//  * `per-module-per-port-behavioral.spec.ts` — the one registry-driven sweep
//    that drives real CV edges — carries a written EXEMPTION for mixmstrs
//    (spawn-count budget + per-channel-on-summed-mix), so it never ran here.
//  * `contract-lock` / `module-docs-lint` read the DECLARATION. The declaration
//    is right; the wiring is not. (Audit shape 1: contract vs value.)
//
// THE INSTRUMENT, AND WHAT IT IS INVARIANT TO. Two legs per input against one
// shared control render, peak |Δsample| (linear amplitude) over a settled
// window, maxed across masterL/R + send1L + send2L:
//   CV   — ConstantSource(delta) → `handle.inputs.get(id).param`, which is
//          EXACTLY what `AudioEngine.addEdge` connects (engine.ts:489).
//   KNOB — `handle.setParam(id, target)`, which is what the on-screen control
//          calls. Different code path; one can work while the other does not.
// A bit-exact zero is also what a broken instrument returns, so:
//   * the KNOB leg of every input is asserted to move — that is the positive
//     control on the METRIC, per input, on every run;
//   * `MECH` asserts ConstantSource(1) → GainNode.gain moves a render in this
//     same harness — the positive control on the MECHANISM;
//   * the live CV legs prove `cs.connect(<worklet AudioParam>)` modulates under
//     node-web-audio-api, so a zero elsewhere is not a harness artifact.
// ⚠ The metric is blind to a param on a channel that is INAUDIBLE in the base
// patch. The first pass muted ch8 (to give send1Pre authority) and every ch8
// row came back 0.0000e+0 on BOTH legs — a false null the per-input KNOB
// control caught immediately. `basePatch()` keeps every channel audible.
//
// NEGATIVE-CONTROLLED IN BOTH DIRECTIONS, by forcing `ch1_volume` broken in the
// factory two different ways and confirming which leg reddens each time:
//
//  A. published on a NON-worklet node (`{ node: deadGain, param: deadGain.gain }`)
//     → the OFF-WORKLET leg reddens (`ch1_volume` joins that set) and the
//       automation leg reddens (0.0000e+0 vs knob 1.6946e-1). ⚠ The CV sweep
//       used to stay green here, because the defect REMOVED its own subject
//       from the sweep's FILTER — which is why the sweep no longer has one.
//  B. kept ON the worklet node but pointed at a dead param
//     (`{ node: f, param: deadGain.gain }`) → the CV sweep reddens naming
//       `ch1_volume 0.8→0 0.0000e+0` while every other row prints a live value,
//       and the off-worklet leg correctly stays green.
//
// So an input cannot be made CV-dead without reddening at least one leg.
//
// AND THE FIX WAS NEGATIVE-CONTROLLED THE SAME WAY (#1737), each half alone:
//  C. restore the unconditional build-time `applyCompMacro` → the RELOAD leg
//     reddens with "engaged −9.624 dBFS RMS vs bypassed −9.624 dBFS RMS", and
//     the declared-defaults leg reddens showing thresh 0 / ratio 1.
//  D. restore wavesculpt's value-based analyser readiness test → the CV sweep
//     reddens naming comp1..comp8 at 0.0000e+0 while all 83 other rows print a
//     live value.
//
// Every driver here is deterministic and nothing is pinned, so this scenario
// needs no baseline and no `.sha` — it is an assertion scenario like
// prefader-sends.test.ts.

import { describe, expect, it } from 'vitest';
import { OfflineAudioContext } from 'node-web-audio-api';
import { mixmstrsDef, MIXMSTRS_CHANNELS, MIXMSTRS_RETURNS, mapCompMacro } from '$lib/audio/modules/mixmstrs';

const SR = 48000;
const DUR_S = 0.25;
const N = Math.round(SR * DUR_S);
const SETTLE = Math.round(0.15 * SR); // past the si.smoo ramp-in on faders/flags

const OUTS = ['masterL', 'masterR', 'send1L', 'send2L'] as const;
const AUDIO_IN = [
  ...MIXMSTRS_CHANNELS.flatMap((c) => [`ch${c}L`, `ch${c}R`]),
  ...MIXMSTRS_RETURNS.flatMap((r) => [`ret${r}L`, `ret${r}R`]),
];

/** Every strip audible and every flag consequential, so no row can read zero
 *  merely because the base patch gave that control nothing to act on. */
function basePatch(): Record<string, number> {
  const p: Record<string, number> = { master_volume: 0.8, send1Pre: 0, send2Pre: 0 };
  for (const c of MIXMSTRS_CHANNELS) {
    // A fader at 0.8 (not 1) is what gives send1Pre/send2Pre authority: the PRE
    // tap sits at unity, the POST tap at 0.8. Muting a channel to make the point
    // instead would blind every other control on that channel — see the header.
    p[`ch${c}_volume`] = 0.8;
    p[`ch${c}_low`] = 0; p[`ch${c}_mid`] = 0; p[`ch${c}_high`] = 0;
    p[`ch${c}_thresh`] = -12; p[`ch${c}_ratio`] = 2; p[`ch${c}_compEnable`] = 1;
    p[`comp${c}`] = 0.5; // ⚠ applied LAST at construction; overwrites the three above
    p[`ch${c}_send1`] = 0.5;
    p[`ch${c}_send2`] = 0.5;
  }
  for (const r of MIXMSTRS_RETURNS) {
    p[`ret${r}_volume`] = 1; p[`ret${r}_low`] = 0; p[`ret${r}_mid`] = 0; p[`ret${r}_high`] = 0;
  }
  return p;
}

/** The far end of each control's travel from its base — chosen for audibility,
 *  not for prettiness, so a live control cannot read zero by coincidence. */
function perturbTarget(id: string): number {
  if (id === 'master_volume') return 0;
  if (id === 'send1Pre' || id === 'send2Pre') return 1;
  if (/^ret\d_volume$/.test(id)) return 0;
  if (/^ret\d_(low|mid|high)$/.test(id)) return 12;
  if (/^comp\d$/.test(id)) return 0;
  if (/^ch\d_volume$/.test(id)) return 0;
  if (/^ch\d_(low|mid|high)$/.test(id)) return 12;
  if (/^ch\d_thresh$/.test(id)) return -36;
  if (/^ch\d_ratio$/.test(id)) return 10;
  if (/^ch\d_compEnable$/.test(id)) return 0;
  if (/^ch\d_send[12]$/.test(id)) return 1;
  throw new Error(`cv-path: no perturbation declared for '${id}' — a new param needs one`);
}

/** Where the param ACTUALLY sits after construction. `basePatch()` is not the
 *  truth for the compressor triple: the comp macro is applied last and
 *  overwrites thresh/ratio/compEnable, so the CV delta must be measured from
 *  the macro's values or the leg silently tests the wrong displacement. */
function effectiveBase(id: string, base: Record<string, number>): number {
  const m = /^ch(\d)_(thresh|ratio|compEnable)$/.exec(id);
  if (!m) return base[id]!;
  const comp = base[`comp${m[1]}`] ?? 0;
  if (m[2] === 'compEnable') return comp === 0 ? 0 : 1;
  if (m[2] === 'thresh') return comp === 0 ? 0 : -20 * comp;
  return comp === 0 ? 1 : 1 + 3 * comp;
}

type Leg =
  | { kind: 'none' }
  | { kind: 'cv'; id: string; delta: number }
  | { kind: 'knob'; id: string; value: number }
  /** EXACTLY the branch `AudioEngine.scheduleParam` (engine.ts:700) and
   *  `holdParam` (:754) take: when `inputs.get(id).param` exists they write the
   *  AudioParam and NEVER call `setParam`. So a dead published param makes clip
   *  automation of that control inert too. */
  | { kind: 'automation'; id: string; value: number };

interface Render { chans: Float32Array[]; offWorkletHosts: string[]; pumped: boolean }

/**
 * WHERE THE COMP-MACRO PUMP RUNS, AND WHY THERE IS EXACTLY ONE OF THEM.
 *
 * #1737: the comp{N} shadow must be pumped DETERMINISTICALLY during the offline
 * render. The factory's live path is a wall-clock `setInterval`, which an
 * offline render outruns nondeterministically; `read('pumpCompMacros')` is the
 * factory's own seam for exactly this. 50 ms is past the shadow's readiness
 * gate (`COMP_SHADOW_READY_S`, 2 render quanta ≈ 5.3 ms) and well before the
 * SETTLE window opens at 150 ms, so an applied CV change is fully settled where
 * `peakDelta` measures. The CV under test is a `ConstantSource`, so the value
 * the pump reads never changes — the pump's own change detector (`> 1e-6`)
 * makes every LATER pump a no-op. This used to schedule four (0.05/0.10/0.15/
 * 0.20); three of them could never do anything, and each one cost a throw of
 * the dice described below.
 *
 * ⚠ `OfflineAudioContext.suspend()` IS RACY BY CONSTRUCTION IN THE PINNED
 * BINDING, AND THE RACE IS WHAT MADE THE ART LANE GO RED ON A GREEN RUN.
 * node-web-audio-api generates `suspend` as `#[napi(catch_unwind)] pub async
 * fn`, so the call only SPAWNS the Rust future on napi's multi-threaded tokio
 * runtime — the registration inside it (`self.renderer.lock()` →
 * `suspend_promises.insert(...)`) happens later, on a worker thread. Nothing
 * orders that against `startRendering()`, whose future does
 * `self.renderer.lock().take()`. When `startRendering` wins, the suspend future
 * panics; `catch_unwind` reports it as `Error: Panic in async function
 * { code: 'GenericFailure' }`, which is what `js/lib/errors.js` prints as
 * "Unexpected Rust error". Measured against the pinned 1.0.9 binding on this
 * machine: ~4-18 panics per 12 000 suspend calls issued in the same turn as
 * `startRendering()`, and 0 per 8 000 when the registration is given a real
 * head start. `resume()` and `startRendering()` never failed once across
 * ~30 000 calls, so `suspend()` is the whole of it. Upstream 2.2.0 has the
 * identical shape, so there is no version to move to.
 *
 * So the seam is registered FIRST — before `mixmstrsDef.factory()`, whose
 * `addModule` + wasm instantiation is a real awaited gap orders of magnitude
 * wider than the race window — and its promise is AWAITED rather than floated.
 * ⚠ THE FLOATING WAS THE EXPENSIVE HALF: `void ctx.suspend(t).then(…)` turned a
 * rare binding panic into an UNHANDLED REJECTION, which vitest counts as
 * "Errors 1" and npm turns into exit 1 — reddening a run that reported
 * `145 passed (145)` / `961 passed (961)` with no failing assertion to point
 * at. Awaiting it means a lost race fails the ONE test that depends on the
 * pump, by name.
 */
const PUMP_AT_S = 0.05;

async function render(base: Record<string, number>, leg: Leg): Promise<Render> {
  const ctx = new OfflineAudioContext({ numberOfChannels: OUTS.length, length: N, sampleRate: SR });

  // ⚠ THE PUMP SEAM IS REGISTERED HERE — FIRST, BEFORE THE FACTORY BUILD — AND
  // IT IS AWAITED, NOT FLOATED. Both halves are load-bearing; see PUMP_AT_S.
  const handleRef: { h?: Awaited<ReturnType<typeof mixmstrsDef.factory>> } = {};
  let pumped = false;
  let pumpError: Error | undefined;
  // ⚠ `pump` MUST NEVER REJECT, and that is not style — it is the whole defect.
  // The rejection lands WHILE `startRendering()` is still being awaited, many
  // ticks before anything could `await` this promise, and Node fires
  // `unhandledRejection` the moment the microtask queue drains with no handler
  // attached. Rethrowing from the rejection handler here would re-arm exactly
  // the failure this file is fixing. So both settlements are captured into
  // `pumpError` and re-thrown below, on the awaiting side, where the failure
  // belongs to a test.
  const pump = ctx.suspend(PUMP_AT_S).then(
    async () => {
      try {
        pumped = handleRef.h?.read?.('pumpCompMacros') === true;
        await ctx.resume();
      } catch (err) {
        pumpError = new Error(
          `cv-path: the comp-macro pump seam threw after its suspend point resolved: ` +
            `"${(err as Error)?.message}".`,
        );
      }
    },
    (err: Error) => {
      pumpError = new Error(
        `cv-path: the comp-macro pump seam never ran — ctx.suspend(${PUMP_AT_S}) rejected ` +
          `with "${err?.message}" instead of resolving at its render quantum. The comp{N} rows ` +
          `of this file's CV sweep depend on it, so the render below is NOT measurable. ` +
          `This is the node-web-audio-api suspend-registration race (see PUMP_AT_S).`,
      );
    },
  );

  const node = { id: 'cv-path', type: 'mixmstrs', position: { x: 0, y: 0 }, params: base } as never;
  const handle = await mixmstrsDef.factory(ctx as unknown as AudioContext, node);
  handleRef.h = handle;

  AUDIO_IN.forEach((id, i) => {
    const ref = handle.inputs.get(id)!;
    const osc = ctx.createOscillator();
    osc.type = 'sawtooth';
    osc.frequency.value = 110 + i * 37; // mutually inharmonic, so no two strips cancel
    const g = ctx.createGain();
    g.gain.value = 0.35;
    osc.connect(g);
    g.connect(ref.node, 0, ref.input);
    osc.start(0);
  });

  // DERIVED, not typed: which paramTarget inputs publish their AudioParam on a
  // node that is NOT the DSP worklet. That is the shape of the #1661 defect —
  // a param on a side node whose output reaches no declared output port.
  // Duck-typed on `.parameters` (the AudioParamMap every AudioWorkletNode has
  // and a GainNode does not) rather than `instanceof`, so it does not depend on
  // which realm installed the AudioWorkletNode global.
  const offWorkletHosts: string[] = [];
  for (const p of mixmstrsDef.inputs) {
    if (!p.paramTarget) continue;
    const ref = handle.inputs.get(p.id);
    if (ref?.param && !('parameters' in ref.node)) offWorkletHosts.push(p.id);
  }

  if (leg.kind === 'cv') {
    const ref = handle.inputs.get(leg.id);
    if (!ref) throw new Error(`cv-path: no input port '${leg.id}'`);
    if (!ref.param) throw new Error(`cv-path: input '${leg.id}' publishes no AudioParam`);
    const cs = ctx.createConstantSource();
    cs.offset.value = leg.delta;
    cs.connect(ref.param);
    cs.start(0);
  } else if (leg.kind === 'knob') {
    handle.setParam(leg.id, leg.value);
  } else if (leg.kind === 'automation') {
    const param = handle.inputs.get(leg.id)?.param;
    if (param) param.setValueAtTime(leg.value, 0);
    else handle.setParam(leg.id, leg.value);
  }

  const merger = ctx.createChannelMerger(OUTS.length);
  OUTS.forEach((id, k) => {
    const ref = handle.outputs.get(id)!;
    ref.node.connect(merger, ref.output, k);
  });
  merger.connect(ctx.destination);
  const buf = await ctx.startRendering();
  // Surfaces a lost suspend-registration race as an ATTRIBUTED failure of the
  // test that depends on it, instead of an unhandled rejection with no owner.
  await pump;
  if (pumpError) throw pumpError;
  return { chans: OUTS.map((_, k) => buf.getChannelData(k).slice()), offWorkletHosts, pumped };
}

/** Peak |Δsample| in LINEAR AMPLITUDE over the settled window, across every
 *  captured output. Units matter: this is not dB and not RMS. */
function peakDelta(a: Render, b: Render): number {
  let peak = 0;
  for (let k = 0; k < a.chans.length; k++) {
    const x = a.chans[k]!, y = b.chans[k]!;
    for (let i = SETTLE; i < N; i++) peak = Math.max(peak, Math.abs(x[i]! - y[i]!));
  }
  return peak;
}

const fmt = (v: number) => (v === 0 ? '0.0000e+0' : v.toExponential(4));
const ALL_PARAM_INPUT_IDS = mixmstrsDef.inputs.filter((p) => p.paramTarget).map((p) => p.id);

/**
 * The CLIP-RECORD controls, whose consumer is JAVASCRIPT rather than the mix.
 *
 * ⚠ A NARROWING OF THE SUBJECT, NOT A TOLERANCE — and the difference is the
 * whole point. The two sweeps below ask "does a cable on this port change the
 * AUDIO". For `ch{N}_rec`, `recTap` and `recQuality` the honest answer is NO
 * and always will be: they select what a RECORDER captures, and a recorder that
 * altered the mix while arming would be a defect. `ch{N}_mon` WILL move audio
 * eventually — its duck attenuates the live branch — but only while a launcher
 * lane is PLAYING, and nothing publishes a lane-playing edge until the return
 * is wired in a later slice, so today it is inert by construction.
 *
 * ⚠ SO THEY ARE NOT DROPPED, THEY ARE RE-POINTED. Excluding a port from the one
 * sweep that proves it live would re-open exactly the #1734 hole this file
 * exists to close. The `recState` leg below drives every id in this set through
 * the CV path and requires each to move the module's OWN observable — so the
 * gate's intent ("no declared CV input is dead") holds for all of them,
 * measured against the right instrument instead of the wrong one.
 */
const JS_CONSUMED_INPUT_IDS: readonly string[] = [
  ...MIXMSTRS_CHANNELS.map((c) => `ch${c}_rec`),
  ...MIXMSTRS_CHANNELS.map((c) => `ch${c}_mon`),
  'recTap',
  'recQuality',
];

/** The ports the AUDIO sweeps cover. */
const PARAM_INPUT_IDS = ALL_PARAM_INPUT_IDS.filter((id) => !JS_CONSUMED_INPUT_IDS.includes(id));

/** Each sweep leg builds and renders the REAL Faust factory once PER INPUT — a
 *  fresh OfflineAudioContext, worklet and wasm instantiation included. Measured
 *  ~15 s per sweep on an idle box, which sits close enough to the ART default of
 *  30 s that a loaded runner turns a correct measurement into a timeout: an
 *  otherwise-green run of this file reported five `Test timed out in 30000ms`
 *  while the same two scenarios passed in 1415 ms each in isolation (a 432×
 *  slowdown, no assertion failures). The cost is inherent to driving the shipped
 *  DSP rather than a mirror, so it is DECLARED here instead of being bought back
 *  by shortening the renders — a wall-clock cap that bounds the failure, never
 *  the gate. */
const SWEEP_TIMEOUT_MS = 300_000;

describe('ART mixmstrs / CV path — a cable on a paramTarget input must change the audio', () => {
  it('MECH control — ConstantSource(1) → GainNode.gain modulates in THIS harness', async () => {
    const run = async (withCv: boolean) => {
      const ctx = new OfflineAudioContext({ numberOfChannels: 1, length: N, sampleRate: SR });
      const osc = ctx.createOscillator();
      osc.frequency.value = 220;
      const g = ctx.createGain();
      g.gain.value = 0.25;
      osc.connect(g);
      g.connect(ctx.destination);
      osc.start(0);
      if (withCv) {
        const cs = ctx.createConstantSource();
        cs.offset.value = 1;
        cs.connect(g.gain);
        cs.start(0);
      }
      const d = (await ctx.startRendering()).getChannelData(0);
      let peak = 0;
      for (let i = SETTLE; i < N; i++) peak = Math.max(peak, Math.abs(d[i]!));
      return peak;
    };
    const off = await run(false);
    const on = await run(true);
    // Without this leg, "the cable never connected" and "the cable connected to
    // nothing" are indistinguishable from a bit-exact zero below.
    expect(on, `CS(1)→gain must modulate: ${off.toFixed(9)} → ${on.toFixed(9)} (linear peak)`)
      .toBeGreaterThan(off * 2);
  });

  it('SEAM control — the comp-macro pump actually RAN inside the render', async () => {
    // The positive control on the mechanism `PUMP_AT_S` documents. Every comp{N}
    // row of the CV sweep below is only measurable because `ctx.suspend()`
    // resolved mid-render and `read('pumpCompMacros')` was answered by the live
    // factory. Both halves can fail silently and INDEPENDENTLY of each other:
    // the suspend can lose its registration race in the binding, and the `read`
    // seam can be renamed or dropped by a factory refactor — in which case
    // `read()` returns undefined and the pump never fires while every other
    // assertion here still has something to measure. This leg reads the seam's
    // own acknowledgement, so neither failure can present as a green run.
    const ctrl = await render(basePatch(), { kind: 'none' });
    expect(ctrl.pumped, `read('pumpCompMacros') must be answered at the t=${PUMP_AT_S}s suspend point`).toBe(true);
  }, SWEEP_TIMEOUT_MS);

  it('every declared paramTarget input moves the audio through the KNOB path', async () => {
    const base = basePatch();
    const ctrl = await render(base, { kind: 'none' });
    // Carried into BOTH sweeps, not just the SEAM leg above: these two tests are
    // where the CI panics actually landed (one in each), and the single suspend
    // point they now share is the thing that has to have run for either sweep's
    // control render to mean anything.
    expect(ctrl.pumped, 'the comp-macro pump must have run in this sweep\'s control render').toBe(true);
    const dead: string[] = [];
    for (const id of PARAM_INPUT_IDS) {
      const d = peakDelta(await render(base, { kind: 'knob', id, value: perturbTarget(id) }), ctrl);
      if (d === 0) dead.push(`${id} (→ ${perturbTarget(id)})`);
    }
    // This is BOTH a real assertion (no control may be inert from its own knob)
    // and the per-input positive control for the CV sweep below: a row that
    // reads zero on both legs is the metric being blind, not a dead cable.
    expect(dead, 'controls inert from their own knob — peak |Δsample| linear = 0').toEqual([]);
  }, SWEEP_TIMEOUT_MS);

  it('EVERY declared paramTarget input moves the audio through the CV path — comp macros included (#1737)', async () => {
    // The off-worklet carve-out is RETIRED: the comp shadow is read back and
    // pumped (see mixmstrs.ts), so comp{N} joins the same sweep as everything
    // else. The old SCOPE leg's own text mandated its deletion with the fix.
    const base = basePatch();
    const ctrl = await render(base, { kind: 'none' });
    // See the KNOB sweep: the comp{N} rows below are ONLY measurable because
    // this ran, so it is asserted here too rather than once, elsewhere.
    expect(ctrl.pumped, 'the comp-macro pump must have run in this sweep\'s control render').toBe(true);
    const dead: string[] = [];
    const table: string[] = [];
    for (const id of PARAM_INPUT_IDS) {
      const target = perturbTarget(id);
      const d = peakDelta(await render(base, { kind: 'cv', id, delta: target - effectiveBase(id, base) }), ctrl);
      table.push(`${id} ${effectiveBase(id, base)}→${target} ${fmt(d)}`);
      if (d === 0) dead.push(id);
    }
    expect(dead, `CV cable inert (linear peak |Δsample| = 0) on: ${table.join(' | ')}`).toEqual([]);
  }, SWEEP_TIMEOUT_MS);

  it('PERMANENT NEGATIVE CONTROL — the comp macros are STILL off-worklet hosts, and their CV is live anyway (#1737)', async () => {
    // Both halves derived, neither hand-typed. The STRUCTURE is unchanged (the
    // macro publishes on a GainNode, not the DSP worklet — same predicate the
    // old carve-out used), so if the CV sweep above ever goes green by the
    // comp rows silently LEAVING the population (an inputs-map refactor
    // dropping paramTarget, say), this leg still reddens: it asserts the
    // off-worklet set is exactly the comp macros AND that one comp CV cable
    // audibly moves the mix on its own.
    const base = basePatch();
    const ctrl = await render(base, { kind: 'none' });
    expect(
      ctrl.offWorkletHosts.slice().sort(),
      'paramTarget inputs published on a non-DSP node (structure, not liveness)',
    ).toEqual(
      // The comp macros, plus the clip-record controls — which are off-worklet
      // for the same reason and by the same rig (a shadow GainNode fed DC 1,
      // read back through a passive analyser). Derived from the same lists the
      // def builds them from, so a rename moves both sides together.
      [...MIXMSTRS_CHANNELS.map((c) => `comp${c}`), ...JS_CONSUMED_INPUT_IDS].sort(),
    );
    const d = peakDelta(
      await render(base, { kind: 'cv', id: 'comp1', delta: 0 - effectiveBase('comp1', base) }),
      ctrl,
    );
    expect(d, `comp1 CV cable must audibly move the mix (linear peak |Δsample|): ${fmt(d)}`).toBeGreaterThan(0);
  }, SWEEP_TIMEOUT_MS);

  it('CLIP AUTOMATION reaches the same terminal a CV cable does — comp macros included (#1737)', async () => {
    // ⚠ THE TITLE IS THE ASSERTION, so it changed with the fix. This leg used to
    // read "a dead published param also makes CLIP AUTOMATION of that control
    // inert" — a characterization of the defect, green BECAUSE comp1 was dead.
    // engine.ts:700 / :754 prefer `inputs[id].param` over `setParam`, so
    // automation was never a second bug: it is the same terminal reached by
    // another writer, and it went live the moment that terminal did.
    // `ch1_volume` is the positive control: same branch, always-live param.
    const base = basePatch();
    const ctrl = await render(base, { kind: 'none' });
    const auto = async (id: string, v: number) =>
      peakDelta(await render(base, { kind: 'automation', id, value: v }), ctrl);
    const knob = async (id: string, v: number) =>
      peakDelta(await render(base, { kind: 'knob', id, value: v }), ctrl);

    const liveAuto = await auto('ch1_volume', 0);
    const liveKnob = await knob('ch1_volume', 0);
    expect(liveAuto, `automation must reach a LIVE param: ${fmt(liveAuto)} vs knob ${fmt(liveKnob)}`)
      .toBeGreaterThan(0);
    expect(liveAuto, 'automation and knob agree on a live param').toBeCloseTo(liveKnob, 6);

    // #1737: the same engine branch on the FORMERLY dead terminal — clip
    // automation of comp1 writes g.gain, the pump picks it up, the mix moves.
    const compAuto = await auto('comp1', 0);
    expect(compAuto, `clip automation of comp1 must be audible: ${fmt(compAuto)}`).toBeGreaterThan(0);
  }, SWEEP_TIMEOUT_MS);
});

// ── #1737 (3): the macro must not clobber what the rack saved ─────────────────
//
// ⚠ THE OBVIOUS INSTRUMENT HERE IS BROKEN, AND ITS FAILURE MODE IS A GREEN RUN.
//
// The natural way to write this is: build the factory against a saved params
// snapshot and read `handle.readParam('ch1_thresh')` straight back. That is a
// SNAPSHOT OF AN AudioParam THAT NOTHING HAS RENDERED. `AudioParam.value` is
// the [[current value]], updated at RENDER QUANTUM boundaries — on a fresh
// `OfflineAudioContext` no quantum has run, so every `setValueAtTime` the
// factory just issued is still queued and `.value` reports the param's
// DECLARED DEFAULT. Measured on this module, same handle, three sample points:
//
//   before startRendering   ch1_thresh −12   ch1_ratio 2   ch1_compEnable 0
//   at ctx.suspend(0.1)     ch1_thresh −30   ch1_ratio 8   ch1_compEnable 1
//   after startRendering    ch1_thresh −30   ch1_ratio 8   ch1_compEnable 1
//
// So the pre-render read is invariant to the entire defect: it returns −12/2/0
// whether the macro clobbered the saved triple or not. The "fresh spawn holds
// its declared defaults" leg PASSED against that instrument — and would have
// passed just as happily with the bug still in, because −12 is what the reader
// returns when it is reading nothing at all. Exactly the CLAUDE.md shape: a
// gate whose precondition (no quantum has rendered) makes its subject
// unobservable, reporting the right number for the wrong reason.
//
// Both halves below therefore read a RENDERED observable:
//   * the AUDIBLE half is dBFS RMS of the real master output over a settled
//     window — the units #1737 states its defect in (+29.17 dB);
//   * the READBACK half samples `readParam` AFTER `startRendering()` resolves,
//     i.e. at a real render instant. The table above measured that read and the
//     `ctx.suspend()` one as identical, so this half keeps its subject while
//     dropping a `suspend()` call — see PUMP_AT_S for why those are not free.
describe('ART mixmstrs / #1737 — the macro must not clobber what the rack saved', () => {
  /** How far below the bypassed level an ENGAGED compressor must pull the
   *  master before this scenario believes it. A POLICY THRESHOLD on a derived
   *  measurement, not a count: the real separation measured on the shipped wasm
   *  is ~23.8 dB, so 6 dB is a wide margin that still cannot be reached by
   *  rounding, dither or a fader nudge. */
  const COMP_ENGAGED_MIN_DB = 6;

  /** Reload a rack: build the SHIPPED factory against a saved params snapshot,
   *  drive ch1 with a loud inharmonic source, render, and report BOTH
   *  observables — master dBFS RMS over the settled tail, and the compressor
   *  triple as read at a real render instant. */
  async function reload(params: Record<string, number>): Promise<{
    rmsDb: number;
    live: Record<string, number | undefined>;
  }> {
    const ctx = new OfflineAudioContext({ numberOfChannels: 1, length: N, sampleRate: SR });
    const node = { id: 'reload', type: 'mixmstrs', position: { x: 0, y: 0 }, params } as never;
    const h = await mixmstrsDef.factory(ctx as unknown as AudioContext, node);

    const out = h.outputs.get('masterL')!;
    out.node.connect(ctx.destination, out.output);
    const inRef = h.inputs.get('ch1L')!;
    const osc = ctx.createOscillator();
    osc.type = 'sawtooth';
    osc.frequency.value = 220;
    const g = ctx.createGain();
    g.gain.value = 0.9; // hot enough that a −30 dB threshold is genuinely crossed
    osc.connect(g);
    g.connect(inRef.node, 0, inRef.input);
    osc.start(0);

    const d = (await ctx.startRendering()).getChannelData(0);
    // Read the params at a RENDERED instant — AFTER the render, not at a
    // `ctx.suspend()` point inside it. The header's own measured table has the
    // post-render read returning exactly what the mid-render read returned
    // (−30 / 8 / 1) while the PRE-render read returns the declared defaults for
    // the wrong reason, so the observable is unchanged and this leg is still
    // NOT invariant to the defect. What it drops is one more throw of the
    // `suspend()` registration dice documented on PUMP_AT_S — this graph has no
    // comp CV and no pump, so its params are written once at build and simply
    // stand.
    const live: Record<string, number | undefined> = {};
    for (const id of ['ch1_thresh', 'ch1_ratio', 'ch1_compEnable']) live[id] = h.readParam?.(id);
    let sum = 0;
    for (let i = SETTLE; i < N; i++) sum += d[i]! * d[i]!;
    const rms = Math.sqrt(sum / (N - SETTLE));
    return { rmsDb: 20 * Math.log10(rms > 0 ? rms : Number.MIN_VALUE), live };
  }

  const dB = (v: number) => `${v.toFixed(3)} dBFS RMS`;
  /** A rack saved BEFORE the comp macro existed: the manual triple, no comp{N}
   *  key at all. That absence is what made the default 0 reach applyCompMacro. */
  const PRE_MACRO_RACK: Record<string, number> = { ch1_thresh: -30, ch1_ratio: 8, ch1_compEnable: 1 };

  it('a pre-macro rack RELOADS COMPRESSED — not +29 dB louder and bypassed', async () => {
    // The three renders are the assertion AND its own controls:
    //   engaged  — the saved rack, exactly as a pre-macro save comes back;
    //   bypassed — the same triple with the compressor explicitly OFF, which is
    //              precisely the state mapCompMacro(0) used to force;
    //   fresh    — a spawn with no compressor params at all.
    // `bypassed === fresh` is the instrument's positive control: it proves this
    // window can see the compressor's ENABLE flag, so the gap below is a real
    // gain reduction and not the harness measuring two arbitrary numbers.
    const engaged = await reload(PRE_MACRO_RACK);
    const bypassed = await reload({ ...PRE_MACRO_RACK, ch1_compEnable: 0 });
    const fresh = await reload({});

    expect(
      bypassed.rmsDb,
      `CONTROL — an explicitly bypassed compressor must sit at the no-compressor level: ${dB(bypassed.rmsDb)} vs fresh ${dB(fresh.rmsDb)}`,
    ).toBeCloseTo(fresh.rmsDb, 6);

    expect(
      engaged.rmsDb,
      `a rack saved with thresh ${PRE_MACRO_RACK.ch1_thresh} / ratio ${PRE_MACRO_RACK.ch1_ratio} / enable on must RELOAD compressed: ` +
        `${dB(engaged.rmsDb)} vs bypassed ${dB(bypassed.rmsDb)} — required at least ${COMP_ENGAGED_MIN_DB} dB below`,
    ).toBeLessThan(bypassed.rmsDb - COMP_ENGAGED_MIN_DB);

    // The readback half of the same defect, at a rendered instant: the card
    // reads node.params while readLive reads the Faust param, and #1737's third
    // consequence is that those two disagree silently after a reload.
    expect(engaged.live, 'the LIVE Faust triple at a rendered instant must equal what the rack saved').toEqual({
      ch1_thresh: PRE_MACRO_RACK.ch1_thresh,
      ch1_ratio: PRE_MACRO_RACK.ch1_ratio,
      ch1_compEnable: PRE_MACRO_RACK.ch1_compEnable,
    });
  }, SWEEP_TIMEOUT_MS);

  it('a rack that SAVED a macro value still gets it applied — the macro path is not weakened', async () => {
    // Skipping the build-time apply must not turn the macro off for racks that
    // legitimately carry one. comp1 = 1 is mapCompMacro's strongest setting.
    const m = mapCompMacro(1);
    const macro = await reload({ comp1: 1 });
    const fresh = await reload({});
    expect(
      macro.rmsDb,
      `comp1 = 1 must compress a fresh rack: ${dB(macro.rmsDb)} vs no macro ${dB(fresh.rmsDb)} — required at least ${COMP_ENGAGED_MIN_DB} dB below`,
    ).toBeLessThan(fresh.rmsDb - COMP_ENGAGED_MIN_DB);
    expect(macro.live, 'the macro fans out to the LIVE Faust triple').toEqual({
      ch1_thresh: m.thresh,
      ch1_ratio: m.ratio,
      ch1_compEnable: m.enable,
    });
  }, SWEEP_TIMEOUT_MS);

  it('a FRESH spawn holds the DECLARED defaults on the LIVE params', async () => {
    // The display half: mapCompMacro(0) used to write { thresh 0, ratio 1 } at
    // build, so ch{N}_thresh/ratio NEVER held their declared −12 / 2 and the
    // knob disagreed with its own motorized readback. Audio is identical either
    // way (enable is 0 = bypassed in both), which is exactly why this leg has to
    // read the params rather than the mix — and why it has to read them at a
    // RENDERED instant, where the pre-render snapshot returned −12 / 2 / 0 for
    // free and could never have failed.
    const declared = Object.fromEntries(
      ['ch1_thresh', 'ch1_ratio', 'ch1_compEnable'].map((id) => [
        id,
        mixmstrsDef.params.find((p) => p.id === id)!.defaultValue,
      ]),
    );
    const fresh = await reload({});
    expect(fresh.live, 'a fresh spawn must render the DECLARED defaults, not mapCompMacro(0)').toEqual(declared);
  }, SWEEP_TIMEOUT_MS);

  it('EVERY clip-record CV input moves read("recState") — the sweep the audio legs cannot do', async () => {
    // ⚠ THE OTHER HALF OF THE NARROWING ABOVE. These eighteen ports are carved
    // out of the audio sweeps because their consumer is JavaScript, and a
    // carve-out with nothing behind it is how #1734 happened in the first
    // place. So each one is driven through the SAME CV path
    // (`AudioEngine.addEdge` connects to `handle.inputs.get(id).param`) and
    // required to move the module's own observable.
    //
    // The measurement is taken AFTER a render, not before: the shadow's value
    // is read off a passive analyser, which holds zeros until the graph has
    // actually rendered a quantum. Reading pre-render would return the knob
    // intrinsic for every port and pass no matter what the cable did.
    const readAfterRender = async (
      cv: { id: string; offset: number } | null,
    ): Promise<{ arm: number[]; mon: number[]; tap: number; quality: number }> => {
      const ctx = new OfflineAudioContext({ numberOfChannels: 1, length: N, sampleRate: SR });
      const node = { id: 'recstate-cv', type: 'mixmstrs', position: { x: 0, y: 0 }, params: {} } as never;
      const handle = await mixmstrsDef.factory(ctx as unknown as AudioContext, node);
      if (cv) {
        const ref = handle.inputs.get(cv.id)!;
        const cs = ctx.createConstantSource();
        cs.offset.value = cv.offset;
        cs.connect(ref.param!);
        cs.start(0);
      }
      const out = handle.outputs.get('masterL')!;
      out.node.connect(ctx.destination, out.output, 0);
      await ctx.startRendering();
      const state = handle.read?.('recState') as {
        arm: number[]; mon: number[]; tap: number; quality: number;
      };
      handle.dispose?.();
      return state;
    };

    const base = await readAfterRender(null);
    // Vacuity guard: the control read must be the declared defaults, or a
    // broken `read` seam would make every comparison below trivially equal.
    expect(base.arm, 'every channel starts unarmed').toEqual(MIXMSTRS_CHANNELS.map(() => 0));
    expect(base.mon, 'every channel starts on the clip-auto default').toEqual(
      MIXMSTRS_CHANNELS.map(() => 2),
    );
    expect(base.tap).toBe(0);
    expect(base.quality).toBe(0);

    const dead: string[] = [];
    const table: string[] = [];
    for (const id of JS_CONSUMED_INPUT_IDS) {
      // Drive each port AWAY from its own default: +2 for the ones that rest at
      // 0, −2 for MON which rests at 2. A cable that reached nothing leaves the
      // state exactly where it was.
      const restsHigh = id.endsWith('_mon');
      const state = await readAfterRender({ id, offset: restsHigh ? -2 : 2 });
      const got = JSON.stringify(state);
      table.push(`${id} → ${got}`);
      if (got === JSON.stringify(base)) dead.push(id);
    }
    expect(
      dead,
      `a clip-record CV cable changed NOTHING in read('recState'): ${table.join(' | ')}`,
    ).toEqual([]);
  }, SWEEP_TIMEOUT_MS);
});
