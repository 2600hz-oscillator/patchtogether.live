# S4 CLOSE-OUT — the switch and the fleet, as landed

**Status:** ⚠ EVIDENCE, NOT INSTRUCTION (`.myrobots/` per AGENTS.md).
**Landed at** `794e530bbd` (S4a, the switch) and `e7b8b102f8` (S4b, the fleet),
on top of `74fa2f23db` (S3, the card VRT sweep).

## The order, and why it was two commits rather than one

The brief says the switch and the fleet are inseparable because of the
blank-rack hazard: `hasCard:false → 'legacy' → SvelteFlow's default renderer`.
That is true of the ORDER, not of the commit. Collapsing `laneRenderKind` so the
`'legacy'` arm does not exist removes the hazard outright — there is no input
that resolves to a card — and the 194 cards then become unreachable code that
still compiles. So S4a is a complete, green, reversible state, and S4b is a
deletion with nothing to race.

## What the two arms cost, measured before they were removed

| question | answer |
|---|---|
| `STRICT_FACES` entries | **194** |
| `*Card.svelte` files | **194** |
| inventory: registered / promoted / organizational-native / remaining | 195 / 194 / 1 / **0** |

So `'placeholder'` (the un-migrated lane body) had ZERO population before it was
deleted, and `'legacy'`'s only reachable input was the query param. `'native'` is
the one carve-out that survives — `NON_SHELL_LANE_TYPES` is `{cadillac}`, which
`flowNodes` filters out BEFORE the decision runs, so the arm exists to keep the
function total rather than to answer `'shell'` for a node `ModuleShell` never
receives.

## ⚠ THE LIVE CARD-MOUNTING PATH S4a CLOSED

`dockRailRendersFace` was `shellFaces && pinned && migrated`, and
`Canvas.svelte` passed `pinned: false` for every USER-DOCKED node. A docked,
non-pinned occupant therefore mounted its VERBATIM CARD in the dock rail, on the
default shell, in the shipping product. The S2 ledger had flagged it ("a live
card-mounting path that the whole e2e inversion does not touch"). All three of
the rule's terms lost their subject at once, so the rule was deleted rather than
narrowed.

## The blast radius was the pre-stage's report card

Deleting all 194 cards + the card map + the eager glob + `card-source` +
`card-def-debt` + `card-def-agreement` + `card-control-ranges` +
`card-range-source` + `card-primitive-parity` produced **four compile errors in
three files**. `card-media-lifetime`, `card-flow-store-guard` and
`present-lifetime` — the three whose min-population guards were the stated risk
— passed untouched.

Runtime residue was two files, both LOAD-TIME reads rather than assertions:
`wavesculpt-face-model.test.ts` bound `WavesculptCard.svelte` to a const nothing
referenced, and `chromaconsole-face-model.test.ts`'s "ONE implementation" leg
named the card's `knobLabel`.

## ⚠ FOUR TRAPS, AND ONLY TWO WERE ON THE LIST

1. **`doom-face-model.test.ts` had THREE card source-probes, not two.** The
   third — "the param writes are TRACKED — the raw-write debt is paid, not
   moved" — reads the card through the same `cardSrc()` helper and is easy to
   miss. Ruling 30 applied to all three.
2. **`collapse-keeps-playing.spec.ts` fails in a subtler way than "passes on an
   empty population".** Its FILE-LEVEL floor (`expect(players).not.toEqual([])`)
   works and would have reddened. What goes silently false is the PER-TYPE
   conditional at :636 — `if (realPlayerTypes().includes(type))` — which stops
   asserting the file input and play button exist while the test reports green.
   The derivation is re-pointed at a RECURSIVE walk of the surviving surfaces: a
   flat scan reproduces the same zero, because the testids live one directory
   down (`videobox/VideoboxScreenBody.svelte`,
   `videovarispeed/VideoVarispeedTransportBody.svelte`).
3. **⚠ `scripts/new-module.ts` STILL SCAFFOLDED A CARD.** Every new module got a
   `<Type>Card.svelte` stub, a card-map enumeration line, and a `--no-card` flag
   to skip it. Nothing would have failed; the next module would simply have
   re-created a file no renderer mounts, and the one after that, and so on. This
   is the S5 item that quietly undoes the whole programme, and it is why the
   plan lists it.
4. **Two anti-vacuity anchors named things this work deleted** — which is the
   shape working correctly, not a defect. `new-module.test.ts` snapshotted
   `modules-card-map.test.ts` and floored undo at three deleted files (two now).
   `agent-context.test.ts` anchored "the docs AGENTS.md points at resolve" on the
   NAME `docs/design/face-migration.generated.md`. AGENTS.md now links no docs
   page at all, so a replacement name would be a guess about prose; the anchor is
   a POSITIVE CONTROL on the extractor instead (it must find a real citation and
   must not invent one), which stays checkable however the prose moves.

## The worker ratchet needed NO re-pin, and the reason is worth keeping

The brief lists "re-pin worker ratchet, delta recorded" as a post-commit. It does
not move: **PASS — 384.30 KiB gzipped, 245.70 KiB under the 630 KiB budget**,
`task build` exit 0. The cards were NEVER IN THE WORKER — `vite.config.ts`'s
`ssrDropBrowserOnlyGraph()` replaced the eager `*Card.svelte` glob with an empty
map in the SSR build (that was #2088's whole point), so deleting the real files
is neutral for the server bundle. The plugin's other two occupants (`<Canvas>`
and `/dev/**`) keep it, along with the `PT_SSR_KEEP_CARDS=1` negative control.

The plan's companion item — "re-prove SSR POSITIVELY (a scratch commit
reintroducing a server-reachable card import must go red)" — cannot be performed
in its stated form: there is no card to import. The standing equivalent is the
ratchet above, which fails in BOTH directions and still catches the next
server-reachable heavy import.

## Numbers

| | |
|---|---:|
| S4b alone | 226 files, 65,744 deletions |
| session total (from `3a3985c33`) | 515 files, 71,742 deletions |
| typecheck | 4,109 files → **3,900**, 0 errors |
| `task test` at `e7b8b102f8` | **21,061** passed, 0 failed |
| e2e collection | 2,971 tests in 492 files |

## STILL OWED — read this before claiming S4 is finished

* `ModuleShellPlaceholder.svelte` — unreachable since S4a (no arm emits
  `moduleShellPlaceholder`), still present with CSS + model consumers.
* The 29 re-pointed VRT scenes (40 boots) owe ONE scoped `task vrt:commit`
  recapture. They run in NO CI job, so nothing required is red; the next capture
  photographs faceplates against card-framed pins.
* The webgl attest: hash `aacfac95…`, deliberately deferred (see
  `ci-first-signal.md`) — and now is the moment, because the fleet is deleted
  and the basis has stopped moving.
* **116 files under `packages/web/src` still carry `?shell=legacy` prose**, much
  of it user-facing module documentation that a player reads. That is ruling 2's
  archaeology sweep and it is the bulk of S5.
* `_module-card.css` prune to `.rl-tile` survivors + merge into
  `_rackline-tile.css`.
