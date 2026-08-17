// art/scenarios/cv-terminal/cv-terminal.test.ts
//
// REGISTRY-DRIVEN STRUCTURAL SWEEP — "where does a cable patched into this
// paramTarget input actually LAND?"
//
// This is the cement in the hole left by `cv-param-reach` (#1769), and the
// difference is the whole point: that sweep answered a STRUCTURAL question with
// a BEHAVIOURAL instrument — a full offline render PER PORT, plus a second
// baseline render per module for a reproducibility leg. It grew to a 45-minute
// job whose timeout CANCELLED every main run and silently blocked the nightly
// production deploy. Owner ruling, 2026-08-16: *"we should have unit and int
// tests per module that all I/O works... kill this job entirely, get rid of it,
// fill the hole in with cement and never do this again."*
//
// Same registry-derived enrolment — `collectAudioDefs()`, the glob barrel the
// app itself registers from, so a module is enrolled the moment it declares a
// `paramTarget` and there is no list to append to. What changed is the cost
// model: ONE materialisation per module and ZERO renders of the module under
// test. Measured on this tree: the whole sweep reads every paramTarget port in
// the registry in well under a second, against `cv-param-reach`'s 1008 s of
// test time / 18m31s of job wall.
//
// ---------------------------------------------------------------------------
// ⚠ THE 30-SECOND "TIMEOUTS" THAT WERE NOT A FINDING
// ---------------------------------------------------------------------------
//
// The first version of this sweep reported 11 modules (every moog*, qbrt, rings,
// resofilter, ringback, samsloop) as failing to materialise, each hitting a 30 s
// cap — and materialisation cost that climbed monotonically with position in the
// run (kickdrum 1.2 s → marbles 3.4 s → meowbox 12.3 s → mixmstrs 34.4 s).
// That reads exactly like a finding about those modules. It was an INSTRUMENT
// BUG: an `OfflineAudioContext` that is never rendered holds its native render
// thread, and sixty of them starve the pool. Driven in isolation the same
// modules materialise in 66-97 ms.
//
// The fix is `release()` below — a 128-sample `startRendering()` per context,
// which completes it and frees the thread. Measured, whole sweep:
//
//     without release   488 076 ms, 11 modules "cannot materialise"
//     with release          762 ms, ZERO modules cannot materialise
//
// A 627x difference, and the wrong version's output was a confident, plausible,
// false conclusion — the CLAUDE.md "validate the instrument" shape exactly.
// ⚠ THIS ALSO RETIRES `cv-param-reach`'s LARGEST BLIND SPOT. It exempted nine
// Faust modules as `harness-cannot-materialize`, 120 ports including all 91 of
// mixmstrs' — "the one module already known to be broken is the one this sweep
// cannot see". Every one of them materialises here. That exemption had in fact
// gone stale on main, and its own re-check is one of the two assertions that
// were failing when the job was killed.
//
// ---------------------------------------------------------------------------
// WHAT IT ASSERTS, per (module, port)
// ---------------------------------------------------------------------------
//
//   TERMINAL   the port resolves off the LIVE handle and publishes an
//              AudioParam. `AudioEngine.addEdge` connects a same-domain CV
//              cable to `inputs.get(port).param` when there is one and falls
//              back to `{node, input}` when there is not — so "no param" is a
//              silently different destination, not an error. (#1734: all four
//              of slewSwitch's `slew*_cv` entries carry `input: 0` ALONGSIDE
//              their param; if the param ever went missing, slew CV would
//              become channel-1 SIGNAL, the audio would still move, and every
//              delta-based sweep would stay green.)
//
//   REACH      the node HOSTING that AudioParam can reach one of the module's
//              own declared output nodes through the connect graph. This is
//              the #1661/#1662 class: a param published on a node whose output
//              goes nowhere is bit-exactly audio-inert, while the engine's
//              per-param tap still animates the motorized fader — so the UI
//              says it works.
//
//   ALIASING   no two paramTarget ports on one module publish the SAME
//              AudioParam object. Unconditional, no exemptions. This is half
//              of #1664: SCOPE published `gain1.gain` on six ports and
//              `gain2.gain` on three; RASTERIZE published `inGain.gain` on all
//              four. At most one of a shared pair can be the real param.
//
//   LIVE PATH  a param on a NATIVE (non-worklet) node must not have that node
//              also published as a declared audio input or output. This is the
//              other half of #1664 and the dangerous half: `rasterize.cursor`
//              sat on the passthrough gain, so a cable MULTIPLIED the through
//              signal — measured 3.146e+5 peak against a 5.0e-1 baseline, a
//              629 000x blow-up pointed at the speaker bus.
//
// ---------------------------------------------------------------------------
// ⚠ THE CORRECT FIX AND THE #1661 DEFECT HAVE THE SAME GRAPH SIGNATURE
// ---------------------------------------------------------------------------
//
// `cv-shadow.ts` builds a landing pad for a param whose consumer is JAVASCRIPT:
// a GainNode reachable from nothing, deliberately, because pinning a carrier and
// tapping it with an AnalyserNode costs one permanently retained Blink
// AudioHandler PER PORT (measured; nine shadows took SCOPE from 2 to 11 retained
// per card). So a correct display param is graph-identical to `swolevco`'s bug.
//
// REACH therefore cannot be guessed, and this sweep does not guess: the class is
// DECLARED at the construction site via `markJsConsumedParam`, which
// `createCvShadow` calls for you — so membership is DERIVED, not listed, and a
// module that uses the canonical helper is classified automatically.
//
// The declaration is asserted in BOTH directions. A registered param that DOES
// reach a declared output is red too: the claim "my consumer is JavaScript" is
// then false and the cable is landing on live audio. Marking a genuinely dead
// DSP param swaps one red for another rather than silencing the gate.
//
// ---------------------------------------------------------------------------
// WHAT THIS GATE STRUCTURALLY CANNOT SEE  (assert-what-you-are-blind-to)
// ---------------------------------------------------------------------------
//
//  1. REACHABLE-BUT-INERT. A graph edge proves connection, never that the value
//     arrives, arrives scaled correctly, or is used at all. All 83 live mixmstrs
//     params sit on the ONE Faust worklet node, which reaches the output, so
//     REACH passes every one of them trivially; a param declared in a .dsp and
//     unused inside it is graph-perfect and audio-dead. `sample.test.ts` beside
//     this file renders real audio for a small FIXED set of ports precisely to
//     keep this sweep honest about that.
//
//  2. VIDEO-DOMAIN MODULES. `collectAudioDefs()` hard-requires `domain: 'audio'`,
//     so paramTarget ports on video defs are outside this sweep entirely — the
//     same boundary `cv-param-reach` had. `cv-bridge-map.ts` and the video
//     registry's own gates cover that side.
//
//  3. ORDERING AND INIT-TIME CLOBBER. #1662 also carries a finding no graph
//     inspection can reach: mixmstrs' comp macro is applied LAST and
//     UNCONDITIONALLY at construction, so a rack saved before the macro existed
//     is re-read at +29.174 dB, louder and uncompressed, on every reload. That
//     is a value/ordering defect, invisible to every predicate here.
//
//  4. THE ENGINE'S OWN DELIVERY PATH. `addEdge` inserts an `attachCvScale`
//     WaveShaper between source and param and tees a per-port tap analyser.
//     A module-handle structural read sees none of it; `cv-scale-registry` and
//     `cv-display-param-reach` cover that seam.
//
//  5. WHETHER A JS-CONSUMED PAD IS ACTUALLY READ. The register says the consumer
//     is JavaScript; it cannot say the pump fires. For SCOPE and RASTERIZE
//     `cv-display-param-reach` supplies that observable through
//     `read('drawParams')`.

import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { OfflineAudioContext } from 'node-web-audio-api';
import { collectAudioDefs } from '../../../packages/web/src/lib/audio/modules';
import type { AudioModuleDef } from '../../../packages/web/src/lib/audio/module-registry';
import { isJsConsumedParam, markJsConsumedParam } from '../../../packages/web/src/lib/audio/cv-shadow';

const SR = 48_000;

// ---------------------------------------------------------------------------
// Exemptions — DENY BY DEFAULT, one NAMED entry per instance, `why` REQUIRED by
// the TYPE so `tsc` refuses an undeclared form before a test runs.
//
// Every entry is an ASSERTION about live evidence, not a skip: each is
// re-derived from the same materialised handle every run and goes RED when the
// evidence that justified it disappears. An entry can therefore only go stale in
// one direction — someone made things better — and that is red.
// ---------------------------------------------------------------------------

type Exemption =
  /** The worklet sums this CV per-sample off a DEDICATED node input instead of
   *  routing it onto an AudioParam, so there is no param to publish and
   *  `{node, input}` is the correct terminal. Re-checked: the port must STILL
   *  publish no AudioParam. */
  | { kind: 'audio-rate-sum'; module: string; port: string; why: string }
  /** A hand-rolled JS-consumed landing pad that cannot call
   *  `markJsConsumedParam` at its construction site. Re-checked in BOTH
   *  directions: the param must still be unmarked (else delete this entry) AND
   *  still reach no declared output (else the claim is false). */
  | { kind: 'js-consumed-unmarked'; module: string; port: string; issue: number; why: string }
  /** A LIVE defect, filed and open. Re-checked: the port must STILL fail the
   *  same predicate every other port is held to. */
  | { kind: 'known-defect'; module: string; port: string; issue: number; why: string };

const EXEMPT: readonly Exemption[] = [
  // --- 1. AUDIO-RATE SUMS: correct `{node, input}` terminals, not defects.
  //        The worklet adds knob + CV per sample and clamps, which is why these
  //        are also the ports `cv-scale-registry.test.ts` carries in
  //        PASSTHROUGH_BY_DESIGN — `cvScale` would have no AudioParam to scale.
  ...([
    ['filter', 'cutoff', 'filter.dsp does `pow(2, 5*cv)` on a dedicated cutoffCv input for a +-5 octave sweep; the def declares paramTarget for the DOCS and the runtime deliberately ignores it (stated verbatim on the def).'],
    ['moog902', 'cv', 'Summing CONTROL INPUT to the VCA gain on a dedicated worklet input (1), added per-sample rather than routed onto an AudioParam.'],
    ['moog902', 'fcv', 'The SECOND summing control input to the same gain, on worklet input 2. ⚠ It shares `paramTarget: gain` with `cv` by design — two jacks that sum into one control — which is legitimate precisely because neither publishes an AudioParam, so the ALIASING leg has no object to collide.'],
    ['moog904a', 'cutoff_cv', 'Ladder cutoff CV is exponential and summed per-sample in the worklet; no AudioParam exists to sum onto.'],
    ['moog904a', 'reso_cv', 'Resonance CV is an additive clamp applied per-sample in the worklet; no AudioParam exists to sum onto.'],
    ['moog904b', 'cutoff_cv', 'Ladder cutoff CV is exponential and summed per-sample in the worklet; no AudioParam exists to sum onto.'],
    ['moog921a', 'freq_cv', 'Driver frequency CV is summed per-sample in the worklet ahead of the exponential converter.'],
    ['moog921a', 'width_cv', 'Pulse-width CV is summed with the WIDTH knob per sample and clamped to the duty range in the worklet.'],
    ['moog921Vco', 'width_cv', 'Pulse-width CV is summed with the WIDTH knob per sample and clamped to 0.02..0.98 in the worklet.'],
    ['wavetableVco', 'wavePos', 'The worklet does `wp = wpKnob + wpCv` per sample clamped 0..1 off a dedicated input, so a +-1 CV sweeps the whole table from the knob position. Verified live by art/scenarios/wavetable-vco/cv-path.test.ts.'],
  ] as const).map(([module, port, why]): Exemption => ({ kind: 'audio-rate-sum', module, port, why })),

  // --- 2. HAND-ROLLED JS-CONSUMED PADS.
  //        ⚠ wavesculpt.ts is in the WEBGL ATTEST BASIS
  //        (scripts/webgl-attest-lib.ts, AUDIO_WEBGL_MODULE_DEFS), so adding the
  //        one-line `markJsConsumedParam` call at its construction site would
  //        move the WebGL content hash and cost a real-GPU re-attest. These are
  //        named here instead, and the entries carry the same two-sided
  //        re-check the register does. Fold the mark in whenever wavesculpt next
  //        moves that hash for a real reason, and delete these.
  ...([
    'morph1_cv', 'morph2_cv', 'morph3_cv', 'morph4_cv',
    'pos_x', 'pos_y', 'pos_z', 'zoom', 'rot', 'scale', 'wiggle',
  ] as const).map((port): Exemption => ({
    kind: 'js-consumed-unmarked',
    module: 'wavesculpt',
    port,
    issue: 1661,
    why: 'Hand-rolled camera/morph shadow: a GainNode whose only edge is to an AnalyserNode, read by the module\'s own setInterval pump (readCamShadow) and pushed into the worklet. Correct by design; unmarked only because wavesculpt.ts sits in the WebGL attest basis.',
  })),

  // --- 3. LIVE DEFECTS.
  ...([1, 2, 3, 4, 5, 6, 7, 8] as const).map((n): Exemption => ({
    kind: 'known-defect',
    module: 'mixmstrs',
    port: `comp${n}`,
    issue: 1737,
    why: 'The comp macro publishes `compShadow[id].gain` on a GainNode the factory deliberately never connects downstream ("We DON\'T connect g downstream" is in the source, under a comment naming #1662). A cable on this port is bit-exactly audio-inert and so is clip automation of it. #1662 was CLOSED on the gate, not on a fix; #1737 tracks the live defect.',
  })),
];

// ---------------------------------------------------------------------------
// The structural reader
// ---------------------------------------------------------------------------

/** Everything the predicates below are allowed to look at, for ONE port. */
interface PortStructure {
  module: string;
  port: string;
  paramTarget: string;
  /** The handle answered for this declared port id at all. */
  hasRef: boolean;
  /** The port published an AudioParam (not the `{node, input}` fallback). */
  hasParam: boolean;
  /** The id of an EARLIER port on this module publishing the same AudioParam. */
  aliasOf?: string;
  /** The instrument found the node that OWNS this AudioParam. When false every
   *  host-derived field below is unknown rather than false, so the sweep asserts
   *  this population is empty instead of guessing (`hostResolved` is the
   *  instrument's own completeness check). */
  hostResolved: boolean;
  /** The param's host node is an AudioWorkletNode (has a `parameters` map). */
  hostIsWorklet: boolean;
  /** The host node can reach one of this module's declared output nodes. */
  hostReachesOutput: boolean;
  /** The host node is ALSO published as a declared output, or as a declared
   *  SIGNAL input (an input carrying no paramTarget of its own). */
  hostIsDeclaredIo: boolean;
  /** The construction site declared this param's consumer to be JavaScript. */
  jsConsumed: boolean;
}

/** node -> the set of nodes it connects to. A `connect(AudioParam)` is recorded
 *  as an edge to that param's HOST NODE — without that resolution the walk
 *  stops dead at every modulation junction and reads a correctly-wired module as
 *  unreachable. ⚠ That was a real instrument bug here: `swolevco`, whose #1661
 *  fix routes its shadows through WaveShaper LUTs into `gain.gain`, read as
 *  UNREACHABLE until this resolution was added. */
let edges = new Map<object, Set<object>>();
let paramHost = new Map<object, AudioNode>();
let restoreInstrument: (() => void) | undefined;
/** The realm's own `AudioParam` constructor, read off a live node rather than
 *  imported — `instanceof` against an imported class is wrong here, because the
 *  class that matters is whichever realm node-web-audio-api installed. */
let audioParamCtor: (new (...args: never[]) => AudioParam) | undefined;

/** Record every AudioParam a node owns, so `connect(param)` can be resolved. */
function registerNode(n: unknown): void {
  if (!n || typeof n !== 'object') return;
  for (let p = Object.getPrototypeOf(n); p && p !== Object.prototype; p = Object.getPrototypeOf(p)) {
    for (const key of Object.getOwnPropertyNames(p)) {
      const d = Object.getOwnPropertyDescriptor(p, key);
      if (!d?.get) continue;
      let v: unknown;
      try { v = (n as Record<string, unknown>)[key]; } catch { continue; }
      if (audioParamCtor && v instanceof audioParamCtor) paramHost.set(v as object, n as AudioNode);
    }
  }
  const params = (n as { parameters?: { forEach?: (cb: (v: AudioParam) => void) => void } }).parameters;
  if (params && typeof params.forEach === 'function') {
    try { params.forEach((v) => { paramHost.set(v as object, n as AudioNode); }); } catch { /* */ }
  }
}

function installInstrument(): void {
  const ctx = new OfflineAudioContext({ numberOfChannels: 1, length: 128, sampleRate: SR });
  const gain = ctx.createGain();
  const audioNodeProto = Object.getPrototypeOf(Object.getPrototypeOf(gain));
  const ctxProto = Object.getPrototypeOf(ctx);
  audioParamCtor = Object.getPrototypeOf(gain.gain).constructor as typeof audioParamCtor;

  const undo: Array<() => void> = [];
  const creatorProtos = [ctxProto, Object.getPrototypeOf(ctxProto)];
  for (const proto of creatorProtos) {
    if (!proto) continue;
    for (const name of Object.getOwnPropertyNames(proto)) {
      if (!name.startsWith('create')) continue;
      const orig = (proto as Record<string, unknown>)[name];
      if (typeof orig !== 'function') continue;
      (proto as Record<string, unknown>)[name] = function (this: object, ...a: unknown[]) {
        const n = (orig as (...x: unknown[]) => unknown).apply(this, a);
        registerNode(n);
        return n;
      };
      undo.push(() => { (proto as Record<string, unknown>)[name] = orig; });
    }
  }

  const origConnect = audioNodeProto.connect;
  audioNodeProto.connect = function (this: object, dest: object, ...rest: unknown[]) {
    registerNode(this);
    let s = edges.get(this);
    if (!s) { s = new Set(); edges.set(this, s); }
    if (dest && typeof dest === 'object') s.add(dest);
    return origConnect.call(this, dest, ...rest);
  };
  undo.push(() => { audioNodeProto.connect = origConnect; });

  restoreInstrument = () => { for (const f of undo) f(); };
}

/** A 128-sample render, which COMPLETES the context and releases its native
 *  render thread. See the header — omitting this is a 627x cost regression that
 *  presents as eleven modules "failing to materialise". */
async function release(ctx: OfflineAudioContext): Promise<void> {
  try { await ctx.startRendering(); } catch { /* a module may leave it unrenderable; the thread is freed either way */ }
}

/** Materialise ONE def and read the structure of every paramTarget port on it.
 *  ZERO renders of the module under test — only the release quantum. */
async function readStructure(def: AudioModuleDef): Promise<PortStructure[]> {
  edges = new Map();
  paramHost = new Map();
  const ctx = new OfflineAudioContext({ numberOfChannels: 1, length: 128, sampleRate: SR });
  let handle;
  try {
    handle = await def.factory(ctx as unknown as AudioContext, {
      id: 'cv-terminal', type: def.type, domain: 'audio',
      position: { x: 0, y: 0 }, params: {},
    } as never);
  } catch (e) {
    // Release BEFORE rethrowing. A factory that throws still leaves a live
    // context holding a native render thread, and leaking one here would slow
    // every module measured after it — i.e. one module's failure would present
    // as the whole sweep degrading. Name the module: this throw is the only
    // report a non-materialising def gets, by design (there is no
    // `harness-cannot-materialize` list to hide in).
    await release(ctx);
    throw new Error(
      `cv-terminal: ${String(def.type)}'s factory threw, so none of its paramTarget ` +
        `ports could be read — ${String((e as Error)?.message ?? e).slice(0, 160)}`,
      { cause: e },
    );
  }

  // ⚠ REGISTER ONLY — never `paramHost.set(r.param, r.node)`. A port's `node`
  // is where a CABLE lands, which is NOT in general where its `param` lives:
  // `polyseqz.humanize_cv` publishes `{node: clockInGain, param:
  // <ConstantSource>.offset}`, and #1734 records slewSwitch publishing `input:
  // 0` alongside its param. Overwriting the true host with `r.node` made the
  // LIVE PATH leg report `polyseqz.humanize_cv` as sitting in the signal path —
  // a false finding produced entirely by the instrument.
  for (const [, r] of handle.inputs) registerNode(r.node);
  for (const [, r] of handle.outputs) registerNode(r.node);

  const outNodes = new Set<AudioNode>();
  for (const [, r] of handle.outputs) outNodes.add(r.node);
  /** Nodes published for a declared SIGNAL input (one with no paramTarget). */
  const signalInNodes = new Set<AudioNode>();
  const paramTargetPortIds = new Set(def.inputs.filter((p) => p.paramTarget).map((p) => p.id));
  for (const [id, r] of handle.inputs) {
    if (!paramTargetPortIds.has(id)) signalInNodes.add(r.node);
  }

  const hostOf = (o: object): object | undefined => paramHost.get(o);
  const reaches = (start: object): boolean => {
    const seen = new Set<object>([start]);
    const stack = [start];
    while (stack.length) {
      const n = stack.pop()!;
      if (outNodes.has(n as AudioNode)) return true;
      for (const next of edges.get(n) ?? []) {
        // A `connect(AudioParam)` continues the walk at the param's HOST node.
        const h = hostOf(next) ?? next;
        if (!seen.has(h)) { seen.add(h); stack.push(h); }
      }
    }
    return false;
  };

  const owner = new Map<object, string>();
  const out: PortStructure[] = [];
  for (const port of def.inputs) {
    if (!port.paramTarget) continue;
    const ref = handle.inputs.get(port.id);
    const base = { module: String(def.type), port: port.id, paramTarget: port.paramTarget };
    if (!ref || !ref.param) {
      out.push({
        ...base, hasRef: !!ref, hasParam: false, hostResolved: true,
        hostIsWorklet: false, hostReachesOutput: false, hostIsDeclaredIo: false,
        jsConsumed: false,
      });
      continue;
    }
    const aliasOf = owner.get(ref.param);
    if (!aliasOf) owner.set(ref.param, port.id);
    const host = hostOf(ref.param) as AudioNode | undefined;
    out.push({
      ...base,
      hasRef: true,
      hasParam: true,
      aliasOf,
      hostResolved: !!host,
      hostIsWorklet: !!host && 'parameters' in (host as object),
      hostReachesOutput: !!host && reaches(host),
      hostIsDeclaredIo: !!host && (outNodes.has(host) || signalInNodes.has(host)),
      jsConsumed: isJsConsumedParam(ref.param),
    });
  }

  try { (handle as { dispose?(): void }).dispose?.(); } catch { /* */ }
  await release(ctx);
  return out;
}

// ---------------------------------------------------------------------------
// THE PREDICATES. One function per class, called by the sweep, by every
// exemption re-check AND by every control — so a control cannot drift from the
// check it claims to validate.
// ---------------------------------------------------------------------------

/** #1734: the cable lands on `{node, input}` instead of an AudioParam. */
const failsTerminal = (s: PortStructure): boolean => !s.hasRef || !s.hasParam;

/** #1661/#1662: the param's host reaches no declared output and nothing claimed
 *  its consumer is JavaScript. */
const failsReach = (s: PortStructure): boolean =>
  s.hasParam && !s.jsConsumed && !s.hostReachesOutput;

/** The JS-consumed claim is FALSE — it does reach live audio after all. */
const failsJsConsumedClaim = (s: PortStructure): boolean =>
  s.hasParam && s.jsConsumed && s.hostReachesOutput;

/** #1664, half one: two ports, one AudioParam object. */
const failsAliasing = (s: PortStructure): boolean => !!s.aliasOf;

/** #1664, half two: a native-node param sitting in the declared signal path.
 *  `hostReachesOutput` is part of the predicate, not a redundancy: the hazard is
 *  that a cable SCALES SIGNAL ON ITS WAY TO AN OUTPUT, so a declared-I/O node
 *  that carries nothing onward cannot produce it (a dead one is REACH's
 *  business, not this leg's). A declared output node satisfies it at distance
 *  zero, which is the scope/rasterize shape. */
const failsLivePath = (s: PortStructure): boolean =>
  s.hasParam && !s.hostIsWorklet && s.hostIsDeclaredIo && s.hostReachesOutput;

const key = (s: { module: string; port: string }) => `${s.module}.${s.port}`;
const exemptKeys = new Set(EXEMPT.map(key));
const exemptOfKind = (kind: Exemption['kind']) =>
  new Set(EXEMPT.filter((e) => e.kind === kind).map(key));

// ---------------------------------------------------------------------------
// SYNTHETIC CONTROLS — real defs with real factories, read by the REAL
// `readStructure`. Not registered anywhere; built and torn down here.
// ---------------------------------------------------------------------------

type ControlShape =
  | 'live' | 'dead-terminal' | 'js-consumed' | 'js-consumed-lying'
  | 'aliased' | 'live-path' | 'no-param';

function controlDef(shape: ControlShape): AudioModuleDef {
  return {
    type: `__control_${shape}`,
    domain: 'audio',
    label: shape,
    inputs: [
      { id: 'a', type: 'cv', paramTarget: 'a' },
      { id: 'b', type: 'cv', paramTarget: 'b' },
      { id: 'sig', type: 'audio' },
    ],
    outputs: [{ id: 'out', type: 'audio' }],
    params: [
      { id: 'a', defaultValue: 0, min: 0, max: 1, curve: 'linear' },
      { id: 'b', defaultValue: 0, min: 0, max: 1, curve: 'linear' },
    ],
    async factory(ctx: AudioContext) {
      const outBus = ctx.createGain();
      const padA = ctx.createGain();
      const padB = ctx.createGain();
      // `live`, `js-consumed-lying` and `live-path` route their pads onward.
      if (shape === 'live' || shape === 'js-consumed-lying') {
        padA.connect(outBus);
        padB.connect(outBus);
      }
      if (shape === 'js-consumed' || shape === 'js-consumed-lying') {
        markJsConsumedParam(padA.gain);
        markJsConsumedParam(padB.gain);
      }
      const inputs = new Map<string, { node: AudioNode; input: number; param?: AudioParam }>();
      if (shape === 'aliased') {
        // ONE param object on TWO ports — the #1664 shape.
        inputs.set('a', { node: padA, input: 0, param: padA.gain });
        inputs.set('b', { node: padA, input: 0, param: padA.gain });
        padA.connect(outBus);
      } else if (shape === 'live-path') {
        // The param sits on the node that IS the declared output and the
        // declared signal input — the rasterize.cursor 629 000x shape.
        inputs.set('a', { node: outBus, input: 0, param: outBus.gain });
        inputs.set('b', { node: padB, input: 0, param: padB.gain });
        padB.connect(outBus);
      } else if (shape === 'no-param') {
        inputs.set('a', { node: padA, input: 0 });
        inputs.set('b', { node: padB, input: 0, param: padB.gain });
        padA.connect(outBus);
        padB.connect(outBus);
      } else {
        inputs.set('a', { node: padA, input: 0, param: padA.gain });
        inputs.set('b', { node: padB, input: 0, param: padB.gain });
      }
      // The declared SIGNAL input. Its own node, except in `live-path`, where
      // the whole point is that the signal input, the output and the param's
      // host are ONE node (rasterize's `inGain`).
      const sigIn = ctx.createGain();
      sigIn.connect(outBus);
      inputs.set('sig', { node: shape === 'live-path' ? outBus : sigIn, input: 0 });
      return {
        domain: 'audio' as const,
        inputs,
        outputs: new Map([['out', { node: outBus, output: 0 }]]),
        setParam() { /* */ },
        readParam() { return undefined; },
        dispose() { /* */ },
      };
    },
  } as unknown as AudioModuleDef;
}

const readControl = (shape: ControlShape) => readStructure(controlDef(shape));

// ---------------------------------------------------------------------------

describe('every paramTarget CV input lands on a live, unaliased AudioParam', () => {
  let defs: AudioModuleDef[] = [];
  let structures: PortStructure[] = [];

  beforeAll(async () => {
    installInstrument();
    defs = collectAudioDefs().filter((d) => d.inputs.some((p) => p.paramTarget));
    for (const def of defs) structures.push(...(await readStructure(def)));
  }, 300_000);

  afterAll(() => { restoreInstrument?.(); });

  // ── the instrument, before any finding ───────────────────────────────────

  it('INSTRUMENT: the connect-graph and param-host resolution are live', async () => {
    expect(audioParamCtor, 'no AudioParam constructor — the instrument never installed').toBeTruthy();
    const live = await readControl('live');
    expect(live.map((s) => s.port).sort()).toEqual(['a', 'b']);
    // A positive control on the WHOLE reader: this shape must pass every leg.
    for (const s of live) {
      expect(failsTerminal(s), `${key(s)} terminal`).toBe(false);
      expect(failsReach(s), `${key(s)} reach`).toBe(false);
      expect(failsAliasing(s), `${key(s)} aliasing`).toBe(false);
      expect(failsLivePath(s), `${key(s)} live-path`).toBe(false);
    }
  }, 60_000);

  it('INSTRUMENT: is not vacuous — it read a real, populated registry', () => {
    expect(defs.length, 'no def declares a paramTarget input — enrolment is broken').toBeGreaterThan(0);
    expect(structures.length).toBeGreaterThan(defs.length);
    // Every enrolled def produced at least one row.
    const seen = new Set(structures.map((s) => s.module));
    expect([...defs.map((d) => String(d.type))].filter((t) => !seen.has(t))).toEqual([]);
  });

  it('INSTRUMENT: every published AudioParam was traced to its OWNING node', () => {
    // Three of the four legs are functions of the HOST node, so an unresolved
    // host is not a finding — it is the instrument failing to look, and the two
    // are indistinguishable from a green run. Asserted before any of them.
    const unresolved = structures.filter((s) => s.hasParam && !s.hostResolved).map(key);
    expect(
      unresolved,
      `the connect/create instrumentation never saw the node owning these params, so ` +
        `REACH, LIVE PATH and the worklet exemption are all UNKNOWN for them — not false. ` +
        `A node built before the instrument installed, or by a constructor the create* ` +
        `patch does not cover, is the usual cause.`,
    ).toEqual([]);
  });

  it('every DECLARED paramTarget port is answered by the live handle', () => {
    // Deliberately unconditional, and there is no harness exemption to pair it
    // with. `cv-param-reach` carried a nine-module `harness-cannot-materialize`
    // list; with `release()` in place the population of modules this harness
    // cannot build is EMPTY, so there is no mechanism to maintain.
    //
    // NOTE the division of labour: a def that cannot be BUILT throws out of
    // `readStructure` and names itself, which is louder than any list. This
    // assertion covers the quieter half — a def that builds fine but whose
    // handle simply has no entry for a port its own def declares, so the engine
    // would find nothing to connect a cable to.
    expect(structures.filter((s) => !s.hasRef).map(key)).toEqual([]);
  });

  // ── the four legs ────────────────────────────────────────────────────────

  it('TERMINAL: every paramTarget port publishes an AudioParam (#1734)', () => {
    const allowed = exemptOfKind('audio-rate-sum');
    const offenders = structures.filter(failsTerminal).map(key).filter((k) => !allowed.has(k));
    expect(
      offenders,
      `these paramTarget ports publish no AudioParam, so AudioEngine.addEdge silently ` +
        `falls back to {node, input} and the cable becomes SIGNAL into that input. ` +
        `Either publish the param, or declare an 'audio-rate-sum' exemption saying which ` +
        `worklet input sums it per-sample.`,
    ).toEqual([]);
  });

  it('REACH: every DSP-consumed param can reach a declared output (#1661/#1662)', () => {
    const allowed = new Set([...exemptOfKind('js-consumed-unmarked'), ...exemptOfKind('known-defect')]);
    const offenders = structures.filter(failsReach).map(key).filter((k) => !allowed.has(k));
    expect(
      offenders,
      `the AudioParam these ports publish sits on a node with no path to any of the ` +
        `module's own declared outputs, so a cable here is bit-exactly audio-inert while ` +
        `the engine's per-param tap still animates the motorized fader. If the consumer is ` +
        `JavaScript, say so at the construction site with markJsConsumedParam() ` +
        `(createCvShadow does it for you) — do not add a list entry.`,
    ).toEqual([]);
  });

  it('REACH, INVERSE: a param DECLARED js-consumed must not reach live audio', () => {
    const offenders = structures.filter(failsJsConsumedClaim).map(key);
    expect(
      offenders,
      `these params are registered as JS-consumed but DO reach a declared output. ` +
        `The declaration is false and a cable is landing on live audio — this is the ` +
        `#1664 shape wearing the fix's clothes.`,
    ).toEqual([]);
  });

  it('ALIASING: no two ports on one module share an AudioParam (#1664)', () => {
    // Unconditional and exemption-free by design: at most one of a shared pair
    // can be the real param, so there is no correct instance of this shape.
    const offenders = structures.filter(failsAliasing).map((s) => `${key(s)} aliases ${s.aliasOf}`);
    expect(offenders).toEqual([]);
  });

  it('LIVE PATH: no native-node param sits in the declared signal path (#1664)', () => {
    const offenders = structures.filter(failsLivePath).map(key);
    expect(
      offenders,
      `these ports publish an AudioParam belonging to a node that is ALSO a declared ` +
        `audio input or output — so a CV cable multiplies the through-signal instead of ` +
        `setting a control (rasterize.cursor measured 3.146e+5 peak against a 5.0e-1 ` +
        `baseline). ⚠ An AudioWorkletNode is exempt BY CONSTRUCTION: its named ` +
        `AudioParams are declared DSP parameters and cannot scale its audio inputs.`,
    ).toEqual([]);
  });

  // ── the exemptions are assertions, re-checked against live evidence ──────

  it('ANCHORED: every exempted (module, port) still exists and still declares paramTarget', () => {
    const declared = new Set(structures.map(key));
    const stale = [...exemptKeys].filter((k) => !declared.has(k));
    expect(
      stale,
      `named in EXEMPT but not a declared paramTarget port any more — delete the entry.`,
    ).toEqual([]);
  });

  it("'audio-rate-sum' entries still publish NO AudioParam", () => {
    const byKey = new Map(structures.map((s) => [key(s), s]));
    const fixed = [...exemptOfKind('audio-rate-sum')].filter((k) => !failsTerminal(byKey.get(k)!));
    expect(
      fixed,
      `these now publish an AudioParam, so the exemption is stale — delete it and let ` +
        `the TERMINAL leg hold them.`,
    ).toEqual([]);
  });

  it("'js-consumed-unmarked' entries are still unmarked AND still unreachable", () => {
    const byKey = new Map(structures.map((s) => [key(s), s]));
    const nowMarked: string[] = [];
    const nowReaching: string[] = [];
    for (const k of exemptOfKind('js-consumed-unmarked')) {
      const s = byKey.get(k)!;
      if (s.jsConsumed) nowMarked.push(k);
      if (s.hostReachesOutput) nowReaching.push(k);
    }
    expect(nowMarked, `now call markJsConsumedParam — delete these entries, membership is derived`).toEqual([]);
    expect(nowReaching, `now reach a declared output, so the js-consumed claim is false`).toEqual([]);
  });

  it("'known-defect' entries still FAIL the same predicate (#1737)", () => {
    const byKey = new Map(structures.map((s) => [key(s), s]));
    const healed = [...exemptOfKind('known-defect')].filter((k) => !failsReach(byKey.get(k)!));
    expect(
      healed,
      `these no longer fail REACH. If the defect was fixed, delete the entry and close ` +
        `the issue; a known-defect entry that passes is certifying nothing.`,
    ).toEqual([]);
  });

  // ── negative controls: every leg must be ABLE to fail, through the real reader ──

  it('NEGATIVE CONTROL: the #1661/#1662 dead terminal is CAUGHT by REACH', async () => {
    const rows = await readControl('dead-terminal');
    expect(rows.filter(failsReach).map((s) => s.port)).toEqual(['a', 'b']);
  }, 60_000);

  it('NEGATIVE CONTROL: the SAME graph, DECLARED js-consumed, is NOT caught', async () => {
    // The pair that proves the register is what separates the fix from the bug —
    // identical topology, opposite verdict, and the difference is the declaration.
    const rows = await readControl('js-consumed');
    expect(rows.filter(failsReach).map((s) => s.port)).toEqual([]);
    expect(rows.every((s) => s.jsConsumed)).toBe(true);
  }, 60_000);

  it('NEGATIVE CONTROL: a LYING js-consumed declaration is CAUGHT', async () => {
    const rows = await readControl('js-consumed-lying');
    expect(rows.filter(failsJsConsumedClaim).map((s) => s.port)).toEqual(['a', 'b']);
  }, 60_000);

  it('NEGATIVE CONTROL: the #1664 aliased param is CAUGHT by ALIASING', async () => {
    const rows = await readControl('aliased');
    expect(rows.filter(failsAliasing).map((s) => `${s.port}->${s.aliasOf}`)).toEqual(['b->a']);
  }, 60_000);

  it('NEGATIVE CONTROL: the #1664 live-path param is CAUGHT by LIVE PATH', async () => {
    const rows = await readControl('live-path');
    expect(rows.filter(failsLivePath).map((s) => s.port)).toEqual(['a']);
  }, 60_000);

  it('NEGATIVE CONTROL: a missing AudioParam is CAUGHT by TERMINAL', async () => {
    const rows = await readControl('no-param');
    expect(rows.filter(failsTerminal).map((s) => s.port)).toEqual(['a']);
  }, 60_000);

  // ── what this run actually covered ──────────────────────────────────────

  it('states its own coverage, DERIVED from the run', () => {
    const held = structures.filter((s) => !exemptKeys.has(key(s)));
    const lines = [
      `modules enrolled          ${defs.length}`,
      `paramTarget ports read    ${structures.length}`,
      `held to every predicate   ${held.length}`,
      `audio-rate-sum            ${exemptOfKind('audio-rate-sum').size}`,
      `js-consumed (derived)     ${structures.filter((s) => s.jsConsumed).length}`,
      `js-consumed (named)       ${exemptOfKind('js-consumed-unmarked').size}`,
      `known-defect              ${exemptOfKind('known-defect').size}`,
      `worklet-hosted params     ${structures.filter((s) => s.hostIsWorklet).length}`,
    ];
    process.stdout.write(`\n[cv-terminal] coverage\n  ${lines.join('\n  ')}\n`);
    // The gate here is that the held population is the MAJORITY of what is
    // declared — an assertion about the RELATION, never about either size.
    expect(held.length).toBeGreaterThan(structures.length - held.length);
  });
});
