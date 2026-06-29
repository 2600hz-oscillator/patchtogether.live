---
name: skeptical-first-baseline
description: Before committing ANY new composite/scope/spectrograph VRT baseline, treat the first capture as a DISCOVERY opportunity, not truth. Predict the display from first principles + the pure DSP core, compare, cross-check, get an adversarial second opinion, and document WHY it's correct on the scene — only then commit. Extends vrt-failures (examine, don't rubber-stamp) to INITIAL captures.
---

# Be skeptical of the first baseline

## The trap

When you first wire a real signal chain to a display (SCOPE / SPECTROGRAPH /
SYNESTHESIA) and capture a baseline, that PNG becomes "truth" forever. Every
future CI run is diffed against it. So if there is a latent DSP bug you don't
know about, **the very first capture shows the BUGGY waveform — and committing
it blesses the bug as correct, permanently.** A green diff on a wrong baseline is
worse than no test: it manufactures confidence in a broken signal path.

This is the exact failure mode of the ~11 byte-identical 440 Hz ART stubs (a
required gate comparing a stub against itself, caught by the 2026-06-27
adversarial review) — except a picture is auditable, so we have a real chance to
catch it AT CAPTURE TIME. Take it.

`vrt-failures` says: a VRT FAILURE is never auto-OK. This skill says: a NEW
baseline is never auto-OK either. **The first capture gets MORE scrutiny than a
later diff, not less.**

## When this applies

Any time you create or recapture a baseline whose pixels encode a COMPUTED
SIGNAL: composite scenes (`e2e/vrt/vrt-composite-scenes.ts` /
`vrt-composite*.spec.ts`), scope/spectrograph/synesthesia scenes in
`e2e/vrt/vrt-scenes.ts`, or any display fed by a real patch chain. (For
pure-chrome knob/fader cards the risk is low — but the procedure still helps.)

## The procedure — do ALL of it before `git add` on the PNG

1. **PREDICT first, from first principles + the pure core.** BEFORE looking at the
   capture, write down what the display SHOULD show: waveform shape (ramp / sine /
   square / rounded), amplitude (±1? a 0.7 DC line?), spectral content (which
   harmonics / which band / where the roll-off lands), contour (A-D-S-R). Derive it
   from the math AND the relevant pinned unit test:
   - `packages/dsp/src/lib/moog-vco-dsp.test.ts` — saw ramps, square duty, sine
     quarters, C4 = 261.626 Hz.
   - `packages/dsp/src/lib/moog-ladder-dsp.test.ts` — ~24 dB/oct slope; high regen
     ⇒ self-oscillation sine at the cutoff.
   - `packages/dsp/src/lib/adsr-env.test.ts` — attack to 1.0, decay to the
     sustain level (≈0.7 default).
   - `packages/dsp/src/lib/sample-hold-dsp.test.ts` — scale-snap targets.
   - `packages/dsp/src/lib/resofilter-dsp.test.ts` — LP/HP/BP/notch/allpass
     response (the SVF that several filters share).
   If you cannot predict it, you cannot validate it — stop and learn the DSP first.

2. **CAPTURE, then COMPARE against the prediction.** Open the PNG and eyeball the
   trace against step 1. Does the saw fall? Does the comb die above the cutoff row?
   Is the DC line at 0.7, not 0.5 or 1.0? Where feasible, add a PROGRAMMATIC check
   on the rendered pixels (or the analyser readback hook, e.g. SCOPE's last-sample
   read) so the assertion isn't only your eyeball — a prediction confirmed by a
   pixel/sample probe is far stronger than "looks right."

3. **CROSS-CHECK against the pure core's known-good numbers.** Tie the visual to a
   specific pinned value: "the fundamental band sits at the row for 261.6 Hz —
   matches `moog-vco-dsp.test.ts`"; "the line is at 0.7 of CV scale — matches the
   sustain in `adsr-env.test.ts`." If the picture and the core disagree, ONE of
   them is wrong — investigate, do not commit.

4. **ADVERSARIAL SECOND OPINION.** Have an independent agent or human ask, point
   blank: "Does this show what it SHOULD — or did we just bless a bug?" The
   reviewer must re-derive the prediction INDEPENDENTLY (not be handed your
   answer). This is the cheapest place to catch a flipped sign or a dead stage.

5. **DOCUMENT WHY it's correct, on the scene.** Add a comment on the scene/baseline
   stating the expectation and its source: e.g. `// scope shows a flat line at
   0.7×CV because ADSR sustain default = 0.7 (adsr-env.test.ts); gate held high`.
   A future reader (or a recapture PR) must be able to re-validate without
   re-deriving from scratch. An undocumented baseline is an unverified baseline.

6. **ONLY THEN commit.** Capture darwin, defer linux via `EXEMPT_BASELINE_PAIRS`
   (`linux/<scene-id>`) until a `vrt-update.yml` linux capture lands, and note in
   the commit body what the baseline PROVES and how you validated it (steps 1-5).
   Never "commit to make CI green."

## Red flags that you're about to bless a bug

- You can't say in one sentence what the display SHOULD show.
- The picture "looks plausible" but you never checked it against a pinned number.
- A flat / black / centered frame you assume is "the module being quiet" — it may
  be a DEAD DSP path (the #1 thing this test exists to catch; cf. silent-poly
  POLYHELM #674).
- Two baselines in a sweep (sine vs saw, gate-hi vs gate-lo, regen low vs high)
  look IDENTICAL — the variable under test isn't reaching the display.
- You're recapturing several scenes at once "to settle them." Recapture ONE,
  validate it fully, then the next.

## Why this exists

When we first hook a real chain to a scope and capture a baseline, that baseline
becomes "truth" — but if there's a latent DSP bug we don't know about, the scope
shows the BUGGY waveform and we'd bless the bug as correct forever. A new
composite/scope baseline is a **discovery opportunity, not a rubber-stamp.** Honor
it the same way `vrt-failures` is honored for failures.

See also: `.myrobots/plans/composite-state-vrt-2026-06-28.md` (the high-ROI
composite-scene plan this skill guards; local working notes), and the memories
`feedback_vrt_failures` + `feedback_no_flake_tolerance`.
