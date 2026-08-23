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
  // THE FACEPLATE QUEUE · Q23 — the first TABBED face, and the first VIDEO
  // module promoted here (2026-08-18). 31 params, 31 CV ports, 3 outputs.
  //
  // TABBED UNDER THE 2026-08-18 OWNER RULING, and the bar was MEASURED rather
  // than eyeballed: 31 params across TEN distinct control shapes (`discrete
  // 1..3` · `linear 1..12` · `0.5..11` · `0..8` · `discrete 0..1` · `0..2pi` ·
  // `4..60` · `-1..1` · `0.5..12` · `0..1`). Ten pages — `count`, then
  // figure/place/look per spiro — clear DOCK_TAB_MIN_BANDS = 7 without padding.
  // The four-page alternative (one page per spiro) was rejected on the ruling's
  // own words: it does not reach the rail AND it puts ten controls in a band,
  // which is `DOCK_ROW_MAX_CONTROLS` exactly — the dense-band shape the ruling
  // names.
  //
  // ⚠ THE AUDIT'S FINDING IS THAT TWENTY OF THE THIRTY-ONE PARAMS ARE
  // BIT-EXACTLY INERT AT SPAWN. `count` ships at 1, so spiro 2 and spiro 3
  // render nothing at all while carrying full, plausible-looking banks of ten
  // dials each. Nothing in the product said so, and it is the single most
  // expensive thing about the module to discover by hand. All three hero
  // readouts are gated on it — which is also what makes them un-fakeable by a
  // knob readback: at `count = 1`, perturbing any of spiro 3's ten dials moves
  // NONE of them while its own dial happily reports the new value.
  //
  // ⚠ SECOND FINDING: `inside` had NO `options` ROSTER — the fourplexer class
  // again, on the choice between a HYPOTROCHOID and an EPITROCHOID. The card
  // named the two states in a local `formatInside()`, and promotion removes the
  // card, so the faceplate would have rendered a two-position dial reading
  // `0`/`1` for the most visible decision on a spiro. Roster declared on the
  // def; cosmetic, so `contract-lock` does not move.
  //
  // ⚠ THIRD FINDING, and it is the one worth printing: WHETHER A FIGURE CLIPS
  // IS SCALE-INVARIANT. Only the FIXED circle is bound-constrained — its centre
  // bounces inside a box inset by its own screen radius `R * scale` — while the
  // drawn curve may overflow, which the module intends. So the curve reaches
  // past the frame exactly when `curveMaxReach > R`, and `scale` multiplies
  // BOTH sides and cancels. A zoom control that cannot change whether the
  // picture clips is not what a player assumes. Measured at the shipped
  // defaults: spiro 1 reaches 4.2 against R = 5 and always fits; spiro 2
  // reaches 7.5 against R = 7 and spiro 3 reaches 9.0 against R = 5, so both
  // can clip.
  //
  // ⚠ `glyph: 'none'` IS REQUIRED AND COUNTER-INTUITIVE. A video def has no
  // `audio` output, so `primaryAudioOutPortId` returns null and any other glyph
  // resolves to `{kind:'static'}` and reddens the dead-glyph clause. The
  // picture arrives from `hasVideoSurface(def)` instead, so `'none' + blank
  // tile` and `'none' + live picture` are indistinguishable from the
  // declaration — the face test asserts `hasVideoSurface`, which is the only
  // thing that tells them apart.
  //
  // The card also gains the SCREEN ON/OFF preview toggle (owner ruling
  // 2026-08-18), persisted in `node.data` like backdraft's so it survives a tab
  // switch. It can never tear down a producer here: the picture is produced by
  // the VIDEO ENGINE's module instance and this card only READS it, so
  // collapsing stops a BLIT and nothing else.
  'spirographs',
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
  // THE FACEPLATE QUEUE · Q35 — the dual trigger delay (2026-08-19). Three
  // params, two `gate` in, two `gate` out, two honest pages, no rail.
  //
  // ⚠ THE MERIT IS ONE NUMBER THE MODULE COULD NOT PRINT: the clock rate above
  // which the output is COMPLETELY SILENT. There is no trigger queue — an edge
  // arriving inside a running countdown RE-ARMS it — so a clock at or above
  // `1/delay` never lets one finish. Measured on the SHIPPING worklet at the
  // 0.1 s default, rising edges on `out1` over a 3.0 s render: 4 Hz -> 12/12,
  // 8 Hz -> 24/24, 9.9 Hz -> 29/30, then 10 Hz -> 0/30, 16 Hz -> 0/48,
  // 32 Hz -> 0/96. A CLIFF, bisected to 9.998958 Hz against a predicted
  // 10.000000. Positive control: the same 16 and 32 Hz clocks at the 0.002 s
  // minimum give 48/48 and 96/96. That is #1886 — FILED, NOT FIXED here, because
  // adding a queue changes what the module sounds like and belongs to the
  // owner's ears; the face makes it visible and the docs now state it.
  //
  // ⚠ STOP 2 HAD A REAL ITEM AND `options[]` PAID IT FOR FREE. The card renders
  // a live three-state NAME (OFF / PARALLEL / SERIES) from an exported const the
  // shell never reads, so a def-driven face would have printed `0.00` — a
  // functional-parity regression, which is a hard requirement rather than a
  // trade. `mode` was already `curve: 'discrete'`, so declaring the roster costs
  // no contract line and no attest, and the names come back from the
  // DECLARATION instead of from card markup.
  //
  // ⚠ AND THE OBVIOUS DISCRETE-MISMATCH FINDING IS FALSE HERE. `Knob.svelte` has
  // no `discrete` branch and the pure core clamps `mode <= 0 … >= 2`, which
  // together predict the card's name disagreeing with the DSP over HALF the
  // dial. Measured: 0 of 41 sampled positions disagree, because the WORKLET
  // rounds first and the boundaries bisect to 0.4999999851 / 1.4999999404 —
  // exactly `Math.round`. Promotion is behaviour-preserving on `mode`. The same
  // reasoning is CORRECT for `moog921b.range`; only reading the consumer
  // separates them.
  //
  // Ranking `delay1, mode, delay2`, and rank 2 is measured rather than asserted:
  // driving TRIG 2 ALONE gives one pulse in OFF and NONE in PARALLEL or SERIES,
  // so MODE turns an input JACK on and off while DELAY 1 is never conditional.
  // All three params are bit-exactly inert at spawn, so — as on moog911 —
  // inertness discriminates nothing and the ranking rests on the gating.
  'moog911a',
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
  // MOOG 993 TRIGGER & ENVELOPE VOLTAGES (2026-08-19) — promoted on the back of
  // the #1911 fix, and the NARROWEST merit case in the set, recorded as such.
  //
  // Three params, no families, no `node.data`, and the three routers are PEERS,
  // so the "what does a shrinking tier keep" argument is nearly empty: mini
  // shows ROUTE 1 because it is the first out on the panel. What earns the two
  // baselines is the hero readout — the module's CONFIGURATION (a 1→3 trigger
  // multiple, or three outs split between two clocks, both named in its docs)
  // is a property of all three switches at once and no switch can print it.
  //
  // The cells are SEGMENTED rather than dials as a consequence of the def: each
  // router declares an `options` roster, which `paramCellKind` renders as a
  // segmented cell at the dock and which paints OFF / FROM 1 / FROM 2 instead
  // of a bare number. Before #1911 these were `curve: 'linear'` dials over a
  // DSP selecting on exact float equality — 149 of 201 dial positions delivered
  // silence — so promoting this module BEFORE that fix would have shipped the
  // same continuous dial onto a def-driven faceplate.
  'moog993',
  // THE FACEPLATE QUEUE · Q32 — OUTLINES, a stateful particle field, and the
  // face whose PAGES carry the module's hardest-to-discover property
  // (2026-08-19).
  //
  // FIVE OF ITS SEVEN KNOBS ARE LATCHED AT SPAWN. `d`, `v`, `spd`, `decay` and
  // `shape` are copied into each shape as it is born; turning them afterwards
  // changes nothing about what is already on screen. A player who turns SPEED
  // and sees nothing move is looking at a control that only applies to the
  // future. So `pages` groups by WHEN a control acts — spawn clock / latched at
  // birth / live field — rather than by what it affects, and the band labels
  // are the only place a resting faceplate states it.
  //
  // ⚠ `rotation` is the ONLY live control and still ranks sixth, because
  // `mapAngularVel(0.5)` is BIT-EXACTLY 0 and 0.5 is the shipped default — the
  // inertness-at-spawn rule beating conceptual importance.
  //
  // The four readouts are not joins; each exists because its mapping is
  // DISCONTINUOUS where the dial is not (`rate`'s engage step from no-clock to
  // 3996.50 ms; `decay = 0` as a persist MODE with the default sitting exactly
  // on it; `shape`'s six 0.166667 bands). Two of them are a PARITY requirement
  // — the card prints shape and spin, and promotion deletes the card.
  'outlines',
  // TREE.oh.VOX (2026-08-19, queue Q3) — promoted on the back of #1658, and the
  // entry whose READOUTS refute its own CUTOFF knob.
  //
  // The voice sweeps its ladder per sample by Open303's hardware-measured law,
  // `instCutoff = cutoff · 2^(scaler·(env − offset) + accentGain·env)`. At the
  // def's own defaults the CUTOFF DIAL SAYS 1000 Hz while the filter rests at
  // 533.4 Hz and peaks at 3757.6 Hz — the dial's number is a frequency the
  // filter is never at. Holding CUTOFF still and sweeping ENVMOD moves the peak
  // 1463 → 9651 Hz while REST moves the OPPOSITE way, 835 → 341 Hz, and no knob
  // readback can see either.
  //
  // ⚠ ITS AUDITION IS NOT OPTIONAL AND THE DEF SAYS SO. treeohvox is bit-silent
  // with nothing patched (0.000e+0 over 145 frames), and its card's gate pad
  // reached the dock only while it had no face. `treeohvox-gate-{n}` is ranked
  // THIRD — inside the compact lane budget — so the smallest tile showing more
  // than one control can already sound the voice.
  //
  // ⚠ ACCENT IS RANKED DOCK-ONLY on a measurement, not a preference: the
  // audition ConstantSource drives worklet input 1 (`gate_in`) alone, so an
  // auditioned note is never accented and ACCENT does nothing on the only
  // surface that can sound the module unpatched.
  'treeohvox',
  // MOOG 984 4×4 MATRIX MIXER (2026-08-19) — the first face whose subject is a
  // TABLE, and the entry that retires a "needs a MATRIX cell" blocker as stale.
  //
  // It needed no platform work. `consoleGridCols` already turns a band into a
  // fixed-column CONSOLE GRID when its clusters are equal-sized and stacked, so
  // ONE band of four 4-cell clusters renders the matrix with column j sharing a
  // centre down all four input rows — the mechanism shipping on mixmstrs.
  // (Declaring FOUR bands instead is the trap: `packRun` packs `[4,4,4,4]` into
  // two rows of eight and there is no matrix left.)
  //
  // ⚠ ITS SIXTEEN CONTROLS ARE BIT-EXACTLY SYMMETRIC — one generator loop, one
  // identical GainNode each — so unlike every other entry here the RANKING
  // carries nothing, and the face says so instead of dressing it up. What earns
  // the two baselines is the four hero readouts: `out_j = Σ_i in_i · m_ij`, so
  // an output's gain is a JOIN over a column that no cross-point can print. The
  // matrix makes that blindness geometric — a readback of `m11` moves
  // convincingly while being invariant to `m21`/`m31`/`m41`, three quarters of
  // what OUT 1 actually carries — and both negative-control legs are permanent
  // in `moog984-face-model.test.ts`.
  //
  // Its lane tile today is the un-migrated PLACEHOLDER (`laneRenderKind`
  // returns `'placeholder'`, not `'legacy'`, because faceplates are the
  // default), so promotion takes that surface from zero controls to six.
  'moog984',
  // THE FACEPLATE QUEUE · Q26 — GRAINS OF VISION, the granular video synth, and
  // the promotion that had to REPAIR AN EXISTING SPEC IN THE SAME DIFF.
  //
  // ⚠ THAT IS THE HEADLINE, NOT THE FACE. `workflow-shell-video.spec.ts` spawned
  // a literal `grainsOfVision` and said why in its own comment: the module is
  // UN-MIGRATED, so it exercises the PLACEHOLDER host of `VideoTileThumb` while
  // `backdraft` exercises the FACED one. A faced tile also has a thumb (#1785),
  // so promoting the hard-coded subject leaves all three of its assertions —
  // the tile has a thumb, the thumb's blit drives the real chain, the picture
  // animates — PASSING, while the host they exist to prove stops being covered.
  // Green, not red: CLAUDE.md's "a gate whose PRECONDITION is the defect" class.
  // The subject is now DERIVED (`VIDEO_SINK_FIXTURE`), so the next promotion
  // re-points it automatically and the pool refills (#1929).
  //
  // WHAT THE FACE IS. Six bands, untabbed, one per stage of a fixed chain:
  // grain / scatter / time / feedback / reverb / composite. `rate` is the hero
  // rank because it is the only control in the video bank that reaches into a
  // frame HISTORY — every other granular knob has a spatial analogue elsewhere.
  //
  // ⚠ TWO DEFECTS FIXED HERE BECAUSE THE FACE WOULD HAVE PAINTED THEM.
  // `fb_dry`/`rev_dry` are consumed as `>= 0.5` and were declared
  // `curve: 'linear'`, so a def-driven faceplate renders a continuous rotary
  // over a two-state value — and the CARD'S OWN COMMENT already claimed they
  // "render as 2-step DRY toggles" while the code did not honour it. And
  // `composite` had no `options[]`, so its five named modes would have painted
  // as an unlabelled 0..4 dial once the card's card-local formatter died with
  // the card.
  'grainsOfVision',
  // THE FACEPLATE QUEUE · Q31 — MIRRORPOOL, the fourth VIDEO face and the
  // second adopter of `face.xyPads` (2026-08-19).
  //
  // The audit's answer was "ZERO un-exposed DSP capability", which is a finding
  // rather than a shortfall — every one of the eleven params reaches the
  // shader, and every one has a matching CV input. What the face adds is not
  // access, it is ORIENTATION.
  //
  // ⚠ THREE OF THE QUEUE'S OWN PRESCRIPTIONS WERE REFUTED BY RE-MEASUREMENT,
  // and they are recorded on the def beside the declarations they changed:
  //   * "compact adds the position pad" — no lane tier EVER shows a pad;
  //     `laneOrder` excludes every pad anchor by construction.
  //   * an ABOVE/BELOW `eye-side` readout "genuinely underivable from any
  //     single knob" — it is `sign(orbit_el)` relabelled, since `dist` is
  //     clamped strictly positive (729 camera settings, zero disagreements).
  //     The `orbit_el`×`orbit_dist` JOIN that replaced it is real — the eye's
  //     horizontal radius is `dist·cos el`, so a readback of either dial is
  //     blind to the other — but it PAINTS NOWHERE: the resting-text ruling
  //     (#1957) landed after this face was built and deleted `hero.readouts`
  //     outright, so the arithmetic survives only in the unit lane
  //     (`mirrorpool-face-model.test.ts`) and in `aria-valuetext`.
  //   * the spec did not mention `paramCells` at all, and all seven non-pad
  //     controls are `<NeonFader>` throws on the card — undeclared, promotion
  //     would have silently repainted every one of them as a dial.
  //
  // The measurements it did make all reproduced exactly (fovY 70/45/20°, eye.y
  // −0.00026000 at `orbit_el = −0.0001`, `surfaceReflectivity(F, 0) === F`
  // bit-exactly, `wind_dir` bit-exactly inert at `wind_speed = 0`).
  'mirrorpool',
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

  // THE FACEPLATE QUEUE · the 921 pair's THIRD family member — `moog921Vco`,
  // the standalone monolith. Same oscillator core, a different instrument: the
  // driver and the slave packed into one module, with the jack neither half of
  // the pair has between them — its OWN 1V/oct input. Four simultaneous taps off
  // one phase, so a keyboard patched straight in feeds four timbres of the same
  // note to four destinations.
  //
  // ⚠ THE MERIT IS A 12-OCTAVE COMPASS PRINTED AS `0 oct` AND `0 st`. RANGE
  // (±5 oct) and FREQ (±12 st) join into ONE frequency through the shipping
  // core, and at the def's own declared endpoints that join spans
  // 4.09 Hz … 16.74 kHz — twelve octaves exactly. Both dials read ZERO at the
  // factory settings, where the answer is 261.63 Hz, and the C4 reference the
  // whole thing hangs off appears on no panel. The `pitch` readout is the only
  // surface in the app that states it.
  //
  // ⚠ TWO OF ITS SIX CONTROLS ARE BIT-EXACTLY DEAD AT SPAWN, and that is the
  // rank argument rather than a taste call. Rendered through the SHIPPING
  // worklet at 48 kHz with a 200 Hz sine on the jack, comparing against an
  // unpatched render and reporting the LAST DIVERGENT SAMPLE — the only
  // window-independent way to ask, and the attack the spec recorded against
  // itself: `linFmAmount = 0` and `sync = 0` each render BIT-IDENTICAL output.
  // Positive controls that do diverge: `linFmAmount = 0.01` (a ±20 Hz span) and
  // `sync = +1`, both through the final sample. So LIN FM and SYNC rank last,
  // and RANGE — never inert — is the hero.
  //
  // ⚠ A SWITCH VOCABULARY RECOVERED FROM CARD MARKUP, and a dead zone closed
  // with it (#1887). `SOFT`/`OFF`/`HARD` existed only in `Moog921VcoCard`'s
  // private array, so a def-driven surface painted a continuous rotary printing
  // `0.00` over a three-position comparator whose `off` state is EXACTLY 50 % of
  // the declared travel. `curve` went `linear` → `discrete` to make a
  // `ParamDef.options` roster legal, and the card now MAPS that roster. The dead
  // zone was reachable before this: a Push 2 encoder maps through
  // `knobFracToValue(frac, min, max, curve)`, and `sync = 0.3` measured
  // BIT-IDENTICAL to an unpatched sync jack while all three card buttons
  // rendered un-selected. ⚠ The names deliberately DIFFER from `moog921b`'s
  // `LO`/`OFF`/`HI` — each module keeps the vocabulary its own panel has always
  // painted; renaming a control the player knows would drop an affordance while
  // claiming to recover one.
  //
  // ⚠ THE GLYPH RESOLVES TO ONE TAP OF FOUR, AND THE FOUR ARE NOT LEVEL-MATCHED.
  // `primaryAudioOutPortId` is `sine` (first declared `audio` output), so the
  // trace is the sine tap alone — and measured at one LEVEL setting the jacks
  // sit −0.044 dB (rect), −3.011 dB (sine), −4.771 dB (triangle), −4.834 dB
  // (saw): a 4.789 dB spread, with the glyph drawing the middle of it. Both
  // facts are in `docs` and asserted in moog921-face-model.test.ts. It JOINS THE
  // VRT ROSTER'S FREE-RUNNING SET for the same reason moog921b does — a VCO with
  // no gate, sounding from sample 0 — so its compact tile exercises #1420's
  // pre-frame audio freeze. What would silently retire that property: `level`
  // ceasing to default to unity, and nothing else; there is no engine selector
  // here that could move the default onto a struck voice.
  //
  // DEFECTS FIXED HERE (module-scoped, so folded in rather than sequenced):
  // #1887 (the comparator's shape, above), #1882 (the docs promised THROUGH-ZERO
  // linear FM that the core's positive 0.01 Hz floor forecloses) and #1792 (the
  // "1 Hz to 40 kHz" prose, wrong at both ends, at every one of its sites).
  // FILED RATHER THAN FOLDED IN, because both change what the module SOUNDS
  // like: #1883 (SOFT sync is a conditional HARD zero, bit-identical to HARD at
  // 67.77 % of pitches) and the width_cv over-authority — a ±1 LFO against a
  // 0.96-wide knob span is 2.08×, so a full-scale modulator spends 68 % of every
  // cycle pinned at 2 % or 98 % instead of sweeping.
  'moog921Vco',
  // THE FACEPLATE QUEUE · Q38 — `moog902`, the rack's only DIFFERENTIAL VCA
  // (level as a voltage, with a bit-exact phase-inverted twin on a second jack).
  //
  // THE FINDING THIS FACE SHIPS: its RESPONSE switch is a LEVEL CONTROL wearing
  // a character switch's clothes, and nothing on the module said so. Measured on
  // the shipping worklet with a CHANNEL-AWARE probe, the LINEAR and EXPONENTIAL
  // laws coincide at ONLY two points — 0 V and the 6 V anchor — so between them
  // flipping the switch moves the output by −2.9841 dB at the shipped pot
  // position and by −5.4525 dB near the bottom of the dial, WITH NO DIAL
  // MOVEMENT. Unity itself moves with it (pot 0.499999985 → 0.641521305). The
  // face prints that as `moog902-gain-db`, whose permanent negative control is
  // exactly the switch a knob readback is blind to.
  //
  // ⚠ AND ITS DOCS WERE WRONG ABOUT THE CEILING, IN THE DEFAULT MODE (#1912,
  // FIXED IN THIS PR RATHER THAN FILED — it is prose, so it changes no audio).
  // "the ×3 ceiling near ~7.5 V" appeared unconditionally at five sites; 7.5 V
  // is the EXPONENTIAL curve's fitted anchor, and the LINEAR arm — WHICH IS THE
  // SHIPPED DEFAULT — reaches ×3 at 9.000000 V, delivering only ×2.500000 at
  // 7.5 V. The second readout (`moog902-ceiling`) prints the mode's real
  // ceiling, and it is INVARIANT to the gain pot, which is what keeps the two
  // readouts each other's control.
  //
  // Its VRT exemption reason carried two more falsehoods, both fixed here: it
  // described the legacy card this promotion makes unreachable, and it credited
  // ART coverage that does not exist (no `art/scenarios/moog902/`; the module is
  // in the ART backlog).
  //
  // ⚠ THE RAW-WRITE LEDGER ENTRY STAYS, against the spec's instruction, and the
  // reason is measured rather than argued: promotion does not delete
  // `Moog902VcaCard.svelte`, so its `target.params.mode = v` write still exists
  // and `mutate.guard`'s deny-by-default direction would redden on an entry
  // removed while the write remains. `moog921Vco` is the precedent — promoted,
  // card retained, ledger entry retained, green on main.
  'moog902',
  // THE FACEPLATE QUEUE · Q39 — `moog904a`, the transistor-ladder 24 dB/oct
  // low-pass: the one filter that stops being a filter and becomes an oscillator.
  //
  // THE FINDING: a cutoff dial that DECLARES `units: 'Hz'` and delivers three
  // different frequencies for the same number. RANGE multiplies the dial by
  // ×1 / ×4 / ×16 before the ladder sees it, so a dial pinned at 1000 Hz places
  // the filter at 1000 / 4000 / 16000 Hz — and nothing on the module said so.
  //
  // ⚠ AND THE CLAMP MAKES THE TOP OF THE DIAL BIT-EXACTLY DEAD. The 20 kHz
  // ceiling applies to the PRODUCT, so at RANGE 2 every dial position from
  // 5000 Hz up and at RANGE 3 every position from 1250 Hz up renders IDENTICALLY
  // to the maximum — the top 20.07 % and 40.14 % of the log taper, boundaries
  // landing exactly on 20000 ÷ ×4 and 20000 ÷ ×16, with a negative control 2 %
  // below each correctly differing. The `moog904a-cutoff-hz` readout pins at
  // `20.0 kHz` across precisely that span, so the face SHOWS the dead zone.
  // (Measured on the settled TAIL. Comparing whole buffers reports 0.00 / 0.00 /
  // 6.17 % instead, because `smCutoff` smooths the RAW dial in Hz BEFORE the
  // multiply-and-clamp — two dials that settle to one filter travel there
  // differently.)
  //
  // ⚠ THE SPEC'S PROPOSED CORNER READOUT WAS REJECTED ON A MEASUREMENT, not
  // skipped. `cutoff · rangeMultiplier · 0.43419` was described as carrying a
  // 0.19 % bias; that constant is the 4-pole cascade's LOW-FREQUENCY limit and
  // the ladder is a TPT design whose `tan` prewarp compresses toward Nyquist, so
  // the real error is −0.04 % / −1.70 % / −29.40 % at RANGE 1 / 2 / 3. Shipping
  // it would have printed a confident number nearly half an octave wrong exactly
  // where the module's headline claim lives.
  //
  // #1913 IS FILED, NOT FIXED — it is OWNER EARS (pitch and level), and no audio
  // changes here. What this PR does owe it is NAMING WHICH QUANTITY: as a FILTER
  // the module IS 1 V/oct (+0.998 / +1.999 / +3.002 oct at +1 / +2 / +3 V), and
  // as an OSCILLATOR it is NOT (+0.981 / +1.946 / +2.880 oct) — so "moog904a is
  // 1 V/oct" and "moog904a is not 1 V/oct" are BOTH true and the question is only
  // answerable by saying which. The docs now say which. ⚠ The first probe to ask
  // this got the FILTER answer wrong (×2.12 at +1 V) by bisecting with the corner
  // near Nyquist, where the TPT prewarp dominates — an instrument artefact, not
  // the DSP; re-measured at dial 200 Hz / RANGE 1 with a dial-doubling positive
  // control reproducing the same residual.
  //
  // ⚠ RAW-WRITE LEDGER: the `Moog904aVcfCard` entry STAYS, for the reason
  // measured on moog902 — promotion does not delete the card FILE, so its
  // `target.params.range = v` write still exists and removing the entry would
  // redden `mutate.guard`'s deny-by-default direction.
  'moog904a',
  // THE FACEPLATE QUEUE · Q40 — `moog912`, the rack's only ANALYSIS module, and
  // ⚠ THE CLOSEST STOP-1 CALL IN THE COHORT. Two params, no control families, no
  // `node.data` — three of the four refuse conditions. It is promoted on the
  // FOURTH clause alone (a derived quantity worth a readout), and if the
  // readouts are ever cut the answer flips to NO FACE ON MERIT rather than
  // degrading to a thin face. The moogCp3 precedent: the merit is the READOUT.
  //
  // WHAT THE READOUTS SAY THAT NOTHING ELSE DOES:
  //   response  the detector's cutoff in Hz. The SMOOTH dial is a bare 0..1 over
  //             an INVERTED logarithmic map — 50 Hz at 0, 1 Hz at 1, 5.64
  //             octaves, and turning the knob UP makes the number go DOWN.
  //             7.07 Hz at the shipped 0.5, which nothing on the module says.
  //   gate      how loud the input must be, in dBFS, to HOLD the gate open —
  //             −12.980 dBFS at the shipped sensitivity — and `—` once that
  //             passes full scale.
  //
  // ⚠ THAT DASH IS #1914 MADE VISIBLE. `GATE_THRESHOLD` is a bare constant that
  // does NOT scale with SENS, so below sens = 0.157080 no input can hold the
  // gate open — the bottom 15.71 % of a dial whose whole job is to open that
  // output. FILED, NOT FIXED (it changes behaviour); the face is where a player
  // can now see it.
  //
  // ⚠ THE NUMBER RANK 1 RESTS ON WAS UNVERIFIED, AND THIS PR VERIFIES IT. §27.6
  // derived the gate threshold arithmetically and said in terms that no
  // BiquadFilterNode had been run. `art/scenarios/moog912/face-audit.test.ts`
  // now drives the SHIPPING factory through a real node-web-audio-api
  // OfflineAudioContext: the settled envelope lands on 0.100001 against a
  // threshold of 0.100000. The arithmetic was right.
  //
  // ⚠ AND THE FIRST INSTRUMENT WAS WRONG, which is why that file keeps the
  // failure as a permanent leg. Bisecting on "did the gate EVER open" reported
  // −14.488 dBFS and read as though the spec were wrong by 1.5 dB. It was not:
  // the envelope OVERSHOOTS its steady state on attack by a constant 1.1861×, so
  // the module has TWO thresholds — a transient one and a sustained one — and
  // the readout prints the sustained one. Both are asserted, in both directions.
  //
  // ⚠ NO MILLISECOND READOUT, rejected on a measurement rather than skipped.
  // §27.6 proposed the ONE-POLE 10–90 % rise; the shipping filter is a BIQUAD at
  // Q = 0.5, measured 30 % away from it — and the rendered figure is itself
  // ripple-contaminated at the fast end. Two uncertain numbers are not a
  // readout, so the face prints the EXACT cutoff instead.
  //
  // FOLDED IN (behaviour-preserving, per the brief): the NaN guard from #1914.
  // `smoothingToCutoffHz`'s clamp was `v < 0 ? 0 : v > 1 ? 1 : v`, and BOTH
  // comparisons are false for NaN, so NaN fell through, `Math.exp` of it is NaN,
  // and that NaN reached `envFilter.frequency` — after which ENV and GATE were
  // both dead until something wrote a finite value. Every FINITE input maps
  // exactly as before.
  //
  // FILED SEPARATELY: #1918 — `buildRectifyCurve(1024)` has an EVEN length, so
  // x = 0 is never sampled and the curve's minimum is 9.7752e-4 rather than 0. A
  // silenced 912 therefore emits a small constant DC on ENV forever. Found by
  // this module's own POSITIVE CONTROL failing, which is the argument for
  // writing them.
  'moog912',
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
  // THE FACEPLATE QUEUE · Q33 — the video sample-and-hold (2026-08-19), and the
  // THIRD video module to hold a face.
  //
  // ⚠ THE FACE SHIPS WITH A FIX, AND THE FIX IS WHY THE RANKING LEADS WHERE IT
  // DOES. `quant_luma` reaches the combined output through a different path
  // from R/G/B — a hue-preserving luma ratio rather than a per-channel
  // posterize — and #1861 lived in exactly that asymmetry: AT ITS OWN DECLARED
  // MINIMUM, which three separate doc strings called a passthrough, it was
  // moving 38.66 % of the 8-bit RGB cube (6,485,727 of 16,777,216 triplets,
  // worst 8 code values) and forcing 25 legitimate near-blacks to EXACTLY
  // black. So the knob the docs said did nothing was the one doing the most.
  // It ranks 1.
  //
  // ⚠ THE DEFECT'S CAUSE AND ITS INVISIBILITY ARE THE SAME FACT.
  // `posterizeChannel` is EXACTLY identity on the 8-bit grid (all 256 code
  // values verified), and it was tested there. Nothing joined that grid
  // assumption to the LUMA call site, whose input is a weighted sum of three
  // 8-bit values and therefore off-grid by construction — one side of a
  // two-sided contract, gated; the other side, not. The fix adds the missing
  // side: `quantizeCombined`, the JS mirror of the shader's combined branch
  // that did not previously exist, walked over the WHOLE cube rather than a
  // sample, because "38.66 % of colours move" is not a property any sample can
  // establish.
  //
  // ⚠ NO GATE READOUT, DELIBERATELY. A `FaceReadoutValue` receives only a param
  // reader, and `gateLevel` reads 0 both when NOTHING is patched (live
  // passthrough) and when a gate IS patched and low (frozen). Those are the two
  // states this module exists to distinguish, they are opposites, and no input
  // a readout can see separates them. This is the `sidecar` precedent — the
  // finding is carried by the band labels and by `docs`, never by a caption
  // that would be confidently wrong half the time.
  //
  // `gateLevel` itself is the first `noUserControl` declaration outside
  // backdraft: the cv jack renders, the knob never did, and #1726's mechanism
  // is what lets a face say so instead of painting a rotary over a gate swing.
  'freezeframe',
  // B3NTB0X (2026-08-19, queue Q24) — the composite-video destroyer, and the
  // most control-heavy video face in the set at 20 painted params.
  //
  // ⚠ ITS TWO READOUTS ARE THE MERIT CASE AND BOTH ARE JOINS THE PAGES SPLIT.
  // The bend circuit's ripple gain is `sync_crush · (1 + 2·enhance) ·
  // (1 + 0.8·bend_d)` — verified against a numeric replay of the shader to
  // 1.776e-15 over 972 points — and the face puts those three on two different
  // pages. It carries a real `1.6·d·E` cross term, so at both full it is ×5.40
  // where independent controls would give ×3.80, which is why no pair of dials
  // recovers it. And `bias` is deliberately NOT in it.
  //
  // ⚠ `enhance` AND `bend_d` ARE TWO STAGES, NOT ONE (#1940 corrected). ENHANCE
  // lands before the sync_crush multiply and the bias add, BEND D after both,
  // so ENHANCE is purely a ripple-gain control while BEND D also multiplies the
  // bias term by `(1+0.8d)`. The face ranks them adjacent (5 and 6) so no tier
  // shows one without the other and hides the interaction.
  //
  // ⚠ `line shift` STATES A LIVE DEFECT WITHOUT MOVING A PIXEL (#1946). `tbc`
  // defaults to 1 and `recoverLineOffset` returns `(rawOffset + wobble) *
  // (1 - tbc)`, so at the shipped settings the picture cannot tear or roll
  // however hard the sync tip is crushed — which is exactly what the module's
  // own docs instruct a player to do. The readout prints `locked` there, and
  // TBC is ranked third, into the same tier as the pair it gates.
  //
  // SIX pages, which does NOT reach `DOCK_TAB_MIN_BANDS = 7`, and no page is
  // padded to make it: FEEDBACK groups with the CRT controls because it is
  // literally a `crtProgram` uniform. The threshold question is raised, not
  // settled, in the PR.
  'b3ntb0x',
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
  // THE FACEPLATE QUEUE · Q42 — the stereo VCA / ring modulator (2026-08-19).
  //
  // A TWO-PARAM MODULE, so STOP 1 is the whole question and the answer is
  // narrow enough to write down. `noise` is the refusal precedent (one param,
  // every tier renders the identical control, nothing to rank). This module
  // clears that bar on ONE fact, measured off the shipping worklet rather than
  // argued: with nothing patched into `strength_*` the multiplier is `0 +
  // offset`, so at the shipped defaults every output sample is a multiply by a
  // literal zero. `level` is therefore bit-exactly INERT at spawn and `offset`
  // is the only control that can un-mute the module — which is a ranking
  // argument that WOULD BE WRONG for a different module, and it inverts
  // declaration order. A face is also the only surface that can say so: the
  // legacy card's two faders can render neither a landmark tick nor a state
  // name, so `MUTE at the centre, UNITY at both ends` has nowhere to appear.
  //
  // ⚠ THE MERIT ARGUMENT MOVED, AND THIS COMMENT RECORDS THE MOVE RATHER THAN
  // HIDING IT. The Q42 spec staked the merit on a DERIVED READOUT (a quiescent
  // `MUTE` / dB line) and said outright that cutting it flips the verdict to NO
  // FACE ON MERIT. The owner then ruled that legibility onto the CONTROL
  // instead (#1962, verbatim *"2 - b"*), so the readout is gone and a landmark
  // roster carries it. That is a NARROWER claim — a name on `offset` cannot see
  // `level` — and it is the half worth keeping: a level fader at zero is
  // self-evidently silent, an OFFSET at centre is not.
  //
  // NOT CONTROL-HEAVY (2026-08-18 tabbed ruling): two controls, one honest
  // page, no rail. See the def for the tier ladder and the fader/knob split.
  'stereovca',
  // THE FACEPLATE QUEUE · Q47 — the stereo wavetable oscillator (2026-08-20).
  //
  // ⚠ THE RECORDED BLOCKER WAS STALE IN BOTH HALVES, and the def had already
  // said so. The inventory rejected this module because wavetable selection
  // lives in `node.data`, which `FaceReadoutValue` cannot see. True, and
  // irrelevant: that type is a PARAM READER and is correctly blind to
  // node.data — while `shell-cells` specs are NODE-TAKING CLOSURES, by design
  // and by their own comments ("a dropdown over a NAMED roster that lives in
  // node.data"). The precedent is this def's own header, which describes the
  // wavetable pattern as the "same shape as the DX7 preset pattern" — and dx7
  // is a registered adopter of BOTH a `selector` and a `file` cell today.
  // #2010 reached the same conclusion from the documentation side in the same
  // week, which is the measure of how much of the remaining pool is gated on
  // prose rather than on platform.
  //
  // ⚠ NOT THE FIRST `toggle` CELL ADOPTER, WHICH IS WHERE THE BUILD ESTIMATE
  // WAS WRONG. The viz toggle looked like it needed the data-backed `toggle`
  // cell (zero adopters, real first-adopter cost) because the card reads
  // "from node.data so the choice persists across page reloads + multiplayer"
  // right beside it. That sentence is about `wavetableSource`.
  // `WavecelCard.svelte:54` holds the toggle as `$state<'scope'|'3d'>`, and
  // both video OUTPUTS render their own view regardless of it — so it is a
  // private view preference over the on-card picture, and it belongs INSIDE
  // the panel. Read the line before pricing the cell.
  //
  // ⚠ THE PICTURE IS A PANEL, NOT AN EXTENSION — `analogVco`'s shape, not
  // `rasterize`'s. Both of those are audio defs the shell cannot draw
  // generically, but rasterize's raster is PRODUCED inside `read('imageData')`
  // (its surface must carry a per-frame push, and has no probe of its own),
  // while this picture is DERIVED from `node.data` + params + CV taps. The
  // panel's probe reads the view toggle that lives INSIDE it, so it observes
  // its own subject rather than a neighbour's caption.
  //
  // GLYPH `'waveform'`, with the rejected option recorded because the next
  // module with an ADSR will ask: this is the only def in its cohort that can
  // resolve `'envelope'` (that arm is checked before the audio-out
  // short-circuit and needs literal A/D/S/R, which this has). Declined — the
  // contour would draw a control set that is bit-exactly INERT in the default
  // ungated state. `out_l` free-runs at 0.9999845624 peak, so the trace shows
  // what is actually being heard. Deterministic under the harness's audio
  // freeze, the `swolevco` case, and this makes a third free-running module
  // covering that freeze.
  //
  // NOT CONTROL-HEAVY (2026-08-18 tabbed ruling): ten params in three genuine
  // groups — tone / amp env / table. Three bands, well under the rail's seven.
  //
  // ⚠ #1999 IS LEFT OPEN (owner ears) and the face is built AROUND it rather
  // than over it: SPREAD ships bit-exactly MONO (side energy 0.00000000, and
  // −34.08 dB even at maximum), FOLD moves −0.0017 dB at the shipped MORPH,
  // and five of ten params are bit-inert at spawn. The rank says so; no audio
  // behaviour changed here.
  'wavecel',
  // THE FACEPLATE QUEUE · Q46 — the audio→video raster mapper (2026-08-20).
  //
  // ⚠ THE STOP-2 FINDING IS A PICTURE, AND NO GENERIC SEAM REACHES IT. Every
  // previous "the shell can draw this" argument leaned on `hasVideoSurface`,
  // which is literally `def.domain === 'video'`. This module is
  // `domain: 'audio'` with a `mono-video` OUT and a frame painted in JS by
  // `RasterPainter` — a case that predicate's own doc-comment names as
  // deliberately excluded, because there is no VideoEngine surface FBO to
  // blit. So promoting it would have swapped a live raster for four knobs on
  // the one module whose entire job is to make a picture. The committed
  // face-migration inventory had already called this: "the scan preview is a
  // read-only picture with no glyph kind — it needs a registered panel or it
  // is a look loss". Resolved through `fullViewBody` (#1726), the slot
  // `videoOut` and `backdraft` use — a declaration, not a carve-out.
  //
  // ⚠ AND THE COLLAPSE RULE INVERTS ON THIS MODULE, which is the detail most
  // likely to be copied wrongly from the other adopters. Their producer is the
  // VIDEO ENGINE and the body only reads it, so SCREEN OFF stops a blit.
  // RASTERIZE's painter is advanced INSIDE `read('imageData')`, so with nothing
  // patched downstream the preview loop is the ONLY thing advancing the raster
  // — stopping it on collapse would freeze the module, the #1720/#1721 class.
  // The body therefore skips the BLIT and never the advance.
  //
  // ⚠ NO GLYPH IS A CHOICE HERE, NOT A FORCED ONE, unlike `moog921a` /
  // `fourplexer` where every output is `cv` and the dead-glyph clause decides
  // it. This def HAS an `audio` output, so a `scope` trace would resolve
  // legally — but THRU is the untouched passthrough, so the trace would draw
  // the INPUT while the module's real output is a picture it cannot draw, and
  // a live moving trace in a compact baseline is what got `analogVco` dropped
  // from batch 3. Asserted in the face-model test with a negative control
  // rather than trusted to this comment.
  //
  // ⚠ THE RANK INVERTS DECLARATION ORDER, and the reason is a live defect.
  // SCAN is declared first and ranks LAST: it is a CHANGE DETECTOR, not a
  // position control (#2000) — re-selecting a value it already displays is a
  // no-op, the knob diverges permanently from the real cursor (measured: knob
  // 1000, cursor 49 800), and the finest gesture moves ~39 px of a 786 432 px
  // range, so it cannot address its own declared `px` unit. #2000 and #2002
  // are LEFT OPEN deliberately: both propose behaviour changes to a
  // performance control and both say in their own bodies that they want a
  // decision before a build. This PR carries only #2001, which is a factual
  // docs error with no behaviour attached.
  //
  // NOT CONTROL-HEAVY (2026-08-18 tabbed ruling): four params, one honest
  // idea, one unlabelled band, no rail.
  'rasterize',
  // 4PLEXVID (queue Q44) — the 4-in / 4-out video cross-point switch, and the
  // video sibling of the already-faced audio `fourplexer`.
  //
  // ⚠ THE MERIT IS NOT THE RANKING — THERE ISN'T ONE — IT IS THAT PROMOTION
  // REPAIRS A CONTROL THAT WAS SHOWING THE WRONG ANSWER. The four selectors are
  // bit-identically symmetric, so the rank IS declaration order and the def's
  // own comment says so rather than inventing a priority. What earns the face is
  // measured: the factory took `{ ...DEFAULTS, ...node.params }` — a FRESH
  // OBJECT — and the gate path advanced only that copy, so after two rising
  // edges `handle.readParam('sel1')` was 2 while `node.params.sel1` was
  // untouched, and `FourPlexVidCard` reads the latter with no `readLive`. The
  // card showed IN 1 while OUT 1 carried IN 3, permanently, and a reload snapped
  // the router back — i.e. the module's headline feature neither displayed nor
  // persisted (#1959, fixed at the seam in the commit below this one).
  //
  // ⚠ AND THE FACE COULD NOT BE AUTHORED UNTIL FOUR "PARAMS" STOPPED BEING
  // OFFERED AS KNOBS (#1958). `gate1..4` are `linear 0..1` synthetic params
  // holding the edge detector's last level; `listExposableControls` returned all
  // eight, so a collapsed rack offered four dials where a drag past
  // `GATE_RISE = 0.6` rotates the router. They are declared `noUserControl`
  // (`writer: 'cv-port'`, anchored to the four `paramTarget` jacks), which is
  // both the live fix and the reason face completeness has something to satisfy.
  //
  // ⚠ THE INPUT NAMES EXISTED ONLY IN THE CARD, AND PROMOTION DELETES THE CARD.
  // `IN1…IN4` came from a card-local formatter, so a face authored without an
  // `options` roster would paint a four-position ANONYMOUS dial on a module
  // whose whole job is naming which input reaches which output. The roster now
  // lives on the def, which is also the one edit in this PR that MOVES THE WEBGL
  // ATTEST HASH — `face` and `noUserControl` are hash-transparent, `params` is
  // not. It is batched here so the re-attest is paid once.
  //
  // NO READOUT, NO SIDEBAR, NO HERO: the 2026-08-19 ruling removed the fields,
  // and the routing state is each selector's own named position plus
  // `aria-valuetext`. NOT CONTROL-HEAVY — four controls, one idea, one
  // unlabelled band, no rail.
  '4plexvid',
  // BENTBOX — 16 params (14 controls + 2 synthetic gates), 6 pages, no rail.
  // A virtual CRT fed a hand-bent NTSC composite line: resample to 240 lines,
  // encode to YIQ, abuse the "voltage" (wavefold → soft-clip), decode, blend
  // against the previous frame, then paint through a phosphor pipeline. The
  // pages ARE that chain — sync / chroma / bend / feedback / crt / mirror.
  //
  // ⚠ IT IS THE SIBLING OF `b3ntb0x`, NOT A SUBSET OF IT. The two share exactly
  // FOUR param ids (`mirrorX`, `mirrorY` + their two gates); `b3ntb0x.ts:51`
  // states outright that NOTHING is imported from bentbox, and the shared mirror
  // logic is duplicated rather than shared. Their two identically-labelled "Hue"
  // dials are not even interchangeable — bentbox's spans a FULL TURN (so both
  // ends return to the centre colour and 0.5 is the real maximum shift) while
  // b3ntb0x's tops out at 0.9π and never wraps.
  //
  // ⚠ WHAT PROMOTION WOULD HAVE DELETED, and it is the largest STOP-2 inventory
  // in the video pool so far: `BentboxCard.svelte` is the SOLE home of the live
  // CRT picture, fullscreen, in-app full-frame, present-on-a-second-display and
  // the resize handle. On a module whose entire output IS a screen, that is not
  // a lost preview — it is losing every way to watch the television. All five
  // move to `face.extension: 'bentbox'` → `fullViewBody`.
  //
  // ⚠ TWO PARAM-SHAPE CORRECTIONS LAND WITH THE FACE, and only one is free.
  // `mirrorX`/`mirrorY` were declared `curve: 'linear'` while the shader
  // hard-thresholds both at `>= 0.5`, so a def-driven face would have painted
  // two continuous rotaries over a switch (the card renders BUTTONS — the
  // def-vs-card divergence class). Corrected to `discrete`, which is what
  // `looksLikeToggle` keys on: pixel-neutral, because the READ is a threshold
  // either way, but a `params` edit and therefore a real-GPU re-attest. The two
  // synthetic `mirror*Gate` params are declared `noUserControl` in the same
  // diff and cost NOTHING — measured both ways on this branch.
  //
  // ⚠ NO `freeze` PARAM, unlike b3ntb0x: bentbox returns early when nothing is
  // patched (a static gradient with no time term), so its face VRT scenes are
  // deterministic by construction rather than by a flag.
  //
  // NO READOUT, NO SIDEBAR, NO HERO — the 2026-08-19 rulings removed the fields.
  // NOT CONTROL-HEAVY: six honest stages against DOCK_TAB_MIN_BANDS = 7, not
  // padded to reach it.
  'bentbox',
  // WARREN'S VISIONS — 12 params, 4 pages, no rail. The 2D spectral video
  // resynthesizer: FFT a 128² luma plane, track the strongest wavevector peaks
  // as gratings, replay everything unclaimed as 16 log-spaced residual rings,
  // and sum it back through an inverse FFT against the source.
  //
  // ⚠ WHAT EARNS THE FACE IS MEASURED, AND IT IS TWO LIVE DEFECTS IN ITS CARD,
  // both of which promotion closes structurally rather than by editing the card.
  //
  // 1. ELEVEN KNOBS DEAD TO CV, AGAINST SEVEN CV INPUTS.
  //    `WarrensvisionsCard.svelte` passes `readLive` on NONE of its eleven
  //    `<Knob>`s, while the def declares seven `cv` inputs each with a
  //    `paramTarget` and a working `cvScale`. Patch a modulator into
  //    `coherence_cv` — the module's own main gesture, per its docs — and the
  //    card shows the stored value while the engine renders a different one.
  //    `ModuleShell` passes `readLive={params.live(pd.id)}` at every param call
  //    site, so the face is live by construction.
  //
  // 2. A DECLARED VOCABULARY NOTHING READ. This is the only module in the
  //    unfaced pool declaring BOTH `options[]` and `landmarks`, and the card
  //    consumed neither: it RE-TYPED `'FREEZE'`/`'LIVE'` as string literals in
  //    its own button and never passed the SINE/SAW/SQUARE landmarks to its
  //    Knob at all. The face reads both off the def — `engineFreeze` resolves
  //    to a SEGMENTED cell from its own `options` roster, and SHAPE paints its
  //    nearest landmark NAME. ⚠ Note `contract-lock.txt` records neither
  //    `options` nor `landmarks`, so a pool derived from the lock alone is
  //    structurally blind to this whole class.
  //
  // The SCREEN ON/OFF switch reaches the dock through `face.extension:
  // 'warrensvisions'` (#1928/#1935), and its SCREEN OFF renews the watch mark:
  // this module's bank TRACKS, ramps over STABILITY commits and slews per drawn
  // frame, so dropping it out of the pull set would stop the bank rather than
  // just the copy (#2015's stateful case).
  //
  // NO READOUT, NO SIDEBAR, NO HERO — the 2026-08-19 rulings removed the fields.
  // NOT CONTROL-HEAVY: four honest pages against DOCK_TAB_MIN_BANDS = 7, and
  // per the 2026-08-18 ruling they are not padded to reach it.
  'warrensvisions',
  // MANDELBULB — 13 params, 3 pages, no rail. A ray-marched 3D fractal that
  // DOUBLES AS AN OSCILLATOR: turn SLICE on and a plane is marched through the
  // bulb's distance field, its cross-section played on `audio_out` as a
  // 256-sample wavetable. Pages are the three ideas: camera / shape / slice.
  //
  // ⚠ THE GLYPH IS THE REASON THIS MODULE IS INTERESTING, and it is already
  // proven permanently in `mandelbulb-glyph-tap.test.ts`. This is the ONE video
  // def in the fleet with a `type: 'audio'` output, so `primaryAudioOutPortId`
  // RESOLVES and the video rule's stated mechanism ("a video def has no audio
  // output, so any glyph goes static") does not fire. A `meter`/`waveform`
  // glyph here binds `{kind:'live-audio'}` — not static, so the dead-glyph
  // clause stays GREEN — through a tap that searches only the AUDIO engine's
  // node map, which a `domain:'video'` node never enters. A live-looking
  // readout of nothing that EVERY def-reading gate passes. Hence `'none'`.
  //
  // ⚠ WHAT PROMOTION WOULD HAVE DELETED: TWO pictures, not one.
  // `MandelbulbCard.svelte` owns the ray-marched preview AND the slice waveform
  // readout — the module's audio half made visible. Both move to
  // `face.extension: 'mandelbulb'`, and the waveform is READ from the engine
  // (`read('sliceWave')`, a seam added with this face) rather than re-derived:
  // `mbSampleSlice` is 16,384 distance-estimate calls on the MAIN THREAD, the
  // card already runs it a second time, and a third pass would have made a
  // slice move cost 3x. Retaining the array the engine already computes takes
  // it the other way — 2x to 1x.
  //
  // ⚠ TWO SCREEN CONTROLS, DELIBERATELY, AND NOT DUPLICATES. `screen_on` is a
  // PARAM and product behaviour: at 0 the factory skips the raymarch, but only
  // while `video_out` is unpatched, so it can never starve a downstream
  // consumer (the faced `cube` ships identical semantics, and it is NOT the
  // #2015 producer-kill class). The preview's switch is
  // `node.data.previewCollapsed` — pure view layer, fleet-standard corner
  // chrome. One asks whether to compute a picture at all; the other whether to
  // look at it now.
  //
  // ⚠ `detail` IS RANKED LOW ON MEASUREMENT, not taste: the GLSL loop caps at
  // MAX_ITER = 16 while the param is declared 4..30, so 15 of its 27 positions
  // render bit-identically and the shipped default of 20 sits in that dead band
  // (#2036). It still moves `audio_out`, so it stays a real control.
  //
  // NO READOUTS, NO SIDEBAR, NO HERO — the 2026-08-19 rulings removed the
  // fields; the slice trace survives as a live PICTURE, not as text.
  'mandelbulb',
  // THE FACEPLATE QUEUE · Q49 — the self-building wavetable oscillator
  // (2026-08-20). THE POOL'S ONE HONESTLY CONTROL-HEAVY MODULE: 33 params in
  // seven genuine groups, which is roughly triple the faced median.
  //
  // ⚠ CONTROL-HEAVY, AND THE RAIL ENGAGES ON ITS OWN. Seven honest pages reach
  // `DOCK_TAB_MIN_BANDS = 7`, so the tab rail turns on through the ordinary
  // threshold and there is NO `face.tabbed` here. That field is
  // OWNER-INSTRUCTION-ONLY and its gate's own failure message says to author
  // honest pages and let the rail engage instead; no owner instruction exists
  // for foxy, so declaring it would mean inventing one. The seven are five
  // WAVECEL surface params, three SEPARATE sources, the XYZ combination, the
  // two generator modes and the four freezes — nothing padded to reach seven,
  // nothing crammed to avoid it. foxy is the FOURTH module to reach the rail
  // (cloudseed 8, pentemelodica 8, backdraft 7), i.e. a user of a settled
  // mechanism rather than a first anything.
  //
  // ⚠ THE STOP-2 FINDING IS FIVE PICTURES, and it is `rasterize`'s argument
  // multiplied. `hasVideoSurface` is `def.domain === 'video'`; foxy is
  // `domain: 'audio'` with three video OUTs painted in JS, so no generic seam
  // reaches the three rasters, the XYZ field or the animated wavetable.
  // Promotion without a surface would delete the module's entire proposition —
  // that you WATCH the table being built — and leave 33 knobs. Resolved through
  // `face.extension: 'foxy'` → `fullViewBody`, which also carries the two
  // affordances no param cell can reach (the SCOPE/3D flip and EXPORT TABLE).
  // ⚠ The committed inventory predicted "a registered panel (cube is the
  // precedent)"; that half is DELIBERATELY NOT TAKEN, for the blind-gate reason
  // rasterize wrote down — a panel REQUIRES a probe, and a read-only picture's
  // only probe watches a DIFFERENT control.
  //
  // ⚠ AND THE COLLAPSE RULE INVERTS HERE TOO, for the same mechanical reason
  // and NOT by inheritance: `bridgeTick()` runs inside the engine handle's
  // `read()` seam, so with nothing patched downstream the preview loop is the
  // only thing advancing the rasters AND the table. SCREEN OFF skips the five
  // BLITS and never the `read('tick')`.
  //
  // ⚠ THE GLYPH IS SUPPRESSED AT THE DOCK, NOT ABSENT. `'waveform'` resolves
  // `{kind:'live-audio'}` on `out_l` — a real trace of the real output, unlike
  // rasterize's THRU — so it is the lane's identity mark, and
  // `dockFullViewHeadPlan` hands the dock head to the extension body so the two
  // pictures never paint at once.
  //
  // NO READOUT, NO SIDEBAR, NO HERO — the 2026-08-19 rulings removed the
  // fields, and this module's two mode NAMES arrive as `options[]` rosters
  // (#2007), which is the declared-name route rather than derived text.
  'foxy',

  // FACE BATCH 16 · gatemaiden (2026-08-20) — the gate↔trigger converter, and
  // the cheapest promotion the programme has made: two params, eleven lines of
  // card markup, and BOTH of the silent build bugs batch 13's reconciliation
  // caught sitting on it at once (#2025).
  //
  // It is promoted on the defects rather than on the tier ladder, and the
  // difference is worth stating because two params is where STOP 1 says to
  // refuse. The ladder here is genuinely trivial — glyph `'none'` caps compact
  // at 3, there are 2 controls, so every tier shows everything. What the face
  // changes is that both controls were rendered WRONG:
  //
  //   · `trigShape` declared no roster, so `looksLikeToggle` resolved an
  //     anonymous two-state switch and the only names for its states — card
  //     literals — had no faced home. It now declares `options`, so the dock
  //     paints a SEGMENTED pair (both states visible, one click away, where the
  //     card needed a click to discover the second) and the lane paints the
  //     NAME through `paintsReadout`. ⚠ Those names are load-bearing, not
  //     cosmetic: TRI carries half SQR's area and clears the 0.5 threshold for
  //     half as long (re-measured on the pure DSP core, 120 vs 240 sample-units
  //     and 2.5 ms vs 5.0 ms at 48 kHz), which is a difference a player must be
  //     able to see the two ends of. The docs claim that it was "display/feel
  //     only" is corrected in the same diff; whether the BEHAVIOUR should
  //     change is #2008 and stays open.
  //   · `gateLen` is a `NeonFader` on the card and no `ParamDef` field says so,
  //     so the shell would have substituted a dial. `face.paramCells`.
  //
  // And the promotion pays a ledgered raw write rather than only re-skinning:
  // the card's shape button poked the store directly, so the gesture was
  // neither undoable nor synced. ⚠ That was paid by EDITING THE CARD, not by
  // facing the module — see the note left in `raw-write-ledger.ts`, where #2025
  // had the mechanism backwards.
  'gatemaiden',
  // BATCH 18 (2026-08-20) — the THIN AUDIO TAIL, the attenuator pair. Owner:
  // *"if there are a lot of audio modules with <4 params can't we just fly
  // through them really quickly? they still need to be done, <4 params or
  // not."*
  //
  // These two close the batch and they are its cleanest statement of the
  // one-port-meter rule, because they differ ONLY in that respect. `moog995`
  // has a live meter available (`out1` is audio) and REFUSES it: three
  // independent channels, so a meter on channel 1 is a false silence for anyone
  // patched through 2 or 3. `moog992` SUMS its four channels into one `cv_out`,
  // so it has no independence problem at all — it simply has no audio output,
  // and its `none` is forced.
  'moog992',
  'moog995',
  // BATCH 18 (2026-08-20) — the THIN AUDIO TAIL, the Moog cluster. Owner: *"if
  // there are a lot of audio modules with <4 params can't we just fly through
  // them really quickly? they still need to be done, <4 params or not."*
  //
  // `moog904b` is the batch's POSITIVE case of the naming rule: its card drew
  // LOW / HIGH radiogroup buttons while the def declared a bare `1..2 discrete`
  // param, so every shared surface could only paint an anonymous two-position
  // control. The names are promoted into `options` and the CARD now imports
  // that roster instead of keeping its own copy.
  //
  // `moog961` is the batch's clearest FORCED `glyph: 'none'`: it has an audio
  // INPUT and an audio domain, and every one of its four outputs is a `gate` —
  // so "it deals with audio, give it a meter" is exactly the wrong inference
  // and the resolver has to be run.
  'moog904b',
  'moog904c',
  'moog905',
  'moog961',
  // BATCH 18 (2026-08-20) — the THIN AUDIO TAIL. Owner: *"if there are a lot of
  // audio modules with <4 params can't we just fly through them really quickly?
  // they still need to be done, <4 params or not."* Utilities whose entire
  // control surface is one knob. Thin is not sloppy: each ships an honest band
  // count (never padded), a glyph RUN through `glyphBinding` rather than argued
  // from the module's description, and a model test.
  //
  // The pair worth reading together is `sampleHold` and `moog962`. Both have a
  // single DISCRETE param; only one gains a named picker. sampleHold's ten
  // scale names already existed and the shell could not reach them, so they are
  // PROMOTED into `options`. moog962's STAGES has no names at all — its values
  // are their own labels — so it stays a knob. Promote names that exist; never
  // invent them to justify a nicer cell.
  'moog903a',
  'moog962',
  'sampleHold',
  'scaler',
  // control surface is one knob or nothing at all. Thin is not sloppy: each
  // still ships an honest band count (never padded to look substantial), a
  // glyph RUN through `glyphBinding` rather than argued from the module's
  // description, and a face-model test.
  //
  // The two zero-param entries are the first faces in the registry to rank
  // NOTHING and carry no shell extension, and they are why `dockFacePlan` now
  // refuses to emit an empty `__all` band — see the note there.
  'depolarizer',
  'flipper',
  'moog994',
  'polarizer',
  // RUTTETRA (`label: 'xyz'`) — 12 params, 4 pages, no rail. The authentic
  // forward-scatter Rutt/Etra scan processor: a 320x180 grid walks the Z
  // source, reads luma at each point, lays it along an internally generated
  // H/V ramp and displaces it by `(lum - 0.5) * disp`, then joins adjacent
  // points within each row into 57,420 additive LINE segments over black. The
  // verb is TILT — you are sculpting relief out of a flat image.
  //
  // ⚠ THIS FACE EXISTS TO PROVE A PLATFORM SEAM, and that is why it is the
  // module that landed it. #2009 filed the gap: `hideControls` — "hide the
  // controls and it becomes a resizable monitor" — is a `node.data` affordance
  // on FIVE legacy cards (`ruttetra`, `monoglitch`, `milkdrop`, `reshaper`,
  // `graphicEq`) with NO shell representation, and `migrated(type)` deletes it
  // from both surfaces at once. `fullViewBody` paints ABOVE the bands and by
  // contract cannot suppress them, so there was no seam to promote through.
  //
  // ⚠ AND ON THIS MODULE THE LOSS WOULD HAVE BEEN A DOCUMENTED ONE. The def's
  // own `docs.explanation` has advertised the gesture in the player's words
  // since it shipped — "hiding the controls turns it into a resizable monitor
  // (drag the bottom-right corner, double-click to restore)". Promoting
  // without a home for it would have shipped documentation describing a control
  // that no longer exists, and NO def-reading gate can see that, because every
  // one of them reads the same def that tells the lie. Resolved by MONITOR MODE
  // (`face.monitor` → `faceMonitorPlan` → the shell suppresses hero + bands),
  // with the toggle on the module's own `fullViewBody` so the button that turns
  // it on is always still on screen to turn it off — which fixes the card's
  // pointer-only trap rather than porting it.
  //
  // ⚠ `editorSurface` WAS THE NOMINATED ROUTE AND IS THE WRONG ONE. It is
  // specced for "controls that are not cell-shaped at all" and is a STATIC
  // structural choice; ruttetra's twelve params are ordinary scalars and monitor
  // mode is a TOGGLE. It stays UNWIRED, and this face is not a fake first
  // adopter of it.
  //
  // ⚠ UNTABBED BY OWNER RULING ("2 - a"), and the arithmetic agrees rather than
  // merely permitting it: four honest DSP-derived pages against
  // `DOCK_TAB_MIN_BANDS = 7`, packing to TWO rows under `DOCK_ROW_MAX_CONTROLS`.
  // Reaching the rail would have meant padding pages to hit a threshold. The
  // module the tabbed ruling first NAMED is the weakest tab candidate in the
  // video bank, and the ruling settled the TAB question, not STOP 2.
  //
  // ⚠ TWO SHAPE PARAMS STAY DIALS WHILE THE OTHER TEN ARE FADERS, and the
  // asymmetry is load-bearing. `xShape`/`yShape` gain `landmarks` at the
  // shader's own morph arms so the linear/triangle/soft/radial name survives
  // without re-typing the card's seven thresholds — and `landmarks` is read by
  // `KnobConic` ALONE (`NeonFader` is passed `options`, not `landmarks`), so
  // declaring `paramCells: 'fader'` for them, which card fidelity would
  // otherwise argue for, would have silently deleted every name while the
  // declaration still looked honoured.
  //
  // ⚠ NO `freeze` PARAM, and it is structural rather than a judgement: there is
  // no `uTime` uniform anywhere in `VERT_SRC`/`FRAG_SRC`, no ping-pong and no
  // accumulator — `draw` clears to black and redraws from the input texture and
  // params every frame. Unpatched, `z` binds a constant 1x1 grey sentinel, so
  // the face scenes are deterministic at rest by construction (the `fourplexer`
  // argument). Its SCREEN OFF still renews the watch mark, but for the OUTPUT
  // rather than for an accumulator — see the body's own note.
  //
  // ⚠ ITS RE-ATTEST WAS PAID AT PROMOTION, and `face`/`docs` were not why. Both
  // cost nothing (hash-transparent). What moved the hash was real code in a
  // video def — the `landmarks` roster, the `R`/`G`/`B` label shortening and
  // (then) `RUTTETRA_MONITOR_BOX`; the entire shell seam (ModuleShell,
  // module-shell-model, graph/types, the extension) is outside the basis.
  //
  // ⚠ THE MONITOR BOX IS NO LONGER ONE OF THEM. It moved to
  // `$lib/ui/modules/ruttetra/monitor-box.ts` on 2026-08-21, in the monoglitch
  // face PR, which already owed a window — so the marginal GPU cost of taking
  // it out of the basis was ZERO. The one-source rule is untouched (card and
  // faced body both import it); only the address changed, and the basis sheds
  // six layout numbers that a probe proved cannot change a rendered GL pixel.
  // `ruttetra-face-model.test.ts` asserts the def stays clean of it, because a
  // move back would be silent.
  //
  // ⚠ ITS LANE VRT CARD BASELINE DOES NOT MOVE — this paragraph USED to claim
  // it does, and that claim was already known to be false when it merged.
  // CORRECTED 2026-08-21 (#2078), from this commit's own PR body: *"I expected
  // `ruttetra.png` … to move, since that spec captures
  // `.svelte-flow__node-ruttetra`. It will NOT: `vrt.spec.ts:86` boots
  // `?shell=legacy`, so it renders the legacy card regardless of promotion."*
  // The commit bears that out — `a2b982bd0` committed `face-ruttetra-compact.png`
  // and `face-ruttetra-dock.png` and did NOT touch `ruttetra.png`. The
  // correction reached the PR body and never reached this line, so the tree
  // asserted the opposite of the measurement for three days. Re-measured on the
  // monoglitch branch, where the same claim about `monoglitch.png` was drafted
  // from this text and then falsified by an actual run.
  //
  // NO READOUT, NO SIDEBAR, NO HERO — the 2026-08-19 rulings removed the fields.
  // The finding that lost its surface is named in the def's `face` comment.
  'ruttetra',

  // FACE BATCH 16 · colourofmagic (2026-08-20) — the largest module in the
  // unfaced pool by a wide margin (37 params, 31 in, 22 out) and the FIRST
  // ADOPTER of the `'color'` cell kind, which had a type, a documented contract
  // and a live `<ColorField>` renderer and zero modules declaring it.
  //
  // THREE DEFECTS FIXED BY THE PROMOTION (#2022), and two of them were
  // invisible to every gate in the tree:
  //
  //   · `pal_r/g/b` are packed `0xRRGGBB` integers. Undeclared they resolve to
  //     a KNOB SWEEPING 16.7 MILLION VALUES — and `faces-parity` PASSES that,
  //     because it drags the knob and the param moves. The platform's own
  //     `ModuleFace.paramCells` doc-comment names this exact situation as the
  //     reason `'color'` is DECLARED rather than sniffed: a packed RGB differs
  //     from any other discrete param only in MAGNITUDE, and nothing in the
  //     repo reads magnitude.
  //   · `preview` chooses WHICH of the 22 outputs you are looking at and its
  //     names lived in the card, so a face painted a 22-position ANONYMOUS
  //     dial. Now a declared roster; ⚠ 22 > SEGMENTED_MAX_OPTIONS so the dock
  //     resolves `selector` where the card paints pills — a deliberate look
  //     change, argued in the def.
  //   · `freeze` is a VRT harness switch with no card control, and face
  //     completeness would have PAINTED IT — putting "hold the last frame" on
  //     the player's faceplate, where a frozen picture reads as a broken
  //     module. Now `noUserControl`, `writer: 'internal'`.
  //
  // NOT CONTROL-HEAVY, and this is the counter-intuitive part: 37 params is not
  // 37 bands. `DOCK_TAB_MIN_BANDS = 7` counts BANDS, and the honest count is
  // FIVE — one per colorspace block. Reaching 7 would mean splitting each
  // block's biases from its OVER toggles, which is padding, and the owner
  // ruling forbids padding pages to force the rail.
  //
  // SCREEN ON/OFF ships through `face.extension: 'colourofmagic'`
  // (`fullViewBody`), not the card — the card is unreachable after promotion,
  // which is the bug spirographs shipped (#1928). OFF stops the preview COPY
  // and never the engine (#2015).
  //
  // ⚠ REAR CARD IS CURATED ON A MEASUREMENT. At 31x22 — the second-largest
  // port field the programme has met — the DERIVED plan drops all fifteen
  // mono-override inputs into one undifferentiated 16-hole `signal` section,
  // because only the `_cv` ports carry a `paramTarget` that projects onto a
  // page. Curated, each block owns its six holes. 53 holes is past
  // `REAR_DENSE_ROWS` (40), so it renders dense by design.
  'colourofmagic',
  // THE FACEPLATE QUEUE · Q52 — CV BUDDY + CV BUDDY MINI (2026-08-21), the pair
  // that had to move TOGETHER and the first face whose blocker was not a
  // control at all.
  //
  // ⚠ ONE FACE OBJECT FOR TWO ENTRIES. Both defs reference the SAME
  // `CV_BUDDY_FACE`, asserted by IDENTITY in `cv-buddy-face-model.test.ts`.
  // They differ only in ports (the mini has no velocity jack), and `face.order`
  // names params — so a second literal would buy nothing and could drift, the
  // argument their shared card body and their shared PPQN roster already make.
  //
  // ⚠ THE INTERESTING PART IS WHAT ALMOST BLOCKED IT. #2024 measured that
  // nearly everything the card showed was RACK-GLOBAL derived text — the ES-9
  // slots this instance owns (a function of every CV Buddy on the rack, of
  // either kind), an ES-9 presence prompt, and a late-tick counter whose own
  // card comment argued a ZERO must always render. None of it is a param, so no
  // resolver could produce it and no def-reading gate could see it go; and all
  // of it is text a resting faceplate may not paint. The resolution is
  // `face.rackStatus` plus the `StatusLed` primitive, and it did NOT relax the
  // rulings — it re-shaped each item into a permitted form:
  //
  //   * the SLOT NAME paints, as a NAME — the owner's own disambiguation test,
  //     since two CV Buddies are otherwise identical plates;
  //   * the CLOCK BAND is REMOVED on a non-primary instance rather than
  //     explained by a sentence, which is STRUCTURE and therefore free;
  //   * `clockSkips` becomes a dark/lit LAMP with the count in `title` /
  //     `aria-label` — strictly more informative at rest than the card's `0
  //     skipped`, because a present-and-dark lamp is what "healthy, and
  //     instrumented" looks like;
  //   * the two ES-9 prose sentences collapse into the ROUTED lamp on an
  //     ACTION-IDENTITY argument, stated where the collapse happens.
  //
  // ⚠ `pages: 1` AND THAT ONE BAND IS THE WHOLE CONTROL SURFACE — both params
  // are clock params. So the non-primary plate is the status body ALONE, which
  // is why `rackStatusPlan` refuses to suppress anything unless that body is
  // painting (`faceMonitorPlan`'s never-a-blank-plate precondition, sharper
  // here). The lane tile is the named blind spot: it has no body, so it hides
  // nothing.
  'cvBuddy',
  'cvBuddyMini',

  // FACE BATCH 19 · monoglitch (2026-08-21) — 8 params, 4 pages, no rail. The
  // luma-driven scanline-displacement glitch: the picture is quantised into a
  // stack of horizontal lines and each line is LIFTED by the luma it samples at
  // its own row centre, so bright rows bow upward out of the flat stack. The
  // verb is LIFT. Not to be confused with either neighbour — `ruttetra` scatters
  // a 320x180 GRID into 3D relief, `reshaper` remaps coordinates; this one bends
  // a stack of 2D lines and tints them like a phosphor.
  //
  // ⚠ THE FIRST INHERITOR OF MONITOR MODE, and the reason this module was next.
  // #2009 named FIVE legacy cards that mount `hideControls` (`ruttetra`,
  // `monoglitch`, `milkdrop`, `reshaper`, `graphicEq`) with no shell
  // representation, and `migrated(type)` deletes the affordance from both
  // surfaces at once. `ruttetra` (#2053) built the seam — `face.monitor` →
  // `faceMonitorPlan` → the shell suppresses hero + bands, with the toggle on
  // the module's own `fullViewBody` so the button that turns the mode on is
  // always still on screen to turn it off. This face is the second adopter and
  // changes NOTHING about the platform: it declares, it does not extend.
  //
  // ⚠ AND THE LOSS WOULD HAVE BEEN A DOCUMENTED ONE HERE TOO. This def's
  // `docs.explanation` has advertised the gesture since it shipped — "in
  // hide-controls mode the preview is resizable by dragging the corner handle".
  // ⚠ THAT SENTENCE IS NOT WHAT ESTABLISHED THE AFFORDANCE EXISTS, and the
  // distinction is the whole #2009 lesson: prose on a def is the thing that
  // lies. `MonoglitchCard.svelte` was read line by line and genuinely mounts
  // the key (the toggle, the resizable canvas branch, the dblclick escape), so
  // monitor mode is HONEST here rather than invented to match the docs.
  //
  // ⚠ IT GAINS A SCREEN SWITCH ITS CARD NEVER HAD. Unlike ruttetra's, the
  // monoglitch card has no `previewCollapsed` control at all. The 2026-08-18
  // ruling is that every video FACE ships one, and
  // `video-face-screen-source.test.ts` denies a faced video module without one
  // — so this is an ADDITION, not a port, recorded so nobody later "restores
  // parity" by deleting it. OFF stops the preview COPY and keeps renewing the
  // watch mark, never the engine (#2015).
  //
  // ⚠ UNTABBED, and the arithmetic is not close: four honest pages — one per
  // TERM of the fragment shader (lift / raster / pan / tint) — against
  // `DOCK_TAB_MIN_BANDS = 7`. Eight controls total is under
  // `DOCK_ROW_MAX_CONTROLS = 10`, so PF-21 packs all four bands into ONE row.
  //
  // ⚠ THIS ENTRY CLAIMED "THE PLATE TIER SHOWS ONE TINT CHANNEL OF THREE" AND
  // THAT WAS FALSE (corrected 2026-08-21, #2085). It reasoned from
  // `LANE_PLATE_MAX_CELLS = 6` against five geometry params. But `faceTierCap`
  // does not return that constant — it runs `laneBodyPlan`, fitting CELLS INTO
  // GEOMETRY, and a `fader` is a TALL cell. Measured through `curatedFace`, this
  // face resolves mini 1 · compact 2 · plate 2 · dock 8, so NO tint reaches any
  // lane tier and the "split triple" it worried about does not exist. Same
  // result on `reshaper` and `ruttetra`: every video fader face is plate = 2.
  //
  // ⚠ NO `freeze` PARAM, and it is structural rather than a judgement — the
  // ruttetra argument, holding for the same mechanical reason. There is no
  // `uTime` uniform in `FRAG_SRC`, no ping-pong and no accumulator; the shader
  // is a pure function of (input texture, params). With nothing patched
  // `uHasInput` is 0 and it paints a fixed dark-navy gradient, so the face
  // scenes are deterministic at rest by construction. Do NOT add one: that is a
  // `params` edit on a def inside the WebGL attest basis, i.e. a real-GPU
  // re-attest, to buy an assertion that already holds.
  //
  // ⚠ ITS LANE VRT CARD BASELINE DOES **NOT** MOVE, AND THE SIBLING COMMENT
  // ABOVE SAYING RUTTETRA'S DID IS WRONG — corrected in this diff (#2078).
  // `vrt.spec.ts/monoglitch.png` is a LIVE card scene (masked canvas) rather
  // than an `EXEMPT_FROM_VRT` entry, so the obvious inference is that promotion
  // re-renders it as the faced lane tile and moves the pixels. It does not:
  // `vrt.spec.ts:86` boots `/rack?shell=legacy`, where `MonoglitchCard.svelte`
  // keeps rendering whether or not the module is promoted. MEASURED on this
  // branch — `task vrt:one -- monoglitch` reports `monoglitch card matches
  // baseline` PASSING with the face merged.
  //
  // ⚠ THE RUTTETRA PR ALREADY FOUND THIS AND THE FIX DID NOT REACH THE TREE,
  // which is why it is worth this many lines. `a2b982bd0`'s body says it plainly
  // ("I expected `ruttetra.png` … to move … It will NOT"), and that commit
  // committed only its two NEW face baselines — `ruttetra.png` is untouched by
  // it. But the prose beside `'ruttetra'` above kept the pre-correction claim,
  // so the tree asserts the opposite of what the author measured. A stale TEST
  // goes red and gets fixed; a stale CLAIM goes quietly green forever, and this
  // one was about to propagate — the first draft of THIS comment repeated it,
  // and only a local VRT run caught it.
  //
  // ⚠ SO THE CARD BASELINE CANNOT BE USED AS A PROMOTION SIGNAL AT ALL, for any
  // of the three cards still queued (`milkdrop`, `reshaper`, `graphicEq`). What
  // WOULD move one is an edit the legacy card actually renders — and note
  // `MonoglitchCard.svelte` HARDCODES its fader captions (`label="R"`), exactly
  // as ruttetra's does, so even a def label change does not reach those pixels.
  // This face changes no card-visible pixel: the card edit is the monitor-box
  // constants, which are the same six numbers it already had.
  //
  // NO READOUT, NO SIDEBAR, NO HERO — the 2026-08-19 rulings removed the fields.
  // The finding that lost its surface is named in the def's `face` comment (the
  // band height, which depends on BOTH `lines` and `spacing` and so cannot be
  // read off either dial).
  'monoglitch',

  // FACE BATCH 19 · reshaper (2026-08-21) — 6 params, 2 pages, no rail. The
  // coordinate-remap processor: a CRT raster whose two SWEEPS ARE CABLES. Each
  // output pixel reads its source u from the X field and its v from the Y field
  // and samples Z there, so a shaped ramp patched into X or Y rebuilds the
  // picture inside a deformed coordinate space. The verb is REMAP. Its siblings
  // do neighbouring things with INTERNAL generators — `ruttetra` scatters a grid
  // into 3D relief, `monoglitch` bends a stack of drawn scanlines — and the
  // thing only this one does is take its sampling grid from outside.
  //
  // ⚠ THE HEADLINE FEATURE HAS NO CONTROL ON THE FACE, and that is correct
  // rather than an omission worth fixing. X and Y are `mono-video` INPUTS with
  // no `ParamDef` behind them, so the entire warp gesture is a PATCHING act and
  // lives on the rear card; every ranked control on the front is downstream of
  // it. A face cannot rank what a def does not declare.
  //
  // ⚠ ITS TIER LADDER IS mini 1 · compact 2 · plate 2 · dock 6, MEASURED through
  // `curatedFace` — and the plate tier being the same two as compact is the
  // thing worth knowing. `faceTierCap` does not return `LANE_PLATE_MAX_CELLS`;
  // it runs `laneBodyPlan`, fitting CELLS INTO GEOMETRY, and a `fader` is a TALL
  // cell. Every video fader face measures the same way (monoglitch 8 params,
  // ruttetra 12 — both plate = 2), so no tint channel reaches any lane tier on
  // any of them. This corrected a wrong claim in two already-merged faces
  // (#2085); it is pinned in `reshaper-face-model.test.ts` as a RELATIONSHIP
  // (plate === compact) rather than as a number.
  //
  // ⚠ THE RANK-1 TIE IS BROKEN BY THE SHADER. `xDisp` and `yDisp` are symmetric
  // in everything the def can express — same range, same default, same
  // expression — so there is no signal of the kind `ruttetra` has (its `yDisp`
  // is the one param it ships off identity). The tie-break is evaluation order:
  // `finalU` before `finalV`, matching the declaration order. That invents
  // nothing, which is the whole bar for a rank argument.
  //
  // ⚠ MONITOR MODE — the THIRD of the five cards #2009 named, after `ruttetra`
  // proved the seam (#2053) and `monoglitch` inherited it (#2081). Verified
  // against `ReshaperCard.svelte`, which mounts `hideControls`, the corner
  // resize and the double-click restore, and carries the same
  // `a11y_no_static_element_interactions` suppression calling the dblclick "a
  // real pointer-only trap … tracked as #1572". The faced body fixes that trap
  // rather than porting it: the body always paints, so the button that turns the
  // mode on is the button that turns it off.
  //
  // ⚠ IT GAINS A SCREEN SWITCH ITS CARD NEVER HAD, exactly as `monoglitch` did —
  // `previewCollapsed` appears nowhere in `ReshaperCard.svelte`. The 2026-08-18
  // ruling requires every video FACE to carry one, so this is an ADDITION rather
  // than a port. Recorded so nobody later "restores parity" by deleting it.
  //
  // ⚠ ZERO ATTEST, and this is the first face to prove the #2081 relocation pays
  // off. Only `face` and `docs` change in `reshaper.ts`, both stripped by
  // `scripts/attest-code-basis.ts`; the monitor box lives at
  // `$lib/ui/modules/reshaper/monitor-box.ts`, outside the WebGL basis. Verified
  // empirically by normalising the def before and after, not assumed.
  //
  // ⚠ ITS LANE VRT CARD BASELINE DOES NOT MOVE. `vrt.spec.ts/reshaper.png` is a
  // live card scene, but `vrt.spec.ts:86` boots `?shell=legacy`, where
  // `ReshaperCard.svelte` renders whether or not the module is promoted — the
  // #2078 correction, applied rather than re-derived. The card edit here is the
  // monitor-box constants, which are the same six numbers it already had.
  //
  // ⚠ NO `freeze` PARAM AND NO `simPin`, and unlike its siblings that is true
  // with sources PATCHED too. `FRAG_SRC` declares no time uniform, no
  // ping-pong, no accumulator and no RNG: the output is a pure function of
  // (X, Y, Z, params). `vrt-live-surfaces.ts` records reshaper measured at
  // "10/10 processes PASS — no mask". Unpatched, all three samplers take their
  // mid-grey branch and the identity ramps apply, so the face scenes paint a
  // flat field that is byte-stable by construction.
  //
  // NO READOUT, NO SIDEBAR, NO HERO — the 2026-08-19 rulings removed the fields.
  // The finding that lost its surface is named in the def's `face` comment: the
  // module is a PASS-THROUGH at its shipped defaults, which is a real derived
  // state that no longer has anywhere to be shown.
  'reshaper',

  // FACE BATCH 19 · milkdrop (2026-08-21) — 8 params (4 of them CV-only), 2
  // pages, no rail. The Winamp-era preset visualizer as a CV-instrumented video
  // SOURCE: butterchurn drives nearly all preset motion from three audio
  // scalars, and the thing only this module does is let a CABLE REPLACE any of
  // them, so a patched LFO becomes "the bass" while it is connected.
  //
  // ⚠ THIS FACE REQUIRED A PLATFORM CHANGE, AND IT IS THE ONLY ONE IN THE WAVE
  // THAT DID. `workflow-shell-faces.spec.ts` asserts SET EQUALITY between
  // `STRICT_FACES` and the `FACES` VRT roster, so before this PR a module could
  // be promoted only if two pixel-stable scenes could be captured for it.
  // butterchurn cannot produce them — MEASURED, not asserted: it is
  // frame-count dependent (mean 41.69 at 16 steps vs 59.61 eight steps later)
  // AND not reproducible across boots at an IDENTICAL frame count (framesDelta
  // 16 both times; means 41.690592 vs 42.132087, with boot 1 itself moving
  // between probe runs). `simPin` pins a CLOCK and cannot reach either cause:
  // the warp mesh samples the previous frame (intrinsic to the Milkdrop format)
  // and the RNG lives inside the library, which `project_milkdrop_module`
  // forbids vendoring under `lib/video/`. So the roster gained a NAMED, ANCHORED
  // exemption — `FACES_WITHOUT_SCENES` — carrying that measurement in its `why`.
  // #2083.
  //
  // ⚠ THE EXEMPTION IS NOT A DISCOUNT, AND THE COST IS REAL: this face's PIXELS
  // ARE NEVER COMPARED, at either tier. A layout regression here reaches a human
  // before it reaches a gate. That is why the exemption type demands
  // `coveredBy`, why those paths are asserted to exist, and why the entry is
  // re-validated four ways (still faced · still absent from FACES · no baseline
  // on disk · no determinism seam on the def) rather than being a permission
  // that outlives its argument.
  //
  // ⚠ AND IT EXTENDS AN OWNER-ACCEPTED PATTERN RATHER THAN INVENTING POLICY. The
  // CARD roster reached this exact verdict about this exact renderer long ago —
  // `EXEMPT_FROM_VRT` in `vrt-exemptions.ts` carries milkdrop with a written why
  // ("continuously-animating multi-pass butterchurn visualizer … defeats
  // deterministic single-frame capture"). The FACE roster simply lacked the
  // concept, which is what made an otherwise parity-clean module unpromotable.
  //
  // ⚠ FOUR PARAMS GET `noUserControl` (#1726) — `bass`/`mid`/`treb` are CV-only
  // band overrides the card has never drawn ("no panel knob; the MID jack writes
  // it"), and `nextTrig` is the synthetic param the NEXT gate writes so the CV
  // bridge has somewhere to land a rising edge. Painted, they would invite a
  // player to drag a value a cable overwrites every frame, and to "turn up" a
  // trigger. `writer: 'cv-port'` for all four, checked against this def's ports.
  //
  // ⚠ THE PRESET PICKER IS A FAMILY SELECTOR, NOT AN `options` ROSTER ON THE
  // PARAM, and that is a truth argument before it is an attest one. A static
  // roster would name only the ~20 CURATED presets, while the card's picker also
  // lists whatever `.milk` files were imported this session and the engine
  // clamps to the LIVE list — so a roster would be wrong the moment anyone used
  // the loader. It also happens to be free: `controlFamilies` is
  // hash-transparent and `params` is not. The dx7 pair
  // (`dx7-preset-select-{n}` + `dx7-syx-input-{n}`) is the precedent, verbatim,
  // down to the `ShellFileCell` for the importer.
  //
  // ⚠ THE PRESET NAME MOVES FROM A READOUT TO A CONTROL. The card prints a live
  // name/index line; the 2026-08-19 rulings deleted that shape. The name is now
  // the picker's SELECTED OPTION LABEL — permitted resting text precisely
  // because it disambiguates the control's own position rather than restating a
  // value. That is the finding that lost its surface, and where it went.
  //
  // ⚠ ZERO ATTEST, verified empirically before/after despite this module's
  // dependency pin: `face`, `docs`, `controlFamilies` and `noUserControl` are all
  // stripped by `scripts/attest-code-basis.ts`, the monitor box lives under
  // `ui/` per #2081, and nothing else in `milkdrop.ts` changes.
  //
  // ⚠ SCREEN OFF KEEPS THE WATCH MARK FOR A DIFFERENT REASON THAN ITS SIBLINGS,
  // and the body says so: `ruttetra` and `monoglitch` argue from having NO
  // accumulator, so a stalled pull costs them only the OUTPUT. MILKDROP IS the
  // accumulator case — the warp mesh samples the previous frame — so a stalled
  // pull loses the evolution the player was watching. Do not copy their comment.
  'milkdrop',

  // ── BATCH 22 · GROUP 1 — THE VIDEO THIN TAIL, FADER BANKS ─────────────────
  //
  // Four video modules with 2-4 params each, promoted together because they are
  // the SAME SHAPE: one honest band of faders, one live picture, one SCREEN
  // switch. None declares `pages`, none declares `hero`, none declares
  // `bareCells`, and none is a MONITOR-mode module — `hideControls` lives on
  // five legacy cards (`ruttetra`, `monoglitch`, `milkdrop`, `reshaper`,
  // `graphicEq`) and none of these four is among them, so inventing it here
  // would be adding an affordance rather than preserving one.
  //
  // ⚠ THEY WERE SCOPED AS "KNOB BANKS" AND THEY ARE NOT — every one of the
  // twelve params is a `NeonFader` on its card. That is the whole reason each
  // face declares `paramCells: {... 'fader'}`: nothing in a ParamDef separates
  // "a level" from any other continuous scalar, so an UNDECLARED face resolves
  // a fader to a KNOB and the promotion silently substitutes a dial for a
  // throw. ⚠ NO DEF-READING GATE CAN SEE THAT — `contract-lock`,
  // `module-docs-lint` and the range assertions all read the def, and the def
  // says nothing about the primitive. It is the backdraft class in a different
  // field, and the mitigation is the same: declare it, do not infer it.
  //
  // ⚠ AND ON COLORIZER THE SILENT SWAP WOULD ALSO HAVE FALSIFIED SHIPPED PROSE
  // — its `docs.explanation` tells the player to "dial the three faders". A
  // promotion that turned them into knobs would have left the documentation
  // describing a control that no longer exists, with every def-reading gate
  // green, which is the #2009 lesson restated.
  //
  // ⚠ SCREEN OFF KEEPS THE WATCH MARK ON ALL FOUR, FOR THREE DIFFERENT REASONS.
  // Do not flatten these into one comment:
  //   * `edges` / `colorizer` are STATELESS — pure per-pixel functions of their
  //     input and params — so a stalled pull costs only the OUTPUT. They are
  //     chainable mid-graph effects (edges' `mono-video` out is exactly what
  //     colorizer consumes), which is what makes the output argument bite.
  //   * `inwards` is a SOURCE with no input at all, so a stalled pull would
  //     mute the generator every downstream node samples — the switch would
  //     read SCREEN and behave as MUTE.
  //   * `vdelay` IS the accumulator case, like `milkdrop` above: a 32-slot ring
  //     advanced by every draw. A stalled pull lets the echo chain decay OUT of
  //     the ring, so the picture returns with its trails missing.
  //
  // ⚠ ZERO ATTEST for all four: `face` and `paramCells` are stripped by
  // `scripts/attest-code-basis.ts`, and the four bodies + extensions live under
  // `ui/`. `inwards` ANIMATES (`uTime`, Speed defaults to 0.5) and still costs
  // no attest, because its VRT determinism is bought with the engine-level
  // `__videoEngineFreezeTime` pin through `simPin` rather than with a new
  // `freeze` ParamDef — a param would have been a contract change to solve a
  // problem the engine already solves. Verified empirically before/after.
  'edges',
  'colorizer',
  'inwards',
  'vdelay',
  // ── BATCH 22 · GROUP 2a — the video thin tail, CARD-CHECKED CELLS ─────────
  //
  // Two video modules whose faces could NOT have been derived from their defs
  // alone — the group exists because each needs a cell the def gets wrong on
  // its own, and the CARD is what establishes the right answer.
  //
  // ⚠ THE PRIMITIVES DIFFER BETWEEN THESE TWO, WHICH IS THE WHOLE POINT.
  // `lumakey` draws its two continuous controls with `NeonFader`, so its face
  // DECLARES `paramCells: {threshold:'fader', softness:'fader'}` — nothing in a
  // ParamDef separates "a level" from any other continuous scalar, so an
  // undeclared face silently substitutes a KNOB for a throw and no def-reading
  // gate can see it. `shapegen` draws SIZE and ROT with `Knob`, the shell's
  // DEFAULT primitive, so its face declares NOTHING — copying lumakey's
  // declaration onto it would have been a silent regression in the opposite
  // direction. The rule is "declare the primitive the CARD established, and
  // only when the def cannot imply it", not "declare faders everywhere".
  //
  // ⚠ BOTH TOGGLES NEEDED NO DECLARATION AT ALL, and that was worth checking
  // rather than assuming: `lumakey.invert` and `shapegen.solids` are each
  // declared `min: 0, max: 1, curve: 'discrete'` — the genuine 2-state shape —
  // so `looksLikeToggle` resolves them and both cards agree (each draws a
  // `<button>`). Had either been declared `linear`, the face would have given a
  // 2-state param a KNOB, which is the moog962 defect: such a control is INERT,
  // because a dial cannot reliably land on two values. That is the same
  // declared-vs-rendered class as #2090; here the defs happen to be right.
  //
  // ⚠ `shapegen`'s CLK PARAM IS DELIBERATELY UNRANKED. It is a synthetic gate,
  // hidden from the card by design and surfaced as the `clock_in` cv jack
  // (SCOREBOARD's `scoreTrig` is the precedent the def itself names). Ranking
  // it would INVENT an affordance the card does not have — which the parity
  // rule forbids in the same breath as dropping one.
  //
  // SCREEN OFF keeps the watch mark on both, for the OUTPUT rather than for an
  // accumulator: neither carries a time uniform, a ping-pong or any history, so
  // both would resume instantly. `lumakey` is a KEYER that exists to be
  // composited downstream and `shapegen` is a GENERATOR whose `out` is the
  // reason to patch it — on either, a lapsed mark turns a control labelled
  // SCREEN into a MUTE for everything downstream.
  //
  // ⚠ ZERO ATTEST, and deliberately so: `face` and `paramCells` are stripped by
  // `scripts/attest-code-basis.ts`, both bodies live under `ui/`, and NO def's
  // `params` are touched. The other half of this group (`tempest`, `fader`)
  // needs `options` rosters to keep its named selectors, which IS a `params`
  // change — so it is split out rather than dragging an attest window onto
  // these two.
  'lumakey',
  'shapegen',
  // QUADRALOGICAL (2026-08-22, owner design #2102) — the first face in the repo
  // where THE PICTURE IS THE CONTROL, and the first adopter of
  // `face.xyPads[].surface: 'body'`.
  //
  // Its joystick sits ON TOP of a live 2×2 preview of the four inputs it is
  // mixing, so the pad cannot be a band cell beside a picture — the picture and
  // the gesture are one surface. `surface: 'body'` hands both axes to the
  // module's own `fullViewBody` and the dock renders no band cell for either.
  //
  // ⚠ IT IS NOT THE `joystick` (#1974) REFUSAL IN A NEW COSTUME, and the reason
  // is NOT that the lane keeps a pad — no lane tier has ever painted one
  // (`laneOrder` makes every declared pad's anchor dock-only; a lane knob
  // column is 46 px and a pad is square). It is that `joystick`'s pad is its
  // ONLY control, so its lane resolves to ZERO; this module has eighteen other
  // ranked params, and its lane shows DIAMOND, then DIAMOND + SHARP.
  //
  // ⚠ THE PROMOTION IS ALSO THE FIX FOR AN UNREACHABLE CONTROL. `invert` is
  // declared, documented, and read by the shader in BOTH keyed branches — and
  // `QuadralogicalCard.svelte` renders nothing for it, with no CV input
  // targeting it either. It has been unreachable since it shipped, and no gate
  // could see it: completeness only runs over THIS SET, `contract-lock` pins
  // that the param exists rather than that it is operable, and
  // `module-docs-lint` REQUIRES the docs entry describing the control that does
  // not exist. Adding the name here is what arms all three.
  //
  // ⚠ AND THIS ENTRY COSTS AN ATTEST, unlike `lumakey`/`shapegen` above. Four
  // `options` rosters (the eight effect names, which reached the player only
  // through the card's hand-rolled `<select>`) and one `curve` correction on
  // `invert` are `params` changes, and `params` is not hash-transparent.
  'quadralogical',

  // ── BATCH 22 · GROUP 2b — the two faces that COST AN ATTEST ───────────────
  //
  // Split out of group 2 for exactly one reason: both need `options` rosters on
  // their DEFS to survive promotion, and `params` is in the WebGL content basis
  // where `face`, `docs`, `paramCells` and `noUserControl` are not. G1 and G2a
  // were deliberately zero-attest; these two are not, so they ride together and
  // pay one attest window between them instead of dragging it onto the others.
  //
  // ⚠ THE ROSTERS ARE FUNCTIONAL PARITY, NOT DECORATION — this is the whole
  // argument for spending the attest:
  //
  //   `fader.abTransition` / `fader.dwTransition` were declared `0..4` with
  //   `curve: 'linear'` and rendered as 5-option NAMED `<select>`s. Faced
  //   as-declared, each resolves to a KNOB sweeping a continuous range and the
  //   FX names (fade / wipe / dissolve / star / checkerboard) simply VANISH.
  //   `coerceMode` has always rounded and clamped, so every value between the
  //   integers was already a lie — the curve correction and the roster are two
  //   halves of one fix.
  //
  //   `tempest.shape` was `0..2 discrete` with no roster, while its card cycles
  //   and PRINTS the live shape name. Without `options` the face shows a bare
  //   3-step stepper and "circle / square / star" is lost. A number is not a
  //   name: "2" does not tell you the tube is a star.
  //
  // ⚠ BOTH ROSTERS ARE DERIVED FROM ARRAYS THAT ALREADY EXIST — `TUBE_SHAPES`
  // (which the factory indexes) and `TRANSITION_NAMES` (which the card renders
  // and `coerceMode` indexes). Nothing is invented and nothing is re-typed, so
  // a face cannot disagree with the engine about which mode is which, and
  // `max` now derives from the roster length instead of a hand-typed `4`.
  //
  // ⚠ TEMPEST WAS ALSO BOY-SCOUTED. It shipped (#935) with NO `docs` block and
  // no `STRICT_DOCS` entry; the living-docs ratchet says the module you touch
  // is the module you bring up to the bar, so that debt is paid here rather
  // than noticed a fourth time. Its prose is written from the def's own header
  // and factory, not from its plan document.
  //
  // SCREEN OFF keeps the watch mark on both, for the OUTPUT: neither carries an
  // accumulator (tempest rebuilds its vertex set per frame from (rim, shape);
  // fader blends fresh every frame). ⚠ `fader` is the batch's strongest case
  // anyway, because it has TWO outputs — `out` and the `send` that feeds an
  // external FX loop — so a lapsed mark stalls an output the switch does not
  // even show, and can empty the wet path the player is mixing against.
  'tempest',
  'fader',

  // ── BATCH 22 · GROUP 3 — THE SCREENS ──────────────────────────────────────
  //
  // Four video modules that BLIT LIVE VIDEO, so the SCREEN switch is
  // load-bearing here rather than ceremonial: on three of them it hides the
  // module's own picture, and on `onetonine` it hides a DIAGNOSTIC surface
  // while nine outputs keep running behind it.
  //
  // ⚠ THREE OF THE FOUR MOVE THE ATTEST HASH, which is why this group pays one
  // window rather than pretending to be zero-attest like G1/G2a:
  //
  //   `posterbox.depth` and `tiler.tile` are DISCRETE params their cards draw
  //   as faders with NAMED tick rails. Without `options` the faces show bare
  //   stepped sliders and the step names go — "3" does not tell you the palette
  //   is 256 colours, and index 3 does not tell you the grid is 4x3. On `tiler`
  //   that is the ENTIRE face, since it has exactly one control.
  //
  //   `onetonine.showGrid` was retyped `linear` -> `discrete`. See #2090 and the
  //   note on the param: that issue REFUSED this retype on the grounds that no
  //   consumer reads `curve`, and it was right while the module was card-only.
  //   FACING IT CREATES THE CONSUMER — a latching toggle resolves ONLY through
  //   `looksLikeToggle`, and `ModuleFace` has no toggle field of its own — so
  //   left `linear` this face would have drawn a 2-state param as a KNOB, the
  //   moog962 inert-control defect. The retype is now load-bearing, not
  //   gate-greening, which is exactly the condition #2090 said must change
  //   first. Behaviour is preserved: `gridOn()` thresholds at `>= 0.5` and
  //   discrete snapping rounds to nearest, and `node.data.showGrid` (a boolean)
  //   takes precedence anyway.
  //
  // ⚠ `sourcery` IS THE ONE FREE FACE, and it is also the one that proves the
  // primitive rule is not "declare faders everywhere": its card draws four
  // KNOBS, so it declares NO `paramCells` at all, while its three batch-mates
  // declare faders. Copying either onto the other would be a silent regression
  // in one direction or the other.
  //
  // ⚠ BOTH ROSTERS DERIVE from arrays that already exist —
  // `POSTERBOX_DEPTH_STEPS` (the quantiser's own level table) and `TILER_STEPS`
  // (which the CV snap and the card's rail read) — so a face cannot disagree
  // with the engine, and a step added to either cannot leave a face naming a
  // subset. Nothing is invented and no count is hand-typed.
  'posterbox',
  'tiler',
  'sourcery',
  'onetonine',

  // ── BATCH 21 · CELLSHADE — the cel-shader, rebuilt on current main ────────
  //
  // Six controls, all drawn with `NeonFader` on the card, so five of them are
  // declared `fader`. The sixth — `bits` (labelled BANDS) — is DISCRETE and
  // carries an `options` roster instead, because module-face-lint refuses
  // `fader` on a discrete param AND on any param with a roster: a fader cannot
  // show names, so the states would render as unlabelled detents. That lesson
  // came from `posterbox.depth` / `tiler.tile` in batch-22 G3.
  //
  // ⚠ THE ROSTER IS REQUIRED, NOT DECORATIVE, AND THE REASON IS ACCESSIBILITY
  // RATHER THAN POLISH. `bits` stores an INDEX 0..4 while the player is
  // choosing a BAND COUNT 2/3/4/6/8. The CARD bridges that with a `formatValue`
  // prop and a labelled tick rail — card-side props `ModuleShell` does not
  // pass. Verified at the read site: `NeonFader`'s `readoutText` is
  // `formatValue ? formatValue(v) : format(v, units)`, and it feeds
  // `aria-valuetext`. So an undeclared `bits` would make the face ANNOUNCE THE
  // INDEX — saying "2" while the picture shows FOUR bands. That is a WRONG
  // value, not a missing one, which is what flips this from optional to
  // required.
  //
  // ⚠ THE LABELS ARE PROMOTED, NOT INVENTED — they are `CELLSHADE_BAND_STEPS`,
  // the array the shader's quantiser indexes. Invention would be naming these
  // "coarse"/"fine", words that appear nowhere in the code. This is the same
  // move `tiler` makes with `${cols}×${rows}`: existing structured data
  // rendered as a label. And it survives the no-resting-text ruling for the
  // same reason — the dial's position is the INDEX, the label is the BAND
  // COUNT, so the label says something the control does not.
  //
  // ⚠ REBUILT, NOT RESUMED. A parked branch carried a cellshade face from
  // 2026-08-11 based on `a216ff243`; it predates the readout, width,
  // EXTENSION_BODY_ROLES and latching gates, and its own commit marked itself
  // UNVERIFIED. Everything here was re-derived against current main.
  //
  // ⚠ COSTS AN ATTEST — `params` is in the WebGL content basis. Nothing else in
  // this face is: `face`, `paramCells` and `docs` are all stripped.
  'cellshade',

  // SCOREBOARD (2026-08-22, #2089) — split out of batch-22 by owner order, and
  // the THINNEST face in the video fleet: ONE ranked control.
  //
  // That is the honest shape rather than a shortfall. The module is a counter
  // you can see — two gates in, four neon digits out, no video input and no
  // audio path — so its surface IS the display and the only thing to set by
  // hand is what colour it glows. Thinness never refuses a face (owner,
  // 2026-08-20), and one honest cell with nothing padded is the correct outcome
  // of "compact is the default and width must be earned".
  //
  // ⚠ ITS ONE CONTROL IS A HUE, AND THE CARD DRAWS IT AS A KNOB. `color` is a
  // continuous 0..1 angle onto 0-360 degrees — it WRAPS, so a dial's end stops
  // fall mid-space and the player travels the long way round between two
  // neighbouring reds. The face declares `paramCells: { color: 'hue' }`, the
  // conic ring, which is the platform's named answer for exactly this shape.
  // A deliberate primitive divergence from the card, not a range divergence.
  //
  // ⚠ AND IT IS BASELINABLE, unlike the other video face this lane shipped.
  // The picture is a pure function of (score, hue) — no time term, no RNG, no
  // accumulator in the RENDER (the counter only moves on a gate edge) — and the
  // module already carries a `__scoreboardVrtSeed` construction hook, which is
  // exactly `simPin`'s shape. It is also main-thread BECAUSE of that hook
  // (`worker-eligibility` excludes it: a worker realm has no `window`), which
  // is the precise inverse of acidwarp, where worker locus is what put simPin
  // out of reach. So this face takes real scenes.
  //
  // ZERO ATTEST: `face`, `paramCells` and `noUserControl` are all
  // hash-transparent, and no `params` field is touched — no options, no
  // landmarks, no curve, no default.
  'scoreboard',

  // ACIDWARP (2026-08-22, #2111) — the batch-23 module that RODE ALONE, on the
  // complex-module half of the owner's split: five params but FOUR distinct
  // control shapes over one 320x240 display.
  //
  // ⚠ IT IS THE FIRST FACED MODULE WHOSE `freeze` IS A FEATURE, NOT A HOOK, and
  // that has a consequence no other entry in this set has: it CANNOT take a
  // face VRT scene. `freezeFaceVideo` freezes a video face by writing
  // `params.freeze = 1`; on acidwarp that halts only the automatic scene
  // cycler while THE PALETTE KEEPS ROTATING, so the picture keeps moving and
  // the harness's one mechanism does not bite. It is therefore in
  // `FACES_WITHOUT_SCENES` with a measured argument rather than in `FACES` —
  // the milkdrop precedent, reached independently. The CARD roster had already
  // reached the same verdict (`EXEMPT_FROM_VRT`).
  //
  // ⚠ THE PROMOTION ALSO DELETES TWO RESTING READOUTS, one of which the batch
  // derivation missed: `SCENE n/41` AND the live speed multiplier. The second
  // could not simply be dropped — `speedKnobToMultiplier` puts NATIVE 1x at the
  // knob's MIDPOINT and nothing in the ParamDef said so — so the fact moved
  // onto `speed` as two LANDMARKS (`STILL` / `NATIVE`), which are names rather
  // than measurements and cost no NUMERIC_LABEL_EXEMPTIONS.
  //
  // ⚠ AND IT COSTS AN ATTEST: `paletteType` gains an `options` roster and
  // `speed` gains `landmarks`, both `params` changes, and this is a video def.
  'acidwarp',
  // ── BATCH 22 · GROUP 4 — the video thin tail, THE REMAINDER ───────────────
  //
  // Four video processors with 1-4 params, promoted together. Every one of the
  // thirteen params is a `NeonFader` on its card, so all four declare
  // `paramCells: {... 'fader'}` — the same parity-critical declaration group 1
  // established, for the same reason: nothing in a ParamDef separates "a level"
  // from any other continuous scalar, so an UNDECLARED face resolves a fader to
  // a KNOB and the promotion silently substitutes a dial for a throw, with
  // `contract-lock`, `module-docs-lint` and the range assertions all blind
  // because they read the def and the def says nothing about the primitive.
  //
  // ⚠ ON `luma` AND `videoMixer` THE SILENT SWAP WOULD ALSO HAVE FALSIFIED
  // SHIPPED PROSE. Every entry in both defs' `docs.controls` NAMES the
  // primitive in its first two words — "Gamma fader — …", "A1 fader (linear
  // 0..1, default 1.0) …" — so a promotion that turned them into knobs would
  // have left the shipped documentation describing controls that no longer
  // exist, with every def-reading gate green. That is the #2009 lesson, and it
  // is the second time this batch has hit it (colorizer, group 1).
  //
  // ⚠ NONE OF THESE FOUR CARDS DRAWS A PREVIEW — and that makes this group
  // different from every video face before it. `MapperCard` / `DestructorCard`
  // / `LumaCard` / `VideoMixerCard` are each a title, a PatchPanel and a fader
  // row: no canvas anywhere. So each new `fullViewBody` is a pure ADDITION
  // rather than the usual port-a-card-affordance, and on all four the PICTURE —
  // not the control layout — is the reason the promotion is worth doing:
  //   * `mapper` has ONE param and would otherwise fail the merit test. Its
  //     whole output is a MATTE DECISION and "did the key cut where I wanted?"
  //     is unanswerable from a fader reading 0.5.
  //   * `destructor`'s four faders are DEGRADATION AMOUNTS whose only
  //     description is a look.
  //   * `luma` ships a BIT-EXACT IDENTITY (see below), so the frame is the only
  //     thing that distinguishes graded from untouched.
  //   * `videoMixer` SUMS — four faders with no per-channel observable at all.
  // Recorded so nobody later "restores parity" by deleting them.
  //
  // ⚠ TWO REAL FINDINGS, one per module, neither previously written down:
  //
  //   * `videoMixer` SHIPS THREE OF FOUR CHANNELS BIT-EXACTLY DEAD. `amount1`
  //     defaults to 1.0 and `amount2/3/4` to 0.0, and the shader multiplies each
  //     sampled input by its amount — so patching a source into in2/in3/in4 on a
  //     fresh node produces EXACTLY the previous frame. It is a defensible
  //     default (opening all four sums to 4x and clips to white on contact) but
  //     nothing in the product said so. It is also the rank-1 argument: A1 is
  //     the only fader that does anything before the player touches something.
  //
  //   * `luma` SHIPS AS A BIT-EXACT IDENTITY. All four defaults are their own
  //     no-ops, including the deliberate `levels >= 16.0` TRUE BYPASS branch
  //     (F-L2). Documented on the def; now it has a surface that can show it.
  //
  // ⚠ AND A THIRD, IN A COMMENT RATHER THAN A CONTROL: `destructor.ts`'s FILE
  // HEADER said `mangle` "scales all three" effects and described `posterize`
  // as "0 = none, 1 = harshest". Both are backwards. `FRAG_SRC` scales only
  // `uShift`/`uScanline` by `k`, and `levels = mix(2, 32, uPosterize)` makes 0
  // the HARSHEST. The shipped `docs` were already correct on both counts, so
  // the two prose surfaces contradicted each other. Corrected with this face —
  // comments, so no attest and no contract move.
  //
  // ⚠ `luma.posterizeLevels` IS THE #2090 CLASS WITH THE POLARITY REVERSED. The
  // def says `curve: 'discrete'` (2..16) and `LumaCard.svelte` passes
  // `curve="linear"`. On #2090 the DEF was the wrong side and the fix was
  // REFUSED because no consumer read the field; here the CARD is the wrong side
  // and the faceplate's consumer DOES read the def — the shader itself floors
  // the uniform, so fifteen positions with nothing between them is the truth.
  // Promotion resolves it in the def's favour with no def edit and no
  // contract-lock move.
  //
  // NO `pages`, NO `hero`, NO `bareCells`, NO readout and NO sidebar on any of
  // the four: each is one honest band, and the 2026-08-19 rulings removed the
  // other fields. None is a MONITOR-mode module: grepped at authoring time,
  // `hideControls` appears on `RuttetraCard`, `MonoglitchCard`, `MilkdropCard`,
  // `ReshaperCard` and `GraphicEqCard` (plus `ModuleShell`, its consumer), and
  // in NONE of these four cards — so inventing it here would be adding an
  // affordance rather than preserving one.
  //
  // ⚠ SCREEN OFF KEEPS THE WATCH MARK ON ALL FOUR, AND ALL FOUR ARE STATELESS —
  // so unlike group 1, the reason is the OUTPUT every time and there is no
  // accumulator case in this group. Do not copy `vdelay`'s or `milkdrop`'s
  // comment onto any of them. What differs is HOW WIDE a stalled pull reaches:
  // `mapper` produces a matte something else composites, `luma` and
  // `destructor` sit mid-chain, and `videoMixer` is the JOIN — a stalled sum
  // blacks out up to FOUR upstream chains' visible result at once.
  //
  // ⚠ ZERO ATTEST for all four: `face` and `paramCells` are stripped by
  // `scripts/attest-code-basis.ts`, comments are stripped with them, no def's
  // `params` are touched, and the four bodies + extensions live under `ui/`.
  'mapper',
  'destructor',
  'luma',
  'videoMixer',
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
