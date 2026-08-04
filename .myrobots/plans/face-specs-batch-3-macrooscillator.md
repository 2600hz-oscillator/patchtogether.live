# FACE SPEC — `macrooscillator` (batch 3) — **PARTIAL REWRITE**

> ⚠ **STATUS CORRECTED 2026-08-04.** PF-20 (**PR #1301**) **HAS MERGED** (`c6ff9253`) — read
> the def on `main`, not `origin/feat/faceplate-platform-v2`. **macrooscillator is UNBUILT:
> this is LIVE BACKLOG, not stale.** `packages/web/src/lib/audio/modules/macrooscillator.ts`
> has not been touched since 2026-08-01, so the measurements below still stand — **and the
> collab-attest warning at §9 is still exactly right**: `e2e/tests/_drivers.ts` is in the
> collab attest basis, so this spec's PARTIAL REWRITE (three new params) drifts that hash
> and must land LAST among unmerged basis-touchers. Two platform facts landed after this
> was written: **PF-21 dock ROW PACKING** (`9bf12df7`), and **`face.title` / `face.hint` are
> ANNOTATION-ONLY** — `facePageHeader()` returns `null` unless annotate mode is on
> (`dock-faceplate-model.ts:90`; owner decision 2026-08-03).

**Status:** SPEC + MOCKUP ONLY — **UNBUILT, live backlog.** PF-20 platform (PR #1301 — MERGED, `c6ff9253`). Citations file:line;
inferences labelled. **This is the one module in the batch that needs NEW CONTROLS**, so it is
a face spec *and* a contract-change spec, and §6 is the part to read hardest — it is about what
happens to saved racks.

**Verdict: PROMOTE, with a scoped DSP addition.** · archetype: **the macro voice — fourteen
synthesis engines behind one four-knob scheme and two related outputs.**

⚠ **Two sources of truth exist and must be read together:** the worklet
`packages/dsp/src/macrooscillator.ts` (the audio that plays) and a hand-maintained **pure-math
mirror** inside the def at `packages/web/src/lib/audio/modules/macrooscillator.ts:70-854` (what
every unit test and the ART scenario actually exercise). They **diverge by design** in at least
two places (§7-N).

Not in `STRICT_FACES`; no `face:` block. 6 params, 8 in / 2 out. contract-lock block =
**18 lines** (`contract-lock.txt:1593-1610`: 1 meta + 8 in + 2 out + 6 param + 1 family).

---

## 1. WHAT IT ACTUALLY DOES

Fourteen engines, selected by `Math.round(model)` clamped 0..13
(`packages/dsp/src/macrooscillator.ts:1514`), dispatched by the if/else ladder at `:1540-1554`.
**Every engine ticks every sample regardless of selection** (`:1525-1538`) — the CPU cost is
unconditional and 14×, which is *deliberate* (it makes MODEL changes phase-continuous) and is
also §7-M's over-promise.

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

### The four-knob scheme is already ours — and it is already the module's biggest problem

`model` / `note` / `harmonics` / `timbre` / `morph` / `level`
(`macrooscillator.ts:882-889`; identical descriptors at `packages/dsp/src/macrooscillator.ts:1421-1427`).
**All six are global. None is per-engine, and there is no mechanism — no `node.data`, no
secondary bank — to remember a per-engine setting.**

**HARMONICS is a QUANTISER in five engines and a continuous control in the other nine**, with no
UI signal of which: FM2's 8 ratio buckets (`:366`), CHORD's 8 shapes (`:509`), MODAL's 4 presets
(`:795`), SPEECH's 6 vowels (`:1362`), WAVETABLE's 8-frame blend (`:1152`). The same fader is a
switch or a knob depending on `model`. And `floor(h·N)` means **`harmonics = 1.0` exactly
overflows and clamps to the last index** — measured: `h = 0.875` and `h = 1.000` both give FM2
ratio index 7, so the last bucket is reachable over `[0.875, 1.0]` while 1.0 is degenerate.

### The two outputs

`out` and `aux`, both mono audio (`macrooscillator.ts:878-881`;
`numberOfOutputs: 2, outputChannelCount: [1,1]` at `:955-959`). Per engine, `aux` is a
*sibling rendering of the same note* — sub-octave triangle (VA `:267`), pre-drive body
(WAVESHAPE `:321`), clean carrier (FM2 `:392`, FM6 `:471`), root sine (CHORD `:546`),
fundamental partial (ADDITIVE `:620`), raw delay tap (STRING `:744`), fundamental mode
(MODAL `:844`), body (KICK `:919`, SNARE `:986`), raw metallic cluster (HIHAT `:1070`),
pre-filter waveform (WAVETABLE `:1177`), spawn-phase sine (GRANULAR `:1290`), glottal pulse
(SPEECH `:1404`). **`out` is level-scaled; `aux` is deliberately NOT** (`:1557-1560`) — see §7-H,
this is a live defect, not a design.

### What is NOT here, and it is the shape of the rewrite

**No envelope, no gate, no accent.** There is no low-pass gate, no VCA stage, no shared envelope
generator. Five engines carry *private, non-configurable* envelopes (FM6 `:439-447`, KICK
`:892-907`, SNARE `:959-966`, HIHAT `:1030-1032`, STRING's excitation `:697-703`); the other
nine free-run forever. `level` (`:1556-1557`) is the only gain stage and it is a static scalar.

The `trig` input (`macrooscillator.ts:866`) exists, but **all it does is RESET all fourteen
engines** on a rising edge (`packages/dsp/src/macrooscillator.ts:1494-1508`). It is a *retrigger*,
not a note-on: nothing about the amplitude of the module responds to it.

**Consequence, and it is load-bearing for the design:** in the worklet, KICK / SNARE / HIHAT /
STRING have their envelope and excitation fields initialised to **0** (`:866-868, :930-935,
:1001, :656`), so **those four engines are silent forever until a `trig` rising edge arrives** —
which is why `e2e/tests/_drivers.ts:111-116` and
`e2e/tests/coverage-group-2-sources.spec.ts:58` both declare `gatePort: 'trig'`. Add FM6, whose
envelopes decay unconditionally (§7-M), and **five of fourteen engines are unplayable without a
cable.** The module has two personalities and no way to tell which one you are in.

---

## 2. THE PARTIAL REWRITE — what is added, what changes meaning, what must never move

### 2.1 THREE NEW ParamDefs

| id | label | range | curve | default | why the default is that number |
|---|---|---|---|---|---|
| `strike_decay` | `Decay` | 0..1 | linear | **0.35** | the internal strike envelope's decay. Only heard when `trig` is patched (§2.3), so the default is a taste call, not a compatibility constraint. |
| `strike_colour` | `Colour` | 0..1 | linear | **0.5** | the strike gate's VCA↔filter blend: 0 = the gate is a filter that tracks the envelope (dark, plucky), 1 = the gate is a pure VCA (bright). Same reason the default is free. |
| `aux_level` | `Aux` | 0..1 | linear | **1.0** | ⚠ **1.0 is not a taste call — it is the compatibility contract.** `aux` is unscaled today (`:1558-1560`), so a default of 1.0 makes every saved rack bit-identical. Any other default silently rewrites the level of an output that is *already* patched into people's racks. |

Plus **two CV jacks**: `decay_cv` → `strike_decay` and `colour_cv` → `strike_colour`, both
`cvScale: { mode: 'linear' }`, matching the existing five (`macrooscillator.ts:867-873`).

### 2.2 THE STRIKE GATE — the mechanism, in our own numbers

A new stage between the engine output and `level`, driven by an envelope that only exists while
`trig` is patched:

```
# ENVELOPE (per-block, at the 128-sample control rate)
attack_per_block = f0 · blockSize · 2 / sampleRate      # pitch-dependent: ~half a cycle of the note
short_decay      = (200 · blockSize / sampleRate) · 2^(−96·strike_decay/12)
decay_tail       = ( 20 · blockSize / sampleRate) · 2^((−72·strike_decay + 12·strike_colour)/12)
                   − short_decay
coeff            = short_decay + (1 − state⁴) · decay_tail       # FAST first, slowing into a long tail

# THE GATE
cutoff_norm = 0.003 + 0.3·state⁴ + strike_colour·0.04
hf_bleed    = ( tail² + (1 − tail²)·strike_colour ) · strike_colour²
out         = lowpass(x, cutoff_norm, Q 0.4) + ( x − lowpass(...) ) · hf_bleed
gain        = state
```

Two properties are the whole point and both are *testable*: the attack is **pitch-dependent**
(so a low note opens more slowly than a high one, which is what makes it read as an instrument
rather than as a gate applied to an oscillator), and **`strike_colour` appears in `decay_tail`**,
so colour and decay are deliberately **not orthogonal** — turning the gate brighter also makes it
ring longer. §5-D's negative control depends on that second property, so it must be implemented,
not approximated.

### 2.3 `trig` CHANGES MEANING — and this is the saved-rack question

**Today:** `trig` is a retrigger. Unpatched, nine engines drone and five are silent forever.

**Proposed:** `trig` becomes *patched-sensing*. Unpatched → no strike gate at all, module behaves
**exactly as today**. Patched → each rising edge resets the engines (as today) **and** fires the
strike envelope, and the gate is inserted.

Presence detection is free in Web Audio: an unconnected worklet input arrives as a zero-length
channel array, which is the same mechanism `pentemelodica` uses (`inputs[0].length >= 2`) and
`sixstrum` uses (`packages/dsp/src/sixstrum.ts:145-149`).

⚠ **THE HAZARD THAT KILLS IT IF NOT CHECKED FIRST: a keep-alive `ConstantSource` defeats
presence detection.** `sixstrum` demonstrates the failure in-tree — its factory permanently
connects a `ConstantSource` to worklet input 2 (`sixstrum.ts:334-337`), so `inputs[2]` is *never*
a zero-length array and the def's own documented normalling rule
(`sixstrum.ts:226`, "a string with no patched strum at or below it is simply never struck") is
**unreachable in the shipped engine** — 14 lines below a comment claiming "NO silence keep-alives
on the inputs" (`sixstrum.ts:319-323`). **Before building this: grep `macrooscillator.ts`'s
factory for a `ConstantSource` on the `trig` input, and if one exists, remove it or move the
keep-alive to a different input.** A presence-detecting design over a pinned input is silently
inert, and no gate in this repo can see it.

### 2.4 WHAT MUST NEVER MOVE — the saved-rack rules

Persistence has **no per-module migration substrate**: `schemaVersion` / `moduleSchemas` were
*removed* (`packages/web/src/lib/graph/persistence.ts:13, 29-30, 264`), and a saved rack is a
bare `Record<string, number>`. Rehydration is a single loop
(`macrooscillator.ts:962-965`): `node.params[id] ?? def.defaultValue`.

| change | what happens to a saved rack | verdict |
|---|---|---|
| **ADD** a param | takes `defaultValue`; the rack sounds the same iff that default is the current behaviour | **SAFE, and that is why `aux_level` defaults to 1.0** |
| **REMOVE** a param | the stale key survives in the Y.Doc forever and is silently ignored | tolerable, but never do it for `model` |
| **RENUMBER `model`** | **every saved rack silently repatches to a different engine, and nothing can detect it** | **FORBIDDEN.** New engines append at index 14+; `MACRO_MAX_MODEL` (`macrooscillator.ts:776`) only grows. |
| **NARROW a range** | the AudioParam silently clamps — a saved 0.9 becomes 0.5 with no marker | **FORBIDDEN.** Widen only. |
| **RE-INTERPRET an id** | the worst case: the value is legal, so nothing clamps, nothing warns, and the sound changes | **FORBIDDEN.** This is why `level` keeps its meaning (§2.5). |

### 2.5 THE ONE THING I AM *NOT* DOING, and why

The obvious move is to make `level` do double duty as a note-loudness/accent, the way it does in
the hardware idiom this design descends from. **Rejected.** `level` is a saved value in every
existing rack with a legal range; re-interpreting it would change the sound of those racks with
nothing able to notice. If accent is wanted later it arrives as a **new** `accent` ParamDef with
a default that reproduces today. That is the standing rule, stated once: **a param that silently
re-interprets an existing saved value is worse than one that resets.**

### 2.6 THE OWNER DECISION THIS SPEC DOES NOT MAKE

The design this descends from drones when unpatched and plucks when a cable lands, and the
*unpatched* half is what makes the module feel alive on a bare rack. Under §2.3, our five
envelope-carrying engines (FM6 / KICK / SNARE / HIHAT / STRING) stay **silent when unpatched**,
exactly as today. Making them drone would be more faithful and is **an audio change to saved
racks on five of fourteen engines**, so:

- **Default recommendation (saved-rack-neutral): ship §2.3 as written**, and give the module the
  audition action (§4) so those five engines are reachable without a cable.
- **If the owner wants the drone:** it is a separate, owner-audition PR that names all five
  engines and re-runs `art/scenarios/macrooscillator/spectral-character.test.ts`. Never fold it
  into a face wave.

---

## 3. THE CONTROLS THAT MATTER

With three new params the module has nine, and the lane budget is six
(`curated-face.ts:46, 65`).

| rank | control | why |
|---|---|---|
| 1 | `model` | the module *is* the engine; nothing else means anything until you know which of fourteen you are in. And it is the only control whose value changes what the other three knobs **mean**. |
| 2 | `harmonics` | the structural axis in every engine — chord, ratio, vowel, frame, spread. Also the one that is secretly a quantiser five times out of fourteen, which §5-A makes visible. |
| 3 | `timbre` | the brightness/density axis. |
| 4 | `morph` | the shape/decay axis. |
| 5 | `note` | ±60 st. Ranks below the three axes because on this module pitch is usually patched, not turned. |
| 6 | `strike_decay` | **NEW.** The first control of the new personality; the one you ride once a trigger is patched. |
| — | *lane budget ends here* | |
| 7 | `macro-strike-{n}` | **NEW — the audition.** Dock-only by the button-in-a-knob-column rule (a lane action degrades to a bare `▸`). |
| 8 | `macro-hero-{n}` | the picture. A `panel`'s first legal rank is 7 and this is 8. |
| 9 | `strike_colour` | **NEW.** Set-once character, not something you ride. |
| 10 | `aux_level` | **NEW.** A trim on the sibling output. |
| 11 | `level` | the static output gain. |

**LOSERS, named:**
- **`level` loses to everything**, including two params that do not exist yet, because it is the
  one control whose entire job is "make it quieter" and the module's real level problem is not
  solvable with it (§7-G: 75 dB of spread *between engines* at identical macro settings).
- **`strike_colour` loses to `strike_decay`** because decay is the gesture and colour is the
  voicing; you ride one and set the other. If the owner disagrees, swapping ranks 6 and 9 is a
  one-line change and nothing else moves.
- **`note` loses ranks 2-4** deliberately, against the usual "pitch first" instinct — on a module
  whose `pitch` port is V/oct and whose primary use is under a sequencer, a 120-semitone fader is
  a *trim*, and the three axes are what the hands are on.

---

## 4. THE FACE

```ts
face: {
  title: 'Macro voice',
  hint:
    'Fourteen engines behind one four-knob scheme. MODEL picks the engine; HARMONICS, TIMBRE and ' +
    'MORPH mean something different in each one — the readout under each dial says what they mean ' +
    'here. OUT and AUX are two renderings of the same note, not a stereo pair.',

  order: [
    'model', 'harmonics', 'timbre', 'morph', 'note', 'strike_decay',   // 1-6 = the lane budget
    'macro-strike-{n}', 'macro-hero-{n}',
    'strike_colour', 'aux_level', 'level',
  ],
  pages: [
    { id: 'engine', label: '1 · engine',
      hint: 'fourteen synthesis models on one selector — every engine runs every sample, so switching is phase-continuous',
      controls: ['macro-hero-{n}', 'macro-strike-{n}', 'model'] },
    { id: 'axes',   label: '2 · the three axes',
      hint: 'structure, brightness, shape — reinterpreted per engine; HARMONICS is a stepped selector in five of the fourteen',
      controls: ['harmonics', 'timbre', 'morph'] },
    { id: 'strike', label: '3 · strike',
      hint: 'inserted only while TRIGGER is patched: a pitch-tracking attack, then a decay that slows into its own tail. COLOUR also lengthens it.',
      controls: ['strike_decay', 'strike_colour'] },
    { id: 'out',    label: 'out · aux',
      hint: 'AUX is a sibling rendering of the same note sharing pitch, params and envelope — a sub-octave, a clean carrier, a raw exciter, depending on the engine',
      controls: ['note', 'level', 'aux_level'] },
  ],
  glyph: 'scope',

  // PF-1 VOCABULARY — 14 options on `model`, sourced from the def so the two
  // duplicate name tables die (§7-B). 14 > SEGMENTED_MAX_OPTIONS, so the dock
  // gets a <Selector> and every lane tier gets a dial with a persistent NAME
  // readout (shell-control-kind.ts:133-136). CONTRACT-TRANSPARENT.
  paramCells: {},  // NOT 'grid' — engine names are words, not pictures.

  hero: {
    cell:    'macro-hero-{n}',
    control: 'model',
    action:  'macro-strike-{n}',
    readouts: [
      { label: 'harmonics', valueId: 'macro-harmonics-meaning' },
      { label: 'strike',    valueId: 'macro-strike-ms' },
      { label: 'aux',       valueId: 'macro-aux-offset' },
    ],
  },

  sidebar: [
    { kind: 'signal-flow', label: 'signal flow', stages: [
      { label: 'PITCH',        role: 'generator', note: 'v/oct + note' },
      { label: 'ENGINE ×14',   role: 'generator', note: 'all tick, one is heard' },
      { label: 'STRIKE ENV',   role: 'bus', parallel: true, note: 'only when patched' },
      { label: 'STRIKE GATE',  role: 'bus', note: 'filter ↔ VCA by COLOUR' },
      { label: 'LEVEL',        role: 'bus', note: 'OUT only' },
      { label: 'OUT',          role: 'bus', note: 'the voice' },
      { label: 'AUX',          role: 'bus', parallel: true, note: 'the sibling' },
    ] },
    { kind: 'custom', label: 'engine map', panelId: 'engine-roster',
      props: { paramId: 'model' } },
    { kind: 'readouts', label: 'this engine', entries: [
      { label: 'harmonics', valueId: 'macro-harmonics-meaning' },
      { label: 'timbre',    valueId: 'macro-timbre-meaning' },
      { label: 'morph',     valueId: 'macro-morph-meaning' },
      { label: 'aux is',    valueId: 'macro-aux-meaning' },
      { label: 'band-limited', valueId: 'macro-alias' },
    ] },
  ],
}
```

**⚠ `AUX` is `parallel: true` and so is `STRIKE ENV`.** AUX is not downstream of LEVEL — it
leaves the engine and bypasses it entirely (`:1557-1560`), which is §7-H's whole point; drawing
it inline would teach that turning LEVEL down quietens both outputs. It does not. STRIKE ENV is
a control signal, not an audio stage.

---

## 5. DERIVED READOUTS

### A. `macro-harmonics-meaning` — the best readout on this module

For the five quantising engines, resolve and print the bucket; for the other nine, print the
continuous meaning.

```
FM2   : idx = min(7, floor(harmonics·8))  → "ratio 3:2 · step 7 of 8"      # :366, :332-341
CHORD : idx = min(7, floor(harmonics·8))  → "shape 5 of 8"                 # :509, :482-491
MODAL : idx = min(3, floor(harmonics·4))  → "preset 2 of 4"                # :795, :756-767
SPEECH: idx = min(5, floor(harmonics·6))  → "vowel 4 of 6"                 # :1362, :1303-1316
WAVET.: f   = harmonics·7                 → "frame 4→5, 30 %"              # :1152
others: a per-engine noun ("detune", "curve", "spread", "bumps", …)
```

**NEGATIVE CONTROL — change `model` with `harmonics` untouched.** A `paramId: 'harmonics'`
readout prints `0.75` in every one of the fourteen states. The derived readout flips from
`"ratio 3:2 · step 7 of 8"` to `"stretch · continuous"` — and *that difference is the module's
single worst usability problem made visible.* **Second control:** move `harmonics` 0.80 → 0.87
on FM2 — the knob moves 7 %, the bucket does **not** (both are index 6), so a readout that moved
would be echoing the fader rather than the engine. Both legs together are what make this an
instrument.

⚠ It also exposes the overflow: `harmonics = 1.000` and `harmonics = 0.875` both print
`step 8 of 8` on FM2 (measured), which is the honest report of `floor(h·N)`.

### B. `macro-timbre-meaning` / `macro-morph-meaning` / `macro-aux-meaning`
Per-engine nouns from the same table. **NEGATIVE CONTROL:** all three must move on a MODEL change
and must **not** move on a `timbre`/`morph` change. A readout that reacts to the knob it labels is
the failure mode; a readout that reacts only to `model` is correct here **by construction**, and
that is the assertion.

### C. `macro-strike-ms` — the strike gate's own −60 dB time (post-rewrite)
```
short_decay = (200·blockSize/sr) · 2^(−96·strike_decay/12)
decay_tail  = ( 20·blockSize/sr) · 2^((−72·strike_decay + 12·strike_colour)/12) − short_decay
t60_blocks  = ∫ over the state⁴-slowed coefficient (closed form in the model module)
```
**NEGATIVE CONTROL — `strike_colour`.** By §2.2's construction, colour appears in `decay_tail`,
so brightening the gate **lengthens** it. A `paramId: 'strike_decay'` readout is invariant to
colour and prints the same number while the tail genuinely grows. **Second control — pitch.** The
attack is `f0·blockSize·2/sr`, so patching a note two octaves up shortens the attack with no
param moving at all. (⚠ pitch is not a param — see §8, this leg needs the widened reader.)

### D. `macro-aux-offset` — the OUT/AUX imbalance, from the DSP's own law
```
offset_dB = 20·log10( aux_level / max(level, 1e-4) )        # :1556-1560, aux is NOT level-scaled
```
**NEGATIVE CONTROL — turn `level` to 0.** OUT goes silent; the readout must print a large positive
offset, because *measured*, at `level = 0`, OUT peak is `0` and **AUX peak is 1.0000**. A
`paramId: 'level'` readout prints `0.00` and says nothing at all about the output that is still
at full scale. **Second leg:** move `aux_level` — the offset must move by exactly the same dB, or
the derivation is not reading the law it claims to.
*(Optional refinement, clearly labelled as measurement not law: add the per-engine offset from
the measured table in §7-G. Do not present that half as derived from the source.)*

### E. `macro-alias` — one band-limited engine out of fourteen
Text, from `model`: `"polyBLEP"` for model 0 (`:230, :234-238`) and `"naive"` otherwise
(§1). **NEGATIVE CONTROL:** move `model` 0 → 1; it must flip. Move `note` +36 st; it must **not**
(band-limiting is a property of the engine, not the pitch), even though the *audible* aliasing
changes enormously — which is exactly why the number to print alongside it is a harmonic count,
not a verdict.

---

## 6. BESPOKE CELL vs PLATFORM

**LEGITIMATE — `macro-hero-{n}`:** a single-cycle / short-window rendering of the **current
engine at the current three axes**, with OUT drawn solid and AUX drawn as a ghost, plus the
strike envelope overlaid when `trig` is patched. It is the only picture that answers "what does
this engine sound like here", and no def introspection produces it. **It also does something the
sidebar cannot:** it makes the OUT/AUX level imbalance (§7-H) visible as two traces of obviously
different height.

**LEGITIMATE — `engine-roster`, a `custom` sidebar panel:** a 14-row list, the current row lit,
each row carrying the engine's name and its three axis nouns. Generic (a discrete-options roster,
`props: { paramId }`) so any future many-option module reuses it.

**NOT LEGITIMATE:** a bespoke component for the axis readouts, the flow diagram or the output
numbers — those are `readouts` / `signal-flow` blocks.

**AND — `face.paramCells` stays EMPTY.** `'grid'` is for states that are *pictures* (the DX7's 32
algorithm diagrams). Engine names are **words**, so `model` gets `ParamDef.options` and the
platform picks `Selector` at the dock (14 > `SEGMENTED_MAX_OPTIONS`) and a dial with a persistent
name readout at every lane tier (`shell-control-kind.ts:133-136`).

---

## 7. ALREADY-WRONG — measured, and this list is why the rewrite is scoped the way it is

Measurements below are from the pure-math mirror at SR 48000, pitch 0.75 V (440 Hz); the mirror
is algorithmically identical to the worklet except where noted in **N**.

- **A · MODAL (model 7) is inaudible.** At the def's defaults `mainRMS = 1.0e-4 (−79.9 dBFS)`,
  `mainPeak = 0.0028`. **Raising TIMBRE makes it quieter, not louder** (Q 5 → −66.0 dBFS;
  Q 200 → −82.4 dBFS), because an RBJ constant-skirt band-pass's impulse response scales with
  `alpha = sin(w0)/2Q`. The comment at `packages/dsp/src/macrooscillator.ts:847-851` ("At Q=200 a
  single bandpass impulse spikes to ~10-20 … a 0.25 scale keeps the macro near ±1") is **flatly
  backwards**. Compounding it, the fixed 4 Hz impulse train (`:804`) means **MODAL is exactly 0.0
  for the first 250 ms after every trig reset** (measured `maxPeak 0.0000` over a full h/t/m grid
  at 0.2 s).
- **B · two duplicate engine-name tables, neither in the def.** `MODEL_NAMES`
  (`packages/web/src/lib/ui/modules/MacrooscillatorCard.svelte:30-34`, not exported) and a
  **byte-identical second copy** at `packages/web/src/lib/audio/modules/macseq.ts:99-115`, whose
  own comment admits it is "duplicated from MacrooscillatorCard.svelte's local copy rather than
  imported". macseq's copy has a drift guard; the card's does not. Three places encode "14
  engines": `MACRO_MAX_MODEL = 13` (`macrooscillator.ts:776`), the card's array length, and the
  worklet's hard-coded `maxValue: 13` + `Math.min(13, …)`. **`ParamDef.options` (§4) collapses
  all three into the def and is contract-transparent.**
- **C · WAVETABLE MORPH 0..0.5 is a bit-exact no-op.** `:1160-1165` guards on `morph < 0.5`.
  Measured `maxAbsDiff` vs morph 0 is `0.000e+0` for morph ∈ {0, 0.1, 0.25, 0.49, 0.5} and `1.98`
  at morph ≥ 0.6. **Half a knob does literally nothing**, and the comment at `:1157-1159` also
  states the wrong wrap point (says 0.25, code wraps at 0.5).
- **D · `wavefold(x, 0)` is not identity.** `:170-175` yields `sin(x·π/2)`; measured
  `wavefold(0.5, 0) = 0.707107`. The docblock at `:167-169` says "fold = 0 is identity".
  Small-signal gain is **+3.92 dB** and VA is *always* shaped.
- **E · TIMBRE on VA is a volume control.** peak/RMS at h = 0, morph = 0:
  `t=0 → 0.9996/0.703`, `t=0.1 → 1.000/0.780`, `t=0.5 → 0.571/0.422`, `t=1 → 0.333/0.238` —
  **−9.5 dB of peak swing and non-monotonic RMS**, because the normaliser `Math.max(1, drive·0.5)`
  (`:174`) is flat for drive ≤ 2 then linear.
- **F · large DC offsets, no DC blocker anywhere.** FM2 at defaults: `mainDC = −0.3464` against
  `mainPeak = 0.64`; across morph: 0.00 → 0.0000, 0.50 → **−0.4330**, 1.00 → +0.0773. WAVETABLE
  reaches **−0.4297**; SPEECH's **aux** carries +0.1528 (the glottal pulse is asymmetric by
  construction, `:1343-1352`).
- **G · 75 dB of level spread between engines at identical macro settings.** Measured OUT RMS at
  defaults: FM2OP −5.0, VA −9.9, KICK −9.4, WAVETABLE −9.7, FM6OP −14.1, GRANULAR −14.8,
  ADDITIVE −14.7, CHORD −17.9, SNARE −18.0, SPEECH −20.8, HIHAT −26.0, STRING −31.5,
  **MODAL −79.9**. Switching MODEL is a step change in loudness of up to 70 dB. **Fixing this is a
  per-engine trim table — a real audio change to every saved rack on 13 of 14 engines, so it is
  its own owner-audition PR and is NOT in this spec.**
- **H · AUX is routinely far louder than OUT and is never level-scaled** (`:1557-1560`). Aux RMS
  at defaults is −3.0 dBFS (a full-scale sine) for FM2OP, FM6OP, CHORD, ADDITIVE and GRANULAR
  against OUT at −5 to −18. **At `level = 0`, OUT peak is 0 and AUX peak is 1.0000.** `aux_level`
  (§2.1) gives it a control without changing a single saved rack.
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
  (un-enveloped, `:471`) rings at a constant −3.0 dBFS forever. So `macrooscillator.ts:893`
  ("All 14 engines run every sample so switching MODEL is glitch-free") is true only for the nine
  free-running engines; switching *to* FM6/KICK/SNARE/HIHAT/STRING lands on a fully decayed voice.
  **(INFERENCE: the claim is about phase continuity, but as written it over-promises.)**
- **N · the mirror and the worklet diverge, and the tests exercise the mirror.**
  (i) HIHAT: the worklet seeds phases with `Math.random()`
  (`packages/dsp/src/macrooscillator.ts:1011`); the mirror uses fixed offsets
  (`macrooscillator.ts:394`). (ii) The mirror calls `str/kick/snare/hihat.reset()` up front
  (`:804-807`), so **every unit and ART test measures an auto-struck voice the worklet never
  produces at t = 0.** The ART scenario's claim that it exercises "the same code path the worklet
  uses" (`art/scenarios/macrooscillator/spectral-character.test.ts:10-11`) is therefore false for
  model 10 and for the t = 0 state of models 6/8/9/10.
- **O · `model_cv` has half-width end buckets, and the shared doc contradicts the code.**
  `scaleCv` uses `Math.round(min + ((cv+1)/2)·span)`
  (`packages/web/src/lib/audio/cv-scale.ts:78-82`), so the measured CV span per model is
  `0: 0.0769 · 1..12: 0.1538 · 13: 0.0769` — **VA and SPEECH get half the CV real estate of every
  other engine.** Meanwhile `packages/web/src/lib/graph/types.ts:216-217` documents discrete as
  `floor((cv+1)/2 · (max−min+1))` (equal buckets) — a doc/code divergence in the **shared**
  contract, not a macro-local one. Related: `model_cv` omits `center: 'default'`
  (`macrooscillator.ts:871`; the option exists at `types.ts:243`), so the LUT is baked against the
  MODEL fader's value **at cable-plug time** (`engine.ts:437-443`, "hot-rebuild … is left to a
  follow-up") and moving the fader after patching MACSEQ offsets every selected engine.
- **P · `trig` declares no `edge:`** (`macrooscillator.ts:866`) despite being a strict rising-edge
  trigger (`packages/dsp/src/macrooscillator.ts:1494`), so `module-docs-lint`'s vocabulary gate is
  **skipped entirely** for this module (`module-docs-lint.test.ts:217`) while its prose
  (`macrooscillator.ts:897-898`) uses full trigger vocabulary. Declare `edge: 'trigger'`.
- **Q · four places still describe a two-engine module.** `macrooscillator.ts:5-6` ("Two models
  shipped in this first slice: VA and WAVESHAPE"), `:22-24` and `:45-46` (AUX as VA/WAVESHAPE
  only), `packages/dsp/src/macrooscillator.ts:123` ("Both models share:"), and
  `packages/web/src/lib/docs/module-manifest.ts:318` + `:701-708` ("0 = VA, 1 = WAVESHAPE …
  More models … land in follow-up PRs"). Fourteen engines have shipped. Separately,
  `e2e/tests/per-module-per-port-behavioral.spec.ts:1202-1206` exempts `harm_cv` on the grounds
  that it is a "harmonics knob no-op on default model (**sine**)" — model 0 is VA, not a sine, and
  harmonics *does* work there (measured beat rates 1.27 / 6.40 / 12.89 Hz at h = 0.1 / 0.5 / 1.0).
  The exemption's *conclusion* may hold; its stated *reason* is false.
- **R · the card re-types every range** (`MacrooscillatorCard.svelte:50-55`) while importing
  `macrooscillatorDef` (`:11`) and even having a `defaultFor()` helper (`:20-21`). All six agree
  today. Fix with `paramSpec()` in the same PR.

---

## 8. THE PLATFORM EXTENSIONS THIS SPEC NEEDS

1. **`FaceReadoutValue` must see more than params** (the same ask as `analogVco`). §5-C's second
   leg is a function of the *played pitch*; §5-E's harmonic count needs `sampleRate`. Widen the
   reader to `{ read, sampleRate, readLive }` — `engine.readParam` already returns
   *intrinsic + modulator tap* (`packages/web/src/lib/audio/engine.ts:737-747`).
2. **An `action` cell that calls `engine.read(node, 'manualTrigger')`.** ⚠ Round 2's specs
   invented a false blocker here twice; it is **not** one.
   `packages/web/src/lib/audio/engine-ref.ts:23` exports `getActiveEngine()` precisely for code
   outside the Svelte context tree, and it is already called from plain `.ts` modules
   (`clipplayer.ts`, `push2-control.svelte.ts`). No platform change is required for the audition.

---

## 9. COST

| | |
|---|---|
| **contract-lock** | **+7 lines, +1 modified.** 3 new `param` lines (`strike_decay`, `strike_colour`, `aux_level`), 2 new `in` lines (`decay_cv`, `colour_cv`), 2 new `family` lines (`macro-hero` kind=cell, `macro-strike` kind=other), and `macrooscillator in trig gate` → `… edge=trigger`. 18 → 25 lines. **`ParamDef.options` on `model` is contract-transparent** (`contract-signature.ts` emits `id min..max curve default=X unit=Y` only). macrooscillator is in `STRICT_DOCS` (`strict-docs.ts:49`), so **every** new port/param/family needs a `docs.*` key or `module-docs-lint` goes red. |
| **collab attest** | ⚠ **`e2e/tests/_drivers.ts` IS in the collab attest basis** (`scripts/collab-attest-lib.ts:98`) and macrooscillator has an entry at `_drivers.ts:111-116` whose `params:` block lists all six defaults. **Adding a ParamDef that needs a driver default drifts the collab attest hash** — budget a re-attest, and land it LAST among unmerged basis-touchers. |
| **ART** | **No pin exists.** `art/scenarios/macrooscillator/spectral-character.test.ts` never calls `docsStrippedRepoSourceSha`; its 30 tests are pure spectral inequalities and there is **no `art/baselines/macrooscillator/`** — the module is on `ART_BACKLOG` (`art/setup/profile-coverage.ts:82`). So the DSP addition costs no `.f32` re-pin. ⚠ That is also a *finding*: a partial rewrite of a 14-engine module with **no audio regression pin** is exactly when to add one, which means removing it from `ART_BACKLOG` and lowering `ART_BACKLOG_MAX`. |
| **Push 2** | No `PUSH_CARD_CONTROLS` entry, so the card is generic-tier and **will silently re-rank when the three params land** (`push-card-config.ts`; the CLAUDE.md warning). Give macrooscillator an explicit entry in the same PR. |
| **VRT** | `vrt.spec.ts/{darwin,linux}/macrooscillator.png` both committed, **and the linux pair was drained on 2026-08-01** (`e2e/vrt/vrt-exemptions.ts:1197-1199`) — so a card change **will** move a real linux baseline. Not in `STRICT_VRT_MODULES`, so it is the informational lane, not the required gate. New face scenes: `face-macrooscillator-{compact,dock}` × 2 = 4. |
| **interactive docs** | macrooscillator is the **reference profile** in the live interactive-doc allowlist (`packages/web/src/lib/docs/interactive/interactive-doc-modules.ts:37-44`). A card gaining `onMount`/rAF/canvas would break that allowlist's stated invariant — keep the hero picture in the **shell panel**, not in the card. |
| **e2e** | +1 `faces-parity` row (11 cells) in the REQUIRED lane, plus a bespoke audition spec with a before/after negative control (assert scope peak ≈ 0 before the click and > threshold after — faces-parity's `action` branch asserts only `toBeEnabled()` then clicks, so it **cannot fail on a dead button**). |
