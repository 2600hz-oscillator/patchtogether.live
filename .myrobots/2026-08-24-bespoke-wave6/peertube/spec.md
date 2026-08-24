# FACEPLATE BUILD SPEC — `peertube` (video, the FEDIVERSE SEARCH BROWSER)

**SPEC ONLY. Nothing here is implemented.** Mockups: [`dock.html`](dock.html) ·
[`dock-results.html`](dock-results.html).

Sibling spec: [`../archivist/spec.md`](../archivist/spec.md). The two were written
together because they look like one design problem — two network-backed search
browsers, both `bespoke-surface`, both carrying `needs-media-controller` **and**
`needs-note-entry-cell`, both with a `*-query.ts` pure sibling. **They are not one
problem.** Where a fact is shared this spec cites the sibling rather than restating
it; §2.2, §4 and §6.2 are where they part.

Method: analyse what the module is FOR, then author the spec, then build from the
spec. Every claim carries the file and line it was measured from, and the ones that
**came back different from what a shipped record says** are marked ⚠ and kept — the
correction is the finding, and this module has three of them.

---

## 0. THE CONSTRAINT MAP, READ FIRST

| constraint | peertube's answer | measured at |
|---|---|---|
| `NON_SHELL_LANE_TYPES` | **NOT a member** | `legacy-fallback.ts` |
| `DOM_SOURCE_LANE_TYPES` (the #1511 tax) | ⚠ **MEMBER** — the card is kept alive off-screen and becomes unclickable | `dom-source-modules.ts:89-97`; `../archivist/spec.md §0.2` |
| lane picture | **FREE, per-node, and GENUINELY LIVE** — unlike its sibling's. §4 | `module-shell-model.ts:237-240`; `peertube.ts:341-347` |
| `face.glyph` | `'none'` — ⚠ and the reason every video def's comment gives is FALSE here too. `../archivist/spec.md §4.1` | `shell-glyph-live.ts:111-113`; `peertube.ts:120-121` |
| WebGL attest | ⚠ **TWO files in the basis**: `peertube.ts`, `peertube-query.ts` | §10.1 |
| ART | none — video domain is outside the audio gate | §10.2 |
| VRT | **`EXEMPT_FROM_VRT` and `ALLOWED_PERMANENT_EXEMPT`. NO card baseline.** Promotion moves ZERO, adds TWO | §9 |
| shell extension slot | `fullViewBody`. Never a `selector`, never a `panel` — §6.1 | `shell-extensions.ts:124` |
| `EXTENSION_BODY_ROLES` | `picture` — and here the predicate is satisfied the ordinary way | `face-rack-status-source.test.ts:142`, `:473-491` |
| tab rail | **NO.** One ranked control is one band | `dock-tabs-model.ts` |
| `node.data` writes / Cmd-Z | ⚠ **SPLIT** — the two content writers are correct, the RESIZE writer is a bare proxy write | §0.3 |
| ⚠ **a defect promotion CREATES** | **YES, and it is the wave's most severe finding** | §2.2 |

### 0.1 THE PARAM SET IS THREE, TWO ARE SYNTHETIC — AND THE THIRD IS DEAD

`peertube.ts:130-135`:

```ts
{ id: 'gain',            label: 'Gain',         defaultValue: 1.0, min: 0, max: 2, curve: 'linear' },
{ id: 'cv_play_trigger', label: 'Play trigger', defaultValue: 0,   min: 0, max: 1, curve: 'linear' },
{ id: 'cv_next_trigger', label: 'Next trigger', defaultValue: 0,   min: 0, max: 1, curve: 'linear' },
```

Both `cv_*` params are the ordinary synthetic-gate case; `peertube.ts:115-116`
declares matching `paramTarget`s on `play_trigger` and `next_trigger`, so
`writer: 'cv-port'` is the only legal `noUserControl` value for each
(`no-user-control.ts:112`, `:121`).

**`gain` is dead, and this def says so in its own docs more plainly than any other
in the fleet** (`peertube.ts:153`):

> *"Gain — declared output-level param (0 to 2, linear; default 1.0). **NOTE: like
> TV-LIBRARIAN, the passthrough shader has no uGain uniform and draw() never applies
> it, so the param is carried on the module but currently inert** — it does not yet
> brighten or scale the video output."*

Verified at the site: `FRAG_SRC` (`:47-63`) has `uTex` and `uHasInput` and nothing
else; `surface.draw` (`:271-289`) sets those two and calls `drawFullscreenQuad()`.
No input declares `paramTarget: 'gain'` (`:109-117` declares two, both to `cv_*`),
and the 789-line card renders no gain control. **`gain` is unreachable and inert;
its value in every serialised node is exactly `1.0`.**

**The analysis, the three available moves, and the reason WIRING is the only honest
one, are identical to the sibling's and are argued there in full:
[`../archivist/spec.md §0.1` and `§0.1.1`](../archivist/spec.md).** The short form:

* ranking a dead param is *"a green gate certifying a live bug"*;
* `noUserControl: { writer: 'internal' }` is mechanically legal and asserts
  something false (nothing writes it);
* the fix is `uniform float uGain;` + `* uGain` + `getUniformLocation` +
  `uniform1f`, four lines, already shipped verbatim at `picturebox.ts:92/101/361/525`,
  `camera-input.ts:43/80/326/508` and `loopback.ts:54/77/209/365`;
* at `gain = 1.0` it is the identity, and 1.0 is the only value any existing node
  holds, so **it changes no saved patch by one bit.**

⚠ **It is a basis edit and it costs one real-GPU re-attest window — the SAME window
as the sibling's.** §10.1 routes it as one shared precursor PR covering `peertube`,
`archivist`, `videobox` and `tvLibrarian` — the exact four modules
`grep -l "Reserved in v1\|currently inert"` and `peertube.ts:153` between them name.

### 0.2 THE `needs-media-controller` TAX — identical to the sibling's, and it bites harder

peertube is in `DOM_SOURCE_LANE_TYPES` (`dom-source-modules.ts:89-97`), so
`Canvas.svelte`'s `fullViewShowsFaceInstead` keeps its real card mounted in
`<HeadlessSourceHost>` **even while its own dock pane is open**, parked at
`left:-9999px` with `pointer-events: none`. **The engine state survives; every
interactive affordance becomes unreachable.** The full derivation is
[`../archivist/spec.md §0.2`](../archivist/spec.md) and is not repeated.

**What the tax pays for here, specifically, is more than a card:**

* the node-owned `<video>` (`nodeMedia`, slot `'main'`, `PeerTubeCard.svelte:106`,
  `:162-204`);
* the node-owned **hls.js demuxer** — `$lib/ui/media/node-hls` (`setNodeHls` /
  `getNodeHls` / `destroyNodeHls`, `:29`, `:111-114`, `:183`). ⚠ **peertube is the
  only module in the fleet with a second node-keyed media registry**, and the card's
  `onDestroy` (`:493-507`) deliberately tears down NOTHING for exactly this reason:
  *"The element, its hls.js demuxer and its audio wiring belong to the NODE and must
  survive this card being unmounted."*
* the audio tap and the **un-mute** step, which is the module's most fragile line
  (`:385-399`, §11 D1).

`card-media-lifetime.test.ts:210-213` classifies it as `owner: 'headless-card-mount'`,
*"same as archivist — a card-owned `<video>` plus an hls.js instance; the element is
node-owned by nodeMedia but the attach is the card mount"*.

**The blocker DOES NOT BLOCK THE FACE** — `face-migration-inventory.ts:378-385`
settles it and cameraInput + loopback are the two shipped proofs. ⚠ #1511 is CLOSED
with its acceptance unmet (`face-migration-inventory.ts:622-628`); **nothing here
waits on it and nothing here asks for it.**

### 0.3 THE `.data` CENSUS — the same SPLIT as the sibling, from the same copied helper

| writer | site | tagged? |
|---|---|---|
| `writeSearchTerm` (`searchTerm`, `instanceHost`) | `PeerTubeCard.svelte:139-148` | ✅ `ydoc.transact(…, LOCAL_ORIGIN)` |
| `writeSelection` (`selectedHost`, `uuid`, `name`) | `:149-159` | ✅ |
| ⚠ **the corner-resize `apply`** | **`:518-524`** | ❌ **bare proxy write — no `transact`, no origin** |

⚠ **`ArchivistCard.svelte:616-621` is the same block, character for character.**
Both are the `apply` callback a CALLER hands to `startCornerResize`
(`card-resize.ts`), so the shape propagates by copy through every corner-resizable
card — wave 5's finding about `MidiCvBuddyCard`/`MidiOutBuddyCard` recurring on a
third pair. `mutate.guard.test.ts` is blind twice over: its three patterns anchor on
the literal token `.params`, and these are `.data` writes.

**Fix in this PR**, through `mutateNode` (`$lib/graph/mutate`), which tags
`LOCAL_ORIGIN` by default and takes a deliberate non-tracked origin if the answer is
"a resize should not enter the undo stack". ⚠ **Not** by wrapping in a bare
`ydoc.transact(fn)` — wave 5 measured that shape on chromaconsole as atomic but
outside the undo stack (`store.ts:70` tracks `LOCAL_ORIGIN` only).

### 0.4 `needs-note-entry-cell` DOES NOT BLOCK — and it is the SAME argument, not a coincidence

peertube types more than its sibling: a search field (`:555-564`) **and** an optional
instance-host field (`:566-574`), both `<input type="text">`.

The clearing argument is the one word **CELL** in the capability text
(`face-migration-inventory.ts:173-191`), and it is worked in full at
[`../archivist/spec.md §0.4`](../archivist/spec.md). Summary of the measurements
that carry it:

* `shell-cells.ts` declares six kinds — `selector`, `action`, `file`, `toggle`,
  `panel`, `warped-fader` — and **none paints text**. The gap is real.
* The probe is `tree.faceShellMountsTypedEntry`, i.e. *"does `ModuleShell.svelte`
  mount typed entry"*. It does not. Correctly stated.
* **A `fullViewBody` is a SLOT, not a cell.** It satisfies no cell contract, declares
  no probe, and is rendered as `<ExtFullViewBody nodeId={id} />`. An
  `<input type="text">` inside it is ordinary markup.
* ⚠ **No existing `fullViewBody` in the tree contains one.**
  `grep -rl 'type="text"' packages/web/src/lib/ui/modules/` returns eleven files,
  every one a legacy `*Card.svelte` (plus `dx7/Dx7OpDetail.svelte`, a panel-cell
  internal). These two would be the first, and **nothing gates it either way**.

**VERDICT, and it is the SAME for both modules for the SAME reason:** the capability
gap is real, correctly scoped to cells, and **not in either module's way**, because
on both the typed query is inseparable from the surface it drives. **Do not schedule
a note-entry cell for this cohort.** Both `blockers` arrays
(`face-migration-inventory.ts:637`, `:948`) should lose the entry when these land.

---

## 1. WHAT THE MODULE IS FOR

**A television that receives the fediverse.**

You type a term; Sepia Search — the CORS-open meta-index across every PeerTube
instance (`peertube-query.ts:18-21`) — returns up to 24 videos with titles,
channels, hosts, durations and thumbnails; you click one; the card resolves that
instance's HLS master playlist and attaches it through hls.js to a
`<video crossorigin="anonymous">`; the engine samples it into a **clean, untainted
`video` texture** and taps its **stereo audio** out to `audio_l`/`audio_r`.

⚠ **The clean texture is the whole reason this module exists as a second one.**
`peertube.ts:9-16` states it as a verified research result: PeerTube sends
`Access-Control-Allow-Origin: *` on the FINAL media hop under a `credentialless`
COEP posture, so the element both plays AND yields an untainted WebGL2 texture —
*"unlike ARCHIVIST's archive.org video"*. **Its sibling is play-only; this one is a
real source.**

**The interaction that makes it bespoke is the RESULT LIST.** archivist rolls dice
(`../archivist/spec.md §1`); peertube gives you twenty-four rows with thumbnails and
lets you choose. `PeerTubeCard.svelte:625-646` is that list, and `↻ next` (`:575-582`)
plus the `next_trigger` CV input walk it. **The list is not decoration around the
picture — it is the module's other half**, and everything in §5 and §6 follows from
having to keep both on one plate.

Second idea, and it is the one nothing else in the rack has: **`next_trigger` makes
channel-surfing a CLOCKED gesture.** `peertube.ts:141` — *"Patch a clock here to
channel-surf the results in time."* That input is why §2.2 is the most severe finding
in this wave.

---

## 2. STOP 1 — is promoting this module a PARITY LOSS?

| # | affordance | card site | where it goes | lost? |
|---|---|---|---|---|
| 1 | search field (debounced 350 ms + Enter) | `:555-564` | body row 1 (⚠ §0.4) | no |
| 2 | instance-host field | `:566-574` | body row 2 | no |
| 3 | `↻ next` | `:575-582` | body row 2 | no |
| 4 | the PREVIEW `<video>` | `:587-599` | ⚠ **a blitted `<canvas>` — the ORDINARY route, unlike the sibling. §2.1** | no |
| 5 | `loading…` overlay | `:592-593` | body overlay, transient | no |
| 6 | `display unavailable — skipping` overlay | `:594-595` | ⛔ **REMOVED as text; the FINDING becomes a lamp** — §7.2 | see §7.2 |
| 7 | `search, then pick a video` empty overlay | `:596-597` | ✅ painted INTO the canvas — §7.3 | no |
| 8 | the now-playing NAME | `:601-603` | ✅ kept — §7.1 (⚠ the wave's one owner call) | no |
| 9 | the attribution link to the watch page | `:604-606` | ✅ kept, `{selectedHost}` as the link text | no |
| 10 | `Play`/`Pause` | `:612` | body transport | no |
| 11 | the progress BAR | `:613` | ⚠ **kept as a BAR, and it becomes a real control** — §5.4 | no, upgraded |
| 12 | the error line | `:617-619` | body, transient | no |
| 13 | the status line | `:620-622` | body, transient | no |
| 14 | **the RESULTS LIST** (24 rows: thumb, title, channel·host·LIVE·duration) | `:625-646` | ⚠ **the body — and it is what the width is for.** §5.3 | ⚠ **the SUB-LINE is trimmed** — §7 |
| 15 | the Sepia/PeerTube DISCLAIMER with two links | `:649-652` | ⚠ **KEPT VERBATIM** — §7.4 | no |
| 16 | corner-drag resize | `:656-662` | ⚠ **not carried** — `../archivist/spec.md §2.3` argues it | see there |
| 17 | the PatchPanel jacks | `:551` | the shell's own rear/patch surface | no |

**Nothing is dropped.** One thing is removed as text and kept as a lamp (#6), one
is trimmed (#14), one is upgraded (#11), and one is a deletion whose subject ceases
to exist (#16).

### 2.1 THE PREVIEW IS AN ORDINARY BLIT — and this is where the two modules stop being the same problem

`peertube.ts:341-347`:

```ts
attachExternalSource(kind, el) {
  if (kind !== 'video') return;
  if (videoEl !== el) unwireAudio();
  videoEl = (el as HTMLVideoElement) ?? null;
  if (videoEl) uploader.attach(videoEl);
  else uploader.detach();
},
```

**`uploader.attach(videoEl)` is called**, so `surface.draw` (`:271-289`) uploads a
fresh frame every engine tick and the module's own output texture IS the stream.
`dom-source-modules.test.ts:138-143` names peertube in exactly that group —
*"the shared per-frame texture uploader is pointed AT the element, so every engine
tick samples it into the module FBO (**peertube**, tv-librarian, videobox). **NOT
archivist**"*.

**Therefore `CameraInputOutputBody.svelte`'s rule applies verbatim and unmodified:**
blit `blitOutputForPreview(nodeId)` into a body-owned `<canvas>`, and **never adopt
the `<video>`** (`CameraInputOutputBody.svelte:7-15` — *"A DOM node has exactly one
parent — so a body that adopted it here would STEAL it from the card"*).

⚠ **AND HERE THE PROHIBITION IS LOAD-BEARING RATHER THAN CONSERVATIVE**, which the
sibling's is not. peertube's element has an **hls.js instance attached to it**
(`:368`, `inst.attachMedia(videoEl)`), and hls.js binds to the element's media
events. Moving the element between parents is DOM-legal, but this body has no reason
to find out — the blit is available, correct, and cheaper.

> **So: archivist must ADOPT and peertube must BLIT, and the reason is one line in
> each factory.** That single difference — `uploader.attach()` called or not —
> produces two different body architectures out of two modules whose registry
> entries, blockers, dispositions and card structures are otherwise twins. It is the
> cohort's headline and it is not visible from either module alone.

### 2.2 ⚠⚠ THE DEFECT PROMOTION *CREATES*: a clocked `next_trigger` becomes a SEARCH-REQUEST GENERATOR

This is wave 5's `README §6` class — *"a bug that does not exist until the PR that
must also fix it"* — and it is materially worse than midiOutBuddy's, because the
victim is a third party's server.

**The chain, read at every site:**

1. `results` and `resultIndex` are card-local `$state`
   (`PeerTubeCard.svelte:117-118`), **deliberately**: the header (`:18-21`) says
   *"Transient playback state (results, hls instance, loading, playhead) stays
   render-local — NEVER per-frame written to the synced store (the per-frame-write
   storm lesson)."* Neither is on `node.data` and neither is on the engine handle
   (`peertube.ts:348-356` exposes `extras`, `hasVideoElement`, `audioWired`,
   `hasKeepAlive`, `uploadCount`, `rvfcSupported`).
2. `nextResult()` (`:275-279`) reads that array:
   ```ts
   function nextResult(): void {
     if (results.length === 0) { void runSearch(); return; }
     const next = (resultIndex + 1 + results.length) % results.length;
     void selectResult(results[next], next);
   }
   ```
3. `startTriggerLoop()` (`:427-443`) polls `cv_next_trigger` every 33 ms and calls
   `nextResult()` on each rising edge. **That loop runs on the CARD**, and after
   promotion the card is the off-screen headless mount.
4. **After promotion the SEARCH runs in the BODY** (§6.1 — no cell can reach a
   Svelte component's `$state`, so the query must live where its results live). So
   **the card's `results` array is empty, forever.**
5. Therefore every rising edge on `next_trigger` takes branch one:
   **`void runSearch()` — a fresh Sepia Search HTTP request.**

**Consequence, stated plainly: patch a clock into `next_trigger` on a promoted
peertube and the module issues a network search per clock pulse instead of advancing
the list.** The card's own rate limiter caps it at 50 calls / 10 s
(`:215-224`, `RATE_MAX = 50`, `RATE_WINDOW_MS = 10_000`) — which is not a mitigation,
it is a measurement of the ceiling: **five requests per second, sustained, to
`sepiasearch.org`, from every rack in the world with a clocked peertube in it**, and
past the cap the player sees `Slow down — too many searches` (`:242`) instead of a
channel change.

⚠ **AND IT WOULD SHIP GREEN.** `peertube.spec.ts` never drives `next_trigger`;
`_per-module-per-port-shared.ts:216` exempts every peertube port from the output-emit
sweep (*"needs a resolved + attached PeerTube stream for any output"*), and all three
of the module's e2e tests boot `?shell=legacy`, which keeps the card in the lane and
the results in the same component as the search box. **The precondition that makes
the bug possible is exactly the one the specs remove.**

#### 2.2.1 THE FIX — one node-keyed registry, and it is a PRECURSOR, not a ride-along

`results` + `resultIndex` move into **`$lib/ui/media/peertube-browse-registry.ts`**,
built on the same discipline the two shipped status registries already use
(`camera-status-registry.ts`, `loopback-status-registry.ts`):

* **node-keyed**, process-wide, per-tab, **never Yjs.** The results are a cache of a
  third-party query, not document state — putting them in the Y.Doc is the
  per-frame-write-storm mistake the card's header already refuses, one size up.
* **swept from `Canvas.svelte`'s node sweep**, beside `cameraStatus.sweep(liveIds)`
  and `loopbackStatus.sweep(liveIds)` — the graph is what retires it.
* **owner-checked hand-over**, verbatim the `node-media-registry` discipline, because
  the card is remounted by view moves and Svelte gives no cross-tree ordering
  guarantee.
* the **body WRITES** the roster after a search; the **card READS** it in
  `nextResult()`; both call one shared `advance(nodeId)` that returns the next
  `PeerTubeVideo` or `null`.
* ⚠ **`nextResult()`'s empty-list branch must stop being `runSearch()`.** With the
  registry in place an empty roster means "no search has run", and the honest
  response to a clock edge is **nothing** — plus a `console.warn` naming the node, on
  the `delivered: false` principle (`camera-status-registry.ts:46-51`: *"'never
  pressed' and 'pressed and reached nothing' must be distinguishable"*).

⚠ **THIS IS A REAL PLATFORM-SHAPED ASK AND IT IS SCOPED TO ONE MODULE.** It is not a
new cell kind, not a new slot, not a widened type — it is a third instance of a
pattern the tree already has twice, in the same directory, with the same sweep. Its
cost is ≈ 3 h including the unit test. **Land it BEFORE the face** so the face PR is
not the thing introducing a live regression it also fixes.

⚠ **It also removes the need for a `peertube-status-registry`.** Everything the body
must SHOW is on `node.data` (`selectedHost`, `uuid`, `name`, `searchTerm`,
`instanceHost` — `peertube-query.ts`'s `PeerTubeData`) or on the engine handle
(`audioWired`, `hasVideoElement`, `uploadCount`) — **except `streamState`**, which is
card-local (`:122`) and is what #6's lamp needs (§7.2). **Put `streamState` on the
same browse registry rather than building a second one**; it is the same node, the
same lifetime and the same sweep.

### 2.3 THE OTHER LIFECYCLE SIDE EFFECTS — enumerated, per wave 5's instruction

The STOP-2 grep finds affordances a USER operates and is blind to what a card does
on the user's behalf. Enumerated: `PeerTubeCard.svelte` has two `$effect`s (`:162`,
`:482`) and two `onMount`s (`:206`, `:462`).

| site | what it does | after promotion |
|---|---|---|
| `$effect :162-204` | adopts the node-owned `<video>`; rehydrates the hls mirror; sets the nodeMedia disposer; binds play/pause/ended; **rehydrates `isPlaying` from the ELEMENT rather than assuming paused** (`:195`) | ✅ card stays mounted |
| `$effect :482-491` | ⚠ **on `(selectedHost, uuid)` change → `resolveAndAttach`**, with a `lastAttached` key guard | ✅ **and it is the seam the body needs.** A body-written selection reaches the stream through this effect. ⚠ **Its sibling has no equivalent, which is a live defect there** (`../archivist/spec.md §11 D1`) |
| `onMount :206-212` | hydrates `searchTerm` / `instanceHost` from `node.data` | ⚠ **moves to the body** — those inputs are the body's now |
| `onMount :462-477` | polls `attachExternalSource` until the engine accepts; starts the trigger loop; starts the 100 ms display timer | ✅ **stays on the card, and must** — `playhead`/`playing` are declared OUTPUT ports and a body is dock-only, so a rack whose CV stops when a pane collapses is a worse module than one whose preview stops (wave 5's midiOutBuddy argument) |

**So exactly one lifecycle behaviour breaks on promotion, and it is §2.2's.**

---

## 3. STOP 2 — does every way of getting DATA IN survive?

| entry point | today | after |
|---|---|---|
| typed search term | card `<input>` `:555`, debounced 350 ms | body `<input>`, same debounce, same `writeSearchTerm` |
| instance host | card `<input>` `:566` | body `<input>`, same writer |
| picking a result | card `<button class="result">` `:627-644` | body list row; same `selectResult` → `writeSelection` → the card's `$effect :482` resolves + attaches |
| `↻ next` | card button `:577` | body button → the shared `advance(nodeId)` (§2.2.1) |
| `play_trigger` via CV | `cv_play_trigger` + the 33 ms loop `:432-436` | ⚠ unchanged — `togglePlay()` (`:402-409`) touches only `videoEl`, no card-local roster. **Safe** |
| `next_trigger` via CV | `cv_next_trigger` + the same loop `:438-441` | ⚠⚠ **BROKEN BY PROMOTION unless §2.2.1 lands** |
| `gain` via CV | **none** — no input targets it | still none; §11 D5 |
| remote peer edit | Y.Doc → `$derived` on `selectedHost`/`uuid`/`name` → `$effect :482` | ✅ **works today, and keeps working** |
| a reloaded patch | the same `$effect :482` fires on hydrate | ✅ unchanged |

---

## 4. THE LANE PICTURE — **ACCEPTED, and unlike the sibling's it actually shows the video**

`laneGlyphFor` (`module-shell-model.ts:237-240`) returns `'picture'` for any
`domain: 'video'` def, before consulting `face.glyph`; `ModuleShell.svelte:1348`
renders `<VideoTileThumb nodeId={id} />` at `VIDEO_THUMB_W = 160` × 120, throttled to
`VIDEO_THUMB_FPS = 15` (`:250-252`), taking the `nodeId` — so it is per-node by
construction and costs nothing to author.

| loaded state | lane tile shows |
|---|---|
| a playing stream | **the stream**, live — `uploader.attach()` (§2.1) |
| loading / unavailable | the idle gradient (`peertube.ts:57-61`) |
| nothing selected | the idle gradient |

⚠ **Contrast the sibling, where the lane picture is the idle gradient for the
module's DEFAULT media type** (`../archivist/spec.md §4`). Same free mechanism, two
very different results, and the difference is again `uploader.attach()`.

The compact tile is picture + up to `LANE_ROW_MAX_CELLS_WITH_GLYPH = 2` cells
(`module-shell-model.ts:366`); this face has ONE ranked cell, so nothing is evicted
and the #1785 picture-outranks-controls rule never has to fire.

⚠ **`glyph: 'none'` is correct, and NOT for the reason the copied comment gives.**
`strict-faces.ts:835-837` and `picturebox.ts:309` both assert *"A video def has no
`audio` output"* — false here: `peertube.ts:120-121` declares `audio_l`/`audio_r` as
`type: 'audio'`, so `primaryAudioOutPortId` returns `'audio_l'`
(`shell-glyph-live.ts:111-113`) and `glyphBinding`'s *"any glyph + a primary AUDIO
output → live-audio"* rule (`:123`) fires, meaning the dead-glyph clause would NOT
redden a `glyph: 'meter'`. **The real reason is that `laneGlyphFor` never consults
`face.glyph` on a video def**, so any other value is authored and painted at no tier.
The full correction, and the list of other video defs it applies to, is
[`../archivist/spec.md §4.1`](../archivist/spec.md) — **fix the comment once, in
whichever of the two PRs lands first.**

---

## 5. THE FACE

### 5.1 RANK — `face.order`

```ts
face: {
  glyph: 'none',                 // §4
  order: ['gain'],
  paramCells: { gain: 'fader' },
  extension: 'peertube',
},
noUserControl: [
  { param: 'cv_play_trigger', writer: 'cv-port',
    why: 'the play_trigger jack writes this synthetic level through the CV bridge and the card edge-detects a rising crossing of 0.5 to toggle transport; it is a raw gate cache, never a value a player sets.' },
  { param: 'cv_next_trigger', writer: 'cv-port',
    why: 'the next_trigger jack writes this synthetic level through the CV bridge and a rising edge advances to the next search result; it is a raw gate cache, never a value a player sets.' },
],
```

One ranked key, for the same reason as the sibling: after the two synthetics are
declared, the module has exactly one player-facing param.

⚠ **`face.order: ['gain']` is only defensible if the shared `uGain` precursor lands**
(§0.1). If the owner refuses the shader edit, the face is **BLOCKED, not
downgraded** — `noUserControl` on a param nothing writes would be a gated assertion
that a defect is intentional.

`paramCells: { gain: 'fader' }` — a linear `0..2` multiply whose landmark is unity at
the middle of the throw reads better on a travel you can see than on a dial;
`picturebox` chose `'fader'` for the byte-identical param.

### 5.2 BANDS — one, and no tab rail

One ranked control is one band; `DOCK_TAB_MIN_BANDS = 7`.

⚠ **peertube is the module in this wave where a two-page split is most tempting —
SEARCH and PLAY — and it is refused on the module's own evidence.** The card puts
the results list DIRECTLY under the transport, in one scrolling column, and the
reason is behavioural: `markUnavailable` auto-skips to the next result after 1800 ms
(`:323-327`), and the `.result.sel` highlight (`:766`) is how you see it happen.
**Splitting the list from the picture would hide the module's own auto-advance from
the person watching it.** A page is a different IDEA; here they are one idea.

`face.tabbed` is OWNER-INSTRUCTION-ONLY with `spirographs` as its single adopter, and
this spec does not reach for it.

### 5.3 WIDTH — **EARNED TWICE, and the two claims need separate arguments**

The gate is `workflow-shell-faces.spec.ts:440-452`, and it measures **SLACK, not
size**: `slack = g.bodyW - g.contentW` against `FACE_WIDTH_SLACK_MAX_PX`, with a
`FACE_WIDTH_EXEMPTIONS` record that currently has **exactly one key, `moog912`**
(`:264`; verified by enumerating the record). ⚠ `cameraInput` and `loopback` are not
in it and their bodies are 480 px wide — **a body whose widest element is a picture
has near-zero slack by construction.**

**CLAIM 1 — the PICTURE.** A live video preview is a named legitimate earner in the
owner ruling (*"A genuine earner is a live picture, a scope trace, a video preview,
an XY pad…"*), and this one is a video preview literally. Sized off the shipped
precedent (`CameraInputOutputBody.svelte:262-266`): **480 × 270**, 16:9 rather than
cameraInput's 4:3 because that is the card's own aspect (`:707-708`,
`aspect-ratio: 16 / 9`) and because a federated video is 16:9.

**CLAIM 2 — the RESULT LIST, and it is a DIFFERENT claim.** The brief is right that
this needs its own argument, because "a list is long" earns HEIGHT, not WIDTH. The
measurement:

| row element | card | body |
|---|---|---|
| thumbnail | `48 × 27` (`:767`) | **64 × 36** — a 48 px thumb at the dock's density is unreadable; 64 is the smallest 16:9 that resolves a face |
| title | `font-size: 0.64rem`, ellipsised (`:770`) | fills; ellipsised |
| sub-line | `channel · host · LIVE · duration` (`:642`) | ⚠ **TRIMMED to `host`** — §7 |

`[64 thumb] + 6 gap + [title ⇢flex]` at a legible size wants **≈ 300 px minimum** and
is comfortable at 480. **So the list does not drive the width; it fits inside the
width the picture already earns.** That is the honest form of the second claim: the
list is not a second earner, it is a passenger. ⚠ **If a build finds itself widening
the plate for the list, the trim in §7 has not been applied** — the card's four-field
sub-line is what makes a row want 600 px, and three of its four fields are refused
resting text anyway.

**HEIGHT is the real constraint and it is not this gate's subject.**
`DockFullView.svelte:371` is `max-height: min(60vh, 680px)` with its own scroll
region. The list therefore gets its own `overflow-y: auto` inside a fixed
`max-height`, exactly as the card does (`:752-758`), so the pane scrolls the FACE and
the list scrolls the RESULTS — never both at once.

⚠ **And the dock VRT scene sees only the TOP ~425 px** (`module-faceplates.md`,
VRT trap 1). With the picture at 270 px plus the query rows, **the results list is
mostly below the fold in the baseline.** That is fine — §9 shows the scene captures
an EMPTY list anyway — but a reviewer must not read a green dock baseline as evidence
the list renders. `faces-parity` and the §13 e2e are what see it.

### 5.4 CONTROL INVENTORY

| face element | primitive | why not the alternative |
|---|---|---|
| GAIN | ranked param cell, `'fader'` | §5.1 |
| the picture (lane) | `VideoTileThumb` via `hasVideoSurface` | automatic (§4) |
| the picture (dock) | the body's blitted `<canvas>` | the dock hero glyph is capped at `DOCK_HERO_GLYPH_W` and is *"a picture, not a surface"* |
| SCREEN ON/OFF | body button, overlaid bottom-right | §6.4 |
| search / instance | body `<input>` | no cell paints text (§0.4) |
| ↻ NEXT | body `<button>` | a `ShellActionCell` needs a probe **and** must reach the roster — §6.1 |
| the RESULT LIST | body | §6.1 walks the ladder |
| PLAY/PAUSE | body `<button>` | ⚠ a `ShellToggleCell` is *almost* right and §6.1 refuses it: transport is not `node.data` |
| ⚠ the PROGRESS BAR | ⚠ **becomes a real SEEK control** — §5.4.1 | — |

#### 5.4.1 ⚠ THE PROGRESS BAR SHOULD BECOME A SEEK BAR, AND THAT IS A GAIN THE FACE MAKES POSSIBLE

`PeerTubeCard.svelte:613` is `<div class="bar"><div class="fill" style="width: {displayFrac*100}%"></div></div>` —
**a read-only fill.** Its sibling has a real `<input type="range">` seek control
(`ArchivistCard.svelte:756-767`) over the same underlying quantity.

Under the resting-text ruling this matters more than it looks: a **non-interactive
bar showing a derived value is decoration for a measurement**, which is the shape the
ruling refuses; a **draggable seek control** is a control whose position IS the value,
which is the shape it permits (the `aria-valuetext` carries `"3:41 of 12:08"` and the
plate paints nothing). **The honest fix and the compliant fix are the same fix**, and
it is the third time in this program that has happened — `BINDERS.md §6` records
chromaconsole's VRT-determinism pass independently arriving at most of the
resting-text ruling.

**So: an `<input type="range">` bound to `videoEl.currentTime`, with the same
`clampSeek` semantics `archivist-scrub.ts:13-18` already implements.** ⚠ Import it
rather than re-writing it — it is a pure, unit-tested module (`archivist-scrub.test.ts`)
whose name is the only thing tying it to archivist. Renaming it is a basis-file move
and therefore **not** free (§10.1); **import it under its current name and say so in
a comment.**

⚠ **HLS SEEKING IS NOT FREE, AND THIS IS THE ONE THING TO VERIFY BEFORE BUILDING IT.**
A live stream (`v.isLive`, `peertube-query.ts`) has no meaningful duration, and
hls.js seeking in a VOD is bounded by the buffered range. **M4 in §13 is the
measurement**, and the fallback if it bites is honest: keep the bar read-only for
`isLive` streams and disable the control, exactly as the sibling disables its seek at
`durationSec <= 0` (`ArchivistCard.svelte:764`).

---

## 6. THE BODY — `face.extension: 'peertube'`, slot `fullViewBody`

### 6.1 WHY NOT A CELL — the ladder, and the RESULT LIST refused at four rungs for four reasons

| rung | candidate | refusal |
|---|---|---|
| **1a. `selector`** | the RESULT LIST | ⚠ **The one the brief asks about, and it fails MECHANICALLY before taste enters.** `ShellSelectorCell.options` is `(node: ModuleNode \| undefined) => SelectorOption<string>[]` (`shell-cells.ts:171`) — **a pure function of the NODE.** The roster is card-local `$state` (`:117`), not on `node.data` and not on the engine handle (`peertube.ts:348-356`). ⚠ **This is NOT wave 4's `env` question** (refuted in `BINDERS.md §1`: `getActiveEngine()` already reaches the engine from plain `.ts`) — the state is in a Svelte component, which no engine handle can see. And even after §2.2.1 puts the roster on a node-keyed registry, three more objections stand: a `SelectorOption` is `{value,label}` with **no thumbnail**, dropping a picture the card has; the cell would need a `controlFamilies` entry, which **IS in the contract** (`contract-lock` moves + a `docs.controls` entry for STRICT_DOCS completeness); and a ranked selector competes with `gain` for band space when it is not a control of the module, it is a library |
| **1b. `action`** | ↻ NEXT | `ShellActionCell.probe` is REQUIRED (`shell-cells.ts:157`). Post-§2.2.1 a `data` probe on `node.data.uuid` would actually be expressible — **and it would still be the wrong shape**, because a NEXT button separated from the list it walks is a button whose effect you cannot see |
| **1c. `toggle`** | PLAY/PAUSE | `ShellToggleCell` is a 0/1 LATCH on `node.data` (`:315-320`). ⚠ peertube's transport is deliberately **not** on `node.data`: `isPlaying` is card-local (`:123`) and rehydrated **from the element** on adopt (`:195`, *"it may well have been playing all along"*). Syncing it would assert one person's playback state onto every rack-mate — the same argument `camera-status-registry.ts:38-43` makes about permission grants. ⚠ Note the sibling made the OPPOSITE choice (`ArchivistData.isPlaying`, shared) and is right to, because an archive item is a file every peer can hold at the same offset while a live federated stream is not |
| **1d. `file`** | — | nothing is loaded from disk |
| **2. `panel`** | the list | ⚠ **Genuinely expressible, and still wrong.** `ShellPanelProbe` requires a testid to click and something that must change — `peertube-result` and `node.data.uuid` satisfy both, and it would be a `data` probe rather than the `data-rev` shape the file outlaws. It is refused because a panel is a **ranked key in `face.order`** (making a library compete with a control for band space), because `shell-cells.ts:331-336` forbids `control-<paramId>` testids inside it, and because a panel is *"one picture you edit"* — it cannot also hold the two text inputs that produce the list |
| **3. `fullViewBody`** | everything | wired (`shell-extensions.ts:124`), takes `nodeId`, no probe, no cell contract; *"The bands BELOW are untouched: every param still gets its cell, so face completeness, the dock render-plan parity gate and `faces-parity` all still apply"* |

**NEVER `editorSurface`** — declared and unwired (`shell-extensions.ts:118`); the
first adopter must wire the render site in `ModuleShell` in the same diff.

### 6.2 THE PRECURSOR — `peertube-browse-registry`, and it is the one thing in this cohort that IS new code

Argued in §2.2.1. Restated here as the build contract:

```ts
// $lib/ui/media/peertube-browse-registry.ts
export interface PeerTubeBrowseState {
  results: readonly PeerTubeVideo[];
  index: number;                       // -1 = nothing selected
  stream: 'idle' | 'loading' | 'playing' | 'unavailable';
}
peertubeBrowse.read(nodeId): PeerTubeBrowseState | null
peertubeBrowse.publish(nodeId, patch: Partial<PeerTubeBrowseState>, owner: object): void
peertubeBrowse.subscribe(nodeId, fn): () => void
peertubeBrowse.advance(nodeId): PeerTubeVideo | null   // ⚠ returns null on an empty roster; never searches
peertubeBrowse.sweep(liveIds: readonly string[]): void
```

* **`advance` returning `null` is the §2.2 fix**, and the card's edge handler logs a
  named warning on `null` rather than swallowing it (`delivered: false` discipline).
* **`stream` lives here rather than in a second registry** (§2.2.1) — same node, same
  lifetime, same sweep.
* ⚠ **Owner-checked publish**, verbatim `node-media-registry`'s reason: the card is
  remounted by view moves and Svelte gives no cross-tree ordering guarantee.
* ⚠ **NEVER Yjs.** These are a cache of a third-party query and one browser's
  playback state.
* ⚠ It lives under **`lib/ui/**`, NOT `lib/video/**`** — that directory is hashed
  wholesale for the WebGL attest, and `camera-status-registry.ts:59-63` records the
  same constraint on itself in as many words. **Do not put it in `video/`.**
* Sweep row added beside `cameraStatus.sweep(liveIds)` / `loopbackStatus.sweep(liveIds)`
  in `Canvas.svelte`'s existing node-sweep `$effect`.

**Cost ≈ 3 h with its unit test**, and the unit runs in `environment: 'node'` because
there is no DOM in it — the same property `camera-status-registry.ts:64-66` claims for
itself.

### 6.3 THE COMPONENT

`packages/web/src/lib/ui/modules/peertube/PeerTubeBrowserBody.svelte`, registered
through `packages/web/src/lib/ui/modules/peertube/shell-extension.ts`.

Top to bottom (mocks: [`dock.html`](dock.html), [`dock-results.html`](dock-results.html)):

1. **the PREVIEW** — a 480 × 270 `<canvas>` blitting `blitOutputForPreview(nodeId)`
   (§2.1), with the **SCREEN ON/OFF** button overlaid bottom-right on a
   `rgba(5,6,8,0.72)` backplate (§6.4) and the transient `loading…` overlay.
   ⚠ The empty state paints `SEARCH, THEN PICK A VIDEO` into the canvas (§7.3).
2. **the QUERY block** — row 1 `[search the fediverse…]`, row 2
   `[instance (optional)][↻ NEXT]`. Same 350 ms debounce (`:226-231`), same
   rate limiter (`:215-224`), same `writeSearchTerm`.
3. **the NOW-PLAYING row** — the video NAME (§7.1) and the host as a link to
   `watchUrl(selectedHost, uuid)`, plus the STREAM lamp (§7.2).
4. **the TRANSPORT** — `[PLAY/PAUSE]` + the seek control (§5.4.1).
5. **the RESULTS LIST** — `overflow-y: auto` inside a `max-height`, one row per
   result: `[64×36 thumb][title][host]`, with `.sel` on the current index.
6. **the DISCLAIMER** — verbatim (§7.4).
7. transient error / status rows, absent at rest.

⚠ **Do not re-implement the writers or the attach machine.** `writeSearchTerm` /
`writeSelection` (`:139-159`) move to **`$lib/graph/peertube-data.ts`**; `runSearch`,
`resolveAndAttach`, `attachStream`, `markUnavailable`, `teardownHls` and
`ensureAudioWired` (`:240-399`) move to
**`$lib/ui/modules/peertube/peertube-stream.ts`** as plain functions taking
`(nodeId, videoEl, engine)`. ⚠ **`ensureAudioWired`'s un-mute step
(`:389-395`) is the module's most fragile line and has a dedicated e2e regression
guard (§8) — move it, do not rewrite it.**

### 6.4 SCREEN ON/OFF — required, and the watch mark answers itself

`video-face-screen-source.test.ts` is deny-by-default over `STRICT_FACES ∩ video
defs`; its `NO_SCREEN_SWITCH` list has exactly one entry (`videoOut`). **peertube
gets the switch.** State on **`node.data.previewCollapsed`** (the shared key, so a
pre-promotion rack does not silently re-open and the state survives dock collapse /
LRU eviction — the #1531/#1574/#1583 class); OVERLAID bottom-right, never a stacked
row (the named anti-pattern that cost ~18.8 px against ~11 px of slack); OFF skips
the PAINT, never the engine read.

⚠ **THE #2015 WATCH-MARK ARGUMENT IS A NON-QUESTION HERE, BY DERIVATION.**
`engine.ts:1170-1177`:

```ts
private isPullExempt(nodeId: string, handle: VideoNodeHandle): boolean {
  if (handle.audioSources && handle.audioSources.size > 0) return true;
  …
}
```

`peertube.ts:196-219` unconditionally populates `audioSources` with six entries
(`audio_l`, `audio_r`, `loaded`, `ended`, `playing`, `playhead`) whenever
`ctx.audioCtx` exists, so **`isPullExempt` is structurally TRUE from construction**
and the node cannot leave the pull set. The engine's own comment names the class:
*"the video players' soundtracks"*.

**Call `markWatched(nodeId)` in the collapsed branch anyway**, exactly as
`CameraInputOutputBody.svelte:216-220` does — belt-and-braces on a derivation this
body does not control — **and write the comment saying that is what it is**, so a
future reader does not delete it as redundant or keep it for the wrong reason.

### 6.5 `EXTENSION_BODY_ROLES` — `picture`

`face-rack-status-source.test.ts` is deny-by-default over every `fullViewBody`,
derived off the DIRECTORY (`:100-115`), with a mechanical predicate per role
(`:473-491`): `picture` ⇒ `paintsCanvas(src, extId)`.

⚠ **CORRECTION TO THIS WAVE'S BRIEF, MEASURED on `ea2e06340`:** the brief names three
roles (`picture`, `status-primitive`, `control-grid`, the last *"added by #2184"*).
**There are TWO.** `:142` is `type BodyRole = 'picture' | 'status-primitive';`,
`ROLE_PREDICATE` has two keys, and `:695` asserts the population literally:

```ts
expect([...roles].sort()).toEqual(['picture', 'status-primitive']);
```

`git log --grep=2184` returns nothing on this tree. **`control-grid` does not exist**,
and adding a third role means editing the union, the predicate record **and** that
hand-enumerated assertion. **peertube does not need one** — its body mounts a canvas
and `picture` is the honest role, exactly as `quadralogical`'s entry (`:280-296`)
reasons for the one body that is also a control: *"this body mounts canvases, so the
`status-primitive` predicate (`StatusLed` and NO canvas) would refuse it, and the role
that describes what a reviewer will see on the surface is the picture one."*

**The `why` string to commit, verbatim:**

> `peertube: { role: 'picture', why: "the fediverse browser's live stream preview — a genuine blit of the module's OWN output texture, because peertube.ts:341-347 DOES call uploader.attach() (PeerTube sends ACAO:* on the final media hop, so the element is untainted) — plus its SCREEN switch, the search + instance fields, the transport with a real seek control, and the RESULT LIST. ⚠ THE LIST IS ON THIS SURFACE AND NOT BEHIND A `selector` CELL for a mechanical reason: a ShellSelectorCell's options closure is a pure function of the NODE, and the roster is a per-node CACHE OF A THIRD-PARTY QUERY that must never enter the Y.Doc — it lives in $lib/ui/media/peertube-browse-registry, which the CARD also reads so a clocked next_trigger advances the list instead of firing a fresh Sepia search per pulse. ⚠ TEXT ON THIS SURFACE, exhaustively: each result's TITLE and HOST and the now-playing NAME (NAMES, not measurements — the cameraInput device-name precedent), the control captions on its buttons and inputs, the two-link Sepia Search / PeerTube ATTRIBUTION DISCLAIMER (a licensing obligation, not a readout), the literal placeholder SEARCH, THEN PICK A VIDEO painted into the empty canvas (the samsloop/twotracks NO SAMPLE LOADED shape), and a transient ERROR that is absent whenever nothing is wrong. ⚠ NOT on it: each row's DURATION and LIVE badge, and the 'display unavailable — skipping' state word the card painted over the picture — all deleted rather than hidden, the duration to the row's aria-label and the stream state to a StatusLed's aria-label. ⚠ NO WATCH-MARK ARGUMENT IS NEEDED: peertube populates six audioSources at construction, so engine.ts isPullExempt is structurally TRUE and the node never leaves the pull set; the body marks anyway, as belt-and-braces on a derivation it does not control." }`

---

## 7. RESTING TEXT — the exhaustive disposition

`face-resting-text-source.test.ts` denies the SHAPE and enumerates the permitted
ROLES (module NAME, TAB/SECTION labels, CONTROL CAPTIONS, OPTION/LANDMARK NAMES).
⚠ **It states its own blind spot: text inside a `fullViewBody` is module-owned markup
and invisible to it.** So this section is enforced by the dock VRT baseline, a human
reviewing it, and `peertube-face-model.test.ts`'s source assertions — **and nothing
else.**

| # | card text | site | verdict | replacement |
|---|---|---|---|---|
| 1 | result TITLE (`v.name`) | `:641` | ✅ **KEPT** — §7.1 | — |
| 2 | now-playing NAME | `:602` | ✅ **KEPT** — same call | — |
| 3 | result sub-line `{channel} · {host}{LIVE} · {duration}` | `:642` | ⚠ **TRIMMED to `{host}`.** The HOST disambiguates two same-titled videos on different instances and is half the identity of a federated item, so it is part of the NAME. **The CHANNEL is attribution** — kept on the row's `aria-label`, and present in full on the linked watch page. **`LIVE` is a state word.** **`formatDuration(v.duration)` is a measurement** | both to `aria-label` on the row button: `"{name} — {channel} on {host}, {duration}{, live}"` |
| 4 | attribution link text `{selectedHost}` | `:605` | ✅ **KEPT** — a host is a name, and the link needs a visible target | — |
| 5 | `display unavailable — skipping` | `:595` | ⛔ **REMOVED as text; the FINDING becomes a lamp** — §7.2 | `StatusLed` |
| 6 | `loading…` | `:593` | ✅ **KEPT** — transient, absent at rest, feedback on a gesture | — |
| 7 | `search, then pick a video` | `:597` | ✅ **KEPT, painted INTO the canvas** — §7.3 | — |
| 8 | `Slow down — too many searches…` / `Search failed: …` / `No results — …` / `Could not resolve: …` | `:242`, `:260`, `:257`, `:299` | ✅ **KEPT** — errors with recovery, absent whenever nothing is wrong (`CameraInputOutputBody.svelte:292-298` names this exception) | — |
| 9 | `Searching the fediverse…` / `Resolving stream…` | `:247`, `:284` | ✅ **KEPT** — transient status | — |
| 10 | placeholders `search the fediverse…`, `instance (optional)` | `:558`, `:569` | ✅ **KEPT** — control captions in the `<input>` idiom | — |
| 11 | button captions `↻ next`, `Play`/`Pause` | `:582`, `:612` | ✅ **KEPT** | — |
| 12 | the DISCLAIMER | `:649-652` | ✅ **KEPT VERBATIM** — §7.4 | — |
| 13 | the progress BAR | `:613` | ⚠ **becomes a CONTROL rather than being deleted** — §5.4.1 | `aria-valuetext` |

### 7.1 THE RESULT TITLE — the wave's owner call, and the ruling is the sibling's

**The question:** is a search result's TITLE an "option/landmark NAME that
disambiguates a control's own position", or a "derived value"?

Both readings are written out in full at
[`../archivist/spec.md §7.1`](../archivist/spec.md) and are not repeated. **This spec
rules the same way — (A), it is a NAME — on the same ground:** the shipped,
deny-by-default-rostered `cameraInput` entry
(`face-rack-status-source.test.ts:381`) classifies a **runtime-enumerated device
label** as *"a name, not a measurement — the cvBuddy precedent"*. A camera's label is
also content the app did not author, arriving from outside the process, different on
every machine. **A federated video's title is the same shape.**

⚠ **THE STAKES ARE HIGHER HERE THAN ON THE SIBLING, and that is why the escalation
lives in both specs rather than one.** archivist shows ONE title and would survive
its loss (the item is identified by the picture). **peertube's entire interaction is
choosing among twenty-four of them.** Under ruling (B) the result list becomes a
column of 64 × 36 thumbnails with a hostname under each — which is not a smaller
version of the feature, it is a different and much worse one.

⚠ **AND THE RULE STILL CUTS HERE**, which is the test that it is a rule rather than a
convenience: on this very surface it refuses the DURATION, the `LIVE` badge, the
CHANNEL, the stream state and the elapsed time — **five of the card's thirteen text
elements go.**

> **OWNER DECISION 1 (shared with `archivist`) — is a network-fetched item TITLE
> permitted resting text on a faceplate, as a NAME (the shipped cameraInput
> device-name precedent), or refused as third-party content the app did not author?**
> It applies to these two modules and to nothing else in the fleet. **Neither face is
> BLOCKED either way** — under (B) the titles move to `aria-label` and every gesture
> survives — but peertube's usability is materially worse, and that cost belongs to
> the owner rather than to a build agent.

### 7.2 REMOVING `display unavailable` REMOVES A FINDING — here is where it goes

CLAUDE.md: *"say which finding lost its surface rather than letting the coverage
quietly lapse."*

`PeerTubeCard.svelte:594-595` is the only place the product tells a player that
**this instance's CORS is misconfigured and the stream will never arrive.** The
def's docs say it (`peertube.ts:138`, *"~1/6 instances misconfigure CORS (raw S3, no
ACAO)"*), but that is the docs site. On the card it is one amber line over the
picture, and it is what turns "my patch is broken" into "this instance is broken,
and I am about to be moved to the next result".

**It survives as a `StatusLed`** (`$lib/ui/controls/StatusLed.svelte`, gated by
`status-led-source.test.ts`): a static literal caption, a boolean lamp that IS the
picture, `detail` reaching `aria-label`/`title` and never a text node. Driven off the
browse registry's `stream` field (§6.2):

| lamp | `stream` | `aria-label` |
|---|---|---|
| lit | `'playing'` | *"Streaming: frames are arriving and feeding the video output; the stereo audio tap is wired."* |
| amber | `'loading'` | *"Resolving and buffering this instance's stream."* |
| red | `'unavailable'` | *"This instance's media is unreachable — a CORS-misconfigured host, a dead stream, or a 14-second timeout. Skipping to the next result shortly."* |
| dim | `'idle'` | *"Nothing selected."* |

Caption beside it: the literal `STREAM`. ⚠ **Not a changing caption** — that is the
readout wearing a shorter label, and *"there but hidden"* was refused by name.

⚠ **`data-stream-state` on the card root (`:542`) is what four e2e assertions read**
(`peertube.spec.ts:266`, `:324`, `:325`, `:396`). It is an ATTRIBUTE, not painted
text, and **the body must re-emit it** — §8.

### 7.3 IN-CANVAS TEXT — the ruling is made and applies verbatim

Wave 5's `GAMES.md §1`: pixels a module renders into its OWN surface are ARTWORK; a
labelled value in a chrome row beside the surface is refused. `samsloop`'s
`NO SAMPLE LOADED` and `twotracks`' `NO TAPE` are both accepted on the roster
(`face-rack-status-source.test.ts:216`, `:221`) as *"a placeholder naming the
surface's own condition, not a measurement of any control"*, with `twotracks` adding
the reason to draw it rather than leave it blank: *"'no tape yet' and 'the body
failed to mount' are different pictures, which matters because the fresh-spawn empty
state is what the dock baseline captures."*

**peertube's empty state is exactly that**, and §9 shows it is the ONLY state its
baselines will ever capture. The canvas paints the literal
`SEARCH, THEN PICK A VIDEO` in its empty branch **and nothing else** — no title, no
timecode, no progress.

### 7.4 ⚠ THE DISCLAIMER IS KEPT VERBATIM, AND IT IS NOT A READOUT

`PeerTubeCard.svelte:649-652`:

> *"Federated public videos via the [PeerTube] fediverse · search by [Sepia Search]."*

Two live links, static text, no derived state. ⚠ **This is the only text in either
module whose removal would be a LICENSING/ATTRIBUTION question rather than a design
one**, and the resting-text ruling has nothing to say about it: it names no
measurement, no value and no state word, and it does not restate a control. It is
closer to the module NAME than to anything the ruling deletes.

**KEPT, verbatim, both links live**, at the bottom of the body under a divider
exactly as the card has it. Recorded explicitly because a mechanical application of
"delete non-control text" would remove it, and that would be the one deletion in this
cohort with a consequence outside the product.

---

## 8. THE E2E SURFACE — three specs, all `?shell=legacy`, all GREEN-AND-BLIND after promotion

`e2e/tests/peertube.spec.ts` (401 lines, three tests) boots
`/rack?shell=legacy&seed=none` (`:175`, `:284`) and drives the LANE CARD by testid.
Under `?shell=legacy` the lane renders the legacy card for a migrated module too, so
**all three keep passing while testing a surface the shipping default shell parks at
`left:-9999px` with `pointer-events: none`** — wave 5's `README §4` class verbatim.

Testids and disposition:

| testid | card site | body |
|---|---|---|
| `peertube-card` | `:541` | ⚠ **do not re-emit.** Rename to `peertube-browser-body` |
| `peertube-search` | `:562` | re-emit |
| `peertube-instance` | `:572` | re-emit |
| `peertube-next` | `:580` | re-emit |
| `peertube-preview` | `:587` | re-emit on the wrap |
| `peertube-video` | set in `init` `:174` | ⚠ **unchanged — it lives on the NODE-OWNED element**, set by `nodeMedia.adopt`'s `init`. This is why `:314`, `:350` and `:374` (the un-mute assertion) survive a re-point untouched |
| `peertube-loading` / `-empty` | `:593`, `:597` | re-emit; ⚠ `-empty` becomes canvas text (§7.3), so its assertion moves to a canvas probe or to the wrap's `data-empty` |
| `peertube-unavailable` | `:595` | ⚠ **replaced** by the lamp (§7.2). `data-stream-state` is what the specs actually assert |
| `peertube-now-playing` | `:602` | re-emit; `peertube.spec.ts:254` asserts its text |
| `peertube-play` / `-bar` | `:612`, `:613` | re-emit; ⚠ `-bar` becomes an `<input type="range">` (§5.4.1) |
| `peertube-error` / `-status` | `:618`, `:621` | re-emit |
| `peertube-result` | `:633` | re-emit; `:246-247`, `:305-306`, `:390-391` drive it |
| `peertube-disclaimer` | `:649` | re-emit (§7.4); `:267` asserts it |
| `peertube-resize-handle` | `:661` | ⛔ not carried; no spec asserts it |
| `data-stream-state` / `-has-selection` / `-is-playing` | `:542-544` | ⚠ **re-emit on the body root.** Seven assertions read them |

⚠ **THE AUDIO TEST IS THE ONE TO PROTECT.** `peertube.spec.ts:273-377` is *"the
regression guard for the operator-reported 'video module = no audio'"* and it asserts
`out.peak > 0.01` at the AUDIO OUT terminal **plus** that the element is un-muted
(`:374-375`). It drives the REAL HLS path. **Re-point it, do not weaken it**, and
keep its capability gate (`:326`) intact.

⚠ **`peertube` is in `_face-fixtures.ts`'s `DENIED` map** (`:111-113`) — and its
reason is wrong twice (§11 D2, D3). ⚠ And note the trap that file documents about
itself twice (`:66-88`, `:89-100`): a `DENIED` entry for a **promoted** module goes
INVISIBLE rather than red, because the loop filters on `unpromoted`. **Two entries
have already been deleted by hand for exactly this.** peertube's must be corrected
at promotion time, not left to rot.

---

## 9. VRT — the exemption is ALREADY PERMANENT; only the FACE scenes are in question

* **`EXEMPT_FROM_VRT:902`** — *"live external PeerTube HLS `<video>` +
  runtime-fetched, ever-changing Sepia-Search results + live thumbnails defeat
  deterministic capture (same as tvLibrarian/videobox); pure-core unit tests
  (query/parse/stream-resolve) + network-mocked e2e provide coverage"*.
* **`ALLOWED_PERMANENT_EXEMPT:1181`** — peertube is in it.
* **No `vrt.spec.ts` baseline exists** (`ls e2e/vrt/__screenshots__/vrt.spec.ts/ |
  grep peertube` → nothing).

**Promotion moves ZERO baselines and adds at most TWO.**

### 9.1 THE DETERMINISM VERDICT — **CAPTURABLE**, and the argument is `samsloop`'s

The exemption's stated reasons are all about a LOADED node. The scenes do not spawn
one. Mapping `_shell-faces.ts`'s `samsloop` entry (`:2823-2846`) row by row:

| samsloop's condition | peertube's equivalent | verified at |
|---|---|---|
| *"a freshly spawned samsloop holds NO SAMPLE, so the body takes its empty branch"* | a fresh peertube has `selectedHost`/`uuid`/`name` all null, so the `$effect :482-491` returns early and nothing attaches | `:486` (`if (!host \|\| !vid \|\| !videoEl) return;`) |
| *"IDLE-BY-DEFAULT with no autoplay"* | `streamState: 'idle'`, `isPlaying: false`, and the transport block is `{#if uuid}` so it does not render at all | `:610` |
| *"the live RECORD branch … is reachable only after a REC press, which no VRT scene performs"* | ⚠ **the results list is empty and the network is reachable only after a TYPED search, which no VRT scene performs** | §9.1.1 |

#### 9.1.1 ⚠ THE THIRD ROW IS A MEASUREMENT, AND IT IS THE ONE A REVIEWER SHOULD RE-RUN

Every caller of `runSearch` enumerated:

* `onSearchInput` (`:227-231`) — fires on `oninput`, i.e. **a keystroke**, then a
  350 ms debounce;
* `onSearchKeydown` (`:232-238`) — Enter;
* `nextResult()` when `results.length === 0` (`:276`) — reachable only from the ↻
  button or a `next_trigger` edge.

`onMount` (`:206-212`) hydrates two strings from `node.data`; `onMount` (`:462-477`)
starts the attach poll, the trigger loop and the display timer. **Neither fetches.**

⚠ **AND THE SHIPPED RECORD SAYS OTHERWISE** — `_face-fixtures.ts:111-113` claims
peertube *"queries a remote PeerTube instance over the network at mount"*. **It does
not** (§11 D2). Two independent readings agreed, which is why this is stated as a
measurement rather than a belief: a spawned-and-never-typed-into peertube makes zero
network requests.

**VERDICT: `peertube` does NOT need a `FACES_WITHOUT_SCENES` entry and does NOT need
a `simPin`.** Its face scenes capture normally, from a cold, empty, offline state.

⚠ **The scope of that verdict, stated so a future scene cannot silently break it:**
it is about the CAPTURE STATE, not about the surface being pure. **If a future scene
ever spawns peertube with a persisted `uuid`** — e.g. from a seeded rack — the
`$effect :482` fires, the network is hit, and the baseline becomes a picture of
whatever a third-party server returned that minute. **`seed=none` is load-bearing,
and the scene must assert the results list is EMPTY** rather than merely capturing.

### 9.2 THE ONE THING TO CHECK BEFORE TRUSTING THIS

The empty canvas paints the idle gradient (`peertube.ts:57-61`,
`vec4(0.05, 0.04, 0.09 + vUv.y*0.06, 1.0)`) — a pure function of `vUv`, no clock, no
RNG. But the body composes it through `blitOutputForPreview`, which is
CADENCE-GATED (`engine.ts:1663-1673`), so a cold-open capture can catch the 2-D
canvas before its first blit — i.e. transparent-black rather than the gradient. **M5
in §13**, and the fix if it bites is `{ immediate: true }` (`engine.ts:1650-1660`,
the #1836 TOYBOX case where 2 of 12 rendered frames were presented).

### 9.3 BOTH COST ARTIFACTS RE-PIN

Two new `vrt-strict` scenes ride the median until measured, and that has reddened
`main` at 92 % of a shard budget with every test passing. `task e2e:timings:accept`
**and** `task vrt:strict:timings:accept`, both diffs reviewed.

Dispatch **scoped**: `GREP=peertube flox activate -- task vrt:commit`. ⚠ A bare
dispatch on a face PR derives FULL. **Predict TWO files and count what the bot
commits; a green dispatch that committed nothing is a RED FLAG.**

---

## 10. COST

### 10.1 ⚠ WEBGL ATTEST — TWO BASIS FILES, ONE EXPENSIVE EDIT, AND IT SHARES A WINDOW WITH THE SIBLING

```
$ flox activate -- bash scripts/webgl-attest-hash.sh --list | grep -i peertube
packages/web/src/lib/video/modules/peertube-query.ts
packages/web/src/lib/video/modules/peertube.ts
```

| edit | file | attest |
|---|---|---|
| `face: { … }` on `peertubeDef` | `peertube.ts` | **ZERO** — `HASH_TRANSPARENT_PROPS` strips it |
| `noUserControl: [ … ]` at the DEF's top level | `peertube.ts` | **ZERO** ⚠ top level, not nested inside a `ParamDef` — wave 4 measured the nested version MOVING the hash and nearly filed it as a platform defect |
| the D2/D4/D6 comment + docs fixes | `peertube.ts` | **ZERO** — the parser drops comments and `docs` |
| **`uGain` (§0.1)** | `peertube.ts` | ⚠ **MOVES THE HASH** |
| the body, the browse registry, the extension, the registries, the e2e | `lib/ui/**` | **ZERO** — not in the basis ⚠ which is exactly why §6.2 puts the registry in `lib/ui/media/` |
| `paramSpec(...)` | n/a | ⚠ **NOT APPLICABLE.** `PeerTubeCard.svelte` renders **no param control at all** — there is no `min=`/`max=` prop to bind, so the `card-range-source` question does not arise on this card. The new `gain` fader is a ranked cell, which reads the `ParamDef` through `ModuleShell`'s own path |

**PR SHAPE — ONE attest window for the whole cohort:**

* **PR A — "wire the inert output gain on the four video sources that declare it and
  ignore it"**: `peertube.ts`, `archivist.ts`, `videobox.ts`, `tvLibrarian`. **ONE
  attest.** Byte-identical at defaults (§0.1), so no owner pixel preview is needed.
  ⚠ Verify with a two-way frame-signature control: unchanged at `gain = 1.0`, MOVED
  at `gain = 0.5`.
* **PR B — the browse registry** (§6.2). `lib/ui/**` only. **ZERO attest.** Land it
  alone: it fixes a live-after-promotion regression and deserves its own review.
* **PR C — the peertube face.** `face` + `noUserControl` + the body + the extension +
  the registries + the e2e re-point + D3/D4/D6. **ZERO attest.**

⚠ **Attest a pin covers a TREE, not a PR.** Match CI's refusal hash before spending
the GPU; never measure attest state in a dirty primary checkout.

### 10.2 ART — ZERO, measured

No `art/baselines/peertube/`. The audio profile gate enumerates **audio-domain ids
only** (`art/scenarios/_meta/audio-profile-gate.test.ts`, matching
`/^(\S+) meta domain=audio\b/` off the contract golden), and peertube is
video-domain — so it needs to be in neither `ART_EXCLUDED` nor `ART_BACKLOG`.
**`art/` should be absent from this diff.**

### 10.3 CONTRACT — unchanged

`face` is fully contract-transparent; `docs` too. **`controlFamilies` is NOT**, and
this face declares none — one more reason §6.1 refuses the `selector` rung.
`docs.controls.gain` is edited (D4), so `task docs:accept` should produce an **empty**
`contract-lock.txt` diff. ⚠ A non-empty diff means the I/O contract moved — stop and
read it.

### 10.4 THE PUSH 2 CARD MOVES

peertube has no explicit `PUSH_CARD_CONTROLS` entry, so **a first promotion moves it
from GENERIC to FACE** (`push-card-config.ts:20-33`) — the whole card changes.
Declaring `noUserControl` additionally drops **both** `cv_*` params
(`push-card-schema.ts:96-98`). Both changes are improvements and both are behaviour
changes outside the faceplate; the PR body must say so and
`push-card-schema.test.ts` is a must-run (§14).

### 10.5 CI WALL-TIME

New: two VRT face captures (they ride the scoped dispatch), one new unit file
(`peertube-face-model.test.ts`), one new unit file for the registry
(`peertube-browse-registry.test.ts`, `environment: 'node'`, ~0 cost), and the three
existing `peertube.spec.ts` tests re-pointed at the dock — adding a dock-open step
each and removing nothing.

`faces-parity` budgets CI at roughly `10 s + 0.8 s/cell`; this face has ONE cell.
**Estimated PR delta: well under 2 minutes.** ⚠ The `vrt-strict` side is what bites,
and §9.3's re-pin is what stops it.

---

## 11. DEFECT LEDGER — live on `main`, independent of any face

| # | defect | evidence | routing |
|---|---|---|---|
| **D1** | ⚠ **"peertube is BROKEN — no audio, red CI" IS STALE, AND THIS SPEC WAS ASKED TO VERIFY IT RATHER THAN REPEAT IT. IT IS FALSE ON BOTH HALVES.** (a) **The audio bug is FIXED and guarded.** `PeerTubeCard.svelte:389-395` un-mutes the element after `createMediaElementSource` succeeds (the card header `:12-16` explains the trap: a muted element gates audio at the SOURCE, upstream of the Web Audio tap), and `peertube.spec.ts:273-377` is a dedicated regression guard that drives the REAL HLS path and asserts `out.peak > 0.01` at the AUDIO OUT terminal **plus** `muted === false`. (b) **CI is not red.** `peertube.spec.ts:326` is a `test.skip` on a **codec capability**, and it is claimed in the ONE park authority: `scripts/e2e-skip-budget.mjs:354-361`, *"Codec-capability gate: headless Chromium builds without proprietary codecs cannot decode the AVC HLS fixture … Tolerated but surfaced."* A named, budgeted capability skip is not a red spec | direct read + the skip budget | ⚠ **NOT a defect. Recorded as a CORRECTION**, because the false version is written into `_face-fixtures.ts` (D2) and into this project's memory, and a stale claim repeated as fact is the failure this wave guards against |
| **D2** | ⚠ **`_face-fixtures.ts:111-113` ASSERTS BOTH HALVES OF THE STALE CLAIM.** Its reason: *"queries a remote PeerTube instance over the network **at mount** (same third-party-host class as archivist), and **the module itself is known-broken — no audio, red CI (#786)**"*. **Clause 1 is false** — nothing fetches on mount (§9.1.1, every `runSearch` caller enumerated). **Clause 2 is false** — D1. Clause 3 (*"a fixture must never depend on a third-party host being reachable from the runner"*, inherited from the archivist entry) is TRUE and sufficient on its own | `:111-113` vs `PeerTubeCard.svelte:206-212`, `:462-477`, `:227-238` | **fix in PR C** — correct the reason to the one true clause. ⚠ **The entry itself STAYS.** ⚠ And it must be re-read at promotion, because a `DENIED` entry for a promoted module goes INVISIBLE rather than RED — that file records two hand-deletions for exactly this |
| **D3** | ⚠⚠ **PROMOTION CREATES A SEARCH-REQUEST GENERATOR.** A clocked `next_trigger` on a promoted peertube fires a fresh Sepia Search per pulse, capped at 5 req/s by the card's own limiter, because `nextResult()` reads a card-local `results` array the body no longer fills. §2.2 | `PeerTubeCard.svelte:117-118`, `:275-279`, `:427-443`; `peertube.ts:141` | **PR B** — the browse registry, landed BEFORE the face. ⚠ This is a bug that does not exist until the PR that must also fix it, so it cannot be scheduled independently |
| **D4** | **`gain` is declared, documented, unreachable and inert**, and the def says so (§0.1). It is in the contract, `contract-lock` pins it, and the Push card will rank it | `peertube.ts:131`, `:153`; `FRAG_SRC :47-63`; `draw :271-289` | **PR A** — wire it, then rewrite `docs.controls.gain` |
| **D5** | **No input targets `gain`**, so even wired it is CV-unreachable — the same fleet shape as the sibling | `peertube.ts:109-117` | ⚠ **NOT this PR.** A new input port is a CONTRACT change **and** a basis edit |
| **D6** | ⚠ **The corner-resize writes `node.data` untagged** — no `transact`, no `LOCAL_ORIGIN`, so it is neither undoable nor atomic. **Byte-identical to `ArchivistCard.svelte:616-621`** | `PeerTubeCard.svelte:518-524`; `mutate.ts:13-18`; `store.ts:70` | **fix in PR C** via `mutateNode`. ⚠ Not a bare `ydoc.transact(fn)` |
| **D7** | **The progress bar is a read-only fill where the sibling has a real seek control** — a derived value painted at rest with no control under it, which is both the worse UX and the shape the resting-text ruling refuses | `PeerTubeCard.svelte:613` vs `ArchivistCard.svelte:756-767` | **PR C** — §5.4.1, gated on M4 |
| **D8** | **The def's `docs.explanation` describes a UI the promoted module will not have**: *"The card has a resizable 16:9 preview screen (bottom-right corner-drag handle, persisted size; default 360x540, min 360x360)"*, plus an enumeration of *"The card UI (none of these are module params)"* | `peertube.ts:138` | **fix in PR C** — describe the faceplate. ⚠ `module-docs-lint` reads the DEF and is structurally blind to a `docs` string promising a surface that no longer exists, so this needs a human edit |
| **D9** | ⚠ **`archivist-scrub.ts` is a general transport-math module named after one module**, and §5.4.1 makes peertube its second consumer | `archivist-scrub.ts:1-6` | ⚠ **DO NOT RENAME.** It is a WebGL-attest basis file and a rename is a real code move costing a GPU window (§10.1). **Import it under its current name with a one-line comment**; a rename belongs in whatever future PR already has an attest window open |

---

## 12. TASTE CALLS, EACH WITH ITS ONE-LINE REVERT

| call | revert |
|---|---|
| `gain` is a `'fader'`, not a knob | delete the `paramCells` entry |
| the result sub-line keeps HOST and drops CHANNEL / LIVE / DURATION | put them back in the row's text (⚠ three of the four are refused resting text — §7) |
| the thumbnail grows 48 → 64 px wide | change the CSS width |
| the progress bar becomes a seek control | leave it a `<div class="bar">` (⚠ then it is a painted derived value with no control under it — §5.4.1) |
| the query block sits above the picture-adjacent transport and above the list | reorder the blocks |
| the disclaimer stays at the bottom under a divider | move it (⚠ do not delete it — §7.4) |
| the results list scrolls inside a fixed max-height | let the pane scroll instead (⚠ then the picture leaves the viewport while you browse) |
| no tab rail | — (needs an owner instruction; `face.tabbed` is not a build-lane decision) |

---

## 13. MUST-VERIFY (before the face is written)

* **M1 — §2.2 REPRODUCES.** On `main`, with `?shell=1`, spawn a peertube, run a
  search in the LANE card, then collapse/expand so the card re-mounts in the headless
  host, then drive `cv_next_trigger` edges and **count Sepia requests via
  `page.route`.** ⚠ Expect the count to rise per edge once the card's `results` is
  empty. **This is the wave's most consequential claim and it must be seen, not
  inferred.** If it does not reproduce, the registry precursor is still correct and
  the severity drops from "hammers a third party" to "the button does nothing".
* **M2 — the headless card is unclickable.** `getComputedStyle` on a card inside
  `[data-testid="headless-source-host"]` → `pointer-events: none`, and off-viewport.
  One assertion; it is the premise the whole body rests on.
* **M3 — the blit really shows the stream.** With the mocked HLS fixture playing,
  read `blitOutputForPreview(nodeId)` into a canvas and assert a non-idle signature;
  with nothing selected assert it matches the idle gradient
  (`vec4(0.05,0.04,0.09+…)`). ⚠ **Both directions** — "the idle field" and "the blit
  never ran" are indistinguishable from one reading.
* **M4 — HLS SEEK (§5.4.1).** Against the committed `hls-clip.mp4` fixture, set
  `videoEl.currentTime` mid-clip and assert playback resumes there. Then repeat with
  `isLive: true` in the fixture and record what happens. ⚠ **This decides whether the
  seek control ships or the bar stays read-only for live streams**, and it must be
  answered before the body is written, not after.
* **M5 — the cold-open dock capture is the GRADIENT, not an empty canvas** (§9.2).
  Three consecutive captures, mean RGB. ⚠ If transparent-black, the fix is
  `{ immediate: true }` on the first present, not a wait.
* **M6 — `noUserControl` is accepted AND its negative control fires.** Run
  `no-user-control.test.ts` + `module-face-lint.test.ts`; confirm completeness skips
  both `cv_*` params **and** that additionally ranking one is RED. Drive it.
* **M7 — the `uGain` fix is byte-identical at defaults and NOT at 0.5** (§10.1),
  on a real GPU, before spending the attest window.
* **M8 — the un-mute path survives the extraction** (§6.3). Re-run
  `peertube.spec.ts`'s audio test against the refactored
  `peertube-stream.ts` and confirm `out.peak > 0.01` and `muted === false`.
  ⚠ `REPEAT=3`.

---

## 14. VERIFICATION GATE

```bash
# 1. the face model + the new registry, with their permanent negative controls
flox activate -- npx vitest run packages/web/src/lib/ui/modules/peertube-face-model.test.ts
flox activate -- npx vitest run packages/web/src/lib/ui/media/peertube-browse-registry.test.ts

# 2. face lint + the promotion anchor (both directions)
flox activate -- npx vitest run packages/web/src/lib/ui/workflow/module-face-lint.test.ts

# 3. the noUserControl soundness sweep + its consumers
flox activate -- npx vitest run packages/web/src/lib/ui/workflow/no-user-control.test.ts

# 4. the rulings' source gates
flox activate -- npx vitest run \
  packages/web/src/lib/ui/controls/face-readout-source.test.ts \
  packages/web/src/lib/ui/controls/status-led-source.test.ts \
  packages/web/src/lib/ui/workflow/face-resting-text-source.test.ts \
  packages/web/src/lib/ui/workflow/video-face-screen-source.test.ts \
  packages/web/src/lib/ui/workflow/face-rack-status-source.test.ts \
  packages/web/src/lib/ui/dock/face-width-source.test.ts

# 5. the registries + the shared-file neighbours
flox activate -- npx vitest run \
  packages/web/src/lib/ui/workflow/shell-extensions.test.ts \
  packages/web/src/lib/ui/workflow/face-migration-inventory.test.ts \
  packages/web/src/lib/ui/workflow/dom-source-modules.test.ts \
  packages/web/src/lib/ui/media/card-media-lifetime.test.ts \
  packages/web/src/lib/ui/media/node-media-registry.test.ts \
  packages/web/src/lib/ui/modules-card-map.test.ts \
  packages/web/src/lib/control/push2/push-card-schema.test.ts

# 6. the module's own suites — and the audio guard 3x (M8)
flox activate -- npx vitest run packages/web/src/lib/video/modules/peertube-query.test.ts
REPEAT=3 flox activate -- task e2e:one -- tests/peertube.spec.ts
REPEAT=3 flox activate -- npx --workspace e2e playwright test faces-parity --grep peertube
REPEAT=3 flox activate -- task e2e:one -- tests/faceplate-platform.spec.ts

# 7. docs contract — the def's docs are edited (D4/D8), so re-pin and READ the diff
flox activate -- task docs:accept && flox activate -- git diff packages/web/src/lib/docs/contract-lock.txt
#    ⚠ EXPECT AN EMPTY DIFF. `docs` and `face` are both contract-transparent.

# 8. typecheck LAST — vitest is lenient where svelte-check is strict
flox activate -- task typecheck

# 9. BOTH cost artifacts, from the newest green run (§9.3)
flox activate -- task e2e:timings:accept -- <run>
flox activate -- task vrt:strict:timings:accept -- <run>

# 10. VRT: dispatch only, SCOPED, and COUNT the files. NEVER commit a PNG.
GREP=peertube flox activate -- task vrt:commit
#    PREDICT: 2 added (face-peertube-compact.png, face-peertube-dock.png), 0 moved.

# 11. attest: NIL for PR B and PR C (§10.1). Confirm the hash is UNMOVED on the MERGED tree.
flox activate -- bash scripts/webgl-attest-hash.sh
```

---

## 15. VERDICT, RISK, ESTIMATE

**PROMOTE-WITH-PRECURSOR — two precursors, and the second is the important one.**

1. **PR A**, the shared three-line `uGain` wiring (§0.1, §10.1). Shared with the
   sibling and with `videobox`/`tvLibrarian`; **one attest window for four modules.**
   Without it the face must rank a dead param, and there is no honest alternative.
2. **PR B**, `$lib/ui/media/peertube-browse-registry.ts` (§6.2). ⚠ **This one is not
   an optimisation — it is the fix for a defect the face itself creates** (§2.2),
   and it must land first so the face PR is not simultaneously the cause and the
   cure. `lib/ui/**` only, so zero attest.

**No platform capability is asked for.** Both declared blockers are dismissed on
measurement: `needs-media-controller` does not block a face (cameraInput and loopback
shipped through it) and `needs-note-entry-cell` is scoped to CELLS while the typed
query belongs in a BODY (§0.4). **Both `blockers` arrays should lose the note-entry
entry when these land.**

**Risk: MEDIUM.** Lower than the sibling's, because the preview is the ordinary blit
and the shipped `cameraInput` body is a direct template. Concentrated in three
places:

1. **§2.2 is a claim about behaviour after a change nobody has made yet**, so M1 is
   the whole of its evidence and it must run first.
2. **HLS seeking (§5.4.1 / M4)** is the one interaction whose feasibility is not
   settled by reading, and it has an honest fallback.
3. **The un-mute step (§6.3 / M8)** is one line with a history and a dedicated
   regression guard; moving it is the riskiest edit in the extraction.

**Estimate: ≈ 18 h** — PR A ≈ 3 h (shared with the sibling; count it once for the
cohort), PR B ≈ 3 h (registry + `environment: 'node'` unit + the `Canvas` sweep row),
PR C ≈ 12 h (the body ≈ 5 h, the two extractions ≈ 2.5 h, the seek control ≈ 1 h,
D6/D7/D8 ≈ 1 h, the e2e re-point ≈ 1.5 h, the face-model unit ≈ 1 h).

**Build it BEFORE the sibling.** Its body is the ordinary blit, so it proves the
shared shape out on the easier of the two; its precursor is the riskier design and
wants unhurried review while the cohort is still open; and its `$effect :482-491`
selection-reattach seam is the pattern the sibling's D1 fix has to copy. **Land PR A
first, alone, for both.**
