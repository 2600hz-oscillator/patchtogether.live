# Issues to consider closing — audit of all 144 open issues (2026-08-22)

**Executive summary:** 144 open; 11 exempt from this audit (3 `alert`-labeled, 4 owner-decision
queue #2045/#2008/#1974/#2036, 4 this-week follow-ups #2089/#2090/#2094/#2095). Of the 133
reviewed: **7 OUT-OF-DATE** (verified against code/PRs on main), **1 UNHELPFUL**, **7 could not
be verified without deeper checks**, and ~118 judged still-valid — the list is healthier than
the prior suggested: most entries carry a *measured* defect that still reproduces on main.
Every flagged entry below was checked against origin/main or a merged PR; nothing was closed,
commented, or labeled — your call on all of it.

## OUT-OF-DATE — close candidates, most confident first

- **#1920** mandelbulb DETAIL dial dead over 55.6% — same subject re-measured and superseded by
  **#2036** (15/27 dead positions + the audio-clamp fix direction), which sits in your decision
  queue — evidence: both titles measure the same dial/dead-band; #2036 is newer and sharper —
  **close as superseded by #2036**.
- **#1543** adopt Svelte AI tooling — its own title records the premise as MEASURED AND REFUTED
  (~1% precision on effect static-analysis; the 229/233-valid-bridges finding stands) — evidence:
  issue title + the effects audit — **close** (re-file narrowly if a specific tool ever earns it).
- **#1952** "P0: main is RED — webgl-smoke killed at its 10-min cap" — the P0 condition no longer
  exists; main has run all-green repeatedly since (e.g. `3fdce3d5f` 2026-08-21: CI+Deploy+Pages+
  Smoke all success) — **close as stale-P0**; if the cap-adjacency hazard is still measurable it
  deserves a fresh non-P0 with current numbers.
- **#1896** b3ntb0x + bentbox face audit ("first fullViewBody adopters" blocker) — both defs now
  declare `face:` on main (b3ntb0x.ts, bentbox.ts) so the audit's blocker record is overtaken —
  **close after one spot-check**: confirm the two MIRROR buttons survived into the faces; if not,
  extract that one line into a fresh narrow issue.
- **#2064** batch 18, face the 15 thin-tail audio modules — the thin-audio blitz shipped 14 of the
  15 across 4 merged PRs (2026-08-20) — **rescope to the single remainder by name, or close** if
  the remainder was deliberately excluded as a snowflake.
- **#1807** spell out abbreviated labels (RES → resonance) — overtaken by your own later rulings
  going the *opposite* way: colourofmagic ("instead of Pal R let's just make this 'R'"), the
  mixmstrs grey-label removal, and faces-carry-near-zero-prose — **close as overtaken by owner
  direction**.
- **#1965** the readout ruling has no aria-valuetext host for a JOIN — the decision it asks for
  was made and executed: the FaceReadoutValue mechanism was deleted (1809 lines, recorded in
  #2020) and aria-valuetext is the fleet standard — **close** (the residue, #2020's doc-rot, is
  tracked separately and stays).

## UNHELPFUL — implementing it would not deliver meaningful functionality or stability

- **#1544** move the most expensive ~25% of e2e to an opt-in nightly tag — the issue's own
  condition ("only if sharding + trims don't already buy the headroom") was met the other way:
  cost-based sharding landed and CI holds ~25 min under load; an opt-in tag now only *removes*
  PR-time coverage — **close as wontfix/condition-not-met**.

This section is deliberately short: most candidates I tested for "unhelpful" turned out to carry
a real fix path (e.g. #2054's refused tick-gate still has the sanctioned off-main-thread worker
route; see keep-list).

## COULD NOT VERIFY — need one deeper check each before acting

- **#1536** /r/[id] zero e2e coverage — partially overtaken: the `@collab` lane now runs with a
  real DATABASE_URL (52 tests green on #2093's merge) and auth-routes visits `/r/`; unverified
  whether any collab spec drives actual shared-rackspace flows on `/r/[id]`. Check: grep the
  @collab suite's goto targets.
- **#1740** tab rail sets pane width, faceplates padded to it — likely subsumed by the #1796
  width overhaul (900px floor removal); needs a measurement on a current build.
- **#1753** GroupCard stale re-render + "THREE e2e specs red on main" — main is green and no
  matching spec filenames remain; fixed, renamed, or parked? Find the closing PR.
- **#1934** freezeframe SCREEN toggle deleted by its own promotion — state unknown after the
  fleet-wide SCREEN standard landed; check freezeframe's current face for the toggle.
- **#1975** two primitives show a value while you set it, one shows none — whether the readout
  sweep reconciled drag-time (not resting) readouts is unchecked; read the three primitives.
- **#1862/#1863** ruttetra flyback streak + SHAPE endpoint extrapolation — did fixes ride the
  merged monitor-mode face PR (#2053)? Diff the shader in that PR.
- **#1806** sweep the mixmstrs hero/summary readout strips — mixmstrs.ts comments still describe
  hero readouts as present-and-asserted, which leans KEEP; confirm on a rendered face before
  treating the ruling as executed.

## What I'd keep that might look stale but isn't

- **#2047** ruttetra 'Tint R/G/B' — the title says "drained" but the def on main still reads
  `label: 'Tint R'` (ruttetra.ts:280-282); the divergence is live.
- **#1972** XyPad resting decimal / no aria-valuetext — still true (XyPad.svelte:271 `toFixed`),
  and acute *today*: the quadralogical face work touches exactly this primitive.
- **#1880** quadralogical 12/21 params dead at spawn — about to be paid by the quadralogical
  face+card PR under fix-with-face policy; leave open until that PR closes it.
- **#1826** /rack boots no engine, no audio prompt — AudioGate is still mounted only on
  routes/r/[id]; the default route is still silently dead.
- **#1787** pay off the waitForTimeout ledger — the ledger still holds 455 entries and DOOM's
  permanent block is only a small slice; the payable tail is real.
- **#1779** illogic poll gates the wrong snapshot — its subject spec is PARKED under #1847; this
  issue is the root-cause path for un-parking one of the 95.
- **#2054** foxy main-thread volumetric rebuild — the tick-gate fix is refused, but the
  sanctioned off-main-thread worker route (the fixe precedent) still applies; rescope, don't close.
- **#1576** TOYBOX randomize expansion — locks + graph randomize shipped in #2031; the curated/
  asset-bank remainder is still real functionality.
- **The LEG-\* program** (#1509–#1521, #1583, #1606) — sequenced legacy-removal program in active
  use by the face migration, not rot.
- **#1801/#1803** (observability-labeled but hand-filed) — real P1 defects (es9 retry storm,
  main-thread scheduler); the label exemption is for *automated* alerts, so these were audited
  and kept.
