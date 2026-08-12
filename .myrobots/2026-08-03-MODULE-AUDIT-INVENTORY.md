# 2026-08-03 — MODULE AUDIT INVENTORY

**18 audio modules audited across 3 batches. 178 defects. ZERO faceplates promoted.**

That last number is the headline, not a failure: the faceplate programme kept finding
that modules **do not work**, not that they look wrong. Putting a face on rings while
its primary output is silent would be decoration over a broken module.

- **21 modules had faces when this was written; 32 do as of 2026-08-12**, and the
  faceplate pipeline is PAUSED by owner directive. 18 audio modules are audited.
- Method + probe cookbook: `.claude/skills/module-adversarial-audit.md`
- Face rules + the two STOP gates: `.claude/skills/module-faceplates.md`

**Every number below was MEASURED** — arithmetic run against real shipping code
(dist worklet, shipped wasm, the real factory, or the real pure core). Anything
read-from-source only is marked READ. Do not blur the two.

> ## STATUS (2026-08-09) — the 2026-08-04 fix wave landed against this ledger
>
> This file is the measurement record; it has no per-row status. State the fixes
> in one place so a reader does not work a row that is already closed:
>
> | ledger rows | fixed by |
> |---|---|
> | rings ODD silent at default + ODD/EVEN bit-identical | **#1345** |
> | timelorde SWING / divider-on-last-beat / external-clock dropout | **#1347** |
> | treeohvox gate length never read / WAVE hard null / filter reset per edge | **#1349** |
> | wavecel amp-ADSR bypass / note-off click / SPREAD cliff | **#1350** |
> | charlottes-echos DELAY off by exactly 4× | **#1344** |
> | cofefve State-var divergence + permanently dead wet path | **#1348** (analog-delay-core) |
> | cube — wavecel's envelope bypass (the item batch 2 scoped out) | **#1360** (`base_vol` default → 0) |
> | twotracks rate/speed CV (the owner HIGH-PRIORITY feat) | **#1352** |
> | samsloop START/END dead (the owner-reported regression) | **#1353** (root cause in SESSION-STATE §6b) |
> | wavesculpt MASTER GAIN dead knob | **#1368** |
> | the mono-normal gate's own blindness (the ⚠ under the stereo-silence class) | **#1351** (46 %, not 30 % — SESSION-STATE §6b) |
>
> **UPDATE 2026-08-12 — the #1434–#1486 wave closed more rows:**
>
> | ledger rows | closed by |
> |---|---|
> | timelorde STOP-vs-MUTE naming + the multiplier deficit (the instrument, not the module) | **#1447** |
> | clouds SIZE's dead top 19.5 % — the ceiling and the law were two literals that disagreed | **#1456** |
> | rings sample-rate dependence (+ macseq, cartesian ×2, fourplexer) | **#1484** |
> | score's 8 silent triplets, and five gates that could not see what they check | **#1483** |
> | marbles `pw_mean` and `x_deja_vu` orphan params — both now have a fader/CV and authored docs | the marbles face, **#1467** |
> | samsloop's O(n²) capture (card path + the live-peak fold) | **#1422** |
> | wavesculpt's 11-param CRT block (dropped rather than fixed) | **#1449** |
> | hypercube | **#1448** — module deleted outright, not repaired |
>
> ⚠ **Two rows now CONTRADICT a later re-measurement and must be reconciled
> before anyone acts on them.** #1451 shipped the clouds face titled *"nothing
> broken and three things invisible"*, and #1470 shipped resofilter's noting
> *"four spec figures that did not survive re-measurement"*. This file's clouds
> rows (TEXTURE inaudible / DENSITY reverses / POSITION at 1.0 / degenerate
> stereo) predate that. **Re-measure before treating any clouds row as live.**
>
> **Everything else in this file still has NO fix PR — treat it as open backlog
> and the measured numbers as current.** Spot-verified 2026-08-12 as still
> present in the tree: **marbles CLUSTERS is still a stub**
> (`marbles-engine.ts:800-804`, still falls through to
> `generateComplementaryBernoulli`), **swolevco's four CV inputs still land on
> shadow GainNodes that drive nothing** (`modules/swolevco.ts:415-424`, `:469-475`
> — `setParam` still owns application), and **destroy's DECIMATE still truncates
> a `si.smoo` with `int()`** (`packages/dsp/src/destroy.dsp:6,21`). Also still
> open, not re-checked this pass: foxy, synesthesia DPT, featurecv,
> wavetable-vco's `wavePos`, spectrograph, and wavesculpt's BLUE/rotation rows
> (plus both tests §"docs" flags as built around defects).

---

## THE STEREO-SILENCE CLASS — five modules, FIXED in #1343

A mono source into a stereo module's LEFT input left its RIGHT output at digital
silence. Two distinct mechanisms produced the identical symptom.

| module | mechanism | measured OUT R |
|---|---|---|
| charlottes-echos | factory pins a silent `ConstantSource` over the DSP's `inputs[1] ?? inputs[0]` normal | **0.0000e+0** → 0.858524 fixed |
| cofefve | same | **0.0000e+0** |
| clouds | same — *the module that named the pattern, never measured until batch 2* | **0.0000e+0** → 6.8858e-1 |
| shimmershine | same — **its own source header already documented this as "DEAD in practice… Verified in Chrome"** | **0.0000e+0** → 4.4212e-1 |
| resofilter | **different**: `channelInterpretation: 'discrete'` zero-fills ch1, so the DSP fallback can never fire | **0.0000e+0**, out_l 0.76655477 |

**The platform claim underwriting it was false.** `stereo-autowire.ts:17` said a mono
source into a stereo L "leaves the sibling UNPATCHED (the engine already normals R←L)."
False for 5 of 5. And `stereo-autowire.spec.ts:143-157` was a test **built around the
defect** — it used cofefve and asserted the ABSENCE of the edge that would have fixed it.

**Batch 3 confirmed the class is BOUNDED at five** — absent from all six of
stereovca/wavetable-vco/swolevco/destroy/featurecv/spectrograph, checked end to end
rather than inferred. stereovca measured OUT R peak **0.500000** with a working
negative control.

⚠ **But the gate written to prevent a sixth is 30 % blind** — see SESSION-STATE §6.

---

## BATCH 1 — wavesculpt, treeohvox, clouds, rings, marbles, timelorde
55 defects, 39 audible. Verdicts: 2 BLOCKED, 4 NEEDS_FIX_FIRST.

### Silent or dead at the shipped default
- **rings ODD output is digital silence** — and ODD is the first-declared,
  docs-designated "primary/mono" out. `dsp/rings.ts:99-107`, `w = cos(position*π*(i+1))`
  is 0 for every odd-accumulator term when `i` is even. **oddPeak 8.486e-16 at the
  default position 0.5 vs 4.735e-1 at 0.0 — about −278 dB.**
- **rings SYMPATHETIC: ODD and EVEN bit-identical** at the same default →
  `stereoPairs` auto-wire yields fake stereo. **maxAbsDiff over 0.5 s = exactly
  0.000e+0** (0.531 at pos 0.25). Distinct edges — not the twotracks bug, same result.
- **wavesculpt BLUE (osc 3) distance gain is exactly 0.0000** at the default camera.
  **BLU > 0 at 1 of 9261 grid points.** ⚠ `wavesculpt.test.ts:218-224` documents this
  and asserts only "≥3 of 4 walls audible" — **a gate built around the defect.**
- **treeohvox WAVE has a hard null at 1/3 travel** — `treeohvox-dsp.ts:451` crossfades
  an ideal saw against a phase-aligned ideal square. **DFT at 100 Hz: h1 = 0.00000 AND
  h3 = 0.00000.** rms 0.08145 → 0.03001 → 0.13535 across the knob.

### Controls that do nothing, or the opposite of what they say
- **timelorde SWING does not swing.** `timelorde-clock-core.ts:353,382` add the lag to
  sub-pulse 0 AND every k-th → a uniformly phase-shifted copy. **Intervals
  [12000,12000,12000,12000] at amount 0, 30, 60 AND 90.**
- **timelorde: every divider fires on the LAST master pulse of its group** — a /4 "bar
  clock" lands on beat 4. `:310` increments before the `% ratio` test at `:317-321`;
  the comment at `:315-316` asserts the conventional behaviour. ⚠
  **`timelorde-clock-core.test.ts:94-96` PINS THE WRONG BEHAVIOUR.**
- **timelorde external-clock dropout leaves the rack silent ~3.4 beats** — `:260` gates
  the accumulator on `!externalActive`; comment at `:292-294` is false. Measured gap
  **81599 samples (1.70 s)**.
- **timelorde `swingSource` capped at 10 but 12 exist** — 1/64 unreachable from UI or
  any saved patch. `contract-lock.txt:3323` pins the wrong ceiling.
- **treeohvox ignores gate length entirely; DECAY does not shorten the note.**
  **Gate 480 vs 48000 samples → BYTE-IDENTICAL output**; −20 dB at 2417 ms (DECAY 50)
  vs 2458 ms (DECAY 3000) = **1.7 % across a 60× knob move.** Every note rings ~8 s.
- **treeohvox: every gate edge hard-resets the filter** → sample 0 of every note is
  exactly 0.0. **sample[9599] 0.06633 → sample[9600] 0.00000**, 3.8× the largest delta
  elsewhere. Its own comment concedes the reference "only resets when idle", and the
  adjacent amp env deliberately does NOT reset "which keeps overlapping retriggers
  click-free" — the two are inconsistent.
- **treeohvox: bottom 6.5–25 % of CUTOFF is bit-exact dead** (ladder clamps ≥200 Hz;
  def exposes from 40 Hz).
- **marbles CLUSTERS is a stub, bit-identical to COIN.** `marbles-engine.ts:800-804`.
  t1, t2 and x1 all bit-identical over 8 s. **The card prints a label on a cycle button
  that changes nothing.** Firmware has a real implementation.
- **marbles SCALE is inert at the shipped default** (STEPS 0.5) and again at STEPS 1.
  All six scales identical below 0.52; useful window only ~0.54–0.88.
- **clouds TEXTURE is inaudible across its entire upper half**, starting at the
  default. **corr 0.999984** for 0.5→1.0; in-run control 0→0.5 gives corr 0.989.
- **clouds DENSITY reverses** — the 24-grain pool saturates at ≈0.49. **0.5 is the
  loudest point on the knob**; the top half moves 0.85 dB the wrong way.
- **clouds POSITION at exactly 1.0** collapses read head onto write head — corr jumps
  −0.0029 → **0.9753**. Reference guards it.
- **clouds stereo is degenerate: corr(outL,outR) = 0.99971** at defaults.
- **rings MODAL DAMPING sweep is 12.8–46.6 ms** and damping UP makes it LOUDER, while
  docs promise "resonates long". `:91` scales Q by 0.05 (500 → 25).

### Docs that describe the opposite of the code
- **marbles: all five DÉJÀ VU strings wrong.** The loop LOCKS at 0.5 and SHUFFLES at
  1.0 — a user following the docs turns it up expecting more repetition and gets the
  least. Code is faithful to hardware; the prose is not.
- **clouds TEXTURE prose is soft→hard; code is hard→soft.** The DSP's own header states
  it correctly — **only the def is wrong, which is exactly where the docs gates read.**
- **wavesculpt: "camera ROT is visual only — audio is rotation-invariant."** False.
  rot=0 → [.0532,.0480,**0.0000**,.0703]; rot=1 → [.0532,.0480,.0755,**0.0000**].
  ⚠ `wavesculpt.test.ts:276-279` asserts rotation L1 = 0.129 — **a passing test
  contradicting the prose beside it.**
- **wavesculpt: the control labelled "Height" dollies the camera along Z.** The real
  height axis is pos_y. It is also the second-strongest audio control (L1 1.55).

### Orphan params — real, audible, no fader and no CV input
- **marbles `pw_mean`** (duty 0.028 → 0.281 → 0.847) and **`x_deja_vu`** (the X half's
  headline feature). Reachable only via the Push 2 generic card.

---

## BATCH 2 — cofefve, charlottes-echos, wavecel, foxy, resofilter, synesthesia
69 defects, 54 measured, 39 audible. Verdicts: 2 BLOCKED, 4 NEEDS_FIX_FIRST.

- **cofefve FILTER MODE "State-var" diverges, then the wet path is PERMANENTLY DEAD for
  the life of the node.** `analog-delay-core.ts:195-196` clamps to `(…,0,1.4)` where a
  Chamberlin SVF needs f<1.1. **Peak 9.5839e+37 at 0.400 s; after returning every knob
  to a safe patch, echo RMS is exactly 0.000e+0 while dry passes at 2.9972e-1.** The
  module is bricked until re-spawned.
- **charlottes-echos DELAY is wrong by exactly 4×** across its whole travel and declares
  `units: 's'`. **At the 0.4 s default the first echo lands at 1.6000 s; peak over
  [0,1.5 s) is exactly 0.0000e+0.**
- **wavecel AMP ADSR is completely bypassed at the shipped `base_vol=1`.**
  `poly-osc-sum.ts:105` = `base + (1-base)*env`. **Rise-to-90 % is 6.50 ms at A=0.001 s
  AND at A=2 s; gated-vs-drone maxAbsDiff exactly 0.0000e+0** (control at base_vol=0:
  9.9595e-1). ⚠ `base_vol` exists because of a real past fix ("kill stray drone + add
  Base Vol VCA floor") — do not simply delete it.
- **wavecel full-scale note-off click** at the default: **0.953480 → 0.000000**,
  block-aligned step 0.604547 (0.000006 at base_vol=0 — a 100,000× control).
- **wavecel SPREAD is a 46 dB volume cliff**, not a width control: **−2.35 dB at spread
  1 → −48.27 dB at 1.0001.**
- **wavecel SPREAD produces no stereo and no detune** — one shared phase accumulator.
  **|L−R|max = 0.0000e+0** at every spread value tested.
- **foxy: the entire SWOLE A block (5 knobs + FREEZE A) contributes nothing.**
  Every A knob → **maxΔwavetable 0.000000**; control `src2_symmetry` moves it 0.652695.
- **foxy WARP, the headline v4 control, is a no-op** for the wavetable. **max|Δ| 0.0e+0.**
- **foxy: 97.10 % of output power is DC.** Every MORPH move is a thump louder than the
  programme — **a −0.759343 full-scale DC step, +16.30 dB above the settled programme.**
- **foxy GEN "3D Shape Gen" at the default MORPH is digital silence on a −1.0 rail** —
  DC −1.000000, AC-rms exactly 0.000000, 60.29 % of the table clamped.
- **synesthesia DPT is bit-identical across most of its travel** — the env CV is already
  railed at the default (CV_MAKEUP 1.6 calibrated on percussive peaks).

---

## BATCH 3 — stereovca, wavetable-vco, swolevco, destroy, featurecv, spectrograph
54 defects, 46 measured, 31 audible. Verdicts: **2 NO_FACE_ON_MERIT**, 4 NEEDS_FIX_FIRST.

*(The first NO_FACE_ON_MERIT verdicts — the skill correctly declining rather than
padding a count. stereovca and spectrograph do not warrant faces.)*

- **swolevco: all four CV inputs (timbre/symmetry/fold/ratio) are audio-inert** — they
  land on "shadow" GainNodes whose output connects to **nothing**.
  `modules/swolevco.ts:406-420` + `:461-466`. **CV +1 → maxΔout 0.000e+0 on all four**;
  the same value on the KNOB gives 1.702 / 0.975 / 1.013 / 1.928. Docs at `:212-216`
  say "patch an envelope here".
- **swolevco: pitch CV never reaches the MODULATOR** — RATIO-locked FM does not track
  the keyboard. At ratio 2: 0 V → out 261.60 / mod 523.30; **+2 V → out 1046.50 / mod
  523.30**. c:m walks 0.25 → 4.0 across C2..C6. Docs at `:209` claim the opposite.
- **destroy DECIMATE holds N−1 on 57 of 64 knob positions** — `int()` truncates a
  `si.smoo` converging from below. **Knob 2 is bit-identical to knob 1** (maxAbsDiff
  0.000e+0), so **2× downsampling — the classic bitcrusher setting — is unreachable.**
  7 factors unreachable, 7 adjacent pairs collide.
- **destroy BITS at the low end is digital silence**, not "near square-wave
  destruction": **−104.83 dB, 100.0 % of samples exactly 0.0** at bits≤2 on a 0.25-amp
  C4. Mid-tread quantizer with a level-dependent dead zone.
- **destroy summing**: a stereo patch is silently summed to mono (L+R)/2, undocumented.
- **featurecv: moving ATK or REL slams all three CVs to the negative rail.**
  `setSmoothing()` rebuilds three EnvFollowers from env=0 **every quantum**.
  **ATK 10→11 ms on a steady tone: LOUD 0.699460 → −0.996783 = 84.8 % of the ±1 range**
  (control with ATK pinned: 0.000003). A 400 ms drag holds the CV below midpoint for
  **95.7 %** of the drag. The source comment calls it "a negligible glitch".
- **featurecv analyses a stereo source LEFT-CHANNEL-ONLY** (`dsp/featurecv.ts:98`), ch1
  silently discarded. Repo-wide analyser convention (synesthesia does the same), not a
  featurecv regression — but worth a decision.
- **wavetable-vco WAVE POSITION CV bypasses the ±1-CV scaling standard** — its def omits
  `cvScale` where its four siblings have it. **At the shipped default, half a bipolar
  LFO is bit-exactly dead: maxAbsDiff 0.000e+0.** Clamp duty ≥50 % at every knob
  position. Docs claim "±1 covers the whole table".
- **wavetable-vco `wavePos` is unsmoothed a-rate** — the only oscillator worklet in the
  repo not using `WtParamSmoother` (18 files do). **A 0→1 flick steps 36.84× the
  control at the block boundary**; one fader pixel = 1.20×.
- **spectrograph: nearest-FFT-bin row sampling makes displayed level frequency-selective
  by up to 102.7 dB.** 128 rows sample 76 of 512 bins — **436 bins (85.2 %) can never
  reach a pixel.** A full-scale sine paints at −13.56 dBFS @6 kHz vs −116.30 dBFS
  @19 kHz. 10.3 % of swept tones paint at or below the floor (invisible).
- ⚠ **spectrograph's own deterministic VRT fixture loses one of its three planted
  traces, and the committed baseline pins the two-trace image as correct.** (Said
  "the darwin PNG" when written; #1458 collapsed that to one baseline set — the
  defect is unchanged, the path is not.) Three
  −12 dB peaks paint at −12.0 / −24.0 / **−100.0** dBFS. The code comment claims
  "visible traces in BOTH colormaps". **Another test built around the defect.**

---

## WHAT THE AUDITS COULD NOT SEE — stated, not implied

- **No module was driven through the real UI.** Everything is DSP-level or factory-level.
  A card that writes the wrong value to a correct DSP is invisible to this method.
- **`packages/dsp`, `packages/server` and the repo root were never swept** for the
  ratchet/blind-gate classes — only `packages/web`, `e2e`, `scripts`, `art`.
- **102 of 120 audio modules are unaudited.** Nothing here says they are clean.
- **Defects requiring a specific patch context** (module A into module B) are outside
  this method entirely — every audit drove modules in isolation.
