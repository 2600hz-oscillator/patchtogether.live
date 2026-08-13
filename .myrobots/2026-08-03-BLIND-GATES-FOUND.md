# 2026-08-03 — BLIND GATES FOUND

**The unifying finding of the session.** Almost every defect fixed that day had been
sitting behind a gate that was **green while measuring nothing**. None announced
itself; each produced a confident, plausible, false "all clear".

The recurring mechanism, stated once: **a filter applied before the check silently
redefines the check's subject.** The gate then reports honestly about a population
that is not the one anybody cares about.

> **2026-08-12 janitorial sweep.** The generalised lessons that used to close this
> file (§4 "the three inversions", §5 "the meta-tell") were DELETED: both are
> carried verbatim in CLAUDE.md and `.claude/skills/blind-gates`, and one of them
> had gone actively WRONG — old inversion 3 said *"ratchet in BOTH directions,
> `actual <= CEILING` and `CEILING - actual === 0`"*, which the 2026-08-10 owner
> directive reverses outright ("never hand-type a population count"). Keeping a
> superseded rule next to two live ones is how it gets copied. The §1 table is
> reduced to the rows that are still open; the fixed rows are named in the PRs
> that fixed them.

---

## 1. GATES THAT COULD NOT SEE THEIR OWN SUBJECT — what is STILL OPEN

Nine of the eleven original rows are closed (`mono-normal` blindness → #1351,
which measured the real figure at **46 %**, 13 normals / 6 missed, not the 30 %
first reported; `stereo-mono-normal` SUTS → stereovca is now a row; the dock VRT
fold → #1413; the `FACES` roster parity → now asserted both directions at
`e2e/vrt/workflow-shell-faces.spec.ts:282-320`; the emit-budget and
`EXEMPT_OUTPUT_EMIT` counts → #1324 and then the ratchet purge; `vrt-update`'s
`revalidate` → #1333; `timelorde-clock-core` phase → #1347).

| gate | the filter | could not see | state |
|---|---|---|---|
| behavioral coverage sweep | control-vs-perturbed scatter larger than the floor | **24 of 26 snaredrum ports PASS WITH NOTHING WIRED** — the voice's own `cent = 5292 ± 5026 Hz` scatter clears four of thirteen floors unaided | **#1337, open** |
| attest pre-flight (`preflightSolo`, duplicated in `grand-` and `webgl-attest`) | **one `ps` sample** | a co-tenant oscillating **3.5 %→87 % on a ~4 s period** reads quiet or busy depending purely on when you look. **45 samples: 25 over threshold, max 87.1 %** | **#1331, open** |
| `task dsp:ensure` | `.dsp-srchash` over INPUTS | **never checks the OUTPUTS exist** — a partial dist reports "current" forever | **#1326, open** |

---

## 2. TESTS BUILT AROUND THE DEFECT

Worse than a blind gate: a test that **pins the broken behaviour as correct**, so
fixing the bug turns CI red. Re-checked 2026-08-12:

- **STILL THERE — `wavesculpt.test.ts:218-231`** asserts only **"≥3 of 4 walls
  audible"**, with the BLUE (+Z) wall's gain of exactly 0 written into the
  comment as expected. That is the same silent voice the wavesculpt face spec
  calls out; the face that would have surfaced it was reverted (#1476), so
  nothing has forced the question.
- **STILL THERE — `clouds.test.ts:125-139`** compares DENSITY 0 vs 1 only, and is
  therefore blind to any non-monotonicity in between. (The sibling defect on
  SIZE — the top 19.5 % bit-identical to the maximum — was found by hand and
  fixed in #1456, not by this test.)
- **FIXED — `wavesculpt.test.ts` rotation prose.** The "audio is
  rotation-invariant" sentence beside a passing L1 = 0.129 assertion is gone; the
  test now states the per-axis gain deltas and asserts each axis re-mixes.
- **FIXED — `stereo-autowire.spec.ts`.** It no longer asserts the ABSENCE of the
  cofefve edge; the sibling is patched and the spec's payload is "cofefve's OUT R
  must make sound" (`e2e/tests/stereo-autowire.spec.ts:25`, `:179`).
- **FIXED — `timelorde-clock-core.test.ts`** divider phase (#1347).
- **UNVERIFIED — spectrograph's baseline** pinned a two-trace image where the
  fixture plants three. The darwin baseline named here no longer exists (#1458
  collapsed the platform dimension); whether the surviving single baseline still
  shows two traces was not re-checked.

---

## 3. UNSOUND, NOT MERELY FLAKY

Green runs that were green **on noise**. Kept for the measured numbers.

- **resofilter's behavioral row**: eight consecutive greens where a *different* metric
  carried each pass by a hair. Root cause: BUGGLES.smooth is a ±0.15 V random walk
  against a linear 0..1 param — **the stimulus was ~7 % of the declared range.** After
  the fix, worst-pair separation went 1.7× → **10.6×** the floor. Six of thirteen OR-ed
  terms had control-vs-control scatter larger than their own floor.
- **The frames-vs-milliseconds gate (#1325)**: `fast − slow ≥ 5` required the free arm
  above ~76 fps, while the file's own header documented rates down to **33.9 fps** —
  a separation of *minus four*. Never satisfiable across the range already measured in
  that file; it passed only where the probe page happened to hit 120 fps.
- **The unpatch test (#1341)**: not unsound — the test was RIGHT and the budget was
  wrong. Its final assertion passed at **30.77 s** against a 30.00 s ceiling. **27 of
  2561 passing tests sat at ≥70 % of budget**; the one that fired ranked only sixth.
