# CLIP PLAYER — a Deluge-flavored, Ableton-Session clip launcher

Status: **in build** (`feat/clipplayer-8lane-instruments`). This is the source of
truth for the module's behaviour and its two UIs (the card + the monome grid).
Code: `packages/web/src/lib/audio/modules/clipplayer.ts` (def + factory),
`packages/web/src/lib/audio/modules/clip-types.ts` (data model + pure helpers),
`packages/web/src/lib/ui/modules/ClipplayerCard.svelte` (card),
`packages/web/src/lib/grid/*` (hardware bridge + launch binding). Sibling module
`kria` is a separate, faithful monome-Kria step sequencer — *not* this.

---

## TL;DR

A **clip launcher** in the Ableton sense: a grid of small note clips you arm and
fire on the beat. We rotate Ableton's layout 90° so it sits naturally on a wide
monome grid:

- **8 rows = 8 instruments** ("lanes"). Each lane has its **own** pitch / gate /
  velocity output, so up to **8 clips sound at once** — one per instrument. This
  is the owner's model: *"each row of clips reflects a given instrument's
  different materials."*
- **8 columns = 8 clip slots** per instrument (alternative takes/variations).
- Fire a cell → that lane swaps to that clip on the next loop boundary. Up to one
  clip plays per lane at a time; firing a new one replaces the old.

```
            slot1  slot2  slot3  slot4  slot5  slot6  slot7  slot8
  lane1  →  [kick A][kick B][ ··· ][ ··· ][ ··· ][ ··· ][ ··· ][ ··· ]  → pitch1/gate1/vel1
  lane2  →  [snr  ][snr 2][ ··· ][ ··· ][ ··· ][ ··· ][ ··· ][ ··· ]  → pitch2/gate2/vel2
  lane3  →  [hats ][ ··· ][ ··· ][ ··· ][ ··· ][ ··· ][ ··· ][ ··· ]  → pitch3/gate3/vel3
  lane4  →  [bass ][bass2][bass3][ ··· ][ ··· ][ ··· ][ ··· ][ ··· ]  → pitch4/gate4/vel4
   ⋮                                                                       ⋮
  lane8  →  [ ··· ][ ··· ][ ··· ][ ··· ][ ··· ][ ··· ][ ··· ][ ··· ]  → pitch8/gate8/vel8
            └───────────────── one "scene" (a column) ─────────────────┘
```

A **scene** is a *column*: firing the column launches one clip per instrument
together (the classic Ableton scene, transposed).

The clips themselves are tiny **note/step patterns** edited in a Deluge-style
note grid (rows = pitches in-key, columns = steps), so the whole thing — launch
*and* compose — can be driven entirely from the monome grid, no mouse.

---

## 1. Clock: locked to TIMELORDE (no internal BPM)

The clip player has **no tempo knob and no clock cable**. It locks to
**TIMELORDE**, the rack's master transport:

- Runs only while `TIMELORDE.running`, at `TIMELORDE.bpm`.
- Freezes instantly when TIMELORDE stops; resumes phase-aligned on start.
- If there is **no TIMELORDE** in the rack, it free-runs (so a bare patch still
  makes sound).

The only timing control on the module is **STEP** — how many steps fit in one
TIMELORDE beat:

| STEP value | steps / beat | feel        |
| ---------- | ------------ | ----------- |
| `1/4`      | 1            | quarters    |
| `1/8`      | 2            | eighths     |
| `1/16`     | 4 (default)  | sixteenths  |
| `1/32`     | 8            | thirty-2nds |

### Transport on the card

The card shows **▶ / ■** transport that *writes* `TIMELORDE.running` — pressing
play on the clip player starts the whole rack. **But** if TIMELORDE is itself
slaved to an external clock (MIDICLOCK / `start_in` patched), the transport
buttons **hide** — you don't get to fight the upstream master; you just follow.
(`read('externallyClocked')` drives that visibility.)

---

## 2. Launch quantize

`QNT` decides *when* a fired clip actually swaps in:

- **`QNT = loop`** (default): the fire is *queued* and takes effect on that
  lane's **next loop boundary**, so everything stays in phase. The cell blinks
  while queued.
- **`QNT = now`**: the clip swaps in immediately on the next step.

Each lane queues independently (`data.queued[lane]`), so you can stack up a whole
new arrangement and have it drop in on the bar line.

---

## 3. The clip (a note pattern)

Each slot holds a **note clip** — a sparse list of note events over N steps
(default **16**, up to **64**). It is genuinely musical, not a one-note trigger:

- **Polyphonic** — multiple notes on the same step = a chord (up to the poly
  cap). Chords fan out across the lane's poly pitch/gate pairs.
- **Per-note length** — a note can sustain across several steps (held gate).
- **Per-note velocity** — drives the lane's `vel` CV out (max of the notes
  starting on a step).
- **Per-note probability** — optional 0..1 chance the note fires this loop.
- **Scale-aware** — a clip carries a root + scale (major / minor / pentatonic /
  chromatic). The editor's rows follow the scale so you can't play a wrong note.

### Outputs per lane

| Output      | Type            | Carries                                    |
| ----------- | --------------- | ------------------------------------------ |
| `pitchN`    | `polyPitchGate` | V/oct pitch (poly: chords → multiple pairs)|
| `gateN`     | `gate`          | note gate, width = note length × step      |
| `velN`      | `cv`            | 0..1 velocity of the step's loudest note   |

`N` = 1..8 (the instrument lane). **24 outputs total.** One input: `stop_all`
(gate) — a rising edge stops every lane at once.

---

## 4. The CARD UI

Two views in one 3u tile. **Session** (launch) is the default; **Edit** (compose
a clip) drills in.

### 4a. Session view (default)

```
 ┌─────────────────────────────────┐
 │ clip player            [grid ◇] │   ← title + GRID connect (monome)
 │ ▶ ■   STEP 1/16  OCT 0  QNT loop│   ← transport + params (▶■ hidden if ext-clocked)
 │ ┌───┬───┬───┬───┬───┬───┬───┬──┐│
 │1│███│▢▢▢│   │   │   │   │   │  ││   ███ = playing   ▢▢▢ = queued (blinks)
 │2│   │███│   │   │   │   │   │  ││   filled = has clip   empty = no clip
 │3│███│   │   │   │   │   │   │  ││   row colour = instrument lane
 │4│   │   │███│   │   │   │   │  ││
 │5│   │   │   │   │   │   │   │  ││
 │6│   │   │   │   │   │   │   │  ││
 │7│   │   │   │   │   │   │   │  ││
 │8│   │   │   │   │   │   │   │  ││
 │ └───┴───┴───┴───┴───┴───┴───┴──┘│
 └─────────────────────────────────┘
```

- **Click a cell** → fire that clip in that lane (queued per QNT). Click the
  playing cell again → stop the lane (queued).
- Cell states: **empty**, **has-clip**, **queued** (blinking ring),
  **playing** (solid). Colours are per-lane so you can read instruments at a
  glance.
- **▶ / ■** start/stop TIMELORDE (hidden when externally clocked).
- **STEP / OCT / QNT** params inline.
- **[grid ◇]** opens the monome connect flow (WebSerial).

### 4b. Clip edit view (Deluge note editor)

Drill into a single clip → a piano-roll where **X = step, Y = pitch** (rows
follow the clip's scale, root at the bottom):

```
 ┌─────────────────────────────────┐
 │ ‹ back   lane2 · slot1   ▶ ■    │   ← which clip; back to Session
 │ scale: minor   root C3   len 16 │
 │ B ·│·│·│·│·│·│·│·│·│·│·│·│·│·│·│·│
 │ A █│·│·│·│·│·│·│·│·│·│·│·│·│·│·│·│   █ = note (drag right = longer)
 │ G ·│·│·│█│·│·│·│·│·│·│·│·│·│·│·│·│   playhead column highlights live
 │ F ·│·│·│·│·│·│█│·│·│·│·│·│·│·│·│·│
 │ E ·│·│·│·│·│·│·│·│·│·│█│·│·│·│·│·│
 │ D ·│·│·│·│·│·│·│·│·│·│·│·│·│·│·│·│
 │ C █│·│·│·│·│·│·│·│█│·│·│·│·│·│·│·│   (root row)
 │   1 2 3 4 5 6 7 8 9 …            │
 └─────────────────────────────────┘
```

- **Click a cell** → toggle a note (placed at medium velocity). **Drag
  horizontally** → set its length.
- **Click the note again** → cycle velocity low → med → high (cell brightness
  shows the tier; same gesture on the grid).
- Scale / root / length are editable here; changing scale re-labels the rows.

---

## 5. The GRID UI (monome 128 = 16×8)

The grid mirrors the card, hands-only. 8 rows = 8 instrument lanes. The 16
columns split into a **clip matrix** (left 8) and a **control strip** (right 8).

### 5a. Session mode (default)

```
        ◀──────── clip slots 1–8 ────────▶   ◀──── control strip ────▶
       c0  c1  c2  c3  c4  c5  c6  c7      c8  c9  c10 c11 c12 c13 c14 c15
 r0 →  ▢   ▢   ·   ·   ·   ·   ·   ·       S   ·   ·   ·   ·   ·   ·   ⏹    lane1
 r1 →  ·   ▢   ·   ·   ·   ·   ·   ·       S   ·   ·   ·   ·   ·   ·   ⏹    lane2
 r2 →  ▢   ·   ·   ·   ·   ·   ·   ·       S   ·   ·   ·   ·   ·   ·   ⏹    lane3
 r3 →  ·   ·   ▢   ·   ·   ·   ·   ·       S   ·   ·   ·   ·   ·   ·   ⏹    lane4
 r4 →  ·   ·   ·   ·   ·   ·   ·   ·       S   ·   ·   ·   ·   ·   ·   ⏹    lane5
 r5 →  ·   ·   ·   ·   ·   ·   ·   ·       S   ·   ·   ·   ·   ·   ·   ⏹    lane6
 r6 →  ·   ·   ·   ·   ·   ·   ·   ·       S   ·   ·   ·   ·   ·   ·   ⏹    lane7
 r7 →  ·   ·   ·   ·   ·   ·   ·   ·       S   ·   ·   ·   ·   ·   ·   ⏹    lane8
        clip matrix (8×8)                  │   │                       │
                                  scene-launch col              per-lane stop
```

- **Press a clip pad** (c0–c7) → fire that clip in that lane (varibright:
  dim = has-clip, mid-blink = queued, bright = playing).
- **Scene-launch column** (one pad per lane region, or a dedicated column) →
  fire a whole **column/scene** across all lanes at once.
- **Per-lane STOP** (right edge) → stop that lane.
- Transport (global start/stop) + EDIT live in the remaining control pads.

> On a 64 (8×8) grid there's no room for a control strip, so the whole 8×8 is the
> clip matrix and control falls back to the card / a held function pad.

### 5b. Clip edit mode (hands-only compose)

Enter a clip's editor from the grid (gesture is an open question — see below),
and the **whole 16×8 grid becomes the Deluge note editor** for that clip:
columns = 16 steps (scroll for longer clips), rows = 8 pitches in-key (scroll
octaves). Press to toggle, hold-and-drag for length. Exit returns to Session.

---

## 6. Why not just clone Kria?

Kria is a *step sequencer* (per-track parameter pages — TRIG / NOTE / OCTAVE /
…), not a clip launcher. The owner wants the **Ableton clip** mental model
(arm/fire/scene, alternative takes per instrument). So we build this, and ship a
**separate faithful `kria`** module in parallel for people who want the real
thing. Kria's grid-navigation grammar (hold-page, quantized cueing) is the prior
art we borrow for our hands-only clip-edit nav.

---

## 7. UI decisions — DECIDED (owner, 2026-06-15)

1. **Card: open a clip for editing** → **double-click the cell.** Single-click
   fires/launches; double-click drills into the note editor. No extra button.
2. **Grid: enter clip-edit hands-only** → **hold the EDIT pad + tap a clip.** The
   whole 16×8 becomes that clip's note grid; tap EDIT again to return. (Kria-style
   hold-to-page grammar.)
3. **Grid right-half (control strip)** → **scene-launch + per-lane STOP +
   transport + EDIT.** `c8` scene-launch column (fire a whole column/scene across
   all lanes), `c15` per-lane STOP, EDIT + global ▶ ■ on the remaining pads.
4. **Velocity in the note editor** → **second-press cycles low → med → high**
   (three grid-LED brightness tiers; identical gesture on card + grid). First
   press places the note at med.

(All four resolved; everything in this doc is now built or in active build.)

---

## 8. Status / build order

1. ✅ Data model (`clip-types.ts`) — 8 lanes, per-lane playing/queued, note model.
2. ✅ Factory (`clipplayer.ts`) — TIMELORDE lock, 24 outs, per-lane scheduling.
3. ⏳ Card (`ClipplayerCard.svelte`) — Session + Edit views (this doc's §4).
4. ⏳ Grid binding (`grid-clip-*.ts`) — per-lane Session + edit mode (§5).
5. ⏳ Tests — pure (clip-types) · per-port · VRT · real-source-chain e2e
   (TIMELORDE→clipplayer→audible RMS per lane).
```
