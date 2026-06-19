# Plan C — role split (Unit 1 = persistent matrix, Unit 2 = context surface)

**Philosophy:** **Unit 1 is ALWAYS the clip matrix — it never changes mode.** Unit 2
is a **context surface** that morphs between four roles — **EDIT / MIXER / SONG /
FX** — picked by its own top row. This solves the one pain Plans A and B share and
that Ableton Push famously has: *when you edit, you can't see your clips.* Here you
can launch, stop, and re-scene on Unit 1 while you edit notes, ride faders, or
arrange a song on Unit 2. The clip you're editing pulses turquoise on Unit 1 so you
never lose your place; tap a different clip on Unit 1 to retarget Unit 2.

> **Diagrams:** `plan-C-session-mixer.svg` (Unit 1 matrix + Unit 2 in MIXER role) ·
> `plan-C-editor.svg` (Unit 1 still live + Unit 2 in EDIT role). Legend:
> `legend-colors.svg`.

---

## Assumed device + layout (lead)

- **Device:** 2× **Launchpad Mini MK3** (ID 1 = matrix, ID 2 = context surface),
  Programmer mode, Web MIDI + SysEx. Pad note `r*10+c`; top row CC 91–98; right col
  CC 89…19; RGB via LED SysEx; pulse/flash on ch 2/3. The MIXER role also uses the
  Launchpad's native **DAW-fader layout** (SysEx `…01 …`) for true vertical level
  faders — a capability the monome simply doesn't have.
- **Two units:** distinct device IDs → two ports; Unit 1's binding is fixed to the
  matrix, Unit 2's binding switches LED frame + key handler by current role.

**If you actually meant…**
- **Launchpad X:** drop-in; pressure-sensitive pads make the MIXER faders feel
  analog and let EDIT capture real velocity. No layout change.
- **Launchkey Mini MK3:** **ideal for Plan C** — the keyboard + 8 encoders ARE the
  context surface (EDIT = play notes on keys, encoders = step velocity/length;
  MIXER = 8 encoders to 8 lane levels; SONG = encoders scrub). Pair a **Launchpad
  (matrix)** with a **Launchkey (context)** and Plan C is its best self.
- **Launch Control XL:** **also ideal** — it's a purpose-built MIXER/macro surface.
  Pair **1 Launchpad (matrix) + 1 Launch Control XL**. The XL can't do the EDIT
  *grid* (no pads), so note editing falls back to the app card or a held Launchpad
  mode; MIXER/SONG/FX roles are excellent. This pairing is *the* reason Plan C
  exists for the "Launch Control" reading of the owner's hardware name.

---

## Unit 1 — the clip matrix (fixed, never modal)

Exactly today's SESSION model, in colour, and **it stays put no matter what Unit 2
is doing:**

- rows = lanes 1–8, cols = slots 1–8; tap = launch/stop via `queued[]`.
- top row = SCENE LAUNCH (amber); right col = per-lane STOP; top-right = STOP-ALL.
- state colours per legend; **the clip open in Unit 2's editor pulses turquoise with
  a bright ring** (diagram: lane 2 slot 3). Tapping a clip on Unit 1 while EDIT is
  the active role **retargets** the editor to that clip — so "edit the next idea" is
  one tap, and you never leave the launch grid.

Because Unit 1 never changes, the launch surface is **always live** — the headline
win.

---

## Unit 2 — the context surface (4 roles)

**Top row = role selector** (always present on Unit 2): FX · MIXER · EDIT · SONG,
plus global **▶ / ● / ALIGN / TAP** on the right of the top row. Active role lit; the
8×8 below re-skins per role.

### Role: MIXER (`plan-C-session-mixer.svg`)

- **8 columns = 8 lanes; each column is a vertical LEVEL fader** (Launchpad
  DAW-fader layout — bottom-up brightness = level; tap a pad to set the level there).
  This is a real fader bank the monome can't render. Maps to per-lane clip `gain`.
- A **MUTE row** (top grid row) toggles lane mute (yellow = audible); a **SOLO** row
  can share via a hold. Optionally swap columns to **pan / send** with a role
  sub-toggle.

### Role: EDIT (`plan-C-editor.svg`)

- **Note grid lives here while Unit 1 stays the matrix.** Top row = role select +
  **FOLLOW** + page-nav (◀PG/PG▶, active when FOLLOW is frozen) + COPY/PASTE. Rows
  0–6 = pitch × step (in-key); bottom row = function strip: **VEL** (hold-cycle or,
  better, a brief ladder pop-up), **SCALE**, **OCT±**, **ROW±**, **DOUBLE** (dup +
  ×2 length, cap 128), **LEN** (opens the 2-row LENGTH-EDIT: end-BLOCK ×16 + end-STEP
  1..16, non-destructive). A clip spans up to **8 blocks of 16 steps = 128**;
  **FOLLOW** auto-scrolls the shown block with the playhead, or freeze it (flashing)
  and page with ◀PG/PG▶.
- Note colour = velocity (RGB ramp); held spans = bars; playhead = amber column
  (shown only on the playing block).
- COPY / PASTE work as the shipped **held modifiers** (hold + tap a clip on Unit 1,
  which doubles as retargeting); PASTE-REV mirrors held-note spans.
- Because Unit 1 is still alive, you can **launch the clip you're editing** (or any
  other) without leaving EDIT — instant audition.

### Role: SONG (arranger)

- The 8×8 becomes the **arrangement block timeline** (`clip-arrange.ts`
  `arrangeBlocks`): rows = lanes, columns = beat windows; each block tinted by its
  clip. ● record-arms; ▶ plays the arrangement; tap a block to move/swap/delete
  (the existing `moveBlock`/`setBlockSlot`/`deleteBlock` ops). `clipMode` toggles
  session↔arrangement.

### Role: FX (macros)

- The 8×8 becomes a **macro / scene-morph surface** — global filter sweep, stutter,
  reverse-all, a "performance FX" page. Open-ended; this is where the surface earns
  its keep for live sets and where future modulation targets land.

---

## Feature reach (coverage table)

| Feature | Plan C location |
|---|---|
| Launch / stop / scene / stop-all | **Unit 1 (always)** |
| Per-lane level / mute / solo | Unit 2 → MIXER role |
| Note add / tie / velocity / scale / octave / row | Unit 2 → EDIT role |
| FOLLOW (auto-scroll) / freeze + page nav / ≤128 steps (16-step blocks) | Unit 2 → EDIT top-row FOLLOW + ◀PG/PG▶ |
| DOUBLE (dup + ×2 length, cap 128) | Unit 2 → EDIT DOUBLE pad |
| Clip length (end-block + end-step) / polymeter | Unit 2 → EDIT LEN → 2-row LENGTH-EDIT |
| Copy / paste / **paste-reverse** (held + tap) | Unit 2 → EDIT COPY/PASTE/REV-CLIP held modifiers (+ retarget by tapping Unit 1) |
| Launch-NOW / quantize | top-row QNT/NOW modifier (`queuedImmediate`) + a quantize sub-row |
| Transport / transport-start re-align (all clips → step 1) | Unit 2 top row ▶ / ALIGN (auto on ▶ start) |
| Song record / arrange edit | Unit 2 → SONG role (block timeline) |
| Performance FX / morph | Unit 2 → FX role |
| **Edit while clips stay launchable** | **inherent — Unit 1 never goes modal** |

---

## UX wins vs. the monome grid (and vs. Plans A/B)

- **The launch grid is never lost.** This is the defining win — over the monome
  (which is one surface, fully modal in edit) AND over Plans A/B (which take a unit
  over to edit). Audition any clip mid-edit, re-scene mid-mix.
- **A real mixer with vertical faders** (native DAW-fader layout) — impossible on
  the monome, and a clearer mixer than Plan B's mute/solo columns.
- **Retarget-by-tap editing** — tap a clip on the live matrix to edit it; the
  workflow stays anchored on Unit 1.
- **Roles scale the surface** to song-arrange and performance-FX without cramming —
  the most future-proof of the three.
- **Best fit for mixed hardware** (Launchpad + Launchkey, or Launchpad + Launch
  Control XL) — the context surface naturally absorbs a keyboard/encoder/fader unit.

## Cons

- **Most code:** a role state-machine on Unit 2 (4 LED frames + 4 key handlers), the
  Launchpad DAW-fader integration for MIXER, and the SONG block-timeline surface
  (the arranger UI doesn't exist on the grid yet). Largest first slice of the three.
- **Two-unit dependency:** Plan C is least useful with a single Launchpad (you'd be
  back to modal). It's explicitly a two-surface design.
- **Discoverability:** four roles need clear labelling (text-scroll the role name on
  switch; colour-code the selector) so users know which role they're in.

## Verdict — **the best end-state**, and the natural choice if the second unit is a
Launchkey or Launch Control XL. Heaviest to build from scratch. Recommended path:
ship **Plan B** first, then **adopt Plan C's "Unit 1 stays the matrix" rule** and
grow Unit 2's roles incrementally (MIXER → EDIT-non-modal → SONG → FX).
