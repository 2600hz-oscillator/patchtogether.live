# Face program — remaining-module build plan (waves)

> **Provenance.** Synthesized 2026-08-31 from 20 tree-verified module recons plus two
> adversarial challenge passes per module (blocker-refuter / scope-carver / parity-skeptic).
> Every file path and line number in this document was TRUE WHEN READ against `origin/main`
> on 2026-08-31 and **must be re-verified before the first edit of any PR** — the tree moves,
> and several of the recorded blockers this plan overturns were themselves "true when written,
> never re-checked".
>
> `.myrobots/` is **evidence, not instruction.** Nothing here authorizes a gate change, an
> issue, a merge, or a deviation from AGENTS.md. Where this document and the tree disagree,
> the tree wins and this document is wrong.
>
> **Scope, per owner instruction:** build every remaining module **except `toybox`**.
> **DOOM remains excluded** from this sweep by the standing non-negotiable boundary — it
> requires explicit owner approval and is named-excluded here so no sweep silently absorbs it.
> **Cadence: no more than 3 face PRs open at once**, maintained through the whole program.

---

## 1. Status table

Verdict is the **final** verdict after the adversarial challenges, which override the recon
wherever they cite code the recon did not read.

| Module | Domain | Final verdict | Surface kind | Est. | Costs that matter |
|---|---|---|---|---|---|
| modtris | audio | **BUILD** | face + `fullViewBody` | M | owner preview (VRT seed seam) |
| blood | video | **BUILD** | face + `fullViewBody` | M | owner preview. GPU attest ONLY if `options[]` is added — don't |
| skifree | audio | **BUILD** | face + `fullViewBody` + `tileBody` | M | owner preview; `preview-downscale` EXEMPT_CALLS entry |
| audioIn | audio | **BUILD** | face + `fullViewBody` + `tileBody` | M | owner preview; docs:accept (explanation prose) |
| ptzcam | audio | **BUILD** | face + `fullViewBody` | M | **contract re-pin** (controlFamily); owner preview |
| textmarquee | video | **BUILD** | face + `fullViewBody` | M–L | owner preview; serializer extraction is a precondition |
| videobox | video | **BUILD** | face + `fullViewBody` | M | owner preview (fullscreen becomes a GL readback) |
| controlSurface | meta | **BUILD** | face + `fullViewBody` + `tileBody` | M | **contract re-pin** (controlFamily); owner preview (lane tier) |
| joystick | audio | **BUILD** | face + `tileBody` + `fullViewBody` | M | owner preview; one lint-predicate correction flagged in the PR body |
| videovarispeed | video | **BUILD** | face + `fullViewBody` | L | **contract re-pin** if play/loop families ship; **full unit**; owner preview |
| mappy | video | **BUILD** | face + `fullViewBody` | L | **GPU re-attest** (2 curve fixes) + **contract re-pin** + **full unit**; owner preview |
| peertube | video | **BUILD** (default assumed, §5.7) | face + `fullViewBody` | M | owner preview |
| recorderbox | video | **BUILD** (tileBody variant) | face + `fullViewBody` + `tileBody` | L | owner preview. Contract re-pin ONLY if the cell variant is chosen — it isn't |
| moog956 | audio | **OWNER** (§5.1) | face + `fullViewBody` + `tileBody` | M | **contract re-pin** (gate curve); owner preview |
| nibbles | video | **OWNER** (§5.2) | face + `fullViewBody` | M | GPU re-attest + 10 baselines **only under option B**; owner preview |
| painter | video | **OWNER** (§5.3) | face + `fullViewBody` | M | owner preview |
| chromaconsole | audio | **OWNER** (§5.4) | face + `fullViewBody` + new param-cell kind | L | **contract re-pin**; owner preview |
| archivist | video | **OWNER** (§5.5) | face + `fullViewBody` (+ #1511 move) | L | owner preview; full unit if the controller move lands |
| clipplayer | audio | **OWNER** (§5.6) | face + panels + `fullViewBody` + `tileBody` | L | **contract re-pin**; **full unit**; owner preview |
| gibribbon | video | **PR-BLOCKED** (#2263) | already built in #2263 | S | **GPU re-attest on the MERGED tree**; owner play-test |

**Counts:** 13 BUILD · 6 owner-blocked · 1 PR-blocked · (toybox excluded by owner, DOOM excluded by boundary).

---

## 2. Inventory corrections (ride with each module's own PR)

The migration inventory's `why` prose is **ungated** and has now been found wrong on
**20 of 20** modules examined. Correct it in the same diff as the promotion — a `generic-face`
entry takes a `note`, never a `why`, and `face-migration-inventory.test.ts:260` makes the
disposition flip **mechanically mandatory** the moment a def declares a `face`.
Then run `flox activate -- task face:inventory:accept`; **never hand-type a count**.

All line numbers below are `packages/web/src/lib/ui/workflow/face-migration-inventory.ts`
unless stated.

### 2.1 joystick (:394)
- **KEEP** `disposition: 'generic-face'` (`blocked` needs a `MigrationBlockerId`, and the union
  has one member).
- **Old note is right about the CELL and stops one step short of the refusal.** Rewrite to say:
  the pad migrates onto the shared `xy` cell at the DOCK and onto a `tileBody` at the LANE,
  never two knobs; the remaining obstacle is ONE gate predicate, not a platform seam.
- **Three sibling stale sites, all false, all in this PR:**
  - `packages/web/src/lib/audio/modules/joystick.ts:165-170` — "*both move every pad-bearing
    face's lane tile and its baselines, so both are platform work*". FALSE: `tileBody` (#2242,
    2026-08-27) moves **no other module** — `cameraInput` is its only adopter in the tree.
  - `packages/web/src/lib/ui/modules/joystick-persist-model.test.ts:17-23` — names a Q43 hold
    cleared by #2038; the def itself already retracts it at `joystick.ts:114-125`.
  - `packages/web/src/lib/ui/workflow/face-xy-body-source.test.ts:58-60` — "*every lane tier
    keeps the generic `XyPad` by construction*". FALSE, and `curated-face.ts:552-556` says so
    three files away: **no lane tier has ever painted a pad.**
  - `packages/web/src/lib/ui/modules/JoystickCard.svelte:~40-44` — "*the face carries the value
    in `aria-valuetext`*"; the def already corrected that to the wrong-attribute finding.

### 2.2 blood (:784-790)
- `bespoke-surface` → `generic-face`.
- **Strike two false clauses verbatim:** "*its body is the viewport*" (BloodCard.svelte has **no
  `<canvas>` in 383 lines** — that sentence is DoomCard's) and "*the knobs*" (the card renders
  exactly ONE knob and paints **no** control for `fillMode`, so the face **adds** a control).
- New note records: the card's real content is the **engine boot** — `BloodCard.svelte:94` is the
  only `extras.ensureLoaded()` caller in the tree — plus the IndexedDB restore, the
  `webkitdirectory` picker, `resetLoad()` and the capture-phase keyboard host; all move into
  `fullViewBody`. Record that the face **adds** blood's first picture and its SCREEN switch, and
  that blood boots only when the dock full view is open (true before and after).

### 2.3 gibribbon (:966-993)
- **Do not author a fresh correction.** PR #2263 already replaces this entry in full
  (`generic-face` + 21-line note). Judged against the tree the recorded FACTS are accurate; the
  DISPOSITION was stale (written before `frogger` shipped).
- Sibling: `e2e/vrt/vrt-exemptions.ts:975-980` claims the ribbon "*defeats deterministic
  single-frame capture*" — #2263 disproves it with `__gibribbonVrtSeed` / `__gibribbonVrtTicks`
  and removes it from both anchored lists.

### 2.4 mappy (:1030-1036)
- `bespoke-surface` → `generic-face`, `why` → `note`.
- **The first two clauses are true; the CONCLUSION is false, and the false conclusion already
  propagated into a gate**: `e2e/tests/dock-tray-shrink-to-content.spec.ts:104-107` quotes this
  entry and pins mappy's un-migrated status as a *durable property*. Re-point that spec (its own
  failure message prescribes it) — do not relax it.
- **Strike:** "*Direct geometry manipulation is the ENTIRE module*". mappy declares TWO real
  params (`showGrid` :432, `surfaceCount` :434) which the card paints as a GRID button and a +/−
  stepper.
- Sibling stale sites: `e2e/vrt/vrt-exemptions.ts:1229` ("nothing patched is … a black preview" —
  it is a deterministic numbered grid), `MappyCard.svelte:8-9` (header says connected-only; the
  template at :343 says otherwise), and `mappy.ts:438` docs.explanation.

### 2.5 nibbles (:1139-1143)
- `bespoke-surface` → `generic-face`.
- **Strike:** "*played on the keyboard*" — there is **no keyboard handler** in `NibblesCard.svelte`
  or the bundle. Steering is CV + (when unpatched and focused) the MOUSE.
- Note must record the glyph trap: nibbles declares **two `type:'audio'` outputs**, so any trace
  literal resolves `{kind:'live-audio'}` and passes the dead-glyph clause while binding to a seam
  structurally blind to a video node. `mandelbulb-glyph-tap.test.ts:14`'s claim that mandelbulb is
  "*the ONE video module with a type: audio output*" is **false** — nibbles is a second.

### 2.6 painter (:1204-1209)
- `bespoke-surface` → `generic-face` (mechanically required).
- The old `why` ("*direct pointer painting is the module and it declares no params at all*") is
  **factually true and draws a ladder conclusion the `fullViewBody` slot invalidated** — the
  picturebox/pong shape. `videoOut` is the shipped zero-param precedent.
- Also rewrite `painterDef.docs.explanation`, which narrates "the card" throughout
  (hash-transparent, free).

### 2.7 textmarquee (:1311-1317)
- `bespoke-surface` → `generic-face`, drop the `needs-note-entry-cell` framing entirely (that
  blocker id was DELETED; `ShellEntryCell` shipped, and a `fullViewBody` is a slot, not a cell).
- Note records: the rasterize-and-push half already moved to `extras-producers.ts:192-231` on
  node lifetime (#1720), so the card writes the MODEL and blits a preview only.
- Sibling: `e2e/vrt/vrt-exemptions.ts:98-99` (the 4plexvid block) claims "*the CARD has not
  rendered since 4plexvid entered STRICT_FACES*" — FALSE, `vrt.spec.ts:86` boots `?shell=legacy`.
  Correct it as boy-scout or leave it and name it; do not price a baseline churn that will not
  happen.

### 2.8 chromaconsole (:852-859)
- **Three of four clauses are dead** (connect gesture = shipped action cell ×5; channel = fixed
  16-entry selector; the 29-entry assignment roster is STATIC descriptor data, not service state).
- The real constraint was never named: **`deviceSlotParams` mints eight identical `0..127 linear`
  params labelled "slot 1".."slot 8"**, and what each drives is per-NODE `node.data.assign`.
- **Also correct the neighbouring `ptzcam` entry (:861-867)**, which cites this one as its
  precedent — ptzcam does NOT inherit the blocker; its four trim knobs are ordinary named params.

### 2.9 clipplayer (:868-875)
- `bespoke-surface` → `generic-face` at promotion.
- **Strike two false clauses:** "*per-cell arm*" (the arm is per **LANE**; `clipplayer.ts:251`
  says the global button was replaced) and "*capture*" (`noteRec` has **zero** references in
  `ClipplayerCard.svelte`).
- "*is the canonical bespoke surface the extension seam was built for (#1512, now shipped)*" reads
  stronger than the tree: `editorSurface` — the slot literally named for this shape — is
  **declared and UNWIRED** (`shell-extensions.ts:138` vs `:144`). Route through `fullViewBody`.

### 2.10 modtris (:1128-1131)
- `bespoke-surface` → `generic-face`.
- **Both clauses false:** "*played on the keyboard*" (the card registers no key handler; five gate
  inputs are the whole input surface) and "*with two faders beside it*" (the lane renders a BLANK
  PLACEHOLDER today — the comparison is face-vs-grey, not face-vs-card).
- Sibling: `modtris.ts:97` promises the canvas "*can be portaled into a containing GROUP card*".
  FALSE and measured: `GROUP_VIZ_HOST_TYPES = {'scope'}`, `group-viz-hosts.test.ts:104` records
  `canvasInSlot 0` (#1755). `modtris.ts:114` `docs.controls.levelStep` promises a difficulty ramp
  that does not exist (`modtris-state.ts:128-129`).

### 2.11 moog956 (:1133-1138)
- `bespoke-surface` → `generic-face`.
- The `why` is **true in its parts, wrong in its conclusion**: "a 1-D touch surface is not a knob"
  is right; what it cannot express is the ONE-POINTER gesture writing `pos` and `gate` together,
  which is exactly what the wired extension seam is for.
- Record the newly-discovered cost: `gate` is declared `curve:'linear'` while the factory
  hard-thresholds it (`moog956.ts:137`), so `face.momentary` is **refused until the curve is
  corrected** — a contract move, neutral by construction.

### 2.12 ptzcam (:861-867)
- `bespoke-surface` → `generic-face`.
- The `why` cites chromaconsole — the one binder still unfaced — while **six siblings shipped this
  exact shape**. Also strike "*the four trim knobs are the only generic-face material*":
  `ptzcam-connect-{n}` is a fifth ranked cell and its testid already exists on the card
  (`PtzcamCard.svelte:119`), so module-docs-lint passes with **no card edit**.

### 2.13 skifree (:1307-1310)
- `bespoke-surface` → `generic-face`.
- **Strike "played on the keyboard"** — no keyboard handler in the card or the vendored bundle;
  steering is two bipolar CV inputs plus the mouse.
- Record that `order: []` is legal and explicitly out of scope of the #1974 zero-lane clause
  (which names `flipper` and `videoOut`), and that the #2192 (868ddb9ee) card-ownership move
  already invalidated the standing refuse-spec's lead blocker.

### 2.14 controlSurface (:899-905)
- `bespoke-surface` → `generic-face`.
- **Strike:** "*Its content is other modules' parameters, so it has no params of its own to rank*"
  — the LOCK toggle (`node.data.locked`) is one node-data-backed control of its own, and
  matrixMix/electraControl already refuted the zero-rankable framing.
- **Correct the three prose sites that quote the refusal as current fact:**
  `strict-faces.ts:4587`, `strict-faces.ts:4718-4741`, `legacy-fallback.ts:163-166`, and
  `e2e/tests/_face-fixtures.ts:347`. The 192 px measurement was taken **before `tileBody` existed**.

### 2.15 archivist (:730-738)
- `bespoke-surface` + `needs-media-controller` → `generic-face`, blocker **dropped for this entry
  only** (the registration stays; six other entries name it).
- **Strike:** "*a result list to pick from*" — `lastDocs` is card-local `$state` that the player
  never sees; the card shows ONE randomly-picked item and a `↻ next`. That sentence describes
  **peertube**.

### 2.16 audioIn (:739-747)
- `bespoke-surface` + `needs-media-controller` → `generic-face`.
- **Strike the load-bearing third clause:** "*a getUserMedia stream the card starts and stops with
  its own lifetime*" — #1590 moved it; `node-audio-input-registry.svelte.ts:47-58` states "the card
  ADOPTS and READS; it never CREATES or DESTROYS", and `AudioinCard.svelte:256-270` carries the
  matching "⚠ NO `stopStream()` HERE" banner.
- Sibling: `face-migration-inventory.ts:766` ("*the same shape still waits on audioIn above*") and
  `e2e/vrt/vrt-exemptions.ts:702`; `Canvas.svelte:2888` ("*BOTH ARMS ARE FALSE TODAY*" — audioOut
  IS migrated); `audioin.ts:115-118` describes a **device filter the card does not implement**.

### 2.17 peertube (:1210-1221)
- `bespoke-surface` + `needs-media-controller` → `generic-face`, blocker dropped from the entry.
- The entry **already disproves its own blocker in its own prose** and keeps it on a registry-wide
  probe — a category error, since cameraInput and loopback are both `generic-face` with that
  blocker outstanding. peertube does not even pay the headless-host tax (it left
  `DOM_SOURCE_LANE_TYPES` in LEG-02 P3).
- Record the DEAD control: the "instance (optional)" input writes `node.data.instanceHost` and
  **nothing reads it** — `buildSearchUrl` takes no host and `fetchCatalogue` ignores `data`.
  Delete the control + field, and fix `peertube.ts docs.explanation` and
  `module-manifest.ts:319`, both of which claim it works.
- Delete peertube's DENIED entry in `e2e/tests/_face-fixtures.ts:123-125` **by hand**.

### 2.18 recorderbox (:1280-1288)
- `bespoke-surface` + `needs-media-controller` → `generic-face`.
- **Every clause after the dash is false and #1574/#1584 (bdef392f6) is what made it false:** the
  capture canvas is registry-owned and never enters the document; the encode pump is the
  registry's ("CAPTURE IS NOT HERE", `RecorderboxCard.svelte:257-259`); the recording survives card
  unmount **by construction**. "*A take list*" was wrong too — that block is a crash-recovery list
  from OPFS manifests, empty after a clean boot.
- Record that `needs-media-controller` never applied: recorderbox is a **SINK** (it consumes the
  engine's FBO via `blitOutputForPreview`) and is in neither half of `HEADLESS_MOUNT_LANE_TYPES`.
- Sibling stale sites: `RecorderboxCard.svelte:8-10` (contradicts :92-96 in its own file) and
  `e2e/vrt/vrt-exemptions.ts:118-124` (the mask's `why`).

### 2.19 videobox (:1374-1382)
- `bespoke-surface` + `needs-media-controller` → `generic-face`, drop the `blockers` key (do NOT
  delete the blocker from `MIGRATION_BLOCKERS`).
- **Strike:** "*the card still creates and attaches the source*" — the string
  `attachExternalSource` does not appear in `VideoboxCard.svelte`; LEG-02 P1 moved it.
- Record the second stale fact that actually decided the disposition: `gain` used to be a declared
  param nothing wrote and nothing read; **#2189 wired `uGain`**, so videobox now has exactly one
  honest control to rank.

### 2.20 videovarispeed (:1383-1390)
- `bespoke-surface` + `needs-media-controller` → `generic-face`.
- **Strike:** "*over a card-owned video source*" — LEG-02 P2 moved elements, attach, audio wire,
  transport, 33 ms CV poll, gate slot switch, seven virtual playheads and the crop push to
  `node-varispeed-registry` on GRAPH lifetime.
- **Correct the registry's own false header**, `node-varispeed-registry.ts:71`, which claims it
  owns "*the per-slot saved-handle restore and the multi-slot export resolver*" — it owns neither.
  Also `asset-spawn.ts:26-31,384-388` and `Canvas.svelte:3737,3740`.

---

## 3. Waves

**Sequencing rules applied.** (a) Every face PR touches the same primary rosters
(`strict-faces.ts`, `face-migration-inventory.ts`, `_shell-faces.ts`) and the same generated
artifacts (`face-migration.generated.md`, both timings JSONs, sometimes `contract-lock.txt`) —
that is unavoidable at 3 open PRs, so the rule is: **never `gh pr update-branch`; merge
`origin/main` locally; "keep both sides" is acceptable only for hand-authored per-module keyed
rosters, and for every GENERATED artifact you must take main's version and re-run the accept
task.** Waves are therefore spread on the *secondary* files: `shell-cells.ts`,
`contract-lock.txt`/`docs:accept`, `face-screen-render-suite.ts` SUBJECTS,
`_face-fixtures.ts`, and one hard pair below. (b) Cheap high-confidence work first. (c) GPU
re-attest amortized. (d) PR-blocked and owner-blocked last.

**Hard pairing constraint:** `videobox` and `videovarispeed` both break
`e2e/tests/collapse-keeps-playing.spec.ts` the same way (a blitting body means the node-owned
`<video>` never enters the dock pane, so the dock-scoped queries time out). **They must not be in
the same wave.** Wave 3 (videobox) carries the repair — re-point the queries document-wide and add
the negative leg; wave 4 (videovarispeed) rebases onto it. If both landed unrepaired, the sweep
reports two green SKIPPED tests and an owner-P0 regression guard is silently gone.

| Wave | Modules | Why grouped |
|---|---|---|
| 1 | modtris · blood · skifree | Cheapest, highest-confidence. All three are games/sinks: no `shell-cells.ts`, no contract-lock, no GPU attest. Distinct secondary files (VRT seed pin / SUBJECTS row / EXEMPT_CALLS row). Establishes cadence. |
| 2 | audioIn · ptzcam · textmarquee | Two device binders on a shipped template plus one editor body. Only ptzcam touches `shell-cells.ts` + contract-lock. audioIn is the only one touching the pinned 🎧 surface. |
| 3 | videobox · controlSurface · joystick | videobox carries the `collapse-keeps-playing` repair. controlSurface is the only `shell-cells.ts`/contract-lock editor here. joystick touches neither and is the program's permanent negative control — worth landing while attention is on it. |
| 4 | videovarispeed · mappy · peertube | The heavies, spread so only mappy touches `shell-cells.ts` and only mappy pays GPU attest. videovarispeed rebases on wave 3's spec repair. **Attest window:** mappy is the only confirmed re-attest in the BUILD set — run it together with gibribbon's merged-tree attest (§3.6) and, if granted, nibbles option B. |
| 5 | recorderbox (+ first two owner-unblocked) | Largest remaining sink; needs the `_face-fixtures.ts` DENIED deletion, which peertube also needs in wave 4 — sequential, no conflict. Backfill the wave from §5 as answers arrive. |
| 6+ | owner-unblocked backlog | moog956 · nibbles · painter first (small, defaults ready), then chromaconsole · archivist, then clipplayer last (largest, most invasive, needs owner preview). |
| — | gibribbon | Separate PR-blocked track (#2263), lands on its own attest window whenever the owner runs it. |

---

## 4. Build briefs

Each brief assumes the standard face-PR spine and does not repeat it:
declare the `face`, add the type to `STRICT_FACES` with its rationale block, flip the inventory
entry (§2), add the `EXTENSION_BODY_ROLES` entry for any new `fullViewBody`
(`face-rack-status-source.test.ts` — deny-by-default; a body with no entry is RED), add the
`_shell-faces.ts` FACES roster row (asserted equal to `STRICT_FACES` in both directions;
`videoFaceWhy` is **mandatory** for a video def or `bootWithFace` burns the 90 s timeout), and
run:

```
flox activate -- task face:accept
flox activate -- task face:inventory:accept
flox activate -- task typecheck
flox activate -- task test:one -- <module>
GREP=<module> flox activate -- task vrt:commit          # Linux CI authors baselines, never local
flox activate -- task e2e:timings:accept -- <run-id>     # after ALL shards report
flox activate -- task vrt:strict:timings:accept -- <run-id>
```

**Both cost artifacts, every face PR, and never while shards still PEND** — a partial accept
truncates into a diff that reads exactly like a legitimate re-pin.
Every new face spec gets a **`pageerror` guard** (a shared derivation repaired on
`ModuleShellPlaceholder` can still throw in `ModuleShell`, and only promoting reveals it), and
every new/changed spec gets `REPEAT=3`.

---

### WAVE 1

#### 1a. modtris
- **Surface:** declarative face + `fullViewBody` (`$lib/ui/modules/modtris/ModtrisBoardBody.svelte`).
- **Glyph:** `'none'` — verified forced. Two `gate` outputs, no `audio` output ⇒ every other
  literal resolves `{kind:'static'}` and reddens the dead-glyph clause.
- **Hero:** none. `fullViewBody` takes the dock head (`dockFullViewHeadPlan`: extBody wins,
  suppresses heroGlyph).
- **Pages/cells:** ONE page `play`, cells `gravityBpm` (knob, rank 1 — it is the module's tempo and
  therefore its gate rate) and `levelStep` (knob, rank 2). No tab rail: 1 band vs
  `DOCK_TAB_MIN_BANDS = 7`; **do not pad**.
- **Parity that must survive:** the live well + next-piece strip + in-canvas `LN` counter (all one
  `drawModtris` call — import it, do not re-implement); the rename; the seven jacks (derived rail
  gives ROTATE L / DROP FAST / LINE CLEARED for free — do **not** add `PortDef.label`);
  `previewCollapsed` on `node.data` (never `$state`); SCREEN ON/OFF that suppresses only the draw
  call — the game subscribes to the shared scheduler clock **in the factory** (`modtris.ts:203`),
  so pieces keep falling and `line_cleared`/`overfill` keep pulsing while OFF.
- **Do first, it is a precondition:** bind both fader ranges with `paramSpec(modtrisDef, id)` and
  enrol `ModtrisCard.svelte` in `RANGE_BOUND_CARDS`. The card currently reads defaults
  **positionally** (`params[0]`/`params[1]`) and re-types `min/max` as literals — if the VRT seam
  below adds a param ahead of `gravityBpm`, both faders silently re-point with every gate green.
- **VRT determinism seam (required, and strictly harder than frogger's):** frogger has no RNG;
  modtris does (`modtris-state.ts:178`, the 7-bag, `opts.rng ?? Math.random`) and pong measured
  that a seed alone is insufficient. Build **seed + fixed-tick-then-stop**: a `__modtrisVrtSeed`
  boot global seeds `initModtrisState`/`stepModtrisState` and the sim steps N ticks at
  construction then stops subscribing, making the well **time-invariant**, not frozen. Do **not**
  add a `freeze` ParamDef (contract cost, weaker guarantee). Then remove modtris from
  `EXEMPT_FROM_VRT` **and** `ALLOWED_PERMANENT_EXEMPT` in one commit (anchored both directions).
- **Also in this PR:** fix the DPR/HUD scale — the card passes backing-store px into `drawModtris`
  so the absolute-sized `NEXT`/`LN` text mis-scales; pass CSS px + `setTransform(DPR,…)` on BOTH
  surfaces. Decide `levelStep` out loud: it is read by **nothing**
  (`modtris-state.ts:331-434` touches `params` once, for gravity) while docs promise a difficulty
  ramp. **Recommended: implement it** (a lines/levelStep level term feeding
  `gravitySecondsPerDrop`) — no contract change, makes the docs true; re-run
  `task art:one -- modtris` and attribute the lock-count move.
- **Tests owed:** default-shell face legs (lane paints `module-shell` not the placeholder; the dock
  body paints a LIVE board — sample twice across frames; SCREEN OFF removes the canvas while the
  tick counter advances; the VRT pin actually pins, which negative-controls the sampler).
  Existing `modtris.spec.ts` legs survive (one is `?shell=legacy`, two read engine state).
  **Precursor:** modtris is the ONLY member of `AUDIO_OPERABLE_FIXTURE`'s derived pool — promotion
  makes `deriveFixture` return `migration-complete` and `workflow-shell.spec.ts:371` skips by name.
  Not red, but skips are not passes: **name it in the PR body** and see §5.1's `toybox` note.
- **VRT scope:** `GREP=modtris`. Two new scenes; the legacy card scene moves only if you also pin it.
- **Shared files:** `strict-faces.ts`, `face-migration-inventory.ts`,
  `face-migration.generated.md`, `_shell-faces.ts`, `vrt-exemptions.ts` (both lists),
  `card-range-source.test.ts` (RANGE_BOUND_CARDS), both timings JSONs.

#### 1b. blood
- **Surface:** declarative face + `fullViewBody` (`BloodScreenBody.svelte`).
- **Glyph:** `'none'` — verified: `glyphBinding` returns `{kind:'none'}`. Not mechanically forced
  (blood has `audio_l`), but `laneGlyphFor` short-circuits to `'picture'` for a video def, so any
  trace literal would paint nothing and spin an unrendered analyser tap.
- **Hero:** none — the extension body claims the dock head.
- **Pages/cells:** ONE band `output`: `audioGain` (knob) and `fillMode`. **DECLARE NO
  `paramCells`.** `'toggle'`/`'segmented'` are not authorable (`AuthoredParamCell = grid|color|
  hue|fader`); `fillMode` is `discrete 0..1` so `paramCellKind` derives `toggle` **free**.
  Adding `options[]` for LETTERBOX/FILL captions is a **params** edit on a def inside the WebGL
  attest basis ⇒ **GPU re-attest + contract + docs:accept for two captions. Do not.**
  Add `'blood:fillMode'` to `ACKNOWLEDGED_LATCHING`. Declare all 13 `cv_*` params
  `noUserControl` (writer `'cv-port'`) — hash-transparent, free.
- **Parity that must survive (all in the body):** the **engine boot** — `BloodCard.svelte:94` is
  the tree's only `extras.ensureLoaded()` caller and blood is in no headless-mount set, so a body
  that forgets to boot leaves a promoted blood dark forever while every gate stays green; the
  IndexedDB restore; the `multiple + webkitdirectory` folder picker with `resetLoad()`; the BOOT
  button; the capture-phase keyboard host on a focusable `role="application"` frame; the
  actionable error prose (`BLOOD_REQUIRED_FILES`, `*.ART`/`*.DAT`, the `BLOOD_LINK=1` build
  command — instructions for a gesture, permitted in a body); the live 2-D preview and the SCREEN
  switch.
- **Write it as a port, not a copy:** take `AcidwarpScreenBody.svelte:78-127` for the
  rAF/blit/markWatched loop **only**; hand-carry the keyboard host from `BloodCard.svelte` —
  **no shipped `fullViewBody` in the tree installs a capture-phase keyboard host.** Header must
  state (a) the `selected` fallback branch is unreproducible in a `{ nodeId }` slot and is already
  inert because `DockCardHost` passes no `selected`, and (b) claiming `Tab` suppresses the
  faceplate FLIP gesture (pre-existing in the dock, but say it).
- **Body must stay 2-D** (`getContext('2d')`): a WebGL context auto-enrols the file in the attest
  basis permanently.
- **SCREEN OFF nuance to state honestly:** blood is pull-exempt via non-empty `audioSources`
  (`engine.ts:1157` names it) **only while an AudioContext exists** — `markWatched` is the belt for
  the no-AudioContext boot. Do not copy acidwarp's stronger claim.
- **Tests owed:** a new `blood-face-screen.spec.ts` (the body mounts, SCREEN unmounts/restores the
  canvas, `previewCollapsed` persists, the engine keeps running while OFF) — **mandatory**, since
  blood goes into `FACES_WITHOUT_SCENES` and this is the only automated check the body paints;
  a `SUBJECTS` row in `face-screen-render-suite.ts`; `blood-face-model.test.ts`; and **re-point ONE
  existing blood spec off `?shell=legacy`** so the boot + keyboard + audio chain is exercised
  through the shipping surface. **Measure the parity-row wall-time delta** — that row now cold-boots
  `blood.wasm` + the LFS shareware inside the dock body; it is the one number that could cross the
  2-minute sign-off line.
- **VRT scope:** `GREP=blood`, legacy-card lane only. Blood belongs in `FACES_WITHOUT_SCENES` with a
  measured argument (Build's `totalclock` is wall-clock inside WASM with no page-global for
  `simPin`; `freezeFaceVideo`'s write is a no-op on a def with no `freeze` param — therefore
  **omit `freezeIsNotASeam`**, which the gate forbids when there is no freeze param).
- **Shared files:** the spine, plus `module-face-lint.test.ts` (ACKNOWLEDGED_LATCHING),
  `face-rack-status-source.test.ts`, `_shell-faces.ts` (FACES_WITHOUT_SCENES),
  `vrt-exemptions.ts` (rewrite blood's `why` to cover the legacy card only — the warrensspectrum
  shape), `face-screen-render-suite.ts`.

#### 1c. skifree
- **Surface:** face with `order: []` + `fullViewBody` **and** `tileBody`
  (`$lib/ui/modules/skifree/`).
- **Glyph:** `'none'` — verified forced (gate + video outputs, no audio ⇒ every literal is a dead
  static).
- **Hero:** none. `order: []` is **legal and out of scope** of the #1974 zero-lane clause, which
  names `flipper` and `videoOut`.
- **Pages/cells:** none. `params: []`.
- **Parity that must survive — and two of these must be AUTHORED, not ported:**
  1. **The blit is cropped today on DPR ≥ 2.** `SkiFree.create` overwrites the 320×320 canvas to
     640 backing / 320 logical; the card's 3-arg `drawImage` therefore paints the top-left
     quadrant, with the skier on the corner. Fix it: explicit destination rect scaled off
     `src.width/height`, `imageSmoothingEnabled = false`, plus a **named `EXEMPT_CALLS` entry in
     `preview-downscale-source.test.ts`** (FoxyOutputBody / RasterizeOutputBody wording).
     **Fix `SkifreeCard.svelte:149` the same way in the same diff** so the two surfaces never show
     different pictures.
  2. **Own the steering in the body.** `controller.enableMouse`'s handlers take their rect from the
     **detached** factory canvas (all zeros since #2192), so the cursor gets raw viewport
     coordinates. Bind `pointermove`/`click` to the body's own canvas, map rect-relative into
     `SKIFREE_CANVAS_SIZE` (import it — do not hardcode 320), call `controller.setCursor`, and
     **gate on `bridge.cvDriven`** so patched CV still overrides the mouse (`syncMouseControl` is
     the only consumer of that flag in the tree).
  3. The write path must sit **above** any `previewCollapsed` branch: `player.isMoving` latches only
     via `setCursor`, so on an unpatched rack SCREEN OFF must not become a play kill switch even
     though it is not a producer kill switch.
  4. `tileBody` = the same scaled blit honouring `previewCollapsed`, read-only; the loading /
     bundle-failed overlays; the focus ring; the CV/MOUSE/IDLE mode indicator (as a lamp + a11y
     name — distance/lives/GAME OVER are painted **into** the canvas by the bundle's InfoBox and
     ride along free).
- **Decide the focus gate explicitly:** unconditional hover-steering is a behaviour change from the
  card's focus+CV gate. Either keep a click-to-arm state or rewrite `docs.explanation`,
  `docs.inputs.x/y` and `module-manifest.ts:434` (all say "when the card has focus"). `docs:accept`.
- **Tests owed:** a default-shell spec that **steers through the face and asserts
  `snapshot.distance` climbs** (no test in the tree moves the skier today); tileBody paints without
  expanding; SCREEN OFF keeps gates firing; repair
  `e2e/tests/skifree-node-lifetime.spec.ts:320`, which hard-codes `module-shell-placeholder` as
  skifree's lane tile. `#1974` SKIPS `order: []` faces, so the face-model test must pin the
  `tileBody`'s existence itself — nothing else in CI would notice the lane regressing to a title
  and a jack rail.
- **VRT scope:** `GREP=skifree`, existing legacy scene only. The FACE goes into
  `FACES_WITHOUT_SCENES` with the measurement (`simPin` cannot reach a rAF loop inside a committed
  third-party IIFE with its own RNG; the def declares no `freeze` param, so **omit
  `freezeIsNotASeam`**) and a `coveredBy` roster naming the `skifree-face-model.test.ts` you write.
- **Shared files:** the spine, `face-rack-status-source.test.ts`,
  `preview-downscale-source.test.ts` (EXEMPT_CALLS), `_per-module-per-port-shared.ts:452-456` and
  `per-module-per-port-behavioral.spec.ts:311` (their stated coverage points only at a
  `?shell=legacy` spec), `module-manifest.ts` (docs:accept).

---

### WAVE 2

#### 2a. audioIn
- **Surface:** face + `fullViewBody` **and** `tileBody`, both mounting ONE shared
  `AudioInSourceControls.svelte` with a `testidPrefix` prop (the tile and the dock pane can be on
  screen at once; a shared testid throws every strict locator).
- **Glyph:** `'meter'` — audioIn declares real audio outputs, so `primaryAudioOutPortId` resolves
  `audio_l_out` and the binding is live. (This is the one binder in the program that keeps a lane
  picture.)
- **Hero:** `hero.control: 'gain'` (one ranked key, no pages — audioOut's shipped arrangement).
- **Pages/cells:** none declared. One cell: `gain`, `paramCells: { gain: 'fader' }` (a level is a
  throw; the shell cannot infer it).
- **Parity that must survive:** the device `<select>` with its `(no inputs)` / `(pick one)` states
  and positional label fallback; the 8-state status LED; the stereo|mono badge; `music mode`
  (persisted **and** re-acquiring); the `role="alert"` error line; ENABLE / RETRY PERMISSION /
  RETRY **on the tileBody too** — it is the only route to a first permission grant, and shipping it
  in `fullViewBody` alone is cameraInput's shipped regression; STOP.
- **Three card-only hooks that MUST move, or the module is silently dead:**
  `nodeAudioInput.adopt(id, engineCtx)` (the registry's `request()` returns IDLE without it, and
  `view()` reads idle forever); the initial `enumerateDevices` + `no-inputs-found` + auto-acquire;
  the `devicechange` subscription. Put the roster in an input-side twin of
  `$lib/audio/output-device.svelte.ts` and **move the legacy card onto it too**.
- **The irreversible hazard:** `request()` calls `#releaseTracks` FIRST, and
  `MediaStreamTrack.stop()` cannot be undone. Two mounted surfaces each auto-acquiring would tear
  each other's capture down mid-performance — the exact #1590 failure through a new door. Put
  auto-acquire on the REGISTRY as a per-node idempotent `ensureAutoAcquire` guarded on
  `state === 'idle'`, **and route `AudioinCard.svelte`'s `onMount` through it too** (the legacy card
  survives promotion in the docked rail and under `?shell=legacy`).
- **Subscribe at INIT, not in an `$effect`:** `AudioinCard.svelte:39-50` records, measured, that
  neither store sugar nor `$effect(() => store.subscribe(...))` delivered `ptzMidiVersion`-style
  updates and that working binds were riding incidental xyflow prop churn. A shell body has no such
  churn.
- **Blast radius:** `pinned-audioIn` is canvas-hidden and the 🎧 panel is its ONLY surface;
  `Canvas.svelte:2893-2899` already wires `workflowAudioInFace`, so declaring the `face` flips it
  for every user at once.
- **Tests owed:** **rewrite `e2e/tests/audio-input-survives-card-collapse.spec.ts`** — after
  promotion the lane tile's `tileBody` stays mounted, so collapsing the dock pane unmounts nothing
  and the whole spec goes vacuous while green. Its ACT must still reach a node with **no mounted
  surface**; if no such route exists on a faced module, **say so to the owner** rather than
  re-pointing at a gesture that unmounts nothing. Keep its positive control (delete the node ⇒
  `trackLive` false) verbatim. Add default-shell coverage of the 🎧 column
  (`workflow-audio-io-face.spec.ts` is the template; `workflow-audio-io-composite` VRT drives
  `?shell=legacy` and is structurally blind). New face spec: `adopt` happens from the face alone
  (probe `__nodeAudioInput` with no card anywhere), the tile's ENABLE reaches getUserMedia under
  the fake-mic project, device pick writes `node.data.deviceId`, music mode persists + re-acquires.
- **Guard the testid split:** `workflow-audio-io-face.spec.ts` uses
  `legacyOnly: 'audioin-device-select'` — the body must NOT reuse that testid.
- **VRT scope:** `GREP=audioIn`. Two new face scenes. **Guard the auto-acquire on `state === 'idle'`
  or a runner with a prior grant lights the lamp and animates the glyph.**
- **Shared files:** the spine, `face-rack-status-source.test.ts` (role `status-primitive`, must
  really import `StatusLed`), `vrt-exemptions.ts:702` (re-scope to the `?shell=legacy` card arm),
  `module-docs.generated.ts` via `docs:accept` (`audioin.ts:146` says "the card owns the permission
  flow"; `:115-118` describes a device filter that does not exist), new
  `$lib/audio/input-device.svelte.ts`.

#### 2b. ptzcam
- **Surface:** face + `fullViewBody` (`PtzcamDeviceBody.svelte`), role `status-primitive`.
- **Glyph:** `'none'` — verified forced (`outputs: []` ⇒ every literal is a dead static).
  ⚠ `glyph:'algorithm'` + `extension` would PASS the dead-glyph clause and paint an empty topo
  plate — do not.
- **Hero:** none.
- **Pages/cells:** two pages — `camera`: `['ptzcam-connect-{n}']`; `aim`:
  `['pan','tilt','zoom','slew']`. **CONNECT ranks first** (the module is inert twice over, and the
  compact lane cap is 3 — a rank below 3 loses the gesture from the tile, which is the whole reason
  midiclock made it a cell). Cell: `ShellActionCell`, mode `'trigger'`, probe
  `{effect:{kind:'audition', seam:'engine-message'}}` (no CI runner has a PT-PTZ helper, so a
  `connected` probe would be red on a live control). Declare `controlFamilies:
  [{ id:'ptzcam-connect', testidPrefix:'ptzcam-connect' }]` — the testid already exists at
  `PtzcamCard.svelte:119`, so **no card edit** is needed for module-docs-lint.
- **Parity that must survive:** the live PT-PTZ output-port roster (`fullViewBody` only — a
  `ShellSelectorCell.options` is a pure fn of the node and would be stale on an async MIDI grant);
  the 9-kind bind LED and its 9 distinct status sentences (deny-by-default resting text ⇒ lamp +
  `detail`/aria, but **carry the full sentence set**, not just hint+error); the `role="alert"` fault
  line; the four trim knobs with `paramSpec` ranges.
- **The tri-state mode line is the correction the plan must not skip.** `axisModeLabel` returns
  `'abs' | 'vel' | '—'` and the row is HIDDEN while `caps` is null. Three boolean `StatusLed`s
  cannot express that: pre-bind (all dark) would be pixel-identical to a bound NexiGo (all dark),
  i.e. the face would assert "all three axes absolute" about a module that knows nothing yet.
  Render the lamp block inside `{#if status.caps}` with `lit = mode === 'vel'`.
  This matters because the axis mode is **the semantics of every other control** (position vs rate,
  and whether SLEW does anything).
- **Reactivity:** `PtzcamCardApi` has **no push seam** (unlike `MidiclockApi.subscribe`). The body's
  only live source is the module-level `ptzMidiVersion` store, and `PtzcamCard.svelte:40-51` records
  the measurement that `$effect(() => store.subscribe(...))` did **not** deliver. Subscribe at INIT
  with `onDestroy(store.subscribe(...))`. And **never mutate from a read path** —
  `ensureBinding()` from a `$derived` throws `state_unsafe_mutation` and poisons the deriveds.
- **`ptzcamConnect` is not a copy of `midiclockConnect`:** carry `PtzcamCard.svelte:89-98`'s
  fallback to app-level `connectPtzMidi()` when the handle is not yet built (a measured "frozen at
  idle forever" bug), call `api.connect()` **synchronously** (an `await` before
  `requestMIDIAccess` spends the user activation), and record the audition honestly on both
  branches.
- **Also:** route `selectPort` through `mutateNode` (or tag `writeDeviceSelection` with
  `LOCAL_ORIGIN`) so picking a camera reaches Cmd-Z; keep the `(offline)` synthetic option.
- **Tests owed:** a face leg in `e2e/tests/ptzcam.spec.ts` re-using the existing `connectAndBind`
  helper against the promoted surface (all ptzcam assertions and the VRT scene run
  `?shell=legacy` today, and the `__annotated__` legend directory holds only adsr and lfo, so
  **nothing in the tree can fail on a dropped ptzcam affordance**).
- **VRT scope:** `GREP=ptzcam`. Two new face scenes; deterministic at rest (`listPtzOutputNames()`
  is `[]` with no grant and page load never requests access).
- **Shared files:** the spine, `shell-cells.ts` (one block), `contract-lock.txt` +
  `module-docs.generated.ts` via `task docs:accept -- ptzcam` (controlFamilies ARE projected into
  the contract signature), `face-rack-status-source.test.ts`.

#### 2c. textmarquee
- **Surface:** face + `fullViewBody` (`TextmarqueeEditorBody.svelte`), role `picture`.
- **Glyph:** `'none'` — verified forced (only a `video` output ⇒ `primaryAudioOutPortId` null ⇒
  every other literal is a dead static). The tile picture comes from `hasVideoSurface`.
- **Hero:** none.
- **Pages/cells:** ONE band, four knob cells `['posX','posY','scrollX','scrollY']`. **No `xyPads`**
  — the card draws four dials, and declaring a pad would halve the lane for nothing and invite the
  zero-control denial. Optional `face.rear.groups` for the four CV jacks.
- **PRECONDITION — do this first, in its own reviewable commit:** the DOM↔model serializer
  (`styleOfNode`, `rgbToHex`, `alignOf`, `runsFromNodes`, `runsFromBlock`, `isBlock`,
  `serializeEditor`, `applyModelToDom`, `TextmarqueeCard.svelte:114-263`) is **~150 lines private
  to the card** — `textmarquee-layout.ts` has **no serializer**, only coerce/truncate/layout. Worse,
  it reads `getComputedStyle`, so the card's `.editor` CSS (`color:#ffffff` at :560,
  `white-space:pre-wrap` at :562, inherited weight/style/decoration/align) is **part of the
  persisted document's semantics**. Re-host that `contenteditable` under `.dock-ext-body` (which
  sets none of them and inherits `var(--text,#eef1f5)`) and every untouched run silently serializes
  the wrong colour, an ancestor `font-weight ≥ 600` stamps `bold:true` on every run, and an
  ancestor `text-align:center` stamps `center` on every paragraph — written into Y.Doc-persisted
  `node.data.richText` and read back by the still-live legacy card. Extract the serializer into a
  shared module **outside `lib/video/**`** (the `$lib/graph/picturebox-data` precedent), have both
  surfaces call it, and set the editor's colour/weight/style/decoration/align/white-space
  **explicitly on the element** in both places rather than by inheritance.
- **Parity that must survive:** the contenteditable + its 250 ms debounce **with an unmount flush**
  (the dock LRU-evicts a pane at the third expand); align/B/I/U (they act on a live DOM Selection,
  so they can only live beside the editor); the per-selection TEXT colour; the FONT `<select>`
  (12 entries) and the SIZE range — both write through `persistModel(serializeEditor())`
  **undebounced**; the layer BACKGROUND colour; the empty badge; the preview.
- **Also boy-scout in the same PR:** teach `TextmarqueeCard` to honour `previewCollapsed` (it blits
  unconditionally today, against the fleet rule), and bind the four knob ranges with
  `paramSpec(textmarqueeDef, id)` instead of the re-typed `min={0} max={1}` literals.
- **Cosmetic diff to flag:** the card's captions are `SCRLX/SCRLY/POSX/POSY`; the def labels are
  `ScrlX/ScrlY/PosX/PosY`. The face paints the DEF label — accept it, do not re-type the card's
  casing.
- **Tests owed:** a default-shell spec that types into the BODY editor and asserts the persisted
  runs carry the expected colour / bold / align — the only thing that can catch the CSS-inheritance
  corruption. (`textmarquee.spec.ts` and `-render-smoke` both boot `?shell=legacy` and survive
  unchanged, proving nothing.)
- **VRT scope:** `GREP=textmarquee`. Two new face scenes; the legacy card scene is untouched.
  ⚠ **Capture risk:** the dock scene's preview is the factory's `textmarquee` placeholder — system
  font glyphs inside a GL texture, the exact nondeterminism `vrt-exemptions.ts:192-197` already
  names for this module. **Measure two-boot pixel identity on the Linux runner before pinning**;
  the honest fallback is `FACES_WITHOUT_SCENES` with the measured number, not a mask.
- **Shared files:** the spine, `face-rack-status-source.test.ts`,
  `face-screen-render-suite.ts` SUBJECTS.

---

### WAVE 3

#### 3a. videobox
- **Surface:** face + `fullViewBody` (`VideoboxScreenBody.svelte`), role `picture`.
- **Glyph:** `'none'` — a real CHOICE, not forced: videobox declares `audio_l`/`audio_r`, so any
  other literal resolves `{kind:'live-audio', portId:'audio_l'}` and would paint a VU of the film's
  soundtrack where the module's own picture belongs, with the dead-glyph clause silent. The picture
  comes from `hasVideoSurface`.
- **Hero:** none (the body takes the dock head).
- **Pages/cells:** ONE band, one cell: `gain`, `paramCells: { gain:'fader' }` (unity at the
  midpoint of a 0..2 throw). `cv_play_trigger` → `noUserControl`, writer `'cv-port'` (the only legal
  value — `play_trigger` declares `paramTarget`). Name the side effects in the PR body: a
  `noUserControl` param also drops off `listExposableControls` and the Push 2 card.
- **THE STOP-2 — the File System Access handle acquisition.** `showOpenFilePicker` and
  `getAsFileSystemHandle` appear in exactly two files in `packages/web/src`
  (`VideoboxCard.svelte`, `VideoVarispeedCard.svelte`) and are honoured only inside a real user
  gesture — component-only **by construction**. The native `<input type=file>` cannot hand back a
  `FileSystemFileHandle`, so a body built on the picker alone would: never persist a handle, never
  restore a file on rack reload (the card header calls that restore "the headline of this
  conversion"), never set `pendingHandleName`, and therefore render the **re-allow overlay as
  permanently unreachable dead code** while `docs.explanation` promises it works. **Port
  `pickViaPicker`/`onPickClick` and the drop-path `getAsFileSystemHandle` branch verbatim**; the
  `<label>` wrapping `videobox-file-input` must carry `onclick={onPickClick}`, and the re-link
  overlay must stay a real `<label>` + `videobox-relink-input`. Pin it with a source assertion in
  the module's face-model test.
- **Three more the plan must carry:** `attachRenderLease` (measured on backdraft: presenting +
  scrolled off-screen drew **0 frames over 143 engine frames**); the resize grip writes
  **`node.data.width` / `height`** — the card's own keys, **not** `resizedWidth/resizedHeight`
  (those are graphicEq/milkdrop/monoglitch keys, and using them ignores every saved rack's size);
  and the seek thumb needs a position source — `VideoSourceStatus` publishes no position or
  duration, so derive it in the body's rAF (element `currentTime` when a local file is loaded, else
  `lastSyncPosition + elapsed` clamped to `fileMeta.duration`).
- **Never adopt the node-owned `<video>`** (one parent per DOM node; the legacy card adopts it under
  `?shell=legacy` or a dock-rail mount). Blit `blitOutputForPreview` — also strictly more honest,
  because it shows what `gain` does.
- **Parity that must survive:** drop-and-drop, the re-link and re-allow overlays, fullscreen +
  display picker, FULL FRAME on the **same `node.data.fullFrame` key**, the right-click
  `VideoCanvasContextMenu`, the load-error line, the filename, `videobox-file-input` and
  `videobox-play-btn` testids (`collapse-keeps-playing.spec.ts:616-617` derives enrolment from
  them — drop either and the sweep SKIPS, green and blind).
- **Deletions to name at preview:** the `0:04 / 2:00` readout (position survives on the slider +
  aria-valuetext); the rack-tile resize (dock-only now); fullscreen becomes a 1024×768 engine
  readback rather than the native-res `<video>` — a visible downgrade on a documented feature.
- **Boy-scout:** `VideoboxCard.svelte:428-433` and `:470-477` write `node.data` **bare** (no
  `ydoc.transact`, no `LOCAL_ORIGIN`), so Full Frame and resize are outside Cmd-Z today.
- **Tests owed / repairs (this PR carries the shared repair):**
  - `e2e/tests/collapse-keeps-playing.spec.ts:593,:628` — re-point the dock-scoped `<video>` queries
    document-wide (the file's own `liveMedia` helper at :186) **and add the negative leg**: the
    element found for a FACED member is NOT inside the dock pane.
  - `e2e/tests/node-source-videobox.spec.ts:256` — same query.
  - `e2e/tests/workflow-shell-video.spec.ts:1433` — lane tile `module-shell-placeholder` →
    `module-shell`.
  - `e2e/tests/video-full-frame.spec.ts` — keep the legacy leg, ADD a default-shell leg, assert both
    read the same `node.data.fullFrame`.
  - New spec **named `face-videobox.spec.ts`** — `videobox-*.spec.ts` matches a WEBGL_HEAVY glob and
    would land in the heavy lane.
- **VRT scope:** `GREP=videobox`. Two new face scenes; the card exemption stays. Deterministic with
  no `simPin`: an unloaded node paints the constant idle gradient.
- **Shared files:** the spine, `face-rack-status-source.test.ts`, `collapse-keeps-playing.spec.ts`
  (**the pairing constraint**), `node-source-videobox.spec.ts`, `workflow-shell-video.spec.ts`,
  `video-full-frame.spec.ts`, `module-manifest.ts` (docs:accept).

#### 3b. controlSurface
- **Surface:** face + `fullViewBody` (`ControlSurfaceBoardBody.svelte`) **and** `tileBody`
  (`ControlSurfaceTileBody.svelte`).
- **Glyph:** `'none'` — verified forced (`inputs: []`, `outputs: []` ⇒ every literal is a dead
  static).
- **Hero:** none (a `hero.cell` must resolve to a PF-14 panel, and the board is a body — its width
  is a function of how many sources are bound, so `ShellPanelCell.minWidth` cannot be supplied
  honestly).
- **Pages/cells:** ONE cell — `control-surface-lock-{n}`, a `ShellToggleCell` over
  `node.data.locked` via `readSurfaceData`/`setSurfaceLocked`, behind a one-member
  `controlFamilies` entry whose `testidPrefix` (`control-surface-lock`) is **already a card
  literal**, so module-docs-lint passes with no card edit. A toggle is not dock-restricted, so it
  reaches the lane tile.
- **PRECONDITION:** **remove `'controlSurface'` from `NON_SHELL_LANE_TYPES`** — membership
  short-circuits `laneRenderKind` before `migrated` is read, so membership and promotion are
  mutually exclusive by construction. This flips the lane for every existing controlSurface in
  every saved patch at once.
- **THE STOP-2:** `pruneSurfaceDangling` has exactly ONE production caller — the card's `$effect`
  (`ControlSurfaceCard.svelte:88-92`) — and controlSurface is in **neither** half of
  `HEADLESS_MOUNT_LANE_TYPES`, so promotion silently stops it with every registry test green
  (the ES-9 shape). **Put it in the `tileBody`, not the `fullViewBody`** — the tile mounts on every
  lane tile at every LOD; the body mounts only while the dock is open. Assert it in the new e2e
  **with the dock CLOSED**.
- **Parity that must survive:** per-source group boxes with live display names; the passthrough
  colour stripe read from the SOURCE module; proxied Knobs wired through `resolveSurfaceParam` +
  the engine `liveReader` (MIDI keying, the CC badge, the right-click MIDI-learn / "Remove from"
  menu ride along free); the per-knob ✎ rename `<input type="text">` — **which must live in the
  file DIRECTLY imported as `fullViewBody`**, because the typed-entry parity resolver regexes
  `fullViewBody: X` then `import X from './…'` and reads only that one file; group drag with
  `node.data.layout` absolute px; the empty-state prompt naming the right-click "Send to <name>"
  gesture (the module's only discovery path).
- **Reproduce `cardVersion`.** `ModuleShell` re-projects a cell on `nodeVersion(id)` alone; the
  card's bounded pump also sums `nodesStructuralVersion()` and `nodeVersion` of every bound SOURCE.
  A body that omits it renders a board that never notices a source rename, colour change or value
  move — and a `node.data`-level unit test passes on it.
- **Pass every proxied Knob an explicit `testid` override.** `Knob.svelte:315` emits
  `control-<paramId>` whenever `paramId` is passed, and faces-parity asserts **exact multiset
  equality** against the def's params — which is `[]` here, so one bound proxy fails the whole face.
  ⚠ **`ElectraGridBody.svelte:286-298` already omits it** — a live latent failure in a shipped face,
  green only because the sweep never binds a slot. Fix both in this diff.
- **State in the PR body, do not let a reviewer find it:** a USER-DOCKED controlSurface keeps
  mounting the verbatim legacy card in the dock rail after promotion (`dockRailRendersFace`
  requires `pinned`, and controlSurface is not in `WORKFLOW_PINS`), and it is `DYNAMIC_SIZED`, so
  the free-growing board survives promotion unmodified there. Also: with 3+ surfaces,
  boards 3..N are one Expand away and evict each other at `MAX_FULLVIEW_PANES = 2`.
- **Tests owed:** a new default-shell face spec (lane tile is a `module-shell` painting LOCK;
  toggling LOCK from the TILE flips `node.data.locked`; Expand → a proxied knob writes the SOURCE
  node's param; ✎ rename writes `binding.name`; **the prune runs with the dock CLOSED**). All six
  existing controlSurface specs drive `?shell=legacy` and stay green while covering nothing.
- **VRT scope:** `GREP=controlSurface`. Two new face scenes (a solo surface has no bindings, so both
  are deterministic); **drain the anchored `EXEMPT_FROM_VRT` + `ALLOWED_PERMANENT_EXEMPT` entries in
  the same commit** — they are red in both directions.
- **Shared files:** the spine, `legacy-fallback.ts` (NON_SHELL_LANE_TYPES + the carve-out prose),
  `shell-cells.ts`, `contract-lock.txt` + docs via `task docs:accept`,
  `face-rack-status-source.test.ts`, `vrt-exemptions.ts` (both lists),
  `strict-faces.ts:4587` and `:4718-4741` + `_face-fixtures.ts:347` prose.

#### 3c. joystick
- **Surface:** face + `tileBody` (the live pad on the lane) + `fullViewBody` (the dock pad).
- **Glyph:** `'none'` in the recommended route. ⚠ The *recon's* claim that no glyph rescues joystick
  is **REFUTED**: `glyphBinding` resolves the `'algorithm'` branch **before** the audio-out
  short-circuit, and the #2160 widening accepts a `face.extension` id with `paramId: null` — `pong`
  ships exactly that shape today with two `gate` outputs and no audio out. That is the fallback.
- **Hero:** none.
- **Pages/cells:** `order: ['pos_x','pos_y']`, `xyPads: [{ x:'pos_x', y:'pos_y', label:'position' }]`.
- **Route (build this):** **Path B** — `glyph:'none'` + `tileBody` painting the card's real 160 px
  pad on a 192 px lane tile (`SHELL_TILE_W = 192`, `PAD_PX = 160`: the pad fits **unshrunk**,
  precision and gesture intact — `laneOrder`'s 46 px `--kcol-max` argument is about the PLATE grid
  and never reached this slot) + `fullViewBody` for the dock. Then the ONE judgement call, flagged
  explicitly in the PR body: **`module-face-lint.test.ts`'s lane-paints-something clause counts
  `curatedFace().controls.length` and cannot see a `tileBody`.** Teaching it to skip a def whose
  declared `face.extension` directory really exports `tileBody` — read off the directory exactly as
  `face-xy-body-source.test.ts` already does, in the same lane — is a **predicate correction inside
  an existing test**, not a new gate. Prefer the STRONGER form (require the tileBody source to name
  both ranked axes). The `:3168` negative control keeps firing (its fixture declares no extension);
  add a second negative control asserting a tileBody-bearing fixture is skipped.
- **Fallback if the owner declines the predicate correction (Path C, zero gate edit):** declare
  `glyph:'algorithm'` + `extension:'joystick'` whose glyph slot draws the pad frame + crosshair at
  rest (pong's court-at-rest contract). `laneGlyphFor` → `'trace'` skips the clause legitimately,
  **and the `tileBody` still paints the live pad.** Cost: a small rest-frame glyph above the live
  pad on one tile. Note honestly that an extension glyph is byte-identical per node
  (`ShellExtensionGlyphProps` carries no `nodeId`, `topologyValue` is hardcoded 0), so it can draw
  identity, never position.
- **`fullViewBody` is MANDATORY once `tileBody` exists:** `extBody` is null when no `fullViewBody`
  is declared, so a `tileBody` alone would paint at the dock too — two pads on one node. Nothing in
  the unit lane sees this; it is browser-only.
- **`tileBody` must NOT emit `control-<paramId>` or `data-control-params`** — the lane tile and the
  dock full view can be open at once. Use `CameraInputTileBody.svelte:25`'s explicit `testidPrefix`.
- **Parity that must survive:** jump-to-point on pointerdown, pointer capture, Y flip, rAF-coalesced
  commits with flush on pointerup, `lostpointercapture` recovery, double-click re-centre to 0/0,
  the dot + `.active` glow, the crosshairs, `nodrag`, and disposal of both drag commits. The face
  **GAINS** per-axis MIDI/Electra assign the hand-rolled card lacks. The resting-decimal readout is
  deleted by owner ruling (#2038 removed it from the primitive; values live in `aria-label`) — this
  is compliance, not a parity gap.
- **Also closed, so nobody re-tries them:** `order: []` (completeness sweep), `surface:'body'`
  (dock-only, `types.ts:768-772` says so by name), `NON_SHELL_LANE_TYPES` (mutually exclusive with
  promotion), and `noUserControl` (would compile, but its `why` must name who writes the param
  instead — here it is the PLAYER, so it would be a knowing falsehood, and it would strip both axes
  from the group instrument bar and Push encoders).
- **Tests owed:** `e2e/tests/joystick.spec.ts` gains a DEFAULT-shell leg (`rackDefault`) that drags
  the tile pad and polls `__patch.nodes[id].params.pos_x/pos_y`, asserting the value **stayed after
  release**; keep the legacy legs. New `joystick-face-model.test.ts` (already promised by name at
  `joystick-persist-model.test.ts:22-23`).
- **VRT scope:** `GREP=joystick`. Two new face scenes; **drain the `vrt-exemptions.ts:1062` entry
  and the pinned list at `:1517` together** — anchored in both directions.
- **Shared files:** the spine, `vrt-exemptions.ts` (both), `module-face-lint.test.ts` (Path B only —
  the one shared file not to touch without the owner's nod), `face-xy-body-source.test.ts:58-60`
  prose, `joystick.ts:165-170` prose, `JoystickCard.svelte` header prose.

---

### WAVE 4

#### 4a. videovarispeed
- **Surface:** face + `fullViewBody` (`VideoVarispeedTransportBody.svelte`), role `picture`.
- **Glyph:** `'none'` — a CHOICE (audio outputs exist), and the right one: the shell branches
  `videoThumb` before `glyphKind`, so any trace literal would never paint.
- **Hero:** none.
- **Pages/cells:** two pages — `transport`: `speed` + (optionally) the play/loop cells; `window`:
  `start`, `end` (`paramCells: 'fader'` for start/end only). **Do NOT declare
  `paramCells:{speed:'fader'}`** — the card draws speed as a `<Knob>`; substituting the primitive is
  a look change on the headline control, not parity. Nine synthetic CV/gate params →
  `noUserControl`, writer `'cv-port'` (each anchored by its own `paramTarget` port).
  **Recommended: put play + loop in the BODY, not in cells** — that avoids the `controlFamilies`
  contract diff entirely. If the owner wants them on the lane tile, declare
  `videovarispeed-play-{n}` (action, probe `{kind:'data', key:'isPlaying'}`) and
  `videovarispeed-loop-{n}` (toggle over `node.data.loop`) and pay `docs:accept` +
  contract-lock review.
- **THE STOP-2, and it is bigger than "move two calls":** the card's `$effect` on
  `fileMeta.handleId` → `tryReloadFromHandle` → `loadFile` → `loadFileIntoSlot` is the **documented
  delivery mechanism for three writers outside the module**: the Loaded-Assets picker spawn
  (`asset-spawn.ts:26-31, 198-215`; videovarispeed is the module spawned for EVERY video asset),
  `runAssetRebindSweep` (`asset-spawn.ts:405-410`), and the perf-zip restore
  (`Canvas.svelte:3737-3785, 3863-3879`). `node-varispeed-registry.ts` has **no import of
  `video-file-store` or `video-export-registry`** and cannot load bytes at all. So: **move
  `loadFileIntoSlot` ITSELF into the controller**, widening `VarispeedMedia` past
  `ensure`/`mediaName` and adding a `{kind:'loadFile'}` command the body originates; re-point
  `registerVideoExport`'s `resolveAllSlotBytes` there too. Putting the restore in the
  `fullViewBody` instead — the obvious shortcut, since the body needs the loader anyway — makes the
  asset picker's PRIMARY video flow silently do nothing until a human opens the dock.
  (Both are **already dock-gated on main**: with no headless host the card mounts only while the
  dock full view is open. This is a repair, not a promotion regression — say so.)
- **Parity that must survive (body):** the seek scrubber (no cell kind scrubs a playhead); the
  `showOpenFilePicker` handle capture + drag-drop + re-link prompt + one-click re-allow + the
  per-slot loader with its 100 MB cap and first-frame decode; the 7-slot bank with C..B tags,
  names, clears, click-select and active highlight (the card's whole-card `oncontextmenu` opener
  must be replaced with an explicit one — right-click is claimed per-control by
  `ControlContextMenu`); the crop add/edit/remove row and the dragged aspect-locked overlay;
  **the crop ASPECT-REFIT `$effect`** (re-fits and re-persists the stored rect on a 16:9↔4:3 flip —
  a persistence-correctness effect, best moved into the controller beside the existing crop push);
  SCREEN ON/OFF over `previewCollapsed`.
- **Paint these in the BODY, never via a `ParamDef.format`/`landmarks` edit** (which would move the
  WebGL attest hash on an in-basis def): the −4×/+1×/+4× speed multiplier, the
  "START past END — no playback" warning (the only diagnostic for a transport that genuinely
  halts), the time readout and the active filename.
- **Tests owed:** name it **`e2e/tests/varispeed-face.spec.ts`** — `videovarispeed-*.spec.ts`
  matches a heavy glob **whose lane was DELETED**, so that name would run in NO CI job and be green
  forever. Legs: SCREEN both ways with the node still in the pull set; load + play + seek from the
  face with no card mounted; two slots switched via the ASSET gate; crop from the face asserted
  through `read('cropActive')` + a downstream pixel; **the repair** — "Export performance" carries
  videovarispeed bytes with no card ever mounted; a reloaded rack restores slot 0 from the
  remembered handle with no card. Retire `e2e/tests/varispeed-panel-layout.spec.ts` (videovarispeed
  is its last row; its own header pre-argues the retirement) — and say so, it is a real coverage
  decision.
- **Rebase note:** this PR lands **after** videobox's `collapse-keeps-playing.spec.ts` repair.
- **VRT scope:** `GREP=videovarispeed`. Two new face scenes; the card exemption stays. The scene is
  deterministic **only because it is empty** — never load a fixture into it; state that in
  `videoFaceWhy`.
- **Shared files:** the spine, `face-rack-status-source.test.ts`, `shell-cells.ts` (only if the
  families ship), `contract-lock.txt` (same), `node-varispeed-registry.ts` +
  `node-varispeed.svelte.ts` (+ its test), `asset-spawn.ts` and `Canvas.svelte` prose,
  `varispeed-panel-layout.spec.ts` (deleted).

#### 4b. mappy — **the attest window**
- **Surface:** face + `fullViewBody` (`MappyMapBody.svelte`), role `picture`.
- **Glyph:** `'none'` — verified forced (no audio output ⇒ every literal is a dead static). The
  picture comes from `hasVideoSurface` → `laneGlyphFor` `'picture'`. **Assert those, never the
  literal.**
- **Hero:** none.
- **Pages/cells:** two pages — `surfaces`: `surfaceCount`, `showGrid`; `map`:
  `mappy-import-map-{n}` (ShellFileCell, `accept:'application/json,.json'`),
  `mappy-export-map-{n}` (ShellActionCell, probe
  `{effect:{kind:'audition', seam:'file-export'}}` — the samsloop precedent).
- **The two param corrections are the whole GPU cost, and they are load-bearing:**
  `showGrid` and `surfaceCount` move `curve: 'linear'` → `'discrete'` so `showGrid` resolves a
  Toggle instead of a 200 px continuous drag over a two-state override, and `surfaceCount` snaps to
  integers. `curve` **is** in the contract signature (`contract-signature.ts:76, :223`), so this is
  `docs:accept` + contract-lock review **in addition to** the GPU re-attest.
  `frametable.ts:469-480` is the in-tree precedent and calls the correction FUNCTIONAL. Skipping it
  to dodge the attest is exactly the trade that shipped that defect the first time — and **no gate
  fires**: module-face-lint's switch-classification leg only reaches params that are already
  `0..1 discrete`.
- **THE INERT-CONTROL TRAP — ship green and broken if you fix only half.** The factory PREFERS
  `node.data` over the params for BOTH (`mappy.ts:500-504`, `:506-510`) while every generic param
  cell writes the param alone. On a fresh node the face works; on any node the card, a map import
  or a `?shell=legacy` collaborator has touched, `node.data` carries the key and the faceplate's
  GRID toggle and SURFACES knob are **DEAD**. Every def-reading gate stays green (the params exist,
  the cells render, faces-parity's `readParam` oracle sees the param move) — the engine ignores it.
  **Do both:** (a) delete the `node.data` preference in the factory so params are the single source
  of truth, **and repoint every READER too** (`MappyCard.svelte:92-94`,
  `MappyEditor.svelte:51-53`, `mappy-edit.ts:57-60`'s `getSurfaceCount`, which reads `node.data` and
  never falls back to the param); (b) register `SHELL_PARAM_WRITES.mappy.surfaceCount` delegating to
  `addSurface`/`removeSurface` so a newly-live surface still drops in as `insetQuadForIndex` rather
  than a full-frame duplicate. **`showGrid` needs the same symmetric treatment** — otherwise the
  face's GRID cell writes the param, the MAP editor reads the mirror, and the editor's bar reads
  "GRID OFF" over a screen full of grid while its first press is a no-op.
- **Parity that must survive (body):** the composite preview and the corner-pin SVG (hit-test via
  `mappy-hit`, `editSetCorner`/`editMoveSurface`); the whole-surface move drag; surface select; the
  per-surface FIT/CROP toggles and RESET (six independent booleans — a controlFamily template is
  ONE cell with no per-member index, so they cannot be cells); the MAP ⤢ button mounting the
  existing `MappyEditor`; the import/export status feedback (the shell paints a status line for a
  FILE cell only — the ACTION cell's export outcome needs a perceivable home);
  the empty-state hint; a visible surface count (a 1..6 discrete knob with no options/landmarks/
  format paints **no readout**, so the lane tile shows a dial with no number); and **the edges
  observer** — a card-local `ydoc.getMap('edges').observeDeep` bridge that is NOT in
  `mappy-edit`/`mappy-hit`/`mappy-map-io`, so "reuse them verbatim" does not carry it, yet
  `hitTestSurfaces`, `live[]` and `MappyEditor`'s `connected` prop all depend on it.
- **SCREEN OFF must keep blitting.** mappy is a mid-chain compositor feeding a projector, and
  `markWatched` happens only inside `blitOutputForPreview` — an OFF branch that stops the call
  blacks out the projector. Copy quadralogical's collapsed branch, not a naive `{#if !collapsed}`.
- **Tests owed:** a body spec proving the corner pin still commits from the FACE (drag a handle in
  the dock body, assert `node.data.surfaces[0].corners` moved); a `SUBJECTS` row in
  `face-screen-render-suite.ts`; **re-point `e2e/tests/dock-tray-shrink-to-content.spec.ts:104-119`**
  at another un-migrated module (see §5.1 on `toybox`). `mappy-output.spec.ts` and
  `mappy-export-import.spec.ts` are `?shell=legacy` and survive unchanged.
- **VRT scope:** `GREP=mappy`. Two new face scenes, deterministic with no `simPin` (nothing patched
  is surface 0's numbered calibration grid, which `mappy.ts:333` states has no time dependence) —
  which also makes `vrt-exemptions.ts:1229` false; correct it in the same diff.
- **Attest discipline:** regenerate the pin **LAST**; confirm only the `.sha`/hash moved; measure
  against the **MERGED** tree, never the dirty primary checkout. Amortize the window with
  gibribbon's merged-tree attest (§3.6) if the timing lines up.
- **Shared files:** the spine, `shell-cells.ts`, `shell-param-writes.ts` (its second entry ever),
  `face-rack-status-source.test.ts`, `face-screen-render-suite.ts`,
  `dock-tray-shrink-to-content.spec.ts`, `vrt-exemptions.ts:1229`, `contract-lock.txt`,
  `ci-webgl-attest/<hash>.json`.

#### 4c. peertube
- **Surface:** face + `fullViewBody` (`PeerTubeBrowseBody.svelte` mounting a shared
  `PeerTubePicker.svelte` that the LEGACY CARD also mounts — this module has a documented history of
  correctness travelling by hand-copy, the `muted = false` audio trap).
- **Glyph:** `'none'` — a CHOICE (peertube has `audio_l`, so any other literal resolves live and the
  dead-glyph clause would stay silent while a soundtrack meter competed with the picture).
- **Hero:** none.
- **Pages/cells:** ONE band, one cell: `gain`, `paramCells: { gain:'fader' }` — honest on arrival,
  `uGain` is declared and pushed every draw. `cv_play_trigger` and `cv_next_trigger` →
  `noUserControl`, writer `'cv-port'`.
- **The body is LOAD-BEARING, not additive:** peertube is not in `DOM_SOURCE_LANE_TYPES`, so there
  is no `HeadlessSourceHost` and under the shell **no card is mounted anywhere** — without the body
  peertube could not be searched at all.
- **Parity that must survive:** the search input **with its ~50 calls/10 s Sepia rate limiter** and
  its refusal message (keep the limiter AND the message — a held-down key must not be a silent
  no-op); `↻ next`; the results roster with thumbnails, channel@host·duration, selection highlight
  and `scrollIntoView`; the play/pause + playhead; the loading / "display unavailable — skipping" /
  "search, then pick a video" overlays; the error and status lines; **the per-video attribution
  ANCHOR** to `https://<host>/w/<uuid>` (see §5.7); the PeerTube / Sepia legal disclaimer; the
  onMount rehydration of `searchTerm` from `node.data` (without it a reloaded rack shows an empty
  box while the persisted term still drives `advance()`'s on-demand fetch).
- **Delete the DEAD `instanceHost` control** (input + `PeerTubeData` field + write) and correct
  `peertube.ts docs.explanation` + `module-manifest.ts:319`, which both claim it scopes the search.
- **Never adopt the node-owned `<video>`;** blit. Pass node.data **LEAVES** to the shared picker,
  never the enclosing `data` object (the Yjs proxy-identity trap: passing `data` fixes the card and
  silently breaks the body, and the two failures look identical from outside).
- **Tests owed:** a new default-shell face spec (name it so it matches no heavy glob; the file's own
  neighbours warn that `peertube-*` is heavy — that prose is stale for the current glob list, but
  verify with minimatch rather than trusting either). ⚠ Use a **ONE-RESULT mock** for any
  "which video is playing" claim: a multi-row fixture races the module's own unavailable
  auto-skip, which is what reddened tvLibrarian's CI and passed locally three times over.
- **VRT scope:** `GREP=peertube`. Two new face scenes; the card exemption stays. **No `simPin`
  needed** — the idle shader branch is a pure function of `vUv` and `autoLoadCatalogue` is
  **false**, so a fresh spawn issues zero network requests (stronger than tvLibrarian's case).
- **Shared files:** the spine, `face-rack-status-source.test.ts`, `_face-fixtures.ts:123-125`
  (delete the DENIED entry BY HAND — promotion makes it invisible, not red; this would be the third
  instance), `module-manifest.ts` (docs:accept), `workflow-shell-video.spec.ts` if peertube has a
  row.

---

### WAVE 5

#### 5a. recorderbox — **build the `order: []` / tileBody variant**
- **Surface:** face + `fullViewBody` (`RecorderboxBody.svelte`, role `picture`) + `tileBody`.
- **Glyph:** `'none'` — verified forced (recorderbox's audio ports are **inputs**, and
  `params: []`, so every branch falls through to a dead static). The picture comes from
  `hasVideoSurface`.
- **Hero:** none.
- **Pages/cells:** **`order: []`** — the videoOut shape. **Do NOT ship RECORD as a
  `ShellToggleCell` and do NOT ship SIZE as a `ShellSelectorCell`**, for two independent reasons:
  1. **Neither cell kind can express `disabled`.** `ShellToggleCell` declares only
     `label`/`value`/`onchange`, and `Toggle.svelte`'s Props has **no `disabled` at all** — so a
     promoted lane tile would paint a live-looking RECORD switch on a machine that cannot encode
     H.264, which the module's own e2e records as a real CI condition. And SIZE's `disabled`
     attribute is the **sole guard** on a mid-take quality change (`onQualityChange` has no
     `recState` guard), so dropping it lets the face read SMALL over a running HIGH take.
     `Selector.svelte` HAS `disabled`; `ShellSelectorCell` cannot reach it.
  2. **faces-parity CLICKS every toggle cell.** Enrolling RECORD would make CI press it on a real
     recorderbox — folder prompt, encoder probe, `nodeRecorder.start`, `acquireRenderLease`, a
     full-canvas `drawImage` + `recorder.frame()` every frame on SwiftShader — and **nothing ever
     calls `stop()`**, because the registry deliberately exposes no teardown. The assertion is racy
     too (every `setData('recording', false)` revert flips `aria-checked` back).
  The `tileBody` owns its own markup, its own disabled state and its own REC/elapsed readout, and
  faces-parity does not press it. **This also drops the contract diff to zero.**
- **PRECURSOR, its own reviewable commit:** move the transport `$effect` (the ONLY reactor to a
  Y.Doc-synced `data.recording` flip — port the effect, not just the functions, or you lose the
  peer-flip and load-with-recording=true paths), the ~120-line start orchestration,
  `probeEncoders`, `listRecoverable`, and an origin-tagged `setData` into
  `packages/web/src/lib/ui/modules/recorderbox-transport.ts` — **`lib/ui`, never `lib/video`**
  (`recorderbox-present-policy.ts:13-17` states the rule; `lib/video/**` is the attest basis, nine
  recorderbox files wide). Both the legacy card and the face call it. This touches the code path
  that writes the user's file, and #1574 was a P0 in exactly this area — split it if the face PR
  would otherwise be large.
- **Parity that must survive:** the crash-RECOVERY block **first** in the body (the only thing here
  with unsaved user data behind it, and absent at rest so the idle baseline stays deterministic);
  the live preview + SCREEN ON/OFF (frametable's idiom: OPEN calls `blitOutputForPreview`,
  COLLAPSED still calls `markWatched`); the REC and SAVING lamps with elapsed / chunk / folder on
  `detail` → aria-label+title, never a text node; the FILE `<input type="text">` + `.mp4` caption
  (**this is also what discharges the typed-entry parity leg** — do NOT make it a
  `ShellEntryCell`: that kind forbids clamping and the shipped save path *sanitizes*
  (`recorderbox-store.ts:120-139`), so an entry cell's rejections would disagree with the file
  actually written); the DIR PICK/CHANGE button (the folder handle is deliberately kept OUT of
  `node.data`, so no `ShellActionProbe` can observe it); both capability badges; the transient
  folder hint.
- **SCREEN OFF cannot reach the encode here** — the take runs on the registry's own pump under an
  `acquireRenderLease` that bypasses both preview gates. Say so in the `EXTENSION_BODY_ROLES` `why`;
  it is a stronger guarantee than a correctly-ordered toggle.
- **Port labels:** the def declares no `PortDef.label`, so the rail derives `AUDIO L`/`AUDIO R` (or
  one collapsed `AUDIO` jack) instead of the card's `IN / A·L / A·R`. `PortDef.label` is **not**
  hash-transparent on a video def — accept the derived names; do not spend a GPU window on prose.
- **Blast radius:** `Canvas.svelte:1759-1795` auto-spawns a recorderbox into the video zone of every
  fresh workflow rack, wired to the master buses. Any defect here is live on every rack from the
  first boot. Owner preview is not optional.
- **Tests owed:** `e2e/tests/recorderbox-face.spec.ts` on the DEFAULT shell (both existing
  recorderbox specs are `?shell=legacy` and survive while proving nothing) — the **transport
  experiment in both directions**: with no card mounted anywhere, pressing the tile's RECORD must
  actually start a take read through `window.__nodeRecording` (which reads the registry, not the
  card), and the negative control is that on main today the same probe reports nothing started when
  `node.data.recording` is written from the store. Plus a live lane thumb and a reachable recover
  block.
- **VRT scope:** `GREP=recorderbox`. Predict **2 added, 0 removed**; the existing
  `vrt.spec.ts/recorderbox.png` should be **unmodified** — if the bot modifies it, stop and read
  why. Judge the capability badges from the ubuntu capture only (CI's runner reports avc supported
  and emits zero chunks).
- **Shared files:** the spine, `face-rack-status-source.test.ts`, `face-screen-render-suite.ts`
  SUBJECTS, `_face-fixtures.ts:105-107` (delete the DENIED entry BY HAND),
  `vrt-exemptions.ts:118-124` (comment-only fix to the mask's stale `why`), new
  `recorderbox-transport.ts`.

#### 5b–5c. backfill
Take the first two modules whose §5 questions have been answered, in this order:
**moog956 → nibbles → painter → chromaconsole → archivist → clipplayer.**

---

### 3.6 gibribbon — PR-blocked track (#2263)

**Do not open a second gibribbon PR.** #2263 already ships the face, the extension, the strict-faces
entry, the inventory promotion, three VRT baselines and `gibribbon-face.spec.ts`; a parallel PR
would collide on twelve shared files and would rank cells around ports #2263 **deletes**.

Its only non-green check is `webgl-attest` — an attestation **refusal**, not a test failure, covered
by the standing owner grant. Every other lane is green (e2e 12/12, vrt-strict 12/12, art, collab,
behavioral, webgl-smoke).

**Order is load-bearing:**
1. `git merge origin/main` **locally** into the branch (never `gh pr update-branch` — five generated
   files are edited on both sides).
2. Re-run `task docs:accept` and `task face:inventory:accept` on the merged tree; verify both sides
   survived.
3. Confirm `git merge-base --is-ancestor origin/main HEAD`, then `task webgl:attest:check` to
   **predict the merged hash**. ⚠ It will be **neither** the branch's refused hash **nor** main's —
   the branch is behind main and #2266 moved two basis files (`video/modules/backdraft.ts`,
   `video/panic-hook.ts`). **Attesting the refused hash today burns the window and re-reddens on
   merge** (the #2027 trap: the pin covers a TREE, not a PR).
4. Run `task webgl:attest` on a real-GPU machine; commit the pin.
5. Push once; after all shards report, re-pin **both** timings artifacts (#2263 has neither, despite
   a 194-line new spec and 3 new scenes).
6. Owner play-test the preview deployment — this is a full look-rewrite of a game — then merge on
   the exact final green commit.

Do **not** open a separate PR for the unreachable `autoplay` param (#2263 already ranks it as
`Attract`), and do not touch DOOM (the shared `wad-sprites` decoder is read-only reuse).

---

## 5. Owner-blocked

Each item is ONE question with a recommended default. Answering with the default unblocks the
module into wave 5+ with no further discussion.

### 5.1 moog956 — **BLOCKS nothing in wave 1–4, blocks moog956 itself**
> **Q:** Promoting moog956 empties the derived subject pools of two shipping specs
> (`midi-binding-node-lifetime.spec.ts` — its `beforeAll` asserts moog956 is NOT promoted; and
> `workflow-rear-card.spec.ts`'s `LEGACY_DOCK_CANDIDATES`, whose `pickLegacyDockType()` **throws**
> once every candidate is faced). Do we nominate a new durable subject, or retire the branch
> coverage?

⚠ **OWNER RULING, 2026-08-31 — the `toybox` nomination below is RETRACTED. Do not re-point any
fixture pool at a preserved un-migrated module.** Owner, verbatim: *"Why do we need a durable
unmigrated fixture? We will migrate everything including toybox and doom and then get rid of the
old ui code entirely."* Nominating a durable subject would make a permanently un-migrated module a
DEPENDENCY OF THE TEST SUITE, which blocks LEG-07/08/09 (delete the shell switch, the card fleet,
the legacy-coupled tests) — the permanent-exempt bucket the reconcile rule forbids.

**Correct handling — split the legs by what they actually assert:**

1. **Legs that test the MIGRATION-ERA MACHINERY itself** — the uniform placeholder tile, its EXPAND
   affordance, the verbatim legacy card operable in the dock (`AUDIO_PLACEHOLDER_FIXTURE`,
   `AUDIO_OPERABLE_FIXTURE`, `LEGACY_DOCK_CANDIDATES`). These are SUPPOSED to run dry:
   `deriveFixture` already carries a terminal `migration-complete` state, so the design anticipated
   the pool emptying. They keep running while un-migrated modules remain (both shells must work
   during the migration), and they are DELETED with the machinery they test in LEG-08/09. A
   promotion that empties a pool must NAME the skip in its PR body — skips are not passes — but it
   must NOT invent a subject to keep the leg alive.
2. **Legs that merely BORROW an un-migrated module as a convenient subject while asserting
   something DURABLE** — `midi-binding-node-lifetime.spec.ts` is the real member: MIDI binding node
   lifetime outlives the migration entirely. This one needs a SYNTHETIC subject (a forced-placeholder
   test hook), which is what #2068 already concluded after the spec expired twice in one day. Build
   that hook rather than re-pointing a third time. It is independent of toybox and of this program.

`LEGACY_DOCK_CANDIDATES`'s `pickLegacyDockType()` currently THROWS when every candidate is faced —
that is category 1 reaching its end state via the wrong exit. It should reach `migration-complete`
and skip like its siblings, or be deleted; decide that inside the moog956 PR, and do not add a gate.

Secondary, decidable inside the PR: `gate`'s `curve` must move `linear → discrete` (a contract move,
argued from the factory's own `value > 0.5` threshold as two-state-neutral) or `face.momentary` is
refused outright. And the ribbon's write path must be **split**: `pos` via `setNodeParam`
(flushed **synchronously before** raising the gate), `gate` via `setMomentaryParam`
(engine-only, never the Y.Doc) — otherwise every note attacks at the previous note's pitch and
glides, on the one module whose promise is that the ribbon holds its last pitch.

### 5.2 nibbles
> **Q:** A faced nibbles has no permitted visible home for `LEN {n} †` — the resting-text ruling
> denies it, and unlike frogger the module's own painter paints **no text at all** to carry it as
> in-canvas artwork. With the default `auto: 0`, a dead game is permanently frozen (no tick, no
> repaint, `length_cv`/`snake`/`gated` pinned) and the `†` is the only thing distinguishing "the
> snake died, press RESET" from "this module broke". Accept the loss, or pay for a HUD?

**Recommended default: (A) accept the loss, with two mandatory fixes.** Cost zero. But (i) render
the `aria-label` element **OUTSIDE** the `{#if !previewCollapsed}` guard — the file the plan copies
(`FroggerBoardBody.svelte:138,145`) puts it inside, so its own comment's claim that "the accessible
name tracks the game even while the picture is off" is false; **fix frogger in the same diff**; and
(ii) make SCALE a `node.data`-backed `selector` cell (the `samsloop-chan-{n}` pattern) so it stays
**lane-reachable**, rather than burying a zoom that is already a live #1531-class defect
(component `$state` dying on every dock collapse) in a dock-only body.
Option (B) — a HUD in `paintFrame` — costs an owner-machine GPU re-attest, rebases **ten** committed
baselines, and burns the HUD into `out` and therefore into every downstream patch.

### 5.3 painter
> **Q:** `previewCollapsed` is Y.Doc-**synced**, and painter's canvas is the module's only input
> device with zero ranked cells beside it — so one collaborator flipping SCREEN OFF makes painter
> undrawable for every peer, with no second surface. Grant painter a `NO_SCREEN_SWITCH` exemption,
> or require a separate preview well?

**Recommended default: (A) add painter to `NO_SCREEN_SWITCH`** with a `why` on exactly that
argument. The list has one entry today (videoOut: "a SCREEN ON/OFF here would collapse the module's
entire reason to exist"), the gate calls a new one "a visible decision rather than a quiet default",
and painter's case is *stronger* — videoOut's screen is read-only output; painter's is the
instrument. Option (B), a separate `blitOutputForPreview` well that SCREEN collapses while the
drawing canvas stays, satisfies the ruling literally and loses nothing, but is a design invention
that needs a yes.
**Independent of the answer, this PR must:** move the canvas setup from `onMount` into an `$effect`
keyed on `canvasEl` (any `{#if}` around the `<canvas>` destroys and recreates it; `onMount` does not
re-run, leaving `ctx2d` and `extras.setPaintCanvas` on a detached element — blank canvas, strokes
into nowhere, ops still committing); port the swatch **right-click → `pickBg`** (the only way to set
the background, read by the eraser and the FILL interior), the `.current` fg/bg indicator, and the
canvas's own `oncontextmenu` preventDefault; and import `MIN_BRUSH`/`MAX_BRUSH` from
`painter-draw.ts` rather than re-typing the SIZE range.

### 5.4 chromaconsole
> **Q:** Approve **one new param-shaped `SHELL_CELLS` kind** (a `device-slot` cell beside
> `warped-fader`, added to `PARAM_CELL_KINDS`) whose `label` / rendered primitive / roster /
> readout are **functions of the live node**, so eight identically-declared `0..127` slot params can
> paint the assigned control's name, its Segmented enum, its device-unit readout and its
> `pedal-snapped` marker?

**Recommended default: YES.** It costs **no ParamDef field, no contract-lock line, no docs:accept,
no attest** — the registry already carries node-taking closures (`ShellSelectorCell.options/value`,
`ShellEntryCell.text` are all `(node) => …`) and already crosses param controls once
(`warped-fader`, #2144). It fixes the caption, the primitive and the readout **together and at both
tiers**; the alternatives do not — `ParamDef.labelFor` fixes one of four properties and imposes a
contract-adjacent decision on every video author, and `face.bodyParams` is **dock-scoped by
construction**, so the LANE TILE would still paint eight knobs captioned "slot 1".."slot 8".
Two caveats to state in the PR body: the new cell must emit an existing `data-cell-control` value
(`'knob'`/`'segmented'`) so faces-parity needs no new branch, and two existing gates must widen from
the literal `'warped-fader'` to `PARAM_CELL_KINDS` (`shell-cells.test.ts:113` and `:143`) — widening
an existing gate to its second member, not a new gate, **but say so**.
There is also a **non-face slice that merges today** and is worth taking regardless: route
auto-detect through `matchPortByHint` (which has ZERO production callers while the card
re-implements it with a **different tie-break** — earliest-hint vs earliest-port), and tag
`chromaconsole.ts:105`'s `ydoc.transact` with `LOCAL_ORIGIN` so a slot reassignment — the module's
most destructive, least reconstructible edit — reaches Cmd-Z.

### 5.5 archivist
> **Q:** archivist's default `mediaType` is `'video'`, and for a video item the engine FBO is
> deliberately the **idle gradient** (archive.org video is CORS-tainted, so the uploader is never
> attached) — so a blit-only body ships a black rectangle as the module's product, while adopting
> the node-owned `<video>` is forbidden in three shipped bodies by name. Do the **#1511 controller
> extraction first** (move attach/audio/gate-loop/playhead onto a node-keyed controller, as
> videobox/videovarispeed/peertube/tvLibrarian all did), or approve a **non-adopting per-frame
> `drawImage`** of the parked element into the body's own 2-D canvas?

**Recommended default: do the controller extraction first, as its own PR, then face it.** It is the
disposition the inventory already records (for the wrong reason), it makes the picture legal by the
same mechanism as four shipped siblings, and it kills a second defect by construction — the search
inputs are card-local `$state` hydrated once at `onMount`, and `runSearch()` writes those locals
**out over** `node.data` before querying, so a body that writes `node.data` and invokes the card's
search would run a blank query and erase what was typed, with `delivered: true`.
The `drawImage` route works (tainting is safe while nothing calls `getImageData`) but is a mechanism
no body in the fleet has, needs its own measurement, and needs an explicit `markWatched` on **both**
SCREEN states because it never calls `blitOutputForPreview`.
⚠ Note the trade either way: archivist is a **named positive control** in
`face-migration-inventory.test.ts:405` and `workflow-shell-video.spec.ts:1389`, and it is the LAST
uncovered member of `DOM_SOURCE_LANE_TYPES` — covering it empties the set and makes
`face-migration-inventory.test.ts:814-815`'s `not.toEqual([])` assertion FAIL. Repair that control
the way `staleBlockers` already is: take the record as a **parameter** and drive it over a synthetic
pair in both directions, so it survives the last real member being covered — which is precisely when
a self-referential gate goes quiet.

### 5.6 clipplayer — **two questions, and this one wants a preview before code**
> **Q1:** `ShellActionCell` renders a bare `<Button>` with no `moduleId`/`paramId`, so RST loses its
> **documented, persisted MIDI binding** (`MidiAssignButton paramId="reset"`; keys live in
> localStorage and `clipplayer.ts:203` advertises it). Plumb `moduleId`/`paramId` into ModuleShell's
> action-cell `<Button>` — which makes **every** action cell in the repo MIDI-learnable, a
> cross-module behaviour change on a shared file — or accept losing the binding?
>
> **Q2:** Removing `'clipplayer'` from `NON_SHELL_LANE_TYPES` is **mandatory** for promotion and
> shrinks the canvas node from a 336–2200 px card to a 192 px tile, moving the 8×8 launcher off the
> canvas for every existing clipplayer in every saved patch at once. Approve at preview?

**Recommended defaults:** Q1 — **plumb it** (an action cell that cannot be learned is a shell gap,
not a clipplayer gap; do it as a separate small PR ahead of the face so the blast radius is
reviewable on its own). Q2 — **owner previews the compact and dock tiers before merge**; the pinned
`c`-pane instance is unchanged (it already paints at faceplate width), so the parity argument is
about the *canvas* instance only.
Also decide in the PR: **four declared control families have no honest probe** and must be deleted
from the def (`auto-assigned` and `auto-cap` are pure readouts with no gesture; `auto-override` and
`clear-auto` render only conditionally, so no probe reaches them on a fresh spawn) — and
`controlFamilies` **are** in contract-lock, so family *deletion* is the contract change here, not
`options[]`. And the **per-lane COLOUR swatch** is a STOP-2 with rack-wide blast radius: it is the
only writer in the app of `node.data.laneColor`, which `ModuleShell.svelte:232-243` reads live to
paint `face.channelAccent` on the **already-shipped mixmstrs face** — dropping it freezes every
channel accent in the rack at the default, with no gate able to see it.

### 5.7 peertube — **non-blocking; answer inline, default assumed in wave 4**
> **Q:** May the body keep (a) the per-video attribution **anchor** to `https://<host>/w/<uuid>` and
> (b) a visible now-playing identity? tvLibrarian's precedent covers only the generic-disclaimer
> half, and its roster-highlight replacement does not transfer — `PEERTUBE_PROFILE.autoLoadCatalogue`
> is **false**, so a reloaded rack restores the selection with an **empty** catalogue and no row to
> highlight.

**Recommended default: KEEP the anchor** (it is a navigational control, not a readout — the only
route from a playing federated video to the creator's page, and the only place the instance host is
named) and put the video name on the picture's `aria-label` via `src.selectionLabel`, which the
controller already publishes from `node.data` and therefore survives an empty roster. Wave 4 builds
on this default; a "no" costs one small follow-up.

---

## 6. Risks

### 6.1 What this plan could get wrong

1. **The line numbers.** Every citation was true on 2026-08-31 and the tree moves daily. A brief
   that says "`X.ts:412`" is a *pointer*, not a fact. Re-read before editing; if the code disagrees,
   the code wins and this file is stale in exactly the way §2 exists to punish.
2. **Concurrency at 3 open PRs.** Every wave has three PRs editing `strict-faces.ts`,
   `face-migration-inventory.ts`, `_shell-faces.ts` and three generated artifacts. "Keep both sides"
   is acceptable **only** for hand-authored per-module keyed rosters; for `face-migration.generated.md`,
   `contract-lock.txt` and both timings JSONs you must take main's version and **re-run the accept
   task**. Never `gh pr update-branch`. Run `task pr:conflict-sweep` after each merge to main.
3. **Cost-artifact truncation.** Accepting `e2e-timings` or `vrt-strict-timings` while shards still
   PEND produces a diff that reads exactly like a legitimate re-pin. Three prior promotions
   (tvLibrarian ×2, gibribbon) needed follow-up commits for this. Accept only after every shard
   reports, from **this PR's own** green run.
4. **The attest window.** `mappy` is the only confirmed GPU re-attest in the BUILD set, and the pin
   covers a **TREE, not a PR** — main moving a basis file under you changes your hash without your
   diff changing. Predict with `webgl:attest:check` on the **merged** tree, regenerate the pin
   **last**, and confirm only the hash moved. Two easy accidental ways to buy a window nobody asked
   for: adding `options[]` or a `format`/`units`/`landmarks` to a def under `lib/video/**` (blood,
   videovarispeed, nibbles all tempt this), and creating a `getContext('webgl')` in a new body
   under `lib/ui/modules/**` (which enrols the file **permanently**).
5. **The `?shell=legacy` blind spot, module by module.** Of the 20 modules here, **every single one**
   has its existing e2e coverage on `?shell=legacy` or the `rack` fixture. `laneRenderKind` returns
   `'legacy'` **before** `migrated` is read, so all of it stays green after promotion while covering
   a surface no player meets. Each brief owes a default-shell spec; a green legacy suite is **not**
   evidence the face works.
6. **Two shared-spec repairs that go quiet instead of red.** `collapse-keeps-playing.spec.ts`
   (videobox + videovarispeed) reports a green SKIP if its runtime enrolment testids are dropped;
   `audio-input-survives-card-collapse.spec.ts` becomes **vacuous** after audioIn's promotion because
   the ACT no longer unmounts anything. Both guard irreversible, owner-reported defects
   (`MediaStreamTrack.stop()`, "recorderbox stops the recording when un-expanded").
7. **`_face-fixtures.ts` DENIED entries** (recorderbox, peertube) go **invisible**, not red, on
   promotion. That file's own header records this happening twice already. Delete them by hand and
   name the deletion in the PR body.
8. **Recommending a fix on a surface we only looked at once.** The joystick/frogger/electra pattern
   recurs in this document: `FroggerBoardBody`'s aria-label bug (§5.2), `ElectraGridBody`'s missing
   `testid` override (wave 3b), `matchPortByHint`'s uncalled tie-break (§5.4). Each is a *second*
   surface carrying the same defect; fixing only the one in front of you leaves the other green and
   wrong.

### 6.2 What this plan is structurally unable to see

- **Anything owned only by a Svelte component.** That is STOP 2, and it is the reason six of these
  twenty modules have a "the only caller in the tree" line in their brief
  (`ensureLoaded`, `pruneSurfaceDangling`, `registerVideoExport`, `adopt`, `probeEncoders`/
  `listRecoverable`, `showOpenFilePicker`). A def-reading gate cannot see any of them, and a
  registry test stays green when they vanish. The mitigation is the per-module default-shell spec,
  and its coverage is only as good as the affordance list in each brief.
- **Whether a rebuilt affordance is the SAME affordance.** The typed-entry parity leg says so about
  itself: it is **presence-only**. Nothing checks that recorderbox's face FILE field round-trips
  through the same sanitize-on-save path, or that controlSurface's rebuilt rename writes the same
  key the Electra flashes.
- **Text inside a `fullViewBody`.** `face-resting-text-source.test.ts` declares body text its own
  blind spot. Every "moved to `aria-label`" and every "kept because it is instructional" decision in
  this document ships green either way — including the PeerTube/Sepia legal disclaimer, which is
  an attribution obligation nothing enforces.
- **Look.** No gate can tell you that a 192 px tile is worse than a 336 px card for a player
  reaching for a control mid-performance (controlSurface, clipplayer), or that a 1024×768 engine
  readback is a worse fullscreen than the native-res element (videobox). That is why every row in
  §1 says *owner preview*.
- **DPR ≥ 2.** Playwright and VRT run at `deviceScaleFactor: 1`. The skifree quadrant crop and the
  modtris HUD mis-scale are both invisible to every gate in the repo and were found only by reading.
  There are almost certainly more.
- **Whether the fleet's shared primitives can express a state the card had.** `Toggle.svelte` has no
  `disabled`; `ShellSelectorCell` cannot reach `Selector.svelte`'s; `ShellActionCell` passes no
  `moduleId`/`paramId`. Each surfaced only because one module needed it. Others are waiting.
- **The owner's intent behind a ruling.** "All video cards get SCREEN ON/OFF" and "faces carry almost
  no prose" were written for a preview beside controls and for a faceplate band respectively;
  painter and peertube each ask whether the ruling reaches a case it was not written for. This
  document guesses; only §5 resolves it.
