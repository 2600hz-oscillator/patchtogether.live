# Build brief — legacy-card removal, branch `feat/legacy-removal`

**Audience:** the builder crew. Self-contained; the companion `plan.md` (same
directory) is the measurement record — read it once, then work from this brief.
**Basis:** `origin/main` @ `fad354576` (post-#2331; toybox faced and merged).
Inventory: 197 registered / 194 done / 0 remaining; `MIGRATION_BLOCKERS` empty.
**Shape:** ONE branch, dependency-ordered slices, every commit green. PR at the end.
**NO auto-merge. The owner reviews the finished PR.**

## Ground rules (non-negotiable)

- Every command through Flox: `flox activate -- <cmd>`. Never git outside Flox.
- cwd resets between tool calls — `cd` in the same command; absolute paths.
- Agent cap: lead + 2. ≤3 open PRs. `task worktree:guard` before any worktree; WIP
  commits, never stash (stash is shared across worktrees). Fresh worktree: npm install
  + svelte-kit sync.
- Never `gh pr update-branch`. Resync = merge `origin/main` locally, re-run accept
  tasks after any merge touching generated lists, verify both sides survived.
- No new gates or kinds of tests. No fundamental CI changes. No GitHub issues. Fix
  discovered defects in this branch if coherent, else report to the owner.
- Linux CI authors ALL VRT baselines (scoped `task vrt:commit`; review the bot's diff).
- New/changed tests: run focused locally, then `REPEAT=3`. Root-cause every failure;
  never re-run a red as "flake". Post-re-bin e2e failures are the fixture/contention
  class — fix the fixture, never the timeout.
- Spec renames keep webgl-heavy filename prefixes (wrong name = runs in NO lane).
- Commit aggressively (sync-layer reverts mint `* 2.ts` junk).
- No profanity in anything that reaches GitHub.

## Preconditions — do NOT start S1 without ALL of these

1. **DOOM approval in hand** for exactly: re-point **15** doom specs (every doom spec
   except `face-doom.spec.ts` boots `?shell=legacy`, INCLUDING `doom-wasm.spec.ts`;
   the only default-shell one is `doom-session-survives-card-collapse.spec.ts`, which
   needs nothing) to the default shell (boot URL + knob locator only); delete
   `DoomCard.svelte` (label becomes `Gain`); bot-recapture the 4
   `composite-doom-evt-*` baselines. Any refusal = carve-out, doom blocked at S2(d)/S4.
2. **Owner answer on vrt-strict** (plan Q9): what replaces the 45 `STRICT_VRT_MODULES`
   card scenes in the required vrt-strict lane. Blocks S3's sweep deletion.
3. Owner answers on prep-split (Q10) and deploy window (Q11) — Q10 may move S1 +
   VirtualModule + fixture flip onto main as ordinary PRs first (preferred; shrinks
   this branch to deletions).
4. Re-measures at branch point (record in `.myrobots/`):
   - Fleet: expect 196 files / 58,875 LoC; deletable 194 / 58,144.
   - Derive the full **fixture-implicit spec list** (~110 files): `_fixtures.ts`
     `rack`-fixture importers that carry ZERO `shell=legacy` text. This joins the S2
     denominator (~412 total).
   - Toybox card-only-testid diff vs the merged 126-LoC thin adopter
     (`toybox-video-relink`, `toybox-preset-error` were card-only — verify face homes;
     if absent they join S1(d)).
   - Attest pin vs branch head + current main (standing grant covers the check).
   - Boot-serialization ceiling for re-binned specs (dock mount no longer overlaps
     page load — derive, don't guess).
5. `flox activate -- task worktree:guard`; branch `feat/legacy-removal` from green main.

## DO-NOT-TOUCH

- **DOOM beyond the approved scope**: game clock, waits, budgets, ledger entries,
  sweep behavior, mp specs, the two skip-budget DOOM-observer entries,
  `doom-session-survives-card-collapse.spec.ts`. Name the exclusion in every sweep
  commit message.
- **KEEP — live default-shell mechanisms wrongly marked delete in v2:**
  `lib/ui/modules/card-kit.ts` (ModuleShell + 7 surviving bodies),
  `lib/ui/modules/card-resize.ts` (`startCornerResize` — DetachedDisplay,
  VideoboxScreenBody), `lib/graph/hidden-card.ts` (hiddenCard flag; saved patches
  depend on the reader), `lib/ui/video-card-visibility.ts` (viewport culling for ALL
  video nodes). Rename off "card" in S5 at most.
- `clip-media-recovery.ts` — becomes the face recovery seam; never delete.
- `DockStubCard.svelte`, `RearCard.svelte` — not legacy.
- `GroupCard.svelte`, `StickyCard.svelte` — move + re-register, never delete.
- `_module-card.css` `.rl-tile` rules — live rear-flip; prune-only.
- `CubeVizSurface.svelte`, `WavesculptVizSurface.svelte` — attest basis; paths stable.
- `STRICT_DOCS` (187), behavioral/output-emit `engine` rosters,
  `module-face-lint.test.ts` rules 1–3.
- `e2e/audio-drift`, `e2e/chaos`, `packages/relay`, `.github` — out of scope.
- `.myrobots/` spec/mock packages stay until explicitly consumed.

## Deletion manifest (required review artifact)

Maintain a **script-generated** manifest on the branch (never hand-typed): one row per
deleted file/test — `path → LoC → disposition → successor gate/spec or stated coverage
loss → commit SHA`. Row count must equal deleted-file count at PR time. The PR body
links it, carries the CI-run plan, worker-bundle delta, wall-time estimate, and the
merge-day protocol. This is the review surface (a ~700-file diff truncates in the
GitHub UI and `--json files` caps at 100).

---

## S1 — Build work (additive product; no deletions)

| task | detail |
|---|---|
| Extract 7 producers | archivist, cameraInput, loopback, scope, synesthesia, timelorde, wavesculpt (~5,521 card LoC). Non-card headless components / NODE-keyed runtime seams (#1531/#1574/#1583 — card unmount kills node resources). `HeadlessSourceHost` mounts the extracted producer; card becomes thin adopter. One commit per module. |
| GroupCard scope host | Re-point `GroupCard.svelte`'s hidden `ScopeCard` mount (`HOST_CARDS`) to the extracted scope producer in the SAME commit as the scope extraction; update `group-viz-hosts.test.ts` and the `dom-source-modules.test.ts` HIDDEN_MOUNT exemption; verify group viz-passthrough e2e. |
| Face-based VirtualModule | Rebuild `lib/docs/interactive/VirtualModule.svelte` to mount ModuleShell/face instead of the glob card-map. Sandbox isolation constraint: it swaps the GLOBAL `patch`/`ydoc` — keep that contract. Gate: `docs-virtual-module.spec.ts` + spot-check STRICT_DOCS pages. |
| Clipplayer recovery face home | `clipplayer-recover`/`-save`/`-discard` exist only in the card; `clip-media-recovery.ts` has no other importer and clipplayer is NOT headless-mounted. Build the interrupted-take prompt into face/shell. Functional parity is a hard requirement. |
| Samsloop REC refusal surface | Face reports `delivered:false` with nowhere to paint refusals (engine-not-ready / rack-full / could-not-start). Give the face a `samsloop-rec-error` equivalent. |
| Vocabulary | Rename `dom-source-modules.ts` vocabulary off "card" (no behavior change). |

**Per-module gate:**
```sh
flox activate -- task typecheck
flox activate -- task test:one -- card-media-lifetime   # scan widened in the SAME commit
flox activate -- task e2e:one -- tests/card-producer-lifetime.spec.ts
flox activate -- task e2e:one -- tests/extras-producer-lifetime.spec.ts
flox activate -- task e2e:one -- tests/<module output sweep>.spec.ts
REPEAT=3 flox activate -- task e2e:one -- <changed specs>
```
Extras: CV-port change → FULL `task test`; poly width → FULL `task art`.
Mixed-version check per extracted producer: two clients, old-bundle card producer vs
new-bundle extracted producer on one shared node — verify extras-channel ownership does
not collide (or document why benign). Keep `wavesculpt`/`cube` surface paths stable.

## S2 — e2e inversion (~412 specs)

Flip `_fixtures.ts` `rack` → default shell; flip `rack-session.ts` default; `rackLegacy`
opt-in alias lives only until S4.

**Decision table — every spec family:**

| family | members | action |
|---|---|---|
| (a) URL-only | engine/graph hooks, PatchPanel jacks, topbar — the majority by count | Re-point boot, run, done. |
| (b) card-DOM, faced module | explicit-string card-DOM specs + the ~110 fixture-implicit files (known members: `bluebox`, `fader`, `painter`, `shapegen`, `shapegen-clock`, `cable-z-order`, `toybox-control-surface`, `vfpga-floorplan`, `vfpga-p4-early-hd`, `vfpga-patchpanel-presets`) | Rewrite selectors against face/surface (aria/config selectors; ModuleShell emits `module-shell`/`face-*`, never `<type>-card`), or fold into the module's face spec per owner Q8. **Positive-control each family**: reintroduce one defect, watch the flipped spec red. |
| (c) parity/transition machinery | `faces-parity-suite.ts` legacy arms, `face-screen-render-suite.ts`, placeholder fixture legs, forced-placeholder consumers (`midi-binding-node-lifetime`, `dock-tray-shrink-to-content`, `workflow-dock` clipplayer leg, `workflow-dock-composite` vrt), `in-card-title`, `card-drop-patch`, rear-card legacy-dock leg | DELETE, with matching skip-budget entries in the same commit (budget test reds on stale entries). |
| (d) DOOM | the 15 approved specs | Exactly the approved scope: boot URL + knob locator. Nothing else. |
| (e) #1847 parks | 28 files (list in plan §4) | Unpark + re-point + `REPEAT=3` if subject survives on the face path; delete test + park note + skip-budget entry together if subject IS the machinery. No re-park. Unresolvable → owner as named coverage loss. |
| (f) audio-drift / chaos | 2 files | Untouched. |

**Timings hygiene:** every commit that deletes a spec prunes its
`e2e/e2e-timings.generated.json` rows in the SAME commit (`e2e-shard-plan.test.ts`
reds on rows naming missing specs; surviving-spec rows may stay stale until S5).

**Gate:**
```sh
flox activate -- task e2e:serve
flox activate -- task e2e:one -- tests/<family>.spec.ts     # per family
REPEAT=3 flox activate -- task e2e:one -- <changed specs>
flox activate -- task test:one -- e2e-shard-plan            # after each deleting commit
flox activate -- task e2e:stop
```
READ skip counts (line-reporter skips are not passes). Expect flipped specs to run
SLOWER (serialized cold boots) — use the S0 ceiling; failures after re-bin are
fixture/contention, never re-run.

## S3 — VRT inversion/deletion (requires owner Q9 answer + owner preview)

| scene family | action |
|---|---|
| renderer-content (`cube-adsr-composite`, `vrt-synesthesia-*`, `vrt-wavesculpt-*`, `vrt-colourofmagic`, `vrt-toybox` 27, `vrt-composite*`, `cellshade/mirrorpool/pentemelodica-composite`, `vrt-karplus-tomtom-states`, probes) | Re-point boot + selectors; keep scene; **Linux CI recaptures** via scoped `task vrt:commit`; count committed files against the manifest prediction. |
| sweep/chrome (`vrt.spec.ts` per-card sweep, `vrt-legacy-mask-audit`, `interactions`, `topbar`, `dashboard`, `groups`, …) | Delete per the owner's Q9 resolution of the 45 required `STRICT_VRT_MODULES` card scenes. **Rewrite `scripts/vrt-shard-plan.test.ts` (literal `vrt.spec.ts :: adsr card matches baseline` anchor) in the SAME commit**; prune vrt-strict-timings rows for deleted scenes same-commit. |
| `vrt-annotated.spec.ts` (docs-faces pipeline) | Re-point to default shell → regenerate `__annotated__` PNGs + `{type}.legend.json` → `scripts/copy-doc-faces.sh` → audit `module-docs-lint.test.ts` legend keys + `docs/control-doc-resolver.ts` (legend testids change with the shell). |
| `EXEMPT_FROM_VRT` (66, subject `legacy-card`) | Delete with the sweep. Audit `VRT_MODULE_MASKS` (31) per surviving scene. |
| `vrt-cable-stripe.test.ts` + `vrt-cable-stripe.ts` (UNIT lane, reads `__screenshots__`) | **Dies HERE, same commit as the baselines it reads** — not in S4. |
| DOOM `composite-doom-evt-*` (4) | Bot recapture on face boot — approved scope only. |

**Gate:** `GREP=<module>` on every focused `task vrt:one`; vrt lane green with zero
re-pins the bot did not author; every deleted baseline has a manifest row naming its
successor face scene or reason. **Owner previews every re-pointed visual scene before
this slice is accepted** (look-changes ruling — precondition, not courtesy).

## S4 — The atomic removal run (switch + fleet + harvest, fused)

Deletions ride the same commits as their readers; every commit green.

**Pre-stage commits (each green):**
1. Rework the ~19 surviving face-model tests that `readFileSync` their card
   (`blood-`, `clipplayer-`, `colourofmagic-`, `frogger-`, `gatemaiden-`, `gibribbon-`,
   `milkdrop-`, `modtris-`, `monoglitch-`, `moog-tail-faces-`, `nibbles-`,
   `picturebox-`, `reshaper-`, `ruttetra-`, `scoreboard-`, `seqtris-`, `skifree-`,
   `wavesculpt-face-model.test.ts`) to stop reading card files.
2. Re-point `webgl-attest-coverage.test.ts` clause (6) + reverse card-dir sweep to
   face/surface trees.
3. Re-point `card-flow-store-guard.test.ts` glob (min-population guard) to the
   face/bespoke surfaces `DockCardHost` mounts.
4. Per-family `module-docs-lint` testidPrefix audit: every `controlFamily.testidPrefix`
   must exist in a SURVIVING surface (e.g. `bluebox-key-*` lives only in the card
   today) — rework family or docs entry.
5. Fix `foxy-face-model.test.ts` `OPERATIONAL_DEBT` import.
6. Verify `card-media-lifetime` + `card-preview-gate` scans already cover every
   surviving surface (min-population guards must never empty).

**The removal commit(s) — one green unit:**
- Switch: `Canvas.svelte` `shellFaces` reader; `laneMigrated` + forced-placeholder
  seam; `laneRenderKind` collapse to `'shell'|'stub'|'native'` **+ rewrite its SIX
  dependent unit files** (`legacy-fallback.test.ts`, `node-hls-source-registry.test.ts`,
  `clipplayer-face-model.test.ts`, `controlsurface-face-model.test.ts`,
  `electracontrol-face-model.test.ts`, `dom-source-modules.test.ts` kind matrices,
  `module-shell-drawer-view.test.ts`); `ModuleShellPlaceholder.svelte`;
  `DockFullView` false arm; `DockCardHost` face prop; `rackLegacy` alias; the 12
  helper strings.
- Fleet: move `GroupCard`/`StickyCard` out of `lib/ui/modules/` first (owner Q4 names
  the home); delete the 194 cards.
- Same commit(s): `modules-card-components.ts` + `modules-card-map.ts` + bijection +
  ssr-stub tests; `card-range-source.test.ts`; `card-def-debt.ts` (incl. DoomCard
  entry, per approval); `card-def-agreement.ts`; `card-source.ts`;
  `card-primitive-parity.test.ts` per owner Q12's disposition; **harvest all 18
  card-keyed rows from `lib/graph/raw-write-ledger.ts`** (`mutate.guard.test.ts` reds
  on stale exemptions); rewrite `dom-source-modules.test.ts` card-map/glob reads;
  retire `face-migration-inventory.ts`/report/test/generated doc/Taskfile targets (its
  test imports `modules-card-map` AND `card-source` — it CANNOT outlive them); delete
  the vite `ssrDropBrowserOnlyGraph()` card branch.
- Blank-rack hazard (`hasCard:false → 'legacy' → SvelteFlow default renderer`) is
  impossible by construction: switch and fleet go together.

**Post commits:** re-pin worker ratchet (`measure-worker-bundle.mjs --check`, delta
recorded for PR body); re-prove SSR POSITIVELY (scratch commit reintroducing a
server-reachable card import must go red); `test-ledger` `legacy-card` bucket = 0;
`SUBJECT_ANCHORS` prose fixed.

**Gate:**
```sh
flox activate -- task build
flox activate -- task typecheck
flox activate -- task test          # FULL unit — cv-scale-registry class only shows here
```
Manual: rack renders identically with and without `?shell=legacy`; all 9 producers
produce with zero cards mounted; a saved patch with headless camera instances loads
with them hidden (hidden-card.ts kept).

## S5 — Consolidation + artifacts

- Rework `scripts/new-module.ts` (+ `new-module.test.ts` — it scaffolds and expects
  `<Type>Card.svelte` today) and `scripts/propose-face.ts` (parses card render-order)
  off cards. Otherwise the first post-removal module re-creates one.
- Prune `_module-card.css` to `.rl-tile` survivors; merge into `_rackline-tile.css`.
  Optional renames of the four KEEP files off "card" vocabulary.
- Rewrite AGENTS.md product-state block ("both must work" / "never globally remove"
  clauses are now satisfied) + `module-surfaces` skill legacy passages. Final commit.
- Finish the deletion manifest; reconcile row count vs deleted files.

**Cost artifacts — the CI loop (cannot be avoided):**
1. Push the branch; let full CI run (measurement run). Expect re-binned shards to be
   slow; watch the 900s global timeout; failures = fixture class.
2. `e2e-timings-accept` + `vrt-strict-timings-accept` from THAT run's id — **only when
   zero shards are pending** (accepting mid-run truncates). Both artifacts, always
   (face PR rule: e2e-timings + vrt-strict-timings together).
3. Push the re-pin; the final CI run must be green on the branch's EXACT final commit.
Minimum spend: N `vrt-update` dispatches (S3) + ≥2 full ci.yml runs. State the plan and
actuals in the PR body.

## Definition of done

1. Full local pass at the final commit:
   `flox activate -- task build && flox activate -- task typecheck && flox activate -- task test && flox activate -- task e2e && flox activate -- task vrt`
   (+ `flox activate -- task art` if S1 touched any audio path).
2. CI fully green on the branch's EXACT final commit (post-re-pin). No failing check
   is "flake" — root-cause or the branch is not done.
3. Deletion manifest complete and reconciled; PR body carries plan §1 tables as
   checklist, CI-run plan + actuals, worker-bundle delta, wall-time estimate,
   merge-day protocol (early-day merge; dev verification per deploy runbook; nightly
   handling per owner Q11).
4. Every deleted test's coverage disposition stated (manifest row / commit message).
   Named coverage losses (card-primitive-parity per Q12, any unresolvable park)
   surfaced to the owner explicitly.
5. **PR open on `feat/legacy-removal` → `main`. NO auto-merge, no self-merge — the
   owner reviews and merges.** After the owner merges: verify dev deploy, run
   `flox activate -- task pr:conflict-sweep`. A red main is P0.

## OWNER RULINGS 2026-09-03 (supersede earlier defaults — binding)
1. **Group and Sticky are DELETED ENTIRELY** — not moved. Defs, cards, registries,
   docs, specs, testids, everything. "We may rebuild these later in a new form but
   for now we burn it down." (cadillac was not named; it stays organizational-native.)
   HARD SAFETY ITEM this creates: saved patches / performance zips containing
   group/sticky nodes must LOAD GRACEFULLY after the types are unregistered —
   determine and pin the unknown-type behavior (reconciler + renderer + persistence)
   before deleting; a crash on legacy patch load is a release blocker.
2. **?shell=legacy: remove ALL references to the idea legacy ever existed** —
   stronger than ignored-param. The param handling dies; comments, prose, doc
   references, spec headers, memory-of-legacy naming (laneRenderKind etc.) get a
   dedicated S5 archaeology sweep (grep shell=legacy, "legacy card", NON_SHELL,
   dockRailRendersFace...) — rewrite or delete every hit.
3. **strict-faces.ts prose slimming happens NOW, on this branch** (was deferred).
4. **Review shape: everything reaches the owner as ONE PR.** Side branches are
   permitted for build efficiency, but the review artifact is a single PR the
   owner merges MANUALLY. Deploy window irrelevant.
5. Volume→Gain label change ACCEPTED. Inventory invariant FOLDS into
   module-face-lint. vrt-strict card half DELETED. Card-DOM specs covered by
   face specs: fold-and-delete with named-coverage manifest.

## OWNER RULING 2026-09-03 (DOOM sub-slice)
DOOM gets IDENTICAL coverage on the new UI, INCLUDING COLLAB: every one of the
14 legacy-navigating DOOM specs is RE-POINTED (never folded/deleted), the collab
multiplayer legs keep their full assertion set on the face surface, and the
sub-slice's definition of done is a coverage diff showing zero lost assertions.
