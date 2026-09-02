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
// ⚠ IMPORTED, NOT RE-TYPED — and it is importable here for a mechanical reason
// worth stating, because this file's header says the roster CANNOT read a live
// def. That limit is about the module REGISTRY (`import.meta.glob`).
// `band-focus-model.ts` is pure logic whose only imports are TYPE-ONLY, so it
// transpiles to zero imports and loads fine in the Playwright runtime — the same
// way `module-shell-model` already does for the platform spec. Deriving the
// focused band set from the shipped predicate is what stops this harness from
// growing a second, drifting copy of the rule.
import { visibleBandIds, type BandFocusPredicate } from '../../packages/web/src/lib/ui/workflow/band-focus-model';

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
  {
    type: 'dx7',
    pages: 4,
  },
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
  // SPIROGRAPHS (2026-08-18) — the first TAB-RAILED face in this roster to
  // declare more than eight bands, and a video module.
  //
  // `pages: 10` is the DECLARED band count (`count`, then figure/place/look per
  // spiro), which is what this roster carries for a railed face — the spec
  // derives `railed = pages >= DOCK_TAB_MIN_BANDS` from it and then asserts
  // exactly ONE band renders. ⚠ So the nine inactive tabs are NOT in either
  // image; that is the rail blind spot this file already names, and band
  // structure here is held by `faceplate-platform` and the pure
  // `dock-row-plan` / `module-face-lint` units instead.
  //
  // ⚠ `videoFaceWhy` IS MANDATORY AND THIS MODULE HAD NO WAY TO HONOUR IT
  // until this PR. Every spiro's centre drifts and bounces off the frame edges
  // as a pure function of `frame.time`, so the picture is different on every
  // rendered frame — the analogVco class, in video. It carried no `freeze`
  // param at all, so one was added (declared `noUserControl`, `writer:
  // 'internal'`, and absent from `face.order`) purely so this scene can settle.
  {
    type: 'spirographs',
    // ⚠ THREE, one per spiro (owner, 2026-08-19: *"this should just be 3 tabs,
    // one per spiro"*). It was TEN — count + figure/place/look x3 — and the rail
    // came from the band THRESHOLD. It now comes from the owner-instructed
    // `face.tabbed` opt-in, because 3 is under DOCK_TAB_MIN_BANDS.
    pages: 3,
    // The rail is DECLARED, not derived — 3 is under DOCK_TAB_MIN_BANDS. Joined
    // to the live def by shell-faces-roster.test.ts in both directions.
    tabbedOptIn: true,
    videoFaceWhy:
      'the dock faceplate carries a live thumbnail of the module output via hasVideoSurface, and '
      + 'this module ANIMATES BY CONSTRUCTION — each spiro centre drifts and bounces as a pure '
      + 'function of frame.time — so the surface is a different picture on every frame. An '
      + 'AudioContext suspend says nothing about a rAF-driven picture; only the freeze stops it.',
    // ⚠ AND THE `freeze` PARAM IS NOT ENOUGH ON ITS OWN — MEASURED 2026-08-25,
    // and it is the finding that overturns this file's own 4plexvid advice (see
    // the corrected note there). Booting both of this module's scenes twice on
    // ubuntu CI through the gate's own scene code and diffing the pairs at
    // threshold 1/255:
    //
    //     face-spirographs-dock      2711 px   maxCh 243   (budget was 1500 — OVER)
    //     face-spirographs-compact     25 px   maxCh 120   (budget was  150 — under)
    //
    // The dock row was a LIVE LATENT FLAKE against the pre-existing tolerance,
    // not merely a zero-tolerance casualty. The cause is the one this file
    // states everywhere else in one sentence: `freezeFaceVideo` makes the
    // picture STOP, it does not choose WHICH picture it stopped on. `draw`
    // returns before `const timeSec = frame.time`, so the held frame is
    // whichever `frame.time` the harness happened to catch, and every spiro
    // centre is `advanceCenter(base, r, W, H, timeSec)` — a different picture
    // for every distinct value of that clock.
    //
    // ⚠ THE FIX IS THE ENGINE CLOCK, NOT A SECOND ParamDef, and spirographs is
    // INWARDS' half of the split rather than mirrorpool's: `resolveSpiros`
    // rebuilds `base` from the module-level SPIRO_DRIFT constants on every call
    // and returns a fresh list, so there is no ping-pong FBO, no accumulator and
    // no RNG for a clock pin to leave running. `framesElapsed` is incremented
    // but nothing in either scene paints it. Pinning `frame.time` therefore
    // makes EVERY frame identical, which is why it also settles the question of
    // which frame the freeze held: they are all the same frame.
    //
    // ⚠ THE `freeze` ParamDef STAYS. It is already shipped, it is in `params`
    // and therefore in the attest basis and contract-lock, and deleting it would
    // cost a real-GPU re-attest and a contract re-pin to remove something that
    // is still correct — just not sufficient. The pin costs neither.
    simPin: [
      {
        global: '__videoEngineFreezeTime',
        value: 1.0,
        why:
          'pins `frame.time`, the ONLY time term this module reads — every spiro centre is '
          + '`advanceCenter(base, fixedRadiusPx, W, H, timeSec)` with `timeSec = frame.time`, and '
          + '`base` is rebuilt from constants on every call. With the clock pinned the render is a '
          + 'pure function of the params, so the scene is identical across boots, renderers and '
          + 'frame counts. Sufficient ALONE here, unlike on mirrorpool, because spirographs '
          + 'carries no ping-pong field, no accumulator and no RNG. ⚠ It is ALSO what makes the '
          + 'shipped `freeze` param safe: freeze holds an arbitrary frame, and this is what makes '
          + 'every frame the same one. Measured without it: 2711 px dock / 25 px compact across '
          + 'two ubuntu boots.',
      },
    ],
  },
  // 4PLEXER (2026-08-18) — no `pages`, so the dock renders ONE unlabelled band
  // holding all four selectors (four peers, one idea; see the face comment).
  // The hero carries readouts only and promotes no control, so nothing is
  // moved out of that band and it is not emptied — unlike `noise`, whose only
  // key WAS promoted.
  //
  // DETERMINISTIC AT REST, structurally: the module is a pure switch with no
  // generator in it, its outputs are `cv`, and the face declares `glyph: 'none'`
  // (forced — every output is `cv`, so no glyph kind can bind). Nothing on
  // either scene reads an analyser, and the three hero readouts are pure
  // functions of the four selector params.
  //
  // ⚠ `pages: 1`, NOT 0, and the first draft of this entry got it wrong while
  // the comment above it stated the right reason — the capture caught it
  // (`face-page` toHaveCount: unexpected value "1"). `noise` is `pages: 0`
  // because its ONLY ranked key is promoted to `hero.control`, which EMPTIES
  // the `__all` band and `heroFacePlan` DROPS an emptied band. This hero
  // promotes NO control, so nothing leaves the band and it renders. Reasoning
  // "no declared `face.pages` ⇒ 0" is the trap: the roster counts RENDERED
  // bands, not declared ones.
  { type: 'fourplexer', pages: 1 },
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
  {
    type: 'sidecar',
    pages: 3,
  },
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
  // MOOG 923 (2026-08-18) — two declared pages (`noise`, `filter`), which pack
  // onto one dock row; no hero control, so no band is emptied and neither page
  // is dropped (heroFacePlan only drops an EMPTIED band — the `noise` case).
  //
  // ⚠ IT IS A FREE-RUNNING NOISE SOURCE AND IT IS STILL SAFE HERE, for a reason
  // that is specific rather than hopeful. `moog923`'s factory `.start()`s two
  // looping noise buffers unconditionally, so it is the `noise`/analogVco
  // family — a live tap would be a moving picture, and analogVco was dropped
  // from batch 3 for exactly that (254/154/315 px across three captures of one
  // tile). What removes the hazard here is the FACE, not the freeze: the def
  // declares `glyph: 'none'` (see its face comment — every glyph kind binds to
  // `white`, and a compact tile cannot afford one), so no analyser feeds any
  // pixel in either scene. The readouts are closed forms over params, which are
  // identical frame to frame. The AudioContext freeze this file applies is
  // therefore a belt on a brace for this entry, not the thing holding it.
  { type: 'moog923', pages: 2 },
  // MOOG 911 (2026-08-19) — two declared pages (`times`, `level`), and `pages`
  // is the POST-hero-split band count: the hero declares READOUTS ONLY, so it
  // promotes no key out of any band and neither band can be emptied. Both are
  // knob-only and pack onto one dock row (4 cells, well under
  // DOCK_ROW_MAX_CONTROLS = 10).
  //
  // ⚠ PIXEL-DETERMINISTIC BY CONSTRUCTION, and unusually easy to argue: this
  // module produces NOTHING until a gate arrives. Its factory's only source is
  // a ConstantSource pinned at 0 (the silence keepalive), the def declares
  // `glyph: 'none'` — forced, since both outputs are `cv` — and all three hero
  // readouts are closed forms over params. So no analyser, no free-running
  // oscillator and no frame-dependent value feeds any pixel in either scene.
  // This is the OPPOSITE end of the range from analogVco, which was dropped
  // from batch 3 for drawing 254/154/315 px across three captures of one tile.
  //
  // Measured at spawn, both taps, with the gate unpatched: `env` is bit-exactly
  // 0 and `env_inv` bit-exactly 1 for a full second, and sweeping any of the
  // four params changes neither. The scenes cannot move unless the FACE moves.
  { type: 'moog911', pages: 2 },
  // MOOG 911A (2026-08-19) — two declared pages (`delays`, `coupling`), and
  // `pages` is the POST-hero-split band count: the hero declares READOUTS ONLY,
  // so no key leaves a band and neither can be emptied. Three cells, one packed
  // dock row.
  //
  // ⚠ THE ONE MEMBER OF ITS COHORT IN `STRICT_VRT_MODULES` — it has a COMMITTED
  // legacy-card baseline, unlike moog911/moogCp3/moog921Vco which are exempt.
  // That card baseline is NOT expected to move: `vrt.spec.ts` navigates to
  // `/rack?shell=legacy`, so promotion does not change what it captures, and the
  // `options[]` roster this face adds is read by the SHELL — the card builds its
  // own mode name from `MOOG911A_MODE_NAMES` and is untouched. Verified by
  // capturing the card scene on this branch and against `main` on the same
  // machine and diffing the two actuals, which is the only same-platform
  // comparison a local run can honestly make.
  //
  // PIXEL-DETERMINISTIC: the module emits nothing until a trigger arrives (its
  // factory's only source is a ConstantSource pinned at 0), `glyph: 'none'` is
  // forced because both outputs are `gate`, and both readouts are closed forms
  // over params. Measured at spawn: with both TRIG jacks unpatched, sweeping any
  // of the three params leaves both outputs bit-identical.
  { type: 'moog911a', pages: 2 },
  // MOOG CP3 (2026-08-19) — two declared pages (`channels`, `4th input`), and
  // `pages` is the POST-hero-split band count: the hero declares READOUTS ONLY,
  // so no key leaves a band. Five knob cells, one packed dock row.
  //
  // ⚠ ITS GLYPH BINDS `live-audio` ON `out_positive` — the (+) bus — and it is
  // SILENT AT SPAWN, which is the mixer/reverb determinism case this file
  // already names and NOT the analogVco free-running one. The module has no
  // generator in it: with nothing patched the bus is bit-exactly zero, so the
  // meter reads zero whether the graph is frozen or running. No mask, and the
  // AudioContext freeze is a belt on a brace here rather than the thing holding
  // the scene.
  { type: 'moogCp3', pages: 2 },
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
  {
    type: 'mixmstrs',
    pages: 4,
    foldHeight: 2048,
  },
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
  // THE PAIR'S THIRD FAMILY MEMBER — `moog921Vco`, the standalone monolith.
  //
  // `pages: 3` and it is the POST-hero split count, which is where this entry
  // differs from the two above: this face DOES declare `pages` (pitch / mod /
  // out), the hero promotes `octave` OUT of `pitch`, and all three bands
  // survive — `pitch` with FREQ alone, `mod` with LIN FM + SYNC, `out` with
  // WIDTH + LEVEL.
  //
  // ⚠ THE `mod` BAND IS SOLO ON ITS ROW, AND THAT IS DERIVED RATHER THAN
  // AUTHORED: SYNC is a 3-option discrete param, so `paramCellKind` returns
  // `segmented` at the dock tier and `PARAM_CELL_WIDTH_CLASS.segmented` is
  // `'wide'` (dock-row-plan.ts:130), which makes `bandIsPackable` refuse to pack
  // it. A reviewer seeing three rows where two would fit is looking at the
  // packing rule, not at a layout mistake.
  //
  // ⚠ IT JOINS THE ROSTER'S FREE-RUNNING SET, so this scene EXERCISES #1420's
  // pre-frame audio freeze rather than being indifferent to it — same property
  // as moog921b and for the same mechanical reason: no gate, no note to wait
  // for, the factory feeds silence to all four inputs purely to keep the worklet
  // processing, and `level` defaults to unity, so `sine` is a full-scale
  // 261.626 Hz tone from sample 0. It carries NO mask: with the graph frozen
  // before the tile is framed the analyser reads zeros and the glyph draws the
  // same flat centreline everything else does. ⚠ WHAT WOULD SILENTLY RETIRE THE
  // PROPERTY: `level` ceasing to default to unity, and nothing else — there is
  // no engine selector here that could move the default onto a struck voice.
  //
  // ⚠ ITS GLYPH IS A LIVE TRACE OF ONE TAP OF FOUR (`sine`, the first declared
  // `audio` output), and the four taps are not level-matched — a 4.789 dB spread
  // measured at one LEVEL setting — so the picture is not a proxy for what the
  // patch hears. Sweeping WIDTH cannot move it at all, because WIDTH reaches
  // only the rectangular tap.
  //
  // ⚠ THE FOUR HERO READOUTS ARE PURE FUNCTIONS OF `node.params` and print at
  // the spawn defaults, so they are IN the dock image and a re-rank or a
  // formatter change moves this baseline: `261.6 Hz · +0.0 dB · off · off`.
  // Those exact strings are pinned in `moog921-face-model.test.ts`, so a
  // formatter change reddens the unit lane before it reddens a baseline.
  { type: 'moog921Vco', pages: 3 },
  // THE 902 VCA — two pages (`gain` = the pot + its CV depth, `response` = the
  // law selector), so the dock scene frames two bands, not one.
  //
  // ⚠ ITS HERO READOUTS ARE PURE FUNCTIONS OF `node.params` and print at the
  // spawn defaults, so they are IN the dock image and a formatter change moves
  // this baseline: `0.0 dB · 9.0 V`. Both strings are pinned in
  // `moog902-face-model.test.ts`, so a formatter edit reddens the unit lane
  // before it reddens a pixel.
  //
  // ⚠ AND THE GLYPH IS A LIVE-AUDIO METER ON A MODULE THAT IS SILENT AT SPAWN,
  // which is why it baselines at all: the 902 is an AMPLIFIER, not a source, so
  // with nothing patched its `audio` tap is zeros and the meter draws its floor.
  // This is the mirror image of the `analogVco` non-determinism class — that one
  // was a FREE-RUNNING voice whose glyph drew a moving saw — and it does not
  // exercise #1420's pre-frame audio freeze, because there is nothing to freeze.
  {
    type: 'moog902',
    pages: 2,
    // (Its compact tile spent 2026-08-28→29 out of the roster: the strongest
    // measurement of the CPU-fleet ±1-2 LSB class was made HERE, by ping-pong —
    // the baseline was re-authored twice from verified actuals, runs
    // 33217755378 / 33229159480, and each next draw on a different CPU flipped
    // it back red. The ±2-LSB band ruling of 2026-08-29 — vrt.config.ts's
    // tolerance block — absorbs exactly that flap, so both scenes gate again.)
  },
  // THE 904A LADDER FILTER — two pages (`filter` = the corner + RANGE,
  // `resonance` = regeneration).
  //
  // ⚠ ITS HERO READOUTS PRINT AT THE SPAWN DEFAULTS and are therefore IN the
  // dock image: `4.0 kHz · filter`. The first of those is the finding — the
  // CUTOFF dial reads 1000 Hz at spawn while RANGE 2 places the filter at 4 kHz
  // — so a formatter or a rangeMultiplier change moves this baseline. Both
  // strings are pinned in `moog904a-face-model.test.ts`.
  //
  // ⚠ AND THE `waveform` GLYPH IS DETERMINISTIC HERE FOR A MODULE-SPECIFIC
  // REASON, not because the harness freezes it: a 904a is a FILTER with no
  // source, and `regeneration` ships at 0 — below the measured 0.665231
  // self-oscillation threshold — so an unpatched, freshly spawned 904a emits
  // nothing and the trace is a flat centreline. The thermal dither that would
  // make it non-deterministic is scaled by `regen⁴`, i.e. exactly 0 at spawn.
  // ⚠ A future default above that threshold would turn this scene into the
  // `analogVco` non-determinism case overnight.
  { type: 'moog904a', pages: 2 },
  // THE 912 ENVELOPE FOLLOWER — SINGLE PAGE (both knobs are the same idea), so
  // `pages: 1` here is the absence of a `face.pages` declaration, not a count of
  // one.
  //
  // ⚠ THIS ONE MOVES A COMMITTED STRICT BASELINE, unlike the other two in this
  // wave. `moog912` is in STRICT_VRT_MODULES, so `vrt.spec.ts/moog912.png` is a
  // committed capture of a surface the promotion REPLACES: that scene now frames
  // a ModuleShell tile instead of `Moog912Card.svelte`.
  //
  // ⚠ THE BASELINE IS RE-CAPTURED, NOT DELETED, and the distinction was checked
  // against the tree rather than assumed. The queue spec said to `git rm` it
  // first, on the skill's "--update-snapshots cannot regenerate a
  // PASSING-but-stale baseline" hazard. That hazard does not apply here and the
  // deletion would be actively wrong: `vrt-meta.test.ts` asserts EVERY
  // STRICT_VRT_MODULES entry HAS a committed baseline, so removing it reddens a
  // gate. `moog923` is the precedent — promoted, in STRICT_VRT_MODULES, and its
  // `moog923.png` is still there. The `git rm`-first discipline is for a stale
  // baseline whose diff falls UNDER the tolerance; a legacy beige Moog card
  // becoming a shell tile is nowhere near that, so the comparison fails loudly
  // and the capture rewrites it.
  //
  // ⚠ ITS HERO READOUTS PRINT AT THE SPAWN DEFAULTS and are IN the dock image:
  // `7.07 Hz · -13.0 dBFS`. Both strings are pinned in
  // `moog912-face-model.test.ts`.
  //
  // Glyph is 'none' and FORCED — every output is cv/gate, so
  // `primaryAudioOutPortId` is null and no glyph kind resolves to anything but
  // the dead `{kind:'static'}`. Nothing live is in this scene at all, which
  // makes it the most trivially deterministic capture in the roster.
  { type: 'moog912', pages: 1 },
  // MOOG 993 — three peer routers, declared as ONE band (no `pages`): three
  // switches for the same idea, and a page per switch would be three headers
  // over three controls.
  //
  // Deterministic for the same reason moog912 is, and more so: every output is
  // gate/cv so `primaryAudioOutPortId` is null and the glyph is a forced
  // 'none', and the module is PASSIVE ROUTING — GainNodes only, no worklet, no
  // oscillator, nothing that advances with time. The only live text in the
  // scene is the hero routing readout, which is a pure function of the three
  // switch positions.
  { type: 'moog993', pages: 1 },
  // OUTLINES — three pages (spawn clock / latched at birth / live field), well
  // under DOCK_TAB_MIN_BANDS, so the dock scene captures stacked bands.
  {
    type: 'outlines',
    pages: 3,
    videoFaceWhy:
      'the dock faceplate carries a live thumbnail of the module output via hasVideoSurface, and '
      + 'this module is a STATEFUL PARTICLE FIELD — every live shape drifts and bounces every '
      + 'frame, and at the shipped rate a new one spawns every 2250 ms — so the surface is a '
      + 'different picture on every frame and on every capture. The sim is seeded '
      + '(__outlinesVrtSeed) but the elapsed-time integration is not stopped by an AudioContext '
      + 'suspend, which says nothing about a rAF-driven picture.',
    // ⚠ AND THE FREEZE ABOVE IS NOT ENOUGH ON ITS OWN — see BootFaceOptions.simPin.
    // `freezeFaceVideo` stops the picture; it does not choose WHICH picture. This
    // module's field is a STATEFUL integration of elapsed time, so the frozen
    // frame was a different set of shape positions on every boot: measured 6724 px
    // against a 1500 px tolerance, both captures on ubuntu CI. Setting the flag
    // engages the phase pin `outlines.ts` already carries (fixed count of fixed-dt
    // steps on frame 1, then dt=0), making the picture a pure function of
    // (seed, params) — independent of wall clock, boot speed and frame count.
    //
    // The value is the seed `outlines-render-smoke.spec.ts` already pins, reused
    // deliberately: one seed for the module's two deterministic capture paths
    // means a shape layout a human has already looked at in one of them.
    simPin: [
      {
        global: '__outlinesVrtSeed',
        value: 0x0c1c1e5,
        why:
          'OUTLINES is a stateful particle sim: every live shape integrates and bounces per '
          + 'frame, so the picture is a function of ELAPSED TIME, not just of (seed, params). '
          + 'The video freeze holds the last drawn frame but cannot choose which frame that is, '
          + 'so the capture drifted by 4.5x the dock tolerance between two ubuntu CI boots. This '
          + 'flag engages the fixed-dt phase pin already in the module.',
      },
    ],
  },
  // TREE.oh.VOX — three bands (filter / osc / play), and the roster's only
  // GATE-AUDITION voice whose pad is inside the LANE budget, so the compact
  // scene frames a momentary action cell beside two knobs.
  //
  // Deterministic, and for a stronger reason than most: the voice is BIT-SILENT
  // until a gate arrives (measured 0.000e+0 on `audio_out` over 145 frames with
  // nothing patched, #1658). Its `scope` glyph therefore taps an analyser that
  // reads zeros on the scene's frozen graph exactly like every struck voice in
  // the roster — it is not free-running, and it does not exercise the audio
  // freeze the way analogVco does. The only live text is the three sweep
  // readouts, each a pure function of cutoff/envelope/accent, all of which read
  // their declared defaults in the capture: 533 Hz / 3.76 kHz / 5.31 kHz.
  { type: 'treeohvox', pages: 3 },
  // MOOG 984 — the 4×4 matrix, and the roster's first CONSOLE GRID that is not
  // mixmstrs. ONE band (`cross-points`) holding four equal clusters, so
  // `consoleGridCols` answers 4 and the dock scene frames a real table: column
  // j has one centre down all four input rows.
  //
  // ⚠ THIS SCENE IS THE ONLY PIXEL EVIDENCE THAT THE GRID ENGAGED. The unit
  // gates read the PLAN — `module-face-lint` and `dock-row-plan` both see four
  // clusters of four and pass identically whether the shell laid them out on a
  // shared ruler or as four independent flex-wrap rows, which is precisely the
  // defect `console-grid.ts` was written for (measured there: cluster drift
  // accumulating to ~138 px across eight channels on mixmstrs). Alignment is a
  // pixel fact, so this is where it is gated.
  //
  // Deterministic for the strongest reason in the roster: the module is PASSIVE
  // — 24 GainNodes, no worklet, no oscillator, no scheduler — and every
  // cross-point DEFAULTS TO 0, so the graph is bit-exactly silent at spawn. The
  // glyph is a declared 'none', so nothing live is framed at all, and the only
  // text is the four column-sum readouts, each a pure function of four params
  // that all read their declared default. All four therefore print `silent` in
  // the baseline, which is the true statement about an unpatched matrix.
  { type: 'moog984', pages: 1 },
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
  // ranks NOTHING (#1821). `pages: 0` — a face that ranks nothing now renders
  // NO section band at all, so the whole faceplate here is the `fullViewBody`
  // extension (videoOut declares `params: []`).
  //
  // ⚠ THIS ENTRY WAS `pages: 1` AND THAT NUMBER WAS PINNING A DEFECT. The band
  // it counted was an EMPTY `face-page` section, and `.dock-page` carries
  // `border-top: 1px solid` + `padding-top: 6px` — so it painted a bare
  // divider rule under the extension body with nothing beneath it. Harmless
  // enough to miss here, because the extension fills the plate above it; not
  // harmless on the zero-param AUDIO utilities that hit the same branch with
  // no extension at all, where the rule IS the entire faceplate. `dockFacePlan`
  // now refuses the empty band and this scene counts what is really rendered.
  //
  // ⚠ `videoFaceWhy` is MANDATORY and doubly so for this one: the dock body
  // blits the live engine every rAF, and unlike backdraft the COMPACT tile is a
  // live picture too (`hasVideoSurface` mounts VideoTileThumb, and a zero-control
  // face never reaches the plate branch that would evict it — see
  // videoout-face-model.test.ts). Both scenes are moving targets without the
  // video freeze; an AudioContext suspend says nothing about either.
  {
    type: 'videoOut',
    pages: 0,
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
    // reaches the second case. ⚠ THAT HAZARD IS RETIRED as of 2026-08-25 —
    // COMPACT_MAX_DIFF is 0, so a stale baseline FAILS and is therefore
    // rewritable by the capture; the `git rm` step is no longer the only way in.
    // (2026-08-29: still true under the ±2-LSB band — a baseline stale WITHIN
    // the band passes, but that band is the fleet's own per-CPU noise, so
    // "stale by ≤2 LSB" and "current" are not distinguishable states here.)
    // The narrative below is kept because it is the evidence for the row, not
    // because the trap is still open. #1805 changed the fader PRIMITIVE again (it
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
  // THE FACEPLATE QUEUE · Q33 — the video sample-and-hold, and the third video
  // face. `pages: 2` is the declared band count; this face promotes no control
  // into the hero, so neither band is emptied and the count is exactly
  // `face.pages.length`.
  {
    type: 'freezeframe',
    pages: 2,
    videoFaceWhy:
      'both scenes carry a LIVE picture: the compact tile paints a VideoTileThumb through '
      + 'hasVideoSurface, and the dock faceplate shows the same live surface beside the bands. '
      + 'freezeframe is additionally the worst case for an unfrozen capture, because its whole '
      + 'purpose is to decide WHEN the image updates — with nothing patched to GATE it is a '
      + 'continuous live passthrough of whatever the video zone is producing, so an unpinned '
      + 'scene would be sampling a moving source rather than the faceplate.',
  },
  // THE FACEPLATE QUEUE · Q24 — the composite-video destroyer, and the widest
  // video face in the roster at six bands and 20 painted params.
  //
  // `pages: 6` is the declared band count; this face promotes no control into
  // the hero (its hero carries READOUTS only), so no band is emptied and the
  // count is exactly `face.pages.length`. Six is also the number that keeps it
  // OFF the tab rail — `DOCK_TAB_MIN_BANDS` is 7 — so the dock scene frames
  // stacked bands rather than a rail, and this entry is what would go red if a
  // seventh page were ever added to force one.
  {
    type: 'b3ntb0x',
    pages: 6,
    videoFaceWhy:
      'both scenes carry a LIVE picture: the compact tile paints a VideoTileThumb through '
      + 'hasVideoSurface, and the dock body is the module\'s own fullViewBody extension — the '
      + 'CRT preview plus its SCREEN switch. b3ntb0x is the strongest case in the roster for a '
      + 'pinned capture, because its whole subject is a signal path whose artefacts EMERGE over '
      + 'time: the subcarrier phase and the timebase wobble both advance with uTime (the wobble '
      + 'is literally sin(y*47 + uTime*3.3)), so an unfrozen scene would sample a different '
      + 'point of an animating raster on every run.',
    // ⚠ THE FIRST AND ONLY DECLARANT of a per-scene time budget (#1949 / #1955),
    // and the entry that made the mechanism necessary.
    //
    // Both scenes CONVERGED under the flat 90 s cap and both wrote their actual
    // PNG; the dock one was then killed 1.4 s after its snapshot write. Neither
    // tripped `expect.timeout`, which is the budget that gates DETERMINISM and
    // is not moved by this. So this is weight, not a determinism finding — see
    // the note above `FACE_SCENE_BASE_MS`.
    //
    // ⚠ THESE NUMBERS ARE NOW SLIGHTLY CONSERVATIVE, deliberately: they were
    // measured with a hero readout row that the 2026-08-19 owner ruling has
    // since removed from this face. A cheaper scene under an unchanged bound is
    // the safe direction, and re-measuring to shave a bound nobody reaches on
    // green would buy nothing — a timeout is a cap, not a sleep.
    sceneWeight: measuredSceneWeight({
      compactMs: 55_600,
      dockMs: 88_600,
      measuredOn: 'vrt-update capture run 32288252788 (ubuntu-latest, SwiftShader)',
      why:
        'four GLSL programs over six FBOs (two of them RGBA16F), an oversampled composite line, '
        + 'and a 24-iteration per-pixel sync scan in the decode pass. Measured at 2.6x the '
        + 'next-heaviest scene in the roster, and the COMPACT scene — which does not render the '
        + 'dock body at all — already costs 55.6 s against a 7.0-7.7 s non-video / 13.2-21.3 s '
        + 'video population, so the weight is the module\'s own rather than the faceplate\'s.',
    }),
  },
  // THE FACEPLATE QUEUE · Q26 — the granular video synth.
  //
  // `pages: 6` is the declared band count and also the post-split count: this
  // face promotes nothing into the hero (it declares no `hero` at all), so no
  // band is emptied. Six is what keeps it OFF the tab rail
  // (`DOCK_TAB_MIN_BANDS` is 7) — and the seventh page was available and
  // REFUSED, because splitting `fb_zoom`/`fb_rotate` out purely to reach the
  // threshold is the padding the tabbed ruling forbids. This entry is what
  // would go red if a seventh page were ever added to force a rail.
  {
    type: 'grainsOfVision',
    pages: 6,
    videoFaceWhy:
      'both scenes carry a LIVE picture: the compact tile paints a VideoTileThumb through '
      + 'hasVideoSurface, and the dock body is the module\'s own fullViewBody extension. ⚠ AND IT '
      + 'IS THE WORST CASE IN THE ROSTER FOR AN UNPINNED CAPTURE, because ALL THREE of its '
      + 'stateful blocks integrate per DRAW rather than per unit of time: an 8-frame history ring '
      + 'that grains sample a jittered MOMENT from, a feedback buffer that folds the previous '
      + 'output back in zoomed and rotated so the transform compounds, and a reverb accumulator '
      + 'that decays over frames. Pinning a clock would not settle any of them; only the freeze '
      + 'param, which returns out of draw() before any of it advances, does.',
  },
  // THE FACEPLATE QUEUE · Q31 — the hemisphere pool, and the fifth video face.
  //
  // `pages: 4` is the declared band count and also the post-split count: this
  // face promotes NOTHING into the hero (it declares no `hero` at all — the
  // readout row it was authored with was deleted by the 2026-08-19 ruling), so
  // no band is emptied. Four is also what keeps it OFF the tab rail
  // (`DOCK_TAB_MIN_BANDS` is 7), so the dock scene frames stacked bands.
  //
  // ⚠ The face's two X-Y PADS are DOCK-ONLY — `laneOrder` excludes every pad
  // anchor because a pad is square and a lane knob column is 46 px — so the
  // COMPACT scene shows the fader ladder (MODE / WIND / RAIN) and the dock
  // scene is the only one that can ever move when a pad declaration changes.
  {
    type: 'mirrorpool',
    pages: 4,
    // ⚠ COMPACT REMOVED 2026-08-26 — see `faceTiers`. It did not reproduce
    // against its own baseline at the zeroed tolerance (335 px -> 339 px across
    // two runs of the same shards on the same SHA) while every other failing
    // scene reproduced exactly, and the two-boot determinism probe had called it
    // BIT-EXACT. The DOCK scene is unaffected and still gates.
    scenes: ['dock'],
    videoFaceWhy:
      'both scenes carry a LIVE picture: the compact tile paints a VideoTileThumb through '
      + 'hasVideoSurface, and the dock body is the module\'s own fullViewBody extension — the pool '
      + 'preview plus its SCREEN switch. ⚠ AND TIME ALONE CANNOT PIN IT, which is why this entry '
      + 'exists rather than a clock seam: the height field is a PING-PONG SIMULATION integrated '
      + 'once per draw (read front / write back over two float FBOs) and the rain scheduler spawns '
      + 'fresh impacts from a FRAME COUNTER, so the surface keeps evolving with the clock held '
      + 'still. The `freeze` param returns out of `draw` before any of that advances.',
    // ⚠ AND THE FREEZE IS NOT ENOUGH ON ITS OWN — the outlines position exactly.
    // `freezeFaceVideo` makes the picture STOP; it does not choose WHICH picture
    // it stopped on. This module integrates per DRAW, so the held frame is
    // whatever the field had reached when the harness got around to writing
    // `freeze` — a different draw count on every boot.
    //
    // MEASURED (2026-08-21), two consecutive local boots of THIS scene through
    // the real capture path, same machine, same commit: the captured PNGs
    // differed (sha 1073dff7… vs 9bb55a01…). With the three globals below they
    // are BYTE-IDENTICAL across boots (6ed0f1d6… twice). Both directions, which
    // is what makes this a fix rather than a hope. On CI it surfaced as
    // `face-mirrorpool-dock` 1614 px against the 1500 px dock budget — a
    // MARGINAL miss, which is why it rode under the tolerance until it did not,
    // and why no merge in that window is responsible for it.
    //
    // ⚠ THREE GLOBALS, NOT ONE, and each is load-bearing: the seed alone fixes
    // WHICH drops spawn but not HOW MANY frames of them landed, and the clock
    // alone pins `tSec` while the ping-pong field keeps integrating — the
    // module's own `freeze` ParamDef comment says so in those words. This is
    // the same trio `mirrorpool-composite.spec.ts` already installs to call its
    // chain "bit-stable across renderers"; the face harness simply never set
    // them, so the seam was dead here exactly as outlines' was.
    simPin: [
      {
        global: '__videoEngineFreezeTime',
        value: 1.0,
        why:
          'pins `tSec`, the wall-clock term every analytic ring ages against. Without it the '
          + 'ring shapes advance with elapsed milliseconds, which is a different number on every '
          + 'boot. Necessary but NOT sufficient — the module reads this flag and its own comment '
          + 'records that pinning time alone leaves the height field integrating.',
      },
      {
        global: '__mirrorpoolVrtSeed',
        value: 0x51ee,
        why:
          'pins the rain scheduler\'s seeded Poisson stream, so `spawnDrops(rain, seed, frame)` '
          + 'produces the same impacts for the same frame index. Reuses the seed '
          + 'mirrorpool-composite.spec.ts already pins, deliberately: one seed for both of this '
          + 'module\'s deterministic capture paths means a surface a human has already reviewed.',
      },
      {
        global: '__mirrorpoolForceAnalytic',
        value: true,
        why:
          'forces the analytic height path, taking the two float FBOs out of the picture. This is '
          + 'the one that actually removes the accumulated state: the ping-pong sim reads front '
          + 'and writes back EVERY DRAW, so its contents are a function of how many draws '
          + 'happened before the freeze landed and nothing short of not using it can settle that.',
      },
    ],
  },
  // THE FACEPLATE QUEUE · Q5 — the Buchla-259-style complex oscillator.
  //
  // `pages: 2` is the POST-hero-split count: the face declares two bands
  // (`primary`, `modulator`) and `hero.control` promotes `fold` OUT of the
  // first, which leaves it at 3 cells rather than emptying it, so no band is
  // dropped.
  //
  // ⚠ THIS IS THE THIRD FREE-RUNNING MODULE IN THE ROSTER, and it is the only
  // reason its COMPACT scene is interesting. swolevco starts three
  // OscillatorNodes at factory time and declares `glyph: 'scope'`, so its lane
  // tile taps an analyser on a graph that is making full-scale sound from the
  // instant it spawns — measured peak 0.99863 on `out` at the defaults, with
  // no gate and no note to wait for. Every other face in this roster is struck
  // or silent, and their analysers read zeros whether or not the freeze works.
  // `analogVco` (#1420) is the precedent and carries the derivation; this entry
  // extends that coverage rather than repeating it, so if the pre-frame
  // AudioContext suspend or its ORDERING regresses, two scenes go red instead
  // of one.
  //
  // NOT `videoFaceWhy` — the `scope` port is `mono-video`, but that is an
  // OUTPUT a video cable can consume, not a video surface on this module. The
  // face is audio-domain, boots into a channel column, and paints no live
  // picture beyond the glyph the audio freeze already covers.
  { type: 'swolevco', pages: 2 },
  // THE FACEPLATE QUEUE · Q42. One band, two cells — and the two cells are
  // DIFFERENT KINDS on purpose (`level` is a declared 96 px fader throw,
  // `offset` a knob), so this is the roster's smallest scene that still proves
  // the mixed-kind row geometry. Its glyph is a `meter` on `out_l`, which reads
  // exactly zero at spawn because the module ships muted — so the tap is
  // flat-line stable and the scene needs no mask and no VRT_LIVE_SURFACES
  // entry, for the same reason the struck voices above need none.
  { type: 'stereovca', pages: 1 },
  // THE FACEPLATE QUEUE · Q47 — the stereo wavetable oscillator.
  //
  // `pages: 3` is the POST-hero-split count: the face declares three bands
  // (`tone`, `amp env`, `table`) and `hero.cell` promotes the wavetable PANEL
  // out of `table`, which leaves it at three cells rather than emptying it, so
  // no band is dropped. Three is also comfortably under `DOCK_TAB_MIN_BANDS`,
  // so the dock stacks bands rather than showing a rail.
  //
  // ⚠ THE FOURTH FREE-RUNNING MODULE IN THIS ROSTER, and that is the whole
  // determinism story for its COMPACT scene. `wavecel` declares
  // `glyph: 'waveform'`, which binds `live-audio` on `out_l` — and this
  // oscillator makes sound from the instant it spawns, with no gate and no
  // note to wait for (measured peak 0.9999845624 at the defaults, because with
  // nothing in POLY or TRIGGER the amp envelope has nothing to shape and the
  // voice free-runs as a drone). `analogVco` (#1420) carries the derivation and
  // `swolevco` extends it; this is a third witness, so a regression in the
  // pre-frame AudioContext suspend or its ORDERING reddens three scenes.
  //
  // ⚠ ITS DOCK SCENE IS DETERMINISTIC FOR A DIFFERENT REASON, worth stating
  // because the two are unrelated. The hero is a PANEL, not a live trace: the
  // picture is drawn from the wavetable in `node.data` plus the morph/spread
  // knobs plus the CV taps, and the component draws in an EFFECT over those
  // inputs rather than a `requestAnimationFrame` loop (the legacy card uses
  // rAF; the panel deliberately does not). With the graph frozen the taps read
  // 0 and every input is pinned, so the picture is a pure function of its
  // declared state and needs no mask — which matters, because a masked hero
  // picture asserts nothing.
  //
  // NOT `videoFaceWhy` — `scope_out` and `wave3d_out` are video ports a cable
  // can consume, not a video surface on this module. It is an audio def and
  // boots into a channel column like any other audio face.
  { type: 'wavecel', pages: 3 },
  // THE FACEPLATE QUEUE · Q46 — the audio→video raster mapper.
  //
  // `pages: 1` — the face declares no `pages` at all (four params, one honest
  // idea), so the dock renders a single unlabelled band and this is the
  // post-hero-split count. It promotes nothing into the hero.
  //
  // ⚠ NOT `videoFaceWhy`, AND THE REASON IS THE SAME ONE THAT MADE THIS MODULE
  // NEED AN EXTENSION IN THE FIRST PLACE. That option boots the face into the
  // purple VIDEO ZONE, because a video-DOMAIN module never joins a channel
  // column. `rasterize` is `domain: 'audio'` — it boots into a column like any
  // other audio face, and declaring `videoFaceWhy` here would hang the scene in
  // `bootWithFace`'s column wait for the full 90 s, which is `backdraft`'s
  // measured failure read backwards. Its mono-video OUT is a port a video cable
  // consumes, not a video surface on this module (the `swolevco` distinction
  // above, reached from the other side).
  //
  // ⚠ SO THE DOCK PICTURE IS *NOT* COVERED BY `freezeFaceVideo`, AND THE AUDIO
  // FREEZE ALONE IS NOT ENOUGH EITHER — which is exactly the `outlines` shape.
  // The raster is painted in JS by `RasterPainter` on the AUDIO side, so the
  // video freeze has no purchase on it. `rasterize.ts` DOES stop painting when
  // the AudioContext suspends, so the picture stops — but it cannot choose
  // WHERE. The running cursor advances ~0.78 scanlines per frame and how many
  // rAFs land before the suspend varies run to run, so the bands would sit tens
  // of rows apart between two boots: the module's own comment measures ~50
  // lines of wander over a 900 ms settle, which is what put a seed hook in the
  // module to begin with.
  //
  // ⚠ THE HOOK IS NOT DEAD CODE — AND CHECKING THAT IS THE POINT. The
  // `outlines` entry above found a pin whose only setter was one render-smoke
  // spec, so the honest move here was to grep `__rasterizeVrtSeed`'s SETTERS
  // rather than assume the same story twice. It has one: the module's own CARD
  // scene (`vrt-scenes.ts`, set in `afterSpawn`). What it does NOT have is a
  // setter on the FACE boot path — a different harness with a different
  // lifecycle — so the pin is live, correct, and simply unreached from here.
  // `simPin` installs it via `addInitScript` BEFORE `goto`, which is strictly
  // earlier than the card scene manages: the flag is set before any module
  // factory runs, so the very first paint is the seeded one and there is no
  // pre-seed frame to race. Setting it engages the pin the module already
  // carries — RESET, then ONE deterministic full-frame fill from a fixed
  // synthetic 261 Hz sine, with every later advance short-circuited — so the
  // picture becomes a pure function of the module's own constants. Nothing
  // under `packages/web/src/lib/video/**` changes and no attest hash moves.
  {
    type: 'rasterize',
    pages: 1,
    simPin: [
      {
        global: '__rasterizeVrtSeed',
        value: 1,
        why:
          'RASTERIZE paints its picture on the AUDIO side (RasterPainter in JS), so freezeFaceVideo '
          + 'never reaches it, and the audio suspend stops the scan without choosing where it '
          + 'stops. The running cursor advances ~0.78 scanlines every frame and the number of rAFs '
          + 'before the suspend varies per boot, so two captures would frame the same band pattern '
          + 'shifted by tens of rows. This flag engages the deterministic single-fill seed already '
          + 'in the module, which its own VRT comment was written for and which nothing set.',
      },
    ],
  },
  // THE FACEPLATE QUEUE · Q44 — the 4-in / 4-out video cross-point switch, and
  // the video twin of `fourplexer` five entries up.
  //
  // `pages: 1`, and for the SAME reason spelled out on the fourplexer entry:
  // this face declares NO `face.pages` at all, so the dock renders ONE
  // UNLABELLED band holding all four selectors, and this roster counts RENDERED
  // bands rather than declared ones. Its hero promotes nothing (there is no
  // hero), so no band is emptied and none is dropped. Reasoning "no declared
  // `face.pages` ⇒ 0" is the trap that caught the first draft of the fourplexer
  // entry; `noise` is `pages: 0` only because its ONLY key is promoted into
  // `hero.control`, which empties its band.
  //
  // ⚠⚠ `videoFaceWhy` IS THE VIDEO-ZONE BOOT SELECTOR FIRST AND THE FREEZE
  // OPT-IN SECOND, AND THIS ENTRY SHIPPED WITHOUT IT AND HUNG FOR 90 SECONDS.
  // Recorded in full because the mistake is one a careful reader makes.
  //
  // The first draft DECLINED it, with an argument built entirely on
  // `freezeFaceVideo`: this module has no `freeze` param, so writing
  // `params.freeze = 1` is a no-op the factory's `if (!(paramId in params))
  // return` guard rejects, and the still-picture assertion would then pass for
  // a reason unrelated to the flag — a manufactured vacuous negative control.
  // Every fact in that argument is TRUE. It is simply about the WRONG HALF of a
  // two-purpose flag, and the flag's name says which half is primary: it is
  // `videoFaceWhy`, not `freezeWhy`.
  //
  // The other half is `bootWithFace`. Without this field a video module takes
  // the AUDIO path, which spawns at `{x:30, y:4280}` and then waits — with NO
  // explicit timeout, so it inherits the 90 s TEST timeout — for the node to
  // appear in `pinned-mixmstrs.data.columns['1']`. A video module NEVER joins a
  // mixer channel column; it joins the purple VIDEO ZONE. The predicate is
  // therefore never true and the scene dies as
  // `page.waitForFunction: Test timeout of 90000ms exceeded`, having never
  // reached the screenshot at all.
  //
  // ⚠ THIS IS ALREADY DOCUMENTED ON THE FIELD ITSELF, in caps, with backdraft
  // named as the measured precedent ("both its scenes timed out in that
  // waitForFunction"). The draft read the `freezeFaceVideo` HELPER's doc and
  // its call sites and never read the OPTION's own declaration — so the
  // conclusion was reached from two thirds of the evidence and looked
  // well-supported. ⚠ AND THE FAILURE IS INDISTINGUISHABLE FROM A SLOW SCENE
  // FROM THE OUTPUT ALONE: a 90 s timeout at a `waitForFunction` reads as "CI
  // is slow, raise the budget", and raising it would have bought another 90 s
  // of waiting for a condition that can never become true. "Slower" and
  // "never" need opposite fixes.
  //
  // So: A VIDEO FACE ALWAYS DECLARES THIS. There is no such thing as a video
  // face that opts out, and the first entry to try became the proof.
  //
  // ── The freeze question, kept because it is real and must not be re-litigated
  //
  // The freeze half of the flag genuinely IS a no-op here, and that is fine:
  // the assertion it guards (the surface held still) is satisfied STRUCTURALLY
  // rather than by the flag. Measured on the def, not inferred from a green
  // capture: `uTime`, `Date.now`, `performance.now`, `Math.random`,
  // `frame.time`, `frame.frameIndex`, `elapsed` and `accum` occur ZERO times,
  // and `FRAG_SRC` declares exactly two uniforms — `uTex` and `uHas`. The
  // fragment shader is a pure passthrough copy, so the output is a pure
  // function of (four inputs, four indices); with nothing patched every output
  // takes the `uHas < 0.5` branch and is solid black on every frame.
  //
  // ⚠ DO NOT "FIX" THAT BY ADDING A `freeze` PARAM. It would be a `params` edit
  // on a def in the WebGL attest basis — an owner-machine re-attest — to buy an
  // assertion that already holds. And do NOT remove `videoFaceWhy` again on the
  // grounds that the freeze is inert: that is exactly the reasoning above, and
  // it costs both scenes.
  //
  // ⚠ WHAT WOULD CHANGE THE ANSWER: give 4plexvid any accumulator or clock — a
  // crossfade on a gate edge, a tally animation, a `uTime` wipe — and the
  // structural argument dies and the scene needs a real pin.
  //
  // ⚠⚠ AND WHICH PIN DEPENDS ON WHICH OF THOSE TWO WORDS IT IS. This note used
  // to say a `freeze` ParamDef was "the template" and to reach for `simPin`
  // only for a stateful sim. THAT IS BACKWARDS FOR A CLOCK, and it is measured
  // (2026-08-25): SPIROGRAPHS was named here as the template and it HAS a
  // `freeze` ParamDef — yet booting its dock scene twice on ubuntu CI and
  // diffing at threshold 1/255 measured 2711 px at max channel delta 243, over
  // the 1500 px budget that was live at the time. A `freeze` param buys
  // INTRA-boot stillness and nothing else: it holds WHICHEVER frame the harness
  // caught, and for a picture that is a function of `frame.time` that is a
  // different frame on every boot. Its own entry now carries the fix.
  //
  // So, stated as the rule the next reader should apply:
  //
  //   * A WALL-CLOCK-DRIVEN picture with no accumulator (spirographs, inwards)
  //     → `simPin: __videoEngineFreezeTime`. Pinning the clock makes EVERY
  //     frame identical, so "which frame was held" stops being a question.
  //   * A STATEFUL sim whose frame depends on how many draws landed
  //     (mirrorpool's ping-pong field, lushgarden's spawn rate, pong's tick
  //     accumulator) → a `simPin` on the module's OWN seam, and a clock pin
  //     alone is NOT enough; mirrorpool records three globals for exactly this.
  //   * A picture that is already a pure function of its inputs (this entry,
  //     bentbox) → nothing at all.
  //
  // ⚠ AND `simPin` IS THE CHEAPER OF THE TWO WHENEVER IT APPLIES — which is the
  // durable half of the advice this note replaces, so keep it. A `freeze`
  // ParamDef is a `params` edit, and `params` is IN the WebGL attest basis and
  // IN contract-lock, so it costs an owner-machine re-attest and a contract
  // re-pin. `simPin` is an e2e-only boot global: e2e files are excluded from the
  // attest hash by owner directive, so it costs neither. Reach for a ParamDef
  // only when the module has no seam a boot-time global can reach — and note
  // that a WORKER `renderLocus` is exactly that case (the acidwarp position),
  // because `addInitScript` does not run in a worker's global scope.
  {
    type: '4plexvid',
    pages: 1,
    videoFaceWhy:
      'a VIDEO module, so it must boot into the video zone rather than a mixer channel column — '
      + 'without this field bootWithFace waits out the full 90 s test timeout for a column '
      + 'membership a video node never acquires. Both scenes also carry a live picture: the '
      + 'compact tile paints a VideoTileThumb through hasVideoSurface, and the dock body is the '
      + "module's own fullViewBody extension (the OUT 1 preview plus its SCREEN switch). The "
      + 'freeze write itself is a NO-OP on this def (it declares no `freeze` param) and that is '
      + 'deliberate: the surface is a pure passthrough of unpatched inputs, so it is solid black '
      + 'and identical frame to frame by construction rather than by the flag.',
  },
  // BENTBOX — six pages (sync / chroma / bend / feedback / crt / mirror), one
  // per stage of the NTSC chain, against DOCK_TAB_MIN_BANDS = 7, so the dock
  // scene captures STACKED bands under the extension body rather than a rail.
  //
  // ⚠ ITS SIBLING NEEDED A `freeze` PARAM AND THIS ONE DOES NOT — the same
  // question, answered the other way, on measurement rather than by family
  // resemblance. `b3ntb0x` animates by construction (subcarrier phase and a
  // literal `sin(y*47 + uTime*3.3)` wobble, plus CRT persistence feeding the
  // previous frame back), so its capture can never settle and #1941's
  // "a pin gated on a flag nothing sets" applies. BENTBOX's fragment shader
  // RETURNS EARLY when nothing is patched:
  //
  //     if (uHasInput < 0.5) {
  //       float v = vUv.y * 0.05;
  //       outColor = vec4(0.04, 0.06, 0.10 + v, 1.0);
  //       return;
  //     }
  //
  // — a pure function of `vUv` with NO time term, taken BEFORE the mirror fold
  // and before every uTime-driven stage below it. `bootWithFace` spawns exactly
  // one node with nothing patched, so both scenes are a STATIC gradient.
  //
  // ⚠ THE COMMENT ON THAT BRANCH CALLS IT "a dim sweeping color bar field" AND
  // THE CODE DOES NOT SWEEP — there is no time term and no bars, just a vertical
  // ramp. Recorded because the comment is exactly what would talk a later reader
  // out of this scene's determinism argument; the CODE is the evidence.
  //
  // So `freezeFaceVideo`'s `params.freeze = 1` write lands nowhere (no such
  // param) and needs to land nowhere. ⚠ Do NOT "fix" that by adding one: it is a
  // `params` edit on a def inside the WebGL attest basis — an owner-machine
  // re-attest — to buy an assertion that already holds.
  //
  // ⚠ WHAT WOULD CHANGE THE ANSWER: patch anything into IN. Every uTime term in
  // the sync, chroma and feedback stages comes alive at once, and the module
  // becomes the b3ntb0x case exactly. That is also why its CARD scene sits in
  // EXEMPT_FROM_VRT as "animated … defeats deterministic capture" — that scene
  // has a source; this one does not, and the two must not be reasoned about
  // together.
  {
    type: 'bentbox',
    pages: 6,
    videoFaceWhy:
      'a VIDEO module, so it must boot into the video zone rather than a mixer channel column — '
      + 'without this field bootWithFace waits out the full 90 s test timeout for a column '
      + 'membership a video node never acquires. Both scenes also carry a live picture: the '
      + 'compact tile paints a VideoTileThumb through hasVideoSurface, and the dock body is the '
      + "module's own fullViewBody extension (the CRT preview, its SCREEN switch, and the "
      + 'fullscreen / full-frame / present affordances promotion would otherwise delete). The '
      + 'freeze write itself is a NO-OP on this def — it declares no `freeze` param, unlike its '
      + 'sibling b3ntb0x — and that is deliberate: the fragment shader returns early when '
      + 'nothing is patched into IN, emitting a static vUv-only gradient with no time term, so '
      + 'both scenes are identical frame to frame by construction rather than by the flag.',
  },
  // WARREN'S VISIONS — the 2D spectral video resynthesizer, and the roster's
  // first video face with real `pages`: analysis / motion / grating / output,
  // four bands against DOCK_TAB_MIN_BANDS = 7, so the dock scene captures
  // STACKED bands under the extension body rather than a tab rail. The OUTPUT
  // band is SOLO by construction — `engineFreeze` declares an `options` roster,
  // so it resolves `segmented`, which `PARAM_CELL_WIDTH_CLASS` classes 'wide'.
  //
  // ⚠ THIS SCENE GATES THE PICTURE, WHICH THE MODULE'S CARD BASELINE DOES NOT.
  // `vrt.spec.ts` masks `warrensvisions-canvas` through `VRT_MODULE_MASKS`, so
  // on that scene the picture is not compared at all. THIS file applies no
  // masks (see the header) — a deliberate choice, not an oversight: the honest
  // test of the determinism seam below is to let it be compared, and the
  // structural argument is strong enough to carry it.
  //
  // ── THE FREEZE WRITE IS A NO-OP HERE, TWICE OVER, AND BOTH REASONS MATTER ──
  //
  // `freezeFaceVideo` writes `params.freeze = 1`. This def declares no param by
  // that name, so the write lands nowhere — the 4plexvid case.
  //
  // ⚠ AND THE PARAM THAT *LOOKS* LIKE THE ANSWER IS NOT ONE. `engineFreeze` is
  // a PLAYER control, not a determinism toggle, and the def says so in its own
  // docs: FREEZE stops the ANALYSIS while *"slew, drift and rendering all keep
  // running"*. Renaming it to `freeze`, or teaching the harness to write it,
  // would hold the component bank and leave the picture moving — a freeze that
  // reports success and pins nothing. "Has a freeze param" and "is
  // deterministic" are independent in both directions. Do NOT add a real
  // `freeze` param either: that is a `params` edit on a def inside the WebGL
  // attest basis, i.e. an owner-machine re-attest, to buy an assertion that
  // already holds.
  //
  // ── WHY IT HOLDS STILL ANYWAY, STRUCTURALLY ────────────────────────────────
  //
  // WARREN'S VISIONS is an EFFECT, not a source, and `bootWithFace` spawns one
  // node with nothing patched. With no texture on `video_in` the luma plane is
  // zero, the FFT finds no peaks, the tracker claims nothing, every ring energy
  // is zero, and the composite's `uHasSrc` branch outputs black. The module's
  // own e2e already measures this leg — *"unpatched input renders black without
  // erroring"*, `nonZeroFrac < 0.02` (`e2e/tests/warrensvisions.spec.ts`). An
  // empty bank has no envelope to advance and no phase to drift (DRIFT ships at
  // 0), so the surface is identical frame to frame for the same reason
  // 4plexvid's is: there is nothing in it.
  //
  // ⚠ WHAT WOULD CHANGE THE ANSWER: patch anything into this scene's VIDEO IN,
  // or ship a non-zero DRIFT/RESIDUAL default, and the structural argument dies
  // — the bank starts tracking and slewing per drawn frame and the picture is a
  // function of the FRAME COUNT the capture happened to reach. The fix then is
  // NOT a bigger budget and NOT `engineFreeze`: it is `simPin` on the engine
  // clock, which this module is already wired for — `warrensvisions.ts` reads
  // `dt` from `frame.time` (the clock `__videoEngineFreezeTime` pins) and
  // explicitly NOT from `frame.timeDelta`, with the reason on the line, and its
  // residual RNG is the fixed `WV_NOISE_SEED`. So every envelope is a function
  // of the frame count the test drove, on any renderer.
  {
    type: 'warrensvisions',
    pages: 4,
    videoFaceWhy:
      'a VIDEO module, so it must boot into the video zone rather than a mixer channel column — '
      + 'without this field bootWithFace waits out the full 90 s test timeout for a column '
      + 'membership a video node never acquires. Both scenes also carry a live picture: the '
      + 'compact tile paints a VideoTileThumb through hasVideoSurface, and the dock body is the '
      + "module's own fullViewBody extension (the resynthesis preview plus its SCREEN switch), "
      + 'which this file does NOT mask even though the card baseline does. The freeze write '
      + 'itself is a NO-OP on this def — it declares `engineFreeze`, a player control that stops '
      + 'the ANALYSIS while slew, drift and rendering keep going, and no param named `freeze` at '
      + 'all. That is deliberate: this is an EFFECT with nothing patched into VIDEO IN, so the '
      + 'bank is empty and the composite outputs black on every frame by construction rather '
      + 'than by the flag.',
  },
  // MANDELBULB — three pages (camera / shape / slice) against
  // DOCK_TAB_MIN_BANDS = 7, so the dock scene captures STACKED bands under the
  // extension body. The dock body carries TWO canvases: the ray-marched preview
  // and the SLICE WAVEFORM trace.
  //
  // ⚠ THIS ENTRY'S FIRST DRAFT SAID THIS MODULE NEEDED NO `freeze` PARAM, AND
  // IT WAS WRONG. Recorded because the wrong reading is the NATURAL one and the
  // next person will reach for it too. The reasoning was: the fragment shader
  // has no `uTime` uniform at all and takes its camera from PARAMS, so a scene
  // that spawns one node and writes nothing should be a still picture.
  //
  // Every clause of that is true and the conclusion is still false. The one
  // time term is AUTOSPIN — and `autospin` DEFAULTS TO 1. The def's own docs
  // say so outright ("default 1 (on) … keeping the bulb tumbling (and the
  // scene perpetually re-rendering)"), and `draw` advances
  // `spinPhase += dt * AUTOSPIN_RATE` off `frame.time` every frame. So the
  // capture is a MOVING TARGET at the shipped defaults, and only a
  // param-default check caught it — reading the draw path alone did not.
  //
  // Hence a real `freeze` param, declared `noUserControl` (`writer: 'internal'`)
  // so it paints nowhere, and taken BEFORE the spin tick so `spinPhase` is held
  // too. This is the spirographs / backdraft / b3ntb0x / grainsOfVision shape,
  // and it is what `freezeFaceVideo` already writes.
  //
  // ⚠ THE SLICE TRACE IS STATIC FOR A SEPARATE REASON, and it does not depend
  // on the freeze: it is fed by `read('sliceWave')`, which is null until SLICE
  // has been ON at least once. `slice` defaults to 0, so both scenes capture
  // the empty centre-line — the honest picture of "no cross-section has been
  // read yet" rather than a waveform whose shape would depend on when the
  // screenshot landed.
  {
    type: 'mandelbulb',
    pages: 3,
    videoFaceWhy:
      'a VIDEO module, so it must boot into the video zone rather than a mixer channel column — '
      + 'without this field bootWithFace waits out the full 90 s test timeout for a column '
      + 'membership a video node never acquires. Both scenes also carry a live picture: the '
      + 'compact tile paints a VideoTileThumb through hasVideoSurface, and the dock body is the '
      + "module's own fullViewBody extension (the raymarched preview, its SCREEN switch, and "
      + 'the slice waveform trace). ⚠ AND THE FREEZE IS LOAD-BEARING HERE, unlike the other '
      + 'video faces in this roster: AUTOSPIN defaults to ON and advances the camera yaw from '
      + 'frame.time on every frame, so the bulb tumbles at the shipped defaults and an unfrozen '
      + 'scene would sample a different rotation on every run. The `freeze` param this module '
      + 'declares holds the draw BEFORE the spin tick, so the phase is held too.',
  },
  // THE FACEPLATE QUEUE · Q49 — the self-building wavetable oscillator, and the
  // first RAILED face in this batch.
  //
  // `pages: 7` is the POST-hero band count, and there is no hero to subtract:
  // the face declares seven pages and promotes nothing out of them, so seven
  // bands reach `dockTabPlan` and the rail engages at `DOCK_TAB_MIN_BANDS`.
  // ⚠ THE DOCK SCENE THEREFORE FRAMES ONE BAND, NOT SEVEN — a railed face
  // renders only the active tab, and the six inactive bands have no layout box
  // at any viewport height. That is scope note 1 of this spec's own header, and
  // it means the dock baseline here proves the picture head, the rail and the
  // `vco` page; the other six pages are gated by `faceplate-platform` and the
  // pure `dock-row-plan` / `module-face-lint` units, which read the whole
  // faceplate. Do NOT read a green dock baseline as evidence that a change to
  // `src b` was a no-op.
  //
  // ⚠ THE HOOK IS NOT DEAD CODE, CHECKED THE SAME WAY `rasterize` CHECKED ITS
  // OWN. Grepping `__foxyVrtSeed`'s SETTERS finds exactly one — the module's
  // own CARD scene in `vrt-scenes.ts` — and none on the FACE boot path, which
  // is a different harness with a different lifecycle. So the pin is live and
  // correct and simply unreached from here, the same shape as rasterize's and
  // NOT the `outlines` story where the only setter was a render-smoke spec.
  {
    type: 'foxy',
    pages: 7,
    simPin: [
      {
        global: '__foxyVrtSeed',
        value: 1,
        why:
          'FOXY builds its picture on the AUDIO side — three RasterPainters plus the XYZ and '
          + 'wavetable renderers, all in JS — so freezeFaceVideo never reaches it, and suspending '
          + 'the AudioContext stops the bridge without choosing WHERE it stops. The bridge is '
          + 'throttled to ~24Hz and each tick advances three independent raster cursors at three '
          + 'different strides (6000 / 4500 / 5200 samples), so the number of ticks landing before '
          + 'the suspend varies per boot and two captures would frame three different band '
          + 'patterns feeding a different heightfield and therefore a different 64x256 table — the '
          + 'drift compounds through every stage rather than shifting one picture. This flag '
          + 'engages the deterministic seed already in the module (`paintSeeded`: reset all three '
          + 'cursors, then ONE full-frame fill from three fixed synthetic waveforms, with every '
          + 'later advance short-circuited), making all five pictures a pure function of the '
          + "module's own constants. It is an AUDIO def, so no attest hash moves.",
      },
    ],
  },
  // GATEMAIDEN (2026-08-20) — the gate↔trigger converter. ONE declared page and
  // no hero, so nothing is promoted out of a band and `pages: 1` is both the
  // declared count and the post-hero-split count.
  //
  // PIXEL-DETERMINISTIC, and for the strongest of the reasons this file
  // distinguishes: the module has NO GENERATOR IN IT. Both outputs are pure
  // functions of the INPUT's level and rising edges (`GateMaidenState.step`),
  // and the scene patches nothing in, so `wasHigh` never flips, `sinceRise`
  // stays at its −1 rest and both jacks are bit-exactly zero on every sample
  // regardless of how far the clock ran. This is the silent-at-spawn case this
  // file already names for moogCp3, not the analogVco free-running one — the
  // AudioContext freeze is a belt on a brace here rather than the thing holding
  // the scene.
  //
  // ⚠ NO LIVE GLYPH TO GO WRONG EITHER, and the reason is a trap worth having
  // written down: `glyph: 'none'` is FORCED, because `primaryAudioOutPortId`
  // matches `type === 'audio'` and BOTH of this module's outputs are `gate`.
  // `domain: 'audio'` does not imply an audio glyph. The same split is why this
  // face renders `.faceplate.gate` and NOT `.faceplate.audio` — a selector
  // keyed on the audio class silently matches nothing here, which is already
  // recorded against this module in `e2e/tests/_face-fixtures.ts`.
  //
  // Both cells are ASCII-only by construction (`TRI` / `SQR`, and a `·` in the
  // band label) — deliberately, because the fonts this suite pins are ~230
  // codepoint Latin subsets and a geometric-shape glyph would render through an
  // unpinned fontconfig fallback in these two new baselines.
  { type: 'gatemaiden', pages: 1 },

  // TEMPOLOCK (2026-08-29) — the beat-tracking clock, born faced. One
  // declared page (`tempo band`, one segmented cell) and no hero, so
  // `pages: 1` is both the declared and the rendered count; the dock scene
  // additionally frames the LOCK + BEAT status body at the full-view head.
  //
  // PIXEL-DETERMINISTIC for the gatemaiden reason, one notch stronger: the
  // module has no generator AND no picture — the body is two DOM `StatusLed`s
  // and the scene patches nothing in, so the tracker sits in its COLD state
  // (both lamps dark, static aria strings) on every boot regardless of how
  // far the clock ran. No canvas, no worklet, no analyser-driven glyph; the
  // AudioContext freeze is a belt on a brace here.
  //
  // ⚠ `glyph: 'none'` IS FORCED (the gatemaiden trap, port for port):
  // `primaryAudioOutPortId` matches `type === 'audio'` and this def's outputs
  // are gate/cv/gate, so this face renders `.faceplate.gate`, NOT
  // `.faceplate.audio`. All three option labels are ASCII by construction
  // ('60-120' etc.) — the pinned VRT fonts are ~230-codepoint Latin subsets.
  { type: 'tempolock', pages: 1 },

  // ── BATCH 18 — THE THIN AUDIO TAIL (attenuator pair) ────────────────────
  //
  // Three and four identical knobs respectively, one band each (`pages: 1`):
  // neither declares `face.pages`, because a row of channel attenuators is ONE
  // idea and splitting it under headings would spend vertical space to say
  // nothing.
  //
  // NO `videoFaceWhy` and no `simPin`. Both are PASSIVE — pure GainNode graphs
  // with no worklet, no oscillator and no analyser tap — and both declare
  // `glyph: 'none'`, so there is no live picture in either scene and nothing to
  // converge. With nothing patched in, a passive attenuator is bit-exactly
  // silent by construction rather than by the AudioContext freeze.
  { type: 'moog992', pages: 1 },
  { type: 'moog995', pages: 1 },
  // ── BATCH 18 — THE THIN AUDIO TAIL (Moog cluster) ───────────────────────
  //
  // Two to three controls each, so `pages: 1` throughout: none declares
  // `face.pages`, and three controls that are all one idea do not become
  // clearer split under headings.
  //
  // NO `videoFaceWhy` and no `simPin`. Three of the four declare
  // `glyph: 'meter'`, but a meter over a module with nothing patched into it is
  // a flat bar and the harness's AudioContext freeze holds it there — these are
  // filters, an interface and a spring reverb, none of which generate signal on
  // their own. (`moog905` is a reverb with NO input patched in the scene, so its
  // tail never starts, let alone decays.)
  { type: 'moog904b', pages: 1 },
  { type: 'moog904c', pages: 1 },
  { type: 'moog905', pages: 1 },
  { type: 'moog961', pages: 1 },
  // ── BATCH 18 — THE THIN AUDIO TAIL ──────────────────────────────────────
  //
  // One-knob utilities. These are among the NARROWEST plates in the fleet and
  // that is the correct result, not a capture bug: compact is the default and
  // width is earned, so a module with one control gets a plate the size of one
  // control.
  //
  // `pages: 1` throughout — each ranks exactly one param and declares no
  // `face.pages`, so `dockFacePlan` returns the single unlabelled `__all` band.
  //
  // NO `videoFaceWhy` and no `simPin` on any of them: all four are audio
  // utilities that are SILENT AT SPAWN. moog903a and scaler declare
  // `glyph: 'meter'`, but a meter over a module with nothing patched in is a
  // flat bar, and the harness's AudioContext freeze holds it there — there is
  // no free-running oscillator and no analyser tap that needs to converge.
  { type: 'moog903a', pages: 1 },
  { type: 'moog962', pages: 1 },
  {
    type: 'sampleHold',
    pages: 1,
  },
  { type: 'scaler', pages: 1 },
  // Utilities whose whole control surface is one knob or nothing at all. These
  // are the NARROWEST plates in the fleet and that is the correct result, not a
  // capture bug: compact is the default and width is earned, so a module with
  // one knob gets a plate the size of one knob.
  //
  // ⚠ `pages: 0` ON THE TWO ZERO-PARAM ENTRIES IS THE INTERESTING NUMBER, and
  // it is NOT "no scene". Both modules declare `params: []` — a gate flip-flop
  // whose alternation lives in the worklet, and a passive multiple that is a
  // solder junction — so `face.order` is empty, `dockFacePlan` returns NO band,
  // and the dock faceplate is the TITLE plus the jack field with no section
  // between them. Before this batch that branch emitted an EMPTY `face-page`
  // section, which `.dock-page`'s `border-top` painted as a bare divider rule
  // over nothing; the planner now refuses it (see `curated-face.ts`), which is
  // also why `videoOut` above moved from 1 to 0.
  //
  // NO `videoFaceWhy` and no `simPin` on any of the four: every one is a
  // silent-at-spawn audio utility with `glyph: 'none'`, so there is no live
  // picture, no free-running oscillator and no analyser tap to converge. The
  // AudioContext freeze the harness applies is a belt on a brace here.
  { type: 'depolarizer', pages: 1 },
  { type: 'flipper', pages: 0 },
  { type: 'moog994', pages: 0 },
  { type: 'polarizer', pages: 1 },
  // RUTTETRA (`label: 'xyz'`) — the authentic forward-scatter Rutt/Etra scan
  // processor, and the roster's first MONITOR-MODE face (#2009).
  //
  // `pages: 4` is the declared band count and also the rendered one: relief /
  // shape / scan / beam, and this face promotes NOTHING into the hero (it
  // declares no `hero` at all — the two readouts it was specced with were
  // deleted by the 2026-08-19 rulings), so no band is emptied and none is
  // dropped by `heroFacePlan`. Four is also what keeps it OFF the tab rail
  // (`DOCK_TAB_MIN_BANDS` is 7, and the owner ruled it untabbed), so the dock
  // scene frames STACKED bands under the extension body. They pack to TWO ROWS
  // under `DOCK_ROW_MAX_CONTROLS = 10` — (2+2) then (4+4) — which is what the
  // dock capture should show.
  //
  // ⚠ WHAT THESE TWO SCENES CAPTURE AT REST IS THE MODE **OFF**, and that is
  // not a gap in the coverage, it is the only honest resting state.
  // `hideControls` is a per-NODE runtime key and `bootWithFace` spawns a fresh
  // node, so it is absent ⇒ false ⇒ controls showing. The dock baseline
  // therefore pins the ORDINARY faceplate — extension body, then four bands —
  // and a monitor-mode capture would be pinning a state no freshly opened
  // faceplate is ever in. The suppression itself is proven where it can be:
  // `faceMonitorPlan` in the unit lane (exhaustively, including "never a blank
  // plate") and the faced leg of `video-hide-controls.spec.ts` in the browser,
  // which is the only thing that can see the bands actually leave.
  //
  // ⚠ NO `freeze` PARAM, AND UNLIKE ITS SIBLINGS THAT IS TRUE WITH A SOURCE
  // PATCHED TOO. bentbox and warrensvisions both argue determinism from having
  // NOTHING patched — patch their inputs and every uTime term wakes up. This
  // def has no `uTime` uniform anywhere in `VERT_SRC`/`FRAG_SRC`, no ping-pong,
  // no accumulator and no feedback: `draw` clears to black and redraws from the
  // input texture and the params every frame, so the output is a pure function
  // of (source frame, params). `bootWithFace` patches nothing, so `z` binds the
  // constant 1x1 mid-grey sentinel and the raster is flat scanlines — identical
  // frame to frame for a strictly stronger reason than its siblings'. Do NOT
  // add a `freeze` param to "make it safe": that is a `params` edit on a def
  // inside the WebGL attest basis, i.e. an owner-machine re-attest, to buy an
  // assertion that already holds.
  {
    type: 'ruttetra',
    pages: 4,
    videoFaceWhy:
      'a VIDEO module, so it must boot into the video zone rather than a mixer channel column — '
      + 'without this field bootWithFace waits out the full 90 s test timeout for a column '
      + 'membership a video node never acquires. Both scenes also carry a live picture: the '
      + 'compact tile paints a VideoTileThumb through hasVideoSurface, and the dock body is the '
      + "module's own fullViewBody extension — the raster preview plus the THREE affordances "
      + 'promotion would otherwise delete (SCREEN ON/OFF, the MONITOR toggle that hides the '
      + 'control bands, and the corner resize). The freeze write itself is a NO-OP on this def — '
      + 'it declares no `freeze` param at all — and that is deliberate rather than an omission: '
      + 'there is no uTime uniform in either shader stage, no ping-pong and no accumulator, so '
      + 'the render is a pure function of (source frame, params) and is identical frame to frame '
      + 'by construction. With nothing patched, `z` binds a constant mid-grey sentinel.',
  },
  // COLOUROFMAGIC (2026-08-20) — the multi-colorspace processor, and the
  // largest face in the roster by param count (37).
  //
  // `pages: 5` is the POST-HERO-SPLIT band count, and here the two numbers
  // genuinely differ: `face.pages` declares SIX entries, and the hero promotes
  // `preview` out of the `output` page, which was its only control. So
  // `heroFacePlan` DROPS that emptied band — the `noise` case — and the dock
  // renders the five colorspace blocks. Reading the declared length here would
  // pin 6 and be wrong.
  //
  // ⚠ IT DOES NOT REACH THE TAB RAIL, which is the counter-intuitive part of a
  // 37-param module: `DOCK_TAB_MIN_BANDS = 7` counts BANDS. Five honest blocks
  // render as one column, and padding to seven to force the rail is refused by
  // the owner ruling.
  //
  // PIXEL DETERMINISM, and this module is the EASY case rather than the hard
  // one. The shader is a pure per-frame function of its input — five colorspace
  // encode/bias/decode passes, no feedback buffer, no accumulator, no RNG and
  // no time term. Nothing is patched into VIDEO IN in this scene, so `uHasInput`
  // is 0 and every frame is identical by construction, not by the flag. The
  // `freeze` write is therefore a belt on a brace here, unlike freezeframe or
  // warrensvisions where it (or `simPin`) is the thing holding the scene.
  //
  // ⚠ AND `freeze` IS WHY THAT PARAM STILL EXISTS ON A FACED MODULE.
  // `freezeFaceVideo` writes `params.freeze = 1` directly into the patch, so
  // the harness needs the param — but the def now declares it `noUserControl`
  // (`writer: 'internal'`), so face completeness no longer PAINTS it. Without
  // that, promotion would have put a "hold the last rendered frame" switch on
  // the player's faceplate, where a frozen picture reads as a broken module.
  // The harness keeps its hook; the player never sees it.
  //
  // NOT MASKED. The dock body is the module's own `fullViewBody` extension (the
  // preview canvas plus its SCREEN switch) and the compact tile is a
  // VideoTileThumb — both black-and-stable with nothing patched, for the reason
  // above. This is the `warrensvisions` position: the CARD baseline masks its
  // canvas (`VRT_MODULE_MASKS`, because the card is captured on a live rack),
  // and the FACE scenes do not need to.
  {
    type: 'colourofmagic',
    pages: 5,
    videoFaceWhy:
      'a VIDEO module, so it must boot into the video zone rather than a mixer channel column — '
      + 'without this field bootWithFace waits out the full 90 s test timeout for a column '
      + 'membership a video node never acquires. Both scenes carry a live picture: the compact '
      + 'tile paints a VideoTileThumb through hasVideoSurface, and the dock body is the '
      + "module's own fullViewBody extension (the preview canvas plus its SCREEN ON/OFF switch, "
      + 'which a faced video module can only reach through that slot — #1928). Neither is '
      + 'masked: the shader is a pure per-frame function of VIDEO IN with no feedback, '
      + 'accumulator, RNG or time term, and nothing is patched in this scene, so the picture is '
      + 'identical on every frame by construction. The freeze write DOES land on this def — it '
      + 'declares a real `freeze` param, which is why that param survives promotion as '
      + '`noUserControl` rather than being deleted — but it is holding an already-static '
      + 'picture, so it is a belt on a brace rather than the thing making the scene capturable.',
  },
  // CV BUDDY + CV BUDDY MINI (2026-08-21) — the Q52 pair, and the roster's
  // first AUDIO faces whose dock head is an extension `fullViewBody`.
  //
  // `pages: 1` on both: ONE declared band (`clock`), no hero, nothing dropped.
  // That single band is also the entire control surface — both params are clock
  // params — which is what makes the dock scene worth looking at: the head is
  // the module's own status body (the slot NAME plus the ROUTED / LATE lamps),
  // and the band sits under it.
  //
  // ⚠ BOTH SCENES CAPTURE THE PRIMARY INSTANCE, and that is the only state a
  // fresh spawn can be in: `bootWithFace` spawns ONE node, so it is trivially
  // the id-smallest of its peer set and `rackStatusPlan` suppresses nothing.
  // A non-primary capture would be pinning a state no freshly opened faceplate
  // is ever in — the `ruttetra` monitor-mode argument verbatim. The suppression
  // is proven where it can be: `rack-status-model.test.ts` exhaustively in the
  // unit lane, and `cv-buddy-face.spec.ts` in the browser with a real SECOND
  // instance, which is the only thing that can see the band actually leave.
  //
  // ⚠ NO MASK, AND NO LIVE SURFACE. The status body is DOM — two lamps and a
  // name — with no canvas, no analyser tap and no rAF. The one moving part is a
  // 1 Hz `setInterval` reading the clock-skip counter, and with no ES-9 and no
  // transport running it reads 0 on every poll, so the lamp is dark and static.
  // The ROUTED lamp is dark too (this scene has no ES-9 node), which is the
  // resting state of a CV Buddy on any rack that has not been wired to
  // hardware yet.
  { type: 'cvBuddy', pages: 1 },
  { type: 'cvBuddyMini', pages: 1 },
  // MONOGLITCH (2026-08-21) — the luma-driven scanline glitch, and the SECOND
  // module to carry MONITOR MODE onto its faceplate after `ruttetra` proved the
  // seam (#2009 / #2053).
  //
  // `pages: 4` is both the declared count and the POST-HERO-SPLIT count, and
  // here the two cannot differ: this face declares NO `hero` at all, so
  // `heroFacePlan` promotes nothing and empties no band. Four bands — lift /
  // raster / pan / tint, one per TERM of the fragment shader — sit under
  // `DOCK_TAB_MIN_BANDS = 7`, so the dock scene frames a COLUMN, not a rail.
  //
  // ⚠ AND UNLIKE RUTTETRA'S, ALL FOUR BANDS PACK INTO ONE ROW. Eight controls
  // is under `DOCK_ROW_MAX_CONTROLS = 10`, so PF-21 emits a single packed row
  // rather than ruttetra's two — which is what the dock capture should show, and
  // is pinned in the unit lane by `monoglitch-face-model.test.ts` rather than
  // left for a pixel diff to discover.
  //
  // ⚠ WHAT THESE TWO SCENES CAPTURE AT REST IS MONITOR MODE **OFF**, and that is
  // the only honest resting state rather than a gap. `hideControls` is a
  // per-NODE runtime key and `bootWithFace` spawns a fresh node, so it is absent
  // ⇒ false ⇒ controls showing. The dock baseline therefore pins the ORDINARY
  // faceplate — extension body, then four bands — and a monitor-mode capture
  // would be pinning a state no freshly opened faceplate is ever in. The
  // suppression is proven where it can be: `faceMonitorPlan` in the unit lane,
  // and the faced leg of `video-hide-controls.spec.ts` in the browser, which is
  // the only thing that can see the bands actually leave.
  //
  // ⚠ NO `freeze` PARAM, AND — as with ruttetra — that is true with a source
  // patched too, which is the stronger form of the argument. `bentbox` and
  // `warrensvisions` argue determinism from having NOTHING patched, so every
  // uTime term wakes up the moment you patch them. `FRAG_SRC` here has no uTime
  // uniform, no ping-pong, no accumulator and no RNG: the output is a pure
  // function of (source frame, params). `bootWithFace` patches nothing, so
  // `uHasInput` is 0 and the shader paints its fixed dark-navy idle gradient —
  // identical frame to frame by construction. Do NOT add a `freeze` param to
  // "make it safe": that is a `params` edit on a def inside the WebGL attest
  // basis, i.e. a real-GPU re-attest, to buy an assertion that already holds.
  //
  // ⚠ THE CARD BASELINE MASKS THIS CANVAS AND THESE SCENES DO NOT — the
  // `warrensvisions` / `colourofmagic` position. `VRT_MODULE_MASKS` masks
  // `monoglitch`'s canvas because the CARD is captured on a live rack; the face
  // scenes boot their own node with nothing patched and need no mask.
  {
    type: 'monoglitch',
    pages: 4,
    videoFaceWhy:
      'a VIDEO module, so it must boot into the video zone rather than a mixer channel column — '
      + 'without this field bootWithFace waits out the full 90 s test timeout for a column '
      + 'membership a video node never acquires. Both scenes also carry a live picture: the '
      + 'compact tile paints a VideoTileThumb through hasVideoSurface, and the dock body is the '
      + "module's own fullViewBody extension — the preview canvas plus the MONITOR toggle that "
      + 'hides the control bands, its corner resize, and a SCREEN ON/OFF switch (which a faced '
      + 'video module can only reach through that slot — #1928). The freeze write itself is a '
      + 'NO-OP on this def — it declares no `freeze` param at all — and that is deliberate '
      + 'rather than an omission: there is no uTime uniform in FRAG_SRC, no ping-pong, no '
      + 'accumulator and no RNG, so the render is a pure function of (source frame, params) and '
      + 'is identical frame to frame by construction. With nothing patched `uHasInput` is 0 and '
      + 'the shader paints a fixed dark-navy idle gradient.',
  },
  // RESHAPER (2026-08-21) — the coordinate-remap processor, and the THIRD
  // adopter of MONITOR MODE after `ruttetra` proved the seam and `monoglitch`
  // inherited it.
  //
  // `pages: 2` is both the declared count and the POST-HERO-SPLIT count: this
  // face declares NO `hero`, so `heroFacePlan` promotes nothing and empties no
  // band. Two bands — warp / colour, the two shader stages that HAVE params —
  // sit far below `DOCK_TAB_MIN_BANDS = 7`, so the dock scene frames a column;
  // six controls is under `DOCK_ROW_MAX_CONTROLS = 10`, so PF-21 packs both
  // bands into a single row.
  //
  // ⚠ THE EASIEST DETERMINISM CASE IN THE VIDEO BANK, and it is worth saying why
  // rather than leaving the absence of `simPin` to look like an oversight.
  // `FRAG_SRC` declares no time uniform, no ping-pong, no accumulator and no
  // RNG — the output is a pure function of (X, Y, Z, params). `bootWithFace`
  // patches nothing, so all three samplers take their `uHas* < 0.5` branch: the
  // ramps fall back to the IDENTITY `vUv.x`/`vUv.y` and the source resolves to a
  // constant `vec3(0.5)`, painting a flat mid-grey field multiplied by the unity
  // tint. Every param also ships AT IDENTITY (disp 0/0, gain 1, tint 1/1/1), so
  // the scene is byte-stable by construction rather than by a flag.
  //
  // Corroborated independently: `vrt-live-surfaces.ts` records this module
  // measured at "10/10 processes PASS — no mask" for its CARD scene.
  //
  // ⚠ WHAT THESE TWO SCENES CAPTURE AT REST IS MONITOR MODE **OFF**, the only
  // honest resting state — `hideControls` is a per-NODE runtime key and
  // `bootWithFace` spawns a fresh node, so it is absent ⇒ false ⇒ controls
  // showing. The suppression is proven in the unit lane (`faceMonitorPlan`) and
  // in the faced leg of `video-hide-controls.spec.ts`, which is the only thing
  // that can see the bands actually leave.
  {
    type: 'reshaper',
    pages: 2,
    videoFaceWhy:
      'a VIDEO module, so it must boot into the video zone rather than a mixer channel column — '
      + 'without this field bootWithFace waits out the full 90 s test timeout for a column '
      + 'membership a video node never acquires. Both scenes also carry a live picture: the '
      + 'compact tile paints a VideoTileThumb through hasVideoSurface, and the dock body is the '
      + "module's own fullViewBody extension — the preview canvas plus the MONITOR toggle that "
      + 'hides the control bands, its corner resize, and a SCREEN ON/OFF switch (which a faced '
      + 'video module can only reach through that slot — #1928). The freeze write itself is a '
      + 'NO-OP on this def — it declares no `freeze` param — and that is deliberate rather than '
      + 'an omission: there is no time uniform, ping-pong, accumulator or RNG in FRAG_SRC, so the '
      + 'render is a pure function of (X, Y, Z, params). With nothing patched the ramps fall back '
      + 'to identity and the source resolves to a constant mid-grey, so the picture is a flat '
      + 'field that is identical on every frame.',
  },
  // ── BATCH 22 · GROUP 1 — the video thin tail, four fader banks ────────────
  //
  // All four are `pages: 1`: each face declares no `pages`, so the dock renders
  // ONE unlabelled band. All four declare every param as a `fader`, so every
  // scene here is a fader face — measured through `curatedFace`, a video fader
  // face resolves plate = 2 (the note on reshaper/ruttetra in strict-faces.ts),
  // so no tint reaches a lane tier and the compact tile is the generic
  // VideoTileThumb in all four.
  {
    type: 'edges',
    pages: 1,
    videoFaceWhy:
      'a VIDEO module, so it must boot into the video zone rather than a mixer channel column — '
      + 'without this field bootWithFace waits out the full 90 s test timeout for a column '
      + 'membership a video node never acquires. Both scenes also carry a live picture: the '
      + 'compact tile paints a VideoTileThumb through hasVideoSurface, and the dock body is the '
      + "module's own fullViewBody extension (the outline preview plus its SCREEN switch). The "
      + 'freeze write itself is a NO-OP on this def (it declares no `freeze` param) and that is '
      + 'deliberate rather than an omission: EDGES is a stateless Sobel filter with no time '
      + 'uniform, no ping-pong and no accumulator, so its render is a pure per-pixel function of '
      + '(input, threshold, thickness). With nothing patched into `in` the output is solid black '
      + 'by construction, identical frame to frame.',
  },
  {
    type: 'colorizer',
    pages: 1,
    videoFaceWhy:
      'a VIDEO module, so it must boot into the video zone rather than a mixer channel column — '
      + 'without this field bootWithFace waits out the full 90 s test timeout for a column '
      + 'membership a video node never acquires. Both scenes also carry a live picture: the '
      + 'compact tile paints a VideoTileThumb through hasVideoSurface, and the dock body is the '
      + "module's own fullViewBody extension (the tint preview plus its SCREEN switch). The "
      + 'freeze write is a NO-OP on this def (no `freeze` param) and deliberately so: the tint is '
      + 'a pure per-pixel function of (input, tintR, tintG, tintB) with no clock or accumulator '
      + 'anywhere in its fragment source, and with nothing patched into `in` the output is solid '
      + 'black — the def\'s own docs say so.',
  },
  {
    type: 'inwards',
    pages: 1,
    videoFaceWhy:
      'a VIDEO module, so it must boot into the video zone rather than a mixer channel column — '
      + 'without this field bootWithFace waits out the full 90 s test timeout for a column '
      + 'membership a video node never acquires. Both scenes also carry a live picture: the '
      + 'compact tile paints a VideoTileThumb through hasVideoSurface, and the dock body is the '
      + "module's own fullViewBody extension (the ring preview plus its SCREEN switch). ⚠ UNLIKE "
      + 'its three batch siblings this module GENUINELY ANIMATES AT REST — it is a SOURCE with no '
      + 'video input, and its shader advances `phase = r * uDensity - uTime * uSpeed` with Speed '
      + 'defaulting to 0.5 — so the surface is a different picture on every rendered frame and '
      + 'the scene cannot settle on its own. The clock pin below is what stops it.',
    // ⚠ THE ENGINE CLOCK, NOT A `freeze` ParamDef. This entry used to argue the
    // point AGAINST the roster's own 4plexvid note, which then said a `freeze`
    // param was required for any clocked module and told the reader not to reach
    // for `simPin`. INWARDS WAS RIGHT AND THAT NOTE WAS WRONG: it has since been
    // corrected in place, on the spirographs measurement (2711 px across two
    // ubuntu boots WITH a `freeze` param and no clock pin), so the two no longer
    // disagree and this paragraph is the surviving record of which way it went.
    //
    // The split the corrected note now states: INWARDS is the CLOCK half, and
    // the STATEFUL half is what `mirrorpool` records three
    // globals to work around: pinning time is NOT sufficient there because its
    // ping-pong height field keeps integrating, so the frozen frame still
    // depends on how many draws landed first. INWARDS HAS NO SUCH STATE. Its
    // render is a pure function of (`frame.time`, params) — no ping-pong, no
    // accumulator, no RNG — so pinning the clock makes the picture a pure
    // function of the params alone, which is total determinism rather than a
    // partial settle.
    //
    // That is verbatim the hook's documented purpose: VideoEngine's own comment
    // on `__videoEngineFreezeTime` reads "the engine clock exposed as
    // `frame.time` is PINNED to it while draws STILL run — so a time-animated
    // module renders an identical frame on every step."
    //
    // ⚠ AND IT KEEPS THE FACE ZERO-ATTEST, which is the batch's target. A
    // `freeze` ParamDef is a `params` change, and `params` is IN the attest
    // basis and IN contract-lock, so it would have cost a real-GPU re-attest
    // and a contract re-pin to solve a determinism problem the engine already
    // solves for every video module at once.
    simPin: [
      {
        global: '__videoEngineFreezeTime',
        value: 1.0,
        why:
          'pins `frame.time`, the ONLY time term this module reads — its ring phase is '
          + '`r * uDensity - uTime * uSpeed`. With it pinned the render is a pure function of the '
          + 'three params, so the scene is identical across boots, renderers and frame counts. '
          + 'Sufficient ALONE here, unlike on mirrorpool, because INWARDS carries no ping-pong, '
          + 'no accumulator and no RNG for the clock pin to leave running.',
      },
    ],
  },
  {
    type: 'vdelay',
    pages: 1,
    videoFaceWhy:
      'a VIDEO module, so it must boot into the video zone rather than a mixer channel column — '
      + 'without this field bootWithFace waits out the full 90 s test timeout for a column '
      + 'membership a video node never acquires. Both scenes also carry a live picture: the '
      + 'compact tile paints a VideoTileThumb through hasVideoSurface, and the dock body is the '
      + "module's own fullViewBody extension (the echo preview plus its SCREEN switch). ⚠ THIS "
      + 'MODULE DOES CARRY AN ACCUMULATOR — a 32-slot frame ring advanced by every draw — so the '
      + 'no-accumulator argument its three batch siblings make does NOT apply to it. It settles '
      + 'anyway, for a stronger reason: with nothing patched into `in` the ring is fed solid '
      + 'black and the feedback term multiplies black by 0.4, so every slot is black and stays '
      + 'black no matter how many draws land. The picture is identical frame to frame because '
      + 'its accumulator has converged, not because it has none. ⚠ PATCH A SOURCE INTO THIS '
      + 'SCENE AND THAT ARGUMENT DIES — the ring would then hold a different number of frames of '
      + 'history per boot, and a real `freeze` param (spirographs / b3ntb0x are the template) '
      + 'would become required.',
  },
  // ── BATCH 22 · GROUP 2a — the video thin tail, card-checked cells ─────────
  //
  // Both `pages: 1`: each face declares no `pages`, so the dock renders ONE
  // unlabelled band. ⚠ They do NOT share a primitive — `lumakey` is a fader
  // pair plus a toggle, `shapegen` is a knob pair plus a toggle — which is the
  // reason the group exists and why each face was read off its CARD rather than
  // derived from its def.
  {
    type: 'lumakey',
    pages: 1,
    videoFaceWhy:
      'a VIDEO module, so it must boot into the video zone rather than a mixer channel column — '
      + 'without this field bootWithFace waits out the full 90 s test timeout for a column '
      + 'membership a video node never acquires. Both scenes also carry a live picture: the '
      + 'compact tile paints a VideoTileThumb through hasVideoSurface, and the dock body is the '
      + "module's own fullViewBody extension (the key preview plus its SCREEN switch). The freeze "
      + 'write is a NO-OP on this def (it declares no `freeze` param) and deliberately so: the '
      + 'key is a pure per-pixel smoothstep over (foreground luma, threshold, softness, invert) '
      + 'with no clock, ping-pong or accumulator anywhere in its fragment source. ⚠ AND ITS '
      + 'UNPATCHED STATE IS NOT BLACK, unlike its batch siblings — the def passes the BACKGROUND '
      + 'straight through when no foreground is patched ("a half-wired chain is never a black '
      + 'hole"), so with nothing patched at all the scene is a constant background, still '
      + 'identical frame to frame.',
  },
  {
    type: 'shapegen',
    pages: 1,
    videoFaceWhy:
      'a VIDEO module, so it must boot into the video zone rather than a mixer channel column — '
      + 'without this field bootWithFace waits out the full 90 s test timeout for a column '
      + 'membership a video node never acquires. Both scenes also carry a live picture: the '
      + 'compact tile paints a VideoTileThumb through hasVideoSurface, and the dock body is the '
      + "module's own fullViewBody extension (the shape preview plus its SCREEN switch). The "
      + 'freeze write is a NO-OP on this def (no `freeze` param) and deliberately so: the scene '
      + 'is a pure function of (raster_a, raster_b, raster_c, size, rotate, solids) — there is no '
      + 'time uniform and no accumulator, and the camera orbit is driven by the ROT PARAM rather '
      + 'than by a clock, which is what makes a still frame possible at all. ⚠ WITH NOTHING '
      + 'PATCHED THE SCENE IS EMPTY BY THE MODULE\'S OWN RULE — raster A below the variance floor '
      + 'emits NO shapes — so the capture is the bare wireframe box and floor grid, which is '
      + 'constant. Patch a source into A and that argument dies: the shape set becomes a function '
      + 'of the incoming raster.',
  },
  // ── QUADRALOGICAL (2026-08-22, #2102) — the face where the PICTURE IS THE
  // CONTROL, and the only entry in this roster whose dock scene contains an
  // operable joystick rather than a preview.
  {
    type: 'quadralogical',
    // THREE bands: `field`, `edges`, `key`. Below DOCK_TAB_MIN_BANDS = 7, so
    // the dock renders one column and NOT a tab rail — which is required
    // rather than incidental here: a rail shows one band at a time, so a
    // tabbed face would put at most one of the four EDGE boxes on screen.
    pages: 3,
    videoFaceWhy:
      'a VIDEO module, so it must boot into the video zone rather than a mixer channel column — '
      + 'without this field bootWithFace waits out the full 90 s test timeout for a column '
      + 'membership a video node never acquires. Both scenes carry a live picture: the compact '
      + 'tile paints a VideoTileThumb through hasVideoSurface, and the dock body is the '
      + "module's own fullViewBody extension. ⚠ THE DOCK BODY IS UNLIKE EVERY OTHER ENTRY HERE "
      + 'and the difference matters for what this scene can prove: it is the JOYSTICK — the '
      + 'field, the diamond, the corner labels and the puck — with a live 2×2 preview of the '
      + "four inputs BEHIND it, drawn from the module's own `preview` output port. So the scene "
      + 'holds TWO canvases (the quadrant tile and the puck, which is a window onto the MIX), '
      + 'and freeze must stop both. ⚠ THE FREEZE WRITE IS LOAD-BEARING HERE, not a no-op like '
      + 'the batch-22 group above: this def DOES declare `freeze`, and its `draw()` returns '
      + 'early at >= 0.5 BEFORE either pass, so the MIX fbo and the PREVIEW fbo both hold their '
      + 'last frame together. With nothing patched all four inputs bind the standalone 1×1 black '
      + 'sentinel, so the held picture is black plus the preview shader\'s own separator cross — '
      + 'constant frame to frame, which is what the harness samples. ⚠ AND THE PUCK IS AT THE '
      + 'CENTRE at spawn (pos_x/pos_y default 0), which is inside the diamond, so the scene also '
      + 'pins the diamond geometry against the pad: the drawn rhombus is `diamond_margin` at '
      + '1:1 with the weight model, and a regression that reverted it to the card\'s '
      + 'rotate(45deg) square would be WRONG BY 4/3 on one axis at this frame\'s 4:3 aspect and '
      + 'would show as a moved outline rather than as a silent maths error.',
  },
  // ── BATCH 22 · GROUP 2b — the two faces that cost an attest ───────────────
  //
  // Both `pages: 1` (neither face declares `pages`). Both carry NAMED SELECTORS
  // resolved from `options` rosters newly declared on their defs — which is the
  // change that costs the attest, and the reason these two are split from G2a.
  {
    type: 'tempest',
    pages: 1,
    videoFaceWhy:
      'a VIDEO module, so it must boot into the video zone rather than a mixer channel column — '
      + 'without this field bootWithFace waits out the full 90 s test timeout for a column '
      + 'membership a video node never acquires. Both scenes also carry a live picture: the '
      + 'compact tile paints a VideoTileThumb through hasVideoSurface, and the dock body is the '
      + "module's own fullViewBody extension (the well preview plus its SCREEN switch). The "
      + 'freeze write is a NO-OP on this def (it declares no `freeze` param) and deliberately so: '
      + 'the well is rebuilt every frame from (rim, shape) through tempest-core with no time '
      + 'uniform, no accumulator and no RNG, so with the params at their defaults the geometry is '
      + 'identical on every frame and on every boot. ⚠ THE CLAW IS PART OF THAT — it is a pure '
      + 'function of `rim`, not of elapsed time, so it sits still unless something drives the CV.',
  },
  {
    type: 'fader',
    pages: 1,
    videoFaceWhy:
      'a VIDEO module, so it must boot into the video zone rather than a mixer channel column — '
      + 'without this field bootWithFace waits out the full 90 s test timeout for a column '
      + 'membership a video node never acquires. Both scenes also carry a live picture: the '
      + 'compact tile paints a VideoTileThumb through hasVideoSurface, and the dock body is the '
      + "module's own fullViewBody extension (the main OUT mix preview plus its SCREEN switch). "
      + 'The freeze write is a NO-OP on this def (no `freeze` param) and deliberately so: both '
      + 'passes are a pure blend of (in_a, in_b, return, fader, dryWet, the two transition modes) '
      + 'with no clock and no accumulator. With nothing patched into either input the mix is a '
      + 'constant black and stays black however many draws land. ⚠ PATCH A SOURCE AND THAT '
      + 'ARGUMENT WEAKENS — the picture then tracks whatever the upstream is doing, which for an '
      + 'animated source is a different frame every capture.',
  },
  // ── BATCH 21 · CELLSHADE ──────────────────────────────────────────────────
  {
    type: 'cellshade',
    pages: 1,
    videoFaceWhy:
      'a VIDEO module, so it must boot into the video zone rather than a mixer channel column — '
      + 'without this field bootWithFace waits out the full 90 s test timeout for a column '
      + 'membership a video node never acquires. Both scenes also carry a live picture: the '
      + 'compact tile paints a VideoTileThumb through hasVideoSurface, and the dock body is the '
      + "module's own fullViewBody extension (the toon preview plus its SCREEN switch). The "
      + 'freeze write is a NO-OP on this def (it declares no `freeze` param) and deliberately so: '
      + 'the def states it is STATELESS PER FRAME — bilateral smooth, luma quantise and Sobel ink '
      + 'all run from the live input with no feedback — and there is no time uniform, ping-pong '
      + 'or RNG anywhere in it. With nothing patched into `in` the whole chain runs over black '
      + 'and the output is constant.',
  },
  // ── BATCH 22 · GROUP 3 — the screens ──────────────────────────────────────
  //
  // All four `pages: 1` (none declares `pages`), and all four BLIT LIVE VIDEO,
  // which is what makes the SCREEN switch load-bearing on this group rather
  // than ceremonial. ⚠ NONE of the four reads a clock — zero `uTime`,
  // `frame.time`, `ctx.time` or `performance.now()` between them — so every
  // scene here settles on its own and none needs a `freeze` param or a
  // `simPin`. That is checked, not assumed.
  {
    type: 'posterbox',
    pages: 1,
    videoFaceWhy:
      'a VIDEO module, so it must boot into the video zone rather than a mixer channel column — '
      + 'without this field bootWithFace waits out the full 90 s test timeout for a column '
      + 'membership a video node never acquires. Both scenes also carry a live picture: the '
      + 'compact tile paints a VideoTileThumb through hasVideoSurface, and the dock body is the '
      + "module's own fullViewBody extension (the quantised preview plus its SCREEN switch). The "
      + 'freeze write is a NO-OP on this def (it declares no `freeze` param) and deliberately so: '
      + 'the quantiser is a pure per-pixel function of (input, depth, dither, mix) with no clock, '
      + 'ping-pong or accumulator, and with nothing patched the output is solid black and stays '
      + 'black however many draws land.',
  },
  {
    type: 'picturebox',
    pages: 1,
    videoFaceWhy:
      'a VIDEO module, so it must boot into the video zone rather than a mixer channel column — '
      + 'without this field bootWithFace waits out the full 90 s test timeout for a column '
      + 'membership a video node never acquires. Both scenes carry a picture: the compact tile '
      + 'paints a VideoTileThumb through hasVideoSurface, and the dock body is the module\'s own '
      + "fullViewBody extension (the live output plus its SCREEN switch, the file pickers and the "
      + '7-slot bank). The freeze write is a NO-OP on this def (it declares no `freeze` param), '
      + 'and unlike its batch-mates that is not because the module is stateless — it DOES have a '
      + 'clock, in the animated-gif frame scheduler that `surface.draw` advances off `ctx.time`. '
      + 'The scene is deterministic anyway because that clock only runs on a slot holding an '
      + 'ANIMATED gif with more than one frame, and a freshly spawned picturebox holds no image '
      + 'at all: `hasActiveImage()` is false, the shader takes its idle branch and fills a '
      + 'constant dark teal (0.02, 0.06, 0.08), and `slotAnim` is seven nulls so the frame-index '
      + 'branch is never entered. A picture would have to be LOADED for anything here to move, '
      + 'and the scene loads none.',
  },
  {
    type: 'tiler',
    pages: 1,
    videoFaceWhy:
      'a VIDEO module, so it must boot into the video zone rather than a mixer channel column — '
      + 'without this field bootWithFace waits out the full 90 s test timeout for a column '
      + 'membership a video node never acquires. Both scenes also carry a live picture: the '
      + 'compact tile paints a VideoTileThumb through hasVideoSurface, and the dock body is the '
      + "module's own fullViewBody extension (the tiled preview plus its SCREEN switch). The "
      + 'freeze write is a NO-OP on this def (no `freeze` param): tiling is a pure re-sample of '
      + '(input, tile) with no clock and no accumulator, and unpatched it is solid black. ⚠ THE '
      + 'DEFAULT STEP IS THE 1:1 PASSTHROUGH (index 0), so the capture is the untiled frame — '
      + 'the grid only appears once the one control moves.',
  },
  {
    type: 'sourcery',
    pages: 1,
    videoFaceWhy:
      'a VIDEO module, so it must boot into the video zone rather than a mixer channel column — '
      + 'without this field bootWithFace waits out the full 90 s test timeout for a column '
      + 'membership a video node never acquires. Both scenes also carry a live picture: the '
      + 'compact tile paints a VideoTileThumb through hasVideoSurface, and the dock body is the '
      + "module's own fullViewBody extension (the keyed preview plus its SCREEN switch). The "
      + 'freeze write is a NO-OP on this def (no `freeze` param) and deliberately so: the picture '
      + 'is derived per frame from its two video inputs and the four params, with no time uniform '
      + 'and no accumulator. With neither A nor B patched the derivation runs over black and the '
      + 'result is constant.',
  },
  {
    type: 'onetonine',
    pages: 1,
    videoFaceWhy:
      'a VIDEO module, so it must boot into the video zone rather than a mixer channel column — '
      + 'without this field bootWithFace waits out the full 90 s test timeout for a column '
      + 'membership a video node never acquires. Both scenes also carry a live picture — and on '
      + 'THIS module the picture is the MONITOR, not the product: the dock body shows the 3x3 '
      + 'grid plus the 1..9 digits that say which cell feeds which of the nine crop outputs. The '
      + 'freeze write is a NO-OP on this def (no `freeze` param): the monitor is the input '
      + 'passthrough with a static overlay, and the overlay geometry is a pure function of the '
      + 'fixed 3x3 grid, so with nothing patched the capture is black plus a constant grid. ⚠ '
      + 'SHOWGRID DEFAULTS ON, so the overlay IS in the baseline — a capture that lost it would '
      + 'mean the toggle had flipped, not that the scene drifted.',
  },
  // ── BATCH 23a — the zero-attest pair ──────────────────────────────────────
  //
  // Both `pages: 1` (neither face declares `pages`). ⚠ UNLIKE EVERY BATCH-22
  // GROUP, NEITHER OF THESE IS STILL AT REST: both animate with nothing
  // patched, so both need a determinism seam and they need DIFFERENT ONES. That
  // is the whole reason to read these two entries together.
  {
    type: 'peakstate',
    pages: 1,
    videoFaceWhy:
      'a VIDEO module, so it must boot into the video zone rather than a mixer channel column — '
      + 'without this field bootWithFace waits out the full 90 s test timeout for a column '
      + 'membership a video node never acquires. Both scenes also carry a live picture: the '
      + 'compact tile paints a VideoTileThumb through hasVideoSurface, and the dock body is the '
      + "module's own fullViewBody extension (the mandala preview plus its SCREEN switch) — which "
      + 'on this module PRESERVES the 144x144 preview PeakstateCard.svelte already drew, rather '
      + 'than adding one. ⚠ IT ANIMATES AT REST AND A CLOCK PIN IS NOT ENOUGH: the picture is an '
      + 'accumulated PEN RING advanced by `advancePen` on every DRAW, so a frozen clock would '
      + 'still leave the frame dependent on how many draws landed first — the mirrorpool problem, '
      + 'not the inwards one. See the simPin below, which uses the module\'s own seam.',
    // ⚠ THE MODULE'S OWN SEED, NOT THE ENGINE CLOCK — and the distinction is
    // the one `inwards` and `mirrorpool` already draw between them in this
    // file. `__videoEngineFreezeTime` pins `frame.time`, which is sufficient
    // only when the render is a pure function of it. PEAKSTATE's is not: the
    // pen ring is HISTORY, and `advancePen` runs per draw. Pinning the clock
    // would leave the trail length a function of draw count.
    //
    // `__peakstateVrtSeed` is the seam the module ships for exactly this, and
    // it is not something this roster invented: the def implements it as
    // "resets the ring + t + rotation to fixed values, paints once at those
    // values, then BLOCKS further pen advance + rotation advance so the frame
    // is pixel-stable across runs", and its own comment records that it
    // "Mirrors the `__foxyVrtSeed` pattern" already used by a sibling entry
    // below.
    simPin: [
      {
        global: '__peakstateVrtSeed',
        value: 1,
        why:
          'seeds the pen ring at 120 fixed 1/60 s steps from t = 0, paints once, then blocks '
          + 'further advance — so the captured frame is a pure function of the params and is '
          + 'identical across boots, renderers and frame counts. Checked as truthy '
          + '(`!!globalThis.__peakstateVrtSeed`), so 1 is the value. ⚠ NOT sufficient via '
          + '`__videoEngineFreezeTime`: this module accumulates per DRAW, not per clock tick, so '
          + 'a pinned clock would still leave the trail length dependent on draw count.',
      },
    ],
  },
  {
    type: 'lines',
    pages: 1,
    videoFaceWhy:
      'a VIDEO module, so it must boot into the video zone rather than a mixer channel column — '
      + 'without this field bootWithFace waits out the full 90 s test timeout for a column '
      + 'membership a video node never acquires. Both scenes also carry a live picture: the '
      + 'compact tile paints a VideoTileThumb through hasVideoSurface, and the dock body is the '
      + "module's own fullViewBody extension (the grating preview plus its SCREEN switch) — a "
      + 'surface LinesCard.svelte never had. ⚠ IT ANIMATES AT REST, so this scene cannot settle '
      + 'on its own: the def\'s own prose says the pattern "auto-scrolls on its own (Phase '
      + 'advances steadily over time, time * 0.15 wrapped to 0..1) so it is visibly alive without '
      + 'touching a knob". The clock pin below is what stops it — and unlike its batch sibling '
      + '`peakstate`, a clock pin is SUFFICIENT here.',
    // ⚠ THE ENGINE CLOCK IS ENOUGH ON THIS ONE — the `inwards` case, not the
    // `peakstate` case sitting directly above. `lines` reads exactly one time
    // term (`const autoPhase = (frame.time * 0.15) % 1;`) and carries no
    // ping-pong, no accumulator, no history and no RNG, so pinning `frame.time`
    // makes the render a pure function of the four params. That is total
    // determinism rather than a partial settle, which is the distinction
    // `mirrorpool` records three globals to work around.
    //
    // ⚠ AND IT KEEPS THIS FACE ZERO-ATTEST, which is the batch's whole shape: a
    // `freeze` ParamDef would be a `params` change, and `params` is IN the
    // WebGL attest basis and IN contract-lock — paying a real-GPU re-attest to
    // solve a determinism problem the engine already solves for every video
    // module at once.
    simPin: [
      {
        global: '__videoEngineFreezeTime',
        value: 1.0,
        why:
          'pins `frame.time`, the ONLY time term this module reads — its auto-scroll is '
          + '`(frame.time * 0.15) % 1`, added on top of the Phase param. With it pinned the '
          + 'render is a pure function of (orient, amp, thickness, phase), so the scene is '
          + 'identical across boots, renderers and frame counts. Sufficient ALONE here, unlike on '
          + 'peakstate above, because LINES carries no accumulator for the clock pin to leave '
          + 'running.',
      },
    ],
  },
  // ── BATCH 22 · GROUP 4 — the video thin tail, the REMAINDER ───────────────
  //
  // All four are `pages: 1`: none of the four faces declares `pages`, so the
  // dock renders ONE unlabelled band on each. All thirteen params across the
  // four are declared `fader`, so every scene here is a fader face.
  //
  // ⚠ ALL FOUR ARE UNCONDITIONALLY BLACK WITH NOTHING PATCHED, which is a
  // stronger determinism argument than group 1's and worth stating once here
  // rather than four times below: each of the four fragment shaders opens with
  // an unpatched-input guard that writes `vec4(0,0,0,1)` (V-MIXER's is the same
  // thing spelled as a sum of four zeroed samplers). None declares a time
  // uniform, a ping-pong, an accumulator or an RNG. So no `simPin` and no
  // `freeze` param is needed on any of them — the freeze write the harness
  // performs is a NO-OP on all four defs, deliberately.
  {
    type: 'mapper',
    pages: 1,
    videoFaceWhy:
      'a VIDEO module, so it must boot into the video zone rather than a mixer channel column — '
      + 'without this field bootWithFace waits out the full 90 s test timeout for a column '
      + 'membership a video node never acquires. Both scenes also carry a live picture: the '
      + 'compact tile paints a VideoTileThumb through hasVideoSurface, and the dock body is the '
      + "module's own fullViewBody extension (the matte preview plus its SCREEN switch) — a "
      + 'surface MapperCard.svelte never had, so this scene is the FIRST pixel record of what '
      + 'this module looks like on a faceplate. Stateless per frame by the def\'s own header, and '
      + 'INTENTIONALLY a black hole when half-patched: with either VID or KEY missing the shader '
      + 'returns solid black before it samples anything, so an unpatched capture is black by '
      + 'construction and identical frame to frame.',
  },
  {
    type: 'destructor',
    pages: 1,
    videoFaceWhy:
      'a VIDEO module, so it must boot into the video zone rather than a mixer channel column — '
      + 'without this field bootWithFace waits out the full 90 s test timeout for a column '
      + 'membership a video node never acquires. Both scenes also carry a live picture: the '
      + 'compact tile paints a VideoTileThumb through hasVideoSurface, and the dock body is the '
      + "module's own fullViewBody extension (the mangled preview plus its SCREEN switch) — a "
      + 'surface DestructorCard.svelte never had. ⚠ ITS SCANLINE GRID IS NOT A CLOCK, which is '
      + 'the one thing that could make this scene look animated: `step(0.5, fract(vUv.y * 240.0))` '
      + 'is a function of the fragment coordinate alone, so the 240-band pattern is fixed in '
      + 'space rather than scrolling. With nothing patched into `in` the shader returns solid '
      + 'black before any of that runs.',
  },
  {
    type: 'luma',
    pages: 1,
    videoFaceWhy:
      'a VIDEO module, so it must boot into the video zone rather than a mixer channel column — '
      + 'without this field bootWithFace waits out the full 90 s test timeout for a column '
      + 'membership a video node never acquires. Both scenes also carry a live picture: the '
      + 'compact tile paints a VideoTileThumb through hasVideoSurface, and the dock body is the '
      + "module's own fullViewBody extension (the graded preview plus its SCREEN switch) — a "
      + 'surface LumaCard.svelte never had. ⚠ NOT `lumakey`, which is its own entry in this '
      + 'roster: that is the two-input COMPOSITOR, this is the single-input TONE PROCESSOR, and '
      + "luma.ts carries a header about earlier versions conflating the two. The transfer is a "
      + 'per-texel chain of gamma, contrast, '
      + 'posterize and bias re-applied as a luma ratio — no clock, no history — and at the '
      + 'shipped defaults it is a BIT-EXACT identity, so an unpatched capture is the '
      + 'unpatched-input branch\'s solid black either way.',
  },
  {
    type: 'videoMixer',
    pages: 1,
    videoFaceWhy:
      'a VIDEO module, so it must boot into the video zone rather than a mixer channel column — '
      + 'without this field bootWithFace waits out the full 90 s test timeout for a column '
      + 'membership a video node never acquires. Both scenes also carry a live picture: the '
      + 'compact tile paints a VideoTileThumb through hasVideoSurface, and the dock body is the '
      + "module's own fullViewBody extension (the composite preview plus its SCREEN switch) — a "
      + 'surface VideoMixerCard.svelte never had. ⚠ ITS UNPATCHED BLACK COMES FROM A SENTINEL, '
      + 'not from an early return: `sampleOrZero` contributes vec3(0) per unbound input, and the '
      + 'def\'s own comment records that binding its OWN output texture as the spare sampler was '
      + 'rejected because that is a GL feedback loop producing garbage. So with nothing patched '
      + 'the sum is exactly zero and the frame is black, deterministically — and it would NOT '
      + 'have been under the rejected design.',
  },
  {
    type: 'scoreboard',
    // ONE unlabelled band: the face declares no `pages`, because its single
    // ranked control (`color`) is not the module's identity — the counter is —
    // and a page would buy an ~81px header to write "colour" above a colour
    // wheel.
    pages: 1,
    videoFaceWhy:
      'a VIDEO module, so it must boot into the video zone rather than a mixer channel column — '
      + 'without this field bootWithFace waits out the full 90 s test timeout for a column '
      + 'membership a video node never acquires. Both scenes carry a live picture: the compact '
      + 'tile paints a VideoTileThumb through hasVideoSurface, and the dock body is the module\'s '
      + "own fullViewBody extension (the 4-digit display plus its SCREEN switch). "
      + '⚠ THE FREEZE WRITE IS A NO-OP ON THIS DEF (it declares no `freeze` param) AND NOTHING '
      + 'IS LOST BY THAT, which is the unusual part. The render is a PURE FUNCTION OF '
      + '(score, hue): `drawScoreboard` rasterizes digits into an OffscreenCanvas and the module '
      + 'only re-uploads when the score or the hue CHANGED. Verified at the read site — there is '
      + 'no `frame.time`, no dt, no `performance.now`, no `Math.random` and no accumulator '
      + 'anywhere in `scoreboard.ts` or `scoreboard-draw.ts`. The counter is the one piece of '
      + 'state, and it moves ONLY on a gate rising edge, so with nothing patched it cannot move '
      + 'at all. A still frame here needs no mechanism; it is the default behaviour. '
      + '⚠ AND THE SCENE IS SEEDED RATHER THAN LEFT AT ZERO — see simPin.',
    simPin: [
      {
        global: '__scoreboardVrtSeed',
        value: 1234,
        why:
          'Seeds the counter at construction so the captured digits are 1234 rather than 0000. '
          + 'NOT a determinism fix — the scene is already stable at 0000 (nothing patched means '
          + 'no gate edges, and the render has no time term). It is a COVERAGE fix: 0000 draws '
          + 'the same glyph four times, so a baseline of it would pin one digit shape and silently '
          + 'certify the other nine. 1234 lights a variety of segments, which is what makes the '
          + 'image evidence that the 7-segment rasterizer works rather than evidence that ONE '
          + 'digit does. '
          + '⚠ THE VALUE AND THE SEAM ARE BOTH REUSED, NOT INVENTED. `scoreboard.ts` has carried '
          + 'this exact hook since it shipped, and `vrt-exemptions.ts` already names 1234 as the '
          + 'intended capture value in its "baseline pending" note — this face is that follow-up '
          + 'arriving. One seed for the module\'s capture paths means a picture a human has '
          + 'already reasoned about, the same argument `outlines` makes for reusing its '
          + 'render-smoke seed. '
          + '⚠ AND IT WORKS ONLY BECAUSE THIS MODULE IS MAIN-THREAD — simPin installs a PAGE '
          + 'global via addInitScript, and `worker-eligibility.test.ts` excludes scoreboard from '
          + 'the worker precisely because "a worker realm has no `window`". That is the exact '
          + 'inverse of acidwarp, whose worker locus is what puts simPin out of reach and lands '
          + 'it in FACES_WITHOUT_SCENES.',
      },
    ],
  },
  // ── BATCH 23b — the attest half ───────────────────────────────────────────
  {
    type: 'shapes',
    pages: 1,
    videoFaceWhy:
      'a VIDEO module, so it must boot into the video zone rather than a mixer channel column — '
      + 'without this field bootWithFace waits out the full 90 s test timeout for a column '
      + 'membership a video node never acquires. Both scenes also carry a live picture: the '
      + 'compact tile paints a VideoTileThumb through hasVideoSurface, and the dock body is the '
      + "module's own fullViewBody extension (the stamp preview plus its SCREEN switch) — a "
      + 'surface ShapesCard.svelte never had. ⚠ AND IT NEEDS NO DETERMINISM SEAM AT ALL, unlike '
      + 'both of batch 23a: this is a pure per-pixel SDF evaluation of (shape, zoom, rotate, '
      + 'tile, tileN) with NO time uniform, no ping-pong, no accumulator and no RNG, so it is a '
      + 'SOURCE that is nonetheless perfectly still at rest. The freeze write the harness '
      + 'performs is a NO-OP on this def and deliberately so. At the shipped defaults the scene '
      + 'is one centred CIRCLE at zoom 1 on black — identical on every frame, every boot and '
      + 'every renderer.',
  },
  // ── CUT A · BATCH 2 ───────────────────────────────────────────────────────
  {
    type: 'shapedramps',
    pages: 2,
    videoFaceWhy:
      'a VIDEO module, so it must boot into the video zone rather than a mixer channel column — '
      + 'without this field bootWithFace waits out the full 90 s test timeout for a column '
      + 'membership a video node never acquires. Both scenes carry a live picture: the compact '
      + 'tile paints a VideoTileThumb through hasVideoSurface, and the dock body is the module\'s '
      + 'own fullViewBody extension — a surface ShapedrampsCard.svelte never had at all, since '
      + 'that card mounts ZERO canvases. ⚠ AND IT NEEDS NO DETERMINISM SEAM, for the same reason '
      + '`shapes` above needs none and unlike both of batch 23a: all three of this module\'s '
      + 'programs are pure per-pixel functions of vUv and the uniforms (LIN_FRAG_SRC, '
      + 'SHAPED_FRAG_SRC, MIX_FRAG_SRC) with NO time uniform, no ping-pong, no history texture '
      + 'and no RNG, so every frame is fully recomputed to the same pixels. It is a SOURCE that '
      + 'is nonetheless perfectly still at rest. ⚠ The dock preview shows `h_out` specifically — '
      + 'the engine aliases surface.texture to fboH_out.texture — so at the shipped defaults '
      + '(h_shape 0, h_phase 0, h_freq 1) the scene is a clean left-to-right linear luminance '
      + 'ramp, which is about as stable a target as this suite has.',
  },
  {
    type: 'dockscope',
    pages: 1,
    simPin: [
      {
        global: '__dockscopeVrtSeed',
        value: 1,
        why:
          'DOCKSCOPE paints a LIVE ANALYSER WINDOW — read(\'snapshot\') returns whatever 2048 '
          + 'samples the AnalyserNode happens to hold when the frame runs — so with nothing '
          + 'patched the trace is the input gain node\'s noise floor and with something patched '
          + 'it is a window whose phase depends on when the capture landed. Neither is stable '
          + 'across boots, and freezeFaceVideo cannot reach it: this is an AUDIO def, so there '
          + 'is no VideoEngine frame to freeze. The module already carries a deterministic seed '
          + 'for exactly this — a fixed 2048-sample 220 Hz sine at 48 kHz, mirroring ScopeCard\'s '
          + '__scopeVrtSeed — and the faceplate body reads the SAME global the card does, which '
          + 'is what lets the FACE be baselined and not only the card. Setting it makes the trace '
          + 'a pure function of the module\'s own constants plus TIME and SCALE.',
      },
    ],
  },
  {
    type: 'graphicEq',
    pages: 1,
    videoFaceWhy:
      'a VIDEO module, so it must boot into the video zone rather than a mixer channel column — '
      + 'without this field bootWithFace waits out the full 90 s test timeout for a column '
      + 'membership a video node never acquires. Both scenes also carry a live picture: the '
      + 'compact tile paints a VideoTileThumb through hasVideoSurface, and the dock body is the '
      + "module's own fullViewBody extension (the meters plus its SCREEN and MONITOR switches). "
      + '⚠ THIS ONE CANNOT USE THE ARGUMENT ITS NEIGHBOURS USE, and saying so is the point of '
      + 'this entry. shapes and batch-22 G3 are still because they hold NO STATE — no time '
      + 'uniform, no accumulator. GRAPHIC EQ HOLDS TWO: `peakL[]`/`peakR[]` are per-band '
      + 'peak-hold caps advanced once per draw by `decayPeak(prev, current, params.peak)`, and '
      + 'both AnalyserNodes carry `smoothingTimeConstant = 0.7`, which is itself an average over '
      + 'the frames actually read. A scene here is earned by a DIFFERENT property and it is '
      + 'MEASURED, not assumed: the animation is AUDIO-DRIVEN, and with nothing patched the '
      + 'analysers read silence, so every band folds to 0 and the caps decay from 0 to 0 — the '
      + 'accumulators exist but have nothing to accumulate. The capture is the dim meter grid. '
      + '⚠ THE EVIDENCE IS AN EXISTING TEST, NOT THIS PROSE: '
      + '`e2e/tests/graphic-eq-render-smoke.spec.ts` already drives two INDEPENDENT step bursts '
      + 'of a fixed frame count against this module and asserts the frames are bit-stable '
      + '(|delta mean| < 0.5, |delta variance| < 1.0). That is the same cross-boot property a '
      + 'baseline needs, proven before this scene existed. '
      + '⚠ AND THE FREEZE WRITE IS A NO-OP HERE (no `freeze` param) — which on THIS module is '
      + 'worth stating rather than glossing, because freezing would not have helped anyway: the '
      + 'thing that could move the picture is the AUDIO, and the harness stills that by leaving '
      + 'the AudioContext suspended with no source patched.',
  },
  // ── BATCH 24 — CUT A, batch 1: the four plain video faces ─────────────────
  //
  // ⚠ THE PENDING STATE IS NOW PAID, AND ONE OF THE FOUR NEEDED IT. These four
  // shipped with NO `sceneWeight` because the field's parts are required-if-
  // present and the durations only exist once a LINUX run has measured them.
  // Run 32631770069 measured them, and it also FAILED the vrt-strict headroom
  // gate at 87% of a 600 s Playwright budget (fail threshold 85%) — every test
  // passed; what ran out was room. The cause is in the numbers below.
  //
  // MEASURED on run 32631770069 (compact / dock, seconds):
  //     chroma      11.3 / 20.4
  //     chromakey   14.5 / 17.9
  //     feedback    15.2 / 21.4
  //     mandleblot  42.8 / 90.0     ← 4x and 9x its batch-mates
  //
  // ⚠ ONLY MANDLEBLOT DECLARES A WEIGHT, and that is arithmetic rather than
  // taste: `sceneBudgetMs` is `max(FACE_SCENE_BASE_MS, measured x FACE_SCENE_HEADROOM)`,
  // so for the other three (dock 17.9-21.4 s, doubled = 35.8-42.8 s) the base
  // 90 s bound already wins and a declaration would change nothing while implying
  // it did. Their measurements are recorded here instead, where they are evidence
  // rather than a no-op.
  //
  // ⚠ AND MANDLEBLOT'S 90.0 s IS NOT MERELY "THE BIGGEST" — it is EXACTLY the
  // base bound, which is the tell: the scene consumed its entire budget rather
  // than landing under it, so it was running AT the wire where the next slow
  // runner tips it into a timeout. That is precisely the "a budget sitting ON the
  // measurement is a coin flip" case `FACE_SCENE_HEADROOM` exists to prevent, and
  // it is why the weight is declared for it and not merely noted.
  {
    type: 'chroma',
    pages: 1,
    videoFaceWhy:
      'a VIDEO module, so it must boot into the video zone rather than a mixer channel column — '
      + 'without this field bootWithFace waits out the full test timeout for a column membership '
      + 'a video node never acquires. Both scenes carry a live picture: the compact tile paints a '
      + 'VideoTileThumb through hasVideoSurface, and the dock body is the module\'s own '
      + 'fullViewBody extension (the graded preview plus its SCREEN switch) — a surface '
      + 'ChromaCard.svelte never had. ⚠ DETERMINISTIC FOR A STATED REASON rather than by luck: '
      + 'CHROMA is a pure per-pixel function of its `in` texture and six params, with NO time '
      + 'uniform, no ping-pong and no accumulator, so the freeze the harness performs is a no-op '
      + 'on this def. In the scene nothing is patched into `in`, so the graded frame is the '
      + 'grade of an absent input on every frame and every renderer — the scene\'s value is the '
      + 'CONTROL layout, which is what the dock capture mostly frames anyway.',
  },
  {
    type: 'chromakey',
    pages: 1,
    videoFaceWhy:
      'a VIDEO module — same video-zone boot requirement as its three batch-mates. ⚠ NOT the '
      + '`chroma` entry directly above: that is the single-input COLOUR GRADE, this is the '
      + 'two-input COMPOSITOR, and chroma.ts carries a header about earlier versions conflating '
      + 'exactly these two. Deterministic for the same stated reason — a per-pixel key decision '
      + 'over `fg` and `bg` with no time uniform and no accumulator — and with BOTH video inputs '
      + 'unpatched in the scene the composite is the same frame on every renderer. The dock body '
      + 'is the module\'s own fullViewBody (the composite preview plus its SCREEN switch), a '
      + 'surface ChromakeyCard.svelte never had.',
  },
  {
    type: 'feedback',
    pages: 1,
    videoFaceWhy:
      'a VIDEO module — same video-zone boot requirement. ⚠ THE ONE ENTRY IN THIS BATCH WHOSE '
      + 'DETERMINISM IS AN ARGUMENT ABOUT AN ACCUMULATOR, so it is written out rather than '
      + 'shared. FEEDBACK re-samples its OWN previous output from a ping-pong framebuffer, so a '
      + 'clock pin alone would NOT be sufficient if the loop had anything in it — the ping-pong '
      + 'advances once per drawn frame regardless of the clock, which is the mirrorpool class. '
      + 'What makes it still here is the ARITHMETIC at rest: the FBOs start cleared, nothing is '
      + 'patched into `in`, and the recurrence is decay×(warped black) + (1-decay)×black, whose '
      + 'fixed point is black. So the accumulator is black on frame 1 and stays black — a '
      + 'deterministic picture, and deliberately a dark one. Unlike its batch-mates its card '
      + 'ALREADY drew this preview; what the face adds is the SCREEN switch it never had.',
  },
  {
    type: 'mandleblot',
    pages: 1,
    sceneWeight: measuredSceneWeight({
      compactMs: 42_800,
      dockMs: 90_000,
      measuredOn: 'ci.yml run 32631770069 (8 vrt-strict shards, ubuntu-latest)',
      why:
        'AN ESCAPE-TIME FRACTAL EVALUATED PER PIXEL, UNDER SWIFTSHADER — the one renderer in '
        + 'batch 24 whose cost is a property of the maths rather than of the frame size. Its '
        + 'shader runs an iteration loop per fragment, hard-capped at 500 and shipping at 150, '
        + 'so a full-resolution frame is up to 150 complex multiply-adds PER PIXEL with no early '
        + 'exit for interior points — and CI has no GPU, so every one of those runs on a software '
        + 'rasteriser. Its three batch-mates are single-pass per-pixel functions of a texture '
        + '(a hue rotate, a key decision, one warped feedback tap) and measured 17.9-21.4 s at '
        + 'the dock against this one\'s 90.0 s. '
        + '⚠ 90.0 s IS THE BASE BOUND ITSELF, not a number under it: the scene spent its whole '
        + 'budget, which is the "a bound sitting ON the measurement is a coin flip" state this '
        + 'field exists to correct. Doubling it via FACE_SCENE_HEADROOM is what turns a scene '
        + 'that happened to finish into one that has room to.',
    }),
    videoFaceWhy:
      'a VIDEO module — same video-zone boot requirement. ⚠ THE CLOCK PIN IS LOAD-BEARING HERE '
      + 'AND IS NOT A FORMALITY, which is what separates this entry from the other three. Its '
      + 'fragment shader takes a `uTime` uniform and folds `uTime * 0.1 * uColorCycle` into the '
      + 'hue, and `color_cycle` SHIPS AT 1 — so at the shipped defaults this renderer CYCLES ITS '
      + 'PALETTE CONTINUOUSLY at rest. `__videoEngineFreezeTime` is what pins `frame.time` and '
      + 'therefore what makes the capture still; without it this face would be the analogVco '
      + 'case and could not be baselined. ⚠ A clock pin is nonetheless SUFFICIENT: the module '
      + 'holds no accumulator at all — every frame is recomputed from (centre, zoom, iterations, '
      + 'rotation, colour, time) — so there is no ping-pong for a pinned clock to leave '
      + 'advancing. Its card already drew this fractal; the face adds the SCREEN switch, and '
      + 'drops the derived magnification readout the resting faceplate may not paint. '
      + '⚠ AND THIS PARAGRAPH DESCRIBED A PIN THAT WAS NOT INSTALLED. Every sentence above was '
      + 'written before the `simPin` below existed: the entry carried `videoFaceWhy` and NO '
      + '`simPin`, so `__videoEngineFreezeTime` was never set for this scene, '
      + '`engineFrozenTimeSec()` returned null, and the engine clock ran free through both '
      + 'captures. The declaration is what was missing, not the argument — see the pin.',
    // ⚠ THE PIN THE PROSE ABOVE ALREADY CLAIMED, AND THE REASON THE SCENE
    // SURVIVED FOR MONTHS WITHOUT IT IS WORSE THAN THE MISSING DECLARATION.
    //
    // `freezeFaceVideo` runs for every entry carrying `videoFaceWhy` and
    // REQUIRES the captured surface to be byte-identical across a second read.
    // That assertion has been passing on this scene — and it was not passing
    // because anything held the picture. It was passing because THE PICTURE
    // HOLDS NO DATA.
    //
    // MEASURED through the render-smoke harness (paused loop, engine clock
    // driven by hand, `color_out` read back via readPixels) at this module's
    // SHIPPED DEFAULTS — zoom 0.2 → ~15.8x, centre (-0.7, 0), iterations 150,
    // color_cycle 1 — at clock 2.0 s and again at 7.0 s, half a hue period
    // apart:
    //
    //     nonZeroFrac 0      variance 0      mean 0      at BOTH clocks
    //
    // The default view lies entirely inside the main cardioid, so every sampled
    // point is IN-SET, and `if (iter >= uIterations) col = vec3(0.0)` paints the
    // colour pass uniformly black. The committed baselines say the same thing
    // from the other end: `face-mandleblot-dock.png` carries a SOLID rgb(0,0,0)
    // rectangle 480x339 where the preview is, and the compact tile 31x23.
    //
    // ⚠ SO THE STILLNESS CHECK ON THIS SCENE IS STILL VACUOUS AFTER THIS PIN,
    // and saying so is the point of writing it here. The pin removes a live LIE
    // — the paragraph above claimed a mechanism nothing installed — and it makes
    // the scene deterministic BY CONSTRUCTION rather than by luck, which is what
    // the roster is for. It does not make the stillness assertion falsifiable,
    // because nothing can move a frame that has no data in it. The precondition
    // that assertion measures is the ABSENCE OF A PICTURE, and only changing
    // what MANDLEBLOT paints at rest can change that — a look change, and
    // therefore the owner's call rather than this PR's.
    //
    // ⚠ AND `simPin` RATHER THAN A `freeze` ParamDef, which is the same choice
    // the `inwards` entry argues out at length a few hundred lines up. MANDLEBLOT
    // is the stateless half of that split — no ping-pong, no accumulator, no RNG,
    // its draw reads `frame.time` and nothing else that moves — so pinning the
    // clock makes the picture a pure function of the params, which is TOTAL
    // determinism rather than the partial settle a freeze buys. A `freeze` param
    // would be strictly weaker (it holds whatever frame the harness happened to
    // catch) and strictly more expensive: `params` is in the WebGL attest basis
    // and in contract-lock, so it would cost a real-GPU re-attest and a contract
    // re-pin to solve a problem the engine already solves for every video module
    // at once.
    //
    // The positive control is `e2e/tests/mandleblot-render-smoke.spec.ts` — it
    // drives a view that DOES paint and shows the picture is a pure function of
    // this exact global.
    simPin: [
      {
        global: '__videoEngineFreezeTime',
        value: 1.0,
        why:
          'pins `frame.time`, the ONLY moving term this module reads — the hue is '
          + '`mod(mu*0.05 + uTime*0.1*uColorCycle + log(uZoom)*0.1*uColorCycle, 1)` and '
          + '`color_cycle` ships at 1, so at rest the palette cycles with a 10 s period and an '
          + 'unpinned scene would sample a different rotation on every boot. The module holds no '
          + 'accumulator, so this one value is the whole of its determinism: the frame becomes a '
          + 'pure function of the params. 1.0 rather than 0 to keep the drift terms exercised '
          + 'instead of landing on the degenerate t=0, matching the `inwards` entry this one '
          + 'follows.',
      },
    ],
  },
  // ── CAMERA — the first card-owned-source promotion ────────────────────────
  {
    type: 'cameraInput',
    pages: 1,
    videoFaceWhy:
      'a VIDEO module, so it must boot into the video zone rather than a mixer channel column — '
      + 'without this field bootWithFace waits out the full 90 s test timeout for a column '
      + 'membership a video node never acquires. ⚠ AND IT IS CAPTURABLE DESPITE OWNING A LIVE '
      + 'MediaStream, which is the interesting part — see the simPin below.',
    // ⚠ THE MODULE'S OWN INJECTED-FRAME SEAM, AND IT IS WHY THIS FACE GETS REAL
    // BASELINES RATHER THAN A `FACES_WITHOUT_SCENES` EXEMPTION.
    //
    // `cameraInput` sits in `EXEMPT_FROM_VRT` — "live MediaStream defeats
    // deterministic capture" — and that stays TRUE OF THE CARD SCENE, which is a
    // different surface with a different baseline (the same distinction the
    // `scoreboard` entry in vrt-exemptions.ts already draws). It is NOT true of
    // a scene captured with this pin set.
    //
    // `__camerainputTestFrame` makes the module upload a FIXED high-contrast
    // synthetic frame instead of sampling the live `<video>`: the def describes
    // it as "identical on every build → frame-stable", DOM-free, and with "NO
    // dependency on getUserMedia reaching 'streaming'". So the pinned scene has
    // no camera, no permission prompt and no stream clock in it at all.
    //
    // ⚠ AND IT IS A PAGE GLOBAL, WHICH IS WHY IT REACHES THIS MODULE AT ALL.
    // simPin installs globals with `addInitScript`; cameraInput is main-thread
    // (its source is a DOM `<video>`, so it can never be worker-eligible), so
    // the factory reads them at construction. That is the same property that
    // makes scoreboard pinnable and the exact inverse of acidwarp's worker
    // locus, which is what lands acidwarp in FACES_WITHOUT_SCENES.
    simPin: [
      {
        global: '__camerainputTestFrame',
        value: 1,
        why:
          "uploads the module's fixed synthetic checker instead of sampling the live <video>, so "
          + 'the captured frame is a pure function of the params and is identical across boots, '
          + 'renderers and frame counts. Read as truthy, so 1 is the value. ⚠ It removes the '
          + 'getUserMedia dependency entirely, which is the same reason the attest smoke uses it: '
          + 'CI has no camera, and without the pin the scene would be a permission hole rather '
          + 'than a picture.',
      },
    ],
  },
  {
    type: 'samsloop',
    // PLAY and SAMPLE — what you do with a sample you have, and how you get one.
    pages: 2,
    // ⚠ NO simPin, AND THAT IS DERIVED RATHER THAN OPTIMISTIC. This face's body
    // paints a canvas, which is normally the live-surface hazard (analogVco was
    // dropped from batch 3 for exactly this: 254 / 154 / 315 px across three
    // captures of the same tile). Three independent facts make this one
    // deterministic at capture time:
    //
    //   * a freshly spawned samsloop holds NO SAMPLE, so the body takes its
    //     empty branch and paints one fixed string — there is no PCM to fold
    //     and no waveform to draw;
    //   * the module is IDLE-BY-DEFAULT with no autoplay, so no voice is
    //     sounding, the worklet publishes `position: -1`, and the playhead is
    //     suppressed entirely rather than parked at a wall-clock-dependent
    //     spot;
    //   * the live RECORD branch — the one genuinely time-varying thing this
    //     surface can draw — is reachable only after a REC press, which no VRT
    //     scene performs.
    //
    // ⚠ So the determinism argument is about the CAPTURE STATE, not about the
    // draw being pure: load a sample and start it and this surface would be as
    // unstable as analogVco's. If a future scene ever spawns samsloop WITH a
    // sample, it needs a pin and this comment is wrong.
  },
  // ── CUT B ─────────────────────────────────────────────────────────────────
  {
    type: 'spectrograph',
    pages: 1,
    simPin: [
      {
        global: '__spectrographVrtFreeze',
        value: true,
        why:
          'SPECTROGRAPH paints a LIVE SCROLLING BUFFER driven by an AnalyserNode, and its own '
          + 'card scene records the measurement: the contents "never bit-stabilize across runs "'
          + '(the column count AND the buffered FFT both depend on wall-clock scheduling). '
          + '⚠ SUSPENDING THE AUDIO CONTEXT DOES NOT FIX IT, which is why this is a simPin and '
          + 'not `freezeAudio` — the scroll is driven by rAF against a 16 ms column gate, not by '
          + 'the audio clock, so a suspend stops the SIGNAL without choosing where the BUFFER '
          + 'stopped. Setting this flag makes the module fill its WHOLE 256-column buffer ONCE '
          + 'from a fixed synthetic three-peak spectrum and HOLD it, so the picture becomes a '
          + 'pure function of the module\'s own constants. '
          + '⚠ AND IT IS A `boolean`, NOT A SEED: the module reads it as `=== true` strictly, so '
          + 'writing 1 here would silently fail to freeze anything and the face would flake '
          + 'rather than fail — which is exactly why this field admits booleans. '
          + '⚠ NOTHING IS MIRRORED INTO THE FACE BODY for this to work: the flag is read INSIDE '
          + 'the module, so any caller of `drawFrame` inherits the freeze. That is the opposite '
          + 'of dockscope, whose seed lived in its card and had to be duplicated into the body.',
      },
    ],
  },
  {
    type: 'frametable',
    pages: 4,
    videoFaceWhy:
      'a VIDEO module, so it must boot into the video zone rather than a mixer channel column — '
      + 'without this field bootWithFace waits out the full test timeout for a column membership '
      + 'a video node never acquires. Both scenes carry a live picture: the compact tile paints a '
      + 'VideoTileThumb through hasVideoSurface, and the dock body is the module\'s own '
      + 'fullViewBody extension (the scanned preview plus its SCREEN switch) — a surface '
      + 'FrametableCard.svelte DID have, at 176x92, and which promotion would otherwise delete. '
      + '⚠ THE DETERMINISM ARGUMENT IS TWO INDEPENDENT LEGS, and it needs to be, because this is '
      + 'the one faced module whose subject is a SIXTY-LAYER ACCUMULATOR advanced once per draw '
      + '— the ping-pong class, one order worse. Neither leg is "it happens to look still". '
      + '(1) `freezeFaceVideo` REACHES THIS MODULE EXACTLY, and `freeze` here is a determinism '
      + 'seam in the ordinary sense rather than the acidwarp sense: `draw()` reads `frozen = '
      + 'params.freeze >= 0.5 || params.freezeGate >= 0.5` and SKIPS the whole capture-and-'
      + 'advance block, so the write stops `head` moving and stops any new frame entering the '
      + 'ring. It is also a real user control, which is fine — the two are not exclusive, and '
      + 'the FACES entry is the correct home precisely because the write DOES still pin the '
      + 'picture. (2) THE RING IS EMPTY IN THIS SCENE ANYWAY, which is the stronger leg. '
      + 'bootWithFace patches nothing into `video_in`, so `inputTex` is null on every draw, '
      + '`capturedAny` never flips true, and the SELECT shader takes its first branch — '
      + '`if (uHasContent < 0.5){ outColor = vec4(0,0,0,1); return; }`. The picture is BLACK by '
      + 'arithmetic on every frame and every renderer, not by luck. The two SHIMMER-driven CPU '
      + 'phase integrators are inert for the same reason a clock pin would be: `shimmer` ships '
      + 'at 0, so `phaseX`, `phaseY` and `morphDrift` all accumulate exactly zero. '
      + 'The scene\'s value is therefore the CONTROL layout — four bands, two XY pads, a '
      + 'segmented MODE roster and the two FILE cells — which is what the dock capture mostly '
      + 'frames anyway. '
      + '⚠ NOT TO BE CONFUSED WITH THE CARD ROSTER\'S VERDICT. `frametable` is in '
      + 'EXEMPT_FROM_VRT with "VRT baseline pending owner look-approval", but that is about the '
      + 'CARD scene, whose canvas shows a live scan of whatever is patched. These two scenes '
      + 'boot their own node with nothing patched, which is the `warrensvisions` / '
      + '`colourofmagic` position — the card baseline is masked or deferred and the face scenes '
      + 'need neither.',
  },
  {
    type: 'videocube',
    pages: 7,
    videoFaceWhy:
      'a VIDEO module, so it must boot into the video zone rather than a mixer channel column — '
      + 'without this field bootWithFace waits out the full test timeout for a column membership '
      + 'a video node never acquires. ⚠ THE ONLY TABBED FACE IN THIS ROSTER, so the dock scene is '
      + 'also the only one whose capture frames a RAIL plus ONE open band rather than a column of '
      + 'bands — which is worth stating because it means the usual "the fold hides the lower '
      + 'bands" caveat does not apply here in the same way: six of the seven pages are mounted '
      + 'but hidden, and the pixel gate sees exactly the open one. Band STRUCTURE is gated by the '
      + 'pure units and faceplate-platform, as always. '
      + 'THE DETERMINISM ARGUMENT, and it is stronger than its siblings\' rather than weaker '
      + 'despite this being the heaviest renderer of the pair. (1) THERE IS NO TIME TERM AT ALL — '
      + 'grepped, not assumed: `uTime`, `frame.time`, `frame.frame`, `timeDelta`, `Date.now` and '
      + '`performance.now` appear NOWHERE in videocube.ts. Every frame is recomputed from '
      + '(three rings, the params, the camera basis), so unlike `mandleblot` there is not even a '
      + 'clock to pin. (2) THE THREE RINGS ARE EMPTY IN THIS SCENE, which disposes of the '
      + 'accumulator. bootWithFace patches nothing into `video_a`/`video_b`/`video_c`, so no slot '
      + 'ever captures, `anyContent = captured.a || captured.b || captured.c` stays FALSE, and '
      + 'the combine shader is handed `uHasContent = 0`. The solid is empty by arithmetic on '
      + 'every renderer. (3) `freezeFaceVideo` REACHES IT ANYWAY, so the harness assertion is '
      + 'real rather than vacuous: `draw()` reads `frozen = params.freeze >= 0.5` and stops the '
      + 'live rings advancing. As on frametable this param is ALSO a shipped user control, which '
      + 'is fine — the two are not exclusive, and the FACES entry is correct precisely because '
      + 'the write still pins the picture. (4) THE WAVE CANVAS IS NOT A LOOSE END: the body\'s '
      + 'third surface traces `read(\'lastWave\')`, which is derived from the same empty field, '
      + 'and the harness suspends the audio graph before framing — so it is a flat baseline, like '
      + 'every other faced module\'s analyser tap. '
      + '⚠ NOT TO BE CONFUSED WITH THE CARD ROSTER\'S VERDICT. `videocube` is in EXEMPT_FROM_VRT '
      + 'with "VRT baseline pending owner look-approval", but that is about the CARD scene, whose '
      + 'canvas shows a live solid built from whatever is patched. These two scenes boot their '
      + 'own node with nothing patched — the `warrensvisions` / `colourofmagic` position, and the '
      + 'same one `frametable` takes directly above.',
  },
  // ── LUSH GARDEN (2026-08-23) ──────────────────────────────────────────────
  {
    type: 'lushgarden',
    pages: 2,
    videoFaceWhy:
      'a VIDEO module, so it must boot into the video zone rather than a mixer channel column — '
      + 'without this field bootWithFace waits out the full test timeout for a column membership '
      + 'a video node never acquires. Both scenes carry a live surface: the compact tile paints a '
      + 'VideoTileThumb through hasVideoSurface (a picture the placeholder tile never had), and '
      + 'the dock body is the module\'s own fullViewBody. ⚠ AND THE PICTURE IS A WALL-CLOCK '
      + 'ACCUMULATION, which is what makes the simPin below mandatory rather than tidy: plants '
      + 'spawn on a rate, each integrates a grow-in curve, and cutout bakes drain two per frame, '
      + 'so the frame differs on every frame AND every boot.',
    simPin: [
      {
        global: '__lushgardenVrtSeed',
        value: 0x5eed,
        why:
          'resets the scene, spawns a fixed 24 fully-grown plants from a seeded RNG, and sets '
          + 'vrtMode, which SUPPRESSES ALL FURTHER SPAWNING. That is strictly stronger than a '
          + 'phase pin: the surface becomes TIME-INVARIANT rather than merely frozen at an '
          + 'arbitrary moment. ⚠ The freeze write alone would NOT be sufficient here — it stops '
          + 'the picture but does not choose WHICH picture, the outlines failure mode that '
          + 'measured 6724 px against a 1500 px tolerance across two ubuntu boots. ⚠ And the pin '
          + 'REACHES this module only because it runs main-thread: simPin installs boot-time '
          + 'globals via addInitScript, so a worker renderLocus would put it out of reach (the '
          + 'acidwarp case). lushgarden declares no renderLocus. The value is the one the CARD '
          + 'scene already pins, so the layout is one a human has reviewed in the legacy '
          + 'baseline.',
      },
    ],
  },
  // ── PONG (2026-08-23) ─────────────────────────────────────────────────────
  {
    type: 'pong',
    pages: 1,
    videoFaceWhy:
      'an AUDIO module that nonetheless needs the video-zone treatment for its DOCK scene: the '
      + 'body paints a LIVE COURT on a 2D canvas, driven by the shared scheduler clock, so the '
      + 'dock capture is of a running game. ⚠ The COMPACT scene is the opposite and it is worth '
      + 'saying so — the tile is two faders plus a court GLYPH that is a PURE LAYOUT FUNCTION, '
      + 'so it is deterministic for free. The two scenes on this one module therefore have '
      + 'completely different determinism arguments. ⚠ AND THE COMPACT ARGUMENT WAS REWRITTEN '
      + '2026-08-23 RATHER THAN LEFT TO ROT: it used to read "hasVideoSurface is false and the '
      + 'tile is three static faders with NO PICTURE AT ALL". The conclusion (deterministic for '
      + 'free) survived the lane-glyph adopter, but its REASON did not — "there is nothing to '
      + 'draw" became "what is drawn cannot read the game". That distinction is the whole safety '
      + 'argument now, and it is mechanical rather than a promise: ShellExtensionGlyphProps is '
      + '{ num, numbers?, testid? } with NO nodeId, so the glyph component cannot resolve a '
      + 'graph node and cannot reach eng.read(node, "snapshot"). It renders pong\'s rest frame, '
      + 'identical on every boot. ⚠ If that prop contract ever gains a nodeId, THIS SCENE NEEDS '
      + 'THE DOCK SCENE\'S TREATMENT (the __pongVrtSeed pin below) and not this paragraph.',
    simPin: [
      {
        global: '__pongVrtSeed',
        value: 0x50ec,
        why:
          'pins the COURT, not only the serve — the whole game state becomes a function of '
          + '(seed, params) rather than of boot speed. ⚠ freeze alone is NOT sufficient here and '
          + 'that is measured, not assumed: it stops the picture but does not choose WHICH '
          + 'picture — the outlines case drifted 6724 px against a 1500 px tolerance across two '
          + 'ubuntu boots with freeze and no pin. ⚠⚠ AND THE SEED ALONE WAS NOT SUFFICIENT '
          + 'EITHER, which is what this entry USED to claim: booting this scene twice on ubuntu '
          + 'CI and diffing at threshold 1/255 measured 72 differing pixels at max channel delta '
          + '237 in a 23x9 box — the BALL. The seed fixed which trajectory and could not fix how '
          + 'far along it the capture landed, because the tick count before the harness suspend '
          + 'is a function of boot speed. The factory therefore steps the pure stepper a fixed 48 '
          + 'ticks at construction under this seed and then stops ticking entirely, so the court '
          + 'is TIME-INVARIANT rather than frozen at an arbitrary moment — lushgarden\'s shape, '
          + 'not a second freeze. ⚠ It REACHES this factory only because pong is main-thread: '
          + 'simPin installs boot-time globals via addInitScript, so a worker renderLocus would '
          + 'put it out of reach (the acidwarp case).',
      },
    ],
  },
  // ── SCOPE (2026-08-23) ────────────────────────────────────────────────────
  {
    type: 'scope',
    pages: 3,
    simPin: [
      {
        global: '__scopeVrtSeed',
        value: 1,
        why:
          'SCOPE\'s dock body paints a LIVE ANALYSER WINDOW — read(\'snapshot\') returns whatever '
          + '2048 samples the two AnalyserNodes happen to hold when the frame runs — so with '
          + 'nothing patched the traces are the input gains\' noise floor and with something '
          + 'patched they are windows whose phase depends on when the capture landed. Neither is '
          + 'stable across boots, and freezeFaceVideo cannot reach it: this is an AUDIO def, so '
          + 'there is no VideoEngine frame to freeze. ⚠ AND THE TWO-CHANNEL CASE IS STRICTLY '
          + 'WORSE THAN DOCKSCOPE\'S ONE-CHANNEL ONE, which is why this entry exists rather than '
          + 'being a copy: two live oscillators are NOT phase-locked to each other, so in XY mode '
          + 'the Lissajous figure\'s ORIENTATION drifts run-to-run even if each trace alone were '
          + 'stable. The module already carries a deterministic seed for exactly this — fixed '
          + 'phase-locked sines at 220/330 Hz with ch2Phase 0, at 48 kHz — and the faceplate body '
          + 'reads the SAME global the card does, which is what lets the FACE be baselined and '
          + 'not only the card. Reading a different global would leave this surface unbaselinable '
          + 'while the card stayed pinned, the trap dockscope records by name. ⚠ The COMPACT '
          + 'scene does not need it and that is worth stating: scope is domain audio, so '
          + 'hasVideoSurface is false and the lane tile is three static fader cells with NO '
          + 'picture at all — deterministic for free. The pin REACHES this module because scope '
          + 'is main-thread and declares no renderLocus (the acidwarp case is what it would '
          + 'otherwise hit), and it is read in the CARD and the BODY rather than in the factory, '
          + 'so construction timing does not matter.',
      },
    ],
  },
  // ── TIMELORDE (2026-08-23) ────────────────────────────────────────────────
  //
  // ⚠ NO `videoFaceWhy`, DELIBERATELY, AND IT IS THE OPPOSITE CALL FROM PONG'S
  // even though the two modules look alike (both audio defs whose dock body
  // paints a live 2D canvas). Two reasons, either one sufficient. First, that
  // field turns on `freezeFaceVideo`, which writes `params.freeze` — pong
  // DECLARES a freeze param and timelorde does not, so it would be writing to
  // nothing. Second, timelorde's picture is not produced by the video engine at
  // all: the body BLITS `video_out`'s own drawFrame, i.e. the frame
  // `TimelordeCard` composites in an off-screen `HeadlessSourceHost`, so there
  // is no video-engine surface to freeze.
  //
  // ⚠ THE DOCK SCENE'S DETERMINISM IS A DECODE, NOT A FREEZE, and it is
  // measured. Under `prefers-reduced-motion` the card paints EXACTLY ONE frame
  // and stops; `owlReady` used to flip in `onload`, which fires when the bytes
  // arrive rather than when the bitmap is rastered, so the single latched frame
  // was a function of boot speed. `vrt-live-surfaces.ts` recorded 13 of 20
  // SEPARATE PROCESSES failing the timelorde CARD scene for exactly that, which
  // is why the card carries a wrap mask — and this roster has no mask mechanism
  // at all, so the fix had to be at the source. The card now awaits
  // `img.decode()` before its first paint.
  //
  // ⚠ THE COMPACT SCENE HAS THE OPPOSITE ARGUMENT and is deterministic for free:
  // timelorde is domain audio with thirteen gate outs and one video out, so
  // `hasVideoSurface` is false, `primaryAudioOutPortId` is null, the face
  // declares `glyph: 'none'`, and the tile is three plain cells with no picture.
  {
    type: 'timelorde',
    pages: 4,
    singletonAdoptWhy:
      'THE FIRST FACED RACK SINGLETON, and the harness cannot spawn its subject. timelorde is '
      + 'maxInstances 1 AND is named in cap.ts\'s PINNED_COUNTS_TOWARD_CAP ("the pinned TIMELORDE '
      + 'is the rack\'s one clock"), so the always-on pinned instance every rack auto-spawns '
      + 'CONSUMES the cap and `__spawnFromPalette` is refused — measured as a 20 s timeout in '
      + 'spawnVideoZoneMember\'s arrival wait, with no second node ever appearing. And the pinned '
      + 'instance itself is canvas-hidden, so it has no lane tile to capture either. ⚠ SO THE '
      + 'SUBJECT IS ADOPTED RATHER THAN SPAWNED: the existing instance is un-pinned and moved '
      + 'into the lane-1 band, which is not a synthetic state — it is exactly what a rack IMPORTED '
      + 'from a saved patch has (workflow-pins\' presence:\'type\' rule means no pinned instance '
      + 'is spawned when a canvas one already exists), and it is the only state in which this '
      + 'face is reachable by a player at all.',
  },
  // ── LOOPBACK — the second card-owned-source promotion ─────────────────────
  {
    type: 'loopback',
    pages: 1,
    videoFaceWhy:
      'a VIDEO module, so it must boot into the video zone rather than a mixer channel column — '
      + 'without this field bootWithFace waits out the full 90 s test timeout for a column '
      + 'membership a video node never acquires. ⚠ AND IT IS CAPTURABLE DESPITE BEING A LIVE '
      + 'SCREEN-CAPTURE SOURCE, which is the interesting part — see the simPin below.',
    // ⚠ THE MODULE'S OWN INJECTED-FRAME SEAM, AND IT IS WHY THIS FACE GETS REAL
    // BASELINES RATHER THAN A `FACES_WITHOUT_SCENES` EXEMPTION.
    //
    // `loopback` sits in `EXEMPT_FROM_VRT` — "a live getDisplayMedia tab-capture
    // + recursive preview defeat deterministic capture" — and that stays TRUE OF
    // THE CARD SCENE, which is a different surface with a different baseline
    // (the same distinction the `cameraInput` and `scoreboard` entries draw). It
    // is NOT true of a scene captured with this pin set.
    //
    // ⚠ AND THIS PIN DOES STRICTLY MORE THAN CAMERA'S, which is the one place
    // the analogy under-sells it. `__camerainputTestFrame` replaces the UPLOAD.
    // `__loopbackTestFrame` replaces the upload AND the GEOMETRY: `effectiveCrop`
    // switches to a fixed sub-quadrant derived from the `crop` PARAM, with no
    // dependency on the card's per-frame `getBoundingClientRect` push into
    // `_cropU0.._cropV1`. That matters because the crop rect is a function of the
    // BROWSER WINDOW, so without the pin this face's picture would be a function
    // of the runner's viewport size — a per-machine baseline, which is the one
    // thing this suite cannot have. With it, the frame is a pure function of the
    // two params.
    //
    // ⚠ AND IT IS A PAGE GLOBAL, WHICH IS WHY IT REACHES THIS MODULE AT ALL.
    // simPin installs globals with `addInitScript`; loopback is main-thread (its
    // source is a DOM `<video>`, so it can never be worker-eligible), so the
    // factory reads them at construction. Same property that makes cameraInput
    // and scoreboard pinnable.
    simPin: [
      {
        global: '__loopbackTestFrame',
        value: 1,
        why:
          "uploads the module's fixed synthetic gradient+checker instead of sampling the live "
          + '<video>, AND derives the crop sub-rectangle from the `crop` param instead of from the '
          + "card's per-frame viewport measurement — so the captured frame is a pure function of "
          + 'the params and is identical across boots, renderers, frame counts AND runner window '
          + 'sizes. Read as truthy, so 1 is the value. ⚠ It removes the getDisplayMedia dependency '
          + 'entirely, which is not merely convenient: a display capture needs a real user gesture '
          + 'and a picker choice EVERY time, with no already-granted state, so without the pin '
          + 'this scene would be an un-answerable browser prompt rather than a picture.',
      },
    ],
  },
  // ── KRIA — the first faced SEQUENCER ──────────────────────────────────────
  {
    type: 'kria',
    pages: 3,
    // ⚠ DETERMINISTIC FOR FREE, AND FOR A REASON WORTH RECORDING: `running`
    // defaults to 0 (kria.ts), so a fresh spawn is STOPPED. The playhead — the
    // one live thing on this face, an engine read per frame — never starts, so
    // no freeze seam is needed and none is declared. `Math.random()` IS in this
    // module's emit path (the probability lane rolls per firing step), which
    // would be a flake source if the scene ever ran the sequencer; it does not,
    // and a behavioural test of that lane must assert a distribution rather
    // than a step.
    //
    // ⚠ WHAT THIS BASELINE DOES **NOT** COVER, stated because the build spec
    // asked for a seeded scene and this ships without one. A fresh kria has an
    // empty pattern, so the 7×16 grid is uniformly dark and the PNG is blind to
    // grid CONTENT — a lit cell in the wrong column would not move it. It is
    // NOT blind to the two failure modes that worried the spec: the selected
    // TRACK and the selected LANE both paint as highlighted buttons in the nav
    // row, inside the capture box, so a body rendering the wrong lane or the
    // wrong track reddens here.
    //
    // Seeding it would need either a module special-case inside this sweep
    // (which the sweep refuses by design — that generic property is what makes
    // every future face auto-enrol) or a product-side `__kriaTestPattern`
    // global, i.e. shipping code whose only reader is a picture. Neither is
    // worth it, because the content IS covered, and more precisely than a PNG
    // could: `kria-types.test.ts` asserts the row↔value bijection over EVERY
    // lane × EVERY row in both directions, and `kria-face-model.test.ts` pins
    // the lit-cell sets for the trig / note / octave states plus the
    // track-switch negative control.
  },
  // ── SCORE — the third faced SEQUENCER, and the only NOTATION one ──────────
  {
    type: 'score',
    // FIVE bands: score / marks / transport / envelope / slots. The staff is
    // `face.hero.cell`, so `heroFacePlan` promotes it out of the `score` band —
    // but that band still holds VALUE, ACC and KEY, so unlike cartesian's it
    // does NOT disappear. Count the POST-hero bands, not the declared pages;
    // here the two numbers happen to agree, and that is a coincidence worth
    // saying out loud rather than a rule.
    pages: 5,
    // ⚠ DETERMINISTIC FOR FREE, LIKE KRIA AND FOR THE SAME REASON: `isPlaying`
    // defaults to 0, so a fresh spawn is STOPPED. The one live thing on this
    // face is the sounding-note highlight, an engine read per frame through the
    // shared meter pump, and it never starts. There is no `Math.random()`
    // anywhere in score's emit path at all. No freeze seam is needed and none
    // is declared.
    //
    // ⚠ THE BRAVURA FONT IS ALREADY HANDLED, and this is the scene that most
    // depends on it. `_fonts.ts` says so in its own words: `document.fonts.ready`
    // "only tracks @font-face faces the document declares (just Bravura, for
    // SCORE)". The SMuFL face is the one self-hosted font the app ships, so the
    // clef, the time signature and every notehead are deterministic where the UI
    // stack's fallbacks were not. ⚠ It is declared globally, and this scene now
    // mounts the staff through a DIFFERENT component tree than the card
    // baseline does — same @font-face, new consumer.
    //
    // ⚠ WHAT THIS BASELINE DOES **NOT** COVER, stated rather than assumed. A
    // fresh score has `notes: []`, so the staff is four empty rows and the PNG
    // is blind to note CONTENT — a notehead drawn at the wrong x would not move
    // it. It is also nearly blind to the BANDS: `DockFullView` caps the pane at
    // `min(60vh, 680px)` and the staff panel alone is ~374 px before its page
    // nav, so most of the capture box is staff and the five section bands sit at
    // or below the fold. That is the same blindness that left sixstrum's, dx7's
    // and kickdrum's dock baselines pixel-identical through a complete band
    // re-grouping. ⚠ A GREEN DOCK SCENE IS THEREFORE NOT EVIDENCE THAT A BAND
    // CHANGE HERE IS A NO-OP — the band gate is `faceplate-platform.spec.ts`
    // plus the pure `dock-row-plan` / `module-face-lint` units, and the `pages`
    // number above, which fails BEFORE the pixel pin if a band is dropped.
    //
    // What it IS covered by instead: `score-face-model.test.ts` pins the ranked
    // order, the hero, the band membership, every cell's read/write pair and the
    // aria strings the removed numbers moved into; `score-face.spec.ts` drives
    // the selection model, the tie removal, the non-destructive page shrink and
    // the quicksave → queue_cv chain on the DEFAULT shell.
  },
  // ── CARTESIAN — the second faced SEQUENCER, and the TYPED one ─────────────
  {
    type: 'cartesian',
    // Two bands: `voice` and `lfo`. The pad grid is `face.hero.cell`, so
    // `heroFacePlan` promotes it out of its band and the band disappears —
    // count the POST-hero bands, not the declared pages.
    pages: 2,
    // ⚠ THE PLAYHEAD IS THE ONE LIVE THING HERE, and unlike kria's it is NOT
    // deterministic for free. kria's `running` defaults to 0, so its cursor
    // never starts; cartesian has no transport param at all — in FREEFORM (no
    // clock patched, which is a fresh spawn) the cursor follows the X/Y CV
    // inputs, and its `currentStep` is an engine read per frame through the
    // shared meter pump. `bootWithFace` suspends the AudioContext before
    // capture (`freezeFaceAudio`), which pins that read, so the highlighted pad
    // is stable — but the safety comes from the FREEZE, not from the module,
    // and a future scene that skipped it would see this move. That is the
    // analogVco class, one module over, and it is recorded here rather than
    // discovered from three differing captures.
    //
    // ⚠ WHAT THIS BASELINE DOES NOT COVER: pad CONTENT. A fresh cartesian seeds
    // every pad to C3 with its gate off, so all sixteen boxes read `c3` and the
    // PNG is blind to which pad holds which note — a note typed into the wrong
    // pad would not move it. That is covered more precisely than a picture
    // could, in `cartesian-face.spec.ts`: typed input lands in `cells[0]`, a
    // refused note leaves it untouched, and clearing it commits a REST.
  },
  {
    type: 'audioOut',
    // ONE param, no `face.pages` — so no labelled section bands, exactly like
    // `noise`. The dock scene is the meter body over a single fader.
    pages: 0,
    // ⚠ NO `videoFaceWhy`. This is `domain: 'audio'`, so the boot must be the
    // ordinary mixer-column spawn; setting it would move the subject into the
    // purple VIDEO ZONE, which is the wrong rack for it and would have been an
    // easy copy-paste from the neighbouring picture-bearing faces.
    //
    // ⚠ AND NO `singletonAdoptWhy`, MEASURED RATHER THAN COPIED FROM
    // `timelorde`. Both are terminal-ish rack fixtures with a pinned instance,
    // so the resemblance is real — but `audioOutDef` declares NO `maxInstances`
    // and is not in `cap.ts`'s `PINNED_COUNTS_TOWARD_CAP` (which is timelorde
    // alone), so `__spawnFromPalette` is NOT refused for it and the sweep gets a
    // fresh instance of its own. Checked before capturing, because adopting the
    // PINNED instance here would have photographed a node that is wired to the
    // seeded `mixmstrs master L/R` and therefore has a LIVE, moving meter.
    //
    // ── WHY THE PICTURE IS DETERMINISTIC, which a live meter has to earn ────
    //
    // The subject is a FRESHLY SPAWNED audioOut with nothing patched into `L`
    // or `R`. Its terminal taps read digital silence, so both bars sit at the
    // floor and the peak-hold ticks decay to it — the same frame every run,
    // with no freeze seam and nothing to pin. That is state 1 of the module's
    // own state matrix, it is what a fresh spawn genuinely is, and it is the
    // one state a scene can hold without a product-side test global.
    //
    // ⚠ THE IDLE STATE IS DRAWN, NOT BLANK, and that is load-bearing for this
    // baseline specifically: "found nothing" and "the body failed to mount"
    // must not be the same picture. The well, the three unlabelled ticks and
    // the ceiling mark paint whether or not the engine has booted, so a body
    // that never mounted takes a visibly different shot.
    //
    // ⚠ THE METER CANVAS IS NOT MASKED. Masking it would make the baseline
    // blind to the only thing this body adds. If the idle state ever stops
    // being deterministic, the BODY is wrong, not the baseline.
    //
    // ⚠ THE DEVICE PICKER'S OPTIONS ARE THE RUNNER'S OWN HARDWARE, which is the
    // one machine-dependent thing in frame — and it is why baselines are
    // authored by linux CI and a local macOS run is a smoke test rather than a
    // capture. Pre-permission the labels are empty and render as the positional
    // fallback (`Output #1`, since the direction fix), and a container with no
    // audio hardware enumerates nothing and shows the picker's named
    // `no-devices` disabled state. Both are stable run-to-run on the machine
    // that authors the file.
  },
  {
    type: 'audioIn',
    // ONE param, no `face.pages` — the same page-less shape as `audioOut` and
    // `noise`. The dock scene is the source-controls body over a single fader.
    pages: 0,
    // ⚠ NO `videoFaceWhy`. `domain: 'audio'`, so the boot must be the ordinary
    // mixer-column spawn; setting it would move the subject into the purple
    // VIDEO ZONE, which is the wrong rack and is the easy copy-paste from the
    // picture-bearing faces either side of it.
    //
    // ⚠ AND NO `singletonAdoptWhy`, CHECKED RATHER THAN COPIED. `audioInDef`
    // declares no `maxInstances` and is not in `cap.ts`'s
    // `PINNED_COUNTS_TOWARD_CAP` (timelorde alone), so `__spawnFromPalette` is
    // not refused and the sweep gets a fresh instance of its own rather than
    // adopting `pinned-audioIn`. That matters here: the pinned one lives in the
    // 🎧 tray and is the instance a returning user's grant would apply to.
    //
    // ── WHY THE PICTURE IS DETERMINISTIC, which a CAPTURE BINDER has to earn ─
    //
    // ⚠ EVERY SENTENCE BELOW IS READ OFF THE COMMITTED PNGs, NOT OFF THE CODE
    // PATH. The first draft of this entry described the state a local macOS run
    // lands in (`idle`, both lamps dark, positional device names) and asserted it
    // of a baseline that shows something else. Nothing in the tree gates a
    // comment, so nothing reddened — the repo's "TRUE-when-written, never
    // re-checked" failure class, in a file whose whole job is to be the durable
    // record. Re-derive from the picture, not from the reasoning, when this
    // changes.
    //
    // This module's legacy card is EXEMPT_FROM_VRT precisely because its state
    // "depends on getUserMedia permission + audioinput presence". The face is
    // not, and the difference is a PRODUCT guarantee rather than a test flag:
    //
    //   1. NOTHING IS EVER ACQUIRED IN A FRESH CONTEXT. Both face surfaces bind
    //      through `bindAudioInputSurface`, which takes its ONE unattended
    //      acquire only when `enumerateDevices()` reports LABELLED entries — the
    //      browser's own signal that this origin already holds a microphone
    //      grant. A Playwright context starts with none, so no `getUserMedia`
    //      call is made and no permission dialog can appear.
    //   2. WHAT THE BASELINE ACTUALLY SHOWS, on the linux runner that authors
    //      it: state `no-inputs-found`, because the container reports ZERO
    //      `audioinput` devices and `bindAudioInputSurface` sets that status and
    //      returns before it ever reaches the labels probe. So `LIVE` is dark,
    //      **`FAULT` is LIT (amber)**, the picker is DISABLED on its single
    //      `(no inputs)` option, the action button reads `ENABLE INPUT` and is
    //      DISABLED (an empty roster still refuses ENABLE — see
    //      `inputActionDisabled`), and the transient error line
    //      `No audio inputs detected.` IS painted. `StatusLed`'s caption is
    //      STATIC by contract, so neither lamp's TEXT can vary with state even
    //      in principle; the eight-state sentence lives on `aria-label`/`title`,
    //      which no capture sees.
    //   3. THE GLYPH IS SILENT. `face.glyph: 'meter'` binds live to
    //      `audio_l_out`, and with nothing attached that port carries only the
    //      factory's zero-offset `ConstantSourceNode` keep-alive. The face
    //      harness ALSO freezes analyser taps pre-frame (see analogVco above),
    //      so this is belt and braces rather than the only argument.
    //
    // ⚠ RESIDUAL RISK #1 — THE DETERMINISM IS THE RUNNER'S, NOT THE PRODUCT'S.
    // `no-inputs-found` is what a runner with NO audio hardware lands on. A
    // machine that HAS an `audioinput` and no prior grant lands on `idle`
    // instead: both lamps dark, the picker offering `(pick one)` plus the
    // browser's positional fallback (`Input #1`, from `formatDeviceLabel`), the
    // ENABLE button LIVE, and no error line — a different picture, 17 CSS px
    // shorter (MEASURED: local macOS render 276×386 against the linux baseline's
    // 276×403). That is the local smoke-test picture and it is NOT what is
    // committed. This is the same class `audioOut`'s entry above names about the
    // same picker, and the answer is the same: linux CI is the only baseline
    // author. If a runner image ever ships an audio input, this scene changes
    // picture wholesale rather than by a pixel.
    //
    // ⚠ RESIDUAL RISK #2 — NOTHING WAITS FOR THE STATUS. `no-inputs-found` only
    // exists after the ASYNC `refreshInputDevices()` inside
    // `bindAudioInputSurface` resolves (`audio-in-actions.ts`), and the scene
    // waits on neither the roster nor the state; the pre-resolution frame is
    // `idle` with FAULT DARK, which is a different picture again. What bounds it
    // is Playwright's own stabilisation: `toHaveScreenshot` re-captures until two
    // consecutive frames are byte-identical, so a mid-resolve frame is retried
    // rather than compared. That is a real guarantee on the COMPARE arm and a
    // weaker one on the `--update-snapshots=all` capture arm, so it is written
    // down rather than left to be re-discovered. A face-scene readiness hook
    // would close it properly; that is shared-harness machinery and an owner
    // call, not a fix to smuggle into a module PR.
    //
    // ⚠ THE COMPACT SCENE IS THE ONE THAT MOVED. Before promotion the lane tile
    // was a `ModuleShellPlaceholder`; it now carries the meter glyph, the fader
    // and the `tileBody`'s ONE row — the FAULT lamp (only that one; the tile
    // drops LIVE, music mode and the error prose), the picker, and ENABLE. That
    // gesture is the only route to a first grant, so it being IN the baseline is
    // the point rather than incidental. READ OFF THE COMMITTED 88×82 PNG: FAULT
    // lit, the picker legible on `(no inputs)`, ENABLE dimmed — the compact
    // picker needs no `min-width` floor because the 192 px lane tile is a
    // DEFINITE width and `flex-grow` already hands it the leftover row.
  },
  // THE 4-VOICE 3-D VIDEO SYNTH — the widest face in the fleet, and the one
  // whose promotion needed a precursor PR to be possible at all.
  //
  // `pages: 10`. Nine of them are ordinary bands; the tenth exists because a
  // control-family key is ONE cell for ALL of that family's instances, so the
  // twelve wavetable pickers could not be distributed into the four oscillator
  // bands the build spec drew them in and share a WAVETABLES band instead.
  // The four OSCILLATOR bands are what take the count over the rail threshold,
  // and they are argued on arithmetic (twelve params + a colour cell each)
  // rather than padded to get there.
  //
  // ⚠ NO `videoFaceWhy`. This is `domain: 'audio'` with a `mono-video` OUT, so
  // the boot must be the ordinary mixer-column spawn — setting it would move
  // the subject into the purple VIDEO ZONE, which is the wrong rack and is the
  // easy copy-paste from the picture-bearing faces either side of it.
  //
  // ── WHY THE PICTURE IS DETERMINISTIC ──────────────────────────────────────
  //
  // It is not, on its own: the renderer advances `uTime`, a per-osc wavetable
  // scroll and a per-osc bolt phase every frame, so two captures would frame
  // different moments of a moving scene. `__wavesculptVrtFreeze` is the seam
  // that settles it, and it is NOT a new one written for this roster — it has
  // shipped inside the renderer since the module did, and the two module-level
  // scenes (`vrt-wavesculpt-blink`, `vrt-wavesculpt-walls`) are captured
  // through it today. The extraction moved it into `WavesculptVizSurface`
  // WITHOUT changing what it pins, which those two scenes re-proved by passing
  // unchanged against their existing baselines after the move.
  {
    type: 'wavesculpt',
    pages: 10,
    simPin: [
      {
        global: '__wavesculptVrtFreeze',
        value: true,
        why:
          'pins the renderer\'s three animated clocks at once — shader `uTime` at a fixed 2.0 s, '
          + 'the per-oscillator wavetable scroll phase at 0, and the CRT field offset — so the '
          + 'scene becomes a pure function of the module\'s own params rather than of how many '
          + 'rAFs elapsed before the capture landed. It is the SAME flag the two module-level '
          + 'wavesculpt VRT scenes have always used, read inside the renderer itself rather than '
          + 'by any card, so this surface inherits the frozen picture without duplicating a global '
          + '— and without it the ribbons, the scope traces and the wall feedback would each be '
          + 'sampled at a different unrepeatable instant.',
      },
    ],
  },
  // ── TWOTRACKS — two tape decks, and the wave's tab-rail face ───────────────
  {
    type: 'twotracks',
    // A · TRANSPORT / TAPE / TONE, the same three for B, and MIX. Seven bands
    // reaches `DOCK_TAB_MIN_BANDS`, so this captures as a TABBED face from the
    // start and no existing baseline moves.
    pages: 7,
    // ⚠ DETERMINISTIC FOR FREE, AND THE ARGUMENT IS ABOUT THE CAPTURE STATE
    // RATHER THAN THE DRAW — samsloop's distinction, and it applies here twice
    // over because this body paints TWO live canvases.
    //
    // A freshly spawned twotracks has a BLANK TAPE on both reels: `bufLen` is 0
    // until something is recorded, the transport is `idle`, and the worklet only
    // emits playhead messages while a reel is rolling. So both canvases settle
    // immediately on their EMPTY state and stop changing — no sweep, no
    // flicker, nothing to freeze and no freeze seam declared. Recording is
    // reachable only through a REC press or a gate input, and this scene
    // performs neither.
    //
    // ⚠ SO THE EMPTY STATE IS THE THING BEING PHOTOGRAPHED, which is why the
    // body DRAWS it (the literal NO TAPE, plus both loop markers, which stay
    // grabbable on a blank reel) rather than leaving the canvas blank. A blank
    // canvas would make "no tape yet" and "the body failed to mount"
    // indistinguishable in the one artifact that could tell them apart.
    //
    // ⚠ AND THE EXISTING CARD MASK IS DELIBERATELY *NOT* CARRIED ONTO THIS
    // FACE. `vrt-exemptions.ts` masks both canvases in the CARD scene, and the
    // reason given there is that they are empty on a fresh spawn. That is an
    // argument for masking a canvas whose content is unknown, and it is exactly
    // backwards here: the empty tape is deterministic, it is drawn, and it is
    // the one thing this body adds to the plate. Masking it would leave the
    // baseline blind to the whole surface.
    //
    // ⚠ WHAT THIS BASELINE DOES **NOT** COVER, stated rather than implied: any
    // reel with audio ON it. The envelope, the out-of-loop wash and a moving
    // playhead are all unreachable from a fresh spawn, so the PNG says nothing
    // about them. They are covered where they can be asserted rather than
    // photographed — `twotracks-waveform-draw.test.ts` pins the geometry, the
    // marker/hit-test agreement and the tape-vs-no-tape branches against a
    // recording context double, and `twotracks.spec.ts` drives a real take.
  },
  // ── MATRIXMIX — the first META-DOMAIN scene in this roster ─────────────────
  {
    type: 'matrixMix',
    // ONE band: the two axis selector cells. No `face.pages`, so the dock
    // renders a single unlabelled section — nowhere near `DOCK_TAB_MIN_BANDS`,
    // and nothing here is padded to reach a rail.
    pages: 1,
    // ⚠ COMPACT REMOVED 2026-08-26 — see `faceTiers`. At the zeroed tolerance
    // it failed by 541 px on one run of `vrt-strict` and PASSED on a re-run of
    // the same shards at the same SHA; every other failing scene in that sweep
    // reproduced with a byte-identical pixel count. The two-boot determinism
    // probe reported it BIT-EXACT, which is that probe's stated blind spot made
    // concrete. The DOCK scene is unaffected and still gates.
    scenes: ['dock'],
    // ⚠ DETERMINISTIC, AND THE ARGUMENT IS THE ONE THE OLD VRT EXEMPTION MADE —
    // now pointed at the right subject. That exemption read "grid body is
    // patch-dependent — solo-spawn shows only the axis dropdowns + a
    // pick-a-module hint (no stable module-specific pixels)". The first half is
    // TRUE and stays true: the cross-point field is a function of two OTHER
    // modules plus the whole edge set, and a solo spawn has neither. The
    // conclusion is what the face falsifies. A solo-spawned matrixMix has NO
    // axis selected, so:
    //
    //   * the LANE TILE is two selector cells reading their placeholder option
    //     ('— pick a module —') under fixed `X` / `Y` tags on a stable plate —
    //     exactly the stable module-specific pixels the exemption said did not
    //     exist; and
    //   * the DOCK body is the empty-state hint, NOT the grid. The grid cannot
    //     paint at all without both axes, so the patch-dependent surface is
    //     structurally out of frame rather than merely quiet.
    //
    // The empty state is therefore the thing being photographed, and it is the
    // state a player actually meets first. It is also self-evidencing: if the
    // body failed to mount, `matrixmix-empty` would be absent and the structural
    // leg reddens before any pixel is compared.
    //
    // ⚠ AND THE ROSTER CANNOT LEAK INTO THE PICTURE. The axis cells' options are
    // derived from the live patch, so a scene that spawned a NEIGHBOUR would put
    // that neighbour's display name in a dropdown and make this baseline depend
    // on what else the harness happened to boot. It declares no `upstream`, and
    // the free-canvas branch spawns exactly one node — asserted, both that the
    // population grew by one and that the returned id IS this type.
  },

  // ── MIDICLOCK — the first BINDER baselined, and the exemption it discharges ─
  {
    type: 'midiclock',
    // ONE band: the division and the connect gesture. Two ranked cells is one
    // band and nothing is padded to make it more — `DOCK_TAB_MIN_BANDS` is 7.
    pages: 1,

    // ⚠ THIS SCENE IS WHY THE MODULE COULD LEAVE `ALLOWED_PERMANENT_EXEMPT`,
    // AND THE ARGUMENT IS THE EXEMPTION'S OWN. `vrt-exemptions.ts` said "card
    // content depends on connected MIDI device", and the sentence right above
    // it conceded the other half: *"pre-Connect state shows a 'Connect MIDI…'
    // button (deterministic) but post-connect the device list depends on
    // hardware that isn't present in CI."* Both halves are true, and only one
    // of them is in frame here.
    //
    // A freshly spawned midiclock has NO MIDI ACCESS: `requestMIDIAccess` is
    // never called until someone presses CONNECT, and this scene presses
    // nothing. So the device roster is not merely empty, it does not exist —
    // `snapshotState().devices` is built from `access.inputs` and `access` is
    // null — and the body renders its pre-connect branch: a CONNECT button, the
    // one-time-per-origin hint, and two DARK lamps. Every pixel is a function
    // of the code, none of it of the runner's hardware.
    //
    // ⚠ AND THE UNREACHABILITY IS STRUCTURAL, NOT INCIDENTAL. On a runner with
    // no MIDI devices and no prior grant, the connected state is not just
    // unlikely — there is no path to it without a click. That is what makes
    // this a discharge rather than a bet: the capture cannot drift into the
    // hardware-dependent state, because reaching that state requires a gesture
    // this suite does not perform.
    //
    // ⚠ WHAT THIS BASELINE DOES **NOT** COVER, stated rather than implied: the
    // POST-CONNECT device picker. A baseline over a mocked roster is reachable
    // — `e2e/tests/_per-port-drivers.ts` already mocks `requestMIDIAccess` and
    // pumps a deterministic clock stream, built for the per-port sweep — but it
    // would mean installing that mock in the VRT harness, which is a change to
    // the harness rather than to this module. Not this PR. The picker's
    // behaviour is asserted in `midiclock.spec.ts` and its strings in
    // `midiclock-status-model.test.ts`.
    //
    // ⚠ NO `videoFaceWhy` AND NO `simPin`. `domain: 'audio'` with four gate/cv
    // outputs and no canvas anywhere on the surface: there is no clock to pin
    // and nothing that advances between frames. The lamps change only when
    // `notify()` fires, and `notify()` fires only on a MIDI transport message.
  },
  // ── PTZ CAM — the SECOND binder baselined, on midiclock's argument with a
  //    SECOND independent reason it cannot drift ──────────────────────────────
  {
    type: 'ptzcam',
    // TWO bands: `camera` (the CONNECT cell) and `aim` (the four trim knobs).
    // Nothing is padded to reach a tab rail — `DOCK_TAB_MIN_BANDS` is 7.
    pages: 2,

    // ⚠ THE DETERMINISM ARGUMENT IS midiclock's, DOUBLED. A freshly spawned
    // ptzcam has no MIDI access — `requestMIDIAccess` is never called until
    // someone presses CONNECT, and this scene presses nothing (`midi.spec.ts`
    // pins "page load never requests Web-MIDI access", and `ptz-midi.ts`'s
    // header states it as a design constraint). So `listPtzOutputNames()`
    // returns `[]` NOT because the runner has no cameras but because `access`
    // is null and the function short-circuits on it. The picker renders exactly
    // one option — its own `— first camera —` literal — the binding is `idle`,
    // and the body paints its pre-connect hint with the LINK lamp dark.
    //
    // ⚠ AND THE SECOND REASON IS WHY THIS IS SAFER THAN midiclock's, not merely
    // as safe. Even a runner that HAD granted sysex MIDI would still show an
    // empty roster, because the roster is filtered to ports whose name begins
    // `PT-PTZ` — names published by a native helper process (tools/pt-ptz)
    // that exists on no CI machine. Two independent conditions, either of which
    // alone makes the capture deterministic, and reaching the hardware-dependent
    // state requires a gesture this suite does not perform.
    //
    // ⚠ THE AXIS LAMPS ARE STRUCTURALLY OUT OF FRAME, which is the half worth
    // stating because it is the surface's most interesting content. They render
    // only inside `{#if status.caps}`, and `caps` is populated exclusively by an
    // inbound sysex frame from a real camera. With no access there is no port,
    // with no port no handshake, with no handshake no caps — so the block cannot
    // paint here at all. Their strings are pinned in
    // `ptzcam-status-model.test.ts` and their wiring in
    // `ptzcam-face-model.test.ts`; the pixels are the owner's hardware to judge.
    //
    // ⚠ NO `videoFaceWhy` AND NO `simPin`. `domain: 'audio'`, `outputs: []`, no
    // canvas anywhere on the surface: there is no clock to pin and nothing that
    // advances between frames. The lamps change only when the binding layer
    // bumps `ptzMidiVersion`, which happens only on a MIDI access/port/handshake
    // event — none of which can occur without the press.
  },
  // ── SYNESTHESIA (2026-08-24) ──────────────────────────────────────────────
  {
    type: 'synesthesia',
    pages: 4,
    // ⚠ NO `simPin`, AND THAT IS A DERIVED ANSWER RATHER THAN AN OMISSION —
    // stated because the sibling entry three above (`scope`) DOES pin, on what
    // looks like the same seam.
    //
    // Scope's dock body paints `read('snapshot')` and its snapshot IS a live
    // 2048-sample ANALYSER WINDOW: whatever the AnalyserNode happened to hold
    // when the frame ran, whose phase depends on when the capture landed. That
    // is unstable across boots however quiet the graph is.
    //
    // SYNESTHESIA's `read('snapshot')` is NOT a window — it is
    // `{ levelsA, levelsB }`, two arrays of four SCALARS the worklet posts, and
    // `drawVuMeters` is a stateless pure function of them (no peak hold, no
    // decay, no clock; synesthesia-draw.ts). With nothing patched the worklet
    // has nothing to follow, so the levels are the `[0,0,0,0]` the factory
    // initialises and the wall paints forty UNLIT segments — the meter's own
    // idle state, identical on every boot BY CONSTRUCTION rather than by a
    // freeze. The face harness's audio suspend makes it doubly true (a
    // suspended worklet posts nothing at all), but the picture does not depend
    // on that.
    //
    // ⚠ THE MODULE'S EXISTING `__synesthesiaVrtFreeze` IS FOR A DIFFERENT
    // SURFACE and must not be reached for here. It swaps the per-band RASTER
    // output's live analyser buffer for a fixed synthetic waveform, which is
    // genuinely nondeterministic; the raster is a `mono-video` OUTPUT PORT and
    // appears nowhere on the faceplate. Setting it would change no pixel in
    // this scene while implying the scene needed it.
  },

  // ── GAMEPAD — the POLL-WITH-NO-GRANT device, and the third VRT drain ──────
  {
    type: 'gamepad',
    // ONE band: the segmented SLOT cell. The face declares no `face.pages`, so
    // the dock renders a single unlabelled section — a `slot` header over a cell
    // already captioned `Slot` would be the same word twice. Nowhere near
    // `DOCK_TAB_MIN_BANDS = 7`, and nothing is padded to reach a rail.
    pages: 1,

    // ⚠ THIS SCENE IS WHY THE MODULE COULD LEAVE `ALLOWED_PERMANENT_EXEMPT`,
    // AND THE ARGUMENT IS THE EXEMPTION'S OWN PREMISE POINTED AT THE RIGHT
    // SUBJECT. `vrt-exemptions.ts` said "card content driven by live
    // navigator.getGamepads() poll; defeats deterministic capture". THE POLL IS
    // LIVE; ITS OUTPUT ON THIS RUNNER IS NOT. With no controller attached
    // `navigator.getGamepads()` returns no populated pad, the factory's
    // `pollPad` takes its `if (!pad)` early return on every frame, and
    // `snapshot.connected` never becomes true — so the whole surface is a
    // function of the code: a dark PAD lamp with its instruction, both stick
    // dots pinned at pad centre (`dotX(0) = dotY(0) = 32`), both trigger fills
    // at zero width, all twelve LEDs unlit, no remap marks, both calibrate
    // buttons in their off state, a dark MAPPING lamp, and SLOT 0 selected.
    //
    // ⚠ AND THE UNREACHABILITY IS STRUCTURAL, NOT INCIDENTAL — the property that
    // makes this a discharge rather than a bet. The Gamepad API deliberately
    // hides a controller until the user PRESSES A BUTTON ON IT (an
    // anti-fingerprinting gate, this module's own header says so), and there is
    // no in-page gesture that substitutes for one. The capture cannot drift into
    // the hardware-dependent state, because reaching it requires hardware this
    // runner does not have and an action this suite cannot perform. Substitute
    // "no controller and no button press" into `midiclock`'s discharge paragraph
    // below and it reads unchanged.
    //
    // ⚠ WHAT THIS BASELINE DOES **NOT** COVER, stated rather than implied: the
    // CONNECTED surface — every dot position, every lit LED, every remap mark,
    // and the calibration sweep box. `e2e/tests/gamepad.spec.ts` already
    // monkey-patches `navigator.getGamepads()` with a deterministic fake, so a
    // mocked baseline is REACHABLE; installing that mock in the VRT harness is a
    // change to the harness rather than to this module. Not this PR — exactly
    // the boundary `midiclock` drew for its post-connect picker. Behaviour is
    // covered by `gamepad.spec.ts` and by `gamepad-face-model.test.ts`.
    //
    // ⚠ NO `videoFaceWhy` AND NO `simPin`. `domain: 'audio'` with eighteen cv /
    // gate outputs and NO canvas anywhere on the surface — the stick pads and
    // trigger bars are `<svg>`, whose geometry is a pure function of a snapshot
    // that never changes here. There is no clock to pin and nothing that
    // advances between frames.
  },

  // ── ELECTRA CONTROL — the FOURTH META scene, and the only faced module whose
  //    always-on instance lives in the workflow DRAWER ────────────────────────
  {
    type: 'electraControl',
    // ONE band: the single SEND TO ELECTRA action cell. `params: []`, so there
    // is nothing else that could rank — the thirty-six proxies are a body, for
    // the addressability reason the def's face comment gives. `DOCK_TAB_MIN_BANDS`
    // is 7 and nothing is padded toward it.
    pages: 1,

    // ⚠ THE CAPTURE STATE IS DETERMINISTIC BY CONSTRUCTION, and this is the
    // strongest such argument in the roster — which is the same fact as its
    // weakest coverage story, so both are stated.
    //
    // A freshly spawned electraControl has ZERO slots filled (asserted directly
    // at `e2e/tests/electra-control.spec.ts`, which reads `data.slots` on a new
    // node). The body ENUMERATES all thirty-six cells from `(row, knob)` and
    // never from the data, so the empty board is not a blank region that happens
    // to be quiet — it is the full 6×6 grid of dashed placeholder dials, three
    // bank labels, and nothing else. There is no canvas, no clock, no animation
    // and no engine node: `domain: 'meta'` with `inputs: []` and `outputs: []`.
    // The patch-dependent surface — proxied knobs, live source colours, custom
    // names — is structurally OUT OF FRAME rather than merely still, because it
    // cannot paint at all without a binding, and a solo spawn has none.
    //
    // ⚠ WHAT THIS BASELINE DOES **NOT** COVER, stated rather than implied: the
    // FILLED board. Every proxied knob, every colour stripe, every custom name
    // and the rename field are invisible to it — which is most of the module's
    // subject. A mocked baseline is reachable (the e2e already builds a filled
    // board through the real assign path), but installing that in the VRT
    // harness is a change to the harness rather than to this module, and it is
    // the boundary `gamepad` and `midiclock` both drew. The filled surface is
    // covered by `e2e/tests/electra-control.spec.ts` (the card, verbatim, under
    // `?shell=legacy`), by `e2e/tests/workflow-drawer-face.spec.ts` (this body,
    // in the pinned `e` tray, on the DEFAULT shell) and by
    // `electracontrol-face-model.test.ts`.
    //
    // ⚠ NO `videoFaceWhy` AND NO `simPin`. `domain: 'meta'` — no ports, no
    // canvas, no engine node — so `hasVideoSurface` is false and the AUDIO boot
    // path is the right one (matrixMix, launchpadControlLeft and push2Control all
    // take it too). There is no clock to pin and nothing that advances between
    // frames.
    //
    // ⚠ AND NO `singletonAdoptWhy`, WHICH LOOKS WRONG UNTIL IT IS CHECKED. This
    // module is `maxInstances: 1` AND its pinned instance is canvas-hidden —
    // exactly `timelorde`'s shape, the one module that needs that field. The
    // difference is `PINNED_COUNTS_TOWARD_CAP` (`graph/cap.ts`), which is derived
    // as `WORKFLOW_PINNED_SURFACES.filter(presence === 'type')` — timelorde only.
    // electraControl is in `WORKFLOW_PINNED_MODULES`, so its pin does NOT consume
    // the cap ("additional instances spawn as normal canvas cards",
    // workflow-pins.ts), `__spawnFromPalette` is not refused, and the ordinary
    // boot path applies.
  },

  // ── CONTROL SURFACE — the FIFTH meta scene, electraControl's DYNAMIC
  //    sibling, and the first face whose promotion is an owner-approved
  //    LANE-TIER change (the free-growing card becomes a 192×180 tile) ───────
  {
    type: 'controlSurface',
    // ONE band: the single LOCK toggle cell. `params: []`, so nothing else
    // could rank — the proxied knobs are a body, for the addressability reason
    // electraControl's entry gives. `DOCK_TAB_MIN_BANDS` is 7 and nothing is
    // padded toward it.
    pages: 1,

    // ⚠ THE CAPTURE STATE IS DETERMINISTIC BY CONSTRUCTION — the electraControl
    // argument, and here it is even shorter: a freshly spawned controlSurface
    // has ZERO bindings, and unlike the fixed 6×6 board this module's grid is
    // enumerated FROM the data, so the empty state is not a grid of
    // placeholders — it is the LOCK cell, the tile's empty-state instruction
    // (the module's only discovery path) and, in the dock, the board's
    // empty-state prompt. There is no canvas, no clock, no animation and no
    // engine node: `domain: 'meta'` with `inputs: []` and `outputs: []`. The
    // patch-dependent surface — group boxes, proxied knobs, live source
    // colours, the tile's colour strip — is structurally OUT OF FRAME rather
    // than merely still, because it cannot paint without a binding and a solo
    // spawn has none.
    //
    // ⚠ WHAT THIS BASELINE DOES **NOT** COVER, stated rather than implied: the
    // BOUND board — every group box, proxied knob, colour stripe, rename field
    // and the tile strip. A mocked baseline is reachable (the e2e builds a
    // bound board through the real Send-to path), but installing that in the
    // VRT harness is a harness change, the boundary gamepad / midiclock /
    // electraControl all drew. The bound surface is covered by
    // `e2e/tests/control-surface.spec.ts` (the card, verbatim, under
    // `?shell=legacy`), by `e2e/tests/controlsurface-face.spec.ts` (the board
    // body and tile, on the DEFAULT shell) and by
    // `controlsurface-face-model.test.ts`.
    //
    // ⚠ NO `videoFaceWhy` AND NO `simPin`. `domain: 'meta'` — no ports, no
    // canvas, no engine node — so `hasVideoSurface` is false and the AUDIO
    // boot path is the right one (matrixMix, electraControl and push2Control
    // all take it too). There is no clock to pin and nothing that advances
    // between frames.
  },

  // ── LAUNCHPAD CONTROL — the second BINDER, and the second META scene ───────
  {
    type: 'launchpadControlLeft',
    // ONE band: the two handshake cells. `params: []`, so there is nothing else
    // that could rank; `DOCK_TAB_MIN_BANDS` is 7 and nothing is padded toward
    // it.
    pages: 1,

    // ⚠ THIS SCENE IS WHY THE MODULE COULD LEAVE `ALLOWED_PERMANENT_EXEMPT`,
    // and — like midiclock's — the argument is the exemption's own, pointed at
    // the state the capture can actually reach.
    //
    // The exemption said the body is "device/binding-dependent (Pair/Bind state
    // + status absent in CI)". Every clause of that is true of the CONNECTED
    // state and none of it is reachable here:
    //
    //   * `connect()` has exactly two callers, `startPairing` and
    //     `startSingle`, and this suite presses nothing — so `isPairBound()`
    //     and `isSingleBound()` are both false and cannot become true;
    //   * `restoreLaunchpadDeployment()` reads `localStorage`, which is empty
    //     in a fresh Playwright context, so the deployment and the single-unit
    //     role take their defaults;
    //   * a solo spawn has no clipplayer, so `launchpadBindVisible` is false
    //     and the BIND control does not render;
    //   * `launchpadViewSegVisible` needs a bound SINGLE unit, so the four-role
    //     segment does not render either.
    //
    // What IS in frame: the module name, two ranked action buttons, two DARK
    // lamps, and — on the compact tile — nothing else. Every pixel is a
    // function of the code.
    //
    // ⚠ AND THE UNREACHABILITY IS STRUCTURAL. Reaching the hardware-dependent
    // state requires a gesture, and there is no gesture. That is what makes
    // this a discharge rather than a bet.
    //
    // ⚠ THE ONE GENUINE VARIABLE, stated rather than buried: `midiAvailable()`
    // (`typeof navigator.requestMIDIAccess === 'function'`) picks between the
    // body's two top-level branches. It is a property of the browser BUILD, not
    // of attached hardware, and the baseline is authored by ONE linux CI runner
    // — `snapshotPathTemplate` has no `{platform}` segment — so it is a
    // constant where it gates. A local darwin run that disagreed would not be a
    // verification either way, which is the standing rule rather than special
    // pleading here.
    //
    // ⚠ WHAT THIS BASELINE DOES **NOT** COVER: the bound states — the BIND
    // control, the four-role segment, the lit lamps and the `one-unit` /
    // `no-device` errors. Reaching them needs a simulated Launchpad, and the
    // harness for that exists (`__launchpadTestInstallSingle`, installed by
    // Canvas.svelte) but installing it in the VRT rig is a change to the
    // HARNESS rather than to this module. Those surfaces are asserted where
    // they can be asserted instead of photographed:
    // `launchpad-binder-status-model.test.ts` pins every string the body can
    // produce (including the ones that are never painted), and
    // `launchpad-face.spec.ts` drives the real segment through the singleton.
    //
    // ⚠ NO `videoFaceWhy` AND NO `simPin`. `domain: 'meta'` — no ports, no
    // canvas, no engine node. Nothing on this surface advances between frames:
    // the lamps change only when the device layer bumps a version rune, and
    // nothing bumps one without a gesture.
  },

  // ── MOOG960 — the first GRID face ────────────────────────────────────────
  {
    type: 'moog960',
    // SIX bands: clock · row range · row 1 · row 2 · row 3 · step mode. One
    // under `DOCK_TAB_MIN_BANDS = 7` on purpose — the three row banks are one
    // idea three times and a player reads them together, so a rail would hide
    // two thirds of the sequence. Nothing is padded to reach the rail.
    pages: 6,

    // ⚠ THE MODULE RUNS, AND THE FACE STILL DOES NOT MOVE — which is the only
    // thing that makes this scene baselineable, so it is stated rather than
    // assumed. moog960 AUTO-RUNS on placement (its own docs say so), and a
    // column pointer really is sweeping while the shot is taken. But every cell
    // on this faceplate is a PARAM — 24 step pots, 3 RANGE switches, 8 MODE
    // switches and RATE — and a running pointer changes none of them. What
    // advances is the OUTPUT (three row CVs and a clock pulse), and no output
    // is painted here: the face declares `glyph: 'none'` (this def has no
    // primary audio output, so every glyph would resolve to `{kind:'static'}`),
    // it has no hero cell, and it has no panel. There is no surface for the
    // motion to reach.
    //
    // ⚠ NO `simPin` AND NO `videoFaceWhy`, and the absence is derived rather
    // than inherited: `domain: 'audio'`, outputs are `cv` + `gate` only, and
    // there is no canvas anywhere on the plate. There is no clock to pin
    // because nothing on the plate reads one.
    //
    // The module is already in `STRICT_VRT_MODULES` — its legacy CARD has held
    // committed linux baselines since #953 on the same determinism argument —
    // so this scene extends an existing claim to the faceplate rather than
    // making a new one.
  },
  // ── VFPGA-RUNNER — the reconfigurable HOST, and the roster's only face whose
  //    picture is a different PROGRAM depending on `node.data` ────────────────
  {
    type: 'vfpgaRunner',
    // THREE bands: `program` (the bitstream picker), `slots` (the eight generic
    // param knobs), `modulation` (the CV conditioning rack). No hero, so no band
    // is emptied and the declared count IS the rendered count. Three is well
    // under DOCK_TAB_MIN_BANDS and nothing is padded to reach it.
    pages: 3,

    videoFaceWhy:
      'the dock faceplate carries this host\'s LIVE OUTPUT via hasVideoSurface plus the '
      + 'extension body\'s own preview canvas, so the scene must take the VIDEO boot path — an '
      + 'audio-path boot would wait out the full 90 s test timeout for a mixer-column membership '
      + 'a video node never joins. '
      + '⚠ AND THE FREEZE THE FLAG ALSO ENGAGES IS A NO-OP HERE, WHICH IS THE HONEST STATE '
      + 'RATHER THAN A GAP: this def declares no `freeze` param, so `freezeFaceVideo` writes a '
      + 'key nothing reads — and its assertion still passes, because the picture is ALREADY '
      + 'still. The bitstream loaded on a fresh spawn is `smpte-bars` (DEFAULT_VFPGA_ID), whose '
      + 'own spec header states the property this scene depends on: "Pure GL, deterministic (no '
      + 'uTime in the colour math - the only time-varying input is the CV), so its CPU-snapshot '
      + 'preview + a frozen-CV VRT scene are pixel-stable." With nothing patched the CV is 0, so '
      + 'every frame is the same 75% colour-bar field. '
      + '⚠ THE MODULATION RACK\'S TRACE CANVASES ARE STILL CANVASES AND freezeFaceVideo SAMPLES '
      + 'THEM TOO. They are stable for a structural reason rather than a lucky one: with no cable '
      + 'patched the post-scale/offset value is a constant 0, and `drawToyboxInputScope` draws a '
      + 'ring of N equal samples as a flat line from x=0 to x=w-1 with a fill under it — the SAME '
      + 'path for every ring length from 2 upward, so the picture does not depend on how many '
      + 'frames elapsed before the capture. MEASURED per-canvas (4 rounds x 6 rAFs, '
      + 'E2E_SWIFTSHADER=1): `vfpga-face-canvas` distinct=1, `vfpga-trace-1` distinct=1 — every '
      + 'surface this scene photographs is byte-identical across rounds. (That measurement is '
      + 'also what found the INSTRUMENT bug this branch fixed: the only mover on the page was '
      + '`pinned-timelorde`, which is rack furniture and not in the capture. See freezeFaceVideo.) '
      + '⚠ AND THE FABRIC FLOORPLAN IS NOT IN FRAME: `showFabric` is component state defaulting '
      + 'to false, so the body mounts the preview canvas and the floorplan canvas does not exist.',
  },

  // ── PUSH 2 CONTROL — the THIRD META scene, and the roster's only picture
  //    that is a REPLICA of a physical object rather than a render ───────────
  {
    type: 'push2Control',
    // ONE band: the single CONNECT action cell. `params: []`, so there is
    // nothing else that could rank; `DOCK_TAB_MIN_BANDS` is 7 and nothing is
    // padded toward it.
    pages: 1,

    // ⚠ THIS SCENE IS WHY THE MODULE COULD LEAVE `ALLOWED_PERMANENT_EXEMPT`,
    // and unlike the four binders drained before it, ONE of its three stated
    // grounds was genuinely still true — so the discharge is in two parts.
    //
    // PART ONE, the two grounds that were about the ENVIRONMENT rather than the
    // feature ("Connect/Bind state absent in CI", "view segment absent in CI").
    // Both describe the ONLY state the capture can reach, which makes them the
    // baseline rather than the obstacle:
    //
    //   * `connectPush()` is reached from exactly one affordance and this suite
    //     presses nothing, so `isConnected()` is false and cannot become true;
    //   * the view segment and the BIND control are both gated on `connected`,
    //     so neither renders;
    //   * `selectedChannelIndex()` and the per-lane focus memory both read
    //     `localStorage`, which is empty in a fresh Playwright context, so the
    //     lane and the focus take their defaults;
    //   * `usbAvailable()` is read ONCE at body construction, so CONNECT
    //     DISPLAY is present or absent for the whole capture rather than
    //     flickering.
    //
    // The unreachability is STRUCTURAL: reaching the device-dependent state
    // requires a gesture, and there is no gesture.
    //
    // PART TWO, and this is the ground the other binders did not have. The
    // exemption also said "the push-card preview canvas renders whatever module
    // happens to be in lane 1, so the card face is patch-dependent". ⚠ THAT IS
    // TRUE, AND IT IS A PROPERTY OF THE FEATURE — no argument about CI can
    // discharge it. It is defeated by SCENE CONSTRUCTION instead, which is
    // matrixMix's route one door over: the thing that varies is the PATCH, and
    // a VRT scene controls the patch.
    //
    // This scene declares no `upstream`, so `bootWithFace` spawns exactly ONE
    // node — and then WAITS for `pinned-mixmstrs.data.columns['1'].length === 1`
    // before it proceeds. So lane 1 resolves to push2Control ITSELF, whose def
    // declares `params: []`, and `currentPushCardView()` returns its
    // deterministic `empty: 'no-controls'` card. ⚠ THAT IS A MEASURED
    // PRECONDITION RATHER THAN A HOPE: a second occupant of lane 1 would have
    // failed the boot's own wait long before any pixel was compared, so the
    // scene cannot silently drift into the patch-dependent picture it is
    // arguing it avoids.
    //
    // (The recursion — a module whose screen shows other modules' cards showing
    // its own — is real and harmless. A module with no turnable params has an
    // empty push card, and that is a CORRECT picture of it.)
    //
    // What IS in frame: the module name, one ranked action button, the 960×160
    // replica painting its empty card, the eight lane buttons with lane 1
    // active, the ‹ › flip, three DARK lamps, and — on the compact tile —
    // nothing but the cell. Every pixel is a function of the code.
    //
    // ⚠ WHAT THIS BASELINE DOES **NOT** COVER: the connected surface — a lit
    // PUSH lamp, the four-role view segment, BIND, and a replica showing
    // ANOTHER module's eight strips of name + bar + readout. Reaching those
    // needs a simulated Push; the harness exists (`__push2TestInstall` /
    // `__push2Sim`, installed under `VITE_E2E_HOOKS`) but installing it in the
    // VRT rig is a change to the HARNESS rather than to this module — the
    // boundary `midiclock`, `launchpadControlLeft` and `gamepad` each drew.
    // Those surfaces are asserted where they can be asserted instead of
    // photographed: `push2-binder-status-model.test.ts` pins every string the
    // body can produce including the ones no baseline will ever show, and
    // `push2-face.spec.ts` drives the promoted surface against the graph.
    //
    // ⚠ THE ONE GENUINE VARIABLE, stated rather than buried: `midiAvailable()`
    // (`typeof navigator.requestMIDIAccess === 'function'`) picks between the
    // body's two top-level branches. It is a property of the browser BUILD, not
    // of attached hardware, and the baseline is authored by ONE linux CI runner
    // — `snapshotPathTemplate` has no `{platform}` segment — so it is a
    // constant where it gates.
    //
    // ⚠ NO `videoFaceWhy` AND NO `simPin`. `domain: 'meta'` — no ports and no
    // engine node, so `hasVideoSurface` is false and the AUDIO boot path is the
    // right one (matrixMix and launchpadControlLeft take it too, and the
    // column-membership premise that once refused port-less defs was measured
    // false: membership is decided by DROP POSITION). And nothing on this
    // surface advances between frames — `paintPushOps` is driven by the card
    // view, which changes only when a version rune bumps, and nothing bumps one
    // without a gesture or a graph edit.
  },

  // ── MIDI LANE — the second BINDER baselined, and a second exemption
  //    discharged on its OWN evidence ────────────────────────────────────────
  {
    type: 'midiLane',
    // FOUR bands: `lane` (connect + channel), `mono` (mode + priority +
    // retrig), `cc taps` (four gestures) and `note gate` (the typed field).
    // `DOCK_TAB_MIN_BANDS` is 7, so no rail — and nothing is padded toward one
    // or merged to stay under it. There is no hero, so no band is emptied by a
    // promotion and the post-hero count is the authored count.
    pages: 4,

    // ⚠ THIS SCENE IS WHY THE MODULE COULD LEAVE `ALLOWED_PERMANENT_EXEMPT`,
    // AND THE ARGUMENT IS THE EXEMPTION'S OWN — made on THIS card rather than
    // inherited from midiclock's, which the block those entries share is
    // explicit is not the same thing. `vrt-exemptions.ts` said "card content
    // depends on connected MIDI device" and conceded the other half in the same
    // sentence: *"the pre-Connect state is just the 'Connect MIDI…' button +
    // hint."* Both halves are true, and only the second is ever in frame.
    //
    // A freshly spawned midiLane has NO MIDI ACCESS. `midi-lane.ts`'s own
    // header says so — *"we DON'T request Web MIDI on mount"* — and the only
    // caller of `api.connect()` in the product is the CONNECT gesture, which
    // this scene does not press. So `access` is null, the device roster does
    // not merely happen to be empty but does not EXIST (`snapshotState()`
    // builds `devices` from `access.inputs`), the extension body renders its
    // pre-connect branch — one hint sentence and four DARK lamps — and the four
    // bands paint their cells at the defaults the def declares. Every pixel is
    // a function of the code, none of it of the runner's hardware.
    //
    // ⚠ AND THE UNREACHABILITY IS STRUCTURAL, NOT INCIDENTAL. On a runner with
    // no MIDI devices and no prior grant, the connected state is not merely
    // unlikely — there is no path to it without a click. That is what makes
    // this a discharge rather than a bet: the capture cannot DRIFT into the
    // hardware-dependent state.
    //
    // ⚠ WHAT THIS BASELINE DOES **NOT** COVER, stated rather than implied: the
    // post-connect device picker, the CC-learn armed lamp, and the NOTE lamp
    // lit. All three need a mocked `requestMIDIAccess` — which
    // `e2e/tests/_per-port-drivers.ts` already has, built for the per-port
    // sweep — but installing that mock in the VRT harness is a change to the
    // HARNESS rather than to this module. Not this PR. Those states are
    // asserted in `midi-lane.spec.ts` and their strings in
    // `midi-lane-status-model.test.ts`.
    //
    // ⚠ NO `videoFaceWhy` AND NO `simPin`. `domain: 'audio'` with seven cv /
    // gate / polyPitchGate outputs and no canvas anywhere on the surface: there
    // is no clock to pin and nothing that advances between frames. The lamps
    // change only when `notify()` fires, and `notify()` fires only on an
    // incoming MIDI message.
  },

  // ── ES-9 — the widest face in the cohort, and the one whose determinism
  //    argument is the INVERSE of midiclock's ────────────────────────────────
  {
    type: 'es9',
    // THREE bands: `bridge` (connect + disconnect), `out jacks` (eight class
    // switches, clustered into halves) and `in twins` (fourteen, clustered
    // 4/4/4/2). `DOCK_TAB_MIN_BANDS` is 7, so no rail — nothing is padded
    // toward one or merged to stay under it. There is no hero, so no band is
    // emptied by a promotion and the post-hero count is the authored count.
    pages: 3,

    // ⚠ THE DETERMINISM ARGUMENT HERE IS THE OPPOSITE OF `midiclock`'s AND
    // `midiLane`'s, and it is the FACE that supplies it rather than the
    // absence of a gesture. Those two are stable because nothing happens until
    // CONNECT is pressed and this suite presses nothing. es9 has no such gate:
    // its FACTORY calls `acquireEs9Bridge` unconditionally, `SharedArrayBuffer`
    // is present on `/rack` (COOP/COEP for Faust), so `es9BridgeAvailable()` is
    // true on every runner, the transport Worker really does spawn and really
    // does fail to reach ws://127.0.0.1:9209, and `bridge.worker.ts` cycles
    // connecting → close → `scheduleReconnect()` on a doubling 1 s→5 s backoff
    // forever.
    //
    // On the LEGACY CARD that makes the status row phase-dependent — it paints
    // `stateLabel`, which alternates between "connecting…" and "bridge not
    // found". THE FACE DOES NOT PAINT IT AT ALL. Every one of those strings is
    // deleted by the resting-text ruling (see `es9-status-model.ts`, which is
    // where they went), so what remains is:
    //
    //   * BRIDGE and CV BUDDY lamps DARK and XRUN dark — `connState` never
    //     reaches 'connected' with no helper listening, so no `deviceInfo`
    //     arrives, `snap.meters` stays null and `es9XrunLit` is false; and a
    //     scene with no cvBuddy in it leaves the third lamp dark too;
    //   * the static empty-state hint, because `snap.supported` is true and the
    //     link is down;
    //   * 24 cells at the defaults the def declares;
    //   * the `meter` glyph on `in1`, fed by a worklet whose rings the worker
    //     never fills — digital silence, i.e. the same flat centreline every
    //     other faced module's live glyph draws — and `bootWithFace` freezes
    //     the audio graph on top of that.
    //
    // So every pixel is a function of the code and none of it of the runner's
    // hardware. The face is not merely capturable DESPITE the retrying worker;
    // it is what makes the claim true.
    //
    // ⚠ WHAT THIS BASELINE DOES **NOT** COVER, stated rather than implied: the
    // connected state (a device name, a rate, a round-trip time), a lit XRUN
    // lamp, and the CV BUDDY lamp lit. The first two need an es9-bridge process
    // listening on localhost, which no runner has and which is the whole reason
    // the module exists. Their strings are unit-asserted in
    // `es9-face-model.test.ts` (every string the lamps can produce, painted or
    // not); the lamp bindings and the unpainted-but-present half are asserted
    // in `es9-face.spec.ts`, which also drives a REAL CV Buddy so the third
    // lamp is proved able to light rather than merely observed dark.
    //
    // ⚠ NO `videoFaceWhy` AND NO `simPin`. `domain: 'audio'`; the only canvas
    // on the surface is the shell's own live-audio glyph, which `bootWithFace`
    // already freezes.
  },

  // ── OUT TO LAUNCH — the fourth BINDER baselined, and the first that is also
  //    a VIDEO module ───────────────────────────────────────────────────────
  {
    type: 'outToLaunch',
    // ONE band: the ranked CONNECT action cell plus BRIGHT and GAMMA. Three
    // cells, one IDEA — put this video on that hardware — so no `face.pages` is
    // declared and the dock renders a single section. `DOCK_TAB_MIN_BANDS` is 7
    // and nothing is padded toward it. There is no hero, so no band is emptied
    // by a promotion and the post-hero count is the authored count.
    pages: 1,

    // ⚠ THIS SCENE IS WHY THE MODULE COULD LEAVE `ALLOWED_PERMANENT_EXEMPT`.
    // Its exemption named TWO grounds and both are discharged on this module's
    // own evidence rather than by inheriting a sibling's argument.
    //
    // GROUND 1 — "live 9×9 monitor preview". Discharged BY THE SHADER, which is
    // stronger than scene construction: `out-to-launch.ts`'s fragment source
    // opens with `if (uHasInput < 0.5) { outColor = vec4(0.0, 0.0, 0.0, 1.0); }`
    // and `hasInput` is `frame.getInputTexture(node.id, 'in') !== null`. A
    // `bootWithFace` scene spawns exactly ONE node and patches nothing into it,
    // so every one of the 81 texels is a compile-time constant, the readback is
    // 324 zero bytes, and both surfaces that draw it paint the unlit socket
    // grid. This is not "the picture happens to be still" — there is no path
    // from an unpatched input to a non-black texel.
    //
    // GROUND 2 — "Web-MIDI device list". Same structural unreachability
    // `midiLane`'s entry records, one layer over. The roster this face renders
    // is `outToLaunchPorts()`, which is EMPTY until `outToLaunchConnect()`
    // publishes into it, and the only caller of that is the CONNECT cell, which
    // this scene does not press. So the picker branch does not merely happen to
    // be unreachable on a device-less runner — it cannot be reached without a
    // click. The plate paints its EMPTY-STATE line and one dark lamp.
    //
    // ⚠ THE COMPACT SCENE HAD A THIRD, UNSTATED GROUND, AND IT IS FIXED RATHER
    // THAN ARGUED AWAY. The lane tile paints a `VideoTileThumb`, which blits a
    // node's texture into the engine's SHARED drawing buffer and then snapshots
    // that buffer — and this is the one video def whose surface is `{ fbo:
    // null, texture: null }`, so the blit did nothing and the snapshot showed
    // whichever node blitted last. Measured: byte-identical to a `videoOut`
    // tile in the same rack. A one-node capture would have been deterministic
    // by luck and the product would still have been wrong, so the guard is in
    // `VideoTileThumb.svelte` and the tile now paints its own dark well.
    videoFaceWhy:
      'BOTH scenes carry a video surface: the compact lane tile paints a VideoTileThumb through '
      + 'hasVideoSurface (domain === "video"), and the dock body is the module\'s own fullViewBody '
      + 'extension drawing the live 9x9 monitor from read("grid9x9"). So it must boot into the '
      + 'VIDEO ZONE — the audio path would wait out the full 90 s timeout on a mixer-column '
      + 'membership a video node never acquires. ⚠ NEITHER SURFACE NEEDS A CLOCK PINNED, and the '
      + 'reason is the def rather than the harness: with nothing patched into `in` the fragment '
      + 'shader takes its `uHasInput < 0.5` branch and writes a CONSTANT black, so the 9x9 is '
      + 'invariant in time; and the tile is a texture-less sink, which now paints the dark well. '
      + 'This def declares no `freeze` param, so freezeFaceVideo writes a key nothing reads — its '
      + 'stability assertion passes because the picture is ALREADY still, which is the vfpgaRunner '
      + 'case re-verified against this body rather than inherited from it.',
  },

  // ── MIDI-CV-BUDDY — the fifth BINDER baselined ───────────────────────────
  {
    type: 'midiCvBuddy',
    // TWO bands: `input` (connect + channel) and `mono` (priority + retrig).
    // `DOCK_TAB_MIN_BANDS` is 7, so no rail — and nothing is padded toward one
    // or merged to stay under it. There is no hero, so no band is emptied by a
    // promotion and the post-hero count is the authored count.
    pages: 2,

    // ⚠ THE PRE-CONNECT SURFACE IS A FUNCTION OF THE CODE, NOT OF THE RUNNER,
    // and the argument is this module's own rather than inherited. A freshly
    // spawned midiCvBuddy has NO MIDI ACCESS: the def's header says so in
    // terms — *"Web MIDI permission is NOT requested at module
    // instantiation"* — and the only caller of `api.connect()` in the product
    // is the CONNECT cell, which this scene does not press. So `access` is
    // null, the device roster does not merely happen to be empty but does not
    // EXIST (`snapshotState()` builds `devices` from `access.inputs`), the
    // extension body renders its pre-connect branch — one hint sentence and two
    // DARK lamps — and both bands paint their cells at the defaults the def
    // declares.
    //
    // ⚠ AND THE UNREACHABILITY IS STRUCTURAL, NOT INCIDENTAL. On a runner with
    // no MIDI devices and no prior grant, the connected state is not merely
    // unlikely — there is no path to it without a click, so the capture cannot
    // DRIFT into the hardware-dependent state.
    //
    // ⚠ ITS `EXEMPT_FROM_VRT` CARD ENTRY IS DELIBERATELY LEFT STANDING. That
    // exemption is about the LEGACY CARD scene in `vrt.spec.ts`, which is a
    // different subject from these two face scenes, and the block those entries
    // share is explicit that discharging the argument for one module does not
    // discharge it for a sibling. Draining it is a separate, deliberate edit on
    // its own evidence; this promotion does not make it.
    //
    // ⚠ WHAT THIS BASELINE DOES **NOT** COVER, stated rather than implied: the
    // post-connect device picker and the NOTE lamp LIT. Both need a mocked
    // `requestMIDIAccess` — which `e2e/tests/_per-port-drivers.ts` already has,
    // built for the per-port sweep — but installing that mock in the VRT
    // harness is a change to the HARNESS rather than to this module. Not this
    // PR. Those states are asserted in `midi-cv-buddy.spec.ts` and their
    // strings in `midi-cv-buddy-status-model.test.ts`.
    //
    // ⚠ NO `videoFaceWhy` AND NO `simPin`. `domain: 'audio'` with three cv/gate
    // outputs and no canvas anywhere on the surface: there is no clock to pin
    // and nothing that advances between frames. The lamps change only when
    // `notify()` fires, and `notify()` fires only on an incoming MIDI message.
  },

  // ── MIDI-OUT-BUDDY — the sixth BINDER baselined, and the first ZERO-OUTPUT
  //    module in this roster ─────────────────────────────────────────────────
  {
    type: 'midiOutBuddy',
    // ONE band: connect + channel. Two cells, one IDEA — put these notes on
    // that instrument — so nothing is padded toward the 7-band rail threshold.
    // There is no hero, so the post-hero count is the authored count.
    pages: 1,

    // ⚠ SAME STRUCTURAL PRE-CONNECT ARGUMENT AS THE SIBLING ABOVE, made on this
    // module's own state machine: `midi-out-buddy.ts` requests nothing on
    // mount, `snapshotState()` builds `devices` from `access.outputs`, and
    // `access` stays null until the CONNECT cell is pressed. The plate paints
    // its hint line and three DARK lamps.
    //
    // ⚠ THE LANE LAMP IS DARK IN THIS SCENE, AND THAT IS THE CORRECT CAPTURE
    // RATHER THAN A MISSED STATE. `bootWithFace` spawns one node on the free
    // canvas, so it has no `data.channel` and `laneChannelOf` returns null —
    // nothing to diverge from. The DIVERGED state is a workflow-lane condition
    // this harness does not construct, and it is asserted in
    // `midi-out-buddy-status-model.test.ts` (both the boolean and the sentence)
    // plus `workflow-channel-columns.spec.ts` on the legacy card, which
    // survives under `?shell=legacy`.
    //
    // ⚠ ITS `EXEMPT_FROM_VRT` CARD ENTRY IS ALSO LEFT STANDING, for the reason
    // the sibling entry gives.
    //
    // ⚠ NO `videoFaceWhy` AND NO `simPin`. `domain: 'audio'`, `outputs: []`,
    // and no canvas anywhere on the surface. The lamps change only when
    // `notify()` fires, which needs a gate edge on an input this scene patches
    // nothing into.
  },

  // ── THE CODE-BUFFER PAIR — the first faceplates whose body is a TEXT EDITOR
  //    ─────────────────────────────────────────────────────────────────────
  //
  // ⚠ BOTH MODULES CARRY A CARD EXEMPTION IN `EXEMPT_FROM_VRT` NAMING THE EXACT
  // HAZARD THESE SCENES HAVE TO CLEAR, and it is not inherited — it is answered.
  // The entries read "CodeMirror caret + syntax-highlight transitions defeat
  // deterministic capture" and "CodeMirror caret + dynamic status
  // (fires-since-mount counter)". Each names a real mechanism and each is about
  // a state THESE SCENES CANNOT BE IN, for reasons that are properties of the
  // boot rather than of luck:
  //
  //   THE CARET. `drawSelection()` renders `.cm-cursorLayer`, and CodeMirror's
  //     own base theme animates it under `.cm-focused > .cm-scroller >
  //     .cm-cursorLayer`. `bootWithFace` opens a faceplate and frames it; it
  //     never clicks into the buffer, so the editor is UNFOCUSED and the blink
  //     rule does not match. Instrumented two ways before baselining — an
  //     in-page rAF sampler AND a MutationObserver over the same window — after
  //     the es9 lesson that a 37 ms sampler read 325/325 identical while an
  //     observer caught six transitions on the same surface.
  //
  //   THE SYNTAX HIGHLIGHTING. A scene spawns exactly ONE node and writes no
  //     data, so `node.data.source` / `node.data.text` is absent and the buffer
  //     is EMPTY. There are no tokens to colour, no diagnostics for the linter
  //     to underline, and nothing for the Lezer parser to do incrementally. Not
  //     "it settles quickly" — there is no work.
  //
  //   THE FIRES-SINCE-MOUNT COUNTER. It is GONE as text (the 2026-08-19 rulings
  //     deleted the shape), and it could not move a pixel here anyway: it is now
  //     the FIRING lamp's `lit` boolean, and `clocked-runner.ts`'s tick opens
  //     `if (!source.trim()) return`, so an empty body never fires and the lamp
  //     is dark in every frame.
  //
  // The CARD exemptions STAY. They are about `?shell=legacy`, where the card
  // paints its own live status line, and this is the rings / attenumix / es9
  // precedent: a face is baselined while its legacy card is not, on evidence
  // that belongs to the surface being captured.
  {
    type: 'clockedRunner',
    // ONE band: the single DIV selector cell. `params: []`, so nothing else
    // could rank — the callback body is the extension's `fullViewBody`, for the
    // addressability reason the def's face comment gives. No `face.pages` is
    // declared, so the dock renders one `__unpaged` section.
    pages: 1,
    // ⚠ NO `videoFaceWhy` AND NO `simPin`. `domain: 'audio'` with NO ports at
    // all, and nothing on the surface draws: the buffer is a DOM text editor and
    // the two lamps are spans. There is no clock to pin — the module's own tick
    // subscription exists and is inert, because an empty body returns before it
    // reads the tempo.
  },
  {
    type: 'livecode',
    // ONE band: the single RUN action cell. Same shape as its child, and for the
    // same reason — the script buffer and the output log are the body.
    pages: 1,
    // ⚠ THE OUTPUT LOG IS NOT IN THIS CAPTURE, and that is by construction
    // rather than by masking. It renders only when `node.data.lastRun.log` has
    // lines, `lastRun` is written only by `runLivecodeNode`, and its only
    // callers are the RUN cell and the two editor surfaces' test hooks — none of
    // which this scene invokes. So the resting plate is the buffer, one dark
    // lamp and the RUN band, with no empty-state placeholder to drift.
  },
  // ── THE VST BRIDGE PAIR — two scenes each, and the determinism argument is
  //    es9's, one module family over ────────────────────────────────────────
  //
  // ONE band each (`bridge`, holding CONNECT + DISCONNECT). No hero, so nothing
  // empties it and the post-hero count is the authored count.
  //
  // ⚠ THE DETERMINISM ARGUMENT IS THE INVERSE OF THE LEGACY CARD'S, AND THE FACE
  // IS WHAT SUPPLIES IT. Both defs' factories call `acquireVstBridge`
  // UNCONDITIONALLY, `SharedArrayBuffer` is present on `/rack` (COOP/COEP for
  // Faust), so `vstBridgeAvailable()` is true on every runner, the transport
  // Worker really does spawn, really does fail to reach ws://127.0.0.1:9309, and
  // reconnects on a 1-5 s backoff forever. On the CARD that makes the status row
  // phase-dependent — it paints `stateLabel`, alternating "connecting…" ↔
  // "helper not found" — which is why the card is and stays VRT-exempt.
  //
  // THE FACE DOES NOT PAINT IT AT ALL. Every one of those strings is deleted by
  // the resting-text ruling (see `vst-status-model.ts`, which is where they
  // went), so what remains on a helperless runner is:
  //
  //   * four DARK lamps — `connState` never reaches 'connected', so `linkUp` is
  //     false, `snap.mounted` is null, `snap.meters` is null and nothing is
  //     persisted; every lamp's varying text is on `aria-label`/`title`, which
  //     no baseline reads;
  //   * the static empty-state hint, because `snap.supported` is true and the
  //     link is down. ⚠ The picker/mount row is inside the SAME `{#if linkUp}`
  //     that the hint is the else-branch of, so on CI it never renders at all —
  //     the one live roster on this surface is structurally absent from the
  //     image rather than merely stable in it;
  //   * two cells at their declared labels;
  //   * the `meter` glyph on `out_l`, fed by a worklet whose rings the worker
  //     never fills — digital silence, i.e. the same flat centreline every other
  //     faced module's live glyph draws — and `bootWithFace` freezes the audio
  //     graph on top of that.
  //
  // ⚠ MEASURED TWO WAYS, AND THE SECOND INSTRUMENT FOUND SOMETHING — which is
  // why it is written out rather than summarised as "deterministic". A single
  // sampler is what made es9's CARD look clean (325/325 identical samples over
  // 12 s against 6 MutationObserver transitions in the same window), so this
  // face was probed with BOTH: an in-page 37 ms sampler over `.faceplate-body`
  // and a MutationObserver over the same subtree (subtree + childList +
  // characterData + attributes), both accumulating INSIDE the page.
  //
  //   sampler          216-242 samples / ~12,039 ms — ONE distinct value
  //   MutationObserver 16 records, and EVERY ONE of them is
  //                    `attr:SPAN.aria-label` or `attr:SPAN.title`
  //
  // So the reconnect state machine IS LIVE under the capture, exactly as it is
  // on the card — the difference is WHERE it lands. Sixteen mutations in twelve
  // seconds is the BRIDGE lamp's `detail` sentence alternating between
  // "opening the connection…" and "the helper did not answer", and the
  // resting-text ruling put that string on `aria-label`/`title`, which no
  // baseline reads. ZERO records touched `class`, `data-lit`, `characterData`
  // or `childList`, so the lamp's PICTURE never flips (`lit` is
  // `state === 'connected'`, unreachable here) and no text node changes.
  //
  // That is a stronger claim than "nothing happens", and it is the honest one:
  // the face is not still, it is UNPAINTED where it moves.
  //
  // ⚠ WHAT THESE BASELINES DO **NOT** COVER, stated rather than implied: the
  // connected state — the plugin picker, its filter, the mount/swap/unmount/
  // editor row, a lit PLUGIN or LOAD or SAVED lamp. All of it needs a vst-bridge
  // helper process and an installed AU, which no runner has and which is the
  // whole reason these modules exist. Their strings are unit-asserted in
  // `vst-face-model.test.ts` (every string the four lamps can produce, painted
  // or not), and the surface itself is driven against a REAL mock helper in
  // `vst-bridge.spec.ts` / `vst-lane-autowire.spec.ts`.
  //
  // ⚠ NO `videoFaceWhy` AND NO `simPin` on either. `domain: 'audio'`; the only
  // canvas on the surface is the shell's own live-audio glyph, which
  // `bootWithFace` already freezes.
  { type: 'vstInstrument', pages: 1 },
  { type: 'vstFx', pages: 1 },

  // ── FROGGER — the first ARCADE BOARD baselined, and the promotion that
  //    DISCHARGED ITS OWN NAMED RATCHET ────────────────────────────────────
  //
  // ⚠ THE TWO SCENES ON THIS MODULE HAVE COMPLETELY DIFFERENT DETERMINISM
  // ARGUMENTS, exactly as pong's do, and conflating them is how a scene ends up
  // pinned by nothing.
  //
  //   COMPACT has NO PICTURE AT ALL and is deterministic for free. All three
  //     outputs are `type: 'gate'`, so `primaryAudioOutPortId` is null, every
  //     glyph literal but `'none'` resolves `{kind:'static'}` and the face
  //     declares `glyph: 'none'`. `hasVideoSurface` is `domain === 'video'` and
  //     this is an AUDIO def, so there is no `VideoTileThumb` either. The tile
  //     is ONE KNOB. ⚠ If `ShellExtensionGlyphProps` ever gains a `nodeId`,
  //     THIS SCENE NEEDS THE DOCK SCENE'S TREATMENT and not this paragraph —
  //     the same conditional pong's compact entry carries, and for the same
  //     mechanical reason (a glyph component today cannot resolve a graph node,
  //     so it cannot reach `eng.read(node, 'snapshot')`).
  //
  //   DOCK carries the LIVE BOARD — the module's `fullViewBody` extension
  //     painting `drawFrogger` every rAF off the game snapshot — and is not
  //     deterministic by any amount of settling. It needs the pin below.
  //
  // ⚠ NO `videoFaceWhy`, AND THE REASON IS NOT THE ONE THE BUILD SPEC GAVE.
  // That field does two things: it boots into the VIDEO ZONE instead of a
  // channel column, and it turns on `freezeFaceVideo`, which WRITES
  // `params.freeze`. frogger declares no `freeze` param, so that write would
  // invent an undeclared key and the assertion after it would be measuring a
  // freeze that never happened — the `timelorde` hazard, verbatim. The channel
  // column is reachable on the ordinary path regardless of port shape (column
  // membership is decided by DROP POSITION, and eight gate/CV-only faces
  // already join fine), and the tick pin makes the board time-invariant, so
  // there is nothing left for a video freeze to do.
  //
  // ⚠ AND NO `freeze` ParamDef EITHER, on this file's own measured rule
  // (2026-08-25): a `params` edit is in the WebGL attest basis AND in
  // contract-lock, so it costs an owner-machine re-attest plus a contract
  // re-pin, and it buys only INTRA-boot stillness — it holds whichever frame
  // the harness caught, which is a different frame per boot. frogger is a
  // STATEFUL SIM on the MAIN THREAD, which is precisely the case this file
  // says takes a `simPin` on the module's OWN seam.
  {
    type: 'frogger',
    // ONE band, ONE control. `order` and `pages` agree; there is no second idea
    // to page and a rail needs DOCK_TAB_MIN_BANDS = 7.
    pages: 1,
    simPin: [
      {
        global: '__froggerVrtTicks',
        value: 96,
        why:
          'pins WHICH BOARD, not merely a still one — the whole game state becomes a function '
          + 'of (ticks, params) rather than of boot speed. ⚠ AND FROGGER NEEDS NO SEED, which is '
          + 'what makes this the cheapest pin in the roster and is a property no sibling game '
          + 'module shares: there is no `Math.random` anywhere in `frogger-state.ts` — a fixed '
          + 'sprite clone, deterministic traffic, a constant `dtSeconds` — so the board was '
          + 'ALREADY a pure function of TICK COUNT and the only nondeterminism was how many '
          + 'ticks landed before the capture. ⚠ A freeze alone would NOT have been sufficient '
          + 'and that is measured on the sibling with the same topology: pong drifted 72 pixels '
          + 'at max channel delta 237 across two ubuntu boots WITH a seed, because the seed '
          + 'fixes which trajectory and cannot fix how far along it the capture landed. So the '
          + 'factory rebuilds the state, steps it exactly 96 ticks (96 x 25 ms = 2.4 s of play) '
          + 'and then STOPS TICKING ALTOGETHER — lushgarden\'s and pong\'s shape, which makes '
          + 'the board TIME-INVARIANT rather than frozen at an arbitrary moment. That matters '
          + 'more here than anywhere: the game clock is a Web Worker `setInterval` that is NOT '
          + 'gated on the AudioContext, so the harness audio suspend could never have stopped '
          + 'this game. ⚠ 96 IS A POSITION ON THE GAME\'S TIMELINE, NOT A POPULATION COUNT: it '
          + 'is past the synthetic auto-start, ~240 sprite ticks into the traffic\'s travel (the '
          + 'sprite clock runs at ~100 Hz of game time inside the 40 Hz real tick) and two '
          + 'seconds off the 60 s HUD timer, so the pinned frame differs from the boot frame in '
          + 'the traffic layout AND in the HUD and cannot be reached by a stepper that never '
          + 'ran. Nothing is patched into the steering inputs, so the frog sits at its spawn '
          + 'cell and no gate has fired. ⚠ It REACHES this factory only because frogger is '
          + 'main-thread: simPin installs boot-time globals via addInitScript, so a worker '
          + 'renderLocus would put it out of reach (the acidwarp case). ⚠ THE SAME GLOBAL PINS '
          + 'THE LEGACY CARD SCENE in vrt-scenes.ts, which is what let frogger leave '
          + 'EXEMPT_FROM_VRT and ALLOWED_PERMANENT_EXEMPT in this same commit — one hook, three '
          + 'baselines, and the exemption\'s own stated exit condition met rather than argued '
          + 'around. ⚠ DOOM IS EXCLUDED FROM THIS MECHANISM BY NAME: its runTic() runs inside '
          + 'surface.draw, so its game clock IS its frame clock and a tick pin would '
          + 're-specify the game. No DOOM file was opened.',
      },
    ],
  },

  // ── MODTRIS — frogger's topology with the pin frogger did not need ───────
  //
  // ⚠ THE TWO SCENES ON THIS MODULE HAVE COMPLETELY DIFFERENT DETERMINISM
  // ARGUMENTS, exactly as frogger's and pong's do, and conflating them is how a
  // scene ends up pinned by nothing.
  //
  //   COMPACT has NO PICTURE AT ALL and is deterministic for free. Both outputs
  //     are `type: 'gate'`, so `primaryAudioOutPortId` is null, every glyph
  //     literal but `'none'` resolves `{kind:'static'}` and the face declares
  //     `glyph: 'none'`. `hasVideoSurface` is `domain === 'video'` and this is an
  //     AUDIO def, so there is no `VideoTileThumb` either. The tile is TWO
  //     FADERS. ⚠ If `ShellExtensionGlyphProps` ever gains a `nodeId`, THIS
  //     SCENE NEEDS THE DOCK SCENE'S TREATMENT and not this paragraph — the same
  //     conditional frogger's and pong's compact entries carry, and for the same
  //     mechanical reason (a glyph component today cannot resolve a graph node,
  //     so it cannot reach `eng.read(node, 'snapshot')`).
  //
  //   DOCK carries the LIVE WELL — the module's `fullViewBody` extension
  //     painting `drawModtris` every rAF off the game snapshot — and is not
  //     deterministic by any amount of settling. It needs the pin below.
  //
  // ⚠ NO `videoFaceWhy`. That field does two things: it boots into the VIDEO
  // ZONE instead of a channel column, and it turns on `freezeFaceVideo`, which
  // WRITES `params.freeze`. modtris declares no `freeze` param, so that write
  // would invent an undeclared key and the assertion after it would be measuring
  // a freeze that never happened — the `timelorde` hazard, verbatim. The channel
  // column is reachable on the ordinary path regardless of port shape (column
  // membership is decided by DROP POSITION), and the pin below makes the well
  // time-invariant, so there is nothing left for a video freeze to do.
  //
  // ⚠ AND NO `freeze` ParamDef EITHER, on this file's own measured rule
  // (2026-08-25): a `params` edit is in contract-lock (and in the WebGL attest
  // basis for a def that is in it), so it costs a contract re-pin and buys only
  // INTRA-boot stillness — it holds whichever frame the harness caught, a
  // different frame per boot. modtris is a STATEFUL SIM on the MAIN THREAD,
  // which is precisely the case this file says takes a `simPin` on the module's
  // OWN seam.
  {
    type: 'modtris',
    // ONE band, TWO controls. `order` and `pages` agree; both params answer the
    // same question (how hard is this game) and a rail needs
    // DOCK_TAB_MIN_BANDS = 7, so nothing is padded to reach one.
    pages: 1,
    simPin: [
      {
        global: '__modtrisVrtSeed',
        value: 0x4d54,
        why:
          'pins WHICH 7-BAG, which frogger did not need and modtris cannot do without. '
          + '`refillQueueIfNeeded` (modtris-state.ts) runs a Fisher-Yates shuffle off '
          + '`opts.rng ?? Math.random`, so without a seed the piece sequence — and therefore the '
          + 'stack, the colours and the NEXT preview — differs on every boot no matter how many '
          + 'ticks are pinned. ⚠ THE SEED ALONE IS NOT SUFFICIENT AND THAT IS MEASURED ON THE '
          + 'SIBLING WITH THIS TOPOLOGY: pong drifted 72 differing pixels at max channel delta '
          + '237 across two ubuntu boots WITH a seed, because a seed fixes which trajectory and '
          + 'cannot fix how far along it the capture landed. See __modtrisVrtTicks below; the '
          + 'two are ONE pin in two halves and neither works alone. ⚠ It REACHES this factory '
          + 'only because modtris is main-thread: simPin installs boot-time globals via '
          + 'addInitScript, so a worker renderLocus would put it out of reach (the acidwarp '
          + 'case). ⚠ THE SAME PAIR PINS THE LEGACY CARD SCENE in vrt-scenes.ts, which is what '
          + 'let modtris leave EXEMPT_FROM_VRT and ALLOWED_PERMANENT_EXEMPT in this same commit '
          + '— one hook, three baselines. ⚠ DOOM IS EXCLUDED FROM THIS MECHANISM BY NAME: its '
          + 'runTic() runs inside surface.draw, so its game clock IS its frame clock and a tick '
          + 'pin would re-specify the game. No DOOM file was opened.',
      },
      {
        global: '__modtrisVrtTicks',
        value: 3200,
        why:
          'pins WHICH WELL, not merely a still one — the whole game state becomes a function of '
          + '(seed, ticks, params) rather than of boot speed. The factory rebuilds the state '
          + 'under mulberry32(seed), steps it exactly this many ticks and then STOPS TICKING '
          + "ALTOGETHER — lushgarden's and pong's shape, which makes the well TIME-INVARIANT "
          + 'rather than frozen at an arbitrary moment. That matters more here than almost '
          + 'anywhere: the game clock is a Web Worker `setInterval` that is NOT gated on the '
          + 'AudioContext, so the harness audio suspend could never have stopped this game. '
          + '⚠ 3200 IS A POSITION ON THE GAME\'S TIMELINE, NOT A POPULATION COUNT: 3200 x 25 ms '
          + '= 80 s of play at the default 60 BPM gravity, and it was COMPUTED from the stepper '
          + 'rather than picked. Under seed 0x4d54 with nothing patched into the steering inputs '
          + '(so every gate edge is false and pieces stack in the spawn columns), tick 3200 '
          + 'leaves 20 LOCKED cells rising to row 11, an L in the NEXT slot and the active piece '
          + 'mid-fall at row 5 — so the pinned frame differs from the boot frame in the WELL, in '
          + 'the NEXT preview AND in the falling piece, and cannot be reached by a stepper that '
          + 'never ran. It also sits several hundred ticks clear of the overfill-and-reset this '
          + 'seed reaches later, so the frame is not on a cliff.',
      },
    ],
  },

  // ── GIBRIBBON — the REWRITE-CLASS promotion: determinism DESIGNED IN, so
  //    the face scenes are baselinable and FACES_WITHOUT_SCENES is refused ──
  //
  // The rewritten engine (gibribbon-engine.ts) is a pure function of
  // (seed, scheduler tick count, per-tick inputs): no Math.random, no
  // Date.now, no wall-clock dt — render interpolation reads the tick-derived
  // phase and sprite animation runs on the scheduler tick count. So BOTH
  // scenes pin the same way the module's card scene does (vrt-scenes.ts),
  // via three boot-time globals the factory reads at construction (this
  // roster's simPin → addInitScript path) and once more in its tick (the
  // card scene's afterSpawn path):
  //
  //   seed  → the xorshift stream (course tie-breaks, per-run reseed chain);
  //   ticks → rebuild + step EXACTLY N scheduler ticks with idle inputs, then
  //           SUPPRESS all further stepping — the frogger/pong shape, which
  //           makes the picture TIME-INVARIANT rather than frozen at an
  //           arbitrary boot-speed-dependent moment. 168 ticks = 4.2 s of
  //           seeded ATTRACT self-play: a populated course, a non-zero SCORE
  //           and the in-canvas ATTRACT label (the honest-self-play claim, in
  //           pixels);
  //   noWad → pins the ART PATH to the line-art fallback. The DOOM1.WAD is
  //           gitignored and setup-fetched, and its decode is ASYNC — without
  //           this pin the captured frame is a function of fetch timing and
  //           of which environment fetched the file.
  //
  // ⚠ `freezeFaceVideo`'s `params.freeze = 1` write lands NOWHERE on this def
  // (no `freeze` param) and needs to land nowhere: with the tick pin
  // suppressing the stepper, the paint is a pure function of the engine state
  // and there is no wall-clock term left in the frame. Do NOT "fix" that by
  // adding a freeze ParamDef — a `params` edit on a def inside the WebGL
  // attest basis costs an owner-machine re-attest to buy an assertion that
  // already holds (this file's own 2026-08-25 rule).
  //
  // ⚠ FACES_WITHOUT_SCENES IS NOT CLAIMABLE HERE, BY THE SPEC'S OWN WORD: its
  // bar is "evidence that simPin AND freeze cannot reach this renderer", and
  // here both can BY CONSTRUCTION — the old blanket exemption text retired
  // with the rewrite (vrt-exemptions.ts carries the discharge note).
  {
    type: 'gibribbon',
    // No declared face.pages: the dock renders ONE unlabelled band holding the
    // three ranked cells (difficulty / tempo / attract) under the extension
    // body (the game screen). The 13 CV-target params are noUserControl and
    // render zero cells.
    pages: 1,
    videoFaceWhy:
      'a VIDEO module, so it must boot into the video zone rather than a mixer channel column — '
      + 'without this field bootWithFace waits out the full 90 s test timeout for a column '
      + 'membership a video node never acquires. Both scenes carry a live picture (the compact '
      + "tile's VideoTileThumb through hasVideoSurface, and the dock body's own fullViewBody "
      + 'game screen), and the module ANIMATES BY CONSTRUCTION — an attract run is self-playing '
      + 'the moment the factory boots. The freeze write itself is a NO-OP on this def (no '
      + '`freeze` param, deliberately — the attest-basis rule): stillness comes from the '
      + '__gibribbonVrtTicks suppression in simPin, which stops the ONE clock the whole game '
      + 'derives from.',
    simPin: [
      {
        global: '__gibribbonVrtSeed',
        value: 0xc0de,
        why:
          'pins the xorshift32 stream — course-extraction tie-breaks and the per-run reseed '
          + 'chain are the only randomness in the rewritten engine (no Math.random anywhere, '
          + 'pinned by gibribbon-face-model.test.ts). Alone it fixes WHICH attract run plays '
          + 'but not how far along it the capture lands — the nibbles lesson, both halves '
          + 'required.',
      },
      {
        global: '__gibribbonVrtTicks',
        value: 168,
        why:
          'rebuilds the run and steps it EXACTLY 168 scheduler ticks (4.2 s of seeded attract '
          + 'self-play) with idle inputs, then SUPPRESSES all further stepping — the '
          + 'frogger/pong shape, time-invariant rather than frozen. 168 is a POSITION on the '
          + "game's timeline: past the count-in, into a populated course with the attract bot "
          + 'scoring, so the frame shows the ribbon, the lookahead lane, a non-zero SCORE and '
          + 'the ATTRACT label, and cannot be reached by a stepper that never ran. It matters '
          + 'more here than anywhere: the game clock is a Web Worker setInterval that no audio '
          + 'suspend and no rAF gate can hold — the module-side early-return is the ONLY '
          + 'mechanism (GAMES.md §4.1).',
      },
      {
        global: '__gibribbonVrtNoWad',
        value: true,
        why:
          'pins the ART PATH to the line-art fallback: DOOM1.WAD is gitignored + setup-fetched '
          + 'and its sprite decode is ASYNC, so without this the captured frame is a function '
          + 'of fetch timing and environment. The fallback is a real shipped path (the WAD lamp '
          + 'lights beside RESET); the sprite path is covered by the wad-sprites unit suite.',
      },
    ],
  },

  // ── TV LIBRARIAN — a LIVE THIRD-PARTY STREAM that is nevertheless capturable
  {
    type: 'tvLibrarian',
    // No `face.pages`, so the dock renders one unlabelled section holding the
    // single ranked cell (`gain`) above the tuner body. Nothing is padded to
    // reach a rail — one control is the honest count for this module.
    pages: 1,
    videoFaceWhy:
      'a VIDEO module, so it must boot into the video zone rather than a mixer channel column — '
      + 'without this field bootWithFace waits out the full 90 s test timeout for a column '
      + 'membership a video node never acquires. ⚠ AND IT IS CAPTURABLE DESPITE SITTING IN '
      + '`EXEMPT_FROM_VRT` FOR A LIVE HLS STREAM, which is the interesting part and is why this '
      + 'is a real baseline rather than a FACES_WITHOUT_SCENES entry — see below.',
    // ⚠ WHY THIS FACE GETS REAL BASELINES WHILE THE MODULE STAYS EXEMPT.
    //
    // `tvLibrarian` sits in `EXEMPT_FROM_VRT` and in `ALLOWED_PERMANENT_EXEMPT`:
    // "live external HLS <video> + runtime-fetched, ever-changing channel list
    // defeat deterministic capture". That stays TRUE OF THE CARD SCENE, which is
    // a different surface with a different baseline — the same distinction the
    // `loopback`, `cameraInput` and `scoreboard` entries draw. It is not true of
    // a FACE scene, and BOTH halves of the exemption were re-checked rather than
    // inherited:
    //
    // (1) THE PICTURE NEEDS NO PIN, AND THAT IS MEASURED AT THE SHADER. A scene
    //     spawns the node and tunes nothing, so `uHasInput` is 0 and the idle
    //     branch runs: `vec4(0.05, 0.05, 0.09 + vUv.y * 0.05, 1.0)`. No clock, no
    //     accumulator, no uniform that is not a param — the output is a pure
    //     function of position, identical across boots, renderers and frame
    //     counts. ⚠ The build spec prescribed a `__tvlibrarianTestFrame` pin as
    //     well; reading the shader is what showed it would pin something already
    //     still. It is deliberately NOT declared, so this entry stays anchored to
    //     what the module actually does.
    //
    // (2) THE ROSTER DOES, AND THE REASON IS NOT THE OBVIOUS ONE. With no
    //     network a runner's country fetch REJECTS, and the picker's catch paints
    //     `Could not load channel list: <message>` — where the message is the
    //     ENVIRONMENT's, not ours. Without the pin the dock baseline would be a
    //     function of which browser build refused the request, which is the
    //     per-machine baseline this suite cannot have. The CHANNEL roster needs
    //     nothing: it is the node-owned controller's and stays empty until a
    //     country is chosen, so a fresh spawn shows the map and no list.
    simPin: [
      {
        global: '__tvLibrarianTestCountries',
        value: 1,
        why:
          'makes the picker use its own fixed two-country dataset instead of fetching famelack, so '
          + "the world map's markers, the dropdown's options and the ABSENCE of an error line are "
          + 'all fixed. Read as truthy, so 1 is the value. ⚠ It removes the network dependency '
          + 'entirely rather than making it fast: an unreachable third-party host does not fail '
          + 'identically twice, and the string it produces is the browser\'s. The seam is a page '
          + 'global read at mount by a main-thread Svelte component — the `__loopbackTestFrame` '
          + 'shape — and it costs no attest window, because neither the picker nor any e2e file is '
          + 'in the WebGL attest basis.',
      },
    ],
  },

  // ── VIDEOBOX — the LOCAL-FILE PLAYER, capturable for the tvLibrarian reason
  {
    type: 'videobox',
    // No `face.pages`, so the dock renders one unlabelled section holding the
    // single ranked cell (`gain`) above the player body. One control is the
    // honest count for this module.
    pages: 1,
    videoFaceWhy:
      'a VIDEO module, so it must boot into the video zone rather than a mixer channel column — '
      + 'without this field bootWithFace waits out the full test timeout for a column membership '
      + 'a video node never acquires. ⚠ AND IT IS CAPTURABLE DESPITE SITTING IN `EXEMPT_FROM_VRT` '
      + 'FOR A LIVE <video> ELEMENT, which is the tvLibrarian distinction one entry up: that '
      + 'exemption is TRUE OF THE CARD SCENE, which loads a real clip and adopts the live '
      + 'element. A FACE scene spawns the node and loads NOTHING, so `uHasInput` is 0 and the '
      + 'shader\'s idle branch runs — a pure function of position with no clock, no accumulator '
      + 'and no uniform that is not a param (pinned in videobox-face-model.test.ts). The rest of '
      + 'the surface is equally still at spawn: no fileMeta, so the seek slider is disabled at '
      + '0, the transport shows Play, no filename line exists, and the drop-hint overlay is '
      + 'static text. ⚠ NO simPin AND NO NETWORK: unlike tvLibrarian there is no runtime roster '
      + 'fetch to pin — the only asynchronous inputs this surface has are user gestures, and a '
      + 'scene performs none.',
  },

  // ── PEERTUBE — the FEDIVERSE BROWSER, capturable for the tvLibrarian reason
  //    and with a STRICTLY STRONGER argument than tvLibrarian's own
  {
    type: 'peertube',
    // No `face.pages`, so the dock renders one unlabelled section holding the
    // single ranked cell (`gain`) above the browse body. One control is the
    // honest count for this module; nothing is padded to reach a rail.
    pages: 1,
    videoFaceWhy:
      'a VIDEO module, so it must boot into the video zone rather than a mixer channel column — '
      + 'without this field bootWithFace waits out the full test timeout for a column membership '
      + 'a video node never acquires. ⚠ AND IT IS CAPTURABLE DESPITE SITTING IN `EXEMPT_FROM_VRT` '
      + 'FOR A LIVE HLS STREAM, the tvLibrarian/videobox distinction two entries up: that '
      + 'exemption is TRUE OF THE CARD SCENE, a different surface with its own baseline. A FACE '
      + 'scene spawns the node and selects NOTHING, so `uHasInput` is 0 and peertube.ts\'s idle '
      + 'branch runs — `vec4(0.05, 0.04, 0.09 + vUv.y * 0.06, 1.0)`, a pure function of position '
      + 'with no clock, no accumulator and no uniform that is not a param. Read at the shader '
      + 'rather than assumed. ⚠ NO simPin AND NO NETWORK, AND THIS IS THE PART THAT IS STRONGER '
      + 'THAN TVLIBRARIAN\'S: tvLibrarian needs `__tvLibrarianTestCountries` because its picker '
      + 'fetches a country roster AT MOUNT and paints the browser\'s own rejection message when '
      + 'the runner cannot reach famelack. peertube\'s roster is fetched only on a SEARCH — '
      + '`PEERTUBE_PROFILE.autoLoadCatalogue` is FALSE — so a fresh spawn issues ZERO network '
      + 'requests and there is nothing to pin. The rest of the surface is equally still: no '
      + 'selection, so the transport and the attribution anchor are absent entirely, the ↻ next '
      + 'button is disabled on an empty catalogue, and the empty-state overlay and the legal '
      + 'disclaimer are static text.',
  },
  // ── VIDEOVARISPEED — the VARISPEED FILE PLAYER, capturable for the same
  //    reason, RE-DERIVED rather than inherited (its card exemption names two
  //    moving things videobox's does not).
  {
    type: 'videovarispeed',
    // No `face.pages`, so the dock renders one unlabelled section holding the
    // three ranked cells (`speed`, `start`, `end`) above the transport body.
    // Three controls is not control-heavy and does not earn a tab rail.
    pages: 1,
    videoFaceWhy:
      'a VIDEO module, so it must boot into the video zone rather than a mixer channel column — '
      + 'without this field bootWithFace waits out the full test timeout for a column membership '
      + 'a video node never acquires. ⚠ AND IT IS CAPTURABLE DESPITE SITTING IN `EXEMPT_FROM_VRT`, '
      + 'but the argument is RE-DERIVED here rather than copied from videobox, because this '
      + 'module\'s exemption names TWO moving things and they fail differently. (1) "a live '
      + '<video> streamed at varispeed": a FACE scene spawns the node and loads NOTHING, so '
      + '`uHasInput` is 0 and the shader\'s idle branch runs — a pure function of position with '
      + 'no clock, no accumulator and no uniform that is not a param — and with no element there '
      + 'is no decode cadence to vary. (2) "a ticking playhead readout": that readout is DELETED '
      + 'on this surface (the card\'s `0:04 / 2:00` line), and what replaces it cannot tick '
      + 'either — the seek slider is `disabled` at 0 with no duration, and `positionSec` is 0 '
      + 'until an element has bytes. The rest is equally still at spawn: the transport shows '
      + 'Play, LOOP is on by construction (VARISPEED_DEFAULT_LOOP), the SPEED multiplier reads '
      + 'its default `+1.0×` (knob 0.5, no CV patched), no filename line exists, the crop row '
      + 'shows only "add crop", the seven bank rows all read "—", and the drop-hint overlay is '
      + 'static text. ⚠ THE START-PAST-END WARNING IS ABSENT AT SPAWN AND THAT IS DETERMINISTIC, '
      + 'not lucky: start defaults to 0 and end to 1, so `resolveWindow` returns hasWindow true '
      + 'for any duration. ⚠ NO simPin AND NO NETWORK: the only asynchronous inputs this surface '
      + 'has are user gestures and a decoded file, and a scene performs neither.',
  },
  // ── NUMPAD+ — the KEYPAD PERFORMANCE SEQUENCER ────────────────────────────
  //
  // `pages: 4` is the POST-hero band count. The declared pages are also four —
  // `numpad-cell-{n}` is the ONLY control `heroFacePlan` lifts out of a band and
  // its band (`pattern`) keeps `activeLayer`, so no band is emptied and the
  // declared count and the painted count happen to agree here. Stated rather
  // than assumed, because on cartesian they do not.
  //
  // ⚠ DETERMINISTIC FOR FREE, AND FOR EXACTLY THE REASON kria's entry gives:
  // `isPlaying` defaults to 0 (numpad-plus.ts), so a fresh spawn is STOPPED.
  // The playhead — the one live thing on this face, an engine read per frame —
  // is gated on the transport in `NumpadStepGrid.svelte` and returns -1 while
  // stopped, so it never starts and no freeze seam is needed. The REC ARM
  // indicator is gated on `armedRecording`, which the engine sets only at a
  // play-from-start edge with `recArm` already high; both default to 0.
  //
  // ⚠ AND THE KEYMAP PANEL'S ONE ANIMATION CANNOT REACH A CAPTURE. The listening
  // outline paints only while a remap is armed, which needs a click the scene
  // never performs, and the panel drops it on any pointerdown outside itself.
  //
  // ⚠ WHAT THESE BASELINES DO **NOT** COVER, stated rather than implied: grid
  // CONTENT. A fresh spawn has an empty pattern, so the 4x4 is uniformly dark
  // and a lit cell in the wrong column would not move the PNG. Seeding it would
  // need either a module special-case inside this sweep (which the sweep refuses
  // by design — that generic property is what makes every future face auto-enrol)
  // or a product-side test global, i.e. shipping code whose only reader is a
  // picture. The content is covered more precisely than a PNG could:
  // `numpadPlus-face-model.test.ts` pins the ranked plate and both probes,
  // `numpad-plus-writes.test.ts` pins what every gesture writes, and
  // `numpad-plus-face.spec.ts` drives the real grid and reads the graph back.
  { type: 'numpadPlus', pages: 4 },

  // ── TEXTMARQUEE (2026-08-31) — the roster's first DOCUMENT EDITOR ─────────
  //
  // `pages: 1` — the face declares one band (`ribbon`) holding all four knobs,
  // and nothing is lifted out of it (no hero), so the declared count and the
  // painted count agree.
  //
  // ── ⚠ THE DETERMINISM ARGUMENT, IN THE ORDER THE RISK ACTUALLY RUNS ───────
  //
  // (1) `freezeFaceVideo` IS A NO-OP HERE, like bentbox and warrensvisions. It
  //     writes `params.freeze = 1`; this def declares `scrollX`, `scrollY`,
  //     `posX`, `posY` and nothing else, and the factory's `setParam` guard is
  //     `if (paramId in params)`, so the write lands nowhere. ⚠ Do NOT "fix"
  //     that by adding a `freeze` param — that is a `params` edit on a def
  //     inside the WebGL attest basis, i.e. an owner-machine re-attest, to buy
  //     an assertion that already holds for the reason below.
  //
  // (2) THE PICTURE HAS NO TIME TERM AT REST, EXACTLY. `surface.draw` calls
  //     `computeDrawOffset`, which adds `scrollOffset(scrollX, frame.time, …)`
  //     to a pure `posToDrawX/Y`. `scrollOffset` opens with
  //     `vel = (clamp01(speedKnob) - 0.5) * 2 * MAX_SCREENS_PER_SEC * span`
  //     and then `if (vel === 0) return 0`. `TEXTMARQUEE_DEFAULTS.scrollX` and
  //     `.scrollY` are both 0.5, and `0.5 - 0.5 === 0` is exact in IEEE-754, so
  //     the early return fires and `frame.time` reaches nothing. `bootWithFace`
  //     spawns ONE node with nothing patched and no CV, so both scenes are a
  //     STATIC ribbon by construction, not by a flag.
  //
  // (3) ⚠ THE REMAINING RISK IS GLYPH RASTERIZATION, AND IT IS NAMED RATHER
  //     THAN ARGUED AWAY. With no card mounted and an empty model, the
  //     `extras-producers` rasterizer clears the texture and the FACTORY's own
  //     placeholder shows: `64px sans-serif`, the word "textmarquee", painted
  //     into an OffscreenCanvas and uploaded as a GL texture. That is
  //     system-font glyphs inside a texture — the class
  //     `vrt-exemptions.ts`'s textmarquee block already names for this module's
  //     CARD scene, where the canvas is MASKED. This file applies no masks, so
  //     here it is compared.
  //
  //     The argument that it holds: `snapshotPathTemplate` carries no
  //     `{platform}` segment, so there is ONE baseline set, authored on Linux
  //     CI and compared on Linux CI. The old exemption's wording — "rasterize
  //     differently ACROSS PLATFORMS" — is a cross-platform claim about a
  //     one-platform pin, and same-image/same-Chromium/same-fontconfig glyph
  //     rasterization is deterministic. The card scene is the partial evidence:
  //     its toolbar, swatches, `<select>` and knob rows have been pinned and
  //     green for this module's whole life; the canvas is the only thing it
  //     never compared.
  //
  //     ⚠ THAT ARGUMENT IS NOT THE MEASUREMENT, AND MUST NOT BE READ AS ONE.
  //     The measurement is two independent Linux boots: `vrt:commit` captures
  //     the baselines on the runner, and this PR's own `vrt-strict` shard then
  //     re-boots and compares against them. If that comparison shows ANY
  //     differing pixels in the preview well, the honest outcome is to move
  //     this module to `FACES_WITHOUT_SCENES` below CARRYING THAT NUMBER — not
  //     a mask, and not a re-run.
  {
    type: 'textmarquee',
    pages: 1,
    videoFaceWhy:
      'a VIDEO module, so it must boot into the video zone rather than a mixer channel column — '
      + 'without this field bootWithFace waits out the full 90 s test timeout for a column '
      + 'membership a video node never acquires. Both scenes also carry a live picture: the '
      + 'compact tile paints a VideoTileThumb through hasVideoSurface (textmarquee\'s FIRST lane '
      + 'picture — the card only ever painted its preview inside itself), and the dock body is '
      + "the module's own fullViewBody extension: the rich-text editor, its toolbar, the layer "
      + 'background swatch, the OUT preview and the SCREEN switch. The freeze write itself is a '
      + 'NO-OP on this def — it declares no `freeze` param — and that is deliberate rather than '
      + 'an omission: with scrollX/scrollY at their 0.5 defaults `scrollOffset` returns on '
      + '`vel === 0` before `frame.time` is used at all, so the ribbon is placed by posX/posY '
      + 'alone and both scenes are identical frame to frame by construction. What the picture '
      + 'shows at rest is the FACTORY placeholder (the word "textmarquee" in 64px sans-serif), '
      + 'because an empty model makes the node-lifetime rasterizer clear the texture rather than '
      + 'push a black layer.',
  },


  // ── JOYSTICK (2026-09-01, face-program wave 3) — the two-ordinary-cells
  // fallback (owner decision 2026-08-31 item 2) ─────────────────────────────
  //
  // `pages: 1` — the face declares no `pages`, so the dock renders the one
  // unlabeled `__all` band: two bipolar knob cells (X, Y) BENEATH the
  // `fullViewBody` pad. Both scenes are deterministic at rest with no seam of
  // any kind: `domain: 'audio'`, no canvas anywhere on the surface, and both
  // axes default to 0, so the dot sits at the crosshair centre on every boot
  // (`joystick-persist-model.test.ts` pins the defaults). Nothing animates —
  // the only writers are a pointer gesture, a knob cell, MIDI learn or a
  // collab peer, none of which occur in a solo capture.
  //
  // ⚠ THE DOCK SCENE DELIBERATELY PHOTOGRAPHS THE REDUNDANCY: pad above, two
  // knobs below, per the owner decision — so a later "cleanup" that quietly
  // drops either surface moves this baseline and gets a review.
  { type: 'joystick', pages: 1 },

  // ── MAPPY (2026-09-01, wave 4) — the PROJECTION MAPPER ────────────────────
  //
  // `pages: 2` — the face declares two bands (`surfaces`, `map`) and nothing is
  // lifted out of either (no hero; the `fullViewBody` takes the dock head via
  // `dockFullViewHeadPlan`), so the declared count and the painted count agree.
  // Two is far below `DOCK_TAB_MIN_BANDS`, so this is a sectioned faceplate and
  // not a tab rail.
  //
  // ── ⚠ THE DETERMINISM ARGUMENT, AND IT IS UNUSUALLY STRONG ────────────────
  //
  // A face scene spawns the node and patches NOTHING, and an unpatched mappy is
  // the module's own designed idle state rather than a blank: `draw()` skips
  // every surface that is neither within the count nor fed, so a fresh spawn
  // composites exactly ONE surface, and with no input texture `drawGrid` is
  // forced true — the picture is surface 0's NUMBERED CALIBRATION GRID.
  //
  // That grid is a pure function of the surface uv: an 8x8 checker, grid lines,
  // a border, cross-hairs and a seven-segment `1`, every term derived from `s`
  // and the constant surface index. `mappy.ts` states it — "Deterministic — no
  // time dependence" — and the shader is the evidence: `calibrationGrid` reads
  // no clock, no accumulator, no uniform that is not a param, and the module
  // declares no CV inputs at all, so nothing can move it between two boots.
  //
  // ⚠ NO `simPin` AND NO `freezeIsNotASeam`. There is nothing to pin: the
  // module has no RNG, no ring, no feedback FBO and no wall-clock term. And
  // `freezeFaceVideo` writes `params.freeze = 1`, which this def has no param
  // for, so the write lands nowhere — the same no-op textmarquee records.
  //
  // ⚠ THE OVERLAY IS DETERMINISTIC TOO, and it is what actually fills the
  // frame: four corner handles on the full-frame UNIT_QUAD plus the quad
  // outline, positioned from `node.data.surfaces` which `normalizeSurfaces`
  // fills with the same defaults on every boot. `selected` is component state
  // initialised to 0, so surface 1 is focused (thick stroke, r=8 handles) in
  // every capture.
  //
  // ⚠ AND THIS MODULE'S `EXEMPT_FROM_VRT` ENTRY IS NOW NARROWED TO THE LEGACY
  // CARD, whose old `why` claimed "nothing patched is non-deterministic chrome
  // over a black preview". That was false about the CARD too — an unpatched
  // mappy paints a numbered grid, not black — and the exemption's real ask, a
  // deterministic composite baseline, is what these two scenes are.
  { type: 'mappy', pages: 2, videoFaceWhy:
      'a VIDEO module, so it must boot into the video zone rather than a mixer channel column — '
      + 'without this field bootWithFace waits out the full test timeout for a column membership '
      + 'a video node never acquires. ⚠ AND IT IS CAPTURABLE DESPITE ITS OLD `EXEMPT_FROM_VRT` '
      + 'ENTRY, which is narrowed to the legacy card in this same diff: the exemption said '
      + '"nothing patched is non-deterministic chrome over a black preview", and an unpatched '
      + 'mappy paints its NUMBERED CALIBRATION GRID — a pure function of the surface uv with no '
      + 'clock, no accumulator and no uniform that is not a param (the def says so in as many '
      + 'words, and the module declares no CV inputs at all). The corner-pin overlay over it is '
      + 'equally still: four handles on the full-frame UNIT_QUAD from `normalizeSurfaces`\''
      + ' defaults, with surface 1 focused on every boot.',
  },

] as const;

/**
 * A FACED module whose renderer CANNOT be pixel-baselined, and therefore has no
 * entry in `FACES` above.
 *
 * ⚠ WHY THIS EXISTS AT ALL, since a roster exemption is exactly the shape this
 * repo is usually suspicious of. `workflow-shell-faces.spec.ts` asserts SET
 * EQUALITY between `STRICT_FACES` and `FACES` in both directions, so before this
 * list a module could be promoted only if two pixel-stable scenes could be
 * captured for it. For a genuinely non-deterministic renderer that is not a bar
 * to clear, it is a permanent refusal — the module can hold a legacy card
 * forever and never reach the faceplate, regardless of how cleanly its controls
 * map.
 *
 * ⚠ AND THE CARD ROSTER ALREADY HAS THIS CONCEPT, for the same module, with a
 * written argument. `e2e/vrt/vrt-exemptions.ts` carries milkdrop in
 * `EXEMPT_FROM_VRT` because a "continuously-animating multi-pass butterchurn
 * visualizer (chaotic/time-based) defeats deterministic single-frame capture".
 * So this is not new policy; it is the FACE roster catching up to a judgement
 * the CARD roster made long ago about the very same renderer.
 *
 * ⚠ WHAT THIS EXEMPTION COSTS, stated plainly because a reader must not have to
 * infer it: the face's PIXELS GO UNVERIFIED. Nothing in any lane compares what
 * the faceplate looks like, at either tier, so a layout regression on an exempt
 * face is invisible to VRT and will be caught only by a human looking. That is
 * the price, and it is why the type demands `coveredBy` — the non-pixel gates
 * that DO cover the face have to be named, and are asserted to exist.
 *
 * ⚠ IT IS ANCHORED FOUR WAYS (see the gate in `workflow-shell-faces.spec.ts`), so
 * it cannot outlive its justification: the entry must name a module that is
 * still FACED, that is still ABSENT from `FACES`, that has NO committed
 * baselines on disk, and whose def declares NO determinism seam. Any one of
 * those changing means somebody made the face capturable — at which point the
 * exemption is a lie rather than a permission, and says so.
 */
export interface UnbaselinableFace {
  /** The module type. Must be in `STRICT_FACES` and absent from `FACES`. */
  readonly type: string;
  /** Which scenes cannot be captured. Both, for every case seen so far. */
  readonly scenes: readonly ('compact' | 'dock')[];
  /**
   * Why this renderer cannot be baselined — an ARGUMENT WITH THE MEASUREMENT IN
   * IT, not a label. "It's animated" is not sufficient: `mirrorpool`,
   * `outlines`, `warrensvisions` and `freezeframe` are all animated and all
   * baselined, via `simPin` or a `freeze` param. The bar is evidence that those
   * mechanisms cannot reach this renderer.
   */
  readonly why: string;
  /**
   * The gates that DO cover this face, since VRT does not. Every entry is a
   * repo-relative path and is asserted to EXIST — a `coveredBy` naming a
   * deleted spec is the exemption quietly becoming uncovered.
   */
  readonly coveredBy: readonly string[];
  /**
   * REQUIRED when the module's def declares a `freeze` param — and forbidden
   * when it does not.
   *
   * ⚠ THIS FIELD EXISTS BECAUSE A GATE'S PRECONDITION TURNED OUT TO BE FALSE.
   * The anchor's fourth leg reads the def's source for `id: 'freeze'` and
   * treats a hit as proof that a determinism seam appeared — because on every
   * def that had one until now, that is exactly what `freeze` was: a hidden
   * param the VRT harness writes to stop the picture, declared
   * `noUserControl`, given no cell.
   *
   * `acidwarp` is the first counter-example. It declares `freeze` and that
   * param is a REAL, DOCUMENTED USER CONTROL with a different meaning — it
   * halts only the automatic scene cycler while the palette goes on rotating,
   * so writing it does NOT stop the picture. Under the old blanket rule that
   * module could never hold an exemption, however true its argument was.
   *
   * The fix is not to soften the leg — it is to make the claim SAYABLE and
   * then check it. Deny-by-default survives: a def with `freeze` and no entry
   * here is still RED (the original behaviour), and an entry here whose def has
   * NO `freeze` param is ALSO red, so the field cannot outlive what it
   * describes.
   *
   * State what the param DOES instead, and cite the read site — "it is not a
   * seam" without a mechanism is the shrug this whole file refuses.
   */
  readonly freezeIsNotASeam?: string;
}

export const FACES_WITHOUT_SCENES: readonly UnbaselinableFace[] = [
  {
    type: 'acidwarp',
    scenes: ['compact', 'dock'],
    why:
      'BOTH of this suite\'s determinism mechanisms fail on this module, for two DIFFERENT and '
      + 'independently verifiable reasons — which is the bar, since "it is animated" is not '
      + 'sufficient (mirrorpool, outlines, warrensvisions and freezeframe are all animated and '
      + 'all baselined). '
      + '(1) `freezeFaceVideo` CANNOT STOP THIS PICTURE, AND THE MODULE SAYS SO IN ITS OWN '
      + 'COMMENT. It freezes a video face by writing `params.freeze = 1`. On every other faced '
      + 'video module `freeze` is a determinism hook; on acidwarp it is a REAL, DOCUMENTED USER '
      + 'CONTROL that halts ONLY the automatic scene cycler. Read at the site: the freeze test '
      + 'guards exactly one branch (`if (params.freeze < 0.5 && speed > 0)`, the scene advance), '
      + 'while the palette accumulator sits OUTSIDE it — `paletteAccumSlots += dt * '
      + 'PALETTE_ROT_PER_SEC * speed`, under the comment "Palette keeps rotating even while '
      + 'frozen — the visual life of the patch comes from the cycling colours". The picture is a '
      + '256-slot palette scrolling under a static index field, so with freeze engaged every '
      + 'frame still differs. '
      + '(2) `simPin` CANNOT REACH THIS MODULE AT ALL, and this half is structural rather than '
      + 'behavioural. It installs boot-time globals with `addInitScript` so a factory can read '
      + 'them AT CONSTRUCTION — but `acidwarpDef.renderLocus` is `\'worker\'`, so the factory '
      + 'runs in a Worker with its OWN global scope which does not inherit the page\'s. Params '
      + 'reach it over the proxy\'s RPC channel; page globals never do. So there is no pin to '
      + 'add here short of inventing a second RPC seam for tests. '
      + '⚠ THE MODULE DOES HAVE A NATURAL STILL — `speed = 0` zeroes the accumulator above, and '
      + 'with freeze also on the frame is a pure function of (scene, paletteType). It is NOT '
      + 'used, deliberately: the harness has no param-pin option (`simPin` is globals only), and '
      + 'writing speed=0 post-boot would hold A frame without choosing WHICH — whatever rotation '
      + 'accumulated before the write — the same "holds a frame, never which frame" defect that '
      + 'put milkdrop on this list. Reaching it properly means a param-pin mechanism in '
      + '`bootWithFace`, which is a platform change and not a face PR. '
      + 'The CARD roster reached the same verdict long ago (EXEMPT_FROM_VRT in '
      + 'vrt-exemptions.ts: "animated palette rotation + auto scene cycler defeats deterministic '
      + 'capture"). See #2111.',
    coveredBy: [
      // The renderer itself — that it draws at all, structured and non-black.
      'e2e/tests/acidwarp-render-smoke.spec.ts',
      // The worker path specifically, which is how this module renders.
      'e2e/tests/render-worker-acidwarp.spec.ts',
      // The pattern + palette math, pixel-free: generatePattern, buildPalette,
      // rotatePalette — and the palette ROSTER this face promoted onto the def.
      'packages/web/src/lib/video/modules/acidwarp.test.ts',
      // The FACE's structure and behaviour, none of which needs pixels: the
      // tier ladder, the two bands, the roster, the landmarks, and the
      // no-user-control declaration.
      'packages/web/src/lib/ui/modules/acidwarp-face-model.test.ts',
      // The SCREEN switch's render legs — that the picture mounts, that OFF
      // unmounts it and keeps the generator running, and that the state
      // persists on node.data.
      'e2e/tests/acidwarp-face-screen.spec.ts',
      // Every cell operates, and the dock's control set equals the def's param
      // set — the registry-driven sweep this face auto-enrols in.
      'e2e/tests/faces-parity.spec.ts',
    ],
    freezeIsNotASeam:
      'acidwarp\'s `freeze` is a SHIPPED USER CONTROL, not a capture hook, and it is the first '
      + 'in the fleet to be so — which is why this field exists at all. Read at the site: the '
      + 'param guards exactly ONE branch of `draw()`, `if (params.freeze < 0.5 && speed > 0)`, '
      + 'which advances the automatic SCENE cycler. The palette accumulator sits OUTSIDE that '
      + 'branch — `paletteAccumSlots += dt * PALETTE_ROT_PER_SEC * speed` — under the module\'s '
      + 'own comment "Palette keeps rotating even while frozen — the visual life of the patch '
      + 'comes from the cycling colours, not the pattern changes". Since the picture IS a '
      + 'palette scrolling under a static index field, writing freeze=1 changes which pattern '
      + 'you are looking at and nothing about whether it moves. MEASURED IN A BROWSER, not '
      + 'merely read: `acidwarp-face-screen.spec.ts`\'s third leg writes exactly this param — '
      + 'the same write `freezeFaceVideo` makes — and asserts the canvas signature CHANGES '
      + 'across 30 frames, on a real GPU and under E2E_SWIFTSHADER=1 alike. ⚠ That leg is '
      + 'written to fail if the picture ever DOES stop, with a message saying this exemption has '
      + 'gone stale and the face should move into the FACES roster — so the claim retires itself '
      + 'rather than being renewed by default.',
  },
  {
    type: 'milkdrop',
    scenes: ['compact', 'dock'],
    why:
      'butterchurn is not pixel-deterministic, and the two mechanisms this suite uses to make an '
      + 'animated renderer capturable both fail on it. MEASURED with the render-smoke harness '
      + '(`installRenderSmokeHooks` pauses the engine rAF loop and steps an exact frame count), '
      + "with milkdrop's own seams pinned exactly as milkdrop-render-smoke.spec.ts pins them "
      + '(__milkdropFixedDelta = 0.05, __milkdropTestAudio = true, both via addInitScript before '
      + 'goto). (1) FRAME-COUNT DEPENDENT: mean 41.69 / variance 1478.8 at 16 steps, versus mean '
      + '59.61 / variance 4737.7 eight steps later — so freezeFaceVideo holding the LAST DRAWN '
      + 'frame holds A frame, never WHICH frame, and the frame it lands on differs per renderer '
      + 'and per load. (2) NOT DETERMINISTIC ACROSS BOOTS EVEN AT AN IDENTICAL FRAME COUNT: with '
      + 'framesDelta 16 on both boots (printed as the instrument control, because "nondeterministic" '
      + 'and "the boots rendered different frame counts" look identical from a mean alone and need '
      + 'opposite fixes), boot 1 read mean 41.690592 and boot 2 mean 42.132087; boot 1 itself moved '
      + 'between two runs of the probe (40.8827 -> 41.6906), so it is not a one-off. simPin cannot '
      + "close either: it pins a CLOCK, and neither butterchurn's per-frame feedback accumulation "
      + '(a Milkdrop warp mesh samples the previous frame — intrinsic to the format) nor the RNG '
      + 'behind the cross-boot drift lives in our code. Seeding it would mean patching butterchurn, '
      + 'which project_milkdrop_module forbids vendoring under lib/video/ precisely because that '
      + 'whole tree is hashed into the WebGL attest basis. The CARD roster reached the same verdict '
      + 'about this renderer long ago (EXEMPT_FROM_VRT in vrt-exemptions.ts). See #2083.',
    coveredBy: [
      // The renderer itself: freeze + fixed delta + synthetic audio, asserting
      // non-black / structured / zero GL errors. It cannot pin PIXELS, but it is
      // what proves the engine still renders at all.
      'e2e/tests/milkdrop-render-smoke.spec.ts',
      // The FACE's structure and behaviour, none of which needs pixels:
      // every param renders exactly one operable cell, and the dock control set
      // equals the def's param set.
      'e2e/tests/faces-parity.spec.ts',
      // MONITOR MODE actually moving the bands, plus the SCREEN switch.
      'e2e/tests/video-hide-controls.spec.ts',
      // The face model: order/pages/hero/paramCells/rear + the module-local pins.
      'packages/web/src/lib/ui/workflow/module-face-lint.test.ts',
      'packages/web/src/lib/ui/modules/milkdrop-face-model.test.ts',
    ],
  },
  {
    type: 'skifree',
    scenes: ['compact', 'dock'],
    why:
      'THE RENDERER IS NOT OURS, AND THAT IS THE MEASUREMENT RATHER THAN A LABEL. skifree\'s '
      + 'pixels are produced by `/skifree/skifree.bundle.js` — a COMMITTED PRE-BUILT esbuild IIFE '
      + 'of `packages/web/native/skifree/embed.js` plus the upstream skifree.js classes — which '
      + 'boots its own `requestAnimationFrame` loop the moment it loads and draws terrain, '
      + 'snowboarders, the yeti and the skier\'s animation cycle from its own `Math.random()`. '
      + 'There is no naturally still frame at any point after load. '
      + '(1) `simPin` CANNOT REACH IT, and this half is structural rather than behavioural. '
      + 'simPin installs boot-time globals with `addInitScript` so a FACTORY can read them at '
      + 'construction; the seed and the clock that would have to be pinned are inside the '
      + 'bundle\'s closure, and the controller it hands back exposes exactly `setCursor`, '
      + '`enableMouse`, `disableMouse`, `reset`, `dispose`, `getState`, `_forceCrash` and '
      + '`_forceEaten` — no freeze, no seed, no tick. Reaching one means editing the vendored '
      + 'source and re-running the bundle recipe (packages/web/native/skifree/README.md), and '
      + '`scripts/lint/lint-policy.mjs` names skifree in its exclusions precisely because that '
      + 'code is not this repo\'s to change casually. That is a fork-and-maintain decision, not a '
      + 'face PR. '
      + '(2) A `freeze` PARAM IS NOT THE ROUTE EITHER, and it is refused rather than merely '
      + 'unused: skifree declares `params: []` and its contract-lock rows are meta + two CV in + '
      + 'gate/video out with ZERO param rows, so adding one is a real contract change plus a '
      + 'docs:accept — bought for a WEAKER guarantee, since a freeze written post-boot holds A '
      + 'frame and never WHICH frame (the defect that put milkdrop on this list). '
      + '⚠ The CARD roster reached this verdict long ago and states the same exit condition — '
      + 'EXEMPT_FROM_VRT in vrt-exemptions.ts: "animated ski-slope (rAF-self-driven terrain + '
      + 'sprites + skier anim) defeats deterministic single-frame capture". This entry is the '
      + 'FACE roster catching up to it about the very same renderer, and the card exemption stays '
      + 'standing rather than being discharged by a promotion that changed nothing about the '
      + 'bundle.',
    coveredBy: [
      // The FACE's structure, and the ONLY thing in CI that can see the lane
      // tile at all: #1974's zero-lane clause `continue`s past an `order: []`
      // face before it measures anything, so this file pins the `tileBody`'s
      // EXISTENCE, the forced glyph, and the source-order rule that keeps the
      // cursor write above the previewCollapsed branch.
      'packages/web/src/lib/ui/modules/skifree-face-model.test.ts',
      // The DEFAULT-SHELL browser legs: steering THROUGH the face until
      // `snapshot.distance` climbs (the positive control for the #2192 rect
      // bug), the lane tile painting with nothing expanded, and SCREEN OFF
      // leaving the gate firing.
      'e2e/tests/skifree-face.spec.ts',
      // The game belongs to the NODE — the default-shell lifetime legs, whose
      // lane-tile locator this promotion re-points from the placeholder to the
      // faced tile.
      'e2e/tests/skifree-node-lifetime.spec.ts',
      // The engine contract, pixel-free: crash/eaten -> gate -> SCOPE, and the
      // CV-overrides-mouse flip.
      'e2e/tests/skifree.spec.ts',
      // Both coordinate maps — the CV path and the POINTER path — including the
      // zero-rect branch that is the whole of the steering defect.
      'packages/web/src/lib/audio/modules/skifree.test.ts',
    ],
    // ⚠ NO `freezeIsNotASeam`, and its ABSENCE is required rather than
    // incidental: the anchor's inverse leg reddens a declaration whose def has
    // no `freeze` param, and skifree declares `params: []`. (Its `declaresFreeze`
    // probe reads `lib/video/modules/<type>.ts`, which does not exist for an
    // audio def either — so the field would be dead twice over.)
  },
  {
    type: 'blood',
    scenes: ['compact', 'dock'],
    why:
      'a LIVE BUILD-ENGINE GAME LOOP inside a 5.9 MB ASYNCIFY WASM module, and both of this '
      + "suite's determinism mechanisms fail on it for reasons that are structural rather than "
      + 'merely "it animates" — which is not sufficient here any more than it was for acidwarp, '
      + 'since mirrorpool, outlines, warrensvisions and freezeframe all animate and are all '
      + 'baselined. '
      + '(1) `freezeFaceVideo` HAS NOTHING TO WRITE. It freezes a video face by setting '
      + '`params.freeze = 1`, and `bloodDef.params` is `audioGain`, `fillMode` and thirteen '
      + '`cv_*` gate targets — there is no `freeze` param on this def and never has been, so the '
      + 'write lands on a key the factory\'s `if (paramId in params)` guard rejects and is a '
      + 'NO-OP. (That is also why this entry carries no `freezeIsNotASeam`: the gate forbids the '
      + 'field on a def with no `freeze` param, and rightly — there is no param to make an '
      + 'argument about.) '
      + '(2) `simPin` CANNOT REACH THE CLOCK, and the clock is the whole problem. The picture '
      + "advances from Build's `totalclock`, which the emscripten shim drives from "
      + '`clock_gettime(CLOCK_MONOTONIC)` INSIDE THE WASM MODULE — wall-clock, read in C, with no '
      + 'page-global anywhere on the path. `simPin` installs boot-time globals with '
      + '`addInitScript` for a JS factory to read at construction; nothing in this module reads a '
      + 'global, so there is no pin to add short of a new seam through the WASM boundary. '
      + '⚠ AND THE MENU ANIMATES BY DESIGN, WHICH IS THE MEASUREMENT. That is not incidental — it '
      + 'is a FIXED BUG, recorded in PHASE1-STATUS.md §3: `CLOCK_MONOTONIC_RAW` is unsupported on '
      + 'emscripten, `totalclock` never advanced, and the idle menu was FROZEN. '
      + '`blood-mount.spec.ts` asserts in a real browser that successive framebuffer hashes '
      + 'DIFFER with no input at all, and its failure message says the engine clock is dead. So '
      + 'this module has a live, committed, running gate asserting exactly the property that '
      + 'makes it uncapturable — a face baseline here would be pinning a bug. '
      + '⚠ THE NATURAL STILL DOES NOT EXIST EITHER, unlike acidwarp (speed = 0) or milkdrop (a '
      + 'fixed delta): every state the picture could be held in is a function of how many wall-'
      + 'clock ticks elapsed between boot and capture, on a runner whose WASM cold-boot is '
      + 'measured at 20-25 s and varies with shard load. '
      + 'The CARD roster reached the same verdict about this renderer long ago (EXEMPT_FROM_VRT '
      + 'in vrt-exemptions.ts, whose `why` this PR rewrites to cover the legacy card only).',
    coveredBy: [
      // The engine itself, in a real browser: it boots out-of-box from the
      // bundled shareware, the drip border is lit (the ART alias), and the idle
      // menu ANIMATES — the clock regression that is also this exemption's
      // measurement.
      'e2e/tests/blood-mount.spec.ts',
      // The whole chain from a menu key to audible PCM at a downstream SCOPE —
      // re-pointed onto the DEFAULT shell in this PR, so it is the leg that
      // proves the FACE boots the engine rather than the legacy card.
      'e2e/tests/blood-audio-output.spec.ts',
      // Driving the menu into a level and reading the in-game framebuffer.
      'e2e/tests/blood-ingame.spec.ts',
      // The SCREEN switch's render legs — that the body mounts and paints, that
      // OFF unmounts the canvas and the ENGINE KEEPS RUNNING, that the state
      // persists on node.data, and that the keyboard host reaches the runtime.
      'e2e/tests/blood-face-screen.spec.ts',
      // Every cell operates, and the dock's control set equals the def's param
      // set — the registry-driven sweep this face auto-enrols in.
      'e2e/tests/faces-parity.spec.ts',
      // The FACE's structure, none of which needs pixels: the two ranked
      // controls, the one band, the glyph refusal, the thirteen
      // no-user-control declarations and the shared boot seam's contract.
      'packages/web/src/lib/ui/modules/blood-face-model.test.ts',
      // The boot seam itself, pure: what each surface must call, and in which
      // order the picker path resets a latched failure.
      'packages/web/src/lib/blood/blood-boot.test.ts',
      // The TS shim and the CV-gate scancode map.
      'packages/web/src/lib/blood/blood-runtime.test.ts',
      'packages/web/src/lib/blood/blood-keys.test.ts',
    ],
  },

];

/**
 * Every module type the FACE ROSTER ACCOUNTS FOR — by a captured scene, or by a
 * named `FACES_WITHOUT_SCENES` exemption.
 *
 * ⚠ THIS EXISTS BECAUSE **TWO** GATES ASSERT THE SAME RELATIONSHIP, and adding
 * the exemption to only one of them shipped a red. `workflow-shell-faces.spec.ts`
 * ("every shipped face has a scene") and `vrt-meta.test.ts` ("the FACES roster
 * is EXACTLY the promoted set") both answer *is every promoted face accounted
 * for?* — independently, off the same `FACES` array. Teaching one about the
 * exemption left the other asserting the pre-exemption invariant, so `milkdrop`
 * came back as PROMOTED BUT NOT ROSTERED from a gate that had never heard of
 * `FACES_WITHOUT_SCENES`.
 *
 * ⚠ THE FIX IS ONE SOURCE FOR THE RELATIONSHIP, NOT A SECOND COPY OF THE
 * SUBTRACTION. Each gate computing `promoted − FACES − exemptions` for itself is
 * the drift machine: the next mechanism that changes what "accounted for" means
 * has to find every copy, which is exactly the search that failed here. Both
 * gates now read THIS set, so the relationship is defined once.
 *
 * THE LESSON, recorded where the next author of a roster mechanism will meet it:
 * a platform change must find every gate asserting the invariant it changes —
 * grep for the INVARIANT (`STRICT_FACES` alongside `FACES`), not for the
 * filename you happen to be editing.
 */
export const ROSTERED_FACE_TYPES: ReadonlySet<string> = new Set<string>([
  ...FACES.map((f) => f.type),
  ...FACES_WITHOUT_SCENES.map((e) => e.type),
]);

/** The exempt subset alone — for a gate that must WORD its message differently
 *  for a face that has no scene BY DESIGN rather than by omission. */
export const EXEMPT_FACE_TYPES: ReadonlySet<string> = new Set<string>(
  FACES_WITHOUT_SCENES.map((e) => e.type),
);

/** Per-scene diff budgets (absolute pixels; Playwright takes the MIN of this and
 *  the config ratio budget — `comparators.js` computes both and calls
 *  `Math.min`, and it tests `!== undefined`, so ZERO is honoured rather than
 *  falling through to a default).
 *
 *  ⚠⚠ BOTH ARE ZERO AS OF 2026-08-25, BY OWNER RULING: *"VRTs are useless if
 *  they can't be pixel perfect every time … i would never have consciously
 *  allowed even a 1px tolerance"*. A face scene now fails on ONE differing
 *  pixel. `count > maxDiffPixels` with `maxDiffPixels = 0` is exactly that.
 *
 *  THE MEASUREMENT THAT MADE IT SAFE, and it is a measurement rather than a
 *  hope: every face scene in this roster, both tiers, was booted TWICE on
 *  ubuntu CI through this file's own scene code and the two captures diffed at
 *  threshold 1/255 (`vrt-determinism-probe.spec.ts`, which carries a negative
 *  AND a positive control on every row, and a storage-wipe control to rule out
 *  a pair matching by inheriting state). All but THREE rows were BIT-EXACT.
 *  The three, and what happened to them:
 *
 *      face-spirographs-dock      2711 px  maxCh 243  — OVER the old 1500 budget
 *                                                       already; a live latent
 *                                                       flake, now clock-pinned
 *      face-pong-dock               72 px  maxCh 237  — the ball; court now pinned
 *      face-spirographs-compact     25 px  maxCh 120  — same cause as the dock row
 *
 *  So the budgets were not absorbing renderer physics. They were absorbing two
 *  unpinned simulations, and both are fixed in the same diff as this line.
 *
 *  ⚠ THE OLD COMMENT SAID `COMPACT_MAX_DIFF` WAS "CURRENTLY INERT" AND THAT IS
 *  NO LONGER TRUE — worth stating because "inert" is the kind of claim that
 *  survives the change that ends it. It was inert because a compact tile is
 *  88×82 = 7216 px and the config's `maxDiffPixelRatio: 0.01` allowed 72 px,
 *  which was tighter than 150. That ratio is now 0 as well, so the two terms are
 *  EQUAL rather than one shadowing the other, and `Math.min(0, 0) = 0` binds
 *  from both directions. Neither is decorative any more.
 *
 *  ⚠ AND A LOCAL macOS RUN WILL NOW FAIL, by design and not by defect. The same
 *  audit measured `dx7-dock` (17 px), `mirrorpool-compact` (8 px),
 *  `moog903a-compact` (4 px) and `scaler-compact` (4 px) on darwin, all at
 *  maxDelta 1-2 and all ZERO at the gate's old 26/255 — last-significant-bit
 *  text shimmer that does NOT reproduce on linux. Linux CI is and always was the
 *  authority (`snapshotPathTemplate` has no `{platform}` segment; there is ONE
 *  baseline set and the capture job authors it). There is deliberately NO
 *  platform carve-out: that would be a new exemption mechanism, and the fix for
 *  a Mac loop is `task vrt:docker`. */
export const COMPACT_MAX_DIFF = 0;
export const DOCK_MAX_DIFF = 0;

// ── THE PER-SCENE TIME BUDGET ───────────────────────────────────────────────
//
// `vrt.config.ts` sets ONE per-test `timeout: 90_000` for every test in the VRT
// lane, and its own header says "Do NOT 'fix' a slow scene by raising this
// further. Past ~90 s the answer is that the scene is not converging, which is a
// determinism finding."
//
// ⚠ THAT SENTENCE CONFLATES TWO DIFFERENT BUDGETS, and separating them is what
// this mechanism is (#1949). Convergence is bounded by `expect.timeout`
// (30_000), which caps the `toHaveScreenshot` retry loop — the
// screenshot-until-two-consecutive-captures-agree loop. A scene that never
// settles fails THERE, with the px ladder ("Failed to take two consecutive
// stable screenshots", `4082 / 3954 / 3936 px`), and it does so at 30 s no
// matter what the outer cap says. The outer per-test cap bounds everything else
// — page load, font decode, spawnPatch, the freeze retries, the height-settle
// loop, the companion diffs — i.e. SCENE WEIGHT. Raising the outer bound
// therefore cannot buy a non-converging scene a pass: the determinism gate is a
// different number and it is NOT moved here.
//
// MEASURED, and it is what falsifies the config's stated diagnosis for one face.
// Capture run 32288252788 (ubuntu-latest, SwiftShader), b3ntb0x:
//
//   face-b3ntb0x-compact   55.6 s   ✓ passed, snapshot written
//   face-b3ntb0x-dock      ~88.6 s to the snapshot WRITE, killed at the 90 s cap
//                          1.4 s later
//
// Both scenes CONVERGED and both wrote their actual PNG. Neither tripped
// `expect.timeout`. So this is not a determinism finding — it is one module that
// costs 2.6x the next-heaviest scene in the roster.
//
// THE POPULATION IT IS SIZED AGAINST — every face scene of the full sweep in
// capture run 32286329756 (ubuntu-latest, SwiftShader, 67 faces x 2 scenes):
//
//   class                       compact          dock
//   no live video surface       7.0 - 7.7 s      9.0 - 10.4 s
//   declares videoFaceWhy      13.2 - 21.3 s    19.5 - 36.7 s
//     (spirographs, outlines, videoOut, backdraft, freezeframe)
//
// So 90 s is 8.6x the heaviest non-video scene and 2.45x the heaviest video one.
// It is a comfortable bound for EVERY face in the roster and it is not moved.
// What this adds is a per-face escape hatch above it, for the one shape the flat
// number cannot express: a scene whose own measured cost is already near the
// cap.
//
// ⚠ DENY BY DEFAULT, AND THE WHY IS IN THE TYPE. A face gets a bigger bound only
// by declaring `sceneWeight` with the two measured durations, the capture run
// they were read off, and what makes the module expensive — `tsc` refuses a
// partial declaration, so the undeclared form cannot appear. The BOUND is then
// DERIVED from the measurement (`measured x FACE_SCENE_HEADROOM`) rather than
// typed, so re-measuring updates the numbers and the budget follows.
//
// ⚠ WHAT THIS DOES NOT DO: it changes no assertion, no tolerance, no viewport
// and no baseline. `expect.timeout`, `COMPACT_MAX_DIFF`, `DOCK_MAX_DIFF` and the
// config's `threshold` / `maxDiffPixelRatio` are all untouched.
//
// CI WALL-TIME: zero on green. A timeout is a cap, not a sleep — only a test
// that is ALREADY failing runs to it. The cost of a declared weight is paid on
// the FAILING path only, and it is `budget - 90 s` for that one scene.

/**
 * The per-test bound every face scene gets, ms. MUST equal `vrt.config.ts`'s
 * `timeout` — anchored by `vrt-config-budget.test.ts`, so the two cannot drift.
 *
 * This is a FLOOR, never lowered per scene: `faceSceneTimeout` returns the max
 * of this and the derived budget.
 */
export const FACE_SCENE_BASE_MS = 90_000;

/**
 * The multiple of a scene's MEASURED cost its bound must clear.
 *
 * 2x is the config's own stated standard for this budget — it chose 90 s so the
 * outer bound "EXCEEDS the sum of its own inner budgets ... with better than 2x
 * headroom". A bound sitting ON the measurement is a coin flip, which is the
 * exact defect the config's header documents about the old 30 s cap ("A budget
 * at p99 is not a margin, it is a coin flip, and it is the reason a *different*
 * scene failed each dispatch").
 */
export const FACE_SCENE_HEADROOM = 2;

/**
 * A face's MEASURED scene cost. Every field is required, so a weight cannot be
 * declared without the evidence for it.
 */
export interface FaceSceneWeight {
  /** the compact scene's measured duration, ms, on the named run */
  readonly compactMs: number;
  /** the dock scene's measured duration, ms, on the named run */
  readonly dockMs: number;
  /** the linux capture run the two durations were read off */
  readonly measuredOn: string;
  /** what makes this module expensive to render — not "it is slow" */
  readonly why: string;
}

/**
 * Declare a face's measured scene cost. A plain identity function whose only job
 * is to put `FaceSceneWeight` in front of `tsc`: the `FACES` roster is an
 * un-annotated `as const` array, so a bare object literal would be inferred
 * rather than checked and a missing `why` would compile.
 */
export function measuredSceneWeight(w: FaceSceneWeight): FaceSceneWeight {
  return w;
}

/**
 * The ARITHMETIC, separated from the roster lookup so it can be controlled in
 * BOTH directions against a synthetic weight the test builds itself — a
 * negative control ("no weight ⇒ exactly the base") proves the function can
 * return the floor, not that it computes the right thing above it.
 */
export function sceneBudgetMs(
  weight: FaceSceneWeight | undefined,
  scene: 'compact' | 'dock',
): number {
  if (!weight) return FACE_SCENE_BASE_MS;
  const measured = scene === 'compact' ? weight.compactMs : weight.dockMs;
  return Math.max(FACE_SCENE_BASE_MS, Math.ceil(measured * FACE_SCENE_HEADROOM));
}

/** The `sceneWeight` a face declares, or undefined. Exported so a gate can walk
 *  the roster's declarations without re-deriving the cast. */
export function faceSceneWeight(type: string): FaceSceneWeight | undefined {
  const entry = FACES.find((f) => f.type === type) as
    | { sceneWeight?: FaceSceneWeight }
    | undefined;
  return entry?.sceneWeight;
}

/** The two capture tiers a face can have. */
export const FACE_TIERS = ['compact', 'dock'] as const;
export type FaceTier = (typeof FACE_TIERS)[number];

/**
 * WHICH TIERS THIS FACE ACTUALLY CAPTURES. Absent from the roster entry — which
 * is the case for all but two — means BOTH, and that is what generated the
 * `face-<type>-compact` / `face-<type>-dock` pair for every face until now.
 *
 * ⚠ THIS IS NOT AN EXEMPTION, AND THE DIFFERENCE IS THE WHOLE POINT OF THE PR
 * IT ARRIVED IN. An exemption is a scene that still exists and is allowed to
 * fail; a tier absent from this list has NO test, NO baseline on disk and NO
 * budget — the gate cannot go green-and-blind on it because there is nothing
 * there to be green about. Every gate that walks the roster reads THIS
 * function, so "the scene exists" is defined once (the `ROSTERED_FACE_TYPES`
 * lesson one level down: two gates computing the same subtraction is the drift
 * machine).
 *
 * ⚠ AND A REMOVED TIER MUST TAKE ITS PNG WITH IT. The baseline checks below and
 * in `vrt-meta.test.ts` iterate this list, so a leftover PNG for a tier that is
 * no longer captured is a file nothing compares — the orphan-anchor shape this
 * repo treats as red everywhere else. Delete the baseline in the same commit.
 *
 * WHO DECLARES ONE TODAY, and why — recorded here because the answer is a
 * MEASUREMENT and the entries themselves are one line each:
 *
 *   mirrorpool / matrixMix, compact removed 2026-08-26 (owner: *"remove these
 *   VRTs for now"*). Both are NON-DETERMINISTIC at the zeroed tolerance and
 *   both were reported BIT-EXACT by `vrt-determinism-probe.spec.ts`, whose
 *   stated blind spot they are: two boots inside ONE browser session cannot see
 *   a 1-in-N instability. Boot-vs-BASELINE found them instead — the same
 *   `vrt-strict` shards re-run on the same SHA moved `face-mirrorpool-compact`
 *   335 px -> 339 px and made `face-matrixMix-compact` (541 px) pass outright,
 *   while the other 19 failing scenes reproduced with byte-identical counts.
 *   mirrorpool's compact tile is a live `VideoTileThumb` whose pin includes
 *   `__mirrorpoolForceAnalytic` — i.e. the pinned picture is a DIFFERENT height
 *   path from the shipped one — which is the first place to look when restoring
 *   it. The DOCK tier of both faces is untouched and still gates.
 *
 * The probe still walks BOTH tiers on purpose: it is boot-vs-boot, needs no
 * baseline, and is therefore the instrument that says when a removed tier has
 * become capturable again.
 */
export function faceTiers(type: string): readonly FaceTier[] {
  const entry = FACES.find((f) => f.type === type) as
    | { scenes?: readonly FaceTier[] }
    | undefined;
  return entry?.scenes ?? FACE_TIERS;
}

/**
 * The per-test bound for ONE face scene, ms.
 *
 * ⚠ ROUTE EVERY CALLER THROUGH THIS, for the `foldViewportFor` reason: an
 * isolation mechanism half the entry points honour is not isolation. A scene
 * that reached for `FACE_SCENE_BASE_MS` directly would silently put a heavy face
 * back under the flat cap.
 */
export function faceSceneTimeout(type: string, scene: 'compact' | 'dock'): number {
  return sceneBudgetMs(faceSceneWeight(type), scene);
}

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
  /**
   * THE FACE IS A RACK SINGLETON THE HARNESS CANNOT SPAWN — adopt the instance
   * the rack already has instead. The string is the REASON, so the declaration
   * cannot be a bare flag (the `videoFaceWhy` idiom, one field up).
   *
   * ⚠ THE SPAWN PATH ASSUMES A TYPE CAN BE INSTANTIATED ON DEMAND, and for one
   * module it cannot. `timelorde` is `maxInstances: 1` and is named in
   * `graph/cap.ts`'s `PINNED_COUNTS_TOWARD_CAP` — its always-on pinned instance
   * IS the rack's one clock and therefore CONSUMES the cap — so
   * `__spawnFromPalette` is simply refused. It fails as a 20 s arrival timeout
   * with no error, which reads like a broken app rather than a refused spawn.
   * And the pinned instance is canvas-hidden, so it has no lane tile either:
   * there is no subject at all until one is made.
   *
   * ⚠ THE ADOPTED STATE IS REAL, NOT SYNTHETIC, which is what makes this
   * legitimate rather than a harness cheat. `workflow-pins`' `presence: 'type'`
   * rule spawns the pinned instance only when NO node of the type exists, so a
   * rack imported from a saved patch carries an ORDINARY CANVAS timelorde and
   * no pin — exactly the state this branch produces by un-pinning and moving
   * the node into the lane band. It is also the ONLY state in which this face
   * is reachable by a player, which is the same thing said from the other side.
   */
  singletonAdoptWhy?: string;
  /**
   * PIN A STATEFUL SIM'S PHASE — boot-time globals installed via
   * `addInitScript` BEFORE `goto`, so they are set before any module factory
   * runs and can be read at CONSTRUCTION.
   *
   * ⚠ A LIST, BECAUSE DETERMINISM IS NOT ALWAYS ONE FLAG. This was a single pin
   * until `mirrorpool` needed THREE (clock + seed + the flag that takes the
   * float ping-pong out of the path), and each is individually insufficient:
   * seeding fixes WHICH rain drops spawn but not how many frames of them
   * landed, and pinning the clock leaves the height field integrating per draw.
   * A one-pin shape would have invited "pin the seed and hope", which is the
   * dead-seam failure this field exists to end. Every entry is installed AND
   * verified against the page, so a scene needing three is not silently
   * two-thirds pinned.
   *
   * ⚠ THIS IS A DIFFERENT AXIS FROM `videoFaceWhy`, AND THE DIFFERENCE IS THE
   * WHOLE BUG. `freezeFaceVideo` holds the LAST DRAWN frame — it makes the
   * picture STOP, and says nothing about WHICH picture it stopped on.
   *
   * ⚠⚠ THIS PARAGRAPH USED TO SAY "for a module whose field is a pure function
   * of frame.time that is enough". IT IS NOT, and the correction is measured
   * (2026-08-25): `spirographs` is exactly that module — every centre is
   * `advanceCenter(base, r, W, H, frame.time)` — it carries a `freeze` ParamDef,
   * and two ubuntu boots of its dock scene differed by 2711 px at maxCh 243,
   * OVER the 1500 px budget that was live at the time. A clock-driven picture
   * needs the CLOCK pinned (`simPin: __videoEngineFreezeTime`), because "which
   * frame did the freeze hold" is a different frame on every boot; pinning the
   * clock makes them all the same frame and the question dissolves.
   *
   * For a STATEFUL sim the freeze is insufficient for a DIFFERENT reason, and
   * the clock pin is insufficient too: the frozen frame is whatever the field
   * had integrated to when the harness got around to writing `freeze`, which is
   * a different number of DRAWS on every boot. mirrorpool records three globals
   * for that; lushgarden and pong suppress the sim outright.
   *
   * ⚠ MEASURED (outlines, #1939): `face-outlines-dock` missed its OWN freshly
   * captured baseline by 6724 px against the then-1500 px `DOCK_MAX_DIFF`
   * (zero since 2026-08-25) — 4.5x the
   * tolerance, capture and comparison both on ubuntu CI. The diff PNG showed
   * ONLY the spawned shapes' POSITIONS moving: chrome, labels and knobs were
   * pixel-identical and the shape COUNT was roughly equal. That is the exact
   * signature of a phase difference, NOT of an unseeded RNG — the spawn RNG
   * already defaults to a fixed seed, so WHERE shapes appear was never in
   * question. Re-capturing could only re-roll the dice; a capture that passed
   * BY LUCK would convert a red gate into a flaky one.
   *
   * ⚠ WHY IT LIVES HERE AND NOT IN THE MODULE. `outlines.ts` ALREADY CONTAINS
   * THE PHASE PIN and has since 1b24033a — it advances a fixed count of
   * fixed-dt steps on the first frame and then holds dt=0, so the picture
   * becomes a pure function of (seed, params). It is gated on
   * `globalThis.__outlinesVrtSeed`, and the ONLY setter in the tree was one
   * render-smoke spec. The face harness never set it, so in this scene the pin
   * was DEAD CODE and the module integrated wall-clock elapsed time exactly as
   * before. The fix is to SET THE FLAG THE PIN ALREADY WAITS FOR, which is why
   * nothing under `packages/web/src/lib/video/**` changes and the WebGL attest
   * hash does not move.
   *
   * `why` is required BY THE TYPE, so `tsc` refuses an undeclared pin: a bare
   * `{ global, value }` will not compile.
   */
  simPin?: readonly {
    /** The `globalThis` property the module reads at construction. */
    readonly global: string;
    /**
     * The value to install.
     *
     * `boolean` is allowed because some seams are FLAGS rather than seeds
     * (`__mirrorpoolForceAnalytic` is read as `!!x`). Writing `1` there would
     * work and would read as a magic number; the declaration should say what
     * the module means.
     */
    readonly value: number | boolean;
    /** Why this scene needs its sim phase pinned. */
    readonly why: string;
  }[];
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
export const FREEZE_RACE_FRAMES = 3;

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
 * How many 6-frame windows the surface gets to REACH stillness before this is
 * called a moving picture.
 *
 * ⚠ IT IS HERE BECAUSE A READINESS GATE WAS WRITTEN AS A SNAPSHOT COMPARE, and
 * that is a different assertion on every runner. "Is the surface still?" is a
 * STATE-READINESS question, and CLAUDE.md's rule for those is an auto-retrying
 * check on the real subject — a single compare of two samples six frames apart
 * asks instead "did these two particular frames match", which a first-paint or
 * a wall-clock preview cadence can answer NO to on a slow box and YES on a fast
 * one while the surface is equally still by the time the shot is taken.
 * (`blitOutputForPreview` really does gate on a wall-clock `minIntervalMs`, so a
 * preview canvas repaints on a cadence that is a DIFFERENT number of frames per
 * renderer — the exact shape the frames-not-milliseconds rule is about, one
 * layer down.)
 *
 * ⚠ IT DOES NOT WEAKEN THE ASSERTION, and the reason is what the caller does
 * next: `settle(page)` runs BEFORE `toHaveScreenshot`, so the property that
 * actually matters is "still by capture time", not "still at this instant". A
 * genuinely live surface — a running sim, an unfrozen renderer — never settles
 * and still fails, now naming which canvas.
 *
 * A COUNT OF WINDOWS, not a wall-clock budget, so it is the same assertion on
 * every renderer. Six windows is ~36 frames.
 */
const VIDEO_FREEZE_ATTEMPTS = 6;

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
 *
 * ⚠ IT SAMPLES THE SUBJECT'S OWN SURFACES, NOT THE PAGE — AND IT USED TO SAMPLE
 * THE PAGE, WHICH MADE IT FLAKY FOR EVERY VIDEO FACE IN THE ROSTER.
 *
 * `document.querySelectorAll('canvas')` collects the RACK'S FURNITURE too, and
 * one piece of that furniture animates on a rAF no video freeze reaches:
 * `pinned-timelorde`'s owl display, which `workflow-pins.ts` spawns into every
 * workflow rackspace. So the helper was asserting stillness of a canvas that is
 * (a) always moving and (b) NOT IN THE CAPTURE — `toHaveScreenshot` is taken on
 * the faceplate / tile locator, never on the document — which can only ever
 * produce a FALSE FAILURE. Two samples six rAFs apart usually landed on the same
 * owl frame, so it read green; it is a coin flip, and a slow runner flips it.
 *
 * MEASURED (2026-08-24, this branch, `E2E_SWIFTSHADER=1`, 4 rounds × 6 rAFs,
 * per-canvas signatures rather than the joined string this helper compares):
 *
 *   vfpgaRunner dock scene — 9 canvases:
 *     vfpga-face-canvas .................... distinct=1
 *     vfpga-trace-1 ........................ distinct=1
 *     video-tile-thumb ×3 .................. distinct=1
 *     audioout-face-canvas ................. distinct=1
 *     synesthesia-vu-a / -b ................ distinct=1
 *     timelorde-display-pinned-timelorde ... distinct=3   <-- the only mover
 *
 *   mirrorpool dock scene — 8 canvases, a SHIPPED and BASELINED face:
 *     mirrorpool-face-canvas ............... distinct=1
 *     timelorde-display-pinned-timelorde ... distinct=4   <-- the same mover
 *
 * The control is what makes this a fix rather than a guess: the mover is
 * identical on a face that has been green for weeks, so it is a property of the
 * INSTRUMENT and not of any module. (`vfpgaRunner` is simply where it finally
 * came up tails — on ubuntu CI, run 32791506814.)
 *
 * ⚠ AND NARROWING CANNOT WEAKEN THE ASSERTION, because it can only REMOVE
 * canvases that were never going to be photographed. What it must not do is
 * narrow to NOTHING — a zero-canvas sweep is trivially "still" — so the count is
 * asserted non-zero and printed either way, which is the positive control the
 * doc-comment above says a negative one cannot replace.
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
  const held = await page.evaluate(async (
    { frames, attempts, id }: { frames: number; attempts: number; id: string },
  ) => {
    // THE SUBJECT'S OWN SURFACES — the two containers the two scenes actually
    // photograph, and nothing else. `dock-full-view` is the dock scene's capture
    // root; the flow node is the compact scene's. Either may be absent (the
    // compact scene never opens a dock), so both are optional and the union is
    // what gets sampled.
    const roots = [
      document.querySelector('[data-testid="dock-full-view"]'),
      document.querySelector(`.svelte-flow__node[data-id="${id}"]`),
    ].filter((el): el is Element => !!el);
    const canvases = roots.flatMap((r) =>
      Array.from(r.querySelectorAll('canvas')) as HTMLCanvasElement[],
    );
    const name = (c: HTMLCanvasElement, i: number) =>
      c.getAttribute('data-testid') ?? `canvas#${i}(${c.width}x${c.height})`;
    const sample = (): string[] =>
      canvases.map((c) => {
        try {
          return c.width && c.height ? c.toDataURL().slice(-64) : 'x';
        } catch {
          return 'x'; // a tainted/GL canvas contributes nothing rather than throwing
        }
      });

    let prev = sample();
    let movers: string[] = [];
    for (let a = 0; a < attempts; a++) {
      for (let i = 0; i < frames; i++) {
        await new Promise((r) => requestAnimationFrame(() => r(null)));
      }
      const next = sample();
      movers = next.map((s, i) => (s === prev[i] ? '' : name(canvases[i]!, i))).filter(Boolean);
      prev = next;
      if (!movers.length) {
        return { same: true, movers, canvases: canvases.length, roots: roots.length, frames, tries: a + 1 };
      }
    }
    return { same: false, movers, canvases: canvases.length, roots: roots.length, frames, tries: attempts };
  }, { frames: VIDEO_FREEZE_SETTLE_FRAMES, attempts: VIDEO_FREEZE_ATTEMPTS, id: nodeId });

  // THE POSITIVE CONTROL FOR THE NARROWING, and it is not decoration: scoping to
  // the subject makes a MISSING subject indistinguishable from a still one, and
  // "still" is what this function returns. A scene whose faceplate never
  // mounted, or whose capture-root testid was renamed by a refactor, would sail
  // through the stillness check below on an empty list and report green.
  //
  // ⚠ IT ASSERTS THE CONTAINERS, NOT THE CANVASES, and the difference is a
  // measured one rather than a hedge. `roots > 0` is true of every scene BY
  // CONSTRUCTION — the compact scene has framed the flow node, the dock scene
  // has opened `dock-full-view` — so it can only fail when the instrument has
  // genuinely lost its subject. `canvases > 0` is NOT universally true: `pong`
  // declares `videoFaceWhy` (it needs the video BOOT PATH) but is `domain:
  // 'audio'` with gate outputs, so `laneGlyphFor` gives its lane tile no
  // picture at all and its COMPACT scene legitimately samples zero canvases.
  // Requiring one there would redden a scene that is green and correct.
  //
  // ⚠ SO A ZERO-CANVAS SUBJECT MAKES THE CHECK BELOW VACUOUS, and the count is
  // printed in both messages rather than left to be inferred. That hole is not
  // new — the page-wide version was equally blind to it and merely could not
  // LOOK vacuous, because the rack furniture always supplied canvases whether or
  // not the subject had any.
  expect(
    held.roots,
    `${label}: freezeFaceVideo found NEITHER capture container for '${nodeId}' — no ` +
      `[data-testid="dock-full-view"] and no .svelte-flow__node[data-id="${nodeId}"]. An empty ` +
      `sweep is trivially "still", so this is a broken instrument rather than a frozen picture.`,
  ).toBeGreaterThan(0);

  expect(
    held.same,
    `${label}: the video surface was still MOVING after writing freeze=1 on '${nodeId}'. ` +
      `STILL CHANGING after ${held.tries} × ${held.frames} rAFs: ${held.movers.join(', ')} ` +
      `(of ${held.canvases} canvases inside ${held.roots} capture container(s)). A scene ` +
      `captured now would be a moving target — the param did not reach the engine, or this ` +
      `module's picture is driven by something freeze does not stop.`,
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
    if (clock.state !== 'suspended') continue;

    // ── THE VERIFICATION IS PART OF THE RETRY, NOT A STEP AFTER IT ────────
    //
    // ⚠ THIS IS THE #1931 DEFECT, AND IT IS NOT WHERE THE ERROR MESSAGE
    // POINTS. `assertFaceAudioFrozen` says "at CAPTURE time", so the family
    // (#1810 / #1835 / #1931) reads as a capture-time race — but BOTH capture
    // paths in workflow-shell-faces.spec.ts already re-freeze immediately
    // before screenshotting, and the run that aborted #1939's full sweep
    // (face-destroy-compact, job 96157688266) failed under the label
    // `face-destroy`, not `face-destroy-compact`. That label is THIS
    // function's, called from `bootWithFace` — i.e. the abort happened at
    // BOOT, inside the retry loop that exists to absorb exactly this race.
    //
    // The loop checked `state === 'suspended'` and then called an assertion
    // that RE-READS the clock. `ensureEngine()` resumes on every call, so a
    // resume landing in the window between those two reads threw straight out
    // of the loop with FIVE of six attempts unused. The retry could not retry
    // the one thing most likely to lose the race.
    //
    // ⚠ AND ONE LOSING FACE ABORTS THE WHOLE CAPTURE (#1810), so this is not a
    // per-scene flake: it is why full sweeps were near-certain to fail. Three
    // distinct faces lost it in one day (videoOut, reverb, destroy), which is
    // the signature of a scheduler-timed window rather than a bad module.
    //
    // The assertion itself is UNCHANGED and stays the authority — it caught
    // exactly what it exists to catch. It is simply now allowed to fail and be
    // re-driven, and on the LAST attempt it throws its own message verbatim so
    // a genuinely repeating resumer still reports as itself rather than as a
    // retry count.
    try {
      await assertFaceAudioFrozen(page, label);
      return;
    } catch (err) {
      seen.push(`${attempt}:resumed-during-verify`);
      if (attempt === FREEZE_ATTEMPTS) throw err;
    }
  }
  throw new Error(
    `${label}: the AudioContext would not STAY suspended — ${FREEZE_ATTEMPTS} attempts, ` +
      `states after each (${seen.join(', ')}); a 'resumed-during-verify' entry means the ` +
      `suspend held long enough to read back 'suspended' and was undone before the clock ` +
      `check finished. Something is resuming it repeatedly. The known ` +
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

  // ── SIM PHASE PIN — INSTALLED BEFORE `goto`, WHICH IS THE ENTIRE POINT ────
  // See BootFaceOptions.simPin. The module reads this global at CONSTRUCTION
  // (in its factory), so an init script is the only placement that can work: a
  // post-goto `evaluate` lands after the factory has already built an unseeded,
  // unpinned sim. Ordering is the defect class here, so it is asserted below
  // rather than assumed.
  for (const { global, value } of opts.simPin ?? []) {
    await page.addInitScript(
      ([g, v]) => {
        (globalThis as unknown as Record<string, unknown>)[g as string] = v;
      },
      [global, value] as [string, number | boolean],
    );
  }

  await page.goto('/rack');
  await page.waitForLoadState('networkidle');
  await awaitVrtFonts(page);
  await waitForHooks(page);

  // ⚠ TWO-SIDED, AND ANCHORED TO THE PAGE RATHER THAN TO THE CALL. Asserting
  // that we CALLED addInitScript would prove nothing — the failure mode this
  // guards is an init script that never reached the document (moved after
  // `goto` by a later refactor, or dropped by a navigation), and from a
  // capture's output "the pin was installed" and "the pin was never set" are
  // indistinguishable: both produce a plausible picture, one of them a
  // different one per boot. A dead pin is exactly how this bug shipped, so it
  // fails loudly here instead of as a 4.5x-over-tolerance pixel diff weeks
  // later.
  //
  // ⚠ EVERY PIN IS CHECKED, not just the first. A scene whose determinism needs
  // THREE globals (mirrorpool) is no more pinned than an unpinned one if two
  // land and the third does not — and the picture it produces looks entirely
  // plausible either way.
  for (const { global, value } of opts.simPin ?? []) {
    const seen = await page.evaluate(
      (g) => (globalThis as unknown as Record<string, unknown>)[g],
      global,
    );
    expect(
      seen,
      `simPin ${global} did not reach the page before boot — the module reads it at `
        + `construction, so an unset flag means this scene captured an UNPINNED sim whose `
        + `phase differs on every boot. Check that addInitScript still runs BEFORE goto.`,
    ).toBe(value);
  }

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
  // ── A RACK SINGLETON IS ADOPTED, NOT SPAWNED ────────────────────────────
  //
  // See BootFaceOptions.singletonAdoptWhy. It resolves its member the way the
  // video-zone branch does — by NODE, on free canvas — and for the same
  // underlying reason rather than by imitation: a CHANNEL COLUMN is the AUDIO
  // chain, and a module with no audio port can never join one. timelorde's
  // fourteen outputs are thirteen `gate` and one `video`, so the column wait
  // would sit at its full budget on a perfectly healthy rack (MEASURED: 90 s,
  // with the node un-pinned and in the lane band). That is the same fact
  // `videoFaceWhy` encodes for pong, which is likewise an audio def with no
  // audio port.
  //
  // ⚠ IT DOES NOT REUSE `videoFaceWhy`, and the difference is not cosmetic:
  // that field ALSO turns on `freezeFaceVideo`, which writes `params.freeze`.
  // pong declares a freeze param; timelorde does not, so the write would invent
  // an undeclared key and the assertion after it would be measuring a freeze
  // that never happened.
  if (opts.singletonAdoptWhy) {
    const adoptedId = await adoptCanvasSingleton(page, type);
    await applyFaceSceneStyle(page);
    if (opts.freezeAudio !== false) await freezeFaceAudio(page, `face-${type}`);
    return adoptedId;
  }

  // ── THE ORDINARY PATH: a channel COLUMN is the chain ─────────────────────
  //
  // ⚠ THERE IS NO PRE-FLIGHT PORT CHECK HERE, AND A WHOLE BOOT BRANCH THAT
  // ASSUMED ONE WAS DELETED. Both rested on the premise that "a def with no
  // audio port can never join a channel column". THE PREMISE IS FALSE. Column
  // membership is decided by DROP POSITION — `__setSpawnFlowPos` lands the node
  // in lane 1's painted band and the membership path adopts it — and has nothing
  // to do with port shape. MEASURED, twice over and in both directions: eight
  // shipped CV/gate-only faces (lfo, kria, marbles, fourplexer, gatemaiden,
  // ninelives, moog962, depolarizer) join fine, and so does `matrixMix`, which
  // declares NO PORTS AT ALL and still reaches a rendered tile through this
  // exact path.
  //
  // The mistake was a PROXY standing in for the SUBJECT. What matters is "the
  // column never formed, so this boot is about to die as a bare timeout" — a
  // DYNAMIC outcome of THIS run. "Declares no audio port" is a STATIC property
  // that merely correlates, and correlates badly in both directions: it
  // reddened eight working faces while `backdraft`'s real problem was the video
  // zone and `timelorde`'s was a REFUSED SPAWN (maxInstances), neither of which
  // is about ports at all.
  //
  // So the wait below is WRAPPED rather than predicted. Every module that can
  // use this path uses it unchanged; a module that ACTUALLY times out gets a
  // named refusal instead of a bare timeout, which turns the 90 s mystery
  // backdraft and timelorde each cost into a 90 s EXPLAINED failure.
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
    try {
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
    } catch {
      // ── THE COLUMN NEVER FORMED — the ONLY condition this refusal is about ──
      //
      // Reached only after the wait has actually exhausted its budget, so it is
      // a MEASUREMENT of this boot rather than a prediction from the def's
      // shape. Every module whose column forms never gets here — which is every
      // module in the roster except the two that declare a branch.
      throw new Error(
        `${t}: the channel column never formed — waited for lane 1 to hold `
          + `${chain.indexOf(t) + 1} member(s) and it never did, so this boot was about to die `
          + `as a bare Playwright timeout with no indication of why (MEASURED at ~90 s on `
          + `backdraft and again on timelorde, each diagnosed from scratch). Membership comes `
          + `from the DROP POSITION, not from port shape, so a module that fails to join has a `
          + `spawn or membership problem rather than a port one. If this module genuinely `
          + `cannot use this path, declare ONE of: \`videoFaceWhy\` (a video module — boots `
          + `into the video zone AND pins its live surface) or \`singletonAdoptWhy\` (a pinned `
          + `rack singleton \`__spawnFromPalette\` refuses). Each takes a REASON string, not a `
          + `flag. ⚠ If this def's column USED to form, this is a REGRESSION in the spawn or `
          + `membership path and declaring a branch is the WRONG fix — it would route a working `
          + `chain around the path that is meant to exercise it.`,
      );
    }
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
/**
 * UN-PIN the rack's existing singleton and put it in the lane-1 band, so the
 * shared audio path can go on treating it as an ordinary channel member.
 *
 * ⚠ IT ASSERTS ITS OWN PRECONDITION IN BOTH DIRECTIONS. "Adopt the one that is
 * there" is silently wrong if there are zero (nothing to capture) or two (the
 * scene would pick an arbitrary one), and both would surface as a generic
 * timeout in the column wait rather than as the thing that happened. The
 * expectation names the population it found.
 */
async function adoptCanvasSingleton(page: Page, type: string): Promise<string> {
  // ⚠ THE ENGINE IS A SIDE-EFFECT OF SPAWNING, AND THIS BRANCH DOES NOT SPAWN.
  // `__spawnFromPalette` boots the audio engine on its way past; adopting a node
  // that already exists never touches it, so without this the scene reaches
  // `freezeFaceAudio` with no AudioContext to suspend and fails as
  // "AUDIO FREEZE DID NOT LAND (no-engine)" — an accurate message pointing at
  // the wrong cause. (MEASURED here, on the first run of this branch.) It is
  // also what lets the adopted card push a display frame at all.
  await page.waitForFunction(() => {
    const w = globalThis as unknown as { __ensureEngine?: () => Promise<unknown> };
    return typeof w.__ensureEngine === 'function';
  }, undefined, { timeout: 20_000 });
  await page.evaluate(async () => {
    const w = globalThis as unknown as { __ensureEngine: () => Promise<unknown> };
    await w.__ensureEngine();
  });

  const existing = await idsOfType(page, type);
  expect(
    existing,
    `${type}: singletonAdoptWhy expects EXACTLY ONE existing instance to adopt, found ` +
      `[${existing.join(', ')}]. Zero means the rack's always-on spawn did not run (there is ` +
      `nothing to capture); two means the cap this branch exists for is no longer in force, and ` +
      `the ordinary spawn path should be used instead.`,
  ).toHaveLength(1);

  await page.evaluate(
    ({ id, pos }) => {
      const w = globalThis as unknown as {
        __patch: {
          nodes: Record<
            string,
            { position?: { x: number; y: number }; data?: Record<string, unknown> } | undefined
          >;
        };
        __ydoc: { transact: (fn: () => void) => void };
      };
      const node = w.__patch.nodes[id];
      if (!node) throw new Error(`adoptCanvasSingleton: ${id} vanished between read and write`);
      w.__ydoc.transact(() => {
        // Un-pinning is what makes it a CANVAS node: `isCanvasHiddenNode` is
        // `pinned || hiddenCard`, and the flowNodes derivation skips those, so a
        // pinned node has no lane tile to capture at all.
        if (node.data) node.data.pinned = false;
        // FREE CANVAS below the channel-lane baseline — the same point the
        // video-zone branch drops into, and for the same reason: a channel
        // column is the AUDIO chain and this module has no audio port, so
        // parking it in a lane band would only make it wait forever to join one.
        node.position = { x: pos.x, y: pos.y };
      });
    },
    { id: existing[0]!, pos: { x: 200, y: 4560 } },
  );
  return existing[0]!;
}

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

/**
 * The member's `face.bandFocus` declaration plus the DEFAULT value of the param
 * it keys on, read off the live registry projection. `null` for a face without
 * the feature, which is every face but one today.
 *
 * The default value is the whole point: it is the state a spawned face is in,
 * and therefore the plate the dock baseline pins.
 */
async function bandFocusOf(
  page: Page,
  memberId: string,
): Promise<{ focus: BandFocusPredicate; defaultValue: number } | null> {
  return page.evaluate((id) => {
    const w = globalThis as unknown as {
      __patch?: { nodes: Record<string, { type?: string } | undefined> };
      __moduleSpecs?: {
        type: string;
        params?: { id: string; defaultValue: number }[];
        bandFocus?: { param: string; showAllOn: number[]; bands: Record<string, number[]> };
      }[];
    };
    const type = w.__patch?.nodes[id]?.type;
    const spec = (w.__moduleSpecs ?? []).find((s) => s.type === type);
    const focus = spec?.bandFocus;
    if (!focus) return null;
    const p = (spec?.params ?? []).find((q) => q.id === focus.param);
    return p ? { focus, defaultValue: p.defaultValue } : null;
  }, memberId);
}

/** Write one param on `memberId` through the real durable store, the way a
 *  player's own click lands. */
async function setFocusParam(page: Page, memberId: string, param: string, v: number): Promise<void> {
  await page.evaluate(
    ({ id, param, v }) => {
      const w = globalThis as unknown as {
        __patch: { nodes: Record<string, { params: Record<string, number> } | undefined> };
        __ydoc: { transact: (fn: () => void) => void };
      };
      w.__ydoc.transact(() => {
        const n = w.__patch.nodes[id];
        if (n) n.params[param] = v;
      });
    },
    { id: memberId, param, v },
  );
}

/**
 * Click the member's jack-rail EXPAND affordance and wait for the dock
 * full-view to mount at the 'dock' face tier with `pages` section bands.
 *
 * ── BAND FOCUS, AND WHY THE BASELINE PINS THE *FOCUSED* PLATE ──────────────
 *
 * A face declaring `face.bandFocus` renders only the bands its focus param's
 * current value reveals, and `colourofmagic` — the first adopter — DEFAULTS to a
 * focused value: five declared bands, one on the plate. MEASURED: this function
 * aborted the whole capture at `toHaveCount(5)` / received 1, so the branch's
 * own dock baseline could never be rewritten (run 32433398192 failed with zero
 * commits).
 *
 * Two things were true at once and both are kept:
 *
 *   1. `pages` is a REAL STRUCTURAL GATE — a dropped band must fail before the
 *      pixel pin, and weakening it to "however many rendered" would delete that.
 *      So the face is driven to its declared SHOW-ALL value and the full count is
 *      asserted there, unchanged, with `pages` still meaning what the roster says.
 *
 *   2. ⚠ THE PNG MUST PIN THE DEFAULT, NOT SHOW-ALL. Capturing the show-all
 *      plate would make this baseline BLIND to the feature it ships beside: if
 *      band focus regressed to "always show everything", a show-all capture is
 *      pixel-identical and the gate says nothing, while the DEFAULT capture moves
 *      the moment the other four bands come back. It is also simply what the
 *      player is handed (owner, 2026-08-20: rgb by default; everything only on
 *      an explicit PASS). So the value is restored before the capture.
 *
 * The restored expectation is DERIVED TWICE OVER rather than typed: the band ids
 * are read off the DOM at show-all, and which of them survive is decided by
 * `visibleBandIds` — the predicate the shell itself renders through. Asserted as
 * the ID LIST, not a count, so a plate showing the right NUMBER of the wrong
 * bands is red.
 */
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

  const bands = faceplate.locator('[data-testid="face-page"]');
  const focused = await bandFocusOf(page, memberId);
  if (!focused) {
    await expect(bands).toHaveCount(pages);
  } else {
    const { focus, defaultValue } = focused;
    const showAll = focus.showAllOn[0];
    expect(
      showAll,
      `${memberId}: declares bandFocus with an EMPTY showAllOn — no value shows the whole face, ` +
        `so the roster's structural band gate could never run`,
    ).not.toBeUndefined();

    await setFocusParam(page, memberId, focus.param, showAll!);
    await expect(
      bands,
      `at the declared show-all value (${focus.param}=${showAll}) every declared band must render ` +
        `— this is the roster's structural gate and band focus does not excuse a dropped band`,
    ).toHaveCount(pages);
    const allIds = await bands.evaluateAll((els) =>
      els.map((e) => e.getAttribute('data-face-page') ?? '?'),
    );

    await setFocusParam(page, memberId, focus.param, defaultValue);
    const visible = visibleBandIds(focus, defaultValue);
    expect(
      visible,
      `the DEFAULT value (${focus.param}=${defaultValue}) is a show-all value, so this face has ` +
        `no focused resting state and the baseline below would be blind to band focus regressing`,
    ).not.toBeNull();
    const want = allIds.filter((id) => visible!.has(id));
    expect(
      want.length,
      `no declared band survives the default value (${focus.param}=${defaultValue}) — the ` +
        `baseline would pin an EMPTY plate`,
    ).toBeGreaterThan(0);
    expect(
      want.length,
      `the default value (${focus.param}=${defaultValue}) reveals all ${pages} bands, so the ` +
        `capture below cannot tell focused from unfocused`,
    ).toBeLessThan(pages);
    await expect
      .poll(
        async () => (await bands.evaluateAll((els) =>
          els.map((e) => e.getAttribute('data-face-page') ?? '?'),
        )).join(','),
        {
          message:
            `back at the default (${focus.param}=${defaultValue}) the plate must hold exactly the ` +
            `focused bands — the PNG pins THIS state, so that the baseline moves if focus stops ` +
            `hiding the others`,
        },
      )
      .toBe(want.join(','));
  }
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
   * `plateW` is `.faceplate-scroll`'s client width — the whole PANE.
   *
   * `bodyW` is `.faceplate-body`'s width from the same origin. That element is
   * `width: max-content` (see `_dock-faceplate.css`), so it IS the face's own
   * natural width, and **`bodyW - contentW` is the useless grey space owner
   * ruling 2026-08-17 forbids**: *"we do not want useless gray horizontal space
   * on cards, ever."*
   *
   * ⚠ USE `bodyW`, NOT `plateW`, TO JUDGE A FACE — and this is a CORRECTION,
   * measured, not a preference. The pane is `max(the face, the dock TITLE BAR)`,
   * and the bar (badge + `MOOG911 911 eg · lane 1` + three window buttons) lives
   * OUTSIDE `.faceplate-scroll`, so `contentW` is structurally blind to it while
   * `plateW` is driven by it. On a NARROW face the bar wins and `plateW -
   * contentW` charges the chrome's width to the faceplate. Measured by removing
   * each element and re-reading the pane:
   *
   *   face                    content  body  plate   without BAR   without STRIP
   *   moog914 (passing)          765    780    780        —              780
   *   moog911                    270    303    352       303             352
   *   vca                        247    280    337       280             337
   *   wavetableVco               250    283    319       283             319
   *   unityscalemathematik       280    313    373       313             373
   *
   * Removing the BAR collapses the pane onto the body every time; removing the
   * hero READOUT STRIP moves nothing on any of them. So the three faces that
   * carried a `FACE_WIDTH_EXEMPTIONS` entry blaming that strip were all
   * mis-attributed — their real waste is **33 px each**, the same "the hero row
   * defines the plate" mode this file's own threshold note documents as normal,
   * and the promised global removal of the strip would have left all three red.
   *
   * ⚠ WHAT THIS STILL CANNOT SEE: whether the BAR ITSELF is wasting space. A
   * pane wider than its faceplate because the title bar demands it is not a
   * face defect, and narrowing it (letting the bar ellipsise instead of setting
   * the pane's max-content) is a dock-CHROME change that would move every dock
   * baseline — an owner-visible decision, not a face PR's.
   */
  contentW: number;
  plateW: number;
  bodyW: number;
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

    // THE FACE'S OWN BOX, from the SAME origin as `contentW` so the two
    // subtract. Deny-by-default: no body means the geometry is unreadable, and
    // a silent 0 would report every face as perfectly filled.
    const body = (sc.closest('.dock-faceplate') ?? sc).querySelector(
      '.faceplate-body',
    ) as HTMLElement | null;
    if (!body) throw new Error('_shell-faces: the dock faceplate has no .faceplate-body');
    const bodyRect = body.getBoundingClientRect();

    return {
      contentW: Math.round(right - contentLeft),
      plateW: sc.clientWidth,
      bodyW: Math.round(bodyRect.right - contentLeft),
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
