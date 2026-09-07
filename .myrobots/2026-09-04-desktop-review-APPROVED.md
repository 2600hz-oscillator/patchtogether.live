# Desktop plan review — OWNER APPROVED 2026-09-04

Owner instruction: *"here is an analysis of our original desktop plan that should
be considered in light of what we have built and what is still unbuilt. we will
want to address all the real issues here"* + **"Approve for me"**.

APPROVED. The reviewer blocks display persistence and the Electron harness until
findings 1-4 are resolved; that block is ACCEPTED.

## Standing architectural ruling from this review

> **Make the INTERRUPTION MATRIX the architectural source of truth.** For every
> interruption, state which PROCESS owns each resource, which TRANSPORT survives,
> what RECONNECTS, what may GLITCH, and what RECEIVER-SIDE instrument proves it.

Several rows in the current plan promise more continuity than their owning
process can provide. No desktop phase is "done" until its row in that matrix is
filled in and its receiver-side instrument exists.

## Blocked until findings 1-4 land
- display persistence
- the Electron e2e harness (PH)


## Verification result (13-agent workflow, 2026-09-04)

**12 of 13 findings SURVIVED. One REFUTED.**

⚠ **REFUTED — the face-inventory finding (182/197 with 12 bespoke-surface
remaining) is FALSE.** It was measured from the repos

## Verification result (13-agent workflow, 2026-09-04)

**12 of 13 findings SURVIVED. One REFUTED.**

⚠ **REFUTED — the face-inventory finding (182/197 with 12 bespoke-surface
remaining) is FALSE.** It was measured from the repo's PRIMARY WORKING CHECKOUT,
which sits on `fix/inventory-regen-2`, **38 commits behind `origin/main`**. On
`origin/main`: 197 registered, **194 done, 0 remaining**, `bespoke-surface` and
`blocked` both EMPTY, and the 3 outstanding are `organizational-native` rack
furniture (cadillac, group, sticky) which the artifact's own row label excludes.
All 12 allegedly-remaining modules ship real surfaces on main — each has a
`shell-extension.ts` and a `face` with an `extension` id, landed across
#2318-#2331; none of those paths exist in the stale checkout.
**The face fleet IS complete, unqualified.**

⚠ **CONSEQUENCE: every numeric claim in that review is suspect for the same
reason and must be re-derived against `origin/main` before being acted on.**
I made this same mistake reading the inventory during triage — the memory
`primary-checkout-is-stale-never-measure-from-it` exists precisely for this and
was not applied. Re-derive with `git show origin/main:<path>`, never the
working tree.

## The 12 that survived, and who is building them

| finding | verdict | build group |
|---|---|---|
| owner answers contradict plan body | TRUE | A — normative docs |
| package hygiene / duplicate packages | PARTLY | A |
| helper SIGKILL is recovery, not continuity | TRUE-BUT-STALE | A (doc only) |
| desktop security model | PARTLY | B — apps/desktop |
| fixed-port + instance ownership | TRUE | B |
| preload contract incomplete | PARTLY | B |
| renderer death vs present transport | PARTLY | C — packages/web present |
| display map vs settings.presentBindings | TRUE | C |
| visual gate is pixel-blind | TRUE | C |
| min-RMS is not an underrun detector | PARTLY | D — audio/zip/slots |
| perf-zip Worker moves jank not memory | PARTLY | D |
| reserved slots vs live Yjs mutation | PARTLY | D |

## Structural finding worth more than any single fix

Owner answers keep being **APPENDED** rather than folded into the body, so each
appendix contradicts both the body AND the previous appendix (brief:62 "now,
parallel" vs :459 "strictly after S4" vs :467 "HELD until cliprec"). And this is
a RE-DISCOVERY: `second-review.md` already found all three contradictions and
scored four owner answers "NOT integrated" — the next package was authored two
hours later and appended OWNER GO while leaving the body untouched.
**Rule going forward: FOLD, never append.**

## Surfaced to the owner, not decided

Click-free crossfade requires the OUTGOING graph to keep rendering past the
Y.Doc swap. The single-client ES-9 socket and the teardown-then-rebuild load
path do not allow that. Design decision with a phase and a price.
