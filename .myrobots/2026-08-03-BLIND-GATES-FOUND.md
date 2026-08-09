# 2026-08-03 — BLIND GATES FOUND

**The unifying finding of the session.** Almost every defect fixed today had been
sitting behind a gate that was **green while measuring nothing**. None announced
itself; each produced a confident, plausible, false "all clear".

The recurring mechanism, stated once: **a filter applied before the check silently
redefines the check's subject.** The gate then reports honestly about a population
that is not the one anybody cares about.

CLAUDE.md's "VALIDATE THE INSTRUMENT" section and `.claude/skills/blind-gates` carry
the standing treatment. This file is the day's evidence.

> ## STATUS (2026-08-09) — the §1 "STILL OPEN" rows, re-verified against `main`
>
> | §1 row | 2026-08-09 |
> |---|---|
> | mono-normal gate 30 % blind ("STILL OPEN — see SESSION-STATE §6") | **FIXED — #1351** (2026-08-04). The real blindness was **46 %** (13 normals, 6 missed) — SESSION-STATE §6b carries the corrected figures and the residual audit (0 unclassified). |
> | `stereo-mono-normal.spec.ts` SUTS omits stereovca ("STILL OPEN") | **CLOSED** — stereovca is now a SUT row (`e2e/tests/stereo-mono-normal.spec.ts:126`, with the `offset: 1` ring-mod caveat documented inline). |
> | dock VRT capture cuts faces at the fold ("STILL OPEN" on 5 modules) | **FIXED — #1413** (2026-08-08): "the dock baseline was 425 px of a 930 px faceplate — nine of them were". |
> | VRT `FACES` roster hand-maintained ("STILL OPEN") | **Still hand-maintained** (`e2e/vrt/_shell-faces.ts` — its own comment says so), but verified in sync today: 24 roster entries = 24 `STRICT_FACES` modules. The structural hole (no parity assertion between the two lists) remains open. |
> | §2 `timelorde-clock-core.test.ts` pins the wrong divider phase | **FIXED — #1347** (2026-08-04, the swing + divider-phase PR). |
>
> The other §2/§3 rows (wavesculpt's two tests, spectrograph's darwin baseline,
> `clouds.test.ts` density) were **not re-verified** in this pass — do not read
> silence here as "fixed".

---

## 1. GATES THAT COULD NOT SEE THEIR OWN SUBJECT

| gate | the filter | saw | could not see |
|---|---|---|---|
| `mono-normal-not-defeated.test.ts:83` | regex matching one expression on one line | **7** normals | **3 of 10 (30 %)** — both stereovca's, one `samsloop-tap.ts:67`. ⚠ **SHIPPED TODAY IN #1343. STILL OPEN — see SESSION-STATE §6** |
| behavioral coverage sweep | control-vs-perturbed scatter larger than the floor | — | **24 of 26 snaredrum ports PASS WITH NOTHING WIRED.** The voice's own `cent = 5292 ± 5026 Hz` scatter clears four of thirteen floors unaided. Filed as **#1337** |
| the emit-budget ratchet | a private accumulator reading 2 of 5 skip reasons | 1 of 180 tests | pinned itself to one of the **116 skipped** — the 1020 s figure I escalated was about a `test.fixme`-d test that has never run |
| `EXEMPT_OUTPUT_EMIT_MODULES` / `EXEMPT_OUTPUT_EMIT` | a bare count | 43 / 65 pinned | **actual 40 / 63** — five slots of silent pre-authorisation. Fixed in #1324 |
| VRT `FACES` roster (`workflow-shell-faces.spec.ts:43-77`) | hand-maintained list | listed faces | **a promoted module silently gets NO VRT scene.** Every other face gate is registry-driven. **STILL OPEN** |
| `stereo-mono-normal.spec.ts` SUTS roster | hand-maintained list | — | **omits stereovca** — nothing in any lane can see its right channel. **STILL OPEN** |
| dock VRT capture | `max-height: min(60vh, 680px)` | the top of the pane | **on sixstrum, dx7, kickdrum, snaredrum, drummergirl the bands sit BELOW THE FOLD** — baselines stayed pixel-identical while layout changed completely. **STILL OPEN** |
| `vrt-update.yml`'s `revalidate` | `needs: [linux, darwin]`, no `if: always()` | both-platform runs only | **the documented close+reopen re-validation NEVER ran for single-platform dispatch — the recommended usage.** Every single-platform baseline to date merged unvalidated. Fixed in #1333 |
| attest pre-flight (`preflightSolo`, duplicated in `grand-` and `webgl-attest`) | **one `ps` sample** | one instant | a co-tenant oscillating **3.5 %→87 % on a ~4 s period** reads quiet or busy depending purely on when you look. **45 samples: 25 over threshold, max 87.1 %.** Filed as **#1331** |
| `task dsp:ensure` | `.dsp-srchash` over INPUTS | source changes | **never checks the OUTPUTS exist** — a partial dist reports "current" forever. Filed as **#1326** |

---

## 2. TESTS BUILT AROUND THE DEFECT

Worse than a blind gate: a test that **pins the broken behaviour as correct**, so
fixing the bug turns CI red.

- **`wavesculpt.test.ts:218-224`** documents the dead BLUE oscillator and asserts only
  **"≥3 of 4 walls audible."**
- **`wavesculpt.test.ts:276-279`** asserts a rotation L1 of 0.129 while the prose beside
  it says "audio is rotation-invariant" — **a passing test contradicting its own docs.**
- **`stereo-autowire.spec.ts:143-157`** uses cofefve and asserts the **ABSENCE** of the
  edge that would have fixed OUT-R silence, citing the false comment as justification.
- **`timelorde-clock-core.test.ts:94-96`** pins the wrong divider phase (a /4 landing on
  beat 4).
- **spectrograph's darwin VRT baseline** pins a two-trace image as correct when the
  fixture plants three.
- **`clouds.test.ts:172-186`** only compares DENSITY 0 vs 1 — invisible to a knob whose
  midpoint is the loudest point.

---

## 3. UNSOUND, NOT MERELY FLAKY

Green runs that were green **on noise**.

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
  2561 passing tests sit at ≥70 % of budget**; the one that fired ranked only sixth.

---

## 4. THE THREE INVERSIONS THAT ACTUALLY FIX THIS CLASS

Applied repeatedly today; they work.

1. **Deny by default, with a NAMED exemption per instance** — the exact
   `(file, key)` / `(module, port)` / `(card, param, field)` triple. Never a filename,
   never a bare count. Two concurrent PRs then collide *textually*, which is what
   `pr:conflict-sweep` can see.
2. **Anchor to the ARTIFACT, not the list.** An entry naming something that no longer
   exists is RED. A stale exemption is one nobody is watching.
3. **Ratchet in BOTH directions** — `actual <= CEILING` **and** `CEILING - actual === 0`.
   A ceiling can only trip by growing; a drain that forgets to lower it passes in total
   silence and the slack pre-authorises the next regression.

Plus, learned the hard way today:

4. **Negative-control the gate, not just the code — and feed it EVERY SPELLING.** The
   mono-normal gate had negative controls and still shipped 30 % blind, because they
   only ever fed it the shape it could already see.
5. **Prefer a PERMANENT per-run control leg** over a one-time authoring check. Several
   gates now carry a leg that fails if the detector stops detecting.
6. **State the gate's scope INSIDE the gate.** An unstated scope reads as full coverage.

---

## 5. AND THE META-TELL

> **"The result is genuinely different here" and "the instrument reads differently here"
> look identical from the output alone.**

Both were live today, in both directions:

- **The observation-window gate** failed because the *instrument* read differently under
  load (its Playwright round-trip was 73 % of the measured window on the slow arm).
- **The score tied-gate** failed because the *result* was genuinely different — an
  ordering race whose loss is permanent, where no timeout budget could ever have helped.

They need opposite fixes. Establish which before acting.
