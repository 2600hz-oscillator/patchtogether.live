# ADR-017: Decline the tidiness changes that cost behaviour or evidence

- Status: Accepted (one item since overturned by the tree — see Consequences)
- Date: 2026-09-08 (records decisions of 2026-06-09 through 2026-07-07)
- Deciders: project owner; this ADR documents the decisions
- Tags: process, architecture, testing, relay

## Context

Two review campaigns — a platform-hardening roadmap and a line-count reduction
report — each produced a list of appealing changes. Both also produced something
more valuable and much easier to lose: a list of changes that were **considered,
costed, and refused**, with the reason.

A refusal with no written reason gets re-proposed every few months by whoever
notices the same surface next, and each re-proposal costs a review cycle. This
ADR is the home for the refusals that are still true against the tree.

## Decision

**These changes are decided against. Each names what it would cost.**

**Platform and relay:**

- **Do not crash the relay on an uncaught exception.** One long-lived process
  serves every rack, so Node's default crash-on-uncaught would nuke every
  connected rack at once and trigger a reconnect storm. The shipped answer is
  log loudly and stay up, with a single-line machine-parseable tagged event and
  a per-process counter surfaced on `/metrics`, so alerting can page on any
  occurrence — and the specific async leaks fixed at the source
  (`packages/server/src/relay-error-handlers.ts`).
- **Do not identity-key the per-rackspace capacity gate.** Identity keying
  collapses anonymous guests into one another, and anonymous collaboration is a
  product requirement. Slots are keyed by **socket id**, acquired at the
  authenticate hook and released on disconnect, both idempotent, with a periodic
  sweep against the server's own live-connection count as the leak valve
  (`packages/server/src/capacity.ts`, cap 4).
- **Do not owner-gate imports or saved-group inserts.** That breaks the
  anonymous-collaborator model; the per-rackspace cap plus connection auth is
  the gate (ADR-006).
- **Do not add a second write-time singleton enforcement layer.** One already
  exists and is powerless against the cross-peer race the new layer was meant to
  close; the reconciling cleanup pass is what actually handles it.
- **Do not make import/load undoable.** A load is a replace, not an edit, and
  folding it into the undo stack makes "undo" mean two different things.

**Line-count reduction — each of these was measured and rejected:**

- **Comment stripping.** The comment mass in the large files is design
  documentation, and the header/doc prose is owner-mandated product content.
- **Pruning test-only exports.** Those exports **are** the pure-core unit and
  ART testing seam; deleting them deletes the ability to test the maths without
  a browser.
- **A def-declaration DSL.** It breaks the static-literal manifest extractors
  that read the defs.
- **Uncommitting the golden artefacts.** `packages/web/src/lib/docs/
  contract-lock.txt` and `packages/web/src/lib/art/fingerprints.generated.json`
  (with 134 committed `.f32` baselines) **are** the gates; removing them from
  the tree deletes the gate, not the maintenance.
- **Booking a large-component decomposition as savings.** Splitting a file moves
  lines between files; it does not remove them.
- **Trusting a dead-code detector's production mode on Svelte.** Verified false
  positives — it misses template-only imports.
- **Cutting coverage that asserts real behaviour** — ART scenarios, behavioural
  deltas, the real-source-chain poly/MIDI end-to-end tests, and the DSP maths
  gates. Deleting a debugging harness trades lines for optionality, and any such
  deletion records a regeneration pointer.

**The method that makes a reduction safe** is the part worth reusing: prove the
change with a **zero-diff** on the generated artefacts (an empty contract-lock
diff, unchanged fingerprints) rather than by re-pinning them, and record how a
deleted artefact would be regenerated.

## Consequences

**Good:**

- Six platform proposals and seven reduction tactics stop being re-litigated,
  and each carries the specific cost that decided it.
- The relay's failure posture is now alertable rather than merely survivable —
  "stays up" and "nobody noticed" print differently.

**Bad / load-bearing:**

- **One refusal has been overturned by the tree, and the tree wins.** The
  "do not add ESLint" push-back is stale: a flat config now exists
  (`eslint.config.mjs`), run through `task lint`. Its shape is worth knowing
  because it is *why* the original objection no longer applies — the config is
  the full unmodulated rule set (the honest reading of the tree), and **which
  findings block is a separate decision** in `scripts/lint/eslint-gate.mjs`
  against a named staging list in `scripts/lint/lint-policy.mjs`, each exemption
  carrying a `why` and anchored so a stale one goes red. Do not cite the old
  push-back.
- Keeping the golden artefacts committed means every intentional behaviour
  change pays a review of a generated diff. That is the cost of the gate
  working.
- Refusing identity-keyed capacity leaves the multi-tab case unaddressed by
  design; it is revisited only on a real lockout report.
- Two items from the same roadmap remain genuinely open and are **not** decided
  here: whether the collaboration job becomes a required check, and whether the
  database wants a migration ledger. Both interact with the standing rulings on
  CI changes and new gates, so both are owner calls.
- This ADR records refusals, not a permanent moratorium. A refusal is overturned
  by evidence — as the lint one was — and the way to overturn one is to bring
  the measurement, then amend this record.

## References

- `packages/server/src/relay-error-handlers.ts`, `packages/server/src/
  capacity.ts` — the two shipped platform refusals.
- `eslint.config.mjs`, `scripts/lint/eslint-gate.mjs`,
  `scripts/lint/lint-policy.mjs` — the overturned one, and the config/gate split
  that answers the original objection.
- `packages/web/src/lib/docs/contract-lock.txt`,
  `packages/web/src/lib/art/fingerprints.generated.json` — the goldens that stay
  committed.
- ADR-006 — capacity and auth gate ordering. ADR-015 — the same "measure before
  you re-architect" posture applied to performance.
- Provenance: preserved in the `myrobots-preserved-2026-09` tag snapshot, as
  `plans/standards-refactor-roadmap.md`,
  `plans/adversarial-review-REMAINING-2026-06-09.md` and
  `loc-reduction-report-2026-07-07.md` (paths relative to the retired
  agent-evidence tree in that snapshot, not to the worktree). Those records'
  *open* rows are stale against the tree and must be re-derived, never quoted.
