# FACEPLATE BUILD SPEC — `videobox` (video, the MULTIPLAYER FILE PLAYER)

**SPEC ONLY. Nothing here is implemented.** Mockups: [`dock.html`](dock.html) ·
[`dock-screens.html`](dock-screens.html).

Method: analyse what the module is FOR, then author the spec, then build from
the spec. Every claim carries the file and line it was measured from, and the
ones that were **checked and came back different from the rule** are marked ⚠
and kept rather than quietly corrected — the correction is the finding.

Measured on tree `ea2e06340` (= `origin/main`).

⚠ **The shared media-controller analysis for cohort A's local-file players lives
in [`../videovarispeed/spec.md` §0](../videovarispeed/spec.md)** — the
`needs-media-controller` disposition, the three bills the cohort has paid, and
the never-adopt-the-`<video>` constraint. This spec states only what is
DIFFERENT for videobox, and §16 answers the wave's cross-module question head on.

---

## 0. THE CONSTRAINT MAP, READ FIRST

| constraint | videobox's answer | measured at |
|---|---|---|
| `NON_SHELL_LANE_TYPES` | **NOT a member** | `legacy-fallback.ts:96-112` |
| `DOM_SOURCE_LANE_TYPES` (the headless-host tax) | ⚠ **MEMBER — the tax is PAID** | `dom-source-modules.ts:95` |
| `needs-media-controller` blocker | **DECLARED, and it does NOT block** | `face-migration-inventory.ts:1109-1116`; and `../videovarispeed/spec.md §0.1` |
| the tax it pays | `<HeadlessSourceHost>` **only** — no status registry | §0.2 |
| **the PARAM SET** | ⚠ **ONE PARAM IS DEAD, AND THE FACE CANNOT SHIP WITHOUT A CONTRACT CHANGE** | §0.1 |
| WebGL attest | ⚠ **the def IS in the basis, AND this PR MUST edit it — so a re-attest is MANDATORY, not avoidable** | §10.1 |
| lane picture | **FREE, automatic, per-node** | `module-shell-model.ts:177-179`, `:237-240` |
| ART | none — video domain is outside the audio profile gate | §10.2 |
| VRT | `EXEMPT_FROM_VRT` today, and half its stated reason is what the face DELETES | `vrt-exemptions.ts:889`; §9 |
| tab rail | **NO** — zero ranked controls; §5.2 | `dock-tabs-model.ts:101` |
| `node.data` writes / Cmd-Z | ⚠ **SPLIT — two writers correct, two BARE. A NEW CENSUS STATE** | §0.3 |
| `EXTENSION_BODY_ROLES` role | `picture` | §6.5 |

### 0.1 ⚠ `gain` IS A DECLARED PARAM NOTHING WRITES AND NOTHING READS — THE `twotracks` PRECEDENT, EXACTLY

This is the fact that shapes the whole PR, and it is stated in three places on
`main`, all of them agreeing:

* `videobox.ts:102-103` — `/** Reserved for future CV control; not consumed in v1. */ gain: number;`
* `docs.controls.gain` (`videobox.ts:153`) — *"Reserved output-gain param carried
  on the module for future CV control; **it is not yet consumed by the v1 engine
  or exposed as a knob on the card, so changing it currently has no
  audible/visible effect**."*
* the shader (`videobox.ts:47-63`) — `outColor = vec4(texture(uTex, vUv).rgb, 1.0);`
  There is no `uGain` uniform and no multiply. The factory stores the value
  (`setParam`, `:336-345`) and no reader consumes it.

`VideoboxCard.svelte` mounts **no control for it** — `grep -n "gain" VideoboxCard.svelte`
returns nothing. So today the param is invisible, and being invisible is what has
kept it alive.

**A face cannot leave it invisible.** `module-face-lint`'s completeness loop is
unconditional for a promoted def, and the only escape is a def-level
`noUserControl` entry — whose `writer` field has exactly two legal values
(`graph/types.ts:528-544`):

* `'cv-port'` — RED unless an input `PortDef` declares `paramTarget: 'gain'`
  (`no-user-control.ts:111-119`). videobox's inputs are `[play_trigger]` only
  (`videobox.ts:122-128`), so this is **illegal**.
* `'internal'` — legal by the port check (`:121-125`), but its declared meaning
  is *"a determinism or harness toggle"* and its required `why` must name **what
  writes it instead**. Nothing writes it. Writing `'internal'` here would be a
  `why` that is false, satisfying a gate with a sentence — which is CLAUDE.md's
  *"a green gate certifying a live bug"* in its purest form.

**So the honest options are two, and both are contract changes:**

| option | contract-lock effect | what it costs | what it means |
|---|---|---|---|
| **DELETE `gain`** ✅ recommended | `videobox param gain 0..2 linear default=1` (`contract-lock.txt:3562`) is removed — exactly one line | ⚠ a real-GPU re-attest (§10.1) | the `twotracks` precedent, verbatim |
| WIRE `gain` | the line stays; a `gain` CV input line is added | the same attest, plus a shader edit and a new port | a feature decision |

**Recommendation: DELETE**, and the precedent is exact and recent.
`face-migration-inventory.ts` records it in `twotracks`'s own note:

> *"⚠ Promotion also required a CONTRACT CHANGE first: `playhead_a`/`playhead_b`
> were declared params nothing wrote and nothing read, invisible while the card
> mounted no control for them and unavoidable the moment a face had to rank every
> param. **They were deleted, not hidden.**"*

⚠ **Wiring it is a FEATURE and therefore not the build lane's call.** It would be
defensible — `picturebox` has exactly this param, wired, as a 0..2 brightness
multiply, and `videobox.ts:44-46` says the module deliberately *"mirrors CAMERA's
idle look so the two file-input modules are visually consistent"*. But the docs
promise it as *reserved*, and inventing a control a module has never had, inside
a face PR, is the thing the rulings refuse. **Recommend delete; record wire-it as
the alternative and let the owner overturn it if they want the knob.** Deleting
loses nothing measurable, so this is not a "we would lose X" question.

⚠ **After the deletion videobox has ONE param — `cv_play_trigger` — and it is
synthetic.** The face therefore ranks **NOTHING**. That is legal and shipped:
`videoOut` declares `params: []` and `face: { order: [], glyph: 'none',
extension: 'videoOut' }` (`video-out.ts:83`, `:134-139`). §5 builds on that.

### 0.2 THE TAX — `<HeadlessSourceHost>` ONLY, AND IT IS ALREADY DEMONSTRATED ON MAIN

`videobox` is in `DOM_SOURCE_LANE_TYPES` (`dom-source-modules.ts:95`), so
`needsHeadlessSourceMount` returns TRUE for the promoted lane kind
(`:357-362`), and `card-media-lifetime.test.ts:216-219` already declares it
`owner: 'headless-card-mount'` with the `why` *"a card-owned `<video>` fed from a
user file blob; the DOM-source rule already keeps this card mounted off-screen"*.

**No status registry.** `cameraInput` and `loopback` each had to build one
because *nothing* about a browser capture grant is in the graph. videobox's whole
state is: `isPlaying`, `lastSyncTime`, `lastSyncPosition`, `fileMeta`,
`fullFrame`, `width`, `height` — every one of them `node.data`
(`videobox.ts:68-82`, `VideoboxCard.svelte:87-137`, `:699`). A body reading
`patch.nodes[nodeId].data` sees everything.

⚠ **AND THE HOST IS ALREADY ASSERTED FOR THIS EXACT MODULE, TODAY, UNDER THE
DEFAULT SHELL.** `workflow-shell-video.spec.ts:1361-1381` spawns a videobox at
plain `/rack` and asserts:

```
videobox still renders the uniform RACKLINE tile in its lane
videobox gets an off-screen lifecycle host           → toHaveCount(1)
the host mounts the REAL videobox card               → data-node-type="videobox"
                                                     → [data-testid="videobox-card"]
                                                     → [data-testid="videobox-video"]
```

So the promoted arrangement — a shell tile in the lane, the real card alive in
the host — is **not a prediction; it is what `main` already does for this module
on every run of that spec.** Promotion changes only which component the DOCK
renders. That is the strongest starting position any module in this program has
had.

⚠ **The constraint from `../videovarispeed/spec.md §0.2 applies verbatim: the
body BLITS and never adopts the `<video>`.** Here it is one element rather than
seven (`VideoboxCard.svelte:565-588`, `nodeMedia.adopt(id, MEDIA_SLOT, …)`), and
`videoEl` is what `togglePlay`, `onSeek`, the drift `$effect` (`:478-500`) and the
500 ms drift loop (`:508-523`) all drive. A body that adopted it would take it out
of the card and null every one of them.

### 0.3 ⚠ THE `.data` CENSUS — videobox IS IN TWO ROWS AT ONCE, WHICH IS A STATE THE TABLE CANNOT EXPRESS

`mutate.guard.test.ts`'s three patterns all anchor on the literal token
`.params`, so the guard is structurally blind to `.data` writes. Wave 5 reported
three states, **one row per module** (`wave5/README.md §7`).

**videobox occupies the best and the worst row simultaneously**, in one file:

| writer | site | shape | Cmd-Z? |
|---|---|---|---|
| `writeSync` (play / pause / seek — the multiplayer triple) | `VideoboxCard.svelte:166-181` | `ydoc.transact(fn, LOCAL_ORIGIN)` | ✓ |
| `writeFileMeta` | `:183-211` | `ydoc.transact(fn, LOCAL_ORIGIN)` | ✓ |
| ⚠ **`setFullFrame`** | `:701-708` | **bare proxy write** — no transact, no origin | ✗ |
| ⚠ **the corner-resize `apply`** | `:744-751` | **bare proxy write** — no transact, no origin | ✗ |

The bare form, verbatim (`:702-707`):

```ts
setFullFrame: (on) => {
  const target = patch.nodes[id];
  if (target) {
    if (!target.data) target.data = {};
    (target.data as Record<string, unknown>).fullFrame = on;
  }
},
```

`store.ts` configures `trackedOrigins: new Set([LOCAL_ORIGIN])`, and
`mutate.ts:13-18` states the consequence: an untagged write *"is silently NOT
undoable"*. So, measured and user-visible:

> **On `main` today, Cmd-Z cannot undo a videobox Full Frame toggle, and it
> cannot undo a videobox resize.** Both are synced to peers, both persist, and
> neither is on the undo stack. Meanwhile the play/pause/seek triple *is*.

⚠ **This is the finding worth carrying out of the census, and it is not "one more
broken module."** Waves 3-5 built a table whose rows are *modules*, on the
premise that a module has a discipline. videobox does not have a discipline; it
has two, in adjacent functions, and **the correct ones are the ones an author was
thinking about while the careless ones are the ones bolted on later** (the sync
triple is the module's headline feature; `fullFrame` and `resize` were added with
the wall-of-TVs work). A per-module column would record videobox as ✓ or ✗
depending on which function the surveyor opened first.

**Fixed in this PR, on both surfaces:**

* the CARD's two bare writes become `mutateNode(id, fn)` — which is
  `ydoc.transact(fn, LOCAL_ORIGIN)` (`mutate.ts:80-90`) — a two-line boy-scout;
* the BODY writes through `mutateNode` from the start, which is what
  `VideoOutBody.svelte:96-102` already does for the same `fullFrame` key.

⚠ **The card fix is not optional just because the card is off-screen.** It is
still reachable at `?shell=legacy`, it is still the surface eleven e2e specs
drive, and leaving a known un-undoable write in a file this PR is already editing
is exactly the debt the boy-scout rule exists to stop.

---

## 1. WHAT THE MODULE IS FOR

A video file, playing **the same frame on everybody's screen**.

Its sibling `videovarispeed` is an instrument you scratch. videobox is a
**television** — you drop a clip in, hit play, and its `video` + `audio_l`/`audio_r`
feed the patch. The idea with anything in it is the **multiplayer playhead**: a
play, a pause or a seek writes one shared `(isPlaying, lastSyncTime,
lastSyncPosition)` triple to `node.data`, and every peer — including the writer —
runs `decideDriftCorrection` each tick and seeks its own local element whenever it
slips more than `DRIFT_THRESHOLD_SEC = 0.5` off the extrapolated position
(`videobox-sync.ts:66`, `:102-115`). The bytes never travel; only the clock does.
A collaborator without a local copy still gets the seekbar, the duration and the
play state, and a re-link prompt naming the file they need.

The second idea is **the wall of TVs**: the card is corner-drag resizable in
whole-rack-unit tiles, the size persists on the node and syncs, and the
`docs.explanation` (`videobox.ts:143`) says the purpose out loud — *"so several
videoboxes can be tiled into a wall of TVs"* — plus Fullscreen (per-peer, local)
and Full Frame (in-app, synced).

**What that means for the face:** the module is a SCREEN with a transport and a
file picker and no controls at all. That is `videoOut`'s shape with a transport
bolted on, and `videoOut` is already faced. §2.3 is where the wall of TVs has to
be answered honestly.

---

## 2. STOP 1 — is promoting this module a PARITY LOSS?

| affordance | `VideoboxCard.svelte` | where it goes on the face | lost? |
|---|---|---|---|
| the live PREVIEW | `:791-802` (`.preview-wrap` + adopted `<video>`) | ⚠ the body's own **BLIT canvas**, plus the lane tile's `VideoTileThumb` | no, and it gains a lane tile |
| drop-a-file target | `:777-779` | body root, same three handlers | no |
| `Choose video…` / `Pick another video…` | `:859-867` | body row, same `<input type=file>`, same testid | no |
| Chromium `showOpenFilePicker` | `:313-345` | body, same handler | no |
| the RE-LINK prompt | `:821-849` | body overlay, same testid — §7 keeps its size + duration line | no |
| the one-click RE-ALLOW | `:808-820` | body overlay, same testid | no |
| PLAY / PAUSE | `:873-884` | body transport row, same testid — §6.2 | no |
| the `0:04 / 2:00` readout | `:881-883` | ⚠ **REMOVED** — §7 | text yes, information no |
| the SEEK scrubber | `:886-897` | body, same `<input type=range>` | no |
| the filename | `:899-903` | body, a NAME — §7 | no |
| the load-error line | `:869-871` | body, transient | no |
| **FULLSCREEN** (real API, per-peer) | `:689-692`, `:925` | body — `createFullscreen`, the `videoOut` precedent | no |
| **screen picker** (multi-display) | `fs.availableScreens`, `:923-925` | body, same | no |
| **FULL FRAME** (in-app, synced) | `:694-711`, `:926` | body — same `node.data.fullFrame` key, §6.3 | no |
| the preview right-click menu | `:727-733`, `:918-929` (`VideoCanvasContextMenu`) | body — mounted on the body's canvas | no |
| `attachRenderLease` (presenting lease) | `:717-721` | ⚠ **stays on the CARD**, which stays mounted — §2.2 | no |
| **corner-drag RESIZE** (`node.data.width/height`) | `:736-756`, `:909-915` | ⚠ **§2.3 — the one that needs a real answer** | **no, but the mechanism changes** |
| TRIG gate → play/pause | `:528-556` (33 ms edge loop) | ⚠ **stays on the CARD** — §2.2 | no |
| the drift loop + drift `$effect` | `:478-523` | ⚠ **stays on the CARD** — §2.2 | no |
| perf-zip export resolver | `:609-618` | ⚠ **stays on the CARD** | no |
| the PatchPanel jacks | `:786` | the shell's own rear/patch surface | no |

**Nothing is lost.** One readout is removed (§7), one mechanism changes (§2.3),
and the module gains a lane picture it never had.

### 2.1 THE `$effect` / `onMount` SWEEP — the class the STOP-2 grep cannot see

`wave5/README.md §6` records that the STOP-2 grep
(`'<button|<select|<input|oncontextmenu|manualTrigger|Toggle|Selector|accept='`)
finds affordances a USER operates and is **structurally blind to a
component-lifecycle side effect the card performs on the user's behalf**. Done
here: `VideoboxCard.svelte` has **seven `$effect(` blocks and two `onMount(`
blocks**, and every one survives **because the card survives in the headless
host**:

| mechanism | site |
|---|---|
| the media-element adopt/release lease | `:565-588` |
| the engine attach poll | `:620-632` |
| the handle-reload attempt | `:438-445` |
| the sync-driven play/pause + drift correction | `:478-500` |
| the 500 ms drift loop | `:508-523`, started `:634` |
| the 33 ms `cv_play_trigger` edge loop | `:538-553`, started `:635` |
| `fs.setTarget` / `fs.attach` | `:691-692` |
| `ff.attach` | `:711` |
| `attachRenderLease` | `:717-721` |
| `registerVideoExport` | `:609-618` |
| the 100 ms `displayPos` refresh | `:673-675` |

⚠ **Two of these are the reason the body must not become a second owner.**
`fs.attach()` and `ff.attach(cardEl, …)` bind document-level listeners to the
CARD's elements. If the body mounts its own `createFullscreen` / `createFullFrame`
against its own root — which it must, because the card's are off-screen and
`pointer-events: none` — then **two attach pairs are live at once**. See M3 (§13):
this must be measured, not assumed, and the cheap mitigation is that the card's
pair targets an element inside a `pointer-events: none` subtree, so its escape/
double-click handlers can only fire from the document, which is where a conflict
would show.

### 2.2 WHAT STAYS ON THE CARD

TRIG edge detection, the drift loop, the drift `$effect`, the render lease and
the perf-zip resolver all stay where they are, alive, in the host. **Promotion
moves the card off-screen; it does not unmount it.** That is the whole content of
the headless-host tax and the reason this is not the `midiOutBuddy` class — a
defect that promotion *creates* (`wave5/README.md §6`).

### 2.3 ⚠ THE WALL OF TVs — THE ONE AFFORDANCE WHOSE MECHANISM CANNOT SURVIVE, AND WHY IT IS NOT A LOSS

**The measurement first.** `Canvas.svelte:641-652`:

```ts
/** A module TYPE's rendered card WIDTH in flow-space px. Under the `?shell=1`
 *  preview a shell/placeholder tile is the UNIFORM SHELL_TILE_W (every module the
 *  SAME width — the owner "same-size horizontally" premise) … */
function wcolCardWidthPx(type: string): number {
  if (shellFaces && !NON_SHELL_LANE_TYPES.has(type)) return SHELL_TILE_W;
  return (rackSizeByType[type]?.hp ?? 1) * RACK_UNIT;
}
```

`SHELL_TILE_W = 192` (`module-shell-model.ts:39`), and **the function's only
argument is `type`.** There is no `nodeId`. So under the default shell every
faced module is 192 px wide, uniformly — and that is not an oversight, it is
quoted in the source as **the owner's "same-size horizontally" premise**. The
height function `wcolCardHeightPx` is the same shape (`:635`, `SHELL_TILE_H_SLOT`).

This is the `ShellExtensionGlyphProps` shape again (`wave5/README.md §5`): a
per-node quantity that the seam has no parameter for. The difference is that
here **a per-node lane width would also be a reversal of a stated owner premise
for all ~200 modules**, so proposing the platform change would be an agent
overturning an owner decision on one module's behalf. Not done, and not offered
as a choice.

⚠ **A PRECEDENT CHECK THAT CAME BACK CLEAN.** `videoOut`'s card is *also*
corner-drag resizable over `node.data.width/height` (`VideoOutCard.svelte:420-430`)
and `videoOut` **is promoted** (`strict-faces.ts:2075`). So the fleet has already
taken this exact trade once, for the module whose entire purpose is a big picture.
Its body's answer is measurable: `VideoOutBody.svelte` has **no resize handle**,
sizes itself `width: 100%; min-width: 260px; flex: 1 1 auto` (`:358`, `:376-378`)
with the comment *"a live picture is the canonical thing that EARNS width"*, and
carries **fullscreen + full frame + detach + present** instead.

**So the affordance is preserved, by four routes that between them cover every
use of it — and one of them is strictly better than what it replaces:**

| what a player did with the resize | on the face |
|---|---|
| make ONE videobox big enough to watch | **FULL FRAME** (`node.data.fullFrame`, the same key, synced) and **FULLSCREEN** with the screen picker — both already on the card, both ported |
| make the dock preview a comfortable size | a **body corner-resize** over `resizedWidth`/`resizedHeight` — five existing adopters (`ruttetra`, `bentbox`, `b3ntb0x`, `milkdrop`, `graphicEq`), per-node, synced, `RuttetraOutputBody.svelte:143-162` is the shape to copy |
| put SEVERAL clips on screen at once, at chosen sizes | ⚠ **DETACH** — `node.data.detached`, `detached-display.ts`, `VideoOutBody.svelte:108-111`. It puts each picture in its own window on real screen real estate, which is **more** wall-of-TVs than 360 px tiles inside a rack canvas, not less |

**What genuinely changes is the GEOMETRY, not the capability**: several videoboxes
tiled *inside the rack canvas at per-node sizes* is not expressible, because the
rack canvas is uniform-tile by ruling for every module. That is a pre-existing
fleet property this promotion inherits, not one it invents, and `videoOut` inherited
it first.

⚠ **AND THE DOCS MUST BE REWRITTEN IN THE SAME PR.** `videobox.ts:143` currently
promises *"The card is drag-resizable from the bottom-right corner (whole-rack-unit
tiles, default and minimum 360x360) so several videoboxes can be tiled into a wall
of TVs; size persists on the node and syncs to peers"* — describing a surface a
workflow-mode player will no longer reach. Leaving it is the `modtris`/`score`
class wave 5 named: **documentation promising behaviour that is not there, on a
module in `STRICT_DOCS`, invisible to `module-docs-lint` because that gate reads
the DEF.** Rewrite it to name the four routes above. `docs` is hash-transparent, so
the rewrite is free.

⚠ **AND `spec.nominalWidth` HAS A DEAD CONSUMER.** `Canvas.svelte:2880-2887`'s
`else` branch — the one that reads a per-node `node.data.width` for a video-zone
default — is guarded by `NON_SHELL_LANE_TYPES.has(spec.type)`, and none of the
three `VIDEO_ZONE_DEFAULTS` (`channel-columns.ts:585-587`: `videoOut`,
`recorderbox`, `synesthesia`) is in that set. **The branch is unreachable and its
comment describes a `videoOut` carve-out removed by #1821.** Recorded in the
ledger (VB-D6) and routed OUT of this PR: it is `videoOut`'s residue and a Canvas
edit does not belong in a face diff.

---

## 3. STOP 2 — does every way of getting DATA IN survive?

| entry point | today | after |
|---|---|---|
| file picker | card `<input type=file>` `:860-865` | body `<input type=file>`, same element, same testid |
| Chromium picker | `showOpenFilePicker` `:320` | body, same call in the same click gesture |
| drag-drop | card root `:777-779` | body root, same |
| IndexedDB handle reload | `:385-405` | unchanged — card-side, survives in the host |
| perf-zip restore | `registerVideoExport` `:609` | unchanged — card-side |
| play / pause / seek | `:448-469` → `writeSync` | body buttons → the same `writeSync` |
| **TRIG gate** | `play_trigger` → `cv_play_trigger` → the card's 33 ms edge loop `:538-553` | unchanged — the loop still runs in the host |
| **a PEER's play/pause/seek** | Y.Doc → the drift `$effect` `:478-500` | unchanged — card-side, and the body reads the same `node.data` |
| remote `fileMeta` | Y.Doc → `$derived` | unchanged |

Nothing in the input set breaks, for the same reason as `videovarispeed`: the
card is moved, not removed.

---

## 4. THE LANE PICTURE — **ACCEPTED**, free, per-node

`hasVideoSurface(def)` is `def?.domain === 'video'` and nothing else
(`module-shell-model.ts:177-179`); `laneGlyphFor` returns `'picture'` off that
alone (`:237-240`); `ModuleShell` renders `<VideoTileThumb nodeId={id} />`, which
blits the node's own output FBO at `160×120`, `15 fps`
(`VideoTileThumb.svelte:164`, `module-shell-model.ts:250-252`). No opt-in, no
platform change.

⚠ **`glyph: 'none'` is MANDATORY** for a video def — `video-out.ts:124` and
`strict-faces.ts` both spell out why, and `videoOut` is the copy-from case: assert
`hasVideoSurface`, because `'none' + blank tile` and `'none' + live thumb` are
indistinguishable from the declaration (`video-out.ts:118-121`).

⚠ **And on videobox the lane tile is the WHOLE tile**, because there are no
ranked controls after §0.1 (`order: []`). It is `videoOut`'s lane tile exactly:
a picture and a title. The #1785 ruling that *"for a video module the picture IS
the module's identity in a rack, so it OUTRANKS ranked controls"* never has to
fire, because there is nothing for it to outrank.

**Pull-eval:** identical to `videovarispeed`. `isPullExempt` returns true on a
non-empty `audioSources` map (`engine.ts:1171`) and videobox's factory installs
two silent `ConstantSourceNode`s at construction (`videobox.ts:206-218`), so **the
node never leaves the pull set while an `AudioContext` exists** — the engine's own
doc names *"the video players' soundtracks"* as the case (`:1155-1158`). The
`markWatched`-while-SCREEN-OFF argument that twenty-eight roster entries carry
**does not apply on its usual grounds**, and §6.4 gives the one that does.

---

## 5. THE FACE

### 5.1 THE DECLARATION

```ts
// after `gain` is deleted (§0.1)
face: {
  glyph: 'none',            // mandatory for a video def — §4
  order: [],                // videobox has no user-facing params. videoOut's shape.
  extension: 'videobox',
},
noUserControl: [
  { param: 'cv_play_trigger', writer: 'cv-port',
    why: 'the TRIG gate input writes the raw level here through the CV bridge and the card '
       + 'edge-detects it into a play/pause toggle; a player pulses the jack, never this value.' },
],
```

* `writer: 'cv-port'` is the **only** legal value: `play_trigger` declares
  `paramTarget: 'cv_play_trigger'` (`videobox.ts:127`), so `'internal'` is RED at
  `no-user-control.ts:121-125`.
* `why` must clear `NO_USER_CONTROL_WHY_MIN = 24` (`no-user-control.ts:54`).
* ⚠ Declaring it also drops the param from `listExposableControls`
  (`group-controls.ts:89-94`) and from the Push 2 card
  (`push-card-schema.ts:96-98`). Both are improvements — a raw gate cache should
  never have been on a hardware controller — and both are behaviour changes
  outside the faceplate that must be in the PR body (§10.5).

### 5.2 BANDS — ZERO, and no tab rail

`order: []` gives zero bands. `DOCK_TAB_MIN_BANDS = 7` (`dock-tabs-model.ts:101`).
**No rail, and none is manufactured.** `face.tabbed` is owner-instruction-only and
is not reached for. This face is the picture plus the body, which is exactly what
`videoOut` ships and what the owner approved for it (*"video output face should…"*,
`strict-faces.ts:2046`).

⚠ **A zero-rank face is NOT the thing STOP 1 refuses.** The overridden refusal was
about *thinness* (`module-faceplates.md:40-52`, owner 2026-08-20: *"they still
need to be done, <4 params or not"*), and the surviving refusal is about **dropping
an affordance** — which §2 shows this does not do. `videoOut` is the shipped proof.

### 5.3 WIDTH — **EARNED**, by the same measurement as `videoOut`

CLAUDE.md's ruling names *a live picture, a video preview* as genuine earners.
This body is a live video preview and nothing else is competing for the space.

* the legacy card's default and minimum are `360×360` (`VideoboxCard.svelte:83-86`)
  around a `16/9` preview;
* the body's canvas is **480×360**, the buffer `LoopbackOutputBody.svelte:227-228`
  uses;
* `VideoOutBody.svelte:366-378` records the equivalent measurement on the module
  this one copies — *"content 354, plate 396, against a 40 px ceiling"* — and its
  chosen declaration is `width: 100%; min-width: 260px; max-width: 100%;
  flex: 1 1 auto; min-width: 0`.

**Copy that declaration.** No `PLATE_FLOOR_EXEMPTIONS` entry is needed — that list
is `[]` (`face-width-source.test.ts:88`) and the gate fires only at or above the
plate scale (`:183-187`); 260 px is well under it. ⚠ **Do not add the wave's first
exemption**, and do not add a `min-width: 900px`-shaped floor: *"a default that
needs a new exemption per review is the wrong default."*

---

## 6. THE BODY — `face.extension: 'videobox'`, slot `fullViewBody`

`packages/web/src/lib/ui/modules/videobox/VideoboxScreenBody.svelte`, registered
through `.../videobox/shell-extension.ts` — the conventional path the
`EXTENSION_BODY_ROLES` directory scan reads (`face-rack-status-source.test.ts:100-116`).

### 6.1 CONTENTS, TOP TO BOTTOM

1. **the PICTURE** — a 480×360 `<canvas>` fed by `blitOutputForPreview(nodeId)` in
   a rAF, letterboxed by the `srcAspect`/`dstAspect` fit at
   `LoopbackOutputBody.svelte:204-209`. **Never an adopted `<video>`** (§0.2).
2. **the SCREEN switch** — overlaying the picture's bottom-right corner (§6.4).
3. **the overlays** — drop-hint / re-allow / re-link, the three mutually exclusive
   states the card computes (`VideoboxCard.svelte:803-850`), same testids.
4. **the SCREEN ROW** — Fullscreen · Full Frame · Detach · Present (§6.3), plus the
   right-click `VideoCanvasContextMenu` on the canvas, which is the same four
   entries by another route.
5. **the pick row** — `Choose video…` / `Pick another video…` + the transient
   load-error line.
6. **the transport row** — PLAY/PAUSE, then the seek scrubber.
7. **the filename.**
8. **the corner RESIZE grip** — over `resizedWidth`/`resizedHeight` (§2.3), the
   `RuttetraOutputBody.svelte:143-162` shape.

### 6.2 WHY `fullViewBody` AND NOT CELLS

**PLAY/PAUSE could be a `ShellToggleCell`** (`shell-cells.ts:314-321` — *"a 0/1
LATCHING switch backed by node.data"*, and `node.data.isPlaying` is exactly that).
Refused for three reasons, the third of which is the one that decides it:

1. **Locality** — the scrubber has no cell kind, so a cell splits the transport
   across two surfaces.
2. **The lane budget** — with `order: []` there are no bands at all, so a cell
   would be the ONLY band, and a lone PLAY band beneath a picture is worse than a
   transport row inside the picture's own box.
3. ⚠ **A cell would silently un-enrol videobox from `collapse-keeps-playing`.**
   `:441-447` derives enrolment from
   `pane.locator('button[data-testid$="-play-btn"]')` **and**
   `pane.locator('input[type="file"][data-testid$="-file-input"]')`. A `<Toggle>`
   and a `ShellFileCell` emit neither, `isPlayer` goes false, and the test SKIPS
   with a loud message. **Skips are not passes.** See `../videovarispeed/spec.md
   §8.1` — the same hazard, on the same sweep, for both modules at once.

**The file pick could be a `ShellFileCell`** (`kind: 'file'`, `shell-cells.ts:306-313`;
adopters `dx7`, `wavecel`, `samsloop`). Refused for the same (3) plus: a file
button in the 46 px lane knob column is where the picture should be
(`picturebox`'s disposition).

**A `panel` cell is refused** because a `ShellPanelCell` requires a `probe`
(`shell-cells.ts:380-381`) whose vocabulary is `data`/`data-rev`/`text`, and a
file input's observable is a browser dialog. `fullViewBody` needs no probe
**because it is a SLOT rather than a cell** (`module-faceplates.md:857-861`).

**Never `editorSurface`** — declared, unwired; `WIRED_SHELL_EXTENSION_SLOTS` is
`['glyph', 'fullViewBody']`.

### 6.3 THE FOUR SCREEN AFFORDANCES — a straight PORT, and the components already exist

Every one of these has a working implementation in `VideoOutBody.svelte`, in a
`fullViewBody`, on a faced video module:

| affordance | card | body | shared helper |
|---|---|---|---|
| FULLSCREEN (+ screen pick) | `VideoboxCard.svelte:689-692` | `VideoOutBody.svelte:38` | `../use-fullscreen.svelte` |
| FULL FRAME | `:694-711` | `:90-105` | `../use-full-frame.svelte` |
| DETACH | — (videobox has none today) | `:108-111` | `../detached-display` |
| PRESENT (popup on another display) | — | `:84-88` | `../use-present.svelte`, node-keyed via `node-present-registry` |

⚠ **`fullFrame` must reuse the SAME `node.data.fullFrame` key**, or every rack
saved before the promotion silently re-opens its collapsed state
(`module-faceplates.md:246-249`). `VideoOutBody.svelte:90-92` already says so:
*"The SAME `node.data.fullFrame` the legacy card persists."*

⚠ **And it must be written through `mutateNode`**, which is
`ydoc.transact(fn, LOCAL_ORIGIN)` — this is where §0.3's VB-D1 gets fixed for
free on the new surface.

⚠ **DETACH and PRESENT are ADDITIONS, not ports**, and they are proposed because
§2.3 needs them: they are the routes that carry the wall-of-TVs capability after
the lane goes uniform. Adding an affordance a module never had is normally out of
scope for a face PR — here it is the *parity* argument, and the components are
already written and already shipped on a sibling. **Say so in the PR body**; do
not let it read as scope creep discovered later.

### 6.4 SCREEN ON/OFF — required, and this module's own argument

Gate: `video-face-screen-source.test.ts`, deny-by-default over `STRICT_FACES ∩
video defs`. Its `NO_SCREEN_SWITCH` list has exactly one entry, `videoOut`, whose
`why` is *"videoOut IS the screen — its faceplate body is the output picture
itself … A SCREEN ON/OFF here would collapse the module's entire reason to exist
… the ruling is about a preview that sits NEXT TO a module's controls."*

⚠ **videobox looks like it qualifies for that exemption and it does NOT**, and
the distinction is worth writing down because it is the closest call in the wave:

> `videoOut` is a **SINK** — it has no controls, no transport, and nothing to do
> except show the picture, so collapsing it leaves an empty plate. `videobox` is a
> **SOURCE with a transport**: with SCREEN OFF you still have a file picker, a
> play/pause, a scrubber, a filename and four screen affordances — a complete,
> usable player. That is the `twotracks` argument verbatim (*"with it collapsed
> you still have a complete, usable tape machine"*).

Mechanics: key `node.data.previewCollapsed`, written via `mutateNode`; the button
**OVERLAYS the picture's bottom-right corner** on an `rgba(5,6,8,0.72)` backplate,
never a row of its own (`module-faceplates.md:206-222`: the stacked row measured
**~18.8 px against ~11 px of slack**; an overlay's delta is **ZERO**); the wrap
keeps a `min-height: 18px` floor that only matters with SCREEN OFF.

**OFF skips the PAINT, never the engine read** — the collapsed branch still calls
`markWatched(nodeId)`. ⚠ The justification is *not* the #2015 accumulator one the
rest of the roster gives: this module is unconditionally pull-exempt while an
`AudioContext` exists (§4). The mark is kept because that exemption evaporates in
an audio-less boot, which is the environment the gates run in. **Write the honest
reason into the `why` (§6.5), not the copied one.**

### 6.5 `EXTENSION_BODY_ROLES` — the THIRD gate a face PR satisfies

`face-rack-status-source.test.ts:150` is deny-by-default over every
`fullViewBody`, membership derived off the DIRECTORY (`:100-116`), `why`
required by the type, each role carrying a mechanical predicate (`:471-492`).

⚠ **SPOT-CHECK THAT CAME BACK DIFFERENT FROM THE BRIEF, CONFIRMED TWICE.** On
`ea2e06340` there are TWO roles, not three: `:142` is
`type BodyRole = 'picture' | 'status-primitive';`, `:690-696` is an ANCHOR
asserting the live set exactly
(`expect([...roles].sort()).toEqual(['picture', 'status-primitive'])`), and
`grep -c "control-grid"` over that file returns **0**. **#2184 is an OPEN PR, not
merged** (independently re-verified by the wave's orchestrator). The anchor is the
durable part: **a third role cannot be added silently — it reddens `:695`** — so
if #2184 lands first, the roster will have three roles *and that assertion will
have been edited to say so*. Re-read it rather than trusting either list.

**ROLE: `picture`.** Predicate `paintsCanvas(src, extId)` (`:476`) — the body
mounts a `<canvas>` directly.

⚠ **`status-primitive` was CONSIDERED and REFUSED, and it is the interesting
half.** Note first that the two predicates are **ordered by the canvas test rather
than mutually exclusive by intent**: `status-primitive` is
`/StatusLed/.test(src) && !paintsCanvas(...)` (`:481-483`), so a body that keeps a
preview canvas **and** imports `StatusLed` is legally `picture` — the role choice
would not have been forced either way. The substantive question is therefore
whether videobox's **SYNC state deserves a `StatusLed` at all**. Ruled: **NO**, on
the merits, and §7.2 is the argument. **No new role is needed and none is
proposed.**

The `why` string to commit:

```
videobox: { role: 'picture', why:
  'the multiplayer file player\'s live output BLIT plus everything a player touches: the '
  + 'transport (PLAY/PAUSE and the seek scrubber), the file pick with its drop target, re-link '
  + 'and re-allow overlays, the four SCREEN affordances (fullscreen with the display picker, '
  + 'full frame, detach, present), a corner resize grip, and its SCREEN switch. '
  + '⚠ THE PICTURE IS BLITTED AND THE <video> IS NEVER ADOPTED — the cameraInput and loopback '
  + 'constraint verbatim: the element is node-owned and ADOPTED INTO VideoboxCard, whose drift '
  + 'loop, drift $effect, seek and togglePlay all drive `videoEl`. A body that adopted it would '
  + 'take the element out of the card and null every one of them. '
  + '⚠ IT IS THE ONLY SURFACE A PLAYER CAN REACH: promotion moves the real card into '
  + '<HeadlessSourceHost>, parked at left:-9999px with pointer-events:none, so the card is '
  + 'MOUNTED (which keeps the element, the 500 ms drift loop, the 33 ms TRIG edge loop and the '
  + 'perf-zip export resolver alive) and nothing on it is CLICKABLE. '
  + '⚠ NO STATUS REGISTRY, unlike cameraInput and loopback, and that is derived: those two '
  + 'needed one because NOTHING about a browser capture grant is in the graph, whereas this '
  + 'module\'s whole state — isPlaying, lastSyncTime, lastSyncPosition, fileMeta, fullFrame — is '
  + 'node.data. '
  + '⚠ NO StatusLed EITHER, and that is a decision rather than an omission: the tempting lamp is '
  + 'a SYNC indicator, and it is refused because a lamp must name a state a player can ACT on. '
  + 'Drift correction is automatic and silent, "in sync" is the resting state of a working '
  + 'module, and the one genuinely actionable multiplayer state — a peer loaded a file this '
  + 'browser does not have — is ALREADY the re-link overlay, which is an affordance rather than '
  + 'an indicator. '
  + '⚠ DETACH and PRESENT are ADDITIONS ported from VideoOutBody rather than from this module\'s '
  + 'card, and they are the parity argument for the lane going uniform: wcolCardWidthPx takes a '
  + 'TYPE and not a nodeId, so the card\'s per-node resizable "wall of TVs" cannot be a lane '
  + 'tile — it becomes full frame, fullscreen, a detached window, and a per-node body resize. '
  + '⚠ SCREEN OFF KEEPS markWatched, but NOT for the #2015 accumulator reason: this module is '
  + 'unconditionally pull-exempt while an AudioContext exists (isPullExempt returns true on a '
  + 'non-empty audioSources map, and the factory installs two silent ConstantSourceNodes at '
  + 'construction). The mark is kept because the exemption evaporates in an audio-less boot, '
  + 'which is the environment the gates run in. '
  + '⚠ TEXT ON THE SURFACE, exhaustively: button captions (SCREEN, Play/Pause, Choose video…, '
  + 'FULL FRAME, FULLSCREEN, DETACH, PRESENT), the FILENAME, and — inside the re-link overlay '
  + 'only — the file SIZE and DURATION, which are how a player identifies the right copy on '
  + 'disk and which are ABSENT whenever nothing is wrong (the loopback recovery-text exception). '
  + '⚠ NOT on it, deliberately: the card\'s `0:04 / 2:00` playhead readout, DELETED rather than '
  + 'hidden — the position lives on the scrubber\'s aria-valuetext.' },
```

---

## 7. RESTING TEXT

### 7.1 ONE readout is REMOVED, and one prose line is KEPT with an argument

`face-resting-text-source.test.ts` denies the SHAPE — permitted resting text is
exhaustively the module NAME, TAB/SECTION labels, CONTROL CAPTIONS and
OPTION/LANDMARK NAMES — and it states its own blind spot: text inside a
`fullViewBody` is invisible to it, which is why §6.5 enumerates it and why the
dock baseline plus a human are what see it.

| card text | site | face | why |
|---|---|---|---|
| `0:04 / 2:00` | `:881-883` | ⚠ **REMOVED from every surface** | a timecode is a measurement |
| the filename | `:899-903` | **KEPT** | a NAME |
| the load error | `:869-871` | **KEPT, transient** | an error is not resting derived state |
| ⚠ the re-link overlay's `12.4 MB · 2:00` | `:846-848` (`formatFileSize` · `formatTime`) | ⚠ **KEPT, and this is the one call that needs an argument** | below |

**Why the re-link size + duration stays.** It is a measurement, and the letter of
the rule refuses a measurement. The exception is named by the precedent, in
`LoopbackOutputBody.svelte:247-250`:

> *"THE CARD'S RECOVERY TEXT, VERBATIM AND UNSUMMARISED. This is the exception the
> resting-text rule is built to allow: it is not derived state restating a
> control, it is an ERROR with instructions, and it is absent whenever nothing is
> wrong."*

Both halves hold here. The line is **absent whenever a file is loaded**
(`showRelinkPrompt`, `:432-434`, requires `!hasLocalFile && fileMeta !== null`),
and its job is to let a player **find the right file on their own disk** — which
is precisely what a size and a duration do and what a name alone does not.
`videobox-sync.ts:47-50` says the field exists for that: *"Always saved; shown in
the re-link prompt ('12.4 MB') so the user can recognise the right copy."*
**It is instructions, not a readout.**

⚠ **DELETING A READOUT DELETES A FINDING.** The `0:04 / 2:00` line was the only
place a **peer without a local copy** could see anything at all — `refreshDisplay`
(`:661-672`) extrapolates `lastSyncPosition + elapsed` for exactly that case. It
survives on the SEEK scrubber, which **stays live for a peer with no file** (its
`max` is `fileMeta.duration` and its `value` is the extrapolated `displayPos`), so
the head still moves and its position is still readable through
`aria-valuetext`. **Nothing is weakened**: a slider showing where the head is is a
control position, not text.

### 7.2 ⚠ THE SYNC SEAM WANTS A STATE WORD, AND IT DOES NOT GET ONE — INCLUDING A `StatusLed`

`videobox-sync.ts` is exactly the shape that wants to paint `SYNCED` / `DRIFTING`
/ `FOLLOWING` / `2 PEERS`. The card, to its credit, **already paints none of
them** — `data-is-playing` is an attribute, and the button caption is `Play` /
`Pause`, which is a control caption on the control it operates and is permitted.

The tempting mechanism is `StatusLed` (`$lib/ui/controls/StatusLed.svelte`, gated
by `status-led-source.test.ts`) — the positive form, a static literal caption plus
a boolean lamp, with `detail` reaching `aria-label`/`title` and never a text node.
**It is refused, and the reason is about lamps rather than about text:**

> **A lamp must name a state a player can ACT on.** Drift correction is automatic
> and silent (`:491-499`, `:508-523`); "in sync" is the resting state of a working
> module, so a lamp lit at rest is decoration and a lamp lit on a 0.6 s correction
> is crying wolf. `loopback`'s lamp earns its place because `START CAPTURE` /
> `STOP` are gestures whose availability *depends* on the state it shows — the
> lamp and the buttons are one control. videobox has no such gesture.

And the one multiplayer state that IS actionable — **a peer loaded a file this
browser does not have** — is already an affordance rather than an indicator: the
re-link overlay, which occupies the picture, names the file and is itself the
button that fixes it. **A lamp beside it would be a second, worse copy of a
message the picture is already showing.**

Recorded here rather than left implicit, because "the sync module got no status
indicator" is the kind of absence a later reader would read as an oversight and
fix.

---

## 8. THE MIGRATION SURFACE — SEVEN SPECS, SIX OF THEM GREEN-AND-BLIND

`grep -rln videobox e2e/` returns 7 spec files plus four generated/config
artifacts. **Six boot `?shell=legacy`:**

| spec | boot | after promotion |
|---|---|---|
| `videobox-output.spec.ts` | `:101` legacy | survives — tests the card, which still exists |
| `videobox-performance-bundle.spec.ts` | `:60` legacy | survives |
| `videobox-upload-perf.spec.ts` | `:47` legacy | survives |
| `video-full-frame.spec.ts` | `:31` legacy | ⚠ survives, **and goes GREEN AND BLIND** — §8.2 |
| `multi-video-playback.spec.ts` | `:81` legacy | survives |
| `camera-input.spec.ts` | fixture | fixture use only |
| **`workflow-shell-video.spec.ts`** | **`/rack` — DEFAULT** (`:135`) | ⚠ §8.3 — it already asserts the promoted arrangement |
| **`collapse-keeps-playing.spec.ts`** | **`/rack` — DEFAULT** (`:107-110`) | ⚠ **THE HEADLINE — §8.1** |
| `per-module.spec.ts`, `per-module-per-port-behavioral.spec.ts` | registry-driven | auto-enrol; `_per-module-per-port-shared.ts:203` already carries a `why` |

### 8.1 ⚠ `collapse-keeps-playing.spec.ts` — SHARED WITH `videovarispeed`, AND BOTH MODULES BREAK IT THE SAME WAY

**Read `../videovarispeed/spec.md §8.1 in full — it is the same spec, the same two
failure modes, and the GREEN one masks the RED one.** The sweep is registry-driven
off `DOM_SOURCE_LANE_TYPES` (`:57-69`), so **videobox and videovarispeed are its
only two enrolled members** (the other five are network/capture sources that
`test.skip` by design, `:423-433`).

The two breakages, restated for this module:

* **(a) enrolment goes false → skip → green and blind.** `:441-447` requires a
  `*-file-input` `<input type=file>` and a `*-play-btn` `<button>` **inside
  `[data-testid="dock-full-view"]`**. After promotion the dock renders the body,
  so the predicate is a statement about what the body emits. §6.2 keeps both as
  real primitives for exactly this reason.
* **(b) the `<video>` assertions are dock-scoped → red.** `:456-459`, `:492` and
  `:303-305` query `[data-testid="dock-full-view"] video`; after promotion the
  element is in the **headless host** (the body blits, §0.2). The
  `waitForFunction` times out at 30 s.

⚠ **Because BOTH members break, promoting either module empties the sweep's
measuring population without emptying its test list.** If both are promoted and
the repair is missed, the file still reports two tests, both green, both skipped,
and the owner-P0 regression guard is gone. **The repair is one edit shared by both
PRs, and whichever lands first must carry it plus the permanent negative leg** —
assert the media element found for a faced member is NOT in the dock pane.

### 8.2 ⚠ `video-full-frame.spec.ts` — the `varispeed-panel-layout` shape, on videobox

It boots `?shell=legacy` (`:31`) and drives the CARD's Full Frame. After
promotion the card is still there under that flag, so **the spec stays green
while the surface a workflow-mode player operates is a different one**. That is
the green-and-blind state, and it is CLAUDE.md's *"a gate whose PRECONDITION is
the defect"* in the milder form the `varispeed-panel-layout` header already
described.

**Fix the SUBJECT, not the threshold.** Full Frame is not a legacy design being
superseded — it is a live affordance that must work on BOTH surfaces — so the
disposition is *add a leg*, not *delete the spec*:

1. keep the legacy leg (the card still exists at `?shell=legacy` and Full Frame
   still works there);
2. **add a default-shell leg** that opens the dock full view on a promoted
   videobox and drives the BODY's Full Frame, asserting the same
   `node.data.fullFrame` key toggles;
3. assert the two legs read the **same key**, which is what stops a body that
   quietly invented its own (`module-faceplates.md:246-249`).

### 8.3 `workflow-shell-video.spec.ts` — the one spec that gets STRONGER

Its videobox leg (`:1361-1381`) boots plain `/rack` and already asserts the
promoted arrangement: a uniform RACKLINE tile in the lane, an off-screen
lifecycle host carrying `data-node-type="videobox"`, and the real card plus its
`<video>` inside that host. **Promotion changes none of it** — it is a statement
about the LANE and the HOST, both of which are already in their post-promotion
state. The only addition worth making is asserting the lane tile now paints a
`VideoTileThumb` rather than a blank tile (M1, §13).

### 8.4 THE DOM-SELECTOR COST

The card testids the specs drive — `videobox-card`, `-video`, `-fs-wrap`,
`-drop-hint`, `-reallow-hint`, `-reallow-btn`, `-relink-hint`, `-relink-input`,
`-pick-label`, `-file-input`, `-error`, `-play-btn`, `-time`, `-seek`,
`-filename`, `-resize-handle` — **all keep resolving**, because the card survives
in the host and all six legacy specs boot into it.

The body re-emits the subset a player operates, under the same names, with one
exception: ⚠ **`videobox-time` is NOT re-emitted** (§7.1); its assertions move to
`aria-valuetext`. And `videobox-resize-handle` becomes
`videobox-face-resize-handle` on the body, matching the five existing adopters'
naming (`bentbox-face-resize-handle`, `ruttetra-face-resize-handle`, …).

---

## 9. VRT

Today: `EXEMPT_FROM_VRT` (`vrt-exemptions.ts:889`) and
`ALLOWED_PERMANENT_EXEMPT` (`:1180`). No `vrt.spec.ts` baseline PNG. No face
scenes.

The exemption's `why`: *"live `<video>` element + **ticking playhead readout**
defeat deterministic capture."* ⚠ **The face deletes the ticking playhead
readout** (§7.1), so half the stated reason ceases to exist on the faced surface.
Copying the sentence forward would be a stale ledger entry — rewrite it to the
`warrensspectrum` shape (`:882`): the operated surface is the faceplate, captured
by the two face scenes; this entry now covers only the LEGACY card at
`?shell=legacy`.

**The face scenes are capturable with NO `simPin`**, and the argument is
`samsloop`'s three-fact one:

1. **a freshly spawned videobox holds NO FILE** — no `<video>` has a `src`,
   `hasLocalFile` is false, so the body takes its empty branch (the drop-hint
   overlay);
2. **the idle picture has no time term** — `videobox.ts:56-62` is
   `outColor = vec4(0.05, 0.05, 0.08 + vUv.y * 0.05, 1.0)` when `uHasInput < 0.5`,
   a static gradient and a pure function of `vUv`;
3. **the seek scrubber is DISABLED at zero** — `disabled={durationSec <= 0}`
   (`:894`), `value={displayPos}` = 0.

**Predict: 2 files ADDED (`face-videobox-compact.png`, `face-videobox-dock.png`),
0 moved.** Add the `FACES` entry to `e2e/vrt/_shell-faces.ts` with `pages: 0` and
a **`videoFaceWhy`** — required, per `cameraInput`'s entry (`:2783-2787`): without
it `bootWithFace` waits out the full 90 s timeout for a mixer-column membership a
video node never acquires.

Dispatch **scoped**: `GREP=videobox flox activate -- task vrt:commit`. **Count what
the bot commits against the prediction; a green dispatch that committed nothing is
a RED FLAG.**

---

## 10. COST

### 10.1 ⚠ WEBGL ATTEST — MANDATORY. THIS IS THE HEADLINE COST DIFFERENCE FROM `videovarispeed`.

```
flox activate -- bash scripts/webgl-attest-hash.sh --list | grep -iE 'videobox|video-frame-upload|keepalive'
  packages/web/src/lib/video/modules/videobox-sync.ts
  packages/web/src/lib/video/modules/videobox.ts
  packages/web/src/lib/video/video-audio-keepalive.ts
  packages/web/src/lib/video/video-frame-upload.ts
```

`HASH_TRANSPARENT_PROPS` strips a def's **top-level** `docs`, `controlFamilies`,
`face` and `noUserControl`. So:

| edit | attest |
|---|---|
| `face: {...}` on `videoboxDef` | **ZERO** |
| `noUserControl: [...]` at def top level | **ZERO** |
| the `docs.explanation` rewrite (§2.3, VB-D3) | **ZERO** |
| ⚠ **deleting the `gain` ParamDef (§0.1)** | ⚠ **MOVES THE HASH** |
| ⚠ deleting the `gain` field from `VideoboxParams` / `DEFAULTS` | ⚠ **MOVES THE HASH** |

> **Unlike every other face in this program, a videobox face CANNOT be
> hash-neutral, because the thing that makes the face legal at all is a param
> deletion.** There is no PR split that avoids it: the face and the contract
> change are the same change.

So the cost is **one real-machine attest window**, and the standing GPU grant
covers it. The consequences for scheduling are concrete:

* **do NOT have `videovarispeed`'s PR 2 (its SPEED landmark roster,
  `../videovarispeed/spec.md §10.1`) in flight against the same window** — two
  basis-touching PRs racing one attest pin is the `attest-pin-covers-tree-not-pr`
  failure;
* ⚠ **attest the MERGED tree, not the branch tip.** If `main` moves a basis file
  under you, your hash changes without your diff changing. Match CI's refusal hash
  before spending the GPU, and never measure attest state in a dirty primary
  checkout.

Measure both directions anyway: clean merged tree → after `face` +
`noUserControl` + `docs` **only** (must be UNMOVED) → after the `gain` deletion
(must MOVE). The first leg is what proves the *face* is free and the contract
change is what is being paid for.

### 10.2 ART — ZERO, measured

No `art/baselines/videobox/`. The audio profile gate enumerates **audio-domain
ids only** (`audio-profile-gate.test.ts`, matching `/^(\S+) meta domain=audio\b/`);
videobox is `domain: 'video'` (`videobox.ts:117`). **`art/` should be absent from
this diff.**

### 10.3 CONTRACT — moves, and the diff is PREDICTABLE TO THE LINE

`contract-lock.txt:3556-3562` currently reads:

```
videobox meta domain=video
videobox in play_trigger gate param=cv_play_trigger edge=trigger
videobox out audio_l audio
videobox out audio_r audio
videobox out video video
videobox param cv_play_trigger 0..1 linear default=0
videobox param gain 0..2 linear default=1
```

**Prediction: exactly ONE line is removed —
`videobox param gain 0..2 linear default=1`.** `face` is fully
contract-transparent and `noUserControl` is not projected. Run
`flox activate -- task docs:accept` and **read the diff**: anything other than
that single deletion means something else changed, and is a stop-and-read.

`videobox` is in `STRICT_DOCS` (`strict-docs.ts:367`), so the `docs.controls.gain`
entry must be deleted with the param (completeness runs both ways).

### 10.4 CI wall-time

New: two VRT face scenes (they ride the scoped dispatch), one new unit file, one
new leg on `video-full-frame.spec.ts` (§8.2), and edits to
`collapse-keeps-playing`. `faces-parity` enrols the module at **zero cells**, so
its budget is the flat `10 s` boot term. **Estimated PR delta: well under 2
minutes.** ⚠ **Re-pin BOTH cost artifacts** — `task e2e:timings:accept` AND
`task vrt:strict:timings:accept`.

### 10.5 The Push 2 card moves

videobox has no explicit `PUSH_CARD_CONTROLS` entry, so its card is resolved from
the live def. Today it ranks `gain` and `cv_play_trigger` in declaration order.
After this PR it ranks **nothing**: `gain` is deleted and `cv_play_trigger` is
dropped by `push-card-schema.ts:96-98`. **A raw gate cache and a param with no
effect leave a hardware controller** — an improvement, a behaviour change outside
the faceplate, and a deliberately accepted golden diff.
`push-card-schema.test.ts` is a must-run.

---

## 11. DEFECT LEDGER — live on `main`, independent of any face

| # | defect | evidence | routing |
|---|---|---|---|
| **VB-D1** | ⚠ **`node.data.fullFrame` and `node.data.width`/`height` are BARE PROXY WRITES** — no `transact`, no `LOCAL_ORIGIN` — so **Cmd-Z cannot undo a Full Frame toggle or a resize**, while the play/pause/seek triple in the same file IS correctly tagged. A new census state: one module in two rows at once (§0.3). | `VideoboxCard.svelte:701-708`, `:744-751` vs `:166-181`, `:183-211`; `mutate.ts:13-18`; `store.ts` `trackedOrigins` | **fix in this PR** — `mutateNode` on both, on the card AND in the new body |
| **VB-D2** | ⚠ **`gain` is a declared param nothing writes and nothing reads.** Invisible while no surface ranks it; unavoidable the moment a face must rank every param. The `twotracks` precedent. | `videobox.ts:102-103`, `:135`, `:153`; the shader at `:56-62`; `contract-lock.txt:3562` | **fix in this PR** — DELETE (§0.1). ⚠ This is what makes the attest mandatory |
| **VB-D3** | ⚠ **The docs promise a surface promotion removes.** `docs.explanation` describes the corner-drag resize and the 360×360 wall of TVs; `wcolCardWidthPx` takes a TYPE and returns `SHELL_TILE_W = 192` for every faced module. Leaving it is the `modtris`/`score` class — documentation promising behaviour that is not there, on a `STRICT_DOCS` module, invisible to `module-docs-lint` because that gate reads the DEF. | `videobox.ts:143` vs `Canvas.svelte:641-652` | **fix in this PR** — rewrite to name full frame / fullscreen / detach / body resize. Prose, hash-transparent |
| **VB-D4** | ⚠ **The def and the card both promise a peer message that no code renders.** `videobox.ts:22-24` and `VideoboxCard.svelte:12` say peers see *"{user} loaded {filename} — pick your own copy"*. `VideoboxFileMeta.loaderUserId` exists (`videobox-sync.ts:59`) and **`grep -rn loaderUserId packages/web/src e2e` finds exactly one other hit — a persistence test FIXTURE.** No producer writes it and no surface reads it. The card renders `Re-link: drop "{name}"` with no attribution. | direct read + grep | **fix in this PR** — either drop the promise from both headers, or write `loaderUserId` at load and render it in the re-link overlay. ⚠ Recommend **dropping the promise**: attribution needs a user identity the module does not have, and inventing one is out of scope. Comment-only either way |
| **VB-D5** | ⚠ **`video-full-frame.spec.ts` goes green-and-blind on promotion** — it boots `?shell=legacy` and drives the card's Full Frame, so it keeps passing while the operated surface is the body. | `video-full-frame.spec.ts:31`; `_fixtures.ts:78-93` | **fix in this PR** — §8.2's added default-shell leg plus the same-key assertion |
| **VB-D6** | ⚠ **A dead branch plus a stale comment in the video-zone packing.** `Canvas.svelte:2880-2887` reads a per-node `node.data.width` for *"a LEGACY-rendered default — videoOut, the video-surface snowflake whose real card stays in the lane"*, guarded by `NON_SHELL_LANE_TYPES.has(spec.type)`. **`videoOut` is in `STRICT_FACES` (`strict-faces.ts:2075`) and is NOT in `NON_SHELL_LANE_TYPES` (`legacy-fallback.ts:96-112`)**, and neither is any of the three `VIDEO_ZONE_DEFAULTS` (`channel-columns.ts:585-587`). The branch is unreachable; its comment describes a carve-out removed by #1821. | direct read, both sets | ⚠ **NOT this PR** — it is `videoOut`'s residue, and a Canvas edit does not belong in a face diff. **Route to the owner as a one-line cleanup.** It is load-bearing for §2.3 and so is recorded here |
| **VB-D7** | ⚠ **`videobox` has NO `DESCRIPTIONS` entry — and this is NOT a defect.** Recorded because the obvious reading is that it is one. `describeModule` falls back to `MODULE_DOCS[type]?.explanation` before the sentinel (`module-manifest.ts:1088-1098`), *"which is what lets most video modules render a real intro without duplicating their prose into DESCRIPTIONS"*, and `module-manifest.test.ts:71-87` asserts against the SENTINEL rather than against the map. **Checked, came back different from the expectation, kept.** ⚠ Note the asymmetry: `videovarispeed` DOES have a `DESCRIPTIONS` entry, and it is the one that is WRONG (`../videovarispeed/spec.md` D5) | `module-manifest.ts:1088-1098`, `module-manifest.test.ts:71-87` | **no action** |

---

## 12. TASTE CALLS, EACH WITH ITS ONE-LINE REVERT

| call | revert |
|---|---|
| `gain` is DELETED rather than WIRED | wire it: add `uGain` to the shader, a `gain` CV input, and keep the param — ⚠ the attest cost is identical either way |
| the face ranks NOTHING (`order: []`) | if `gain` is wired instead, `order: ['gain']`, `paramCells: { gain: 'fader' }` |
| DETACH and PRESENT are added | drop them from the body — ⚠ but re-read §2.3 first; they are the parity argument |
| the body gets a corner resize grip | drop the grip; the body then sizes to the plate |
| no `StatusLed` for sync state | add one — ⚠ §7.2 is the argument against, and it is about lamps, not text |
| the SCREEN switch overlays the picture's corner | — (a stacked row is the named anti-pattern) |
| no tab rail | — (zero bands; a rail is not reachable) |

---

## 13. MUST-VERIFY (before the face is written)

* **M1 — the lane picture actually paints, both directions.** Spawn a promoted
  videobox, load a fixture, and read the lane tile's thumb: non-black with a clip,
  and matching the idle gradient (`rgb ≈ (13,13,20)` from `videobox.ts:59`) with
  no file. Both directions, because "black" and "never looked" are
  indistinguishable from one reading. Fold into
  `workflow-shell-video.spec.ts:1361-1381`, which already has the node.
* **M2 — the `gain` deletion is contract-exact.** Run `task docs:accept` and
  confirm the diff is **exactly one removed line** (§10.3). Anything else is a
  stop-and-read.
* **M3 — the two fullscreen/full-frame attach pairs do not fight.** With the dock
  open on a promoted node, the CARD's `fs.attach()` / `ff.attach(cardEl, …)` and
  the BODY's are both live (§2.1). Drive Full Frame and Escape from the body and
  confirm exactly one toggle per gesture, no double-fire, and that the card's
  document-level handlers do not intercept. ⚠ Measure it; do not reason about it.
* **M4 — the `noUserControl` declaration is accepted, and ranking it is RED.**
  Run `no-user-control.test.ts` + `module-face-lint.test.ts`, and drive the
  negative control (rank `cv_play_trigger`, confirm it reddens).
* **M5 — `collapse-keeps-playing` still enrols BOTH members and still measures.**
  ⚠ Read the skip count. A green run that skipped videobox is the §8.1 failure.
* **M6 — `fullFrame` round-trips on the SAME key across both surfaces.** Toggle it
  from the body, reload, and confirm the legacy card at `?shell=legacy` comes back
  in full frame — and that Cmd-Z now undoes it (VB-D1).
* **M7 — the attest hash moves ONLY for the `gain` deletion.** Three-leg
  measurement per §10.1.

---

## 14. VERIFICATION GATE

```bash
# 1. the face model + its permanent negative controls
flox activate -- npx vitest run packages/web/src/lib/ui/workflow/videobox-face-model.test.ts

# 2. face lint + the promotion anchor (both directions)
flox activate -- npx vitest run packages/web/src/lib/ui/workflow/module-face-lint.test.ts

# 3. the noUserControl soundness sweep
flox activate -- npx vitest run packages/web/src/lib/ui/workflow/no-user-control.test.ts

# 4. THE THREE GATES A FACE PR SATISFIES
#    (a) the face lints / STRICT_FACES promotion anchor  -> step 2
#    (b) the VRT baselines (compact + dock)              -> step 10
#    (c) EXTENSION_BODY_ROLES — deny-by-default over every fullViewBody
flox activate -- npx vitest run packages/web/src/lib/ui/workflow/face-rack-status-source.test.ts

# 5. the rulings' source gates
flox activate -- npx vitest run \
  packages/web/src/lib/ui/controls/face-readout-source.test.ts \
  packages/web/src/lib/ui/controls/status-led-source.test.ts \
  packages/web/src/lib/ui/workflow/face-resting-text-source.test.ts \
  packages/web/src/lib/ui/workflow/video-face-screen-source.test.ts \
  packages/web/src/lib/ui/dock/face-width-source.test.ts

# 6. the registries + the shared-file neighbours
flox activate -- npx vitest run \
  packages/web/src/lib/ui/workflow/shell-extensions.test.ts \
  packages/web/src/lib/ui/workflow/module-shell-import-guard.test.ts \
  packages/web/src/lib/ui/workflow/face-migration-inventory.test.ts \
  packages/web/src/lib/ui/workflow/dom-source-modules.test.ts \
  packages/web/src/lib/ui/media/card-media-lifetime.test.ts \
  packages/web/src/lib/ui/modules-card-map.test.ts \
  packages/web/src/lib/control/push2/push-card-schema.test.ts \
  packages/web/src/lib/docs/module-manifest.test.ts

# 7. the module's own suites + the CONTRACT-CHANGE blast radius
flox activate -- npx vitest run packages/web/src/lib/video/modules/
flox activate -- npx vitest run packages/web/src/lib/graph/persistence.test.ts
#    ⚠ persistence.test.ts:720 carries a videobox fileMeta fixture (VB-D4) — a
#    param deletion must not disturb it, and if it does, read why.

# 8. docs contract — a PARAM IS DELETED. Re-pin and READ the diff.
flox activate -- task docs:accept && flox activate -- git diff packages/web/src/lib/docs/contract-lock.txt
#    ⚠ EXPECT EXACTLY ONE REMOVED LINE:
#      videobox param gain 0..2 linear default=1
#    Anything else — stop and read it.

# 9. e2e — REPEAT=3 on both changed specs
flox activate -- task e2e:serve
REPEAT=3 flox activate -- task e2e:one -- tests/collapse-keeps-playing.spec.ts
REPEAT=3 flox activate -- task e2e:one -- tests/video-full-frame.spec.ts
REPEAT=3 flox activate -- task e2e:one -- tests/workflow-shell-video.spec.ts
REPEAT=3 flox activate -- npx --workspace e2e playwright test faces-parity --grep videobox
REPEAT=3 flox activate -- task e2e:one -- e2e/vrt/workflow-shell-faces.spec.ts
flox activate -- task e2e:stop
#    ⚠ READ THE SKIP COUNT on the collapse run (§8.1).

# 10. the exemption ledger + typecheck LAST
flox activate -- task test:ledger:accept
flox activate -- task typecheck

# 11. VRT: dispatch only, SCOPED, and COUNT the files (§9). NEVER commit a PNG.
GREP=videobox flox activate -- task vrt:commit
#    PREDICTION: 2 files ADDED, 0 moved.

# 12. BOTH cost artifacts (§10.4)
flox activate -- task e2e:timings:accept -- <run>
flox activate -- task vrt:strict:timings:accept -- <run>

# 13. ⚠ ATTEST IS MANDATORY HERE (§10.1). Three legs, then spend the GPU.
flox activate -- bash scripts/webgl-attest-hash.sh
```

---

## 15. VERDICT, RISK, ESTIMATE

**PROMOTE, with a CONTRACT CHANGE in the same PR** — the `twotracks` shape. It is
not "promote with a precursor": the deletion of `gain` and the face are the same
change, and splitting them would leave a face that cannot pass
`module-face-lint` for as long as the split lasted.

**Risk: MEDIUM**, and the three sources are unequal:

1. ⚠ **the attest is MANDATORY and unavoidable** (§10.1) — the only module in
   this program whose face cannot be hash-neutral. This is scheduling risk, not
   technical risk, and it is why videobox and `videovarispeed`'s PR 2 must not
   race one window.
2. **`collapse-keeps-playing`** — shared with `videovarispeed`, and the sweep's
   whole enrolled population is those two modules (§8.1). The green failure masks
   the red one.
3. **the wall-of-TVs argument** (§2.3) — the analysis is settled and the
   precedent is `videoOut`, but it is the part a reviewer will push on, and the
   PR body has to carry it rather than the spec.

**Estimate: ≈ 12 h**, as: the contract change and its blast radius ≈ 2 h; a
~300-line body (the picture, the transport, four screen affordances, the resize
grip) ≈ 5 h; the two registries and the face-model unit ≈ 2 h; the
VB-D1/D3/D4/D5 repairs ≈ 2 h; the VRT roster entry and the exemption rewrite
≈ 1 h. **Plus one attest window.**

**Build it FIRST in cohort A.** It is the smaller sibling, it settles the shared
body shape (the blit, the SCREEN switch, the transport row) on a third of
`videovarispeed`'s surface, and its lane/host arrangement is **already asserted on
`main`** by `workflow-shell-video.spec.ts:1361-1381`. ⚠ But it is the one that
spends the GPU, so land it and let the attest settle before
`videovarispeed`'s PR 2 goes near a basis file.

---

## 16. ⚠ DO THESE TWO MODULES WANT THE SAME MEDIA-CONTROLLER SHAPE? — THE WAVE'S CROSS-MODULE QUESTION

**YES — the same SHAPE, and it is a shape neither `cameraInput` nor `loopback`
has.** Named concretely:

| dimension | videobox | videovarispeed | same? |
|---|---|---|---|
| lane render | `ModuleShell` tile + `VideoTileThumb` (free, `domain === 'video'`) | identical | ✅ |
| card disposition | `<HeadlessSourceHost>`, `left:-9999px`, `pointer-events: none` | identical | ✅ |
| body slot | `fullViewBody` | identical | ✅ |
| body role | `picture` | `picture` | ✅ |
| the picture | `blitOutputForPreview(nodeId)` into a 480×360 2D canvas in a rAF | identical | ✅ |
| ⚠ the `<video>` | **NEVER adopted** — 1 element | **NEVER adopted** — 7 elements | ✅ same rule, 7× the blast radius |
| status registry | ⚠ **NONE** | ⚠ **NONE** | ✅ — and this is the divergence from cameraInput/loopback |
| SCREEN switch | `node.data.previewCollapsed`, corner overlay | identical | ✅ |
| `markWatched` while OFF | kept, but **not** for the #2015 reason — both are unconditionally pull-exempt via `audioSources` | identical | ✅ |
| PLAY + file pick | real `<button data-testid$="-play-btn">` + real `<input type=file data-testid$="-file-input">`, **forced by `collapse-keeps-playing`'s DOM-derived enrolment** | identical | ✅ |
| **ranked cells** | ⚠ **ZERO** (`order: []`, videoOut's shape) | ⚠ **THREE** (`speed`, `start`, `end`), two bands | ❌ **the one real divergence** |
| contract change | ⚠ **REQUIRED** — delete `gain` | none | ❌ |
| attest | ⚠ **MANDATORY** | **ZERO** for the face; a separate PR for landmarks | ❌ |
| `.data` discipline | ⚠ **SPLIT** — 2 correct, 2 bare | ✅ all five correct | ❌ |

**The concrete shared shape, in one sentence:**

> **A `picture`-role `fullViewBody` that BLITS the engine output, carries a real
> `<button>` transport and a real `<input type="file">` (not a `ShellToggleCell`
> and not a `ShellFileCell`), reads and writes the module's state directly off
> `node.data` through `mutateNode`, mounts a corner-overlaid SCREEN switch on the
> shared `previewCollapsed` key, and needs NO status registry — while the real
> card stays alive off-screen in `<HeadlessSourceHost>` owning the element, the
> decode, the gate loops and the export resolver.**

**The one dimension where they diverge is BANDS, and the divergence is honest**:
videovarispeed has three real transport params and videobox has none, so one is a
two-band face with a body and the other is a bodies-only face. That is not two
architectures; it is the same architecture with the ranked list empty.

⚠ **AND THE COHORT'S THIRD SHAPE IS THE ONE THAT ALREADY EXISTS AND MUST NOT BE
COPIED.** `cameraInput` and `loopback` needed a status registry — a *remote
control* seam publishing the card's state and registering its commands — because
**their state is not in the graph**. Reaching for `camera-status-registry`'s shape
on a local-file player would be a copied solution to a problem these two modules
do not have, and it would introduce a second owner of state the Y.Doc already
owns. **The discriminator is one question, and it is worth being the wave's
headline: is the thing the body needs to show and drive IN THE GRAPH?** If yes:
body reads `node.data`, no registry. If no: a status registry, with a `delivered`
ledger on every command.
