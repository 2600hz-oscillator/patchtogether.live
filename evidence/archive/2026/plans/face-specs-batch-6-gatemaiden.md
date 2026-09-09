# FACE SPEC — `gatemaiden` (batch 6)

## 0. STATUS

**Authored 2026-08-11 against `main` (`2af79daf`).** Nothing here is
implemented; no def, card, DSP or test file is touched. Every number below was
measured against the **REAL shipping worklet** — `packages/dsp/src/gatemaiden.ts`
captured through a `registerProcessor` shim and pumped in 128-sample blocks at
48 kHz, the `art/setup/worklet.ts` path — or read at file:line.

**Verdict: PROMOTE, and it is the strongest of the three.** archetype: **the
converter.** It is the one module in the repo whose entire subject is the
trigger↔gate distinction CLAUDE.md legislates, and it currently expresses that
subject with one fader, one unlabelled button and no statement of any kind about
what its two outputs differ by.

**The headline, measured: the two controls are PERFECTLY ORTHOGONAL — each owns
exactly one output — and in ONE corner of that two-control space the two outputs
become BIT-IDENTICAL.** `LEN → TRIG` is `max|Δ| = 0.00e+0` across the whole
0.005..2 s travel; `SHAPE → GATE` is `max|Δ| = 0.00e+0`; and at `LEN = 0.005`
(minimum) with `SHAPE = SQR` the GATE and TRIG buffers agree to
`max|Δ| = 0.00e+0` on both a square and a triangle input. A module sold as "one
input, both shapes at once" has a reachable setting where it emits the same
shape twice, and nothing anywhere says so.

**And the second one is a live documentation bug with a number.** The def says
`trigShape` is *"Display/feel only; both fire once per rising edge with the same
canonical pulse width."* Both pulses are indeed 5.000 ms of non-zero. The width
**above `GATE_HI`** is **2.500 ms (TRI) vs 5.000 ms (SQR)** — half — and a
consumer that samples once per 128-sample render quantum **misses the TRI pulse
at 16 of 240 sub-block phases (6.7 %) and the SQR pulse at 0 of 240 (0.0 %)**.
`trigShape` is a reliability control, not a cosmetic one.

Not in `STRICT_FACES`; no `face:` block. In `STRICT_DOCS` (`strict-docs.ts:144`).
Not in `STRICT_VRT_MODULES`; a card baseline is committed
(`e2e/vrt/__screenshots__/vrt.spec.ts/gatemaiden.png`). No `PUSH_CARD_CONTROLS`
entry. **2 params, 1 in, 2 out.** contract-lock = **6 lines**.

---

## 1. EVERY PORT AND PARAM, FROM THE DEF

`packages/web/src/lib/audio/modules/gatemaiden.ts`

### Ports

| dir | id | cable | `edge` | `accepts` | what it is |
|---|---|---|---|---|---|
| in | `in` | `gate` | **`gate`** | `cv`, `pitch` | the ONE input. Declared `edge: 'gate'` because the module reads its LEVEL for the GATE output while separately edge-detecting for TRIG — the def calls this *"the one principled converter exception to 'one input = one semantic'"* (`gatemaiden.ts:30-33`). |
| out | `gate` | `gate` | `gate` | — | held square, minimum width `gateLen`. |
| out | `trig` | `gate` | `trigger` | — | one short pulse per rising edge. |

### Params

| id | label | range | curve | default | units | measured authority |
|---|---|---|---|---|---|---|
| `gateLen` | `Len` | **0.005 .. 2** | `log` | **0.05** | `s` | owns `gate` ONLY. `max|Δ|` on `trig` over the full travel = **0.00e+0**. |
| `trigShape` | `Shape` | **0 .. 1** | `discrete` | **0** (triangle) | — | owns `trig` ONLY. `max|Δ|` on `gate` = **0.00e+0**; on `trig` = **9.96e-1**. |

The min/max/default are mirrored in **three** places that agree today:
`GATE_LEN_MIN/MAX/DEFAULT` (`packages/dsp/src/lib/gatemaiden-dsp.ts:37-39`), the
worklet's `parameterDescriptors`, and the def. The card re-types them a **fourth**
time as literals (§8-D).

**Canonical constants, cited not re-derived** (`$lib/audio/gate-trigger`):
`GATE_HI = 0.5`, `GATE_LO = 0.5`, `TRIGGER_PULSE_S = 0.005`,
`DEFAULT_GATE_LEN_S = 0.05`. The DSP lib mirrors the first two BY VALUE with a
comment saying so (`gatemaiden-dsp.ts:26-33`) — packages cannot import across the
web/dsp boundary. That is the disciplined form; **`fourplexer` does not do it**
(see that spec's §5).

---

## 2. MEASURED — the real worklet, 48 kHz

**Determinism control:** two identical renders, `max|Δ| = 0.00e+0` on **both**
outputs.

### A. The two outputs, in numbers

| | TRI (`trigShape 0`, default) | SQR (`trigShape 1`) |
|---|---|---|
| peak | **0.995833** | 1.000000 |
| non-zero width | 240 smp = **5.000 ms** | 240 smp = **5.000 ms** |
| width **above `GATE_HI`** | 120 smp = **2.500 ms** | 240 smp = **5.000 ms** |
| area | 2.5000 ms·unit | 5.0000 ms·unit |
| rms over the pulse | 0.091286 | 0.158114 (= ×√3) |

The TRI pulse **never reaches 1.0**: the ramp is sampled at
`frac = (i + 0.5)/240`, so the two samples straddling the apex both read
0.995833.

### B. THE BLOCK-QUANTUM MISS — why `trigShape` is not cosmetic

A consumer that reads the TRIG output **once per 128-sample render quantum** (a
k-rate `AudioParam` read, a per-block poll, any main-thread tap that is not
`$lib/audio/edge-detect`'s windowed counter) sees a value ≥ `GATE_HI` only if a
block boundary lands inside the above-threshold window. That window is **120
samples for TRI — shorter than the 128-sample quantum**.

*Measured*, sweeping the pulse across all 240 sub-block phases:

| shape | above-threshold window | phases where a per-block read sees NOTHING |
|---|---|---|
| TRI | 120 smp | **16 / 240 = 6.7 %** |
| SQR | 240 smp | **0 / 240 = 0.0 %** |

The GATE output at `LEN = minimum` (240 smp) is likewise never missed: **0/240**.

⚠ This does **not** affect a per-sample worklet consumer, which is correct by
construction and exempt per CLAUDE.md. It affects exactly the main-thread
consumers the trigger/gate section warns about — which is why the honest reading
is *"SQR is the safe shape for anything that leaves the audio thread"*, and why
the def's `docs.controls.trigShape` is wrong to call the choice display-only.

### C. `LEN` IS A THRESHOLD ON THE INPUT, NOT A DURATION

The derived gate is `high || withinMin`, so `LEN` only reaches the output when
the input gate is **shorter** than `LEN`. Against a **350 ms held gate**, ref =
`LEN 0.005`:

| `LEN` | `max|Δ|` vs ref | gate width |
|---|---|---|
| 0.005 … 0.3499 | **0.00e+0** | 350.00 ms |
| **0.3500** | **0.00e+0** | 350.00 ms |
| **0.3501** | **1.00e+0** | 350.10 ms |
| 0.4 / 0.5 / 1.0 / 2.0 | 1.00e+0 | 400 / 500 / 1000 / 2000 ms |

**Plateau against the quantisation floor.** `LEN` quantises to
`round(len·sr)` = **one sample = 20.83 µs**, and the plateau edge resolves to
exactly that: `0.3500 → +1 smp` moves the output (`1.00e+0`), while
`0.3496 → +1 smp` does **not** (`0.00e+0`). So the flat region is a real
plateau, not a measurement floor — the instrument can see a 20.83 µs change and
reports zero across 345 ms of fader.

On the **log** fader's own travel, the inert fraction depends only on the input:

| input gate | `LEN` bit-inert over |
|---|---|
| 10 ms | 11.6 % of travel |
| 50 ms | 38.4 % |
| 100 ms | 50.0 % |
| 350 ms | **70.9 %** |
| 1000 ms | 88.4 % |
| ≥ 2000 ms | **100.0 %** |

**Any input gate at or above 2 s makes `LEN` completely inert** — the fader's
maximum is 2 s and the input always wins. A sustained note held for two seconds
turns half this module's control surface off, and no surface says so.

Conversely, for a canonical 5 ms trigger the gate width is `round(LEN·sr)`
**exactly** at every probed value (5 / 10 / 50 / 100 / 250 / 500 / 1000 /
2000 ms), on both a square and a `fireTrigger`-shaped triangle input.

### D. THE COLLAPSE — GATE ≡ TRIG in one corner

| input | `LEN` | `SHAPE` | `max|GATE − TRIG|` |
|---|---|---|---|
| 5 ms square | 0.005 (min) | **SQR** | **0.00e+0** |
| 5 ms square | 0.005 (min) | TRI | 9.96e-1 |
| 5 ms triangle | 0.005 (min) | **SQR** | **0.00e+0** |
| 5 ms triangle | 0.005 (min) | TRI | 9.96e-1 |

The mechanism is arithmetic and unavoidable:
`GATE_LEN_MIN === TRIGGER_PULSE_S` — both are **0.005 s exactly**
(`gatemaiden-dsp.ts:37` and `gate-trigger.ts:36`). At the minimum, the derived
gate is a 5 ms square, and a SQR trigger is a 5 ms square. **The module's two
outputs are the same signal.**

Is that a bug? *No* — it is the correct answer, and it is also the module's most
useful setting (a clean re-shaped clock on both jacks). It is a **legibility**
defect: a faceplate should say `GATE = TRIG` there instead of drawing two jacks
that look independent.

### E. THE THRESHOLD IS ABSOLUTE — below 0.5 the module emits NOTHING

A 2 Hz sine into `in`, `LEN` 50 ms, over 2 s:

| input amplitude | trigs | GATE duty | GATE peak |
|---|---|---|---|
| 0.25 / 0.45 / 0.49 / **0.4999** | **0** | **0.00 %** | **0.000** |
| **0.5000** | 4 | **10.00 %** | 1.000 |
| 0.5001 | 4 | 10.00 % | 1.000 |
| 0.6 | 4 | 18.65 % | 1.000 |
| 0.75 | 4 | 26.77 % | 1.000 |
| 1.0 | 4 | **33.34 %** | 1.000 |

`GATE_HI` is an **absolute** threshold on a port that `accepts: ['cv','pitch']`.
A ±0.4 LFO, an attenuated gate, a pitch CV sitting below C4+6 semitones — all
produce **bit-zero on both outputs**, forever, with no indication. This is the
single most likely "it's broken" support question for the module and it is
invisible on the card.

⚠ Note the **10.00 % duty at amplitude exactly 0.5**, where the input is above
threshold for essentially zero time. That floor is `LEN` (50 ms × 4 pulses over
2000 ms). **`LEN` is what turns a barely-crossing CV into a usable gate** — the
other half of §2-C's story, and the reason `LEN` ranks first.

### F. RETRIGGER MERGES — the window RESTARTS, it does not queue

Two 5 ms triggers, `LEN` 50 ms:

| gap | GATE runs | widths | TRIGs |
|---|---|---|---|
| 10 ms | **1** | 60.00 ms | 2 |
| 20 ms | **1** | 70.00 ms | 2 |
| 49 ms | **1** | 99.00 ms | 2 |
| 51 ms | 2 | 50.00, 50.00 ms | 2 |

The merge boundary is `LEN` **exactly**. Total width = gap + `LEN`. TRIG always
fires twice. That one table is the module in miniature: **TRIG counts events,
GATE measures time.**

### G. The rest, briefly

- **Latency 0 samples** on both outputs (input rises at 4800, both outputs first
  non-zero at 4800). GATE's value set is exactly `{0, 1}` — a hard square.
- **Constant HIGH** for 1 s → GATE duty 100.00 %, **1** trig. **Constant LOW**
  (= unpatched) → both outputs **bit-zero**, 0 trigs.
- **440 Hz saw into `in`** → **439 trigs/s**, GATE duty 99.83 % in **one
  continuous run** (`LEN` 50 ms swallows every gap). Audio into this module makes
  GATE a DC 1.0 and TRIG a 439 Hz pulse train.

---

## 3. THE RANKING — 2 params, and the ordering is measured, not argued

| rank | key | tier | why |
|---|---|---|---|
| 1 | `gateLen` | mini | It is the only continuous control, and §2-E shows it is what makes a marginal input usable at all (the 10.00 % duty floor). It is also the one that can be **inert** (§2-C), so it is the one that needs a readout next to it. |
| 2 | `trigShape` | compact | Two states — but §2-B makes it a correctness control, not a cosmetic one. |

There is no rank 3. The lane budget is six; the module has two. **Every tier
above `mini` shows the whole module**, which is unusual and worth stating: this
face is not a triage of a big panel, it is an ANNOTATION of a small one, and its
entire value is in the readouts and the sidebar.

**Where 2 params sits.** Of the 28 modules already in `STRICT_FACES`, **bluebox
has 0 params** and `vca` has 2. A 2-param face is squarely inside precedent.

---

## 4. THE FACE

```ts
face: {
  title: 'Converter',
  hint:
    'One input, both shapes at once. LEN owns the GATE output and SHAPE owns the TRIG output — ' +
    'measured, each has exactly zero effect on the other. Anything below 0.5 makes neither.',

  order: ['gateLen', 'trigShape'],

  // TWO BANDS, ONE PER OUTPUT. The band structure is the MEASUREMENT: LEN →
  // TRIG is 0.00e+0 and SHAPE → GATE is 0.00e+0 over the full travel of each,
  // so "which output does this knob belong to" has a bit-exact answer and the
  // bands are it. Two bands is well under DOCK_TAB_MIN_BANDS (7), so the face
  // stays untabbed and PF-21 row packing still applies.
  pages: [
    {
      id: 'gateout',
      label: 'gate out',
      hint:
        'LEN is a THRESHOLD ON THE INPUT, not a duration: it only reaches the output when the ' +
        'input is SHORTER than LEN. Against a 350 ms gate the whole bottom 70.9 % of this fader ' +
        'is bit-identical; at or above 2 s of input it is inert end to end.',
      controls: ['gateLen'],
    },
    {
      id: 'trigout',
      label: 'trig out',
      hint:
        'both shapes are 5 ms wide; TRI is above 0.5 for only 2.5 ms of it, which is shorter than ' +
        'one 128-sample render quantum — a per-block reader misses 6.7 % of TRI pulses and 0 % of SQR.',
      controls: ['trigShape'],
    },
  ],

  // ⚠ 'none', DELIBERATELY — see §7-A. gatemaiden has NO audio-typed output, so
  // `glyphBinding` cannot resolve a live analyser tap and falls through to
  // `{ kind: 'static' }`, which paints a canned decaying burst that has nothing
  // to do with this module. A picture that is not the module's is worse than no
  // picture. The real picture lives in the sidebar, where it can be DRAWN from
  // the two params instead of tapped from a port that does not exist.
  glyph: 'none',

  hero: {
    control: 'gateLen',
    readouts: [
      { label: 'trig',  valueId: 'gatemaiden-trig-hi' },
      { label: 'gate',  valueId: 'gatemaiden-widen-below' },
      { label: 'jacks', valueId: 'gatemaiden-collapse' },
    ],
  },

  sidebar: [
    // THE PICTURE. A `custom` sidebar block carries no `face.order` key and
    // therefore no rank (the meowbox precedent, stated in sidebar-panels.ts).
    // ⚠ Since PF-22 (#1480) a `hero.cell` is ALSO rank-free — a hero picture is
    // dock-only and may rank FIRST — so the two routes are now both open and
    // the choice is a design one, not an arithmetic one.
    { kind: 'custom', label: 'the conversion', panelId: 'gate-trigger-map',
      props: { lenParam: 'gateLen', shapeParam: 'trigShape', threshold: 0.5 } },

    // ⚠ A `signal-flow` sidebar block stood here. THAT CELL KIND NO LONGER
    // EXISTS — #1468 removed it and its twelve adopters, and
    // `graph/types.ts:798` warns in as many words that re-adding one is the
    // mistake. The chain it drew (IN → >=0.5 → LEVEL/GATE, EDGE/TRIG) is
    // §2-C/§2-D and is stated in the readouts block below.

    { kind: 'readouts', label: 'what is true right now', entries: [
      { label: 'trig above 0.5', valueId: 'gatemaiden-trig-hi' },
      { label: 'per-block safe', valueId: 'gatemaiden-block-safe' },
      { label: 'len reaches',    valueId: 'gatemaiden-widen-below' },
      { label: 'the two jacks',  valueId: 'gatemaiden-collapse' },
      { label: 'input floor',    text: 'below 0.5 both outputs are exactly zero' },
      { label: 'retrigger',      text: 'a rise inside the window RESTARTS it — one long gate, not two' },
    ] },

    { kind: 'presets', label: 'the three uses', entries: [
      { id: 'clock',   label: 'clean clock', note: 'GATE = TRIG here',
        values: { gateLen: 0.005, trigShape: 1 } },
      { id: 'sustain', label: 'open a sustain', note: '250 ms floor',
        values: { gateLen: 0.25, trigShape: 0 } },
      { id: 'strike',  label: 'strike from a hold', note: 'gentle trig',
        values: { gateLen: 0.005, trigShape: 0 } },
    ] },
  ],

  // trigShape is `0..1 discrete default 0`, so `looksLikeSwitch` is TRUE and
  // module-face-lint demands an explicit momentary/latching classification. It
  // is LATCHING (a shape selector you set and leave), so it needs an
  // `ACKNOWLEDGED_LATCHING` entry `'gatemaiden:trigShape'` in
  // module-face-lint.test.ts — with the reason, per the named-exemption rule.
  // See §6 for the better fix, which is `ParamDef.options`.
}
```

⚠ **`title`, `hint` and every band `hint` paint NOTHING at rest** — they are
annotation-gated (`dock-faceplate-model.ts`, owner decision 2026-08-03), and
cofefve's build confirmed the band hints go the same way. So the mechanism above
is a fourth tier, and this face's argument rests entirely on the three surfaces
that paint unconditionally: **the hero readouts, the sidebar readouts block, and
the picture.** Everything load-bearing is in one of those three.

---

## 5. DERIVED READOUTS

All four are pure functions of the two params, which is what
`FaceReadoutValue` — `(read: (paramId) => number | undefined) => string`
(`face-readout-values.ts:149`) — can express. Nothing here needs the platform
widened. That is not true of the other two modules in this batch (see the
sampleHold spec §6-A, which files the `FaceReadoutValue` widening).

### A. `gatemaiden-trig-hi` — the number that decides whether the pulse is seen

```
aboveMs = (trigShape >= 0.5 ? TRIGGER_PULSE_S : TRIGGER_PULSE_S / 2) * 1000
        → '5.0 ms above 0.5'   |   '2.5 ms above 0.5'
```

**NEGATIVE CONTROL — `gateLen`.** Measured `max|Δ|` of `LEN` on the whole TRIG
buffer over its full 0.005..2 travel is **0.00e+0**, so a readout of the trigger
that moved with `LEN` would be reading the wrong output. **POSITIVE CONTROL —
`trigShape` 0 → 1** must move it 2.5 → 5.0, which the same measurement backs
(`max|Δ| = 9.96e-1`). A `paramId: 'trigShape'` readout prints `0.00`.

### B. `gatemaiden-block-safe` — the same fact as a verdict

`'safe'` at SQR; `'6.7 % missed by a per-block reader'` at TRI. Same input as A,
different sentence, and it is the one a user acts on. Anchored on the 16/240
sweep (§2-B), which the model test re-derives from the real processor rather than
hard-coding — so if the pulse width ever changes, the claim goes red.

### C. `gatemaiden-widen-below` — `LEN` as the predicate it actually is

`'widens anything under 50 ms'`, from `round(gateLen·sr)/sr`.

**Why not `paramId: 'gateLen'`.** That prints `0.05 s` and is *correct* — and it
is silent about the only thing that matters, which is that the number is a
CEILING on the inputs `LEN` can affect at all. §2-C measured a 345 ms wide,
bit-exact plateau with a 20.83 µs quantisation floor; a dial readback cannot
express a plateau. **NEGATIVE CONTROL — `trigShape`:** measured 0.00e+0 on the
GATE buffer, so it must not move.

### D. `gatemaiden-collapse` — the readout that is the module's argument

`'GATE = TRIG'` when `gateLen <= GATE_LEN_MIN && trigShape >= 0.5`, else
`'distinct shapes'`. A function of **both** params at once; neither dial can
express it, and the collapse is bit-exact (§2-D).

**NEGATIVE CONTROL, both directions.** From the collapse corner: raise `LEN` one
step → `'distinct shapes'`; flip `SHAPE` to TRI → `'distinct shapes'`. And the
positive leg: only `(min, SQR)` prints the collapse. A one-sided test would pass
against a readout that said `'GATE = TRIG'` whenever `LEN` was at minimum, which
is **false at TRI** (`max|Δ| = 9.96e-1`).

---

## 6. THE VOCABULARY FIX — `ParamDef.options` on `trigShape`

`trigShape` is `0..1 discrete` with **no `options` roster**, so
`paramCellKind` falls to `looksLikeToggle` → `'toggle'`: an anonymous switch. The
card today paints `△ TRI` / `▭ SQR` on a bespoke `<button>`; the dock face would
paint neither name.

Declaring `options: [{ value: 0, label: 'Triangle' }, { value: 1, label: 'Square' }]`
(2 ≤ `SEGMENTED_MAX_OPTIONS` = 6) gives a `<Segmented>` row at the dock and a
dial with a persistent name readout at every lane tier, and it is
**CONTRACT-TRANSPARENT** — `contract-signature.ts:109-110` emits only
`id min..max curve default=X unit=Y`, never `options`. It also deletes the card's
local `shapeLabels` array.

⚠ It does **not** remove the `ACKNOWLEDGED_LATCHING` obligation:
`looksLikeSwitch` reads the ParamDef's shape, not its roster, and the two gates
answer different questions ("which primitive" vs "does releasing it write REST
back"). Both are needed.

---

## 7. THE PLATFORM FACT THIS BATCH ESTABLISHES

### A. THE GLYPH SYSTEM IS AUDIO-OUT-ONLY, AND THIS IS THE FIRST FACE IT FAILS

`glyphBinding` (`shell-glyph-live.ts:112-171`) resolves a live tap through
`primaryAudioOutPortId`, which is `outputs.find(o => o.type === 'audio')`.
gatemaiden's outputs are `gate` and `gate`. **There is no audio-typed output, so
every glyph kind falls through to `{ kind: 'static' }` — a canned `BURST_TRACE`
or `SINE_TRACE` constant in `ModuleShell.svelte:112-117`.**

*Measured across the roster:* of the **28** modules in `STRICT_FACES`, **26 have
an audio output**. The two that do not — `adsr` (`glyph: 'envelope'`) and `lfo`
(`glyph: 'waveform'` + a 0..2 `shape`) — both land on a **param-derived** branch
resolved *before* the audio short-circuit. **No shipped face has ever resolved to
`static`.** All three modules in batch 6 would be the first, which is why all
three declare `glyph: 'none'` and put their picture in the sidebar.

The general fix, if the owner wants glyphs on CV utilities: `glyphBinding` needs
a CV/gate branch (`outputs.find(o => CV_FAMILY.has(o.type))` feeding the same
analyser tap). That is a platform PR, not a face PR, and it would light up all
three of these plus every future utility.

---

## 8. ALREADY-WRONG

- **A · `docs.controls.trigShape` is measurably wrong.** *"Display/feel only;
  both fire once per rising edge with the same canonical pulse width."* The
  non-zero width is the same; the **above-threshold** width is halved (2.500 vs
  5.000 ms), the TRI peak is 0.995833 not 1, and a per-block reader misses TRI
  6.7 % of the time and SQR never (§2-B). Fix the prose in the face PR — it is a
  `docs` edit, hash-transparent to every attest by design
  (`scripts/attest-code-basis.ts`), and it will move `contract-lock.txt` not at
  all (docs prose is not in the signature).
- **B · GATE ≡ TRIG at (`LEN` min, SQR)** and nothing says so (§2-D). Not a bug;
  a legibility hole the face closes with one readout.
- **C · the card RAW-WRITES `trigShape`.** `GatemaidenCard.svelte:25-29` does
  `t.params.trigShape = …` directly instead of `setNodeParam`, ledgered as
  `kind: 'debt'` in `raw-write-ledger.ts:177-181` with the reason *"card button
  write — user gesture, should be undoable + synced"*. It DOES reach the engine
  (the reconciler diffs `node.params` at `reconciler.ts:209-220`), so it is
  audible — it just has no undo entry. **One line to fix, and the ledger entry
  goes with it.** Boy-scout it in the face PR.
- **D · the card re-types the range.** `GatemaidenCard.svelte:42` passes
  `min={0.005} max={2}` as literals while `GATE_LEN_MIN`/`GATE_LEN_MAX` are
  exported from `gatemaiden-dsp.ts` and already mirrored on the def.
  `gatemaiden` is **not** in `RANGE_BOUND_CARDS`. Bind through `paramSpec()` and
  enrol it, per the cofefve precedent.
- **E · the repo's canonical gate↔trigger converter has NO bespoke e2e.** It
  appears only in `per-module-per-port.spec.ts` /
  `per-module-per-port-behavioral.spec.ts` and in `docs-virtual-module.spec.ts`.
  A module whose entire subject is a semantic distinction CLAUDE.md legislates
  should have one spec that patches a real trigger source into it and asserts
  both conversion directions at the graph level. (The ART profile
  `art/scenarios/gatemaiden/profile.test.ts` does assert both directions, but
  against the pure core, not the real chain.)
- **F · no `options` roster on `trigShape`** (§6) — the dock would paint an
  anonymous switch where the card paints two named states.
- **G · `glyph` cannot be live** (§7-A).

**Not wrong, and worth recording so a later batch does not "fix" it:** the
absolute `GATE_HI` threshold (§2-E), the retrigger merge (§2-F), and the
`GATE_LEN_MIN === TRIGGER_PULSE_S` coincidence (§2-D) are all correct hardware
behaviour. They are documentation gaps, not DSP gaps, and the face is the fix.

---

## 9. COST

| | |
|---|---|
| **contract-lock** | **+0 lines.** `face` is out of the signature by construction, `options` is contract-transparent, and no port or param is added. §8-A is a `docs` prose edit, also out of the signature. |
| **`STRICT_DOCS`** | already in it (`strict-docs.ts:144`), so any new doc key is already gated. No new keys — the two params and three ports are all documented. |
| **ART** | `art/baselines/gatemaiden/{gate,trig}.f32` + `.sha` are pinned at `gateLen = GATE_LEN_DEFAULT`, `trigShape = 0` via `dspSourceSha('gatemaiden.ts', 'lib/gatemaiden-dsp.ts')`. **A face changes neither**, so no re-pin, and §8-A's prose fix lives on the DEF — which the pin does not hash. ⚠ **But `dspSourceSha` hashes those two DSP files RAW** (`createHash('sha256').update(source)`, `capture.ts:58-65`) — no comment stripping, unlike `docsStrippedRepoSourceSha`, which only the five pattern-3 def-pinned scenarios use. **So a one-word edit to a comment in `packages/dsp/src/gatemaiden.ts` re-pins this baseline.** Do not "tidy" the worklet header while fixing §8-A; the prose that is wrong is on the def, and it is free there. |
| **VRT** | A card baseline is committed and `gatemaiden` is **not** in `STRICT_VRT_MODULES`, so it is the informational lane. §8-C/D repaint nothing visible (a raw-write fix and a range binding), so the card baseline should not move — **verify that, do not assume it**, and remember a sub-`DOCK_MAX_DIFF` change is invisible to both the gate and `--update-snapshots`. New face scenes: `face-gatemaiden-{compact,dock}` = **2** baselines. Both are deterministic: unpatched, the module is bit-zero on both outputs (§2-G), and with `glyph: 'none'` there is no live surface at all. |
| **e2e** | +1 `faces-parity` row, **2 cells** — the smallest in the programme after `bluebox`. ≈ +3 s. Plus the §8-E bespoke spec, which is new coverage rather than face cost. |
| **Push 2** | No `PUSH_CARD_CONTROLS` entry → generic tier. With two params the generic card cannot re-rank into anything surprising, so no explicit entry is needed. |
| **the bottom line** | The cheapest face in the batch and the one with the highest ratio of true-things-said to cells-rendered: **four derived readouts over two controls**, three of which state facts (`2.5 ms above threshold`, `LEN reaches nothing above your input`, `these two jacks are currently the same signal`) that the module's own documentation either omits or contradicts. |
