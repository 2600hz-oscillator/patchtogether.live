// packages/web/src/lib/audio/workflow-audio-verdict.ts
//
// DID THIS WORKFLOW DISRUPT THE OUTPUT? — one pass/fail verdict over the three
// instruments that can answer, and an explicit list of the ones that COULDN'T.
//
// ── WHY A COMBINED VERDICT, AND WHY IT REPORTS ITS OWN BLINDNESS ───────────
// The three legs fail on DIFFERENT diseases and each is blind to the others:
//
//   DEVICE   `playbackStats` underruns (playback-stats.ts). The only detector
//            for output starvation and device-callback repeats — and VACUOUS on
//            headless CI, where a null audio sink means an underrun literally
//            cannot occur.
//   MAIN     scheduler tick lateness (tick-latency.ts). Main-thread saturation
//            — the term this repo's own record blames for the drag-glitch and
//            for `video/pull-eval.ts`'s "video pipeline starves the audio output
//            buffer". Blind to anything inside the audio graph.
//   GRAPH    the continuity probe (continuity-probe.ts). Silence, clicks,
//            frozen buffers, a stalled worklet. The only leg that CAN go red on
//            a headless runner — and structurally unable to see a device
//            underrun, because starvation happens BELOW every graph tap.
//
// A save that moves work to a Worker makes the GRAPH leg green by construction
// while the main thread still stalls and the video outputs still freeze. A
// headless run makes the DEVICE leg green by construction. So the dangerous
// failure is not a leg going red — it is a verdict that is green because every
// leg that could have failed was switched off. `blind` names those legs, and a
// verdict with no live legs is NOT a pass.
//
// PURE + framework-free: plain snapshots in, verdict out. No clock, no DOM.

import type { AudioHealthSnapshot } from './playback-stats';
import { diffAudioHealth } from './playback-stats';
import type { TickLatencyStats } from './tick-latency';
import type { ContinuityViolation } from './continuity-probe';

/** Which instrument produced a finding (or could not). */
export type WorkflowAudioLeg = 'device' | 'main' | 'graph';

export interface WorkflowAudioFinding {
  leg: WorkflowAudioLeg;
  /** Machine-readable cause. Graph findings reuse the probe's own kinds. */
  kind: string;
  /** The measured value that broke the limit. */
  value: number;
  /** The limit it broke. */
  limit: number;
}

export interface WorkflowAudioBlindness {
  leg: WorkflowAudioLeg;
  /** Why this leg could not have gone red for this run. */
  reason: string;
}

export interface WorkflowAudioVerdict {
  /** True only when at least one leg was LIVE and no leg found anything. */
  pass: boolean;
  /** Everything that went wrong, across every live leg. */
  findings: WorkflowAudioFinding[];
  /** Legs that were structurally unable to fail. Read this before believing a
   *  pass — and quote it when reporting one. */
  blind: WorkflowAudioBlindness[];
  /** Legs that were actually capable of failing. `pass` is meaningless if empty. */
  live: WorkflowAudioLeg[];
}

export interface WorkflowAudioThresholds {
  /** Device starvation events tolerated across the workflow. Default 0. */
  maxUnderrunEvents: number;
  /** Scheduler ticks arriving a WHOLE period late, tolerated. Default 0. */
  maxOverBudgetTicks: number;
  /** Worst single tick lateness tolerated, ms. 0 disables the percentile leg. */
  maxTickLatenessMs: number;
}

export const DEFAULT_WORKFLOW_AUDIO_THRESHOLDS: WorkflowAudioThresholds = Object.freeze({
  maxUnderrunEvents: 0,
  maxOverBudgetTicks: 0,
  maxTickLatenessMs: 0,
});

export interface WorkflowAudioInput {
  /** Device-layer snapshots taken either side of the workflow. */
  health?: { before: AudioHealthSnapshot; after: AudioHealthSnapshot } | null;
  /** Scheduler tick stats either side of the workflow. */
  tick?: { before: TickLatencyStats | null; after: TickLatencyStats | null } | null;
  /** Graph-continuity violations collected during the workflow. An EMPTY ARRAY
   *  means "the probe ran and found nothing"; `null`/absent means "no probe",
   *  which is a blind leg, not a clean one. */
  graph?: ContinuityViolation[] | null;
}

/**
 * Judge one workflow. PURE.
 *
 * ⚠ AN EMPTY ARRAY AND A MISSING ONE ARE DIFFERENT ANSWERS. `graph: []` is "the
 * probe ran and saw nothing"; `graph: undefined` is "there was no probe". The
 * first is evidence, the second is an absence of it, and collapsing them is how
 * a deleted instrument keeps a gate green.
 */
export function evaluateWorkflowAudio(
  input: WorkflowAudioInput,
  thresholds: Partial<WorkflowAudioThresholds> = {},
): WorkflowAudioVerdict {
  const t = { ...DEFAULT_WORKFLOW_AUDIO_THRESHOLDS, ...thresholds };
  const findings: WorkflowAudioFinding[] = [];
  const blind: WorkflowAudioBlindness[] = [];
  const live: WorkflowAudioLeg[] = [];

  // ── DEVICE ───────────────────────────────────────────────────────────────
  if (!input.health) {
    blind.push({ leg: 'device', reason: 'no playbackStats snapshots were taken' });
  } else {
    const d = diffAudioHealth(input.health.before, input.health.after);
    if (!d.supported) {
      blind.push({
        leg: 'device',
        reason: 'playbackStats unsupported (Firefox/Safari, or a context swap mid-workflow)',
      });
    } else if (d.totalSec <= 0) {
      // No output time elapsed between the snapshots: nothing could have been
      // starved, so a zero is arithmetic rather than evidence. This is also the
      // shape a null audio sink produces on a headless runner.
      blind.push({
        leg: 'device',
        reason: 'no output time elapsed between snapshots (a null sink cannot underrun)',
      });
    } else {
      live.push('device');
      if (d.underrunEvents > t.maxUnderrunEvents) {
        findings.push({
          leg: 'device',
          kind: 'underrun',
          value: d.underrunEvents,
          limit: t.maxUnderrunEvents,
        });
      }
    }
  }

  // ── MAIN THREAD ──────────────────────────────────────────────────────────
  const tb = input.tick?.before ?? null;
  const ta = input.tick?.after ?? null;
  if (!ta) {
    blind.push({ leg: 'main', reason: 'no scheduler clock was running (nothing started it)' });
  } else if (tb && ta.samples - tb.samples <= 0) {
    // The clock did not tick during the workflow, so lateness cannot have been
    // observed. Distinct from "it ticked and was on time".
    blind.push({ leg: 'main', reason: 'the scheduler clock did not tick during the workflow' });
  } else {
    live.push('main');
    const overBudget = ta.overBudget - (tb?.overBudget ?? 0);
    if (overBudget > t.maxOverBudgetTicks) {
      findings.push({
        leg: 'main',
        kind: 'tickOverBudget',
        value: overBudget,
        limit: t.maxOverBudgetTicks,
      });
    }
    if (t.maxTickLatenessMs > 0 && ta.p99Ms > t.maxTickLatenessMs) {
      findings.push({
        leg: 'main',
        kind: 'tickLateness',
        value: ta.p99Ms,
        limit: t.maxTickLatenessMs,
      });
    }
  }

  // ── GRAPH ────────────────────────────────────────────────────────────────
  if (!input.graph) {
    blind.push({ leg: 'graph', reason: 'no continuity probe was mounted' });
  } else {
    live.push('graph');
    for (const v of input.graph) {
      findings.push({ leg: 'graph', kind: v.kind, value: v.value, limit: v.limit });
    }
  }

  return { pass: live.length > 0 && findings.length === 0, findings, blind, live };
}

/** One-line summary for a trace or a report. Always names the blind legs, so a
 *  pass can never be quoted without the caveat that produced it. */
export function formatWorkflowAudioVerdict(v: WorkflowAudioVerdict): string {
  const head = v.pass ? 'PASS' : v.live.length === 0 ? 'NO EVIDENCE' : 'FAIL';
  const found = v.findings.length
    ? ` — ${v.findings.map((f) => `${f.leg}:${f.kind}(${f.value}>${f.limit})`).join(', ')}`
    : '';
  const legs = ` [live: ${v.live.join('+') || 'none'}]`;
  const blindTxt = v.blind.length ? ` [blind: ${v.blind.map((b) => b.leg).join('+')}]` : '';
  return `${head}${found}${legs}${blindTxt}`;
}
