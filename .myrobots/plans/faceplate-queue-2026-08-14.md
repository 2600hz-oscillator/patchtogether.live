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
