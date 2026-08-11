# FACE SPEC — `flipper` (batch 6) — **VERDICT: A FACE IS NOT POSSIBLE**

## 0. STATUS + THE ONE-LINE ANSWER

**Authored 2026-08-11 against the working tree of `main`.** Nothing here is
implemented; no def, card, DSP or test file is touched. Every number below was
measured by running **the exact shipping worklet bundle** —
`packages/dsp/dist/flipper.js`, the bytes the browser's
`audioWorklet.addModule()` loads — inside a classic-script `vm` shim, stepped in
**128-sample render quanta** exactly as the browser does. 48 kHz.
**Determinism control: two identical runs, `max|flip₁ − flip₂| = 0.000e+0` and
`max|flop₁ − flop₂| = 0.000e+0`.**

**VERDICT: NOT "no face on merit" — NO FACE IS EXPRESSIBLE.** `flipper` has
**zero params, zero control families and zero numbered-legend static controls**
(`flipper.ts:31` is literally `params: []`; `FlipperCard.svelte` contains one
`<PatchPanel>` and two decorative `<span>`s). `face.order` would be `[]`, so
`curatedFace()` returns `controls: []` at **every** tier — mini, compact, full
and dock all paint a face tile with **nothing in it**. This is a category below
noise's "all four tiers are the same knob": there is no knob.

**Every escape is also closed** (§4): a hero PICTURE needs rank ≥ 7 and there
are no ranks; a derived READOUT reads `node.params` and there are no params; the
one live fact worth showing — *which output is armed next* — is a worklet
variable no host surface can see.

**The measurement was still worth doing.** It found **six defects**, three of
them behavioural and one of them severe: **a held gate on either input JAMS the
flip-flop and pins one output HIGH indefinitely** (§3.3), which the def's own
docs describe as the supported two-source use case. The right surface for this
module is a **CARD** with an analyser-driven FLIP/FLOP indicator plus three DSP
fixes — §7 — not a faceplate.

---

## 1. THE COMPLETE CONTRACT

`contract-lock.txt:1129-1133` — **5 lines, and not one of them is a param**:

```
flipper meta domain=audio
flipper in in1 gate edge=gate
flipper in in2 gate edge=gate
flipper out flip gate edge=gate
flipper out flop gate edge=gate
```

| kind | id | type | `edge` | notes |
|---|---|---|---|---|
| input | `in1` | `gate` | `gate` | worklet input 0. A silent `ConstantSourceNode(0)` is permanently connected here to keep `process()` scheduled (`flipper.ts:61-66`). |
| input | `in2` | `gate` | `gate` | worklet input 1. Unpatched ⇒ `inputs[1] = []` ⇒ read as 0. |
| output | `flip` | `gate` | `gate` | worklet output 0 |
| output | `flop` | `gate` | `gate` | worklet output 1 |
| **params** | — | — | — | **NONE.** `flipper.ts:31`. `setParam()` is a no-op and `readParam()` returns `undefined` (`:78-83`). |

**Registry membership.** In `STRICT_DOCS` (`strict-docs.ts:148`, with a note
that it carries a `card:` override because `defLite` cannot resolve it).
**Not** in `STRICT_VRT_MODULES` — it is in the full/informational VRT lane only,
with one baseline at `e2e/vrt/__screenshots__/vrt.spec.ts/flipper.png`.
**Not** in `STRICT_FACES`, no `face:`. **Not** in `PUSH_CARD_CONTROLS` (and
could not be — a push card is eight *controls*). Has an ART profile
(`art/scenarios/flipper/profile.test.ts`). Module-level exempt from the
per-port emit sweep (`per-module-per-port.spec.ts:131`), reason: *"FLIP/FLOP
fire on alternate input edges (not per-output drivable)"*.

**The DSP.** `packages/dsp/src/flipper.ts` wraps `FlipperState`
(`packages/dsp/src/lib/flipper-dsp.ts`). The whole state machine is 12 lines
and every finding in §3 traces to two of them:

```ts
const combined = in1 > in2 ? in1 : in2;      // :29   ← a max(), not a logical OR
const high = combined >= FLIPPER_THRESHOLD;  // :30   ← single threshold, 0.5
```

---

## 2. WHAT IT MEASURES AS — the module's real output shape

### 2.1 The canonical trigger goes in; something else comes out

The repo's canonical trigger is a **5 ms TRIANGLE** —
`fireTrigger(cs, t, TRIGGER_PULSE_S, 'triangle')`, ramping 0→1 over `w/2` then
1→0 (`gate-trigger.ts:49-69`). *Measured*, that pulse through the shipping
worklet:

| | samples | ms | peak |
|---|---|---|---|
| INPUT pulse | 239 | 4.979 | 1.0000 |
| **FLIP pulse** | **121** | **2.521** | 1.0000 |
| **FLOP pulse** | **121** | **2.521** | 1.0000 |

FLIP's first four samples: `0.500000  0.508333  0.516667  0.525000`.
Its last four: `0.525000  0.516667  0.508333  0.500000`.
**Step INTO the pulse = +0.500000. Step OUT of the pulse = −0.500000.**

**FLIPPER emits the part of the trigger that is above 0.5 and nothing else.** It
loses **49.4 % of the pulse width** and replaces both edges with a hard 0.5
discontinuity, because `:38-39` returns `0` when `!high` and `combined`
otherwise — there is no held level, only a gate on the *input's own waveform*.
A downstream consumer detecting at `>= GATE_HI` still sees the edge (the pulse
*starts* at exactly 0.500000, which passes `>=` by one ULP of nothing), but the
shape is no longer the canonical trigger the rest of the repo emits.

⚠ **Block alignment is not load-bearing** — a negative control shifting the
input by 37 samples produced identical run widths `[121, 121]`, confirming the
processor is per-sample and the 128-quantum stepping in my harness is not
shaping the result.

### 2.2 The output level is the INPUT level, unnormalised and unclamped

*Measured*, square gate of varying amplitude into `in1`:

| input gate amplitude | FLIP peak |
|---|---|
| 0.4999 | **0.000000** (below `GATE_HI`; nothing at all) |
| 0.50 | 0.500000 |
| 0.60 | 0.600000 |
| 0.80 | 0.800000 |
| 1.00 | 1.000000 |
| **2.00** | **2.000000** |

`return this.routeToFlip ? [combined, 0] : [0, combined]` (`flipper-dsp.ts:39`).
**FLIPPER is a router, not a gate generator** — it never synthesises a level, it
forwards the one it received, including out-of-range ones. The def's docs get
this right for the *inputs* (`flipper.ts:37`: *"a long gate in is a long gate
out"*) and wrong for the *outputs* — see §7-A.

### 2.3 The "divide by two" is not a square

*Measured*, 8 Hz square clock into `in1` over a 1 s window:

| clock duty | FLIP high | FLIP pulses | FLOP high | FLOP pulses |
|---|---|---|---|---|
| 5 % | 2.50 % | 4 | 2.50 % | 4 |
| 25 % | 12.50 % | 4 | 12.50 % | 4 |
| 50 % | **25.00 %** | 4 | **25.00 %** | 4 |

**FLIP's duty is the source's duty ÷ 2, never 50 %.** A classic /2 flip-flop
outputs a square at half the rate; this one outputs the source's own pulses,
every other one. Both are legitimate designs — a "clock divider" and a "trigger
alternator" — but they are different modules, and the doc claims the first
(§7-A) while the DSP implements the second.

### 2.4 A bipolar source into a gate input

*Measured*, a 2 Hz ±1 sine into `in1`: FLIP 1 pulse, FLOP 1 pulse, both peak
1.0000, **run width 166.69 ms of a 500 ms period** — the sine's above-0.5 cap,
exactly `(1/3)·period` as `asin` predicts. Legal (a gate cable is just CV) and
worth knowing: the width you get from an LFO depends on the LFO's *amplitude*,
not just its rate.

### 2.5 Spawn phase, and there is no way to change it

*Measured*: the first edge after spawn **always** fires FLIP —
`nextIsFlip = true` at construction (`flipper-dsp.ts:19`). Five pulses split
3 FLIP / 2 FLOP. Driving `in2` alone with nothing on `in1` gives the same
2 / 2 split on four pulses: the toggle is genuinely shared and the silent
`ConstantSourceNode` on input 0 is not in the way.

⚠ **`FlipperState.reset()` exists (`flipper-dsp.ts:43-47`) and is unreachable at
runtime.** The processor never calls it, there is no `port.onmessage` handler,
there is no RESET input port and there is no param. **The only way to re-phase a
FLIPPER is to delete it and spawn a new one.** On a divide-by-two whose entire
value is *which* voice gets the beat, that is the module's most-wanted control
and it does not exist.

---

## 3. THE THREE BEHAVIOURAL DEFECTS, MEASURED

### 3.1 The "OR" is a `max()`, so overlapping gates lose edges

`flipper-dsp.ts:29-31` takes `max(in1, in2)` and toggles on *its* rising edge.
Two independent sources whose gates overlap therefore present **one** rising
edge, not two. *Measured*, `in1` high over [0.10, 0.30] and [0.50, 0.70],
`in2` high over [0.20, 0.40] and [0.60, 0.80]:

| driven | output pulses |
|---|---|
| `in1` alone | 2 |
| `in2` alone | 2 |
| **both together** | **2** (not 4) |

The merged runs measure **300.0 ms and 300.0 ms** — each pair fused into one
double-length pulse. **Two of the four edges are silently discarded.**

### 3.2 …and the def documents the failing case as the feature

`flipper.ts:38`: *"The two are OR'd, so two sources can drive the toggle
together."* `flipper.ts:35`: *"Feeding both inputs lets two different sources
jointly advance the toggle."* Both are in `STRICT_DOCS`. They are true only when
the two sources never overlap — which for two *independent* sources is the
uncommon case, not the common one.

### 3.3 ⚠ A HELD gate on one input JAMS the flip-flop and pins an output HIGH

The severe form. *Measured*, an 8 Hz / 25 %-duty clock on `in1` while `in2` is
held high for the whole 1 s window:

| | FLIP pulses | FLOP pulses | toggles | FLIP high | FLOP high |
|---|---|---|---|---|---|
| clock alone | 4 | 4 | 8 | 12.5 % | 12.5 % |
| **clock + `in2` held HIGH** | **1** | **0** | **1** | **100.0 %** | **0.0 %** |

`max(clock, 1) ≡ 1`, so after the single rising edge at t = 0 there is never
another. **The module stops toggling entirely and FLIP sits at full scale for as
long as the held gate lasts.** Anything downstream — a VCA, an envelope sustain,
a voice gate — is held open. There is no indication anywhere: the card is
static, the ports look connected, and the clock is visibly running.

This is not exotic. `edge: 'gate'` is *declared* on both inputs
(`contract-lock.txt:1130-1131`), so a held gate is precisely what the contract
invites, and every gate-emitting module in the rack can produce one.

### 3.4 No hysteresis, on a state machine

`GATE_LO === GATE_HI === 0.5` (`gate-trigger.ts:24-31`) — a single threshold,
documented as the proven choice for *level* consumers. `flipper` is not a level
consumer; it is a **state machine whose phase is cumulative**, so a chattered
crossing does not add a spurious pulse, it **permanently scrambles which output
is which**. *Measured*, a 1 Hz unipolar LFO crossing 0.5 once, with noise:

| noise amplitude | output pulses (ideal: **1**) |
|---|---|
| 0.000 | **1** |
| 0.005 | **52** |
| 0.020 | **201** |
| 0.050 | **517** |

A clean 1 s ramp through the threshold gives 1, so the crossing itself is fine.
**0.5 % of noise is enough to produce 52 phase flips from one intended edge.**
Any real analogue-ish source — a `featurecv` CV, a slewed gate, an envelope
near its knee, an ES-9 input — can hit this.

⚠ Note the sibling precedent: CLAUDE.md's trigger/gate rule exists because
main-thread rescans **double-counted** edges (NUMPAD+/HYDROGEN/ATLANTIS). A
worklet doing per-sample `prev < TH && cur >= TH` is called out as *"correct by
construction"* there — and it is, **for counting**. It is not sufficient for a
*latching* consumer fed a noisy signal, which is a distinction the shared model
does not currently draw.

---

## 4. WHY A FACE IS NOT EXPRESSIBLE — four walls, all structural

**A · `face.order` would be EMPTY.** Zero params (`flipper.ts:31`), zero
`controlFamilies`, zero numbered-legend static controls (`FlipperCard.svelte`
has a `<PatchPanel>`, a `<ModuleTitle>` and two decorative `<span>`s — no
button, no select). `curatedFace()` returns `{ controls: [] }` at every tier;
`dockFacePlan()` returns one `__all` band with nothing in it. The lane tile would
render a title and a glyph. **`module-face-lint`'s STRICT_FACES completeness
check passes vacuously** — an empty order over an empty control set is complete —
so nothing would go red. A green gate certifying an empty faceplate.

**B · A hero PICTURE is illegal.** `module-face-lint.test.ts:629-663` fails a
panel cell selected at any lane tier, and the `full` cap is 6
(`LANE_PLATE_MAX_CELLS`), so a panel's first legal rank is **7**. With zero
ranked controls, rank 7 is unreachable — and unlike the one-param modules in
this batch, so is rank 1. The meowbox escape (a sidebar `custom` block, which
carries no `face.order` key and hence no rank) technically works and is
**dock-only**, i.e. it would never appear in a lane.

**C · Every readout is blind.** `ModuleShell.readoutValue` reads
`node.params`, and `FaceReadout` offers exactly `paramId` / `valueId` / `text`
(`types.ts:697-708`). `flipper` has no params, so `paramId` has nothing to name
and a `valueId` function has nothing to read — **only `text` would render, i.e.
a constant string.** noise rejected a constant-string readout as *"decoration,
not a readout"* (`face-specs-batch-3-noise.md` §4) and that ruling applies here
with more force, because here it is the *only* available kind.

**D · The one fact worth showing is inside the worklet.** *Which output is armed
next* (`nextIsFlip`, `flipper-dsp.ts:19`) is the number a patcher actually wants,
and it lives in an `AudioWorkletProcessor` field. There is no `port` message, no
param mirror, no analyser tap on internal state. This is the bluebox wall in its
strongest form: bluebox at least had twelve params whose *readouts* were blind to
a press; flipper has no params at all.

**So the question "does flipper merit a face?" does not reach the merit stage.**
The platform cannot express one. Saying that plainly is the answer.

---

## 5. WHAT SHOULD HAPPEN INSTEAD — the CARD, and it can do what the face cannot

The information §4-D says a face cannot reach is reachable **from a card**,
because a card may hold its own `AnalyserNode` on the module's outputs. That
pattern already ships: `featurecv`'s card paints live LOUD / BRIGHT / PUNCH
meters and an ONSET blink off the engine, display-only, never writing the Y.Doc
(`module-manifest.ts`, featurecv entry). `FlipperCard.svelte` is currently
**52 lines** and paints a static `FLIP ↔ FLOP`.

The card that would earn its place:

- **Two live lamps**, FLIP and FLOP, off analysers on the two outputs — so
  "which one is armed" is *observed*, not inferred. This also makes §3.3 visible
  the instant it happens: FLIP lit solid while the clock runs is unmistakable.
- **A jam warning.** Both a held-input jam (§3.3) and a chatter storm (§3.4) are
  detectable from the output taps alone: one output continuously high for
  > ~1 s, or > N transitions per second. This is the readout the module needs
  and it is a *card* readout, not a face one.
- ⚠ **It must not write the graph.** Live render state only — the
  `cv-modulation-live-store-write-storm` rule.
- ⚠ **It would cost a VRT baseline.** `flipper` is in the full lane, not
  `STRICT_VRT_MODULES`, so this is one informational re-capture — but a *live*
  lamp is animated chrome, and the analyser must read zeros under the
  `bootWithFace` / #1420 audio freeze for the scene to be deterministic. The
  analogVco precedent (`strict-faces.ts`, analogVco entry: 254 / 154 / 315 px
  across three captures of one tile) is the exact failure to design against.

And three DSP fixes, each of which is a separate, small PR:

1. **Per-input edge detection instead of `max()`** (§3.1/§3.3) — track
   `wasHigh1` and `wasHigh2` and toggle on either input's own rising edge. This
   makes the documented two-source use case true and makes a held gate on one
   input harmless. ⚠ It changes the ART baseline
   (`art/scenarios/flipper/profile.test.ts` pins `flip`/`flop` with a
   `combinedSourceSha` over both DSP files), so it is an intentional
   `task art:update` with a reviewed diff.
2. **A RESET input**, `edge: 'trigger'`, calling the `reset()` that already
   exists and is unreachable (§2.5). A contract change: +1 `contract-lock` line,
   +1 doc key, +1 per-port row.
3. **Hysteresis, or a debounce, on the toggle** (§3.4). `GATE_LO` exists as a
   named constant *"so a future module can opt into a Schmitt-trigger band …
   without re-deriving the number"* (`gate-trigger.ts:26-30`). **This is that
   module.**

---

## 6. THE CONTINGENCY FACE — only if the owner overrules §4, stated for completeness

It is not a good object and I am not recommending it. The only shape that is not
an empty tile puts everything in the dock-only sidebar, which means the lane
tiers still render nothing:

```ts
face: {
  title: 'Flip-flop',
  hint: 'Two gate ins, two gate outs. Every rising edge swaps which one passes.',

  order: [],                 // there is nothing to rank. This is the finding.

  glyph: 'scope',            // the ONLY live surface a lane tier could carry

  // NO `hero` — `control` and `action` both take a face.order key, and there
  // are none. A hero with only `readouts` would print constants (SS4-C).

  sidebar: [
    { kind: 'signal-flow', label: 'routing', stages: [
      { label: 'IN 1',  role: 'generator' },
      { label: 'IN 2',  role: 'generator', parallel: true },
      { label: 'toggle', role: 'bus', note: 'rising edge only' },
      { label: 'FLIP',  role: 'bus', note: '1st, 3rd, 5th' },
      { label: 'FLOP',  role: 'bus', note: '2nd, 4th, 6th', parallel: true },
    ] },
    { kind: 'readouts', label: 'what it does NOT do', entries: [
      { label: 'no reset',   text: 'phase is fixed at spawn' },
      { label: 'held gate',  text: 'jams the toggle, pins one output HIGH' },
      { label: 'out width',  text: 'the input pulse above 0.5, not a square' },
    ] },
  ],
}
```

⚠ Every sidebar entry is `text:` — a constant string, i.e. **prose in a
faceplate**. The `signal-flow` block is the only element carrying real
structure, and it is DOCK-ONLY. ⚠ `glyph: 'scope'` is safe here for the reason
it is unsafe on the CV pair: flipper is silent at spawn (both outputs 0 with
nothing patched), so the trace is a deterministic flat centreline under the
#1420 capture freeze. **A face whose entire content is three sentences and a
diagram is a documentation page rendered in the wrong place** — that content
belongs in `docs.explanation`, where §7's corrections should put it anyway.

---

## 7. ALREADY-WRONG — six, three of them measured behaviour

**A · `flipper.ts:41` — "Driven from a single clock it is a half-rate GATE."**
Measured, it is a half-rate **pulse train with the source's own duty**: 25.00 %
high from a 50 % clock, 2.50 % from a 5 % clock (§2.3). A "half-rate gate" is
50 % high, which this never is at any input duty. In `STRICT_DOCS`.

**B · `flipper.ts:38` / `:35` — "the two are OR'd, so two sources can drive the
toggle together."** Measured false whenever the gates overlap: 4 independent
edges produce 2 output pulses, the pair fused into 300 ms runs (§3.1). The
supported case is documented; the failing case is the same case. In
`STRICT_DOCS`.

**C · The held-gate jam is undocumented and severe** (§3.3): 8 toggles → 1, one
output pinned at 100 % duty. Nothing in the def, the manifest
(`module-manifest.ts:206`), the card or the contract mentions it.

**D · No hysteresis on a latching consumer** (§3.4): 0.5 % noise turns one
intended edge into 52 phase flips. `GATE_LO` exists precisely for this opt-in
and nothing opts in.

**E · `FlipperState.reset()` is dead code from the module's point of view**
(`flipper-dsp.ts:43-47`, §2.5). It is covered by `flipper-dsp.test.ts`, so the
unit lane is green on a method the shipping module can never call — the
"a gate that cannot fail is decoration" shape, one level up: a *test* that
cannot fail for the shipped configuration.

**F · `flipper` is not in `EXPECTED_NODE_TYPES`, and that gate no longer means
what its header says.** `modules-card-map.test.ts:1-11` promises the glob map
reproduces the migration set *"no module dropped, none spuriously added"*, but
only the **dropped** direction is asserted (`:102-104` checks
`EXPECTED_NODE_TYPES.filter(t => !(t in nodeTypes))` and nothing else). A source
scan finds **34** registered module types outside the list — `flipper`, all
twenty MOOG cards, `pentemelodica`, `recorderbox`, `outlines`, `edges` and more
— of which exactly one (`cadillac`) is declared `NO_CARD_BY_DESIGN`. So
`FlipperCard.svelte` is not covered by the gate that exists to prove it resolves.
⚠ The 34 comes from a regex scan of `type: '…'` declarations rather than the
live registry, so treat the **existence** of the gap as measured and the
**count** as approximate.

**Not wrong, worth recording:** the ART profile
(`art/scenarios/flipper/profile.test.ts`) drives `FlipperState` directly rather
than the worklet, and its header defends that as *"the EXACT per-sample code the
worklet runs … no mirror, no drift"*. **I verified that claim from the other
side** — running the shipping `dist/flipper.js` bundle reproduces the ART
behaviour exactly, including the alternation and the both-silent-after-pulse
invariant. The one thing the ART scenario cannot see is §2.1, because
`clockTrain` emits a **rectangular** pulse (its assertion is
`expect(flip[i]).toBe(1)` across the whole pulse) while the repo's canonical
trigger emitter is a **triangle** — so the 49.4 % width loss and the ±0.5 edge
steps are invisible to the pinned baseline.

---

## 8. WHAT I COULD NOT DETERMINE

- **Whether a real `audioWorklet.addModule()` differs from the `vm` shim.** I
  ran the shipping dist bytes at the browser's 128-sample quantum, and the
  block-alignment negative control (§2.1) shows the processor is per-sample, so
  quantum placement is not shaping the result — but I did not instantiate it
  inside a real `AudioWorkletNode`. Channel-count behaviour under a *stereo*
  upstream (`inputs[0][0]` = left only) is therefore **not measured**.
- **Whether any shipped patch depends on the current `max()` semantics.** I did
  not survey saved patches, so §5's fix 1 is a design proposal, not a
  regression-free guarantee.
- **The audible consequence of the ±0.5 edge steps** (§2.1) into a downstream
  VCA. Inferred (a 0.5 step at audio rate is a click), **not auditioned**.
- **The exact `EXPECTED_NODE_TYPES` gap size** (§7-F) — regex scan, not registry.

---

## 9. COST

| | |
|---|---|
| **a FACE (not recommended)** | contract-lock **+0** (`face` is UI metadata, `types.ts:522-527`); attest **0** (`attest-code-basis.ts` strips `face`); VRT +`face-flipper-{compact,dock}` = 2 informational baselines; `faces-parity` +1 row with **0 cells** — a parity row that asserts nothing, on a tile that paints nothing. |
| **the CARD (§5)** | 1 informational VRT re-capture (`flipper` is not in `STRICT_VRT_MODULES`), plus a determinism argument for the live lamps under the #1420 capture freeze. No contract change, no attest, no ART. |
| **DSP fix 1 — per-input edges** | re-pins `art/baselines/flipper/{flip,flop}.f32` + `.sha` + `fingerprints.generated.json` via `task art:update`, reviewed as a diff. No contract change. |
| **DSP fix 2 — RESET input** | contract-lock **+1** line, +1 `docs.inputs` key, +1 per-port row, +1 card jack. A real contract change. |
| **DSP fix 3 — hysteresis** | re-pins the ART baselines only if the threshold band changes a pinned render; a `GATE_LO < GATE_HI` opt-in is already anticipated by `gate-trigger.ts:26-30`. |
| **the honest bottom line** | **The face is not a judgement call — the platform cannot express one.** The three behavioural defects are worth more than any surface, and the surface that would actually show them is a card with two analyser lamps. |
