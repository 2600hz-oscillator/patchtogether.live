# BESPOKE FACE PROGRAM — WAVE 6 (the MEDIA / STREAM surfaces, and the capability that turned out not to be one)

Six specs, one cohort: **`archivist`, `peertube`, `tvLibrarian`, `videobox`,
`videovarispeed`, `recorderbox`.**

Every module here has a remote or streamed picture as its PRIMARY interaction,
and every one of them declares the same migration blocker. So the wave was
commissioned to produce something more useful than six faceplates: **a precise
enough definition of `needs-media-controller` to SCHEDULE it.**

It did not produce that, and the reason is the wave's headline.

---

## 0. THE HEADLINE — `needs-media-controller` IS A LIFECYCLE TAX, NOT A FACE BLOCKER, AND THE TREE ALREADY PROVED IT TWICE

The commissioning question was: *if the six specs converge on one controller
shape, specify it; if they genuinely need different things, say that, because
"one capability unblocks N" may be an assumption nobody has tested.*

**Somebody tested it. Twice. It is false.** Two modules carrying this exact
blocker have ALREADY SHIPPED FACES with it outstanding:

* **`cameraInput`** — the first `DOM_SOURCE_LANE_TYPES` member to be promoted.
  `dom-source-modules.ts:76-88` carries the lineage: its `NON_SHELL_LANE_TYPES`
  carve-out *"was removed when the module was promoted"*, so (`:82-88`)
  *"cameraInput is now an ORDINARY member: the shell swaps its lane card for a
  faceplate,
  `needsHeadlessSourceMount` returns true for the resulting 'shell' kind, and
  `<HeadlessSourceHost>` keeps the real card — and therefore getUserMedia, the
  stream and the permission machine — alive off-screen."*
* **`loopback`** — `face-migration-inventory.ts:378-385`, in the entry's own
  words: *"a card-owned-source module CAN be faced while that blocker is
  outstanding, by paying the headless-host tax."*

So the capability is not on the critical path of any face in this wave. What it
buys is the DELETION of `<HeadlessSourceHost>` and the per-rack tax that host
represents — which is a real and worthwhile cleanup, and a different project from
faceplates.

**The consequence for this wave, applied in all six specs:** no spec requests a
platform capability for its media lifecycle. Each one instead states **exactly
what tax it pays** — headless host, a status registry the way `cameraInput` built
`camera-status-registry` (`legacy-fallback.ts:90`), or nothing at all because
the module already paid the debt through `node-extras-registry` /
`extras-producers.ts` the way `picturebox` did (wave 4 §0.2).

That is a strictly more useful output than a capability spec, because it is
per-module, it is checkable, and it does not block on anything.

---

## 1. ⚠ THREE STANDING CORRECTIONS — the briefing numbers were wrong, and one of them is a live board defect

This wave was commissioned on three factual premises. **All three are false**,
measured on `ea2e06340`. They are recorded here because two of them will mislead
the next reader of the board, not merely the next reader of this file.

### 1.1 There is no `needs-media-controller` LABEL, and #1511 is CLOSED

`needs-media-controller` is not a GitHub label — `gh issue list --label
needs-media-controller --state all` returns `[]`. It is a **`MigrationBlockerId`**
in the source: `packages/web/src/lib/ui/workflow/face-migration-inventory.ts:98`.

`#1511` is **CLOSED**, `stateReason: COMPLETED`, at `2026-08-23T00:36:19Z`, and it
is titled *"[P0][legacy-removal] LEG-02: node-owned media lifecycle — no source
may exist because a card is mounted"*. Its body names **nine** modules.

### 1.2 ⚠ #1511's OWN ACCEPTANCE NEVER LANDED — a closed issue that is not done

This is the correction that matters beyond this wave. #1511's stated acceptance is:

> `DOM_SOURCE_LANE_TYPES` is empty and deleted; `HeadlessSourceHost.svelte` is
> deleted; no `<SvelteFlow>` exists outside the main canvas.

Measured on `ea2e06340`:

* `DOM_SOURCE_LANE_TYPES` has **seven** members —
  `archivist`, `cameraInput`, `loopback`, `peertube`, `tvLibrarian`, `videobox`,
  `videovarispeed` (`dom-source-modules.ts:89-97`);
* `HeadlessSourceHost.svelte` **still exists** (`packages/web/src/lib/ui/workflow/`);
* `HEADLESS_MOUNT_LANE_TYPES` is that seven plus the six `CARD_PRODUCER_LANE_TYPES`
  (`cube`, `rasterize`, `scope`, `synesthesia`, `timelorde`, `wavesculpt` —
  `:204-211`).

The inventory says so outright, at `face-migration-inventory.ts:622-628`:

> ⚠ AND EMPTYING IT DID NOT RETIRE `needs-media-controller`. That blocker's probe
> is `cardOwnedSourceTypes.length === 0` … and it is still false … **"The last
> blocked module shipped" and "the blocker resolved" are different facts and only
> the first one happened.**

**A closed issue whose acceptance never landed will mislead whoever reads the
board next.** The work #1511 describes is still entirely outstanding; what closed
was the *`blocked` disposition bucket*, which is a different thing. Recorded here
rather than re-opened, per the standing no-new-issues ruling.

### 1.3 The population is EIGHT, not twelve — and this cohort is SIX of them

`needs-media-controller` is carried by exactly eight inventory entries:

| entry | line | also carries |
|---|---|---|
| `archivist` | 637 | `needs-note-entry-cell` |
| `audioIn` | 646 | — |
| `peertube` | 948 | `needs-note-entry-cell` |
| `recorderbox` | 1029 | `needs-note-entry-cell` |
| `toybox` | 1066 | `needs-note-entry-cell` |
| `tvLibrarian` | 1075 | — |
| `videobox` | 1111 | — |
| `videovarispeed` | 1120 | — |

**Wave 6's cohort is six of those eight — 75% of the population.** The two
outside it are `audioIn` and `toybox`.

The corrected number is a *better* justification for the cohort than the wrong one
was: at twelve, six modules would have been half a population and the convergence
question would have stayed open on the unexamined half. At eight, this wave
examines three quarters of it, and the two it leaves out are both known oddities:
`toybox` is *"a whole SUB-RACK in a card: a node menu, many source pickers and
file imports, a named preset store, its own camera capture and an interactive
canvas"* (its own `why`, `:1068-1070`), and `audioIn` is the only carrier that is
not a video module at all — an `AudioModuleDef` registered from
`packages/web/src/lib/audio/modules/audioin.ts:107`, described as *"a hardware
CAPTURE BINDER … a getUserMedia stream the card starts and stops with its own
lifetime"* (`:647-650`). Neither is a media/stream SURFACE in the sense this
cohort is about, which is why the cohort stops at six rather than reaching for
eight.

### 1.4 The instrument that produced these numbers, and the two ways it lied first

Stated because this wave's method section demands it of the specs, and the README
does not get an exemption.

* A `type:` → `blockers:` regex with a 400-character lookahead **crossed an entry
  boundary** and reported `push2Control` as a blocker-carrier. It is not;
  `recorderbox` is, and `push2Control` sits between them in the file. Caught by
  running a second, differently-shaped extraction and reading the lines where the
  two disagreed.
* A disposition census that split on `\n  {\n` returned **61 entries**. The real
  number is **198**: 137 entries are written on a single line and the split could
  not see them. The corrected census is 45 `bespoke-surface`, 150 `generic-face`,
  3 `organizational-native`, and **0 `blocked`** — after subtracting the four
  occurrences that are the discriminated union's own TYPE DECLARATION
  (`:251-257`) rather than entries.

Both failures have the same shape, and it is the shape CLAUDE.md names: **a
filter applied before the check that quietly redefined the check's subject.**
Neither announced itself; both returned a clean, plausible, wrong number.

---

## 2. WHY THIS COHORT, AND WHAT "CONVERGENCE" WOULD HAVE MEANT

The six were grouped by **shared design problem**, not by domain tag: a remote or
streamed picture IS the primary interaction for all of them, and all six carry the
same blocker. That makes them the natural place to test whether one capability
serves many modules.

The convergence question was made **falsifiable rather than assumed** by the
fan-out, which paired modules by similarity and put the two DIVERGENT ones
together:

| agent | modules | shared design problem |
|---|---|---|
| A | `videovarispeed`, `videobox` | LOCAL-FILE PLAYERS — a picked file, a transport, a window |
| B | `archivist`, `peertube` | REMOTE-QUERY BROWSERS — a typed query, a result list, a player |
| C | `tvLibrarian`, `recorderbox` | THE DIVERGENT PAIR — a roster/tuner and the cohort's only SINK |

Pairing C deliberately: if the six were going to fail to converge, `recorderbox`
is where it would show, because it is the only one that *consumes* frames rather
than producing or attaching them. A convergence claim that never examined the
divergent case would not be worth writing down.

### 2.1 ⚠ THE ANSWER IS **THREE SHAPES, NOT ONE** — and the inventory already said so in a field nobody read

The cohort does **not** converge on one media-controller shape. It splits cleanly,
and the discriminator is already sitting in the inventory: **the `blockers` field
cuts this cohort on TYPED TEXT, not on media.**

* `needs-note-entry-cell` carriers: `archivist`, `peertube`, `recorderbox`, `toybox`
* second-blocker-free: `tvLibrarian`, `videobox`, `videovarispeed`

| shape | members | body role | roster seam | today's cells adequate? |
|---|---|---|---|---|
| **FILE PLAYER** | `videobox`, `videovarispeed` | `picture` | a local file, in `node.data` | ✓ `file` + params |
| **QUERY BROWSER** | `archivist`, `peertube` | `picture` | a query the user **types** | ✗ — `needs-note-entry-cell` |
| **BROWSE-AND-TUNE** | `tvLibrarian` | `picture` | a **runtime network fetch**, body-only | ✓ one param cell |
| **SINK** | `recorderbox` | **`status-primitive`** | three static values it declares | ✓ `selector` + `toggle` |

**The media half genuinely does generalise** — a `picture` body, the headless-host
tax, a lane picture that comes free with `domain: 'video'`. **The input half does
not, and that is the whole finding.** The sharpest single instance is that
`selector` gives *opposite* answers inside one agent's pair: `recorderbox`'s
quality roster is a textbook `ShellSelectorCell` (three static values in
`node.data`), while `tvLibrarian`'s station roster **cannot be a cell at all**,
because `options` is a pure synchronous `(node) => SelectorOption[]` and that
roster is two runtime network fetches against a third-party dataset.

⚠ **The `env`-for-selectors ask does not rescue it and is NOT re-proposed here**
(wave 5 `BINDERS.md §9` refuted it): `getActiveEngine()` reaches the *engine*, and
this roster lives on `raw.githubusercontent.com`.

So the useful scheduling output is not "build one controller". It is: **the media
lifecycle is already a solved pattern applied several ways, and the one thing this
cohort was supposed to be blocked on is not a capability at all.**

### ⚠ AND THERE IS A ONE-LINE DISCRIMINATOR THAT PREDICTS WHICH SHAPE A MODULE NEEDS

The most useful thing the wave produced, and it survives all six modules:

> **Is the thing the body needs to show and drive IN THE GRAPH?**
>
> * **YES** → the body reads `node.data` / params directly. **No registry.**
> * **NO** → it needs a status registry with a `delivered` ledger.

`cameraInput` and `loopback` needed `camera-status-registry` because *a browser
capture grant is nowhere in the graph.* A local-file player's entire state is
`node.data` plus params, so it needs nothing of the kind — and ⚠ **copying
`camera-status-registry`'s shape onto them would introduce a SECOND owner of
state the Y.Doc already owns**, which is a defect, not an abstraction.

This is why "one controller for twelve modules" was never the right question. The
modules do not differ by *how much media lifecycle* they have; they differ by
**whether their state is already in the document**. That is a property anyone can
check in a minute, and it partitions the population correctly on the first try.

The concrete shape the four graph-state modules share — and it is a THIRD shape,
neither `cameraInput`'s nor `loopback`'s — is: a `picture`-role `fullViewBody`
that **blits the engine output and never adopts the node-owned `<video>`**,
carries a real `<button>` transport and a real `<input type="file">` (⚠ *not*
`ShellToggleCell` / `ShellFileCell` — forced by `collapse-keeps-playing`'s
DOM-derived enrolment), reads and writes `node.data` through `mutateNode`, and
mounts the SCREEN switch on the shared `previewCollapsed` key — while the real
card stays alive off-screen owning the element, the decode and the gate loops.

⚠ **One axis inside that shape is decided by CORS, not by module family**, and it
splits a pair that otherwise matches exactly. `peertube.ts:341-347` calls
`uploader.attach(videoEl)`, so its body **BLITS** (cameraInput's rule verbatim).
`archivist.ts:453-467` deliberately never does — archive.org video is
CORS-tainted, and `dom-source-modules.test.ts:142` says so by name (*"NOT
archivist"*) — so its body **must ADOPT** the node-owned element, because its own
texture is the idle gradient for its default media type. Two sibling modules, one
design problem, opposite answers on the single most structural question in the
body. **That is the strongest evidence in the wave that "one media controller" was
never going to be the shape.**

### 2.2 ⚠ AND A MODULE CAN SATISFY WHAT THE BLOCKER *DESCRIBES* WHILE BEING INVISIBLE TO WHAT IT *MEASURES*

`recorderbox` is the case, and it is the wave's best blind-gate finding.

Its inventory `why` (`:1029-1034`) says *"the capture canvas plus its per-frame
encode loop live on the card, so the recording exists only while it is mounted."*
**All three clauses are false**, and `RecorderboxCard.svelte` denies each one at
the line (verified independently by the orchestrator):

| claim | what the card actually says | at |
|---|---|---|
| capture canvas on the card | *"there is no capture canvas here any more. The registry creates one and never appends it to the document"* | `:93-96` |
| encode loop on the card | *"CAPTURE IS NOT HERE. It runs on the registry's own pump, which keeps feeding the encoder while this card is unmounted. This loop is preview-only"* | `:257-260` |
| recording dies with the mount | *"#1574: the recording belongs to the NODE… The card no longer holds anything it could kill."* | `:106-111` |

The owner is `node-recorder-registry.svelte.ts` (graph-lifetime), shipped as
**`bdef392f6`** — *"fix(recorderbox): the recording belongs to the NODE —
collapsing the card no longer destroys the take (P0) (#1574) (#1584)"*.

**Now the blind gate.** `dom-source-modules.test.ts` derives both membership sets
from exactly three seams — `attachExternalSource(` (`:79`), `write(node|id,…)`
(`:319`) and `install*FrameDrawer(` (`:329`). **Every one of them describes a card
that hands the engine a source or pushes pixels IN. `recorderbox` is a SINK — it
consumes `ve.blitOutputForPreview(id)`.** It could never match any of them.

So **its absence from both sets is a tautology about a regex, not evidence about
its lifetime — and if `#1574` were reverted tomorrow the gate would stay green.**
That is CLAUDE.md's blind-gate shape exactly: a filter applied before the check
that quietly redefines the check's subject. The gate names this as its own first
stated blind spot (`:33-35`), which is the honest version and is why this is
recorded rather than treated as a scandal.

⚠ **No new gate is proposed** (the standing no-new-CI-machinery ruling). The fix
that actually prevents the confusion is deleting the stale `why` — the claim
appears in **two further places**, the card's own header (`:8-10`, contradicted 85
lines later) and the VRT mask `why` (`vrt-exemptions.ts:118-124`).

---

## 3. THE THREE GATES EVERY FACE PR IN THIS WAVE SATISFIES

Wave 4 listed two of these and `midiclock` discovered the third the hard way, so
all six specs in this wave list three:

1. **the face lints / `STRICT_FACES` promotion anchor** —
   `module-face-lint.test.ts`. The set is asserted EQUAL to the set of defs
   declaring a `face`, in both directions, so **authoring the `face` IS the
   promotion** and there is no count to maintain (`strict-faces.ts:10-21`).
2. **the VRT baselines** — a compact scene and a dock scene per face, registered
   in `e2e/vrt/_shell-faces.ts`. ⚠ Linux CI authors them; nobody commits a PNG —
   dispatch with `task vrt:commit`, which SCOPES the capture to the branch's diff
   and prints what it selected before dispatching. ⚠ A face that genuinely cannot
   be baselined takes a NAMED `FACES_WITHOUT_SCENES` entry (`:3391`) rather than
   a silent absence — which matters in this cohort, because a NETWORK-BACKED
   surface is a determinism hazard the fleet has not had to price before.
3. **`EXTENSION_BODY_ROLES`** — `face-rack-status-source.test.ts:150`.
   Deny-by-default over every `fullViewBody` in the tree, membership derived off
   the DIRECTORY, a **mechanical predicate per role**, and a `why` required by the
   type. There are exactly **two** roles (`:142`): `picture` (the body really
   mounts a `<canvas>`) and `status-primitive` (it really imports `StatusLed`
   **and** really has no canvas). They are not exclusive by intent — they are
   ordered by the canvas test, so a body that keeps a preview canvas *and* uses
   `StatusLed` is legally `picture`.

   ⚠ **The role set is ANCHORED EXACTLY** (`:690-696`):
   `expect([...roles].sort()).toEqual(['picture', 'status-primitive'])`, with the
   stated reason that *"a roster where every entry said `picture` would be a
   rename of the blind spot rather than a narrowing of it."* So a third role
   cannot be added quietly — it moves that assertion, deliberately and visibly.

   ⚠ **CORRECTION, and it is the kind this wave keeps finding.** This wave was
   briefed that a third role `control-grid` already existed, "added by #2184".
   **It does not exist on `ea2e06340`** — `grep -c control-grid` over that file
   returns **0**, and `:142` is a two-member union. #2184 is an OPEN PR. The
   error was propagated into all three spec briefs before a spec agent measured
   it and sent it back. Recorded because the correction pattern is the point: an
   *unmerged PR's* contents read exactly like *merged tree state* in a briefing,
   and nothing but going and looking distinguishes them.

That third gate is the one this cohort most needed listing, because a media body
is the exact case it was built for. Its own header is candid that it **cannot see
what a canvas paints** — which is why every spec here states its role, its `why`
string as it would be committed, and what its canvas draws.

**Every module in this wave is `picture` except `recorderbox`, which is
`status-primitive`** — stated per module in each spec, with the reason, rather
than inherited from the cohort.

### 3.1 TWO MORE GATES A FACE PR SATISFIES — each discovered live, neither listed in wave 4's §14

4. **`module-docs-lint`'s FAMILY↔CARD leg** — `module-docs-lint.test.ts:360-370`,
   *"every declared controlFamily.testidPrefix actually appears in the card
   source"*. It scans every CARD's source for each declared
   `controlFamilies.testidPrefix`, so **declaring a family whose testid the LEGACY
   card does not carry reddens.** ⚠ The honest fix is to ADD the testid to the
   card when the card really has that gesture — **not** to drop the family.
   Shipped precedent: `cs-clear-tail` and the four `twotracks-*` prefixes.
   (Found by `midiclock` on `midiclock-connect`.)

5. **the `optionsExhaustive` SNAP contract** — `param-vocabulary.test.ts:130-203`.
   A param with an exhaustive option roster must **SNAP at the point of use**, not
   validate-and-reject. The reason is mechanical: `paramCellKind` returns `'knob'`
   for an options param OFF-DOCK, so a lane drag genuinely can land between
   options — snapping is what makes those intermediate integers harmless instead
   of silently rejected. ⚠ *"one that declares it and does NOT snap is worse than
   one that never declared it"* (`:153`). There is ONE snap implementation —
   `snapToOptions` from `$lib/ui/controls/knob-vocabulary-model` (`:32-34`); never
   hand-roll a second. **A validate-and-reject implementation is a control that
   looks alive and isn't.**

### 3.2 TWO COSTS EVERY SPEC MUST PREDICT RATHER THAN DISCOVER

⚠ **Draining a VRT exemption enrols the module in MORE than VRT.**
`vrt.spec.ts:52` builds `COVERED_MODULES` as
`REGISTRY.filter(m => !(m.type in EXEMPT_FROM_VRT))`, so a drain also adds the
**legacy CARD baseline**, not just the face scenes. `midiclock` correctly
predicted **3** files where its own spec had said 2; the drain also surfaced
`vrt-cable-stripe` on #2184. **Every spec here predicts its file count and names
which sweeps the drain joins** — and the count is checked against what the bot
actually commits, per the standing VRT rule that a green dispatch committing
nothing is a red flag.

⚠ **`DOCK_MAX_DIFF = 1500` px cannot see a short caption change**
(`_shell-faces.ts:3556`). So **face TEXT can drift while the dock baseline stays
green**, and `--update-snapshots` cannot repair a passing-but-stale baseline
anyway. Any spec that specifies caption WORDING states that the wording is
verified **by eye on the committed PNG**, never by the gate. This matters more
in this wave than most, because §4.1's ruling is enforced largely through what
captions say.

---

## 4. THE RULINGS, AS APPLIED TO A COHORT THAT WANTS TO BREAK THEM

### 4.1 NO RESTING DERIVED TEXT — and this cohort is where the rule bites hardest

Permitted resting text, exhaustively: the module NAME, TAB/SECTION labels,
CONTROL CAPTIONS, and option/landmark NAMES that disambiguate a control's own
position. **A duration, a timecode, a bitrate, a frame count, a filename, a
"buffering"/"connected"/"recording" state word, a track title — all refused as
painted chrome.** They live in `aria-valuetext`.

Every module in this wave wants to paint transport state, and one of them wants a
running timecode. The positive form already exists and no spec here invents an
exemption: **`StatusLed`** (`$lib/ui/controls/StatusLed.svelte`, gated by
`status-led-source.test.ts`). Its own header calls it *"the ONLY status surface a
face may use, shaped so the refused form cannot be expressed"*, and three
properties are why it holds where the previous mechanisms did not:

* **there is NO `value` prop.** `Readout.svelte` — *"the refused shape preserved
  next door: `{ value, units, precision }` and a text node"* — is the contrast.
  Adding one is an edit to a gated file, not a call-site choice.
* ⚠ **the caption is STATIC BY CONTRACT, not by convention**: it is painted and
  announced identically whether `lit` is true or false, so a caller cannot smuggle
  a measurement through `lit ? 'LATE 3' : 'OK'` — that reads as a caption that
  changes, and the source gate denies it AT THE CALL SITE.
* the derived quantity goes to `detail`, which reaches `aria-label` and `title`
  and never a text node; `tone: 'accent' | 'warn'` distinguishes a FAULT from a
  readiness in **colour, not text**.

`persistentReadout=false` is refused BY NAME; the prop is deleted, so it cannot
come back.

⚠ **In-canvas text is a different question and the ruling is already made.** Wave
5's `GAMES.md:59-65` settled it: *"Pixels the MODULE renders into its OWN surface
are a different object. They are the module's artwork, not the face's chrome …
The face is not painting the number; the game is."* Applied here verbatim, not
re-derived. Its precedent is the game module whose HUD is drawn inside its own
surface — **cited, never opened, per the standing ruling on that module.**

The honest edge of it in this fleet is `samsloop` and `twotracks`, both of which
paint a literal placeholder (`NO SAMPLE LOADED`, `NO TAPE`) into an empty canvas.
Permitted, because *a placeholder naming the surface's own condition is not a
measurement of any control* — and drawn rather than left blank precisely so that
"nothing loaded yet" and "the body failed to mount" are different pictures, which
matters because the fresh-spawn empty state is what the dock baseline captures.

⚠ And the gap is stated rather than implied, because this cohort lives in it:
`face-resting-text-source.test.ts` **cannot see either shape**. Canvas text is
invisible to it. The only things that see those pixels are the dock VRT baseline
and the human reviewing it — which is why `EXTENSION_BODY_ROLES` (§3) requires
every body in this wave to write down what its canvas draws.

### 4.2 COMPACT IS THE DEFAULT — a live picture is a legitimate earner, and it is still argued per module

A live picture EARNS width, and this is the one cohort where that is true for
nearly every member. **It is still stated per module with the measurement**, never
assumed from the cohort, because the burden of proof is on the wide face and
"it's a video module" is not a measurement. Gates: `face-width-source.test.ts`
(the rule) plus the per-face content-vs-plate measurement in
`workflow-shell-faces.spec.ts` (the result).

### 4.3 SCREEN ON/OFF is fleet standard, and for this cohort it has teeth

Every video module gets the backdraft-pattern preview-collapse toggle: it **keeps
rendering while OFF** — the collapse skips the PAINT, never the per-frame engine
read — and its state persists across tabs (`video-face-screen-source.test.ts`).

⚠ Two edges this cohort has to get right and generic video modules do not:

* the **watch mark** (`markWatched` / `pullExempt`, #2015). A lapsed mark on a
  mid-chain module does not merely pause a preview; on a module with history it
  punches a permanent gap in it.
* **SCREEN OFF must never stop an ENCODE or a CAPTURE.** The toggle is about the
  preview copy, and on a recorder the distinction is the difference between a
  collapsed panel and a lost take.

⚠ And the ruling's SCOPE is `STRICT_FACES ∩ video defs` — `audioOut`, `samsloop`,
`spectrograph` and `twotracks` are all derived OUT of it for being `domain:
audio`. Each spec checks its own `domain` rather than assuming the cohort's.

### 4.4 The rest, applied without re-derivation

* **A family key is ONE cell for ALL instances** (#2181).
* **Tab rail only on honest pages**, never padded to reach `DOCK_TAB_MIN_BANDS`;
  `face.tabbed` is owner-instruction-only. Where a spec proposes a rail it argues
  it from the real control census.
* **No keyboard-a11y design work** — Tab IS the flip gesture.
* **Device/stream rosters are READ from the engine via `getActiveEngine()`.** The
  `env`-for-selectors platform ask is DISPROVEN (wave 5 `BINDERS.md §9`) and is
  not re-proposed anywhere in this wave.
* **On a def in the WebGL attest basis, bind ranges with `paramSpec(def,'x')`,
  never a new `export const FOO_RANGE`** (#2186, `module-faceplates.md:384-414`).
  The export is ordinary code and moves the attest hash; `paramSpec` reads the
  `ParamDef` the def already declares and costs zero. The basis is essentially
  every `packages/web/src/lib/video/**` file, so this applies to most of the
  cohort — and it means range fixes on these cards are free rather than deferred
  to an attest window.

---

## 5. THE VERDICTS

| module | verdict | body role | width earned | risk | est. |
|---|---|---|---|---|---|
| `videovarispeed` | **PROMOTE** — no precursor | `picture` | YES | MED-HIGH | — |
| `videobox` | **PROMOTE + contract change in the SAME PR** (the `twotracks` shape) | `picture` | YES | MEDIUM | — |
| `archivist` | **PROMOTE-WITH-PRECURSOR** (PR A: `uGain`) | `picture` | YES | MED-HIGH | — |
| `peertube` | **PROMOTE-WITH-PRECURSOR** (PR A + PR B: browse registry) | `picture` | YES | MED-HIGH | — |
| `tvLibrarian` | **PROMOTE-WITH-PRECURSOR** (make `gain` work) | `picture` | YES | MEDIUM | ≈12 h |
| `recorderbox` | **PROMOTE-WITH-PRECURSOR** (extract record transport) | **`status-primitive`** | **NO** | MED-HIGH | ≈13 h |

**Every one is promotable. None asks for a platform capability.** That is the
wave's practical result, and it is the direct consequence of §0.

### 5.1 ⚠ THE REAL SHARED CAPABILITY IS A THREE-LINE SHADER FIX, NOT A CONTROLLER

The convergence nobody predicted: **`gain` is DECLARED-BUT-DEAD on four of the
six** — `archivist`, `peertube`, `videobox` and `tvLibrarian`. `archivist`'s own
`docs.controls.gain` admits it (`archivist.ts:199`: *"Reserved in v1 — declared on
the module…"*), and `tvLibrarian`'s def says outright that *"the passthrough
shader does not currently read it (no uGain uniform)"* (`tv-librarian.ts:160`).

A face **must rank every param**, and there is no honest way to rank a control
nothing consumes. So the same three-line `uGain` wiring is a precursor for four
modules — and because these defs are in the WebGL attest basis, **it is ONE attest
window for four modules if scheduled together, or four windows if not.**

That is a far more actionable scheduling output than the capability this wave was
sent to define, and it was invisible until four specs were written side by side.

⚠ **And the tempting fix is a green gate certifying a live bug**: declaring
`noUserControl` with `writer: 'internal'` PASSES, because `no-user-control.ts:121`
only checks that no port targets the param. It would green the gate and leave the
control dead — CLAUDE.md's *"before 'fixing' a declaration to satisfy a gate,
check the consumer reads it"*, found in the wild.

### 5.2 ⚠ `needs-note-entry-cell` IS OVER-DECLARED ON THIS COHORT

Two agents reached this from opposite ends and it resolves cleanly.

The `blockers` field **cuts this cohort on typed text** (§2.1) — but the cut is
wrong, and the resolution is a **SLOT/CELL distinction**, not a judgement call.

The blocker's capability text is scoped to **CELLS**. A `fullViewBody` is a
**slot**: it satisfies no cell contract and needs no probe. It is an ordinary
Svelte component, so it can carry an `<input>` today. **The blocker is real — it
is simply not in these modules' way**, because none of them needs a typed cell in
a LANE.

⚠ **It is unprecedented and worth flagging as such: no existing `fullViewBody` in
the tree contains a text input.** Legal, ungated, and first-of-kind — so the first
face to do it should expect review attention even though nothing refuses it.

⚠ And it is a **different route from wave 5's `score`**, which cleared the same
blocker by typing nothing at all. These modules do type; they clear it on the slot
boundary. Two independent routes past one blocker is decent evidence the blocker
is over-declared rather than that everyone is finding loopholes.

**Recommendation: drop `needs-note-entry-cell` from `archivist` and `peertube`'s
`blockers` arrays when their faces land.** `recorderbox`'s filename field is the
same argument. That leaves the blocker meaning what it says, for the modules that
genuinely need a typed cell in a LANE.

---

## 6. WHAT NEEDS AN OWNER DECISION

**Two. Both are about §4.1's exhaustive list, both are cohort-level, and neither
blocks any face** — every spec is written so it can go either way without
restructuring.

### 6.1 ⚠ Is a NETWORK-FETCHED ITEM TITLE permitted resting text, as a NAME?

Applies to `archivist` and `peertube` and to nothing else in the fleet.

* **The permitting reading:** it is an option NAME that disambiguates a control's
  own position, and the shipped precedent is `cameraInput`'s **device names** —
  also runtime-enumerated content the app did not author, and already
  roster-reviewed and accepted.
* **The refusing reading:** it is third-party content, not a name the module owns,
  and §4.1's list is exhaustive on purpose.

⚠ **The costs are asymmetric and that is the substance of the decision.**
`peertube`'s usability is materially worse under the refusal — a result list whose
rows cannot be named is a list of thumbnails. `archivist` is less affected.
Neither face is blocked either way.

*(The related STATION-name question on `tvLibrarian` was SETTLED rather than
escalated, with a discriminator that reproduces every settled fleet case: **text
inside a control that selects it is an option name; the same text painted outside
every control, restating what is selected, is a readout.** So list rows keep their
names — the picturebox per-slot-filename precedent — and the NOW PLAYING label
goes. If 6.1 is refused, that discriminator is what has to give way, so the two
questions should be answered together.)*

### 6.2 ⚠ Is "REQUIRED LEGAL / ATTRIBUTION TEXT" a permitted resting-text role?

`tvLibrarian` paints a legal disclaimer plus Famelack / iptv-org attribution
(`TvLibrarianCard.svelte:573-578`). Under §4.1's exhaustive list it has **no
permitted role** — it is not a module name, a section label, a control caption or
an option name — and the dataset's licence requires it.

The decision is needed precisely **because no gate will ever ask.** Body text is
`face-resting-text-source`'s stated blind spot, so it ships green whichever way it
goes, and a future reviewer applying the ruling literally would delete it and
create a licensing problem. `peertube` almost certainly has the same question.

**Nothing in either spec depends on the answer** — both are written so the text
can stay or go without restructuring.

---

## 7. BUILD ORDER

1. **PR A — the shared `uGain` wiring**, ALONE (`archivist`, `peertube`,
   `videobox`, `tvLibrarian`). Three or four lines per module, **byte-identical at
   defaults** (1.0 is the only value any node holds), and **ONE attest window for
   four modules** instead of four. The pattern already shipped in
   `picturebox` / `cameraInput` / `loopback`. Blocks four faces; nothing blocks it.
2. **`videobox`** — face + `gain` contract change in ONE PR (splitting them leaves
   a face that cannot pass `module-face-lint` for the duration of the split).
   ⚠ Build it **before** `videovarispeed`: it is smaller, it settles the shared
   body shape for both, and its lane/host arrangement is *already asserted on main*
   by `workflow-shell-video.spec.ts:1361-1381`. It is also the one that spends the
   GPU — **let its attest settle before `videovarispeed`'s PR 2 goes near a basis
   file.**
3. **`videovarispeed`** — the only unconditional PROMOTE (its PR 1 face is
   attest-ZERO; PR 2 carries the SPEED landmark roster, which is ordinary code in
   `params[]` and therefore is not).
4. **`peertube` PR B** — `$lib/ui/media/peertube-browse-registry.ts`, `lib/ui/**`
   only so zero attest. ⚠ **Must land before the face** (§8).
5. **`peertube` face**, then **`archivist` face** — in that order. `peertube` is
   the lower-risk of the pair (its preview is the ordinary blit; `archivist` must
   ADOPT), so it settles the shared browser body first.
6. **`tvLibrarian`** — after PR A.
7. **`recorderbox`** — precursor extracts the record transport off the card. It is
   the wave's **highest-care** item despite having the smallest surface, because
   the precursor touches the code path that writes the user's file.

⚠ **Two specs share `collapse-keeps-playing.spec.ts`** (`videovarispeed` and
`videobox` are its entire enrolled population), and promotion breaks it two ways
**with the GREEN failure masking the RED one**: enrolment is DOM-derived from the
dock pane (`:441-447`) and degrades to `test.skip` (green and blind), while the
`<video>` assertions are dock-scoped (`:456`, `:492`) and the element lives in the
headless host (red). **The green failure fires first.** Whichever of those two
lands first owns fixing that sweep — CLAUDE.md's green-and-blind class, live, on
the sweep that guards an owner P0.

### 7.1 ⚠ `varispeed-panel-layout.spec.ts` — DELETE IT, and this is the precondition class exactly

Its `CARDS` table is now **one element, and it is `videovarispeed`** —
`picturebox`'s row was retired 2026-08-24. **Promotion empties the table.**

And it does not go red: the spec boots `?shell=legacy` through the `rack` fixture
(`_fixtures.ts:93`), so it goes **GREEN AND BLIND.** `grep -rln multiOpen` returns
exactly two cards, one already faced — so the overlay-sheet technique's last
living subject dies with this promotion.

**Verdict: delete the spec file, say so in the PR body, and do NOT re-point it at
`picturebox`.** Re-pointing is the move CLAUDE.md warns about — fixing the
threshold instead of the subject — and here there is no honest subject left.

*(It also answers `picturebox`'s open M1: `varispeed-panel-layout.spec.ts:56`
presses Escape *"to dismiss the node context menu the right-click also opened"* —
outcome (1), both fire.)*

---

## 8. ⚠ THE ONE DEFECT A FACE *CREATES* — and it would ship green

**`peertube` promotion turns the module into a SEARCH-REQUEST GENERATOR against a
third party.** `nextResult()` falls back to `runSearch()` on an empty `results`;
`results` is card-local Svelte `$state`; after promotion the search runs in the
body. So **a clock patched to `next_trigger` fires a fresh Sepia Search per
pulse**, bounded only by the module's own limiter at **5 requests/second to
someone else's server.**

⚠ **It would ship GREEN.** No spec drives it, and all three `peertube` e2e specs
boot `?shell=legacy` — the shell where the defect cannot exist.

This is why `peertube`'s PR B (`$lib/ui/media/peertube-browse-registry.ts`) is
**not an optimisation and must land BEFORE the face**: otherwise the face PR is
simultaneously the cause and the cure, which is not a reviewable change. It is
also the cleanest instance in the wave of the class CLAUDE.md names — *a gate
whose precondition is the defect cannot fail on the defect* — arriving from the
other direction: here the precondition (`?shell=legacy`) means the gate cannot
fail on a defect that only exists in the OTHER shell.

---

## 9. DEFECT LEDGER — live on `main`, independent of any face

1. ⚠ **`recorderbox`: all three `node.data` writes are un-undoable.** `setData`
   (`RecorderboxCard.svelte:144-151`) is a bare proxy write — no `transact`, and
   `LOCAL_ORIGIN` appears **zero** times in the file. It covers `filename`,
   `quality` and **`recording`** — the last with irreversible disk side effects.
   *(Independently verified by the orchestrator.)*
2. ⚠ **A FOURTH `.data` census state, inside ONE file.** `tvLibrarian`'s
   `writeCountry` (`:168`) and `writeChannel` (`:185`) are correctly
   `LOCAL_ORIGIN`-tagged; its corner-resize `apply` (`:447-453`) is a bare proxy
   write. **Discipline is per-CALL-SITE, not per-module** — which the running
   `.data` census (wave 3 → 4 → 5) has been recording as a per-module binary and
   therefore cannot express. `archivist` has the identical split (four content
   writers correct, the resize writer bare). ⚠ **It is fleet-wide: all 15
   `startCornerResize` callers have it.** The defensible reason is that it fires
   per `pointermove`; the fix is `DetachedDisplay.svelte:121`'s shape — commit
   once on `onEnd`. Scoped per module in each PR; the sweep is separate.
3. ⚠ **`gain` declared, exposed nowhere, read by nothing** on four modules — §5.1.
   `videobox`'s is the cleanest instance: a declared param **nothing writes and
   nothing reads**, with no truthful `noUserControl` writer available.
   `contract-lock.txt:3562` is the one line that goes.
3b. ⚠ **`videobox`: `fullFrame` (`:701-708`) and `width`/`height` (`:744-751`) are
   BARE PROXY WRITES** while `writeSync` / `writeFileMeta` on the same file are
   correctly origin-tagged. **Cmd-Z cannot undo a Full Frame toggle or a resize.**
   Same per-call-site shape as (2), from a third module.
3c. **`videovarispeed`'s prose describes behaviour the code REVERSED** — the file
   header (`:49-50`) and `DESCRIPTIONS` (`module-manifest.ts:306`, capitalised
   *"RESTARTS IT FROM THE BEGINNING"*) both promise the opposite of what ships.
   ⚠ `module-docs-lint` reads the **DEF**, so it is structurally blind to both —
   the modtris/score class.
3d. **`Canvas.svelte:2880-2887` is a dead branch with a stale comment** —
   `videoOut` is faced, so `NON_SHELL_LANE_TYPES.has('videoOut')` is false and no
   `VIDEO_ZONE_DEFAULTS` member is in that set. `videoOut` residue; routed out of
   this wave as owner cleanup.
4. **`recorderbox`'s stale `why` appears in three places** — the inventory
   (`:1029-1034`), the card's own header (`:8-10`, contradicted 85 lines later),
   and the VRT mask `why` (`vrt-exemptions.ts:118-124`). §2.2.
5. **`tvLibrarian`: tuning does not scroll the selected row into view** (`:563`) —
   which is what makes removing the NOW PLAYING label safe.
6. **The `_face-fixtures.ts` `DENIED` entry goes INVISIBLE, not red, on
   promotion** — the third instance of a class that file documents twice
   (`audioOut`, `twotracks`). Must be deleted by hand in each face PR.

7. ⚠⚠ **`archivist` is NOT multiplayer-aware for item loading, and three places
   claim it is.** It has no `$effect` on `item` (its three effects are: adopt,
   class-toggle, isPlaying-sync). **A peer's selection writes `node.data.item` and
   no element ever gets a `.src`.** ⚠ `peertube` HAS the effect (`:482-491`);
   `archivist` does not — the defect was found only by reading the two side by
   side, which is the argument for pairing siblings in one agent. It is also
   exactly the seam the body needs, so the face PR fixes it as a matter of course.
8. ⚠ **`strict-faces.ts:835-837` and `picturebox.ts:309` assert that "a video def
   has no `audio` output"** as the reason `glyph:'none'` is forced. **That is
   FALSE for `archivist`, `peertube`, `videocube`, `milkdrop`, `nibbles` and
   others.** They reach the right answer for a reason that is not true of them —
   the real reason is that `laneGlyphFor` returns `'picture'` before it ever
   consults `face.glyph`. A correct conclusion resting on a false premise is the
   thing that breaks the next time someone reasons from the premise.
9. Minor: `archivist-query.ts:8-9` has a truncated citation; both
   `docs.explanation`s describe a card UI the promoted module will not have; and
   `peertube`'s progress bar is a read-only fill where the honest fix and the
   ruling-compliant fix coincide (make it a real seek control, gated on an
   HLS-seek measurement).

### ⚠ TWO STANDING CLAIMS CHECKED AND FOUND STALE

Both were VERIFIED rather than repeated, which is the only reason they are here.

* *"Recorderbox capture fix — wiring + owner hw-verify remain"* — **the WIRING
  LANDED** (#1574/#1584, #1802, #1846; the e2e drives the real chain with a
  real-encode gate). Only the hardware verification is outstanding, and that is
  not confirmable from the tree.
* *"peertube: BUILT #786 but BROKEN (no audio + red CI)"* — **STALE ON BOTH
  HALVES.** Audio is fixed *and guarded*: `peertube.spec.ts:273-377` asserts
  `peak > 0.01` at AUDIO OUT and `muted === false` over the real HLS path. The
  "red CI" is a named, budgeted codec-capability skip
  (`e2e-skip-budget.mjs:354-361`). ⚠ **The false version is written into
  `_face-fixtures.ts:111-113`**, which additionally claims both modules *"fetch at
  mount"* — neither does, and that same claim is what makes their VRT capture
  possible.
