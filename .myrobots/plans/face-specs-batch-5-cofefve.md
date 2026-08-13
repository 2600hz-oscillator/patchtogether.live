# cofefve — face record: the MEASUREMENTS, and what is still open

**SHIPPED.** archetype: **the BBD / tape stereo delay.** The proposed `face` block, the ranking
table and the band layout have been deleted from here — read the def.

**THE HEADLINE, and it is now encoded on the faceplate as `cofefve-asleep`:**

> **SEVEN of twenty-four controls are bit-exactly inert at the factory default, and every one of
> them is the dependent half of an enabler pair whose enabler ships at zero.**

**Method.** REAL factory → REAL worklet under `node-web-audio-api`'s `OfflineAudioContext`, 48 kHz,
C4 saw at −6 dBFS into both `inL` and `inR`, statistics over the tail half of a 2 s render.
Determinism control: `max|run1 − run2| = 0.000e+0`.

⚠ **Owner ruling 2026-08-11** (verbatim at `packages/web/src/lib/audio/modules/rings.ts:585-590`,
`:645-650`): *"we should prefer almost zero AI authored text, and all future faceplate work should
reflect that"* and *"lets stop doing these and clean up the existing ones, get rid of them. lose the
signal flow diagrams."* The band hints and their character-budget fallbacks this spec agonised over
are struck; the facts they carried are the `cofefve-wait-*` readouts, which are numbers.

---

## 0 · SHIPPED vs PROPOSED

**Matching:** `hero.cell: 'cofefve-echo-{n}'`, `hero.control: 'delayTime'`, `glyph: 'scope'`, and
six bands — with the "one under `DOCK_TAB_MIN_BANDS` (7), because a seventh flips the face to a tab
rail" reasoning carried into the def **verbatim** (`cofefve.ts:365`).

**Did NOT ship:**

| proposed | shipped |
|---|---|
| readout `time` / `cofefve-time-ms` | `waiting` / **`cofefve-asleep`** |
| readout `waiting` / `cofefve-inert-count` | `spacing` / **`cofefve-echo-spacing`** |
| readout `peak` / `cofefve-peak-est` | `repeats` / **`cofefve-repeats`** |
| `syncPeriod` in `face.order` | **dropped** — it is no longer a param (ledger B) |
| page ids `space`, `duckmix` | `stereo`, `output` |

The sidebar's five `cofefve-wait-*` readouts (`wow` / `duck` / `sync` / `pan` / `drive`) are the
enabler→dependent table shipped as live values rather than as prose.

---

## 1 · AT SPAWN

*Measured*, defaults: `outL` ≡ `outR`, peak 0.58977, rms **−11.63 dB**, centroid 7905 Hz,
DC −0.00021. The default is **dry-dominant** — with `dryVolume = 0` the wet path alone measures
**−17.62 dB**, 6 dB below the mixed output.

---

## 2 · THE SEVEN THAT DO NOTHING

The module's whole design problem in one table. *Measured*, each control swept over its full
declared range, first at the shipped default and then with its enabler opened.

| dependent | enabler (default) | `Δ` at the default | `Δ` with the enabler open |
|---|---|---|---|
| `lfoFrequency` | `lfoAmount` (**0**) | **0.00e+0** | **7.76e-1** at `lfoAmount 0.3` |
| `duckAttack` | `duckAmount` (**0**) | **0.00e+0** | 8.79e-2 at `duckAmount 5` |
| `duckRelease` | `duckAmount` (**0**) | **0.00e+0** | 1.13e-1 at `duckAmount 5` |
| `clockSource` | `tempoSync` (**0**) | **0.00e+0** | **5.73e-1** at `tempoSync 5` |
| `panMode` | `pan` (**0**) | **0.00e+0** | 4.51e-1 at `pan 0.8` |
| `driveMix` | `driveGain` (**0.1** of 10) | 6.38e-3 | **3.14e-1** at `driveGain 8` |
| `driveIterations` | `driveGain` (**0.1** of 10) | 6.8e-2 (at 12) | **5.34e-1** at `driveGain 8` |

**Five enablers, seven dependents, and every enabler ships closed.**

⚠ **`panMode` is NOT enabled by the LFO.** The obvious second hypothesis — ping-pong needs motion,
so the LFO should wake it — is **false**: measured `Δ = 0.00e+0` for `panMode` at
`lfoAmount = 0.3`. Only `pan ≠ 0` wakes it. A face that paired PAN MODE with the LFO would be
teaching a model the DSP does not have.

⚠ **`syncPeriod` COULD NOT BE MEASURED, and that was a finding of its own.** `Δ = 0.00e+0` at
`tempoSync = 0` **and** at `tempoSync = 5`. It is written by a host `setInterval(pushSyncPeriod, 16)`
that resolves the clock singleton's beat period — a main-thread timer that does not advance inside
an offline render. So the probe could not see it, **and the more interesting question it raised is
why a host-written value was a user-facing `ParamDef` with a `0..30 s` range on the card at all.**
Resolved — ledger B.

**The ranking rule the shipped `order` follows: an ENABLER always ranks above its dependents, and
never more than one rank apart.** That is the only ordering that makes a prefix of the list a
*usable* subset — the bluebox "every prefix is still a keypad" property, applied to a dependency
graph instead of a layout.

---

## 3 · FOUR MORE MEASURED FACTS

### A. Both volume controls exceed full scale, and they are the only gain stages

| | 0 | 0.4 | 0.8 | 1.2 | 1.6 | 2.0 |
|---|---|---|---|---|---|---|
| `dryVolume` peak | 0.325 | 0.335 | 0.490 | 0.690 | 0.890 | **1.089** |
| `wetVolume` peak | 0.500 | 0.572 | 0.644 | 0.810 | **1.025** | **1.240** |

Both are `0..2 linear`. **Nothing after them limits.**

### B. STEREO OFFSET is a real, measurable channel asymmetry — and it is antisymmetric

*Measured*, `outL` / `outR` rms dB:

| `stereoOffset` | −0.5 | −0.3 | −0.1 | +0.1 | +0.3 | +0.5 |
|---|---|---|---|---|---|---|
| `outL` | −10.53 | **−6.61** | −11.96 | −8.73 | −11.56 | −10.41 |
| `outR` | −10.41 | −11.56 | −8.73 | −11.96 | **−6.61** | −10.53 |

Exactly mirrored about zero to two decimals — the L row read backwards is the R row. A clean
control, and the only one on the module that makes a stereo image without the LFO.

### C. FILTER MODE is four positions worth 0.31 dB

`filterMode` 0/1/2/3 → rms −11.63 / −11.74 / −11.88 / −11.57 dB, `max|Δ|` 8.8e-2 / 1.65e-1 / 5.3e-2.
Real but tiny at the shipped `lowCut 0.75` / `highCut 0.001`. The mode changes the *slope*, and slope
is nearly invisible when the cutoffs sit at the ends of their ranges — which is where they ship.

### D. Both filter cutoffs ship at an END of their range

`lowCut` default **0.75** on `0.01..1`; `highCut` default **0.001** on `0.001..0.99` — the absolute
minimum. Measured `highCut` travel: rms −11.63 → −11.37 dB, `max|Δ| = 1.38e-1` over the whole range.
The tone section is effectively wide open at spawn and the mode control (§3-C) has almost nothing to
act on.

### E. The ranking's own measurements

`delayTime`: rms −11.54 → −6.03 dB across the range (5.5 dB, peaking around 96 ms where the echoes
align with the source). `feedback` is −1..+1 and **negative feedback is louder**: −8.66 dB at −1 vs
−9.35 at +1 vs −11.68 at +0.2.

---

## 4 · THE DERIVED READOUTS AND THEIR NEGATIVE CONTROLS

**A · the inert counter** (proposed as `cofefve-inert-count`, shipped as `cofefve-asleep`) — the
readout that *is* the module's argument. Prints how many controls are currently doing nothing:
**`7 waiting`** at the factory default, counting down as enablers open. Computed from the five
enabler params only.
*NEGATIVE CONTROL — `delayTime`:* must not move it (a time change wakes nothing).
*SECOND — `lfoAmount` 0 → 0.3:* must go `7 waiting` → `6 waiting`, which the measurement backs
(`lfoFrequency` `Δ` 0.00e+0 → 7.76e-1). **Both legs matter: a counter that only ever went down would
pass a one-sided test while being wrong about which control it was counting.**

**B · the effective delay time** (proposed as `cofefve-time-ms`; the shipped
`cofefve-echo-spacing` is the same quantity) — `delayTime` in ms when `tempoSync = 0`, the synced
division's period when not.
*NEGATIVE CONTROL — `delayTime` at `tempoSync = 5`:* the readout must **NOT** move, because the sync
overrides it (measured: `tempoSync` 1..11 changes the output at a fixed `delayTime`, `Δ` 3.25e-1 …
5.90e-1).
⚠ **State the units in the label.** `ms`, because the param is in **seconds** (`0.001..2 s`) and the
two differ by 1000×.

**C · the clip warning** (proposed as `cofefve-peak-est`; not shipped) — from `dryVolume` +
`wetVolume` + `driveGain`, anchored on §3-A (1.089 / 1.240 at the two volume maxima; 0.839 at
`driveGain 10`). Red above 1.00. *NEGATIVE CONTROL — `feedback`:* measured peak 0.565..0.825 across
the whole −1..+1 range, so the estimate must be nearly flat in feedback while it doubles in
`wetVolume`.

---

## 5 · DEFECT LEDGER

| # | item | verdict |
|---|---|---|
| **A** | **seven controls are inert at the factory default** (§2) | ⛔ **STILL OPEN, and it is a DEFAULTS QUESTION FOR THE OWNER**, not a bug in any one control: should `driveGain` ship at 0.1/10, and should PAN MODE be reachable without first moving PAN? **The face mitigates it — it does not answer it.** |
| **B** | `syncPeriod` was a host-written value exposed as a user `ParamDef` (`0..30 s`, default 0, pushed by a 16 ms `setInterval`) — either it is not a user control and should not be on the card, or it is and should not be overwritten 62 times a second | ✅ **FIXED** — `cofefve.ts:193` now reads *"⚠ `syncPeriod` USED TO BE DECLARED HERE AND IS NOT A PARAM"*, with the note that the worklet declares its own descriptor and the bridge writes it through `params.get('syncPeriod')`, so removing it from the def changed no audio and no wiring. |
| **C** | **`dryVolume`/`wetVolume` reach 1.089 / 1.240 peak with no limiter** (§3-A) | ⛔ **STILL OPEN** |
| **D** | `CofefveCard.svelte` re-typed 34 literal `min=`/`max=` props — the most of any card in the batch — while `cofefve` was in neither bound list, so the gate that exists for exactly this could not see it | ✅ **FIXED** — now in **both** `RANGE_BOUND_CARDS` (`card-range-source.test.ts:254`) and `MAPPING_BOUND_CARDS` (`:284`). Its `driveIterations` slider is a NATIVE `<input type=range>` whose `min="1" max="16"` STRING attributes the `min={…}` grep is structurally unable to see — bound anyway, because a gate's blind spot is not a licence to leave a second copy of a number. |
| **E** | batch 4 deferred `cofefve` alongside `charlottesEchos` on the grounds that "charlottes-echos is migrating to `analog-delay-core`" — but **cofefve IS the replacement**, with its own 209-line worklet and nothing to wait for | ✅ **OVERTURNED**, and recorded as a **process ruling**: *re-check a rejection against the code, not against the previous index.* |

**ART:** `cofefve` HAS an ART scenario (`art/scenarios/cofefve/`), so any fix for C re-pins — keep it
out of a face PR.
