---
name: testing-conventions
description: How we structure tests. Multi-layer (unit / ART / VRT / E2E), shift-left from day 1, regression test pairs every fix, no mocked databases.
---

# Testing conventions

## Philosophy: shift-left, every layer

This codebase has had multi-layer testing from day 1. The principle:
each kind of bug is cheapest to catch at the lowest layer that can see it.

| Layer | What it catches | Cost to run |
|-------|-----------------|-------------|
| Typecheck | Type errors, broken refactors | sec |
| Unit | Logic in pure functions, store wiring, helper math | sec |
| ART (audio regression) | DSP output drift (buffer-level diff vs baseline) | sec |
| VRT (visual regression) | UI pixel drift per module card | min |
| E2E | User flows: spawn, patch, drag, transport | many min |
| Live smoke | Post-deploy sanity, real environment | min |

Don't skip layers. A change to a knob's range should add a unit test (range
math), update an ART baseline (if it affects DSP output), update a VRT
baseline (if it affects the card), and may need a new E2E (if it changes
interaction).

## New/changed tests must prove non-flaky (3× locally) before an MR

A green local run proves pass/fail; it does **not** prove **stability**. Any test
you add or seriously change passes **3× in a row locally** (scoped to that test —
not the whole suite) before it goes to CI. Use `REPEAT=3` on the `*:one` targets
(`REPEAT=3 task e2e:one -- my-spec`); it bails on the first failing iteration so a
flake can't hide behind a later green run. A flake that only reproduces under CI
load (e.g. a `@collab` relay-contention timeout) is still root-caused, never
re-run away. See the `running-tests` skill for the commands and
`feedback_no_flake_tolerance` for the discipline.

## Always pair a fix with a regression test

The user has called this out explicitly: every bug fix gets a test that
would have caught the bug. Don't fix-and-run.

If the bug is hard to write a test for (e.g., a race condition in CRDT sync,
or a GL state leak), at minimum write a comment explaining why no test exists
and what would have to change to add one.

## Never mock the database (or anything that has a real cheap test)

The user has been burned by mocked-test-passes-prod-fails. Default to hitting
the real thing in integration tests:
- Real Postgres (via Neon) — use the HTTP `neon` template tag, NOT the `pg`
  package or Neon's WebSocket Pool (they fail from CF Workers; see
  `cf-workers-pg-blocker` memory).
- Real AudioContext — Playwright tests instantiate one; don't stub.
- Real Y.Doc — multiplayer behavior under test is the actual sync, not a fake.

## Test before asking the user to verify

When you ship a feature, automate the verification you'd otherwise ask the
user to do. Don't outsource a check. If you can capture a Playwright
screenshot, do that instead of "please confirm it looks right."

## VRT failures: examine, don't rubber-stamp

See the `vrt-failures` skill. Short version: every VRT failure is either an
**expected** visual change (this PR meant to alter that region) or
**unexpected** (regression). Open the actual diff PNG and classify. If
unsure, ask the user — never blanket-recapture.

## Determinism

The harness is intentionally deterministic where possible:
- Playwright VRT baselines are ONE set, authored by linux CI — the platform
  dimension was removed 2026-08-10 (#1458) because CI gates on linux and a
  darwin-only baseline gave zero protection while counting as covered. A
  module whose render is non-deterministic (animated 3D, CRT feedback) opts out
  by NAME via `EXEMPT_FROM_VRT` + `ALLOWED_PERMANENT_EXEMPT` in
  `e2e/vrt/vrt-exemptions.ts`.
- ART baselines are float-precision `.f32` + SHA. Any divergence is an
  intentional output change.
- Unit tests use seeded RNG; never `Math.random()` in a test.

## What lives where

- `packages/<workspace>/src/**/*.test.ts` — unit (Vitest).
- `packages/art/scenarios/` — ART (Vitest).
- `e2e/tests/*.spec.ts` — E2E (Playwright).
- `e2e/vrt/*.spec.ts` + `e2e/vrt/__screenshots__/` — VRT (Playwright + LFS-tracked PNGs).

## Test naming

- `<thing> <does verb>` reads like a sentence. "sequencer advances on gate
  rising edge" not "gate rising edge advances sequencer".
- E2E test names appear in Playwright reports — keep them short and specific.

## Test data: stub at boundaries, not deep

If a test needs a saved-group payload, hit the real `/api/saved-groups` route
with a test fixture. Don't mock the fetcher inside the component — that's
deep stubbing that drifts. Boundary-level stubs (Playwright `page.route`,
MSW) are fine; deep stubs are not.

---

## Moved here from CLAUDE.md (2026-08-12, #1493)

The RULE stays in CLAUDE.md; the measured evidence lives here so the numbers
exist in exactly one place.


## ART baselines and the fingerprint manifest are ONE truth — re-pin BOTH

`art/baselines/**/*.f32` (+ `.sha`) and
`packages/web/src/lib/art/fingerprints.generated.json` are two artifacts of the
same truth. Re-pinning a baseline without re-pinning the manifest leaves the
manifest stale — which is exactly what #1174 did to `delay/audio` (an
owner-approved equal-power dry/wet fix, +3.01 dB): CI stayed green and the gate
went red only on fresh LOCAL checkouts.

- **Use `flox activate -- task art:update`.** It now chains
  `art:fingerprints:accept`, so the manifest cannot be forgotten. If you re-pin
  a baseline by any other route, run `task art:fingerprints:accept` yourself.
- **REVIEW the manifest diff entry by entry** — it is the accept-loop, same as
  `docs:accept`. The diff tells you what kind of change you made: a
  **labels-only** move (`peakDb`/`rmsDb`) is a pure LEVEL change, while a
  **spectrum/features** move is a TIMBRAL change. A uniform +3.01 dB on both
  peak and RMS with a byte-identical spectrum is the signature of a ×√2 scalar
  gain (e.g. linear→equal-power at mix 0.5). **Any entry you cannot attribute to
  a known intentional change is a real audio regression — stop, do not re-pin.**
- Every entry pins a `sourceSha256` (the sha256 of the `.f32` it was computed
  from, which equals the file's git-LFS oid). `fingerprints.consistency.test.ts`
  check (d) verifies it on EVERY lane — it needs no python, numpy or LFS, so it
  catches baseline↔manifest drift even on an `lfs: false` checkout.

**A gate that cannot fail on CI is decoration.** The byte-exact drift gate needs
materialized LFS bytes + numpy, so it runs in the ci.yml **`art`** job (the only
lane with the real `.f32` bytes) under `ART_FINGERPRINTS_REQUIRED=1`, which makes
it FAIL rather than skip-pass if that environment ever loses those inputs. When
you add a probe-and-skip test, ask where it can actually run — and give it a
loud-skip env flag in the lane that promises to run it (the
`rackspaces-capacity.test.ts` "refusing to skip-pass" precedent).

