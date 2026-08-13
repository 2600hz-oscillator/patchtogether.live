# Stereo audio normalization — what is left

**CORE COMPLETE. PR-0 through PR-4 are all on `main`** (#1397, #1402, #1404,
#1407, #1408, #1409, and #1426 which added per-leg patching). Their
implementation recipes are deleted — the code is a better copy of them.

| PR | state |
|---|---|
| ~~PR-1 rename stereovca→ringmod~~ | ⛔ **STRUCK** — deferred to that module's FACEPLATE work. Recipe kept below. |
| **PR-5** declared-pairs parity + attest batch | ⏳ **NOT STARTED** — verified 2026-08-12: `VideoModuleDef` still has no `stereoPairs`, only 22 defs declare it |
| **PR-6** mixmstrs per-channel pan | ⏳ **NOT STARTED** — verified 2026-08-12: no `pan1..pan8` params on `mixmstrs.ts` |

Plus **one open owner question** (group D/E, below) and **one deferred follow-up**
(option C).

---

## The architecture, in one paragraph — so nobody re-derives it

**The PROJECTION (Option B).** Port ids, the `Edge` shape, the Y.Doc schema,
`engine.addEdge` and every module def's ports stay byte-identical. "One stereo
cable" is a **leg group** of existing per-channel edges, co-created / co-deleted
by the wiring layer and rendered as one bezier. "Patch only L" writes exactly one
leg. Pairing is derived centrally — declared `stereoPairs` ∪ the L/R id-token
fallback, **audio-typed ports only**, minus named exemptions. Jack collapse lives
**inside PatchPanel**, not per-card. This bought zero saved-rack migration across
all five persisted surfaces: a legacy single-leg edge reinterprets as an only-L
cable, audio byte-identical. Option A (true port-id merge) measured at ~2–3× the
cost for **zero user-visible gain**.

## DUAL-MONO is the policy — the owner REVERSED sum-to-mono

> *"if we pass a stereo signal through a module which is, at present, mono, we do
> not want to lose the stereo data."*

A mono module fed a stereo leg group runs its DSP **twice**, one instance per
channel, independent state — as a DAW instantiates a mono plugin on a stereo
track. **ALWAYS two instances. No "is the input really stereo?" detection**, because
a runtime heuristic deciding whether two legs "are the same signal" is exactly the
class of instrument that fails silently: *"i want our purely mono sources to
eventually go away so i don't want to harden for them."* **2× CPU on mono modules
is accepted, deliberately.**

### As built, the "one generic wrapper for 21 modules" story did not survive

Two rounds of measurement, both of which corrected the round before. Kept because
each correction is a *class* of mistake, not a number:

- **Classifying on DECLARED PORTS was wrong.** The spec said group A (clean
  mono→mono pipes the wrapper serves verbatim) was **13**; the DSP said **7**.
- **4 of the 13 need NOTHING — they are already dual-mono, natively, at 1× cost.**
  `delay`, `scaler`, `moog907a`, `moog914` are built from native Web Audio nodes,
  which keep independent state per channel. Wrapping them would have doubled the
  CPU of the most common time-effect in the app for **zero** behavioural change.
  This is a MEASUREMENT, pinned in `art/scenarios/stereo-dual-mono/`.
- **The population was 27, not 26** — the correction table itself filtered on
  `domain=audio` and silently dropped `milkdrop`. The gate now asserts the
  population is NOT domain-filtered, because that filter is precisely the "a
  filter applied before the check redefines the check's subject" defect.

Wrapped set as shipped: **`destroy filter reverb moog904a moog904b moog904c
moog905`**. Classifications live in `packages/web/src/lib/audio/dual-mono.ts`.

### Two mechanism notes that were expensive to find

- **An AudioParam CV input needs a FAN, not a hand-off.** `destroy` and
  `moog904c` resolve to real AudioParams and `addEdge` connects the CV source
  straight to `din.param`. Handing it instance A's param would leave the RIGHT
  channel unmodulated. A `ConstantSourceNode` with `offset = 0` re-emits whatever
  is connected to its offset as a signal, fanning into both real params while
  keeping the engine's CV scaling and param tap on the normal path.
- **The wrapper's audio input needs TWO paths summed, not one bigger one**, because
  each covers a case the other destroys:

  | arrives as | path | why the other path breaks it |
  |---|---|---|
  | 2-channel stream on ONE cable (what a dual-mono module emits → what CHAINS) | `mono` bus → `upmix` | a ChannelMerger INPUT is 1-channel by spec, so it would down-mix the pair away |
  | two cables from `out_l`/`out_r` (what `planAudioCommit` writes) | `legL`/`legR` → `ChannelMerger(2)` | a shared bus SUMS them, which is the failure dual-mono exists to prevent |

  ⚠ **A ChannelMerger has the discrete zero-fill hazard in a different costume: an
  unconnected merger input renders as SILENCE.** A lone `out_l` would have gone
  left-only. Two engine-controlled **mono normal** gains close it: OPEN by default,
  closed only once the opposite leg genuinely lands, re-opened on unpatch. **The
  failure direction is duplication, never silence.**

### Sharp edges that are still live properties of the system

1. **`read()` is single-instance.** Card meters/scopes reading through the handle
   see instance A (left) only. A silent-R inside a chain is invisible on the card
   — the same instrument-blindness the per-channel taps fixed at the terminal,
   reappearing per-module. **Decide per read key.**
2. **Nondeterministic DSP decorrelates.** Two instances of a noise/random module
   give genuinely different L and R. Often desirable width, occasionally a surprise.
3. **ART is structurally blind to dual-mono** — most scenarios drive DSP cores
   directly, not the factory path. **ART will NOT catch a dual-mono regression;**
   the 6 real-def scenarios plus e2e own that gate.
4. **2× CPU on the mono pass-through spine is a real perf surface.** Watch for
   output underrun rather than assuming a glitch is the clock.

---

## ⚠ OPEN QUESTION FOR THE OWNER — blocks dual-mono groups D and E

Groups A–C shipped without it. D and E change what `vca` and `resofilter` do to
audio, which is not an agent's call.

**Group D — 5 MULTI-TAP outputs whose taps are variants, NOT L/R:** `vca`
(audio + audio_inv), `moog902` (same), `rings` (even/odd), `moog923`
(hp/lp/pink/white), `swolevco` (mod_out/out/sum_out). Two instances × N taps =
2N streams for N declared ports; **the merger story is undefined.** ⚠ `vca` — the
single most common module in any patch — is in this group, so this is not an edge
case.

> A stereo signal reaches `vca`, one audio input, two outputs. Options: **(i)**
> treat D like the analyzers — one instance fed the sum, so stereo collapses at a
> VCA; **(ii)** duplicate and pair the taps by index, so `audio` becomes L/R and
> `audio_inv` becomes L/R — doubling the declared port count, a contract change;
> **(iii)** per-module hand-treatment.

**Group E — genuine mono→stereo wideners:** `resofilter` (`audio` → `out_l`/`out_r`)
and `warrensspectrum` (worklet declares `outputChannelCount: [2]`, reads only
`inputs[0][0]`, equal-power PANS each band across L/R). They already widen;
feeding two legs and merging two widened pairs is incoherent.

**Also unresolved: `rasterize` is a HYBRID** — `in`(audio) → `thru`(audio) **and**
`out`(mono-video). Duplicating gives two `RasterPainter`s competing for one video
port; down-mixing collapses `thru`. **Both treatments are regressions**, so it
joins the D/E question.

---

## PR-5 — declared-pairs parity + attest batch

**First task: verify/fix the 2 failing `cameraInput` tests that block
`task webgl:attest`** (parked since #979). They are a test problem, not a
machine-access problem, and the owner has granted the machine. *(Not re-verified
2026-08-12 — no attest was run.)*

Then: declare `stereoPairs` on the 19 undeclared audio modules; add optional
`stereoPairs` to `VideoModuleDef` and declare on the 9 video defs; clean
Foxy/Cube/Wavesculpt card L/R descriptor rows and labels; **deny-by-default lint**
— every L/R-token audio pair must declare `stereoPairs` or sit in a NAMED opt-out
list; then shrink the id-token fallback in `derivedStereoPairs` toward
declarations-only. Capstone: delete the then-unreachable id-token fallback branch
in `patch-convenience` `resolveMainAudioOut/In`; `io-explain` prose sweep.

⚠ **The original spec said "ratcheted both directions" here. That is now a DEAD
instruction** — hand-typed population counts were eliminated repo-wide. Use a
named deny-by-default list anchored to the artifact, per CLAUDE.md.

Gates: `task docs:accept` (+~26 additive stereo lines, review per-module — beware
the precedence interaction, declarations enter `resolveMainAudioOut` ahead of the
fallback, and `patch-convenience.test.ts:499-506` pins mixer behavior); then a
trusted-GPU `env WEBGL_ATTEST_ALLOW_BUSY=1 task webgl:attest` as the LAST unmerged
basis-toucher (kill 5173/4173 + clear `node_modules/.vite` first — a stale bundle
causes a FALSE refusal).

## PR-6 — mixmstrs per-channel pan

Owner decision: **ADD per-channel pan — 8 params + a row of pan knobs on the card.**
New per-channel pan in `packages/dsp/src/mixmstrs.dsp` (equal-power law — reuse
`equal-power-pan.dsp`'s approach; placement post-EQ/comp, pre-master sum) + 8
`pan1..pan8` params + a row of 8 pan knobs on MixmstrsCard + **an explicit
`PUSH_CARD_CONTROLS` entry** (new params re-rank the generic push card — pin it) +
contract re-pin + mixmstrs ART re-pin (entry-by-entry review; **pan@center must be
level-neutral — a moving entry not attributable to the pan law is a regression**)
+ mixmstrs VRT baselines + **owner audio preview before merge** (level-affecting).

⚠ Risk: new DSP on the most-connected module. Pan@center must be bit-transparent
or every mixmstrs ART entry moves.

## Follow-up: option C, deferred by owner decision

Once the above ships **and all UIs, VRTs and ARTs are updated**, revisit making
selected modules *genuinely* stereo rather than two independent copies — `reverb`
and `delay` are the obvious candidates, where real stereo DSP buys cross-feedback
and ping-pong that dual-mono cannot express. Per-module, on its own merits, with
owner ears. **NOT part of this sequence.**

---

## The stereovca → ringmod rename — deferred, recipe preserved

Owner, 2026-08-07: *"just leave it called stereovca for now, i don't want to touch
that many files. we'll do it when we do the faceplate for it."* Measured footprint:
**44 files.** The rename is a rider on that module's FACEPLATE work, not a step in
this sequence, and nothing downstream depends on it — PR-2/3/4 key off port ids and
cable types, and `stereovca`'s ports are unchanged by the rename by design.

The expensive parts to re-derive, when it does happen:

- **Files**: `stereovca.ts` → `ringmod.ts` (def `id`/`label` → lowercase `ringmod`;
  registration is glob-driven so the rename auto-registers), its test, its Card, and
  `packages/dsp/src/stereovca.ts`. Re-author co-located `docs` as THE ring modulator
  (audio-rate unsmoothed multiply; `strength_l`/`strength_r` stay independent cv jacks).
- **Alias**: `RETIRED_TYPE_ALIASES { stereovca: 'ringmod' }` in `persistence.ts` —
  identical port ids mean the alias keeps ALL cables on file/performance load. Add a
  registry/engine-level alias so live relay docs materialize too.
- **Registry keys**: `module-manifest.ts` DESCRIPTIONS + PORT_NOTES, `strict-docs.ts`,
  `modules-card-map.test.ts`, `interactive-doc-modules.ts`, `mike/catalog.ts` (out of
  `vcas`, into an fx/ringmod role), `rack-sizes.ts` + `rack-sizing.test.ts`,
  `cv-scale-registry.test.ts`, `vrt-exemptions.ts` STRICT_VRT_MODULES, `build_gallery.py`,
  the behavioral spec param-override key, `coverage-groups-3-4-5.spec.ts`,
  `sidecar.spec.ts`, `docs-virtual-module.spec.ts`.
- ⚠ **THE TRAP: `ci.yml`'s behavioral-smoke grep AND `behavioral-smoke-subset.test.ts`
  must move in the SAME commit.**
- **ART**: rename scenario + baselines + fingerprint keys → `task art:update`
  (content byte-identical, keys move; `.sha` last).
- **Attest**: `persistence.ts` is in the collab basis → `task collab:attest` after the
  final source commit, as the last unmerged basis-toucher.

---

## Load-bearing facts still worth having

- **The registry doc-comment LIES**: "engine virtually duplicates to R" — `engine.ts`
  contains ZERO stereoPairs/normalling code. Any plan assuming engine normalling
  builds on sand.
- **Instruments are mono-blind.** An AnalyserNode analyzes a mono downmix per spec.
  Measured on the real default chain in Chrome: **mono 0.15507, L 0.31015, R 0 —
  mono is exactly L/2**, so only-L and only-R were the same number. Any only-L/R
  assertion MUST use the per-channel taps (`outputSnapshotL`/`outputSnapshotR`),
  never the mono downmix tap. **Residual: non-terminal taps (scope, behavioral
  metric) are still mono-downmix — a dead-R inside a chain reads −6 dB, not
  failure, anywhere but the master out.**
- **The workflow default chain is LEFT-ONLY** — a mono VCO into mixmstrs `ch1L`
  reaches AUDIO OUT's L and nothing else. Any e2e that spawns the default chain and
  expects both channels is asserting something that is not true.
- **A unit test cannot see this at all.** `packages/web/vitest.config.ts` runs in
  `node` and does not pull in the audio module factories (they import WASM/worklet
  `?url` assets only Vite resolves). Per-channel audio tests live in **ART**, the
  only lane with `node-web-audio-api` + the `?url`→filesystem worklet seam.
- **`COLLAPSE_EXEMPT` needs ONE entry, not four.** Only `rings` odd/even is real —
  `scope` ch1/ch2, synesthesia band outs and es9's hardware ins derive no pair at
  all under audio-only + L/R-token, so listing them would have created stale
  exemptions. (`es9 spdif_l/r` does collapse; es9 has **14** class-tagged ins.)
- **Search by SYMBOL, never by line.** Every Canvas line cited in the original plan
  had drifted +28; the plan also gave the wrong DIRECTORY (`lib/ui/Canvas.svelte`,
  not `lib/ui/canvas/Canvas.svelte`), and a grep scoped to the wrong path returns
  nothing and reads as "the symbol is gone".
- **Verified-clean surfaces — do not re-sweep**: control surfaces
  (push2/launchpad/electra/monome — port-blind), `packages/server/src` (byte-opaque),
  interactive docs hover panes, grand attest (already pins BOTH masterL/R legs, so
  mandatory both-legs does not move the golden), `PUSH_CARD_CONTROLS` (ports are
  provably invisible to push-card ranking — only a new PARAM re-ranks, which is
  exactly what PR-6 is).
