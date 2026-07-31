# DX7 — status and remaining plan (shelved 2026-07-29)

Program plan: `.myrobots/plans/dx7-and-faces-design-program-2026-07-27.md`
(+ owner decisions in `.myrobots/plans/` — see the PR 0 decisions doc).

Shelved at owner's request while shutting down. **Nothing is in flight.** No open
PRs, no branches awaiting work, main green.

## Landed — 4 of 7

| PR | what | merged |
|---|---|---|
| **PR 0** | 32-algorithm routing table + PER-ALGORITHM feedback | #1187 |
| **PR 0b** | authentic operator envelope + fixed-frequency law | #1210 |
| **PR 1** | incremental non-destructive dx7 operator messages | #1190 |
| **PR 2** | param cell kinds + the panel shell cell | #1225 |

PR 0 mattered more than its title suggests: only **21 of the 32 algorithms were
distinct** before it.

## Remaining — 4

| PR | what | depends on | state |
|---|---|---|---|
| **PR 3** | pure model layer | PR 0 ✅ | **unblocked, ready to start** |
| **PR 5** | voice edit buffer + preset STAMP model | PR 1 ✅ | **unblocked, ready to start** |
| **PR 4** | algorithm chip + popover picker + glyph | PR 2 ✅, PR 3 | blocked on 3 |
| **PR 6** | the operator map + detail panel | PR 3, 4, 5 | last |

**PR 3 and PR 5 are independent of each other** — 3 hangs off PR 0, 5 hangs off
PR 1. They can run in parallel. Then PR 4, then PR 6.

**PR 6 is the one that makes DX7 look like its spec.** Everything before it is
groundwork.

## The one real risk, and it is inside PR 3

`coarse`/`fine` must be **ADDED to `DX7OpData`**. Today the type stores only the
derived `ratio` (`dx7-syx.ts:58-75`); `parsePackedVoice:183-186` reads coarse and
fine and **discards them**, and `dx7-banks.ts`'s `op()` helper does the same.

Consequences, all of which are the actual work of PR 3:

- touches `dx7-syx.ts`, `dx7-banks.ts` (**×9 voices**), `dx7-render.ts`, and the
  ART fixtures;
- needs a defined **`ratio → (coarse, fine)` inverse**;
- needs a **migration**: every already-saved rack's `node.data.userPatches` has no
  coarse/fine, and *without the inverse an imported cartridge opens with an empty
  pitch row*.

Because it moves ART fixtures, this wants the **full `task art`**, per the
repo standard that ART pins exact voicing.

Also flagged in the plan and easy to get wrong: **`deepUnwrapVoice` is a NEW
function, not an extraction.** `sendPatch`'s existing unwrap
(`modules/dx7.ts:274-283`) builds a `PatchMessage` operator payload — a
*different shape* from `DX7Voice` (no `pitchEg`, no `lfo`, no
name/algorithm/feedback/transpose wrapper). Two functions, not one.

## Cheap parts

- **PR 3**: no UI, no def change, no contract change. CI delta ~+2 s.
- **PR 4**: no new params/families → **no contract-lock move**. VRT: regen
  **darwin** `face-dx7-compact` + `face-dx7-dock` only. `linux/face-dx7-compact`
  and `linux/face-dx7-dock` are already in `EXEMPT_BASELINE_PAIRS`
  (`vrt-exemptions.ts:1003-1004`) — **leave them exempt, no `vrt-update.yml`
  dispatch.** CI delta ~+2 s.
- **PR 5**: `selectDx7Preset` becomes a **stamp** in ONE `mutateNode`
  transaction, so undo is a single step and collab sends one message.
- **PR 6**: two new `controlFamilies` (`dx7-operator-map` kind `'cell'`,
  `dx7-op-detail` kind `'other'`). Their `testidPrefix` grep
  (`module-docs-lint.test.ts:233-243`) is satisfied by the new `.svelte` files
  themselves — **no legacy-card edit**. `task docs:accept` → **+2 contract-lock
  lines**.

## EG editor detail worth not re-deriving (PR 6)

Four draggable points. **Y = LEVEL** (0–99). **X = the RATE of the segment
ARRIVING at that point**, mapped `x = (99 − rate) / 99` — **raw rate, never
seconds**.

Corrections already folded into the plan doc during this session, do not
re-introduce the originals:

- **MARIMBA → TUB BELLS**
- the `lastGate` mechanism is a **hard RETRIGGER**, not silence
- **rate 0 = 317.487 s**, not 90 s
- hold is a **FROZEN segment 3**, not segment 2

## Where to pick up

Start PR 3 and PR 5 in parallel. Budget the bulk of PR 3 for the coarse/fine
migration + inverse, not for the new pure modules.
