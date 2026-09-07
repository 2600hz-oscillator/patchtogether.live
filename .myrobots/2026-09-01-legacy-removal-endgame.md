# Legacy-card removal endgame — measured surface and phased plan

**Date:** 2026-09-01
**Status:** ⚠ **EVIDENCE, NOT INSTRUCTION.** Per `AGENTS.md`, `.myrobots/` is evidence, not a
work order. Nothing here is an approved decision; every gate, workflow, ratchet, or Taskfile
change is presented as an OWNER DECISION with costs.
**Basis:** measured at `origin/main` @ `326f257ed`, re-verified in part at
`origin/main` @ `2e2f0c185` (2026-09-01 15:30 -0400, #2292 trails).
⚠ **Every line number below was true when read and MUST be re-verified before acting.**
Several citations carried in the tree's own prose were found FALSE during this measurement
and are flagged inline. The primary checkout is stale — read via `git show origin/main:<path>`
or from a worktree.

**LEG-xx status.** `LEG-01`…`LEG-10` are #1510, #1511, #1509 (03a), #1515, #1516, #1517,
#1518, #1519, #1520, #1521. **All of them are CLOSED** — swept in the 2026-08-22 board purge,
not completed. They survive as *naming*, and the work below is PR-shaped, not issue-shaped.
⚠ Per the standing ruling, **nobody opens or reopens issues without the owner**.
⚠ Note in particular that **LEG-04 (#1515, invert the canonical e2e fixture) is closed and
was NOT done** — 306 specs still boot `?shell=legacy`. That is the schedule's real long pole
after §3.

---

## 1. The measured legacy surface

### 1.1 The card fleet

| | count | LoC |
|---|---:|---:|
| `*Card.svelte`, all | 198 | 67,778 |
| — `lib/ui/modules/*Card.svelte` — **the deletable fleet** | **196** | **66,682** |
| — `lib/ui/dock/DockStubCard.svelte` — NOT legacy (docked-stub tile) | 1 | 180 |
| — `lib/ui/workflow/RearCard.svelte` — NOT legacy (the new rear panel) | 1 | 916 |

Median 205.5 LoC, min 13, max 3,883.

**Already unreferenced: ZERO.** Recomputing the resolver's map from the *generated* registry
manifest (197 types, minus `cadillac` which is `NO_CARD_BY_DESIGN`, `modules-card-map.test.ts:100`)
against the 196 basenames, applying the 34 explicit `card:` overrides and
`conventionalCardName()` otherwise, gives a **clean 196↔196 bijection — 0 orphans, 0 missing,
0 cards shared by two types.** Every card is still lane-reachable, *including all 175 faced
modules*, because `?shell=legacy` renders the verbatim card in the lane regardless of
promotion.

- Registry glob: `packages/web/src/lib/ui/modules-card-components.ts:35` —
  `import.meta.glob('./modules/*Card.svelte', { eager: true })`
- Resolver: `packages/web/src/lib/ui/modules-card-map.ts:50-58` (`buildNodeTypes`), `:30`
  (`conventionalCardName`)
- SSR stub: ⚠ **the plugin is `ssrDropBrowserOnlyGraph()`** at
  `packages/web/vite.config.ts:182` — **not** `ssrDropCardComponents()`, which does not exist
  and survives only in stale in-tree comments. It also stubs **`Canvas.svelte`** and every
  `/dev/**` `.svelte`. (~1.9 MiB gzipped against a 3 MiB Worker ceiling.)

Largest three cards, **all un-migrated**: `ToyboxCard` 3,883 · `ClipplayerCard` 3,652 ·
`DoomCard` 2,912. The 19 unfaced modules hold **19,587 LoC (29.4%)** of the fleet. That is
work to be **built**, not deleted.

### 1.2 The shell switch and the fallback

**One flag reader in the whole tree** — `packages/web/src/lib/ui/Canvas.svelte:530`:

```
let shellFaces = $derived(page.url?.searchParams?.get('shell') !== 'legacy');
```

No server hook, no layout, no route reads `shell` (verified against every `searchParams` use).

`packages/web/src/lib/ui/workflow/legacy-fallback.ts` — 324 lines, the whole decision:

| symbol | line | role |
|---|---:|---|
| `LaneRenderKind` (`'legacy'\|'shell'\|'placeholder'\|'stub'`) | 32 | the 4-way |
| `NON_SHELL_LANE_TYPES` | 178 | **5**: `group`, `sticky`, `cadillac`, `clipplayer`, `controlSurface` |
| `laneRenderKind()` | 215 | `if (userDocked) 'stub'; if (!shellFaces \|\| !hasCard) 'legacy'; return migrated ? 'shell' : 'placeholder'` |
| `emittedTypeFor()` | 223 | `'legacy'` → the module's own type |
| `isShellSwappable()` | 241 | `hasResolvableCard && !NON_SHELL_LANE_TYPES.has(type)` |
| `dockRailRendersFace()` | 322 | `shellFaces && pinned && migrated` |

Call sites: `Canvas.svelte:2723`, `:3173` (both pass
`hasCard: isShellSwappable(n.type, cardTypeSet.has(n.type))`), `:2230`, `:2897/:2905` (dock
rail), `AudioIoSurface.svelte:73`.

⚠ **`cardTypeSet` contradicts its own comment.** `Canvas.svelte:624` is
`new Set(Object.keys(nodeTypes))` computed **after** `dockStub` / `moduleShell` /
`moduleShellPlaceholder` are spread in — 199 keys, not "the glob-built map minus the
non-def helpers" (`:621-623`). Harmless today only because no module type collides with those
three names.

⚠ **`rendersPlaceholderTile` is NOT app code.** It exists only in
`e2e/tests/_face-fixtures.ts:361`, and it reads the live `NON_SHELL_LANE_TYPES` rather than a
copy — good.

Supporting surface:

| file | LoC | note |
|---|---:|---|
| `lib/ui/workflow/strict-faces.ts` | 5,461 | `STRICT_FACES` (175 entries, `:754`), `migrated()` (`:5459`) — almost entirely per-module rationale prose |
| `lib/ui/modules/ModuleShellPlaceholder.svelte` | 164 | `data-testid="module-shell-placeholder"` (`:114`) |
| `lib/ui/workflow/dom-source-modules.ts` | 405 | the headless-host rosters |
| `lib/ui/workflow/HeadlessSourceHost.svelte` | 106 | off-screen card mount (`position:fixed; left:-9999px`) |
| `lib/ui/dock/DockFullView.svelte` | 510 | legacy branch `{:else}` at `:365-381` → `.fp-card-mount` |
| `lib/ui/dock/DockCardHost.svelte` | 304 | `face` prop selects shell vs card |
| `lib/ui/Canvas.svelte` | 10,550 | hosts the switch |

**The headless producer host is the load-bearing piece** (`dom-source-modules.ts`):
`DOM_SOURCE_LANE_TYPES` (`:136`) = `archivist`, `cameraInput`, `loopback`;
`CARD_PRODUCER_LANE_TYPES` (`:247`) = `cube`, `rasterize`, `scope`, `synesthesia`,
`timelorde`, `wavesculpt`; `HEADLESS_MOUNT_LANE_TYPES` (`:262`) = the union, **9 types**;
`FACE_MOUNTS_PRODUCER` (`:391`) = `cube`, `rasterize`; `needsHeadlessSourceMount()` (`:400`).
For these 9, **engine-visible state depends on the legacy card being mounted somewhere** —
8 are already faced and the real card is still kept alive off-screen.

### 1.3 Legacy-coupled tests

⚠ **The "377 of 431" figure is STALE. Today it is 306 of 562.**

| | count |
|---|---:|
| `*.spec.ts` files total | **562** (`e2e/tests` 490 · `e2e/vrt` 70 · `e2e/audio-drift` 1 · `e2e/chaos` 1) |
| **navigate to `?shell=legacy` on a non-comment line** | **306** (`e2e/tests` 274 · `e2e/vrt` 32) |
| mention `shell=legacy` in prose only | 31 |
| textual union (`shell=legacy` ∪ `LEGACY_RACK_URL`) | 337 |
| non-spec helpers carrying the string | 12 |

Navigation is overwhelmingly direct: ~636 non-comment `page.goto(` vs 39 `bootRack(` and 17
`bootWithFace(`. The `rack` fixture (`e2e/tests/support/rack-session.ts:390`) defaults
`rackUrl` to `LEGACY_RACK_URL` (`:143` = `/rack?shell=legacy&seed=none`), but **only 2 spec
files import it** and both also carry the literal — so the textual count hides no implicit
population.

**Unit tests.** **84** unit files reference a card path (the narrower `Card.svelte'` pattern
gives 61 — do not use it). **Zero mount a card component.** The coupling is a
**source-lint family**: ~60+ read the card SOURCE as text via `readFileSync` /
`readCardSourceWithDelegates`. Shared readers: `lib/ui/card-source.ts` (74),
`lib/ui/modules/card-def-agreement.ts`, `card-def-debt.ts` (280), `card-kit.ts` (137),
`card-resize.ts`, `lib/graph/hidden-card.ts` (51), `lib/ui/video-card-visibility.ts` (118).

Card-fact ledgers that die with the fleet:
- `card-def-debt.ts` — `OPERATIONAL_DEBT` 6, vocabulary debt 242 entries across 50 named cards
  (header still says "all 193 cards" — stale by 3).
- `card-range-source.test.ts` (1,254 LoC) — `RANGE_BOUND_CARDS` **55** (`:269`);
  ⚠ `MAPPING_BOUND_CARDS` is **45** (`:695-880`), **not 20** as an earlier count claimed.

### 1.4 Migration-only rosters and generated artifacts

- **`docs/design/face-migration.generated.md`** (9,224 B) — regenerated by
  `flox activate -- task face:inventory:accept` (`Taskfile.yml:514`), pinned by
  `face-migration-inventory.test.ts`. Reports **197 registered · 175 done · 19 remaining · 0
  without disposition · 0 dead entries**. Dispositions: `generic-face` 176 (175 done),
  `blocked` 0, `bespoke-surface` 18, `organizational-native` 3.
  The 19: `joystick` (generic-face); `archivist chromaconsole clipplayer controlSurface doom
  mappy modtris moog956 nibbles painter peertube recorderbox seqtris textmarquee toybox trails
  videobox videovarispeed` (bespoke-surface). Blocker `needs-media-controller` (#1511/LEG-02)
  on 6.
  ⚠ **The PROSE in this artifact is systematically unreliable** (7/7 promotions found the
  `why` wrong). The **counts** are generated from the live registry × `STRICT_FACES` and are
  trustworthy. **Read the card, never the `why`.**
- **`face-migration-inventory.ts`** (1,663 LoC) — `FACE_MIGRATION_INVENTORY` (`:249`),
  `MIGRATION_BLOCKERS` (`:180`), `staleBlockers()` (`:212`), `FaceMigrationDisposition` (`:85`).
- **`e2e/vrt/vrt-exemptions.ts`** (1,772 LoC): `VRT_MODULE_MASKS` 32 · `EXEMPT_FROM_VRT` **69**
  · `ALLOWED_PERMANENT_EXEMPT` 21 · `STRICT_VRT_MODULES` 45.
- **`scripts/test-ledger.mjs`** already classifies this: bucket 2 splits coverage exemptions
  into **`legacy-card` (LEGACY-RETIRING)** vs **`engine` (LIVE, survives)**. At `326f257ed` it
  was 338 / **69** / 269; at `2e2f0c185` it is 342 / **69** / 273.
  ⚠ Its `SUBJECT_ANCHORS` cites "LEG-08 (#1519, the **195**-card fleet)" — **that 195 is stale**;
  the fleet is 196 and the VRT roster is 128.
- Cost artifacts any removal PR must re-pin: `e2e/e2e-timings.generated.json`,
  `e2e/vrt-strict-timings.generated.json`. ⚠ Accept them only when **no shard is still
  PENDING**, or the diff truncates into something that looks like a re-pin.

**Fixture runway, measured today** (`e2e/tests/_face-fixtures.ts`, 878 LoC; `deriveFixture()`
at `:464` returns `'ok' | 'migration-complete' | 'no-candidate'`, instrument check ordered
*before* the migration check at `:527`/`:552` — a genuinely well-built degradation;
`DENIED` at `:67` = `cameraInput`, `recorderbox`, `archivist`, `peertube`, `doom`):

| fixture | line | pool TODAY | members |
|---|---:|---:|---|
| `AUDIO_PLACEHOLDER_FIXTURE` | 625 | **6** | chromaconsole, joystick, modtris, moog956, seqtris, trails |
| `AUDIO_OPERABLE_FIXTURE` | 657 | **1** | `modtris` — the only un-promoted audio card mounting `<NeonFader>` (verified: Modtris 2, all five others 0) |
| `VIDEO_FIXTURE` | 705 | **7** | mappy, nibbles, painter, textmarquee, toybox, videobox, videovarispeed |
| `VIDEO_SINK_FIXTURE` | 770 | **2** | `mappy`, `toybox` — the only un-promoted video modules with both a video IN and a video OUT |

The file's own prose still says the placeholder pool was 34 and operable 4 at the #2137 split.
**`AUDIO_OPERABLE_FIXTURE` is ONE promotion from empty and `VIDEO_SINK_FIXTURE` is TWO** — and
`modtris` and `toybox` both have face work in flight right now.
`LEGACY_DOCK_CANDIDATES` (`workflow-rear-card.spec.ts:738`) = `['moog956','moog960','cartesian']`
— **2 of 3 already spent**; runway **1**, and `.myrobots/face-specs/moog956.html` already exists.

### 1.5 VRT baselines

594 committed baseline PNGs. **246 are captured on `?shell=legacy`** across **32**
legacy-booting VRT specs; **340** belong to `workflow-shell-faces.spec.ts` (the face surface —
survives).

The per-card sweep is `e2e/vrt/vrt.spec.ts` (191 LoC):
`COVERED_MODULES = REGISTRY.filter(m => !(m.type in EXEMPT_FROM_VRT))` (`:52`), booting
`/rack?shell=legacy&seed=none` (`:86`). **197 − 69 = 128**, and there are exactly **128 PNGs**
in `__screenshots__/vrt.spec.ts/`. Under `VRT_STRICT=1` it narrows to the 45
`STRICT_VRT_MODULES`.

Other legacy-baseline holders: `vrt-toybox` 27, `vrt-composite` 14, `vrt-colourofmagic` 9,
`vrt-wavesculpt-blink` 8, `vrt-quadralogical` 8, `vrt-composite-coverage` 8,
`vrt-karplus-tomtom-states` 6, `interactions` 6, plus 17 smaller.

`e2e/vrt/workflow-shell-zoom.spec.ts:114` pins a baseline on `workflow-recorderbox` rendering
a **placeholder** — promoting recorderbox moves that baseline, and the spec already says so.

### 1.6 ⚠ Three deletion-blocking gates that are easy to miss

1. **`modules-card-components.ssr-stub.test.ts`** — asserts the eager glob has **exactly one
   home**. A card-fleet deletion necessarily moves it.
2. **`scripts/measure-worker-bundle.mjs --check`** — a **Worker gzipped-size ratchet**. A
   deletion PR moves the number by construction; the ratchet must be re-pinned deliberately,
   not silently.
3. **`PT_SSR_KEEP_CARDS=1` + `packages/web/scripts/prove-ssr-identical.sh`** — explicitly a
   *negative* control ("build once each way, diff the HTML"). ⚠ Per repo standard a passing
   negative control is not enough: a fleet deletion should re-prove this **positively**, by
   reintroducing a server-reachable card import and watching the ratchet go **red**.

---

## 2. Phased removal order

Each phase names its **precondition**, its **exit test**, and its **revert**. Phases are
strictly serialised where marked. Nothing is deleted while something still depends on it.

> ⚠ **Phase 0 is not optional and is not last.** It is §3, and it must land **before** the
> unfaced population drops to 1 in any pool.

### **Phase 0 — FIX THE WRONG EXITS.** *(new work; no LEG anchor)*
- **Precondition:** none. Do it now.
- **Do:** convert every hard-fail-on-empty-population site in §3 to a clean, named
  degradation, and re-derive the two hard-coded subjects.
- **Exit:** each converted site, run with its pool artificially emptied, reports a *named*
  skip or a *named* "migration complete" verdict — never a throw and never a silent pass.
  ⚠ A skip is not a pass: pair each with the `no-candidate` instrument arm that already
  exists in `deriveFixture`.
- **Revert:** self-contained per site.
- **Schedule risk: HIGHEST.** Two sites land on `moog956` and two pools are 1–2 promotions
  from empty.

### **Phase 1 — LEG-03a (#1509) + LEG-02 (#1511): the two capabilities.**
- **Precondition:** none; these are build-work, not deletion.
- **Do:** the note-entry/text face cell and node-owned media. **25 of the remaining bespoke
  modules gate on these two, not on more faces.** 6 of the 19 carry `needs-media-controller`
  explicitly.
- **Exit:** the blocker disposition clears in the generated inventory via
  `task face:inventory:accept`, reviewed diff.
- **Revert:** ordinary feature revert; no deletion has happened.

### **Phase 2 — LEG-05 (#1516): promote the remaining 19.**
- **Precondition:** Phase 0 complete (or each promotion re-checks §3 by hand — do not rely on
  that), and Phase 1 for the 6 media-gated modules.
- **Do:** ship faces/bespoke surfaces for `joystick`, `archivist`, `chromaconsole`,
  `clipplayer`, `controlSurface`, `doom`, `mappy`, `modtris`, `moog956`, `nibbles`, `painter`,
  `peertube`, `recorderbox`, `seqtris`, `textmarquee`, `toybox`, `trails`, `videobox`,
  `videovarispeed`.
  ⚠ Owner rulings that bind here: **functional parity is a HARD requirement** (never surface
  "we would lose X"); **control-heavy → TABBED face**, never padded pages; **all video cards
  get SCREEN ON/OFF** which keeps rendering while OFF; **compact density always, decimals
  gone not hidden**; **faces carry near-zero prose**.
  ⚠ **Each promotion must clear the `NON_SHELL_LANE_TYPES` membership first** where it applies
  (`clipplayer`, `controlSurface`): that set short-circuits before `migrated` is read, so
  membership and promotion are mutually exclusive by construction.
  ⚠ **DOOM's face is in this phase and carries its own approval and its own hazards** — see
  `.myrobots/2026-09-01-doom-multiplayer-and-collab-attest.md`. Its game clock IS the frame
  clock; its waits are not ordinary waits.
- **Exit:** generated inventory reports **197 / 197 / 0 remaining**; `?shell=legacy` and the
  default shell both still work.
- **Revert:** per module.

### **Phase 3 — LEG-06 (#1517): replace visual coverage BEFORE deleting it.**
- **Precondition:** Phase 2 complete for each module whose baseline is being replaced.
- **Do:** face-tier baselines for the 128 modules currently covered by `vrt.spec.ts` on
  `?shell=legacy`, plus face equivalents for the 246 legacy-booted baselines across the 32
  legacy VRT specs. Delete a legacy baseline **only in the same PR that adds its replacement**
  ("delete-on-migrate", the phase's original framing).
- ⚠ **Cost warning carried from the original LEG-06 note:** doing this *before* the card
  deletion risks minting two tiers per face and owing a large re-baseline. Sequence the tier
  choice **once**, up front.
- ⚠ VRT playbook: **always `GREP=<module>` on a face PR** — a bare run derives the FULL set
  (41–56 min). Linux CI authors the single baseline set; **never commit a locally captured
  baseline**; use a scoped `task vrt:commit` and review the bot's exact diff.
  ⚠ `vrt-strict` is at 12 shards near ~61% of a 600 s cap; shard timeouts pass ZERO-failed and
  are **not** flakes.
- **Exit:** every deleted legacy baseline has a named face-tier successor; `vrt-strict` green
  with zero re-pins the bot did not author.
- **Revert:** baselines are content — revert restores both sides.

### **Phase 4 — LEG-04 (#1515): invert the e2e fixture. ⚠ THE LONG POLE.**
- **Precondition:** Phase 2 complete (nothing renders a placeholder any more) and Phase 3 for
  any spec that also pins a baseline.
- **Do:** re-point the **306** specs that navigate to `?shell=legacy` at the default shell, in
  reviewable batches. Flip the `rack` fixture default (`rack-session.ts:143/:390`) and the 12
  helper files. Keep a **generated allowlist** for whatever legitimately still needs legacy —
  derived, never hand-typed.
- ⚠ **This is where coverage is most easily gutted silently.** See §4.
- **Exit:** the allowlist is empty or every entry has a stated reason; the full `e2e` lane and
  `behavioral` green; skip counts **read**, not assumed (the line reporter's skip count is not
  a pass count).
- **Revert:** batch-sized; each batch is one PR.

### **Phase 5 — LEG-07 (#1518): delete the switch, placeholder, dock legacy branch, headless host.**
- **Precondition:** Phase 4 complete — **no spec and no code path reads `shell=legacy`.**
- ⚠ **The `hasCard` gate must be removed in the SAME change as (or before) the cards.**
  `laneRenderKind`'s second clause is `if (!shellFaces || !hasCard) return 'legacy'`. With the
  cards gone, `hasCard` is false for every module node → every node returns `'legacy'` →
  `emittedTypeFor` emits the raw module type → SvelteFlow falls back to its **default node
  renderer** and **the entire rack renders as blank boxes**. `modules-card-map.test.ts` reds
  first, but the app-level failure is a blank rack, not an error.
- **Do:** delete `Canvas.svelte:530`'s reader, `legacy-fallback.ts`'s legacy branch,
  `ModuleShellPlaceholder.svelte`, `DockFullView.svelte:365-381`'s `{:else}` `.fp-card-mount`,
  and `HeadlessSourceHost.svelte` + the 9-type roster in `dom-source-modules.ts`.
- ⚠ **The headless host cannot go until all 9 producers own their state at the NODE.** That is
  LEG-02's job for the media ones; `archivist` and `loopback` are the exposed remainder
  (`cameraInput` already moved to `camera-status-registry`). Card unmount kills node
  resources — the registry must be node-keyed, not card-keyed.
- ⚠ **`_module-card.css` (562 LoC) CANNOT be deleted in this phase.** It is imported globally
  at `routes/+layout.svelte:7` and — the reason the earlier note got wrong — it **itself
  contains live `.rl-tile` rules** (`:367`, `:373`) governing the **new** shell's rear-view
  flip, consumed by `ModuleShell.svelte:903`. `_rackline-tile.css` does **not** `@import` it
  (there is no `@import` in that file); `+layout.svelte` imports both separately (`:7`, `:11`).
  The docs catalog reusing `.mod-card` (`routes/docs/modules/+page.svelte:75`) is a **class
  reuse, not a card mount** — `e2e/tests/docs.spec.ts:25` is therefore *not* card-coupled.
- **Exit:** the rack renders identically with and without the (now-ignored) query param; the
  9 producers still produce with no card mounted anywhere.
- **Revert:** one PR, but large. Keep it separate from Phase 6.

### **Phase 6 — LEG-08 (#1519): delete the 196-card fleet (~66,682 LoC) and its import infrastructure.**
- **Precondition:** Phase 5 complete. Nothing resolves a card; nothing mounts one.
- **Do:** delete `lib/ui/modules/*Card.svelte` (**196**, *not* the 195 the ledger says, and
  **not** `DockStubCard.svelte` or `RearCard.svelte`), the glob in
  `modules-card-components.ts:35`, `buildNodeTypes`/`conventionalCardName` in
  `modules-card-map.ts`, and the card branch of `ssrDropBrowserOnlyGraph()`
  (`vite.config.ts:182`).
- **Also moves, by construction:** `modules-card-components.ssr-stub.test.ts`, the Worker-size
  ratchet (`scripts/measure-worker-bundle.mjs --check`), and `prove-ssr-identical.sh` /
  `PT_SSR_KEEP_CARDS=1`. ⚠ Re-prove the SSR guarantee **positively** (§1.6).
- **Exit:** build + typecheck + unit + e2e + vrt-strict green; Worker bundle ratchet re-pinned
  with the delta stated in the PR body.
- **Revert:** one enormous revert. **Do this as its own PR, touching nothing else.**

### **Phase 7 — LEG-09 (#1520): rewrite, move, or delete every legacy-coupled test.**
- **Precondition:** runs **per module, AHEAD of that module's card deletion** for anything
  behavioural; the source-lint family runs **after** Phase 6 because its subject is gone.
- **Do:** retire the ~60+ card-source-reading unit tests and their shared readers
  (`card-source.ts`, `card-def-agreement.ts`, `card-def-debt.ts`, `card-kit.ts`,
  `card-resize.ts`, `hidden-card.ts`, `video-card-visibility.ts`), plus `card-range-source.test.ts`
  (55 + **45** rows).
- ⚠ **Reconcile means fix or delete** — there is no permanent-exempt bucket. For each retired
  test, state where the invariant now lives, or state that it is genuinely gone.
- **Exit:** `scripts/test-ledger.mjs` bucket 2 shows **0** `legacy-card` entries and the
  `engine` count unchanged (273 at `2e2f0c185`).
- **Revert:** per family.

### **Phase 8 — LEG-10 (#1521): consolidation and the second harvest.**
- **Precondition:** Phases 5–7 complete.
- **Do:** delete `strict-faces.ts`'s now-universal `STRICT_FACES`/`migrated()` if every module
  is faced (or keep it as the registry-derived identity it becomes),
  `face-migration-inventory.ts` (1,663 LoC), the generated
  `docs/design/face-migration.generated.md` + its ratchet, the `_face-fixtures.ts` migration
  arms, and whatever of `_module-card.css` is genuinely unreferenced once `.rl-tile` moves to
  `_rackline-tile.css`.
- ⚠ **Never maintain a parallel population list.** Anything that survives must stay
  glob/registry-derived.
- **Exit:** `AGENTS.md`'s "never globally remove legacy cards until the inventory says every
  module has a disposition" clause is satisfied and can itself be rewritten in the same PR.

---

## 3. ⚠ THE WRONG-EXIT LIST — the single most schedule-sensitive item

These are the places that **THROW or go silently vacuous** when the last un-migrated module
disappears, instead of degrading cleanly. **They must be fixed BEFORE the population empties.**
Two of the four land on the same module (`moog956`), whose face spec is already authored — so
**one PR can fire two of these traps at once.**

### 3a. Hard failures

| # | site | exit shape | runway |
|---|---|---|---:|
| 1 | `e2e/tests/workflow-rear-card.spec.ts:~747` `pickLegacyDockType()` — **`throw new Error`** | THROW, **named** | **1** — `moog956` (moog960, cartesian already spent) |
| 2 | `e2e/tests/workflow-shell.spec.ts:~219` `placeholderSubjectType()` — **`throw new Error`** | THROW, **named** | **5** — chromaconsole, modtris, moog956, seqtris, trails (joystick excluded as hardware, clipplayer as NON_SHELL) |
| 3 | `e2e/tests/midi-binding-node-lifetime.spec.ts:141` — `type: 'moog956'` with a `beforeAll` asserting `PROMOTED.has('moog956') === false` | RED, **named** | **0 spare** — already re-pointed twice (#2068) |
| 4 | `e2e/tests/workflow-shell-video.spec.ts:817` — `for (const id of ['g1', RECORDERBOX])` asserting `module-shell-placeholder` `toHaveCount(1)` | RED — the message names the id (`"${id} renders a placeholder tile"`) but not the cause | **0 spare** on the `RECORDERBOX` leg |

⚠ **Site 4 is the worst of the four and it argues against itself.** Its own comment at
`:795-816` explains at length that `g1` is *derived* precisely so a promotion drops it from
the pool automatically "instead of reddening this line" — and then hard-codes `RECORDERBOX` as
the second element of the same loop. When recorderbox is promoted, the leg reds with
`"workflow-recorderbox renders a placeholder tile … Received: 0"`, which reads like a product
regression. **Derive the second element from the same predicate set, or drop it.**

Note line numbers already drifted between the two reads of this file (site 1 read as `:748`
then `:747`; site 2 as `:220` then `:219`). **Locate by symbol name, not by line.**

### 3b. Silently vacuous (worse than a throw)

5. **`e2e/tests/workflow-shell.spec.ts:776`** asserts `workflow-synesthesia` renders a
   **placeholder** — but `synesthesia` is in `STRICT_FACES`. **The subject is already expired.**
   It is not red only because the test is `test.fixme`-parked under FLAKE-PARK #1847 (`:769`),
   and the park note at `:757-764` already records the subject moved on 2026-08-24. This is
   the exact "TRUE when written, never re-checked" failure preserved in amber — **an unpark
   would red immediately.** Fix the subject in the same PR that unparks.
6. **The `deriveFixture` consumers** — `workflow-shell.spec.ts`, `workflow-dock-ux.spec.ts:117/:184`,
   `workflow-shell-video.spec.ts` — all `test.skip(F.kind === 'migration-complete', F.why)`.
   This is the **correct** degradation and should be the model for 3a. But ⚠ **skips are not
   passes**: when those four pools retire, four legs go quietly green-by-absence. The
   `no-candidate` instrument arm (checked *before* the migration arm, `:527` vs `:552`) is what
   keeps that honest — **preserve that ordering in any rewrite.**
7. **Any `all()`/`every()` over a shrinking roster** needs a **minimum-population guard**.
   Once the un-migrated population is 0, an `.every(...)` over it is vacuously true and a CI
   monitor built on it reports green forever. Audit before Phase 2 empties the pools.
8. **`e2e/vrt/workflow-shell-zoom.spec.ts:114`** pins a baseline on a **placeholder** render.
   Promoting recorderbox moves the image; the spec says so, but the baseline will look like an
   unexplained VRT diff to whoever runs it.
9. **`_face-fixtures.ts` `DENIED`** (`:67`) = `cameraInput`, `recorderbox`, `archivist`,
   `peertube`, `doom`. When these promote, the deny list becomes dead configuration that no
   test can distinguish from an active one.

### 3c. The Phase-0 exit criterion

For each of sites 1–4: run it with its candidate pool **artificially emptied** and confirm it
reports a *named* "migration complete" verdict. ⚠ Per repo standard, prefer a **positive
control** — empty the pool for real in a scratch branch and watch the new path fire — over
merely observing that the current pool is non-empty.

---

## 4. Coverage that genuinely dies, and what must replace it FIRST

### 4.1 ⚠ Correct the premise before planning against it

Two corrections to the framing:

1. **It is 306 of 562, not 377 of 431.**
2. **⚠ `?shell=legacy` is NOT a complete legacy switch.** `Canvas.svelte:9723` passes
   `migrated={migrated(fv.node.type)}` to the dock full view — **not**
   `shellFaces && migrated(...)`, unlike `dockRailRendersFace`, which does. So **a promoted
   module's card is never mounted in the dock full view on any URL.** A spec that boots
   `?shell=legacy` and then expands a promoted module is exercising the **face**.
   **Therefore 306 is an upper bound on legacy-card coverage, not a measure of it.** This is
   consistent with the standing note that the shell flag is not a complete gate.

Do not budget Phase 4 against 306 real card-coverage transfers. **Measure first** (§4.4).

### 4.2 What actually dies

| Coverage | Dies with | Replacement that must land FIRST |
|---|---|---|
| 128 per-module lane renders (`vrt.spec.ts`) | Phase 5/6 | Phase 3 face-tier baselines, one-for-one |
| 246 legacy-booted VRT baselines across 32 specs | Phase 5/6 | Phase 3, delete-on-migrate |
| ~60+ card-source lint invariants (naming, ranges, mapping, vocabulary debt, hidden-card, video visibility) | Phase 6/7 | For each: the same invariant asserted against the **face/def**, or an explicit statement that it is gone. ⚠ "Reconcile means fix or delete." |
| `RANGE_BOUND_CARDS` 55 + `MAPPING_BOUND_CARDS` 45 | Phase 7 | `paramSpec(def, id)` binding is the sanctioned successor — bind with `paramSpec`, **not** a `*_RANGE` export |
| Legacy dock full-view controls (`DockFullView.svelte:365-381`) | Phase 5 | The bespoke surface / `fullViewBody` contract for each of the 19 |
| The 9 headless producers' engine-visible state | Phase 5 | Node-owned registries (LEG-02); ⚠ node-keyed, never card-keyed |
| Placeholder-tile behaviour (thumbnails, wave glyph, zoom) | Phase 5 | Nothing — the concept ceases to exist. Delete the assertions, do not re-point them. |

### 4.3 What must NOT be treated as replaceable

- **Functional parity is a hard requirement.** If a legacy card can do something the face
  cannot, that is a blocker for Phase 2 on that module — not a coverage note.
- **A face PR must re-pin BOTH cost artifacts** (`e2e-timings.generated.json` and
  `vrt-strict-timings.generated.json`), and only once no shard is pending.
- **CV-port changes → run the FULL web unit suite** (`cv-scale-registry` only fails in `unit`).
  **Poly/chord width changes → run the FULL `task art`** (ART pins exact voicing).
- **New modules use `PatchPanel`**, never raw `Handle` jacks; module labels stay lowercase
  (a guard test enforces it); every module needs `DESCRIPTIONS` or the unit gate fails.

### 4.4 The measurement to take before Phase 4

Nobody has measured how many of the 306 specs would behave **differently** on the default
shell. The honest instrument is a **positive control**: pick a batch, flip it, and confirm
that a deliberately reintroduced product defect still reds the flipped spec. Flipping a spec
that then passes for a *different reason* is exactly how coverage gets gutted silently.
⚠ This is a measurement, not a new gate. Anything permanent is an **owner decision**.

---

## 5. Risks, and what this plan cannot see

### 5.1 Risks

1. **Wrong-exit traps fire before Phase 0** (§3). Two pools are 1–2 promotions from empty and
   two traps share `moog956`. **Highest probability, and it lands as a mystery red on someone
   else's PR.**
2. **Blank-rack failure mode** in Phase 5/6 if the `hasCard` gate outlives the fleet by even
   one commit. It fails *silently* at the app level.
3. **Baseline double-tiering** in Phase 3 if the tier choice is not made once, up front.
4. **Silent coverage loss** in Phase 4 (§4.1, §4.4).
5. **The sync layer reverts edits** and makes `* 2.ts` junk — commit aggressively during long
   deletion passes.
6. **Worktree hazards:** cap is 10; the guard auto-removes DEAD-LOCK + clean + PUSHED trees, so
   "push to be safe" is *harmful* — UNPUSHED work protects a tree. `git stash` is **one
   repo-wide stack** shared by every worktree; use WIP commits. Run `task worktree:guard`
   before creating one, and `task pr:conflict-sweep` after a merge to `main`.
7. **Face-registry merges:** "keep both sides" is UNSAFE — re-run the accept task after any
   merge that touches a generated list.
8. **Never `gh pr update-branch`** on PRs touching shared list/generated files (all of these
   do); merge `origin/main` locally and verify both sides survived.
9. **Scratch filenames can collide with tracked files** — write to the scratchpad, `git ls-files`
   first, never `git add -A`.
10. **DOOM is in Phase 2** and carries a separate approval, a separate plan, and a game clock
    that IS the frame clock. Exclude it by name from any broad sweep and say why.

### 5.2 What this plan cannot see

1. **No suite was executed.** Every count is a static derivation from committed source (the
   196↔196 bijection was recomputed from the *generated* registry manifest, which is the
   strongest of them; the four fixture pools replicate `deriveFixture` logic and are the
   likeliest place for a small error).
2. **VRT baseline disk footprint is unknown** — `git archive` yields LFS pointer files, so 594
   is a file count, not bytes.
3. **`uniformDomainClass` determinacy for `modtris` was not independently recomputed** — only
   that it is the sole un-promoted audio card with a `<NeonFader>`.
4. **How many of the 490 `e2e/tests` specs boot the DEFAULT shell was not enumerated** — many
   never navigate to `/rack` at all, so `562 − 306` is *not* that number.
5. **`e2e/audio-drift/_collab.ts`** matched a `/rack` grep and was not traced; whether the
   ART/audio-drift lane couples to cards is unknown.
6. **The `?shell=legacy` incompleteness (§4.1) was found late** and its full blast radius —
   which of the 306 specs actually exercise a card versus a face — has not been measured.
7. **Whether the tree's remaining `legacy` prose is accurate anywhere else.** Three separate
   false claims were found during this measurement alone (`ssrDropCardComponents`, the CSS
   `@import`, the 195-card count). Assume prose is wrong until re-read.

---

## 6. Owner decisions surfaced by this plan (nothing taken)

1. **Sequencing:** is the phase order above accepted, and specifically is **Phase 0 (§3)
   authorised to go first**, before any further promotions?
2. **VRT tier choice (Phase 3):** one face tier or two? Made once, up front — it is the
   difference between a ~128-baseline replacement and a much larger one.
3. **Phase 4 batching:** how large a batch of the 306 specs per PR, and is a positive-control
   flip acceptable as the acceptance evidence?
4. **Ratchets that move by construction** (Worker bundle size, both timing artifacts, the
   test-ledger bucket counts): re-pin inside each phase's PR, or a separate accept pass?
5. **`AGENTS.md` itself** says never globally remove legacy cards until the inventory says
   every module has a disposition. Phase 8 would rewrite that clause. Confirm before the sweep
   reaches it.
