// art/scenarios/cv-param-reach/cv-param-reach.test.ts
//
// REGISTRY-DRIVEN CV-REACH SWEEP — "does a cable patched into this param
// input actually move this module's output?"
//
// WHY THIS EXISTS (#1661). SWOLEVCO published a `param` for each of its four
// CV inputs that was the `.gain` of a GainNode connected to NOTHING. The
// engine's per-param tap analyser saw the CV and animated the motorized
// fader, so the UI told the player it was working, while the measured peak
// |Δsample| of patching a cable into any of the four was exactly 0.0000e+0.
// Every gate in the set was blind to it, and each was blind for the same
// reason: they all read the CONTRACT (`PortDef.paramTarget` is declared, the
// edge materialises, the cv-scale math is right) and none read the VALUE.
//
// So this sweep's observable is RENDERED AUDIO, and it is derived from the
// registry — `collectAudioDefs()`, the same glob barrel the app registers
// from — so a new module is enrolled the moment it declares a `paramTarget`,
// with no list to append to.
//
// ---------------------------------------------------------------------------
// WHAT IT MEASURES, per (module, port)
// ---------------------------------------------------------------------------
//
//   baseline  render the def's own factory under an OfflineAudioContext with
//             canonical drivers on every NON-paramTarget input.
//   repro     render the baseline A SECOND TIME, unchanged, and require the two
//             to be bit-identical. This runs FIRST and it is a veto: a module
//             that cannot render the same twice has no noise floor below the
//             deltas below, so none of its ports are measured at all. See #1680.
//   cv leg    the same render plus a ConstantSource wired the way
//             `AudioEngine.addEdge` wires one (engine.ts ~489): into
//             `inputs.get(portId).param` when the module publishes one, else
//             into `inputs.get(portId).node` — the engine's own fallback.
//   knob leg  the same render with `handle.setParam(paramTarget, value)`, at
//             the SAME effective param value the cv leg asks for.
//
// and requires BOTH legs to move the output. Requiring both is the whole
// point, in both directions:
//
//   * knob moved, cv did not  →  the #1661 shape: the param is audible, the
//     cable is not. A live bug.
//   * cv moved, knob did not  →  the CV is reaching something that is NOT
//     the param. This is not a hypothetical: it is how RASTERIZE and SCOPE
//     were found (below), where several ports publish one live audio-path
//     GainNode's `.gain`, so a cable into `cursor` MULTIPLIES the passthrough
//     audio — measured 3.1e+5 peak against a 5.0e-1 baseline — while the
//     param itself never moves. A sweep that only asked "did the audio
//     change?" would have called that a PASS.
//   * neither moved  →  INCONCLUSIVE, never a pass. The instrument cannot
//     see this control at this operating point, so it has proved nothing.
//     These are named below with their evidence, not silently skipped.
//
// ---------------------------------------------------------------------------
// WHAT THIS GATE STRUCTURALLY CANNOT SEE  (assert-what-you-are-blind-to)
// ---------------------------------------------------------------------------
//
//  1. FAUST MODULES. `node-web-audio-api` cannot host a custom AudioWorklet,
//     and a Faust def's factory instantiates one (see the header of
//     art/setup/faust-offline.ts, which exists precisely because of this).
//     Their factories throw here, so every paramTarget port on them is
//     unmeasured. That is not a small hole — the coverage line at the bottom of
//     this file prints `declared` / `measured` / `unmeasured` DERIVED from the
//     run, and the Faust share of it is the largest single reason. MIXMSTRS'
//     `comp{N}` macro ports are a CONFIRMED instance of the #1661 shape (filed
//     as #1662) and live inside it, so the one module already known to be
//     broken is the one this sweep cannot see.
//     The exemption asserts the factory STILL throws, so the day one of them
//     becomes materialisable the entry goes red instead of quietly persisting.
//
//  2. NON-AUDIO CONSUMERS. The metric is the module's audio-ish outputs. A
//     param whose only consumer is the CARD, a video output, or a MIDI
//     stream is invisible here even when its CV path is perfect. SCOPE's
//     render params are exactly that shape — which is why their entries
//     below are about the ALIASING defect and not about the render path.
//     ⚠ This blind spot is easy to mistake for a defect. WAVESCULPT's `scale`
//     was filed as "the cable works, the KNOB is dead" (#1680) on a non-zero cv
//     reading and a zero knob reading. In fact `sScale` is read in exactly one
//     place — the card-facing `read()` that returns scope traces — so `scale`
//     has NO audio consumer, the knob leg is correctly wired, and the non-zero
//     cv number was blind-spot-3 race noise. Before believing a one-legged
//     result, grep the shadow's consumers.
//
//  3. MAIN-THREAD PUMPS — and they make the render NON-REPRODUCIBLE, which is
//     worse than blindness. A module that pushes state to the DSP from a
//     `setInterval`/`setTimeout` tick (the WAVESCULPT pattern) DOES get ticks
//     during `startRendering()`: node-web-audio-api renders off-thread, so the
//     JS event loop is free for the whole await and the pump fires. Measured on
//     a 0.35 s render: 3-4 callbacks, landing at `ctx.currentTime` 0.003 /
//     0.072 / 0.237 — i.e. at a WALL-CLOCK-determined offline time that is
//     different every run.
//
//     ⚠ An earlier revision of this comment claimed "0 timer callbacks across a
//     1 s offline render". That measurement was wrong, and believing it cost a
//     REAL two-verdict incident (#1680): the same wavesculpt ports read
//     `cv Δ=0.0000e+0, knob Δ=0.0000e+0` on one CI run and PASSED on the next
//     two, from identical sweep code in the identical job.
//
//     So the pump is not a false-NEGATIVE risk, it is a COIN FLIP in both
//     directions, and the only sound response is to refuse to judge such a
//     module at all. The REPRODUCIBILITY leg below renders each module's
//     baseline twice and requires the two to be bit-identical before any of its
//     ports are measured; a module that fails it is skipped and must be NAMED.
//
//  4. WHETHER THE MOVEMENT IS *CORRECT*. This asserts reach, not fidelity —
//     that the cable changes the sound, not that it changes it the right way
//     or by the right amount. Range/scaling is `cv-range-uniformity`'s job.
//
// ---------------------------------------------------------------------------

import { describe, expect, it, beforeAll } from 'vitest';
import { OfflineAudioContext } from 'node-web-audio-api';
import { collectAudioDefs } from '../../../packages/web/src/lib/audio/modules';
import type { AudioModuleDef } from '../../../packages/web/src/lib/audio/module-registry';
import { isVideoCableType } from '../../../packages/web/src/lib/graph/types';
import { vcoTestSignal, gateTrain, triggerTrain, clockTrain, C4_HZ } from '../../setup/drivers';

const SR = 48_000;

/** Render length. Long enough for a delay/reverb tail to reach the output at
 *  the canonical drive, short enough that the whole sweep (two renders per
 *  port, plus a baseline pair and an identity build per module) stays inside
 *  its lane's budget. Ports needing a longer window to show a difference land in
 *  `no-observable-at-canonical-drive` WITH that recorded as their reason —
 *  they are never counted as passing. */
const DURATION_S = 0.35;

// ---------------------------------------------------------------------------
// Exemptions — DENY BY DEFAULT, one NAMED entry per instance, `why` required
// by the TYPE so `tsc` refuses an undeclared form before a test runs.
//
// Every entry is itself an ASSERTION about measured evidence, not a skip:
// the sweep re-measures each exempt port and fails if the evidence that
// justified the exemption has gone away. An entry can therefore go stale in
// exactly one direction — someone made things better — and that is red.
// ---------------------------------------------------------------------------

type Exemption =
  /** The def's factory cannot be materialised in this harness at all, so no
   *  port on it is measured. Evidence re-checked: the factory still throws. */
  | { kind: 'harness-cannot-materialize'; module: string; port: '*'; why: string }
  /** Two IDENTICAL renders of this module's baseline are not bit-identical, so
   *  every delta it can produce is a coin flip and NO port on it may be judged.
   *  Evidence re-checked: the module must still be NAMED here the moment the
   *  sweep observes it, and the sweep is RED if a module goes racy unnamed. */
  | { kind: 'render-not-reproducible'; module: string; port: '*'; issue: number; why: string }
  /** The KNOB leg does not move the output either, so the instrument cannot
   *  see this control here and has proved nothing about the cable. Evidence
   *  re-checked: the knob leg still measures exactly 0. */
  | { kind: 'no-observable-at-canonical-drive'; module: string; port: string; why: string }
  /** A live defect, filed. Evidence re-checked: the port still FAILS the
   *  same predicate every other port is held to. */
  | { kind: 'known-defect'; module: string; port: string; issue: number; why: string };

const EXEMPT: readonly Exemption[] = [
  // --- 1. Faust: the harness cannot host their AudioWorklet (see blind spot 1)
  ...(['adsr', 'analogVco', 'destroy', 'drummergirl', 'filter', 'meowbox',
    'mixmstrs', 'qbrt', 'score'] as const).map((module): Exemption => ({
    kind: 'harness-cannot-materialize',
    module,
    port: '*',
    why: 'Faust module: the factory instantiates an AudioWorkletNode, which node-web-audio-api cannot host — the factory throws before any port can be probed. Covering these needs a browser-hosted harness, not a longer render.',
  })),

  // --- 2. The knob leg is inert too, so nothing is proved either way.
  //        Each of these is a REAL gap in coverage, recorded with the reason
  //        the canonical drive cannot reach it.
  {
    kind: 'no-observable-at-canonical-drive', module: 'charlottesEchos', port: 'delay',
    why: 'A delay-time change only becomes audible once the changed tap has been read back out, which is longer than the render window at this delay setting.',
  },
  ...(['position_cv', 'pitch_cv', 'density_cv', 'texture_cv'] as const).map((port): Exemption => ({
    kind: 'no-observable-at-canonical-drive', module: 'clouds', port,
    why: 'Granular: the grain buffer has not filled far enough inside the render window for a read-position/density/texture change to reach the output. `size_cv` and `blend_cv` on the same module DO move, so the module is materialising and sounding — this is a window-length gap, not a dead module.',
  })),
  ...(['feedback_cv', 'drive_cv', 'drift_cv'] as const).map((port): Exemption => ({
    kind: 'no-observable-at-canonical-drive', module: 'cofefve', port,
    why: 'Feedback / drive / drift shape the recirculated signal, which has not come back around inside the render window. Five of the module\'s eight CV ports DO move here.',
  })),
  ...(['morph_cv', 'spread_cv', 'fold_cv'] as const).map((port): Exemption => ({
    kind: 'no-observable-at-canonical-drive', module: 'foxy', port,
    why: 'The module renders SILENCE under the canonical drivers (baseline peak 0), so no param can be shown to move anything. Needs a module-specific drive before any claim can be made about these ports.',
  })),
  ...(['tmodel_cv', 'tbias_cv', 'tjitter_cv', 'dejavu_cv', 'length_cv', 'spread_cv',
    'xbias_cv', 'steps_cv', 'xdejavu_cv', 'scale_cv'] as const).map((port): Exemption => ({
    kind: 'no-observable-at-canonical-drive', module: 'marbles', port,
    why: 'These params shape a random-sequence generator that only re-samples them on a clock edge; too few edges land inside the render window to change the output. `rate_cv` on the same module DOES move.',
  })),
  {
    kind: 'no-observable-at-canonical-drive', module: 'polyseqz', port: 'humanize_cv',
    why: 'The module renders silence under the canonical drivers (baseline peak 0) — it is a note source whose output is not in the audio-ish output set this metric reads.',
  },
  {
    kind: 'no-observable-at-canonical-drive', module: 'samsloop', port: 'rate_cv',
    why: 'The module renders silence under the canonical drivers (baseline peak 0): a sample player with no sample loaded has nothing whose rate could change.',
  },
  ...(['rate_cv_a', 'rate_cv_b'] as const).map((port): Exemption => ({
    kind: 'no-observable-at-canonical-drive', module: 'twotracks', port,
    why: 'The module renders silence under the canonical drivers (baseline peak 0): a two-deck player with no material loaded.',
  })),

  // --- 3. The render itself is a race, so no delta from these modules means
  //        anything. See blind spot 3 — each drives the DSP from a main-thread
  //        pump that fires at wall-clock time during the offline render.
  //
  // ⚠ THESE THREE REPLACE two `known-defect` entries this file briefly carried
  // for wavesculpt.morph3_cv and wavesculpt.scale. Those entries recorded a
  // real reading (`cv Δ=0.0000e+0, knob Δ=0.0000e+0` and `cv Δ=3.8759e-2, knob
  // Δ=0.0000e+0`) from the sweep's first CI run — and the SAME code on the next
  // two CI runs made both ports PASS. The readings were noise, so the defect
  // claims are RETRACTED (#1680): nothing was ever established about those two
  // ports in either direction.
  {
    kind: 'render-not-reproducible', module: 'wavesculpt', port: '*', issue: 1680,
    why: 'Two identical baseline renders differ every time: measured peak |Δsample| between them ranged 3.9e-3..1.7e-1 against a baseline peak of 1.3e-1..1.7e-1 — and some renders come out bit-exactly SILENT while the next sounds. The `setInterval(tick, ENV_TICK_MS)` pump is what pushes the combined knob+CV shadow values into the worklet params (wavesculpt.ts:1511 is the ONLY writer of engineParams `morph{N}`, and it lives inside tick()), and it fires 3-4 times at wall-clock-determined points inside the render. So BOTH legs of every morph port depend on a wall-clock race, which is exactly the shape #1680 mistook for a defect.',
  },
  {
    kind: 'render-not-reproducible', module: 'cloudseed', port: '*', issue: 1680,
    why: 'Two identical baseline renders differ on EVERY attempt: measured peak |Δsample| 2.7e-1..4.3e-1 against a baseline peak of 4.0e-1..5.6e-1, i.e. the run-to-run noise is most of the signal. Quiescing the timers registered during the factory does NOT settle it, so the source is not (only) a factory-window pump — that is part of #1680 and not yet established.',
  },
  {
    kind: 'render-not-reproducible', module: 'cube', port: '*', issue: 1680,
    why: 'The render is BISTABLE at full scale: two identical baseline renders are either bit-identical or differ by exactly 1.000e+0, with both outcomes seen repeatedly across the same local sweep. A port delta here is a fair coin, not a measurement. Quiescing the factory-window timers does not settle it either (#1680).',
  },

  // --- 4. Live defects found BY this sweep. Filed; still failing on purpose.
  ...(['cursor', 'samplesPerFrame', 'gain', 'wrap'] as const).map((port): Exemption => ({
    kind: 'known-defect', module: 'rasterize', port, issue: 1664,
    why: 'All four ports publish the SAME AudioParam — `inGain.gain`, which is the live in→thru passthrough. A cable into `cursor` therefore multiplies the audio instead of moving the param: measured 3.1e+5 peak against a 5.0e-1 baseline. `setParam` only writes a JS record, so the knob leg moves nothing at all.',
  })),
  ...(['timeMs', 'ch1Scale', 'ch1Offset', 'ch1Range', 'ch2Scale', 'ch2Offset',
    'ch2Range', 'mode', 'intensity'] as const).map((port): Exemption => ({
    kind: 'known-defect', module: 'scope', port, issue: 1664,
    why: 'Six ports publish `gain1.gain` and three publish `gain2.gain` — the live ch1/ch2 passthrough gains. A cable into `timeMs` amplitude-modulates the passthrough (measured 7.0e+1 peak against a 5.0e-1 baseline) and never moves the param; `setParam` only writes a JS record.',
  })),
];

// ---------------------------------------------------------------------------
// Measurement
// ---------------------------------------------------------------------------

/** Outputs this metric can read. Video and MIDI outputs are not samples. */
function audioIshOutputs(def: AudioModuleDef): string[] {
  return def.outputs
    .filter((o) => !isVideoCableType(o.type) && !/midi/i.test(String(o.type)))
    .map((o) => o.id);
}

/** Canonical driver per cable type — the same vocabulary the ART audio
 *  profiles use, so "driven" means one thing across the lane. */
function driverFor(type: string, edge: string | undefined): Float32Array | null {
  if (type === 'audio') {
    return vcoTestSignal({ totalS: DURATION_S, freqHz: C4_HZ, shape: 'saw', sampleRate: SR });
  }
  if (type === 'gate') {
    return edge === 'trigger'
      ? triggerTrain({ totalS: DURATION_S, bpm: 480, sampleRate: SR })
      : gateTrain({ totalS: DURATION_S, bpm: 480, gateS: 0.06, sampleRate: SR });
  }
  if (type === 'clock') return clockTrain(DURATION_S, SR);
  if (type === 'cv') {
    // ADR-004: a full-scale modulator is ±1.
    const b = new Float32Array(Math.round(SR * DURATION_S));
    for (let i = 0; i < b.length; i++) b[i] = Math.sin((2 * Math.PI * 3 * i) / SR);
    return b;
  }
  return null;
}

interface Leg { readonly ok: true; readonly channels: readonly Float32Array[] }
interface LegError { readonly ok: false; readonly error: string }
type LegResult = Leg | LegError;

interface RenderRequest {
  /** Drive a constant into this port the way `AudioEngine.addEdge` would. */
  cv?: { portId: string; value: number };
  /** Apply this param by the knob path. */
  knob?: { paramId: string; value: number };
}

async function renderLeg(
  def: AudioModuleDef,
  outIds: readonly string[],
  req: RenderRequest,
): Promise<LegResult> {
  try {
    const ctx = new OfflineAudioContext({
      numberOfChannels: Math.max(1, outIds.length),
      length: Math.round(SR * DURATION_S),
      sampleRate: SR,
    });
    const handle = await def.factory(ctx as never, {
      id: 'cv-param-reach', type: def.type, domain: 'audio',
      position: { x: 0, y: 0 }, params: {},
    } as never);

    // Drive every non-paramTarget input so the module actually sounds. The
    // port under test is left to the cv leg.
    for (const port of def.inputs) {
      if (port.paramTarget) continue;
      const ref = handle.inputs.get(port.id);
      if (!ref) continue;
      const data = driverFor(String(port.type), port.edge);
      if (!data) continue;
      const buf = ctx.createBuffer(1, data.length, SR);
      buf.copyToChannel(new Float32Array(data), 0);
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.connect(ref.node, 0, ref.input);
      src.start(0);
    }

    if (req.cv) {
      const ref = handle.inputs.get(req.cv.portId);
      if (!ref) return { ok: false, error: `no input port '${req.cv.portId}'` };
      const cs = ctx.createConstantSource();
      cs.offset.value = req.cv.value;
      cs.start(0);
      // EXACTLY the engine's own branch: an exposed AudioParam wins, and a
      // module that exposes none takes the node input (engine.ts addEdge).
      if (ref.param) cs.connect(ref.param);
      else cs.connect(ref.node, 0, ref.input);
    }
    if (req.knob) handle.setParam(req.knob.paramId, req.knob.value);

    const merger = ctx.createChannelMerger(Math.max(1, outIds.length));
    outIds.forEach((id, k) => {
      const out = handle.outputs.get(id);
      if (out) out.node.connect(merger, out.output, k);
    });
    merger.connect(ctx.destination);
    const rendered = await ctx.startRendering();
    return { ok: true, channels: outIds.map((_, k) => rendered.getChannelData(k).slice()) };
  } catch (e) {
    return { ok: false, error: String((e as Error)?.message ?? e).slice(0, 140) };
  }
}

/** Peak |Δsample| across every captured output — linear amplitude, the same
 *  metric #1661 reported its 0.0000e+0 in. */
function peakDelta(a: Leg, b: Leg): number {
  let m = 0;
  for (let c = 0; c < a.channels.length; c++) {
    const x = a.channels[c]!;
    const y = b.channels[c]!;
    for (let i = 0; i < x.length; i++) m = Math.max(m, Math.abs(x[i]! - y[i]!));
  }
  return m;
}

function peakOf(leg: Leg): number {
  let m = 0;
  for (const ch of leg.channels) for (const v of ch) m = Math.max(m, Math.abs(v));
  return m;
}

/** A far-from-default point inside the param's declared range, so the probe
 *  is a real excursion rather than a nudge. */
function probeValue(min: number, max: number, dflt: number): number {
  return (dflt - min) < (max - dflt) ? min + 0.8 * (max - min) : min + 0.2 * (max - min);
}

export interface PortMeasurement {
  module: string;
  port: string;
  paramId: string;
  /** Which branch of the engine's addEdge the cv leg took. */
  via: 'param' | 'node-input';
  basePeak: number;
  cvDelta: number;
  knobDelta: number;
  error?: string;
}

/** THE PREDICATE. Every leg of this file — the sweep, the positive control,
 *  the negative control, the exemption re-checks — calls THIS, so a control
 *  cannot drift away from the check it is controlling for. */
function reaches(m: PortMeasurement): boolean {
  return !m.error && m.cvDelta > 0 && m.knobDelta > 0;
}

function describeMeasurement(m: PortMeasurement): string {
  return `${m.module}.${m.port} → param '${m.paramId}' via ${m.via}: `
    + `cv Δ=${m.cvDelta.toExponential(4)}, knob Δ=${m.knobDelta.toExponential(4)}, `
    + `baseline peak=${m.basePeak.toExponential(2)} (peak |Δsample|, linear amplitude)`
    + (m.error ? ` — ERROR: ${m.error}` : '');
}

/** Measure every paramTarget port of one def. Materialises the def TWICE for
 *  the reproducibility leg and twice per port. */
async function measureDef(def: AudioModuleDef): Promise<{
  factoryError?: string;
  /** Peak |Δsample| between two IDENTICAL baseline renders. Anything but 0
   *  means every other number this def can produce is a coin flip. */
  nullDelta: number;
  sharedParams: { a: string; b: string }[];
  rows: PortMeasurement[];
}> {
  const rows: PortMeasurement[] = [];
  const sharedParams: { a: string; b: string }[] = [];
  const outIds = audioIshOutputs(def);
  const targets = def.inputs.filter((p) => p.paramTarget);

  const base = await renderLeg(def, outIds, {});
  if (!base.ok) return { factoryError: base.error, nullDelta: 0, sharedParams, rows };

  // REPRODUCIBILITY LEG — the same request, rendered again. This is the
  // instrument's own negative control and it runs BEFORE anything is measured:
  // a delta between two identical renders is the noise floor for every delta
  // below, so a module that fails it cannot be judged at all. Skipping its
  // ports is not a saving, it is the only honest reading — see blind spot 3
  // and the #1680 two-verdict incident that produced this leg.
  const base2 = await renderLeg(def, outIds, {});
  const nullDelta = base2.ok ? peakDelta(base, base2) : 0;

  // ALIASING leg — object identity of the published AudioParams. Cheap,
  // exact, and it catches the class the audio metric can be FOOLED by: two
  // ports on one AudioParam means at most one of them can be the real param.
  // The same single materialisation also records which branch of the
  // engine's addEdge each port takes, so this costs ONE extra factory build
  // per module rather than one per port.
  const viaOf = new Map<string, 'param' | 'node-input'>();
  const ctx = new OfflineAudioContext({ numberOfChannels: 1, length: 128, sampleRate: SR });
  try {
    const handle = await def.factory(ctx as never, {
      id: 'identity', type: def.type, domain: 'audio', position: { x: 0, y: 0 }, params: {},
    } as never);
    const seen = new Map<AudioParam, string>();
    for (const port of targets) {
      const param = handle.inputs.get(port.id)?.param;
      viaOf.set(port.id, param ? 'param' : 'node-input');
      if (!param) continue;
      const prior = seen.get(param);
      if (prior !== undefined) sharedParams.push({ a: prior, b: port.id });
      else seen.set(param, port.id);
    }
  } catch { /* covered by the factoryError branch above */ }

  // The aliasing leg above is STRUCTURAL (object identity of the published
  // AudioParams), so it stays valid even when the render is not — which is why
  // it runs before this bail-out rather than after.
  if (nullDelta > 0) return { nullDelta, sharedParams, rows };

  const basePeak = peakOf(base);
  for (const port of targets) {
    const pd = def.params.find((p) => p.id === port.paramTarget);
    if (!pd) {
      rows.push({
        module: def.type, port: port.id, paramId: String(port.paramTarget),
        via: 'param', basePeak, cvDelta: 0, knobDelta: 0,
        error: `def declares paramTarget '${port.paramTarget}' with no matching param`,
      });
      continue;
    }
    const target = probeValue(pd.min, pd.max, pd.defaultValue);
    const cv = await renderLeg(def, outIds, {
      // The CV SUMS with the knob intrinsic, so the offset that lands the
      // effective value on `target` is `target - default`.
      cv: { portId: port.id, value: target - pd.defaultValue },
    });
    const knob = await renderLeg(def, outIds, { knob: { paramId: pd.id, value: target } });

    rows.push({
      module: def.type, port: port.id, paramId: pd.id,
      via: viaOf.get(port.id) ?? 'param', basePeak,
      cvDelta: cv.ok ? peakDelta(base, cv) : 0,
      knobDelta: knob.ok ? peakDelta(base, knob) : 0,
      error: !cv.ok ? cv.error : !knob.ok ? knob.error : undefined,
    });
  }
  return { nullDelta, sharedParams, rows };
}

// ---------------------------------------------------------------------------
// Synthetic defs — the permanent controls. Both are run through the SAME
// `measureDef` / `reaches` path as every real module.
// ---------------------------------------------------------------------------

/** Increments on every materialisation of a `driftPerBuild` control, so two
 *  renders of the same def cannot agree. */
let CONTROL_BUILDS = 0;

function makeControlDef(
  type: string,
  connectShadow: boolean,
  driftPerBuild = false,
): AudioModuleDef {
  return {
    type, domain: 'audio', label: type, category: 'utility',
    palette: { top: 'Utility', sub: 'Utility' },
    inputs: [{ id: 'amount', type: 'cv', paramTarget: 'amount' }],
    outputs: [{ id: 'out', type: 'audio' }],
    params: [{ id: 'amount', label: 'Amount', defaultValue: 0, min: 0, max: 1, curve: 'linear' }],
    async factory(ctx: AudioContext) {
      const carrier = ctx.createConstantSource();
      // A `driftPerBuild` control emits a DIFFERENT level on every build, which
      // is the reproducibility leg's negative control: two identical renders of
      // it must disagree.
      carrier.offset.value = driftPerBuild ? 1 + 0.25 * (CONTROL_BUILDS++ % 3) : 1;
      carrier.start();
      const shadow = ctx.createGain();
      shadow.gain.value = 0;
      carrier.connect(shadow);
      const out = ctx.createGain();
      out.gain.value = 1;
      // The ONLY difference between the two controls. When false this is
      // literally the #1661 graph: a published AudioParam on a GainNode
      // whose output goes nowhere.
      if (connectShadow) shadow.connect(out);
      else carrier.connect(out);
      return {
        domain: 'audio',
        inputs: new Map([['amount', { node: shadow, input: 0, param: shadow.gain }]]),
        outputs: new Map([['out', { node: out, output: 0 }]]),
        setParam(_id: string, v: number) { shadow.gain.setValueAtTime(v, ctx.currentTime); },
        readParam() { return shadow.gain.value; },
        dispose() { try { carrier.stop(); } catch { /* */ } },
      };
    },
  } as unknown as AudioModuleDef;
}

// ---------------------------------------------------------------------------

let MEASURED: PortMeasurement[] = [];
let FACTORY_ERRORS = new Map<string, string>();
let SHARED = new Map<string, { a: string; b: string }[]>();
/** module → peak |Δsample| between two identical baseline renders, recorded
 *  ONLY for the modules where it was non-zero. */
let NON_REPRODUCIBLE = new Map<string, number>();
let DEFS: AudioModuleDef[] = [];
/** Per-module wall time, reported (never asserted). A wall-clock number is a
 *  property of the MACHINE, not of the code — measured on this tree, the same
 *  unchanged sweep took 127 s on an idle box and 50 min at load average 44,
 *  and the per-module ordering inverted completely. It is printed to point at
 *  the expensive modules when someone needs to make this cheaper; anything
 *  that GATED on it would be a different assertion on every runner. */
const COST: { module: string; ms: number; ports: number }[] = [];

describe('CV param reach — every declared paramTarget input must move its module', () => {
  beforeAll(async () => {
    DEFS = (collectAudioDefs() as AudioModuleDef[])
      .filter((d) => d.inputs?.some((p) => p.paramTarget))
      .sort((a, b) => a.type.localeCompare(b.type));
    for (const def of DEFS) {
      const t0 = Date.now();
      const r = await measureDef(def);
      COST.push({ module: def.type, ms: Date.now() - t0, ports: r.rows.length });
      if (r.factoryError) FACTORY_ERRORS.set(def.type, r.factoryError);
      if (r.nullDelta > 0) NON_REPRODUCIBLE.set(def.type, r.nullDelta);
      if (r.sharedParams.length) SHARED.set(def.type, r.sharedParams);
      MEASURED = MEASURED.concat(r.rows);
    }
  }, 3_000_000);

  // -------------------------------------------------------------------------
  // Controls. These run FIRST in file order and are permanent legs: if the
  // harness ever stops being able to see a working CV path, or stops being
  // able to see a broken one, the sweep's greens mean nothing.
  // -------------------------------------------------------------------------

  it('POSITIVE CONTROL (mechanism): ConstantSource → GainNode.gain moves a render here', async () => {
    const ctx = new OfflineAudioContext({ numberOfChannels: 1, length: 480, sampleRate: SR });
    const dc = ctx.createConstantSource();
    dc.offset.value = 0.25;
    dc.start();
    const g = ctx.createGain();
    g.gain.value = 1;
    dc.connect(g);
    g.connect(ctx.destination);
    const drive = ctx.createConstantSource();
    drive.offset.value = 1;
    drive.start();
    drive.connect(g.gain);
    const rendered = await ctx.startRendering();
    // Without this leg, "the CV never connected" and "the CV connected and
    // reached nothing" are indistinguishable from a bit-exact zero.
    expect(
      rendered.getChannelData(0)[100],
      'cs.connect(audioParam) must modulate in node-web-audio-api (linear amplitude)',
    ).toBeCloseTo(0.5, 6);
  });

  it('POSITIVE CONTROL (predicate): a shadow WIRED to the output passes `reaches`', async () => {
    const r = await measureDef(makeControlDef('__control_live_shadow', true));
    expect(r.nullDelta, 'the control itself must render reproducibly').toBe(0);
    expect(r.rows).toHaveLength(1);
    expect(reaches(r.rows[0]!), describeMeasurement(r.rows[0]!)).toBe(true);
  });

  it('CONTROL (reproducibility leg): a def whose render is not repeatable is REFUSED, not measured', async () => {
    // The instrument's negative control ON ITSELF, and a permanent leg of the
    // #1680 incident. Both directions, both through `measureDef`:
    //   * an ordinary def          → nullDelta 0, its port IS measured;
    //   * the same def built so each materialisation differs → nullDelta > 0,
    //     and NOT ONE row is emitted.
    // Without the second leg, "every module is reproducible" and "this leg
    // never looked" are indistinguishable from a green run.
    //
    // The drift here is per-materialisation rather than wall-clock, on purpose:
    // it reproduces the PROPERTY the leg exists to catch (two identical renders
    // disagree) without importing the timing race that would make the control
    // itself flaky. The real instances are in EXEMPT under
    // `render-not-reproducible`.
    const steady = await measureDef(makeControlDef('__control_live_shadow', true));
    expect(steady.nullDelta).toBe(0);
    expect(steady.rows).toHaveLength(1);

    // `connectShadow: false` routes the carrier straight to the output, so the
    // per-build drift is what the BASELINE renders — which is the whole point.
    const racy = await measureDef(makeControlDef('__control_drifting', false, true));
    expect(
      racy.nullDelta,
      'a non-repeatable render must be CAUGHT (peak |Δsample| between two identical renders, linear amplitude)',
    ).toBeGreaterThan(0);
    expect(
      racy.rows,
      'and a non-reproducible module must emit NO measurements at all — a coin flip is not a reading',
    ).toEqual([]);
  });

  it('NEGATIVE CONTROL (predicate): a shadow wired to NOTHING fails `reaches`', async () => {
    // The #1661 graph exactly. If this ever passes, the sweep has gone blind
    // and every green below is worthless.
    const r = await measureDef(makeControlDef('__control_dead_shadow', false));
    expect(r.rows).toHaveLength(1);
    const m = r.rows[0]!;
    expect(reaches(m), describeMeasurement(m)).toBe(false);
    expect(m.cvDelta, 'the dead shadow must measure a BIT-EXACT zero, as #1661 did').toBe(0);
    expect(m.knobDelta, 'and its knob leg must be equally dead — setParam writes the same dead node').toBe(0);
  });

  // -------------------------------------------------------------------------
  // The sweep.
  // -------------------------------------------------------------------------

  it('every non-exempt paramTarget port moves its module output through the CV path', () => {
    const exemptKeys = new Set(
      EXEMPT.map((e) => (e.port === '*' ? `${e.module}.*` : `${e.module}.${e.port}`)),
    );
    const offenders = MEASURED
      .filter((m) => !exemptKeys.has(`${m.module}.${m.port}`) && !exemptKeys.has(`${m.module}.*`))
      .filter((m) => !reaches(m))
      .map(describeMeasurement);
    expect(offenders, 'CV inputs that do not move their module (see #1661)').toEqual([]);
  });

  it('no two paramTarget ports on one module publish the SAME AudioParam', () => {
    // The aliasing class. The audio metric can be FOOLED by it — a cable that
    // multiplies the passthrough does move the output — so this leg is
    // structural and independent of any render.
    const known = new Set(
      EXEMPT.filter((e) => e.kind === 'known-defect').map((e) => `${e.module}.${e.port}`),
    );
    const offenders: string[] = [];
    for (const [module, pairs] of SHARED) {
      for (const p of pairs) {
        if (known.has(`${module}.${p.a}`) && known.has(`${module}.${p.b}`)) continue;
        offenders.push(`${module}: ports '${p.a}' and '${p.b}' publish one AudioParam`);
      }
    }
    expect(offenders, 'aliased paramTarget ports — at most one of a pair can be the real param').toEqual([]);
  });

  // -------------------------------------------------------------------------
  // Exemptions are ANCHORED TO THE ARTIFACT, in both directions.
  // -------------------------------------------------------------------------

  it('every exemption names a module + port that still declares a paramTarget', () => {
    const live = new Set<string>();
    const liveModules = new Set<string>();
    for (const def of DEFS) {
      liveModules.add(def.type);
      for (const p of def.inputs) if (p.paramTarget) live.add(`${def.type}.${p.id}`);
    }
    const stale = EXEMPT
      .filter((e) => (e.port === '*' ? !liveModules.has(e.module) : !live.has(`${e.module}.${e.port}`)))
      .map((e) => `${e.module}.${e.port} (${e.kind}) — no such paramTarget port any more`);
    expect(stale, 'stale exemptions: delete them').toEqual([]);
  });

  it('every exemption carries a REASON, not just a name', () => {
    const thin = EXEMPT
      .filter((e) => e.why.trim().length < 60)
      .map((e) => `${e.module}.${e.port}: why is ${e.why.trim().length} chars`);
    expect(thin, 'an exemption without an argument is a skip wearing a costume').toEqual([]);
  });

  it('every module whose render is NOT REPRODUCIBLE is NAMED — deny by default', () => {
    // The gate that would have caught #1680 the day it was written. A module
    // that cannot render the same twice produces coin flips, and a coin flip
    // reads exactly like a finding: wavesculpt.morph3_cv was reported as a
    // filed defect on the strength of one, and passed on the next two runs.
    const named = new Set(
      EXEMPT.filter((e) => e.kind === 'render-not-reproducible').map((e) => e.module),
    );
    const unnamed = [...NON_REPRODUCIBLE]
      .filter(([module]) => !named.has(module))
      .map(([module, d]) =>
        `${module}: two IDENTICAL baseline renders differ by ${d.toExponential(4)} `
        + '(peak |Δsample|, linear amplitude) — every delta this module can produce is noise. '
        + "Make the render deterministic, or add a NAMED 'render-not-reproducible' exemption.");
    expect(unnamed, 'modules whose measurements are a coin flip').toEqual([]);
  });

  it("'harness-cannot-materialize' entries still fail to materialize", () => {
    const fixed = EXEMPT
      .filter((e) => e.kind === 'harness-cannot-materialize')
      .filter((e) => !FACTORY_ERRORS.has(e.module))
      .map((e) => `${e.module}: factory now materialises — delete this exemption and let the sweep measure it`);
    expect(fixed).toEqual([]);
  });

  it("'no-observable-at-canonical-drive' entries still have a DEAD knob leg", () => {
    // The evidence for the exemption IS the missing positive control. The
    // moment a better driver (or a module change) makes the knob audible,
    // this port is measurable and the exemption must go.
    const byKey = new Map(MEASURED.map((m) => [`${m.module}.${m.port}`, m]));
    const stale = EXEMPT
      .filter((e) => e.kind === 'no-observable-at-canonical-drive')
      .flatMap((e) => {
        const m = byKey.get(`${e.module}.${e.port}`);
        if (!m) return [`${e.module}.${e.port}: not measured at all — is it behind a factory error, or did the reproducibility leg veto the module (nullΔ=${NON_REPRODUCIBLE.get(e.module)?.toExponential(4) ?? 'n/a'})?`];
        if (m.knobDelta === 0) return [];
        return [`${e.module}.${e.port}: knob leg now moves (${describeMeasurement(m)}) — this port is measurable, delete its exemption`];
      });
    expect(stale).toEqual([]);
  });

  it("'known-defect' entries still fail the SAME predicate the sweep applies", () => {
    const byKey = new Map(MEASURED.map((m) => [`${m.module}.${m.port}`, m]));
    const fixed = EXEMPT
      .filter((e) => e.kind === 'known-defect')
      .flatMap((e) => {
        const m = byKey.get(`${e.module}.${e.port}`);
        if (!m) return [`${e.module}.${e.port}: not measured — cannot confirm the defect still stands (factory error, or the reproducibility leg vetoed the module: nullΔ=${NON_REPRODUCIBLE.get(e.module)?.toExponential(4) ?? 'n/a'})`];
        if (!reaches(m)) return [];
        // The NUMBERS, not just the verdict: #1680 was two CI runs disagreeing
        // about these ports, and this message printed neither reading. Anyone
        // who hits this next must be able to compare deltas from the failure
        // text alone, without re-running a 15-minute sweep.
        return [`${e.module}.${e.port} (issue #${e.issue}) now PASSES — ${describeMeasurement(m)}`
          + ' — if this is stable, close the issue and delete this exemption; if it disagrees with'
          + ' the reading in the exemption\'s `why`, suspect the INSTRUMENT first (see blind spot 3)'];
      });
    expect(fixed).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // Scope statement — the gate asserts what it cannot see, so a reader of a
  // green run knows the size of the hole rather than assuming there is none.
  // -------------------------------------------------------------------------

  it('states its own coverage: what was measured vs what was skipped, and why', () => {
    const declared = DEFS.flatMap((d) =>
      d.inputs.filter((p) => p.paramTarget).map((p) => `${d.type}.${p.id}`));
    const measuredKeys = new Set(MEASURED.map((m) => `${m.module}.${m.port}`));
    const unmeasured = declared.filter((k) => !measuredKeys.has(k));
    const viaNodeInput = MEASURED.filter((m) => m.via === 'node-input').length;

    // Not a population ceiling: every one of these is DERIVED from the
    // registry at run time and asserted as a PARTITION — a declared port is
    // measured or it is named as unmeasurable, never neither and never both.
    const unmeasuredButNotExcused = unmeasured.filter((k) => {
      const [module] = k.split('.');
      return !EXEMPT.some((e) => e.module === module && e.port === '*');
    });
    expect(
      unmeasuredButNotExcused,
      'declared paramTarget ports that were never measured AND have no named reason',
    ).toEqual([]);

    const slowest = [...COST].sort((a, b) => b.ms - a.ms).slice(0, 5)
      .map((c) => `${c.module} ${(c.ms / 1000).toFixed(1)}s/${c.ports}p`).join(', ');
    // Derived from the run, never typed: which named reason each unmeasured
    // port fell under, so a reader of a green run sees the shape of the hole.
    const excusedBy = (kind: Exemption['kind']) => {
      const mods = new Set(EXEMPT.filter((e) => e.kind === kind).map((e) => e.module));
      return unmeasured.filter((k) => mods.has(k.split('.')[0]!)).length;
    };
    const racy = [...NON_REPRODUCIBLE]
      .map(([m, d]) => `${m} nullΔ=${d.toExponential(3)}`).join(', ') || 'none';
    // eslint-disable-next-line no-console
    console.log(
      `[cv-param-reach] slowest: ${slowest} (wall time — a MACHINE property, never a gate) | `
      + `declared=${declared.length} measured=${measuredKeys.size} unmeasured=${unmeasured.length} `
      + `(harness-cannot-materialize=${excusedBy('harness-cannot-materialize')}, `
      + `render-not-reproducible=${excusedBy('render-not-reproducible')}) `
      + `| NON-REPRODUCIBLE this run: ${racy} `
      + `| cv leg via node-input=${viaNodeInput} via param=${MEASURED.length - viaNodeInput} `
      + `| BLIND TO: Faust worklets, non-audio consumers (card/video/MIDI), any module whose render `
      + `is not repeatable (its ports are refused, not judged), and whether the movement is CORRECT. `
      + `NOTE: a 'render-not-reproducible' entry is anchored one way only — the sweep reddens when a `
      + `NEW module goes racy, but a named module that BECOMES deterministic is not detected here, `
      + `because re-measuring a coin flip cannot fail reliably (#1680).`,
    );
  });
});
