---
name: module-faceplates
description: Author a PF-20 dock FACEPLATE for an audio module and promote it to STRICT_FACES — the platform contract (what paints and what does not), the two STOP checks before promoting, derived readouts, ACTION probes, band packing, every gate by name, the shared registries a face collides on, and the per-module batch checklist. Use whenever adding/reworking a module `face`, promoting to STRICT_FACES, or debugging a dock faceplate.
---

# Authoring a module FACEPLATE (PF-20) and promoting it

The faced set is exactly `STRICT_FACES` (`$lib/ui/workflow/strict-faces.ts`),
asserted equal in both directions by `module-face-lint` — **authoring a `face`
IS the promotion**. Everything else is the batch queue.

⚠ **This paragraph used to carry "21 of ~118" and "the remaining ~97", and both
were stale within a wave.** Do not re-introduce a count here; derive it when you
need it — `task face:inventory` regenerates
`docs/design/face-migration.generated.md`, which reports the per-disposition
breakdown against the live registry. (The queue's pool join is
`.myrobots/plans/faceplate-queue-2026-08-14.md` §11.)

**Promoting a module is a behaviour change, not a skin.** `migrated(type)` is
`STRICT_FACES.has(type)` (`strict-faces.ts:105`), and it decides which component
the user actually operates:

- lane: `laneRenderKind` (`legacy-fallback.ts:106`) → `ModuleShell` tile
- dock: `DockFullView.svelte:319` renders `<ModuleShell view="dock-full">`
  **instead of** the module's `*Card.svelte`

⚠ **The dock swap is NOT behind `?shell=1`.** `Canvas.svelte:7993` passes
`migrated={migrated(fv.node.type)}` inside `{#if workflowMode}` only —
`shellPreview` (`Canvas.svelte:509`) gates the *lane* derivation
(`Canvas.svelte:2371`) and nothing else. So every merged face changes flag-off
behaviour for every workflow-mode user on the next deploy.

Do the adversarial audit FIRST — see `module-adversarial-audit.md`. A face over a
module that does not work is a prettier broken module.

---

## STOP 1 — does this module MERIT a face?

**"NO FACE ON MERIT" is a legitimate, expected verdict. Report it and move on.**

`noise` (`lib/audio/modules/noise.ts:60-68`): `inputs: []`, three outputs, and
**one** param. `faceTierCap` (`curated-face.ts:76`) gives mini 1 / compact 2–3 /
plate 6 / dock all — with one control every tier renders the identical single
knob, and `face.hero`, `face.pages`, band packing and the sidebar all have
nothing to organise. A face there is pure churn: 2 new VRT baselines per
platform, a faces-parity row, a Push-card tier change, and zero user-visible
gain.

Refuse when **all** of these hold: ≤2 params, no control families, no
`node.data`-backed affordances, no derived quantity worth a readout. When in
doubt, write the one-paragraph "what is it FOR" (audit step 2) — if it does not
produce a ranking argument, there is nothing to rank.

## STOP 2 — does every way of getting DATA IN survive promotion?

Promoting REMOVES the legacy card from both surfaces. Anything that lives *only*
on that card becomes unreachable.

**The worked case: `samsloop`.** `SamsloopCard.svelte` owns
`samsloop-wav-input` (`:758`, the `accept="audio/*"` loader at `:755`),
`samsloop-rec-settings` (`:792`, CHAN/BITS/RATE), and the whole REC machine.
None of them are `ParamDef`s — they are `node.data`. Promote samsloop and the
module has no way to acquire a sample at all.

**The check, before you write a line of `face`:**

```sh
grep -nE '<button|<select|<input|oncontextmenu|manualTrigger|Toggle|Selector|accept=' \
  packages/web/src/lib/ui/modules/<Mod>Card.svelte
```

Every hit maps to one of: a `face.order` param key · a `controlFamilies` entry +
a `SHELL_CELLS` cell (`shell-cells.ts`) · a `face.momentary` id · a `face.hero`
promotion · **or a written exemption with an argument.** If a hit is
load-bearing and has no shell representation you can build, **do not promote** —
`NON_SHELL_LANE_TYPES` (`legacy-fallback.ts:66`) is the precedent for the carve-
out (videoOut and cameraInput are there for exactly this reason), but note it
only protects the LANE: the dock full-view reads `migrated()` alone, so a
carve-out does **not** give the legacy card back in the dock.

⚠ Two gates are blind here. `module-face-lint`'s completeness enumerates params
+ declared families + numbered-legend statics, and only **three** legend files
exist in the whole repo — `e2e/vrt/__annotated__/{adsr,lfo,sequencer}.legend.json`
— so on every other module a card-only button is invisible to CI. **The grep is
the gate.**

---

## The platform contract — VERIFIED, 2026-08-03

| behaviour | where | note |
|---|---|---|
| **`face.title` does NOT always paint** | `dock-faceplate-model.ts:86-95` | `facePageHeader(def, annotations=false)` returns `null` when `annotations` is off — **title included**. Owner overruled the "a title is a name, not a note" draft: the module NAME is already painted once by the dock title bar; `face.title` is a CATEGORY word, and description is annotation. |
| every band `hint` is annotation | `bandHeaderPlan` (`:128-140`) | `hint: opts.annotations ? … : ''` |
| a band LABEL is suppressed only when TABBED | same | `label: opts.tabbed ? '' : …` — the rail already says it. The two suppressions are INDEPENDENT; coupling them was a real bug. |
| annotations are per-node + local | `annotate-mode.svelte.ts:20-30` | never synced to Yjs |
| **no type/description text on a card** | owner quote, `dock-faceplate-model.ts:69-81` | *"no 'voice' etc section, no text on the module… the name of the module as text is fine, it's the type/description text that needs to go away."* |
| readouts are a **row BELOW the hero**, full width | `ModuleShell.svelte:1010-1019`, CSS `:1464` | owner 2026-08-02: *"this row of controls should be below the graphic"*. They were a column beside it and competed with the picture for width. |
| a `hero.cell` **suppresses the shell glyph at the dock** | `ModuleFaceHero` doc, `graph/types.ts:698-703` | painting both put an empty black rectangle beside the graph on a silent rack. Untouched at every other tier. |
| `hero.cell/control/action` **MOVE** a key, never duplicate | `heroFacePlan`, `dock-faceplate-model.ts:276` | a duplicate emits a second `control-<paramId>` and fails faces-parity's exact multiset. `heroFacePlanIsTotal` (`:336`) pins the move. The key must already be claimed by a band. |
| a `FaceReadoutValue` sees **ONLY params** | `face-readout-values.ts:83` | `(read: (paramId) => number \| undefined) => string`. `node.data` is structurally unreachable — five of six specced samsloop readouts were underivable for this reason. |
| tier caps are GEOMETRY, not an authored ladder | `curated-face.ts:62-79` | mini 1 · compact 2 with a glyph / 3 without · plate 6 · dock all. **Ranks 1–6 are the entire lane budget; rank 7+ is dock-only.** |
| ≥7 bands ⇒ TAB RAIL | `dock-tabs-model.ts:56,72` | `DOCK_TAB_MIN_BANDS = 7`. A tabbed face never packs rows and prints no band hints where the rail names them. |

### The authoring consequence: WRITE FOR THE HINT-OFF STATE

Annotations are OFF by default, per node, and never synced. **So the resting
faceplate is: the module name in the dock title bar, band LABELS, and control
labels. Nothing else.** Author against that, not against the annotated view you
have open while you work.

- **A band label must stand alone.** `1 · burst — the hands` reads as a section;
  a label that leans on its hint reads as a bare word. Every page's `hint` is a
  sentence the reader may never see.
- **`face.title` and `face.hint` are annotation-only** — do not put anything
  load-bearing in them. No category word, no subtitle, no type text; the owner
  has been emphatic and repeatedly.
- **Do not add a page just to get a header.** A page costs a ~81 px band on a
  dock that folds at 720p; a cluster costs a ~14 px sub-header
  (`graph/types.ts:499-504`). A page is a different IDEA; a cluster is the same
  idea twice (a filter EG next to an amp EG).
- A hint declared on a TABBED face used to be authored, reviewed and rendered
  NOWHERE (the coupled `{#if band.label && !dockTabs}`). Fixed — but the lint
  now asserts the hint COUNT, so check yours actually paints.

### Band packing (PF-21, `dock-row-plan.ts`)

Consecutive bands share a row. The rule, as implemented:

1. **A tabbed face never packs** (`:288`) — a rail shows one band at a time.
2. **A band carrying a WIDE cell is SOLO** (`bandIsPackable`, `:156`).
   `cellWidthClass` (`:115`) is DENY-BY-DEFAULT: unresolvable ⇒ `'wide'`.
   Measured off the live dock (20 faces, 104 cells, a 1220 px pane): knob columns
   40–68.8 px, everything else 94.3–560 px. The split is drawn at the cell KIND,
   not a width estimate.
3. Runs pack to at most `DOCK_ROW_MAX_CONTROLS = 10` (`:76`) — a **flat**
   legibility number the owner set by eye, not derived from the pane width.
4. **A section is never split** (`packRun`, `:230`) — an over-cap band takes a
   row alone.
5. Balanced, not greedy: exact O(n²) DP, fewest rows → evenest → heaviest row
   last (`better`, `:196-214`). sixstrum's `[3,3,3,6]` becomes `(3+3)(3+6)`.

`dockRowPlanIsTotal` (`:320`) asserts the rows flatten to exactly the input
bands, in order — `module-face-lint` runs it over every faced module.

---

## Derived readouts — the one thing that is NOT a knob relabelled

`FaceReadout` declares **exactly one** of `paramId` / `valueId` / `text`
(`graph/types.ts:680-691`). Reach for `valueId` whenever the number the mock
prints is not any single knob.

**The canonical trap** (`face-readout-values.ts:12-30`): kick drum's TAIL. The
nearest knob is SUB DEC (450 ms). It moves when you turn SUB DEC. It looks
right. It is **invariant to SUB LEVEL**, which genuinely shortens the tail, and
the true answer at the def defaults is **398 ms**. A reviewer checking "does it
move when I turn the decay knob" gets a green.

**The bar for adding one — non-negotiable:** a derived readout is
negative-controlled on the input a knob readback would be BLIND to,
**permanently**, in a per-module `<mod>-face-model.test.ts`. Not once at
authoring time. Working examples and their controls:

- `clap-voice-ms`: 170 ms at SNAP 0.5, 40 ms at SNAP 1 — while `tail` reads 150
  at both (`clap-face-model.test.ts`).
- `clap-q` is TONE-invariant, `clap-bandwidth-hz` is not — publishing both is the
  instrument's own negative control.
- `drummergirl-*`: DECAY must move **none** of the five, because
  `drummergirl.dsp:69` contains no `decayKnob` at all.
- `sixstrum-ring-t60`: hold RING at 10 s, sweep MATERIAL to 0 → collapses to
  775 ms while the dial still says 10.

Also assert TOTALITY (fresh node / NaN / ±Infinity) — the function runs on every
render, so a throw takes the faceplate down mid-drag (`face-readout-values.ts:80`).

## ACTION cells REQUIRE a probe

`ShellActionCell.probe` is **required** (`shell-cells.ts:157`). Until 2026-08-02
faces-parity's `action` branch asserted `toBeEnabled()`, clicked, and asserted
nothing — **a dead audition passed the face green**, and sixstrum shipped a face
over an instrument that could not be sounded.

An audition writes nothing to the graph by design, so `readParam`/`readData` are
structurally blind. The observable is the AUDITION LEDGER
(`$lib/ui/modules/audition-ledger.ts`): per press, did the seam resolve a
callable off the live engine handle and call it. `delivered: false` is
**recorded, never dropped** — "never pressed" and "pressed and reached nothing"
must be distinguishable.

- `probe: { effect: { kind: 'audition', seam: 'manual-strike' | 'manual-gate' | 'engine-message' } }`
- `mode: 'gate'` needs `onGate`; `mode: 'trigger'` needs `onFire`
  (`shell-cells.ts:161-165`) — `shell-cells.test.ts` fails the mismatch.
- PANEL cells declare their own probe; **prefer `data` over `data-rev`** — a
  revision-only probe passes on a dead button that bumps the counter
  (`shell-cells.ts:225-240`).
- ⚠ `getActiveEngine()` (`$lib/audio/engine-ref.ts:23`) is already exported and
  already consumed from plain `.ts` (`clipplayer.ts:28`,
  `push2-control.svelte.ts:61`). **Two independent agents invented the same
  false blocker** that a shell-cells action needs a platform PR to reach the
  engine. It does not. Assume a third would too.

## A card must never RE-TYPE a range its def declares

The backdraft class: the card writes values the contract forbids, the model
clamps silently, and every def-reading gate is blind. It is live on faced
modules — `analogVco`'s def declares `fmAmount`/`pmAmount` as `-1..1` and its
card passed `min={0}` on both, so the knob reached half the contract while the
DEF-DRIVEN dock face reached all of it (`card-def-agreement.ts:14-18`).

Export the range from ONE model module the def **and** the card import (the
`ringback-crush-model` precedent). `ModuleShell.svelte:657-700` already does it
right — it passes `min`/`max`/`defaultValue`/`curve`/`label` straight off the
`ParamDef`. Two gates, asking different questions: `card-def-agreement.ts`
("does the restated number AGREE?") is deny-by-default over all 193 cards;
`card-range-source.test.ts`'s `RANGE_BOUND_CARDS` ("is the divergence
UNREPRESENTABLE?") is still an opt-in list of 7.

---

## Bespoke surfaces — the EXTENSION registry (#1512)

When a module needs more than the generic cells, there is a ladder, and the
extension is its LAST rung — reach for the earlier ones first:

1. **A family/static cell** (`shell-cells.ts` selector/toggle/action/file) —
   the control is one of the shared primitives, driven by a declared spec.
2. **A PF-14 `panel` cell** — ONE picture-you-edit *inside* the generic face
   (an operator map, an envelope editor). Registered in `shell-cells.ts`,
   probe required, dock-only by lint.
3. **A `custom` sidebar block** (`sidebar-panels.ts`) — a context picture with
   no `face.order` rank at all.
4. **A SHELL EXTENSION** — the module needs to fill one of the SHELL'S OWN
   SLOTS with bespoke code: the glyph, a whole editor surface, or the entire
   dock full-view body. This is the seam the bespoke-surface cohort
   (clipplayer, controlSurface, electraControl, launchpadControl, videoOut,
   cameraInput) plugs into.

### The contract

- The def declares **`face.extension: '<id>'`** — a string, never a component,
  so `face` stays serialisable data.
- The extension lives at **`$lib/ui/modules/<id>/shell-extension.ts`** (the id
  IS the directory name), default-exporting a `ShellExtension` slot map. The
  module owns that file and statically imports its own components there.
- ModuleShell resolves the id through `loadShellExtension()`
  (`$lib/ui/workflow/shell-extensions.ts`) — a **non-eager `import.meta.glob`**,
  so the bespoke code is a separate lazy chunk and **no module name ever
  appears in ModuleShell's imports**. Registration is glob+declaration, like
  the module registry and modules-card-map: no shared file is edited.

**Slots** (`ShellExtension`): `glyph` (wired — renders inside the generic
`.topo-glyph` plate AND as the `paramCells:'grid'` per-cell picture),
`editorSurface` and `fullViewBody` (declared contract, **no render site yet**
— the first adopter wires the `{#if ext?.…}` in ModuleShell and moves the slot
into `WIRED_SHELL_EXTENSION_SLOTS` in the same diff; until then
`shell-extensions.test.ts` refuses an extension exporting one, so a slot can
never silently no-op).

### The dx7 example (the proof migration)

```ts
// $lib/audio/modules/dx7.ts — the def declares data:
face: { …, glyph: 'algorithm', extension: 'dx7', paramCells: { algorithm: 'grid' } }

// $lib/ui/modules/dx7/shell-extension.ts — the module owns the components:
import Dx7AlgorithmGlyph from './Dx7AlgorithmGlyph.svelte';
export default { glyph: Dx7AlgorithmGlyph } satisfies ShellExtension;
```

The shell's `'algorithm'` glyph binding renders `ext?.glyph` with exactly the
props the old direct import got (`num`, `numbers`, `testid`), so the pixels and
the DOM contract did not move — the DX7 VRT scenes are the check.

### The guards

- **`module-shell-import-guard.test.ts`** — deny-by-default: ModuleShell plus
  its static import closure across the shell layer may not reference a
  module-owned directory, a module def path, or a module-named root file. The
  declared registries (`shell-cells`, `face-readout-values`,
  `shell-param-writes`) are typed BOUNDARY entries carrying the lints that own
  them; everything else reddens. Negative-controlled with the exact dx7 import
  the seam removed.
- **`shell-extensions.test.ts`** — declared id ↔ discovered module in BOTH
  directions; an `'algorithm'` glyph must resolve an extension exporting
  `glyph`; unknown/unwired slot keys are refused.

Docs note: `face` and this skill are hash-transparent by design (the attest
normalizer strips `face:` and all prose), so declaring an extension or editing
this section costs no re-attest.

---

## The gates, by name

Pure unit lane (~0 CI cost) — run these on every face:

```sh
flox activate -- task test:one -- module-face-lint    # order/pages/hero/sidebar/momentary/paramCells/rear
flox activate -- task test:one -- dock-row-plan       # PF-21 packing + totality
flox activate -- task test:one -- dock-faceplate-model # hero split totality, readout resolution
flox activate -- task test:one -- shell-cells         # no inert cell on a promoted face; probe shape
flox activate -- task test:one -- shell-extensions    # extension registry: declared ↔ discovered, slot shape
flox activate -- task test:one -- module-shell-import-guard # the shared shell stays module-free
flox activate -- task test:one -- curated-face
flox activate -- task test:one -- rear-card-model     # ⚠ pins tidyVco/kickdrum/adsr/vca/lfo/cloudseed
flox activate -- task test:one -- <mod>-face-model    # YOUR permanent negative controls
flox activate -- task test:one -- push-card-schema    # the Push 2 golden (see below)
flox activate -- task test:one -- module-docs-lint
flox activate -- task docs:check                      # contract golden, read-only
flox activate -- task typecheck                       # svelte-check is stricter than vitest
```

E2E / VRT (`REPEAT=3` on anything new or seriously changed):

```sh
flox activate -- task e2e:serve
REPEAT=3 flox activate -- npx --workspace e2e playwright test faces-parity --grep <mod>
REPEAT=3 flox activate -- task e2e:one -- tests/faceplate-platform.spec.ts
REPEAT=3 flox activate -- task e2e:one -- e2e/vrt/workflow-shell-faces.spec.ts
REPEAT=3 flox activate -- task vrt:one -- <mod>
flox activate -- task e2e:stop
```

**Registry-driven, so they auto-enrol your module the moment it enters
`STRICT_FACES`:** `faces-parity.spec.ts:857` · `module-face-lint` completeness
(`:228`) · dock render-plan parity (`:276`) · `shell-cells.test.ts:58` ·
`faceplate-platform.spec.ts` sidebar + annotation sweeps.

**NOT registry-driven — you must edit them by hand:**

- `e2e/vrt/workflow-shell-faces.spec.ts:43-77` — the `FACES` roster, with a
  per-scene `pages` count. **Nothing ties it to `STRICT_FACES`.** A promoted
  module missing from this list simply has no VRT scene, silently.
- `e2e/tests/faceplate-platform.spec.ts:151` — `sweepBudgetMs(adopterCount)`
  scales with the roster. Batch 3 took the annotation/sidebar adopter count from
  1 to 5 and a flat 30 s budget went red on shard 3/10 (measured 6.1 s on a real
  GPU, **14.4 s under `E2E_SWIFTSHADER=1`**).

## The shared files a face PR collides on

Measured off `2d111616` (batch 3, 4 faces, 61 files). These are the conflict
surface — run `flox activate -- task pr:conflict-sweep` after any merge:

| file | why |
|---|---|
| `$lib/ui/workflow/strict-faces.ts` | the promotion set (append) |
| `$lib/ui/workflow/face-readout-values.ts` | one map, every module's `valueId`s |
| `$lib/ui/workflow/shell-cells.ts` | one `SHELL_CELLS` record |
| `$lib/ui/workflow/sidebar-panels.ts` | `custom` sidebar block registry |
| `e2e/vrt/workflow-shell-faces.spec.ts` | the `FACES` roster |
| `packages/web/src/lib/audio/modules/vrt-meta.test.ts` | only if you touch `STRICT_VRT_MODULES` |
| `$lib/control/push2/push-card-config.ts` + `push-card-schema.test.ts` | see below |
| `$lib/docs/contract-lock.txt` | GENERATED — see below |

### ⚠ The Push 2 card moves when you author a face

Three tiers, first match wins (`push-card-config.ts:20-33`): OVERRIDE → **FACE**
(first 8 turnable params of `face.order`) → GENERIC (declaration order).

- **A first promotion moves the module from GENERIC to FACE** — the whole card
  changes, not one slot.
- **A re-rank moves it again.** sixstrum's batch-3 re-do changed the golden from
  `strumSpread, ring, material, pickTone, muteDepth, register, strumDir, tuning`
  to `ring, material, body, strumSpread, level, stiffness, tuning, register`, and
  `skipped` from 1 family to 2 (`push-card-schema.test.ts` diff on `2d111616`).
- Adding a param re-ranks the generic tier and can push the 8th control off.
- If the card matters, pin it with an explicit `PUSH_CARD_CONTROLS` entry — an
  override REPLACES, so it cannot drift. Otherwise **accept the golden diff
  deliberately, with the reason written in the test.**

### ⚠ `face` is MOSTLY contract-transparent — `sidebar` and `controlFamilies` are NOT

`serializeModuleContract` projects id/min/max/curve/defaultValue/units/ports/
flags, so a re-rank, a page relabel, a hero, a `paramCells` declaration, a
`ParamOption` detent roster and a hint are all free.

⚠ **`face.sidebar` IS PROJECTED and this section used to say it was not.**
`contract-lock.txt` carries a `<type> face sidebar <i> kind=… label=… …` line
per block (`serializeFaceSidebar`, `contract-signature.ts:142`), in declaration
ORDER, because #1468 removed a sidebar block from twelve modules with every
non-pixel gate green. So **declaring, reordering, relabelling or removing a
sidebar block costs a `task docs:accept`** — and the diff is the review surface
that incident did not have. The rest of `face` is enumerated in
`FACE_FIELDS_NOT_IN_LOCK`, which `tsc` requires you to extend when you add a
field, so "not in the lock" is a declaration rather than an omission.

**But a new `controlFamilies` entry IS in the contract.** Batch 3 added three
lines — `clap family clap-hero kind=cell prefix=clap-hero`,
`pentemelodica family pentemelodica-voices …`, `sixstrum family sixstrum-strum …`.
So a hero panel or a recovered audition costs `flox activate -- task docs:accept`
plus a `docs.controls` entry for the family (STRICT_DOCS completeness).

---

## VRT — three traps, all of which cost real time

**1. The dock scene sees the TOP ~425 px and nothing else.**
`DockFullView.svelte:371` is `max-height: min(60vh, 680px)` with its own scroll
region, so on a face with a tall hero the section bands sit **below the fold and
are not in the image**. Measured while landing PF-21, which re-grouped the bands
of thirteen faces: nine dock baselines went red and **sixstrum's, dx7's,
kickdrum's, snaredrum's and drummergirl's stayed pixel-identical** while the
layout underneath them changed completely — the gate is blind to band layout on
precisely the faces with the most bands
(`workflow-shell-faces.spec.ts:90-114`). A green dock scene is NOT evidence that
a band-level change is a no-op. Band structure is gated by
`faceplate-platform.spec.ts` and the pure `dock-row-plan` / `module-face-lint`
units, which read the whole faceplate.

**2. `--update-snapshots` only rewrites on FAILURE. MEASURE FIRST, then choose.**
Budgets: `COMPACT_MAX_DIFF = 150`, `DOCK_MAX_DIFF = 1500`
(`workflow-shell-faces.spec.ts:87-88`), `REAR_MAX_DIFF = 1500`
(`workflow-rear-card.spec.ts:56`).

- Over budget ⇒ the comparison FAILS ⇒ `--update-snapshots` rewrites it. Batch 3
  measured sixstrum at 205 px (compact) and 11379 px (dock, 7.6× the budget) and
  took this route.
- **Under budget ⇒ the scene PASSES while stale and the dispatch commits
  ZERO.** `darwin/rear-sixstrum.png` moved by exactly **611 px** because
  `rearFieldPlan` derives the rear card's band ids/labels/order straight from
  `face.pages` (`rear-card-model.ts:287-300`) — a full page rename, sub-tolerance
  because only one band header falls inside the 1220×425 capture. Route:
  `git rm` the baseline first, so Playwright writes a *missing* snapshot.
- **NEVER `git rm` a LINUX baseline** — it manufactures an undeclared platform
  gap and reddens `vrt-meta`. Darwin only.
- **A green dispatch that committed nothing is a RED FLAG.** Count the files the
  bot commits against what you expected.

**3. A live surface is not pixel-deterministic.** analogVco was authored, passed
every unit gate, and was **dropped from batch 3**: it is a free-running
oscillator, so its live `scope` glyph draws a moving saw where every other faced
module draws a flat centreline — **254 / 154 / 315 px across three consecutive
captures of the same tile**. Its dock scene was stable, which confirmed the
cause (a `hero.cell` suppresses the glyph there). Those belong in
`VRT_LIVE_SURFACES` (`e2e/vrt/vrt-live-surfaces.ts:338`) with a mask **and** a
measured companion — not in a face PR.

**New face scenes need NOTHING declared** (since #1458). Add the module to the
`FACES` roster, push, and run `flox activate -- task vrt:commit` — linux CI
writes `face-<t>-compact.png` and `face-<t>-dock.png` and commits them to the
branch. There is no pair to add, no ceiling to move, no ledger to re-pin, and no
drain-before-dispatch ordering: all of that existed to manage a second baseline
population that no longer exists. Until the capture lands the two scenes FAIL as
"snapshot doesn't exist", which is the visible-debt state the exemption pair used
to hide.

## Accept loops — what each re-pins

| command | re-pins |
|---|---|
| `task docs:accept` | `contract-lock.txt` (+ the gitignored render module). Needed for a new `controlFamilies` entry or any param change. |
| `task test:ledger:accept` | `docs/testing/test-ledger.generated.md`. Needed on ANY edit to an exemption list. GENERATED — never hand-edit. |
| `task art:update` | ART `.f32` + `.sha` **and** `fingerprints.generated.json` (chained). Only if the audit fixed DSP. **Attribute every manifest entry**: a labels-only `peakDb`/`rmsDb` move is a LEVEL change; a spectrum move is TIMBRAL. An entry you cannot attribute is a regression — stop, do not re-pin. |

Attest: **NIL**, for an audio OR a video def. Audio defs are outside the WebGL
basis and no collab/grand basis file is touched; and a video def's `face` is
stripped before hashing anyway — `face` is one of the hash-transparent def
properties in `scripts/attest-code-basis.ts`, alongside `docs` and
`controlFamilies`. (⚠ Only a def's own TOP-LEVEL `face`. A `face:` nested inside
geometry is real code and stays in the hash, deliberately.)

---

## THE BATCH CHECKLIST — one module, end to end

1. **Audit first** (`module-adversarial-audit.md`). Fix what you find, in its
   own commit, with its own gate. Never fold a DSP change into a face wave.
2. **STOP 1** — merit. If no, report "NO FACE ON MERIT" with the numbers and stop.
3. **STOP 2** — grep the legacy card. Every affordance maps to a face key, a
   shell cell, a `momentary` id, or a written exemption. If an input path cannot
   survive, do not promote.
4. **Read four things in order**: the def (`lib/audio/modules/<mod>.ts`) · the
   card **line by line** (control-loss ground truth) · the DSP
   (`packages/dsp/src/<mod>.{ts,dsp}`) · `art/scenarios/<mod>/*`.
5. **One paragraph: what is it FOR, musically.** Name the ONE thing it does that
   its siblings do not, and the verb a player performs. Every rank descends from
   this.
6. **Rank against the DSP, not the declaration order.** A rank is only defended
   if the argument would be wrong for a different module. Check hero candidates
   for **inertness at spawn**; check demotions for **unconditional
   applicability**. Print the tier ladder as a sentence.
7. **Page by FUNCTION.** `order` = priority (tiers showing a subset); `pages` =
   signal order (the tier showing everything). Let them disagree, and say so in
   the comment. A page earns a header at ≥2 controls, or 1 that is the module's
   identity. Never merge two distinct engines into one band to save height.
8. **Write the face**, co-located on the def, with the argument in the comment.
   `clap.ts` (`2d111616`) is the reference: tier ladder read back as a sentence,
   why `order` and `pages` disagree, why each derived readout is not a knob.
9. **Hero + readouts.** Every `valueId` gets a permanent negative control in
   `<mod>-face-model.test.ts` on the input a knob readback is blind to, plus a
   totality leg.
10. **Rear card is a PROJECTION of `face.pages`** — re-derive it on paper for
    every page edit (which CV holes land in which section, orphan `_cv` stems, a
    curated group id colliding with a page id), then check `rear-card-model.test.ts`.
    Since **#1800** both rails share ONE row grammar and the groups lay out as
    COLUMNS, so three things changed for an author:
    - `face.rear.groups` covers BOTH rails. An entry takes an optional
      `direction` (default `'input'`); an OUTPUT group declares
      `direction: 'output'`. ⚠ A port id can exist on both rails at once
      (`delay` declares an `audio` in AND an `audio` out) — module-face-lint
      refuses a group whose ports are not on the direction it declares, and
      refuses one that resolves to no port at all (the section would silently
      never render).
    - Outputs have a **derived default**, so authoring is optional: one `out`
      section, splitting into one section per CABLE DOMAIN only once the rail
      out-runs a column. Author a group when the split should mean something
      else (main vs sends), not to restate the domains.
    - A section's WIDTH is derived from its row count (`rearSectionColumns`), so
      a three-jack group is three jacks wide and a thirty-jack group takes the
      columns it needs. Nothing collapses or hides — band-collapse is gone.
    - **Direction is carried by four NON-COLOUR channels** declared in
      `rear-direction.ts` (zone · section glyph · row mirror · tile chrome).
      Colour means cable domain and nothing else; `rear-direction.test.ts` fails
      any direction-qualified rule that assigns a domain hue.
11. **Promote**: add to `STRICT_FACES`. An authored face NOT in the set is
    INERT — it ships as a no-op while looking complete. (Zero instances in the
    tree today; keep it that way.)
12. **Add the VRT scene** to `FACES` in `workflow-shell-faces.spec.ts` with the
    post-hero-split band count. Capture darwin; declare the linux pair + both
    ratchets + the ledger in the same commit.
13. **Run every gate above**, `REPEAT=3` on new/changed tests, then `typecheck`.
14. **Estimate the CI wall-time delta.** faces-parity budgets CI at roughly
    `10 s + 0.8 s/cell` — ~4× the local software-renderer cost of
    `2.0 s + 0.19 s/cell` (`faces-parity.spec.ts:78-83`). Multiply by your cell
    count. Anything over ~2 min needs owner sign-off.
15. **PR title carries the finding, not the ceremony.** A face wave that fixed a
    live defect says so. Look-affecting PRs go to owner preview — **do not
    auto-merge a faceplate.**

## What this skill does NOT cover

- **VIDEO modules — but the two reasons this used to give are now STALE, and
  the real blocker is elsewhere.** This entry said *"no video def carries a
  `face`; their doc `[id]` page does not exist either."* The first is circular
  (the skew offered as its own justification — the shape twice withdrawn for
  `ninelives` and `analogLogicMaths`); the second is simply false now
  (`module-manifest.ts` wires `VIDEO_SOURCES` into `buildModuleManifest`, and
  `routes/docs/modules/[id]` enumerates it — video modules HAVE doc pages).
  Nor is the attest a concern: a top-level `face` on a video def is
  hash-transparent (`HASH_TRANSPARENT_PROPS`, `scripts/attest-code-basis.ts`),
  verified live. And the shell is READY — `ModuleShell` gives a video face a
  LIVE THUMBNAIL of its own output via `hasVideoSurface(def)`.

  ⚠ **The declaration is counter-intuitive: a video def must declare
  `glyph: 'none'`.** `primaryAudioOutPortId` matches `type === 'audio'` and a
  video def has none, so any other glyph resolves to `{kind:'static'}` and
  reddens the dead-glyph clause. The picture arrives through `hasGlyph`'s OR,
  from a different seam — so `'none' + blank tile` and `'none' + live thumb`
  are indistinguishable from the declaration. **Assert `hasVideoSurface`.**

  **THE ACTUAL BLOCKER (#1726): face completeness has no exemption for a param
  with NO USER CONTROL.** `module-face-lint` loops every `ParamDef` with no
  filter and no skip-list, a second gate requires each to render exactly one
  interactive cell, and `ModuleFace` has no `hidden` field. Several video
  modules carry hidden SYNTHETIC params that exist only so a CV bridge has
  somewhere to write a gate edge, plus a `freeze` VRT hook — `backdraft` has
  seven. No faced module has ever had one, so there is no precedent to copy,
  and since they declare `curve: 'linear'` they would render as continuous
  rotaries over raw gate swings. Settle that on `ModuleFace` before picking a
  first video face. Full audit:
  `.myrobots/plans/faceplate-queue-2026-08-14.md` §16-§17.
- **The lane-tile snowflakes** in `NON_SHELL_LANE_TYPES` (clipplayer, the MIDI
  surfaces, videoOut, cameraInput, group, sticky, cadillac) — they get bespoke
  faces in a later spike, and the dock-side story for them is unsolved.
- **`cube` and the odd ducks** whose "controls" are a viewport. Not attempted.
- **`samsloop`-class modules** (the input path is `node.data`). The shell has no
  file-import or recorder cell that reaches the dock. Building one is a platform
  PR, not a face.
- **Whether the owner will like it.** Design review is not a gate you can run.

## Related

- `module-adversarial-audit.md` — do this first
- `blind-gates.md` — what a gate is structurally unable to see
- `module-docs.md` · `module-pr-checklist.md` · `vrt-failures.md`
- `.myrobots/plans/dx7-and-faces-design-program-2026-07-27.md` §7 (the recipe)
  and `.myrobots/plans/face-specs-round-2-2026-08-01.md` (a 71-defect
  adversarial review of ten drafts — **the defect lists are the valuable half**)
