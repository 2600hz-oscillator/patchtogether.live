# FACEPLATE BUILD SPEC — `audioOut` (audio, the rack's TERMINAL)

**SPEC ONLY. Nothing here is implemented.** Mocks: [`dock.html`](dock.html) ·
[`io-panel.html`](io-panel.html).

**Verdict: BLOCKED on one four-line precursor PR, then PROMOTE.**
Risk LOW (the face) / MEDIUM (the precursor, because it moves a second module).
Estimate ≈ 9 h across 2 PRs.

---

## 0. THE CONSTRAINT MAP, READ FIRST

`audioOut` is the only module in this wave whose promotion has a **precondition that
is not about `audioOut`**. Everything else in this spec is ordinary; this section is
not, and it is the reason the module has a two-PR shape.

| fact | where | consequence |
|---|---|---|
| ONE param, `master` (0..1, linear, default 0.7) | `audio-out.ts:99-109` | the face is one cell plus a bespoke device row. Rank is not a question |
| `outputs: []` — a terminal sink | `audio-out.ts:97` | `primaryAudioOutPortId` is null ⇒ **every glyph literal falls to dead static.** Mechanically protected (§4.2) |
| three terminal analyser taps already exist and are unread by any UI | `audio-out.ts:207-246`, `read()` `:301-321` | the face's earned-width argument (§6) and the strongest `nodeId` argument in the fleet (§4.3) |
| one instance is PINNED into every workflow rackspace | `workflow-pins.ts:127` | the surface question below |
| the pinned instance is CANVAS-HIDDEN | `legacy-fallback.ts:186-188`; `_face-fixtures.ts:70-73` | **it has no lane tile and no dock full view** |
| the 🎧 topbar panel plain-mounts the REAL card | `AudioIoSurface.svelte:6-20, 207-215` | that panel is the pinned instance's ONLY surface |
| that panel never asks whether to render a face | `AudioIoSurface.svelte:207-215` vs `DockCardHost.svelte:71` | **§0.1 — the blocker** |
| zero WebGL attest | measured, §10.1 | free |

### 0.1 ⚠ THE BLOCKER: A PURE RULE EXISTS, IS CORRECT, AND HAS A CALLER THAT DOES NOT CALL IT

This is the page's headline. It is not a defect *in* `audioOut`; it is a defect that
only becomes visible **when you try to promote `audioOut`**, which is why it has sat
unnoticed.

`legacy-fallback.ts:229-231`:

```ts
export function dockRailRendersFace(i: DockRailRenderInput): boolean {
  return i.shellFaces && i.pinned && i.migrated;
}
```

Its header states the whole argument, and states it *correctly* (`:186-188`):

> *"a PINNED occupant is canvas-hidden (`isCanvasHiddenNode`), so it has NO lane tile,
> NO EXPAND pill and no route to `DockFullView`. **The tray is its ONLY surface, and it
> is therefore the only place its face can appear.**"*

`Canvas.svelte:2043` calls it for the dock rail. **`AudioIoSurface.svelte` does not.**
Both of its mounts pass six props and no `face`:

```
AudioIoSurface.svelte:171-179   <DockCardHost node={audioIn}  {nodeTypes} rackSize={…} scale={inScale}  title="audio in"  … />
AudioIoSurface.svelte:207-215   <DockCardHost node={audioOut} {nodeTypes} rackSize={…} scale={outScale} title="audio out" … />
DockCardHost.svelte:71          face = false,
```

So `DockCardHost` mounts `nodeTypes[node.type]` — the verbatim legacy card —
unconditionally.

**Therefore, promoting `audioOut` on its own produces this:**

| instance | today | after promotion, with no precursor |
|---|---|---|
| user-ADDED on the canvas | legacy card in the lane tile + dock full view | **the face** |
| the PINNED one, in the 🎧 panel | legacy card | **the legacy card. Unchanged.** |

The pinned one is the instance every user has in every session. **The face would merge
green and change nothing a normal user can reach.**

### 0.2 ⚠ AND TWO INDEPENDENT MECHANISMS WOULD HIDE IT

This is the CLAUDE.md precondition class in its sharpest form: not one blind gate but
two, either of which alone is sufficient.

1. **The prop is missing** (§0.1) — so the panel cannot render a face at all.
2. **The one VRT scene that watches that panel is on the legacy path.**
   `e2e/vrt/workflow-audio-io-composite.spec.ts:53` is `await page.goto('/rack?shell=legacy')`.
   Under `?shell=legacy`, `shellFaces` is false, so `dockRailRendersFace` is false
   **even after the prop is threaded**. That scene can never show a face in that panel.

Mechanism 2 is worth reading twice, because of what that scene is FOR. Its header
(`:3-9`) says it exists for *"the owner-reported breakage class this scene exists to
catch (`this should have been caught with vrt analysis`)"* — the two hosted card faces
rendering wrong. It is the panel's dedicated watcher, and it watches the arm that
promotion does not touch.

**The tree already names this exact class, for the neighbouring surface.**
`legacy-fallback.ts:200-204`:

> *"⚠ AND IT IS WHY THE THREE SHIPPED DRAWER SPECS CANNOT SEE THIS CHANGE —
> `workflow-dock.spec.ts` and `workflow-mode.spec.ts` both drive `/rack?shell=legacy`,
> so they exercise the `false` arm forever. New coverage for the `true` arm must drive
> the DEFAULT shell; see `e2e/tests/workflow-drawer-face.spec.ts`."*

The audio I/O panel has the identical condition and no such warning. The fix is the
same one that file already prescribes: **a scene on the DEFAULT shell.**

### 0.3 THE PRECURSOR PR, SPECIFIED

**PR 1 — `AudioIoSurface` asks the rule it never asked.** Small, and deliberately
separate.

* `WorkflowTopbar.svelte` already receives everything needed; thread `shellFaces` and a
  `migratedFor: (type: string) => boolean` (or the two booleans pre-computed, matching
  how `Canvas.svelte:2043` does it) down to `AudioIoSurface`.
* `AudioIoSurface` calls `dockRailRendersFace({ shellFaces, pinned: true, migrated })`
  **once per column** and passes the result as `face`. `pinned: true` is a literal and
  correct: both occupants are the pinned singletons, that is what the component is.
* ⚠ **Do NOT re-derive `?shell=legacy` or `migrated()` inside `AudioIoSurface`.** The
  whole reason the rule is pure and injected is that `Canvas` reads those in one place
  (`DockCardHost.svelte:48-52` says so explicitly). Adding a second reader is the
  two-derivations-of-one-fact failure the file is built to avoid.
* **A new scene on the DEFAULT shell.** Not a rewrite of
  `workflow-audio-io-composite.spec.ts` — that scene's legacy-arm assertion is still
  worth having, and re-pointing it would delete coverage of the escape hatch. A
  SECOND scene, `/rack` with no `shell` query, asserting the panel's two hosts.
  ⚠ On the day PR 1 lands, both occupants are still un-migrated, so the new scene shows
  legacy cards — **and that is the point**: it is the leg that MOVES when either module
  is promoted, which is precisely what the existing scene can never do.

**⚠ PR 1 moves `audioIn` too, and that is why it is its own PR.** The prop is per-host,
so it could technically be threaded for the AUDIO OUT column alone — **do not.** A rule
applied to one of two identical adjacent occupants is worse than not applying it: it
makes the panel's behaviour depend on which module someone promoted last. Thread both;
`audioIn` is un-migrated so its arm is inert until it is promoted, and then it is
already right.

`audioIn`'s presence is also the reason this cannot ride the face PR: `audioIn` owns a
live `getUserMedia` stream (`AudioIoSurface.svelte:22-25`) and is `DENIED` as a test
fixture for exactly that reason (`_face-fixtures.ts:68-69` — *"capability-dependent on
CI, where there is no camera or mic to grant"*). A face PR should not be the thing
holding a capability-dependent surface when CI goes red.

**PR 2 is then an ordinary face**, and everything from §1 down describes PR 2.

### 0.4 ⚠ THE ORDERING IS NOT A PREFERENCE

Doing PR 2 first is the single most expensive available mistake in this wave. It would
pass `module-face-lint`, `faces-parity`, `curated-face`, `shell-cells`, the dock
render-plan parity gate, `workflow-shell-faces` and the existing audio-I/O VRT scene —
all of them — and deliver a faceplate to the one instance class most users never
create. **The green would be honest and the result would be nothing.**

---

## 1. WHAT THE MODULE IS FOR

`audioOut` is where the patch becomes sound. Two mono inputs, `L` and `R`, each routed
to one side of the stereo bus, following the Eurorack convention the def's own header
states: *"every patch cable is mono; if you want stereo, you patch both L and R"*
(`audio-out.ts:3-5`).

It is not a passive sink. Between the user's signal and `ctx.destination` sit two
always-on stages the user never sees and cannot disable:

1. **A DC blocker** — a 5 Hz `BiquadFilter` highpass per channel, Q 0.707
   (`:139-148`). Attenuates audible content by under 0.1 dB and kills the slow drift a
   feedback loop or a misrouted LFO produces.
2. **A look-ahead brickwall master limiter** at a −1 dBFS ceiling
   (`MASTER_CEILING_DB`, imported from the DSP core rather than re-typed so the
   worklet and the fallback cannot disagree — `:67-72`). Below the ceiling it is the
   identity; above it, the minimum reduction that reaches the ceiling.

The def records why stage 2 is a brickwall and not a compressor, with the measurement
that decided it (`:30-45`): the old `DynamicsCompressorNode` at 4:1 **both pumped the
sub by up to 5 dB per strike AND still let the mix clip the device**, and added a
constant +1.35 dB of makeup to every patch. That is the design intent in one line:
*"no speaker damage from a runaway patch"*, not *"make everything sound compressed."*

There is a third thing the module does that the def calls a card concern: **choosing
which output device the browser sends to**, via `AudioContext.setSinkId`.

**The mental model the face must serve:** this is the last module in the chain. A
player looking at it wants three things, in this order — *is my level right*, *am I
clipping*, and *is it coming out of the right speakers*. Today the card answers the
third, offers a fader for the first, and **cannot answer the second at all**, which
is §6's whole argument.

---

## 2. STOP 1 — is promoting this module a PARITY LOSS?

`AudioOutCard.svelte` is 300 lines and carries exactly four affordances. Enumerated
from the markup (`:182-238`), not from memory:

| affordance | element | survives promotion? |
|---|---|---|
| `master` level | `NeonFader` (`:226-235`) | **YES** — one param cell, `paramCells: { master: 'fader' }` (§8) |
| output device pick | `<select data-testid="audioout-device-select">` (`:190-212`) | **YES**, as a `selector` cell — §3.1, and it is a genuine upgrade |
| `setSinkId` unsupported notice | `.device-notice` (`:214-217`) | **§2.1 — this one needs care** |
| `setSinkId` error | `.device-notice.err`, `role="alert"` (`:218-222`) | **YES**, §2.1 |
| L / R jacks | `PatchPanel` (`:186`) | **YES** — the shell's own rail, unchanged |
| rename | `ModuleTitle` (`:184`) | **YES** — dock title bar |

No hidden gestures: no drag, no right-click menu, no keyboard handler, no file drop, no
wheel handler, no context menu. The card is a fader, a dropdown and two notices.

### 2.1 THE TWO NOTICES ARE THE ONLY REAL PARITY QUESTION, AND ONE OF THEM IS A DEFECT

Both notices are **resting derived-state text**, which the owner has refused four times
and which `face-resting-text-source.test.ts` now denies at the SHAPE level. Neither can
be carried onto a face as written.

They are also not the same thing, and conflating them would lose a real signal:

* **The ERROR notice** (`setSinkIdError`, `role="alert"`) is a **transient response to
  a user action** — the pick did not take. That is not resting text; it is feedback on
  a gesture. It survives as the selector's `aria-label` / `aria-describedby` and,
  because it already carries `role="alert"`, as a live-region announcement. **Nothing
  is painted at rest**, because at rest there is no error.
* **The SUPPORT notice** (*"Device selection requires Chromium-based browsers."*) is
  genuinely resting: on Firefox it paints forever. It **does not survive as text**, and
  it should not — a permanently-painted sentence under a dial is precisely the shape
  that was deleted fleet-wide. It becomes the cell's **DISABLED state plus its
  `aria-valuetext`**, which is speakable, assertable, and unpainted.

⚠ **And this is where the current implementation has a hole the face closes by
accident, so the spec makes it deliberate.** The `<select>` is disabled by
`devices.length === 0 || !setSinkIdSupported` (`:195`), but the notice renders only
`{#if !setSinkIdSupported}` (`:214`). **So on a supporting browser where enumeration
returned nothing, the control is dead and silent** — it shows `(no outputs)`, it is
greyed, and nothing anywhere says why. Two different causes, one indistinguishable
dead state. The face's disabled-state `aria-valuetext` must name WHICH cause
(`no output devices found` vs `output device selection is unavailable in this
browser`), and `audioout-face-model.test.ts` asserts both strings on both causes —
which is strictly more than the card does today.

### 2.2 THE 🎧 PANEL'S OWN CHROME IS NOT THE CARD'S, AND SURVIVES REGARDLESS

Worth proving rather than assuming, because §0 makes it easy to fear the whole panel
moves. The `receive from` rows are the panel's own markup, OUTSIDE `DockCardHost`
(`AudioIoSurface.svelte:218-227`), and they are **derived from the live def** through
the same `collapseStereoPorts` the `PatchPanel` uses (`:69-93`, whose comment records
that they used to be hardcoded literals and why that was the def-disagreement class).
So the L/R receive row, its `data-stereo-sibling`, and the `patchpanel:patchto`
hand-off are untouched by promotion in either direction.

`audio-in.spec.ts:510-545` asserts exactly that row and **drives `?shell=legacy`**, so
it exercises an arm promotion does not move. It needs no change — but it is also not
evidence that the row survives on the default shell, and §14 lists that as a
MUST-VERIFY rather than letting the passing test imply it.

---

## 3. STOP 2 — does every way of getting DATA IN survive?

One way in beyond the fader: the device `<select>`. It needs its own section because
it is not a param and the answer is more interesting than "yes".

### 3.1 THE DEVICE PICKER MAPS ONTO A `selector` CELL — AND MILKDROP ALREADY PROVED THE DYNAMIC CASE

The obvious worry is that a face cell needs a roster declared on the def
(`ParamDef.options`), and the device list is enumerated at runtime from
`navigator.mediaDevices.enumerateDevices()`. **That worry is wrong, and the registry
says so in its first line.** `shell-cells.ts:129-137`:

```ts
/** A dropdown over a NAMED roster that lives in node.data (not a param). */
export interface ShellSelectorCell {
  kind: 'selector';
  tag: string;
  options: (node: ModuleNode | undefined) => SelectorOption<string>[];
  value: (node: ModuleNode | undefined) => string;
  onchange: (nodeId: string, value: string) => void;
}
```

`options` is a **function of the node**, evaluated at render. And `milkdrop` is the
precedent for a genuinely live list, with the argument written out (`:511-512`):
*"live list rather than a static roster, because the list grows with in-session `.milk`
imports and a frozen roster would be wrong the moment…"*. A device list that changes on
`devicechange` is the same shape.

No probe is required — `ShellSelectorCell` carries `value(node)`, so it is observable
by construction. (`probe` is required on `ShellActionCell` `:256` and `ShellPanelCell`
`:358`, the two kinds whose effect is not readable from the cell itself.)

### 3.2 ⚠ BUT A SELECTOR CANNOT REACH THE ENGINE, AND THE DEVICE PICK NEEDS TO

`onchange` is `(nodeId, value)`. It has no `env`. Compare `ShellActionCell`, which gets
a `ShellCellEnv` carrying `engine.write` (`:148-152`) — and the file's justification for
giving it one (`:176-179`) is:

> *"BOTH handlers take the same `env` as the one-shot: an action's press semantics and
> what it can REACH are orthogonal, and a held gesture that needed the engine handle
> would otherwise be the one shape that could not have it."*

**That argument applies verbatim to a selector**, and today the selector is the shape
that cannot have it. Picking a device is not only a data write: it must call
`ctx.setSinkId(deviceId)` on the live `AudioContext`
(`AudioOutCard.svelte:101-123`).

**The route this spec takes needs NO platform change, and it is better than the
widening.** The card already contains the answer, in its own re-apply path
(`:157-159`): on engine boot it re-applies the saved id from `node.data`. So the
saved id is already the source of truth and `setSinkId` is already something that
happens *in response to* that key rather than *as part of* the click. Make that the
only path:

* the selector's `onchange` writes `node.data.outputDeviceId` through an origin-tagged
  seam (§12 D2) — **and nothing else**;
* **ONE owner** applies it: a node-scoped effect (or the audio engine itself) watches
  that key and calls `setSinkId`, on write and on engine boot, from one place.

This deletes the card's current dual-write (`onPickOutputDevice` at `:125-129` does
both), makes the reload path and the click path literally the same code instead of two
code paths that agree, and — the part that matters for a multiplayer product — makes
the behaviour well-defined when the key changes because **a collaborator changed it**
(§12 D3), which today it is not.

**Recorded as the alternative, not taken:** widen `ShellSelectorCell.onchange` to take
`env`, matching the action cell. One line, an exact in-file precedent, and a real
improvement to the registry. It is a platform PR and an owner/queue call, not something
a face PR should self-serve — and it is not needed here.

### 3.3 THE FADER IS ALREADY CLEAN

`setParam` (`:45-47`) is `setNodeParam(id, paramId, v)`. Undoable, origin-tagged,
synced. `readLive` (`:48-54`) reads the engine. **There is no `AudioOutCard` entry in
`raw-write-ledger.ts` and none is owed for the fader** — it is correct as written.
(The device write is a different matter and a different ledger's business; §12 D2.)

---

## 4. THE LANE PICTURE — a decision, stated as a decision

### 4.1 THE DECISION

**`glyph: 'none'`.** No lane picture.

### 4.2 IT IS MECHANICALLY REFUSED, WHICH MAKES IT THE EASY HALF

`shell-glyph-live.ts:111-113`:

```ts
export function primaryAudioOutPortId(def) {
  return def?.outputs?.find((o) => o.type === 'audio')?.id ?? null;
}
```

`audioOut` declares `outputs: []` (`audio-out.ts:97`). It is a terminal sink; it has no
output ports of any type. So `primaryAudioOutPortId` is `null`, **every glyph literal
falls to `{kind:'static'}`, and the unconditional dead-glyph clause catches it.**

This is `dockscope`'s protection, and it means an author who never read this section
still ships the right thing. It is the **opposite** of `scope`'s situation (where the
binding resolves live and lies) and of `twotracks`' (§ that spec, where it resolves
live and is ambiguous). Recorded as a permanent negative leg in
`audioout-face-model.test.ts` anyway — the *mechanism* is what protects us, and if
someone ever gave `audioOut` a thru output the protection would silently vanish.

### 4.3 ⚠ AND THIS IS THE MODULE WHERE THE PICTURE IS MOST WANTED AND LEAST REACHABLE

The honest version of the `nodeId` argument, including the half that weakens it.

**Why `audioOut` is the strongest ARGUMENT.** Wave 2 nominated `scope` for the
`ShellExtensionGlyphProps.nodeId` escalation, on the grounds that a live glyph there
would be a *lie* (its `ch1_out` IS `gain1`, invariant to all nine controls).
`audioOut`'s picture would be the terminal L/R level, and it is:

* **not a passthrough** — it is measured at `tail`, the same node that feeds
  `ctx.destination`, so it sees the master gain AND the limiter's action
  (`audio-out.ts:235-246`);
* **already built, already negative-controlled in both directions on every run** by
  `art/scenarios/audio-out/per-channel-taps.test.ts`, which the def names at `:63`;
* **the single most useful thing a rack-wide glance could carry.** The def documents,
  at length (`:213-234`), that the mono tap cannot tell only-L from only-R and reads
  ~0 for an anti-phase pair — which is exactly the diagnosis a player needs and cannot
  get. Today, **the module every patch terminates at cannot tell you whether it is
  clipping.**

**Why it is a worse ADOPTER, and this is not a footnote.** The pinned instance is
canvas-hidden. **It has no lane tile.** A glyph would paint only on user-ADDED
`audioOut` instances — the minority case, and the case that matters least, since a user
who deliberately added a second output is already looking at it.

**So: `scope` remains the right first adopter of the `nodeId` prop; `audioOut` is the
best argument for why the prop is worth adding at all.** Both halves go to whoever
picks that platform PR up. Nothing here depends on it.

---

## 5. THE FACE

### 5.1 RANK — `face.order`

```ts
order: ['master']
```

One param. Rank is not a question and there is nothing to argue. The device selector is
a `shell-cells` registry cell, not a `face.order` key — it is not a param, and
`face.order` keys are param ids (`graph/types.ts:799-803`).

### 5.2 NOT CONTROL-HEAVY. NO TAB RAIL, AND IT COULD NOT ENGAGE

`DOCK_TAB_MIN_BANDS = 7` (`dock-tabs-model.ts:56,72`). This face has two bands (§7).
There is no owner instruction for `face.tabbed` on `audioOut` and **this spec does not
reach for one** — the opt-in is owner-instruction-only, recorded verbatim in
`FACE_TAB_OPT_IN`, and the risk the rule exists to prevent is exactly an agent writing
a plausible sentence about what the owner wanted.

### 5.3 COMPACT BY DEFAULT — and this face has nothing to argue about

The width ruling puts the burden of proof on the wide face. `audioOut` carries one
fader, one dropdown and (per §6) one meter. **It is the narrowest face in the wave and
should stay that way.** `FACE_WIDTH_EXEMPTIONS` is untouched; `audioOut` must not
become an entry, and `workflow-shell-faces.spec.ts`'s per-face content-vs-plate
measurement is the runtime check that it did not.

---

## 6. THE BODY — `face.extension: 'audioOut'`, and the one thing that EARNS width

### 6.1 The argument

Three analyser taps already hang off `tail` — the exact node feeding `ctx.destination`
— and they are read by **nothing in the UI**. `read('outputSnapshot')`,
`read('outputSnapshotL')` and `read('outputSnapshotR')` (`audio-out.ts:301-321`) exist
solely for e2e audibility assertions.

The owner's list of genuine width earners is *"a live picture, a scope trace, a video
preview, an XY pad, or a control that appears in one mode only."* **A stereo terminal
meter is a live picture**, it is the picture this module is about, and it costs nothing
new — the data is already tapped, already per-channel, already negative-controlled.

It also closes the module's one real functional gap: the rack's terminal currently
gives no indication of level or of limiting.

### 6.2 The component, specified

`$lib/ui/modules/audioOut/shell-extension.ts` → `{ fullViewBody: AudioOutMeterBody }`.
`fullViewBody` is WIRED (`shell-extensions.ts:124`), dock-only, paints above the
control bands, replaces the hero glyph — and **leaves every param cell intact**
(`:85-87`), so `master` still gets its cell and face completeness still applies.

* **A 2D canvas.** ⚠ Deliberately 2D: attest basis rule (2) is derived from CONTENT, so
  a body written against a WebGL context would enter the basis automatically and make
  every future edit of this module cost a GPU re-attest. §10.1.
* **Two horizontal bars, L over R**, drawn from `outputSnapshotL` / `outputSnapshotR`.
  Not the mono key, ever — the def spends 20 lines (`:213-234`) explaining that the
  mono tap cannot distinguish only-L from only-R and reads ~0 for an anti-phase pair.
  **Using the mono key here would reproduce the exact blindness the per-channel taps
  were added to fix.**
* **A ceiling mark at −1 dBFS**, read from `MASTER_CEILING_DB` — **imported, never
  re-typed.** The def already imports it from the DSP core rather than re-typing it,
  with the reason stated (`:67-72`), and re-typing it in the body would re-create the
  card-disagrees-with-its-def class one layer out.
* **A peak-hold tick** per channel with a decay tail. The tail is a genuine
  product-side interval, so any e2e that waits on it writes the `// pacing:` comment
  naming where the product defines it.
* **NO NUMBERS PAINTED.** No dB readout, no "−1.0 dBFS" label, no peak value. The
  meter is a picture; the measurement lives in `aria-valuetext` on the meter element,
  which is speakable and assertable and unpainted. This is not a close call — a
  labelled row of derived values under a picture is the hero readout strip, deleted
  fleet-wide on 2026-08-19.
* **Visibility-gated.** The draw loop must not run when the body is not on screen. The
  legacy card has no equivalent loop to copy, so this is new code and gets it right the
  first time; `kria`'s spec (§12) documents what the ungated version costs.

### 6.3 ⚠ SCREEN ON/OFF — and `audioOut` is on the "no" side of it

The ruling is that every VIDEO module's face gets a SCREEN toggle. `audioOut` is
`domain: 'audio'`, so `video-face-screen-source.test.ts` — which sweeps
`listVideoModuleDefs() ∩ STRICT_FACES` — cannot see it either way. That gate hole is
already recorded fleet-wide (wave 2's README); nothing new here.

On the merits: **no toggle.** `dockscope`, `spectrograph` and `samsloop` each refuse
one on `videoOut`'s argument — when the picture IS the module, collapsing it deletes the
product. A terminal meter is closer to that than to a preview beside nine controls: a
face with the meter collapsed is a face with one fader on it, and the reason to open
`audioOut` at all is to see the level. **Do not add a switch whose off state is an
empty plate.**

⚠ This is a judgement, so it gets a revert: if the owner wants it, it is a
`previewCollapsed` key on `node.data` (never component `$state` — the #1531/#1574/#1583
unmount class) reusing that exact key name, and the collapse must skip the PAINT and
never the read loop.

---

## 7. BAND STRUCTURE — two bands, no rail

```
1 · OUTPUT      master
2 · DEVICE      <selector cell: output device>
```

Two bands, so `dockRowPlan` may pack them into one row. That is correct and wanted:
this face should be one compact block. ⚠ `bandIsPackable` is DENY-BY-DEFAULT —
`cellWidthClass` returns `'wide'` for anything it cannot resolve (`dock-row-plan.ts:115`,
`:156`) — so a `selector` cell may well class wide and force band 2 solo. **That is
acceptable and must be MEASURED rather than predicted**; §14 lists it.

Band labels stand alone (`OUTPUT`, `DEVICE`) — annotations are off by default, so the
resting plate is the module name in the dock title bar, those two labels, and the
control captions. Nothing else.

---

## 8. CONTROL INVENTORY — every primitive decision, argued

| key | primitive | why |
|---|---|---|
| `master` | **`fader`**, declared `paramCells: { master: 'fader' }` | The card mounts a `NeonFader` (`:226`). **Undeclared, it silently becomes a dial** — `'fader'` and `'hue'` are the primitives that cannot be inferred. A master level is a throw, not a dial: `mixmstrs` and `noise` are the precedent, and `noise`'s face carries the declaration for exactly this reason. Costs ~96 px in a lane cell, which this face can afford at rank 1 of 1 |
| output device | **`selector`** registry cell | §3.1. `tag: 'OUT'`, `options` from live enumeration, `value` from `node.data.outputDeviceId`, `onchange` writes that key (§3.2) |

**Two things NOT done, each with its reason:**

* **No `hero`.** A hero MOVES a key out of its band (`dock-faceplate-model.ts:276`) and
  a `hero.cell` suppresses the shell glyph at the dock. With one param there is nothing
  to promote it above, and the body already takes the hero glyph's place.
* **No ACTION cell.** There is no gesture here — nothing to fire, nothing to audition.

---

## 9. THE STATE MATRIX

The states `audioout-face-model.test.ts` must pin. Each is a state a user can actually
be in, and each has a distinct observable.

| # | state | meter | selector | `aria-valuetext` |
|---|---|---|---|---|
| 1 | nothing patched | both bars at floor, idle drawn | enabled, `Default` | `silent` |
| 2 | mono into L only | L moving, **R at floor** | enabled | names the L level |
| 3 | anti-phase stereo pair | **both bars moving** | enabled | names both levels |
| 4 | above the ceiling | bars at ceiling mark, peak tick held | enabled | names limiting |
| 5 | `setSinkId` unsupported | unchanged | **disabled** | `output device selection is unavailable in this browser` |
| 6 | supported, zero devices enumerated | unchanged | **disabled** | `no output devices found` |
| 7 | `setSinkId` rejected | unchanged | enabled, live-region announce | the error message |

⚠ **States 2 and 3 are the permanent negative controls, and they are the whole reason
the body reads the per-channel keys.** Both are states where `read('outputSnapshot')`
— the mono key — gives an answer that is indistinguishable from silence or from the
wrong channel. A body that regressed to the mono key would still pass a naive
"the meter moves" assertion and would fail these two. States 5 and 6 are the pair
§2.1 found the card cannot distinguish.

---

## 10. COST

### 10.1 ⚠ WEBGL ATTEST: ZERO. MEASURED, NOT REASONED.

```sh
flox activate -- bash scripts/webgl-attest-hash.sh --list | grep -iE 'audio-out|AudioOutCard'
```

returns **nothing**. `audio/modules/audio-out.ts`, `ui/modules/AudioOutCard.svelte` and
`ui/workflow/AudioIoSurface.svelte` are all absent from the basis. Both PRs are
zero-attest.

⚠ **The body must stay 2D to keep it that way.** Basis rule (2) is derived from
CONTENT, so an `AudioOutMeterBody` written against a WebGL context would enrol itself
and make every subsequent edit cost a GPU re-attest. There is no reason to use WebGL
for two bars.

### 10.2 ART: ZERO — and the first draft of this section was WRONG

⚠ **ART pins baselines to the RAW FILE SHA and is NOT comment-stripped** — the opposite
of the attest, and that asymmetry cost wave 2 a red run on a comment-only edit. So the
first draft of this section reasoned from the rule: `art/scenarios/audio-out/` exists
(three test files, two of them named in the def), PR 2 edits `audio-out.ts` to add the
`face` block, **therefore the pin moves.**

**Measured, and it does not.** ART's source pins are `.sha` files living beside their
`.f32` baselines in `art/baselines/<module>/`. There is **no `art/baselines/audio-out/`**,
and `audioOut` sits in **`ART_EXCLUDED`** (`art/setup/profile-coverage.ts:44`) with a
reason:

> `audioOut: 'terminal sink — no audio-family OUTPUT port to capture'`

**There is no baseline, so there is no pin, so there is nothing to re-pin.** The
scenarios under `art/scenarios/audio-out/` are property tests (the limiter's
no-overshoot proof, the per-channel taps' two-way negative control), not SHA-pinned
captures.

⚠ Note the exclusion reason is the **same structural fact** as the glyph refusal in
§4.2 — `outputs: []`. One property of this module is why it cannot have an ART baseline
*and* why it cannot have a live glyph.

⚠ **Do not remove it from `ART_EXCLUDED`**, and do not add a scenario. This PR must
leave `art/` entirely out of its diff; anything appearing there is a signal, not a
chore.

**Recorded rather than silently corrected**, because "the rule says the pin moves" and
"this module has a pin" are different claims, and only the second one is checkable.

### 10.3 CI wall-time

PR 1: one new VRT scene on the default shell. PR 2: registry-driven auto-enrolment
(`faces-parity` partition row, `module-face-lint` completeness, dock render-plan
parity, `shell-cells`, the `faceplate-platform` annotation sweep) plus two dock VRT
scenes and one `audioout-face-model` unit file. **Both well under the 2 min
threshold**, but the estimate is stated so the delta is a claim someone can check.

⚠ `faceplate-platform.spec.ts:151`'s `sweepBudgetMs(adopterCount)` scales with the
roster — adding an annotation adopter has reddened a shard before. Watch it.

### 10.4 The Push 2 card moves — observed, not discovered

`push-card-config.ts` resolves tier 2 from `face.order` when there is no override, so
**authoring a face silently re-ranks this module's Push card.** `audioOut` has no
`PUSH_CARD_CONTROLS` entry today. With one param the ranking has one candidate and the
result is trivially correct — but *trivially correct* is still a change, so it is
pinned as a permanent leg in `push-card-schema` rather than assumed.

---

## 11. DETERMINISM AND VRT

The meter is live, so the dock scene must be deterministic by construction, not by
timing.

* **The scene captures the IDLE state** — nothing patched, both bars at floor. That is
  state 1, it is a real state, and it is the state a fresh spawn is in.
* **The idle state must be DRAWN**, not blank. "Found nothing" and "not on this
  surface" must be different pictures — the same rule wave 2 applied to `scope`'s
  graticule. A blank canvas in a baseline is indistinguishable from a body that failed
  to mount.
* ⚠ **Do NOT mask the meter canvas.** A masked canvas makes the baseline blind to the
  one thing this body adds. If the idle state cannot be made deterministic, the body is
  wrong, not the baseline.
* **Two scenes predicted**: `face-audioOut-compact.png`, `face-audioOut-dock.png`.
  ⚠ Dispatch with `GREP=audioOut task vrt:commit` — a bare dispatch on a face PR
  derives FULL, because the derivation reads PATHS ONLY and every face PR touches a
  shared roster file whose path names no module. **Count what the bot commits against
  that prediction**; a green dispatch that committed nothing, or that committed a
  third file, is a red flag rather than a pass.
* ⚠ **PR 1 may move `workflow-audio-io.png`.** Threading a prop that evaluates false
  should be a no-op — but "should be" is not a measurement, and the existing scene is
  page-level rather than element-level. **Predict zero moved baselines for PR 1 and
  reconcile against it.** A moved baseline there means the prop threading changed
  something, and that is worth knowing before it ships.
* `e2e/vrt/workflow-shell-faces.spec.ts`'s `FACES` roster is **NOT registry-driven** —
  a promoted module missing from it silently has no VRT scene. Add `audioOut` by hand.

---

## 12. DEFECT LEDGER

| # | defect | evidence | routing |
|---|---|---|---|
| **D1** | **`formatDeviceLabel` returns `Input #N` for OUTPUT devices.** The AUDIO OUT dropdown lists speakers as inputs whenever the browser's privacy gate leaves labels empty — which the helper's own header says is the PRE-PERMISSION default, and which for audiooutput labels persists until MICROPHONE permission is granted. So on a fresh rack, before any permission, **every entry in the output picker reads `Input #1`, `Input #2`, …** | `devices.ts:149-155` (`return \`Input #${index + 1}\``), used by `AudioOutCard.svelte:208` **and** `AudioinCard`; header `:11-18` states the permission behaviour | **Fold into PR 2.** Give the helper a direction, or split it. ⚠ Fix the CARD too — a face does not pay a card's debt |
| **D1b** | ⚠ **A green gate certifies D1.** `devices.test.ts:128-133` pins `'Input #1'` with the comment *"Pre-permission privacy gate"*. The test is direction-blind, so it asserts the wrong word is produced and passes | `devices.test.ts:131-132` | **Same PR.** The repaired test asserts BOTH directions — this is the CLAUDE.md "a gate that reads only one side of a two-sided contract" case, in its strongest form: the gate does not merely fail to catch the bug, it pins it |
| **D2** | **The device pick is un-undoable and untransacted.** `target.data['outputDeviceId'] = deviceId` is a bare proxy write outside any `ydoc.transact`, so it carries no origin and the UndoManager never sees it | `AudioOutCard.svelte:63-69`; `store.ts:70` `trackedOrigins: new Set([LOCAL_ORIGIN])` | **Fold into PR 2**, as part of §3.2's single-owner rewrite. ⚠ Not visible to `mutate.guard` — its regex anchors on `.params` (`mutate.guard.test.ts:94`). See the wave README |
| **D3** | **A collaborator's device pick moves YOUR speakers.** `outputDeviceId` mirrors into the Y.Doc, so a remote peer's change re-targets the local `setSinkId`. The card's own comment concedes it: *"at the cost of a remote user being able to nudge your sink choice"* | `AudioOutCard.svelte:28-31` | **REPORT — owner call, do not fix in a face PR.** The precedent cuts the other way: `clipplayer` keeps grid LED + serial I/O *per-user local* while syncing the session. An output device is a per-machine fact. But changing it changes what a saved rack restores, so it is not a face PR's decision |
| **D4** | **A dead, silent control.** The `<select>` disables on `devices.length === 0 \|\| !setSinkIdSupported` but explains only the second cause, so a supporting browser with zero enumerated devices shows a greyed `(no outputs)` and no reason | `AudioOutCard.svelte:195` vs `:214` | **Fold into PR 2** — §2.1; the face distinguishes both causes in `aria-valuetext` and the model test asserts both |
| **D5** | **The device-detect `setInterval` is never cleared on unmount.** `onMount` (`:146-165`) starts a 100 ms × 50 retry loop and clears it only on success or exhaustion; `onDestroy` (`:173-177`) removes the `devicechange` listener and nothing else. An unmounted card can keep a timer for up to its full window and write `$state` after destroy | `AudioOutCard.svelte:137-177` | **Fold into PR 2.** Small, and it is the card-unmount-kills-node-resources class seen from the other side — under dock collapse / LRU eviction this card unmounts routinely |
| **D6** | `setSinkIdError` is not cleared on the branch that discovers `setSinkId` is missing (`:113-116` returns after setting `setSinkIdSupported = false`), so a stale error can persist under a support notice that says the feature is unavailable | `AudioOutCard.svelte:113-123` | **Fold into PR 2.** Trivial; listed because it is the kind of thing the state matrix (§9, rows 5 and 7) makes visible and would otherwise be found by a reviewer |
| **P1** | **`AudioIoSurface` never calls `dockRailRendersFace`** | §0.1 | **PR 1. This is the blocker.** |
| **P2** | **The audio-I/O VRT scene is on the legacy arm** and cannot see a face in that panel | `workflow-audio-io-composite.spec.ts:53` | **PR 1**, as a SECOND default-shell scene — not a re-point (§0.3) |

⚠ **D1, D2, D4, D5 and D6 are card defects, and a face does not pay a card's debt.**
The legacy card still renders under `?shell=legacy` and in the per-card VRT sweep.
Each fix edits `AudioOutCard.svelte` (and `devices.ts`) directly; the face is not the
fix. This is the mistake #2025 made by name.

---

## 13. TASTE CALLS, EACH WITH ITS ONE-LINE REVERT

| call | revert |
|---|---|
| The meter is a stereo BAR pair, not a waveform | swap the draw function; the taps and the `aria-valuetext` are unchanged |
| No SCREEN ON/OFF toggle (§6.3) | add the `previewCollapsed` key + overlay button; the read loop must still run |
| Two bands rather than one | merge `DEVICE` into `OUTPUT`; `dockRowPlan` may already be doing this visually |
| `tag: 'OUT'` on the selector | one string. The card says `out` (`:189`); this promotes the case, nothing more |
| The peak-hold tick | drop the hold; the instantaneous bar is unaffected |

---

## 14. MUST-VERIFY — claims this spec makes that the build must prove

1. **The pinned instance renders the face after PR 1.** Not "the prop is threaded" —
   the actual pinned AUDIO OUT in the 🎧 panel on the DEFAULT shell shows the
   faceplate. This is the entire point of PR 1 and it must be a runtime assertion.
2. **The panel's `receive from` rows survive on the DEFAULT shell** (§2.2). The
   existing assertion is legacy-only and proves nothing about the promoted arm.
3. **PR 1 moves ZERO baselines.** Predicted in §11; reconcile against the bot's commit.
4. **The body reads the PER-CHANNEL keys** — states 2 and 3 of §9, as permanent
   negative controls. A mono-key regression must be red.
5. **Both disabled causes are distinguishable** — states 5 and 6.
6. **`FACE_WIDTH_EXEMPTIONS` is untouched** and `workflow-shell-faces`'s
   content-vs-plate measurement passes without one.
7. **Band packing measured, not predicted** (§7) — whether the selector classes wide.
8. **`master` renders as a FADER, not a dial**, on both the lane cell and the dock.
9. **ART stays out of the diff entirely** (§10.2) — no baseline exists, `audioOut` stays
   in `ART_EXCLUDED`, and the three `art/scenarios/audio-out/` property tests pass
   unchanged.
10. **`audioIn` is unaffected in behaviour** by PR 1 while it remains un-migrated —
    its arm evaluates false and its `getUserMedia` lifecycle is untouched.

---

## 15. VERIFICATION GATE

```sh
# 1. the pure model + this face's PERMANENT negative controls (§9, §14.4, §14.5)
flox activate -- task test:one -- audioout-face-model

# 2. face lint: completeness, consistency, dead-glyph, dock render-plan parity
flox activate -- task test:one -- module-face-lint
flox activate -- task test:one -- dock-row-plan
flox activate -- task test:one -- dock-faceplate-model
flox activate -- task test:one -- curated-face

# 3. the rulings' source gates
flox activate -- task test:one -- face-resting-text-source   # §2.1 — the two notices
flox activate -- task test:one -- face-readout-source
flox activate -- task test:one -- face-width-source          # §5.3 — no new exemption

# 4. the registries
flox activate -- task test:one -- shell-cells                # §3.1 selector shape
flox activate -- task test:one -- shell-extensions           # §6.2 slot shape
flox activate -- task test:one -- module-shell-import-guard
flox activate -- task test:one -- push-card-schema           # §10.4
flox activate -- task test:one -- devices                    # §12 D1b — BOTH directions now
flox activate -- task test:one -- mutate.guard               # §12 D2 — must stay green
flox activate -- task test:one -- module-docs-lint
flox activate -- task docs:check

# 5. e2e — PR 1's new default-shell scene is the one that matters
flox activate -- task e2e:serve
REPEAT=3 flox activate -- npx --workspace e2e playwright test faces-parity --grep audioOut
REPEAT=3 flox activate -- task e2e:one -- tests/audio-in.spec.ts      # §2.2, legacy arm
REPEAT=3 flox activate -- task e2e:one -- tests/faceplate-platform.spec.ts
flox activate -- task e2e:stop

# 6. typecheck LAST — svelte-check is stricter than vitest
flox activate -- task typecheck

# 7. VRT: dispatch only. NEVER commit a PNG.
GREP=audioOut flox activate -- task vrt:commit

# 8. ART — there is NO baseline and NO pin (§10.2). Run the property tests; expect
#    `art/` to be absent from the diff. Do NOT run art:update.
flox activate -- task art:one -- scenarios/audio-out

# 9. attest: NIL. Nothing to run and nothing to report (§10.1).
```

---

## 16. BUILD-COST ESTIMATE

| | |
|---|---|
| **PR 1** — thread `shellFaces`/`migrated`, call the rule twice, one default-shell VRT scene, reconcile zero baseline moves | **≈ 3 h** |
| **PR 2** — the face declaration, the selector cell, the meter body, the single-owner sink rewrite, the card defect fixes (D1, D1b, D2, D4, D5, D6), the model test, two VRT scenes, ART re-pin | **≈ 6 h** |
| **Total** | **≈ 9 h** |

Risk is LOW on PR 2 and MEDIUM on PR 1 — not because PR 1 is large, but because it is
the PR that changes what a surface every user sees renders, for two modules at once,
with one of them capability-dependent on CI.
