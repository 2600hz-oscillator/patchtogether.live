# Test Reconciliation — changelog

A dated, per-test-block tally of **total** tests and **disabled** tests across
the repo. The goal of this report is simple: **watch the disabled count fall
over time.** Each entry is a snapshot; the trend across entries is the signal.

It is published to GitHub Pages alongside the VRT gallery (one Pages site per
repo). The live page recomputes the *current* counts at deploy time from the
working tree, so the latest row is always honest; the dated rows below are the
committed history.

## What "disabled" means here

This report is deliberately precise about what counts as disabled, so the number
is actionable rather than alarming:

- **Disabled** = a *static, declaration-level* disable that removes a test from
  the run permanently — `test.skip('name', …)`, `it.skip(…)`,
  `test.fixme('name', …)`, `describe.skip`/`describe.fixme`, `test.todo`. These
  are the backlog: tests someone turned off and owes a fix or a deletion.
- **NOT disabled — runtime guards.** `test.skip(cond, 'reason')` /
  `test.skip(true, 'reason')` *inside a test body* are environment gates (is the
  DB / WAD / ROM / relay present?), not a test the author switched off. They run
  whenever their precondition is met. Counting them as "disabled" would
  permanently inflate the number with healthy CI hygiene.
- **NOT disabled — parametrized exemptions.** The registry-driven sweeps
  (`per-module-per-port`, `behavioral`, `per-module`) emit loop-generated
  `test.fixme(\`${title} [SKIPPED: …]\`)` placeholders for exempt module/ports.
  Those are accounted for in the **parametrized** blocks' enrolment numbers
  (e.g. `behavioral`'s module-exempt count), not double-counted in the raw e2e
  block.
- **`.only` is an ALERT**, not just a disable — `forbidOnly: true` hard-fails CI,
  so a focused test would break the build. The report flags any `.only` location.

## Blocks

| block | what it counts | kind |
|---|---|---|
| **unit** | `test()`/`it()` in `packages/**/*.test.ts` (vitest) | raw |
| **e2e** | `test()` in `e2e/tests/**/*.spec.ts` (playwright) | raw |
| **art** | `it()`/`test()` in `art/scenarios/**/*.test.ts` | raw |
| **vrt** | enrolled module cards + bespoke scene snapshots | parametrized |
| **behavioral** | enrolled modules in the behavioral input sweep | parametrized |
| **@collab** | `test()` in files tagged `@collab` (multi-user/relay) | raw (e2e subset) |

Parametrized blocks don't have one literal `test()` per unit — the spec does
`for (const mod of REGISTRY) test(…)`. We count the **enrolled units** (registry
modules minus the spec's exemption set), computed from the same inputs the spec
reads (`e2e/.generated/registry-manifest.json` + the exemption files).

## How to add an entry

Run the counter and append today's snapshot (the date comes from the last commit
date, never `Date.now()`, so it's reproducible):

```sh
flox activate -- task test:recon            # human table
flox activate -- task test:recon -- --json  # machine JSON (blocks array)
```

Then add a new dated object to `changelog.json` (append-only; do not edit past
entries). The Pages build renders both the committed history and a fresh live
row.

---

## Entries

### 2026-06-07 — behavioral reconciliation #1 (moog984 re-enabled)

First PR of the behavioral reconciliation leg (driving the behavioral
disabled count down one PR at a time). **behavioral disabled 64 → 63.**

| block | kind | total | disabled | %disabled |
|---|---|---:|---:|---:|
| unit | raw | 5963 | 2 | 0.0% |
| e2e | raw | 903 | 1 | 0.1% |
| art | raw | 457 | 0 | 0.0% |
| vrt | parametrized | 150 | 0 | 0.0% |
| behavioral | parametrized | 93 | 63 | 67.7% |
| @collab | raw (e2e subset) | 108 | 0 | 0.0% |

What changed:
- **Re-enabled `moog984`** (4×4 matrix mixer) in the behavioral input sweep.
  The whole-module exemption claimed the output was "silent until an upstream
  audio source feeds the channels", but the real cause was that all 16
  cross-points (`m11..m44`) default to **0** — the *identical* default-0-levels
  passive-mixer class as `attenumix` / `veils` / `videoMixer`, which are NOT
  exempt precisely because they carry a `BEHAVIORAL_PARAMS` boost opening their
  gating knobs.
- The fix is one `BEHAVIORAL_PARAMS.moog984 = { m11:1, m21:1, m31:1, m41:1 }`
  entry (open column 1, the observed `out1`). Driving any of `in1..in4` with the
  harness's noise source now reaches `out1`. All 4 inputs are real-coverage
  passes with a large, stable margin (Δμrms ≈ 0.18, ~18× the 0.01 floor),
  verified 3× locally with no flakes.

The other Moog routers (993/961/911a/960) stay exempt — they need per-port
exemptions + output-bus reasoning (gate-typed/independent buses, clock-driven
sequencer), the natural NEXT batch.

### 2026-06-07 — seed

First snapshot (test-stability restoration program, Area 1).

| block | kind | total | disabled | %disabled |
|---|---|---:|---:|---:|
| unit | raw | 5934 | 2 | 0.0% |
| e2e | raw | 896 | 1 | 0.1% |
| art | raw | 457 | 0 | 0.0% |
| vrt | parametrized | 150 | 0 | 0.0% |
| behavioral | parametrized | 92 | 64 | 69.6% |
| @collab | raw (e2e subset) | 108 | 0 | 0.0% |

Notes:
- `unit` disabled = 2 `describe.skip` blocks.
- `e2e` disabled = 1 static `test.fixme` (`patch-menu-ux.spec.ts:84`, the
  drag-threshold case). 49 loop-generated cases are counted in the parametrized
  blocks instead.
- `behavioral` 64/92 module-exempt is the known harness limitation — most
  video / sequencer / game modules can't be driven by the audio behavioral
  harness; tracked here so the ratio is visible, not hidden.
- No `.only` (focused) tests — good (`forbidOnly: true` would hard-fail CI).
