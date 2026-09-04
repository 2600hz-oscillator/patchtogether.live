# S5 — the archaeology sweep, and three things to read BEFORE you edit

**Status:** ⚠ EVIDENCE, NOT INSTRUCTION (`.myrobots/` per AGENTS.md). IN PROGRESS.

---

## ⚠ READ THIS BEFORE YOU PREDICT WHETHER A CHANGE MOVES THE WEBGL ATTEST HASH

> **The normalizer strips `docs`, `controlFamilies`, `face` and `noUserControl`
> — and nothing else. So "it's only a doc change" is a claim about the FIELD,
> not about the FILE.**

Predict hash movement from that field list, never from intent. This programme got
it wrong TWICE, in opposite directions, and both failures had the same shape —
reasoning from what the change was *about* instead of from what the normalizer
keeps:

| prediction | reality |
|---|---|
| "S4 will move the hash — the basis includes each `rendersWebGL` module's CARD SOURCE" | It did NOT. `webgl-attest-hash.sh --list` is 220 files with ZERO `*Card.svelte`; `cube`/`wavesculpt` enter through their extracted `*VizSurface.svelte`. |
| "S5 will not move it — comments and `docs` props are hash-transparent" | It DID. The prose was transparent (`contract-lock.txt` re-pinned byte-identical), but the same commit retired the `card:` DEF FIELD, six declarations of which are in `lib/video/modules/` — 96 of the 220 basis files. `aacfac95…` → `9af32fc1…`. |

A commit that edits prose AND a field is not a prose commit. **Always re-check
with `flox activate -- task webgl:attest:check`** rather than trusting any hash
written down — including the ones in these notes.

Practical: the attest is ONE spend and must be taken at the END, after the last
basis-touching commit.

---

## ⚠ BEFORE YOU RUN YOUR OWN BULK PROSE EDIT: THE SINGLE-QUOTE TRAP

Inserting `faceplate's` into a **single-quoted** string literal terminates it.
One careless pass produced **1,722 errors across 5 files** — and the failure is
loud, so it is cheap; what is expensive is the naive fix. A line-shape heuristic
("does this line start with `'`?") misses `freezeTable: '…'` and every other
`key: '…'` form.

The correct fix walks BACK from each occurrence to the nearest UNESCAPED quote —
that character is the literal's real opening delimiter — and escapes only when it
is `'`. 119 apostrophes needed escaping; a line-shape guess found 14 of them.

---

## ⚠ SEVEN "card" STRINGS ARE KEPT ON PURPOSE — THEY NAME OTHER PEOPLE'S HARDWARE

This is the distinction a future blanket sweep will get wrong, and seven
corrupted user-facing strings is what it costs. None of these is our UI:

| module | string | what it actually names |
|---|---|---|
| `sixstrum` ×5 | "On the classic card that recall is the MODE knob", "The classic card's ⟋ STRUM button", "the classic card's MODE presets park it at 2.5 / 6 / 9 s" | the ORIGINAL HARDWARE instrument this module ports |
| `chromaconsole` | "the Push 2 card can drive" | Ableton Push 2 |
| `es9` | "If the ES-9 card also shows rising xruns" | the Expert Sleepers ES-9 audio interface |

A rule matching `the card` / `card's` / `on the card` does not hit any of them,
because every one carries a qualifier between the article and the noun
(`classic`, `Push 2`, `ES-9`). That is luck, not design — a sweep that matches a
bare `card` WILL hit all seven. Guard on the qualifier, and read every hit in a
module whose subject is a piece of real hardware.

---

## What the sweep changed

**312 rewrites across ~75 module defs + `module-manifest.ts`.** ZERO
`?shell=legacy` or "legacy card" references remain in any user-facing string.

Shape of the edit, in descending volume: `the card's` → `the faceplate's` (54),
`on-card` → `on-faceplate` / `the faceplate's` (105 across two forms),
`on the card` → `on the faceplate` (43), `no card row/knob/control` → `no
faceplate …` (52), plus ~35 read-individually rewrites where a whole clause had
to go rather than a noun (`archivist`, `peertube`, `mappy`, `tv-librarian`,
`ruttetra` ×5, `milkdrop`, `cube`, `cv-buddy`, `loopback`, `mandleblot`,
`vfpga-runner`, `backdraft`, and seven manifest entries).

Deleted rather than reworded, because rewording keeps the monument: every "the
legacy card also does X" / "under `?shell=legacy` it is Y" sentence.

## `def.card` was fully orphaned

34 declarations across module defs, 5 `card?: string` type fields, and **zero
readers** — it was the deleted card map's explicit-basename override. Removed
with the two tests that asserted it (`control-surface.test.ts`,
`electra-control.test.ts`). This is the field whose removal moved the attest hash.

## HELD DELIBERATELY — `packages/web/src/lib/video/modules/camera-input.ts`

8 prose hits, untouched. A P0 on `main` is actively rewriting `cameraInput` (the
face lost its source picker; separately the dock rail was still mounting the
verbatim card because `dockRailRendersFace` required `pinned` while Canvas passed
`pinned: false` — the half this branch's S4a closes). Editing its prose now would
conflict in a file being rewritten underneath. It is done AFTER that fold, on the
post-fix text, on the coordinator's signal.

## ⚠ S4a MOVED A DEV SEAM'S BEHAVIOUR AND NO GATE COULD REPORT IT

`laneRenderKind` stopped consulting `migrated`, which silently changed what the
forced-placeholder seam DID. Four specs were built on that seam and all four
went red at once — and none of them said so, because the e2e lane had not run
since. (Two pushes that day produced no CI run at all.) The lesson is not
"remember to run e2e": it is that **deleting an arm of a switch changes every
seam that injected an answer into it**, and those seams are exactly the code
with no product caller to notice.

Worth pairing with the second-order finding below, which is the same shape one
level down: the deletion did not only break tests, it broke the PRODUCT in a
place only those tests looked at.

## ⚠ THE DELETION LEFT A LIVE DEFECT, AND THE ONLY GATE WAS POINTED AWAY FROM IT

`data-dock-card` / `data-dock-card-frame` were emitted ONLY by `DockFullView`'s
second branch, so they were a property of the CONTENT rather than of the DOCK.
`Canvas.cardRectFor` and `PickupCable` both resolve them and both fall back to
`.svelte-flow__node[data-id]` — which a CANVAS-HIDDEN node does not have.

Measured, both directions, on the built preview:

* with the anchors: the ghost cable renders, path has geometry;
* without them: **the `pickup-cable` element is not found at all.**

So on `main` today you can flip the built-in clip player's pane (Tab), click a
back jack, and nothing attaches to your cursor. The picker loses the same rect
and opens at the raw cursor instead of the pane edge — the owner's "patch to is
a mess in terms of where the menu spawns", by a second route.

The anchors now sit on the pane's own frame (attributes on elements it already
had — no wrapper, so measured geometry is unchanged). Regression test:
`workflow-rear-card.spec.ts` → "a CANVAS-HIDDEN occupant renders a pickup ghost
from its rear card". Its subject MUST be a node with no canvas element; the
existing carry-seam test uses a spawned `adsr` and therefore resolves the first
selector and never reaches the fallback.

## ⚠ THE DERIVED LEGACY-FALLBACK FIXTURE POOLS ARE STRUCTURALLY DEAD

`e2e/tests/_face-fixtures.ts` derives four pools — `AUDIO_PLACEHOLDER_FIXTURE`,
`AUDIO_OPERABLE_FIXTURE`, `VIDEO_FIXTURE`, `VIDEO_SINK_FIXTURE` — each meaning
"an un-migrated module whose legacy card does X". Their fitness predicates READ
CARD SOURCE (`mountsAFader` opens `${cardComponentName(type)}.svelte`), and the
cards are gone, so every predicate now accepts nothing.

⚠ AND THE FIXTURE'S OWN ANTI-VACUITY GUARD IS WHAT REPORTED IT, correctly and
loudly: it separates "migration complete" from "the predicate broke" by asking
whether the predicate accepts ANY module in the whole population, promoted or
not. It says *"THE FITNESS PREDICATE ACCEPTS NOTHING IN THE ENTIRE domain=audio
POPULATION (121 modules) … FIX THE PREDICATE, do not re-point the fixture."*
That guard is the reason this surfaced as a named failure instead of a suite of
silent skips. The honest answer is neither of its two arms: the predicates
cannot be fixed and the fixtures cannot be re-pointed, because the population
they select from no longer exists. They die with the cards.

Consumers needing a per-leg disposition: `workflow-dock-ux.spec.ts` (2 legs +
1 health test), `workflow-shell.spec.ts` (health tests + several legs),
`workflow-shell-video.spec.ts` (`VIDEO_SINK_FIXTURE` + health).

## Remaining in S5

* ~~`ModuleShellPlaceholder.svelte`~~ — DONE, and it took the forced-placeholder
  seam, `DockFullView`'s second branch and three of its props with it. Four
  specs re-pointed; one dock regression found, fixed and gated.
* The derived legacy-fallback fixture pools (above) — the last structural
  dependency on the card fleet inside the e2e suite.
* The `module-shell-placeholder` testid still named in ~25 specs. Most are
  `toHaveCount(0)` — now trivially true, and monuments of exactly the kind
  ruling 2 forbids. Sweep them with the fixture work, not before: several sit
  in the same legs.
* The re-pointed VRT baselines — one scoped `task vrt:commit`. NOTE the count
  is no longer 29: `workflow-dock-patch` re-points to the pinned MIXMSTRS
  drawer and its picture changes deliberately.
* `camera-input.ts`'s 8 hits, after the fold.
* THEN the attest, on whatever `task webgl:attest:check` reports at that point.
