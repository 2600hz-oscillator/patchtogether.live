# FACEPLATE BUILD SPEC — `launchpadControlLeft` (meta, the LAUNCHPAD BINDER)

**SPEC ONLY. Nothing here is implemented.** Mockups: [`dock.html`](dock.html) ·
[`dock-single.html`](dock-single.html).

Every claim carries the `file:line` it was measured from. Claims that came back
**different from the brief that commissioned this spec** are marked ⚠ and kept
rather than quietly corrected — the correction is the finding.

Measured on `99a961b08` (`git rev-parse origin/main`, verified equal to this
worktree's HEAD, so every `sed -n` below is a read of `origin/main`).

Sibling spec: [`../outToLaunch/spec.md`](../outToLaunch/spec.md). The two modules
bind **the same physical device in opposite directions**; the convergence answer
is §14 and is written once, there and here.

---

## 0. THE HEADLINE — ⚠ **THERE IS NO 8×8 GRID ANYWHERE IN THE APP**, AND THREE PLACES SAY THERE IS

The brief commissioned this spec on the premise that *"the 8×8 / 9×9 GRID is
where #2181 (a family key is ONE cell for ALL instances) bites hardest in the
whole wave."*

**It does not bite at all, and the reason is that this module paints no grid.**

`LaunchpadControlCard.svelte` is 268 lines. Its entire rendered surface
(`:135-235`) is:

| element | at | what it is |
|---|---|---|
| `ModuleTitle` | `:137` | the module name |
| `Pair Launchpads` `<button>` | `:147-160` | the L/R handshake gesture |
| `Connect single Launchpad` `<button>` | `:161-168` | the one-unit gesture |
| `Bind / Unbind clip-player` `<button>` | `:169-178` | conditional on `paired && (bound \|\| hasClip)` |
| a 4-button view segment `GRID CLIP ARR CTRL` | `:181-196` | conditional on `paired && isSingle` |
| a `.lp-warn` block | `:141-144`, `:198-205` | error / no-device copy |
| a `.lp-status` line | `:206-228` | **nine** derived-text branches |
| a `.lp-hint` line | `:231-233` | *"Colour guide → right-click → **View docs**."* |

There is no `<canvas>`, no pad matrix, no LED mirror, no colour legend. The card's
own header says why (`:14-15`): *"The full firmware-accurate colour language lives
in LaunchpadDocs (right-click the card → 'View docs'); this card carries only a
one-line pointer."*

**Three shipped artifacts describe a surface that is not there:**

1. **The inventory `why`** (`face-migration-inventory.ts:840-846`):
   > *"a Launchpad PAD MAPPER — an **8×8 pad matrix** bound to a hardware surface.
   > It has no params; **the pad map is the interaction**."*

   The 8×8 pad matrix is on the **hardware**. Nothing in the app renders it, and
   nothing ever did in this consolidated card.

2. **The VRT exemption comment** (`vrt-exemptions.ts:667-679`):
   > *"The deterministic solo-spawn state is just the blurb + a 'Pair Launchpads'
   > button + **a colour legend** (no module-specific pixels worth pinning beyond
   > the legend, which is itself driven by the live map constants exercised in the
   > unit suite)."*

   `grep -n "legend" packages/web/src/lib/ui/modules/LaunchpadControlCard.svelte`
   → **no match.** The legend moved to `LaunchpadDocs.svelte` when the LEFT/RIGHT
   cards were consolidated (def header, `launchpad-control.ts:23-25`), and the
   exemption's stated evidence went with it. ⚠ The exemption entry is *also* the
   one that was already corrected once, in place, for naming `matrixMix` as
   company after matrixMix was drained (`:681-686`) — so this is the **second**
   stale clause in the same comment block.

3. **`NON_SHELL_LANE_TYPES`'s own carve-out reason** (`legacy-fallback.ts:40-44`):
   > *"clipplayer + the MIDI control surfaces — SNOWFLAKES whose lane face is **a
   > grid / launcher / mapper**, not a ranked-knob skeleton."*

   True of `clipplayer`. Not true of this module's card.

**This is the `recorderbox` class from wave 6 §2.2, arriving from the other
direction.** There, three artifacts described a lifetime that a merged P0 had
already changed. Here, three artifacts describe a *surface* that a merged
consolidation removed. In both cases the stale text is the only statement on
record about the module, and it points a reader at the opposite of the truth.

### 0.1 SO WHAT #2181 ACTUALLY MEANS HERE

`resolveFaceControl` (`curated-face.ts:407,417-437`) matches
`FAMILY_TEMPLATE = /^(.+)-\{n\}$/` and returns **one** `FaceControl` with
`kind: 'family'`. One key, one cell, however many members the family has.

For this module the answer is that **there is nothing for the construct to
collapse**: `params: []` (`launchpad-control.ts:44`), zero declared
`controlFamilies`, and no repeated on-screen control except the **four**-member
view segment — which is a four-option *choice*, not a bank. #2181 is a
non-event here, and saying that is more useful than pretending otherwise.

⚠ **The construct is still LOAD-BEARING, for the opposite reason.** `params: []`
means every key `face.order` can hold is a **non-param** key, and
`module-face-lint` legitimizes a non-param key only as a declared family template
or a committed `.legend.json` entry. `matrixmix.ts:46-52` states it exactly:

> *"for a meta def it is the ONLY route: `params` is empty by construction, so
> every key `face.order` can hold is a NON-param key … Without these two
> declarations the face could rank nothing at all."*

So this face's cells are family templates **not because there is a bank, but
because there are no params.** Same construct, opposite reason.

### 0.2 SHOULD THE FACE *ADD* A PAD MIRROR? **NO — DECIDED, NOT ESCALATED**

The tempting design is an 8×8 canvas mirroring the hardware's LED frame. It is
refused on three independent grounds and the refusal is recorded rather than
left implicit:

* **Parity is the bar, not superset.** The standing ruling is that every
  affordance survives promotion; it is not a licence to invent one. Nothing on
  `main` paints pad state, so nothing loses a surface if the face does not.
* **Compact is the default and width must be EARNED.** An 8×8 mirror is the
  single largest thing that could go on this plate, on a module whose real
  content is four buttons (§6).
* **It would be a NEW vocabulary decided by accident of being first** — wave 5
  §2.4's exact reasoning about a quantize marker. The LED colour language is
  firmware-accurate and documented at length in `LaunchpadDocs.svelte`; a
  half-fidelity mirror invented on a module PR becomes the fleet's answer to
  "show me the hardware" without anyone choosing it.

Recorded as a deliberate non-choice, with the note that if the owner *does* want
one it is a separate feature PR whose body role would flip from
`control-grid`/`status-primitive` to `picture` (§9).

---

## 1. THE CONSTRAINT MAP, READ FIRST

| constraint | this module's answer | measured at |
|---|---|---|
| `NON_SHELL_LANE_TYPES` | ⚠ **MEMBER** — one of seven. Promotion is impossible without deleting the entry (§4) | `legacy-fallback.ts:110-129` |
| the carve-out is **positively asserted** by a test | ⚠ **YES** — `expect(NON_SHELL_LANE_TYPES.has(LAUNCHPAD_CONTROL_TYPE)).toBe(true)` | `legacy-fallback.test.ts:229` |
| domain | `meta` — the registry `matrixMix` opened for faces | `launchpad-control.ts:36` |
| params | **ZERO.** `params: []` | `launchpad-control.ts:44` |
| ports | **ZERO both ways** | `launchpad-control.ts:42-43` |
| lane picture | `laneGlyphFor` → `'none'`. `hasVideoSurface` is `domain === 'video'` | `module-shell-model.ts:177-179`, `:237-240` |
| glyph | `'none'`, **mechanically forced** (§5) | `shell-glyph-live.ts:111-113`, `:129-131` |
| WebGL attest | **ZERO** — `lib/meta/**` is in no basis clause | `scripts/webgl-attest-lib.ts:256-303` |
| ART | **ZERO** — no audio path, no ports | — |
| `contract-lock` | ⚠ **MOVES** — families are projected | `contract-signature.ts:237-241`; `contract-lock.txt:1508` |
| `STRICT_DOCS` | ⚠ **STRUCTURALLY UNREACHABLE** — `MetaModuleDef` has no `docs` field (§11) | `meta/module-registry.ts:74-83`, `strict-docs.ts:303-323` |
| `DESCRIPTIONS` | **not required** — the manifest globs audio+video only | `module-manifest.ts:43-57` |
| Push 2 card | **unchanged** — `params: []`, nothing to rank | `push-card-config.ts` (no entry) |
| shell extension slot | `fullViewBody`. `editorSurface` is declared and UNWIRED | `shell-extensions.ts:118-120`, `:124` |
| tab rail | **NO** — one band against `DOCK_TAB_MIN_BANDS = 7` | `strict-faces.ts:802` |
| `.data` writes | ⚠ **ZERO CALL SITES.** The card never touches `node.data` (§7) | `grep -n "\.data" LaunchpadControlCard.svelte` → no match |
| VRT | `EXEMPT_FROM_VRT` **and** `ALLOWED_PERMANENT_EXEMPT` | `vrt-exemptions.ts:686`, `:1213` |
| e2e coverage of the CARD | ⚠ **NONE. ZERO.** (§8) | — |

### 1.1 ⚠ THE TWO ONE-LINE ANSWERS THE WAVE ASKED FOR

> ### **WHICH SIDE OF THE `NON_SHELL_LANE_TYPES` SPLIT:**
> **`launchpadControlLeft` IS IN THE SET** (`legacy-fallback.ts:110-129`), so
> `laneRenderKind` short-circuits to `'legacy'` before it ever consults
> `migrated` (`:158-162`) — it has **no shell lane tile at all today**, and a
> face authored while the entry stands would be a **DOCK-ONLY face** (the dock
> still mounts `<ModuleShell view="dock-full">` on `migrated` alone,
> `DockFullView.svelte:136`, `:334`). **This spec REFUSES that arrangement and
> deletes the entry — §4.5 gives the measurement.**

> ### **WHAT WOULD MAKE IT DRAINABLE FROM `ALLOWED_PERMANENT_EXEMPT`:**
> **The no-device-bound state, and it is unreachable-by-gesture rather than
> merely unlikely** — `startPairing` / `startSingle` are the only callers of
> `connect()` (`LaunchpadControlCard.svelte:83`, `:100`) and the VRT suite
> presses nothing, while `restoreLaunchpadDeployment()` (`:51`) reads a
> `localStorage` that is empty in a fresh Playwright context. So the exemption's
> *"Pair/Bind state + status absent in CI"* describes the **only** state the
> capture can reach, which makes it the baseline rather than the obstacle.
> **Drainable. Recommend the drain; no `FACES_WITHOUT_SCENES` entry.** §10.3.

⚠ **And the compact-by-default argument is scoped by that first line.**
`face.bareCells` is dock-only *because* a lane tile has no section headings
(CLAUDE.md, *"a lane tile has no section headings, so the thing that makes the
caption redundant is not on screen"*). If the carve-out stayed, this module would
have **no lane tile to make that tradeoff for** and `bareCells` would be
vacuous for it. Because §4.5 deletes the carve-out, the tradeoff comes back — and
the answer is still *do not declare `bareCells`*: this face's two ranked cells are
`Single` and `Pair`, which are not otherwise-identical and have no section
heading above them to make redundant.

---

## 2. ⚠ THE CARD HAS NO TEST COVERAGE AT ALL, AND 6,278 LINES OF UNIT TESTS SIT BESIDE IT

This is the second headline and it changes the risk calculus completely.

```
grep -rln "launchpad-control-" e2e/ packages/web/src
  → packages/web/src/lib/ui/modules/LaunchpadControlCard.svelte
```

**One file. The card itself.** Every `data-testid` this card emits —
`launchpad-control-pair`, `-single`, `-bind`, `-view-{grid,clip,arranger,control}`,
`-status`, `-nomidi`, `-nodevice`, `-oneunit`, `-docs-hint` — appears nowhere
else in the repository. No spec clicks any of them.

Meanwhile the library beneath it is one of the most heavily tested in the tree:

```
wc -l packages/web/src/lib/control/launchpad/*.test.ts
   483 keys-stuck-gate.test.ts        910 launchpad-control.test.ts
   212 launchpad-device.test.ts      1382 launchpad-map.test.ts
   238 launchpad-monitor.test.ts      225 launchpad-play-every.test.ts
   520 launchpad-prob.test.ts         413 launchpad-scene-repeats.test.ts
  1634 launchpad-single-unit.test.ts  261 launchpad-sysex.test.ts
  6278 total
```

plus **five** e2e specs that belong to this module — `launchpad-clip-launch`,
`launchpad-perf-controls`, `launchpad-arp`, `launchpad-keys-record`,
`launchpad-scene-repeats` (`ls e2e/tests/ | grep -i launchpad`; the sixth,
`launchpad-monitor-survives-card-collapse`, belongs to the sibling).

⚠ **ALL FIVE RUN ONLY UNDER `?shell=legacy`.** Every one of them takes the
`rack` fixture, and `_fixtures.ts:91-93` is
`await page.goto('/rack?shell=legacy&seed=none')`. So **promotion is structurally
invisible to every spec this module has** — they cannot go red, and they cannot
go green-and-blind either, because they never look at the surface at all. That is
the sharpest possible statement of D3: the coverage is real, extensive, and
orthogonal.

⚠ **And it is the exact inverse of the sibling**, whose one spec is default-shell
only and *does* break (`../outToLaunch/spec.md` §8). Across the whole seven-module
cohort the orchestrator measures 16 e2e specs of which **14 are `rack`-fixture**;
the two exceptions are the sibling's and `es9-shell-lifetime.spec.ts:56`. So
within this pair, `outToLaunch` has the cohort's best default-shell coverage and
`launchpadControlLeft` has **none**.

**Every one of those five e2e specs bypasses the card.** They drive
`__launchpadTestInstall` / `__launchpadTestInstallSingle` / `__launchpadSim` /
`__launchpadSingleSim`, and those globals are installed by **`Canvas.svelte`**
(`:8544`, `:8548`, `:8567`, `:8573`) — not by the card. So they are indifferent
to whether the card, a faceplate, or nothing at all is mounted.

Two consequences, and they pull in opposite directions:

* ⚠ **Promotion is mechanically SAFE for device behaviour.** Nothing in the
  suite goes through this card, so replacing it cannot break a launchpad
  assertion. Contrast the sibling module, where a P0 hardware-lifetime e2e
  drives the real card end to end and *does* break (`../outToLaunch/spec.md` §8).
* ⚠ **Nothing would notice if the face's buttons never worked.** A face whose
  Pair / Connect / Bind gestures are wired to nothing ships green today and
  would ship green after promotion. **The face PR owes the module's first
  card-surface e2e**, and it should be written against the FACE, not
  back-filled against the card that is being retired.

Two of the four launchpad e2e tests are additionally **parked**
(`launchpad-perf-controls.spec.ts:190`, `:303` — `test.fixme`, FLAKE-PARK #1847,
a positive and its negative control), which is worth knowing before scheduling
anything that touches this area's CI time.

---

## 3. EVERY READOUT THE CARD PAINTS TODAY, AND ITS VERDICT

The permitted resting text is exhaustively: the module NAME, TAB/SECTION labels,
CONTROL CAPTIONS, and option/landmark NAMES that disambiguate a control's own
position (CLAUDE.md, *"Faceplate chrome"*). This card was built before the ruling
and **the single largest visible change promotion makes is deleting its status
line.**

| # | what it is | where | verdict | what replaces it |
|---|---|---|---|---|
| 1 | `Not connected.` | `:213` | ⛔ **REMOVED** — a state word | `StatusLed caption="LINK" lit={paired}` in the body; the sentence goes to `detail` → `aria-label` |
| 2 | `Single unit driving clip-player {bound} — {VIEW} view (top row or the buttons to switch).` | `:215` | ⛔ **REMOVED** — a derived id, a derived mode word and an instruction | two lamps (`LINK`, `CLIP`) + the VIEW control's own `aria-valuetext` |
| 3 | `Single unit ✓ — hit Bind to drive your clip-player.` | `:217` | ⛔ **REMOVED** — an instruction about a control that is on screen | the BIND cell exists; its `title` already says what it does |
| 4 | `Single unit ✓ — add a clip-player module to drive (auto-binds it).` | `:219` | ⚠ **KEPT, as EMPTY-STATE copy** — see §3.1 | unchanged in substance, moved into the body's empty branch |
| 5 | `Driving clip-player {bound}.` | `:221` | ⛔ **REMOVED** — a derived node id | the `CLIP` lamp; the id goes to `detail` → `aria-label` |
| 6 | `Paired ✓ — hit Bind to drive your clip-player.` | `:223` | ⛔ **REMOVED** | as (3) |
| 7 | `Paired ✓ — add a clip-player module to drive (pairing auto-binds it).` | `:225` | ⚠ **KEPT, as EMPTY-STATE copy** — §3.1 | as (4) |
| 8 | `Both Launchpads should light up (green + blue) — press any pad on the one you want as the LEFT (matrix) unit; the other becomes RIGHT.` | `:209` | ⚠ **KEPT, as TRANSIENT INSTRUCTION** — §3.2 | unchanged; it is the handshake's only instruction and it is not at REST |
| 9 | `Couldn't access MIDI — allow the permission prompt and try again.` | `:211` | ✅ **KEPT** — an ERROR, absent when nothing is wrong | midiclock's precedent verbatim (`MidiclockDeviceBody.svelte:22-28`) |
| 10 | `Web MIDI isn't available in this browser — connect a Launchpad in Chrome/Edge.` | `:142-144` | ✅ **KEPT** — an ERROR | same |
| 11 | `One Launchpad — use Connect single, or plug in both for the split.` | `:199-201` | ✅ **KEPT** — an ERROR/outcome, absent when nothing is wrong | same |
| 12 | `No Launchpad detected — plug one in, then Connect single.` | `:203-205` | ✅ **KEPT** — an ERROR | same |
| 13 | `Colour guide → right-click → View docs.` | `:231-233` | ⛔ **REMOVED — see §3.3, and it is a pure deletion with zero loss** | nothing; the affordance it names is unconditional and fleet-generic |
| 14 | the PAIR button caption cycling `Pair Launchpads` / `Re-pair Launchpads` / `Press a pad on the unit you want as LEFT…` | `:153-159` | ⚠ **SPLIT — §3.4** | the first two are control captions and STAY; the third moves to the body's transient instruction |

### 3.1 THE TWO "ADD A CLIP-PLAYER" LINES ARE EMPTY-STATE COPY, WHICH IS PERMITTED

Rows 4 and 7 read as sentences and they survive, on the shipped precedent rather
than on a new argument. `MidiclockDeviceBody.svelte:22-24` names the category:

> *"THE PRE-CONNECT HINT — instructional copy in an EMPTY state, and the empty
> state is the whole content of the plate before a grant."*

and wave 6 §4.1 states the general form (`samsloop`'s `NO SAMPLE LOADED`,
`twotracks`' `NO TAPE`, matrixMix's *"Pick an X-axis + Y-axis module"*):
**a placeholder naming the surface's own condition, REPLACED by the surface the
moment the surface exists.**

Both lines qualify exactly: they render only when `firstClipplayer() === null`
(`:76`), i.e. when there is no object for the BIND control to act on, and they
vanish the instant a clipplayer is spawned. The version that ships is the shorter
one — *"Add a clip-player to drive."* — because the parenthetical *"(pairing
auto-binds it)"* is a claim about behaviour, not a naming of the empty state.

⚠ **`face-resting-text-source.test.ts` cannot see any of this either way.** It
denies `ModuleFace` FIELDS with no permitted text role; a sentence inside a
`fullViewBody` is invisible to it, by its own stated blind spot. The enforcement
is the dock VRT baseline plus a human reading it — which is precisely why this
module's baseline matters (§10) and why `EXTENSION_BODY_ROLES` (§9) demands the
body write down what it paints.

### 3.2 THE PAIRING PROMPT IS NOT RESTING TEXT — IT IS A MODAL INSTRUCTION

Row 8 renders only while `pairingNow` is true (`:208`), i.e. between the press of
PAIR and the first pad hit on a physical unit. The ruling is about the **resting**
faceplate; this text does not exist at rest and cannot be reached without a
gesture. It is also the only place in the product that says *what the user is
supposed to do next* during a handshake that has no other affordance — the pads
are on the hardware.

Kept verbatim. Recorded here so a future reviewer applying the ruling literally
does not delete it: **the discriminator is `at rest`, and this is not.**

### 3.3 THE DOCS HINT — **DECIDED: DELETE**, and it is a stronger case than `chromaconsole`'s

The brief points at wave 5 §2.3, which deleted `chromaconsole`'s open-loop
sentence on the narrow ground that *"the text survives verbatim and at greater
length in `docs.explanation`, so this is a RELOCATION, not a coverage loss."*

**The same ground holds here and is stronger, for a mechanical reason.**

`NodeContextMenu.svelte:341` gates the *Annotate* entry on `hasDocs`. The **Docs**
entry immediately above it (`:337-339`) is gated on nothing but
`nodeType && !isGroup`:

```svelte
{#if nodeType && !isGroup}
  <button class="ctx-item" onclick={pickDocs} role="menuitem">Docs</button>
```

and `pickDocs` (`:291-297`) opens `/docs/modules/${nodeType}`. For this module
that route is a **hand-authored page** —
`packages/web/src/routes/docs/modules/launchpadControlLeft/+page.svelte` renders
`$lib/docs/LaunchpadDocs.svelte`, the whole firmware-accurate colour language for
both deployments. Only nine modules in the tree have such a page
(`ls packages/web/src/routes/docs/modules/`).

So the hint points at a **fleet-generic, unconditional menu entry** whose target
is intact and richer than anything a card could hold. Deleting the pointer
deletes nothing but the pointer.

⚠ **And the pointer is already wrong.** The card says *"right-click → **View
docs**"*; the menu item is labelled **`Docs`** (`:338`). A caption naming a
control that does not exist under that name is a live, if tiny, defect (D4).

### 3.4 THE PAIR BUTTON'S CAPTION — WHAT SURVIVES, AND WHY THE `StatusLed` RULE DOES NOT APPLY

`StatusLed`'s caption is static **by contract**, and the reason is stated in the
brief: a caller must not be able to smuggle a measurement through
`lit ? 'LATE 3' : 'OK'`. That rule is about a *lamp*, whose entire job is to be a
picture.

A `<button>` is a different object: its caption names **the action it will
perform**, and an action that genuinely changes must say so or the control lies.
`Bind to clip-player` / `Unbind clip-player` (`:176`) is the canonical shape, and
it already ships on a promoted module — `OutToLaunchCard.svelte:239` vs `:243`,
and `midiclock`'s own `Connect MIDI…` action cell carries a fixed label because
its action never changes.

So:

* `Pair Launchpads` ↔ `Re-pair Launchpads` — **KEEP.** Two names for two actions.
* `Connect single Launchpad` ↔ `Re-connect single` — **KEEP.** Same.
* `Bind to clip-player` ↔ `Unbind clip-player` — **KEEP.** Same.
* `Press a pad on the unit you want as LEFT…` — ⛔ **NOT A CAPTION.** It is an
  instruction wearing a button. It moves to the body's transient instruction
  (§3.2) and the button reverts to `Cancel pairing` for the same press, which is
  what `pair()` actually does in that state (`:80`).

⚠ **`ShellActionCell.label` is a plain `string`, not a function of node**
(`shell-cells.ts:314`). So a ranked action cell **cannot** change its caption.
That is a real constraint on the design and it is why BIND is specified as a
single `Clip player` cell whose *`title`* carries the direction, rather than as a
label that flips (§6.2).

---

## 4. ⚠ `NON_SHELL_LANE_TYPES` — WHAT PROMOTION MEANS, AND EXACTLY WHAT THE PR DELETES

### 4.1 THE CARVE-OUT IS NOT A HINT; IT IS A HARD SHORT-CIRCUIT

`laneRenderKind` (`legacy-fallback.ts:158-162`):

```ts
if (i.userDocked) return 'stub';
if (!i.shellFaces || !i.hasCard) return 'legacy';
return i.migrated ? 'shell' : 'placeholder';
```

and `Canvas.svelte:2458`, `:2935` pass
`hasCard: isShellSwappable(n.type, cardTypeSet.has(n.type))`, where
`isShellSwappable` (`legacy-fallback.ts:180-182`) is
`hasResolvableCard && !NON_SHELL_LANE_TYPES.has(type)`.

**So `migrated` is never consulted for a member of the set.** Authoring a `face`
on this def and adding it to `STRICT_FACES` would change **nothing** in the lane:
`laneRenderKind` returns `'legacy'` two lines earlier. The face would be
unreachable — a promoted module still rendering its verbatim card.

⚠ It also fixes the tile GEOMETRY: `Canvas.svelte:635` and `:650` return
`SHELL_TILE_H_SLOT` / `SHELL_TILE_W` only `if (shellFaces && !NON_SHELL_LANE_TYPES.has(type))`,
so a carved-out module keeps its legacy card's measured box (320-340 px wide,
`LaunchpadControlCard.svelte:244`) forever.

**Promotion therefore REQUIRES deleting the entry, and the deletion is the
promotion.** That is the opposite of the sibling module, which is not in the set
at all and for which promotion is purely additive.

### 4.2 IS THE CARVE-OUT'S CLAIM STILL TRUE — the `cameraInput` question

`cameraInput`'s entry named two things (`legacy-fallback.ts:70-94`): (a) the live
`getUserMedia` source, and (b) the device picker. `(a)` stopped being true when
`<HeadlessSourceHost>` shipped; `(b)` was true and was **answered** by building
`camera-status-registry` and moving the picker into the extension body.

This module's clause is *"SNOWFLAKES whose lane face is a grid / launcher /
mapper, not a ranked-knob skeleton … they get bespoke faces in a later spike, and
stay on the verbatim legacy card until then rather than a lossy placeholder."*

Read against the tree, that decomposes into two claims of very different quality:

| clause | status | evidence |
|---|---|---|
| *"its lane face is a grid / launcher / mapper"* | ⚠ **FALSE** — the card paints four buttons and a status line; §0 | `LaunchpadControlCard.svelte:135-235` |
| *"a placeholder tile would be LOSSY"* | ✅ **TRUE, and it is the load-bearing half** | `laneRenderKind` returns `'placeholder'`, and `ModuleShellPlaceholder` offers no route to the four gestures |

**So the carve-out is doing real work and was right to exist — for a reason its
own text does not give.** It is protecting the *gestures*, exactly as
`cameraInput`'s `(b)` protected the picker. And it retires the same way: when a
face carries those gestures, the carve-out has nothing left to protect.

This is CLAUDE.md's *"a correct conclusion resting on a false premise is the thing
that breaks the next time someone reasons from the premise"* — the wave-6 defect
#8 shape, on a different file. The face PR rewrites the clause as lineage
(`videoOut` / `cameraInput` are the two templates already in that file) rather
than merely deleting it.

### 4.3 ⚠ THE ANCHOR TEST **POSITIVELY ASSERTS MEMBERSHIP**, AND A DRAIN REDDENS IT

The brief asked what `legacy-fallback.test.ts` does on a drain. It does more than
anchor:

```ts
// legacy-fallback.test.ts:226-231
it("the launchpad entry IS the def's own exported type — re-typing cannot drift it again", () => {
  expect(LAUNCHPAD_CONTROL_TYPE).toBe('launchpadControlLeft');
  expect(NON_SHELL_LANE_TYPES.has(LAUNCHPAD_CONTROL_TYPE)).toBe(true);
  expect(NON_SHELL_LANE_TYPES.has('launchpadControl'), 'the unregistered id must be GONE').toBe(false);
});
```

The middle line is a **hard `toBe(true)` on membership**. A drain turns it red —
which is correct and desirable (the drain is a reviewed decision), but it means
the face PR must edit a test whose stated purpose is #1579 drift protection, and
that needs care:

* the `toBe(true)` **flips to `toBe(false)`**, with a lineage comment, exactly as
  `dom-source-modules.test.ts:1249` did for `cameraInput`
  (`expect(NON_SHELL_LANE_TYPES.has('cameraInput')).toBe(false)`, the old
  `toBe(true)` preserved as a comment at `:1205`);
* the third line — *"the unregistered id must be GONE"* — **STAYS**. It is the
  half that actually guards #1579's defect (a misspelled id that resolves to no
  def), and it is independent of membership;
* the generic leg at `:215` (*"every member resolves to a registered def"*) and
  the permanent negative control at `:237-243` are untouched, so #1579's
  protection survives the drain in full.

⚠ **Do NOT re-point the launchpad-specific `it()` at another member.** That is
CLAUDE.md's *fix the threshold, not the subject* — the block exists because
*this* id drifted, and once this id leaves the set the honest form is the
`cameraInput` lineage note, not a substitute subject.

### 4.4 ⚠ THE "DOCK-ONLY FACE" ALTERNATIVE — MEASURED, AND REFUSED

There is a real third option the brief's framing points at, and it must be
refused with a measurement rather than by assumption: **leave the carve-out and
author the face anyway.** It works, mechanically. `DockFullView.svelte:136`,
`:334` gate on the `migrated` prop alone, and `dockRailRendersFace`
(`legacy-fallback.ts`, the #1739 block) makes the pinned `m` tray show the face
too. So the module would get a faceplate in the dock and keep its card in the
lane.

**Refused, on three measurements:**

1. **It ships TWO designs for one module.** Lane = the 320-340 px legacy card
   (`LaunchpadControlCard.svelte:244`) with its nine-branch status line; dock rail
   and full view = a compact faceplate with none of it. #1739's owner ruling —
   *"the `m` key tray view needs to show the new card and not the old one"* — is
   the same complaint one surface earlier, and the fix there was to make the
   surfaces agree, not to accept two.
2. **The lane keeps the WRONG GEOMETRY, permanently.** `Canvas.svelte:635` and
   `:650` return `SHELL_TILE_H_SLOT` / `SHELL_TILE_W` only
   `if (shellFaces && !NON_SHELL_LANE_TYPES.has(type))`. A carved-out module sits
   at its card's measured box in a rack of 192 px RACKLINE tiles, forever, with
   no way to reach the shell sizing. That is the *"useless gray horizontal
   space"* ruling losing at the rack level rather than the plate level.
3. **The resting-text ruling would then apply to HALF the module.** The ruling is
   about faceplates and *"the legacy cards are untouched"* — so §3's status line
   would be deleted from the dock and still painted in the lane, on the same
   node, at the same moment. That is not a partial migration; it is a
   contradiction shipped on purpose.

**So the entry goes.** What the carve-out protects (§4.2) is discharged by the
face; what it costs is a permanent second design.

### 4.5 THE REST OF THE DRAIN'S BLAST RADIUS

`grep -rn "NON_SHELL_LANE_TYPES" packages/web/src e2e` — everything that reads the
set, and what each does on the drain:

| consumer | at | effect |
|---|---|---|
| `Canvas.svelte` (2 sizing sites, 2 `isShellSwappable` sites) | `:635`, `:650`, `:2458`, `:2882`, `:2935` | the tile takes `SHELL_TILE_W/H` — **this is the promotion** |
| `legacy-fallback.test.ts` | `:96-97`, `:229` | §4.3 |
| `_face-fixtures.ts` `rendersPlaceholderTile` | `:333-334` | the module becomes eligible for the audio placeholder pool — but the pool also filters on **un-promoted**, and this PR promotes it, so it is excluded by the other clause. **No fixture churn.** ⚠ Verify by running the fixture's own `fixtureProblems()` gate, which asserts `pool ∪ rejections === unpromoted` |
| `_face-fixtures.ts` `VIDEO_SINK_FIXTURE` | `:745-746` | not applicable — `domain: meta` never enters the video pool |
| `dom-source-modules.test.ts:1113` | — | picks `[...DOM_SOURCE_LANE_TYPES].find(t => !NON_SHELL_LANE_TYPES.has(t))`; this module is not a DOM source, so unaffected |
| `workflow-shell.spec.ts:259` | — | names `clipplayer`, not this module |
| `shell-extensions.ts:9` | — | a comment naming the cohort; boy-scout it |
| `face-migration-inventory.ts:760` | — | another module's `why` naming the set; untouched |

---

## 5. THE LANE TILE — `glyph: 'none'`, MECHANICALLY FORCED, AND THE TILE IS THIN

`glyphBinding` (`shell-glyph-live.ts:129-201`) resolves in order. With
`outputs: []`:

* `primaryAudioOutPortId(def)` = `def.outputs.find(o => o.type === 'audio')?.id ?? null` → **null** (`:111-113`);
* `'envelope'` needs `attack/decay/sustain/release` params — there are none → `{kind:'static'}`;
* `'algorithm'` needs an `algorithm` param **or** a `face.extension`. ⚠ **This one
  would resolve** — the face declares an extension, so `glyph: 'algorithm'` gives
  `{ kind: 'algorithm', layoutSource: 'launchpadControl', paramId: null }`
  (`:154-159`). That is the "a picture the MODULE owns" branch, and taking it
  would mean building an `ShellExtensionGlyphProps` component — i.e. §0.2's pad
  mirror, refused;
* every other literal falls to `{kind:'static'}`, which `module-face-lint`'s
  dead-glyph clause refuses by name (#1692).

And `hasVideoSurface(def)` is `domain === 'video'` (`module-shell-model.ts:177-179`)
→ false → `laneGlyphFor` returns `'none'` (`:237-240`).

**So `glyph: 'none'` is the only literal that compiles into a green run**, which
is `matrixmix.ts:91-97`'s sentence verbatim. Assert it in the module's own
face-model test with a negative control (the `moog921a` / `fourplexer` template),
not in a comment.

⚠ **AND THE GLYPH SEAM COULD NOT HELP EVEN IF IT DID BIND.**
`ShellExtensionGlyphProps` (`shell-extensions.ts:44-51`) carries `num`,
`numbers` and `testid` and **no `nodeId`** — so a glyph is a pure function of a
discrete param value and every instance of the module draws an identical
picture. The useful glance here is *"is a Launchpad attached, and to which clip
player"*, which is per-node BINDING STATE. Not expressible. This is wave 5 §5's
finding, and this module makes it **five** modules (`midiCvBuddy`,
`midiOutBuddy`, `chromaconsole`, `midiclock`, and this one) rather than four.
**No new glyph kind is invented here**, for the reason wave 4 and wave 5 both
gave.

**What the tile shows at 1/8 size:** the RACKLINE frame, the module name, and the
top-N ranked cells — for a glyph-less face that is **three**
(`module-shell-model.ts:184-196` describes the cap seam). §6 ranks exactly two,
deliberately.

### 5.1 ⚠ THE HONEST COST OF THE SWAP, STATED RATHER THAN BURIED

Today the lane holds the whole 320-340 px card, including a status line that says
*"Driving clip-player `n7`"*. After promotion the lane holds a compact tile with
two buttons and no status.

That is **not** a parity violation — a status readout is not an affordance, and
the ruling refuses it (§3). But it *is* a reduction in at-rest information, and
CLAUDE.md requires naming which finding lost its surface: **"this rack's
Launchpad is driving THAT clipplayer" moves from the lane to a dock-only
`StatusLed`'s `aria-label`.** On a rack with two clip players that is the only
thing distinguishing them, and it is now one click away instead of zero.

The trade is the ruling's intended one. It is recorded so it is a decision, not
an accident.

---

## 6. THE FACE — TWO RANKED CELLS, FOUR FAMILIES, ONE BODY

### 6.1 THE CONTROL CENSUS, AND WHY THE RAIL IS REFUSED

Four affordances (§0), of **one** kind (a press) plus one four-option choice.
The 2026-08-18 control-heavy ruling asks for *"many controls of DIFFERENT
types"*; this is the opposite of both halves. `DOCK_TAB_MIN_BANDS = 7`
(`strict-faces.ts:802`) and this face declares **one** page. `face.tabbed` is
owner-instruction-only and is not proposed.

### 6.2 THE DECLARATION, AS IT WOULD BE COMMITTED

```ts
// launchpad-control.ts
controlFamilies: [
  { id: 'launchpad-control-pair',   label: 'Pair',        kind: 'other', testidPrefix: 'launchpad-control-pair' },
  { id: 'launchpad-control-single', label: 'Single',      kind: 'other', testidPrefix: 'launchpad-control-single' },
  { id: 'launchpad-control-bind',   label: 'Clip player', kind: 'other', testidPrefix: 'launchpad-control-bind' },
  { id: 'launchpad-control-view',   label: 'View',        kind: 'other', testidPrefix: 'launchpad-control-view' },
],

face: {
  glyph: 'none',
  order: ['launchpad-control-single-{n}', 'launchpad-control-pair-{n}'],
  extension: 'launchpadControl',
},
```

**Ranked: SINGLE, then PAIR.** Both are always-meaningful gestures with a
fixed label, which is what `ShellActionCell` can express (§3.4). SINGLE ranks
first because the def's own header calls it *"a first-class deployment with the
full feature set"* (`launchpad-control.ts:16-19`) and it is the one a player with
one unit reaches for.

**NOT ranked, deliberately:**

* **BIND** — it is a no-op when `firstClipplayer() === null` (`:112-113`), and
  `ShellActionCell` has no `disabled` and no node-dependent label
  (`shell-cells.ts:312-327`). A ranked BIND would be a control that looks alive
  and isn't, in a state a fresh rack is *always* in. It lives in the body, where
  ordinary Svelte can keep the card's own `{#if paired && (bound || hasClip)}`
  condition (`:169`) — which is precisely the class of thing a body exists for.
* **VIEW** — the segment renders only `{#if paired && isSingle}` (`:181`). A
  `ShellSelectorCell` whose roster is empty in pair mode is the same defect. Body.

⚠ **The families are DECLARED even for the two body-only affordances**, and that
is on purpose: `controlFamilies` is what makes the `-{n}` key legal *and* what
`module-docs-lint`'s FAMILY↔CARD leg pins to the card. Declaring all four keeps
the card↔face vocabulary complete and costs nothing here (§11 — a meta def has no
`docs` completeness obligation).

### 6.3 THE `fullViewBody` — `$lib/ui/modules/launchpadControl/LaunchpadBinderBody.svelte`

Contents, in order:

1. **A `<button>` PAIR** (the two-unit handshake) with the transient instruction
   beneath it while `isPairing()` (§3.2). ⚠ It appears here **as well as** as a
   ranked cell — which is midiclock's explicitly refused shape
   (`shell-cells.ts:2054-2062`: *"A second button on the same plate would be one
   gesture with two affordances"*). **Resolved the same way midiclock resolved
   it, in the opposite direction:** the ranked cell is the gesture, and the body
   renders **only the instruction**, never a second button.
2. **The BIND control**, conditioned exactly as the card conditions it.
3. **The VIEW segment**, conditioned exactly as the card conditions it, with
   `aria-pressed` preserved (`:189`) — that is the existing accessible state and
   it is what a spec should read.
4. **Two `StatusLed`s** — `LINK` (`lit={paired}`, `detail` = the deployment and
   port names) and `CLIP` (`lit={bound !== null}`, `detail` = the bound node id).
   Static literal captions, boolean lamps, the derived quantities in `detail` →
   `aria-label`. `StatusLed` is the ONE permitted status surface
   (`$lib/ui/controls/StatusLed.svelte`, gated by `status-led-source.test.ts`).
5. **The error branches** (rows 9-12 of §3), unchanged.
6. **The empty-state line** (§3.1) when there is no clipplayer.

Every string this surface can produce — painted or not — is decided in a pure
`launchpad-binder-status-model.ts` beside it, `midiclock-status-model.ts`'s
shape (`MidiclockDeviceBody.svelte:118-124`): *"An unpainted string that is wrong
is invisible to a VRT baseline and to a human reading one, so they are decided
where a unit test can read them."*

⚠ **A shared body is a boundary problem.** Wave 5 §3 flagged it and it is still
live: `module-shell-import-guard.test.ts` denies the shared shell layer from
referencing module-owned directories, so if this body is ever factored together
with the sibling's device picker it must live outside the shell or be a declared
BOUNDARY entry. **They should NOT be factored together** — see §14.

### 6.4 WIDTH — COMPACT, BY MEASUREMENT

The gate is `bodyW - contentW <= FACE_WIDTH_SLACK_MAX_PX (40)` with a NAMED
`FACE_WIDTH_EXEMPTIONS` entry otherwise
(`workflow-shell-faces.spec.ts:209-224`, `:264`).

Measured drivers on this face:

| element | width driver |
|---|---|
| the two ranked action cells | `Connect single Launchpad` at 12 px (`:258`) — the widest caption on the plate |
| the VIEW segment | four `flex: 1 1 0` buttons at `padding: 4px 6px` (`:262`) — it fills, it does not drive |
| the two `StatusLed`s | `midiclock`'s lamp row shape, `.lamps` — narrow |
| the module NAME row | `LAUNCHPAD CONTROL`, 17 characters — ⚠ **the likely driver**, on `moog912`'s precedent (`workflow-shell-faces.spec.ts:265-302`: *"the module NAME ROW … is wider than either of its two remaining controls"*) |

**Nothing on this face earns width.** There is no picture, no trace, no XY pad,
no mode-exclusive control. The prediction is that the plate is set by the name row
or by the SINGLE caption, both under ~240 px, and that **no
`FACE_WIDTH_EXEMPTIONS` entry is needed**. ⚠ If the name row does drive it, the
`moog912` entry is the template for how to record that — it is a *measured
attribution*, not a permission, and the correct response is to write down which
element drives, not to widen the ceiling.

---

## 7. WHERE STATE LIVES — ⚠ A **FIFTH** ROW THE `.data` CENSUS HAS NEVER HAD

Waves 3-6 built a running census of how the bespoke cohort writes `node.data`,
and wave 6 corrected it to be **per CALL SITE, not per module** (README §9.2:
*"Discipline is per-CALL-SITE, not per-module — which the running census has
been recording as a per-module binary and therefore cannot express"*).

**This module has ZERO call sites**, and that is not the same as "clean":

```
grep -n "\.data" packages/web/src/lib/ui/modules/LaunchpadControlCard.svelte
  → (no match)
```

The card never touches `node.data`. Nor does it touch `node.params` (there are
none). **Every piece of this module's state lives somewhere the Y.Doc cannot
see:**

| state | where | synced? | undoable? | survives reload? |
|---|---|---|---|---|
| deployment (`pair` / `single`) | `localStorage[STORAGE_KEY_DEPLOYMENT]` | ✗ per-machine | ✗ | ✓ (`launchpad-control.svelte.ts:683`, `:1094`) |
| single view (`grid`/`clip`/`arranger`/`control`) | `localStorage[STORAGE_KEY_VIEW]` | ✗ | ✗ | ✓ (`:684`, `:1081`) |
| L / R port ids | `localStorage[STORAGE_KEY_LEFT/RIGHT]` | ✗ | ✗ | ✓ (`:900-901`, `:1063-1064`) |
| ⚠ the **bound clipplayer NODE ID** | `localStorage[STORAGE_KEY_NODE]` | ✗ | ✗ | ✓ (`:814`, `:855`) |
| the device claim + programmer mode | the **DEVICE**, via `launchpad-device.svelte.ts` | n/a | n/a | ✗ (needs a gesture) |
| LED frames | module-scope render state | ✗ (deliberate: `launchpad-control.ts:20-21`) | n/a | ✗ |

⚠ **The fourth row is the one worth naming.** A **graph reference** — a node id —
is persisted in a per-machine key/value store. Nothing rewrites it when the node
is deleted, renamed by a peer, or replaced by a patch load; `boundClipNode()`
(`:855`) simply reads the id back and `bindLaunchpadToClip` re-attaches to
whatever now holds it. That is a dangling-reference shape the Y.Doc-side
registries (`node-recorder-registry`, `node-launchpad-monitor-registry`)
specifically avoid by keying to graph lifetime and sweeping.

**Does it break the generic face path?** **No, and that is the useful half.** The
generic path reads params and `node.data`; this module has neither, so a face
cannot accidentally write the wrong place. All four gestures route through the
same singleton the card routes through. The face changes the *caller*, not the
store.

**Does it break MULTIPLAYER?** It is already not multiplayer, by design
(`launchpad-control.ts:20-21`: *"The binding … is per-machine localStorage, never
synced"*), and that is correct: a physical device attached to one person's
machine is not a shared fact. The face preserves it exactly.

**Routing for the dangling-node-id:** recorded as **D2** below, not fixed here —
it is a real defect but it is in the control layer, not the face, and folding a
localStorage-lifetime change into a face PR would make the face PR unreviewable.

---

## 8. THE E2E AND UNIT PICTURE, AND WHAT THE FACE PR OWES

| suite | drives the card? | breaks on promotion? |
|---|---|---|
| `launchpad-clip-launch.spec.ts` (5 tests) | ✗ — `__launchpadTestInstall` / `__launchpadSim`, installed by `Canvas.svelte:8544` | **no** |
| `launchpad-perf-controls.spec.ts` | ✗ — same; 2 of its tests are `test.fixme` FLAKE-PARK #1847 (`:190`, `:303`) | **no** |
| `launchpad-arp.spec.ts` | ✗ — `__launchpadSingleSim` | **no** |
| `launchpad-keys-record.spec.ts` | ✗ — `rack` fixture (`?shell=legacy`), zero `launchpad-control-` testids | **no** |
| `launchpad-scene-repeats.spec.ts` | ✗ — same | **no** |
| `launchpad-*.test.ts` × 10 (6,278 lines) | ✗ — pure model / device / map tests | **no** |
| `vrt.spec.ts` | n/a — exempt today (§10) | — |

**Nothing breaks. Nothing covers the surface being replaced.** The face PR owes
the module's **first** surface test, and it should assert the things a source gate
cannot see:

1. spawn → the lane renders `moduleShell`, not the legacy card (the
   `camerainput-shell-source.spec.ts` shape);
2. the SINGLE cell fires the real gesture — an **audition** probe
   (`probe: { effect: { kind: 'audition', seam: 'engine-message' } }`), because
   `startSingle` depends on hardware CI does not have and `paired` can never flip
   there. This is midiclock's stated reasoning verbatim
   (`shell-cells.ts:2069-2083`): *"the audition asks what the runner CAN answer"*;
3. the body's VIEW segment writes `setLaunchpadView` and the singleton reports it
   — drivable with `__launchpadTestInstallSingle`, which already exists and
   already works headlessly;
4. `aria-valuetext` / `aria-label` on the two lamps carries the deleted status
   text, so §3's removals are asserted rather than merely believed.

⚠ **Estimate the CI wall-time delta and flag it if over ~2 min.** This module's
area already carries two parked tests; adding a slow one here is the wrong place
to spend.

---

## 9. `EXTENSION_BODY_ROLES` — **`status-primitive`**, AND THE ROLE SET CHANGED TODAY

⚠ The brief warned that `EXTENSION_BODY_ROLES` moved. **Verified on the merged
file:** `face-rack-status-source.test.ts:142` is now

```ts
type BodyRole = 'picture' | 'status-primitive' | 'control-grid';
```

and the anchor at `:808-827` is a **SET IDENTITY between `ROLE_PREDICATE`'s keys
and the roles the roster uses**, asserted in both directions — no longer the
hand-typed pair wave 6's README described. `control-grid` is live, arrived with
matrixMix, and carries its own permanent leg (*"A CONTROL GRID'S SENTENCE IS
SPEAKABLE, NOT PAINTED"*, `:829-861`).

**The three predicates** (`:557-607`):

| role | predicate | this body |
|---|---|---|
| `picture` | `paintsCanvas(src, extId)` | ✗ — no canvas (§0.2 refuses one) |
| `status-primitive` | `/StatusLed/.test(src) && !paintsCanvas(src, extId)` | ✅ — imports `StatusLed` (§6.3.4), mounts no canvas |
| `control-grid` | `/aria-label=/.test(src) && !paintsCanvas(src, extId)` | would also match, but see below |

⚠ **Both `status-primitive` and `control-grid` would pass.** The roles are
ordered by the canvas test and are not exclusive by intent. The honest choice is
`status-primitive`, because `control-grid`'s own arrival note (`:578-588`) defines
it as *"a table of clickable cross-points … the surface the module is operated
FROM"*, and this body is not a table — it is a device-status panel with three
gestures on it. Declaring `control-grid` here would dilute the role that matrixMix
added for a reason.

**The entry, as it would be committed:**

```ts
launchpadControl: {
  role: 'status-primitive',
  why:
    "the LAUNCHPAD BINDING panel — a PAIR handshake instruction, the BIND control and the "
    + "single-unit VIEW segment, over two StatusLed lamps (LINK, CLIP) that carry the deleted "
    + "status line as colour. ⚠ IT MOUNTS NO CANVAS AND MUST NOT GROW ONE: the 8x8 pad matrix "
    + "this module drives lives on the HARDWARE and is deliberately not mirrored here (a "
    + "half-fidelity mirror would become the fleet's vocabulary for 'show me the device' by "
    + "accident of being first, and the firmware-accurate colour language already lives at "
    + "/docs/modules/launchpadControlLeft). ⚠ ALL PAINTED TEXT IS A CONTROL CAPTION, AN ERROR "
    + "OR EMPTY-STATE COPY: the three button labels, the four view names (option names that "
    + "disambiguate the segment's own position), the four hardware/permission error branches, "
    + "the transient pairing instruction that exists only mid-handshake, and one empty-state "
    + "line that is replaced by the BIND control the moment a clip-player exists. No value, no "
    + "measurement, no state word. ⚠ THE DERIVED FACTS ARE ON aria-label VIA StatusLed's "
    + "`detail`: which deployment is live, which ports, and which clip-player node is bound. "
    + "⚠ NO SCREEN SWITCH AND NO WATCH MARK: the video-screen ruling runs over STRICT_FACES "
    + "INTERSECT video defs and this is domain meta.",
},
```

⚠ **What the gate still cannot see** (its own first stated blind spot, `:46-52`):
whether those lamps are *right*. The pure model beside the body (§6.3) is what
covers that, and the dock VRT baseline plus a human is what covers the pixels.

---

## 10. VRT — THE DRAIN, AND ⚠ THE ORDERING CONSTRAINT NOBODY HAS HIT YET

### 10.1 THE PREDICTION: **THREE PNGs**, plus two deletions and one exact-set edit

`vrt.spec.ts:52-55` builds `COVERED_MODULES = REGISTRY.filter(m => !(m.type in EXEMPT_FROM_VRT))`,
so a drain enrols the **legacy card** as well as the two face scenes:

| file | authored by | why |
|---|---|---|
| `e2e/vrt/__screenshots__/vrt.spec.ts/launchpadControlLeft.png` | the drain from `EXEMPT_FROM_VRT` | `vrt.spec.ts:63-66` |
| `…/workflow-shell-faces.spec.ts/face-launchpadControlLeft-compact.png` | the `FACES` roster entry | `workflow-shell-faces.spec.ts:325` |
| `…/workflow-shell-faces.spec.ts/face-launchpadControlLeft-dock.png` | same | `:372` |

**Three**, which is exactly what `midiclock` predicted and got. Plus, in source:

* delete `launchpadControlLeft` from `EXEMPT_FROM_VRT` (`vrt-exemptions.ts:686`)
  **and its 20-line comment block** (`:667-686`), whose stated evidence is stale
  twice over (§0);
* delete `'launchpadControlLeft'` from `ALLOWED_PERMANENT_EXEMPT`
  (`vrt-exemptions.ts:1213`) — that list is ANCHORED in both directions
  (`:1197-1199`: *"an entry here naming a module that is NOT in EXEMPT_FROM_VRT is
  RED"*), so leaving the name is red, not merely untidy. The `midiclock` removal
  note at `:1217-1222` is the format to copy.

### 10.2 ⚠ THE DRAIN JOINS `vrt-cable-stripe`, AND THE EDIT CANNOT LAND FIRST

This is the sweep the `midiclock` drain surfaced on #2184, and this module hits it
in the **opposite** direction from its sibling.

`packages/web/src/lib/ui/vrt-cable-stripe.test.ts:684-699` asserts

```ts
expect(dropped).toEqual(NOT_TOKEN_PINNED_SCENES);
```

where `dropped` is **derived from the committed baseline files** (`measure()`,
`:259-300`) — every scene whose card does not pin `.stripe` to a `--cable-*`
token. `LaunchpadControlCard.svelte` renders **no `.stripe` element at all**
(`grep -n "stripe" LaunchpadControlCard.svelte` → no match): it is a control
surface for an external device with zero ports, so there is no cable for a stripe
to colour — **word for word the `chromaconsole` / `electraControl` / `matrixMix`
case the list already documents** (`:181-202`).

**So `'launchpadControlLeft'` must be ADDED to `NOT_TOKEN_PINNED_SCENES`**
(sorting between `electraControl` and `matrixMix`).

⚠ **AND IT CANNOT BE ADDED BEFORE THE BASELINE EXISTS.** `dropped` is built by
walking `__screenshots__`; a declared entry with no PNG is an extra member and the
`toEqual` goes red. The capture bot commits onto the PR branch, CI re-runs, and
*that* run is where the entry has to be present. **Sequence: dispatch
`GREP=launchpadControlLeft task vrt:commit` → the bot commits 3 PNGs → add the
`NOT_TOKEN_PINNED_SCENES` entry → push.** Getting it the other way round is a red
run that reads like a defect and is not one.

⚠ Also: a bare `task vrt:commit` on this PR would derive **FULL**, because a face
PR touches shared roster files whose paths name no module (CLAUDE.md's VRT
section says so explicitly). **Pass `GREP=`.**

### 10.3 IS THE CARD ACTUALLY BASELINE-ABLE? — YES, ON MIDICLOCK'S ARGUMENT

The exemption's stated reason is *"body is device/binding-dependent (Pair/Bind
state + status absent in CI)"*. `midiclock`'s drain (`vrt-exemptions.ts:751-758`,
`_shell-faces.ts:3344-3384`) falsified the identical sentence, and the same
argument holds here **structurally, not by luck**:

* a freshly spawned card calls `restoreLaunchpadDeployment()` (`:51`), which reads
  `localStorage` — **empty in a fresh Playwright context**, so `deployment` and
  `singleView` take their defaults;
* `startPairing` / `startSingle` are the only things that call `connect()`, and
  **this suite presses nothing**. So `isPairBound()` and `isSingleBound()` are
  both false and cannot become true without a gesture;
* therefore the rendered branch is deterministic: two buttons, no BIND (there is
  no clipplayer in a solo spawn), no view segment, and `Not connected.` — which
  the face deletes anyway.

⚠ **The one genuine variable is `midiAvailable()`** (`:53`), which decides between
the two top-level branches. It is a property of the browser build, and **the
baseline is authored by one linux CI runner** (`snapshotPathTemplate` has no
`{platform}` segment), so it is a constant *where it gates*. A local darwin run
that disagrees is not a verification either way — which is the standing rule, not
a special pleading.

**The face scenes** need `pages: 1` and **no `videoFaceWhy`** (`domain: meta`, no
canvas anywhere, nothing that advances between frames — `midiclock`'s
`_shell-faces.ts:3380-3384` note is the template) and **no `simPin`**.

---

## 11. THE FOUR GATES A FACE PR MUST SATISFY — VERIFIED AGAINST THE TREE

### GATE 1 — the face lints / `STRICT_FACES` promotion anchor

`module-face-lint.test.ts`; `strict-faces.ts` asserts the set EQUAL to the set of
defs declaring a `face`, in both directions, so **authoring the `face` IS the
promotion** and there is no count to maintain.

⚠ **For a META def this used to be structurally impossible and the fix is
recent.** `meta/module-registry.ts:41-73` records it:

> *"`svelte-check` refuses `face:` on a meta def outright, so no meta module could
> be promoted however good its design; and the promotion anchor …
> reads `def.face && !STRICT_FACES.has(def.type)`, which for a meta def is
> `undefined && …` — PERMANENTLY FALSE. **A whole DOMAIN sat outside the face
> system with every gate green.**"*

`MetaModuleDef` now carries `face?: ModuleFace` (`:79-83`) and
`controlFamilies?: readonly ControlFamily[]`, and the negative control lives with
the gate (`module-face-lint.test.ts`, *"meta domain: the `face?` precursor is
READ, not merely declarable"*). **`launchpadControlLeft` would be the SECOND
meta-domain face**, after `matrixMix` (`face-migration-inventory.ts:870-883`:
*"PROMOTED, and it is the FIRST META-DOMAIN FACE"*).

### GATE 2 — the VRT baselines

§10. Three files; two deletions; one `vrt-cable-stripe` addition with an ordering
constraint.

### GATE 3 — `EXTENSION_BODY_ROLES`

§9. Role `status-primitive`, `why` as committed, predicate confirmed
(`/StatusLed/` present, `paintsCanvas` false).

### GATE 4 — `module-docs-lint`'s FAMILY↔CARD leg

`module-docs-lint.test.ts:359-376`: *"every declared `controlFamily.testidPrefix`
actually appears in the card source."*

All four declared prefixes are **already emitted by the legacy card**:

| prefix | at |
|---|---|
| `launchpad-control-pair` | `:150` |
| `launchpad-control-single` | `:165` |
| `launchpad-control-bind` | `:173` |
| `launchpad-control-view` | `:182` (`launchpad-control-view-seg`) and `:188` (`launchpad-control-view-${v.id}`) |

**Zero card edits needed.** ⚠ The card FILE survives promotion — `cameraInput`'s
does (`CameraInputCard.svelte:73`), `EXPECTED_NODE_TYPES` still lists promoted
types (`modules-card-map.test.ts:58` carries `launchpadControlLeft` today), and
`?shell=legacy` still renders it. So the prefixes stay resolvable.

⚠ **STATED BLIND SPOT OF THIS GATE**, found while verifying it: `allCardSource()`
(`module-docs-lint.test.ts:82-94`) walks **all of `lib/ui/`** and `join`s it into
ONE string, then asks `cards.includes(f.testidPrefix)`. So a prefix present in
*any* `.svelte` under `lib/ui` passes — including the face body itself. The check
is global-substring, not per-card. `ModuleShell.svelte:838-842` is aware and
compensates on the other side (`cellTestId` deliberately does **not** reuse the
family prefix: *"that id belongs to the legacy card and is grep-pinned to it by
the docs gate"*), but the gate itself cannot tell the two apart. Reported, not
proposed for change (standing no-new-CI-machinery ruling).

### PLUS — the `optionsExhaustive` SNAP contract

`param-vocabulary.test.ts`. **Not applicable, and for a structural reason:**
`params: []`, so there is no `ParamDef` to carry `optionsExhaustive`. The VIEW
segment's four options are a `SelectorOption` roster on a **family** cell, and
`paramCellKind`'s off-dock `'knob'` fall-through is about *param* cells. Nothing
here can land between options because nothing here is a dial.

⚠ And the VIEW segment is specified into the **body**, not a cell (§6.2), which
removes the question entirely.

### ⚠ GATE 5, WHICH THE BRIEF DID NOT LIST AND WHICH BOTH MODULES OWE

`face-migration-inventory.test.ts:213-226`:

> *"the DONE set IS STRICT_FACES — both directions, no count … the inventory's
> done-set (`generic-face ∩ STRICT_FACES`) must BE `STRICT_FACES`."*

**A promoted module must be re-dispositioned from `bespoke-surface` to
`generic-face` in the same PR, or the gate reddens.** That is what retires §0's
stale `why` **by construction** — `matrixMix` and `midiclock` both replaced
`why:` with `note:` on promotion (`:872-883`, `:911-921`). The note to write is
§0's finding: the 8×8 is on the hardware, the card is four buttons, and what the
carve-out was really protecting was the gestures.

---

## 12. THE COST TABLE

| cost | this module | measured at |
|---|---|---|
| **WebGL attest** | **ZERO.** `lib/meta/**` appears in no clause of `resolveWebglBasis()` — the basis is `lib/video/**`, WebGL-context cards under `lib/ui/modules`, `AUDIO_WEBGL_MODULE_DEFS`, and the standalone/toolchain pins | `scripts/webgl-attest-lib.ts:256-303` |
| **ART** | **ZERO** — no audio path, no ports | — |
| **`contract-lock`** | ⚠ **MOVES** — `serializeModuleContract` projects families as `<type> family <id> kind=<k> prefix=<p>`. Four new lines under the existing single `launchpadControlLeft meta domain=meta` at `:1508`. Run `task docs:accept`; on conflict take main + re-run | `contract-signature.ts:237-241` |
| **Push 2 card** | **unchanged** — `params: []`, nothing for the tiers to re-rank. No `PUSH_CARD_CONTROLS` entry exists or is needed | `push-card-config.ts` |
| **docs / `STRICT_DOCS`** | ⚠ **NOT APPLICABLE, MECHANICALLY.** `MetaModuleDef` has **no `docs` field**, and `module-manifest.ts` globs `../audio/modules/*.ts` + `../video/modules/*.ts` with no meta glob — *"there is nowhere for co-located docs to be written and nowhere for them to be read. The boy-scout ratchet therefore does not apply."* And *"Promotion to a FACE does NOT trigger this: a `face` is not `docs`"* | `strict-docs.ts:303-323`; `meta/module-registry.ts:74-83`; `module-manifest.ts:43-57` |
| **`DESCRIPTIONS`** | **not required** — `module-manifest.test.ts:77-89` runs over `m.modules`, which the meta-less globs never populate | `module-manifest.test.ts:77-89` |
| **VRT** | 3 PNGs added; 2 exemption entries deleted; 1 `vrt-cable-stripe` entry added (§10.2) | §10 |
| **shared-file conflict surface** | `strict-faces.ts`, `_shell-faces.ts` FACES, `vrt-exemptions.ts` ×2, `vrt-cable-stripe.test.ts`, `face-migration-inventory.ts`, `contract-lock.txt`, `legacy-fallback.ts`, `legacy-fallback.test.ts` — **nine** hand-maintained files. Run `task pr:conflict-sweep` after any sibling merge | CLAUDE.md, *Post-merge conflict sweep* |

⚠ **The docs row deserves emphasis because it is counter-intuitive.** This module
has the **richest documentation of any module in this pair** — a hand-authored
route page rendering `LaunchpadDocs.svelte` — and it is **invisible to every docs
gate in the repo**. `module-docs-lint` sees the def (it does include
`listMetaModuleDefs()`, `:100`) but has nothing to check; `STRICT_DOCS` cannot
contain it; `MODULE_DOCS` has no entry, so `ctxMenuHasDocs` is false
(`Canvas.svelte:5302-5305`) and the **Annotate** menu entry never appears — while
the **Docs** entry above it works perfectly. Reported as **D5**; not fixed here,
because `strict-docs.ts:313-323` is explicit that whoever adds `docs?` to
`MetaModuleDef` must re-point `module-annotate.spec.ts` in the same diff, and that
is not a face PR's business.

---

## 13. DEFECT LEDGER — live on `main`, independent of any face

**D1. ⚠ Three artifacts describe an 8×8 grid this module does not paint.**
`face-migration-inventory.ts:840-846` (*"an 8×8 pad matrix … the pad map is the
interaction"*), `vrt-exemptions.ts:667-679` (*"a colour legend"* — `grep legend`
on the card returns nothing), and `legacy-fallback.ts:40-44` (*"whose lane face is
a grid / launcher / mapper"*). All three predate the LEFT+RIGHT consolidation the
def header records (`launchpad-control.ts:23-25`). §0. **The inventory one is
retired by construction** on promotion (Gate 5); the other two are two-line prose
edits that ride the face PR.

**D2. ⚠ A GRAPH REFERENCE is persisted in `localStorage` with no lifetime.**
`launchpad-control.svelte.ts:814` writes the bound clipplayer's **node id** to
`STORAGE_KEY_NODE`; `:855` reads it back. Nothing rewrites or clears it when that
node is deleted, when a peer deletes it, or when a different patch is loaded — so
a stale id can silently re-attach the pair to whatever node now carries it, or to
nothing. Every comparable resource in this area is keyed to graph lifetime and
swept (`node-launchpad-monitor-registry.svelte.ts:76-88`,
`node-recorder-registry`). **Routed OUT of the face PR** — it is a control-layer
lifetime change and folding it in would make the face PR unreviewable.

**D3. ⚠ The card has ZERO surface coverage** against 6,278 lines of unit tests and
four e2e specs beneath it (§2), and two of those e2e tests are parked
(`launchpad-perf-controls.spec.ts:190`, `:303`). Not a defect in the product; a
defect in the **evidence**, and it is what makes "promotion is safe" and
"promotion is unverifiable" both true at once.

**D4. The docs hint names a control that does not exist under that name.** The
card says *"right-click → **View docs**"* (`:232`); `NodeContextMenu.svelte:338`
labels the item **`Docs`**. Deleted by §3.3 anyway.

**D5. The best-documented module in the pair is invisible to every docs gate.**
§12's docs row. Reported, deliberately not fixed.

**D6. The VRT exemption comment has now been wrong twice in the same block.**
`:681-686` already carries an in-place correction (*"THIS LINE USED TO SAY
'controlSurface/matrixMix' AND matrixMix IS DRAINED"*), and the clause above it
about the colour legend is wrong for a second, independent reason. A comment
block that needs a correction per review is the shape CLAUDE.md warns about for
*defaults*; here it is the argument for draining the entry rather than editing it
a third time.

---

## 14. ⚠ THE COHORT QUESTION — DO THE TWO MODULES SHARE ONE DEVICE-BINDING SHAPE?

The wave was commissioned on the premise that its seven members share one shape,
and this pair is the sharpest available test: **the same physical Novation
Launchpad Mini Mk3, over the same `MIDIAccess`, through the same
`$lib/control/launchpad/` layer, driven in opposite directions.** If one shape
existed anywhere it would be here.

**IT DOES NOT. They share a DEVICE LAYER and nothing above it.** The full answer
is written once, in [`../outToLaunch/spec.md` §14](../outToLaunch/spec.md), and
the discriminator is stated there. The short form, from this side:

| | `launchpadControlLeft` | `outToLaunch` |
|---|---|---|
| direction | hardware **→** rack | rack **→** hardware |
| domain | `meta` | `video` |
| ports | none | 1 in, 0 out |
| params | **0** | **2**, both alive |
| lane today | ⚠ carved out — **no tile at all** | placeholder tile (with a broken picture — sibling §0) |
| promotion is | a **DELETION** from `NON_SHELL_LANE_TYPES` | purely **additive** |
| state store | `localStorage`, 4 keys, incl. a node id | a module-scope registry, **nothing persisted** |
| survives reload | ✅ auto-restores | ❌ must be re-bound by hand |
| `.data` writes | **0**, and stays 0 | **0**, becomes **1** (the SCREEN key) |
| body role | `status-primitive` | `picture` |
| WebGL attest | zero, structurally | zero, but only because `face` is stripped from the hash |
| docs | unreachable by construction | `STRICT_DOCS`, and a family costs a doc entry |
| card e2e coverage | **none** | a **P0** spec that promotion breaks |

**The one thing they genuinely share** is `isOutputClaimed(outputId, exceptToken)`
(`launchpad-device.svelte.ts:558-560`), which is
`outputHeldByUnit(outputId) || outputHeldByOtherMonitor(outputId, exceptToken)` —
one arbiter, one owner per physical surface, spanning both consumers. The
registry that owns the sibling's half says exactly why that arbitration must not
be duplicated (`node-launchpad-monitor-registry.svelte.ts:60-72`): *"Duplicating
the claim here would mean two maps that can disagree about who owns a surface,
which is precisely the bug the exclusivity rule exists to prevent."*

**So the shared shape is one function, and it already exists.** Everything a
faceplate touches — the store, the lane, the body role, the gates, the costs —
diverges. **A shared `LaunchpadBinderBody.svelte` would be a mistake**, and the
import guard (`module-shell-import-guard.test.ts`) would make building one
awkward for a second, independent reason.

---

## 15. VERDICT

> ## **PROMOTE — no precursor.** LOW/MEDIUM risk. ≈ 8 h / 1 PR.

**The one-line reason:** every affordance is a plain gesture over a singleton the
card already calls, nothing in 6,278 lines of tests goes through the card, and the
only thing standing between this module and a faceplate is a `NON_SHELL_LANE_TYPES`
entry whose stated reason is false and whose real reason (protect the gestures)
the face discharges.

**Risk is LOW on the device and MEDIUM on the surface**, and the split is the
point: nothing can break the launchpad, and nothing would notice if the face were
broken. **The mitigation is the first surface e2e (§8), and it is not optional.**

**Build order relative to the sibling: build THIS ONE FIRST.**

* it is attest-ZERO by construction (meta domain), so it cannot be blocked by a
  GPU window;
* it settles the `vrt-cable-stripe` ordering constraint (§10.2) on the module that
  *needs* the entry, where getting it wrong is cheap;
* it is the second meta-domain face, so it exercises the `MetaModuleDef.face`
  path a second time before anything harder depends on it;
* and it does **not** break a single test, whereas the sibling breaks a P0
  hardware-lifetime spec and needs a precursor first.

**What must land in the PR, exhaustively:**

1. `launchpad-control.ts` — `controlFamilies` ×4, `face` (glyph/order/extension);
2. `$lib/ui/modules/launchpadControl/shell-extension.ts` + `LaunchpadBinderBody.svelte`
   + `launchpad-binder-status-model.ts` + its unit test;
3. `shell-cells.ts` — two `action` cells with `audition` probes;
4. `strict-faces.ts` — the entry and its reasoning;
5. `legacy-fallback.ts` — delete the carve-out, rewrite the clause as lineage;
6. `legacy-fallback.test.ts:229` — flip to `toBe(false)` with the lineage note;
   keep `:230`;
7. `face-migration-inventory.ts` — `bespoke-surface` → `generic-face` + `note`
   (Gate 5);
8. `face-rack-status-source.test.ts` — the `EXTENSION_BODY_ROLES` entry (§9);
9. `_shell-faces.ts` — `{ type: 'launchpadControlLeft', pages: 1 }`;
10. `vrt-exemptions.ts` — two deletions;
11. `task docs:accept` → `contract-lock.txt`;
12. the first surface e2e (§8), flake-checked `REPEAT=3`;
13. **after** the capture bot commits: `vrt-cable-stripe.test.ts` entry (§10.2).
