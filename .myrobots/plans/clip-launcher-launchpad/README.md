# Clip Launcher on Novation pad controllers — research + 3 implementation plans

**Status:** research + design. For owner evaluation.
**Date:** 2026-06-18 (original) · **revised 2026-06-19**.
**Scope:** how patchtogether.live's CLIP LAUNCHER (the `clipplayer` module, today
driven by a monome grid) would map onto a pair of Novation MK3 pad controllers.

---

## ⇒ READ FIRST: the chosen direction is `launchpad-mk3-proposal.md`

This README + plan-A/B/C are the **research + exploration**. The **decision** —
the rename plan, the two-Launchpad left/right split, the dir-button + SHIFT nav
model, the LED scheme, the change-list, and the OPEN QUESTIONS for the owner — now
lives in **[`launchpad-mk3-proposal.md`](./launchpad-mk3-proposal.md)**, which
**adopts Plan B** and supersedes it as THE plan. The 3 plans stay here as the
alternatives + history.

**What's new since the original draft (folded into the proposal + these docs):**
- **8×8 reality is now explicit.** A Launchpad shows only **8 of the 16 steps** in a
  block, so the editor is a **windowed 8×8** view, navigated by the dir buttons.
- **The two Launchpads are split L = clip matrix / R = command deck** (Plan B), and
  the proposal pins exactly how they pair over Web MIDI (press-a-pad handshake) and
  how each half maps onto the monome's old 16×8 surface.
- **Navigation = the dedicated ▲▼◀▶ buttons (one row/col per press) + a SHIFT
  modifier (held Session/▣ button, CC 95) that jumps a full screen (8) at a time** —
  global, not editor-only, and composes with the held copy/paste/edit gestures.
- **The rename is precise:** the ENGINE module stays `clipplayer`; only the
  monome CONTROL layer (`lib/grid/*`) is renamed to `monome-control`, with the
  PURE clip-surface logic extracted into a controller-agnostic core both the monome
  and the two Launchpads share. (See the proposal §3.)
- **Re-grounded on shipped #827** (the "Updated to shipped #827 behavior" section
  below is unchanged and still correct; the proposal §1-§2 cite exact file:line).

The new colour-coded mockups for the chosen direction are `launchpad-left.svg`,
`launchpad-right.svg`, `launchpad-clipedit.svg`, `launchpad-shift-legend.svg`.

---

## Updated to shipped #827 behavior — what changed from the original proposal

These plans were first drafted in parallel with the clip-launcher design and cited
the *in-flight* spec. **PR #827 has now merged to main**, so the docs below have been
**re-grounded on the shipped clip-launcher** (`clip-types.ts`, `grid-clip-map.ts`,
`grid-clip-binding.svelte.ts`, `clip-grid-spec.ts`). The substantive corrections:

- **FOLLOW (not "HOLD") is the page-freeze toggle.** The editor has a dedicated
  **FOLLOW** pad: lit = the shown page auto-scrolls with the playhead; **flashing =
  frozen** on a page, and **LEFT / RIGHT page** through the clip while frozen
  (a no-op while following, and at the ends). The original docs called this "HOLD"
  and conflated it with the session launch-NOW modifier — those are two different
  things and both are now named correctly (FOLLOW = editor page-freeze; the session
  immediate-launch override is `queuedImmediate`).
- **Patterns are up to 128 steps, modelled as 16-step BLOCKS (8 blocks).** The
  shipped constants are `MAX_CLIP_STEPS = 128`, `STEPS_PER_PAGE = 16`,
  `MAX_EDIT_PAGES = 8`. The original docs described "8-step pages → ≤64 steps, ≤128
  with DOUBLE", which was the 8-wide-Launchpad pad count leaking into the model. The
  model's page/block is **16 steps**; a Launchpad's 8 columns show **half a block**,
  so the plans now spell out the Launchpad's block↔column mapping explicitly.
- **LENGTH-EDIT is a dedicated 2-row page, not a length cycle.** Row 1 pads 1–8 =
  coarse **end-BLOCK** (each = 16 steps; counted blocks dim, the end block bright),
  row 1 pad 16 = **EXIT**; row 2 pads 1–16 = fine **end-STEP** within the end block.
  Length = (endBlock−1)×16 + endStep, up to 128, and it is **non-destructive**
  (shortening hides notes past the new end but keeps them — they return when you
  lengthen again). The original "LEN ×2 / 8·16·32·64 cycle" framing is replaced.
- **DOUBLE is its own gesture** = duplicate the pattern into the back half and double
  the length (cap 128); a no-op at 128. It is **not** the length editor — the docs
  previously blurred "LEN ×2" and DOUBLE into one pad.
- **COPY / PASTE / PASTE-REVERSE are press-and-HOLD modifiers.** You **hold** COPY
  (or PASTE / PASTE-REV) and **tap a clip**: hold-COPY + tap grabs that clip into a
  **per-machine buffer**; hold-PASTE + tap a destination creates-or-overwrites it;
  hold-PASTE-REV + tap pastes a **reversed** copy (each held-note span mirrored). A
  **COPY-INDICATOR pulses** while the buffer holds a clip. The original "tap COPY to
  arm, then tap a clip" latch flow is replaced with the shipped hold-modifier flow.
- **Per-clip independent length → polymeter, re-aligned on transport start.** Each
  clip free-runs at its own length between transport starts; on **transport start**
  all playing clips **re-align to step 1**. The docs now say "polymeter" (independent
  per-clip lengths) rather than "polyrhythm", and tie ALIGN to transport-start.

The plans still map these onto the **2× Launchpad** surface + the RGB colour
language, and the 3-plan A/B/C structure with the **Plan B recommendation** is
unchanged. Where the monome editor packs everything onto one 16-wide surface, the
Launchpad's extra unit/buttons let several of these (FOLLOW, LENGTH-EDIT, DOUBLE,
COPY/PASTE) become dedicated lit buttons instead of the monome's shared function row.

---

## TL;DR

- **Assumed device:** **Novation Launchpad Mini MK3** (8×8 RGB grid + 8 top
  function buttons + 8 right-side function buttons), **two units** over USB.
  This is the closest real product to the owner's stated "launchcontrol micro
  mk3" (which isn't a shipping Novation name — see "What did you actually mean?"
  below). It is the cheapest RGB clip-launcher Novation makes and is purpose-built
  for exactly this job.
- **Three plans, three philosophies:**
  - **Plan A — Ableton-faithful:** the two units fuse into one **16-lane × 8-scene
    wall**. Maximum live clip real estate, Live-standard colours; the editor
    borrows a unit on demand.
  - **Plan B — monome-parity-plus:** **Unit L = the clip matrix** (a 1:1 colour
    upgrade of today's grid), **Unit R = a dedicated command deck** that gives the
    shipped features (copy/paste/paste-reverse, the 2-row LENGTH-EDIT, DOUBLE,
    FOLLOW + page-nav, launch-quantize) and the editor controls their own
    *permanent, labelled, colour-coded* buttons — no hold-modifier overloading.
  - **Plan C — role split:** **Unit 1 is ALWAYS the clip matrix**; **Unit 2 is a
    context surface** that morphs between EDIT / MIXER / SONG / FX. You never lose
    the launch grid while editing or mixing.
- **Recommendation: Plan B** for the first build (best parity + best use of the
  extra buttons + lowest-risk port of the existing pure code), with **Plan C's
  "matrix never disappears" rule folded in as a v2 enhancement.** Rationale at the
  bottom.

---

## Files in this folder

| File | What it is |
|---|---|
| `README.md` | this overview + device research + prior art + recommendation |
| `legend-colors.svg` | the shared RGB **colour language** (state → colour) |
| `plan-A.md` / `plan-A-session.svg` / `plan-A-editor.svg` | Ableton-faithful 16-wide wall |
| `plan-B.md` / `plan-B-session.svg` / `plan-B-editor.svg` / `plan-B-length.svg` | monome-parity-plus matrix + command deck + LENGTH-EDIT view |
| `plan-C.md` / `plan-C-session-mixer.svg` / `plan-C-editor.svg` | role split (persistent matrix + context surface) |

> The LENGTH-EDIT (block + step) view ships as a diagram on Plan B (`plan-B-length.svg`),
> since Plan B's editor deck is where the shipped 2-row length model lives most
> faithfully; Plans A and C describe how they reach the same end-block/end-step model.

> The SVGs are hand-authored, dark-theme, colour-accurate renders that match the
> in-app `GridDiagram` aesthetic (rounded pads, role colours, labels). Open them
> directly to compare layouts visually.

---

## Device research (verified against the manufacturer docs)

### What did you actually mean? ("launchcontrol micro mk3")

There is no Novation product called "Launchcontrol micro mk3". The likely intents,
and how each plan changes if that's what you meant:

- **Launchpad Mini MK3** *(assumed default)* — 8×8 RGB grid, 8 top + 8 right
  function buttons, **no knobs/faders**, USB-only, no MIDI DIN. This is the
  product these plans are written for.
- **Launchpad X** — same 8×8 + top/right button topology, but **velocity- AND
  pressure-sensitive** pads and slightly bigger pads + a 3.5 mm MIDI out. *Drop-in
  for every plan; you additionally gain real velocity capture (you could play
  notes into a clip by feel) and poly-aftertouch as a modulation source.* Nothing
  in the layouts changes.
- **Launchkey Mini MK3** — a 25-mini-key keyboard with only **16 RGB pads (2×8)**,
  8 encoders, and pitch/mod touch strips. *This is a very different surface.* You'd
  get a real **piano keyboard for note entry** (huge for the clip editor) and **8
  encoders** (perfect for mixer/macros), but only 16 pads — far too few for an 8×8
  session matrix. Two of them = 32 pads, still not a full session. With Launchkey
  the natural split is **keys+encoders for editing/mixing, pads for a 2×8 clip
  strip or drum-lane launch.** See each plan's "if you meant Launchkey" note.
- **Launch Control XL (MK3)** — **no pad grid at all**: 8 faders, 24 RGB encoders,
  16 buttons, an OLED. *Cannot be a clip-launch matrix.* It is an outstanding
  **mixer / macro companion** to a Launchpad — i.e. it slots in as "Unit 2" in
  Plan C's MIXER role and nothing else. If you bought *two* of these you'd have no
  launch surface; pair ONE with a Launchpad instead.

**Bottom line:** the plans assume **2× Launchpad Mini MK3**. If you meant Launchpad
X, the plans are unchanged (plus velocity). If you meant Launchkey Mini, read the
per-plan Launchkey notes — the keyboard rewrites note entry. If you meant Launch
Control XL, you want **1 Launchpad + 1 Launch Control XL**, which is exactly Plan C.

### Launchpad Mini MK3 — exact layout & capabilities (from the Programmer's Reference)

- **Surface:** 8×8 grid of RGB pads, a top row of 8 round buttons, and a right
  column of 8 round buttons. 81 addressable LEDs total (incl. the logo).
- **Two USB-MIDI port pairs per unit:**
  - `LPMiniMK3 DAW In/Out` — the "Session" surface a DAW drives.
  - `LPMiniMK3 MIDI In/Out` — Custom modes + **Programmer mode** (the one we use).
- **Programmer mode** (entered by SysEx `F0 00 20 29 02 0D 0E 01 F7`) makes
  *every* pad and button send/receive Note or CC, with full per-LED control. This
  is the mode the existing `mext` grid binding's moral equivalent targets — we send
  an LED frame, we receive key events. Return to normal with `…0E 00 F7`.
- **Pad addressing (Programmer mode):** the 8×8 uses **decimal row/col note
  numbers** — pad at row *r* (1=bottom … 8=top), column *c* (1=left … 8=right) is
  **note `r*10 + c`** (so bottom-left = 11, top-right = 88). The **top row** = CC
  **91…98** (left→right). The **right column** = CC **89, 79, 69, 59, 49, 39, 29,
  19** (top→bottom). Logo = CC 99.
- **Colour — three ways, all per-LED:**
  - *Palette index* (1 byte, 0–127): Note-On velocity / CC value on **channel 1**.
  - *Flashing*: channel 2 — alternates the pad's static colour (A) with the event's
    colour (B), beat-synced.
  - *Pulsing*: channel 3 — fades dark↔full, beat-synced (2-beat period).
  - *Full RGB*: the **LED-lighting SysEx** `F0 00 20 29 02 0D 03 <spec…> F7`, where
    each `<spec>` = `type, ledIndex, data`. **type 3 = RGB**, data = R,G,B each
    **0–127**. Up to 81 specs per message → a whole-surface repaint in one SysEx.
- **Key palette indices** (stable across the MK3 family): `0`=off, `3`=white,
  `5`=red, `7`=dim red, `9`=amber/orange, `13`=yellow, `21`=green, `37`=turquoise,
  `45`=blue, `49`=violet/light-blue. Our colour legend prefers **RGB SysEx** for
  exact hues and only cites the nearest index for reference.
- **Brightness:** global SysEx `…08 <0-127> F7`.
- **Text scroll:** SysEx `…07 …` can scroll a label across the pads (handy for
  "EDIT", "COPIED", clip names — a nice touch the monome grid can't do).

### Addressing **two** units over one USB

Each Launchpad Mini MK3 has a **USB device ID 1–16**, set in its bootloader (hold
*Capture MIDI* while plugging in; the top two pad rows pick the ID). **Give the two
units different IDs (e.g. 1 and 2).** Each then enumerates as its own MIDI port
pair (`LPMiniMK3 MK3 …` with a distinct port name / index), so the app sees two
independent devices. In the browser that's two `MIDIInput`/`MIDIOutput` entries via
the **Web MIDI API** (SysEx access required — `navigator.requestMIDIAccess({ sysex:
true })`); we bind unit-1 and unit-2 by port name. No helper app needed (consistent
with the "no native helper apps" repo rule — Web MIDI is browser-native, unlike the
monome grid which we reach over WebSerial).

> **Footgun:** if both units keep the factory ID 1, some hosts merge or mis-order
> the ports. The setup flow must walk the user through setting distinct IDs (or at
> least detect duplicate-name ports and prompt). Document it in the connect UI.

---

## What we're mapping: the current clip launcher (ground truth from source)

Read from `packages/web/src/lib/audio/modules/clip-types.ts`,
`clip-arrange.ts`, `clip-playhead.ts`, `packages/web/src/lib/grid/grid-clip-map.ts`,
`grid-clip-binding.svelte.ts`, `mext.ts`, and `clip-grid-spec.ts`:

- **Model:** 8 instrument **lanes** × 8 clip **slots** = 64 clips (`CLIP_LANES`,
  `CLIP_SLOTS`). Flat index `lane*8 + slot`. Up to 8 clips play at once (one per
  lane). Each clip is a tiny note pattern (`NoteClipRecord`: sparse `NoteEvent[]`,
  `lengthSteps`, `root`, optional `scale`).
- **Synced launch state** lives on `node.data`: `playing[lane]`, `queued[lane]`
  (a slot, `'stop'`, or null), `queuedImmediate[lane]` (launch-NOW override),
  `mono[lane]`. Quantize boundary applies the queue; this is what every peer + the
  card + the grid all read/write — **the Launchpad writes the same fields**, so it
  inherits multiplayer sync for free.
- **Session interactions today (monome, as shipped #827):** clip pad → launch/stop
  its lane; right col 8 = per-lane STOP; right col 9 = **scene launch** (fire slot
  *y* across all lanes); the right column (col 15) stacks **EDIT (15,0) · COPY (15,2)
  · COPY-IND (15,3) · PASTE (15,4) · PASTE-REV (15,5) · STOP-ALL (15,6) · TRANSPORT
  (15,7)** (toggles TIMELORDE.running). COPY / PASTE / PASTE-REV are **held**
  modifiers (hold + tap a clip); the COPY-INDICATOR pulses while the per-machine clip
  buffer is loaded.
- **Editor today (monome, as shipped #827):** the whole 16×8 becomes a note grid —
  X = step, Y = pitch (in-key, 7 rows + a function row). Function row (with spacer
  gaps): EXIT, **VEL** (hold + tap to cycle a note's velocity through 6 levels), ROW±,
  OCT±, SCALE, **FOLLOW**, **LEFT**, **RIGHT**, **DOUBLE**, **LENGTH-EDIT**. Tap
  toggles a note; hold a note + tap another in the row = a tied/held span. A clip
  spans up to **8 pages of 16 steps** (128 max); **FOLLOW** auto-scrolls the shown
  page with the playhead, or tap it to **freeze** (it then flashes) and **LEFT/RIGHT**
  page through it. **DOUBLE** duplicates the first half into a doubled length (cap
  128). **LENGTH-EDIT** opens a dedicated 2-row length page. Velocity renders as 3
  brightness buckets; the playhead column boosts the note it crosses.
- **Velocity:** 6 levels `[0,25,51,76,102,127]`, default 76 (`VEL_LEVELS`,
  `VEL_DEFAULT`); displayed as 3 colour buckets on a single-colour grid (`velBucket`).
- **Length model (shipped):** `MAX_CLIP_STEPS = 128`, `STEPS_PER_PAGE = 16`,
  `MAX_EDIT_PAGES = 8`. Length is described as an end-BLOCK (1..8, ×16 steps) + an
  end-STEP within it (1..16): `length = (endBlock−1)*16 + endStep`. The LENGTH-EDIT
  page edits exactly these two rulers (pure helpers `lengthEndBlock` / `lengthEndStep`
  / `lengthFromBlockTap` / `lengthFromStepTap`). Per-clip lengths are independent →
  **polymeter** (clips free-run between starts and **re-align to step 1 on transport
  start**). Shortening is non-destructive (`doubleNoteClip` / `reverseClipSteps` /
  `copyClip` are the pure transforms).
- **Song mode (arranger):** `clip-arrange.ts` records a timestamped event log of
  launches and replays it (`clipMode: 'session' | 'arrangement'`, `recording`).
- **SHIPPED GRID feature bar** (we must be **at least as capable** on Launchpad):
  per-clip **copy / paste / paste-reverse** (held modifiers + a buffer indicator),
  **≤128-step polymeter** patterns, clip-edit **FOLLOW / page-nav (LEFT/RIGHT) /
  DOUBLE / LENGTH-EDIT (2-row)**, and **transport-start re-alignment** (all clips
  snap to step 1).

**Why Launchpad is a strict upgrade over the monome here:** the monome grid is
**varibright (16 grey levels), single-hue.** Today the editor has to collapse 6
velocity levels into 3 brightnesses and "empty vs. note" is the *only* state a pad
can show. The Launchpad is **full RGB + per-LED pulse/flash**, so every clip state
(empty / loaded / playing / queued-launch / queued-stop / recording / clipboard)
gets a **distinct colour or animation** instead of a brightness ramp — exactly the
problem the comment in `grid-clip-map.ts` ("that's the grid's 4-colours-1-dark
reality") calls out. And the monome has **no dedicated buttons**; the Launchpad's
16 function buttons (plus a whole second unit) absorb every new copy/paste/length
function without hold-modifier overloading.

---

## Prior art we're adopting (and the footguns)

### Ableton Live + Launchpad native Session mode (the canonical colour language)

- **Playing clip = green, pulsing.** **Queued (pressed, waiting for the bar) =
  green, flashing.** **Empty/loaded = dim.** (Source: Novation "Using Launchpad
  Mini's Session mode"; Ableton "Launching Clips".)
- **Record-armed lane → empty slots dim red; queued-to-record flashes red;
  recording pulses red.** We map this to the arranger's record-arm + a future audio
  clip record.
- **Stop row = bright red where a track is playing** (press to stop). **Mute row =
  bright yellow where a track is audible.** We reuse red for STOP, yellow/amber
  family for SCENE + MUTE.
- **Scene launch is a dedicated column** that fires a whole row. We keep it.
- **Footgun (queue legibility):** Live distinguishes *playing* (pulse) from *queued*
  (flash) by **animation**, not hue — both green. On hardware that reads instantly;
  copying that exactly avoids inventing a second green. We do.
- **Footgun (clip colour vs. state colour):** Live tints clips by the user's track
  colour AND overlays play-state. On one LED you can't show both. We **prioritise
  STATE** (a playing clip is always green) and use the clip's own `color` field only
  for *idle/loaded* pads — matching Live's behaviour where the play overlay wins.

### Ableton Push (session + note + device modes)

- Push's big idea: **one surface, modal** — Session turns pads into clips, Note
  turns them into an instrument, Device puts params on encoders, and the **layout
  is always in-key** in Note mode (Plan A/B/C all keep in-key rows). Push proves a
  modal pad surface works; it also shows the **cost**: when you're in Note mode you
  **can't see your clips.** That pain is precisely what **Plan C** fixes by
  dedicating Unit 1 to the matrix permanently.
- Push's **per-step velocity / probability lanes** and **loop-length row** inspire
  Plan B's editor deck (a real 6-step velocity *ladder* instead of a hold-cycle).

### monome conventions (what to keep)

- **Stateless, hold-modifier gestures** (hold EDIT/VEL + tap), **per-machine binding**
  (the controller is "your hardware", like a MIDI-learn), **LED frames are local
  render state, never synced.** All three plans preserve these — they're already how
  `grid-clip-binding.svelte.ts` works, so the existing pure mapping code ports almost
  verbatim. The big change is the LED frame becomes RGB, and we gain real buttons so
  we can *reduce* reliance on hold-modifiers where it improves clarity (Plan B/C).

### Elektron / Polyend function-button idioms

- **Dedicated, always-visible, colour-coded function buttons** (Polyend's
  green/yellow/pink/blue parameter buttons; Elektron's FUNC + trig-condition /
  copy-paste-clear combos). The lesson: **copy/paste/length/probability deserve
  their own labelled, lit buttons**, not buried chords. This is the soul of **Plan
  B's command deck** and **Plan C's context surface.**
- **Footgun (chord overload):** Elektron's power-user combos are notoriously
  unlearnable for newcomers. With a second whole Launchpad we have the button budget
  to make each function a **single dedicated pad**, so we should — reserve chords
  only for rare/destructive actions (e.g. hold-CLEAR + clip).

---

## Recommendation

**Build Plan B first, with one rule borrowed from Plan C.**

- **Plan B** maps our *exact* current model 1:1 onto Unit L (so the existing pure
  `grid-clip-map` logic ports with minimal change and the muscle memory transfers),
  while Unit R turns every shipped feature (copy/paste/paste-reverse, the 2-row
  LENGTH-EDIT, DOUBLE, launch-quantize/NOW, scene snapshots, per-lane mute/solo) and
  every editor control (velocity *ladder*, scale, FOLLOW + page-nav, octave/row) into
  a **dedicated, lit, colour-coded button.** That is the single biggest UX win over
  the monome and it needs no clever layout gymnastics.
- **Borrow Plan C's "Unit 1 never stops being the matrix" rule:** even in Plan B,
  when Unit L flips to the note editor you *lose* the launch grid. The cleanest
  hybrid is: **editor opens on Unit R's deck area / or a held mode, and the matrix
  stays live on Unit L** — i.e. Plan C's persistence applied to Plan B's deck. Ship
  Plan B's command deck now; make the editor non-modal-over-the-matrix in v2.
- **Plan A** is the right call *only if* the owner's priority is "as many live
  clips as possible, Ableton muscle memory" and they rarely edit on the hardware.
  It's the simplest to reason about but it throws away the second unit's potential
  as a control surface and makes the editor a full-screen takeover.
- **Plan C** is the most ambitious and the best end-state, but it's the most code
  (a role state-machine on Unit 2, Launchpad DAW-fader layout for the mixer). Great
  as the north star; heavier as a first slice.

**If the hardware is actually a Launchkey Mini or Launch Control XL,** the
recommendation flips toward **Plan C** (keyboard/encoders are made for the
EDIT/MIXER roles, and a single Launchpad carries the matrix) — see each plan's
device note.

---

## Sources

- [Launchpad Mini MK3 Programmer's Reference Manual (PDF)](https://www.djshop.gr/Attachment/DownloadFile?downloadId=10737)
- [Launchpad X Programmer's Reference Manual (PDF)](https://fael-downloads-prod.focusrite.com/customer/prod/s3fs-public/downloads/Launchpad%20X%20-%20Programmers%20Reference%20Manual.pdf)
- [Launchkey MK3 Programmer's Reference Guide (PDF)](https://fael-downloads-prod.focusrite.com/customer/prod/downloads/launchkey_mk3_programmer_s_reference_guide_v1_en.pdf)
- [Launch Control XL 3 — Novation product page](https://novationmusic.com/products/launch-control-xl)
- [Launchkey Mini MK3 — Novation product page](https://novationmusic.com/products/launchkey-mini-mk3)
- [Using Launchpad Mini's Session mode — Novation User Guides](https://userguides.novationmusic.com/hc/en-gb/articles/23731303692306-Using-Launchpad-Mini-s-Session-mode)
- [Using Launchpad X's Session mode — Novation User Guides](https://userguides.novationmusic.com/hc/en-gb/articles/23731420256018-Using-Launchpad-X-s-Session-mode)
- [Launching Clips — Ableton Reference Manual v12](https://www.ableton.com/en/manual/launching-clips/)
- [Using Push 2 — Ableton Reference Manual v12](https://www.ableton.com/en/manual/using-push-2/)
- [Polyend Play / Tracker+ manuals](https://polyend.com/manuals/play/)
