# FACEPLATE BUILD SPEC — `archivist` (video, the ARCHIVE.ORG RANDOM-ITEM SOURCE)

**SPEC ONLY. Nothing here is implemented.** Mockups: [`dock.html`](dock.html) ·
[`dock-loaded.html`](dock-loaded.html).

Sibling spec: [`../peertube/spec.md`](../peertube/spec.md). The two were written
together because they look like the same design problem — two network-backed
search browsers, both `bespoke-surface`, both carrying `needs-media-controller`
**and** `needs-note-entry-cell`, both with a `*-query.ts` pure sibling. **They are
not the same problem, and §4 and §6.1 are where they part company.** Where a claim
is shared, this spec states it and the sibling cites it rather than restating it.

Method: analyse what the module is FOR, then author the spec, then build from the
spec. Every claim carries the file and line it was measured from, and the ones that
**came back different from the rule** are marked ⚠ and kept — the correction is the
finding.

---

## 0. THE CONSTRAINT MAP, READ FIRST

| constraint | archivist's answer | measured at |
|---|---|---|
| `NON_SHELL_LANE_TYPES` | **NOT a member** | `legacy-fallback.ts` — the set is `group, sticky, cadillac, clipplayer, controlSurface, electraControl, launchpadControlLeft` |
| `DOM_SOURCE_LANE_TYPES` (the #1511 tax) | ⚠ **MEMBER.** The card is kept alive off-screen, forever | `dom-source-modules.ts:89-97` |
| `HEADLESS_MOUNT_LANE_TYPES` | member, via the set above | `dom-source-modules.ts:225-228` |
| lane picture | **FREE and per-node — but BLANK for the module's DEFAULT media type.** §4 | `module-shell-model.ts:237-240`; `archivist.ts:453-467` |
| `face.glyph` | `'none'` — ⚠ and **NOT for the reason every other video def's comment gives.** §4.1 | `shell-glyph-live.ts:111-113`; `archivist.ts:167-169` |
| WebGL attest | ⚠ **THREE files in the basis**: `archivist.ts`, `archivist-query.ts`, `archivist-scrub.ts` | §10.1 |
| ART | none — video domain is outside the audio gate | §10.2 |
| VRT | **`EXEMPT_FROM_VRT` and `ALLOWED_PERMANENT_EXEMPT`. NO card baseline exists.** So promotion moves ZERO and adds TWO | §9 |
| shell extension slot | `fullViewBody`. Never a `selector`, never a `panel` — §6.1 | `shell-extensions.ts:124` |
| `EXTENSION_BODY_ROLES` | `picture` — ⚠ and the predicate is satisfied only because the body mounts a `<canvas>`, which is a **design constraint**, not a description. §6.5 | `face-rack-status-source.test.ts:142`, `:473-491` |
| tab rail | **NO.** One ranked control is one band | `dock-tabs-model.ts` (`DOCK_TAB_MIN_BANDS = 7`) |
| `node.data` writes / Cmd-Z | ⚠ **SPLIT: the four CONTENT writers are correct, the RESIZE writer is a bare proxy write** | §0.3 |

### 0.1 ⚠ THE PARAM SET IS TWO, ONE IS SYNTHETIC — AND THE OTHER IS DEAD

`archivist.ts:178-181`:

```ts
{ id: 'gain',            label: 'Gain',         defaultValue: 1.0, min: 0, max: 2, curve: 'linear' },
{ id: 'cv_play_trigger', label: 'Play trigger', defaultValue: 0,   min: 0, max: 1, curve: 'linear' },
```

`cv_play_trigger` is the ordinary synthetic-gate case and `noUserControl` handles it
(`writer: 'cv-port'` is the only legal value, because `archivist.ts:163` declares
`play_trigger` with `paramTarget: 'cv_play_trigger'` — `no-user-control.ts:112`
makes `'cv-port'` red without such a port and `:121` makes `'internal'` red with
one).

**`gain` is the problem, and it is the sharpest instance of a rule CLAUDE.md
states in the abstract.** The def's own `docs.controls.gain` (`:199`):

> *"Output gain, linear 0..2 (default 1). **Reserved in v1 — declared on the module
> but not yet consumed in the signal path.**"*

Read at the site rather than believed: `archivist.ts:347-385` is the whole of
`surface.draw`. It sets `uTex` and `uHasInput` and calls `drawFullscreenQuad()`.
There is **no `uGain` uniform in `FRAG_SRC`** (`:68-84`) and **no `uniform1f` call
for one**. `setParam` (`:428-433`) stores the value into a local record that
nothing reads.

⚠ **And it cannot be reached from a cable either.** archivist declares exactly one
input (`:161-164`, `play_trigger`), so no `paramTarget` writes `gain`. The card
(926 lines) renders no `gain` control at all — the STOP-2 grep returns no fader, no
knob, no slider bound to it. **So `gain` is unreachable AND inert, and its value in
every saved patch that has ever existed is exactly its default, `1.0`.**

Now the face makes that visible, because `module-face-lint`'s completeness loop is
unconditional over `def.params` and the render-side twin requires exactly one
interactive cell per param. The three available moves:

| move | consequence |
|---|---|
| **rank it** | a faceplate ships a dial that moves and does nothing. CLAUDE.md names this exact shape: *"a green gate certifying a live bug"* |
| **`noUserControl: [{ param: 'gain', writer: 'internal', … }]`** | mechanically legal (`no-user-control.ts:121` only reddens `'internal'` when a port DOES target it, and none does) and **dishonest**: the field means "something else writes it", and nothing writes it. It would convert a live defect into a permanent, gated declaration that the defect is intentional |
| ⚠ **WIRE IT** — 3 lines, and it is the only honest option | §0.1.1 |

#### 0.1.1 WIRING `gain` IS THREE LINES, IT IS ALREADY WRITTEN ELSEWHERE, AND AT DEFAULTS IT IS BYTE-IDENTICAL

The pattern is shipped four times over in the same directory:

```
picturebox.ts:92    uniform float uGain;
picturebox.ts:101     vec3 col = texture(uTex, vUv).rgb * uGain;
picturebox.ts:361     const uGain = gl.getUniformLocation(program, 'uGain');
picturebox.ts:525     g.uniform1f(uGain, params.gain);
```

and identically at `camera-input.ts:43, 80, 326, 508` and `loopback.ts:54, 77, 209,
365`. **Three of the fleet's video sources wire it; archivist, peertube, videobox
and tvLibrarian do not** (`grep -l "Reserved in v1\|currently inert"` over
`video/modules/` returns exactly `archivist.ts`, `peertube.ts`, `videobox.ts`, and
peertube's docs name tvLibrarian as the fourth at `peertube.ts:153`).

⚠ **THE PIXEL ARGUMENT IS PROVABLE RATHER THAN PERSUASIVE.** `gain` defaults to
`1.0`, no cable can write it, and no UI has ever exposed it — so `params.gain` is
`1.0` in **every node that has ever been serialised**, and `rgb * 1.0` is the
identity. **A wired `gain` changes no existing patch by one bit.** It only starts
working when a player moves the new control. That removes the "look change needs an
owner preview" objection that would otherwise attach to editing a shader.

⚠ **IT IS NOT FREE, THOUGH.** `archivist.ts` is in the WebGL attest basis (§10.1)
and a `uniform float` plus a `uniform1f` is ORDINARY CODE, not a hash-transparent
def property. **This is the one edit in the whole PR that costs a real-GPU
re-attest window.** §10.1 carries the routing, and it is the same window for the
sibling — one attest for both modules, not two.

### 0.2 ⚠ THE `needs-media-controller` TAX, NAMED EXACTLY

The brief for this wave asked each spec to say **what tax it pays**. archivist pays
the FULL cameraInput tax, and the reason is one line of a shipped set:

`dom-source-modules.ts:89-97` —

```ts
export const DOM_SOURCE_LANE_TYPES: ReadonlySet<string> = new Set<string>([
  'archivist', 'cameraInput', 'loopback', 'peertube',
  'tvLibrarian', 'videobox', 'videovarispeed',
]);
```

Membership means the real card is mounted in `<HeadlessSourceHost>` whenever the
lane is not showing it. And `Canvas.svelte`'s `fullViewShowsFaceInstead` keeps it
mounted **even while the dock full view is open**, because for a MIGRATED
DOM-source module the dock shows the faceplate rather than the card:

```ts
// Canvas.svelte (headlessSourceNodes derivation)
const fullViewShowsFaceInstead =
  dockStore.isFullView(n.id) && migrated(n.type) &&
  (DOM_SOURCE_LANE_TYPES.has(n.type) || (CARD_PRODUCER_LANE_TYPES.has(n.type) && !FACE_MOUNTS_PRODUCER.has(n.type)));
```

`HeadlessSourceHost.svelte` parks each host at `left:-9999px` with real dimensions
and `aria-hidden="true"`; `camera-status-registry.ts:12-14` records the operative
consequence in one sentence: *"an off-screen pointer-events-none subtree cannot be
clicked."*

**So the tax is exactly this: `archivist`'s engine state survives promotion
untouched, and every one of its NINETEEN interactive affordances becomes
unreachable.** `nodeMedia` already owns the three elements, the audio wiring, the
gate/CV ConstantSourceNodes and the item URL — none of that is at risk. What is at
risk is the entire UI. The `fullViewBody` is the only surface a player can touch,
which is the sentence `CameraInputOutputBody.svelte:17-28` opens with, and it is
why that body is *"THE WIDEST BODY IN THIS ROSTER"* (`face-rack-status-source.test.ts:381`).

**This blocker DOES NOT BLOCK THE FACE.** `face-migration-inventory.ts:378-385`
already settles it — *"a card-owned-source module CAN be faced while that blocker is
outstanding, by paying the headless-host tax and rebuilding the card-only
affordances"* — and `cameraInput` and `loopback` are the two modules that proved it.
⚠ #1511 is CLOSED and its acceptance is **not** met: `DOM_SOURCE_LANE_TYPES` still
has seven members and `HeadlessSourceHost.svelte` still exists
(`face-migration-inventory.ts:622-628` says so outright). **Nothing in this spec
waits on it, and nothing in this spec should be read as asking for it.**

### 0.3 ⚠ THE `.data` CENSUS — ARCHIVIST IS A **SPLIT** CASE, WHICH IS A FOURTH STATE

Waves 3–5 built a three-state table (bare proxy write / untagged `transact` /
`transact` + `LOCAL_ORIGIN`). archivist does not fit any single row, because **the
same card does two of them.**

| writer | site | tagged? |
|---|---|---|
| `writeItem` (the loaded item) | `ArchivistCard.svelte:217-224` | ✅ `ydoc.transact(…, LOCAL_ORIGIN)` |
| `writeSearchInputs` (term, type, years) | `:227-236` | ✅ |
| `writePlaying` | `:239-244` | ✅ |
| `updateDuration` | `:432-445` | ✅ |
| ⚠ **the corner-resize `apply`** | **`:616-621`** | ❌ **a bare proxy write — no `transact`, no origin** |

```ts
apply: (w, h) => {
  const t = patch.nodes[id];
  if (t) {
    if (!t.data) t.data = {};
    (t.data as Record<string, unknown>).width = w;
    (t.data as Record<string, unknown>).height = h;
  }
},
```

`mutate.ts:13-18` states the consequence: an untagged write *"is silently NOT
undoable"*, because `store.ts:70` configures `trackedOrigins: new
Set<unknown>([LOCAL_ORIGIN])`.

⚠ **THE SIBLING IS BYTE-FOR-BYTE THE SAME BUG** — `PeerTubeCard.svelte:518-524` is
the identical block with the identical omission, which is wave 5's *"the raw-write
pattern PROPAGATES BY COPY"* finding recurring on a third pair. Both come from
`startCornerResize` (`card-resize.ts`), whose `apply` callback the CALLER supplies —
so this is a shape every corner-resizable card can get wrong independently.

**⚠ AND `mutate.guard.test.ts` IS BLIND TO IT IN TWO WAYS AT ONCE**: its three
patterns anchor on the literal token `.params` (wave 5 verified at `:94-110`), and
these writes are on `.data`. So the guard is green over both.

**Routing:** the four content writers need no change. The resize writer is fixed
**inside this PR** — one `mutateNode(id, live => {…})` call, which
`$lib/graph/mutate` already tags — and the same fix rides the sibling's PR.
⚠ **Do not "fix" it by wrapping in a bare `ydoc.transact(fn)`**: wave 5 measured
that shape on `chromaconsole` and it is atomic but still outside the undo stack.

⚠ **A resize is a genuinely debatable undo target** and this spec does not claim it
must be undoable — it claims the *origin decision should be made*, and today it is
made by omission. If the intended answer is "a resize should not pollute the undo
stack", `mutateNode`'s own API takes a non-tracked origin and says so
(`mutate.ts:22-26`), so the deliberate version is one argument away and reads as a
decision instead of a gap.

### 0.4 ⚠ `needs-note-entry-cell` DOES NOT BLOCK THIS MODULE — AND THE REASON IS NOT SCORE'S

This is the one place in the cohort where a platform capability might legitimately
be needed, so it was checked before anything else.

`face-migration-inventory.ts:173-191` defines the capability:

> *"a note/short-text entry **face cell** — card-primitive-parity declares NoteEntry
> `via: none`, and a raw `<input type="text">` shares the gap, so a typed pitch
> field ("c#3"), a MIDI note number or a name field **has no face representation at
> all**"*

and its probe (`:188`) is `tree.faceShellMountsTypedEntry` — i.e. *"does
`ModuleShell.svelte`, the ONE renderer every face cell is painted by, mount typed
entry"*. Verified: it does not. `shell-cells.ts` declares exactly six kinds —
`selector` (`:168`), `action` (`:287`), `file` (`:306`), `toggle` (`:316`), `panel`
(`:386`), `warped-fader` (`:440`) — and **none of them paints a text field.**
The capability gap is REAL and correctly stated.

⚠ **It is nevertheless not in archivist's way, and the reason is different from
`score`'s.** Wave 5 cleared score by measuring that *score types nothing* —
its note entry is a pointer gesture (`score/spec.md §0.4`). **archivist types.** Its
search box is a literal `<input type="text">` (`ArchivistCard.svelte:664-673`) and
two `<input type="number">` year fields (`:676-694`).

The clearing argument is one word in the capability text: **CELL.**

> A `fullViewBody` is a SLOT, not a cell. It is an ordinary Svelte component
> resolved through a lazy `import.meta.glob` (`shell-extensions.ts`), it satisfies
> no cell contract, it declares no probe, and `ModuleShell` renders it as
> `<ExtFullViewBody nodeId={id} />`. **An `<input type="text">` inside it is
> ordinary markup and nothing in the platform is in a position to refuse it.**

That is the same escape `samsloop`'s waveform took — *"it rides the `fullViewBody`
extension slot, which needs no probe because it is a SLOT rather than a cell"*
(`module-faceplates.md`, the samsloop entry).

⚠ **AND IT IS UNPRECEDENTED, WHICH IS WORTH SAYING RATHER THAN GLOSSING.** Measured
across every `shell-extension.ts` in the tree: **no existing `fullViewBody` contains
a text input.** `grep -rl 'type="text"' packages/web/src/lib/ui/modules/` returns
eleven files and **every one of them is a legacy `*Card.svelte`** (plus
`dx7/Dx7OpDetail.svelte`, which is a panel-cell internal, not a body). So archivist
and peertube would be the first two bodies in the fleet to carry one.

**Nothing gates it either way**, and that is the honest statement of the risk:
`face-resting-text-source.test.ts` names extension-body markup as its own blind spot;
`module-face-lint` walks params and families; `faces-parity` walks `control-*`
testids derived from the def's param set. A text input in a body is invisible to all
three. **It is legal and unobserved.** The corresponding assertion belongs in a
`archivist-face-model.test.ts` source check plus the e2e in §13.

**VERDICT ON THE BLOCKER, and it is the SAME for both modules:** `needs-note-entry-cell`
is a real capability gap, correctly scoped to CELLS, and **neither `archivist` nor
`peertube` needs it** — because on both modules the typed query is inseparable from
the surface it drives (a query without its results is not a control), and that
surface is a body either way. **Do not schedule a note-entry cell for this cohort.**
The two `blockers: ['needs-media-controller', 'needs-note-entry-cell']` arrays
(`face-migration-inventory.ts:637`, `:948`) should lose their second entry when
these faces land.

---

## 1. WHAT THE MODULE IS FOR

**A slot machine pointed at the Internet Archive.**

Every other source in the rack asks you to supply the material: videobox takes your
file, cameraInput takes your camera, picturebox takes your image. archivist asks you
for a *description* — a media type, a search term, optionally a decade — and then
**picks something for you at random** out of everything archive.org has that
matches. `pickRandomDoc(lastDocs)` (`ArchivistCard.svelte:303`) over a 50-row
random-sorted page (`:270`, `{ rows: 50, random: true }`), with `↻ next` re-rolling
from the same page without re-fetching (`:290-293`).

⚠ **It is NOT a browser, and this is the single fact that separates it from its
sibling.** There is no result list on screen anywhere: `lastDocs` is card-local
`$state` (`:127`) that the player never sees. **You get one item, and a button that
gets you a different one.** The design idea is *serendipity* — you are not choosing
a 1954 civil-defence film, you are choosing to be shown a 1954 civil-defence film.

The def's own docs say the same in operational terms (`archivist.ts:184`): *"Usage:
choose 'image' to feed clean stills into the video graph, or 'audio' to pull
found-sound stereo into the audio graph; use 'video' only for in-card
preview/scrubbing."*

**What that means for the face:** the module is a QUERY, a DICE ROLL, a PICTURE and
a TRANSPORT. Three of those four are gestures the card owns and the headless host
makes unreachable; the fourth is a picture the engine cannot always draw (§4). The
face is therefore mostly a rebuild, not a re-skin — which is the cameraInput shape,
and the estimate reflects it.

---

## 2. STOP 1 — is promoting this module a PARITY LOSS?

Functional parity is a hard requirement, not a trade. Every affordance
`ArchivistCard.svelte` offers, with where it goes.

| # | affordance | card site | where it goes on the face | lost? |
|---|---|---|---|---|
| 1 | media-type `<select>` (image/audio/video/any) | `:652-663` | body row 1 | no |
| 2 | search text field + Enter | `:664-673` | body row 1 (⚠ §0.4) | no |
| 3 | year-from `<input type=number>` | `:676-684` | body row 2 | no |
| 4 | year-to | `:687-694` | body row 2 | no |
| 5 | `Search` button | `:695-701` | body row 2 | no |
| 6 | `↻ next` (re-roll) | `:702-709` | body row 2 | no |
| 7 | the PREVIEW (video / img / audio-art) | `:714-741` | ⚠ **a blitted `<canvas>` — and it is BLANK for video items. §2.1** | ⚠ **see §2.1** |
| 8 | the empty-state hint | `:729-734` | body, painted INTO the canvas — §7 | no |
| 9 | the loading spinner + status | `:735-740` | body overlay, transient | no |
| 10 | the error line | `:743-745` | body, transient — §7 | no |
| 11 | `−10s` | `:750` | body transport | no |
| 12 | `Play`/`Pause` | `:751` | body transport | no |
| 13 | `+10s` | `:752` | body transport | no |
| 14 | `⤭` jump-to-random-position | `:753` | body transport | no |
| 15 | the `m:ss / m:ss` time readout | `:754` | ⛔ **REMOVED as text** — §7 | text yes, information no |
| 16 | the seek `<input type=range>` | `:756-767` | body transport — the position IS the control | no |
| 17 | the title link to archive.org/details | `:773` | body — §7 | no |
| 18 | `Internet Archive · {type}` | `:775` | ⛔ **REMOVED** — §7 | see §7 |
| 19 | `⚠ play-only (no clean output)` | `:777` | ⛔ **REMOVED as text; the FINDING survives as a lamp** — §7.2 | see §7.2 |
| 20 | corner-drag resize | `:784-790` | ⚠ **not carried** — §2.3 | see §2.3 |
| 21 | the PatchPanel jacks | `:647` | the shell's own rear/patch surface | no |

**Nineteen interactive affordances, all of them rebuilt in the body.** Two entries
need their own argument: #7 (§2.1) and #20 (§2.3). Nothing is *dropped*.

### 2.1 ⚠ THE HEADLINE: THE ENGINE HAS NO PICTURE TO BLIT FOR THE MODULE'S DEFAULT MEDIA TYPE

`CameraInputOutputBody.svelte:7-15` states the rule every faced DOM-source module
follows, and it is stated as an absolute:

> *"⚠ THE PICTURE IS BLITTED FROM THE ENGINE AND THE `<video>` IS NEVER ADOPTED …
> A DOM node has exactly one parent — so a body that adopted it here would STEAL it
> from the card, and the card is what owns … the stream. 'Port the card's preview'
> is the obvious move and it would silently kill the capture the moment the dock
> opened. `blitOutputForPreview` reads the module's own output texture instead,
> **which is what every other video face does anyway.**"*

**For archivist, the module's own output texture is the IDLE GRADIENT whenever the
loaded item is a VIDEO — which is the module's DEFAULT.** Three independent reads:

1. `ARCHIVIST_DATA_DEFAULTS.mediaType` is `'video'` (`archivist.ts:122-129`), and
   the card's local default matches (`ArchivistCard.svelte:124`).
2. `attachExternalSource(kind === 'video')` deliberately does **not** point the
   frame uploader at the element (`archivist.ts:453-467`):
   ```ts
   // NOTE: archive.org video is CORS-tainted, so the card attaches the
   // <video> for PLAYBACK + audio only — NOT for texturing. …
   // We do NOT uploader.attach() a tainted element (that would
   // throw a SecurityError on texImage2D).
   videoEl = null; // not textured
   mediaEl = vid;
   ```
3. Therefore in `surface.draw` (`:359-372`) `imageReady` is false and
   `uploader.uploadIfReady()` returns false, so `uHasInput` is `0.0` and
   `FRAG_SRC` (`:78-82`) paints `vec4(0.04, 0.05, 0.09 + vUv.y*0.06, 1.0)` — the
   near-black idle field.

⚠ **AND A SHIPPED GATE ALREADY SAYS SO IN ITS OWN WORDS**, which is why this is not
an inference: `dom-source-modules.test.ts:138-143` documents the
`uploader.attach(el)` retention seam as *"peertube, tv-librarian, videobox. **NOT
archivist** — see `codeOf()`: the only `uploader.attach()` in its body is a comment
saying it does not."* (`:167-165` adds that archivist's ONLY retention seam is
`mediaEl = <element>`, for the audio graph.)

**So `blitOutputForPreview(nodeId)` returns a picture for an IMAGE item, and the
idle field for a VIDEO item and for an AUDIO item.** Copying cameraInput's body
verbatim would ship a promoted archivist whose preview is dark for the media type it
defaults to — a functional-parity loss, which is never a thing to surface as an
owner choice.

#### 2.1.1 THE RESOLUTION — **ADOPT**, and the reason cameraInput's prohibition does not transfer

`nodeMedia.adopt` is safe to call from a second surface, and `node-media-registry.ts`
argues why in its own header (`:31-44`):

> *"WHY DOUBLE-MOUNT IS UNREPRESENTABLE HERE, not merely unlikely. … 1. There is
> EXACTLY ONE element per (nodeId, slot). `adopt` cannot mint a second … 2.
> Adoption is a TRANSFER and release is OWNER-CHECKED. `adopt` always succeeds and
> steals ownership; `release` compares the caller's host against the current owner
> and NO-OPS when they differ. So a stale mount's teardown can never detach the live
> one, and mount/unmount ORDER stops mattering."*

**cameraInput's prohibition is about a MediaStream, not about the registry.** Its
element carries a live `getUserMedia` track and a permission state machine that only
the card can run; moving the element does not break those, but cameraInput's author
reasoned conservatively about a surface whose ownership is genuinely singular.
**archivist's element carries a `src` URL and a `currentTime`.** The card sets
`.src`, calls `.play()` and reads `.currentTime` **through its retained reference
`mediaEl`, which is unaffected by which div the element is parented into.** There is
no stream to strand.

The concrete design, and the ordering that makes it correct:

* the BODY owns the three host divs and calls `nodeMedia.adopt(nodeId, 'video' |
  'audio' | 'image', host, …)` exactly as the card does today
  (`ArchivistCard.svelte:151-182`) — same slots, same `init`, same testids;
* the CARD keeps its own adopt call. The body mounts LATER (a dock pane is opened
  after the rack loads), so the body wins the transfer;
* on dock collapse the body's cleanup calls `lease.release()`, which parks the
  element off-screen. **Parked elements keep decoding** — `node-media-registry.ts:56-60`
  is explicit that parking is `left:-9999px` with real dimensions *precisely
  because* `display:none` would freeze decode. Playback continues; the picture is
  simply not on screen, which is what "the pane is closed" means.

⚠ **THE ONE RISK, NAMED:** if the card's adoption `$effect` re-runs while the body
holds the element, the card steals it back and the body goes blank **silently**. Its
dependencies are `videoHost`/`audioHost`/`imageHost` and `id`
(`ArchivistCard.svelte:151-156`), none of which change for a mounted headless host —
but "does not change today" is not "cannot change". **M2 in §13 is the measurement,
and the body must render a visible empty state rather than an empty div** so a lost
element is distinguishable from a loaded-nothing state.

⚠ **AND THE HONEST ALTERNATIVE IS NAMED TOO, because it is better and out of
scope:** if archive.org video were fetched through a CORS-normalising proxy the
texture would be clean, `uploader.attach()` would apply, and archivist would become
an ordinary blit-preview module identical to its sibling. That is a networking
change with legal and cost dimensions, it is **not** a face PR, and this spec does
not propose it. It is recorded so that a future proxy makes this section obsolete
rather than surprising.

### 2.2 ⚠ THE SEARCH PAGE LIVES IN CARD-LOCAL `$state`, WHICH NO CELL AND NO OTHER COMPONENT CAN READ

`ArchivistCard.svelte:127` — `let lastDocs = $state<ArchivistDoc[]>([]);`

It is **not** on `node.data` (`ArchivistData`, `archivist.ts:105-120`, carries
`searchTerm`, `mediaType`, `yearFrom`, `yearTo`, `item`, `isPlaying`, `width`,
`height` — and no docs array), and it is **not** on the engine handle
(`archivist.ts:469-476` reads `extras`, `hasImage`, `hasMediaElement`, `audioWired`,
`hasKeepAlive`).

This matters twice:

1. **It rules out every cell kind for `↻ next`, mechanically.** A `ShellSelectorCell`'s
   roster is `options: (node: ModuleNode | undefined) => SelectorOption<string>[]`
   (`shell-cells.ts:171`) — a pure function of the NODE. A `ShellActionCell` reaches
   the engine via `getActiveEngine()` (the route wave 5's `BINDERS.md §1.3`
   established, and the one three agents in a row have reinvented as a false
   blocker). **Neither route reaches a Svelte component's `$state`.** So this is not
   the `env` question again; it is a genuinely different one, and the answer is not
   a platform change — it is **put the search in the body**, where the state and the
   surface are the same component.
2. **It is why archivist needs NO shared registry and its sibling DOES.** archivist's
   only CV input is `play_trigger`, whose handler is `togglePlay()`
   (`ArchivistCard.svelte:496-503`) reading `isPlaying` off `node.data` — **no
   card-local dependency.** peertube's `next_trigger` handler reads the card's
   `results` array, and that difference produces a promotion-created defect on the
   sibling and none here. See `../peertube/spec.md §2.2` — it is the cohort's most
   important divergence and it is not visible from either module alone.

**So `lastDocs` simply MOVES into the body, and the card stops owning search
entirely.** The card retains exactly three jobs: hold the three media elements,
run the `play_trigger` gate loop (`:542-552`), and pump `playhead`/`playing` on its
100 ms display timer (`:559-570`). That is a real simplification, not a
displacement.

### 2.3 ⚠ THE CORNER RESIZE IS NOT CARRIED, AND THAT IS A DELETION WITH AN ARGUMENT

`ArchivistCard.svelte:784-790` + `:609-626` give the card a corner-drag resize
persisting `node.data.width/height` (`rack-sizing.test.ts:54-66` records archivist as
a deliberate member of the *"user-resizable family"*, and `rack-sizes.ts:58` records
that such modules are *"intentionally ABSENT"* from the fixed-size map).

**A faceplate has no equivalent.** The dock pane is sized by
`DockFullView.svelte`'s own layout (`max-height: min(60vh, 680px)`), the plate is
`width: max-content`, and there is no per-face size on `node.data` that any shell
surface reads. `ruttetra`'s body carries a resize grip
(`face-rack-status-source.test.ts:214`), so a *body-local* grip is precedented — but
it resizes the body's canvas, not the module, and it would leave
`node.data.width/height` written by a surface that no longer uses them.

**Disposition: the LANE tile and the DOCK pane are both shell-sized, and the
affordance has no subject after promotion.** This is not "we would lose X" offered
as a choice: the thing being resized (a card box) ceases to exist. `width`/`height`
stay on `node.data` untouched, so `?shell=legacy` keeps working and a
de-promotion would restore the behaviour exactly.

⚠ **The measurement that would change this answer** is whether a player wants the
body's PREVIEW bigger. If so, the ruttetra grip is the shape, it is body-local, and
it should use a **different** `node.data` key so the two are never confused. Not
proposed here; recorded so it is a decision rather than an oversight.

---

## 3. STOP 2 — does every way of getting DATA IN survive?

| entry point | today | after |
|---|---|---|
| typed search term | card `<input>` `:664` | body `<input>`, same `writeSearchInputs` |
| media type | card `<select>` `:652` | body `<select>`, same writer |
| year range | card `<input type=number>` ×2 | body, same writer |
| `Search` / `↻ next` | card buttons `:695`, `:702` | body buttons; `lastDocs` moves with them (§2.2) |
| transport (play/skip/seek/random) | card buttons + range `:750-767` | body, same handlers |
| `play_trigger` via CV | `cv_play_trigger` + the 33 ms gate loop `:542-552` | ⚠ **unchanged, and it stays ON THE CARD** — §3.1 |
| `gain` via CV | **none** — no input declares `paramTarget: 'gain'` | ⚠ still none after wiring; §11 D4 |
| remote peer edit | Y.Doc → `$derived` reads of `node.data` | ⚠ **BROKEN TODAY. §11 D1** |
| a reloaded patch | `onMount` `:577`, `if (item) void attachMedia(item)` | unchanged (the card still mounts) |

### 3.1 THE GATE LOOP STAYS ON THE CARD — deliberately, and the wave-5 §6 grep is why it was checked

Wave 5's `README §6` records that the STOP-2 grep
(`'<button|<select|<input|oncontextmenu|manualTrigger|Toggle|Selector|accept='`) is
*"structurally blind to a component-lifecycle side effect the card performs on the
user's behalf"*, and instructs: **grep for `$effect(` and `onMount(` as well.**
Done — `ArchivistCard.svelte` has three `$effect`s (`:151`, `:186`, `:531`) and two
`onMount`s (`:193`, `:573`):

| lifecycle site | what it does | survives promotion? |
|---|---|---|
| `$effect :151-182` | adopts the three node-owned elements; binds `ended` | ✅ card stays mounted in the headless host |
| `$effect :186-191` | toggles `.hidden` on the video/img per item type; sets `alt` | ✅ same |
| `$effect :531-537` | syncs the shared `isPlaying` to the local element | ✅ same |
| `onMount :193-201` | hydrates local inputs from `node.data` | ⚠ **moves to the body** — the inputs are the body's now |
| `onMount :573-578` | starts the gate loop + the 100 ms display timer; re-attaches a saved item | ✅ **stays on the card, and must** — it is the module's engine pump |

**The `startGateLoop`/`refreshDisplay` pair must NOT move into the body**, and the
reason is the one wave 5 gives for `midiOutBuddy`: *"a body is **dock-only**, so
correctness would then depend on a dock being open."* `playhead` and `playing` are
declared OUTPUT ports; a rack whose CV stops when a pane is collapsed is a worse
module than one whose preview stops.

**So promotion creates no lifecycle defect on archivist.** ⚠ The sibling is not so
lucky (`../peertube/spec.md §2.2`).

---

## 4. THE LANE PICTURE — **ACCEPTED, FREE, AND BLANK FOR THE DEFAULT MEDIA TYPE**

`hasVideoSurface(def)` is `def?.domain === 'video'` and nothing else, and
`laneGlyphFor` (`module-shell-model.ts:237-240`) returns `'picture'` on that alone:

```ts
export function laneGlyphFor(def: LaneGlyphDefLike | undefined): LaneGlyph {
  if (hasVideoSurface(def)) return 'picture';
  return (def?.face?.glyph ?? 'none') !== 'none' ? 'trace' : 'none';
}
```

`ModuleShell.svelte:1348` then renders `<VideoTileThumb nodeId={id} />` at
`VIDEO_THUMB_W = 160` × 120, throttled to `VIDEO_THUMB_FPS = 15`
(`module-shell-model.ts:250-252`). archivist is `domain: 'video'`
(`archivist.ts:158`), so the picture is per-node, live, and free.

**ACCEPT — but the spec must say what it will show, because the wave-5 README's
§5 warning is that the lane-picture question is answered by mechanism and the
mechanism is not the whole story:**

| loaded item | lane tile shows |
|---|---|
| **image** | the image. `imageTex` is uploaded (`archivist.ts:325-345`) and sampled (`:361-363`) |
| **audio** | the idle field. There is no texture path for audio at all |
| **video** | ⚠ **the idle field** — §2.1 |
| nothing | the idle field |

⚠ **So on a default-configured archivist the lane picture is a near-black gradient
until the player switches the type to `image`.** That is not a reason to refuse it
(a blank picture is still the honest picture of an idle source, and `videobox`
before a file load is the same), but a spec that wrote "the lane shows the loaded
media" would be wrong for three of the four states. The compact tile is
picture + up to `LANE_ROW_MAX_CELLS_WITH_GLYPH = 2` cells
(`module-shell-model.ts:366`), and this face has exactly ONE ranked cell, so nothing
is evicted.

### 4.1 ⚠ `glyph: 'none'` IS CORRECT — AND THE REASON EVERY OTHER VIDEO DEF GIVES IS FALSE HERE

Three faced video defs carry the same copied comment. `picturebox.ts:309` and
`strict-faces.ts:835-837`:

> *"⚠ `glyph: 'none'` IS REQUIRED AND COUNTER-INTUITIVE. **A video def has no
> `audio` output**, so `primaryAudioOutPortId` returns null and any other glyph
> resolves to `{kind:'static'}` and reddens the dead-glyph clause."*

**The premise is false for archivist.** `primaryAudioOutPortId` is
`def?.outputs?.find((o) => o.type === 'audio')?.id ?? null`
(`shell-glyph-live.ts:111-113`), and `archivist.ts:167-169` declares:

```ts
{ id: 'audio_l',  type: 'audio' },
{ id: 'audio_r',  type: 'audio' },
```

So it returns `'audio_l'`, `glyphBinding`'s *"any glyph + a primary AUDIO output →
live-audio"* rule (`:123`) fires, the binding is **not** `{kind:'static'}`, and the
dead-glyph clause would **not** redden a `glyph: 'meter'` declaration.

⚠ **It is not a one-off.** `grep -l "type: 'audio'"` over `video/modules/` returns
`archivist`, `peertube`, `videocube`, `milkdrop`, `graphicEq`, `nibbles`, `blood`,
`doom`, `mandelbulb` and more — and `videocube.ts:1361`, `milkdrop.ts:325` and
`scoreboard.ts:210` all declare `glyph: 'none'`. **They reached the right answer;
the sentence in their file explaining why is a general claim that is false of
several of them.**

**The real reason `'none'` is correct is stronger and applies to every video def
without exception:** `laneGlyphFor` returns `'picture'` for a video domain
*before it ever looks at `face.glyph`*, and `ModuleShell.svelte:320-322` derives
`hasGlyph` from `laneGlyph` alone. So on a video def a non-`'none'` glyph is
**authored and painted nowhere in the lane** — a declaration that would pass its
gate and render at no tier. That is the "declared but dead" shape, and it is the
argument this spec uses.

**Recommended, and it rides this PR because the PR touches nothing else there:**
correct the sentence at `strict-faces.ts:835-837` to say *"`laneGlyphFor` returns
`'picture'` for a video def before consulting `face.glyph`, so any other value is
authored and never painted"*, and note that the audio-output half is true of most
video defs and **not** of the sources. It is a comment, so it is hash-transparent
(`scripts/attest-code-basis.ts`) and free.

---

## 5. THE FACE

### 5.1 RANK — `face.order`

```ts
face: {
  glyph: 'none',                 // §4.1
  order: ['gain'],
  paramCells: { gain: 'fader' },
  extension: 'archivist',
},
noUserControl: [
  { param: 'cv_play_trigger', writer: 'cv-port',
    why: 'the play_trigger jack writes this synthetic level through the CV bridge and the card edge-detects a rising crossing of 0.5 to toggle transport; it is a raw gate cache, never a value a player sets.' },
],
```

**One ranked key.** That is the honest shape: after `cv_play_trigger` is declared,
the module has exactly one player-facing param, and CLAUDE.md's compact-is-the-default
ruling means a face with one control should look like a face with one control.

⚠ **`face.order: ['gain']` is only defensible if §0.1.1 lands in the same PR.**
Ranking a param nothing consumes is the thing this repo calls a green gate over a
live bug. **If the owner refuses the shader edit, the face is BLOCKED, not
downgraded** — there is no honest third option, because `noUserControl` would assert
that something else writes a param nothing writes.

⚠ `paramCells: { gain: 'fader' }` is a decision, not decoration. `gain` is a linear
`0..2` brightness multiply whose meaningful landmark is unity at the middle of the
throw — a dial puts unity at 12 o'clock where a fader puts it at the midpoint of a
travel you can see. `picturebox` chose `'fader'` for the byte-identical param
(`picturebox.ts` face), and `'fader'` is a legal `AuthoredParamCell`
(`shell-control-kind.ts`).

### 5.2 BANDS — one, and no tab rail

One ranked control is one band. `DOCK_TAB_MIN_BANDS = 7` (`dock-tabs-model.ts:101`),
and the rail is applied only at or above it unless `face.tabbed` is declared.

**No rail, and none is manufactured.** ⚠ `face.tabbed` is
OWNER-INSTRUCTION-ONLY (`module-faceplates.md`, the ⛔ section) with `spirographs`
as its single adopter. The tempting move here — "a QUERY page and a PLAYER page" —
would be **two pages, not seven bands**, so it would not reach the rail anyway; and
splitting a query from the results it produces is the wrong split, because you read
them together. **One column, in the body, in the order you use them.**

### 5.3 WIDTH — **EARNED BY THE PICTURE, and the gate measures SLACK not SIZE**

`face-width-source.test.ts` denies a `max-width` on `.faceplate-body`, denies any
per-occupant `:has(...)` override outright, and its `PLATE_FLOOR_EXEMPTIONS` list is
**empty** (`:88`). The result-side gate is
`workflow-shell-faces.spec.ts:440-452`:

```ts
const slack = g.bodyW - g.contentW;
expect(widthWhy ? -1 : slack, `face-${type}-dock: ${slack} CSS px of EMPTY PLATE …`)
  .toBeLessThanOrEqual(FACE_WIDTH_SLACK_MAX_PX);
```

⚠ **`FACE_WIDTH_EXEMPTIONS` currently has exactly ONE key — `moog912`**
(`workflow-shell-faces.spec.ts:264`, verified by enumerating the record's keys).
**`cameraInput` and `loopback` are not in it**, and their bodies are 480 px wide.
That is the measurement that settles this: **a body whose widest element is a
picture has near-zero slack by construction, because the picture IS the content.**

The proposed geometry, sized off the shipped precedent
(`CameraInputOutputBody.svelte:262-266`, `canvas width={480} height={360}`;
`:400-406`, `.picker-row { max-width: 480px }`):

| body row | asks for |
|---|---|
| the preview `<canvas>` | **480** (4:3; the engine is `VIDEO_RES` 1024×768, so 4:3 is the source aspect and letterboxing is nil) |
| query row — `[type ▾ 66] [search ⇢flex]` | fills 480, min ~200 |
| bounds row — `[from 56] – [to 56] [SEARCH 62] [↻ NEXT 62]` | ~250 |
| transport — `[−10] [PLAY] [+10] [⤭]` | ~190 |
| seek slider | fills 480 |
| the title link | fills 480, ellipsised |

**The picture is the only thing asking for 480; every other row asks for less and
stretches.** So `contentW ≈ bodyW` and no `FACE_WIDTH_EXEMPTIONS` entry is needed.
⚠ **If a build lands one, that is the signal something else got wide** — the
exemption is not the fix.

**A live picture is a named legitimate earner in the owner ruling** (*"A genuine
earner is a live picture, a scope trace, a video preview, an XY pad…"*), and
archivist's is a video preview by definition. ⚠ **The RESULT-LIST width claim,
which the wave brief flags as a second and separate argument, DOES NOT ARISE HERE**
— archivist has no result list (§1). It arises on the sibling, and
`../peertube/spec.md §5.3` makes it there.

### 5.4 CONTROL INVENTORY — every primitive decision, argued

| face element | primitive | why not the alternative |
|---|---|---|
| GAIN | ranked param cell, `'fader'` | a knob hides unity-at-midpoint (§5.1) |
| the picture (lane) | `VideoTileThumb` via `hasVideoSurface` | automatic; nothing to author (§4) |
| the picture (dock) | the body's own `<canvas>` | the dock hero glyph is capped at `DOCK_HERO_GLYPH_W` (`module-shell-model.ts:635`) and is *"a picture, not a surface"*; the body owns this region |
| SCREEN ON/OFF | body button, overlaid bottom-right | §6.4 — required by the fleet ruling and by `video-face-screen-source.test.ts` |
| media type | body `<select>` | a `ShellSelectorCell` is a genuine candidate and §6.1 argues it down |
| search term / years | body `<input>` | no cell paints text (§0.4) |
| SEARCH / ↻ NEXT | body `<button>` | a `ShellActionCell` needs a probe and would have to reach `lastDocs` (§2.2, §6.1) |
| transport | body buttons + range | same; and a transport split from the picture it drives is unusable |

---

## 6. THE BODY — `face.extension: 'archivist'`, slot `fullViewBody`

### 6.1 WHY NOT A CELL — the ladder, walked down, with the refusal for each rung

`module-faceplates.md` requires reaching for the earlier rungs first. All four are
refused, and each for a **different mechanical reason** — which is the test of
whether these are arguments rather than a foregone conclusion.

| rung | candidate | refusal |
|---|---|---|
| **1a. `selector`** | media type (4 fixed options — genuinely roster-shaped!) | ⚠ **The only one that ALMOST works.** `mediaType` really is a fixed four-value roster and it really is on `node.data`, so `options`/`value` are expressible as pure functions of the node. It is refused for a LAYOUT reason rather than a capability one: the type filter is one of four inputs to a single query, and putting it in a dock BAND while the other three are in the body splits one gesture across two surfaces. ⚠ **It would also cost a `controlFamilies` entry, which IS in the contract** (`contract-lock` moves; `module-faceplates.md`, "`face` is now FULLY contract-transparent — but `controlFamilies` is NOT"), and `STRICT_DOCS` completeness would then demand a `docs.controls` entry for the family |
| **1b. `file`** | — | `ShellFileCell` (`shell-cells.ts:305-311`) takes `accept` + `onFile`. archivist loads nothing from disk |
| **1c. `action`** | SEARCH / ↻ NEXT | `ShellActionCell.probe` is REQUIRED (`shell-cells.ts:157`). A press must reach `lastDocs`, which is a Svelte component's `$state` (§2.2) — unreachable from `getActiveEngine()` and unreachable from `node`. ⚠ This is **not** wave 4's `env` question: the capability that would fix it does not exist because the state is in the wrong place, and the fix is to move the state, not to widen a type |
| **1d. `toggle`** | — | `ShellToggleCell` is a 0/1 latch on `node.data`. Nothing here is one |
| **2. `panel`** | the preview + transport | `ShellPanelProbe` REQUIRES a testid inside the panel to click or drag, and *"prefer `data` over `data-rev`"* (`shell-cells.ts:225-240`). A panel would also have to be a **ranked key in `face.order`**, making the picture compete with `gain` for band space when it is not a control. And `shell-cells.ts:331-336`'s rule 1 forbids `control-<paramId>` testids inside it |
| **3. `fullViewBody`** | everything | **wired** (`WIRED_SHELL_EXTENSION_SLOTS = ['glyph','fullViewBody']`, `shell-extensions.ts:124`), takes `nodeId`, needs no probe, and — the load-bearing half — *"The bands BELOW are untouched: every param still gets its cell, so face completeness, the dock render-plan parity gate and `faces-parity` all still apply"* |

**NEVER `editorSurface`.** It is declared and unwired (`shell-extensions.ts:118`),
and its own note says the first adopter must wire the render site in `ModuleShell`
**in the same diff**. archivist has no business being the module that wires a
platform slot.

### 6.2 THE PRECURSOR THIS MODULE DOES **NOT** NEED — and why that is worth stating

cameraInput built `$lib/ui/media/camera-status-registry.ts` and loopback built
`loopback-status-registry.ts`, both swept from `Canvas.svelte`'s node sweep. Their
reason (`camera-status-registry.ts:22-28`) is that the body must show *"the real
capture STATE"* — a permission machine the graph cannot express — and must
**invoke** a gesture the card owns.

**archivist needs neither half, and both halves were checked rather than assumed:**

* **No status to publish.** Every state the body must show is already on
  `node.data` or on the engine handle: `item` (`ArchivistData.item`), `isPlaying`,
  the search inputs, and — for the CORS lamp (§7.2) — `item.cleanOutput`, which
  `hasCleanOutput(concrete)` writes at load time (`ArchivistCard.svelte:341`).
  `archivist.ts:469-476` additionally exposes `hasImage`, `hasMediaElement`,
  `audioWired`, `hasKeepAlive`, reachable with `getActiveEngine()`.
* **No command to deliver.** Every gesture the body offers acts on the element it
  now holds (§2.1.1) or writes `node.data`, which the card already reads.

⚠ **THE ONE EXCEPTION, AND IT IS A CARD BUG RATHER THAN A SEAM GAP:** for a
body-written `node.data.item` to actually load, the card must re-attach — and today
it does not (§11 D1). That is fixed with **one `$effect` on the card**, mirroring
the one `PeerTubeCard.svelte:482-491` already has. It is not a registry.

**So archivist is CHEAPER than cameraInput at exactly the point where the cohort
looked identical.** Recorded because "it is a card-owned media source, therefore it
needs a status registry" is the plausible-and-wrong inference this section exists to
block.

### 6.3 THE COMPONENT

`packages/web/src/lib/ui/modules/archivist/ArchivistBrowserBody.svelte`, registered
through `packages/web/src/lib/ui/modules/archivist/shell-extension.ts`.

Top to bottom (the mock is [`dock.html`](dock.html) / [`dock-loaded.html`](dock-loaded.html)):

1. **the PREVIEW**, a `<div class="preview-wrap">` holding
   * the three adopted media hosts (§2.1.1), and
   * a `<canvas>` that blits `blitOutputForPreview(nodeId)` **when the loaded item
     is an IMAGE or there is no item** — so the empty state and the image state come
     from the engine like every other video face, and only the two element-backed
     states use the DOM.
   ⚠ **Both paths must exist**: an `<img>` shows the picture, but the ENGINE
   texture is what downstream nodes see, and a preview that never reads it cannot
   show a `gain` change. Once §0.1.1 lands, `gain` is a real control and the image
   preview must be the blit, not the `<img>`.
   * the **SCREEN ON/OFF** button, OVERLAID bottom-right on a translucent backplate
     (§6.4).
2. **the QUERY block** — row 1 `[media type ▾][search…]`, row 2
   `[from][–][to][SEARCH][↻ NEXT]`. Same handlers, same `writeSearchInputs`.
3. **the TRANSPORT**, rendered only for time-media (`item.type === 'audio' |
   'video'`) exactly as the card gates it (`:748`): `[−10s][PLAY/PAUSE][+10s][⤭]`
   then the seek range.
4. **the ATTRIBUTION line** — the title, as a link to
   `buildDetailsUrl(item.identifier)`, plus the CORS lamp (§7.2). ⚠ **Not the
   `Internet Archive · {type}` line** (§7).
5. **transient rows** — the loading overlay and the error line, both absent at rest.

⚠ **Do not re-implement the writers.** `writeItem` / `writeSearchInputs` /
`writePlaying` / `updateDuration` (`ArchivistCard.svelte:216-245`, `:430-446`) move
into **`$lib/graph/archivist-data.ts`** and both surfaces call the extraction —
the `matrixmix.ts` `mutateMatrix` shape, and the thing that keeps §0.3's correct
tagging correct in two places instead of one. The same file is where the resize fix
(§0.3) lands.

⚠ **Do not re-implement `attachMedia`, `waitForMeta`, `loadItem` or
`loadRandomFromDocs` either.** They are 120 lines of load-failure handling
(`:295-486`) that took a real bug to write (*"the card always lands on a playable
item instead of hanging on 'Loading'"* — `archivist.ts:25-31`). They move to
`$lib/ui/modules/archivist/archivist-load.ts` as plain functions taking
`(nodeId, elements, engine)`, called from the body.

### 6.4 SCREEN ON/OFF — required, and the WATCH-MARK question answers itself

The fleet ruling (owner, 2026-08-18) is not optional and
`video-face-screen-source.test.ts` is deny-by-default over `STRICT_FACES ∩ video
defs` with a per-module `why` exemption; its `NO_SCREEN_SWITCH` list has exactly one
entry (`videoOut`, *"videoOut IS the screen"*). **archivist gets the switch.**

Mechanics, copied verbatim from the precedent rather than re-derived:

* state lives on **`node.data.previewCollapsed`** — the shared key, so a rack saved
  before promotion does not silently re-open, and so it survives a dock collapse /
  LRU eviction (the #1531 / #1574 / #1583 class);
* the button **OVERLAYS the preview's bottom-right corner** on a
  `rgba(5,6,8,0.72)` backplate, with a `min-height: 18px` on the wrap so the button
  does not escape when the canvas is gone
  (`CameraInputOutputBody.svelte:369-398`). ⚠ **A stacked row is the named
  anti-pattern** — it cost ~18.8 px on a card with ~11 px of slack and
  `io-spec-consistency` caught the overhang;
* OFF skips the **PAINT**, never the engine read.

#### 6.4.1 ⚠ THE WATCH MARK IS A NON-QUESTION HERE, **BY DERIVATION**

Every recent `EXTENSION_BODY_ROLES` entry argues #2015 at length, because a body
that stops calling `blitOutputForPreview` also stops calling `markWatched` and the
node drops out of the pull set. **archivist cannot drop out of the pull set at all:**

```ts
// engine.ts:1170-1177
private isPullExempt(nodeId: string, handle: VideoNodeHandle): boolean {
  if (handle.audioSources && handle.audioSources.size > 0) return true;
  …
}
```

`archivist.ts:247-270` unconditionally populates `audioSources` with six entries
(`audio_l`, `audio_r`, `loaded`, `ended`, `playing`, `playhead`) whenever
`ctx.audioCtx` exists. **So `isPullExempt` is TRUE structurally**, for every
archivist node, from construction. The engine's own comment names the class:
*"the video players' soundtracks"*.

**Nevertheless the body should still call `markWatched(nodeId)` in the collapsed
branch, exactly as cameraInput does** (`CameraInputOutputBody.svelte:216-220`) —
not because it is needed, but because the exemption is derived from a handle shape
that a future refactor could change, and a body that depends on that derivation
without saying so is one edit from a silent regression. **Write the call, and write
the comment saying it is belt-and-braces on a structurally-exempt node.**

### 6.5 ⚠ `EXTENSION_BODY_ROLES` — `picture`, AND THE PREDICATE IS A DESIGN CONSTRAINT

`face-rack-status-source.test.ts` is deny-by-default over every `fullViewBody` in
the tree, derived off the DIRECTORY (`:100-115`), with a **mechanical predicate** per
role (`:473-491`):

```ts
picture:            holds: (src, extId) => paintsCanvas(src, extId)
'status-primitive': holds: (src, extId) => /StatusLed/.test(src) && !paintsCanvas(src, extId)
```

⚠ **CORRECTION TO THIS WAVE'S BRIEF, MEASURED.** The brief states the existing roles
are `picture`, `status-primitive` and `control-grid` (*"added by #2184"*). **On
`ea2e06340` there are TWO.** `face-rack-status-source.test.ts:142` is
`type BodyRole = 'picture' | 'status-primitive';`, `ROLE_PREDICATE` (`:473`) has two
keys, and `:695` asserts the population in both directions:

```ts
expect([...roles].sort()).toEqual(['picture', 'status-primitive']);
```

`git log --grep=2184` returns nothing on this tree. **So `control-grid` does not
exist, and a build agent who reached for it would find a type error.** Two
consequences follow and both matter:

1. **archivist declares `picture`.** Its body mounts a `<canvas>` (§6.3) for the
   blit path, so the predicate holds. ⚠ **This makes the canvas load-bearing on the
   GATE as well as on the design**: a build that dropped the blit and used only the
   adopted `<img>`/`<video>` would satisfy no role and the entry would go red. That
   is a good outcome — it forces the engine-truth preview §6.3 argues for — but it
   must be understood as a constraint rather than discovered as a failure.
2. **Adding a THIRD role is not a one-line change.** It means editing the `BodyRole`
   union, `ROLE_PREDICATE`, *and* the hand-enumerated assertion at `:695`, which is
   a literal list of the role population. **Neither of this cohort's two modules
   needs a new role**, so neither should propose one — but a wave that concluded
   otherwise should know the assertion is there.

**The `why` string to commit, verbatim:**

> `archivist: { role: 'picture', why: "the archive.org source's live preview — the engine's own output texture when the loaded item is an IMAGE or nothing is loaded, and the node-owned <video>/<audio> element ADOPTED into this body when it is not. ⚠ THE ADOPTION IS THE ONLY BODY IN THE ROSTER THAT DOES IT, and it is forced rather than chosen: archive.org video lacks CORS on the served file, so archivist.ts:453-467 deliberately never calls uploader.attach() and the module's own texture is the idle gradient for a VIDEO item — the media type this module DEFAULTS to. cameraInput's 'never adopt' rule protects a MediaStream with one owner; here the element carries only a src and a currentTime, the card keeps its reference, and node-media-registry's adoption is an owner-checked TRANSFER that cannot double-mount. ⚠ TEXT ON THIS SURFACE, exhaustively: the item's TITLE as an attribution link (a NAME, not a measurement — the cameraInput device-name precedent), the control captions on its buttons, the literal placeholder SEARCH THE INTERNET ARCHIVE painted into the empty canvas (the samsloop/twotracks NO SAMPLE LOADED shape — a placeholder naming the surface's own condition), and a transient ERROR that is absent whenever nothing is wrong. ⚠ NOT on it: the m:ss/m:ss time readout and the 'Internet Archive · <type>' source line the card painted, both deleted rather than hidden — the position lives in the seek control's aria-valuetext and the CORS limitation in a StatusLed's aria-label. ⚠ NO WATCH-MARK ARGUMENT IS NEEDED: archivist populates six audioSources at construction, so engine.ts isPullExempt is structurally TRUE and the node never leaves the pull set; the body marks anyway, as belt-and-braces on a derivation it does not control." }`

⚠ It clears the `why.length > 40` floor by a wide margin, which the gate checks
(`:686-691`), and it names the canvas so the predicate's satisfaction is not
accidental.

---

## 7. RESTING TEXT — the exhaustive disposition, and the ONE call this wave has to make

`face-resting-text-source.test.ts` denies the SHAPE, enumerating the permitted
ROLES: the module NAME, TAB/SECTION labels, CONTROL CAPTIONS, and OPTION/LANDMARK
NAMES that disambiguate a control's own position. ⚠ **It states its own blind spot:
text inside a `fullViewBody` is module-owned markup and invisible to it.** So this
section is enforced by the dock VRT baseline, a human reviewing it, and the
`archivist-face-model.test.ts` source assertions in §14 — **and by nothing else.**
That is written down rather than implied, because a spec that leaned on the
resting-text gate here would be leaning on a gate that structurally cannot check it.

| # | card text | site | verdict | replacement |
|---|---|---|---|---|
| 1 | the item TITLE (attribution link) | `:773` | ✅ **KEPT** — §7.1 | — |
| 2 | `Internet Archive · {item.type}` | `:775` | ⛔ **REMOVED.** The host is a constant (this module has exactly one) and the type is a state word restating the media-type control | the type is already the selector's own option name, three rows up |
| 3 | `⚠ play-only (no clean output)` | `:777` | ⛔ **REMOVED as text** — §7.2 | a `StatusLed`, with the sentence on `aria-label`/`title` |
| 4 | `{formatTime(displayPos)} / {formatTime(durationSec)}` | `:754` | ⛔ **REMOVED.** A timecode is the canonical forbidden shape — a labelled derived value at rest beside the control it describes, i.e. the deleted hero readout strip (#1957) | `aria-valuetext` on the seek control: `"3:41 of 12:08"` |
| 5 | `Search the Internet Archive` / `pick a type + term, press Enter` | `:730-733` | ✅ **KEPT, painted INTO the canvas** — §7.3 | — |
| 6 | the audio-art `♪` + `{item.title}` | `:723-726` | ⚠ **SPLIT**: the `♪` is a glyph and stays; the title inside the art is a SECOND copy of #1 and goes | one title, in the attribution row |
| 7 | `Searching archive.org…` / `Loading "{title}"…` | `:738` | ✅ **KEPT** — transient, absent at rest, feedback on a gesture | — |
| 8 | `Search failed: …` / `No results — …` / `Could not find a playable item …` | `:744` | ✅ **KEPT** — an ERROR with recovery instructions is the exception `CameraInputOutputBody.svelte:292-298` already names, and it is absent whenever nothing is wrong | — |
| 9 | option labels `image / audio / video / any` | `:659-662` | ✅ **KEPT** — option names, the permitted role verbatim | — |
| 10 | placeholders `search archive.org…`, `from yr`, `to yr` | `:667`, `:679`, `:690` | ✅ **KEPT** — a placeholder is a control caption in the `<input>` idiom | — |
| 11 | button captions `Search`, `↻ next`, `−10s`, `Play`, `+10s`, `⤭` | `:695-753` | ✅ **KEPT** — control captions | — |

### 7.1 ⚠ THE ITEM TITLE — the wave's judgement call, made, argued, and escalated anyway

**The question the brief asks:** is a search result's TITLE an "option/landmark NAME
that disambiguates a control's own position", or a "derived value"?

**Both readings, written out:**

> **(A) It is a NAME.** The permitted role exists so a reader can tell WHICH of a
> control's states it is in. archivist's item selector has one state per archive.org
> item; `Duck and Cover (1951)` is the only thing distinguishing this state from the
> ten thousand others. Suppressing it leaves a source module that will not tell you
> what it is playing — which is not minimalism, it is amnesia.
>
> **(B) It is a VALUE.** The four permitted roles are all things the FACE authors:
> the module's name, the pages the def declares, the captions on `ParamDef.label`,
> and rosters written on the def. A title is **content a third party returned over
> the network** and nothing in the app authored it. Under this reading a title is a
> `state word` with a longer tail, and the ruling's own list — *"a value, a
> measurement, a state word or a sentence"* — closes on it.

**THIS SPEC RULES (A), and the ground is a SHIPPED, ROSTER-REVIEWED PRECEDENT rather
than a preference.** `face-rack-status-source.test.ts:381`, the `cameraInput` entry,
says of that body's resting text:

> *"Its resting TEXT is the device NAME (**a name, not a measurement — the cvBuddy
> precedent**) plus an ERROR that is absent whenever nothing is wrong."*

A camera's label — `FaceTime HD Camera (05ac:8514)` — is **also** runtime-enumerated
content the app did not author, arriving from outside the process, different on
every machine. It shipped, it is on the deny-by-default roster, and the roster
records the classification explicitly. **A search-result title is the same shape as
a device name: it identifies which of an externally-supplied set the source is
pointed at.**

⚠ **AND THE DISTINCTION IS NOT A LOOPHOLE, BECAUSE IT CUTS.** Under ruling (A) the
things it *refuses* on this very surface are the ones the card also paints: the
DURATION (a measurement), the media TYPE (a state word), the elapsed time (a
measurement), the CORS state (a state word), a result COUNT (a count). **Six of the
card's eleven text elements go and five stay.** A rule that permitted everything
would not have that ratio.

⚠ **ESCALATED ANYWAY, as ONE line for the owner, because it is the first time the
roster is fetched from an ARBITRARY REMOTE rather than from the OS:**

> **OWNER DECISION 1 — is a network-fetched item TITLE permitted resting text on a
> faceplate, as a NAME (the shipped cameraInput device-name precedent), or refused
> as third-party content the app did not author?** It applies identically to
> `archivist` and `peertube` and to nothing else in the fleet. **If refused,
> neither face is blocked** — the title moves to `aria-label` on the attribution
> link and the surface loses no gesture; peertube's result list becomes an
> unreadable row of thumbnails, which is the cost, and `../peertube/spec.md §7.1`
> prices it.

### 7.2 ⚠ DELETING THE CORS WARNING DELETES A FINDING — here is which one, and where it goes

CLAUDE.md: *"**Deleting a readout deletes a FINDING** … say which finding lost its
surface rather than letting the coverage quietly lapse."*

`ArchivistCard.svelte:777` is the only place in the product where a player learns
**that a loaded VIDEO item cannot drive anything downstream**. The def's docs say it
(`archivist.ts:184`, at length) and `DESCRIPTIONS.archivist`
(`module-manifest.ts:160`) says it, but those are the docs site. On the card it is
one amber phrase next to the picture, and it is the difference between "my patch is
broken" and "this item is play-only".

**It survives as a `StatusLed`, which is the positive form the brief names**
(`$lib/ui/controls/StatusLed.svelte`, gated by `status-led-source.test.ts`): a
STATIC LITERAL caption, a boolean lamp that IS the picture, `detail` reaching
`aria-label`/`title` and never a text node. The shape here:

| lamp | condition | `aria-label` |
|---|---|---|
| **lit / good** | `item.cleanOutput === true` (image or audio) | *"This item's texture and audio are CORS-clean: the image / audio_l / audio_r outputs carry real signal downstream."* |
| **amber** | `item.cleanOutput === false` (video) | *"Play-only. archive.org serves video without CORS on the final hop, so the texture is tainted: this item plays and scrubs in the preview, and the `video` output stays the idle pattern."* |
| **dim** | no item | *"Nothing loaded."* |

The caption beside it is the literal string `OUT`, which is a control-caption-shaped
static and names what the lamp is about. ⚠ **Not `CLEAN` / `PLAY-ONLY` as a
changing caption** — that is the readout wearing a shorter label, and *"there but
hidden"* was refused by name.

⚠ **`data-clean-output` on the card root (`:639`) is what three e2e assertions read**
(`archivist.spec.ts:116`, `:140`, `:161`). It is an ATTRIBUTE, not painted text, and
the body must re-emit it — see §8.

### 7.3 IN-CANVAS TEXT — the ruling is already made and applies verbatim

Wave 5's `GAMES.md §1`: pixels a module renders into its OWN surface are ARTWORK;
a labelled value in a chrome row beside the surface is refused. `samsloop` paints the
literal `NO SAMPLE LOADED` and `twotracks` paints `NO TAPE`, both accepted on the
roster (`face-rack-status-source.test.ts:216`, `:221`) as *"a placeholder naming the
surface's own condition, not a measurement of any control"*, and `twotracks`'s entry
adds the reason it is drawn rather than left blank: *"'no tape yet' and 'the body
failed to mount' are different pictures, which matters because the fresh-spawn empty
state is what the dock baseline captures."*

**archivist's empty state is exactly that case**, and §9 shows why it matters more
here than anywhere: the fresh-spawn empty state is the ONLY state its baselines will
ever capture. So the body paints `SEARCH THE INTERNET ARCHIVE` into the canvas's
empty branch, as a literal, and nothing else.

⚠ **Nothing else goes into the canvas.** No title, no timecode, no progress. The
canvas is the engine's output when there is one and a placeholder when there is not.

---

## 8. THE E2E SURFACE — three specs, all `?shell=legacy`, all GREEN-AND-BLIND after promotion

`e2e/tests/archivist.spec.ts` (231 lines, three tests) boots
`/rack?shell=legacy&seed=none` (`:81`) and drives the LANE CARD by testid.

⚠ **Under `?shell=legacy` the lane renders the legacy card for a MIGRATED module
too**, so all three tests keep passing after promotion — while testing a surface
that, under the shipping default shell, is parked at `left:-9999px` with
`pointer-events: none`. That is wave 5's `README §4` class verbatim: *"the specs go
green while testing a surface the user no longer operates."*

**They must be re-pointed, not merely left green.** The testids and their
disposition:

| testid | card site | body |
|---|---|---|
| `archivist-card` | `:636` | ⚠ **do not re-emit.** Rename to `archivist-browser-body` — the name would stop being true |
| `archivist-type` | `:656` | re-emit |
| `archivist-search` | `:671` | re-emit |
| `archivist-year-from` / `-to` | `:682`, `:693` | re-emit |
| `archivist-search-btn` / `-reroll-btn` | `:700`, `:707` | re-emit |
| `archivist-preview` | `:714` | re-emit on the wrap |
| `archivist-video` / `-audio` / `-image` | set in `init` `:161` | ⚠ **unchanged — they live on the NODE-OWNED elements**, set by `nodeMedia.adopt`'s `init`. This is the one group promotion cannot move, and it is why `archivist.spec.ts:120` (`toHaveJSProperty('complete', true)`) and `:173-181` (readyState/duration) survive a re-point untouched |
| `archivist-hint` / `-loading` / `-error` | `:730`, `:736`, `:744` | re-emit |
| `archivist-play` / `-back` / `-fwd` / `-rand-pos` | `:750-753` | re-emit |
| `archivist-time` | `:754` | ⛔ **NOT re-emitted** — the removed readout (§7). No spec asserts it today, so nothing has to move |
| `archivist-seek` | `:765` | re-emit |
| `archivist-meta` | `:772` | re-emit |
| `archivist-cors-warn` | `:777` | ⚠ **replaced.** `archivist.spec.ts:118`, `:145` assert `toHaveCount(0)` and `:163` asserts `toBeVisible()`. Re-point onto the StatusLed's `data-clean-output` state (§7.2) |
| `archivist-audio-art` | `:723` | re-emit (glyph only, §7 #6) |
| `archivist-resize-handle` | `:788` | ⛔ not carried (§2.3). No spec asserts it |
| `data-has-item` / `-media-type` / `-clean-output` / `-is-playing` | `:637-640` | ⚠ **re-emit on the body root.** Eight assertions across the three tests read them |

**The three tests then need one structural change each**: drop `?shell=legacy`, open
the dock full view, and drive the body. ⚠ The VIDEO test's `data-clean-output` and
play-advance legs are the ones to watch — its `advances` probe (`:214-220`) is
capability-gated with an honest `console.log` fallback and must stay that way.

⚠ **`archivist` is in `_face-fixtures.ts`'s `DENIED` map** (`:108-110`) with the
reason *"fetches archive.org over the NETWORK at mount"*. **That reason is FALSE —
see §11 D2** — but the ENTRY is still correct on its other clause (*"a fixture must
never depend on a third-party host being reachable from the runner"*), so the entry
STAYS and its wording is corrected. ⚠ And note the trap that file documents about
itself twice (`:66-88`, `:89-100`): a DENIED entry for a **promoted** module goes
INVISIBLE rather than red, because the loop filters on `unpromoted`. **archivist's
entry must be re-read at promotion time, not left to rot** — two entries have already
been deleted by hand for exactly this.

---

## 9. VRT — the exemption is ALREADY PERMANENT, so the question is only about the FACE scenes

* **`EXEMPT_FROM_VRT:406`** — *"live external archive.org source + live
  `<video>`/`<audio>` + ticking playhead defeat deterministic capture; pure-core unit
  tests (query/parse/file-pick/scrub) + route-mocked e2e provide coverage"*.
* **`ALLOWED_PERMANENT_EXEMPT:1163`** — archivist is in it.
* **`ls e2e/vrt/__screenshots__/vrt.spec.ts/ | grep archiv` → nothing.** There is no
  card baseline.

**So promotion moves ZERO baselines and adds at most TWO** (`face-archivist-compact.png`,
`face-archivist-dock.png`) — the cheapest VRT position in the wave, and strictly
cheaper than picturebox's (which moved one).

### 9.1 THE DETERMINISM VERDICT — **CAPTURABLE, and the argument is `samsloop`'s, not `cameraInput`'s**

The wave brief flags a network-backed module's dock baseline as a determinism
hazard. It is, **for a loaded node.** The scenes do not spawn one.

`_shell-faces.ts`'s `samsloop` entry (`:2823-2846`) is the template, and its three
conditions map one-for-one:

| samsloop's condition | archivist's equivalent | verified at |
|---|---|---|
| *"a freshly spawned samsloop holds NO SAMPLE, so the body takes its empty branch"* | a freshly spawned archivist has `item: null` | `ARCHIVIST_DATA_DEFAULTS` (`archivist.ts:122-129`) |
| *"IDLE-BY-DEFAULT with no autoplay … the playhead is suppressed entirely"* | `isPlaying: false`; the transport block is `{#if isTimeMedia}` and `item` is null, so it does not render at all | `ArchivistCard.svelte:748` |
| *"the live RECORD branch … is reachable only after a REC press, which no VRT scene performs"* | ⚠ **the network is reachable only after a SEARCH press, which no VRT scene performs** | §9.2 |

⚠ **AND THE THIRD ROW IS A MEASUREMENT, NOT AN ASSUMPTION.** Enumerating every
caller of `runSearch` in the card: `onSearchKeydown` (Enter, `:598-600`),
`onclick` on the Search button (`:698`), and `nextRandom()` when `lastDocs` is empty
(`:291`). `onMount` (`:573-578`) starts two timers and calls `attachMedia(item)`
**only if `item` is non-null**. **There is no fetch on mount.** A VRT scene that
spawns archivist and captures makes zero network requests.

**VERDICT: `archivist` does NOT need a `FACES_WITHOUT_SCENES` entry, and does NOT
need a `simPin`.** Its face scenes are captured normally.

⚠ **The scope of that verdict, stated so a future scene cannot silently break it:**
it is about the CAPTURE STATE, not about the surface being pure. Load an item and
this surface is as unstable as anything in the fleet. **If a future scene ever
spawns archivist WITH an item, it needs a pin and this section is wrong** — the
exact caveat samsloop's entry carries, for the same reason.

### 9.2 ⚠ THE ONE THING TO CHECK BEFORE TRUSTING THIS

The empty canvas paints the module's idle gradient
(`vec4(0.04, 0.05, 0.09 + vUv.y*0.06, 1.0)`, `archivist.ts:78-82`) — a pure function
of `vUv`, with no clock and no RNG. **That is deterministic.** But the body composes
it through `blitOutputForPreview`, which is CADENCE-GATED (`engine.ts:1663-1673`),
so a capture taken between blits sees whatever the 2-D canvas last held — which on a
cold open is *nothing*, i.e. transparent-black rather than the gradient.

**M4 in §13 is the measurement**, and the fix if it bites is the one the engine's own
comment names: a one-shot present must pass `{ immediate: true }` (`engine.ts:1650-1660`,
the #1836 TOYBOX case where 2 of 12 rendered frames were presented). ⚠ Note the
distinction that makes this worth checking rather than assuming: *"'holds a frame,
never which frame'"* is the defect that put `milkdrop` on `FACES_WITHOUT_SCENES`;
here every frame is the same frame, so the failure mode is **an empty canvas**, not
a wrong one — which is visually obvious in a baseline review rather than subtle.

### 9.3 BOTH COST ARTIFACTS RE-PIN

`module-faceplates.md`: *"⚠ A FACE ADDS SCENES TO **BOTH** COST ARTIFACTS — RE-PIN
BOTH, EVERY TIME."* Two new `vrt-strict` scenes ride the median until measured, and
that has reddened `main` at 92 % of a shard budget with every test passing.
`task e2e:timings:accept` **and** `task vrt:strict:timings:accept`, both diffs
reviewed.

Dispatch **scoped**: `GREP=archivist flox activate -- task vrt:commit`. ⚠ A bare
dispatch on a face PR derives FULL, because every face PR touches a shared roster
file whose path names no module. **Predict TWO files and count what the bot
commits.**

---

## 10. COST

### 10.1 ⚠ WEBGL ATTEST — THREE BASIS FILES, AND EXACTLY ONE EDIT COSTS THE GPU

```
$ flox activate -- bash scripts/webgl-attest-hash.sh --list | grep -i archivist
packages/web/src/lib/video/modules/archivist-query.ts
packages/web/src/lib/video/modules/archivist-scrub.ts
packages/web/src/lib/video/modules/archivist.ts
```

`HASH_TRANSPARENT_PROPS` (`scripts/attest-code-basis.ts`) strips `docs`,
`controlFamilies`, `face` and `noUserControl` **when they are direct members of a
module-scope object literal**. So:

| edit | file | attest |
|---|---|---|
| `face: { … }` on `archivistDef` | `archivist.ts` | **ZERO** — stripped |
| `noUserControl: [ … ]` at the def's top level | `archivist.ts` | **ZERO** — stripped ⚠ it must be at the DEF's top level, not nested inside a `ParamDef`; wave 4 measured a nested version MOVING the hash and nearly reported it as a platform defect |
| the D1/D2/D5 comment fixes | `archivist.ts` | **ZERO** — the parser drops comments |
| **`uGain` (§0.1.1)** | `archivist.ts` | ⚠ **MOVES THE HASH.** A `uniform float` in a template literal, a `getUniformLocation` and a `uniform1f` are ordinary code |
| the body, the extension, the registries, the e2e | `lib/ui/**` | **ZERO** — not in the basis |
| `paramSpec(...)` in a card | n/a | ⚠ **NOT APPLICABLE HERE, and it is worth saying.** The brief instructs binding ranges with `paramSpec` on a basis-resident def. **`ArchivistCard.svelte` renders no param control at all** — no `min=`/`max=` prop exists to bind — so there is nothing for `paramSpec` to serve, and the `card-range-source` question does not arise. It arises on the BODY's new `gain` fader, and a body reads the `ParamDef` through the ranked-cell path anyway |

**PR SHAPE — and this is the wave's cheapest available saving:**

> **ONE attest window for BOTH modules.** archivist and peertube have the identical
> `uGain` defect and the identical three-line fix. Landing them as two PRs each
> touching one basis file is **two** real-GPU windows CI (SwiftShader) cannot run.
> Landing the shader fix for both in **one** precursor PR is one window.

* **PR A — "wire the inert output gain on the four video sources that declare it and
  ignore it"**: `archivist.ts`, `peertube.ts`, and (boy-scout, same three lines,
  same argument) `videobox.ts` and `tvLibrarian`. **ONE attest.** Byte-identical at
  defaults (§0.1.1), so it needs no owner pixel preview. ⚠ Verify by rendering the
  four modules before and after with `gain` at its default and asserting an
  unchanged frame signature — a positive control at `gain = 0.5` must MOVE it.
* **PR B — the archivist face.** `face` + `noUserControl` + the body + the
  extension + the registries + the e2e re-point + D1/D3/D5. **ZERO attest.**
* **PR C — the peertube face.** Same, plus its own precursor (`../peertube/spec.md §6.2`).

⚠ **Attest a pin covers a TREE, not a PR.** If `main` moves a basis file under you,
your hash changes without your diff changing — match CI's refusal hash before
spending the GPU, and never measure attest state in a dirty primary checkout.

### 10.2 ART — ZERO, measured rather than inferred

* `ls art/baselines/` — no `archivist/` directory.
* The audio profile gate enumerates **audio-domain ids only**
  (`art/scenarios/_meta/audio-profile-gate.test.ts`, matching
  `/^(\S+) meta domain=audio\b/` off the contract golden). archivist is
  video-domain, so the gate never sees it and it needs to be in neither
  `ART_EXCLUDED` nor `ART_BACKLOG`.

**`art/` should be absent from this diff.**

### 10.3 CONTRACT — unchanged, and that is a design constraint

`face` is fully contract-transparent (`serializeModuleContract` projects
id/min/max/curve/defaultValue/units/ports/flags). **`controlFamilies` is NOT**, and
this face declares none — which is one more reason §6.1 refuses the `selector` rung.
`docs.controls.gain` **is** edited (D3, §11) and `docs` is contract-transparent too,
so `task docs:accept` should produce an **empty** `contract-lock.txt` diff. ⚠ **A
non-empty diff means something changed the I/O contract — stop and read it.**

### 10.4 THE PUSH 2 CARD MOVES

Three tiers, first match wins (`push-card-config.ts:20-33`): OVERRIDE → FACE (first
8 turnable params of `face.order`) → GENERIC. archivist has no explicit
`PUSH_CARD_CONTROLS` entry, so **a first promotion moves it from GENERIC to FACE** —
the whole card changes, not one slot. Declaring `noUserControl` additionally drops
`cv_play_trigger` from the Push card entirely (`push-card-schema.ts:96-98`).

Both changes are improvements (a raw gate cache should never have been on a hardware
controller) but they are behaviour changes **outside the faceplate** and the PR body
must say so. `push-card-schema.test.ts` is a must-run (§14).

### 10.5 CI WALL-TIME

New: two VRT face captures (they ride the scoped `vrt:commit` dispatch, not the PR's
CI lane), one new unit file (`archivist-face-model.test.ts`), and the three existing
`archivist.spec.ts` tests re-pointed at the dock — which **adds a dock-open step**
to each but removes nothing.

`faces-parity` budgets CI at roughly `10 s + 0.8 s/cell`
(`faces-parity.spec.ts:78-83`). This face has ONE cell. **Estimated PR delta: well
under 2 minutes**, under the sign-off bar. ⚠ The `vrt-strict` side is the one that
bites, and §9.3's re-pin is what stops it.

---

## 11. DEFECT LEDGER — live on `main`, independent of any face

Per the owner ruling nobody opens issues; each item is fixed **inside a PR** and the
PR narrative is the searchable record.

| # | defect | evidence | routing |
|---|---|---|---|
| **D1** | ⚠⚠ **ARCHIVIST IS NOT MULTIPLAYER-AWARE FOR ITEM LOADING, AND THREE PLACES CLAIM IT IS.** The def (`archivist.ts:184`) promises *"Multiplayer-aware: the loaded item, search inputs, and play state mirror on the node so peers see and drive the same item"*; the card header (`:26-28`) says *"Each peer loads the URL locally"*. **There is no `$effect` on `item`.** Enumerated: the card has three (`:151` adopt, `:186` class-toggle, `:531` isPlaying-sync) and two `onMount`s (`:193` hydrate, `:573` timers + `if (item) attachMedia(item)`). So `attachMedia` runs **on mount and inside `loadItem` only**. A remote peer's selection writes `node.data.item`; the local card updates `data-has-item`, the title link and the transport UI — and never sets `.src` on any element. **The preview stays empty and every output stays idle.** ⚠ Contrast `PeerTubeCard.svelte:482-491`, which HAS the effect: the sibling is correct and this one is not, which is why reading them together found it | direct read; the effect enumeration is the measurement | **fix in PR B** — one `$effect` mirroring peertube's, keyed on `item.identifier`+`item.fileUrl` with a `lastAttached` guard so it does not re-attach per tick. ⚠ **It is also the seam the body needs** (§6.2), so the face cannot ship without it |
| **D2** | ⚠ **TWO SHIPPED RECORDS SAY THIS MODULE FETCHES AT MOUNT. IT DOES NOT.** `_face-fixtures.ts:108-110` — *"**fetches archive.org over the NETWORK at mount**"*. Measured: `onMount` (`:573-578`) starts a gate loop, starts a 100 ms display timer, and calls `attachMedia` only for an already-persisted item. Every `runSearch` caller is a user gesture (§9.2). The same false clause is in the peertube entry (`:111-113`). ⚠ It is a **stale scoping claim**, the class `module-faceplates.md` warns *"goes quietly green forever … and it reads as a considered architectural boundary rather than a snapshot"* | `:108-113` vs `ArchivistCard.svelte:573-578` | **fix in PR B** — correct the wording. ⚠ **The DENIED entry itself STAYS**: its other clause (a fixture must not depend on a third-party host) is true and sufficient |
| **D3** | **`gain` is declared, documented, unreachable and inert** (§0.1). It is in the contract, `contract-lock` pins it, and the Push card will rank it | `archivist.ts:179`, `:199`; `FRAG_SRC :68-84`; `draw :347-385` | **PR A** — wire it. Then rewrite `docs.controls.gain` to describe a working control |
| **D4** | **No input targets `gain`.** Every other faced video source that wires gain also leaves it CV-unreachable, so this is a fleet shape rather than an archivist bug — but with `gain` wired it becomes the obvious next ask | `archivist.ts:161-164` (one input) | ⚠ **NOT this PR.** A new input port is a CONTRACT change (`contract-lock` moves) **and** a basis edit. Recorded so the next person does not bolt it onto a face PR |
| **D5** | ⚠ **The corner-resize writes `node.data` untagged** — no `transact`, no `LOCAL_ORIGIN`, so it is not undoable and not atomic. **Byte-identical to `PeerTubeCard.svelte:518-524`**; both come from a caller-supplied `startCornerResize` `apply` | `ArchivistCard.svelte:616-621`; `mutate.ts:13-18`; `store.ts:70` | **fix in PR B** — route through `mutateNode`. ⚠ Not by wrapping in a bare `ydoc.transact(fn)` (wave 5 measured that shape as atomic-but-un-undoable on chromaconsole) |
| **D6** | ⚠ **`archivist-query.ts:8-9` contains a TRUNCATED CITATION.** The header reads *"Feasibility verified 2026-06-14 against the live endpoints — see`.` Headline: …"* — a dangling `see` followed by a bare period where a reference was removed. The sentence promises evidence and delivers none | `archivist-query.ts:8-9` | **fix in PR B** — comment-only, hash-transparent |
| **D7** | **`formatTime` loses its only caller.** `archivist-scrub.ts:50-58` exists solely for the `m:ss / m:ss` readout §7 removes, and `archivist-scrub.test.ts` covers it | `archivist-scrub.ts:51`; `ArchivistCard.svelte:754` | ⚠ **KEEP IT, and use it in `aria-valuetext`** (§7 #4). Deleting it would remove tested code and force the aria string to re-implement the same mm:ss padding — the exact "two places for one number" shape the range rule is about |
| **D8** | ⚠ **The def's `docs.explanation` describes a UI the promoted module will not have**: *"The card is corner-drag resizable (handle bottom-right, min 360x360, default 360x540), with a 16:9 preview screen inside"* | `archivist.ts:184` | **fix in PR B** — describe the faceplate. `docs` is hash-transparent and contract-transparent, so it is free; ⚠ but `module-docs-lint` reads the DEF and is structurally blind to a `docs` string that promises a surface the implementation no longer has, which is why this needs a human edit rather than a gate |

---

## 12. TASTE CALLS, EACH WITH ITS ONE-LINE REVERT

| call | revert |
|---|---|
| `gain` is a `'fader'`, not a knob | delete the `paramCells` entry |
| the query block sits ABOVE the transport and BELOW the picture | swap the two blocks |
| the CORS signal is a lamp with a static `OUT` caption | change the caption string (⚠ **not** to a state word — §7.2) |
| the empty canvas paints `SEARCH THE INTERNET ARCHIVE` | drop the `fillText`; ⚠ then "no item" and "the body failed to mount" become the same picture |
| the media type stays in the body rather than becoming a `selector` cell | add the `controlFamilies` entry + a `SHELL_CELLS` record + a `docs.controls` entry — three shared-file edits and a contract move |
| the corner resize is not carried | add a body-local grip on a NEW `node.data` key (§2.3) |
| no tab rail | — (needs an owner instruction; `face.tabbed` is not a build-lane decision) |

---

## 13. MUST-VERIFY (before the face is written)

* **M1 — the headless card really is unclickable.** On `main`, promote nothing;
  instead spawn a `cameraInput` (already promoted, same set) and assert that its
  card inside `[data-testid="headless-source-host"]` has
  `pointer-events: none` computed and is off-viewport. This is the premise the whole
  body rests on and it is one `getComputedStyle` away. ⚠ Do it BEFORE building, not
  after.
* **M2 — ADOPTION FROM A SECOND SURFACE (§2.1.1), in both directions.** Mount a
  second host div in a test page, `adopt` the same `(nodeId, 'video')`, and assert:
  (a) the element moved; (b) the card's retained `mediaEl` reference is the SAME
  object; (c) `.play()`/`.currentTime` still work through it; (d) the card's
  subsequent `release()` is a **no-op** (the owner check); (e) the body's `release()`
  parks it and playback continues. ⚠ **(d) is the leg that decides the design** — if
  release is not owner-checked in practice, the whole §2.1.1 route is unsafe.
  `node-media-registry.test.ts` already drives the pure core with fakes and is where
  this goes.
* **M3 — the video preview really is blank via the blit.** With a video item loaded,
  read `blitOutputForPreview(nodeId)` into a canvas and assert the pixels match the
  idle gradient; then with an IMAGE item assert they do not. ⚠ **Both directions** —
  "the idle field" and "the blit never ran" are indistinguishable from one reading,
  which is the exact instrument failure CLAUDE.md opens on.
* **M4 — the cold-open dock capture is the GRADIENT, not an empty canvas** (§9.2).
  Open the dock full view on a fresh archivist and read the body canvas's mean RGB
  across three consecutive captures. ⚠ If it is transparent-black, the fix is
  `{ immediate: true }` on the first present, not a wait.
* **M5 — `noUserControl` is accepted AND its negative control fires.** Run
  `no-user-control.test.ts` and `module-face-lint.test.ts`; confirm completeness
  skips `cv_play_trigger` **and** that additionally ranking it is RED. Drive the
  negative control; do not assume it.
* **M6 — the `uGain` fix is byte-identical at defaults and NOT at 0.5** (§10.1).
  Both legs, on a real GPU, before spending the attest window.
* **M7 — D1 reproduces.** Two browser contexts on one rackspace; load an item in A;
  assert B's `node.data.item` is populated and B's `<video>` `src` is empty. ⚠ This
  is the defect ledger's headline and it should be seen, not inferred.

---

## 14. VERIFICATION GATE

```bash
# 1. the face model + its permanent negative controls
flox activate -- npx vitest run packages/web/src/lib/ui/modules/archivist-face-model.test.ts

# 2. face lint + the promotion anchor (both directions)
flox activate -- npx vitest run packages/web/src/lib/ui/workflow/module-face-lint.test.ts

# 3. the noUserControl soundness sweep + its consumers
flox activate -- npx vitest run packages/web/src/lib/ui/workflow/no-user-control.test.ts

# 4. the rulings' source gates
flox activate -- npx vitest run \
  packages/web/src/lib/ui/controls/face-readout-source.test.ts \
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

# 6. the module's own suites
flox activate -- npx vitest run packages/web/src/lib/video/modules/archivist-query.test.ts
flox activate -- npx vitest run packages/web/src/lib/video/modules/archivist-scrub.test.ts
REPEAT=3 flox activate -- task e2e:one -- tests/archivist.spec.ts
REPEAT=3 flox activate -- npx --workspace e2e playwright test faces-parity --grep archivist
REPEAT=3 flox activate -- task e2e:one -- tests/faceplate-platform.spec.ts

# 7. docs contract — the def's docs are edited (D3/D8), so re-pin and READ the diff
flox activate -- task docs:accept && flox activate -- git diff packages/web/src/lib/docs/contract-lock.txt
#    ⚠ EXPECT AN EMPTY DIFF. `docs` and `face` are both contract-transparent.
#    A non-empty diff means the I/O contract moved — stop and read it.

# 8. typecheck LAST — vitest is lenient where svelte-check is strict
flox activate -- task typecheck

# 9. BOTH cost artifacts, from the newest green run (§9.3)
flox activate -- task e2e:timings:accept -- <run>
flox activate -- task vrt:strict:timings:accept -- <run>

# 10. VRT: dispatch only, SCOPED, and COUNT the files. NEVER commit a PNG.
GREP=archivist flox activate -- task vrt:commit
#    PREDICT: 2 added (face-archivist-compact.png, face-archivist-dock.png), 0 moved.
#    A green dispatch that committed nothing is a RED FLAG.

# 11. attest: NIL for PR B (§10.1). Confirm the hash is UNMOVED against the MERGED tree.
flox activate -- bash scripts/webgl-attest-hash.sh
```

---

## 15. VERDICT, RISK, ESTIMATE

**PROMOTE-WITH-PRECURSOR.** The precursor is **PR A**, the three-line `uGain` wiring
(§0.1.1 / §10.1) — not because the face depends on the pixels, but because the face
must rank `gain` and there is no honest way to rank a param nothing consumes. It is
shared with the sibling, so it is one attest window for the cohort rather than one
per module.

**No platform change is asked for.** ⚠ Both declared blockers are dismissed on
measurement: `needs-media-controller` does not block a face (cameraInput and loopback
already shipped through it) and `needs-note-entry-cell` is scoped to CELLS while the
typed query belongs in a BODY (§0.4). **The `needs-note-entry-cell` entry should be
removed from archivist's `blockers` array when this lands.**

**Risk: MEDIUM-HIGH**, and it is concentrated in two places rather than spread:

1. ⚠ **THE ADOPTION ROUTE (§2.1.1) IS UNPRECEDENTED.** Every other faced DOM-source
   body blits and never adopts, and cameraInput's file says so in capitals. The
   argument that the prohibition does not transfer is sound — archivist's element
   carries no stream — but it is an argument, and **M2 is the experiment that has to
   run before a line is written.** If M2's leg (d) fails, the fallback is worse
   rather than absent: an `<img>`-only preview for image items and a literal
   in-canvas "video plays in the legacy card" placeholder, which is a genuine parity
   loss and would make the verdict BLOCKED.
2. **The rebuild is nineteen affordances wide** (§2). None is hard; there are simply
   a lot of them, and four of the e2e assertions move onto a different mechanism
   (§8).

**Estimate: ≈ 16 h**, as PR A ≈ 3 h (four modules, three lines each, the two-way
frame-signature control, one attest window) + PR B ≈ 13 h (the body ≈ 6 h, the two
extractions ≈ 2 h, D1 + D5 ≈ 1.5 h, the e2e re-point ≈ 2 h, the face-model unit
≈ 1.5 h).

**Build it AFTER the sibling.** `peertube` carries a promotion-CREATED defect
(`../peertube/spec.md §2.2`) whose fix — a node-keyed browse registry — is the
riskier of the two designs and wants unhurried review; and its body is the ordinary
blit, so it proves the shared shape out before archivist departs from it. **Land
PR A first, on its own, for both.**
