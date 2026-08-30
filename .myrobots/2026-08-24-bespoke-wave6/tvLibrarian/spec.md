# FACEPLATE BUILD SPEC — `tvLibrarian` (video, the STATION TUNER)

**SPEC ONLY. Nothing here is implemented.** Mockups: [`dock.html`](dock.html) ·
[`dock-tuned.html`](dock-tuned.html).

Method: analyse what the module is FOR, then author the spec, then build from the
spec. Every claim below carries the file and line it was measured from, and the
ones that were *checked and came back different from the rule* are marked ⚠ and
kept rather than quietly corrected — the correction is the finding.

Measured on `ea2e06340`.

---

## 0. THE CONSTRAINT MAP, READ FIRST

| constraint | tvLibrarian's answer | measured at |
|---|---|---|
| `NON_SHELL_LANE_TYPES` | **NOT a member** | `legacy-fallback.ts:96-112` |
| `DOM_SOURCE_LANE_TYPES` | ⚠ **MEMBER** — so it gets `<HeadlessSourceHost>`; §3 | `dom-source-modules.ts:89-97` |
| `HEADLESS_MOUNT_LANE_TYPES` | **MEMBER** (via the above) — the tax is paid, not avoided | `:219-222` |
| lane picture | **FREE, automatic, per-node** — `domain: 'video'` | `module-shell-model.ts:177-179`, `:237-240`; §5 |
| WebGL attest | ⚠ **THREE basis files**; the face edit is hash-transparent, the `gain` fix is not | §11.1 |
| ART | none — video domain is outside the audio profile gate | §11.2 |
| VRT | ⚠ **PERMANENTLY EXEMPT — no baseline exists and none can be captured naïvely** | `vrt-exemptions.ts:895`, `:1180`; §10 |
| shell extension slot | `fullViewBody`. Never `editorSurface` | `shell-extensions.ts:118`, `:124` |
| tab rail | **NO** — one ranked control; §6.2 | `dock-tabs-model.ts:101` |
| `node.data` writes / Cmd-Z | ⚠ **MIXED WITHIN ONE FILE** — two tagged, one not; §2 | `TvLibrarianCard.svelte:168`, `:185`, `:448-453` |
| `EXTENSION_BODY_ROLES` | **`picture`** | §9 |
| params | 3 — one INERT (§1.1), two synthetic (§1.2) | `tv-librarian.ts:139-143` |
| STRICT_DOCS | already a member | `strict-docs.ts:366` |

### 1. WHAT THE MODULE IS FOR

A television, in the video graph, tuned to a real station somewhere in the world.

Pick a country — by clicking a 2D equirectangular world map that snaps to the
nearest country centroid with channels, or from a dropdown — then pick a channel
from that country's list. The card attaches its HLS `.m3u8` to a crossorigin
`<video>` via hls.js; the engine samples that element into a WebGL framebuffer
through a straight passthrough shader, so `video` is *"a genuine
downstream-usable texture, not play-only"* (`tv-librarian.ts:147`). The stream's
audio splits to `audio_l`/`audio_r`. Two gate OUTPUTS fire on tune
(`channel_changed`, a trigger) and while playing (`stream_online`, a held gate),
and two gate INPUTS channel-surf hands-free — `next` advances, `random` rolls.

**What that means for the face:** the module is a PICTURE plus a ROSTER plus two
navigation gestures. The picture wants to be seen at every size; the roster is a
two-level browse (country → channel) that only makes sense with room; the
navigation is two buttons. That maps onto the lane-tile / dock-body split cleanly
— which is why this is a promote and not an argument. What it is *not* is
param-shaped: **`next` and `random` are, in the def's own words, "DOM-only, not
module params"** (`:147`).

### 1.1 ⚠ THE PRECURSOR — `gain` IS DECLARED, UNREACHABLE, AND INERT, AND A FACE IS THE FIRST SURFACE THAT WOULD EXPOSE IT

Three independent measurements, which together are the one hard finding on this
module:

1. **It is declared as a real, ranked-eligible param** —
   `tv-librarian.ts:140`:
   `{ id: 'gain', label: 'Gain', defaultValue: 1.0, min: 0, max: 2, curve: 'linear' }`.
2. **The card exposes no control for it.** `grep -n 'gain\|Knob\|Fader\|NeonFader' TvLibrarianCard.svelte`
   returns exactly one hit, at `:254`, and it is an unrelated comment about
   un-muting the media element. **There is no knob, no fader, nothing.**
3. ⚠ **The shader does not read it, and the def says so in its own docs**
   (`tv-librarian.ts:160`):

   > *"Gain — declared output-level param (0 to 2, linear; default 1.0). NOTE: the
   > passthrough shader does not currently read it (no uGain uniform / draw()
   > never applies it), so it is carried on the module but inert in v1 — it does
   > not yet brighten or scale the video output."*

Today this is harmless *because nothing surfaces it*. **A face changes that**,
because completeness is unconditional for a promoted def
(`module-face-lint.test.ts:339`):

```
if (!orderSet.has(p.id)) missing.push(`${def.type}: param '${p.id}' not in face.order`);
```

So a tvLibrarian face **must** rank `gain`, and ranking it paints a dial that
does nothing. That is CLAUDE.md's named class — *"a green gate certifying a live
bug"* — arriving by promotion. It is also the wave-5 §6 shape inverted: not a
defect the promotion deletes, but **a defect the promotion CREATES a surface
for**, and therefore one that cannot be scheduled separately.

⚠ **AND THE TEMPTING FIX PASSES THE GATE WHILE BEING FALSE.** The escape from
completeness is a def-level `noUserControl` entry (`module-face-lint.test.ts:330-338`),
whose `writer` is checked against the def's own ports in both directions
(`no-user-control.ts:111-126`):

* `writer: 'cv-port'` is **RED** — *"NO input port declares `paramTarget: 'gain'`
  — nothing writes it, so it is not CV-driven, it is dead"* (`:112-116`). Correct:
  tvLibrarian's only `paramTarget` inputs are `next`→`cv_next` and
  `random`→`cv_random` (`tv-librarian.ts:126-127`).
* `writer: 'internal'` is **GREEN** — the check is only that no port targets it
  (`:121-125`), and none does.

**So `{ param: 'gain', writer: 'internal', why: … }` would compile, pass
`no-user-control.test.ts`, satisfy face completeness, and be a lie**: nothing
writes `gain` internally either. The gate anchors on the PORTS, which is the
right anchor for the case it was built for, and it is structurally unable to ask
"does anything write this at all". Declaring `internal` here is the exact move
CLAUDE.md warns against — *"Before 'fixing' a declaration to satisfy a gate, check
the consumer reads it."*

**Three honest options, and the build lane must pick one explicitly in the PR
body:**

| option | cost | verdict |
|---|---|---|
| **(a) IMPLEMENT it** — add a `uGain` uniform to `FRAG_SRC` and apply it in `draw()` | edits `tv-librarian.ts`, which **is in the attest basis** → a real-GPU re-attest (§11.1) | ⚠ **RECOMMENDED.** It is a ~4-line shader change, the param already has a sane range and default, and every other video source in the fleet has a working output level. It makes the ranked cell honest. |
| **(b) DELETE the param** | a contract change → `contract-lock.txt` moves, `docs:accept`, and any saved rack carrying a `gain` value silently loses it | defensible but worse: it removes an affordance the def has always promised |
| **(c) `noUserControl: 'internal'`** | free, hash-transparent | ⛔ **REFUSED — it is false.** Recorded so it is not rediscovered as a shortcut. |

**This spec assumes (a)**, and §11.1 prices the attest window it costs.

### 1.2 THE TWO SYNTHETIC PARAMS — `noUserControl`, and here `cv-port` IS the legal value

`cv_next` and `cv_random` (`tv-librarian.ts:141-142`) are bridge-written caches:
the CV bridge writes the gate level, and the card polls `readParam` and
edge-detects a rising edge (`:161-162`). They are exactly picturebox's
`asset_pitch`/`asset_gate` shape, and the same declaration applies:

```ts
noUserControl: [
  { param: 'cv_next',   writer: 'cv-port', why: '…' },
  { param: 'cv_random', writer: 'cv-port', why: '…' },
],
```

* `'cv-port'` is the **only** legal value for each — `next` and `random` declare
  `paramTarget: 'cv_next'` / `'cv_random'` (`:126-127`), so `'internal'` would be
  RED at `no-user-control.ts:121`.
* `why` is required by the TYPE and must clear `NO_USER_CONTROL_WHY_MIN = 24`
  (`no-user-control.ts:54`, checked `:127`).
* ⚠ **It is not cosmetic beyond the face.** `group-controls.ts:89-94` drops
  `noUserControl` params from `listExposableControls` and
  `push-card-schema.ts:96-98` drops them from the Push 2 card. Both are
  improvements (a raw gate cache should never have been on a hardware
  controller), but they are **behaviour changes outside the faceplate** and the PR
  body must say so. tvLibrarian has no explicit `PUSH_CARD_CONTROLS` entry, so its
  push card is resolved from the live def and **will re-rank itself**.

Without the declaration the face paints **two continuous rotaries over raw gate
levels**, which is the failure `video/module-registry.ts:38-42` describes in as
many words.

---

## 2. ⚠ THE `.data` CENSUS — tvLibrarian IS A **FOURTH STATE**, AND IT IS INSIDE ONE FILE

Wave 5's census (README §7) built a three-state table over whole modules:

| state | modules | Cmd-Z? |
|---|---|---|
| bare proxy write, no transaction | `kria`, `audioOut`, `midiclock`, `midiCvBuddy`, `midiOutBuddy`, part of `numpadPlus` | ✗ |
| `ydoc.transact(fn)` with NO `LOCAL_ORIGIN` | `chromaconsole`, `score`, `numpadPlus` | ✗ |
| `ydoc.transact(fn, LOCAL_ORIGIN)` | `picturebox`, `matrixMix` | ✓ |

**tvLibrarian is in the top row and the bottom row at the same time**, and the
whole point is that it is one file:

| site | shape | Cmd-Z |
|---|---|---|
| `writeCountry`, `:161-169` | `ydoc.transact(…, LOCAL_ORIGIN)` | ✓ |
| `writeChannel`, `:171-186` | `ydoc.transact(…, LOCAL_ORIGIN)` | ✓ |
| ⚠ the corner-resize `apply`, `:447-453` | **bare proxy write**, no transact, no origin | ✗ |

```
TvLibrarianCard.svelte:447-453
  apply: (w, h) => {
    const t = patch.nodes[id];
    if (t) {
      if (!t.data) t.data = {};
      (t.data as Record<string, unknown>).width = w;
      (t.data as Record<string, unknown>).height = h;
    }
  },
```

The author of this file clearly knows the rule — they applied it twice, correctly,
with `LOCAL_ORIGIN` imported at `:29`. **The discipline is per-call-site, not
per-module**, and wave 5's table (which assigns one state per module) cannot
express that. **This is the census's fourth state and it is the one that most
undermines reading the census as a list of careful and careless modules.**

⚠ **AND THIS ONE HAS A DEFENSIBLE JUSTIFICATION, WHICH THE OTHERS DID NOT.** The
`apply` callback fires **per `pointermove`**. Tagging it `LOCAL_ORIGIN` unmodified
would push a resize drag into the undo stack at frame rate — `captureTimeout: 500`
(`store.ts:68`) would coalesce much of it, but the shape is still wrong. So this
is **not** simply the `kria`/`audioOut` defect again.

**It is still a defect**, for two reasons:

1. the values *are* persisted and synced (they ride `node.data`, so a rack-mate
   sees the resize), so "it is transient view state" is not available as a defence;
2. the resize is genuinely un-undoable today, and a user who drags the card to a
   wrong size has no Cmd-Z.

**The correct shape is the one `DetachedDisplay.svelte:121` already documents** —
*"at `handleNodeDragStop`, never per move, because every `LOCAL_ORIGIN` [write
enters the undo stack]"*: write untagged during the drag, and commit **once** on
`onEnd` inside `ydoc.transact(…, LOCAL_ORIGIN)`. `startCornerResize` already
provides the `onEnd` hook (`:456`).

⚠ **AND THE PATTERN IS FLEET-WIDE, WHICH IS WHY IT IS NOT FIXED HERE ALONE.**
`startCornerResize` has **fifteen** callers (`card-resize.ts` consumers), and of
the module cards that use it only four import `LOCAL_ORIGIN` at all (`Archivist`,
`PeerTube`, `TvLibrarian`, `Videobox`) — and all four import it for their *other*
writes, not for the resize. **Every corner-resize in the fleet is un-undoable.**

**Routing:** fix tvLibrarian's inside this PR (it is the file being touched);
⚠ **do NOT sweep the other fourteen here** — that is a separate change with its
own review surface, and this spec does not assume it lands. Recorded so the next
reader knows the scope of what they found.

⚠ Note the face does **not** inherit the problem: the faceplate has no corner
resize (the dock owns its own sizing), so `width`/`height` stop being written from
this module at all once the card stops being the primary surface. The fix is
boy-scout on the card, not a face requirement.

---

## 3. THE `needs-media-controller` TAX — tvLibrarian PAYS THE HEADLESS-HOST TAX, AS THE THIRD MEMBER OF A SETTLED LINEAGE

The blocker is real and outstanding: its probe is
`tree.cardOwnedSourceTypes.length === 0` (`face-migration-inventory.ts:207`),
i.e. `HEADLESS_MOUNT_LANE_TYPES` is empty, and it is not.

⚠ **#1511 is CLOSED (COMPLETED, 2026-08-23) and its acceptance is NOT met** —
`DOM_SOURCE_LANE_TYPES` still has seven members and `HeadlessSourceHost.svelte`
still exists. The inventory says so itself (`:622-628`): *"'the last blocked
module shipped' and 'the blocker resolved' are different facts and only the first
one happened."*

⚠ **It does not block a face, and that is settled on `main`.** `cameraInput` and
`loopback` both shipped faces with it outstanding
(`face-migration-inventory.ts:378-385`: *"a card-owned-source module CAN be faced
while that blocker is outstanding, by paying the headless-host tax and rebuilding
the card-only affordances. It is the SECOND module to pay both halves."*).

**This spec proposes no platform capability, and does not ask for one.**

### 3.1 THE TAX, STATED EXACTLY

`tvLibrarian` is in `DOM_SOURCE_LANE_TYPES` (`dom-source-modules.ts:94`), so
`needsHeadlessSourceMount` returns `true` for the `'shell'` lane kind
(`:378-384`) and `<HeadlessSourceHost>` keeps the **real `TvLibrarianCard`
mounted off-screen** for the life of the node.

**What that host keeps alive**, each measured on the card:

| kept alive | line | what dies without it |
|---|---|---|
| `ve.attachExternalSource(id, 'video', videoEl)` | `:390`, in an `onMount` retry interval | the engine node exists but its source is null — **`video` is a blank texture and every consumer downstream is black** |
| `startTriggerLoop()` | `:397`, `onMount` | ⚠ **the `next` / `random` CV inputs.** The card polls `readParam` and edge-detects; with no card, both gate jacks are *patched, visibly connected and INERT* — the picturebox precedent verbatim |
| `fetchCountries()` | `:398`, `onMount` | the roster never loads (§7) |
| the two `$effect`s at `:403` / `:414` | | a country/channel arriving from a **remote peer** or from a saved rack never attaches its stream |

**That is the tax: a real card is mounted off-screen on every rack containing a
tvLibrarian, forever.** It is the same tax cameraInput and loopback already pay,
and it is a *permanent per-rack* cost rather than a one-off. tvLibrarian would be
the **third** module to pay it.

### 3.2 ⚠ HALF THE MEDIA DEBT IS ALREADY PAID, AND IT SHARPENS THE TAX RATHER THAN REMOVING IT

This module has already done the harder half of what `needs-media-controller`
describes, and the card is emphatic about it:

* **the `<video>` element belongs to the NODE**, not the card. It is created by
  `$lib/ui/media/node-media-registry` and **adopted** into a host div
  (`:355-378`, `nodeMedia.adopt(id, MEDIA_SLOT, host, …)`). The markup says so at
  `:485-487`: *"The `<video>` is NOT declared here: it belongs to the NODE and is
  adopted into this host div. Declaring it in markup is what tied its lifetime to
  the card."*
* **the hls.js instance belongs to the NODE** — `$lib/ui/media/node-hls`,
  `setNodeHls`/`getNodeHls`/`destroyNodeHls` (`:24`, `:93-95`), rehydrated on
  adopt (`:374`).
* **`onDestroy` deliberately tears down nothing** (`:423-435`):
  > *"NOTE what is deliberately ABSENT: no teardownHls, no detach, no unwireAudio,
  > no setStreamOnline(false). The element, its hls.js demuxer and its audio
  > wiring belong to the NODE and must survive this card being unmounted …
  > The stream really is still online; saying otherwise here is what made the
  > tuner go dead on a collapse. Teardown runs from nodeMedia's disposer when the
  > node leaves the graph."*

**So the media OBJECT is node-owned; what remains card-owned is the ATTACH CALL
and the two polling loops.** That is why the module is still in
`DOM_SOURCE_LANE_TYPES` — the gate derives membership from a card that calls
`attachExternalSource` **and** an engine that retains the element
(`dom-source-modules.test.ts:79`, `:241-252`), and tvLibrarian satisfies both.

⚠ **This is worth stating precisely because it is the good news and the bad news
at once.** The expensive part of #1511 (element lifetime, demuxer lifetime,
collapse-survival) is *done* on this module. The cheap-looking part — one
`attachExternalSource` call in an `onMount` retry loop, and a trigger poll — is
what keeps it on the headless host. **A future #1511 completion for tvLibrarian
is small**, and this spec deliberately does not attempt it: it is a platform
change, it would need the same treatment on the other six members, and the face
does not need it.

---

## 4. STOP 1 & 2 — PARITY

Every affordance `TvLibrarianCard.svelte` offers, with where it goes:

| affordance | card | where it goes on the face | lost? |
|---|---|---|---|
| the live 16:9 stream picture | `:481-487` | **the lane tile** (live, per-node, §5) **and** the `fullViewBody` hero | no, upgraded |
| `tuning…` overlay | `:488-489` | body overlay — a transient outcome, not resting state | no |
| `stream unavailable — skipping` | `:490-491` | body overlay, transient | no |
| `pick a country, then a channel` empty state | `:492-493` | body overlay | no — and see §8, it is a placeholder naming the surface's own condition |
| the NOW PLAYING label | `:498-503` | ⚠ **REMOVED as text** → `aria-label` — §8 | text yes, information no |
| map / list segmented toggle | `:507-510` | body | no |
| `random` button | `:511` | body (or a cell — §6.3 argues the body) | no |
| the clickable world map + markers | `:520-532` | body | no |
| the country `<select>` | `:534-543` | body — ⚠ **NOT a `selector` cell**; §7 | no |
| `next ▸` button | `:548` | body | no |
| the channel list, with `geo` badges and language tags | `:550-570` | body | no |
| `loading channels…` / `no playable channels` | `:552-555` | body, transient | no |
| the legal disclaimer + Famelack/iptv-org attribution | `:573-578` | ⚠ **body, and it is MANDATORY** — §8.2 | no |
| corner-drag resize (persisted `width`/`height`) | `:441-458` | ⚠ **removed** — the dock owns pane sizing; §2 | the gesture, yes; the capability, no |
| `gain` | — (never exposed) | a ranked param cell — **and it must be made to work first**, §1.1 | no, **gained** |
| PatchPanel jacks | `:479` | the shell's own patch surface | no |

**Nothing is lost.** One thing is removed as painted text (§8), one gesture is
superseded by the dock's own pane sizing, and one thing is **gained**: `gain`
becomes reachable for the first time (§1.1).

⚠ **The `$effect`/`onMount` sweep (wave 5 §6) was run on this card and it is
clean** — every lifecycle hook it carries (`:355`, `:383`, `:403`, `:414`,
`:423`, `:459`) is kept alive by the headless host (§3.1). That is the tax doing
its job, and it is the reason this module needs no extraction precursor where
recorderbox does.

---

## 5. THE LANE PICTURE — **ACCEPTED**, and free

`hasVideoSurface(def)` is `def?.domain === 'video'` and nothing else
(`module-shell-model.ts:177-179`); `laneGlyphFor` returns `'picture'`
(`:237-240`); `ModuleShell.svelte:1345-1348` renders `<VideoTileThumb nodeId={id} />`,
which blits the node's own output FBO at `VIDEO_THUMB_W×H = 160×120`, throttled to
`VIDEO_THUMB_FPS = 15` (`:250-252`).

`tv-librarian.ts:117` is `domain: 'video'`. **The picture is automatic, per-node,
and costs nothing to author** — a wall of TVs each showing its own station, which
the def explicitly calls a supported use (`:120-121`: *"multiple 'TVs' tuned to
different countries is a legit wall-of-screens use case"*).

Wave 5 §5 records that the intuitive rule ("a module with a video port gets the
picture") is false in both directions and **the predicate is the DOMAIN and only
the domain**. tvLibrarian is a straightforward accept on that predicate; it needs
no `nodeId` prop, no glyph seam, and depends on none of the escalations waves 2-5
nominated.

⚠ **The face MUST declare `glyph: 'none'`.** `glyphBinding()` short-circuits on
the first `type === 'audio'` **output** (`shell-glyph-live.ts:163-184`) — and here
is the trap: **tvLibrarian HAS audio outputs** (`audio_l`, `audio_r`,
`tv-librarian.ts:131-132`), so unlike picturebox and recorderbox its glyph would
NOT resolve to a dead static. A glyph literal would produce a *live* binding and
`module-face-lint`'s dead-glyph clause would not catch it.

**So the `'none'` here is a real decision rather than a forced one**, and the
reason is the #1785 owner ruling recorded at `module-shell-model.ts:202-214`: *"for
a video module the picture IS the module's identity in a rack, so it OUTRANKS
ranked controls."* A meter glyph on a module whose whole point is a picture would
be competing with the picture for the tile. `strict-faces.ts:838-840` records the
rule for video defs.

---

## 6. THE FACE

### 6.1 THE DECLARATION

```ts
face: {
  glyph: 'none',                 // §5 — a real choice here, not a forced one
  order: ['gain'],
  paramCells: { gain: 'fader' },
  extension: 'tvLibrarian',      // → fullViewBody
},
noUserControl: [                 // §1.2 — def top-level, not per-param
  { param: 'cv_next',   writer: 'cv-port', why: '…' },
  { param: 'cv_random', writer: 'cv-port', why: '…' },
],
```

One ranked key. That is not a thin face; it is an honest one — the module has one
real control, and compact-is-the-default means a face with one control should look
like a face with one control.

### 6.2 BANDS — one, and no tab rail

One ranked control is one band. `DOCK_TAB_MIN_BANDS = 7` (`dock-tabs-model.ts:101`),
applied at `:142`. **No tab rail, and none is manufactured.**

⚠ **This module is a plausible candidate for the owner's "control-heavy = TABBED
face" ruling and it does NOT qualify, which is worth stating.** That ruling is
about *many controls of DIFFERENT types*. tvLibrarian has **one** control and a
browse surface. The browse surface is a body, not a page. Padding it to seven
bands to earn a rail is the exact anti-pattern the ruling names, and `face.tabbed`
is owner-instruction-only.

### 6.3 `gain` IS A `'fader'`

`'fader'` is a legal `AuthoredParamCell` (`shell-control-kind.ts:119`). `gain` is
a linear 0..2 output level whose meaningful landmark is unity at the middle of the
throw, which is the fader's natural reading. ⚠ There is **no card choice to
preserve or overturn here** — the card never exposed it (§1.1) — so this is a
fresh decision, and it matches what every other video source's output level uses.

⚠ **No range re-typing question arises, and that is worth recording because it
usually does on a video module.** The `paramSpec` vs `*_RANGE` decision
(`module-faceplates.md`, "On a card whose def is in the WEBGL ATTEST BASIS") only
bites when a **card** restates a range. `TvLibrarianCard.svelte` restates nothing
— it has no param control at all — and a ranked face cell reads the `ParamDef`
directly through `ModuleShell.svelte:657-700`. **So tvLibrarian needs no
`RANGE_BOUND_CARDS` entry and no `paramSpec` binding.** (Contrast recorderbox,
which has no params at all, and picturebox, where the question was live and cost a
PR split.)

### 6.4 `next` AND `random` STAY IN THE BODY, NOT AS `action` CELLS

They are tempting as `ShellActionCell`s and the temptation should be resisted.

* An `action` cell's `probe` is **required** (`shell-cells.ts:293`), and the
  honest probe for `next` would be `{ kind: 'data', key: 'channel', expect: 'changed' }`
  — which is real, so this is not a probe problem.
* ⚠ **It is a LOCATION problem.** A cell can be ranked into the LANE, and a
  "next channel" button in a 46 px lane knob column, beside nothing that says
  *which* channel, is an affordance with no context. The gesture only means
  something next to the roster it steps through.
* And the def already classifies them: *"'random' / 'next ▸' buttons (DOM-only,
  not module params)"* (`tv-librarian.ts:147`). The CV path to the same behaviour
  is the two gate inputs, which are real ports and keep working.

**Both stay in the body, beside the list.** ⚠ If a future owner instruction wants
them in the lane, they become `action` cells with `{ kind: 'data', key: 'channel',
expect: 'changed' }` probes and this section is the record of why they were not.

### 6.5 THE BODY — `face.extension: 'tvLibrarian'`, slot `fullViewBody`

`packages/web/src/lib/ui/modules/tvLibrarian/TvLibrarianTunerBody.svelte`,
registered via `.../tvLibrarian/shell-extension.ts`.

Contents, top to bottom:

1. **the picture** — the `nodeMedia`-adopted `<video>` host div, 16:9, with the
   three transient overlays (`tuning…`, `unavailable`, the empty-state
   placeholder) and the fleet-standard **SCREEN ON/OFF** toggle (§7.1).
2. **the picker head** — the `map` / `list` segmented toggle and `random`.
3. **the map** *or* **the country `<select>`**, per the toggle.
4. **the channel head** — the country NAME and `next ▸`.
5. **the channel list** — rows of station name · `geo` badge · language tag.
6. **the disclaimer + attribution** — §8.2, mandatory.

⚠ **THE `<video>` ADOPTION IS THE ONE THING THAT MUST BE GOT RIGHT.** The body is
a **second** possible host for a node-owned element that is already adopted into
the off-screen headless card's host div. `nodeMedia.adopt` is a lease
(`:358`, `mediaLease?.release()` at `:433`), so the mechanism supports a handoff —
but two simultaneous adopters of one element is exactly the double-mount hazard
`needsHeadlessSourceMount` exists to prevent (`dom-source-modules.ts:352-360`,
the `'stub'` arm: *"Double-mounting would run TWO getUserMedia / two `<video>`
elements for one node"*).

**MUST-VERIFY M2 (§17) is the experiment.** The likely correct shape is the
`FACE_MOUNTS_PRODUCER` analogue for the DOM-source half — `Canvas.svelte`'s
`fullViewShowsFaceInstead`, which is already scoped to `DOM_SOURCE_LANE_TYPES`
(`dom-source-modules.ts:329-334` records exactly that scoping) — so the headless
host should already stand down while the dock full view is open. **Confirm it,
do not assume it**, and confirm the element lands in the *body's* host and comes
back to the headless host on collapse without tearing down hls.

⚠ **Never `editorSurface`.** `WIRED_SHELL_EXTENSION_SLOTS = ['glyph', 'fullViewBody']`
(`shell-extensions.ts:124`); `editorSurface` is declared (`:118`) and unwired, and
its first adopter must wire the render site in `ModuleShell` in the same diff.

---

## 7. ⚠ THE STATION ROSTER — IT IS A RUNTIME NETWORK FETCH LIVING ON THE CARD, SO IT **CANNOT** BE A `selector` CELL

The brief asked this directly — *where does the roster come from today, and can
the shell read it?* Both halves are measured.

### 7.1 WHERE IT COMES FROM

`tv-librarian-data.ts:1-16` is unambiguous:

> *"PURE data layer … No DOM, no network calls here — just the dataset URLs, a
> TOLERANT parser … **All network I/O lives in the card** so this file is trivially
> unit-testable. Dataset: github.com/famelack/famelack-data (MIT). **Fetched at
> RUNTIME (we do NOT bundle it).** … v1 hotlinks GitHub raw (ACAO:* — verified)
> with a graceful failure path."*

The two fetches are in the card: `fetch(countriesMetadataUrl(), { mode: 'cors' })`
at `TvLibrarianCard.svelte:131`, and `fetch(countryChannelsUrl(code))` at `:148`.
The results live in **component state** (`countries`, `channels`), not in
`node.data`. Only the *chosen* country code and the *chosen* channel's metadata
are persisted (`writeCountry` `:161`, `writeChannel` `:171` — `nanoid`, `name`,
`streamUrl`, `country`, `languages`).

### 7.2 SO IT CANNOT BE A `selector` CELL, AND THE REASON IS THE CELL'S OWN SIGNATURE

`ShellSelectorCell` is *"A dropdown over a NAMED roster that lives in node.data
(not a param)"* (`shell-cells.ts:166-172`), and its options function is:

```ts
options: (node: ModuleNode | undefined) => SelectorOption<string>[];
```

**A pure, synchronous function of the node.** It cannot await a fetch, it cannot
hold a loading state, and it cannot render an error. The country roster is ~250
entries fetched over the network on mount; the channel roster is a *second* fetch
keyed to the chosen country, with `loadingChannels`, `datasetError` and a
`no playable channels` empty state (`:552-555`).

**None of that is expressible as `options(node)`.** Persisting the whole roster
into `node.data` to make it expressible would be strictly worse: it puts a
third-party dataset that *"may change without notice"* into the Y.Doc, syncs it to
every peer, and writes it into every saved rack.

⚠ **AND THE `env`-FOR-SELECTORS PLATFORM ASK IS DISPROVEN — do not re-propose
it.** Wave 5's `BINDERS.md §9` settled that device/stream rosters are read from
the engine via `getActiveEngine()` (`$lib/audio/engine-ref.ts:23`, already
exported and already consumed from plain `.ts`), so a selector *can* reach live
service state without a platform change. **That route does not help here**, and
the difference is worth being precise about rather than filed as "same problem":
`getActiveEngine()` reaches the **engine**, and tvLibrarian's roster is not in the
engine — it is on `raw.githubusercontent.com`. The engine has never heard of it.

**So the roster lives in the `fullViewBody`, which has no such constraint**, and
that is not a workaround: a two-level async browse with a map, a segmented view
toggle, badges and an error path is precisely *"a control that is not cell-shaped
at all"*.

⚠ **This is the sharpest structural divergence between my two modules.**
recorderbox's quality roster is three static values the module itself declares, so
it is a textbook `selector` cell (see that spec §6.3). tvLibrarian's roster is a
runtime network resource, so it cannot be a cell at all. **Same word, opposite
answers.**

---

## 8. RESTING TEXT — ONE REMOVAL, ONE JUDGEMENT CALL SETTLED, AND ONE OWNER QUESTION

`face-resting-text-source.test.ts` denies the SHAPE: every `ModuleFace` field must
carry a declared text ROLE, and the permitted roles are exhaustively module NAME,
TAB/SECTION labels, CONTROL CAPTIONS and OPTION/LANDMARK NAMES. ⚠ Its **stated
blind spot** (`:60-87`) is text drawn inside a `fullViewBody` — so most of what
follows is a taste call no gate will catch, which is exactly why it is argued here
and declared in the `EXTENSION_BODY_ROLES` `why` (§9).

### 8.1 THE DISPOSITIONS

| card text | line | face | why |
|---|---|---|---|
| the NOW PLAYING label — `{channel.name}` + language | `:498-503` | ⚠ **REMOVED** → `aria-label` on the picture | a standalone readout of current state, painted beside the picture and attached to no control. It restates which roster row is selected, and the list's own selected-row highlight already says that. This is the hero-readout-strip shape (#1957) with one value in it. |
| the channel list rows — station names | `:565` | **KEPT** | §8.2 |
| `geo` badge | `:566` | **KEPT** | a per-row static literal marking a property of that option, not a measurement |
| the language tag | `:567` | **KEPT** | part of the option's name — two stations called "TV 5" in one country are told apart by it |
| the country name in the chan-head | `:547` | **KEPT** | a SECTION LABEL — it names the list below it |
| `tuning…` / `stream unavailable — skipping` | `:489`, `:491` | **KEPT** | transient outcomes, not resting state |
| `pick a country, then a channel` | `:493` | **KEPT** | ⚠ the `samsloop` / `twotracks` precedent — a placeholder naming the surface's own condition is not a measurement, and it is REPLACED the moment a stream exists |
| `loading channels…` / `no playable channels` | `:553`, `:555` | **KEPT** | same shape |
| the disclaimer + attribution | `:573-578` | **KEPT — MANDATORY** | §8.2 |

### 8.2 THE STATION-NAME JUDGEMENT, ARGUED RATHER THAN ASSUMED

The brief flagged this as a real call. **It is settled, and it splits.**

**Reading A — a station name is an OPTION NAME (permitted).** The channel list is
a roster of selectable options and the station name is the option's name, the same
role as `HIGH`/`BALANCED`/`SMALL` on a quality selector. The picturebox precedent
is directly on point (that spec §7): per-slot filenames were **kept** in the body
because *"a file bank whose rows do not say which file is in them is not a file
bank"*, and the text is *"a per-row LABEL, which is the `control-caption` role in
substance."* A channel roster whose rows are blank is not a roster.

**Reading B — a station name is DERIVED DATA (refused).** The names are not an
option set the module declares; they are fetched at runtime from a third-party
dataset whose own README warns the schema *"may change without notice"*
(`tv-librarian-data.ts:4-5`). The ruling's permitted role was written about
options a module owns.

**The resolution:** Reading A **for the list rows**, Reading B **for the
now-playing label**, and the discriminator is *attachment*, not provenance:

> **Text inside a control that selects it is an option name. The same text painted
> outside every control, restating what is selected, is a readout.**

That discriminator reproduces every settled case in the fleet — picturebox's
per-slot filenames (in the row, kept), scope's tuner numbers (outside the control,
deleted), the hero readout strip (outside, deleted), `HIGH`/`BALANCED`/`SMALL`
(in the selector, kept) — and it decides both of tvLibrarian's cases without
special pleading.

### 8.3 ⚠ ONE GENUINE OWNER QUESTION, WHICH THIS SPEC DOES NOT DECIDE

The discriminator above settles *where* text may be. It does not settle a second
thing, and this one is outside a build lane's authority:

> **The legal disclaimer and the Famelack / iptv-org attribution
> (`TvLibrarianCard.svelte:573-578`) are resting text that is neither a name, a
> caption, a section label, nor an option — and they must stay anyway.**
>
> *"Third-party public streams — not hosted by patchtogether. Data via Famelack ·
> iptv-org."* The def calls it *"a legal disclaimer and Famelack/iptv-org
> attribution"* (`tv-librarian.ts:147`) and the dataset's licence requires the
> attribution. It is the **only** text in the fleet whose justification is legal
> rather than design, and no permitted role covers it.

**This spec keeps it, unchanged, in the body**, and flags it because:

* it is invisible to `face-resting-text-source.test.ts` (body text — the stated
  blind spot), so it will ship green either way and **nobody will be asked**;
* a future reviewer applying the resting-text ruling literally would delete it,
  and deleting it is a licence problem, not a taste regression;
* the honest fix is for the owner to say whether "REQUIRED LEGAL/ATTRIBUTION" is a
  permitted resting-text role. If it is, it should be declared as one so the next
  module carrying an attribution inherits the answer.

⚠ **`peertube` almost certainly has the same question** (its exemption entry
names the same shape of third-party source, `vrt-exemptions.ts:902`), so this is
a cohort-level question rather than a tvLibrarian one. **Routed to the owner via
the orchestrator; nothing in this spec depends on the answer.**

### 8.4 THE FINDING THAT LOSES ITS SURFACE

⚠ Deleting a readout deletes a finding. The NOW PLAYING label is currently the
only place a user can see the station name **while looking at the picture** — the
list may be scrolled away, or the view toggled to `map`. What lapses is the
join between *this picture* and *that name*.

It survives on the picture's `aria-label` (speakable, assertable, unpainted), and
the selected row's highlight (`class:sel`, `:563`) remains the painted answer.
⚠ **The build must confirm the selected row is reachable** — if the list is
scrolled or the view is on `map`, nothing painted says which station is playing.
**Scroll the selected row into view on tune**, which the card does not do today
(D3).

---

## 9. `EXTENSION_BODY_ROLES` — **`picture`**

`face-rack-status-source.test.ts:142` declares `type BodyRole = 'picture' | 'status-primitive'`,
and `:695` asserts the role set is **exactly** those two.

⚠ **CORRECTION TO THE BRIEF.** It named a third role, `control-grid`, *"added by
#2184"*. **On `ea2e06340` that role does not exist** — the union has two members
and the both-directions anchor at `:695` would redden if a third appeared.
Re-read `:142` at build time; the reasoning below is unaffected either way.

The predicate (`:476-480`): `picture` → `paintsCanvas(src, extId)` — *"mounts a
`<canvas>`, directly or through a surface component it renders."*

⚠ **AND HERE IS THE ONE THING THE BUILD MUST CHECK RATHER THAN ASSUME.** This
body mounts a **`<video>`**, not a `<canvas>` — the node-owned element adopted
into a host div (§6.5). If `paintsCanvas` greps for the literal `canvas`, the
`picture` predicate could **fail on the one body in the roster whose picture is
most obviously a picture.**

Two possible outcomes, and they need opposite responses:

1. `paintsCanvas` resolves through the mounted surface and finds one (the module's
   engine-side FBO blit, or a `<canvas>` in the host component) → the entry is
   `picture` and nothing more is needed;
2. it does not → ⚠ **this is a genuine gap in a deny-by-default roster**, and the
   honest response is **not** to mislabel the body `status-primitive` (its
   predicate requires `StatusLed` *and* no canvas — a `<video>` body satisfies
   neither half honestly). It would need the `picture` predicate widened to
   `<canvas>`-or-`<video>`, with its `what` string updated to say so.

**MUST-VERIFY M4 (§17)** decides it by running the predicate against the drafted
source. ⚠ Per the standing no-new-gates ruling, a widening is **not** self-served:
if outcome 2 obtains, it goes to the owner with the measurement. This spec does
not assume it.

The entry to commit (assuming outcome 1):

> `tvLibrarian: { role: 'picture', why: 'the STATION TUNER: a live 16:9 HLS picture from the node-owned <video> (adopted via node-media-registry, never declared in this markup — declaring it is what tied its lifetime to a card), its SCREEN switch, and beneath it the two-level browse this module exists for — a clickable equirectangular world map or a country dropdown, then that country\'s channel list. ⚠ THE ROSTER IS A BODY RATHER THAN A `selector` CELL BY NECESSITY, not by preference: `ShellSelectorCell.options` is a pure synchronous `(node) => SelectorOption[]`, and this roster is TWO runtime network fetches against a third-party dataset (famelack, hotlinked raw at runtime, never bundled) with their own loading, error and empty states — none of which `options(node)` can express, and persisting the dataset into node.data to make it expressible would sync a volatile third-party payload into every saved rack. ⚠ WHAT IT PAINTS AS TEXT: the control captions on its own buttons (map / list / random / next), the country NAME as a section label over the list it heads, and one station NAME per roster row with its `geo` badge and language tag — option names inside the control that selects them, the picturebox per-slot-filename precedent. ⚠ NOTHING DERIVED IS PAINTED: the card\'s NOW PLAYING label — the station name restated OUTSIDE every control, beside the picture — is GONE, and lives on the picture\'s aria-label; the selected row\'s highlight is the painted answer. ⚠ THE TRANSIENT OVERLAYS STAY (tuning…, stream unavailable — skipping, and the empty-state placeholder "pick a country, then a channel"): outcomes and a placeholder naming the surface\'s own condition, the samsloop NO SAMPLE LOADED shape, replaced the moment a stream exists. ⚠ THE ONE TEXT WITH NO DECLARED ROLE IS THE LEGAL DISCLAIMER AND THE FAMELACK / IPTV-ORG ATTRIBUTION, which is kept because the dataset licence requires it and refused by no gate because body text is this roster\'s blind spot — it is named here as the only fleet text whose justification is legal rather than design, and it is an open owner question whether that is a permitted resting-text role.' }`

---

## 10. VRT — ⚠ **PERMANENTLY EXEMPT TODAY, AND THE FACE MUST DECIDE WHAT REPLACES THAT**

This is the sharpest cost difference against recorderbox, which has a committed
baseline and a deterministic idle state.

* **No baseline exists.** `ls e2e/vrt/__screenshots__/vrt.spec.ts/ | grep -i tvlibrarian`
  → nothing.
* `tvLibrarian` is in **`EXEMPT_FROM_VRT`** (`vrt-exemptions.ts:895`):
  > *"live external HLS `<video>` + runtime-fetched, ever-changing channel list
  > defeat deterministic capture (same as videobox); pure-core unit tests +
  > network-mocked e2e provide coverage"*
* …and in **`ALLOWED_PERMANENT_EXEMPT`** (`:1180`, alongside `blood`,
  `warrensspectrum`, `videobox`).

**Both halves of that exemption are real**, and they are independent: the picture
is a live third-party stream, *and* the roster is a network fetch that changes
under you. Either alone would defeat a baseline.

### 10.1 THE FACE'S OPTIONS, AND THE RECOMMENDATION

The precedent that matters is **`loopback`**, which is *also* in `EXEMPT_FROM_VRT`
and *nevertheless has real face baselines* (`_shell-faces.ts:3093-3140`). Its
entry states the principle:

> *"⚠ THE MODULE'S OWN INJECTED-FRAME SEAM, AND IT IS WHY THIS FACE GETS REAL
> BASELINES RATHER THAN A `FACES_WITHOUT_SCENES` EXEMPTION. `loopback` sits in
> `EXEMPT_FROM_VRT` … and that stays TRUE OF THE CARD SCENE, which is a different
> surface with a different baseline."*

`__loopbackTestFrame` replaces the upload **and** the geometry, so the captured
frame is a pure function of the params. `simPin` installs page globals via
`addInitScript`, which reaches any **main-thread** module — and tvLibrarian is
necessarily main-thread (its source is a DOM `<video>`, so it can never be
worker-eligible), exactly the property that makes `cameraInput`, `loopback` and
`scoreboard` pinnable.

**RECOMMENDED: a `__tvlibrarianTestFrame` simPin, plus a roster pin.** ⚠ Note it
needs **two** pins, not one, which is why it is more work than loopback:

| pin | what it replaces | why one is not enough |
|---|---|---|
| `__tvlibrarianTestFrame` | the `<video>` sample → a fixed synthetic frame | pins the PICTURE |
| `__tvlibrarianTestRoster` | the two `fetch` calls → a fixed 2-country / 3-channel dataset | ⚠ pins the **ROSTER**, which is half the body's pixels and is *"ever-changing"* by the exemption's own words. Without it the dock baseline is a function of what famelack published this morning. |

The second is the one a loopback-shaped copy would miss, and it would produce a
baseline that passes on the day it is captured and reddens later for no reason
anyone can attribute.

**FALLBACK: a `FACES_WITHOUT_SCENES` entry** (`_shell-faces.ts:3391`) with both
reasons argued, the `acidwarp` entry as the template for the bar (*"it is animated"
is not sufficient*), and a `coveredBy` list naming `tv-librarian.spec.ts`,
`tv-librarian-audio.spec.ts` and the face-screen render check.

⚠ **The fallback is genuinely worse and the PR must say which it took.** `milkdrop`'s
roster entry records the cost in one line (`face-rack-status-source.test.ts:197`):
*"Unbaselinable … so this declaration is the only record of what it paints — no
dock baseline can contradict it."* For a body this text-heavy that is a real loss.

**Predicted file count**, for the §10.2 procedure: **two added**
(`face-tvLibrarian-compact.png`, `face-tvLibrarian-dock.png`), **zero moved** —
there is no existing baseline to go stale. ⚠ That makes the *"a green dispatch
that committed nothing is a RED FLAG"* check especially load-bearing here: with
nothing to move, "committed nothing" is the exact signature of the pins not
working.

### 10.2 THE PROCEDURE, IN ORDER

1. Predict the file count (above) **before** dispatching.
2. Dispatch **scoped**: `GREP=tvLibrarian flox activate -- task vrt:commit`. A bare
   dispatch on a face PR derives FULL.
3. **Count what the bot commits against the prediction.**
4. Never commit a PNG by hand. A local macOS run compares Metal text against a
   linux baseline and is not a verification.
5. ⚠ If the two scenes are captured, **re-run the dispatch once on a later day**
   before merging. A roster pin that silently fell through would produce a stable
   baseline on day one and a red on day two; running it twice is the cheapest
   negative control available and it is the one this module specifically needs.

---

## 11. COST

### 11.1 ⚠ WEBGL ATTEST — THREE BASIS FILES, AND THE `gain` FIX IS THE THING THAT COSTS

```
flox activate -- bash scripts/webgl-attest-hash.sh --list | grep -i tv-librarian
  packages/web/src/lib/video/modules/tv-librarian.ts
  packages/web/src/lib/video/modules/tv-librarian-data.ts
  packages/web/src/lib/video/modules/tv-librarian-geo.ts
```

(The basis is 218 files: essentially every `packages/web/src/lib/video/**` file,
plus the cube/wavesculpt pair and their surfaces, plus the toolchain and harness
manifests. `TvLibrarianCard.svelte` is **not** in it.)

`HASH_TRANSPARENT_PROPS` is `['docs', 'controlFamilies', 'face', 'noUserControl']`
(`scripts/attest-code-basis.ts:96-109`), and `:100-107` records that
`noUserControl` was added for precisely this reason — *"every video def sits in
the WebGL attest basis, so a property that stayed in the hash would make declaring
one cost a real-GPU re-attest that CI (SwiftShader) cannot run."* ⚠ The strip is
restricted to a **DIRECT member of a MODULE-SCOPE object literal** (`:88-93`), so
`noUserControl` must sit at the def's top level (§1.2), which is the real API.

**So the PR shape matters and it is the picturebox split, for a different reason:**

| PR | contents | attest |
|---|---|---|
| **PR 1 — the `gain` precursor (§1.1)** | `uGain` uniform in `FRAG_SRC` + apply in `draw()` + the `docs.controls.gain` rewrite | ⚠ **MOVES THE HASH — one real-GPU window.** A shader edit is unambiguously code. |
| **PR 2 — the face** | `face` + `noUserControl` on the def, the body, the registries, the e2e moves, the D2/D3 fixes | **ZERO**, if it touches nothing else in those three files |

⚠ **Unlike picturebox, the split is not optional-but-recommended here — the
precursor is the expensive half and it must land first**, because the face's
ranked `gain` cell is only honest once the shader reads it.

⚠ **An attest pin covers a TREE, not a PR.** If `main` moves a basis file under
you, your hash changes without your diff changing. Match CI's refusal hash before
spending the GPU, and never measure attest state in a dirty primary checkout.
Verify PR 2 by running `scripts/webgl-attest-hash.sh` against the **merged** tree
and confirming it is unmoved.

### 11.2 ART — ZERO, measured

* `ls art/baselines/` — **no `tv-librarian/` or `tvLibrarian/` directory**.
* The audio profile gate enumerates **audio-domain ids only**
  (`art/scenarios/_meta/audio-profile-gate.test.ts:39-47`, matching
  `/^(\S+) meta domain=audio\b/`). tvLibrarian is `domain: 'video'`, so the gate
  never sees it and it needs no `ART_EXCLUDED` / `ART_BACKLOG` entry.

⚠ **Note the trap it avoids**: this module has two **audio outputs**, so "it has
audio, therefore ART" is available and wrong. The gate reads the def's `domain`
off the contract golden, not its ports — the same predicate/port distinction
wave 5 §5 records for the lane picture.

**`art/` should be absent from this diff.**

### 11.3 CI WALL-TIME

New: two VRT face captures (they ride the scoped dispatch, not the PR's CI lane),
one new unit file (`tvLibrarian-face-model.test.ts`), and the simPin plumbing
(§10.1) which adds no test rows of its own. The e2e changes are selector edits
inside specs that already run.

**Estimated PR delta: well under 2 minutes**, under the sign-off bar.

### 11.4 THE PUSH 2 CARD MOVES

⚠ Declaring `noUserControl` drops `cv_next`/`cv_random` from
`push-card-schema.ts` (`:96-98`). tvLibrarian has no explicit
`PUSH_CARD_CONTROLS` entry, so its card is resolved from the live def and **will
re-rank itself** — from three params to one. The change is an improvement (a raw
gate cache should never have been on a hardware controller), but it must be in the
PR body, and `push-card-schema.test.ts` is a must-run.

---

## 12. THE e2e SURFACE

`tvLibrarian` **is** in `_face-fixtures.ts` — ⚠ **check whether it is a `DENIED`
entry at build time**, and if so, **delete it by hand in this PR**. That file's
header records the class twice (`_face-fixtures.ts:60-96`): a `DENIED` entry for a
module that gets PROMOTED does not go red, it goes **invisible**, because
promotion moves the module out of `unpromoted`. Both `audioOut` and `twotracks`
had to be removed by hand, and the second was factually wrong by the time anyone
read it.

Specs that reach for tvLibrarian:

| spec | role | disposition |
|---|---|---|
| `tv-librarian.spec.ts` | SUBJECT — network-mocked browse + tune | selector moves; the mock is the roster-pin prototype (§10.1) |
| `tv-librarian-audio.spec.ts` | SUBJECT — the stereo split | selector moves |
| `collapse-keeps-playing.spec.ts` | ⚠ **the headless-host sweep** — spawns each `DOM_SOURCE_LANE_TYPES` member and drives a file player | ⚠ **re-read before touching.** Its precondition is that the card is swapped away and the stream survives; promotion changes *which* surface replaces it, not whether it is replaced. Confirm it still exercises the real condition rather than passing vacuously (CLAUDE.md's green-and-blind class). |
| `per-module.spec.ts`, `per-module-per-port-behavioral.spec.ts`, `_per-module-per-port-shared.ts` | registry-driven sweeps | auto-enrolled; run the tvLibrarian rows |
| `peertube.spec.ts` | references it as a sibling | read-only |
| `e2e/fixtures/generate-hls-clip.mjs` | the local HLS fixture the mocked specs serve | ⚠ **the asset the §10.1 picture-pin should reuse** rather than inventing a second synthetic frame |

Testids the body must re-emit: `tv-preview`, `tv-loading`, `tv-unavailable`,
`tv-empty`, `tv-view-map`, `tv-view-list`, `tv-random`, `tv-map`,
`tv-country-select`, `tv-next`, `tv-channels`, `tv-channel`, `tv-error`,
`tv-disclaimer`.

⚠ **`tv-now-playing` should NOT be re-emitted** — it names the readout §8 removes.
Its assertions move to the picture's `aria-label`, which is what every spec
proving a face tracks state already reads. ⚠ **`tv-resize-handle` likewise** — the
gesture is superseded by the dock's pane sizing (§4).

---

## 13. THE CONVERGENCE QUESTION — tvLibrarian IS THE COHORT'S BEST FIT, AND IT STILL SPLITS FROM THE QUERY BROWSERS ON A MEASURABLE FIELD

The wave asks whether six modules converge on one media-controller shape.
tvLibrarian is the one that comes **closest** to the file-player / query-browser
shape — and the inventory's own `blockers` field already cuts the cohort somewhere
else:

| module | `blockers` | line |
|---|---|---|
| `archivist` | `needs-media-controller`, **`needs-note-entry-cell`** | `:637` |
| `peertube` | `needs-media-controller`, **`needs-note-entry-cell`** | `:948` |
| `recorderbox` | `needs-media-controller`, **`needs-note-entry-cell`** | `:1029` |
| `toybox` | `needs-media-controller`, **`needs-note-entry-cell`** | `:1066` |
| **`tvLibrarian`** | `needs-media-controller` only | `:1075` |
| `videobox` | `needs-media-controller` only | `:1111` |
| `videovarispeed` | `needs-media-controller` only | `:1120` |

**The second blocker splits on TYPED TEXT, and tvLibrarian is on the other side of
it from the query browsers.** That is not a bookkeeping detail — it is the whole
difference between a **BROWSE** and a **QUERY**:

* `archivist` and `peertube` need the user to **type a search**, which is why they
  carry `needs-note-entry-cell`: their roster does not exist until a query
  produces it.
* `tvLibrarian`'s roster **already exists** — it is a fixed (if remote) directory
  of every country and every channel. The user *navigates* it: a map click, a
  dropdown, `next`, `random`. **Nothing is typed anywhere on this module.**

**So the honest grouping is three shapes, not one:**

| shape | members | body | roster seam | cell vocabulary |
|---|---|---|---|---|
| **BROWSE-AND-TUNE** | `tvLibrarian` | `picture` + a navigable directory | a runtime network fetch, body-only (§7) | sufficient — 1 param cell |
| **FILE PLAYER** | `videobox`, `videovarispeed` | `picture` + transport | a local file, `node.data` | sufficient — `file` + param cells |
| **QUERY BROWSER** | `archivist`, `peertube` | `picture` + results | a query the user TYPES | ⚠ **insufficient** — `needs-note-entry-cell` |

**tvLibrarian and the query browsers share a body role (`picture`), a tax (the
headless host) and a lane-picture answer (accepted, free), and they diverge on the
one thing that decides whether the cell vocabulary is adequate.** That is a real
partial convergence, and it is worth more than a claim of a single shape: the
media half really does generalise; the *input* half does not.

⚠ **And the other module in this agent's pair, `recorderbox`, is on the far side of
both cuts** — a SINK, `status-primitive`, no headless host, zero params, carrying
`needs-note-entry-cell` because of a filename field. See that spec §13. **Between
the two modules I was given, there is no shared shape at all beyond
`domain: 'video'` and a lane picture that comes free with it.**

---

## 14. DEFECT LEDGER — live on `main`, independent of any face

| # | defect | evidence | routing |
|---|---|---|---|
| **D1** | ⚠ **`gain` is declared, exposed nowhere, and read by nothing.** The def carries a 0..2 output-level param; the card has no control for it; the shader has no `uGain` and `draw()` never applies it — **and the def's own docs say so** (`:160`). A face is the first surface that would paint it. | `tv-librarian.ts:140`, `:160`; `TvLibrarianCard.svelte` (no control) | **the PRECURSOR — PR 1** (§1.1). ⚠ Do **not** "fix" it with `noUserControl: 'internal'`: the gate would pass and the declaration would be false. |
| **D2** | ⚠ **The corner-resize writes `node.data.width`/`.height` bare** — no `ydoc.transact`, no `LOCAL_ORIGIN` — while the same file tags its two other `.data` writers correctly. A **fourth** census state: discipline that is per-call-site, not per-module. | `TvLibrarianCard.svelte:447-453` vs `:168`, `:185`; `mutate.ts:13-18` | **fix in this PR** — commit once on `onEnd` inside `LOCAL_ORIGIN` (the `DetachedDisplay.svelte:121` shape). ⚠ **Do NOT sweep the other 14 `startCornerResize` callers here** — same defect, separate PR. |
| **D3** | **Tuning does not scroll the selected channel into view.** With the list scrolled or the view toggled to `map`, nothing painted says which station is playing — and §8 removes the NOW PLAYING label that used to cover for it. | `:563` (`class:sel` with no scroll-into-view) | **fix in this PR** — it is the thing that makes the §8 removal safe |
| **D4** | **`attachExternalSource` is a 100 ms polling interval with a 50-attempt cap** rather than an engine-ready signal — so a slow engine start silently gives up after ~5 s and the node is black with no error anywhere. | `TvLibrarianCard.svelte:383-397` | ⚠ **NOT this PR.** It is pre-existing, it is the same shape on other DOM-source cards, and fixing it properly is an engine-ready seam. Recorded so it is not mistaken for something the face introduced. |
| **D5** | ⚠ **`_face-fixtures.ts`'s `DENIED` entry (if present) will go INVISIBLE, not red, on promotion** — the class that file's header documents twice. | `_face-fixtures.ts:60-96` | **check and, if present, delete by hand in this PR**, saying so in the PR body |

---

## 15. TASTE CALLS, EACH WITH ITS ONE-LINE REVERT

| call | revert |
|---|---|
| `gain` is a `'fader'`, not a knob | delete the `paramCells` entry |
| `next` / `random` stay in the body rather than becoming lane `action` cells | add two `ShellActionCell`s with `{ kind: 'data', key: 'channel', expect: 'changed' }` probes |
| the map is the default view, as on the card | flip the initial `viewMode` to `'list'` |
| the NOW PLAYING label is removed rather than moved into the picture as an overlay caption | — (an overlay caption is still resting derived text; this one has no cheap revert) |
| no tab rail | — (needs an owner instruction; `face.tabbed` is not a build-lane decision) |

---

## 16. MUST-VERIFY (before the face is written)

* **M1 — `gain` really is inert (§1.1).** Read `FRAG_SRC` in full and confirm no
  `uGain`; then, on `main`, drive `gain` to 0 through the store and assert the
  node's output texture is **unchanged**. ⚠ Both directions — drive it to 2 as
  well, and confirm the probe *can* move by perturbing something that does work
  (the stream itself). "It did not change" and "we never looked" are
  indistinguishable from one reading, and this measurement is what sizes PR 1.
* **M2 — the `<video>` handoff (§6.5).** With a tuned tvLibrarian, open the dock
  full view and confirm: exactly **one** adopter of the node's media slot; the
  picture is live in the body; the headless host has stood down; and on collapse
  the element returns with **hls intact and the stream still playing**. This is
  the one place a double-mount could ship.
* **M3 — the trigger loop survives promotion.** Patch a clock into `next` on a
  promoted, never-docked node and assert the channel advances. That is the
  headless host doing its job (§3.1) and it is the assertion that proves the tax
  is actually being paid.
* **M4 — the `picture` predicate accepts a `<video>` body (§9).** Run
  `ROLE_PREDICATE['picture'].holds(draftedSource, 'tvLibrarian')` against the
  drafted body. ⚠ If it returns false, **stop and route to the owner** — do not
  relabel the body.
* **M5 — the two VRT pins actually pin (§10.1).** Capture twice, on different
  days, and diff. A roster pin that fell through produces a stable day-one
  baseline and an unattributable red later.
* **M6 — the attest hash.** PR 1 moves it (budget a GPU window); PR 2 must not.
  Verify against the merged tree.
* **M7 — `EXTENSION_BODY_ROLES` still has two roles** (`face-rack-status-source.test.ts:142`,
  `:695`), per the §9 correction.

---

## 17. VERIFICATION GATE

```bash
# 1. the face model + its permanent negative controls
flox activate -- npx vitest run packages/web/src/lib/ui/workflow/tvLibrarian-face-model.test.ts

# 2. face lint + the promotion anchor (both directions)
flox activate -- npx vitest run packages/web/src/lib/ui/workflow/module-face-lint.test.ts

# 3. the noUserControl soundness sweep — and DRIVE THE NEGATIVE CONTROL:
#    confirm `writer: 'cv-port'` on `gain` is RED, and that ranking cv_next is RED.
flox activate -- npx vitest run packages/web/src/lib/ui/workflow/no-user-control.test.ts

# 4. the rulings' source gates
flox activate -- npx vitest run \
  packages/web/src/lib/ui/controls/face-readout-source.test.ts \
  packages/web/src/lib/ui/workflow/video-face-screen-source.test.ts \
  packages/web/src/lib/ui/workflow/face-resting-text-source.test.ts \
  packages/web/src/lib/ui/dock/face-width-source.test.ts

# 5. the roster gate that owns the body role + `why`  (⚠ M4 lives here)
flox activate -- npx vitest run packages/web/src/lib/ui/workflow/face-rack-status-source.test.ts

# 6. the registries + the shared-file neighbours
flox activate -- npx vitest run \
  packages/web/src/lib/ui/workflow/shell-extensions.test.ts \
  packages/web/src/lib/ui/workflow/shell-cells.test.ts \
  packages/web/src/lib/ui/workflow/face-migration-inventory.test.ts \
  packages/web/src/lib/ui/workflow/dom-source-modules.test.ts \
  packages/web/src/lib/ui/modules-card-map.test.ts \
  packages/web/src/lib/control/push2/push-card-schema.test.ts

# 7. the module's own units
flox activate -- npx vitest run packages/web/src/lib/video/modules/ -t "tv-librarian"

# 8. e2e — the two subjects plus the headless-host sweep
flox activate -- task e2e:one -- tv-librarian
flox activate -- task e2e:one -- tv-librarian-audio
flox activate -- task e2e:one -- collapse-keeps-playing
#    ⚠ Flake-check anything changed 3x:  REPEAT=3 flox activate -- task e2e:one -- tv-librarian

# 9. docs contract — the def's docs.controls.gain is rewritten in PR 1, so re-pin
flox activate -- task docs:accept && flox activate -- git diff packages/web/src/lib/docs/contract-lock.txt
#    ⚠ PR 1: expect the gain docs line to move and NOTHING ELSE.
#    ⚠ PR 2: expect an EMPTY diff. `face` is not the I/O contract.

# 10. typecheck LAST — vitest is lenient where svelte-check is strict
flox activate -- task typecheck

# 11. VRT: dispatch only, SCOPED, and COUNT the files (§10.2). NEVER commit a PNG.
GREP=tvLibrarian flox activate -- task vrt:commit

# 12. attest: PR 1 MOVES the hash (budget a GPU window). PR 2 must not.
flox activate -- bash scripts/webgl-attest-hash.sh
```

---

## 18. VERDICT, RISK, ESTIMATE

**PROMOTE-WITH-PRECURSOR.**

The face is straightforward and the module is well built: the media element and
its demuxer are already node-owned, `onDestroy` already refuses to tear anything
down, the headless host already exists and already has two shipped precedents, and
the lane picture comes free with `domain: 'video'`. The body is a picture over a
browse surface, which is what a `fullViewBody` is for.

**What gates it: `gain` (§1.1).** The face must rank it, and today it is a param
nothing writes and nothing reads. Implementing it is a ~4-line shader change; the
cost is that `tv-librarian.ts` is in the attest basis, so it buys a real-GPU
window that CI cannot run. **PR 1 pays that; PR 2 (the face) is then free.**

**What unblocks it:** a `uGain` uniform in `FRAG_SRC`, applied in `draw()`, plus
the `docs.controls.gain` rewrite. ≈ 2 h plus one attest window. No platform
change, no new cell kind, no new body role, no gate change.

**Risk: MEDIUM**, in three places, none of them in the design:

1. ⚠ **VRT.** This is the only module in my pair with **no baseline at all** and a
   *permanent* exemption. Getting real face baselines needs **two** simPins (the
   picture and the roster, §10.1), and the roster pin is the one a loopback-shaped
   copy would miss. The fallback (`FACES_WITHOUT_SCENES`) is a genuine loss of
   review coverage on a text-heavy body.
2. ⚠ **The `<video>` handoff** between the headless host and the dock body (M2).
   The mechanism exists and is leased, but a double-mount here means two decoders
   on one node.
3. **The `picture` predicate on a `<video>` body** (M4) — one grep away from
   either a non-issue or an owner conversation.

**Estimate: ≈ 12 h**, as **PR 1 (`gain`) ≈ 3 h** (shader, docs, `docs:accept`, one
attest window) and **PR 2 (the face) ≈ 9 h** (def `face` + `noUserControl`, the
body with the map/list/roster port, the two VRT pins, the
`EXTENSION_BODY_ROLES` entry, the D2/D3/D5 fixes, the e2e selector moves, and the
face-model unit).

**Build it SECOND in this cohort** — after one of the two file players, which will
settle the headless-host-plus-dock-body handoff (M2) on a cheaper module, and
before the query browsers, which need a typed-text answer this module does not
have to give.
