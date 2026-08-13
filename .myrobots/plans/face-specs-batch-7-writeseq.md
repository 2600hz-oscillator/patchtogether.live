# FACE SPEC — `writeseq` (batch 7)

> **Two owner rulings, 2026-08-11, apply to this file** (verbatim at
> `rings.ts:585-590` and `:645-650`): *"we should prefer almost zero AI authored
> text, and all future faceplate work should reflect that"* and *"lets stop doing
> these and clean up the existing ones, get rid of them. lose the signal flow
> diagrams."* Every proposed `hint` has been **deleted** from §5; its measured
> content is in §3. Do not re-author it. Measurements belong in `docs.controls`
> (the `rings.ts:592-596` precedent), not on the panel. §5b's "a readout is a value
> and a unit" is the same ruling applied to readouts and it stands.

## 0. STATUS

**Authored 2026-08-11 against `main` at `2af79daf`. UNBUILT** — no `face:` block
(`grep -c '^  face:' writeseq.ts` = 0).

**Verdict: PROMOTE.** *"The best-shaped of the three modules in this batch and the
only unambiguous one."* **7 params + 1 control family = 8 cells** — one more than the
FULL lane plate, so the tier ladder does real work; exactly one family, so exactly
one bespoke panel to build; and a panel's first legal rank is 7, which this module
can reach and `noise`/`meowbox`/`drummergirl` could not.

archetype: **the recording step sequencer.** A 128-step / 8-page grid you can either
draw into or PLAY into from a CV+gate source, quantized to the same step the partner
drum sequencer is hitting.

In `STRICT_DOCS` (`strict-docs.ts:193`). In `INTERACTIVE_DOC_MODULES`
(`interactive-doc-modules.ts:161`). In `DOCKABLE_TYPES` (`dockable.ts:34`). **Not** in
`PUSH_CARD_CONTROLS`. In `EXEMPT_FROM_VRT` (`vrt-exemptions.ts:563`) **and**
`ALLOWED_PERMANENT_EXEMPT` (`:985`), so it has **no legacy VRT baseline to move** — a
real cost saving that none of the recent faces had. `rack-sizes.ts:152` — `2u / hp 5`,
261×880 px.

**THE HEADLINE: the module's own docs say `bpm` is "used only when nothing is patched
into CLOCK IN" and that is FALSE. On an external clock the GATE WIDTH is still
computed from the bpm knob, so at the knob's default against a 60 bpm external clock
the gate is 100 % of the step and never falls.**

**Method.** writeseq has no DSP — no `.dsp`, no worklet, no AudioParam (`setParam` is
a documented no-op, `writeseq.ts:870-872`). Its "engine" is plain-JS scheduler code
riding `getSchedulerClock`, so the real shipping engine here is the exported model
layer the factory imports and calls: `quantizeToNearestStep`, `resolveStepVOct`,
`coerceStep(s)`, `STEP_COUNT`, `PAGE_SIZE`. Those were driven directly through `tsx`
from `packages/web/src/lib/audio/modules/writeseq.ts` — the same module the factory
uses, **no mirror**. The two claims that are about SCHEDULING rather than pure
functions (§3-A, §3-B) are **source-level with a worked numeric example**, the
mixmstrs §7-A discipline, because there is no AudioContext in node to render them
against.

⚠ **A pure-function determinism control is VACUOUS and is not claimed.** Two identical
calls to a pure function being equal proves nothing about the code. Where the
discipline applies — §3-A's arithmetic — the control is a **negative control on the
probe**: the reading must MOVE when the one thing it claims to measure moves (§3-A's
ladder does; §3-E's plateau does).

---

## 1. THE CONTRACT — every param and port

### 1a. Params — 7 (`writeseq.ts:252-260`)

| id | label | range | curve | default | card draws |
|---|---|---|---|---|---|
| `bpm` | `BPM` | 30 .. 300 | linear | 120 | **Fader** |
| `length` | `Len` | 1 .. 128 | **discrete** | 16 | **Fader** |
| `octave` | `Oct` | −2 .. 2 | **discrete** | 0 | **Fader** |
| `gateLength` | `Gate` | 0.1 .. 0.95 | linear | 0.5 | **Fader** |
| `isPlaying` | `Play` | 0 .. 1 | **discrete** | 0 | button |
| `recArm` | `Rec` | 0 .. 1 | **discrete** | 0 | button |
| `overdub` | `Ovd` | 0 .. 1 | **discrete** | 0 | button |

**Three of the seven are `0..1 discrete default 0`** — `looksLikeSwitch()`
(`shell-control-kind.ts:94`) sees all three, and none is a press-pad, so all three
need an `ACKNOWLEDGED_LATCHING` entry (`module-face-lint.test.ts:357`). +3 lines in a
shared hand-maintained file.

### 1b. Ports — 10 in, 3 out

- `cv` (pitch), `gate` (gate, `edge: 'gate'`), `clock` (gate, `edge: 'trigger'`),
  `rec` (gate, `edge: 'trigger'`), then the six shared transport CV ports
  (`play_cv` / `reset_cv` / `queue1..4_cv`, all `edge: 'trigger'`).
- Out: `pitch` (pitch), `gate` (gate, `edge: 'gate'`), `clock` (gate,
  `edge: 'trigger'`).
- **No CV input carries a `paramTarget`** — not one of the seven params is
  CV-addressable. That matters for the rear (§7): the derivation's "one band per page
  for that page's CV holes" produces nothing, so every hole is an orphan.

### 1c. Control families — 1

`{ id: 'writeseq-pitch', label: 'Per-step note entry', kind: 'cell',
   testidPrefix: 'writeseq-pitch', countParam: 'length' }`

**8 cells: 7 params + 1 family.** All of `contract-lock.txt:3808-3826` is already
pinned; a `face` adds **zero** contract lines.

⚠ **The card renders a second numbered control the def does not declare.**
`WriteseqCard.svelte:322` emits `gateTestId={writeseq-gate-${id}-${i}}` — a per-step
gate button, one per cell, matching no `controlFamily` and no `docs.controls` key. It
costs the face nothing (there is no numbered legend for writeseq, so
`legendStaticKeys` is empty and completeness never asks about it), but **it is an
undocumented control surface and the panel in §6 must own it.**

---

## 2. AT SPAWN — measured

Driven through the shipping model layer.

| | |
|---|---|
| `STEP_COUNT` / `PAGE_SIZE` | 128 / 16 → **8 pages** |
| `coerceSteps(undefined).length` | 128 |
| default step | `{ on: false, midi: 60 }` (C4) |
| `resolveStepVOct({on,midi:60}, 0)` | **0.0000 V** |
| step duration at the defaults | `60/120/4` = **125.0 ms** |
| loop length at the defaults | 16 × 125 ms = **2.000 s** |
| gate width at the defaults | 0.5 × 125 ms = **62.5 ms** |

Octave is exact V/oct and not a semitone offset: −2 / −1 / 0 / 1 / 2 give
**−2.0000 / −1.0000 / 0.0000 / 1.0000 / 2.0000 V** on C4.

Coercion, measured (`writeseq.ts:150-178`):

| input | result |
|---|---|
| `{}` | `{on:false, midi:60}` — an **absent** `midi` key means C4 |
| `{on:true, midi:null}` | `{on:true, midi:null}` — an **explicit** null is preserved (a rest) |
| `{on:true, midi:200}` | `{on:true, midi:null}` — out of 0..127 falls to null, i.e. **C4 at play time** |
| `{shift: 9}` | `{on:false, midi:60, shift:0.5}` — clamped, **and never read** |

---

## 3. FOUR MEASURED DEFECTS (and one non-defect)

### A · THE GATE WIDTH IS COMPUTED FROM A KNOB THE MODE IGNORES

`processClock`'s EXTERNAL branch takes `stepDurForGate = 60 / bpm / 4` from the
**param** (`writeseq.ts:697-698`) and hands it to `emitStep`, which schedules gate-off
at `atTime + stepDurForGate * gateLengthFrac` (`:651`). The bpm knob is otherwise
unused in that mode. `docs.controls.bpm` (`:295`) says it is *"used only when nothing
is patched into CLOCK IN."*

Measured against an external clock pulsing 16ths at 120 bpm (real step **125.0 ms**),
`GATE` at its default 0.5:

| BPM knob | gate high | as a fraction of the real step |
|---|---|---|
| 30 | 250.0 ms | **200 %** — never falls |
| 60 | 125.0 ms | **100 %** — never falls |
| **120** | 62.5 ms | 50 % (the only setting that means what the knob says) |
| 240 | 31.3 ms | 25 % |
| 300 | 25.0 ms | 20 % |

**Two of the five sampled knob positions produce a gate that never closes.** The next
step's `setValueAtTime(1, …)` and this step's `setValueAtTime(0, …)` land out of
order on the same AudioParam, so what a downstream envelope sees is not "legato" but
an irregular gate whose falls are one step late.

**NEGATIVE CONTROL on the probe** — the reading must move with the one thing it
claims to measure. It does, monotonically, across the whole knob (200 → 100 → 50 → 25
→ 20 %), and it is invariant to `length` and `octave`, which is the correct
invariance.

**A DEF/ENGINE bug, not a face bug, and it must NOT be fixed in a face PR**: the fix
changes the gate width of every rack driving writeseq from TIMELORDE, which is an
audible change and an owner audition. The face's job is to make the number VISIBLE
(§5b) and the def's job is to stop claiming the opposite.

### B · TWO GATE EDGES IN ONE SCHEDULER TICK RECORD ONE STEP

`pollGateEdges()` returns a COUNT (`writeseq.ts:530-537`), and the record branch
consumes it as a boolean:

```js
if (recordingActive && gateEdges > 0) {
  …
  writeStep(recStep, midi);          // ONE write, whatever the count was
}
```
(`writeseq.ts:825-836`)

`SCHEDULER_TICK_MS` is 25 ms, so **any two note-ons closer than ~25 ms record as one
note** — a grace note, a flam, a fast trill, a chord played on a MIDI→CV converter
with per-note gates. **It is silent: nothing warns, and the second note is simply
absent from the pattern.**

The same line carries a second, smaller divergence. `docs.inputs.cv` (`:274`) says the
pitch is *"sampled at each incoming gate edge"*; the code samples `latestSample(cvTap)`
once per TICK (`:758`) and uses that one value for the write. On a monophonic keyboard
where CV leads gate this is almost always right; **it is wrong exactly when it matters
(a fast line).**

### C · THE CLOCK EDGE MATH IS A HAND-ROLLED COPY OF THE SHARED SEAM

`countEdges` (`writeseq.ts:498-515`) re-implements `createEdgeCounter`
(`$lib/audio/edge-detect`) — the module CLAUDE.md names as the single owner of that
window arithmetic, written *"so a consumer CANNOT get it wrong (no `start = 0`
foot-gun)"*. **writeseq's copy is CORRECT** (it windows on `elapsed * sampleRate`, so
there is no double-count), and this is therefore a boy-scout item rather than a
defect — worth stating only because the sibling `clipplayer.ts:40` imports the seam
and writeseq does not. **Three call sites** (`pollRecEdges`, `pollGateEdges`, and the
inline scan in `processClock`) would collapse into it. **A third hand-rolled copy.**

### D · `shift` IS PERSISTED, CLAMPED, SYNCED — AND NEVER READ

`WriteseqStep.shift` is declared FUTURE-ROOM (`writeseq.ts:126-132`), preserved by
`coerceStep`, carried through `writeStep`, and consumed by nothing. Measured:
`coerceStep({shift: 9})` → `0.5`. It also **survives a round-trip through the card's
own write path and is DROPPED by the test hook** — `window.__writeseqSetStep` rebuilds
the array without it (`WriteseqCard.svelte:240`), so a value written by a future
engine would vanish the first time a test touched that step.

### E · THE ROUNDING PLATEAU, WITH ITS FLOOR — the recording law is sound

Stated because §3-A and §3-B are defects and **this one is not**.
`quantizeToNearestStep` (`writeseq.ts:206-218`) has exactly ONE flip across a step,
measured at **62.50 ms** on a 125.0 ms step — `stepDur/2` to the sample. The plateau
on each side is therefore **62.5 ms**, against a **~25 ms** scheduler tick: the
quantiser's decision boundary is **2.5× the sampling interval that feeds it**, so a
press is placed within ±25 ms of where it fell and the rounding can only be wrong for
a press within 25 ms of the exact midpoint. Wrap is correct (anchor 15, length 16,
press at 0.99·step → step **0**) and the degenerate case returns the anchor rather
than dividing by zero (`stepDur 0` → step 4).

---

## 4. THE RANKING — 8 cells, a lane budget of six

Tier caps here: mini 1, compact **3** (this face declares no glyph — see below),
full 6, dock all 8.

| rank | key | tier | why |
|---|---|---|---|
| 1 | `recArm` | mini | the one control that makes this module not the ordinary step sequencer, and the one whose STATE must be legible from across a rack: armed, your next keypress overwrites the pattern. |
| 2 | `overdub` | compact | ranked directly under its arm because it decides whether arming **destroys**: off = one-shot, which CLEARS the pattern (`startRecording`, `writeseq.ts:606-619`); on = layer. |
| 3 | `isPlaying` | compact | |
| 4 | `length` | plate | two jobs in one control: the loop window AND the number of steps a one-shot captures. |
| 5 | `bpm` | plate | |
| 6 | `gateLength` | plate | — *lane budget ends here* — |
| 7 | `octave` | dock | |
| 8 | `writeseq-pitch-{n}` | dock (panel) | the grid — §6. **Rank 8 ≥ 7, so a panel is legal here**, which is the whole reason this module can carry a hero picture. |

**The rule the ranking follows, and the alternative it rejects.** Rank by **WHAT THE
CONTROL DESTROYS**, then by what it shapes. The obvious alternative — the card's own
header order, PLAY / REC / OVD — puts the transport first because that is where a
transport goes on a card. In a ONE-CELL mini tile that is wrong: `isPlaying` is the
control every sequencer in the rack has, so a mini writeseq would be indistinguishable
from a mini macseq, and the one bit a player needs at a glance (**is this thing about
to overwrite my pattern?**) would be invisible at three of four tiers.

The `overdub`-under-`recArm` adjacency is the cofefve enabler rule applied to a
destructive pair: the dependent that decides the arm's semantics is ranked immediately
below it, never in a different band.

⚠ **`glyph: 'none'`, deliberately.** writeseq declares no `audio`-typed output —
`pitch` / `gate` / `clock` are all CV — so `primaryAudioOutPortId`
(`shell-glyph-live.ts:75-77`) resolves nothing and a `meter` or `scope` glyph would
paint a permanently flat trace. **Declaring none buys the compact tier a THIRD cell**
(`faceTierCap('compact', false)` = 3 vs 2), which is exactly the cell `isPlaying`
needs. The only honest live picture on this module is the PLAYHEAD, and that is the
hero panel's job at the dock.

---

## 5. THE LAYOUT — three bands, and what it does at 1280×720

```ts
face: {
  title: 'Sequencer',

  order: [
    // 1-6 = the LANE budget. Destructive first (see §4).
    'recArm', 'overdub', 'isPlaying', 'length', 'bpm', 'gateLength',
    // dock only
    'octave',
    'writeseq-pitch-{n}',      // PANEL, rank 8 — dock-only by rule AND by arithmetic
  ],

  pages: [
    // THREE bands — under the tab-rail threshold, so this is one scrolling column
    // and every band is visible together, which a sequencer needs (you set LEN
    // against the grid, not in a different tab).
    { id: 'record',  label: 'record',  controls: ['recArm', 'overdub', 'isPlaying'] },
    { id: 'pattern', label: 'pattern', controls: ['length', 'octave', 'writeseq-pitch-{n}'] },
    { id: 'clock',   label: 'clock',   controls: ['bpm', 'gateLength'] },
  ],

  glyph: 'none',

  paramCells: {
    bpm: 'fader',
    gateLength: 'fader',
    // length + octave CANNOT be declared here — see the warning below.
  },

  hero: {
    cell: 'writeseq-pitch-{n}',
    readouts: [
      { label: 'steps', paramId: 'length' },
      { label: 'loop',  valueId: 'writeseq-loop-s' },
      { label: 'gate',  valueId: 'writeseq-gate-ms' },
    ],
  },

  rear: { /* §7 */ },
}
```

**Cell arithmetic:** 7 params + 1 family = **8 cells**, each key once. `heroFacePlan`
promotes `writeseq-pitch-{n}` out of the `pattern` band, leaving it with `length` +
`octave` — **no band empties**, so the roster row is
`{ type: 'writeseq', pages: 3 }`.

**No `hero.control`.** A hero with a picture and readouts and no promoted dial is
legal (`dock-faceplate-model.ts` renders the stage on `cell || control || action`),
and it is the right shape here: promoting `length` would strip the `pattern` band down
to one cell — a labelled void beside a picture.

⚠ With three bands the face is nowhere near the tab-rail threshold, so it never
becomes a rail and the wavesculpt fold failure is structurally unavailable to it.

### ⚠ TWO OF THE CARD'S FOUR FADERS CANNOT BE REPRODUCED, BY RULE

`WriteseqCard.svelte:331-336` draws **four** `<Fader>`s. The `fader` cell kind landed
on main in #1464 for exactly this class of divergence — but `module-face-lint`'s
clause refuses it on a discrete param:

> *"a throw needs a CONTINUOUS param. A discrete roster belongs on a segmented row, a
> selector or a grid, all of which NAME their states; a fader would show them as
> unlabelled detents on a scale."*
> (`module-face-lint.test.ts:593-606`)

`length` is `1..128 discrete` and `octave` is `−2..2 discrete`, so **the face can
declare `fader` for `bpm` and `gateLength` and must render `length` and `octave` as
knobs**, where the card draws throws. **writeseq is the FIRST consumer of the kind
after `noise` and the first to hit its restriction.**

State it, do not fight it. The clause's rationale — a slider over three named states
is unreadable — is right about `octave` (five detents) and arguably wrong about
`length` (128 steps is a scale, not a roster). If the owner wants `length`'s throw
back, that is a one-clause platform change ("discrete is allowed above N steps") with
its own PR and its own negative control, **not a face-batch edit**.

### ⚠ THE ROW PLAN CLASSIFIES A FADER AS *WIDE*, AND NOTHING HAS EXERCISED IT

`cellWidthClass` (`dock-row-plan.ts:120-140`) enumerates the narrow kinds —
`knob | toggle | momentary | color` — and returns `'wide'` for everything else by
deny-by-default. **`fader` is not in the list**, so a band containing one is SOLO and
never packs with its neighbour. But `ModuleShell.svelte:714` renders it as a bare
`.kcol ms-cell-fader` with **no width rule anywhere in the file** — it is physically a
knob column. `dock-row-plan.test.ts` contains the string `fader` **zero times**, and
`noise` — the only face that declares the kind — ships `pages: 0`, so **no dock band
has ever held one.**

Consequence for this layout, stated both ways because a browser cannot be measured
from here:

| if `fader` classifies… | rows | band height |
|---|---|---|
| **`'wide'` (today's code)** | `[record + pattern]` (5 cells ≤ 10), `[clock]` | 2 × 90 = **180 px** |
| `'column'` (what it renders as) | `[record + pattern + clock]` (7 cells ≤ 10) | 1 × 90 = **90 px** |

**Budget at 1280×720.** `DockFullView.svelte:371` caps the pane at
`max-height: min(60vh, 680px)` → **432 px** at that viewport, and the measured
`.faceplate-scroll` scrollport is **~352 px** (`ClipplayerCard.svelte:630` and
`clipplayer-grid-stability.spec.ts:14`, both citing the same live measurement). The
hero picture is budgeted at **104 px of plot** — the house height every shipped hero
panel uses (`CloudsRingPanel` 104, `BlueboxToneBankPanel` 104, `ClapHeroPanel` 104) —
plus its caption and the readout strip, call it **~150 px**. So:

- worst case (fader = wide): 150 + 180 = **330 px** against 352 → **everything is
  above the fold**;
- best case: 150 + 90 = **240 px**.

**That is the check wavesculpt skipped**: its hero was **445 px against the same
352 px box**, so band content rendered entirely below the fold and all eight tabs of
its rail looked identical. **This face must not exceed ~150 px of hero, and the panel
in §6 is specified at 104 px of grid for that reason, not for taste.**

---

## 5b. THE THREE READOUTS — bare values, no sentences

**Owner ruling 2026-08-11: a readout is a value and a unit.** All three below are pure
functions of the live params, which is what makes them registerable.

| valueId | prints at the defaults | what it is |
|---|---|---|
| — (`paramId: 'length'`) | `16` | the loop window, straight from the param |
| `writeseq-loop-s` | `2.00 s` | `length × 60/bpm/4` |
| `writeseq-gate-ms` | `62.5 ms` | `gateLength × 60/bpm/4 × 1000` |

`writeseq-loop-s` is the number eight pages of grid cannot show: **at `length` 128 and
`bpm` 30 it reads 64.00 s**, and nothing anywhere says the loop is a minute long.

`writeseq-gate-ms` is the §3-A readout. **It is correct in BOTH clock modes** — the
engine really does compute the gate from this knob on an external clock — **which is
precisely what makes it diagnostic: a player on a 60 bpm external clock sees `62.5 ms`
printed against a 250 ms step and the number is the bug.**

**NEGATIVE CONTROL, both directions, for each** (a permanent leg in
`writeseq-face-model.test.ts`, calling the SAME predicate the readout calls — never a
re-typed copy, which is how the last one went blind):

- `writeseq-loop-s` must move when `length` moves (16→32 doubles it) **and** when
  `bpm` moves (120→60 doubles it), and must NOT move for `octave` or `gateLength`. A
  readout that only tracked `length` would pass a one-sided test while being blind to
  the tempo, which is half of what a loop length is.
- `writeseq-gate-ms` must move with `gateLength` **and** with `bpm`, and must not move
  with `length`.

⚠ **`FaceReadoutValue` is params-only and cannot see patch topology**, so neither
readout can say *"an external clock is patched and this number is not tracking it"* —
the one sentence that would close §3-A on the panel. **That is the sixth module to
want the seam widened**; it is named here and not worked around.

---

## 6. THE PICTURE — `writeseq-pitch-{n}`, the one panel

A `ShellPanelCell`, `minWidth: 680`, promoted into the hero. It is the module's one
bespoke surface and **it must be good enough to REPLACE the card in the dock**, because
promotion does exactly that (`DockFullView` switches on `migrated(type)`).

What it draws, at 104 px:

- **one page of 16 steps**, in the card's own order, each cell a gate square above a
  note name — the two affordances `WriteseqCard.svelte:314-326` already binds
  (`writeseq-gate-{id}-{i}` and `writeseq-pitch-{id}-{i}`);
- the **playhead** on the sounding step, from `read('currentStep')` (the engine
  already exposes it, `writeseq.ts:879`);
- cells past `length` **dimmed**, the card's own `dim={i >= length}` rule (`:320`) —
  which is what makes the `length` knob in the band beneath it legible without a
  caption;
- the **page nav**, 8 pages, **local component state — never `node.data`**. A page is
  a private authoring lens, and syncing it would scroll a collaborator's grid (the
  `pickingScale` precedent, `ClipplayerCard.svelte:1087`).

No caption sentence and no explanatory text: the grid is the picture, the step numbers
identify it, and the note names are values.

**Probe (required).** A `data` probe, not `data-rev` and not `text`: the gate square
writes a real value, so name it.

```ts
'writeseq-pitch-{n}': {
  kind: 'panel', label: 'steps', component: WriteseqStepPanel, minWidth: 680,
  probe: { testid: 'writeseq-panel-gate-0', action: 'click',
           effect: { kind: 'data', key: 'steps[0].on', expect: 'changed' } },
},
```

⚠ **The panel must never emit `data-testid="control-<paramId>"`** — faces-parity
asserts exact multiset equality against the def's seven param ids, so a `control-`
testid inside the grid reads as an eighth control with no def backing and fails the
whole face (`shell-cells.ts` rule 1).

---

## 7. THE REAR — 13 holes, all of them orphans under derivation

`rear-card-model.ts` renders every declared port, one hole each: **10 in + 3 out =
13**. Nothing collapses (no `stereoPairs`).

**The derivation is degenerate for this module and that is the reason to curate it.**
The default rear puts CV holes into the band of the PAGE whose params they target —
and writeseq declares **zero** `paramTarget`s, so all ten inputs land in the orphan-CV
band beside each other: the pitch input a keyboard plugs into sits in the same
undifferentiated rail as `queue3_cv`.

```ts
rear: {
  groups: [
    { id: 'play',      label: 'play in',   ports: ['cv', 'gate'] },
    { id: 'record',    label: 'record',    ports: ['rec'] },
    { id: 'clock',     label: 'clock',     ports: ['clock'] },
    { id: 'transport', label: 'transport', ports: ['play_cv', 'reset_cv'] },
  ],
  clusters: [
    { group: 'transport', label: 'slots', ports: ['queue1_cv','queue2_cv','queue3_cv','queue4_cv'] },
  ],
}
```

⚠ Two lint clauses apply and both must be checked before this ships: *"every curated
rear GROUP claims the leading slot or names a real page"*
(`module-face-lint.test.ts:1002`) — `play` takes the leading slot and the other three
are NOT page ids, so they need to be pages or the leading group; and *"no rear band
LABEL prefixes another on the same card"* (`:1053`) — `clock` against `clock in` would
trip it. **The exact group set above is a proposal to be run against the gate, not a
verified one.**

⚠ **Four `queue*_cv` ports for EIGHT quicksave slots.** `QuicksaveControls` renders
`SLOT_KEYS = ['1'..'8']` (`transport-helpers.ts:34`) and the shared transport spread
declares four queue inputs. **Slots 5–8 are reachable from the card and from nothing
else.** Pre-existing, shared with every module using that spread, not a face concern —
but the rear is where a player discovers it, so the band label should not imply
otherwise.

---

## 8. ALREADY-WRONG — ordered by cost to a user

- **A · the gate width follows the BPM knob on an external clock, and the docs say the
  opposite** (§3-A). **Two of five sampled knob positions produce a gate that never
  closes.** Its own PR, owner audition — it changes audible gate timing on every
  externally-clocked rack.
- **B · two gate edges inside one 25 ms tick record ONE step** (§3-B), silently. Its
  own PR; **the fix is to loop the write over `gateEdges`, which needs a per-edge CV
  sample and therefore a real design decision.**
- **C · `docs.inputs.cv` says the pitch is sampled at the gate edge**; it is sampled
  once per tick (§3-B). A prose fix, free, and it should ride the face PR since a face
  PR already touches the def.
- **D · `WriteseqCard.svelte` re-types four ranges the def declares** (`:332-335`) and
  **re-types the four defaults twice more** (`:59-62`, `:167-170`), while importing
  nothing from the def. It is in **NEITHER `RANGE_BOUND_CARDS` nor
  `MAPPING_BOUND_CARDS`**, so no gate sees it. Bind through `paramSpec()` and enrol
  both, in the SAME PR that touches the card.
- **E · `PAGE_SIZE` exists in THREE copies.** `WriteseqCard.svelte:420`
  (`grid-template-columns: repeat(16, 1fr)`), `SequencerPageNav.svelte:16`
  (`export const PAGE_SIZE = 16`, plus `maxPages = 8` at `:42`) and
  `sequencer-pages.ts:23` — the one that should be imported. **Changing `PAGE_SIZE`
  breaks the grid silently.**
- **F · a slot-count contradiction.** `WriteseqCard.svelte:11` and `:156` say "8-slot"
  while `packages/web/src/lib/ui/QuicksaveControls.svelte:2` says "1-4 slot buttons";
  the render is 8. One of the two comments is wrong whichever way you read it.
- **G · `shift` is dead persisted state** (§3-D), and the test hook drops it.
- **H · a THIRD hand-rolled copy of `createEdgeCounter`** (§3-C). Correct today;
  collapse it when the file is next open.
- **I · `writeseq-gate-{id}-{i}` is an undeclared numbered control** (§1c).

**THE TRIAGE, verbatim — this is the scheduling answer:**
> *"None of A, B or G belongs in the face PR. C, D, E, F, H and I do."*

---

## 9. COST

| | |
|---|---|
| **contract-lock** | **+0 lines.** No new params, no new families; `face` is contract-transparent. |
| **`ACKNOWLEDGED_LATCHING`** | **+3** (`writeseq:isPlaying`, `writeseq:recArm`, `writeseq:overdub`), each with its own `why`. |
| **shared registries** | `strict-faces.ts`, `e2e/vrt/_shell-faces.ts` (`{ type: 'writeseq', pages: 3 }`), `shell-cells.ts` (one panel + its probe), `face-readout-values.ts` (2 valueIds), `card-range-source.test.ts` (§8-D). |
| **new source** | `WriteseqStepPanel.svelte` + `writeseq-face-model.ts` / `.test.ts` (the two derived numbers and their four-legged negative control). |
| **VRT** | +`face-writeseq-{compact,dock}` = **2 baselines**, authored by linux CI — never commit one (#1458). ⚠ **No existing baseline moves**: writeseq is in `EXEMPT_FROM_VRT` + `ALLOWED_PERMANENT_EXEMPT`, so there is no legacy card PNG to disturb. **Do NOT drain those entries as part of this PR** — they cover the legacy card, which this face does not change. |
| **e2e** | +1 `faces-parity` row at **8 cells** = 30 000 + 600×8 = **34.8 s** (59.4 s under `SLOW_RENDER`). ⚠ writeseq's existing e2e is **four tests** and touches neither the page nav, the quicksave, the faders nor the `writeseq-pitch-*` inputs — **the panel's affordances are effectively untested today, so the panel needs a bespoke spec of its own, not just the parity row.** Well under 2 min. |
| **ART** | none. writeseq has no scenario directory and no baselines. |
| **Push 2** | no `PUSH_CARD_CONTROLS` entry, so its eight push controls are whatever the generic ranker picks over seven params — stable today, but it will silently re-rank the day an eighth param is added. Give it an explicit entry in the same PR. |
| **the bottom line** | The cheapest promotion available and the one with the clearest shape: one panel, three bands, two derived numbers, zero contract lines, no baseline movement. Its argument is not curation — a step sequencer's controls are self-explanatory, which is the owner's own point — it is that **the gate width silently follows a knob the mode claims to ignore, a fast pair of notes records as one, and the loop can be a minute long with nothing saying so.** |
