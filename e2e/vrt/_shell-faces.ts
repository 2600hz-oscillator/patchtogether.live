// e2e/vrt/_shell-faces.ts
//
// Shared scene machinery for the P1 CURATED FACES VRT (`workflow-shell-faces.
// spec.ts`) and its measurement probe (`vrt-fold-probe.spec.ts`).
//
// WHY A SHARED MODULE rather than a copy in each: the probe exists to explain
// the GATE's capture box. A probe that booted the scene even slightly
// differently would be measuring a different box, and the number it printed
// would be authoritative about nothing — the exact failure mode CLAUDE.md's
// "VALIDATE THE INSTRUMENT" section is about. One boot path, one fold reading,
// two consumers.
//
// (A `_`-prefixed file is not matched by vrt.config's testMatch, so nothing
// here registers tests. Importing a *.spec.ts from another spec WOULD register
// its tests twice, which is why the FACES roster lives here and not there.)

import { expect, type Locator, type Page } from '@playwright/test';
import { pinVrtFonts, awaitVrtFonts } from './_fonts';
import { freezeAudioContext, readAudioClock } from './vrt-audio-freeze';
import { settle, waitFrames } from '../_helpers/frames';

/** The P1 migrated set (= STRICT_FACES). `pages` = the declared face.pages
 *  count the dock scene must render as labeled section bands — a per-scene
 *  structural gate that fails BEFORE the pixel pin if a page is dropped. */
export const FACES = [
  // batch 1
  { type: 'tidyVco', pages: 5 },
  { type: 'kickdrum', pages: 5 },
  { type: 'adsr', pages: 1 },
  { type: 'vca', pages: 1 },
  { type: 'lfo', pages: 1 },
  { type: 'cloudseed', pages: 8 },
  // batch 2 — the two pitched voices, the two drums, the two processors
  { type: 'dx7', pages: 4 },
  { type: 'sixstrum', pages: 5 },
  { type: 'snaredrum', pages: 5 },
  { type: 'tomtom', pages: 4 },
  { type: 'shimmershine', pages: 3 },
  { type: 'qbrt', pages: 2 },
  // batch 3 — the plucked-string voice + the four workhorse processors
  { type: 'karplus', pages: 2 },
  { type: 'filter', pages: 2 },
  { type: 'mixer', pages: 2 },
  // 2 → 1: `output blend` held a single knob and was a house template copied
  // across four defs; the three knobs are one idea and the band header now says
  // which of them sit inside the loop.
  { type: 'delay', pages: 1 },
  { type: 'reverb', pages: 2 },
  // batch B+ — the stereo crush
  { type: 'ringback', pages: 2 },
  // FACE BATCH 3 (2026-08-03) — the PF-20 wave. `pages` is the POST-hero-split
  // band count the dock renders, which is the declared `face.pages` length
  // unless a promotion empties a band (heroFacePlan drops an emptied band).
  { type: 'clap', pages: 4 },
  { type: 'drummergirl', pages: 2 },
  // ⚠ THE ONLY FREE-RUNNING VOICE IN THIS ROSTER, and therefore the only entry
  // that EXERCISES the audio freeze above rather than being indifferent to it.
  // It carries NO mask: it is captured strict, like every sibling.
  //
  // Every other face is struck or silent, so its glyph tap reads zeros whether
  // the graph runs or not — which is precisely why the missing freeze survived
  // undetected for months and why `fix/vrt-face-audio-freeze` (#1420) could
  // only be covered by a SYNTHETIC control that manufactures the condition.
  // analogVco makes the condition real: it sounds the instant it spawns, with
  // no gate and no note to wait for (`factory` feeds silence to all four
  // merger inputs purely to keep the Faust node processing).
  //
  // MEASURED 2026-08-08, darwin, port 5439, this tile, within-subject via
  // vrt-face-audio-probe (26/255 channel delta, glyph box x50-82 y35-49):
  //
  //   SOURCE      port=saw tapped=true peak=0.999890 moving=1.953397
  //               (`moving > 0` IS the free-running condition, read at the
  //                AnalyserNode rather than inferred from pixels)
  //   frozen pre-frame (SHIPPING)          0 px  — and 0 px across two
  //                                        INDEPENDENT boots
  //   AUDIT_NO_FREEZE=1 (freeze off)     394 px  — all of it in the glyph box
  //   PROBE_FREEZE_LATE=1 (wrong ORDER)  337 px  across independent boots
  //
  // The last two rows are 0 px for all 21 other faces, so this entry is the
  // ONLY thing in the roster that can distinguish "frozen" from "running" OR
  // correct freeze ORDERING from late. Gate derivation, 10 SEPARATE playwright
  // processes against a fresh unmasked baseline (scripts/vrt-derive-trials.sh,
  // NOT --repeat-each): 10/10 PASS.
  { type: 'analogVco', pages: 2 },
  // THE SECOND FREE-RUNNING VOICE, and therefore the second entry that
  // exercises the freeze rather than being indifferent to it. Same shape as
  // analogVco above — it sounds the instant it spawns, no gate and no note to
  // wait for — and it carries NO mask either.
  //
  // ⚠ NOT REDUNDANT WITH analogVco, and the measurements say so in BOTH
  // directions. MEASURED 2026-08-09, darwin, this tile, via
  // vrt-face-audio-probe at the same 26/255 channel delta the gate applies,
  // against the same effective 72 px budget (7216 px tile × 0.01):
  //
  //   SOURCE   port=out tapped=true peak=0.639986 moving=1.087596
  //            (`moving > 0` IS the free-running condition, read at the
  //             AnalyserNode rather than inferred from pixels)
  //   frozen pre-frame (SHIPPING)    0 px within-run (d12=0, d23=0) AND
  //                                  0 px across two INDEPENDENT boots
  //   AUDIT_NO_FREEZE=1              78 / 230 / 103 / 146 px over FOUR
  //                                  independent runs — every one of them
  //                                  entirely inside the glyph box
  //                                  (x53-82, y38-46), 3 of 4 over budget
  //   PROBE_FREEZE_LATE=1            0 / 0 / 192 / 173 px over four boot pairs
  //
  // ⚠ READ THE LAST ROW CAREFULLY, BECAUSE IT IS THE INTERESTING ONE. A
  // late-ordered freeze on THIS module is INTERMITTENT — it lands on the same
  // saw phase about half the time — where analogVco caught the same
  // mis-ordering at a hard, repeatable 337 px. So macrooscillator alone would
  // turn an ordering regression into a FLAKE, and analogVco alone cannot
  // notice that the failure mode is module-dependent at all. Keep both: they
  // are complementary witnesses, not a duplicate pair.
  //
  // ⚠ AND WHAT WOULD SILENTLY RETIRE THIS ENTRY: nine of the fourteen engines
  // free-run and five are SILENT until struck, so whether this scene exercises
  // the freeze at all depends on `model`, which is 0 (VA) at the def default.
  // Move that default onto a struck engine and this tile starts reading zeros
  // like the other twenty-one, with every gate still green. Re-run the probe
  // to re-establish it; never infer it from a passing scene.
  { type: 'macrooscillator', pages: 3 },
  // ⚠ 8 bands trips DOCK_TAB_MIN_BANDS: this face renders as a TAB RAIL, by
  // design (five identical voice strips have no other shape). Do not merge it
  // back under seven.
  { type: 'pentemelodica', pages: 8 },
  // FACE BATCH 3 (2026-08-09) — the DTMF dialer. Two bands: the keypad (which
  // the hero promotes the tone-bank PANEL out of, leaving its ten keys, so the
  // band survives) and the two in-band tones.
  //
  // ⚠ DETERMINISTIC FOR THE MIXER/REVERB REASON, NOT THE analogVco ONE. Its
  // glyph is a `meter` on `out` and all twelve keys default to 0, so the rack is
  // SILENT at spawn and the VuMeter is unlit — it would baseline cleanly even
  // without #1420's freeze.
  //
  // ⚠ ITS HERO PANEL POLLS THE LIVE ENGINE ON rAF, which is a first for this
  // roster and worth naming here rather than leaving to be discovered from a
  // flaky tile. It is deterministic anyway, for a reason that does not depend on
  // the freeze: the poll reads the twelve `btn_*` AudioParams, every one of them
  // sits at its default 0, and the panel only assigns state when the resulting
  // 12-bit mask CHANGES — so an idle scene repaints nothing at all. (It reads
  // the engine because it must: all twelve params are momentary, so a durable
  // read is constant zero forever. See the def.) Flake-checked 3×.
  { type: 'bluebox', pages: 2 },
  // meowbox declares TWO bands and renders two: the hero promotes `morph` and
  // the MEOW pad out of band 1, which still holds `pitch` — so nothing is
  // emptied and nothing is dropped. (A promotion that emptied band 1 would make
  // this 1, and would also take that band's hint out of the annotation sweep.)
  { type: 'meowbox', pages: 2 },
  // FACE BATCH 3 (2026-08-10) — the 3-D wavetable navigator. SIX bands, all six
  // surviving the hero split: the hero promotes `cube-view` and `slice_ry` out
  // of band 1, which still holds ROT Z / ROT X / Y / WRAP.
  //
  // ⚠ THE ONLY FACE IN THIS ROSTER WHOSE HERO IS A LIVE WebGL2 CONTEXT, and the
  // determinism argument is NOT the audio freeze — it is that cube's picture has
  // no clock at all. The volume, the plane and the camera are all params
  // (`view_rot_*` are knobs, not a spin), the renderer SKIPS the draw entirely
  // when its scene signature is unchanged, and the wave overlay is the posted
  // slice, which on a suspended graph never arrives — so an idle tile repaints
  // nothing. The hero CAPTION is the same story from the other side: it is
  // computed through the pure `sampleSlice` rather than tapped off the engine,
  // precisely so it prints a real number in a frozen capture instead of `—`.
  //
  // ⚠ WHAT WOULD SILENTLY RETIRE THAT: giving cube any time-varying view (an
  // auto-orbit, a spinning plane) makes this the first face tile that genuinely
  // animates, and it would flake rather than fail. Re-derive with
  // vrt-face-audio-probe before assuming a passing scene proves stillness.
  { type: 'cube', pages: 6 },
  // FACE BATCH 4 (2026-08-10) — the granular texture processor. Three bands:
  // the ring (which the hero promotes BOTH the buffer panel and POSITION out
  // of, leaving FREEZE — so the band survives and the count stays 3), the
  // grains, and pitch + blend.
  //
  // ⚠ DETERMINISTIC BY CONSTRUCTION, NOT BY THE FREEZE, and the distinction is
  // the whole reason this entry is worth a note. clouds is the first face whose
  // hero picture is of something that MOVES IN TIME — a ring buffer filling —
  // so the obvious hero is a live write head, and a live write head would make
  // this baseline a race against boot latency no matter what #1420 does about
  // the AudioContext. The panel therefore has NO CLOCK: every pixel is a pure
  // function of the six macros (`cloudsRingPlan`), pinned as such in
  // clouds-face-model.test.ts. VERIFIED rather than assumed — three consecutive
  // dock captures byte-identical, and the same for the compact tile.
  //
  // Its `meter` glyph is unlit for the mixer/reverb reason, not the analogVco
  // one: clouds is an INSERT, so with nothing patched both outputs are exactly
  // 0.000e+0 and the VuMeter has nothing to draw. This tile would baseline
  // cleanly even without the audio freeze, so — unlike analogVco and
  // macrooscillator — it is not a witness for it.
  { type: 'clouds', pages: 3 },
  // FACE BATCH 4 (2026-08-10) — the three-tap noise source, and the FIRST
  // ZERO-BAND entry in this roster. Not a mistake and not a truncation: the
  // module has ONE param, `face.hero.control` promotes it, and `heroFacePlan`
  // DROPS a band its hero emptied ("a labelled void where they were"), so the
  // dock renders a hero rail and a sidebar and no section bands at all. The
  // `toHaveCount(pages)` assert in `openDock` is therefore a real structural
  // gate here too — it fails if a band ever comes back.
  //
  // ⚠ FREE-RUNNING, AND THE FIRST BROADBAND WITNESS FOR #1420's FREEZE. All
  // three noise tables `.start()` unconditionally at factory time, so the
  // `meter` glyph on the compact tile is live from spawn — this tile can only
  // baseline because the shared boot path suspends the graph before framing.
  // analogVco and macrooscillator are the existing witnesses and both are
  // PERIODIC (a saw at some phase), which is why a mis-ordered freeze reads as
  // an intermittent 0/0/192/173 px on macrooscillator. Broadband noise has no
  // phase to land on, so the prediction is that this tile catches the same
  // regression deterministically.
  //
  // ⚠ THAT IS A PREDICTION, NOT A MEASUREMENT — say so rather than let a later
  // reader take it for a derived number like the two entries above. The two
  // PNGs (`face-noise-compact`, `face-noise-dock`) are authored by the linux
  // capture job like every other baseline, and the probe that would settle
  // this has not been run against them. Run `vrt-face-audio-probe` on this
  // tile before quoting a number here; a passing scene is not the measurement.
  { type: 'noise', pages: 0 },
  // FACE BATCH 5 — the analog delay. SIX declared bands, six rendered: the hero
  // promotes `delayTime` and the echo-train panel out of band 1, which still
  // holds SYNC, CLK SRC and FEEDBACK, so nothing empties.
  //
  // ⚠ ITS HERO PANEL IS AN INSERT'S PICTURE, NOT A TRACE, which is what makes
  // this tile deterministic on a rack with no source patched into it. Every
  // stem is computed from the durable params through the DSP's own loop
  // arithmetic — no analyser, no rAF poll, no engine read — so the picture is
  // identical whether the graph is running or frozen. (The `scope` glyph on the
  // COMPACT tile is a live trace, and it is flat for the ordinary reason: an
  // unpatched insert outputs silence. #1420's freeze covers it regardless.)
  //
  // ⚠ THIS SCENE WAS "LINUX ONLY" AND IS NOW SIMPLY NORMAL (2026-08-10). Its
  // linux baseline was captured; the sibling darwin job of the same dispatch
  // FAILED on two UNRELATED scenes (`face-mixer-compact`,
  // `face-ringback-dock`), both tripping #1420's guard — "the AudioContext is
  // 'running', not 'suspended', at CAPTURE time" — and the darwin sweep is ONE
  // job, so those two aborted the whole capture. With the darwin baseline set
  // deleted there is nothing left to be missing here.
  //
  // ⚠ THE CAPTURE DEFECT ITSELF IS NOT FIXED and does not disappear with the
  // platform dimension: if those two scenes trip the guard on LINUX too, they
  // abort the one remaining capture job and NOTHING gets written. The guard is
  // correct — a face glyph baselined off a running graph is a moving target —
  // so the fix belongs in whatever leaves the context running, not in the
  // guard.
  //
  // ⚠ AND A LOCAL DARWIN VRT RUN SILENTLY RECREATES IT. Playwright's
  // `updateSnapshots` defaults to `'missing'`, so any darwin run — including a
  // read-only "did it still render?" check — writes `darwin/face-cofefve-*.png`
  // as UNTRACKED files that a `git add -A` would happily commit, turning this
  // deliberate linux-only state into exactly the undeclared gap it avoids.
  // `git status` for untracked PNGs after every VRT run until the pair exists.
  { type: 'cofefve', pages: 6 },
  // FACE BATCH 4 (2026-08-11) — the random source. SIX bands, six rendered: the
  // hero promotes the loop PANEL and DÉJÀ VU out of T LOOP (which keeps LENGTH)
  // and nothing empties.
  //
  // ⚠ FREE-RUNNING AND NOT A FREEZE WITNESS, which is worth stating because a
  // draft of this entry claimed the opposite and it took reading
  // `glyphBinding` to disprove it. marbles genuinely produces from the instant
  // it spawns — measured at the shipped defaults, 16 `clk` edges in 8 s
  // (2.000 Hz), 6 `t1` and 10 `t2` — but it declares NO `audio` output (t1/t2/
  // clk are `gate`, x1/x2/x3 are `cv`), and `primaryAudioOutPortId` matches
  // `type === 'audio'` only. So no glyph on this module can resolve to a live
  // analyser tap; the face therefore declares `glyph: 'none'` rather than a
  // `meter` that would render twelve segments at a hard-coded 0. There is
  // nothing here for #1420's freeze to hold still. analogVco and
  // macrooscillator remain the roster's two witnesses.
  //
  // ⚠ THE DOCK TILE IS DETERMINISTIC BY CONSTRUCTION, not by the freeze. Its
  // hero picture has no clock, no playhead and no analyser — every pixel is a
  // pure function of the thirteen params through `marblesLoopPlan` — so it
  // captures identically on a running graph, a frozen one and a silent rack.
  { type: 'marbles', pages: 6 },
  // FACE BATCH 4 — the clean multi-mode filter. FOUR params and no declared
  // `pages`, so the dock renders the single page-less `__all` band; the hero
  // promotes CUTOFF out of it and the remaining three (RESO, MODE, MIX) keep it
  // alive, so unlike `noise` it does NOT empty to zero.
  //
  // ⚠ ITS SIDEBAR PICTURE IS PARAM-DERIVED, NOT AN ANALYSER TRACE, which is
  // what makes this tile deterministic. Every point of the response curve is a
  // pure function of the four durable params through the SVF's own transfer
  // function (`resofilter-face-model`) — no engine read, no rAF, no
  // `AudioContext.currentTime` — so it is identical on a running graph, a
  // frozen graph and an empty rack. Like cofefve and clouds, this scene is NOT
  // a witness for #1420's freeze.
  //
  // The `scope` glyph on the COMPACT tile IS a live analyser trace, and it is
  // flat for the ordinary insert reason: nothing patched in, so both outputs
  // are exactly 0.000e+0 (measured, all five modes, including at resonance
  // 0.999 where the filter is a hair from self-oscillating — a linear SVF with
  // no input has nothing to ring).
  //
  // ⚠ THE DOCK TILE FRAMES A FIVE-BUTTON SEGMENTED ROW WITH THREE OF ITS FIVE
  // CAPTIONS ELLIPSIZED, AND THE BASELINE IS SUPPOSED TO SHOW THAT. MODE
  // declares `options` for the first time in this PR; `.seg` is `flex: 1 1 0%`,
  // so the 182.5 px cell splits into 31 px buttons = 15.0 px of content box,
  // and the captions lay out at LP 14.13 · HP 16.02 · BP 15.11 · NT 15.72 px.
  // HP, NT and AP therefore paint as `H…`, `N…`, `A…` — the same state the
  // SHIPPED `filter` dock has been in since #1430 (`LP · H… · B…`), so this
  // scene pins the platform's behaviour rather than a regression.
  //
  // ⚠ IF A FUTURE DIFF SHOWS THOSE THREE CAPTIONS SUDDENLY COMPLETE, that is
  // the `.seg { flex: 1 1 auto }` fix landing (it is worth ~1 px per button,
  // which is all this needs) — ACCEPT it, and expect the sibling Segmented
  // modules to move in the same run. No DOM gate can tell you: `scrollWidth`,
  // `measureText` (which drops `letter-spacing`) and `faces-parity`'s
  // `textContent` read all five as clean today. This baseline is the only
  // surface in the repo that can see it.
  { type: 'resofilter', pages: 1 },
  // FACE BATCH 4 — the exciter-driven resonator. THREE declared bands, three
  // rendered: the hero promotes the comb panel, POSITION and the STRUM audition
  // out of band 3, which still holds LEVEL, so nothing empties.
  //
  // ⚠ THIS TILE IS DETERMINISTIC FOR THE STRONGEST REASON IN THE ROSTER, and
  // it is worth distinguishing from the "unpatched insert is silent" cases
  // (cofefve, mixer, reverb). rings is not merely quiet at rest — it is
  // BIT-ZERO: measured peak exactly 0.000e+0 on both taps, in both models, over
  // a 1 s render of the shipping worklet with nothing patched and nothing
  // struck. There is no internal exciter, no free-run and no noise floor, so
  // the `scope` glyph on the compact tile has nothing to draw whether the graph
  // is frozen or running. This scene therefore does NOT depend on #1420's
  // freeze — unlike analogVco, macrooscillator and noise, which are the
  // roster's real witnesses for it.
  //
  // ⚠ AND THE HERO PICTURE IS DRAWN, NOT TRACED. Every bar of the pickup comb
  // is a pure function of the durable params through `RingsModal.configure`'s
  // own laws (rings-face-model.ts) — no analyser, no rAF, no engine read — so
  // the dock tile is identical on a frozen graph, a live graph and a silent
  // rack. That is what lets a module with no sound at rest still have a
  // faceplate that says something.
  { type: 'rings', pages: 3 },
  // THE FACEPLATE QUEUE · Q6 — the 4-channel attenuating mixer.
  //
  // `pages` is the POST-hero-split band count. It equals the declared
  // `face.pages` length here because attenumix's hero promotes NOTHING out of a
  // band — it is a readouts-only hero (no `cell`, no `control`, no `action`),
  // which `heroFacePlan` supports on its own — so no band can be emptied and
  // dropped.
  //
  // DETERMINISTIC by construction, like rings and unlike analogVco: this module
  // carries NO glyph at all (`primaryAudioOutPortId` resolves `out1`, one of
  // four channel direct outs, so a meter here would paint a lie — see the
  // face's own comment), and all three readouts are pure functions of the five
  // params. Every pixel is identical on a frozen graph, a live graph and a
  // silent rack.
  { type: 'attenumix', pages: 2 },
  // FACE BATCH 6 · the stereo sidechain ducker. `pages: 3` is the POST-hero
  // split count: three declared pages, and promoting `threshold` into the hero
  // leaves `detect` with knee + sc_hpf rather than emptying it, so no band is
  // dropped (heroFacePlan only drops an EMPTIED band — the `noise` case).
  //
  // DETERMINISTIC AT REST BY CONSTRUCTION, and unusually so for a face with a
  // live glyph: sidecar is an INSERT with four audio inputs and no generator of
  // its own, so on the VRT rack nothing is patched, the worklet's `outAL` is
  // `audio + sc·(…)` over two silent inputs, and the meter tap reads bit-zero
  // whether the graph is frozen or running. It therefore neither exercises nor
  // depends on #1420's pre-frame freeze — the mixer / reverb / clouds property.
  { type: 'sidecar', pages: 3 },
  // FACE BATCH 6 · the two-engine spectral resynthesizer. `pages: 5` is the
  // POST-hero split count: five declared pages, and promoting `spectralPartials`
  // into the hero leaves `engine` with MODE + BANDS rather than emptying it, so
  // no band is dropped (heroFacePlan only drops an EMPTIED band — the `noise`
  // case). Five is also comfortably under DOCK_TAB_MIN_BANDS, so this face
  // packs rows rather than growing a tab rail.
  //
  // DETERMINISTIC AT REST, and MEASURED rather than assumed: it is an EFFECT,
  // so with nothing patched into `audio_in` the worklet writes bit-exact zeros
  // to both channels (art/scenarios/warrensspectrum/cv-path.test.ts asserts
  // `peak |sample| === 0` on the silent-input leg), and the `meter` glyph tap
  // therefore reads zero whether the graph is frozen or running. Like sidecar
  // it neither exercises nor depends on #1420's pre-frame freeze.
  //
  // ⚠ ITS DOCK SCENE CARRIES A PANEL, which is new for this roster's tail: the
  // `ws-filterbank-{n}` cell paints eight bars whose heights come from the
  // SAVED band table, not from an analyser — pure geometry off `node.data`, no
  // clock and no tap, so the picture is the same on a silent rack and a running
  // one. That is why it needs no mask and no VRT_LIVE_SURFACES entry.
  { type: 'warrensspectrum', pages: 5 },
  // THE FACEPLATE QUEUE · Q9 — the timbre-sweep oscillator. `pages: 2` is the
  // POST-hero split count: two declared pages, and promoting `wavePos` into the
  // hero leaves `wave` holding `pmAmount` rather than emptying it, so no band is
  // dropped (heroFacePlan only drops an EMPTIED band — the `noise` case).
  //
  // ⚠ THE THIRD FREE-RUNNING ENTRY, after analogVco and macrooscillator, and
  // therefore the third scene that EXERCISES #1420's pre-frame freeze rather
  // than being indifferent to it. It sounds the instant it spawns: `factory`
  // posts the table and the worklet's phase accumulator advances on
  // `freq / sampleRate` with no gate, no note and no input required — three of
  // its four worklet inputs can be empty and it still runs. Its `scope` glyph
  // is a live analyser tap on `audio`, so without the freeze it would draw a
  // moving trace, which is exactly the condition that measured 254/154/315 px
  // on analogVco before #1420.
  //
  // ⚠ WHAT IT IS *NOT*: a fourth independent witness. analogVco fails a
  // mis-ordered freeze at a hard, repeatable 337 px and macrooscillator fails
  // it INTERMITTENTLY (0/0/192/173 over four boot pairs) — that pair is what
  // establishes the failure mode is module-dependent, and this entry has not
  // been probed with `AUDIT_NO_FREEZE=1` / `PROBE_FREEZE_LATE=1` at all. It is
  // enrolled as an ordinary strict scene that happens to depend on the freeze;
  // do not cite it as coverage for the ORDERING regression until someone runs
  // `vrt-face-audio-probe` against it and writes the numbers here, and do not
  // retire either of the two witnesses on the strength of it.
  //
  // No mask, like both of them: it is captured strict, glyph included.
  { type: 'wavetableVco', pages: 2 },
  // THE FACEPLATE QUEUE · Q11 — the ⅓-ladder modulation fan-out.
  //
  // `pages: 1` is the POST-hero split count: the face declares NO `pages`, so
  // its two ranked keys sit in the single unlabelled `__all` band, and the hero
  // promotes RATE out of it leaving WAVEFORM behind. One key remains, so the
  // band survives — this is NOT the `noise` case where the only key was
  // promoted and `heroFacePlan` dropped the emptied band to `pages: 0`.
  //
  // ⚠ DETERMINISTIC FOR A REASON WORTH DISTINGUISHING FROM BOTH ESTABLISHED
  // ONES, and it is neither "silent at rest" (rings, sidecar, warrensspectrum)
  // nor "free-running and saved by #1420's freeze" (analogVco, macrooscillator,
  // wavetableVco). This module IS free-running — nine phase accumulators
  // advance from the moment it spawns, with no gate and no input — but NOTHING
  // ON THE FACE READS THEM. Its glyph is `waveform`, and with every declared
  // output typed `cv` there is no audio output for `primaryAudioOutPortId` to
  // resolve, so `glyphBinding` returns `{ kind: 'wave-morph' }`: a single cycle
  // of the `shape` morph derived from the DURABLE param, no analyser, no tap,
  // no rAF. The picture is byte-identical on a frozen graph, a live graph and a
  // silent rack.
  //
  // So this scene neither exercises nor depends on #1420's pre-frame freeze,
  // and it is NOT a fourth free-running witness for it — the mechanism that
  // would make it one (a live tap) is exactly the one the face declines to use.
  // See `ninelives-face-model.test.ts` for both halves of that resolution,
  // including the negative control that `glyph: 'meter'` here would have
  // painted a VuMeter with no tap at all (the marbles defect).
  { type: 'ninelives', pages: 1 },
  // FACE BATCH 6 · the four-stage destructive echo. `pages: 2` is the POST-hero
  // split count: two declared pages, and promoting `feedback` into the hero
  // leaves `the loop` with DECAY + MIX rather than emptying it, so no band is
  // dropped (heroFacePlan only drops an EMPTIED band — the `noise` case).
  //
  // DETERMINISTIC AT REST, and MEASURED rather than assumed: it is an INSERT
  // with no generator of its own, so with nothing patched into L the worklet
  // writes bit-exact zeros to both outputs — asserted as `peak |sample| === 0`
  // on the silent-input leg of art/scenarios/charlottes-echos/cv-path.test.ts,
  // through the DEF'S OWN FACTORY, which is where the factory's `silenceL`
  // ConstantSource would show up if it were producing anything. Its `scope`
  // glyph tap therefore reads zero whether the graph is frozen or running: like
  // sidecar and warrensspectrum it neither exercises nor depends on #1420's
  // pre-frame freeze, and it is NOT the analogVco free-running case.
  { type: 'charlottesEchos', pages: 2 },
  // THE FACEPLATE QUEUE · Q13 — the wogglebug. `pages: 2` is the POST-hero
  // split count: two declared pages, and promoting `rate` into the hero leaves
  // `the roll` holding CHAOS rather than emptying it, so no band is dropped
  // (heroFacePlan only drops an EMPTIED band — the `noise` case).
  //
  // ⚠ DETERMINISTIC FOR THE ninelives REASON, REACHED FROM THE OPPOSITE PORT
  // SHAPE — which is worth distinguishing from all three established classes.
  // This module is emphatically FREE-RUNNING: a wall-clock `setTimeout` fires
  // the first woggle 50 ms after it spawns and every jack moves from then on,
  // with no gate and no input. It is NOT "silent at rest" (rings, sidecar,
  // warrensspectrum, charlottesEchos). But it is also NOT the
  // free-running-and-saved-by-#1420's-freeze class (analogVco,
  // macrooscillator, wavetableVco), because NOTHING ON THE FACE READS THE
  // OUTPUTS: the face declares `glyph: 'none'`, so `glyphBinding` returns
  // `{ kind: 'none' }`, no analyser is ever attached, no rAF runs, and the five
  // readouts are pure functions of the DURABLE params. The scene is
  // byte-identical on a frozen graph, a live graph and a silent rack.
  //
  // ⚠ AND THE 'none' IS LOAD-BEARING FOR EXACTLY THAT, so do not "add a glyph"
  // here without re-deriving this paragraph. This def HAS an audio output
  // (`ring`), so unlike ninelives the resolver WOULD bind live: any glyph but
  // 'none' resolves `{ kind: 'live-audio', portId: 'ring' }` on a free-running
  // source, which is the analogVco condition that measured 254/154/315 px
  // across three captures of one tile before #1420. So this scene neither
  // exercises nor depends on the pre-frame freeze TODAY, and adding a glyph
  // would move it into the class that does. See `buggles-face-model.test.ts`
  // for both halves of the resolution.
  { type: 'buggles', pages: 2 },
  // THE FACEPLATE QUEUE · Q12 — the two fixed filter banks, as a PAIR.
  //
  // `pages: 1` on both, and it is the honest shape rather than an omission:
  // every control is a level on a fixed section, the only structure is the
  // frequency axis `face.order` already carries, and a register split fine
  // enough to be useful would cross DOCK_TAB_MIN_BANDS and turn a graphic EQ
  // into a tab rail. So both dock scenes render the page-less `__all` band —
  // fourteen cells for the 914, ten for the 907A, one row each (fader cells are
  // width-class 'column', so DOCK_ROW_MAX_CONTROLS does not split them into a
  // second row and the band is never split anyway).
  //
  // DETERMINISTIC AT REST, structurally: both are pure BiquadFilterNode +
  // GainNode fans with NO generator anywhere in them, so an unpatched `audio`
  // input leaves the summing bus carrying nothing at all — there is no worklet
  // and no ConstantSource that could produce a floor. Their `meter` glyphs
  // therefore read zero whether the graph is frozen or running: like sidecar,
  // warrensspectrum and charlottesEchos they neither exercise nor depend on
  // #1420's pre-frame freeze, and neither is the analogVco free-running case.
  //
  // ⚠ THE GLYPH RESOLVES, and it was established rather than assumed (#1692's
  // finding was a `meter` that fell through to `{ kind: 'static' }` and painted
  // twelve segments that could never light). Both defs declare a single output
  // typed `audio`, so `primaryAudioOutPortId` returns `'audio'` and
  // `glyphBinding` returns `{ kind: 'live-audio', portId: 'audio' }` — asserted
  // for both modules, with a negative control, in
  // moog-filterbank-face-model.test.ts.
  { type: 'moog907a', pages: 1 },
  { type: 'moog914', pages: 1 },
  // MIXMSTRS — the full mixer, and the largest face in this roster by 1.86x
  // (91 cells against pentemelodica's 49).
  //
  // `pages: 4` is the POST-hero-split band count. The declared `face.pages`
  // length is 4 and the hero promotes `master_volume` out of `channels`, which
  // still leaves that band four clusters of eight — non-empty, so `heroFacePlan`
  // drops nothing and 4 is also what the dock renders. (It was 5 until the owner
  // review of #1738 merged the separate `levels` band into `channels` as its
  // first cluster, so each fader heads its own channel's column.) The ceiling is
  // `DOCK_TAB_MIN_BANDS = 7`, where the dock becomes a tab rail and shows one
  // band at a time — which would take the eight faders out of one frame.
  //
  // ⚠ THE GLYPH RESOLVES, established not assumed (the #1692 finding). The def's
  // first `audio`-typed output is `masterL`, so `primaryAudioOutPortId` returns
  // it and `glyphBinding` returns `{ kind: 'live-audio', portId: 'masterL' }` —
  // NOT the `{ kind: 'static' }` dead-segment shape. On this module that also
  // means the meter taps the MASTER BUS rather than a per-channel direct out:
  // #1667 (auto-wire grabbing `outputs[0]`) is open precisely because
  // `attenumix.outputs[0]` is a direct out, and mixmstrs is on the right side of
  // it. Asserted, with the port named, in mixmstrs-face-model.test.ts.
  //
  // ⚠ AND THE METER IS DELIBERATELY NOT THE PER-CHANNEL VU. `read('levels')` is
  // a mono-sum tap (`mixmstrs.dsp:349-356`) measured to read 0.0000e+0 on an
  // anti-phase channel that masterL and masterR each carry at rms 0.184216.
  // Nothing in this scene paints it.
  //
  // Deterministic on a silent rack like every sibling: a mixer contains no
  // generator, so with nothing patched masterL is bit-exactly zero.
  //
  // ⚠ THE ONLY ENTRY THAT DECLARES `foldHeight`, and it is the reason that field
  // exists. The unfolded pane MEASURES 1623 CSS px, so at the shared 1400 it
  // starts at y = -290 and cannot be framed; `foldViewportFor` gives this scene
  // 2048 (425 px of headroom) and leaves every other scene's viewport — and
  // therefore every other committed baseline — untouched. See the measurement
  // on `foldViewportFor` for why raising the shared constant is NOT a no-op.
  { type: 'mixmstrs', pages: 4, foldHeight: 2048 },
  // THE FACEPLATE QUEUE · Q14 — quad slew + 4→1 sequential switch. `pages: 2`
  // is the declared count AND the post-hero count, because this face promotes
  // NO control into the hero: its hero is readouts only (the attenumix /
  // moog907a / moog914 shape, for their reason — one of four interchangeable
  // dials drawn four times larger claims something untrue). `heroFacePlan`
  // therefore removes nothing and neither band can be emptied.
  //
  // DETERMINISTIC AT REST, and for a stronger reason than the effects above:
  // this module has no oscillator and no internal clock of any kind. The switch
  // advances only on a `step_clock` EDGE, which is an external input, and the
  // four one-poles converge on whatever is patched — so with nothing patched
  // every output holds a constant. It neither exercises nor depends on #1420's
  // pre-frame freeze, and it is not the analogVco free-running case.
  //
  // ⚠ THE GLYPH IS 'none', SO THERE IS NO TAP TO BE NON-DETERMINISTIC — and
  // that is a measurement, not a convenience. `primaryAudioOutPortId` returns
  // NULL here (six `cv` outputs, one `gate`, no `audio`), the ninelives case;
  // and unlike ninelives there is no `shape` param to make 'waveform' honest
  // either, so EVERY candidate glyph resolves `{ kind: 'static' }`. The dock
  // scene therefore shows the seven-row output table where other scenes show a
  // trace. See slewswitch-face-model.test.ts.
  //
  // ⚠ THE DOCK SCENE SEES THE TOP ~425 px, so treat a green dock capture as
  // evidence about the hero row and the first band ONLY. This face's band
  // structure is gated by faceplate-platform.spec.ts and the pure dock-row-plan
  // / module-face-lint units, which read the whole faceplate — and it has a
  // SOLO band by construction (`switch` carries two `segmented` cells, which
  // `cellWidthClass` classifies WIDE), which is exactly the kind of layout fact
  // the 425 px window is blind to.
  { type: 'slewSwitch', pages: 2 },
  // THE FACEPLATE QUEUE · Q15 (COHORT 3) — the curve-morph attenuverter.
  //
  // THREE bands, all three surviving the hero split: the hero promotes `aCurve`
  // out of band `a`, which still holds `aAtten`, so nothing is emptied and the
  // count stays 3 (`unity` holds one control by design — the attenumix `bus` /
  // mixer `bus` / reverb `output` shape).
  //
  // ⚠ THE FIRST FACE IN THIS ROSTER WITH `glyph: 'none'` DECLARED FOR A
  // STRUCTURAL REASON, and it is worth naming here rather than leaving it to be
  // read as an omission. The module has THREE `cv` outputs and no `audio`
  // output at all, so `primaryAudioOutPortId` returns null and every glyph kind
  // but 'none' resolves to `{ kind: 'static' }` — the marbles defect (#1692):
  // a live-looking readout of nothing, which a VRT baseline captures perfectly
  // deterministically and therefore cannot see. `module-face-lint`'s dead-glyph
  // clause is unconditional and refuses it at the source; the compact tile here
  // simply gets the extra control cell instead of a glyph plate.
  //
  // DETERMINISTIC AT REST, structurally, and NOT via the #1420 freeze: the
  // worklet is a stateless per-sample function with no generator anywhere in
  // the factory — no oscillator, no ConstantSource, no pump — so an unpatched
  // module emits exactly zero and there is no live surface to freeze. Measured
  // twice in `art/scenarios/unityscalemathematik/cv-path.test.ts`: two
  // independent renders of the same patch are BIT-IDENTICAL (#1680).
  { type: 'unityscalemathematik', pages: 3 },
  // THE FACEPLATE QUEUE · Q16 — the audio→CV feature extractor (2026-08-15).
  //
  // TWO bands, both surviving the hero split: the hero promotes `bipolar` out of
  // band `feature`, which still holds gain/attack/release, and band `onset`
  // holds its two. Nothing is emptied, so the count stays 2.
  //
  // `glyph: 'none'` for the same structural reason as unityscalemathematik
  // above — three `cv` outputs and one `gate`, no `audio` output, so every
  // glyph but 'none' resolves to `{ kind: 'static' }`.
  //
  // ⚠ THIS SCENE CARRIES THE FIRST SIDEBAR PANEL IN THE ROSTER WHOSE MODULE
  // COULD HAVE BEEN TRACED LIVE AND IS NOT, and that is what makes it
  // deterministic. `FeaturecvCard.svelte` pumps three meters off
  // `engine.read(node,'snapshot')` every rAF; the face draws `featurecv-maps`
  // from the DSP's own constants instead, so the picture is a pure function of
  // `node.params` and there is no analyser, no rAF and nothing for the #1420
  // freeze to be load-bearing about. The module is ALSO silent at rest by
  // construction (an analyser with one input and no generator anywhere in the
  // factory — the muted keep-alive is a `gain.value = 0` sink), so a bare tile
  // emits exactly the polarity floor on three DC jacks.
  { type: 'featurecv', pages: 2 },
  // THE FACEPLATE QUEUE · Q17 — the attenuverter / math / logic utility.
  //
  // `pages: 1` is the POST-hero split count, the ninelives shape: the face
  // declares NO `pages`, so its four ranked keys sit in the single unlabelled
  // `__all` band and the hero promotes ATT1 out of it, leaving three. The band
  // survives — this is NOT the `noise` case where the only key was promoted and
  // `heroFacePlan` dropped the emptied band to `pages: 0`.
  //
  // DETERMINISTIC AT REST, and for the cleanest reason in this roster: the
  // module contains NO generator of any kind. Its factory builds GainNodes,
  // WaveShaperNodes and one ConstantSource whose whole job is the `1 − x`
  // inversion, so with nothing patched every jack is a constant. Measured
  // through the real factory: att1..att4 / sum / diff / and / or all sit at
  // 0.000000 and — the one thing worth flagging for anyone reading a bare tile
  // — nand and not sit at a constant 1.000000, from sample 0. There is no
  // analyser, no rAF and no tap: `glyph` is 'none' because
  // `primaryAudioOutPortId` returns null (six `cv` outputs, four `gate`, no
  // audio), and the sidebar picture is drawn from `node.params` alone. So this
  // scene neither exercises nor depends on #1420's pre-frame freeze.
  { type: 'illogic', pages: 1 },
  // THE FACEPLATE QUEUE · Q18 — the bitcrusher / sample-rate decimator.
  //
  // `pages: 1` is the POST-hero split count, the illogic / ninelives shape: the
  // face declares NO `pages`, so its three ranked keys sit in the single
  // unlabelled `__all` band and the hero promotes DECIMATE out of it, leaving
  // BITS and WET. The band survives — this is NOT the `noise` case where the
  // only key was promoted and `heroFacePlan` dropped the emptied band.
  //
  // DETERMINISTIC AT REST because it is an INSERT with no generator: the
  // factory instantiates the Faust node plus ONE ConstantSource whose offset is
  // 0 (it exists only to keep the worklet processing), so with nothing patched
  // the single `audio` output is exactly zero and its `scope` glyph is the flat
  // centreline every other faced insert draws. It therefore neither exercises
  // nor depends on #1420's pre-frame freeze — the two free-running witnesses
  // (analogVco, macrooscillator, noise) are what cover that.
  //
  // ⚠ THE FOUR HERO READOUTS ARE PURE FUNCTIONS OF `node.params` and print at
  // the spawn defaults, so they are IN the dock image and a re-rank or a
  // formatter change moves this baseline: `48.0 kHz · 768 kbit/s · -101.1 dB ·
  // -96.3 dB` at DECIMATE 1 / BITS 16 / WET 1.
  { type: 'destroy', pages: 1 },
  // THE FACEPLATE QUEUE · Q19 — the CONTINUOUS logic block, `illogic`'s sibling.
  //
  // `pages: 1` is the POST-hero split count, the illogic / destroy / ninelives
  // shape: the face declares NO `pages`, so its two ranked keys sit in the single
  // unlabelled `__all` band and the hero promotes ATT A out of it, leaving ATT B.
  // The band survives — this is NOT the `noise` case where the only key was
  // promoted and `heroFacePlan` dropped the emptied band.
  //
  // DETERMINISTIC AT REST, and for the same reason as illogic only more so: the
  // factory builds exactly ONE AudioWorkletNode and nothing else — no
  // ConstantSource, no analyser, no rAF, no generator of any kind. Measured
  // through the real factory, an unpatched module emits BIT-EXACT ZERO on all
  // five jacks from sample 0 (illogic's nand/not sit at a constant 1; this one
  // has no such source). `glyph` is 'none' because `primaryAudioOutPortId`
  // returns null (five `cv` outputs, no audio), so the shell paints no tile at
  // all, and the sidebar picture is drawn from `node.params` alone. This scene
  // therefore neither exercises nor depends on #1420's pre-frame freeze.
  //
  // ⚠ THE FOUR HERO READOUTS ARE PURE FUNCTIONS OF `node.params` and print at
  // the spawn defaults, so they are IN the dock image and a re-rank or a
  // formatter change moves this baseline: `×0.96 · ×0.00 · ×0.76 · ×2.00` at
  // ATT A +1 / ATT B +1.
  { type: 'analogLogicMaths', pages: 1 },
  // THE FACEPLATE QUEUE · Q28 — the Moog 921 oscillator, as a PAIR: a CV-only
  // driver and the slave it drives.
  //
  // `pages: 1` on both, and it is the POST-hero split count (the illogic /
  // destroy / analogLogicMaths shape): neither face declares `pages`, so the
  // ranked keys sit in the single unlabelled `__all` band and each hero
  // promotes ONE key out of it — FREQ on the driver, leaving RANGE + WIDTH;
  // RANGE on the slave, leaving FREQ, LEVEL, FM and SYNC. Both bands survive.
  //
  // ⚠ THEIR GLYPHS DIFFER, WHICH IS WHY THEY ARE ONE ENTRY. `moog921a`'s two
  // outputs are `cv`, so `primaryAudioOutPortId` is null and its face declares
  // `glyph: 'none'` — the shell paints NO tile at all, and the compact scene is
  // three cells with no picture. `moog921b`'s four outputs are `audio`, so
  // `glyphBinding` returns `{ kind: 'live-audio', portId: 'sine' }` and the
  // compact scene has a trace beside two cells.
  //
  // ⚠ moog921b JOINS THE ROSTER'S FREE-RUNNING SET, so this scene EXERCISES
  // #1420's pre-frame audio freeze rather than being indifferent to it. ⚠ NO
  // ORDINAL, deliberately: "the Nth free-running entry" is a population count,
  // and the entries above already have to be read together to work out what N
  // is (analogVco, macrooscillator, wavetableVco and noise are all in it, and
  // the `destroy` note calls that set "two" while naming three of them). The
  // PROPERTY is what matters and it is stated per entry. It is a VCO
  // with no gate and no note to wait for: the factory feeds silence to all five
  // inputs purely to keep the worklet processing, the bus normals to 0 V = C4
  // and the width bus normals to a 50 % square, so `sine` is a full-scale
  // 261.626 Hz tone from sample 0. It carries NO mask, exactly like its two
  // predecessors: with the graph frozen before the tile is framed the analyser
  // reads zeros and the glyph draws the same flat centreline everything else
  // does. ⚠ WHAT WOULD SILENTLY RETIRE THAT PROPERTY: nothing here — unlike
  // macrooscillator there is no engine selector that could move the default
  // onto a struck voice. The only way this scene stops exercising the freeze is
  // if `level` stops defaulting to unity.
  //
  // ⚠ moog921a IS THE OPPOSITE AND IS ALSO WORTH NAMING: it has no audio path
  // at ALL — no oscillator, no analyser, no rAF — so its tile is deterministic
  // by construction rather than by the freeze, like illogic and
  // analogLogicMaths.
  //
  // ⚠ BOTH HEROES' READOUTS ARE PURE FUNCTIONS OF `node.params` and print at
  // the spawn defaults, so they are IN the dock image and a re-rank or a
  // formatter change moves these baselines. At the shipped defaults the driver
  // reads `+0.00 V · 130.8 Hz … 523.3 Hz · 50 %` and its sidebar reads
  // `261.6 Hz` twice (the RANGE switch is inert at the dial's centre, which is
  // the face's own rank argument made visible); the slave reads
  // `261.6 Hz · +0.00 oct · +0.0 dB · off · off`. Those exact strings are
  // pinned in `moog921-face-model.test.ts`, so a formatter change reddens the
  // unit lane before it reddens a baseline.
  { type: 'moog921a', pages: 1 },
  { type: 'moog921b', pages: 1 },
  // THE FIRST VIDEO FACE. Its `pages` are feedback / loop / colour / key /
  // switches / tv screen / virtual camera — enough bands to reach
  // DOCK_TAB_MIN_BANDS, so the dock scene captures a TAB RAIL with one band
  // under it. (That list changed in owner review round 1: `geometry` was folded
  // into `feedback` and the shell's `__unpaged` catch-all — which it labels
  // `more` — disappeared once FEEDBACK was claimed by a real page.)
  //
  // ⚠ IT IS THE FIRST SCENE IN THIS ROSTER WITH A LIVE PICTURE IN IT, and an
  // AudioContext suspend cannot pin that. The dock faceplate mounts the
  // module's `fullViewBody` extension — a real video surface blitting the
  // engine's output every rAF — which is the `analogVco` non-determinism class
  // (254 / 154 / 315 px across three captures of one tile) with a bigger
  // subject. `videoFaceWhy` turns on the same fix the module's own card scene
  // already uses (`vrt-scenes.ts`): write backdraft's `freeze` param after the
  // settle, so the ring and the output hold their last frame.
  //
  // That param exists for exactly this and says so — it is declared
  // `noUserControl` with `writer: 'internal'`, `why: 'determinism toggle for
  // VRT capture'`. It is NOT a general "freeze anything called freeze" rule:
  // `clouds:freeze` is a player-facing latch and writing it would change that
  // module's look on purpose, which is why this is a per-scene DECLARATION with
  // a reason rather than a predicate over param names.
  // THE SECOND VIDEO FACE, and the first scene in this roster whose module
  // ranks NOTHING (#1821). `pages: 1` is the single unlabelled `__all` band
  // `dockFacePlan` returns for a face with no `face.pages` — it renders as one
  // empty `face-page` section under the extension body, which IS the faceplate
  // here (videoOut declares `params: []`).
  //
  // ⚠ `videoFaceWhy` is MANDATORY and doubly so for this one: the dock body
  // blits the live engine every rAF, and unlike backdraft the COMPACT tile is a
  // live picture too (`hasVideoSurface` mounts VideoTileThumb, and a zero-control
  // face never reaches the plate branch that would evict it — see
  // videoout-face-model.test.ts). Both scenes are moving targets without the
  // video freeze; an AudioContext suspend says nothing about either.
  {
    type: 'videoOut',
    pages: 1,
    videoFaceWhy:
      'BOTH scenes carry a live picture: the dock faceplate IS a fullViewBody extension blitting '
      + 'the video engine every rAF, and the compact lane tile paints a live VideoTileThumb because '
      + 'this face ranks no controls and so keeps its glyph strip at every tier. Neither is '
      + 'pixel-deterministic without the video freeze.',
  },
  {
    type: 'backdraft',
    pages: 7,
    videoFaceWhy:
      'the dock faceplate mounts a fullViewBody extension that blits the live video engine every ' +
      'rAF; the compact tile is static today but is pinned the same way so a future lane picture ' +
      'cannot silently make this scene a moving target',
    // CAPTURED, twice, both counted against a prediction made first — per the
    // "a green dispatch that committed nothing is a RED FLAG" rule:
    //
    //   authoring        predicted 2, committed 2 (compact + dock), nothing else
    //   owner round 1    predicted 1, committed 1 (dock only)
    //   fader migration  predicted 2, committed 2 (both MODIFIED, 0 added/deleted)
    //   main unblock     predicted 1, committed 1 (dock only)
    //
    // ⚠ The round-1 asymmetry is the useful part: the faceplate was
    // restructured completely — tabs renamed and reordered, a page deleted, the
    // hero row removed, a band stacked into three rows, a new button — and
    // `face-backdraft-compact` did NOT move by so much as a pixel. The COMPACT
    // LANE TILE reads `order` / `paramCells` / `xyPads` / `glyph`, and `hero`,
    // `pages`, `clusters` and the extension body are all DOCK-ONLY. A face can
    // be rebuilt at the dock and leave the lane byte-identical, which is worth
    // knowing before anyone reads a green compact scene as coverage of a
    // faceplate change.
    //
    // ⚠ AND THE FADER MIGRATION (#1822) MOVED BOTH, which is the same lesson
    // from the other side: that change was to the fader PRIMITIVE rather than
    // to any dock-only declaration, so it reached every tier that paints a
    // fader cell. Which scenes move tells you WHICH LAYER changed — declaration
    // or primitive — and the count alone does not. Both blob hashes were
    // recorded before the dispatch and re-read after, so "2 files touched" is
    // known to be "2 files genuinely different" rather than a re-timestamp.
    //
    // ⚠ THE MAIN-UNBLOCK ROW IS THE ONE THAT NEEDED AN ARGUMENT, because the
    // compact scene was PASSING and a capture cannot regenerate a passing
    // baseline — so "it went green" would have been indistinguishable from "it
    // is stale but under COMPACT_MAX_DIFF", and only an explicit `git rm`
    // reaches the second case. #1805 changed the fader PRIMITIVE again (it
    // deleted the resting readout outright), which by the row above should have
    // reached every tier that paints a fader cell. It did not, and the reason is
    // that the readout was never a lane element in the first place:
    // `persistentReadout={faceplateView}` bound it to the DOCK tier alone, so
    // the compact tile had nothing to lose. Three independent legs agree —
    // `min-width: 900px` sat on `.faceplate-body` (the dock plate, not the lane
    // tile); backdraft declares NO `format` on any param, so KnobConic's
    // format-suppression change (what moved the eight compact baselines that
    // DID move) cannot reach it; and `flicker`, the roster that newly paints a
    // NAME, is dock-only in `face.order` while compact shows the first 2-3 of
    // feedback/zoom/mix. The dock scene, by contrast, failed on a DIMENSION
    // mismatch (900x523 -> 657x509), which no diff budget can absorb.
  },
] as const;

/** TIGHT per-scene diff budgets (absolute pixels; Playwright takes the MIN of
 *  this and the config ratio budget).
 *
 *  ⚠ COMPACT_MAX_DIFF IS CURRENTLY INERT, and saying so is the point — a budget
 *  nobody has re-measured reads as protection it may not provide. MEASURED
 *  2026-08-08: a compact tile is 88×82 = 7216 px, and vrt.config's
 *  `maxDiffPixelRatio` was TIGHTENED from 0.05 to 0.01 on 2026-07-31, so the
 *  ratio now allows 72 px and is the binding term. 150 was chosen against the
 *  old 0.05 (~350 px) and has been the looser of the two ever since. It is kept
 *  because it is the DECLARED intent and it binds again on any tile over
 *  15 000 px, not because it is doing work today. The dock
 *  faceplate is a full-width element (1220 × 322…1003 now that it is captured
 *  unfolded): 1500 px matches the workflow-shell-zoom scene budget, and it stays
 *  the binding term because Playwright takes the MIN — the config's 0.01 ratio
 *  on even the smallest of these (1220×322) allows 3928 px. Unfolding therefore
 *  did NOT loosen the budget. */
export const COMPACT_MAX_DIFF = 150;
export const DOCK_MAX_DIFF = 1500;

// ── THE FOLD ────────────────────────────────────────────────────────────────
//
// The dock pane is `max-height: min(60vh, 680px)` — declared TWICE, on
// Canvas.svelte's `.dock-fullview-drawer` and on DockFullView's own
// `.dock-faceplate` — wrapped around `.faceplate-scroll` (`overflow: auto`). So
// the captured element's height is `min(content, min(60vh, 680px))`, and
// whatever the content has past that is SCROLLED — absent from the image.
//
// MEASURED (vrt-fold-probe, this worktree, CSS px, content = the
// `.faceplate-scroll` scrollHeight; capture = content + 72 px of pane chrome):
//
//   face           content   hidden @720   hidden at the 680 px cap
//                                          (i.e. at ANY viewport ≥ 1134 px,
//                                           where 60vh stops being the min)
//   drummergirl        930          578          330
//   kickdrum           852          500          252
//   tidyVco            711          359          111
//   sixstrum           681          329           81
//   dx7                679          327           79
//   snaredrum          595          243            0
//   clap               550          198            0
//   pentemelodica      517          165            0
//   filter             402           50            0
//   (the other 12       ≤328           0            0)
//
// So NINE of 21 dock baselines were truncated, which is exactly the nine PNGs
// committed at 425 px — the signature of a clamped capture rather than a
// measured one. THE SECOND COLUMN IS THE POINT: raising the viewport is NOT a
// fix, because `min()`'s other term is a hard 680 px, so five faces stay folded
// at ANY window height. The clamp has to come off for the scene to see the
// faceplate at all.
//
// `unfoldDockPane` takes it off. The capture then contains the whole faceplate
// — the SCROLLABLE CONTENT rather than the WINDOW — which is a deliberate
// choice: a VRT exists to notice that a layout changed, and content the user
// reaches by scrolling is still part of the layout. It costs nothing in
// fidelity because the faceplate's layout does not depend on the pane height
// (measured: `scrollbarW = 0` on every face — Chromium here paints OVERLAY
// scrollbars, so removing the overflow steals no width and the 12 already-
// unfolded faces render byte-identically).
//
// `FOLD_VIEWPORT` then only has to be TALL ENOUGH to hold the unfolded pane:
// the drawer is `position: absolute; bottom: 0`, so a pane taller than its
// container would extend above the viewport top and Playwright could not scroll
// it into view (the container does not scroll). 1400 px is the DEFAULT and the
// dock test ASSERTS the headroom rather than assuming it.
export const FOLD_VIEWPORT = { width: 1280, height: 1400 } as const;

/**
 * The fold viewport for ONE scene — the default, unless the roster entry
 * declares a taller `foldHeight`.
 *
 * ⚠ IT IS PER-SCENE BECAUSE RAISING THE SHARED HEIGHT IS NOT A NO-OP, AND THAT
 * WAS MEASURED RATHER THAN ASSUMED. mixmstrs' unfolded pane is 1623 CSS px (91
 * controls in five clustered sections), so at 1400 it starts at y = -290 and
 * cannot be framed at all — the dock test said so, with the number. The obvious
 * move is to raise `FOLD_VIEWPORT.height` for everyone, and the file's own
 * reasoning invites it: the pane is bottom-anchored at a fixed 1280 px width and
 * `unfoldDockPane` has already removed the one `vh` term in its geometry, so
 * viewport HEIGHT "should not" enter any face's layout.
 *
 * IT DOES. Measured with `vrt-fold-probe`'s diff-vs-baseline leg over the whole
 * roster, same machine and renderer at both heights — a within-subject control,
 * so the local-vs-linux font noise that dominates the absolute numbers cancels:
 *
 *   capture HEIGHT   identical for every face at both heights (tidyVco 783 px …)
 *   diff@1           MOVED on every face (tidyVco 152 427 → 172 388 px;
 *                    kickdrum 153 628 → 193 594; noise 46 058 → 115 538)
 *   diff@26          moved on most (kickdrum 19 307 → 19 883, marbles
 *                    11 154 → 11 738) — i.e. past the threshold the GATE applies
 *   bbox             widened to the right edge and rose to y0 = 0 on nine faces
 *                    (dx7 x1 1139 → 1172, drummergirl y0 28 → 0)
 *
 * INSTRUMENT CONTROL, because "the result differs" and "the instrument reads
 * differently" look identical from that output: two independent probe runs at
 * the SAME height are byte-identical in every reported number. So the movement
 * is the viewport, not run-to-run drift.
 *
 * A face PR that re-pinned forty-two dock baselines to accommodate one new
 * scene would be exactly the "chrome that is not in frame can still move a
 * baseline — through layout, not pixels" class CLAUDE.md says NOT to answer by
 * re-pinning. So the tall scene gets its own viewport and every existing
 * baseline is untouched by construction.
 *
 * ⚠ ROUTE EVERY CALLER THROUGH THIS. An isolation mechanism half the entry
 * points honour is not isolation: `workflow-shell-faces.spec.ts`'s dock scene
 * and `vrt-fold-probe.spec.ts` both resolve here, and a new consumer that
 * reaches for the bare constant would silently put a tall face back in a short
 * window.
 */
export function foldViewportFor(type: string): { width: number; height: number } {
  const entry = FACES.find((f) => f.type === type) as { foldHeight?: number } | undefined;
  return entry?.foldHeight
    ? { width: FOLD_VIEWPORT.width, height: entry.foldHeight }
    : { ...FOLD_VIEWPORT };
}
/** The viewport the scene used before the unfold — reproduces the 432 px clamp
 *  regime for the negative control, and the config default for every other
 *  scene in this file (the compact tile is pinned at 1280×720). */
export const LEGACY_FOLD_VIEWPORT = { width: 1280, height: 720 } as const;
/** The clamp the CSS resolved to at the legacy viewport: `min(60vh, 680px)` with
 *  60vh = 432 px. What the negative control re-applies. */
export const LEGACY_FOLD_CLAMP_PX = 432;
/** The capture height that clamp produced: 432 minus the pane's own 4 px
 *  padding and subpixel rounding. Every one of the nine truncated baselines is
 *  committed at exactly this height, which is how they were identified. */
export const LEGACY_FOLD_PX = 425;

/** The ONE managed style element the fold overrides live in, so the scene can
 *  toggle between regimes instead of accumulating `addStyleTag` layers. */
const FOLD_STYLE_ID = 'vrt-dock-fold';

/**
 * Take the `max-height: min(60vh, 680px)` clamp OFF the dock pane, so the
 * captured element is the whole faceplate rather than its top fold.
 *
 * Both declarations have to go — Canvas's `.dock-fullview-drawer` AND
 * DockFullView's `.dock-faceplate`. Overriding one leaves the other clamping,
 * which looks exactly like a fix and is not; that is why this asserts the
 * result (`hiddenY === 0`) at the call site rather than trusting the CSS.
 */
export async function unfoldDockPane(page: Page): Promise<void> {
  await setFoldStyle(
    page,
    '.dock-fullview-drawer,.dock-faceplate{max-height:none !important;}',
  );
}

/** Put a clamp BACK at `px`, reproducing the pre-fix capture box. Used by the
 *  negative control to demonstrate what the old scene could not see. */
export async function refoldDockPane(page: Page, px: number): Promise<void> {
  await setFoldStyle(
    page,
    `.dock-fullview-drawer,.dock-faceplate{max-height:${px}px !important;}`,
  );
}

async function setFoldStyle(page: Page, css: string): Promise<void> {
  await page.evaluate(
    ({ id, css }) => {
      let el = document.getElementById(id) as HTMLStyleElement | null;
      if (!el) {
        el = document.createElement('style');
        el.id = id;
        document.head.appendChild(el);
      }
      el.textContent = css;
    },
    { id: FOLD_STYLE_ID, css },
  );
  await settle(page);
}

/** Wait until the Canvas dev spawn/viewport hooks are registered. */
export async function waitForHooks(page: Page): Promise<void> {
  await page.waitForFunction(
    () => {
      const w = globalThis as unknown as {
        __setSpawnFlowPos?: unknown;
        __spawnFromPalette?: unknown;
        __flow?: unknown;
      };
      return (
        typeof w.__setSpawnFlowPos === 'function' &&
        typeof w.__spawnFromPalette === 'function' &&
        !!w.__flow
      );
    },
    undefined,
    { timeout: 20_000 },
  );
}

// ── THE AUDIO GRAPH ─────────────────────────────────────────────────────────
//
// `bootWithFace` DID NOT SUSPEND THE AUDIOCONTEXT, and every face scene
// captured off a running graph.
//
// It looked safe because the whole roster is struck or silent: a face's live
// `scope` glyph reads a `createShellGlyphTap` AnalyserNode on the module's
// primary audio output (shell-glyph-live.ts), and a buffer of zeros draws
// exactly the flat centreline an unattached tap draws. The spec header's "no
// audio flows in these scenes" was a property of the ROSTER, not of the scene.
//
// A FREE-RUNNING voice falsifies it. It sounds at spawn with no gate to wait
// for, so the analyser window advances every frame and the glyph draws a
// genuinely moving trace. `toHaveScreenshot` needs TWO CONSECUTIVE IDENTICAL
// captures before it will even compare to a baseline, so such a tile cannot
// baseline at all — measured on analogVco at 254 / 154 / 315 px across three
// captures of the same tile on one commit, which is why its face was authored,
// verified and then dropped (see strict-faces.ts).
//
// This is the SHARED boot path, so the freeze lands once for every present and
// future face rather than per module.
//
// ⚠ ORDER IS LOAD-BEARING IN BOTH DIRECTIONS, and both were MEASURED.
//
//   AFTER the palette spawn. `ensureEngine()` (Canvas.svelte) resumes a
//   suspended context on every call — deliberately, so a restored video rack
//   isn't left silent — and the spawn path calls it. A pre-spawn freeze would
//   be undone by the very next line with no error anywhere.
//
//   BEFORE `frameMember`. The shell's glyph tap is LAZY: `createShellGlyphTap`
//   builds its AnalyserNode on the first READ, and the reads come from the
//   visibility-gated meter ticker, i.e. once the tile is framed at a tier that
//   shows the glyph. Freeze first and that analyser is created on an already-
//   suspended context and never renders a single sample, so it reads ZEROS —
//   the same flat centreline every boot. Freeze afterwards and it holds
//   whatever phase it had reached: stable WITHIN a run and different every run,
//   which passes a settle check and still cannot match a baseline.
//
//   MEASURED (filter face downstream of a free-running macrooscillator, darwin,
//   88×82 tile, 26/255 channel delta):
//       running, no freeze            3 captures: 166 px, 155 px apart
//       freeze here (pre-frame)       3 captures: 0 px — and TWO INDEPENDENT
//                                     BOOTS agree to 0 px
//       freeze after frameMember      3 captures: 0 px, but two independent
//                                     boots differ by 106 px, all of it inside
//                                     the glyph box (x 50-82, y 39-46)
//   The last row is why within-run stability is not the property to assert.
//
// ⚠ AND IT IS RE-ASSERTED AT CAPTURE TIME, not just here. Between this call and
// the dock capture the scene CLICKS (the jack-rail expand affordance), and any
// future click-driven `ensureEngine()` would silently resume the graph. A
// freeze that stopped applying looks identical to a freeze that worked, which
// is the whole reason `freezeAudioContext` throws rather than returning a
// verdict nobody reads.
//
// ⚠ THE SUSPEND HAS TO BE RE-APPLIED UNTIL IT STICKS, and that is not defensive
// coding — it is a MEASURED race with the workflow rack's own pinned modules.
// `?shell=1` pins a videoOut → recorderbox chain, and recorderbox's factory
// does `if (ac.state === 'suspended') void ac.resume()` (recorderbox.ts:269 —
// a MediaStreamAudioDestinationNode does not terminate the graph, so a
// suspended context would never pull its keep-alive). That factory runs from
// the reconcile the palette spawn triggers, i.e. AFTER the point this code
// freezes. Captured live with an `AudioContext.prototype.resume` trace:
//
//     resume ← recorderbox.ts:92 factory ← VideoEngine.addNode
//            ← PatchEngine.addNode ← doReconcile
//
// One-shot per page load, but it lands on a frame we do not control: a single
// suspend produced 16 passes and 27 failures across the 43 face scenes.

/** Options for `bootWithFace`. */
export interface BootFaceOptions {
  /**
   * DEFAULT TRUE. Set false ONLY in a negative control that exists to show what
   * a running graph does — never to make a scene pass.
   *
   * Deny-by-default is enforced OUTSIDE this file: `vrt-meta.test.ts`
   * ("bootWithFace freezeAudio:false is deny-by-default") scans every VRT
   * source for `freezeAudio: false` and fails on any call site that is not in
   * its named exemption list, so a new scene cannot opt out quietly and an
   * exemption naming a call site that no longer exists is also red.
   */
  freezeAudio?: boolean;
  /**
   * Spawn this module into lane 1 BEFORE the face, so the face sits downstream
   * of it in the channel chain (a column IS the chain — channel-columns.ts).
   *
   * The negative control uses it to MANUFACTURE the free-running condition the
   * roster does not contain. No faced module sounds at spawn, so a control that
   * booted a face on its own would be asserting "a silent tile is stable" and
   * would pass for the wrong reason forever.
   */
  upstream?: string;
  /**
   * THE FACE IS A VIDEO MODULE — boot it into the VIDEO ZONE instead of an
   * audio channel column, and pin its live surface before capture. The string
   * is the REASON, so the declaration cannot be a bare flag (the
   * `freezeAudioWhy` idiom in `vrt-scenes.ts`).
   *
   * ⚠ THE AUDIO PATH CANNOT BOOT A VIDEO FACE AT ALL, and it fails as a
   * 90-SECOND TIMEOUT rather than an error, which reads like a broken app.
   * `bootWithFace` waits for the spawned node to appear in
   * `pinned-mixmstrs.data.columns['1']`, because for an audio face a column IS
   * the chain. A video module never joins one: the video-domain analog of the
   * mixer strip is the purple VIDEO ZONE below the channel-lane baseline
   * (`videoAreaBand`, channel-columns.ts). Measured on `backdraft`, the first
   * video face: both its scenes timed out in that `waitForFunction`.
   *
   * So this branch spawns into the zone and identifies the member BY TYPE
   * rather than by column position — the zone already contains an auto-spawned
   * `videoOut`, so "the newest node" would be ambiguous and "the only node"
   * false.
   */
  videoFaceWhy?: string;
}

/** How many times the suspend may be re-applied before the scene gives up. The
 *  known racer (recorderbox's factory resume) is ONE-SHOT per page load, so a
 *  correct run needs at most two; the headroom exists so a second one-shot
 *  racer shows up as a slow scene rather than a flake, and the failure message
 *  prints the attempt count so a NEW repeating racer is legible instead of
 *  mysterious. */
const FREEZE_ATTEMPTS = 6;
/** rAFs to wait after each suspend for a pending best-effort `resume()` to
 *  land. Frames, not ms — renderer-independent by construction, and kept small
 *  because this runs 43× per VRT run on a renderer whose frame rate is unknown:
 *  correctness comes from the RETRY, not from the length of this window. */
const FREEZE_RACE_FRAMES = 3;

/**
 * Suspend the audio graph for a face scene and PROVE it, in both the declared
 * and the observable sense:
 *
 *   1. `freezeAudioContext` throws unless `ctx.state === 'suspended'` (it
 *      resolves the context through the audio DOMAIN — the root engine has no
 *      `.ctx`, which is how the previous repo-wide freeze was a silent no-op
 *      for months; see vrt-audio-freeze.ts).
 *   2. The suspend is then RE-APPLIED until it survives `FREEZE_RACE_FRAMES`
 *      real animation frames, because the workflow rack's pinned recorderbox
 *      resumes the context from the spawn's own reconcile (see THE AUDIO GRAPH
 *      above — measured, with the stack).
 *   3. `assertFaceAudioFrozen` then checks the EFFECT: the audio clock does not
 *      advance across real animation frames. A state flag is a claim; a pinned
 *      `currentTime` is the thing the analyser's window actually depends on.
 */
/** rAFs a frozen video surface must hold still for before we believe it. */
const VIDEO_FREEZE_SETTLE_FRAMES = 6;

/**
 * Pin a face scene's LIVE VIDEO SURFACE by writing the module's own `freeze`
 * param, and PROVE it held — the video sibling of `freezeFaceAudio`.
 *
 * ⚠ AN AUDIO SUSPEND DOES NOT TOUCH THIS. The video engine runs on rAF, not on
 * the AudioContext, so every guarantee `freezeFaceAudio` provides is silent
 * about a video face. `backdraft` is the first roster entry with a picture in
 * its faceplate, and without this its dock scene is the `analogVco`
 * non-determinism class: a live surface re-drawing between capture attempts.
 *
 * ⚠ WHY A DECLARATION AND NOT A PREDICATE. This is opt-in per scene
 * (`videoFaceWhy` on the FACES entry), NOT "write any param called freeze":
 * `clouds:freeze` is a player-facing latch whose whole point is changing what
 * the module sounds like, and a name-matching rule would silently re-look it.
 * The modules this is for declare the param `noUserControl` with
 * `writer: 'internal'` and say "determinism toggle for VRT capture" in their
 * own `why`.
 *
 * The write goes through the Y.Doc transaction the module's card scene already
 * uses (`vrt-scenes.ts`), then we settle real frames and REQUIRE the surface to
 * be byte-identical across a second read — the effect, not the flag, because a
 * param that never reached the engine looks exactly like a frozen one from the
 * store.
 *
 * ⚠ SCOPE — WHAT THIS IS STRUCTURALLY UNABLE TO SEE, stated because a green run
 * here would look identical either way. It is a NEGATIVE control: it proves the
 * surface STOPPED. It cannot prove the surface was ever MOVING, so a scene whose
 * video never rendered at all — no sink pulling the chain, the node not a pull
 * root, the engine never booted — satisfies it VACUOUSLY. That is not
 * hypothetical: `spawnPatch` clears the rack and takes the seeded `videoOut`
 * with it, and a chain with no sink sat at `framesDrawnFor === 0` forever while
 * looking, from here, perfectly frozen.
 *
 * The POSITIVE control for this surface lives in
 * `e2e/tests/backdraft-preview-toggle.spec.ts`, which asserts the same canvas
 * genuinely animates (distinct frames across rAFs) before it concludes anything
 * about it stopping. A passing negative control is not enough on its own.
 */
export async function freezeFaceVideo(page: Page, nodeId: string, label: string): Promise<void> {
  await page.evaluate((id) => {
    const w = globalThis as unknown as {
      __patch: { nodes: Record<string, { params: Record<string, number> } | undefined> };
      __ydoc: { transact: (fn: () => void) => void };
    };
    w.__ydoc.transact(() => {
      const n = w.__patch.nodes[id];
      if (n) n.params.freeze = 1;
    });
  }, nodeId);
  // Let the param reach the engine and the last pre-freeze frame be the one held.
  await waitFrames(page, VIDEO_FREEZE_SETTLE_FRAMES);

  // THE EFFECT, sampled IN THE PAGE across real frames — never a Playwright
  // poll loop, which would be one round-trip per sample on the same main thread
  // as the subject and cannot tell "frozen" from "never looked".
  const held = await page.evaluate(async (frames: number) => {
    const canvases = Array.from(document.querySelectorAll('canvas')) as HTMLCanvasElement[];
    const sample = (): string =>
      canvases
        .map((c) => {
          try {
            return c.width && c.height ? c.toDataURL().slice(-64) : 'x';
          } catch {
            return 'x'; // a tainted/GL canvas contributes nothing rather than throwing
          }
        })
        .join('|');
    const first = sample();
    for (let i = 0; i < frames; i++) {
      await new Promise((r) => requestAnimationFrame(() => r(null)));
    }
    const second = sample();
    return { same: first === second, canvases: canvases.length, frames };
  }, VIDEO_FREEZE_SETTLE_FRAMES);

  expect(
    held.same,
    `${label}: the video surface was still MOVING after writing freeze=1 on '${nodeId}' ` +
      `(${held.canvases} canvases sampled across ${held.frames} rAFs). A scene captured now ` +
      `would be a moving target — the param did not reach the engine, or this module's picture ` +
      `is driven by something freeze does not stop.`,
  ).toBe(true);
}

export async function freezeFaceAudio(page: Page, label: string): Promise<void> {
  const seen: string[] = [];
  for (let attempt = 1; attempt <= FREEZE_ATTEMPTS; attempt++) {
    await freezeAudioContext(page, label);
    // Give any in-flight best-effort `resume()` the frames it needs to land, so
    // a freeze that is about to be undone is caught HERE rather than at capture.
    await waitFrames(page, FREEZE_RACE_FRAMES);
    const clock = await readAudioClock(page);
    seen.push(`${attempt}:${clock.state}`);
    if (clock.state === 'suspended') {
      await assertFaceAudioFrozen(page, label);
      return;
    }
  }
  throw new Error(
    `${label}: the AudioContext would not STAY suspended — ${FREEZE_ATTEMPTS} attempts, ` +
      `states after each (${seen.join(', ')}). Something is resuming it repeatedly. The known ` +
      `one-shot racer is the pinned recorderbox factory (recorderbox.ts, ` +
      `\`if (ac.state === 'suspended') void ac.resume()\`), which the palette spawn's reconcile ` +
      `triggers; a REPEATING resume is a new one and needs finding, not more attempts.`,
  );
}

/** rAFs the clock check waits across. Frame-counted, not wall-clocked — a
 *  renderer-independent window by construction (CLAUDE.md's frames-not-ms rule).
 *
 *  TWO is enough and is chosen to be cheap, because this runs once per boot AND
 *  again before every capture, 43× per VRT run on a renderer whose frame rate
 *  is unknown. The assertion is EXACT EQUALITY against a clock that advances in
 *  128-sample render quanta (2.67 ms at 48 kHz), so any frame at all separates
 *  a running context from a suspended one — there is no margin to buy by
 *  waiting longer, only frames to spend. The negative control proves the two
 *  frames are sufficient on every run by requiring this to REJECT while the
 *  graph is live. */
const FREEZE_CLOCK_FRAMES = 2;

/**
 * ASSERT the audio graph is still frozen — call it immediately before a
 * capture, not once at boot.
 *
 * Two-sided by construction: a suspended context reports `state='suspended'`
 * AND holds `currentTime` exactly constant, while a running one fails both.
 * The negative control in workflow-shell-faces.spec.ts drives this function
 * against a deliberately RUNNING graph on every VRT run and requires it to
 * reject, so "it passed" cannot mean "it cannot fail".
 */
export async function assertFaceAudioFrozen(page: Page, label: string): Promise<void> {
  const before = await readAudioClock(page);
  await waitFrames(page, FREEZE_CLOCK_FRAMES);
  const after = await readAudioClock(page);
  const advance = (after.currentTime ?? 0) - (before.currentTime ?? 0);
  expect(
    after.state,
    `${label}: the AudioContext is '${after.state}', not 'suspended', at CAPTURE time. ` +
      `bootWithFace suspended it — something resumed it since (ensureEngine() resumes on ` +
      `every call, and the dock scene clicks between boot and capture). Any baseline taken ` +
      `now came off a RUNNING graph, so a free-running voice's glyph is a moving target.`,
  ).toBe('suspended');
  expect(
    advance,
    `${label}: the audio clock advanced ${advance.toFixed(6)}s across ${FREEZE_CLOCK_FRAMES} ` +
      `animation frames while reporting state='${after.state}'. The suspend is declared but not ` +
      `in EFFECT — the analyser window feeding every live glyph is still moving. ` +
      `(currentTime ${before.currentTime} → ${after.currentTime})`,
  ).toBe(0);
}

/** What a private AnalyserNode on a module's own audio output reports. */
export interface FaceAudioReading {
  state: string;
  /** True when an analyser was attachable (engine up, node materialized). */
  tapped: boolean;
  /** The audio output port the tap read, or null when the module has none. */
  portId: string | null;
  /** max |sample| over the window. 0 = the module is SILENT. */
  peak: number;
  /** max |f[n][i] − f[n−1][i]| between consecutive frames. 0 = the analyser
   *  window is not advancing, so nothing a live glyph draws can change. */
  moving: number;
  frames: number;
}

/** rAF frames of analyser data `readFaceAudio` compares. Frames, not ms. */
const FACE_AUDIO_FRAMES = 6;

/**
 * Attach a private AnalyserNode to `nodeId`'s primary audio output and sample
 * it across `FACE_AUDIO_FRAMES` consecutive animation frames, ACCUMULATING IN
 * THE PAGE (never a Playwright-side poll loop — that samples the very main
 * thread it is measuring; CLAUDE.md).
 *
 * ONE implementation, read by the gate's negative control AND by
 * vrt-face-audio-probe, so the two cannot disagree about whether a module is
 * sounding — the same reason `readFoldGeometry` is shared.
 *
 * Deliberately a SECOND tap rather than a read of the shell's own: the shell's
 * `createShellGlyphTap` is lazy and self-releasing, so reading it would perturb
 * the thing being measured. An analyser is a pure sink and adds no load.
 */
export async function readFaceAudio(page: Page, nodeId: string): Promise<FaceAudioReading> {
  return page.evaluate(
    async ({ nodeId, frames }) => {
      const w = globalThis as unknown as {
        __engine?: () => Record<string, unknown> | null;
        __patch?: { nodes: Record<string, { type?: string } | undefined> };
        __listModuleDefs?: () => readonly {
          type: string;
          outputs?: readonly { id: string; type: string }[];
        }[];
      };
      const empty = {
        state: 'n/a',
        tapped: false,
        portId: null as string | null,
        peak: 0,
        moving: 0,
        frames: 0,
      };
      const eng = w.__engine?.();
      if (!eng) return empty;
      const audio = (eng as { getDomain?: (d: string) => unknown }).getDomain?.('audio') as
        | {
            ctx: AudioContext;
            getOutputNode: (n: string, p: string) => { node: AudioNode; output: number } | null;
          }
        | undefined;
      if (!audio?.ctx) return empty;
      const ctx = audio.ctx;
      const type = w.__patch?.nodes[nodeId]?.type ?? '';
      const def = w.__listModuleDefs?.().find((d) => d.type === type);
      const portId = def?.outputs?.find((o) => o.type === 'audio')?.id ?? null;
      if (!portId) return { ...empty, state: ctx.state as string };
      const out = audio.getOutputNode(nodeId, portId);
      if (!out) return { ...empty, state: ctx.state as string, portId };

      const an = ctx.createAnalyser();
      an.fftSize = 2048;
      an.smoothingTimeConstant = 0;
      out.node.connect(an, out.output);

      const buf = new Float32Array(an.fftSize);
      let prev: Float32Array | null = null;
      let peak = 0;
      let moving = 0;
      let n = 0;
      await new Promise<void>((resolve) => {
        const tick = (): void => {
          an.getFloatTimeDomainData(buf);
          for (let i = 0; i < buf.length; i++) {
            const a = Math.abs(buf[i]);
            if (a > peak) peak = a;
            if (prev) {
              const d = Math.abs(buf[i] - prev[i]);
              if (d > moving) moving = d;
            }
          }
          prev = buf.slice();
          n++;
          if (n >= frames) {
            resolve();
            return;
          }
          requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      });
      try {
        out.node.disconnect(an);
      } catch {
        /* source already gone */
      }
      return { state: ctx.state as string, tapped: true, portId, peak, moving, frames: n };
    },
    { nodeId, frames: FACE_AUDIO_FRAMES },
  );
}

/** Boot `?shell=1`, spawn `type` into lane 1 via the REAL palette-drop path,
 *  and return the member's node id. Also kills animation jitter, hides the
 *  floating flow chrome (the zoom-scene stability recipe) and FREEZES THE
 *  AUDIO GRAPH (see THE AUDIO GRAPH above). */
export async function bootWithFace(
  page: Page,
  type: string,
  opts: BootFaceOptions = {},
): Promise<string> {
  await pinVrtFonts(page);
  await page.goto('/rack');
  await page.waitForLoadState('networkidle');
  await awaitVrtFonts(page);
  await waitForHooks(page);

  // ── VIDEO FACES BOOT INTO THE VIDEO ZONE, not a channel column ──────────
  // See BootFaceOptions.videoFaceWhy. Only the MEMBER RESOLUTION differs; the
  // scene style + audio freeze tail below is shared, so an audio face runs the
  // same code it always has.
  if (opts.videoFaceWhy) {
    const videoMemberId = await spawnVideoZoneMember(page, type);
    await applyFaceSceneStyle(page);
    if (opts.freezeAudio !== false) await freezeFaceAudio(page, `face-${type}`);
    return videoMemberId;
  }

  // A channel column IS the chain (source → processor → … → mixer channel;
  // channel-columns.ts), and the order array is the chain order, so spawning
  // `upstream` first puts its output into `type`'s input through the REAL
  // membership + reconcile path — no hand-built edge, no second boot path.
  const chain = opts.upstream ? [opts.upstream, type] : [type];
  for (const t of chain) {
    await page.evaluate((tt) => {
      const w = globalThis as unknown as {
        __setSpawnFlowPos: (p: { x: number; y: number }) => void;
        __spawnFromPalette: (t: string) => void;
      };
      // x=30 lands inside narrowed column 1's [0, SHELL_COLUMN_W) band; y=4280
      // lands inside the lane's PAINTED band (the drop hit-test is 2-D — a Y
      // above the lanes is free canvas and joins no lane).
      w.__setSpawnFlowPos({ x: 30, y: 4280 });
      w.__spawnFromPalette(tt);
    }, t);
    await page.waitForFunction(
      (n) => {
        const w = globalThis as unknown as {
          __patch?: {
            nodes: Record<string, { data?: { columns?: Record<string, string[]> } } | undefined>;
          };
        };
        return (w.__patch?.nodes['pinned-mixmstrs']?.data?.columns?.['1'] ?? []).length === n;
      },
      chain.indexOf(t) + 1,
    );
  }
  // The face under test is the LAST member — the bottom of the chain.
  const memberId = await page.evaluate((n) => {
    const w = globalThis as unknown as {
      __patch: { nodes: Record<string, { data?: { columns?: Record<string, string[]> } } | undefined> };
    };
    return (w.__patch.nodes['pinned-mixmstrs']?.data?.columns?.['1'] ?? [])[n - 1] ?? '';
  }, chain.length);
  expect(memberId, `${type}: the lane-1 member spawned`).not.toBe('');
  if (opts.upstream) {
    // ANCHORED TO THE ARTIFACT: a chain that silently did not form would leave
    // the face silent and make every "it moves" leg below vacuous.
    const t = await page.evaluate((id) => {
      const w = globalThis as unknown as { __patch: { nodes: Record<string, { type?: string } | undefined> } };
      return w.__patch.nodes[id]?.type ?? '';
    }, memberId);
    expect(t, `${type}: the LAST lane-1 member is the face under test, not its upstream`).toBe(type);
  }

  await applyFaceSceneStyle(page);
  if (opts.freezeAudio !== false) await freezeFaceAudio(page, `face-${type}`);
  return memberId;
}

/** The scene's chrome-hiding + animation-killing style tag. Extracted so the
 *  video-zone boot path applies the IDENTICAL rules rather than a second copy
 *  that could drift — a scene styled even slightly differently is measuring a
 *  different box. */
async function applyFaceSceneStyle(page: Page): Promise<void> {
  await page.addStyleTag({
    content:
      '.svelte-flow__minimap,.svelte-flow__controls,.svelte-flow__attribution,.minimap-toggle{display:none !important;}' +
      '*,*::before,*::after{animation:none !important;transition:none !important;}',
  });
}

/** Every node id of `type` currently in the patch. */
async function idsOfType(page: Page, type: string): Promise<string[]> {
  return page.evaluate((tt) => {
    const w = globalThis as unknown as {
      __patch?: { nodes: Record<string, { type?: string } | undefined> };
    };
    return Object.entries(w.__patch?.nodes ?? {})
      .filter(([, n]) => n?.type === tt)
      .map(([id]) => id);
  }, type);
}

/**
 * Spawn a VIDEO face into the video zone and return the id of the node THIS CALL
 * created.
 *
 * ⚠ IDENTIFIED AS "THE NEW ONE", NOT "THE ONLY ONE" — and the difference is a
 * shipped bug, not a refinement. This function's own doc comment used to warn
 * that *"the zone is auto-populated with a default `videoOut` … so 'the only node
 * there' is false"* — and then waited for `filter(type).length === 1` anyway. For
 * every face that had ever used this path the two readings agreed, because none
 * of their types pre-existed in the zone. `videoOut` is the first face whose own
 * type IS the node already sitting there, so spawning it makes the count 2 and a
 * wait for `=== 1` can never be satisfied: both its scenes timed out at 20 s on
 * every run, deterministically, and the "every face has baselines" gate failed as
 * a CONSEQUENCE because the scenes could not reach `toHaveScreenshot`.
 *
 * The fix is general rather than a `videoOut` special case — snapshot the ids of
 * this type BEFORE spawning and take the one that appears — so it is correct for
 * a type with 0, 1 or N pre-existing instances, and the NEXT colliding type does
 * not get to rediscover this.
 *
 * The property the old code was reaching for is KEPT and strengthened: exactly
 * ONE new node must appear, so a double-spawn is an error rather than a silent
 * arbitrary pick, and the returned id is asserted NOT to be a pre-existing one —
 * which is the assertion that fails if this ever regresses to picking the
 * default `videoOut` instead of the spawned face.
 */
async function spawnVideoZoneMember(page: Page, type: string): Promise<string> {
  // The population BEFORE the spawn — the thing that made `=== 1` wrong.
  const before = await idsOfType(page, type);

  await page.evaluate((tt) => {
    const w = globalThis as unknown as {
      __setSpawnFlowPos: (p: { x: number; y: number }) => void;
      __spawnFromPalette: (t: string) => void;
    };
    // Inside the purple VIDEO ZONE: the band starts at the channel-lane
    // baseline (COLUMN_BASELINE_Y = 4320) and is VIDEO_AREA_HEIGHT (3u = 540)
    // tall, spanning columns 1..8 from COLUMN_ORIGIN_X. A point comfortably
    // inside it, since the drop hit-test is 2-D.
    w.__setSpawnFlowPos({ x: 200, y: 4560 });
    w.__spawnFromPalette(tt);
  }, type);

  // ⚠ `>= 1`, NOT `=== 1`, and that distinction is the bug this helper was
  // written to fix — one level up. An equality wait is only ever satisfiable
  // TRANSIENTLY: if two nodes of the type appear (a double reconcile, or the
  // rack's own video-zone auto-population landing after `before` was captured),
  // the count goes 1 → 2 and never comes back, so the wait eats its full 20 s
  // and reports Playwright's generic timeout with none of the diagnostics the
  // assertion below carries. Wait for ARRIVAL; let the assertion judge the
  // COUNT, which is where a useful message lives.
  await page.waitForFunction(
    ({ tt, seen }) => {
      const w = globalThis as unknown as {
        __patch?: { nodes: Record<string, { type?: string } | undefined> };
      };
      const known = new Set(seen);
      return (
        Object.entries(w.__patch?.nodes ?? {}).filter(
          ([id, n]) => n?.type === tt && !known.has(id),
        ).length >= 1
      );
    },
    { tt: type, seen: before },
    { timeout: 20_000 },
  );

  const after = await idsOfType(page, type);
  const fresh = after.filter((id) => !before.includes(id));

  expect(
    fresh,
    `${type}: exactly one NEW video-zone member spawned ` +
      `(${before.length} of this type pre-existed: [${before.join(', ')}])`,
  ).toHaveLength(1);

  // ⚠ THESE TWO ARE ANCHORED TO THE ARTIFACT, and the previous attempt was NOT.
  // It asserted `expect(before).not.toContain(fresh[0])` — but `fresh` is
  // DEFINED as `after` minus `before`, so that is true for every possible input:
  // a gate green on all inputs including the regression it names, which is
  // exactly the "would its green run look any different if the answer were
  // 'everything'?" shape. Replaced with two properties read off the live patch,
  // both of which can genuinely fail:
  //   · the population of this type grew by EXACTLY ONE (a spawn that silently
  //     did not happen, or fired twice, reddens here);
  //   · the id we are returning really is a node of the type under test.
  expect(
    after.length,
    `${type}: the spawn must add exactly one node of this type ` +
      `(before ${before.length}, after ${after.length})`,
  ).toBe(before.length + 1);

  const freshType = await page.evaluate((id) => {
    const w = globalThis as unknown as { __patch?: { nodes: Record<string, { type?: string } | undefined> } };
    return w.__patch?.nodes[id]?.type ?? '(absent)';
  }, fresh[0]!);
  expect(
    freshType,
    `${type}: the returned member must BE the face under test — framing the wrong ` +
      `tile would baseline the wrong subject and every pixel assertion downstream ` +
      `would be green about it`,
  ).toBe(type);

  return fresh[0]!;
}

/** Center the viewport on the lane-1 member (members bottom-anchor toward the
 *  4320 lane baseline) at `zoom`, then wait for the LOD face tier to settle on
 *  the member's tile + two rAFs so the tier content swap lands. */
export async function frameMember(
  page: Page,
  memberId: string,
  zoom: number,
  tier: string,
): Promise<void> {
  await page.evaluate(
    ({ memberId, zoom }) => {
      const w = globalThis as unknown as {
        __flow: {
          getInternalNode: (id: string) => { internals?: { positionAbsolute?: { x: number; y: number } }; position?: { x: number; y: number }; measured?: { width?: number; height?: number } } | undefined;
          setViewport: (vp: { x: number; y: number; zoom: number }, o?: { duration?: number }) => void;
        };
      };
      const inode = w.__flow.getInternalNode(memberId);
      const x = inode?.internals?.positionAbsolute?.x ?? inode?.position?.x ?? 0;
      const y = inode?.internals?.positionAbsolute?.y ?? inode?.position?.y ?? 0;
      const cx = x + (inode?.measured?.width ?? 192) / 2;
      const cy = y + (inode?.measured?.height ?? 180) / 2;
      const pane = document.querySelector('.svelte-flow') as HTMLElement;
      const r = pane.getBoundingClientRect();
      w.__flow.setViewport({ x: r.width / 2 - cx * zoom, y: r.height / 2 - cy * zoom, zoom }, { duration: 0 });
    },
    { memberId, zoom },
  );
  await page.waitForFunction(
    ({ memberId, tier }) => {
      const el = document.querySelector(
        `.svelte-flow__node[data-id="${memberId}"] [data-testid="module-shell"]`,
      );
      return !!el && el.getAttribute('data-shell-tier') === tier;
    },
    { memberId, tier },
    { timeout: 10_000 },
  );
  await settle(page);
}

/** Click the member's jack-rail EXPAND affordance and wait for the dock
 *  full-view to mount at the 'dock' face tier with `pages` section bands. */
export async function openDock(page: Page, memberId: string, pages: number): Promise<Locator> {
  await page
    .locator(`.svelte-flow__node[data-id="${memberId}"] [data-testid="module-shell"]`)
    .getByTestId('shell-open-dock')
    .click();

  const faceplate = page.getByTestId('dock-full-view');
  await expect(faceplate).toBeVisible();
  // The migrated shell mounts at the 'dock' face tier with its curated
  // SECTION BANDS — one per declared face page.
  await expect(faceplate.locator('[data-testid="module-shell"][data-shell-tier="dock"]')).toBeVisible();
  await expect(faceplate.locator('[data-testid="face-page"]')).toHaveCount(pages);
  await settle(page);
  return faceplate;
}

/**
 * `settle` (two rAFs — a tier/content swap lands and paints) and `waitFrames`
 * (n rAFs) now live in ONE place for the whole harness: e2e/_helpers/frames.ts
 * (#1523 asks for exactly one export site, so a spec reaching for a frame count
 * has one obvious import rather than a local re-implementation).
 *
 * Re-exported here so every existing `from './_shell-faces'` caller is
 * unchanged. (Imported as well as re-exported: a bare `export … from` does NOT
 * bind the names in this module's own scope, and this file calls both.)
 */
export { settle, waitFrames };

/** What the dock capture box can and cannot contain, in CSS px. */
export interface FoldGeometry {
  /** The captured element's own height — the PNG's height. CSS px. */
  captureH: number;
  /** `.faceplate-scroll` content extent vs the extent it can show. CSS px. */
  scrollH: number;
  clientH: number;
  scrollW: number;
  clientW: number;
  /** Content the capture CANNOT contain, per axis. CSS px, 0 = fully captured. */
  hiddenY: number;
  hiddenX: number;
  /** Vertical scrollbar width stolen from the content's layout width. CSS px. */
  scrollbarW: number;
  /** Per-band geometry, offsets relative to the captured element's top. */
  bands: Array<{ id: string; top: number; h: number; rendered: boolean }>;
  /** Bands the browser lays out with area (a tab rail hides the inactive ones). */
  renderedBands: number;
  /** Tab-rail chips, 0 when the face renders as one scrolling column. */
  tabs: number;
  /**
   * THE WIDTH THE FACE ACTUALLY USES, and the width it was GIVEN. CSS px.
   *
   * `contentW` is the rightmost extent of anything the face DRAWS, measured
   * from the scroll container's content-box left edge: control cells, pictures
   * and the TEXT of every heading (via a Range, because a heading is a block
   * element whose BOX is the full plate width and whose ink is not — measuring
   * boxes would report every face as perfectly filled and the gate would be
   * blind by construction).
   *
   * `plateW` is `.faceplate-scroll`'s client width. `plateW - contentW` is the
   * useless grey space owner ruling 2026-08-17 forbids: *"we do not want
   * useless gray horizontal space on cards, ever."*
   */
  contentW: number;
  plateW: number;
  /** The pane's top edge in viewport coords. NEGATIVE = the pane has grown off
   *  the top of the window and Playwright cannot scroll it into view, because
   *  the drawer is absolutely positioned in a non-scrolling container. This is
   *  the headroom the dock scene asserts. CSS px. */
  topY: number;
  viewportH: number;
}

/**
 * Measure the dock capture box. ONE implementation, read by the gate's scope
 * assertion and by the probe, so the two cannot disagree about what "below the
 * fold" means.
 *
 * ⚠ UNITS: CSS px throughout. The dock drawer is NOT inside xyflow's zoom
 * transform (it is an absolutely-positioned sibling of `.svelte-flow__viewport`
 * — see Canvas's `.dock-fullview-drawer`), so unlike `card-control-overflow`
 * these numbers need no zoom division and ARE the PNG's pixels at DPR 1.
 */
export async function readFoldGeometry(page: Page): Promise<FoldGeometry> {
  return page.evaluate(() => {
    const el = document.querySelector('[data-testid="dock-full-view"]') as HTMLElement | null;
    if (!el) throw new Error('_shell-faces: no [data-testid="dock-full-view"] mounted');
    const sc = el.querySelector('.faceplate-scroll') as HTMLElement | null;
    if (!sc) throw new Error('_shell-faces: the faceplate has no .faceplate-scroll container');
    const er = el.getBoundingClientRect();
    const scr = sc.getBoundingClientRect();
    const bands = Array.from(el.querySelectorAll('[data-testid="face-page"]')).map((node) => {
      const b = node as HTMLElement;
      const r = b.getBoundingClientRect();
      return {
        id: b.getAttribute('data-face-page') ?? b.id ?? '?',
        top: Math.round(r.top - er.top),
        h: Math.round(r.height),
        rendered: r.width > 0 && r.height > 0,
      };
    });
    // ── CONTENT EXTENT ────────────────────────────────────────────────────
    // Boxes for the things that ARE their content (cells, pictures), and TEXT
    // RANGES for everything else. A `.page-label` <h4> is a block box as wide
    // as the plate, so a box-only sweep would measure the plate against itself
    // and return zero slack for every face including the double-wide ones.
    const scStyle = getComputedStyle(sc);
    const contentLeft = scr.left + parseFloat(scStyle.paddingLeft || '0');
    let right = contentLeft;
    const BOXY = '[data-cell-key],.tile-glyph,canvas,svg,img,[data-testid="face-hero"] .hero-vis';
    for (const node of Array.from(sc.querySelectorAll<HTMLElement>('*'))) {
      if (node.getClientRects().length === 0) continue;
      if (node.matches(BOXY)) {
        const r = node.getBoundingClientRect();
        if (r.width > 0 && r.right > right) right = r.right;
        continue;
      }
      for (const child of Array.from(node.childNodes)) {
        if (child.nodeType !== Node.TEXT_NODE) continue;
        if (!(child.textContent ?? '').trim()) continue;
        const rng = document.createRange();
        rng.selectNodeContents(child);
        const r = rng.getBoundingClientRect();
        if (r.width > 0 && r.right > right) right = r.right;
      }
    }

    return {
      contentW: Math.round(right - contentLeft),
      plateW: sc.clientWidth,
      captureH: Math.round(er.height),
      scrollH: sc.scrollHeight,
      clientH: sc.clientHeight,
      scrollW: sc.scrollWidth,
      clientW: sc.clientWidth,
      hiddenY: Math.max(0, sc.scrollHeight - sc.clientHeight),
      hiddenX: Math.max(0, sc.scrollWidth - sc.clientWidth),
      scrollbarW: Math.round(scr.width - sc.clientWidth),
      bands,
      renderedBands: bands.filter((b) => b.rendered).length,
      tabs: el.querySelectorAll('[data-face-tab]').length,
      topY: Math.round(er.top),
      viewportH: window.innerHeight,
    };
  });
}

/** The band whose BOTTOM sits lowest in the faceplate — the one a fold hides
 *  first, and therefore the one the negative control perturbs. Derived from the
 *  live layout, never hardcoded, so a renamed or re-packed band cannot leave the
 *  control quietly poking at nothing. */
export function lowestBand(g: FoldGeometry): { id: string; top: number; h: number } {
  const rendered = g.bands.filter((b) => b.rendered);
  if (rendered.length === 0) throw new Error('_shell-faces: the faceplate rendered no bands');
  return rendered.reduce((lo, b) => (b.top + b.h > lo.top + lo.h ? b : lo));
}

/** Shift one band sideways by `px`, a pure PAINT change (no reflow, so no other
 *  band moves and the pane's height is untouched). The negative control's
 *  perturbation: the smallest edit that is unambiguously confined to one band. */
export async function perturbBand(page: Page, bandId: string, px: number): Promise<void> {
  await setFoldStyle(
    page,
    '.dock-fullview-drawer,.dock-faceplate{max-height:none !important;}' +
      `[data-face-page="${bandId}"]{transform:translateX(${px}px) !important;}`,
  );
}

/** The perturbation under the OLD clamp — the pair that shows the pre-fix scene
 *  could not see it. `px` is the clamp height to restore. */
export async function perturbBandFolded(
  page: Page,
  bandId: string,
  px: number,
  clampPx: number,
): Promise<void> {
  await setFoldStyle(
    page,
    `.dock-fullview-drawer,.dock-faceplate{max-height:${clampPx}px !important;}` +
      `[data-face-page="${bandId}"]{transform:translateX(${px}px) !important;}`,
  );
}
