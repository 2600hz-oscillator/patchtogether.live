# TOYBOX — LAYER INPUT (feedback-tap texture source)

## What it is

A TOYBOX layer's **texture source** (the SURFACE dropdown on an OBJ layer, plus
the audited parallels on VIDEO / FRAG / Shadertoy layers) can be set to **LAYER
INPUT**, meaning *"sample whatever node output is wired into this layer's SOURCE
node's input port in the combine graph"*.

The headline use case is sourcing a layer's surface from the **post-feedback
OUT** — i.e. close a loop `OUT → layer surface → layer FBO → graph → OUT`. To
keep that loop stable it reads the **previous frame** of OUT (a 1-frame feedback
tap), exactly like the FEEDBACK op samples its own previous ring frame.

## Mechanism

### The patch-point (port)

- `inPortsFor('source')` now returns `['in0']` (was `[]`). Every SOURCE node in
  the combine editor auto-renders an input dot (testid
  `toybox-inport-src{N}-in0`), click-to-connect via the existing `onInPortClick`.
  No card markup change.
- `hasOutPort('source')` stays `true` — a source still **emits** its layer FBO
  downstream. The `in0` port is **emit-only in the forward eval**; it carries a
  feedback tap that the render resolves one frame late.
- An **unwired** `in0` dot is a pure no-op.

### Wiring / persistence

- No new mutator. `connectCombine(nodeId, from, to, 'in0')` runs `validateConnect`
  then pushes a plain edge onto `g.edges` in place (Yjs-safe). The tap persists as
  one more entry in `node.data.combine.edges` whose `to` is a source id
  (`src0..src3`). `deleteCombineEdge` removes it identically.

### Cycle safety (three independent guards)

1. **Prev-frame tap.** Layers render in **STEP 1** of `surface.draw()`, *before*
   `evalGraph` (STEP 2) recomputes the graph and *before* STEP 3 overwrites
   `outTexture`. So binding `outTexture` during STEP 1 samples **last frame's**
   OUT — never the live, still-being-computed result.
2. **Cycle / DAG exemption.** `isLayerInputEdge(g, to, toPort)` is true for an
   `in0` wire into a SOURCE node. `validateConnect` SKIPS `wouldCreateCycle` for
   such an edge (self-loop / no-out-port / occupied still reject; a non-source
   destination keeps cycle rejection unchanged). `topoSort` DROPS layer-input
   edges from indegree/adjacency, so the SOURCE stays a root and `evalGraph`
   remains an acyclic single-pass eval.
3. **Frame-0 / undefined safety.** `outFbo` is black-cleared every frame (STEP
   3), so frame 0 (and any frame where OUT is disconnected) samples clean black.
   Each frame's OUT is a clamped 8-bit composite, so feeding it back one frame
   late is bounded — it cannot diverge to all-white / NaN any more than the
   existing FEEDBACK op.

### Render (the prev-frame tap)

`layerInputWanted(layers, combine, i)` (pure, in `toybox-surface.ts`) decides
per layer: it is `true` iff the layer's source param selects the LAYER INPUT
sentinel **AND** the layer-`i` SOURCE node has a wired `in0` edge. When true the
GL pass binds `outTexture` (the retained prev-frame OUT) instead of the
default source, with `uUseSurface=1` (OBJ) / the scene channel (FRAG / Shadertoy)
/ the video texture (VIDEO).

## Params given a LAYER INPUT option

| Param | Field | Sentinel / value | UI |
|---|---|---|---|
| **OBJ SURFACE source** | `material.surfaceSource` | `LAYER_INPUT_SOURCE = -2` | `toybox-surface-select` → `<option value="-2">LAYER INPUT</option>` |
| **VIDEO layer source** | `layer.videoSource` | `'layerIn'` | `toybox-video-source-select` → `<option value="layerIn">Layer Input</option>` |
| **FRAG scene input (iChannel0)** | `layer.sceneInputSource` | `'layer-input'` | `toybox-scene-source-select` (`LAYER BELOW` / `LAYER INPUT`) |
| **Shadertoy iChannel** | `ShadertoyChannel` | `{ type: 'layer-input' }` | data-model + render only (channel-editor UI is a Phase-1 candidate — see below) |

`setLayerSurfaceSource` preserves the `-2` sentinel (other negatives still floor
to `-1` = MATCAP). `hasSurfaceSource` treats `-2` as "has source" (SURF MIX +
projective controls show), and the engine's `useSurf`/SURF MIX path applies the
mix to the LAYER INPUT tap.

### Audited as already node-output-capable (no change needed)

All op-node inputs `in0..in3` (incl. blend `in0`/`in1`, 1-input `in0`, EXQUISITE
`in0..in3`, DISPLACE `in1`, MAP `in1`), the OUTPUT node `in0`, Shadertoy
`buffer`/`self`/`scene`, and VIDEO `inA`/`inB` (the module's rack-cable video
input ports) already sample node/upstream outputs. **Out of scope:**
`shaderSrc`/`objSrc`/`imageBytes` are *content* sources, not texture-input
sources.

## Phase scope

- **Phase 1 (this PR):** LAYER INPUT = the **prev-frame OUT** tap (`outTexture`
  is the only already-retained tap). The wired `in0` edge expresses intent + the
  loop; the param sentinel selects it.
- **Phase 2 (sketched, no data-model / cycle-policy change):** a per-tapped-SOURCE
  retained FBO that the end of `evalGraph` copies `texForNode.get(edge.from)`
  into (clear-on-alloc), so STEP 1 next frame taps the EXACT wired node's
  prev-frame output rather than always OUT.

## Open questions

- **Shadertoy channel-editor UI.** Phase 1 ships the `'layer-input'`
  `ShadertoyChannel` type + its topo-exclusion + render binding (prev-frame OUT),
  but the project/Shadertoy channel-editor UI (distinct from the SURFACE family)
  is left as a Phase-1 candidate: the channel is selectable via the data model
  (e.g. presets / imported projects) and renders correctly, but there is not yet
  a dropdown in the Shadertoy project editor to pick it interactively.

## Tests

- **Unit** (`toybox-combine-graph.test.ts`): `inPortsFor('source') === ['in0']`,
  `isLayerInputEdge`, `validateConnect` cycle-exemption for source-`in0` (and
  unchanged rejection elsewhere / self-loop / occupied), `topoSort` drops the tap
  edge (source stays a root, eval acyclic).
- **Unit** (`toybox-surface.test.ts`): `layerHasInputEdge`, `layerInputWanted`
  (OBJ / VIDEO / FRAG sentinel-AND-wired matrix, no-op when either is missing,
  other kinds never wanted), `-2` registers no sibling-layer dep.
- **Unit** (`toybox-layers-ydoc.test.ts`): `setLayerSurfaceSource` preserves `-2`,
  `setLayerVideoSource('layerIn')`, `setLayerSceneInputSource`.
- **Unit** (`toybox-combine-ydoc.test.ts`): wiring a real OUT-feeding tap into
  `src0.in0` via `connectCombine` (cycle-exempt) + `deleteCombineEdge` removes it.
- **E2E** (`toybox-layer-input.spec.ts`): SURFACE = LAYER INPUT is a no-op when
  unwired; once the tap is wired it textures the OBJ (composite delta) AND the
  post-feedback loop is **stable** (never all-black, never blown out to
  all-white, no crash) across two frozen frames.
