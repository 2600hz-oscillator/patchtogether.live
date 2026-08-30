# FACEPLATE SPEC — `skifree` (audio) — **REFUSE, and the refusal is the finding**

> **SPEC + MOCK. Nothing here is implemented.** Group analysis: [`../GAMES.md`](../GAMES.md).
> Sibling specs: [`../frogger/spec.md`](../frogger/spec.md) · [`../modtris/spec.md`](../modtris/spec.md)
> · [`../nibbles/spec.md`](../nibbles/spec.md). Precedent for the class:
> `.myrobots/2026-08-23-bespoke-wave1/pong/spec.md`.
>
> **Mock:** `dock.html` — it shows what a skifree face WOULD be, which is the argument.
>
> ⚠ **DOOM is excluded from this spec by name**, per the standing owner ruling. It is a game
> module and would fall inside every sweep here; nothing in this document applies to it and no
> file of its was opened.

---

## VERDICT

**REFUSE. Three independent blockers, any one of which is sufficient**, and the audit that
produced them found **a live product defect that makes this module non-functional in the
shipping shell** — which is worth more than the face would have been.

| # | blocker | class |
|---|---|---|
| **B1** | **Promotion DELETES THE GAME.** The engine lives on the card; the factory only reads it. No card ⇒ no bundle ⇒ no controller ⇒ no picture, no `gate`, no `out`. | STOP 2 — a data-in path that cannot survive |
| **B2** | **`params: []`.** Zero ranked controls, so **every lane tier resolves to a title, a patch panel and nothing** — the #1974 `joystick` bar, verbatim. | STOP 1 — parity loss |
| **B3** | **No determinism seam is buildable.** The game is a committed pre-built third-party IIFE that self-drives on its own rAF. Its `EXEMPT_FROM_VRT` entry names the missing hook and it stays missing. | VRT |

Per `module-adversarial-audit.md`, **"NO FACE ON MERIT" is a complete answer**, and per
`module-faceplates.md` STOP 1, a functional-parity loss is *"never surfaced as an owner choice
after the build — file the blocker and move on."* This document is that blocker, plus the
precursor path if the owner ever wants the face, plus the defect ledger the fix PR should carry.

**What SHOULD happen instead, now:** §12 — the producer fix. It is small, it is a live bug, and
it is worth doing on its own merits with no face attached.

---

## 0. THE CONSTRAINT MAP

| registry | member? | what it means here |
|---|---|---|
| `NON_SHELL_LANE_TYPES` | **NO** | ⚠ **and it arguably SHOULD be** — this set exists for exactly the carve-out skifree needs (§12.3). |
| `CARD_PRODUCER_LANE_TYPES` | **NO — and that is WRONG** | ⚠⚠ **THE FINDING.** The set is DERIVED and its derivation is structurally unable to see this module. §5. |
| `HEADLESS_MOUNT_LANE_TYPES` | **NO** | consequence of the above: `needsHeadlessSourceMount` returns false, so nothing keeps the card alive. |
| `EXEMPT_FROM_VRT` (`vrt-exemptions.ts:778`) | **YES** | *"animated ski-slope (rAF-self-driven terrain + sprites + skier anim) defeats deterministic single-frame capture"*, with an exit condition (`:775-777`) that is **not met and not cheaply meetable**. |
| `ALLOWED_PERMANENT_EXEMPT` (`:1176`) | **YES** | anchored in both directions. |
| `STRICT_FACES` | **NO** | un-migrated, and this spec says it should stay that way. |
| `STRICT_DOCS` (`strict-docs.ts:307`) | **YES** | so any contract change needs its docs entry. |
| `PUSH_CARD_CONTROLS` | **NO** | and it cannot matter: `params: []` means no encoders at any tier. |
| `RANGE_BOUND_CARDS` | **NO** | and it cannot matter: there are no ranges to re-type. |
| `ART_EXCLUDED` (`profile-coverage.ts:42`) | **YES** | ⚠ the stated reason — *"free-running game audio driven by RNG"* — is loose: skifree has **no audio output at all**. Cost: ZERO either way. |
| `cv-scale-registry.test.ts:139` | `skifree: ['x','y']` | declared: *"the CV doesn't modulate any knob, it IS the mouse-cursor position the skier steers toward."* Same shape as pong's paddles. |
| `_face-fixtures.ts` `AUDIO_PLACEHOLDER` pool | member, **index 5 of 26** | not the pick (`clockedRunner` is). 25 members of slack; a promotion would be invisible to it. |
| `face-migration-inventory.ts:1031-1034` | **`bespoke-surface`, NO BLOCKERS** | *"a GAME: a scrolling viewport played on the keyboard, with no params at all."* ⚠ **"no params at all" is TRUE and is B2. "played on the keyboard" is FALSE** — the card has no keydown handler; it steers with the MOUSE. And **`blockers: []` is wrong**: this spec is the missing entry. |
| `maxInstances: 1` (`skifree.ts:143`) | — | one card, one bridge. ⚠ `skifree-bridge.ts:44-47` records that the single global is node-un-keyed and calls it *"a distinct defect… Do not mistake this file for having solved it."* |
| WebGL attest basis | **NO — VERIFIED** | no skifree file in the attest basis. Attest-transparent. |
| `scripts/lint/lint-policy.mjs` | ⚠ **names `skifree`** | the vendored bundle under `packages/web/native/skifree/` is lint-excluded — a reminder that the game code is NOT this repo's to change casually. |

---

## 1. WHAT THE MODULE IS FOR

**In one paragraph.** SKIFREE is **a CV-steered crash generator**: you feed X and Y, the skier
heads downhill toward the cursor you synthesise, and every time it hits something the module
fires one 10 ms gate. Its siblings turn a *rhythm* into events (pong's rally, modtris' stack,
frogger's hops); skifree turns a **two-dimensional trajectory through a scrolling obstacle
field** into events, and the rate is a function of how tightly you are steering rather than of
any clock. The verb is **RIDE THE LINE**: patch two LFOs at co-prime rates and you get a
quasi-periodic crash pattern nothing else in the rack produces. It also carries the slope as a
`video` output, so the game can be the picture in a video chain.

**The chain** (`skifree.ts:177-340`):

1. **Two CV taps** (`AnalyserNode`, `fftSize = 32`, tail sample) read at scheduler-tick rate.
   `cvToCanvasCoord(cv, 320)` maps −1..+1 to 0..320 canvas px (`:68-73`), exported pure for
   `skifree.test.ts`.
2. **CV OVERRIDES MOUSE.** `cvDriven = |x| > 1e-4 || |y| > 1e-4` (`:276`); when true the factory
   writes `ctl.setCursor(...)` and the card disables native mouse steering (`SkifreeCard.svelte:82-90`).
   ⚠ A patched-but-resting-at-0 CV is indistinguishable from unpatched, and the def's own comment
   says so and argues it does not matter (CV 0 maps to centre, which is what the mouse path would
   do anyway).
3. **The gate.** `bridge.onGate` is set ONCE by the factory at materialize; the CARD's controller
   invokes it on every crash / yeti-eat, and the factory pulses a `ConstantSourceNode` for
   `SKIFREE_GATE_PULSE_S = 0.01`.
4. **The video out.** `drawFrame(target)` blits `bridge.controller.canvas` into the cross-domain
   bridge canvas, aspect-fit, black-filled (`:224-254`).
5. **The picture.** ⚠ **There is no `draw*` function in this repo.** Unlike frogger, modtris and
   pong — all of which export a pure painter the def owns — skifree's pixels are produced by
   `/skifree/skifree.bundle.js`, a committed pre-built esbuild IIFE of the upstream
   `packages/web/native/skifree/js/` classes, running on its own rAF inside the bundle.

**PARAMS: NONE.** `contract-lock.txt:2992-2996` is the whole contract: `meta domain=audio
maxInstances=1 vizPassthrough`, `in x cv`, `in y cv`, `out gate gate edge=trigger`,
`out out video`. **Zero `param` rows.**

---

## 2. STOP 1 — B2: a face with NO CONTROLS AT ANY TIER

`module-faceplates.md`'s STOP-1 override is explicit that **thinness never refuses**: *"if there
are a lot of audio modules with <4 params can't we just fly through them really quickly? they
still need to be done, <4 params or not."* A one-knob module gets a one-knob face and that is
correct.

**Zero is not thin. Zero is the `joystick` case.** #1974 was refused because *"every lane tier
resolves to zero controls: a title, a patch panel, and no stick, on a module whose entire purpose
is a performance gesture."* skifree is that shape exactly:

- `curatedFace` has nothing to rank at any tier — mini, compact, plate and dock all resolve to
  **zero cells**.
- The glyph cannot fill the gap: `hasVideoSurface` is `domain === 'video'` and skifree is audio
  (GAMES.md §2.3 — **its `out` video PORT does not make it a video DOMAIN**), and its one
  audio-family output is a `gate`, so `primaryAudioOutPortId` is null and every glyph literal but
  `'none'` reddens the dead-glyph clause.
- So the promoted lane tile is **a title bar and a patch panel**, on a module whose entire purpose
  is a game you watch.

⚠ **The honest counter-argument, and why it does not carry.** Pong's §2 argued *"the alternative
is not the card — it is a BLANK TILE"*, and that is true of skifree's LANE too. But pong's other
two legs were what made the promote: `fullViewBody` gave the court a real dock home, and three
ranked params meant no tier was empty. **skifree has neither.** Its dock body cannot show the
game (B1) and it has nothing to rank (B2). The comparison completes in the opposite direction.

---

## 3. STOP 2 — B1: THE GAME IS ON THE CARD

```sh
grep -nE '<button|<select|<input|oncontextmenu|manualTrigger|Toggle|Selector|accept=' \
  packages/web/src/lib/ui/modules/SkifreeCard.svelte
```
**Zero hits** — and that is exactly the shape that makes this trap dangerous. The grep is looking
for CONTROLS. skifree's card does not own a control; **it owns the game.**

| # | affordance | site | after promotion |
|---|---|---|---|
| 1 | `<ModuleTitle defaultLabel="SKIFREE">` | `:178` | YES — the shell's own title bar |
| 2 | `<PatchPanel>` — four jacks | `:180-212` | YES |
| 3 | ⚠ **the bundle `<script>` injection** — `s.src = '/skifree/skifree.bundle.js'`, `document.head.appendChild(s)` | `:102-111` | ⛔ **NO. Nothing else loads it.** |
| 4 | ⚠ **`window.SkiFree.create({ canvas, width, height, spriteBase, onGate })` — the CONTROLLER, bound to the CARD's canvas** | `:115-125` | ⛔ **NO.** The factory reads `bridge.controller` and never creates one. |
| 5 | ⚠ **`bridge.controller = controller`** — publishing it for the factory | `:126` | ⛔ **NO** |
| 6 | ⚠ **the CANVAS ITSELF** — `width=320 height=320`, the surface the bundle draws into AND the source `drawFrame` blits from | `:185-195` | ⛔ **NO** |
| 7 | ⚠ **MOUSE STEERING** — `tabindex="0"` + `onfocus`/`onblur` → `controller.enableMouse(canvasEl)` | `:82-90`, `:150-151`, `:191-192` | ⛔ **NO.** The module's only direct-manipulation instrument. |
| 8 | ⚠ **the load-status overlay** (`Loading…` / `Bundle failed: …`) | `:197-201` | ⛔ NO — and it is the only place a 404 on the bundle is ever surfaced to a user |
| 9 | the `.skifree-hud` row — `{distance}m`, `· lives {n}`, `CV`/`MOUSE`/`IDLE`, `GAME OVER` | `:203-210` | ⛔ **FORBIDDEN by the resting-text ruling anyway** — §10 |
| 10 | `controller.dispose()` on unmount | `:161` | — ⚠ and this is why COLLAPSE currently throws the run away (§13.2) |

**Rows 3–7 have no shell representation, and there is no cell that could hold them.** A
`ShellFileCell` loads a file; a `ShellActionCell` fires an audition; neither instantiates a
third-party game runtime and binds it to a canvas it owns. `fullViewBody` COULD host all of it —
it is a SLOT, not a cell, so it needs no probe — but that is **a rewrite of the module's
lifecycle, not a faceplate** (§12.2).

**So promotion is not "the picture moves to the dock". It is "the module stops existing."**
Not a missing view: the snapshot freezes at its construction defaults (`skifree.ts:267-270`),
`out` stays black (`drawFrame` returns early when `src` is falsy, `:227`), and `gate` — the
module's ONLY trigger output — never fires, because `onGate` is invoked by the controller the
card created.

### 3.1 Where state lives — `params` vs `node.data`

**NEITHER.** `grep -c "mutateNode\|node.data\|setNodeParam" SkifreeCard.svelte` → 0. There are no
params and no `node.data`. **All of skifree's state lives in a MODULE-SCOPE GLOBAL**
(`globalThis.__skifree`) and in the bundle's own closure.

That is the fourth data point this wave adds to the `.data`-discipline census (wave 3 gave two,
wave 4 gave six), and it is a **new category**: `mutate.guard.test.ts`'s regex anchors on the
literal token `.params`, so it is blind to `.data` writes — and skifree writes neither. **A
module whose entire instrument state is a page global is invisible to every discipline gate in
that family**, and the same property is what makes §5 true. Report it with the `.data` finding
rather than as a separate item: the shape is *state that no node owns*.

---

## 4. WHAT A FACE WOULD ACTUALLY BE — the mock, and why it is the argument

`dock.html` draws it. It is:

- a title bar,
- a patch panel (X, Y in; GATE, OUT out),
- **an empty plate**, because there are no params to band,
- and, if `fullViewBody` were used, a slope that is **not being rendered by anything**.

That picture is the refusal. It is included precisely so an owner can see the outcome rather than
read an argument about it, and so nobody proposes "just give it a face, it is only two ports."

---

## 5. ⚠⚠ THE PLATFORM FINDING — `skifree` IS A CARD PRODUCER AND TWO DENY-BY-DEFAULT GATES CANNOT SEE IT

This is the most valuable thing in the wave and it is a live defect, not a promotion cost.
GAMES.md §5 is the group-level statement; this is the detail.

### 5.1 The two gates, and why each is blind

| gate | what it checks | why skifree is invisible |
|---|---|---|
| `dom-source-modules.test.ts` → `CARD_PRODUCER_LANE_TYPES` | a DERIVED set. `PRODUCER_SEAMS` is exactly **two** typed regexes — `/\bwrite\s*\(\s*(?:node\|id\|nodeId)\s*,/` and `/\binstall\w*FrameDrawer\s*\(/` — searched over each card's **`.svelte` component subtree** | skifree's producer statement is `bridge.controller = controller` (`SkifreeCard.svelte:126`), reached through **`$lib/audio/skifree-bridge.ts` — a `.ts` file**, and matching neither regex. ⚠ The `.svelte`-only boundary is **deliberate and argued in the gate's own header**: following `.ts` edges enrols all 195 cards, because every card reaches `video/engine.ts` which DEFINES `attachExternalSource`. So this is a **structural** blind spot, not an oversight — and the gate's honest widening measurement (*"exactly TWO attributions the flat walk could not make"*) was taken over `.svelte` files only. |
| `card-media-lifetime.test.ts` → `EXTRAS_OWNERS` | deny-by-default, one typed verdict per card **on the extras channel** (`read(id,'extras')`), anchored in both directions | `SkifreeCard` never calls `read(…, 'extras')` — it uses the `window.__skifree` global — so it is **not on the channel** and the map never asks about it. ⚠ Its sibling `NibblesCard` IS on the channel and IS classified: *`module-renders-itself` — "nibbles.ts paints a frame before the first tick and ticks its own clock… the card pushes only arrow keys and a reset."* **That verdict is exactly right for nibbles and would be exactly wrong for skifree**, and nothing asks. |

**A third producer seam exists in this repo and neither gate knows the shape.** That is the
finding, and it is CLAUDE.md's Pattern 5 verbatim: *a filter applied before the check redefined
the check's subject.* `CARD_PRODUCER_LANE_TYPES` is honestly derived; its enumeration of *seams*
is the filter.

⚠ **The repo has already written the consequence down without connecting it.**
`skifree-bridge.ts:26-28`: *"Under the faceplate shell that is not an edge case: an un-migrated
module's card exists only inside the dock full-view, so COLLAPSE unmounts it — and the dock also
LRU-EVICTS a pane when a third module is expanded."* That paragraph is about a DIFFERENT bug
(#1590, the two-owner bridge) and it states the lifetime fact that makes this one true.

### 5.2 What SHIPS today

`laneRenderKind` (`legacy-fallback.ts:143-147`): not user-docked, `shellFaces` on, has a card, not
a `NON_SHELL_LANE_TYPE`, **not migrated ⇒ `'placeholder'`**. Not in `HEADLESS_MOUNT_LANE_TYPES`.

> **So on `main`, under the shipping shell, a rack containing SKIFREE has no game at all until
> the user expands its dock pane — and collapsing the pane calls `controller.dispose()` and
> throws the run away.**

**pong's §13.8, one severity higher.** Pong's game keeps running engine-side on the scheduler and
only the picture is missing. skifree's game does not exist. And nothing in CI can see it: every
skifree e2e navigates `/rack?shell=legacy` (`skifree.spec.ts:183`, and the shared `rack` fixture
is `?shell=legacy` by construction, `_fixtures.ts:93`).

⚠ **Note what this does to the per-port sweep's exemptions.** `_per-module-per-port-shared.ts:446-447`
excuses `skifree.gate` and `skifree.out` because they need an in-game event, *"covered by
e2e/tests/skifree.spec.ts which drives the skier into a crash … via the controller's
`_forceCrash`/`_forceEaten` hooks"*. Those hooks are on the CARD's controller. **The exemption's
stated coverage exists only on `?shell=legacy`**, which is where that spec runs — so it is true
as written and says nothing about the shipping surface.

---

## 6. B3 — WHY THE VRT EXEMPTION IS NOT DISCHARGEABLE HERE

`vrt-exemptions.ts:770-778` states the exit condition: *"Promote to a real VRT baseline once a
deterministic-time render-freeze hook is added so the scene can be pinned at a known frame."*

Its siblings can all meet their equivalent (GAMES.md §4.2): frogger has no RNG at all and needs a
tick pin; modtris' injectable RNG already exists and is merely unused by the factory; nibbles'
pin already exists and is already proven byte-identical. **skifree can meet none of it**, and the
reason is mechanical:

- the game runs **inside a committed pre-built third-party IIFE** (`/skifree/skifree.bundle.js`,
  esbuild of `packages/web/native/skifree/embed.js` + the upstream `js/` classes);
- it drives **its own rAF**, in the bundle, with its own clock and its own RNG;
- nothing in this repo owns either. `SkifreeController` exposes `setCursor`, `enableMouse`,
  `disableMouse`, `reset`, `dispose`, `getState`, `_forceCrash`, `_forceEaten` — **and no freeze,
  no seed, no tick.**

Adding one means changing the vendored source and re-running the bundle recipe
(`packages/web/native/skifree/README.md`). ⚠ `scripts/lint/lint-policy.mjs` names `skifree` in its
exclusions, which is the tell that the bundle is not this repo's code to edit casually. **That is
a fork-and-maintain decision, not a face PR**, and it belongs to the owner.

---

## 7. THE PRECURSOR PATH — what it would take, in order, if the owner ever wants the face

Written so nobody re-derives it, and so the *cost* is visible next to the *benefit*.

**PR 1 — the PRODUCER FIX (do this regardless; §12).** Enrol skifree so its card is kept alive.

**PR 2 — the MOUSE PROBLEM, which PR 1 creates.** `<HeadlessSourceHost>` mounts the real card
**off-screen with `pointer-events: none`**, so the game runs and the gate fires and **the mouse
steering is unreachable**. That is the cameraInput problem exactly — its "Request access" gesture
became unclickable off-screen — and cameraInput solved it with a purpose-built registry
(`$lib/ui/media/camera-status-registry`) that publishes the card's state and registers its
commands so the faceplate can show and drive them **without a second owner existing**. skifree
needs the same shape: a `skifree-status-registry` publishing the controller so a `fullViewBody`
can re-parent or mirror the canvas and forward pointer events. ⚠ **Two owners of one canvas is
the hazard**, and #1590 is what the last two-owner arrangement on this module cost.

**PR 3 — the ZERO-PARAM problem (B2), which no amount of plumbing solves.** Even with the game
alive and visible in the dock, the LANE tile is a title and a patch panel. The honest fixes are
both feature work: give the module real params (a slope-speed or a yeti-aggression control the
upstream may not expose), or put it in `NON_SHELL_LANE_TYPES` and keep the legacy card in the
lane — ⚠ **which does NOT give the card back in the DOCK**, because the dock full view reads
`migrated()` alone. So the carve-out route promotes a module whose dock face is empty.

**PR 4 — the determinism seam (B3), i.e. a fork of the upstream bundle.** Owner decision.

**Four PRs, one of them a vendored-code fork, to reach a face with no controls on it.** That is
the whole argument for the refusal, and it is why §12 is separated out: PR 1 is worth doing
today, alone, with none of the rest.

---

## 8. CONTROL INVENTORY

**Nothing to inventory. `params: []`.** Recorded so a reviewer can confirm the absence rather than
infer it, and so it is clear that no roster, no `paramCells`, no landmark, no hero and no
`face.momentary` decision was skipped — there is nothing to decide.

The only affordances are (a) the two CV jacks, which the shell's patch panel paints, and (b) the
mouse, which §7 PR 2 is about.

---

## 9. THE STATE MATRIX — measured against the SHIPPING shell, not the legacy card

| # | shell | dock pane | x/y | what actually happens |
|---|---|---|---|---|
| 1 | `?shell=legacy` | — | unpatched | the card mounts, the bundle loads, the game runs, mouse steering engages on focus. **This is the only state any test has ever observed.** |
| 2 | **default (shipping)** | collapsed | any | ⚠ **NO GAME.** Lane tile is a `ModuleShellPlaceholder`; no card, no bundle, no controller. `gate` never fires, `out` is black, the snapshot is frozen at `{distance:0, lives:5, …}`. §5.2 |
| 3 | default | **expanded** | unpatched | the card mounts inside the dock full view, the bundle loads, the game starts **from scratch** |
| 4 | default | expanded → collapsed | any | ⚠ `onDestroy` runs `controller.dispose()` — **the run is thrown away**, and re-expanding starts a new game |
| 5 | default | a THIRD module expanded | any | ⚠ the dock LRU-evicts the pane: same as row 4, **for a module the user never touched** |
| 6 | any | any | patched | `cvDriven` true ⇒ the factory writes the cursor and the card disables the mouse. ⚠ Only meaningful in rows 1, 3 |
| 7 | any | any | patched at exactly 0 | indistinguishable from unpatched by design (`CV_EPS = 1e-4`), and the def argues it does not matter |

⚠ **Rows 2, 4 and 5 are the product today.** They are not consequences of a face; they are what a
user gets on `main`, and no test can see them.

---

## 10. THE RESTING-TEXT RULING — skifree's HUD is the group's FORBIDDEN example

**The ruling** (GAMES.md §1): a game's score and lives painted INSIDE the playfield canvas are
ALLOWED; a score or lives row rendered as CHROME BESIDE the playfield is FORBIDDEN.

**skifree is the group's clearest FORBIDDEN case, and it is refused by name here even though the
module is not being promoted** — because the row is what a face author would otherwise carry
across, and because the distinction is easier to see on a module where both halves are visible in
one card.

`SkifreeCard.svelte:203-210` renders a `.skifree-hud` div **beside** the canvas:

```
{snapshot.distance}m   ·  lives {snapshot.lives}   CV|MOUSE|IDLE   GAME OVER
```

Four separate resting derived values in DOM chrome: a measurement, a count, a **state word**, and
a status banner. Measured against the exhaustive permitted list — module NAME, TAB/SECTION labels,
CONTROL CAPTIONS, option/landmark NAMES that disambiguate a control's own position — **it is none
of the four.** It is the hero readout strip (#1957) with a different label: *"you don't need to
have the out-silent text at all … we absolutely have to stop doing [things] like that."*

⚠ **And note that skifree's canvas has NO in-canvas HUD to fall back on.** Whatever the upstream
bundle draws is the upstream's business, but the distance, the lives and the control-mode word
exist **only** in this repo's DOM chrome. So the ruling does not merely relocate them — **it
deletes them**, and the honest home is the accessible name:

```
role="img"  aria-label="SKIFREE — 280 metres, 4 lives, steered by CV"
```

⚠ **The control-mode word is the one that most deserves to survive and least deserves to be
painted.** `CV` / `MOUSE` / `IDLE` answers *"why is my mouse doing nothing"*, which is a real
question — and it is a STATE WORD, the exact shape the ruling refuses. Its home is
`aria-label` plus (if it is ever built) a `title` on the canvas. **Do not propose a "compact" or
hover version: "there but hidden" was refused by name.**

⚠ **AND THE GATE CANNOT SEE IT.** `face-resting-text-source.test.ts` denies `ModuleFace` FIELDS;
a `.skifree-hud` div in a module-owned component is not a field, and canvas text is its own named
blind spot. **If skifree is ever promoted, the dock VRT baseline and a human are the whole
enforcement.** GAMES.md §1.

---

## 11. IF IT WERE PROMOTED ANYWAY — the cost, for completeness

| item | cost |
|---|---|
| WebGL attest | ZERO — not in the attest basis |
| ART | ZERO — `ART_EXCLUDED`, and there is no audio output to capture |
| contract-lock | unchanged (no params) — unless §7 PR 3 adds some |
| VRT | 2 face scenes added; ⚠ **both nondeterministic and neither pinnable** (§6), so they would need `VRT_LIVE_SURFACES` masks — which is the mechanism for a surface that *cannot* be pinned, and using it to paper over B3 would be exactly the wrong call |
| Push 2 | unchanged — no params, so no encoders at any tier |
| e2e | `skifree.spec.ts` costs **24.0 s** today and is untouched; `faces-parity` would add ≈ 10 s for **zero cells**, which is itself the tell |

**`faces-parity` at ten seconds for zero cells** is the numeric form of the refusal.

---

## 12. ⚠ WHAT TO DO INSTEAD — THE PRODUCER FIX, AS ITS OWN PR

**This is the recommendation. It is a live product defect, it is small, and it needs no face.**

### 12.1 The fix

Add `'skifree'` to `CARD_PRODUCER_LANE_TYPES` so `needsHeadlessSourceMount` returns true and
`<HeadlessSourceHost>` keeps the real card mounted off-screen. Rows 2, 4 and 5 of §9 all resolve:
the bundle loads once, the controller lives for the node, `gate` fires, `out` carries the slope,
and a collapse stops throwing the run away.

⚠ **But the set is DERIVED and asserted EXACTLY** (`dom-source-modules.test.ts`), so a hand-added
member reddens the gate. **The fix is therefore two-part and the second part is the valuable
half:**

1. **Add a THIRD `ProducerSeam`** — one typed entry with its own `why`, matching the
   bridge-publication shape (`\b\w*[Bb]ridge\w*\.\w+\s*=` is too loose; the honest form is to
   have `SkifreeCard` publish through a named helper the seam can match, e.g. renaming
   `ensureSkifreeBridge` usage to an `installSkifreeController(...)` call so the existing
   `install*` family is the pattern). ⚠ **Prefer changing the CALL SITE to fit a tight regex over
   loosening the regex** — the gate's own header explains why a wide filter redefines the subject.
2. **Widen the WALK, or accept a named exemption.** The seam lives in a `.ts` file. The gate's
   `.svelte`-only boundary is argued and correct, so the honest options are (a) put the
   publication in the component itself so the existing walk finds it, or (b) add skifree as a
   NAMED entry carrying this evidence. **(a) is better**, because it keeps the set derived.

### 12.2 What the fix does NOT solve

**Mouse steering** (§7 PR 2) and **B2** (§2). PR 1 makes the module WORK; it does not make it
promotable. Say so in the PR body so nobody reads a green producer gate as a promotion signal.

### 12.3 The alternative, and why it is weaker

Add `'skifree'` to `NON_SHELL_LANE_TYPES` instead. The lane keeps the verbatim card, the game
lives, the mouse works. ⚠ **But it only protects the LANE** — the dock full view reads
`migrated()` alone, so it changes nothing about the dock, and it leaves skifree permanently
outside the faceplate system rather than fixing the seam that hides it. It is the smaller change
and the worse one; the precedent members (`videoOut`, `cameraInput`) are there for affordances
that genuinely have no shell expression, and cameraInput has since LEFT the set by building the
registry §7 PR 2 describes.

---

## 13. DEFECT LEDGER

Per CLAUDE.md nobody opens issues: these are fixed inside the §12 PR, scoped honestly, with the
story in the PR body.

**13.1 — ⚠⚠ SKIFREE HAS NO GAME UNDER THE SHIPPING SHELL, AND NO TEST CAN SEE IT.** §5.2 and §9
rows 2/4/5 in full. Not in `NON_SHELL_LANE_TYPES`, not in `STRICT_FACES`, not in
`CARD_PRODUCER_LANE_TYPES` ⇒ `laneRenderKind` returns `'placeholder'`, no card mounts, the bundle
never loads, `gate` never fires and `out` is black. Every skifree e2e drives `?shell=legacy`.
**Severity: the highest in this wave.** Fix: §12.

**13.2 — COLLAPSE DESTROYS THE RUN, and LRU eviction does it to a module the user never
touched.** `SkifreeCard.svelte:158-173` `onDestroy` calls `controller.dispose()`. Under the shell
an un-migrated module's card exists only inside the dock full view, so collapsing the pane — or
expanding a third module, which LRU-evicts this one — ends the game. `skifree-bridge.ts:26-28`
states the lifetime fact and was written for a different bug. **Severity: fold into §12** (the
headless host is the fix; nothing else is needed).

**13.3 — the card clears the bridge UNCONDITIONALLY, ignoring the guard the bridge provides.**
`releaseSkifreeCardState(controller?)` takes an optional controller *"so a card that has already
been replaced by a newer mount cannot null out the newer one"* (`skifree-bridge.ts:76-78`).
`SkifreeCard.svelte:172` calls it with **no argument**, which the signature documents as *"clear
unconditionally"*. `maxInstances: 1` makes this mostly moot today — but the guard exists because
the #1590 class is exactly a stale owner clobbering a live field, and an unmount/mount overlap
during a dock pane swap is the ordering that would expose it. **Severity: one-line fix, fold in**
— pass the controller.

**13.4 — `vizPassthrough: true` is a lie, and two surfaces advertise it.** `skifree.ts:139`
declares it and `docs.explanation` (`:163`, via the manifest entry) describes the portal path,
but `GROUP_VIZ_HOST_TYPES` is `new Set(['scope'])`, so `GroupCard` mounts no skifree card while
collapsed. ⚠ **skifree is a FOURTH instance of #1755 that the measured test does not name** —
`group-viz-hosts.test.ts:104` records `canvasInSlot 0` for frogger/modtris/pong only. **Severity:
report**; GAMES.md §8.1. It also has a `video` OUT port, which is the correct way to do the same
thing, so the flag is redundant as well as inert.

**13.5 — `__skifree` is a single un-keyed global.** `skifree-bridge.ts:44-47` says so and says it
is not solved: *"two SKIFREE nodes share one bridge… Do not mistake this file for having solved
it."* `maxInstances: 1` contains it. **Severity: known, declared, out of scope** — recorded so a
future multi-instance change knows the cost.

**13.6 (minor) — `face-migration-inventory.ts:1031-1034` is wrong twice.** *"played on the
keyboard"* — `SkifreeCard.svelte` has **no keydown handler**; it steers with the MOUSE, and CV
overrides it. And **`blockers: []`** on a module with three of them. Fix both in the §12 PR:
the string, and a `blockers` entry naming this spec's B1/B2/B3.

**13.7 — the per-port sweep's exemption text describes a coverage path that exists only on
`?shell=legacy`.** `_per-module-per-port-shared.ts:446-447` cites `skifree.spec.ts`'s
`_forceCrash`/`_forceEaten` drive as the coverage for `skifree.gate` and `skifree.out`. Those
hooks live on the CARD's controller. The sentence is TRUE and the coverage is real — on the
legacy shell. **Severity: note**; after §12 lands it becomes true on both, which is the right
time to say so in the exemption's `why`.

---

## 14. VERIFICATION GATE — for the §12 PR (there is no face to gate)

```sh
# 1. the producer set, in BOTH directions — this is the gate the fix must satisfy honestly
REPEAT=3 flox activate -- task test:one -- dom-source-modules
# 2. the card-lifetime family, since skifree is being brought into a lifetime rule
flox activate -- task test:one -- card-media-lifetime
flox activate -- task test:one -- legacy-fallback
flox activate -- task test:one -- skifree-bridge          # §13.3 changes a call site it owns
flox activate -- task test:one -- skifree                 # cvToCanvasCoord + the gate hook
# 3. the inventory string + blockers (§13.6)
flox activate -- task test:one -- face-migration-inventory
flox activate -- task test:one -- group-viz-hosts          # §13.4 touches its comment only
# 4. e2e — ⚠ the WHOLE POINT is a run WITHOUT ?shell=legacy
flox activate -- task e2e:serve
REPEAT=3 flox activate -- task e2e:one -- tests/skifree.spec.ts
#    plus a NEW leg on the DEFAULT shell: spawn skifree, never open the dock, and assert
#    `gate` reaches a downstream SCOPE. It must FAIL on main and PASS after the fix.
flox activate -- task e2e:stop
# 5. typecheck LAST
flox activate -- task typecheck
# 6. VRT: nothing moves — skifree is EXEMPT_FROM_VRT and stays there. No dispatch.
# 7. attest: NIL. contract: unchanged. ART: unchanged. Push: unchanged.
```

**The negative control that makes §12 a fix rather than a hope, spelled out:** the new
default-shell leg must be **RED on `main`** — spawn skifree, never expand its dock pane, drive a
crash, and observe `gate` NOT reaching a downstream SCOPE — and **GREEN after**. A leg that only
ever passes proves the headless host mounted something, not that it mounted the right thing. ⚠
Pair it with a positive control on the same run (`?shell=legacy` still works), because *"a passing
negative control is NOT enough"*.

---

## 15. BUILD-COST ESTIMATE — for §12 only

| phase | estimate |
|---|---|
| move the controller publication into the component (or add the third `ProducerSeam` + its `why`) | ~2 h |
| enrol skifree; run `dom-source-modules` both directions and confirm the set is still DERIVED | ~1 h |
| §13.3 (pass the controller), §13.6 (inventory string + blockers), §13.4 (comment) | ~1 h |
| the RED-on-main default-shell e2e leg + its positive control | ~2.5 h |
| gate loop, 3× flake checks, typecheck | ~1.5 h |
| **total** | **≈ 8 h** |

**Risk rank: MEDIUM for the fix, and the FACE is REFUSED at any price.** The fix is worth doing on
its own merits and this week: a module that does not function in the shipping shell, with no test
that can observe it, is a worse problem than any face in this wave solves.
