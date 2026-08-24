# FACEPLATE BUILD SPEC — `videovarispeed` (video, the MULTI-SLOT VARISPEED FILE PLAYER)

**SPEC ONLY. Nothing here is implemented.** Mockups: [`dock.html`](dock.html) ·
[`dock-loaded.html`](dock-loaded.html).

Method: analyse what the module is FOR, then author the spec, then build from
the spec. Every claim carries the file and line it was measured from, and the
ones that were **checked and came back different from the rule** are marked ⚠
and kept rather than quietly corrected — the correction is the finding.

Measured on tree `ea2e06340` (= `origin/main` at the time of writing; verified
identical, `git log --oneline -1 origin/main`).

This spec's §0 carries the **shared media-controller analysis for cohort A's
local-file players** — `videobox`'s spec references it rather than restating it.

---

## 0. THE CONSTRAINT MAP, READ FIRST

| constraint | videovarispeed's answer | measured at |
|---|---|---|
| `NON_SHELL_LANE_TYPES` (the lane carve-out) | **NOT a member** | `legacy-fallback.ts:96-112` — `group, sticky, cadillac, clipplayer, controlSurface, electraControl, launchpadControlLeft` |
| `DOM_SOURCE_LANE_TYPES` (the headless-host tax) | ⚠ **MEMBER — the tax is PAID, not avoided** | `dom-source-modules.ts:96`; §0.2 |
| `needs-media-controller` blocker | **DECLARED, and it does NOT block** | `face-migration-inventory.ts:1118-1124`; §0.1 |
| lane picture | **FREE, automatic, per-node** | `module-shell-model.ts:177-179`, `:237-240`; §4 |
| WebGL attest | ⚠ **the def IS in the basis** — `face` + `noUserControl` are free, a `ParamOption` roster is NOT | §10.1 |
| ART | none — video domain is outside the audio profile gate | §10.2 |
| VRT | ⚠ **`EXEMPT_FROM_VRT` today, and half its stated reason is the thing the face DELETES** | `vrt-exemptions.ts:910`; §9 |
| shell extension slot | `fullViewBody` (wired). Never `editorSurface` | `shell-extensions.ts` `WIRED_SHELL_EXTENSION_SLOTS` |
| tab rail | **NO — and the "control-heavy" reading is REFUTED by the census** | §5.2 |
| `node.data` writes / Cmd-Z | ✅ **CORRECT on all five writers** — and that is a finding, §0.3 | `VideoVarispeedCard.svelte:298,312,329,444` + `crop-edit.ts` |
| `EXTENSION_BODY_ROLES` role | `picture` | §6.5 |

### 0.1 ⚠ `needs-media-controller` IS DECLARED AND IT DOES NOT BLOCK A FACE — SETTLED ON MAIN, TWICE

`videovarispeed` carries the blocker (`face-migration-inventory.ts:1118-1124`):

```ts
{ type: 'videovarispeed', disposition: 'bespoke-surface',
  blockers: ['needs-media-controller'],
  why: 'a multi-SLOT varispeed player: several file slots, a crop overlay dragged over the '
     + 'frame, and scrub/speed transport — over a card-owned video source.' }
```

Its probe is `tree.cardOwnedSourceTypes.length === 0` — i.e. **`HEADLESS_MOUNT_LANE_TYPES`
is empty** — and it is false, and it is false *because of this module among
others*. **That is not a reason to wait.** The inventory says so itself, in the
`loopback` note at `face-migration-inventory.ts:378-385`:

> *"a card-owned-source module CAN be faced while that blocker is outstanding, by
> paying the headless-host tax and rebuilding the card-only affordances. It is
> the SECOND module to pay both halves."*

⚠ **And #1511, which the blocker resolves to, is CLOSED (COMPLETED, 2026-08-23)
with its acceptance UNMET** — `DOM_SOURCE_LANE_TYPES` still has seven members
and `HeadlessSourceHost.svelte` still exists. `face-migration-inventory.ts:622-628`
records that outright. **So the blocker cannot be waited out; it can only be
paid.** Nothing in this spec asks for a platform capability.

### 0.2 THE TAX THIS MODULE PAYS, NAMED EXACTLY

Three modules have now been faced out of this cohort and they paid three
different bills. Which one applies is a property of *where the module's
engine-visible state lives*, and it is checkable rather than a judgement:

| module | what its card owns | the bill it paid |
|---|---|---|
| `picturebox` | nothing — the texture and the CV pump moved to `extras-producers.ts` / `node-extras-registry` | **NONE.** It is absent from `CARD_PRODUCER_LANE_TYPES` (`dom-source-modules.ts:204-211`) and therefore from `HEADLESS_MOUNT_LANE_TYPES` |
| `cameraInput` | `getUserMedia`, the `MediaStream`, the permission machine | `<HeadlessSourceHost>` **+ a new status registry** (`camera-status-registry`) so the face can reach the off-screen card's gesture |
| `loopback` | `getDisplayMedia`, the capture state machine | `<HeadlessSourceHost>` **+ `loopback-status-registry`** |

**`videovarispeed` pays the FIRST HALF ONLY: `<HeadlessSourceHost>`, and NO
status registry.** The reason is mechanical, and it is the one line worth
carrying out of this section:

> **A status registry exists to publish state that is NOT IN THE GRAPH.** camera
> and loopback needed one because *nothing* about a browser capture grant is in
> the graph — `loopback-status-registry.ts` says so: *"`gain` and `crop` are the
> only params, and neither moves when a capture starts, stops, is refused, or is
> ended from the browser's share bar."* **videovarispeed's entire transport IS in
> the graph**: `isPlaying`, `loop`, `fileMeta`, `slotMeta` and `crop` are all
> `node.data` (`videovarispeed.ts:123-145`), and `speed`/`start`/`end` are
> params. A body reading `patch.nodes[nodeId].data` sees everything the card
> sees. There is nothing left for a registry to carry.

What the headless host already gives us, verified rather than assumed:

* `needsHeadlessSourceMount` returns TRUE for `kind === 'shell'`
  (`dom-source-modules.ts:357-362`), which is exactly the promoted lane kind;
* `card-media-lifetime.test.ts:220-223` already declares this card
  `owner: 'headless-card-mount'`, with the `why` *"a card-owned `<video>` plus
  the varispeed transport; the collapse-keeps-playing sweep is built on this card
  staying mounted"*;
* `VideoVarispeedCard.svelte:1105-1113` already refuses to tear anything down on
  unmount — *"no `attachExternalSource(id,'video',null)`, no per-slot
  `revokeObjectURL`, no `unwireAudio()`"* — because the elements are node-owned
  through `nodeMedia`.

⚠ **THE ONE CONSTRAINT THAT MUST BE COPIED VERBATIM AND IS THE EASIEST TO GET
WRONG.** `LoopbackOutputBody.svelte:7-16`:

> *"THE PICTURE IS BLITTED FROM THE ENGINE AND THE `<video>` IS NEVER ADOPTED,
> and that is the single most important line in this file … A DOM node has
> exactly one parent, so a body that adopted it here would STEAL it from the card
> — and the card is what owns [the source]. 'Port the card's preview' is the
> obvious move and it would silently kill the capture the moment the dock
> opened."*

Here the failure is **seven elements deep**: `VideoVarispeedCard.svelte:1037-1072`
adopts SEVEN node-owned `<video>` elements through `nodeMedia.adopt`, and
`slotEls[i]` is what `selectAssetSlot` (`:795-832`) and the rAF transport
(`:912-980`) drive. A body that adopted slot 0's element would take it out of the
card, and the card's `videoEl = $derived(slotEls[activeSlot])` would go null
mid-transport. **The body blits `blitOutputForPreview(nodeId)` and adopts
nothing.** That is also what makes the body cheap: it is 480×360 of 2D canvas and
one rAF, exactly `LoopbackOutputBody.svelte:178-219`.

### 0.3 ⚠ THE `.data` WRITES ARE CORRECT — ALL FIVE — AND THAT MATTERS FOR THE CENSUS

The wave-5 census (`wave5/README.md §7`) reports three states for `node.data`
writes, and `mutate.guard.test.ts`'s three patterns all anchor on the literal
token `.params`, so the guard is structurally blind to every one of them.

`videovarispeed` is in the **top row** — the correct one — on every writer:

| writer | site |
|---|---|
| `writePlaying` | `VideoVarispeedCard.svelte:297-304` → `}, LOCAL_ORIGIN);` |
| `writeFileMeta` | `:305-327` → `}, LOCAL_ORIGIN);` |
| `writeLoop` | `:328-335` → `}, LOCAL_ORIGIN);` |
| `writeSlotMeta` | `:443-459` → `}, LOCAL_ORIGIN);` |
| `writeCrop` | `ui/modules/crop-edit.ts` → `}, LOCAL_ORIGIN);` |

`grep -n "LOCAL_ORIGIN\|ydoc.transact" VideoVarispeedCard.svelte` returns exactly
four transacts and four origins, with no fifth bare proxy write anywhere in the
file. **So videovarispeed is the census's second clean module after `picturebox`
and `matrixMix`** — and its SIBLING `videobox` is not (see `../videobox/spec.md`
§0.3, which is a *new* census state: one module in two rows at once).

Nothing in this spec depends on a `.data` ledger landing. videovarispeed needs no
fix here; it is a control case.

---

## 1. WHAT THE MODULE IS FOR

A turntable for video files.

Not a player — a *player* is `videobox`, which decodes a file and syncs its
playhead to your collaborators. videovarispeed is the one you **perform with**:
the SPEED knob is an asymmetric analog-clock face running −4× through +1× at
twelve o'clock to +4×, forward speeds ride native `<video>.playbackRate` (so the
audio pitch-shifts like tape), reverse scrubs `currentTime` at a throttled ~10 Hz,
and START/END carve a loop window you can shrink to a stutter. The def's own
`docs.explanation` (`videovarispeed.ts:285`) names the verb: *"Use it to scratch,
reverse, freeze, and loop-window a clip live."*

Two things sit on top of that and neither is a control:

* **a 7-clip melodic switcher.** Seven preloaded `<video>` elements, one per
  scale degree C-D-E-F-G-A-B, selected by pitch class off a clip player's
  PITCH+GATE — and each inactive slot runs its **own virtual playhead**
  (`:888-910`), so a switch lands on that clip at *its* live, de-synced position
  rather than restarting it. That is the difference between a video switcher and
  a video sampler.
* **a CROP rectangle** that is a **second first-class video output**
  (`videovarispeed.ts:259`) — drag a box over the frame and `crop` re-samples
  just that region, scaled up to full output resolution. A live zoom you can
  patch somewhere else while the full frame keeps going.

**What that means for the face:** the module is a PICTURE you scrub, three
knobs' worth of transport, and two things you *do to the picture* (crop it,
load seven of them). The three transport params map to bands; everything else is
a surface. That is a `fullViewBody`, and the split is clean rather than
negotiated.

---

## 2. STOP 1 — is promoting this module a PARITY LOSS?

Functional parity is a hard requirement, not a trade. Every affordance the legacy
card offers is enumerated here with where it goes.

| affordance | `VideoVarispeedCard.svelte` | where it goes on the face | lost? |
|---|---|---|---|
| the live PREVIEW | `:1189-1193` (`.preview-wrap` + adopted `<video>`) | ⚠ **the body's own BLIT canvas**, and the lane tile's `VideoTileThumb` — never an adopted element (§0.2) | no, and it gains a lane tile |
| drop-a-file target | `:1176-1178` (`ondragover/ondragleave/ondrop`) | body root, same three handlers | no |
| `Choose video…` / `Pick another video…` | `:1276-1284` | body row, same `<input type=file>`, same testid | no |
| Chromium `showOpenFilePicker` path | `:620-646` (`onPickClick`) | body, same handler | no |
| the RE-LINK prompt | `:1211-1229` | body overlay, same testid | no |
| the one-click RE-ALLOW button | `:1199-1210` | body overlay, same testid | no |
| PLAY / PAUSE | `:1291-1297` | body transport row, same testid — §6.2 argues why not a `toggle` cell | no |
| the `0:04 / 2:00` time readout | `:1298-1300` | ⚠ **REMOVED**, and §7 names what loses its surface | text yes, information no |
| the SEEK scrubber | `:1303-1314` | body, same `<input type=range>` | no |
| SPEED knob | `:1318-1323` | **ranked param cell**, `paramCells: { speed: 'knob' }` | no |
| the `+1.0×` speed readout | `:1324` | ⚠ **REMOVED** → `aria-valuetext`; §7 + §10.1's PR 2 | text yes, information no |
| LOOP ↔ 1-SHOT | `:1326-1334` | body transport row, same testid — §6.2 | no |
| START / END sliders | `:1337-1362` | **ranked param cells**, `'fader'` | no |
| the START-past-END warning | `:1363-1365` | body, transient — an ERROR, not a readout (§7) | no |
| the filename | `:1367-1371` | body, per-row label in the bank (§7) | no |
| the load-error line | `:1286-1288` | body, transient | no |
| `add crop` / `edit crop` / `remove crop` | `:1241-1268` | body, same three buttons + same testids | no |
| the `CropOverlay` drag/resize rectangle | `:1234-1236` | body, over the body's blit canvas — §6.3 | no |
| the 7-slot `Load multiple…` panel | `:1383-1410` | body, **always visible** — no longer behind a right-click (§2.1) | no, **upgraded** |
| per-slot load / clear / name | `:1399-1406` | body rows, same testids | no |
| the hidden slot pool (`.slot-pool`) | `:1377-1381` | ⚠ **stays on the CARD**, in the headless host — §2.2 | no |
| the PatchPanel jacks | `:1187` | the shell's own rear/patch surface | no |
| the `__vvsVirtualPlayhead` test hook | `:1138-1150` | ⚠ **stays on the CARD** — §2.2 | no |

**Nothing is lost.** Two readouts are deliberately removed (§7), one gesture is
promoted from an undiscoverable right-click to a visible surface (§2.1), and one
thing is *gained* (a live lane tile the card never had).

### 2.1 SIX OF THE SEVEN SLOTS ARE BEHIND A RIGHT-CLICK — AND UNLIKE PICTUREBOX, THE COLLISION IS **MEASURED**

`VideoVarispeedCard.svelte:670-674`:

```ts
function onCardContextMenu(ev: MouseEvent): void {
  ev.preventDefault();
  multiOpen = !multiOpen;
}
```

bound at `:1179` on the card root. That handler is the only route to the
`Load multiple…` panel, and the panel is the only route to slots 2-7.

⚠ **PICTUREBOX'S OPEN MUST-VERIFY `M1` IS ANSWERED HERE, AND THE ANSWER IS
OUTCOME (1): BOTH MENUS FIRE.** The wave-4 picturebox spec (§2.1) listed three
possible outcomes for the collision between a card's bubble-phase
`oncontextmenu` and `Canvas.svelte`'s capture-phase `contextmenu` listener, and
declined to guess. It did not need to be guessed for this module — the answer is
committed, in a passing spec, at `e2e/tests/varispeed-panel-layout.spec.ts:53-57`:

```ts
await card.click({ button: 'right', position: { x: 30, y: 30 } });
const panel = page.locator(`[data-testid="${c.testid}-multi-panel"]`);
await expect(panel).toBeVisible();
await page.keyboard.press('Escape'); // dismiss the node context menu the right-click also opened
await expect(panel).toBeVisible();
```

The `Escape` is there **because both fire**: the shared node context menu opens
*and* the panel toggles underneath it. So the collision is real, benign, and
already worked around by a test rather than by the product. Every player who
right-clicks a videovarispeed gets a menu they did not ask for on top of a panel
they could not have known about.

**The face removes the collision by not binding `oncontextmenu` at all**, and
removes the discoverability problem by making the bank part of the body. That is
the picturebox fix, applied to the module that supplied the evidence.

### 2.2 ⚠ TWO THINGS DELIBERATELY STAY ON THE CARD, AND SAYING SO IS THE POINT

The STOP-2 grep finds affordances a USER operates. `wave5/README.md §6` records
that it is *"structurally blind to a component-lifecycle side effect the card
performs on the user's behalf"* — an `$effect`, an `onMount`, a subscription —
and instructs grepping `$effect(` / `onMount(` as well. Done:
`VideoVarispeedCard.svelte` has **eight `$effect(` blocks and two `onMount(`
blocks**. Each was checked against promotion:

| card-lifetime mechanism | site | survives promotion? |
|---|---|---|
| the 7-element adopt/release lease loop | `:1037-1072` | ✅ the card stays mounted in the headless host |
| the engine attach poll | `:1081-1093` | ✅ same |
| `startGateLoop` (33 ms edge detect on 5 gates) | `:844-865`, started `:1095` | ✅ same |
| `startTransportLoop` (the rAF varispeed transport) | `:981-988`, started `:1096` | ✅ same |
| per-slot handle reload | `:517-524` | ✅ same |
| slot-0 handle reload | `:551-558` | ✅ same |
| crop push-to-engine + aspect refit | `:217-239` | ✅ same |
| `isPlaying` → element play/pause sync | `:992-1006` | ✅ same |
| `registerVideoExport` (the perf-zip resolver) | `:1079` | ✅ same |
| `displayTimer` (100 ms `displayPos` refresh) | `:1123` | ⚠ **still runs, and now feeds nothing visible** — see D7 |
| `__vvsVirtualPlayhead` test hook | `:1138-1150` | ✅ same |

**Every one survives, because the card survives** — which is the whole content of
the headless-host tax and the reason this promotion is not the `midiOutBuddy`
class (`wave5/README.md §6`, a defect that *promotion creates*). The one residue
is D7: a 100 ms interval whose only consumer was the removed readout.

---

## 3. STOP 2 — does every way of getting DATA IN survive?

| entry point | today | after |
|---|---|---|
| file picker (main) | card `<input type=file>` `:1277-1282` | body `<input type=file>`, same element, same testid |
| Chromium picker | `showOpenFilePicker` `:627` | body, same call in the same click gesture |
| drag-drop | card root `:1176-1178` | body root, same |
| per-slot picker ×7 | card `:1400` | body rows, same |
| IndexedDB handle reload | `:469-484`, `:499-512` | unchanged — card-side, survives in the host |
| perf-zip restore | `registerVideoExport` `:1079` + `resolveAllSlotBytes` `:1015-1029` | unchanged — card-side |
| SPEED/START/END via UI | `Knob` `:1318`, two `<input type=range>` `:1339`, `:1352` | ranked param cells |
| SPEED/START/END via CV | `speedCv`/`startCv`/`endCv` inputs, `videovarispeed.ts:249-251` | unchanged — the bridge writes the param |
| the four transport GATES | `cv_start/cv_pause/cv_reset/cv_loop_toggle`, `:233-239` | unchanged — the card's 33 ms edge loop still runs (§2.2) |
| slot select via ASSET PITCH+GATE | `:244-246` → card `:857-860` | unchanged — same reason |
| remote peer edit | Y.Doc → `$derived` reads of `node.data` | unchanged — the body reads the same `node.data` |

Nothing in the input set is card-shaped in a way promotion breaks, because the
card is not removed from existence — only from the screen.

---

## 4. THE LANE PICTURE — **ACCEPTED**, free, and per-node

`hasVideoSurface(def)` is `def?.domain === 'video'` and **nothing else** —
`module-shell-model.ts:177-179` — and `laneGlyphFor` returns `'picture'` off that
alone (`:237-240`). `ModuleShell` then renders `<VideoTileThumb nodeId={id} />`,
which takes the **nodeId**, so the picture is per-node by construction. The
`ShellExtensionGlyphProps` problem that refused a lane picture eight times in
wave 5 (`wave5/README.md §5` — the props carry `num`/`numbers`/`testid` and no
`nodeId`) does not apply, because video modules were never on the glyph seam.

Size and cadence are fixed and free: `VIDEO_THUMB_W = 160`, `VIDEO_THUMB_H = 120`,
`VIDEO_THUMB_FPS = 15` (`module-shell-model.ts:250-252`).

⚠ **`glyph: 'none'` IS MANDATORY, not tasteful.** `videoOut`'s def spells the
mechanism out at `video-out.ts:124` and `strict-faces.ts` repeats it:
`primaryAudioOutPortId` matches `type === 'audio'`, and while videovarispeed
*does* declare two audio outputs (`audio_l`/`audio_r`, `videovarispeed.ts:260-261`)
they are **cross-domain bridges from a media element, not a synthesised signal** —
so any glyph other than `'none'` would paint a live scope over a file's soundtrack
and, worse, `'none' + blank tile` and `'none' + live thumb` are indistinguishable
from the declaration. **Assert `hasVideoSurface`**, per `videoOut`'s own note at
`:120-121`. This is `videoout-face-model.test.ts`'s shape, copied.

⚠ **AND THE LANE PICTURE WILL ACTUALLY PAINT, BY A CHAIN THAT MUST BE VERIFIED
RATHER THAN ASSUMED (M2, §13).** The chain is: headless-hosted card →
`attachExternalSource` (`:1087`) → the factory's rVFC (`videovarispeed.ts:408-422`)
→ `uploadIfReady` (`:454-485`) → the module's FBO → `blitOutputToDrawingBuffer`.
Every link is card-independent once the card is mounted *anywhere*, and the
headless host is a mount. The one thing that could break it is the module being
dropped from the pull set — and it cannot be, see §4.1.

### 4.1 ⚠ THIS MODULE IS UNCONDITIONALLY PULL-EXEMPT, WHICH CHANGES THE SCREEN-OFF ARGUMENT

`VideoEngine.isPullExempt` (`engine.ts:1170-1177`):

```ts
if (handle.audioSources && handle.audioSources.size > 0) return true;
```

and `videovarispeed`'s factory populates `audioSources` with two silent
`ConstantSourceNode`s at construction whenever `ctx.audioCtx` exists
(`videovarispeed.ts:394-406`) — **before any file is loaded**. The doc at
`engine.ts:1155-1158` names this case explicitly: *"the video players'
soundtracks … Pausing draw() would freeze the simulation/CV that audio consumers
hear."*

**So videovarispeed never leaves the pull set, watched or not.** Twenty-eight
entries in `EXTENSION_BODY_ROLES` carry a `markWatched`-while-SCREEN-OFF argument
(#2015) — `colorizer`, `vdelay`, `inwards`, `picturebox`, `scoreboard`,
`acidwarp` … For this module **that argument does not apply**, and writing it
would be a copied sentence rather than a measured one.

⚠ **The body should still call `markWatched(nodeId)` in the collapsed branch,
and the reason is different and worth stating**: the exemption is a property of
the *handle*, evaluated per frame, and `audioSources` is empty when there is no
`AudioContext` (a headless/e2e boot, `videovarispeed.ts:394`). A body that
depends on the exemption is a body that goes dark in exactly the environment the
gates run in. The call is one line, idempotent and free; the *claim* attached to
it must be the honest one. See the `why` string in §6.5.

---

## 5. THE FACE

### 5.1 RANK — `face.order`

```ts
face: {
  glyph: 'none',                                   // mandatory for a video def — §4
  order: ['speed', 'start', 'end'],
  paramCells: { speed: 'knob', start: 'fader', end: 'fader' },
  pages: [
    { id: 'transport', label: 'transport', order: ['speed'] },
    { id: 'window',    label: 'window',    order: ['start', 'end'] },
  ],
  extension: 'videovarispeed',
},
```

Three ranked keys, two bands. `order` and `pages` **agree** here and there is
nothing clever to say about it: SPEED is the module's identity and both the
priority order and the signal order put it first.

⚠ **`paramCells: { speed: 'knob' }` is a real decision.** SPEED is the one
control on this module that is *not* a fraction: it is an asymmetric clock face
where the meaningful landmark is **unity at the MIDPOINT** (`0.5 → +1×`,
`videovarispeed.ts:180`, `:265`). A fader's throw reads as "more" in one
direction; a dial reads as a *position on a face*, which is what the legacy card
chose (`:1318`) and what the docs describe (*"asymmetric analog-clock"*, `:285`).
The face keeps that choice rather than silently re-deciding it.

`start`/`end` are `'fader'` because they are exactly what the card draws — two
horizontal `<input type=range>` over `0..1` of duration (`:1339`, `:1352`) — and
because two faders side by side read as a *window* in a way two dials do not.
They keep their `START`/`END` captions: this is the tidyVco `A/D/S/R` case
verbatim (CLAUDE.md — *"the only thing separating four identical knobs"*), so
**no `bareCells` entry**.

### 5.2 ⚠ NO TAB RAIL — AND THE "CONTROL-HEAVY" READING IS REFUTED BY THE CENSUS

The owner ruling (`module-faceplates.md:152-164`) gives a control-heavy module a
backdraft-style `face.pages` rail: *"lots of controls of DIFFERENT types"*. This
module *looks* like the strongest candidate in the wave — a 1710-line card, a
knob, two sliders, five buttons, a scrubber, seven file rows and a draggable
rectangle. **It is not, and the reason is arithmetic:**

* `DOCK_TAB_MIN_BANDS = 7` (`dock-tabs-model.ts:101`), applied at `:142`.
* videovarispeed's **ranked control census is THREE**, giving **TWO honest
  bands**.
* Everything else on that list is `node.data`-backed DOM that lives in the
  `fullViewBody`. **A body is not bands.** `dockTabPlan` counts post-hero bands;
  a shell extension contributes none.

So the rail is five bands away, and the only route to it is padding pages — the
named anti-pattern (`module-faceplates.md:189-193`, *"do not pad pages to force
the rail"*). ⚠ It is also worth recording that this module is **not** a fourth
data point for the `DOCK_TAB_MIN_BANDS` threshold question wave 5 routed to the
owner (`wave5/README.md §10.6` — score at 5 bands, numpadPlus at 4, ruttetra at
12 params): those three are *near-misses in the same direction*, and
videovarispeed at 2 bands is not near anything. **Counting it would corrupt the
measurement**, which is the reason to say so rather than to stay silent.

`face.tabbed` is owner-instruction-only (`module-faceplates.md:166-176`) and is
not reached for.

### 5.3 WIDTH — **EARNED**, and the earner is measured

CLAUDE.md: *"Compact is the DEFAULT. Width must be EARNED, and the burden of proof
is on the wide face."* A genuine earner is named in the ruling itself: **a live
picture, a video preview, an XY pad.** This body has the first two and a
drag-rectangle over them.

The measurement, so this is not an assertion:

* the legacy card is **320 px** wide (`VideoVarispeedCard.svelte:1417`) with a
  `16/9` preview (`:1445`) and a `min-height: 140px` floor (`:1444`);
* the body's canvas is **480×360** — the same buffer `LoopbackOutputBody.svelte:227-228`
  uses, and the same one `videoOut`'s body sizes against;
* the bank's row grammar is `[note] [Load video…] [filename] [✕]`
  (`.slot-row` `grid-template-columns: 14px auto 1fr 14px`, `:1678-1682`) and the
  legacy card fits it in 320 px minus 16 px of padding;
* so the body's natural content width is **~480 px**, set by the picture, and the
  bank is *narrower than the picture* — the widest element is the earner, and
  nothing is padded to reach it.

**Declaration:** `width: 100%; min-width: 260px; max-width: 100%` on the body
root, the same shape `VideoOutBody.svelte:358,376-378` already ships, whose own
comment records the reasoning: *"a live picture is the canonical thing that EARNS
width, and `flex: 1 1 auto` … `min-width: 0` is required or the flex item"*.

**No `PLATE_FLOOR_EXEMPTIONS` entry is needed.** That list is `[]` today
(`face-width-source.test.ts:88`) and the gate only fires on a `min-width` at or
above the plate scale (`:183-187`). 260 px is well under it. ⚠ **Do not add a
`min-width: 900px`-shaped floor and do not add the wave's first exemption** — the
ruling's own history is that *"a default that needs a new exemption per review is
the wrong default"*.

The second half of the width gate is the per-face content-vs-plate measurement in
`workflow-shell-faces.spec.ts`. A ~480 px picture inside a plate sized to content
passes it on the merits: the plate is wide **because the picture is**, which is
what "earned" means.

### 5.4 CONTROL INVENTORY — every primitive decision, argued

| face element | primitive | why not the alternative |
|---|---|---|
| SPEED | ranked param cell, `'knob'` | a fader would overturn the card's own analog-clock choice and hide that unity is at the midpoint |
| START / END | ranked param cells, `'fader'` | two dials do not read as one window |
| the picture (lane) | `VideoTileThumb` via `hasVideoSurface` | automatic; nothing to author (§4) |
| the picture (dock) | the body's own blit canvas | the dock hero glyph is capped at `DOCK_HERO_GLYPH_W` and is *"a picture, not a surface"*; a scrubbable frame with a crop rectangle on it is a surface |
| SCREEN ON/OFF | body, overlay bottom-right | the fleet standard; §6.4 |
| PLAY/PAUSE | body | a `toggle` cell is available and refused — §6.2 |
| LOOP ↔ 1-SHOT | body | same — §6.2 |
| the seek scrubber | body | no cell kind scrubs a playhead (`twotracks`' roster entry says so in as many words) |
| file pick (main + ×7) | body | a `ShellFileCell` exists (`shell-cells.ts:306-313`) and §6.2 argues it down |
| the crop rectangle | body | §6.3 |
| the 7-slot bank | body | §6.2 |

---

## 6. THE BODY — `face.extension: 'videovarispeed'`, slot `fullViewBody`

`packages/web/src/lib/ui/modules/videovarispeed/VideoVarispeedTransportBody.svelte`,
registered through `.../videovarispeed/shell-extension.ts` — the conventional
path the `EXTENSION_BODY_ROLES` directory scan reads
(`face-rack-status-source.test.ts:100-116`).

### 6.1 CONTENTS, TOP TO BOTTOM

1. **the PICTURE** — a 480×360 `<canvas>` fed by `blitOutputForPreview(nodeId)`
   in a rAF, letterboxed with the same `srcAspect`/`dstAspect` fit
   `LoopbackOutputBody.svelte:204-209` uses. **Never an adopted `<video>`** (§0.2).
   The `CropOverlay` renders on top of it while editing.
2. **the SCREEN switch** — overlaying the picture's bottom-right corner (§6.4).
3. **the overlays** — drop-hint / re-allow / re-link, the three mutually
   exclusive states the card already computes (`:1194-1229`), same testids.
4. **the CROP row** — `add crop` | `edit crop` + `remove crop` (`:1241-1268`).
5. **the pick row** — `Choose video…` / `Pick another video…` + the transient
   load-error line.
6. **the transport row** — PLAY/PAUSE, then the seek scrubber, then LOOP↔1-SHOT.
7. **the START-past-END warning**, when it applies.
8. **the 7-slot bank** — always visible, seven rows, `[C..B] [Load video…]
   [filename] [✕]`.

### 6.2 WHY `fullViewBody` AND NOT CELLS — THREE CONTROLS THAT *DO* HAVE A CELL KIND, REFUSED WITH REASONS

This is the section worth reading, because three of these affordances **could**
be cells and the easy version of this spec would have made them cells.

**PLAY/PAUSE could be a `ShellToggleCell`.** `shell-cells.ts:314-321` is exactly
*"a 0/1 LATCHING switch backed by node.data"*, and `node.data.isPlaying` is
exactly that. Refused for two independent reasons:

1. **Locality.** A transport whose PLAY is in a band and whose SCRUBBER is in the
   body is a transport split across two surfaces. The scrubber has no cell kind
   (nothing in `ShellCell` scrubs a playhead), so the split is forced, not chosen.
2. ⚠ **A cell would silently un-enrol the module from the sweep written for its
   own owner-P0 bug.** `collapse-keeps-playing.spec.ts:441-447` derives enrolment
   from the DOM: `pane.locator('button[data-testid$="-play-btn"]')`. A `<Toggle>`
   does not emit that. See §8.1 — this is not a preference, it is a live hazard.

**LOOP ↔ 1-SHOT could be a `ShellToggleCell`** over `node.data.loop`. Refused on
locality plus a budget measurement: the lane tile carries the picture, and
`LANE_ROW_MAX_CELLS_WITH_GLYPH = 2`, so the lane already shows only `speed` and
`start`. A fourth cell can only **evict** one of the two ranked controls that are
there. LOOP belongs beside PLAY.

**The file pick could be a `ShellFileCell`** (`kind: 'file'`, adopters `dx7`,
`wavecel`, `samsloop`). Refused for picturebox's reason, one order of magnitude
larger: there are **EIGHT** `<input type="file">` elements here (one main +
seven slots), and a file cell in the ranked order would put a file button in the
46 px lane knob column where the picture should be. `picturebox`'s
`EXTENSION_BODY_ROLES` entry (`face-rack-status-source.test.ts:349`) states the
general form: *"no ParamCellKind mounts one, so without this body a promoted
picturebox would be a picture source with no way to be given a picture."*

**A `panel` cell is refused for the bank** for picturebox's second reason: a
`ShellPanelCell` requires a `probe` (`shell-cells.ts:380-381`) whose vocabulary is
`data`/`data-rev`/`text`, and *a file input's observable is a browser dialog*.
There is no honest `data` probe for "the picker opened".

`fullViewBody` needs no probe **because it is a SLOT rather than a cell** — the
`samsloop` entry in `module-faceplates.md:857-861` is the precedent, and its
bands below are untouched, so face completeness, the dock render-plan parity gate
and `faces-parity` all still apply.

**Never `editorSurface`**: `WIRED_SHELL_EXTENSION_SLOTS` is `['glyph',
'fullViewBody']`, and the first `editorSurface` adopter must wire its render site
in `ModuleShell` in the same diff. This module has no business wiring a platform
slot.

### 6.3 THE CROP RECTANGLE — a BODY, and the discriminator is not the one you would reach for

The obvious argument is `twotracks`' — *"IT IS A BODY RATHER THAN A PANEL by the
mechanical discriminator: both the envelope and the playhead are PER-FRAME ENGINE
READS with nothing on the node to derive them from"*
(`face-rack-status-source.test.ts`, the `twotracks` entry). ⚠ **That
discriminator does NOT apply here and using it would be a copied sentence**: the
crop rect *is* on the node (`node.data.crop`, `videovarispeed.ts:144`), so a
panel probe could read it cleanly.

The argument that does apply is **registration**:

> The crop rectangle is a box drawn **in the coordinate space of the frame**, and
> the only thing that makes it meaningful is that it sits over the pixels it
> crops. A `panel` cell is a separate box in a band row. Putting the crop editor
> in a panel would mean either drawing a second copy of the live frame inside the
> panel — two blits of one node, at two sizes, for one rectangle — or editing a
> rectangle against nothing. **The overlay must be registered to the picture, so
> it lives where the picture lives.**

The platform already agrees with that in the one place it has been asked:
`quadralogical` declares `face.xyPads[0].surface: 'body'` so *"the dock paints no
band cell for pos_x/pos_y, and this surface IS the joystick"*
(`face-rack-status-source.test.ts`, the `quadralogical` entry, gated by
`face-xy-body-source.test.ts`). Crop is not an XY pad — it is `{active,x,y,w}` on
`node.data`, not two params — so it needs **no declaration at all**; it is body
markup with pointer handlers, exactly as `twotracks`' loop markers are.

The card's crop machinery ports unchanged and correctly: `readCrop`/`writeCrop`
live in the shared, origin-tagged `ui/modules/crop-edit.ts`, and `pushCrop`
(`:206-215`) retries until the engine has materialised the node. **The body calls
the same two functions.** ⚠ Do **not** re-implement them — `crop-edit.ts`'s own
header says it exists to keep *"the Yjs in-place mutation discipline in ONE
testable place (crop-edit-ydoc.test.ts)"*.

⚠ **ONE HAZARD, and it is a real one.** `cropEditing` is card-LOCAL `$state`
(`:187`) and `pushCrop`'s retry timer is card-local. The body has its own
component lifetime. Two mounts of the crop editor — a headless-hosted card and a
visible body — would both run `$effect`s that call `extras.setCrop(...)`. They
push the *same* value from the *same* `node.data`, so the result is idempotent
rather than racy, but it is two pushes per change. **Mitigation, and it is the
same shape `loopback` used:** the body owns the visible editor; the card's crop
row and overlay are already unreachable in the headless host
(`pointer-events: none`), so nothing needs deleting — but the PR must **verify**
the double-push is benign rather than assume it (M4, §13).

### 6.4 SCREEN ON/OFF — the fleet standard, with this module's own argument

Owner ruling (2026-08-18): every video module gets it. Gate:
`video-face-screen-source.test.ts`, deny-by-default over `STRICT_FACES ∩ video
defs`, whose `NO_SCREEN_SWITCH` list has exactly one entry (`videoOut`, *"videoOut
IS the screen"*). **videovarispeed does not qualify for that exemption** and does
not want it: with the screen collapsed you still have a complete player — a
transport, a window, a bank and a speed knob — which is the `twotracks` argument
verbatim.

Mechanics, all load-bearing:

* the key is **`node.data.previewCollapsed`**, the shared one
  (`LoopbackOutputBody.svelte:73-82`), written through `mutateNode` so it is
  origin-tagged and undoable;
* the button **OVERLAYS the picture's bottom-right corner on a translucent
  backplate** (`rgba(5,6,8,0.72)`), never a row of its own —
  `module-faceplates.md:206-222` measures the stacked-row anti-pattern at
  **~18.8 px on a card carrying ~11 px of slack**, and an overlay's height delta
  is **ZERO**;
* the wrap keeps a `min-height: 18px` floor that is inert behind the canvas and
  only matters with SCREEN OFF (`LoopbackOutputBody.svelte:310-317`);
* **OFF skips the PAINT, never the engine read.** The collapsed branch still runs
  `markWatched(nodeId)` — with the honest justification from §4.1, not the
  copied one.

⚠ Because this module is a **DOM-source module whose decode is driven by the
card's rAF transport**, SCREEN OFF must not touch anything the card owns. The
body's collapsed branch does exactly two things: skip the blit, and mark. It does
not pause, detach or unwire. Anything else would be the #1720/#1721 bug class.

### 6.5 `EXTENSION_BODY_ROLES` — the THIRD gate a face PR satisfies

`face-rack-status-source.test.ts:150` is deny-by-default over **every**
`fullViewBody` in the tree, with membership derived off the DIRECTORY
(`extensionsWithBody()`, `:100-116`) so a new body cannot enter without an entry
(`:646-658`). The role carries a **mechanical predicate** the source must satisfy
(`ROLE_PREDICATE`, `:471-492`).

⚠ **SPOT-CHECK THAT CAME BACK DIFFERENT FROM THE BRIEF, AND THE CORRECTION IS
CONFIRMED FROM TWO DIRECTIONS.** The brief listed three existing roles —
`picture`, `status-primitive`, `control-grid` (*"added by #2184"*). **On
`ea2e06340` there are TWO**:

* `:142` — `type BodyRole = 'picture' | 'status-primitive';`
* `:690-696` — an ANCHOR asserting the live role set exactly:
  `expect([...roles].sort()).toEqual(['picture', 'status-primitive']);`
* `grep -c "control-grid"` over that file returns **0**.

**#2184 is an OPEN PR, not merged** (independently re-verified by the wave's
orchestrator after this spec was drafted). The anchor at `:695` is the part worth
carrying forward: **a third role cannot be added silently — it reddens that
assertion** — so if #2184 lands before this face is built, the roster will have
three roles *and the anchor will have been edited to say so*. Re-read it rather
than trusting either list.

**ROLE: `picture`.** The predicate is `paintsCanvas(src, extId)` (`:476`) and the
body mounts a `<canvas>` directly, so it holds. ⚠ Note the two predicates are
**ordered by the canvas test, not mutually exclusive by intent**:
`status-primitive` is `/StatusLed/.test(src) && !paintsCanvas(...)` (`:481-483`),
so a body that keeps a preview canvas **and** imports `StatusLed` is legally
`picture`. No new role is needed here, and none is proposed.

The `why` string to commit, written out so it is reviewed here rather than
invented at build time:

```
videovarispeed: { role: 'picture', why:
  'the varispeed player\'s live output BLIT plus everything a player touches: the transport '
  + '(PLAY/PAUSE, the seek scrubber, LOOP↔1-SHOT), the file pick with its drop target, re-link '
  + 'and re-allow overlays, the CROP rectangle dragged over the frame, the 7-slot asset bank, '
  + 'and its SCREEN switch. '
  + '⚠ THE PICTURE IS BLITTED AND THE SEVEN <video> ELEMENTS ARE NEVER ADOPTED — the cameraInput '
  + 'and loopback constraint, one order of magnitude larger: VideoVarispeedCard adopts SEVEN '
  + 'node-owned elements through nodeMedia and its rAF transport drives slotEls[activeSlot], so '
  + 'a body that adopted slot 0 would take the element out of the card mid-transport and '
  + 'videoEl would go null. '
  + '⚠ IT IS THE ONLY SURFACE A PLAYER CAN REACH: promotion moves the real card into '
  + '<HeadlessSourceHost>, parked at left:-9999px with pointer-events:none, so the card is '
  + 'MOUNTED (which is what keeps the seven elements, the rAF varispeed transport, the 33 ms gate '
  + 'edge loop and the perf-zip export resolver alive) and nothing on it is CLICKABLE. '
  + '⚠ NO STATUS REGISTRY, unlike cameraInput and loopback, and that is derived rather than '
  + 'skipped: those two needed one because NOTHING about a browser capture grant is in the graph, '
  + 'whereas this module\'s entire transport is — isPlaying, loop, fileMeta, slotMeta and crop are '
  + 'node.data and speed/start/end are params, so a body reading patch.nodes[id] sees everything '
  + 'the card sees. '
  + '⚠ THE CROP RECTANGLE IS BODY MARKUP RATHER THAN A PANEL for a reason that is NOT twotracks\' '
  + 'per-frame-read discriminator (the rect really is on node.data): a crop box is drawn in the '
  + 'coordinate space of the frame, so a panel would have to blit a SECOND copy of the same node '
  + 'to have anything to draw it over. It writes through the shared origin-tagged crop-edit.ts. '
  + '⚠ SCREEN OFF KEEPS markWatched, but NOT for the #2015 accumulator reason the rest of this '
  + 'roster gives: this module is UNCONDITIONALLY pull-exempt while an AudioContext exists, '
  + 'because isPullExempt returns true on a non-empty audioSources map and the factory installs '
  + 'two silent ConstantSourceNodes at construction. The mark is kept because the exemption '
  + 'evaporates in an audio-less boot — which is the environment the gates run in. '
  + '⚠ TEXT ON THE SURFACE, exhaustively: button captions (SCREEN, Play/Pause, LOOP, add/edit/'
  + 'remove crop, Choose video…, Load video…), the START and END slider captions, the seven '
  + 'scale-degree tags C D E F G A B, and up to eight FILENAMES — each a NAME, not a measurement. '
  + '⚠ NOT on it, deliberately: the card\'s `0:04 / 2:00` playhead readout and its `+1.0×` speed '
  + 'readout, both DELETED rather than hidden; the position and the multiplier live in '
  + 'aria-valuetext. A transient LOAD ERROR and a transient START-past-END warning remain, and '
  + 'both are absent whenever nothing is wrong.' },
```

---

## 7. RESTING TEXT — TWO readouts are REMOVED, and this names what loses its surface

`face-resting-text-source.test.ts` denies the SHAPE: every `ModuleFace` field
must carry a declared text ROLE, and the permitted roles are exhaustively the
module NAME, TAB/SECTION labels, CONTROL CAPTIONS and OPTION/LANDMARK NAMES. It
states its own blind spot — text drawn inside a `fullViewBody` is invisible to it
— which is why §6.5's `why` enumerates the body's text and why the dock VRT
baseline plus a human are what actually see it.

The card paints two derived-state readouts:

| card text | site | face | why |
|---|---|---|---|
| `0:04 / 2:00` | `:1298-1300` (`formatTime(displayPos)` / `formatTime(durationSec)`) | ⚠ **REMOVED from every surface** | a timecode is a measurement, refused by name |
| `+1.0×` | `:1324` (`speedLabel`, `:1163`) | ⚠ **REMOVED from every surface** | a multiplier is a measurement of a control that is right next to it |
| the filename | `:1367-1371` and per-slot `:1403` | **KEPT, in the BODY** | a NAME, and a file bank whose rows do not say which file is in them is not a file bank — the `picturebox` disposition |
| `START past END — no playback` | `:1363-1365` | **KEPT, transient** | an outcome the player must see; an error is not resting derived state |
| the load error | `:1286-1288` | **KEPT, transient** | same |

⚠ **DELETING A READOUT DELETES A FINDING, and here are the two that lose their
surface.**

1. **The playhead position.** It was the only place a player could see *where in
   the clip* they were, and the only place a **collaborator without a local copy**
   could see anything at all. It survives on the SEEK scrubber's own
   `aria-valuetext` — the scrubber is a control whose *position* is the picture,
   which is the permitted form (a slider showing where the head is is not text).
   **Nothing is weakened**: every spec proving a face tracks the graph reads
   `aria-valuetext` already.
2. ⚠ **The speed multiplier — and this one is the interesting loss.** `+1.0×`
   was the ONLY surface on which the module's single most non-obvious fact was
   visible: **unity is at the knob's MIDPOINT, and the dial is asymmetric**
   (−4× … +1× … +4× across 0…1). A dial reading "0.5" tells a player nothing.

   The face carries it in two places, one free and one not:

   * `aria-valuetext` on the SPEED cell, and the arithmetic pinned in
     `videovarispeed-face-model.test.ts` — **free, and it is what PR 1 ships**;
   * **landmark NAMES on the param** — `−4×` at 0, `1×` at 0.5, `+4×` at 1 — which
     `paintsReadout` permits because the text is a declared option/landmark NAME.
     The precedent is exact: `acidwarp`'s roster entry records *"the speed
     mapping's one non-obvious fact (NATIVE 1x is the knob's MIDPOINT) moved onto
     the param as landmark NAMES."*

   ⚠ **The landmarks are NOT free.** A `ParamOption` roster is ordinary code
   inside `params[]`, and `HASH_TRANSPARENT_PROPS` strips only a def's top-level
   `docs` / `controlFamilies` / `face` / `noUserControl`. **It moves the WebGL
   attest hash.** §10.1 splits it into PR 2 for exactly that reason. This is the
   `moogCp3` lesson (*"unity is at the dial's MIDPOINT"*) meeting the picturebox
   lesson (*"a stray line of code converts a free PR into a GPU window"*), and the
   two point in opposite directions — which is why the split is the answer rather
   than a preference.

---

## 8. THE MIGRATION SURFACE — TWELVE e2e SPECS, AND ELEVEN OF THEM GO GREEN-AND-BLIND

`grep -rln videovarispeed e2e/` returns 12 spec files plus four generated /
config artifacts. **Eleven of the twelve boot `?shell=legacy`**, measured:

| spec | boot | after promotion |
|---|---|---|
| `varispeed-panel-layout.spec.ts` | `rack` fixture → `/rack?shell=legacy&seed=none` (`_fixtures.ts:93`) | ⚠ **GREEN AND BLIND — and its CARDS table EMPTIES. §8.2** |
| `varispeed-multislot-persist.spec.ts` | `:23` legacy | survives; tests the card, which still exists |
| `videovarispeed-crop.spec.ts` | `:31` legacy | survives |
| `videovarispeed-output.spec.ts` | `:28` legacy | survives |
| `videovarispeed-perfzip.spec.ts` | `:36` legacy | survives |
| `videovarispeed-switch.spec.ts` | `:267` legacy | survives |
| `multi-video-playback.spec.ts` | `:81` legacy | survives |
| `video-audio-output.spec.ts` | `:40` legacy | survives |
| `camera-input.spec.ts`, `cable-drag-drilldown.spec.ts`, `workflow-lane-add-safety.spec.ts`, `workflow-master-transport.spec.ts`, `workflow-media.spec.ts` | fixture/legacy | fixture uses; unaffected |
| `per-module.spec.ts`, `per-module-per-port-behavioral.spec.ts` | registry-driven | auto-enrol; `_per-module-per-port-shared.ts:204` already excludes output assertions with a `why` |
| **`collapse-keeps-playing.spec.ts`** | **`/rack` — the DEFAULT shell** (`:107-110`, *"do not add a shell param"*) | ⚠ **THE HEADLINE. §8.1** |

**That eleven-to-one split is the `e2e-rack-fixture-hides-shell-parity` fact,
firing on the module with the most specs in the cohort.** A spec on the legacy
flag keeps the CARD in the lane, so it keeps finding `videovarispeed-*` testids
and keeps passing — while testing a surface a workflow-mode player no longer
operates. The DOCK, meanwhile, swaps on `migrated()` alone
(`module-faceplates.md:27-31`).

### 8.1 ⚠ `collapse-keeps-playing.spec.ts` — THE OWNER-P0 SWEEP FOR *THIS MODULE*, AND PROMOTION BREAKS IT TWO DIFFERENT WAYS

This is the single highest-value item in the spec, and it is worse than the
`varispeed-panel-layout` case because **the spec exists for this module's own
owner-reported P0** (`:3-6`):

> *"videovarispeed stops playing if its card is collapsed. i put it on scene,
> expand, load video, play → stops playing as soon as the expanded tray is
> dismissed."*

It is registry-driven off `DOM_SOURCE_LANE_TYPES` (`:57-69`, parsed from source
and refusing to pass vacuously) and it boots plain `/rack` on purpose. Promotion
hits it in **two independent places, which fail in OPPOSITE directions**:

**(a) THE ENROLMENT PREDICATE GOES FALSE → `test.skip` → GREEN AND BLIND.**
`:441-447`:

```ts
const fileInput = pane.locator('input[type="file"][data-testid$="-file-input"]').first();
const playBtn   = pane.locator('button[data-testid$="-play-btn"]').first();
const isPlayer  = (await fileInput.count()) > 0 && (await playBtn.count()) > 0;
test.skip(!isPlayer, `${type} is not a local-file player …`);
```

`pane` is `[data-testid="dock-full-view"]`. After promotion `DockFullView`
renders `<ModuleShell>` instead of the card, so **whether this predicate still
holds is entirely a property of what the body emits**. If the body used a
`ShellFileCell` and a `ShellToggleCell` instead of an `<input type=file>` and a
`*-play-btn` button, the count goes to zero, the test SKIPS with a loud message,
and the sweep silently stops covering the module it was written for.
**Skips are not passes.** This is the direct reason §6.2 refuses the toggle cell.

**(b) THE ASSERTIONS SCOPE THE `<video>` TO THE DOCK PANE → RED.** `:456-459`,
`:492`, `:303-305` all query `document.querySelectorAll('[data-testid="dock-full-view"] video')`.
After promotion the seven elements are in the **headless host**, not the dock
pane, because the body blits and never adopts (§0.2). The
`waitForFunction` at `:451-462` would time out at 30 s.

⚠ **The two failures mask each other in the worst possible order**: (a) fires
first, so the run goes GREEN with a skip, and (b) is never reached. A reviewer
looking at a green CI run sees nothing.

**THE FIX — fix the SUBJECT, not the threshold:**

1. **The body MUST re-emit `videovarispeed-file-input` and
   `videovarispeed-play-btn`** as a real `<input type="file">` and a real
   `<button>`. That is not test-shaped design: they are the honest primitives for
   both affordances (§6.2), and the predicate is derived from them precisely
   because they identify a local-file player.
2. **The `<video>` queries must drop the dock scoping.** The spec's own
   `where` classifier (`:95-101`, `:303-305`) already knows the three homes —
   `dock` / `headless` / `parking` — so the change is deleting a selector prefix,
   not adding a concept. The instrument (in-page accumulated playback progress,
   wrap-safe and seek-proof, `:180-206`) is unaffected: it measures a media clock,
   not a DOM location.
3. **Add a permanent NEGATIVE LEG**: assert that the element found is NOT in the
   dock pane for a faced module. Otherwise the repair is one refactor away from
   being undone silently, and "the element moved" and "the element vanished" read
   identically from a green run.

The PR body must state that it did (1), (2) and (3), and why.

### 8.2 ⚠ `varispeed-panel-layout.spec.ts` — ITS `CARDS` TABLE EMPTIES, SO THE SPEC IS RETIRED WITH THE DESIGN

The spec's own header already worked this out **for picturebox, four days ago**
(`:18-38`), and the sentence that matters is:

> *"THE SPEC IS NOT DELETED, because its real subject is the OVERLAY-SHEET
> TECHNIQUE and not picturebox. `videovarispeed` still draws the same panel
> inside the same rack-sized box, is NOT in STRICT_FACES, and is the harder of
> the two cases (it also carries `overflow: hidden`, so its bottom rows were
> CLIPPED rather than merely spilling). The row that survives is the one that
> caught the original bug in its worst form."*

`CARDS` is now a one-element array (`:39-41`) and that element is
`videovarispeed`. **Promoting it empties the table.**

The reasoning transfers verbatim, and every clause of it is verified for this
module:

* the panel is an absolute overlay clipped to a rack-unit-locked card — the CSS
  comment at `VideoVarispeedCard.svelte:1634-1640` says exactly why (*"the card
  is pinned to an exact rack-unit height … with `overflow: hidden`, so an in-flow
  panel pushed past the tier and its bottom rows (slots A/B) were clipped"*);
* in a `fullViewBody` **there is no rack-unit height and no `overflow: hidden`**,
  so the containment the spec measures ceases to exist;
* the spec boots `?shell=legacy` (the `rack` fixture, `_fixtures.ts:93`), so it
  would keep finding the legacy card, keep finding the panel, and **keep
  passing** — asserting a containment that no longer constrains anything a player
  can reach.

**Disposition: DELETE the spec file**, and say so in the PR body with the reason.
This is the honest close rather than a hedge, and the evidence is that the
overlay-sheet technique has exactly two adopters in the whole tree —
`grep -rln multiOpen packages/web/src/lib/ui/modules/` returns
`PictureboxCard.svelte` and `VideoVarispeedCard.svelte`, and picturebox's row was
already retired. **The technique's last living subject dies with this
promotion.** Keeping a zero-row `for` loop over an empty `CARDS` array would be a
file that runs no tests and looks like coverage.

⚠ **Do NOT re-point it at picturebox.** That row was removed four days ago for
this exact reason and re-adding it would restore a green-and-blind test.

### 8.3 THE DOM-SELECTOR COST, COUNTED HONESTLY

The specs above drive these card testids:
`videovarispeed-card`, `-preview`, `-drop-hint`, `-reallow-hint`, `-reallow-btn`,
`-relink-hint`, `-relink-input`, `-pick-label`, `-file-input`, `-error`,
`-play-btn`, `-time`, `-seek`, `-speed-readout`, `-loop-btn`, `-start`, `-end`,
`-window-warn`, `-filename`, `-add-crop`, `-edit-crop`, `-remove-crop`,
`-multi-panel`, `-multi-close`, `-slot-{i}`, `-slot-input-{i}`, `-slot-name-{i}`,
`-slot-clear-{i}`, `-video`, `-slot-video-{i}`.

**Because the CARD SURVIVES in the headless host, every legacy-booting spec keeps
finding all of them unchanged.** That is the one way this migration is *cheaper*
than picturebox's: there is no mass selector rewrite, because there is no
surface being deleted.

The body re-emits the subset a player operates, under the same names, with two
exceptions:

* ⚠ **`videovarispeed-speed-readout` and `videovarispeed-time` are NOT
  re-emitted** — they are the removed readouts (§7). Their assertions move to
  `aria-valuetext`.
* ⚠ **`videovarispeed-multi-panel` should NOT be re-emitted.** It names a panel
  whose defining property was being hidden behind a right-click. Rename to
  **`videovarispeed-assets-body`**, and let the rename be the signal — the
  picturebox disposition.

---

## 9. VRT — AN EXEMPTION WHOSE STATED REASON THE FACE HALF-DISCHARGES

Today: **`EXEMPT_FROM_VRT`** (`vrt-exemptions.ts:910`) and
`ALLOWED_PERMANENT_EXEMPT` (`:1181`). No `vrt.spec.ts` baseline PNG exists
(`ls e2e/vrt/__screenshots__/vrt.spec.ts/ | grep -i videovarispeed` → nothing).
No face scenes exist.

The exemption's `why`:

> *"live `<video>` element streamed at varispeed + **ticking playhead readout**
> defeat deterministic capture; unit + transport-math + e2e output spec +
> per-module spawn smoke provide coverage"*

⚠ **The face DELETES the ticking playhead readout** (§7). So half the stated
reason ceases to exist on the faced surface, and copying the sentence forward
would be a stale ledger entry — the exact shape the file's own
`warrensspectrum` entry (`:882`) was rewritten to avoid.

**The face scenes ARE capturable without a simPin, and the argument is
`samsloop`'s**, three facts deep (`_shell-faces.ts`, the `samsloop` entry):

1. **a freshly spawned videovarispeed holds NO FILE.** No `<video>` has a `src`,
   `hasLocalFile` is false, so the body takes its empty branch: the drop-hint
   overlay and seven empty bank rows.
2. **the idle picture has no time term.** `videovarispeed.ts:102-105` is
   `outColor = vec4(0.05, 0.05, 0.08 + vUv.y * 0.05, 1.0)` when `uHasInput < 0.5`
   — a static vertical gradient, a pure function of `vUv`. There is no clock to
   pin, so unlike `mandleblot` there is nothing for a `__videoEngineFreezeTime`
   pin to do.
3. **the seek scrubber is DISABLED and at zero.** `disabled={durationSec <= 0}`
   (`:1311`) with `value={displayPos}` = 0. The one time-varying control is
   inert at spawn.

**So: no `simPin`, and that is DERIVED rather than optimistic.** The `cameraInput`
and `loopback` entries needed `__camerainputTestFrame` / `__loopbackTestFrame`
because *their* idle state is a live stream; this module's idle state is a
constant.

**Procedure, in order:**

1. **Predict the file count**: **two added** (`face-videovarispeed-compact.png`,
   `face-videovarispeed-dock.png`), **zero moved** — there is no card baseline to
   move, because the module is exempt.
2. Add the `FACES` entry in `e2e/vrt/_shell-faces.ts` with `pages: 2` and a
   `videoFaceWhy` — ⚠ **required**, and `cameraInput`'s entry
   (`_shell-faces.ts:2783-2787`) says why: *"a VIDEO module, so it must boot into
   the video zone rather than a mixer channel column — without this field
   `bootWithFace` waits out the full 90 s test timeout for a column membership a
   video node never acquires."*
3. **Rewrite the `EXEMPT_FROM_VRT` entry** to the `warrensspectrum` shape: the
   operated surface is the faceplate, captured by the two face scenes; this entry
   now covers only the LEGACY card at `?shell=legacy`, whose live `<video>` and
   ticking readout still defeat capture. Keep the `ALLOWED_PERMANENT_EXEMPT`
   membership (anchored: an entry naming a non-exempt module is RED).
4. Dispatch **scoped**: `GREP=videovarispeed flox activate -- task vrt:commit`. A
   bare dispatch on a face PR derives FULL, because every face PR touches a
   shared roster file whose path names no module.
5. **Count what the bot commits against the prediction. A green dispatch that
   committed nothing is a RED FLAG.**

---

## 10. COST

### 10.1 ⚠ WEBGL ATTEST — THE DEF IS IN THE BASIS. THE PR SHAPE IS THE WHOLE COST QUESTION.

```
flox activate -- bash scripts/webgl-attest-hash.sh --list | grep -iE 'videovarispeed|crop|asset-select'
  packages/web/src/lib/video/asset-select.ts
  packages/web/src/lib/video/crop-core.ts
  packages/web/src/lib/video/crop-render.ts
  packages/web/src/lib/video/modules/videovarispeed-transport.ts
  packages/web/src/lib/video/modules/videovarispeed.ts
```

Five of this module's files are in a 218-file basis. **Nothing under
`packages/web/src/lib/ui/**` is** — so the card, the body, `crop-edit.ts`,
`CropOverlay.svelte` and every registry are outside it.

`HASH_TRANSPARENT_PROPS` (`scripts/attest-code-basis.ts`) strips a def's
**top-level** `docs`, `controlFamilies`, `face` and `noUserControl`. So:

| edit | in basis? | attest |
|---|---|---|
| `face: {...}` on `videoVarispeedDef` | yes, stripped | **ZERO** |
| `noUserControl: [...]` at def top level | yes, stripped | **ZERO** |
| `docs` rewrites (D4, D6) | yes, stripped | **ZERO** |
| `paramSpec(videoVarispeedDef,'speed').max` in the CARD | card is not in the basis | **ZERO** |
| ⚠ `options: [...]` inside a `ParamDef` (§7's landmarks) | yes, **NOT stripped** | ⚠ **MOVES THE HASH** |
| ⚠ `export const VIDEOVARISPEED_SPEED_RANGE` | yes, **NOT stripped** | ⚠ **MOVES THE HASH** — the `*_RANGE` export is the expensive spelling (`module-faceplates.md:384-413`) |

> **A videovarispeed face PR that adds ONLY `face`, `noUserControl` and `docs`
> prose to the def costs ZERO GPU. Any other edit to `videovarispeed.ts` costs a
> real-machine re-attest that CI (SwiftShader) cannot run.**

**Recommended PR shape:**

* **PR 1 (this face)** — `face` + `noUserControl` + the docs fixes (D4, D6), the
  extension body, the two registries, the `collapse-keeps-playing` repair (§8.1),
  the `varispeed-panel-layout` retirement (§8.2), the `paramSpec` boy-scout (D3),
  and `videovarispeed-face-model.test.ts`. **Zero attest.**
* **PR 2 (the SPEED landmarks, §7)** — a `ParamOption` roster on `speed`. **This
  one moves the hash and needs the GPU.** It is a genuine improvement (it restores
  the finding the deleted readout carried, as a NAME rather than a number) and it
  must not hold PR 1 hostage to an attest window. Wave 5 named merging them *"the
  single most avoidable cost in a face wave."*

⚠ **Verify, do not assume, and measure BOTH directions** — the picturebox
correction is that the obvious reading of an attest measurement can be false.
Run `scripts/webgl-attest-hash.sh` on the clean merged tree, then after the
`face` + `noUserControl` edit (must be UNMOVED), then after a deliberate
positive control (bump `speed`'s `max` to 2 — must MOVE), then revert.
⚠ **Attest a pin covers a TREE, not a PR**: match CI's refusal hash before
spending the GPU, and never measure attest state in a dirty primary checkout.

### 10.2 ART — ZERO, measured rather than inferred

* `ls art/baselines/` — no `videovarispeed/` directory.
* The audio profile gate enumerates **audio-domain ids only**
  (`audio-profile-gate.test.ts`, matching `/^(\S+) meta domain=audio\b/` off the
  contract golden). videovarispeed is `domain: 'video'` (`videovarispeed.ts:224`),
  so the gate never sees it.

**`art/` should be absent from this diff.**

### 10.3 CONTRACT — moves, and the diff must be READ

`face` is fully contract-transparent (`module-faceplates.md:601-615`;
`FACE_FIELDS_IN_LOCK` is empty). But this PR edits `docs` (D4, D6), and
`STRICT_DOCS` contains `videovarispeed` (`strict-docs.ts:368`), so
`flox activate -- task docs:accept` is required and the diff must be reviewed.
**No `controlFamilies` entry is added** (the body is a slot, not a family), so no
new contract-lock family line.

### 10.4 CI wall-time

New: two VRT face scenes (they ride the scoped `vrt:commit` dispatch, not the
PR's CI lane) and one new unit file. `varispeed-panel-layout.spec.ts` is
**deleted**, which returns time. `collapse-keeps-playing` is edited, not added.
`faces-parity` auto-enrols the module at 3 cells; its CI budget is roughly
`10 s + 0.8 s/cell` → **≈ 12 s**.

**Estimated PR delta: comfortably under 2 minutes, and plausibly NEGATIVE**
(a deleted spec against ~12 s of parity). ⚠ **Re-pin BOTH cost artifacts** —
`task e2e:timings:accept` AND `task vrt:strict:timings:accept`. An unmeasured
`vrt-strict` scene rides the median and has reddened `main` at 92 % of a shard
budget with every test passing.

### 10.5 The Push 2 card moves

videovarispeed has no explicit `PUSH_CARD_CONTROLS` entry, so its card is
resolved from the live def. Today it is GENERIC tier (declaration order:
`speed, start, end, speedCv, startCv, endCv, cv_start, …`). Authoring a `face`
moves it to the FACE tier (first 8 turnable params of `face.order`), and
declaring `noUserControl` drops the nine synthetic params from
`push-card-schema.ts` entirely. **The card goes from eight slots of mostly raw CV
caches to three real controls.** That is an improvement, it is a behaviour change
outside the faceplate, and it must be in the PR body with a deliberately accepted
golden diff. `push-card-schema.test.ts` is a must-run.

---

## 11. DEFECT LEDGER — live on `main`, independent of any face

Each item is fixed **inside this PR** unless marked otherwise; there is no issue
to file (owner ruling), and the PR narrative is the searchable record.

| # | defect | evidence | routing |
|---|---|---|---|
| **D1** | ⚠ **`varispeed-panel-layout.spec.ts` goes GREEN AND BLIND on promotion and its `CARDS` table empties.** Its own header already worked the reasoning out for picturebox four days ago; videovarispeed is the last row. | `varispeed-panel-layout.spec.ts:18-41`; `_fixtures.ts:93` | **fix in this PR** — delete the spec with the design it covered (§8.2) |
| **D2** | ⚠ **`collapse-keeps-playing.spec.ts` — the sweep written for THIS module's owner P0 — breaks in two opposite directions, and the GREEN one masks the RED one.** DOM-derived enrolment against the dock pane goes false → `test.skip`; the `<video>` assertions are scoped to `dock-full-view` while the element lives in the headless host. | `:441-447`, `:456-459`, `:492` | **fix in this PR** — §8.1's three-part repair, including a permanent negative leg |
| **D3** | ⚠ **The SPEED knob re-types its range** — `min={0} max={1}` as literals while `defaultValue={defaultFor('speed')}` correctly reads the def. The backdraft class. videovarispeed is **outside `RANGE_BOUND_CARDS`**, so no gate sees it. | `VideoVarispeedCard.svelte:1319-1320` vs `videovarispeed.ts:265` | **fix in this PR** with `paramSpec(videoVarispeedDef,'speed')` — ⚠ **ZERO attest**, unlike a `*_RANGE` export (§10.1). Add the card to `RANGE_BOUND_CARDS` |
| **D4** | ⚠ **The def's FILE HEADER contradicts both the code AND the def's own docs.** `videovarispeed.ts:49-50` says a slot switch means *"the newly-active video restarts from the beginning (currentTime=0)"*. The card does the opposite: `selectAssetSlot` jumps to `slotPos[i]`, the slot's **live virtual playhead**, clamped into the window. `docs.explanation` (`:285`) has it right (*"each slot running its own virtual playhead so a switch jumps to that clip's live, de-synced position"*). | `:49-50` vs `VideoVarispeedCard.svelte:814-821` vs `videovarispeed.ts:285` | **fix in this PR** — comment-only, hash-transparent |
| **D5** | ⚠ **AND THE DOCS SITE SHIPS THE WRONG BEHAVIOUR.** `DESCRIPTIONS.videovarispeed` says a gate edge *"makes it the active source, **RESTARTS IT FROM THE BEGINNING (currentTime=0)**, plays it …"* — capitalised, emphatic, and false since the virtual-playhead change. ⚠ `module-docs-lint` reads the DEF, so it is **structurally blind** to a `DESCRIPTIONS` string promising behaviour the implementation never had — the same class wave 5 found independently on `modtris` and `score`, which makes it a CLASS rather than a typo. | `module-manifest.ts:306` vs `VideoVarispeedCard.svelte:795-832` | **fix in this PR** — prose-only |
| **D6** | ⚠ **Right-click opens BOTH the node context menu and the slot panel**, and the only thing that knows is a test pressing Escape. Six of seven slots are behind a gesture nothing advertises. **This ANSWERS picturebox's open MUST-VERIFY M1 in the affirmative (outcome 1).** | `VideoVarispeedCard.svelte:670-674`, `:1179`; `varispeed-panel-layout.spec.ts:53-57` | **fixed by the face** (the bank is the body; no `oncontextmenu` is bound). ⚠ Report the M1 answer to the picturebox lane |
| **D7** | **A 100 ms interval whose only consumer the face deletes.** `displayTimer` refreshes `displayPos` (`:1117-1124`) purely to drive the removed `-time` readout and the seek `value`. On the faced surface the card is off-screen, so the interval runs forever feeding an invisible element. | `:1119-1124` | **fix in this PR** — the body owns its own display refresh; the card's can go, or be gated on the card being on-screen. ⚠ Check the seek `value` binding first — it reads `displayPos` too |
| **D8** | ⚠ **A dead branch plus a stale comment in the video-zone packing.** `Canvas.svelte:2880-2887` computes a per-node width for *"a LEGACY-rendered default — videoOut, the video-surface snowflake whose real card stays in the lane"*, guarded by `NON_SHELL_LANE_TYPES.has(spec.type)`. **videoOut is in `STRICT_FACES` (`strict-faces.ts:2075`) and is NOT in `NON_SHELL_LANE_TYPES` (`legacy-fallback.ts:96-112`)**, and none of the three `VIDEO_ZONE_DEFAULTS` (`channel-columns.ts:585-587`) is. So the `else` branch is unreachable and its comment describes a carve-out removed by #1821. | direct read, both sets | ⚠ **NOT this PR** — it is `videoOut`'s residue, not videovarispeed's, and folding a Canvas edit into a face PR widens the diff for no gain. **Route to the owner as a one-line cleanup**; recorded here because it is the load-bearing fact behind `../videobox/spec.md` §2.3 |

---

## 12. TASTE CALLS, EACH WITH ITS ONE-LINE REVERT

| call | revert |
|---|---|
| SPEED is a `'knob'`, START/END are `'fader'`s | change the `paramCells` entries |
| two pages (`transport` / `window`) rather than one band | collapse `pages` to a single entry |
| the bank is always visible rather than behind a disclosure | wrap the seven rows in a `<details>` |
| the picture sits at the TOP of the body, transport under it, bank last | reorder the body's blocks |
| PLAY and LOOP are body buttons, not `toggle` cells | move them to `controlFamilies` + `SHELL_CELLS` — ⚠ but re-read §8.1 first |
| the SCREEN switch overlays the picture's corner | — (a stacked row is the named anti-pattern; not a taste call) |
| no tab rail | — (adding one needs an owner instruction) |

---

## 13. MUST-VERIFY (before the face is written)

* **M1 — the lane picture actually paints, both directions.** Spawn a promoted
  videovarispeed under the default shell, load the long fixture, and read the
  lane tile's thumb: assert non-black with a clip loaded, and assert it matches
  the idle gradient (`rgb ≈ (13,13,20)` from `videovarispeed.ts:104`) with no
  file. Both directions, because "black" and "never looked" are indistinguishable
  from one reading.
* **M2 — the headless host really is mounted, and the seven elements are in it.**
  After promotion assert `[data-testid="headless-source-host"]` has
  `data-node-type="videovarispeed"`, that it contains
  `[data-testid="videovarispeed-card"]`, and that the seven
  `videovarispeed-slot-video-*` elements are inside it and NOT in the dock pane.
  This is `workflow-shell-video.spec.ts:1361-1381`'s videobox assertion, copied.
* **M3 — the `noUserControl` declaration is accepted, and ranking one is RED.**
  Run `no-user-control.test.ts` and `module-face-lint.test.ts`; drive the negative
  control (rank `asset_gate` and confirm it reddens) rather than assuming it.
  ⚠ Confirm `writer: 'cv-port'` is the legal value for all nine — every one has
  an input declaring `paramTarget` (`videovarispeed.ts:233-251`), and
  `no-user-control.ts:121` makes `'internal'` RED when one does.
* **M4 — the double crop push is benign.** With the dock open on a promoted node,
  drag the crop rectangle and confirm `read(id,'cropActive')` and the engine's
  rect settle to one value, that no write storm appears in the Y.Doc, and that the
  headless card's own `pushCrop` effect does not fight the body's (§6.3).
* **M5 — `collapse-keeps-playing` still enrols and still measures.** Run it
  against the promoted module and confirm the test does **not** skip, that the
  media element it finds is in `headless`, and that the accumulated playback
  progress still clears the gate. ⚠ A green run with a skip is the failure.
* **M6 — the attest hash is unmoved** on the merged tree, with the positive
  control run (§10.1).

---

## 14. VERIFICATION GATE

```bash
# 1. the face model + its permanent negative controls
flox activate -- npx vitest run packages/web/src/lib/ui/workflow/videovarispeed-face-model.test.ts

# 2. face lint + the promotion anchor (both directions)
flox activate -- npx vitest run packages/web/src/lib/ui/workflow/module-face-lint.test.ts

# 3. the noUserControl soundness sweep + its consumers
flox activate -- npx vitest run packages/web/src/lib/ui/workflow/no-user-control.test.ts

# 4. THE THREE GATES A FACE PR SATISFIES
#    (a) the face lints / STRICT_FACES promotion anchor      -> step 2
#    (b) the VRT baselines (compact + dock)                  -> step 9
#    (c) EXTENSION_BODY_ROLES — deny-by-default over every fullViewBody
flox activate -- npx vitest run packages/web/src/lib/ui/workflow/face-rack-status-source.test.ts

# 5. the rulings' source gates
flox activate -- npx vitest run \
  packages/web/src/lib/ui/controls/face-readout-source.test.ts \
  packages/web/src/lib/ui/controls/status-led-source.test.ts \
  packages/web/src/lib/ui/workflow/face-resting-text-source.test.ts \
  packages/web/src/lib/ui/workflow/video-face-screen-source.test.ts \
  packages/web/src/lib/ui/dock/face-width-source.test.ts

# 6. the range boy-scout (D3)
flox activate -- npx vitest run \
  packages/web/src/lib/ui/modules/card-range-source.test.ts \
  packages/web/src/lib/ui/card-control-ranges.test.ts

# 7. the registries + the shared-file neighbours
flox activate -- npx vitest run \
  packages/web/src/lib/ui/workflow/shell-extensions.test.ts \
  packages/web/src/lib/ui/workflow/module-shell-import-guard.test.ts \
  packages/web/src/lib/ui/workflow/face-migration-inventory.test.ts \
  packages/web/src/lib/ui/workflow/dom-source-modules.test.ts \
  packages/web/src/lib/ui/media/card-media-lifetime.test.ts \
  packages/web/src/lib/ui/modules-card-map.test.ts \
  packages/web/src/lib/control/push2/push-card-schema.test.ts \
  packages/web/src/lib/docs/module-manifest.test.ts

# 8. the module's own suites — videovarispeed has real coverage; run it
flox activate -- npx vitest run packages/web/src/lib/video/modules/
flox activate -- npx vitest run packages/web/src/lib/ui/modules/crop-edit-ydoc.test.ts

# 9. e2e — the two that matter, REPEAT=3 because both are changed
flox activate -- task e2e:serve
REPEAT=3 flox activate -- task e2e:one -- tests/collapse-keeps-playing.spec.ts
REPEAT=3 flox activate -- npx --workspace e2e playwright test faces-parity --grep videovarispeed
REPEAT=3 flox activate -- task e2e:one -- e2e/vrt/workflow-shell-faces.spec.ts
flox activate -- task e2e:stop
#    ⚠ READ THE SKIP COUNT on the collapse run. A green run that SKIPPED
#    videovarispeed is the D2 failure, not a pass.

# 10. docs contract — the def's docs are edited (D4), so re-pin and READ the diff
flox activate -- task docs:accept && flox activate -- git diff packages/web/src/lib/docs/contract-lock.txt
#    ⚠ EXPECT AN EMPTY DIFF for D4/D5 (prose). A non-empty diff means a param or
#    port moved — stop and read it.

# 11. the exemption ledger + typecheck LAST (svelte-check is stricter than vitest)
flox activate -- task test:ledger:accept
flox activate -- task typecheck

# 12. VRT: dispatch only, SCOPED, and COUNT the files (§9). NEVER commit a PNG.
GREP=videovarispeed flox activate -- task vrt:commit
#    PREDICTION: 2 files ADDED, 0 moved. Anything else is a red flag.

# 13. BOTH cost artifacts (§10.4) — an unmeasured scene has reddened main twice
flox activate -- task e2e:timings:accept -- <run>
flox activate -- task vrt:strict:timings:accept -- <run>

# 14. attest: NIL for PR 1 (§10.1). Confirm unmoved; run the positive control.
flox activate -- bash scripts/webgl-attest-hash.sh
```

---

## 15. VERDICT, RISK, ESTIMATE

**PROMOTE.** No precursor, no platform change, no new seam. The
`needs-media-controller` blocker is declared and does not block: the tax is
`<HeadlessSourceHost>` and **no status registry**, because unlike `cameraInput`
and `loopback` this module's entire state is already in the graph (§0.2).

**Risk: MEDIUM-HIGH**, and none of it is in the design:

1. ⚠ **the e2e surface, and one spec in particular.**
   `collapse-keeps-playing.spec.ts` is the sweep for this module's own owner P0,
   it runs in the default shell, and promotion breaks it two ways with the GREEN
   failure masking the RED one (§8.1). Getting this wrong ships a silently
   uncovered P0 regression guard. It is the reason the risk is not MEDIUM.
2. **the attest basis.** A single stray line of code in `videovarispeed.ts`
   converts a free PR into one needing a real-GPU window. §10.1's split is not
   optional, and the SPEED landmarks are the tempting line.
3. **the body's size.** It is the widest `fullViewBody` this cohort will produce
   — a picture, a crop overlay, a transport, an eight-input file surface and a
   seven-row bank. Nothing in it is hard; there is simply a lot of it, and every
   piece must re-emit a testid the sweeps read.

**Estimate: ≈ 20 h**, as PR 1 ≈ 18 h (def + a ~450-line body + the two
registries + the D1/D2/D4/D5/D7 repairs + the `paramSpec` boy-scout + the face
model unit + the VRT roster entry and its exemption rewrite) and PR 2 ≈ 2 h (the
SPEED landmark roster and one attest window).

**Build it SECOND in cohort A** — after `videobox`, which is the smaller and
strictly-easier sibling and which settles the shared body shape (§0.2's blit,
§6.4's SCREEN switch) on one third of the surface. ⚠ But **`videobox` carries a
CONTRACT CHANGE and a mandatory attest** (`../videobox/spec.md` §0.1), so the two
must not be in flight at once against the same attest window.
