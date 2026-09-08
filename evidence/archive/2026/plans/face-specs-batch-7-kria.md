# FACE SPEC — `kria` (batch 7)

# ⛔ VERDICT: DO NOT PROMOTE. FIX THE MODULE FIRST — PR K1 (§5).

Unlike `flipper`, this is **not** a permanent ruling: it names the unblocking work.
**Build PR K1** (the six missing editor pages, card + grid, **zero contract cost**),
then re-spec. Do not open a face PR for kria before that lands.

⚠ **THE PLATFORM SIDE IS ALREADY UNBLOCKED.** `#1480` (*"the primitive-parity
inventory — make a missing cell kind LOUD, and free the rank a hero picture was
paying"*) landed the PF-22 work this spec was waiting on. **The remaining blocker is
the MODULE, not the face platform.**

⚠ **K1 AND K2 ARE STILL UNSTARTED.** `#1484`'s own title says *"five measured
defects — macseq, cartesian ×2, fourplexer, rings **(and kria is NOT one)**"*.

> **Two owner rulings, 2026-08-11, also apply** (verbatim at `rings.ts:585-590` and
> `:645-650`): *"we should prefer almost zero AI authored text, and all future
> faceplate work should reflect that"* and *"lets stop doing these and clean up the
> existing ones, get rid of them. lose the signal flow diagrams."* The §6 sketch
> carries labels only, no hints and no signal-flow. Measurements belong in
> `docs.controls` (the `rings.ts:592-596` precedent).

## 0. STATUS AND THE THREE-FACT ARGUMENT

**Authored 2026-08-11 against `main` at `2af79daf`. UNBUILT** — no `face:` block.

The argument is three measured facts, none of which a face can touch:

1. **BOTH of kria's params are BIT-EXACTLY INERT in the configuration the module was
   designed for.** Its own file header declares *"Clock = the rack's TIMELORDE
   singleton"* — and **with a `timelorde` node in the rack, `bpm 30 / running 0` and
   `bpm 300 / running 1` produce byte-identical 161-event renders.** `bpm` and
   `running` are the entire param surface. A face's whole vocabulary here is two
   dials that do nothing.
2. **46 % of the module's model has no editor anywhere.** `ratchet`, `probability`,
   `glide`, `loopStart`, `loopLength`, `timeDivision`, `direction`, `muted`, `scale`
   and `root` — **214 values** the engine reads every tick, the pattern snapshot
   copies, the coercer validates and `docs.explanation` describes in detail — are
   settable by no gesture on the card and no gesture on the monome grid. Both
   surfaces expose the same four pages: TRG / NTE / OCT / DUR.
3. **A face cannot supply the missing editors, structurally.** They are not
   `ParamDef`s, so `face.order` cannot rank them. The one surface that could host
   them is a `ShellPanelCell` — and `module-face-lint` refuses a panel SELECTED at a
   lane tier, so a panel's first legal rank is 7. **kria has 3 ranked cells.** A
   `custom` sidebar block escapes the rank (the `noise` / `meowbox` precedent) but
   `sidebar-panels.ts`'s rule 2 is explicit: *"A panel READS; it does not own
   state."*

So the face-shaped work available on kria today is: paint two inert knobs and a grid
cell the shell cannot render. **The work kria actually needs is a card PR that adds
the six missing pages, and it is not a face PR.**

archetype: **the polymetric grid sequencer** — four tracks, each with its own loop
window, clock division and direction, drifting in and out of phase.

In `STRICT_DOCS` (`strict-docs.ts:190`). **Not** in `EXEMPT_FROM_VRT` — it ships
`vrt.spec.ts/kria.png`, informational lane (not `STRICT_VRT_MODULES`). **Not** in
`DOCKABLE_TYPES`. **Not** in `PUSH_CARD_CONTROLS`. Size declared on the def itself
(`kria.ts:57-59` — `3u / hp 4`), not in `rack-sizes.ts`. contract-lock **14 lines**
(`contract-lock.txt:1482-1495`) — the smallest contract of any sequencer in the
registry, over the largest model.

**Method.** No worklet: a main-thread scheduler writing `ConstantSourceNode`s off
`getSchedulerClock()`. The REAL shipped `factory()` was driven headless over a
deterministic fake `AudioContext` (every `setValueAtTime` /
`linearRampToValueAtTime` / `cancelScheduledValues` logged with node, time and
value), `getSchedulerClock` replaced by a captured subscriber the probe steps by
hand, and the real `$lib/graph/store` patch used for params, `node.data` and edges so
`isInputPortConnected` and the TIMELORDE scan see a real graph. The pure model
(`kria-types.ts`) was driven directly for the direction and scale tables.

**Determinism control: two identical 1.0 s renders bit-equal — `true`, 93 logged
events** (all `probability` at the default 1). **And the control has a DELIBERATE
second reading, which is the point of running it:** set any step's `probability` to
0.5 and the same two renders are **`false`** — `emitTrackStep` calls `Math.random()`
(`kria.ts:268`). So kria is deterministic only in the region of its own model where
a face could pin anything, **and the control tells you where the boundary is instead
of asserting sameness once.**

---

## 1. THE CONTRACT

### 1a. Params — 2

| id | label | range | curve | default |
|---|---|---|---|---|
| `bpm` | `BPM` | 30 .. 300 | linear | 120 |
| `running` | `Run` | 0 .. 1 | discrete | **0** |

`running` is `0..1 discrete default 0` → `looksLikeSwitch()` → it needs an
`ACKNOWLEDGED_LATCHING` entry (`'kria:running'`). It renders as `<Toggle>`; the card
paints it as a RUN button (`KriaCard.svelte:240-246`). `bpm` is a `<Knob>` on the
card (`:336-337`), so **no `paramCells: 'fader'` here** — the noise precedent is
about matching the card's affordance, and this card draws a dial.

### 1b. Ports — 2 in, 8 out

`clock` (gate, **trigger**) · `reset` (gate, **trigger**) → `pitch1..4` (pitch) +
`gate1..4` (gate, **gate**).

Both inputs route through the canonical `createEdgeCounter`
(`$lib/audio/edge-detect`, `kria.ts:148, 159`) — **kria is the *good* citizen of this
batch**; `cartesian` hand-rolls its LFO counter. Both `edge` declarations are right:
`clock` advances once per rising edge, `reset` re-anchors once per rising edge, and
neither is level-sensitive.

**Zero CV inputs target a param**, so there is no CV-reach story and the rear
derivation has no per-page CV bands to build (§6).

### 1c. `node.data` — the module

```ts
KriaData = { patterns: Record<string, KriaPattern>, active, cued, cueSteps }
KriaPattern = { tracks: KriaTrack[4], scale, root }
KriaTrack  = { trig[16], ratchet[16], note[16], octave[16], duration[16],
               probability[16], glide[16],
               loopStart, loopLength, timeDivision, direction, muted }
```

**Per active pattern: 4 × (7 × 16 + 5) + 2 = 470 values. Two of them are
`ParamDef`s. The ratio is the module.**

---

## 2. AT SPAWN — measured

| configuration | scheduled writes / 1.0 s | gate-HIGH writes | `totalAdvances` |
|---|---|---|---|
| **the shipped default** (`running` 0, `defaultKriaData()`) | **0** | 0 | 0 |
| `running` forced to 1, default data | **80** | **0** | 36 |

**A kria that you press RUN on is bit-silent.** `defaultTrack().trig` is
`fill(false)` (`kria-types.ts:160`), so `fire` is false on every step of every track
and `emitTrackStep` writes `gate = 0` and one pitch value forever (measured: **1**
distinct non-zero pitch value across the whole render, 0 gate-HIGH writes). That is
defensible — an empty sequencer should be empty — and it is worth stating because it
means **the lane tile has nothing live to show at spawn and neither does the dock.**

`totalAdvances = 36` rather than 32 over 1.0 s at 120 BPM is the 200 ms lookahead
(`LOOKAHEAD_S`, `kria.ts:163`) running 9 base ticks ahead × 4 tracks — not a tempo
error.

---

## 3. THE MEASURED DEFECTS

### A · BOTH PARAMS ARE BIT-EXACTLY INERT WITH A TIMELORDE IN THE RACK

`resolveTransport()` (`kria.ts:212-222`) consults, in order: is `clock` patched? →
run, tempo from TIMELORDE-or-param. Is there a `timelorde` node anywhere in the
graph? → **its** bpm and **its** running. Otherwise → the two params.

Measured, 60 ticks (1.5 s), one track fully trigged:

| rack | kria's own params | result |
|---|---|---|
| a `timelorde` present (bpm 150, running 1) | `bpm 30, running 0` vs `bpm 300, running 1` | **logs identical = true**, 161 events |
| **no timelorde** *(negative control)* | `bpm 30` vs `bpm 300` | **identical = false** |
| **no timelorde** *(negative control)* | `running 0` vs `running 1` | **identical = false** |
| `clock` patched, 8 Hz | `running 0` vs `running 1` | **logs identical = true**, 116 events |

**Two negative controls, both red in the required direction**, so the probe can see a
one-param change; with a TIMELORDE it sees none **across the entire declared range of
both params at once.**

⚠ **This is not "an override", it is the DESIGNED configuration.** `kria.ts:12` —
*"Clock = the rack's TIMELORDE singleton (read live from the graph store): runs only
while TIMELORDE.running ≥ 0.5, tempo = TIMELORDE.bpm."* The params exist for the rack
that does **not** have the rack transport in it. So on the normal patch, a kria
faceplate's whole control surface is inert, and the `docs.controls` entries say so
honestly (*"used only when there is no TIMELORDE node in the rack AND nothing is
patched into CLOCK IN"*) — **which means the face would add nothing the docs do not
already say, while being obliged by `STRICT_FACES` completeness to paint both.**

### B · UNDER AN EXTERNAL CLOCK, `bpm` SILENTLY BECOMES A GATE-WIDTH CONTROL

With `clock` patched the cable sets the tempo and `bpm` still feeds `stepDur`, which
is what `emitTrackStep` multiplies the `duration` lane by. Measured, a 4 Hz cable
clock (real step **0.25 s**), `duration` at its 0.5 default:

| `bpm` | gate width | vs the real step |
|---|---|---|
| 30 | **0.250000 s** | **100 %** — the gate never closes |
| 300 | **0.025000 s** | 10 % |

**At `bpm` 30 against any cable clock faster than 2 Hz the gates OVERLAP**, and
nothing in the module notices. The knob labelled BPM is, in this topology, a
gate-duty knob with a tempo-shaped law. `macseq` has the same defect (its spec §3-B);
`cartesian` has a worse version (its spec §3-C). **All three sequencers in this batch
get the external-clock gate width wrong, in three different ways.**

### C · 214 MODEL VALUES HAVE NO EDITOR — on the card OR the grid

The card's page roster is `PAGES = ['trig','note','octave','duration']`
(`KriaCard.svelte:59-64`). The monome grid's is
`KRIA_PAGES = ['trig','note','octave','duration']` (`kria-grid-map.ts:29-30`). **The
same four.** Everything else appears in the tree exactly twice: in the
pattern-snapshot copy (`KriaCard.svelte:139-143`, `kria-grid.svelte.ts:154-164`) and
in `loopWindowSet`'s LED read (`kria-grid-map.ts:229-231`) — copied and displayed,
never assigned.

| model value | engine reads it | any editor |
|---|---|---|
| `trig[16]`, `note[16]`, `octave[16]`, `duration[16]` | ✔ | ✔ card + grid |
| `ratchet[16]` | ✔ `kria.ts:277` | **✘** |
| `probability[16]` | ✔ `:268` | **✘** |
| `glide[16]` | ✔ `:254` | **✘** |
| `loopStart`, `loopLength` | ✔ `advanceStep` | **✘** |
| `timeDivision` | ✔ `:309` | **✘** |
| `direction` | ✔ `advanceStep` | **✘** |
| `muted` | ✔ `:268` | **✘** |
| `scale`, `root` | ✔ `stepVOct` | **✘** (`scale` is shown read-only, `KriaCard.svelte:338`) |

**Count: 4 tracks × (3 unreachable lanes × 16 + 5 unreachable scalars) + 2 pattern
scalars = 214, against 256 that are editable. 46 % of the model.**

And these are not obscure corners — they are the module's *stated* identity.
`docs.explanation` promises *"its own loop window (start + length), clock division
and play direction (forward / reverse / ping-pong / drunk / random)"* and *"separate
per-step lanes for trigger, note, octave, duration, probability, glide and ratchet"*.
**All seven lanes exist in the engine; four can be edited.**

The engine side is real and correct — measured:

| `direction` | first 20 steps from a fresh cursor | repeatable |
|---|---|---|
| `forward` | 1,2,3,…,15,0,1,2,3,4 | ✔ |
| `reverse` | 15,14,13,…,1,0,15,14,13,12 | ✔ |
| `pingpong` | 1,2,…,14,15,14,13,12,11,10 | ✔ |
| `drunk` | 15,0,1,2,1,0,1,2,1,0,15,0,1,0,15,14,13,12,11,12 | **✘** |
| `random` | 5,7,10,7,8,5,0,5,12,7,13,3,8,10,8,6,3,13,0,8 | **✘** |

…and so is the scale mapping (V/oct for degrees 0..6, root C3):

| scale | 0 | 1 | 2 | 3 | 4 | 5 | 6 |
|---|---|---|---|---|---|---|---|
| major | −1.0000 | −0.8333 | −0.6667 | −0.5833 | −0.4167 | −0.2500 | −0.0833 |
| minor | −1.0000 | −0.8333 | −0.7500 | −0.5833 | −0.4167 | −0.3333 | −0.1667 |
| pentatonic | −1.0000 | −0.8333 | −0.6667 | −0.4167 | −0.2500 | **0.0000** | **0.1667** |
| chromatic | −1.0000 | −0.9167 | −0.8333 | −0.7500 | −0.6667 | −0.5833 | −0.5000 |

(Pentatonic has five degrees, so the NOTE page's rows 5 and 6 wrap into the next
octave — correct, and worth a `docs` sentence since the grid draws seven rows for a
five-note scale.)

**Five working direction modes and four working scales that no user can select. That
is what makes this a MODULE gap rather than a face gap: the DSP is finished and the
surface is missing.**

---

## 4. WHY A FACE CANNOT CLOSE ANY OF IT

### The cell arithmetic

2 params + 1 declared family = **3 cells**, so every one of kria's three ranks is
SELECTED at a lane tier. `panelTierProblems` (`module-face-lint.test.ts:652-666`)
fails a `panel` cell selected at `mini`, `compact` or `full`: *"Rank it below the
lane caps (ranks 7+ are dock-only) or drop the panel."* **kria cannot reach rank 7.**
So:

- `kria-cell-{n}` — the per-step editor grid, and the module's identity — must be
  ranked (STRICT_FACES completeness, `module-face-lint.test.ts:245-246`);
- the only `ShellCell` kind that can paint a grid is `panel` (the registry has
  `selector` / `action` / `file` / `toggle` / `panel`, `shell-cells.ts:271-274`);
- an unregistered family key paints `data-cell-control="inert"`
  (`ModuleShell.svelte:865`), which fails `module-face-lint` **and** `faces-parity`.

**Three mutually exclusive requirements. This is a contradiction, not a hard layout
problem to be solved with taste**, and the spec's job is to name it rather than route
around it.

### The sidebar escape does not apply

`noise` and `meowbox` got their pictures onto a faceplate through a `custom` sidebar
block, which carries no `face.order` key and therefore no rank. That works because
their pictures are **pictures**. `sidebar-panels.ts:23-24`: *"A panel READS; it does
not own state. It takes a nodeId and derives everything from the live node + def."*
**Kria's missing surfaces are EDITORS.**

### The glyph is a no-op

`glyphBinding` resolves through `primaryAudioOutPortId`
(`shell-glyph-live.ts:95-97, 135-171`) = `outputs.find(o => o.type === 'audio')`.
Kria's eight outputs are `pitch` and `gate`. No `algorithm` param, no `envelope`
A/D/S/R set, no 0..2 `shape`. **Every glyph kind resolves to `{ kind: 'static' }`** —
a deterministic dead trace. Whatever kria eventually gets, it is `glyph: 'none'`.

### And a readout could not say anything either

`FaceReadoutValue` is **params only**. Every number worth printing on this module is
in `node.data` (how many steps trig, what the loop lengths are, which
tracks are muted) or in the **graph** (is a `timelorde` present, is `clock` patched).
**Kria adds a shape to that platform request the earlier petitioners did not have:
not *"is this port patched"* but *"does a node of type X exist anywhere in the
rack"***, because that is the predicate `resolveTransport` branches on. See the
cartesian spec §11-C for the running count (**nine modules**).

---

## 5. WHAT TO BUILD INSTEAD — the module PR, sized

**PR K1 — `feat(kria): the six missing editor pages`** (card + grid, one PR).
**⚠ STILL UNSTARTED as of #1484.**

- Card: extend `PAGES` from 4 to 7 — add `RAT`, `PRB`, `GLD`. The step grid already
  renders 8 rows × 16 columns and `onCell(step, row)` already switches on `selPage`
  (`KriaCard.svelte:152, 175`); each new page is a lane write and a row→value
  mapping. `ratchet` is 1..4 (4 rows), `probability` is Kria's four-level fader
  (1 / 0.5 / 0.25 / 0 — the model's own comment, `kria-types.ts:109-110`), `glide` is
  seconds.
- Card: a per-track strip for `loopStart` / `loopLength` / `timeDivision`
  (`KRIA_TIME_DIVISIONS` = `[1,2,3,4,6,8,12,16]`) / `direction` (`KRIA_DIRECTIONS`) /
  `muted`. Five controls × 4 tracks; the track selector already exists.
- Card: `scale` (4 presets) + `root` for the pattern. The read-only `scale-tag`
  becomes a control.
- Grid: `KRIA_PAGES` and the row spans mirror the card's — the map file is already a
  pure table (`kria-grid-map.ts:57`).
- **Contract cost: ZERO.** Not one of these is a `ParamDef`; they all live in
  `node.data`, which is already synced, snapshotted and coerced. No contract-lock line
  moves, no ART, no attest.
- Test cost: the pure lane writes are `kria-types.test.ts` rows; the grid map is
  already golden-tested.
- ⚠ VRT: kria ships `vrt.spec.ts/kria.png` in the **informational** lane (not
  `STRICT_VRT_MODULES`), so the card growth re-captures one non-required baseline.
  Linux CI authors it; never commit one.

**PR K2 — `fix(kria): gate width from the CABLE clock, not the BPM param`** (§3-B).
**⚠ STILL UNSTARTED.** Measure the interval between `clock` rising edges (the counter
already timestamps them) and use it for `stepDur` when `clock` is patched. **Owner
audition: it changes the sound of any saved rack driven by an external clock.**

**PR K3 — the face**, after K1. With the six pages landed the module has a real
control surface, and the face question becomes interesting rather than impossible —
the dock is the only place with room for seven pages at once, and `face.pages` at 7
would trip `DOCK_TAB_MIN_BANDS` into a tab rail, which is exactly the trade a
per-lane page editor wants. **Re-spec then; do not pre-commit a layout to a control
surface that does not exist yet.**

---

## 6. FOR THE RECORD — what the face WOULD look like, once K1 lands

Not a recommendation. Written down so K3 does not start from zero, and because one
number in it is a live hazard.

⚠ **THE TAB-RAIL FOLD, at 1280×720.** `.dock-faceplate` is
`max-height: min(60vh, 680px)` (`DockFullView.svelte:371`); at 720 px tall that is
**432 CSS px**, and the captured faceplate is **425 px** (`LEGACY_FOLD_PX`,
`_shell-faces.ts:325`). Measured off `face-cloudseed-dock.png`, the chrome above the
bands costs ~130 px — grip, title bar, and **the tab rail itself** — leaving **~295 px**
of band region at a `DOCK_BAND_PX = 90` pitch (`dock-tabs-model.ts:21-35, 53`).

A seven-page kria **is** a tab rail (`DOCK_TAB_MIN_BANDS = 7`), so exactly one band
renders at a time and the hero is above it, always. **The hero budget is therefore
~295 px minus one band (~90 px) = ~205 px.** A 16-column × 8-row step grid at 20 px
cells is 160 px tall plus a 24 px column ruler = **184 px — it fits, barely, and only
at 20 px cells.** At the card's own cell size it does not, and the result is the
wavesculpt failure exactly: a 445 px hero against a ~352 px box renders every band
below the fold, so all eight tabs look identical and the rail reads as broken while
being correct. **Any kria face must state its hero height in px and subtract it from
205 before it is reviewable.**

Sketch, for K3 to argue with:

```ts
face: {
  title: 'Tracks',
  order: [
    'kria-cell-{n}',   // 1 — the PF-22 platform side landed in #1480
    'running',         // 2
    'bpm',             // 3
  ],
  pages: [
    { id: 'trig',  label: 'trig' },
    { id: 'note',  label: 'note' },
    { id: 'oct',   label: 'oct'  },
    { id: 'dur',   label: 'dur'  },
    { id: 'prob',  label: 'prob' },
    { id: 'glide', label: 'glide'},
    { id: 'track', label: 'track', controls: ['running', 'bpm'] },
  ],
  glyph: 'none',
}
```

Band labels are LABELS — `trig`, `note`, `oct` — per the 2026-08-11 ruling. No
captions, no explanatory hints; the mechanism lives in `docs:`, in this file and in
the PR body.

**The rear** is 10 holes (2 in + 8 out), no stereo pairs, no CV-param holes. The
derivation puts `clock`/`reset` in the leading signal band and the eight outputs on
the OUTPUTS rail, which is already right — except that a four-track module wants its
outputs read as **pairs**, so one curated group earns its lines:

```ts
rear: {
  groups: [{ id: 'signal', label: 'clock · reset', ports: ['clock', 'reset'] }],
  clusters: [
    { group: 'signal', label: 'track 1', ports: ['pitch1', 'gate1'] },
    // …2, 3, 4
  ],
}
```

`audioRate`: **nothing ticks** — both inputs are polled once per ~25 ms scheduler
tick through an `AnalyserNode` ring (`createEdgeCounter`).

---

## 7. ALREADY-WRONG — ordered by cost to a user

- **A · 214 model values, 46 % of the pattern, have no editor** (§3-C). **PR K1. The
  single largest control-loss finding in the batch.**
- **B · under an external clock, `bpm` becomes a gate-duty control, and at bpm 30 the
  gates overlap** (§3-B). **PR K2, owner audition.**
- **C · both params are inert with a TIMELORDE present** (§3-A). Correct by design,
  invisible on the card. The RUN button and the BPM knob look live and are not. **The
  honest fix is a card affordance, not a face** — grey them and name the source, the
  way the transport resolution already knows it (`resolveTransport` returns the
  answer; nothing displays it).
- **D · `drunk` and `random` directions make the module non-deterministic** (§3-C
  table), as does any `probability < 1`. Correct and intended — but **any future
  ART/VRT coverage of kria must pin the default pattern only**, and a face readout
  could never be pinned against a randomised track. Worth a sentence in
  `docs.explanation`, which currently lists `random` as a feature with no note that
  it is unpinnable.
- **E · the NOTE page draws 7 rows for a 5-degree pentatonic** (§3-C table). Rows 5–6
  wrap an octave. Documentation.
- **F · `cueSteps` is read and written by nothing — CONFIRMED 2026-08-12.** It appears
  only at `kria.ts:327,330,333` (all reads), in `kria-types.ts` (type at `:152`,
  default at `:186`, the `tickCue` reducer at `:430-443`) and in two test files. **No
  writer, no editor.** It gates the quantized pattern switch's countdown; at its
  permanent 0 the cue applies on the next track-0 loop boundary. **Either expose it in
  K1 or delete it.**

---

## 8. COST — if it were promoted today

Recorded so the verdict is priced, not asserted.

| | |
|---|---|
| **contract-lock** | +0 (`face` is contract-transparent). |
| **`ACKNOWLEDGED_LATCHING`** | +1 (`kria:running`). |
| **blocking platform** | ✅ **CLEARED** — PF-22 landed in **#1480**. The remaining blocker is the MODULE (PR K1). |
| **shared registries** | `strict-faces.ts`, `_shell-faces.ts`, `shell-cells.ts`, `push-card-config.ts`. |
| **VRT** | +`face-kria-{compact,dock}` = 2 baselines, plus a re-capture of the informational `vrt.spec.ts/kria.png` if the card moves. |
| **e2e** | +1 `faces-parity` row at **3 cells** ≈ 30 000 + 600×3 = **31.8 s**. Negligible. |
| **the bottom line** | The cheapest face in the batch to build and the only one with nothing to say. Two inert knobs and a grid the shell cannot paint. **Build PR K1 instead** — same author, same week, ten times the value, and zero contract cost. |
