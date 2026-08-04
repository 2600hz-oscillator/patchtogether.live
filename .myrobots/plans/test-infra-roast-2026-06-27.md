# Test-infrastructure adversarial review — 2026-06-27

_8 domain critics, 73 raw findings, synthesized + honesty-discounted._

> **TRIAGE 2026-08-04 — this is the EVIDENCE doc behind
> `test-infra-remediation-plan-2026-06-27.md`; read that file for what to do.
> Several of the headline findings are now FIXED, so do not quote this as
> current state.**
>
> | finding | today |
> |---|---|
> | "the entire Moog batch is 11 byte-identical 440 Hz sine stubs" — the headline | **FIXED.** The stubs were deleted and an md5-uniqueness guard added (**#940**); ART then grew 48 → **136** real `.f32` baselines under an explicit coverage ratchet (`art/setup/profile-coverage.ts`, backlog 101 → 56) |
> | "MilkdropCard escapes the fail-closed WebGL basis" | **FIXED** — `webgl-attest-coverage.test.ts` now fails on any WebGL-rendering source outside the basis |
> | "behavioral is informational and doesn't run on a normal PR" | **PARTLY FIXED** — **#986** made a fast subset REQUIRED; the full lane is still informational, and **#1318** showed a required row passing on noise |
> | "exemption lists are unenforced graveyards past their own caps" | **PARTLY FIXED** — ratchets are now assertions and are checked in BOTH directions; but `BEHAVIORAL_MODULE_EXEMPT` has grown 64 → **77** and `EXEMPT_FROM_VRT` 76 → **81** |
> | "the blocking VRT gate covers 13% of modules; linux baselines perpetually pending" | **PARTLY FIXED** — linux baselines are captured routinely now and the deficit ratchet counts all four gap mechanisms (**#1272**); a stale-palette hole in the REQUIRED lane was found and closed as late as **#1281** |
> | "retries=1 launders flakes" | **NOT FIXED** — `e2e/playwright.config.ts:97` is still `retries: CI ? 1 : 0` |
> | "555 waitForTimeout sleeps" | **NOT FIXED** — **639** under `e2e/` today |
> | "@collab / real multiplayer never runs on PR CI" | **NOT FIXED** — still informational |
>
> ⚠ The "heavy WebGL specs are excluded from PR and run in a serialized
> `e2e-video` lane" framing is **wrong as of 2026-06-20 (#839)**: that lane was
> deleted, so exclusion now means no PR coverage at all.
> Kept because the *reasoning* (what each gate is structurally unable to see) is
> the ancestor of the "VALIDATE THE INSTRUMENT" / "blind gates" standards now in
> CLAUDE.md.

## Headline
The product is a synth, yet enforced audio-correctness coverage is near-zero: the ART "baselines" for the entire Moog batch (plus polyhelm, pentemelodica, analog-vco) are 11 byte-identical 440 Hz sine stubs (md5 8313a1e7…), so a required CI gate is literally comparing a stub against itself and stamping it green.

## Executive summary
Your test suite is wide and green, and that green is substantially false. The single most damning fact: the ART audio-regression gate for the entire Moog batch (plus polyhelm, pentemelodica, analog-vco) compares a 440 Hz sine stub against a baseline that IS the same stub — VERIFIED, 11 byte-identical .f32 files. Across all four layers, the DSP correctness of a synth is essentially unenforced: unit tests skip audio by design, e2e specs titled 'audio flows to OUTPUT' never read the output, and the one lane that proves input→output (behavioral) is non-blocking and doesn't even run on a normal PR. The 'edge materialized' per-port sweep — the registry's primary input coverage — proves a wire didn't throw, nothing more. Meanwhile your two highest-risk lanes never execute on the PR that could break them: real-GPU WebGL and real multiplayer are owner-local self-attestations CI trusts by a hash of a hand-writable JSON, and the only real-multiplayer backstop (collab-nightly) has self-cancelled for 6 straight nights (#868). The blocking VRT gate covers 26 of 188 modules — all static knob cards — while the actual video product's pixels are informational with linux baselines perpetually 'pending'. Underneath sits exemption-list rot (lists 3-9x past their own 'design is wrong' caps, unenforced), retries=1 laundering flakes against your own no-flake rule, and zero coverage for three bug classes you've ALREADY shipped to prod (Y.Doc data-loss, the +140MB/min write-storm, stored-XSS in a multiplayer app). Highest-leverage quick wins: an md5-uniqueness guard that instantly exposes the ART stubs (then delete them), un-swallow 'Failed to load resource' so dead worklets fail loudly, add MilkdropCard to the WebGL basis, and make exemption caps a failing assertion. Then make behavioral blocking, add real output reads to audio specs, fix the dead nightly, and run thin real @collab + WebGL passes on PR CI. The good news: the patterns to copy already exist in your repo (adsr-env/moog-ladder pure cores, the deterministic DRS freeze path, acidwarp render-smoke) — the fixes are mostly promotion and enforcement, not invention.

## Themes

### [CRITICAL] DSP correctness is unverified at EVERY layer — green badges on dead/stubbed audio paths
A modular synth's entire value is its signal processing, and not one lane actually checks it on a normal PR. A wrong coefficient, flipped sign, dead envelope, or silent output ships green. This is the institutionalized POLYHELM #674 'green-but-silent' failure mode, across the whole module surface.

> VERIFIED: art/setup/render.ts:66-68 returns Math.sin(2π*440…) ignoring opts.moduleName; 11 .f32 baselines share md5 8313a1e783… and 2 share fc3e2d8e… (stub-vs-itself for moog902/904a/904b/911/921a/921b/921-vco/cp3 + pentemelodica + polyhelm + analog-vco). e2e specs titled 'audio flows X→Y→OUTPUT' (attenumix/peaks/clouds/warps/resofilter) assert only toEqual([]) on console errors and never read AudioOut; resofilter reads cutoff=800 back as 800 (tautological). vitest is environment:'node' and explicitly does NOT load audio factories — 22 pure-core tests vs 70 worklet entries; most modules have no extracted core.

### [CRITICAL] The two highest-risk lanes (real-GPU WebGL + real multiplayer) NEVER run on PR CI — they are owner-local self-attestations CI trusts by hash, and the nightly backstop is dead
@collab is documented as THE DOOM/sync regression gate, and WebGL render is the video product — yet the PR that could break them never executes them. The 'required' webgl-attest/collab-attest jobs only recompute a content hash and check a committed JSON exists (README: 'Every field is hand-writable; NOT a security control'). The only lane that runs real under-load multiplayer (collab-nightly) has self-cancelled at its 90-min ceiling for 6 consecutive nights with open issue #868 rotting.

> VERIFIED: collab-nightly cancelled 1h30m on 06-22..06-27 (gh run list). ci.yml: behavioral + full vrt + heavy-WebGL excluded from PR; webgl-attest/collab-attest jobs are verify-hash-only; real `collab` job is 'informational, deliberately NOT in failing condition'. MilkdropCard.svelte only getContext('2d') + imports butterchurn → escapes the 'fail-closed' WebGL basis regex entirely.

### [CRITICAL] 'Edge materializes' is the primary input coverage — it proves a wire didn't throw, not that any input does anything
The auto-enrolled per-port sweep (~109-166 modules) asserts only that an edge id survives in the patch store; its own comment says 'we only need to assert edge materialised, not downstream effect observable.' Worse, spawnPatch writes edges DIRECTLY into the Yjs store, bypassing canConnect/engine.addEdge — so it can't even catch the engine-rejects-edge bug it claims to. CLAUDE.md explicitly says this does NOT count as coverage, yet it IS the coverage.

> per-module-per-port.spec.ts DIM3 asserts edgeIds.toContain('e-up-sut') + filterErrors([])==[]; _helpers.ts:121-129 writes w.__patch.edges directly in __ydoc.transact. The only lane that proves input→output (per-module-per-port-behavioral) is continue-on-error AND skipped unless a PR carries the 'behavioral' label (ci.yml:1147,1155 VERIFIED).

### [CRITICAL] The blocking VRT gate covers 13% of modules (static knob cards); the actual visual product — every canvas/video card — is informational and its linux baselines are perpetually 'pending'
For a video synth, the picture IS the product, but a pixel regression on 162 of 188 modules can merge green. The scene-driven canvas render-correctness mechanism — the headline VRT feature — runs on ZERO modules on CI because linux baselines were never captured (vrt-update is manual workflow_dispatch nobody runs). vrt-meta then rubber-stamps darwin-only baselines (that CI never diffs) as 'covered'.

> VERIFIED: STRICT_VRT_MODULES = 26 entries; full `vrt` job continue-on-error:true (ci.yml:1754). vrt-meta.test.ts:95 counts a baseline on EITHER platform as covered; 55 darwin-only baselines; 97 'linux/…' EXEMPT_BASELINE_PAIRS commented 'pending workflow_dispatch', some 5+ weeks stale. 18 linux baselines are canvas-masked (#ff00ff) so only knob chrome is diffed.

### [HIGH] Exemption lists are unenforced graveyards that blew past their own stated caps by 3-9x — coverage erodes silently while reporting 'covered'
Every harness defaults to opt-OUT via hand-maintained prose lists, so the gate's strength is gated on the same hand-list it's meant to replace. ~1/3 of modules are wholly behavioral-exempt, 37% of output ports are emit-exempt, STRICT_DOCS/STRICT_VRT are opt-IN allowlists. Each list is a known merge-conflict surface. The 'cap' is a code comment, not a test.

> BEHAVIORAL_MODULE_EXEMPT ~64 + BEHAVIORAL_SWEEP_EXEMPT ~160 vs file's own '~25 upper bound'; EXEMPT_OUTPUT_EMIT(_MODULES) ~41 each vs header '~25 = design is wrong'; 236/644 output ports emit-exempt; module-docs-lint.test.ts:153 `if(!STRICT_DOCS.has)continue` (completeness opt-in only); vrt-exemptions.ts is 1276 lines (VERIFIED).

### [HIGH] Flake laundering contradicts the repo's own no-flake-tolerance discipline
retries=1 on CI turns first-attempt failures green with no signal, while 555 hard-coded waitForTimeout sleeps + networkidle in 296 specs manufacture the exact timing races retries then hide. Plus permanent VRT 'quarantine' entries (#198/#202) and an in-card-title peer-sync test.fixme that the attest counts as not-failing. The team believes the suite is stable because CI is green; the green is partly laundered.

> VERIFIED playwright.config.ts:97 retries: CI?1:0. 555 waitForTimeout / 806 networkidle (per critics). EXEMPT_BASELINE_PAIRS darwin quarantine block dated 2026-06-01 still present. in-card-title.spec.ts:106 test.fixme on peer Yjs rename, in the @collab attest basis.

### [HIGH] Attest over-invalidation treadmill: whole-file/whole-dir hashing puts the owner's single laptop on the critical path of unrelated PRs
Both webgl-attest and collab-attest hash packages/web/package.json wholesale, so ANY dependency bump (audio/UI/date util) forces a manual owner-local re-attest — collab even needs local Postgres + relay. The WebGL basis sweeps all of lib/video/**, so a label typo in a video module churns the hash. This is a recurring multi-minute human tax that gates merges on one machine being free, for changes that touch zero pixels/zero sync.

> TOOLCHAIN_PIN_FILES includes packages/web/package.json; resolveWebglBasis sweeps lib/video/** (183 basis files); README records committed run durationSec=252 and historical 24-27 min; collab-attest greps every spec for @collab so a comment trips the hash (collab-basis tag-grep footgun memory).

### [HIGH] Cross-cutting safety nets are entirely absent on surfaces with a proven prod-incident track record
Three bug classes the team has ALREADY shipped have no automated tripwire: (1) Y.Doc persistence/migration — no legacy-snapshot fixture despite #566 + #812 silent data-loss; (2) per-frame write-storm memory leak — the +140MB/min TOYBOX leak (#719) was found in PROD, only one soft Chromium-gated heap check exists; (3) stored-XSS — a multiplayer app where peers render each other's labels/patches/URLs/user-GLSL has zero sanitization/CSP test.

> grep for legacy|migrate|backward over lib/sync + server returns nothing; only vfpga-p3-composite.spec.ts touches heap (soft, if(heapApi)); grep for xss|sanitize|dompurify|csp finds only comments. Memories cv-modulation-live-store-write-storm, videovarispeed-multislot-persist corroborate the shipped incidents.

### [MEDIUM] The no-console-errors net — the sole proof in ~73 specs — is defeated by its own filter swallowing the exact failure it should catch
filterErrors() drops any 'Failed to load resource' — which is precisely what a 404'd worklet/shader/sample emits, i.e. the most common way a DSP/GL module ships silent or dead. Dozens of specs whose entire safety net is errors.toEqual([]) cannot catch a failed-to-load worklet. The over-broad filter hides the bug class it exists to catch.

> per-module-per-port.spec.ts:624-633 filterErrors drops 'Failed to load resource','[vite]','AudioContext','[reconciler] reconcile failed'; feeds the inputs-accept/outputs-emit asserts at :1276/:1426.

### [MEDIUM] Consistency/drift gates are honestly useful but are sold as correctness gates they are not
contract-lock + living-docs + modules-card-map prove I/O SHAPE and that doc KEYS exist and are non-empty — never that the module works or the prose is true. The edge-vocab check is positive-keyword-presence only ('this is NOT a trigger and never fires' passes the trigger gate). controlFamily cross-check is a substring over ALL card source concatenated (false-positive across unrelated cards). 'renderable component' is toBeTruthy on a glob import that never mounts. These are good drift gates mislabeled as semantic ones.

> module-docs-lint.test.ts:108-111 hasAny(desc, TRIGGER_VOCAB); :76-88 concatenates every *.svelte; modules-card-map.test.ts:166-170 expect(comp).toBeTruthy(); 530 toBeTruthy/toBeDefined occurrences across unit tests.

## Prioritized actions

- **[quick-win]** Add a guard test asserting no two ART .f32 baselines share an md5 — it goes red immediately on the 13 stub collisions — then DELETE the stub-vs-stub scenarios (Moog batch/polyhelm/pentemelodica/analog-vco). A deleted test is honest; stub-vs-itself manufactures false confidence on a required gate.
  - addresses: DSP correctness unverified; ART stub theme
- **[quick-win]** Narrow filterErrors() to specific known-noise URLs (the optional DOOM WAD) and stop swallowing the blanket 'Failed to load resource' — so a 404'd worklet/shader/registry asset fails the ~73 'no console errors' specs loudly.
  - addresses: no-console-errors net defeated by its own filter
- **[quick-win]** Close the WebGL coverage fail-open: add MilkdropCard.svelte to the basis now, detect lib-mediated GL (butterchurn/three/regl/pixi imports) and getContext('webgpu'), and make 'card source for any domain:video module' an unconditional basis rule instead of a literal getContext regex.
  - addresses: WebGL guard fail-open; MilkdropCard escaping basis
- **[quick-win]** Turn every exemption cap into a failing unit assertion (list.length <= N, ratcheting DOWN) for behavioral/emit/input-drive/STRICT lists — so breaching the documented ceiling is a hard red, forcing harness work or honest deletion instead of silent list growth.
  - addresses: exemption-list graveyards; unenforced caps
- **[medium]** Surface CI retry counts as a first-class signal: fail the run (or alert) when any test passes only on retry. Then begin replacing waitForTimeout-before-assert with expect.poll on the actual RMS/edge/render condition (generalize the acidwarp render-smoke freeze+step pattern) and networkidle with a deterministic __appReady signal.
  - addresses: flake laundering; 555 hard sleeps
- **[medium]** Make the behavioral input-coverage lane a BLOCKING gate for its stable subset (continue-on-error:false, always-on, not label-gated) and add real output reads (AnalyserNode RMS/spectral delta via the existing readScopeSnapshot) to every e2e spec whose TITLE claims audio flows. The 'edge materialised' wire-up check becomes the rare reasoned opt-out, not the norm.
  - addresses: edge-materializes false confidence; non-gating behavioral lane
- **[medium]** Treat collab-nightly #868 as the P0 it is: shard it / drop retries / cut the slow DOOM-WASM-boot specs so it finishes under the ceiling and reports. Then run a THIN real multi-context @collab smoke + a deterministic-floor (SwiftShader-tolerant) WebGL pass on PR CI as required jobs — so the doom/render gates actually execute on the SHA being merged, not just a hash-verify of a hand-writable JSON.
  - addresses: highest-risk lanes never run on PR; dead nightly backstop
- **[large]** Auto-capture linux VRT baselines in CI on the PR branch (the runner is already linux) and use the deterministic DRS freeze path to diff canvas content for video modules in a BLOCKING lane — dropping the 26-card ceiling and the magenta-mask-everything pattern. Make vrt-meta require the platform CI actually runs (linux), so darwin-only baselines count as NOT covered.
  - addresses: VRT covers 13%; canvas render-correctness runs on zero CI modules
- **[medium]** Narrow the attest bases: hash only renderer/sync-relevant pinned versions (not whole package.json) and only files contributing shader/GL bytes (not whole lib/video/**), with docs-hash-ignore markers for doc-only edits — so unrelated dependency bumps and label typos stop forcing owner-local re-attests.
  - addresses: attest over-invalidation treadmill
- **[large]** Build the missing cross-cutting safety nets: (1) commit prior-version Yjs snapshot fixtures + a load/round-trip test against real Hocuspocus+Postgres; (2) a heap-budget 'soak' lane asserting no synced ydoc writes during pure modulation frames + bounded usedJSHeapSize/edge-SVG count; (3) stored-XSS tests threading hostile labels/patches/URLs through the real A→peer collab path + a CSP-presence assert.
  - addresses: Y.Doc persistence, perf/memory, and security coverage gaps (all proven prod incidents)
- **[large]** Extract the per-sample math of high-value worklets into pure lib cores (the adsr-env/moog-ladder pattern) and unit-test numeric behavior; track worklet-entries-with-a-core-test (22/70) as a ratcheting metric. For Faust, render the actual compiled .wasm in ART rather than a hand-written TS mirror, or re-label those scenarios as model unit tests.
  - addresses: DSP correctness unit gap; ART renders a shadow impl not shipped DSP

## False-confidence hotspots (where we THINK we're covered)

- ART 'green' on the entire Moog batch + polyhelm + pentemelodica + analog-vco = a 440 Hz sine stub compared against itself (VERIFIED md5 collision); the most official-looking .f32 baselines have the LEAST real coverage.
- e2e specs titled 'audio flows X → Y → OUTPUT' (attenumix/peaks/clouds/warps/cloudseed) never read the AudioOut — silence, NaN, or wrong transfer function all pass.
- The per-port 'inputs accept signal' sweep (the primary input coverage for the whole registry) only checks an edge id survives in a store the test wrote directly — it bypasses engine.addEdge and proves nothing about behavior.
- The behavioral lane — the ONLY thing that proves input→output — is continue-on-error AND skipped on any PR without the 'behavioral' label (VERIFIED ci.yml:1147,1155); it provides zero merge protection.
- VRT 'covered' is satisfied by a darwin-only baseline CI never diffs; vrt-meta.test.ts:95 rubber-stamps non-coverage as full coverage. The blocking gate is 26 of 188 modules, all static knob cards.
- collab-attest is a REQUIRED gate that runs zero multi-user tests — it verifies a hand-writable JSON exists; the real @collab lane is informational and the nightly has been dead for 6 nights.
- The WebGL 'fail-closed' coverage guard is fail-OPEN for lib-mediated GL: MilkdropCard.svelte (butterchurn) is escaping the basis TODAY (VERIFIED: only getContext('2d')), as would any three.js/regl/pixi/WebGPU card.
- The no-console-errors assertion (sole proof in ~73 specs) cannot catch a 404'd worklet/shader because filterErrors() swallows 'Failed to load resource' — the exact silent-module failure it should catch.
- WebGL attest README claims 'retries=0 to surface flakes honestly' but the normal `task webgl:attest` runs retries=1/MAX_FLAKY=1 and writes the attestation after a flaky recovery.

## Discounted (mean-but-not-true — honesty pass)

- 'preflightSolo lists Spotify / misses Blender' — a cheap shot. The denylist only affects whether the owner's local run starts; it has zero bearing on attestation validity. Low priority.
- 'vitest single-fork forfeits multi-core speedup / order-coupling risk' — speculative (the roaster's own confidence). singleFork is plausibly a deliberate determinism choice for shared registry singletons; not a real pain point today.
- 'EXPECTED_NODE_TYPES has 85 blank lines of cruft' / 'EXPECTED_HEAVY_SPEC_COUNT changelog archaeology' — the cosmetic framing is overblown; the lists DO catch accidental drops/de-registration, just redundantly. Minor maintenance, not a coverage hole.
- 'Zero accessibility coverage / data-testid monoculture' — true but a11y is a known queued deep-dive, not a core correctness/regression risk; the severity framing inflates it relative to the silent-DSP and silent-multiplayer holes.
- 'Certifies Apple M5 — the narrowest possible renderer slice' — partially overstated: an M5 is still a REAL GPU, which is the entire stated point vs CI's SwiftShader. The fair, narrower point (doesn't cover D3D11/Vulkan, so document the scope) survives; 'narrowest possible' does not.
- 'Pyramid inversion: the bulk of CI wall-time is wasted on unit-testable facts' — directionally right but overstated; integrated e2e of the gesture→mutate→sync→engine chain has genuine value the unit layer can't replace. Treat as a rebalancing goal, not waste.
- 'resofilter's tautological cutoff readback' and 'cube two configs share an md5' — valid but single-spec, low blast-radius; subsumed by the broader 'add real output reads / md5-uniqueness guard' actions.
- 'compareBuffers tier C perceptual is a permanent stub' — real but it's an unbuilt aspirational feature, not active false confidence; exact-RMS churn is a nuisance, not a correctness hole. Bundle into the ART real-render work.