// packages/web/src/lib/ui/example-patches/gibribbon-demo-calibration.test.ts
//
// REAL-CHAIN calibration guard for the bundled GIBRIBBON demo
// (gibribbon-demo.imp.json). This is the regression test the SYNESTHESIA #698
// retune (PR #701) rests on.
//
// The demo's signal chain is:
//   TIMELORDE → MACSEQ → MACROOSCILLATOR → SYNESTHESIA(copy A) → GIBRIBBON
// The four SLOW SYNESTHESIA env-followers (a_band{1..4}_env_slow) become
// GIBRIBBON cv1..cv4 → loop/jump/imp/zombie events (via GIB_TUNING.cvEventMap).
//
// WHY a separate test from the existing "Phase-2 demo CV calibration" in
// gibribbon-events.test.ts: that one is PURELY SYNTHETIC — it hand-models four
// idealized raised-cosine envelopes and never touches renderSynesthesia or the
// demo's actual gains, so it stayed green THROUGH the #698 refactor that killed
// jump+imp AND through the fix that revived them. It cannot guard the gains.
//
// THIS test drives the demo's EXACT sequenced MACROOSCILLATOR voice (the
// 128-step kick/snare/melodic pattern + the macro/synesthesia params decoded
// straight from the committed Y.Doc blob — the blob is the source of truth)
// through the REAL renderSynesthesia DSP at the demo's REAL gains, samples the
// slow-env CV per GIBRIBBON tick, and pushes it through the real
// clockTick→chooseSpawn pipeline. It asserts ALL FOUR event kinds spawn (none
// dead), none floods, and the total rate sits in a playable band. So the NEXT
// synesthesia band/attack/gain change that silently re-kills a channel fails CI.
//
// macrooscillatorMath.render is the pure-math mirror of the worklet (same path
// the macrooscillator unit tests + ART use); renderSynesthesia is the same DSP
// the synesthesia unit tests import. No AudioWorklet / WebGL needed.

import { describe, it, expect } from 'vitest';
import * as Y from 'yjs';
import { macrooscillatorMath, type MacroParams } from '$lib/audio/modules/macrooscillator';
import { renderSynesthesia } from '../../../../../dsp/src/lib/synesthesia-dsp';
import { midiToVOct } from '$lib/audio/note-entry';
import {
  newGame,
  clockTick,
  judgePress,
  EVENT_BUTTON,
  GIB_TUNING,
  type GibEventKind,
} from '$lib/video/modules/gibribbon-events';
import { parseEnvelope } from '$lib/graph/persistence';
import { GIBRIBBON_DEMO_ENVELOPE_RAW } from './gibribbon-demo';

// ── Demo transport math (TIMELORDE bpm=120; see build-gibribbon-demo-envelope.mjs).
//   2× (8th)     = 0.25 s clocks MACSEQ → 1 MACSEQ step = 0.25 s.
//   1× (quarter) = 0.50 s is GIBRIBBON's scroll clock → 1 GIB tick = 2 steps.
const SR = 48000;
const STEP_SECS = 0.25;
const GIB_TICK_SECS = 0.5;
const STEP_SAMPLES = Math.round(STEP_SECS * SR);
const GIB_TICK_SAMPLES = Math.round(GIB_TICK_SECS * SR);

// The demo's SYNESTHESIA copy-A gains. Kept here as the test's source of truth
// for the assertions; the separate "blob ↔ script gains" guard in
// gibribbon-demo.test.ts proves the committed blob actually carries these.
const DEMO_MASTER = 1.2;
const DEMO_GAINS: [number, number, number, number] = [1.4, 2.35, 3.9, 1.9];
// The OLD (pre-#698) gains that left jump+imp dead — used by the negative-guard
// test below to prove this calibration test really would catch a regression.
const OLD_MASTER = 1.35;
const OLD_GAINS: [number, number, number, number] = [1.5, 1.6, 1.7, 1.8];

interface DemoStep {
  on: boolean;
  midi: number | null;
  model: number | null;
}

// ── Decode the demo straight from the committed Y.Doc blob (source of truth). ─
function decodeDemoDoc(): Y.Doc {
  const env = parseEnvelope(JSON.stringify(GIBRIBBON_DEMO_ENVELOPE_RAW));
  const doc = new Y.Doc();
  Y.applyUpdate(
    doc,
    Uint8Array.from(atob(env.update), (c) => c.charCodeAt(0)),
  );
  return doc;
}

function nodeOfType(doc: Y.Doc, type: string): Record<string, unknown> {
  const nodes = doc.getMap('nodes').toJSON();
  const n = Object.values(nodes).find(
    (m): m is Record<string, unknown> => (m as { type?: string })?.type === type,
  );
  if (!n) throw new Error(`no ${type} node in demo blob`);
  return n;
}

function demoSteps(doc: Y.Doc): DemoStep[] {
  const ms = nodeOfType(doc, 'macseq');
  const steps = (ms.data as { steps?: DemoStep[] })?.steps;
  if (!Array.isArray(steps)) throw new Error('macseq node has no steps[]');
  return steps;
}

function demoMacroParams(doc: Y.Doc): MacroParams {
  return nodeOfType(doc, 'macrooscillator').params as MacroParams;
}

// ── Render the sequenced MACROOSCILLATOR voice the demo plays. ────────────────
// Each MACSEQ step drives the macro voice for STEP_SAMPLES with the step's model
// (MACSEQ.modelcv → MACROOSCILLATOR.model_cv, a discrete CV that round-trips to
// the same integer) at the step's pitch (MACSEQ.pitch → V/oct). A gated-OFF step
// is silence (the macro voice is un-triggered). macrooscillatorMath.render
// re-seeds the drum/string excitation each call, mirroring the per-step gate
// rising edge that retriggers KICK/SNARE/STRING in the real worklet.
function renderDemoVoice(steps: DemoStep[], macro: MacroParams): Float32Array {
  const out = new Float32Array(steps.length * STEP_SAMPLES);
  let off = 0;
  for (const s of steps) {
    if (s.on && s.model != null) {
      const pitchV = midiToVOct(s.midi ?? 48);
      const { main } = macrooscillatorMath.render(STEP_SAMPLES, SR, pitchV, {
        ...macro,
        model: s.model,
        note: 0,
      });
      out.set(main, off);
    }
    off += STEP_SAMPLES;
  }
  return out;
}

// Sample each of the 4 slow envelopes at every GIBRIBBON clock tick.
function cvPerTick(envSlow: Float32Array[], nTicks: number): number[][] {
  const rows: number[][] = [];
  for (let t = 0; t < nTicks; t++) {
    const i = Math.min(envSlow[0]!.length - 1, t * GIB_TICK_SAMPLES);
    rows.push([envSlow[0]![i]!, envSlow[1]![i]!, envSlow[2]![i]!, envSlow[3]![i]!]);
  }
  return rows;
}

// MACSEQ.gate → GIBRIBBON.gate. A GIB tick covers MACSEQ steps 2t, 2t+1; the
// gate reads HIGH if either step is gated on (kick/snare/voice) — the on-beat
// bias that lets the strongest channel spawn.
function gatePerTick(steps: DemoStep[], nTicks: number): boolean[] {
  const g: boolean[] = [];
  for (let t = 0; t < nTicks; t++) g.push(!!steps[2 * t]?.on || !!steps[2 * t + 1]?.on);
  return g;
}

interface PipelineResult {
  spawned: GibEventKind[];
  counts: Record<GibEventKind, number>;
  nTicks: number;
}

// Push the per-tick CV + gate through the REAL gibribbon pipeline. Simulates a
// competent player (clears in-window events) so the marine survives and we
// measure the full-window spawn rate, not a truncated up-to-gameover rate.
function runDemoPipeline(
  steps: DemoStep[],
  macro: MacroParams,
  master: number,
  gains: [number, number, number, number],
): PipelineResult {
  const voice = renderDemoVoice(steps, macro);
  const rendered = renderSynesthesia(voice, { sr: SR, master, gains });
  const nTicks = Math.floor(voice.length / GIB_TICK_SAMPLES);
  const cv = cvPerTick(rendered.envSlow, nTicks);
  const gate = gatePerTick(steps, nTicks);

  const s = newGame(0xc0de);
  const spawned: GibEventKind[] = [];
  let prevId = s.nextEventId;
  for (let t = 0; t < nTicks; t++) {
    clockTick(s, cv[t]!, gate[t]!);
    if (s.nextEventId > prevId) {
      const just = s.events.find((e) => e.id === s.nextEventId - 1);
      if (just) spawned.push(just.kind);
      prevId = s.nextEventId;
    }
    for (const ev of [...s.events]) {
      if (!ev.resolved && Math.abs(ev.pos) <= GIB_TUNING.hitWindow) {
        judgePress(s, EVENT_BUTTON[ev.kind]);
      }
    }
  }
  const counts: Record<GibEventKind, number> = { loop: 0, jump: 0, imp: 0, zombie: 0 };
  for (const k of spawned) counts[k] += 1;
  return { spawned, counts, nTicks };
}

describe('GIBRIBBON demo — real-chain SYNESTHESIA calibration (#698 retune guard)', () => {
  const doc = decodeDemoDoc();
  const steps = demoSteps(doc);
  const macro = demoMacroParams(doc);

  it('renders a non-silent sequenced voice and a non-trivial number of ticks', () => {
    const voice = renderDemoVoice(steps, macro);
    expect(voice.length).toBe(steps.length * STEP_SAMPLES);
    // The voice carries real energy (not all-zero) so renderSynesthesia has
    // something to analyse.
    let peak = 0;
    for (let i = 0; i < voice.length; i++) {
      const a = Math.abs(voice[i]!);
      if (a > peak) peak = a;
    }
    expect(peak).toBeGreaterThan(0.05);
    // 128 steps × 0.25 s = 32 s = 64 GIBRIBBON ticks.
    expect(Math.floor(voice.length / GIB_TICK_SAMPLES)).toBe(64);
  });

  it('ALL FOUR event kinds spawn at the demo gains — none dead', () => {
    const { counts } = runDemoPipeline(steps, macro, DEMO_MASTER, DEMO_GAINS);
    expect(counts.loop, 'loop (cv1) must spawn').toBeGreaterThanOrEqual(1);
    expect(counts.jump, 'jump (cv2) must spawn').toBeGreaterThanOrEqual(1);
    expect(counts.imp, 'imp (cv3) must spawn').toBeGreaterThanOrEqual(1);
    expect(counts.zombie, 'zombie (cv4) must spawn').toBeGreaterThanOrEqual(1);
  });

  it('no single channel floods (per-kind spawn share is bounded)', () => {
    const { counts, spawned } = runDemoPipeline(steps, macro, DEMO_MASTER, DEMO_GAINS);
    const total = spawned.length;
    expect(total).toBeGreaterThan(0);
    // No one kind may own more than half the spawns (a flooded channel starves
    // the others even if they technically fire ≥1).
    for (const kind of ['loop', 'jump', 'imp', 'zombie'] as GibEventKind[]) {
      expect(counts[kind] / total, `${kind} share`).toBeLessThanOrEqual(0.5);
    }
  });

  it('the total spawn rate is playable (~0.39 spawns/tick, band 0.3–0.5)', () => {
    const { spawned, nTicks } = runDemoPipeline(steps, macro, DEMO_MASTER, DEMO_GAINS);
    const perTick = spawned.length / nTicks;
    expect(perTick).toBeGreaterThanOrEqual(0.3);
    expect(perTick).toBeLessThanOrEqual(0.5);
  });

  // NEGATIVE GUARD: prove this test really catches a band/gain regression. With
  // the OLD (pre-#698) gains the same real chain leaves jump+imp DEAD — exactly
  // the bug the retune fixed. If a future edit reverts to a calibration that
  // kills a channel, the "ALL FOUR" assertion above fails the same way.
  it('FAILS-SAFE: the OLD pre-#698 gains leave jump + imp dead (the bug)', () => {
    const { counts } = runDemoPipeline(steps, macro, OLD_MASTER, OLD_GAINS);
    // Demonstrates the regression the new gains fix: at least one mid band dead.
    expect(counts.jump + counts.imp).toBe(0);
    // loop + zombie still fired under the old gains (only the mids died).
    expect(counts.loop).toBeGreaterThanOrEqual(1);
    expect(counts.zombie).toBeGreaterThanOrEqual(1);
  });
});
