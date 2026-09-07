# Legacy-UI removal and faceplate creation — how it actually works

Read-only analysis of all 52 open issues + the code they cite, 2026-08-13 against `main`.
Written for the owner, who asked: *"how is the legacy removal going to work in terms of
faceplate creation? i believe we need to have all new faceplates before we can remove all
the legacy code but i would like an explanation of how we're going to approach this."*

## The short answer

**The hypothesis is right about the thing that matters, and incomplete in three ways that
will cost time if left unstated.**

Right: **the card fleet and the shell switch cannot be deleted until every module has a new
surface.** That gate is real and encoded. Nothing in the code contradicts it.

Incomplete:

1. **"All faceplates" is not one kind of work.** 140 modules get a generic `face`.
   **50 get a hand-built bespoke surface** — not a faceplate. 3 get nothing (rack
   furniture). The 50 are the long pole and are all blocked behind one issue currently
   labelled **P1**.
2. **Legacy removal is not one event at the end.** Roughly half the legacy *coupling* — VRT
   baselines, masks, exemptions, legacy-coupled e2e specs, the DOM-source compensation
   layer — is designed to be deleted **per module, in the same PR as its face**. Deferring
   that to the end creates a cliff of 574 spec references and ~300 baselines landing at
   once. Only the *switch* and the *card files* are genuinely all-or-nothing.
3. **"Delete ALL legacy code" is not literally reachable.** `GroupCard.svelte` and
   `StickyCard.svelte` are organizational furniture that never migrate, and they live
   inside the fleet LEG-08 promises to zero out. #1519's acceptance criterion is wrong as
   written — small, but it will stop a deletion PR dead.

Accurate framing: **all faceplates before the deletion — but the deletion is the last ~15%
of the work, and the other ~85% removes legacy incrementally as it goes.**

## 1. The mechanism that makes staging possible

`packages/web/src/lib/ui/workflow/legacy-fallback.ts:107-111`:

```ts
export function laneRenderKind(i: LaneRenderInput): LaneRenderKind {
  if (i.userDocked) return 'stub';
  if (!i.shellFaces || !i.hasCard) return 'legacy';
  return i.migrated ? 'shell' : 'placeholder';
}
```

Four render kinds decided **per module, per node, at render time**. `migrated` is
`STRICT_FACES` membership. This is why day one shipped with zero reskins and why module 33
can land without module 34 existing.

A migrated module renders `<ModuleShell>` in the lane; an un-migrated one renders
`<ModuleShellPlaceholder>` whose expand opens the **verbatim legacy card**
(`DockFullView.svelte:319` → `:331-332`).

**Consequence:** migration is incremental by construction. Deletion is not — the
placeholder path is *shared*, so one un-migrated module keeps the entire legacy branch, the
card glob and the SSR-drop plugin alive. That is the real argument for the gate, and a
better one than "partial UI looks bad."

## 2. The unit of progress is the DISPOSITION, not the face

PR #1581 (closing #1510) landed `face-migration-inventory.ts`: every registered module gets
**exactly one disposition**, deny-by-default — a new def with no entry is red, and an entry
naming a dead def is red (`:51-54`). The done-set is *not stored*; it is read off
`STRICT_FACES`, itself asserted ≡ "the defs that declare a `face`", both directions
(`strict-faces.ts:10-15`).

**Disposition = what kind of work. Face = completion.** Both gated, neither hand-counted.

Derived from `docs/design/face-migration.generated.md` (gate re-run: 19 tests pass):

| disposition | total | done | **remaining** | audio | video | meta |
|---|---|---|---|---|---|---|
| `generic-face` | 140 | **32** | **108** | 61 | 47 | 0 |
| `bespoke-surface` | 50 | 0 | **50** | 27 | 18 | 5 |
| `blocked` | 3 | 0 | **3** | 0 | 3 | 0 |
| `organizational-native` | 3 | — | never migrates | 0 | 0 | 3 |
| **registered** | **196** | **32** | **161** | | | |

Blocker fan-out:

| blocker | issue | modules waiting |
|---|---|---|
| `needs-extension-registry` | **#1512** | **50** |
| `needs-note-entry-cell` | #1509 | 15 |
| `needs-media-controller` | #1511 | 12 |

⚠ **#1516's cohort-A figure is stale** — its comment says 90; the committed inventory says
**108**. The delta is ~18 modules #1581 moved into `generic-face`. Anyone scoping from the
comment under-scopes by 20%.

## 3. Dependency order

```
#1510 LEG-01 inventory ────────────────── DONE (PR #1581)
#1538 e2e shard rebalance ─────────────── DONE (PR #1558; 805s → ~544s worst shard)

  ├─ #1515 LEG-04  invert e2e fixture ─── UNBLOCKED, P0, NOT STARTED
  ├─ #1517 LEG-06  full-tier VRT tier ─── UNBLOCKED
  │
  ├─ #1512 extension registry ──────────► unblocks 50 bespoke   ◄── WIDEST GATE
  ├─ #1509 note-entry cell + xy pads ───► unblocks 15
  ├─ #1511 LEG-02 media lifecycle ──────► unblocks 12 + fixes the live P0 bug wave
  │
  └─ #1516 LEG-05 the migration
        ├─ cohort A (108) ──── UNBLOCKED TODAY
        ├─ cohort B (15) ───── after #1509
        └─ cohort C (50+3) ─── after #1512 / #1511
              │
              ▼  "no placeholder reachable" sweep = the green light
        #1520 LEG-09 drain legacy tests (per module, alongside)
              ▼
        #1518 LEG-07 delete switch + placeholder + headless host
              ▼
        #1519 LEG-08 delete 195 cards / 69,474 LoC
              ▼
        #1521 LEG-10 second harvest
```

**The critical path is not cohort A.** 108 generic faces are parallelizable and blocked on
nothing. The critical path is **#1512 → 50 bespoke surfaces, one per PR** — the hardest and
most serialized work.

⚠ **#1512 is P1 while #1509 and #1511 are P0, and it gates 4× more modules than either.**
The clearest mis-prioritization on the board.

## 4. Parallel vs. serialized

**Parallel now:** #1515 bucket (a) · #1517 manifest · #1516 cohort A · #1512 · #1511 ·
#1509 · #1579.

**Strictly serialized:** LEG-07 behind complete LEG-05 · LEG-08 behind LEG-07 · LEG-09
per-module ahead of that module's card deletion · LEG-10 last.

## 5. The carve-outs — and where the plan is wrong about them

`NON_SHELL_LANE_TYPES` (`legacy-fallback.ts:66-76`) has 9 entries, splitting three ways:

**(a) Six snowflakes that DO get new surfaces** — `clipplayer`, `controlSurface`,
`electraControl`, `launchpadControl`, `videoOut`, `cameraInput`. All `bespoke-surface`.
They keep verbatim legacy cards *today* rather than a lossy placeholder, then plug into
#1512's extension seam. **Not permanent legacy.**

**(b) `launchpadControl` names a type no def has.** The registered id is
`launchpadControlLeft` (`meta/modules/launchpad-control.ts:31`), so the carve-out never
fires and the Launchpad surface renders a **placeholder tile today** — filed as #1579.
Found because the inventory is anchored to the registry while this bare `Set<string>` is
not: the repo's own "anchor to the artifact, not the list" rule.

**(c) Three organizational natives that NEVER migrate** — `group`, `sticky`, `cadillac`.

> ⚠ **#1518 and #1519 are wrong as written.**
> - #1518 says `LaneRenderKind` becomes `'shell' | 'stub'`. It cannot: `group`/`sticky`
>   must keep returning `'legacy'`.
> - #1519 says **zero** `*Card.svelte` under `src/lib/ui/modules/`, exempting only
>   `DockStubCard` and `RearCard` — but `GroupCard.svelte` and `StickyCard.svelte` are in
>   that directory and in the 195.
>
> Either the exemption list grows by two, or those two components get **renamed and moved
> out of the card fleet**. **Nobody has written down which.** Five minutes now, a blocked
> deletion PR later.

**(d) The DOM-source layer** — `dom-source-modules.ts:60-70` names 9 modules whose media
exists only because a card is mounted; `HeadlessSourceHost.svelte` parks their real cards
off-screen at `left:-9999px` to compensate. Dies per-module with #1511.

> ⚠ **#1511's scope list is video-only and misses three modules.** `audioIn` (a live
> `getUserMedia` stream, `AudioinCard.svelte:361`), `toybox` and `recorderbox` are in the
> same position but invisible to `DOM_SOURCE_LANE_TYPES` because that set keys off the
> *video* engine's `attachExternalSource`. Fix the issue body before someone scopes from it.

## 6. Visual coverage (#1517) — must land EARLY, not merely before deletion

Measured today:

- **64** face baselines (32 modules × compact + dock). The **full lane tier has no per-face
  pixel baseline at all.**
- **115** legacy-card baselines under `e2e/vrt/__screenshots__/vrt.spec.ts/`, all captured
  through `?shell=legacy`.
- 32 modules carry uncompanioned canvas masks — a masked renderer can go blank and pass.

The delete-on-migrate policy is right: when a face lands, its legacy scene, baseline PNG,
`EXEMPT_FROM_VRT` entry and mask entry die *in the same PR*.

**Sharper timing answer:** the full tier must land **before cohort A scales**, not before
LEG-08. Otherwise 108 faces are born with 2 tiers each and you owe a ~324-baseline
retro-capture wave. Born-with-3-tiers is nearly free; retrofitted is a multi-day campaign.

Three hazards this repo has already been bitten by, now at 161× scale:
- `--update-snapshots` cannot regenerate a *passing-but-stale* baseline — `git rm` first.
- A `git rm`-ed baseline is **silently recreated** by the next plain VRT run as an untracked
  PNG no gate reads.
- Bare `--update-snapshots` is `=all` in Playwright 1.59 and once rewrote 22 unrelated
  baselines.

**Count the files the bot commits against what the manifest predicts, every dispatch.**

## 7. Most likely to bite: LEG-04 has not started and is going BACKWARDS

`e2e/tests/_fixtures.ts:86` still reads:

```ts
rack: async ({ page }, use) => {
  await page.goto('/rack?shell=legacy&seed=none');
```

with the header at `:70` noting **~169 specs reach the canvas only through here.**

| | #1515 filed (`b9d5e247`) | **today** |
|---|---|---|
| `e2e/tests/` files | 272 | **277** |
| `e2e/vrt/` files | 34 | 34 |
| `packages/web/` files | 8 | 8 |
| **total occurrences** | **571** | **574** |

**It has grown.** There is no `legacyRack` fixture and no allowlist artifact. Every new spec
written this week defaulted onto the dying UI, because the deny-by-default guard #1515
specifies does not exist yet. Cheapest item on the board, compounding cost, P0, untouched.

## 8. The half-migrated state is currently shipping DATA LOSS

Not captured in the LEG issues. Under the default shell an un-migrated module's card only
exists while its dock pane is open — so collapsing, **or an LRU eviction when a third module
is expanded with no user action against the affected module at all**, runs `onDestroy` on
resources whose real lifetime is the NODE:

- **#1588 samsloop (P0)** — press REC, collapse, take **silently destroyed**
  (`SamsloopCard.svelte:618`). No commit path exists at all. Worse than recorderbox pre-#1574.
- **#1587 wavesculpt + timelorde (P0)** — video **black on rack load**, before the user
  touches anything; the patch looks correctly cabled.
- **#1589 toybox (P0)** — collapse drops every video layer *and* Export silently writes a
  zero-video preset reporting success.
- **#1590** — skifree / synesthesia / audioIn: live outputs die on unmount; skifree's GATE
  never pulses again for the life of the node.
- **#1583** is the epic, and flags that its verifier pass died on a session limit, so
  `confirmedCount: 0` meant *"no verifier ran"*, not *"nothing is wrong"*. **A floor, not a
  ceiling.**

**Sequencing consequence:** these exist *because* the migration is half-done, but they are
**not** an argument for rushing faces — a faced module has the identical bug if its producer
still lives on a card. They are an argument that **#1511-class node-ownership work is the P0
correctness work, which happens to unblock 12 modules as a side effect.** The proven fix
shape exists twice already (#1531, #1574): a node-keyed registry where cards *adopt and
read*, never *create and destroy*, teardown keyed to graph lifetime, and the structural
guard is the **absence** of a teardown method so `tsc` refuses the wrong call.

## 9. Recommended order

**Now, in parallel:**

1. **#1515 LEG-04 bucket (a) + the deny-by-default guard.** The guard matters more than the
   migration — it stops the bleeding immediately.
2. **#1512 extension registry — re-label to P0.** Gates 50 modules (4× #1509, 4× #1511) and
   is the only platform blocker with no work started. DX7 is the proof case already in
   `ModuleShell.svelte`.
3. **#1511 / #1583 wave as ONE effort.** Fix the P0 data loss and extract node-owned
   controllers in the same PRs. Add `audioIn` / `toybox` / `recorderbox` to #1511 first.
4. **#1517 full-tier manifest** — before cohort A scales.
5. **#1579** — Launchpad carve-out typo + anchoring gate for `NON_SHELL_LANE_TYPES`.

**Then the standing pipeline:**

6. **Cohort A, 108 modules, 4–6 per PR.** Restart the rolling face pipeline (paused
   2026-08-11 for token cost — it is the delivery mechanism and nothing replaces it).
   `task face:propose` drafts a face from the card's render order for review. Each PR
   carries #1516's definition-of-done: face + `STRICT_FACES`, 3 VRT tiers, per-port/
   behavioral green, **Push-card check** (face metadata re-ranks `PUSH_CARD_CONTROLS` tiers
   and can silently reshuffle a module's Push 2 card), legacy VRT scene + mask + exemption
   deleted, specs flipped off `legacyRack`.
7. **Cohort B (15), then cohort C (50 + 3)** as blockers clear.

**Then, and only then:** placeholder-unreachable sweep → LEG-07 → LEG-08 → LEG-10.

**Fix in the issue list before anyone picks them up:** #1519's zero-cards acceptance
(Group/Sticky) and #1516's stale 90 → 108.

## 10. Rough sizing

| work | modules | PRs (at stated batch size) |
|---|---|---|
| cohort A generic faces | 108 | ~18–27 (4–6/PR) |
| bespoke surfaces | 50 | ~50 (1/PR) |
| blocked → generic | 3 | ~1–2 |
| platform (#1509/#1511/#1512) | — | ~15 |
| LEG-04 + LEG-06 | — | ~8–12 |
| LEG-07/08/09/10 | — | ~10–15 batched |
| **total** | **161** | **~110–130 PRs** |

**CI headroom has cleared** — #1538/PR #1558 moved e2e to cost-based sharding, worst shard
805s → ~544s against the 900s hard timeout, spread 2.31× → 1.26×. That was #1516's stated
gate on scaling cohort A. Remaining CI risk: the flaky tail (#1569 — six tests, not two) and
per-faced-module sweep growth.

## 11. Other things that will bite

- **Attest bases.** Video cards sit in the WebGL basis; the collab basis is similarly
  touchy. Deleting them costs re-attests. Plan deletion waves *against the basis file
  lists*, batch into one window, verify the hash before burning GPU time.
- **Card-exported constants.** #1519 puts reverse-dependency inventory first for good
  reason — the repo has been bitten by a card re-typing a range the def owned, with every
  gate reading only the def side. Extract load-bearing exports *before* deleting.
- **Canvas is growing.** The punchlist quotes 8,610 lines; it is **9,027** today (+417).
  #1513's decomposition and #1521's finish are both downstream of the deletion.
- **`docs:accept` / push-card / DESCRIPTIONS.** Every faced module touches shared
  hand-maintained list files. At 4–6 modules/PR across a parallel pipeline,
  `task pr:conflict-sweep` after every merge is not optional — and never
  `gh pr update-branch`.

## What could NOT be determined

- **Whether `organizational-native` means `GroupCard`/`StickyCard` move out of
  `src/lib/ui/modules/`.** No issue, comment or code says. Decides whether #1519's
  acceptance is achievable as written.
- **Realistic calendar time.** PR counts, not throughput. The rolling 4-face pipeline was
  paused for token cost and no measured completion rate exists.
- **Whether all 108 cohort-A modules are genuinely mechanical.** #1510's own caveat: the
  classification is a source reading, not an execution. Expect some to reclassify to
  `bespoke-surface` mid-flight — the deny-by-default gate makes that a visible, reviewed
  diff rather than a silent slip, which is what it is for.
- **Per-faced-module CI wall-time delta.** Unmeasured; at ~161 modules it is the number most
  likely to force the #1544 nightly-tier decision.
