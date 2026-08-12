# `macrooscillator` — the face SHIPPED (#1432). The PARTIAL REWRITE did not, and will not this way.

**What shipped** (`feat(faces): macrooscillator`, #1432): the face (3 bands, hero picture, STRIKE
audition, signal-flow + presets + readouts sidebar, 9 derived readouts, `scope` glyph),
`ParamDef.options` on `model`, `edge: 'trigger'` on `trig`, the `macro-engine-roster`
de-duplication, and the card bound through `paramSpec`. **Read the def.**

**What did NOT ship, and why it is not a backlog item in this shape:**

- **The three new params (`strike_decay`, `strike_colour`, `aux_level`) and the strike gate.**
  The design hung on `trig` becoming **patched-sensing** — presence detection over
  `inputs[1].length`. That **cannot work** once anything connects a keep-alive to that input, and
  the audition this face needs does exactly that. The failure is already in-tree: `sixstrum`'s
  factory permanently connects a `ConstantSource` to worklet input 2 (`sixstrum.ts:334-337`), so
  `inputs[2]` is *never* a zero-length array and the def's own documented normalling rule
  (`sixstrum.ts:226`, "a string with no patched strum at or below it is simply never struck") is
  **unreachable in the shipped engine** — 14 lines below a comment claiming "NO silence keep-alives
  on the inputs". **A presence-detecting design over a pinned input is silently inert, and no gate
  in this repo can see it.** A future strike gate needs a different mechanism than an input channel
  count. It is also a DSP change, so it never belonged in a face wave.
- **The `engine-roster` custom sidebar** — the generic `presets` block does it better, and
  `ParamDef.options` already names all fourteen in the MODEL selector.

**Re-derived on `main` at build time, correcting the measurements below:**
- **"HARMONICS is a quantiser in FIVE engines" is WRONG — it is FOUR.** WAVETABLE is a genuine
  BLEND (41/41 distinct renders over a sweep), not an 8-bucket quantiser.
  FM 2OP 8, CHORD 8, MODAL 4, SPEECH 6.
- **The engine level spread is 76.6 dB** (FM 2OP −5.0 dBFS … MODAL −81.6), not 75.
- **MODAL**: −69.6 dBFS at Q 5 → −86.6 at Q 200; first non-zero sample #11999 = **250.0 ms exactly**.
- **GRANULAR's MORPH is a 3-POSITION SWITCH** (bounds 0.33 / 0.66). Not in this spec at all, and
  nothing in the repo said so before the build.
- `face.hint` / `face.title` are ANNOTATION-ONLY and do not paint at rest.

The four defects (WAVETABLE dead morph half, GRANULAR 3-step morph, MODAL inverted timbre, the
76.6 dB spread) are **documented on the face, not fixed** — each is worklet arithmetic and its own
owner-audition PR. The face's claims are re-derived from `macrooscillatorMath` in
`macrooscillator-face-model.test.ts`, so when one of them IS fixed the stale claim goes red.

---

## 1. WHAT IT ACTUALLY DOES

Fourteen engines, selected by `Math.round(model)` clamped 0..13
(`packages/dsp/src/macrooscillator.ts:1514`), dispatched by the if/else ladder at `:1540-1554`.
**Every engine ticks every sample regardless of selection** (`:1525-1538`) — the CPU cost is
unconditional and 14×, which is *deliberate* (it makes MODEL changes phase-continuous) and is
also §3-M's over-promise.

| # | engine | method | lines |
|---|---|---|---|
| 0 | VA | two phase accumulators, morphed saw/square/tri, summed ×0.5, then `wavefold` | `:179-271` |
| 1 | WAVESHAPE | sine + sub body ×drive `1+timbre·7`, crossfade `sin(·π/2)` ↔ `tanh`, ÷√drive | `:275-325` |
| 2 | FM 2-OP | Chowning; ratio pair from an 8-entry table by `floor(h·8)`; index `t·8`; 1-sample carrier feedback `morph·π` | `:343-396` |
| 3 | FM 6-OP | fixed algorithm 4→3→2→1→carrier + self-FM op5; **per-op exponential envelope `0.05·100^morph` s** | `:412-475` |
| 4 | CHORD | 4 fixed-cost voices, 8-entry interval table by `floor(h·8)`; sine↔saw by timbre; voices 1-3 gated by morph | `:493-553` |
| 5 | ADDITIVE | 16 partials, stretch `n·f·(1+h·0.1·(n−1))`, tilt `1/n^(0.5+1.5t)`, odd/even morph | `:563-627` |
| 6 | STRING | Karplus-Strong, 2400-sample line, **integer delay** `round(sr/f)`, loop LP 200..12 k, stiffness allpass, gain 0.998 | `:644-746` |
| 7 | MODAL | 6 RBJ band-passes on 4 ratio presets, Q `5+195t`, excited by a **fixed 4 Hz impulse train** | `:771-854` |
| 8 | KICK | swept sine; pitch env 30 ms, amp env `0.05+1.45·morph` s, click env 3 ms × timbre | `:861-922` |
| 9 | SNARE | two body sines (f, 1.5f) + HP'd LCG noise; `harmonics` = tone/noise crossfade | `:926-989` |
| 10 | HIHAT | 6 incommensurate squares → noise by timbre → one RBJ band-pass 2..10 kHz, Q 0.7 | `:997-1073` |
| 11 | WAVETABLE | 8 **analytic** frames blended by `h·7`, phase-warp by morph, one-pole LP by timbre | `:1126-1179` |
| 12 | GRANULAR | 8-grain pool, spawn 5..200 Hz, fixed 10 ms grains, ±6 % jitter, 3 windows, ÷√active | `:1198-1296` |
| 13 | SPEECH | glottal pulse or noise by morph → 3 RBJ band-passes on a 6-vowel table, ×4.0 | `:1318-1407` |

**Shared code is almost nil.** Only `polyBlep` (`:154-164`, used **exclusively by VA**) and
`wavefold` (`:170-175`, likewise). Every other engine is standalone: three separate inline RBJ
band-pass implementations (`:825-836`, `:1052-1061`, `:1382-1391`) and **six** private
Park-Miller LCGs.

**Pitch** (`:1488-1491`): `semitones = pitchV·12 + note`;
`freq = 261.6256·2^(semitones/12)` clamped [1 Hz, 20 kHz]. `pitch` is V/oct with 0 V = C4;
`note` is a single ±60 st fader at `curve: 'linear'` — **120 semitones on one fader, no
coarse/fine split**.

**Antialiasing**: none anywhere except VA's polyBLEP'd saw and square. CHORD's saw
(`:538`, with an explicit "aliasing risk is real" admission at `:517-521`), WAVETABLE frames
2/3/4/5/7, HIHAT's six squares and ADDITIVE are all naive.

### The four-knob scheme is the module's biggest problem

`model` / `note` / `harmonics` / `timbre` / `morph` / `level` — **all six are global. None is
per-engine, and there is no mechanism — no `node.data`, no secondary bank — to remember a
per-engine setting.**

**HARMONICS is a QUANTISER in four engines and a continuous control in the other ten**, with no UI
signal of which: FM2's 8 ratio buckets (`:366`), CHORD's 8 shapes (`:509`), MODAL's 4 presets
(`:795`), SPEECH's 6 vowels (`:1362`). (WAVETABLE's 8-frame blend at `:1152` looked like a fifth
and is not — it is a genuine blend.) The same fader is a switch or a knob depending on `model`.
And `floor(h·N)` means **`harmonics = 1.0` exactly overflows and clamps to the last index** —
measured: `h = 0.875` and `h = 1.000` both give FM2 ratio index 7, so the last bucket is reachable
over `[0.875, 1.0]` while 1.0 is degenerate. **That per-engine reinterpretation is what the shipped
`macro-harmonics-meaning` readout exists to make visible.**

### The two outputs, and the two personalities

`out` and `aux`, both mono audio. Per engine, `aux` is a *sibling rendering of the same note* —
sub-octave triangle (VA `:267`), pre-drive body (WAVESHAPE `:321`), clean carrier (FM2 `:392`,
FM6 `:471`), root sine (CHORD `:546`), fundamental partial (ADDITIVE `:620`), raw delay tap
(STRING `:744`), fundamental mode (MODAL `:844`), body (KICK `:919`, SNARE `:986`), raw metallic
cluster (HIHAT `:1070`), pre-filter waveform (WAVETABLE `:1177`), spawn-phase sine
(GRANULAR `:1290`), glottal pulse (SPEECH `:1404`). **`out` is level-scaled; `aux` is deliberately
NOT** (`:1556-1560`) — see §3-H.

**No envelope, no gate, no accent.** Five engines carry *private, non-configurable* envelopes
(FM6 `:439-447`, KICK `:892-907`, SNARE `:959-966`, HIHAT `:1030-1032`, STRING's excitation
`:697-703`); the other nine free-run forever. `level` is the only gain stage and it is a static
scalar. The `trig` input **only RESETS all fourteen engines** on a rising edge (`:1494-1508`) — it
is a *retrigger*, not a note-on. Consequently KICK / SNARE / HIHAT / STRING have their envelope and
excitation fields initialised to **0** (`:866-868, :930-935, :1001, :656`) and are **silent forever
until a `trig` edge arrives** — which is why `e2e/tests/_drivers.ts` and
`coverage-group-2-sources.spec.ts` both declare `gatePort: 'trig'`. Add FM6, whose envelopes decay
unconditionally (§3-M), and **five of fourteen engines are unplayable without a cable.** The
shipped face's STRIKE audition is the saved-rack-neutral answer to that.

---

## 2. THE SAVED-RACK RULES — general, and they outlive this spec

Persistence has **no per-module migration substrate**: `schemaVersion` / `moduleSchemas` were
*removed* (`packages/web/src/lib/graph/persistence.ts`), and a saved rack is a bare
`Record<string, number>`. Rehydration is a single loop: `node.params[id] ?? def.defaultValue`.

| change | what happens to a saved rack | verdict |
|---|---|---|
| **ADD** a param | takes `defaultValue`; the rack sounds the same **iff that default reproduces current behaviour** | **SAFE, conditionally** |
| **REMOVE** a param | the stale key survives in the Y.Doc forever and is silently ignored | tolerable, but never for `model` |
| **RENUMBER `model`** | **every saved rack silently repatches to a different engine, and nothing can detect it** | **FORBIDDEN.** New engines append at index 14+; `MACRO_MAX_MODEL` only grows. |
| **NARROW a range** | the AudioParam silently clamps — a saved 0.9 becomes 0.5 with no marker | **FORBIDDEN.** Widen only. |
| **RE-INTERPRET an id** | the value is legal, so nothing clamps, nothing warns, and the sound changes | **FORBIDDEN.** |

The last row is why `level` was never repurposed as a note-loudness/accent, which is the obvious
move and the idiomatic one in the hardware this descends from. **A param that silently
re-interprets an existing saved value is worse than one that resets.** If accent is wanted it
arrives as a **new** `accent` ParamDef whose default reproduces today.

**OWNER DECISION, 2026-08-08:** *should the five envelope-carrying engines (FM6 / KICK / SNARE /
HIHAT / STRING) DRONE when unpatched?* — **NO.** They stay silent when unpatched, as today.

---

## 3. ALREADY-WRONG — measured, and still open on `main` unless marked

Measurements are from the pure-math mirror at SR 48000, pitch 0.75 V (440 Hz); the mirror is
algorithmically identical to the worklet except where noted in **N**.

- **A · MODAL (model 7) is inaudible.** At the def's defaults `mainRMS = 1.0e-4 (−79.9 dBFS)`,
  `mainPeak = 0.0028`. **Raising TIMBRE makes it quieter, not louder** (Q 5 → −66.0 dBFS;
  Q 200 → −82.4 dBFS), because an RBJ constant-skirt band-pass's impulse response scales with
  `alpha = sin(w0)/2Q`. The comment at `packages/dsp/src/macrooscillator.ts:848-851` ("At Q=200 a
  single bandpass impulse spikes to ~10-20 … a 0.25 scale keeps the macro near ±1") is **still
  there and flatly backwards**. Compounding it, the fixed 4 Hz impulse train (`:804`) means
  **MODAL is exactly 0.0 for the first 250 ms after every trig reset.**
- **C · WAVETABLE MORPH 0..0.5 is a bit-exact no-op.** `:1160-1165` still guards on `morph < 0.5`.
  Measured `maxAbsDiff` vs morph 0 is `0.000e+0` for morph ∈ {0, 0.1, 0.25, 0.49, 0.5} and `1.98`
  at morph ≥ 0.6. **Half a knob does literally nothing**, and the comment at `:1157-1159` also
  states the wrong wrap point (says 0.25, code wraps at 0.5).
- **D · `wavefold(x, 0)` is not identity.** `:170-175` yields `sin(x·π/2)`; measured
  `wavefold(0.5, 0) = 0.707107`. The docblock at `:166-169` still says "fold=0 is identity".
  Small-signal gain is **+3.92 dB** and VA is *always* shaped.
- **E · TIMBRE on VA is a volume control.** peak/RMS at h = 0, morph = 0:
  `t=0 → 0.9996/0.703`, `t=0.1 → 1.000/0.780`, `t=0.5 → 0.571/0.422`, `t=1 → 0.333/0.238` —
  **−9.5 dB of peak swing and non-monotonic RMS**, because the normaliser `Math.max(1, drive·0.5)`
  (`:174`) is flat for drive ≤ 2 then linear.
- **F · large DC offsets, no DC blocker anywhere.** FM2 at defaults: `mainDC = −0.3464` against
  `mainPeak = 0.64`; across morph: 0.00 → 0.0000, 0.50 → **−0.4330**, 1.00 → +0.0773. WAVETABLE
  reaches **−0.4297**; SPEECH's **aux** carries +0.1528 (the glottal pulse is asymmetric by
  construction, `:1343-1352`).
- **G · ~76 dB of level spread between engines at identical macro settings.** Measured OUT RMS at
  defaults: FM2OP −5.0, VA −9.9, KICK −9.4, WAVETABLE −9.7, FM6OP −14.1, GRANULAR −14.8,
  ADDITIVE −14.7, CHORD −17.9, SNARE −18.0, SPEECH −20.8, HIHAT −26.0, STRING −31.5,
  **MODAL −79.9**. Switching MODEL is a step change in loudness of up to 70 dB. **Fixing it is a
  per-engine trim table — a real audio change to every saved rack on 13 of 14 engines, so it is its
  own owner-audition PR.**
- **H · AUX is routinely far louder than OUT and is never level-scaled** — the worklet still does
  `outMain[i] = mainPick * lvl; outAux[i] = auxPick` (`:1556-1560`), with a comment claiming
  players "expect a steady amplitude". Aux RMS at defaults is −3.0 dBFS (a full-scale sine) for
  FM2OP, FM6OP, CHORD, ADDITIVE and GRANULAR against OUT at −5 to −18. **At `level = 0`, OUT peak
  is 0 and AUX peak is 1.0000.**
- **I · four engines exceed full scale at LEVEL = 1.** Grid max peaks: SPEECH **2.1211**,
  KICK **1.6380**, SNARE **1.1131**, STRING **1.0545**. **The "bounded" unit test is blind by
  construction:** the SPEECH one probes `h=1, t=1, m=1`
  (`packages/web/src/lib/audio/modules/macrooscillator.test.ts:1065-1076`) which is the
  **quietest** corner (peak 0.2166) — a textbook "gate that reads the wrong axis".
- **J · GRANULAR's AUX is not what its comment says.** `:1289-1290` calls it "clean source sine";
  it is `sin(2π · spawnTimer/spawnEvery)` — a full-scale sine at the **grain-spawn rate**.
  Measured `P(440 Hz) = 8.6e-18` vs `P(spawnRate) = 5.0e-1`. On a port declared `type: 'audio'`,
  `harmonics = 0` emits a **5 Hz sub-audio tone**.
- **K · KICK's AUX comment is false.** `:918` claims "clean body only (no click, **no pitch
  sweep**)", but `:919` reuses `this.phase`, which *is* the swept phase. Measured at timbre 0:
  `maxAbsDiff(main, aux) = 0.000e+0` — aux is bit-identical to main.
- **L · STRING is badly out of tune above ~880 Hz.** Integer delay only (`:688`, admitted at
  `:684-687`): measured error +1.4 ¢ at 440 Hz, **−14.4 ¢ at 880**, **+17.4 ¢ at 1760**,
  +315.6 ¢ at 20 kHz.
- **M · FM 6-OP cannot sustain, and the "glitch-free" claim over-promises.** Envelopes decay
  unconditionally (`:439-447`); measured RMS by 0.5 s window at morph 0:
  `1.10e-1 → 5.02e-6 → 2.28e-10 → 1.04e-14`. Even morph 1 is a 5 s decay, and OUT dies while AUX
  (un-enveloped, `:471`) rings at a constant −3.0 dBFS forever. So the def's "All 14 engines run
  every sample so switching MODEL is glitch-free" is true only for the nine free-running engines;
  switching *to* FM6/KICK/SNARE/HIHAT/STRING lands on a fully decayed voice.
  **(INFERENCE: the claim is about phase continuity, but as written it over-promises.)**
- **N · the mirror and the worklet diverge, and the tests exercise the mirror.**
  (i) HIHAT: the worklet seeds phases with `Math.random()`
  (`packages/dsp/src/macrooscillator.ts:1011`); the mirror uses fixed offsets. (ii) The mirror calls
  `str/kick/snare/hihat.reset()` up front, so **every unit and ART test measures an auto-struck
  voice the worklet never produces at t = 0.** The ART scenario's claim that it exercises "the same
  code path the worklet uses" (`art/scenarios/macrooscillator/spectral-character.test.ts:10-11`) is
  therefore false for model 10 and for the t = 0 state of models 6/8/9/10.
- **O · `model_cv` has half-width end buckets, and the SHARED doc contradicts the code.**
  `scaleCv` uses `Math.round(min + ((cv+1)/2)·span)`, so the measured CV span per model is
  `0: 0.0769 · 1..12: 0.1538 · 13: 0.0769` — **VA and SPEECH get half the CV real estate of every
  other engine.** Meanwhile `packages/web/src/lib/graph/types.ts:216` still documents discrete as
  `floor((cv+1)/2 * (max−min+1))` (equal buckets) — a doc/code divergence in the **shared**
  contract, not a macro-local one. Related: `model_cv` omits `center: 'default'`, so the LUT is
  baked against the MODEL fader's value **at cable-plug time** and moving the fader after patching
  MACSEQ offsets every selected engine.
- **Q · one surviving two-engine comment.** `packages/dsp/src/macrooscillator.ts:123` still says
  "Both models share:". (The def prose and the `module-manifest.ts` entries were corrected.)
  Separately, `e2e/tests/per-module-per-port-behavioral.spec.ts` exempts `harm_cv` on the grounds
  that it is a "harmonics knob no-op on default model (**sine**)" — model 0 is VA, not a sine, and
  harmonics *does* work there (measured beat rates 1.27 / 6.40 / 12.89 Hz at h = 0.1 / 0.5 / 1.0).
  The exemption's *conclusion* may hold; its stated *reason* is false.

**Closed:** **B** — the two byte-identical `MODEL_NAMES` tables (card-local + macseq) are gone;
both now re-export from `macro-engine-roster` and `ParamDef.options` carries the fourteen names on
the def. **P** — `trig` declares `edge=trigger` (`contract-lock.txt:1592`). **R** — the card is
bound through `paramSpec()`.

---

## 4. TWO THINGS THE MODULE STILL NEEDS FROM OUTSIDE THE FACE

- **`FaceReadoutValue` must see more than params.**
  `packages/web/src/lib/ui/workflow/face-readout-values.ts:176` is still
  `(read: (paramId) => number|undefined) => string`. Nothing on the shipped face needed the
  widening, because every readout here is a function of `model` + a param — but a pitch-dependent
  or sample-rate-dependent readout is not expressible. `{ read, sampleRate, readLive }` is the
  minimal shape; `engine.readParam` already returns *intrinsic + modulator tap*
  (`packages/web/src/lib/audio/engine.ts:737-747`). **analogVco asks for the identical widening.**
  (There is **no platform `inert` field** and there does not need to be — inertness is expressed
  through derived readouts.)
- **There is NO audio regression pin on a 14-engine module.**
  `art/scenarios/macrooscillator/spectral-character.test.ts` never calls
  `docsStrippedRepoSourceSha`; its 30 tests are pure spectral inequalities and there is **no
  `art/baselines/macrooscillator/`** — the module sits on `ART_BACKLOG`
  (`art/setup/profile-coverage.ts:71`). Any of the §3 fixes is an audio change with nothing pinned
  underneath it. ⚠ **Do NOT follow the old instruction to "lower `ART_BACKLOG_MAX`"** — that
  constant (`:120`) is one of the surviving hand-typed ratchets and is legacy, not precedent; per
  the repo standard, adding the profile means removing the entry, not re-scoping a count.
  (Note also: macrooscillator is the **reference profile** in the live interactive-doc allowlist,
  `packages/web/src/lib/docs/interactive/interactive-doc-modules.ts:59` — a card gaining
  `onMount`/rAF/canvas would break that allowlist's stated invariant, which is why the hero picture
  lives in the shell panel and not in the card.)
