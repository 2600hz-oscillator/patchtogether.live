Title: TOYBOX randomize: context-aware curated random patches, node/layer locks, expanded asset bank — on a dynamic-registry architecture
Labels: enhancement, p1
---
## Summary

Add a one-press **randomize** to TOYBOX. Each press produces a new, interesting,
never-black patch: it rolls **both** the four layers' content **and** the internal combine
node graph, draws on a significantly expanded shader/OBJ bank, **incorporates whatever the
user has patched into the module** (video into `inA`/`inB`, cv/gate/audio into
`cv1..cv6`) instead of ignoring or disconnecting it, and works **around** elements the
user has locked via right-click.

Before any dice are built, an **architecture phase** lands the seams this feature and the
planned TOYBOX sandbox subsite (separate issue: *toybox.patchtogether.live*) both need:
a dynamic asset provider (so assets are enumerated through an interface, not read straight
off the hand-maintained `static/toybox/manifest.json`), first-class param extraction for
arbitrary GLSL (so user-loaded shaders gain faders/CV/randomize targets), and a shader
compile-validation probe. **That phase exists to serve the subsite issue as much as this
one** — the randomizer is deliberately built on the new architecture so it does not need a
rebuild when the subsite arrives.

## Why

TOYBOX is the app's deepest module (4 layers × 7 content kinds, a 17-op combine DAG, 6 CV
+ 2 video inputs) but exploring it requires authoring. Prior-art survey across creative
audio/video tools (Synplant, Nord G2 Mutator, Elektron, VCV, MilkDrop, procedural-gen
literature) is unambiguous: uniform randomness is unusable; what users keep is **curated
randomness** — designer-tuned structures and ranges, liveness guaranteed, user work
sacred. Supporting evidence: `.myrobots/2026-08-13-random-preset-prior-art.md` and
`.myrobots/2026-08-13-toybox-randomize-plan.md` (not required to act on this issue).

## Scope — five workstreams, in order

1. **Architecture prep (front-loads the subsite issue's prerequisites)**
   - Asset provider seam over `packages/web/src/lib/video/toybox-content.ts`:
     `listContent/getSource/listModels` with a static-manifest provider (current behavior)
     and a runtime provider for session-registered assets; the existing disk file-picker
     ingest becomes the runtime provider's first consumer.
   - `extractShaderParams(src)`: parse `uniform float` declarations + optional
     `// @param(min,max,default,curve)` annotations into the manifest's `params[]` shape;
     custom shaders get faders and CV targets like bundled ones.
   - `validateToyboxShader(src)`: offscreen compile probe with structured errors,
     used by disk-load now and paste-validation later.
2. **Asset expansion**: a significant drop of new GEN/FX/FRAG shaders and OBJ models
   (roughly doubling shader families, ~+10 models), spread across visual families
   (feedback / organic / geometric / glitch / 3D-scene / texture-source) so random results
   have real variety. Every entry license-clean (CC0/MIT/original — **no** Shadertoy
   default-license imports) and the manifest-integrity gate extended to require a license
   tag on shaders (today it gates models only).
3. **Lock UX**: right-click Lock/Unlock on individual combine-graph nodes AND on entire
   layers (layer tab strip), with visible lock badges. `locked` rides `node.data`, so it
   syncs to rack-mates and round-trips presets/zip export. Locks constrain the dice, not
   manual editing.
4. **Randomize engine** (pure, seeded): `(seed, context, locks) → data blob`.
   Structure-first generation — pick a weighted **archetype** (hand-designed topology
   family), build a valid combine DAG, draw content through the asset provider, then roll
   scalars from designer-curated ranges. Context probe reads the rack graph's inbound
   edges per port; patched sources are locked-by-default inputs every roll builds on.
   Bounded generate-and-test (validation + retry cap + known-good fallback archetype).
   Anti-repeat memory on archetypes across consecutive presses. A `mutate(current,
   amount)` variant for "variation of this thing I like".
5. **Button + safety loop**: dice button on the card (one gesture, no dialog, instant
   apply, cheap re-roll); each roll applies atomically in one Yjs transaction ⇒ single
   Cmd-Z undo; session restore point captured at the first roll; short history ring of
   recent rolls; save-kept-result via the existing user-preset gesture.

## Non-goals

- The public sandbox subsite itself (separate issue; this issue only front-loads its
  Toybox-side architecture).
- New combine-op kinds, new module ports, or changes to rack-level auto-wiring. The
  randomizer never creates, moves, or severs rack cables.
- Auto-audition / timed shuffle mode (possible follow-up; must stay opt-in).

## Acceptance criteria

**(a) New + interesting per press**
- [ ] A dice button on the TOYBOX card; first press works with zero configuration; a
      press applies fully or not at all (no half-applied states, no orphaned CV routes).
- [ ] Seeded CI sweep: N ≥ 20 consecutive seeded rolls each render non-black output
      (luma-variance probe, frame-count waits, not wall-clock).
- [ ] Structural anti-repeat: consecutive rolls never share an archetype; the sweep's
      rolls span multiple archetypes (asserted from the applied state, derived from the
      archetype table — no hard-coded counts).
- [ ] Both layer content AND combine-graph topology differ across rolls; generated graphs
      always validate (no cycles, output reachable).

**(b) Context-aware**
- [ ] With a video source patched into `inA`/`inB`: every roll selects that input as a
      live layer source. With cv/gate/audio patched into any `cv1..cv6`: every roll routes
      that port to a parameter that exists in the result. Rack edges are never
      disconnected by a roll.
- [ ] e2e proof wires REAL source modules through the rack graph (real video producer →
      `inA`, real LFO → `cv1`), rolls, and asserts the output is alive AND the sources are
      load-bearing in the applied state. An engine-direct test with synthetic context does
      not satisfy this criterion.
- [ ] With nothing patched, rolls draw entirely from the built-in asset pool.

**(c) Layers + graph, varied processing**
- [ ] The generator can produce every archetype in its table (derived-membership test:
      iterate the table, assert each builds a valid, alive-by-construction blob).
- [ ] Rolled patches exercise ops across the op-kind families (mix/key/geometry/
      displace/feedback/glitch), not a fixed few — asserted across the seed sweep.

**(d) Locks**
- [ ] Right-click Lock/Unlock on any combine node and any layer; visible badge when
      locked.
- [ ] Lock round-trip: lock element → roll repeatedly → locked element (and what it needs
      to keep functioning, e.g. its inbound connections and content) is byte-identical
      across all rolls; unlock → it participates again.
- [ ] Locked flags survive preset save/load and zip export/import.

**(e) Asset bank**
- [ ] New shaders and models land with per-entry license provenance; the integrity gate
      fails any shader or model without one.
- [ ] Every new shader declares tunable params (via annotation extraction or manifest),
      so it is CV-routable and randomizable; the existing integrity assertions
      (params ↔ uniforms, min≤default≤max) stay green over the expanded bank.
- [ ] VRT representatives added for each new visual family.

**Architecture prep (serves the subsite issue)**
- [ ] Randomizer and card enumerate assets only through the provider interface; nothing
      outside `toybox-content.ts` reads the manifest URL directly.
- [ ] A user-loaded `.glsl` with `// @param` annotations shows faders and is
      CV-routable — same plumbing as bundled shaders.
- [ ] `validateToyboxShader` rejects non-compiling GLSL with a structured error before it
      reaches the render path.

**Safety / trust**
- [ ] One Cmd-Z fully reverts one roll. A restore point from before the first roll of the
      session is one gesture away. Recent rolls are revisitable. Saving a kept result is
      one gesture (existing user-preset flow).
- [ ] Rolls never touch: module name, editor layout state, CV attenuverter settings, or
      anything outside the module's own data (documented exclusion list).
- [ ] Determinism: same seed + same context ⇒ identical result (unit-asserted); an e2e
      hook accepts a seed so CI and bug reports can replay rolls.

## Testing notes (repo standards)

Renderer-dependent waits are frame-count based (rAF), never milliseconds; new tests
flake-checked `REPEAT=3` locally before push; the `toybox-*.spec.ts` glob is excluded from
PR CI, so exactly one roll-liveness floor test is enrolled in the `@webgl-smoke` PR lane
(SwiftShader-tolerant, CI wall-time delta estimated); the full 20-seed sweep lives in the
heavy toybox spec. VRT baselines are authored by Linux CI dispatch only. No hand-typed
population counts anywhere — membership and postconditions are derived
(`findOrphanedRoutes(result) == []`, archetype-table iteration). WebGL-attest re-pins
accompany each PR that touches `lib/video/toybox-*` / `modules/toybox.ts`.

## Sequencing

Workstream 1 (architecture) lands first and unblocks everything else; 2 (assets) and
3 (locks) can proceed in parallel after it; 4–5 (engine, then button/e2e/VRT) build on all
three. The architecture phase intentionally front-loads prerequisites for the
*toybox.patchtogether.live sandbox subsite* issue so the randomizer never needs a rebuild
when that ships.
