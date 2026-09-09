# ADR-016: Model the cause, and state every deliberate divergence

- Status: Accepted
- Date: 2026-09-08 (records decisions of 2026-06-27 through 2026-09-01)
- Deciders: project owner; this ADR documents the decisions
- Tags: video, dsp, modules, simulation, licensing-adjacent

## Context

Several modules imitate something that exists: a camera pointed at its own
monitor, a CRT feedback nest, an FPGA fabric, a commercial spectral plugin, a
rhythm game that reacts to music, three wavetables joined in space. Each time,
the same fork appeared — simulate the **mechanism**, or reach for a servo, a
threshold, or a faithful port of the reference.

The repo has evidence for both sides. Reaching for the shortcut produced two
documented failures: a module whose events were threshold-coupled to another
module's calibrated envelope was killed twice by that upstream gain changing,
and a "flat blend" stand-in for a volumetric field looked wrong in a way that no
parameter could fix. Modelling the mechanism produced constants that are
derivable and therefore defensible.

## Decision

**Where the cause is cheap to model and observable in the output, model the
cause. Where it is not, keep it as feel — and name the boundary. Where the
reference itself is wrong for us, diverge deliberately and write down why.**

**Model the cause:**

- **BACKDRAFT flicker** is a physical chain, not a wobble:
  emission × exposure × sensor storage × rolling shutter × sampling, with a
  saturating shoulder. Its constants fall out of that model —
  `BACKDRAFT_FLICKER_SHUTTER = 0.25` because 0.5 is exactly one period of 120 Hz
  flicker and would make that position perfectly dead, and because a real camera
  stops down when pointed at a bright screen; `BACKDRAFT_FLICKER_READOUT = 0.5`
  as mid-range CMOS. The model also explains why the feature is *needed*: with
  flicker off the composite is a monotone positive map, which has only
  fixed-point attractors — it decays or it pins white, and **a delay cannot make
  it oscillate**, because a delay only oscillates when the loop has a sign
  inversion or a level-dependent correction.
- **PURE TV** implements the bounded-screen map from the literature — a
  **Dirichlet-zero** boundary rather than a clamp — so the frame contains a
  strictly nested sequence of screens, each delimited by its own bezel band. The
  nesting is forced by the geometry, not tuned. In this mode the input is the
  room, not the picture.
- **VIDEOCUBE** builds a genuine 3-D scalar field over the three video surfaces
  and ray-marches it under an orbitable camera, sharing the **same field maths**
  as the audio CUBE oscillator (`packages/dsp/src/lib/cube-dsp.ts`), so the
  audio read is a slice of the same solid the picture shows. The v1 flat blend —
  which collapsed the depth axis to one value per pixel — was owner-rejected and
  deleted.
- **GIBRIBBON** analyses audio in-module: a pure fold over its own analyser
  bins produces four musical band levels plus a flux number, and a separate
  adaptive extractor judges "interesting" by measuring each band against its own
  rolling baseline. The fold is the ear; the extractor is the judgement. It is
  deliberately **not** coupled to another module's calibrated envelope — that
  coupling is what killed the game twice. Its judgement is anchored to **one
  clock** — the audio scheduler tick (`getSchedulerClock` / `SCHEDULER_TICK_MS`),
  not rAF — so the timing windows and the picture cannot disagree.

**Keep as feel, and say so:** the virtual FPGA models the **toolchain**
accurately around the GPU — synchronous register discipline, combinational-loop
rejection, a literal LUT truth table — and never simulates gates per pixel at
video resolution. The owner cut the floorplan viewer and, with it, the
critical-path analyser and the router whose only consumer it was: a net that can
never fail to route is not authentic, but the authentic version buys nothing a
viewer would see and would run on every fabric in the registry sweeps. A
fragment shader also cannot propagate a carry horizontally or scatter to an
arbitrary texel, so carry chains and write-addressable LUT RAM are named as the
explicit boundary rather than half-built.

**Diverge deliberately:** WARREN'S SPECTRUM ships the reference plugin's
behaviour with one clamp removed, so its declared SLICE range is reachable
across its whole travel — the plugin's own sibling engine honours the full range
with no ceiling, so the intent was never ambiguous, and the default sits under
the old clamp so the change is bit-identical there (proved: every ART baseline
for the module unchanged — `art/scenarios/warrensspectrum/profile.test.ts`). The
module states its absent features in its own header rather than implying parity.

**A rename gets a type alias ONLY when the replacement can keep the node's
cables and values; when it cannot, the old string is dropped visibly rather than
migrated silently — and it is never re-used.** `RETIRED_TYPE_ALIASES` maps the
retired type to the current one, and the per-alias diagnostic names the
*specific* failure a migrated node can still produce — here, that the
replacement analyses audio, so a migrated node with nothing patched into its
input is silent. The counter-case is in the same table: `warrenspectrum` (one
's') is **deliberately absent**, because 0 of its 43 ports and 0 of its 16
params exist on the mono spectral contract, so an alias would keep no cable and
no value. It takes the ordinary unknown-type drop path instead — a dropped node
is visibly absent and the user knows to rebuild; a silently-migrated one lies.
The same rule applies below the type: a param whose meaning changes keeps its
persisted id (GIBRIBBON's `autoplay` now means ATTRACT, relabelled in place)
because minting a clean id silently drops every saved value.

## Consequences

**Good:**

- Constants derived from a model can be defended, re-derived and argued with;
  constants tuned by eye can only be re-tuned.
- Two alternatives were **falsified** rather than merely rejected, and both
  would have looked reasonable in review: a spatial blur cannot damp the
  full-field mode it was proposed to fix, and an auto-exposure servo passes
  exactly the fast beats it was proposed to suppress. Recording a falsification
  is what stops it being re-proposed.
- Because the flicker knee makes the incremental response fall toward zero as a
  region approaches white, a gain modulation stops acting where the image is
  already hot — the beat reads as contour shimmer instead of a full-field flash.
  A bare gamma law is scale-free and would not do this. That is the kind of
  behaviour a model gives you and a fudge factor does not.
- Sharing one field between the audio and video sides of the same idea means a
  change to the maths cannot desynchronise the two.

**Bad / load-bearing:**

- **Modelling costs pins.** A physical model has ART fingerprints and VRT
  baselines attached to its constants; changing one is a re-attest, not an edit.
  Attribute every fingerprint move before re-pinning — a level move and a
  timbral move are different events, and re-pinning an unattributed one is what
  turns a real regression green.
- **The virtual FPGA's authenticity is bounded and one known defect is
  shipped:** the literal LUT tile collapses its output to monochrome, so the
  most "authentic" element currently black-and-whites the picture. The named fix
  (operating on bit-planes of the real image) is the item that would make
  accuracy serve the aesthetic; it is unbuilt, along with the serialised-but-
  unconsumed clock-divider configuration.
- Divergence is a promise to keep explaining: the deliberate ones are documented
  in-module, and interchange with the reference plugin's own file format remains
  an open question precisely because the parameter sets differ.
- Type-alias retirement carries a stated removal condition, not an open-ended
  grace period: the table's own rule is to drop it **two minor releases after
  ship** (`packages/web/src/lib/graph/persistence.ts`), by which point live
  patches have been re-saved under the canonical id and the drop path handles
  the stragglers. Dropping one earlier strands saved patches.
- **Game-asset sourcing is out of scope here, and one licensing claim has no
  durable home.** The owner's fair-use artistic-parody ruling covering
  GIBRIBBON's DOOM sprite reuse lives only in the `gibribbon.ts` /
  `gibribbon-engine.ts` headers; it is **not** recorded in ADR-007, and
  recording it is an owner-approval item. DOOM is excluded by name from this
  decision and from any sweep it motivates — nothing there moves without
  explicit owner approval.

## References

- `packages/web/src/lib/video/modules/backdraft.ts` — the flicker chain, the
  monotone-positive-map argument, the bounded-screen map, `*_FLICKER_*` and
  `*_TV_*` constants.
- `packages/web/src/lib/video/modules/videocube.ts`,
  `packages/dsp/src/lib/cube-dsp.ts` — the shared field and the ray-march.
- `packages/web/src/lib/video/modules/gibribbon-spectral.ts`,
  `gibribbon-engine.ts` — the in-module fold and the adaptive extractor;
  `gibribbon.ts` with `packages/web/src/lib/audio/scheduler-clock.ts` — the one
  clock the judgement is phase-anchored to, and the kept `autoplay` param id.
- `packages/web/src/lib/video/vfpga/`, `packages/web/src/lib/video/modules/
  vfpga-runner.ts` — the toolchain model and the main-thread render locus.
- `packages/web/src/lib/audio/modules/warrensspectrum.ts`,
  `packages/web/src/lib/graph/persistence.ts` (`RETIRED_TYPE_ALIASES`,
  `RETIRED_TYPE_ALIAS_NOTES`).
- ADR-007 — game-asset distribution. ADR-015 — where a module renders.
- `.claude/skills/renderer-tests` — VRT and baseline discipline for a change
  that moves pixels.
- Provenance: preserved in the `myrobots-preserved-2026-09` tag snapshot, as
  `plans/backdraft-flicker-research-2026-07-26.md`,
  `plans/backdraft-pure-tv-2026-07-27.md`,
  `plans/videocube-redesign-2026-07-20.md`,
  `plans/vfpga-hardware-accuracy-analysis-2026-06-27.md`,
  `plans/warrens-spectrum-2026-08-02.md` and `face-specs/gibribbon.html`
  (paths relative to the retired agent-evidence tree in that snapshot, not to
  the worktree).
