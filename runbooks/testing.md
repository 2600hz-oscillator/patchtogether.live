# Testing

There are four test layers plus two specialized lanes. All run through Flox.

| Layer | Tool | What it proves | Task |
| --- | --- | --- | --- |
| **Unit** | Vitest | pure data + Svelte `$state` logic | `task test` |
| **E2E** | Playwright | browser flows, per-port I/O sweeps | `task e2e` |
| **VRT** | Playwright screenshots | per-card visual regression | `task vrt` / `task vrt:strict` |
| **ART** | Vitest + `node-web-audio-api` | offline audio render fingerprints | `task art` |
| **behavioral** | Playwright | audio fingerprint delta CONTROL→PATCHED | `behavioral-smoke` (7-module subset) GATES; full sweep informational |
| **collab** | Playwright (`@collab`) | multi-user Yjs sync | dedicated CI lane (informational) |

## Running everything

```sh
flox activate -- task test     # unit/integration (dsp + server + web + scripts) + emit registry manifest
flox activate -- task art      # full ART suite (offline audio render)
flox activate -- task e2e      # full E2E (sharded 8–10× in CI, 1 retry)
flox activate -- task vrt      # full VRT sweep (informational lane — canvas-heavy specs may flake)
flox activate -- task vrt:strict   # deterministic VRT subset (this is the REQUIRED gate)
flox activate -- task ci       # full PR-gate chain: typecheck → test → art → e2e → vrt:strict
flox activate -- task typecheck    # svelte-check across all workspaces
```

**What actually gates a PR** (branch ruleset 16042163 → 2 required contexts: the
`ci` umbrella + `vrt-strict`). The umbrella fails if ANY of these is not green:
`actionlint, typecheck, unit, dsp-build, build-web, art, build, e2e, webgl-smoke,
webgl-attest, behavioral-smoke`. Everything else (`behavioral-coverage`, `vrt`,
`collab`, `collab-attest`, `grand-attest`) RUNS but never blocks merge. The live,
generated source of truth is [`docs/testing/README.md`](../docs/testing/README.md)
+ `docs/testing/test-ledger.generated.md` — see [ci.md](ci.md) for the evidence.

## Running ONE test (fast loop)

Dedicated `*:one` targets run a single test without the full suite. Prefix with
`REPEAT=3` to run 3× and bail on the first failure (the pre-MR flake-check).

```sh
# UNIT — defaults to the web package; PKG=dsp|server|art selects another workspace
flox activate -- task test:one -- src/lib/ui/canvas/organize.test.ts
flox activate -- task test:one -- organize -t "deterministic"        # file + name filter
flox activate -- task test:one PKG=dsp -- cube                       # another workspace

# E2E — boot the server ONCE, then run single specs against it
flox activate -- task e2e:serve
flox activate -- task e2e:one -- tests/ai-smoke.spec.ts
flox activate -- task e2e:one -- "title is patchtogether"            # bare phrase → --grep one test
flox activate -- HEADED=1 task e2e:one -- tests/audio-gate.spec.ts   # watch it
flox activate -- task e2e:stop

# VRT — one card (reuses the e2e:serve server if up)
flox activate -- task vrt:one -- adsr
flox activate -- HEADED=1 task vrt:one -- scope

# ART — one scenario
flox activate -- task art:one -- moog911
flox activate -- task art:one -- scenarios/meowbox/meow-c4.test.ts
```

## Registry-driven auto-enrollment

A single source of truth — `e2e/.generated/registry-manifest.json` — is emitted as
a side-effect of `task test`. At Playwright test-discovery time, three specs
iterate the module registry and auto-enroll **every** module:

- `e2e/tests/per-module-per-port.spec.ts` — 3 dims: handle-presence, output-emit,
  input-accept.
- `e2e/tests/per-module-per-port-behavioral.spec.ts` — audio fingerprint delta.
- `e2e/vrt/vrt.spec.ts` — one screenshot per enrolled module.

A new module is automatically swept in all three unless explicitly listed in the
exemptions (`e2e/vrt/vrt-exemptions.ts`: `EXEMPT_FROM_VRT`, `EXEMPT_OUTPUT_EMIT`,
behavioral exempts, `STRICT_VRT_MODULES`). You **cannot** forget to register a new
module — the manifest regenerates on every `task test`.

> **Manifest-stale trap:** e2e/VRT specs parse the manifest at file-discovery time
> (before the browser boots). If it's missing/outdated, Playwright throws an
> actionable error pointing to `task test:emit-manifest`. CI's `task ci` runs
> `task test` before e2e/vrt so it's always fresh. Locally, add a module without
> running `task test` and the specs fail at parse-time with a clear hint.

When adding a new module, run the registry-driven rows for it:

```sh
flox activate -- npx --workspace e2e playwright test per-module-per-port --grep <yourModuleId>
flox activate -- npx --workspace e2e playwright test vrt --grep <yourModuleId>
```

## Per-layer config & determinism

| Layer | Config | Key settings |
| --- | --- | --- |
| Unit (web) | `packages/web/vitest.config.ts` | node env, `$lib` alias, `pool=forks` + `singleFork` |
| ART | `art/vitest.config.ts` | node env + `node-web-audio-api`, `pool=forks` + `singleFork` (OfflineAudioContext is not thread-safe) |
| E2E | `e2e/playwright.config.ts` | chromium + audio-in + camera projects, WebGL-heavy partition, `retries=1` in CI |
| VRT | `e2e/vrt/vrt.config.ts` | `workers=1` (GPU determinism), `retries=0`, per-platform baselines, `threshold=0.2`, `maxDiffRatio=0.05` |

VRT determinism: `pinVrtFonts()` pre-loads Inter + JetBrains, awaits
`document.fonts.ready`, settles the card box height (3× identical
`getBoundingClientRect()` frames), and freezes the AudioContext post-render so
canvas content is pixel-stable. Non-scene-driven canvases are **masked** (filled
`#ff00ff` before diff) so the chrome (knobs/faders/handles) is the regression gate.

## Retries & sharding (CI)

- **E2E:** 8–10 shards (round-robin by file sort), 4 workers/shard, `retries=1`
  (gate-realistic), `forbidOnly=true`. WebGL-heavy specs (`toybox-*`, `video-*`,
  `wavesculpt*`, …) are partitioned into a dedicated serialized job
  (`--workers=1`) to avoid SwiftShader GPU-context starvation on the shared matrix.
- **VRT:** single worker, zero retries (baseline drift is deterministic truth).
- **collab / behavioral / capacity:** partitioned to their own low-parallelism CI
  jobs to avoid relay/load contention.

## Flake discipline

This repo treats flakes as bugs to root-cause, never tolerate.

1. **`REPEAT=3` pre-MR protocol** (repo standard): any NEW or seriously-changed
   test must pass **3× in a row locally** before you push it. Scope to the
   new/changed test, not the whole suite. `REPEAT=3` bails on the first failure.
2. **Declaration-level disablement only:** `test.skip('reason', fn)` /
   `test.fixme('reason', fn)`. Runtime guards (`test.skip(cond, …)`) are
   environment gates, not flake tolerance.
3. **The test ledger** (`docs/testing/test-ledger.generated.md`, GENERATED +
   freshness-gated in the `unit` lane) is the punch-list of every hard skip /
   quarantine (Bucket 1), coverage exemption (Bucket 2), and informational-only CI
   lane (Bucket 3). **Bucket 1 → 0** is the metric. Every disabled test is backlog:
   reconcile by fixing (assert real behavior) or deleting (worthless) — there is no
   permanent "intentional/correct-by-design" exempt bucket. Check it read-only with
   `flox activate -- task test:ledger`; after an intentional change re-pin with
   `flox activate -- task test:ledger:accept` and review the diff. Roadmap + gating
   truth: [`docs/testing/README.md`](../docs/testing/README.md).
4. **Capability probes:** modules depending on a hardware H.264 encoder,
   `getUserMedia`, or WebGL precision must **gate the assertion on a runtime probe**
   (`isConfigSupported()` / `getCapabilities()` / a renderer-tolerant pixel assert)
   and confirm green **on CI**, not just locally. CI runs SwiftShader (software
   WebGL) and has no OS H.264 encoder, so a flat pixel/encode assert that passes on
   a real GPU goes red on CI.
5. **Poly/MIDI modules** must ship an e2e wiring the REAL default source
   (MIDI LANE / POLYSEQZ) → module → and assert audible RMS at output. A per-port
   "edge materializes" assertion does NOT count as poly coverage.

To faithfully reproduce CI's WebGL-precision behavior locally:

```sh
flox activate -- E2E_SWIFTSHADER=1 task vrt:one -- <card>
```

## Reading a test failure

- **VRT failures:** download the playwright report / VRT gallery artifact, then
  diff the expected/actual/diff PNGs and classify as expected vs unexpected
  change. Don't rubber-stamp. If a baseline genuinely needs updating, regenerate
  it (`task vrt:update` locally, or the `vrt-update.yml` workflow for both
  platforms) and **inspect the git diff before committing**.
- **ART failures:** a `.f32` baseline diff means the audio changed. Decide
  regression vs intentional; if intentional, `task art:update`. Re-pin
  source-SHA baselines as the **last** edit step and confirm only the `.sha`
  (not the `.f32`) changed.
- **General CI failures:** see [ci.md](ci.md) — **never** use
  `gh run view --log-failed` (it wedges the shell); download artifacts instead.

## Update baselines

```sh
flox activate -- task vrt:update    # regenerate e2e/vrt/__screenshots__/ (LFS-tracked — inspect diff!)
flox activate -- task art:update    # regenerate art/baselines/ (.f32 + .sha)
```

> **git-LFS pointer trap:** `__screenshots__/**.png` and `art/baselines/*.f32` are
> LFS-tracked. CI must check out with `lfs:true`, or Playwright compares against
> the pointer-file bytes and every test "fails" with a giant diff.
