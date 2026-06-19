# Launchpad Mk3 support for the clip launcher — design proposal

**Status:** design + docs only (no source changes). For owner review + push-back.
**Date:** 2026-06-19. **Branch:** `docs/launchpad-mk3-proposal` (off `origin/main`).
**Supersedes** the Plan-A/B/C exploration as the *chosen direction*: this proposal
adopts **Plan B** (matrix + command deck) and re-grounds the whole thing on (a) the
**8×8 reality** of a Launchpad, (b) the **shipped #827** clip launcher, (c) the
**two-Launchpad split**, and (d) the **dir-button + SHIFT** navigation model the
owner asked for. Plans A/B/C remain in this folder as the alternatives + history;
where this proposal contradicts them it wins.

> **Hardware in hand:** 2× **Novation Launchpad Mk3** (the owner's words). The two
> shipping Mk3 8×8 grid units are the **Launchpad Mini Mk3** and **Launchpad X**.
> Everything below is written for **either** — they share the *exact* programmer-mode
> note/CC layout and LED SysEx; the only difference is the X's pads are
> velocity+pressure sensitive (a bonus for note entry, never required). If the units
> are actually **Launchpad Pro Mk3** the device byte + a couple of CCs differ (it has
> extra rows) — that is the one open hardware question (see §10).

---

## 0. Executive summary

- **Rename:** the hardware-CONTROL layer becomes per-controller. The **clip ENGINE
  stays one shared module** (`clipplayer`, label `clip player`). We rename the
  **monome binding** `lib/grid/grid-clip-binding*` → **`monome-control`** and split
  out a controller-agnostic core both bindings share. We do **NOT** rename the
  `clipplayer` module type (that would churn saves, the registry, every test +
  doc). See §3 for the precise surface.
- **Two new control surfaces:** `launchpad-control-left` + `launchpad-control-right`,
  each an 8×8 Launchpad in **programmer mode** over **Web MIDI (SysEx)**. Together
  they reconstruct the monome 128's 16×8 surface: **L = the clip matrix (Plan B Unit
  L), R = the command/editor deck (Plan B Unit R)**. They write the SAME synced
  `node.data` fields the card + monome write, so multiplayer + the engine are
  unchanged. See §4–§6.
- **8×8 editing with dir-nav + SHIFT:** the editor shows **8 steps × 8 pitches** at a
  time. The Launchpad's dedicated **▲▼◀▶** top buttons scroll the note window **one
  row/col per press**; **holding SHIFT** (the top-row **Session/▣ button**, CC 95)
  makes ▲▼◀▶ jump **a full screen (8) at a time**. SHIFT is global (also page-jumps
  the session matrix scenes / clip pages). See §7.
- **LED colour language:** full RGB via the programmer-mode lighting SysEx — every
  clip state gets its own hue + animation (the monome could only do brightness). See
  §8 + `legend-colors.svg` (reused) + the new `launchpad-*.svg` mockups.

The OPEN QUESTIONS the owner must decide are collected in **§10** — read those first
if you're short on time; they gate the build.

---

## 1. Current state — exact ground truth (file:line)

Everything below was read from `origin/main` on 2026-06-19.

### 1.1 The clip ENGINE (shared, stays one module)

- **`packages/web/src/lib/audio/modules/clipplayer.ts`** — the module def + factory.
  - `type: 'clipplayer'`, `label: 'clip player'`, `domain: 'audio'`,
    `palette: { top: 'Audio modules', sub: 'sequencers' }`, `size: '3u'`, `hp: 2`
    (`clipplayer.ts:48-58`).
  - Inputs: `stop_all` (gate) (`:71`). Outputs: `pitch1..8` (polyPitchGate) / `gate1..8`
    (gate) / `vel1..8` (cv) — **24 outs**, one trio per lane (`:72-76`).
  - Params: `stepDiv` / `octave` / `gateLength` / `quantize` (`:77-84`).
  - **Clock LOCKED to TIMELORDE** (no BPM, no clock cable) (`:9-12`).
- **`packages/web/src/lib/audio/modules/clip-types.ts`** — the data model + ALL pure
  helpers (the controller-agnostic brains).
  - `CLIP_LANES = 8`, `CLIP_SLOTS = 8`, `CLIP_COUNT = 64` (`clip-types.ts:33-35`).
  - `MAX_CLIP_STEPS = 128`, `STEPS_PER_PAGE = 16`, `MAX_EDIT_PAGES = 8`
    (`:40-43`) — **this is the shipped #827 length model.**
  - `VEL_LEVELS = [0,25,51,76,102,127]` (6 levels), `VEL_DEFAULT = 76`,
    `VEL_BUCKET_COUNT = 3` (`:426-436`).
  - Synced launch state on `node.data`: `playing[lane]`, `queued[lane]`
    (slot|`'stop'`|null), `queuedImmediate[lane]`, `mono[lane]`, plus arranger
    `arrangement`/`clipMode`/`recording` (`:114-144`).
  - Pure transforms the deck reuses verbatim: `toggleNoteAt`, `setNoteSpan`,
    `cycleVelocity`, `doubleNoteClip`, `reverseClipSteps`, `copyClip`,
    `lengthFromBlockTap`, `lengthFromStepTap`, `lengthEndBlock`, `lengthEndStep`
    (`:385-633`).
- **`packages/web/src/lib/audio/modules/clip-playhead.ts`** — non-synced per-lane
  playhead registry (`getLanePlayhead` / `setLanePlayhead`). LED playheads read it;
  it is **never** a Y.Doc write (the CV-modulation-live-store-write lesson).
- **`packages/web/src/lib/audio/modules/clip-arrange.ts`** — the SONG-mode arranger
  (event log of launches, `clipMode: 'session' | 'arrangement'`, `recording`).
- **`packages/web/src/lib/ui/modules/ClipplayerCard.svelte`** — the always-available
  card (Session + Edit + Song views) AND the **GRID connect button** that binds the
  monome to *this* node: `bindGridToClip(id)` (`ClipplayerCard.svelte:60-85`). This
  is the seam the Launchpad connect re-uses.

### 1.2 The monome CONTROL layer (this is what gets renamed)

- **`packages/web/src/lib/grid/mext.ts`** — the monome serial CODEC. PURE byte layer:
  `encodeLedSet 0x18` (0-15 varibright), `encodeLedAll 0x19`, key RX `0x21/0x20`,
  handshake. `GRID_WIDTH = 16`, `GRID_HEIGHT = 8`, `LED_LEVEL_MAX = 15`
  (`mext.ts:51-56`). **monome-specific.** No RGB.
- **`packages/web/src/lib/grid/grid-device.svelte.ts`** — the **WebSerial singleton**:
  one `navigator.serial` connection per page, `onKey()` subscription, `setFrame()`
  diffed LED writes, an `installSimulatedGrid()` test hook (`grid-device.svelte.ts`).
  **monome/WebSerial-specific.**
- **`packages/web/src/lib/grid/grid-clip-map.ts`** — the **16×8 ↔ clip-launcher PURE
  mapping** (session/edit/length classifiers + LED-frame builders). This is the file
  whose layout the Launchpad must reconstruct on 8×8. Exact shipped coords:
  - SESSION: left 8×8 = clip matrix (`padToClipIndex` = `y*8+x`,
    `grid-clip-map.ts:125-128`); `col 8` = per-lane STOP (`CTRL_STOP_COL`, `:105`);
    `col 9` = SCENE LAUNCH (`CTRL_SCENE_COL`, `:106`); right column `col 15`:
    **EDIT (15,0) · COPY (15,2) · COPY-IND (15,3) · PASTE (15,4) · PASTE-REV (15,5)
    · STOP-ALL (15,6) · TRANSPORT (15,7)** (`:107-113`).
  - EDIT: **7 note rows (0..6) + a FUNCTION ROW (row 7)** (`NOTE_ROWS = 7`,
    `FUNC_ROW = 7`, `:81-83`); the function row is
    `EDIT · VEL · _ · ROW− · OCT− · _ · ROW+ · OCT+ · _ · SCALE · _ · FOLLOW · LEFT ·
    RIGHT · DOUBLE · LEN` across the 16 columns (`:84-100`). Note window = `page*16 +
    x` over the 16 columns (`editPadToNote`, `:177-188`).
  - LENGTH-EDIT: a 2-row page — row 0 = end-BLOCK ruler (1..8 ×16) + pad 15 EXIT;
    row 1 = end-STEP ruler (1..16) (`lengthEditPad`, `:255-260`;
    `computeLengthEditLeds`, `:431-450`).
- **`packages/web/src/lib/grid/grid-clip-binding.svelte.ts`** — the **stateful binding
  / mode machine** (`session` | `edit` | `lengthEdit`), the held-modifier flow, the
  LED render loop on the scheduler tick (`grid-clip-binding.svelte.ts`). Per-machine
  bound (localStorage `pt.grid.boundClipNode`, `:84`). **This is the file the
  Launchpad bindings parallel.**
- **`packages/web/src/lib/grid/kria-grid*`** — a SEPARATE Kria step-sequencer binding.
  Untouched by this work.
- **`packages/web/src/lib/audio/grid-nav.ts`**, **`packages/web/src/lib/docs/clip-grid-spec.ts`** —
  grid-nav helpers + the docs `GridDiagram` data (pure function of the real layout
  constants, so it never drifts).

### 1.3 The registration / list-file surface (for the change-list)

- `packages/web/src/lib/ui/rack-sizes.ts:42` — `clipplayer: { size: '3u', hp: 2 }`.
- `packages/web/src/lib/docs/module-manifest.ts:187` — `clipplayer:` DESCRIPTIONS
  entry (the unit-gate requires one per module). Also the computed-outputs special
  case at `:1309-1311`.
- `packages/web/src/lib/ui/modules-card-map.test.ts:35` — `clipplayer` in
  `EXPECTED_NODE_TYPES`.
- `e2e/vrt/vrt-exemptions.ts:711` — `'linux/clipplayer'` exempt.
- `packages/web/src/lib/docs/module-guides.ts:22` — `clipplayer → /docs/modules/
  grid-clip-launcher`; docs route at `packages/web/src/routes/docs/modules/
  grid-clip-launcher/`.
- Module registration itself is **glob+palette-driven** (PR #551): any new
  `*Def`-exporting file under `lib/audio/modules` (or `lib/meta/modules` etc.) is
  auto-registered — **so the two new surfaces don't touch `modules/index.ts` or
  `Canvas.svelte`.**

### 1.4 The MIDI plumbing we'll reuse (not the serial path)

- **`packages/web/src/lib/midi/midi-learn.svelte.ts`** — the shared
  `navigator.requestMIDIAccess()` singleton + the per-machine **localStorage** binding
  discipline (`midi-learn.svelte.ts:1-10`, `STORAGE_KEY` `:41`). The Launchpad device
  layer copies this access pattern (one MIDI access, SysEx enabled, ports bound by
  name + persisted per-machine) — NOT the WebSerial path.
- `MidiAccessLike` / `MidiInputLike` / `MidiEventLike` + `webMidiAvailable` live in
  `packages/web/src/lib/audio/modules/midi-cv-buddy.ts` and are the inject-a-fake-access
  test seam we reuse.

### 1.5 The critical architecture fact (informs the whole rename + module design)

**The monome grid is NOT a module — it is a page-level singleton bound to a
`clipplayer` node from the card's GRID-connect button.** `grid-device.svelte.ts` is
one connection for the whole page; `bindGridToClip(nodeId)` (called from
`ClipplayerCard.svelte`) points that one grid at one clip-player. The closest
"controller as a node" precedent is **`packages/web/src/lib/meta/modules/control-surface.ts`**
+ `ControlSurfaceCard.svelte` (an abstract surface node holding pointers to other
modules' controls) and the **`ElectraConnectButton`** (a global connect button, not a
node). This is why the owner's "add two launchpad **modules**" needs an explicit
architecture decision — see §4.0 + OPEN QUESTION Q1.

---

## 2. What the prior plans got WRONG vs shipped #827 (already corrected)

The Plan-A/B/C docs were drafted alongside the in-flight clip launcher and were
partially re-grounded already; this proposal completes the reconciliation. The
substantive corrections (now reflected everywhere here, and re-checked against the
actual source on 2026-06-19):

1. **FOLLOW, not "HOLD".** The editor page-freeze is the **FOLLOW** pad: lit =
   auto-scroll with the playhead; **flashing = frozen**; LEFT/RIGHT page while frozen
   (no-op while following / at the ends). `isFollowPad`/`FOLLOW_PAD` at
   `grid-clip-map.ts:96,212`; freeze logic `grid-clip-binding.svelte.ts:332-345`.
   This is *separate* from the session immediate-launch override, which is
   `queuedImmediate[]` on `node.data` (`clip-types.ts:123-126`).
2. **128 steps in 16-step BLOCKS (8 blocks).** `MAX_CLIP_STEPS=128`,
   `STEPS_PER_PAGE=16`, `MAX_EDIT_PAGES=8` (`clip-types.ts:40-43`). The original
   "8-step pages → ≤64, ≤128 with DOUBLE" framing was the 8-wide-Launchpad pad count
   leaking into the model. **The model's page/block is 16 steps; a Launchpad's 8
   columns show HALF a block** — this is the single biggest 8×8-reality correction
   and §7 spells out the half-block↔column mapping explicitly.
3. **LENGTH-EDIT = a dedicated 2-row page**, not a length cycle: row 0 = end-BLOCK
   (×16) + EXIT, row 1 = end-STEP (1..16); non-destructive
   (`lengthEditPad`/`computeLengthEditLeds`, `grid-clip-map.ts:255-260,431-450`;
   binding `grid-clip-binding.svelte.ts:280-299`).
4. **DOUBLE is its own gesture** = `doubleNoteClip` (dup first half + double length,
   cap 128, no-op at 128) (`clip-types.ts:537-551`; binding `:358-362`). Not the
   length editor.
5. **COPY / PASTE / PASTE-REVERSE are press-and-HOLD modifiers** (hold + tap a clip),
   with a pulsing **COPY-INDICATOR** while the per-machine buffer is loaded
   (`grid-clip-binding.svelte.ts:398-450`; `LED_COPY_IND_PULSE` `grid-clip-map.ts:59`).
   The buffer **survives a re-bind** (it's the machine's clipboard, `:138`).
6. **Per-clip independent length → POLYMETER, re-aligned on transport START.** Each
   clip free-runs at its own length; transport start snaps every playing clip to
   step 1. (The docs now say "polymeter", not "polyrhythm".)
7. **VEL is 6 levels shown as 3 colour buckets** (`VEL_LEVELS`/`velBucket`,
   `clip-types.ts:426-441`). On the monome the editor collapses to 3 brightnesses;
   on the Launchpad RGB we can show all 6 as a smooth ramp (a genuine win, §8).

Two prior-plan claims this proposal **changes outright** (beyond reconciliation):

- **"row*10+col addressing 11..88" / right-column CCs** in the README were stated as
  fact; they are the well-documented MK3-family convention and are correct for Mini
  Mk3 / X, but the prior docs didn't flag the **Pro Mk3** divergence (extra rows,
  different device byte). Flagged here as OPEN QUESTION Q-HW.
- The prior plans framed the editor as **7 note rows + a function row** (monome
  reality). On the **two-Launchpad** split the function row MOVES TO UNIT R, so the
  editor on Unit L is **8 full pitch rows** (a real gain, §6). The single-unit
  fallback keeps 7+1.

---

## 3. The RENAME — precise surface + change-list

**Decision (owner-locked):** keep the clip launcher; rename it to `monome-control`.
**Interpretation (recommended):** the thing that is monome-specific is the **binding +
the serial codec + the 16×8 map**, not the clip engine. So:

### 3.1 What does NOT change (the shared engine)
- The **module type stays `clipplayer`**, label stays `clip player`. Renaming the
  module type churns every save (`schemaVersion`/migrate), the registry glob, the
  rack-size key, the DESCRIPTIONS key, `EXPECTED_NODE_TYPES`, the VRT exemption, the
  docs route, and ~6 e2e specs — for zero user benefit (the engine isn't
  monome-specific). **Recommend: do not rename the module.** (OPEN QUESTION Q1 if the
  owner actually wants the *node* called "monome control".)
- `clip-types.ts`, `clip-playhead.ts`, `clip-arrange.ts` — the shared model + pure
  helpers. Untouched.

### 3.2 What gets renamed (the monome control layer)
| Today | Renamed to | Why |
|---|---|---|
| `lib/grid/grid-clip-binding.svelte.ts` | `lib/control/monome/monome-control.svelte.ts` | the monome binding = "monome control" |
| `lib/grid/grid-clip-map.ts` | **split** → `lib/control/clip-surface-map.ts` (controller-agnostic logic) + `lib/control/monome/monome-map.ts` (16×8 placement) | the PURE map is shared; only the 16×8 placement is monome-specific |
| `lib/grid/grid-device.svelte.ts` | `lib/control/monome/monome-device.svelte.ts` | the WebSerial singleton is monome-specific |
| `lib/grid/mext.ts` | `lib/control/monome/mext.ts` | the serial codec is monome-specific |
| `lib/grid/grid-clip-binding.test.ts`, `grid-clip-map.test.ts`, `grid-device.test.ts`, `mext.test.ts` | move alongside | tests follow their files |
| `lib/grid/kria-grid*` | `lib/control/monome/kria-*` | Kria is also a monome binding (or leave in `lib/grid` if scope-creep is a concern) |

> **Why a `lib/control/` home + a controller-agnostic core?** The Launchpad bindings
> must reuse the session/edit/length **logic** (which clip a pad fires, what a note
> toggle does) while supplying their **own placement** (where each function lands on
> 8×8 across two units). Splitting `grid-clip-map.ts` into a *placement-free* core
> (`clip-surface-map.ts` — the classifiers parameterised on a placement table + the
> pure transforms) and a *monome placement* (`monome-map.ts` — the 16×8 coords) is
> the single change that makes BOTH the monome and the two Launchpads thin adapters
> over one brain. **This is the heart of the rename and the prerequisite for §4–§6.**

### 3.3 List-file change-list for the rename (no behavior change)
- **localStorage key:** `pt.grid.boundClipNode` → keep as-is (rename-only churn would
  un-bind every existing user's grid). Add a new key per controller (§4.4).
- **Imports:** every `$lib/grid/*` import updates to `$lib/control/*`. Grep targets:
  `ClipplayerCard.svelte` (the connect button), `clip-grid-spec.ts`, the four test
  files, `grid-nav.ts`.
- **Docs:** `module-guides.ts` href + the `/docs/modules/grid-clip-launcher` route
  copy mention "monome control" as ONE of the controllers (not THE controller).
- **No change** to: rack-sizes, DESCRIPTIONS (engine unchanged), `EXPECTED_NODE_TYPES`
  (no new module *type* from the rename), vrt-exemptions (engine unchanged).
- This rename is a **pure refactor PR** that should land BEFORE the Launchpad PR so
  the Launchpad work builds on the shared core (see §9 phasing).

---

## 4. The two Launchpad surfaces

### 4.0 Architecture: are they "modules"? (recommendation)

Three ways to model "two launchpad modules", in increasing alignment with the
existing architecture:

- **(a) True audio/meta module nodes** (one node per unit on the canvas). Matches the
  literal "module" ask + the glob registry, gets a card, a rack slot, a DESCRIPTIONS
  entry, VRT. **Cost:** they have no audio I/O (they're controllers), so they'd be
  zero-port nodes — which fights the rack/cable mental model, and you'd have TWO nodes
  to place for one physical pair.
- **(b) A single `launchpad-control` node with an L/R role param** (one node, drives
  both units). Cleaner canvas; one card; the card's connect flow pairs both units.
- **(c) A global connect button (like the grid / Electra), no node at all** — the
  Launchpad is "your hardware", bound to a `clipplayer` node from that node's card,
  exactly like the monome today.

**Recommendation: (c) for the binding + a thin (a)/(b) presence ONLY if the owner
wants it on the canvas.** The grid is already modeled as (c) and it works; the
Launchpad is the same kind of thing (personal hardware bound to a clip-player). The
"two modules" naming the owner used most likely means "two device roles"
(`launchpad-control-left` / `-right`), which we honour as **two named device ROLES
inside one connect flow**, not necessarily two canvas nodes. **OPEN QUESTION Q1:**
does the owner want actual cards on the canvas, or just the connect button +
left/right device roles? The rest of this proposal works for either — the binding
logic is identical; only the "is there a card" wrapper differs.

> For the deliverable's module *names*, we use `launchpad-control-left` and
> `launchpad-control-right` as the two **device-role identifiers** (the strings the
> pairing UI + per-machine binding use), regardless of whether they also become
> canvas nodes.

### 4.1 The layout split — L = matrix, R = command deck (Plan B)

The monome 128 is **16×8 = a clip matrix (left 8) + a control strip (right 8)**. Two
8×8 Launchpads reconstruct that **but better**, because the second unit's 16 dedicated
buttons absorb the control strip's overloaded functions:

```
   LAUNCHPAD LEFT (CC95=SHIFT)              LAUNCHPAD RIGHT (CC95=SHIFT)
   ┌─ ▲ ◀ ▶ ▼ · · ▣ · ─┐ top CCs          ┌─ ▶ ● SONG ALIGN · · ▣ · ─┐ top CCs
   │ 8×8 CLIP MATRIX    │ scene col        │ COMMAND / EDITOR DECK    │ scene col
   │ rows=lanes 1-8     │ (right CCs)      │ COPY PASTE REV · MUTE··· │ (right CCs)
   │ cols=slots 1-8     │                  │ SOLO LEN± QNT EDIT DBL.. │
   └────────────────────┘                  └──────────────────────────┘
        = monome cols 0-7                        = monome cols 8-15
        (clip matrix)                            (control strip, de-overloaded)
```

- **Unit L = the clip matrix**, a 1:1 colour upgrade of the monome session left-8×8:
  **rows = instrument lanes 1-8, columns = clip slots 1-8**, `pad note 11..88` ↔ clip
  index `lane*8+slot`. Same `node.data.queued[]` writes → multiplayer-synced for free.
  L's **scene column** (right CCs) = SCENE LAUNCH per slot; L's **STOP** lands on the
  command deck (R) so all 8 of L's columns stay clips.
- **Unit R = the command deck**: every shipped control function gets a **dedicated,
  lit, RGB-coded button** instead of the monome's overloaded right column + function
  row. Transport / song-record / SONG / ALIGN, COPY / PASTE / PASTE-REV (+ buffer
  indicator), per-lane MUTE/SOLO, LEN±, launch QNT/NOW, EDIT, DOUBLE, scene snapshots.
  See `launchpad-right.svg` + §5.

This is **exactly Plan B**, now on real 8×8 hardware with the two-unit button budget.

### 4.2 Why not Plan A (one 16-lane wall) or pure Plan C?

- **Plan A** (L = lanes 1-8, R = lanes 9-16) needs the engine to grow to 16 lanes (or
  run two clip-players) and throws away the second unit as a control surface — copy/
  paste/length/mixer have nowhere good to live. The owner's model is **8 instruments**
  (`clip-types.ts:26-34`); Plan A fights it.
- **Plan C** (R is a 4-role context surface, matrix never disappears) is the best
  end-state but the most code (a role state-machine + DAW-fader LED layout). **We fold
  in Plan C's ONE best rule now** — "the editor does NOT take the matrix away" — by
  putting the **note grid on Unit L only while editing and keeping launch live via the
  card / a held LAUNCH-peek**, and leave full roles for v2.

### 4.3 Pairing the two units in Web MIDI (how we tell L from R)

Each Launchpad Mk3 enumerates as **two USB-MIDI port pairs**:
`LPMiniMK3 DAW In/Out` (the DAW Session surface) and **`LPMiniMK3 MIDI In/Out`** — and
**programmer mode uses the MIDI port** (confirmed: Novation user-guides, lpminimk3
docs). We bind the **MIDI** port, send the enter-programmer SysEx, then own every LED.

Telling two identical units apart:
- **Recommended:** a **one-time pairing handshake.** On connect, enumerate all
  `LPMiniMK3 MIDI` ports; for each, light a distinct colour + scroll "LEFT"/"RIGHT"
  via the text SysEx and ask the user to **press the lit pad on the unit that should
  be LEFT**. The port that answers = left; the other = right. Persist both port
  identifiers per-machine (localStorage, like the grid binding) so it's a one-time
  step. This needs no firmware fiddling and is robust to OS port re-ordering.
- **Alternative (no UI):** give the two units **distinct USB device IDs** in their
  bootloader (hold *Capture MIDI* on power-up; top pad rows pick ID 1..16). They then
  enumerate with distinguishable names/indices and we bind by name. More setup
  friction; documented as a footgun in the README.
- **Web MIDI requires SysEx access:** `navigator.requestMIDIAccess({ sysex: true })`
  — reuse the `midi-learn` access singleton (don't open a second access). Browser
  support is Chromium (matches the WebSerial gate); Safari/Firefox/CI degrade cleanly.

### 4.4 Per-machine binding (no Y.Doc)
Exactly the grid discipline: which clip-player the Launchpads drive + which port is
L/R is **per-machine local** (localStorage). New keys:
`pt.launchpad.boundClipNode`, `pt.launchpad.portLeft`, `pt.launchpad.portRight`. The
LED frames are local render state, **never synced**. The clip/launch STATE syncs via
`node.data` exactly as today.

---

## 5. Unit R — the command deck (every shipped feature = a lit button)

Laid out as functional columns so it reads at a glance (see `launchpad-right.svg`).
All writes are the SAME `node.data` mutations the card + monome already make.

### Top row (the dir-button row is REPURPOSED on R as global controls)
| Pad/CC | Function | Source write | Colour |
|---|---|---|---|
| ▶ (CC91) | transport play/stop | `timelorde.params.running` | green when running |
| ● (CC92) | song record-arm | `data.recording` | red pulse when armed |
| SONG (CC93) | session ↔ arrangement | `data.clipMode` | white, lit in arrangement |
| ALIGN (CC94) | transport-start re-align (auto on ▶) | (read-only indicator; ▶ start re-aligns) | white |
| **SHIFT (CC95 / ▣)** | **global full-screen-jump modifier (held)** | local | violet while held |
| COPY (CC96) | hold + tap a clip on L → buffer | `copyClip` → per-machine buffer | turquoise (bright held) |
| PASTE (CC97) | hold + tap a dest on L → create/overwrite | `writeClip(copyClip(buffer))` | violet (bright held) |
| PASTE-REV (CC98) | hold + tap → reversed paste | `reverseClipSteps(copyClip(buffer))` | magenta (bright held) |

### 8×8 grid (R), by column family
- **MUTE column** (col 1) — per-lane mute; yellow = audible, dim = muted.
- **SOLO column** (col 2) — per-lane solo; blue when solo'd.
- **LEN− / LEN+ columns** (cols 3-4, per lane) — coarse block-stepped shorten/lengthen
  of each clip's length (the polymeter knobs); exact end-block/end-step is the editor's
  LENGTH-EDIT page.
- **QUANTIZE ladder** (col 5) — global launch quantize: 1 bar / 1/2 / 1/4 / 1/8 /
  1/16 / NOW; current setting lit. (QNT/NOW momentary = `queuedImmediate`.)
- **EDIT / DOUBLE / SCENE-SNAPSHOTS / REC** (right cols + right CC column) — EDIT
  (hold + tap a clip on L → editor); DOUBLE (`doubleNoteClip`); SCENE 1-4 named
  snapshots; REC (record-arm the focused lane).
- **COPY-INDICATOR** pad — pulses turquoise while the per-machine buffer holds a clip
  (the RGB analogue of `LED_COPY_IND_PULSE`).

Coverage: every row in Plan B's coverage table maps to a dedicated R pad. The bar
("at least as capable as the shipped grid spec") is cleared with room to spare.

---

## 6. The editor on 8×8 — Unit L = note grid, Unit R = editor deck

When **EDIT** (R) is held + a clip is tapped on L, **Unit L flips to an 8×8 note
grid** and **Unit R flips to the editor deck**:

- **Unit L = 8 pitch rows × 8 step columns** (a real gain over the monome's 7+func:
  the function row lives on R, so all 8 of L's rows are pitch). X = step within the
  shown **8-step window**, Y = pitch in-key (root-guide faint). Note colour = velocity
  (RGB ramp, all 6 `VEL_LEVELS`); held spans render as bars; the playhead column
  washes amber + boosts the note it crosses (drawn only when the playing window is
  shown).
- **The 8-step window is HALF a 16-step block.** The clip's model is still 16-step
  blocks up to 128 (`STEPS_PER_PAGE=16`). On 8 columns we show **block N, half H**
  (H ∈ {left 0-7, right 8-15}). The window scrolls by the dir buttons (§7).
- **Unit R editor deck:** VELOCITY ladder (6-step direct pick — far better than the
  monome hold-cycle), SCALE column (MAJ/MIN/PENT/CHROM + ROOT± + MONO), the 2-row
  LENGTH-EDIT (end-BLOCK ruler ×16 + end-STEP ruler 1..16, non-destructive), DOUBLE,
  FOLLOW, PROB ladder, EXIT, and the COPY/PASTE held modifiers (which can copy a
  step-RANGE inside the editor, not just whole clips).

> **Plan C rule folded in:** while editing, the launch matrix is on L (taken over by
> the note grid), but **launch stays reachable** — hold the top-row **LAUNCH-peek**
> (a held modifier on R) to momentarily re-show L's matrix and fire/stop a clip, then
> release back to the note grid. Full non-modal (matrix always live on its own unit)
> is the v2 Plan-C end-state. **OPEN QUESTION Q2:** is held-LAUNCH-peek enough for v1,
> or does the owner want the matrix permanently on one unit from day one?

---

## 7. Navigation + SHIFT (the 8×8 windowing model)

The owner's spec, made concrete:

- **The Launchpad's dedicated top buttons ▲ ▼ ◀ ▶** scroll the **note-editor window**,
  **one row/column per press**:
  - **◀ / ▶** = step window left/right by **1 step** (the window is 8 columns wide;
    pressing ▶ at a block-half boundary crosses into the next half/block, up to the
    128-step max / the clip's length).
  - **▲ / ▼** = pitch window up/down by **1 scale-degree row** (reusing the editor's
    `rowOffset` math — `editRowToMidi` row scrolling, `grid-clip-map.ts:161-164`).
- **SHIFT (held) makes ▲▼◀▶ jump a FULL SCREEN (8) at a time:**
  - SHIFT+◀/▶ = ±8 steps (a whole visible window = half a 16-block) — so two SHIFT-▶
    presses cross a full 16-step block.
  - SHIFT+▲/▼ = ±8 rows (a full screen of pitches ≈ one in-key octave-plus).
  - This is the 8×8 substitute for the monome's "see 16 at once": one screen = 8, a
    SHIFT-jump = the next 8.
- **SHIFT is GLOBAL, not just the editor:** in SESSION, SHIFT+◀/▶ pages the **clip-slot
  view** if/when slots exceed 8 (today 8 slots fit exactly, so it's a no-op now but
  reserved for a future >8-slot or banked layout), and SHIFT+▲/▼ pages **lane banks**
  (reserved similarly). SHIFT also composes with the held copy/paste/edit modifiers:
  e.g. **hold COPY + SHIFT + tap** = copy a whole **block** (a future step-range copy),
  vs. plain hold-COPY + tap = copy the whole clip. SHIFT never *replaces* a gesture;
  it's a *magnitude* modifier (×8) + a *scope* modifier (clip→block).

### Which physical button is SHIFT?
The Mk3 8×8 units have **no dedicated Shift**. The cleanest choices:
- **Recommended: the top-row Session/▣ button (CC 95).** It's a top function button
  (so it's out of the ▲▼◀▶ cluster), easy to hold with a thumb, and unused by our
  layout in programmer mode. Held = SHIFT; we light it violet while held.
- **Alternative: a held bottom-right scene button** (right column, CC 19) — a
  comfortable "modifier corner", but it eats a scene-column pad.
- **On Launchpad Pro Mk3 there IS a labelled Shift** — if the owner's units are Pro,
  use the real Shift button (OPEN QUESTION Q-HW).

**OPEN QUESTION Q3:** confirm CC 95 (Session/▣) as SHIFT, or prefer a different
top/scene button? (This is a small, easily-changed binding constant.)

---

## 8. LED colour language (RGB)

We reuse the shared **`legend-colors.svg`** state→colour map (already RGB-accurate)
and drive it with the programmer-mode lighting SysEx. The state colours:

| State | RGB (0-127) | Anim | Source field |
|---|---|---|---|
| empty slot | 0/0/0 | off | no clip |
| loaded clip (idle) | 28/40/56 (dim blue) or clip tint | static dim | `clips[i]` present |
| **playing** | 23/104/53 (green) | **pulse** | `playing[lane]===slot` |
| **queued-launch** | 23/104/53 (green) | **flash** | `queued[lane]===slot` |
| **queued-stop** | 104/23/23 (red) | **flash** | `queued[lane]==='stop'` |
| recording / armed | 127/16/16 (red) | pulse | `recording` |
| copy-buffer source | 15/99/99 (turquoise) | pulse | per-machine buffer |
| scene launch | amber | static | scene column |
| stop lane | dim red → bright red when playing | static | STOP control |
| function / FOLLOW idle | white | static | deck buttons |
| held modifier / FOLLOW frozen | violet | flash | COPY/PASTE/VEL/SHIFT held |
| transport running / FOLLOW on | green | static | `timelorde.running` |
| editor note (velocity) | blue→cyan ramp, 6 shades | static | `VEL_LEVELS` |
| note under playhead | yellow boost | static | playhead column |

**Animation, not hue, distinguishes playing (pulse) vs queued (flash)** — the Ableton/
Launchpad-native convention (both green), so a Launchpad user reads it instantly.
Pulse = MIDI channel 3, flash = channel 2, static = channel 1 (or all-RGB via the
lighting SysEx). The monome's "3 brightnesses + dark" reality is gone.

---

## 9. Hardware reference (verified, with citations + confidence)

All **CONFIRMED** items below were cross-checked against ≥2 of: Novation user-guides,
the Launchpad Pro/X/Mini Mk3 Programmer's Reference manuals, and the `lpminimk3`
Python implementation. Items marked **VERIFY-ON-HW** are the well-documented family
convention but should be confirmed on the owner's actual units (esp. if they're Pro).

- **SysEx header (Mini Mk3):** `F0 00 20 29 02 0D …` — `00 20 29` = Novation/Focusrite
  manufacturer ID, `02 0D` = Launchpad Mini Mk3 product. **CONFIRMED.** (Launchpad X =
  `02 0C`; Pro Mk3 = `02 0E` — device byte differs per model, which is why the L/R
  pairing must bind by enumerated port, not a hardcoded byte.)
- **Enter / exit Programmer mode:** the "Programmer/Live mode select" SysEx,
  `F0 00 20 29 02 0D 0E <mode> F7` where `<mode>` = `01` programmer, `00` Live →
  **enter = `F0 00 20 29 02 0D 0E 01 F7`**, exit = `…0E 00 F7`. **CONFIRMED** (mode
  byte semantics confirmed across sources; the `0E` command byte VERIFY-ON-HW for the
  exact model).
- **Pad addressing (programmer mode):** the 8×8 sends/receives **Note** numbers
  `row*10 + col`, bottom-left = **11**, top-right = **88** (row 1 = bottom … 8 = top;
  col 1 = left … 8 = right). **VERIFY-ON-HW** (this is the consistent MK3 programmer
  layout; one source quoted the *Drum-rack* layout's 36-99 numbering, which is a
  DIFFERENT layout — programmer mode uses 11..88, but worth a 30-second hardware
  check).
- **Top row buttons:** **CC 91-98** (left→right). **CONFIRMED** (Novation: "top row
  buttons send CCs 91-98"). Our mapping: ▲=91, ▼=92, ◀=93, ▶=94, ▣/SHIFT=95, then
  96-98 spare on L / used as deck controls on R.
- **Right column (scene) buttons:** **CC 89, 79, 69, 59, 49, 39, 29, 19** (top→bottom)
  — the col-9-of-each-row extension of the row*10+col scheme. **VERIFY-ON-HW.**
- **Logo LED:** CC 99. **VERIFY-ON-HW.**
- **LED control — three ways, all per-LED:**
  - *Palette / velocity:* Note-On velocity (pads) / CC value (buttons) selects a
    fixed palette colour 0-127. **Channel 1 = static, channel 2 = flashing, channel
    3 = pulsing.** **CONFIRMED.**
  - *Full RGB:* the **LED-lighting SysEx** `F0 00 20 29 02 0D 03 <spec…> F7`, each
    `<spec>` = `<lighting-type> <index> <data…>`; **lighting-type 3 = RGB**, data =
    `R G B` each **0-127**; up to ~81 specs per message (whole-surface repaint in one
    SysEx). **CONFIRMED for the format**; the Pro-Mk3 manual excerpt documents types
    0/1/2 with header `02 0E 03` — the **Mini Mk3 adds type 3 (RGB)** under `02 0D 03`
    (VERIFY-ON-HW that type 3 is present on the owner's exact unit; the `lpminimk3`
    lib confirms RGB 0-127 for the Mini).
  - Nearest stock palette indices (for reference): 0=off, 3=white, 5=red, 9=amber,
    13=yellow, 21=green, 37=turquoise, 45=blue, 49=violet. We prefer RGB SysEx for
    exact hues + only cite indices as a fallback. **CONFIRMED (family-stable).**
- **Global brightness / text scroll:** brightness + a text-scroll SysEx exist in the
  Mk3 family (scroll a label like "EDIT"/"COPIED"/clip names across the pads — a touch
  the monome can't do). Exact command bytes **VERIFY-ON-HW** before we rely on them.
- **Two USB-MIDI port pairs:** `LPMiniMK3 DAW In/Out` (Session surface a DAW drives)
  and `LPMiniMK3 MIDI In/Out` (Custom modes + **Programmer mode** — the one we bind).
  **CONFIRMED** (Novation user-guides).
- **Web MIDI:** `requestMIDIAccess({ sysex: true })`; Chromium-only; two units = two
  `MIDIInput`/`MIDIOutput` entries we pair via §4.3. **CONFIRMED.**

### Monome (WebSerial) vs Launchpad (Web MIDI) — what's shared vs controller-specific
| Concern | monome (today) | Launchpad (new) | Shared? |
|---|---|---|---|
| transport | **WebSerial** 115200 8N1, FTDI | **Web MIDI** + SysEx | NO (per-controller device layer) |
| codec | mext bytes (`0x18`/`0x21`) | MIDI note/CC + lighting SysEx | NO |
| LED depth | 0-15 **brightness**, single hue | full **RGB** + pulse/flash | NO (richer on LP) |
| surface | 16×8 (one unit) | 8×8 ×2 (two units) | NO (placement differs) |
| clip/launch logic | `clip-surface-map` core | same core | **YES** (the rename's whole point) |
| pure transforms | `clip-types.ts` | same | **YES** |
| synced state | `node.data` writes | same writes | **YES** (multiplayer free) |
| binding persistence | localStorage per-machine | localStorage per-machine | YES (pattern) |
| test seam | `installSimulatedGrid` | `installSimulatedMidiDevice` (exists) | pattern shared |

---

## 10. Phased build plan

0. **Hardware spike (½ day):** plug in both units, confirm the VERIFY-ON-HW bytes
   (programmer enter/exit, 11..88 pads, CC 91-98 / 89..19, RGB type 3, brightness +
   text-scroll commands). Capture a golden SysEx log. **Gates everything.**
1. **Rename + extract shared core (refactor PR, no behavior change):** `lib/grid` →
   `lib/control/monome` + split `grid-clip-map.ts` into `clip-surface-map.ts` (core) +
   `monome-map.ts` (16×8). All existing tests pass unchanged. §3.
2. **Launchpad device layer:** `lib/control/launchpad/launchpad-device.svelte.ts`
   (Web MIDI singleton + SysEx, mirrors `grid-device`'s shape + simulated-device hook)
   + `launchpad-sysex.ts` (PURE codec, golden-vector tested like `mext.ts`). §4.3.
3. **Launchpad placement + binding:** `launchpad-map.ts` (the 8×8 ×2 placement over the
   shared core) + `launchpad-control.svelte.ts` (the mode machine, mirrors
   `grid-clip-binding`). Plus the pairing handshake UI. §4-§6.
4. **Nav + SHIFT:** dir-button windowing + the SHIFT magnitude/scope modifier. §7.
5. **Connect UI:** a "Launchpad" connect button on `ClipplayerCard` (next to GRID),
   the L/R pairing flow, per-machine binding. (+ optional canvas card if Q1 = yes.)
6. **Tests:** pure golden-vector (sysex) + placement-map unit tests; a
   **real-source-chain e2e** (TIMELORDE → clip-player → simulated Launchpad press →
   audible RMS) per the poly/MIDI standard; VRT for any new card; flake-check 3×.

CI wall-time: device/codec tests are pure (cheap). The e2e uses the simulated MIDI
device (no hardware, no software-renderer cost) — should add well under the 2-min
threshold. No WebGL.

---

## OPEN QUESTIONS for the owner (please answer — these gate the build)

- **Q-HW (most important): which Launchpad Mk3 exactly?** Mini Mk3 / Launchpad X /
  Pro Mk3? Mini & X share everything here (X adds velocity pads — a free note-entry
  bonus). **Pro Mk3** has a different device byte, extra button rows, and a real Shift
  — if it's Pro, several constants change (and SHIFT gets a dedicated button). Please
  confirm the model + run the §10.0 hardware spike so we pin the VERIFY-ON-HW bytes.
- **Q1 (rename scope + module-ness):**
  (a) Keep the engine module type as `clipplayer` (recommended), or actually rename
  the *node* to "monome control" (churns saves/registry/tests for no engine benefit)?
  (b) Should the two Launchpad surfaces be **canvas nodes/cards** (`launchpad-control-
  left/-right` modules), or just a **connect button + L/R device roles** like the grid
  is today (recommended)?
- **Q2 (editor modality):** is **held-LAUNCH-peek** (re-show L's matrix while editing)
  enough for v1, or do you want the **matrix permanently live on one unit** from day
  one (full Plan-C non-modal, more code)?
- **Q3 (SHIFT button):** confirm **top-row Session/▣ = CC 95** as SHIFT, or prefer a
  scene-column button / (if Pro) the real Shift?
- **Q4 (L/R pairing):** prefer the **press-a-pad pairing handshake** (recommended, no
  device setup) or **distinct USB device IDs** set in each unit's bootloader (more
  setup, binds by name)?
- **Q5 (single-unit fallback):** if only ONE Launchpad is connected, do you want it to
  run **matrix-only** (control falls back to the card, editor = a held mode that takes
  the matrix over, 7+func like the monome), or refuse to bind until both are present?
- **Q6 (scene column conflict on L):** the monome put per-lane STOP on a column; on
  Plan B, L's right CC column = SCENE LAUNCH and STOP moves to R. OK to drop per-lane
  STOP from L entirely (it's on R), or keep a STOP affordance on L's scene column via
  a held modifier?
- **Q7 (which controller "wins" when both monome + Launchpad are connected):** can a
  user drive the SAME clip-player from a monome AND two Launchpads at once (they all
  just write `node.data`, so technically yes), or should binding be exclusive per
  clip-player?

---

## Files in this folder (after this proposal)

| File | What it is |
|---|---|
| `launchpad-mk3-proposal.md` | **this** — the chosen direction (supersedes plan-B as THE plan) |
| `README.md` | overview + device research + the 3-plan history (revised for 8×8 + #827 + two-LP + dir/SHIFT) |
| `legend-colors.svg` | shared RGB state→colour language (reused) |
| `launchpad-left.svg` | **NEW** — Unit L session/clip-launch, 8×8 + top dir row + scene col, RGB states |
| `launchpad-right.svg` | **NEW** — Unit R command deck, 8×8 + top globals + COPY/PASTE/MUTE/SOLO/LEN/EDIT |
| `launchpad-clipedit.svg` | **NEW** — 8×8 note editor: the 8-at-a-time window + ▲▼◀▶ nav + SHIFT=full-screen |
| `launchpad-shift-legend.svg` | **NEW** — the SHIFT + held-modifier legend |
| `plan-A.md` / `plan-B.md` / `plan-C.md` + their `.svg`s | the 3-plan exploration (history; B is the chosen base) |
</content>
