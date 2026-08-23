---
name: module-faceplates
description: Author a PF-20 dock FACEPLATE for an audio module and promote it to STRICT_FACES — the platform contract (what paints and what does not, including the resting-text ruling that deleted the sidebar and the hero readout strip), the two STOP checks before promoting, ACTION probes, band packing, every gate by name, the shared registries a face collides on, and the per-module batch checklist. Use whenever adding/reworking a module `face`, promoting to STRICT_FACES, or debugging a dock faceplate.
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

## STOP 1 — is promoting this module a PARITY LOSS?

⚠ **THIS STOP USED TO REFUSE THIN MODULES, AND THAT REFUSAL IS OVERRIDDEN.** It
read: *"Refuse when all of these hold: ≤2 params, no control families, no
`node.data`-backed affordances"*, with `noise` as the worked example. Owner
directive, 2026-08-20, which supersedes it:

> *"if there are a lot of audio modules with <4 params can't we just fly through
> them really quickly? they still need to be done, <4 params or not."*

**Thinness is not a reason to refuse.** A one-knob module gets a one-knob face:
one honest band, nothing padded, and it is among the narrowest plates in the
fleet — which is the correct outcome of "compact is the default and width must be
earned", not a defect.

⚠ **And the old example was FALSE WHEN WRITTEN.** `noise` is *in* `STRICT_FACES`
— it ships a face with `paramCells: { level: 'fader' }`. The text cited it as the
canonical refusal while the module had already been promoted, so anyone reasoning
"the same grounds on which `noise` is refused" inherited a premise the registry
contradicts. That mistake propagated: a sibling lane re-pointed
`midi-binding-node-lifetime.spec.ts` onto `depolarizer` on 2026-08-20 *because*
this section called such modules structurally un-promotable, and the batch-18
blitz promoted `depolarizer` hours later.

### What actually earns a refusal

Not the control count — whether the promoted face **drops something the player
can do or see today**. Promoting removes the legacy card from both surfaces, so
anything living only there becomes unreachable. Two measured examples, both filed
rather than shipped:

- **#1974 (`joystick`)** — its only controls are one `xy` pad. `laneOrder` drops
  the pad's anchor and `foldedOrder` drops its partner, so **every lane tier
  resolves to zero controls**: a title, a patch panel, and no stick, on a module
  whose entire purpose is a performance gesture.
- **#2065 (`spectrograph`)** — its headline feature is a live scrolling sonogram
  the card draws on its own canvas. `hasVideoSurface` is `domain === 'video'`, so
  an audio-domain module with `mono-video` ports has **no engine surface** for
  the shell to paint; the face would be one GAIN knob and a static glyph.

Both are functional-parity losses, which are never surfaced as an owner choice
after the build — file the blocker and move on to the next module. That is the
verdict this stop exists to produce now.

⚠ **A thin module can still have a real trap, and it is SELECTABILITY, not
merit.** A `2..3 discrete` param rendered as a knob has two reachable positions
across the dial's whole travel, so a drag quantises back to where it started and
the control is **inert** — `faces-parity` caught exactly this on `moog962`
(*"dragging the knob commits a param change into the graph"*, both attempts). Give
a few-state discrete param an `options` roster so `paramCellKind` derives a
segmented cell. Labels are the module's real names where it has them, and the
states' own values where they are literally quantities; never fabricate
semantics. See "rosters make states SELECTABLE" below.

## STOP 2 — does every way of getting DATA IN survive promotion?

Promoting REMOVES the legacy card from both surfaces. Anything that lives *only*
on that card becomes unreachable.

**The worked case: `samsloop`.** `SamsloopCard.svelte` owns
`samsloop-wav-input` (the `accept="audio/*"` loader), `samsloop-rec-settings`
(CHAN/BITS/RATE), and the whole REC machine. None of them are `ParamDef`s —
they are `node.data`.

⚠ **The conclusion this example used to draw — "promote samsloop and the module
has no way to acquire a sample at all" — IS NO LONGER TRUE (#2010),** and the
example is kept because the METHOD is right even though its verdict expired.
The loader now maps to a `ShellFileCell` (see the entry at the bottom of this
file); it is the RECORDER that has no cell. **That is the point of the grep: it
tells you which affordances exist, and you must then re-check each against
today's ladder rather than against a verdict someone reached against an older
one.** Line numbers in an example like this drift too — treat them as hints, and
let the grep find the real ones.

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
| **no readout row, and no sidebar** | `ModuleShell.svelte` hero rail, `DockFullView.svelte` `.page` | owner 2026-08-19. The resting faceplate paints NO derived-state text in any shape — see the ⛔ section below and `face-resting-text-source.test.ts`. |
| a `hero.cell` **suppresses the shell glyph at the dock** | `ModuleFaceHero` doc, `graph/types.ts:698-703` | painting both put an empty black rectangle beside the graph on a silent rack. Untouched at every other tier. |
| `hero.cell/control/action` **MOVE** a key, never duplicate | `heroFacePlan`, `dock-faceplate-model.ts:276` | a duplicate emits a second `control-<paramId>` and fails faces-parity's exact multiset. `heroFacePlanIsTotal` (`:336`) pins the move. The key must already be claimed by a band. |
| tier caps are GEOMETRY, not an authored ladder | `curated-face.ts:62-79` | mini 1 · compact 2 with a glyph / 3 without · plate 6 · dock all. **Ranks 1–6 are the entire lane budget; rank 7+ is dock-only.** |
| a HUE is its own primitive (`paramCells: 'hue'`) | `HueWheel.svelte`, `shell-control-kind.ts` | the conic ring, for a CONTINUOUS `0..1` angle. **Not `'color'`** (that is a DISCRETE packed-RGB picker) and **not a knob** — a hue wraps, so a dial's end stops fall mid-space. It paints NO value; the angle is in `aria-valuetext`. module-face-lint refuses it on any other param shape. |
| ≥7 bands ⇒ TAB RAIL | `dock-tabs-model.ts:56,72` | `DOCK_TAB_MIN_BANDS = 7`. A tabbed face never packs rows and prints no band hints where the rail names them. |

### Owner ruling (2026-08-18): a CONTROL-HEAVY module gets a TABBED face, like backdraft

"Heavy" means **lots of controls of DIFFERENT types** — not render weight. The
reference is backdraft's dock face: eight semantic pages (`feedback / loop /
colour / key / switches / tv screen / virtual camera / …`) on the tab rail, with
the one persistent element (its preview screen) present in every view (owner:
*"the preview screen can stay present in all views"*). First named application:
**ruttetra** (12 params).

- The mechanism is `face.pages` → dock bands → `dockTabPlan` engages the rail at
  `DOCK_TAB_MIN_BANDS = 7`. **Do not cram a heavy module into few dense bands to
  stay under the threshold**, and do not solve heaviness with row wrapping — a
  page per IDEA, like backdraft's.

### ⛔ `face.tabbed` — the per-face rail opt-in is OWNER-INSTRUCTION ONLY

A face can force the rail on below the threshold. **You may not reach for it.**

- **It is declared only on an EXPLICIT OWNER INSTRUCTION, per module**, and the
  instruction goes into `FACE_TAB_OPT_IN` (`dock-tabs-model.test.ts`) **verbatim**,
  beside an argument for why the rail is that module's own STRUCTURE. A def that
  declares `tabbed` with no entry is RED; an entry whose module no longer
  declares it is RED. Provenance is the point: the risk is an agent adding it
  because a face "reads better as tabs" and writing a plausible sentence about
  what the owner wanted.
- **It does NOT reopen the threshold question for anything else.** The default
  stands: author honest pages, and the rail engages at 7. A 3–6 page face
  renders as one column and that is CORRECT — the owner ruled `ruttetra` ships
  **untabbed** in the same breath as ruling spirographs tabbed.
- **Today's only adopter is `spirographs`** (*"this should just be 3 tabs, one
  per spiro"*): three independent figures, one editable at a time — the
  structure its own legacy card already had.
- ⚠ **A hero that empties its band changes the tab count.** `heroFacePlan` drops
  a band whose every control was promoted, so the rail must be computed from the
  POST-hero bands — `DockFullView` does this, and a def-less or pre-hero
  `dockTabPlan` call is the "rail with no matching hide" blank-faceplate class.
- This does not repeal "do not add a page just to get a header" (below): pages
  must still be different IDEAS. On a genuinely heavy module they are. If a
  heavy module's honest semantic grouping lands at 5–6 pages — under the rail
  threshold — **do not pad pages to force the rail**; raise it to the owner
  instead (the threshold is the lever, and moving it is a deliberate,
  baseline-moving decision per `dock-tabs-model.ts`'s own header).

### Owner ruling (2026-08-18): EVERY video module's card gets a SCREEN ON/OFF toggle

*"'screen on / off' on the card like that is a thing all video modules should
have moving forward."* Reference: backdraft's
`BackdraftOutputBody.svelte` (~:314) — the button toggles `previewCollapsed`;
OFF collapses the preview and **reclaims its vertical space** while the module
KEEPS RENDERING (ON again shows the LIVE picture, never a stale frame — do not
tear the producer down; that is the #1720/#1721 bug class). The owner's stated
floor: the on/off state **persists through tab switches**. Every new video face
ships with it.

**WHERE it goes is settled, and it is a measurement rather than a taste: OVERLAY
the preview's BOTTOM-RIGHT CORNER on a translucent backplate, NEVER a row of its
own.** Precedent: spirographs (`592ca4f6b`). A stacked toggle — the button under
the canvas in a `flex-direction: column` with a gap — cost **~18.8 px on a card
carrying ~11 px of slack**, and `io-spec-consistency`'s card sweep caught the
result: `.fader-grid` overhanging the card's bottom edge by 7.8 CSS px against a
tolerance of 6 (18.8 − 11 = the 7.8 measured). The control is REQUIRED so it
cannot be dropped, and neither a wider tolerance nor a taller card is the fix —
both just hide the next control that does this. An overlay sits inside the
picture's own box, so the expanded card is **exactly** the height it was before
the feature existed: the delta is ZERO, not merely small. Two details that are
load-bearing rather than decorative: the backplate (`rgba(5,6,8,0.72)`) exists
because a transparent button over a live picture was never legible, and the
wrap keeps a small `min-height` that is inert behind the canvas and only matters
with SCREEN **off**, where the canvas is gone and an absolutely-positioned button
would otherwise leave the card. **The stacked row is the named anti-pattern** —
if you are measuring whether a row "fits", you are already building the wrong one.

**⚠ THE PARAGRAPH ABOVE IS ABOUT A *CARD*. A *FACE* NEEDS A DIFFERENT ROUTE, AND
FORGETTING THAT SHIPPED A MERGED FACE WITHOUT THE CONTROL (#1928).** Promotion
sets `migrated(type)` true, and neither surface renders the module's card after
that — so a toggle that lives only on the card is **deleted by the very promotion
that was supposed to keep it**. `spirographs` shipped exactly that: the switch was
on `SpirographsCard.svelte`, the module entered `STRICT_FACES`, and the ruling was
then satisfied only on a surface nobody can reach.

There is **no generic shell affordance** for it — `previewCollapsed` appears in
zero shell files. A faced video module gets the toggle through the
**`fullViewBody` shell-extension slot** (`face.extension: '<id>'` →
`$lib/ui/modules/<id>/shell-extension.ts`). Adopters: `backdraft`, `videoOut`,
`spirographs`. It is dock-only by `dockFullViewHeadPlan`, because a 192 px lane
tile cannot carry a module surface — the lane keeps the generic `VideoTileThumb`.

So: **card → overlay the preview's corner; face → `fullViewBody`.** Both are
required of a video module that has both surfaces, and the face one is the half
that is easy to lose, because nothing asserts it — a deny-by-default check over
`STRICT_FACES ∩ video defs` is the honest close and does not exist yet (#1928).

Two details that are load-bearing wherever it renders: **state lives on
`node.data`**, never component `$state` (the component unmounts on dock collapse
/ LRU eviction — the #1531 / #1574 / #1583 class — and `node.data` is what
survives a tab switch, a remount, a reload and syncs to collaborators); and
**reuse the same `previewCollapsed` key** the card used, or every rack saved
before the promotion silently re-opens its collapsed preview.

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

## ⛔ DERIVED READOUTS ARE DELETED — and so is the whole sidebar

**Owner ruling, 2026-08-19. Do not author either. There is nothing to migrate
to.** Both mechanisms are removed from the platform, not deprecated:

- **`face.sidebar`** — the right-hand context column, all three kinds
  (`presets`, `readouts`, `custom` panels). *"this should go away and we reclaim
  the vertical space. I DO NOT WANT THESE RIGHT HAND TEXT AREAS I DO NOT WANT
  EXTRA TEXT. i explicitly already dictated that several times."*
- **`face.hero.readouts`** — the labelled strip under the hero. *"you don't need
  to have the out-silent text at all … we absolutely have to stop doing shit
  like that. i said minimal, and good use of screen real estate."* (#1957)

`FaceReadout`, `FacePreset`, `FaceSidebarBlock`, `sidebarPlan`, `readoutText`,
the preset arithmetic, `sidebar-panels.ts`, `face-readout-values.ts`,
`FaceSidebar.svelte` and the nine sidebar panel components are all gone.

**THE RULE, and it is a SHAPE rather than a mechanism:** the resting faceplate
paints no derived-state text. The permitted resting text is exhaustively the
module NAME (dock title bar), TAB/SECTION labels, CONTROL CAPTIONS, and
OPTION/LANDMARK NAMES that disambiguate a control's own position. A value, a
measurement, a state word or a sentence has no place — its home is
`aria-valuetext` on the control it describes.

⚠ **Three separate mechanisms have now passed the letter of a prior gate while
violating this** (the resting decimal under a dial → the sidebar `readouts`
block → the hero strip). That is why the gate,
`face-resting-text-source.test.ts`, enumerates the PERMITTED ROLES and denies
everything else: adding any new `ModuleFace` field means writing down which
permitted role its text plays, and a field with no entry is RED on the type
alone, before any module adopts it.

**What was genuinely lost, so nobody re-derives it as a fresh idea:** kick
drum's TAIL really is 398 ms rather than the 450 ms SUB DEC knob; resofilter's
five modes really do collapse to three distinct PEAK/WIDTH pairs; marbles'
CLUSTERS model really does run the COIN generator. Those derivations are still
pinned in the `<mod>-face-model.test.ts` unit lane — they simply have no
renderer, and the owner has ruled that they should not get one. **Do not propose
a "compact" or "hover" version; "there but hidden" was refused by name.**

⚠ **The eight `custom` sidebar PANELS were pictures, not text** (a filter
response curve, illogic's routing map, analogLogicMaths' transfer curve — that
face's only picture, since its `glyph` is `'none'`). They went with the column
because keeping it alive for eight modules would leave the mechanism standing.
There is no in-face home for them today: a PF-14 panel cell's first legal rank
is 7 and these modules have too few rankable keys to reach it. That gap is
filed, not faked.

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

## Rosters make states SELECTABLE — the labels question is a DIFFERENT question

Two questions look like one when you meet a discrete param, and answering only
the first ships an inert control (batch 18, 2026-08-20):

1. **What are the states CALLED?** Promote names that already exist and the shell
   cannot otherwise reach — the gatemaiden shape. `sampleHold`'s ten scale names
   were rendered by its card in its own element above the knob, so a faceplate
   could only ever paint an anonymous ten-position dial; `moog904b`'s LOW/HIGH
   lived in a literal array inside the card. Both are now `options` on the def.
   **Never fabricate semantics a module does not have** — `moog904c`'s `mode` is
   a continuous band-pass↔notch morph whose endpoint names appear only in docs
   prose, so it gets no landmarks from a face migration.
2. **Can a player REACH each state?** A `2..3 discrete` param drawn as a KNOB has
   exactly two reachable positions across the dial's whole travel, so an ordinary
   drag quantises back to where it started. ⚠ **`moog962` shipped that way and
   `faces-parity` failed it on both attempts** — *"moog962 cell 'stages'
   (param/knob): dragging the knob commits a param change into the graph"*. The
   legacy card has the same defect, since it draws the same bare `<Knob>`.

`options` is the ONLY mechanism for (2): `paramCellKind` derives `'segmented'`
from a roster (`'selector'` past `SEGMENTED_MAX_OPTIONS`, and `'knob'` at every
non-dock tier), and `face.paramCells` has no segmented kind to declare. So a
few-state discrete param gets a roster **even when its states have no names** —
label them with their own values, which invents nothing.

⚠ **Export the roster from the def and import it in the card** when the card
renders its own picker — the same ONE-PLACE rule as the ranges above, and for the
same reason: no runtime gate reads a literal in a `.svelte` file, so guard it at
the SOURCE level. `MOOG904B_RANGE_OPTIONS` is the worked example.

A roster is TOTAL by default: assert it against the param's own `min`/`max` span,
never a typed length. `param-vocabulary`'s reason is that a roster skipping a
value leaves a state the dial can reach and the picker cannot name.

---

## Bespoke surfaces — the EXTENSION registry (#1512)

When a module needs more than the generic cells, there is a ladder, and the
extension is its LAST rung — reach for the earlier ones first:

1. **A family/static cell** (`shell-cells.ts` selector/toggle/action/file) —
   the control is one of the shared primitives, driven by a declared spec.
2. **A PF-14 `panel` cell** — ONE picture-you-edit *inside* the generic face
   (an operator map, an envelope editor). Registered in `shell-cells.ts`,
   probe required, dock-only by lint.
3. **A SHELL EXTENSION** — the module needs to fill one of the SHELL'S OWN
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
  declared registries (`shell-cells`, `shell-param-writes`) are typed BOUNDARY
  entries carrying the lints that own them; everything else reddens. Negative-controlled with the exact dx7 import
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
flox activate -- task test:one -- module-face-lint    # order/pages/hero/momentary/paramCells/rear
flox activate -- task test:one -- face-resting-text-source # NO resting derived-state text, any shape
flox activate -- task test:one -- dock-row-plan       # PF-21 packing + totality
flox activate -- task test:one -- dock-faceplate-model # hero split totality
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
`faceplate-platform.spec.ts` annotation sweep.

**NOT registry-driven — you must edit them by hand:**

- `e2e/vrt/workflow-shell-faces.spec.ts:43-77` — the `FACES` roster, with a
  per-scene `pages` count. **Nothing ties it to `STRICT_FACES`.** A promoted
  module missing from this list simply has no VRT scene, silently.
- `e2e/tests/faceplate-platform.spec.ts:151` — `sweepBudgetMs(adopterCount)`
  scales with the roster. Batch 3 took the annotation adopter count from
  1 to 5 and a flat 30 s budget went red on shard 3/10 (measured 6.1 s on a real
  GPU, **14.4 s under `E2E_SWIFTSHADER=1`**).

## The shared files a face PR collides on

Measured off `2d111616` (batch 3, 4 faces, 61 files). These are the conflict
surface — run `flox activate -- task pr:conflict-sweep` after any merge:

| file | why |
|---|---|
| `$lib/ui/workflow/strict-faces.ts` | the promotion set (append) |
| `$lib/ui/workflow/shell-cells.ts` | one `SHELL_CELLS` record |
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

### ⚠ `face` is now FULLY contract-transparent — but `controlFamilies` is NOT

`serializeModuleContract` projects id/min/max/curve/defaultValue/units/ports/
flags, so a re-rank, a page relabel, a hero, a `paramCells` declaration, a
`ParamOption` detent roster and a hint are all free.

**`FACE_FIELDS_IN_LOCK` is now EMPTY.** `face.sidebar` was the one projected
field — it earned its line because #1468 removed a sidebar block from twelve
modules with every non-pixel gate green — and the field itself is deleted, so
there is no block left to pin. That is safe only because the COVERAGE GATE
survives: `contract-lock.test.ts` walks the keys live defs actually declare and
requires each to be projected **or** named in `FACE_FIELDS_NOT_IN_LOCK` with a
`why` and a `coveredBy`, which `tsc` requires you to extend when you add a
field. An empty projected list therefore means "every face key is covered by a
named non-golden gate", asserted — not "nobody checked".

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
branch. Since #1795 that dispatch DERIVES its scope from your branch's diff, so
a single-module face PR captures in ~3 min instead of 41-56; it prints the token
and the test count before dispatching, and falls back to the full sweep loudly
(two modules, or a file it cannot attribute) rather than guessing. There is no pair to add, no ceiling to move, no ledger to re-pin, and no
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
2. **STOP 1** — parity, NOT merit. Thinness never refuses (owner, 2026-08-20:
   *"they still need to be done, <4 params or not"*). Refuse only when the face
   would DROP an affordance the card has — file the blocker (#1974, #2065) and
   stop.
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
   why `order` and `pages` disagree.
9. **Hero.** `cell` / `control` / `action` only — a hero promotes CONTROLS, and
   there is no readout strip to author (see the ⛔ section). If the module has a
   derived quantity worth knowing, it belongs in `aria-valuetext` on the control
   it describes, or in the `docs` prose — never as resting text on the plate.
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
- **`samsloop`-class modules** — but ⚠ **THIS ENTRY USED TO SAY "the shell has no
  file-import OR recorder cell that reaches the dock", AND THE FIRST HALF IS NOW
  FALSE (#2010).** The two were carried as one clause and they have different
  answers:

  - **FILE IMPORT HAS A CELL, and it is generic and shipping.** `ShellFileCell`
    (`shell-cells.ts:180` — `kind: 'file'` with `accept` / `onFile` / a
    status-and-error line) renders at a generic site,
    `ModuleShell.svelte:1080`. **`dx7` is the adopter to copy**: it is in
    `STRICT_FACES`, it RANKS `dx7-syx-input-{n}` in `face.order` (`dx7.ts:213`)
    and it puts it on a DOCK PAGE (`dx7.ts:226`), so a player imports a Yamaha
    `.syx` cartridge from the faceplate today.
  - **THE RECORDER DOES NOT.** samsloop's REC machine — the transport plus
    CHAN/BITS/RATE — has no cell, and that part of the original sentence stands.

  So "samsloop-class is a platform PR" is no longer the right summary. Re-measure
  the specific module: samsloop is **4 params** plus an `accept="audio/*"` loader
  (→ file cell), a loop/one-shot toggle (→ `ShellToggleCell`) and ~9 buttons
  (→ `ShellActionCell`, probe required). Only the recorder is genuinely missing.

  ⚠ **The general lesson, which is why this is written out rather than silently
  corrected.** A stale TEST goes red and gets fixed. A stale SCOPING CLAIM goes
  **quietly green forever** — it produces no failure, only absent work — and it
  reads as a considered architectural boundary rather than a snapshot, so each
  agent who meets it defers instead of re-measuring. Two other modules were
  parked on this one sentence (`wavecel`, recorded as "blocked on two cells that
  do not exist"; `wavesculpt`, whose fourteen card affordances ALL have cells
  today). **Before deferring to any scoping claim in this file, check the
  primitive it says is missing.**
- **Whether the owner will like it.** Design review is not a gate you can run.

## Related

- `module-adversarial-audit.md` — do this first
- `blind-gates.md` — what a gate is structurally unable to see
- `module-docs.md` · `module-pr-checklist.md` · `vrt-failures.md`
- `.myrobots/plans/dx7-and-faces-design-program-2026-07-27.md` §7 (the recipe)
  and `.myrobots/plans/face-specs-round-2-2026-08-01.md` (a 71-defect
  adversarial review of ten drafts — **the defect lists are the valuable half**)
