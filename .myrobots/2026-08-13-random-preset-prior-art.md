# Random preset / randomize — prior-art requirements

**Date:** 2026-08-13
**Purpose:** A generalized, tool-agnostic statement of what a "random preset" / "randomize" feature must do, should do, and must avoid in order to reliably produce output that is both new and interesting.
**Note:** This is a prior-art distillation — surveyed across creative audio and video tools (software and hardware), plus procedural-generation design literature — intended as input to a Toybox "randomize" feature plan. By design it contains **no product internals**: every finding is expressed as a general requirement. Surveyed tools are listed, without commentary, in the appendix.

---

## 1. Definition and goals

A **random preset** function produces, on a single gesture, a complete new working state
(a patch, scene, or preset) that the user did not author. A **randomize** function
perturbs some or all of an existing state. Mature tools offer both, and the distinction
between them (generate vs. mutate) is one of the most load-bearing design decisions in
this space (see §3).

The goal is **not randomness — it is surprise the user wants to keep.** The consistent
finding across every surveyed domain is that uniform randomness over raw parameter space
produces almost entirely unusable output; users describe results as "unusable 9 times out
of 10" at best. The features users praise are, without exception, **curated randomness**:
the possibility space has been shaped by a designer so that a random draw lands on
something coherent, and the user supplies only the selection pressure ("keep / re-roll").

Three tensions define the design space:

- **Novelty vs. usability.** A result can be so conservative it teaches nothing, or so
  wild it is noise. Good randomizers sit deliberately between, and let the user move the
  slider (an *amount* control, §3).
- **Mathematical vs. perceptual uniqueness.** Procedural-generation literature names this
  the "10,000 bowls of oatmeal" problem: every result can be mathematically unique while
  all of them *feel* identical. The metric that matters is whether a human perceives
  successive results as different — and ideally as *memorable*.
- **Exploration vs. authorship.** Randomize is a discovery tool, not a replacement for
  the user's work. Every surveyed workflow that users trust treats the user's current
  state as sacred (§5) and the random result as a *proposal*.

## 2. Requirements on the randomization itself

**R1 — Curated, not uniform.** Randomization MUST draw each parameter from a
designer-tuned range and distribution, not uniformly from the parameter's full legal
range. The single most cited property of well-loved randomizers is that ranges and
inter-parameter relationships were "extensively tuned so that useful results come out of
random mutations." Corollary: tuning the random distributions is *content design work*
with real effort attached, not a for-loop over parameters.

**R2 — Structured choices before scalar noise.** Randomization SHOULD operate at more
than one level: first choose *structure* (an algorithm, topology, archetype, or template
— which sources, which processing, which routing), then choose scalar values within that
structure. Tools that randomize only scalars on a fixed structure converge on oatmeal;
tools that pick among hand-made archetypes and then vary them produce results that are
both coherent and distinct.

**R3 — Weighted and correlated draws.** Not all parameters are equal. Draws SHOULD be
weighted (common/safe choices more probable, extreme choices rarer but present) and
correlated where parameters are musically or visually coupled — e.g. values that only
make sense together should be drawn together. Independent per-parameter dice produce
internally contradictory results.

**R4 — Exclude what randomness ruins.** Some parameters MUST be excluded from
randomization by default because random values there destroy usability rather than add
character: output level/master gain, global tempo or sync, routing that disconnects the
user's I/O, anything resembling a config setting. Community consensus is explicit that
removing modulation-matrix chaos, output gain, and utility settings from the dice is what
turns a novelty into a tool.

**R5 — Liveness guarantee.** A random result MUST be demonstrably *alive*: never silent,
never a black/empty frame, never a state whose output is imperceptible (zero amplitude,
fully closed filter equivalents, invisible geometry, 10-second attack before anything is
heard or seen). Where liveness cannot be guaranteed by construction (ranges that cannot
express a dead state), it MUST be enforced by **generate-and-test**: evaluate the
candidate against concrete constraints and silently re-roll on failure. The
procedural-generation rule applies directly: "the most reliable generators are the ones
where you can concretely describe constraints" — silence and black frames are the most
concretely describable failures there are.

**R6 — Coherence within a single result.** Each result SHOULD read as one intentional
thing, not a committee of independent accidents. Archetypes (R2), correlated draws (R3),
and shared palettes/scales/key-centers within one roll are the mechanisms. A result the
user can *name* ("a slow blue tunnel", "a plucky bass") is the informal bar.

**R7 — Variety across successive presses.** Consecutive rolls MUST be perceptually
distinct. Mechanisms observed: anti-repeat memory (do not revisit recent structural
choices; "shuffle with no-repeat"), forcing a change of archetype between rolls, and
distributions with genuinely heavy tails so that occasional rolls are surprising.
Perceptual distinctness is the acceptance criterion (§6), not statistical independence.

**R8 — Rare gems are a feature.** The distribution SHOULD keep a small probability of
extreme/weird results rather than clamping everything to the safe middle. Users
explicitly forgive a wild dud far more readily than they forgive blandness; what they do
not forgive is *dead* output (R5) or *samey* output (R7).

## 3. Scope control

**R9 — Both generate and mutate.** The feature MUST support (a) *generate*: a wholly new
state from scratch, and (b) *mutate*: variation of the current state. These are different
user intents — "give me a starting point" vs. "give me a variation of this thing I like"
— and the most praised systems in the survey are breeding/mutation workflows layered on
top of generation, where the user iterates toward a result by ear/eye over generations.

**R10 — An amount/depth control.** Mutation MUST have a user-controllable magnitude —
from a barely-there nudge to a full re-roll — ideally as a continuous control (the
"how far did you throw the dice" pattern), or at minimum a small/medium/large choice. A
related, highly regarded pattern: a control that *morphs* continuously between the
original state and the randomized state, making the amount reversible and performable.

**R11 — Scoped randomization.** The user MUST be able to randomize a *part* of the
state: a single module/section/page/layer, while everything else is untouched. Surveyed
tools converge on scope-by-section (just the sound source, just the sequence, just the
color/effects) as the difference between a toy and a daily-driver.

**R12 — Locking / pinning.** The user MUST be able to lock elements (a parameter, a
module, a whole section) so that randomization works *around* them. Infinite variations
on "everything except the thing I like" is the workflow that turns randomize into a
design partner. Locks must be visible and cheap to toggle.

**R13 — Context-awareness.** If the user has material connected — an input source, a
camera, a clip, a live signal, existing wiring — the random result MUST incorporate that
material rather than ignore, disconnect, or replace it. A randomize that severs the
user's sources fails both liveness (their content vanishes) and trust (§5). Concretely:
treat user-provided sources as locked-by-default inputs the random patch is built *on*.

**R14 — Optional aim.** The feature SHOULD offer directed randomness where taxonomy
exists: roll *within a category* (bass/pad/percussive; feedback/geometric/organic) or
"more like this one". This is repeatedly cited as what makes randomization feel guided
rather than blind. It is an enhancement, not a prerequisite, for v1.

## 4. Interaction and workflow

**R15 — One gesture.** Invoking randomize MUST be a single, discoverable, always-available
gesture (one button/key/menu item — the "dice" affordance). No dialog before the first
result. Configuration (scope, amount, locks) is available but never mandatory.

**R16 — Instant feedback.** The result MUST be applied and observable immediately —
audible/visible within the same interaction beat. Any randomizer whose results take even
minutes to audition is remembered as a punchline in the survey material. Bounded,
predictable latency is part of the contract (§5).

**R17 — Cheap re-roll.** Pressing again MUST immediately produce the next result. The
core loop is *roll → glance/listen → roll*; anything that adds friction (confirmations,
modal states, cursor travel) breaks the loop. Design for dozens of presses per minute.

**R18 — History and undo.** Every roll MUST be undoable, and the last N results SHOULD
be revisitable (a short history / breadcrumb of recent rolls), because users routinely
recognize one press too late that the *previous* result was the good one. Interactive-
evolution literature identifies temporary storage of intermediate results as essential to
the workflow, not a convenience.

**R19 — Seeds and repeatability.** A result SHOULD be reproducible: either expose a seed
(copyable, shareable, re-enterable) or guarantee that any shown result can be captured
losslessly (R20). Seeds also serve testing (R24). Repeatability is what converts a lucky
roll into an artifact.

**R20 — Save what you like.** Capturing the current result as a normal, first-class
preset MUST be one gesture away from the roll loop. Rating/marking ("keep this one")
during a browse/shuffle session is the observed pattern for building a personal library
out of a random stream.

**R21 — Auto-audition is a separate, optional mode.** Continuous background shuffle
(auto-advance on a timer or on musical events, with smooth transitions) is a valuable
*performance* mode in visual tools, but it MUST be opt-in and clearly distinct from the
one-shot roll; it inherits all the same constraints (liveness, variety, locks).

## 5. Safety and trust

**R22 — Never destroy user work.** Randomize MUST NOT overwrite the user's saved state.
The pattern used by trusted tools: an automatic restore point captured at (or before) the
first roll, with a one-gesture "reload from before I started rolling". The random result
lives in working state only until the user explicitly saves it (R20). Undo (R18) covers
the single step; the restore point covers the session.

**R23 — Atomic application.** A roll MUST apply completely or not at all. No
half-applied states, no transient broken frames or audio glitches *caused by the
application itself*, no orphaned connections, no invalid states that crash downstream
consumers. If generate-and-test (R5) rejects candidates, the rejection loop is invisible;
the user only ever sees valid states.

**R24 — Predictable cost and determinism for testing.** A roll MUST complete in bounded,
short time — generate-and-test needs an iteration cap with a guaranteed-valid fallback
(e.g. fall back to a known-good archetype) rather than an unbounded search. For automated
testing, the generator MUST be seedable so CI can assert the liveness and validity
invariants deterministically, and so a reported-bad seed can be replayed.

**R25 — Honest scope.** What a roll will and will not touch MUST be predictable to the
user: locks are honored absolutely, excluded parameters (R4) are documented, and the same
scope selection always touches the same surface. Violated expectations here — a "small"
roll that silently changed something global — are the fastest trust-killers reported.

## 6. Quality bar / acceptance criteria

A randomize feature is *good* when a skeptical user can do the following, and it SHOULD
be evaluated exactly this way (manually at first, with the mechanically checkable parts
automated via seeds, R24):

1. **Liveness, N-of-N:** press randomize N times in a row (N ≥ 20); *every* result
   produces perceptible output within the interaction beat — zero silent/black/empty
   results. This part is machine-checkable and belongs in tests.
2. **Distinctness:** in the same N rolls, no two consecutive results are perceptually
   confusable, and the set as a whole spans clearly different characters (different
   structure/archetype, not just different shades of one).
3. **Usability rate:** a meaningful fraction of the N (order one-in-three, not
   one-in-ten) is something a user would plausibly keep or build on. "Interesting dud" is
   acceptable; "dead" and "identical" are not.
4. **Workflow round-trip:** lock an element → roll repeatedly → the locked element never
   changes; undo → exact prior state; save → the kept result reloads identically;
   restore-point → the pre-session state returns intact.
5. **Context round-trip:** connect user material, then roll: the material is present and
   load-bearing in every result.
6. **Cost:** every roll returns within its latency budget, including worst-case
   rejection loops.

The perceptual criteria (2, 3) cannot be fully automated — they are review criteria for
a human pass — but their *floors* can be: structural anti-repeat (R7) and liveness (R5)
are assertable per-seed.

## 7. Anti-requirements — the documented failure modes

These are the ways surveyed randomizers fail, stated as prohibitions:

- **Uniform noise over all parameters.** The default failure. Produces contradictory,
  dead, or ear/eye-hostile states; users try it twice and never again.
- **Randomizing utility state.** Output gain, sync, I/O routing, config — randomizing
  these converts "surprising" into "broken" (R4).
- **Silent / black / imperceptible results.** Even occasionally. A single dead result
  teaches the user the button cannot be trusted mid-performance (R5).
- **Oatmeal.** Mathematically distinct, perceptually identical results — the signature
  of scalar-only randomization on a fixed structure (R2, R7).
- **Destroying user state.** Overwriting the working patch with no way back, severing
  user-connected sources, or leaving a half-applied hybrid (R13, R22, R23).
- **Slow or unbounded rolls.** Multi-second (or worse) generation kills the roll loop
  and is remembered for years (R16, R24).
- **Hidden or dishonest scope.** "Randomize this section" that also touches something
  else; locks that are advisory rather than absolute (R25).
- **Configuration as a prerequisite.** Requiring the user to set up ranges, weights, or
  checklists before the first roll inverts the feature's purpose; defaults must be the
  curated experience, with configuration as refinement (R15).
- **Novelty theater.** A randomize whose safe middle is so narrow that after ten presses
  the user has seen the whole space. Heavy tails and structural variety are what keep the
  button alive after the first session (R7, R8).

---

## Appendix — tools and sources surveyed

- Entropy & Sons Recursion Studio — https://entropyandsons.com/products/fr4xtal
- Erogenous Tones Structure — https://erogenous-tones.com/docs/structure-user-guide/
- Sonic Charge Synplant — https://soniccharge.com/synplant
- Clavia Nord Modular G2 Patch Mutator / MutaSynth (Palle Dahlstedt) — https://www.nordkeyboards.com/wt/documents/237/Nord%20Modular%20G2%20Mutator%20English%20User%20Manual%20v1.0%20Edition%20A.pdf
- Korg wavestate / opsix / modwave — https://www.korg.com/us/products/synthesizers/modwave/
- Arturia MicroFreak — https://www.arturia.com/products/hardware-synths/microfreak/details
- Elektron Digitakt / Syntakt — https://elektron.se/wp-content/uploads/2024/10/Syntakt-User-Manual_ENG_OS1.30_241016.pdf
- Waldorf Blofeld — https://waldorfmusic.com/
- MOD WIGGLER, "Randomize all parameters — Novation Summit" — https://www.modwiggler.com/forum/viewtopic.php?t=226021
- VCV Community, "Randomize: right click context menu" — https://community.vcvrack.com/t/randomize-right-click-context-menu/1492
- MilkDrop / projectM — http://wiki.winamp.com/wiki/MilkDrop_Unleashed_Guide
- Resolume — https://www.resolume.com/
- Artbreeder — https://www.artbreeder.com/
- Kate Compton, "So you want to build a generator…" — https://galaxykate0.tumblr.com/post/139774965871/so-you-want-to-build-a-generator
- Emily Short, "Bowls of Oatmeal and Text Generation" — https://emshort.blog/2016/09/21/bowls-of-oatmeal-and-text-generation/
- KVR Audio, "Synths with good randomize functions" — https://www.kvraudio.com/forum/viewtopic.php?t=318469
- KVR Audio, "Synths that can create random presets and/or randomise parameters" — https://www.kvraudio.com/forum/viewtopic.php?t=565834
- Loopy Pro forum, "Most musical synth randomizer" — https://forum.loopypro.com/discussion/52206/most-musical-synth-randomizer
- Gearspace, "Synths With Patch Randomization Algorithms" — https://gearspace.com/board/electronic-music-instruments-and-electronic-music-production/1272413-synths-patch-randomization-algorithms.html
- Elektronauts, "Randomizer ideas for digitone / digitakt / syntakt" — https://www.elektronauts.com/t/randomizer-ideas-for-digitone-digitakt-syntakt/172127
