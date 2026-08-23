# Next-cut derivation — what is left to face, and what the cuts cost

Written 2026-08-23, against `main` at `cbee73be4` (#2131, batch-23b / shapes).

**This is evidence, not instruction.** Everything below is derived from live
artifacts in the tree and every derivation is a command you can re-run. Nothing
here is a decision — the cut is the owner's. No work from this document has been
started.

## How this was derived

| what | source | how |
|---|---|---|
| dispositions + done-ness | `docs/design/face-migration.generated.md` | GENERATED from `face-migration-inventory.ts` × the live registry × `STRICT_FACES`; pinned by `face-migration-inventory.test.ts`. Regenerate: `task face:inventory:accept` |
| param / port counts | `packages/web/src/lib/docs/contract-lock.txt` | counted per module from the pinned I/O golden |
| per-module migration notes | `face-migration-inventory.ts` | the `note` / `why` fields, which the TYPE requires on every non-default disposition |
| carve-outs | `e2e/vrt/vrt-exemptions.ts` | `EXEMPT_FROM_VRT` + the per-module mask lists |
| card-mounted engine state | `packages/web/src/lib/ui/workflow/dom-source-modules.ts` | `DOM_SOURCE_LANE_TYPES` + `CARD_PRODUCER_LANE_TYPES` |
| in-flight work | `git for-each-ref` + `git worktree list` | branches with commits ahead of `main` |
| PR size | `git diff --shortstat` over the last three face merges | measured, not estimated |

Done-ness is never typed anywhere — it is read off the def (does it declare a
`face`, is it in `STRICT_FACES`). No count in this document is committed to code.

## Where the fleet stands

| | count |
|---|---|
| registered modules | 198 |
| done (faced + promoted) | 124 |
| remaining, excluding rack furniture | 71 |
| — of those, `generic-face` (author a face, rank the controls) | 17 |
| — of those, `blocked` (a face today but for one named capability) | 3 |
| — of those, `bespoke-surface` (interaction is not param-shaped) | 51 |
| rack furniture, not a migration at all | 3 |

## FINDING 1 — the two capabilities that gate 74 percent of the remainder have CLOSED tracking issues

The inventory names two blockers. Both of their issues read as done:

- `needs-media-controller` → **#1511 is CLOSED** — 12 modules waiting
- `needs-note-entry-cell` → **#1509 is CLOSED** — 17 modules waiting

**The issues are the stale half, not the report.** The inventory does not read
issue state; each blocker carries a `probe` that asks the TREE whether the
capability shipped, and both probes currently answer no:

- media lifecycle probe is `cardOwnedSourceTypes.length === 0`, i.e.
  `HEADLESS_MOUNT_LANE_TYPES` empty. It holds **15** types today —
  `DOM_SOURCE_LANE_TYPES` (archivist, cameraInput, frametable, loopback,
  peertube, tvLibrarian, videobox, videocube, videovarispeed) plus
  `CARD_PRODUCER_LANE_TYPES` (cube, rasterize, scope, synesthesia, timelorde,
  wavesculpt).
- note-entry probe is `faceShellMountsTypedEntry`, i.e. does `ModuleShell.svelte`
  mount typed entry. No `ParamCellKind` paints text, so the cell cannot exist
  without it, and it does not.

So the capabilities are genuinely absent and the report is correct. What is wrong
is the tracking: 29 distinct modules (12 + 17, overlapping on 4) are gated on two
pieces of platform work that a board reader would believe was finished. Worth an
explicit owner decision — the standing direction is that issues only shrink and
the board tracks towards zero, and these two closed early relative to the tree.

## FINDING 2 — the cheap pipeline has about two batches of runway left

Of the 17 `generic-face` modules still open, **one is already in flight** and only
**seven** are plain — everything a plain one needs is a cell that already ships.
The other nine each need a bespoke panel, a tab rail, or a snowflake
accommodation. The "author a face, rank the controls" loop that produced 124
faces is close to exhausted, which is the real reason the next cut matters.

### The 17, smallest first

`params / inputs / outputs` are counted off `contract-lock.txt`. `class` is my
classification; the note is the inventory's own words.

| module | dom | p / in / out | class | what the inventory says, and what I found |
|---|---|---|---|---|
| `spectrograph` | audio | 1 / 1 / 2 | PANEL | one gain knob + a B/W toggle; the sonogram waterfall matches no glyph kind, so the screen becomes a registered panel |
| `joystick` | audio | 2 / 0 / 4 | PLAIN | its 2-D pad is a hand-clone — migrate onto the shared `xy` cell, never two knobs. VRT baseline pending, so no committed PNG gates it |
| `dockscope` | audio | 3 / 1 / 0 | PLAIN | the trace IS the `scope` glyph (analogVco is the precedent); the CV/AUDIO range button is a param |
| `samsloop` | audio | 4 / 4 / 1 | PLAIN | file → file cell, trigger → action cell, rec channels/bits/rate → discrete params; the sample waveform is the `waveform` glyph. Every cell it needs already ships |
| `graphicEq` | video | 5 / 2 / 1 | IN FLIGHT | branch `face/graphiceq-2026-08-22`, two commits ahead of main, live worktree, no PR yet. Fully VRT-exempt (animated audio-reactive bars). **Do not assign** |
| `chroma` | video | 6 / 7 / 1 | PLAIN | no note. VRT baseline pending; carries mask entries |
| `chromakey` | video | 6 / 8 / 1 | PLAIN | no note. VRT baseline pending |
| `feedback` | video | 6 / 7 / 1 | PLAIN | no note |
| `mandleblot` | video | 6 / 1 / 2 | PLAIN | no note |
| `timelorde` | audio | 6 / 5 / 14 | SNOWFLAKE | transport + mute write params; tap tempo is an action cell writing the same bpm param. But: `maxInstances=1 undeletable` (the master clock singleton) and a card-producer, so its engine state depends on its card being mounted. 14 outputs |
| `lushgarden` | video | 7 / 6 / 4 | AUDIT FIRST | the def declares more params than the card exposes — a face ranks ALL of them, so each one has to be checked for being real before it is ranked |
| `shapedramps` | video | 8 / 12 / 6 | PLAIN | no note. 12 inputs is the widest port surface in the plain set |
| `scope` | audio | 9 / 11 / 3 | PANEL (conditional) | the dual-trace + Lissajous screen is ONE `scope` glyph binding — **if** it will carry two channels. If not, the screen becomes a registered panel. Also `vizPassthrough` and a card-producer |
| `vfpgaRunner` | video | 16 / 12 / 2 | PANEL | preset roster → selector cell, fabric floorplan → a toggled read-only panel; rank the def-declared params, not the manifest. Fully VRT-exempt: host card with live preview plus CV scope canvases |
| `synesthesia` | audio | 22 / 4 / 48 | PANEL + TABS | mode/polarity buttons write params; the two band displays are read-only pictures, nearest kind `meter`. Card-producer. 48 outputs is the largest port surface left |
| `moog960` | audio | 36 / 3 / 4 | TABS | the 8-column step grid is knobs binding params; the active-column highlight is a readout, so nothing here is a bespoke gesture |
| `wavesculpt` | audio | 79 / 26 / 7 | TABS + OWNER REVIEW | two hand-cloned camera pads and the largest control order after mixmstrs. The inventory records that a face was authored for it once and shipped both pads as knobs, and says not to repeat that. Card-producer. Standing owner instruction excludes it from merge-on-green — it needs manual review |

Class definitions: **PLAIN** = every cell it needs already ships, no invention.
**PANEL** = its display matches no glyph kind, so a registered panel has to be
built. **TABS** = control-heavy, so the owner's tabbed-face direction (2026-08-19)
applies and it needs a `face.pages` tab rail; ruttetra was the first adopter and
is done, so the pattern exists. **SNOWFLAKE** = a structural constraint outside
the face itself.

⚠ Every video face in that table also owes a screen on/off toggle and a
shell-extension, per the owner's fleet-standard direction (2026-08-19) that all
video cards get one. None of the five plain video modules has a `shell-extension.ts`
today, while the great majority of already-faced video modules do — so this is
replication of an established pattern rather than invention, but it is not free.
Re-derive the current set with
`ls packages/web/src/lib/ui/modules/*/shell-extension.ts` rather than trusting a
number written here.

### The 3 `blocked` — all one capability away from being ordinary faces

Each says, in the inventory's own words, that nothing else stands in the way.

| module | p / in / out | what it becomes |
|---|---|---|
| `loopback` | 2 / 0 / 1 | a capture LED, a start/stop capture action and one fader — the smallest surface in the media set. Everything is expressible today except that the tab-capture stream lives on the card |
| `frametable` | 18 / 15 / 1 | knobs plus two hand-cloned 2-D pads, both expressible as `face.xyPads`, over a video source the card creates and attaches. Once the source is node-owned this is a face and nothing else |
| `videocube` | 30 / 22 / 8 | knobs plus three mounts of the shared XY pad and a file import. The only thing it cannot express is its card-owned video source |

### The 51 `bespoke-surface`, split by what they are actually waiting on

| group | count | modules |
|---|---|---|
| needs media lifecycle only | 5 | audioIn, cameraInput, tvLibrarian, videobox, videovarispeed |
| needs note-entry cell only | 13 | cartesian, controlSurface, drumseqz, electraControl, macseq, midiLane, painter, polyseqz, sequencer, textmarquee, vstFx, vstInstrument, writeseq |
| needs both | 4 | archivist, peertube, recorderbox, toybox |
| needs neither — genuinely purpose-built | 29 | audioOut, blood, chromaconsole, clipplayer, clockedRunner, doom, es9, frogger, gamepad, gibribbon, kria, launchpadControlLeft, livecode, mappy, matrixMix, midiclock, midiCvBuddy, midiOutBuddy, modtris, moog956, nibbles, numpadPlus, outToLaunch, picturebox, pong, push2Control, score, skifree, twotracks |

Cross-checks: 5 + 4 + 3 blocked = 12, which is the media figure the report prints.
13 + 4 = 17, which is the note-entry figure. Both reconcile.

⚠ The 29 in the last row are the only group no platform capability helps. They
are the games, the hardware control surfaces and the MIDI devices — a different
kind of project from face authoring, and not a "cut" in the sense this document
uses the word.

## What a face PR actually costs

Measured off the last three face merges rather than estimated:

| merge | scope | files | lines |
|---|---|---|---|
| `cbee73be4` (#2131) | shapes, one video face with a screen | 14 | +480 / -29 |
| `f75a8d07e` | moog921Vco promotion | 14 | +888 / -41 |
| `0e7650727` | moogCp3 promotion | 13 | +789 / -10 |

So a face lands in roughly **13-14 files and 500-900 lines**, consistently,
whatever the module. Batch cadence in force (owner instruction 2026-08-18): one
to two video plus two to three audio faces per batch, a spec floor of four, any
fix folded into the same PR as its face, and at most four open PRs at a time.

## The decision menu

Six candidate cuts. Sizes are modules; costs are in face-PR units as measured
above.

---

### Cut A — the plain tail ✅ **MY RECOMMENDATION for the next batch**

**8 modules**, split 3 audio / 5 video:

- audio: `joystick`, `dockscope`, `samsloop`
- video: `chroma`, `chromakey`, `feedback`, `mandleblot`, `shapedramps`

⚠ That split is video-heavy against the standing cadence (one to two video plus
two to three audio per batch), so at the cadence as written this is closer to
three batches than two unless the mix is allowed to flex — worth deciding
explicitly rather than discovering in batch two.

**Cost**: about two to three batches at the standing cadence, 8 face PRs, roughly 13-14
files each. No platform invention: every cell these need already ships (`xy`,
`file`, `action`, `waveform` glyph, `scope` glyph). Five of them owe a video
screen extension, which is replication of an existing pattern.

**Why I recommend it**: it is the last cut that runs at the velocity the previous
23 batches ran at. Two of its members (chroma, chromakey) have no committed VRT
baseline, so they carry less baseline risk than a typical face, not more. And
finishing it produces the cleanest possible decision point: afterwards every
remaining `generic-face` module needs either a panel, a tab rail, or a snowflake
accommodation, so the owner would be choosing between genuinely different kinds
of work rather than between "more of the same" and everything else.

**Risk**: `shapedramps` has 12 inputs, the widest port surface in the set.
`lushgarden` was deliberately left out — see Cut F.

---

### Cut B — the screen-panel set

**4 modules**: spectrograph (1 param), scope (9), vfpgaRunner (16), synesthesia (22)

**Cost**: 4 face PRs plus the registered-panel work each one needs, which is new
surface rather than cell reuse. `scope` may or may not need a panel at all — the
inventory says its dual-trace plus Lissajous screen is one `scope` glyph binding
if that glyph will carry two channels, so **the first task in this cut is a
one-hour check of whether it does**, and the answer moves scope between Cut A and
Cut B.

**Risk**: scope and synesthesia are card-producers — their engine-visible state
depends on their card being mounted, so a face must not break the headless-host
contract. That is a live invariant with a measured precedent in the tree
(a collapsed group silences a producer in both shells). vfpgaRunner and
graphicEq are both fully VRT-exempt, so a panel here is gated by e2e and unit
coverage, not by a baseline.

---

### Cut C — the control-heavy tabbed pair

**2 modules**: moog960 (36 params), wavesculpt (79 params, 26 inputs)

**Cost**: 2 face PRs, both large, both needing a `face.pages` tab rail per the
owner's tabbed-face direction. ruttetra proved the pattern, so this is adoption
rather than invention.

**Risk**: wavesculpt is the single highest-risk face left. It is the largest
control order after mixmstrs; the inventory records that a face was authored for
it once and got both camera pads wrong by shipping them as knobs; it is a
card-producer; and the standing owner instruction excludes it from merge-on-green
and requires manual review. moog960 is by contrast mechanically simple for its
size — an 8-column step grid of knobs binding params, with the active-column
highlight being a readout rather than a gesture.

---

### Cut D — build the node-owned media lifecycle 🔶 **the strategic one**

**Unlocks 12 modules**: 3 blocked (loopback, frametable, videocube — each of
which the inventory says becomes "a face and nothing else") + 5 bespoke
media-only + 4 bespoke needing both.

**Cost**: platform work, not face work, so the face-PR unit does not apply. The
probe states the finish line exactly — `HEADLESS_MOUNT_LANE_TYPES` empty, from 15
today — which makes it unusually well specified for its size.

**Why it is worth surfacing above the face cuts**: it is not only a face
unblocker. Today every one of those 15 types is kept alive off-screen by
`HeadlessSourceHost`, which the inventory describes as a tax on every rack. And
it is the capability the parked camera face is waiting on — the camera work that
just landed (PR #2133) deliberately shipped only the part that stands without it.

**Risk**: touches the source lifecycle for the entire media fleet. Highest blast
radius on the menu.

---

### Cut E — build the note-entry face cell

**Unlocks 17 modules**: the whole sequencer class (sequencer, drumseqz, polyseqz,
macseq, writeseq, midiLane, cartesian, painter, textmarquee, controlSurface,
electraControl, vstFx, vstInstrument) plus the 4 that need both.

**Cost**: platform work. The inventory scopes it as a note/short-text entry cell
plus consolidation of hand-cloned XY pads; no `ParamCellKind` paints text today,
so this is genuinely new surface in `ModuleShell.svelte`.

**Why it is the larger unlock by count** (17 versus 12) but the weaker one by
urgency: it buys sequencer faces, where Cut D also removes a standing per-rack
cost. If only one platform cut is taken, I would take D.

---

### Cut F — the two that need a question answered before they need a face

**2 modules**: lushgarden (7 params), timelorde (6 params)

Both look like plain small faces by param count and are not.

- `lushgarden`: the def declares more params than the card exposes. A face ranks
  all of them, so someone has to check each undeclared-in-UI param is real before
  it appears on a faceplate. That is an audit, and its outcome could also be a
  def correction.
- `timelorde`: `maxInstances=1 undeletable` — the master clock singleton — and a
  card-producer. Its face is mechanically trivial (transport and mute write
  params, tap tempo is an action cell writing the same bpm param), but it is the
  one module every rack has exactly one of, and it took a tap-tempo fix as
  recently as #2132.

**Cost**: an investigation each, then a small face. Good candidates to fold into
another batch as the "fix plus face in one PR" slot rather than to run as a cut.

---

## Summary table

| cut | modules | new platform capability | my read |
|---|---|---|---|
| A — plain tail | 8 (3 audio / 5 video) | none | ✅ recommended next batch; last cut at current velocity |
| B — screen panels | 4 | registered panels | do after A; check scope's glyph first, it may belong in A |
| C — tabbed pair | 2 | none (ruttetra proved it) | wavesculpt needs owner review by standing instruction |
| D — media lifecycle | 12 | node-owned media lifecycle | 🔶 the strategic unlock; also removes a per-rack tax |
| E — note-entry cell | 17 | typed entry in the shell | largest by count; sequencer class |
| F — audit-first pair | 2 | none | fold into another batch, not a cut |
| (none) | 29 | none possible | genuinely purpose-built; games, MIDI, control surfaces |

**In one sentence:** the face pipeline has roughly two batches of ordinary work
left (Cut A), after which every remaining module needs either new platform
surface or a bespoke build — so the decision that matters is not which faces come
next, it is whether Cut D or Cut E starts while Cut A is still running.

## Things I checked so nobody re-checks them

- `graphicEq` is in flight in another lane's worktree with two commits and no PR.
  It is the only one of the 17 that is already assigned.
- All 20 remaining `generic-face` + `blocked` modules are already in
  `STRICT_DOCS`, so none of them owes documentation work as part of its face.
- Both blocker issues are closed while both capabilities are absent (Finding 1).
- The 3 `organizational-native` modules (cadillac, group, sticky) are rack
  furniture and are excluded from every count above, as the report excludes them.
