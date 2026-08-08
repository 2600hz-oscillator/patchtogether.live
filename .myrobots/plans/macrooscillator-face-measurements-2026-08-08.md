# macrooscillator — face measurements, RECOVERED from a destroyed worktree

**Status: MEASUREMENTS ONLY. The implementation is gone.** 2026-08-08.

⚠ **How this file exists.** An agent had a substantially complete, green
macrooscillator face build in an isolation worktree — 32/32 unit, all 13 e2e
rows, typecheck clean — **uncommitted and unpushed**. I removed the worktree
with `git worktree remove --force` while triaging unauthorized agents, without
checking whether it was dirty. `task worktree:guard` exists to refuse exactly
that, and `--force` skips it. The code is unrecoverable; these numbers are the
part worth preserving, so a re-run starts from measurement rather than
re-deriving it.

**The lesson, for whoever reads this next: never `--force` a worktree removal.
Run `task worktree:clean`, which removes only checkouts that are clean AND
pushed. If it refuses, that refusal is the point.**

---

## 1. Measured dead / clamped controls

Bit-exact against the def's own pure-math mirror.

| finding | measurement |
|---|---|
| **WAVETABLE MORPH** | bit-identical `0.000 → 0.500 INCLUSIVE` (`maxAbsDiff 0.000e+0`); first change at 0.5001. **Half the fader does nothing.** |
| **GRANULAR MORPH** | a **3-position switch** — boundaries at 0.33 / 0.66, nothing in between. **Not in the spec; nothing in the repo says so.** |
| **MODAL TIMBRE** | a level control running **BACKWARDS**: Q 5→200 gives −69.3 → −86.0 dBFS. MODAL is also **exactly 0.0 for 250 ms** (first non-zero sample 11999). |
| **stepped HARMONICS** | only **FOUR** engines, not five: FM 2OP 8, CHORD 8, MODAL 4, SPEECH 6, all at `k/N`. **WAVETABLE is a BLEND** (101 distinct renders over a 100-step sweep) — the spec's "quantiser in five engines" is **wrong**. |
| **struck engines** | STRING / KICK / SNARE / HIHAT initialise excitation to 0 → **silent forever without a trigger**. FM 6OP decays to −108 dBFS in 1 s and never restarts. |
| **level spread** | OUT RMS spans **76.1 dB** across engines at identical macros (FM 2OP −4.9 dBFS, MODAL −81.0 dBFS at LEVEL 0.8). |
| **AUX** | at LEVEL 0: OUT peak 0.0000 / AUX peak 1.0000 on **8 of 14** engines. KICK's AUX ≡ OUT at CLICK 0 (6e-8). GRANULAR's AUX tracks the **spawn rate** (0 Hz at h=0, 199 Hz at h=1), not the note. |

⚠ Several of these are **defects, not face-layout facts** — WAVETABLE MORPH's
dead half and MODAL TIMBRE's inverted sense in particular. Decide whether they
are fixed or documented before a face presents them as working controls.

---

## 2. TWO INSTRUMENT BUGS — both would have shipped a false green

**(a) An 85 ms liveness window reported three live macros as bit-exactly dead.**
A 4096-sample window declared all three MODAL macros dead. They are not — the
window was **shorter than MODAL's own 250 ms impulse period**. Fixed at 15360
samples (320 ms), with the false reading pinned as a permanent negative-control
leg. Textbook "the instrument was blind to the dimension under test".

**(b) ⚠ THE COMPACT VRT TILE CANNOT BASELINE — and it is a SHARED PLATFORM GAP,
not a macrooscillator problem.** macrooscillator free-runs, so its live `scope`
glyph never reaches two consecutive identical captures. **This is the exact
analogVco blocker.**

Root cause: **`bootWithFace` in `e2e/vrt/_shell-faces.ts` never freezes the
AudioContext**, and every face shipped so far is a struck or silent voice, so
nobody hit it. The fix belongs in that shared boot — a `freezeAudioContext`
that **asserts it landed** — not per-module, and it must be verified
byte-identical on the other 21 faces first.

**Whoever picks up analogVco (#1416) needs this.** Two faces are already blocked
on it; it is a prerequisite for any free-running voice getting a face.

---

## 3. Two real layout defects the gates caught

- A strike button on its own row overflowed the 1u card by **30.2 CSS px**. The
  card has ~8 px of slack — the button must **share the engine-name row**.
- The dock sidebar overflowed **78 CSS px horizontally** (1298 vs 1220) on long
  flow notes and axis nouns. Sidebar content column is **258 px**; keep readout
  values under **~26 characters**.

---

## 4. Spec staleness — correct these before building from the spec

- **§2.3's patched-sensing strike gate is UNBUILDABLE as written.** The audition
  permanently connects a `ConstantSource` to the `trig` worklet input, so
  `inputs[1]` is never zero-length and presence detection cannot work — the gate
  would insert itself on every saved rack. Scoped out as a DSP rewrite, also per
  INDEX rule 5 ("never fold a DSP change into a face wave").
- **§8.1's widened `FaceReadoutValue` did NOT land** — still params-only.
- **§9's "faces-parity cannot fail on a dead button" is FIXED** —
  `ShellActionCell.probe` is now required, so no bespoke audition spec is needed.
- **§6's `engine-roster` custom sidebar panel is unnecessary** — the generic
  `presets` block does it better, and INDEX rule 3 forbids bespoke sidebars.
- **There is no platform `inert` field.** Inertness is expressed through derived
  readouts.

---

## 5. What passed, so a re-run knows the target

`macrooscillator-face-model.test.ts` 32/32 in 276 ms with two-legged permanent
negative controls · `module-face-lint` · `shell-cells` · `module-docs-lint` ·
`contract-lock` · `push-card` (94) · `card-range-source` (25) · `vrt-meta` (24) ·
`test-ledger` · `vrt-gallery` · `macseq` · `modules-card-map` · `typecheck` 0
errors · **all 13 macrooscillator e2e rows in 56.7 s** including `faces-parity`
(every cell driven, audition + panel probes), `per-module-per-port` ×3,
`behavioral`, and a 14-engine overflow sweep (1.7 s).

**Estimated CI delta ≈ +70 s**, under the 2-minute bar: +4 VRT scenes on the
informational lane (~+25 s, non-gating), +1 `faces-parity` row at 11 cells
(~+10 s on one shard), +1 overflow test (measured 1.7 s), +32 unit tests
(measured 276 ms).

---

## 6. Owner decision still open on this module

**Should the five envelope-carrying engines (FM6 / KICK / SNARE / HIHAT /
STRING) DRONE when unpatched?** Owner answered **NO** on 2026-08-08. Recorded
here because the spec's §2.6 still frames it as open.
