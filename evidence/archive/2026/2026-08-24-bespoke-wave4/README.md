# BESPOKE FACE PROGRAM — WAVE 4 (the rack's PICTURE, its MAP, and its MASTER CLOCK)

Three spec packages for bespoke-surface modules chosen off the live roster
(`docs/design/face-migration.generated.md`, the `bespoke-surface` table on `main`).
Each is `spec.md` plus two browsable, self-contained HTML mocks.

**Method, per the owner's directive:** analyse what the module is FOR first, then author
the spec, then build from the spec. These are the analysis and the spec.
**Nothing here is implemented.**

| module | class | verdict | risk | est. |
|---|---|---|---|---|
| [`matrixMix`](matrixMix/spec.md) | rack-wide PATCH MATRIX (meta) | **BLOCKED on a ONE-FIELD precursor**, then PROMOTE | LOW / MED | ≈ 8 h / 2 PRs |
| [`picturebox`](picturebox/spec.md) | 7-slot IMAGE SLOT BANK (video) | **PROMOTE** — the wave's only ACCEPTED lane picture | MEDIUM | ≈ 11 h / 2 PRs |
| [`midiclock`](midiclock/spec.md) | MIDI TRANSPORT BRIDGE (audio) | **PROMOTE** — one PR, three live defects fixed | MEDIUM | ≈ 13 h |

## The mocks

* `matrixMix/dock.html` · `matrixMix/lane-tile.html`
* `picturebox/dock.html` · `picturebox/dock-slots.html`
* `midiclock/dock.html` · `midiclock/dock-connect.html`

House tokens, no external assets, no scripts.

---

## WHY THESE THREE

The brief asked for value = user-facing prominence × defect richness × unblocking power,
and excluded the already-specced, `clipplayer` (owner decided option (a) — the card
stays), anything DOOM, and the note-entry-blocked VST pair. Ranking what remained on one
question — **which module's face answers something the fleet cannot currently answer?** —
gave three that are deliberately different SHAPES, in three different DOMAINS, hitting
three different platform seams:

* **`matrixMix` — unblocking power, and it is the largest in the wave.** It is the only
  module on the roster that sees the WHOLE rack, and it is the program's **zero-param
  case**: no ports, no params, no factory. The question it settles — *what does a face
  rank when there is nothing to rank?* — gates every roster entry whose `why` says
  "it declares no params at all". It is also `meta` domain, which turned out to matter
  far more than expected (see below).
* **`picturebox` — prominence, uncontested, and the fleet's most-used un-faced fixture.**
  More e2e specs reach for it than for anything else in this wave, most of them because
  they needed *a video source that would definitely be there*. It is also the first module in the program whose def sits
  **inside the WebGL attest basis**, and the first whose lane picture is **accepted**
  rather than refused.
* **`midiclock` — defect richness.** Four items in its ledger are live on `main`, and one
  of them is a "live activity indicator" that is structurally incapable of updating while
  there is activity. It is also the archetype of the **binder cohort** — the
  largest unblocked group left on the roster shares its shape (connect gesture + live
  device roster + no params) — and the one that shows how wide the remaining gap is.

⚠ **Two of the three are zero-param modules, and that is a deliberate pairing rather than
a gap in the selection.** `matrixMix` and `midiclock` both declare `params: []`, and they
resolve in **opposite** directions: matrixMix has nothing to rank and no jacks either, so
its face has to be argued into existence; midiclock has nothing to rank *because one of
its two settings was never declared as a param*, and declaring it makes the module nearly
generic. **The difference between those two outcomes is the finding**, and one module
could not have produced it.

---

## ⚠ THE FINDING THAT IS LARGER THAN ANY OF THE THREE

**A whole DOMAIN is outside the face system, and every gate reads green.**

`MetaModuleDef` (`packages/web/src/lib/meta/module-registry.ts:23-56`) declares `type`,
`domain`, `label`, `category`, `inputs`, `outputs`, `params`, `noUserControl`, `size`,
`hp`, `maxInstances`, `undeletable`, `palette`, `card`.

**There is no `face` field.** `svelte-check` refuses `face:` on a meta def outright, so no
meta module can be promoted today regardless of how good its face design is.

And the promotion anchor cannot see it. `module-face-lint.test.ts:3139-3151` denies by
default on `def.face && !STRICT_FACES.has(def.type)` — which for a meta def is
`undefined && …`, permanently false. The gate is well-built (deny-by-default, anchored in
both directions, its blind spots stated inside itself) and it is **structurally unable to
notice that an entire DOMAIN cannot participate at all**.

⚠ **The field next to the hole is the tell.** `:34-39` declares `noUserControl` with this
reason:

> *"Declared for parity with AudioModuleDef / VideoModuleDef **so the face lints can read
> `def.noUserControl` uniformly across all three registries**; no meta module declares one
> today."*

So the meta registry was **already extended for the face system's benefit**, by somebody
thinking specifically about the face lints, and it stopped one field short of the one that
would let a meta module have a face.

**The precursor is small because everything downstream is already meta-aware** —
`allDefs()` concatenates `listMetaModuleDefs()` (`module-face-lint.test.ts:111-117`),
`ModuleShell.svelte:185` already falls through to `getMetaModuleDef`, `FaceDefLike`
already carries `domain` (`curated-face.ts:404`), and `laneRenderKind` is registry-free and
already reaches the `migrated ? 'shell' : 'placeholder'` branch for matrixMix. It is one
optional field plus a negative control proving something reads it.

⚠ **And `matrixMix` is the only meta module that could use it.** Taking the defs under
`lib/meta/modules/` by name: `group`, `sticky` and `cadillac` are `organizational-native`
(not migrations at all); `controlSurface`, `electraControl` and `launchpadControlLeft` are
in `NON_SHELL_LANE_TYPES` and so cannot be swapped for a faceplate whatever they declare;
`push2Control` needs hardware. That leaves `matrixMix`. **It is the first adopter by
elimination, not by preference** — which is the strongest form of that argument.

`matrixMix/spec.md` §0.2 carries the precursor and the negative control it must ship with.

---

## THE LANE-PICTURE DECISION — A RUN OF REFUSALS, THEN ONE ACCEPT

Waves 2 and 3 refused a lane picture for every module they examined, always for the same
platform fact:
`ShellExtensionGlyphProps` (`shell-extensions.ts:44-52`) carries `num`, `numbers` and
`testid` and **no `nodeId`**, so a glyph is a pure function of one discrete param value and
every instance would draw a byte-identical picture. Wave 2 nominated `scope` as the best
first adopter for a `nodeId` prop; wave 3 nominated `audioOut` as the better argument.

⚠ **`picturebox` ACCEPTS a picture, and it needs none of that** — which is worth stating
precisely, because the wrong version of the sentence would be *"we found a way around the
missing prop"*. picturebox is not on the glyph seam at all:

```
module-shell-model.ts:177-179   hasVideoSurface(def) → def?.domain === 'video'
module-shell-model.ts:237-240   laneGlyphFor(def)    → 'picture' when hasVideoSurface
ModuleShell.svelte:1345-1348    <VideoTileThumb nodeId={id} />
```

`domain === 'video'` is the **whole** condition — no opt-in, no face field, no port check —
and the thumb takes the nodeId, so the picture is per-node by construction. **Video-domain
modules were never on the glyph path.** The `nodeId`-on-glyph escalation still stands for
the audio modules that want a trace; picturebox simply is not one of them.

The three lane-picture decisions in this wave — one accept, two refusals — and as in waves
2 and 3 the test of whether each is an argument rather than a copy is that they resolve by
**different mechanisms**:

| module | outputs | resolves | why the picture is refused (or accepted) |
|---|---|---|---|
| `picturebox` | `out` (`image`) — no `audio` | glyph → dead static | ⚠ **ACCEPTED via `hasVideoSurface`.** `face.glyph: 'none'` is MANDATORY (any other literal is a dead glyph the lint reddens unconditionally) — and the picture arrives anyway |
| `matrixMix` | **none at all** | every literal → dead static | **Mechanically protected**, and the picture it would want depends on **two other nodes plus the whole edge set** — strictly more than a `nodeId` would buy |
| `midiclock` | `gate`, `cv`, `gate`, `gate` — **no `audio`** | every literal → dead static | Mechanically protected. The useful glance is *"is a clock arriving?"* — a picture of an **event rate**, and all five `VALID_GLYPHS` members describe a continuous audio quantity. It is the argument for a sixth; the spec **refuses to invent one on a module PR** |

---

## THE `.data` UNDO FINDING — WAVE 3 GAVE THE NUMERATOR, WAVE 4 GIVES THE DENOMINATOR

Wave 3 reported that the fleet's raw-write discipline is a `params`-shaped gate —
`mutate.guard.test.ts:94`'s regex anchors on the literal token `.params` — while the
bespoke cohort keeps its instrument in `data`, and found `kria` and `audioOut` both writing
`.data` outside `LOCAL_ORIGIN`.

Wave 4 read three more, and **the result is not "the cohort is careless"**:

| module | what lives in `node.data` | tagged `LOCAL_ORIGIN`? |
|---|---|---|
| `kria` | the entire sequencer | ✗ (wave 3) |
| `audioOut` | `outputDeviceId` | ✗ (wave 3) |
| **`midiclock`** | `divisor`, `lastDeviceId` | ✗ — `MidiclockCard.svelte:71-79`, a bare proxy write outside any transaction |
| **`picturebox`** | image bytes, 7 slots, names, mimes | ✓ — `:144`, `:179`, `:211` |
| **`matrixMix`** | two axis ids | ✓ — `graph/matrixmix.ts:61-67`, `:93` |
| `twotracks` | `bufLenA` (engine-owned) | n/a |

**Three broken, two correct, one n/a — and `mutate.guard` is green over all six.**

That is a materially stronger case for a `.data`-side seam than wave 3's two-of-two,
because it establishes the thing that actually matters: **the gate cannot distinguish the
careful modules from the careless ones.** A green run today reads as *"no unledgered raw
writes exist"*; what it establishes is *"no unledgered raw **param** writes exist"*, and
for this cohort that is close to a statement about the empty set.

matrixMix is the most pointed case, because it is *exemplary*: `graph/matrixmix.ts:11-16`
names the trap it is avoiding (*"a single-key set, never a spread/reassign of an integrated
Y type"*), cross-references `control-surface.ts mutateSurface` for the same discipline, and
passes `LOCAL_ORIGIN` everywhere. **None of that care is visible to any gate, and none of
midiclock's absence of it is either.**

**The routing call is unchanged from wave 3**: the module-level fixes are small and ride
their own face PRs (midiclock's is one argument, and §5.1 of its spec deletes half the
problem by making `divisor` a param). The platform question — whether `.data` gets an
origin-tagged seam and a ledger of its own — is a separate, owner-facing decision.
**This wave reports it; it does not build it, and no spec here assumes it lands.**

---

## ⚠ THE CORRECTIONS — three claims that were checked and came back different

Wave 3's pattern was *"the rule was applied correctly and the subject was never checked."*
It repeated here three times, and each is recorded in place rather than quietly fixed.

**1. The attest instrument was wrong before it was right, and the wrong reading looked
like a platform defect.** `picturebox.ts` **is** in the WebGL attest basis (waves 2 and 3
were both entirely outside it, so their flat "zero GPU cost" line does not transfer). The
first negative control wrote `noUserControl: true` *inside each ParamDef*, on the
assumption that a property named "no user control" is a per-param flag. **The hash moved**
(`1c49e951…` → `928c2acd…`), and the obvious reading was a real finding: *"the strip list
names a property that can never be stripped where it actually lives."*

That reading was **false**. `types.ts:527-544` declares `NoUserControlParam { param,
writer, why }` and the registries declare `noUserControl?: readonly NoUserControlParam[]`
**on the def**. The hash moved because the edit was nested — exactly as
`attest-code-basis.ts:88-93` says it should. Re-run with the real API, both directions:

| tree state | hash |
|---|---|
| baseline | `1c49e951c4836ef426bf969dad894302e738321319ff56a30c9d0ee1bf83ab50` |
| `+ face: { order: ['gain'] }` | `1c49e951…` **UNCHANGED** |
| plus a def-level `noUserControl` array | `1c49e951…` **UNCHANGED** |
| `gain` `max: 2 → 3` (positive control) | `93ab8cd7e696cde48429821a4265a3072dc6ba167beef1af31d90fd76ce85e2a` **MOVED** |

So the operative rule is sharp and it is in `picturebox/spec.md` §10.1: **a picturebox face
PR that adds only `face` and `noUserControl` costs ZERO GPU; any other edit to that file
costs a real-machine re-attest CI cannot run.** The range boy-scout is split into its own
PR for exactly that reason.

**2. A fixture conflict that dissolved — for a reason nobody wrote down.**
`module-annotate.spec.ts:107` is *"undocumented module (matrixMix): NO Annotate entry"*,
chosen **because** matrixMix is undocumented, with an explicit *"NOTE TO DOCS-BATCH AGENTS:
if you ever author docs for `matrixMix`, re-point this fixture"*. CLAUDE.md's living-docs
ratchet says any module you touch is brought up to the bar. That looked like a hard
conflict.

It is not. `MetaModuleDef` has no `docs` field either, `module-manifest.ts:42-53` globs
audio and video only, and the Annotate entry is gated on `hasDocs`
(`NodeContextMenu.svelte:341`). A `face` is not `docs`. **The fixture survives untouched.**

⚠ **And that is not reassuring.** `strict-docs.ts:300-301` says matrixMix *"stays
undocumented on purpose — it is the e2e 'undocumented module' fixture"*, which reads as a
reversible policy choice by a person. The operative fact is a missing field on a type, and
the two look identical from the comment. The day `MetaModuleDef` gains `docs?` — a
plausible follow-on to gaining `face?` — the mechanical protection vanishes and a sentence
in a comment is all that stands between a routine edit and a red run. **Comments do not
gate**, so `matrixMix/spec.md` §0.2 instructs PR 1 **not** to add `docs?`, and to carry the
coupling in its body where the person who would break it will read it.

**3. Wave 3's build order is stale by one step — its blocker LANDED.** wave 3's headline
was that `AudioIoSurface.svelte` hosted the pinned audio pair without ever calling
`dockRailRendersFace`, so a promoted `audioOut` would render its face on user-added
instances only. `AudioIoSurface.svelte:23` and `:73-76` now pass exactly that rule, shipped
as `5f6c289a3` (#2173). **audioOut's PR-1 is done; its PR-2 is now an ordinary one-param
face.**

⚠ **But #2173 repaired ONE of THREE topbar surfaces**, and wave 4 found the other two by
following midiclock's pinned instance. `workflow-pins.ts:106-122` hosts four canvas-hidden
pinned modules across three surfaces, and only `AudioIoSurface` is a card host that asks the
migration rule. `MidiDinSurface.svelte` (which hosts `pinned-midiclock`) contains no
`DockCardHost` and no `face` prop to thread; `ClockSurface.svelte:2-3` calls itself
*"TIMELORDE's **face** for workflow racks"* — and timelorde **is** in `STRICT_FACES` with a
real `face`, so **a promoted module already ships with a bespoke topbar surface standing in
for its faceplate.**

That makes midiclock's pinned divergence a *named non-goal* rather than a repeat of
audioOut's bug: audioOut's surface *was* a faceplate host that failed to ask the rule, which
is a defect. midiclock's is a different surface by design. **Unifying the three topbar
surfaces with the faceplate system is the wave's largest open platform question, and it
belongs to the owner rather than to a module PR.**

---

## THE ROUTING CALL — a better first candidate than wave 2's

Wave 2 nominated adding `nodeId` to `ShellExtensionGlyphProps`; wave 3 agreed and refined
the argument. Wave 4 found a **smaller, better-evidenced** platform ask, and it comes from
comparing two modules in this wave against each other.

`shell-cells.ts:157-165` — *"A dropdown over a NAMED roster that lives in node.data (not a
param)"*:

```ts
export interface ShellSelectorCell {
  options: (node: ModuleNode | undefined) => SelectorOption<string>[];
  value:   (node: ModuleNode | undefined) => string;
  onchange: (nodeId: string, value: string) => void;
}
```

`options` is a **function**, and a cell-actions module may reach the graph directly
(`kria-cell-actions.ts:29` imports `patch` from `$lib/graph/store`). **So matrixMix's two
axis pickers — a roster of "every module in the patch" — ARE face cells today**, which is
what turns its face from a blank tile into two useful controls.

⚠ **A shipped comment says otherwise, and it generalises badly.**
`legacy-fallback.ts:70-73`, about cameraInput's device picker: *"It is NOT a ParamDef, so
**no shell face can render it**."* That is correct about cameraInput and false as a general
claim. **The real constraint is where the roster LIVES**: derivable from the graph →
reachable; behind a browser API or on an engine handle → not.

Which is exactly why midiclock's device picker is **not** expressible — its roster is on the
engine handle (`read('card-api')`) — while `ShellActionCell` **does** get an engine, via
`ShellCellEnv { engine, node }` (`shell-cells.ts:169-181`).

> **The ask: give `ShellSelectorCell.options`/`value` the same `env` that
> `ShellActionCell` already gets.** One parameter, matching a shape the same file already
> has, and it would unblock the device picker for **midiclock, midiCvBuddy, midiOutBuddy,
> chromaconsole, outToLaunch, audioIn and cameraInput** at once — most of the binder cohort.

**No spec here asks for it or depends on it.** All three route through `fullViewBody`, which
is wired, dock-only, and is the shipped cameraInput answer
(`CameraInputOutputBody.svelte`). Recorded because it is smaller than the glyph-prop ask,
half-implemented in the neighbouring interface, and has a larger and more clearly-defined
set of waiting adopters.

**And `editorSurface` is still unwired.** `WIRED_SHELL_EXTENSION_SLOTS` is
`['glyph', 'fullViewBody']` (`shell-extensions.ts:124`). Its doc describes *"a bespoke
EDITOR SURFACE for controls that are not cell-shaped at all (a clip arranger, **a pad
matrix**)"* — and matrixMix's cross-point grid is about as close to a pad matrix as the
roster gets. **It is still the wrong slot**, and matrixMix's spec §6.2 says why: its face
already carries one platform precursor, and loading the third extension slot onto the same
PR would make one change responsible for both.

---

## THE #2166 CLASS — one precondition dissolves, one fixture already names its own exit

The brief asked for a sweep for "conveniently un-faced fixture" uses. None of the three is
in `_face-fixtures.ts`'s `DENIED` map or in `LEGACY_DOCK_CANDIDATES`
(`workflow-rear-card.spec.ts:738` = `['moog956', 'moog960', 'cartesian']`), so none
inherits the repaired `scope` hazard. Three results are worth carrying:

* ⚠ **`varispeed-panel-layout.spec.ts` is the CLAUDE.md precondition class, in its milder
  form.** Its header (`:9-10`) states its subject: the "Load multiple…" panel *"stays within
  the card's box once opened"* — and the card box is exactly what a picturebox face removes.
  The panel is an absolute overlay clipped to a rack-unit-locked card; in a `fullViewBody`
  there is no rack-unit height and nothing to contain. **The test does not go red. It goes
  green and blind**, still asserting a containment that no longer constrains anything. The
  instruction is CLAUDE.md's: fix the SUBJECT (re-point the row at a card whose overlay
  still lives in a rack-sized box) or retire the row with the design it covered — and
  **state which, in the PR body**, rather than letting a green run stand in for an argument.
* **`module-annotate.spec.ts` is the cure, not the disease** — a fixture that names its own
  exit condition in a comment addressed to future agents. It survives (correction 2), and
  the hazard is what happens after the field it depends on stops being missing.
* **`midi-autobind-perfzip.spec.ts:124` carries a latent bug independent of any
  promotion**: `.locator('select').first()` is positional, and works only because the
  midiclock card happens to have exactly two `<select>`s in a known order. Re-point it at a
  testid.

---

## COST POSITION, MEASURED PER MODULE

| | `matrixMix` | `picturebox` | `midiclock` |
|---|---|---|---|
| **WebGL attest** | ZERO — nothing under `lib/meta/` is in the basis | ⚠ **IN the basis** — free for `face` + `noUserControl` only, **measured both ways** | ZERO — not in the basis, so even a real code change is free |
| **ART** | ZERO — meta domain, outside the audio gate | ZERO — video domain, outside the audio gate | ZERO — `ART_EXCLUDED:37`, declared, and the entry stays |
| **VRT today** | `EXEMPT_FROM_VRT:648` + permanent, **no exit condition** | ⚠ **one committed baseline** (`vrt.spec.ts/picturebox.png`, 9984 B, unmasked) | `EXEMPT_FROM_VRT:730` + permanent |
| **VRT after** | 2 added, 0 moved; **discharge the exemption** | 1 moved, 2 added | 2 added, 0 moved; **discharge the exemption** |
| **contract** | unchanged | unchanged (expect an EMPTY `docs:accept` diff) | ⚠ **moves** — one new param line |
| **Push 2 card** | unchanged (no params) | ⚠ re-ranks (two params leave it) | ⚠ **appears where there was none** |

⚠ **Both VRT exemptions are dischargeable, and one of them has been dischargeable for a
while.** `midiclock`'s exit condition is stated in a third file — `art/DETERMINISM.md:75`,
*"EXEMPT_FROM_VRT **until a deterministic stub lands**"* — and **the stub is in the repo**:
`e2e/tests/_per-port-drivers.ts:726` mocks `requestMIDIAccess` and pumps `0xFA` plus
360×`0xF8`, built for the per-port sweep, never carried back. The cheap discharge does not
even need it: the exemption's own text concedes the pre-Connect view is deterministic.
`midiCvBuddy`, `midiOutBuddy` and `midiLane` sit in the same two lists for the same stated
reason, so whichever way this goes it is the precedent for three more.

---

## BUILD ORDER RECOMMENDATION

**`matrixMix` first, as TWO PRs.** PR 1 is the one-field precursor plus the negative control
that something reads it — it should land alone and be looked at, because it opens the face
system to a domain rather than to a module. PR 2 is then the cheapest face in the wave:
zero attest, zero ART, two baselines added and none moved, no contract change, no Push 2
movement. It settles the zero-param question by a merged face rather than by three more
specs, which is the argument that put `kria` first in wave 3 and was right there.

**`picturebox` second, as TWO PRs.** PR 1 is the face and **must contain no other edit to
`picturebox.ts`** — the measured hash-transparency in §10.1 is the whole reason it is free.
PR 2 is the range boy-scout (`PICTUREBOX_GAIN_RANGE` + `RANGE_BOUND_CARDS`), which moves
the hash and needs a GPU window. ⚠ **Merging them would convert a free PR into one held
hostage to an attest window**, which is the single most avoidable cost in this wave.

**`midiclock` last, as ONE PR.** It is the only one that changes a contract, and it arrives
carrying three live defect fixes — including a readout removed **because it was broken as
well as because the ruling forbids it**, which is a sentence a reviewer should read
carefully rather than as the third item in a batch. Its migration (`node.data.divisor` →
`params.divisor`) is the only way a saved patch in this wave can regress, and M3 in its §13
is the guard.
