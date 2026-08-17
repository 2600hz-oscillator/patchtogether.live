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

---

# COHORT 4 — appended 2026-08-17

Cohort 3 is exhausted: Q15 `unityscalemathematik`, Q16 `featurecv`, Q17
`illogic`, Q18 `destroy` and Q19 `analogLogicMaths` are merged. Q20 `moog923`
and Q21 `moog905` are spec'd and unbuilt — **they stay in the queue, they are
not re-spec'd here.** Q22 `backdraft` is being built concurrently and is **not
touched here**.

**This cohort is deliberately VIDEO-WEIGHTED**, and §20 is the reason: the pool
is now 51 % video and the two platform gaps §17.9 named as blocking *every*
video face have both landed.

## 19. THE RE-DERIVED POOL (2026-08-17, `origin/main` @ `5ecae179`)

Same three sources as §6 and §11, none of them this file, RE-RUN rather than
re-read:

```sh
# contract-lock.txt            -> domain / params / discrete / units / in / out /
#                                 paramTarget count / families / port KINDS
# face-migration-inventory.ts  -> disposition (SOURCE, not the generated md)
# strict-faces.ts              -> the promoted set
# join: generic-face ∩ ¬STRICT_FACES, SPLIT by domain (§16's correction), and
#       printed in FOUR orderings
```

**`|STRICT_FACES|` = 48. The pool is 92 — 45 audio, 47 video, 0 meta.**

The re-derivation is its own negative control on §11, and it passes in both
directions: every cohort-3 entry that merged has LEFT the pool
(`unityscalemathematik`, `featurecv`, `illogic`, `destroy`, `analogLogicMaths`,
`slewSwitch`, `mixmstrs` are all gone), while `moog923`, `moog905` and
`backdraft` are still in it — exactly the shape a correct join has while two
specs sit unbuilt and a third is in flight. The instrument was also checked
against itself: 196 modules in `contract-lock.txt`, 196 entries in
`face-migration-inventory.ts`, **zero on either side without the other**.

| | audio | video | meta |
|---|---|---|---|
| registered modules | 120 | 68 | 8 |
| `generic-face` | 93 | 47 | 0 |
| `bespoke-surface` | 27 | 18 | 5 |
| `organizational-native` | 0 | 0 | 3 |
| `blocked` | 0 | 3 | 0 |
| **PROMOTED** | **48** | **0** | 0 |
| **remaining pool** | **45** | **47** | 0 |

⚠ **`STRICT_FACES ∩ {video defs}` is STILL ∅**, and video is now the LARGER half
of the pool. §16 recorded the skew; a cohort later it has not moved, because the
one video entry that was authored (`backdraft`) turned out to be the hardest
module in the domain (§17.9). **That is a selection artefact, not evidence about
video**, and §20 is the correction.

### 19.1 FOUR ORDERINGS, and this time the fourth is the one that pays

§10.6 retired param-count-alone; §11 added OUTPUT count and params+outputs. This
run adds a fourth — **outputs PER param**, which is the `ninelives` argument
written down as a sort key rather than re-argued each cohort (2 params, 9
outputs; merit lives in the RELATION between the outputs, and the ratio is what
surfaces that shape).

Head of the pool by param count (video rows marked **V**):

| type | dom | par | disc | unit | in | out | cvT | disposition here |
|---|---|---|---|---|---|---|---|---|
| `wavesculpt` | | 79 | 12 | 26 | 26 | 7 | 11 | owner manual review (§4) |
| `colourofmagic` | **V** | 37 | 22 | 1 | 31 | 22 | 15 | **DEFERRED → §22.1** |
| `backdraft` | **V** | 37 | 3 | 0 | 33 | 1 | 29 | Q22 — IN FLIGHT, do not touch |
| `moog960` | | 36 | 11 | 1 | 3 | 4 | 0 | needs a STEP-GRID cell |
| `foxy` | | 33 | 6 | 8 | 5 | 5 | 3 | extension-class (video out) |
| `spirographs` | **V** | 31 | 4 | 0 | 31 | 3 | 31 | **Q23** |
| `synesthesia` | | 22 | 4 | 0 | 4 | 48 | 0 | extension-class (video out) |
| `b3ntb0x` | **V** | 22 | 0 | 0 | 19 | 1 | 18 | **Q24** (family) |
| `quadralogical` | **V** | 21 | 4 | 0 | 19 | 2 | 15 | **Q27** |
| `grainsOfVision` | **V** | 20 | 1 | 0 | 19 | 2 | 17 | **Q26** |
| `moog984` | | 16 | 0 | 0 | 4 | 4 | 0 | needs a MATRIX cell |
| `bentbox` | **V** | 16 | 0 | 0 | 15 | 1 | 14 | **Q24** (family) |
| `vfpgaRunner` | **V** | 16 | 0 | 0 | 12 | 2 | 8 | **DEFERRED → §22** |
| `mandelbulb` | **V** | 13 | 4 | 0 | 10 | 2 | 10 | **Q25** |
| `ruttetra` | **V** | 12 | 0 | 0 | 8 | 1 | 7 | next-after |
| `warrensvisions` | **V** | 12 | 4 | 5 | 9 | 1 | 8 | next-after (§22.7) |
| `mirrorpool` | **V** | 11 | 0 | 0 | 13 | 1 | 11 | next-after |
| `wavecel` | | 10 | 0 | 5 | 7 | 4 | 3 | extension-class (poly + video) |
| `scope` | | 9 | 3 | 1 | 11 | 3 | 9 | Q4 — extension-class |
| `outlines` | **V** | 9 | 0 | 0 | 9 | 4 | 8 | next-after |
| `swolevco` | | 8 | 0 | 4 | 7 | 4 | 4 | Q5 — unblocked by #1669 |
| `shapedramps` | **V** | 8 | 0 | 0 | 12 | 6 | 8 | **REJECTED → §22.3** |
| `freezeframe` | **V** | 8 | 2 | 1 | 2 | 5 | 1 | next-after |
| `4plexvid` | **V** | 8 | 4 | 0 | 8 | 4 | 4 | next-after |
| `treeohvox` | | 7 | 0 | 3 | 10 | 1 | 7 | Q3 — blocked by #1658 |
| `moog921Vco` | | 6 | 0 | 2 | 8 | 4 | 5 | sibling of **Q28**, spec'd there |
| `timelorde` | | 6 | 4 | 2 | 5 | 14 | 0 | Q2 — extension-class |
| `moogCp3` | | 5 | 0 | 0 | 5 | 7 | 0 | sibling of **Q28**, spec'd there |
| `moog921b` | | 5 | 1 | 2 | 5 | 4 | 0 | **Q28** (the 921A + 921B pair) |
| `moog923` | | 3 | 0 | 0 | 1 | 4 | 0 | **Q20 — already spec'd, unbuilt** |
| `moog905` | | 3 | 0 | 0 | 1 | 1 | 0 | **Q21 — already spec'd, unbuilt** |

**Head of the OUTPUTS-PER-PARAM ordering** (out ≥ 2), which is where the
`ninelives` shape lives:

| type | dom | par | out | out/par | what the ratio is claiming |
|---|---|---|---|---|---|
| `onetonine` | **V** | 1 | 9 | 9.0 | **REJECTED → §22.2** — the ratio is real and so are the outputs; the PARAM is not |
| `moog994` | | 0 | 6 | — | §4 rejection stands (passive multiple) |
| `cvBuddy` | | 2 | 5 | 2.5 | §14 rejection stands (`node.data`) |
| `timelorde` | | 6 | 14 | 2.33 | extension-class |
| `synesthesia` | | 22 | 48 | 2.18 | extension-class |
| `cvBuddyMini` | | 2 | 4 | 2.0 | §14 rejection stands (`node.data`) |
| `joystick` | | 2 | 4 | 2.0 | §4 DEFERRAL stands (`<XyPad>` consolidation) |
| `moog961` | | 2 | 4 | 2.0 | §4 rejection stands |
| `moogCp3` | | 5 | 7 | 1.4 | sibling of **Q28** — §14's "member of the bank" is CORRECTED there |
| `moog923` | | 3 | 4 | 1.33 | **Q20**, already spec'd |
| `shapedramps` | **V** | 8 | 6 | 0.75 | **REJECTED → §22.3** |

**The fourth ordering surfaced exactly one new name — `onetonine` — and it is a
REJECTION.** That is worth recording as a result rather than a null: an ordering
that only ever promotes is an ordering nobody could have been wrong about. §22
carries the reasoning.

**What this pool STILL cannot see** (restated, because a green derivation is not
a complete one): the join reads DECLARATIONS. It cannot tell N genuinely
different outputs from N copies of one bus — that is what killed `onetonine` —
and it cannot see a card-only affordance at all. **STOP 2 is a grep, not a
query.** §20.2 is that grep, run TOTALLY for the first time.

## 20. WHAT CHANGED UNDER VIDEO SINCE §17 — six findings, all mechanical

### 20.1 BOTH PLATFORM BLOCKERS §17.9 NAMED HAVE LANDED, and the attest is still free

§17.9 listed four items between the pool and a video face. Two of them were
platform-wide (*"Blocks every video face, not just this one"*) and **#1732 shipped
both**:

| §17.9 item | status on `origin/main` @ `5ecae179` |
|---|---|
| 2. *"Give `ModuleFace` a way to express 'no user control'"* | **LANDED.** `def.noUserControl` (`no-user-control.ts`), a DECLARATION not a skip-list: `why` required by the TYPE, `writer` checked against the def's own ports in both directions. Five named consumers, each a real behaviour change. |
| 3. *"Wire the `fullViewBody` slot"* | **LANDED.** `WIRED_SHELL_EXTENSION_SLOTS = ['glyph', 'fullViewBody']` (`shell-extensions.ts:124`), mounted as `<ExtFullViewBody>` behind a queryable testid, dock-gated in ONE place (`dockFullViewHeadPlan`, `module-shell-model.ts:688-706`). |
| 1. the six backdraft gate placements | backdraft-specific; irrelevant to every other candidate |
| 4. `options[]` + `curve` corrections | **STILL COSTS A REAL-GPU RE-ATTEST** — see below |

**And the attest price is still zero for the declarations.**
`HASH_TRANSPARENT_PROPS` is now `['docs', 'controlFamilies', 'face',
'noUserControl']` (`attest-code-basis.ts:95-107`), and the added entry carries
its own argument in the source: *"every video def sits in the WebGL attest
basis, so a property that stayed in the hash would make declaring one cost a
real-GPU re-attest that CI (SwiftShader) cannot run."* So §17.8's table extends
cleanly:

| edit to a VIDEO def | WebGL attest hash moves? |
|---|---|
| add a top-level `face: {...}` | **NO** |
| add `noUserControl: [...]` | **NO** |
| edit its `docs` strings | **NO** |
| add `options[]` to a param, or correct a `curve` | **YES** — owner-machine step |

⚠ **The last row is the one that shapes every spec below**, because §20.3 shows
it applies to essentially the whole pool.

⚠ **`fullViewBody` is WIRED and has ZERO ADOPTERS.** The only registered
extension in the tree is `dx7` (`ui/modules/dx7/shell-extension.ts`), and it
exports `glyph` alone. Whichever spec is built first from Q26 becomes the slot's
first adopter, and `shell-extensions.test.ts:163` already pins the three things
its render site has (read, mount, queryable testid) — so the adopter inherits a
gate rather than writing one.

### 20.2 THE ⛶ OUTPUT BLOCKER IS THREE MODULES, NOT THE DOMAIN — swept totally

§17.1's refusal has been read since as a property of video faces. It is not. It
is a property of the `VideoCanvasContextMenu` affordance, and that affordance is
**mounted by exactly six cards in the entire fleet**:

```sh
$ grep -rln "VideoCanvasContextMenu" packages/web/src/lib/ui/modules/*.svelte
BackdraftCard.svelte  B3ntb0xCard.svelte  BentboxCard.svelte
ToyboxNodeMenu.svelte  VideoboxCard.svelte  VideoOutCard.svelte
```

Three of those six (`toybox`, `videoOut`, `videobox`) are `bespoke-surface` and
already carved out of the pool. **So within the 47-module video pool the ⛶ OUTPUT
/ Full Frame / Full Screen / Present blocker exists on precisely THREE modules:
`backdraft`, `b3ntb0x`, `bentbox`** — and on the other 44 it does not exist at
all. A face over any of those 44 loses no capability; it trades a card-sized
preview canvas for the shell's live 160×120 `VideoTileThumb`, which is the same
`blitOutputToDrawingBuffer` seam (§16.2).

⚠ **This is a SIZE claim, not a safety claim, and the distinction matters.** The
grep proves no candidate mounts *that* menu. It does NOT prove a candidate has no
other card-only affordance — `QuadralogicalCard` mounts a MIDI-assign context
menu over its XY pad, which no grep for "fullscreen" would ever surface. **STOP 2
still has to be run by hand, per module**, and it is, below.

⚠ And note what the sweep says about Q26: `b3ntb0x` + `bentbox` are the two
pool modules that DO carry it — which is why they are spec'd as the
`fullViewBody` adopter rather than as ordinary faces.

### 20.3 THE PARAM-SHAPE TAX — and ⚠ A CORRECTION TO HOW §17.3 IS BEING READ

⚠ **THE FIRST DRAFT OF THIS SECTION WAS WRONG, and the error is worth keeping
because it is §17.3's own sentence over-generalised.** It read "every discrete
param without `options[]` renders as a knob" off §17.3's backdraft table and
swept the pool on `curve === 'discrete'`. **That is not what the resolver
does.** Read `paramCellKind` (`shell-control-kind.ts:243-253`) rather than the
precedent:

```ts
if (p.options?.length) {
  if (tier !== 'dock') return 'knob';
  return p.options.length <= SEGMENTED_MAX_OPTIONS ? 'segmented' : 'selector';
}
if (looksLikeToggle(p)) return 'toggle';   // curve==='discrete' && min===0 && max===1
return 'knob';
```

So the real rule has **three** arms, not one:

| param shape | what a def-driven face renders |
|---|---|
| `discrete`, `min 0`, `max 1` | **`toggle`** — correct already, `options[]` irrelevant |
| `discrete`, **more than two states**, no `options[]` | **`knob`** at every tier — §17.3's case |
| `discrete`, more than two states, **with** `options[]` | `segmented`/`selector` **at the DOCK tier only**; still a `knob` in lane / compact / plate |

⚠ **The third arm matters and is not in §17.3**: declaring `options[]` buys the
named states in the dock full view and **nowhere else**. Do not price an
options fix as if it changed the lane tile.

Re-swept on the correct predicate — **multi-state** discrete params (>2 states)
in the pool, against `options:` declarations in the def source:

| type | dom | multi-state discrete params | `options[]` |
|---|---|---|---|
| `moog960` | A | 11 (`mode1..8`, `range1..3`, all 0..2) | 0 |
| `wavesculpt` | A | 9 (incl. three `*_color 0..16777215`) | 0 |
| `4plexvid` | **V** | 4 (`sel1..4` 0..3) | 0 |
| `colourofmagic` | **V** | 4 (three `pal_* 0..16777215`, `preview 0..21`) | 0 |
| `fourplexer` | A | 4 (`sel1..4` 0..3) | 0 |
| `quadralogical` | **V** | 4 (`edge1..4_fx` **0..7**) | 0 |
| `backdraft` | **V** | 3 (`flicker` 0..5, `shape` 0..4, `tvMode` 0..2) | 0 |
| `warrensvisions` | **V** | 3 (`visionsComponents` 1..256, `visionsSlice`/`visionsStability` 1..16) | **1** (on `engineFreeze`, a 0..1 toggle) |
| `acidwarp` | **V** | 2 (`paletteType` 0..7, `scene` **0..40**) | 0 |
| …21 further modules | | 1 each | 0 |

**30 pool modules carry at least one multi-state discrete param, and exactly ONE
`options[]` declaration exists anywhere in the 92-module pool** —
`warrensvisions.engineFreeze`, which is a 0..1 toggle and therefore did not need
it. **Every named-state control in the pool is a bare number today.**

⚠ But note what the corrected predicate also says: a 1..256 or 2..16 param is
`discrete` because it is INTEGER, not because it is a named enum. `options[]`
is the wrong fix for those — a knob IS right, it just needs a `units`. **Sort
"integer count" from "named enum" per module before pricing anything**;
`quadralogical`'s `edge*_fx 0..7` (eight named effects) and `4plexvid`'s
`sel1..4` are enums, `warrensvisions.visionsComponents` is a count.

**The consequence for this cohort, stated once rather than per spec:** a video
face ships fine WITHOUT any of this (the face is hash-transparent), but it ships
numbers where names belong. **Every spec below states its own options gap and
prices it separately from the face**, so the two can be reviewed — and merged —
apart.

⚠ **THE INVERSE DEFECT IS THE COMMONER ONE, and it bites this cohort.** A
genuine boolean declared `curve: 'linear'` fails `looksLikeToggle` and falls
through to **`knob`** — a continuous rotary over a two-state value. That is the
cloudseed precedent (`module-face-lint.test.ts:432-436`) and §17.6's finding on
backdraft's `mirrorX`/`mirrorY`/`pureGeo`. `onetonine.showGrid` (0..1,
`linear`, thresholded at 0.5 in the shader) is exactly it. ⚠ And do not "fix" a
`curve` without checking the consumer reads it — CLAUDE.md's `curve="linear"`
trap is a green gate certifying a live bug.

### 20.4 THE VIDEO CV BRIDGE IS NOT THE AUDIO CV BRIDGE — and #1773's shape reaches 33 pool modules

⚠ **DERIVED BY READING, NOT MEASURED. Every number in this section is a
hypothesis until a builder renders it (§5.2 / §15.14).** It is recorded because
it is mechanical and because it changes what a video face's readouts are FOR.

#1773 measured `analogLogicMaths`' CV inputs bit-exactly inert upward, and
attributed it to the Web Audio spec: an `AudioParam`'s computed value is clamped
to its nominal range, and a cable ADDS. **That mechanism does not exist on the
video path** — video params are plain store values, not `AudioParam`s. It was
therefore checked rather than assumed, and the same observable arrives by a
DIFFERENT route:

```
engine.ts:1594  tickCvBridges()            — runs EVERY FRAME, unconditionally
engine.ts:1617    handle.setParam(target, mapCvBridgeValue(mapping, raw))
cv-bridge-map.ts:103  mapCvBridgeValue -> scaleCv(sample, knob, min, max, hint)
cv-scale.ts:67   linear:   clamp(knob + cv*depth*(max-min)/2, min, max)
cv-scale.ts:86   discrete: clamp(round(min + ((cv+1)/2)*(max-min)), min, max)   ← knob UNUSED
```

Three consequences, none of them printed anywhere on any module:

1. **`default === max` ⇒ inert UPWARD; `default === min` ⇒ inert DOWNWARD.**
   Same observable as #1773, different mechanism (an explicit `clamp()`, not
   AudioParam nominal range). Swept over the pool: **33 of 92 candidates** have
   at least one such input. The UPWARD half is the sharp one — a dial that ships
   wide open with a cable that can only close it: `quadralogical` (5 inputs),
   `chroma` (3), `backdraft` (3), `warrensvisions` (2), `b3ntb0x` (1),
   `videoMixer` (1), `cellshade` (1), `posterbox` (1), `colorizer` (1),
   `destructor` (1).
2. **`cvScale: { mode: 'discrete' }` IGNORES THE KNOB ENTIRELY** — `scaleCv`'s
   discrete branch never reads it. So a patched cable does not modulate the
   dial, it REPLACES it, and at **0 V it lands on the range midpoint**:

   | module · param | range | dial default | value at cv = 0 |
   |---|---|---|---|
   | `luma.posterizeLevels` | 2..16 | **16** | **9** |
   | `tiler.tile` | 0..5 | 0 | **3** |
   | `spirographs.count` | 1..3 | 1 | **2** |
   | `grainsOfVision.composite` | 0..4 | 1 | **2** |
   | `scope.mode` (audio) | 0..1 | 0 | **1** |

   Patching a cable at rest is a visible jump, and the dial is inoperative for as
   long as the cable is there. This is DESIGNED (`cv-scale.ts:86-92` says so:
   *"cv=−1 → paramMin; cv=+1 → paramMax"*) — **the defect is that nothing states
   it**, which is precisely what a face readout is for.
3. **The modulation centre is captured ONCE, at plug time.**
   `buildCvBridgeMapping(..., meta?.params)` is called from `addCvBridge`
   (`engine.ts:1563`) and never rebuilt; `tickCvBridges` then overwrites the
   param every frame. **On the AUDIO path the knob keeps working** (the cable
   sums a delta into a live `AudioParam`); **on the VIDEO path it does not.**
   ⚠ This asymmetry is the single most load-bearing DERIVED claim in this
   cohort — **measure it first, on any candidate, before writing a readout that
   depends on it.**

### 20.5 TWO THINGS A VIDEO FACE PR DOES *NOT* OWE — checked, not assumed

- **No `DESCRIPTIONS` entry.** `describeModule` falls back to the co-located
  `docs.explanation` (`module-manifest.ts:1084-1095`), with the reason in the
  source: *"This is what lets most video modules render a real intro without
  duplicating their prose into DESCRIPTIONS."* The standing "a new module needs a
  DESCRIPTIONS one-liner or the unit gate fails" rule is an AUDIO rule.
- **No docs write-up from scratch.** Every candidate in this cohort is ALREADY in
  `STRICT_DOCS` (`freezeframe`:320, `quadralogical`:339, `ruttetra`:343,
  `warrensvisions`:349, `spirographs`:353, `mandelbulb`:354, `b3ntb0x`:358,
  `bentbox`:359, `onetonine`:373, `grainsOfVision`:437). The face PR owes docs
  ACCURACY, not docs existence — and §21's audits are where the inaccuracies are.

### 20.6 ⚠ THE LEGACY-FALLBACK FIXTURE IS DRY AGAIN — one promotion from throwing

**This is a live finding of this derivation and it is not filed anywhere.**
`e2e/tests/_face-fixtures.ts` picks `UNMIGRATED_AUDIO_MODULE` from an ordered
candidate list and throws at IMPORT TIME when none is acceptable — #1689's class,
moved to module load, and it already fired once when Q18 promoted `destroy`.

Read against `origin/main`, `UNMIGRATED_CANDIDATES = ['stereovca', 'moog902',
'gatemaiden']` and the predicate accepts **exactly one** of them:

| candidate | `STRICT_FACES`? | `domainClassForDef` | mounts `<Fader>`? | verdict |
|---|---|---|---|---|
| `stereovca` | no | `audio` | **yes** (`StereovcaCard.svelte`, 2) | **ACCEPTED — the only one** |
| `moog902` | no | `audio` | **no** (`Moog902VcaCard.svelte`, 0 — the `card:` override resolves here) | rejected |
| `gatemaiden` | no | `gate` | yes | rejected (asserted `.faceplate.audio`) |

**So the list is one promotion deep, and the module it depends on is
`stereovca` — which §4 lists as a merit rejection *with a caveat that could
promote it*.** Nothing in this cohort touches it, but:

⚠ **EVERY SPEC BELOW CARRIES THE SAME INSTRUCTION, AND IT IS NOT OPTIONAL: grep
your module across the whole test suite before promoting it** (`e2e/`,
`packages/web/src/lib/docs/`, `packages/web/src/lib/ui/`, `scripts/`, `art/`).
A promotion that empties this list takes down every spec that imports the file,
before any of them runs a line. **File an issue to widen
`UNMIGRATED_CANDIDATES`** — a list with one accepted member is a ratchet nobody
declared.

## 21. THE COHORT

Ordered by MERIT, not by param count. **§5.2 applies to every one of them, and harder
than usual: almost nothing below was RENDERED.** These are audits of source, so
every figure is DERIVED-BY-READING unless it says otherwise — a spec's arithmetic
is a hypothesis (§15.14). Each entry names what to measure first.

### Q23 · `spirographs` — three trochoids that drift on a clock nobody can see

**Merit: YES, and it is the strongest video candidate that is neither blocked nor
in flight.** 31 params, 31 `paramTarget` CV inputs (1:1 — every single param is
CV-able), 3 outputs, no video input. It is the largest unblocked candidate in
either domain after `colourofmagic` (§22.1) and `backdraft` (in flight).

**What it is FOR, visually.** You dial up to three independent spirograph figures
and let them DRIFT. There is no video in: this is a generator. Per figure you set
a fixed-circle radius `R`, a rolling radius `r`, a pen offset `p`, an
inside/outside family, rotation, zoom, X/Y nudge, line width and hue; the module
samples that trochoid as a polyline, strokes it on a 2-D canvas with real round
caps, and uploads it as a GL texture each frame. **The verb is *set it going*** —
each figure's centre moves on its own, forever, off the wall clock. You do not
steer it. You only nudge where it started.

**THE READOUT STORY — and it is unusually rich, because FOUR different derived
quantities are unprintable and all four change what you see.**

1. **THE DRIFT PERIOD. Nothing anywhere prints how long a figure takes to cross
   the frame and come back.** `advanceCenter` folds `home + v·t` into a band of
   width `W − 2·R·scale` px, and `reflectIntoBand` has period `2 × span`
   (`spirographs-math.ts:204, 243-253`). Velocity comes from a FIXED seed table
   (`spirographs.ts:110-114`) — **it is not a param at all.** So:

   > `T_x = 2·(W − 2·R·scale) / (|vx|·W)` seconds

   DERIVED-BY-READING at the shipped defaults, 1024×768:

   | figure | `R·scale` px | `T_x` | `T_y` |
   |---|---|---|---|
   | 1 (R 5 · scale 28) | 140 | **26.4 s** | **31.0 s** |
   | 2 (R 7 · scale 22) | 154 | **29.8 s** | **19.0 s** |
   | 3 (R 5 · scale 20) | 100 | **22.7 s** | **28.4 s** |

   ⚠ And note the shape of it: **the period is a function of `R × scale`**, so
   turning ZOOM up SHORTENS the bounce cycle. No label suggests that a zoom knob
   is also a rate knob.
2. **THE MOTION DIES AT A PRODUCT OF TWO DIALS, silently.**
   `advanceCenter` (`spirographs-math.ts:252-253`) is
   `hiX > loX ? reflect(…) : { pos: boxW/2 }` — so at `R·scale ≥ W/2 = 512` the X
   position pins to 512 **forever**, and at `R·scale ≥ H/2 = 384` Y pins.
   DERIVED: `R=12, scale=32` → 384 → vertical drift stops. `R=12, scale=43` →
   516 → **fully frozen, and `xOffset`/`yOffset` go bit-exactly inert with it**
   (the pinned branch ignores the base position entirely). **Nothing on the card
   computes `R·scale`.** This is the single best readout on the module: print
   `R·scale` against 384 and 512 and the freeze stops being a mystery.
3. **THE LOBE COUNT AND THE SAMPLE BUDGET, from one ratio.**
   `revs = clamp(round(r·1000) / gcd(round(R·1000), round(r·1000)), 1, 200)`,
   polyline length `= round(revs·240)+1` (`spirographs-math.ts:123-140, 295-299`;
   `samplesPerRev = 240` is hard-coded in `spirographs-draw.ts:71/98/135`).
   DERIVED-BY-READING:

   | R, r | gcd | revs | points per curve |
   |---|---|---|---|
   | 5, 3 (fig 1 default) | 1000 | 3 | 721 |
   | 7, 3 (fig 2 default) | 1000 | 3 | 721 |
   | 5, 2 (fig 3 default) | 1000 | 2 | 481 |
   | **5, 3.001** | **1** | 3001 → **capped at 200** | **48 001** |

   All three scenes are painted unconditionally every frame
   (`spirographs.ts:461-463`), so at `count = 3` the worst case is
   **9 × 48 001 ≈ 432 000 sin/cos pairs and `lineTo` calls per frame** — reached
   by moving `r` **by 0.001**. The docs promise *"R:r sets how many petals"*
   (`:265`) and no readout gives the number, the revs, the point count, or the
   200 cap. ⚠ **This is the readout that protects the user from the module.**
4. **A BIPOLAR LFO INTO `rotation` OR `chroma` SPENDS HALF ITS CYCLE PINNED.**
   `s1_rotation` is `0..6.2832` with default **0**, so `halfSpan = 3.1416` and
   `clamp(knob + cv·halfSpan, min, max)` (`cv-scale.ts:69-73`) sends every
   `cv ≤ 0` to exactly 0. A ±1 LFO gives a 0..half-turn sweep with a **hard stop
   for half its period**. Same on `s*_chroma` (default 0): the hue sits at pure
   red for half the cycle. This is §20.4's INERT-DOWNWARD arm, and it is on the
   two params a player is most likely to modulate.

**⚠ THE CV WARNING THAT IS SPECIFIC TO THIS MODULE — and it is §20.4's second
arm, four times over.** `count` and `s{1,2,3}_inside` declare
`cvScale: { mode: 'discrete' }` (`spirographs.ts:177, 186`), whose branch
**ignores the knob entirely**. DERIVED-BY-READING:

| param | range | dial default | value at **cv = 0** |
|---|---|---|---|
| `count` | 1..3 | 1 | **2** |
| `s1_inside` / `s2_inside` | 0..1 | 1 | 1 |
| `s3_inside` | 0..1 | **0** | **1** |

**Patching an idle DC-zero source into COUNT silently makes it 2 and the knob
stops mattering**, and the same cable flips figure 3 from OUTSIDE to INSIDE.
⚠ MEASURE THIS FIRST — it is the load-bearing derived claim of §20.4 and this is
the cleanest module in the pool to test it on.

**GLYPH: `'none'`.** No output declares `type: 'audio'`
(`video` · `mono-video` · `video`, `spirographs.ts:258-260`), so
`primaryAudioOutPortId` is null and any other glyph resolves to
`{kind:'static'}` — §16.2's rule applies unchanged. The live picture arrives
through `hasVideoSurface`'s OR. **Assert that, don't comment it.**

**⚠ STOP 2, and it INVERTS the usual worry.** `SpirographsCard.svelte` mounts a
160×120 preview canvas, three tab buttons, a bespoke conic-gradient colour wheel
(`spiro-colorwheel`, a pointer drag surface writing `chroma`), an INSIDE/OUTSIDE
button and a ticked 3-detent COUNT fader. **No `VideoCanvasContextMenu`, no
fullscreen, no present** (§20.2). But:

- **`mono_out` and `overlap` have NO on-card view AT ALL, today.** The surface's
  canonical texture is hard-wired to the colour FBO
  (`spirographs.ts:450-451`) and the card's only viewing path is
  `blitOutputToDrawingBuffer(id)`, which reads that surface. **Two of three
  outputs are already invisible in the shipped UI**, so a face does not lose
  them — it is the first surface that could ever show them. That is a merit
  argument, not a risk.
- **`activeSpiro` (the 1/2/3 tab) is component-local `$state`, not a param and
  not `node.data`** (`SpirographsCard.svelte:52`). It is invisible to
  `FaceReadoutValue` AND to persistence, and it resets on remount. A face's
  `pages` replace it cleanly — **this is the affordance the face improves.**
- **The COUNT detents and the colour wheel are card-only vocabulary.** The def
  carries no `options[]` and no `face`, so a def-driven face paints COUNT as a
  rotary printing `1.00` and `chroma` as a plain knob with no hue. Decide
  deliberately: a `color`-kind `paramCell` is the shell's answer for the wheel,
  and it must be DECLARED (`shell-control-kind.ts:57-58` — *"`1..32 discrete`
  and `0..16777215 discrete` differ only in MAGNITUDE, and no gate reads
  magnitude"*).

**⚠ THE OPTIONS PRICE (§20.3):** one multi-state discrete param (`count`, 1..3).
That is an INTEGER COUNT, not a named enum — so `options[]` is arguably the wrong
fix and a knob with a `units` is right. The three `s*_inside` params are already
`toggle` by `looksLikeToggle`. **So `spirographs` is the cheapest video candidate
on the param-shape axis: no re-attest is needed to render it correctly.**

**⚠ DEFECTS FOUND — file these, do not fold them into the face PR:**

1. **The docs describe a colour sequence the shader does not produce.**
   `spirographs.ts:236-237` and `module-manifest.ts:275` both promise pile-ups
   *"racing through green→yellow→red→magenta"*. Derived from
   `hue(n) = fract(0.207059·n + 0.58)` (`spirographs.ts:238-239` with
   `OVERLAP_STROKE_GRAY = 22`, `spirographs-draw.ts:113`), the actual order is
   **violet(1) → red(2) → yellow-green(3) → green(4) → blue(5)**, stepping
   **+74.5° per stacked line** and wrapping every 4.83. The white bloom
   (`smoothstep(0.78,1.0,a)*0.7`) does not begin until n ≥ 10 and **caps at 70 %
   — it never reaches white**, while the prose implies a white core. This is the
   #1701 / #1697 class exactly: a false VALUE in `STRICT_DOCS` prose with every
   declaration correct, so every gate is blind.
2. **A doc sentence stating a number the code contradicts, trivially but
   literally.** `docs.controls.s*_rotation` says *"0-2pi radians"* (`:272, :310`)
   while the declared max is `6.2832`, which EXCEEDS 2π by 1.47e−5 rad.
3. **`xOffset`/`yOffset` are documented as a "nudge" and are a TELEPORT at
   `t > 0`.** The position is `reflectIntoBand(home + v·t, …)` evaluated fresh
   each frame, so changing `home` by Δ moves the FOLDED position by ±Δ modulo an
   unknown number of reflections. At large `t` the visible jump is effectively
   arbitrary within the band.
4. **A stale roster comment.** `e2e/vrt/vrt-exemptions.ts:134-140` says
   spirographs is *"Currently in `EXEMPT_FROM_VRT` below"*. **It is not** — and
   it already has a committed solo baseline. ⚠ A ledger entry naming a state
   that no longer holds is exactly what CLAUDE.md calls RED.
5. Dead code: `curveMaxReach` (`spirographs-math.ts:143-147`) documents a role
   in picking sample density; nothing in the render path calls it (`samplesPerRev`
   is hard-coded 240). `advanceCenter`'s flipped-heading return is never read.

**⚠ THE SUITE GREP (STOP 2's other half), run:** `spirographs` appears in
`STRICT_DOCS:353`, `DESCRIPTIONS:274`, `contract-lock.txt:3110-3175`,
`modules-card-map.test.ts:61`, `rack-sizes.ts:215`,
`face-migration-inventory.ts:298`, `stereo-jack-collapse.test.ts:317-319` (a
case-only-id allowlist — `s1_R` vs `s1_r`), `vrt-live-surfaces.test.ts:156`,
`vrt-exemptions.ts:141-143` (a canvas mask), a committed solo VRT baseline,
`per-module-per-port-behavioral.spec.ts:256` (whole-module exempt),
`spirographs-render-smoke.spec.ts` and `video-pull-eval.spec.ts:92,94`.
**It is ABSENT from `_face-fixtures.ts` and `push-card-config.ts`, so promoting
it retires no fixture** — but it forces a decision on the existing canvas mask
and the committed solo baseline, and it ADDS the two `workflow-shell-faces`
baselines the roster gate demands.

**RISK: LOW-MEDIUM.** No `node.data`, no free-running source beyond the wall
clock, no audio, no fullscreen affordance to preserve. The two real risks are
(a) the DETERMINISM of a VRT capture over a module that drifts on
`performance.now()` — ⚠ **there is no `freeze` param here, unlike `backdraft`
and `grainsOfVision`, so a face scene needs one or a clock stub**; and (b) the
432 000-`lineTo` cliff, which a capture could wander into.

**MEASURE BEFORE RANKING:** the three drift periods (they are the headline
readout and they are pure arithmetic over a table I read, not rendered); the
`R·scale` freeze thresholds at exactly 384 and 512; `count`'s value at exactly
`cv = 0`; and the overlap hue at n = 1..5 against the docs' claim.

### Q24 · `b3ntb0x` **and** `bentbox` — the two modules that carry the §17.1 blocker, i.e. the FIRST `fullViewBody` ADOPTERS

**Merit: YES for both** — 22 params / 19 inputs and 16 params / 15 inputs, one
`video` output each. **They are ONE ENTRY here for the same reason Q12 was, and
for a DIFFERENT reason than Q12 was**, so read the next paragraph before
assuming the precedent transfers.

**⚠ THEY ARE A FAMILY, NOT A SUPERSET PAIR — and the first draft of this entry
assumed otherwise.** `b3ntb0x.ts:3-9` declares the lineage in the source
(*"a circuit-level NTSC composite RE-ARCHITECTURE of BENTBOX"*) and the suite
treats them as one class (`strict-docs.ts:357-359` adjacent under *"Video batch
7 … NTSC/composite destroyers"*; `vrt-exemptions.ts:673-681` adjacent with
cross-referencing rationale; `per-module-per-port-behavioral.spec.ts:218` names
*"the bentbox / b3ntb0x / backdraft animated-video variance class"*). **But the
PARAM-ID INTERSECTION IS EXACTLY FOUR** — `mirrorX`, `mirrorY`, `mirrorXGate`,
`mirrorYGate`. Of bentbox's 12 bending knobs, ZERO exist on b3ntb0x by id, and
vice versa. `b3ntb0x.ts:51` says outright *"NOTHING is imported from BENTBOX"*,
and `:138` labels its mirror helpers *"(clean, NOT imported from bentbox)"* —
the shared logic is **duplicated, not shared**. Different palette groups
(Processors vs Utilities), different architectures (4 GLSL passes / 6 FBOs, two
of them RGBA16F, vs 1 pass / 2 RGBA8).

> **So: TWO faces sharing ONE family LAYOUT and ONE extension pattern. The only
> control block you may legitimately share is MIRROR X / MIRROR Y (+ their two
> hidden gate params). Any sentence of the form "b3ntb0x is bentbox with more
> knobs" is FALSE** — and the two identically-labelled "Hue" controls are not
> even interchangeable (see the readout story).

**WHY THIS IS THE ENTRY TO BUILD FIRST, despite not being the largest.**
§20.2 swept the fleet: `VideoCanvasContextMenu` is mounted by six cards, three of
which are `bespoke-surface`. **`backdraft`, `b3ntb0x` and `bentbox` are the ONLY
pool modules carrying the ⛶ OUTPUT / Full Frame / Full Screen / Present menu.**
`backdraft` is in flight and refused on four other grounds (§17.9). So **these
two are the pool's `fullViewBody` case, and the slot has been WIRED since #1732
with ZERO adopters** (`dx7` is the only registered extension and it exports
`glyph` alone). The render site already carries its own gate
(`shell-extensions.test.ts:163` pins read + mount + a queryable testid;
`:174` pins that the dock gating lives in ONE place), so **the adopter inherits
a gate instead of writing one** — which is the opposite of §17.1's position, and
the reason it is now a face-sized job rather than a platform PR.

Concretely, per card: `B3ntb0xCard.svelte:81-118, 382-397` and
`BentboxCard.svelte:94-136, 406-421` each carry `createFullscreen` /
`createFullFrame` / `createPresent` / `attachRenderLease` plus the right-click
menu. ⚠ **`present` feeds a second-display popup from the NODE'S ENGINE OUTPUT,
not from the card canvas** (`B3ntb0xCard.svelte:88-96`) — so the extension can
move without re-plumbing the projector.

**THE READOUT STORY — four facts, and each one contradicts a control's own label
or its module's own instructions.**

1. **`b3ntb0x.tbc` DEFAULTS TO 1 AND THAT ZEROES THE MODULE'S HEADLINE GESTURE.**
   `b3ntb0x.ts:443` is `return (rawOffset + wobble) * (1.0 - tbc);` — at the
   shipped `tbc = 1` that is **exactly 0.0**, every frame. The 24-iteration sync
   scan (`:426-432`) and the wobble term (`:441`) are computed and multiplied by
   zero. **DERIVED-BY-READING:** at `tbc = 0` the worst-case displacement is
   ±0.037 of line-fraction ÷ 0.84 × 1024 = **±45 output px**; at `tbc = 0.5`,
   ±22.5 px; at the default, **0 px**. Meanwhile `docs.explanation` (`:788`)
   instructs the player: *"Crank Sync Crush + Bias to **tear and roll the
   picture**."* **At factory settings that instruction cannot work**, and the
   `tbc` control doc (`:826`) states the opposite behaviour correctly — two doc
   sentences that contradict each other operationally. A readout printing the
   effective displacement in px is the fix.
2. **`b3ntb0x.enhance` AND `bend_d` ARE BOTH CHROMA-GAIN KNOBS, wearing other
   names.** `:310-313` computes `neighborAvg = (v(x−dx) + v(x+dx))·0.5` where one
   `dx` is **exactly 90° of subcarrier phase**, so writing active video as
   `v(φ) = Y + A·cos(φ−ψ)` the two neighbours are `Y ∓ A·sin(φ−ψ)` and
   **`neighborAvg = Y` exactly**. `vc − neighborAvg` is therefore the PURE CHROMA
   CARRIER. DERIVED: `enhance = 0` → saturation ×1.0; `0.5` → **×2.0**; `1.0` →
   **×3.0**, with luma untouched. The docs call it an edge sharpener (`:814`) and
   it acts a **seventh of a pixel** wide. `bend_d` (`:356-357`) is the same
   operation at ×0.8 — and because it runs AFTER `+ uBias` (`:317`), on a flat
   grey field with `bias = +0.5` it adds `0.8 × 0.5 = +0.40 V of pure DC`, a
   brightness shift with no ripple involved.
3. **`bentbox`'s HUE DIAL SPANS EXACTLY ONE FULL TURN, so BOTH ENDS EQUAL THE
   CENTRE.** `bentbox.ts:324`: `ang = (uChromaPhase + phaseNoise) * TWO_PI` with
   `chroma_phase ∈ [−1, 1]`. DERIVED: `0.25` → 90°; **`0.5` → 180°, the actual
   maximum hue shift**; **`±1.0` → ±360° → `cos = 1.0`, `sin ≈ −3.07e−10`, i.e.
   bit-identical to 0.** The knob's two extremes are the same colour as its
   centre detent. ⚠ **And b3ntb0x's identically-labelled `hue` tops out at
   `0.9π = 162°` and never wraps** (`b3ntb0x-dsp.ts:330`), so **180° is
   unreachable there and reachable at half-travel here.** Two controls, one
   label, opposite geometry — the single sharpest argument for specifying the
   family together.
4. **`bentbox`'s DELAY NULL IS AT THE DIAL MIDPOINT, NOT AT ITS DEFAULT.**
   `bentbox.ts:352`: `fract(sampleUv.y + uFeedbackDelay*0.04 − 0.02)`. DERIVED:
   default `0` → **−0.02 = −4.8 of the 240 lines**; `0.5` → **exactly 0**, the
   true null; `1.0` → +4.8 lines. Total travel is **4 % of picture height**,
   while `docs:527` promises *"sliding between line-level and **field-level**
   recursion"* — field-level is off by ~25×.

**⚠ THE `noUserControl` CASE THIS COHORT WAS WAITING FOR — and it resolves the
audit's own open question.** Both defs declare `mirrorXGate` / `mirrorYGate` as
`0..1 linear` params that are **never uniforms** — they exist only to be
edge-detected on the CPU (`b3ntb0x.ts:954, 957`; `bentbox.ts:610, 613`), and
`b3ntb0x.ts:834-835` says so: *"Read for edge detection, not as a continuous
control."* `bentbox.ts:411-415` calls them **"Hidden — no card knob."**

**There is no filter.** `module-face-lint.test.ts:301-331` loops
`for (const p of def.params ?? [])` with no skip-list, and `ModuleFace` has no
`hidden` field — §17.6 established that and it is unchanged. **`def.noUserControl`
IS the answer, it landed in #1732, and these four params are its textbook case**:
`writer: 'cv-port'` is checkable against `mirror_x_gate` / `mirror_y_gate` in both
directions, and the `why` is already written in the source. ⚠ **It costs ZERO
attest** (`HASH_TRANSPARENT_PROPS`, §20.1). **Adopt it here and `backdraft`'s
item 2 is retired by precedent rather than by argument.**

⚠ **AND THE SAME SHAPE IS ON THE VISIBLE HALF.** `mirrorX`/`mirrorY` ARE user
controls, are reduced to `>= 0.5 ? 1.0 : 0.0` in the shader
(`b3ntb0x.ts:1035-1036`; `bentbox.ts:659-660`), and are declared `curve:
'linear'` — so they fail `looksLikeToggle` and **a def-driven face paints two
continuous rotaries over a two-state value.** The cards render them as BUTTONS.
This is the cloudseed precedent verbatim (§20.3's inverse defect). Correcting the
`curve` is a `params` edit → **real-GPU re-attest** (§20.1). Price it separately.

**⚠ THE OPTIONS PRICE (§20.3): ZERO. Neither def uses `curve: 'discrete'` at
all.** All 22 and all 16 params are `linear`. So the *only* param-shape edit
either module wants is the four `mirrorX/Y` curves above — cheap to describe,
owner-machine to land.

**GLYPH: `'none'` for both.** Each declares exactly one output,
`{ id: 'out', type: 'video' }` (`b3ntb0x.ts:759-761`; `bentbox.ts:464-468`), so
`primaryAudioOutPortId` is null and §16.2 applies unchanged. Assert
`hasVideoSurface` is what paints the tile.

**⚠ STOP 2 — the card-only inventory, complete:**

- **The ⛶ OUTPUT menu and its four actions** → this is the `fullViewBody` body.
- **`b3ntb0x`'s "reduced precision (no float FBO)" BADGE**
  (`B3ntb0xCard.svelte:324-326` ← `videoEngine.read?.(id,'isFloat')` ←
  `b3ntb0x.ts:1093`). ⚠ **A card-only quantity with NO port and NO param**, so
  `FaceReadoutValue` is structurally blind to it — the `cvBuddy` shape. It is a
  real capability signal (the 8192-texture-cap case below), so decide: move it
  into the extension body, or lose it.
- **The corner RESIZE HANDLE**, writing `node.data.width/height` raw
  (`B3ntb0xCard.svelte:225-244`; `BentboxCard.svelte:251-270`).
  ⚠ `node.data.fullFrame` is **Y.Doc-synced on purpose** — *"so a wall-of-TVs
  layout survives reload + is shareable"* (`BentboxCard.svelte:114-116`).
- **The per-frame engine→store reflect of `mirrorX/Y`**
  (`B3ntb0xCard.svelte:196-205`; `BentboxCard.svelte:224-234`), a raw write
  outside undo so a GATE edge updates the buttons. ⚠ **This is §17.2's defect
  verbatim** — the card-unmount class (#1531/#1574/#1583, #1723) — and it is
  already dead for anyone who has not docked the module. **A face PR neither
  causes nor cures it; the fix is a NODE-keyed registry either way.**
- **`BentboxCard.svelte:304-320` hand-writes its 15 input `PortDescriptor`s
  instead of `portsFromDef`**, while its outputs use `portsFromDef` (`:321`) and
  b3ntb0x derives both. They agree today and nothing enforces it. **A face
  regenerates them from the def — expect the jack labels to change.**

**⚠ THE LABEL TRAP, and it is a four-way one.** `bentbox`'s param id is
`wavefold`, its label is **`Solarize`**, its CV port is `wavefold_cv`, and the
card's jack prints **`SOLAR`** — four strings for one control, deliberately
(`bentbox.ts:478-482`). And `card-def-debt.ts:86` already ledgers b3ntb0x's
`burst_starve.label` / `chroma_leak.label`: the card prints `"Burst Strv"` /
`"Chroma Lk"`, **the def says `"Burst Starve"` / `"Chroma Leak"`, and the dock
renders the DEF's label** (§15.12). **Plan the band width for the longer strings
and expect a user-visible rename** — that is the #1714 lesson, pre-paid.

**⚠ DEFECTS TO FILE (do not fold into the face PR):**

1. **b3ntb0x's DECODE pass binds a sampler it never reads.** `uEncode` is
   declared (`:391`), its location cached (`:894`) and `fboEncode.texture` bound
   to TEXTURE1 every frame (`:1005-1007`) — and **`DECODE_FRAG` never samples
   it** (all four `texture()` calls read `uBend`). Two comments assert the
   opposite (`:379-382`, `:371-373`). ⚠ **And the "no dead control" guard
   (`b3ntb0x.test.ts:501-550`) is keyed on PARAM uniforms only, so a dead
   SAMPLER slips through** — a gate that is structurally unable to see the thing
   next to the thing it checks.
2. **Three `docs` sentences contradicted by the code:** b3ntb0x's *"sign picks
   fold polarity"* on `bend_a` (`:821` — the fold is driven by `abs(a)`; the only
   sign term is a ±0.05 V DC nudge the `clamp(vc, −0.6, 1.4)` at `:365` swallows
   at high magnitude); `bend_c` documented bipolar `(-1–1)` and made unipolar by
   `abs()` at `:345` and `:528`, so −0.7 and +0.7 are bit-identical; and
   bentbox's *"higher overdrives into white smear"* on `master_gain` (`:531`) —
   DERIVED, at `master_gain = 2` pure white comes out at **0.996825**, BELOW its
   input, while darks are lifted 18 %.
3. **A declared MIN that is a bit-exact NO-OP rather than an extreme.**
   `bentbox.master_gain = 0.0` makes the mix weight at `:343` exactly
   `0.1 × 0 = 0`, so `mix(yiq.x, X, 0)` **discards the whole composite stage** —
   dragging Gain to zero gives the CLEANEST image the module can produce. #1758's
   sample-AT-the-declared-value rule found this.
4. **An undocumented always-on 240-line decimation.** `bentbox.ts:284-285` snaps
   to `LINES = 240` in a **768-row** FBO, so **68.75 % of incoming vertical
   detail is discarded before any knob acts**. The explanation says *"resampled
   to a 240-line raster"* without saying the FBO is 768. ⚠ b3ntb0x does NOT do
   this — its 240 is a mask over a full-768 picture — which is another reason the
   two cannot share one spec sentence.
5. **With nothing patched, every bentbox control is bit-exactly inert**
   (`:266-273` returns the idle field BEFORE the mirror fold and every stage),
   while b3ntb0x deliberately feeds black through the FULL pipeline so its
   sync/CRT/geometry controls still act (`b3ntb0x.ts:790`). **Opposite
   unpatched behaviour, same family** — a face's hint text must not be shared.
6. **A capability cliff worth a readout.** `b3ntb0x.ts:101-105` sizes the
   oversampled FBO as `min(round(baseWidth)·8, maxTexSize)`. At 4:3 that is
   **8192 — exactly the very common cap, fitting by zero margin**; at 16:9
   (`1366`) it wants 10928, so **an 8192-cap GPU silently gets 5.997× instead of
   8×** while the shader's `dx` stays inlined at `1/(1024·8)`. That is what the
   `isFloat` badge is gesturing at, and it is why the badge should survive.

**⚠ ROSTER ASYMMETRIES — these two are NOT symmetrically registered, so do not
copy one PR's checklist onto the other:** `modules-card-map.test.ts:38` lists
**bentbox only**; `card-def-debt.ts:86` lists **b3ntb0x only**;
`webgl-heavy-globs.ts:92` and `modules.spec.ts:69` `HEAVY_RENDER` list
**b3ntb0x only**; `per-module-per-port-behavioral.spec.ts` gives bentbox a
NARROW timing exemption (`:358`) and b3ntb0x a WHOLE-MODULE one (`:375`). Both
sit in `EXEMPT_FROM_VRT` + `ALLOWED_PERMANENT_EXEMPT`
(`vrt-exemptions.ts:673-681, :1026`) as *"animated … defeats deterministic
capture"*, and both are omitted from `vrt-aspect-16x9.spec.ts:95`. **Both have
a FREEZE SEAM already** — `__b3ntb0xFreezeTimeSec` (`b3ntb0x.spec.ts:111-114`)
and `__bentboxFreezeTime` (`bentbox.spec.ts:37-40`) — **so the face VRT scenes
have a determinism hook to use, unlike `spirographs` (Q23).**
**Neither is in `_face-fixtures.ts`, `push-card-config.ts`, or
`module-manifest.ts` DESCRIPTIONS** (§20.5 — the video fallback covers the last).

**RISK: MEDIUM-HIGH, and it is the highest in this cohort.** It is a
platform-adoption PR wearing a face. **Recommended split, mirroring §17.1's:
land the `fullViewBody` extension + the output surface FIRST, with
`video-fullscreen.spec.ts:88` and `video-full-frame.spec.ts:101` re-pointed at
the FACE rather than the card and passing; THEN the two faces on top.** Authoring
a face first produces a module whose output cannot be opened.

**MEASURE BEFORE RANKING:** `tbc`'s displacement at exactly 1.0 and 0.0;
`enhance` at 0 / 0.5 / 1.0 as a saturation multiplier; `bentbox.chroma_phase` at
exactly ±1.0 against 0.0 (bit-identity is the claim); `feedback_delay` at exactly
0.5; and `master_gain` at exactly 0.0.

### Q25 · `mandelbulb` — the ONE video module whose glyph RESOLVES, and it resolves to a tap that CANNOT SEE ITS SUBJECT

**Merit: YES — and it is here for the FINDING, the way Q18 `destroy` was.** 13
params, 10 `cv` inputs, 2 outputs. Mid-sized. What puts it in the cohort is that
it is the **only module in the 47-strong video pool with a `type: 'audio'`
output**, so it is the only one where §16.2's *"a video def must declare
`glyph: 'none'`"* rule does **not** apply mechanically — and following the
apparent licence would ship a dead glyph that no gate can catch.

**THE FINDING, and it is the sharpest thing in this cohort.** Confirmed against
the code, twice:

```ts
// mandelbulb.ts:363-373
outputs: [
  { id: 'video_out', type: 'mono-video' },
  { id: 'audio_out', type: 'audio' },     // :372
],
```
and independently in the frozen projection — `contract-lock.txt:1649`,
`mandelbulb out audio_out audio`. So `primaryAudioOutPortId` returns
**`'audio_out'`**, `glyphBinding` returns `{ kind: 'live-audio', portId:
'audio_out' }`, and `ModuleShell.svelte:301` builds
`createShellGlyphTap(engine, id, 'audio_out')`.

**And that tap can never read it.** The tap resolves its source via
`audio.getOutputNode(nodeId, portId)` (`shell-glyph-live.ts:323`) on the AUDIO
engine, and `AudioEngine.getOutputNode` (`audio/engine.ts:849-854`) searches only
`this.nodes`. `PatchEngine.addNode` routes by `node.domain`
(`audio/engine.ts:1096-1098`), so **a `domain: 'video'` node never enters the
audio engine's map at all.** The cross-domain path for a video module's audio is
`VideoEngine.getAudioSource`, which the glyph tap does not call. Net:
`getOutputNode` → `null` → `detach()` → `getSamples()` `undefined`,
`getLevel()` **`0`, forever** (`shell-glyph-live.ts:324-327, 352-362`).

> **A `meter` or `waveform` glyph here binds to a REAL, LIVE signal through a
> seam that is structurally unable to see it.** It is not `{kind:'static'}`, so
> `module-face-lint`'s dead-glyph clause is green. It is not `'none'`, so §16.2's
> rule reads as satisfied. **Every def-reading gate in the fleet passes, and the
> glyph is a permanent flatline.** That is #1748's class in its purest form — a
> live-looking readout of nothing, which is worse than a static one **because
> nothing can notice**.

⚠ **THE SPEC'S INSTRUCTION IS THEREFORE: declare `glyph: 'none'` HERE TOO, and
assert WHY.** Not because `primaryAudioOutPortId` is null — it isn't — but
because the tap cannot reach a video-domain node. **Assert both halves**
(`primaryAudioOutPortId(mandelbulbDef) === 'audio_out'` AND the tap detaching),
because the first is what makes this module look different from every other
video candidate and the second is why it isn't. If a live audio glyph is wanted
later, **the tap needs a video-domain fallback first** — a platform PR, filed
separately.

**THE READOUT STORY — three quantities, and two of them are dead knob travel.**

1. **THE `detail` DIAL IS DEAD OVER 55.6 % OF ITS TRAVEL, AND THE SHIPPED
   DEFAULT SITS INSIDE THE DEAD BAND.** The shader hard-caps the march:
   `const int MAX_ITER = 16;` … `if (float(i) >= uIterations) break;`
   (`FRAG_SRC:132, 143`), while `detail` is declared `4..30 discrete` with default
   **20**. DERIVED-BY-READING:

   | `detail` | GLSL iterations | `video_out` |
   |---|---|---|
   | 4 … 15 | 4 … 15 | distinct |
   | 16 | 16 | distinct |
   | **20 (the default)** | **16** | **bit-identical to 16** |
   | 30 (declared max) | **16** | **bit-identical to 16** |

   **15 of the 27 discrete positions produce the same frame.** Through the CV
   bridge (`clamp(knob + cv·halfSpan, min, max)`, halfSpan 13) the picture only
   moves for `cv < −0.346` — **67.3 % of `detail_cv`'s swing is bit-exactly inert
   on `video_out`.** ⚠ And it is not simply dead: **the AUDIO path has no cap**
   (`mandelbulb-de.ts:51` loops to `iters` ≤ 30), so `detail` 16→30 changes
   `audio_out` and the on-card SLICE readout while leaving the picture untouched.
   **One dial, two consumers, different laws** — the readout writes itself.
2. **THE BOTTOM OF THE `zoom` DIAL RENDERS A BLANK SKY FRAME, and the blank
   region includes the declared MINIMUM.** `eyeDist = 2.2 / clamp(zoom, 0.3, 3)`
   (`:87-90`); the march breaks at `t > MAX_DIST = 6.0`; for `|p| > BAILOUT =
   2.5` the DE loop breaks at iteration 0 so `DE(eye) = 0.5·ln(r)·r`.
   DERIVED-BY-READING:

   | `zoom` | eye | first step | vs 6.0 | result |
   |---|---|---|---|---|
   | **0.30 (declared MIN)** | 7.333 | **7.305** | > | **100 % sky, no bulb** |
   | 0.34 | 6.471 | 6.041 | > | sky |
   | 0.35 | 6.286 | 5.778 | < | hits |
   | 1.0 (default) | 2.2 | — | — | normal |
   | 3.0 (max) | 0.733 | — | — | eye INSIDE the ~1.2 bounding radius |

   Threshold `0.5·r·ln r = 6` ⟹ `r ≈ 6.44` ⟹ **`zoom ≤ 0.3416` is always a
   blank frame** — 5.6 % of the LOG dial, and **the bottom 25.6 % of a ±1
   `zoom_cv` swing parks the module on an empty frame.** #1758's rule found this:
   sampled AT the declared minimum, not near it.
3. **`AUTOSPIN` IS A BOOLEAN WHOSE RATE IS A CONSTANT.**
   `AUTOSPIN_RATE = 0.25` rad/s (`:293`) → **one revolution every 25.13 s**. The
   control is on/off; nothing states the period.

**⚠ THE COST WARNING A FACE MUST NOT MAKE WORSE.** `mbSampleSlice` is
`MB_SLICE_SIZE(256)` rays × `MB_RAY_STEPS(64)` = **16 384 `jsDistanceEstimate`
calls per recompute**, each looping `iters` times over an
`acos`/`atan2`/`pow`/`sin`/`cos` body → **327 680 trig iterations at `detail`
= 20, 491 520 at 30 — ON THE MAIN THREAD** (`:536`). It fires from `setParam`
whenever a `SLICE_PARAM` moves (`:697`), and the CV bridge calls `setParam`
**once per frame**, so CV on `slice_y` at 60 fps is ~20 M trig iterations/second
on the main thread. **The card runs the identical scan a SECOND time** in
`drawSliceReadout` (`MandelbulbCard.svelte:174`) with its own independent cache
— so a slice move costs **2×** today. ⚠ **A face that re-derives the waveform for
a readout makes it 3×.** Read `handle.read('slice')` instead; the module already
exposes `'eyeDist'`, `'screenOn'`, `'autospin'`, `'slice'` (`:703-709`).

**⚠ STOP 2 — and the inventory note that sent me here is WRONG.**
`face-migration-inventory.ts:232` says *"the orbit drag over the preview is a 2-D
camera gesture → the `xy` cell"*. **There is no orbit drag.** The pointer
handlers write `slice_y` + `slice_ry` (`MandelbulbCard.svelte:136-137`) and only
fire when SLICE is ON (`:140`); `rotate_x`/`rotate_y` are knob-only. **A face
built to that note would wire the wrong pair of params to its XY pad.** This is
§16.3's correction-to-the-brief lesson applying to an inventory NOTE — verify an
I/O description against the code before designing against it.

The rest of the card: a 200×150 preview canvas; a card-painted **"SCREEN OFF"
flat panel** (`:94-104, 195`); three toggle BUTTONS (SPIN / SCRN / SLICE,
`:303-325`); a draggable yellow select box writing `slice_y`/`slice_ry`; and a
**second canvas** (`mandelbulb-slice-readout`) drawing the recomputed wavetable.
No `VideoCanvasContextMenu`, no fullscreen (§20.2). `node.data` is untouched
beyond `data?.node`. **The knobs ARE motorized** (`readLive`, `:334, 347`).

**⚠ THE OPTIONS PRICE (§20.3): FOUR multi-state-or-boolean discretes, none with
`options[]`** — `detail` (4..30, an integer COUNT, so a knob is right), and
`autospin` / `screen_on` / `slice`, which are `0..1 discrete` and therefore
already resolve to `toggle` by `looksLikeToggle`. **So the options price here is
ZERO** and the card's three buttons map onto three toggles cleanly. That is the
cheapest param-shape story in the video half of the cohort.

**⚠ DEFECTS TO FILE:**

1. **The two doc entries for `detail` disagree with each other.**
   `docs.inputs.detail_cv` (`:400`) promises *"linear CV sweeps the fractal
   iteration budget over 4..30 … Higher = sharper surface detail"*;
   `docs.controls.detail` (`:416`) admits *"(shader caps the loop at 16)"*. The
   shipped default of 20 sits in the dead band. #1701 class.
2. **The file header states a resolution the code contradicts.** `:41` says
   *"video_out … (4:3, 640×480)"* and `:111-112` say `// 320` / `// 240`.
   `VIDEO_RES` is 1024×768 so `RENDER_W/RENDER_H` are **512/384**. The `docs:`
   field is correct; only the header is stale — ⚠ **but `SURF_EPS = 0.0016
   "(~half-pixel at the reduced res)"` (`:135`) is calibrated to the STALE
   numbers**, so this one is not purely cosmetic.
3. **`mandelbulb` does not resize with the OUTPUT aspect switch.**
   `RENDER_W/RENDER_H` are module-level `const`s computed at import
   (`:110-112`), the FBO is **unmanaged** (`createRenderTarget`, `:303-337`, not
   `ctx.createFbo()`), and `surface` declares **no `resize()`**. Under the 16:9
   switch the FBO stays 512×384 and the copy stretches to 1366×768 — a **1.333×
   horizontal distortion of the bulb**. `uResolution` is hard-set too (`:650`).
   Compare `grainsOfVision`, which does implement `resize()` (`:872-886`).
4. **The "byte-identical" claim between the GLSL and TS distance estimators is
   false.** `mandelbulb-de.ts:18-21` states it; the GLSL caps at 16 and the TS
   does not. **At the shipped default the picture and the audio run different
   iteration counts.**
5. **A display that drops what the port emits — two instances.** The yellow
   select box derives from **committed** `node.params`
   (`MandelbulbCard.svelte:124-125`) while the waveform beside it derives from
   `liveParam()`, **engine-resolved and CV-inclusive** (`:162-169`) — so under
   `slice_y_cv` **the waveform moves and the box does not.** And both caches
   quantize at `round(v·1000)`, so **any slice-param change below 0.0005 is
   silently dropped.** #1744 class, twice.
6. **`hue = 1.0` (declared max) is bit-identical to `hue = 0.0`** —
   `((1 % 1) + 1) % 1 = 0` (`:635`).

**⚠ AND `audio_out` IS A FIXED-PITCH C4 DRONE WITH A LARGE DC BIAS.** The
oscillator's `voct = pitch + tune/12 + fine/1200` (`mandelbulb-osc.ts:169`), the
def declares **no pitch input and no tune/fine params**, and the worklet's only
input is `oscSilence`, a `ConstantSourceNode` at `offset.value = 0` (`:571-574`)
— so **freq ≡ 261.626 Hz, always.** And `sample = 2·occupancy − 1`
(`mandelbulb-slice.ts:155`) with occupancy typically well under 0.5 and a
complete miss reading **exactly −1.0**, with **no DC blocker anywhere**. **A
level readout would be dominated by DC, not by the sound.** It is also silent
by default (`slice` defaults 0, `:594`). ⚠ **If a readout prints anything about
this jack, print the PITCH (a constant) and say so — not an RMS.**

**RISK: MEDIUM.** The glyph decision is the whole risk and this spec resolves it.
`mandelbulb` is in `HEAVY_RENDER` (`modules.spec.ts:69`), has a VRT live-surface
mask with the slice readout **deliberately unmasked**
(`vrt-live-surfaces.ts:346-375`), is whole-module exempt in
`per-module-per-port-behavioral.spec.ts:715-717`, and `'mandelbulb.audio_out'`
carries its own per-port exemption (`_per-module-per-port-shared.ts:288-294`).
Absent from `_face-fixtures.ts`, `push-card-config.ts`, `vrt-scenes.ts` and
`DESCRIPTIONS` (§20.5). In `STRICT_DOCS` (`:354`).

**MEASURE BEFORE RANKING:** the glyph tap — **prove `getLevel()` is 0 and stays
0**, in a permanent negative-control leg, because that is the entire claim;
`detail` at exactly 16 vs 20 vs 30 for bit-identity on `video_out` AND
non-identity on `audio_out`; `zoom` at exactly 0.30 and 0.35; `hue` at exactly
1.0 vs 0.0.

---

### Q26 · `grainsOfVision` — the first video `noUserControl` adopter, and a face that stops rendering stops the DSP

**Merit: YES.** 20 params, 19 inputs (17 `paramTarget` CV + 2 video), 2 video
outputs, and a genuine three-block chain — grain swarm → video feedback → video
reverb — that is a natural three-page face rather than one list of twenty
faders. §17.6 named it explicitly as one of the four modules blocked on
`ModuleFace` having no way to say "this param has no user control"; **#1732
landed that, so this entry is the one that closes §17.9's item 2 in practice.**

**THE `noUserControl` CASE.** `freeze` (`:588`) is a determinism hook declared
`0..1 linear`, described in §17.6 as *explicitly "like BACKDRAFT"*. It is
`writer: 'internal'`-shaped, its `why` is already in the source, and **declaring
it costs ZERO attest** (§20.1). ⚠ **But it is not the only one that needs
attention:** `fb_dry` (`:579`) and `rev_dry` (`:584`) are **genuine user
booleans declared `curve: 'linear'`**, so they fail `looksLikeToggle` and paint
continuous rotaries over two-state values (§20.3's inverse defect). **Those two
want a `curve` correction, not `noUserControl` — and that is the expensive edit
(§20.1).** Sort them deliberately.

**THE READOUT STORY — four numbers, all products of two or more dials.**

1. **`density` IS CELLS DOWN, AND THE GRAIN COUNT IS ASPECT-DEPENDENT.**
   `cells = clamp(round(density), 2, 48)` (`:148-151`); in the shader
   `q = vUv * vec2(uAspect, 1.0)` with `cellSize = 1/uCells` (`:356-357`), so
   cells down = `density` and cells across = `density · aspect`.
   **DERIVED-BY-READING: total grains = `density² · aspect`.**

   | `density` | aspect | grains |
   |---|---|---|
   | 2 (min) | 4:3 | ≈ **5** |
   | **14 (default)** | 4:3 | ≈ **261** |
   | 48 (max) | 4:3 | **3072** |
   | 14 | **16:9** | ≈ **349 (+33 %)** |

   The docs (`:619`) say *"grains across the frame"*. **The dial says 14; the
   picture has 261 grains, and the number changes when the rack's aspect
   changes.**
2. **THE GRAIN OVERLAP FACTOR, AND THE POINT WHERE THE 3×3 GATHER STARTS
   TRUNCATING.** Radius in cell units is `grain_size · (0.6 + 0.8·rSize)`
   (`:383`), gathered over `GOV_GRAIN_RADIUS = 1` i.e. ±1 cell (`:81, 363-364`).
   A grain whose centre is more than ~1.5 cells away can never be gathered, so
   truncation begins at **`grain_size · 1.4 > 1.5` ⟹ `grain_size > 1.071`** —
   **BELOW the shipped default of 1.1.** So at the factory setting the largest
   hashed grains are already hard-clipped at the neighbourhood boundary, and
   **the top 62 % of the SIZE dial buys truncation rather than blend.** There is
   no `GOV_GRAIN_RADIUS` control and no readout.
3. **`rate` IS AN 8-VALUED INTEGER FRAME COUNT WITH A 117 ms CEILING.**
   `delayFrames = clamp(round(rate·(ring−1)), 0, ring−1)` with
   `GOV_HISTORY_FRAMES = 8` (`:79, 156`). DERIVED-BY-READING: `0 … 0.0714` → **0
   frames** (a hard no-op); `0.15` (the default) → `round(1.05)` = **1 frame =
   16.7 ms**; `0.5` → 4; `1.0` → **7 frames = 116.7 ms**. ⚠ **And in the
   no-op zone `time_spray` is BIT-EXACTLY INERT** — `tfrac` is hard-zeroed when
   `!pastEnabled` (`:406, 732, 755`), which neither the card nor
   `docs.controls.time_spray` (`:622`) mentions.
4. **TRAIL LENGTH IS THE PRODUCT OF TWO DIALS, and the reverb tail a third.**
   Feedback per-frame gain `g = feedback · fb_decay` (`:197-199`, GLSL `:435`).
   DERIVED: defaults `0.4 × 0.9 = 0.36` → −60 dB in 6.8 frames = **113 ms**;
   `0.7 × 0.9` → 249 ms; **`0.98 × 1.0` → 342 frames = 5.70 s.** Reverb:
   per-frame gain is `rev_decay` alone → `0.85` (default) = **709 ms**, `0.99` =
   **11.5 s**. And `rev_size` maps to a blur `spread = 0.5 + 7.5·rev_size`
   TEXELS at HALF resolution, so ±4 taps reach **±4 output px at `rev_size = 0`
   — the room never fully closes — ±34 px at the default, ±64 px at max.**

⚠ **`spray` DRIVES TWO THINGS AT DIFFERENT SCALES, and the ratio is ~12×.**
Grain-centre jitter is `±spray·0.5·cellSize` (`:372`, `GOV_SPRAY_SCALE`); source
read scatter is `±spray·0.32` in **UV** (`:394`, `GOV_SRC_SPRAY_SCALE`). At the
default `spray = 0.35`, `density = 14`, 1024×768: **±9.6 px of position jitter
against ±115 px of read scatter.** The docs mention both and never the ratio.

**⚠⚠ THE PLATFORM WARNING THIS ENTRY EXISTS TO CARRY, and it applies to EVERY
video face, not just this one.** `blitOutputToDrawingBuffer` is also the
engine's **"someone is watching"** signal — it calls `this.markWatched(nodeId)`
(`video/engine.ts:1444`). `grainsOfVision` deliberately relies on it:
`:535-538` says it is **NOT `pullExempt`**, so *"the feedback/reverb/history
state simply pauses when nothing observes the output."*

> **A faceplate that paints this module without calling
> `blitOutputToDrawingBuffer` (or `blitOutputPortToDrawingBuffer`) FREEZES its
> history ring, its feedback and its reverb tail.** The shell's
> `VideoTileThumb` does call it — but it is `IntersectionObserver`-gated and
> throttled to `VIDEO_THUMB_FPS`, so **a scrolled-off or collapsed face is a
> stalled DSP.** ⚠ **This is the card-unmount-kills-node-resources class
> (#1531/#1574/#1583) reaching a module through its RENDER path rather than its
> lifecycle.** Establish the real behaviour before ranking anything, and put a
> permanent leg on it.

**⚠ STOP 2.** `GrainsOfVisionCard.svelte` mounts one 176×132 preview, four
section headers, and a card-local `formatValue={formatComp}` reading
`GOV_COMPOSITE_MODES` (`:40-42, 161`). **No buttons, no `<select>`, no
fullscreen, no `node.data`.** But two gaps:

- **`grains` (the second video output) has NO on-card view at all** — the card
  blits only `surface.texture` = `out` (`:60`). The engine HAS
  `blitOutputPortToDrawingBuffer(nodeId, portId)` for exactly this
  (`video/engine.ts:1470-1482`) and the card does not use it. **A face is the
  first surface that could show it** — a merit argument, as with `spirographs`'
  `mono_out`/`overlap`.
- ⚠ **ALL 19 CARD CONTROLS ARE DEAD TO CV** — no `readLive` prop is passed
  (`:154-165`), so a CV-driven `density`/`rate`/`feedback` moves the picture
  while every fader stays parked. **A face binding `readLive` FIXES a live
  defect**, and it is the same shape as the three raw-write ledger entries Q28
  pays. Cite it as merit.

**⚠ THE OPTIONS PRICE:** one multi-state discrete, `composite` (0..4), with **no
`options[]`** — the mode names live in a separate exported `GOV_COMPOSITE_MODES`
(`:100`) that only the CARD reads. A def-driven face gets a bare `0..4` knob.
This is a genuine named enum, so `options[]` is the right fix — **and it costs a
real-GPU re-attest** (§20.1). ⚠ **And `composite`'s CV is `mode: 'discrete'`, so
per §20.4 a cable at 0 V selects mode 2, not the dial's 1** — and it is inert
while `in_b` is unpatched (`:737`), which the docs do state (`:611`).

**⚠ DEFECTS TO FILE:** the three `linear` booleans and the card comment that
**claims they render as 2-step toggles and does not** (`:102-103` vs `pcurve()`
`:34-36` and `Fader.fracToValue` `:245-257`) — so anything in `[0, 0.5)` looks
set and does nothing; `docs` stating `0/1` for those three (`:630, 635, 638`);
`docs`' *"grains across the frame"* (`:619`); the **reverb tail FREEZING rather
than decaying when bypassed** (`revFront = revNext` sits inside the non-dry
branch only, `:860`, so toggling `rev_dry` on parks the tail and toggling it off
replays it at full strength); `rev_size = 0` not closing the room; and the
undocumented half-resolution render (`GOV_RENDER_SCALE = 0.5`, `:77` —
`mandelbulb` states its own half-res in `docs`, this one does not).

**RISK: MEDIUM.** No VRT baseline is pinned — `vrt-exemptions.ts:456-462`,
*"VRT baseline pending owner look-approval (look-affecting WebGL granular
video)"*, canvas masked at `:263-265`, in `ALLOWED_PERMANENT_EXEMPT` (`:1017`).
⚠ **So this face's baselines are an owner-look gate, not a mechanical capture.**
It is one of only three candidates with a hand-written `DESCRIPTIONS` entry
(`module-manifest.ts:146-147`), has a per-port DRIVER already
(`_per-port-drivers.ts:1138-1160`, ACIDWARP → `in_a`), and is absent from
`_face-fixtures.ts` / `push-card-config.ts` / `vrt-scenes.ts`. In `STRICT_DOCS`
(`:437`).

**MEASURE BEFORE RANKING:** the `markWatched` claim FIRST (does a collapsed or
scrolled-off face stall the ring?); the grain count at `density = 14` against
the docs' "14"; `grain_size` at exactly 1.071; `rate` at exactly 0.0714 and
0.0715 for the `time_spray` null; and `rev_dry` toggled on and off for the
frozen tail.

### Q27 · `quadralogical` — a face would render 21 controls over a module where 12 of them are bit-exactly dead at spawn

**Merit: YES.** 21 params, 19 inputs (15 `paramTarget` CV + 4 `video`), **2
`video` outputs that are genuinely different pictures**. A four-source video
mixer you steer with **one joystick**: the pad position becomes four bilinear
corner weights, power-sharpened outside a drawn diamond so the stick snaps to a
crisp two-input region, and each of four "edges" runs its own blend effect on
its own pair. **The verb is *drag*** — the whole module is one gesture and the
eight-way FX menus are the preset behind it.

**THE READOUT STORY — four facts, and the first one is what the face is FOR.**

1. **⚠ AT THE SHIPPED SPAWN STATE, 12 OF THE 21 PARAMS ARE BIT-EXACTLY DEAD —
   AND THE CARD HIDES THEM WHILE A DEF-DRIVEN FACE WOULD SHOW ALL OF THEM.**
   All four `edge{N}_fx` default to **0 = DISSOLVE**, and DISSOLVE is the
   `blend2` default case (`quadralogical.ts:321-322`, GLSL `:531`):
   `return mix(a, b, t)` — it reads **neither `amount` nor `param` nor `key` nor
   `invert`**. So `edge1..4_amount`, `edge1..4_param`, `keyR`, `keyG`, `keyB`
   and `invert` — **twelve params and eleven CV ports** — do nothing at all until
   a selector is changed. The card knows: it hides each `amount`/`param` fader
   per-effect from the `EFFECTS` table (`:370-379`, `null` ⇒ hidden) and gates
   the whole key row on `edgeFx.some(fx => fx === 4)`. **A face that ranks the
   def renders twelve inert cells on a fresh module.**
   ⚠ **This is the tidyVco control-loss lesson inverted** — not a control that
   cannot reach the user, but a user reaching twelve controls that cannot reach
   the picture. **`face.pages` plus DERIVED readouts naming which edges are live
   is the answer, and it is the strongest single argument for a face here.**
2. **⚠ THE FOUR "EDGES" ARE AN INDEX CYCLE, NOT THE PAD'S GEOMETRY — AND TWO OF
   THE FOUR CAN NEVER BE ISOLATED.** `EDGE_PAIRS` (`:156-161`) is
   `[0,1] [1,2] [2,3] [3,0]` = TL↔TR, **TR↔BL**, BL↔BR, **BR↔TL** — two of them
   are DIAGONALS of the pad. Isolating edge *e* needs `mass_e = 1` with the other
   three at zero; for edge2 that forces the pad to a CORNER, not an edge.
   DERIVED-BY-READING (margin 0.5, K 3):

   | pad position | weights | masses e1..e4 | ratios e1..e4 |
   |---|---|---|---|
   | `(0, +1)` top | `[.5, .5, 0, 0]` | `1.0, 0.5, 0, 0.5` | `.5, 0, .5(guard), 1` |
   | `(+1, 0)` right | `[0, .5, 0, .5]` | `0.5, 0.5, 0.5, 0.5` | `1, 0, 1, 0` |
   | `(0,0)` centre | `[.25]×4` | `0.5, 0.5, 0.5, 0.5` | `0.5 ×4` |

   **There is no joystick position at which exactly one effect slot is active.**
   The card labels them `EDGE 1–2 / 2–3 / 3–4 / 4–1` and nothing says "2–3" and
   "4–1" are unreachable alone. The module header (`:46-50`) explains the
   index-cycle choice; the docs and the card do not.
3. **⚠ "DRAG TO A CORNER FOR A CLEAN CUT TO ONE INPUT" IS TRUE FOR 2 OF 8
   EFFECTS.** `docs.explanation` (`:729`) and the header (`:47-50`) assert it
   unconditionally. At corner in1, edge4's ratio is 1 with `a = c4, b = c1`, and
   half the corner picture comes from that edge. DERIVED-BY-READING, feeding
   `t = 1` into each branch at the shipped `amount = 1, param = 0.1`: DISSOLVE ✓,
   IRIS ✓ (bar a feathered fringe), and **ADD / MULTIPLY / WIPE / CHROMA / LUMA /
   DIFF all fail** — WIPE most severely, showing **`c4`, the wrong input
   entirely**.
4. **THE RGB KEY THRESHOLDS ARE HARD CONSTANTS NO DIAL STATES, AND THE TWO "Thr"
   DIALS HAVE DIFFERENT SENSITIVITIES.** GLSL `:505-514` / TS `:286-297`:
   `satGate = smoothstep(0.04, 0.18, saturation)` — **a pixel below 0.04
   saturation is never keyed at all**, and neither number is in any doc string.
   `tol = clamp(amount) * 0.5` — **CHROMA's full 0..1 travel maps to a hue
   tolerance of only 0..0.5**, and `hueDistance` is already capped at 0.5, so
   `Thr = 0.5` already covers a quarter-turn. **LUMA (`:298-305`) does NOT halve
   `tol` or `sft`** — so two dials sharing a label and a range have different
   effective sensitivities. ⚠ And LUMA uses **Rec.601** while `warrensvisions`
   uses **Rec.709**: two video modules, two luma standards.

**⚠ CV REACH, DERIVED — and the fix pattern is already in this file.**
`cv-bridge-map.ts:87-93` + `cv-scale.ts:70-73`: `effective = clamp(knob +
cv·(max−min)/2, min, max)` with `knob` = the STORED value:

| param | default | CV ±1 reaches | can it reach its max? |
|---|---|---|---|
| `pos_x` / `pos_y` | 0, **`center: 'default'`** | **−1 … +1** | ✓ **full** |
| `blend_sharp` | 3 | 0 … **7** | ✗ never 8 |
| `edge{N}_amount` ×4 | **1 (= max)** | **0.5 … 1** | pinned for every `cv ≥ 0` |
| `keyG` | **1 (= max)** | **0.5 … 1** | pinned |
| `edge{N}_param` ×4 | 0.1 | 0 … **0.6** | ✗ never 1 |
| `keyR` / `keyB` | 0 | 0 … **0.5** | ✗ |

**Five inputs ship AT their param's declared MAXIMUM** — #1773's shape (§20.4).
⚠ **And `pos_x`/`pos_y` show the cure: they declare `cvScale: { center:
'default' }` (`:678-679`), which ignores the stored value so a cable spans the
full range from any knob position.** That is the option-3 fix #1773 left open,
already shipping in this very def on two of its fifteen CV inputs. **Say so in
the spec — it is the cheapest thing a builder could learn here.**

**`preview` IS A DIFFERENT PICTURE, AND IT HAS NO ON-CARD VIEW.** Not a copy of
`out`: `out` is the joystick-weighted per-edge composite and is the canonical
surface, while `preview` has its **own shader and its own FBO**
(`PREVIEW_FRAG_SRC`, `:575-611`, drawn as pass 2 at `:910-921`) — **a 2×2 tile of
the four NORMALLED raw inputs** (in1 TL, in2 TR, in3 BL, in4 BR) with a
0.004-wide `0.12`-grey separator cross, for cueing sources independently of the
mix. ⚠ **The card calls `blitOutputToDrawingBuffer(id)` (`:346`), the
primary-surface-only variant, so `preview` is invisible in the shipped UI** —
`blitOutputPortToDrawingBuffer` exists (`engine.ts:1477`, VIDEOCUBE uses it) and
this card does not. Same inverted merit argument as Q23's `mono_out`/`overlap`
and Q26's `grains`: **a face is the first surface that could show it.**

**⚠ STOP 2 — AND THE INVENTORY ALREADY NAMES THE JOB.**
`face-migration-inventory.ts:275` carries it verbatim: *"the quad mix pad is a
HAND-CLONE → the shared `xy` cell (#1509 §3)"*. Confirmed: the pad is a raw
`<div class="pad nodrag">` with hand-written `onpointerdown/move/up/cancel`
(`QuadralogicalCard.svelte:152-169`) writing straight to
`patch.nodes[id].params`, and **it does not import
`$lib/ui/controls/XyPad.svelte`** — only `VideocubeCard` and `BackdraftCard` do.
The card's own header says so (`:5-6`, *"cloned from JoystickCard"*) and `:21`
gives the reason: *"The pad stays a `<div>` … so midi-learn-wiring-audit exempts
it."* ⚠ **Migrate the pad onto the shared `xy` cell FIRST, as its own reviewed
change, then rank `pos_x`/`pos_y` as `face.xyPads`.** Authoring the face over a
hand-clone reproduces the `wavesculpt` failure (§4).

**The rest of the card, and it is the largest card-only surface in this cohort:**

- **A bespoke 2-axis right-click context menu portalled to `<body>`**
  (`:552-673`, `quadralogical-axis-menu`) carrying **far more than MIDI learn**:
  `assign-x`/`-y` and conditional `forget-x`/`-y` showing `CH n · CC n`; a
  **Control Surface** section (`:578-598`, *"Send X to {name}"* / *"Remove X
  from…"*, naming the bindings `QUAD X` / `QUAD Y`); and an **Electra Control
  three-level cascade** (`:603-671`) — `electra-{x|y}-{id}` → `-rows` →
  `-row-{1..6}` → `-row-{r}-knob-{1..6}`, i.e. **72 buttons per Electra per
  axis**, plus a `-clear`. ⚠ **No `ParamCellKind` carries any of this.** Name its
  fate explicitly; it is the single biggest STOP-2 item in the cohort after
  Q24's ⛶ OUTPUT menu.
- **Four `<select class="fx-select">`** (`:484-494`) iterating `TRANSITIONS`.
- **Live chrome with no param behind it**: four corner labels, an h/v crosshair,
  a **live diamond** sized from `diamond_margin` (`:438-442`), and a **live dot
  whose colour is `INPUT_COLORS[argmax(weights)]`** (`:115-117`) — a five-way
  readout of position AND which input dominates. **That is a `FaceReadoutValue`
  waiting to be written.**
- A numeric readout (`:453-458`) plus `X·MIDI` / `Y·MIDI` badges.

**⚠ NO `VideoCanvasContextMenu`, no fullscreen, no present, no `<select>` for
anything but FX, no file input, no `node.data` at all** (`data?.node` and a pass
to `<ModuleTitle>` only). **Every quantity this card displays is a param or a
pure function of params** — the best `FaceReadoutValue` surface in the cohort.

**⚠ THE OPTIONS PRICE (§20.3), and it is the pool's second largest.** Four
`edge{N}_fx`, `0..7 discrete`, **no `options[]`** (`:707, 710, 713, 716`) — so
four bare rotaries printing `0.00 … 7.00`. **The vocabulary exists in THREE
places and none of them is the declaration:** `TRANSITIONS` (`:354-363` —
DISSOLVE · ADD · MULTIPLY · WIPE · CHROMA · LUMA · DIFF · IRIS), `EFFECTS`
(`:370-379` — the per-effect labels for the two shared faders: `Amt`/`Angle`/
`Thr`/`Radius` and `Soft`/`Feather`), and the shader switch (`:491-532`). Eight
options > `SEGMENTED_MAX_OPTIONS` = 6, so the fix yields a **`selector`** — ⚠ **at
the DOCK tier only.** ⚠ **It is a `params` edit on a VIDEO def, so it costs an
owner-machine real-GPU re-attest** (§20.1). **Price it as its own PR.**

**⚠ THE `noUserControl` / CURVE CASE, and both halves are worse than the
declaration suggests.** `freeze` (`:725`) and `invert` (`:723`) are both
`0..1 **linear**` and both are thresholded booleans (`:868`, `:294`/`:303`), so a
def-driven face paints two continuous rotaries over bits.

- **`freeze` is an UNDECLARED `noUserControl`.** Zero hits in the card, no port
  targets it, `:724` says *"a hidden VRT/determinism toggle — no card control"*,
  and `vrt-quadralogical.spec.ts:126` sets `n.params.freeze = 1`. ⚠ **The
  precedent is exact and already shipping**: `backdraft.ts:3198` declares the
  identical situation as `{ param: 'freeze', writer: 'internal', why: … }`.
  **Adopt it — FREE (§20.1).**
- **⚠ `invert` IS COMPLETELY UNREACHABLE FROM THE SHIPPED UI** — no card
  control, no CV port, and no `noUserControl`. A declared, persisted,
  live-in-shader param a player can set only by hand-editing the patch. **It is
  a real control with no way to reach it, which is the opposite defect and needs
  the opposite fix** (give it a cell). Same for **`diamond_margin` and
  `blend_sharp`, which have no card control either** — the card only READS them
  (`:107-108`) to draw the diamond and tint the dot. **A face makes three
  currently-unreachable controls reachable. That is merit, not risk.**

**GLYPH: `'none'`.** Both outputs are `type: 'video'` (`:697-700`), so
`primaryAudioOutPortId` is null and §16.2 applies. ⚠ **Say WHICH picture the
thumb shows: the canonical surface, i.e. `out` — never `preview`.**

**⚠ A FACE PAYS A LEDGERED RAW-WRITE DEBT, as in Q28.**
`raw-write-ledger.ts:255-259` carries
`'ui/modules/QuadralogicalCard.svelte': { keys: ['pos_x','pos_y'], kind: 'debt',
why: 'joystick drag — see JoystickCard' }`. The shared `<XyPad>` writes through
the param pipeline, so **the consolidation pays the ledger entry** — cite it.

**⚠ DEFECTS TO FILE (do not fold in):**

1. **WIPE IS POLARITY-REVERSED.** `blend2` case 3 (`:275-285`) / GLSL
   `:497-504`: `edge = (t − 0.5)·(1 + 2·soft)`, `m = smoothstep(edge−soft,
   edge+soft, proj)`, `return mix(a, b, m)` — `m = 1` gives `b`, and `m = 1`
   where `proj > edge`, so as `t` rises **`b`'s territory SHRINKS.**
   DERIVED-BY-READING at the shipped defaults (`amount = 1` ⇒ horizontal,
   `param = 0.1` ⇒ `soft = 0.05`, `proj ∈ [−0.5, 0.5]`): **`t = 0` ⇒ `edge =
   −0.55` ⇒ m = 1 everywhere ⇒ PURE `b`** (should be `a`); **`t = 1` ⇒ `edge =
   +0.55` ⇒ m = 0 everywhere ⇒ PURE `a`** (should be `b`). Every other effect,
   IRIS included, runs `a → b`. ⚠ **TS and GLSL AGREE, so the parity tests pass,
   and `quadralogical.test.ts:390-396` EXCLUDES WIPE from the endpoint check on
   purpose** (*"WIPE/IRIS are positional … so they're excluded here"*) while its
   own WIPE test only asserts left ≠ right at `t = 0.5`, which passes either way.
   **A gate that filters its subject before checking it — CLAUDE.md's exact
   shape — and this is the live bug behind that filter.**
2. **`docs.explanation`'s corner-cut claim is false for 6 of 8 effects** (above).
3. **`invert` unreachable; `diamond_margin` / `blend_sharp` CV-only** (above).
4. **`diamond_margin` at EXACTLY its declared max 1.0 is GLSL-UNDEFINED.**
   `quadWeights` uses `smoothstep(margin, 1.0, m)`; the TS special-cases
   `edge0 === edge1` and returns `x < edge0 ? 0 : 1` (`:143-147`), while
   **GLSL `smoothstep(1.0, 1.0, m)` divides by `edge1 − edge0 = 0`, which the
   GLSL spec declares UNDEFINED.** So at that one value the card's dot tint (TS)
   and the rendered composite (GLSL) are not guaranteed to agree. #1758's
   sample-AT-the-value rule found it.
5. **The card header states a wrong constant**: `:5-6` says `PAD_PX = 440`; the
   constant is **380** (`:120-121`). The dot's 34 px is right.
6. **Card CSS width disagrees with the rack tile.** `.quadralogical-card { width:
   480px }` (`:677`) against `rack-sizes.ts:201` `{ size: '3u', hp: 4 }` = a
   720 px tile, and `_module-card.css:150-151` wins on specificity. ⚠ **This is
   precisely the failure `WarrensvisionsCard.svelte:258-265` documents** (*"that
   disagreement is what made the knob grid hang 67.7 CSS px past the right
   edge"*), and content here is already ~700 px wide.
7. **The `x:`/`y:` readout is rounded to 2 dp** (`:132-134`) while the pad writes
   full float precision — a CV-driven `0.4764564431012892` displays as `0.48`.
   #1744's class, mild.
8. **`card-def-debt.ts:154` already ledgers label debt**:
   `['keyB.label', 'keyG.label', 'keyR.label']` — the card prints `R`/`G`/`B`,
   the def says `Key R`/`Key G`/`Key B`, **and the dock renders the DEF's label**
   (§15.12). Plan the band width and expect a visible rename.

**⚠ THE SUITE GREP — and this one is NOT cheap.** `quadralogical` appears in ~41
files. The ones that matter: **THREE separate `vrt-exemptions.ts` entries** —
a per-selector canvas mask (`:302-304`), `EXEMPT_FROM_VRT` for solo spawn
(`:815-820`), and a bare roster line at `:1031`; **`vrt-quadralogical.spec.ts`
with EIGHT committed composite baselines**, one per effect, which sets
`edge1_fx` per scene and `freeze = 1` (`:105`, `:126`) — ⚠ **a face changing the
card retires nothing there (the scenes read the port FBOs), but confirm it**;
whole-module exempt in `per-module-per-port-behavioral.spec.ts:377-387`;
`webgl-heavy-globs.ts:99`; `raw-write-ledger.ts:255`; `card-def-debt.ts:154`;
`rack-sizes.ts:201`; `STRICT_DOCS:339`; a full design doc at
`docs/design/quadralogical.md`; **and a dedicated 256-line
`quadralogical-assign.spec.ts` covering the axis-assign menu** — the surface the
face has to preserve or replace. **ABSENT from `_face-fixtures.ts`,
`push-card-config.ts`, `_per-port-drivers.ts` and `module-manifest.ts`
DESCRIPTIONS** (the video fallback covers the last, §20.5), **so promoting it
retires no fixture.**

**RISK: MEDIUM-HIGH.** The XY-pad consolidation must land first; the axis-assign
menu needs a decided fate; the options fix is an owner-machine step. **Nothing
here is a platform gap** — unlike Q24, every piece exists today.

**MEASURE BEFORE RANKING:** WIPE at exactly `t = 0` and `t = 1` (the defect claim
is the whole of §1's file); the twelve dead params at spawn (perturb each and
confirm the frame is bit-identical — a NEGATIVE CONTROL in both directions); the
five `default === max` CV inputs at exactly `cv = 0` and `cv = +1`;
`diamond_margin` at exactly 1.0 in TS **and** on a real GPU.

### Q28 · `moog921a` + `moog921b` — ONE oscillator split across TWO defs, as a PAIR

**Merit: YES, and the pairing argument is STRONGER than Q12's.** `moog914` +
`moog907a` were paired because their merit ARGUMENT was identical. These two are
paired because they are **one signal path** — `moog921a` is a CV-only driver
(3 params, 2 `cv` outputs, **no audio anywhere**), `moog921b` is the sound-making
slave (5 params, 4 audio outputs) **with no 1V/oct jack of its own**. Pitch
arrives on `freq_bus`. The repo says so in three places:

- `moog921a.ts:9-10` — *"A CV PROCESSOR, not a sound source … CV-ONLY: NO audio
  inputs, NO audio outputs."*
- `packages/dsp/src/moog921a.ts:7-8` — *"the 921A is meaningless without ≥1
  slaved 921B."*
- §9 of this file already named the batch and the constraint:
  *"`moog921b` reads `freq_bus`/`width_bus` from a `moog921a` … **so the pair's
  faces have to agree**."*

**THE READOUT STORY — the number that matters is a PRODUCT OF BOTH FACES, and
neither can print it alone.** `moog921a`'s `frequency` is a dimensionless −1..1
dial whose volts-per-unit is set by a DIFFERENT control, `freqRange`
(`rangeOctSpan`, `packages/dsp/src/moog921a.ts:66-72`: position 1 = **1 octave**
of span, position 2 = **6**). The slaved 921B then computes
`261.626 · 2^(freqVolts + range + fine/12)`.

DERIVED-BY-READING (921B at `range = 0, fine = 0`, no `freq_cv`):

| `frequency` dial | `freqRange` | `freq_bus` | the 921B sings at |
|---|---|---|---|
| 0.00 | either | 0 V | **261.63 Hz** (C4) |
| **+0.50** | **1 = SEMI** | +0.5 V | **370.00 Hz** (F♯4) |
| **+0.50** | **2 = OCT** | +3.0 V | **2 093.01 Hz** (C7) |
| +1.00 | 2 = OCT | +6.0 V | **16 744.06 Hz** |
| −1.00 | 2 = OCT | −6.0 V | **4.09 Hz** |

**The same dial position is F♯4 or C7 — a factor of 5.66 (2^2.5) — depending on a
two-state switch.** The faces print `0.50` and `SEMI`/`OCT`. They print **no Hz,
no octave count and no volts.** The SEMI compass is 130.81 … 523.25 Hz; the OCT
compass is 4.09 … 16 744.06 Hz. **Neither number exists anywhere in the shipped
UI.** That is the strongest single face-merit fact in the audio half of the pool.

**And the POT and the JACK have different units on the same panel.** `freqCv` is
added AFTER the `× octSpan` multiply (`packages/dsp/src/moog921a.ts:138`),
deliberately. So `freq_cv = +1 V` raises pitch **exactly one octave in BOTH
range positions**, while the pot's own +1.0 raises it one octave (SEMI) or SIX
(OCT). **A 6× gain difference between two controls sitting side by side, stated
nowhere.**

**⚠ THE DEFECT THAT ONLY A PAIRED SPEC CAN SEE — and it is the reason to pair
them.** The 921A emits `width_bus = clamp(knob + cv, 0, 1)`
(`packages/dsp/src/moog921a.ts:143-146`); the 921B reads it as
`width = widthBus < 0.02 ? 0.5 : widthBus` (`packages/dsp/src/moog921b.ts:170`).
**Checked EXACTLY at the declared value, per #1758:**

| 921A `width` | `width_bus` | 921B duty |
|---|---|---|
| **0.000** (declared MIN) | 0.0 | **50 %** — a square, **identical to no cable at all** |
| 0.0199 | 0.0199 | **50 %** |
| 0.0201 | 0.0201 | **2.01 %** |
| 1.000 (declared MAX) | 1.0 | 98 % (clamped, `:196`) |

So sweeping WIDTH 0 → 1 gives **50 %, 50 %, … a 48-point DISCONTINUOUS DROP to
2 %, a smooth rise to 98 %, then dead travel.** The declared MINIMUM produces the
MIDPOINT result. `moog921a.ts:91` says only *"0 to 1 (0.5 = a 50 % square)"* —
true at 0.5, false at 0. `moog921b.ts:91` says *"Unpatched it normals to 0.5"* —
and never says a fully-patched cable at 0 counts as unpatched.
⚠ **The unit test never touches the region** (`moog921b.test.ts:177-195` samples
only 0.8 and 0.2). Same shape on `width_cv`: at the default `width = 0.5`, a CV
of exactly −0.5 lands on the same duty as zero CV, so a ±1 LFO is
**non-monotonic**.

**⚠ THE GLYPHS DIFFER, AND THAT IS THE POINT OF PAIRING.**
`moog921a`'s outputs are `cv` · `cv` → `primaryAudioOutPortId` is **null** → it
must declare `glyph: 'none'` (§15.9). `moog921b`'s are four `audio` →
`primaryAudioOutPortId` is **`'sine'`**, so a `meter`/`waveform` glyph BINDS —
to SINE, which is one of four taps. **Say which, in the spec** (the `noise`
finding, #1692, and Q20's warning verbatim). Two halves of one instrument with
two different correct answers is exactly what authoring them separately would
get wrong.

**⚠ A FACE HERE PAYS THREE LEDGERED RAW-WRITE DEBTS AUTOMATICALLY, and that is a
citable merit argument.** `raw-write-ledger.ts:230-244` carries
`moog921Vco.sync`, `moog921a.freqRange` and `moog921b.syncMode`, all three
*"panel switch write — user gesture, should be undoable + synced"*. As shipped,
**the RANGE switch — the control that decides whether +0.5 means F♯4 or C7 — is
not undoable and does not sync to collaborators.** A def-driven face writes
through the param pipeline and pays all three.

**⚠ THE PARAM-SHAPE PRICE (§20.3), and it has an ORDERING CONSTRAINT:**

- `moog921a.freqRange` is `1..2 discrete` with **no `options[]`**
  (`moog921a.ts:68`) — a genuine two-name enum (`SEMI` / `OCT`) whose vocabulary
  exists **only in `Moog921aCard.svelte:47-50`**. A def-driven face prints
  `1.00`. This one genuinely wants `options[]`.
- `moog921b.range` is `-5..5 discrete` with no `options[]` — **11 unnamed octave
  detents**, i.e. an integer count, so a knob with `units: 'oct'` (which it
  already has) is right and `options[]` is not.
- ⚠ **But `moog921b.range` is a THREE-WAY disagreement and a face CHANGES SHIPPED
  BEHAVIOUR.** The def says `discrete`; `card-def-debt.ts:55` already ledgers
  `['range.curve']` because *"the LEGACY `Knob.svelte` has no discrete branch at
  all"*; and **the DSP never rounds either** — `smRange.step(rangeRaw)`
  (`packages/dsp/src/moog921b.ts:182`) smooths it as a FLOAT into the exponent,
  so `range = 2.5` is a valid non-octave offset today. A def-driven face WOULD
  round (`knob-conic-model.ts:71`, `Fader.svelte:254` both implement discrete),
  making a currently-reachable value unreachable. **That is a face-spec decision
  to take deliberately, not an implementation detail** — and it is a live
  instance of CLAUDE.md's *"before 'fixing' a declaration to satisfy a gate,
  check the consumer reads it"*.
- `moog921Vco.sync` and `moog921b.syncMode` are **3-state comparators declared
  `curve: 'linear'`** (`moog-vco-dsp.ts:48-52`: `v ≥ 0.5 → hard`, `v ≤ −0.5 →
  soft`, else off). **50 % of the dial's travel is one flat state**, and a
  def-driven face paints a continuous rotary printing `0.00`. ⚠ They cannot take
  `options[]` until the `curve` changes to `discrete` (`graph/types.ts:358-360`
  rejects a def carrying both) — **so sequence the two edits.**

**⚠ THE CARD IS DOING LOAD-BEARING WORK A FACE WILL DROP.** All four bank
members wrap `ui/modules/moog/MoogPanel.svelte`, which carries **two
accessibility fixes**: `:171-177` re-points Knob/Fader/switch captions from the
washed-out `--text-dim` to the engraved `--text` (the panel's own comment
measures the bad case at *"only ~5:1 over the lightest brushed-metal streak"* and
calls the alternative *"a BUG (every Moog card)"*), and `:196-199` re-points the
patch-panel subtree tokens — the fix for the *"921b has no labels"* report.
**A def-driven face inherits neither.** State what replaces them. This is #1762's
class (affordances the legacy card has and the face does not) with a named,
measured instance.

**⚠ ART / VRT COVERAGE IS INVERTED ACROSS THE BANK — check before you touch
anything:**

| module | ART baseline | VRT |
|---|---|---|
| `moog921a` | **NO** (`art/setup/profile-coverage.ts:95`, `ART_BACKLOG`) | **YES — `STRICT_VRT_MODULES`** (`vrt-exemptions.ts:1172`) |
| `moog921b` | **NO** (`profile-coverage.ts:96`) | **YES — `STRICT_VRT_MODULES`** (`:1173`) |
| `moog921Vco` | **YES — 4 outputs pinned** (`fingerprints.generated.json:5281/5345/5409/5473`) | NO (`EXEMPT_FROM_VRT:882`) |
| `moogCp3` | **YES — 1 output** (`:4641`) | NO (`EXEMPT_FROM_VRT:890`) |

**So a face for the PAIR moves a committed STRICT VRT baseline** and must ride a
PR carrying the `vrt-update.yml` dispatch — the two with ART have no VRT and vice
versa. ⚠ Do not assume the Q12 precedent: `moog914`/`moog907a` were the other
shape.

**⚠ ALSO KNOWN, ledgered, not a code defect:**
`per-module-per-port-behavioral.spec.ts:1400` records that `moog921b.freq_bus`
DOES respond (*"perturbed cent jitters ±13–24 Hz vs control ±1 Hz, mean
264→255"*) but the symmetric-sweep metric collapses, so the port is exempted with
a named re-enable condition. **The pitch bus is currently unasserted at the e2e
layer** — which is precisely the port this spec's headline readout depends on.

**DEFECTS TO FILE (not fold in):** both defs' `docs` claim the oscillator tracks
*"roughly 1 Hz to 40 kHz"* (`moog921b.ts:7, :86`; `module-manifest.ts:224`; and
`moog921-vco.ts:95` / `:212` for the monolith). The clamp is
`hi = min(40000, sr·0.49)` and `lo = 0.01` (`moog-vco-dsp.ts:68-70`) — so
**23 520 Hz at 48 kHz, 21 609 Hz at 44.1 kHz**, and the floor is 0.01 Hz, not 1.
40 kHz needs `sr ≥ 81 633`. The DSP lib's own header states it correctly, so the
def copied it wrong. #1701 class, in `STRICT_DOCS` prose.

**THE SIBLING, NOT FOLDED IN: `moog921Vco`** is the same instrument packed into
one module (`moog921-vco.ts:95`) and shares the `MoogVco` core, but its dials are
different (`octave`+`tune` vs the pair's `frequency`+`freqRange`+`range`+`fine`),
it has a `pitch` jack the 921B does not, and it is the ART-pinned member.
**Spec it as a third member sharing this layout vocabulary — do not fold it into
the pair.** Its own unprintables: the 12-octave knob compass (4.09 Hz …
16.74 kHz); `linFmAmount` 0..1 meaning **±2000 Hz** (`moog921-vco.ts:155`) and
shipping at 0, so the `lin_fm` jack is a no-op as delivered; and `width_cv`
having ~2.08× the authority the duty range can absorb, so a full-scale LFO spends
**68 % of every cycle pinned** at 2 % or 98 %.

**⚠ AND `moogCp3` IS NOT IN THIS BANK.** It shares the prefix and the panel, not
the instrument: a 4→1 console mixer with a phase-inverted bus, a pre-fader 1→3
multiple and two DC rails, `category: utilities`, no shared DSP lib. §14 already
said *"do not pull it out of the bank on [its 7 outputs] alone"* — the correction
is that it was never IN it. Its own merit is a GAIN LAW, not a frequency compass,
and it is real: `cp3ChannelGain(k) = clamp(k,0,1) · 2`
(`moog-cp3-dsp.ts:30, 37-40`), so **unity is at the dial's MIDPOINT and all five
knobs ship at their MAX** — four channels at defaults sum to **8.0, i.e. +18.06 dB
over full scale**. And `ch4` and `attenuator4` are declared IDENTICALLY
(`0..1 linear default 1`) with DIFFERENT laws (the attenuator clamps at ×1 and
never boosts), so a def-driven face renders two controls that look the same and
are not. ⚠ Only 2 of its 5 audio outputs carry independent information —
`multiple_one/two/three` are bit-identical copies of `in1` and `out_negative` is
the exact negation of `out_positive`; ART pins only `out_positive`. **Spec it
separately, and note its `card:` override (`moog-cp3.ts:53`) keeps it out of
`INTERACTIVE_DOC_MODULES`.**

⚠ **A `moogCp3` DEFECT TO FILE FIRST:** its co-located `docs` state the sum as
`… CH4·(in4 + ext4·ATT4)` (`moog-cp3.ts:98`), the code is
`(in4 + ext4) * atten4` (`moog-cp3-dsp.ts:68`), and `module-manifest.ts:469` has
it RIGHT. **Two authored doc sources disagree with each other and one disagrees
with the code by a factor of 2** (DERIVED: `in4=1, ext4=0, att4=0.5, ch4=0.5` →
docs say 1.000, code gives 0.500). Repeated in `docs.controls.attenuator4`
(`:111`) and the file header (`:20-21`). #1701 class, in a `STRICT_DOCS` module.

### Q29 · `fourplexer` — §4's and §14's REJECTION, WITHDRAWN, and the card's two numbers disagree with each other

**Merit: YES. §14's *"§9's rejections STAND, re-checked against the output
ordering"* is WITHDRAWN, and the withdrawal is the third of its kind
(`ninelives` §10.6, `analogLogicMaths` §11.1).** The pattern is identical every
time: the rejection was taken on the CONTROL SURFACE (4 knobs, 4 outputs,
nothing to rank) and the merit is in what the controls **cannot say**.

4 params, 8 inputs (4 `cv` + 4 `gate`), 4 `cv` outputs. Each output carries
whichever of the four inputs its selector points at, and each has a gate whose
rising edge advances that selector.

**THE READOUT STORY — and the first fact is a SHIPPED DISPLAY DEFECT, not a
missing readout.**

1. **⚠ THE CARD'S KNOB AND ITS OWN READOUT PRINT DIFFERENT NUMBERS FOR THE SAME
   PARAM AT THE SAME INSTANT.** `FourPlexerCard.svelte:70` feeds the `Knob`
   `value={paramVal('sel'+o)}` — the **0-based** index — so it prints `1.00`;
   six lines below, `:77-79` renders `← IN {selectedInput(o)}` where
   `selectedInput(o) = paramVal('sel'+o) + 1` (`:54-56`) — so it prints
   `← IN 2`. **Same param, same instant, two numbers.** That is #1744's class
   verbatim (an LED showing 12/3, 24/5 against its own jack), and here both
   numbers are on the same card, 40 pixels apart.
   ⚠ **And the def is 0-based while EVERY doc string is 1-based**:
   `docs.controls.sel1` says *"Which input (1–4)"*, `docs.inputs.gate1` says
   *"(1→2→3→4→1, wrapping)"* (`fourplexer.ts:92, 104`), `module-manifest.ts:514`
   agrees. **Nothing in the def bridges the off-by-one**, so a def-driven face
   prints `0.00`–`3.00` under prose that says 1–4.
2. **UNDER A FAST GATE, BOTH NUMBERS DISAGREE WITH THE JACK.** The truth of what
   each output emits is `this.cur[o]` **inside the worklet**
   (`packages/dsp/src/fourplexer.ts:67, 154`). The param only catches up via
   `announce()` → `postMessage` → a **50 ms leading+trailing throttle**
   (`FOURPLEXER_COMMIT_INTERVAL_MS = 50`, `fourplexer-select.ts:70, 102-154`) →
   `livePatch` → reconciler → `setParam`. **Both the readout AND the knob's
   `readLive` are downstream of that 20 Hz throttle.** DERIVED-BY-READING:

   | gate rate | selector advances/s | complete 4-cycles/s | store writes/s |
   |---|---|---|---|
   | 8 Hz (musical) | 8 | 2 | ≤ 20 — display correct |
   | **440 Hz** | 440 | **110** | **≤ 20** |
   | **2 kHz** | 2000 | **500** | **≤ 20** |

   At 440 Hz the displayed index is a 20 Hz sample of a 110 Hz cycle; at 2 kHz
   it is effectively a random index. **"Which input is this jack carrying right
   now" is the module's central question and no surface answers it.** That is
   the readout.
3. **THE "HARD SWITCH, NEVER A BLEND" IS FALSE ABOVE 250 Hz.**
   `DECLICK_S = 0.004` (`packages/dsp/src/fourplexer.ts:44`),
   `fadeStep = (1/sampleRate)/DECLICK_S`, `fade[o] = 0` on every change (`:91`),
   and the output is a **linear blend** while `fade < 1` (`:158`). @48 kHz the
   fade needs **192 samples = 4.000 ms**; if the next advance arrives after `P`
   samples the fade is `min(1, P/192)`. DERIVED-BY-READING:

   | gate | P | fade at next edge | output |
   |---|---|---|---|
   | 8 Hz | 6000 | 1 | clean discrete select ✔ |
   | **250 Hz** | 192 | **1.0000** | the exact boundary |
   | **440 Hz** | 109 | **0.5677** | `0.4323·prev + 0.5677·cur` — **43 % of the previous input, permanently** |
   | **2 kHz** | 24 | **0.125** | **87.5 % of the WRONG input, forever** |

   `docs.explanation` (`:86`) says *"it is a hard switch, **never a blend or
   mix**"* and the DSP header (`:17-18`) says *"still effectively
   instant/discrete"*. Both are true at musical rates and false at the audio
   rates `fourplexer-select.ts:51-52` itself measures and names. ⚠ **No test,
   comment or exemption anywhere in the repo mentions the fade failing to
   settle** — file it.

**⚠ THE OPTIONS PRICE (§20.3): FOUR multi-state discretes, and this is the
cleanest `options[]` case in the entire pool.** `sel1..sel4` are `0..3 discrete`
with **no `options[]`**, so `paramCellKind` falls through to **`'knob'`** — four
identical anonymous rotaries printing `0.00 … 3.00` with nothing naming what
each index selects. The `← IN N` translation exists **only in the card**
(`FourPlexerCard.svelte:54-56, 77-79`). Four states ≤ `SEGMENTED_MAX_OPTIONS`, so
`options[]` yields a **`segmented`** cell — ⚠ **at the DOCK tier only**; the lane
and plate still render a knob (§20.3, third arm). **`fourplexer` is AUDIO-domain,
so `options[]` here costs a `docs:accept` and NO re-attest** — unlike every video
candidate in this cohort. **That makes it the cheapest full fix in the batch.**

**⚠ THE GLYPH IS `'none'`, AND THE REASON IS ITSELF A FINDING.** All four outputs
are `type: 'cv'` (`fourplexer.ts:70-73`), so `primaryAudioOutPortId` is **null**
— **despite the module being explicitly designed to route AUDIO**. The def says
why (`:11-18`): the patch cascade had no cable type accepting both audio and cv
sources, so `cv` was chosen as the lowest common denominator. **The jack colour
understates what the port accepts, and the glyph resolver's `live-audio`
short-circuit cannot fire on a module whose main job is carrying audio.**
Declare `'none'` and say so.

**TRIGGER HANDLING: CORRECT BY CONSTRUCTION, and stating that is the point.**
Edge detection is a per-sample compare inside the worklet
(`packages/dsp/src/fourplexer.ts:132-147`) with per-output `prevGate` state; the
main thread receives **messages, not samples**, so the `createEdgeCounter`
double-count class (#1703/#1725) **does not apply**. ⚠ **But the threshold is
`g > 0.5` (strictly greater), against `GATE_HI = 0.5` compared `>=` everywhere
else** (`audio/gate-trigger.ts:24`; `moog911-eg-dsp.ts:29`;
`trigger-delay-dsp.ts:79`). **A gate whose high level is exactly 0.5 is
bit-exactly inert on `fourplexer` and fires on `moog911` and `moog911a`.** That
is #1758's finding — *four gates were green because each sampled 0.49 and 0.51* —
reproduced in a fifth place. ⚠ **And `trigger-delay-dsp.ts:22` asserts in a
comment that `fourplexer` MATCHES the 0.5 convention. It does not.** A
cross-file claim that is false is worse than no claim.

**⚠ ONE MORE DEFECT: `fourplexerClampSelector` WRAPS RATHER THAN CLAMPING.**
`((Math.round(idx) % 4) + 4) % 4` (`fourplexer-select.ts:25`), applied in
`setParam` (`fourplexer.ts:182`) and the factory seed (`:126`). **A saved,
CV-driven or automated value of 4 becomes 0 and 5 becomes 1** — it does not pin
to the declared max 3, and no `docs` sentence says the param wraps.

**⚠ STOP 2:** the card mounts four `Knob`s, a `PatchPanel`, one static hint line
and the four `← IN N` readouts. No `<select>`, no canvas, no meter, no
`node.data` beyond `data.node`. **The only card-only vocabulary is the 1-based
readout — which is the thing that is wrong.** A face replacing it with a DERIVED
readout reading the live selector fixes the disagreement instead of inheriting
it.

**⚠ THE SUITE GREP:** `fourplexer` is in `STRICT_DOCS:153` (explicitly **STATIC**
— the `card:` override at `:53` keeps it out of `INTERACTIVE_DOC_MODULES`,
named as excluded at `interactive-doc-modules.ts:116`), `DESCRIPTIONS:418` with
**12 per-port entries** (`:510-521`), `modules-card-map.test.ts:45`,
`rack-sizes.ts:54`, `face-migration-inventory.ts:215`, and — worth reading before
authoring — **`strict-faces.ts:1025, 1032`, where it is used as the CONTRAST CASE
in the `slewSwitch` faceplate argument**: *"fourplexer's four inputs genuinely
ARE symmetric — it has no LENGTH — so the argument does not transfer."* **That
sentence is still correct and this spec does not contradict it**: the merit here
is not an intrinsic order over the four (there is none — rank by layout, the
`illogic`/`bluebox` answer), it is the three unprintable facts above.
It sits in `EXEMPT_FROM_VRT:860` + `ALLOWED_PERMANENT_EXEMPT:1032` (*"VRT
baseline pending — deterministic card (4 selector knobs, no canvas)"* — so a
face's baselines are a straightforward capture), is whole-module
`EXEMPT_OUTPUT_EMIT` (`per-module-per-port-behavioral.spec.ts:335-337`) and
`PURE_CV_GATE_UTILITY` (`_per-module-per-port-shared.ts:1138`). ⚠ **ART pins
`out1` ONLY** (`art/baselines/fourplexer/out1.{f32,sha}`); out2–4 have no
baseline. **Absent from `_face-fixtures.ts` and `push-card-config.ts`.**
⚠ `e2e/tests/4plexer.spec.ts` has four scenes and **every gate test fires one
pulse at a time, so the audio-rate blend is untested.**

**RISK: LOW.** Audio-only, no canvas, no `node.data`, a deterministic card, and
the cheapest options fix in the cohort. **The work is the readout, not the
layout.**

**MEASURE BEFORE RANKING:** the fade at exactly `P = 192`, and at 109 and 24; a
gate whose high level is **exactly 0.5** on all four inputs (#1758 — sample AT
the value); the store-write rate against the worklet's `cur[o]` at 440 Hz; and
`fourplexerClampSelector(4)`.

---

## 22. VERDICTS RECORDED — additions to §4, §9 and §14

| module | dom | par | verdict |
|---|---|---|---|
| `fourplexer` | A | 4 | **§14's rejection WITHDRAWN → Q29.** The third rejection overturned by reading the OUTPUTS instead of the control count, after `ninelives` and `analogLogicMaths`. |
| `onetonine` | **V** | **1** | **NO FACE ON MERIT — and the outputs-per-param ordering that surfaced it is what proves it.** See §22.2. |
| `colourofmagic` | **V** | 37 | **NOT a merit rejection — a DEFERRAL with named conditions.** See §22.1. |
| `shapedramps` | **V** | 8 | **NO FACE ON MERIT, on the STOP-2 half.** See §22.3. |
| `rasterize` | A | 4 | **NOT a merit rejection — BLOCKED on a registered panel, and it carries the cohort's second-sharpest glyph finding.** See §22.4. |
| `vfpgaRunner` | **V** | 16 | **DEFERRED, and the pool row is misleading.** Its control set is selected at runtime by a loaded `VfpgaSpec` in `node.data` (§16.3's correction), which `FaceReadoutValue` is structurally unable to see — the `cvBuddy` rejection, one level up. `renderLocus: 'worker-experimental'` on top. Re-open only after a `node.data`-reading cell kind exists. |
| `ruttetra` · `mirrorpool` · `outlines` · `freezeframe` · `4plexvid` | **V** | 8–12 | **Next-after, all five.** None is rejected; none made this cohort's seven. `ruttetra` carries a real defect worth filing first (§22.5). |
| `moogCp3` · `moog921Vco` | A | 5 · 6 | **Siblings of Q28, spec'd there, NOT folded into it.** §14's *"a member of the System-55 BANK batch"* is CORRECTED for `moogCp3`: it shares the prefix and the `MoogPanel`, not the instrument. |
| `moog911` · `moog911a` | A | 4 · 3 | **Next-after, and both are stronger than their param counts suggest.** §22.6. |

### 22.1 `colourofmagic` — DEFERRED, with the conditions written down

**The merit is not in doubt** — 37 params, 22 outputs, five colourspace blocks
(RGB / YDbDr / HSV·HSL / YIQ / YCbCr), and genuinely rich unprintables: every
chroma bias dial is in PACKED space with an expansion gain nobody states
(**YDbDr ×2.66667**, YIQ **×1.19176** / **×1.04537**, YCbCr **×1.164384** /
**×1.138393** — of which only the YCbCr luma gain is documented, as *"~1.16×"*),
and `bias_h` is the one honest dial because it alone declares `units: 'deg'`.

**It is deferred because it is a §17.9-shaped multi-PR job, and the reasons are
mechanical:**

1. **22 discrete params, ZERO `options[]`** (§20.3). Four of them fall through to
   `knob`: `preview` (**0..21**, whose 22-label roster lives only in
   `ColourofmagicCard.svelte:106-111`) and `pal_r/g/b` (**0..16777215**, packed
   `0xRRGGBB`). ⚠ `shell-control-kind.ts:57-58` names that case exactly and says
   a `color` cell **must be DECLARED** because *"`1..32 discrete` and
   `0..16777215 discrete` differ only in MAGNITUDE, and no gate reads
   magnitude."* This def declares no `face`, so all three paint as
   **16.7-million-step rotaries**. All of it is a `params` edit → **owner-machine
   re-attest** (§20.1).
2. **`preview` is not a preview.** It is documented as *"which of the 22 outputs
   the on-card preview canvas shows"* (`:567`), but the canonical surface IS the
   preview FBO (`:646-647`) — **so it decides what anything blitting this node
   sees, including a fullscreen view.** It is a global output selector wearing a
   card-local label. File it.
3. **`over_h` is bit-exactly inert** — stored, persisted, and never a uniform
   (there is no `uOverH`; `adjHue` takes no `over` argument, `:174-178`). The
   card renders it as a **non-interactive `<span>WRAP</span>`** (`:399-404`); a
   def-driven face paints an operable toggle that does nothing.
4. **`freeze` has NO WRITER anywhere** and no `noUserControl` declaration, so its
   stated purpose (*"for stable VRT capture"*, `:568`) is unrealized.
5. **Nine committed composite VRT baselines assert the CARD's canvas**
   (`vrt-colourofmagic.spec.ts:110-112` locates `.svelte-flow__node-colourofmagic`
   and asserts `canvas[data-testid="colourofmagic-canvas"]` has count 1). **A
   face replacing that canvas retires those assertions.** It also sits in **both**
   `EXEMPT_FROM_VRT:830` and `ALLOWED_PERMANENT_EXEMPT:1031`, which
   `vrt-exemptions.ts:989-992` requires to stay in sync, and in `HEAVY_RENDER`
   plus the webgl-heavy glob.

**Withdraw the deferral when** (a) a declared `color` `paramCell` exists for the
three packed palette params, (b) `preview` has `options[]` (22 > 6 ⟹ a
`selector`), and (c) the nine composite baselines have a decided fate. Until
then it is four PRs, not one, and it is the same shape §17.9 refused.

⚠ **One live defect to file NOW, independent of any face:** `docs.inputs.in`
reads *"All three blocks read it in parallel."* (`:475`). **There are FIVE**, and
the def's own `explanation` two lines up says FIVE. It is in `STRICT_DOCS`, so it
is what right-click → annotate shows a player. The same stale "8 outs" figure
survives in `per-module-per-port-behavioral.spec.ts:240` and
`vrt-exemptions.ts:828-830` while `colourofmagic.spec.ts:161` asserts **all 22**.

### 22.2 `onetonine` — NO FACE ON MERIT, and the ordering that found it is what condemns it

**The outputs-per-param ordering (§19.1) put it at the top: 1 param, 9 outputs,
ratio 9.0 — the highest in the pool, higher than `ninelives`' 4.5.** And the nine
outputs really are nine DIFFERENT functions, not a fan-out: one loop, one
uniform pair varying by `i` (`onetonine.ts:338-350`), nine FBOs, with the law
`c = (n−1) % 3, r = floor((n−1)/3)` giving each output a distinct sub-rectangle
(`:97-107`) at exactly **3× magnification per axis / 9× area**, aspect preserved.
**So the ratio is honest and the outputs are real. It is still a rejection.**

**Because the one param does not touch any of them.** `showGrid` (`:257`) is read
only by the MONITOR pass (`:360`); the crop loop (`:338-350`) never references
it. **DERIVED-BY-READING: `showGrid` at its declared max and at its declared min
both leave `out1..out9` bit-identical.** So the real ratio is **9 outputs / ZERO
effective params**, and §4's `flipper` verdict applies: *"nothing to rank at
all."* A face here is a title, a glyph, and one knob that provably does nothing.

**And there are two further blockers, either of which alone would be enough:**

- **`node.data` WINS UNCONDITIONALLY over the param.** `gridOn()` (`:321-325`)
  returns `node.data.showGrid` when it is a boolean and only falls back to
  `params.showGrid >= 0.5`. The card sets it on first press
  (`OneToNineCard.svelte:41`). **A param-only face calling
  `setNodeParam(id,'showGrid',…)` is silently ignored** — the `cvBuddy`
  rejection (§14), which *"no re-ordering can overturn."*
- **`showGrid` is a boolean declared `curve: 'linear'`**, so a def-driven face
  paints a continuous rotary over a bit (§20.3's inverse defect).

**⚠ WHAT WOULD CHANGE MY MIND, stated so this is falsifiable:** if `showGrid`
moves out of `node.data` into the param alone AND gains `curve: 'discrete'`, the
module becomes a one-toggle face over nine outputs — still thin, but arguable on
the `noise` bar. **The stronger re-opening is different: the MONITOR is
card-only** — it has NO port (`read('outputTexture:monitor')` at `:395` exposes
it with no declared output), and it is what `surface.texture` points at
(`:329-331`), so the shell's `VideoTileThumb` DOES show it. **If a face ever
wants to print WHICH ninth feeds WHICH jack, that is a real readout** — but the
monitor already paints the digits in the picture, so the face would be
duplicating a display that exists.

⚠ **Two defects to file regardless:** the card's preview does `drawImage(src, 0,
0, canvasEl.width, canvasEl.height)` with **no aspect fit** against a
module-scope `CANVAS_H` computed from the STATIC 4:3 `VIDEO_RES`
(`OneToNineCard.svelte:47-50, 67`), so a 16:9 rack squeezes it horizontally; and
`rack-sizes.ts:194` says *"300×169 (16:9) monitor preview"* while the card
computes **300×225 (4:3)** — off by 56 px. Also worth knowing: **7 of the 9
outputs are never asserted anywhere in e2e** (`onetonine.spec.ts:112-131` checks
only that `out1.sig ≠ out9.sig`).

### 22.3 `shapedramps` — NO FACE ON MERIT, on the STOP-2 half

8 params, 12 inputs, **6 `mono-video` outputs** — and the ratio flatters it. Read
the outputs:

- **`mix1_out` and `mix2_out` are the SAME shader with the SAME uniform
  structure**, differing only in which ports feed them (`:371-384` vs
  `:386-399`, *"byte-for-byte the same seven calls with `mix1_*`→`mix2_*`
  substituted"*). Two identical channels, not two functions.
- **`h_lin` and `v_lin` are inert against all 8 params and all 8 CV jacks by
  construction** (`:337-345` binds only `uAxis`). Documented and intentional —
  and it means **2 of 6 outputs are wholly unmodulatable.**
- **At the shipped defaults `h_out` is BIT-EXACTLY `h_lin`** (`h_shape = 0,
  h_freq = 1, h_phase = 0` ⟹ `t = fract(u) = u` and `mix(vLin, vTri, 0) = t`).
  **So at factory settings the six ports emit only TWO distinct images**, and
  the mixers are black when unpatched.

**And the card adds NOTHING.** `ShapedrampsCard.svelte` is 8 `<Fader>`s and two
static labels — **zero canvases**, independently confirmed by
`vrt-exemptions.ts:67` (*"shapes, shapedramps, vdelay — confirmed 0 canvases
each"*). **There is no card-only affordance to preserve and no picture to
promote**, so both halves of the usual video merit argument are absent.

**⚠ WHAT WOULD CHANGE MY MIND.** The module DOES have real unprintables — the
shape anchors sit at exactly `1/3` and `2/3` while the header comment says
`0.33`/`0.66` (so a knob at exactly 0.33 is 99 % triangle + 1 % linear, not the
pure triangle promised); `h_phase`/`v_phase` at their declared MAX reproduce
their MIN (`fract` wraps, so the dial's endpoints are one image); and
**`h_freq`/`h_phase` and their two CV jacks go BIT-EXACTLY DEAD at `h_shape =
1.0` exactly** (`seg = 2, frac = 1` ⟹ `r = vRad`, which never touches `t`) —
**two of eight knobs and two of eight CV jacks dead at one exact knob position,
with no indication anywhere.** That last one is a genuine #1758-class finding.
**File it. If a `mono-video` glyph kind ever lands so the six ramps can be SEEN,
re-open this on that finding alone.** Today a face would be six invisible
outputs and eight faders.

⚠ **A defect to file now: `v_lin`'s `docs` states its direction BACKWARDS.**
`:264` says *"red channel = screen v, **top=0 to bottom=1**"*; the shader writes
`r = vUv.y` and the engine's vertex shader is `vUv = aPos*0.5 + 0.5`
(`video/engine.ts:2093`), i.e. **y-UP, `v == 1` is the TOP** — a convention
`onetonine.ts:32-34` states explicitly and `onetonine.test.ts:45` pins. `h_lin`'s
"left=0 to right=1" is correct. Also: the card's header comment says **4**
mono-video outputs; there are **six**, and `shapedramps.test.ts` tests only
`shapedrampsMix` — the shape morph, radial, phase and freq math have **no unit
coverage at all.**

### 22.4 `rasterize` — BLOCKED on a panel, and it carries the cohort's second-sharpest glyph finding

`face-migration-inventory.ts:276` already says it: *"the scan preview is a
read-only picture with no glyph kind — **it needs a registered panel or it is a
look loss**."* That stands. But the audit found something that outranks the
blocker:

**⚠ `primaryAudioOutPortId(rasterizeDef)` = `'thru'` — and `thru` is the
module's own INPUT, bit-exactly.** Outputs are `{thru, audio}` then
`{out, mono-video}` (`rasterize.ts:78, 80`). `thru` is `inGain`'s output;
`inGain` is a bare `GainNode` at unity fed by `in` (`:124`) and **never scaled by
anything** — the `gain` param goes to a `CvShadow`, not to `inGain.gain`
(`:151`). **So a `meter`/`waveform` glyph here WILL bind, WILL be live, and will
trace the module's INPUT — while the picture the module actually makes is on
`out`, which the glyph resolver cannot see.** Together with Q25's `mandelbulb`
this makes **two modules in one cohort where the glyph resolves to a live tap
that is not the module's subject**, by two different mechanisms. ⚠ **Declare
`'none'` and assert why.**

Its other defects are worth filing on their own account — **`samplesPerFrame` is
hard-capped at `analyser.fftSize = 2048`** (`:129, 178-179`) against a declared
max of 8000, so on the LOG taper **the top 21.9 % of the dial and the matching CV
span are bit-exactly inert** (⚠ and `vrt-scenes.ts:264` sets it to **8000**
believing it does something); the `docs` say **640×480** in three places
(`:14, 97, 114`) plus `module-manifest.ts:245` while the frame is **1024×768 =
786 432**, which the def's own `cursor` max already states — **the def
contradicts itself between its param table and its docs**; `~1.25
scanlines/frame` is really **0.7813** at width 1024; **`cursor` at its declared
MAX is bit-identical to its declared MIN** (`normalizeCursor(786432, 786432) =
0`); **`gain = 0` BRIGHTENS to a uniform #808080** rather than darkening, because
`sampleToLuminance(0) = 128`; and *"1 clears on wrap"* is promised in three
places while **no code path clears** (`RasterPainter.reset()` is called only
under `__rasterizeVrtSeed`). Also `curve: 'log'` with `min: 0` silently falls
back to a LINEAR taper in both `Knob.svelte` and `Fader.svelte`.

### 22.5 `ruttetra` — next-after, with a defect to file FIRST

12 params, 1 output, and a real readout story (the DISPLACEMENT dials in pixels:
at the shipped `yDisp = −0.3` a black↔white swing is **230.4 px**; at `−1` it is
**768 px = the entire frame height**; and the 320×180 grid samples **7.32 % of
the source** with a row pitch of 4.291 output px). But:

⚠ **THE END-OF-ROW WRAP IS PRESENT AT THE SHIPPED DEFAULTS.** `shapedRamp` at
`morph = 0` returns `fract(t)` (`VERT_SRC:118, 124`). The last column has
`h0 = 319/319 = exactly 1.0`; with `xFreq = 1, xPhase = 0` (both defaults)
`t = 1.0` and **`fract(1.0) = 0.0`** — so **the last grid point of every row is
placed at the LEFT edge**, drawing a near-full-width additive bar at intensity
1.5 with `ONE/ONE` blending, on all 180 rows. The same happens vertically
(`v0 = 179/179 = 1.0` → the bottom scanline is drawn at the top). **`xShape = 0`
— the shipped default — is the worst case, and `xShape = 0.333` is clean.**
DERIVED-BY-READING. ⚠ **`ruttetra` HAS A REAL VRT SCENE whose canvas is diffed**
(`vrt-scenes.ts:352-361`) and `video-orientation.spec.ts:426` runs it at
`xShape: 0`, **so this may already be baked into a passing baseline** — check
before "fixing" it.

Also: all 12 card controls are **dead to CV** (no `readLive`), including the
shape-name labels, so a CV-driven `xShape` moves the render while the card keeps
printing `XS: linear`; and **the card's shape-name thresholds do not match the
shader's breakpoints** (card 0.083/0.25/0.416/0.583/0.75/0.916 vs shader
0.333/0.666 — the card prints "triangle" across `[0.25, 0.416)` when pure
triangle is exactly 0.333). ⚠ And `xShape`/`yShape` ship at their range MINIMUM
with `halfSpan = 0.5`, so **50 % of their CV swing is a no-op and `cv = +1`
reaches only 0.5 — `radial` is unreachable by CV** (§20.4). Three of its
quantities (`hideControls`, `resizedWidth/Height`) live in `node.data`.

### 22.6 `moog911` + `moog911a` — next-after, both stronger than their param counts

**`moog911`** (4 params, 2 `cv` outputs) — a three-time-constant contour
generator, **not an ADSR**. Its `units: 's'` is a HALF-TRUTH on all three T
knobs: `egCoeff` uses `TAU_DECADES = 5` and each stage exits on its own
hard-coded threshold, so the real duration is `T × ln(k)/5`. DERIVED: T1 = 0.01 s
→ attack completes at **13.82 ms**; T1 = 10 s (max) → **13.82 s**; T2 = 0.2 s at
`esus = 0.6` → **239.7 ms**, and at `esus = 0` → **276.3 ms** — **the T2 dial's
real duration moves with the ESUS knob.** T3 = 0.4 s releasing from sustain →
**696 ms**, from the peak → **736.8 ms**. ⚠ Two bit-exact nulls checked AT the
declared value: **`esus = 0` makes T3 and `t3_cv` bit-exactly inert** (release
goes IDLE in one sample), and `esus = 1.0` does the same to T2 (documented).
⚠ **`env_inv` idles at a constant +1.0 DC** — a patched INV jack with no gate is
a full-scale DC source, on no dial.

**`moog911a`** (3 params, 2 `gate` outputs) — a dual trigger delay whose
**PULSE WIDTH IS A HARD-CODED CONSTANT ON NO DIAL**: `TRIGGER_DELAY_PULSE_S =
0.001` → **48 samples = 1.0000 ms** @48 kHz, a **0.01 % duty cycle** at the 10 s
max delay. ⚠ **There is NO QUEUE — a second trigger DISCARDS the first**
(`:81-82` restarts the countdown), so **at the default 0.1 s driven by a 16 Hz
clock the module emits NOTHING AT ALL.** The knob is sampled **only on the
edge**, so turning it mid-countdown changes nothing. `mode` is `0..2 discrete`
with **no `options[]`** and its `OFF`/`PARALLEL`/`SERIES` names live in an
exported const only the card reads. ⚠ It is in `STRICT_VRT_MODULES` (`:1169`), so
a face moves a committed baseline. Defect: `docs` say the SERIES total is
`delay1 + delay2`; the code gives `D1 + D2 + **1**` samples (`:163` reads the
PREVIOUS sample's `out1`) — **20.83 µs, stated as an equality.**

### 22.7 `warrensvisions` — next-after, and the module documents a control that DOES NOT EXIST

12 params, 9 inputs, 1 output. It very nearly made the cohort and is the first
name to pick up next. Three things make it unusual, and one of them is a defect
sharp enough to file today.

**It is the ONLY module in the 92-strong pool that declares `options[]`**
(`warrensvisions.ts:353-362`, on `engineFreeze`: `LIVE` / `FREEZE` with `title`
tooltips) — so it is the only unfaced module that gets a **`segmented`** cell for
free (`shell-control-kind.ts:247-249`, 2 ≤ `SEGMENTED_MAX_OPTIONS` = 6). It also
declares **`landmarks`** on `visionsShape` (`:344-348`: 0 SINE / 0.5 SAW /
1 SQUARE). ⚠ **Neither is consumed today**: the card's freeze button re-types
`'FREEZE'`/`'LIVE'` as string literals (`:126`) instead of reading `options`, and
the landmarks never reach the Knob (`:203-214`). **Both are dormant until a face
lands — which is good news for the spec and means neither is proven by anything
but `param-vocabulary.test.ts`.** ⚠ And note: **`contract-lock.txt` records
neither `options` nor `landmarks`** (`:3712`), so a pool derived from the lock
alone is structurally blind to both — which is why §20.3 had to read the def
SOURCE.

**It carries FIVE real units over a video module** — `dB`, `s`, `fr` (×2), `ct` —
which is unique in the video pool, and it is `maxInstances: 1` with the reason
stated twice in the source: *"Two instances would be ~2.4 ms of extra CPU per
frame and have not been measured together"* (`:81-84`). ⚠ **The palette HIDES the
module once one exists, so a VRT scene that spawns two silently gets one.**

**⚠ THE DEFECT TO FILE NOW: the user-facing manifest documents a `LOCK` control
that does not exist.** `module-manifest.ts:322` tells the player peaks are
*"ranked by SALIENCE, **snapped toward a detected lattice comb by LOCK**, matched
frame to frame as tracks…"*. There is no `LOCK` param on the def, no card
control, and **`applyParams()` (`:510-521`) never calls `setLock()`** — it sets
ten of the eleven setters. So the core's `lock` is pinned at its constructor
default **0.5** (`warrensvisions-core.ts:475`) forever, silently doing two
things: reranking salience by up to **2.5×** for lattice harmonics
(`core:303-328, 888-896`) and snapping wavevectors up to **halfway to the comb**
(`core:913-931`). **A live, load-bearing behaviour with a public setter, a name
in the shipped docs, and no way for anyone to change it.** This is #1701's class
turned inside out: not a false VALUE in prose, but prose describing a control the
declaration does not carry.

**Two more `docs`-vs-code contradictions, both measurable:**

- **`docs.controls.visionsSlew` claims it governs the residual rings; it does
  not.** `:399` says *"the time constant on every component's CONTRAST **and on
  the residual ring envelopes**."* `core:1093-1097` runs the rings on a
  hard-coded `1 − exp(−dt/0.05)`. DERIVED-BY-READING at 60 fps: at SLEW min the
  component coefficient is **0.5654** and the ring coefficient **0.2835**; at
  SLEW max the component coefficient is **0.004158** — **the rings react 68×
  faster than the components.**
- **`docs.controls.visionsComponents` quotes the wrong row of the module's own
  measurement table.** `:393` says a 256-component bank *"costs about 1.2 ms of
  CPU per analysed frame"*; the table at `:39-41` reads **0.75 ms** for
  analysis at 256 and **1.20 ms** for the WHOLE frame at SLICE 1.

**And the CV story is §20.4's UPWARD arm at its most consequential.**
`visionsCoherence` and `visionsMix` both default to **1, their own declared
max**, and neither declares `center: 'default'`. DERIVED-BY-READING: a ±1 cable
into `coherence_cv` sweeps only **0.5 … 1**, with every non-negative sample
pinned at 1 — **so the CV can never reach the free-running behaviour the module
exists for**, while `docs.inputs.coherence_cv` (`:375`) promises *"sweeping it is
the module's main gesture, from resynthesized camera to free-running
interference."* Same for `mix_cv` (cannot reach passthrough), `components_cv`
(never 256), `shape_cv` (never reaches SAW), `drift_cv` (never half scale).
⚠ **The fix pattern is `quadralogical`'s `cvScale: { center: 'default' }` (Q27),
already shipping two ports away.**

**Other unprintables a spec would build on**, all DERIVED-BY-READING:
`visionsResidual` is **bit-exactly silent at `visionsComponents = 1`** (its
declared min) even at RESIDUAL 2, because `rLevel = residual · cbrt((n−1)/255)`
(`core:1211-1216`) — **two dials that multiply, one zeroing the other at an
endpoint**; STABILITY is counted in **COMMITS**, and a commit is `visionsSlice`
frames, so at STABILITY 16 × SLICE 16 full contrast takes **256 frames = 4.27 s**
while the knob reads `16 fr`; DRIFT 1 makes each grating rotate at exactly
`|k|` Hz, so `|k| > 30` **strobes past the 60 fps Nyquist** while the rings churn
16× slower; and CENTER at −3600 ct **hard-cuts every component below `|k| = 4`
with no ramp**, which the docs cover only at the top end.

**⚠ AND SIX LIVE TELEMETRY VALUES ALREADY EXIST WITH NO CONSUMER.**
`WARRENSVISIONS_READ_KEYS` (`:150-157`) serves `committedFrames`,
`framesElapsed`, `liveComponents`, `hasInput`, `smoothPath`, `fieldRange` — and
`liveComponents` (how many gratings actually contributed this frame) and
`smoothPath` (bicubic vs hardware-bilinear, i.e. **the renderer-gated quality
tier**) are exactly what a face readout should surface. Only
`warrensvisions.spec.ts:220-222` reads them today, and the source comment at
`:149` claims *"`read()` keys the e2e **and the card poll**"* — **the card never
polls.** ⚠ **That is a ready-made `FaceReadoutValue` set, already plumbed, with
its own e2e. It is the single best reason to build this face next.**

**Roster notes:** unlike `quadralogical` it is **NOT in `EXEMPT_FROM_VRT`** —
only a per-selector canvas mask (`vrt-exemptions.ts:229-231`) — so it **IS**
solo-spawn VRT-captured today and a face moves a committed baseline. It is in
`HEAVY_RENDER` (`modules.spec.ts:64,69`), in `card-range-source.test.ts:96, 276`
(**the range-source gate already binds its card to the def — the `backdraft`
lesson is pre-paid here**), in `modules-card-map.test.ts:60`, `STRICT_DOCS:349`,
`rack-sizes.ts:210` (and its card width AGREES with the tile, unlike
quadralogical's). **NOT in `card-def-debt.ts` (no label debt), NOT in
`raw-write-ledger.ts` (no raw writes), NOT in `_face-fixtures.ts` or
`push-card-config.ts`.** ⚠ **And it has NO entry in
`per-module-per-port-behavioral.spec.ts` at all** — neither exempt nor driven —
which is worth establishing before promoting it: absent from an exemption list
is not the same as covered.

## 23. WHAT COHORT 4 ADDS TO §5, §10 AND §15

15. **A GLYPH THAT RESOLVES IS NOT A GLYPH THAT READS.** §15.9 said *"a glyph is
    not a default — RESOLVE it"*, and every cohort since has resolved
    `primaryAudioOutPortId` and stopped there. **Two modules in this cohort defeat
    that.** `mandelbulb` is the only video def with a `type: 'audio'` output, so
    the resolver returns `{kind:'live-audio'}` — and the tap calls
    `AudioEngine.getOutputNode`, which searches only the audio engine's node map,
    which a `domain: 'video'` node **never enters**. `rasterize`'s resolver
    returns `'thru'`, which is live and real and is **the module's own INPUT**.
    Both pass every def-reading gate; one flatlines forever and one traces the
    wrong signal. **Resolve the glyph, then follow the TAP to the engine that
    would have to answer it, and assert it moves.** A `{kind:'live-audio'}` that
    cannot move is strictly worse than `{kind:'static'}`, because nothing can
    notice (#1748).

16. **A DECLARATION-SHAPED FIX HAS A DECLARATION-SHAPED PRICE, AND A `params`
    FIX DOES NOT.** For a VIDEO def, `face`, `docs`, `controlFamilies` and now
    `noUserControl` are stripped by the attest normalizer, so all four are FREE
    (§20.1). **Everything else about the def is in the WebGL basis**, so adding
    `options[]` or correcting a `curve` costs an owner-machine real-GPU
    re-attest CI cannot perform. ⚠ **Price the two halves separately in every
    spec, and let them merge separately.** The face ships without the second
    half; it just ships numbers where names belong.

17. **READ THE RESOLVER, NOT THE PRECEDENT.** §20.3's first draft swept the pool
    on `curve === 'discrete'` because §17.3's backdraft table read like a
    general rule. `paramCellKind` has THREE arms: a 0..1 discrete is already a
    `toggle`; a multi-state discrete without `options[]` is a `knob`; a
    multi-state discrete WITH `options[]` is `segmented`/`selector` **at the
    dock tier only**. ⚠ **The commoner defect is the inverse** — a genuine
    boolean declared `linear` (`onetonine.showGrid`, `b3ntb0x`/`bentbox`'s
    `mirrorX`/`mirrorY`, `grainsOfVision`'s `fb_dry`/`rev_dry`/`freeze`) paints a
    continuous rotary over a bit. **A precedent is a case, not a predicate.**

18. **THE VIDEO CV BRIDGE IS NOT THE AUDIO CV BRIDGE.** #1773's "inert upward"
    result came from AudioParam nominal-range clamping, which does not exist on
    the video path — so it was checked rather than carried, and the same
    observable arrives via an explicit `clamp()` in `scaleCv`, plus two things
    the audio path does NOT do: **`mode: 'discrete'` ignores the knob entirely**
    (a cable at 0 V lands on the range MIDPOINT), and **the modulation centre is
    captured once at plug time and the param is overwritten every frame**, so the
    dial goes inoperative rather than staying additive. ⚠ **When you carry a
    finding across a domain boundary, name the MECHANISM and check it survives.**
    Same observable, different cause, different fix.

19. **A "SOMEONE IS WATCHING" SIGNAL MAKES RENDERING A DEPENDENCY OF DSP.**
    `blitOutputToDrawingBuffer` calls `markWatched(nodeId)`, and
    `grainsOfVision` deliberately relies on it — *"the feedback/reverb/history
    state simply pauses when nothing observes the output."* **A face that paints
    a video module without going through a blit stalls its DSP**, and the shell's
    thumbnail is `IntersectionObserver`-gated and fps-throttled. This is the
    card-unmount class (#1531/#1574/#1583) reaching a module through its RENDER
    path rather than its lifecycle. **Ask of every video face: what stops
    running when nobody is looking?**

20. **AN INVENTORY NOTE IS A HYPOTHESIS TOO.**
    `face-migration-inventory.ts:232` tells a builder that mandelbulb's *"orbit
    drag over the preview is a 2-D camera gesture → the `xy` cell"*. There is no
    orbit drag; the handlers write `slice_y`/`slice_ry` and only fire when SLICE
    is on. **A face built to that note wires the wrong two params.** §16.3
    learned this about a task BRIEF; it is equally true of a checked-in
    annotation that no gate reads. **Verify an I/O description against the code
    before designing against it — including the descriptions this repo writes
    about itself.**

21. **CHECK WHETHER A REJECTION WAS TAKEN ON THE CONTROL SURFACE.** `ninelives`,
    `analogLogicMaths` and now `fourplexer` were all rejected on "few knobs,
    nothing to rank" and all three had their merit in what the knobs cannot say.
    ⚠ **And the inverse is now on the record too**: `onetonine` tops the
    outputs-per-param ordering at 9.0 — higher than `ninelives` — with nine
    genuinely different outputs, and is still a rejection, because **its one
    param is inert on all nine.** The ratio is a SEARCH key, not a verdict. An
    ordering that only ever promotes is an ordering nobody could have been wrong
    about.

22. **A DEFAULT THAT SITS ON A CLIFF IS A READOUT, NOT A BUG REPORT.** This
    cohort found seven, all by sampling AT the declared value (#1758) rather than
    around it: `b3ntb0x.tbc = 1` zeroes the module's headline gesture;
    `bentbox.master_gain = 0` discards a whole stage rather than silencing it;
    `mandelbulb.detail = 20` sits inside a 15-position dead band and
    `zoom = 0.30` renders an empty frame; `grainsOfVision.grain_size = 1.1` is
    already past the truncation onset at 1.071; `moog921a.width = 0` produces the
    MIDPOINT duty; `rasterize.cursor` at max equals `cursor` at min. **Each is a
    number a face can print. Print it, and file the docs sentence that
    contradicts it separately.**

23. ⚠ **A SELF-HEALING FIXTURE THAT IS ONE ENTRY DEEP IS A RATCHET NOBODY
    DECLARED.** `_face-fixtures.ts` accepts exactly ONE of its three candidates
    (§20.6): `moog902` fails the `<Fader>` predicate and `gatemaiden` fails the
    domain-class one. **The next promotion of `stereovca` throws at import time
    and takes down every spec that imports the file.** No entry in this cohort
    touches it — and every spec in this cohort carries the grep instruction
    anyway, because the cost of checking is a `rg` and the cost of not checking
    is the whole suite.

---

## 24. THE COHORT AT A GLANCE

| Q | module(s) | dom | par | why it earns a face, in one line |
|---|---|---|---|---|
| **Q23** | `spirographs` | V | 31 | Three figures drift on a clock that is **not a param** — the periods (26.4 / 29.8 / 22.7 s) and the `R·scale ≥ 512` freeze are pure arithmetic no dial shows. |
| **Q24** | `b3ntb0x` + `bentbox` | V | 22 + 16 | The pool's only two ⛶ OUTPUT carriers, i.e. the **first `fullViewBody` adopters** — plus a `tbc` default that silently disables the module's own headline instruction. |
| **Q25** | `mandelbulb` | V | 13 | The **only video def with an `audio` output**, so its glyph RESOLVES — to a tap that structurally cannot see a video-domain node. |
| **Q26** | `grainsOfVision` | V | 20 | §17.6's named `noUserControl` blocker, now landed — and a module whose DSP **stops when nobody is looking**. |
| **Q27** | `quadralogical` | V | 21 | **12 of its 21 params are bit-exactly dead at spawn** — the card hides them and a def-driven face would not; plus a polarity-reversed WIPE the unit suite filters out of its own check. |
| **Q28** | `moog921a` + `moog921b` | A | 3 + 5 | **One oscillator split across two defs**: the same dial position is F♯4 or C7 depending on a switch, and neither face can print the Hz alone. |
| **Q29** | `fourplexer` | A | 4 | §14's rejection withdrawn — the card's **knob and its own readout print different numbers for the same param**, and both lag the jack. |

**Rejected or deferred, with reasons (§22):** `onetonine` (REJECT — 9 real
outputs, and its one param is inert on all of them) · `shapedramps` (REJECT — no
card affordance, two duplicate outputs, two unmodulatable ones) ·
`colourofmagic` (DEFER — four PRs, named) · `vfpgaRunner` (DEFER — its control
set lives in `node.data`) · `rasterize` (BLOCKED on a registered panel, and it
carries the second glyph finding).

**Next after this cohort, in order:** `ruttetra` (12 params — file the
end-of-row wrap first) · `mirrorpool` (11) · `outlines` (9) · `freezeframe` (8 —
its `quant_luma` default is not the passthrough the docs claim) · `4plexvid` (8)
· `moog911` + `moog911a` (the two strongest small audio candidates left) ·
`moogCp3` and `moog921Vco` (spec'd inside Q28, not folded into it).
