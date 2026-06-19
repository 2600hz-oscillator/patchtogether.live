# Plan A — Ableton-faithful session wall (2 units = 16 lanes × 8 scenes)

**Philosophy:** treat the two Launchpads as **one wide Ableton Session View.** Unit
L is lanes 1–8, Unit R is lanes 9–16; the top row of each is **scene launch**, the
right column carries per-unit functions. Colours follow Ableton/Launchpad native
session mode exactly so anyone who has touched a Launchpad is instantly at home. The
note editor is a **temporary takeover** of whichever unit you opened a clip on.

> **Diagrams:** `plan-A-session.svg` (the 16-wide wall) · `plan-A-editor.svg` (a
> unit flipped to the note grid). Colour legend: `legend-colors.svg`.

---

## Assumed device + layout (lead)

- **Device:** 2× **Launchpad Mini MK3**, USB device IDs **1** (Unit L) and **2**
  (Unit R). Each = 8×8 RGB pads + 8 top + 8 right buttons; driven in **Programmer
  mode** over each unit's `MIDI In/Out` port via Web MIDI (SysEx enabled).
- **Pad addressing:** grid pad row *r* col *c* = note `r*10+c` (11=bottom-left …
  88=top-right); top row = CC 91–98; right column = CC 89,79,…,19. LEDs lit by RGB
  SysEx (`F0 00 20 29 02 0D 03 type=3 idx R G B … F7`) for exact hues; pulse/flash
  via channels 2/3.
- **Two units:** distinct bootloader device IDs → two independent port pairs; app
  binds "Unit L = lanes 0–7", "Unit R = lanes 8–15".

**If you actually meant…**
- **Launchpad X:** identical layout; you also get velocity/pressure, so a future
  "play notes into the wall" capture mode is possible. No layout change.
- **Launchkey Mini MK3:** only 16 pads per unit — **a 16-lane wall is impossible.**
  Plan A doesn't apply; use Plan C (keys for editing, pads for an 8-slot strip).
- **Launch Control XL:** no grid — Plan A impossible. Use Plan C with one Launchpad.

---

## Important: our model is 8 lanes, the wall is 16. Two sub-options.

The current `clipplayer` has **8** lanes. A 16-wide wall offers two readings — the
owner picks:

- **A1 — two clip-players side by side.** Unit L drives clip-player node #1 (lanes
  1–8), Unit R drives clip-player node #2 (lanes 9–16). This is the "two instruments
  worth of clips at once" reading and needs **zero model change** — each unit is a
  full instance of today's binding. Scenes fire per-unit (or linked, see below).
- **A2 — one 16-lane clip-player.** Bump `CLIP_LANES` to 16 (or add a "wide" mode).
  One node, 16 instrument lanes, 8 slots each. Bigger model change, but it's "one
  big rig". The pure helpers (`clipIndex`, `laneOf`, `slotOf`) already parameterise
  on `CLIP_LANES`, so the math generalises; the engine's per-lane output port count
  is the real cost.

The diagram shows the unified wall; both sub-options render identically.

---

## Session view — every pad/button

### The 8×8 clip matrix (per unit)

- **rows = scenes 1–8, columns = lanes** (this transposes today's grid so a *whole
  row* is a scene, matching Ableton, where a scene is a horizontal row). Tap a clip
  pad → **queue-launch** that clip in its lane (writes `queued[lane]=slot`,
  `queuedImmediate` per the HOLD modifier). Tap the playing clip again → **queue-stop**.
- **Colour by state** (see legend): empty = off; loaded = dim blue (or the clip's
  own `color` tint); **playing = green pulse**; **queued-launch = green flash**;
  **queued-stop = red flash**; **recording = red pulse**.

### Top row — SCENE LAUNCH (CC 91–98), amber

- Pad *n* fires slot *n* across **all 8 lanes** of that unit (today's
  `sceneSlotForPad`). Empty cells in the scene queue-stop their lane (current
  behaviour). **Both units' scene rows fire together** when scenes are *linked*
  (default), so one press launches a full 16-lane scene; an unlinked toggle lets
  each unit hold its own scene.

### Right column — per-unit functions (CC 89…19)

| Pad (top→bottom) | Unit L | Unit R |
|---|---|---|
| 1 (CC 89) | **STOP-ALL** (red) | **EDIT** hold (violet) |
| 2–7 (CC 79…29) | reserved (→ per-lane STOP overlay, see below) | reserved |
| 8 (CC 19) | — | **TRANSPORT ▶** (green when running) |

Because rows = scenes here, **per-lane STOP** moves to a **hold gesture**: hold
STOP-ALL + tap a column = stop just that lane (or a dedicated "stop strip" mode
toggled by a double-tap of STOP-ALL turns the bottom row into 8 per-lane stops). The
diagram shows the simple state; the owner can choose the stop ergonomics.

### Transport-start re-alignment (shipped)

- **TRANSPORT ▶** toggles `TIMELORDE.running` (today's behaviour). On a transport
  **start**, every playing clip **re-aligns to step 1** (the shipped behaviour — clips
  free-run at their own independent lengths between starts, i.e. **polymeter**, then
  snap back into phase together when transport restarts). **Hold ▶ + tap a scene** can
  surface an explicit re-align as a manual one-shot. Lit amber while held.

---

## Editor view — a unit flips to the note grid

Hold **EDIT** (Unit R, CC 89) + tap any clip on either unit → **that unit** becomes
the note editor for that clip (the *other* unit stays the live matrix — a small but
real concession toward Plan C's persistence). See `plan-A-editor.svg`.

- **Step model: 16-step BLOCKS, up to 8 blocks = 128 steps** (the shipped
  `STEPS_PER_PAGE=16`, `MAX_EDIT_PAGES=8`, `MAX_CLIP_STEPS=128`). A Launchpad row is
  only **8 columns**, so each block fills **two columns-pages** ("block N first half /
  second half"). The **top row = block / half-block select** (lit white = the shown
  half-block). **FOLLOW** (a top-row pad) auto-scrolls the shown half-block with the
  playhead; tap it to **freeze** (it flashes) and the **◀/▶** pads page through the
  blocks. This replaces the original "8-step pages, ≤128 only with DOUBLE" framing —
  DOUBLE is a separate gesture (below), not how you reach 128.
- **8×8 = note grid.** X = step (within the shown 8-column half-block), Y = pitch
  (in-key, root-row guide faint). **Note colour = velocity** via RGB (low/med/high
  blue→cyan ramp; the legend's 3 editor colours map to the 6 `VEL_LEVELS` buckets,
  but with RGB we can show all 6 as a smooth ramp). **Held spans** render as a
  multi-pad bar. The **playhead column** washes amber and boosts the note it crosses
  to yellow (drawn only when the playing block IS the shown block — the shipped
  rule).
- **Bottom function row:** EXIT (red) · VEL (violet, hold+tap cycles a note's
  velocity — or with RGB, *six* distinct shades so you see the exact level) ·
  OCT−/OCT+ · ROW−/ROW+ (white) · SCALE (cycles major→minor→pentatonic→chromatic) ·
  **FOLLOW** (steady = following, flashing = frozen) · **◀/▶** (page when frozen) ·
  **DOUBLE** (white — duplicate the pattern into the back half + double the length,
  cap 128; a no-op at 128) · **LEN** (amber — opens the 2-row LENGTH-EDIT page, see
  below). DOUBLE and LEN are **distinct**: DOUBLE copies content + doubles length;
  LEN sets an exact length non-destructively.
- **LENGTH-EDIT** (the LEN pad): the grid becomes the shipped **2-row length editor** —
  ROW 0 pads 1–8 pick the **end-BLOCK** (each = 16 steps; counted blocks dim, end
  block bright), ROW 0 pad 8 (or the far-right top button) = **EXIT**; ROW 1 pads
  1–8…(2 columns-pages) pick the **end-STEP 1–16** within the end block. Length =
  (endBlock−1)×16 + endStep, up to 128, **non-destructive** (notes past the new end
  are hidden, not deleted). On the 8-wide Launchpad the 16-cell end-step ruler needs
  two columns-pages (or doubles up on two grid rows) — see Plan B's `plan-B-length.svg`
  for the faithful render of the model.
- **Copy / paste / paste-reverse** in Plan A live as **held EDIT-mode modifiers**
  matching the shipped session flow (hold COPY/PASTE/PASTE-REV + tap a clip), but
  Plan A has no spare buttons so they overload onto held combos with EXIT — the only
  place Plan A is cramped. This is Plan A's weakness and the reason Plan B exists.

---

## How every feature is reached (coverage table)

| Feature | Plan A gesture |
|---|---|
| Launch / stop clip | tap clip / tap playing clip |
| Scene launch | top row pad (both units linked) |
| Per-lane stop | hold STOP-ALL + tap column |
| Stop all | STOP-ALL pad |
| Transport | ▶ pad |
| Transport-start re-align (all clips → step 1) | automatic on ▶ start; explicit via hold ▶ + tap scene |
| Quantize / launch-NOW | global QNT = double-tap ▶; "NOW" override = hold a clip past the flash (`queuedImmediate`) |
| Note add / toggle / tie | editor pad tap / hold-tap span |
| Velocity (6 levels) | editor VEL hold + tap (RGB 6-level shades) |
| Scale / octave / row | editor SCALE / OCT± / ROW± |
| FOLLOW (page auto-scroll) / freeze | editor FOLLOW pad (steady=follow, flash=frozen) |
| Page nav (LEFT/RIGHT, when frozen) | editor ◀/▶ pads |
| ≤128 steps (16-step blocks) | block/half-block select on the top row |
| DOUBLE (dup + ×2 length, cap 128) | editor DOUBLE pad |
| Clip length edit (end-block + end-step) | editor LEN → 2-row LENGTH-EDIT page |
| Copy / paste / paste-reverse | **held EDIT-mode modifiers (cramped, no spare buttons)** |
| Song record / playback | hold ▶ menu (no dedicated pad) |

---

## UX wins vs. the monome grid

- **Instant Ableton familiarity** — colours and the scene-row metaphor are exactly
  Live's; a Launchpad user needs no manual.
- **16 lanes visible at once** (A1: two instruments; A2: one wide rig) — double the
  live clip real estate the monome 16×8 gives, *all of it clips* (no control strip
  eating columns).
- **RGB state clarity** — the monome's 4-grey reality becomes 7 distinct
  state colours + pulse/flash.

## Cons

- **Wastes the second unit as a control surface** — both units are "more clips",
  so copy/paste/length/mixer have **nowhere good to live** (chords only).
- **Editor is a full-unit takeover** — opening a clip steals an 8-lane half of your
  wall.
- **Scene-as-row transpose** differs from today's lane-as-row monome layout — muscle
  memory from the grid does *not* transfer (Ableton memory does).
- If model stays 8 lanes (A1), the two units are two *separate* clip-players, which
  may not be the "one rig" the owner pictures.

## Verdict

Choose Plan A only if the priority is **maximum live clips + Ableton muscle memory**
and on-hardware editing/copy-paste is rare. Otherwise Plan B or C use the second
unit far better.
