// packages/web/src/lib/ui/workflow/no-user-control.ts
//
// THE "NO USER CONTROL" DECLARATION (#1726) — the pure resolver + its lint.
//
// A `ParamDef` that exists so the GRAPH has somewhere to write, not so a PLAYER
// has something to turn. `backdraft` has seven of them: six synthetic gate
// params a `paramTarget` CV bridge pushes raw 0..1 swings into (the module
// edge-detects the rising edge), plus a determinism toggle a VRT capture flips.
// Before this the fact lived only in `// hidden — no card knob` comments, which
// no gate can read.
//
// It is a DECLARATION rather than a skip-list, and the difference is structural
// (see NoUserControlParam in graph/types.ts): `why` is required by the TYPE, and
// `writer` is checked against the def's own ports in BOTH directions, so
// neither arm can be asserted about nothing.
//
// ── WHAT READS IT ───────────────────────────────────────────────────────────
//
// The point of a declaration nobody consumes is nothing, so every consumer is
// named here and each is a real behaviour change, not a gate verdict alone:
//
//   1. group-controls `listExposableControls` — a no-user-control param is
//      never auto-exposed on a GROUP's instrument bar. This is live today, on
//      the un-faced modules that adopt it: before #1726 collapsing a rack
//      containing `backdraft` offered its six gate params as knobs. It also
//      REPLACED a global, module-blind `AUTO_EXPOSE_EXCLUDE_PARAM_IDS` set that
//      matched by bare param id across every def in the repo — and whose five
//      names (`camera_x` …) no live def declares any more, so it was a ledger
//      naming a vanished subject.
//   2. push-card-schema — neither the FACE ranking nor the GENERIC declaration
//      -order ranking may put one under a Push 2 encoder.
//   3. module-face-lint COMPLETENESS — a declared param satisfies the "every
//      param is ranked" rule without a rank. Deny-by-default is intact: a param
//      that is in NEITHER `face.order` NOR this declaration is still RED, and a
//      param in BOTH is RED (the declaration would be a lie).
//   4. module-face-lint DOCK RENDER-PLAN PARITY — inverted rather than skipped.
//      A declared param must render EXACTLY ZERO cells; every other param still
//      exactly one. That is what keeps this from being the `curve="linear"`
//      trap: the renderer claim is falsifiable in both directions.
//   5. faces-parity.spec.ts — the DOM-level twin of (4).
//
// ── WHAT IT IS NOT ──────────────────────────────────────────────────────────
//
// It is not "hide this control". A param the player SHOULD be able to set,
// declared here to quiet a gate, passes every check in this file and is a lie
// the `why` has to carry — which is why the `why` is prose a human reviews, and
// why `writer` forces the author to say which of the two mechanisms applies.

import type { NoUserControlDefLike, NoUserControlParam } from '$lib/graph/types';

/** The shortest `why` that can plausibly name a mechanism. A prose-quality
 *  floor on ONE string, not a population count — the same shape as the `why`
 *  floors on the VRT and behavioral ledgers. */
export const NO_USER_CONTROL_WHY_MIN = 24;

/** The param ids a def declares as having no user control. Empty set for the
 *  overwhelming majority of defs, which declare nothing. Pure. */
export function noUserControlIds(def: NoUserControlDefLike | undefined): ReadonlySet<string> {
  const out = new Set<string>();
  for (const e of def?.noUserControl ?? []) out.add(e.param);
  return out;
}

/** True iff this def declares that `paramId` has no user control. Pure. */
export function hasNoUserControl(
  def: NoUserControlDefLike | undefined,
  paramId: string,
): boolean {
  return (def?.noUserControl ?? []).some((e) => e.param === paramId);
}

/** Input ports of `def` that write `paramId` (`PortDef.paramTarget`). This is
 *  the ANCHOR both `writer` arms are checked against — the same derivation the
 *  CV bridge itself uses, so the declaration cannot describe a wiring the
 *  engine does not have. Pure. */
export function cvWritersOf(def: NoUserControlDefLike | undefined, paramId: string): string[] {
  return (def?.inputs ?? []).filter((p) => p.paramTarget === paramId).map((p) => p.id);
}

/**
 * Every problem with ONE def's `noUserControl` declaration, as human sentences.
 * Empty array = the declaration is sound. Pure, so it is callable from the lint
 * AND from its own negative controls with a hand-built def — which is what
 * makes "the gate can fail" provable rather than asserted.
 */
export function noUserControlProblems(def: NoUserControlDefLike | undefined): string[] {
  const entries = def?.noUserControl;
  if (!entries || entries.length === 0) return [];
  const who = def?.type ?? '<unnamed def>';
  const problems: string[] = [];
  const paramIds = new Set((def?.params ?? []).map((p) => p.id));
  const seen = new Set<string>();

  for (const e of entries as readonly NoUserControlParam[]) {
    // ANCHORED TO THE ARTIFACT: an entry naming a param that no longer exists
    // is RED, not silently inert. This is the leg that makes the declaration
    // survive a rename honestly.
    if (!paramIds.has(e.param)) {
      problems.push(
        `${who}: noUserControl names '${e.param}', which is not a ParamDef of this def — ` +
          `delete the entry or fix the id (params: ${[...paramIds].join(', ') || 'none'})`,
      );
      continue;
    }
    if (seen.has(e.param)) {
      problems.push(`${who}: noUserControl declares '${e.param}' twice`);
      continue;
    }
    seen.add(e.param);

    const writers = cvWritersOf(def, e.param);
    if (e.writer === 'cv-port' && writers.length === 0) {
      problems.push(
        `${who}: noUserControl '${e.param}' says writer 'cv-port' but NO input port declares ` +
          `paramTarget: '${e.param}' — nothing writes it, so it is not CV-driven, it is dead`,
      );
    }
    // The other direction, and the reason 'internal' is not an escape hatch: a
    // param that GAINED a CV port is no longer internal, and the entry that
    // called it internal must be re-read by whoever added the port.
    if (e.writer === 'internal' && writers.length > 0) {
      problems.push(
        `${who}: noUserControl '${e.param}' says writer 'internal' but input port(s) ` +
          `${writers.join(', ')} target it — say 'cv-port', or drop the entry`,
      );
    }
    if (e.why.trim().length < NO_USER_CONTROL_WHY_MIN) {
      problems.push(
        `${who}: noUserControl '${e.param}' needs a real 'why' naming what writes it ` +
          `(got ${JSON.stringify(e.why)})`,
      );
    }
  }
  return problems;
}
