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
| `illogic` | 4 | MARGINAL-YES, deferred. Four attenuverters, ten outputs of derived logic. |

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
