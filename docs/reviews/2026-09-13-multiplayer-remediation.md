# Multiplayer and persistence remediation — 2026-09-13

Implemented the approved correctness and amplification work from the [adversarial review](2026-09-13-adversarial-review.md). The original review and its evidence describe commit `221e4d76d`; they remain historical evidence. This report describes the uncommitted changes on `codex/multiplayer-correctness`.

The owner approved: “I recommend fixing persistence and multiplayer correctness first, then reducing update amplification and test overhead. Multiplayer and multilayer behavior should drive the acceptance tests.” The owner also explicitly included DOOM and authorized appropriate fixes.

## Changes and evidence

| Area | Result | Acceptance boundary |
| --- | --- | --- |
| Persistence (F1) | Postgres records the authoritative save generation and either inline bytes or an immutable R2 object key. An R2 write failure saves inline at that generation. A missing authoritative object fails the load rather than returning an older snapshot. | Real Postgres: object write failure, successful fallback, journal compaction, storage recovery, and fresh load preserve both users’ layer edits. |
| Clock sampling (F2–F3) | Correlated four-timestamp requests replace awareness-derived samples. Duplicate responses and unrelated awareness changes cannot fabricate convergence. Reconnect and relay restart reset sampling; measured round-trip delay bounds uncertainty. | Unit tests cover fixed and asymmetric delay, invalid exchanges, duplicates, awareness churn, timeout, reconnect, restart, and cleanup. |
| Actual modulation (F4) | LFOs receive the audio-time/shared-time mapping, wait for clock convergence, anchor on first initialization, and handle later resync/reset. The factory uses the browser’s paired output/performance timestamps. | Two independent browser contexts measure actual quadrature LFO worklet output after staggered creation, reconnect, and shared reset. Deliberately shifting an anchor by 250 ms fails the same measurement. |
| Update amplification (F5–F6) | Gameplay, layout, and clock metadata no longer invalidate the graph snapshot. Canvas observes layout changes separately. An active reconciliation retains one pending pass over the latest state. | The original 700-update DOOM probe now emits **0 snapshots instead of 700**. A pending factory plus 200 changes completes **2 passes instead of 202**, applying value 200. Removal and replacement during creation also pass. |
| DOOM input (F7) | Sender session and sequence distinguish press/release events with identical millisecond timestamps. Older senders retain timestamp compatibility. | Two-context test observes both events reaching the real host input path. A separate joined-player test proves A’s movement changes player position in B’s actual runtime and B’s framebuffer; a no-input control stays stationary. |
| Multilayer output | Added outcome coverage for independent edits to two layers, offline edits, reconnect, and a fresh peer. | Both real video engines produce the expected composite pixels after each transition. Reload recreates the document/provider/renderer, not just a local model. |

Persistence also orders generation allocation per rack within a relay, preventing asynchronous database allocation from reversing save order. Immutable keys include a random suffix to prevent reuse across restored/cloned database sequences. Generation-zero legacy snapshots merge the R2 and Postgres Yjs updates before adopting the new contract.

Retired objects are queued in the same transaction as authority changes or rack deletion. Cleanup retains an hour of read grace, drains bounded pages with one deletion request at a time, and retries failures. Tests cover superseded writes, reversed upload completion, generation allocation order, sequence reuse, idempotent authority retries, cleanup backlog, and failed deletion retries.

## Test cost and CI

The four `@multiplayer-critical` browser tests run first on the existing collaboration runner. Their test and skip/flake-audit outcomes feed a lightweight required `multiplayer` job and the aggregate CI result. The remaining collaboration suite retains its diagnostic result and excludes those four tests to avoid duplicate execution within that runner. No additional dependency installation or browser build is introduced by the result job.

Three DOOM fixed sleeps were replaced with tic progression and observable movement. The exact three removed wait-ledger entries were reviewed. Worktree identity tests inject their retry wait, removing eight seconds of deliberate sleeping while preserving HTTP failure/success checks. DSP builds now exclude test and declaration sources and remove stale outputs for them. Generated Playwright vendor reports received an explicit lint-policy exclusion, matching the existing generated-report convention.

These are concrete local reductions; they do **not** establish a reduction in total CI elapsed time or runner minutes. The earlier 313–322 runner-minute samples remain the baseline until this change has run in CI.

## Validation

All commands ran through Flox. New or materially changed tests received focused runs and three-run flake checks.

- Critical browser acceptance: **12/12 passed**, four tests repeated three times with one worker and zero retries; report audit found **zero skipped or flaky results**.
- Real Postgres authority integration: **2 tests passed**, focused and three repeats, in an isolated temporary database/schema. Includes fallback/compaction recovery and transactional retirement with live-object retry protection.
- Snapshot storage: **18 tests passed**, focused and three repeats.
- Runtime update isolation: **4 tests passed**, focused and three repeats.
- Actual LFO processor: **3 tests passed**, focused and three repeats; factory clock mapping/readiness test also passed focused and three repeats.
- Related web suites: **128 tests passed in each of three runs** at that stage; later factory and lifecycle changes received the focused repeats above.
- Related server suites: **51 tests passed in each of three runs** before the additional storage cases; the expanded storage and real-database suites passed subsequently.
- Existing collaboration sync/layout tests: **3 passed**. These inspect stored per-user layout state, not rendered drag positions.
- Fixture registration/compositing and its classification gate: **2 passed**, focused and three repeats.
- CI policy suites: **72 tests passed in each of three runs**. Worktree/test-ledger/related workflow checks also passed three repeats.
- `task typecheck`: passed, including Svelte with zero errors/warnings; server TypeScript passed after the generation-order fix.
- `task lint`, `task actionlint`, DSP build, and `git diff --check`: passed.

[Compact browser results and validation evidence](2026-09-13-multiplayer-remediation-evidence/results.json) preserve the final browser outcomes and the bounded regression measurements. The tests themselves are the reproducible instruments.

## Deployment requirement

Apply [migration 008](../../db/schema/008_snapshot_authority.sql) **before starting the updated relay**. Drain old relay processes during the format switch, then complete the relay upgrade before shipping the new clock clients. Old relays cannot interpret the new authority records; rollback requires materializing current snapshots into their legacy format. See [database rollout notes](../../db/README.md#L10).

At the initial 2026-09-13 validation checkpoint, no live migration, deployment, commit, push, or merge had been performed.

## Remaining limits and work

- F8’s eager module loading and startup cost remain. A metadata/factory split needs cold-start and first-output measurements before broader restructuring.
- Graph changes still rebuild graph-wide indexes; this patch removes irrelevant invalidations and queued passes, not every linear scan.
- Repeated CI installs, shard balance, and broader unit-suite cost remain to be measured after CI runs this patch.
- Clock uncertainty cannot determine arbitrary network asymmetry. Local browser output proof does not certify WAN behavior or every physical audio device.
- The browser tests use the local relay’s in-memory persistence; the separate integration test uses real Postgres with a controlled R2 transport. This is not a live R2 outage or relay-restart end-to-end test.
- An uploaded object whose authority commit truly fails may remain orphaned; the journal is preserved, and ordinary retired/superseded objects are cleaned up. There is no full bucket orphan sweep.
- The existing one-owner-per-live-document relay architecture remains. Sustained storage-delay/backpressure testing, full Linux CI, full ART/VRT, and a GPU/load profile were not performed.

The change preserves node-owned audio/video runtime lifetime, demand-driven video evaluation, module registries, and the single Linux-authored VRT baseline set.


## PR preparation — 2026-09-14

Recovered this work into an isolated checkout on `codex/multiplayer-persistence`,
based on current `main` at `5abcd254e419539d576785ed8ac0e02d308f0377`.
Unrelated Backdraft work and the original recovery stash were preserved.

Fresh validation on that base passed: DSP build, typecheck (zero Svelte errors
or warnings), lint, actionlint, 140 focused web tests, 54 focused server tests,
57 workflow/tooling tests, and all four critical multiplayer browser tests
with zero retries. The earlier three-run acceptance evidence remains above.

Read-only preflight verified that dev, autotest, and production all have the
existing snapshot table and none has migration 008's new schema objects.
The operator's target-environment selection is pending; no shared database
migration or relay deployment has been performed in this preparation step.
