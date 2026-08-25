// packages/web/src/lib/ui/modules/clocked-runner-cell-actions.ts
//
// The CLOCKED RUNNER faceplate's cell seam — the module-owned end of its one
// ranked cell, kept out of `shell-cells.ts` so the shared registry imports one
// file per module rather than the module's whole world (the
// `midi-lane-cell-actions` idiom).
//
// ── WHY THE DIVISION IS A `node.data` SELECTOR AND NOT A PARAM ──────────────
//
// `clockedRunnerDef` declares `params: []`. The division lives on `node.data`
// because the module is SPAWNED BY A SCRIPT rather than by a player — the
// runtime writes `{ name, division, source, ownerNodeId }` straight into the
// node's data when `clocked(division, fn)` is invoked (`$lib/livecode/runtime`)
// — and the factory reads it back off the live patch on EVERY TICK, so a change
// takes effect on the next boundary with no restart. `ShellSelectorCell` reads
// and writes `node.data` through closures by design, so the face needs no
// contract migration to be complete. Turning it into a `ParamDef` is a real and
// probably good idea (it would buy automation, CV and a Push 2 slot) and it is
// deliberately NOT bundled into a promotion: it needs a saved-patch read order,
// a contract-lock line and an engine `setParam` path the runner does not have.
//
// ── WHY A SELECTOR AND NOT A SEGMENTED PARAM ────────────────────────────────
//
// The SELECTABILITY trap is about a few-state DISCRETE PARAM drawn as a knob:
// two reachable positions across the whole dial, so a drag quantises back to
// where it started. It does not arise here at all, because there is no param —
// a `node.data` roster has no dial to be inert on. What DOES decide the shape
// is width and parity: `CLOCKED_DIVISIONS` is nine entries, a `selector` is a
// flat 168 CSS px against a segmented cell's 94.3-430.9, and the LEGACY CARD's
// own affordance is a `<select>` dropdown (`data-testid="clocked-runner-division"`).
// The parity-correct primitive and the narrow one are the same one.
//
// ⚠ THE ROSTER IS IMPORTED, NEVER RE-TYPED. `CLOCKED_DIVISIONS` is the same
// literal tuple `divisionToBeatsPerTick` switches on and the same one
// `ClockedRunnerCard.svelte` renders its `<option>`s from, so the picker cannot
// offer a division the tick maths has no branch for. That is the ONE-PLACE rule
// the range gates enforce at the source level, applied to a roster.

import { mutateNode } from '$lib/graph/mutate';
import { getActiveEngine } from '$lib/audio/engine-ref';
import { patch } from '$lib/graph/store';
import type { SelectorOption } from '$lib/ui/controls';
import type { ModuleNode } from '$lib/graph/types';
import {
  CLOCKED_RUNNER_DEFAULT_DIVISION,
} from '$lib/audio/modules/clocked-runner';
import { CLOCKED_DIVISIONS } from '$lib/livecode/api-surface';

/**
 * The division roster, as the picker sees it. TOTAL by construction — it maps
 * the module's own tuple rather than listing a subset, so a division the engine
 * can tick at and the picker cannot name is unwritable.
 *
 * The labels are the division strings themselves, which invents no semantics:
 * `1/16` is literally what the value is, and `2x`/`4x` are the module's own
 * names for a division SLOWER than one beat.
 */
export function clockedRunnerDivisionOptions(): SelectorOption<string>[] {
  return CLOCKED_DIVISIONS.map((d) => ({
    value: d,
    label: d,
    title: `Re-run the body every ${d} of TIMELORDE's beat`,
  }));
}

/** The division stored on a node, falling back to the module's own default. */
export function clockedRunnerDivisionValue(node: ModuleNode | undefined): string {
  const d = (node?.data as Record<string, unknown> | undefined)?.division;
  return typeof d === 'string' ? d : CLOCKED_RUNNER_DEFAULT_DIVISION;
}

/**
 * Persist the division. ONE write, through the undo-aware seam — the factory
 * re-reads `node.data.division` on every tick, so there is no engine-side copy
 * to keep in step and nothing to restart.
 */
export function setClockedRunnerDivision(nodeId: string, value: string): void {
  mutateNode(nodeId, (live) => {
    if (!live.data) live.data = {};
    (live.data as Record<string, unknown>).division = value;
  });
}

/** What the runner's engine handle reports about its own evaluation. Every
 *  field is TELEMETRY: it reaches `StatusLed.detail` (so `aria-label` + `title`)
 *  and never a text node on the plate. */
export interface ClockedRunnerTelemetry {
  /** The last evaluation error, or null when the body last ran clean. */
  lastError: string | null;
  /** Successful body evaluations since this node's handle was built. */
  fires: number;
  /** Failed ones, over the same window. */
  errors: number;
  /** The TIMELORDE tempo the last tick derived its period from. */
  bpm: number;
}

/**
 * Read the runner's telemetry off the LIVE engine handle.
 *
 * ⚠ THE HANDLE IS THE ONLY SOURCE. None of this is on `node.data`: the tick
 * loop lives in the factory's closure (`clocked-runner.ts`), which is what makes
 * the module keep running with no card and no faceplate mounted anywhere. A
 * `readData`-shaped oracle is structurally blind to it, exactly as it is to an
 * audition — see the face's own comment.
 *
 * Returns nulls/zeros when the engine is not up or the node is gone, so "not
 * running" and "never looked" both read as the resting state rather than
 * throwing on a plate that opened before the graph reconciled.
 */
export function clockedRunnerTelemetry(nodeId: string): ClockedRunnerTelemetry {
  const rest: ClockedRunnerTelemetry = { lastError: null, fires: 0, errors: 0, bpm: 0 };
  const engine = getActiveEngine();
  if (!engine) return rest;
  const node = patch.nodes[nodeId] as ModuleNode | undefined;
  if (!node) return rest;
  const err = engine.read(node, 'lastError');
  const fires = engine.read(node, 'firesSinceMount');
  const errors = engine.read(node, 'errorsSinceMount');
  const bpm = engine.read(node, 'bpm');
  return {
    lastError: typeof err === 'string' ? err : null,
    fires: typeof fires === 'number' ? fires : 0,
    errors: typeof errors === 'number' ? errors : 0,
    bpm: typeof bpm === 'number' ? bpm : 0,
  };
}

/** The FIRING lamp's sentence — what a player would otherwise have read off the
 *  card's status line, now spoken instead of painted. */
export function clockedRunnerFiringDetail(t: ClockedRunnerTelemetry, division: string): string {
  if (t.fires === 0) return `idle — the body has not run yet (every ${division})`;
  const tempo = t.bpm > 0 ? ` at ${Math.round(t.bpm)} bpm` : '';
  return `${t.fires} evaluations, every ${division}${tempo}`;
}

/** The ERROR lamp's sentence. `errors` is kept even once `lastError` clears, so
 *  "never failed" and "failed and recovered" stay distinguishable. */
export function clockedRunnerErrorDetail(t: ClockedRunnerTelemetry): string {
  if (t.lastError) return t.lastError;
  if (t.errors > 0) return `no current error — ${t.errors} earlier evaluations failed`;
  return 'no evaluation error';
}
