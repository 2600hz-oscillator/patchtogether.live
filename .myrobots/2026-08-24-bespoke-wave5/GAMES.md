# WAVE 5 — THE GAME GROUP: `frogger` · `modtris` · `skifree` · `nibbles`

> **SPEC + MOCKS ONLY. Nothing here is implemented.** Four bespoke-faceplate specs plus
> this shared analysis. Every per-module spec references this file rather than repeating it.
>
> **Direct precedent:** `.myrobots/2026-08-23-bespoke-wave1/pong/spec.md`. `pong` is the
> same class — an audio-domain arcade game whose court lives on its card — and where a
> conclusion transfers, it is CITED rather than re-derived. The value of this group is the
> **four places pong's argument does not transfer**, and those are §2, §4, §5 and §6.

⚠ **DOOM IS EXCLUDED FROM THIS GROUP BY NAME.** Standing owner ruling (2026-08-17): DOOM is
not to be touched — code, specs, waits or timing — without specific approval. It is a game
module and would otherwise fall inside every sweep in this file (the resting-text ruling, the
lane-picture table, the determinism story, the VRT exemption lists). **It is excluded
deliberately, no file of its was opened, and no recommendation here applies to it.** The
mechanical reason the exclusion matters rather than being politeness: DOOM's game clock IS its
frame clock, so any re-timing re-specifies the game itself. A silent inclusion is the failure
mode even when the change is otherwise correct.

---

## 0. THE FOUR, AND THE VERDICTS

| module | domain | params | playfield lives | verdict |
|---|---|---|---|---|
| [`frogger`](frogger/spec.md) | audio | **1** (`initialTime`) | CARD canvas, painted by the def's own pure `drawFrogger` | **PROMOTE** — the cheapest face in the wave, one knob and a body |
| [`modtris`](modtris/spec.md) | audio | 2 (`gravityBpm`, `levelStep`) | CARD canvas, `drawModtris` | **PROMOTE — but the PR carries a named PRECURSOR** (§6) and a dead control (§8.2) |
| [`skifree`](skifree/spec.md) | audio | **0** | a THIRD-PARTY BUNDLE the CARD instantiates | **REFUSE / BLOCKED** — promotion deletes the game, and the face resolves to zero controls at every tier |
| [`nibbles`](nibbles/spec.md) | **video** | 2 (`auto`, `tick_ms`) | the MODULE's own GL surface | **PROMOTE** — the only lane picture in the group, and the only module whose determinism seam already exists |

Three promote, one refuse. **The refusal is the most valuable of the four**, because the
thing that blocks it is invisible to two deny-by-default gates that both read green (§5).

---

## 1. ⛔ THE GAME-SCORE QUESTION — RULED, AND THE GATE CANNOT SEE EITHER ANSWER

Every one of these modules has a SCORE and a LIVES count. The no-resting-derived-text ruling
has now been given four times about four different mechanisms, and each new mechanism passed
the gate written for the previous one — so the question "is a game score allowed on a
faceplate?" is exactly the shape that has gone wrong four times. **It is ruled, and the ruling
is a distinction, not a permission.**

### THE RULING

- A game's **score and lives painted INSIDE the playfield canvas are ALLOWED.**
- A score or lives row rendered as **CHROME BESIDE the playfield is FORBIDDEN.**

### WHY THE LINE FALLS THERE

The no-resting-derived-text ruling governs **faceplate CHROME** — text the FACE paints in
order to describe module state. Its permitted list is exhaustive: the module NAME (dock title
bar), TAB/SECTION labels, CONTROL CAPTIONS, and option/landmark NAMES that disambiguate a
control's own position. **A score row is none of those four.** As chrome it is refused, and it
is refused for exactly the reason the hero readout strip was deleted (#1957): a labelled
derived value sitting at rest next to the thing it describes. `LEN 4`, `lives 3`, `280m` are
that shape verbatim.

Pixels the MODULE renders into its OWN surface are a different object. They are the module's
**artwork**, not the face's chrome. A playfield with its score in it is ONE PICTURE, and that
picture is the thing that earns the width (§3 of the compact ruling: *"a genuine earner is a
live picture"*). The face is not painting the number; the game is. That distinction has a
settled in-repo precedent — a game module whose HUD is drawn inside its own surface, which
nobody has ever argued violates the readout ruling — and the principle is cited here without
naming or opening the module, because it is DOOM and DOOM is off-limits.

### ⚠ THE GAP, STATED RATHER THAN IMPLIED

`face-resting-text-source.test.ts` **cannot see either shape.** It states its own blind spot
in its own words: *text drawn INTO a canvas (a glyph, a video surface, a shell extension's
`fullViewBody`) is invisible to it*. And a chrome row inside a `fullViewBody` is bespoke
module-owned markup, not a `ModuleFace` field — the gate denies the SHAPE of a declared face
FIELD, which is why it is robust against a fifth mechanism, and it is precisely why it has no
purchase on a component the module ships itself.

**So this ruling is enforced by the dock VRT baselines and a human reviewing them, and by
NOTHING ELSE.** No spec in this wave may claim otherwise. Writing "the resting-text gate keeps
this honest" would be a spec relying on a gate that structurally cannot check its rule, which
is the failure this repo cares most about.

The honest mitigations, and they are weaker than a gate — say so in each PR body:

1. the two dock baselines (`face-<t>-dock.png`) DO contain the body, so a chrome row appears
   in a reviewable diff;
2. each module's `<mod>-face-model.test.ts` can assert the body's DOM contains no
   `.score`-class element — a source-shaped check the module owns, negative-controlled by
   temporarily re-adding one;
3. the accessible name carries the number instead (§1.1), so removing the paint costs no
   assertion.

### 1.1 WHERE THE NUMBER GOES INSTEAD

`aria-label` on the playfield (`role="img"`), not `aria-valuetext` — a picture is not a range
role (the `XyPad.svelte` conclusion pong's §10 cites). Speakable, assertable, unpainted. Every
spec in this wave reads the score from there, so no assertion had to be weakened.

### 1.2 HOW THE FOUR ACTUALLY SIT TODAY — MEASURED, AND THEY DO NOT AGREE

| module | score/lives painted where | verdict under the ruling | what the face must do |
|---|---|---|---|
| `frogger` | **INSIDE the canvas.** `drawFrogger` `hud` block: `LIVES n LV n T n` at 4,6 and `SCORE n` right-aligned, plus a centred `PRESS START` / `GAME OVER — START GATE TO RESTART` banner (`frogger.ts:427-441`) | **ALLOWED as-is** | nothing — carry `drawFrogger` into the body unchanged, `hud: true` |
| `modtris` | **INSIDE the canvas.** the right strip: `NEXT`, the next-piece preview, `LN` + `state.lines` (`modtris.ts:329-354`) | **ALLOWED as-is** | nothing — carry `drawModtris` unchanged |
| `skifree` | **DOM CHROME.** `.skifree-hud`: `{distance}m`, `· lives {n}`, a `CV`/`MOUSE`/`IDLE` mode word, and `GAME OVER` (`SkifreeCard.svelte:203-210`) | **FORBIDDEN** | the row does not survive; §1.3 |
| `nibbles` | **DOM CHROME, and there is NO in-canvas fallback.** `.score`: `LEN {n}` + a `†` dagger when dead (`NibblesCard.svelte:136`). `paintFrame` draws background, border, food, snake and scanlines — **zero text** (`nibbles.ts:514-552`) | **FORBIDDEN** | §1.3, and it is the expensive one |

⚠ **The ruling's escape hatch is NOT free for nibbles, and that is a real finding rather than
a footnote.** "Put the score in the canvas" is a `nibbles.ts` code edit — `paintFrame` would
have to rasterise glyphs — and `nibbles.ts` is **IN the WebGL attest basis** (§7, measured).
So the one module in this group that most obviously wants an in-canvas score is the one where
adding one costs an owner-machine GPU re-attest that CI cannot run. **Do not fold that into
the face PR.** The face PR removes the chrome row and puts `LEN` in the accessible name; a
painted score is a separate, owner-facing question with a GPU cost attached.

### 1.3 EACH SPEC MUST REFUSE THE CHROME ROW EXPLICITLY

A spec that simply never mentions a score row reads as an oversight, and this is the class
where an oversight has cost four rulings. **All four per-module specs name the ruling and
refuse the row by name**, including the two whose canvas already satisfies it — because
"frogger's HUD is fine" and "nobody looked at frogger's HUD" are indistinguishable from the
outcome.

---

## 2. ⚠ THE SAME REQUIREMENT, TWO COMPLETELY DIFFERENT MECHANISMS — AND THIS GROUP HAS BOTH

Every module here needs the same thing: **a game must be visible to be a game.** That
requirement resolves by two mechanisms that share no code, and the group contains both. This
is the contrast the group exists to produce.

### 2.1 The VIDEO half — `nibbles`

```
module-shell-model.ts:177-179   hasVideoSurface(def) → def?.domain === 'video'
module-shell-model.ts:237-240   laneGlyphFor(def)    → 'picture' when hasVideoSurface
ModuleShell.svelte              <VideoTileThumb nodeId={id} />
```

`domain === 'video'` is the **whole** condition. No opt-in, no face field, no port check — and
the thumb takes `nodeId`, so the picture is per-node by construction. `nibbles` is
`domain: 'video'` (`contract-lock.txt:2347` — `nibbles meta domain=video`), so **its lane tile
paints its own live game** the moment it is promoted, with nothing declared.

⚠ Counter-intuitively the def must declare **`glyph: 'none'`**. `primaryAudioOutPortId`
matches `type === 'audio'`; nibbles HAS two audio outs (`snake`, `gated`) — see §2.3 — but a
video-domain def takes the `hasVideoSurface` branch first (`laneGlyphFor` returns `'picture'`
before it ever looks at `face.glyph`). Declaring anything else is a trace that can never
render. **Assert `hasVideoSurface`, never infer the picture from the declaration** — `'none' +
blank tile` and `'none' + live thumb` are indistinguishable from the face's own text.

### 2.2 The AUDIO half — `frogger`, `modtris`, `skifree`

All three are `domain: 'audio'` (`contract-lock.txt:1249`, `:2022`, `:2992`). So
`hasVideoSurface` is false, there is no engine surface, and **the shell has nothing to paint.**
This is #2065 (`spectrograph`) verbatim: *an audio-domain module with video-family ports has
no engine surface for the shell to paint.*

Their playfields reach the dock through the **`fullViewBody` shell-extension slot** and reach
the lane **not at all**. `ShellExtension.glyph` cannot help: it renders only under
`binding.kind === 'algorithm'`, and `ShellExtensionGlyphProps` carries `num` / `numbers` /
`testid` and **no `nodeId`**, so every instance of a module would draw a byte-identical
picture — the platform fact waves 2 and 3 refused a lane picture on, five times.

⚠ **frogger and modtris are the SIXTH and SEVENTH modules to hit it** (after `scope`,
`rasterize`, `wavesculpt`, `timelorde` and `pong`). That is not a per-module footnote any
more; it is the strongest standing argument for the `nodeId`-on-`ShellExtensionGlyphProps`
escalation waves 2 and 3 nominated. **No spec here asks for it or depends on it.**

### 2.3 ⚠ AND THE THING THAT LOOKS LIKE IT SHOULD DECIDE IT, DOES NOT

The intuitive rule is *"the module with video ports gets the picture."* **It is false in both
directions in this group, and both counter-examples are here on purpose:**

- **`skifree` DECLARES A `video` OUTPUT PORT** (`contract-lock.txt:2996` — `skifree out out
  video`) and gets **no** lane picture, because it is `domain: 'audio'`. Its `out` is a
  cross-domain bridge source (`videoSources` + `drawFrame`), which is a port a video cable
  consumes — not a surface the shell can blit.
- **`nibbles` DECLARES TWO `audio` OUTPUTS** (`snake`, `gated`) and gets the picture anyway,
  because it is `domain: 'video'`.

So the predicate is the DOMAIN and only the domain, and the port list is a decoy. Every one of
these four declares `vizPassthrough: true` as well (except nibbles, which does not need it) —
also not a factor, and §8.1 is about how little that flag actually does.

---

## 3. THE LANE-PICTURE DECISION TABLE — four rows, resolving by three different mechanisms

| module | outputs | glyph resolves | lane picture | why |
|---|---|---|---|---|
| `nibbles` | `out` video · `pellet`/`death`/`dir_change` gate · `length_cv` cv · `snake`/`gated` audio | **`hasVideoSurface` → `'picture'`** | ⚠ **ACCEPTED** | `domain: 'video'` is the whole condition. `face.glyph: 'none'` is MANDATORY. **2 params + a glyph exactly fills `LANE_ROW_MAX_CELLS_WITH_GLYPH`**, so at `compact` the tile is picture + TICK + AUTO with **nothing evicted** — the #1785 picture-outranks-controls rule never has to fire. |
| `frogger` | 3 × `gate` — **no `audio`** | every literal → dead static | **REFUSED** | `domain: 'audio'` ⇒ no surface; `primaryAudioOutPortId` is null ⇒ every glyph literal but `'none'` reddens the dead-glyph clause. The board is dock-only via `fullViewBody`. |
| `modtris` | 2 × `gate` — **no `audio`** | every literal → dead static | **REFUSED** | identical to frogger, same two reasons. |
| `skifree` | `gate` + **`out` (video)** | every literal → dead static | **REFUSED, and by a THIRD route** | not merely un-paintable: **there is no picture to paint without the card** (§5). Even a `nodeId` glyph prop would draw nothing, because the producer of the pixels is not the module. |

⚠ **The test of whether these are arguments rather than copies is that they resolve by
different mechanisms**, and they do: nibbles by DOMAIN, frogger/modtris by the missing engine
surface, skifree by the missing PRODUCER. Waves 2, 3 and 4 held the same bar.

---

## 4. DETERMINISM — the group's real technical risk, and FOUR different stories

pong's §11 established the shape: a live game surface is not pixel-deterministic, the
comparison class is `analogVco` (**254 / 154 / 315 px across three consecutive captures of the
same tile**), and the mask mechanism is `VRT_LIVE_SURFACES`. ⚠ **None of these four is in
`VRT_LIVE_SURFACES` today** (grep: zero hits), and none should go there — a mask is the answer
for a surface that cannot be pinned, and three of these four can.

### 4.1 ⚠ THE CORRECTION THAT MATTERS MOST — an audio suspend does NOT stop these games

The natural assumption, and the one `rasterize`'s roster entry would lead you to, is that
suspending the AudioContext freezes an audio module's picture. **It is false for every game in
this group, measured at the source.**

`scheduler-clock.ts` drives `dispatch()` from a **Web Worker `setInterval`** (`:78`,
`WORKER_SOURCE`), with a plain `setInterval` fallback (`:151`). `dispatch()` (`:101-118`)
iterates its subscribers **unconditionally** — there is no AudioContext state check anywhere
in the file. `frogger`, `modtris` (and `pong`) subscribe to that clock in their factories, so:

> **The game clock is independent of the AudioContext AND of rAF.** `freezeAudio: true`
> cannot hold it, `freezeFaceVideo` cannot reach it, and a scene that captures "after the
> suspend" is capturing an unknown number of elapsed ticks.

The only seam is **module-side**: a `freeze` early-return inside the subscribed `tick`, which
is exactly what pong's §5.1 proposes and the same reason it proposed it. ⚠ **Do not assume
pong's `freeze` design is a convenience — it is the ONLY mechanism, and this measurement is
why.**

### 4.2 The four stories

| module | is the game already deterministic? | what a capture needs | cost |
|---|---|---|---|
| **`frogger`** | ⚠ **YES, COMPLETELY.** `grep -n "Math.random\|rng\|seed" frogger-state.ts` → **zero hits.** The stepper has no RNG at all, and `dtSeconds = SCHEDULER_TICK_MS/1000` is computed once (`frogger.ts:195`) and never measures elapsed time — so the board is a **pure function of TICK COUNT**. | a **TICK PIN ONLY**: a `freeze` early-return plus a fixed tick budget. **No seed, because there is nothing to seed.** | the cheapest determinism seam in the wave |
| **`modtris`** | half. `initModtrisState({rng})` and `stepModtrisState(…, {rng})` **already accept an injectable RNG** (`modtris-state.ts:177-178`, `:336-338`, defaulting to `Math.random`) — and the factory calls both with **none** (`modtris.ts:173`, `:194`). Same shape as pong's. | seed pin **+** tick pin. Two lines in the factory for the seed, plus the `freeze` early-return. | pong's cost, exactly |
| **`skifree`** | **NO, AND THERE IS NO SEAM TO BUILD.** the game is a committed pre-built third-party IIFE (`/skifree/skifree.bundle.js`, ~24 KB) that self-drives on its own rAF inside the bundle. Nothing in this repo owns its clock or its RNG. | a determinism hook inside a vendored bundle — i.e. a fork of the upstream, or a re-build recipe change. | ⚠ **out of scope for a face PR by a wide margin.** Its `EXEMPT_FROM_VRT` entry names this exact condition and it is not dischargeable here. |
| **`nibbles`** | ⚠ **THE SEAM ALREADY EXISTS AND IS ALREADY PROVEN.** `__nibblesVrtSeed` (`nibbles.ts:245-249`, `:283-292`) pins the RNG; `__videoEngineFreezeTime` pins `frame.time`, so `dt === 0`, `tickAccumS` never reaches `tickPeriodS`, and the snake never steps. | **declare the pair in the FACE roster's `simPin` and nothing else.** No new param, no new code. | **ZERO**, and the pair is already reviewed |

### 4.3 ⚠ nibbles' pin is proven in BOTH directions, by a measurement already in the tree

`.myrobots/2026-08-23-nibbles-composite-vrt-nondeterminism.md` is the diagnosis and the fix for
`composite-nibbles-length_cv-driven`, and it carries the byte-level result:

| tree | run A | run B | verdict |
|---|---|---|---|
| pre-fix (neither global pinned) | `2ed942ac…` | `62fc8ce5…` | **differ** |
| post-fix (both globals pinned) | `14256032…` | `14256032…` | **identical** |

Two things about that record are load-bearing for the nibbles face:

1. **BOTH halves are required.** The seed alone fixes *which* pellets spawn, not *how many
   ticks elapsed*; the clock alone stops the stepping but leaves the seed on `Date.now()`.
   That is the `mirrorpool` lesson (three globals, each necessary) reached independently.
2. ⚠ **The seed must be set BEFORE spawn.** `maybeApplyVrtSeed` re-seeds `state` on a later
   draw frame but does **not repaint**, so a post-spawn pin leaves the original `Date.now()`
   frame on screen. `simPin` installs via `addInitScript` before `goto`, which is strictly
   earlier than any `afterSpawn` hook manages — so the face path gets this right where the
   card scene's `afterSpawn` had to work around it.

### 4.4 The roster contract, for all three promotions

- **`videoFaceWhy` is MANDATORY for `nibbles` and FORBIDDEN for `frogger`/`modtris`.** It is
  the **video-zone boot selector first** and the freeze opt-in second. A video module that
  omits it takes the AUDIO boot path, which waits — with no explicit timeout, inheriting the
  90 s test timeout — for a `pinned-mixmstrs` channel-column membership a video node never
  acquires. A `domain: 'audio'` module that declares it hangs the same way in reverse.
  `rasterize` is the shipped precedent for the audio side: an audio module with a card-drawn
  canvas, a `fullViewBody`, a `simPin`, and **no** `videoFaceWhy`.
- `FACES_WITHOUT_SCENES` is **not available to any of the three**. Its bar is *evidence that
  `simPin` AND `freeze` cannot reach this renderer*. For frogger, modtris and nibbles both
  can — they simply are not wired yet (nibbles' are wired elsewhere). Claiming it would be the
  argument made by a module that does not qualify.

### 4.5 What promotion does to the exemption lists

`frogger`, `modtris` and `skifree` are all in `EXEMPT_FROM_VRT` **and** in
`ALLOWED_PERMANENT_EXEMPT` (`vrt-exemptions.ts:756`, `:769`, `:778`, `:1176`). The two lists
are anchored in both directions — an entry naming a non-exempt module is RED — so they can only
ever move together, in one commit.

⚠ **Two of those entries state their own discharge condition verbatim.** frogger:
*"Promote to a real VRT baseline once a deterministic-time test hook is added so the scene can
freeze the game at a known tick."* skifree: *"once a deterministic-time render-freeze hook is
added so the scene can be pinned at a known frame."* **frogger's PR builds exactly that hook**
(§4.2), so its card exemption should be re-examined in the same PR — and if it is dropped, the
capture commits **three** PNGs (two face scenes + a first card baseline), not two. Predict the
count and check it. skifree's condition remains genuinely unmet.

`nibbles` is in **neither** list: it has a committed card baseline
(`vrt.spec.ts/nibbles.png`), five composite baselines (`nibbles-cv-{min,25,50,75,max}.png`) and
four coverage baselines. Its card scene is captured at `/rack?shell=legacy`, so **promotion
does not move it** — the two face scenes are purely additive.

---

## 5. ⚠ THE PLATFORM FINDING: `skifree`'s CARD IS A PRODUCER, AND TWO DENY-BY-DEFAULT GATES CANNOT SEE IT

This is the largest thing in the wave and it is a live defect, not a promotion cost.

### 5.1 What is true

`SkifreeCard.svelte` **owns the entire game**: it injects the bundle `<script>`, calls
`window.SkiFree.create({ canvas, …})` against its own canvas, and publishes the controller on
the shared bridge (`:115-126`). The factory (`skifree.ts`) only READS it — `ctl.getState()` for
the snapshot, `ctl.setCursor()` for the CV cursor, `bridge.controller.canvas` as the blit
source for the `out` video port (`:225-227`).

**No card ⇒ no bundle ⇒ no controller ⇒ no game.** Not a missing picture — a missing module.
The snapshot freezes at its construction defaults, `out` stays black (`drawFrame` returns
early when `src` is falsy), and `gate` — the module's only trigger output — never fires,
because `onGate` is invoked by the controller the card created.

### 5.2 Why nothing catches it

Two gates own this class, both deny-by-default, both anchored in both directions, both green:

| gate | what it greps | why skifree is invisible |
|---|---|---|
| `dom-source-modules.test.ts` → `CARD_PRODUCER_LANE_TYPES` | a DERIVED set: exactly two `PRODUCER_SEAMS` — `/\bwrite\s*\(\s*(?:node\|id\|nodeId)\s*,/` and `/\binstall\w*FrameDrawer\s*\(/` — searched over each card's **`.svelte` component subtree** | skifree's producer statement is `bridge.controller = controller`, reached through **`$lib/audio/skifree-bridge.ts` — a `.ts` file.** The `.svelte`-only boundary is deliberate and argued in the gate's own header (following `.ts` edges enrols all 195 cards), so this is a **structural** blind spot, not an oversight |
| `card-media-lifetime.test.ts` → `EXTRAS_OWNERS` | every card that calls `read(id, 'extras')`, one typed verdict each | `SkifreeCard` never calls `read(…, 'extras')` — it uses the `window.__skifree` global instead, so it is **not on the channel at all** and the deny-by-default map never asks about it |

**A third, independent seam exists in this repo and neither gate knows the shape.** That is
the finding: `CARD_PRODUCER_LANE_TYPES` is honestly derived and its enumeration of *seams* is
the filter that redefines its subject — the exact Pattern-5 shape (*"a filter applied before
the check redefined the check's subject"*).

⚠ **And the repo has already written the consequence down without connecting it.**
`skifree-bridge.ts:26-28`, in its own header: *"Under the faceplate shell that is not an edge
case: an un-migrated module's card exists only inside the dock full-view, so COLLAPSE unmounts
it — and the dock also LRU-EVICTS a pane when a third module is expanded."* That paragraph is
about a DIFFERENT bug (#1590, the two-owner bridge), and it states the lifetime fact that makes
this one true.

### 5.3 So what SHIPS today

`laneRenderKind` (`legacy-fallback.ts:143-147`): not user-docked, `shellFaces` on, has a card,
not a `NON_SHELL_LANE_TYPE`, **not migrated ⇒ `'placeholder'`**. skifree is not in
`HEADLESS_MOUNT_LANE_TYPES` either. **So under the shipping shell, on `main`, a rack containing
SKIFREE has no game at all until the user expands its dock pane — and collapsing the pane calls
`controller.dispose()` and throws the run away.** Every skifree e2e navigates
`/rack?shell=legacy` (`skifree.spec.ts:183`, and the shared `rack` fixture is `?shell=legacy`
by construction — `_fixtures.ts:93`), so nothing in the suite has ever looked.

**This is pong's §13.8 one severity higher.** Pong's game keeps running engine-side on the
scheduler and only its picture is missing. skifree's game does not exist.

### 5.4 The routing call

The FIX (enrol skifree as a card producer so `<HeadlessSourceHost>` keeps it alive) is worth
doing **on its own merits, now, independent of any face** — see `skifree/spec.md` §12. The face
is blocked behind it and behind a second, larger question (an off-screen host is
`pointer-events: none`, which kills the mouse steering that is the module's instrument — the
cameraInput problem, solved there with a status-and-command registry). **The wave reports both;
neither is a face PR.**

---

## 6. THE #2166 CLASS — one derived fixture pool has ONE member left, and it is `modtris`

The brief asked for a sweep for "conveniently un-faced fixture" uses — a spec whose
PRECONDITION is that the module is un-faced, which goes **green-and-blind** rather than red
when the module is promoted. **MEASURED by evaluating the derivations, not by reading them:**

```
AUDIO_PLACEHOLDER — picked: clockedRunner | pool size 26   (contains frogger, modtris, skifree)
AUDIO_OPERABLE    — picked: modtris       | pool size 1    ← ⚠
VIDEO             — picked: painter       | pool size 13   (contains nibbles)
VIDEO_SINK        — picked: toybox        | pool size 3
```

Three of the four pools have real slack and a promotion simply drops the module out. **The
`AUDIO_OPERABLE` pool has exactly one member, and it is `modtris`.**

### What happens when it empties

Not a throw, and not a red run. `deriveFixture` returns `kind: 'migration-complete'` with a
long, honest diagnosis, `fixtureProblems()` deliberately does **not** count that as a problem
(*"`migration-complete` is NOT a problem — it is the designed end state, and the consuming spec
skips on it by name"*), and `workflow-shell.spec.ts` pairs it with
`test.skip(F.kind === 'migration-complete', F.why)`.

> **So promoting `modtris` turns `workflow-shell.spec.ts`'s "the verbatim legacy card is
> OPERABLE in the dock full view" leg into a NAMED SKIP.** The suite goes green, the message is
> loud and correct, and the only coverage of that behaviour ends. **Skips are not passes.**

⚠ **This is the DERIVED version of a failure the same file already survived once.** Its own
header records that `VIDEO_FIXTURE`'s predecessor was a four-deep hand-picked list, that *"the
cohort in flight spent all four"*, and that the list was self-HEALING but never
self-REFILLING. The derivation removed the obligation for the video pool — and the audio
OPERABLE pool has narrowed from **4 at the #2137 split to 1 today** without anybody measuring
it, because a shrinking derived pool produces no signal until it empties.

### What `modtris`' PR must therefore do

CLAUDE.md's rule is the instruction: **fix the SUBJECT, never the threshold**, and say which in
the PR body.

1. **Widen the predicate**, if `mountsAFader` is stricter than the leg needs — the leg drives
   `.fader-wrap .track`, and a knob-drawing card is refused by name. That is the honest
   candidate: check whether a `<Knob>`-driving variant of the leg is a smaller change than
   losing it. **Do not widen it just to keep a pool non-empty** — that is a threshold fix.
2. Or **retire the leg with the design it covered**, explicitly, in the PR body.
3. Or provide a **purpose-built fixture module deliberately never promoted**, which
   `deriveFixture`'s own `migration-complete` text names as the alternative.

**Whichever it is, it is not optional and it is not silent.** A `modtris` face PR that does not
mention `AUDIO_OPERABLE_FIXTURE` has quietly ended a test.

### Two smaller results from the same sweep

- **None of the four is in `_face-fixtures.ts`'s `DENIED` map**, so none inherits the repaired
  `scope` hazard. ⚠ But that file's header names the failure mode this group is one instance
  of: *"a promotion does not redden a stale entry here, it makes one INVISIBLE"* — two entries
  (`audioOut`, `twotracks`) were deleted by hand for exactly that, in two consecutive merges.
- **`workflow-shell.spec.ts` already carries a repaired instance of the CLAUDE.md precondition
  class ON modtris** (`:365-378`): a leg failed with an empty param map because modtris' card
  is a game board with its faders far below the dock's fold, and the fix was `scrollIntoViewIfNeeded`
  **in the LEG** rather than a `DENIED` entry — *"denying the module would have hidden a
  fragility that the next tall card hits again."* That repair is a reason to trust the leg and
  a reason its subject matters.

---

## 7. COST POSITION, MEASURED PER MODULE

| | `frogger` | `modtris` | `skifree` | `nibbles` |
|---|---|---|---|---|
| **WebGL attest** | **ZERO** — no frogger file in the attest basis | **ZERO** | **ZERO** | ⚠ **IN THE BASIS** — `nibbles.ts`, `nibbles-game.ts`, `nibbles-bot.ts` are all listed. **Free for `face` only; see §7.1** |
| **ART** | ZERO — `ART_EXCLUDED` (`profile-coverage.ts:41`) | ZERO (`:40`) — ⚠ but `art/scenarios/modtris/gate-pulses.test.ts` exists; §8.4 | ZERO (`:42`) | ZERO — video domain, outside the audio gate |
| **contract-lock** | unchanged **unless** the `freeze` hook is a param (+1 row) | +1 row for `freeze`; ⚠ and §8.2 may REMOVE the `levelStep` row | n/a | **unchanged — and it must stay unchanged.** §7.1 |
| **VRT today** | `EXEMPT_FROM_VRT:769` + permanent; ⚠ **exit condition stated and dischargeable** | `EXEMPT_FROM_VRT:756` + permanent | `EXEMPT_FROM_VRT:778` + permanent; exit condition **not** met | 1 card + 5 composite + 4 coverage baselines, **none of which move** |
| **VRT after** | 2 added; **+1 if the exemption is discharged** | 2 added, 0 moved | — | 2 added, 0 moved |
| **Push 2 card** | GENERIC → FACE; 1 turnable param, so the card is one encoder either way | GENERIC → FACE; ⚠ re-ranks by `face.order` | unchanged (no params) | GENERIC → FACE; 2 params |
| **e2e cost today** | `frogger.spec.ts` **24.6 s** | `modtris.spec.ts` **17.8 s** | `skifree.spec.ts` **24.0 s** | `nibbles.spec.ts` 4.4 s + `nibbles-cv-scope.spec.ts` 13.8 s |
| **`faces-parity` delta** (`10 s + 0.8 s/cell`) | 1 cell ⇒ ≈ **10.8 s** | 2 cells ⇒ ≈ **11.6 s** | — | 2 cells + 1 action ⇒ ≈ **12.4 s** |

All three promotions are far under the ~2 min owner-sign-off threshold, individually and
together. ⚠ **But add BOTH cost artifacts on every face PR** — `e2e:timings:accept` and
`vrt:strict:timings:accept`. An unmeasured `vrt-strict` scene rides the median and has reddened
`main` at 92 % of a shard budget with every test passing.

### 7.1 ⚠ nibbles' hash-transparency, MEASURED IN BOTH DIRECTIONS

Wave 4's `picturebox` correction says the obvious reading of an attest measurement can be
false, so this was measured rather than inherited. Run non-mutatively through
`scripts/attest-code-basis.ts`'s own `normalizeForHashWithReport`, on the real
`packages/web/src/lib/video/modules/nibbles.ts`:

| tree state | normalised digest (16) | stripped props |
|---|---|---|
| baseline | `5f29cf092c8d45fd` | `["docs"]` |
| `+ face: { glyph:'none', order, pages }` | `5f29cf092c8d45fd` **UNCHANGED** | `["face","docs"]` |
| `+ face + a def-level noUserControl[]` | `5f29cf092c8d45fd` **UNCHANGED** | `["face","noUserControl","docs"]` |
| `+ a NESTED `face:` (negative control) | `95e993d0c16741f2` **MOVED** | `["docs"]` |
| `NIBBLES_MAX_LENGTH 119 → 120` (positive control) | `09a90ac6d20ba75d` **MOVED** | `["docs"]` |

Both controls fire, so the instrument is not blind in either direction. The operative rule:

> **A nibbles face PR that adds ONLY `face` (and, if needed, a def-level `noUserControl`) costs
> ZERO GPU. ANY other edit to that file costs a real-machine re-attest CI cannot run.**

That is why the nibbles spec refuses a `freeze` param (it does not need one — §4.2), refuses to
paint the score into the framebuffer (§1.2), and splits any range boy-scout into its own PR.
Merging them would convert a free PR into one held hostage to an attest window, which wave 4
named as the single most avoidable cost in a face wave.

---

## 8. SHARED DEFECT LEDGER — the class-level items

Per CLAUDE.md nobody opens issues: a bug found in the course of planned work is fixed **inside
that work's PR**. These are the items that belong to more than one module; the per-module
ledgers carry the rest.

**8.1 — `vizPassthrough: true` IS A LIE FOR EVERY AUDIO GAME IN THIS GROUP, and two surfaces
advertise it.** `frogger.ts:82`, `modtris.ts:68` and `skifree.ts:139` all declare it, and each
`docs.explanation` tells the user the canvas *"can be portaled into a containing GROUP card for
cross-domain video."* `GROUP_VIZ_HOST_TYPES` is `new Set(['scope'])`, so `GroupCard` never
mounts these cards while collapsed and its `querySelector('canvas[data-viz-passthrough]')`
finds nothing. **MEASURED and recorded in the tree**: `group-viz-hosts.test.ts:101-106` —
*"`canvasInSlot 0` for frogger/modtris/pong against SCOPE's 1"*, tracked as **#1755** — and the
reverse assertion is **deliberately withheld** so the test does not state a falsehood. Pong's
spec found this for pong; **this group establishes it as a CLASS across four modules** (and
`skifree` is a fourth instance nobody has measured). Severity: report. It is a docs lie plus a
dead attribute, and it does not block any promotion.

**8.2 — `modtris.levelStep` IS A CONTROL THAT DOES NOTHING.** `modtris-state.ts:129` says so in
its own words: *"Lines-per-level threshold (**unused in v1 stepper** but reserved for future
scoring)."* `grep -n "params\." modtris-state.ts` returns exactly one consumer —
`gravitySecondsPerDrop(params.gravityBpm)` at `:407` — and `ModtrisState` has a `lines` field
but **no `level` field at all**, so there is no difficulty ramp for it to threshold. The def
declares it, the card faders it, `contract-lock.txt:2031` pins it, the Push card will rank it,
and `docs.controls.levelStep` promises *"gravity speeds up each level"* — a behaviour that does
not exist twice over. **This is HALF of modtris' controls.** Severity: fold into the modtris
face PR; the two honest resolutions (wire it, or delete the param) are argued in
`modtris/spec.md` §13.1.

**8.3 — `frogger.initialTime` does nothing until the next START.** Read at exactly two sites,
both of them constructors: `initFroggerState` (`:313`) and `startGame` (`:336`). `handleDie`
(`:472`) and `handleLevelComplete` (`:481-483`) both restore from `state.defaultTime`, which is
a SNAPSHOT taken at start — and `handleLevelComplete` then decays it by 5 s per level, so after
a few levels the knob's value is not even the current ceiling. `readLive` reports the new value
immediately while the game keeps the old one. **Pong's §13.2 class verbatim, on a module whose
face has exactly one control.** Severity: fold into the frogger face PR — shipping a face whose
*only* control appears dead is worse than not shipping it.

**8.4 — the ART gate-pulse test cannot fail on a factory regression** (`modtris`, and pong has
the identical defect as its §13.7). `art/scenarios/modtris/gate-pulses.test.ts` hand-orchestrates
the `ConstantSourceNode` schedule into a fresh `OfflineAudioContext` instead of importing
`GATE_PULSE_S` / `SCHEDULE_CUSHION_S` from the def. Change either constant and the test stays
green while the shipped gate width changes. Severity: report; the minimum fix is importing the
two constants.

**8.5 — every one of these modules re-types its def's ranges in its card, and NOTHING checks
them.** `FroggerCard.svelte:98` (`min={10} max={120} defaultValue={60}`),
`ModtrisCard.svelte:88-89` (six literals), `NibblesCard.svelte:154` (`min={40} max={200}`; it
does use `defaultFor('tick_ms')`, which is half-right). None of the four is in
`RANGE_BOUND_CARDS`, whose own stated scope is *"every card NOT in this set is unchecked"*.
They agree today; nothing holds them there. ⚠ For nibbles this is the **one** boy-scout that
must NOT ride the face PR — it is a `.svelte` edit, so it is attest-free, but the matching def
edit that exports the range constant is not (§7.1). Severity: fold in per module, nibbles
split.

**8.6 — `face-migration-inventory.ts`'s `why` is FACTUALLY WRONG for three of the four.** The
roster reads: frogger *"a GAME viewport driven by the keyboard"* (`:812`), modtris *"a
falling-block viewport played on the keyboard"* (`:909`), skifree *"a scrolling viewport played
on the keyboard"* (`:1033`), nibbles *"a snake viewport played on the keyboard"* (`:921`).
**MEASURED** — `grep -n "onkeydown\|keydown\|KeyboardEvent"` over the four cards returns hits in
**`NibblesCard.svelte` only.** frogger and modtris have no keyboard path at all and are driven
entirely by gate CV; skifree is driven by CV or the **mouse**. Severity: minor, but it is the
text a queue reader uses to decide a disposition, and three of four descriptions describe a
module that does not exist. Fix the strings in whichever PR touches the entry.

---

## 9. ⚠ THE CORRECTIONS — claims checked that came back different

Wave 3's pattern was *"the rule was applied correctly and the subject was never checked."*
It happened four times here, each recorded in place.

**1. "An audio suspend freezes an audio game's picture."** FALSE — §4.1. The scheduler clock is
a Web Worker `setInterval` with an unconditional `dispatch()`. This is the correction that
changes a design: it means pong's `freeze`-param seam is the ONLY mechanism rather than the
convenient one, and it means a scene relying on `freezeAudio` for one of these games would be
capturing an arbitrary tick.

**2. "The module with a video port gets the lane picture."** FALSE in both directions — §2.3.
`skifree` has a `video` output and gets nothing; `nibbles` has two `audio` outputs and gets the
picture. The predicate is `domain` and only `domain`.

**3. "The derived fixture pools are self-refilling, so a promotion is free."** TRUE for three
of four and FALSE for the one that matters — §6. `AUDIO_OPERABLE` has **one** member. The
derivation is correct and its slack is not, and a shrinking derived pool emits no signal until
it empties. The claim was checked by EVALUATING the derivation, not by reading its comment —
and its comment says "4 candidates", which was true at the #2137 split and is not true now.

**4. "`nibbles` has a score painted in its canvas like the other games."** FALSE — §1.2.
`paintFrame` draws background, border, food, snake and scanlines and **no text**; `LEN` is DOM
chrome only. The first draft of the group ruling assumed all four sat on the allowed side of
the line. Only two do, and the one that most obviously wants the escape hatch is the one where
using it costs a GPU re-attest.

---

## 10. BUILD ORDER RECOMMENDATION

**`frogger` FIRST, as ONE PR.** It is the cheapest face in the wave — one knob, one band, one
body — and it is the one that **discharges a stated ratchet**: its `EXEMPT_FROM_VRT` entry
names "a deterministic-time test hook … so the scene can freeze the game at a known tick" and
the PR builds exactly that. It is also the module where the determinism seam is genuinely
easiest, because there is no RNG to seed. It carries §8.3 (the dead rank-1 control) and §8.5.
Zero attest, zero ART, no contract change unless the freeze hook is a param.

**`nibbles` SECOND, as ONE PR that touches `nibbles.ts` with `face:` AND NOTHING ELSE.** It is
the only lane picture in the group, its determinism pair already exists and is already proven
byte-identical, and its cost is measurably zero **provided the discipline in §7.1 holds**. It
carries the largest STOP-2 surface in the group (a RESET action, a SCALE control that is
currently doomed component `$state`, and arrow-key steering that is the instrument rather than
a11y), so it is the one that needs the most careful parity work — but none of that work is in
the attested file.

**`modtris` THIRD, as ONE PR — and it is the one that needs a decision before it starts.**
The face itself is two faders and a body. What it carries is the `AUDIO_OPERABLE_FIXTURE`
question (§6, which must be answered before the promotion lands, not after) and a dead half of
its own control surface (§8.2, which is a contract change either way). Doing it third means the
fixture question is answered while two other promotions have already exercised the path.

**`skifree` — DO NOT ATTEMPT THE FACE.** Do the producer fix (§5.4) on its own merits as an
ordinary bug PR; it is a live defect that makes the module non-functional in the shipping shell
and no test can currently see it. The face is blocked behind that AND behind a zero-param
lane tier (#1974's bar) AND behind an un-pinnable third-party render loop. Three independent
blockers is a refusal, and per the audit skill a refusal is a complete answer.
