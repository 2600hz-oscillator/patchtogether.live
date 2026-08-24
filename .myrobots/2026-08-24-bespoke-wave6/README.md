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

<!-- WAVE-6-VERDICTS: filled from the three agents' returns -->

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

## 5. WHAT NEEDS AN OWNER DECISION

<!-- WAVE-6-OWNER-DECISIONS: filled from the three agents' returns -->

---

## 6. BUILD ORDER

<!-- WAVE-6-BUILD-ORDER: filled from the three agents' returns -->
