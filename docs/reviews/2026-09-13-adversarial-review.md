# Adversarial codebase review — 2026-09-13

**The most urgent problems are multiplayer correctness and persistence.** The review reproduced a stale saved-rack read, false clock convergence, loss of the LFO's shared-time anchor, dropped DOOM input, and unnecessary graph/reconciliation work. The current tests can remain green through these failures. CI is also expensive: the three sampled successful runs took 18–20 minutes elapsed and 313–322 summed runner minutes each.

The codebase's growing cost comes from coupling distinct kinds of state and runtime ownership through a few broad paths. The evidence supports repairing those boundaries in stages. It does not establish a need to replace Svelte, Yjs, WebAudio, or WebGL.

## Scope and evidence

Reviewed checkout: `codex/comment-cleanup`, commit `221e4d76d`, initially clean. This is a repository-wide structural review with focused execution of likely failure paths, not an exhaustive line-by-line certification. It covers graph/state flow, multiplayer/DOOM, audio timing, layered video ownership, server persistence, module loading, test configuration, and CI cost. DOOM is included under the owner's explicit instruction in this task, which overrides its usual exclusion. Multiplayer and multilayer behavior are treated as product requirements to preserve.

Evidence levels below distinguish **reproduced**, **measured**, and **source-inspected risk**. No production incident is inferred from a local reproduction. CI timings come from separate main commits; build and probes ran on this checkout.

- Fresh `task build:web`: passed.
- Review instruments: 8 web tests and 2 server tests; focused run followed by `REPEAT=3` for both. Six web assertions deliberately use `it.fails`; their green status means the intended guarantees fail. The observations reached their specific assertions in every run.
- Existing focused suites: 130 web tests and 10 server tests passed separately, including clocks, snapshots/reconciliation, DOOM transport/presence, layer mutators, and snapshot storage.
- No application, workflow, baseline, or production-test changes remain. The instruments are archived outside test discovery.
- No fresh full E2E/VRT run, WAN impairment run, real audible phase measurement, GPU profile, or live database outage was performed. These limits matter particularly for proposed renderer changes and relay capacity estimates.

Reproducible artifacts: [instructions and probe sources](2026-09-13-adversarial-evidence/README.md), [measurements](2026-09-13-adversarial-evidence/measurements.json), [validation output](2026-09-13-adversarial-evidence/validation.log).

## Prioritized findings

P1 means address promptly because a core promise can fail. P2 means a concrete defect or measured cost to address after the immediate correctness work. Priorities are this review's recommendations, not previously approved owner decisions.

| ID | Priority | Finding | Evidence |
| --- | --- | --- | --- |
| F1 | P1 | Successful fallback saves can later load an older rack | Reproduced at storage boundary |
| F2 | P1 | Cursor/awareness traffic fabricates clock samples and convergence | Reproduced with real Awareness |
| F3 | P1 | Clock estimator treats delay variation as round-trip latency | Reproduced with fixed network delays |
| F4 | P1 | LFO factory discards the shared-time anchor; phase test bypasses actual output | Reproduced factory messages + source |
| F5 | P2 | DOOM/gameplay and layout updates rebuild the whole patch snapshot | Reproduced and microbenchmarked |
| F6 | P2 | Async node creation allows redundant reconciliation work to accumulate | Reproduced delayed factory |
| F7 | P2 | DOOM shared-input relay drops events with equal millisecond timestamps | Reproduced press/release |
| F8 | P2 | Rack route has 6.75 MB of static JavaScript dependencies | Fresh build measurement |

### F1 — Saved-state authority is ambiguous across R2 and Postgres

[snapshot-store.ts:155](../../packages/server/src/snapshot-store.ts#L155) returns any successful R2 read immediately. [Its write path](../../packages/server/src/snapshot-store.ts#L171) falls back to Postgres when R2 fails and reports that save as durable.

Reproduction: R2 holds rack A; saving rack B receives an R2 503, then successfully writes the fallback. The next R2 GET succeeds with A. Actual result: `durable: true`, fallback value `after`, loaded value `before`. The no-R2 control returns the latest write correctly.

This is more serious than a temporarily stale view. [onStoreDocument](../../packages/server/src/index.ts#L279) can compact journal entries after the fallback reports success. A subsequent fresh load can then return the old R2 snapshot without the compacted edits available for replay. A surviving local replica might repair it; a fresh client cannot be assumed to have one. The exposure requires the R2 backend to be configured; deployed configuration was not checked.

**Repair:** establish a durable generation/authority rule spanning both stores, or use a storage design in which successful fallback writes remain authoritative on subsequent reads. Ensure compaction uses the same rule. A GET outage returning an older fallback also needs coverage. Blindly preferring either backend is insufficient.

**Acceptance:** write-fail/read-recover, read-fail/fallback, concurrent store completion, and restart/journal-compaction sequences recover the newest committed document from a fresh client. Existing tests exercise individual fallback operations, so they cannot prove this sequence.

### F2 — Unrelated awareness changes move the shared clock

[shared-clock.svelte.ts:188](../../packages/web/src/lib/audio/shared-clock.svelte.ts#L188) rescans awareness and submits its newest heartbeat on every callback, without checking whether that heartbeat was already consumed. It subscribes to both `update` and `change`, so one change can submit it twice.

With one heartbeat at server time 10,000 and client time 1,000, ten cursor changes over the following 500 ms produced:

| Metric | Before cursor traffic | After |
| --- | ---: | ---: |
| Offset estimate | 9,000 ms | 8,500 ms |
| Sample count | 1 | 16, the window cap |
| Converged | false | true |
| Reported RTT | unknown | 0 ms |

The resync counter incremented 11 times despite no new heartbeat. DOOM presence and other awareness fields reach the same callback. This is a direct multiplayer timing failure, not just inaccurate diagnostic text.

**Repair:** consume each heartbeat once using an explicit server session plus sequence identity, with a restart rule. Choose one appropriate awareness event. A forever-increasing-tick check alone would mishandle a server restart.

**Acceptance:** cursor, key, presence, and repeated-awareness traffic cannot increment heartbeat sample count or move the estimate; actual new heartbeats still work; restart/reconnect does not strand the estimator.

### F3 — The clock's reported RTT cannot measure constant network delay

[clock-sync.ts:53](../../packages/web/src/lib/multiplayer/clock-sync.ts#L53) computes `client receive delta - server send delta` and calls it RTT. Constant transit delay cancels in that subtraction. Adding half this value therefore cannot compensate for latency.

Two clients with equal physical clocks and stable one-way delays of 10 ms and 110 ms both report zero RTT and convergence after repeated heartbeats, but their computed shared times differ by 100 ms. The zero-delay control recovers the known offset correctly. This remains a defect after deduplicating heartbeats in F2.

**Repair:** use an actual timestamped request/response exchange and make its latency/asymmetry assumptions explicit. Keep jitter and RTT distinct and report uncertainty rather than declaring accuracy from sample count alone.

**Acceptance:** independent fixed, variable, asymmetric, and reconnect delay cases. Same-machine tests and zero-delay mocks cannot establish WAN clock accuracy. Perfect offset under arbitrary asymmetric delay is not a valid promise to build into the replacement test.

### F4 — The actual LFO is not anchored by the phase model that the test checks

[The LFO factory](../../packages/web/src/lib/audio/modules/lfo.ts#L282) reads `sharedNow`, checks it for null, then omits it from the worklet message. Two contexts initialized at local audio time zero but shared times 10,000 and 11,250 receive identical messages: epoch 10,000, audio origin zero, smoothing zero.

[The worklet](../../packages/dsp/src/lfo.ts#L80) initializes phase to zero. Its [resync target](../../packages/dsp/src/lfo.ts#L199) adds epoch to elapsed local audio time; it has no mapping of current audio time to current shared time. The omitted anchor cannot be reconstructed there. The factory-message reproduction demonstrates missing information; it does not claim a measured audible phase error.

Meanwhile, [shared-clock.spec.ts:160](../../e2e/tests/shared-clock.spec.ts#L160) supplies the same synthetic instant to both tabs' `__lfoPhaseAt` hooks. [The hook](../../packages/web/src/routes/+layout.svelte#L413) calls the separate `computeStateAt` model. Agreement proves deterministic arithmetic and common epoch state; disabling worklet anchoring would not make that assertion fail. The separate audio-drift research harness checks actual signals but permits initial phase difference, so it does not fill this gap.

**Repair:** define one explicit audio-time/shared-time/epoch mapping and carry all necessary values into the worklet, including init, resync, and reset semantics. Retain useful pure-model tests and label their claim accurately.

**Acceptance:** clients joining at different times produce aligned real modulation/output within a justified tolerance, including reset and reconnect. Deliberately disabling anchor delivery must fail the output test. The actual worklet/factory seam must participate.

### F5 — Transient gameplay and layout activity rebuild durable graph views

[snapshot.ts:420](../../packages/web/src/lib/graph/snapshot.ts#L420) rebuilds and emits on every Y.Doc update. Memoization preserves many entry identities, but [each build](../../packages/web/src/lib/graph/snapshot.ts#L184) still walks nodes/edges, sorts, resolves ports, and rebuilds indexes.

Actual DOOM `LockstepTransport` calls for two player slots over 350 tics produced 700 document updates, 38,131 incremental encoded bytes, and **700 snapshots of a graph with zero nodes**. At the game's 35 Hz schedule, that amount of tic activity corresponds to ten seconds; the probe itself ran as a tight loop and did not measure network packet timing. It demonstrates the unnecessary work regardless of graph size.

An additional Node microbenchmark changed only the `layouts` map 300 times, leaving the graph untouched:

| Untouched rack | Snapshot emissions | Total time, three runs |
| --- | ---: | ---: |
| 32 nodes / 31 edges | 300 | 25.5–26.0 ms |
| 128 / 127 | 300 | 78.8–80.0 ms |
| 512 / 511 | 300 | 308.6–312.4 ms |

Single-node parameter updates had comparable scaling. These are local Node timings, excluding Svelte rendering, browser contention, GPU work, relay fan-out, and persistence. They demonstrate scaling and amplification, not a user-facing frame-rate claim.

[Canvas](../../packages/web/src/lib/ui/Canvas.svelte#L1080) replaces its shared snapshot for every emission. Multiple [runtime controllers](../../packages/web/src/lib/ui/Canvas.svelte#L2999) then depend on broad `snapshot.nodes` scans. Multiplayer activity in one subsystem is coupled to unrelated modules and layered renderers.

**Repair:** distinguish structural graph changes, field/data changes, layout state, and gameplay events. Notify each consumer through the channel it needs. Incremental indexes and dirty-node subscriptions can then reduce graph-wide work. Do not merely suppress layout/data notifications: the UI and live layered content still need their own updates. Preserve DOOM's ordered lockstep and late-join/replay guarantees if its transport is ever changed.

**Acceptance:** gameplay-only updates cause no structural snapshot/reconciliation work; layout still updates peers correctly; layer parameter changes reach the actual renderer; cost of a one-node change is measured as unrelated nodes increase.

### F6 — A pending factory accumulates a queue of obsolete reconciliation requests

[reconciler.ts:80](../../packages/web/src/lib/audio/reconciler.ts#L80) appends every requested pass to a promise chain. The [scheduled flag](../../packages/web/src/lib/audio/reconciler.ts#L327) resets before that pass finishes. Later events can each enqueue another pass while an async factory is blocked.

A held `addNode` followed by 200 separately delivered parameter updates produced 202 completed reconciliation passes after release, while only the final value, 200, was applied. Reading `latest` at execution time preserves the final state but does not remove redundant passes or callbacks. F5 supplies a natural high-rate source of requests.

**Repair:** retain at most one pending follow-up over the latest snapshot while a pass is active. Preserve explicit `reconcile()` completion semantics, error handling, disposal, node replacement, and edge ordering.

**Acceptance:** a slow factory plus hundreds of updates has bounded pending work and reaches the final state; removal/replacement during the wait cannot resurrect an obsolete node. A synchronous burst test alone misses this queue.

### F7 — DOOM key deduplication mistakes wall time for event identity

[DoomSurface](../../packages/web/src/lib/ui/modules/doom/DoomSurface.svelte#L1581) stamps relay events with `Date.now()`. [collectIncomingKeyPushes](../../packages/web/src/lib/doom/doom-presence.ts#L136) rejects timestamps less than or equal to the previous event from that client.

The actual helper accepted a press at timestamp 1,000 and dropped its release at the same timestamp. Distinct keys can collide too. Same-millisecond dispatch is possible with queued events or coarse time resolution. A dropped release can leave the host's key held. This finding concerns the spectator/shared-input relay, not the separate joined-player tic-command path.

**Repair:** use event sequence/session identity, with explicit duplicate and reconnect behavior, rather than timestamp uniqueness. Preserve both press and release. Consider the awareness field's latest-state semantics when deciding whether it is an adequate event transport.

**Acceptance:** burst presses/releases and multiple keys survive timestamp collision; duplicate delivery remains harmless; reconnect resets identity correctly. Include real host input state in an E2E assertion.

### F8 — Eager definitions make unused modules part of rack startup

The fresh Vite manifest's **static import closure** for rack route node 29 and root layout node 0 contains 86 JavaScript chunks: 6,754,938 raw bytes and 2,214,212 bytes when individually gzipped. The largest static chunks are approximately 2.59 MB, 1.57 MB, 1.18 MB, and 630 KB. Dynamic-only code, boot entry, CSS, WASM, and media are excluded. This is a dependency-size measurement, not a browser transfer or parse-time measurement; caching and compression alter actual loads.

The [audio](../../packages/web/src/lib/audio/modules/index.ts#L27) and [video](../../packages/web/src/lib/video/modules/index.ts#L17) registries eagerly import sibling definition files, coupling discoverable metadata to factories and their dependencies. UI extensions already have a lazy mechanism; indiscriminately adding more dynamic imports around code that remains statically reachable will not solve this.

**Repair:** measure a metadata/factory split with a generated or glob-derived population and load factories when needed. Preserve synchronous metadata contracts, module registration completeness, saved-rack compatibility, and error handling. Never introduce a manually maintained parallel registry.

**Acceptance:** compare cold empty-rack and representative multilayer-rack startup, parse time, responsiveness, and first audible/visible output. Verify deferred load failures and factory races. Set a budget from measured product behavior, not an arbitrary bundle-size target.

## Test cost and what the gates cannot see

### Multiplayer is deliberately outside the aggregate CI gate

[ci.yml:2221](../../.github/workflows/ci.yml#L2221) omits `collab` from aggregate dependencies and explicitly prints it as informational. This is a current intentional configuration, not a newly discovered typo. Three green samples do not themselves settle whether the whole lane is reliable enough to require. External branch-protection settings were not audited.

Given the owner's multiplayer emphasis, the recommendation is **P1: define a required compact multiplayer outcome gate**. It should prove real audio/video behavior, convergence after concurrent changes, late join/reconnect, and save/reload. The latest sampled collaboration lane passed 49 tests with no flakes or skips in about 6.1 minutes, but the aggregate does not require that result. Not every multiplayer-related test is excluded: the clock-sync tag also runs through other E2E selection.

| Instrument | What it establishes | What it cannot establish alone |
| --- | --- | --- |
| Pure clock/LFO model | Arithmetic for supplied timestamps | Independent clocks or real worklet output alignment |
| Same-document layer mutator tests | Live Y-type mutation safety and correct target layer | Conflicting peer edits, remote hydration, or rendered output on both peers |
| Two-context collaboration tests | Covered edit/relay flows | WAN timing and every persisted/transient state interaction |
| Snapshot-store operation tests | Individual backend fallback behavior | Authoritative recovery across alternating backend failures |
| Mock-engine reconciliation | Covered graph operations and scheduling | Factory readiness, real DSP sound, GPU/media lifetime |
| VRT and curated GPU probes | Their scenes and execution environments | Every excluded heavy render scenario or native device behavior |

TOYBOX has meaningful per-layer, compositing, feedback, and output tests. Preserve them. Add a targeted multilayer collaboration outcome: independent users edit different layers, conflict on content/parameters, reconnect and reload, then verify the agreed composite on both clients. GPU-heavy scenarios are explicitly curated/excluded by [webgl-heavy-globs.ts](../../e2e/webgl-heavy-globs.ts); there is no general `e2e-video` lane to move tests into. A curated smoke result must not be described as execution of every heavy proof.

### Measured CI cost

| Successful run | Elapsed to recorded completion | Sum of job durations | Workspace-install steps | Unit step | Collab step |
| --- | ---: | ---: | ---: | ---: | ---: |
| [34757630198](https://github.com/2600hz-oscillator/patchtogether.live/actions/runs/34757630198), Sep 13 | 18m 00s | 313.0 min | 45.1 min across 35 steps | 590s | 368s |
| [34417548872](https://github.com/2600hz-oscillator/patchtogether.live/actions/runs/34417548872), Sep 9 | 19m 58s | 322.2 min | 44.4 min across 35 steps | 601s | 366s |
| [34413328938](https://github.com/2600hz-oscillator/patchtogether.live/actions/runs/34413328938), Sep 9 | 19m 21s | 322.2 min | 45.7 min across 35 steps | 594s | 386s |

Summed job duration measures occupied runner time, not CPU consumption or billing. Elapsed time is created-to-last-recorded-update. Installs are part of the job totals, not additional cost. In the latest run the slowest E2E jobs were shards 5 and 11, approximately 14.1 minutes each; unit runtime alone is not the end-to-end critical path.

The latest unit log breaks down to DSP 94.90s, server 1.40s, web 421.10s, manifest 7.09s, and scripts 59.38s. The web runner reports 97.80s collection and 229.45s test execution, so speeding assertions alone leaves significant overhead.

Representative expensive files from that run:

| Test file | Time | Interpretation |
| --- | ---: | --- |
| `macrooscillator.test.ts` | 23.14s | DSP behavior coverage; inspect assertion/fixture cost before reducing cases |
| `snaredrum-dsp.test.ts` | 20.53s | Substantial DSP execution |
| `nibbles-bot.test.ts` | 15.47s | Calibration runs 2,000 seeded games; useful heavy numerical contract |
| `worktree-identity.test.ts` | 11.16s | Real retry delays contribute about eight seconds in two negative cases |
| `outlines-perf.test.ts` | 10.75s | Repeated old/new pixel computation and per-pixel assertions |
| `clouds-face-model.test.ts` | 10.63s | Despite its name, includes meaningful behavioral computation |
| `attest-code-basis.test.ts` | 10.06s | Tooling/attestation fixtures and process work |

**P2 recommendations, in order:**

1. Measure and reduce repeated dependency installation. Cached `node_modules` jobs still invoke [the install task](../../Taskfile.yml#L63). Use a verified lock/environment-keyed install artifact or validated cache path that preserves required lifecycle/generated outputs. The observed 44–46 minutes is an upper bound on exposed work, not a promised saving.
2. Separate independent unit packages or carefully partition expensive web groups. Current single-fork settings and shared globals mean blindly raising workers can exchange time savings for memory pressure and flakes. Check isolation with repeated runs.
3. Make retry time injectable in tooling tests while retaining a real integration check. Replace per-sample assertion overhead with aggregate/vector comparisons that retain full sample coverage and a useful failing index. Keep sonic and pixel oracles.
4. Treat deterministic calibration/performance workloads as an explicit project if measurement justifies it; preserve coverage of changes that affect them. Do not cut samples or tolerance merely to make a job fast.
5. Rebalance E2E with recent per-test durations and report both total runner minutes and the slowest shard. More shards alone multiply setup cost.

Some nearby prose is stale: Playwright configuration describes flake gating as not armed, while current CI invokes `--fail-on-flaky`; historical shard counts also disagree with the current 12-shard workflow. The executable workflow is the evidence. Broadly editing comments or deleting tests is not the performance fix.

## Complexity assessment and remaining capacity risk

Canvas is 10,121 lines, with 56 literal `$effect(` sites and 55 `snapshot.nodes` references in this checkout. Those counts identify an investigation hotspot; they do not constitute a defect or justify a line-count target. Other large owned files include BACKDRAFT's runtime, the TOYBOX console/runtime, controller mapping, and clipplayer. Much of their size represents real product behavior.

The concrete complexity problem is the number of responsibilities activated by the same change: shared graph snapshots drive UI, audio reconciliation, node-owned media controllers, and layered video synchronization. Adding a gameplay log to the document activates that machinery too. Splitting files without changing these dependencies would preserve the problem.

The recommended ownership model is:

| Responsibility | Contract to make explicit |
| --- | --- |
| Durable shared rack | Versioned/recoverable graph and module data, with well-defined conflict behavior |
| Per-peer rig and layout | Device/runtime ownership and only the sharing required by the UI |
| Transient multiplayer events | Sequence/session, ordering, delivery, retention, and replay policy |
| Runtime controllers | Node lifetime independent of face/dock visibility, with explicit readiness/disposal |
| Render/audio observation | Per-node/field invalidation and actual output evidence |

This is a staged boundary recommendation, consistent with [ADR 015's measurement requirement](../adr/015-re-architect-only-on-a-measurement.md) and [ADR 017's refusal of tidiness at the expense of behavior](../adr/017-decline-tidiness-that-costs-behaviour.md). Those decisions do not pre-approve a new gate or transport. The owner's DOOM inclusion is explicit; a framework rewrite or coverage reduction is not.

For multilayer performance, the video engine already uses demand-driven evaluation and a [preview visibility/cadence gate](../../packages/web/src/lib/video/engine.ts#L1684). Its distinction between a card preview and a downstream consumer is essential: hiding a preview must not starve a layer, audio consumer, or export. Prior profiling described in ADR 015 identified preview synchronization as expensive and did not justify moving the engine to a worker. No new GPU measurement in this review supersedes that evidence.

**Source-inspected capacity risk, not a reproduced outage:** [every applied update](../../packages/server/src/index.ts#L258) launches a fire-and-forget [journal insert](../../packages/server/src/journal.ts#L65), while the [database pool](../../packages/server/src/db.ts#L107) has ten connections and no explicit acquisition/query timeout in that configuration. Slow storage plus sustained gameplay/edit traffic can accumulate pending work; swallowing insert failures does not provide backpressure. Rack byte accounting and connection capacity are different controls from limiting update rate or queued persistence work.

Before claiming a supported multiplayer capacity, run an isolated fault/load scenario with several clients, DOOM tics, parameter changes, and layered media while delaying storage. Measure pending inserts, memory, update-to-output latency, and save recovery. Choose bounded queues/batching/admission rules that preserve durable edits; do not silently drop updates to make the queue small.

## Recommended execution sequence

1. **Persistence correctness:** fix F1 with authority/generation and recovery tests before optimizing snapshot writes.
2. **Multiplayer timing and input:** repair F2–F4 and F7, then prove actual staggered-client output and DOOM release state. Keep clock protocol and factory mapping as separately tested contracts.
3. **Bound runtime work:** fix F6, then separate invalidations in F5. Compare identical large/layered racks under peer edit and DOOM traffic, including hidden previews with active consumers.
4. **Make the critical multiplayer outcomes required:** select a compact reliable set and demonstrate that negative controls turn it red. Preserve longer collaboration and renderer evidence with honest execution status.
5. **Reduce startup and CI cost:** measure metadata/factory separation, repeated installs, unit isolation, and shard balance. Report improvements in user-visible latency and runner cost without reducing behavioral coverage.

Each step has an independent acceptance boundary and can be reviewed without a sweeping rewrite. The archived probes make the immediate defects concrete; real browser/audio/load measurements remain required before broader performance claims.
