# FACE SPEC — `sampleHold` (batch 6)

## 0. STATUS

**Authored 2026-08-11 against `main` (`2af79daf`).** Nothing here is
implemented. Every number was measured against the **REAL shipping worklet** —
`packages/dsp/src/sample-hold.ts` captured through a `registerProcessor` shim and
pumped in 128-sample blocks at 48 kHz — or read at file:line.

**Verdict: PROMOTE — but the argument has to be made honestly, because this
module has ONE parameter, and a face cannot be justified by its control count.**
It is justified by the opposite: **the module has two completely different
personalities and the control surface has no way to name either of them.**

The module type is `sampleHold` (the def's `type`); the DSP files, the ART
scenario and the e2e spec all use `sample-hold`.

**Two headlines, both measured.**

1. **The module's identity is not a param.** With `gate_in` unpatched it is a
   pure quantizer; patched, a sample & hold. *Measured*, the same inputs through
   the two modes differ by `max|Δ| = 1.95` V on `cv_out` and `2.00` V on
   `cv_quant`, and produce **11 999 vs 3 distinct output levels** over 0.5 s.
   That switch is driven by a hidden worklet param the graph writes
   (`gateConnected`) — and `FaceReadoutValue` is **params-only**, so a
   `readouts` block structurally **cannot** print it. §6-A.
2. **The one param's real number is invisible.** `scale` prints `1.00` on a
   knob. What it actually sets is **how far the QUANT output moves a note**:
   *measured max snap distance* **50 ¢ (Chromatic) / 100 ¢ (all seven modes +
   Melodic Minor) / 150 ¢ (Harmonic Minor)**. At the SHIPPED default (Major),
   **41.7 %** of input voltages get moved by a full semitone.

Not in `STRICT_FACES`; no `face:` block. In `STRICT_DOCS`
(`strict-docs.ts:65`). Not in `STRICT_VRT_MODULES`; a card baseline is committed
(`e2e/vrt/__screenshots__/vrt.spec.ts/sampleHold.png`). No `PUSH_CARD_CONTROLS`
entry. **1 param, 2 in, 2 out.** contract-lock = **6 lines**.

---

## 1. EVERY PORT AND PARAM, FROM THE DEF

`packages/web/src/lib/audio/modules/sample-hold.ts`

### Ports

| dir | id | cable | `edge` | what it is |
|---|---|---|---|---|
| in | `cv_in` | `cv` | — | the value to sample (gated) or quantize (ungated). |
| in | `gate_in` | `gate` | **`trigger`** | the sample clock. Each rising edge latches. **Unpatched is a MODE, not an absence** — see §2-D. |
| out | `cv_out` | `cv` | — | the held value. **Never quantized.** |
| out | `cv_quant` | `cv` | — | `cv_out` snapped to the selected scale. |

### Params

| id | label | range | curve | default | units | measured authority |
|---|---|---|---|---|---|---|
| `scale` | `Scale` | **0 .. 9** | `discrete` | **1** (Major) | — | `max|Δ|` on `cv_quant` = **8.33e-2 V = 100 ¢**; on `cv_out` = **0.00e+0** over the entire 0..9 travel. |

**That is the whole control surface.** One knob, ten positions.

### The hidden third param

The worklet declares TWO `parameterDescriptors` the def does not:

| worklet param | range | default | who writes it |
|---|---|---|---|
| `scale` | **0 .. 32** | 1 | the def's `setParam` (§7-C: the range disagrees) |
| `gateConnected` | 0 .. 1 | **0** | the FACTORY, from a 120 ms poll of the live graph (`sample-hold.ts:129-143`) |

⚠ **`gateConnected` is the RIGHT shape and it is worth saying so.** It is
host-driven state that is deliberately **not** a `ParamDef`, so it never appears
on a card, in the contract, or in a face's completeness obligation. Compare
`cofefve`'s `syncPeriod`, which was host-written 62 times a second **while being
declared a user param** — a control that could not hold a value — and had to be
removed from the control surface in that module's face PR. sampleHold got this
right the first time.

### Constants, cited not re-derived

`GATE_THRESHOLD = 0.5` (`sample-hold-dsp.ts:118`) — the same value as
`GATE_HI` in `$lib/audio/gate-trigger`, under a local name. The worklet's edge
test is `g >= GATE_THRESHOLD && prevGate < GATE_THRESHOLD`, which matches the
canonical `>=` form. (`fourplexer` does not — see that spec's §5.)
`GATE_POLL_MS = 120` (`sample-hold.ts:67`).

---

## 2. MEASURED — the real worklet, 48 kHz

**Determinism control:** two identical renders, `max|Δ| = 0.00e+0` on **both**
outputs.

### A. THE QUANTIZER IS EXACT — and my first instrument said it was not

`quantizeVoltage` was checked against a brute-force
nearest-admitted-semitone oracle over **±5 octaves at a 1-cent grid — 120 001
probes × 10 scales**:

| | max disagreement |
|---|---|
| **all 10 scales** | **0.00e+0 semitones** |

⚠ **The first run of that oracle reported 1.00 / 2.00 / 3.00 semitones of
disagreement, per scale, and it was the INSTRUMENT.** The reported figure was
exactly each scale's **maximum degree gap** — the signature of a TIE, not a bug.
`quantizeVoltage` rounds an exact midpoint toward the HIGHER note
(`sample-hold-dsp.ts:100-108`); my oracle's `<` kept the lower one. Same rule,
re-run, `0.00e+0`. **A metric blind to the tie convention returns a clean,
confident, wrong number** — the CLAUDE.md failure mode, hit on the first probe of
this batch, recorded here so the next author does not re-derive the same false
finding.

**NEGATIVE CONTROL on the corrected oracle:** a +1 semitone perturbation of the
subject is caught at **1201 / 1201** probes. The oracle can see a defect; it
reports none.

*Ties, measured:* `4.500 st → 5.000`, `11.500 st → 12.000`,
`−0.500 st → 0.000`. Half-up, including across an octave boundary and across
zero.

### B. THE STAIRCASE — what a scale actually costs, in cents

Over a −2 V .. +2 V ramp (four octaves), gate unpatched:

| # | scale | notes | steps over 4 oct | mean plateau | **max snap** | mean snap |
|---|---|---|---|---|---|---|
| 0 | Chromatic | 12 | **49** | 83.3 mV | **50.0 ¢** | 25.0 ¢ |
| 1 | **Major (default)** | 7 | 29 | 143.5 mV | **100.0 ¢** | 45.8 ¢ |
| 2 | Minor | 7 | 29 | 142.0 mV | 100.0 ¢ | 45.8 ¢ |
| 3 | Dorian | 7 | 29 | 142.0 mV | 100.0 ¢ | 45.8 ¢ |
| 4 | Phrygian | 7 | 29 | 143.5 mV | 100.0 ¢ | 45.8 ¢ |
| 5 | Lydian | 7 | 29 | 143.5 mV | 100.0 ¢ | 45.8 ¢ |
| 6 | Mixolydian | 7 | 29 | 142.0 mV | 100.0 ¢ | 45.8 ¢ |
| 7 | Locrian | 7 | 29 | 143.5 mV | 100.0 ¢ | 45.8 ¢ |
| 8 | **Harmonic Minor** | 7 | 29 | 143.5 mV | **150.0 ¢** | **50.0 ¢** |
| 9 | Melodic Minor | 7 | 29 | 143.5 mV | 100.0 ¢ | 45.8 ¢ |

**Harmonic Minor is the outlier and the reason `max snap` is worth printing.**
Its degrees are `[0,2,3,5,7,8,11]`, so the gap between the ♭6 and the ♮7 is
**3 semitones** — a CV landing in the middle of it is moved a full **150 ¢**,
three times Chromatic's worst case. That is not a defect; it is the scale. It is
also completely invisible on a knob reading `8.00`.

**Plateau width against the quantisation floor.** The plateaus here are the
POINT of the module rather than a dead zone, and they are wide by design: 83.3 mV
(Chromatic) to 143.5 mV, against a `cv` path whose resolution is the float
sample. The step count is the honest measure — **49 vs 29 distinct levels over
the same 4 V** — and it moves with the control, which is what makes it a
readout rather than a coincidence.

### C. SCALE'S AUTHORITY IS EXACTLY ONE OUTPUT

| | `max|Δ|` vs Chromatic over a −1..+1 V ramp |
|---|---|
| `cv_quant` | **8.33e-2 V = 100 ¢** (every scale 1..9) |
| `cv_out` | **0.00e+0** over the whole 0..9 travel |

A permanent, free negative control: **the only knob on the module has zero
effect on the module's first output.** Any readout of `cv_out` that moved with
`scale` would be wrong by construction, and any face that puts `scale` in a
band labelled anything other than "QUANT" is teaching a chain that does not
exist.

*Latency:* changing `scale` while HOLDING takes effect at the **next 128-sample
block** — measured, a change at sample 2000 moved `cv_quant` at sample 2048
(Δ 48 smp ≤ 2.67 ms). Major `0.333333` → Chromatic `0.250000`.

### D. THE TWO PERSONALITIES

Same 7 Hz sine into `cv_in`, same three gate edges, `gateConnected` 1 vs 0:

| | S&H (`gateConnected 1`) | QUANTIZER (`gateConnected 0`) |
|---|---|---|
| `cv_out` | a staircase | **bit-identical to `cv_in`** (`max|Δ| = 0.00e+0`) |
| distinct `cv_out` levels / 0.5 s | **3** | **11 999** |
| `max|Δ|` between the two modes | `cv_out` **1.95 V** · `cv_quant` **2.00 V** | |

*Latch behaviour, S&H:* **0 samples of latency** — `cv_out[edge] === cv_in[edge]`
exactly, at every edge. Held perfectly flat between edges.

**⚠ THE VALUE AT SPAWN IS EXACTLY ZERO.** With `gate_in` patched but not yet
clocked, `cv_out` and `cv_quant` both read **0.000000** — `held` initialises to
0 in the worklet and nothing writes it until the first rising edge. `0 V` is
**C4** under the module's own 1V/oct convention, so a patched-but-unclocked S&H
sits on middle C indefinitely. Nothing says so, and "the sequencer isn't running
yet" and "the module is broken" look identical.

With **nothing** patched at all, both outputs are bit-zero
(`cv_out` peak `0.000000`, `cv_quant` peak `0.000000`) — which is what makes the
VRT scene deterministic (§9).

### E. THE DEFAULT SCALE IS NOT A NEUTRAL DEFAULT

Major vs Chromatic over a 2 V ramp: the two outputs differ on **41.7 %** of
samples. At the shipped default, **two input voltages in five are moved by a
whole semitone.** For a module whose second output is often the only one patched,
that is the single most useful sentence the faceplate can say, and it is a pure
function of the one param.

### F. An instrument note, recorded because it nearly became a finding

The first S&H probe placed gate edges at **0.1 / 0.2 / 0.3 s** against a **7 Hz**
sine. 0.1 s is exactly 0.7 of a 7 Hz cycle, so edges 2 and 3 sampled the
**identical** value `0.587785`, and "distinct levels" read **3** where 4 was
expected — which reads exactly like a missed latch. Re-run at irregular offsets
(0.037 / 0.113 / 0.191 / 0.277 / 0.359 / 0.443 s against 7.13 Hz): **7 distinct
levels for 6 latches plus the spawn value**, all different
(`0.0000, 0.9962, −0.9394, 0.7631, −0.1564, −0.3662, 0.8395`). *Sample at
co-prime offsets when probing anything periodic* — CLAUDE.md's rule 2, earned
twice in one batch.

---

## 3. THE RANKING — one param, so the ranking is trivial and the ARGUMENT is not

| rank | key | tier | why |
|---|---|---|---|
| 1 | `scale` | mini | it is the only one. |

**Where 1 param sits.** Of the 28 modules in `STRICT_FACES`, **`bluebox` has
ZERO params** and one `face.order` key (a control family), and `vca` has two.
bluebox's face is justified entirely by its sidebar TONE BANK and its glyph —
*"because no prefix can carry the module's INFORMATION, the information moves off
the key subset entirely"* (`strict-faces.ts:150-154`). **This is the same
argument with the same shape**, and it is the only argument available:

- the ONE knob is worth **three** derived readouts (§5), each of which states a
  number the knob cannot;
- the module's MODE — its actual identity — needs a `custom` sidebar panel,
  because it is patch-topology state (§6-A);
- and the module has a natural picture (a scale ring) that no other surface in
  the repo draws.

**The case AGAINST, stated fairly.** A dock faceplate for one knob is mostly
chrome, the card already prints the scale NAME and an `S&H` / `QUANTIZER` hint
(`SampleHoldCard.svelte:66,79`), and promoting it costs 2 VRT baselines plus a
`faces-parity` row for **one cell**. If the owner's bar for a face is "the panel
is hard to read", sampleHold does not clear it. If the bar is "the module says
things no control can say" — 50/100/150 ¢, 41.7 %, 0 V = C4, and which of two
modules it currently is — it clears it comfortably. **Recommend PROMOTE; the
decision is legitimately the owner's and the arithmetic is above.**

---

## 4. THE FACE

```ts
face: {
  title: 'Quantizer',
  hint:
    'Two modules in one, and the CABLE picks which. No gate patched: a live scale quantizer. ' +
    'Gate patched: a sample & hold whose held value is then quantized. HOLD is never quantized; ' +
    'QUANT always is.',

  order: ['scale'],

  // ONE band. Two would be a lie — there is one control and it belongs to one
  // output. The band's hint carries the mechanism; the readouts carry the
  // numbers, because band hints do not paint at rest (see below).
  pages: [
    {
      id: 'quant',
      label: 'quantize',
      hint:
        'SCALE affects the QUANT output ONLY — measured 0.00e+0 on HOLD across its whole travel. ' +
        'At the shipped Major it moves 41.7 % of input voltages by a full semitone.',
      controls: ['scale'],
    },
  ],

  // ⚠ 'none', DELIBERATELY. sampleHold has NO audio-typed output (`cv_out` and
  // `cv_quant` are both `cv`), so `glyphBinding` cannot resolve a live analyser
  // tap and falls through to `{ kind: 'static' }` — a canned decaying burst
  // from ModuleShell's BURST_TRACE constant. 26 of the 28 modules already in
  // STRICT_FACES have an audio output; the two that do not (adsr, lfo) land on
  // a PARAM-DERIVED branch. No shipped face has ever rendered `static`, and a
  // picture that is not the module's is worse than no picture. See the
  // gatemaiden spec §7-A for the platform fix.
  glyph: 'none',

  hero: {
    control: 'scale',
    readouts: [
      { label: 'scale', valueId: 'samplehold-scale-name' },
      { label: 'snaps up to', valueId: 'samplehold-snap' },
      { label: 'notes', valueId: 'samplehold-notes' },
    ],
  },

  sidebar: [
    // THE PICTURE, and the ONE surface that can print the mode. A `custom`
    // block, not a `hero.cell` — module-face-lint refuses a PANEL cell selected
    // at a lane tier and the 'full' lane cap is SIX, so a panel's first legal
    // rank is 7 and a one-param module can never reach it (the meowbox
    // precedent, stated in sidebar-panels.ts).
    //
    // A sidebar panel receives `nodeId` and imports `$lib/graph/store` itself
    // (FilterResponsePanel.svelte:31, MeowboxFormantBankPanel.svelte:33), so it
    // CAN read `patch.edges` — which is exactly what a `readouts` block cannot
    // do and why the mode banner has to live here. See §6-A.
    { kind: 'custom', label: 'the scale', panelId: 'scale-ring',
      props: { scaleParam: 'scale', gatePort: 'gate_in' } },

    { kind: 'signal-flow', label: 'signal flow', stages: [
      { label: 'CV IN',   role: 'generator', note: 'anything bipolar' },
      { label: 'LATCH',   role: 'bus',       note: 'only while GATE is patched' },
      { label: 'HOLD',    role: 'bus',       note: 'raw — never quantized' },
      { label: 'QUANT',   role: 'bus', parallel: true, note: 'snapped to the scale' },
    ] },

    { kind: 'readouts', label: 'what QUANT does to a note', entries: [
      { label: 'scale',       valueId: 'samplehold-scale-name' },
      { label: 'notes/oct',   valueId: 'samplehold-notes' },
      { label: 'worst snap',  valueId: 'samplehold-snap' },
      { label: 'moved',       valueId: 'samplehold-moved' },
      { label: 'unclocked',   text: 'a patched-but-silent GATE holds 0 V = C4' },
      { label: 'root',        text: 'C at 0 V, 12-ET, 1/12 V per semitone' },
    ] },

    { kind: 'presets', label: 'three snap distances', entries: [
      { id: 'chromatic', label: 'chromatic',      note: '50 ¢ worst',  values: { scale: 0 } },
      { id: 'major',     label: 'major',          note: '100 ¢ worst', values: { scale: 1 } },
      { id: 'harmonic',  label: 'harmonic minor', note: '150 ¢ worst', values: { scale: 8 } },
    ] },
  ],
}
```

⚠ **`title`, `hint` and the band `hint` paint NOTHING at rest** —
annotation-gated (`dock-faceplate-model.ts`, owner decision 2026-08-03; cofefve's
build confirmed band hints go the same way). Everything load-bearing is in the
hero readouts, the sidebar readouts block, or the picture.

⚠ **The three presets are the teaching, not convenience.** They are three knob
positions, which would normally be decoration — here they are the three
DISTINCT values of the `snaps up to` readout, so clicking through them
demonstrates that the module's one number is not the knob's number. That is also
exactly the readout's negative control (§5-B), made clickable.

---

## 5. DERIVED READOUTS

`FaceReadoutValue` is `(read: (paramId) => number | undefined) => string`
(`face-readout-values.ts:149`). All four below are pure functions of `scale`.
The MODE is not, and that is §6-A.

### A. `samplehold-scale-name` — the table lookup

`SAMPLE_HOLD_SCALES[clampScaleIndex(scale)].name` → `'Major'`. A
`paramId: 'scale'` readout prints `1.00`.

This also **deletes a duplicate**: `SampleHoldCard.svelte:43` computes the same
string from `sampleHoldScaleName`, and the def re-exports
`SAMPLE_HOLD_SCALE_NAMES` for it. Better still — declare
`ParamDef.options` from `SAMPLE_HOLD_SCALES` (§7-D) and the platform prints the
name in the dock `<Selector>` and in every lane knob's persistent readout
without any readout at all.

### B. `samplehold-snap` — THE readout, and its negative control is unusually clean

The maximum distance QUANT can move a note, in cents:
`maxGap(scale.degrees) / 2 × 100`. → `'50 ¢'` / `'100 ¢'` / `'150 ¢'`.

**NEGATIVE CONTROL — `scale` 1 → 2 (Major → Minor) must NOT move it.** Both are
7-note scales with a 2-semitone maximum gap, so both snap by at most 100 ¢
(measured: identical). A `paramId: 'scale'` readback moves on **every** step of
the knob; this one moves on **two** of the nine (0→1 and 7→8). *A readout that
moved on all nine would be echoing the dial.*

**POSITIVE CONTROL — `scale` 0 → 1 → 8** must print 50 → 100 → 150. Both legs
are required: a readout stuck at a constant would pass the negative leg alone.

Anchored on §2-B, re-derived from `SAMPLE_HOLD_SCALES` in the model test rather
than hard-coded, so adding an eleventh scale updates the claim instead of
staling it.

### C. `samplehold-notes` — `'7 of 12'` / `'12 of 12'`

`scale.degrees.length`. Moves on 0→1 and nowhere else in 1..9 — the same
two-sided control shape as B, on a different axis. Cheap and it makes the
Chromatic position legible as "no quantization at all beyond 12-ET".

### D. `samplehold-moved` — the fraction of the input range the scale relocates

`1 − degrees.length / 12` → `'0 %'` (Chromatic) / **`'41.7 %'`** (every 7-note
scale). §2-E measured exactly 41.7 % on a real ramp through the real worklet,
which is what makes this a derivation rather than an arithmetic coincidence: the
model test asserts the closed form against the measured ramp.

**NEGATIVE CONTROL:** identical for scales 1..9, so it must not move across the
seven modes while `samplehold-snap` moves at 8 — the two readouts are blind in
*different* directions, and that is why both are on the panel.

---

## 6. WHAT THE FACE PLATFORM CANNOT DO HERE

### A. THE MODE IS PATCH STATE, AND `readouts` IS PARAMS-ONLY

`ModuleShell.readoutValue` is `params.paramVal(pid)`
(`ModuleShell.svelte:411-414`), and `FaceReadoutValue` takes exactly one
argument: a param reader. There is **no** access to `patch.edges`, to the engine,
or to a port. So the single most important fact about this module — *which of two
modules is it right now* — **cannot be a `FaceReadout` of any kind**.

Three routes, and only one is available today:

| route | verdict |
|---|---|
| a `readouts` entry with a `valueId` | **impossible** — the reader cannot see edges. |
| a `custom` sidebar panel | **works today.** The panel gets `nodeId` and imports `$lib/graph/store` itself; `FilterResponsePanel` and `MeowboxFormantBankPanel` both already do. This is what the spec declares. |
| widening `FaceReadoutValue` to `{ read, edges, sampleRate }` | the right long-term fix, and it is the **third** face spec to ask for a widened reader (analogVco and macrooscillator both did, for `sampleRate` and played pitch). A platform PR, not a face PR. |

⚠ **All three batch-6 modules hit this exact wall**, and each one's best fact is
on the far side of it: sampleHold's mode, gatemaiden's "is anything above 0.5
arriving", fourplexer's "three of your four inputs have no cable". **That
convergence is the batch's strongest argument for widening the reader**, and it
should be filed as one platform issue rather than three face-local workarounds.

### B. A PANEL'S FIRST LEGAL RANK IS 7

`module-face-lint`'s `panelTierProblems` refuses a PANEL cell selected at a lane
tier, and the `'full'` cap is `LANE_PLATE_MAX_CELLS = 6`. With **one** rankable
key, a `hero.cell` is unreachable. The `custom` sidebar block carries no
`face.order` key and is therefore exempt.

### C. THERE IS NO `fader` CELL KIND — and no live glyph either

`ParamCellKind` is `knob | momentary | toggle | segmented | selector | grid |
color` (`shell-control-kind.ts:33-40`). There is **no `'fader'`**; a face renders
every non-toggle/segmented/selector/grid/color param as a `KnobConic`. That does
not bite sampleHold (its card already uses a `<Knob>`), but it does bite
gatemaiden, whose card uses a `<Fader>` — recorded here because the assumption
that a fader kind exists would silently produce a different-looking dock.

Glyph: see §4's comment and the gatemaiden spec §7-A.

---

## 7. ALREADY-WRONG

- **A · a patched-but-unclocked S&H sits at exactly 0 V = C4** (§2-D), and
  nothing anywhere states it. Not a bug — `held` has to start somewhere — but the
  face should say it, because it is indistinguishable from a dead module.
- **B · the mode switch has up to `GATE_POLL_MS` = 120 ms of latency**
  (`sample-hold.ts:64-67, 143`). A freshly dragged gate cable leaves the module a
  quantizer for up to 120 ms; at a 120 BPM 16th-note clock (125 ms/pulse) that is
  up to one lost pulse, at 32nds up to two. ⚠ **A LOADED rack is NOT affected**:
  `isGateConnected()` reads `livePatch.edges` (the live store), not the
  reconciler's applied set, and persistence writes nodes and edges before the
  reconciler runs — so the factory's initial `refreshGateConnected()` already
  sees the edge. Verify that if the load path ever changes; the failure would be
  silent.
- **C · the worklet declares `scale` as `0 .. 32`; the def declares `0 .. 9`.**
  *Measured*: `scale` 9, 10, 15 and 32 all produce bit-identical output
  (`Δ = 0.00e+0`), because `quantizeVoltage` calls `clampScaleIndex`. So **23 of
  the worklet's 33 declared positions are dead aliases of Melodic Minor**. There
  is no `scale_cv` port, so nothing can currently reach them — which is precisely
  why it is worth fixing now, while it is free: set the descriptor's `maxValue`
  from `SAMPLE_HOLD_MAX_SCALE` so a future CV input inherits the right range
  instead of a silently-clamped one.
- **D · `scale` has no `ParamDef.options` roster.** 10 states >
  `SEGMENTED_MAX_OPTIONS` (6), so a declared roster gives the dock a
  `<Selector>` and every lane tier a dial with a persistent NAME readout
  (`shell-control-kind.ts:144-154`) — which is exactly what the card hand-rolls
  today. **Contract-transparent**: `contract-signature.ts:109-110` emits only
  `id min..max curve default=X unit=Y`.
- **E · `SampleHoldCard.svelte:69` re-types `min={0}`** as a literal (the max is
  correctly imported as `SAMPLE_HOLD_MAX_SCALE`). One literal, but sampleHold is
  not in `RANGE_BOUND_CARDS` and the cheap fix is `paramSpec()`.
- **F · Harmonic Minor's 150 ¢ worst-case snap is 3× Chromatic's** (§2-B) and
  1.5× every other scale's. Correct, and worth printing.
- **G · `glyph` cannot be live** — no audio-typed output (§6-C).

---

## 8. THE PICTURE — `scale-ring`

A twelve-position ring (or a twelve-cell strip; the ring reads better at sidebar
width), root C at the top:

- the **admitted** degrees of the current scale lit, the rest dimmed — so the
  Chromatic → Major change is a picture of five lights going out;
- the **largest gap** drawn as an arc with its cents value, which is the
  `samplehold-snap` readout made visual and is where Harmonic Minor's 3-semitone
  gap becomes obvious at a glance;
- a **mode banner** reading `SAMPLE & HOLD — clocked` or `QUANTIZER — no gate
  patched`, from `patch.edges` (§6-A). This is the panel's load-bearing job.

**Deliberately NOT drawn: the currently-held value.** It lives on `cv_out`, an
audio-rate port; reading it needs an analyser tap the panel has no access to,
and any live element would make the VRT baseline a race against boot. Every pixel
above is a pure function of `scale` + the edge set, so the tile is deterministic
on a frozen graph, a live graph and a silent rack alike — the clouds precedent, a
stronger guarantee than #1420's freeze and one this face therefore does not
depend on.

⚠ **The panel is NOT generic yet, and it should say so** rather than pretending.
It reads sampleHold's own scale table. The day a second quantizer wants it, the
table moves behind a declared prop the way `stereo-crossover` takes
`splitHz`/`widthParam` — then, not now, on one module's guess about the next one.
(`marbles` and `qbrt` are the two candidates; neither is checked here.)

---

## 9. COST

| | |
|---|---|
| **contract-lock** | **+0 lines.** `face` is out of the signature, `options` (§7-D) is contract-transparent, no port or param added. §7-C is a worklet `parameterDescriptors` edit — also not in the signature (the signature reads the DEF), but it **does** move the ART source SHA (below). |
| **`STRICT_DOCS`** | already in it (`strict-docs.ts:65`); no new keys. |
| **ART** | A face touches no DSP, so **no re-pin**. ⚠ **And a finding in its own right: sampleHold's two baselines carry NO `.sha` companion.** `art/baselines/sample-hold/` holds `continuous-quant-curve.f32` and `gated-quant-steps.f32` and nothing else, while its two batch siblings each ship one (`gatemaiden/{gate,trig}.sha`, `fourplexer/out1.sha`). The scenario uses `moduleSourceSha('sample-hold')` **only** as a build-toolchain check — *"built worklet SHA matches the source SHA"* — and writes the baselines through bare `writeBaseline`/`compareBuffers`. So a change to the quantizer math is caught by the RMS comparison but **nothing forces an INTENTIONAL re-pin** the way a `.sha` does, and `art/scenarios/sample-hold/quantized-vco-steps.test.ts` renders through `lib/sample-hold-dsp.ts` — the file that holds the whole scale table — which no pin covers at all. Converting it to the `dspSourceSha('sample-hold.ts', 'lib/sample-hold-dsp.ts') + pinAll` shape its siblings use is a small, separate PR. §7-C (the worklet `maxValue`) edits `packages/dsp/src/sample-hold.ts`, so it needs a real `task dsp:build` for the build-toolchain check to stay green; the `.f32` bytes must come back **byte-identical** (the change is a declared range, not arithmetic, and §7-C measured 9..32 as already aliased). |
| **VRT** | Card baseline committed; not in `STRICT_VRT_MODULES` → informational lane. §7-D repaints the card (the name label may become redundant), so **the card baseline WILL move** — capture it via `task vrt:commit`, and remember a sub-`DOCK_MAX_DIFF` change is invisible to both the gate and `--update-snapshots`. New face scenes: `face-sampleHold-{compact,dock}` = **2**. Both deterministic (bit-zero unpatched, `glyph: 'none'`, panel is pure). |
| **e2e** | +1 `faces-parity` row, **1 cell** — the smallest in the programme. ≈ +2 s. The existing `e2e/tests/sample-hold.spec.ts` (3 tests: clocked chain, scale-name label, continuous-quantizer + `hint=QUANTIZER`) asserts the card's label and hint by testid; **if §7-D removes the hand-rolled label, that spec needs updating in the same PR** or it goes red. |
| **Push 2** | No `PUSH_CARD_CONTROLS` entry → generic tier over one param; nothing can re-rank. |
| **the bottom line** | The smallest face in the programme, and the one whose value is most concentrated in a single sentence the platform currently cannot print. **Promote it, and file the `FaceReadoutValue` widening (§6-A) as the batch's one platform ask** — three modules, three different blind spots, one reader. |
