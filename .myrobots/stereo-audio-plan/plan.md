# Stereo audio normalization — implementation plan

**Status: FINAL — all 7 owner questions answered 2026-08-03. Ready to implement, starting at PR-0.**
*(Re-verified 2026-08-04: none of the 7 PRs has landed. `stereovca` is still the module id in `packages/dsp/src/`, `art/scenarios/`, `art/baselines/` and both VRT baselines; `reconciler.ts:143`'s `await engine.addNode(node)` is still unguarded, exactly as PR-0 describes. The whole sequence is live backlog.)*
Source: 12-agent ultracode analysis (8 subsystem surveys → 2 competing designs → adversarial + completeness critics), all findings verified against the actual code with file:line cites. Draft questions + owner answers recorded in §1.

## 0. Executive summary

Owner directive: all audio patch cables carry L&R; mono modules are "effectively stereo" via normalling (no new stereo DSP); right-clicking an audio output adds "patch only L" / "patch only R" (a stereo cable with one silent channel); mixmstrs gains per-channel panning; the Stereo VCA is renamed to **ringmod** (not deleted).

**Architecture: the PROJECTION (Option B).** Port ids, the `Edge` shape, the Y.Doc schema, `engine.addEdge`, and every module def's ports stay byte-identical. "One stereo cable" is a **leg group** of the existing per-channel edges, co-created / co-deleted by the wiring layer and rendered as one bezier. "Patch only L" writes exactly one leg. Pairing is derived centrally — declared `stereoPairs` ∪ the existing L/R id-token fallback, **audio-typed ports only**, minus named exemptions. Jack collapse happens **inside PatchPanel**, not per-card.

Why this wins (each alternative measured by the surveys):

- **Zero saved-rack migration** across all five persisted surfaces (file envelopes, live relay Y.Docs, Postgres `saved_groups`, `.ptperf.zip` bundles, committed fixtures). A legacy single-leg edge reinterprets as an only-L cable — audio byte-identical.
- **Zero engine/DSP changes** on the default path. Web Audio already carries N-channel on one connect; mono→stereo normalling = the double-patch both-legs pattern `planSendToMixer`/`planColumnChain` already ship (patch-convenience.ts:391, :564-584).
- **No collab re-attest** except the one PR that adds the `stereovca→ringmod` persistence alias; **no WebGL GPU re-attest** until the deliberately-quarantined PR-5.
- **VRT blast radius is ~20 PNGs (upper 40) of 426, not "every faceplate"** — canvas card faces (the 190 vrt.spec baselines) render NO visible jacks (corner-variant PatchPanel drill-down); only compact lane tiles, rear cards, the audio-io surface, and 2 interaction scenes shift, plus the stereovca→ringmod baseline rename.
- Option A (true port-id merge) was measured at ~2–3× total cost (contract-lock rewrite of ~35 modules, STRICT_DOCS re-key, registry schemaVersion 2→3, a new Edge field in the collab basis, a brand-new port-alias migration substrate) with **zero user-visible gain**.

**Difficulty: ~8–11 agent person-days, 7 PRs, ~10–12 CI cycles (~21–28 min each measured) + 1–2 vrt-update dispatches (~15 min/platform) + one local collab re-attest (~7 min, PR-1) + one trusted-GPU webgl re-attest (PR-5).** Riskiest step: PR-4 (the flip: leg-group semantics + jack collapse + VRT regen).

---

## 1. Owner decisions (LOCKED, 2026-08-03)

| # | Question | Decision |
|---|---|---|
| 1 | Mono-input consumption policy | **Unity-sum via double-connection** (both legs into the mono input; Web Audio sums). The planner special-cases a mono-source leg group into a mono input by writing ONE leg, so a correlated mono round-trip does not gain +6 dB. ART stays byte-identical. |
| 2 | mixmstrs panning | **ADD per-channel pan: 8 params + a row of pan control knobs** on the card. New Faust DSP, contract + ART re-pin, explicit PUSH_CARD_CONTROLS entry, owner audio preview before merge. PR-6 is in scope. |
| 3 | stereovca | **KEEP, renamed to `ringmod`.** It is the project's only transparent (unsmoothed) audio-rate ring modulator; the rename makes that its identity. Docs re-authored accordingly. Port ids unchanged → a type alias preserves every existing cable. |
| 4 | Mixed-source stereo | **Leg-level occupancy**: a full-stereo patch replaces both legs of the target; an only-X patch replaces only the X leg — so A-only-L + B-only-R into one input coexist. |
| 5 | Look-and-feel | **Recommendations accepted**: dashed stroke + channel tag for only-L/R cables; unpatch-menu "(L only)" labels; one lane-rail dot per stereo port; rear card gets a single stereo hole (pair-tie retired). Pre-approved; PR-4 still posts a preview deploy as confirmation before the VRT dispatch bakes baselines. |
| 6 | Attest machine | **Available whenever needed.** PR-5 unblocked. Note the machine-access grant does not fix the 2 failing cameraInput tests (webgl-attest-video-orientation-camera-fail memory) — verifying/fixing those is the first task of PR-5. |
| 7 | CI cost | **Approved.** |

### Decidable defaults (locked with the above)

- **Only-L/R representation = single-leg edge**, never an Edge field: no Y.Doc schema change; the reconciler's id-only diff (reconciler.ts:153) and endpoint-derived edge-id collisions rule out a mutable `channels` field anyway.
- **Derived pairs apply to audio-typed ports ONLY.** ringmod's `strength_l`/`strength_r` are cv-typed → they stay two independent jacks, preserving independent per-channel gain/ring depth. (This is what keeps Q3's capability intact.)
- **Collapse exemptions** (semantic non-pairs stay two jacks): rings `['odd','even']` (two timbre taps — but it KEEPS its declared-pair autowire behavior, which is shipped and e2e-pinned at stereo-autowire.spec.ts:90; jack-collapse and autowire consult SEPARATE lists), scope ch1/ch2, synesthesia band outs, es9's 16 class-tagged hardware jacks (es9 `spdif_l/r` DOES collapse). Collapse includes: audioOut L/R, audioin, mixmstrs channel pairs + masterL/R + send pairs, qbrt, meowbox, ringback, cube, hypercube, wavesculpt, samsloop in-pair, ringmod in/out pairs, all 16 declared stereoPairs, 9 video-def pairs.
- **behavioral-smoke subset**: unchanged membership — rename `stereovca`→`ringmod` in ci.yml:2146's grep AND INTENDED_SUBSET (behavioral-smoke-subset.test.ts:58) in the SAME commit.
- **Old racks**: `RETIRED_TYPE_ALIASES { stereovca: 'ringmod' }` (persistence.ts:73-88) — identical port ids mean the alias keeps ALL cables on file/performance load. Live relay docs: PR-0's reconciler hardening prevents wedging; add a cheap registry/engine-level type alias so live 'stereovca' nodes materialize as ringmod too (decide exact seam at implementation — if it turns out invasive, fall back to skip-with-warning + optional elected-writer rename per the singleton-cleanup pattern).
- **ART capture labels keep their names**; stereovca ART scenario/baselines/fingerprint keys rename to ringmod → `task art:update` re-pin (content byte-identical, keys move).
- **No visible mono-policy param** on modules — policy is a wiring constant (avoids push-card re-ranking + contract churn).
- **VRT regen route**: ONE unscoped both-platform vrt-update dispatch (measured 14–16 min/platform, sequential).

---

## 2. Load-bearing facts (measured by the surveys)

- **Edge realization**: plain audio edge = one `sout.node.connect(din.node, sout.output, din.input)` at engine.ts:500; port handles are `Map<portId,{node,output/input}>` (engine.ts:37-40). Cross-domain bridges connect independently at engine.ts:1797/:1802/:1865.
- **`stereoPairs` today**: declared on 16 defs (naming inconsistent: `in_l`/`inL`/`audio_l`/`L`); consumed by stereo-autowire (both-defs-must-declare, stereo-autowire.ts:100-129), patch-convenience (declared → id-token fallback chain at resolveMainAudioOut :247), docs (contract-signature :113 "stereo l+r" lines, io-explain :143), column-reconcile, module-manifest (its `parseStereoPairs` regex at :1084 CANNOT parse mixmstrs' backtick-computed pairs — live doc-parity bug), registry manifest schemaVersion 2.
- **The registry doc-comment lies**: "engine virtually duplicates to R" — engine.ts contains ZERO stereoPairs/normalling code. Today a drag-patched mono→L leaves R silent unless the module normals internally or a convenience planner double-patched. Any plan assuming engine normalling would build on sand.
- **19 audio modules + 9 video modules have L/R pairs with NO declaration** — paired only by patch-convenience's id-token fallback (LEFT/RIGHT_WORDS, :82-86). A **fifth independent pairing heuristic** lives in rear-card-model.ts:178-189 (`pairWithPrev`) and must be unified.
- **Faceplates**: 208 cards; 188 import PatchPanel; 144 derive ports via `portsFromDef` (card-kit.ts:57) — collapse there is free. ~44 hand-build descriptor lists; MixmstrsCard hand-picks ids and `pickInputs` SILENTLY DROPS unknown ids (:62-88). WebGL-basis cards (CubeCard :996-998, HypercubeCard :816-818, WavesculptCard :2904-2905 hand-list L/R descriptors; FoxyCard :48-49 overrides labels "OUT L"/"OUT R") must stay byte-identical until PR-5 → **collapse must be implemented centrally in PatchPanel keyed on derived pairs, not by editing card files**.
- **Instruments are mono-blind**: AnalyserNode analyzes a mono downmix per spec. The terminal e2e audibility tap (audio-out.ts:138-142, `read('outputSnapshot')`) reads ~half-level for only-L and ~0 for anti-phase stereo — only-L vs only-R are INDISTINGUISHABLE on it. Per-channel taps must land BEFORE any only-L/R e2e. ~25 module files call getFloatTimeDomainData; ~8 e2e specs read outputSnapshot with level asserts that shift +6 dB once UI patches write both legs — sweep them.
- **ART is structurally blind to this change**: captures are 48 kHz MONO per label; only 6 scenarios use the real-def factory path; the rest drive DSP cores directly. The projection forces NO ART re-pin beyond the ringmod key rename — and ART can NEVER see the graph normalling policy; e2e must own that gate.
- **Persistence**: edges dead-drop on stale portId at file load (visible diagnostic); on live relay sync a deleted/unknown node type **permanently wedges every peer's reconcile** (unguarded engine.addNode throw at reconciler.ts:143 aborts the pass, re-throws every snapshot). Hardening is a hard prerequisite of the rename.
- **mike AI patching** writes audio edges via its own `ydoc.transact` (mike/driver.ts:79-105), bypassing all three Canvas commit paths — it must route through the leg-group planner or AI patches stay single-leg.
- **Canvas handleDelete (:4069)** deletes exactly the xyflow payload edge ids — with sibling legs deduped to one rendered edge, deletion must expand to the leg group or Backspace orphans a dashed only-R cable. Same for the wcol-detach branch (:4077).
- **CI**: required = typecheck+unit+ART+E2E umbrella (includes GATING webgl-attest) + vrt-strict. collab-attest is informational at PR time BUT behavioral-watchdog screams P0 on main for a stale collab hash — attest before merge. Measured green-run total 21–28 min; vrt-update 14–16 min/platform; concurrency cancel-in-progress punishes drip-pushing — batch pushes.
- **vrt-strict prediction**: strict faces are dock/corner variants that render no jacks → expected GREEN through the flip. VERIFY locally with `task vrt` before the first push (the two designs disagreed here; settle it with a measurement, not a belief).

---

## 3. PR sequence

### PR-0 — reconciler hardening (tiny, prereq)
Wrap the unguarded `engine.addNode` at reconciler.ts:143 in the same per-item try/catch as addEdge (:165-172): warn once per node id, record in a failed set, continue so later nodes/edges/params materialize. Unit test: snapshot with an unknown-type node + valid later nodes asserts the later ones apply and the failure logs once. reconciler.ts is in NO attest basis.
Gates: web unit lane; `REPEAT=3 task test:one -- reconciler`; typecheck. 1 CI cycle.

### PR-1 — rename stereovca → ringmod (+ persistence alias + collab attest)
The module survives with identical ports (`in_l/in_r/out_l/out_r` audio, `strength_l/strength_r` cv, level/offset params) and identical DSP; its identity becomes the ring modulator.
- **Files rename**: stereovca.ts → ringmod.ts (def `id`/`label` → lowercase `ringmod`; registration is glob-driven per #551 so the rename auto-registers), stereovca.test.ts → ringmod.test.ts, StereovcaCard.svelte → RingmodCard.svelte, packages/dsp/src/stereovca.ts → ringmod.ts. Re-author co-located `docs` as THE ring modulator (audio-rate unsmoothed multiply; strength_l/r stay independent cv jacks) — module stays in STRICT_DOCS (key renamed).
- **Alias**: `RETIRED_TYPE_ALIASES { stereovca: 'ringmod' }` in persistence.ts (identical port ids → alias keeps ALL cables); fixture test copying retired-type-migration.test.ts asserting edge survival. Live-doc story per §1 defaults.
- **Registry key renames** (same lines the deletion would have hit): module-manifest.ts DESCRIPTIONS :314 (new ring-mod prose) + PORT_NOTES :689-694; strict-docs.ts:142; modules-card-map.test.ts:54; interactive-doc-modules.ts:103; mike/catalog.ts:71 (out of `vcas`, into an fx/ringmod role); rack-sizes.ts:133 + rack-sizing.test.ts:121-124 (stays the 1u reference, key renamed); cv-scale-registry.test.ts:125 (PASSTHROUGH entry key); vrt-exemptions.ts:899 STRICT_VRT_MODULES; build_gallery.py:142; behavioral spec :888 param-override key; coverage-groups-3-4-5.spec.ts:721-756 (test SURVIVES renamed — keeps the independent per-channel strength-CV coverage); sidecar.spec.ts:151; docs-virtual-module.spec.ts:304; **ci.yml:2146 grep + behavioral-smoke-subset.test.ts:58 in the SAME commit**; docs prose: docs/testing/README.md:42, e2e/MODULE-COVERAGE-PLAN.md:110.
- **VRT**: `git rm` vrt.spec.ts stereovca.png (darwin+linux pair, gap-neutral); the renamed scene's baselines are MISSING → captured by dispatch or local darwin run (missing always writes). STRICT entry renamed keeps vrt-meta green only once baselines exist — capture in-PR.
- **ART**: rename art/scenarios/stereovca/ + art/baselines/stereovca/ → ringmod; fingerprint keys `stereovca/out_l|out_r` → `ringmod/...`; `task art:update` (content-identical, keys move; .sha last).
- Accept loops in order: `task docs:accept` (contract-lock: stereovca block → ringmod block) → `task art:update` → `task test:ledger:accept`. ONE batched push.
- **Attest**: persistence.ts is in the collab basis → run `task collab:attest` after the final source commit, as the last unmerged basis-toucher.
Gates: full local `task test` + `task art` from clean dsp dist; REPEAT=3 on renamed/edited specs. 1–2 CI cycles. Then `task pr:conflict-sweep`.

### PR-2 — instruments + pairing infrastructure (behavior-invisible)
(a) **Per-channel terminal taps**: ChannelSplitter(2) post-limiter in audio-out feeding two analysers; new read keys `outputSnapshotL`/`outputSnapshotR` beside the mono one (read keys are not ports → zero contract churn). Negative-control BOTH directions in a unit/e2e helper: only-L in → L reads, R ~0; then inverted.
(b) **parseStereoPairs backtick fix** (module-manifest.ts:1084) + computed-tuple test case — closes the live mixmstrs doc-parity gap.
(c) **`graph/stereo-pairs.ts`**: `derivedStereoPairs(def)` = declared `stereoPairs` ∪ the id-token fallback (lift idWords/LEFT_WORDS/RIGHT_WORDS from patch-convenience.ts:82-86; patch-convenience re-imports), **audio-typed ports only**, minus the named per-(module,pair) exemption sets. TWO lists, separately consulted: `COLLAPSE_EXEMPT` (rings odd/even, scope ch1/ch2, synesthesia bands, es9 hw jacks) and autowire behavior (rings keeps its shipped declared-pair autowire). Golden unit test pins the FULL derived pair map across all 194 registry modules, ratcheted both directions (count + content).
(d) **Unify rear-card-model.ts:178-189** pairing onto derivedStereoPairs (kills the fifth heuristic); patch-panel-labels.test.ts:128 (`'out_l'→'OUT L'`) updated with collapsed-label policy.
Gates: unit lane; REPEAT=3 new tests; assert `task docs:check` is a no-op (no def edits). 1 CI cycle.

### PR-3 — wiring semantics: universal leg-group planner
Generalize `planStereoAutowire` → the universal audio commit planner over derivedStereoPairs: stereo↔stereo = L→L,R→R; mono→stereo = double-patch; stereo→mono = **unity-sum both legs** (Q1), with the mono-source-round-trip special case writing one leg; `channelMode: 'both'|'left'|'right'` selects legs. Route ALL audio edge writers through it: Canvas handleConnect (:3773), pickPortMenuTarget (:6324-6398), commitCarriedEdge (:6243), `writeStereoSiblingEdge` generalizes (:3641) — **plus mike/driver.ts:79-105**. **Leg-level occupancy** (Q4): full patch replaces both legs; only-X replaces only the X leg. Leg-group deletion: handleDelete (:4069) + wcol-detach (:4077) + unpatch-menu.ts/UnpatchMenu.svelte expand to the group; "(L only)" label.
Tests: stereo-autowire.test.ts rewritten (mandatory legs, only-L/R, leg occupancy, unity-sum policy — the policy gets its FIRST explicit assert anywhere); patch-convenience{,-columns}.test.ts updated; schema-cleanup-roundtrip golden untouched (no Edge field change).
Gates: REPEAT=3 every changed unit file; e2e stereo-autowire.spec.ts rewritten (keeps the only full jack-click→carry→picker→commit e2e). NOT in any attest basis. Lands back-to-back with PR-4 (merge PR-3 only when PR-4 is ready for review, so main never sits long in the two-jacks-render-but-patch-writes-both state). 1–2 CI cycles.

### PR-4 — THE FLIP: jack collapse + only-L/R menu + cable rendering + VRT regen (riskiest)
- **PatchPanel-central collapse**: render one jack/row per derived pair, keyed on module type — card files pass their existing descriptors; PatchPanel merges pair rows. WebGL-basis cards (Cube/Hypercube/Wavesculpt/Foxy + video cards) stay BYTE-IDENTICAL; their faces still collapse because the collapse lives in PatchPanel. Both hidden xyflow handles remain co-located so either leg anchors.
- MixmstrsCard sections (:62-88): verify every hand-picked id survives (pickInputs drops unknowns SILENTLY — count rendered rows in a test); audit the ~44 hand-descriptor cards (17 reference L/R ids).
- AudioIoSurface.svelte:57,85 (workflow dock AUDIO I/O rows) collapse + only-L/R handling; RearCard.svelte:321 tie → single stereo hole (Q5).
- **PortContextMenu**: "patch only L"/"patch only R" rows when source is an audio output with a derived pair; `portMenuChannelMode` threaded into the commit paths; bind the currently-dead unpatched-output-row contextmenu on PatchPanel (:393) without fighting the patched-row unpatch menu. (Video/game raw-handle cards get the menu via the existing document-level contextmenu path — parity from day one since pairing is derived, not declared.)
- **Cable rendering**: flowEdges mapper (Canvas:2567) dedupes sibling legs to one rendered edge; single-leg gets `cable-left-only`/`cable-right-only` dashed class + channel tag (global.css:99-135); PickupCable ghost matched.
- **New e2e**: right-click → only-L → assert `outputSnapshotL` audible AND `outputSnapshotR` silent; inverted for only-R (PR-2 instrument; audio RMS, no frame waits). A leg-occupancy e2e: A-only-L + B-only-R coexist. Sweep the ~8 existing outputSnapshot-consuming specs for +6 dB threshold shifts.
- **Example patches**: audit/re-save ui/example-patches/*.imp.json (glitches.imp.json has 3 single-leg out_l→in_l edges that would render dashed) + e2e/fixtures/cold-load-patch.ptperf.zip.
- **VRT cycle** (drain-first discipline): run every affected scene locally on darwin, READ printed pixel diffs; classify over-tolerance (dispatch rewrites) vs under-tolerance-changed (`git rm` as darwin+linux PAIRS — the #1213 trap); drain the 5 pending linux EXEMPT_BASELINE_PAIRS in the blast set (dx7/qbrt/shimmershine/sixstrum/tomtom) + lower LINUX_DEFICIT_CEILING(148) + SHARED_LINUX_PAIR_CEILING(91) + `task test:ledger:accept` in ONE commit; preview deploy for owner confirmation (pre-approved Q5); push once; ONE unscoped both-platform `gh workflow run vrt-update.yml -f ref=<branch>` (never `-f grep`); approve `action_required` follow-ons; **COUNT bot-committed PNGs vs the local failure list**; revalidate close+reopen; merge on final-commit green. Apply the `behavioral` label pre-merge (6-shard lane runs before it can trip the push-only watchdog).
Gates: vrt-strict expected green (verify with local `task vrt` BEFORE first push); expected shift ~20 PNGs (upper 40). 2–3 CI cycles + 1 dispatch. Then conflict-sweep.

### PR-5 — declared-pairs parity + attest batch (UNBLOCKED per Q6)
First task: verify/fix the 2 failing cameraInput tests that block `task webgl:attest` (webgl-attest-video-orientation-camera-fail memory; parked since #979) — they are a test problem, not a machine-access problem, and Q6 grants the machine.
Then: declare `stereoPairs` on the 19 undeclared audio modules + add optional `stereoPairs` to VideoModuleDef + declare on the 9 video defs; clean Foxy/Cube/Hypercube/Wavesculpt card L/R descriptor rows and labels; deny-by-default lint: every L/R-token audio pair must declare stereoPairs or sit in the named opt-out list, ratcheted both directions; then shrink the id-token fallback in derivedStereoPairs toward declarations-only. Capstone items ride along: delete the then-unreachable id-token fallback branch in patch-convenience resolveMainAudioOut/In; io-explain prose sweep; memory updates.
Gates: `task docs:accept` (+~26 additive stereo lines, review per-module — beware precedence interaction: declarations enter resolveMainAudioOut ahead of the fallback; patch-convenience.test.ts:499-506 pins mixer behavior); trusted-GPU `env WEBGL_ATTEST_ALLOW_BUSY=1 task webgl:attest` as the LAST unmerged basis-toucher (kill 5173/4173 + clear node_modules/.vite first — stale-bundle false refusal). 1–2 CI cycles.

### PR-6 — mixmstrs per-channel pan (IN SCOPE per Q2)
New per-channel pan in packages/dsp/src/mixmstrs.dsp (equal-power law — reuse equal-power-pan.dsp's approach; pan placement: post-EQ/comp, pre-master sum) + 8 `pan1..pan8` params in mixmstrs.ts + **a row of 8 pan knobs** on MixmstrsCard + explicit PUSH_CARD_CONTROLS entry (new params re-rank the generic push card — pin it) + contract re-pin (`docs:accept`) + mixmstrs ART re-pin (`art:update`, entry-by-entry review; pan@center should be level-neutral — a moving entry NOT attributable to the pan law is a regression) + mixmstrs VRT baselines (card face changes: knob row) + **owner audio preview before merge** (level-affecting). 1–2 CI cycles + possible small vrt dispatch (can share PR-4's if sequenced adjacently, but keep the PRs separate — DSP + look changes both want isolated review).

---

## 4. CI fast-path summary

- Strict sequence PR-0 → 1 → 2 → 3 → 4 → {5, 6 in either order}. PR-2 and PR-3 can develop in parallel worktrees (cap 10, `task worktree:guard`) but LAND sequentially — they collide on module-manifest.ts/contract-lock/ledger.
- Front-load each PR exactly per repo discipline: `rm -rf packages/dsp/dist` + `task dsp:build` → `task typecheck` → full `task test` (all accept-loop gates live in the web unit lane) → accepts with reviewed diffs → `task e2e:serve` + targeted `REPEAT=3 task e2e:one/vrt:one` → `E2E_SWIFTSHADER=1` for renderer-dependent asserts → ONE batched push (cancel-in-progress).
- Attest choreography: PR-1 carries the only collab re-attest (persistence alias); PR-5 carries the only webgl re-attest. PR-0/2/3/4 touch NO attest basis — keep it that way during implementation and re-verify against the basis lists before each merge.
- Hazards: mass-PNG rewrite invalidates the lfs-vrt cache key (one-time giant LFS pull, no retry loop — the 502-incident shape); pre-regen informational vrt lane may hit its 20-min ceiling (acceptable; vrt-strict has 2× headroom); vrt-update bot pushes land follow-ons in `action_required` — approve, don't wait.

## 5. Migration story

Near-none, by construction. All five persisted surfaces load unchanged; legacy single-leg edges render as dashed only-L cables (audio-identical); legacy double-patched pairs render as one stereo cable. stereovca racks: `RETIRED_TYPE_ALIASES` renames the node and keeps every cable on file/performance load (identical port ids); live relay docs materialize via the registry-level alias (or skip-with-warning fallback per §1). Committed example patches are re-saved in PR-4 so shipped content doesn't render dashed.

## 6. Top risks

1. **PR-4 leg-group semantics** — occupancy, deletion, dedupe across three commit paths + mike. Mitigation: PR-3 lands the planner with exhaustive unit coverage first; the e2e rewrite keeps the only full click→commit flow gate.
2. **Sub-tolerance VRT invisibility** (#1213 class) — a removed jack dot « DOCK_MAX_DIFF commits nothing on a green dispatch. Mitigation: measure every affected scene locally; `git rm` pairs; count bot PNGs.
3. **MixmstrsCard silent id-filtering** — mitigations: row-count assert + the PatchPanel-central collapse minimizes card edits.
4. **Instrument blindness** — only-L/R e2e MUST use the PR-2 per-channel taps; never the mono downmix tap. Residual: non-terminal taps (scope, behavioral metric) stay mono-downmix — a dead-R inside a chain reads −6 dB, not failure, anywhere but the master out. Accepted + documented; revisit if it bites.
5. **Unity-sum audibility edges** — the planner's mono-round-trip special case contains the +6 dB case, but a user manually patching both legs of a correlated source into a mono input still sums hot (faithful to Eurorack). ART cannot see policy; the new stereo-autowire unit asserts + e2e own it.
6. **mixmstrs pan** (PR-6) — new DSP on the most-connected module; pan@center must be bit-transparent or every mixmstrs ART entry moves. Gate: fingerprint diff attribution before re-pin + owner ears.

## 7. Verified-clean surfaces (do not re-sweep)

Control surfaces (push2/launchpad/electra/monome — port-blind; Launchpad "L/R" are device units), packages/server/src (byte-opaque), interactive docs hover panes, grand attest (grand-integration.attest.spec.ts already pins BOTH masterL/R legs at :330-331 — mandatory both-legs does not move the golden), PUSH_CARD_CONTROLS (ports are provably invisible to push-card ranking — only a new PARAM re-ranks; mixmstrs' new pan params in PR-6 are exactly that case and get a pinned entry).
