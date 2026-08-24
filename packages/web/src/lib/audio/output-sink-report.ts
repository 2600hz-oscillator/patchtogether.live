// packages/web/src/lib/audio/output-sink-report.ts
//
// THE SINK REPORT — how the one `setSinkId` caller tells the UI what happened.
//
// ⚠ WHY THIS EXISTS, WHICH IS A PARITY BUG CAUGHT IN REVIEW RATHER THAN A
// DESIGN FLOURISH. Moving the apply off `AudioOutCard` and into the audio-out
// HANDLE fixed the ownership problem (the card is unmounted on the promoted
// surfaces, so it cannot be the applier) — but it broke the ERROR SURFACE on
// the way. The handle keeps `sinkError` in a factory-scoped closure exposed
// through `read('outputSink')`, and an engine `read` is a plain function call:
// nothing about it is reactive, so a Svelte `$derived` over it recomputes only
// when its OTHER dependencies change. A rejected pick would have sat there
// unreported until something unrelated re-rendered.
//
// The card used to show it correctly, because the card owned the `$state`. A
// promotion is not allowed to cost an affordance, so the notification moved
// with the ownership instead of being dropped.
//
// ── WHY A PLAIN LISTENER SET AND NOT A `$state` ───────────────────────────
//
// `audio-out.ts` is a module DEF: it is imported by the ART harness and by
// Node-side tooling, and it must not depend on the Svelte runtime. So the
// reporter is framework-free, and `output-device.svelte.ts` — which is a UI
// module and may use runes — subscribes ONCE and turns the callback into a
// reactive version counter. One direction, one subscription, no polling and no
// timer.
//
// ⚠ AND NOT A POLL. The obvious alternative was for the writer to re-read
// `read('outputSink')` after the pick until it settles, which is a timer whose
// interval would be a guess about how long a device negotiation takes — the
// exact shape the retry loop this whole change deleted was built out of.

/** What the applier knows after trying (or declining) to set the sink. */
export interface SinkReport {
  /** `AudioContext.setSinkId` exists on this context. */
  supported: boolean;
  /** The id actually APPLIED — not merely requested. */
  deviceId: string | null;
  /** The last rejection, cleared on the next successful apply. TRANSIENT: it
   *  is feedback on a gesture, never resting state. */
  error: string | null;
}

const reports = new Map<string, SinkReport>();
const listeners = new Set<() => void>();

/** Called by the audio-out handle — the ONE caller of `setSinkId` — whenever
 *  its sink state changes. */
export function reportSink(nodeId: string, report: SinkReport): void {
  reports.set(nodeId, report);
  for (const fn of [...listeners]) {
    try {
      fn();
    } catch {
      /* a broken subscriber must not stop the others being told */
    }
  }
}

/** Forget a node's report (its handle was disposed). */
export function clearSinkReport(nodeId: string): void {
  if (reports.delete(nodeId)) {
    for (const fn of [...listeners]) {
      try {
        fn();
      } catch {
        /* as above */
      }
    }
  }
}

/** The last report for `nodeId`, or null if its handle never spoke. */
export function readSinkReport(nodeId: string): SinkReport | null {
  return reports.get(nodeId) ?? null;
}

/** Subscribe to any change. Returns the unsubscribe. */
export function onSinkReport(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Test seam: drop every report and every listener. */
export function __resetSinkReports(): void {
  reports.clear();
  listeners.clear();
}
