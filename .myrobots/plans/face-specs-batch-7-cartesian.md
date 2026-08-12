# FACE SPEC — `cartesian` (batch 7)

## 0. STATUS

**Authored 2026-08-11 against `main` at `2af79daf`.** Nothing here is
implemented; no def, card, DSP or test file is touched. Every number below was
measured or read against that tree.

**Verdict: PROMOTE — THIRD, behind two blockers, and the face is NOT the fix for
either.** In order:

1. **`mode` is a DEAD PARAM.** Declared, documented in four places, wired to a
   card button — and never read by the factory. Measured bit-exactly inert over
   its whole 2-state range in **both** topologies. A def PR deletes it or wires
   it; a `STRICT_FACES` face is *obliged* to paint it (completeness), so
   promoting first means shipping a faceplate that paints a dead control as a
   working one, which is what the macrooscillator batch exists to forbid — and
   under the 2026-08-11 no-prose ruling the face can no longer even say so.
2. **The step grid cannot be RENDERED on a face today.** `cart-pitch-{n}` is a
   `controlFamily`; the only registered `ShellCell` that can paint a grid is a
   `panel`, and `module-face-lint` refuses a panel SELECTED at a lane tier. With
   7 cells the family lands at rank 7 exactly — legal by one — so the module's
   ENTIRE IDENTITY is invisible at mini, compact and full, and the lane plate
   shows six knobs, **three of which are the defective ones**.

archetype: **the X/Y pad sequencer.** Sixteen notes on a plane; a cursor picked
by coordinate rather than by a playhead line.

Not in `STRICT_FACES`; **no `face:` block** (`grep -c '^  face:'
modules/cartesian.ts` = 0). In `STRICT_DOCS` (`strict-docs.ts:188`). In
**`STRICT_VRT_MODULES`** (`vrt-exemptions.ts:1043`) — the *required* `vrt-strict`
gate, so any card edit moves a required baseline. **Not** in `DOCKABLE_TYPES`.
**Not** in `PUSH_CARD_CONTROLS`. **Not** in `card-range-source.test.ts`'s
allowlist (§10-G). `rack-sizes.ts:36` — `4u / hp 2`, 563×360 px. contract-lock
**17 lines** (`contract-lock.txt:353-369`).

**Method.** The module has no worklet: it is a main-thread scheduler writing
`ConstantSourceNode`s off `getSchedulerClock()`. So the REAL shipped `factory()`
was driven headless over a deterministic fake `AudioContext` — every
`setValueAtTime` / `linearRampToValueAtTime` / `cancelScheduledValues` logged
with node, time and value — with `getSchedulerClock` replaced by a captured
subscriber the probe steps by hand, and the real `$lib/graph/store` patch used
for `node.params`, `node.data` and edge topology (so `isInputPortConnected` sees
real cables). Analysers are fed a programmable signal sampled at the real
`fftSize`/`sampleRate` window, so `createEdgeCounter`-class window math is
exercised, not stubbed.

**Determinism control: two identical 1.0 s renders bit-equal — `true`, 1332
logged events, on every configuration tested.** Instrument negative control:
`octave` 0 → 1 over the same render **does** move the log (`identical = false`),
so a "logs identical" result is a statement about the parameter, not about a
probe that cannot see anything.

---

## 1. THE CONTRACT

### 1a. Params — 6

| id | label | range | curve | default | card primitive |
|---|---|---|---|---|---|
| `mode` | `Mode` | 0 .. 1 | discrete | 0 | header `<button>` LIN/X-Y |
| `octave` | `Oct` | −2 .. 2 | discrete | 0 | `<Fader>` |
| `gateLength` | `Gate` | 0.1 .. 0.95 | linear | 0.5 | `<Fader>` |
| `lfoDiv` | `Div` | 0 .. 7 | discrete | 3 | `<Fader>` + ticks + `formatValue` |
| `lfoShape` | `Wave` | 0 .. 3 | linear | 0 | `<Fader>` + glyphs |
| `snh` | `s&h` | 0 .. 1 | discrete | **1** | header `<button>` S&H/OFF |

`mode` is `0..1 discrete default 0` → `looksLikeSwitch()` sees it → it needs an
`ACKNOWLEDGED_LATCHING` entry (`module-face-lint.test.ts:357`). `snh` does
**not**: its default is 1, and `looksLikeSwitch` requires `defaultValue === 0`.
Both still render as `<Toggle>` (`looksLikeToggle` → `paramCellKind` → `toggle`).

**Four of the six are `<Fader>` on the card**, so all four take
`face.paramCells: 'fader'` — the primitive that landed with `noise`
(`shell-control-kind.ts:63-70`). `lfoDiv` is the exception and it is *not* a
fader question: 8 named states (`LFO_DIVISIONS`) is a `ParamDef.options` roster,
which at ≥7 options resolves to `<Selector>` at the dock
(`SEGMENTED_MAX_OPTIONS = 6`). `lfoShape` is a **continuous morph** between four
named shapes — `landmarks` (PF-10), never `options`, because a Segmented would
lie by hiding the in-between blends, and the blends are live (§3-E).

### 1b. Ports — 4 in, 5 out

| dir | id | type | edge |
|---|---|---|---|
| in | `clock` | gate | **trigger** |
| in | `x_cv` | cv | — |
| in | `y_cv` | cv | — |
| in | `lfo_clock` | gate | **trigger** |
| out | `pitch` | polyPitchGate | — |
| out | `gate` | gate | **gate** |
| out | `clock` | gate | **trigger** |
| out | `lfo_x` | cv | — |
| out | `lfo_y` | cv | — |

**Zero CV inputs target a param.** Not one of the six params is reachable by
cable — every input is an event or a coordinate. That is a rear-card fact (§8)
and a ranking fact: there is no "CV reach" story to tell on this module.

⚠ **`clock` in and `clock` out declare `edge: 'trigger'` and both are correct**
— read against `$lib/audio/gate-trigger`. The input fires once per rising edge
(`lastClockSample < 0.5 && cur >= 0.5`, `cartesian.ts:419`); the output is a
fixed 10 ms pulse (`emitClockPulse`, `:277-278`), which is a trigger by
construction. `gate` out is `edge: 'gate'` and is also right — it is held for a
computed width and its width is the whole problem (§3-C).

⚠ **`lfo_clock`'s edge counter is HAND-ROLLED, not `createEdgeCounter`.**
`updateLfoClock` (`:293-315`) re-implements the windowed scan inline. The window
math is *correct* — `newSamples = ceil(elapsed × sampleRate)`, clamped to
`buf.length`, scanned from `buf.length - newSamples` — so this is not the
NUMPAD+ double-count. It is the drift risk CLAUDE.md's shared-seam rule exists
for: `kria.ts` and `macseq.ts`, the two siblings in this batch, both route
through `$lib/audio/edge-detect`. Converting it is a 6-line PR with no
behavioural delta, and it belongs in whatever PR next opens this file.

### 1c. `node.data` — the part a face cannot reach

`cells: Cell[16]`, each `{ on: boolean; midi: number | null; chord: 'mono' |
'maj' | 'min' }`. **48 values.** None is a `ParamDef`; `FaceReadoutValue` is
`(read: (paramId) => number | undefined) => string`
(`face-readout-values.ts:149`), so no readout can count how many pads are lit,
or whether any pad carries a chord. See §6.

---

## 2. AT SPAWN — measured

With **nothing patched**, over 1.0 s of scheduler ticks:

| | |
|---|---|
| scheduled writes | **1036** |
| of which `lfo_x` | **518** |
| of which `lfo_y` | **518** |
| `totalAdvances` | **0** |
| `lfoMeasuredHz` | 1 (the `LFO_DEFAULT_RATE_HZ` fallback) |
| `lfoPhase` after 1.0 s | 0.036000 |

**An unpatched cartesian schedules a thousand AudioParam events per second.**
The quadrature LFO is unconditional: `scheduleLfo` runs on every tick regardless
of whether `lfo_clock` is patched or `lfo_x`/`lfo_y` are connected to anything,
at `LFO_DT_S = 2 ms` through a 60 ms lookahead. Two `ConstantSourceNode`s ×
500 writes/s. The sequencer half is silent (`totalAdvances = 0`) because with no
clock and no X/Y CV the tick falls to the third branch and only syncs
`lastClockSample`.

This is not a face defect and the face cannot fix it, but it is the honest
answer to "what does this module do when you drop it on the canvas", and it is
the reason the lane tile has nothing live to show (§5).

---

## 3. THE MEASURED DEFECTS — three of six params

### A · `mode` IS BIT-EXACTLY INERT — the param is never read

`grep -n mode modules/cartesian.ts` returns the header comment, the `ParamDef`,
and four prose strings. **The factory never calls `readParam('mode', …)`.** The
tick branches on `isInputPortConnected(edges, nodeId, 'clock')`, not on the
param (`:406`, `:411`). The card's LIN/X-Y button writes a value nothing
consumes.

Measured, 40 ticks (1.0 s), all 16 pads lit:

| topology | `mode` 0 vs 1 | events |
|---|---|---|
| `clock` patched, 8 Hz | **logs identical = true** | 1332 |
| `clock` unpatched, `x_cv` ramp −1→+1 | **logs identical = true** | (same render) |

**Negative control on the instrument:** `octave` 0 vs 1 over the identical
render → `logs identical = false`. So the probe can distinguish a
one-discrete-step param change; `mode` produces none.

**There is no quantisation-floor defence here and it is worth saying why.**
`mode` is `0..1 discrete` — a **2-state** param. Its "plateau" is not a band on
a dial that adjacent values fall into; it is *both* of its states rendering
byte-for-byte identical output. There is no third value to test.

⚠ **And the docs are wrong in a way that reads as a feature.**
`docs.controls.mode` (`:165-166`) describes FREEFORM vs CLOCKED and asserts
*"The card's LIN/X-Y face button toggles this same setting."* The mechanism it
describes is real — the module genuinely has two modes — but the **selector is
the cable, not the param**. `docs.inputs.clock` (`:143-144`) states the true rule
correctly on the very next line. Two authored doc entries, on one def,
disagreeing about which surface chooses the mode.

**This is a DEF bug, not a face bug.** Two clean options, both one PR:
delete `mode` (−1 contract line, −1 docs entry, −1 card button; nothing reads
it, so no audio moves and no saved rack changes) or wire it (`clockPatched`
becomes `clockPatched && mode >= 0.5`, which **does** change saved-rack
behaviour and needs an owner call). **Do not fold either into a face PR.**

### B · `snh` IS UNREACHABLE BY 0.05 OF A KNOB — with a POSITIVE control

`snh` defaults **ON**, has its own card button, its own docs entry, and its own
regression spec (`cartesian-snh.test.ts`). Measured, it does nothing at any
legal setting of anything:

| topology | `snh` 1 vs 0 | events / advances |
|---|---|---|
| `clock` patched, 8 Hz | **identical = true** | 1980 |
| `clock` unpatched, `x_cv` 3 Hz + `y_cv` 1.7 Hz, `gateLength` 0.95 | **identical = true** | 3701 / 45 both |

Bit-identity alone would prove nothing here, so the probe was **positively
controlled** — forced into the state where the feature *must* act, by writing
`gateLength` past its declared maximum (`readParam` applies no clamp, so this is
reachable from the probe and from nothing else):

| `gateLength` | in range? | `snh` 1 vs 0 identical | advances (1 / 0) |
|---|---|---|---|
| **0.95** (declared max) | ✔ | **true** | 45 / 45 |
| **1.00** | ✘ | **false** | 38 / 45 |
| 1.05 | ✘ | **false** | 29 / 45 |
| 2.00 | ✘ | **false** | 26 / 45 |

**The feature switches on at `gateLength = 1.0`. The param's declared maximum is
0.95.**

The mechanism is arithmetic and it is the same arithmetic as §3-C. In the
clock-unpatched branch the guard is `priorGateStillHigh = snh && fireAt <
lastGateOffTime` (`:447`), where `fireAt = nowAt + 0.005` and `lastGateOffTime =
previousFireAt + gateDur × gateLength`. Both fires are one scheduler tick apart,
and `gateDur` **is** that tick (`gateDur = Math.max(0.01, elapsed)`, `:409`). So
the guard needs `tickΔ < tickΔ × gateLength`, i.e. `gateLength > 1`. The declared
range tops out at 0.95, so the S&H can never latch anything.

Confirmed from the other side by varying the host tick — the gate width tracks
it exactly and the conclusion does not move:

| host tick | gate width at `gateLength` 0.95 | `snh` 1 vs 0 |
|---|---|---|
| 25 ms | 0.023750 s | identical |
| 50 ms | 0.047500 s | identical |
| 100 ms | 0.095000 s | identical |

⚠ **`cartesian-snh.test.ts` is green and always was.** It tests the *pure
helpers*, not the tick, so it is structurally unable to see this — the same
"a gate that reads only one side" class as the card/def divergence in CLAUDE.md.
The fix is a DSP/def PR (derive `gateDur` from the measured clock interval, as
`macseq` does, and the S&H becomes reachable at every `gateLength`); the
regression test it needs is the four-row positive-control table above.

### C · GATE LENGTH IS A FRACTION OF THE SCHEDULER TICK, NOT OF THE STEP

The same `gateDur = elapsed` is the gate's whole time base, so the emitted gate
is **tempo-invariant**:

| clock | step | `gateLength` | gate width | % of the step |
|---|---|---|---|---|
| 8 Hz | 0.1250 s | 0.5 | **0.012500 s** | **10.00 %** |
| **2 Hz** | **0.5000 s** | **0.5** | **0.012500 s** | **2.50 %** |
| 8 Hz | 0.1250 s | 0.1 | 0.002500 s | 2.00 % |
| 8 Hz | 0.1250 s | 0.95 | 0.023750 s | 19.00 % |

The knob's entire declared travel spans **2.5 ms → 23.75 ms** at the shipped
25 ms tick — and the numbers change if the host tick does, which means the
control's meaning is a property of `SCHEDULER_TICK_MS`. Halve the tempo and the
gate does not lengthen; the module cannot produce a legato step at any setting.

`macseq`, the sibling in this batch, gets this right on its internal clock
(`stepDur = 60 / bpm / 4`, measured 50.00 % / 10.00 % / 95.00 % exactly). So
this is a cartesian bug with a working reference implementation twelve files
away.

**Also DSP, also not a face PR.** It changes the sound of every saved rack that
uses this module.

### D · THE X/Y AXES ARE FOUR EQUAL BANDS — the plateau is 25 % of the travel

`cvToCell` (`:385-389`) is `floor(((v + 1) / 2) × 4)` clamped to 0..3. Measured
over −1..+1 in 0.05 steps (41 samples):

```
00000000001111111111222222222233333333333
```

Ten samples per band, exactly. **The plateau is 0.5 CV wide — 25 % of the
axis** — which is the number any future inertness probe on this module has to
beat before "the log did not move" means anything. Bit-identity across a 0.1 CV
nudge here is CORRECT BEHAVIOUR, not a dead control.

### E · THE LFO MORPH HAS NO DEAD ZONE — co-prime probe

`lfoShape` 0..3 crossfades sine → tri → saw → square. Sampled at **seven
co-prime phase offsets** (`k/7`, k = 0..6) so a period-2 or period-4 artifact
cannot alias to a constant, `max|Δ|` per 0.1 of the dial:

| segment | Δ per 0.1 step |
|---|---|
| 0.0 → 1.0 (sine → tri) | **1.21e-1**, flat |
| 1.0 → 2.0 (tri → saw) | **1.14e-1**, flat |
| 2.0 → 3.0 (saw → square) | **2.00e-1**, flat |

Thirty steps, no zero, no plateau. `lfoShape` is the healthiest control on the
module and it is the one with the least prose written about it.

`lfoDiv` likewise: `lfoPhase` after 1.0 s unclocked = **0.129500 / 0.036000 /
0.288000** at div 0 (×0.125) / 3 (×1.0) / 7 (×8) — consistent with 0.125, 1.036
and 8.288 cycles through the 60 ms lookahead.

### F · THE X/Y READ IS A 40 Hz POINT SAMPLE OF A 500 Hz WRITE

`cvToCell` reads `buf[buf.length - 1]` — the single most recent sample — once
per ~25 ms tick. The module's own LFO writes its outputs every **2 ms**. So the
headline patch the def advertises (`lfo_x → x_cv`, `lfo_y → y_cv`, "the cursor
draws a circle") is a **40 Hz sampler on a 500 Hz source**, and anything above
20 Hz of cursor motion aliases. At the default `lfoDiv` 1/1 with no `lfo_clock`
that is 1 Hz and entirely fine; at `lfoDiv` ×8 off a 16th-note clock it is not.
Nothing anywhere states the ceiling.

---

## 4. THE RANKING — 7 cells, a lane budget of six

`faceTierCap`: mini **1**, compact **2** with a glyph / **3** without, full **6**
(`curated-face.ts:62-79`). Dock: all 7.

⚠ **THE GLYPH IS WORTHLESS ON THIS MODULE AND THAT IS STRUCTURAL.**
`glyphBinding` (`shell-glyph-live.ts:112-172`) resolves every kind except
`envelope`/`algorithm` through `primaryAudioOutPortId`, which is
`outputs.find(o => o.type === 'audio')`. Cartesian's five outputs are
`polyPitchGate`, `gate`, `gate`, `cv`, `cv` — **no `audio` port**, no
`algorithm` param, no 0..2 `shape`. So *any* declared glyph falls through to
`{ kind: 'static' }`: a deterministic dead trace. **Declare `glyph: 'none'`**
and spend the compact tile's third column on a control. (The same is true of
`kria` and `macseq`; it is true of every sequencer in the registry.)

| rank | key | tier | why |
|---|---|---|---|
| 1 | `cart-pitch-{n}` | — **see the blocker** — | the 4×4 grid IS the module. A sequencer face that ranks GATE above its own pattern is a utility box. |
| 2 | `octave` | mini | the one control a player rides while it runs, and the only param that is both live and unambiguous. |
| 3 | `lfoShape` | compact | the healthiest control on the module (§3-E) and the one that changes what the self-patch draws. |
| 4 | `lfoDiv` | plate | the LFO's rate against its clock. |
| 5 | `gateLength` | plate | ranked HERE and not higher **because §3-C makes it a 2.5-to-23.75 ms trim, not a duty cycle.** Demoting it is a statement about what it does. |
| 6 | `snh` | plate | — *lane budget ends here* — ranked at all only because completeness demands it; §3-B says it does nothing. |
| 7 | `mode` | dock | dead (§3-A). Last, and it should not exist. |

**The rule the ranking follows.** Rank by **what a player touches while the
sequencer runs**, and among equals prefer the control that is measurably alive.
That ordering falls out of §3 rather than out of taste, and it inverts the def's
own declaration order (`mode` is declared first and is dead; `snh` is declared
last and is unreachable).

⚠ **AND THE PLATFORM CANNOT EXPRESS RANK 1.** `curatedFace` resolves
`cart-pitch-{n}` to `kind: 'family'`, which is selectable at a lane tier — but
`ModuleShell` paints a family through `shellCellFor(type, ctl)`
(`ModuleShell.svelte:774`), and an unregistered key renders
`data-cell-control="inert"`, which fails `module-face-lint` **and**
`faces-parity`. The only registered `ShellCell` kind that can paint a grid is
`panel`, and `panelTierProblems` (`module-face-lint.test.ts:652-666`) fails a
panel SELECTED at `mini`/`compact`/`full`. With seven cells the grid can only be
**rank 7**.

So the ranking above is **not shippable today**. The two honest shapes are:

- **(i) ship it as written, gated on PF-22 (§11-A)** — a lane-selectable
  `ShellGridCell`. Then rank 1 is the grid, the compact tile shows the pattern,
  and a rack of sequencers is readable at a glance, which is the entire reason
  a sequencer wants a face.
- **(ii) ship today with the grid at rank 7** — the six knobs above it are
  `octave`, `lfoShape`, `lfoDiv`, `gateLength`, `snh`, `mode`, and **three of
  those six are the §3 defects**. A mini tile showing OCT and a compact tile
  showing OCT + WAVE is not a sequencer; it is an octave box with an LFO.

**Recommendation: (i).** Shape (ii) is worse than the legacy card, and a face
that is worse than the card it replaces should not ship.

---

## 5. THE LAYOUT — three bands, and the fold budget

**Bands: 3.** Well under `DOCK_TAB_MIN_BANDS = 7` (`dock-tabs-model.ts:56`), so
the dock is ONE scrolling column and every band is on screen together. That is
the right trade here and it needs no argument: seven cells cannot justify a
rail.

```ts
face: {
  title: 'Grid',
  hint: 'Sixteen pads on a plane; the cursor is a coordinate, not a playhead.',

  // `order` is a PRIORITY ranking for the tiers that show a SUBSET;
  // `pages` is FUNCTION order for the tier that shows EVERYTHING. They
  // answer different questions — do not "fix" one to match the other.
  order: [
    'cart-pitch-{n}',   // 1 — needs PF-22; see §4
    'octave',           // 2
    'lfoShape',         // 3
    'lfoDiv',           // 4
    'gateLength',       // 5
    'snh',              // 6   ← the lane budget ends HERE
    'mode',             // 7 — dock-only, and it should not exist (§3-A)
  ],

  pages: [
    { id: 'grid',  label: 'grid',  controls: ['cart-pitch-{n}', 'octave'] },
    { id: 'gate',  label: 'gate',  controls: ['gateLength', 'snh', 'mode'] },
    { id: 'lfo',   label: 'lfo',   controls: ['lfoDiv', 'lfoShape'] },
  ],

  glyph: 'none',        // no `audio` output ⇒ every glyph kind resolves to
                        // `static` (§4). Declaring one paints a dead rectangle.

  paramCells: {
    octave:     'fader',
    gateLength: 'fader',
    lfoShape:   'fader',
    // lfoDiv is NOT a fader — 8 named states ⇒ `ParamDef.options` ⇒ <Selector>
    // at the dock, KnobConic + a persistent state readout in the lane.
  },

  hero: {
    cell: 'cart-pitch-{n}',
    control: 'octave',
    readouts: [{ label: 'gate', valueId: 'cartesian-gate-ms' }],
  },
}
```

`mode` additionally needs `ACKNOWLEDGED_LATCHING` — `'cartesian:mode'` — unless
the def PR in §3-A deletes it first, which is the better sequence.

### Band labels are LABELS

Per the owner ruling of 2026-08-11: `grid` / `gate` / `lfo`. No editorial
sentences, no captions, no explanatory `hint` on any page. The three facts in §3
live **here, in `docs:`, and in the PR body** — never on the panel. (`face.hint`
above is annotate-mode-only in any case: `faceAnnotations` gates `title`, `hint`
and every band hint behind annotate mode, `dock-faceplate-model.ts:182-191`.)

### The fold, at 1280×720 — stated as the brief requires

`.dock-faceplate` is `max-height: min(60vh, 680px)`
(`DockFullView.svelte:371`). At 720 px tall, **60vh = 432 CSS px**, and the
captured faceplate is **425 px** (`LEGACY_FOLD_PX`, `_shell-faces.ts:325` — 432
minus the pane's 4 px padding and subpixel rounding). Measured off
`face-cloudseed-dock.png`, the chrome above the bands costs ~130 px and the band
region runs **y ≈ 130 … 425**, i.e. **~295 px**, at a `DOCK_BAND_PX = 90` pitch
(`dock-tabs-model.ts:21-35, 53`).

**So the hero budget is the whole argument, and it is ~295 px total.** The
wavesculpt failure is exactly this arithmetic: a 445 px hero against a ~352 px
box (425 minus grip + title bar + tab rail) leaves **zero** pixels for band
content, so every tab renders the same empty column below the fold and the
tab rail looks broken while being correct.

**This face's budget:**

| | px |
|---|---|
| band region at 1280×720 | **~295** |
| hero — 4×4 pad grid at 36 px/cell + 10 px gaps + a 20 px caption row | **~184** |
| remaining | **~111** |
| `grid` band (label + one row) | ~90 |
| **visible without scrolling** | hero **and** the first band, with ~21 px spare |

The `gate` and `lfo` bands are below the fold and `.faceplate-scroll` is
`overflow:auto`, so they scroll — say so rather than claim they fold. **The hero
is sized 184 px deliberately: `minWidth: 240` on the panel with a 4×4 grid at
36 px cells is the largest square that leaves a band header visible at 720p.**
A 240 px hero (60 px cells, the legacy card's size) would push the first band
header to y ≈ 481 and reproduce wavesculpt.

⚠ **Do NOT promote a second cell into the hero.** `hero.cell` + `hero.control`
is already two rows in a 214 px-wide picture bay (`DOCK_HERO_GLYPH_W`); a third
crosses the budget.

---

## 6. READOUTS — exactly one, and it is a bare value

Under the 2026-08-11 ruling a readout must earn its place as **a value and its
unit, nothing more.** One qualifies.

### `cartesian-gate-ms` → `12.5 ms`

`SCHEDULER_TICK_MS × gateLength × 1000`. At the shipped default, `12.5 ms`.

It earns the slot because **the dial's own readback is wrong about the
quantity.** `gateLength` prints `0.50`, which reads as "half the step" and is
2.5 % of the step at a 2 Hz clock and 10 % at 8 Hz (§3-C). The derived value
prints the number that is actually true and is invariant to the clock, which is
the finding — stated as arithmetic on the panel and as prose in `docs`.

- **NEGATIVE CONTROL (permanent, in `cartesian-face-model.test.ts`):** the
  printed value must NOT move when `lfoDiv`, `lfoShape`, `octave`, `mode` or
  `snh` move. A readout that drifted with any of them would be reading the wrong
  thing.
- **SECOND LEG:** `gateLength` 0.1 → `2.5 ms`, 0.95 → `23.75 ms`, and the ratio
  must be exactly 9.5. Both legs are required: a one-sided test passes on a
  readout that merely echoes the knob ×25.
- **THE ORACLE:** assert `SCHEDULER_TICK_MS` is the multiplier by importing it,
  never by typing 25. When the DSP fix in §3-C lands, this readout becomes wrong
  and the model test must go RED — so pin `gateDur`'s source, not its value.

### Rejected, with the reason

- **`cartesian-lfo-hz`** (`LFO_DEFAULT_RATE_HZ × LFO_DIVISIONS[lfoDiv].mult`).
  **Rejected: it would print a false number whenever `lfo_clock` is patched.**
  The real rate is `lfoMeasuredHz × mult`, and `lfoMeasuredHz` is measured off a
  cable. `FaceReadoutValue` is params-only, so the readout would say `1.00 Hz`
  while the LFO ran at 8. That is the blind-metric trap painted on a faceplate.
- **`cartesian-pads-on`** (how many of the 16 pads are lit; how many carry a
  chord). **Rejected: `node.data.cells` is not params.** This is the single most
  useful bare number the module has — `9 / 16` — and the platform cannot compute
  it.
- **A mode readout** (`FREEFORM` / `CLOCKED`). **Rejected twice over:** it is a
  word, not a value, and the answer is a cable, not a param.

⚠ **THREE of the four rejections are the same platform gap**, and this module is
one of three in this batch that hit it — see §11-C.

---

## 7. THE REAR — 9 holes, and one label that matters

`rear-card-model.ts` renders every declared port, one hole each: **4 input holes
+ 5 output holes = 9**. No stereo pairs, no CV-param holes at all (§1-B), so the
derivation puts all four inputs in the leading voice/signal band and all five
outputs on the OUTPUTS rail — and that is already correct.

One curated group is worth its lines, because the derivation cannot know it:

```ts
rear: {
  groups: [
    { id: 'signal', label: 'cursor',    ports: ['clock', 'x_cv', 'y_cv'] },
    { id: 'lfo',    label: 'lfo clock', ports: ['lfo_clock'] },
  ],
}
```

`lfo_clock` is a `gate`/`trigger` input sitting beside `clock`, and the two do
completely different jobs — one advances the sequencer, one only paces the LFO
(`docs.inputs.lfo_clock` says so; the rear currently does not). Two holes of the
same cable type, adjacent, with opposite effects is exactly the case a rear band
label exists for.

`audioRate`: **nothing ticks.** Every input is read once per ~25 ms scheduler
tick from an `AnalyserNode` ring (`:394-396`, `:294`). Cited per Step 6 of the
recipe.

---

## 8. THE PICTURE

**`cart-pitch-{n}` — the 4×4 pad grid, promoted to `hero.cell`.** Four things
only this can show, all of them pictures rather than sentences:

- **which pad the cursor is on** — `read('currentStep')` off the live handle
  (`playhead.currentAt`), the one genuinely live surface this module has;
- **which pads are lit** and their note names, from `node.data.cells`;
- **the chord badge per pad** (`mono` / `maj` / `min`) — a per-cell control that
  exists on the card and is in NO declared family (§10-D);
- **the cursor's coordinate**, drawn as a column/row highlight rather than
  written out.

`minWidth: 240` (§5). Probe (required, `ShellPanelProbe`):

```ts
'cart-pitch-{n}': {
  kind: 'panel',
  label: 'pads',
  component: CartesianPadGrid,
  minWidth: 240,
  probe: {
    testid: 'cart-chord-panel-5',           // NOT `control-<paramId>` — rule 1
    action: 'click',
    effect: { kind: 'data', key: 'cells[5].chord', expect: 'changed' },
  },
}
```

⚠ **`data`, not `data-rev`.** A revision counter passes on a dead badge. The
chord cycle is the right probe target precisely because it is the affordance
with no param behind it — if the panel is inert, nothing else on this module
would notice.

**Sidebar** — one block, and it is a picture, not prose:

```ts
sidebar: [
  { kind: 'signal-flow', label: 'signal flow', stages: [
    { label: 'CLOCK',  role: 'generator' },
    { label: 'X / Y',  role: 'generator', parallel: true },
    { label: 'CURSOR', role: 'bus' },
    { label: 'PAD',    role: 'bus' },
    { label: 'PITCH',  role: 'bus' },
    { label: 'GATE',   role: 'bus', parallel: true },
    { label: 'LFO',    role: 'generator', parallel: true },
  ] },
]
```

`parallel: true` on `X / Y` and on `LFO` is load-bearing, not decoration: the
X/Y pair is an **alternative** cursor source to the clock (whichever is patched
wins), and the LFO is not in the note path at all. A diagram drawing the LFO
inline would teach that it modulates the pitch, which is the opposite of true.

**No `presets` block.** There is nothing to open: no enabler pairs, and two of
the three switches are broken.

---

## 9. ALREADY-WRONG — ordered by cost to a user

- **A · `mode` is dead** (§3-A). Its own def PR: delete it, or wire it and take
  the owner call on saved racks. **Blocks the face.**
- **B · `snh` is unreachable by 0.05 of `gateLength`'s range** (§3-B). DSP PR,
  same fix as C.
- **C · the gate is a fraction of the SCHEDULER TICK, 2.5–23.75 ms, tempo-
  invariant** (§3-C). DSP PR; changes the sound of saved racks; `macseq` is the
  working reference. Fixing C fixes B for free.
- **D · three per-cell controls, ONE declared family.** The card emits
  `cart-pitch-{id}-{i}`, `cart-gate-{id}-{i}` (inside `NoteEntry`) and
  `cart-chord-{id}-{i}` (`CartesianCard.svelte:224-245`); the def declares only
  `cart-pitch`. `module-face-lint`'s completeness enumerates params + declared
  families + **numbered-legend** statics, and only three legend files exist in
  the whole repo (`e2e/vrt/__annotated__/`: adsr, lfo, sequencer). So the gate
  and chord controls are invisible to CI. Declaring `cart-gate` and `cart-chord`
  is +2 contract-lock lines and +2 `docs.controls` entries and should ride the
  face PR.
- **E · `lfo_clock`'s edge counter is hand-rolled** (§1-B). Correct today;
  convert to `createEdgeCounter` on the next touch.
- **F · an idle cartesian schedules ~1036 AudioParam writes/second** (§2). Gate
  `scheduleLfo` on `lfo_x`/`lfo_y` being connected, or on `lfo_clock` being
  patched. Its own perf PR; measure before and after.
- **G · `CartesianCard.svelte` re-types four ranges as literals**
  (`:251-279` — `min={-2} max={2}`, `min={0.1} max={0.95}`, `min={0}
  max={LFO_DIVISIONS.length - 1}`, `min={0} max={3}`) while importing
  `cartesianDef`, and cartesian is **not** in `card-range-source.test.ts`'s
  allowlist. Bind through `paramSpec()` and enrol in the SAME PR that touches
  the card — the boy-scout precedent every recent face PR followed.
- **H · the X/Y read aliases above ~20 Hz** (§3-F). Documentation, not a fix.

---

## 10. COST

| | |
|---|---|
| **contract-lock** | **+2 lines** if D lands with the face (`cart-gate`, `cart-chord` families); **−1** if the `mode` PR lands first. `face` itself is contract-transparent. |
| **`ACKNOWLEDGED_LATCHING`** | +1 (`cartesian:mode`) — or zero, if `mode` is deleted first. That is a second reason to sequence the def PR ahead. |
| **shared registries** | `strict-faces.ts`, `e2e/vrt/_shell-faces.ts` (`{ type: 'cartesian', pages: 3 }`), `shell-cells.ts` (the pad-grid cell + probe), `face-readout-values.ts` (1 `valueId`), `card-range-source.test.ts` (§9-G), `push-card-config.ts` (see below). |
| **VRT** | +`face-cartesian-{compact,dock}` = **2 baselines**, authored by linux CI — never commit one. ⚠ The existing `vrt.spec.ts/cartesian.png` is in **`STRICT_VRT_MODULES`**, so any card edit (D or G) moves a **required** baseline, not an informational one. |
| **e2e** | +1 `faces-parity` row at **7 cells** ≈ 30 000 + 600×7 = **34.2 s** (45 000 + 1 800×7 = 57.6 s under `SLOW_RENDER`). Well inside the ~2 min flag threshold. |
| **ART** | cartesian has ART coverage of `lfoMorph` via `lfo-divisions.ts`; a face touches none of it, and none of the three DSP PRs above can ride the face PR. |
| **Push 2** | No `PUSH_CARD_CONTROLS` entry, so its 8 push controls are whatever the generic ranker picks over 6 params — and CLAUDE.md's standing warning applies: the §3-A def PR *removing* a param silently re-ranks the card. Give it an explicit entry in whichever PR moves first. |
| **PLATFORM** | **PF-22 (§11-A) blocks rank 1.** Without it the face ships in shape (ii) and is worse than the card. |

---

## 11. THE PLATFORM ITEMS THIS BATCH FOUND

### A · PF-22 — a LANE-SELECTABLE grid cell (blocks all three sequencers)

**The gap:** `ShellCell` has five kinds — `selector`, `action`, `file`,
`toggle`, `panel`. A per-step editor can only be a `panel`, and a panel is
forbidden at every lane tier, so **a step grid's first legal rank is 7**.
Measured across the batch:

| module | cells | grid's best possible rank | legal? |
|---|---|---|---|
| `cartesian` | 6 params + 1 family = **7** | 7 | ✔ by one |
| `macseq` | 5 params + 2 families = **7** | 6 and 7 | ✘ — rank 6 is a lane tier |
| `kria` | 2 params + 1 family = **3** | 3 | ✘ |

And the rank-7 escape is not a fix even where it is legal: a sequencer whose
pattern is invisible at mini/compact/full has no reason to be faced.

**The proposal, in preference order.** (i) A new `ShellGridCell` that renders a
**read-only miniature** at `mini`/`compact`/`full` and the full editor at
`dock`, so the lane tile shows the pattern — which is the one thing a rack of
sequencers needs to be readable at a glance. (ii) Failing that, relax
`panelTierProblems` from *"a panel may not be RANKED above 7"* to *"a panel is
never SELECTED at a lane tier"* — i.e. filter panels out of `curatedFace` at
lane tiers instead of failing the rank. That is the smaller change and it also
retires the wall `meowbox`, `drummergirl` and `noise` each hit from the other
direction (a picture that can never reach rank 7 because the module is too
small).

⚠ **`.myrobots/plans/face-specs-batch-4-drumseqz.md` ranks `drumseqz-pitch-{n}`
at 1 with the note "a `family` key is legal at any rank — the rank-7 rule is for
`panel` CELLS only."** That is true of the LINT and leaves the RENDER
unanswered: an unregistered family key paints `data-cell-control="inert"`
(`ModuleShell.svelte:865`), which `faces-parity` fails. Seven modules are
affected — `sequencer`, `drumseqz`, `polyseqz`, `writeseq`, `macseq`,
`cartesian`, `kria`.

### B · `glyph` is a no-op for every sequencer

`glyphBinding` falls through to `{ kind: 'static' }` for any def with no
`audio`-typed output and no `algorithm`/`envelope`/`shape` param
(`shell-glyph-live.ts:135-171`). All seven sequencers are in that set. Not a
bug — but a face author reading the `glyph` field would reasonably expect it to
do something, and today the only correct value for these modules is `'none'`.
Worth one sentence in `ModuleFace.glyph`'s doc comment.

### C · `FaceReadoutValue` is params-only — the count is now NINE

`(read: (paramId) => number | undefined) => string`. It cannot see `node.data`
and it cannot see patch topology. All three modules in this batch want both:

| module | what it wants | why params cannot answer |
|---|---|---|
| `cartesian` | how many pads are lit / carry a chord | `node.data.cells` |
| `cartesian` | the real LFO rate | `lfoMeasuredHz` is measured off `lfo_clock` |
| `cartesian` | which mode it is in | the answer is whether `clock` is patched |
| `macseq` | how many steps set a model | `node.data.steps` |
| `macseq` | the real gate width | depends on whether `clock` is patched |
| `kria` | anything at all | its entire model is `node.data` |
| `kria` | whether its two params do anything | depends on whether a **`timelorde` NODE EXISTS in the rack** |

The brief records six modules having wanted this widened; **this batch makes it
nine**, and `kria` adds a shape the earlier six did not: not "is this port
patched" but "does a node of type X exist anywhere in the rack". A widened
reader would need `(read, node, graph)`, and the graph arm is what
`kria` needs.
