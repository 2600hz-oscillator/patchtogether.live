# FACEPLATE BUILD SPEC — `recorderbox` (video, the RECORDER SINK)

**SPEC ONLY. Nothing here is implemented.** Mockups: [`dock.html`](dock.html) ·
[`dock-recording.html`](dock-recording.html).

Method: analyse what the module is FOR, then author the spec, then build from the
spec. Every claim below carries the file and line it was measured from, and the
ones that were *checked and came back different from the brief that commissioned
this spec* are marked ⚠ and kept rather than quietly corrected — the correction is
the finding.

Measured on `ea2e06340`.

---

## 0. THE HEADLINE — THE SET ANOMALY IS **(a) A STALE `why`**, AND THE FIX IT DESCRIBES IS A MERGED P0

This spec was commissioned with an open question at the top of it, so it is
answered before anything else.

### 0.1 THE ANOMALY, RESTATED FROM THE TREE

`face-migration-inventory.ts:1027-1034` declares:

```ts
{
  type: 'recorderbox',
  disposition: 'bespoke-surface',
  blockers: ['needs-media-controller', 'needs-note-entry-cell'],
  why:
    'a RECORDER: arm/record/stop transport, quality selection, a typed filename, a take list and ' +
    'a save flow — and the capture canvas plus its per-frame encode loop live on the card, so ' +
    'the recording exists only while it is mounted.',
}
```

The final clause — *"the capture canvas plus its per-frame encode loop live on
the card, so the recording exists only while it is mounted"* — **is false, and
has been false since 2026-06.**

### 0.2 THE EVIDENCE, AT THE LINES

| claim in the `why` | the tree | measured at |
|---|---|---|
| "the capture canvas … live[s] on the card" | ⚠ **there is no capture canvas on the card.** `let previewEl` is the only canvas reference, and the comment beside it exists specifically to deny the claim | `RecorderboxCard.svelte:92-96` |
| "its per-frame encode loop live[s] on the card" | ⚠ **the card's rAF loop is preview-only and says so.** *"CAPTURE IS NOT HERE. It runs on the registry's own pump, which keeps feeding the encoder while this card is unmounted. This loop is preview-only and is correct to die with the card."* | `RecorderboxCard.svelte:257-260` |
| "the recording exists only while it is mounted" | ⚠ **the exact opposite is now guaranteed, by a P0 fix, with the old behaviour named as the bug.** *"#1574: the recording belongs to the NODE, not to this card … Collapsing the dock full-view unmounts this card; before the registry that unmount called `recorder.abandon()` and destroyed the user's take. The card no longer holds anything it could kill."* | `RecorderboxCard.svelte:106-111` |

The card's `onDestroy` closes it out (`:514-522`):

> *"PREVIEW ONLY. #1574: this used to also `recorder.abandon()`, which made
> COLLAPSING the card destroy an in-progress recording — the card cannot
> distinguish 'collapsed' from 'node deleted', so it must decide neither. The
> recording is owned by node-recorder-registry and ends only on user intent
> (Record OFF) or on the node leaving the graph (Canvas's sweep). There is
> deliberately no registry method to call here."*

The owner of all of it is `$lib/ui/modules/node-recorder-registry.svelte.ts`
(15.9 KB, with a 18.1 KB test beside it), whose own header states the lifetime
rule (`:41-53`): *"Teardown is keyed to GRAPH lifetime — `sweep(liveNodeIds)` …
This registry deliberately exposes NO per-card teardown: no `dispose()`, no …
the only [removals] are `stop()` (the user pressed Record OFF) and `sweep()` (the
node is gone)."*

And the shipping commit is on `main`:

```
bdef392f6 fix(recorderbox): the recording belongs to the NODE — collapsing the
          card no longer destroys the take (P0) (#1574) (#1584)
```

**So the `why` string is a verbatim description of a P0 that was fixed, kept in
the present tense, in the file whose entire job is to say what still blocks a
module.** That is a documentation defect (D1 below), and it is the kind that
costs real time: it is the ONLY statement on record about recorderbox's media
lifetime, and it points the reader at the opposite of the truth.

### 0.3 ⚠ SO THE SET ABSENCE IS CORRECT — BUT THE GATE THAT ANCHORS IT COULD NOT HAVE TOLD US THAT

This is the more valuable half, and it was checked in the order the brief asked
for: **the gate's predicates were read before its output.**

`recorderbox` is in neither `DOM_SOURCE_LANE_TYPES` (`dom-source-modules.ts:89-97`)
nor `CARD_PRODUCER_LANE_TYPES` (`:214-221`), so it is not in
`HEADLESS_MOUNT_LANE_TYPES` and `<HeadlessSourceHost>` does not keep it alive.
Both sets are *derived* by `dom-source-modules.test.ts`, so the temptation is to
read the absence as a gate-anchored statement that recorderbox owns no card-lifetime
engine state.

**It is not that statement.** The gate derives membership from exactly three
seams:

* `CALL_RE = /attachExternalSource\s*\(/` (`dom-source-modules.test.ts:79`);
* `PRODUCER_SEAMS[0]` — `/\bwrite\s*\(\s*(?:node|id|nodeId)\s*,/` (`:319`);
* `PRODUCER_SEAMS[1]` — `/\binstall\w*FrameDrawer\s*\(/` (`:329`).

All three describe a card that **hands the engine a source or pushes pixels into
it**. `recorderbox` is a **SINK**: it *consumes* the engine's output
(`ve.blitOutputForPreview(id)`, `:237`) and hands the bytes to an encoder. It
could never match any of the three, whatever its lifetime discipline were.

⚠ **Therefore: if #1574 were reverted tomorrow and the recorder moved back onto
the card, `dom-source-modules.test.ts` would stay green and recorderbox would
stay out of both sets.** Its absence is not evidence about recorderbox; it is a
tautology about a regex.

The gate is honest about this — it is the first bullet of its own stated scope
(`:33-35`): *"a card that produces engine state through a seam not in
`PRODUCER_SEAMS` — a genuinely new fourth mechanism. Nothing here can invent that
name; the e2e (`e2e/tests/card-producer-lifetime.spec.ts`) is the behavioural
net."* A **consuming** card is precisely that unnamed mechanism, and it is not a
hypothetical: it is a shipped module that had this exact defect and had it fixed
as a P0.

**The conclusion is (a), and it was reached by reading `RecorderboxCard.svelte`,
not by reading the set.** Recorded here because the reverse inference — "the
derived set omits it, so the seam is gone" — is available, plausible, and wrong,
and it is the inference the brief that commissioned this spec started from.

D2 records this as a blind spot rather than a defect: nothing is broken today,
and per the standing no-new-gates ruling this spec does **not** propose widening
`PRODUCER_SEAMS`. It proposes that the entry's `why` say what is true, which is
the thing that would actually have prevented the confusion.

---

## 1. THE CONSTRAINT MAP, READ FIRST

| constraint | recorderbox's answer | measured at |
|---|---|---|
| `NON_SHELL_LANE_TYPES` | **NOT a member** — the set is `group, sticky, cadillac, clipplayer, controlSurface, electraControl, launchpadControlLeft` | `legacy-fallback.ts:96-112` |
| `HEADLESS_MOUNT_LANE_TYPES` | **NOT a member, and correctly so** (§0) — but see §3, because it is the reason this face needs a precursor | `dom-source-modules.ts:219-222` |
| lane picture | **FREE, automatic, per-node** — `domain: 'video'` is the whole predicate | `module-shell-model.ts:177-179`, `:237-240`; §5 |
| WebGL attest | ⚠ **ELEVEN basis files**, the largest footprint of any module in this wave | §11.1 |
| ART | none — video domain is outside the audio profile gate | §11.2 |
| VRT | ⚠ **has a committed baseline AND a canvas mask today** | `vrt-exemptions.ts:122-124`; §10 |
| shell extension slot | `fullViewBody`. Never `editorSurface` (declared, unwired) | `shell-extensions.ts:118`, `:124` |
| tab rail | **NO** — zero params means zero bands; §6.2 | `dock-tabs-model.ts:101` |
| `node.data` writes / Cmd-Z | ⚠ **BROKEN — bare proxy writes, no transaction, no origin** | `RecorderboxCard.svelte:144-151`; §2 |
| `EXTENSION_BODY_ROLES` | **`status-primitive`** — the roster's second non-picture body | §9 |
| params | ⚠ **ZERO.** `params: []` | `recorderbox.ts:162` |

### 1.1 ZERO PARAMS IS LEGAL, AND THERE ARE TWO PRECEDENTS

`recorderbox.ts:162` declares `params: []`, and `:66` says why: *"Params: none
(filename + record state live in node.data, not params)."*

A face over a zero-param def is `face.order: []`, and `module-face-lint`'s
lane-tile gate explicitly carves the shape in — not by exemption, but by scope
(`module-face-lint.test.ts:3042-3045`):

> *"⚠ A face that ranks NOTHING is not in scope: it promises the lane nothing, so
> an empty tile is the honest rendering of it. `flipper` (params: []) and
> `videoOut` (order: [], picture) are both this shape, and both are deliberate.
> The subject is a face that ranks controls."*

`EMPTY_LANE_OK` is empty (`:3029`) and **recorderbox needs no entry in it**,
because the gate never reaches the check for a face that ranks nothing.

⚠ **`videoOut` is not merely a precedent here, it is the structural twin**, and
§13 argues that it — not any of the five other modules in this cohort — is
recorderbox's nearest neighbour in the entire fleet.

---

## 2. ⚠ THE `.data` CENSUS — recorderbox IS BROKEN, AND IT IS THE PLAINEST CASE FOUND IN FOUR WAVES

Waves 3, 4 and 5 built a three-state table of how the bespoke cohort writes
`node.data` (wave 5 README §7). recorderbox lands in the worst row, with no
ambiguity at all.

```
RecorderboxCard.svelte:144-151
  function setData(key: 'filename' | 'recording' | 'quality', value: string | boolean) {
    const target = patch.nodes[id];
    if (target) {
      if (!target.data) target.data = {};
      target.data[key] = value;
    }
  }
```

* **No `ydoc.transact`.** A bare SyncedStore proxy write.
* **No `LOCAL_ORIGIN`.** `grep -c LOCAL_ORIGIN RecorderboxCard.svelte` → **0**.
  The token does not appear in the file.

`mutate.ts:13-18` states the consequence: an untagged write *"(a bare
`patch.nodes[id].params[p] = v` — SyncedStore's proxy transacts with NO origin)…
is silently NOT undoable"*, because `store.ts:70` configures
`trackedOrigins: new Set<unknown>([LOCAL_ORIGIN])`.

**All three of this module's user-facing settings are un-undoable**, and one of
them is destructive:

| write | reached from | Cmd-Z |
|---|---|---|
| `filename` | the FILE text field, `:154-157` | ✗ |
| `quality` | the SIZE `<select>`, `:159-162` | ✗ |
| `recording` | the RECORD button, `:164-167` | ✗ |

⚠ **`recording` is the one worth naming.** Cmd-Z after an accidental STOP does
not resume the take, and Cmd-Z after an accidental RECORD does not stop it —
and unlike a knob, both have irreversible side effects on disk (a chunk written,
a folder prompt raised). This is not a cosmetic undo gap; the module's own
lifetime rule (`node-recorder-registry.svelte.ts:41-53`) is that a recording
ends **only** on user intent, and the undo stack is not a route to that intent.

The `mutate.guard` gate cannot see any of it: its three patterns
(`RAW_PARAM_WRITE`, `RAW_PARAM_WRITE_KEY`, `WHOLE_BAG`) all anchor on the literal
token `.params`, and this is `.data`.

**Routing: fixed inside the face PR.** `setData` becomes one `ydoc.transact(…,
LOCAL_ORIGIN)` and is extracted alongside the transport (§4) so the face and the
card share it. No spec here depends on a `.data`-side ledger landing.

---

## 3. STOP 1 — THE PRECURSOR. **NOTHING WOULD START A RECORDING.**

This is the one hard finding that stands between recorderbox and a face, and it
is a consequence of §0 rather than a contradiction of it: the registry owns the
recording **once started**, and the thing that **starts** it lives on the card.

### 3.1 THE CHAIN, AT THE LINES

```
RecorderboxCard.svelte:264-272
  $effect(() => {
    const want = recording;
    const isLive = nodeRecorder.isRecording(id);
    if (want && !isLive && support.canRecord) {
      void startRecording();
    } else if (!want && isLive) {
      void stopRecording();
    }
  });
```

`startRecording()` (`:277-…`) is roughly 120 lines of **orchestration that exists
nowhere else**:

1. resolve the destination folder — re-verify the cached handle's write
   permission (`ensureHandleWritePermission`), then `planRecordStartFolder` (the
   presentation-safe policy, `recorderbox-present-policy.ts:31-38`), then
   `promptSaveFolder()` and `nodeRecorder.rememberFolder` (`:311-322`);
2. the overwrite confirm, gated on `mayShowOverwriteConfirm(isFullscreen)`
   (`:334-348`);
3. resolve the audio capture — the sample-accurate worklet tap, with the legacy
   `MediaStreamAudioTrackSource` fallback (`:365-384`);
4. resolve the encode profile for the chosen quality tier at the live engine
   resolution (`pickEncodeProfile`, `:353-357`);
5. only then `nodeRecorder.start(id, { engine, width, height, options })`
   (`:388-…`).

The registry's `start()` takes a **fully-resolved config**. It resolves nothing
itself.

### 3.2 WHY PROMOTION BREAKS IT, WHERE IT WOULD NOT BREAK tvLibrarian

Under the default shell an unfaced recorderbox renders `ModuleShellPlaceholder`
in the lane, and `RecorderboxCard` mounts only when the node is DOCKED. That is
coherent today, because **the RECORD button is on the card** — you cannot press
it without the card being mounted, and once pressed the registry owns the take.

A face moves the RECORD button onto the faceplate, which is reachable with **no
card mounted anywhere**:

* `needsHeadlessSourceMount` returns `false` for recorderbox (`dom-source-modules.ts:378`,
  the first line of the function: `if (!HEADLESS_MOUNT_LANE_TYPES.has(i.type)) return false;`);
* so no `<HeadlessSourceHost>`;
* so no `$effect` at `:264`;
* so pressing RECORD flips `node.data.recording` and **nothing observes it.**

⚠ **This is the wave-5 §6 class in its most severe form.** That section's finding
was that the STOP-2 grep (`'<button|<select|<input|oncontextmenu|manualTrigger|Toggle|Selector|accept='`)
finds affordances a user operates and is *structurally blind to a
component-lifecycle side effect the card performs on the user's behalf.*
recorderbox has **two** such effects and they are not decoration:

| lifecycle hook | what dies with the card | line |
|---|---|---|
| `$effect` on `recording` | **the entire transport.** RECORD/STOP become inert | `:264-272` |
| `onMount` → `probeEncoders(…)` | the `canRecord` / `opfs` support probe that gates the button and the badges | `:505-511` |
| `onMount` → `scanRecoverable()` | ⚠ **the crash-recovery prompt** — the surface that returns a take lost to a browser crash | `:512`, `:498-501` |

The third is the one with user data behind it.

### 3.3 THE PRECURSOR, NAMED

**Extract the record transport out of the card into a node-keyed module, and
call it from both surfaces.** This is exactly the route picturebox took to pay
its own #1511 debt (`extras-producers.ts` / `node-extras-registry`), and the
route #1574 already took for half of this module — the registry exists, it is
node-keyed, and it is missing only its front door.

Proposed: `packages/web/src/lib/ui/modules/recorderbox-transport.ts`

```ts
export async function startRecorderboxTake(nodeId: string, env: {…}): Promise<void>
export async function stopRecorderboxTake(nodeId: string): Promise<void>
export async function probeRecorderboxSupport(): Promise<Support>
export async function scanRecorderboxRecoverable(nodeId: string): Promise<RecorderboxManifest[]>
```

with `setData` (§2) moved beside them and origin-tagged. `RecorderboxCard.svelte`
keeps its `$effect` and calls the extraction; the face's transport cell calls the
same function directly.

⚠ **It must NOT live in `packages/web/src/lib/video/**`.** That directory is the
WebGL attest basis (§11.1), and `recorderbox-present-policy.ts:14-17` already
records the precedent verbatim: *"Lives under lib/ui/modules (NOT lib/video) ON
PURPOSE: lib/video/** is the WebGL attest basis, and this is non-rendering UI
policy that must not force a real-GPU re-attest."* Follow it.

⚠ **And it must NOT be solved by adding recorderbox to `HEADLESS_MOUNT_LANE_TYPES`.**
That set is DERIVED by a grep gate over three seams recorderbox matches none of
(§0.3); a hand-added member would be the one thing that file's own header forbids
(*"Adding a seam re-derives membership — you do not hand-add a type"*), and it
would pay the headless-host tax to keep a card alive whose only remaining job is
a preview the lane tile already draws (§7).

**Estimate for the precursor alone: ≈ 4 h.** It is a move, not a redesign — but
it is a move of the code path that writes the user's file, so it wants its own
review and its own green run.

---

## 4. STOP 2 — DOES EVERY AFFORDANCE SURVIVE? **YES, AND THE INVENTORY IS THE DESIGN**

Functional parity is a hard requirement, not a trade. Every affordance
`RecorderboxCard.svelte` offers, with where it goes:

| affordance | card | where it goes on the face | lost? |
|---|---|---|---|
| live preview canvas 200×150 | `:548-554` | ⚠ **the LANE TILE**, live, per-node, at 160×120 — §7 argues this is parity *and an upgrade* | no |
| REC lamp + `mm:ss` elapsed | `:556-560` | `StatusLed` in the body; the timecode moves to `detail` → `aria-label` — §8 | text yes, information no |
| `SAVING…` finalizing state | `:561-563` | second `StatusLed` (`SAVING`, `tone:'accent'`) | no |
| FILE text field | `:568-580` | `fullViewBody` — a short-text field; §6.4 | no |
| DIR folder name + PICK/CHANGE | `:582-600` | body row; the NAME moves to `title`/`aria` — §8 | no |
| folder hint (transient) | `:601-603` | body, transient — an outcome, not resting state | no |
| SIZE quality `<select>` | `:605-620` | ⚠ a `selector` **cell** — §6.3, and it is the only cell this face has | no |
| RECORD / STOP button | `:622-632` | a `toggle` cell — §6.3 | no |
| `no H.264 encoder available` badge | `:634-635` | body, gated on the same probe | no |
| `crash-recovery unavailable (no OPFS)` badge | `:636-637` | body | no |
| `saved <chunk>` while recording | `:640-642` | ⚠ **removed as text**, folded into the REC lamp's `detail` — §8 | text yes |
| the RECOVER prompt + per-take Save / Discard | `:646-658` | `fullViewBody`, top — §6.4 | no |
| PatchPanel jacks (IN, A·L, A·R, OUT) | `:545` | the shell's own patch surface | no |

**Nothing is lost.** Two things are removed as *painted text* and survive as
`aria` (§8), and one thing is **upgraded**: the preview stops being
only-when-the-card-is-open and becomes always-on in the lane (§7).

⚠ **The brief called `:646-658` a "take list". It is not a take list, and the
distinction matters for the design.** It is a **crash-recovery** list, populated
by `scanRecoverable()` from OPFS manifests left by a take that never finalized
(`recorderbox-store.ts` `listRecoverable`). At rest, after a clean session, **it
is empty and renders nothing** — which is what makes the idle dock baseline
deterministic (§10). recorderbox keeps no history of completed takes; a finished
chunk is a file on the user's disk and the module forgets it.

---

## 5. THE LANE PICTURE — **ACCEPTED**, free, and it does more work here than anywhere else in the wave

`hasVideoSurface(def)` is `def?.domain === 'video'` and nothing else
(`module-shell-model.ts:177-179`); `laneGlyphFor` returns `'picture'` for it
(`:237-240`); `ModuleShell.svelte:1345-1348` renders `<VideoTileThumb nodeId={id} />`,
which blits the node's own output FBO at `VIDEO_THUMB_W×H = 160×120`, throttled
to `VIDEO_THUMB_FPS = 15` (`:250-252`).

`recorderbox.ts:151` is `domain: 'video'`. **The picture is automatic, per-node,
and costs nothing to author.**

⚠ **And for this module the lane tile is showing the RIGHT thing, which is not
true by default.** recorderbox is a passthrough sink: `in` (video) → per-instance
FBO → `out` (video) (`recorderbox.ts:154-161`, and the def's own explanation:
*"it draws its `in` video into a per-instance framebuffer every frame so the card
can show a live preview AND so `out` can pass the picture through unbroken"*).
The FBO the thumb blits **is the frame being encoded**. The lane tile is
therefore a live confirmation of what is being recorded, at all times, whether or
not any dock is open — which is strictly more than the card's preview offers.

⚠ **The face MUST declare `glyph: 'none'`.** `glyphBinding()` short-circuits on
an audio output (`shell-glyph-live.ts:163-184`, `primaryAudioOutPortId` = the
first `type === 'audio'` **output**). recorderbox's audio ports are **inputs**
(`recorderbox.ts:156-157`); its only output is `{ id: 'out', type: 'video' }`
(`:160`). So every glyph literal except `'none'` resolves to `{kind:'static'}`
and `module-face-lint.test.ts:271-290` reddens it — unconditional, no exemption
list, no count.

---

## 6. THE FACE

### 6.1 THE DECLARATION

```ts
face: {
  glyph: 'none',            // mandatory for a video def — §5
  order: [],                // the module declares no params — §1.1
  cells: ['quality', 'record'],
  extension: 'recorderbox', // → fullViewBody
},
```

### 6.2 BANDS — none, and no tab rail

Zero ranked params is zero bands. `DOCK_TAB_MIN_BANDS = 7` (`dock-tabs-model.ts:101`),
applied at `:142`. **No tab rail, and none is manufactured.** `face.tabbed` is
owner-instruction-only and its single adopter is `spirographs`; padding a
zero-param module to seven bands to earn a rail would be the exact anti-pattern
the owner ruling names.

### 6.3 THE TWO CELLS, EACH ARGUED

**`quality` → `ShellSelectorCell`.** *"A dropdown over a NAMED roster that lives
in node.data (not a param)"* (`shell-cells.ts:166-172`) — which is
`node.data.quality` exactly. Its `options` is `(node) => SelectorOption<string>[]`,
fed from the module's own `QUALITY_VALUES` / `qualityLabel`
(`recorderbox-quality.ts`), and `value` from `coerceQuality(node?.data?.quality)`,
the same coercion the card uses (`RecorderboxCard.svelte:90`).

⚠ **A `selector`'s option labels are PERMITTED resting text and this is the clean
case of it.** `HIGH` / `BALANCED` / `SMALL` are option NAMES that disambiguate the
control's own position — the exhaustively-permitted role. Nothing derived is
painted: not the bitrate, not the codec, not the estimated file size.

**`record` → `ShellToggleCell`.** *"A 0/1 LATCHING switch backed by node.data (a
param-backed toggle is a `param` cell, not this)"* (`shell-cells.ts:315-320`).
`value: (node) => node?.data?.recording === true`; `onchange` calls the §3.3
extraction.

⚠ **A `toggle` rather than an `action`, and the reason is not stylistic.**
`node.data.recording` is genuine two-way latched state: it is synced over the
Y.Doc, so a **remote peer** can flip it, and the card's `$effect` reacts to the
value rather than to a press. An `action` cell models a press with no state
(`ShellActionCell`, `:286-300`) and would leave the face unable to render "a
rack-mate started this recording" — which is a state this module really can be
in. The toggle's `value` reads the truth; an action has no `value` at all.

⚠ **AND THE `action` PROBE REQUIREMENT IS WHY THIS IS WORTH SPELLING OUT.**
CLAUDE.md's rule — *"An ACTION-shaped cell needs a probe, exactly like a PANEL
does"* — applies to `ShellActionCell`, whose `probe` is **required**
(`shell-cells.ts:293`) precisely because *"a dead audition passed the face
green"* (`:220-226`). Had this been an action, its honest probe would have been
`{ kind: 'data', key: 'recording', expect: 'changed' }` — a real observable, not
an audition, because the press really does write the graph. Choosing the toggle
does not dodge that; a toggle's observable is the same `node.data` key, read by
the parity sweep from `value`.

⚠ **`file-export` is the RIGHT audition seam for the RECOVER→Save press, and it
is a BODY affordance rather than a cell.** `AuditionSeam`'s fifth member exists
*"for a press whose whole effect leaves the app — samsloop's sample DOWNLOAD"*
(`audition-ledger.ts:82-86`). Recovery-save is that shape. It stays in the body
(§6.4) because it is **per-row over a variable-length list**, and a cell is a
single control; if it ever becomes a single "save last take" button, `file-export`
is the seam it takes.

### 6.4 THE BODY — `face.extension: 'recorderbox'`, slot `fullViewBody`

`packages/web/src/lib/ui/modules/recorderbox/RecorderboxTransportBody.svelte`,
registered via `packages/web/src/lib/ui/modules/recorderbox/shell-extension.ts`.

Contents, top to bottom:

1. **the RECOVER block**, `{#if recoverable.length > 0}` — unchanged in substance
   from `:646-658`, and **first** because it is the only thing here with unsaved
   user data behind it. Per row: the chunk name (a NAME, §8), `Save`, `Discard`.
   Absent at rest.
2. **the two lamps** — `<StatusLed caption="REC" lit={recState === 'recording'} tone="warn" …/>`
   and `<StatusLed caption="SAVING" lit={recState === 'finalizing'} …/>`.
3. **the FILE row** — the short-text field, `.mp4` suffix as a static caption.
4. **the DIR row** — `PICK` / `CHANGE` button; the chosen folder's name lives in
   the button's `title` and `aria-label`, not in a text node (§8).
5. **the capability badges** — the no-encoder / no-OPFS lines, gated on the probe.
   These are **outcomes**, not resting derived state, and the picturebox
   precedent (§7 of that spec: *"an error is not resting derived text"*) applies.

⚠ **`fullViewBody`, never a `panel` cell**, for the reason picturebox §6.1 gives
and one more of its own: a `ShellPanelCell`'s probe vocabulary is
`data` / `data-rev` / `text` (`shell-cells.ts:379-381`) and `ShellPanelProbe`
**requires an element to click or drag**; the recover list is absent at rest, so
on the ordinary node there is nothing for the probe to reach. A body has no probe
requirement and is the honest seam for "a block that is usually not there".

⚠ **Never `editorSurface`.** `WIRED_SHELL_EXTENSION_SLOTS = ['glyph', 'fullViewBody']`
(`shell-extensions.ts:124`); `editorSurface` is declared (`:118`) and unwired, and
its first adopter must wire the render site in `ModuleShell` in the same diff.
A recorder's transport has no business being the module that wires a platform slot.

---

## 7. WIDTH — **NOT EARNED**, and the preview is where this face diverges from every other one in the cohort

The ruling: *"Compact is the DEFAULT. Width must be EARNED, and the burden of
proof is on the wide face."* A live picture is named as a genuine earner — and the
brief flagged recorderbox as the case where it may not be.

**It is not.** The argument is mechanical, in three steps:

1. **The picture is already on screen, for free, per-node, always.** §5: the lane
   tile blits this node's own output FBO, which is the frame being encoded. Opening
   the dock is not what makes the picture available; it is available in the rack.
2. **A dock preview would be a second, smaller copy of the lane tile's subject**,
   drawn from the same FBO by the same seam. The card's preview is 200×150
   (`RecorderboxCard.svelte:550-551`); `VideoTileThumb` is 160×120
   (`module-shell-model.ts:250-252`). The delta is 40×30 px of the same image.
3. **The module's product is the FILE, not the picture** — and that is the exact
   discriminator that separates it from `videoOut`, whose `EXTENSION_BODY_ROLES`
   `why` reads *"the picture the whole module exists to produce"*
   (`face-rack-status-source.test.ts:218`). For videoOut the picture IS the
   product; for recorderbox the picture is the *input*, and the product is on disk.

⚠ **PARITY IS PRESERVED AND UPGRADED, WHICH IS THE ONLY REASON THIS IS ALLOWED
TO BE A DESIGN CHOICE.** Functional parity is a hard requirement and "we would
lose the preview" would not be an owner question, it would be a defect. The
preview affordance does not go away: it moves from *only while the card is
mounted* to *always, in the lane*. A player who never opens the dock has more
preview after this change than before.

**So the body is a lamp and a transport, and it is narrow.** Widest element is
the FILE row; the body sits comfortably at ~300 px and the plate sizes to content
via `width: max-content`.

`face-width-source.test.ts`'s `PLATE_FLOOR_EXEMPTIONS` is currently empty and
**recorderbox needs no entry**. The per-face content-vs-plate measurement in
`workflow-shell-faces.spec.ts` is the result-side check and this face is
comfortably inside it.

### 7.1 ⚠ THE SCREEN ON/OFF RULING APPLIES AND MUST BE EXEMPTED **BY NAME**

The fleet-standard preview-collapse toggle runs over `STRICT_FACES ∩ video defs`
(`video-face-screen-source.test.ts:70-73`, `:104-106`). recorderbox is
`domain: 'video'` (`recorderbox.ts:151`) and would be in `STRICT_FACES`, **so the
ruling reaches it** — this is not one of the audio-domain derivations
(`audioOut`, `samsloop`, `twotracks`, `spectrograph`) that fall out of scope.

A body with no preview canvas has no screen to switch. The face therefore needs a
named `NO_SCREEN_SWITCH` entry (`:57-68`) carrying its `why`:

> `{ type: 'recorderbox', why: 'a video SINK whose body is a transport, not a preview: the picture this module passes through is already painted per-node in the LANE TILE (domain video → VideoTileThumb, the same output FBO the encoder reads), so the body mounts no canvas and there is nothing for a SCREEN switch to collapse. ⚠ AND THE SWITCH WOULD BE ACTIVELY WRONG HERE even if a preview existed: the ruling requires SCREEN OFF to skip the PAINT and never the engine read, and on this module the engine read IS the encode — a switch a player reasonably reads as "stop showing me this" sitting on the one module where the pixels are being written to their disk is a hazard, not an affordance. The encode runs on the registry pump (node-recorder-registry) and is untouchable from any face control by construction.' }`

⚠ **The second half of that `why` is the teeth the brief asked for.** The ruling's
requirement — *SCREEN OFF must never stop the ENCODE* — is satisfied here **by
construction rather than by care**: the encode runs on the registry's own pump
with its own `acquireRenderLease`, and the card's rAF loop is preview-only and
says so (`RecorderboxCard.svelte:229-260`, *"a lease bypasses both gates — so a
recording node keeps rendering at full rate even with this card off-screen,
unmounted, or throttled"*). **There is no split to police because there is no
control that can reach the encode.** That is a stronger guarantee than a
correctly-ordered toggle, and it is the reason the exemption is safe.

---

## 8. RESTING TEXT — recorderbox is the module most likely to want a timecode, and it does not get one

`face-resting-text-source.test.ts` denies the SHAPE: every `ModuleFace` field
must carry a declared text ROLE in `FACE_FIELDS`, and the permitted roles are
exhaustively module NAME, TAB/SECTION labels, CONTROL CAPTIONS and
OPTION/LANDMARK NAMES.

| card text | line | face | why |
|---|---|---|---|
| `REC 04:12` (running elapsed) | `:558` | ⚠ **REMOVED as text** → `StatusLed` `detail` → `aria-label`/`title` | a running duration is the purest form of the refused shape |
| `SAVING…` | `:562` | **REMOVED as text** → a second `StatusLed` whose CAPTION is the static literal `SAVING` and whose lamp is the state | a state word painted as text is refused; a static caption + a lamp is the permitted form |
| the folder NAME | `:588-592` | **REMOVED as text** → the button's `title` + `aria-label` | a filesystem path is derived state, not an option name |
| `saved RECORDING-002-….mp4` | `:641` | **REMOVED** → folded into the REC lamp's `detail` | a filename is derived state |
| the FILE field's contents | `:571-578` | **KEPT** — it is an `<input value>`, the user's own typed text in the control they typed it into, not a readout | an editable field is not resting derived text |
| `HIGH` / `BALANCED` / `SMALL` | `:616` | **KEPT** — option NAMES on a `selector`, the permitted role | §6.3 |
| `no H.264 encoder available` | `:634` | **KEPT** — a capability outcome, transient/conditional | picturebox §7's rule: an outcome the user must see is not a readout |
| the recover row's chunk name | `:651` | **KEPT** in the body | a per-row NAME identifying which take a Save button saves — the `control-caption` role in substance, and a recovery list whose rows do not say what they are is not a recovery list |

`StatusLed` is the positive form and it fits this module better than any other in
the wave (`StatusLed.svelte:1-42`): a static caption, a boolean lamp that IS the
picture, `detail` reaching `aria-label`/`title` and never a text node. Its own
header notes there is **no `value` prop**, by design, and that adding one is an
edit to a gated file.

The proposed `detail` string, so it is reviewable rather than left to the build:

```
REC   lit:  `recording, 04:12 elapsed, chunk 2, BALANCED, saving to Takes`
      dark: `not recording`
SAVING lit: `finalizing the take — writing the last fragments`
      dark: `idle`
```

⚠ **DELETING A READOUT DELETES A FINDING — here is the one that loses its
surface.** The `REC mm:ss` timecode is currently the only place a performer can
see **how long the take has run**, and unlike most deleted readouts it has no
arithmetic behind it that a unit test could keep honest — it is `fmtElapsed` over
`nodeRecorder.view(id).elapsed` (`:112-114`, `:525-531`), a pure clock. What
lapses is not a computation but a *performance affordance*: knowing you are two
minutes from the ~10-minute chunk roll. It survives in `aria-valuetext`/`detail`,
which is speakable and assertable but unpainted, and **every e2e assertion that
reads it must move to `aria`** (§12) — no assertion is weakened by the move.

⚠ **`persistentReadout=false` is not an option here.** The prop is deleted and
refused by name; a hover reveal is "there but hidden".

---

## 9. `EXTENSION_BODY_ROLES` — **`status-primitive`**, the roster's second non-picture body

`face-rack-status-source.test.ts:142` declares `type BodyRole = 'picture' | 'status-primitive'`,
and `:695` asserts the role set is **exactly** `['picture','status-primitive']`.

⚠ **CORRECTION TO THE BRIEF THAT COMMISSIONED THIS SPEC.** It named a third role,
`control-grid`, *"added by #2184"*. **On `ea2e06340` that role does not exist**:
the union at `:142` has two members and the both-directions anchor at `:695`
would redden if a third appeared. Either #2184 is not in this tree or the role
was named differently. **This spec is written against the two-role union, and the
build lane must re-read `:142` before writing the entry** — if `control-grid` has
landed by then, the reasoning below is unaffected (recorderbox mounts no control
*grid* either).

The predicate (`:481-489`):

```ts
'status-primitive': {
  holds: (src, extId) => /StatusLed/.test(src) && !paintsCanvas(src, extId),
  …
}
```

**Both halves hold for the proposed body**: it imports `StatusLed` (§6.4) and it
mounts no `<canvas>`, directly or through a component it renders (§7 — the
preview is deliberately not there).

⚠ **The two roles are mutually exclusive and the choice is therefore load-bearing,
not a label.** `picture` requires a canvas; `status-primitive` requires *no*
canvas. A body that kept a preview **and** used `StatusLed` would be legal — as
`picture`, since that role does not forbid the primitive — so **no new role is
needed under either design.** This spec did not invent one, and did not need to.

The entry to commit:

> `recorderbox: { role: 'status-primitive', why: 'the RECORDER TRANSPORT: the REC and SAVING lamps, the FILE name field, the destination-folder picker and the crash-recovery rows. The second non-picture body in this roster after cvBuddy, and it is a DELIBERATE ABSENCE rather than a module with nothing to show — this is a video SINK whose passthrough FBO is already painted per-node by the LANE TILE (domain video → VideoTileThumb, the same buffer the encoder reads), so a body preview would be a 40×30 px-smaller second copy of a picture the player already has, and the ruling puts the burden of proof on the wide face. ⚠ WHAT IT PAINTS AS TEXT IS EXHAUSTIVELY: the two static StatusLed captions (REC, SAVING), the control captions FILE / SIZE / DIR, the .mp4 suffix, the selector option names HIGH/BALANCED/SMALL, and — only when a previous take was left mid-flight — one chunk NAME per recovery row, which identifies which take a Save button saves. ⚠ NOTHING DERIVED IS PAINTED: the running mm:ss elapsed, the destination folder name and the last-saved chunk name are all on aria-label/title via StatusLed detail and button titles, never in a text node. ⚠ AND THE ELAPSED TIMECODE IS THE POINT: a recorder is the surface that most wants a running clock, and the resting-text ruling refuses one, so this entry is the record that the refusal was deliberate and where the number went. ⚠ NO SCREEN SWITCH — carried as a NAMED NO_SCREEN_SWITCH entry rather than derived out, because unlike audioOut/samsloop/twotracks/spectrograph this module IS domain video and the ruling really does reach it: there is no canvas to collapse, and a switch here would sit on the one module whose pixels are being written to the user\'s disk. The encode is unreachable from any face control by construction — it runs on node-recorder-registry\'s own pump under an acquireRenderLease that bypasses both preview gates.' }`

---

## 10. VRT — a baseline exists, it is MASKED, and the idle state is deterministic

* `e2e/vrt/__screenshots__/vrt.spec.ts/recorderbox.png` — **exists**, the
  platform-agnostic per-type name.
* `recorderbox` is **not** in `EXEMPT_FROM_VRT` and **not** in
  `ALLOWED_PERMANENT_EXEMPT` — it is under full card VRT coverage today.
* ⚠ **It carries a canvas mask** (`vrt-exemptions.ts:118-124`):
  `{ selector: 'canvas', why: 'a live preview canvas blitted off the engine clock, plus a hidden off-screen full-res capture canvas; the title, handles, FILE field and RECORD button are the gate.' }`

⚠ **The mask's `why` is the THIRD place in the tree carrying the stale
"card-owned capture canvas" claim** (after the inventory `why` and the card's own
header — D1, D3). *"a hidden off-screen full-res capture canvas"* describes what
`RecorderboxCard.svelte:93-96` explicitly says is no longer there. The mask
itself stays correct and necessary — the **preview** canvas is genuinely live —
so this is a comment fix, not a behaviour change.

### 10.1 WHAT THE IDLE DOCK BASELINE PAINTS, AND WHY IT IS DETERMINISTIC

The brief asked this directly. On a fresh spawn:

| element | idle state | deterministic? |
|---|---|---|
| REC lamp | **dark**, caption `REC` | ✓ static |
| SAVING lamp | **dark**, caption `SAVING` | ✓ static |
| FILE field | `recording` (the default, `:85`) | ✓ static |
| DIR row | button reads `PICK` (no folder yet) | ✓ static |
| SIZE selector | `BALANCED` (the owner default, `:87-88`) | ✓ static |
| RECORD toggle | off | ✓ static |
| recover block | **absent** — `recoverable.length === 0` after a clean boot | ✓ absent |
| capability badges | ⚠ **runner-dependent** — see below | ⚠ |

⚠ **ONE HAZARD, AND IT IS REAL.** The `no H.264 encoder available` badge is gated
on `probeEncoders()` (`:505-511`), and `recorderbox.spec.ts:14-21` records that
**CI's headless software runner reports avc as config-supported yet emits ZERO
chunks**, while a dev Mac with a hardware encoder does not show the badge at all.
So the badge's presence is a property of the *machine*, and a dock baseline that
captured it would be a per-machine baseline — the one thing the suite cannot have.

**The linux CI capture is the authority** (`snapshotPathTemplate` has no
`{platform}` segment; the baseline is written by the `vrt-update.yml` job on
ubuntu-latest), so whatever ubuntu-latest probes is what gets pinned — and it is
stable *for that machine*. The requirement on the build lane is therefore not
"suppress the badge" but **"confirm the captured PNG matches what ubuntu-latest
renders, and never judge it from a local macOS run"**, which is the standing rule
anyway. If it proves unstable *within* CI, the honest answer is a `simPin`-style
pin on the probe result (the `loopback` / `cameraInput` precedent,
`_shell-faces.ts:3121-3140`), **not** a `FACES_WITHOUT_SCENES` exemption — the
rest of this face is static chrome and is exactly the kind of surface baselines
are good at.

**recorderbox does NOT need a `FACES_WITHOUT_SCENES` entry.** Compare tvLibrarian,
which does (see that spec §10) — the two modules diverge here as sharply as
anywhere.

### 10.2 THE PROCEDURE, IN ORDER

1. **Predict the file count**: one moved (`recorderbox.png`, if `vrt.spec.ts`
   still covers a promoted type) plus two added (`face-recorderbox-compact.png`,
   `face-recorderbox-dock.png`).
2. Dispatch **scoped**: `GREP=recorderbox flox activate -- task vrt:commit`. A bare
   dispatch on a face PR derives FULL, because every face PR touches a shared
   roster file whose path names no module.
3. **Count what the bot commits against the prediction.** A green dispatch that
   committed nothing is a RED FLAG, not a pass.
4. If `recorderbox.png` is stale-but-passing, `git rm` it first — then ⚠ **`git status`
   for untracked PNGs after the next VRT run**, because a `git rm`-ed baseline is
   silently recreated as an untracked file no gate reads.
5. Never commit a PNG by hand.

---

## 11. COST

### 11.1 ⚠ WEBGL ATTEST — ELEVEN BASIS FILES, THE LARGEST IN THE WAVE

```
flox activate -- bash scripts/webgl-attest-hash.sh --list | grep -i recorderbox
  packages/web/src/lib/video/modules/recorderbox.ts
  packages/web/src/lib/video/recorderbox-audio-ring.ts
  packages/web/src/lib/video/recorderbox-capture-drain.ts
  packages/web/src/lib/video/recorderbox-cfr.ts
  packages/web/src/lib/video/recorderbox-chunk-name.ts
  packages/web/src/lib/video/recorderbox-quality.ts
  packages/web/src/lib/video/recorderbox-recorder.ts
  packages/web/src/lib/video/recorderbox-save-flow.ts
  packages/web/src/lib/video/recorderbox-store.ts
```

(9 by that grep; `recorderbox-cfr-deficit` and `recorderbox-roll-audio-gap` are
test-only. The basis is 218 files total, essentially every
`packages/web/src/lib/video/**` file plus the cube/wavesculpt pair and the
toolchain manifests.)

⚠ **This is a real, measurable cost difference against tvLibrarian's three
files**, and it changes how the PR must be shaped:

> **A recorderbox face PR that adds ONLY `face` to `recorderbox.ts` costs ZERO
> GPU. Any other edit to any of those nine files costs a real-machine re-attest
> that CI (SwiftShader) cannot run.**

`HASH_TRANSPARENT_PROPS` is `['docs', 'controlFamilies', 'face', 'noUserControl']`
(`scripts/attest-code-basis.ts:96-109`), and a def's top-level `face` is stripped
— but ⚠ a **nested** `face:` is not, only a def's own top-level one.

**Consequences for this build, and they are the reason §3.3 insists on the
directory:**

* the §3.3 transport extraction goes in `lib/ui/modules/`, **not** `lib/video/`,
  following `recorderbox-present-policy.ts:14-17` verbatim. Zero attest.
* the §2 `LOCAL_ORIGIN` fix is in `RecorderboxCard.svelte`, which is **not** in
  the basis (the only cards in it are `WavesculptCard.svelte` and
  `cube/CubeVizSurface.svelte`). Zero attest.
* the §10 mask-comment fix (D3) is in `e2e/vrt/vrt-exemptions.ts` — not in the
  basis, and a comment besides. Zero attest.
* **recorderbox has no params, so there is no range-binding question at all** —
  the `paramSpec` vs `*_RANGE` decision (`module-faceplates.md` §"On a card whose
  def is in the WEBGL ATTEST BASIS") **does not arise on this module.** Recorded
  because it arises sharply on tvLibrarian, and the difference between the two
  is exactly the kind of thing a wave summary flattens.

⚠ Verify by running `scripts/webgl-attest-hash.sh` **against the merged tree**
before and after, and confirm the hash is unmoved. An attest pin covers a TREE,
not a PR: if `main` moves a basis file under you, your hash changes without your
diff changing. Never measure attest state in a dirty primary checkout.

### 11.2 ART — ZERO, measured

* `ls art/baselines/` — **no `recorderbox/` directory**.
* The audio profile gate enumerates **audio-domain ids only**
  (`art/scenarios/_meta/audio-profile-gate.test.ts:39-47`, matching
  `/^(\S+) meta domain=audio\b/` off the contract golden). recorderbox is
  `domain: 'video'`, so the gate never sees it and it needs no `ART_EXCLUDED` /
  `ART_BACKLOG` entry.

**`art/` should be absent from this diff.**

### 11.3 CI WALL-TIME

New: two VRT face captures (they ride the scoped `vrt:commit` dispatch, not the
PR's CI lane), one new unit file (`recorderbox-face-model.test.ts`), and one new
unit file for the extracted transport (`recorderbox-transport.test.ts` — pure,
node-env, no GL/DOM, following `recorderbox-present-policy.test.ts`).

⚠ `recorderbox.spec.ts` already sets `test.setTimeout(120_000)` and drives a real
ACIDWARP + real encode chain; **this PR must not add to it.** The face assertions
belong in the existing shell-faces sweep rows, which already run.

**Estimated PR delta: well under 2 minutes**, under the sign-off bar.

### 11.4 THE PUSH 2 CARD

recorderbox declares `params: []`, so it has no push card to re-rank and no
`PUSH_CARD_CONTROLS` entry to collide on. **Nothing moves.** (Contrast the
picturebox case, where declaring `noUserControl` silently re-ranked the card.)

---

## 12. THE e2e SURFACE

`recorderbox` **is** in `_face-fixtures.ts`'s `DENIED` map — it is named there
alongside `audioIn`, `audioOut`(deleted), `twotracks`(deleted), `cameraInput`,
`archivist`, `peertube`, `doom`.

⚠ **THE audioOut / twotracks LESSON APPLIES DIRECTLY TO THIS PR.** That file's own
header records it twice (`_face-fixtures.ts:60-96`): a DENIED entry for a module
that gets PROMOTED does not go red — it goes **invisible**, because promotion
moves the module out of `unpromoted`, the population the record filters. Both
prior entries had to be **deleted by hand**, and the second was factually wrong
by the time anyone looked.

**So: delete recorderbox's `DENIED` entry in this PR, by hand, and say so in the
PR body.** Do not leave it to go quiet.

Specs that drive card testids and need re-pointing:

| spec | subject | disposition |
|---|---|---|
| `recorderbox.spec.ts` | the REAL source chain: ANALOG VCO → `audio_l`, ACIDWARP → `in`, record ~2.5 s, assert a parseable fragmented MP4 in OPFS **and** that a truncated copy is still parseable | ⚠ **the crown jewel — do not disturb its gating.** It gates on *chunks actually emitted*, not `isConfigSupported`, precisely because CI false-positives. Selector edits only. |
| `recorderbox-recover-reachable.spec.ts` | the crash-recovery prompt is reachable | re-point at the body's recover block |

Testids the body must re-emit where the affordance survives: `recorderbox-preview`
(⚠ **not** re-emitted — §7; its assertions move to the lane thumb),
`recorderbox-filename`, `recorderbox-folder`, `recorderbox-change-folder`,
`recorderbox-quality`, `recorderbox-record`, `recorderbox-no-encoder`,
`recorderbox-no-opfs`, `recorderbox-recover`, `recorderbox-recover-save`,
`recorderbox-recover-discard`.

⚠ **`recorderbox-rec-indicator` should NOT be re-emitted.** It names a text
element that no longer exists as text (§8). Its assertions move to the `REC`
`StatusLed`'s `data-testid` + `data-lit` + `aria-label`, which is what every spec
proving a face tracks state already reads. `recorderbox-chunk-status` likewise.

---

## 13. ⚠ THE CONVERGENCE QUESTION — recorderbox DOES NOT JOIN THIS COHORT, AND THE TREE ALREADY SAYS SO

The wave's headline claim is that six modules converge on one media-controller
shape. **recorderbox falsifies it**, and not by a matter of degree.

**Every other module in this cohort is a SOURCE.** `archivist`, `peertube`,
`tvLibrarian`, `videobox`, `videovarispeed`, `toybox`, `audioIn` all bring pixels
or samples INTO the graph from outside it. recorderbox takes them OUT. It is the
only sink in the set, and every design answer follows from that one fact:

| question | the five source modules | recorderbox |
|---|---|---|
| what the body shows | a player / a roster / a preview | **a transport and two lamps** |
| `EXTENSION_BODY_ROLES` | `picture` | **`status-primitive`** |
| width | earned by a live picture | **not earned** (§7) |
| the media element | a card-owned `<video>`/`<img>` handed to the engine | **none — it reads the engine's own FBO** |
| `HEADLESS_MOUNT_LANE_TYPES` | members (via `DOM_SOURCE_LANE_TYPES`) | **not a member, correctly** (§0.3) |
| the `needs-media-controller` tax | the headless host keeps the real card alive off-screen | ⚠ **a different tax entirely** — §14 |
| params | 1-3 | **zero** |
| what the lane picture is | the module's product | **the module's INPUT** |

**Its nearest neighbour in the entire fleet is `videoOut`** — also
`domain: 'video'`, also `order: []`, also a terminal sink with a passthrough-ish
preview, and named in `module-face-lint.test.ts:3042` in the same breath as
`flipper` as the canonical zero-rank shape. The two differ on exactly one axis
and it is the axis that decides the body role: **videoOut's product is the
picture, recorderbox's product is a file on disk** (§7).

⚠ **AND THE INVENTORY'S OWN BLOCKER FIELDS ALREADY CUT THE COHORT A DIFFERENT
WAY THAN "MEDIA".** Read across the six:

| module | `blockers` | line |
|---|---|---|
| `archivist` | `needs-media-controller`, **`needs-note-entry-cell`** | `:637` |
| `peertube` | `needs-media-controller`, **`needs-note-entry-cell`** | `:948` |
| `recorderbox` | `needs-media-controller`, **`needs-note-entry-cell`** | `:1029` |
| `toybox` | `needs-media-controller`, **`needs-note-entry-cell`** | `:1066` |
| `tvLibrarian` | `needs-media-controller` only | `:1075` |
| `videobox` | `needs-media-controller` only | `:1111` |
| `videovarispeed` | `needs-media-controller` only | `:1120` |

**The second blocker splits the set on TYPED TEXT, not on media** — and it puts
recorderbox in a group with the two query browsers *because of its FILENAME
field*, while leaving the three players out. So the cohort is at least two
cross-cutting populations already, and neither of them is "the media controller
shape":

* **typed text** (`archivist`, `peertube`, `recorderbox`, `toybox`) — needs a
  short-text field the cell vocabulary does not have;
* **card-owned media element** (`archivist`, `peertube`, `tvLibrarian`,
  `videobox`, `videovarispeed`) — needs the headless host.

**recorderbox is in the first and not the second. tvLibrarian is in the second and
not the first.** The two modules this agent was given are on opposite sides of
both cuts, which is presumably why they were given together.

**Concrete answer to the brief's question**, stated as shapes rather than as a
verdict:

* **recorderbox wants**: `face.order: []`, cells `['quality','record']`
  (`selector` + `toggle`), `fullViewBody` role **`status-primitive`**, no lane
  registry, no headless host, a **`NO_SCREEN_SWITCH`** entry, and a transport
  extraction. Registry: `node-recorder-registry` (exists) + a new
  `recorderbox-transport.ts` front door.
* **the file players want**: a `picture` body over a card-owned `<video>`, the
  headless host, and transport cells over `params`.
* **the query browsers want**: a `picture` body **plus a typed-query surface the
  cell vocabulary cannot express**, which is what `needs-note-entry-cell` names.

**These are three shapes, not one.** recorderbox shares the typed-text problem
with the browsers and shares nothing else with anyone.

---

## 14. THE `needs-media-controller` TAX — recorderbox PAYS A DIFFERENT ONE, AND IT IS THE ONLY MODULE IN THE WAVE THAT DOES

The blocker is real and outstanding: its probe is
`tree.cardOwnedSourceTypes.length === 0` (`face-migration-inventory.ts:207`),
i.e. `HEADLESS_MOUNT_LANE_TYPES` is empty, and it is not — `DOM_SOURCE_LANE_TYPES`
still has seven members and `HeadlessSourceHost.svelte` still exists.

⚠ **#1511 is CLOSED (COMPLETED, 2026-08-23) and its acceptance is NOT met.** The
inventory says so itself (`:622-628`): *"'the last blocked module shipped' and
'the blocker resolved' are different facts and only the first one happened."*

⚠ **The blocker does not block a face, and that is settled on `main`.**
`cameraInput` and `loopback` both shipped faces with it outstanding by paying the
headless-host tax (`dom-source-modules.ts`, the cameraInput lineage note;
`face-migration-inventory.ts:378-385` — *"a card-owned-source module CAN be faced
while that blocker is outstanding, by paying the headless-host tax and rebuilding
the card-only affordances. It is the SECOND module to pay both halves."*).

**This spec proposes no platform capability, and does not ask for one.**

**recorderbox's tax, stated exactly:**

> **It cannot pay the headless-host tax, because it is not eligible for the
> headless host** — it matches none of the three derived seams (§0.3) and hand-adding
> it to `HEADLESS_MOUNT_LANE_TYPES` is forbidden by that file's own derivation rule.
> **Its tax is the §3.3 EXTRACTION**: the record transport, the encoder-support
> probe and the crash-recovery scan move off the card into
> `lib/ui/modules/recorderbox-transport.ts` (node-keyed, `lib/ui`-resident so it
> stays out of the attest basis), and the card is rewritten to call the same
> functions the face calls. Roughly 4 h and one careful review, paid once.

⚠ **And it is the CHEAPER tax, which is worth saying because it reads like the
harder one.** The headless host is a *permanent* cost — cameraInput and loopback
pay it on every rack, forever, by keeping a real card mounted off-screen for the
life of the session. recorderbox's extraction is paid once and then the module is
genuinely card-free: after it, recorderbox satisfies `needs-media-controller`'s
*capability* description (*"a node-scoped controller instead of by a mounted
`<X>Card.svelte`"*) even though it never counted toward the probe.

⚠ **That is a finding about the blocker, not just about this module: a module can
fully satisfy what `needs-media-controller` DESCRIBES while being invisible to
what it MEASURES.** The probe counts `HEADLESS_MOUNT_LANE_TYPES` membership, which
is derived from three source-shaped seams; a sink that does the right thing was
never in the numerator or the denominator. **No change is proposed** (the
no-new-gates ruling stands, and nothing is broken) — but the inventory's `why`
should stop asserting the opposite, which is D1.

---

## 15. DEFECT LEDGER — live on `main`, independent of any face

Each is fixed **inside this PR** unless marked otherwise; there is no issue to
file (owner ruling), and the PR narrative is the searchable record.

| # | defect | evidence | routing |
|---|---|---|---|
| **D1** | ⚠ **`face-migration-inventory.ts:1029-1034`'s `why` describes a FIXED P0 in the present tense.** *"the capture canvas plus its per-frame encode loop live on the card, so the recording exists only while it is mounted"* — all three clauses false since #1574 (`bdef392f6`). It is the only statement on record about this module's media lifetime and it points at the opposite of the truth. | `RecorderboxCard.svelte:92-96`, `:106-111`, `:257-260`, `:514-522` | **fix in this PR** — rewrite the `why` to describe the registry. ⚠ `blockers` stays: `needs-media-controller`'s probe is genuinely still false. The tax changes (§14), not the membership. |
| **D2** | ⚠ **`dom-source-modules.test.ts` is structurally blind to a CONSUMING card.** Its three seams all describe a card that hands the engine a source or pushes pixels in; a sink can never match. So recorderbox's absence from both sets proves nothing about its lifetime discipline, and a revert of #1574 would keep the gate green. | `dom-source-modules.test.ts:79`, `:319`, `:329`; stated scope `:33-35` | ⚠ **NOT this PR — no fix proposed.** Nothing is broken today and the no-new-gates ruling stands. Recorded so the next reader does not repeat the inference. D1's fix is what actually prevents it. |
| **D3** | ⚠ **The same stale claim in two more places.** `RecorderboxCard.svelte:8-10`'s own header still describes *"A HIDDEN capture `<canvas>` at the engine's native resolution that the recorder encodes (we draw the engine canvas into it each rAF while armed)"* — **contradicted 85 lines later by `:93-96`, in the same file.** And `vrt-exemptions.ts:118-124` repeats it in the mask's `why`. | direct read | **fix in this PR** — comment-only, and `RecorderboxCard.svelte` is not in the attest basis. Zero cost. |
| **D4** | ⚠ **All three `node.data` writes are un-undoable.** `setData` is a bare proxy write: no `ydoc.transact`, no `LOCAL_ORIGIN` (zero occurrences of the token in the file). `filename`, `quality` and **`recording`** all bypass the undo stack. | `RecorderboxCard.svelte:144-151`; `mutate.ts:13-18`; `store.ts:70` | **fix in this PR** — §2 |
| **D5** | **The transport, the encoder probe and the crash-recovery scan are card-lifetime.** Not a defect *today* (the button is on the card, so the card is mounted when it is pressed) — but it is the precursor, and it is the wave-5 §6 class that the STOP-2 grep is blind to. | `:264-272`, `:503-513` | **the PRECURSOR** — §3.3, extract first |
| **D6** | ⚠ **`_face-fixtures.ts`'s `DENIED` entry will go INVISIBLE, not red, on promotion** — the third instance of a class that file's header already documents twice (audioOut, twotracks). | `_face-fixtures.ts:67-96` | **fix in this PR** — delete the entry by hand and say so in the PR body |

---

## 16. TASTE CALLS, EACH WITH ITS ONE-LINE REVERT

| call | revert |
|---|---|
| no preview in the body (§7) | mount the preview canvas and flip the role to `picture`; drop the `NO_SCREEN_SWITCH` entry and add a SCREEN toggle |
| `record` is a `toggle`, not an `action` | swap the cell kind and add `probe: { effect: { kind: 'data', key: 'recording', expect: 'changed' } }` |
| the recover block sits at the TOP of the body | move it below the transport |
| two lamps (`REC`, `SAVING`) rather than one three-state lamp | collapse to one `StatusLed` and put the phase in `detail` |
| no tab rail | — (adding one needs an owner instruction; `face.tabbed` is not a build-lane decision) |

---

## 17. MUST-VERIFY (before the face is written)

* **M1 — the transport really is card-lifetime (§3.2).** On `main`, dock a
  recorderbox, press RECORD, then collapse the dock. Confirm the take **continues**
  (that is #1574, and it is what makes §0's verdict (a)). Then, separately,
  confirm that with **no** card mounted anywhere a write to `node.data.recording`
  starts **nothing** — drive it from a second peer or from the store directly.
  ⚠ Both directions, because "it started" and "we never looked" are
  indistinguishable from one reading. **This is the experiment that sizes the
  precursor; do not skip it because the source reads clearly.**
* **M2 — the lane picture actually paints the recorded frame.** With a live source
  patched into `in`, read the promoted lane tile's thumb and assert non-black;
  with nothing patched, assert it matches the module's idle field. Both
  directions. This is what §7's parity argument rests on, and it is the single
  claim that would sink the design if false.
* **M3 — the zero-param face lints.** Run `module-face-lint.test.ts` and confirm
  `order: []` is accepted and that the lane-tile gate skips it at `:3042`. Drive
  the negative control too: add a ranked param and confirm the gate can still
  fail.
* **M4 — the attest hash is unmoved** on the merged tree, per §11.1. Run it
  before and after; do not spend the GPU.
* **M5 — `EXTENSION_BODY_ROLES` still has two roles** (`face-rack-status-source.test.ts:142`,
  `:695`). If `control-grid` has landed by build time, re-read §9 before writing
  the entry.
* **M6 — the memory claim.** This project's memory says *"Recorderbox capture fix —
  wiring + owner hw-verify remain"*. ⚠ **Checked against the tree and it is STALE
  as to the wiring**: `#1574`/`#1584` (`bdef392f6`) landed the node-keyed registry,
  `#1802`/`#1846` landed the preview gating and the downscale fix, and
  `recorderbox.spec.ts` drives the real chain end-to-end with a real-encode gate.
  **The owner hardware verification is the part that cannot be confirmed from the
  tree** and this spec does not claim it. Do not repeat the wiring half as fact.

---

## 18. VERIFICATION GATE

```bash
# 1. the face model + its permanent negative controls
flox activate -- npx vitest run packages/web/src/lib/ui/workflow/recorderbox-face-model.test.ts

# 2. the extracted transport (the precursor), pure/node-env
flox activate -- npx vitest run packages/web/src/lib/ui/modules/recorderbox-transport.test.ts

# 3. face lint + the promotion anchor (both directions), incl. the zero-rank arm
flox activate -- npx vitest run packages/web/src/lib/ui/workflow/module-face-lint.test.ts

# 4. the rulings' source gates — ALL FOUR, and #3 is the one this face turns on
flox activate -- npx vitest run \
  packages/web/src/lib/ui/controls/face-readout-source.test.ts \
  packages/web/src/lib/ui/controls/status-led-source.test.ts \
  packages/web/src/lib/ui/workflow/video-face-screen-source.test.ts \
  packages/web/src/lib/ui/workflow/face-resting-text-source.test.ts \
  packages/web/src/lib/ui/dock/face-width-source.test.ts

# 5. the roster gate that owns the body role + `why`
flox activate -- npx vitest run packages/web/src/lib/ui/workflow/face-rack-status-source.test.ts

# 6. the registries + the shared-file neighbours
flox activate -- npx vitest run \
  packages/web/src/lib/ui/workflow/shell-extensions.test.ts \
  packages/web/src/lib/ui/workflow/shell-cells.test.ts \
  packages/web/src/lib/ui/workflow/face-migration-inventory.test.ts \
  packages/web/src/lib/ui/workflow/dom-source-modules.test.ts \
  packages/web/src/lib/ui/modules-card-map.test.ts

# 7. the module's own suites — recorderbox has real coverage; run ALL of it
flox activate -- npx vitest run packages/web/src/lib/video/ -t recorderbox
flox activate -- npx vitest run packages/web/src/lib/ui/modules/recorderbox-present-policy.test.ts
flox activate -- npx vitest run packages/web/src/lib/ui/modules/node-recorder-registry.test.ts
#    ⚠ recorderbox has ~10 sibling unit files under lib/video/. That population is
#    itself evidence the logic moved OFF the card (§0). Run the lot.

# 8. e2e — selector moves only; do NOT touch the real-encode gating
flox activate -- task e2e:one -- recorderbox
flox activate -- task e2e:one -- recorderbox-recover-reachable
#    ⚠ Flake-check anything changed 3x:  REPEAT=3 flox activate -- task e2e:one -- recorderbox

# 9. docs contract — the def gains `face`, so re-pin and READ the diff
flox activate -- task docs:accept && flox activate -- git diff packages/web/src/lib/docs/contract-lock.txt
#    ⚠ EXPECT AN EMPTY DIFF. `face` is not the I/O contract. A non-empty diff means
#    something changed a port or a param — stop and read it.

# 10. typecheck LAST — vitest is lenient where svelte-check is strict
flox activate -- task typecheck

# 11. VRT: dispatch only, SCOPED, and COUNT the files (§10.2). NEVER commit a PNG.
GREP=recorderbox flox activate -- task vrt:commit

# 12. attest: NIL if the diff respects §11.1. Confirm the hash is unmoved.
flox activate -- bash scripts/webgl-attest-hash.sh
```

---

## 19. VERDICT, RISK, ESTIMATE

**PROMOTE-WITH-PRECURSOR.**

The face itself is the simplest in the wave — zero params, two cells, a lamp and
a transport, no tab rail, no width to justify, no lane registry, and a lane
picture that comes free with `domain: 'video'`. What gates it is one honest piece
of work: **the record transport, the encoder probe and the crash-recovery scan
must come off the card first (§3.3), because recorderbox is the one module in
this cohort with no headless host to fall back on.**

**What unblocks it:** `packages/web/src/lib/ui/modules/recorderbox-transport.ts`
— a node-keyed front door for `node-recorder-registry`, called by both the card
and the face. ≈ 4 h, in `lib/ui/` so it costs no attest. Nothing else. No
platform capability, no new cell kind, no new body role, no gate change.

**Risk: MEDIUM-HIGH**, and all of it is in one place rather than in the design:

1. ⚠ **The precursor touches the code path that writes the user's file.** A
   mistake there loses a take, and the module's own history (#1574 was a P0 for
   exactly that) says this area punishes carelessness. It wants its own PR, its
   own review and M1 run in both directions.
2. **The attest basis is nine files wide.** A stray edit into `lib/video/` turns a
   free PR into one needing a real-GPU window. §11.1's directory rule is not
   optional and the module's own `recorderbox-present-policy.ts` already states it.
3. Low, but named: the capability badge is machine-dependent, so the dock baseline
   must be judged from the linux capture only (§10.1).

**Estimate: ≈ 13 h**, as **PR 1 (the precursor) ≈ 5 h** (the extraction, its unit
test, the D4 `LOCAL_ORIGIN` fix, the card rewired to call it) and **PR 2 (the
face) ≈ 8 h** (def `face`, the body, the two cells, the `NO_SCREEN_SWITCH` entry,
the `EXTENSION_BODY_ROLES` entry, the D1/D3/D6 documentation fixes, the e2e
selector moves, the face-model unit, and one VRT dispatch).

**Build it LAST in this cohort.** It is the only one needing a precursor, the only
one whose PR must be split, and — per §13 — the only one whose answers do not
transfer to any sibling. Building it first would invite the wave's shape to be
generalised from the module that does not fit it.
