// art/scenarios/cv-terminal/sample.test.ts
//
// THE BEHAVIOURAL SAMPLE — a SMALL, FIXED set of ports rendered as real audio,
// so the structural sweep beside this file keeps corresponding to something a
// player can hear.
//
// ---------------------------------------------------------------------------
// WHY IT EXISTS, AND WHY IT IS DELIBERATELY TINY
// ---------------------------------------------------------------------------
//
// `cv-terminal.test.ts` proves a cable LANDS somewhere live. Its first stated
// blind spot is that a graph edge never proves the value ARRIVES: all 83 live
// mixmstrs params sit on the one Faust worklet node that reaches the output, so
// REACH passes every one of them trivially, and a param declared in a `.dsp`
// but unused inside it is graph-perfect and audio-dead. Only a render can tell
// the difference.
//
// Owner ruling, 2026-08-16: *"a small behavioral sample is fine."* SMALL is the
// operative word and it is a REQUIREMENT, not a budget. `cv-param-reach` was
// this same idea scaled to the whole registry — a render per port over 340
// declared ports — and it grew into a 45-minute job whose timeout cancelled
// every main run and blocked the nightly production deploy (#1769).
//
// ⚠ SO: THIS LIST IS FIXED. It is a hand-authored sample, NOT an enrolment.
// Do NOT add an entry here because you added a module — the structural sweep
// enrols your module automatically and that is the whole design. Add one here
// only to cover a new SHAPE of terminal that no existing row exercises, and say
// which shape in the row's `why`. Five renders is the point; five hundred is
// the thing that was just deleted.
//
// The rows are chosen to span the structural verdicts, one port each:
//
//   worklet-hosted, reaches trivially   the population REACH is weakest on
//   native-node param in the chain      the ordinary DelayNode/GainNode shape
//   shadow routed back into the DSP     the #1661 fix's own shape
//
// ---------------------------------------------------------------------------
// THE INSTRUMENT
// ---------------------------------------------------------------------------
//
// Two renders per row against one control: peak |Δsample| in LINEAR AMPLITUDE
// (not dB, not RMS) — the same metric #1661 reported its 0.0000e+0 in. The CV
// leg wires a ConstantSource EXACTLY the way `AudioEngine.addEdge` does, into
// `inputs.get(port).param`, so this exercises the shipped delivery branch.
//
// A bit-exact zero is also what a BROKEN instrument returns, so every row
// carries its own positive control: `basePeak` asserts the control render is
// audible at all before any delta is believed, and MECH asserts that
// ConstantSource → GainNode.gain moves a render in this same harness. Without
// those two, "the cable is dead" and "the module was silent" are the same
// number.

import { describe, expect, it } from 'vitest';
import { OfflineAudioContext } from 'node-web-audio-api';
import { collectAudioDefs } from '../../../packages/web/src/lib/audio/modules';
import type { AudioModuleDef } from '../../../packages/web/src/lib/audio/module-registry';
import { isVideoCableType } from '../../../packages/web/src/lib/graph/types';
import { vcoTestSignal, gateTrain, triggerTrain, clockTrain, C4_HZ } from '../../setup/drivers';

const SR = 48_000;
/** ⚠ MUST outlast the longest default time-constant any sampled module has, or
 *  a row reads a FALSE NULL. At 0.25 s this window was exactly `delay`'s own
 *  default TIME, so the wet signal never arrived inside it, both renders were
 *  pure dry, and `delay.time` measured 0.0000e+0 — indistinguishable from the
 *  dead-terminal defect this file exists to rule out. The per-row `basePeak`
 *  control cannot catch that one: the module WAS audible, just not through the
 *  path under test. */
const DURATION_S = 0.5;

/** ONE row per SHAPE of terminal. `why` is required by the type, and it must
 *  say which shape the row covers — not what the module is. */
interface SampleRow {
  module: string;
  port: string;
  /** CV offset to wire, in the param's own units. Far enough from the default
   *  that a live path cannot read zero by coincidence. */
  cv: number;
  why: string;
}

const SAMPLE: readonly SampleRow[] = [
  {
    module: 'mixmstrs', port: 'ch1_volume', cv: -0.8,
    why: 'WORKLET-HOSTED, REACHES TRIVIALLY — the shape REACH is weakest on: every param on a single-worklet Faust module sits on the node that IS the output, so the structural leg passes it for free. This row is the one that would notice a Faust param declared in the .dsp and unused inside it. Also the module carrying the live #1662 defect, so its healthy ports must be demonstrably healthy.',
  },
  {
    module: 'delay', port: 'time', cv: -0.15,
    why: 'NATIVE-NODE PARAM IN THE CHAIN — a DelayNode.delayTime published directly, reachable but not itself declared I/O. The ordinary non-worklet shape, and the one LIVE PATH has to leave alone. NEGATIVE on purpose: it SHORTENS the 0.25 s default so the echo lands well inside the render window (a positive offset pushes it past the end and reads a false null).',
  },
  {
    module: 'swolevco', port: 'timbre', cv: 0.6,
    why: 'SHADOW ROUTED BACK INTO THE DSP — the #1661 fix\'s own shape: a shadow GainNode whose value re-enters the audio graph through a WaveShaper LUT rather than being read in JS. Structurally this is the case that needed connect(AudioParam) resolution to read as reachable at all, so it is the row most worth confirming by ear.',
  },
];

// ---------------------------------------------------------------------------

function audioIshOutputs(def: AudioModuleDef): string[] {
  return def.outputs
    .filter((o) => !isVideoCableType(o.type) && !/midi/i.test(String(o.type)))
    .map((o) => o.id);
}

/** Canonical driver per cable type — the same vocabulary the ART audio profiles
 *  use, so "driven" means one thing across the lane. */
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
    const b = new Float32Array(Math.round(SR * DURATION_S)); // ADR-004: full-scale modulator is ±1
    for (let i = 0; i < b.length; i++) b[i] = Math.sin((2 * Math.PI * 3 * i) / SR);
    return b;
  }
  return null;
}

/** Render one leg: every non-paramTarget input driven, optionally a CV cable on
 *  the port under test wired the way `AudioEngine.addEdge` wires one. */
async function render(
  def: AudioModuleDef,
  outIds: readonly string[],
  cv?: { portId: string; value: number },
): Promise<Float32Array[]> {
  const ctx = new OfflineAudioContext({
    numberOfChannels: Math.max(1, outIds.length),
    length: Math.round(SR * DURATION_S),
    sampleRate: SR,
  });
  const handle = await def.factory(ctx as unknown as AudioContext, {
    id: 'cv-terminal-sample', type: def.type, domain: 'audio',
    position: { x: 0, y: 0 }, params: {},
  } as never);

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

  if (cv) {
    const ref = handle.inputs.get(cv.portId);
    if (!ref) throw new Error(`sample: no input port '${cv.portId}' on ${String(def.type)}`);
    if (!ref.param) throw new Error(`sample: '${cv.portId}' publishes no AudioParam`);
    const cs = ctx.createConstantSource();
    cs.offset.value = cv.value;
    cs.start(0);
    // The engine's `din.param` branch (engine.ts addEdge). ⚠ addEdge additionally
    // inserts an `attachCvScale` WaveShaper ahead of this junction, so `cv` here
    // is in the param's OWN units rather than the ±1 a cable would carry. That
    // is deliberate — this file is asking whether the terminal is audible, not
    // whether the scaling is right; `cv-scale-registry` owns the latter.
    cs.connect(ref.param);
  }

  const merger = ctx.createChannelMerger(Math.max(1, outIds.length));
  outIds.forEach((id, k) => {
    const out = handle.outputs.get(id);
    if (out) out.node.connect(merger, out.output, k);
  });
  merger.connect(ctx.destination);
  const rendered = await ctx.startRendering();
  return outIds.map((_, k) => rendered.getChannelData(k).slice());
}

/** Peak |Δsample| across every captured output — LINEAR AMPLITUDE. */
function peakDelta(a: Float32Array[], b: Float32Array[]): number {
  let m = 0;
  for (let c = 0; c < a.length; c++) {
    const x = a[c]!, y = b[c]!;
    for (let i = 0; i < x.length; i++) m = Math.max(m, Math.abs(x[i]! - y[i]!));
  }
  return m;
}

function peakOf(chans: Float32Array[]): number {
  let m = 0;
  for (const ch of chans) for (const v of ch) m = Math.max(m, Math.abs(v));
  return m;
}

// ---------------------------------------------------------------------------

describe('behavioural sample: a structurally-live terminal is an AUDIBLE terminal', () => {
  it('MECH: ConstantSource → GainNode.gain moves a render in THIS harness', async () => {
    // The positive control on the MECHANISM, before any module is judged. If
    // this ever reads zero, every zero below is a harness artifact and not a
    // finding — which is exactly how a dead instrument looks like a dead module.
    const mech = async (cv: number): Promise<Float32Array[]> => {
      const ctx = new OfflineAudioContext({ numberOfChannels: 1, length: Math.round(SR * 0.05), sampleRate: SR });
      const osc = ctx.createOscillator();
      const g = ctx.createGain();
      g.gain.value = 0.5;
      osc.connect(g); g.connect(ctx.destination); osc.start(0);
      if (cv) { const cs = ctx.createConstantSource(); cs.offset.value = cv; cs.start(0); cs.connect(g.gain); }
      const r = await ctx.startRendering();
      return [r.getChannelData(0).slice()];
    };
    const delta = peakDelta(await mech(0), await mech(0.4));
    expect(delta, `MECH read ${delta.toExponential(4)} peak |Δsample| — the harness cannot modulate an AudioParam at all`).toBeGreaterThan(0);
  }, 120_000);

  it('the sample names only REAL, paramTarget-declared ports', () => {
    // ANCHORED: a row naming something that no longer exists is RED, not skipped.
    const defs = new Map(collectAudioDefs().map((d) => [String(d.type), d]));
    const bad = SAMPLE.filter((r) => {
      const def = defs.get(r.module);
      return !def || !def.inputs.some((p) => p.id === r.port && p.paramTarget);
    }).map((r) => `${r.module}.${r.port}`);
    expect(bad, `sample rows naming a port that is not a declared paramTarget input`).toEqual([]);
    // Every `why` must say something. Prose-quality floor, not a population count.
    expect(SAMPLE.filter((r) => r.why.length < 80).map((r) => r.port)).toEqual([]);
  });

  for (const row of SAMPLE) {
    it(`${row.module}.${row.port}: a CV cable AUDIBLY moves the output`, async () => {
      const def = collectAudioDefs().find((d) => String(d.type) === row.module)!;
      const outIds = audioIshOutputs(def);
      const control = await render(def, outIds);
      const patched = await render(def, outIds, { portId: row.port, value: row.cv });

      const basePeak = peakOf(control);
      // POSITIVE CONTROL, per row: a silent control render makes any delta
      // meaningless — "the cable is dead" and "the module made no sound" are
      // the same 0.0000e+0 without this.
      expect(
        basePeak,
        `${row.module} rendered SILENT with nothing patched (peak ${basePeak.toExponential(4)}), ` +
          `so this row proves nothing about ${row.port}. Fix the base patch, do not weaken the delta.`,
      ).toBeGreaterThan(0);

      const delta = peakDelta(control, patched);
      expect(
        delta,
        `${row.module}.${row.port} with CV ${row.cv}: peak |Δsample| = ${delta.toExponential(4)} ` +
          `(linear amplitude) against a control peak of ${basePeak.toExponential(4)}. ` +
          `The structural sweep says this terminal reaches the output; the render says the ` +
          `value never arrives — a graph-perfect, audio-dead param.`,
      ).toBeGreaterThan(0);
    }, 120_000);
  }
});
