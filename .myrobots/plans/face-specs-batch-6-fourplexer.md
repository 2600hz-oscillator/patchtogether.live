# FACE SPEC — `fourplexer` (batch 6)

## 0. STATUS

**Authored 2026-08-11 against `main` (`2af79daf`).** Nothing here is
implemented. Every number was measured against the **REAL shipping worklet** —
`packages/dsp/src/fourplexer.ts` captured through a `registerProcessor` shim and
pumped in 128-sample blocks at 48 kHz, with the host's `postMessage` round-trip
simulated where it matters — or read at file:line.

**Verdict: PROMOTE.** archetype: **the router.** Four independent one-of-four
switches, each with its own clock. It is the largest contract in the batch
(**17 contract-lock lines**, 8 in / 4 out) and the only one whose control count
(4) is unremarkable.

**Three headlines, all measured, and the third is a P1-shaped question for the
owner.**

1. **The def says it never blends. It blends for 3.979 ms on every switch.**
   `docs.explanation` (contract-locked prose): *"it is a hard switch, never a
   blend or mix."* *Measured*, flipping OUT 1 from a `+1` input to a `−1` input
   produces **191 distinct intermediate values over 191 samples = 3.979 ms**,
   passing through exactly `0.000000` at the midpoint. The declick is
   intentional and correct (`DECLICK_S = 0.004`); the def's own prose is the
   thing that is wrong. `module-manifest.ts`'s `DESCRIPTIONS` entry gets it
   right — **two prose sources, one of them contract-locked, disagree.**
2. **Its gate threshold disagrees with the shared seam, at exactly the canonical
   value.** fourplexer tests `g > 0.5`; `$lib/audio/gate-trigger`'s `GATE_HI` is
   `0.5` and every other consumer tests `>=`. *Measured*: a gate peaking at
   **exactly 0.5** produces **0 advances** here and **4 triggers** on
   `gatemaiden`. fourplexer neither imports the constant nor mirrors it by value
   — it is a bare `0.5` literal in two comparisons.
3. **A gate advance writes the Y.Doc, and the gate ports accept audio.**
   *Measured* `postMessage` rate = the rising-edge rate of whatever is patched:
   **8/s** for a musical clock, **30/s** for an LFO, **440/s** for a 440 Hz saw,
   **2000/s** for a 2 kHz sine. Each one becomes
   `livePatch.nodes[id].params[key] = idx` → a Yjs transaction → a reconciler
   pass → `engine.setParam`. The def's own docs say audio routes identically
   through this module, so an audio cable into a gate input is a documented use.

Not in `STRICT_FACES`; no `face:` block. In `STRICT_DOCS`
(`strict-docs.ts:147`). **VRT-EXEMPT** — no baseline at all
(`vrt-exemptions.ts:824, 996`). No `PUSH_CARD_CONTROLS` entry. Carries a
`card: 'FourPlexerCard'` override. **4 params, 8 in, 4 out.**

---

## 1. EVERY PORT AND PARAM, FROM THE DEF

`packages/web/src/lib/audio/modules/fourplexer.ts`

### Ports — 8 in, 4 out

| dir | ids | cable | `edge` | what it is |
|---|---|---|---|---|
| in | `in1` `in2` `in3` `in4` | `cv` | — | the four signal inputs. Declared `cv` deliberately: the def's header explains there is no single cable type the patch-to cascade accepts from BOTH an audio and a cv source, so it picks the lowest common denominator and relies on the engine routing audio identically (`fourplexer.ts:11-18`). |
| in | `gate1` `gate2` `gate3` `gate4` | `gate` | **`trigger`** | per-output advance. Rising edge steps THAT output's selector 1→2→3→4→1. |
| out | `out1` `out2` `out3` `out4` | `cv` | — | each carries exactly one input. |

### Params

| id | label | range | curve | default | measured |
|---|---|---|---|---|---|
| `sel1` | `OUT 1` | 0..3 | `discrete` | **0** | the four defaults make a straight-through router — *measured* out1..4 = in1..4 exactly. |
| `sel2` | `OUT 2` | 0..3 | `discrete` | **1** | |
| `sel3` | `OUT 3` | 0..3 | `discrete` | **2** | |
| `sel4` | `OUT 4` | 0..3 | `discrete` | **3** | |

The UI shows them 1-based; the param is 0-based (`FourPlexerCard.svelte:31,54-56`).

### DSP constants

`DECLICK_S = 0.004` (`packages/dsp/src/fourplexer.ts:57`) →
`fadeStep = (1/sampleRate)/DECLICK_S`, i.e. **192 samples at 48 kHz**.
Edge test: `g > 0.5 && prevGate <= 0.5` (`:187`) — see §5.

---

## 2. MEASURED — the real worklet, 48 kHz

**Determinism control:** two identical renders, `max|Δ| = 0.00e+0` across all
four outputs, and the same message count (4 vs 4).

### A. THE DECLICK — 3.979 ms of genuine blend, on every switch

Flipping `sel1` from `in1` (DC **+1**) to `in2` (DC **−1**):

| | measured |
|---|---|
| crossfade length | **191 samples = 3.979 ms** (declared `DECLICK_S` = 192 smp) |
| distinct intermediate values | **191** |
| value at the fade midpoint | **0.000000** — a true 50/50 blend |
| worst intermediate magnitude | 0.989583 |

This is the right DSP. It is also flatly contradicted by the def's own
`docs.explanation`, which is in `STRICT_DOCS` and therefore gated for
*completeness* but not for *truth*.

**For a PITCH router the blend is a portamento.** Switching between a 0 V input
and a 1 V input (one octave): **191 intermediate voltages over 4.00 ms** — a
4 ms glissando through the whole octave, every switch, on a port family that
includes `pitch`. Downstream of a quantizer it is inaudible; straight into a
VCO's V/oct it is a very short slide. Correct behaviour for audio, a surprise for
CV, and the faceplate is the only place that can say which one you are getting.

### B. GATE ADVANCE — and the host round-trip that makes it persist

Six pulses into `gate1`: out1 visits **in1 → in2 → in3 → in4 → in1 → in2 → in3**,
wrapping at 4, and posts **6** `{type:'sel', out, idx}` messages. The factory
writes each back into `livePatch.nodes[id].params[`sel${n}`]`
(`fourplexer.ts:129-137`, marked `guard:allow-raw-write`), the reconciler diffs
`node.params` and calls `engine.setParam`, and the worklet's `lastParam`
observed-delta logic absorbs the returning value without reverting the advance
(`fourplexer.ts` DSP `:170-176`). *Measured with the round-trip simulated: the
selector sequence is identical, and no advance is reverted.* **The design works.**

⚠ **It works only while the round-trip completes.** *Measured*, with one advance
and NO writeback, a user then setting the knob to position 1 and then to
position 2 changes nothing at all — out1 stays on `in2` (0.20) through both
writes. The mechanism: `lastParam` still holds the pre-advance value, so writing
that value produces no observed delta, and writing the advanced value produces a
`setSelection` to the index the worklet is already on. **Two of the four knob
positions are dead until the store catches up.** The window is one Yjs
transaction plus one reconciler pass — short, and non-zero, and it is the reason
the round-trip is load-bearing rather than a nicety.

### C. ONE CLOCK INTO ALL FOUR GATES = a lock-step rotation

| pulses | routing |
|---|---|
| 0 | in1 / in2 / in3 / in4 |
| 2 | **in3 / in4 / in1 / in2** |
| 4 | in1 / in2 / in3 / in4 (back to the default) |

**16 postMessages for 4 pulses** (4 outputs × 4 edges). This is the module's
best trick and nothing on the card suggests it exists.

### D. THE WRITE STORM

`postMessage` per second = the rising-edge rate of the gate input:

| gate input | messages / s |
|---|---|
| musical clock, 8 Hz | 8 |
| LFO, 30 Hz sine ±1 | 30 |
| **AUDIO, 440 Hz saw** | **440** |
| **AUDIO, 2 kHz sine** | **2000** |

Every message that changes the index is a Y.Doc write, and the selector advances
on a 4-cycle so **every** message changes it. On a shared rackspace that is 2000
synced param writes per second per output, plus 2000 reconciler passes, from one
cable. The `cv-modulation-live-store-write-storm` memory is the same failure
class; the difference is that this one is reachable through a documented use of a
documented port.

**This is NOT a face-PR fix** (it wants coalescing — post at most once per
render quantum, or debounce the store write and let the worklet stay
authoritative between). It IS something the faceplate can warn about, because
the rate is a property of the patch and the panel is where a user looks.

### E. AN UNPATCHED INPUT IS SILENCE, AND THE ROUTER WILL ROTATE ONTO IT

With only `in1` patched (DC 0.80) and `gate1` advancing four times, *measured*
out1 over time: **0.80 → 0.00 → 0.00 → 0.00 → 0.80**.

**Three of the four selector positions carry nothing, and no control on the
module says so.** A clocked router on a half-patched rack is silent 75 % of the
time and looks like it is working. This is the module's `hero` fact and — like
sampleHold's mode — it is patch state, so a `readouts` block cannot reach it
(§6-A).

---

## 3. THE RANKING — and it is a LAYOUT ranking, on purpose

| rank | key | tier | why |
|---|---|---|---|
| 1 | `sel1` | mini | |
| 2 | `sel2` | compact | |
| 3 | `sel3` | compact (no glyph) | |
| 4 | `sel4` | full | |

**The four selectors are INTERCHANGEABLE. `face.order` is a PRIORITY ranking, and
a router's four outputs have no priority — so this face does not invent one.**
It ranks by LAYOUT, in the order the outputs are printed, exactly as `bluebox`
ranks twelve keypad buttons by the order a telephone prints them
(`strict-faces.ts:136-154`). The property that buys is the same: **every prefix
of the ranking is still a coherent router.** The 3-cell compact tile is a 3-way
switch; the 2-cell tile is a 2-way switch. A ranking by "which output is most
used" would be a guess, would be wrong on most patches, and would make the
compact tile an arbitrary pair.

⚠ **`glyph: 'none'` is what makes the compact tile 3 cells rather than 2.**
`faceTierCap('compact', hasGlyph)` returns `LANE_ROW_MAX_CELLS_WITH_GLYPH` when a
glyph is declared. Since the glyph would be a canned trace anyway (§6-C),
dropping it is free and buys a third selector.

**Where 4 params sits:** `adsr`, `qbrt`, `ringback` and `meowbox` are all 4-param
faces already in `STRICT_FACES`. Unremarkable.

---

## 4. THE FACE

```ts
face: {
  title: 'Router',
  hint:
    'Four one-of-four switches, each with its own clock. Every output carries exactly one input — ' +
    'with a 4 ms declick crossfade on the switch, which is a portamento if you are routing pitch.',

  // LAYOUT ORDER, not priority — four interchangeable outputs (see §3). Every
  // prefix of this list is still a working router.
  order: ['sel1', 'sel2', 'sel3', 'sel4'],

  // ONE band. Four bands (one per output) would cost ~81 px of dock height each
  // to say four times what the cells already say, and four ROWS of one cell is
  // the layout PF-21's row packing exists to avoid. Four selectors is one idea.
  pages: [
    {
      id: 'routing',
      label: 'routing',
      hint:
        'each knob picks the ONE input its output carries; the matching GATE input advances it ' +
        '1→2→3→4→1. One clock into all four gates rotates the whole matrix.',
      controls: ['sel1', 'sel2', 'sel3', 'sel4'],
    },
  ],

  // ⚠ 'none', DELIBERATELY, and it also buys a 3-cell compact tile (§3).
  // fourplexer has NO audio-typed output (all four are `cv`), so `glyphBinding`
  // cannot resolve a live analyser tap and falls through to
  // `{ kind: 'static' }` — a canned decaying burst from ModuleShell's
  // BURST_TRACE. 26 of the 28 modules in STRICT_FACES have an audio output; the
  // two that do not (adsr, lfo) land on a PARAM-DERIVED branch. No shipped face
  // has ever rendered `static`. See the gatemaiden spec §7-A.
  glyph: 'none',

  // ⚠ NO `control:` — promoting one selector into the hero would assert a
  // priority §3 argues does not exist. The hero is the three numbers no cell
  // can print. (Verify module-face-lint accepts a hero with readouts and no
  // `cell`/`control`; every field on ModuleFaceHero is optional, but no shipped
  // face has used that shape.)
  hero: {
    readouts: [
      { label: 'inputs used',  valueId: 'fourplexer-inputs-used' },
      { label: 'idle',         valueId: 'fourplexer-idle' },
      { label: 'shared',       valueId: 'fourplexer-shared' },
    ],
  },

  sidebar: [
    // THE PICTURE, and the one surface that can see the CABLES. A `custom`
    // block, not a `hero.cell` — module-face-lint refuses a PANEL cell selected
    // at a lane tier and the 'full' lane cap is SIX, so a panel's first legal
    // rank is 7 and four rankable keys can never reach it (the meowbox
    // precedent, stated in sidebar-panels.ts). A sidebar panel imports
    // `$lib/graph/store` itself, so it CAN read `patch.edges` — see §6-A.
    { kind: 'custom', label: 'the matrix', panelId: 'router-matrix',
      props: { selPrefix: 'sel', inPrefix: 'in', gatePrefix: 'gate', width: 4 } },

    { kind: 'readouts', label: 'what this routing does', entries: [
      { label: 'inputs used', valueId: 'fourplexer-inputs-used' },
      { label: 'idle inputs', valueId: 'fourplexer-idle' },
      { label: 'shared',      valueId: 'fourplexer-shared' },
      { label: 'switch',      text: '4 ms declick crossfade — a portamento on pitch CV' },
      { label: 'gate floor',  text: 'this module needs a gate ABOVE 0.5; exactly 0.5 does nothing' },
    ] },

    { kind: 'presets', label: 'three routings', entries: [
      { id: 'thru',    label: 'straight through', note: '4 of 4 used',
        values: { sel1: 0, sel2: 1, sel3: 2, sel4: 3 } },
      { id: 'fan',     label: 'fan out IN 1',     note: '1 of 4 used',
        values: { sel1: 0, sel2: 0, sel3: 0, sel4: 0 } },
      { id: 'reverse', label: 'reverse',          note: '4 of 4 used',
        values: { sel1: 3, sel2: 2, sel3: 1, sel4: 0 } },
    ] },
  ],
}
```

⚠ **`title`, `hint` and the band `hint` paint NOTHING at rest** —
annotation-gated (`dock-faceplate-model.ts`, owner decision 2026-08-03; cofefve's
build confirmed band hints go the same way). Load-bearing content is in the hero
readouts, the sidebar readouts block, and the picture.

⚠ **The three presets are a negative control you can click.** `straight through`
and `reverse` are different routings with **identical** readouts (4 used, 0 idle,
none shared) — so a readout that echoed the dials would move between them and
the derived one must not. `fan out IN 1` moves all three. That is exactly §5's
assertion, made demonstrable in the UI.

---

## 5. THE THRESHOLD DISAGREEMENT — measured, and it is a seam violation

`packages/dsp/src/fourplexer.ts:187` — `if (g > 0.5 && this.prevGate[o]! <= 0.5)`.

Every other consumer in the repo tests `>=` against `GATE_HI`:

| module | test | at a gate peaking at **exactly 0.5** |
|---|---|---|
| `gatemaiden` | `input >= GATE_HI` (`gatemaiden-dsp.ts:76`) | **4 triggers** (measured) |
| `sampleHold` | `g >= GATE_THRESHOLD && prevGate < …` (`sample-hold.ts`) | latches |
| **`fourplexer`** | **`g > 0.5`** | **0 advances** (measured) |

*Measured sweep:*

| gate peak | advances |
|---|---|
| 0.4 | 0 |
| **0.5** | **0** |
| 0.5000001 | 3 |
| 0.51 | 3 |
| 1.0 | 3 |

**Is 0.5 reachable?** Not from `fireTrigger` (its triangle is sampled at
`(i+0.5)/240`, which never lands on 0.5 exactly) and not from `openGate` (which
writes 1.0). It IS reachable from a `ConstantSource` at 0.5, an attenuated gate
through a VCA at half gain, an LFO at exactly ±0.5 depth, or any sequencer that
emits half-scale gates. The practical risk is low; the **maintenance** risk is
not, because the number is a bare literal in a file that never mentions
`GATE_HI`, so nothing connects it to the seam if the seam ever moves.

⚠ **`gatemaiden`'s DSP lib shows the disciplined form** for the same
cross-package constraint: it re-declares `GATE_HI = 0.5` and `TRIGGER_PULSE_S`
with a comment saying *"Mirrors GATE_HI in the web-side $lib/audio/gate-trigger
(kept in lockstep by value — packages can't import across the web/dsp
boundary)"* (`gatemaiden-dsp.ts:24-33`). fourplexer should do the same, and use
`>=`. **That IS an audio change** (a gate at exactly 0.5 starts advancing), so it
re-pins `art/baselines/fourplexer/out1.f32` if the driver ever produces a
0.5 sample — check before assuming — and it is an owner-visible behaviour change.
Its own PR.

---

## 6. WHAT THE FACE PLATFORM CANNOT DO HERE

### A. THE CABLES ARE THE INTERESTING PART, AND `readouts` IS PARAMS-ONLY

`FaceReadoutValue` is `(read: (paramId) => number | undefined) => string`
(`face-readout-values.ts:149`); `ModuleShell.readoutValue` is
`params.paramVal(pid)` (`ModuleShell.svelte:411-414`). No `patch.edges`, no
engine, no ports.

So the three facts a router most wants to state — **which inputs have a cable**,
**which gates have a clock**, and therefore **which selector positions are
silent** (§2-E, measured `0.80 → 0.00 → 0.00 → 0.00`) — cannot be a
`FaceReadout`. The `custom` sidebar panel CAN read them (`FilterResponsePanel`
and `MeowboxFormantBankPanel` both import `$lib/graph/store` directly), which is
why the matrix picture is doing the real work here and the three hero readouts
are the params-only subset.

⚠ **All three batch-6 modules hit this same wall on their single best fact.**
Filed once, in the sample-hold spec §6-A, as the batch's one platform ask:
widen the reader to `{ read, edges, sampleRate }`. It is also the third
independent request for a widened reader (analogVco and macrooscillator asked for
`sampleRate` and played pitch).

### B. A PANEL'S FIRST LEGAL RANK IS 7

`panelTierProblems` refuses a PANEL cell at a lane tier; `'full'` caps at
`LANE_PLATE_MAX_CELLS = 6`. Four rankable keys cannot reach 7. `custom` sidebar
blocks carry no rank.

### C. NO LIVE GLYPH, AND NO `fader` CELL KIND

No audio-typed output → `glyphBinding` returns `{ kind: 'static' }` → a canned
`BURST_TRACE`. See the gatemaiden spec §7-A for the roster measurement (26 of 28
faced modules have an audio output; the other two are param-derived).

And `ParamCellKind` is `knob | momentary | toggle | segmented | selector | grid |
color` (`shell-control-kind.ts:33-40`) — **there is no `'fader'` kind.** Not a
constraint for fourplexer (its card uses `<Knob>`), recorded because the batch
brief assumed one exists.

---

## 7. THE ONE CHEAP FIX THAT CHANGES THE WHOLE PANEL — `ParamDef.options`

Each selector is `0..3 discrete` with no roster, so `paramCellKind` returns
`'knob'`: a **four-state dial**, which is the worst primitive for a four-state
choice and is why the card had to hand-roll a `← IN n` readout under every one
(`FourPlexerCard.svelte:77-79`).

Declare `options: [{value:0,label:'IN 1'}, … {value:3,label:'IN 4'}]` on all
four. 4 ≤ `SEGMENTED_MAX_OPTIONS` (6), so the dock paints **four `<Segmented>`
rows of four named buttons** — every routing one click away, no dial, no
duplicate readout — and every lane tier keeps a dial with a persistent NAME
readout (`shell-control-kind.ts:141-154`). **Contract-transparent**:
`contract-signature.ts:109-110` emits only
`id min..max curve default=X unit=Y`.

⚠ **Watch the caption width.** cofefve's build measured `.seg` as `flex: 1`
(flex-basis 0), so buttons split the group's max-content width EQUALLY and the
widest caption of an uneven roster clips (`SYS…`, `PING-P…`). `IN 1`/`IN 2`/
`IN 3`/`IN 4` is a **perfectly even** roster — four captions of identical
character content — so it is the one case that cannot clip. That is luck, not
design; the underlying `flex: 1 1 auto` fix is still owed and is still its own
PR.

---

## 8. DERIVED READOUTS

Three, all pure functions of the four selectors — the params-only subset of what
this module wants to say (§6-A).

### A. `fourplexer-inputs-used` — `'4 of 4'` / `'1 of 4'`

`new Set([sel1..sel4]).size`.

**NEGATIVE CONTROL — the `straight through` → `reverse` preset pair.** Two
completely different routings (0,1,2,3 vs 3,2,1,0); this readout must **not
move** (4 of 4 both times), while a `paramId: 'sel1'` readback moves from `0.00`
to `3.00`. **POSITIVE CONTROL — `fan out IN 1`:** must go 4 → 1. Both legs are
required; a readout that echoed any single dial would fail the first.

### B. `fourplexer-idle` — the inverse map, which no cell can express

`'IN 3, IN 4 idle'` / `'none idle'`. The set of inputs no output is pointing at.

This is the readout the module is missing. Each cell says *"OUT 1 carries IN 2"*;
**nothing anywhere says "IN 3 is going nowhere"**, and on a clocked router that
is the difference between a patch that works and a patch that is silent 75 % of
the time (§2-E).

**NEGATIVE CONTROL:** move `sel1` 0 → 0 (a no-op write) — must not move. **Move
`sel1` 0 → 1 while `sel2` is already 1** — must go from `none idle` to
`IN 1 idle`, i.e. it must react to a change in a *different* param than the one
that moved. A per-cell readout is structurally incapable of that.

### C. `fourplexer-shared` — `'IN 2 → OUT 1, OUT 3'` / `'no input shared'`

Which inputs feed more than one output. The complement of B, and the thing you
want to know before you clock a gate: a shared input plus a clock is how a
routing you liked disappears.

**NEGATIVE CONTROL:** the `straight through` / `reverse` pair again — both print
`no input shared`, so it must not move; `fan out IN 1` must print
`IN 1 → OUT 1, OUT 2, OUT 3, OUT 4`.

---

## 9. THE PICTURE — `router-matrix`

A **4 × 4 grid**, inputs down the left, outputs across the top:

- the lit cell per column is that output's current selector — the whole routing
  readable in one glance, which four separate dials are not;
- **rows for inputs with no cable are DIMMED**, from `patch.edges` — so §2-E's
  "three of your four positions are silent" is a picture rather than a surprise;
- **columns whose gate has a clock carry a ▷ mark** and a small arrow showing
  where the next pulse will move them. That is the only surface anywhere that
  makes the advance predictable before it happens.

**Deliberately NOT drawn: the live signal.** Any per-frame element makes the VRT
baseline a race against boot. Every pixel above is a pure function of the four
params plus the edge set, so the tile is deterministic on a frozen graph, a live
graph and a silent rack alike (the clouds precedent) — a stronger guarantee than
#1420's freeze, and one this face therefore does not depend on.

**Generic-ish, and it says how far.** The panel takes
`selPrefix`/`inPrefix`/`gatePrefix`/`width` as declared props, so a future 8× or
2× switcher reuses it unchanged. It does **not** yet handle a non-uniform matrix
(different input and output counts); that is one prop away and should be added
when a second adopter exists, not now.

---

## 10. ALREADY-WRONG

- **A · `docs.explanation` says "a hard switch, never a blend or mix"; it blends
  for 3.979 ms** (§2-A). And `module-manifest.ts`'s `DESCRIPTIONS` entry for the
  same module **does** mention the *"~4 ms declick crossfade"* — so the two prose
  sources disagree and the one that is contract-locked is the wrong one. A `docs`
  edit; hash-transparent to every attest by design
  (`scripts/attest-code-basis.ts`) and not in `contract-signature`.
- **B · the gate threshold is `> 0.5`, not `>= GATE_HI`** (§5), and the constant
  is a bare literal with no reference to the seam. Fixing it is an audio change
  and wants its own PR.
- **C · the gate-advance write storm** — 2000 Y.Doc writes/s from a 2 kHz audio
  cable into a documented port (§2-D). Wants coalescing (post at most once per
  render quantum) in its own PR. The face can only warn.
- **D · fourplexer has NO VRT baseline at all.** `vrt-exemptions.ts:824`:
  *"VRT baseline pending — deterministic card (4 selector knobs, no canvas);
  capture via `task vrt:update` on each platform."* ⚠ **That reason text is
  STALE** — it describes the abandoned per-platform capture model. There is now
  ONE baseline set, authored by linux CI (`task vrt:commit`). The card is
  deterministic by the exemption's own admission, so **this exemption should be
  drained in the face PR, not carried into it.** A module getting a faceplate
  while its card has never once been pixel-diffed is exactly the gap the
  programme exists to close.
- **E · `FourPlexerCard.svelte:71` re-types `min={0} max={3}`** as literals ×4.
  Not in `RANGE_BOUND_CARDS`. Bind through `paramSpec()` and enrol it (cofefve
  precedent). §7's `options` roster makes the range redundant on the card
  anyway.
- **F · no `options` roster** (§7) — four dials over four named states.
- **G · the behavioral exemption's reason is thin.**
  `per-module-per-port-behavioral.spec.ts:311`: *"multiplex selector with
  per-input → per-output isolation; covered by fourplexer-related specs."* The
  four `4plexer.spec.ts` tests do cover routing, gate-advance + wrap,
  independence and audio-vs-cv. **None covers the declick, the threshold, or the
  storm** — the three things measured here. Not a face blocker; worth a line in
  the exemption's `why` so the next reader knows what it does not cover.
- **H · `glyph` cannot be live** (§6-C).

---

## 11. COST

| | |
|---|---|
| **contract-lock** | **+0 lines.** `face` is out of the signature, `options` (§7) is contract-transparent, no port or param added. §10-A is a `docs` prose edit, also out of the signature. |
| **`STRICT_DOCS`** | already in it (`strict-docs.ts:147`); no new keys — all 12 ports and 4 controls are documented. |
| **ART** | `art/baselines/fourplexer/out1.f32` + `.sha` exist. A face touches no DSP, so **no re-pin**. ⚠ §10-B (the threshold fix) edits `packages/dsp/src/fourplexer.ts` and therefore moves the source SHA — keep it out of the face PR. |
| **VRT** | ⚠ **fourplexer is currently EXEMPT with no baseline** (§10-D). Draining that exemption in the face PR adds the card scene (+1) and re-runs `task test:ledger:accept`, since `docs/testing/test-ledger.generated.md` counts the exemption lists — a GENERATED artifact, re-pin it in the SAME commit, never hand-edit. New face scenes: `face-fourplexer-{compact,dock}` = **2**. All three are deterministic: unpatched inputs read as 0 so every output is bit-zero, `glyph: 'none'`, and the panel is a pure function of params + edges. |
| **e2e** | +1 `faces-parity` row, **4 cells**. ≈ +5 s. §7's `options` change makes each cell a `<Segmented>` at the dock, which `faces-parity` reads by `textContent` — worth confirming the four `IN n` captions come back exactly (cofefve's build found `.seg` ellipsizing while the gate stayed green, because the DOM says the full name; an even roster cannot clip, but check it rather than reasoning about it). |
| **Push 2** | No `PUSH_CARD_CONTROLS` entry → generic tier over 4 params; nothing to re-rank. Adding `options` does not change the push card (it resolves from the live def's params, not their rosters) — but **confirm**, per the CLAUDE.md warning that a def edit can silently move a generic push card. |
| **the bottom line** | The batch's largest contract and its worst defect. The face's own contribution is **three readouts about the routing AS A WHOLE** — used / idle / shared — none of which any per-output cell can express, plus a matrix picture that is the only surface able to show that three of your four inputs have no cable. Its two real problems (the storm, the threshold) are DSP PRs the face documents rather than fixes, per INDEX rule 5. |
