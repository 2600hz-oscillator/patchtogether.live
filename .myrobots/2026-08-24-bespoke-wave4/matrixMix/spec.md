# FACEPLATE BUILD SPEC — `matrixMix` (meta, the rack-wide PATCH MATRIX)

**SPEC ONLY. Nothing here is implemented.** Mockups: [`dock.html`](dock.html) ·
[`lane-tile.html`](lane-tile.html).

Method: analyse what the module is FOR, then author the spec, then build from the
spec. Two claims in here were checked and came back **different from the rule**, and
both are kept as corrections rather than quietly applied — §0.2 (the promotion
blocker is not the one this spec went looking for) and §8 (the fixture conflict that
dissolves, for a reason nobody wrote down).

---

## 0. THE CONSTRAINT MAP, READ FIRST

| constraint | matrixMix's answer | measured at |
|---|---|---|
| `NON_SHELL_LANE_TYPES` (the clipplayer carve-out) | **NOT a member** — and it is the only meta module on the roster that isn't | `legacy-fallback.ts:105-112` |
| ⚠ **`MetaModuleDef` has no `face` field** | **THE BLOCKER.** A two-field platform precursor | `meta/module-registry.ts:23-56`; §0.2 |
| `HEADLESS_MOUNT_LANE_TYPES` | not a member — no engine node at all | `matrixmix.ts:20-24` (*"binds to NO engine"*) |
| lane picture | **refused**, and mechanically protected | §4 |
| WebGL attest | **ZERO — not in the basis** | §10.1 |
| ART | **ZERO** — meta domain is outside the audio gate entirely | §10.2 |
| VRT | ⚠ currently `EXEMPT_FROM_VRT` with **no exit condition**, and the face **falsifies the stated reason** | §9 |
| tab rail | **NO** — two controls | `dock-tabs-model.ts:101` |
| `node.data` writes / Cmd-Z | ✅ **CORRECT** — `LOCAL_ORIGIN` throughout | `graph/matrixmix.ts:61-67`, `:93` |
| docs ratchet | ⚠ **does not apply, and the reason is mechanical** | §8 |

### 0.1 THE PARAM SET IS EMPTY, AND SO IS EVERYTHING ELSE

`matrixmix.ts:42-44`:

```ts
inputs: [],
outputs: [],
params: [],
```

No ports, no params, no factory (`:22-23` — *"The reconciler skips domain==='meta',
so this def carries no factory"*). The persisted state is two strings:
`node.data.xAxisModuleId` and `node.data.yAxisModuleId` (`:26-27`).

So the question this module exists to answer for the program is:
**what does a faceplate rank when there is nothing to rank?**

The answer, measured, is that a face ranking nothing is *legal*. There is no
minimum: `module-face-lint.test.ts:2972-3110` (*"every promoted LANE TILE paints
something"*) explicitly puts a face that ranks NOTHING **out of scope** at `:2994`,
naming `flipper` and `videoOut` as the precedents, and `EMPTY_LANE_OK` (`:2979`) is
an empty list because nothing needs it.

⚠ **But "legal" is not "good", and `order: []` is the wrong answer here.** A
promoted matrixMix with an empty order paints a blank `ModuleShell` tile in the
lane, which is strictly worse than today's placeholder: a placeholder at least
announces that a real card is one click away. §5 argues the *right* answer, which
turns out to rank two cells — because the two axis pickers ARE expressible, and
that is the second thing this module settles.

### 0.2 ⚠ THE BLOCKER IS NOT THE ONE THIS SPEC WENT LOOKING FOR

The obvious candidates were checked first and all three came back clear:
matrixMix is **not** in `NON_SHELL_LANE_TYPES` (unlike `controlSurface`,
`electraControl` and `launchpadControlLeft`, its three closest siblings), **not** in
`HEADLESS_MOUNT_LANE_TYPES`, and **not** in any `DENIED` fixture map.

The blocker is one line of a type:

```
packages/web/src/lib/meta/module-registry.ts:23-56
export interface MetaModuleDef {
  type; domain: 'meta'; label; category;
  inputs; outputs; params;
  noUserControl?;      // ← :39
  size?; hp?; maxInstances?; undeletable?; palette?; card?;
}
```

**There is no `face` field.** `svelte-check` refuses `face:` on a meta def outright,
so matrixMix cannot be promoted today no matter how good its face design is. And the
promotion anchor cannot see the gap either: `module-face-lint.test.ts:3139-3151`
denies by default on `def.face && !STRICT_FACES.has(def.type)`, which for a meta def
is `undefined && …` — permanently false. **A whole domain is outside the face system
and every gate reads green.**

⚠ **And the field next to the hole is the tell.** `:34-39` declares `noUserControl`
with this reason:

> *"Declared for parity with AudioModuleDef / VideoModuleDef **so the face lints can
> read `def.noUserControl` uniformly across all three registries**; no meta module
> declares one today."*

So the meta registry was **already extended for the face system's benefit**, by
somebody thinking about the face lints, and it stopped one field short of the field
that would let a meta module have a face at all.

**Everything downstream is already meta-aware**, which is why the precursor is small
rather than a project:

* `module-face-lint.test.ts:111-117` — `allDefs()` concatenates
  `listModuleDefs()` + `listVideoModuleDefs()` + **`listMetaModuleDefs()`**.
* `ModuleShell.svelte:185` — `return getModuleDef(type) ?? getVideoModuleDef(type) ?? getMetaModuleDef(type);`
  The shell already resolves a meta def.
* `curated-face.ts:404` — `FaceDefLike` already carries `domain?: string`.
* `laneRenderKind` (`legacy-fallback.ts:143-146`) is registry-free and takes
  `hasCard` + `migrated` as inputs; matrixMix declares `card: 'MatrixMixCard'`
  (`matrixmix.ts:41`), so it already reaches the `migrated ? 'shell' : 'placeholder'`
  branch and lands on `'placeholder'` today.

**THE PRECURSOR (PR 1), and it is one field:**

```ts
// meta/module-registry.ts, beside noUserControl
/** The curated faceplate. Declared for parity with AudioModuleDef /
 *  VideoModuleDef — authoring one IS promotion to STRICT_FACES. */
face?: ModuleFace;
```

⚠ **DO NOT ALSO ADD `docs?`.** It is the obvious companion and it is wrong here, for
two independent reasons:

1. `module-manifest.ts:42-53` globs `../audio/modules/*.ts` and
   `../video/modules/*.ts` and **has no meta glob**, so a `docs` field on a meta def
   would be authored into a manifest that never reads it — a green field certifying
   nothing, which is the shape CLAUDE.md warns about before *"fixing" a declaration
   to satisfy a gate*.
2. §8: matrixMix's *absence* of docs is load-bearing for a shipped e2e fixture.
   Adding the field is one step from adding the docs, and the thing protecting that
   fixture is a comment.

**PR 1 is the field, its type import, and the negative control that the field can
actually be read** — a meta def declaring a `face` must appear in `allDefs()` with
`def.face` set, asserted, so the precursor cannot land as a decorative type change.
It is its own PR because it opens the face system to a whole DOMAIN rather than to a
module, and should be looked at on its own.

### 0.3 THE `.data` WRITES ARE CORRECT — the second control case in this wave

`graph/matrixmix.ts:61-67`:

```ts
ydoc.transact(() => {
  const target = patch.nodes[matrixId];
  if (!target) return;
  if (!target.data) target.data = {};
  fn(target.data as MatrixMixData);
}, LOCAL_ORIGIN);
```

and the edge writers do the same (`:93`, *"writes it in ONE LOCAL_ORIGIN transaction
so it rides the Y.Doc to rack-mates + lands on the undo stack"*). The card's own
comments confirm the intent at the call sites (`MatrixMixCard.svelte:144-151`,
`:166-167`).

Its header (`:11-16`) even names the trap it is avoiding — *"a single-key set, never
a spread/reassign of an integrated Y type (the [[yjs-save-load-real-ydoc]] 'Type
already integrated' trap)"* — and cross-references `control-surface.ts mutateSurface`
for the same discipline.

**So matrixMix, like picturebox, is a control case for wave 3's `.data` finding.**
Across waves 3 and 4 the tally is now three correct (`picturebox`, `matrixMix`,
`twotracks`) and three broken (`kria`, `audioOut`, `midiclock`) — with
`mutate.guard.test.ts` green over all six, because its regex anchors on the literal
token `.params` (`:94`). See the wave README; nothing in this spec depends on a
`.data` ledger landing.

---

## 1. WHAT THE MODULE IS FOR

Seeing the patch instead of the cables.

matrixMix is an EMS-Synthi / Buchla pin matrix for a rack that does not have one.
Pick any two modules in the patch; you get a grid with one column per the X
module's jacks and one row per the Y module's, and every cell is the connection
that could exist between them (`matrixmix.ts:3-18`). A filled dot means the cable is
already there. A red ✕ means that input is fed by a third module and clicking would
replace it. A grey ✕ means the output already fans out and clicking would add.
Clicking a dot **unpatches**.

That is a genuinely different way to work: the cable view answers *"what is
connected?"* one wire at a time, and the matrix answers *"what COULD be connected,
and what would I break?"* for a whole pair at once, before you commit.

Two properties follow from that and they drive the whole face design:

1. **It is about OTHER modules.** It has no signal, no sound, no picture, no state
   of its own beyond which two modules you are looking at.
2. **Its content is unbounded.** A pair of small modules is a 4×4 grid; a pair of
   large ones is a scrolling field. The card handles that with
   `width: max-content; max-width: 640px` and a two-axis scroll box
   (`MatrixMixCard.svelte:326-329`, `:272`).

**What that means for the face:** the two axis selections are the module's entire
control surface, and the grid is a picture-you-edit whose size is somebody else's
decision. That is not a hard face — it is a small one with one large body.

---

## 2. STOP 1 — is promoting this module a PARITY LOSS?

| affordance | `MatrixMixCard.svelte` | where it goes on the face | lost? |
|---|---|---|---|
| X-axis module picker | `:230-241` | **ranked `ShellSelectorCell`** — §5.1 | no |
| Y-axis module picker | `:245-256` | **ranked `ShellSelectorCell`** — §5.1 | no |
| the "pick a module" empty hint | `:260-263` | body empty state | no |
| the grid itself | `:272-321` | `fullViewBody` — §6 | no |
| cell click → create edge | `:170-176` | unchanged (`createMatrixEdge`) | no |
| cell click → unpatch | `:146-151` | unchanged (`removeMatrixEdge`) | no |
| the destructive-repatch confirm | `:163` (`window.confirm`) | unchanged — §2.1 | no |
| per-cell tooltip / `aria-label` | `:192-206`, `:297-300` | unchanged, and §7 keeps it as the *only* place the cell's meaning is stated | no |
| the column / row jack heads | `:277-291` | unchanged inside the body | no |
| live re-derivation on any patch change | `:53` (`docVersion()`) | unchanged — §6.4 | no |

**Nothing is lost.** One thing is gained: the axis selection becomes visible from
the lane without opening anything (§5.2).

### 2.1 THE `window.confirm` STAYS, AND THAT IS A DELIBERATE NON-CHANGE

`:163` — `if (warning && !window.confirm(\`${warning}\n\nMake this patch?\`)) return;`

A native modal inside a faceplate is not beautiful, and it is not this PR's problem.
It guards a genuinely destructive action (a red-✕ click **replaces** an existing
source), the copy is built by a tested pure helper (`confirmMessageFor`), and
swapping it for an in-app dialog is a UI change with its own e2e surface
(`matrixmix.spec.ts` drives it). **Changing it here would be scope creep in a PR
whose subject is the surface, not the interaction.** Recorded so the next reader
knows it was considered rather than missed.

---

## 3. STOP 2 — does every way of getting DATA IN survive?

| entry point | today | after |
|---|---|---|
| axis selection | `<select onchange>` → `setXAxisModule` / `setYAxisModule` | selector cell `onchange` → **the same two functions** |
| cell click | `onCellClick` → `createMatrixEdge` / `removeMatrixEdge` | unchanged, inside the body |
| remote peer edit | `docVersion()` re-derive | unchanged |
| a cable dragged on the canvas | `docVersion()` re-derive | unchanged |
| CV / MIDI / automation | **none — no params, no ports** | none |

⚠ **There is no automation surface to preserve, and that is worth stating rather
than leaving implied.** matrixMix has no params, so it has never been reachable from
clip automation, MIDI learn, the Electra mapper or the Push 2 card, and promotion
does not change that. A reader coming from the audio modules will expect a
"does automation survive?" row here; the honest answer is that the row has always
been empty.

---

## 4. THE LANE PICTURE — refused, and the mechanism is a fourth distinct one

The wave-2/3 refusals turned on `ShellExtensionGlyphProps` carrying no `nodeId`
(`shell-extensions.ts:44-52`), so a glyph would be byte-identical across instances.
picturebox escapes that entirely via the video path (§4 of its spec). matrixMix is
refused by a third mechanism and a fourth consideration:

**Mechanically protected.** `laneGlyphFor` (`module-shell-model.ts:237-240`) returns
`'picture'` only for `hasVideoSurface(def)`, which is `def?.domain === 'video'`
(`:177-179`) — matrixMix is `domain: 'meta'`. And a `'trace'` glyph needs
`face.glyph !== 'none'`, which for matrixMix would resolve through
`glyphBinding()` (`shell-glyph-live.ts:128-200`) to `{kind: 'static'}` at `:199`,
because `primaryAudioOutPortId` (`:111-113`) finds no `type === 'audio'` output —
matrixMix has **no outputs at all**. `module-face-lint.test.ts:271-290` reddens a
dead glyph **unconditionally**. So `glyph: 'none'` is the only literal that compiles
into a green run, and an author who never thinks about it ships the right thing.

**And the picture it would WANT is the one thing a glyph cannot be.** matrixMix's
identity picture is the cross-point field — which depends on two *other* nodes, not
on this one. That is strictly more than the missing `nodeId` would buy: even a
per-node glyph prop would not help, because the data lives in a pair of foreign
nodes plus the whole edge set. This is the clearest case in the program that the
glyph seam's limit is not an oversight to be patched but a shape.

---

## 5. THE FACE

### 5.1 ⚠ THE AXIS PICKERS ARE EXPRESSIBLE TODAY — AND A SHIPPED COMMENT SAYS OTHERWISE

The strongest argument against a matrixMix face is written down in the tree, in the
cameraInput lineage note at `legacy-fallback.ts:70-73`, about *that* module's device
picker:

> *"the DEVICE PICKER — a `<select>` populated from `enumerateDevices()`, persisted
> to `node.data.deviceId`. **It is NOT a ParamDef, so no shell face can render it**
> (a `static` face cell is a dead dashed label by design — ModuleShell's
> controlCell)."*

Read as a general claim — *a runtime roster cannot be a face cell* — that is
**false**, and `shell-cells.ts:152-160` is the counter-example:

```ts
/** A dropdown over a NAMED roster that lives in node.data (not a param). */
export interface ShellSelectorCell {
  kind: 'selector';
  tag: string;
  options: (node: ModuleNode | undefined) => SelectorOption<string>[];
  value:   (node: ModuleNode | undefined) => string;
  onchange: (nodeId: string, value: string) => void;
}
```

`options` is **a function**, evaluated per render. It is not a static roster. And a
cell-actions module may reach the whole graph: `kria-cell-actions.ts:29` imports
`patch` from `$lib/graph/store` directly, which is exactly what
`MatrixMixCard.svelte:75-87` does to build `moduleChoices`.

⚠ **The cameraInput note is not wrong about cameraInput** — its roster comes from
`enumerateDevices()`, an async browser call, and `options(node)` receives only the
node. The clause that generalises badly is *"no shell face can render it"*: the real
constraint is **where the roster LIVES**, not that it is runtime-derived. A roster
derivable from the graph is reachable; a roster living behind a browser API or on an
engine handle is not. (That distinction is what blocks `midiclock`'s device picker
from the same treatment — see `../midiclock/spec.md` §5.2, where the gap is one
parameter wide.)

So matrixMix gets **two real ranked cells**, in a new
`packages/web/src/lib/ui/modules/matrixmix-cell-actions.ts`:

```ts
matrixmixXAxisOptions(node)   // every patch node with ≥1 jack, minus this one,
matrixmixYAxisOptions(node)   //   sorted by resolveDisplayName — the SAME
                              //   derivation as MatrixMixCard.svelte:75-87,
                              //   EXTRACTED and called from both surfaces
matrixmixXAxisValue(node)     // node.data.xAxisModuleId, dropped if the node died
matrixmixYAxisValue(node)     //   (MatrixMixCard.svelte:96-105)
setXAxisModule / setYAxisModule   // ALREADY EXIST — graph/matrixmix.ts:70, :78
```

⚠ **Extract, never re-implement.** `MatrixMixCard.svelte:75-105` contains the
roster, the sort and the dangling-selection drop. A second copy in the face would be
the backdraft class in a new dress — two surfaces disagreeing about which modules are
selectable. The extraction is called from the card **and** the cells, and the card
keeps working through it.

### 5.2 RANK — `face.order`

```ts
face: {
  glyph: 'none',                       // mandatory — §4
  order: ['matrixmix-x', 'matrixmix-y'],
  extension: 'matrixmix',
},
```

Two ranked keys, both `selector` shell cells, registered in `shell-cells.ts` under a
`matrixMix:` block (the registry is keyed **module type → exact `face.order` key**,
`:453-460`).

Completeness passes trivially: `params` is empty, so the `:339` loop has nothing to
require, and there are no `controlFamilies` (`:341-345`).

**This is the design decision that makes the face worth building.** With
`order: []` the lane tile is blank. With these two, the lane tile answers the
question you actually have about a matrix node at a glance — **which two modules is
it looking at** — without opening anything. Today that costs a dock full-view open,
because an un-migrated matrixMix renders as a `moduleShellPlaceholder`
(`legacy-fallback.ts:146`, `:151-163`).

### 5.3 BANDS — one, and no tab rail

Two selector cells is one band. `DOCK_TAB_MIN_BANDS = 7`
(`dock-tabs-model.ts:101`), applied at `:142`. **No rail**, and `face.tabbed`
(`types.ts:1069`) is OWNER-INSTRUCTION ONLY with `spirographs` as its sole adopter.
Nothing here is padded to reach a rail.

### 5.4 WIDTH — compact, with the one honest caveat in this wave

`face-width-source.test.ts` denies any `max-width` on `.faceplate-body` (`:146-150`)
and any per-occupant `:has(...)` override outright (`:160-176`), and
`PLATE_FLOOR_EXEMPTIONS` is **empty** (`:88`). matrixMix adds no entry and needs
none.

⚠ **But this is the one module in the wave where "compact" and "the content" pull in
opposite directions, and the spec should not pretend otherwise.** The legacy card
caps itself at `max-width: 640px` (`:329`) and scrolls in both axes (`:272`,
`:265-268` — *"overflow:auto so a small matrix (e.g. ADSR × VCA) shows NO scrollbars
… while a big one scrolls"*). The face **cannot** re-impose that cap on
`.faceplate-body`; the gate refuses it, and the gate is right — a clamp *clips* a
wide face where a scroll *reveals* it (the `dock-pane-close-chrome` / dx7 case
recorded at `face-width-source.test.ts:125-142`).

**Resolution: the cap moves INSIDE the body component**, on the grid's own scroll
box, exactly where the card already puts it. That is not a hatch — it is a
component's internal layout, which is what the card is doing today and what the gate
does not and should not police. The body is then a fixed-width scrolling field
inside a plate that sizes to `max-content`.

---

## 6. THE BODY — `face.extension: 'matrixmix'`, slot `fullViewBody`

### 6.1 WHY `fullViewBody` AND NOT A `panel` CELL

A `ShellPanelCell` (`shell-cells.ts:370-382`) is the seam for *"one
picture-you-edit inside the generic face"*, which is very nearly what the grid is,
and it is DOCK-ONLY (`:1805-1817`). It was the first candidate. It loses on two
measurements:

1. **`minWidth` is a required number** (`:379`, *"the panel's own design floor"*,
   emitted as `--panel-min-w`). matrixMix's grid has no design floor — it is 4
   columns or 40 depending on two other modules. Any number written there is a
   fiction, and a fiction in a required field is worse than an absent field.
2. **the required `probe`** (`:380-381`) has the vocabulary `data` / `data-rev` /
   `text` (`:364-367`). The grid's observable is **`patch.edges`** — an edge
   materialising between two *other* nodes. That is neither this node's `data` nor
   its text, so the only expressible probe would be a `data-rev` counter, and the
   registry's own warning applies verbatim: *"Prefer `data` where you can. A
   revision-only probe passes on a DEAD button that bumps the counter without
   editing anything."*

`fullViewBody` requires neither. It is wired (`shell-extensions.ts:124`), takes
`nodeId` (`:57-59`), paints above the bands, replaces the hero glyph (which
matrixMix does not have), and leaves the two ranked cells intact (`:83-87`).

### 6.2 NEVER `editorSurface` — even though this is the module it was described for

`shell-extensions.ts:75-79` describes `editorSurface` as *"a bespoke EDITOR SURFACE
for controls that are not cell-shaped at all (a clip arranger, a pad matrix)"*, and
a cross-point matrix is about as close to "a pad matrix" as the roster gets.

**It is still the wrong slot.** `WIRED_SHELL_EXTENSION_SLOTS = ['glyph',
'fullViewBody']` (`:124`) — `editorSurface` is declared and **unwired**, and its own
note (`:65-69`) requires the first adopter to wire the render site in `ModuleShell`
**in the same diff**. matrixMix's face already carries a platform precursor (§0.2);
loading a second platform change onto it would make one PR responsible for both the
meta-domain seam and the third extension slot. `fullViewBody` does the job with no
platform change at all.

Recorded because *"the slot for this exact thing exists and does not render"* is
worth knowing before somebody wires it speculatively for a module that did not need
it.

### 6.3 THE COMPONENT

`packages/web/src/lib/ui/modules/matrixmix/MatrixMixGridBody.svelte`, registered via
`packages/web/src/lib/ui/modules/matrixmix/shell-extension.ts`.

It is the card's `{#if !ready} … {:else} …table… {/if}` block (`:260-322`) lifted
verbatim, minus the two axis `<label>`s (which are now cells). Keep every
`data-testid` — `matrixmix-grid`, `matrixmix-grid-scroll`, `matrixmix-dot`,
`matrixmix-cell-{rowdir}-{rowport}-{coldir}-{colport}`, `matrixmix-empty` — because
`matrixmix.spec.ts` drives all of them and there is no reason for a rename.

⚠ **`matrixmix-card` is the exception.** `matrixmix.spec.ts:75` and
`workflow-dock.spec.ts:145` both select
`[data-testid="matrixmix-card"][data-node-id="…"]`. Under the face the card element
no longer exists in the lane. `workflow-dock.spec.ts:145` is the one that matters —
see §8.

### 6.4 ⚠ THE `docVersion()` PUMP IS NOW IN THE LANE, ON EVERY RACK

`MatrixMixCard.svelte:53` is `let cardVersion = $derived(docVersion());`, and the
comment above it (`:48-52`) is unusually candid:

> *"Whole-doc version from the shared registry (ONE listener app-wide instead of a
> per-card pump). MATRIXMIX is the one legitimately near-global card: moduleChoices
> scans ALL nodes and the grid scans ALL edges, so it keeps per-transaction
> invalidation for now (decomposing it further is a known follow-up)."*

Today an un-migrated matrixMix renders a **placeholder** in the lane
(`legacy-fallback.ts:146`), so that whole-doc invalidation only runs when somebody
opens the dock full view. **After promotion the two selector cells are in the lane
tile, always mounted, on every rack that contains a matrix node.**

The exposure is not the grid — that stays in the dock-only body — it is
`matrixmixXAxisOptions` / `…YAxisOptions`, which scan `patch.nodes` and call
`resolveDisplayName` per node, re-running on **every Y.Doc transaction**. On a busy
rack under CV modulation that is a real repaint budget.

**Requirement, not a suggestion:** the extracted roster function must be memoised on
a **node-set** signature (ids + display names), not on `docVersion()`. A cable moving
changes `docVersion` and cannot change the roster; only a spawn, a delete or a rename
can. ⚠ **And it must be measured, not assumed** — M2 in §13 says how, and it says it
in the page rather than from a Playwright poll loop, because a loaded runner starves
both sides and "frozen" and "never looked" are indistinguishable from the output.

---

## 7. RESTING TEXT — nothing to remove, and one thing to protect

matrixMix paints **no derived-state text** on its card. The empty hint (`:262`,
*"Pick an X-axis + Y-axis module to build the patch matrix."*) is instructional
copy in an empty state, not a value; the jack heads (`:279-280`, `:289-290`) are
port ids and directions, which are CONTROL CAPTIONS in substance; the `X` / `Y`
labels (`:229`, `:244`) become the selector cells' `tag` field, which is the
primitive's own caption slot (`shell-cells.ts:156`).

So `face-resting-text-source.test.ts` has nothing to object to, and — unusually for
this program — **no readout is deleted and no finding loses its surface.**

⚠ **The thing to protect is the `aria-label` on every cell.** `:300` sets
`aria-label={cellTitle(...)}`, and `cellTitle` (`:192-206`) is the only place a cell
says what it *means*: *"input already patched from FILTER.cutoff — clicking replaces
it"*, *"output already feeds VCA.in — clicking adds another cable"*, *"CUTOFF in ↔
OUT out — connected (click to unpatch)"*. The visual is a coloured dot or a ✕; the
sentence is the whole semantics.

Under the resting-text ruling that sentence **must not** become painted face text,
and it does not need to: `aria-valuetext` / `aria-label` is exactly where the ruling
puts this class, *"speakable and assertable but unpainted"*. The body keeps the
attribute verbatim. **Any face spec proving matrixMix works reads the aria, not the
pixels** — which is also what makes §9's VRT argument safe.

---

## 8. ⚠ THE FIXTURE CONFLICT THAT DISSOLVES — AND WHY THAT IS NOT REASSURING

This spec went looking for the #2166 class and found what looked like a textbook
instance. It is worth walking through, because the resolution is the interesting
part.

**The apparent conflict.** `e2e/tests/module-annotate.spec.ts:107` is
`test('undocumented module (matrixMix): NO Annotate entry', …)`, and its fixture
comment (`:108-115`) is explicit that the choice is *because* of the absence:

> *"FIXTURE CHOICE: a currently-undocumented, LIGHTWEIGHT module (the `matrixMix` DOM
> matrix-mixer card — trivial card, no WebGL) … **NOTE TO DOCS-BATCH AGENTS: if you
> ever author docs for `matrixMix`, re-point this fixture at another undocumented
> lightweight module** (grep `undocumented` here)."*

and `strict-docs.ts:300-301` records the other half:

> *"(matrixMix stays undocumented on purpose — it is the e2e 'undocumented module'
> fixture.)"*

Meanwhile CLAUDE.md's living-docs ratchet says *"any module you incidentally touch is
brought up to the bar then (boy-scout)."* A face PR touches matrixMix. So the ratchet
appears to require exactly the edit the fixture forbids.

**The dissolution.** It does not, and the reason is mechanical rather than a
judgement call:

1. `MetaModuleDef` (`meta/module-registry.ts:23-56`) **has no `docs` field**, so
   matrixMix cannot carry co-located docs at all — the ratchet has nowhere to write.
2. `module-manifest.ts:42-53` globs audio and video only, so matrixMix is never in
   `m.modules` and the placeholder gate (`module-manifest.test.ts:78-83`) cannot
   fire on it.
3. The Annotate entry is gated on **docs specifically**:
   `NodeContextMenu.svelte:341` is `{#if hasDocs && onannotate}`, with the comment
   *"Only shown for modules that actually have authored docs."*

A `face` is not `docs`. **`module-annotate.spec.ts` survives a matrixMix promotion
untouched**, and §0.2's instruction *not* to add `docs?` alongside `face?` is what
keeps it that way.

**⚠ WHY THAT IS NOT REASSURING.** The fixture is safe for a reason nobody wrote
down, and the reason that *is* written down — *"stays undocumented on purpose"* —
reads as a reversible policy choice by a person, when the operative fact is a
missing field on a type. Those look identical from the comment.

The day `MetaModuleDef` gains a `docs?` field — a plausible and reasonable follow-on
to gaining `face?` — the mechanical protection vanishes and the only thing standing
between a routine boy-scout edit and a red `module-annotate` run is a sentence in a
comment. **Comments do not gate.**

**So PR 1 (§0.2) carries this instruction in its body**: adding `docs?` to
`MetaModuleDef` is a *separate* decision that must re-point
`module-annotate.spec.ts` in the same diff. That is the whole ask — not a new gate
(the owner has ruled against adding gates), just the coupling stated where the
person who would break it will read it.

### The rest of the e2e surface

* `matrixmix.spec.ts` — **SUBJECT**, three tests (`:62`, `:236`, `:317`), deeply
  coupled to the card DOM (`:75`, `:81-82`, `:91`, `:119`). The grid testids all
  survive into the body (§6.3); the axis `selectOption` calls at `:81-82` move to
  the two selector cells. A real but mechanical rewrite.
* `workflow-dock.spec.ts:121` — **FIXTURE.** Its subject is the dock rail / stub /
  undock round-trip; matrixMix is *"an allowlisted meta module"* (`:126`) it happens
  to dock. ⚠ Its final assertion is
  `expect(page.locator('.svelte-flow__node[data-id="mm"] [data-testid="matrixmix-card"]')).toBeVisible();`
  (`:145`) — it asserts the **legacy card** is back in the lane after undocking.
  After promotion the lane holds a `ModuleShell`, so this line must become the face
  equivalent. It is a one-line change and the test's real subject is untouched.
* **Not** in `_face-fixtures.ts`'s `DENIED` map (`:67-96`).
* **Not** in `LEGACY_DOCK_CANDIDATES` (`workflow-rear-card.spec.ts:738` =
  `['moog956', 'moog960', 'cartesian']`).
* Not in `_per-module-per-port-shared.ts`, `per-module-per-port-behavioral.spec.ts`
  or `per-module.spec.ts` — all three gate on audio output, so a meta module never
  enters and needs no exemption entry.

---

## 9. VRT — the exemption's stated reason is FALSIFIED by the face

`vrt-exemptions.ts:648`:

> `matrixMix: 'grid body is patch-dependent — solo-spawn shows only the axis
> dropdowns + a pick-a-module hint (no stable module-specific pixels). Covered by
> matrixmix-grid.test.ts + matrixmix-ydoc.test.ts + e2e/tests/matrixmix.spec.ts.'`

with the reasoning at `:640-647` and membership in `ALLOWED_PERMANENT_EXEMPT` at
`:1165`. **No exit condition is stated**; it reads as structurally permanent.

⚠ **The face makes the stated reason false.** *"No stable module-specific pixels"* is
true of the GRID, and the grid stays in a dock-only body. But the promoted **lane
tile** is two selector cells with fixed `X` / `Y` tags and a stable plate — that is
exactly stable module-specific pixels, and it is the surface a face baseline
captures.

The wave-3 caution applies and is worth repeating: `ALLOWED_PERMANENT_EXEMPT`'s own
header (`:1144`) says *"NOT AN ENDORSEMENT. Membership records that a module was
exempt on the day the brake landed — nothing more"*, and `:1137` says *"the set only
ever SHRINKS BY NAME. When a module earns baselines, delete it from BOTH lists."*
There is a shipped precedent for doing exactly that: `:1158-1160` records
`cvBuddy` being removed on 2026-08-20.

**So the face PR should discharge the exemption**, deleting `matrixMix` from
`EXEMPT_FROM_VRT` **and** `ALLOWED_PERMANENT_EXEMPT` — the two lists are asserted set-equal
in both directions by `vrt-meta.test.ts` (`:1131-1132`), so a one-sided delete is red.

⚠ **With one condition, and it is a real one.** The exemption's grid argument
survives: a solo-spawned matrixMix has no axes selected, so the body is the empty
hint. **The face baselines must be captured in the empty state** (no axis selected),
which is deterministic and module-specific, and the grid must NOT be in frame. If
`workflow-shell-faces.spec.ts` cannot guarantee the empty state, keep the exemption
and say why in the PR body rather than capturing a baseline over a
patch-dependent field.

There is no existing baseline to move: no `matrixmix` PNG exists anywhere under
`e2e/` today. **Promotion adds two and moves none** — the cheapest VRT position in
the wave.

Dispatch scoped (`GREP=matrixmix flox activate -- task vrt:commit`), predict **two**
files, and count what the bot commits against that prediction.

---

## 10. COST

### 10.1 WEBGL ATTEST — ZERO. MEASURED.

```
flox activate -- bash scripts/webgl-attest-hash.sh --list | grep -i matrixmix
  (no output)
```

The basis is essentially all of `packages/web/src/lib/video/**`, plus
`audio/modules/cube.ts`, `audio/modules/wavesculpt.ts`, `WavesculptCard.svelte`,
`cube/CubeVizSurface.svelte`, and four config files. **Nothing under
`packages/web/src/lib/meta/`, nothing under `ui/workflow/`, and no `MatrixMixCard`.**

Neither does the precursor: `meta/module-registry.ts` is not in the basis either, so
PR 1 is free as well.

⚠ Note the direction of the risk, because it is the opposite of picturebox's: a body
component written against a WebGL context would enter the basis **automatically**,
since basis membership is derived from CONTENT and path, not from a list somebody
maintains. matrixMix's body is a `<table>`. Keep it one.

### 10.2 ART — ZERO, and for a stronger reason than "no pin"

* `ls art/baselines/` — no `matrixmix/` directory.
* matrixMix is in **neither** `ART_EXCLUDED` nor `ART_BACKLOG`
  (`art/setup/profile-coverage.ts:25`, `:78`), **and needs to be in neither**: the
  gate enumerates audio-domain ids only
  (`art/scenarios/_meta/audio-profile-gate.test.ts:39-47`, matching
  `/^(\S+) meta domain=audio\b/`), and the contract golden records
  `matrixMix meta domain=meta` (`contract-lock.txt:1708`). The gate never sees it.

**`art/` should be absent from both diffs.**

### 10.3 CI wall-time

New: two VRT face captures (dispatched, not in the PR lane), one new unit file
(`matrixmix-face-model.test.ts`), and the existing `matrixmix.spec.ts` rewritten in
place. **Estimated delta well under 2 minutes.**

### 10.4 The Push 2 card does NOT move

matrixMix has no params, so `push-card-schema.ts` has nothing to rank and the
CLAUDE.md re-ranking warning does not apply. Stated because it is the one shared-file
hazard a reader will check for.

---

## 11. DEFECT LEDGER — live on `main`, independent of any face

| # | defect | evidence | routing |
|---|---|---|---|
| **D1** | ⚠ **`MetaModuleDef` carries `noUserControl` "so the face lints can read it uniformly" but has no `face` field** — so the whole meta domain is outside the face system while every gate reads green (the promotion anchor's predicate is `def.face && …`, permanently false for a meta def). | `meta/module-registry.ts:23-56`, esp. `:34-39`; `module-face-lint.test.ts:3139-3151` | **PR 1** (§0.2) |
| **D2** | **`strict-docs.ts:300-301` states a policy reason for a mechanical fact.** matrixMix "stays undocumented on purpose"; it is in fact *undocumentable* — `MetaModuleDef` has no `docs` field and `module-manifest.ts` has no meta glob. A shipped e2e fixture depends on the distinction. | `:300-301` vs `meta/module-registry.ts:23-56`, `module-manifest.ts:42-53` | **fix in PR 1** — correct the comment to say which fact is load-bearing |
| **D3** | ⚠ **The VRT exemption has no exit condition and its stated reason stops being true on promotion.** | `vrt-exemptions.ts:648`, `:640-647`, `:1165` | **face PR** — §9 |
| **D4** | **The axis roster derivation is card-local**, so any second surface must copy it (the face would be the second). | `MatrixMixCard.svelte:75-105` | **fix in the face PR** — §5.1 extraction |
| **D5** | **`docVersion()` invalidates the roster on every Y.Doc transaction**, including edge moves that cannot change it — acknowledged in the card as *"a known follow-up"*. Harmless while the card is dock-only; a lane-tile cost after promotion. | `MatrixMixCard.svelte:48-53` | **fix in the face PR** — §6.4, with M2's measurement |

⚠ **Note what is NOT in this ledger.** matrixMix is a well-built module: correct
`LOCAL_ORIGIN` discipline, an extracted pure core (`matrixmix-grid.ts`), a
registry-free pure lane rule, a real e2e, and an in-place Y-type mutation that
dodges the "Type already integrated" trap by name. Four of the five items above are
about the *platform's* relationship to it, not about the module. That is worth
saying plainly, because a defect ledger with nothing in it reads as a search that
was not performed.

---

## 12. TASTE CALLS, EACH WITH ITS ONE-LINE REVERT

| call | revert |
|---|---|
| the two axis pickers are ranked cells, not body content | move both into the body, `order: []` |
| X ranks before Y | swap the two strings |
| the grid's width cap lives inside the body component | delete the cap, let the body scroll the plate |
| `window.confirm` stays | replace with an in-app dialog (its own PR — §2.1) |
| no tab rail | — (needs an owner instruction) |

---

## 13. MUST-VERIFY (before the face is written)

* **M1 — the precursor is readable, not just declarable.** After adding `face?` to
  `MetaModuleDef`, assert that a meta def declaring a `face` appears in
  `allDefs()` with `def.face` set **and** that the promotion anchor
  (`module-face-lint.test.ts:3139-3151`) now fires on it. Drive it with a fixture
  def, in both directions. ⚠ A type-only precursor that nothing reads is exactly the
  green-and-blind shape this program keeps finding.
* **M2 — the lane-tile roster cost (§6.4).** Measure on a rack with a matrix node
  plus enough CV traffic to produce steady Y.Doc transactions: count roster
  re-derivations **in the page**, not from a Playwright poll loop, and report
  `samples` / `elapsedMs` / the values seen in the assertion message. Negative-control
  it: spawn a node (roster MUST move) and drag a cable (roster must NOT).
* **M3 — the empty-state VRT capture (§9)** is reachable from
  `workflow-shell-faces.spec.ts` without the grid in frame. If it is not, the
  exemption stays and the PR body says so.
* **M4 — `workflow-dock.spec.ts:145` still proves what it was written to prove**
  after its selector moves to the face. Its subject is undock-restores-position, not
  which element renders; confirm the assertion still fails when position is not
  restored.

---

## 14. VERIFICATION GATE

```bash
# ── PR 1: the precursor ────────────────────────────────────────────────────
flox activate -- npx vitest run packages/web/src/lib/ui/workflow/module-face-lint.test.ts
flox activate -- npx vitest run packages/web/src/lib/ui/workflow/no-user-control.test.ts
flox activate -- task typecheck        # the whole point of PR 1 is a type

# ── PR 2: the face ─────────────────────────────────────────────────────────
# 1. the face model + its permanent negative controls
flox activate -- npx vitest run packages/web/src/lib/ui/workflow/matrixmix-face-model.test.ts

# 2. face lint + the promotion anchor (both directions)
flox activate -- npx vitest run packages/web/src/lib/ui/workflow/module-face-lint.test.ts

# 3. the rulings' source gates
flox activate -- npx vitest run \
  packages/web/src/lib/ui/controls/face-readout-source.test.ts \
  packages/web/src/lib/ui/workflow/face-resting-text-source.test.ts \
  packages/web/src/lib/ui/dock/face-width-source.test.ts

# 4. the registries + shared-file neighbours
flox activate -- npx vitest run \
  packages/web/src/lib/ui/workflow/shell-extensions.test.ts \
  packages/web/src/lib/ui/workflow/face-migration-inventory.test.ts \
  packages/web/src/lib/ui/modules-card-map.test.ts \
  packages/web/src/lib/ui/workflow/legacy-fallback.test.ts

# 5. the module's own pure cores — BOTH, they are the exemption's stated cover
flox activate -- npx vitest run \
  packages/web/src/lib/ui/matrixmix-grid.test.ts \
  packages/web/src/lib/graph/matrixmix-ydoc.test.ts

# 6. e2e — the SUBJECT spec and the FIXTURE spec, and the fixture that must NOT move
flox activate -- task e2e:one -- matrixmix
flox activate -- task e2e:one -- workflow-dock
flox activate -- task e2e:one -- module-annotate     # ⚠ must stay GREEN and unedited (§8)

# 7. VRT exemption set-equality — a one-sided delete is red
flox activate -- npx vitest run packages/web/src/lib/audio/modules/vrt-meta.test.ts

# 8. typecheck LAST
flox activate -- task typecheck

# 9. VRT: dispatch only, SCOPED, predict TWO files, COUNT them. NEVER commit a PNG.
GREP=matrixmix flox activate -- task vrt:commit

# 10. attest: NIL for both PRs (§10.1).
```

---

## 15. VERDICT, RISK, ESTIMATE

**PROMOTE — BLOCKED on a one-field platform precursor.**

The face design is small and settled: two ranked selector cells and a dock-only
grid body, no new seam, no unwired slot, no tab rail, no width hatch, zero attest,
zero ART, two new VRT baselines and none moved. The only thing standing between here
and a merged face is that **`MetaModuleDef` has no `face` field**, and the field
beside the hole was added for the face lints' benefit by somebody who stopped one
line short.

**Risk: LOW-MEDIUM.**

* PR 1 is one optional field plus a negative control proving something reads it.
  Its risk is that it lands as a decorative type change — M1 is the guard.
* PR 2's real risk is §6.4: the roster derivation moves from a dock-only card into
  an always-mounted lane tile and inherits a whole-doc invalidation the card's own
  comment already calls a known follow-up. That is a measurement, not a mystery, and
  M2 specifies it.

**Estimate: ≈ 8 h** — PR 1 ≈ 1.5 h (field, import, negative control, typecheck), PR 2
≈ 6.5 h (cell actions extraction + memoisation, two selector cells, the body
component, `matrixmix.spec.ts` rewritten, `workflow-dock.spec.ts:145`, the VRT
exemption discharge, the face-model unit).

**Build it FIRST in the wave.** It is the cheapest, it carries the precursor that
five roster modules are waiting behind, and it settles the zero-param question by a
merged face rather than by three more specs — the same argument that put `kria`
first in wave 3, and it was right there.
