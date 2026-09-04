# Click-free crossfade — options and cost for the owner

**Date:** 2026-09-04. **Status:** ⚠ EVIDENCE + a decision request. **Nothing here is
chosen.** Measured against `origin/main` @ `b454185235`.

**Owner answer 6 (2026-09-03, binding):** *"Patch swap: CLICK-FREE CROSSFADE."*

Those four words are now mandatory and they have **no owning phase, no design, and
no instrument**. This memo exists because the gap between them and the current
architecture is a design decision with a phase and a price — not a wording change,
and not something an executing agent should quietly pick.

---

## 1. The one question only you can answer

The words admit two readings, and **the cost gap between them is roughly an order of
magnitude**:

- **"Click-free"** — no discontinuity, no click, no pop. A brief *silence* is
  acceptable as long as the edges are ramped.
- **"Crossfade"** — the outgoing patch is still *sounding* while the incoming one
  comes up. The two overlap. Never silent.

Today the load is a hard cut into a silent rebuild gap, which fails **both**
readings. So work is needed either way — but which work differs enormously.

> **The decision:** is a short, smooth, *silent* gap acceptable (Option A), or must
> the old patch keep sounding through the swap (Option B)?

---

## 2. Why this is not a small change: what the code does today

**The load is one Y.Doc transaction that clears unconditionally, then inserts.**
`packages/web/src/lib/graph/persistence.ts:529-587` — every edge (`:536`) and every
node (`:537`) is deleted, then the incoming nodes (`:538-540`) and edges (`:585`)
are added. The doc comment at `:446-456` states the intent: *load = replace*.

**The audio graph follows the doc, and teardown is immediate and synchronous.**
The reconciler disposes removed nodes inline — `reconciler.ts:182` calls
`engine.removeNode`, which reaches `handle.dispose()` at `engine.ts:341` in the same
pass. **There is no deferred-teardown seam, no graveyard, no grace path.** (The
`#2321` seam is *not* one: it is the identity-change rule at `reconciler.ts:144-185`.
Its own commit note records the current invariant explicitly — "one transaction is
one snapshot — the empty intermediate state never exists to be observed." **A
crossfade inverts that invariant rather than extending it.**)

**There is no master gain to crossfade with.** The terminal chain — gains, DC
blockers, stereo merger, limiter, and the `connect(ctx.destination)` at
`audio-out.ts:305` — is *itself a patch node* (`audioOut`), constructed per instance
and destroyed with the patch (`dispose()` at `:518-534`). The `master` param write is
an instantaneous step, not a ramp (`audio-out.ts:477-478`, `setValueAtTime`). Repo-wide
there is **no crossfade/fade utility on any master or output gain** — the only
adjacent prior art is the ES-9 underrun fade in the DSP worklet
(`es9-bridge-core.ts:48,111,118-131`), which is a dropout policy, not a graph
crossfade.

**⚠ Three hardware resources STRUCTURALLY forbid two simultaneous owners.** This is
the finding that constrains the answer, and it is not a matter of effort:

| resource | constraint | evidence |
|---|---|---|
| **ES-9** | The native app accepts a **SINGLE client** and answers `busy` to a second connection, then closes. Two graphs ⇒ the incoming ES-9 is **dead for the whole fade**. Worse on a *same-id* reload: the new node is handed the old node's rings, then the old node's dispose stops the worker the new one depends on | `bridge-owner.ts:28-31`, `:265-276`; `bridge-state.ts:10-20` |
| **Launchpad** | Exclusive, one owner per physical surface; `bind()` **returns false** when another owner holds the port. The new graph's bind is refused while the old node still holds it | `node-launchpad-monitor-registry.svelte.ts:51-52`, `:175-188` |
| **Mic / audio-in** | Release is `MediaStreamTrack.stop()` — **irreversible**. The old graph's mic dies instantly and needs a fresh `getUserMedia` | `node-audio-input-registry.svelte.ts:23-33`, `:352-358` |

Plus **MIDI inputs are single-slot, last-writer-wins**: `onmidimessage` is a property,
not an event target, so the moment the new graph attaches, **the outgoing graph goes
MIDI-deaf** (`input-attach.ts:1-15`, `:101-114`) — which defeats much of the point of
fading out a sequencer.

**And the resource sweeps are keyed to the DOC, not to engine liveness.** One
`$effect` at `Canvas.svelte:2574-2660` sweeps **17 single-owner registries** off
`snapshot.nodes`. The instant the transaction commits, cameras, mic, Launchpad,
present bindings, recorder takes and samsloop PCM are all released — *even if the
outgoing audio nodes were still rendering*. Deferring audio teardown alone would
therefore produce a still-sounding graph whose media and hardware were already
reclaimed. Splitting "doc liveness" from "engine liveness" means threading a second
liveness set through that effect and 17 registry APIs inside a 10,688-line component.

---

## 3. The options

### Option A — fade-out → rebuild → fade-in (a smooth *gap*)

Ramp a stable master gain down, run the swap, `await reconciler.reconcile()`, ramp
back up. Click-free at both edges; **briefly silent** in the middle.

- **Needs:** one new engine-owned stable master stage ahead of `ctx.destination` that
  survives the clear, plus reconciliation of the handful of direct-to-destination
  escapes (ES-9 keep-alive pin `es9.ts:577-580`, TWOTRACKS `twotracks.ts:644`, engine
  and video keep-alives).
- **Does NOT need:** any change to teardown ordering, the registry sweeps, or hardware
  ownership — **only one graph ever exists**, so every structural constraint in §2 is
  simply avoided.
- **Gap length:** the existing rebuild window (async factories + `await reconcile()`),
  unchanged — this option makes the gap *smooth*, not *shorter*.
- **Cost: S/M.** Order ~1 week including the instrument.
- **Risk:** low. The main unknown is the limiter's worklet failover latch
  (`audio-out.ts:366-372`) interacting with a new terminal stage — worth one spike hour.
- **Satisfies:** "click-free" ✅ · "crossfade" ❌ (it is silent in the middle).

### Option B — true overlap crossfade (old graph keeps sounding)

Defer teardown so both graphs render simultaneously, cross-ramping between them.

- **Needs everything in Option A**, plus: a deferred-dispose path (mechanically small —
  `reconciler.ts:182` is the *sole* product caller of `removeNode`), **plus** the
  expensive part: a separate engine-liveness concept threaded through the 17-registry
  sweep effect, **plus** an explicit policy for each resource that cannot be
  double-owned. For ES-9, Launchpad and mic that policy cannot be "share" — it has to
  be "the incoming graph waits", which means those paths are *not* crossfaded and the
  feature is partial by construction.
- **Also affects:** 121 audio + 68 video module `dispose()` implementations, every one
  written assuming "dispose = release everything now."
- **Cost: L.** Order ~3-4 weeks, and it inverts a stated design invariant.
- **Risk: high**, and the payoff is capped: for exactly the rigs the owner cares about
  most (ES-9, Launchpad, mic, MIDI-driven), the overlap either cannot happen or the
  outgoing graph goes deaf/silent mid-fade anyway.
- **Satisfies:** "crossfade" ✅ for pure-DSP patches · ⚠ degrades to Option A behavior
  precisely where hardware is bound.

### Option C — A now, B later behind a per-patch capability check

Ship Option A as the contract. Detect whether a swap touches any exclusive resource;
if it does not, allow the deferred-teardown overlap.

- **Cost: A's cost now, B's cost later, plus the capability check and a second code
  path to test.** Two behaviors on one workflow is also a harder thing to assert.
- **Worth naming because** it is the only route that ever reaches true overlap without
  betting the schedule on it — but it does not reduce total cost, it defers it.

---

## 4. What this blocks

- **The `load patch` row of the [interruption matrix](interruption-matrix.md)** —
  currently OPEN, with the assertion tightened from "content dip allowed" to
  "crossfade envelope only". Its shape depends on the answer: Option A asserts a
  declared ramp shape around a permitted silent window; Option B asserts a floor that
  is never crossed.
- **P1's acceptance criteria and DoD.**
- **The PH instrument's design.** A worklet min-RMS floor "never dips" assertion is
  only meaningful under Option B; under Option A the instrument must assert the
  *envelope shape*, which is a different measurement. Building the instrument before
  this is answered risks building the wrong one.

**Recommended handling meanwhile:** leave the matrix row demanding and OPEN. Do not
weaken it back to "content dip allowed" to make a test pass — that re-pins the gate
to the behavior the answer rejected.

---

## 5. Two smaller things surfaced on the way

1. **A second swap path is unpriced.** `bindRackspace()` (`store.ts:151-189`)
   **destroys the entire Y.Doc** and builds a fresh one, so the reconciler sees an
   empty snapshot and tears down everything. A crossfade covering only
   `loadEnvelopeIntoStore` does **not** cover a rackspace switch. Whichever option is
   chosen, say explicitly whether rackspace switching is in scope.
2. **A stale e2e comment.** `e2e/tests/patch-load-leak.spec.ts:177` references a
   `loadEnvelopeGuarded` / "cross-mode guard" that **does not exist anywhere in
   `packages/web/src`** on `origin/main`. Not load-bearing for this decision; worth a
   line in whichever PR next touches that spec.
