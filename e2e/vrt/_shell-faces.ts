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
// it into view (the container does not scroll). 1400 px leaves ~300 px of
// headroom over today's tallest face (drummergirl, 1002 px of pane) and the
// dock test ASSERTS that headroom rather than assuming it.
export const FOLD_VIEWPORT = { width: 1280, height: 1400 } as const;
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

  await page.addStyleTag({
    content:
      '.svelte-flow__minimap,.svelte-flow__controls,.svelte-flow__attribution,.minimap-toggle{display:none !important;}' +
      '*,*::before,*::after{animation:none !important;transition:none !important;}',
  });
  if (opts.freezeAudio !== false) await freezeFaceAudio(page, `face-${type}`);
  return memberId;
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
    return {
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
