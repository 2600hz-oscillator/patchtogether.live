# Test-infra remediation — what is LEFT (from the 2026-06-27 sequenced plan)

Derived from the adversarial roast (`test-infra-roast-2026-06-27.md`). Discipline:
**one wave = one PR (mostly), fire CI once per solid branch, never flood.** Every
change is either ≈0 CI delta or its wall-time delta is measured and flagged if
>~2 min.

> **TRIAGE 2026-08-12.** Waves 0, 1 and 4 are DONE and their sections are deleted:
> #940 (ART md5 guard + stub-baseline deletion), the WebGL basis fail-OPEN fix
> (`packages/web/src/lib/video/webgl-attest-coverage.test.ts`), #946, and the
> attest-basis narrowing — which landed far better than planned as
> `scripts/attest-code-basis.ts` (hash CODE not bytes; the 79 `docs-hash-ignore`
> marker pairs are gone). The **exemption-cap ratchets** Wave 0 shipped were
> later DELETED repo-wide under the P0 "never hand-type a population count"
> directive (#1455 / #1458 / #1486) — do not rebuild them, and do not read any
> "ratchet the metric" phrasing below as live advice.

## STILL OPEN

### Make the real gates actually gate
- **`@collab` is still not required.** A dedicated non-sharded `collab` job now
  exists in `ci.yml` (single runner, `--workers=1`, against `vite preview`, with
  the DOOM specs opted back in), and `collab-nightly.yml` exists — but `collab`
  is **absent from the `ci` umbrella's `needs:`** (`ci.yml:2268`), so the per-PR
  multi-context lane is still informational. Root-cause the relay-contention /
  in-card-title timeout, verify it ran with `DATABASE_URL` (not vacuous), then
  arm it — or record in CLAUDE.md why it can't be.
- **`behavioral-smoke` is proven, not trusted.** The fast REQUIRED subset shipped
  (#986), but **#1318** found a member of that required subset passing on noise.
  A required row that can pass on noise is a decoration; audit the subset's rows
  against a real-output read.
- **Real output reads in e2e.** Every spec whose TITLE claims "audio flows
  X→Y→OUTPUT" must read AudioOut (AnalyserNode RMS / spectral delta via
  `readScopeSnapshot`), not just assert `console errors == []`. Demote "edge
  materialised" to the rare reasoned opt-out.
- **Flake signal.** Fail/alert when a test passes only on RETRY.
  `retries: process.env.CI ? 1 : 0` is unchanged (`e2e/playwright.config.ts:130`).
- **`waitForTimeout` has not come down.** 602 at authoring, **649 today** under
  `e2e/`. Replace `waitForTimeout`-before-assert with `expect.poll` on the real
  condition, and `networkidle` with a deterministic `__appReady` signal. (For
  anything renderer-dependent the answer is a FRAME count, not a budget — see
  CLAUDE.md.)

### Coverage architecture (large, owner-gated)
- **DSP correctness.** Extract per-sample worklet math into pure lib cores and
  unit-test numeric behaviour. Many `packages/dsp/src/lib/*-dsp.ts` pure cores now
  exist with tests, but there is no systematic sweep of which worklet entries have
  one. ⚠ Do **not** re-add the "22/70 with a core test" metric — express it as a
  named deny-by-default list or an unconditional assertion. For Faust, render the
  actual compiled `.wasm` in ART, or relabel those as model unit tests.
- **Three missing safety nets, all still un-built** (independent, parallelisable):
  1. Prior-version Y.Doc snapshot fixtures + load/round-trip against real
     Hocuspocus+Postgres (#566 / #812). No fixture corpus exists.
  2. Heap-budget soak lane — assert no synced ydoc writes during pure modulation
     frames, plus a bounded `usedJSHeapSize` / edge-SVG count (#719 write-storm).
     `usedJSHeapSize` appears only in three bespoke perf specs today.
  3. Stored-XSS tests threading hostile labels / patches / URLs / user-GLSL
     through the real A→peer collab path, plus a CSP-presence assert. Nothing in
     the tree matches.

### Attest ergonomics (small, cheap)
- **Attest build-fail fast-detect.** A missing local npm dep (vite
  `Failed to resolve import`) boots the app into an error overlay, so EVERY heavy
  spec fails or times out — a 15+ min `passed=0` run that LOOKS like a slow or
  hung attest. `scripts/webgl-attest.ts` should probe the dev-server root for the
  vite error overlay (or an `__appReady` signal) BEFORE the heavy passes and abort
  loudly with the overlay text. **Not built** — no overlay/`__appReady` probe
  exists in `scripts/`. Also documented in `.claude/skills/webgl-attest.md`
  (RULE 4 + the branch-switch node_modules-prune trap: a sibling-branch
  `npm install` prunes deps the attest branch needs).

## Premises that MOVED — do not execute as written
- ⚠ **The serialized `e2e-video` lane this plan assumes was DELETED 2026-06-20
  (#839).** `WEBGL_HEAVY_GLOBS` no longer *relocates* a spec — it **deletes its
  PR coverage outright**. See the banner in `e2e/webgl-heavy-globs.ts`. Anyone
  "pulling specs into the video lane" would silently remove coverage.
- ⚠ **`scope-video-out` parallel flake.** Under the parallel real-GPU attest at
  the default `ceil(cpus/2)=5` workers its 2 tests flaked 2× (→ exceeded
  `MAX_FLAKY=1` → refuse, forcing a re-run); at `WEBGL_ATTEST_WORKERS=3` it was
  ≤1. The spec is an e2e file → NOT in the attest basis, so hardening its
  `waitForFunction` is hash-free and lets the attest run clean at the default 5.
  (`WEBGL_ATTEST_WORKERS` still exists at `scripts/webgl-attest.ts:72`.)

## Explicitly discounted (roast honesty pass — NOT doing)
a11y-coverage framing (queued separately), "M5 is the narrowest renderer" (it's a
real GPU = the point; just document scope), vitest `singleFork` (deliberate
determinism), `EXPECTED_NODE_TYPES` blank-line cosmetics, "all e2e wall-time is
waste" (the integrated chain has real value).
