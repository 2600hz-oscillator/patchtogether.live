# TOYBOX randomize — implementation plan

**Date:** 2026-08-13
**Inputs:** `.myrobots/2026-08-13-random-preset-prior-art.md` (generalized requirements R1–R25),
owner directives (a)–(g), read-only recon of the TOYBOX file family.
**Companion tickets:** `.myrobots/2026-08-13-ticket-toybox-randomize.md` (the work),
`.myrobots/2026-08-13-ticket-toybox-sandbox-subsite.md` (the deferred subsite this plan's
architecture phase deliberately serves).

---

## 1. Problem statement

TOYBOX is the deepest module in the app (~20k lines across
`packages/web/src/lib/video/modules/toybox.ts`, `packages/web/src/lib/ui/modules/ToyboxCard.svelte`,
16 pure helpers, 5 Yjs mutators) — 4 layers × 7 content kinds, a 17-op internal combine
DAG, 6 modsignal + 2 video inputs — but exploring it requires authoring. The owner wants a
one-press **randomize** that yields a *new, interesting* patch every time, that **uses
whatever the user has patched in** (video/audio/CV) rather than ignoring it, that rolls
**both layer content and the node graph**, that respects **right-click locks** on nodes and
layers, and that draws on a **significantly expanded** shader/OBJ bank.

Constraint (g), owner directive: the subsite vision (toybox.patchtogether.live — paste
shaders, upload OBJs, run them in TOYBOX) requires architectural changes — a dynamic asset
registry, first-class params for arbitrary GLSL, a shader validation seam. **Those land
first**, so randomize is built on the new architecture instead of being rebuilt later.

Today there is no randomize anywhere in TOYBOX, no shared RNG utility in the repo, and no
seed plumbing (`__toyboxFreeze(time?, seed?)` at `ToyboxCard.svelte:2016` is a VRT-only
hook). Asset enumeration is a hand-maintained static JSON
(`packages/web/static/toybox/manifest.json`, fetched via `TOYBOX_MANIFEST_URL` at
`toybox-content.ts:127`), and user-loaded shaders are second-class: no declared params, so
no faders, no CV targets, nothing a randomizer could roll.

## 2. The key architectural decision

**One seam, three consumers.** The randomizer, the existing disk-load path, and the future
subsite all need the same three capabilities, so they are built once, in
`lib/video/toybox-*` pure helpers, before any dice exist:

1. **Asset provider seam.** An enumeration interface (`listContent(kind)` / `getSource(id)`
   / `listModels()`) with two implementations: the static-manifest provider (current
   behavior, zero user-visible change) and a runtime provider for session-registered
   assets. `toybox-content.ts`'s direct manifest fetch moves behind it. The randomizer
   enumerates **through the provider, never the manifest**, so subsite-uploaded assets are
   randomizable on day one of the subsite with no engine change.
2. **First-class params for arbitrary GLSL.** `extractShaderParams(src)` parses
   `uniform float <id>;` declarations plus an optional `// @param(min,max,default,curve)`
   annotation into the exact `params[]` shape manifest entries use. The manifest-integrity
   test's "declared param must appear as a uniform" cross-check
   (`toybox-manifest-integrity.test.ts`) is re-expressed on the same parser — one parser,
   both directions. Custom/uploaded shaders gain faders, CV targets, and randomize
   targets; the subsite gains paste-a-shader-get-controls.
3. **A validation probe.** `validateToyboxShader(src)`: offscreen compile + structured
   error. Today bad GLSL only degrades at render time
   (`e2e/tests/toybox-disk-loading.spec.ts` covers the degrade). The probe serves
   disk-load now, the randomize CI liveness harness next, and subsite paste-validation
   later.

A second, equally load-bearing decision: **the randomize engine is a pure function**
`(seed, context, locks) → data blob`, applied through the existing in-place Yjs machinery
(`applyDataBlobToData`, `graph/toybox-presets.ts:168`) in **one `LOCAL_ORIGIN` transact**
(`graph/store.ts:39`). Because all TOYBOX state lives in `node.data` and both renderers
(main factory and `worker/toybox-worker-handle.ts`) consume the synced data, the engine
needs **no dual implementation** — the two-renderer parity trap in the recon does not
apply to the dice, only to new ops (we add none). And because the rack store already has a
Yjs `undoManager` tracking `LOCAL_ORIGIN` (`graph/store.ts:48`), one transact per roll
gives per-roll Cmd-Z for free.

## 3. Phases and PRs (sequencing per owner directive g)

### Phase A — architecture prep (PR-1) · *serves the subsite, consumed by randomize*
- Asset provider seam; migrate `getContent`/model fetch in `toybox-content.ts` behind it;
  the existing file-picker ingest (`setLayerShaderSource` at `graph/toybox-layers.ts:277`,
  `setLayerObjSource:298`) becomes the runtime provider's first real consumer.
- `extractShaderParams` + `// @param` annotation grammar; wire custom shaders into the
  same fader/CV-target path manifest shaders use (`OP_PARAMS`-style plumbing already
  exists for ops at `toybox-combine-graph.ts:246`; layer params flow via
  `toybox-control-params.ts`).
- `validateToyboxShader` compile probe; disk-load calls it and surfaces the error instead
  of silently degrading.
- **No visual change** → no VRT churn. Every touched file is in the webgl-attest basis
  (basis walks `packages/web/src/lib/video` excluding `.test.ts`,
  `scripts/webgl-attest-lib.ts:237`) → one `task webgl:attest` re-pin, run LAST on the
  merged tree.

### Phase B — asset expansion (PR-2) · *requirement (e)*
- A significant drop of new GEN/FX/FRAG shaders and OBJ models (current bank: gen 28,
  shaders 21, models 22 in `manifest.json` — target roughly doubling shader families and
  ~+10 models, weighted so every archetype family in Phase D has multiple members:
  feedback/organic/geometric/glitch/3D-scene/texture-source).
- **License discipline is the gate**: the integrity test currently requires a license tag
  on models only (`toybox-manifest-integrity.test.ts:204`) — extend it to shaders in this
  PR (deny-by-default; every entry carries provenance). Only CC0/MIT/original material.
  NO Shadertoy imports under Shadertoy's default CC BY-NC-SA license.
- New shaders use the Phase-A `// @param` annotations; the integrity test's
  min≤default≤max / uniform-exists assertions are already derived (they iterate the
  manifest — no counts to maintain).
- VRT: add hand-listed representatives of each NEW family to `e2e/vrt/vrt-toybox.spec.ts`
  (its CONTENTS/MODELS arrays are representatives, not manifest-driven); baselines via
  `task vrt:commit` dispatch (Linux CI authors; count committed PNGs against prediction).
- Static assets are **not** in the attest basis → no re-attest for this PR (keep the
  integrity-test edit in this PR too; tests are basis-excluded).

### Phase C — lock UX (PR-3) · *requirement (d)*
- Data: optional `locked` flag on `ToyboxGraphNode` (`toybox-combine-graph.ts:195`) and on
  `ToyboxLayer` (`toybox-content.ts:571`). `applyDataBlobToData` clones layer/node objects
  wholesale, so the flag rides user presets and zip round-trip — assert that in the
  `-ydoc` test tier.
- Mutators: `setCombineNodeLocked` (in `graph/toybox-combine.ts`), `setLayerLocked` (in
  `graph/toybox-layers.ts`), in-place Yjs discipline like every sibling.
- UX: `ToyboxNodeMenu.svelte` `node` target (`MenuKind` at `:31`) gains Lock/Unlock; layer
  tabs (`toybox-layer-tabs`, `ToyboxCard.svelte:2212`) gain a right-click lock; lock badge
  glyph on SVG editor nodes and layer tabs.
- **Honest scope (R25):** locks constrain the *dice*, not the user — manual edits to a
  locked element stay allowed. Documented in the card and in `docs`. (Owner question #2.)
- VRT: badges move node-editor/card baselines → `task vrt:commit`.
- `toybox-combine-graph.ts` is in the attest basis → re-attest.

### Phase D — the randomize engine (PR-4 pure engine, PR-5 button + e2e + VRT)
**PR-4 (pure, no UI, no VRT):** `lib/video/toybox-random.ts` +
`toybox-random.test.ts`.
- Seeded PRNG (sfc32/mulberry32-class, tiny, no dependency).
- **Context probe first** (R13/owner b): inputs = which of `cv1..cv6`/`inA`/`inB` have
  inbound rack edges and of what kind. Engine-side this already exists (`inboundEdge` at
  `modules/toybox.ts:1346`, `kindFor:1358`); the card-side roll reads `patch.edges`
  directly with the same predicate. Patched video ports are **locked-by-default sources**:
  every roll must place a `video`-kind layer with `videoSource:'inA'|'inB'` for each.
  Patched cv/gate/audio ports must each receive a `cvRoutes` entry targeting a live param
  in the rolled result. Rack-level edges are never created, moved, or severed.
- **Structure before scalars** (R2): a named archetype table — each entry
  `{id, why, weight, build(rng, ctx, locks)}` — hand-designs a topology family (e.g.
  feedback tunnel, keyed collage over a source, OBJ scene + displace chain, FRAG
  post-processing a gen stack, datamosh/desync glitch chain), then content is drawn from
  the **provider** weighted by family, then scalars roll from curated ranges (manifest
  `params[]` min/max/default as the base envelope, narrowed by a per-param range table
  where full range is hostile). Correlated draws within an archetype (R3, R6).
- **Locks** (R12/owner d): locked layers/nodes are copied byte-identical into the
  candidate; the archetype builder receives them as fixed context and builds around them
  (their inbound edges and content untouched).
- **Liveness** (R5): by construction + verify. Construction: every archetype guarantees a
  source→output chain; `validateConnect`/`wouldCreateCycle`/`topoSort`
  (`toybox-combine-graph.ts`) run on the candidate; curated ranges exclude known-dead
  zones (mix=0 into black, fully-closed keyers). Verify: bounded reject-and-retry (cap ~8)
  on any validation failure, then **fall back to a known-good archetype** — a press never
  fails and never exceeds its latency budget (R24). GPU-readback liveness is the **CI
  instrument** (per-seed sweep, §5), not a per-press runtime gate (owner question #3).
- **Exclusions** (R4): never touches `name`, `combineView.h`, `cvInputs` attenuverters,
  rack wiring, or anything outside `node.data`'s layers/combine/cvRoutes.
- **Anti-repeat** (R7): caller passes recent archetype ids; the generator excludes them.
- **Postconditions asserted in-engine**: `findOrphanedRoutes` (`toybox-cv-routes.ts:359`)
  returns `[]` on every result — unconditional, not a ceiling.
- **Mutate as well as generate** (R9/R10): `mutate(seed, current, amount, locks)` — at low
  amount, scalar nudges within curated ranges on the existing structure; at high amount,
  structural swaps; amount is continuous.

**PR-5 (UI + proof):**
- Dice button on the card header (one gesture, no dialog, R15–R17); press = probe →
  generate → `undoManager.stopCapturing()` → one `LOCAL_ORIGIN` transact applying the
  blob in place (`applyDataBlobToData` pattern — never spread-and-reassign; Yjs "Type
  already integrated" trap).
- Safety (R18/R20/R22): restore point captured at first roll of a session (data blob;
  optionally auto-saved via `toybox-user-presets.ts` `saveUserPreset`); session history
  ring of the last ~8 rolls with back/forward; save-as-user-preset is the existing one
  gesture. Cmd-Z per roll via the existing undo manager.
- Mutate amount control as a secondary affordance (flyout/modifier — owner question #4);
  the primary press stays zero-config.
- e2e hook `__toyboxRoll(seed?)` registered beside `__toyboxLoadPreset`
  (`ToyboxCard.svelte:2022`) — the determinism plumbing for every test below.
- DESCRIPTIONS boy-scout: the `toybox` entry in
  `packages/web/src/lib/docs/module-manifest.ts` is already stale (omits image/video
  kinds) — update it to cover randomize + the missing kinds in this PR.
- VRT: card chrome changes → baselines.

## 4. Prior-art requirements → TOYBOX mechanisms

| Requirement (headline) | TOYBOX mechanism |
|---|---|
| Curated, not uniform; utility state excluded | Per-param curated range table over manifest/`OP_PARAMS` envelopes; engine structurally cannot write `name`/`combineView`/`cvInputs`/rack edges |
| Structure first, then scalars | Named weighted archetype table → combine-DAG topology → provider-drawn content → correlated scalar rolls |
| Liveness — never black | Archetypes guarantee source→output chains; `topoSort`/`validateConnect` on candidates; curated ranges exclude dead zones; capped reject loop + known-good fallback; per-seed GPU readback sweep in CI |
| Generate AND mutate with amount | `generate(seed, ctx, locks)` + `mutate(seed, current, amount, locks)`, continuous amount |
| Scoped randomization + locking | `locked` on layers and combine nodes (Phase C); locked elements byte-identical across rolls; scope = the unlocked remainder |
| Context-aware — patched sources are load-bearing | Edge probe per port (`inboundEdge`/`kindFor` pattern); patched video ⇒ mandatory video layer; patched cv/gate/audio ⇒ mandatory live `cvRoutes` entry; rack edges never touched |
| One gesture, instant, cheaply repeatable | Card dice button, no dialog; apply = one Yjs transact; bounded generation cost (retry cap + fallback) |
| Never destroy user work | Session restore point, per-roll Cmd-Z (existing `undoManager` + `LOCAL_ORIGIN`), history ring, one-gesture save via user presets; atomic apply in one transact |
| Seedable determinism | Pure `(seed, ctx, locks) → blob`; `__toyboxRoll(seed)` hook; peers converge on the *data* (the roll happens on one peer and syncs as state, so determinism is a test/repro property, not a collab requirement) |
| Acceptance: N≥20 alive + distinct | CI seed sweep (§5) asserts liveness and structural anti-repeat per-seed; perceptual distinctness/keep-rate is the owner's manual review pass |

## 5. Testing strategy (repo standards applied)

**Unit (vitest, PR-4 mostly):**
- Determinism: same seed + same context ⇒ deep-equal blob.
- Lock invariant: for a spread of seeds, roll with locked elements ⇒ locked layer/node
  deep-equal before/after (property loop, not examples).
- Context invariant: synthetic edge sets ⇒ every patched video port selected by some
  layer; every patched cv port owns a route to a param that exists in the result.
- Exclusion invariant: `name`/`combineView`/`cvInputs` byte-identical across rolls.
- Postcondition: `findOrphanedRoutes(result)` `toEqual([])` — unconditional (rule 1 of
  the population-count standard; no ceilings).
- Archetype coverage: **derived membership** — iterate the archetype table itself and
  assert each entry generates a valid blob; never assert "there are N archetypes".
  Each entry carries a required `why` field (the shape-in-the-type pattern).
- Graph validity: every generated combine graph passes `validateConnect`/`topoSort` with
  zero dropped cycle edges.
- Yjs tier: lock mutators + `locked`-flag blob round-trip in the `-ydoc` tests, matching
  the in-place discipline of the existing `graph/toybox-*-ydoc.test.ts` files.
- Param extractor: annotation grammar cases + the re-based manifest-integrity cross-check
  (Phase A).

**e2e (PR-5):**
- `e2e/tests/toybox-randomize.spec.ts` — auto-excluded from PR CI by
  `e2e/webgl-heavy-globs.ts:64` (`'**/toybox-*.spec.ts'`). Therefore **tag exactly one
  floor test `@webgl-smoke`** (or hand-add beside `toybox-layer-input.spec.ts` in
  `.github/workflows/ci.yml:2017`) so the PR lane proves the feature; estimate the CI
  wall-time delta and get sign-off if >~2 min.
- Floor test (@webgl-smoke, SwiftShader-tolerant): spawn toybox → `__toyboxRoll(seed)` ×3
  seeds → each result renders non-black (in-page luma-variance accumulator; report
  samples/values in the assertion message; **frame-based waits via a rAF `waitFrames`
  helper** — pattern at `e2e/vrt/_shell-faces.ts:918` — never `waitForTimeout`;
  SwiftShader runs at ~7.9 fps so a ms budget is a different assertion per machine).
- Full sweep (heavy lane): 20 seeded rolls, all alive, structural anti-repeat asserted
  from the applied blobs; undo restores exact prior blob; lock round-trip; restore point.
- **Real-source-chain test** (the poly/MIDI rule transposed to video): wire an actual
  video-producing module → `inA` and a real LFO/clock → `cv1` through the rack graph,
  roll, assert (1) output alive and (2) the sources load-bearing — the applied blob
  selects `inA` on a layer and routes `cv1`, and the port scope shows a non-idle kind. An
  engine-direct roll with synthetic context does NOT count as this proof.
- Every new/changed test: `REPEAT=3` locally, scoped, before push; run from a clean state;
  `task typecheck` as well as vitest.

**VRT:** three baseline-moving PRs (B, C, 5). Each: dispatch `task vrt:commit`, never
commit a baseline locally; predict the file count and compare against what the bot
commits; remember `--update-snapshots` cannot regenerate a passing-but-stale baseline
(`git rm` first) and a `git rm`-ed baseline is silently recreated untracked by the next
plain run (`git status` for untracked PNGs).

**Sweeps/ledger:** no new module, no new ports ⇒ no `contract-lock.txt` change, no
per-port enrollment, no `EXPECTED_NODE_TYPES` edit. The existing
`toybox.inA/inB` `EXEMPT_INPUT_DRIVE` entries (`e2e/tests/_per-module-per-port-shared.ts:747`)
and the spawn-smoke quarantine stay untouched (touching them means
`task test:ledger:accept`).

## 6. Gates and attest bases — what moves, when to re-pin

| Gate / basis | PR-1 (arch) | PR-2 (assets) | PR-3 (locks) | PR-4 (engine) | PR-5 (UI) |
|---|---|---|---|---|---|
| `ci-webgl-attest` (`lib/video/**` non-test, `modules/toybox.ts`, worker handle in basis; `ToyboxCard.svelte` NOT in basis) | **re-attest** | no (static assets + tests are basis-excluded) | **re-attest** (`toybox-combine-graph.ts`) | **re-attest** | only if `modules/toybox.ts` moves |
| `ci-collab-attest` | no — `graph/toybox-*.ts` is outside the collab basis (`scripts/collab-attest-lib.ts`) | no | no | no | no |
| `contract-lock` / `docs:accept` | no port changes anywhere in this plan | — | — | — | DESCRIPTIONS edit is manifest-side, not contract |
| manifest-integrity test | parser re-base | **extended (shader licenses) + must stay green over new entries** | — | — | — |
| VRT baselines (Linux CI authors) | no | new-family representatives | lock badges | no | dice button chrome |
| `webgl-smoke` PR floor | — | — | — | — | +1 tagged test (wall-time estimate) |

Re-attest discipline: attest **the merged tree, not the branch tip**, run it LAST after
all other basis-touching work in flight has merged, and match CI's refusal hash before
spending the GPU. Kill stale dev servers on 5173/4173 first.

## 7. Risks

1. **License provenance of the asset drop** is the largest schedule risk: Shadertoy's
   default license is CC BY-NC-SA — unshippable. Sourcing is CC0/MIT/original only, and
   the gate is extended to enforce it per-entry.
2. **VRT churn** across three PRs; each is a Linux-CI dispatch cycle. Mitigated by
   concentrating visual changes (PR-4 is deliberately invisible).
3. **Worker renderer divergence**: under `?videoworker=1` (`renderLocus:
   'worker-experimental'`, `modules/toybox.ts:344`) `video`/`image` layers render black.
   A roll that satisfies context-awareness by selecting `inA` is black in the worker
   path. Accepted for the experimental flag, documented — not silently ignored.
4. **Control-surface re-pointing**: `toybox-control-params.ts` resolves flat param ids to
   the first owning layer, so a structural shuffle can silently re-target existing
   MIDI/control-surface bindings. The engine treats layers with active control bindings
   the same as CV-routed context (verify at PR-4; if unresolvable cheaply, surface as an
   owner decision).
5. **Perceptual quality is content-design work** (prior-art R1): archetype and range
   tuning will take real iteration with the owner's eyes on it; the plan budgets a
   preview/feedback loop before PR-5 merges (look-changes = review before merge).

## 8. Open questions for the owner

1. **Liveness enforcement depth:** by-construction + capped retry + per-seed CI readback
   sweep (proposed), vs. a per-press runtime GPU readback gate (adds latency/complexity
   to every press). OK with the proposed?
2. **Lock semantics:** locks constrain the dice only; manual edits to locked elements
   remain allowed. Confirm.
3. **Mutate amount UX:** flyout slider next to the dice vs. modifier-press
   (e.g. shift-click = small mutate). Preference?
4. **Seed surfacing:** keep seeds internal (tests/repro only), or show a copyable seed
   chip so users can share rolls?
5. **Asset drop sourcing:** original in-house GLSL vs. curated CC0/MIT hunting — and
   roughly how much is "significant" (proposal: double the shader families, ~+10 models)?
6. **Restore point persistence:** session-only (proposed) or auto-write a user preset at
   the first roll of a session?
7. **CI budget:** one @webgl-smoke roll-liveness test on the PR lane (~tens of seconds
   expected). The 20-seed sweep lives in the excluded heavy spec. Sign off on the
   wall-time estimate at PR-5.
