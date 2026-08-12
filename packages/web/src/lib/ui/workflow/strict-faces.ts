// packages/web/src/lib/ui/workflow/strict-faces.ts
//
// The RATCHET set for the workflow-mode UI-CURATION system — the face analog of
// STRICT_DOCS ($lib/docs/strict-docs). A module type in this set has been
// PROMOTED to the full curation bar: its co-located `face` MUST be COMPLETE —
// every param, every declared control family, and every numbered-legend control
// appears in `face.order` (the deny-missing-curation guarantee at the control
// surface), enforced by module-face-lint.test.ts.
//
// Modules NOT in this set are checked only for CONSISTENCY (no orphaned face
// keys) — they degrade gracefully while the ratchet rolls out. The set only
// grows:
//  - every NEW faced module ships into it,
//  - a module incidentally reskinned for a fix is brought up + added (boy-scout),
//  - background batches promote the tail.
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
// `.myrobots/plans/face-specs-batch-3-noise.md` returns a verdict of NO FACE ON
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
// `.myrobots/plans/face-specs-batch-4-resofilter.md` reports the plateau gain
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
  // FACE BATCH 5 · the analog delay (2026-08-10) — see the header note above.
  'cofefve',
  // FACE BATCH 4 · the random source (2026-08-11) — see the header note above.
  'marbles',
  // FACE BATCH 4 · the clean multi-mode filter (2026-08-11) — see above.
  'resofilter',
  // FACE BATCH 4 · the exciter-driven resonator (2026-08-11) — see above.
  'rings',
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
