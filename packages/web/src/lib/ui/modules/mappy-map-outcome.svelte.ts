// packages/web/src/lib/ui/modules/mappy-map-outcome.svelte.ts
//
// THE LAST MAP I/O OUTCOME, per node — a tiny reactive record so the venue
// map's EXPORT can say what happened.
//
// ── WHY IT EXISTS ───────────────────────────────────────────────────────────
//
// ModuleShell paints a status/error line under a `file` cell for free, and
// NOTHING under an `action` cell. mappy ranks both halves of the venue map, so
// IMPORT reports itself and EXPORT has nowhere to speak — and "the export
// outcome needs a perceivable home" is not a nicety here: a rejected import
// ("not a MAPPY map: unsupported map version") and a failed export are the only
// things distinguishing a refusal from a dead button.
//
// ⚠ THE ALTERNATIVE WAS A SECOND SET OF BUTTONS, AND IT LOOKED LIKE ONE. The
// first draft gave the `fullViewBody` its own export/import pair so it could
// own the outcome locally — which painted the same two controls twice, inches
// apart, in the dock (the body's pair above the ranked cells' pair). One
// control with one outcome is the honest shape; this module is what lets the
// outcome cross from the cell that fired it to the surface that shows it.
//
// ⚠ IT IS RENDER STATE, NOT GRAPH STATE, and deliberately so. "Your last export
// succeeded" is a fact about THIS browser's last gesture: it is not
// collaborative, not undoable and not worth a Y.Doc write (the
// `cv-modulation-live-store-write-storm` rule, one step milder). It dies with
// the page, which is correct — a reloaded rack has no outcome to report.

/** One node's last map I/O result. `seq` advances on every record so a repeat
 *  of the SAME message still reads as a new outcome. */
export interface MappyMapOutcome {
  kind: 'ok' | 'err';
  text: string;
  seq: number;
}

let outcomes = $state<Record<string, MappyMapOutcome>>({});
let seq = 0;

/** Record what an export/import just did. A result with neither a status nor an
 *  error records nothing — an action that had nothing to say must not blank a
 *  message the player has not read yet. */
export function recordMappyMapOutcome(
  nodeId: string,
  r: { status: string | null; error: string | null },
): void {
  const text = r.error ?? r.status;
  if (!text) return;
  outcomes[nodeId] = { kind: r.error ? 'err' : 'ok', text, seq: ++seq };
}

/** This node's last map I/O outcome, or `undefined` if it has had none.
 *  Reactive: read it inside a `$derived` and the surface repaints on the next
 *  record. */
export function mappyMapOutcome(nodeId: string): MappyMapOutcome | undefined {
  return outcomes[nodeId];
}

/** TEST SEAM: forget everything. Never called from app code. */
export function __resetMappyMapOutcomes(): void {
  outcomes = {};
  seq = 0;
}
