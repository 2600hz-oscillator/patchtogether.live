# Game modules (PONG, MODTRIS) — design

Status: **research / proposal**. No code change is implied by this doc. The companion branch `research/game-modules-pong-prototype` exists separately if a working sketch is needed; this doc is the load-bearing artefact.

## TL;DR verdict

**Yes, this fits the existing paradigm — with two specific extensions, both small.** Game modules sit naturally next to SCOPE / CHARLOTTE'S ECHOS / BUGGLES: a CV-consuming + gate-emitting node whose card carries a 2D `<canvas>`. The architectural pieces we'd need are already shipped:

1. `AudioDomainNodeHandle` already supports modules that have no real audio path beyond `ConstantSource` (BUGGLES is exactly this) and that expose canvas state to the card via `read('snapshot')` (SCOPE is exactly this).
2. `SyncedModuleDef` + `shared-clock.svelte.ts` already define a deterministic `(epoch, params, prng) → state` contract designed precisely for the cross-peer state problem.
3. The CV-input → `setParam(portId, value)` path that the cross-domain CV bridge uses to write video-side uniforms once per video frame is the exact rate (~60 Hz) a game needs to ingest paddle position.
4. Gate-output emission via `ConstantSourceNode` + `setValueAtTime(1) → setValueAtTime(0)` is the existing convention (BUGGLES.clock/burst, SCORE.gate/clock) and is sample-accurate via the audio thread's scheduler.

The two extensions we'd add:
- **Game-loop ownership**: a tiny `GameLoopHost` utility that owns the 60 Hz tick (worker-driven, mirroring PR #90's `scheduler-clock`) and exposes a subscribe-per-instance API. Cards never own the tick; the engine factory does.
- **Gate-input rising-edge detector**: a 3-line helper that wraps an `AnalyserNode` tap and reports `(prev<0.5 && curr≥0.5)` per tick. Used by MODTRIS for `rotate_l`/`rotate_r`/`drop_fast`.

**Risks (ranked):**
1. Multi-user state sync at game-tick rate. Resolved below by following the `SyncedModuleDef` pattern (deterministic recomputation, not state broadcast) for PONG; explicit ownership transfer for MODTRIS.
2. Worklet vs. main-thread game-loop ownership. Resolved by keeping the loop on the main thread with a Worker-backed tick (free-running while UI janks), matching how every sequencer in the repo works.
3. Visual fidelity — 16-bit pixel-perfect canvas in a SvelteFlow card surrounded by faders. Card sizing + DPR handling already solved by SCOPE / WAVECEL.

---

## Investigation findings (what already exists)

### Existing visual-state-on-card modules
- **SCOPE** (`packages/web/src/lib/audio/modules/scope.ts`): audio passthrough with `AnalyserNode` taps. Card uses `$effect(() => requestAnimationFrame tick)` and calls `engine.read(node, 'snapshot')` to pull two `Float32Array` buffers + `sampleRate`. `drawScope()` is a pure function rendering them into a `CanvasRenderingContext2D`. Same `drawScope` is reused by the cross-domain video bridge (the engine's `videoSources` Map has `drawFrame(canvas)` that the bridge calls every video frame). **Net pattern: factory holds pure state, card pulls + paints, video bridge can re-use the same draw fn.**
- **BUGGLES** (`packages/web/src/lib/audio/modules/buggles.ts`): chaotic CV source. No audio worklet at all — it's a JS scheduler (`setInterval` / scheduler-clock) that orchestrates ramps on four `ConstantSourceNode`s. Two of those (clock, burst) emit gates by scheduling `setValueAtTime(1, t)` → `setValueAtTime(0, t + pulseWidth)`. Reads CV inputs through `AnalyserNode` taps with `getFloatTimeDomainData()`. **This is the closest analog to a "game module" today** — main-thread orchestration, no audio worklet, gates out via ConstantSource scheduling, CV in via analyser taps.
- **CHARLOTTE'S ECHOS** is a standard audio worklet (delay line); not the right reference.

### Multi-user / sync stack
- `packages/web/src/lib/graph/store.ts`: SyncedStore over Yjs. Singleton `patch` Y.Doc; `nodes` + `edges` maps. UndoManager scoped to `LOCAL_ORIGIN` so my undo never reverts your edit.
- `packages/web/src/lib/multiplayer/presence.ts`: Hocuspocus `awareness` for per-user, ephemeral state (cursors, camera, group-building). Awareness is broadcast on every change with no coalescing — cheap for 30 Hz cursor updates, **fine for ≤30 Hz game-input awareness, expensive for 60 Hz game-state**.
- `packages/web/src/lib/multiplayer/clock-sync.ts` + `packages/web/src/lib/audio/shared-clock.svelte.ts`: NTP-style cross-peer time alignment (Cristian's algorithm + min-RTT filter). Surfaces a `sharedTimeNow()` that any module can call to get a deterministic shared-time reading. **This is the single most important piece for game modules.** With shared time + a shared epoch + a shared rngSeed (already in `meta.rngSeed`), a `(state) = pure_fn(shared_time, params, rng)` game evolves identically on every peer with **zero per-tick wire traffic**.
- `packages/web/src/lib/audio/module-registry.ts` defines `SyncedModuleDef extends AudioModuleDef` with `computeStateAt(tMsSinceEpoch, params, prng)` — LFO is the proof of concept (`lfo-state.ts`). This contract was designed exactly for the use case "two peers, same module, must agree on state with no per-tick traffic."

### Per-rackspace clock / tempo source
- `packages/web/src/lib/audio/scheduler-clock.ts` (added in PR #90): singleton tick source, posts a tick every 25 ms **from a Web Worker**. Worker timers fire while the main thread is blocked, so module ticks don't drift under UI jank. Modules subscribe; each instance gets its own `dispose()` cleanup. **This is the right substrate for the game-loop**: a 16.67 ms (60 Hz) worker tick subscribed by each game instance, no rAF tied to a specific card.
- PR #176 fixed pointermove-flooding-Y.Doc by rAF-coalescing fader drags. The lesson it teaches: **never let game state mutate `patch.nodes[id].params` at 60 Hz**. Game state goes to a `read('snapshot')` cache, not to the shared graph.

### Worklet ↔ main-thread comm
- Worklets `postMessage` to main via `workletNode.port.postMessage(...)`. Main-thread modules push values into worklets via `AudioParam.setValueAtTime(...)` or `workletNode.port.postMessage(...)`.
- Gate emission: `ConstantSourceNode.offset.setValueAtTime(1, t); setValueAtTime(0, t + pulseWidth_s)`. The audio thread renders the swing sample-accurately. Downstream gate consumers detect the rising edge in their own worklet (or, for main-thread consumers, via their own `AnalyserNode` tap polled at scheduler-clock rate — same pattern BUGGLES uses for `clock_cv` ingest).
- **For games, there's no benefit to running game logic in a worklet.** The game doesn't need sample-accurate timing for its own loop (60 Hz visual is the target); pure-JS on the main thread with a worker-tick is simpler, easier to test, easier to sync, and easier to debug. Gate-output emission still goes through `ConstantSourceNode` scheduling so consumers downstream are sample-accurate.

### Visual-modules roadmap (already partly built)
- The memory note (`visual-modules-roadmap.md`) says "Phase 5 ships audio MVP, then video." That's outdated — `packages/web/src/lib/video/engine.ts` already exists with a full WebGL2 + OffscreenCanvas + cross-domain CV bridge + FBO/topology engine, and `packages/web/src/lib/video/modules/` ships LINES, SHAPES, FEEDBACK, INWARDS, PICTUREBOX, LUMA, CHROMA, RUTTETRA, etc. **Game modules are NOT video-domain modules** — they belong in `domain: 'audio'` because (a) their I/O is CV + gates (audio-domain cable types), and (b) the existing audio-domain factory shape already covers everything they need (`videoSources`, `read()`, ConstantSource gate outs). Putting them in video-domain would force a (currently nonexistent) "video module emits audio-side gates" path that nothing else needs.

---

## Open design questions — answers

### 1. State location

**Recommendation: game state lives inside the audio-engine factory closure, accessible to the card via `engine.read(node, 'snapshot')`. It is NOT in the Y.Doc patch graph and NOT in Svelte reactive state.**

Rationale: The patch graph is for *authoring* (which modules exist, how they're patched, what fader positions are set to). Game state is *runtime* (where the ball is right now). Mixing them duplicates the PR #176 problem at 4× the rate: a 60 Hz ball position would cascade into snapshot rebuilds, reconciler walks, and SvelteFlow re-renders, plus Y.Doc updates broadcast to peers. Keeping it inside the factory closure mirrors how SCOPE's analyser data is *not* in the Y.Doc — it's an ephemeral live read.

For multi-user sync (next question), we either (a) recompute identically on every peer from `(sharedTime, params, prng)` per the `SyncedModuleDef` contract, or (b) elect a single "host" peer to own it. Either way the state is **per-peer, not in the shared graph**.

### 2. Multi-user sync

**Recommendation: split by game.**

- **PONG**: SyncedModuleDef. State `(ballX, ballY, ballVX, ballVY, scoreL, scoreR)` is `computeStateAt(t_ms_since_epoch, params, rng)`. Each peer computes independently; no per-tick network traffic. CV-driven paddles are external inputs we treat as parameters — but since CV is broadcast through `awareness` at the existing 30 Hz cursor cadence (or sampled identically per peer from a shared CV source upstream), both peers see the same paddle trajectories and so compute the same ball trajectory. Scoring is `computeStateAt` rolling over a deterministic mod boundary. Score-gate pulses are *fired locally* on each peer when its computed state crosses the scoring boundary — the gate fires simultaneously on every peer (within shared-clock RTT bounds) **without any state broadcast**, because everyone is computing the same future from the same epoch.
- **MODTRIS**: NOT a clean `SyncedModuleDef` candidate. State depends on rising-edge gate inputs whose exact sample is timing-dependent, and the random piece queue depends on a stream of rng calls whose count diverges between peers under input race. **Recommendation: single owner.** The rackspace owner peer owns the game; other peers spectate by polling the owner's `read('snapshot')` via an `awareness` channel at 30 Hz (board state + current piece — ~80 bytes packed, comfortably inside the awareness budget). The owner emits `line_cleared` / `overfill` gates locally; spectator peers get a separate `awareness`-broadcast "fire gate now" event which their local `ConstantSourceNode` pulses on receipt (the small RTT skew is acceptable for non-musical gates and matches how human-player jitter already feels). This is the same "one peer drives, others observe" pattern as DAW transport.

For the prototype: ship PONG single-user-only and document the SyncedModuleDef wiring as deferred. **Don't attempt multi-user MODTRIS in the prototype**; only when its design is fully validated.

### 3. CV ↔ game integration

**Recommendation:**
- **CV-in sampling rate**: at the game-loop tick (60 Hz). Use `AnalyserNode` taps exactly as BUGGLES does (`fftSize: 32`, `smoothingTimeConstant: 0`, read `getFloatTimeDomainData` on each tick, take the tail sample). Latency is ≤1 game-frame, which is well below human-perceptible.
- **Gate-out timing**: sample-accurate via `ConstantSourceNode.offset.setValueAtTime(1, t); setValueAtTime(0, t + pulseWidth)`. Default pulseWidth = 5 ms (BUGGLES.CLOCK_PULSE_MS convention). The game-loop tick computes "did we score?" each tick; if so, it schedules the pulse at `ctx.currentTime + 0.005` (5 ms cushion so the audio thread doesn't miss the start). **Rendered-frame-accurate is the correctness floor, but ConstantSource scheduling gives us sample-accurate for free** — no reason not to take it.
- **Gate-in rising-edge detection**: each tick, tap analyser → tail sample → compare to last tick's tail sample. Edge detected iff `prev < 0.5 && curr ≥ 0.5`. 60 Hz tick gives a 16.67 ms minimum input pulse-width to register, which is well below any plausible BUGGLES/sequencer pulse (5–50 ms). Document this in the module def.

### 4. Game-loop ownership

**Recommendation: shared `scheduler-clock`-style worker tick at 60 Hz, subscribed by each game-instance's factory. Cards subscribe to `engine.read('snapshot')` via their own rAF for the visual paint.**

Two-loop split:
- **Game logic loop** (60 Hz, worker-driven): owned by the factory. Ticks the game state, samples CV inputs, schedules gate output pulses, increments scores. Runs even if the card isn't on-screen or the user is dragging a fader. Persistent across card-mount lifecycle.
- **Card render loop** (rAF, ≤ display Hz): owned by the card. Pulls `engine.read(node, 'snapshot')` and paints to canvas. Skips when card unmounted.

Why not rAF for game logic? rAF pauses when the tab is backgrounded; a backgrounded PONG should keep playing if its CV inputs are still flowing (because the audio CV source is still ticking). rAF also locks to the display refresh; a 30 Hz display would slow the game. Why not the AudioWorklet's `process()`? Game logic doesn't need sample accuracy and a worklet would force a tortured message-passing API for the canvas paint path.

Why not `setInterval`? It's what BUGGLES uses today, but PR #90 showed `setInterval` on the main thread drifts under jank. A worker-driven tick is strictly better — same shape, no drift.

### 5. Performance budget

**Recommendation: budget = 1 patch-store mutation per *human* gameplay event (paddle hit, score, line clear), zero per game-tick.**

This is the PR #176 lesson restated. Concretely:
- Score = 2 score-gate pulses per game over its lifetime, plus 1 game-state reset → 1 patch mutation each (or zero, if we keep the score in factory state and expose it via `read('totalScore')`).
- Line clear / overfill = 1 gate pulse per event.
- Paddle moves = 0 patch mutations (CV input via analyser tap, never touches the graph).
- Ball position updates = 0 patch mutations.

In multi-user: PONG = zero awareness traffic (everyone computes the same future). MODTRIS = ≤30 Hz awareness `setLocalStateField` on the owner only, with a board snapshot of ~80 bytes (10×20 grid as a `Uint8Array`). This is well inside the camera-presence budget that already ships.

### 6. Generality vs. per-game

**Recommendation: one Svelte/factory pair per game, NOT a generic GAME module with cartridges.**

Reasons:
- Each game has different I/O. PONG = 2 CV in + 2 gate out. MODTRIS = 3 gate in + 2 gate out. A cartridge model would force the worst case of every game on every game (unconnected ports cluttering every card) or dynamic ports (a complexity bomb for the reconciler + patch panel + saved layouts + saved groups + cable type-check + serialization).
- Module ART/E2E tests target per-game determinism; a cartridge layer adds a test dimension without buying anything.
- Two games is the prototype scope. If a third arrives that overlaps PONG's I/O exactly (say, BREAKOUT — 1 CV in, 1 gate out), we can extract a shared `lib/audio/modules/games/` helper at that point. YAGNI.

The shared helper layer worth extracting *now* is small:
- `lib/audio/games/game-loop-host.ts` — subscribe/unsubscribe to the worker tick, manage per-instance state, expose `dispose()`.
- `lib/audio/games/rising-edge.ts` — `(analyser, lastSample) → boolean`. 6 lines.
- `lib/audio/games/gate-out.ts` — `pulseGate(constantSource, ctx, widthMs)`. 4 lines.

Each game module imports these. They live in `audio/games/` not `audio/modules/games/` so the `module-registry` auto-import-glob is unchanged.

### 7. Feasibility verdict

**Feasible inside the existing paradigm with two extensions** (`GameLoopHost` utility + rising-edge helper). Both are <50 lines combined. No domain extensions, no new cable types, no engine-core changes. PONG can ship in single-user form as the validation prototype; multi-user PONG is a follow-up that wires `SyncedModuleDef.computeStateAt`. MODTRIS is a larger build (10×20 grid, piece queue, line-clear, gravity) but architecturally identical.

The biggest open question is **MODTRIS multiplayer** — single-owner + awareness snapshot is the most natural fit, but it's a new sync pattern. The prototype intentionally side-steps it.

---

## Proposed module specs

### PONG

```jsonc
{
  "type": "pong",
  "domain": "audio",
  "label": "PONG",
  "category": "games",
  "schemaVersion": 1,
  "inputs": [
    { "id": "paddle_left",  "type": "cv" },
    { "id": "paddle_right", "type": "cv" }
  ],
  "outputs": [
    { "id": "score_left",  "type": "gate" },
    { "id": "score_right", "type": "gate" }
  ],
  "params": [
    { "id": "speed",       "label": "Speed",  "default": 1.0,  "min": 0.25, "max": 4,  "curve": "log" },
    { "id": "paddle_h",    "label": "Paddle", "default": 0.2,  "min": 0.05, "max": 0.5, "curve": "linear" },
    { "id": "serve_angle", "label": "Serve",  "default": 0.3,  "min": 0.0,  "max": 1.0, "curve": "linear" }
  ],
  "vizPassthrough": true
}
```

Card: ~200×140 px canvas at 2× DPR (so 400×280 backing for crisp 16-bit pixels). Renders the field, two paddles, ball, scores. CRT-vibe palette (mono green on near-black, or NES-palette).

Factory shape:
```text
factory(ctx, node) {
  const cvL = analyserFor('paddle_left')
  const cvR = analyserFor('paddle_right')
  const scoreLGate = ctx.createConstantSource()  // .start()
  const scoreRGate = ctx.createConstantSource()  // .start()
  let state = initState(node.params, sharedClock.rngSeed())
  const unsub = gameLoopHost.subscribe(() => {
    const paddleL = tail(cvL); const paddleR = tail(cvR)
    state = step(state, paddleL, paddleR, dtMs=16.67)
    if (state.scoreEvent === 'L') pulse(scoreLGate, ctx)
    if (state.scoreEvent === 'R') pulse(scoreRGate, ctx)
  })
  return {
    domain: 'audio',
    inputs: Map([['paddle_left', { node: cvL, param: cvL_sink }], ...]),
    outputs: Map([['score_left', { node: scoreLGate, output: 0 }], ...]),
    read: (key) => key === 'snapshot' ? state : undefined,
    setParam, readParam, dispose: () => { unsub(); ... }
  }
}
```

### MODTRIS

```jsonc
{
  "type": "modtris",
  "domain": "audio",
  "label": "MODTRIS",
  "category": "games",
  "schemaVersion": 1,
  "inputs": [
    { "id": "rotate_l",  "type": "gate" },
    { "id": "rotate_r",  "type": "gate" },
    { "id": "drop_fast", "type": "gate" },
    { "id": "move_l",    "type": "gate" },
    { "id": "move_r",    "type": "gate" }
  ],
  "outputs": [
    { "id": "line_cleared", "type": "gate" },
    { "id": "overfill",     "type": "gate" }
  ],
  "params": [
    { "id": "gravity_bpm", "label": "Drop", "default": 60, "min": 30, "max": 240, "curve": "log" },
    { "id": "level_step",  "label": "Lvl",  "default": 10, "min": 1,  "max": 20,  "curve": "linear" }
  ],
  "vizPassthrough": true
}
```

**Design note re: spec.** The original brief omitted `move_l` / `move_r` ("no horizontal-move inputs in spec? Confirm/recheck"). **Recommendation: include them.** Without horizontal motion the game is unplayable as Tetris — pieces only fall in column 4 forever. Including them as `gate` inputs (rising-edge step-left / step-right per pulse) matches the rotate inputs cleanly. A real CV-sequencer player can patch a slow LFO into a `cv → gate` thresholder and "play" MODTRIS hands-free; that's the patchtogether-shaped use case.

Card: 10×20 grid at 12 px per cell + 2 px gutter = 140×280 visual area, plus a small "next piece" preview. Standard tetromino colors.

---

## "Why this fits / doesn't fit the existing paradigm"

### Fits (evidence)
- **BUGGLES is already 80% of PONG's runtime shape**: main-thread orchestration, no audio worklet, gates out via `ConstantSource.setValueAtTime(1/0)`, CV in via analyser taps. The only delta is a deterministic 60 Hz step function vs. BUGGLES's stochastic woggle scheduler.
- **SCOPE is already 100% of PONG's visual shape**: factory holds a `Float32Array`-shaped snapshot, card pulls via `engine.read(node, 'snapshot')` inside an rAF, paints to a 2D canvas. Pure draw function reusable for video bridge.
- **`SyncedModuleDef` was designed for this exact case** — LFO is the proof. PONG's `step(state, paddleL, paddleR, dt) = nextState` is literally `computeStateAt(tMsSinceEpoch, params, prng)` with a deterministic accumulator.
- **`scheduler-clock` worker tick** already gives drift-free main-thread ticks; subscribing at 60 Hz instead of 25 ms is a one-line change.

### Doesn't fit (none load-bearing)
- The repo has no precedent for "module emits a one-tick pulse on a programmatic event with no audio-side trigger." Every gate output today is either user-triggered (button) or audio-thread-scheduled (sequencer step, LFO crossing). Game scoring is a *game-logic* event on the main thread. This is fine — `ConstantSource.setValueAtTime(1, ctx.currentTime + ε)` from the main thread is the supported pattern (BUGGLES schedules its clock/burst exactly this way); we just trigger it from `gameLoopHost.subscribe`'s callback instead of a stochastic woggle.
- The `category: 'games'` is new. The palette UI groups by category; adding one is `palette.svelte` only.
- The MODTRIS multi-user "single owner, awareness snapshot" pattern is new. Manageable, but it's where the genuine architectural risk lives. Recommendation: ship PONG first to validate everything else, then design MODTRIS sync as its own follow-up.

---

## Next steps if approved

1. Land the two helper files (`game-loop-host.ts`, `rising-edge.ts`) standalone with unit tests.
2. Ship PONG (single-user) as the validation slice. Tests: unit (state stepper deterministic), ART (gate outputs fire at expected times for a scripted paddle trajectory), E2E (card renders, CV-driven paddle moves the on-screen paddle).
3. Add SyncedModuleDef wiring for PONG (multi-user). New ART scenario: simulate two peers with the same epoch + params, assert ball/score trajectories are identical to within float precision.
4. Design MODTRIS multi-user (separate doc — it's its own design question).
5. Ship MODTRIS (single-user first, multi-user follow-up).

---

## Appendix — diagram

```
                            patchtogether.live game module
                            ─────────────────────────────────────
   CV IN ──► AnalyserNode ──┐
   CV IN ──► AnalyserNode ──┤
                            ▼
                    ┌───────────────────┐         ┌──────────────────┐
                    │  GameLoopHost     │ tick    │ step(state, ...) │
                    │  (worker @ 60Hz)  │────────►│  pure function   │
                    └───────────────────┘         └────────┬─────────┘
                                                            │ new state
                                                            ▼
                                                  ┌──────────────────┐
                                                  │ factory closure  │
                                                  │ holds `state`    │
                                                  └────┬─────────┬───┘
                              read('snapshot') ────────┘         │
                              from card rAF                      │ on score event:
                                                                 ▼
                                                       ConstantSourceNode
                                                       .setValueAtTime(1)
                                                       .setValueAtTime(0)
                                                                 │
                                                       GATE OUT ─┘
```

Multi-user (PONG via SyncedModuleDef):

```
peer A                                    peer B
  │                                         │
  ├── sharedClock.epoch_ms  ◄── Y.Doc ────► sharedClock.epoch_ms
  ├── sharedClock.rngSeed   ◄── Y.Doc ────► sharedClock.rngSeed
  ├── node.params           ◄── Y.Doc ────► node.params
  │                                         │
  │     computeStateAt(t, params, rng)      │     computeStateAt(t, params, rng)
  │     ─────────────────────────────►      │     ─────────────────────────────►
  │     identical state                     │     identical state
  │                                         │
  │  fires score_left at t=12.345s          │  fires score_left at t=12.345s
  │  (locally, no broadcast)                │  (locally, no broadcast)
```
