---
name: module-adversarial-audit
description: The pre-face audit for one audio module — what it is SUPPOSED to do, what it ACTUALLY does, an adversarial check that could go red, fix what you find, then build the surface. Carries the 2026-08 case file (seven shipped defects with the measurement that found each and why every gate was blind), a probe cookbook, and the reporting rules. Use before authoring a faceplate, before promoting a module, or whenever asked "is this module actually correct".
---

# The adversarial module audit

**Every module gets: what it is SUPPOSED to do → what it ACTUALLY does →
an adversarial check → fix what is found → *then* the surface.**

This order is not politeness. Seven defects shipped fixes in the first three
days of August 2026, and **every one was found by this method on a module that
was on the queue for a faceplate**, not by a gate. Building a face first means
drawing a designed panel over a module that does not work — which is what
sixstrum did (twenty controls over an instrument that could not be sounded) and
what shimmershine did (a "crystalline drone" that was a DC rail).

The output of an audit is one of three things, and **all three are complete
answers**:

1. a DEFECT, with a measurement, its own commit, and the gate that could not
   previously have caught it;
2. **"zero un-exposed DSP capability"** — the def and the DSP are 1:1. That is a
   finding, not a shortfall. Say it and move on;
3. **"NO FACE ON MERIT"** — see `module-faceplates.md` STOP 1.

---

## Step 1 — what is it SUPPOSED to do

Read four things, in this order, before writing a word:

```
packages/web/src/lib/audio/modules/<mod>.ts          # def, face, docs, factory wiring
packages/web/src/lib/ui/modules/<Mod>Card.svelte     # LINE BY LINE — control-loss ground truth
packages/dsp/src/<mod>.{ts,dsp}  or  lib/<mod>-dsp.ts
art/scenarios/<mod>/*                                # what is pinned, and by WHICH hash function
```

Then write **one paragraph, musically**: the ONE thing this module does that its
siblings do not, and the verb a player performs on it. Not a feature list. Every
later claim descends from that paragraph.

Diff the def's `params` against the DSP's `PARAM_TABLE` / `parameterDescriptors`
/ `hslider`s. A constant hiding a real dimension (reverb's `fb2`, shimmershine's
shifter rate) is a **separate PR** with its contract line, docs entry, face rank,
faces-parity cell and ART re-pin itemised. **Never fold a DSP change into a face
wave.**

## Step 2 — what does it ACTUALLY do. MEASURE.

**Four separate hypotheses were disproven by measurement in one session.** Do not
reason from the source about behaviour you can render. Drive the real core, or
the real page, and read a number.

The probes below are the ones that actually found something. Reach for the shape
that matches the claim you are testing.

| claim under test | the probe that catches it | what it found |
|---|---|---|
| "this knob does X" | **bit-exact delta across the WHOLE travel**, quarter-turn by quarter-turn, on the def's own spawn defaults | cube MORPH: RMS difference between 0 and 1 **exactly 0.000e+0**, every quarter-turn 0.0000 (`e8585fd9`) |
| "this fader is a shape control" | **RMS sweep at a level OUT of the saturator**, sampling the MIDDLE of the travel, not just the ends | clap WIDTH: −33.96 / −43.00 / −47.16 / −49.93 / −52.02 dB — an **18.06 dB** spread on a control labelled as timbre (`290dcdb5`) |
| "the CV follows the envelope" | **two different attack times must produce DIFFERENT rise times** — an absolute threshold passes a merely-faster slew | vca: 1 ms and 5 ms attacks gave a **bit-for-bit identical** rise (49.79 ms both) through a 7.02 Hz smoother (`290dcdb5`) |
| "it is placed in the stereo field" | **band-split L/R balance WITH A SIGN**: `(E_L−E_R)/(E_L+E_R)`, HF vs LF bands | snaredrum: LEFT hand gave HF **−0.9991** / LF **+0.7820** — the sizzle on the opposite side from the hand (`1446f1c5`) |
| "the tail sustains" | **DC fraction of the tail** over a long render, plus the round-trip DC loop gain | shimmershine: **100.0 % DC** at the defaults, mean −0.281; at SHIMMER 1, −0.980, a full-scale rail. The tanh bounded it, so it never blew up and never sounded like anything (`290dcdb5`) |
| "these two jacks are separable" | **different signals into each channel, then `peak \|OUT L − OUT R\|`** | twotracks: **0 over 150 samples** while OUT L peaked at 0.7456 — both handles were `{ node, output: 0 }` on a 2-channel bus (`16bf310e`) |
| "recording works" | **join the WRITER's key to the READER's key** in one pure function | samsloop: `stopRecording` wrote `node.data.sample.bytesB64`; the factory read `fileBytesB64` then `samples`. REC persisted, redrew, round-tripped, downloaded a correct WAV — and the module stayed **silent** (`bbba5b5d`) |
| "a press is transient" | **unmount mid-hold, then read the durable param** | tomtom `strike` latched 1 in the Y.Doc, so `max(trigger_in, strike)` stayed high and the rising edge never fired again — an external sequencer could never play the drum (`momentary-params.ts:12-37`) |

Two habits that make every one of these cheaper:

- **State the units in the assertion message** (`dB` vs linear, `ms` vs frames,
  `CSS px` vs screen px). Half the instrument bugs in this repo were unit
  confusions a printed label would have exposed.
- **Reproduce under the environment that actually fails.** `E2E_SWIFTSHADER=1`
  for anything WebGL; the real compiled wasm, not the pure-math mirror, for
  anything the worklet computes.

## Step 3 — the adversarial check: why did NOTHING catch this?

Answer it every time. The answer names the gate you owe.

Every one of the seven had a green, honest, well-written gate sitting next to it.
The recurring shapes:

1. **Every gate read the CONTRACT; the defect was in DATA.** cube's
   `contract-lock` pinned the param, `module-docs-lint` checked it was
   documented, `per-module-per-port` proved the CV jack materialised an edge —
   all correct, and none of them rendered the module and asked whether the knob
   changes the output. *Ask: is the thing that is wrong a declaration or a value?*
2. **Every gate read ONE SIDE of a two-sided contract.** samsloop's encode was
   pinned, the render-given-a-buffer was pinned, the upload path was pinned end
   to end — nothing joined the recorder's write to the player's read. *A gate
   that reads one side proves nothing about the other.*
3. **The assertion was invariant to the dimension under test.** snaredrum's
   stereo assertions were mono-safety, "L and R differ", and side-energy
   sensitivity — all three are blind to **which** side. clap's loudness clause
   was an amplitude WINDOW measured at a level where the final tanh had already
   compressed 18 dB of RMS into 0.9998 vs 0.6115; it could not fail.
4. **The observation window was structurally outside the effect.** vca's ART
   windows are 0.05–0.45 s and 0.7–1.0 s; the smoother's tau is 22.65 ms. The
   slew was outside every assertion by construction.
5. **The design property made the observable unreachable.** An audition writes
   nothing to the graph on purpose, so `readParam`/`readData` are structurally
   blind — and the gate settled for `toBeEnabled()` + click + assert nothing.
   *When the natural oracle cannot see it, find the next observable inward
   (`audition-ledger.ts`), do not drop the assertion.*
6. **A filter applied before the check redefined the check's subject.** See
   `blind-gates.md` Pattern 5 — an opt-in list, a `if (!p.edge) continue`, a
   bracket-only regex. Three instances in one day.

## Step 4 — fix it, with the gate that could not previously have caught it

Every fix ships with an assertion that **fails on the old code**. Reproduce
before, fix, reproduce after, and put both numbers in the commit message.

- **Negative-control in BOTH directions.** Force the subject broken (the gate
  must go red) *and* force it working (the inverse gate must go red). The
  audition ledger's predicate is negative-controlled both ways in the unit lane
  on every run (`audition-ledger.test.ts`); the e2e side was verified once by
  disconnecting karplus's `manualTrigger` read key and watching `faces-parity`
  go red at the probe — **with `toBeEnabled()` and `click()` both still
  passing.** That is the finding in one line.
- **Prefer a PERMANENT per-run control leg** over a one-time authoring check. A
  check you ran once is a check nobody is watching. The derived-readout tests
  (`<mod>-face-model.test.ts`) are the pattern: the negative control IS the test.
- **Add a leg that covers the MIDDLE of the travel**, not only the endpoints —
  clap's replacement is an RMS sweep with an explicit assert that the render
  stays out of the tanh, plus a COLOR leg as a negative control **on the metric
  itself**.
- **Put the fix where the pin already reaches.** snaredrum's pan helpers live in
  `snaredrum-dsp.ts` rather than a shared lib on purpose: the ART profile's
  `dspSourceSha` enumerates that file, so a coefficient change stays forced
  through an intentional `task art:update`. A new lib file would sit outside the
  pin.
- **Fix READER-side when already-saved racks must recover.** samsloop's
  `resolveSamsloopSource` and `momentary-params.restedParams` both repair
  existing data with no migration step and no user action.

### If an ART baseline moves, ATTRIBUTE every manifest entry

`task art:update` re-pins the `.f32`, the `.sha` **and**
`fingerprints.generated.json`. Read the manifest diff entry by entry:

- **labels-only** (`peakDb` / `rmsDb` move, spectrum byte-identical) = a LEVEL
  change. A uniform +3.01 dB on both is the signature of a ×√2 scalar gain.
- **spectrum / features move** = a TIMBRAL change.
- **An entry you cannot attribute to a change you made is a real audio
  regression. Stop. Do not re-pin.**

Useful precision: clap's WIDTH fix left `art/baselines/clap/audio_out.f32`
**byte-identical** (the default sits at the normalisation point) and moved only
the `.sha`. That is what "measure the user impact by knob position" buys you —
WIDTH 0 got 13.8 dB quieter, WIDTH 1 got 5.1 dB louder, the default did not move
at all.

## Step 5 — report and route

- **A behaviour fix is its own commit, and usually its own PR.** Never fold it
  into a face wave — bisectability is the whole argument.
- **Anything that changes how a module SOUNDS or LOOKS is an owner-preview PR.
  Do NOT auto-merge.** Title it so, in the subject line. The shipped precedents
  all say `AWAITING OWNER AUDIO PREVIEW — DO NOT MERGE` or `⚠ OWNER-AUDITION PR`.
- **State the user impact by control position**, not in the abstract: "a saved
  rack with WIDTH away from centre WILL change level; that is the defect, not a
  side effect."
- **Price the CI delta.** >~2 min needs owner sign-off.
- A defect that needs a GPU re-attest (cube did) is separated for exactly that
  reason — see `webgl-attest.md` RULE 3, the treadmill.

---

## Anti-patterns, in order of how often they recurred

From the 20-agent fan-out review (`.myrobots/plans/face-specs-round-2-2026-08-01.md`
— **not one of ten specs came back sound**: 4 contradicted the code, 6 needed
work, 71 defects total):

1. **Justifying a decision with computed pixel arithmetic instead of the
   committed baseline PNG.** Measure the artifact.
2. **Listing "cell count unchanged" as the verification** and missing the named
   regression specs, the page-label text assert, and the rear-card pins.
3. **Proposing a ranking identical to the existing one and presenting it as a
   redesign.**
4. **"The same platform pattern as module X"** without checking module Y's stated
   invariant.
5. **Assuming an artifact exists because siblings have one** (an ART `.sha`, a
   numbered legend — only three legend files exist in the whole repo).
6. **Prose that contradicts the code block directly beneath it.**
7. **Inventing a platform blocker.** Two independent agents both concluded that a
   `shell-cells` action needs a ~14 LOC platform PR because `PatchEngine` is
   context-only. `getActiveEngine()` (`$lib/audio/engine-ref.ts:23`) has been
   exported and consumed from plain `.ts` for months (`clipplayer.ts:28`,
   `push2-control.svelte.ts:61`). **Because two independent agents made the
   identical error, assume a third will.** Verify a blocker before ordering a PR
   around it.

## What this skill does NOT cover

- **VIDEO / WebGL modules.** The probe cookbook is audio-shaped; the render side
  is `iterated-render-e2e.md` (count frames, never milliseconds) and the attest
  treadmill is `webgl-attest.md`.
- **Poly / MIDI modules.** They have an additional hard requirement — e2e the
  REAL source chain (MIDI LANE / POLYSEQZ → module → audible RMS). An
  engine-direct test does not count. See CLAUDE.md and memory
  `poly-modules-test-real-source-chain`.
- **Multiplayer / persistence semantics** beyond "does an already-saved rack
  recover". Anything touching `persistence.ts` / `mutate.ts` gates the collab
  attest.
- **Deciding whether a fix is worth the sound change.** That is an owner call and
  the PR must ask it explicitly.

## Related

- `module-faceplates.md` — what you do AFTER the audit passes
- `blind-gates.md` — the full treatment of gates that cannot see what they gate
- `skeptical-first-baseline.md` · `module-pr-checklist.md` · `running-tests.md`
- Memory `flaky-tests-can-be-unsound-not-just-flaky` — ask why the GREEN runs
  are green
