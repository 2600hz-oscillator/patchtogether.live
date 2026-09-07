# BESPOKE-SURFACE BUILD SPEC — `seqtris` (audio; an 8×8 Tetris played on a Novation Launchpad)

> **SPEC + MOCK ONLY. Nothing here is implemented, and this package touches no `src/` file.**
> **Mock:** [`mock.html`](mock.html) — both tiers, compact density, self-contained.
> **Open owner calls:** [`open-questions.md`](open-questions.md).
>
> Owner directive, verbatim: *"yes lets go ahead and spec out seqtris and trails. those work
> well so we want 1:1 parity"*. Everything below is a TRANSLATION of the shipping card into the
> v2 slots. Nothing is dropped and nothing is redesigned.
>
> Direct precedent: **`modtris`** (PR #2282, `origin/feat/modtris-face`, **OPEN — not merged**) —
> the same family, the same "well + the game runs in the factory" shape, and the source of the
> SCREEN answer in §7. Second precedent: **`skifree`** (SHIPPED, `disposition: done`) — the only
> module in the fleet that fills **both** body slots, and the model for the read-only lane tile.
> Third: **`midiCvBuddy`** (`.myrobots/2026-08-24-bespoke-wave5/midiCvBuddy/spec.md`) — the
> device-CONNECT gesture living in `fullViewBody`, which is the precedent §6 follows.
>
> ⚠ **DOOM is excluded from this spec by name**, per the standing owner ruling. It is a game
> module and would fall inside every sweep named here. Nothing in this document applies to it,
> no DOOM file was opened, and no DOOM spec, wait, budget, ledger entry or sweep is touched.

**Verdict: PROMOTE, with `tileBody` + `fullViewBody`.** The translation is clean — the card's
picture is DOM, the game is already in the factory, and the two knobs already bind through
`paramSpec`. Three things must be said loudly before anyone writes code:

1. ⚠ **THE WELL IS NOT A CANVAS.** It is a CSS `grid` of 64 `<span>`s. The modtris/skifree DPR
   blit rules **do not apply and must not be applied** — converting the well to a canvas to
   "follow the precedent" would delete 64 test seams and *introduce* a DPR bug class this
   module structurally cannot have today. §9.
2. ⚠ **THERE IS NO NEXT-PIECE PREVIEW ON THIS CARD, AND `SeqtrisSnapshot` CANNOT SUPPLY ONE.**
   The task brief asked for "piece, locked cells, NEXT piece". The first two are real; the third
   is modtris' strip, not seqtris'. Adding one is a REDESIGN and a snapshot-shape change. §3.3.
3. ⚠ **SEVEN OF THE CARD'S ELEVEN TESTIDS HAVE ZERO CONSUMERS.** `seqtris-card-*`,
   `-well-*`, `-cell-*`, `-controls-*`, `-control-*`, `-status-*`, `-led-*` and `-picker-*` are
   referenced by **nothing** outside `SeqtrisCard.svelte` — measured. A face that silently
   dropped the well, the scene column, the status line or the LED would be caught by no gate in
   the tree. §11 is written against that blind spot rather than around it. §8.

---

## 0. THE CONSTRAINT MAP, READ FIRST

Every row verified against `origin/main` (not the primary checkout) on 2026-09-01.

| registry / artifact | member? | what it means here |
|---|---|---|
| `NON_SHELL_LANE_TYPES` | **NO** | the lane swaps on promotion. |
| `CARD_PRODUCER_LANE_TYPES` | **NO — correctly** | the card only *reads* `engine.read(node,'card-api')`. Nothing engine-side depends on it being mounted. |
| `HEADLESS_MOUNT_LANE_TYPES` | **NO** | so under the shipping default shell **the card is not mounted at all today**. §0.1. |
| `STRICT_FACES` | **NO** | un-migrated. This PR adds it. |
| `EXEMPT_FROM_VRT` | **NO — and it is BASELINED** | `e2e/vrt/__screenshots__/vrt.spec.ts/seqtris.png` exists. ⚠ Unlike modtris and skifree, seqtris **never needed an exemption**: the card header records why (§10). |
| `ALLOWED_PERMANENT_EXEMPT` | **NO** | nothing to discharge. |
| `STRICT_VRT_MODULES` | **NO** | informational lane only; promotion does not change that. |
| `STRICT_DOCS` (`strict-docs.ts:344`) | **YES** | any param add/remove needs a matching `docs.controls` entry. **This PR adds no param**, so the row is inert — see §5. |
| `RANGE_BOUND_CARDS` (`card-range-source.test.ts:408`) | ⚠ **YES — and the card is CLEAN** | `SeqtrisCard.svelte` binds every bound through `paramSpec(seqtrisDef, knobId)` and re-types **zero** numbers. The face inherits that discipline for free. |
| `AUDIO_OPERABLE_FIXTURE` | **NOT A MEMBER** | its predicate is `mountsAFader`, and this card draws `KnobConic`. **Promoting seqtris cannot empty that pool** — the modtris precursor decision (§0.1 of the modtris spec) does **not** transfer. |
| `AUDIO_PLACEHOLDER_FIXTURE` | pool member | a ~34-member derived pool; one promotion is invisible to it. Named so the PR body can say it was checked. |
| `ART_EXCLUDED` (`profile-coverage.ts:46`) | **YES, with a reasoned entry** | *"…the module sits on its opening piece and emits nothing there"*. **No ART change is owed** — see §12. |
| `per-module-per-port-inputs.spec.ts:114` | ⚠ **FLAKE-PARKED** (`test.fixme`) | seqtris' inputs-accept row is parked under the 2026-08-22 owner ruling, 2026-09-01, for `mount FRAME budget exhausted after 300 frames`. §11.5 — **this PR must not silently un-park or extend it.** |
| `_per-module-per-port-shared.ts:265` | reasoned per-port exclusion | poly ports read as lane-0 DC; `board` is a declared silent stub. Unchanged by this PR. |
| WebGL attest basis | **NO — VERIFIED** | derived from `e2e/webgl-heavy-globs.ts`; no seqtris/modtris/skifree spec matches any glob. **And `face` is in `HASH_TRANSPARENT_PROPS` anyway** (`scripts/attest-code-basis.ts`), stripped when it is a direct member of a module-scope def literal, which is exactly the shape here. **Editing seqtris is attest-transparent. NIL attest work.** |
| `face-migration-inventory.ts:1485` | **`bespoke-surface`, NO blockers** | ⚠ and unusually, **its `why` is ACCURATE** — verified line by line against the card in §1. That is worth stating because the standing finding is that inventory prose is systematically false; this entry is one of the ones that survives re-reading. |
| `seqtris.test.ts:138` | ⚠ **an assertion this PR must FLIP** | `it('declares NO face — the bespoke-surface disposition is deliberate')` asserts `seqtrisDef.face` is `undefined`. It goes red the moment the def declares a face. §11.1. |

### 0.1 THE FACT THAT DEFINES THIS SURFACE

`seqtris.ts`'s factory holds **all** of the module's ongoing behaviour:

```ts
const launchpad = acquireSeqtrisLaunchpad(nodeId, press);        // the hardware claim
const unsubscribeTick = getSchedulerClock().subscribe(() => { … tick() … });  // the game clock
function changed() { version++; launchpad.paint(renderBoard(state)); … }      // the LED mirror
```

The card is a **window**, and its own header says so. So today, under the shipping default
shell, seqtris renders `ModuleShellPlaceholder` — **no well, no controls, no CONNECT** — while
the game runs, the pads stay lit and `piece` / `line` / `spawn` keep firing into whatever is
patched. Every seqtris e2e reaches the card only through the `rack` fixture, which is
`?shell=legacy` by construction.

**Promotion therefore replaces a blank placeholder, not a card.** That is the direction of
travel, and it is why the parity bar in §2 is measured against `?shell=legacy` rather than
against what ships.

---

## 1. THE INVENTORY `why`, CHECKED AGAINST THE CARD

`face-migration-inventory.ts:1487-1496` claims six things. Read against
`SeqtrisCard.svelte` on `origin/main`, all six hold:

| the claim | verdict |
|---|---|
| "an 8×8 picture of live gameplay — sixty-four coloured cells painted from transient engine state" | ✅ exact. 64 `<span class="cell">`, `background: seqtrisCssColor(cell)`, from `snap.board`. |
| "the eight controls beside it are not params: they are the LAUNCHPAD'S OWN SCENE COLUMN, laid out in hardware order (including the two dead buttons)" | ✅ exact. `{#each SEQTRIS_SCENE_ACTIONS as action, i}` — the roster imported from `seqtris-launchpad.ts`, `null` rendered as `<span class="scene dead">`. |
| "Ranking them as cells would reorder them, which is the one thing they must not do" | ✅ and it is stronger than the prose: `face.order` is *a priority ranking*, so a face that ranked them would put them in importance order, and the two dead buttons have no `ParamDef` to rank at all. The column is unrankable by construction. |
| "The CONNECT gesture and the bound / no-device / claimed status are WebMIDI service state rather than params" | ✅ `launchpadStatus()` returns a `SeqtrisLaunchpadStatusKind` union of six states from a module-scope binder. Not a param, not on the node. |
| "Two knobs (grav, quant) are the only generic material" | ✅ `seqtrisDef.params` is exactly `[gravity, quantize]`. |
| "a face that ranked those would move them to the lane and leave the board and the controller behind" | ✅ — **which is precisely what a face WITHOUT the two body slots would ship.** §6. |

**No inventory prose correction is owed by this PR.** (Stated explicitly, because the standing
program finding is that 7/7 promotions found the `why` wrong. This is the eighth and it is
right.)

---

## 2. STOP 1 — IS PROMOTING THIS MODULE A PARITY LOSS?

**No, provided both body slots ship.** The full argument is the table in §8. The short form:

* the two params become face cells (rank in §4);
* the five jacks become the shell's rear rail (`face.rear` in §5);
* the title becomes the shell's title;
* **everything else — the well, the eight-button hardware column, CONNECT / picker / status /
  LED — has no generic home and goes into the two extension bodies.**

⚠ There is no `ParamCellKind` that mounts an 8×8 live grid, and a PF-14 `panel` cell's first
legal rank is **7** (the 'full' lane cap is six), which a two-param module can never reach. So
`panel` is mechanically out of reach here for the same reason it was for modtris — the body
slots are not a preference, they are the only route.

---

## 3. STOP 2 — DOES EVERY WAY OF GETTING DATA IN SURVIVE?

Four input routes exist. All four survive:

| route | survives? | why |
|---|---|---|
| the `clock` jack | ✅ untouched | the factory owns the edge counter; the rear rail redraws the same jack. |
| the **Launchpad** (the default-mode source) | ✅ untouched | `acquireSeqtrisLaunchpad` + `onKey` live in the binder module, subscribed from the factory. A card has never been in that path. ⚠ `release()` is called from the factory's `dispose` only — **a body component must never call it** (#1728, stated in the binder's own header). |
| the **on-screen scene buttons** | ✅ **moves to `fullViewBody`** | they call `api()?.press(action)`. §6, and Q1 in `open-questions.md`. |
| the two knobs | ✅ | normal param path, plus MIDI-learn (`moduleId` / `paramId` on `KnobConic`). |

### 3.1 Where state lives — `params` vs `node.data` vs transient

| state | home today | home after |
|---|---|---|
| `gravity`, `quantize` | `node.params` | **unchanged** |
| the **board, the piece, the divisor ladder, the counters** | **transient engine state** inside the factory closure, read through `snapshot()` | **unchanged — and this is the load-bearing invariant.** |
| the Launchpad claim + `portName` + status kind | module-scope + per-binding closure in `seqtris-launchpad.ts` | **unchanged** |
| `previewCollapsed` (SCREEN) | ⚠ **does not exist today** | **`node.data.previewCollapsed`** — the modtris/skifree convention. §7. |

⚠ **ZERO PER-FRAME Y.Doc WRITES, BEFORE AND AFTER.** The board never touches the graph store.
The only new node write this PR introduces is **one boolean per SCREEN click**. That is the
`cv-modulation-live-store-write-storm` rule satisfied by construction rather than by care.

### 3.2 ⚠ THE CARD SUBSCRIBES — IT DOES NOT rAF, AND THE BODIES MUST NOT EITHER

This is the sharpest divergence from the modtris and skifree precedents, and copying them here
would be a regression.

```ts
unsubscribe = a.subscribe(() => { snap = a.snapshot(); });   // SeqtrisCard.svelte
```

The module **pushes** on every state change (`changed()` fires the listener set). `ModtrisWellBody`
and `SkifreeScreen` both run `requestAnimationFrame` loops because their modules expose no
listener seam. **seqtris does.** A body that polls on rAF would burn a frame's work per node per
frame to re-read a board that changes at most once per clock pulse — and would make an idle,
unclocked seqtris (the resting state a VRT scene captures) do work forever.

**Both bodies subscribe. Neither runs rAF.** Three sub-parts of that seam must be carried over
verbatim or the surface silently freezes:

1. `attach()` guarded on `if (unsubscribe) return;` — idempotent.
2. the `$effect` that re-runs on **node identity change** (`void node; attach();`) — *"a card can
   mount before the reconciler builds it"*. ⚠ This is the `yjs-proxy-stable-identity-defeats-derived`
   hazard's neighbour and it is already handled correctly; do not "simplify" it away.
3. `onDestroy(() => { unsubscribe?.(); unsubscribe = null; })` — a leaked listener per mount,
   and a body unmounts on every dock collapse and LRU eviction.

### 3.3 ⚠ THERE IS NO NEXT-PIECE PREVIEW, AND ADDING ONE IS OUT OF SCOPE

`SeqtrisSnapshot` (`seqtris.ts`) declares `board`, `piece`, `divisor`, `baseDivisor`, `ladder`,
`lines`, `totalLines`, `gameOvers`, `notesFired`, `spawns`, `lineFires`, `tiedDrops`,
`clockPulses`, `clockPatched`, `version`. **There is no `next` field**, `state.bag` is not
exposed, and the card renders no NEXT strip.

modtris has one (`s.queue[0]`); seqtris does not. **The 1:1 instruction forbids inventing one**:
it would need a `SeqtrisSnapshot` shape change, a second picture on the plate, and it would put
authored chrome on a resting surface the owner's density ruling refuses. If it is wanted it is a
separate, owner-approved change. Logged as Q4.

### 3.4 ⚠ AND THERE ARE NO COUNTERS ON THE PLATE EITHER

`snapshot()` exposes `lines`, `totalLines`, `gameOvers`, `notesFired`, `spawns`, `lineFires`,
`tiedDrops`, `clockPulses` — **and the card shows none of them.** Its own header says so: *"No
timers, no counters, no live numbers on the plate."*

That is already the owner's ruling (*decimals GONE not hidden*; *no descriptive/readout text
outside a control*) satisfied before it was made. **The face adds no readout row, no LINES pill,
no GAME OVER banner.** The modtris body's §10.1 refuses the same shape by name. Those numbers
reach a screen reader through the well's `aria-label` and nowhere else (§10).

---

## 4. THE RANK — `face.order`

```ts
order: ['gravity', 'quantize']
```

**`gravity` is rank 1.** It is the game's tempo, in clock pulses per row, and everything
downstream of `piece` / `line` / `spawn` is clocked by how fast the stack builds. It is also the
one param with a live engine effect (`setParam` → `setBaseDivisor(state, …)` → `changed()`), so
moving it repaints immediately.

**`quantize` is rank 2, and the loser is named.** It is a two-position mode switch (`free` /
`clock`) that changes *when* a press lands, not what the game does. At the `mini` tier
(`FACE_TIER_CAPS.mini` = 1 control) a 46 px column serves a tempo better than a latch mode.

⚠ **Neither param is inert.** This is the one place seqtris is *easier* than modtris, whose face
PR had to wire a dead `levelStep` before it could honestly rank it. `gravity` is read on every
`setParam` and every `gravitySec()`; `quantize` is read on every `press()`. **No wiring work is
owed, and the def's `params` array is not edited — so `contract-lock.txt` does not move.**

---

## 5. THE DECLARATION

```ts
face: {
  order: ['gravity', 'quantize'],

  // ONE band. Both params answer the same question — HOW does the game move —
  // and `pages` AGREES with `order` rather than disagreeing. A tab rail needs
  // DOCK_TAB_MIN_BANDS = 7 bands; NOTHING IS PADDED to reach one, per the
  // owner's control-heavy/tabbed ruling read in the correct direction.
  pages: [{ id: 'fall', label: 'fall', controls: ['gravity', 'quantize'] }],

  // ⚠ FORCED, and measured rather than assumed. `primaryAudioOutPortId` needs a
  // `type: 'audio'` output; seqtris' four outputs are polyPitchGate ×2 and gate
  // ×2, so every LIVE glyph kind (scope/meter/envelope/waveform) resolves
  // `{kind:'static'}` and is refused by the dead-glyph clause. `'algorithm'`
  // resolves but is refused on its merits: `ShellExtensionGlyphProps` is
  // `{num, numbers?, testid?}` with NO `nodeId`, so a glyph component cannot
  // resolve a graph node, cannot reach `card-api`, and would draw one identical
  // picture on every seqtris in the rack forever. `hasVideoSurface` is
  // `domain === 'video'`; this is audio. So: none.
  glyph: 'none',

  // ⚠ DECLARED FOR PARITY, NOT TASTE. `SeqtrisCard.svelte` draws BOTH controls
  // as <KnobConic>. Without this the shell derives its default primitive and a
  // player's muscle memory for a rotary could land on a fader. Note the
  // divergence from the modtris sibling, which declares 'fader' for the same
  // reason in the opposite direction: each face matches ITS OWN card.
  paramCells: { gravity: 'knob', quantize: 'knob' },

  // The well, the eight-button hardware column and CONNECT.
  // See $lib/ui/modules/seqtris/shell-extension.ts.
  extension: 'seqtris',

  // ⚠ AUTHORED rather than derived. `clock` is a real signal input with NO
  // paramTarget, so the derived rail would render one anonymous jack. An input
  // group must claim the LEADING slot ('voice'/'signal') or name a declared
  // page, or it appends as a stray band after every page and the rear totality
  // gate cannot see it (module-face-lint). 'signal' is the leading slot and
  // `clock` IS what you play the module with.
  // The OUTPUT rail takes the derived default: `piece`/`board` are one cable
  // domain and `line`/`spawn` another, and `rearFieldPlan` splits by domain
  // only once the rail out-runs a column — four ports do not.
  rear: {
    groups: [{ id: 'signal', label: 'clock', ports: ['clock'] }],
  },
}
```

⚠ **`quantize` renders as a two-position control, and its `options` are already declared on the
def** (`{value:0,label:'free'}`, `{value:1,label:'clock'}`). The shell reads them. **Do not
re-type those labels in the face** — same one-source rule as a range, same gate family.

**Nothing else on the def changes.** No param added, no param removed, no port touched, no
`docs` edit owed. `contract-lock.txt` lines 2786-2793 stay byte-identical, and `face` is
hash-transparent, so **the diff on `seqtris.ts` is provably behaviour-neutral.**

---

## 6. THE TWO SLOTS

```ts
// $lib/ui/modules/seqtris/shell-extension.ts
export default {
  fullViewBody: SeqtrisWellBody,   // the DOCK: well + hardware column + CONNECT
  tileBody:     SeqtrisTileBody,   // the LANE: the well, read-only
} satisfies ShellExtension;
```

Both slots are in `WIRED_SHELL_EXTENSION_SLOTS`, so neither needs a render site built. `skifree`
is the precedent for filling both.

⚠ **THE TWO ARE COUNTERPARTS, NEVER SIBLINGS.** `ModuleShell.svelte:1886` gates the tile slot on
`!extBody`, and `extBody` is itself dock-gated by `dockFullViewHeadPlan` — so exactly one paints
per shell instance. But a **lane tile and an open dock pane for the same node are two instances
mounted at once**, which is why the two bodies must **namespace their testids**
(`seqtris-tile-*` / `seqtris-face-*`) instead of sharing them. Sharing would put two elements
behind every selector — the exact failure `skifree/shell-extension.ts` records.

### 6.1 What is in each

| affordance | `tileBody` (lane) | `fullViewBody` (dock) |
|---|---|---|
| the 8×8 well, 64 cells, live | ✅ **~104 px, read-only** | ✅ **~176 px** |
| the bind LED lamp | ✅ (a dot — state at a glance) | ✅ |
| the 8-button hardware scene column | ❌ | ✅ **in `SEQTRIS_SCENE_ACTIONS` order, both dead buttons rendered** |
| CONNECT / Unbind | ❌ | ✅ |
| the port picker | ❌ | ✅ |
| the status line | ❌ | ✅ (`role="alert"` when `problem`) |
| SCREEN ON/OFF | ❌ (**honours** the flag) | ✅ |

### 6.2 Why CONNECT and the column are DOCK-ONLY

This is the one judgement call in the spec, and it is Q1 in `open-questions.md`. The
recommendation follows two shipped precedents against one:

* **FOR dock-only:** `midiCvBuddy` puts its `Connect MIDI…` button in `fullViewBody` and its own
  spec records the consequence plainly (*"the button is in a `fullViewBody`, which is dock-only
  by `dockFullViewHeadPlan`. The test must open the dock full view first"*). `skifree` puts every
  steering affordance in `SkifreeSlopeBody` and keeps the tile read-only. **And the space
  argument is real:** the lane tile is ~192 px wide with the title bar and jack rail already
  spent; a 104 px well + a 52 px column + a bind row + a picker + a status line does not fit
  under the `io-spec-consistency` / `_card-overflow.ts` bounds gate, which measures a control's
  edge against the tile's at `OVERFLOW_TOL_PX = 6`.
* **AGAINST:** `cameraInput` is the `tileBody` slot's *first adopter* precisely because its
  device picker and acquire gesture were dock-only and *"the lane tile could neither choose a
  camera nor start one"*.

**Recommended default: dock-only, with the well and the lamp in the tile.** The distinguishing
fact is that seqtris' tile is **not blank without them** — it paints two knobs, a live well and
a bind lamp, so a glance answers *is it playing, and is my Launchpad on it*. cameraInput's tile
without its picker showed a thumbnail with no possible stream behind it; that is a different
condition. And the dock is one click (the EXPAND pill is a lane affordance and stays one).

⚠ **The tile height must be MEASURED, not assumed.** modtris' own body records the precedent:
stacking a SCREEN button under the picture cost spirographs ~18.8 px against ~11 px of slack and
**reddened `io-spec-consistency`**. §11.4.

### 6.3 What the bodies may NOT do

* ⚠ **Never call `launchpad.release()`.** It is the node's death, called from the factory's
  `dispose`. A component lifecycle hook releasing the hardware is #1728 and the binder's header
  refuses it by name. `unbind()` is a **user gesture only**.
* ⚠ **Never re-derive the scene roster.** Import `SEQTRIS_SCENE_ACTIONS` from
  `$lib/audio/seqtris-launchpad`. A second copy of that eight-entry list is how the screen and
  the hardware drift, and `seqtris-launchpad.test.ts:35` pins only the module's copy.
* ⚠ **Never re-derive the palette.** Import `seqtrisCssColor`. The engine's own comment: *"ONE
  palette for both surfaces on purpose… a second copy of these numbers is how the two drift
  apart."*
* ⚠ **Never statically import the Launchpad device module.** `seqtris-launchpad.ts`'s header
  records the measured failure: `launchpad-device.svelte.ts` declares `$state` at module scope,
  the ART harness runs the audio registry under plain vitest with no Svelte plugin, and a static
  import throws `ReferenceError: $state is not defined` while loading three unrelated CV
  scenarios. `seqtris.test.ts:124` pins this per-file, **and the guard's file list must be
  extended to the two new body files** (§11.1).
* ⚠ **Never `await` above `api()?.connect()`.** The card's comment is the whole rule: *"Straight
  from the click handler — an await above `requestMIDIAccess` spends the user activation and
  Chromium refuses to prompt."* Carry `void api()?.connect().then(() => { revision++; });`
  verbatim.

---

## 7. SCREEN ON/OFF — YES, IT APPLIES

**Decision: the convention applies, dock-only, persisted on `node.data.previewCollapsed`.**

The owner ruling is *"all video cards get SCREEN ON/OFF — keeps rendering while OFF"*. seqtris is
an **audio-domain** module, so the ruling's letter does not reach it — but the well is a live
view and modtris answered the identical question. Its body states the reason and it transfers
**word for word, and then some**:

> *"The game runs on the shared SCHEDULER CLOCK, subscribed inside the module's FACTORY — not in
> this component, not on rAF, and not gated on anything watching… So collapsing the preview
> stops a `drawModtris` call and NOTHING ELSE."*

`seqtris.ts` has the identical structure (`getSchedulerClock().subscribe(…)` in the factory), so
SCREEN OFF stops **only the DOM well**. Pieces keep falling, lines keep clearing, and
`piece` / `line` / `spawn` keep firing.

⚠ **AND SEQTRIS HAS A SECOND, STRONGER GUARANTEE MODTRIS DOES NOT.** `launchpad.paint()` is
called from `changed()` **inside the factory**. So SCREEN OFF on the screen **does not dark the
hardware** — the pads keep showing the board. That is the owner's *"it KEEPS RENDERING while
OFF"* floor met twice over, by construction rather than by care, and it is the single best
argument that the switch is safe on this module.

**Shape (copied from `ModtrisWellBody.svelte`, and every deviation is a defect):**

* the state is `node.data.previewCollapsed`, **absent ⇒ false ⇒ ON**, so an existing rack opens
  unchanged. ⚠ **Not `$state` in the component** — a body unmounts on dock collapse and LRU
  eviction (the #1531 / #1574 / #1583 class). One `mutateNode` per **click**, never per frame.
* the tile **honours** the flag without offering the switch — one flag, two surfaces, no way for
  them to disagree (`SkifreeTileBody`'s exact call).
* ⚠ **the `role="img"` frame renders UNCONDITIONALLY; only the grid sits inside the collapse
  guard**, so the accessible name survives SCREEN OFF. (`FroggerBoardBody.svelte` puts the frame
  *inside* the guard and its own comment's claim is therefore false there. **Not fixed here —
  another module's file — reported instead**, per the standing instruction.)
* the switch **overlays** the well's bottom-right corner and costs **zero layout height**. That
  is not a style preference: stacking it cost spirographs ~18.8 px and reddened
  `io-spec-consistency`.
* ⚠ `role="img"` sits on the **wrapper**, never on a child that svelte-check refuses one on.
  `task typecheck` runs `--fail-on-warnings`.

---

## 8. THE PARITY TABLE — EVERY AFFORDANCE, WITH A HOME

Enumerated from `SeqtrisCard.svelte` line by line. The `consumers` column is measured:
`git grep` over `origin/main` for each testid, excluding the card itself.

### 8.1 The eleven `data-testid`s

| # | testid | what it is | consumers today | HOME after promotion |
|---|---|---|---|---|
| 1 | `seqtris-card-${id}` | card root wrapper | **none** | ⚠ **ABSORBED** — the shell's own plate replaces it. Nothing selects it. Not re-created. |
| 2 | `seqtris-led-${id}` | bind lamp, `.led-bound` when bound | **none** | **BOTH bodies** → `seqtris-tile-led` / `seqtris-face-led` |
| 3 | `seqtris-connect-${id}` | `Connect Launchpad` button | ⚠ **`seqtris.spec.ts:connectAndBind`** | **`fullViewBody`** → `seqtris-face-connect`. ⚠ §11.2 — the existing spec must open the dock, or keep driving `?shell=legacy`. |
| 4 | `seqtris-unbind-${id}` | `Unbind` button (bound state) | ⚠ **`seqtris.spec.ts:connectAndBind`** | **`fullViewBody`** → `seqtris-face-unbind`. Same note. |
| 5 | `seqtris-picker-${id}` | port-list container | **none** | **`fullViewBody`** → `seqtris-face-picker` |
| 6 | `seqtris-port-${i}-${id}` | one button per listed port, ⚠ **keyed by INDEX not name** (Windows reports identical port names — the dual-port finding) | ⚠ **`seqtris.spec.ts`** (`port-0`) | **`fullViewBody`** → `seqtris-face-port-${i}`. ⚠ **the index keying is load-bearing and must survive the rename.** |
| 7 | `seqtris-status-${id}` | status prose, `role="alert"` when `problem` | **none** | **`fullViewBody`** → `seqtris-face-status`. §8.4 on the resting-text ruling. |
| 8 | `seqtris-well-${id}` | the well, `role="img"` + `aria-label` | **none** | **BOTH** → `seqtris-tile-well` / `seqtris-face-well` |
| 9 | `seqtris-cell-${row}-${col}-${id}` | **64 cells**, each `data-piece={cell ?? ''}` | **none** | **BOTH**, ⚠ **all 64, in both bodies, with `data-piece` preserved.** §9. |
| 10 | `seqtris-controls-${id}` | scene-column container | **none** | **`fullViewBody`** → `seqtris-face-controls` |
| 11 | `seqtris-control-${action}-${id}` | **6 live scene buttons** (`reset`, `drop`, `rotateLeft`, `rotateRight`, `moveLeft`, `moveRight`) | **none** | **`fullViewBody`** → `seqtris-face-control-${action}` |

### 8.2 The non-testid affordances

| # | affordance | source | HOME after promotion |
|---|---|---|---|
| 12 | **the two DEAD scene buttons** — `<span class="scene dead" aria-hidden="true">` at indices 1 and 2, no testid | the `{#if action === null}` branch | ⚠ **`fullViewBody`, RENDERED, in position.** This is the affordance the inventory says the surface must not lose. §8.3. |
| 13 | `ModuleTitle {id} {data} defaultLabel="SEQTRIS"` | title + rename | **ABSORBED** by the shell's title bar (`label: 'seqtris'` on the def; the lowercase-label guard already passes). |
| 14 | the `polyPitchGate` domain stripe | `<div class="stripe">` | **ABSORBED** by the shell's `.faceplate.<domain-class>` plate. |
| 15 | `PatchPanel` with 1 in + 4 out | `portsFromDef(seqtrisDef.inputs/outputs)` | **ABSORBED** by the shell's rear rail; grouping authored in §5's `face.rear`. All five jacks stay reachable. |
| 16 | two `KnobConic`, bound via `paramSpec(seqtrisDef, id)` | `KNOBS = ['gravity','quantize']` | **face cells** (§4/§5). ⚠ the `paramSpec` binding is what keeps `card-range-source` / `card-control-ranges` green — **the face must not re-type a bound either.** |
| 17 | `readLive(knobId)` + `moduleId` / `paramId` on each knob | MIDI-learn + live-value readback | **carried by the shell's own cells** — verify in §11.3 rather than assume. |
| 18 | `api()` = `engine.read(node, 'card-api')` | the whole seam | **BOTH bodies**, unchanged. |
| 19 | `attach()` + the node-identity `$effect` | re-attach when the handle appears | **BOTH bodies** — §3.2. |
| 20 | `unsubscribe` + `onDestroy` | listener teardown | **BOTH bodies** — §3.2. |
| 21 | the `revision` counter | ⚠ bumped after every user action so the **non-reactive** `launchpadStatus()` read re-runs | **`fullViewBody`** (the only body with gestures) — ⚠ **omit it and the status line, the LED and the CONNECT/Unbind swap never update.** Silent, and no gate sees it. |
| 22 | the 64-null board fallback when `snap === null` | `Array.from({length: COLS*ROWS}, () => null)` | **BOTH** — this is what makes the pre-attach frame render an empty well instead of throwing. Load-bearing for VRT. |
| 23 | `onConnect` with ⚠ **no `await` above `connect()`** | user-activation constraint | **`fullViewBody`**, verbatim. §6.3. |
| 24 | `onPick(port)` → `bindPort(port)` | claim | **`fullViewBody`** |
| 25 | `onUnbind()` → `unbindPort()` | user-gesture release | **`fullViewBody`** |
| 26 | `onControl(i)` → `SEQTRIS_SCENE_ACTIONS[i]` → `press(action)` | ⚠ **indexes the roster, does not re-derive it** | **`fullViewBody`**, verbatim. |
| 27 | the well `aria-label` — `Seqtris well, 8 by 8${piece ? ', current piece ' + piece : ''}` | the speakable half | **BOTH** — §10. |
| 28 | `seqtrisCssColor(cell)` | the shared palette | **BOTH**, imported. §6.3. |
| 29 | `title={"Scene button " + (i+1) + " — " + label}` on each live button | the hardware mapping, per button | **`fullViewBody`**, verbatim. ⚠ This is how the mapping is learnable *without* hardware — the inventory's own stated purpose. |
| 30 | `CONTROL_LABELS` (`reset` / `drop` / `rot ←` / `rot →` / `move ←` / `move →`) | button captions | **`fullViewBody`**. ⚠ Already lowercase, already compact, already decimal-free. |
| 31 | `.seqtris-card { width: 260px }` | card width | **ABSORBED** by the shell's `size: '3u'` / `hp: 2` tier geometry. |

### 8.3 ⚠ THE HARDWARE ORDER IS THE ONE THING THAT MUST NOT MOVE

The column is `SEQTRIS_SCENE_ACTIONS`, top to bottom:

```
0  reset       ← RGB_RESET   (amber-red on the hardware)
1  (dead)      ← left DARK
2  (dead)      ← left DARK
3  drop        ← RGB_DROP    (white)
4  rotateLeft  ← RGB_CONTROL (dim blue)
5  rotateRight
6  moveLeft
7  moveRight
```

⚠ **This is TOP-origin, and the codebase has two disagreeing conventions.** The binder's header
records it: `decodeMidiMessage` hands back `ev.row` measured from the **bottom** while
`SCENE_CCS` is written **top**-first, and *"reading `ev.row` instead would invert the whole
controller and every button would still 'work'"*. The face body indexes the exported roster, so
it inherits the correct convention — **but a body that "tidied" the dead entries out, or sorted
by label, or dropped the `aria-hidden` spacers would break the learnability the surface exists
to provide, and nothing in CI would notice.** §11.3 puts an assertion on it.

### 8.4 The status line and the resting-text ruling

The owner's ruling is *no descriptive/sidebar/readout text outside a control* and *near-zero
authored prose*. The status line survives it, on `midiCvBuddy`'s precedent, which split the same
question: its connect **hint** was cut as resting text, its **error** state was kept because
*"it is not resting text"*.

`seqtrisStatusMessage()` returns six strings and **every one is device-service state**, not
description: `unsupported` (no Web MIDI), `listing`, `no-device`, `claimed` (*"Another SEQTRIS is
holding the Launchpad"*), `bound` (names the port), `idle`. The `idle` string is the only
borderline one — *"Not connected. CONNECT grants Web MIDI and lists the Launchpads on this
machine."* — and it is the **resting** state, the one a VRT scene captures.

**Recommendation: keep all six verbatim (1:1), and log the `idle` sentence as Q3** rather than
trimming it unilaterally. Trimming is a prose change to a pure, unit-tested function
(`seqtris-launchpad.test.ts:81`) and the owner asked for parity.

### 8.5 ⚠ THE LEFTOVER SET

**EMPTY.** Every one of the 11 testids and 20 non-testid affordances above has an explicit home:
23 carried into a body, 5 absorbed by the shell (rows 1, 13, 14, 15, 31 — each argued), 3 into
face cells / the rear rail.

**Nothing is dropped. Nothing is redesigned. Nothing is deferred.**

The only *additions* are the SCREEN switch (§7, owner convention) and the testid namespacing
(§6, forced by the two-instances-at-once invariant).

### 8.6 The factory-owned behaviour — NOT the card's, and NOT to be "migrated"

Stated so a future reader does not go looking for it in a body, or worse, move it into one:

| behaviour | where it lives | why it must stay |
|---|---|---|
| `getSchedulerClock().subscribe(tick)` | `seqtris.ts` factory | the game runs with no UI mounted — the whole premise |
| `acquireSeqtrisLaunchpad(nodeId, press)` | factory | the claim outlives every surface |
| `launchpad.paint(renderBoard(state))` in `changed()` | factory | **the LED mirroring is engine-side**; §7 |
| `launchpad.release()` | factory `dispose` **only** | #1728 |
| `clockPatched()` reading `livePatch.edges` | factory | drives the *"an unpatched clock always plays free"* rule |
| the `PENDING_MAX = 16` latch queue | factory | a stopped clock must not replay a minute of input |

---

## 9. ⚠ THE WELL IS DOM, NOT CANVAS — THE DPR QUESTION, ANSWERED

The brief asked how the mock's canvas scale rules follow the modtris/skifree DPR lessons.
**The premise does not hold, and following it would be a regression.**

`SeqtrisCard.svelte` renders:

```svelte
<div class="well" role="img" aria-label={…}>
  {#each ROWS as row}{#each COLS as col}
    <span class="cell" class:filled={cell !== null}
          style={`background: ${seqtrisCssColor(cell)};`}
          data-testid={`seqtris-cell-${row}-${col}-${id}`}
          data-piece={cell ?? ''}></span>
  {/each}{/each}
</div>
```

```css
.well { display: grid; grid-template-columns: repeat(8, 1fr);
        grid-template-rows: repeat(8, 1fr); gap: 1px; aspect-ratio: 1 / 1; }
```

**There is no canvas, no `getContext`, no `width`/`height` backing store and no DPR anywhere in
this module's UI.** The DPR lessons are real, and they are about a *different* mechanism:

* modtris' body records the measured bug — the card passed `canvasEl.width/height` (the backing
  store at DPR 2, i.e. 400×520) into a painter that lays out in those units and draws its NEXT
  strip at an absolute `'700 9px'`, so labels rendered at ~4.5-5.5 CSS px. Fix: pass **CSS px**
  and scale the context by DPR.
* skifree's `SkifreeScreen` blits a 320 (or 640 on retina) source into a named destination rect
  with smoothing off, rather than trusting a coincidence.

**Both are canvas-blit hazards. A CSS grid has neither.** The browser rasterises DOM at device
pixels natively; `1fr` columns, a `1px` gap and `aspect-ratio: 1/1` are resolution-independent by
construction, and there is no source-to-destination scale to get wrong.

**So the rules the mock and the bodies follow are the DOM equivalents, and they are stated as
such rather than borrowed:**

1. **Size the well in CSS px on the container only** (`--well-px`), never per cell. Cells stay
   `1fr` so the grid divides the box exactly and cannot accumulate rounding into a 9th column.
2. **Keep `aspect-ratio: 1 / 1`** — the geometric guarantee that 8 columns and 8 rows are square
   at any tier, replacing what a blit's destination rect would have to assert.
3. **Keep the `1px` gap and `border-radius: 1px`** — sub-pixel at a 104 px tile is fine because
   the browser snaps it; a canvas would have to round the cell pitch by hand.
4. ⚠ **Do NOT add `image-rendering: pixelated`.** modtris' body needs it because it *is* a
   bitmap. Applying it to DOM cells is inert at best and is a copied incantation.
5. ⚠ **Do NOT convert the well to a canvas.** It would delete 64 `data-testid`s and the
   `data-piece` attribute (the only machine-readable read of the board that is not a
   `page.evaluate` into engine internals), and it would *import* the DPR bug class this module
   is currently immune to. **1:1 parity means the well stays DOM.**

**Cost of keeping it DOM:** 64 `<span>`s per mounted body. At the tile that is 64 elements
beside two knobs — cheap, and it only re-renders when `snap` changes (§3.2), which is at most
once per clock pulse and never at all on an unpatched module.

---

## 10. THE ARIA CONTRACT

⚠ **`open-questions.md` does NOT ask about keyboard navigation, and this spec adds none.** The
owner ruling stands: *Tab IS the flip gesture; never file or fix keyboard-nav.* The scene
buttons are `<button>`s and inherit whatever the shell gives them, exactly as today.

The contract carried over verbatim:

| element | contract |
|---|---|
| the well | `role="img"` on the **wrapper**, `aria-label="Seqtris well, 8 by 8"` + `, current piece {id}` when a piece exists. ⚠ **outside** the SCREEN collapse guard (§7). |
| each cell | no role, no label — `data-piece` carries the machine-readable value. 64 announced cells would be noise. |
| the status line | `role="alert"` **only** when `problem` (`no-device` / `claimed` / `unsupported`), which is the card's exact condition. A permanent alert region announces on every repaint. |
| each dead scene button | `aria-hidden="true"`, no testid, **still occupying its row**. |
| each live scene button | its `title` is the hardware mapping (`Scene button 4 — drop`). |
| the SCREEN switch | `aria-pressed={!previewCollapsed}`, label `SCREEN ON` / `SCREEN OFF`. |

⚠ **No score row, no counters, no banner.** §3.4.

---

## 11. TESTS OWED

### 11.1 Unit — the three that go red on the first line of the diff

| file | what changes |
|---|---|
| `packages/web/src/lib/audio/modules/seqtris.test.ts:138` | ⚠ **`it('declares NO face…')` INVERTS.** It becomes the face's own shape assertion: `face.order` is the two params, `glyph: 'none'`, `extension: 'seqtris'`, `pages` length 1, `paramCells` both `'knob'`. |
| `seqtris.test.ts:124` (the lazy-import guard loop) | ⚠ **its file list must be EXTENDED to the two new body files.** The guard proves no file in the seqtris closure statically imports the rune-bearing device module; two new files that do would re-open the measured ART registry crash. **If the list is a hard-coded array, this is a real edit — do not assume a glob.** |
| `card-range-source.test.ts:408` | `'SeqtrisCard.svelte': seqtrisDef` — **unchanged** while the card exists. ⚠ If the bodies re-type a bound they are outside this set and **nothing would see it**; §11.3 covers it instead. |

**New:** `packages/web/src/lib/ui/modules/seqtris-face-model.test.ts`, on the shipped sibling
pattern (`skifree-face-model.test.ts`, `modtris-face-model.test.ts`). It must derive through
`curatedFace` — ⚠ **never read `FACE_TIER_CAPS` directly**; four sibling faces got that wrong,
because the raw cap is the pre-reconciliation number rather than what the lane actually fits.
Legs:

1. the tier ladder read back as a sentence: `mini` → `gravity`; `compact`/`full` → both;
   `dock` → both plus the body.
2. `glyph: 'none'` is **forced** — including the counterfactual (assert that `'scope'`/`'meter'`
   would resolve `{kind:'static'}` given no `type:'audio'` output), so a future widening of the
   glyph rules cannot silently make the declaration a preference.
3. ⚠ **the extension file exists and exports BOTH slots** — the `skifree-face-model.test.ts`
   pattern, and its stated reason applies here verbatim: *"Nothing else in CI would notice this
   file disappearing."*
4. ⚠ **the scene roster the body renders IS `SEQTRIS_SCENE_ACTIONS`, in order, dead entries
   included** — a pure-model leg, not a render leg, so it costs nothing and closes §8.3.

### 11.2 e2e — what extends, and the one that must be read carefully

`e2e/tests/seqtris.spec.ts` is the **rule-8 chain** (AGENTS.md boundary 8) and it is good: five
tests, `simulated Launchpad → the app's own CONNECT click → bindUnit → onKey → the pure core →
PIECE → a real DX7 → SCOPE RMS`, plus a full-window **negative control** (`silent until played`)
and an instrument that throws on zero samples.

⚠ **It runs on the `rack` fixture, which is `?shell=legacy` by construction — so every one of
those five tests keeps passing after promotion without ever touching the new surface.** That is
the `e2e-rack-fixture-hides-shell-parity` finding in its exact shape. **Green does not mean
covered here.**

**What is owed:**

* ⚠ **Do NOT re-point the existing five.** They are the module's rule-8 gate and the legacy card
  must keep working while `?shell=legacy` ships. Leave them.
* **NEW: `e2e/tests/seqtris-face.spec.ts`** — the default-shell legs. ⚠ The filename matters:
  `webgl-heavy-globs.ts` matches by prefix and a spec named after a heavy module can run in **no
  CI job at all**, green forever. `seqtris-face.spec.ts` matches none of those globs (verified),
  and it is the same shape as the shipped `skifree-face.spec.ts` / `adsr-face.spec.ts`. **Verify
  it enrols before trusting a green run.**

  Legs, smallest set that would have caught a real drop:

  1. **`pageerror` guard on every leg.** Standing rule — a shared derivation repaired only on the
     surface you looked at is invisible until you promote.
  2. **LANE**: the tile paints `seqtris-tile-well` with **64** `seqtris-tile-cell-*`, and at
     least one carries a non-empty `data-piece`. **PAINT, not presence** — assert a computed
     background, because a rack-fixture-shaped test that only counts elements passes on an
     unstyled grid.
  3. **DOCK**: expand, then assert `seqtris-face-controls` holds **eight** rows, that the six
     live ones are `seqtris-face-control-${action}` in `SEQTRIS_SCENE_ACTIONS` order, and that
     **indices 1 and 2 are the dead spacers**. §8.3.
  4. ⚠ **THE RULE-8 LEG ON THE DEFAULT SHELL**: install the simulated Launchpad, drive
     `seqtris-face-connect` → `seqtris-face-port-0` → assert `seqtris-face-unbind` is visible,
     then press a scene button **on screen** and assert **audible SCOPE RMS** through
     `PIECE → DX7`. This is the leg that proves the promoted surface can actually play the game —
     the boundary-8 requirement, re-paid on the surface that now ships. Reuse
     `readScopePeakOverWindow` / `describeScopeWindow`.
  5. **SCREEN**: toggle off → the grid is gone, the `role="img"` frame and its label remain, and
     `notesFired` **keeps climbing** with a clock patched. That last clause is the whole point of
     the convention and it is the only leg that can fail if someone gates the game on the view.
  6. **NEGATIVE CONTROL**: the identical dock graph with nothing driving it stays silent over a
     full window with no early exit. Do not let leg 4 be the only instrument.

* ⚠ **Flake-check the new spec with `REPEAT=3`** — and remember that passing 3× locally can
  still race the product. Read the **skip count**, not just the pass count.
* ⚠ **`workflow-shell.spec.ts` is NOT at risk here** (unlike modtris): seqtris is not the
  `AUDIO_OPERABLE_FIXTURE` pick and cannot become one — its card draws knobs, not faders. Say so
  in the PR body so a reviewer does not have to re-derive it.

### 11.3 The gaps no existing gate covers — named, not gated

⚠ Per the standing owner ruling (*no new gates or kinds of tests without discussion*), these are
**reported as things the build must verify by hand or fold into the specs above**, not proposed
as new machinery:

| gap | why nothing sees it | where it is covered above |
|---|---|---|
| a body re-typing a param bound | `RANGE_BOUND_CARDS` keys on `*Card.svelte`; a body file is outside the set | fold into `seqtris-face-model.test.ts` leg 2's neighbourhood — assert the bodies import `paramSpec`, or simply **do not put params in the bodies at all** (the recommendation: params are face cells, §4) |
| the `revision` counter omitted → a frozen status line | no gate reads the status line | §11.2 leg 4 exercises it end-to-end (connect → picker → unbind swap is exactly the `revision` path) |
| the dead buttons tidied away | `aria-hidden`, no testid, no consumer | §11.2 leg 3 + §11.1 leg 4 |
| `MIDI-learn` / `readLive` lost in the cell translation | shell-owned, but unverified for this module | **verify by hand on the dock face**, per the standing MIDI-assignment audit finding |

### 11.4 The measurement that must happen BEFORE the layout is fixed

⚠ **`io-spec-consistency` / `_card-overflow.ts` bounds the tile.** `OVERFLOW_TOL_PX = 6`, and
`EXEMPT_CONTROL_OVERFLOW` is explicitly *"layout DEBT"* whose entries may not be added to make a
newly-introduced overflow go green. **Measure the tile with the well at 104 px before committing
to it**; if it overflows, shrink the well — never add an exemption.

### 11.5 ⚠ THE PARKED ROW STAYS PARKED

`per-module-per-port-inputs.spec.ts:114` `test.fixme`s seqtris' inputs-accept row (flake-park
#1847, 2026-09-01, `mount FRAME budget exhausted after 300 frames`, four hypotheses already
eliminated in-session). **This PR neither un-parks it nor extends the park.** Two things to say
in the PR body:

1. The park is orthogonal to the face — it is a **mount-time** failure of the per-port harness,
   not a surface question.
2. ⚠ **But the promotion changes what mounts**, so re-check whether the park's own reasoning
   still reads true afterwards. If the promoted tile mounts *faster* than the card did, that is
   information about the park's mechanism; report it, do not act on it.

---

## 12. VRT SCOPE AND DETERMINISM

### 12.1 What already exists

`e2e/vrt/__screenshots__/vrt.spec.ts/seqtris.png` — the **legacy card** baseline, auto-enrolled
from the registry. ⚠ **seqtris was never in `EXEMPT_FROM_VRT`.** Unlike modtris, pong, frogger
and skifree, it never needed an exemption, and the card's own header explains why:

> *"DETERMINISTIC AT REST (VRT): with nothing patched into CLOCK the piece never falls, and the
> piece bag is seeded from a fixed constant — so a fresh spawn renders the same first piece at
> the top of an empty well, every time. No timers, no counters, no live numbers on the plate."*

**That is designed-in determinism, and it is the strongest position in this family.** It means
**the modtris `simPin` (seed + tick count) is NOT NEEDED here**, and the spec says so rather than
copying it:

* `createSeqtrisState` seeds from `SEQTRIS_DEFAULT_SEED = 0x5e9721` — **fixed, not
  `Math.random`** — so modtris' `__modtrisVrtSeed` half has no counterpart to install.
* the game only advances on a **clock edge** (`tick()` returns early on `edges <= 0`), and a VRT
  scene patches nothing into `clock`, so **the board is time-invariant at rest by construction**
  — modtris' `__modtrisVrtTicks` half has no counterpart either.

⚠ **This is the rare case where the right answer is "add no pin".** A `simPin` here would be
machinery pinning a thing that does not move, and it would obscure the fact that this module got
determinism right at the source. **Verify the claim rather than trusting it** (§12.3), but do
not pre-emptively add a seam.

**MEASURED, so the baseline is predictable:** `shuffledBag(0x5e9721)` yields
`[l, t, o, i, s, j, z]`, so the resting well is the **`l` piece** (the top-LEFT corner tromino,
`X.` over `XX`), width 2, spawned at `col = floor((8-2)/2) = 3` — cells `(0,3)`, `(1,3)`, `(1,4)`
in `rgb(245, 104, 0)`, everything else `rgb(18, 20, 26)`. ⚠ **That is a derivation to verify, not
a constant to hard-code** — the mock reproduces it, the implementation must not.

### 12.2 What this PR adds

Two face scenes in `e2e/vrt/_shell-faces.ts` `FACES`, on the modtris entry's shape but with a
**different determinism argument for each**, because conflating them is how a scene ends up
pinned by nothing:

| scene | baseline | determinism |
|---|---|---|
| `face-seqtris-compact` | `workflow-shell-faces.spec.ts/face-seqtris-compact.png` | ⚠ **the tile now HAS A PICTURE**, which is the divergence from modtris' compact entry. `glyph: 'none'` means no glyph, but `tileBody` paints the live well. It is deterministic **for the §12.1 reason** (seeded bag + no clock), not for modtris' "there is nothing to draw" reason. **State that in the entry** — a future reader who copies modtris' paragraph here would be asserting something false. |
| `face-seqtris-dock` | `…/face-seqtris-dock.png` | the well + the eight-row column + the **`idle`** status string. Same seeded-bag argument, plus: `launchpadStatus()` is `idle` (or `unsupported`) in a VRT boot — **⚠ and those two render DIFFERENT strings**, so the scene must pin which. §12.3. |

Entry: `{ type: 'seqtris', pages: 1 }` — **no `simPin`, no `videoFaceWhy`**. ⚠ `videoFaceWhy`
would boot the VIDEO zone and turn on `freezeFaceVideo`, which **writes `params.freeze`**;
seqtris declares no `freeze` param, so that write would invent an undeclared key — the
`timelorde` hazard, verbatim.

### 12.3 ⚠ THE ONE REAL DETERMINISM RISK, AND IT IS NOT THE GAME

`seqtrisStatusMessage()` returns `unsupported` when `webMidiPresent()` is false and `idle` when
it is true — **two different strings in the same pixel region.** Chromium under Playwright has
`requestMIDIAccess`, so `idle` is expected; but the resting card baseline already survives this,
which is evidence it is stable. **Verify it explicitly on the dock scene** (a one-line
`expect(...).toHaveText(...)` before the screenshot, in the scene's own settle), rather than
discovering it as a cross-platform baseline diff.

Second-order: `.status` is `font-size: 9px` prose. `pinVrtFonts` / `awaitVrtFonts` already run
for every scene, so it inherits the fleet's font pinning.

### 12.4 The dispatch

⚠ **`GREP=seqtris` on the VRT dispatch. Always.** A bare run derives the FULL set (41-56 min).
**Predict the file count and COUNT what the bot commits**: this PR should produce **exactly two
new PNGs** (`face-seqtris-compact`, `face-seqtris-dock`) and **zero changes** to the existing
`seqtris.png` card baseline — the card is not edited. ⚠ **A moved `seqtris.png` means the card
changed and you did not mean it to.** Linux CI authors the baselines; never commit a locally
captured one.

---

## 13. COST

| artifact | delta |
|---|---|
| **WebGL attest** | ⚠ **NIL. VERIFIED.** No seqtris spec matches `webgl-heavy-globs.ts`, and `face` is in `HASH_TRANSPARENT_PROPS`. Nothing to run. |
| **contract-lock** | ⚠ **NIL.** No param, port or domain change. Lines 2786-2793 stay byte-identical. State this in the PR body — a contract diff on this PR is a bug. |
| **ART** | ⚠ **NIL.** `seqtris` is `ART_EXCLUDED` with a reasoned entry, and no poly width, no chord voicing and no note derivation is touched. **Do not run `task art:update`.** |
| **docs / `docs:accept`** | **NIL** unless §8.4's Q3 trims the `idle` string, which is a pure-function prose change with its own unit test — not a `docs.*` field. |
| **face inventory** | `task face:inventory:accept` — the generated row flips. ⚠ **never type its counts.** |
| **e2e wall-time** | **+1 spec, ~6 legs.** Two of them (leg 4 and leg 6) carry audible/silence windows sized like the existing file's (`AUDIBLE_CAP_MS = 10_000` as a failure **bound**, `SILENCE_WINDOW_MS = 800` as a full window). ⚠ **Estimate the delta and get sign-off if it crosses 2 min** — the standing rule. Expected well under it; measure, do not assume. |
| **VRT** | +2 face scenes in `vrt-strict`. ⚠ **The strict lane is at ~61% of a 12-shard cap and 8 shards already timed out once at 90% of the 600 s budget (#2222).** Two scenes is small, but say the number. |
| **⚠ BOTH cost artifacts** | `e2e-timings` **and** `vrt-strict-timings` must be re-pinned **against the newest run, with every shard COMPLETE.** Accepting while shards pend truncates into a diff that looks like an ordinary re-pin. Review both. |

### 13.1 Shared files touched

Every one is a cross-PR conflict surface. ⚠ Never `gh pr update-branch` on this PR; merge
`origin/main` locally and verify both sides survived. ⚠ On a face-registry merge, *"keep both
sides"* is **unsafe** — re-run the accept task.

| file | edit |
|---|---|
| `packages/web/src/lib/ui/workflow/strict-faces.ts` | +1 entry (`'seqtris'`) + its argument |
| `packages/web/src/lib/ui/workflow/face-migration-inventory.ts` | disposition → done. ⚠ **the `why` needs no correction** (§1) |
| `docs/design/face-migration.generated.md` | generated — `face:inventory:accept` |
| `e2e/vrt/_shell-faces.ts` | +1 `FACES` entry |
| `packages/web/src/lib/audio/modules/seqtris.ts` | +`face: {…}` **only**; hash-transparent |
| `packages/web/src/lib/audio/modules/seqtris.test.ts` | the two legs in §11.1 |
| `scripts/e2e-skip-budget.mjs` | ⚠ **check** — the modtris PR touched it; verify whether a new spec moves the budget |
| **NEW** `packages/web/src/lib/ui/modules/seqtris/shell-extension.ts` | no shared file edited — the glob discovers it |
| **NEW** `packages/web/src/lib/ui/modules/seqtris/SeqtrisWellBody.svelte` | |
| **NEW** `packages/web/src/lib/ui/modules/seqtris/SeqtrisTileBody.svelte` | |
| **NEW** `packages/web/src/lib/ui/modules/seqtris-face-model.test.ts` | |
| **NEW** `e2e/tests/seqtris-face.spec.ts` | |
| **NEW** 2 × VRT PNG (**Linux CI authors them**) | |

⚠ **`SeqtrisCard.svelte` IS NOT EDITED AND IS NOT DELETED.** `?shell=legacy` must keep working
until the generated inventory says every module has a disposition.

---

## 14. WHAT CANNOT BE 1:1 UNDER CURRENT GATES

Flagged loudly, per instruction. **Two items, and neither is fatal.**

1. ⚠ **THE LANE TILE CANNOT CARRY THE CONNECT GESTURE OR THE SCENE COLUMN AT COMPACT DENSITY.**
   *The gate:* `io-spec-consistency` / `_card-overflow.ts`, `OVERFLOW_TOL_PX = 6`, against a
   ~192 px tile with the title bar and jack rail already spent. The card had 260 px and no such
   bound. **This is a genuine geometry loss relative to `?shell=legacy`, and it is one click
   deep** (the dock EXPAND pill is a lane affordance and stays one). Two shipped precedents made
   the same call (`midiCvBuddy`'s CONNECT, `skifree`'s steering); one (`cameraInput`) went the
   other way. **Reported, not designed around — Q1.**

2. ⚠ **THE `seqtris-card-${id}` ROOT TESTID CANNOT EXIST ON THE PROMOTED SURFACE.** The shell
   owns the plate. **Measured consumer count: zero**, so nothing breaks — but it is a real
   deletion and it is named rather than quietly absorbed.

**Everything else is 1:1.** In particular, and against expectation: the 64-cell grid, the
`data-piece` attribute, the eight-row hardware column *including both dead buttons*, the
index-keyed port picker, the six status strings, the `revision` seam, the no-`await`-above-
`connect()` constraint, the shared palette and the shared scene roster all carry over unchanged.

---

## 15. MUST-VERIFY BEFORE THE PR IS OPENED

Each of these has already burned this program at least once.

1. ⚠ **Re-read the CARD on `origin/main`, not this spec.** This document is evidence, not
   instruction, and the primary checkout is stale.
2. ⚠ **`seqtris.test.ts:124`'s lazy-import guard list actually covers the two new files.** If it
   is a hard-coded array, extend it. The ART registry crash it prevents is measured, not
   theoretical.
3. ⚠ **The tile's measured height with a 104 px well** clears `_card-overflow`. §11.4.
4. ⚠ **`seqtris-face.spec.ts` ENROLS in a CI job.** A spec that runs nowhere is green forever and
   its absence looks like bookkeeping.
5. ⚠ **Read the SKIP COUNT** on every Playwright run, not the pass count.
6. ⚠ **`GREP=seqtris` on the VRT dispatch**, and the bot commits **exactly two** new PNGs with
   `seqtris.png` unmoved.
7. ⚠ **The contract diff is EMPTY.** Anything else means a param or port moved.
8. ⚠ **`task typecheck` runs LAST** — svelte-check with `--fail-on-warnings` is stricter than
   Vitest, and the `role="img"`-on-a-canvas class of warning is a hard fail.
9. ⚠ **Both cost artifacts re-pinned against a COMPLETE run.**
10. ⚠ **Owner visual review** — this is a new surface, and the standing ruling is that look
    changes get an owner preview before merge. (Faces otherwise merge on green; the named
    exceptions are `cube` and `wavesculpt`, neither of which is this.)
11. ⚠ **DOOM was not touched.** Confirm by name in the PR body; every sweep here would otherwise
    have included it.
