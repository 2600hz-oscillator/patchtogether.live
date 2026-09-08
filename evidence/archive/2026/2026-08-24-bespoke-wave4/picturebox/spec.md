# FACEPLATE BUILD SPEC — `picturebox` (video, the IMAGE SLOT BANK)

**SPEC ONLY. Nothing here is implemented.** Mockups: [`dock.html`](dock.html) ·
[`dock-slots.html`](dock-slots.html).

Method: analyse what the module is FOR, then author the spec, then build from the
spec. Every claim below carries the file and line it was measured from, and the
ones that were *checked and came back different from the rule* are marked ⚠ and
kept rather than quietly corrected — the correction is the finding.

---

## 0. THE CONSTRAINT MAP, READ FIRST

| constraint | picturebox's answer | measured at |
|---|---|---|
| `NON_SHELL_LANE_TYPES` (the clipplayer carve-out) | **NOT a member** | `legacy-fallback.ts:105-112` — the set is `group, sticky, cadillac, clipplayer, controlSurface, electraControl, launchpadControlLeft` |
| `HEADLESS_MOUNT_LANE_TYPES` (the #1511 tax) | **NOT a member — the debt is already PAID** | `dom-source-modules.ts:89-97` + `:219-222`; see §0.2 |
| lane picture | **FREE, automatic, per-node** | `module-shell-model.ts:177-179`, `:237-240`; see §4 |
| WebGL attest | ⚠ **the def IS in the basis** — but the face edit is hash-transparent, **measured both directions** | §10.1 |
| ART | none — video domain is outside the audio gate | §10.2 |
| VRT | ⚠ **has a committed baseline today**, and it is the only one of the wave's three that does | §9 |
| shell extension slot | `fullViewBody` (wired). Never `editorSurface` (declared, unwired) | `shell-extensions.ts:118`, `:124` |
| tab rail | **NO** — see §5.3, and the rail is not manufactured | `dock-tabs-model.ts:101` |
| `node.data` writes / Cmd-Z | ✅ **CORRECT already** — and that is a finding, see §0.3 | `PictureboxCard.svelte:144, 179, 211` |

### 0.1 THE PARAM SET IS THREE, AND TWO OF THEM MUST NOT BE CONTROLS

`picturebox.ts:201-209` declares three params:

```ts
{ id: 'gain',        label: 'Gain',        defaultValue: 1.0, min: 0,   max: 2,  curve: 'linear' },
{ id: 'asset_pitch', label: 'Asset pitch', defaultValue: 0,   min: -10, max: 10, curve: 'linear' },
{ id: 'asset_gate',  label: 'Asset gate',  defaultValue: 0,   min: 0,   max: 1,  curve: 'linear' },
```

The def's own `docs.controls` (`:224-225`) describes the second and third as
*"synthetic, hidden param… **Not a card knob**"*. The legacy card honours that: its
only control is one `NeonFader` on `gain` (`PictureboxCard.svelte:277-279`).

⚠ **A face cannot silently honour it the same way.** `module-face-lint.test.ts:339`
is unconditional for a promoted def:

```
339	        if (!orderSet.has(p.id)) missing.push(`${def.type}: param '${p.id}' not in face.order`);
```

There is exactly one legal escape, at `:330-338`: a param declared in the def's
top-level `noUserControl` is skipped by completeness — **and ranking it anyway is
its own RED line** (`:331-336`, *"pick one (rank it, or delete the noUserControl
entry)"*). The dock render-plan parity arm inverts rather than skips: `:436`
`const want = noControl.has(p.id) || inBody.has(p.id) ? 0 : 1;`.

So the choice is not "declare `noUserControl` or leave it": it is **declare
`noUserControl`, or ship a faceplate that paints a continuous rotary over a raw
V/oct cache and a second one over a raw gate level.** The registry comment says so
in as many words at `video/module-registry.ts:38-42` — *"without this declaration
`module-face-lint`'s completeness loop demands an interactive cell for each and the
face paints two continuous rotaries over raw gate levels."*

The declaration this face adds, validated against `noUserControlProblems`
(`no-user-control.ts:86-135`) rather than guessed:

```ts
noUserControl: [
  { param: 'asset_pitch', writer: 'cv-port', why: '…' },
  { param: 'asset_gate',  writer: 'cv-port', why: '…' },
],
```

* `writer: 'cv-port'` is required rather than stylistic — `:112` makes `'cv-port'`
  RED when no input declares `paramTarget` for it, and `:121` makes `'internal'`
  RED when one does. Both params have a matching input (`picturebox.ts:193`,
  `:196`), so `'cv-port'` is the only legal value for each.
* `why` is required **by the type** (`types.ts:543`) and must clear
  `NO_USER_CONTROL_WHY_MIN = 24` (`no-user-control.ts:54`, checked `:127`).
* ⚠ **Declaring it is not cosmetic beyond the face.** `group-controls.ts:89-94`
  drops `noUserControl` params from `listExposableControls`, and
  `push-card-schema.ts:96-98` drops them from the Push 2 card. Both are
  improvements here (neither surface should offer a raw gate cache), but they are
  **behaviour changes outside the faceplate** and the PR body must say so.

### 0.2 ⚠ THIS MODULE ALREADY PAID THE #1511 DEBT, AND THE SET RECORDS IT

Every other spec in this program has had to argue whether a face orphans the
module's engine state. picturebox is the one that already answered it, and the
answer is load-bearing for the verdict.

`PictureboxCard.svelte:80-107` is the record. Two halves of the module used to
live on the card and both broke the same way when the shell stopped mounting it:

1. the TEXTURE — *"a SAVED rack rendered the module's idle field instead of your
   image, on LOAD. Measured on the default /rack, reading the node's own output
   texture: meanRGB (5,15,20) never-mounted vs (0,0,254) with the card open"*;
2. the CV INPUTS — *"A 33 ms interval was the ONLY consumer of ASSET GATE and ASSET
   PITCH… With no card the two jacks were patched, visibly connected and INERT."*

Both moved to `$lib/ui/media/extras-producers.ts` (`:255` `pictureboxProducer`),
driven by `node-extras-registry`, keyed to GRAPH lifetime. The card's closing line
is the whole point: *"This card writes node.data and renders UI."*

The consequence, and it is checkable rather than asserted: **picturebox is absent
from `CARD_PRODUCER_LANE_TYPES`** (`dom-source-modules.ts:214-221` — `cube`,
`rasterize`, `scope`, `synesthesia`, `timelorde`, `wavesculpt`) **and therefore
from `HEADLESS_MOUNT_LANE_TYPES`**. That set is not hand-maintained: its own doc
(`:212-213`) says *"DERIVED, never hand-maintained: dom-source-modules.test.ts
greps every card component for these producer seams and asserts this set is EXACTLY
what it finds."* So picturebox's absence is a gate-anchored statement that the
seam is gone, not a list somebody forgot to update.

**A picturebox face needs no `<HeadlessSourceHost>`, no status registry, and no
platform change to keep the picture alive.** cameraInput had to build
`camera-status-registry` to reach an off-screen card's gesture
(`legacy-fallback.ts:88-96`). picturebox has nothing off-screen to reach.

### 0.3 ⚠ THE `.data` WRITES ARE CORRECT HERE — WHICH SHARPENS WAVE 3'S FINDING RATHER THAN CONTRADICTING IT

Wave 3 reported that the fleet's raw-write discipline is a `params`-shaped gate
(`mutate.guard.test.ts:94` anchors on the literal token `.params`) while the
bespoke cohort keeps its instrument in `data`, and found `kria` and `audioOut` both
writing `.data` outside `LOCAL_ORIGIN`.

picturebox does **not**. All three of its `node.data` writers pass the origin:

* `PictureboxCard.svelte:144` — `}, LOCAL_ORIGIN);` (per-slot load)
* `:179` — `}, LOCAL_ORIGIN);` (slot clear)
* `:211` — `}, LOCAL_ORIGIN);` (single-image load)

and `mutate.ts:13-18` states exactly why that matters: an untagged write *"(a bare
`patch.nodes[id].params[p] = v` — SyncedStore's proxy transacts with NO origin)…
is silently NOT undoable"*, because `store.ts:70` configures
`trackedOrigins: new Set<unknown>([LOCAL_ORIGIN])`.

**So the wave-3 finding is not "the cohort is careless" — it is "the gate cannot
tell the careful ones from the careless ones."** Three bespoke modules examined
across two waves, and the split is 1 correct / 2 broken, with a green
`mutate.guard` run over all three. That is a stronger argument for a `.data`-side
ledger than "two modules were wrong", and it is the version wave 4 reports (see
this wave's README, and §0.3 of `../midiclock/spec.md`, which is the third broken
one).

**Nothing in this spec depends on that ledger landing.** picturebox needs no fix
here; it is the control case.

---

## 1. WHAT THE MODULE IS FOR

A picture, in the video graph, that you chose.

It is the simplest possible video SOURCE — no camera, no file stream, no network —
and that simplicity is why it is everywhere: `picturebox` is the fleet's default
"cheap image on a wire". More e2e specs reach for it than for any other module in this
wave (§8), most of them because
they needed *a video source that would definitely be there* and picturebox is the
one that costs nothing to mount.

Beyond the single image it is a **7-slot bank**, and the bank is the part with an
idea in it: each slot is labelled with a scale degree (C D E F G A B), and a clip
player's PITCH + GATE outputs select which slot is showing, by **pitch class**, so a
C in any octave shows slot 1 (`picturebox.ts:44-49`, `asset-select.ts`). That turns
an image bank into a note-triggered image sampler — you sequence pictures the way
you sequence notes.

Two sentences from the def's own docs (`:213`) name the intended uses: *"Use it as a
still backdrop, an animated-gif loop, an album-art frame, or a note-triggered image
sampler feeding downstream video benders."*

**What that means for the face:** the module is a PICTURE plus a BANK plus one
knob. The picture wants to be seen at every size; the bank is a seven-row roster
that only makes sense with room; the knob is a knob. That maps cleanly onto the
lane-tile / dock-body split the shell already has, which is why this is a promote
rather than an argument.

---

## 2. STOP 1 — is promoting this module a PARITY LOSS?

Functional parity is a hard requirement, not a trade. Every affordance the legacy
card offers is enumerated here with where it goes.

| affordance | `PictureboxCard.svelte` | where it goes on the face | lost? |
|---|---|---|---|
| "Choose image…" single-file pick | `:248-251` | `fullViewBody` — a `file` cell is also available (`shell-cells.ts:292`) and §5.4 argues the body instead | no |
| the loaded-image PREVIEW | `:256-262` | **the lane tile itself**, live, via `hasVideoSurface` — §4 | no, upgraded |
| the filename caption | `:264-266` | `aria-valuetext` / body — NOT resting face text, §7 | text yes, information no |
| the `synced (1024×768)` / `gif` hint | `:267-271` | ⚠ **removed** — §7 | see §7 |
| the error line | `:272-274` | body, transient | no |
| GAIN fader | `:277-279` | ranked `face.order` cell, `paramCells: { gain: 'fader' }` | no |
| the 7-slot "Load multiple…" panel | `:281-304` | `fullViewBody` | no, **and it stops being hidden** — §2.1 |
| per-slot load | `:293-296` | body row | no |
| per-slot clear ✕ | `:298-300` | body row | no |
| per-slot filename | `:297` | body row | no |
| the PatchPanel jacks | `:246` | the shell's own rear/patch surface | no |

**Nothing is lost.** One thing is deliberately removed (the sync hint, §7) and one
thing is *gained* (§2.1).

### 2.1 ⚠ SIX OF THE SEVEN SLOTS ARE REACHABLE ONLY BY A RIGHT-CLICK THAT NOTHING ADVERTISES

`PictureboxCard.svelte:182-185`:

```svelte
function onCardContextMenu(ev: MouseEvent): void {
  ev.preventDefault();
  multiOpen = !multiOpen;
}
```

bound at `:239` (`oncontextmenu={onCardContextMenu}`) on the card root. That
handler is **the only route to the "Load multiple…" panel**, and the panel is the
only route to slots 2-7. Nothing in the card's visible surface says so. The def's
docs do say it (`:213`, *"right-click the card to open the 'Load multiple…'
panel"*) and so does `DESCRIPTIONS.picturebox` (`module-manifest.ts:303`) — but
those are the docs site, not the card.

So the module ships a seven-slot instrument whose six extra slots are behind an
undiscoverable gesture. **Moving the bank into the `fullViewBody` is not a
relocation, it is the fix**: the dock full view is a place you open deliberately,
and what is in it is visible.

⚠ **AND THE GESTURE COLLIDES — but the direction of the collision is UNMEASURED and
this spec does not guess.** `Canvas.svelte` installs a `contextmenu` listener in
the **capture** phase (`:5865`, `window.addEventListener('contextmenu', onContextMenu, true)`),
and the repo has a shared `NodeContextMenu.svelte` carrying the per-node entries
(annotate among them — the same menu `module-annotate.spec.ts` drives). The card's
handler is a bubble-phase Svelte binding that calls `preventDefault()`.

Three outcomes are consistent with the source and they are materially different:

1. the node menu opens **and** the panel toggles underneath it (both fire);
2. the card suppresses the node menu, so **picturebox nodes have no annotate /
   rename / patch-to menu at all**;
3. the canvas handler cancels first and the panel never opens under some
   conditions.

**MUST-VERIFY M1 (§13) is the experiment**, not a prediction. Whatever the answer,
the face removes the collision by not binding `oncontextmenu` at all — the shell's
node menu is then the only right-click, which is the fleet behaviour every other
faceplate already has.

### 2.2 THE ONE CONTROL, AND THE ONE PLACE ITS RANGE MAY LIVE

`PictureboxCard.svelte:278` (elided to the props that matter):

```svelte
<NeonFader value={p('gain')} min={0} max={2}
  defaultValue={pictureboxDef.params.find((x) => x.id === 'gain')!.defaultValue} … />
```

⚠ **`min` and `max` are numeric literals re-typed in the card while `defaultValue`
is correctly read off the def.** That is precisely the backdraft class CLAUDE.md
opens on: *"A control's range must come from ONE place — export it from the def and
import it in the card; never re-type numbers in the card."* The gates that hold
that line (`card-range-source.test.ts`, `card-control-ranges.test.ts`) are **opt-in
per card via `RANGE_BOUND_CARDS`, and picturebox is not in it** — which is the blind
spot the rule names as the place this class actually lives now.

The face does not inherit the defect (a ranked param cell reads the `ParamDef`), but
the PR **touches this card**, so boy-scout applies:

* export `PICTUREBOX_GAIN_RANGE` from `picturebox.ts` and pass it in the card;
* add `PictureboxCard.svelte` to `RANGE_BOUND_CARDS`.

⚠ **AND THAT EXPORT IS NOT FREE.** A new exported `const` in `picturebox.ts` is
CODE, and this def is in the WebGL attest basis (§10.1). Measured: it moves the
hash. **Either take the re-attest deliberately, or land the range fix as a separate
non-basis-touching PR.** §10.1 carries the numbers and the recommendation.

---

## 3. STOP 2 — does every way of getting DATA IN survive?

| entry point | today | after |
|---|---|---|
| file picker (single) | card `<input type=file>` `:249` | body `<input type=file>` — same element, same `encodePickedFile` |
| file picker (per slot) | card `:294` | body row, same |
| GAIN via UI | `NeonFader` `:278` | ranked fader cell |
| GAIN via CV | `gain` input, `paramTarget` `picturebox.ts:186` | unchanged — the bridge writes the param, not the UI |
| slot select via CV | `asset_pitch` + `asset_gate` → `extras-producers` pump | **unchanged, and card-independent already** (§0.2) |
| remote peer edit | Y.Doc → `$derived` reads of `node.data` | unchanged — the body reads the same `node.data` |
| import / perf-zip | `node.data.imageBytes` / `.assets` | unchanged |

Nothing in the input set is card-shaped. The two CV inputs are the ones that would
normally worry a promotion, and they are the two that were already moved off the
card (§0.2).

---

## 4. THE LANE PICTURE — **ACCEPTED**, and it is the first one in this program

Waves 2 and 3 refused a lane picture six times, and the reason was always the same
platform fact: `ShellExtensionGlyphProps` (`shell-extensions.ts:44-52`) carries
`num`, `numbers` and `testid` and **no `nodeId`**, so a glyph is a pure function of
one discrete param value and every instance of a module would draw a byte-identical
picture.

⚠ **That constraint does not apply here, and it is worth being precise about why,
because the wrong version of this sentence would be "we found a way around it".**
picturebox does not use the glyph seam at all. Video modules get their lane picture
from a *different, already-per-node* path:

```
module-shell-model.ts:177-179
export function hasVideoSurface(def: ShellDefLike | undefined): boolean {
  return def?.domain === 'video';
}

module-shell-model.ts:237-240
export function laneGlyphFor(def: LaneGlyphDefLike | undefined): LaneGlyph {
  if (hasVideoSurface(def)) return 'picture';
  return (def?.face?.glyph ?? 'none') !== 'none' ? 'trace' : 'none';
}
```

`domain === 'video'` is the **whole** condition — no opt-in, no face field, no port
check. `ModuleShell.svelte:1345-1348` then renders `<VideoTileThumb nodeId={id} />`,
which takes the nodeId, and the thumb blits the node's own output FBO
(`videoEngine.blitOutputToDrawingBuffer(nodeId)` → `drawImage` into a 2D canvas —
`module-shell-model.ts:156-166`, and note *"no WebGL in the component, so the shell
stays OUT of the WebGL attest basis"*).

So: **picturebox's promoted lane tile shows the picture picturebox is showing, live,
per node, at `VIDEO_THUMB_W×H = 160×120`, throttled to `VIDEO_THUMB_FPS = 15`
(`:250-252`), for free.** No platform change. No `nodeId` prop to add. The
owner ruling recorded at `:202-214` even makes it outrank the controls: *"for a
video module the picture IS the module's identity in a rack, so it OUTRANKS ranked
controls (owner ruling, #1785)."*

⚠ **The face MUST declare `glyph: 'none'`, and that is mandatory rather than
tasteful.** `strict-faces.ts:838-840` records the rule for video defs, and the
mechanism is the DEAD-GLYPH clause: `glyphBinding()` short-circuits on an audio
output (`shell-glyph-live.ts:163-184`, `primaryAudioOutPortId` = the first
`type === 'audio'` output), picturebox has exactly one output and it is
`{ id: 'out', type: 'image' }` (`picturebox.ts:198-200`), so **every glyph literal
except `'none'` resolves to `{kind:'static'}`** and `module-face-lint.test.ts:271-290`
reddens it — *unconditional, no exemption list, no count.*

This is the wave's one accepted picture, and the difference from the six refusals is
mechanical, not a matter of taste: video-domain modules were never on the glyph
path.

---

## 5. THE FACE

### 5.1 RANK — `face.order`

```ts
face: {
  glyph: 'none',                     // mandatory for a video def — §4
  order: ['gain'],
  paramCells: { gain: 'fader' },
  extension: 'picturebox',
},
```

One ranked key. That is not a thin face; it is an honest one — the module has one
control, and CLAUDE.md's compact-is-the-default ruling means a face with one control
should look like a face with one control.

Completeness is satisfied because the other two params are `noUserControl` (§0.1),
and `module-face-lint.test.ts:330-338` skips exactly those.

⚠ **`paramCells: { gain: 'fader' }` is a real decision, not decoration.** `gain` is
a linear 0..2 brightness multiply whose meaningful landmark is unity at the middle
of the throw. The legacy card already chose a `NeonFader` over a knob (`:278`); the
face keeps that choice rather than silently re-deciding it, and `'fader'` is a legal
`AuthoredParamCell` (`shell-control-kind.ts:119`).

### 5.2 BANDS — one, and no tab rail

One ranked control is one band. `DOCK_TAB_MIN_BANDS = 7` (`dock-tabs-model.ts:101`)
and the rail is applied at `:142` (`if (!faceForcesTabs(def) && bands.length < DOCK_TAB_MIN_BANDS) return null;`).

**No tab rail, and none is manufactured.** `face.tabbed` exists (`types.ts:1069`)
but its doc is explicit that it is OWNER-INSTRUCTION ONLY, and its single adopter is
`spirographs`. picturebox has one control; padding it to seven bands to earn a rail
would be the exact anti-pattern the owner ruling names.

### 5.3 WIDTH — compact, and it costs nothing to keep it there

`face-width-source.test.ts` denies a `max-width` on `.faceplate-body`, denies any
per-occupant `:has(...)` width override outright (`:160-176`, *"Per-module hatches
are how `min-width: 900px` survived two owner reviews"*), and its
`PLATE_FLOOR_EXEMPTIONS` list is **currently empty** (`:88`).

picturebox needs no entry. Its widest element is the 7-slot body, and a slot row is
`[note] [Load file…] [filename] [✕]` — the legacy card fits that in a **220 px**
card (`PictureboxCard.svelte:310`). The body is comfortable at ~340 px and the plate
sizes to content via `width: max-content` (`:111-122`).

### 5.4 CONTROL INVENTORY — every primitive decision, argued

| face element | primitive | why not the alternative |
|---|---|---|
| GAIN | ranked param cell, `'fader'` | a knob would silently overturn the card's existing choice |
| the picture (lane) | `VideoTileThumb` via `hasVideoSurface` | automatic; nothing to author |
| the picture (dock) | the `fullViewBody`'s own `<img>` preview | the dock hero glyph is capped at `DOCK_HERO_GLYPH_W = 214 px` (`module-shell-model.ts:635-636`) and is *"a picture, not a surface"* (`shell-extensions.ts:96-104`); the bank needs the same region |
| the 7-slot bank | `fullViewBody` | a `panel` cell (`shell-cells.ts:370-382`) is the alternative and §6 argues it down |
| single-file pick | `fullViewBody` | a `file` cell (`shell-cells.ts:292`) would put a file button in the lane tile, where the picture should be |

---

## 6. THE BODY — `face.extension: 'picturebox'`, slot `fullViewBody`

### 6.1 WHY `fullViewBody` AND NOT A `panel` CELL

A `ShellPanelCell` (`shell-cells.ts:370-382`) is the right seam for *"one
picture-you-edit inside the generic face"* and it is DOCK-ONLY
(`shell-cells.ts:1805-1817`, *"a 280 px SVG has no business being SELECTED into a
46 px lane knob column"*). It carries a `minWidth` and a **required** `probe`
(`:380-381`).

Two reasons it is the wrong seam here, and the second is the decisive one:

1. a panel cell must be a **ranked key in `face.order`**, which would make the bank
   compete with `gain` for band space when the bank is not a control — it is a
   library;
2. ⚠ the bank contains **`<input type="file">` elements**. A panel cell's probe
   vocabulary is `data` / `data-rev` / `text` (`:364-367`) and its own doc warns
   *"Prefer `data` where you can. A revision-only probe passes on a DEAD button that
   bumps the counter without editing anything."* A file input's observable is a
   browser dialog; there is no honest `data` probe for "the picker opened". Putting
   it behind a probe-required seam would mean writing a probe that proves less than
   it appears to.

`fullViewBody` has neither problem: it is wired (`shell-extensions.ts:124`), it
takes `nodeId` (`:57-59`), it paints above the bands and replaces the hero glyph,
and — the load-bearing half — *"The bands BELOW are untouched: every param still
gets its cell, so face completeness, the dock render-plan parity gate and
`faces-parity` all still apply to an adopter"* (`:83-87`).

### 6.2 NEVER `editorSurface`

`WIRED_SHELL_EXTENSION_SLOTS = ['glyph', 'fullViewBody']` (`shell-extensions.ts:124`).
`editorSurface` is declared (`:118`) and unwired, and its own note (`:65-69`) says
the first adopter must wire the render site in `ModuleShell` **in the same diff**.
picturebox's bank is not *"a control that is not cell-shaped at all"* — it is a list
of rows. It has no business being the module that wires a platform slot.

### 6.3 THE COMPONENT

`packages/web/src/lib/ui/modules/picturebox/PictureboxAssetsBody.svelte`, registered
through `packages/web/src/lib/ui/modules/picturebox/shell-extension.ts` — a well-trodden pattern
(`ui/modules/*/shell-extension.ts` is a populated glob).

Contents, top to bottom:

1. **the live preview** — the same `<img src="data:{mime};base64,{bytes}">` the card
   uses (`PictureboxCard.svelte:256-262`), which animates a gif natively. Keep the
   card's `{#if hasImage}` guard so an empty face renders no preview.
2. **the single-file row** — `Choose image…` + the transient error line.
3. **the 7-slot bank** — seven rows, always visible, never behind a gesture (§2.1).
   Row = scale-degree tag · `Load file…` · filename · `✕` when occupied.

⚠ **The body reads and writes `node.data` through the SAME code the card uses.** Do
not re-implement the slot-array read/merge (`PictureboxCard.svelte:126-143` and
`:161-178` are the same 18 lines twice already, which is its own small defect):
**extract them into `$lib/graph/picturebox-data.ts` as `setSlotAsset(nodeId, slot,
enc, filename)` / `clearSlotAsset(nodeId, slot)`**, both passing `LOCAL_ORIGIN`, and
call the extraction from both surfaces. That is the `matrixmix.ts` `mutateMatrix`
shape (`graph/matrixmix.ts:61-67`) and it keeps §0.3's correct behaviour correct in
two places instead of one.

### 6.4 ⚠ THE SHELL ALREADY HAS A MEDIA LIBRARY AND THIS MODULE DOES NOT KNOW ABOUT IT

Measured: `grep mediaLibrary` returns **zero** hits in `PictureboxCard.svelte` and
zero in `extras-producers.ts`.

Meanwhile the workflow topbar carries two shipped surfaces feeding a centralized
library — `MediaLoaderSurface.svelte` (the `+` slot: file/folder pick **and** a drop
target, everything landing in `mediaLibrary` via `$lib/media/ingest`) and
`AssetsPickerSurface.svelte` (the floppy slot, *"the Loaded Assets Picker … lists
what lands here"*), both mounted from `WorkflowTopbar.svelte:522` and `:539`.
`workflow-media.spec.ts:386` already tests an **image → picturebox** auto-create
path, so the two systems do meet — but only in the direction library→new node.

**This spec does NOT wire them together, and says so deliberately.** Routing slot
loads through `mediaLibrary` would be a genuine improvement (pick from what is
already loaded instead of re-picking a file per slot) and it is a *different,
larger* change touching the media ingest contract. Recording it here so the next
person does not discover it mid-build and either bolt it on or quietly re-invent it.

**Recommendation for a follow-up, not this PR:** the body's slot row gains a second
affordance — "pick from library" beside "Load file…" — once someone owns the
ingest-side question of what a library entry gives you (an `ArrayBuffer`? a URL?
picturebox needs bytes it can base64 into `node.data`).

---

## 7. RESTING TEXT — one readout is REMOVED, and this names what loses its surface

`face-resting-text-source.test.ts` denies the SHAPE rather than a mechanism: every
`ModuleFace` field must carry a declared text ROLE in `FACE_FIELDS` (`:128-248`),
and the permitted roles are exhaustively the module NAME, TAB/SECTION labels,
CONTROL CAPTIONS and OPTION/LANDMARK NAMES (`:44-52`).

The legacy card paints two pieces of derived text under the preview:

* `:264-266` the **filename** — `{imageName}`;
* `:267-271` the **sync hint** — `{isGif ? 'gif' : \`synced (${TARGET_W}×${TARGET_H})\`}`.

Dispositions:

| card text | face | why |
|---|---|---|
| filename | **kept, in the BODY** | the body is an extension surface; the resting-text gate's own stated blind spot (`:60-87`) is text drawn inside a `fullViewBody`. This is not a loophole being exploited — a file bank whose rows do not say which file is in them is not a file bank. It is a per-row LABEL, which is the `control-caption` role in substance. |
| the sync hint | ⚠ **REMOVED from every surface** | it is a state word (`gif`) or a measurement (`synced (1024×768)`) about the module, not a caption on a control. That is the shape the ruling names. |

⚠ **DELETING A READOUT DELETES A FINDING, and here is the one that loses its
surface.** The sync hint is currently the *only* place a user learns that

* their gif was preserved byte-for-byte and is animating (`gif`), versus
* their image was downscaled and re-encoded to 1024×768 JPEG q=0.85 (`synced (…)`),
  versus
* their gif was **over the cap and silently flattened to one frame** — which today
  surfaces as the transient error at `:272-274`, *"gif too large — showing first
  frame only"*, set at `:118-120` and `:199-201` off `enc.fellBack === 'gif-too-large'`.

The first two move to `aria-valuetext` on the preview, which is speakable and
assertable but unpainted, per the ruling's own instruction. **The third must NOT be
demoted to aria** — it is an outcome the user needs to see, and an error is not
resting derived text. Keep it as the same transient, dismissible line the card
already has.

---

## 8. THE #2166 CLASS — picturebox is the fleet's most-used un-faced fixture, and one spec's PRECONDITION IS THE THING THE FACE REMOVES

**Not** in `e2e/tests/_face-fixtures.ts`'s `DENIED` map (`:67-96`) — that map lists
`audioIn`, `audioOut`, `twotracks`, `cameraInput`, `recorderbox`, `archivist`,
`peertube`, `doom`, and picturebox is not among them.

**Not** in `LEGACY_DOCK_CANDIDATES` (`workflow-rear-card.spec.ts:738`, =
`['moog956', 'moog960', 'cartesian']`), so it does not inherit the `scope` trap that
list was built to fix.

But the list of e2e files that reach for it is long, and the split matters:

**SUBJECT — rewritten, not broken:**
`picturebox-limits.spec.ts` (drives the palette + `.svelte-flow__node-picturebox`
count, so it survives untouched), `picturebox-gif.spec.ts`,
`picturebox-asset-select.spec.ts`, `picturebox-sync.spec.ts` (@collab),
`coverage-groups-6-7-8-9.spec.ts:389`, `video-orientation.spec.ts:654`,
`extras-producer-lifetime.spec.ts:660`.

**FIXTURE — picturebox chosen as a cheap asset-bearing video node:**
`rackspace-persistence.spec.ts:46` (node.data only, never the DOM — survives),
`videovarispeed-perfzip.spec.ts:56`, `videobox-performance-bundle.spec.ts:89`,
`wavesculpt.spec.ts:463` (wire only — survives), `workflow-media.spec.ts:386`,
and:

### ⚠ `varispeed-panel-layout.spec.ts` — the CLAUDE.md precondition class, exactly

Its header (`:9-10`) states its subject:

> *"(picturebox). The panel is now an absolute overlay sheet, so this asserts it —
> including its last slot row — stays within the card's box once opened."*

Its `CARDS` table names picturebox at `:19`. **Its subject is the geometry of the
"Load multiple…" panel INSIDE THE LEGACY CARD BOX** — and the card box is exactly
the thing this promotion removes. The panel is an absolute overlay clipped to a
rack-unit-locked card (`PictureboxCard.svelte:367-388` explains why:
*"the card is pinned to an exact rack-unit height … so an in-flow panel pushed past
the tier and spilled outside the card box"*). In a `fullViewBody` there is no
rack-unit height and no overflow to contain — the constraint the test measures
ceases to exist.

This is CLAUDE.md's *"A gate whose PRECONDITION is the defect cannot fail on the
defect"* in its milder form: the precondition here is not a defect, it is a design
the face supersedes. The failure mode is the same either way — **the test goes green
and blind, still passing, still asserting a containment that no longer constrains
anything.**

**The instruction is the one CLAUDE.md gives: fix the SUBJECT, not the threshold.**
Either
(a) re-point the row at another card whose overlay panel still lives in a rack-sized
box — the `CARDS` table is a list, and the spec's real subject is the overlay-sheet
technique, not picturebox; or
(b) if picturebox is its only remaining case, **retire the row with the design it
covered** and say so in the PR body.

Deciding which is a build-lane call that needs the `CARDS` table read in full; the
spec's requirement is that the PR **states which it did and why**, rather than
letting a green run stand in for an argument.

### The DOM-selector cost, counted honestly

Several of the specs listed above drive `data-testid="picturebox-*"` selectors that live
on the legacy card:
`picturebox-file-input`, `picturebox-card`, `picturebox-preview`,
`picturebox-synced`, `picturebox-slot-input-{i}`, `picturebox-slot-name-{i}`,
`picturebox-slot-clear-{i}`, `picturebox-multi-panel`.

**The body must re-emit the same testids** wherever the affordance survives, which
makes most of those specs a one-line container change rather than a rewrite.
`picturebox-synced` is the exception — it is the removed readout (§7) and its two
assertions (`picturebox-gif.spec.ts:112` among them) must move to
`aria-valuetext`, which is what every face spec proving a module tracks its state
already reads.

⚠ **`picturebox-multi-panel` should NOT be re-emitted.** It names a panel whose
defining property was that it was hidden behind a right-click; re-emitting the id on
an always-visible body would keep a name that has stopped being true. Rename to
`picturebox-assets-body`, and let the rename be the signal.

---

## 9. VRT — the only one of the wave's three that already has a baseline

* `e2e/vrt/__screenshots__/vrt.spec.ts/picturebox.png` — **exists, 9984 bytes**,
  platform-agnostic name, one of the per-type `<type>.png` files in that directory.
* **Not** in `EXEMPT_FROM_VRT` and **not** in `ALLOWED_PERMANENT_EXEMPT`
  (`vrt-exemptions.ts`) — picturebox is under full VRT coverage today.
* It is diffed **unmasked**: its only mention in that file is `:66`, in the
  `VRT_MODULE_MASKS` deletion note recording that the mask was a dead selector
  (*"these cards contain ZERO `<canvas>` elements"*).
* No face baselines exist (`face-picturebox-compact.png` / `-dock.png` are absent
  from `workflow-shell-faces.spec.ts/`).

**So promotion moves one baseline and adds two.** That is a real cost the other two
modules in this wave do not have, and it comes with the sharpest hazard in
CLAUDE.md: **`--update-snapshots` cannot regenerate a PASSING-but-stale baseline.**
If `vrt.spec.ts` keeps rendering something for picturebox after promotion, the old
PNG may pass and never be rewritten.

Procedure, in order, no improvisation:

1. **Predict the file count before dispatching** — one moved (`picturebox.png`, if
   `vrt.spec.ts` still covers a promoted type) plus two added
   (`face-picturebox-compact.png`, `face-picturebox-dock.png`).
2. Dispatch **scoped**: `GREP=picturebox flox activate -- task vrt:commit`. A bare
   dispatch on a face PR derives FULL, because every face PR touches a shared roster
   file whose path names no module.
3. **Count what the bot commits against the prediction.** A green dispatch that
   committed nothing is a RED FLAG, not a pass.
4. If `picturebox.png` is stale-but-passing, `git rm` it first — then ⚠ **`git status`
   for untracked PNGs after the next VRT run**, because a `git rm`-ed baseline is
   silently recreated as an untracked file no gate reads.

---

## 10. COST

### 10.1 ⚠ WEBGL ATTEST — THE DEF IS IN THE BASIS. MEASURED IN BOTH DIRECTIONS.

**This is the first module in this program whose def sits inside the WebGL attest
basis, so waves 2 and 3's flat "zero GPU cost" line does NOT transfer.**

```
flox activate -- bash scripts/webgl-attest-hash.sh --list | grep -i picturebox
  packages/web/src/lib/video/modules/picturebox-encode.ts
  packages/web/src/lib/video/modules/picturebox.ts
```

The basis is essentially *every* `packages/web/src/lib/video/**`
file, plus the `cube` / `wavesculpt` pair and their two surfaces, plus the toolchain and
harness manifests (`.flox/env/manifest.toml`, both `package.json`s, `e2e/playwright.config.ts`,
`e2e/webgl-heavy-globs.ts`).
`packages/web/src/lib/ui/modules/PictureboxCard.svelte` is **not** in it (the only
cards in the basis are `WavesculptCard.svelte` and `cube/CubeVizSurface.svelte`),
and neither is anything under `ui/workflow/`.

⚠ **THE HASHES BELOW ARE A RECORD OF ONE RUN, NOT A TARGET TO MATCH.** They were
measured on tree `5f6c289a3`. `main` has since moved the basis — **#2180**
(*"the WebGL attest has been unpassable since 2026-08-23 — a stale platform-default
constant"*) — and on the absorbed tree the same clean baseline now reads
`136a02a3c460bcec8a9f009789d0a6126d0691b7a26d5753e04201468d15072f`. **Re-measure
before trusting any absolute value here.**

What survives the move is the only thing the controls were run to establish, because it
is a property of `HASH_TRANSPARENT_PROPS` rather than of any particular tree: **`face`
and a def-top-level `noUserControl` are hash-transparent, and ordinary code in the same
file is not.** Re-confirmed after the absorb: `picturebox.ts` and `picturebox-encode.ts`
are both still in the basis.

Measured on tree `5f6c289a3`, negative control then positive control:

| tree state | hash |
|---|---|
| **baseline** (clean `main` at `5f6c289a3`) | `1c49e951c4836ef426bf969dad894302e738321319ff56a30c9d0ee1bf83ab50` |
| `+ face: { order: ['gain'] }` on `pictureboxDef` | `1c49e951…` — **UNCHANGED** |
| plus a def-top-level `noUserControl` array, one entry per synthetic param | `1c49e951…` — **UNCHANGED** |
| `gain` `max: 2` → `max: 3` (positive control) | `93ab8cd7e696cde48429821a4265a3072dc6ba167beef1af31d90fd76ce85e2a` — **MOVED** |

So the exact PR shape matters, and the rule is sharp:

> **A picturebox face PR that adds ONLY `face` and `noUserControl` to the def costs
> ZERO GPU. Any other edit to `picturebox.ts` costs a real-machine re-attest that
> CI (SwiftShader) cannot run.**

`scripts/attest-code-basis.ts:96-109` is why: `HASH_TRANSPARENT_PROPS` is
`['docs', 'controlFamilies', 'face', 'noUserControl']`, and `:100-107` records that
`noUserControl` was added for precisely this reason — *"every video def sits in the
WebGL attest basis, so a property that stayed in the hash would make declaring one
cost a real-GPU re-attest that CI (SwiftShader) cannot run."*

⚠ **The strip is restricted to a DIRECT member of a MODULE-SCOPE object literal**
(`:88-93`) — *"a WebGL module may legitimately carry a `face:` on a nested
geometry/cube-side object, and stripping THAT would be a missed re-attest."* So the
`noUserControl` array must sit at the def's top level, which is the real API
(`video/module-registry.ts:50`, `types.ts:527-544`) and not a per-param flag.

⚠ **AND HERE IS THE INSTRUMENT FAILURE THIS SPEC WALKED INTO, KEPT RATHER THAN
TIDIED AWAY.** The first run of the control above wrote `noUserControl: true`
*inside each ParamDef*, on the assumption that a property named "no user control"
was a per-param flag. The hash MOVED (`928c2acd9e864f423e0d20ea3028641861b83b51536814c7800bb8974d70260e`),
and the obvious reading was a genuine finding: *"the strip list names a property
that can never be stripped where it actually lives."* That reading was **wrong, and
it was wrong because the subject was never checked** — `types.ts:527-544` declares
`NoUserControlParam { param, writer, why }` and `module-registry.ts:50` declares
`noUserControl?: readonly NoUserControlParam[]` **on the def**. The hash moved
because the edit was nested, exactly as `:88-93` says it should.

This is CLAUDE.md's VALIDATE-THE-INSTRUMENT rule catching a spec rather than a test.
It is recorded because the false version was one paragraph away from being written
down as a platform defect, and it would have read as authoritative.

**Recommended PR shape given all of the above:**

* **PR 1 (this face)** — `face` + `noUserControl` on the def, the extension body, the
  registries, the e2e selector moves. **Zero attest.** Verify by running
  `webgl-attest-hash.sh` against the merged tree and confirming `1c49e951…` (or
  whatever `main` reads at that moment) is unmoved.
* **PR 2 (the range boy-scout, §2.2)** — `PICTUREBOX_GAIN_RANGE` export +
  `RANGE_BOUND_CARDS`. **This one moves the hash and needs the GPU.** Splitting it
  keeps a green, cheap face PR from being held hostage to an attest window.

⚠ Attest a pin covers a TREE, not a PR: if `main` moves a basis file under you, your
hash changes without your diff changing. Match CI's refusal hash before spending the
GPU, and never measure attest state in a dirty primary checkout.

### 10.2 ART — ZERO, and measured rather than inferred from the rule

The rule is "this PR edits the def, therefore the ART pin moves" — ART pins to the
RAW FILE SHA and is not comment-stripped. **The rule does not apply, because this
module has no pin.**

* `ls art/baselines/` — **no `picturebox/` directory**.
* `picturebox` is in **neither** `ART_EXCLUDED` nor `ART_BACKLOG`
  (`art/setup/profile-coverage.ts:25`, `:78`) and needs to be in neither: the audio
  profile gate enumerates **audio-domain ids only**
  (`art/scenarios/_meta/audio-profile-gate.test.ts:39-47`, matching
  `/^(\S+) meta domain=audio\b/` off the contract golden). picturebox is
  video-domain, so the gate never sees it.
* Its only ART presence is a defs-shape placeholder:
  `art/scenarios/video/phase1-defs.test.ts:26` lists `'picturebox'` in
  `PHASE1_TYPES`, with a header explaining that the video render equivalent waits on
  headless GL.

**`art/` should be absent from this diff.**

### 10.3 CI wall-time

New: two VRT face captures (they ride the scoped `vrt:commit` dispatch, not the PR's
CI lane) and one new unit file (`picturebox-face-model.test.ts`). The e2e changes
are selector edits inside specs that already run.

**Estimated PR delta: well under 2 minutes**, which is under the sign-off bar. No
new e2e spec is proposed; §13's verification runs existing rows.

### 10.4 The Push 2 card moves

⚠ Declaring `noUserControl` drops `asset_pitch` / `asset_gate` from
`push-card-schema.ts` (`:96-98`). picturebox has no explicit `PUSH_CARD_CONTROLS`
entry, so its card is resolved from the live def and **will re-rank itself**. That
is the CLAUDE.md warning ("adding or renaming a param on any module can silently
change that module's push card") firing on a *removal*. The change is an improvement
— a raw gate cache should never have been on a hardware controller — but it must be
in the PR body, and `push-card-schema.test.ts` is a must-run (§13).

---

## 11. DEFECT LEDGER — live on `main`, independent of any face

Each item is fixed **inside this PR** unless marked otherwise; there is no issue to
file (owner ruling), and the PR narrative is the searchable record.

| # | defect | evidence | routing |
|---|---|---|---|
| **D1** | ⚠ **Both file headers are stale by 2.56× in area.** `picturebox.ts:4` and `PictureboxCard.svelte:3` both say the file is *"downscaled to 640x480"*. The real target is `TARGET_W`/`TARGET_H` = `VIDEO_RES` = **1024×768** (`video-res.ts:35`), and the card **prints the live constant three lines from the stale comment** (`:269`, `synced (${TARGET_W}×${TARGET_H})`). The `docs.explanation` (`:213`) and `DESCRIPTIONS` (`module-manifest.ts:303`) both say 1024×768 correctly. | direct read | **fix in this PR** — comment-only, hash-transparent (§10.1) |
| **D2** | ⚠ **The def documents a versioning mechanism it does not implement.** `picturebox.ts:9-11`: *"schemaVersion bumped to 2… `migrate` **here** ensures legacy patches load without warnings"*, plus three more `schemaVersion bumped to N` paragraphs (`:13`, `:22`) and `:138` (*"schemaVersion 4"*). The def object (`:172-449`) contains **no `schemaVersion` field and no `migrate` function**, and `VideoModuleDef` declares neither. The forward-compat behaviour is real but lives in the *readers* (`?? new Array(ASSET_SLOTS).fill(null)` at `PictureboxCard.svelte:57-70`, `extras-producers.ts:268`). | direct read | **fix in this PR** — rewrite the header to describe the reader-side defaults. Comment-only. ⚠ Do **not** "fix" it by adding a `migrate`: check the consumer first (CLAUDE.md), and nothing calls one. |
| **D3** | ⚠ **Numeric range literals in the card** — `NeonFader min={0} max={2}` (`:278`) while `defaultValue` is correctly read off the def. picturebox is outside `RANGE_BOUND_CARDS`, so no gate sees it. | `:278` vs `picturebox.ts:202` | **PR 2** (§10.1) — the export is basis code |
| **D4** | ⚠ **Six of seven slots behind an unadvertised right-click**, and the gesture's interaction with the shared node context menu is unmeasured. | `:182-185`, `:239`; `Canvas.svelte:5865` | **fixed by the face** (the body is always visible); measure M1 first |
| **D5** | **The slot-array read/merge is duplicated verbatim** — `:126-143` (load) and `:161-178` (clear) are the same 18-line assets/names/mimes pad-and-slice. A third copy would be added by the body. | direct read | **fix in this PR** via the §6.3 extraction |
| **D6** | **The module bypasses the shell's own media library** — zero `mediaLibrary` references in the card or the producer, while the topbar ships an ingest surface and a loaded-assets picker. | grep | ⚠ **NOT this PR** — §6.4 states the reason and the follow-up |
| **D7** | The `gif too large — showing first frame only` outcome is a transient error line that can be missed, and the only durable signal it left (`synced` vs `gif`) is the readout §7 removes. | `:118-120`, `:199-201`, `:268-270` | **fix in this PR** — keep it a visible non-transient row in the body for the affected slot |

---

## 12. TASTE CALLS, EACH WITH ITS ONE-LINE REVERT

| call | revert |
|---|---|
| `gain` is a `'fader'`, not a knob | delete the `paramCells` entry |
| the bank is always visible rather than behind a disclosure | wrap the seven rows in a `<details>` |
| the preview lives at the top of the body, above the bank | swap the two blocks |
| the filename stays per-row | drop the `.slot-name` span |
| no tab rail | — (adding one needs an owner instruction; `face.tabbed` is not a build-lane decision) |

---

## 13. MUST-VERIFY (before the face is written)

* **M1 — the right-click collision (§2.1).** On `main`, spawn a picturebox in the
  legacy lane and right-click its body. Record: does `NodeContextMenu` open? does
  the multi-panel toggle? both? Then repeat with the node inside the dock full view.
  ⚠ This decides whether D4 is "an undiscoverable panel" or "an undiscoverable panel
  **that also eats the node menu**", and the PR body must state which.
* **M2 — the lane picture actually paints.** After promotion, read the promoted lane
  tile's thumb for a node with a loaded image and assert non-black, and for a node
  with no image assert it matches the idle teal (`picturebox.ts:78`,
  `vec4(0.02, 0.06, 0.08, 1.0)`). Both directions, because "black" and "never
  looked" are indistinguishable from one reading.
* **M3 — the `noUserControl` declaration is accepted.** Run
  `no-user-control.test.ts` and `module-face-lint.test.ts` and confirm the
  completeness arm skips both synthetic params **and** that ranking one of them is
  red (drive the negative control, do not assume it).
* **M4 — the attest hash is unmoved** on the merged tree, per §10.1.
* **M5 — `varispeed-panel-layout.spec.ts`'s disposition (§8)** is decided by reading
  its `CARDS` table in full, not by seeing it stay green.

---

## 14. VERIFICATION GATE

```bash
# 1. the face model + its permanent negative controls
flox activate -- npx vitest run packages/web/src/lib/ui/workflow/picturebox-face-model.test.ts

# 2. face lint + the promotion anchor (both directions)
flox activate -- npx vitest run packages/web/src/lib/ui/workflow/module-face-lint.test.ts

# 3. the noUserControl soundness sweep + its consumers
flox activate -- npx vitest run packages/web/src/lib/ui/workflow/no-user-control.test.ts

# 4. the rulings' source gates
flox activate -- npx vitest run \
  packages/web/src/lib/ui/controls/face-readout-source.test.ts \
  packages/web/src/lib/ui/workflow/face-resting-text-source.test.ts \
  packages/web/src/lib/ui/dock/face-width-source.test.ts

# 5. the registries + the shared-file neighbours
flox activate -- npx vitest run \
  packages/web/src/lib/ui/workflow/shell-extensions.test.ts \
  packages/web/src/lib/ui/workflow/face-migration-inventory.test.ts \
  packages/web/src/lib/ui/modules-card-map.test.ts \
  packages/web/src/lib/control/push2/push-card-schema.test.ts \
  packages/web/src/lib/ui/workflow/dom-source-modules.test.ts

# 6. the module's own suites — picturebox has real coverage; run it
flox activate -- npx vitest run packages/web/src/lib/video/modules/
flox activate -- task e2e:one -- picturebox
flox activate -- task e2e:one -- extras-producer-lifetime

# 7. docs contract — the def's docs are edited (D1/D2), so re-pin and READ the diff
flox activate -- task docs:accept && flox activate -- git diff packages/web/src/lib/docs/contract-lock.txt
#    ⚠ EXPECT AN EMPTY DIFF. D1/D2 are comments; the I/O contract does not move.
#    A non-empty diff means something in §0.1 changed the contract — stop and read it.

# 8. typecheck LAST — vitest is lenient where svelte-check is strict
flox activate -- task typecheck

# 9. VRT: dispatch only, SCOPED, and COUNT the files (§9). NEVER commit a PNG.
GREP=picturebox flox activate -- task vrt:commit

# 10. attest: NIL for PR 1 (§10.1). Confirm the hash is unmoved; do not spend the GPU.
flox activate -- bash scripts/webgl-attest-hash.sh
```

---

## 15. VERDICT, RISK, ESTIMATE

**PROMOTE.** No precursor, no platform change, no new seam. It is the only module in
this wave whose lane picture is *accepted* rather than refused, and the picture
costs nothing because video-domain modules were never on the glyph path (§4).

**Risk: MEDIUM**, and all of it is in two places rather than in the design:

1. **the attest basis** — a single stray line of code in `picturebox.ts` converts a
   free PR into one needing a real-GPU window. §10.1's PR split is the mitigation
   and it is not optional.
2. **the e2e surface** — a long tail of specs drive card testids, and one
   (`varispeed-panel-layout`) has a precondition the face dissolves. None is hard;
   there are simply a lot of them, and the last one needs a judgement rather than a
   selector swap.

**Estimate: ≈ 11 h**, as PR 1 ≈ 9 h (def + body + registries + six spec selector
moves + the D1/D2/D5/D7 fixes + the face-model unit) and PR 2 ≈ 2 h (the range
export, the `RANGE_BOUND_CARDS` entry, and one attest window).

**Build it second in the wave** — after `matrixMix`, which is cheaper and settles the
zero-param question this face does not touch, and before `midiclock`, which is the
one carrying a live-defect fix that wants unhurried review.
