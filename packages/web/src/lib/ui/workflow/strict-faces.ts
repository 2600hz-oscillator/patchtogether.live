// packages/web/src/lib/ui/workflow/strict-faces.ts
//
// The PROMOTED set for the workflow-mode UI-CURATION system — the face analog
// of STRICT_DOCS ($lib/docs/strict-docs). A module type in this set has been
// PROMOTED to the full curation bar: its co-located `face` MUST be COMPLETE —
// every param, every declared control family, and every numbered-legend control
// appears in `face.order` (the deny-missing-curation guarantee at the control
// surface), enforced by module-face-lint.test.ts.
//
// ⚠ THIS SET IS NOT AN INDEPENDENT ALLOWLIST — it is asserted EQUAL to the set
// of defs that declare a `face` (module-face-lint.test.ts, both directions).
// AUTHORING A `face` IS THE PROMOTION. There is no count anywhere: the old
// `|STRICT_FACES| >= 18` floor was deleted 2026-08-12 and the set identity
// carries what it protected. To un-promote a module, delete its `face`; to
// promote one, author a complete `face` and add the name here in the same PR.
//
// (Historically, modules with an unpromoted `face` were checked only for
// CONSISTENCY — no orphaned keys — while the bar rolled out. Measured
// 2026-08-12, that population is EMPTY, which is why the identity can be
// asserted rather than described.)
//
// P1 BATCH 1 (2026-07-25): the first faced-module wave — six total reworks to
// the gallery spec (see .myrobots/plans, workflow-mode UI refactor §3.6 + §5).
// Each entry below carries a complete co-located `face` (order + pages + glyph)
// authored against its fullcard mock.
//
// P1 BATCH 2 (2026-07-26): the second wave — the two pitched voices (dx7,
// sixstrum), the two percussion voices (snaredrum, tomtom) and the two
// processors (shimmershine, qbrt). Same bar: a complete co-located `face`
// (order + pages + glyph + `rear`), authored from what each module ACTUALLY
// is rather than transcribed from its legacy card. The two pitched voices are
// additionally enrolled in default-pitch-accuracy (unit + e2e).
//
// P1 BATCH 3 (2026-07-26): the third wave — the plucked-string voice (karplus)
// and the four workhorse processors/utilities (filter, mixer, delay, reverb) a
// rack reaches for on every patch. Same bar: a complete co-located `face`
// (order + pages + glyph + `rear`).
//
// FACE BATCH B+ (2026-08-02): ringback — the first module PROMOTED from having
// no face at all in this wave (the batch-B reworks all rewrote existing ones).
// It ships the same bar plus the two things batch B established: the ranges
// live in ONE model module the def AND the card import
// ($lib/audio/ringback-crush-model), and its `glyph`/`order` are checked
// against measurements taken from the real DSP core rather than argued in a
// comment.
//
// FACE BATCH 3 (2026-08-03): the PF-20 wave — clap, drummergirl and
// pentemelodica, plus a RE-DO of sixstrum's shipped face. Faceplates authored
// against what each module IS rather than against its legacy card, each with a
// hero, a declared sidebar and DERIVED readouts registered in
// face-readout-values.ts (never a knob relabelled), negative-controlled
// PERMANENTLY in a per-module `*-face-model.test.ts`.
//
// sixstrum is a RE-DO rather than a promotion, and it is the entry that fixes a
// live defect: its shipped face ranked three next-STRIKE-only controls into the
// lane and had no strike key at all, so under `?shell=1` the dock offered
// twenty controls over an instrument that could not be sounded.
//
// meowbox (2026-08-08) joins that batch as a second promotion-from-nothing, and
// it is the entry that answers a wall drummergirl hit and worked around by
// DEFERRING: `module-face-lint` refuses a PANEL cell SELECTED at a lane tier and
// the 'full' lane cap is SIX, so a hero picture's first legal rank is 7 — which a
// module with four params and one audition can never reach. drummergirl dropped
// its picture and its audition together over this. meowbox ships both, because a
// `sidebar` `custom` block carries no `face.order` key and therefore no rank at
// all: the picture is `formant-bank` in the sidebar and the audition is a
// `mode:'gate'` action at rank 5. Its `gate` port is additionally the first on
// this module to DECLARE `edge` — the def's prose called it a trigger while the
// DSP's `en.adsr` sustains at 0.4, and module-docs-lint's vocabulary check does
// `if (!p.edge) continue`, so the one gate that owns that vocabulary was
// structurally unable to see it.
//
// ⚠ analogVco was authored, verified and then DROPPED from this batch. Its
// `face-analogVco-compact` VRT scene was NOT pixel-deterministic: unlike every
// other faced module, analogVco is a FREE-RUNNING oscillator, so its live
// `scope` glyph was drawing a genuinely moving saw rather than the flat
// centreline the spec header assumed (measured 254 / 154 / 315 px across three
// consecutive captures of the same tile). Its DOCK scene was stable, which
// confirmed the diagnosis — a `hero.cell` suppresses the glyph there.
// FACE BATCH 3 · analogVco (2026-08-08) — the RECOVERY of the face batch 3
// authored, verified and then dropped. Every unit gate passed at the time; the
// blocker was purely the pixel lane, and it is now fixed at the ROOT.
//
// THE BLOCKER WAS NOT WHERE THIS FACE'S OWN BRANCH THOUGHT IT WAS, and the
// correction is the interesting part. analogVco is a FREE-RUNNING oscillator —
// it sounds the instant it spawns — so the live `scope` glyph on its COMPACT
// lane tile drew a genuinely moving saw where every other face drew a flat
// centreline, and the tile could not baseline at all. The recovered branch
// concluded the fix was a `VRT_LIVE_SURFACES` mask plus a measured companion,
// and derived one honestly (1/10 unmasked vs 10/10 masked, 10 processes).
//
// It was treating a SYMPTOM. The cause was that `bootWithFace` never suspended
// the AudioContext, so EVERY face scene captured off a live graph; the roster
// got away with it because all 21 other faces are struck or silent and their
// analysers held zeros either way. #1420 freezes the graph in that ONE shared
// boot path, before the tile is framed, so a free-running voice's glyph tap is
// an analyser on a stopped graph and reads zeros like everyone else's. The mask
// this branch carried was therefore DELETED, not merged: the tile ships fully
// strict, glyph included.
//
// ⚠ AND THIS FACE IS THE FIRST REAL TEST OF THAT FIX. #1420 shipped covered
// only by a SYNTHETIC negative control, because — as its own author flagged —
// no module holding a face was free-running, so nothing in the roster could
// exercise the freeze. analogVco changes that. MEASURED 2026-08-08 (darwin,
// within-subject, vrt-face-audio-probe, 26/255 delta):
//
//   source: port=saw peak=0.999890 moving=1.953397   → genuinely free-running,
//                                                      read at the AnalyserNode
//   frozen pre-frame (shipping)          0 px, and 0 px across two INDEPENDENT
//                                        boots
//   freeze OFF                         394 px, entirely inside the glyph box
//   freeze LATE (wrong ordering)       337 px across independent boots
//
// All 21 other faces read 0 px in both perturbed configurations. So promoting
// this face converts #1420's synthetic-only coverage into REAL roster coverage,
// and it is the only entry that can catch a regression of either the freeze or
// its ORDERING. Gate derivation: 10/10 separate processes, unmasked.
//
// The face itself is unchanged from the verified batch-3 authoring, and its two
// live defects were fixed independently before it landed: the card/def bipolar
// range disagreement (#1311) and the impossible `pw`-with-an-LFO doc (897b6515).
//
// FACE BATCH 3 · macrooscillator (2026-08-09) — the SECOND free-running face,
// and the entry whose argument is that a faceplate must not paint a dead
// control as a working one. Six dials over FOURTEEN engines, three of which
// mean something different in each, so every readout is DERIVED from `model`
// plus the dial rather than read back off a knob.
//
// FOUR of them report a DEFECT rather than a feature (WAVETABLE's morph is
// dead over its bottom half, GRANULAR's is a 3-position switch, MODAL's timbre
// runs backwards, OUT spans 76.6 dB across engines). All four are worklet
// arithmetic, so they are documented rather than fixed — CLAUDE.md, and
// batch-3 INDEX rule 5.
//
// ⚠ THE MEASUREMENTS ARE DELIBERATELY NOT REPEATED HERE. Every number lives in
// `$lib/audio/modules/macro-engine-roster` and is RE-DERIVED from
// `macrooscillatorMath` on every run by `macrooscillator-face-model.test.ts` —
// so a copy in this comment could go stale while the gate stayed green, which
// is the drift this repo keeps re-learning. Freeze numbers likewise live once,
// in the FACES roster (`e2e/vrt/_shell-faces.ts`).
// FACE BATCH 3 · bluebox (2026-08-09) — the DTMF dialer, PROMOTED from having
// no face at all, and the entry that answers a question the batch had not had to
// answer: WHAT DOES `face.order` MEAN ON A MODULE WHOSE TWELVE CONTROLS ARE
// INTERCHANGEABLE?
//
// `order` is a PRIORITY ranking for the tiers that show a subset, and a
// telephone keypad has no priority. This face does not invent one. It ranks by
// LAYOUT — the twelve keys in the order a telephone prints them, DERIVED from
// `BLUEBOX_BUTTON_NAMES` rather than typed — and the property that buys is that
// every PREFIX of the ranking is still a recognisable keypad fragment: the
// 6-cell lane plate is the top two rows of a phone. The alternatives were
// considered and are all worse, including the one that is genuinely principled
// (the minimal bank cover {1,5,9,0,BLUEBOX,REDBOX}, the smallest set of keys
// that lights all ten oscillators), because it reads in a lane tile as a broken
// phone and is no more true. Then, because no prefix can carry the module's
// INFORMATION, the information moves off the key subset entirely: a `meter`
// glyph in the lane (the real hazard — eight simultaneous digits is full scale)
// and a ten-bar TONE BANK in the dock, the only surface anywhere that makes the
// shared-oscillator `+=` visible.
//
// ⚠ ITS READOUTS ARE BLIND TO A PRESS, and that is the platform, not the face:
// a `face.momentary` press writes the engine only and a gate cable is a node
// input, so neither reaches `node.params` (the source `ModuleShell.readoutValue`
// reads). Declared on the def, filed as a platform follow-up. Everything the
// numbers assert is negative-controlled in bluebox-face-model.test.ts, in both
// directions, against the REAL processor class on twelve key sets — including
// the one worklet constant the model has to mirror, which is anchored by
// measuring the shipping DSP rather than by a comment.

// FACE BATCH 3 · cube (2026-08-10) — the biggest face in the repo (26 params
// + 2 panels = 28 cells) and the first one whose HERO IS THE MODULE'S EXISTING
// RENDERER rather than a picture drawn for the faceplate.
//
// cube is "a solid and a cut": three wavetables stacked into a 3-D density
// field, read by one movable plane whose 256 samples ARE the waveform. The
// spec that preceded this face priced a cheaper 2-D hero; the owner required
// full visualisation parity, and the parity is not cosmetic — the volume
// render is the only surface anywhere that shows the cut INSIDE the solid. So
// the renderer moved out of CubeCard.svelte into `cube/CubeVizSurface.svelte`
// and BOTH mounts use it. That moved the WebGL attest basis SET (the card out,
// the surface in) and needs a real-GPU re-attest.
//
// ⚠ ITS RANKING IS THE INVERSE OF ITS OWN DEF, and that is the argument. The
// def and the legacy card both lead with TUNE / FINE / MORPH / CONNECT and put
// the three rotations 12th-14th of 15 — an implementation order, since the
// field is computed before it is cut. Measured, the cut owns the timbre by 5×
// (`slice_ry` 0.885 rmsΔ over its travel against `morph_fc`'s 0.178), so the
// SLICE band is first and the SOLID second.
//
// ⚠ AND THE FACE'S BEST WORK IS ONE READOUT. `slice_y` is a real control that
// is inert in EXACTLY ONE STATE: the state the module spawns in. The ray march
// integrates over a window centred on the ray origin, so sliding the plane
// along its own normal moves the window and its contents together, and at
// spawn the normal IS the axis Y translates along (0.115 flat, 0.759 at ROT X
// 0.8). No surface has ever said so, and a knob readback structurally cannot —
// it prints 0.50 in both. `cube-y-live` prints `asleep — plane is flat` or
// `live`, and the `tilted` preset is one click that changes it.
//
// ⚠ THE PRE-#1448 DEFECT LIST IS PARTLY STALE AND THIS FACE DOES NOT REPEAT
// IT. Re-measured on the shipped default tables: CRUSH at its maximum is
// `acRms` 0.5528 (it used to be exactly 0.000000, a full-scale DC step), SPACE
// DIFFUSE at 1.0 is 0.2450 (likewise), and the two-table pigeonhole that left
// CONNECT bit-exactly dead at one end of MORPH is gone with the third factory
// table. A face that documented a repaired control as broken would be worse
// than one that said nothing, so every number this face prints was re-derived
// against the current DSP and is re-derived again on every run by
// cube-face-model.test.ts.

// FACE BATCH 4 · clouds (2026-08-10) — the granular TEXTURE processor, and the
// entry whose argument is that a face can be worth building for a module with
// NOTHING WRONG WITH IT.
//
// Every other promotion in this programme found a defect: a dead morph half, a
// dial that wrote values its def forbade, an instrument that could not be
// sounded. clouds has none. It has no dead controls in the ordinary sense, and
// it is the best-behaved module in its batch on level — 0 of 54 measured
// corners exceed full scale, worst −0.10 dBFS, against sidecar's +17.98 and
// resofilter's +44.4. What it has is INVISIBILITY, and each instance is
// invisible to precisely the instrument the repo would reach for:
//
//   * IT IS SILENT WHEN YOU PATCH IT — bit-zero for exactly one GRAIN LENGTH
//     (measured 60.0 / 134.1 / 300.0 / 670.8 / 800.0 ms at size 0 / .25 / .5 /
//     .75 / .9, POSITION-invariant to the sample), then ~12 dB down until the
//     2.0 s ring has filled, full level one grain after that. Nothing anywhere
//     said so. ⚠ The spec authored against `main` said "the first quarter
//     second is bit-zero" and "the step lands at t = 2.000 s to the sample";
//     both were artifacts of a 0.25 s measurement grid. The real silence is a
//     grain length and it MOVES with SIZE; the real level knee is a ~0.3 s ramp
//     starting at ≈2.02 s. Re-measured before anything was written around them.
//   * POSITION IS THE STRONGEST CONTROL AND NO LEVEL METRIC CAN SEE IT —
//     0.17 dB across the whole travel on broadband, against max|Δ| 0.99 on a
//     marked source. It would read as a dead dial in a lane tile, which is why
//     it is ranked 5 and promoted to the DOCK hero beside the one picture that
//     can show it.
//   * PITCH IS A ~10.6 dB FADER AT ZERO — a THRESHOLD, not a slope: −5.47 dB at
//     0 against −17.60 at ±0.5 st.
//
// ⚠ AND ONE THING THE FACE REFUSED TO PAINT AS WORKING — WHICH IS NOW FIXED,
// and the sequence is the argument for the whole discipline. Re-measurement
// found (the spec had not) that SIZE's top 19.50 % rendered BIT-IDENTICAL
// output: `safeLen = min(lengthSamples, 0.4·bufLen)` capped the grain at 800 ms
// while the dial's law asked for 1500. The face shipped a `CLAMPED` badge there
// rather than a working-looking dial, plus a bit-identity ORACLE pinning the
// defect to the DSP. #1456 raised the ceiling to the law's own top, the oracle
// went red exactly as it promised, and both badge and oracle are gone —
// replaced by the inverse claim measured on the SHIPPING WORKLET
// (art/scenarios/clouds/size-travel.test.ts).
//
// ⚠ ITS HERO PANEL HAS NO CLOCK, and that is the design rather than a
// limitation. A live write head would need the worklet's `fillLevel`, which is
// not an AudioParam and is never posted; anything derived from
// `AudioContext.currentTime` would make the VRT baseline a race against boot
// latency. Every pixel is a pure function of the six macros, so the tile is
// deterministic on a frozen graph, a live graph and a silent rack alike — a
// stronger guarantee than #1420's freeze, which this face therefore does not
// depend on. (Its `meter` glyph is unlit at the lane tiers for the
// mixer/reverb reason: an insert with nothing patched outputs exactly zero.)

// FACE BATCH 4 · noise (2026-08-10) — the SMALLEST module in the registry to
// carry a face, and the entry that had to argue with its own spec to exist.
//
// `` returns a verdict of NO FACE ON
// MERIT, and its arithmetic is correct: one param, zero inputs, zero modes, so
// `faceTierCap` gives mini 1 and compact 2 and ALL FOUR TIERS RENDER THE SAME
// SINGLE KNOB. This face does not dispute that and does not dress it up.
//
// It is promoted anyway because the spec measures a faceplate by its TIER
// LADDER and this module's problem is not curation, it is that THREE TRUE
// FACTS ABOUT IT ARE STATED NOWHERE — and each is invisible to the one control:
//
//   · THE THREE TAPS ARE NOT LEVEL-MATCHED. One linear gain is written to all
//     three tap gains in the same `setParam`, and they leave the module at
//     white −4.77, brown −11.84, pink −17.08 dBFS (LEVEL 1) — a 12.3 dB spread
//     that `level`'s own readback is INVARIANT to, because it prints 0.50 for
//     all three. Three derived readouts, closed-form from the coefficients.
//   · BROWN IS A ONE-POLE LOW-PASS, NOT A SLOPE. Flat below ≈ 77 Hz, −6 dB/oct
//     above — and the corner MOVES WITH THE INTERFACE (70.5 Hz at 44.1 k,
//     153.6 at 96 k) because `LEAK = 0.99` carries no `sampleRate` term while
//     the table length does. The def, the DSP header and the module manifest
//     all said a flat "1/f², heavy low-frequency content"; all three are
//     corrected in this PR, and the sidebar picture draws the actual knee.
//   · BROWN HAS NO BOUND. White is clamped at 1 by its uniform draw and pink by
//     its ROWS+1 normaliser; brown is a random walk, and 118 of 200 seeded 2 s
//     tables peak ABOVE full scale at LEVEL 1 (median 1.021, worst 1.362).
//     `noise-dsp.ts` says "peak excursions stay comfortably under ±1 … verified
//     to ~64k samples" — the shipped table is 96 000.
//
// ⚠ THE PICTURE COULD NOT HAVE BEEN A HERO CELL, AT THE FAR END OF A CONSTRAINT
// TWO FACES HAVE NOW HIT. A panel's first legal rank is 7 (module-face-lint
// refuses a panel SELECTED at a lane tier, and the lane plate is six cells).
// meowbox reached that wall with five keys and drummergirl dropped its picture
// over it; noise has ONE key and can never approach it. The `custom` sidebar
// block carries no `face.order` key at all, which is what makes a picture
// possible on a one-param module — and is the general answer, not a workaround.
//
// ⚠ AND IT IS THE FIRST FACE WHOSE HERO EMPTIES ITS ONLY BAND. One ranked key,
// promoted to `hero.control`, leaves the page-less `__all` band with nothing in
// it, and `heroFacePlan` drops an emptied band. `dock-faceplate-model.ts` wrote
// that branch defensively — "a no-op on every face declared today … landed now
// so the first face that needs it does not have to discover it" — and this is
// the face that needs it. Its VRT roster entry is `pages: 0`.
//
// ⚠ FREE-RUNNING, LIKE analogVco AND macrooscillator, AND BROADBAND UNLIKE
// EITHER. All three tables `.start()` unconditionally at factory time, so its
// `meter` glyph is live from spawn; #1420's pre-frame freeze is what makes the
// tile capturable. The two existing witnesses are periodic (a saw at a fixed
// phase), so a mis-ordered freeze shows up on them as a PHASE difference —
// which is why macrooscillator catches it only intermittently. A broadband
// witness has no phase to land on. NOT YET MEASURED as such — the claim is a
// PREDICTION for `vrt-face-audio-probe` to settle, not a result.
//
// OWNER CONSTRAINT, 2026-08-10 ("preserve today's look"): the legacy card is
// pixel-unchanged, the module keeps one prominent LEVEL control and its three
// jacks, and nothing is renamed or recoloured. The one difference the first
// pass could NOT honour is the reason this face was held a release: a ranked
// param paints as `KnobConic`, so the dock showed LEVEL as a dial where the
// card draws a FADER — on a module whose whole visual identity is one centred
// throw. The owner's answer was the platform `fader` cell kind rather than an
// exception, and `noise` is its first consumer (`face.paramCells`); clouds,
// mixer and vca are fader cards too and inherit it when they are faced.

// FACE BATCH 5 · cofefve (2026-08-10) — the analog delay, PROMOTED from having
// no face at all, and the entry whose argument is that A FACEPLATE MUST BE ABLE
// TO SAY THAT A CONTROL IS WAITING ON ANOTHER CONTROL.
//
// FIVE of its twenty-three params are BIT-EXACTLY inaudible at the factory
// default and two more are within a percent of it — SEVEN asleep in all,
// because each is the dependent half of an ENABLER PAIR whose enabler ships
// closed. Nothing on the legacy card says so, so a new user turns a third of
// the panel and hears nothing. That is a legibility defect, not a DSP one: four
// of the five pairs are the ordinary correct convention (a depth at zero
// silences its rate, a feature off silences its shaping controls), and the
// face's job is to make the dependency VISIBLE — the ranking puts every enabler
// above its dependents, a five-line sidebar block names each pair's live state,
// four presets open all five enablers in one click each, and the hero counts
// what is currently asleep.
//
// ⚠ AND BAND HINTS DO NOT PAINT AT REST EITHER — which is worth recording,
// because the face was designed on the assumption that they do. `face.hint` and
// `face.title` being annotation-gated was known; `bandHeaderPlan` blanks EVERY
// band hint under the same flag, by the same owner directive. The declaration
// is present, module-face-lint's reachability clause is green, and the rendered
// dock shows six bare band labels. Only capturing the panel and looking at it
// showed that. So this face's argument rests entirely on the three surfaces
// that DO paint unconditionally — the hero count, the hero picture's captions
// and greyed WOW ripple, and the five-line sidebar block — and the band hints
// carry the MECHANISM as a fourth tier for annotation mode.
//
// ⚠ THE SAME LOOK-AT-IT PASS CAUGHT A SHARED-PRIMITIVE DEFECT, which this face
// deliberately does NOT fix. Three of the newly declared `options` rosters
// ellipsized in their `.seg` buttons (`SYS…`, `PING-P…`, `CIRCUL…`, `STATE…`)
// while `faces-parity` stayed green, because it reads `textContent` — the DOM
// says `Ping-Pong` while the panel paints `PING-P…`. The cause is measured on
// cofefve's def: `.seg` is `flex: 1`, i.e. flex-BASIS 0, so buttons split the
// group's max-content width EQUALLY and every caption gets exactly the roster
// MEAN — zero margin by construction, so the widest caption of any uneven
// roster always clips. It is ALREADY LIVE on cloudseed `pre`/`post`,
// warrensspectrum `LIVE`/`FREEZE` and tidyVco `-1`/`0`/`+1`. The one-line fix
// (`flex: 1 1 auto`) repaints those three modules' dock baselines, so it wants
// its own PR and an owner preview. Two caption workarounds were tried and
// MEASURED, and both failed: shortening `System` to `SYS` NARROWED the group
// and clipped `MIDI` harder, and equalising by character count still clipped by
// 1–3 px because equal characters are not equal pixels. Hunting a caption set
// that measures identically is calibrating against one renderer — the thing
// CLAUDE.md's frame-count rule exists to forbid — so the full names stay.
//
// ⚠ THE SPEC IT WAS BUILT FROM WAS WRONG ABOUT PAN, and the error was in the
// INSTRUMENT rather than the analysis — which is why it is recorded here.
// Measured with the SAME signal in both inputs, PAN MODE moves nothing at any
// setting of anything except PAN, from which "PAN is its enabler" follows and
// is false. PING-PONG swaps the two channels' FEEDBACK, and a swap of two equal
// things is the identity, so a probe feeding L and R the same waveform is
// structurally blind to the one mode that does not need PAN at all. Feed them
// different waveforms, or skew them with STEREO, and PING-PONG wakes at PAN 0
// (measured 2.31e-1 / 2.84e-1 against a bit-exact 0.00e+0 at pan alone). PAN
// MODE therefore has TWO enablers with different jurisdictions, both ranked
// above it, and the `ping-pong` preset opens STEREO and leaves PAN at 0 so the
// corrected fact is the one a click teaches.
//
// ⚠ TWO DEFECTS FIXED INLINE, both pure def/card. `syncPeriod` was declared as
// a user PARAM while being host-written 62 times a second by the factory's own
// `setInterval` — a control that cannot hold a value, and one that a COMPLETE
// face would have been obliged to paint. It is off the control surface; the
// worklet still declares it and the bridge still writes it, so no audio and no
// wiring changed. And `CofefveCard.svelte` re-typed 34 literal ranges the def
// already declares — the most of any card in its batch — so it is now bound
// through `paramSpec` and enrolled in RANGE_BOUND_CARDS + MAPPING_BOUND_CARDS,
// which is what makes the divergence visible to a gate at all.
//
// ⚠ ONE DEFECT DELIBERATELY NOT FIXED: DRIVE GAIN ships at 0.1 of 10, which is
// neither the DSP's own exact bypass (`driveGain <= 0` is an early return) nor
// an audible drive — a sliver of saturation at 1 % of the control's travel that
// leaves DRIVE MIX and DRIVE ITERATIONS with almost no authority. Whether that
// default is intended is an owner question, and changing it changes the
// module's shipped sound and re-pins its ART baseline, so it is DOCUMENTED (on
// the param, in the band hint, in the sidebar) rather than changed in a face PR.
//
// Every number this face prints is DERIVED and negative-controlled in BOTH
// directions in cofefve-face-model.test.ts, and the claims that are about audio
// are re-derived from the REAL worklet processor class on every run — so a DSP
// fix turns a stale claim RED instead of leaving the faceplate insisting on a
// repaired defect.

// FACE BATCH 4 · marbles (2026-08-11) — the rack's only RANDOM SOURCE, and the
// FIRST FACE AUTHORED UNDER THE NO-PROSE DIRECTIVE.
//
// Owner, 2026-08-11, on the shipped clouds faceplate: *"i really don't like any
// of this text… we should prefer almost zero AI authored text, and all future
// faceplate work should reflect that. our old faces are pretty self
// explanatory. i want to lose all the ai text, and bring back right click →
// annotate based on authored docs."* So this face has NO `hint`, NO band hints,
// NO explanatory captions and NO editorial band headers — six plain labels
// (`CLOCK`, `T GATES`, `T LOOP`, `X`, `QUANTISER`, `X LOOP`), a picture, and
// eleven bare values. Everything it learned is in the def's `docs`, one
// right-click away, and in the PR body.
//
// ⚠ marbles IS THE MODULE MOST TEMPTED TO NARRATE, which is what makes it a
// real test of that directive rather than an easy one: randomness genuinely
// cannot be read off knob positions. The answer taken here is to choose values
// that ARE the fact:
//
//   · `T random` / `X random` print `p = (2·dv − 1)²`, so DÉJÀ VU's travel
//     reads 100 % → 0 % → 100 %. That the MAXIMUM of the knob is not the
//     maximum of the behaviour is then visible by turning one dial.
//   · `T loop` / `X loop` print `free`, not `8 steps`, while their DÉJÀ VU is
//     0 — because LENGTH is BIT-EXACTLY inert there, and that is the shipped
//     default. The picture does the same thing in pixels: one slot, not eight.
//   · `glide 0 %` and `quantiser off` sit next to each other at the shipped
//     STEPS 0.50, which is the whole story of that dial's dead gap.
//
// ⚠ THE SPEC IT WAS BUILT FROM WAS WRONG FOUR TIMES, every one the same failure
// — probing a random process at ONE SEED on a coarse grid — and the corrections
// are recorded on the def. The headline: it reported the T loop as SATURATED
// across the top half of DÉJÀ VU while only the X loop was non-monotone. BOTH
// are non-monotone and both peak at exactly 0.5; the saturation was an artifact
// of `length 4` plus an IOI-tolerance metric on a seed whose four slots
// happened to sit on one side of the gate threshold. The oracle measures the
// per-clock GATE WORD at the shipped length 8 instead, which has neither
// problem.
//
// ⚠ ONE DEFECT DOCUMENTED, NOT FIXED: `t_model` 1 (CLUSTERS) is a two-line
// commented STUB that falls through to the COIN generator, in both the worklet
// core and the host mirror — bit-identical `t1` AND `t2` at three separate
// biases, with DRUMS as a passing control. Implementing it means porting the
// firmware's cluster generator, which changes audio and re-pins nothing that
// exists yet (there is no `art/baselines/marbles/`), so it is its own PR. The
// faceplate prints `CLUSTERS → COIN` rather than painting a dead model as a
// working one.
//
// ⚠ AND IT DECLARES NO GLYPH, which is the one finding this face made about
// ITSELF. It shipped `glyph: 'meter'` through three passes on the reasoning
// that marbles free-runs and a meter is what a 64 px tile can honestly say —
// until the binding was read rather than assumed. `primaryAudioOutPortId`
// matches `type === 'audio'`, and marbles declares none: t1/t2/clk are `gate`,
// x1/x2/x3 are `cv`. `glyphBinding` therefore returns `{ kind: 'static' }`,
// `tap` is undefined, and `<VuMeter>` falls back to its `level = 0` default —
// twelve segments that can never light, on the busiest module in the rack. It
// also means marbles is NOT a witness for #1420's audio freeze, which the same
// draft claimed: it free-runs, but nothing on the face was ever reading it.

// FACE BATCH 4 · resofilter (2026-08-11) — the clean multi-mode filter, and the
// SECOND face authored under the owner's no-prose ruling. (It was authored
// concurrently with `marbles` above, which landed first; the two branches
// reached the same shape independently, which is the useful part — the ruling
// is specific enough to converge on.) Nothing on this panel is a sentence: no
// `face.title`, no `face.hint`, no band caption, and no signal-flow block —
// that last one struck by the same day's SEPARATE ruling ("lets stop doing
// these and clean up the existing ones"), and it would have been a poor block
// here regardless, since one SVF whose five modes are taps off one shared state
// is one box rather than a chain. The band header is a plain label and every
// readout is a value and a unit. Everything explanatory went into `docs`, which
// is what right-click → annotate already reads.
//
// ITS ONE ARGUMENT: RESONANCE is a single dial setting a single number
// (`k = 2 − 2·res`, floored at 0.003) that becomes a different KIND of quantity
// in each mode, and no surface on the module said so. A `resonance` readback
// prints `0.30` in all five states while the player hears
//
//   LP · HP   a PEAK at cutoff, exactly 1/k — measured −6.02 / −2.92 / +1.94 /
//             +13.98 / +33.98 / +50.46 dB at res 0 / .3 / .6 / .9 / .99 /
//             ≥.9985, identical in both modes and at every cutoff 50 Hz–15 kHz
//   BP        that peak AND the band's −3 dB width
//   NT        WIDTH ONLY — the notch is a TRUE ZERO at cutoff at every
//             resonance, and the dial runs 2.53 → 0.004 octaves, which a
//             broadband level metric reads as 0.55 dB of nothing at all
//   AP        NEITHER — magnitude is exactly 1 at every frequency and every
//             resonance (span 0.00 dB over the whole travel) while `max|Δ|`
//             runs 9.3e-4 → 1.4e0. A pure phase rotation, invisible to every
//             level-based instrument in the repo.
//
// The face says that with TWO readouts that are each other's negative control
// — `peak` live in LP/HP/BP, `width` live in BP/NT/AP — plus a sidebar picture
// that switches to PHASE in allpass, because a magnitude plot there is a flat
// line, i.e. a picture certifying that a live control is dead.
//
// ⚠ FOUR OF THE SPEC'S NUMBERS DID NOT SURVIVE RE-MEASUREMENT, and two of them
// were the same mistake twice: a Q≈333 filter read before it had settled.
// `` reports the plateau gain
// as 50.441 dB and back-derives an "implied k_min ≈ 0.003006" from it — but
// `resToK` floors k at EXACTLY 0.003 (50.4576 dB), and the measurement
// converges there on a 2 s render (50.4547 / 50.4576 / 50.4576 / 50.4576 dB at
// 1 / 2 / 4 / 8 s). It likewise reports the notch as "50 dB deep and zero
// octaves wide" at resonance 1.0: −68.0 dB on a 1 s render, −154.9 dB on 4 s
// and 16 s. The notch is a true zero at every resonance. Its "18 of 60 corners
// exceed full scale" does not reproduce and cannot — the count is a property of
// which 60 corners (9 on a plausible grid) — so the face publishes the robust
// form instead: +50.46 dB of peak gain with nothing limiting, i.e. a −6 dBFS
// sine leaving at +44.46 dBFS. And its L/R dB figures do not reproduce while
// its `max|L−R| = 5.281e-1` does to the digit, so the CLAIM holds and only the
// reference level differed. Everything else in the spec reproduced unchanged.
//
// ⚠ AND THE SPEC'S ONE STATED BLOCKER WAS NOT ONE. It calls declaring `options`
// on MODE "a contract change (task docs:accept)" costing "+5 contract-lock
// lines". `contract-signature.ts` projects id/min/max/curve/default/units and
// nothing else, so naming a value moves ZERO lines — measured, contract-lock is
// byte-identical across this PR. Declaring it also let the def stop
// hand-duplicating `RESOFILTER_MODE_NAMES` — the copy's stated reason (an SSR
// `sampleRate` import) was false; the DSP lib takes `sr` as an argument
// everywhere.
//
// ⚠ THE SPEC'S OTHER WARNING ABOUT `options` RE-MEASURES **TRUE**, AND THIS
// FACE'S FIRST ANSWER TO IT WAS WRONG. It says filter's three two-letter
// captions already render `LP · H… · B…` at the dock — screenshotted on `main`,
// they do. The first draft here argued a five-caption roster was SAFE because
// an EVEN roster splits evenly and therefore cannot clip. The pixels say
// otherwise: the MODE cell is 182.5 px, `.seg` is `flex: 1 1 0%` → 31 px per
// button → 15.0 px of content box, and the captions lay out at LP 14.13 ·
// HP 16.02 · BP 15.11 · NT 15.72 px, so THREE OF FIVE clip (`H…`, `N…`, `A…`).
// Evenness was never the mechanism; total width is. The deficit is 0.1–0.4 px
// — ONE more pixel of button width fits all five.
//
// ⚠ AND EVERY CHEAP INSTRUMENT CALLED IT CLEAN. `scrollWidth === clientWidth`
// on all five (a one-line ellipsis leaves no overflow); a canvas `measureText`
// at the computed font returned 12.92 / 14.80 / 13.91 / 14.52 px, all under
// 15.0, because `measureText` DROPS `letter-spacing` — 0.6 px × 2 chars is
// exactly the 1.2 px it misses against a Range measurement; and `faces-parity`
// reads `textContent`, which an ellipsis does not change. A 3× screenshot of
// the cell is what found it. It ships anyway, because every alternative a face
// can reach is worse: without `options` the control is the `0.00`…`4.00` rotary
// this declaration exists to remove, `paramCells: 'grid'` hides the roster
// behind a chip, and the real fix (`.seg { flex: 1 1 auto }`) repaints five
// other modules' dock baselines and wants an owner preview.
//
// ⚠ TWO THINGS THE FACE DOCUMENTS RATHER THAN FIXES, both because they are
// contract or DSP changes that want their own PR and re-pin:
//   · `cutoff_cv` declares `cvScale: 'linear'` on a LOG-tapered param, so the
//     CV adds ±9990 **Hz** and clamps. From 1 kHz that is 5.64 octaves down and
//     3.46 up; at the 20 Hz bottom of the dial it cannot travel down AT ALL.
//     38 of the registry's 44 log-curve CV targets declare `log` (symmetric at
//     ±4.98 oct), including the qbrt and moog904c cutoffs. The `cv reach`
//     readout STATES the window.
//   · nothing limits the +50.46 dB peak. A DSP question with an ART re-pin.
//
// ⚠ AND ONE DELIBERATE NON-FIX ON THE CARD, WHICH THE GATES ARGUED WITH.
// `ResofilterCard.svelte` is now range- AND mapping-bound, and one of the five
// bound props is a NO-OP: MODE passed `curve="linear"` where the def says
// `discrete`, and `Knob.svelte` branches on `log`/`exp` only, so `discrete`
// falls through to linear and nothing renders differently. The first attempt
// left it unbound on exactly that reasoning (CLAUDE.md's "check the consumer
// reads it") and `card-range-source`'s curve-AGREEMENT clause refused, rightly:
// a range-bound card is CERTIFIED def-bound, and "this disagreement happens to
// be harmless" is the argument that lets the next one not be. What the binding
// does not do is make MODE detented. That needs the PRIMITIVE — the five-state
// Segmented the def now declares `options` for, which the DOCK renders — and
// swapping it on the card would move the `resofilter` vrt.spec baseline by
// roughly the 865 px #1213 measured for the identical swap on filter: UNDER
// DOCK_MAX_DIFF, therefore invisible to the gate AND unrepinnable by
// `--update-snapshots`. Its own PR, with an owner preview and a `git rm` first.
// The card is otherwise pixel-unchanged.

// FACE BATCH 4 · rings (2026-08-11) — the exciter-driven RESONATOR, PROMOTED
// from having no face at all, and the entry whose argument is that A MODULE
// THAT CANNOT BE SOUNDED IS NOT A FACEPLATE PROBLEM UNTIL SOMEONE LOOKS.
//
// rings is a BODY, not a voice. With nothing patched and nothing struck the
// output is not "quiet", it is EXACTLY ZERO — measured peak 0.000e+0 on both
// taps in both models over a 1 s render of the shipping worklet; the
// Float32Arrays are untouched. And until this PR the module could not be
// struck from ANY surface: `RingsCard` had a MODEL button, six faders and a
// jack field, and no strum. A user who spawned RINGS and turned all seven
// knobs heard nothing, with no indication why. That is the sixstrum defect on
// a legacy card rather than on a face, and it is fixed here on BOTH surfaces
// through ONE seam — a `strumCs` ConstantSource on worklet input 2 plus the
// factory's `manualTrigger` read key, the karplus pattern verbatim.
//
// ⚠ THE SPEC IT WAS BUILT FROM WAS STALE IN FOUR PLACES, and re-measuring
// first is the only reason this face does not repeat them. `strum` was said to
// declare no `edge` — it declares `edge: 'trigger'` and has since #1436. The
// ODD/EVEN separation was given as "116 dB, every bin" — measured per bin
// h1..h8 it is 129 / 124 / 113 / 110 / 110 / 110 / 98 / 84, so the honest
// figure is 84 dB at the worst bin and 116 is not the minimum of the spec's
// own table either. A claimed peak-find artifact at structure 0 does not
// reproduce (EVEN's h2 beats its h4 by 1.7 dB, as the spec's own §1 table
// already showed). And SYMPATHETIC's T60 was said to go back UP at high
// damping; measured it plateaus (490 / 342 / 340 ms at damping .5 / .75 / 1)
// rather than reversing. Everything else in it reproduced to the digit,
// including the mirror-symmetry table, the 5.37 dB model step and the 0.107 dB
// limiter no-op.
//
// ⚠ AND THE READOUT THIS FACE MOST WANTED IS NOT ON IT. Two knobs set the ring
// time and only one says so — BRIGHTNESS is documented as a tone control and
// moves T60 25x at a fixed DAMPING — but the number cannot be printed
// honestly: MODAL's T60 depends on the INTERFACE SAMPLE RATE, measured
// 3889 / 7420 / 476 ms at 44.1 / 48 / 96 kHz for one fixed pair of settings,
// because the decay constant is `q/(pi*sampleRate)` with no compensating term.
// The ratio is no better (18.2x / 25.3x / 3.4x). So the finding is carried by
// the band LABEL, which paints unconditionally where a hint does not, and the
// rate dependence is documented on the def as the DSP defect it is — a patch
// saved at 48 k is a different instrument at 96 k. Fixing that moves audio, so
// it is not folded into a faceplate PR.
//
// Its hero picture reaches `hero.cell` where meowbox's and noise's could not:
// a panel's first legal rank is 7 and rings has nine rankable keys, so the
// pickup comb is a real hero cell rather than a sidebar consolation.
//
// ⚠ IT SHIPS WITH NO SIDEBAR AT ALL, and that is the second owner directive
// this face absorbed mid-build. It carried one `signal-flow` block; the owner,
// looking at analogVco's, ruled the genre out entirely — "this really isn't
// accurate. lets stop doing these and clean up the existing ones, get rid of
// them." So the block is gone and NOTHING replaced it: an empty sidebar is
// reported as empty rather than padded with filler. Seven faces already ship
// this way (adsr, karplus, mixer, delay, reverb, tomtom, qbrt).
//
// The two directives are one rule. A faceplate states values; the explanation
// — the chain, the measurements, the two-knobs-set-the-decay finding — lives in
// `docs` for right-click → annotate. A stage list is additionally the surface
// most likely to go stale: a hand-maintained picture of code that moves
// underneath it, with no gate able to notice.
//
// ⚠ OTHER FACES STILL DECLARE `signal-flow`, so the shared renderer STAYS
// until the fleet sweep (#1468) lands — deleting it here would blank their dock
// panels in a faceplate PR for one module. Deliberately NOT stating how many:
// that is a population count, it goes stale the moment #1468 lands a partial,
// and `grep -l "kind: 'signal-flow'"` answers it against the tree.
// FACE BATCH 6 · sidecar (2026-08-14) — the stereo sidechain DUCKER, the first
// entry of the resumed queue, and the entry whose argument is that A MODULE CAN
// BE ENTIRELY CORRECT AND STILL BE UNREADABLE FROM ITS OWN CONTROLS.
//
// The audit found no dead control, no unexposed DSP capability and no
// card/def range disagreement. What it found is that FOUR of the nine faders
// print a number that is not the answer, and in each case the knob is not
// merely incomplete but INVARIANT to the thing that decides it:
//
//   · THRESHOLD IS NINE dB FROM WHERE DUCKING ACTUALLY STARTS, for two
//     independent reasons it cannot show. The detector is a stereo-linked sum
//     of rectifiers (`|aL| + |aR|`), so a mono main normalled to both channels
//     reads exactly 20·log10(2) = 6.0206 dB above its own peak — measured at
//     three amplitudes, the offset is that value every time — and the soft KNEE
//     opens `knee/2` BELOW the threshold (onset −17.99 / −19.49 / −20.99 /
//     −23.99 / −29.99 dB at knee 0 / 3 / 6 / 12 / 24, i.e. `threshold − knee/2`
//     to the hundredth). The dial says −18.00 in all of them.
//   · RATIO IS BLIND TO THRESHOLD, and the dial is badly non-linear in its own
//     top half: 0 / −12.010 / −18.015 / −21.018 / −22.820 dB at 1 / 2 / 4 / 8 /
//     20 against a full-scale mono main, so the last two thirds of the travel
//     buy under 2 dB.
//   · INPUT LVL AND MAKEUP ARE THE SAME DIMENSION, EXACTLY. `compressor-dsp`
//     step 9 multiplies the sidechain by both and `duckLin` is computed from
//     the MAIN pair alone, so the ordering is irrelevant: `inLvl 2 / makeup 0`,
//     `inLvl 1 / makeup 6.0206` and `inLvl 0.5 / makeup 12.0412` render
//     bit-identically. Neither readback can print the sidechain's real gain,
//     and at `inputLevel` 0 the path is silent whatever MAKEUP says.
//   · ENVMAG PRINTS 1.00 WHETHER ENV IS DEAD OR OVERSHOOTING. It is
//     audio-invariant (bit-identical output RMS at 0 / 0.5 / 1 / 2 — which is
//     why it is ranked LAST of nine), and its output is unclamped, so ENV
//     passes 1.0 whenever the reduction passes 24 dB. Measured 1.6889–1.7044 at
//     the DEFAULT envMag of 1.
//
// ⚠ THE MOST IMPORTANT FACT ABOUT THE MODULE IS ONE THE FACEPLATE IS
// STRUCTURALLY UNABLE TO STATE, and it is recorded here rather than faked.
// Measured: with the SIDECHAIN pair unpatched the output is BIT-IDENTICAL with
// every one of the nine controls at either extreme (0.003926950, 0.007853659,
// 0.011779882, 0.015705380 in both; peak 0.500000000 in both) — the box is a
// wire and the whole panel is inert. With the MAIN pair unpatched the reduction
// is exactly 0.000000 and six of the nine are inert. A `FaceReadoutValue` is
// `(read) => string` over PARAMS and can never observe a cable, so this went
// into `docs` (where right-click → annotate reads it) and NOT into a readout
// that would have had to guess. The readouts instead name their operating point
// in their own labels — `@ FS` is a full-scale mono main.
//
// ⚠ THREE DOCUMENTATION DEFECTS FIXED INLINE, all measured, none of them audio:
// `makeup` was documented as "a fixed OUTPUT gain … to bring the overall level
// back up" and provably is not (output bit-identical at 0 / 12 / 24 dB with the
// SC unpatched — it gains the ducked sidechain only); the ENV overshoot was
// documented as something that happens above envMag 1 when it happens at any
// envMag > 0; and `inputLevel` declared `units: '%'` on a 0..2 range — the ONLY
// such param in the registry, every other `%` param being 0..100 — so a
// faceplate would have painted `1.00 %` where the module means 100 %. That one
// is fixed with a `format` rather than by rescaling the range: the worklet's
// parameterDescriptor is 0..2 and every saved rack holds a 0..2 value, so
// moving the range would be an audio-affecting migration for a display bug.
//
// ⚠ AND ONE DEFECT THE FACE'S OWN ORACLE CAUGHT IN THE FACE ITSELF. Two
// bit-identical INPUT LVL / MAKEUP states printed `0.0 dB` and `-0.0 dB`,
// because `fmtDb` branches on `v > 0` and `20·log10(0.5) + 6.0206` evaluates to
// −2.8e-10. The readout that exists to show the two knobs are interchangeable
// was printing two different strings for the same state. `snapDb` fixes it and
// the equivalence is now an assertion rather than a claim.
//
// Every number above is RE-DERIVED on every run by sidecar-face-model.test.ts
// against the shipping `packages/dsp/src/lib/compressor-dsp.ts` — including a
// negative control on the ORACLE ITSELF (a deliberately mis-scaled knee term
// must redden the same comparison), so a DSP fix turns a stale faceplate claim
// red instead of leaving the panel insisting on a repaired defect.

// THE FACEPLATE QUEUE · Q11 — NINE LIVES, the ⅓-ladder modulation fan-out
// (2026-08-15), and the entry whose whole argument is that A KNOB CAN BE
// CORRECT AND STILL BE INVARIANT TO THE MODULE.
//
// §1 of the queue ranked the pool by PARAM COUNT and this module — 2 params, 1
// input, 9 outputs — is a rejection on that measure. It is the `noise` case
// verbatim: one dial, promoted because several stated facts about its taps are
// unprintable from it. RATE prints ONE frequency for NINE outputs 6561× apart.
// Measured through THIS module's own factory, port id by port id, at the
// shipped Rate of 1 Hz: out1 1.00 s, out5 1.4 min, out8 36.5 min, out9 1.8 h —
// and at the bottom of the dial (0.01 Hz) out9's cycle is 7.6 DAYS.
//
// ⚠ THE AUDIT'S SHARPEST FINDING IS ABOUT THE GLYPH, and it is the `noise`
// lane-meter hazard answered rather than repeated. With nine outputs, ANY
// analyser-backed glyph reads exactly one of them and paints it as the module.
// Here `primaryAudioOutPortId` returns NULL — every output is `cv`, so there is
// no audio output to resolve — which means `glyph: 'meter'` would have given
// `{ kind: 'static' }`, no tap, and twelve VuMeter segments that can never
// light: the marbles defect, verbatim, on a module with nine jacks. The face
// declares `'waveform'` instead, which resolves `{ kind: 'wave-morph' }`: a
// PARAM-DERIVED single cycle of the `shape` morph, tapping nothing. That is
// honest here for a module-specific reason — the waveform is genuinely SHARED
// by all nine taps, so the picture is of every output rather than one of them.
// Both halves are permanent legs of `ninelives-face-model.test.ts`.
//
// ⚠ AND THE ⅓ LADDER RE-MEASURED **TRUE**, which is the result the queue's own
// warning said not to assume. `art/scenarios/ninelives/ladder.test.ts` drives
// the shipped worklet through the def's factory in a real OfflineAudioContext
// and reads each DECLARED port's rate by unwrapped phase slope (a saw at
// `shape 1` IS the phase, so the same estimator resolves 100 Hz and 0.0152 Hz
// with one code path — a Goertzel cannot see out9 at all in a 1 s window).
// Every rung lands within 2.5e-7 relative of `rate × (1/3)^(n-1)`. Before this
// scenario NOTHING joined the factory's port map to what the processor writes:
// the module unit test pins the map against its own arithmetic, the DSP unit
// test indexes a scratch array with no port ids in it, and the ART profile
// drives the PROCESSOR CLASS with its own `out1..out9` literal.
//
// ⚠ TWO THINGS CORRECTED, NEITHER AUDIO. The def, its DSP core header, its
// `docs` and the module manifest all said out1 is "IDENTICAL to a normal LFO",
// unqualified. It is bit-identical at the LFO's shipped `depth` default (0.5,
// where the LFO's own `depth·2` scaling reaches unity) and at NO other depth —
// NINE LIVES has no depth control, so every tap is a fixed full-scale ±1. Both
// halves are permanent ART legs. And the def carried `const OUT_COUNT = 9`
// beside a nine-entry `outputs` literal while `ninelives-dsp.ts` sized the
// processor's loop off its own `NINE_LIVES_OUTPUT_COUNT` — two unjoined copies
// of the ladder length, where a disagreement publishes silently dead jacks. The
// def now imports the DSP constant and derives the roster from it, so the
// disagreement is unrepresentable rather than merely untested, and the
// hand-typed count is gone. `contract-lock.txt` is byte-identical across it.
export const STRICT_FACES: ReadonlySet<string> = new Set<string>([
  // P1 batch 1 — first 6 module faces
  'adsr',
  'cloudseed',
  'kickdrum',
  'lfo',
  'tidyVco',
  'vca',
  // P1 batch 2 — 6 more faces (2 pitched voices, 2 drums, 2 processors)
  'dx7',
  'qbrt',
  'shimmershine',
  'sixstrum',
  'snaredrum',
  'tomtom',
  // P1 batch 3 — 5 more faces (1 voice, 4 processors/utility)
  'delay',
  'filter',
  'karplus',
  'mixer',
  'reverb',
  // face batch B+ — the stereo crush (first promotion from no face at all)
  'ringback',
  // FACE BATCH 3 (2026-08-03) — see the header note above.
  'clap',
  'drummergirl',
  'pentemelodica',
  // FACE BATCH 3, cont. (2026-08-08) — see the header note above.
  'meowbox',
  // FACE BATCH 3 · the recovered free-running oscillator (2026-08-08).
  'analogVco',
  // FACE BATCH 3 · the fourteen-engine macro voice (2026-08-09).
  'macrooscillator',
  // FACE BATCH 3 · the DTMF dialer (2026-08-09) — see the header note above.
  'bluebox',
  // FACE BATCH 3 · the 3-D wavetable navigator (2026-08-10) — see below.
  'cube',
  // FACE BATCH 4 · the granular texture processor (2026-08-10) — see above.
  'clouds',
  // FACE BATCH 4 · the three-tap noise source (2026-08-10) — see above.
  'noise',
  // THE FACEPLATE QUEUE · Q29 — the 4x4 hard router (2026-08-18). Four
  // selectors, eight inputs, four outputs, one idea repeated four times.
  //
  // ⚠ THE AUDIT'S FINDING IS A CONTROL LOSS THAT PROMOTION WOULD HAVE CAUSED,
  // and it is the STOP-2 class the skill's grep is blind to because the
  // affordance is not a `<button>` — it is a DECLARATION THAT WAS NEVER MADE.
  // `sel1..sel4` are `curve: 'discrete'` with NO `options` roster, so nothing in
  // the def says what any of the four positions is CALLED. The legacy card
  // answered that in markup (`← IN {value + 1}`), and promoting the module
  // removes that card from both surfaces — so the faceplate would have rendered
  // four dials reading 0..3, on the module whose entire job is "which input",
  // with nothing anywhere naming an input. Every gate is green either way:
  // `contract-lock` pins min/max/curve (a roster is cosmetic and not
  // projected), `module-face-lint` counts CELLS not names, and the card's own
  // test asserts the markup it hand-wrote. Fixed in this PR by declaring the
  // roster ONCE in `fourplexer-select.ts` and having BOTH the def and the card
  // read it — which also makes `paintsReadout` true, so the dock gets a named
  // button row and the lane dial paints `IN 2` instead of `2`.
  //
  // ⚠ NO GLYPH, AND IT IS FORCED RATHER THAN CHOSEN. Every output is typed
  // `cv`, so `primaryAudioOutPortId` returns NULL and every glyph kind falls
  // through to `{ kind: 'static' }` — the #1692 dead-glyph shape the lint
  // refuses by name. This is `moog921a`'s situation, and like it the assertion
  // lives in the module's face-model test with a negative control rather than
  // in a comment.
  //
  // NOT CONTROL-HEAVY, measured against the 2026-08-18 tabbed-face ruling: four
  // params at ONE distinct control shape (`discrete 0..3`), and one honest idea
  // to group them into. "Lots of controls of different types" is the bar and
  // this module is the opposite of both halves of it, so it takes a single
  // unlabelled band rather than a rail.
  'fourplexer',
  // FACE BATCH 5 · the analog delay (2026-08-10) — see the header note above.
  'cofefve',
  // FACE BATCH 4 · the random source (2026-08-11) — see the header note above.
  'marbles',
  // FACE BATCH 4 · the clean multi-mode filter (2026-08-11) — see above.
  'resofilter',
  // FACE BATCH 4 · the exciter-driven resonator (2026-08-11) — see above.
  'rings',
  // THE FACEPLATE QUEUE · Q6 — the 4-channel attenuating mixer (2026-08-14).
  //
  // The queue called this one MARGINAL on merit and it clears STOP 1 on the
  // half the rule cares about: the refusal needs ALL of ≤2 params / no control
  // families / no node.data affordances / no derived quantity worth a readout,
  // and this module fails the first and the last. Its four channel knobs ARE
  // interchangeable (the bluebox problem — a priority order over four identical
  // controls carries no information), so the ranking is by LAYOUT and the
  // INFORMATION moved to three derived readouts, each a join over five knobs
  // that no single readback can perform. The load-bearing one: at the shipped
  // defaults every attenuator is 0 and the mix bus is BIT-EXACTLY SILENT while
  // MASTER reads a confident `1.00`.
  //
  // Audited before authoring (the #1661 swolevco class): all four declared CV
  // inputs MOVE THE AUDIO through the CV path, measured on the shipping worklet
  // at the input index the DEF publishes, each paired with a knob positive
  // control, a bit-exact knob/CV equivalence leg and an instrument negative
  // control. attenumix cannot fail that way by the same mechanism — its
  // `cv1..cv4` are audio-rate worklet INPUTS, not `paramTarget` AudioParam
  // shadows — and `attenumix-cv-path.test.ts` now asserts both halves of that
  // sentence permanently, including that no attenumix input ever becomes one.
  'attenumix',
  // FACE BATCH 6 · the stereo sidechain ducker (2026-08-14) — see above.
  'sidecar',
  // FACE BATCH 6 · the two-engine spectral resynthesizer (2026-08-15).
  //
  // ⚠ THE PROMOTION IS GATED ON A PANEL, not on the face. This module's
  // 8-band FILTERBANK is `node.data`, not ParamDefs, and before this batch its
  // ONLY editor was `WarrensspectrumCard.svelte` — which promotion removes
  // from both surfaces. Shipping the face without `WarrensspectrumBankPanel`
  // would have made the bank unreachable: the samsloop failure, on a module
  // that has a live bank rather than an absent sample. The panel is registered
  // as the `ws-filterbank-{n}` shell cell and carries a `data` probe on
  // `wsBands[0].send`, so a dead editor is red rather than merely invisible.
  //
  // ⚠ AND THE AUDIT CAME FIRST. All six declared `paramTarget` CV inputs were
  // verified LIVE through the CV path — not the knob path — before a line of
  // face was written (`art/scenarios/warrensspectrum/cv-path.test.ts`), because
  // the two modules audited before it were both defective (#1661, #1662).
  'warrensspectrum',
  // THE FACEPLATE QUEUE · Q9 — the timbre-sweep oscillator (2026-08-15).
  //
  // A free-running voice — the third in the roster, after analogVco and
  // macrooscillator. Everything the header note above says about #1420 applies
  // here and is the reason this is not a repeat of the analogVco drop:
  // `bootWithFace` suspends the graph before the tile is framed, so a live
  // `scope` glyph reads zeros like every struck sibling. The glyph is kept — on
  // a WAVETABLE oscillator the trace is the readout of the control the hero
  // promotes. It is NOT a third freeze-ORDERING witness; see the roster entry
  // in `_shell-faces.ts` for what has and has not been probed.
  //
  // ⚠ THE AUDIT CAME FIRST, and for once it found nothing: all five declared
  // `paramTarget` CV inputs move the audio through the CV path
  // (`art/scenarios/wavetable-vco/cv-path.test.ts`), and the KNOB and CV legs
  // agree to every printed digit on every row — the strong form, since it says
  // the CV terminal is the SAME terminal the knob writes, not merely a live
  // one. That result is only worth anything because the sweep carries its
  // positive controls (a GainNode leg, a worklet-AudioParam leg, and a per-input
  // knob leg) permanently; a green sweep with no controls is indistinguishable
  // from a sweep that measured nothing.
  //
  // ⚠ IT DID FIND A LIVE CARD/DEF DIVERGENCE, and this PR is what pays it.
  // `WavetableVcoCard` passed `min={0}` on `fmAmount`/`pmAmount` where the def
  // declares `-1` — the analogVco backdraft class, so the documented polarity
  // inversion was unreachable from the card while the def-driven dock face
  // reaches all of it. It sat in `OPERATIONAL_DEBT` with a stated release
  // condition ("rides a PR that also carries the vrt-update.yml dispatch"), and
  // a face PR is definitionally that PR: the card is now `paramSpec`-bound, the
  // debt entry is DELETED rather than re-worded, and the card baseline is
  // re-captured by this branch's dispatch.
  'wavetableVco',
  // THE FACEPLATE QUEUE · Q11 — the ⅓-ladder modulation fan-out (2026-08-15).
  // See the header note above.
  'ninelives',
  // FACE BATCH 6 · the four-stage destructive echo (2026-08-15).
  //
  // ⚠ THE FACE EXISTS BECAUSE TWO OF THE FIVE DIALS ARE A STABILITY BOUNDARY
  // WEARING THE LABELS OF TASTE CONTROLS. The four AnalogDelayCore stages are in
  // SERIES and each carries an in-loop tanh drive whose small-signal gain is
  // `1 + DECAY·(1+stage)·0.8` — up to 4.20 at the last stage — and that
  // multiplies the feedback INSIDE each stage's own loop, so `FEEDBACK_MAX =
  // 0.995` does not bound it. The module stops decaying at
  // `FEEDBACK · 0.995 · (1 + DECAY·3.2) = 1`; the shipped default sits at 0.82,
  // i.e. 0.11 of DECAY or 0.11 of FEEDBACK from a patch that rings forever. The
  // card said none of it and no gate could: it is a VALUE, and every gate here
  // reads a DECLARATION.
  //
  // ⚠ AND A SPEC CLAIM WAS MEASURED AND REFUTED BEFORE IT WAS SHIPPED. The
  // batch-6 spec asserted the boundary is a function of DELAY too (a bisected
  // table sliding 0.318 → 0.208 of DECAY across the travel). That bisection used
  // a LEVEL threshold over a fixed-length render — an instrument that cannot
  // separate "does not decay" from "decays slowly", and a longer tape decays
  // slower in wall-clock time by construction. Under a RATE instrument (dB/s
  // between two late windows) the boundary is loop gain 1.000 at 0.02 s, 0.15 s,
  // 0.6 s AND 1.5 s. The `margin` readout is a closed form rather than a 3-D
  // interpolation over an artifact because of that correction.
  //
  // ⚠ AUDITED BEFORE AUTHORING (the #1661/#1662/#1664 class). This module
  // declares exactly ONE `paramTarget` CV input, and a one-row sweep is where
  // the audit is cheapest to skip: `art/scenarios/charlottes-echos/cv-path.test.ts`
  // drives the DEF's OWN FACTORY under node-web-audio-api and asserts not only
  // that the cable moves the audio but that `CV(+Δ)` and `KNOB(base+Δ)` are the
  // SAME RENDER TO THE BIT — a live jack wired to the wrong terminal passes the
  // movement leg and fails that one. It found no defect, which is a result.
  'charlottesEchos',
  // THE FACEPLATE QUEUE · Q13 — BUGGLES, the wogglebug (2026-08-15): the chaos
  // DISTRIBUTOR, and the entry whose argument is that FIVE JACKS CANNOT BE
  // SUMMARISED BY A PICTURE OF ONE.
  //
  // 5 params, 3 inputs, 5 outputs. It rolls ONE random decision per woggle tick
  // and sprays five correlated views of it — slewed, stepped, the tick as a
  // gate, a probabilistic ratchet of that tick, and the slewed voltage
  // ring-modulated — so the whole patch drifts together because it all came
  // from the same roll. RATE reaches all five and prints none of them: it is a
  // normalised 0..1 dial over a LOG map spanning 500x.
  //
  // ⚠ THE GLYPH DECISION IS THE ninelives HAZARD WITH THE OPPOSITE PORT SHAPE,
  // and it is a measurement. ninelives could not resolve a tap at all (every
  // output `cv`, so `primaryAudioOutPortId` returned NULL). Here exactly one of
  // five jacks is typed `audio` — RING — so ANY glyph but 'none' resolves
  // `{ kind: 'live-audio', portId: 'ring' }` and paints one fifth of the module
  // as the module. And it could not even paint that: the shell's tap is
  // GLYPH_TAP_FFT_SIZE = 2048 samples ~ 42.7 ms, while RING's carrier at the
  // shipped RATE is 0.30028 Hz — a 3.330 s period, so the window is 1.3% of ONE
  // CYCLE, and 53% at the very top of the dial. The picture would be a creeping
  // line at every knob position, resolving LIVE, so no gate would flag it. The
  // face declares `glyph: 'none'` and spends the picture's budget on a FIVE-ROW
  // OUTPUT TABLE instead — one row per declared jack, each depending on a
  // different subset of the knobs. Both halves are permanent legs of
  // `buggles-face-model.test.ts`, including the control that 'scope' HERE would
  // have tapped `ring`, so the 'none' is a decision rather than an omission.
  //
  // ⚠ AUDITED BEFORE AUTHORING, and it found TWO live defects — see the
  // preceding commit. `external_clock` captured 16.7% of the rising edges a
  // player sent (a 0.667 ms analyser ring against a 33 ms poll), FLAT across
  // every clock rate, because the answer is geometric; it now uses the shared
  // windowed `createEdgeCounter` and captures 100.0%. And RING was documented
  // as "audio-rate ... patchable straight into the audio path" in four places
  // while its carrier tops out at 12.5 Hz, under the floor of hearing — the
  // #1701 false-VALUE class, invisible to `contract-lock` (which pins `ring` as
  // `type: 'audio'`, correctly) and to the one ART leg named for RING, which
  // mirrors the construction at 200 Hz, 667x above the real carrier.
  'buggles',
  // THE FACEPLATE QUEUE · Q12 — the two fixed filter banks, promoted as a PAIR
  // (2026-08-15). They share `moog-filterbank-dsp`'s centre grid and
  // `buildFilterBank`'s wiring verbatim and differ only in which slice they
  // import, so they share ONE faceplate model
  // ($lib/ui/modules/moog-filterbank-face-model) and one rank law. Authoring
  // them separately would have guaranteed two layouts for one idea.
  //
  // ⚠ THE CV AUDIT IS VACUOUS HERE BY CONSTRUCTION, AND THAT IS STATED RATHER
  // THAN RUN AS A NULL SWEEP THAT PASSES. Both defs declare exactly one input
  // (`audio`, plain audio) and one output; neither declares a `paramTarget`
  // port, a `cv` port, or an `_cv` stem. The rig that stopped #1661/#1662/#1664
  // has no port to drive here, so a green `cv-path` sweep on these modules would
  // report nothing about them. `moog-filterbank-face-model.test.ts` asserts the
  // ABSENCE directly instead — zero cv-typed ports and zero paramTargets on
  // either def, in a leg that goes red the day someone adds one without an
  // audit.
  //
  // ⚠ THE RANK IS THE FREQUENCY AXIS, AND THE PREMISE WAS MEASURED. "N identical
  // band levels have no priority to express" is the spec's claim; per-section
  // authority (max |ΔdB| of the summed response when one level is driven 0.5→1
  // and 0.5→0) puts the 914 inside 2.07x across fourteen sections and the 907A
  // inside 3.54x across ten — and the two banks rank their own sections in
  // DIFFERENT orders, so an authority rank would have split the pair. See the
  // face comment on moog914.
  //
  // ⚠ WHAT THE AUDIT DID FIND is a VALUE, which is why no gate here could have:
  // the sections are summed by Web Audio fan-in, i.e. COHERENTLY, and they
  // overlap. At the shipped 0.5 defaults the 914's twelve band centres span
  // 7.1 dB and its summed response ripples 20.9 dB; the 907A ripples 17.5 dB and
  // carries a -21.6 dB null at 209 Hz that the 914 does not have. Both defs
  // documented that state as "a neutral middle to boost or cut from". The docs
  // are corrected in this PR and the three hero readouts publish the numbers
  // live.
  'moog907a',
  'moog914',
  // THE FACEPLATE QUEUE · Q20 — the noise + filter utility drawer (2026-08-18).
  // Three params, one input, FOUR outputs, and two instruments sharing a panel
  // and no signal path (measured: a 200 Hz sine through `audio` leaves `lp`/`hp`
  // bit-identical at LEVEL 1 and LEVEL 0). Merit is the `noise` argument with
  // more of it — four unprintable facts over four taps, not three over three.
  //
  // ⚠ THE AUDIT'S FINDING IS THE FILTER'S Q, AND NO GATE IN THE TREE COULD HAVE
  // SEEN IT. `moog923.ts` creates two `BiquadFilterNode`s and never assigns
  // `Q`. For `lowpass`/`highpass` the Web Audio API reads `Q` in DECIBELS
  // (`α = sin ω0 / (2·10^(Q/20))`) and defaults it to 1 — so the frequency the
  // knob sets, which the def called "the corner" in five places, is where the
  // filter reads +1.00 dB. Measured on the shipping factory at knob 0, 0.25,
  // 0.5, 0.75 and 1: the real −3 dB point is 1.3293x the declared corner on
  // `lp` and 0.7520x on `hp`, and each tap carries a +1.96 dB hump 0.36 oct
  // inside its own passband. Every closed form matches the analog prototype at
  // Q = 10^(1/20) exactly, which is how we know it is the platform default
  // showing through rather than a modelling choice. `contract-lock` pins
  // min/max/curve and is structurally blind to a filter coefficient; the
  // module's own unit test asserts `cutoffToHz` and the biquad's `.frequency`
  // agree, which they do — the number is simply not the corner. The DOCS are
  // corrected in this PR and the face publishes the real −3 dB points live;
  // whether the clone should CARRY 2 dB of unchosen resonance is an audio
  // question for the owner's ears and is filed separately, because an audio
  // change does not belong in a face PR that self-merges on green.
  //
  // ⚠ AND THE SECOND FINDING IS THE SHIPPED DEFAULT. Both dials default to 0.5,
  // so a reader concludes the two taps meet in a clean crossover at 894 Hz.
  // They do not: the −3 dB points move as x and 1/x off that shared corner, so
  // the taps OVERLAP by 0.82 oct — a band that arrives at both jacks. That is
  // the `split` readout, and it is the one number on this module that no single
  // dial can even approximate.
  //
  // ⚠ NO GLYPH, which is the #1692 finding answered rather than repeated.
  // `primaryAudioOutPortId` takes the first `audio` output — `white` — so every
  // glyph kind resolves to a live tap on the NOISE half and nothing can point
  // one at `lp`/`hp`. A glyph also costs a compact cell (three knob columns, or
  // two plus the glyph), so a filter patch would trade a dial it is using for a
  // picture of a path it is not. `noise` decided the other way on the opposite
  // facts and both decisions are in their face comments.
  'moog923',
  // THE FACEPLATE QUEUE · Q34 — the contour generator (2026-08-19). Four
  // params, five inputs, two `cv` outputs, two honest pages, no rail.
  //
  // ⚠ THE FINDING IS THAT THREE OF THE FOUR DIALS PRINT A DURATION THE MODULE
  // DOES NOT DELIVER, and one of the three is wrong by the amount a DIFFERENT
  // knob is turned. `egCoeff` makes each T a TIME CONSTANT (a ~99.3 % approach)
  // while each stage exits on its OWN threshold — attack at `level >= 0.999`,
  // decay at `|level − esus| <= 1e-3`, release at `level <= 1e-4` — so a stage
  // takes `T · ln(k)/5` and only the attack's `k` is a constant. Measured on
  // the SHIPPING worklet at 48 kHz, held gate, at the def's own defaults: the
  // dials read 10 / 200 / 400 ms and the module delivers 13.833 / 239.667 /
  // 695.958, a 949.458 ms contour against a dial sum of 610 (×1.5565). Holding
  // T2 at its default and sweeping ESUS moves the delivered settle 276.313 →
  // 262.063 → 239.667 → 92.104 → 0.021 ms **while the T2 dial reads 200.000 at
  // every one of them**. Nothing in the product said any of this; the three
  // hero readouts now print it live, and each is the other two's negative
  // control because `rise` is exactly ESUS-invariant and the other two are not.
  //
  // ⚠ THE INSTRUMENT WAS WRONG FIRST, in the way the queue's own spec records:
  // detecting the SUSTAIN stage by comparing a `Float32Array` sample to the
  // float64 literal `0.6` reports ZERO sustain samples, which reads exactly
  // like "this module never sustains". `Math.fround` fixes it, and what caught
  // it was the POSITIVE control — a HELD gate certainly sustains, so a probe
  // reporting 0 there is broken rather than the module (it reports 275 833).
  //
  // ⚠ INERTNESS DISCRIMINATES NOTHING HERE, which is worth saying because the
  // three faces before this one were each carried by a dead-at-spawn finding.
  // With `gate` unpatched, sweeping EACH of the four across its full declared
  // range leaves BOTH outputs bit-identical — all four are dead at spawn, so
  // #1758's habit finds four dead knobs and separates none of them. The ranking
  // rests on the time law instead. Positive control: with the gate held, T1, T2
  // and ESUS all move the output and T3 correctly does not (it needs a fall).
  //
  // NO GLYPH, and it is forced rather than chosen: both outputs are `cv`, so
  // `primaryAudioOutPortId` returns null and every kind except `'envelope'`
  // falls through to the dead `{kind:'static'}` — and `'envelope'` does not
  // rescue it either, because that arm keys on four HARDCODED param names
  // (attack/decay/sustain/release) and this module's are t1/t2/esus/t3 by
  // design. #1888 carries the declaration-shaped fix; ⚠ it is an ENABLER, not
  // a blocker, and its comment records why a role mapping ALONE would draw the
  // DIAL contour and so restate the very defect this face exists to expose.
  'moog911',
  // THE FACEPLATE QUEUE · Q36 — the CP3 mixer (2026-08-19). Five params, five
  // inputs, SEVEN outputs, two pages.
  //
  // ⚠ THE MERIT IS THE READOUT, NOT THE RANKING, and the face comment says so
  // plainly rather than presenting a channel-numbered mixer's channel order as
  // a redesign. `order` IS declaration order.
  //
  // THE FINDING: `cp3ChannelGain(k) = clamp(k,0,1)·2`, so UNITY IS AT THE DIAL'S
  // MIDPOINT and every one of the five knobs SHIPS AT MAX. Measured on the
  // shipping worklet (1 kHz sine, Hann-windowed single-bin DFT past the 80 Hz
  // smoother, with the instrument's own positive control first — a known 0.5
  // sine reads 0.500000 at its bin and 0.000000 at a wrong one): four
  // correlated unity inputs sum to a bus peak of 8.0000, i.e. +18.062 dB OVER
  // FULL SCALE, 10.0000 with EXT 4 also patched, and there is NO clamp or
  // saturator anywhere in the path. Nothing in the app said so.
  //
  // ⚠ OF SEVEN JACKS, TWO ARE THE KNOBS' BUSINESS. Sweeping every one of the
  // five knobs 1.0 -> 0.0 leaves `multiple_one/two/three`, `plus_twelve` and
  // `minus_six` BIT-IDENTICAL; the three multiples are bit-identical to each
  // other and to `in1`; the two references are constants (+2.400000 /
  // -1.200000, ratio exactly -2). The face groups them on the rear card so
  // nobody hunts for the knob that changes a multiple.
  //
  // ⚠ AND THE 4TH CHANNEL SHIPS A REDUNDANT CONTROL DIMENSION. `cp3Mix` applies
  // `(in4+ext4)·atten4·g4`, so the bus sees only the PRODUCT: swapping CH 4 and
  // ATT 4 with different signals on the two jacks is BIT-IDENTICAL at every
  // pair tried (max abs diff 0.000000000000), against a non-interchangeable
  // control pair that differs by 2.106857. This CORRECTS the earlier reading
  // that the two "look the same and are not". #1884 would change the equation;
  // that is audible on any saved rack and moves an ART baseline, so the face is
  // drawn against TODAY'S code with the redundancy stated rather than hidden.
  'moogCp3',
  // THE FACEPLATE QUEUE · Q7 — the full mixer (2026-08-15). 91 params, 111
  // input ports: 1.86x the previous largest face (pentemelodica, 49 cells).
  //
  // ⚠ THE PROMOTION SURFACE IS SMALLER THAN THE RULE SAYS, AND IT WAS TRACED
  // RATHER THAN ASSUMED. `shell-cells.ts:995` and the module-faceplates skill
  // both state the promotion rule as "migrated(type) removes the legacy card
  // from the lane AND the dock". That is true of the dock FULL-VIEW
  // (`DockFullView.svelte:317-340`, gated on the `migrated` prop passed at
  // `Canvas.svelte:8359`) and FALSE of the pinned DRAWER — `DockCardHost.svelte`
  // resolves `nodeTypes[node.type]` at `:62`/`:167` with no `migrated` input at
  // all. The `m` key routes to `dockStore.toggle('bottom', 'pinned-mixmstrs')`
  // (`Canvas.svelte:1570` via `DRAWER_KEY_TO_PINNED`, `workflow-pins.ts:138`),
  // i.e. through `DockRail` → `DockCardHost`. And `pinned-mixmstrs` is
  // canvas-hidden (`Canvas.svelte:2489`), so it has no lane tile, no EXPAND
  // pill, and cannot reach `DockFullView` at all outside the e2e hook.
  //
  // So promoting mixmstrs changes exactly two surfaces, both on NON-PINNED
  // instances (the submixes and parallel buses the def explicitly supports):
  // the lane tile (placeholder → ModuleShell) and that instance's dock
  // full-view (MixmstrsCard → ModuleShell). The always-on `m` drawer is
  // BYTE-IDENTICAL before and after. That asymmetry is a real gap in the rule
  // as written, not a property of this module, and it is filed as its own
  // issue rather than papered over here.
  //
  // ⚠ THE AUDIT FOUND FOUR MEASURED FACTS AND THE FACE PUBLISHES ALL FOUR.
  // Eighteen of ninety-one controls are BIT-EXACTLY inert on a factory-fresh
  // module (16 thresh/ratio behind a bypassed compressor, 2 PRE/POST switches
  // behind sixteen shut sends) against a measured module floor of 2.9062e-4;
  // two correlated full-scale channels already clip the bus (peak 1.2797 at
  // the defaults, and nothing limits); the per-channel VU tap is a mono sum and
  // reads 0.0000e+0 on an anti-phase channel the master carries at full level;
  // and the comp macro overwrites a saved compressor at load, measured
  // +29.174 dB. The first three are hero readouts here. The fourth is a
  // def/factory bug that changes saved-rack audio and is NOT fixed in a face
  // PR — see the note on `applyCompMacro`.
  'mixmstrs',
  // THE FACEPLATE QUEUE · Q14 — SLEWSWITCH, quad slew + 4→1 sequential switch
  // (2026-08-15), and the entry whose argument is that TWO ENGINES IN ONE BOX
  // ARE TWO PAGES, not one ranked list of seven.
  //
  // 7 params, 10 inputs, 7 outputs. Four independent lag processors that turn
  // any stepped voltage into a glide, plus a clocked selector that reads those
  // same four smoothed lines one at a time — so the module both CONDITIONS four
  // voltages and SEQUENCES between them, and out1..out4 stay live while it does.
  // sampleHold latches on an edge, fourplexer routes raw signals with no
  // conditioning; this one SHAPES and then SCANS.
  //
  // ⚠ THE FOUR SLEW DIALS LOOK INTERCHANGEABLE AND ARE NOT, which is what makes
  // the ranking an argument rather than declaration order with a story. LENGTH
  // counts UP from channel 1, so channel 1 is in the scan at all four length
  // settings, channel 2 at three, channel 3 at two, channel 4 only at length 4;
  // RESET returns to channel 1 and length 1 HOLDS channel 1. fourplexer's four
  // inputs genuinely ARE symmetric — it has no LENGTH — so the argument does
  // not transfer, which is the test of whether it is one. The whole SWITCH half
  // is then ranked below the slew half because it is gated on a CABLE: there is
  // no internal clock, so MODE / LENGTH / XFADE change nothing that leaves the
  // box until `step_clock` is patched.
  //
  // ⚠ THE GLYPH DECISION IS THE ninelives HAZARD WITH NO ESCAPE HATCH, and it
  // is measured. `primaryAudioOutPortId` returns NULL — six `cv` outputs and one
  // `gate`, no `audio` output at all — so the `live-audio` short-circuit cannot
  // fire, exactly as on ninelives. But ninelives could still declare 'waveform'
  // honestly, because it HAS a `shape` param 0..2 that every one of its nine
  // taps shares. This module has no `shape`, no ADSR quartet and no `algorithm`,
  // so 'scope', 'meter', 'waveform', 'envelope' and 'algorithm' ALL resolve
  // `{ kind: 'static' }`: a deterministic fake trace tapping nothing. There is
  // no honest picture available at any setting, so the face declares
  // `glyph: 'none'` and spends the budget on a SEVEN-ROW OUTPUT TABLE — one row
  // per declared jack, each reading a different subset of the dials. Every
  // branch is a permanent leg of `slewswitch-face-model.test.ts`, including the
  // control that each candidate glyph would have resolved `static`.
  //
  // ⚠ AUDITED BEFORE AUTHORING, and the CV half came back CLEAN — which is only
  // worth anything because the rig carried its controls. All four `paramTarget`
  // inputs move the audio on BOTH paths and the two columns agree TO THE BIT
  // (|cv − knob| = 0.0000e+0 on every channel), the four channels are perfectly
  // isolated (slew1_cv moves out1 by 1.1156e+0 and out2/out3/out4 by
  // 0.0000e+0), and the terminal partition is DERIVED off the live handle:
  // 4 param terminals, 6 port terminals, zero params published off-worklet.
  // `step_clock` captures 100.0 % of rising edges at 1 / 2 / 5 / 10 / 20 / 50 /
  // 100 Hz and is width-invariant from 1 to 256 samples — the buggles defect
  // measured for, and absent, because this consumer is a WORKLET doing a
  // per-sample compare rather than a main-thread analyser poll.
  //
  // ⚠ IT FOUND TWO OTHER DEFECTS, both in the two preceding commits. The
  // "glitch-free" equal-power crossfade ADDED a +41.42 % overshoot to every CV
  // hand-off (#1711) — the audio law applied to correlated CV, invisible
  // because the ART profile's `switched` assertion skips the fade window by
  // construction. And the slew dials are one-pole TIME CONSTANTS documented as
  // arrival times (#1712), a fixed 4.605x across three decades: the shipped
  // 0.5 s default arrives in 2.30 s. That second one is now the face's own
  // `settle` readout, so the panel prints the number the docs had wrong.
  'slewSwitch',
  // THE FACEPLATE QUEUE · Q15, COHORT 3 — the curve-morph attenuverter
  // (2026-08-15), and the entry whose merit argument is a SHAPE rather than a
  // count.
  //
  // Six other modules in the rack attenuate or invert a control voltage —
  // scaler, polarizer, depolarizer, attenumix, illogic, analogLogicMaths — and
  // every one of them is a straight line. This is the only module that changes
  // the SHAPE of a voltage: `y = sign(x)·|x|^k·atten`, `k = 1 + 2·curve`.
  //
  // ⚠ AN EXPONENT IS NOT A GAIN, and that is the whole face. Measured on the
  // shipped worklet through the def's own factory: at full CURVE a 0.5 input
  // leaves at 0.125 while a 2.0 input leaves at 8.0 — one dial, −12 dB at one
  // end of the range and +12 dB at the other, PIVOTING about a magnitude of
  // exactly 1. No single number a dial could print says both, which is why the
  // hero publishes the response at BOTH probe magnitudes and why the two move
  // in opposite directions on every render.
  //
  // ⚠ THE AUDIT FOUND THE DOCS ASSERTING ONLY THE HALF THAT SUITED THEM.
  // `docs.explanation` and both curve controls said the curve "leaves larger
  // excursions intact" / "preserves large ones". |x| = 1 is the ONLY fixed
  // point; above it the curve EXPANDS (2 → 8, 3 → 27). Every gate was blind
  // because the DECLARATION is correct and the defect is a VALUE inside prose —
  // the #1701 class. Corrected (#1715), and the corrected claim is now printed
  // as a live number rather than asserted in a sentence.
  //
  // ⚠ AND IT PAID A CARD/DEF DIVERGENCE ON ALL FIVE LABELS (#1714), with every
  // RANGE agreeing — the other half of the #1681 class, and the half that
  // becomes user-visible exactly here: the dock renders the DEF's label, so
  // promoting this module without binding the card would have shipped a rename
  // of five controls that nobody reviewed. All five were already sitting in
  // `VOCABULARY_DEBT`, so this is a KNOWN answer paid rather than a new find —
  // the CharlottesEchosCard precedent verbatim, and the reason the queue tells
  // you to grep the debt lists before authoring a face. The card is now
  // `paramSpec`-bound on every prop including `label`, enrolled in
  // RANGE_BOUND_CARDS + MAPPING_BOUND_CARDS, and the five ledger entries are
  // DELETED with no replacement counter.
  //
  // ⚠ THE PUSH 2 CARD MOVES, and no golden covers it. Promotion takes this
  // module from the GENERIC tier (declaration order: unityAtten, aAtten,
  // aCurve, bAtten, bCurve) to the FACE tier (`face.order`: aCurve, aAtten,
  // bCurve, bAtten, unityAtten) — five encoders re-assigned. That is the
  // INTENDED effect of ranking the identity first, and it is recorded here
  // because `push-card-schema.test.ts`'s AUTHORED goldens only cover modules
  // with an explicit `PUSH_CARD_CONTROLS` override, so "the card did not move"
  // and "nobody looked" would otherwise be one green.
  //
  // ⚠ `glyph: 'none'` IS A DECISION. Three `cv` outputs and no audio output, so
  // `primaryAudioOutPortId` returns null and any other glyph resolves to
  // `{ kind: 'static' }` — the marbles defect (#1692). The face takes the extra
  // lane cell instead.
  //
  // The CV audit found nothing, which is only worth anything because the sweep
  // carries its positive controls permanently (a GainNode leg, a
  // worklet-AudioParam leg, a per-input knob leg, and a DERIVED terminal
  // partition): all five declared `paramTarget` inputs move the audio through
  // the CV path and the KNOB and CV legs agree to every printed digit —
  // `art/scenarios/unityscalemathematik/cv-path.test.ts`.
  'unityscalemathematik',
  // THE FACEPLATE QUEUE · Q16, COHORT 3 — the audio→CV feature extractor
  // (2026-08-15), and the entry whose whole argument is that EVERY DIAL ON THE
  // MODULE IS IN THE WRONG UNITS FOR WHAT IT DECIDES.
  //
  // featurecv is the rack's LISTENER: one audio in, three continuous CVs (LOUD
  // = broadband RMS, BRIGHT = zero-crossing rate, PUNCH = crest factor) and an
  // ONSET trigger, all time-domain so it is fully deterministic. SYNESTHESIA
  // does the per-band version; nothing else in the rack publishes broadband
  // TIMBRE as control voltage at all.
  //
  // ⚠ THE FACE EXISTS BECAUSE THE SIX DIALS PRINT MULTIPLIERS AND LOCKOUTS
  // WHERE THE ANSWERS ARE LEVELS AND RATES. Measured on the shipping worklet
  // through this def's own factory (`art/scenarios/featurecv/analysis.test.ts`):
  // SENS `0.50` is a threshold of 2.60× the running mean flux and the map is
  // INVERTED; DEBNCE `80 ms` is a 12.5 Hz rate ceiling (12/12 pulses captured
  // at 12 Hz, and every OTHER hit at 16 Hz — 24 of 48); ATK `10 ms` is a one-pole TIME CONSTANT that
  // delivers a 22 ms 10→90 % rise; and LOUD is `clamp01(2·rms·gain)`, so at
  // unity trim any source above −6.02 dBFS RMS reads a flat full scale.
  //
  // ⚠ THE RANK-1 ARGUMENT IS A MEASUREMENT, NOT A PREFERENCE. POLARITY is the
  // ONLY control on this module with unconditional authority: every other one is
  // inert until a cable arrives, because with nothing patched all three feature
  // targets are 0. POLARITY still moves all three jacks a full rail — and the
  // direction is the surprise, since BIPOLAR maps that 0 to −1.00, so an idle
  // featurecv is holding three destinations at the BOTTOM of their range rather
  // than at their centre. Nothing on the module said so before this face.
  //
  // ⚠ THE CV AUDIT IS VACUOUS HERE BY CONSTRUCTION, and it is stated rather
  // than run as a null sweep that passes (the Q12 precedent). The def declares
  // exactly ONE input — plain `audio`, the signal under analysis — and zero
  // `paramTarget` ports, so the rig that stopped #1661/#1662/#1664 has nothing
  // to drive. `featurecv-face-model.test.ts` asserts the ABSENCE directly, in a
  // leg that goes red the day someone adds a CV input without an audit.
  //
  // ⚠ WHAT THE AUDIT DID FIND, and both are VALUES rather than declarations:
  //   * #1744 — the card's ONSET LED reports 18.8–25.0 % of the pulses the
  //     ONSET jack emits. `snapOnset` is OVERWRITTEN every render quantum and
  //     READ every sixteenth, and a trigger pulse is 240 samples ≈ 1.9 quanta,
  //     so four hits in five never coincide with a post. Fixed by LATCHING
  //     across the post interval; the ONSET OUTPUT itself was measured clean
  //     (100 % at 1/2/4/8/12 Hz, collapsing past the debounce ceiling exactly
  //     where it should).
  //   * #1745 — the DSP core's crest calibration comment claimed "white noise
  //     (~3.5) → ~0.5". That is a GAUSSIAN figure and the rack produces no
  //     Gaussian noise: `noise`'s white tap is UNIFORM in [−1,+1], crest √3 ≈
  //     1.73, so the canonical patch NOISE → FEATURECV lands PUNCH at 0.15
  //     unipolar / −0.71 bipolar — the bottom of the rail, not the middle.
  //   * #1746 — five card/def LABEL divergences, all already in
  //     `VOCABULARY_DEBT`, paid here because the dock renders the DEF's label.
  //
  // ⚠ AND ONE INSTRUMENT LESSON, recorded because it nearly shipped as a
  // finding. The first SENS sweep returned "the dial is bit-exactly dead across
  // its whole travel" on four amplitudes of a clean 4 Hz hit train. It is not:
  // an unambiguous transient clears every threshold, so the probe signal was
  // INVARIANT to the dimension under test. On ambiguous material the same
  // travel goes 1 → 13 pulses (a tremolo tone) and 4 → 10 (hits under a loud
  // noise bed). CLAUDE.md's "a no-op reading is FIRST an instrument bug",
  // one wave after `destroy` recorded it.
  //
  // ⚠ PROMOTION REMOVES A LIVE METER AND IT IS NOT REBUILT — decided on
  // measurement rather than on cost. The card's three bars read the extractor's
  // UNSMOOTHED, always-UNIPOLAR target, so they disagree with the jacks they
  // name (PUNCH bar 0.145 against a PUNCH jack at −0.703 at the shipped
  // default) and do not move when ATTACK or RELEASE do. What replaces them is
  // the `featurecv-maps` sidebar picture, DRAWN from the constants the worklet
  // inlines rather than traced off a snapshot — the `noise-taps` precedent,
  // reached from the opposite direction: noise could not be traced, featurecv
  // could be and should not be.
  //
  // ⚠ `glyph: 'none'`, and that is a decision. Three `cv` outputs and one
  // `gate`, no `audio` output, so `primaryAudioOutPortId` returns null and any
  // other glyph resolves to `{ kind: 'static' }` — the marbles defect (#1692),
  // asserted at its cause and negative-controlled in both directions.
  'featurecv',
  // THE FACEPLATE QUEUE · Q17 — ILLOGIC, the attenuverter / math / logic
  // utility (2026-08-16). Four dials, TEN jacks, and the merit argument is the
  // `ninelives` one in its strongest available form: the module's four controls
  // are four copies of the same control, and every interesting fact about its
  // outputs is a fact none of them can print.
  //
  // ⚠ FOUR OF THE TEN JACKS ARE BEHIND NONE OF THE FOUR KNOBS. AND, NAND, OR
  // and NOT threshold the RAW inputs, before the attenuverters, so sweeping any
  // knob its full −1 → +1 travel moves all four by BIT-EXACTLY 0.0000e+0 —
  // measured through this module's own factory, all four params × all ten
  // outputs, with the port sets DERIVED from the def (`gate`-typed vs
  // `cv`-typed) and asserted in BOTH directions, so the sweep cannot pass by
  // measuring nothing. Correct design (an attenuverted gate is not a gate), and
  // completely unknowable from a card showing four faders above ten jacks. The
  // faceplate says it twice: as a NUMBER in the readout row (`logic ×1.00`
  // beside three bus gains that do move) and as the routing picture, where the
  // boolean taps visibly branch upstream of the attenuverter triangles.
  //
  // ⚠ AND DIFF SHIPS AS A COMMON-MODE NULL. Its gain on a signal present at
  // every input is a1+a2−a3−a4, which is EXACTLY 0.00 at the shipped defaults
  // (all four at +1) — verified against the rendered graph, not just the
  // arithmetic. Underneath four faders sitting at maximum, one of the two mix
  // buses is configured to output silence. `diff ×0.00` is the resting face's
  // most useful two characters.
  //
  // ⚠ THE THIRD READOUT IS THE ONE THE OTHER TWO ARE BLIND TO. `peak` is Σ|aN|,
  // the worst case either bus reaches for ±1 inputs — SIGN-BLIND, where `sum`
  // and `diff` are signed and cancel. Neither bus is scaled by 1/n, so it reads
  // ×4.00 at the defaults on a CV convention of ±1; measured, a deliberately
  // modest 0.9/0.9/0.6/0.4 stimulus already leaves the rail on 26.8 % of SUM's
  // samples and 39.2 % of DIFF's. Flip one knob negative and `sum`/`diff` move
  // while `peak` does not, which is what makes them each other's control on
  // every run rather than three spellings of one quantity.
  //
  // ⚠ `glyph: 'none'`, ESTABLISHED rather than assumed. Six `cv` outputs and
  // four `gate`, no `audio` output, so `primaryAudioOutPortId` returns NULL and
  // every other glyph value resolves to `{ kind: 'static' }` — the marbles
  // defect (#1692). Asserted by calling both functions, negative-controlled in
  // both directions, in `illogic-face-model.test.ts`.
  //
  // ⚠ THE AUDIT FOUND ONE LIVE DEFECT AND THIS PR FIXES IT (#1750). The gate
  // threshold is declared as `>= 0.5` in three places — `illogicMath.gate`, the
  // def's own `docs`, and the module manifest — and the SHIPPED path disagreed
  // with all three AT EXACTLY THAT VALUE. `thresholdCurve` built its step with
  // `x >= threshold`, but a WaveShaperNode LINEARLY INTERPOLATES between curve
  // samples and 0.5 lands at index 3071.25 of 4096, a quarter of the way up the
  // ramp: an input sitting exactly on the declared threshold rendered a gate of
  // 0.25, so `not` read 0.750000 where the contract says 0 and `and` read
  // 0.062500 where it says 1. Every gate was green because every gate read ONE
  // SIDE — the pure helper's arithmetic, or a truth table sampled at 0.49/0.51.
  // The step is now snapped to the sample at-or-below the threshold, so
  // `v >= 0.5` renders an exact 1 and WaveShaper's unavoidable one-index ramp
  // sits entirely BELOW the threshold. The ART baselines are BYTE-IDENTICAL
  // across the fix (the profile drives 0/1 gate trains, far from the band) —
  // only the four `.sha` source pins moved, which is the verification.
  //
  // ⚠ WHAT THE AUDIT DID NOT FIND, stated as a result rather than as silence.
  // No dropped edges: the AND multiplier's AudioParam-modulator leg captures
  // 100 % of pulses at 1/2/4/8/16 Hz at every width down to a SINGLE SAMPLE
  // (20.8 µs), and so does its audio leg — both carried through the permanent
  // sweep with instrument controls that read 0 and read a number they were not
  // handed. No out-of-range excursion on coincident edges (worst 0.0000e+0), no
  // card/def divergence on any operational or vocabulary field including
  // `units`, no dead knob, and no FALSE value in the shipped docs — three
  // OMISSIONS, all now written and all now printed by the face.
  'illogic',

  // FACE BATCH 4 · destroy (2026-08-16) — the bitcrusher, and the entry whose
  // merit claim was A NUMBER: the queue (Q18) deferred it twice on the grounds
  // that "the decimator's effective sample rate and bit depth are genuinely
  // unprintable by a 0..1 dial", which is a faceplate argument that is only worth
  // anything if the numbers are TRUE. They were not.
  //
  // ⚠ IT SHIPPED WITH ITS HEADLINE NUMBER WRONG AT EVERY DIAL POSITION (#1716),
  // and that is fixed HERE rather than referenced: `packages/dsp/src/destroy.dsp`
  // TRUNCATED a `si.smoo`-ed slider (`ba.period(int(d))`). A one-pole smoother
  // stalls just BELOW its target in float32 — measured ≈ 4.8e-4 short at d = 8,
  // which is the update underflowing half an ULP, not slow convergence — so every
  // integer position resolved one step low. Measured on the shipping wasm, hold
  // length by DECIMATE, BEFORE → AFTER `int(d + 0.5)`:
  //
  //     DECIMATE     2     4     8    16    32    64
  //     before       1     3     7    15    31    63     ← DECIMATE 2 was a
  //     after        2     4     8    16    32    64        bit-exact NO-OP
  //
  // The declared range, the `paramTarget`, the `cvScale` and the docs were all
  // correct, so contract-lock, module-docs-lint and per-module-per-port were all
  // green: the defect was in the VALUE, and the only instrument that could see it
  // renders the module. It moves the ART baseline, reviewed as TIMBRAL.
  //
  // ⚠ AND THE QUEUE'S PROPOSED STRONGEST READOUT DOES NOT EXIST. §Q18 asked for a
  // JOIN — "the number of distinct output levels is a function of BITS and
  // DECIMATE together (a held sample is quantised once)" — and told this branch to
  // measure it before ranking. Measured: the level census is a function of BITS
  // ALONE (exactly 9 at 4 bits and 5 at 3 bits, at DECIMATE 1, 2, 4, 8, 16 AND
  // 64). Decimation re-uses grid cells, it does not remove them; the apparent
  // thinning at high DECIMATE is sampling exhaustion of a finite window, and it
  // vanishes at low bit depths where the grid is small enough to fill. The join
  // the face ships instead is the DATA RATE (bits × effective rate, kbit/s),
  // which is a genuine two-dial product and the figure of merit a player knows.
  //
  // ⚠ ITS GLYPH IS A TRACE ON A MEASUREMENT, NOT A HOUSE STYLE. A level meter is
  // INVARIANT TO THIS MODULE'S PRIMARY CONTROL: across DECIMATE's entire travel
  // the output RMS moves 0.12 dB on broadband noise and 0.00 dB on a sine, while
  // the error-vs-dry over the same travel moves 99.2 dB. Half the FX family
  // declares `meter`; here it would have painted a dead indicator over the dial a
  // player is turning.
  //
  // THE OTHER TWO THINGS THE AUDIT FOUND, both OMISSIONS rather than faults, both
  // now printed by the face and written into the docs: the quantiser has a DEAD
  // ZONE that is a cliff (at 1 bit a source 1.2× over −6.0 dBFS leaves at −4.3
  // dBFS and one at 0.98× leaves at −99.0), and WET's own smoother never closes,
  // so a residual dry path survives 89.8 dB down at WET 1 — inaudible, and the
  // reason nobody could measure this module: output samples inside a held plateau
  // are never bit-identical, so a bit-equality census reports "decimation does
  // nothing" and a distinct-value census reports "bit reduction does nothing".
  // Both are recorded as PERMANENT negative controls on the audit's instrument.
  'destroy',
  // FACE BATCH 4 · analogLogicMaths (2026-08-17) — the CONTINUOUS logic block,
  // and the entry that RETIRES ITS OWN REJECTION. Queue Q19.
  //
  // §9 refused it on merit: *"the module IS its five outputs, and the rear card
  // renders those without a face."* That is the `ninelives` argument with the
  // sign flipped — `ninelives` has 2 params and 9 outputs and was promoted
  // PRECISELY because the module is its outputs and no dial can print their
  // relation. The rear card renders five JACKS. It cannot render the five LAWS,
  // and the laws are the module.
  //
  // WHAT MAKES IT A FACE, measured on the shipping worklet through the def's
  // own factory (`art/scenarios/analog-logic-maths/face-audit.test.ts`, which
  // re-derives every figure on each run):
  //
  //  · SUM IS A SATURATOR, NOT A MIXER. Two dials at +1 have a nameplate gain
  //    of ×2.00 and deliver ×0.96 — −6.34 dB against the un-clipped sum, and
  //    −12.05 dB for two ±2 sources. §11.1 DERIVED those two figures from the
  //    declared law and told this branch to render them before authoring; they
  //    REPRODUCE to four decimal places (−6.3388 / −12.0470). The knee is not a
  //    corner case: the compression reads −0.96 dB at ±0.3 in each input and
  //    passes 1 dB by ±0.4, less than half the rail. And it is a JOIN — with ATT
  //    B at 0 the same full-scale input compresses by only −2.37 dB, so opening
  //    the second dial nearly triples
  //    it. Neither dial can print a number that only exists when both are open,
  //    which is the STOP-1 test this module was rejected for failing.
  //
  //  · AND THE SOFT-CLIP IS ON THE WRONG PAIR OF JACKS. For in-range inputs
  //    |a′·b′| ≤ 1, so PRODUCT's tanh cannot be protecting anything (it is a
  //    fixed −2.37 dB of distortion at the corner), while DIFF reaches
  //    |attA|+|attB| = ±2.00 UNCLIPPED and is the only jack on the module that
  //    leaves the ±1 rail. The DSP said the exact opposite in a comment — *"MIN
  //    / MAX / DIFF stay bounded for any in-range pair"* — wrong in both halves,
  //    corrected here, with the BEHAVIOUR deliberately unchanged (a soft-clipped
  //    difference would stop being a difference) and the live ceiling printed as
  //    `peak`.
  //
  //  · DIFF SHIPS AS A COMMON-MODE NULL (×0.00 with both faders at maximum),
  //    the illogic finding in a module with half the dials.
  //
  // ⚠ THE RANK AXIS ILLOGIC USED DOES NOT WORK HERE, AND THE AUDIT PROVES IT
  // RATHER THAN ASSUMING IT. Ranking by REACH reports attA moving five jacks
  // and attB four — and SWAPPING THE TWO INPUT AMPLITUDES FLIPS THE ANSWER,
  // because MIN and MAX are selectors and whichever channel is louder owns them.
  // Reach is a property of the STIMULUS on this module, not of the module. Both
  // readings are asserted as a permanent leg so the refusal cannot be quietly
  // forgotten. The intrinsic axis is POLARITY: `diff = a′ − b′` is the one
  // antisymmetric law, so ATT A enters all five jacks with the sign the panel
  // implies and ATT B inverts one of them.
  //
  // ⚠ ITS GLYPH IS 'none' ON A RESOLUTION, not a house style: five `cv` outputs
  // and no `audio` output means `primaryAudioOutPortId` returns null and every
  // other literal collapses to the dead `{kind:'static'}` binding. The face's
  // only picture is therefore a registered `custom` sidebar panel — the transfer
  // curve, where "SUM bends and DIFF does not, and it is the straight line that
  // crosses the rail" is one drawing instead of three sentences.
  //
  // ⚠ AND ITS TWO CV INPUTS ARE HALF-DEAD AT THE FACTORY SETTINGS, found by
  // sampling AT the declared value rather than around it (the #1750 lesson):
  // `attA`/`attB` ship at +1, which IS the top of their declared −1..+1 range,
  // and a CV cable ADDS to the knob, so a +1 — or a +5 — CV changes the output
  // by bit-exactly zero. Written into the docs; the knob-at-0 positive control
  // is a permanent leg.
  'analogLogicMaths',

  // THE FACEPLATE QUEUE · Q28 (COHORT 4) — the Moog 921 oscillator, as a PAIR.
  // ONE INSTRUMENT SPLIT ACROSS TWO DEFS: `moog921a` is a CV-only driver (3
  // params, two `cv` outputs, no audio anywhere) and `moog921b` is the
  // sound-making slave (5 params, four `audio` outputs) with no 1V/oct jack of
  // its own. Pitch arrives on the bus. They are promoted together because the
  // number that matters is a product of both faces.
  //
  // ⚠ THE MERIT IS A DIMENSIONLESS DIAL WITH ITS SCALE ON ANOTHER CONTROL.
  // `moog921a.frequency` runs −1..+1 and means nothing alone; `freqRange` picks
  // whether that span is ONE octave or SIX (`packages/dsp/src/moog921a.ts:66-72`).
  // DERIVED THROUGH THE SHIPPING CORE, 921B at its own defaults:
  //
  //   frequency +0.50, SEMI →  +0.5 V →   370.00 Hz  (F#4)
  //   frequency +0.50, OCT  →  +3.0 V →  2093.01 Hz  (C7)
  //
  // The same dial position, a factor of 5.66 apart, from a two-state switch —
  // and the shipped cards print `0.50` and `SEMI`/`OCT` and no Hz, no octave
  // count and no volts on either panel. The SEMI compass is 130.81..523.25 Hz;
  // the OCT compass is 4.09 Hz..16.74 kHz.
  //
  // ⚠ AND THE PAIR'S GLYPHS DIFFER, WHICH IS WHY AUTHORING THEM APART WOULD HAVE
  // GOT ONE WRONG. `moog921a`'s outputs are `cv`·`cv`, so `primaryAudioOutPortId`
  // is null and every glyph but 'none' collapses to the dead `{kind:'static'}`
  // binding (#1692). `moog921b`'s four `audio` outputs bind a live trace — to
  // `sine`, the FIRST declared audio output and one tap of four, which its docs
  // now say out loud. Both asserted, with negative controls, in
  // moog921-face-model.test.ts.
  //
  // ⚠ TWO SWITCH VOCABULARIES RECOVERED FROM CARD MARKUP. `SEMI`/`OCT` and
  // `OFF`/`LO`/`HI` existed only in each card's private array, so a def-driven
  // surface painted rotaries printing `1.00` and `0.00` over them. Both are now
  // `ParamDef.options` rosters the cards MAP rather than restate — and
  // `moog921b.syncMode`'s `curve` went `linear` → `discrete` in the same commit
  // to make the roster legal, which is correct on its own terms: the DSP
  // thresholds it at ±0.5, so half its declared travel was one flat state.
  //
  // ⚠ moog921b JOINS THE VRT ROSTER'S FREE-RUNNING SET — a VCO with no gate,
  // sounding from spawn — so its compact tile exercises #1420's pre-frame audio
  // freeze rather than being indifferent to it. moog921a is silent by
  // construction (it has no audio path at all) and carries no glyph. ⚠ NO
  // ORDINAL here or in the roster entry: "the Nth free-running voice" is a
  // population count, and the existing comments already need reading together
  // to establish what N is. State the PROPERTY per entry, never the position.
  //
  // DEFECTS FOUND BY THE AUDIT, FILED RATHER THAN FOLDED IN: #1791 (the 921A's
  // declared MINIMUM width produces the MIDPOINT duty — measured 49.85 % through
  // the real worklet chain, printed by the `duty` readout as `norm 50 %`) and
  // #1792 (the "1 Hz to 40 kHz" prose is wrong at both ends).
  'moog921a',
  'moog921b',
  // ⛔ REVIEW-HOLD · THE FIRST VIDEO FACE (2026-08-17) — Q22, `backdraft`.
  //
  // 37 params, 33 inputs (29 paramTarget CV + 4 video), 1 video out: the
  // largest generic-face candidate in the fleet that is neither blocked nor
  // carved out. It came back a STOP-2 REFUSAL in the 2026-08-14 audit on four
  // blockers, and it is promoted now because three of them were fixed and the
  // fourth is paid in this diff:
  //
  //   1. Six clock/gate inputs edge-detected in `draw()`, so a pulsed trigger
  //      was DEAD on all six — 28.6 % capture of a 5 ms trigger, 0.0 % at 8 fps.
  //      FIXED on main (#1725 / #1741): all six moved to `setParam`, 100 %.
  //      A face that ranked MIRROR X/Y, SHAPE, PURE GEO and TV MODE while their
  //      clock inputs were dead would have been a prettier broken module.
  //   2. Face completeness had no exemption for a param with NO user control,
  //      and this module has seven. FIXED on main (#1732): `def.noUserControl`,
  //      which backdraft already adopts — they render exactly ZERO cells.
  //   3. `face.extension`'s `fullViewBody` slot had no render site, and no
  //      ParamCellKind mounts a canvas. FIXED on main (#1732). See below.
  //   4. Three discrete params had no `options` roster and three 0/1 switches
  //      declared `curve: 'linear'`, so a def-driven face painted six of the
  //      module's most-used controls as anonymous continuous rotaries. PAID
  //      HERE — and unlike the rest of this promotion it is a `params` edit, so
  //      it MOVES THE WEBGL ATTEST HASH and needs an owner-machine re-attest.
  //
  // ⚠ PROMOTION WOULD OTHERWISE DELETE THE MODULE'S OUTPUT. The `⛶ OUTPUT`
  // button is `node.data`-backed rather than a ParamDef, and it is the SOLE
  // entry to Full Frame / Full Screen / Present (the node menu offers only
  // Docs / Duplicate / Delete). It survives as the `fullViewBody` extension at
  // `$lib/ui/modules/backdraft/` — the first adopter of that slot in the repo,
  // and the first adopter of `face.xyPads` too.
  'backdraft',
  // THE SECOND VIDEO FACE, AND THE FIRST FACE THAT RANKS NOTHING (2026-08-18,
  // #1821) — `videoOut`, the OUTPUT monitor. Owner: *"video output face should
  // be prioritized next for face … that's the most important face work to do."*
  //
  // ⚠ `face.order` IS EMPTY, and every completeness gate therefore passes
  // VACUOUSLY over it. That is stated here rather than left to be discovered,
  // because it is exactly the shape `blind-gates.md` warns about: `module-face-
  // lint`'s completeness, the dock render-plan parity check and `faces-parity`
  // all enumerate `params`, and this def declares NONE — so a green run from any
  // of them says nothing whatever about this face. What actually covers it:
  //
  //   * `videoout-face-model.test.ts` — the permanent negative controls, and
  //     they are about the two things the declaration CANNOT show: that the lane
  //     tile still resolves a live video surface (`glyph: 'none'` plus a blank
  //     tile is indistinguishable from `'none'` plus a live thumb), and that the
  //     face never reaches the plate branch where #1785 evicts the picture.
  //   * `videoout-detach-display.spec.ts` — the affordances, on a real canvas.
  //   * `shell-extensions.test.ts` — the declared id ↔ the discovered module.
  //
  // ⚠ IT MERITS A FACE ON THE `node.data` CLAUSE, NOT THE PARAM ONE. STOP 1 in
  // `module-faceplates.md` refuses a face only when ALL of "≤2 params, no
  // families, no `node.data`-backed affordances, no derived quantity" hold.
  // OUTPUT has zero params and fails the refusal on the third: full frame is
  // `node.data.fullFrame`, and #1821 adds DETACH — a floating, resizable picture
  // with no patch wires, owned by `node.data.detached` so that deleting the card
  // takes the floating output with it by construction.
  //
  // The picture and all four ways of enlarging it live in the `fullViewBody`
  // extension at `$lib/ui/modules/videoOut/` — the second adopter of that slot.
  // For backdraft the slot AUGMENTS a faceplate; here it IS the faceplate.
  'videoOut',
  // THE FACEPLATE QUEUE · Q5 — the Buchla-259-style complex oscillator
  // (2026-08-19). The full ranking argument is a comment on the def itself;
  // what belongs HERE is the one finding that made it worth building and the
  // one instrument bug that nearly wrote the wrong face.
  //
  // ⚠ TWO OF ITS EIGHT KNOBS ARE BIT-EXACTLY INERT IN THE STATE A RACK SPAWNS
  // IN. At the shipped default `ratio = 1`, sweeping `mod_tune` or `mod_fine`
  // across its FULL declared range (±36 st, ±100 ¢) gives
  // `max|x − x_ref| = 0.000e+0` on ALL THREE audio outputs — the modulator's
  // free-run leg is gated off and those two dials reach nothing. `docs.controls`
  // has always said so in prose; NOTHING on the panel did, and the legacy card
  // renders them as two ordinary faders identical to the six live ones. The
  // face answers it three ways at once: they rank 7 and 8 (dock-only, since
  // `faceTierCap('full')` is 6), the LOCK readout names the live mode, and the
  // sidebar says what they would do in the other one. Positive control, so the
  // probe is not blind: at `ratio = 0` the same sweep moves `mod_out` from
  // 33 Hz to 2093 Hz.
  //
  // ⚠ THE INSTRUMENT WAS WRONG FIRST, AND IT LOOKED AUTHORITATIVE. The whole
  // ranking rests on spectral centroid, and the first pass measured it with a
  // RECTANGULAR window — which read this module's own `mod_out`, a pure
  // 261.626 Hz sine, as 2904 Hz. A frequency-weighted centroid is dominated by
  // 1/f leakage sidelobes, so every number was inflated and FOLD and TIMBRE
  // came out nearly equal. What caught it was a POSITIVE control that the
  // module hands you for free — a known pure sine must read as itself — not a
  // negative one. With a Hann window the same tap reads 261.8 Hz and the
  // ranking separates cleanly: FOLD +412 % of centroid across its travel
  // against TIMBRE's +23 %.
  //
  // ⚠ IT IS THE THIRD FREE-RUNNING MODULE TO HOLD A FACE (after `analogVco` and
  // `macrooscillator`), so its `scope` glyph is live from spawn and its lane
  // baseline is REAL roster coverage for #1420's pre-frame AudioContext freeze.
  // That is why this face keeps the glyph instead of suppressing it with a
  // `hero.cell` picture: a hero cell would have made the tile silent-by-
  // construction and bought nothing the readouts do not already say.
  //
  // Two claims in the banked spec are REFUTED here rather than carried
  // forward, and both failed the same way — a measurement window shorter than
  // the thing measured. There is no DC rail at low `ratio` (at 0.005 the
  // modulator is a 1.3082 Hz sine at full scale, exactly the locked
  // prediction; the "+0.574 DC" is a 0.25 s window over a 0.76 s period, and
  // reads −0.052 over 2 s), and the 15.2 dB `sum_out` swing with TUNE is not a
  // beat — measured by interpolated zero-crossing over 4 s, the modulator sits
  // at EXACTLY the primary's frequency at `ratio = 1`, detune 0.000000 Hz.
  'swolevco',
]);

/**
 * The legacy-fallback MIGRATION derivation: is this module type MIGRATED to a
 * curated ModuleShell face? Drives the workflow `flowNodes` swap (migrated →
 * ModuleShell curated face; un-migrated → styled placeholder + legacy card in
 * the dock). The bridge and the face-lint gate read the SAME set, so a module is
 * "migrated" exactly when it's on the curation bar.
 *
 * A module is only truly migrated once it is BOTH faced AND promoted, so this
 * keys off STRICT_FACES membership (an authored-but-unpromoted `face` is a
 * draft-in-progress, not a shipped face). Pure — no registry read; the caller
 * already has the type. The bridge itself is wired in a later phase (P0.3 / P1).
 */
export function migrated(type: string): boolean {
  return STRICT_FACES.has(type);
}
