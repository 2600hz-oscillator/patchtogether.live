# Test-infra remediation — sequenced plan (2026-06-27)

Derived from the adversarial roast (`test-infra-roast-2026-06-27.md`). Discipline:
**one wave = one PR (mostly), fire CI once per solid branch, never flood.** Each wave
is gated on the prior landing green. Workflows are used for the parallelizable
waves (independent tracks); single edits stay single PRs. "Respect wall-time +
stability" = no whole-suite local e2e, no piling concurrent CI runs, every change
either ≈0 CI delta or its wall-time delta is measured + flagged if >~2 min.

## WAVE 0 — Quick wins (IN FLIGHT: `feat/test-honesty-quickwins`)
Pure test/gate, ≈0 CI, no pixels/attest. Stops two gates from lying.
- ART md5-uniqueness guard + DELETE the ~13 stub-vs-itself `.f32` baselines (moog batch / polyhelm / pentemelodica / analog-vco).
- Exemption-cap RATCHET assertions (behavioral/emit lists `<=` today; STRICT_DOCS/STRICT_VRT `>=` today).
- filterErrors() narrowing was considered here but moved to Wave 1 (can surface latent red → needs a blast-radius survey first).

## WAVE 1 — Honesty gates that may surface latent red (one PR each, careful)
Run the affected lane locally, FIX the real failures it exposes (or tightly scope), land green.
- **filterErrors() narrowing**: stop swallowing blanket `Failed to load resource`; allowlist only known-noise (optional DOOM WAD). Survey which of the ~73 "no console errors" specs go red → fix the real 404'd worklet/shader/registry assets they were hiding.
- **WebGL basis fail-OPEN fix**: MilkdropCard (butterchurn) + any lib-mediated GL (three/regl/pixi imports) + `getContext('webgpu')` currently escape the attest basis. Make "card source for ANY domain:video module" an unconditional basis rule. One re-attest. (Do this BEFORE merging the milkdrop PR so milkdrop is actually covered.)

## WAVE 2 — Make the real gates actually gate (CI-config + targeted coverage)
- **Behavioral → blocking for its stable subset**: un-label-gate + `continue-on-error:false` for the rows proven stable; keep the rest informational. (Needs a stability survey of the behavioral rows first — workflow.)
- **Real output reads in e2e**: every spec whose TITLE claims "audio flows X→Y→OUTPUT" must read AudioOut (AnalyserNode RMS / spectral delta via the existing readScopeSnapshot), not just assert `console errors == []`. Demote "edge materialised" to the rare reasoned opt-out.
- **collab-nightly #868 (P0)**: shard / drop retries / cut the slow DOOM-WASM-boot specs so it finishes under the 90-min ceiling and REPORTS. Then a THIN real multi-context @collab smoke + a SwiftShader-tolerant deterministic-floor WebGL pass as REQUIRED PR jobs (so the doom/render gates execute on the merged SHA, not just a hash-verify of a hand-writable JSON).
- **Flake signal**: fail/alert when any test passes only on retry; begin replacing `waitForTimeout`-before-assert with `expect.poll` on the real condition + `networkidle`→a deterministic `__appReady` signal. (Incremental, woven in.)

## WAVE 3 — Coverage architecture (large, owner-gated; workflow w/ parallel tracks)
- **Linux VRT in CI + canvas-content diff for video** in a BLOCKING lane (the runner is already linux); drop the 26-card ceiling + the magenta-mask-everything; make vrt-meta require the platform CI actually runs.
- **DSP correctness**: extract per-sample worklet math into pure lib cores + unit-test numeric behavior; ratchet the worklet-entries-with-a-core-test metric (22/70 today). For Faust, render the actual compiled `.wasm` in ART (or relabel those as model unit tests).
- **Missing safety nets** (3 independent tracks → parallel workflow): (1) prior-version Y.Doc snapshot fixtures + load/round-trip vs real Hocuspocus+Postgres (#566/#812); (2) heap-budget soak lane — no synced ydoc writes during pure modulation frames + bounded `usedJSHeapSize`/edge-SVG count (#719 write-storm); (3) stored-XSS tests threading hostile labels/patches/URLs/user-GLSL through the real A→peer collab path + a CSP-presence assert.

## WAVE 4 — Attest treadmill relief (medium)
- Narrow both attest bases: hash only renderer/sync-relevant PINNED versions (not whole `package.json`) and only files contributing shader/GL bytes (not all of `lib/video/**`); `docs-hash-ignore` for doc-only edits. Kills owner-local re-attests on unrelated dep bumps / label typos.

## Added 2026-06-28 (from the milkdrop/backdraft attest campaign)
- **scope-video-out parallel flake → Wave 2 (flake signal).** `scope-video-out.spec.ts`'s
  2 tests flake under the parallel real-GPU attest: at the default `ceil(cpus/2)=5`
  workers they flake 2 (→ exceed MAX_FLAKY=1 → refuse, forcing a re-run); at
  `WEBGL_ATTEST_WORKERS=3` it's ≤1 (clean). The spec is an e2e file → NOT in the
  attest basis, so hardening its `waitForFunction` (longer/contention-scaled
  timeout, or `expect.poll` on the real pixel condition + a settle loop) is
  hash-free and lets the attest run clean at the full default-5. Concrete first
  instance of Wave 2's "replace waitForTimeout/bare waitForFunction with poll-on-real-condition."
- **Attest build-fail fast-detect → Wave 1 honesty add (cheap).** A missing local
  npm dep (vite `Failed to resolve import`) makes the app boot into an error
  overlay so EVERY heavy spec fails/times out — a 15+ min `passed=0` run that LOOKS
  like a slow/hung attest. `scripts/webgl-attest.ts` should probe the dev-server
  root for the vite error overlay (or a `__appReady` signal) BEFORE the heavy
  passes and abort loudly with the overlay text. Also documented in
  `.claude/skills/webgl-attest.md` (RULE 4 + the branch-switch node_modules-prune
  trap: a sibling-branch `npm install` prunes deps the attest branch needs).

## Explicitly discounted (roast honesty pass — NOT doing)
a11y-coverage framing (queued separately), "M5 is the narrowest renderer" (it's a real GPU = the point; just document scope), vitest singleFork (deliberate determinism), EXPECTED_NODE_TYPES blank-line cosmetics, "all e2e wall-time is waste" (integrated chain has real value).
