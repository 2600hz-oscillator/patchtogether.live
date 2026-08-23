// packages/web/src/lib/ui/modules/audition-ledger.ts
//
// THE OBSERVABLE FOR AN AUDITION — what a `ShellActionCell` press actually did.
//
// ── Why this exists (the blind-gate finding, 2026-08-02) ────────────────────
// `faces-parity`'s `action` branch was:
//
//     const btn = host.locator('button');
//     await expect(btn, `${where}: a real enabled button`).toBeEnabled();
//     …
//     await btn.click();
//     return;
//
// It asserted the button EXISTED and was ENABLED, then clicked it and asserted
// NOTHING. Every other cell kind in that sweep proves an observable effect — a
// knob commits a param, a toggle flips `aria-checked`, a selector changes the
// displayed value, a PANEL must declare a probe and move `node.data`. The
// `action` kind, the one whose entire purpose is to DO something, had no probe
// at all. A dead audition passed the whole face green.
//
// That is the revision-only-probe pathology `shell-cells.ts` outlaws for panel
// cells (*"a revision-only probe passes on a DEAD mute button that bumps the
// counter without muting anything"*), on a kind that had no probe whatsoever.
// It is why karplus's dock PLUCK could animate a press flash **even when
// nothing was plucked** (face-redo ledger defect #22 — the shell discards
// `fireManualStrike`'s boolean, which the legacy card honours), and why
// sixstrum shipped a face whose strum audition never reached `SHELL_CELLS`.
//
// ── What "observable" means here, and why ───────────────────────────────────
// An audition deliberately WRITES NOTHING TO THE GRAPH. That is stated as a
// design property in `manual-strike-actions.ts`: *"no value moves, nothing is
// persisted, nothing is shared with the rackspace, nothing lands in the undo
// stack"* — each fires a host-side `ConstantSource` summed into the same
// worklet input a cable feeds. So `readParam` and `readData`, the two oracles
// every other branch of the sweep uses, are STRUCTURALLY UNABLE to see it. A
// probe modelled on the panel probe would have been unimplementable.
//
// The next observable inward is the one thing that distinguishes a live
// audition from a dead one: **the seam resolved a callable off the live engine
// handle and called it.** All three audition seams already compute exactly that
// boolean and all three THREW IT AWAY at the call site. This module keeps it.
//
// A record is written on EVERY press, including the ones that failed —
// `delivered: false` is the whole point. "The button was never pressed" and
// "the button was pressed and reached nothing" are different failures, and a
// probe that could not tell them apart would be the same vacuity one level
// down.
//
// Why not audible RMS? It is strictly stronger and it is the right bar in the
// place the repo already mandates it — a POLY or MIDI module must e2e the REAL
// source chain to audible RMS, because there the failure mode (voice gating)
// lives between the trigger and the sound. These five action cells are MONO
// STRUCK VOICES: kickdrum, karplus, snaredrum HIT/ROLL and cloudseed's tank
// flush. Their factories' response to the read key is already pinned by
// `{kickdrum,karplus,snaredrum}-factory-strike.test.ts`, and an analyser poll
// per cell inside a REQUIRED sweep that already costs ~0.8 s/cell on the
// SwiftShader runner buys a second assertion of that same fact for real
// wall-time. The gap this closes is the CALLER→SEAM one, and `delivered`
// closes it exactly.
//
// PURE + framework-free, so `auditionDelivered` is unit-testable in both
// directions with no browser, no AudioContext and no DOM — see
// `audition-ledger.test.ts`, which is the PERMANENT negative control.

import { testHooksEnabled } from '$lib/dev/test-hooks';

/**
 * The seams an audition can reach. The first three mirror `ShellActionCell.mode`
 * plus the engine-message shape cloudseed's CLEAR TAIL uses.
 *
 * `manual-press` is the MOMENTARY PAD (`face.momentary` — tomtom STRIKE, tidyVco
 * HOLD), added when that seam stopped writing the Y.Doc. It is deliberately a
 * FOURTH member and NOT an alias of `manual-gate`: `manual-strike-actions.ts`
 * keeps the press-pad on its own latch precisely so a node can hold a gate
 * audition and a press-pad at the same time without one stealing the other's
 * release, and a ledger that collapsed them would re-introduce exactly that
 * aliasing one layer up — a probe watching `manual-gate` would be satisfied by a
 * press-pad edge on the same node. (An ACTION cell must never DECLARE this seam;
 * `shell-cells.test.ts`'s `SEAMS` allowlist keeps it out by omission.)
 */
/**
 * `file-export` is the FIFTH member, for a press whose whole effect leaves the
 * app — samsloop's sample DOWNLOAD. It is deliberately not `engine-message`:
 * an export reaches no engine and no worklet, so reusing that name would make
 * the ledger describe something that did not happen, AND a probe watching
 * `engine-message` on the node would then be satisfied by a REC press — the
 * exact aliasing `manual-press` was split out to prevent, one seam over.
 * `delivered: false` is recorded when there is nothing to export.
 */
export type AuditionSeam =
  | 'manual-strike'
  | 'manual-gate'
  | 'engine-message'
  | 'manual-press'
  | 'file-export';

export interface AuditionRecord {
  /** Monotonic, so a probe can ask "since I looked" without clock skew. */
  seq: number;
  nodeId: string;
  seam: AuditionSeam;
  /** For `manual-gate` / `manual-press`: which edge. Undefined for the one-shot
   *  seams. Both edges are recorded, because "opened" and "opened then closed"
   *  are different facts and an end-state read cannot tell them apart. */
  high?: boolean;
  /** For `manual-press`: WHICH pad. A module may declare several `momentary`
   *  params (`face.momentary` is a list), and they share a nodeId — so without
   *  this a probe for one pad would be satisfied by a press on its neighbour. */
  paramId?: string;
  /** ⚠ THE FIELD THE WHOLE GATE TURNS ON. False = the press happened and
   *  reached NOTHING (no engine, no node, or a handle that does not answer the
   *  read key). A dead audition is recorded, loudly, rather than absent. */
  delivered: boolean;
}

/** Bounded so a held gate cannot grow it without limit. Two orders of
 *  magnitude more than any single face's cell count. */
const CAP = 512;

let seq = 0;
let log: AuditionRecord[] = [];

/** Record one audition attempt. Called by the seams, never by a card. */
export function recordAudition(r: Omit<AuditionRecord, 'seq'>): void {
  log.push({ ...r, seq: ++seq });
  if (log.length > CAP) log = log.slice(-CAP);
}

/** The ledger, oldest first. */
export function auditionLog(): readonly AuditionRecord[] {
  return log;
}

/** TEST SEAM: forget everything. Never called from app code. */
export function __resetAuditionLedger(): void {
  seq = 0;
  log = [];
}

/**
 * THE PROBE PREDICATE — did `nodeId` reach `seam` and actually deliver, in a
 * record newer than `sinceSeq`?
 *
 * `sinceSeq` is what makes it a probe rather than a historian: faces-parity
 * snapshots the sequence number before the press, so an earlier module's
 * successful audition can never satisfy a later module's assertion. PURE.
 */
export function auditionDelivered(
  entries: readonly AuditionRecord[],
  nodeId: string,
  seam: AuditionSeam,
  sinceSeq = 0,
  opts?: { high?: boolean; paramId?: string },
): boolean {
  return entries.some(
    (r) =>
      r.seq > sinceSeq &&
      r.nodeId === nodeId &&
      r.seam === seam &&
      r.delivered &&
      (opts?.high === undefined || r.high === opts.high) &&
      (opts?.paramId === undefined || r.paramId === opts.paramId),
  );
}

/** The highest sequence number issued — the "before" snapshot. PURE. */
export function auditionSeq(entries: readonly AuditionRecord[]): number {
  return entries.length ? entries[entries.length - 1]!.seq : 0;
}

/** Publish the ledger for the e2e (dev/autotest builds only — the same
 *  `testHooksEnabled()` gate `__moduleSpecs` and `__shellPanelProbes` use).
 *  Exposed as a FUNCTION, not a snapshot array, because the sweep reads it
 *  after each press and a frozen copy would always look empty. */
export function exposeAuditionLedgerForTests(): void {
  if (!testHooksEnabled()) return;
  if (typeof window === 'undefined') return;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (window as any).__auditionLog = () => auditionLog();
}
