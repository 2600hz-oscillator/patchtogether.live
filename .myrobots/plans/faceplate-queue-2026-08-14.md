# The faceplate QUEUE — resumed 2026-08-14

The rolling face pipeline was paused 2026-08-11. This is the standing queue the
owner asked for: **specs first, implementation second**, so authoring never runs
ahead of design review. Every claim below is measured or read off the tree in
this branch; nothing is carried over from an earlier plan.

---

## 1. THE DERIVED STATE (do not trust any number that is not re-derived)

Two independent derivations, run against this branch, agreeing:

```sh
# A — the defs that DECLARE a top-level `face` (file names)
grep -rln "^  face: {" packages/web/src/lib/audio/modules/*.ts \
  packages/web/src/lib/video/modules/*.ts packages/web/src/lib/meta/modules/*.ts \
  | xargs -n1 basename | sed 's/\.ts$//' | sort

# B — the PROMOTED set
sed -n "/export const STRICT_FACES/,/^\]/p" \
  packages/web/src/lib/ui/workflow/strict-faces.ts \
  | grep -oE "^  '[A-Za-z0-9]+'," | tr -d " '," | sort

# C — the whole fleet, per-disposition, GENERATED and gate-pinned
flox activate -- task face:inventory     # green ⇒ the report below is fresh
```

A ≡ B exactly (the only rows that differ are the two kebab-case FILE names,
`analog-vco.ts` / `tidy-vco.ts`, whose def types are `analogVco` / `tidyVco`).
That identity is what `module-face-lint` asserts in both directions, and what
`face-migration-inventory.test.ts` keys its done-set off; re-deriving it here is
the negative control on both.

The promoted set, as derived:

> adsr · analogVco · bluebox · clap · clouds · cloudseed · cofefve · cube ·
> delay · drummergirl · dx7 · filter · karplus · kickdrum · lfo ·
> macrooscillator · marbles · meowbox · mixer · noise · pentemelodica · qbrt ·
> resofilter · reverb · ringback · rings · shimmershine · sixstrum · snaredrum ·
> tidyVco · tomtom · vca

`task face:inventory` is GREEN in this tree, so
`docs/design/face-migration.generated.md` is fresh and its per-disposition
breakdown is current. The **unfaced remainder that is eligible for a generic
face** is derived by intersecting the inventory's `generic-face` disposition with
the audio domain and subtracting `STRICT_FACES`:

```sh
flox activate -- node -e '<the contract-lock × inventory × STRICT_FACES join;
  see the session report — prints type / params / discrete / in / out / families>'
```

That join is the candidate pool this queue is drawn from. Video defs are
excluded on purpose: no video def carries a face, the doc `[id]` renderer for
them does not exist, and `module-faceplates.md` scopes them out.

---

## 2. THE QUEUE

Ordered by user value — how often a player actually operates the module — with
the risk each one carries stated up front, because two of the top three carry
platform risk that a face PR must not absorb silently.

### Q1 · `sidecar` — the stereo sidechain ducker  ⟵ IMPLEMENTED (this branch)

**Status: promoted.** Face authored, `STRICT_FACES` entry added, four derived
readouts registered, card range-bound, VRT roster entry added and the linux
capture dispatched. The three documentation defects §3 measured are filed as
**#1657** and fixed in the same branch.

**What it is FOR, musically.** SIDECAR is the rack's PUMP: the one module that
makes one signal breathe in time with another. It is not an insert compressor —
it is a two-input BOX. The MAIN pair is the trigger and passes through
untouched; the SC pair is the signal that gets pushed down and summed back in.
The verb is *patch a kick into MAIN, patch a pad into SC, and set how deep and
how fast the pad gets out of the kick's way.* Nothing else in the rack does that
in one module; the alternative is a VCA plus an envelope follower plus an
inverter.

**Merit (STOP 1): YES.** 9 params, 7 inputs, 4 outputs, and — the reason a face
is worth building — four quantities that matter to the player and that NO knob
readback can print (§3).

**STOP 2 (`grep` over `SidecarCard.svelte`, 84 lines): CLEAN.** Zero `<button>`,
zero `<select>`, zero `<input>`, no `node.data`, no `attachExternalSource`, no
`write(`. Nine `Fader`s and a `PatchPanel`. Every affordance is a `ParamDef`, so
nothing becomes unreachable on promotion.

**Ranking** (against the DSP, not the declaration order — measurements in §3):

| rank | key | why it is here and not lower |
|---|---|---|
| 1 | `threshold` | decides WHETHER anything ducks at all |
| 2 | `ratio` | how deep: 0 / −12.01 / −18.02 / −21.02 / −22.82 dB at 1 / 2 / 4 / 8 / 20 |
| 3 | `release` | the "breath" — in a ducker, release is the groove |
| 4 | `inputLevel` | how loud the ducked signal sits, AND the enabler: at 0 the SC path is dead |
| 5 | `attack` | how snappy the clamp |
| 6 | `knee` | moves the ONSET by knee/2 — measured −18.0 → −30.0 dB across its travel |
| 7 | `sc_hpf` | detector shaping; ships effectively off (−0.47 dB at 60 Hz) |
| 8 | `makeup` | the SAME dimension as `inputLevel`, in dB — deliberately ranked BELOW its twin |
| 9 | `envMag` | measured audio-INVARIANT; it scales the CV outs only, so it is the one control that cannot change what you hear |

Tier ladder as a sentence: *mini shows THRESH; compact adds RATIO; the six-cell
lane plate is the pump itself (thresh · ratio · release · in lvl · attack ·
knee); the dock adds the detector filter, the redundant makeup and the CV-only
env scaler.*

**Pages (FUNCTION / signal order — deliberately disagreeing with `order`):**

1. `detect` — what the MAIN has to do to trigger: `threshold`, `knee`, `sc_hpf`
2. `duck` — the shape of the dip: `ratio`, `attack`, `release`
3. `output` — everything that scales what LEAVES the box: `inputLevel`,
   `makeup`, `envMag`

Three bands of three, no wide cells, so PF-21 packs them and no tab rail (well
under `DOCK_TAB_MIN_BANDS`). `order` and `pages` disagree because priority and
signal flow genuinely differ here: `knee` is a rank-6 refinement but sits in the
FIRST band because it is part of the detection decision, and `envMag` is the
lowest-ranked control in the module but is the last thing in the chain.

**Hero:** `hero.control: 'threshold'` — the one dial that decides whether the
module does anything — with the four derived readouts as the row below it.
`glyph: 'meter'` on the primary audio out (unlit on a silent rack, the
mixer/reverb/clouds precedent: an insert with nothing patched outputs exactly
zero).

**No `face.title`, no `face.hint`, no band hints, no sidebar prose.** Owner
ruling 2026-08-11 (marbles/resofilter): plain labels and values; the explanation
lives in `docs` for right-click → annotate.

**Derived readouts** — four, each negative-controlled on a DIFFERENT blind input
(§3 has the numbers; `sidecar-face-model.test.ts` re-derives all of them against
the real `compressor-dsp` on every run):

| valueId | what it says | which knob is BLIND to it |
|---|---|---|
| `sidecar-onset` | the MAIN peak level at which ducking begins | THRESHOLD — blind to `knee` and to the +6.02 dB detector sum |
| `sidecar-duck` | the reduction at a full-scale mono main | RATIO — blind to `threshold` |
| `sidecar-sc-gain` | the sidechain's total gain, `20log₁₀(inLvl) + makeup` | MAKEUP is invariant to INPUT LVL and vice versa |
| `sidecar-env` | what ENV actually outputs at that reference | ENV MAG — blind to threshold/ratio/knee, and prints the overshoot |

**No ACTION cell, no PANEL** in v1: nothing on this module is a gesture, and a
transfer-curve picture (the obvious hero) costs a `controlFamilies` entry, a
`contract-lock` line and a `STRICT_DOCS` `docs.controls` blob. It is queued as a
follow-up rather than folded in (see Q1b).

**Risk: LOW.** No live surface, no card producer, no video, nothing free-running
— every pixel is a pure function of nine params, so the VRT scenes are
deterministic on a frozen graph, a live graph and a silent rack alike.

### Q1b · `sidecar` transfer-curve panel (follow-up, not v1)

A PF-14 `panel` drawing the static gain computer — threshold, knee width and
ratio slope as one picture — pure `computeGainDb`, no clock, no tap. A panel's
first legal rank is 7 and sidecar has 9 rankable keys, so it CAN be a real
`hero.cell` (the rings precedent, not the meowbox/noise sidebar consolation).
Deferred because it is a contract change (`controlFamilies` → `contract-lock` →
`docs:accept` → a `docs.controls` entry), and the ranking argument stands
without it.

### Q2 · `timelorde` — the rack's master clock

**Highest raw user value in the whole queue** and deliberately NOT first.
`maxInstances: 1`, `undeletable: true`, and Canvas auto-spawns one into any rack
that opens without it — so it is the only module present in 100 % of racks.

**Merit: YES.** 6 params (`bpm`, `swingAmount`, `swingSource`, `muteOutputs`,
`running`, `wizardOn`), 5 inputs, 14 outputs, plus a TAP TEMPO gesture.

**Its face's whole argument is already written down in its own def**, and no
surface but the card carries it: `muteOutputs` says

> *"NOT different at the jacks: a muted clock and a stopped one both send
> nothing at all down every one of the thirteen outputs, so a cable cannot tell
> you which one is silencing your rack."*

`timelordeTransportState({running, muteOutputs})` already exists and already
separates the four states (RUNNING / STOPPED / MUTED / STOPPED+MUTED). It is a
pure function of two PARAMS, so it is reachable through `FaceReadoutValue`'s
params-only reader — a derived readout whose negative control is built in
(a `running` readback is blind to MUTE and a `muteOutputs` readback is blind to
STOP, and only their JOIN names the state).

**STOP 2: four card affordances, three of them clean.**
- RUN button → the `running` param (a toggle cell). Note the card HIDES it while
  the transport is slaved to `start_in`/`stop_in`; a face must decide whether to
  reproduce that or always show it (recommend: always show it, and let the
  readout say who owns the transport).
- MUTE button → the `muteOutputs` param (a toggle cell).
- WIZARD toggle → the `wizardOn` param (a toggle cell).
- **TAP TEMPO → an ACTION cell**, and it writes the `bpm` param, so unlike an
  audition it IS observable through `readParam` — the probe is a param write,
  not an audition-ledger entry. It is `disabled` while an external clock owns
  the tempo; the shell cell must carry that.

**⚠ THE RISK, AND WHY THIS IS NOT THE RESUME FACE.** timelorde is a member of
`CARD_PRODUCER_LANE_TYPES` (`dom-source-modules.ts`, #1587): its CARD composites
the big display (the beat-pulsing owl, or the `video_in` feed) and pushes it into
the node with `write(node,'displayFrame')`, and that push is the only thing
feeding `video_out`. Two consequences a face PR must handle explicitly:

1. **Promotion does NOT kill it** — `needsHeadlessSourceMount` returns true for
   the `'shell'` lane kind, so the real card is kept alive off-screen. Verified
   by reading the seam, and it must be verified again by a spec.
2. **The owl is a LOOK LOSS on the faceplate.** The face has no cell that paints
   it. Painting it means a `face.extension` glyph (#1512 landed; dx7 is the only
   adopter) — a bespoke component in
   `$lib/ui/modules/timelorde/shell-extension.ts`. That is a genuinely different
   size of PR, and the owl PULSES with the beat, so it is a live surface with
   the analogVco hazard (mitigated by #1420's pre-frame freeze, but unproven for
   an image-based glyph).

**Recommended split:** land the face WITHOUT the owl first (transport readout,
TAP action, tempo/swing pages), then the extension glyph as its own PR with its
own VRT dispatch.

### Q3 · `treeohvox` — the TB-303 voice slice

**Merit: YES.** 7 params (`tune`, `cutoff`, `resonance`, `envelope`, `decay`,
`accent`, `waveform`), 10 inputs, 1 output. High everyday value: it is the acid
bass.

**STOP 2: CLEAN** — `TreeohvoxCard.svelte` has zero buttons; every control is a
param fader.

**⚠ AUDIT ITEM THAT MUST BE SETTLED BEFORE THE FACE — filed as #1658. It looks
like the `rings` defect.** Grepped against the tree: the factory declares no `manualTrigger` read
key and the card mounts no strike affordance, so **the module appears to be
un-soundable from any surface** — you must patch a gate into `gate_in`. That is
exactly what shipped on `rings` (twenty controls over an instrument that could
not be sounded) and on `sixstrum` before it. The face PR must either (a)
reproduce the rings fix — a `strumCs` ConstantSource plus the factory's
`manualTrigger` read key, and a `mode:'gate'` action cell with an
audition-ledger probe — or (b) demonstrate, with a measurement, that the module
IS soundable some other way. Do not author the face first.

Because the voice is gate-driven, its e2e must wire a REAL source chain
(CLAUDE.md, `poly-modules-test-real-source-chain`), not an engine-direct call.

### Q4 · `scope` — the dual-trace oscilloscope

**Merit: YES.** 9 params (`ch1Range`, `ch1Scale`, `ch1Offset`, `ch2Range`,
`ch2Scale`, `ch2Offset`, `timeMs`, `intensity`, `mode`), 11 inputs, 3 outputs
(`ch1_out`, `ch2_out` and a `mono-video` `out`). Everyone patches a scope, and
it has a natural CLUSTER structure (the same idea twice: CH1 and CH2), which is
what `face.pages` clusters are for.

**STOP 2: three buttons, all params.** `scope-ch1-mode` → `ch1Range`,
`scope-ch2-mode` → `ch2Range`, `scope-xy-mode` → `mode`. All three are declared
`discrete 0..1` params, so all three become toggle cells. Clean.

**⚠ THE OPEN QUESTION IS THE SCREEN.** The whole module IS its screen, and the
inventory note already flags it: `glyphBinding` resolves ONE tap off
`primaryAudioOutPortId`, so a `scope` glyph can draw ONE channel. A dual-trace +
Lissajous screen needs a registered PANEL (dock-only by lint) or a
`face.extension`. Settle that before ranking — a face that silently drops the
second trace is a look loss on the module whose entire purpose is the picture.
The screen is also LIVE, so `VRT_LIVE_SURFACES` / #1420's freeze apply.

### Q5 · `swolevco` — the Buchla-259-style complex oscillator

**Merit: YES.** 8 params (`tune`, `fine`, `mod_tune`, `mod_fine`, `ratio`,
`timbre`, `symmetry`, `fold`), 7 inputs, 4 outputs including a `mono-video`
scope tap.

**STOP 2: CLEAN** — `SwolevcoCard.svelte` is 69 lines of knobs.

**Pages write themselves and the ranking does not.** Two oscillators (PRIMARY /
MODULATOR) plus a WEST-COAST section (timbre = audio-rate FM index, symmetry =
a 3-way waveform crossfade, fold = the wavefolder), so the pages are `primary` /
`modulator` / `shape`. What must be MEASURED first: `ratio` and `mod_tune` are
two ways to set the same modulator frequency (`ratio` is a multiplier, `mod_tune`
is semitones) — establish which is inert when the other is at its default before
ranking either. `timbre` at 0 is very likely the enabler for the whole modulator
section (the cofefve enabler-pair shape); prove it with a bit-exact delta rather
than assuming it.

**⚠ FREE-RUNNING**, like analogVco / macrooscillator / noise — three
`OscillatorNode`s started at factory time. Its lane glyph is live from spawn, so
it depends on #1420's pre-frame freeze and joins that fix's real-roster
coverage.

### Q6 · `attenumix` — the plain 4-channel attenuating mixer

**Merit: MARGINAL-YES, and the argument is narrow.** 5 params (`att1..att4`,
`master`), 8 inputs, 5 outputs. It clears STOP 1 on the letter of the rule
(>2 params) but the four channel knobs are INTERCHANGEABLE, which is the bluebox
problem: `order` is a priority ranking and four identical attenuators have no
priority. Take bluebox's answer — rank by LAYOUT so every PREFIX is still a
recognisable fragment (att1..att4 then master), and put the INFORMATION
somewhere a prefix can carry it.

The information worth carrying: the def says the channel attenuators are
`clamp(knob + cv, 0, 1)` — **CV can only reach a control that is not already at
1**, and the master is the only place gain past unity lives (`0..2`, with a
`tanh` after it). A derived `headroom` readout (how much of the mix bus the four
open channels can reach, and where the tanh starts to bend) is the one number no
knob prints. Measure the tanh knee before writing it.

**STOP 2: CLEAN** — `AttenumixCard.svelte` is 92 lines of knobs, zero buttons.

### Q7 · `mixmstrs` — the full mixer

**Merit: YES, and it is the largest face in the fleet by a distance.** 91
params, 111 inputs, 6 outputs — bigger than cube (28 cells).

**It already has its page plan in the tree**: `mixmstrs-sections.ts` derives
`Ch1..ChN`, `Ret1..RetN` and `Master` sections from the def. A face should read
that module rather than re-deriving the grouping (and `rear-card-model` derives
the rear card from `face.pages`, so the two stay in step for free).

**⚠ PRICE IT BEFORE STARTING.** `faces-parity` budgets CI at roughly
`10 s + 0.8 s/cell`; at ~91 cells that is over a minute on its own, before the
per-port and VRT sweeps. CLAUDE.md requires owner sign-off past ~2 min of CI
wall-time delta. Measure the real cell count from the authored face and get the
sign-off BEFORE authoring.

**STOP 2: one chrome button** (`compact` — a card-local view toggle, not a
param; it does not need to survive) plus two more to classify.

### Q8 · `warrensspectrum` — the spectral filterbank

**Merit: YES.** 15 params, 9 inputs, 1 output, and — unusually — it already
declares a `controlFamilies` entry (`ws-filterbank`), which is the shape the
faced modules already register as a family cell/panel. One button on the card to
classify.

---

## 3. `sidecar` — THE AUDIT, MEASURED

Run against the shipping `packages/dsp/src/lib/compressor-dsp.ts` (pure, exported,
deterministic; SR 48 000). Every number below is reproduced on every run by
`sidecar-face-model.test.ts`, so a DSP fix turns a stale claim RED rather than
leaving the faceplate insisting on it.

**M1 — WITH THE SIDECHAIN UNPATCHED, ALL NINE CONTROLS ARE BIT-EXACTLY INERT.**
Rendering a 60 Hz mono main at 0.5 with `sc` at zero, then again with EVERY knob
at the opposite extreme (`threshold −60`, `ratio 20`, `knee 0`, `makeup 24`,
`inputLevel 2`, `attack 0.1`, `release 2000`, `sc_hpf 1000`), the output samples
are bit-identical — `0.003926950, 0.007853659, 0.011779882, 0.015705380` in both,
peak `0.500000000` in both. The module is a wire. This is the `clouds`/`rings`
class of invisibility and nothing on the module said so.

**M2 — WITH THE MAIN UNPATCHED, THE DUCK NEVER ENGAGES.** `gainDb` is exactly
`0.000000` and the SC passes at unity, at the defaults AND at `threshold −60,
ratio 20`. So SIDECAR has TWO enabler CABLES; six of its nine knobs are asleep
without both. ⚠ A `FaceReadoutValue` sees only params, so the faceplate is
STRUCTURALLY unable to say which cable is missing — this finding is carried by
the band labels and by `docs`, never by a readout.

**M3 — `makeup` AND `inputLevel` ARE THE SAME DIMENSION, EXACTLY.** Measured
SC-path output for four equivalent pairs: `inLvl 2 / makeup 0` → 6.0206 dB;
`inLvl 1 / makeup 6.0206` → 6.0206 dB; `inLvl 0.5 / makeup 6.0206` → 0.0000 dB;
`inLvl 0.25 / makeup 12.0412` → 0.0000 dB. So the sidechain's gain is
`20log₁₀(inputLevel) + makeup` and NEITHER knob's readback can print it. Not a
defect — a redundancy — and it is why the face publishes `sc gain`.

**M4 — DEFECT (doc, #1657): `makeup` IS NOT AN OUTPUT GAIN.** The def documents it as
*"a fixed output gain in dB added after ducking … to bring the overall level back
up"*. Measured with the SC unpatched, the output peak is `0.500000000` at makeup
0, 12 AND 24 dB — bit-identical. `makeup` multiplies the DUCKED SIDECHAIN only
(`compressor-dsp.ts` step 8/9); the MAIN passthrough never sees it. The DSP's own
param comment says so correctly; the user-facing doc does not.

**M5 — DEFECT (doc, #1657): ENV OVERSHOOTS AT THE DEFAULT `envMag`, NOT ONLY ABOVE IT.**
The doc says *"At 1 a 24 dB reduction reaches ENV 1.0; above 1 the env overshoots
past 1.0"*, which reads as "overshoot requires envMag > 1". Measured at
`envMag = 1` with `threshold −40, ratio 20` and a −0.9 main, ENV ran
**1.6889 – 1.7044**. The real condition is *reduction > 24 dB*, at any
`envMag > 0` — `env = (−gainDb / 24) · envMag`, unclamped.

**M6 — DEFECT (display, #1657): `inputLevel` DECLARES `units: '%'` ON A 0..2 RANGE.** It
is the only such param in the fleet — the other six `%` params (wavesculpt's wall
alphas) are all `0..100`. Any surface that prints value+units prints `1.00 %`
where the module means 100 %. It is invisible today only because
`SidecarCard.svelte` passes no `units` to its `Fader`s; a faceplate reads the
`ParamDef` and WOULD paint it.

**M7 — `envMag` is audio-INVARIANT, as documented.** Output RMS is bit-identical
(`0.636462653`) at `envMag` 0 / 0.5 / 1 / 2. Confirmed, not a defect — and it is
why `envMag` is ranked last.

**M8 — the KNEE's authority is at the ONSET only.** At a detector level far above
the threshold (a full-scale mono main, +6.02 dB) the reduction is identical at
knee 0, 6 and 24 dB (`−18.015` at ratio 4). What the knee moves is where ducking
BEGINS: onset −17.99 / −19.49 / −20.99 / −23.99 / −29.99 dB at knee 0 / 3 / 6 /
12 / 24 (i.e. `threshold − knee/2`, to the hundredth). So `onset` and `duck` are
each other's negative control: one moves with the knee and the other cannot.

**M9 — the THRESHOLD KNOB IS NOT CALIBRATED IN dBFS.** The detector is
`|aL| + |aR|` (stereo-linked sum of rectifiers), so a mono main normalled to both
channels reads **+6.0206 dB** above its own peak — measured at three amplitudes,
the offset is exactly `20log₁₀2` every time. A THRESHOLD of −18 therefore starts
ducking at a main peak of −24.02 dB (hard knee) or −27.02 dB (default 6 dB knee).
The DSP comment calls the offset deliberate ("absorbed into the threshold knob's
perceptual calibration"); no user-facing surface has ever stated it.

**M10 — `sc_hpf` ships effectively OFF and has real reach.** One-pole magnitude at
60 Hz: −0.47 dB at the default 20 Hz, then −3.04 / −7.06 / −12.78 / −18.76 /
−25.03 dB at 60 / 120 / 250 / 500 / 1000 Hz. The default is honest.

**M11 — the RATIO ladder at a full-scale mono main:** 0 / −12.010 / −18.015 /
−21.018 / −22.820 dB at ratio 1 / 2 / 4 / 8 / 20 (threshold −18). Note the top of
the dial buys only 1.8 dB more than ratio 8 — a fact a `ratio` readback of
`20.00` cannot convey.

### What the audit did NOT find

No dead control, no unexposed DSP capability, no range disagreement between the
card and the def (the nine re-typed literals all AGREE — they are a
maintainability hazard, not a live bug, and this PR binds them through
`paramSpec` so they cannot drift). `sidecar` is a correct module with three
documentation defects and one structural invisibility.

---

## 4. NO FACE ON MERIT — the rejections

`module-faceplates.md` STOP 1 refuses when ALL of: ≤2 params, no control
families, no `node.data`-backed affordances, no derived quantity worth a readout.
A face there is pure churn — two VRT baselines, a faces-parity row, a Push-card
tier change, and an identical single control at every tier, because `faceTierCap`
gives mini 1 / compact 2–3 / plate 6 / dock all.

Recorded here so nobody re-derives the verdict:

| module | params | verdict |
|---|---|---|
| `flipper` | **0** | NO FACE ON MERIT. Nothing to rank at all; the inventory note already says its face would be "a title, a glyph and the rear". |
| `moog994` | **0** | NO FACE ON MERIT. A passive multiple — the module IS its jack field, which is the REAR card, and the rear is derived without a face. |
| `depolarizer` | 1 | NO FACE ON MERIT. One knob, one in, one out. |
| `polarizer` | 1 | NO FACE ON MERIT. Same shape, inverse function. |
| `scaler` | 1 | NO FACE ON MERIT. One knob, one in, one out. |
| `moog903a` | 1 | NO FACE ON MERIT. Noise source: one level, two taps, zero inputs — the `noise` shape, and `noise` was promoted only because THREE stated facts about its taps were unprintable. Re-open if the same is true here; it is a one-hour measurement, not a face. |
| `moog962` | 1 | NO FACE ON MERIT. A sequential switch: its behaviour is the routing, not the knob. |
| `moog912` | 2 | NO FACE ON MERIT. Envelope follower, two knobs. |
| `gatemaiden` | 2 | NO FACE ON MERIT. |
| `stereovca` | 2 | NO FACE ON MERIT — with a caveat: if its `strength` response turns out to be non-obvious (the `vca` face exists precisely because gain-at-full-CV is not the knob), it earns a derived readout and moves to the queue. Measure before deciding. |
| `moog904b` | 2 | NO FACE ON MERIT. |
| `moog961` | 2 | NO FACE ON MERIT — an interface/converter; the routing is the module. |
| `sampleHold` | 1 | NO FACE ON MERIT as a control surface. |
| `joystick` | 2 | **NOT a merit rejection — a DEFERRAL.** Two params, but its 2-D pad is a HAND-CLONE of the shared `<XyPad>`, and the inventory's standing instruction is to migrate it onto the shared `xy` cell rather than paint two knobs. It is a platform-consolidation job that happens to produce a face. |
| `spectrograph` | 1 | **NOT a merit rejection — BLOCKED in practice.** One gain knob and a B/W toggle, but the sonogram waterfall matches no glyph kind, so promoting it without a registered panel is a straight look loss. |

Also NOT queued, and not rejected on merit either:

- **`samsloop`** — `module-faceplates.md` scopes it out by name: its input path is
  `node.data` (the WAV loader, the REC machine, CHAN/BITS/RATE), and the shell
  has no file-import or recorder cell that reaches the dock. Building one is a
  platform PR.
- **`wavesculpt`** — a face was authored for it once and shipped both hand-cloned
  camera pads as knobs. It is also the second-largest order in the fleet and a
  `CARD_PRODUCER_LANE_TYPE`. ⚠ Owner ruling: `wavesculpt` and `cube` face MRs do
  NOT self-merge; they need manual review.
- **the `moog9xx` bank generally** — most members are 1–3 params of a modular
  utility. A few (`moog960` at 36 params, `moog984` at 16, `moog914` at 14,
  `moog907a` at 10) clear merit comfortably and belong in a later batch; the rest
  are rejections of the shape above.

---

## 5. WHAT EVERY ENTRY IN THIS QUEUE OWES

Not a checklist for its own sake — these are the four things the shipped faces
each had to learn the hard way:

1. **Audit BEFORE the face.** Every defect this programme found was found by
   auditing a module that was on the queue, not by a gate. A face over a module
   that does not work is a prettier broken module.
2. **Re-measure the spec.** Every face in batches 3–5 found its own spec wrong
   somewhere — marbles four times, rings four times, resofilter four times,
   clouds twice. Numbers in THIS file are measurements taken in this branch and
   are still to be re-derived by the per-module oracle, not trusted.
3. **Promotion is a behaviour change.** `migrated(type)` is
   `STRICT_FACES.has(type)` and the dock swap is not behind a flag, so a merged
   face changes what every workflow-mode user operates on the next deploy.
4. **The VRT roster is hand-maintained but IS now gate-coupled** — a correction
   to `module-faceplates.md`, which still says nothing ties it to `STRICT_FACES`.
   `workflow-shell-faces.spec.ts:313` asserts roster ≡ `STRICT_FACES` in BOTH
   directions AND that every scene's baselines are COMMITTED (it reads the
   filesystem, so a locally-recreated untracked PNG cannot satisfy it). You
   still add the `{ type, pages }` entry by hand; you can no longer forget to.

5. **A local VRT run WRITES the missing baselines as untracked PNGs.** Measured
   in this session: running the two new sidecar scenes on macOS produced
   `face-sidecar-compact.png` (4 626 B) and `face-sidecar-dock.png` (54 129 B)
   in `__screenshots__/`, untracked. They were deleted, not committed — linux CI
   is the only baseline author. `git status` for PNGs after every VRT run.

---

# COHORT 2 — appended 2026-08-15

The set has MOVED since §1 was written: **35 promoted**, not 32 (`attenumix`,
`sidecar`, `warrensspectrum` landed). Most of the original Q2–Q8 is blocked or
extension-class, so the pool was re-derived from scratch rather than re-ordered.

## 6. THE RE-DERIVED POOL (2026-08-15, `origin/main` @ `01b46c83`)

The join is `generic-face ∩ audio ∩ ¬STRICT_FACES`, three sources, none of them
this file:

```sh
# contract-lock × face-migration-inventory × STRICT_FACES
#   contract-lock.txt          -> domain / param count / discrete / in / out /
#                                 paramTarget-input count / controlFamilies
#   face-migration-inventory.ts-> disposition (SOURCE, not the generated md)
#   strict-faces.ts            -> the promoted set
# prints: type par disc in out cvT fam portKinds
```

**58 candidates.** The re-derivation is itself the negative control on §1: it
reproduced every module §1 named, and it surfaced two §1 missed (`ninelives`,
`destroy`) because §1 ranked by param count alone and both are small-param
modules whose value is in their OUTPUTS.

The head of the pool, by param count:

| type | par | disc | in | out | cvT | fam | disposition here |
|---|---|---|---|---|---|---|---|
| `mixmstrs` | 91 | 10 | 111 | 6 | 91 | 0 | Q7 — stopped by #1662 |
| `wavesculpt` | 79 | 12 | 26 | 7 | 11 | 1 | owner manual review (§4) |
| `moog960` | 36 | 11 | 3 | 4 | 0 | 0 | needs a STEP-GRID cell |
| `foxy` | 33 | 6 | 5 | 5 | 3 | 0 | extension-class (video out) |
| `synesthesia` | 22 | 4 | 4 | 48 | 0 | 0 | extension-class (video out) |
| `moog984` | 16 | 0 | 4 | 4 | 0 | 0 | needs a MATRIX cell |
| `moog914` | 14 | 0 | 1 | 1 | 0 | 0 | **Q12** |
| `moog907a` | 10 | 0 | 1 | 1 | 0 | 0 | **Q12** (paired) |
| `wavecel` | 10 | 0 | 7 | 4 | 3 | 4 | extension-class (poly + video) |
| `scope` | 9 | 3 | 11 | 3 | 9 | 0 | Q4 — extension-class |
| `swolevco` | 8 | 0 | 7 | 4 | 4 | 0 | Q5 — unblocked by #1669 |
| `slewSwitch` | 7 | 2 | 10 | 7 | 4 | 0 | **Q14** |
| `treeohvox` | 7 | 0 | 10 | 1 | 7 | 0 | Q3 — blocked by #1658 |
| `featurecv` | 6 | 1 | 1 | 4 | 0 | 0 | next-after |
| `moog921Vco` | 6 | 0 | 8 | 4 | 5 | 0 | the System-55 BANK batch |
| `timelorde` | 6 | 4 | 5 | 14 | 0 | 0 | Q2 — extension-class |
| `wavetableVco` | 5 | 0 | 8 | 1 | 5 | 0 | **Q9 — IMPLEMENTED** |
| `charlottesEchos` | 5 | 0 | 3 | 2 | 1 | 0 | **Q10 — IMPLEMENTED** |
| `buggles` | 5 | 0 | 3 | 5 | 0 | 0 | **Q13** |
| `ninelives` | 2 | 0 | 1 | 9 | 0 | 0 | **Q11** |

## 7. THE COHORT

### Q9 · `wavetableVco` — the timbre-sweep oscillator  ⟵ IMPLEMENTED (this branch)

**Status: promoted.** Face authored, `STRICT_FACES` entry added, two derived
readouts registered, the card converted to `paramSpec` and the standing
`OPERATIONAL_DEBT` entry DRAINED, VRT roster entry added, capture dispatched.

**What it is FOR, musically.** WAVETABLE VCO is the rack's TIMBRE-SWEEP
oscillator. Every other VCO here decides its shape before the note — tidyVco's
four fixed jacks, analogVco's morph crossfade, macrooscillator's fourteen
engines. This one reads a 16-frame single-cycle table that runs saw → square →
triangle → sine, and WAVE scans it *while it sounds*. The verb is *sweep the
shape*: park an LFO or an envelope on WAVE POSITION and the harmonics thin out
over the note instead of being chosen ahead of it. It is not a wavetable LOADER
(that is WAVECEL) — the table is fixed and WAVE only scans it.

**Merit (STOP 1): YES.** 5 params, 8 inputs (5 of them `paramTarget` CV), 1
output — and two quantities that matter to a player and that NO knob readback
can print (§8, M4/M5).

**STOP 2 (`grep` over `WavetableVcoCard.svelte`, 45 lines): CLEAN.** Zero
`<button>`, zero `<select>`, zero `<input>`, no `node.data`, no `write(`. Five
`Fader`s and a `PatchPanel`. Every affordance is a `ParamDef`.

**Ranking** (measurements in §8):

| rank | key | why it is here and not lower |
|---|---|---|
| 1 | `wavePos` | the module's IDENTITY — the only control that changes the timbre, and the only thing its VCO siblings cannot do. Measured: frame 0 (saw) → frame 15 (sine) is a peak \|Δ\| of 9.9937e-1, a full-scale change |
| 2 | `tune` | the pitch. ±36 st, 1.4999 peak Δ per octave |
| 3 | `fine` | ±1 semitone of trim — 1/72 of TUNE's travel, but UNCONDITIONALLY applicable, which is what puts it above the two depths |
| 4 | `fmAmount` | the second identity (DX-style metallic tones) — but INERT until a cable lands in `fm`. Measured bit-exactly 0.0000e+0 with nothing patched |
| 5 | `pmAmount` | same enabler-gated shape, ranked below FM because it never moves the pitch at all — it offsets the READ phase only |

Tier ladder as a sentence: *mini shows WAVE; compact adds TUNE beside the scope
glyph; the six-cell lane plate and the dock both show all five, so the ranking's
whole authority is at the top two.*

**Pages (FUNCTION / signal order — deliberately disagreeing with `order`), and
the split is DSP-derived, not a habit:**

1. `pitch` — everything that lands in the ONE exponent
   (`semitones = pitch*12 + tune + fine/100 + fmAmount*fm*12`, the worklet's own
   line): `tune`, `fine`, `fmAmount`.
2. `wave` — everything that touches the READOUT and not the frequency: `wavePos`
   picks the frame, `pmAmount` offsets the read phase while the accumulator is
   left alone: `wavePos`, `pmAmount`.

That is the same teaching `analogVco`'s face carries, and it is measured here
rather than inherited: a DC on `fm` at depth 1 moves C4 to 523.25 Hz, a DC on
`pm` at depth 1 leaves the period bit-exactly alone (§8 M6). Filing FM under
"modulation" beside PM would put the module's most pitch-shifting control in
the band that claims not to touch pitch.

Two bands, both survive the hero promotion (`wave` still holds `pmAmount`), so
the VRT roster entry is `pages: 2`.

**Hero:** `hero.control: 'wavePos'` — the identity dial at hero size — with the
two derived readouts as the row below it. `glyph: 'scope'`, the analogVco
precedent: this is the SECOND free-running entry in the VRT faces roster, and the
scene machinery's `freezeAudioContext` is what makes that deterministic (measured
0 px across two independent boots for analogVco, `_shell-faces.ts`).

**No `face.title`, no `face.hint`, no band hints, no sidebar.** Owner ruling
2026-08-11: plain labels and values.

**Derived readouts** — two, each negative-controlled on a DIFFERENT blind input:

| valueId | what it says | which knob is BLIND to it |
|---|---|---|
| `wavetablevco-knob-hz` | the sounding pitch from the knobs alone | TUNE — blind to FINE, and neither prints Hz or the C4 anchor |
| `wavetablevco-fm-span` | FM's reach in cents AND the asymmetric Hz swing | FM AMT — blind to TUNE (the Hz swing doubles per octave); TUNE — blind to FM AMT; and a knob readback swings through zero on the SIGN while the span must not move |

**Risk: LOW-MEDIUM.** Free-running, so the compact scene's glyph depends on
#1420's audio freeze — the same dependency analogVco already carries and the
same machinery. No card producer, no video, no `node.data`.

### Q10 · `charlottesEchos` — the destructive multi-head stereo delay  ⟵ IMPLEMENTED (#1688 / PR #1689)

> **WHAT THE MEASUREMENT CORRECTED, recorded here because §5.2 predicted it and
> the correction is the valuable half.**
>
> 1. **The batch-6 spec's `delay`-dependent stability boundary is an INSTRUMENT
>    ARTIFACT.** §3-B of `face-specs-batch-6-charlottes-echos.md` bisects the
>    boundary with a LEVEL threshold over a fixed-length render ("is the last 2 s
>    of a 12 s render above −100 dBFS") and reports it sliding from `DECAY 0.3184`
>    at 20 ms to `0.2079` at 600 ms. That metric cannot separate "does not decay"
>    from "decays slowly", and a longer tape decays slower per second by
>    construction (the round trip is `DELAY/4`). Swept further the same instrument
>    reports ~0.0001 at `delay 1.5 s` — "any DECAY sustains", the tell. Under
>    **dB per ROUND TRIP** (delay-invariant) the loss is −0.99 / −1.00 dB/rt at
>    0.15 s and 0.6 s against a predicted −0.959: the boundary is loop gain
>    **1.000 at every DELAY**, and DELAY moves the RATE. The spec's `ce-margin`
>    3-D interpolation became a closed form. Both instruments now run on the same
>    six renders as a permanent leg of `art/scenarios/charlottes-echos/face-law.test.ts`.
> 2. **The push-gate fixture warning above was based on a stale COMMENT, not on
>    the code.** `push-card-schema.test.ts` tier 3 already DERIVES its subject
>    (`allDefs().find(d => !d.face && …)`) and asserts non-vacuity, so promoting
>    this module just moves the `find` to another face-less def. Only the comment
>    naming `charlottesEchos` was stale; it now says why naming a module there
>    goes stale silently.
> 3. **The DSP mono normal cannot be asserted through the def's factory under
>    `node-web-audio-api`** — the host zero-fills an unconnected worklet input, so
>    the `??` fallback never fires (measured `max|L−R| = 9.011e-1`, against
>    `0.0000e+0` in a real browser). That leg is a SCOPE assertion naming
>    `mono-normal-not-defeated.test.ts` and `stereo-mono-normal.spec.ts` as the
>    owners, so a green ART run is never mistaken for coverage of the normal.
> 4. **The audit found no CV defect** — and the strong leg says so: `CV(+Δ)` and
>    `KNOB(base+Δ)` are the same render to the bit (`0.0000e+0`), which is the
>    claim "the cable moved the audio" cannot make.

**Merit: YES.** 5 params (`delay`, `feedback`, `decay`, `pitchUp`, `mix`), 3
inputs, 2 outputs. The last unfaced time-based effect of consequence —
`delay`, `cofefve`, `cloudseed` and `reverb` are all promoted.

**STOP 2: to run** — the card was not read in this session.

**ONE CV input only** (`delay`, log-scaled), so the CV audit is a one-row table
and cheap. Its factory carries a deliberate asymmetry worth checking during the
audit: a `silenceL` ConstantSource pinned to input 0 ONLY, because putting one on
input 1 defeats the DSP's `inputs[1] ?? inputs[0]` mono normal
(`mono-normal-not-defeated.test.ts` already pins that — do not "fix" it).

⚠ **IT IS ALSO THE PUSH GATE'S GENERIC-TIER FIXTURE.**
`push-card-schema.test.ts` tier 3 opens with *"charlottesEchos carries no face,
so it is a real generic-audio card"* — promoting it silently retires that leg's
subject. Move the fixture to another face-less audio module in the SAME commit,
or the tier-3 test starts asserting the FACE tier while still claiming to prove
declaration order.

**The readout story is the four-stage cascade.** `feedback` is fed to EVERY
stage and compounds, `decay` tapers each later stage AND adds in-loop drive plus
HF loss, and `pitchUp` transposes each successive stage by a compounding ratio.
So the tail length is a function of `feedback` AND `decay` together — a
`feedback` readback is blind to `decay` and vice versa — and the total pitch
climb by the fourth head is a function of `pitchUp` that no 0..0.2 dial prints.
Measure both against the real `charlottes-echos` worklet before ranking; §5.2
applies (every face in batches 3–5 found its own spec wrong somewhere).

### Q11 · `ninelives` — the nine-tap LFO ladder

**MISSED BY §1's ORDERING, and it is the sharpest small module in the pool.**
2 params, 1 input, 9 outputs. §1 ranked by param count, and on that measure this
is a rejection; on merit it is the `noise` case exactly — `noise` has ONE param
and was promoted because THREE stated facts about its taps were unprintable.

**Merit: YES, on the readouts.** The def already states the ladder:
`out_n = rate · (1/3)^(n-1)`, so out9 is `rate/6561` ≈ 0.0001524× — a number no
RATE knob can print, on a module whose whole point is the nine simultaneous
rates. Nine derived readouts (or a small table) are the face; the RATE dial is
one of them and is blind to all nine.

⚠ Verify before authoring: read the tap rates off the FACTORY, not off the
description. This is the exact shape of the `noise` lane-meter finding (the meter
resolved `primaryAudioOutPortId` = the FIRST output, not the one the player
hears) — with nine outputs, whatever the glyph taps is one of nine and the face
must say WHICH.

### Q12 · `moog914` + `moog907a` — the two fixed filter banks, as a PAIR

**Merit: YES.** 14 and 10 params, 1 input and 1 output each, and — the reason
they are one entry — they SHARE the `moog-filterbank` centre-frequency lib. A
face for one is a face for both, and authoring them separately guarantees two
different layouts for one idea.

**The interchangeable-knob problem, with an answer.** Like `attenumix` and
`bluebox`, a rank over N identical band levels has no priority to express. Unlike
those, these bands have an INTRINSIC ORDER and an intrinsic LABEL: the centre
frequency. Rank by frequency, low → high, with the HP and LP cells at the ends,
and the prefix each cell paints is the Hz — information no level knob carries.

**ZERO CV inputs on both** (`cvT = 0`), so the CV audit that stopped three of the
last three modules is vacuous here by construction — state that as the finding
rather than running a null sweep and calling it a pass.

**Risk: LOW.** Audio-only, no video, no free-running source, no `node.data`.

### Q13 · `buggles` — the wogglebug

**Merit: YES.** 5 params, 3 inputs, 5 outputs (SMOOTH / STEPPED / CLOCK / BURST /
RING). A clean-room Buchla/Make Noise chaotic voltage source; `marbles` is the
faced sibling, so the house style already exists.

**The readout story is the BURST probability and the RING product.** BURST emits
probabilistic clusters of 3–7 triggers and RING is `smooth × stepped` — neither
is a knob. And like `ninelives`, the glyph taps ONE of five outputs: say which.

⚠ `art/scenarios/buggles/` already exists — read what is pinned there before
measuring anything, and by WHICH hash function.

### Q14 · `slewSwitch` — quad slew + sequential switch

**Merit: YES.** 7 params, 10 inputs, 7 outputs. Two ideas in one box (four
independent slew limiters, 1 ms–5 s, CV-controllable; a `step_clock`-advanced
4→1 switch), which is a genuine two-page face rather than one list.

**4 `paramTarget` CV inputs — run the audit rig.** This is the shape that was
defective three times running.

⚠ Note the registry: `slewSwitch.in1..in4` are listed in `PASSTHROUGH_BY_DESIGN`
as raw SIGNAL inputs (the things being slewed), NOT knob modulators. So the audit
has two terminal shapes exactly like `wavetableVco` did — derive the terminal off
the live handle, never assume it.

**Next after this cohort, in order:** `featurecv` (6 params, audio→CV feature
extractor with real derived ranges) · `unityscalemathematik` (5, the `k=1..3`
curve morph is a derived response no dial prints) · `illogic` (4 params, 10
derived logic outputs) · `destroy` (3, but the decimator's effective sample rate
and bit depth are unprintable) · `moog905` (3, spring reverb).

## 8. `wavetableVco` — THE AUDIT, MEASURED

Run against the REAL shipped worklet (`packages/dsp/dist/wavetable-vco.js`) in
`node-web-audio-api`, driven through the def's OWN factory — not a pure-TS
mirror, so the publish-an-AudioParam seam that broke #1661/#1662 exists in the
harness. SR 48 000, 0.25 s renders, metric = peak |Δsample| in LINEAR amplitude
over a settled window. Every number is reproduced on every run by
`art/scenarios/wavetable-vco/cv-path.test.ts`.

**M1 — ALL FIVE `paramTarget` INPUTS REACH THE AUDIO, on BOTH paths.** The
finding the last three audits did not get to have:

| input | param | base → target | KNOB peak \|Δ\| | CV peak \|Δ\| |
|---|---|---|---|---|
| `wavePos` | `wavePos` | 0 → 1 | 9.9937e-1 | 9.9937e-1 |
| `tune` | `tune` | 0 → 12 | 1.4999e+0 | 1.4999e+0 |
| `fine` | `fine` | 0 → 100 | 1.9943e+0 | 1.9943e+0 |
| `fmAmount` | `fmAmount` | 0 → 1 | 1.9769e+0 | 1.9769e+0 |
| `pmAmount` | `pmAmount` | 0 → 1 | 1.9883e+0 | 1.9883e+0 |

The two columns agree to every printed digit on every row, which is the strong
form: the CV terminal is not merely alive, it is the SAME terminal the knob
writes.

**M2 — THE MODULE HAS TWO TERMINAL SHAPES, and the sweep derives which.**
`tune`/`fine`/`fmAmount`/`pmAmount` publish an AudioParam (`din.param`, so
`AudioEngine.addEdge` takes the `connect(din.param)` branch). `wavePos` publishes
NO param — it is consumed audio-rate at worklet input 2 (`wp = wpKnob + wpCv`,
clamped 0..1) and is a named `PASSTHROUGH_BY_DESIGN` entry. A sweep that assumed
one shape would either throw or silently skip a row; this one reads the terminal
off the live handle and asserts the partition is exactly `{4 params, 1 port}`.

**M3 — THE TWO DEPTH CONTROLS ARE ENABLER-GATED, bit-exactly.** With nothing
patched into `fm` / `pm`, `fmAmount = 1` and `pmAmount = 1` each move the output
by exactly `0.0000e+0`. Not a defect — it is what a depth control IS — but it is
why both are ranked below `fine`, and it is asserted permanently so the base
patch's own assumption cannot rot. At depth 0 the modulators are equally
invisible (`0.0000e+0`), which is what makes them a legitimate part of the
control render.

**M4 — THE SOUNDING PITCH IS TWO PARAMS AND A HIDDEN ANCHOR.**
`f = 261.626 · 2^((tune + fine/100)/12)`, confirmed against the render at eight
points; every deviation is zero-crossing quantisation (`SR/period` is integral),
e.g. tune 0 / fine 0 → 262.295 Hz measured vs 261.626 formula (period 183.47 →
183 samples). tune −36 / fine −100 → 30.868 Hz measured, 30.868 formula, exact.
Neither knob prints Hz, neither knob prints the C4 reference, and a `tune`
readback does not budge when FINE moves the pitch a full semitone.

**M5 — FM IS EXPONENTIAL, SO ITS Hz SWING IS ASYMMETRIC AND SCALES WITH PITCH.**
Measured with a DC on `fm` and no other modulator:

| fmAmount | +1 V | −1 V | up Δ | down Δ |
|---|---|---|---|---|
| 0 | 262.30 Hz | 262.30 Hz | 0 | 0 |
| 0.25 | 311.69 | 220.18 | +50.06 | −41.44 |
| 0.5 | 369.23 | 185.33 | +107.60 | −76.30 |
| 1 | 521.74 | 130.79 | +260.11 | −130.84 |

Formula `up = f0·(2^a − 1)`, `down = f0·(1 − 2^−a)` reproduces every row. And at
`tune +12` the same `fmAmount = 1` gives +520.23 / −260.96 Hz — the swing DOUBLES
with the fundamental while the FM AMT dial does not move. That is the readout.

**M6 — PM DOES NOT MOVE THE PITCH; FM DOES. The instrument's own negative
control.** `pma * pm` is added to the READ phase (`p = this.phase + pma*pm`)
while the accumulator advances on `freq/sr` alone, so a DC phase offset shifts
where the table is read and leaves the period untouched. This is why the two
depths are in DIFFERENT bands.

**M7 — DEFECT (live, ledgered): THE CARD REACHES HALF THE FM/PM CONTRACT.**
`WavetableVcoCard.svelte` passed `min={0}` on `fmAmount` and `pmAmount` where the
def declares `min: -1`. The negative half — the documented polarity inversion,
"negative values invert the modulator's polarity" — was UNREACHABLE from the
card while the def-driven dock face reaches all of it. This is the `analogVco`
backdraft class verbatim, and it was already carried as a NAMED
`OPERATIONAL_DEBT` entry whose stated release condition was *"this rides a PR
that also carries the `vrt-update.yml` dispatch"*. A face PR is that PR, so it is
paid here: the card is converted to `paramSpec` (one copy of every number),
enrolled in `RANGE_BOUND_CARDS`, and the debt entry is DELETED rather than
re-worded.

**M8 — DEFECT (doc): the `PASSTHROUGH_BY_DESIGN` note contradicts the def.**
`cv-scale-registry.test.ts` says *"wavetableVco.wavePos: audio-rate input (no
paramTarget)"*. The def has declared `paramTarget: 'wavePos'` all along — the
exemption is correct, its stated REASON is not, and the correct reason (it is not
summed onto an AudioParam, so `cvScale` has nothing to scale) is the one the def's
own comment already gives. Corrected in place.

### What the audit did NOT find

No dead CV input, no dead knob, no unexposed DSP capability, no range
disagreement other than M7, and no defect in the authored docs (the `explanation`
correctly calls the FM exponential and not through-zero, and correctly says a
negative depth inverts the modulator). `wavetableVco` is a correct module with
one live card/def divergence and one wrong comment.

## 9. VERDICTS RECORDED — additions to §4

Applying STOP 1 to the pool members §1 did not reach. **"NO FACE ON MERIT" is a
complete answer**; so is "not a merit rejection — it needs a platform cell".

| module | params | verdict |
|---|---|---|
| `analogLogicMaths` | 2 | NO FACE ON MERIT. Attenuverter + logic: the module IS its five outputs, and the rear card renders those without a face. |
| `cvBuddy` | 2 | NO FACE ON MERIT. |
| `cvBuddyMini` | 2 | NO FACE ON MERIT. |
| `moog992` | 4 | NO FACE ON MERIT. A passive CV panel — four attenuators into a summing bus; the `moog994` argument (the module is its jack field, which is the REAR) applies with knobs attached. |
| `moog993` | 3 | NO FACE ON MERIT. A passive routing patch-bay; three ROUTE switches ARE the module. |
| `moog995` | 3 | NO FACE ON MERIT. Three independent passive attenuators — three interchangeable knobs with nothing to rank and nothing derived. |
| `fourplexer` | 4 | NO FACE ON MERIT. Four discrete selectors; the routing is the module, and it is legible on the rear. |
| `moog902` · `moog904a` · `moog904c` · `moog911a` · `moog921a` | 3 each | NO FACE ON MERIT INDIVIDUALLY — but see the BANK note below. |
| `moog905` | 3 | MARGINAL-YES, deferred. A spring reverb with a real derived quantity (the dispersion chirp) but only three dials; queue it behind Q14. |
| `moog923` | 3 | MARGINAL-YES, deferred. Noise + two filter taps; the `moog903a` question (are the tap levels unprintable?) applies and is a one-hour measurement. |
| `destroy` | 3 | MARGINAL-YES, deferred. The decimator's EFFECTIVE sample rate and bit depth are genuinely unprintable by a 0..1 dial — that is a readout, and it is the whole face. |
| `illogic` | 4 | **SHIPPED as Q17 (2026-08-16, #1751).** The "MARGINAL" was wrong and §11 below says why with numbers. |

**NOT merit rejections — blocked on a platform cell, each named:**

| module | what it needs | why a generic face is a LOOK LOSS |
|---|---|---|
| `moog960` | a STEP-GRID cell | 3 rows × 8 steps = 24 step pots. A face is a 36-item ranked list of things that are a GRID; the grid is the instrument. |
| `moog984` | a MATRIX cell | 16 cross-points addressed as `m_ij`. Ranking them linearly destroys the only structure they have. |
| `dockscope` | a registered PANEL | 3 params, ZERO outputs — a terminal visualiser. The module IS its trace. |
| `rasterize` | a registered PANEL / extension | the module IS the picture, and #1664 already found a live CV defect in it. |
| `foxy` · `synesthesia` | `face.extension` | audio-domain defs with VIDEO outputs; a generic face silently drops the picture, which is the `scope` (Q4) argument. |
| `wavecel` | `face.extension` + poly | `polyPitchGate` + `mono-video` + FOUR `controlFamilies`. Also a poly module, so it owes the REAL-source-chain e2e. |

**The moogafakkin SYSTEM-55 BANK — a batch, not a queue position.**
`moog921Vco` (6) · `moog921a` (3) · `moog921b` (5) · `moogCp3` (5) · `moog911`
(4) · `moog902` (3) · `moog904a/b/c` (3) form one instrument. Their cards already
share the beige MoogPanel house look, and their faces should share a house
LAYOUT for the same reason — authoring them one at a time guarantees nine
different answers to the same question. Treat as one batch after the cohort
above, and note `moog921b` reads `freq_bus`/`width_bus` from a `moog921a` rather
than carrying its own 1V/oct jack, so the pair's faces have to agree.

## 10. WHAT COHORT 2 ADDS TO §5

6. **RE-DERIVE THE POOL, DO NOT RE-ORDER THE LIST.** §1's ordering was by param
   count, and that ordering alone hid `ninelives` — 2 params, 9 outputs, and the
   `noise` merit argument verbatim. A module's face value lives in what it
   PUBLISHES as much as in what it exposes; sort by both.

7. **A "known-answer" ledger entry can name the PR that pays it.** The
   `OPERATIONAL_DEBT` entry for `WavetableVcoCard` did — *"rides a PR that also
   carries the `vrt-update.yml` dispatch"* — and a face PR is definitionally
   that PR. Before authoring a face, grep the debt/exemption lists for the module
   you are about to touch: you may already be holding the release condition.

8. **A CV audit that finds NOTHING is still the deliverable.** Three of three
   audited modules were defective; the fourth was clean, and the clean result is
   only worth anything because the instrument carried its positive controls
   (MECH, MECH-WORKLET, and a per-input KNOB leg) into the permanent test. A
   green sweep with no controls is indistinguishable from a sweep that measured
   nothing.

---

# COHORT 3 — appended 2026-08-15

Cohort 2 is exhausted: Q9 `wavetableVco`, Q10 `charlottesEchos`, Q11 `ninelives`,
Q12 `moog914`+`moog907a` and Q13 `buggles` are merged. Q14 `slewSwitch` is being
built concurrently and is **not touched here**.

## 11. THE RE-DERIVED POOL (2026-08-15, `origin/main` @ `1481e963`)

Same three sources as §6, none of them this file, RE-RUN rather than re-read:

```sh
# contract-lock.txt            -> domain / params / discrete / in / out /
#                                 paramTarget count / families / port KINDS
# face-migration-inventory.ts  -> disposition (SOURCE, not the generated md)
# strict-faces.ts              -> the promoted set
# join: generic-face ∩ audio ∩ ¬STRICT_FACES, printed in THREE orderings
```

**`|STRICT_FACES|` = 41. The pool is 52.** The re-derivation is its own negative
control on §6: every cohort-2 entry that merged has LEFT the pool
(`wavetableVco`, `charlottesEchos`, `ninelives`, `moog914`, `moog907a`,
`buggles` are all gone), and `slewSwitch` is still in it — exactly the shape a
correct join has while a sibling PR is open.

**And one ordering is not enough** (§10.6): sorting by param count alone is what
hid `ninelives`, so the join was printed three ways — by params, by OUTPUTS, and
by params+outputs.

| type | par | disc | in | out | cvT | fam | disposition here |
|---|---|---|---|---|---|---|---|
| `mixmstrs` | 91 | 10 | 111 | 6 | 91 | 0 | Q7 — stopped by #1662 |
| `wavesculpt` | 79 | 12 | 26 | 7 | 11 | 1 | owner manual review (§4) |
| `moog960` | 36 | 11 | 3 | 4 | 0 | 0 | needs a STEP-GRID cell |
| `foxy` | 33 | 6 | 5 | 5 | 3 | 0 | extension-class (video out) |
| `synesthesia` | 22 | 4 | 4 | 48 | 0 | 0 | extension-class (video out) |
| `moog984` | 16 | 0 | 4 | 4 | 0 | 0 | needs a MATRIX cell |
| `wavecel` | 10 | 0 | 7 | 4 | 3 | 4 | extension-class (poly + video) |
| `scope` | 9 | 3 | 11 | 3 | 9 | 0 | Q4 — extension-class |
| `swolevco` | 8 | 0 | 7 | 4 | 4 | 0 | Q5 — unblocked by #1669 |
| `slewSwitch` | 7 | 2 | 10 | 7 | 4 | 0 | **Q14 — IN FLIGHT, do not touch** |
| `treeohvox` | 7 | 0 | 10 | 1 | 7 | 1 | Q3 — blocked by #1658 |
| `featurecv` | 6 | 1 | 1 | 4 | 0 | 0 | **Q16** |
| `moog921Vco` | 6 | 0 | 8 | 4 | 5 | 0 | the System-55 BANK batch |
| `timelorde` | 6 | 4 | 5 | 14 | 0 | 0 | Q2 — extension-class |
| `moog921b` | 5 | 1 | 5 | 4 | 0 | 0 | the System-55 BANK batch |
| `moogCp3` | 5 | 0 | 5 | 7 | 0 | 0 | the System-55 BANK batch |
| `unityscalemathematik` | 5 | 0 | 8 | 3 | 5 | 0 | **Q15 — IMPLEMENTED (this branch)** |
| `illogic` | 4 | 0 | 4 | 10 | 0 | 0 | **Q17** |
| `destroy` | 3 | 0 | 4 | 1 | 3 | 0 | **Q18** |
| `moog923` | 3 | 0 | 1 | 4 | 0 | 0 | **Q20 — PROMOTED INTO THE COHORT (§11.1)** |
| `moog905` | 3 | 0 | 1 | 1 | 0 | 0 | **Q21** |
| `analogLogicMaths` | 2 | 0 | 4 | 5 | 2 | 0 | **Q19 — PROMOTED INTO THE COHORT (§11.1)** |

### 11.1 DID THE RE-DERIVATION AGREE WITH THE FIVE §7 NAMED? Mostly — and the disagreement is the finding.

§7's closing line named `featurecv` · `unityscalemathematik` · `illogic` ·
`destroy` · `moog905`. **All five are still in the pool at the stated param
counts**, so nothing on that list has gone stale and none of them has been
promoted out from under it. But the OUTPUT ordering surfaces two candidates the
list does not contain, and **both out-rank `moog905`**:

- **`analogLogicMaths` — 2 params, 5 outputs.** §9 rejected it: *"NO FACE ON
  MERIT. Attenuverter + logic: the module IS its five outputs, and the rear card
  renders those without a face."* **That is the sentence §10.6 was written to
  retire.** It is the `ninelives` argument with the sign flipped — `ninelives`
  has 2 params and 9 outputs and was promoted *precisely because* the module IS
  its outputs and no dial can print their relation. Read off the def rather than
  the verdict: `SUM = tanh(A′+B′)` and `PRODUCT = tanh(A′·B′)` are
  **soft-clipped**, and the compression is stated against the UN-CLIPPED SUM
  (the only reference that makes the two rows comparable — see the ⚠ below):

  | inputs, both attenuverters +1 | linear sum | `tanh` | compression |
  |---|---|---|---|
  | ±1 each | 2.0000 | 0.964028 | **−6.34 dB** |
  | ±2 each | 4.0000 | 0.999329 | **−12.05 dB** |

  Neither `attA` nor `attB` can print a compression that only exists when both
  are open, and it more than doubles across a range of CV a rack produces
  routinely. **Verdict corrected → Q19.**

  ⚠ **THESE TWO NUMBERS ARE DERIVED FROM THE DEF'S STATED LAW, NOT RENDERED**,
  and that distinction is load-bearing rather than pedantic: §5.2's whole point
  is that a spec's arithmetic is a hypothesis. **Measure them against the real
  worklet before authoring**, exactly as Q15 did. ⚠ And an earlier draft of this
  paragraph got them WRONG — it quoted `−0.318 dB` and `−6.02 dB`, which are
  the first row measured against UNITY and the second against nothing
  consistent. Two rows referred to two different denominators and read as one
  trend. **A dB figure with an unstated reference is not a measurement**, which
  is the same lesson §15.10 records for `destroy` and §13 M8's budget records
  for the model-vs-worklet leg.
- **`moog923` — 3 params, 1 audio input, 4 audio outputs** (`white`, `pink`,
  `lp`, `hp`). §9 already flagged it honestly (*"MARGINAL-YES, deferred. The
  `moog903a` question (are the tap levels unprintable?) applies"*). The OUTPUT
  ordering makes it concrete: one LEVEL dial and two **0..1 cutoff dials with no
  `units`** drive four simultaneous taps, so the corner frequencies are nowhere
  on the module and `pink`'s level relative to `white` is a property of the
  pinking filter no dial states. Three unprintable facts over four taps is
  exactly the bar that promoted `noise` (ONE param, three outputs). **→ Q20.**

Everything else the output ordering surfaces is already dispositioned:
`synesthesia` (48 outs) and `timelorde` (14) are extension-class; `moogCp3` (7),
`moog921b` and `moog921Vco` belong to the System-55 BANK batch §9 named;
`moog993`/`moog994` are the passive jack-field rejections; and
`cvBuddy`/`cvBuddyMini` publish 5 and 4 outputs but their interesting quantities
(SLOTS / LATE / ES-9-present) live in `node.data`, which `FaceReadoutValue` is
structurally unable to see — a rejection no re-ordering can overturn.

**What this pool STILL cannot see**, stated so a green derivation is not mistaken
for a complete one: the join reads DECLARATIONS. It cannot tell a module whose
five outputs are five genuinely different functions from one whose five outputs
are five copies of the same bus, and it cannot see a card-only affordance at all
— **STOP 2 is a grep, not a query.** Both were done by hand, per entry, below.

## 12. THE COHORT

Ordered by MERIT, not by param count. §5.2 applies to every one of them: the
numbers below were measured in this branch and are still to be re-derived by the
per-module oracle, not trusted.

### Q15 · `unityscalemathematik` — the curve-morph attenuverter  ⟵ IMPLEMENTED (#1717 / this branch)

**Status: promoted.** Face authored, `STRICT_FACES` entry added, four derived
readouts registered, the card bound to the def through `paramSpec` (which is the
fix for a FIVE-label card/def divergence, #1714), the false docs claim corrected
(#1715), VRT roster entry added, capture dispatched. Full audit in §13.

**What it is FOR, musically.** UNITYSCALEMATHEMATIK is the rack's CV BENDER. Six
other modules attenuate or invert a control voltage — `scaler`, `polarizer`,
`depolarizer`, `attenumix`, `illogic`, `analogLogicMaths` — and every one of them
is a straight line: `out = in × k`. This is the only module in the rack that
changes the SHAPE of a voltage rather than its size. The verb is *bend the
response*: park an LFO or an envelope on A IN, turn A CRV up, and the bottom of
the sweep goes flat while the top keeps its reach — the same modulation, redealt
so most of the travel happens where you wanted it.

**Merit (STOP 1): YES.** 5 params, 8 inputs (5 of them `paramTarget` CV), 3
outputs — and a response law that is a pure function of two knobs and that
NEITHER of them can print (§13 M3/M4).

**STOP 2 (`grep` over `UnityscalemathematikCard.svelte`, 67 lines): CLEAN.** Zero
`<button>`, zero `<select>`, zero `<input>`, no `node.data`, no `write(`, no
`attachExternalSource`. Five `Fader`s, three static section captions and a
`PatchPanel`. Every affordance is a `ParamDef`, so nothing becomes unreachable on
promotion. (The three captions — `UNITY` / `A` / `B` — are card CHROME, not
controls; the face reproduces them as band labels.)

**Ranking** (against the DSP, not the declaration order — measurements in §13):

| rank | key | why it is here and not lower |
|---|---|---|
| 1 | `aCurve` | the module's IDENTITY — the only control in the rack that bends a CV instead of scaling it. Measured: a 0.5 input leaves at 0.500 / 0.250 / 0.125 across its travel, and a 2.0 input leaves at 2.00 / 4.00 / **8.00** — it moves the two halves of the range in OPPOSITE directions |
| 2 | `aAtten` | A's scale/invert AND its ENABLER: at 0 the whole A channel is dead, curve included. Ranked below the identity and above everything in B because it is UNCONDITIONALLY applicable — it still works at curve 0, where the module is a plain attenuverter |
| 3 | `bCurve` | the same law again. B is a CLUSTER of A, not a second idea — which is why it is a cluster on one page rather than a page of its own |
| 4 | `bAtten` | B's enabler, under A's for layout order alone, and that is stated rather than dressed up |
| 5 | `unityAtten` | ranked LAST **deliberately**: it does the one thing three other modules already do, and it is the only control here that cannot bend anything. It is also the only one with no readout, because a dB conversion of a single dial IS that dial relabelled |

Tier ladder as a sentence: *mini shows A CRV; compact adds A ATT; the six-cell
lane plate and the dock both show all five, so the ranking's whole authority is
at the top two.*

**Pages (FUNCTION / signal order — deliberately disagreeing with `order`):**

1. `shape` — the two curve-shapers, as two CLUSTERS (`a`, `b`). ⚠ This is the
   documented cluster case verbatim (`ModuleFacePage.clusters`: *"reach for a
   CLUSTER when they are the same idea, twice"*) — A and B are not merely
   similar, they are bit-identical code paths on different inputs (§13 M5), so a
   second PAGE would buy an ~81 px band to say the same word twice.
2. `unity` — `unityAtten`.

`order` and `pages` disagree because priority and signal flow genuinely differ
here: UNITY is the FIRST section on the panel and the LAST thing worth reaching
for.

**Hero:** `hero.control: 'aCurve'` — the identity dial at hero size — with four
derived readouts as the row below it. **`glyph: 'none'`**, and that is not a
default: see the ⚠ below.

**No `face.title`, no `face.hint`, no band hints, no sidebar.** Owner ruling
2026-08-11: plain labels and values.

**Derived readouts** — four, in two pairs, and the PAIRING is the instrument's
own negative control:

| valueId | what it says | which knob is BLIND to it |
|---|---|---|
| `unityscale-a-half` | A's output for a HALF-SCALE input | A ATT — blind to A CRV (0.500 → 0.125 with ATT untouched); A CRV — blind to A ATT |
| `unityscale-a-over` | A's output for a 2× input | the SAME two knobs, moving the OTHER WAY: A CRV up sends `a-half` DOWN and `a-over` UP. Publishing both is what makes the curve's real behaviour visible instead of merely assertable — and it is the claim §13 M4 found the docs getting wrong |
| `unityscale-b-half` | the same for B | B ATT / B CRV — and A's two readouts must NOT move, which is the cross-section control |
| `unityscale-b-over` | the same for B | as above |

**Risk: LOW.** Pure per-sample math, no free-running source, no card producer, no
`node.data`, no video. Renders bit-identically twice (§13 M8), so #1680's
non-reproducible-render hazard is CLOSED here by measurement rather than by
assumption.

⚠ **THE GLYPH RESOLVES TO NOTHING, AND SAYING SO IS THE POINT.**
`primaryAudioOutPortId` matches `type === 'audio'`; this module declares three
`cv` outputs and no audio output at all, so ANY glyph but `'none'` resolves to
`{kind:'static'}` — a live-looking readout of NOTHING, which is the `marbles`
defect (#1692) and the `ninelives` near-miss (#1706). It is caught now: the
*"no declared glyph resolves to a DEAD (static) binding"* clause of
`module-face-lint` is UNCONDITIONAL with no exemption list and no count.
`glyph: 'none'` is declared, and the face takes the extra lane cell instead.

⚠ **The same applies to `featurecv`, `illogic` and `analogLogicMaths`** — all
three are CV/gate-output-only. **Do not spend a spec argument on which output a
glyph would tap: there is no glyph.**

### Q16 · `featurecv` — the audio→CV feature extractor  ⟵ IMPLEMENTED (#1743 / this branch)

**Merit: YES,** and it has the richest readout story in the cohort. 6 params
(`gain`, `attack`, `release`, `bipolar`, `onset_sens`, `onset_debounce`), 1 audio
input, 4 outputs (`loud`/`bright`/`punch` CV plus an `onset` **trigger**).

**The readout story: every number the player cares about is a MAPPING the dial
does not print.** Read off `packages/dsp/src/lib/featurecv-dsp.ts` in this branch:

- `onsetSensToThreshMult` maps SENS 0..1 onto an adaptive-threshold multiplier of
  **4.0 → 1.2**, INVERTED (higher SENS = LOWER multiplier). The dial prints
  `0.50`; the detector is firing at **2.6×** the running mean flux, and the dial
  can say neither the number nor the direction.
- `punchToCv` maps crest factor **1..6** onto 0..1, so a pure sine (crest √2)
  reads `0.083` and white noise (~3.5) reads `0.5`. With POLARITY at its default
  BIPOLAR those become **−0.83** and **0.0** at the jack — and the POLARITY
  toggle prints `BI`.
- `onset_debounce` is a lockout, so the MAXIMUM trigger rate is `1000/debounce` =
  **12.5 Hz** at the shipped 80 ms. That is the number deciding whether a
  16th-note hi-hat gets through; the dial prints `80 ms`.
- `LOUD_MAKEUP = 2.0` and `BRIGHT_GAIN = 2.0` sit between the measurement and the
  jack, and `gain` (a ×0.25..×4 trim) is IN FRONT of the analyser — so LOUD's CV
  is `clamp01(2·rms(gain·x))` and the GAIN dial is blind to what CV it produces.

**⚠ THE ONE REAL COST, AND IT MUST BE DECIDED BEFORE AUTHORING: PROMOTION LOSES
THE METERS.** `FeaturecvCard.svelte` is 219 lines and roughly half of it is a
live display — three bars (`LOUD`/`BRIGHT`/`PUNCH`) and an `ONSET` LED, pumped on
rAF from `engine.read(node, 'snapshot')`. **A `FaceReadoutValue` sees ONLY
params** (`face-readout-values.ts:83`), so the meters are structurally
underivable from a readout, and the module has no audio output for a `meter`
glyph to tap. This is the `scope` (Q4) argument at a smaller scale: the module is
an ANALYSER and its picture IS the analysis.

Two honest routes; the spec must PICK one rather than discovering it mid-build:

1. **A `custom` sidebar block** (`sidebar-panels.ts`) carrying the four meters —
   the **meowbox precedent** exactly: a `custom` block carries no `face.order`
   rank, so it dodges the "a panel's first legal rank is 7" wall that made
   `drummergirl` drop its picture and its audition together. Recommended, and a
   normal-sized PR.
2. Accept the loss and ship six ranked controls. Cheaper, and a straight look
   regression on the module whose whole job is showing you what it heard.

⚠ **AND IT IS A LIVE SURFACE, so the VRT argument is NOT free.** The meters poll
the engine every rAF. The `bluebox` precedent says a polling hero CAN baseline
deterministically — but bluebox's panel only assigns state when its 12-bit mask
CHANGES, while featurecv's bars write `mLoud`/`mBright`/`mPunch` on EVERY frame.
On a frozen graph the snapshot never updates and the bars sit at 0, which is
almost certainly deterministic; **measure it with `vrt-face-audio-probe` before
believing it**, the way `cube` and `bluebox` were measured, and never infer it
from a passing scene.

⚠ `face.order` must rank `bipolar`. It is `0..1 discrete` → a TOGGLE cell, and
the card's `<button>` maps onto it one-for-one, so STOP 2 is clean — but a
promoted module that grows a switch-shaped param nobody classified is a
`module-face-lint` failure, and this one already exists.

⚠ **`onset` declares `edge: 'trigger'`.** Nothing on the FACE consumes it, so
#1703's rule does not bite the face itself — but any test that COUNTS onsets must
use `$lib/audio/edge-detect` `createEdgeCounter` and never rescan an
`AnalyserNode` buffer. `buggles`' `external_clock` captured **1 rising edge in
6** doing exactly that.

⚠ `art/scenarios/featurecv/feature-extract.test.ts` and
`e2e/tests/featurecv-source-chain.spec.ts` BOTH already exist. Read what they pin
before measuring anything; the e2e already drives a REAL source chain (noise →
featurecv → filter cutoff → audible RMS), which a face PR should extend rather
than duplicate.

### Q17 · `illogic` — the attenuverter / math / logic block

**Merit: YES.** 4 params, 4 `cv` inputs, **10 outputs** — four attenuverted
passthroughs, `sum`, `diff`, and four logic gates. **Zero `paramTarget` CV
inputs**, so the CV audit that stopped three of three modules is VACUOUS HERE BY
CONSTRUCTION; state that as the finding rather than running a null sweep and
calling it a pass (the Q12 precedent).

**The readout story is the SUM BUS's HEADROOM, and it is measured.** Rendered
through the def's own factory in `node-web-audio-api` (this branch; DC drivers;
settled sample; all four attenuverters at their shipped +1 default):

```
spawn, nothing patched : att1..4=0  sum=0  diff=0  and=0  nand=1  or=0  not=1
all four inputs at +1  : att1..4=1  sum=4  diff=0  and=1  nand=0  or=1  not=0
att1=0, in1=1, in2=1   : att1=0 att2=1  sum=1  diff=1  and=1  nand=0  or=1  not=0
```

Three facts fall out of that table, and no dial prints any of them:

1. **`SUM`'s full-scale reach is `|att1|+|att2|+|att3|+|att4|` — ×4 (+12.04 dB)
   at the shipped defaults.** Web Audio summing is implicit and there is no
   limiter anywhere in the factory, so four correlated inputs leave this module
   4× over. It is the `attenumix` headroom readout with a harder edge, because
   `attenumix` at least ends in a `tanh`.
2. **`DIFF` is SILENT at the defaults for correlated inputs** —
   `(att1+att2) − (att3+att4)` = 0 when all four sit at +1. A player patching
   four copies of one LFO into a module called "diff" gets nothing, and every
   knob reads `1.00`.
3. **`NAND` and `NOT` sit at +1 DC from spawn**, driven by a free-running
   `ConstantSource(+1)`. Correct Boolean semantics — and worth printing, because
   two of ten jacks are HOT on an unpatched module.

**Confirmed, NOT a defect:** the logic block reads the **RAW** input,
pre-attenuverter — row 3 shows `att1 = 0` while `and`/`or` stay high. The def's
own `docs` say so (*"Does not affect the logic threshold (logic always reads the
raw input)"*) and the factory backs it (`gate1` taps `in1Bus`, not `att1`).
**Do not "fix" it**; assert it, because it is the module's most surprising true
statement.

**The interchangeable-knob problem, with the `bluebox`/`moog914` answer.** Four
identical attenuverters have no priority to express. Rank by LAYOUT so every
PREFIX is a recognisable fragment (att1..att4), and put the INFORMATION in the
readouts, which is where it belongs.

⚠ `art/scenarios/illogic/` already holds `attenuverter-and-logic.test.ts` **and**
a `profile.test.ts` — read what is pinned there, and by WHICH hash, before
measuring anything.

⚠ `cv-scale-registry.test.ts` names `illogic: ['in1','in2','in3','in4']` as
PASSTHROUGH_BY_DESIGN. That is correct and must stay: they are the signals being
attenuverted, not knob modulators.

### Q18 · `destroy` — the bitcrusher, and it ships a LIVE DEFECT (#1716)

**Merit: MARGINAL-YES on the controls, YES on the finding.** 3 params, 1 audio
in, 1 audio out, 3 `paramTarget` CV inputs. §9 deferred it with the right
argument — *"the decimator's EFFECTIVE sample rate and bit depth are genuinely
unprintable by a 0..1 dial"* — and the audit turns that from a readout into a
bug report.

**MEASURED (this branch, the real shipped Faust wasm through
`art/setup/faust-offline.ts`; 1.5 s render; census over the settled tail
t ≥ 1.2 s; 1000 Hz sine at 0.5; plateau = consecutive samples within 1e-4):**

| DECIMATE | median plateau | effective SR the doc claims (`SR/N`) | effective SR MEASURED |
|---|---|---|---|
| 1 | 1 | 48 000.0 Hz | 48 000.0 Hz |
| 2 | **1** | 24 000.0 Hz | **48 000.0 Hz — the setting is a NO-OP** |
| 4 | 3 | 12 000.0 Hz | 16 000.0 Hz |
| 8 | 7 | 6 000.0 Hz | 6 857.1 Hz |
| 16 | 15 | 3 000.0 Hz | 3 200.0 Hz |
| 64 | 63 | 750.0 Hz | 761.9 Hz |

**The hold length is `DECIMATE − 1`, not `DECIMATE`**, and at the bottom of the
dial that is the difference between an effect and nothing at all. Root cause is
visible in `packages/dsp/src/destroy.dsp:6,21`: the slider is `: si.smoo`-ed and
then TRUNCATED by `int(d)`. A one-pole smoother approaches its target
asymptotically and never reaches it, so `int(7.999…) = 7` for every integer
position on the dial. `rint` / `int(d + 0.5)` is the fix; **it moves the ART
baseline**, so it belongs in `destroy`'s own PR with an `art:update` and a
reviewed manifest diff (a spectrum move here is expected and TIMBRAL), not folded
into a face wave.

**⚠ AND THE MEASUREMENT ALMOST DIDN'T HAPPEN — VALIDATE THE INSTRUMENT.** The
first two instruments both returned confident, clean, WRONG answers, for the same
single cause:

- *"longest run of bit-identical consecutive samples"* → **1 at every DECIMATE**
  ("decimation does nothing").
- *"count of distinct output levels in the settled tail"* → **624 at every BITS
  value from 16 down to 1** ("bit reduction does nothing").

Both are artefacts of a **−90 dB dry leak**: `wet` is `si.smoo`-ed too, so at
WET = 1 the settled value is ≈ `0.999968` and `audio*(1−wet)` never closes. A
residual ~1.6e-5 sine rides on every held plateau and breaks bit-equality without
moving the plateau. **A tolerance-based census recovers the truth immediately.**
Anyone measuring this module must not compare output samples for EQUALITY.

**The face, once the defect is fixed:** two readouts — the effective sample rate
in Hz and the quantisation step / level count — each a pure function of ONE dial,
which is this entry's weakness and why it ranks below `illogic`. The strongest
available form is a JOIN: the crush is a CASCADE, so the number of distinct
output levels a player actually hears is a function of BITS **and** DECIMATE
together (a held sample is quantised once), and `wet` scales it back toward the
dry. Measure the join before ranking.

⚠ `e2e/tests/cv-range-uniformity.spec.ts:243` spawns a `destroy` with
`decimate: 32`. Promotion does not touch it (that spec drives params, not the
card), but re-read it after the DSP fix — its expectations sit downstream of the
very off-by-one above.

#### BUILT — 2026-08-16, PR #1766 (#1716, #1764, #1765)

Everything below was measured against the SHIPPED compiled wasm and is
re-derived on every run by `art/scenarios/destroy/face-audit.test.ts`. Recorded
here because two of the entries above turned out to be WRONG, and the entry
that was wrong is more useful to a later reader than the ones that were right.

**#1716 REPRODUCED and is fixed.** The hold-length table above is confirmed
exactly. One correction to its root-cause sentence: the smoother's shortfall is
not merely asymptotic, it is a float32 **STALL** — `y += 0.001·(x−y)` stops
changing `y` once the increment falls under half an ULP, leaving it **≈ 4.8e-4**
short at `d = 8` and staying there for the rest of the render. `int(d + 0.5)`
absorbs ±0.5 in either direction; verified at 1.4→1, 1.6→2, 2.49→2, 2.51→3.

**⚠ THE JOIN THIS ENTRY PROPOSED DOES NOT EXIST, and the entry told the right
person to check.** *"The number of distinct output levels a player actually
hears is a function of BITS **and** DECIMATE together"* is FALSE. Measured, the
level census is a function of **BITS alone**: exactly 9 at 4 bits and 5 at 3
bits, at DECIMATE 1, 2, 4, 8, 16 **and** 64. Decimation RE-USES grid cells
rather than removing them. What makes the prediction plausible is real but is an
artefact of the WINDOW: at 8 bits the census does read 129 / 95 / 47 as DECIMATE
climbs, because a 0.3 s tail holds only 225 samples at DECIMATE 64 and cannot
visit 129 cells. It vanishes at depths whose grid the window can fill, which is
why the assertion is stated at 4/3/2 bits.

*The general lesson, since it will recur:* **a census over a finite window
measures the window as much as the cascade.** Ask what the sample count is
before reading a count as a property.

**The join the face ships instead is the DATA RATE** — `bits × effective rate`,
kbit/s. A genuine two-dial product (768 at the defaults, 24 at DECIMATE 8 /
BITS 4) and the figure of merit a player recognises.

**Three findings this entry did not predict:**

* **BITS has a DEAD ZONE and it is a CLIFF.** Mid-tread quantiser ⇒ anything
  under half a step rounds to exactly zero, i.e. below `−6.02 × bits` dBFS. At 1
  bit a source 1.2× over the threshold leaves at −4.3 dBFS and one at 0.98×
  leaves at −99.0. The shipped doc said *"1 bit is near square-wave
  destruction"*, true only above −6 dBFS.
* **A level meter is BLIND to DECIMATE** — 0.12 dB across the whole travel on
  broadband, 0.00 dB on a sine, against 99.2 dB of error-vs-dry. That decided
  the glyph (`scope`, not the FX-family `meter`) on a measurement.
* **A card/def label divergence** (`Decimate` vs `Dec`), already sitting in
  `VOCABULARY_DEBT` and paid here.

**⚠ AND PROMOTING IT EXHAUSTED A FIXTURE (#1765) — the #1689 hazard, one step
worse.** `destroy` was the LAST accepted candidate in
`e2e/tests/_face-fixtures.ts`'s `UNMIGRATED_CANDIDATES`, so promotion takes the
legacy-fallback fixture to zero and the IIFE throws **at module load**, before
any spec runs. The replacement then exposed a second, unwritten requirement: the
operability leg drives `.fader-wrap .track`, so the fixture must mount a
**Fader**, and the first candidate tried (`moog902`) draws knobs and failed as a
30 s timeout. Both are now checked predicates rather than prose. **Any later
queue item that promotes a module must re-read that file, not just grep for its
own module name.**

**Instrument controls worth carrying to Q19+:** the `wet` dry-leak trap named
above is real (−89.8 dB measured) and is kept as a permanent test leg; so is the
**1000 Hz source** trap, which is NOT in the entry above and cost a cycle here —
1000 Hz is exactly 48 samples/period at 48 kHz, so it visits only 25 distinct
magnitudes and reports "bit reduction does nothing" at 16, 12 and 8 bits alike.
Use C4 (183.47 samples/period) for anything counting levels.

### Q19 · `analogLogicMaths` — the CONTINUOUS logic block (§9's verdict, CORRECTED)

**Merit: YES on the readouts — a correction to §9, which rejected it on param
count.** 2 params (`attA`, `attB`), 4 inputs (2 signal + 2 `paramTarget` CV), 5
outputs (`min`, `max`, `diff`, `sum`, `product`).

**What earns it a face is the `tanh`.** `SUM = tanh(A′+B′)` and
`PRODUCT = tanh(A′·B′)` are the only two outputs in the `illogic` /
`analogLogicMaths` pair that are SOFT-CLIPPED, and the clip is a JOIN over both
attenuverters — see the table in §11.1: **−6.34 dB** against the un-clipped sum
with two full-scale inputs at the shipped defaults, **−12.05 dB** with two ±2
sources. Neither dial can print a compression that only exists when both are
open, and it more than doubles across a range of CV a rack produces routinely.
`min`/`max`/`diff` are LINEAR and are the readouts' own negative control — they
must NOT move when the clip does.

⚠ **DERIVED FROM THE DECLARED LAW, NOT RENDERED.** Measure both rows against the
real worklet before authoring (§5.2), and state the dB REFERENCE in the
assertion message — an earlier draft of this entry quoted two figures against
two different denominators and they read as one trend.

⚠ **The `ninelives` lesson is the whole reason this entry exists.** §9's
rejection sentence — *"the module IS its five outputs, and the rear card renders
those without a face"* — is the exact argument §7 recorded as WRONG for
`ninelives`. A module's face value lives in what it PUBLISHES as much as in what
it exposes.

⚠ **2 `paramTarget` CV inputs — run the audit rig**
(`art/scenarios/wavetable-vco/cv-path.test.ts` is the template, and
`art/scenarios/unityscalemathematik/cv-path.test.ts` is the two-terminal-shape
variant). This is the shape that was defective three times running.

⚠ **Zero audio outputs → `glyph: 'none'`**, same as Q15/Q16/Q17.

⚠ **STOP 1 is genuinely close here.** 2 params is the refusal threshold, and the
whole case rests on the readouts being real. If the `tanh` turns out unreachable
in practice — every realistic CV source well under ±1, so the clip never engages
— that is a NO and it should be REPORTED as one. Measure the knee before
authoring.

#### BUILT — 2026-08-17 (#1771, #1772, #1773)

Everything below was measured against the SHIPPED worklet through the def's own
factory and is re-derived on every run by
`art/scenarios/analog-logic-maths/face-audit.test.ts` (27 legs, 1.4 s).

**STOP 1 PASSES, and the knee is the reason.** The entry told this branch to
measure it before authoring, and the answer is not marginal. SUM's compression
against the UN-CLIPPED sum:

```
drive  ±0.05  ±0.10  ±0.25  ±0.30  ±0.40  ±0.50  ±1.00  ±2.00
dB     −0.03  −0.11  −0.68  −0.96  −1.62  −2.37  −6.34  −12.05
```

⚠ **The entry's derived figures REPRODUCED** — −6.3388 and −12.0470 against
§11.1's −6.34 / −12.05. That is worth recording precisely because §15.14 exists:
this is the first cohort-3 entry whose unrendered arithmetic turned out RIGHT,
and it stayed right only because §11.1 had already caught and corrected its own
first draft (−0.318 / −6.02 against two different denominators).

⚠ **BUT THE PROSE ABOUT THE KNEE WAS WRONG, IN THIS BRANCH.** The first draft of
the face comment said the compression *"crosses 1 dB at about a THIRD of the rail
(±0.3)"* — read straight off the ±0.3 row, which is **−0.9627 dB and has
therefore NOT crossed**. The gate caught it. *The general lesson, since it will
recur:* **a table is not a claim. Reading a threshold OFF a table is a
derivation, and it obeys the same "measure it" rule as the table itself.**

**THE MERIT CLAIM IS A JOIN, confirmed:** with ATT B at 0 the same full-scale
input compresses by only −2.37 dB, so opening the second dial nearly triples it.

**THREE FINDINGS THE ENTRY DID NOT PREDICT.**

* **THE SOFT-CLIP IS ON THE WRONG PAIR OF JACKS (#1772).** The DSP said *"soft-
  clip is applied only to SUM + PRODUCT (the operations that can leave the
  [-1,+1] range). MIN / MAX / DIFF stay bounded for any in-range pair"* — wrong
  in BOTH halves. For in-range inputs `|a′·b′| ≤ 1`, so PRODUCT's tanh protects
  nothing (a fixed −2.37 dB of distortion at the corner); and **DIFF reaches
  `|attA|+|attB|` = ±2.00 with no clip at all** and is the ONLY jack that leaves
  the rail. `algebra.test.ts` asserted the bounds of SUM and PRODUCT and said
  nothing about DIFF's range — the half that was wrong. Behaviour deliberately
  unchanged; the face prints the live ceiling as `peak`.
* **BOTH CV INPUTS ARE HALF-DEAD AT THE SHIPPED DEFAULT (#1773).** `attA`/`attB`
  ship at +1, which IS the declared `maxValue`, and a cable ADDS to the knob, so
  a +1 — or a +5 — CV changes the output by bit-exactly zero and a bipolar LFO is
  half-wave rectified. Found by sampling **AT** the declared value (the #1750
  lesson); a probe at ±0.1 either side of a mid knob sees nothing. Left OPEN as a
  family-level owner call (the same shape exists on `unityscalemathematik`).
* **ONE INPUT PATCHED MAKES IT A RECTIFIER PAIR.** With B unpatched, MIN keeps
  only the negative half of A and MAX only the positive half, and PRODUCT is
  bit-exactly silent. The behaviour a player meets FIRST, stated nowhere.

⚠ **AND THE RANK AXIS THIS ENTRY INHERITED FROM Q17 DOES NOT EXIST HERE.**
`illogic` ranked four identical dials by REACH. Applied to ALM that sweep reports
attA moving 5 jacks and attB 4 — and **swapping the two input amplitudes flips
the answer**, because MIN and MAX are SELECTORS and whichever channel is louder
owns them. Reach is a property of the STIMULUS on this module. Both readings are
a permanent leg. The axis that IS intrinsic is POLARITY: `diff = a′ − b′` is the
one antisymmetric law, so ATT A enters all five jacks with the sign the panel
implies and ATT B inverts one. *The general lesson:* **an axis that worked on the
sibling is a hypothesis, not an inheritance — and a selector-shaped output makes
"reach" stimulus-dependent by construction.**

**Instrument controls worth carrying to Q20+:**

* ⚠ **RELATIVE ERROR IS THE WRONG INSTRUMENT AT A NULL, and this module is full
  of nulls.** The model-vs-worklet leg went red at 1.3e8 relative on
  `a=−0.6 b=0.2 att=0.25/0.75`, where the summed pair is −0.15+0.15: float64 says
  2.8e-17, float32 says −3.7e-9, both are zero to any honest reading, and their
  RATIO is meaningless. The metric now SWITCHES on the expected magnitude, with
  the switch and its floor printed in the assertion message. §13 recorded
  "absolute is wrong, use relative"; the complete rule is **name the denominator
  AND state where it stops existing.**
* ⚠ **`tanh(x)` IS EXACTLY 1 IN FLOAT32 for large x**, so
  `expect(|out|).toBeLessThan(1)` fails on a correctly-saturating jack. The
  clipped/linear partition is asserted as `≤ 1` **plus** proportionality (linear
  jacks track a ×50 drive, clipped ones come nowhere near it) — the property, not
  a strict interior.
* ⚠ **An anti-phase stimulus puts SUM on its own null**, so a ratio taken against
  it is a NaN wearing a measurement. Use an ASYMMETRIC pair (0.4 / 0.2).
* ⚠ **`glyphBinding` SHORT-CIRCUITS ON THE DECLARED LITERAL** before it inspects
  a port, so a `glyph: 'none'` def returns `{kind:'none'}`, NOT `{kind:'static'}`
  — and a negative control that spreads the def and only adds an `audio` output
  still returns `{kind:'none'}`, i.e. it measures the literal it was trying to
  control for. Override the glyph in BOTH mutants.
* The `destroy` 1000 Hz trap is honoured (C4 everywhere a waveform is counted).

**VRT: PREDICTION vs ACTUAL.** Predicted exactly two new baselines
(`face-analogLogicMaths-compact.png`, `face-analogLogicMaths-dock.png`) and no
moves elsewhere. ⚠ The #1752 hazard fired again: the local `task vrt:one` WROTE
both PNGs as untracked macOS renders, which a second local run would have
reported as PASSING. Deleted; `git status --untracked-files=all` after every VRT
run is not optional.

### Q20 · `moog923` — noise + two filter taps (§9's deferral, RESOLVED)

**Merit: YES, on the `noise` argument verbatim.** 3 params (`level`, `lpCutoff`,
`hpCutoff`), 1 audio input, **4 audio outputs** (`white`, `pink`, `lp`, `hp`).

§9 deferred it with the right question — *"are the tap levels unprintable?"* —
and the def answers it: the two cutoffs are **0..1 dials with no `units`**, so
the corner frequency they set appears nowhere on the module, and `pink`'s level
relative to `white` is a property of the pinking filter that no LEVEL dial can
state. Three unprintable facts over four taps is precisely the count that
promoted `noise` (ONE param, three outputs).

⚠ **Which tap does the glyph resolve to?** Unlike Q15–Q19 this module DOES have
audio outputs, so a `meter` glyph BINDS — to `white`, because
`primaryAudioOutPortId` takes the FIRST `type === 'audio'` output. **That is the
`noise` finding verbatim** (#1692): the meter shows the tap the player is
probably not listening to. Say which, in the spec, and decide whether a readout
should print the other three levels.

⚠ Measure the 0..1 → Hz map off the WORKLET, never off the description.

⚠ `moog923` is in `NOT_TOKEN_PINNED_SCENES` (`vrt-cable-stripe.test.ts`) — the
whole `moog*` family renders no `.stripe`. Promotion does not change that (the
card still exists); do not "fix" the missing stripe while you are in there.

### Q21 · `moog905` — the spring reverb

**Merit: MARGINAL-YES, and it is LAST of the seven on the measurement.** 3 params
(`mix`, `decay`, `size`), 1 in, 1 out, **zero CV inputs** — so it has neither a
CV audit to run nor an output roster to derive readouts from. §9 deferred it on
*"a real derived quantity (the dispersion chirp) but only three dials"*, and the
audit narrows that considerably.

**MEASURED (this branch, the def's own factory in `node-web-audio-api`, a
1-sample impulse, `mix = 1`, tail = last sample above −60 dB of peak):**

| decay | size | tail |
|---|---|---|
| 0.6 | 0.5 | 0.270 s |
| 0.2 | 0.5 | 0.129 s |
| 0.9 | 0.5 | 0.708 s |
| 0.6 | 0.1 | 0.163 s |
| 0.6 | 0.9 | 0.377 s |

**SIZE is not orthogonal to DECAY.** At a FIXED `decay = 0.6`, moving SIZE across
its travel moves the tail **0.163 s → 0.377 s** — a 2.3× range — while the module
documents SIZE as *"spring length / dispersion — how much chirp and boing"* and
DECAY as *"tail length"*. So the one number a player actually wants (how long
does it ring) is a JOIN over two dials and neither can print it. That is a
legitimate derived readout, and it is the module's only one. Renders
bit-identically twice.

**Why it still ranks last:** three dials means `faceTierCap` gives mini 1 /
compact 2–3 / plate 6 — the plate and the dock render the identical three knobs,
so `pages`, band packing and the tier ladder have nothing to organise. One
readout over three dials is the thinnest case in the cohort. If it is built, it
is built for completeness of the effects rack, not because the face earns its two
VRT baselines.

## 13. `unityscalemathematik` — THE AUDIT, MEASURED

Run against the REAL shipped worklet (`packages/dsp/dist/unityscalemathematik.js`)
in `node-web-audio-api`, driven through the def's OWN factory — so the
publish-an-AudioParam seam that broke #1661/#1662 exists in the harness. SR
48 000, DC drivers, metric = the settled output sample in LINEAR amplitude. Every
number is reproduced on every run by
`art/scenarios/unityscalemathematik/cv-path.test.ts` and
`unityscalemathematik-face-model.test.ts`.

**M1 — ALL FIVE `paramTarget` INPUTS REACH THE AUDIO, on BOTH paths, and the two
paths AGREE TO THE PRINTED DIGIT.** The strong form: the CV terminal is not
merely alive, it is the SAME terminal the knob writes.

| input | param | base → target | KNOB Δ | CV Δ |
|---|---|---|---|---|
| `u_atten_cv` | `unityAtten` | 1 → −1 | 1.000000 | 1.000000 |
| `a_atten_cv` | `aAtten` | 1 → −1 | 1.000000 | 1.000000 |
| `a_curve_cv` | `aCurve` | 0 → 1 | 0.375000 | 0.375000 |
| `b_atten_cv` | `bAtten` | 1 → −1 | 1.000000 | 1.000000 |
| `b_curve_cv` | `bCurve` | 0 → 1 | 0.375000 | 0.375000 |

**M2 — THE TERMINAL PARTITION IS EXACTLY `{5 params, 3 ports}`, DERIVED off the
LIVE handle.** `u_atten_cv` / `a_atten_cv` / `a_curve_cv` / `b_atten_cv` /
`b_curve_cv` publish an AudioParam, so `AudioEngine.addEdge` takes the
`connect(din.param)` branch; `u_in` / `a_in` / `b_in` publish a raw node input and
are the named `PASSTHROUGH_BY_DESIGN` entries. A sweep that assumed one shape
would either throw or silently skip half the module.

**M3 — THE RESPONSE LAW, CONFIRMED AGAINST THE RENDER:**
`y = sign(x)·|x|^k·atten`, `k = 1 + 2·curve`, `k ∈ [1, 3]`.

| \|x\| | curve 0 (k=1) | curve 0.5 (k=2) | curve 1 (k=3) |
|---|---|---|---|
| 0.10 | 0.100000 | 0.010000 | 0.001000 |
| 0.25 | 0.250000 | 0.062500 | 0.015625 |
| 0.50 | 0.500000 | 0.250000 | 0.125000 |
| 0.90 | 0.900000 | 0.810000 | 0.729000 |
| **1.00** | **1.000000** | **1.000000** | **1.000000** |
| 1.50 | 1.500000 | 2.250000 | 3.375000 |
| 2.00 | 2.000000 | 4.000000 | **8.000000** |
| 3.00 | 3.000000 | 9.000000 | **27.000000** |

**M4 — DEFECT (doc, #1715): "leaving larger excursions intact" IS FALSE ABOVE
UNITY.** The def's `explanation` says the curve *"compresses small signals while
leaving larger excursions intact"* and its `aCurve`/`bCurve` control docs say
*"compressing small signals while preserving large ones"*. Measured: **`|x| = 1`
is a FIXED POINT and the only one.** Below it the curve attenuates as documented;
**above it the curve EXPANDS** — a ±2 source at CURVE 1 leaves at ±8 (a **×4
gain**) and a ±3 source at ±27 (**×9**). "Preserved" is true at exactly one input
magnitude and wrong everywhere above it. This is the #1701 class exactly: a false
VALUE inside prose, with every gate blind because the DECLARATION is correct.
Corrected in this PR, and the corrected sentence is what `unityscale-a-over`
prints as a LIVE number rather than as an assertion.

**M5 — SECTIONS A AND B ARE BIT-IDENTICAL CODE PATHS, AND THE THREE CHANNELS DO
NOT CROSS-TALK.** Driving `a_in` alone leaves `u_out` and `b_out` at exactly `0`.
That is what licenses `a`/`b` as CLUSTERS of one page rather than two pages.

**M6 — EVERY CONTROL IS ENABLER-GATED ON A CABLE, bit-exactly.** With nothing
patched into `a_in`, `aCurve = 1` and `aAtten = −1` together move the output by
exactly `0`. Not a defect — it is what a shaper IS — but it means the FACE cannot
say which cable is missing (a `FaceReadoutValue` sees only params), which is why
all four readouts are stated as a RESPONSE ("what a 0.5 in would become") and
never as a level.

**M7 — DEFECT (live, #1714): THE CARD DISAGREES WITH THE DEF ON ALL FIVE
LABELS.** The `min`/`max`/`defaultValue`/`curve` literals all AGREE (checked one
by one), so this is NOT the `wavetableVco` range defect — it is the *other* half
of the same class, and it is the half that becomes user-visible on promotion,
because **the dock renders the DEF's label**:

| param | def `label` | card paints |
|---|---|---|
| `unityAtten` | `Unity` | `Att` |
| `aAtten` | `A Att` | `Att` |
| `aCurve` | `A Crv` | `Curve` |
| `bAtten` | `B Att` | `Att` |
| `bCurve` | `B Crv` | `Curve` |

The card disambiguates the three `Att` cells with static section captions the def
cannot see. **All five were already sitting in `VOCABULARY_DEBT` — see M9.**
Fixed by binding the card to `paramSpec(def, id)` — one copy of every number,
curve, unit AND label — and enrolling it in `RANGE_BOUND_CARDS` +
`MAPPING_BOUND_CARDS`.
⚠ **That moves `e2e/vrt/__screenshots__/vrt.spec.ts/unityscalemathematik.png`**,
and a label change may land UNDER the diff budget, which is the
passing-but-stale trap: COUNT what the bot commits against the prediction, and
`git rm` + re-dispatch if the card PNG is not among them.

**M8 — THE RENDER IS REPRODUCIBLE.** Two independent renders of the same patch
are BIT-IDENTICAL across the whole buffer. Stated as a MEASUREMENT because #1680
found three modules where it was not: `node-web-audio-api` renders off-thread and
a `setInterval` pump keeps firing during a render, so any value written only from
one is racy. This module has no pump — it is a stateless per-sample function —
and the assertion is a permanent leg, so a future pump cannot be added quietly.

### What the audit did NOT find

No dead CV input, no dead knob, no unexposed DSP capability, no range
disagreement, no cross-talk between the three sections, and no defect in the
worklet's math — the pure `unityScaleMath` helper the readouts use agrees with
the rendered audio to **9.02e-8 RELATIVE** (~0.76 float32 ULP), which is
float32-vs-float64 `Math.pow` and nothing else. `unityscalemathematik` is a
correct module with one false documentation claim and one card/def label
divergence.

⚠ **AND THAT NUMBER'S UNIT IS A LESSON, not a footnote.** The first draft of
that leg asserted an ABSOLUTE budget of 1e-7 and went RED at 1.81e-7 — on a
result of magnitude 2.004, i.e. 9.0e-8 relative, i.e. the harness working
perfectly. An absolute budget over a quantity that spans 0 to 8 across the
dials' travel is **a different assertion at every probe magnitude**; a relative
one is the same assertion everywhere. The assertion message now names the unit
(`RELATIVE error (dimensionless; budget 1e-6)`), which is the half of CLAUDE.md's
"state the units" rule that would have caught it before the run.

**M9 — THE DIVERGENCE WAS ALREADY LEDGERED, WHICH CHANGES WHAT M7 IS.** All five
labels sat in `VOCABULARY_DEBT` (`card-def-debt.ts`, generated 2026-08-02), so
this was not an undiscovered defect — it was a KNOWN one, deferred, in a ledger
whose whole purpose is to keep a known answer around. §10.7's advice paid off
exactly as written: *"before authoring a face, grep the debt/exemption lists for
the module you are about to touch — you may already be holding the release
condition."* A face PR IS that condition here, because promotion is what turns a
latent divergence into a live rename. The entry is DELETED rather than re-worded
(CLAUDE.md: when debt is paid, delete the mechanism and leave no replacement
counter); what guards it now is the unconditional `unledgered(...) === []`
clause of `card-def-agreement.test.ts` with five fewer exemptions, plus
`RANGE_BOUND_CARDS` + `MAPPING_BOUND_CARDS`, which is strictly stronger — there
is no second copy of a name left to disagree.

## 14. VERDICTS RECORDED — additions to §4 and §9

| module | params | verdict |
|---|---|---|
| `analogLogicMaths` | 2 | **§9's "NO FACE ON MERIT" is WITHDRAWN → Q19.** The rejection sentence is the `ninelives` argument with the sign flipped, and the `tanh` on SUM/PRODUCT is a real derived readout (§11.1). |
| `moog923` | 3 | **§9's deferral is RESOLVED → Q20.** Three unprintable facts over four taps = the `noise` bar. |
| `moog905` | 3 | MARGINAL-YES **confirmed with a measurement** (Q21): SIZE moves the tail 2.3× at a fixed DECAY, so there IS one derived readout. Ranked last of seven. |
| `moogCp3` | 5 | NOT a merit rejection — a member of the System-55 BANK batch (§9), and its face must share that batch's layout. Its 7 outputs put it high in the OUTPUT ordering; do not pull it out of the bank on that alone. |
| `fourplexer` · `moog992` · `moog993` · `moog995` · `cvBuddy` · `cvBuddyMini` | 2–4 | §9's rejections STAND, re-checked against the output ordering. `cvBuddy`'s interesting quantities are `node.data`, which `FaceReadoutValue` cannot reach at all — a rejection no re-ordering can overturn. |

## 15. WHAT COHORT 3 ADDS TO §5 AND §10

9. **A GLYPH IS NOT A DEFAULT — RESOLVE IT.** Four of the seven entries in this
   cohort have NO `type: 'audio'` output, so every glyph but `'none'` resolves to
   `{kind:'static'}` and paints a live-looking readout of nothing. That used to
   be invisible (marbles shipped it through three passes, #1692); it is now an
   UNCONDITIONAL clause of `module-face-lint` with no exemption list and no
   count. Establish what the glyph RESOLVES TO before writing it — and for a
   module that DOES have audio outputs, say WHICH one, because
   `primaryAudioOutPortId` takes the first.

10. **A "NO-OP" INSTRUMENT READING IS FIRST AN INSTRUMENT BUG.** `destroy`'s
    audit returned "decimation does nothing" and "bit reduction does nothing"
    from two INDEPENDENT metrics, and both were wrong — a **−90 dB** dry residual
    (`si.smoo` never closes `1 − wet`) broke bit-equality without moving the
    signal. Any census over a Faust module's output that compares samples for
    EQUALITY is measuring the smoother, not the DSP. Use a tolerance, and print
    the tolerance in the assertion message.

11. **RENDER EVERY BASELINE TWICE AND ASSERT BIT-IDENTITY** before trusting a
    number from it (#1680). It costs two lines and it is the only cheap defence
    against an off-thread render racing a pump.

12. **THE LABEL IS HALF THE CARD/DEF CONTRACT, and it is the half that becomes
    user-visible on promotion.** `wavetableVco` (#1681) was a RANGE divergence;
    `unityscalemathematik` (#1714) is a LABEL divergence on all five params with
    every range agreeing. `card-def-agreement.ts` compares the numbers. **The
    dock renders the DEF's label**, so a face PR that does not bind labels ships
    a rename nobody reviewed.

13. **A dB FIGURE WITH AN UNSTATED REFERENCE IS NOT A MEASUREMENT.** §11.1's
    first draft quoted `analogLogicMaths`' `tanh` compression as `−0.318 dB` and
    `−6.02 dB` — the first against UNITY, the second against nothing consistent,
    and the two read as one trend. Against the un-clipped sum, which is the only
    reference that makes the rows comparable, they are **−6.34 dB** and
    **−12.05 dB**. The same failure has three faces in this cohort alone: this
    one, the ABSOLUTE-vs-RELATIVE budget in §13's model-vs-worklet leg, and
    `destroy`'s equality-vs-tolerance census in §15.10. **Name the denominator
    and the unit IN the number**, in a spec exactly as in an assertion message.

14. **A SPEC'S ARITHMETIC IS A HYPOTHESIS UNTIL IT IS RENDERED.** Q15's numbers
    came off the shipped worklet; Q19's and Q21's partly did not, and Q19's were
    wrong. Mark which is which — an unmarked derived figure is indistinguishable
    from a measured one, and the builder inherits it as fact.

---

## 16. THE DOMAIN THE POOL NEVER LOOKED AT — VIDEO (owner redirect, 2026-08-15) · #1726

**§11's join filtered on `domain === 'audio'`, and §6's did before it.** So did
§1's. Three cohorts, one filter, never restated as a decision — which is the
same failure mode as ranking by param count alone, one level up: **a filter
applied before the check quietly redefines the check's subject** (`blind-gates`,
and CLAUDE.md's four-green-and-blind gates verbatim).

Re-run WITHOUT the domain filter, same three sources:

```sh
# generic-face ∩ ¬STRICT_FACES, SPLIT by domain rather than filtered to one
```

| | audio | video | meta |
|---|---|---|---|
| registered modules | 120 | **68** | 8 |
| `generic-face` disposition | 93 | **47** | 0 |
| **PROMOTED (`STRICT_FACES`)** | **all of them** | **ZERO** | — |
| remaining pool | 51 | **47** | 0 |

**Every promoted face is `audio`. Not one video module is faced**, while video
is a third of the `generic-face` population. State it as a relation, not a
pair of counts: `STRICT_FACES ∩ {video defs} = ∅`, and it has been ∅ since the
programme began.

### 16.1 WHY, and both stated reasons are now STALE

§1 wrote the exclusion down, which is the only reason it is recoverable:

> *"Video defs are excluded on purpose: no video def carries a face, the doc
> `[id]` renderer for them does not exist, and `module-faceplates.md` scopes
> them out."*

- **"no video def carries a face"** is CIRCULAR — it is the skew, offered as its
  own justification. This is exactly the shape §10.6 retired for `ninelives`
  and §11.1 retired for `analogLogicMaths`, and it survived twice as long
  because it was phrased as a scope note rather than a verdict.
- **"the doc `[id]` renderer does not exist"** was true and IS NO LONGER.
  `module-manifest.ts:53` declares `VIDEO_SOURCES` and `buildModuleManifest`
  takes it as a second parameter (`:1306`), so the manifest carries video defs;
  `routes/docs/modules/[id]/+page.server.ts`'s `entries()` enumerates
  `buildModuleManifest().modules` and its `load` finds any of them. **Video
  modules have doc pages today**, and `backdraft` is already in `STRICT_DOCS`.
- `module-faceplates.md`'s "What this skill does NOT cover · VIDEO MODULES"
  cites both of the above and is therefore stale in both halves. It needs the
  correction folded in with the first video face.

### 16.2 AND THE PLATFORM WAS READY — the finding that costs a spec its main worry

The obvious fear is that a faceplate has nothing to say about a picture. It is
already answered in the shell, and it was answered deliberately:

```ts
// ModuleShell.svelte:216-221
// VIDEO-domain module → the glyph slot shows a LIVE THUMBNAIL of its actual
// output (the legacy preview seam via VideoTileThumb), never a static trace:
// a migrated video face gets the same live picture the placeholder tiles do.
let videoThumb = $derived(hasVideoSurface(def));
let hasGlyph = $derived(glyphKind !== 'none' || videoThumb);
```

`hasVideoSurface(def)` is `def.domain === 'video'` (`module-shell-model.ts:177`),
and the thumb is a 160×120 aspect-fit blit at 15 fps, IntersectionObserver-gated
(`VIDEO_THUMB_*`). So a video face gets its module's real output in the glyph
slot for free.

⚠ **AND THE DECLARATION THAT GOES WITH IT IS COUNTER-INTUITIVE, so it must be
asserted rather than commented.** A video def must declare **`glyph: 'none'`** —
not because it has no picture, but because `primaryAudioOutPortId` matches
`type === 'audio'` and a video def has none, so ANY other glyph resolves to
`{kind:'static'}` and reddens `module-face-lint`'s dead-glyph clause. The live
picture arrives through `hasGlyph`'s **OR**, from a different seam entirely.
`'none' + a blank tile` and `'none' + a live video thumb` are indistinguishable
from the declaration alone: **assert `hasVideoSurface` is what paints it.**

### 16.3 THE VIDEO POOL, by param count

| type | par | disc | in | out | cvT | notes |
|---|---|---|---|---|---|---|
| `backdraft` | **37** | 3 | 33 | 1 | **29** | **Q22 — owner pick, IMPLEMENTED, REVIEW-HOLD** |
| `colourofmagic` | 37 | 22 | 31 | 22 | 15 | five colorspace blocks + 22 taps; already noted in §1's inventory as needing page splitting |
| `spirographs` | 31 | 4 | 31 | 3 | 31 | every param CV-able, 1:1 |
| `b3ntb0x` | 22 | 0 | 19 | 1 | 18 | |
| `quadralogical` | 21 | 4 | 19 | 2 | 15 | |
| `grainsOfVision` | 20 | 1 | 19 | 2 | 17 | granular video; three chained blocks = natural pages |
| `bentbox` | 16 | 0 | 15 | 1 | 14 | |
| `vfpgaRunner` | 16 | 0 | 12 | 2 | 8 | ⚠ THE VFPGA HOST — see the correction below |
| `mandelbulb` | 13 | 4 | 10 | 2 | 10 | |
| `ruttetra` | 12 | 0 | 8 | 1 | 7 | |
| `warrensvisions` | 12 | 4 | 9 | 1 | 8 | already `RANGE_BOUND` + `MAPPING_BOUND` |
| `mirrorpool` | 11 | 0 | 13 | 1 | 11 | |

**`backdraft` is the fourth-largest `generic-face` candidate in the WHOLE fleet**
— behind only `mixmstrs` (91, stopped by #1662), `wavesculpt` (79, owner manual
review) and `colourofmagic` (37, tied on params but with 22 outputs and 22
discrete switches). It is the largest that is neither blocked nor already
carved out, in either domain.

⚠ **A CORRECTION TO THE BRIEF THAT SENT ME HERE, recorded because it is the
§5.2 rule applying to a task description rather than to a spec.** The redirect
described `backdraft` as *"a VFPGA host … 4 video in, 4 CV in, 4 gate in, 2
video out, an 8-slot generic param bank `p1..p8` … a loaded `VfpgaSpec`
(`node.data.vfpga`) selects which subset is ACTIVE"*, and framed the central
design problem as **a dynamic control set**. Read off `contract-lock.txt` and
the def itself, that describes **`vfpgaRunner`** (16 params, 12 in = `cv×4 +
gate×4 + video×4`, **2** video out) — not `backdraft` (37 params, 33 in =
`cv×29 + video×4`, **1** video out, no `node.data` spec at all).

The line counts in the redirect were right (`backdraft.ts` is 3688,
`BackdraftCard.svelte` is 1290), which is exactly why the description read as
authoritative. **Verify an I/O description against `contract-lock.txt` before
designing against it**; the two modules' design problems have nothing in common.
The real one is in §17.

---

## 17. Q22 · `backdraft` — the first VIDEO face, and it is NOT a face-sized job

**Issues filed from this audit: #1725** (six dead gate inputs), **#1723** (the
engine→store reflect dies with the card), **#1722** (docs describe a removed
display; `tvMode` mode 1 has two names), **#1726** (the video-face platform gap).

**Merit (STOP 1): YES, emphatically.** 37 params, 33 inputs (29 `paramTarget`
CV + 4 `video`), 1 `video` out — the fourth-largest `generic-face` candidate in
the fleet and the largest that is neither blocked nor carved out. Two `<XyPad>`
mounts, three discrete switch banks, six edge-detected gate inputs, a derived TV
readout, and an owner who says he uses it a lot. Nothing about merit is in
doubt.

**STOP 2: FAILS TODAY.** And the failure is not a judgement call — it is
gate-enforced, so it is worth stating exactly.

### 17.1 THE BLOCKER: promotion deletes the ONLY entry point to the output

`BackdraftCard.svelte` no longer carries a picture at all (the 320×240 display
was removed to buy 6hp→4hp and a taller fader; card header, lines 4/16-24). What
it carries instead is the **`⛶ OUTPUT` button** (`:696-703`,
`backdraft-output-menu`) → `VideoCanvasContextMenu` (`:914-929`) → **Full Frame /
Full Screen / Present / Present All / Stop Present**, over a 0×0
always-mounted `<canvas>` (`:896-911`) that `requestFullscreen()` and the Present
popup both blit from.

**That button is the whole feature**, and its own e2e says so:
`backdraft-full-output.spec.ts:277` — *"there is no in-rack picture to
right-click — the node menu answers instead"* — and pins that the node menu
offers **Docs / Duplicate / Delete only**. So:

- today, un-docked in the default shell, backdraft renders a
  `ModuleShellPlaceholder` (`laneRenderKind`: `!migrated ⇒ 'placeholder'`), and
  the card is reachable **only through the dock** (or `?shell=legacy`);
- `DockFullView` swaps the card for `<ModuleShell>` on `migrated()` alone;
- so **promotion removes the last surface that can open Full Frame, Full Screen
  or Present.**

There is no cell to build it from. `ParamCellKind` is
`knob | momentary | toggle | segmented | selector | grid | color | fader | xy`
(`shell-control-kind.ts:32-41`) — none of them mounts a canvas, and a `custom`
sidebar panel is explicitly read-only (*"A panel READS; it does not own state"*,
`sidebar-panels.ts:22-23`).

**The only honest path is `face.extension` with the `fullViewBody` slot — and
that slot HAS NO RENDER SITE.** `WIRED_SHELL_EXTENSION_SLOTS = ['glyph']`
(`shell-extensions.ts:87`), and the interface note names the price:

> *"`editorSurface` / `fullViewBody` are the DECLARED contract for the LEG-05
> bespoke-surface cohort; the first adopter wires the render site in ModuleShell
> and moves the slot to the wired list IN THE SAME DIFF — shell-extensions.test.ts
> refuses an extension exporting an unwired slot, so a slot can never silently
> no-op."*

**So the first video faceplate is definitionally the first `fullViewBody`
adopter.** That is a platform PR — the seam the bespoke-surface cohort
(clipplayer, controlSurface, electraControl, launchpadControl, videoOut,
cameraInput) plugs into — not a face wave. Sized honestly it is: wire the
`{#if ext?.fullViewBody}` render site in `ModuleShell`, move the slot to the
wired list, author `$lib/ui/modules/backdraft/shell-extension.ts` carrying the
output surface + button + menu, and prove the whole
`backdraft-full-output.spec.ts` suite still passes against the FACE rather than
the card.

**Recommended split, mirroring Q2's:** land the platform slot + the output
surface FIRST, as its own reviewed PR with its own e2e; then the face on top of
it. Authoring the face first produces a module whose output cannot be opened.

### 17.2 THE SECOND STOP-2 ITEM IS ALREADY BROKEN — and that is the finding

`syncFromEngine` (`BackdraftCard.svelte:490-520`) is a per-rAF **engine→store
reflect** for five params the ENGINE flips by itself on a rising gate edge:
`mirrorX`, `mirrorY`, `pureGeo` (`:499`), `tvMode` (`:508`), `shape` (`:517`) —
each a `// guard:allow-raw-write`, deliberately outside undo.

The obvious reading is "promotion kills it". **It is already dead for most
users**: the card only mounts in the dock, so for anyone who has not docked the
module, a `mirror_x_gate` / `shape_gate` / `tv_gate` edge flips the picture and
**never reaches the store** — it does not persist, it does not sync to
collaborators, and the button's lit state is stale the moment you open the dock.

That is the **card-unmount-kills-node-resources class** (#1531/#1574/#1583) and
its documented fix applies unchanged: **a NODE-keyed registry, not a card**.
Filed separately; a face PR neither causes nor cures it, and the fix is the same
work either way.

### 17.3 THREE DISCRETE PARAMS CARRY NO `options[]` — so a def-driven face renders them as KNOBS

| param | states | where the names live | what a face renders today |
|---|---|---|---|
| `shape` | 5 — SQUARE / CIRCLE / PENTAGON / TRIANGLE / OCTAGON | `BACKDRAFT_SHAPES` (`backdraft.ts:294`) | a `0..4` **knob** |
| `flicker` | 6 — OFF / 6 / 24 / 50 / 60 / 120 Hz | `BACKDRAFT_FLICKER_OPTIONS` (`:306`) | a `0..5` **knob** |
| `tvMode` | 3 — OFF / (see 17.4) / CRITICAL | `BACKDRAFT_TV_MODE_LABELS` (`:453`) | a `0..2` **knob** |

`ParamDef.options` exists and has precedent in BOTH domains (`cloudseed`,
`tidyVco`, `filter`, `warrensspectrum`, and the video `warrensvisions`), and
declaring it turns each into a `segmented`/`selector` cell. **⚠ But `params` is
in the CONTRACT and, for a VIDEO def, in the WebGL ATTEST BASIS** — unlike
`face`/`docs`/`controlFamilies`, which the attest normalizer strips. So this fix
costs `docs:accept` **and a real-GPU re-attest**, which is an owner-machine step.
Price it before promising it.

### 17.4 DEFECTS FOUND, filed rather than folded in

1. **`tvMode` mode 1 has TWO NAMES, on the same button.** The button prints
   `TV: VIRTUAL CAMERA` (from `BACKDRAFT_TV_MODE_LABELS`) while the button's own
   `title` tooltip and the def's `docs` (`:3127`, `:3196`) both call it
   `PURE TV`. One state, two names, one control.
2. **`docs.explanation` describes a card that no longer exists.** It still says
   *"The card carries a small 320×240 DISPLAY centred in a band across the top…
   The discrete switches flank the display… over a **single row** of labelled
   fader banks"*. The display was REMOVED, the card is now two rows, and the
   explanation never mentions the VIRTUAL CAMERA bank at all. This is the #1701
   class again — a false VALUE in prose, with every gate blind because the
   declaration is correct — and it is the module's `STRICT_DOCS` text, i.e. the
   thing right-click → annotate shows a player.
3. **The engine→store reflect is dead un-docked** (§17.2).

### 17.5 WHAT THE AUDIT FOUND CLEAN — and one of them retires a CLAUDE.md example

- **NO live range divergence, anywhere.** Every Fader range is DERIVED
  (`pmin()/pmax()/pdef()` read `backdraftDef.params.find(...)` and THROW if
  absent), so a card/def range disagreement is structurally unrepresentable here.
- ⚠ **CLAUDE.md's ±0.2-vs-±1 case study IS this module, and it is FIXED.**
  `card-control-ranges.test.ts:6-11` names it verbatim: *"BACKDRAFT's two camera
  joysticks were authored with literal `xMin={-1} xMax={1}` while the def
  constrained those params to ±0.2 (tilt) and ±0.5 (position)."* Both pads now
  pass `xMin={-BACKDRAFT_CAM_TILT_RANGE}` / `{-BACKDRAFT_CAM_POS_RANGE}` — **the
  same exported symbols the def itself uses** — and a SOURCE-level regex gate
  rejects any numeric literal on those props. The card carries the incident in a
  comment, and a second comment records #1223 trying to re-introduce literals in
  the `camDist` Fader and the gate catching it. **The rule in CLAUDE.md should
  keep the case study and stop implying it is live.**
- **The two pads are `face.xyPads` verbatim**: pad A = `camTiltX`/`camTiltY`,
  pad B = `camPosX`/`camPosY`, all four continuous and bipolar, so all four
  satisfy the lint (declared, ranked, non-momentary, continuous, claimed once).
  The inventory note (`face-migration-inventory.ts:185`) called this correctly,
  and the `wavesculpt` entry records what happens if it is ignored.

### 17.6 SEVEN PARAMS HAVE NO USER CONTROL — AND COMPLETENESS HAS NO EXEMPTION

`delayClock`, `mirrorXGate`, `mirrorYGate`, `shapeGate`, `pureGeoGate`, `tvGate`
(synthetic gate params the CV bridges write, edge-detected by the module) and
`freeze` (a VRT/determinism hook). Every one carries a `docs.controls` entry
saying "No card knob" / "No card control".

**There is no way to exclude them, and it was checked rather than assumed.**
`module-face-lint.test.ts:301-331` loops `for (const p of def.params ?? [])`
with **no filter, no skip-list, no predicate and no per-instance escape**, and
`ModuleFace` (`graph/types.ts:584-741`) has no `hidden`/`exclude` field —
its whole surface is `order`, `pages`, `glyph`, `glyphDepthGain`, `extension`,
`paramCells`, `xyPads`, `momentary`, `rear`, `title`, `hint`, `hero`, `sidebar`.
`ModuleFaceRear` curates PORTS, not params, so it is not a parking lot either.

And ranking them is not enough: a **second** gate, dock render-plan parity
(`:334-413`), requires every `ParamDef.id` to render **exactly one interactive
cell** in the dock full-view — written for the tidyVco control-loss lesson,
*"a control can be ranked in `face.order` yet still never REACH the user"*.

⚠ **There is NO PRECEDENT to lean on.** No module in `STRICT_FACES` has a param
without a user control. Every module that does — `grainsOfVision` (`freeze`,
explicitly *"like BACKDRAFT"*), `gibribbon`, `tvLibrarian`, `vfpgaRunner` — is
an UNFACED VIDEO module. backdraft would be the first, and the honest reading is
that **`ModuleFace` needs a way to say "this param has no user control"** before
any of them can be faced. That is a platform question, not a backdraft one.

⚠ **AND THE SHAPE IS WRONG TOO.** All seven declare `curve: 'linear', min: 0,
max: 1`, and `looksLikeToggle` is `curve === 'discrete' && min === 0 && max === 1`
(`group-controls.ts:46-48`) — so they escape the momentary/latching
classification entirely and would render as **continuous 0..1 rotaries over raw
gate swings**. The same is true of `mirrorX`, `mirrorY` and `pureGeo`, which ARE
user toggles: this is the cloudseed precedent verbatim
(`module-face-lint.test.ts:432-436` — *"they only became visible to this gate
when their `curve` was corrected `linear` → `discrete`; before that the shell
painted them as continuous rotaries"*). Correcting those curves is a **`params`
edit**, which §17.8 prices.

### 17.7 THE SIX GATE INPUTS ARE ALREADY A NAMED, LEDGERED, LIVE DEFECT

The coordinator's brief flagged the #1703 "consumer silently dropping input"
class. It is not a risk here — **it is already documented as shipped and broken,
on all six ports**, and the ledger is `trigger-edge-placement.test.ts:431-438`:

```ts
const KNOWN_REMAINING: readonly string[] = [
  // BACKDRAFT — 6 raw-passthrough clock/gate ports, all edge-read in draw().
  'backdraft.delayClock', 'backdraft.mirrorXGate', 'backdraft.mirrorYGate',
  'backdraft.shapeGate',  'backdraft.pureGeoGate', 'backdraft.tvGate',
```

The mechanism, from that file's own header (`:23-41`): a rising edge on a
raw-passthrough input **must** be detected in `setParam`, on the bridge's clock.
`PatchEngine.installGateDispatch` replays each edge on the ~25 ms scheduler tick
as `setParam(0); setParam(1); setParam(currentLevel)` **in the same
millisecond**, so by the time `draw()` runs the param is back to 0 and the
detector sees `0 → 0 → 0`. In the file's words: *"The consumer is not 'flaky' —
it is DEAD, deterministically, for every patched trigger. A HELD gate still
works, which is why they have gone unnoticed."*

backdraft detects all six in `draw()` (`backdraft.ts:3373-3402`) using
`detectEdge` from `$lib/doom/cv-gate-edge` (rise > 0.6 / fall < 0.4 hysteresis).
The PRIMITIVE is sanctioned; the PLACEMENT is the defect. The ledger's own note
says why it was left: *"each needs its own behavioural verification, and
BACKDRAFT is a look-affecting module under the WebGL attest
(owner-preview-before-merge)."*

**So MIRROR X/Y, SHAPE, PURE GEO, TV and DELAY CLK do nothing from a clock
today.** A faceplate that ranks them is a prettier broken module — audit before
the face, exactly as §5.1 says.

### 17.8 THE ATTEST PRICE, MEASURED — the one piece of GOOD news

| edit to `backdraft.ts` | WebGL attest hash moves? |
|---|---|
| add ONLY a top-level `face: {...}` | **NO** |
| also edit its `docs` strings | **NO** |
| add `options[]` to a param, or correct a `curve` | **YES** |

`packages/web/src/lib/video/modules/**` IS in the WebGL basis
(`webgl-attest-lib.ts:237-239` walks the whole `lib/video` tree, `.test.ts`
excluded). But `HASH_TRANSPARENT_PROPS = ['docs', 'controlFamilies', 'face']`
(`attest-code-basis.ts:93`) and the normalizer strips them from any MODULE-SCOPE
def object before hashing (`:215-231`), with a permanent negative control that a
**nested** `face:` is kept. `module-registry.ts:29-38` already states the
conclusion for exactly this case.

**So the face itself is free.** Everything §17.3 and §17.6 say is needed to make
it render correctly — `options[]`, the `curve` corrections — is not, and a
real-GPU re-attest is an owner-machine step CI cannot perform.

### 17.9 THE VERDICT

**NOT A FACE. It is the first `fullViewBody` adopter, and four platform PRs
stand between here and a faceplate.** Stated as work, in dependency order:

1. **Fix the six gate placements** (§17.7) — each with its own behavioural
   verification. Blocks any face, because the face would rank six dead controls.
2. **Give `ModuleFace` a way to express "no user control"** (§17.6) — or accept
   seven meaningless cells. Blocks every video face, not just this one.
3. **Wire the `fullViewBody` slot + author backdraft's shell extension**
   (§17.1) — the output surface, the OUTPUT button and its menu, plus a
   node-keyed home for the engine→store reflect (§17.2). Without it, promotion
   deletes the only way to open Full Frame / Full Screen / Present.
4. **`options[]` + `curve` corrections** (§17.3, §17.6) — costs a `docs:accept`
   AND an owner-machine re-attest (§17.8).

Then, and only then, the face — which by comparison is the easy part: 37 ranked
params, two `face.xyPads` that the card already proves out, ~7 bands (over
`DOCK_TAB_MIN_BANDS`, so a tab rail), `glyph: 'none'` with the live thumb coming
from `hasVideoSurface`, and a derived TV readout that is genuinely a
`FaceReadoutValue` (`backdraftTvFill`/`Depth` are pure functions of params).

**And backdraft is `EXEMPT_FROM_VRT` + `ALLOWED_PERMANENT_EXEMPT` today**
(`vrt-exemptions.ts:971`, `:1035`) — *"What still blocks promotion is purely
mechanical: no baseline PNGs"* — while a scene is already registered
(`vrt-scenes.ts:535-570`, `afterSpawn` writes `freeze` after settle). So the
face wave also owes it three baselines, not two.

⚠ **This is a STOP-2 REFUSAL, which the skill names as a legitimate, expected
outcome** — *"If a hit is load-bearing and has no shell representation you can
build, do not promote."* Every clause above is gate-enforced or ledgered, not a
judgement call: `shell-extensions.ts:87`, `module-face-lint.test.ts:301`,
`trigger-edge-placement.test.ts:431`, `webgl-attest-lib.ts:237`,
`vrt-exemptions.ts:971`. Authoring the face first produces a module that ranks
six dead controls and cannot open its own output.

### 17.7 AND THE CV AUDIT IS THE WIDEST BLIND SPOT IN THE FLEET

**29 `paramTarget` CV inputs, and nothing in the repo proves ANY of them reaches
the picture.** `per-module-per-port-behavioral.spec.ts:474` exempts backdraft
**whole-module**, in its own words:

> *"the HDR feedback-trail `out` has a per-frame luma-variance baseline of ~7700
> with a HUGE ±4000-6000 per-frame RANGE driven by the ACIDWARP context motion +
> trail accumulation… Δμvar runs 37→1750 and ΔRvar runs 2.7→4060 with NO
> correlation to which port is driven, so the variance metric can't attribute a
> delta to ANY input (the 22 ports all 'passed' once but only on the animation's
> own noise)."*

`contract-lock` and `module-docs-lint` read the declaration; `cv-scale-registry`
never renders. So the module with the most CV inputs in the fleet has the least
CV coverage — and #1664 already found a live CV defect in `rasterize`, a sibling
video module, in exactly this gap.

⚠ **The exemption's own reasoning names the instrument fix.** It failed because
it drove a MOVING source (acidwarp) through a per-frame VARIANCE metric with
three snapshots. The module is deterministic given a fixed source and a fixed
frame count (`flicker` and the TV noise are both pure functions of the frame
index `n`), so the instrument that works is: **a STATIC source, a fixed frame
count reached with `waitFrames`, and a same-frame-index pixel comparison** —
never a wall-clock wait and never a variance floor. That is a different
assertion, not a tuned one, and it is the audit's deliverable whatever happens
to the face.

---

## 18. Q16 · `featurecv` — THE AUDIT, MEASURED, and four spec corrections

Run against the REAL shipped worklet (`packages/dsp/dist/featurecv.js`) in
`node-web-audio-api`, driven through the def's OWN factory, so the GainNode-trim
and k-rate-param seams the offline core does not have are in the harness.
SR 48 000. Two metrics, different in kind: the SETTLED SAMPLE in LINEAR amplitude
for the three continuous CVs, and a RISING-EDGE COUNT across `GATE_HI` for
`onset`. Every number is reproduced on every run by
`art/scenarios/featurecv/analysis.test.ts` (9 legs),
`packages/web/src/lib/ui/modules/featurecv-face-model.test.ts` (30) and
`packages/dsp/src/featurecv-snapshot.test.ts` (6).

**M1 — WITH NOTHING PATCHED, ALL THREE FEATURE CVs SIT AT THE POLARITY FLOOR.**
`loud`/`bright`/`punch` = **−1.00** at the shipped BIPOLAR default, **0.00** at
UNIPOLAR, and `onset` emits zero edges in both. This is a property of the module
as it appears in a rack, not of a contrived patch: the muted keep-alive makes the
worklet process from spawn, the targets are 0 on silence, and `applyBipolar` maps
0 to −1. **An idle featurecv holds three destinations at the BOTTOM of their
range while POLARITY prints `BI`.** Nothing on the module said so.

**M2 — POLARITY IS THE ONLY CONTROL THAT MOVES AN IDLE JACK, BIT-EXACTLY.**
Driven to the far end of its travel against an unpatched module:

| control | → | Δ on each of the three CV jacks |
|---|---|---|
| `gain` | 4 | `0.0000e+0` |
| `attack` | 500 | `0.0000e+0` |
| `release` | 2000 | `0.0000e+0` |
| `onset_sens` | 1 | `0.0000e+0` |
| `onset_debounce` | 1000 | `0.0000e+0` |
| **`bipolar`** | **0** | **1.0000 (a full rail)** |

That table IS the rank-1 argument. Every other control acts on a measurement of
a signal that is not there, so ranking any of them first would put a
conditionally-inert control at the top of the ladder.

**M3 — LOUD CLIPS, AND THE CEILING IS A DIAL NOBODY READS AS ONE.**
`clamp01(LOUD_MAKEUP · rms · gain)` with `LOUD_MAKEUP = 2`, measured against DC
drivers so `rms ≡ amplitude`:

| input rms | gain | LOUD (unipolar) |
|---|---|---|
| 0.10 | 1 | 0.2000 |
| 0.25 | 1 | 0.5000 |
| **0.50** | 1 | **1.0000 — pinned** |
| 0.80 | 1 | 1.0000 |
| 0.25 | 4 | 1.0000 |
| 0.25 | 0.25 | 0.1250 |

So at unity trim **every source above −6.02 dBFS RMS reads a flat full scale**,
and GAIN divides that threshold 6.02 dB per doubling. A 0.8-amplitude sine
(rms 0.5668) is already past it. The faceplate prints the live figure as
`loud clip`, and `never` below GAIN 0.5 where the clamp needs an RMS above full
scale.

**M4 — GAIN REACHES EXACTLY ONE OF THE THREE FEATURES, BIT-EXACTLY.** At
gain 0.25 / 0.5 / 2 / 4 against a fixed white-noise drive, `bright` and `punch`
move by `0.0000e+0` — ZCR counts sign changes and crest is a peak-to-RMS ratio,
so both are scale-invariant through a GainNode as well as in the algebra. The
positive control on the same drive: LOUD moves 0.117 → 0.468 over the same trim.
**The shipped docs said the trim lets "its features reach a usable CV range".**
Corrected: it reaches ONE of them.

**M5 — DEFECT (doc, #1745): THE CREST MAP IS CALIBRATED ON A DISTRIBUTION THIS
RACK DOES NOT PRODUCE.** `featurecv-dsp.ts` said *"white noise (~3.5) → ~0.5"*.
`noise`'s white tap is UNIFORM in [−1,+1], crest **√3 ≈ 1.73 regardless of
window length**. Measured over featurecv's own 1024-sample window on the shipping
generator, and confirmed at the jack:

| tap | rms | zcr | crest | LOUD | BRIGHT | PUNCH (uni / bi) |
|---|---|---|---|---|---|---|
| white | 0.5784 | 0.4858 | **1.7265** | 1.000 | 0.972 | **0.146 / −0.709** |
| pink | 0.1061 | 0.2063 | 3.1926 | 0.212 | 0.413 | 0.438 / −0.123 |
| brown | 0.1905 | 0.0538 | 3.1876 | 0.381 | 0.108 | 0.438 / −0.125 |

The canonical NOISE → FEATURECV patch lands PUNCH at a third of the promised
level, at the bottom of the rail — **and the implied ordering is backwards**,
since pink and brown are the peakier taps here. `3.5` is a GAUSSIAN figure.
⚠ The MAP is not changed: whether `CREST_MAX = 6` suits this rack's material is a
SOUND question and belongs to the owner.

**M6 — THE ONSET JACK IS CLEAN, and the ceiling is exactly the readout.** The
#1703 / #1725 census, hits at 2 ms decay so the material is never the constraint:

| debounce | 12 Hz | 16 Hz | 20 Hz |
|---|---|---|---|
| 80 ms (shipped, ceiling 12.5 Hz) | **36/36** | 24/48 | 30/60 |
| 40 ms (ceiling 25 Hz) | 36/36 | **48/48** | 60/60 |

100 % below the lockout, exactly half above it, and the boundary MOVES with the
dial. `1000/debounce` is therefore an honest readout rather than a bound nobody
reaches.

⚠ **THE HIT WIDTH IS PART OF THE INSTRUMENT.** With the 10 ms decay the other
legs use, a 20 Hz train's tails OVERLAP, the slow envelope never falls, the flux
never re-rises, and the census collapses to **ONE pulse at every debounce
setting** — a result about the MATERIAL wearing the shape of a result about the
DIAL. The first draft of this leg went red for exactly that reason.

⚠ **AND SO IS THE LEAD-IN.** The factory pushes its k-rate params with
`setValueAtTime(v, ctx.currentTime)`, and in an OfflineAudioContext the FIRST
render quantum still reads the descriptor DEFAULT — so a hit inside the first 128
samples arms the lockout at 80 ms whatever the patch says, and the SECOND hit of
a 16 Hz train vanishes. Measured 47/48 through the factory against 48/48 through
the pure core, the two buffers otherwise bit-identical, the missing edge at
sample 3022. A one-quantum HOST artifact, not a module property — and a census
that swallowed it would have reported 97.9 % capture for the wrong reason.

**M7 — DEFECT (live, #1744): THE CARD'S ONSET LED REPORTS 18.8–25.0 % OF WHAT
THE JACK EMITS.** `snapOnset` was written every render quantum and read every
sixteenth; a trigger pulse is 240 samples ≈ 1.9 quanta.

| hit rate | jack edges | LED blinks | capture |
|---|---|---|---|
| 1 Hz | 12 | 3 | 25.0 % |
| 2 Hz | 24 | 5 | 20.8 % |
| 4 Hz | 48 | 10 | 20.8 % |
| 8 Hz | 96 | 18 | 18.8 % |

The `buggles` / `backdraft` shape reached from the other side: those dropped
edges because a main-thread poller rescanned a ring buffer; this one because two
cadences inside ONE processor were never lined up. Fixed by latching across the
post interval. **The gate had to go on the PROCESSOR** — the pure core has no
port, an OfflineAudioContext render never delivers a `postMessage`, and the LED
is a decaying CSS opacity.

**M8 — SENS IS CONDITIONAL, AND THE FIRST PROBE COULD NOT SEE IT.** Swept
against a clean 4 Hz hit train at four amplitudes, the WHOLE travel is a no-op
(12/12 at SENS 0, 0.25, 0.5, 0.75, 1). That reads exactly like a dead dial and is
not one — an unambiguous transient clears every threshold, so the probe was
INVARIANT to the dimension under test. On ambiguous material:

| signal | SENS 0 | 0.25 | 0.5 | 0.75 | 1 |
|---|---|---|---|---|---|
| tremolo sine (4 Hz AM) | 1 | 1 | 8 | 11 | **13** |
| hits under a loud noise bed | 4 | 5 | 7 | 7 | **10** |
| 30 Hz AM burst train (debounce 20) | 3 | 3 | 4 | 61 | **78** |

The mechanism: the threshold is `avgFlux · mult + 0.15`, so the fixed floor
dominates whenever the running flux is small. §15.10's rule, one cohort later.

**M9 — THE RENDER IS REPRODUCIBLE AND THE TWO SEAMS AGREE.** Two independent
renders of one patch are BIT-IDENTICAL (`0.0000e+0` across all four outputs), and
the worklet agrees with the pure core to `0.0000e+0` — which matters because
`gain` is a GainNode in the factory and an inline multiply offline.

### What the audit did NOT find

No dead jack, no dead dial (M8 is a conditional dial, not a dead one), no
unexposed DSP capability, no range disagreement, no cross-domain leakage, and no
defect in the feature maths. **The CV audit is VACUOUS BY CONSTRUCTION and says
so** rather than running a null sweep that passes (the Q12 precedent): one input,
plain `audio`, zero `paramTarget` ports — asserted directly, in a leg that
reddens the day someone adds one.

### 18.1 FOUR CORRECTIONS TO THE Q16 SPEC (§12), all measured

1. **"the MAXIMUM trigger rate is `1000/debounce` = 12.5 Hz"** — right, and the
   spec did not say under what. Under a train the detector can RESOLVE it is
   exact (36/36 at 12 Hz, 24/48 at 16 Hz). Under a DENSE 60 Hz drive the
   achieved ceiling is 10.0 Hz at the same 80 ms, because after the lockout
   expires the flux still has to re-rise. Two different numbers from one dial,
   and the readout states the first.
2. **"`punchToCv` maps crest 1..6 onto 0..1, so … white noise (~3.5) reads
   0.5"** — the spec inherited the DSP comment's error verbatim. This rack's
   white noise reads **0.146** (M5). The spec's own instruction — *"Measure
   every one of those claims against the real factory; do not transcribe
   them"* — is what caught it, on the sentence the spec itself transcribed.
3. **"PROMOTION LOSES THE METERS … the module is an ANALYSER and its picture IS
   the analysis"** — true, and the cost is smaller than stated because the
   meters were a THIRD, DISAGREEING view. `levels()` returns the UNSMOOTHED,
   always-UNIPOLAR target: the bars are byte-identical at atk/rel 0.5/1,
   10/100 and 500/2000 while the jack moves, and at the shipped BIPOLAR default
   the PUNCH bar reads 0.145 where the PUNCH jack sits at −0.703. Filed as
   #1747. So route 1 was taken in SHAPE (a `custom` sidebar block) and rejected
   in CONTENT: `featurecv-maps` is DRAWN from the worklet's own constants, not
   traced off the snapshot — which also retires the spec's VRT worry entirely,
   since the picture is a pure function of `node.params`.
4. **"`face.order` must rank `bipolar` … a TOGGLE cell"** — right that it must be
   ranked, and it ranks FIRST rather than being fitted in. It also needed a
   `ParamOption` roster: undeclared, a 0..1 discrete param renders as an
   anonymous `<Toggle>` printing `0`/`1` where the card has always printed
   `UNI`/`BI`. Cosmetic, so contract-lock does not move for it.

### 18.3 VRT: PREDICTION vs ACTUAL, RECONCILED

**PREDICTED, from the RESTING DOM rather than from a local diff: 2 files
committed, 0 moved.**

**ACTUAL: exactly that.** `chore(vrt): regenerate baselines [vrt-update
workflow]` (`6234f82c0`) is `2 files changed, 6 insertions(+)`:

```
e2e/vrt/__screenshots__/workflow-shell-faces.spec.ts/face-featurecv-compact.png  (new)
e2e/vrt/__screenshots__/workflow-shell-faces.spec.ts/face-featurecv-dock.png     (new)
```

The card baseline `vrt.spec.ts/featurecv.png` did NOT move, and it was checked
BEFORE the capture rather than inferred from it: the PR run on `db0e7cd3c` failed
exactly three `vrt-strict` assertions — the two missing snapshots and the roster
clause that reads the filesystem for committed PNGs — and the card scene passed
in the same run.

⚠ **The local macOS run is what would have made the prediction wrong.** It failed
the card scene at 3452 px, which reads as "your change moved it". It is platform
noise: an untouched text-heavy card (`spectrograph`) fails the same local run at
**6506 px** — harder than the card that was actually edited — while a sparse
untouched one (`noise`) passes. Two controls in opposite directions, on a
question where the tempting single observation says the opposite of the truth.

⚠ **And the local run WROTE both new baselines as untracked PNGs**, which the
second local run then reported as PASSING. They were deleted, not committed;
`git status --untracked-files=all` was clean before the dispatch and again after
the merge. This is the #1706 hazard in its new-baseline form, and it is why "the
scene passed" is never evidence on a branch that just ran VRT locally.

### 18.2 WHAT COHORT 3 ADDS TO §5 / §10 / §15

15. **A "CLEAN" PROBE CAN BE THE WRONG PROBE.** §15.10 says a no-op reading is
    first an INSTRUMENT bug; Q16 adds the shape it takes when the instrument is
    fine and the STIMULUS is invariant. A clean hit train cannot see SENS
    because an unambiguous transient clears every threshold; hits at a 10 ms
    decay cannot see DEBOUNCE because their tails overlap. **Ask what the probe
    signal is invariant to, not only what the metric is.**

16. **`contract-lock.txt` IS NOT `face`-BLIND — `face.sidebar` IS PROJECTED.**
    `module-faceplates.md` said *"contract-lock.txt contains zero `face` lines …
    a sidebar is free"*, and there are 41 `face sidebar` lines in the golden
    today. Declaring, reordering, relabelling or REMOVING a sidebar block costs
    a `task docs:accept` — which is the review surface #1468 did not have when
    it removed a block from twelve modules with every non-pixel gate green.
    Corrected in the skill with this PR.

17. **A KNOB'S `units` NEVER PAINT AT REST**, so binding them is invisible to a
    VRT baseline. `Knob.svelte` renders its value readout only while
    `dragging || hovering`, and its `.label` is `text-transform: uppercase` — so
    featurecv's five VOCABULARY_DEBT entries were pure CASE and its three
    missing `units` were pure hover, i.e. **a card/def divergence with no
    pixel symptom at all**. That is why they sat unpaid, and it is not a reason
    to leave them: the dock renders the DEF's label, and the second copy is what
    drifts. **Predict the baseline move from the RESTING DOM, not from the
    diff** — and negative-control the prediction, because a local macOS run of
    an untouched text-heavy card (`spectrograph`, 6506 px) fails HARDER than the
    card you changed (`featurecv`, 3452 px), while a sparse one (`noise`) passes.

## 11. Q17 · `illogic` — MEASURED, and the "MARGINAL" verdict was wrong

§9 filed this as *"MARGINAL-YES, deferred. Four attenuverters, ten outputs of
derived logic."* Shipped 2026-08-16 (#1751). It is not marginal, and the reason
generalises: **§9 ranked the pool by what the module EXPOSES and this module's
whole value is in what it PUBLISHES** — the §10 rule 6 correction (`ninelives`)
applies here and was not applied.

Every number below is re-derived on every run by
`art/scenarios/illogic/face-audit.test.ts` against the REAL factory under
`node-web-audio-api` at 48 kHz. Determinism is asserted first (two renders,
bit-identical, every declared output) because #1680 measured three modules racy
under it.

**M1 — FOUR OF TEN JACKS ARE BEHIND NONE OF THE FOUR KNOBS.** Each attenuverter
swept its full −1 → +1 travel, all ten outputs watched, max |Δ| in linear
amplitude on a 0.9/0.9/0.6/0.4 stimulus of CO-PRIME sub-audio sines (3/5/7/11 Hz
— an even ratio aliases the mix buses and makes a cancellation look like a null):

| param | own `att` | `sum` | `diff` | `and` | `or` | `nand` | `not` |
|---|---|---|---|---|---|---|---|
| `att1_amount` | 1.80e+0 | 1.80e+0 | 1.80e+0 | **0** | **0** | **0** | **0** |
| `att2_amount` | 1.80e+0 | 1.80e+0 | 1.80e+0 | **0** | **0** | **0** | **0** |
| `att3_amount` | 1.20e+0 | 1.20e+0 | 1.20e+0 | **0** | **0** | **0** | **0** |
| `att4_amount` | 8.00e-1 | 8.00e-1 | 8.00e-1 | **0** | **0** | **0** | **0** |

Asserted with the port sets DERIVED FROM THE DEF (`gate`-typed vs `cv`-typed)
and in BOTH DIRECTIONS — every gate output unmoved AND every cv output moved by
at least one param — so the sweep cannot pass by measuring nothing. Each
attenuverter is also orthogonal: knob N moves `attN` and no other `att` jack.

**M2 — DIFF SHIPS AS A COMMON-MODE NULL, and this is the face's best sentence.**
Its gain on a signal present at every input is `a1+a2−a3−a4` = exactly **0.00**
at the shipped defaults. Read AT THE JACK, not computed: one sine into all four
inputs gives `peak(diff) = 0.000000` while `peak(sum) = 0.8 × 4`. Underneath
four faders sitting at maximum, one of two mix buses outputs silence. Negative
control: unbalance ONE knob and DIFF comes alive at exactly ×2.

**M3 — NEITHER BUS IS SCALED BY 1/n.** Worst case `Σ|aN|` = **×4.00** on a CV
convention of ±1, reached on SUM under in-phase DC and on DIFF under the
anti-phase split. A deliberately modest stimulus already leaves the rail on
**26.8 %** of SUM's samples and **39.2 %** of DIFF's, while every individual
`att` jack stays inside it — so the over-range is a property of the SUMMING,
which is what the `peak` readout says.

⚠ **§2 OF THE BATCH-5 SPEC DID NOT REPRODUCE, and that is the lesson.** It
quoted `sum` 1.791 / `diff` 2.594 from "the same" 0.9/0.9/0.6/0.4 stimulus and
called DIFF the worse of the two. Measured here: **sum 2.224 / diff 1.978**, with
SUM the worse. Neither pair is wrong — they are different PHASE relationships of
the same amplitudes, and a peak of a sum of sines is a property of the phases,
not of the module. **A stimulus-dependent peak is not a fact about a module.**
The face therefore prints the WORST CASE (`Σ|aN|`, phase-independent and
derivable from the knobs), and the ART sweep asserts the fraction-outside-rail
as an inequality rather than pinning either number.

**M4 — A LEVEL STATISTIC CANNOT SEE AN ATTENUVERTER.** `att1` at −1 and +1: rms
0.636396 and peak 0.900000 at BOTH, signed max |Δ| = 1.8000e+0. Every comparison
in the audit is a signed per-sample delta for this reason, and the routing
picture hatches the triangle on a negative coefficient. **An attenuverter is the
most common control shape in the unfaced tail** (`analogLogicMaths`,
`unityscalemathematik`, the `moog9xx` family), so any sweep over those must be
signed or it will report the control's defining behaviour as doing nothing.

**M5 — THE ONE LIVE DEFECT (#1750), and it is the two-sided-contract shape.**
`>= 0.5` is declared in `illogicMath.gate`, the def's `docs`, and the module
manifest; the shipped path rendered **0.25** at exactly that value, because
`WaveShaperNode` interpolates and the threshold landed at curve index 3071.25 of
4096. Fixed by snapping the step to the sample at-or-below the threshold. **ART
baselines byte-identical across the fix — only the four `.sha` pins moved**,
which is the verification. A permanent negative control carries the pre-fix
construction through WaveShaper's own lookup arithmetic.

**M6 — THE SWEEP THAT FOUND NOTHING, and why it is still the deliverable.** 100 %
edge capture at 1/2/4/8/16 Hz at every width down to a SINGLE SAMPLE (20.8 µs),
on BOTH legs of the AND multiplier — the audio input AND the AudioParam
modulator, which is the only one a k-rate param could break. Instrument controls
are permanent: the counter must read 0 with the other input low (while OR still
counts every edge) and must report 8 for an 8 Hz × 4 Hz product, not 16. No
out-of-range excursion on coincident edges (worst 0.0000e+0).

**M7 — THE RANK HAS AN INTRINSIC AXIS after all.** Four apparently
interchangeable knobs, but each input driven ALONE reaches **7 / 6 / 3 / 3** of
the ten outputs (in1 taps the logic block and NOT; in2 taps the logic block;
in3/in4 reach no boolean jack and are SUBTRACTED where 1–2 are added). The order
comes out 1,2,3,4 — the same as declaration order — and the ART sweep asserts the
reach ordering is non-increasing along `face.order` rather than the numbers. This
is the `moog914` answer on a module §9 had written off as the `bluebox` problem.

### What Q17 adds to §10

9. **A PICTURE IS A CLAIM, AND THE ONLY GATE THAT READS IT IS A HUMAN LOOKING AT
   THE BASELINE.** The first linux capture shipped the routing panel's logic
   label CLIPPED (`and or nand no`) and drew ONE bus line labelled `sum` at the
   top and `diff` at the bottom — "one bus with two names", with the +/− column
   hung on it implying the polarity split applies to both. It does not. Both are
   geometry; the e2e asserts DOM attributes and saw nothing, `module-face-lint`
   saw a registered panel, and faces-parity saw no stray `control-*` testid.
   **Look at the PNG the bot commits.** It is the deliverable, not the receipt.

10. **PREDICT THE BOT'S FILE COUNT BEFORE EACH DISPATCH AND CHECK IT.** Two
    dispatches here, both predicted exactly: #1 "2 added, 0 modified, 0 deleted"
    (two new scenes) and #2 "1 modified, 0 added, 0 deleted" (the dock only — a
    compact lane tile renders no sidebar, so a sidebar-only change cannot move
    it). Scoping the second with `GREP=illogic` cut it from ~50 min to ~8.

11. ⚠ **A LOCAL VRT RUN SILENTLY AUTHORS THE MISSING BASELINES IT JUST FAILED
    ON** — and a second local run then reports them PASSING, against a macOS
    render. Third occurrence; filed as #1752 with a suggested mechanisation.
    Until then, `git status --untracked-files=all` after every local VRT run in
    a window where a baseline is new. Note the useful half: once the baseline
    EXISTS, a local run writes only `-actual.png` into the gitignored
    `test-results/`, which makes it a safe and fast way to EYEBALL a picture
    before spending a dispatch on it. Both panel defects above were found and
    fixed that way.
