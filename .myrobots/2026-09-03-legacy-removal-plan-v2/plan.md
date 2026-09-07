# Legacy-card removal plan v2.1 — one branch, measured from the tree

**Date:** 2026-09-03 (v2.1 — three adversarial reviews folded in; see Appendix A for
discarded review items)
**Status:** ⚠ EVIDENCE, NOT INSTRUCTION (`.myrobots/` per AGENTS.md). Every owner-decision
item is flagged; nothing here authorizes itself.
**Basis:** v2 measured at `origin/main` @ `20e2a596b`; v2.1 re-based to
`origin/main` @ `fad354576` — **#2331 (toybox face, the last module) is MERGED**.
Inventory reads **197 registered / 194 done / 0 remaining**, `MIGRATION_BLOCKERS` empty.
Post-toybox fleet re-measured: **196 card files / 58,875 LoC** (ToyboxCard is now a
126-LoC thin adopter).
**Supersedes:** `.myrobots/2026-09-01-legacy-removal-endgame.md`. The owner has asked for
the removal as **one PR branch, green, reviewed whole** (see owner Q10 for the
prep-split option that keeps that shape).

⚠ Line numbers were true at the stated basis. Locate by symbol, not line. Verify, don't
trust: v2 itself carried five measured-fact errors that only adversarial re-measurement
caught (§1.4 DOOM row, §1.6 four keep/delete misclassifications, §1.5 baseline count,
the e2e denominator, and the "only build work" claim). Everything below was re-verified
in-tree.

---

## 1. What the removal covers TODAY (measured)

### 1.1 The card fleet

| | count | LoC |
|---|---:|---:|
| `packages/web/src/lib/ui/modules/*Card.svelte` (post-#2331) | 196 | 58,875 |
| — survivors that MOVE, not delete: `GroupCard.svelte` (569) + `StickyCard.svelte` (162) | 2 | 731 |
| — **the deletable fleet** | **194** | **58,144** |
| NOT legacy, NOT in scope: `lib/ui/dock/DockStubCard.svelte`, `lib/ui/workflow/RearCard.svelte` | 2 | — |

Registry: 197 types = 194 migratable (all faced) + 3 `organizational-native`
(`group`, `sticky`, `cadillac`; cadillac is `NO_CARD_BY_DESIGN`).
Of the 58,144 deletable LoC, **~5,521 LoC of producer logic RELOCATES** (§1.3) rather
than deletes; the rest is net removal.

### 1.2 The `?shell=legacy` machinery

| piece | where | LoC | disposition |
|---|---|---:|---|
| the ONE flag reader | `Canvas.svelte` (`shellFaces`) | — | delete |
| `laneRenderKind` / `emittedTypeFor` / `isShellSwappable` / `dockRailRendersFace` | `lib/ui/workflow/legacy-fallback.ts` | 370 | collapse: kinds become `'shell'|'stub'|'native'`. ⚠ the collapse breaks SIX unit files, not one: `legacy-fallback.test.ts`, `node-hls-source-registry.test.ts` (:437/:470/:477), `clipplayer-face-model.test.ts` (:86-108), `controlsurface-face-model.test.ts` (:54-105), `electracontrol-face-model.test.ts` (:57-87) (all assert `.toBe('legacy')`), `dom-source-modules.test.ts` (:1065-1407 kind matrices), `module-shell-drawer-view.test.ts` — all rewritten in the same commit |
| `NON_SHELL_LANE_TYPES` | same file | — | `{group, sticky, cadillac}` — survives, renamed off "legacy" vocabulary |
| `ModuleShellPlaceholder.svelte` | `lib/ui/modules/` | 164 | delete (concept ceases to exist) |
| forced-placeholder seam (#2068/#2299) | `$lib/dev/forced-placeholder.svelte.ts` + `Canvas.svelte laneMigrated()` | 97 | delete with its 4 consumers (§1.4) |
| dock legacy branch | `DockFullView.svelte` `migrated` prop + verbatim-card `{:else}` | 510-file | delete the false arm |
| `DockCardHost` `face` prop | `lib/ui/dock/DockCardHost.svelte` | 304 | prop becomes constant-true; simplify |
| `HeadlessSourceHost.svelte` + rosters | `lib/ui/workflow/dom-source-modules.ts` | 106 + 405 | **REWORK, not delete** — §1.3 |
| `strict-faces.ts` (`STRICT_FACES` = 194) | `lib/ui/workflow/` | 6,751 | survives as the derived identity; prose slimming optional, owner Q7 |
| `face-migration-inventory.ts` + `face-migration-report.ts` + test + `docs/design/face-migration.generated.md` + Taskfile `face:inventory`/`face:inventory:accept` | | 2,229 + report | retire — ⚠ `face-migration-inventory.test.ts` imports `modules-card-map` AND `card-source`, so retirement rides the SAME atomic run as the fleet deletion (S4), not a later slice; successor invariant is owner Q3 |
| card glob + resolver | `modules-card-components.ts` (45) + `modules-card-map.ts` (63) + `modules-card-map.test.ts` + `modules-card-components.ssr-stub.test.ts` (78) | ~200 | delete in the S4 atomic run (importers listed in §1.6 die/retarget same-commit) |
| SSR card stub | `vite.config.ts` `ssrDropBrowserOnlyGraph()` card branch | — | delete branch; `Canvas`/dev-route stubbing stays |
| Worker-size ratchet + SSR proof | `measure-worker-bundle.mjs --check`, `prove-ssr-identical.sh` / `PT_SSR_KEEP_CARDS=1` | — | re-pin ratchet with stated delta; re-prove SSR **positively** |
| `_module-card.css` | 24 importers incl. `ModuleShell`, `PatchPanel`, `+layout.svelte` | 562 | **keep** — live `.rl-tile` rear-flip rules; prune dead card rules only, merge into `_rackline-tile.css` last |
| card-scaffolding tooling | `scripts/new-module.ts` (:117 scaffolds `<Type>Card.svelte`; test :506 expects it), `scripts/propose-face.ts` (:139-171 parses card render-order; `task face:propose`) | — | **rework in S5** — otherwise the first post-removal module re-creates a card |

Forced-placeholder seam consumers (all die or re-point with it):
`midi-binding-node-lifetime.spec.ts`, `dock-tray-shrink-to-content.spec.ts`,
`workflow-dock.spec.ts` (clipplayer leg), `e2e/vrt/workflow-dock-composite.spec.ts`.

### 1.3 The build work (v2 said "7 extractions, the only build work" — REFUTED; this is the real list)

**(a) The 7 producer cards.** `HEADLESS_MOUNT_LANE_TYPES` = 9; `FACE_MOUNTS_PRODUCER` =
`{cube, rasterize}`. For the other 7, engine-visible state exists only because
`HeadlessSourceHost` mounts the REAL card off-screen, even on the default shell:

| type | roster half | card LoC |
|---|---|---:|
| archivist | DOM-source | 859 |
| cameraInput | DOM-source | 1,020 |
| loopback | DOM-source | 500 |
| scope | card-producer | 486 |
| synesthesia | card-producer | 456 |
| timelorde | card-producer | 889 |
| wavesculpt | card-producer | 1,311 |

5,521 LoC extracted into non-card headless components / node-keyed runtime seams
(livecode action-seam shape; node-keyed registries per #1531/#1574/#1583).
`cube`/`rasterize` faces already mount their producers, those two cards delete normally.

**(b) GroupCard's viz-host mount.** `GroupCard.svelte:37` imports `ScopeCard.svelte`
directly (`HOST_CARDS = { scope: ScopeCard }`, hidden mount per viz-passthrough child),
and `group-viz-hosts.test.ts` enforces the direct `.svelte` import from both sides. The
scope extraction MUST re-point GroupCard's hidden mount to the extracted producer in the
same commit, update the `dom-source-modules.test.ts` `GroupCard → ScopeCard.svelte`
HIDDEN_MOUNT exemption, and verify group viz-passthrough e2e.

**(c) The docs interactive sandbox.** `routes/docs/modules/[id]/+page.svelte`
dynamically imports `lib/docs/interactive/VirtualModule.svelte`, which mounts the
ACTUAL card via the glob card-map (gated by `docs-virtual-module.spec.ts`). Deleting the
fleet breaks all 187 STRICT_DOCS interactive pages. A face/ModuleShell-based
VirtualModule must be BUILT (the sandbox swaps the global `patch`/`ydoc` — nontrivial)
before the fleet can go.

**(d) Card-only user affordances with no face home** (functional parity is a HARD
requirement — these are build items, not questions):
- **Clipplayer interrupted-take recovery**: `clipplayer-recover`/`-save`/`-discard`
  render only in `ClipplayerCard.svelte`; `clip-media-recovery.ts` is imported by the
  card and nothing else; clipplayer is NOT headless-mounted, so on the default shell the
  scan runs nowhere. Without a face home, an interrupted Arm-Endless take becomes
  permanently unrecoverable while its OPFS bytes stay GC-spared forever. Build the
  recovery prompt into the face/shell.
- **Samsloop REC refusal feedback**: `samsloop-face-actions.ts:69-72` — the refusal
  text renders only in the card's `samsloop-rec-error`; the face reports
  `delivered:false` and paints nothing. Three refusal paths (engine-not-ready,
  rack-full, could-not-start) become silent no-ops. Give the face a refusal surface.

### 1.4 e2e coupling

| | count |
|---|---:|
| spec files total (`e2e/tests` 509 · `e2e/vrt` 40 · audio-drift 1 · chaos 1) | 551 |
| specs with non-comment `shell=legacy` lines | 311 (279 tests · 32 vrt) |
| — of those, actually NAVIGATING to it | 302 |
| ⚠ **specs booting legacy via the `rack` fixture with ZERO `shell=legacy` text** (fixture destructure only; the string lives in `_fixtures.ts:93`) | **~110** |
| — **the real inversion denominator** | **~412 spec files** |
| non-spec helpers carrying the string | 12 (`_fixtures.ts`, `_helpers.ts`, `_module-coverage-helpers.ts`, `_per-module-per-port-shared.ts`, `_per-port-drivers.ts`, `_toybox-fixture-helpers.ts`, `carl-rackspace.helpers.ts`, `support/face-screen-render-suite.ts`, `support/faces-parity-suite.ts`, `support/rack-session.ts`, `e2e/vrt/_shell-faces.ts`, `e2e/vrt/vrt-exemptions.ts`) |
| `_fixtures.ts` `rack` fixture importer files | 243 |
| `rack-session.ts` (`LEGACY_RACK_URL` default) importers | 6 |
| e2e-timings rows | 422; 198 belong to explicitly-legacy-navigating specs (more once the 110 are counted) |
| skip-budget entries | 47; migration-complete / rear-card-legacy-dock / placeholder entries die with the fleet |
| files with `test.fixme` parks | 63 (56 citing #1847) |
| parked files ∩ legacy-navigating specs | 28 (list in §4) |

Confirmed card-DOM members of the fixture-implicit blind spot (all red on the fixture
flip; none were in v2's category inventory): `bluebox.spec.ts` (`bluebox-card`,
`bluebox-key-0`), `fader.spec.ts` (`fader-card`), `painter.spec.ts`,
`shapegen.spec.ts`, `shapegen-clock.spec.ts`, `cable-z-order.spec.ts`
(`video-out-card`), `toybox-control-surface.spec.ts` (`control-surface-card`,
`toybox-card`), `vfpga-floorplan.spec.ts` (`vfpga-runner-card`),
`vfpga-p4-early-hd.spec.ts`, `vfpga-patchpanel-presets.spec.ts`. ModuleShell emits
`module-shell`/`face-*` testids, never `<type>-card`. S0 re-derives the full 110-file
list mechanically (fixture-importers minus explicit-string carriers, minus non-DOM
specs).

**DOOM (corrected):** the doom family is **16 spec files**. Excluding `face-doom.spec.ts`,
**15 of 15 boot `?shell=legacy`** — including `doom-wasm.spec.ts:68` (v2 claimed it was
the exception; FALSE). The actual default-shell exception is
`doom-session-survives-card-collapse.spec.ts` (`/rack?seed=none`; its subject, #1590
node-owned session survival, survives removal untouched). See §5.

⚠ 412 is an upper bound on card coverage, not a measure of it (the shell flag is not a
complete gate). The honest split is by what a spec TOUCHES — §3 S2 categories.

**Cost/capacity (measured):** the legacy-string specs carry **59% of e2e lane cost**
(14,468 of 24,521 CPU-s; 12 shards ≈ 2,043 CPU-s each). Re-pointing off legacy
SERIALIZES cold boots (standing note: dock mount stops overlapping page load), so
flipped specs get slower before deletions get cheaper, and all are packed at stale
costs until re-pin. Derive the boot-serialization ceiling BEFORE S2; watch load spread
on the measurement run; treat any post-re-bin failure as the fixture/contention class,
never a re-run.

### 1.5 VRT coupling

| | count |
|---|---:|
| committed baseline PNGs under `__screenshots__` | **628** (v2's 630 counted 2 `__annotated__` docs PNGs) |
| under the 32 legacy-booting VRT specs | 249 (131 = `vrt.spec.ts` per-card sweep) |
| face tier (`workflow-shell-faces.spec.ts`) | 371; `FACES ≡ STRICT_FACES` both directions |
| `vrt-exemptions.ts` (1,942 LoC) | `EXEMPT_FROM_VRT` 66 (subject `legacy-card` — dies), `VRT_MODULE_MASKS` 31 (audit per scene), `STRICT_VRT_MODULES` 45 |
| DOOM baselines clipping the legacy card | 4 (`composite-doom-evt-{kill,door}-{idle,driven}.png`) |

⚠ **The vrt-strict contradiction (v2 §1.5/§6/§7 were mutually inconsistent).** The
REQUIRED vrt-strict lane is exactly `vrt.spec.ts` + `workflow-shell-faces.spec.ts`
(`vrt.config.ts`, `vrt-shard-plan.mjs`); under `VRT_STRICT=1` the per-card sweep filters
to the 45 `STRICT_VRT_MODULES`. Deleting `vrt.spec.ts` therefore removes 45 required
card scenes from the merge gate and leaves the roster consumer-less — a **content change
to an existing required gate**, which needs owner cover (owner Q9: face-tier scenes for
the 45? redefine the lane?). Additionally `vrt-shard-plan.test.ts:142` hard-codes
`'vrt.spec.ts :: adsr card matches baseline'` — it reds the moment the spec or its
timings row goes and must be rewritten in the SAME commit as the spec deletion.

**The annotated docs-faces pipeline (absent from v2).** `e2e/vrt/vrt-annotated.spec.ts`
boots `/rack?shell=legacy&seed=none`, screenshots the numbered CARD →
`__annotated__/{type}.png` + `{type}.legend.json` (number → card testid) →
`scripts/copy-doc-faces.sh` → `packages/web/static/docs/module-faces/` served by
`/docs/modules/[id]`, wired into `task build` via `docs:faces`. Legend keys are
consumed by `module-docs-lint.test.ts` and `docs/control-doc-resolver.ts`. Re-pointing
to the default shell changes legend testids and `docs.controls` keys — a scheduled
re-point + regeneration + docs-lint key audit, in S3.

The 32 legacy VRT specs split (decided per spec in S3):
- **sweep/chrome scenes** → delete ONLY per owner Q9's answer (`vrt.spec.ts`,
  `vrt-legacy-mask-audit.spec.ts`, `interactions`, `topbar`, `dashboard`, `groups`, …).
- **renderer-content scenes** (subject is the VIDEO PIXELS) → re-point boot + selectors,
  keep scene, bot recaptures (`cube-adsr-composite`, `vrt-synesthesia-*`,
  `vrt-wavesculpt-*`, `vrt-colourofmagic`, `vrt-toybox` 27, `vrt-composite*`,
  `cellshade/mirrorpool/pentemelodica-composite`, `vrt-karplus-tomtom-states`, probes).
- **`vrt-annotated.spec.ts`** → re-point + regenerate legends + docs-lint audit (above).

### 1.6 Unit-test / ledger coupling (corrected and expanded)

**104** unit-test files reference a card path — but v2's "zero mount one" was
materially misleading: one PRODUCT file mounts a card (GroupCard→ScopeCard, §1.3b) and
~19 tests READ card files at runtime (below).

| file | LoC | disposition |
|---|---:|---|
| `lib/ui/modules/card-range-source.test.ts` (`RANGE_BOUND_CARDS` 59, `MAPPING_BOUND_CARDS` 49; reads every `*Card.svelte` from disk; :1206-1210 reds on entries naming deleted files) | 1,374 | delete **in the S4 atomic run, same commit as the fleet** — successor is `paramSpec(def,id)` binding, which every face already uses |
| `lib/ui/modules/card-def-debt.ts` (`OPERATIONAL_DEBT` 5, `VOCABULARY_DEBT` 56) | 310 | delete; ⚠ DoomCard entry — §5; ⚠ **`foxy-face-model.test.ts:48` imports `OPERATIONAL_DEBT`** — fix that surviving test in the same commit |
| `lib/ui/modules/card-def-agreement.ts` | 222 | delete |
| `lib/ui/card-source.ts` (shared reader) | 74 | delete — ⚠ TWO unlisted consumers: `vrt-cable-stripe.test.ts` (below) and `card-primitive-parity.test.ts` (below, also imports `conventionalCardName` from `modules-card-map`) |
| `lib/ui/modules/card-kit.ts` | 137 | **KEEP — v2 "delete" was WRONG.** v2-shell plumbing: imported by `ModuleShell.svelte` + surviving bodies (`CvBuddyBody`, `JoystickPadBody`, `MappyMapBody`, `Moog956RibbonStrip`, `PongCourtBody/Glyph`, `QuadralogicalScreenBody`). Rename off "card" in S5 at most |
| `lib/ui/modules/card-resize.ts` | 72 | **KEEP — v2 "delete" was WRONG.** `startCornerResize` used by `DetachedDisplay.svelte` and `videobox/VideoboxScreenBody.svelte`; documented as the live corner-resize seam by `rack-sizes.ts`/`rack-sizing.test.ts`. Rename at most |
| `lib/graph/hidden-card.ts` | 51 | **KEEP — v2 "delete" was WRONG.** Live product concept: the `hiddenCard` node-data flag for headless camera-manager instances; consumed by `Canvas.svelte` flowNodes derivation, `graph/types.ts`, `asset-spawn.ts`, `dom-source-modules.ts`, `workflow-cameras.ts`, `unpatch-menu.test.ts`; round-trips every persistence path — deleting the reader makes saved patches/perf zips with headless cameras render those nodes onto the canvas. Rename at most |
| `lib/ui/video-card-visibility.ts` | 118 | **KEEP — v2 "delete" was WRONG.** The central IntersectionObserver over `.svelte-flow__node[data-id]` feeding `videoEngine.setCardVisibility` for ALL video nodes, faces included (`video/engine.ts`, `Canvas.svelte`, `DetachedDisplay`, `VideoTileThumb`). Deleting it makes every off-viewport node permanently "visible" to pull-eval — the drag-glitch/output-underrun regression class, silently. Rename at most |
| `lib/ui/media/card-media-lifetime.test.ts` (`EXTRAS_OWNERS` scan; hard min-population guards) | 724 | **RE-POINT, never delete** — widen scan to `lib/ui/modules/**/[A-Z]*.svelte` in the SAME commits that move/delete cards. The scan widening MUST ride the deleting commits (min-population guards make "if not already done" unexecutable — hard requirement, not hedge) |
| `lib/ui/modules/card-preview-gate.test.ts` (ungated-blit deny) | 302 | **RE-POINT** — same reasoning |
| `modules-card-map.test.ts` (bijection) | — | delete with the map |
| **`lib/graph/raw-write-ledger.ts`** (absent from v2) | — | **18 live card-keyed DEBT entries** (`AcidwarpCard` … `WavesculptCard`); `mutate.guard.test.ts:176-190` reds on any entry whose write no longer exists. Harvest every row in the SAME commit as the fleet deletion |
| **`webgl-attest-coverage.test.ts`** (absent from v2) | — | clause (6) (:375) hard-requires a card file to EXIST for every `rendersWebGL` def and walks its render tree; reverse sweep (:391) scans `ui/modules/*Card.svelte`. **Re-point to face/surface trees in the S4 atomic run.** (§1.7's "attest clean" claim was about the HASH only) |
| **~19 surviving face-model tests that `readFileSync` their card** (absent from v2) | — | `blood-`, `clipplayer-`, `colourofmagic-`, `frogger-`, `gatemaiden-`, `gibribbon-`, `milkdrop-`, `modtris-`, `monoglitch-`, `moog-tail-faces-`, `nibbles-`, `picturebox-`, `reshaper-`, `ruttetra-`, `scoreboard-`, `seqtris-`, `skifree-`, `wavesculpt-face-model.test.ts` — each individually reworked to stop reading the card, BEFORE the fleet deletes (S4 pre-stage) |
| **`card-flow-store-guard.test.ts`** (absent from v2) | — | :42 min-population guard reds when the card glob resolves to zero files. Its invariant (no bare provider hooks in dock-plain-mounted components) applies to face/bespoke surfaces mounted by `DockCardHost` — **re-point the glob, not delete** |
| **`module-docs-lint.test.ts` testidPrefix clause** (absent from v2) | — | :360-374 requires every declared `controlFamily.testidPrefix` to appear in card source; corpus is all of `ui/`. Any card-only family (e.g. `bluebox-key-*`, only in `BlueboxCard.svelte`) reds at deletion. **Per-family audit scheduled in S4 pre-stage**: each family's prefix must exist in a surviving surface or the family/docs entry is reworked |
| **`group-viz-hosts.test.ts`** (absent from v2) | — | enforces GroupCard's direct ScopeCard import both directions — updated with the §1.3b re-point |
| **`card-primitive-parity.test.ts`** (absent from v2) | — | anti-vacuity leg reds the instant the fleet deletes; its invariant (card↔face affordance parity — the silent XY-pad→knob downgrade class that shipped once) loses its reference entirely. Disposition = **owner Q12** (accept named coverage loss vs re-anchor, which is a gate change under the no-new-gates ruling) |
| **`vrt-cable-stripe.test.ts` (+`vrt-cable-stripe.ts`)** (absent from v2) | — | a UNIT-lane test reading `e2e/vrt/__screenshots__`; reds when S3 deletes baselines. **Dies WITH the S3 sweep baselines, in the same commit** — not in S4 |
| **`scripts/e2e-shard-plan.test.ts`** (absent from v2) | — | :171-173 "every measured entry names a spec that still exists" — a UNIT test. **Prune e2e-timings rows mechanically in the SAME commit as every spec deletion** (surviving-spec rows may stay stale; the planner tolerates that) |
| **`scripts/vrt-shard-plan.test.ts`** (absent from v2) | — | literal anchor on `vrt.spec.ts` scene keys — rewritten in the same commit as that spec's disposition (§1.5) |
| **`dom-source-modules.test.ts`** | — | imports `modules-card-map`, regex-extracts the glob from `modules-card-components.ts`, asserts entries > 0 — rewritten in the S4 atomic run |
| other card-map/card-source importers needing per-file disposition (absent from v2) | — | `lib/audio/module-registry.ts`, `lib/ui/rack-sizing.test.ts`, `lib/ui/workflow/face-monitor-source.test.ts`, `lib/devices/device-card-source.test.ts` |

`scripts/test-ledger.mjs`: bucket 2 = 339; `legacy-card` subject = 66 → 0; `engine`
rows survive. `SUBJECT_ANCHORS` prose fix while touching.

### 1.7 Attest exposure — hash clean; coverage gate is NOT

`scripts/webgl-attest-hash.sh --list` = 220 files, ZERO `*Card.svelte`; only
`CubeVizSurface.svelte` + `WavesculptVizSurface.svelte` from `lib/ui` — **the fleet
deletion does not move the WebGL attest HASH.** But the attest *coverage* test
(§1.6, `webgl-attest-coverage.test.ts`) requires card files to exist and MUST be
re-pointed in S4. Per the playbook, verify the pin against branch head + current main
before merge; producer extraction keeps the two surface files' paths stable or budgets
a re-attest.

### 1.8 Docs and prose

- **`/docs/modules/[id]` mounts the real card** via `VirtualModule.svelte` (§1.3c) —
  build work, gated by `docs-virtual-module.spec.ts` + 187 STRICT_DOCS pages.
- The annotated docs-faces pipeline (§1.5) regenerates against the default shell.
- Zero files under `docs/` or `runbooks/` reference `shell=legacy`. Rewrites:
  AGENTS.md product-state block (final commit), `module-surfaces` skill passages,
  `face-migration.generated.md` retired with its generator (owner Q3).

### 1.9 Deploy & mixed-version exposure (absent from v2)

- Merge auto-deploys dev/autotest; **prod ships the same night on cron**. The
  "one branch = one revert" rollback is only clean BEFORE the nightly — plan the merge
  early in the day, verify dev per the deploy runbook, and decide the nightly handling
  with the owner (owner Q11).
- Mid-session collab: cards are EAGER in the client bundle, so old-bundle sessions keep
  rendering across the S4 flip — render-only, no shared-state break (verified). The one
  real window is **S1**: during a deploy, an old-bundle peer mounts the CARD producer
  while a new-bundle peer mounts the EXTRACTED producer on the same shared node. The
  extras-channel-owner invariant is per-build. S1's gate includes a two-client
  mixed-mount check per extracted producer (old-vs-new owner on one node), or a stated
  reason the collision is benign.

---

## 2. What is ALREADY DONE that the old plan scheduled

- #2331 (toybox) MERGED — inventory 194/0, `MIGRATION_BLOCKERS` empty.
- Phase 0 wrong exits: named `migration-complete` skips + skip-budget entries + the
  forced-placeholder seam; synesthesia amber-park fixed by #2295.
- Phases 1–2 (capabilities + promotions) shipped; `NON_SHELL_LANE_TYPES` = furniture.
- Phase 3: 371 face baselines exist, `FACES ≡ STRICT_FACES` gated.
- The `DENIED` map self-cleans; whatever remains is dead configuration deleted in S2.

**Not done, still true:** fixture inversion (~412 specs), the switch/fleet deletion, the
source-lint harvest, the §1.3 build list.

---

## 3. The slice sequence — dependency-ordered per the execution review

Owner constraint: the whole removal on one PR branch, green, reviewed whole (owner Q10
offers the prep-split that shrinks the branch without splitting the removal PR).
Rollback: one branch = one revert **before the nightly** (§1.9). Each slice is a
contiguous commit run that keeps the tree green — v2's S4/S5 "green only in combination"
and S5-before-S6 orderings violated this THREE ways (card-scanning tests, shard-plan
timings test, inventory-test imports); the fix is fusing deletions with their readers
(S4 below). Commit aggressively; never `gh pr update-branch`; merge `origin/main`
locally + re-run accept tasks + `task pr:conflict-sweep` after landing.

⚠ **Branch lifetime is the largest execution risk** (measured: 84 main commits/week;
hot generated files churn daily; new main-side specs still default to the legacy `rack`
fixture, so the S2 denominator GROWS until the fixture flips). Mitigations: owner Q10
(land S1 + docs VirtualModule + the fixture-default flip as ordinary main PRs first —
freezes the moving target, mega-branch holds only deletions, ~1 week instead of ~4);
daily local `origin/main` merges with accept-task re-runs regardless.

**S0 — Preconditions (no tree changes).**
- DOOM approval in hand (§5, **corrected 15-spec scope**) — get it FIRST.
- Owner answers to Q9 (vrt-strict card half), Q10 (prep split), Q11 (deploy window) —
  Q9 blocks S3; Q10/Q11 shape the branch.
- Re-measure at branch point: fleet LoC (done here: 194/58,144), fixture pools, attest
  pin vs head + current main, **the full fixture-implicit spec list** (~110; derive
  mechanically), **the toybox card-only-testid diff** against the merged thin adopter
  (`toybox-video-relink`, `toybox-preset-error` were card-only pre-#2331 — verify face
  homes or add to §1.3d).
- Derive the boot-serialization ceiling for S2 re-binning (§1.4 capacity note).
- `task worktree:guard`; branch `feat/legacy-removal` from green `main`.

**S1 — Build work (product only, additive, no deletions).**
All of §1.3: 7 producer extractions (one commit per module) + GroupCard scope-host
re-point + face-based `VirtualModule` + clipplayer-recovery and samsloop-refusal face
homes. Rename `dom-source-modules.ts` vocabulary off "card".
- Gate per module: `card-producer-lifetime.spec.ts`, `extras-producer-lifetime.spec.ts`,
  output sweeps, `REPEAT=3` on changed specs; `card-media-lifetime` scan widened in the
  same commits; group viz-passthrough e2e after the scope re-point;
  `docs-virtual-module.spec.ts` green on the face-based sandbox; mixed-version
  producer check per §1.9.
- ⚠ CV-port changes → FULL web unit suite; poly width → FULL `task art`.
  `wavesculpt`/`cube` surface paths stable (attest).

**S2 — e2e inversion (~412 specs; the long pole).**
Flip `_fixtures.ts` `rack` → default shell; flip `rack-session.ts`; `rackLegacy` alias
only within this slice's lifetime.
- **(a) URL-only flips** — re-point, run, done.
- **(b) card-DOM specs of faced modules** — INCLUDING the ~110 fixture-implicit files:
  rewrite selectors against the face/surface (aria/config selectors) or fold into the
  module's face spec (owner Q8 governs depth). ⚠ Positive-control each family:
  reintroduce one defect, watch the flipped spec red.
- **(c) parity/transition suites** — subject IS the machinery → delete, with matching
  skip-budget entries same-commit.
- **(d) DOOM sub-slice** — exactly the §5-approved 15-spec scope, nothing else.
- **(e) #1847 park reconciliation** (28 files, §4) — unpark-with-repoint or
  delete-with-subject; no re-park.
- **Timings hygiene: every commit that deletes a spec prunes its e2e-timings rows in
  the SAME commit** (`e2e-shard-plan.test.ts` reds otherwise). Surviving-spec rows may
  stay stale until S5's re-pin.
- Gate: focused `task e2e:one` per family; skip counts READ; `REPEAT=3` for changed
  specs; renames keep webgl-heavy filename prefixes. Post-re-bin failures =
  fixture/contention class, never re-run (§1.4 capacity note).

**S3 — VRT inversion/deletion (Q9 answer in hand; owner preview is a PRECONDITION of
acceptance, not an open question).**
- Re-point renderer-content scenes; Linux CI recaptures via scoped `task vrt:commit`
  (never local; review the bot's exact diff; count files against the manifest).
- Delete sweep scenes + `EXEMPT_FROM_VRT` (66) + masks-audit per Q9's resolution of the
  strict card half; **rewrite `vrt-shard-plan.test.ts` in the same commit**; prune
  vrt-strict-timings rows for deleted scenes same-commit.
- **`vrt-cable-stripe.test.ts` + `vrt-cable-stripe.ts` die here, same commit as the
  baselines they read.**
- Re-point `vrt-annotated.spec.ts` → regenerate legends + `copy-doc-faces.sh` output →
  audit `module-docs-lint` legend keys + `control-doc-resolver`.
- Audit `VRT_MODULE_MASKS` (31) per surviving scene. `GREP=<module>` on every focused run.
- Gate: vrt lane green with zero re-pins the bot did not author; every deleted baseline
  names its successor or reason in the manifest; owner has previewed every re-pointed
  visual scene BEFORE the slice is accepted.

**S4 — The atomic removal run (v2's S4+S5+S6 + inventory retirement, fused).**
Deletions ride the same commits as their readers — that is what keeps every commit
green.
- **Pre-stage (each commit green):** rework the ~19 face-model card-readers; re-point
  `webgl-attest-coverage` clause (6) + reverse sweep to face/surface trees; re-point
  `card-flow-store-guard` glob; per-family `module-docs-lint` testidPrefix audit; fix
  `foxy-face-model` import; widen `card-media-lifetime`/`card-preview-gate` scans
  (if any card still unscanned).
- **The removal commit(s):** switch removal (`Canvas.svelte` reader, `laneMigrated`/
  forced-placeholder seam, kind collapse + its SIX unit-file rewrites,
  `ModuleShellPlaceholder`, `DockFullView` false arm, `DockCardHost` prop, `rackLegacy`
  alias, 12 helper strings) **+** fleet deletion (194 cards; Group/Sticky move out
  first) **+** glob/map/bijection/ssr-stub tests **+** `card-range-source` /
  `card-def-debt` / `card-def-agreement` / `card-source` **+** raw-write-ledger 18-row
  harvest **+** `dom-source-modules.test.ts` rewrite **+** `face-migration-inventory`
  machinery retirement **+** vite SSR card-stub branch. The blank-rack hazard
  (`hasCard:false → 'legacy' → SvelteFlow default renderer`) is impossible by
  construction when switch + fleet go together.
- **Post:** re-pin Worker ratchet with stated delta; re-prove SSR positively; test-ledger
  `legacy-card` bucket reads 0; `SUBJECT_ANCHORS` prose fixed.
- Gate: build + typecheck + FULL `task test` green on every commit; rack renders
  identically with and without the now-ignored `?shell=legacy`; the 9 producers produce
  with no card mounted anywhere.

**S5 — Consolidation + artifacts.**
- Rework `scripts/new-module.ts` (+ test) and `scripts/propose-face.ts` off card
  scaffolding/parsing.
- Prune `_module-card.css` to `.rl-tile` survivors, merge into `_rackline-tile.css`;
  optional renames (`card-kit`, `card-resize`, `hidden-card`, `video-card-visibility` —
  KEEP files, §1.6). Rewrite AGENTS.md product-state block + module-surfaces skill.
- **Cost artifacts:** re-pin BOTH (`e2e-timings.generated.json`,
  `vrt-strict-timings.generated.json`) only with zero pending shards. ⚠ Both accept
  scripts REQUIRE a completed CI run — "CI fires once" is structurally impossible here.
  Minimum: N `vrt-update` dispatches (S3) + **≥2 full ci.yml runs** (one measurement run
  after S2/S4 to feed the accepts, one final green on the exact post-re-pin commit).
  State the run plan in the PR body.
- Final gate: full `task build && task typecheck && task test && task e2e && task vrt`
  (+ `task art` if S1 brushed audio) green on the branch's EXACT final commit. PR open;
  **NO auto-merge — the owner reviews.** A red main after merge is P0; merge early in
  the day per §1.9.

---

## 4. The #1847 parks whose specs die or move (28 files)

`cable-drag-panel-lock`, `card-drop-patch`, `clipplayer-play-every`, `control-surface`,
`duplicate-module`, `dx7`, `edges`, `in-card-title`, `io-spec-consistency`,
`landing-new-rack-is-fresh`, `lushgarden`, `mapper`, `matrixmix`, `nibbles`,
`patch-load-leak`, `peakstate-render-smoke`, `per-module-per-port-behavioral`,
`per-module-per-port-outputs`, `per-module`, `recorderbox`, `stereo-mono-normal`,
`timelorde-pinned-source`, `wavecel-video-outs`, `workflow-channel-columns`,
`workflow-dock`, `workflow-shell-faces`, `workflow-shell`, `workflow-surfaces` (.spec.ts).

Rule applied in S2, per park: subject survives on the face path → unpark + re-point same
commit + `REPEAT=3`; subject IS the legacy machinery → delete test + park note +
skip-budget entry together, disposition stated. No re-park; any park that cannot be
honestly unparked or deleted goes to the owner as a named coverage loss.

---

## 5. DOOM — the boundary, one approval request (OWNER) — COUNTS CORRECTED

Measured facts (v2's row was FALSE and would have mis-scoped the approval):
- The doom family is **16 spec files**. Excluding `face-doom.spec.ts`, **15 of 15 boot
  `?shell=legacy`**, including `doom-wasm.spec.ts:68`. The single default-shell spec is
  `doom-session-survives-card-collapse.spec.ts` (`/rack?seed=none`; its subject
  survives removal untouched). An approval scoped to v2's "14, all but doom-wasm" list
  would have left doom-wasm un-re-pointed — after S4 its `?shell=legacy` silently
  ignored, a DOOM boot-semantics change with no approval covering it.
- `DoomCard.svelte` is 122 LoC, thin over `doom/DoomSurface.svelte` (shared with the
  face). The card keeps the Volume `Knob` + OUTPUT FIT row so `card-def-debt`'s
  `audioGain.label` entry keeps a live subject; the face declares both `audioGain` and
  `fillMode`, so the FIT row has a face home.
- 4 committed baselines (`composite-doom-evt-*`) clip the legacy card.
- Two skip-budget DOOM-observer entries watch from OUTSIDE — keep, wording untouched.
- Doom specs pin their own gotos — the S2 fixture flip does not touch them.

**One named approval request, before the branch starts:**
1. Re-point **15** doom specs to the default shell (same `DoomSurface`; game clock /
   waits / budgets untouched — boot URL + knob locator only).
2. Delete `DoomCard.svelte`; def's `Gain` becomes the only label (owner Q2). Debt entry
   dies with its ledger; no attest movement.
3. Bot-recapture the 4 `composite-doom-evt-*` baselines on the face boot.
Any refusal becomes a DO-NOT-TOUCH carve-out and blocks S2(d)/S4 for doom — no partial
path.

---

## 6. DO-NOT-TOUCH list

- **DOOM beyond the §5-approved scope**: game-clock/waits/budgets/ledger entries/sweep
  behavior/mp specs; the two skip-budget DOOM-observer entries;
  `doom-session-survives-card-collapse.spec.ts` needs no re-point. Excluded by name
  from every sweep; each sweep commit says so.
- `DockStubCard.svelte`, `RearCard.svelte` — not legacy.
- `GroupCard.svelte`, `StickyCard.svelte` — move+re-register, never delete.
- **`card-kit.ts`, `card-resize.ts`, `hidden-card.ts`, `video-card-visibility.ts` —
  LIVE default-shell mechanisms (§1.6). Rename at most; deleting any of them breaks the
  shell, saved patches, or viewport culling.**
- `clip-media-recovery.ts` — becomes the face-recovery seam (§1.3d), never deleted.
- `_module-card.css` `.rl-tile` rules — live shell rear-flip; prune-only.
- `CubeVizSurface.svelte`, `WavesculptVizSurface.svelte` — attest basis; path-stable.
- `STRICT_VRT_MODULES` (45) — disposition is owner Q9's, not a sweep's. `STRICT_DOCS`
  (187), behavioral/output-emit exemption rosters (subject `engine`) — live coverage.
- `module-face-lint.test.ts` rules 1–3 — permanent face-quality gates (verified: cards
  appear only in comments there).
- Cost/timing artifacts: accept only with zero pending shards, only from CI runs.
- No new gates or kinds of tests (2026-08-25); no fundamental CI changes (2026-08-23);
  no issues opened; no `gh pr update-branch`; Linux CI authors all baselines;
  `.myrobots` spec/mock packages stay until explicitly consumed.
- `e2e/audio-drift`, `e2e/chaos`, `packages/relay`, `.github` — zero legacy references;
  out of scope.

---

## 7. Gate-by-gate impact summary (corrected)

| gate | impact |
|---|---|
| unit (`task test`) | card-referencing files deleted WITH their subjects (S4 atomic run); ~19 face-model readers + attest-coverage + card-flow-store-guard + docs-lint families + 6 kind-collapse files re-pointed; raw-write-ledger harvested; card-primitive-parity per owner Q12 |
| e2e lane | ~412 specs re-pointed/rewritten/deleted; per-commit timings-row pruning; skip-budget same-commit cleanup; re-bin/capacity watch (§1.4) |
| vrt lane | 32 specs → delete or re-point; −249 legacy PNGs; −66 `EXEMPT_FROM_VRT`; bot recaptures; vrt-cable-stripe dies with its baselines; annotated docs pipeline regenerated |
| vrt-strict | **CONTENT CHANGES** — the card half (45 scenes) of the required lane needs owner Q9; `vrt-shard-plan.test.ts` rewritten; timings re-pin from a CI run only |
| webgl-attest | hash unmoved; **coverage test re-pointed (S4)**; verify pin anyway |
| art | untouched unless S1 brushes audio (then FULL suite) |
| worker bundle | ratchet DOWN — deliberate re-pin, delta in PR body |
| test-ledger | bucket-2 `legacy-card` 66 → 0; `engine` unchanged |
| docs (build) | `docs:faces` regenerated; docs-lint legend keys audited; VirtualModule face-based |
| CI wall-time | net negative eventually; ≥2 full runs + N vrt-update dispatches consumed by the branch itself — state estimate per the >2 min rule |

## 8. Open questions (owner)

1. **DOOM approval** (§5, corrected 15-spec scope) — precondition.
2. Volume→Gain label consolidation — accept, or rename the def (attest re-pin)?
3. Inventory machinery successor: plain retirement, or fold "every registered def
   declares a face (or is organizational-native)" into `module-face-lint`'s set
   identity? (Gate change — flagged under no-new-gates.)
4. Group/Sticky new home + names.
5. `?shell=legacy` post-removal: silently-ignored param vs visible deprecation.
6. Review protocol confirmation: slice-commit review + the §9 deletion manifest; owner
   preview of S3 re-pointed scenes is written in as a precondition — confirm.
7. `strict-faces.ts` prose slimming: this branch or later harvest?
8. S2(b) rewrite depth: fold-and-delete into face specs acceptable, or 1:1 preservation?
9. **vrt-strict card half (NEW):** deleting `vrt.spec.ts` removes 45 required
   `STRICT_VRT_MODULES` card scenes from the merge gate. Replace with face-tier
   equivalents for those 45? Redefine the lane? (Required-gate content change — needs
   explicit owner cover.)
10. **Prep split (NEW):** land S1 (additive product extractions), the face-based
    VirtualModule, and the fixture-default flip as ordinary main PRs BEFORE the
    removal branch? Keeps "one PR for the removal" while cutting branch lifetime from
    ~4 weeks to ~1 against 84 commits/week of main churn. Needs sign-off since it
    splits the one-branch instruction.
11. **Deploy window (NEW):** merge lands on dev same day; prod ships nightly on cron.
    Merge-day protocol: early-day merge + dev verification per the deploy runbook —
    ride the nightly, or hold it one night?
12. **card-primitive-parity coverage loss (NEW):** after deletion nothing compares the
    affordance a param gets against any reference (the silent XY-pad→knob downgrade
    class). Accept as a named coverage loss, or re-anchor the parity check (a gate
    change under no-new-gates)?

## 9. Review artifact — the deletion manifest (NEW; required)

- **A derived deletion manifest is committed on the branch** (script-generated from git
  status + the tables here — never hand-typed, per the roster rule): one row per
  deleted file and per deleted test — `path → LoC → disposition → successor gate/spec
  (or stated coverage disposition) → commit SHA`.
- Review = per-commit review + manifest reconciliation: **manifest row count must equal
  deleted-file count**. (`gh pr view --json files` caps at 100 and the web UI truncates
  a ~700-file diff — the manifest is the review surface.)
- The PR body carries: this file's §1 tables as the checklist, the CI-run plan (§3 S5),
  the worker-bundle delta, the wall-time estimate, and the §1.9 merge-day protocol.
- Owner preview of every S3 re-pointed visual scene is a PRECONDITION of S3 acceptance
  (look-changes ruling).

---

## Appendix A — review items discarded, with reasons

- **"`module-face-lint.test.ts` expects cards"** — disproven in-tree by the execution
  review itself: it imports only def/model-side seams; cards appear only in comments.
- **Mixed-version shared-state hazard at S4/S5 (shell flip)** — refuted by the safety
  review: cards are EAGER in old client bundles; the flip is render-only. (The S1
  producer co-ownership window is real and kept — §1.9.)
- **Card-only affordance suspicions that held negative controls** (recorderbox recover,
  audioin/audioout, blood, picturebox, skifree, midiclock/midiOutBuddy,
  dx7/frametable/wavecel/milkdrop file cells, gamepad mapping body, samsloop UPLOAD
  status) — all verified to have face homes; no action. Only clipplayer recovery and
  samsloop REC refusal survived as real holes (§1.3d).
- **The 36 specs passing `?shell=1`** — benign: resolves to faceplates today, dead
  param after S4; no work item.
- **Toybox card-only-testid caveat** — not discarded, resolved to an S0 action: #2331
  is merged; re-run the diff against the 126-LoC thin adopter at S0.
- **v2's per-file LoC measurements** — attacked and held (every checked value matched
  `wc -l`); only the NET-deletion framing and the 630-baseline count needed the
  corrections in §1.1/§1.5.
