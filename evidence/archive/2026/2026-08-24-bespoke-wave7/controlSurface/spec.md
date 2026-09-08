# FACEPLATE BUILD SPEC — `controlSurface` (meta, the abstract control panel)

> **SPEC + MOCKS. Nothing here is implemented.** Wave 7, cohort B (agent B).
> Mocks: `dock.html` (the dock faceplate, populated) · `lane-tile.html` (what the
> 192 px shell tile can and cannot hold — the refusal, drawn).
> Every claim carries `file:line` on `origin/main`. Verified with
> `flox activate -- git show origin/main:<path>`.

---

## VERDICT — **REFUSE (promotion is a functional-parity loss), and the blocker is MECHANICAL, not a judgement call**

`controlSurface` is in `NON_SHELL_LANE_TYPES` (`legacy-fallback.ts:110-129`). Three
mechanisms interlock, and together they make promotion strictly lossy today:

1. **A `NON_SHELL_LANE_TYPES` member's lane is `'legacy'` unconditionally** — promotion
   cannot change it (`_face-fixtures.ts:333-334`, quoting `laneRenderKind`).
2. **So the module must LEAVE that set to be promoted** — because the VRT compact scene
   locates `.svelte-flow__node[data-id="…"] [data-testid="module-shell"]`
   (`e2e/vrt/workflow-shell-faces.spec.ts:363`), which does not exist inside a legacy
   card; and `STRICT_FACES ≡ FACES` is asserted **in both directions**
   (`workflow-shell-faces.spec.ts:526-545`), so there is no promotion without that scene.
3. **The moment it leaves, the lane becomes `SHELL_TILE_W = 192` × `SHELL_TILE_H_SLOT = 180`,
   uniform at EVERY zoom** (`module-shell-model.ts:39,55`; `Canvas.svelte:631-650`) — and
   one binding group box is **`BOX_W = 174` px wide × 124 px tall** for two knobs
   (`control-surface-layout.ts:76-79`, `:100-104`). **There is no seam that can put a
   proxied knob in that tile**: `fullViewBody` is dock-only by `dockFullViewHeadPlan`
   (`matrixmix/shell-extension.ts:53-58`), and `ShellExtensionGlyphProps` carries no
   `nodeId`, so a glyph is identical for every instance and cannot show this node's
   bindings.

**That is #1974 (`joystick`) verbatim**, from the skill's own STOP 1
(`module-faceplates.md:62-78`): *"every lane tier resolves to zero controls: a title, a
patch panel, and no stick, on a module whose entire purpose is a performance gesture."*
Substitute *proxied knob* for *stick* and the sentence is unchanged. Reaching for a knob
you laid out is this module's entire purpose, and after promotion the lane holds none of
them.

**Per the skill, this verdict is produced and not escalated** — *"Both are
functional-parity losses, which are never surfaced as an owner choice after the build —
file the blocker and move on to the next module. That is the verdict this stop exists to
produce now."* Under the standing no-new-issues ruling the blocker is recorded HERE and in
`face-migration-inventory.ts`, not on the board.

**§12 states the ONE platform change that lifts it**, and it is small, named, and useful
to five other modules.

⚠ **AND THERE IS A SECOND, INDEPENDENT BLOCKER — §5.3.** Authoring a `face` on this module
is **RED** on `face-migration-inventory.test.ts`'s typed-entry leg, because the rename
`<input type="text">` lives on the LEGACY CARD (which promotion does not remove) and
declaring a `face` forces the entry to `generic-face`, which that leg refuses. ⚠ **Wave 6
§5.2's prescription — "drop the blocker from the `blockers` array" — does NOT fix it**: the
leg `continue`s out of the `generic-face` branch before it ever reads that array.
**Escalated, not resolved here**, and the face design is identical whichever way it goes.

⚠ **The rest of this document is not wasted by the refusal.** §4-§9 are the face that
should be built the day §12 lands, and §5, §6.2 and §13 are findings that stand on their
own today.

---

## 0. THE COMMISSIONING QUESTION, ANSWERED FIRST: **`controlSurface` HAS NO DEVICE. AT ALL.**

> ### ⚠ **`controlSurface` IS IN THE "HARDWARE CONTROL SURFACES" COHORT BY NAME ONLY.**
>
> Written out so no later reader has to re-derive it. This module is a `meta` def with
> **zero ports, zero params, no `docs` field, no factory and no engine binding**
> (`meta/modules/control-surface.ts:24-34`), whose entire state lives on `node.data` and
> is populated by right-clicking *"Send to ⟨surface⟩"* on another module's knob. **It is
> a TABLE OF BINDINGS. Its face problem is a table problem, not a device problem.**
> There is no connect gesture to design, no roster to enumerate, no permission to
> request, and **no lamp may be drawn for a device that does not exist** — a
> `StatusLed` on this face would be a lie with the ruling's own primitive as cover.
> The word "surface" in its name refers to a *control surface* in the abstract
> mixing-desk sense, not to a piece of hardware.

The wave was commissioned on the premise that *"a PHYSICAL DEVICE is the interaction"* for
all seven cohort members. **It is false for this one, and the measurement is a clean
zero.**

```sh
flox activate -- git grep -n -E "navigator\.|requestMIDIAccess|MIDIAccess|getGamepads|usb|WebMIDI|card-api|getActiveEngine" \
  origin/main -- packages/web/src/lib/ui/modules/ControlSurfaceCard.svelte \
                 packages/web/src/lib/graph/control-surface.ts \
                 packages/web/src/lib/graph/control-surface-params.ts \
                 packages/web/src/lib/graph/control-surface-layout.ts \
                 packages/web/src/lib/graph/control-color.ts
# → (NO HITS)
```

**Zero hits across the card, the data model, the param adapter, the layout lib and the
colour resolver.** The card's only engine touch is `engineCtx.get()?.readParam(live, paramId)`
(`ControlSurfaceCard.svelte:189-199`) — a read of *another node's* live param value so the
proxied dial ticks with motorised CV. That is a GRAPH read, not a device read.

⚠ **Verified against the CARD and the graph module as instructed, not inferred from the
def header.** The def (`meta/modules/control-surface.ts`, 34 lines) is 20 lines of comment
and 13 lines of `MetaModuleDef` with `inputs: []`, `outputs: []`, `params: []`. But the
absence in the def proves nothing on its own — the measurement above is over the two files
that could have hidden a listener.

### 0.1 The device is ONE HOP AWAY, IN A DIFFERENT MODULE — and that is the useful finding

`controlSurface` is a **device-independent data structure that device modules CONSUME**:

| consumer | how it reaches this module | at |
|---|---|---|
| `electraControl` (Electra One, SysEx) | imports `listControlSurfaces`, `groupBindingsByModule`, `surfaceName` from `$lib/graph/control-surface`, and `resolveSurfaceParam` | `electra/host.ts:8`, `:21`, `:28` |
| the Electra preset generator | mirrors `ControlBinding` so the generator does not depend on the graph layer | `electra/preset.ts:12`, `:45` |
| Push 2 | imports `resolveSurfaceParam` | `push2-control.svelte.ts:92` |

And the data model is authored FOR that hardware: `ControlBinding.name` is documented as
*"Optional user-set CUSTOM display name … used on the Electra preset, clamped to 14 chars
there"* (`graph/control-surface.ts:36-38`), and `controlType?: 'knob' | 'button'` exists
solely to *"drive the Electra preset representation: a 'knob' (default) → fader/list; a
'button' → a pad"* (`:40-43`). The card's rename button's own `title` is `Rename "…" for
the Electra` (`ControlSurfaceCard.svelte:377`).

**So the cohort's shared design problem needs restating, and this is the wave-level
correction:** the shared thing is **not** *"a physical device is the interaction"*. It is
**a MAPPING TABLE whose rows point at something outside the module.** For five members the
far end is a device; for `controlSurface` the far end is *other nodes in the same graph*,
and the device belongs to a different module that reads this one. The table is the
invariant; the device is not.

### 0.2 The two-line consequence for the cohort's design questions

Every question the cohort was expected to converge on is a DEVICE question — *is there a
connect gesture? a permission prompt? a roster? a status?* **`controlSurface` answers "no"
to all four**, and it still needs the same body shape as the ones that answer "yes",
because the body's job is to render a variable-length table of pointers. That is the
strongest available evidence that the cohort's real invariant is the table.

---

## 1. THE CONSTRAINT MAP

| registry / gate | member? | what it means here |
|---|---|---|
| `NON_SHELL_LANE_TYPES` (`legacy-fallback.ts:114`) | **YES** | `laneRenderKind` returns `'legacy'` unconditionally. **THE WALL** — see the verdict. |
| `dockable.ts:37` | **YES** | it can be docked today, and the dock full view is the surface a face would improve. |
| `WORKFLOW_PINNED_MODULES` | **NO** (`grep` over `workflow-pins.ts` returns nothing for `controlSurface`) | ⚠ **Unlike `electraControl`**, which is the pinned `E` of the M/E/C trio. So `dockRailRendersFace` (`legacy-fallback.ts:263-265`, `shellFaces && pinned && migrated`) is **structurally false** here and the drawer wall that dominates `electraControl`'s spec does not apply. This module's problem is the LANE, not the drawer. |
| `STRICT_FACES` | **NO** | and reachable now — see the next row. |
| `MetaModuleDef.face?` / `.controlFamilies?` | ✅ **PRESENT** (`meta/module-registry.ts:85`, `:106`) | ⚠ **CORRECTION to wave 1.** `.myrobots/2026-08-23-bespoke-wave1/electraControl/spec.md:35` records `STRICT_FACES` as *"structurally impossible today — `MetaModuleDef` has no `face` field"*. **That landed with matrixMix.** The registry now carries both fields with a long note on why `face?` alone would have been *"a promotion route to a blank tile"* (`:97-104`). **The meta-domain platform precursor is DONE; no wave-7 spec should re-request it.** |
| `EXEMPT_FROM_VRT` (`vrt-exemptions.ts:639`) | **YES** | and §6.2 shows the rationale is matrixMix's overturned argument, verbatim in structure. |
| `ALLOWED_PERMANENT_EXEMPT` (`vrt-exemptions.ts:1213`) | **YES** | anchored in both directions by `vrt-meta.test.ts`, so a one-sided delete is RED. |
| `PUSH_CARD_CONTROLS` (`push-card-config.ts`) | **NO** | zero params — nothing to rank, nothing can drift. |
| WebGL attest basis | **NO — VERIFIED MECHANICALLY** | `resolveWebglBasis()` (`scripts/webgl-attest-lib.ts:256-304`) sweeps `lib/ui/modules/**.svelte` only where `sourceCreatesWebglContext` holds. `ControlSurfaceCard.svelte` creates none, and neither def path is in `AUDIO_WEBGL_MODULE_DEFS` (`:67-70`). **Attest cost: zero** — provided the body stays DOM (matrixMix's stated reason for refusing a canvas, `MatrixMixGridBody.svelte:37-41`). |
| `module-manifest.ts` `DESCRIPTIONS` | **NO ENTRY** | correct, not a defect: the manifest globs `../audio/modules/*.ts` + `../video/modules/*.ts` and has **no meta glob** (`meta/module-registry.ts:75-84`). |
| `STRICT_DOCS` | **NO**, and **cannot be** | same note: there is deliberately **no `docs?` field on `MetaModuleDef`**, and adding one must re-point `module-annotate.spec.ts`'s "undocumented module" fixture (which is matrixMix) **in the same commit**. |
| `face-migration-inventory.ts:770-779` | `bespoke-surface`, `blockers: ['needs-note-entry-cell']` | §5.3 shows the blocker is **over-declared**, exactly as wave 6 §5.2 found for `archivist`/`peertube`. |
| `contract-lock.txt:724` | one line: `controlSurface meta domain=meta` | a face moves **nothing** — `face` is stripped by the attest normalizer and the contract has no ports or params to change. |

---

## 2. WHAT THE MODULE IS FOR

A **CONTROL SURFACE** is an abstract panel of **POINTERS** to other modules' controls. You
right-click any MIDI-assignable knob anywhere in the rack and choose *"Send to ⟨surface⟩"*;
a proxy for that control appears here, grouped under its source module behind a dotted
border and a module-name label.

Three properties make it more than a convenience view, and all three are load-bearing:

1. **Pointers, not copies.** A binding is `{ moduleId, paramId, name?, controlType? }`
   (`graph/control-surface.ts:31-45`) and nothing else. The proxy reads and writes the
   SOURCE node's live param through `resolveSurfaceParam`, and is keyed for MIDI by the
   same `moduleId:paramId` — *"so a MIDI assignment on the proxy IS the assignment on the
   source, the same control can live on multiple surfaces, and there is no per-proxy state
   that can drift"* (`:6-16`).
2. **It reaches into COLLAPSED modules.** *"Because the source node stays present + live in
   `patch.nodes` even when it is collapsed inside a Group, proxied controls keep working
   when the underlying module is folded away — which is the whole point"* (`:18-21`). This
   is the module's stated reason to exist.
3. **The colour stripe is PASSTHROUGH, never stored.** Each proxy carries a thin stripe of
   the SOURCE module's control colour, read live through `resolveControlColor(sourceNode)`
   on every ydoc tick (`ControlSurfaceCard.svelte:167-170`). *"The surface NEVER stores the
   colour"* (`meta/modules/control-surface.ts:12-17`).

And it is **a mini-graph of itself**: a lock/unlock button freezes or frees the group boxes,
and unlocked they are dragged into place with positions persisted to `data.layout`
(`:6-9`, and `ControlSurfaceCard.svelte:229-249`).

**The verb is REACH.** Not *configure*, not *browse* — you laid the board out so your hand
would find the right knob without hunting the canvas. That is what §3 measures against.

---

## 3. STOP 1 / STOP 2 — the parity census

### 3.1 Every affordance the card carries today

```sh
flox activate -- git show origin/main:packages/web/src/lib/ui/modules/ControlSurfaceCard.svelte
```

| # | affordance | site | survives promotion? |
|---|---|---|---|
| 1 | `<ModuleTitle defaultLabel="CONTROL SURFACE" inline>` — rename + control-colour dot | `:275` | ✅ the shell's own title bar |
| 2 | **LOCK / UNLOCK toggle**, `aria-pressed`, `data-testid="control-surface-lock"` | `:276-286` | ✅ a `ShellToggleCell` over `data.locked` (§4) |
| 3 | the EMPTY-STATE prompt (`Right-click a control → "Send to …"`) | `:289-293` | ⚠ text — §5 row 3 |
| 4 | per-source **GROUP BOX**, `role="group"`, `aria-label={`${g.label} controls`}`, dotted border | `:308-322` | ✅ body |
| 5 | the group's **module-name label** | `:323` | ✅ body — a SECTION LABEL |
| 6 | the **passthrough colour stripe** per proxy | `:341-346` | ✅ body |
| 7 | the proxied **`<Knob>`** — `min`/`max`/`defaultValue`/`units`/`curve` all read off the SOURCE `ParamDef`, `onchange` writing the source | `:347-359` | ✅ body — and it must stay a real `<Knob>`, rows 8-10 depend on it |
| 8 | per-proxy **right-click** → MIDI learn / *Remove from ⟨surface⟩* | inherited from `Knob.svelte` | ✅ inherited |
| 9 | per-proxy drag / dbl-click-to-default / wheel / MIDI badge | inherited | ✅ inherited |
| 10 | the proxy **caption** (`c.label` — custom name, else the source param label) | `:360` | ✅ body — §5.2 settles the authorship question |
| 11 | **rename `<input maxlength="14">`**, Enter commits / Escape cancels / blur commits | `:362-378` | ⚠ the declared blocker — §5.3 clears it |
| 12 | the rename **✎ button**, unlocked only | `:379-391` | ✅ body |
| 13 | **DRAG-TO-ARRANGE** the group boxes when unlocked (`pointerdown`/`move`/`up`, persisted to `data.layout`) | `:229-249`, `:319` | ⛔ **see §3.2** |
| 14 | the auto-prune `$effect` (drops bindings whose source vanished) | `:80-87` | ✅ moves with the body — ⚠ and it MUST, or a deleted module's binding lingers and *"the next Electra flash would emit a dead control"* (`:74-79`) |
| 15 | `PatchPanel` | **absent** — zero ports | correct; `modules-card-map.test.ts` permits it via a `portCount > 0` guard |
| — | **THE WHOLE FIELD, ON THE CANVAS, AT REST** | the card IS the lane render | ⛔ **THE PARITY LOSS** — §3.2 |

### 3.2 ⚠ THE LOSS, MEASURED

**What is lost is not an affordance — it is a TIER.** Rows 4-12 all survive, in the dock
full view. Row 13 (drag-to-arrange) survives there too, and §7 places it. What does not
survive is that **the field is on the canvas**.

The measurement:

| quantity | value | source |
|---|---|---|
| a faced lane tile | **192 × 180 px**, uniform at every zoom | `module-shell-model.ts:39,55`; `Canvas.svelte:625` (*"at EVERY zoom — the LOD tier swaps only the …"*) |
| one binding group box | **`BOX_W` = 14 + 2·76 + 8 = 174 px** wide | `control-surface-layout.ts:47-79` (`KNOB_CELL_W=76`, `KNOBS_PER_ROW=2`, `KNOB_GRID_GAP=8`, `BOX_PAD_X=14`) |
| …and, for a 2-knob group | `BOX_PAD_Y 12 + LABEL_H 18 + KNOB_ROW_H 94` = **124 px** tall | `:60-64`, `:82-88` |
| today's card | `width: max-content; min-width: 360px; max-width: 760px` | `ControlSurfaceCard.svelte:407-411` |
| …so today's canvas card holds | up to **4 group columns** (`10+174+12+174+12+174+12+174+10 = 752 ≤ 760`) before it must grow past its own max-width | derived from the two rows above |

**A 192 px tile cannot hold one 174 px box plus the shell's own chrome**, and there is no
slot that could try: `fullViewBody` is **dock-only by `dockFullViewHeadPlan`**
(`matrixmix/shell-extension.ts:53-58`, *"a 192 px lane tile cannot carry a module
surface"*), and the `glyph` slot's props carry **no `nodeId`**, so every instance of a
module draws the identical glyph — a per-node binding set is unreachable through it.

So promotion trades **"four columns of live knobs, always visible, on the canvas"** for
**"a 192 px tile and a dock open"**, on a module whose stated purpose is that the knobs are
reachable when their modules are folded away. **That is a tier loss on a performance
gesture, and it is #1974's exact shape.**

⚠ **The counter-argument, stated and rejected.** *"Every affordance is still REACHABLE, so
it is a relocation, like wave 5's chromaconsole sentence."* Reachability is the wrong test
here, and #1974 is the proof: `joystick`'s pad is also reachable in the dock, and it was
refused anyway. The gesture *"glance at the canvas and turn the knob"* and the gesture
*"open the dock, then turn the knob"* are different gestures, and a module built so you do
not have to hunt is defeated by making you hunt.

---

## 4. THE FACE — what to build the day §12 lands

```ts
// packages/web/src/lib/meta/modules/control-surface.ts
controlFamilies: [
  { id: 'cs-lock', label: 'Lock', kind: 'other', testidPrefix: 'control-surface-lock' },
],
face: {
  glyph: 'none',            // no `audio` output exists → `primaryAudioOutPortId` is null
  order: ['cs-lock-{n}'],   // ONE cell. Nothing is padded.
  extension: 'controlSurface',
},
```

Four points, each argued:

* **`glyph: 'none'` is the only literal that compiles into a green run.** `laneGlyphFor`
  returns `'picture'` only for `domain === 'video'`; every live glyph resolves through
  `primaryAudioOutPortId`, which is `outputs.find(o => o.type === 'audio')?.id`
  (`mandelbulb-glyph-tap.test.ts:32`) and this def has **no outputs at all**, so a `scope`
  / `meter` / `waveform` glyph resolves to `{kind:'static'}` — a dead glyph
  `module-face-lint` reddens unconditionally. Same derivation matrixMix records
  (`meta/modules/matrixmix.ts:92-97`).

* **`order` is ONE key, and it is the LOCK.** A meta def declares `params: []` **by
  construction**, so *"every key its `face.order` can ever hold is a NON-param key"* and
  `module-face-lint` legitimizes exactly two forms: a `<familyId>-{n}` template whose prefix
  is a DECLARED family, or a committed `<type>.legend.json` entry
  (`meta/module-registry.ts:88-101`). `data.locked` is a real, per-node, synced boolean with
  a real mutator (`setSurfaceLocked`, `graph/control-surface.ts:240-244`) — so it is an
  honest cell, not a decoration.

* **`order: []` is refused, and matrixMix already argued why.** *"A face that ranks nothing
  is LEGAL … but it paints a BLANK lane tile — strictly worse than the placeholder it
  replaces, which at least announces that a real surface is one click away"*
  (`meta/modules/matrixmix.ts:80-84`). ⚠ **Here it is worse still**, because this module
  does not currently render a placeholder — it renders the whole card.

* **NO TAB RAIL.** One cell is one band against `DOCK_TAB_MIN_BANDS = 7`
  (`module-faceplates.md:150`). Nothing is padded, and `face.tabbed` is owner-instruction
  only.

⚠ **`module-face-lint`'s completeness check is VACUOUS on this module** and that must be
said rather than relied on: it loops `def.params`, which is `[]`. A green run proves
nothing about this face. **The gate that carries it is the bespoke source test in §10.5**,
the `midiclock-face-model.test.ts` / `matrixmix-face-model.test.ts` pattern.

---

## 5. RESTING TEXT — the census, and the wave's new question

Permitted resting text, exhaustively: module NAME, TAB/SECTION labels, CONTROL CAPTIONS,
and option/landmark NAMES that disambiguate a control's own position.

| # | painted today | site | verdict | what carries it after |
|---|---|---|---|---|
| 1 | `🔒 Locked` / `🔓 Unlocked` on the lock button | `:285` | ⛔ **REFUSED AS WRITTEN.** A caption that CHANGES with state is the shape `StatusLed` was built to make inexpressible — *"a caller cannot smuggle a measurement through `lit ? 'LATE 3' : 'OK'`"* (wave 6 README §4.1). | a `ShellToggleCell` with the **static** caption `LOCK`, whose on/off is the toggle's own visual state. The words `Locked`/`Unlocked` go to `aria-label`. |
| 2 | the group's module-name label (`{g.label}`) | `:323` | ✅ **KEEP** — a SECTION LABEL, and the ONLY thing separating two boxes of otherwise-identical dials. This is `tidyVco`'s `A`/`D`/`S`/`R` argument exactly. | — |
| 3 | the EMPTY-STATE prompt, `Right-click a control → "Send to ⟨name⟩"` | `:290-292` | ✅ **KEEP.** `midiclock`'s shipped precedent, by name: *"THE PRE-CONNECT HINT — instructional copy in an EMPTY state, and the empty state is the whole content of the plate before a grant"* (`MidiclockDeviceBody.svelte:22-25`). ⚠ But it must lose the interpolated `{name}` — a surface's own user-typed name inside the sentence makes the sentence derived. Print `Send to this surface`. | — |
| 4 | the proxy CAPTION (`{c.label}`) | `:360` | ✅ **KEEP** — §5.2. |
| 5 | `title=` on the knob cell (`… — right-click for "Remove from ⟨surface⟩"`) | `:337` | ⛔ **REMOVED as a hover string** — *"there but hidden"* is refused by name. | `aria-label` on the cell, carrying the same sentence. |
| 6 | `title=` on the ✎ button (`Rename "…" for the Electra`) | `:377` | ⛔ same | `aria-label={`Rename ${c.label}`}` — which the card **already sets** (`:378`). |
| 7 | any VALUE readout under a proxy | **none today** | ✅ nothing to remove — the card never printed one. ⚠ And it stays that way for free: `paintsReadout(vocab)` requires a named roster and no declared `format`, so a bare `min..max linear` proxied param has no readout to paint. | — |

**Deleting row 1 deletes no finding**: "am I locked?" is answerable from the toggle's own
lit state, and from whether the boxes drag — which is the state itself, not a report of it.

### 5.1 ⚠ THE `aria-label` HAZARD, checked against the leg that owns it

`face-rack-status-source.test.ts:826-860` — *"A CONTROL GRID'S SENTENCE IS SPEAKABLE, NOT
PAINTED"* — refuses any `aria-label={EXPR}` whose **same expression** is also rendered as
a bare text node (`>{EXPR}`).

This body paints `{g.label}` (row 2) and `{c.label}` (row 4) as text nodes. So **neither
may be the whole of any `aria-label` expression.** The design:

```svelte
<div class="cs-group" role="group" aria-label={groupSentence(g)}>       <!-- not {g.label} -->
  <div class="cs-group-label">{g.label}</div>
  …
  <div class="cs-knob" aria-label={proxySentence(g, c)}>                <!-- not {c.label} -->
    <Knob … label={c.label} />
    <div class="cs-knob-cap">{c.label}</div>
```

with `proxySentence` returning e.g. `ATTACK on ADSR 1 — proxied control; turning it writes
the source module's live parameter. Right-click to remove from this surface.`

⚠ **The gate cannot check this and I am saying so rather than implying coverage.** Its
predicate is expression IDENTITY, not string containment — an author who wrote
`aria-label={c.label}` beside `>{c.label}<` is caught; one who wrote
`aria-label={c.label + ' control'}` is not. **The compliance argument here rests on the
sentence genuinely differing in content, and the only thing that can see it is a human
reading the dock PNG** — the same blind spot the roster's own header concedes for canvas
text (`:47-60`).

⚠ Today's card already sets `aria-label={`${g.label} controls`}` (`:315`), which would
NOT trip the regex (different expression) but is also not a sentence. It should become one.

### 5.2 ⚠ **A USER-AUTHORED NAME IS A CAPTION. SETTLED, NOT ESCALATED.**

This is the genuinely new case the brief flagged, and it resolves cleanly on a
discriminator that reproduces every settled case in the fleet.

**The question.** `c.label` is `custom.length > 0 ? custom : baseLabel`
(`ControlSurfaceCard.svelte:153-157`) — the user's typed name if they set one, else the
source `ParamDef.label`. Is the user-typed branch permitted resting text?

**The answer: YES, and the reason is that AUTHORSHIP IS NOT A DIMENSION THE RULING RANGES
OVER.** The permitted list is keyed on the text's **ROLE** (module name / section label /
control caption / option name) and its **POSITION** (inside the control it names). It says
nothing about who typed the string, because nothing in the rule's purpose depends on that:
the refused class is text that RESTATES A VALUE, and a name restates nothing.

**Three checks, all of which the discriminator must pass to be worth writing down:**

1. **It reproduces the settled cases.** A `def.label` caption is permitted; a `NOTE 64`
   readout is not; an option NAME inside the control that selects it is permitted; a
   "now bound: Launchpad Mini MK3" line outside every control is not. Role-and-position
   separates all four. Authorship separates none of them.
2. **The alternative rule has a shipped counter-example.** If "a caption is permitted only
   when the APP authored it", then the **user-renamed MODULE NAME** in every faceplate's
   title bar is a violation — and it is not, on any of the ~300 faced modules.
   `ModuleTitle` reads `node.data.name`; `resolveDisplayName`
   (`$lib/multiplayer/module-naming`) is imported by `MatrixMixGridBody.svelte:48` to paint
   exactly that in a shipped `fullViewBody`. **A user-typed module name is permitted AS the
   module name. A user-typed control name is permitted AS the control caption, by the
   identical argument one level down.**
3. **It is invariant to every control's value.** Turning any knob on the surface, or on any
   source module, changes none of these strings. That is the property the refused class
   never has.

**So: the proxy caption stays, custom or not.** No escalation, no exemption, no new
mechanism.

⚠ **The edge this does NOT settle, named so nobody thinks it did:** a user-typed string
that is *itself* a measurement (someone renames a proxy `0.42`). The ruling has no defence
against a user deliberately writing a number into a name field, and it should not try —
that is the user's own document, exactly as a sticky note is.

### 5.3 ⚠⚠ **THE TYPED-ENTRY GATE — AUTHORING A `face` ON THIS MODULE IS RED, AND WAVE 6's PRESCRIPTION DOES NOT FIX IT**

**This is the second blocker, it is independent of §3.2's parity blocker, and no previous
wave listed it.** Measured by the orchestrator, and every citation re-verified here against
`origin/main`.

`packages/web/src/lib/ui/workflow/face-migration-inventory.test.ts` has **three interlocking
legs**, and `controlSurface` trips the third:

1. **`:229` — *"every def that DECLARES a `face` is dispositioned generic-face"***
   (`allDefs().filter(d => d.face).filter(d => inventoryEntry(d.type)?.disposition !== 'generic-face')`,
   `toEqual([])`, on the stated ground that *"a module cannot be 'needs a bespoke surface' and
   ship a curated face at the same time"*). **So authoring a `face` FORCES the entry to
   `generic-face`.**
2. **`:268-281` — *"no generic-face entry names any blocker"***
   (`'generic-face' cannot be waiting on a capability`). **So `blockers: ['needs-note-entry-cell']`
   must be emptied in the same commit.**
3. **`:226-248` — the TYPED-ENTRY leg**, verbatim:

```ts
if (!mountsTypedEntry(tmpl)) continue;
const entry = inventoryEntry(type);
if (!entry) continue;
if (entry.disposition === 'generic-face') {
  offenders.push(`${type}: dispositioned generic-face, but its card mounts typed entry — the face system has no text cell (card-primitive-parity: NoteEntry via:none)`);
  continue;                                    // ⚠ BEFORE migrationBlockers is ever read
}
if (entry.disposition === 'organizational-native') continue;
if (!migrationBlockers(entry).includes('needs-note-entry-cell')) { … }
```

**Read the control flow.** The `generic-face` branch pushes an offender and **`continue`s
before the code reaches `migrationBlockers(entry)`**. So (1) forces `generic-face`, and (3)
reddens on `generic-face` + typed entry — **and emptying the blockers array, which (2)
requires anyway, changes nothing**, because that is the branch below the one that fires.

⚠ **The scan's subject is the LEGACY CARD, which promotion does not remove.** `templates`
comes from `cardTemplates()` (`:153-170`) over `cardTemplate()` (`:126-133`), i.e. the
rendered markup of `ControlSurfaceCard.svelte` with script/style/comments stripped. That card
is what `?shell=legacy` renders and it survives promotion, so `<input type="text">` at
`:364-376` stays in scan range forever.

#### ⚠ THIS OVERTURNS WAVE 6 §5.2's PRESCRIPTION — say so loudly

Wave 6's **reasoning** is correct and is not disturbed: the blocker's capability text is
scoped to **CELLS**; a `fullViewBody` is a **SLOT**, satisfies no cell contract, needs no
probe, and can carry an `<input>` today (`matrixmix/shell-extension.ts:14-31` draws the same
boundary from the other side — what a `panel` CELL requires is *"neither"* required of a
body). **Wave 6's REMEDY — "drop the blocker from the `blockers` array when the face lands" —
is necessary and NOT SUFFICIENT**, because the leg that reddens never reads that array.

**Wave 6 could not have seen this**, and the reason is the interesting part: all three
modules promoted since the extension slot shipped — `midiclock`, `kria`, `matrixMix` — have
**clean cards**, so this leg has never fired. Its four positive controls (`sequencer`,
`drumseqz`, `sticky`, `textmarquee`) all still fire, so the scan is live and not vacuous.

#### ⚠ THE BLIND-GATE SHAPE, and it is inside ONE FILE disagreeing with itself

The same file makes the **blocker's own liveness probe** read a *different artifact*:
`:346` is `faceShellMountsTypedEntry: mountsTypedEntry(moduleShellTemplate())`, over
**`ModuleShell.svelte`** — *"the ONE renderer every face cell is painted by"* (`:332-334`).

So within one file: the **blocker's** subject is the shared face RENDERER, the **disposition
leg's** subject is the LEGACY CARD, **and a `fullViewBody` is neither.** The subject was
quietly redefined when #1512 shipped the extension slot and neither leg was revisited. That is
CLAUDE.md's *"a filter applied before the check that quietly redefined the check's subject"*,
sitting in the file that exists to prevent it.

#### The measured split — and `gamepad` is CLEAN

| mounts typed entry | clean |
|---|---|
| **`ControlSurfaceCard`** (`input:text`), `MidiLaneCard` (`input:number`), `ArchivistCard` / `PeerTubeCard` / `RecorderboxCard` (`input:text` — **all three of wave 6's targets**) | **`GamepadCard`**, `Es9Card`, `OutToLaunchCard`, `LaunchpadControlCard`, `Push2ControlCard`, `MidiclockCard`, `KriaCard`, `MatrixMixCard` |

⚠ **The asymmetry inside this agent's own pair is worth stating: this is a `controlSurface`-only
problem.** `gamepad` mounts a `<select>` and an `<input type="file">`, neither of which is
typed entry, so its face is unaffected by any of this. **Two modules, one cohort, one shared
"table of pointers" design problem — and one of them cannot be promoted without an owner
decision the other never encounters.**

#### ⚠ NOT RESOLVED HERE — escalated, and the fourth route is named to REFUSE it

All three routes cost something a standing ruling protects:

| route | cost |
|---|---|
| (a) strip the `<input>` from `ControlSurfaceCard.svelte` | a **functional-parity cost on `?shell=legacy`** — the rename gesture disappears from the surface the escape hatch promises is verbatim |
| (b) narrow the leg's subject to what the FACE renders | **the no-CI-changes ruling** (2026-08-23) — never add or alter gates |
| (c) do not promote | already this spec's verdict for an independent reason (§3.2) |
| ⛔ (d) re-disposition to `organizational-native` to dodge it | **REFUSED BY NAME.** The leg skips that bucket at `:522` (*"the text IS the object"*), so this would be a green gate certifying nothing — the exact class CLAUDE.md warns about, chosen deliberately. **Do not do this.** |

Escalated to the owner in the cohort doc (`SURFACES.md §9.1`). **The face design in §4-§9 is
identical whichever way it goes — only the PR's file list changes**, so nothing above or
below this section is contingent on the answer.

### 5.4 ⚠ WAVE 6's FIRST-OF-KIND FLAG: **STILL TRUE, AND NOW SHARPER** (measured; the first measurement was VACUOUS)

Wave 6 flagged that *"no existing `fullViewBody` in the tree contains a text input."*
**matrixMix did not change that.** Measured:

```sh
flox activate -- git grep -l -E "<input|<textarea|contenteditable" origin/main -- "packages/web/src/lib/ui/modules/*/*.svelte"
# → cube/CubeTableStackPanel.svelte   dx7/Dx7OpDetail.svelte   picturebox/PictureboxAssetsBody.svelte
# POSITIVE CONTROL: 63 of the 78 files in that glob contain "<button".
```

⚠ **INSTRUMENT NOTE — my first attempt at this returned a clean, plausible, WRONG answer.**
I resolved each `fullViewBody`'s component by parsing the `import … from './X.svelte'` line
out of `shell-extension.ts` in shell. It resolved **0 of 67** files (a `\x27` quoting bug in
the extraction truncated every path) and reported *"no hits"* — an empty scan wearing the
shape of a negative result. Caught only by adding the resolve-count and the `<button>
positive control shown above. That is CLAUDE.md's *"a filter applied before the check that
quietly redefined the check's subject"*, at first hand.

**Classified:**

| file | slot | input |
|---|---|---|
| `picturebox/PictureboxAssetsBody.svelte:269,291` | ✅ a real `fullViewBody` (`picturebox/shell-extension.ts:36`) | `<input type="file">` |
| `dx7/Dx7OpDetail.svelte:110-112` | ❌ **NOT** a body — dx7's extension fills `glyph` only (`dx7/shell-extension.ts:20`); this component is mounted from `shell-cells.ts:897` as a PANEL | `<input type="text">` |
| `cube/CubeTableStackPanel.svelte:169` | ❌ not a body — `cube` has no `shell-extension.ts` at all | `<input type="file">` |

**So the claim survives in a strictly more useful form, and it lowers the risk:**

* an `<input>` element in a `fullViewBody` is **already shipped** (picturebox);
* an `<input type="text">` in a shell-rendered module component is **already shipped**
  (dx7's panel);
* only the **intersection** — a text input in a `fullViewBody` — is unprecedented.

First-of-kind, legal, ungated. Expect review attention; expect no gate to fire.

---

## 6. WIDTH — **NOT EARNED. NO EXEMPTION ENTRY.**

> ⚠ **WHICH SIDE OF THE SPLIT, STATED BEFORE THE WIDTH ARGUMENT.** `controlSurface` **IS
> IN** `NON_SHELL_LANE_TYPES` (`legacy-fallback.ts:114`), so `laneRenderKind` returns
> `'legacy'`, it keeps its verbatim card in the lane and **has no shell lane tile at
> all** — a face for it is a **DOCK-ONLY face**, and "promotion" here MEANS removing it
> from that set (§3.2 is why that is the refusal). **The consequence for the
> compact-versus-caption tradeoff: with no lane tile there is no section-heading-versus-
> caption question to make, which is exactly why `face.bareCells` is dock-only.** So the
> group's module-name label (§5 row 2) is not competing with anything for a tier that
> does not render it, and the width argument below is about the DOCK pane only.

The instrument: `workflow-shell-faces.spec.ts` measures `bodyW - contentW` against
`FACE_WIDTH_SLACK_MAX_PX = 40` (`:224`, `:440-453`), where `bodyW` is `.faceplate-body`'s
own box and `contentW` is the ink inside it. `PLATE_FLOOR_EXEMPTIONS` in
`face-width-source.test.ts:88` is **`[]`** — the 900 px floor is gone and there is no plate
hatch left to reach for.

### 6.1 The measurement, and why the body scrolls instead of growing

| state | ink | what a naive port would reserve |
|---|---|---|
| fresh spawn (**what the dock baseline captures**) | the empty-state sentence, ~44 chars at 0.72 rem ≈ **250 px** | the card's `min-width: 360px` floor ⇒ **~110 px of slack**, well past the 40 px ceiling |
| 1 group | **174 px** | — |
| 2 groups | `10+174+12+174+10` = **380 px** | — |
| 4 groups (the card's own ceiling) | **752 px** | — |
| N groups | unbounded — the card sets `overflow: visible` and grows past its `max-width: 760px` | — |

**So the design is matrixMix's, and it is the component's own layout rather than a plate
override:** the body wraps its group field in a `max-width: 600px; max-height: 320px;
overflow: auto` scroll box, exactly `.mm-grid-scroll`
(`MatrixMixGridBody.svelte:262-276`). matrixMix's header states why that is not a hatch:

> *"`face-width-source.test.ts` denies a `max-width` on `.faceplate-body` and denies
> per-occupant `:has(...)` overrides outright — correctly, because a clamp CLIPS a wide face
> where a scroll REVEALS it. This is a component's own internal layout … the plate sizes to
> its content, and the grid scrolls inside a fixed box exactly as it always has."*
> (`:29-35`)

matrixMix carries **no** `FACE_WIDTH_EXEMPTIONS` entry and passes; this body has the same
shape, so neither does this one. ⚠ And the empty state — the state the baseline photographs
— must **not** carry a `min-width` floor; the dashed prompt sizes to its own sentence.

### 6.2 ⚠ THE VRT EXEMPTION IS matrixMix's OVERTURNED ARGUMENT, VERBATIM IN STRUCTURE

`vrt-exemptions.ts:639`:

> `controlSurface: 'content is binding-dependent (proxied controls vary by patch); empty state is a blank square. …'`

Two clauses. **The first is TRUE and stays true** — the proxy field is a function of other
nodes, and a solo spawn has none. **The second is the conclusion matrixMix falsified**,
`:645-652`:

> *"A solo-spawned matrixMix is a stable, deterministic, entirely module-specific picture …
> and it is the state every player meets first. 'No stable pixels' described the surface
> that ISN'T rendered and drew a conclusion about the one that is."*

A freshly spawned `controlSurface` renders, deterministically and specifically: the title
`CONTROL SURFACE`, the lock button, and the dashed empty-state box with its prompt
(`ControlSurfaceCard.svelte:274-293`). **"A blank square" is false about the thing that
paints.** It is the identical error, on the entry sitting five lines above matrixMix's own
correction.

⚠ **AND THIS ENTRY IS THE ROOT OF A BY-REFERENCE CHAIN**, which the brief asked about and
the file has already had to repair once:

* `:686` — `launchpadControlLeft: '… like controlSurface/electraControl'`
* `:687` — `push2Control: '… like launchpadControlLeft/electraControl'`
* `:680-685` — the file's **own** correction note: *"THIS LINE USED TO SAY
  'controlSurface/matrixMix' AND matrixMix IS DRAINED. Corrected here rather than left to
  read as company: matrixMix's exemption rested on a solo spawn having no stable pixels,
  which stopped being true; THIS one rests on the body being DEVICE-dependent … Those are
  different arguments and only one of them was overturned."*

**So the answer to "what does draining `controlSurface` do to its dependents" is already
written in the file, and it is: NOTHING, provided the same repair is made.**
`launchpadControlLeft`'s exemption rests on **device-dependence** (a Pair/Bind state and a
status line that need hardware CI does not have). `controlSurface`'s rests on
**binding-dependence** — and §0 proves it has no device at all, so it never shared
`launchpadControlLeft`'s ground in the first place. **Draining `controlSurface` costs its
dependents nothing but the same one-line edit `matrixMix`'s drain cost them.**

⚠ **This is a drain that can and should happen INDEPENDENTLY of any face** — see §13.1.

### 6.3 ⚠⚠ **THE DRAIN LINE** — what makes `controlSurface` drainable from `ALLOWED_PERMANENT_EXEMPT`

> **`controlSurface` IS DRAINABLE TODAY, WITH NO FACE AND NO DESIGN WORK, because its
> exemption concedes the drainable half in its own words.** The device-INDEPENDENT part
> of this module is **all of it** (§0: there is no device), and the patch-INDEPENDENT
> part is the **fresh-spawn empty state** — a title, a lock button and a dashed prompt,
> every pixel a function of the code — which is the state a VRT scene produces by
> construction, since the scene controls the spawned patch and a solo spawn has no
> bindings. `:639` already says *"empty state is a blank square"*; the word "blank" is
> the only false thing in the sentence. **No `FACES_WITHOUT_SCENES` entry is warranted
> or acceptable here.**

"Permanent" on this entry means UNDRAINED, not undrainable — `midiclock` was drained from
`ALLOWED_PERMANENT_EXEMPT` on 2026-08-24 (`vrt-exemptions.ts:1217-1222`, the second drain
ever, after `cvBuddy`), and matrixMix before it (`:1209-1212`). The set's own header says
it *"only ever SHRINKS BY NAME"* and that membership *"records that a module was exempt on
the day the brake landed — nothing more"* (quoted at `:654-657`). This is the third name it
should shrink by.

---

## 7. THE BODY — role, `why`, and what it draws

**Role: `control-grid`.** Verified against the live predicate
(`face-rack-status-source.test.ts:598-606`):

```
'control-grid': holds: (src, extId) => /aria-label=/.test(src) && !paintsCanvas(src, extId)
```

The body sets `aria-label` on every group and every proxy cell (§5.1) ✅ and mounts no
`<canvas>` ✅. It is not `picture` (no canvas) and not `status-primitive` (no `StatusLed`
and nothing to lamp).

**The `why` string, AS IT WOULD BE COMMITTED** into `EXTENSION_BODY_ROLES`:

> `controlSurface: { role: 'control-grid', why: 'the PROXY BOARD — a field of live <Knob> POINTERS at other modules\' params, grouped per source module behind a dotted box, dragged into place while UNLOCKED and renamed in situ. ⚠ IT IS A CONTROL GRID, NOT A PICTURE: turning a dial here writes the SOURCE node\'s param through resolveSurfaceParam, so the surface is what the rack is operated FROM — and it mounts no canvas and must not grow one, since WebGL attest basis membership is derived from CONTENT and a GL body would enrol a meta module in the GPU attest. ⚠ ALL PAINTED TEXT IS A NAME: one SECTION LABEL per group (the source module\'s display name — the only thing separating two boxes of identical dials) and one CONTROL CAPTION per proxy. The caption may be USER-TYPED and that changes nothing: the ruling ranges over a text\'s ROLE and POSITION, never its author, which is the same reason a user-renamed MODULE name is permitted in the title bar. No value, no measurement, no state word — the lock caption is the static literal LOCK and its state is the toggle\'s own picture. ⚠ THE SEMANTICS LIVE ON aria-label: a dial cannot say "this writes ADSR 1\'s ATTACK; right-click to remove it", so that sentence is the accessible name and never a text node. ⚠ IT IS A BODY RATHER THAN A PANEL for two mechanical reasons: ShellPanelCell REQUIRES a minWidth NUMBER and this field is one group box or twelve depending on how many controls the player has sent (any number would be a fiction in a required field), and the required probe vocabulary is data/data-rev/text while this surface\'s observable is a param on ANOTHER node — neither this node\'s data nor its text. ⚠ IT CARRIES A TEXT <input> (the 14-char rename, Enter commits / Escape cancels), which is legal on a SLOT and unprecedented in this roster; picturebox\'s body already carries a file input and dx7\'s PANEL already carries a text one, so only the intersection is new. ⚠ NO SCREEN SWITCH and NO WATCH MARK: the video-screen ruling runs over STRICT_FACES INTERSECT video defs and this is domain meta, and markWatched is a VideoEngine pull-set concept this module has no part in.' }`

### 7.1 Where LOCK/UNLOCK and drag-to-arrange go

**LOCK is a ranked CELL, not a body button** — a `ShellToggleCell` over `data.locked`, which
is what puts it in the lane tile (§4). **Drag-to-arrange stays in the body**, gated on the
same `locked` flag, with `data.layout` unchanged.

⚠ **The pointer plumbing must come across.** The card wraps each knob cell in
`onpointerdown={(e) => e.stopPropagation()}` (`:335`) purely *"to stop the XYFlow canvas
drag so the control inside receives the gesture"*. **The dock drawer is not the XYFlow
canvas**, so that guard is probably unnecessary there and harmful nowhere — MUST-VERIFY
§15.2. Do not drop it without measuring; `electraControl`'s spec flagged the identical
question and reached the same instruction.

⚠ **And drag-to-arrange inside a SCROLL BOX is a real interaction question** (§6.1 puts the
field in a 600×320 `overflow: auto` box). Dragging a box toward the edge does not
auto-scroll, and `onPointerMove` clamps only at zero (`Math.max(0, …)`, `:239-240`), so a
box can be dragged to a coordinate the scroll box will reveal but the pointer cannot reach
in one gesture. **The honest v1 is to keep the layout write as-is and let the scroll box
reveal it**; auto-scroll-on-drag is a separate, small improvement and is NOT this PR.

---

## 8. STATE — the `.data` census (continuing wave 5 §4 / wave 6's per-CALL-SITE correction)

Wave 6 established the census must be **per CALL SITE, not per module**. Measured here:

| call site | transacted? | `LOCAL_ORIGIN`? | in place? |
|---|---|---|---|
| `addBindingToSurface` (`graph/control-surface.ts:191-206`) | ✅ | ✅ | ✅ `push` |
| `removeBindingFromSurface` (`:208-215`) | ✅ | ✅ | ✅ `splice` |
| `setBindingName` (`:220-240`) | ✅ | ✅ | ✅ single key |
| `addScreenToSurface` (`:242-249`) | ✅ | ✅ | ✅ |
| `removeScreenFromSurface` (`:251-258`) | ✅ | ✅ | ✅ |
| `setSurfaceLocked` (`:260-264`) | ✅ | ✅ | ✅ |
| `setSurfaceGroupPosition` (`:266-271`) | ✅ | ✅ | ✅ single key |

**Every one goes through ONE chokepoint** — `mutateSurface` is
`ydoc.transact(() => { … }, LOCAL_ORIGIN)` (`:175-183`) — and there is **no bare proxy
write anywhere in the module or its card.**

⚠ **This is the CLEANEST module the running census has measured**, and it is worth saying
loudly against wave 6 §9's ledger, which found bare writes in `recorderbox` (all three),
`tvLibrarian`, `archivist` and `videobox`. `controlSurface` is the counter-example that
shows the discipline is achievable with a single mutator function, and **`electra-control.ts`
copied it deliberately** (`graph/electra-control.ts:5`, *"A sibling of control-surface.ts"*;
`:222`, *"See control-surface.ts:163-173"*).

⚠ **And the in-place rule is not style — it is a shipped crash.** The file's own CRITICAL
note (`:165-173`): spreading the live array *"re-integrates the already-integrated Y type
and Yjs throws 'Type already integrated' — which is exactly why a SECOND send-to-surface
broke the whole surface."* **Any body that rebuilds `data.bindings` is a shipped crash**,
and the regression is a named unit leg (`control-surface-ydoc.test.ts:43-65`).

**Does this break the generic face path?** No. Nothing here is a param, so
`shell-param-writes` never sees it; the LOCK cell's `onchange` calls `setSurfaceLocked`
directly, the way matrixMix's axis cells call `matrixmixSetXAxis`
(`shell-cells.ts:2036-2050`).

---

## 9. LANE TILE AT 1/8 SIZE

**Today: there is no lane tile.** `controlSurface` is a `NON_SHELL_LANE_TYPES` snowflake, so
`laneRenderKind` returns `'legacy'` and the canvas paints the **verbatim card**
(`_face-fixtures.ts:333-334`). Promotion means something different for this module than for
an ordinary one: it does not upgrade a placeholder, it **replaces a working surface**.

**After promotion (post-§12):** module name + one `LOCK` toggle cell + `glyph: 'none'`, in
192 × 180. `laneOrder` drops a declared `hero.cell` and each `xyPads` entry's `x` key; this
face declares neither, so the single cell survives to every tier
(`shell-cells.ts:2020-2027`). ⚠ **A one-cell face at the tightest tier is exactly what could
become the `joystick` shape**, which is why §10.5's bespoke model test must assert the cell
is PRESENT at every lane tier rather than that the face merely resolves — matrixMix's own
instruction, at that line.

---

## 10. THE FOUR GATES (plus SNAP)

| # | gate | file:line | this module |
|---|---|---|---|
| 1 | **face lints / `STRICT_FACES` promotion anchor** | `module-face-lint.test.ts`; `strict-faces.ts:10-15` (*"asserted EQUAL to the set of defs that declare a `face` … AUTHORING A `face` IS THE PROMOTION. There is no count"*) | authoring the `face` + adding the name in the same PR. ⚠ Completeness is VACUOUS (`params: []`) — §4. |
| 2 | **VRT baselines** | registered in `e2e/vrt/_shell-faces.ts:34` (`FACES`); Linux CI authors them; dispatch `task vrt:commit` | **3 files** — see §11. |
| 3 | **`EXTENSION_BODY_ROLES`** | `face-rack-status-source.test.ts:150` (roster), `:557-608` (`ROLE_PREDICATE`), `:784-797` (role verified not trusted), `:826-860` (the speakable leg) | `role: 'control-grid'`; `why` in §7; predicate satisfied (aria-label present, no canvas). ⚠ The role set is now a **SET IDENTITY** against `ROLE_PREDICATE`'s keys asserted both ways (`:810-827`) — **not** wave 6's hand-typed pair. Adding this entry moves nothing there, because `control-grid` is already used by matrixMix. |
| 4 | **`module-docs-lint` FAMILY↔CARD** | `module-docs-lint.test.ts:359-375` — *"every declared controlFamily.testidPrefix actually appears in the card source"* | `cs-lock`'s prefix is `control-surface-lock`, which **the card already emits** (`ControlSurfaceCard.svelte:280`). ✅ **Nothing to add.** ⚠ The honest fix for a miss is ADDING the testid, never dropping the family (`cs-clear-tail`, the four `twotracks-*`). |
| **5** | ⚠ **`face-migration-inventory.test.ts` — THE FIFTH GATE, and it BLOCKS** | `:229` (face ⇒ `generic-face`), `:268-281` (no blocker on `generic-face`), `:226-248` (typed entry ⇒ not `generic-face`) | **RED on this module, unresolvable by the PR alone — §5.3.** Listed as a gate in its own right because no previous wave listed it and three of wave 6's six targets are also caught by it. |
| + | **`optionsExhaustive` SNAP** | `param-vocabulary.test.ts` | **N/A** — zero params, so no options roster exists to snap. `snapToOptions` from `$lib/ui/controls/knob-vocabulary-model` is not reached. |

### 10.5 A FIFTH, BESPOKE gate this module must ship — because #1 is blind to it

`module-face-lint`'s completeness leg loops `def.params` and this def has none, so a green
run is not evidence. The face therefore ships `control-surface-face-model.test.ts`, the
`matrixmix-face-model.test.ts` / `midiclock-face-model.test.ts` pattern, asserting at source:

1. the `LOCK` cell resolves and is **PRESENT at every lane tier** (`lane`, `folded`,
   `compact`), not merely that the face resolves — §9's `joystick` guard;
2. `glyph === 'none'` **and** `primaryAudioOutPortId(controlSurfaceDef) === null`, so the
   literal is proved rather than asserted (the `mandelbulb-glyph-tap.test.ts:63-66` shape);
3. the body's `aria-label` expressions are disjoint from its painted text expressions —
   the sharper half of §5.1 that the shared leg's identity regex cannot reach;
4. a **negative control** in both directions: a fixture body with `aria-label={c.label}`
   beside `>{c.label}<` must be caught, and today's design must clear it.

---

## 11. COST TABLE

| cost | value | why |
|---|---|---|
| **WebGL attest** | **ZERO** | `resolveWebglBasis()` (`webgl-attest-lib.ts:256-304`) admits a `lib/ui/modules/**.svelte` file only when `sourceCreatesWebglContext` holds. A DOM body does not. ⚠ **Conditional on the body never mounting a WebGL context** — matrixMix's stated reason for staying a `<table>`. |
| **ART** | **ZERO** | no engine binding, no factory, no audio. `domain: 'meta'` is skipped by the reconciler. |
| **`contract-lock.txt`** | **ZERO** | `:724` is one line with no port or param rows. `face` and `controlFamilies` are stripped by `scripts/attest-code-basis.ts`; ⚠ but `controlFamilies` is **NOT** contract-transparent (`module-faceplates.md:601`) — run `task docs:accept` and review the diff. |
| **Push 2 card** (`push-card-config.ts`) | **ZERO** | no explicit entry, no params, nothing to re-rank. ⚠ The standing hazard (a card resolved from the LIVE def re-ranks itself when a param is added) cannot fire on a def with no params. |
| **docs / `STRICT_DOCS`** | **ZERO, and structurally so** | `MetaModuleDef` has no `docs?` field, deliberately; adding one must re-point `module-annotate.spec.ts`'s fixture in the same commit (`meta/module-registry.ts:75-84`). Not this PR. |
| **VRT files** | **3** | `face-controlSurface-compact.png` + `face-controlSurface-dock.png` (new scenes) **+ `controlSurface.png`** — draining `EXEMPT_FROM_VRT` enrols the **legacy card** via `vrt.spec.ts:51-54`'s `COVERED_MODULES = REGISTRY.filter(m => !(m.type in EXEMPT_FROM_VRT))`. ⚠ `midiclock` predicted 3 where its own spec had said 2 and was right; matrixMix's drain note says the same (`vrt-exemptions.ts:656-659`). **Sweeps joined: `vrt.spec.ts` (the card) + `workflow-shell-faces.spec.ts` (both face scenes).** `vrt-strict` only if the type is added to `STRICT_VRT_MODULES`, which it should not be (the dock scene mounts a body). |
| **deletions the PR must make** | `EXEMPT_FROM_VRT` `:639` **and** `ALLOWED_PERMANENT_EXEMPT` `:1213` | `vrt-meta.test.ts` asserts set equality **in both directions**, so a one-sided delete is RED (`vrt-exemptions.ts:653-655`). Plus the by-reference repair at `:686` (§6.2). |
| **CI wall-time** | two face scenes at `FACE_SCENE_BASE_MS = 90_000` bound + one card scene | ⚠ Over the ~2 min sign-off line in aggregate; flag it in the PR body per CLAUDE.md. |

---

## 12. ⚠ THE ONE PLATFORM CHANGE THAT LIFTS THE REFUSAL — and it serves FIVE other modules

**The ask: a LANE-TIER extension slot.** Name it `laneBody`. Same contract as
`fullViewBody` (`{ nodeId }`, module-owned, resolved through the existing non-eager glob),
rendered by `ModuleShell` at the `full` LOD tier only, inside a tile whose height the module
declares. It requires:

1. a `laneBody` key in `ShellExtension` and in `WIRED_SHELL_EXTENSION_SLOTS`
   (`shell-extensions.ts:124` — today `['glyph', 'fullViewBody']`);
2. a render site in `ModuleShell` at the `full` tier, and the `SHELL_TILE_H_SLOT` /
   `SHELL_TILE_W` uniformity relaxed for occupants that declare one
   (`module-shell-model.ts:39,55`; `Canvas.svelte:631-650`);
3. a new `EXTENSION_BODY_ROLES`-style scope note, since the roster's population is derived
   from `fullViewBody:` presence (`face-rack-status-source.test.ts:100-115`) and would go
   **blind to a `laneBody`** — the roster must widen or it silently stops covering the new
   slot. ⚠ **That third item is the one a PR would forget**, and it is the blind-gate shape.

**Who else it unblocks** — every `NON_SHELL_LANE_TYPES` member whose lane surface is a
per-node table: `controlSurface`, `electraControl`, `launchpadControlLeft`, `clipplayer`,
and (by the same argument) `push2Control`. That is **five modules** against one slot, which
is a materially better scheduling ratio than the capability wave 6 was sent to define and
found unnecessary.

⚠ **NOT PROPOSED AS PART OF ANY FACE PR.** Per the standing no-CI-changes and
no-new-issues rulings this is recorded here as the named blocker, for the owner to schedule
or refuse. Nothing in §4-§9 is wasted either way: the day it lands, the face above is what
gets built, and the day it does not, this document is why the module stayed on its card.

---

## 13. DEFECT LEDGER — live on `main`, independent of any face

1. ⚠ **`vrt-exemptions.ts:639` repeats the exact error matrixMix's drain corrected, five
   lines above the correction.** *"Empty state is a blank square"* is false about a surface
   that paints a title, a lock button and a dashed prompt (§6.2). **This drain is available
   TODAY, with no face**: delete `:639` and `:1213`, repair `:686`, and let CI author
   `controlSurface.png`. One file, one baseline, no design work. **It is the cheapest
   correct thing in this spec.**
2. ⚠ **`e2e/tests/control-surface.spec.ts:310` is a `test.fixme`** — *"card grows so ALL
   groups + knobs render within bounds (locked + unlocked)"*, parked under **#1847** with
   *"10 recovered-on-retry observations in the 96 h census to 2026-08-18"*. **The parked
   assertion is precisely the layout §3.2 shows a face cannot reproduce**, so the parked
   test and the refusal are the same finding seen from two sides. ⚠ And a `fixme` is
   green-and-silent: nothing on `main` currently checks that a populated surface renders
   inside its own card.
3. ⚠ **All three `controlSurface` e2e specs boot `?shell=legacy`** —
   `control-surface.spec.ts:36` (explicit `goto`), and both `control-surface.spec.ts:196,310`
   and `toybox-control-surface.spec.ts:88,149` through the `rack` fixture, which is
   `?shell=legacy` by construction (`_fixtures.ts:76-98`). **Today that is CORRECT rather
   than a defect** — the module is a `NON_SHELL_LANE_TYPES` snowflake, so `?shell=legacy`
   and the default shell paint the same card in the lane, and the fixture's own note
   explains why card-interaction specs live there. ⚠ **It becomes wave 6's green-and-blind
   class the instant the module leaves that set**: the specs would keep passing against a
   card no user can reach. **Whichever PR removes the `NON_SHELL_LANE_TYPES` membership owns
   re-pointing them at `rackDefault`** (`_fixtures.ts:107-120`) or splitting them.
4. **`launchpadControlLeft`'s VRT exemption cites `controlSurface` by reference**
   (`vrt-exemptions.ts:686`) on a ground `controlSurface` does not have. §0 proves this
   module has **no device**, so it never shared the device-dependence argument
   `launchpadControlLeft` rests on. The citation is decorative today and misleading after
   the drain — repair it in the same commit, the way `:680-685` repaired the matrixMix half.
5. **`.claude/skills/module-faceplates.md:485-489` is STALE**: it says `editorSurface` and
   `fullViewBody` are *"declared contract, no render site yet"*. `fullViewBody` is **wired**
   — `WIRED_SHELL_EXTENSION_SLOTS = ['glyph', 'fullViewBody']`
   (`shell-extensions.ts:124`), with ~30 shipped adopters. Only `editorSurface` is still
   unwired (`shell-extensions.ts:65`). Boy-scout it on any face PR.
6. **The wave-1 `electraControl` spec's §12.1 platform precursor is DONE.**
   `.myrobots/2026-08-23-bespoke-wave1/electraControl/spec.md:35` records `MetaModuleDef`
   as having no `face` field; `meta/module-registry.ts:85,106` now has both `face?` and
   `controlFamilies?`, with a negative-control describe block naming itself
   (`module-face-lint.test.ts`, *"meta domain: the `face?` precursor is READ, not merely
   declarable"*). Anyone reading that spec today inherits a false blocker.
7. Minor: `ControlSurfaceCard.svelte:290-292` interpolates the surface's own **user-typed
   name** into the empty-state sentence, and `:337`/`:377` put full sentences in `title=`
   (hover strings, refused by name once this is a face). All three are §5 rows; none is a
   defect on a legacy card.

---

## 14. VERDICT, RISK, ESTIMATE

| | |
|---|---|
| **verdict** | **REFUSE — TWO independent blockers.** (1) promotion is a functional-parity loss (#1974's shape), blocked MECHANICALLY by `SHELL_TILE_W = 192` against `BOX_W = 174` with no lane-tier slot to bridge it (§3.2); (2) authoring a `face` is RED on `face-migration-inventory.test.ts`'s typed-entry leg, because the rename `<input>` is on the LEGACY card and a `face` forces `generic-face` (§5.3). |
| **what would change it** | (1) §12's `laneBody` slot — nothing else, not a capability, not a cell kind, not `env`. (2) an OWNER decision among §5.3's three real routes. ⚠ **They are independent**: lifting either alone still leaves the other. |
| **available TODAY, with no face** | the **VRT drain** (§13.1): delete `vrt-exemptions.ts:639` + `:1213`, repair `:686`, predict **1** new baseline (`controlSurface.png`). ≈1 h plus one CI capture. |
| **the face, once unblocked** | ≈10-14 h. The body is a straight port of `:295-395` with the rename input, the drag session, the prune effect and the pointer plumbing intact; the risk is concentrated in the in-place Y.Doc discipline (§8) and in the drag-inside-a-scroll-box interaction (§7.1). |
| **risk** | **MEDIUM** for the body (the mutation trap is a shipped-crash class with a named regression test); **LOW** for the cell and the gates. |

---

## 15. MUST-VERIFY (things I could not measure without running something)

1. **`primaryAudioOutPortId(controlSurfaceDef) === null`** — derived from
   `mandelbulb-glyph-tap.test.ts:32` (`outputs.find(o => o.type === 'audio')?.id`) against a
   def with `outputs: []`. Certain by reading, unrun.
2. **The XYFlow `stopPropagation` guard in the drawer** (§7.1) — the drawer is not the
   canvas, so the guard may be inert there. Measure before dropping it.
3. **Whether a filled board's proxied `<Knob>`s red the `faces-parity` sweep.** Every
   `<Knob>` emits `data-testid="control-<paramId>"` from the SOURCE param, so a populated
   surface paints `control-attack` on a module declaring no params. The wave-1
   `electraControl` spec raised the identical question as its §15.2 and it is **still
   open**; both modules hit it and neither has measured it. ⚠ If it reds, the fix is a
   scoping rule on the body, not a weakened assertion.
4. **The dock scene's `bodyW - contentW` against the 40 px ceiling** with the scroll box in
   place. §6.1 predicts near-zero slack (contentW and bodyW are both the box), matching
   matrixMix's exemption-free pass — but only a captured scene proves it.
