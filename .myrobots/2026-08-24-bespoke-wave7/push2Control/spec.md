# `push2Control` — BESPOKE FACEPLATE SPEC (wave 7, cohort B)

**Nothing here is implemented. This is a spec.** Measured against `origin/main`
@ `99a961b08`; every claim carries the command or the `file:line` that produced it.

| | |
|---|---|
| def | `packages/web/src/lib/meta/modules/push2-control.ts` (3 605 bytes) |
| card | `packages/web/src/lib/ui/modules/Push2ControlCard.svelte` (13 318 bytes) |
| engine | `packages/web/src/lib/control/push2/push2-control.svelte.ts` + 12 siblings |
| domain | `meta` · `size: '2u'` · `hp: 2` · `maxInstances: 1` |
| ports | **none**, both ways (`push2-control.ts:56-57`) |
| params | **none** (`:58`) |
| inventory | `face-migration-inventory.ts:1036-1042`, `bespoke-surface`, **no blockers** |
| VRT | `EXEMPT_FROM_VRT:687` **and** `ALLOWED_PERMANENT_EXEMPT:1214` |
| docs | ⚠ **no `docs` field, and NOT in `STRICT_DOCS`** — see §8.4 |

> **WHICH SIDE OF THE LANE CARVE-OUT:** ⚠ **NOT in `NON_SHELL_LANE_TYPES`**
> (`legacy-fallback.ts:110-129`) — unlike its two named models, `electraControl`
> and `launchpadControlLeft` — so `laneRenderKind` returns **`'placeholder'`**
> today (`:156-160`) and this module already HAS a shell lane tile, just an empty
> one. Promotion therefore fills a tile that exists rather than creating one, and
> the compact-versus-caption tradeoff is live for this face (a lane tile has no
> section headings, which is what makes `face.bareCells` dock-only). §0.
>
> **WHAT WOULD MAKE IT DRAINABLE** from `ALLOWED_PERMANENT_EXEMPT`: ⚠ **the
> PRE-CONNECT state is fully deterministic and is what a dock baseline captures**
> — two of the exemption's three stated grounds (`:687`) are absences in CI, not
> variability, and the third (a patch-dependent replica) is defeated by a VRT
> scene that spawns `push2Control` ALONE, leaving lane 1 empty and the canvas
> painting its stable `card.empty` picture. §7.2.

---

## 0. THE HEADLINE — THIS IS `midiclock` #2187 AGAIN, WORD FOR WORD, AND THE PR TITLE IS THE PROOF

The merged commit that promoted this cohort's predecessor reads:

> `40ca0622b feat(faces): PROMOTE midiclock — **the CONNECT gesture was DOCK-ONLY
> on a module that is inert until it is pressed**, and the clock division was never
> a param at all (#2187)`

Both halves of that sentence are true of `push2Control`, and the first one is true
*more strongly*, because this module has **no jacks at all** — there is not even a
cable to prove it exists.

**The mechanism, derived rather than assumed** (`legacy-fallback.ts:156-160`):

```ts
export function laneRenderKind(i: LaneRenderInput): LaneRenderKind {
  if (i.userDocked) return 'stub';
  if (!i.shellFaces || !i.hasCard) return 'legacy';
  return i.migrated ? 'shell' : 'placeholder';
}
```

and `hasCard` is not "a card exists" — `LaneRenderInput`'s own doc (`:137-138`)
says *"The type resolves to a real card **AND is not a `NON_SHELL_LANE_TYPE`**"*,
computed by `isShellSwappable` (`:181-183`).

`push2Control` **is not** in `NON_SHELL_LANE_TYPES` (`:110-129` — the set is
`group`, `sticky`, `cadillac`, `clipplayer`, `controlSurface`, `electraControl`,
`launchpadControlLeft`). ⚠ **That is the wave's most surprising single fact and it
splits this cohort in half**: its two sibling hardware surfaces, `controlSurface`
and `launchpadControlLeft`, ARE carved out and keep their verbatim card in the
lane. `push2Control` — built explicitly *"Modeled on ElectraControl /
LaunchpadControl"* (`push2-control.ts:41-43`) — was never added to the set.

So today, at plain `/rack`:

* `push2Control` → `hasCard: true`, `migrated: false` → **`'placeholder'`**;
* `launchpadControlLeft` → `hasCard: false` → **`'legacy'`**, the real card.

Two modules with the same header, the same domain, the same zero-port shape, and
opposite lane renders.

**What the placeholder is, and what it is not.**
`ModuleShellPlaceholder.svelte:2-10` is candid: *"a REAL RACKLINE tile, not a
stub… differing only in the body (no ranked knobs until the module gets a
`face`). The module's REAL, unchanged `*Card.svelte` opens verbatim in the bottom
dock full-view (DockFullView)."* So nothing is *lost* — the surface is **DOCK-ONLY**.
For a module that does nothing whatsoever until `Connect Push 2` is pressed, and
whose only jacks are a physical USB cable, dock-only is precisely the defect
#2187 was filed against.

⚠ **AND THE SHIPPED GATE CANNOT SEE IT.** `push2-clip-launch.spec.ts:24` imports
the `rack` fixture, and `e2e/tests/_fixtures.ts:91-93` is
`page.goto('/rack?shell=legacy&seed=none')` — with the fixture's own comment
(`:76-83`) stating *"the bare default `/rack` renders each module as a FACEPLATE
tile… so a module's own card testids do not exist in the lane."* The spec that
proves the pads reach audible RMS therefore runs in **the one shell where the
placeholder cannot exist**. It is green, it is correct, and it certifies a surface
no default-shell user is looking at. This is CLAUDE.md's *"a gate whose
precondition is the defect cannot fail on the defect"*, arriving from the far
side — the precondition here excludes the defect rather than manufacturing it.

**Verdict preview: PROMOTE.** §10.

---

## 1. THE PRIMARY INTERACTION — A REPLICA OF A PHYSICAL SCREEN, PAINTED BY THE SAME DRAW OPS

Everything else on this plate is scaffolding around one object.

`Push2ControlCard.svelte:9-18`, the card's own header, states it and states why:

> **THE PREVIEW IS THE POINT.** This card renders EXACTLY what the 960×160 panel
> paints, through the exact same draw ops, into a canvas scaled to the card width.
> That makes the whole feature — schema, lane selection, curve math, layout —
> visible and testable with NO HARDWARE ATTACHED, which is the only reason any of
> it could be built without a Push on the desk. It reads the SHARED
> `pushDisplayOps()` seam rather than re-deriving the card, so while the hardware
> LEGEND button is held this preview shows the legend too — **one seam, so the
> preview cannot disagree with the panel about what is on screen.**

The implementation is four lines (`:88-97`): `paintPushOps(ctx, pushDisplayOps())`
into a `<canvas width={PUSH_SCREEN_W} height={PUSH_SCREEN_H}>`, where those are
`960` and `160` (`push-screen-layout.ts:39-40`).

**Three properties follow, and each one decides something later in this spec.**

1. **It is a REPLICA, not a visualisation.** There is no second renderer to drift.
   That is why the resting-text question resolves cleanly (§2.5) and why the width
   argument is arithmetic rather than taste (§5).
2. **It paints ANOTHER NODE'S CONTROLS.** The strips are the current lane's
   focused module's params — name, bar graph, formatted readout, one per encoder
   (`push-card-config.ts:7-11`). ⚠ The VRT exemption says so as the reason it
   cannot be baselined: *"the push-card preview canvas renders whatever module
   happens to be in lane 1, so the card face is patch-dependent"*
   (`vrt-exemptions.ts:687`).
3. **It is a 2-D context.** `Push2ControlCard.svelte:91` is
   `c.getContext('2d')`. This is not a detail — see §8.1, where it is the whole
   attest answer.

**The rest of the surface exists to steer the replica**: which lane (8 buttons),
which module within that lane (a ‹ › flip), which of the four Launchpad-parity
views, and the two connection gestures that make any of it reach hardware.

---

## 2. THE RESTING-TEXT CENSUS — every string the card paints, with a verdict

Permitted resting text, exhaustively: module NAME, TAB/SECTION labels, CONTROL
CAPTIONS, and option/landmark NAMES that disambiguate a control's own position
(CLAUDE.md, *"Faceplate chrome"*). The settled discriminator, applied throughout:
**text inside a control that SELECTS it is an option name; the same text painted
OUTSIDE every control, restating what is selected, is a readout.**

| # | what it is | where | verdict | replacement |
|---|---|---|---|---|
| 1 | `Web MIDI isn't available in this browser — connect a Push 2 in Chrome/Edge.` | `:143-145` | ✅ **KEEP** — an ERROR, absent whenever nothing is wrong; midiclock's `accessMessage` precedent (`face-rack-status-source.test.ts:466-472`) | — |
| 2 | `{connected ? 'Re-connect Push 2' : 'Connect Push 2'}` | `:154` | ⚠ **KEEP, BUT PIN THE CAPTION** — see §2.1 | a literal `Connect Push 2` |
| 3 | `{bound ? 'Unbind clip-player' : 'Bind to clip-player'}` | `:163` | ⚠ **KEEP** — see §2.1 | unchanged; it is a real two-state action |
| 4 | `Connect display` | `:172` | ✅ **KEEP** — a control caption on its own button | — |
| 5 | the flip label: `{card.title}` | `:199-200` | ⛔ **REMOVED** — a derived NAME painted OUTSIDE every control (§2.2) | the canvas already paints it; `aria-label` on the flip group |
| 6 | `{card.index}/{card.count}` | `:201` | ⛔ **REMOVED** — a MEASUREMENT, and a population count at that (§2.2) | `aria-valuetext` on the flip control |
| 7 | lane buttons `{c + 1}` (1–8) | `:220` | ✅ **KEEP** — option NAMES inside the controls that select them, with `aria-pressed` already correct (`:218`) | — |
| 8 | view buttons `GRID` `CLIP` `ARR` `CTRL` | `:129-134`, `:238` | ✅ **KEEP** — same; a four-option roster, each name on its own button | — |
| 9 | `No Push 2 detected — plug one in, then Connect Push 2.` | `:243` | ✅ **KEEP** — an ERROR (row 1's argument) | — |
| 10 | `Not connected.` | `:250` | ⛔ **REMOVED** — a STATE WORD about the module, the deleted hero-readout shape | the `PUSH` `StatusLed` |
| 11 | `Driving clip-player <code>{bound}</code> — <b>{activeView}</b> view.` | `:252` | ⛔ **REMOVED** — a sentence with a derived node id AND a derived state word (§2.3) | `BOUND` lamp + `detail`; the view is already row 8's pressed button |
| 12 | `Push 2 ✓ — hit Bind to drive your clip-player.` | `:254` | ⛔ **REMOVED** — instructional copy that is **not** an empty state (§2.4) | the `BOUND` lamp being dark next to a live `Bind` button |
| 13 | `Push 2 ✓ — add a clip-player module to drive (auto-binds it).` | `:256` | ⚠ **KEEP, RESHAPED** — this one IS an empty state (§2.4) | kept, but only in the genuinely-empty branch |
| 14 | `Screen not connected ({displaySt}) — hit Connect display. The pads and encoders work without it.` | `:261-262` | ⛔ **text REMOVED**, and it carries a real finding (§2.3) | the `SCREEN` lamp; `displaySt` to `detail` |
| 15 | `No WebUSB here — the on-device screen needs Chrome/Edge. Everything else still works; the card above shows what the screen would.` | `:266-267` | ✅ **KEEP** — a CAPABILITY ERROR, row 1's argument | — |
| 16 | `Colour guide + control map → right-click → View docs.` | `:273-274` | ⛔ **REMOVED** — a PERMANENT sentence, chromaconsole's open-loop shape exactly (§2.6) | — (relocation, see §2.6) |
| 17 | **the 960×160 canvas** — 8 × (name + bar + readout), or the LEGEND grid | `:182-191` | ✅ **KEEP, ENTIRELY** — and this is the module's whole argument (§2.5) | — |

### 2.1 A BUTTON CAPTION THAT CHANGES IS NOT AUTOMATICALLY A READOUT — but one of these two is

Rows 2 and 3 look identical and are not.

`status-led-source.test.ts:15-18` names the temptation precisely — *"interpolate
`detail` into the caption 'just so it is visible without hovering'"* — and
`face-rack-status-source.test.ts` holds the call-site half by requiring a
**string LITERAL** caption on a declaring body. That rule is about `StatusLed`.
It does not, and should not, forbid a `<button>` whose label names the action it
will perform: `Play`/`Pause` is a caption, not a measurement.

The discriminator that separates the two rows here is **whether the label names a
DIFFERENT ACTION or the SAME ACTION plus a state word**:

* **Row 3, `Bind` / `Unbind`** — two genuinely different actions on one control
  (`toggleBind`, `:122-125`, branches on `boundClipNode()`). The label names which
  one will fire. ✅ **KEEP.**
* **Row 2, `Connect Push 2` / `Re-connect Push 2`** — ⚠ **one action.** `connect()`
  (`:113-120`) does not branch: it calls `connectPush()` and auto-binds, identically,
  in both states. The `Re-` prefix carries **no information about the gesture** and
  exactly one bit about the module's state. That is a state word wearing a caption's
  clothes. **Pin it to the literal `Connect Push 2`** and let the `PUSH` lamp carry
  the bit, which is what the lamp is for.

⚠ **Nothing in the tree enforces this.** `status-led-source` reads ONE primitive
(`:31-33`: *"A module that hand-rolls its own `<span>3 skipped</span>` is invisible
here"*); `face-resting-text-source` reads FACE FIELDS. A `<button>` caption in a
`fullViewBody` is seen by **the dock VRT baseline and a human reading it**, and by
nothing else. Stated, not implied — per this repo's standing preference.

### 2.2 THE FLIP LABEL — the finding that lapses, and the one that does not

Rows 5 and 6 are one element (`:199-202`) and they lose different things.

* **`{card.title}` (row 5) LOSES NOTHING**, and this is the cleanest deletion in
  the wave: the canvas immediately above it **already paints the module's name**,
  in the card header the hardware itself shows (`push-screen-layout.ts:50-52`,
  `HEADER_H = 24`). The DOM label is a second copy of a string the picture is
  drawing three pixels higher. Deleting it is not a trade; it is removing a
  duplicate.
* **`{card.index}/{card.count}` (row 6) LOSES A REAL FINDING**, and it must be
  named rather than allowed to lapse: *there are N modules in this lane and you are
  looking at the i-th* — the only thing on the plate that tells a player the ‹ ›
  buttons have anywhere to go. Without it, a lane with one module and a lane with
  six are the same picture. **It goes to `aria-valuetext` on the flip control**,
  which is speakable, assertable and unpainted.
  ⚠ *A sighted player operating the flip gets nothing.* That is the ruling's
  intended trade, exactly as wave 5 recorded for the channel-override badge
  (`BINDERS.md §2.2`), and it is stated here rather than smoothed over.
  ⚠ Note also that row 6 is *"a count of a population"* rendered into the UI —
  derived at runtime, not a typed literal, so **not** the construct CLAUDE.md's
  ratchet section forbids and **not** a bug to go fix. Noted only because that
  section trains you to look at the shape twice.

### 2.3 THE `Driving clip-player {bound}` SENTENCE AND THE `({displaySt})` PARENTHESIS

Row 11 is the module's largest single deletion and its finding is genuinely
important: **which clipplayer node this Push is driving.** With `maxInstances: 1`
there is exactly one Push and potentially many clipplayers, so "bound" without
"to what" is materially less useful.

It survives on `StatusLed`'s `detail`, which reaches `aria-label` and `title` and
never a text node. `StatusLed.svelte` is *"the ONLY status surface a face may
use, shaped so the refused form cannot be expressed"* — **there is no `value`
prop**, so a caller cannot regrow the sentence by accident; adding one is an edit
to a gated file (`status-led-source.test.ts`).

Row 14's `({displaySt})` is the same shape one size down: a raw status string
interpolated into a hint. It goes to the `SCREEN` lamp's `detail`. ⚠ **And the
`tone` axis carries the part that actually matters** — `tone: 'accent' | 'warn'`
distinguishes a FAULT from a readiness **in colour, not text**, which is exactly
the distinction row 14's parenthesis was making badly.

**Three lamps, and they are the whole status surface:**

| caption | `lit` when | `detail` carries |
|---|---|---|
| `PUSH` | `isConnected()` | the device name, or the failure outcome |
| `SCREEN` | `isDisplayConnected()` | `displayStatus()` — and `tone:'warn'` on a decline, `'accent'` when merely absent |
| `BOUND` | `boundClipNode() !== null` | the bound node's display name and the active view |

⚠ **`SCREEN` unlit is NOT a fault and the tone must say so.** `push2-control.ts:38-41`:
*"The 960×160 display runs over WebUSB and **degrades to nothing** if it is
unavailable or declined — pads and encoders keep working over Web MIDI."* A warn-
toned lamp on the default path would be a lie in the opposite direction from the
one the ruling usually guards against.

### 2.4 TWO SENTENCES THAT LOOK ALIKE; ONE IS AN EMPTY STATE AND ONE IS NOT

Rows 12 and 13 differ by a condition and the ruling turns on it.

Wave 6 §4.1 settled the empty-state shape (`samsloop`'s `NO SAMPLE LOADED`,
`twotracks`'s `NO TAPE`, matrixMix's *"Pick an X-axis + Y-axis module"*): *a
placeholder naming the surface's own condition is not a measurement of any
control*, and it is **REPLACED by the surface the moment the surface exists.**

* **Row 13** fires when `!hasClip` — there is **no clipplayer in the patch at
  all**. There is nothing to bind, no surface to replace it, and no control on the
  plate whose state it restates. That is the empty state, and it survives.
* **Row 12** fires when a clipplayer exists and `Bind to clip-player` is sitting
  right there, live, three rows up. The sentence restates the state of a control
  that is on screen. ⛔ **That is a readout of a button.**

### 2.5 THE CANVAS — the fleet's strongest instance of the in-canvas-text ruling, and it is not close

Row 17 is 960×160 pixels of names, bar graphs and **formatted numeric readouts**
(`push-screen-layout.ts:53-64`: `LABEL_Y`, `BAR_Y`, `VALUE_Y`, `VALUE_H`). Under a
literal reading of the resting-text ruling that is a wall of refused text.

The ruling on this was already made, in wave 5's `GAMES.md:59-65`:

> Pixels the MODULE renders into its OWN surface are a different object. They are
> the module's artwork, not the face's chrome … The face is not painting the
> number; the game is.

**Applied here it is not merely satisfied — it is the strongest case the fleet
has, and for a reason no other module can claim.** Every previous instance was
about pixels a module *chose* to draw. These pixels are **a byte-accurate replica
of a physical object that exists off-screen**, painted by `pushDisplayOps()` — the
exact op list already on its way to a 960×160 OLED over WebUSB
(`Push2ControlCard.svelte:14-18`).

Three consequences, in ascending order of usefulness:

1. **Deleting the canvas text would not remove a readout from the product.** The
   hardware still paints it. It would only make the on-screen copy *disagree with
   the hardware*, which is the one property the shared-seam design was built to
   make impossible.
2. **The replica is the only place the feature is reviewable without hardware**
   (`:11-14`), which is a testability argument, not an aesthetic one.
3. ⚠ **A "compact" replica would be worse than either extreme.** Half the strips,
   or the bars without the values, is *"there but hidden"* applied to a picture of
   a real object — refused by name, and here it would additionally be **wrong**,
   because the whole contract is that this canvas and that panel show the same
   thing.

⚠ **NO GATE SEES ANY OF THIS.** `face-resting-text-source.test.ts` reads
`ModuleFace` FIELDS and is blind to a body's markup by its own admission, and
canvas pixels are invisible to every source gate in the tree. **The enforcement is
the dock VRT baseline and a human reading it** — which is exactly why
`EXTENSION_BODY_ROLES` requires this body to write down what its canvas draws
(§7.3). Naming the gap is required; implying a gate covers it is the failure this
repo cares most about.

### 2.6 THE DOCS HINT — DELETE, on wave 5's narrow ground, and the ground holds here

Row 16 (`:273-274`) is a **permanent** sentence — outside every conditional, true
at every moment, therefore carrying no per-moment information. That is the
definition of resting text, and wave 5 `BINDERS.md §2.3` decided the identical
case for `chromaconsole` and took the deletion.

Its narrow ground was that the text **survives verbatim elsewhere**, making the
change a RELOCATION rather than a coverage loss. **That ground holds here and is
stronger**, because the sentence is not content at all — it is *navigation
instructions to content that already exists*:
`module-guides.ts:39-41` registers `push2Control → /docs/modules/push2Control`,
and `packages/web/src/routes/docs/modules/push2Control/+page.svelte` is a real,
shipped page. The right-click Annotate route reaches it whether or not a line on
the plate says so.

⚠ **And it is the wrong instruction for a faceplate anyway** — it names a
right-click on a *card*, and after promotion the card is not what a player is
looking at.

---

## 3. WHERE THE STATE LIVES — a FIFTH location the running census cannot express

Waves 3–6 have tracked a `.data` census with four states: params; `node.data`
transacted + `LOCAL_ORIGIN`-tagged; `node.data` transacted untagged
(`chromaconsole`, wave 5 §4); `node.data` bare proxy write. Wave 6 sharpened it to
**per CALL SITE, not per module.**

**`push2Control` is a fifth state and the census's shape cannot hold it: NONE OF
ITS STATE IS IN THE DOCUMENT.**

Measured — `git show origin/main:packages/web/src/lib/control/push2/push2-control.svelte.ts | grep -n 'localStorage\|mutateNode'`:

| what | where it lives | line |
|---|---|---|
| selected lane (0–7) | `localStorage[STORAGE_KEY_CHANNEL]` | read `:154-157`, write `:449` |
| electra row | `localStorage[STORAGE_KEY_ELECTRA_ROW]` | read `:165`, write `:310` |
| binding, shift, legend, electra mode, focus | module-level `let` in the `.svelte.ts` | `:126-146` |
| LED + display frames | transient render state | `:871-875` |

`mutateNode` appears **zero** times in `push2-control.svelte.ts` and zero times in
`Push2ControlCard.svelte`. Every `.data` hit in the engine file (`:512`, `:530`,
`:559`, `:635`) is a **READ of somebody else's node** — the clipplayer's lane
colours and the pinned mixer's columns.

⚠ **The `.data` census's binary column would score this module ✓ (no untagged
writes) for a reason that is a tautology: it never writes.** Same shape as wave 6's
`recorderbox` finding — an absence from a derived set that is a property of the
probe, not of the subject.

### 3.1 ⚠ AND IT MECHANICALLY FORCES THE FACE'S SHAPE

This is the single most consequential paragraph in the spec.

The def is explicit that the placement is deliberate (`push2-control.ts:41-44`):
*"all hardware state is per-machine local; LED and display frames never touch the
Y.Doc"*, and the engine repeats it (`push2-control.svelte.ts:44-46`) — *"Binding,
selected lane and lane focus are per-machine LOCAL."*

**It is also correct, and not merely a convenience.** Two collaborators on one
rack each have their own Push, each on their own lane. Syncing `selectedChannel`
would make one player's lane button move the other player's hardware screen. The
per-machine placement is a multiplayer-correctness decision.

**Therefore:**

* A **control FAMILY** is a `node.data`-backed picker — `push-card-config.ts:67-72`
  describes `dx7`'s preset selector as *"a control FAMILY (`node.data`-backed
  picker)"*. **The 8 lane buttons cannot be a family cell without moving
  `selectedChannel` into the Y.Doc, which would be a multiplayer regression.**
* An **ACTION cell** is unconstrained — it fires a function. `shell-cells.ts:1405-1408`
  states the idiom: *"It takes the nodeId and not the `env` handle: `fireManualStrike`
  resolves the live engine itself through `getActiveEngine()`, which is what lets a
  Svelte card with no ShellCellEnv share it."* `push2Control`'s actions do not even
  need the engine — `connectPush()` and `toggleBind()` are plain module functions.

So: **CONNECT is a cell; the lane select, the view select and the flip are body
controls.** Not by preference — by where the state lives. §4 is that conclusion
written out.

⚠ **This is a THIRD independent route past wave 4's `env`-for-selectors ask.**
Wave 5 `BINDERS.md §1` disproved it on capability grounds (`ShellCellEnv.engine`
is `{ write }` with no `read`; `getActiveEngine()` already exists). Wave 6 §2.1
disproved it on reach grounds (a roster on `raw.githubusercontent.com` is not
behind the engine). **`push2Control` disproves it on a third axis: its roster is
`localStorage`, which no engine handle of any shape reaches.** The ask is not
re-proposed here, and this is the third distinct reason not to.

---

## 4. THE FACE

```ts
export const PUSH2_FACE: ModuleFace = {
  glyph: 'none',
  order: ['push2-connect-{n}'],
  extension: 'push2Control',
  pages: [
    {
      id: 'surface',
      label: 'surface',
      hint: '…',                       // see §4.3
      controls: ['push2-connect-{n}'],
    },
  ],
};
```

### 4.1 `order` IS ONE ACTION CELL, and the module has no params to rank

`params: []` (`push2-control.ts:58`), so *"a face must rank every param"* is
vacuous — `videoOut`'s `order: []` is the shipped precedent for a face that ranks
nothing at all. This face ranks one thing, and it is the gesture the module is
inert without.

**Why exactly one, and not two or three:**

* **CONNECT PUSH 2 → RANKED.** midiclock's face argues the case and the argument
  transfers verbatim (`midiclock.ts:283-289`): *"only the `panel` kind is dock-only
  … an `action` cell is not restricted … So the CONNECT gesture stops being
  reachable only from the dock full view, which on a module that does NOTHING
  until it is granted access is the single biggest thing promotion changes for a
  player."* Here the module does nothing until it is granted access **and has no
  jacks**, so it is the *only* thing promotion changes for a player.
* **CONNECT DISPLAY → BODY.** It is conditional in the card
  (`{#if usbOk && !displayOn}`, `:168`) and it is *never required* by design. A
  cell is unconditional; an unconditional cell that is a no-op on every machine
  without WebUSB is a control that looks alive and isn't — the same defect shape
  `param-vocabulary.test.ts:153` names for a non-snapping options param.
* **BIND / UNBIND → BODY.** Conditional on `connected && (bound || hasClip)`
  (`:157`), i.e. on the presence of a *different module* in the patch. Same
  argument. ⚠ And it is **auto-fired by `connect()` already** (`:119` → `autoBind()`),
  so the common path never needs it.
* **THE 8 LANE BUTTONS → BODY, and #2181 is why it would be one cell if it could
  be.** A family key is ONE cell for ALL instances, so eight lane buttons would be
  a single `push2-control-ch-{n}` cell — not eight. It is moot here only because
  §3.1 forbids a family cell over `localStorage` state. **The ruling is satisfied
  in the body too**: the eight buttons are rendered from one `{#each CHANNELS}`
  (`:212-224`), one control with eight positions, not eight controls.

⚠ **No tab rail.** `face.tabbed` is owner-instruction-only and a rail must never
be padded to reach `DOCK_TAB_MIN_BANDS`. One ranked cell and one body is one
honest page. The owner ruling on control-heavy tabbed faces is about *"many
controls of DIFFERENT types"*; this face has one cell.

### 4.2 `glyph: 'none'` IS MECHANICALLY FORCED — and here for a reason that is actually true

`outputs: []` (`push2-control.ts:57`), so `primaryAudioOutPortId`
(`outputs.find(o => o.type === 'audio')?.id`) resolves null, no `live-audio`
binding is reachable, every literal falls through to `{ kind: 'static' }`, and
`module-face-lint`'s dead-glyph clause reddens it unconditionally with no
exemption list. This is midiclock's paragraph (`midiclock.ts:262-268`) with a
stronger premise: midiclock has four non-audio outputs, this has **zero outputs**.

⚠ **Wave 6's defect-ledger item 8 warns that `strict-faces.ts:835-837` and
`picturebox.ts:309` reach the right answer from a FALSE premise** (*"a video def
has no `audio` output"* — false for `archivist`, `peertube`, `videocube`,
`milkdrop` and others). **That warning does not apply here**: this def has an
empty `outputs` array, so the premise is true by inspection, not by luck. Recorded
because the wave-6 note trains you to check, and checking is cheap.

**The glance this module wants still does not exist**, and this is the fifth
module in three waves to say so: *is the surface bound, and is traffic flowing?*
— a BINDING STATE plus an EVENT RATE, where all five `VALID_GLYPHS` members
describe a continuous audio quantity. Wave 4 argued it for `midiclock`; wave 5
raised it to four modules; this is five. **No spec invents one.** A new glyph kind
on a module PR is the wrong shape, and the refusal is more defensible with more
evidence, not less.

### 4.3 THE PAGE HINT — the one place prose is allowed, and it should carry the WebUSB fact

`face.pages[].hint` is authored prose, not painted chrome (midiclock's is 60 words,
`midiclock.ts:293-299`). It is where row 15's capability sentence and the deleted
row 16's navigation instruction belong. Draft:

> The Push 2 is two devices in one cable. **Connect Push 2** is the Web MIDI
> gesture — pads, encoders and the eight lane buttons — and it is all this module
> needs. **Connect display** is a *separate* WebUSB permission for the 960×160
> screen; declining it, or running a browser without WebUSB, costs you nothing but
> the on-device picture, and the preview on this plate shows exactly what that
> screen would. The eight display encoders turn the eight controls of whichever
> module the selected lane is showing — that choice is an owner-editable text
> schema, not a fixed map.

---

## 5. WIDTH — EARNED, and the burden of proof is discharged in arithmetic

**Compact is the default. Width must be EARNED and the burden is on the wide
face.** Gates: `face-width-source.test.ts` (`packages/web/src/lib/ui/dock/`) plus
the per-face content-vs-plate measurement in `workflow-shell-faces.spec.ts`.

⚠ **The gate's current state, verified:** `PLATE_FLOOR_EXEMPTIONS` is `[]`
(`face-width-source.test.ts:88`) — **empty**, with `PLATE_SCALE_PX = 100` (`:79`)
and `WIDTH_CHAIN = ['_dock-faceplate.css']` (`:70`). Its failure message is
*"the DEFAULT is wrong — fix the default. Per-module hatches are how `min-width:
900px` happened"* (`:173`). **So this face must NOT add a `min-width` to the width
chain.** The width it needs is the BODY's own, which is a different mechanism —
the body is content, and `workflow-shell-faces.spec.ts`'s content-vs-plate leg is
what audits it.

**The measurement.** The replica is 960 backing px across `STRIP_COUNT = 8` strips
(`push-screen-layout.ts:42-46`): `STRIP_W = 120`, `STRIP_CONTENT_W = 104`, with a
`VALUE_H = 32` px readout and a `LABEL_H = 24` px name inside each.

| CSS width | scale | per-strip content | verdict |
|---|---|---|---|
| 960 px | 1.00× | 104 px | pixel-exact everywhere; far too wide for a dock plate |
| **480 px** | **0.50×** | **52 px** | **pixel-exact at DPR 2; half-res at DPR 1** ← proposed |
| 340 px (today's card) | 0.354× | 36.8 px | a 32 px readout renders at 11 px — the numbers stop being numbers |
| 192 px (a lane tile) | 0.20× | 21 px | eight bars, no legible text at all |

**480 CSS px is the smallest width at which the replica is still a replica**, and
it is the number this face should use. Below it, the thing the module exists to
show stops being readable, which is the definition of a width that was needed
rather than taken.

⚠ **Two honest caveats, both stated rather than smoothed:**

* **Linux CI runs at DPR 1**, so the committed dock baseline captures the
  half-resolution case, not the pixel-exact one. That is the correct thing to
  baseline (it is what most desktops show) but it means **the baseline cannot
  prove the 1:1 case is right.**
* `DOCK_MAX_DIFF = 1500` px *"cannot see a short caption change"*
  (`_shell-faces.ts:3556`, wave 6 §3.2). Since this body's whole content is
  rendered text, **the wording and legibility are verified by eye on the committed
  PNG, never by the gate**, and `--update-snapshots` cannot repair a
  passing-but-stale baseline anyway.

**The def already conceded this argument once**, for the card, in its own words
(`push2-control.ts:60-65`): *"the card now carries a 960×160 PUSH-CARD PREVIEW
(CSS-scaled to the card width) plus the card-flip row above the lane buttons,
which takes its natural height past the 180 px a 1u allows. `card-control-overflow`
measured 201 px of content in a 180 px card — the def is the ONE place that height
is declared, so it moves here rather than the preview being shrunk to fit."*
⚠ Note the shape of that decision: **the preview was NOT shrunk to fit.** The same
call, made independently on the height axis two months earlier, for the same
reason.

---

## 6. THE LANE TILE AT 1/8 SIZE

**Today: `ModuleShellPlaceholder` — a RACKLINE tile with a domain spine, the name,
a type badge, a live domain glyph and the `PatchPanel` jack rail.** With `inputs:
[]` and `outputs: []` the rail is empty, so the tile is a name and a badge.

**After: `ModuleShell` with one ranked action cell.** The tile gains **`Connect
Push 2`**, and that is the entire user-visible change in the lane. It is also the
whole point (§0).

**The body does NOT reach the lane, and must not.** It is dock-only by
`dockFullViewHeadPlan`, the same disposition midiclock's extension states
(`shell-extension.ts:33-35`): *"a 192 px lane tile cannot carry a module surface."*
At 192 px the replica scales to 0.20× (§5) and is eight coloured bars with no
legible text — a picture that misrepresents the hardware, which is worse than no
picture.

⚠ **`hasVideoSurface` is false** (`domain: 'meta'`), so the `VideoTileThumb` route
`ModuleShellPlaceholder` uses for video modules does not apply, and there is no
free lane picture to inherit.

---

## 7. THE FOUR GATES A FACE PR MUST SATISFY (plus the SNAP contract)

### 7.1 the face lints / `STRICT_FACES` promotion anchor

`module-face-lint.test.ts`; the set is asserted EQUAL to the set of defs declaring
a `face`, **in both directions**, so *authoring the `face` IS the promotion* and
there is no count to maintain. Nothing to add by hand.

⚠ Two legs this face has to clear specifically: the **dead-glyph clause**
(satisfied by `glyph: 'none'`, §4.2) and the **rank-every-param** leg (vacuous,
`params: []`).

### 7.2 the VRT baselines — **PREDICT 3 FILES, NOT 2**

Linux CI authors them; nobody commits a PNG.

⚠ **Dispatch with `GREP=push2Control flox activate -- task vrt:commit`, NOT a bare
`task vrt:commit`.** The scope derivation *"reads PATHS ONLY"* (CLAUDE.md, VRT
section) since the diff-content tokenizer was deleted 2026-08-23, and **a face PR
always touches a shared roster file whose path names no module — so a bare dispatch
DERIVES FULL**: 41-56 min unscoped against ~3 min scoped (#1795).

**The drain is a two-line edit and both lines are anchored:**

1. `EXEMPT_FROM_VRT:687` — delete the entry.
2. `ALLOWED_PERMANENT_EXEMPT:1214` — delete `'push2Control'`. ⚠ That set is
   ANCHORED IN BOTH DIRECTIONS (`vrt-exemptions.ts:1197-1199`: *"an entry here
   naming a module that is NOT in `EXEMPT_FROM_VRT` is RED"*), so leaving the name
   behind after the drain is a red gate, not a stale comment. The two `midiclock`
   deletion notes at `:1216-1222` are the shipped precedent for the mechanics and
   for the comment style.

**The file count, derived rather than guessed.** `vrt.spec.ts:52` builds
`COVERED_MODULES` as `REGISTRY.filter(m => !(m.type in EXEMPT_FROM_VRT))`, so a
drain enrols the **legacy card** as well as the two face scenes. `midiclock`'s
committed artefacts confirm the arithmetic exactly —
`git ls-tree -r --name-only origin/main | grep -i midiclock` returns three PNGs:

```
e2e/vrt/__screenshots__/vrt.spec.ts/midiclock.png                              ← the legacy CARD
e2e/vrt/__screenshots__/workflow-shell-faces.spec.ts/face-midiclock-compact.png
e2e/vrt/__screenshots__/workflow-shell-faces.spec.ts/face-midiclock-dock.png
```

**So: 3 files** — `vrt.spec.ts/push2Control.png`,
`workflow-shell-faces.spec.ts/face-push2Control-compact.png`, and
`…/face-push2Control-dock.png`. Count what the bot commits against that number; a
green dispatch that commits nothing is a red flag.

⚠ **AND THIS MODULE MAY NOT SURVIVE THE DRAIN — the exemption's stated reason is
partly still true.** `:687` gives three grounds and they do not fail together:

| ground | still true? |
|---|---|
| *"Connect/Bind state absent in CI"* | ✗ — the **pre-Connect** view is deterministic, which is the exemption's own concession, and it is what the dock baseline would capture |
| *"view segment absent in CI"* | ✗ — same; the view row is `{#if connected}` (`:236`) and is simply not there |
| *"the push-card preview canvas renders whatever module happens to be in lane 1, so the card face is patch-dependent"* | ✅ **STILL TRUE**, and it is a property of the FEATURE, not of the environment |

**Recommendation: drain, and pin the scene.** The VRT scenes in `_shell-faces.ts`
control the spawned patch; a scene that spawns `push2Control` **alone** has an
empty lane 1, so the canvas paints its deterministic *empty* card
(`card.empty`, `Push2ControlCard.svelte:188`, `:200`). That is a stable picture and
it is the honest fresh-spawn state.

⚠ If it turns out not to be stable, the correct move is a **NAMED
`FACES_WITHOUT_SCENES` entry** (`_shell-faces.ts:3391`) carrying that reason — not
a silent absence, and not a re-exemption.

### 7.3 `EXTENSION_BODY_ROLES` — role `picture`

`packages/web/src/lib/ui/workflow/face-rack-status-source.test.ts:150`.
Deny-by-default over every `fullViewBody`, membership derived off the DIRECTORY,
a **mechanical predicate per role**, and a `why` **required by the type** (`:146`:
*"Required — `tsc` refuses the bare form"*).

⚠ **THE ROLE SET IS THREE, NOT TWO — verified on `origin/main` today**, because
wave 6's README explicitly recorded it as two and named `control-grid` as a
non-existent role from an open PR. It has since merged. `git show
origin/main:…/face-rack-status-source.test.ts` gives `:143`
`type BodyRole = 'picture' | 'status-primitive' | 'control-grid';` and the anchor
at `:805-825` is now a **SET IDENTITY** between the roles the type defines and the
roles the roster uses, asserted in both directions — no longer the hand-typed pair
wave 6 describes. **Read the merged file; do not inherit either snapshot.**

**This body is `picture`.** `ROLE_PREDICATE.picture.holds = paintsCanvas(src, extId)`
(`:560-566`) and this body mounts a `<canvas>` directly. The predicates are ordered
by the canvas test, so a body that keeps a canvas *and* uses `StatusLed` is legally
`picture` — which is this body exactly (three lamps, §2.3). ⚠ It is **not**
`control-grid` despite being a grid of controls: that role's predicate is
`/aria-label=/.test(src) && !paintsCanvas(...)` (`:600-602`), and *"a canvas would
make it a picture"* is the predicate's own stated reason.

**The `why`, as it would be committed:**

> `push2Control: { role: 'picture', why: '` a **PIXEL-EXACT REPLICA of the Push 2's
> physical 960×160 OLED**, painted by `paintPushOps(ctx, pushDisplayOps())` — the
> SAME op list already on its way to the hardware over WebUSB, so the plate and the
> panel cannot disagree about what is on screen — plus the eight LANE buttons, the
> card ‹ › flip, the four view buttons, the two connection gestures and the
> PUSH/SCREEN/BOUND lamps. ⚠ **THE CANVAS PAINTS ANOTHER NODE'S CONTROLS**: eight
> strips of name + bar + formatted readout belonging to whichever module the
> selected lane is focused on, which is why this module's VRT exemption called its
> card patch-dependent. Under the resting-text ruling those readouts are the
> MODULE'S ARTWORK, not the face's chrome (wave 5 `GAMES.md`) — and here more
> strongly than anywhere else in the fleet, because deleting them would not remove
> a readout from the product (the hardware still paints it) but would break the
> one-seam guarantee. ⚠ **IT IS A 2-D CONTEXT AND MUST STAY ONE**: attest-basis
> membership is derived mechanically from `getContext('webgl'|'webgl2')`
> (`webgl-attest-lib.ts:40`, applied to `lib/ui/modules/**` at `:267-272`), so a
> WebGL body would enrol a meta module in the GPU attest for a picture that is
> eight rectangles and some text. ⚠ **NO STATE HERE IS IN THE Y.DOC**: the lane
> select is `localStorage` and the binding is a module-level rune, deliberately, so
> two collaborators each drive their own Push — which is also why the lane select
> is a body control and not a family cell. ⚠ **NO SCREEN SWITCH and NO WATCH
> MARK**: the video-screen ruling runs over `STRICT_FACES ∩ video defs` and this is
> `domain: meta`. The only text nodes are option NAMES on the buttons that select
> them, control captions, and errors that are absent whenever nothing is wrong; the
> derived values go to `StatusLed.detail` and `aria-valuetext`. `'` `}`

⚠ It declares **no `face.rackStatus`** — its subject is a binding to hardware that
is not in the rack, not a rack-global allocation. So the FORWARD leg does not reach
it and the **ROSTERED** leg is what covers it, exactly as recorded for `midiclock`
(`:459-462`).

### 7.4 `module-docs-lint`'s FAMILY↔CARD leg

`module-docs-lint.test.ts:359-375` — for every def, for every
`controlFamilies[].testidPrefix`, `cards.includes(f.testidPrefix)` over the
concatenated source of **all** cards. Its comment (`:363-367`) is explicit that it
is **PRESENCE-ONLY**: *"proves the family exists, not that its member COUNT is
right."*

**This face declares NO `controlFamilies`** (§4.1 — the lane buttons cannot be a
family, §3.1), so the leg is vacuously satisfied.

⚠ **If a later PR adds one, the testid it needs already exists.**
`Push2ControlCard.svelte:213` emits ``data-testid={`push2-control-ch-${c + 1}`}``,
and the gate does a substring test over card source, so a prefix of
`push2-control-ch-` would be found in the template literal. **That is the honest
direction** — the leg's rule is *add the testid to the card, never drop the family*
— and here the card already has it.

### 7.5 the `optionsExhaustive` SNAP contract

`param-vocabulary.test.ts:130-203`. **`params: []`, so there is no options param
and nothing to snap.** Stated rather than skipped because the contract's reason is
mechanical and worth carrying: `paramCellKind` returns `'knob'` for an options
param OFF-DOCK, so a lane drag can genuinely land between options, and *"one that
declares it and does NOT snap is worse than one that never declared it"* (`:153`).
There is ONE snap implementation — `snapToOptions` from
`$lib/ui/controls/knob-vocabulary-model` (`:32-34`).

⚠ **The nearest thing this module has is the four-view roster** (`GRID` / `CLIP` /
`ARR` / `CTRL`, `:129-134`). It is **not** a `ParamDef` — it is
`launchpadActiveView()`, module-local — so it is not covered by this contract and
must not be converted into one just to gain the vocabulary. It lives in the body
as four `aria-pressed` buttons, which is what it already is.

---

## 8. COST

| | |
|---|---|
| **WebGL attest** | **ZERO** — §8.1 |
| **ART** | **ZERO** — zero ports, zero audio path |
| **contract-lock** | **unchanged** — `face` is contract-transparent; no port or param moves |
| **Push 2 card** | ⚠ **none, recursively** — §8.2 |
| **docs / `STRICT_DOCS`** | ⚠ **a real cost** — §8.4 |
| **VRT** | **3 files**, plus 2 deletions — §7.2 |
| **CI wall-time** | 2 face scenes + 1 card scene in the VRT lane; no new e2e proposed. Well under the ~2 min sign-off threshold. |

### 8.1 THE ATTEST IS ZERO, AND THE REASON IS ONE REGEX

`scripts/webgl-attest-lib.ts:267-272`:

```ts
for (const f of walk('packages/web/src/lib/ui/modules')) {
  if (!f.endsWith('.svelte')) continue;
  if (sourceCreatesWebglContext(join(REPO_ROOT, f), true)) files.add(f);
}
```

against `WEBGL_CONTEXT_RE = /getContext\(\s*['"`]webgl2?['"`]/` (`:40`), applied
**after** comment-stripping (`:42-53`).

A new `packages/web/src/lib/ui/modules/push2Control/Push2SurfaceBody.svelte`
**would be walked** — the sweep is the whole directory tree. It stays out of the
basis only because its context is `'2d'` (`Push2ControlCard.svelte:91`).

⚠ **So "keep it 2-D" is not a style note, it is a scheduling fact**, and it belongs
in the body's `why` (§7.3) where a future author will read it before reaching for a
shader. matrixMix's entry makes the identical argument for the identical reason
(*"a WebGL body would enrol a meta module in the GPU attest"*), from the other
direction — that body mounts no canvas at all.

⚠ Note also `:40`'s **doc-mention hazard**: the regex is applied to stripped
source, so a comment containing `getContext('webgl')` does *not* enrol a file. The
`why` string above quotes the regex rather than the call, which is safe either way.

### 8.2 THE PUSH CARD — a genuine recursion, and it resolves to "nothing"

`push-card-config.ts:20-35` gives three tiers, first match wins: an
`PUSH_CARD_CONTROLS` **OVERRIDE** (which *"REPLACES the ranking outright"*), else
the **FACE** ranking's first 8 turnable params, else the **GENERIC** declaration
order.

`push2Control` has no override, no face today, and **no params**. So its own push
card is empty at every tier, before and after promotion. **Adding a face changes
nothing**, because the FACE tier skips *"preset selectors, step grids and momentary
press-pads … an encoder can only turn a value"* (`:26-28`) and this face's only
ranked cell is an ACTION.

⚠ **Do NOT pin a `PUSH_CARD_CONTROLS` override.** midiclock's face makes the
argument (`midiclock.ts:270-278`): an override REPLACES rather than merges, so
pinning would *"silently keep a future second param off the hardware forever."*
Here it would additionally be an override of an empty list.

*(The recursion — a module whose screen shows other modules' cards, showing its own
— is real and harmless: selecting the Push's own lane paints its empty card, which
is a correct picture of a module with no turnable params.)*

### 8.3 SIBLING FILES A FACE PR DOES NOT TOUCH

`push2Control` appears in `packages/web/src/lib/ui/modules-card-map.test.ts:58`
(`EXPECTED_NODE_TYPES`) — a card-map assertion, unaffected by a `face`. It appears
in `packages/web/src/lib/docs/module-guides.ts:39-41` and `:93` (the docs route) —
also unaffected. Neither is edited.

### 8.4 ⚠ DOCS ARE THE ONE REAL NON-VRT COST, and this module is BEHIND the ratchet

`push2-control.ts` **has no `docs` field** (verified: the whole def is `:50-72` and
there is none), and `push2Control` **is not in `STRICT_DOCS`** — `git grep -n
"push2Control" origin/main -- packages/web/src/lib/docs/strict-docs.ts` returns
nothing, while its cohort siblings `es9` (`:29`), `midiLane` (`:226`), `gamepad`
(`:229`) and `outToLaunch` (`:460`) all *are* listed.

CLAUDE.md's living-docs ratchet: *"every new module ships with co-located `docs`
and enters `STRICT_DOCS`; any module you incidentally touch is brought up to the
bar then (boy-scout)."* **A face PR is not incidental contact — it is the module's
PR.** So the face PR owes:

1. a co-located `docs.explanation` on `push2ControlDef` — most of it can be lifted
   from the def's own 45-line header (`:1-44`), which is already better prose than
   many shipped `docs` blocks;
2. `'push2Control'` added to `STRICT_DOCS`;
3. `flox activate -- task docs:accept`, then **review the `git diff`** — a diff
   means a contract changed; accept it or recognise a bug.

⚠ **Docs are hash-transparent by design** — `scripts/attest-code-basis.ts` parses
with the real TypeScript parser and drops a def's `docs` property from every attest
hash — so (1) costs nothing even on a basis file. This def is not a basis file
anyway (§8.1), but the point generalises to the cohort.

⚠ **And the `docs` text must not simply be the deleted row-16 sentence.** Wave 5's
relocation ground (§2.6) requires the content to *exist* somewhere reachable, and
`/docs/modules/push2Control` already satisfies that. The `docs.explanation` should
say what the module DOES, not where its documentation is.

---

## 9. DEFECT LEDGER — live on `main`, independent of any face

1. ⚠⚠ **`push2Control` is missing from `NON_SHELL_LANE_TYPES` while its two named
   models are in it.** `push2-control.ts:41-43` says *"Modeled on ElectraControl /
   LaunchpadControl — a meta-domain control-surface node with no audio cable I/O"*,
   and `legacy-fallback.ts:110-129` contains `electraControl` and
   `launchpadControlLeft` and not `push2Control`. **The consequence is user-visible
   today** (§0): at plain `/rack` this module is a name and a badge, and its entire
   surface is dock-only. ⚠ **The correct fix is the FACE, not adding it to the
   set** — the carve-out is a legacy holding pen, and `cameraInput`'s removal from
   it on promotion (`:63-65`) is the shipped direction of travel. Recorded because
   *"it was never added"* and *"it was deliberately left out"* are indistinguishable
   from the tree, and the next reader will assume the second.
2. ⚠ **`push2-clip-launch.spec.ts` runs in the one shell where the defect above
   cannot exist.** `:24` imports the `rack` fixture → `?shell=legacy`
   (`_fixtures.ts:91-93`). Its two tests (`:123`, `:204`) are correct and prove real
   things — a simulated pad press reaching audible RMS, and lane select driving the
   push card — but neither can observe the default renderer. ⚠ **A face PR must not
   simply re-point it**: the legacy-card coverage is genuine and CLAUDE.md's
   precondition rule says fix the SUBJECT. The honest shape is a *second*,
   default-shell spec asserting the CONNECT cell is on the lane tile — the
   `flip-rack-rear-view.spec.ts` / #1607 "a rack-LEVEL feature wants BOTH renderers"
   pattern the fixture file itself prescribes (`:110-113`).
3. **`push2Control` is behind the living-docs ratchet** — no `docs`, not in
   `STRICT_DOCS`, while all four of its `domain != meta` cohort siblings are in.
   §8.4. Not a face blocker; a boy-scout debt the face PR should pay.
4. **The `Re-connect Push 2` caption leaks state through a label for an action that
   does not change** (`Push2ControlCard.svelte:154` vs `connect()` at `:113-120`,
   which does not branch). §2.1. A one-word fix that no gate will ever ask for.
5. **A FIFTH `.data`-census state that the census's column cannot express**:
   state that is in **neither** `params` **nor** `node.data` — `localStorage` plus
   module-level runes (§3). ⚠ The census would score this module ✓ for a reason that
   is a tautology about the probe (it never writes), which is wave 6's `recorderbox`
   shape from a different angle. **Not a defect in this module** — the placement is
   correct and argued — but a real defect in the *instrument*, and the fourth time
   in four waves that the `.data` column has been found unable to hold the truth.

---

## 10. VERDICT

| verdict | body role | width earned | risk | est. |
|---|---|---|---|---|
| **PROMOTE — no precursor** | `picture` | **YES**, at 480 px (§5) | **LOW/MEDIUM** | ≈ 8 h / 1 PR |

**The one-line reason:** it is `midiclock` #2187 with a stronger premise — a module
that is completely inert until a gesture is pressed, and the gesture is dock-only
today, on a module that has **no jacks at all** to hint that it exists.

**Why the risk is not higher despite the biggest body in the cohort:** the body is
almost entirely a *move*. `paintPushOps(ctx, pushDisplayOps())` is four lines
against a shared seam that already exists and is already unit-tested
(`push-card-paint.test.ts`, `push-card-model.test.ts`, `push-card-schema.test.ts`,
`push-card-encoder.test.ts`); the lane and view buttons are `{#each}` loops over
constants; and nothing in the module touches the Y.Doc, so there is no undo,
origin-tagging or collab question to get wrong. **Zero params means zero ranking
risk, zero contract-lock movement, zero ART and zero attest.**

**Where the care goes**, in order:

1. **The VRT scene must spawn `push2Control` alone** so lane 1 is empty and the
   canvas paints its deterministic empty card (§7.2). Getting this wrong produces a
   flaky baseline on a module whose picture is *another module*.
2. **Do not let the body reach WebGL** (§8.1).
3. **The default-shell spec (ledger 2) is the real coverage**, and it is new work,
   not a re-point.

**Build order within cohort B:** this one **after** whichever binder settles the
shared connect/lamp arrangement, and **before** `controlSurface` /
`launchpadControlLeft`, because those two are inside `NON_SHELL_LANE_TYPES` and
their promotion has to answer a question this module does not have
(what the carve-out's removal does), while this module's promotion is the plain
case that establishes the cohort's body vocabulary.
