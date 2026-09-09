# FACE SPEC — `attenumix` (batch 4)

> **Two owner rulings, 2026-08-11, apply to this file** (verbatim at
> `rings.ts:585-590` and `:645-650`): *"we should prefer almost zero AI authored
> text, and all future faceplate work should reflect that"* and *"lets stop doing
> these and clean up the existing ones, get rid of them. lose the signal flow
> diagrams."* Every proposed `hint` and the `signal-flow` sidebar block have been
> **deleted** from §5; their measured content is in §4. Do not re-author them.
> Measurements belong in `docs.controls` (the `rings.ts:592-596` precedent), not
> on the panel.

## 0. STATUS

**Authored 2026-08-09 against `main` at `ecc48f2e`. UNBUILT** — `attenumix.ts`
still has no `face:` block.

**Verdict: PROMOTE.** archetype: **the UTILITY MIXER** — the module the palette
calls "the simple mixer", and the one most likely to be spawned by someone who
just wants two things to come out of one cable.

Not in `STRICT_FACES`. In `STRICT_DOCS`; **not** in `STRICT_VRT_MODULES`; **not**
in `card-range-source.test.ts`. 5 params, 8 in, 5 out. contract-lock = **19 lines**.

**Method.** `packages/dsp/src/attenumix.ts` bundled with esbuild against stub
worklet globals, run offline at 48 kHz. THD is `√(Σ h2..h20²)/h1` on a 250 Hz
Hann-windowed Goertzel set. **Harness validation: measured mix peaks match
`tanh()` to five decimals — 0.46212 = tanh(0.5)** — which confirms the harness
reaches the real math.

---

## 1. WHAT IT ACTUALLY DOES

```
att_i = clamp(knob_i + cv_i, 0, 1)     # attenuators only attenuate; a negative sum MUTES
out_i = in_i · att_i                    # per-channel DIRECT out — no master, no tanh
mix   = tanh( (Σ out_i) · master )      # the summing bus
```

**The one structural fact the panel does not state: `mix` and the four `out_i` are
not the same signal.** The direct outs are a clean multiply; the mix bus goes
through a tanh that is **always on**. Everything in §4 follows from that.

---

## 2. THE CONTROLS THAT MATTER — 5 params, and the lane fits all of them

| rank | control | why |
|---|---|---|
| 1 | `master` | ranked FIRST because **MASTER is the drive control** (§4-A), not a level trim, and it is the only cell that changes the sound of every channel at once. |
| 2-5 | `att1` … `att4` | the four channels. |

⚠ **THE RANKING BELOW RANK 1 IS DECLARATION ORDER AND THE FACE SHOULD SAY SO.**
Four symmetric channel strips have no principled priority: nothing makes channel 2
more important than channel 3. This is the `bluebox` keypad argument on a smaller
surface. The comment on `order` must state that it is arbitrary rather than
pretend it is a judgement.

⚠ **AND THAT IS WHY MASTER IS RANKED 1** — not because a master outranks a channel
in general, but because it is the **only** control whose rank carries information.
At `compact` (2 cells with a glyph) a face ranked `att1, att2` would show two
channels and hide the drive stage that is distorting them.

⚠ **THE PICTURE CANNOT BE A HERO CELL.** A panel's first legal rank is 7 and this
face has five params, so **rank 7 is unreachable** — the drummergirl wall. **The
picture goes in the SIDEBAR as a `custom` block**, which carries no `face.order`
key and therefore no rank (the meowbox answer).

**NO AUDITION.** attenumix generates nothing; there is nothing to strike.

---

## 3. INERT AT SPAWN — and it is a MIXER, which makes this the batch's most user-visible default

All four attenuators default to **0**. *Measured* with four 0.5-amplitude sines
patched in: `out1` peak **0.000e+0**, `mix` peak **0.000e+0**.

The def's comment says this is deliberate ("so a freshly spawned ATTENUMIX is
silent until the user dials in a channel"). It is also the module a new user
reaches for when they want two sources in one cable, and it produces **digital
silence** with everything correctly patched. **The face's single most useful job is
to make "these are at zero" impossible to miss.**

---

## 4. WHAT THE FACE MUST MAKE VISIBLE — four measured facts

### A. The tanh is not a safety net. It is an always-on distortion stage, and MASTER is its drive.

`docs.explanation`: *"Master goes up to ×2, so pushing past unity drives the sum
into the tanh for warm saturation instead of a hard digital clip."* That sentence
implies a clean region below unity. **There isn't one.**

*Measured*, one channel at unity, 250 Hz sine at 0.5 (−6 dBFS), MASTER swept:

| master | 0.25 | 0.50 | **1.00 (default)** | 1.50 | 2.00 |
|---|---|---|---|---|---|
| mix peak | 0.12435 | 0.24492 | **0.46212** | 0.63515 | 0.76159 |
| linear would be | 0.1250 | 0.2500 | **0.5000** | 0.7500 | 1.0000 |
| **level loss** | −0.045 dB | −0.178 | **−0.684** | −1.444 | −2.366 |
| **THD** | 0.130 % | 0.513 % | **1.962 %** | 4.119 % | **6.707 %** |

At the **shipped default**, with **one** channel open and a −6 dBFS input, the mix
bus is already **1.96 % THD and 0.68 dB down.** MASTER 2.0 is not "the boost" — it
is a **6.7 % distortion** setting that is 2.37 dB *quieter* than the linear gain it
advertises.

### B. Every channel you open makes the others dirtier — and the mix gets quieter than the sum

*Measured*, N channels at unity, each fed a 0.5 sine **in phase** (the worst
realistic case: four copies of one bus):

| channels open | 1 | 2 | 3 | 4 |
|---|---|---|---|---|
| linear sum would peak | 0.50 | 1.00 | 1.50 | 2.00 |
| **mix peak** | 0.46212 | 0.76159 | 0.90515 | **0.96403** |
| **loss vs linear** | −0.68 dB | −2.37 | −4.39 | **−6.34 dB** |
| **THD** | 1.96 % | 6.71 % | 12.24 % | **17.34 %** |

At four 0.9-amplitude inputs: mix peak 0.99851, **THD 28.32 %**.

And the counterpart, which is the actual finding: **the DIRECT outs at the same
settings measure THD 0.00004 %** — numerically clean. So the module carries the
same four signals in two forms, and the panel gives no indication that one path is
a soft-clipper.

**The hard ceiling is real and worth keeping.** Unlike treeohvox (+6.70 dBFS),
sidecar (+17.98) and resofilter (+44.4), attenumix's mix bus **cannot exceed ±1 by
construction**. That is a genuine virtue; the trade it makes for it is the
distortion above.

### C. The CV window is a function of the knob, and half of a bipolar LFO is always dead

`att = clamp(knob + cv, 0, 1)`. At knob `k` the CV values that do anything are the
window `[−k, 1−k]`; everything outside is clamped flat. *Measured* at knob 0.5:

| cv | −1 | −0.5 | 0 | +0.5 | +1 | +2 |
|---|---|---|---|---|---|---|
| effective att | **0.0000** | **0.0000** | 0.5000 | **1.0000** | **1.0000** | **1.0000** |
| phase | + | + | + | + | + | + |

Two checked non-defects: a negative sum **mutes to digital zero** (−6000 dB), it
does not phase-invert; and a CV over the top saturates at unity rather than
boosting. Both match `docs.explanation` exactly.

The finding is the **window**. At the shipped knob of 0 a ±1 V LFO spends its
entire negative half at zero; at knob 1 it spends its entire positive half at
unity; only at knob 0.5 is a ±0.5 V swing fully live. The def's
`PASSTHROUGH_BY_DESIGN` comment argues this is better than a `linear` cvScale
(which would halve the reach) — **that argument is sound and is not disputed**. The
point is that the *live window* is invisible on a panel (§6-B).

### D. MASTER does not mute the module, and the attenuator taper is exact

*Measured*: at `master 0` the mix is **bit-zero** while `out1` still reads peak
**0.50000**. Turning the master down does not silence a rack fed from the direct
outs — correct per the topology, invisible on the panel.

**A measured NON-DEFECT worth recording**, because it is the thing a mixer is most
often wrong about: the attenuator is **exactly linear in amplitude**. out1 relative
to unity measures **−20.00 / −13.98 / −10.46 / −6.02 / −3.10 / −0.92 / 0.00 dB** at
knob 0.10 / 0.20 / 0.30 / 0.50 / 0.70 / 0.90 / 1.00 — every value within 0.01 dB of
`20·log10(knob)`. That does mean the **top half of the fader is 6 dB and the bottom
tenth is 20 dB to −∞**, which is a legibility fact rather than a defect, and a
reason for §6-A to print dB.

---

## 5. THE FACE

```ts
face: {
  title: 'Mixer',

  // ⚠ RANKS 2-5 ARE DECLARATION ORDER AND THAT IS DELIBERATE. Four symmetric
  // channels have no priority ranking; inventing one would be a lie with a
  // straight face. Only rank 1 carries information — see §2.
  order: ['master', 'att1', 'att2', 'att3', 'att4'],
  pages: [
    { id: 'channels', label: 'channels', controls: ['att1', 'att2', 'att3', 'att4'] },
    { id: 'bus',      label: 'bus',      controls: ['master'] },
  ],
  glyph: 'meter',   // ⚠ see 5-A — the default jack is out1, not mix

  hero: {
    control: 'master',
    readouts: [
      { label: 'bus',    valueId: 'attenumix-bus-thd-pct' },
      { label: 'headroom', valueId: 'attenumix-bus-loss-db' },
      { label: 'cv window', valueId: 'attenumix-cv-window' },
    ],
  },

  sidebar: [
    { kind: 'custom', label: 'the bus curve', panelId: 'softclip-transfer',
      props: { driveParam: 'master', shape: 'tanh' } },
  ],
}
```

⚠ **5-A · THE GLYPH WILL METER THE WRONG JACK BY DEFAULT.**
`primaryAudioOutPortId` picks the **first** audio output in declaration order
(`shell-glyph-live.ts:96`), and this def declares `out1 out2 out3 out4 mix`. So an
off-the-shelf `glyph: 'meter'` meters **`out1`** — a single channel's clean direct
out — on a module whose whole story is the mix bus. This is the `noise` white-tap
finding on a second module. **Either declare the glyph source explicitly (a
platform addition), reorder the outputs (a contract change that would move every
saved patch's port order), or state which jack the meter reads.** ⚠ **Do not ship a
meter without resolving which jack it is on** — a level display pointing at the
wrong signal is worse than none, and no gate we own can see it.

---

## 6. DERIVED READOUTS

### A. `attenumix-bus-thd-pct` / `attenumix-bus-loss-db` — the pair, and they negative-control each other

```
drive     = master · Σ clamp(att_i + cv_i, 0, 1) · (assumed unit inputs)
loss_db   = 20·log10( tanh(drive) / drive )
thd_pct   from the tanh series at that drive
```
*Anchors, measured:* one channel / master 1 → 1.96 %, −0.68 dB. Four channels /
master 1 → 17.34 %, −6.34 dB. One channel / master 2 → 6.71 %, −2.37 dB.

**NEGATIVE CONTROL — `att2..4`.** A `paramId: 'master'` readout prints `1.00`
whether one channel or four is open, while the measured THD moves 1.96 → 17.34 %
with MASTER untouched. **SECOND CONTROL — the DIRECT outs must NOT be implicated:**
the readout is labelled `bus`, and the direct outs branch before it (measured
0.00004 % THD). **PUBLISHING BOTH NUMBERS IS THE PAIR'S OWN CONTROL** — they are
two views of one `drive`, so a derivation that moves one without the other is
falsified on the spot.

⚠ **HONESTY TERM: this cannot know the input amplitudes.** Print it as `at 0 dBFS
in` or similar, not as a live measurement. The alternative — reading the analyser —
needs the widened `FaceReadoutValue`; **until that lands, the label must say what
it assumed**, or the number is a confident fiction. The one readout in the batch
most at risk of being believed too literally.

### B. `attenumix-cv-window` — the window the knob opens

Prints `[−0.50 … +0.50]` for the selected channel: the CV range that is not
clamped. **NEGATIVE CONTROL — the knob.** `paramId: 'att1'` prints `0.50` and says
nothing about what a patched LFO will do; measured, at knob 0.5 the values −1 and
−0.5 both produce **exactly 0** and +0.5, +1 and +2 all produce **exactly 1**.
**SECOND CONTROL — knob 0 vs knob 1:** the readout must print `[0 … +1]` and
`[−1 … 0]` respectively, i.e. it must move in *both* directions; a one-sided
derivation would pass on a readout that simply tracked the knob.

---

## 7. THE PICTURE

**`softclip-transfer` in the sidebar** (§5): the `tanh(x·master)` transfer curve
with the current operating point marked, the linear reference as a dashed diagonal,
and the ±1 ceiling drawn. Written generically on purpose — `qbrt`, `clap`'s drive
and `rings`' output tanh could all reuse it, which is the `custom`-block contract.
If it turns out to be attenumix-specific, name it so.

---

## 8. ALREADY-WRONG

- **A · `docs.explanation`'s "pushing past unity drives the sum into the tanh"**
  implies a clean region below unity. Measured: **1.96 % THD and 0.68 dB loss at
  the DEFAULT master with one channel open.** §4-A. In `STRICT_DOCS`.
- **B · the ART "mix-saturation" scenario is an ALGEBRAIC IDENTITY CHECK, not an
  audio regression test — CONFIRMED STILL OPEN.**
  `art/scenarios/attenumix/mix-saturation.test.ts:47,53` still asserts
  `expect(mixSample(sum, 1)).toBeCloseTo(Math.tanh(sum), 12)` (and the `×2` twin) —
  i.e. that the implementation equals itself, to 12 decimal places. It never
  renders a signal and never asks **how much distortion the formula produces**,
  which is the only question a listener has. Nothing in the lane would notice if
  the answer changed from 2 % to 20 %, provided the formula stayed `tanh`. Not a
  bug; a gate with a stated scope narrower than its name. **Adding one THD row to
  that file is a ~10-line change and closes it.**
- **C · the ART scenario tests the MIRROR** (`attenumixMath` in the web def), while
  `packages/dsp/src/attenumix.ts:111-133` carries its **own copy** of the same three
  formulas (no import). Measured today they agree — the worklet's mix peak is
  **0.46212**, which is `tanh(0.5)` to five decimals — but **nothing compares them.**
  Same class as rings §8-F, smaller surface.
- **D · the card re-types the ranges** (`AttenumixCard.svelte:47, 58`:
  `min={0} max={1}`, `min={0} max={2}`) on the same lines where `defaultFor(...)`
  **is** def-sourced. **Not in `RANGE_BOUND_CARDS`.**
- **E · the default meter jack would be `out1`, not `mix`.** §5-A. A
  face-introduced hazard rather than an existing one — flagged before it ships.

**NEGATIVE RESULTS — no dead controls.** All five params measurably move the
output, and three behaviours that usually go wrong on a mixer are measured
**correct** here: the attenuator taper is exactly `20·log10(knob)` to 0.01 dB, a
negative CV **mutes rather than inverting**, and the mix bus has a real **hard
ceiling at ±1**.

---

## 9. COST

| | |
|---|---|
| **contract-lock** | **+0 lines.** No control family, no audition; the picture is a sidebar `custom` block, which is not a control key. |
| **ART** | none from the face. `art/scenarios/attenumix/{mix-saturation,profile}.test.ts` + `art/baselines/attenumix/` exist. §8-B is a TEST addition, not an audio change — **no re-pin**, and it can ride along. |
| **VRT** | not in `STRICT_VRT_MODULES`. +`face-attenumix-{compact,dock}` baselines. ⚠ `glyph: 'meter'` on a module that is **silent at spawn** (§3) reads zeros deterministically under #1420's freeze — but see §5-A about *which* jack. |
| **e2e** | +1 `faces-parity` row, 5 cells, no audition ≈ +12 s on one shard. |
