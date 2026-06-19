# Plan B — monome-parity-plus (Unit L = clip matrix, Unit R = command deck)

> **CHOSEN — but superseded as the source of truth by
> [`launchpad-mk3-proposal.md`](./launchpad-mk3-proposal.md).** Plan B is the
> direction we adopt; the proposal carries the *final* form: the precise rename
> + shared-core extraction (§3), the Web-MIDI L/R pairing handshake (§4.3), the
> explicit **8×8 windowed editor** (an 8-step window = HALF a 16-step block, §6),
> and the **dir-button + SHIFT** navigation model (§7) that this draft predates.
> Read the proposal for what we'll build; read on here for the original Plan-B
> rationale + the coverage table.

**Philosophy:** keep our **exact current 8-lane × 8-slot model** on Unit L — a 1:1,
colour-upgraded port of today's monome grid, so the pure `grid-clip-map` logic and
the user's muscle memory transfer almost unchanged — and turn **Unit R into a
dedicated COMMAND DECK** where every shipped feature (copy / paste / paste-reverse /
the 2-row LENGTH-EDIT / DOUBLE / launch-quantize / scene snapshots / mute / solo) and
every editor control gets its **own labelled, lit, colour-coded button.** No
hold-modifier overloading where a real button will do.

> **Diagrams:** `plan-B-session.svg` (matrix + command deck) · `plan-B-editor.svg`
> (Unit L = full note grid, Unit R = editor deck) · `plan-B-length.svg` (the shipped
> 2-row LENGTH-EDIT: end-BLOCK ruler + end-STEP ruler). Colour legend:
> `legend-colors.svg`.

---

## Assumed device + layout (lead)

- **Device:** 2× **Launchpad Mini MK3** (IDs 1 = matrix, 2 = deck), Programmer
  mode, Web MIDI + SysEx. Pad note `r*10+c`; top row CC 91–98; right col CC 89…19;
  RGB via LED-lighting SysEx; pulse/flash on MIDI ch 2/3.
- **Two units:** distinct device IDs → two ports; "Unit L" binds the clip matrix +
  LED frame, "Unit R" binds the command/editor deck.

**If you actually meant…**
- **Launchpad X:** drop-in; velocity pads let the **velocity ladder** on Unit R be
  played by feel, and you could finger-drum notes into a clip. No layout change.
- **Launchkey Mini MK3:** the **25 keys replace pitch entry** (play notes/chords
  straight in), the **8 encoders become the command deck** (one encoder = velocity,
  one = length, etc.), and the **16 pads = an 8-slot × 2-lane clip strip** or
  drum-lane launch. Strong for editing, weak for an 8×8 session — a real variant
  worth its own sketch if this is the device.
- **Launch Control XL:** no grid; it can only *be* the command deck (its 8 faders =
  mixer, 24 encoders = macros, 16 buttons = copy/paste/etc.). Pair **1 Launchpad
  (matrix) + 1 Launch Control XL (deck)** and Plan B works beautifully — arguably
  its best hardware.

---

## Unit L — the clip matrix (1:1 with today, in colour)

Identical to `grid-clip-map.ts` SESSION mode, just on an 8×8 (no wasted columns,
because the control strip moved to Unit R):

- **rows = instrument lanes 1–8, columns = clip slots 1–8** (today's exact
  orientation — muscle memory preserved). Tap = launch/stop the lane via `queued[]`.
- **Right column = per-lane STOP** (today's col 8). Bright red where the lane plays,
  dim red idle. Top-right pad = **STOP-ALL**.
- **Top row = SCENE LAUNCH** (today's col 9 promoted to a full row — better, since a
  row reads as "fire this slot everywhere"). Amber.
- **Colour by state** (legend): empty=off, loaded=dim blue / clip tint,
  **playing=green pulse, queued-launch=green flash, queued-stop=red flash,
  recording=red pulse, copy-source=turquoise pulse.** A clip currently in the
  per-machine clip buffer glows turquoise so you always see your copy source (shown in
  the diagram at lane 2 slot 3) — the RGB analogue of the shipped COPY-INDICATOR pulse.

That's the *entire* current feature set, byte-for-byte the same writes to
`node.data.queued`, so it's multiplayer-synced and the existing pure mapping +
tests port directly.

---

## Unit R — the COMMAND DECK (every new feature gets a real button)

The deck is laid out as functional **columns** so it reads at a glance (see diagram):

### Top row — global transport + clipboard + alignment

| Pad | Function | Colour |
|---|---|---|
| ▶ | transport play/stop (`TIMELORDE.running`) | green |
| ● | song-record arm (arranger `recording`) | red |
| SONG | session ↔ arrangement (`clipMode`) | white / lit when arrangement |
| ALIGN | **transport-start re-alignment** (all playing clips → step 1; happens on ▶ start) | white |
| COPY | **hold** + tap a clip on Unit L → grab it into the per-machine buffer | turquoise (bright while held) |
| PASTE | **hold** + tap a clip on Unit L → create-or-overwrite from the buffer | violet (bright while held) |
| PASTE-REV | **hold** + tap a clip → paste a **reversed** copy (held-note spans mirrored) | magenta (bright while held) |
| QNT/NOW | launch-quantize modifier (held = launches fire NOW, `queuedImmediate`) | white→violet when held |

**Copy / paste / paste-reverse flow (matches shipped):** these are **press-and-HOLD
modifiers**, not latches. **Hold COPY** and tap a source clip on Unit L → it is copied
into the per-machine buffer (`copyClip`) and the buffer indicator pulses turquoise.
**Hold PASTE** (or **PASTE-REV**) and tap a destination clip → it is created or
overwritten from the buffer (PASTE-REV applies `reverseClipSteps`, mirroring each
held-note span within `lengthSteps`). Cross-unit gesture, fully visible, no chords;
the buffer survives a re-bind (it's the machine's clipboard). The shipped pure helpers
`copyClip` / `reverseClipSteps` already exist.

### Left columns — per-lane mute / solo, length, quantize

- **MUTE column** (8 pads, one per lane): yellow when audible/active, dim when
  muted (Ableton mute colour idiom). Mute = a per-lane gain-0 / gate-gate flag.
- **SOLO column** (8 pads): blue when solo'd.
- **LEN− / LEN+ columns** (per-lane, or a single pair acting on the focused lane):
  a quick coarse shorten/lengthen of that clip's length (block-stepped), supporting
  **polymeter** lanes (clip 1 = 12 steps, clip 2 = 16, etc. — the shipped ≤128-step
  model). Distinct independent lengths per clip are exactly what makes polymeter
  legible here; the *precise* end-block/end-step is set in the editor's LENGTH-EDIT
  page (see `plan-B-length.svg`). All these clips free-run between transport starts
  and **re-align to step 1 on ▶ start**.
- **QUANTIZE ladder** (a column): pick the global launch quantize — 1 bar / 1/2 /
  1/4 / 1/8 / 1/16 / NOW. Current setting lit violet. (QNT/NOW on the top row is the
  momentary "launch NOW regardless", i.e. `queuedImmediate`.)

### Right column — EDIT, DOUBLE, scene snapshots, REC

- **EDIT** (violet, hold): hold + tap a clip on Unit L → enter the note editor.
- **DOUBLE** (white): duplicate the clip's pattern into the back half + double its
  length, capped at 128 (the shipped `doubleNoteClip`; a no-op at 128). This is
  distinct from setting an exact length — that's the LENGTH-EDIT page.
- **SCENE 1–4 snapshots** (amber): store/recall a whole playing-set as a one-press
  scene (beyond the 8 column-scenes — named user scenes).
- **REC** (red): record-arm the focused lane for live note capture.

---

## Editor view — Unit L = full note grid, Unit R = editor deck

When EDIT is held + a clip tapped, **Unit L flips to a full 8-row note grid** and
**Unit R flips to an editor deck** (see `plan-B-editor.svg`). Because the controls
live on Unit R, **all 8 rows of Unit L are pitch** (today's monome editor sacrifices
a row to the function strip — here it doesn't).

- **Unit L:** top row = 16-step **block / half-block select** (a block fills two
  8-column half-pages; current half-block lit white); 8×8 = pitch × step; note
  colour = velocity (RGB ramp); held spans = bars; playhead = amber column + yellow
  note boost (drawn only on the playing block). **FOLLOW** lives on Unit R; while
  following, the shown half-block tracks the playhead and ◀PG/PG▶ are dim no-ops;
  freeze FOLLOW to page manually.
- **Unit R editor deck:**
  - **VELOCITY ladder** — a vertical 6-step fader (0/20/40/60/80/100%, the shipped
    `VEL_LEVELS`); tap a level, then tapped notes take that velocity (and the level
    shows as the note's RGB shade). This replaces the monome's hold-VEL-and-cycle with
    a **direct pick** — far faster, and impossible on a single-hue grid.
  - **SCALE column** — MAJ / MIN / PENT / CHROM direct-select + ROOT± + MONO toggle.
  - **LENGTH (2-row LENGTH-EDIT)** — a faithful render of the shipped length page: an
    **end-BLOCK** ruler (1..8 ×16 steps; counted blocks dim, end block bright) + an
    **end-STEP** ruler (1..16 within the end block). Length = (endBlock−1)×16 +
    endStep, up to 128, **non-destructive**. See `plan-B-length.svg`. (Plan B's deck
    gives this its own labelled rulers instead of cycling through fixed lengths.)
    **DOUBLE** + **FOLLOW** + **◀PG/PG▶** are dedicated pads here too.
  - **PITCH-WINDOW column** — OCT± / ROW± / NUDGE (scroll the in-key window).
  - **COPY / PASTE / PASTE-REV / ◀PG / PG▶** on the top row (the held-modifier flow;
    copy can also work at the *step-range* level inside the editor — copy a bar, paste
    it, paste-reversed).
  - **EXIT** (red), **PROB** (per-step probability ladder, using `NoteEvent.prob`).
  - A **reserved quadrant** for future per-step probability / micro-timing / clip
    colour / humanize — it grows without ever stealing note pads.

---

## How every feature is reached (coverage table)

| Feature | Plan B control |
|---|---|
| Launch / stop / scene / stop-all | Unit L matrix + top row + right col (as today) |
| Per-lane mute / solo | Unit R MUTE / SOLO columns |
| Copy / paste / **paste-reverse** (held + tap) | Unit R COPY / PASTE / PASTE-REV (dedicated, visible) + turquoise buffer indicator |
| Clip length (end-block + end-step) / **polymeter** | Unit R LEN± per clip + editor 2-row LENGTH-EDIT |
| DOUBLE (dup + ×2 length, cap 128) | Unit R DOUBLE pad |
| Launch-NOW / quantize | Unit R QNT/NOW pad + QUANTIZE ladder (`queuedImmediate`) |
| Transport / transport-start re-align (all clips → step 1) | Unit R ▶ / ALIGN (auto on ▶ start) |
| Song record / session↔arrangement | Unit R ● / SONG |
| Scene snapshots | Unit R SCENE 1–4 |
| Note add / tie | editor pad tap / hold-tap span (Unit L) |
| **Velocity (direct, 6 levels)** | editor VELOCITY ladder (Unit R) |
| Probability | editor PROB ladder (Unit R) |
| Scale / root / mono | editor SCALE column (Unit R) |
| Octave / row scroll | editor PITCH-WINDOW column (Unit R) |
| FOLLOW (auto-scroll) / freeze + page nav | editor FOLLOW pad + ◀PG/PG▶ |
| ≤128 steps (16-step blocks) | editor block/half-block select |

**Every shipped feature has a dedicated, lit button** — the bar the prompt set
("at least as capable as the grid spec") is cleared with room to spare.

---

## UX wins vs. the monome grid

- **Exact parity, zero relearning** on Unit L — same orientation, same gestures,
  same `node.data` writes; the pure code and tests port over.
- **Every new feature is a labelled, colour-coded button** instead of a hidden
  chord — the Polyend/Elektron lesson done right (we have the button budget).
- **Velocity becomes a direct 6-level pick** (the editor's biggest single win;
  hold-and-cycle is gone).
- **Full 8 pitch rows** in the editor (the function row no longer eats a row).
- **Clipboard source visibly glows** (turquoise) — copy/paste is legible, which it
  fundamentally can't be on a single-hue grid.
- **Mixer (mute/solo) on the surface** — impossible on the monome.

## Cons

- **Editor still takes over Unit L** (the matrix disappears while you edit) — this
  is the one place Plan C is better, and the recommended fix is to fold Plan C's
  "matrix stays live" rule in for v2 (editor on Unit R's region / focused-clip).
- **Unit R is dense** — lots of small functions; needs a good printed/overlay legend
  or the text-scroll feature to label modes. Mitigated by colour-coding by function
  family.
- **Two clip-players?** No — Plan B is one 8-lane clip-player; Unit R is pure
  control, so no model change at all (cleanest of the three on that axis).

## Verdict — **recommended first build.** Lowest-risk port of the existing code,
clears the feature bar with dedicated buttons, biggest editor win (velocity ladder),
and leaves a clear v2 path (borrow Plan C's persistent matrix).
