# DOOM multiplayer — per-player inputs (design + bug-(B) root cause)

Status: DESIGN / ROOT-CAUSE. No feature build in this PR (doc only). Branch off
`origin/main` at **#347** (`ce56585`, true deterministic lockstep: ordered
`Y.Array` ticcmd log + WASM barrier).

Two intertwined problems:

- **(A)** Owner ask: give DOOM **per-player input ports** (groups p1..p4 → slots
  0..3) and **hide them per-viewer** so each player patches their own
  gamepad/LFO to their own controls on one shared patch.
- **(B)** Bug: TODAY, if EITHER peer patches anything into the DOOM CV inputs
  during a netgame, **input breaks for BOTH players, permanently.**

---

## 1. Code map (what exists at #347)

Single shared DOOM node (`maxInstances: 1`, `ownerOnly`). Every JOINED peer runs
its OWN WASM runtime and renders its own POV. Inputs today:

- **One** shared CV-gate input set: `doom.ts` builds inputs from
  `CV_GATE_PORT_IDS` = `['up','down','left','right','space','ctrl','alt']`, each a
  `cv` port with `paramTarget: 'cv_<id>'`. There is exactly ONE group, shared in
  the Yjs doc — both players see the same panel (problem A).
- **CV → engine path**: a cross-domain CV bridge is built **per peer, from the
  shared edge set** (`audio/engine.ts addCrossDomainCvBridge` → `video/engine.ts
  addCvBridge`). Each peer's engine taps its OWN local audio source via an
  `AnalyserNode` and, each video frame (`tickCvBridges`), calls
  `handle.setParam('cv_<port>', raw)` on its OWN DOOM runtime. The DOOM factory
  (`doom.ts` `setParam`) edge-detects and calls `runtime.setKey(doomKey, pressed)`
  → `dgpt_set_key` → DOOM's `gamekeydown[]`.
- **Keyboard vs CV**: a node is keyboard-OR-CV (`isCvGatePatched`). When any CV
  gate has an incoming edge the card flips `setKeyboardInert(true)` (runtime
  drops keyboard-origin keys + releases held ones). CV is never gated.
- **Lockstep ticcmd flow** (`DoomCard.pumpLockstep` + `doom-lockstep.ts` +
  `d_loop.c`): each tic, the engine's `BuildNewTic` runs `G_BuildTiccmd` against
  `gamekeydown[]` and stores the result in `ticdata[maketic].cmds[localplayer]`.
  The JS pump reads each newly-built tic via `readLocalTiccmdAt(t)` (fwd/side/
  ang/btn ONLY — see `d_loop.c:1279`), appends `{t,s:slot,...}` to a shared
  `Y.Array` log, consolidates a per-tic `TicSet` once every live slot has
  submitted, and feeds it to `dgpt_receive_ticset`. Under lockstep, `TryRunTics`
  runs `ticdata[]` straight from the consolidated set for ALL slots, including
  the local one — it does NOT `SinglePlayerClear` and does NOT run the slice-5
  `DGPT_OverlayRemoteCmds` band-aid (`d_loop.c:1045`).

Key fact: **CV reaches the deterministic per-slot ticcmd path correctly in
principle** — CV → `gamekeydown[]` → `G_BuildTiccmd` → `ticdata[...][localplayer]`
→ logged → consolidated. The log carries only fwd/side/ang/btn; consistancy is
re-derived locally on receive (below).

---

## 2. Bug (B) — root cause, with evidence

### 2a. The consistency check is NOT the live freeze (evidence)

The historical freezes (#343, #345) were DOOM's netgame desync guard in
`g_game.c:965-977`: for `netgame && gametic > BACKUPTICS (128)` it does
`I_Error("consistency failure")` — a **fatal longjmp; the WASM sim aborts and
never ticks again, for that peer, permanently.** A peer that aborts stops
appending to the log → every other peer's barrier starves → **all peers freeze.**
That is the exact "breaks for BOTH players, forever" signature.

But #347 **neutralizes** it on the lockstep path: `DGPT_LoopReceiveTicSet`
(`d_loop.c:1219`) self-stamps `set->cmds[i].consistancy =
G_ConsistancyForSlot(i, tic % BACKUPTICS)` for EVERY slot at receive time. Both
the self-stamp and the later G_Ticker compare read the same ring slot
`consistancy[slot][tic%BACKUPTICS]` (the lagged `mo->x` from `tic - BACKUPTICS`),
and `recvtic` leads `gametic` by only `input_delay` (6) ≪ BACKUPTICS (128), so
the slot is never overwritten in between → the compare **always matches.**

Evidence it holds even with heavy movement past the boundary:
`tests/lockstep-barrier.acceptance.mjs` runs 2- and 4-sim live-barrier games for
**200 tics** (> BACKUPTICS) with divergent fire/move/turn input and asserts BOTH
no consistency abort AND byte-identical `dgpt_state_checksum` every tic. So
**when every sim runs the identical consolidated TicSet, neither the abort nor a
checksum divergence fires** — movement alone does not break it.

### 2b. The real bug class: non-deterministic CV injected per-peer, and a test gap that hides it

Two structural facts combine into the bug:

1. **The CV edge is shared; the bridge is per-peer and reads LOCAL audio.** The
   edge lives once in the Yjs doc, so on **every** peer the reconciler builds a
   CV bridge that taps THAT peer's own `AudioContext` and writes
   `setParam('cv_<port>')` → `setKey` → its OWN `gamekeydown[]`
   (`audio/engine.ts:896`, `video/engine.ts:622`). Consequences:
   - One LFO patch drives the local slot on EVERY peer (P1's "up" cable makes
     P2's marine walk too — wrong slot ownership; the shared model has no notion
     of "this CV belongs to slot N").
   - The sampled value is **not deterministic across peers**: each peer's
     analyser samples a different `AudioContext.currentTime` phase at a different
     `requestAnimationFrame` cadence (`tickCvBridges` runs on the video rAF,
     decoupled from the 35 Hz tic clock). The edge-detector fire instant
     therefore differs per peer and per frame relative to `BuildNewTic`.

2. **Per-slot determinism is only safe because each peer logs its OWN built tic
   — but that exact round-trip is UNTESTED.** Both acceptance harnesses synthesize
   a single canonical ticcmd per slot from a shared seeded RNG and inject it into
   every sim (`lockstep-barrier.acceptance.mjs:192-200`); they **discard each
   sim's `G_BuildTiccmd` output** and never call `readLocalTiccmdAt`. So the
   production path — "each peer builds its own slot from its own `gamekeydown[]`,
   logs it, and the consolidation feeds it back" — has **zero harness coverage**.
   The @collab e2e (`doom-mp-lockstep-sharedstate.spec.ts`) only drives the
   KEYBOARD and only asserts to `gametic > 20` (well under BACKUPTICS). Nothing
   exercises CV-into-a-real-netgame.

The freeze surface that this opens (any one of these flips the sim into the
fatal abort or a starve): a CV edge that asserts/clears a movement key at a
frame phase straddling a `BuildNewTic` boundary means a peer can **log a ticcmd
that does not equal the one it actually consumed**, or build its slot at a tic
the barrier has already consolidated — and once any peer's `dgpt_state_checksum`
diverges from the shared stream, the re-armed consistency oracle (which #347
calls "our live divergence oracle") `I_Error`s and that peer's WASM dies
permanently → universal freeze.

**Bottom line:** CV is applied via a direct `setKey` write that sits **outside**
any reasoning about which slot owns the input or whether the value is
deterministic across peers. It happens to flow through the per-slot ticcmd path,
but with (i) wrong-slot fan-out (shared edge → every peer's local slot) and (ii)
no determinism guarantee on sampling time. Under the #347 barrier+oracle, that is
exactly the input that turns a tiny divergence into a permanent, both-players
freeze — and the test suite cannot catch it because it never runs the
build-own-slot-then-log round-trip with CV.

> Note: the precise first-divergence tic depends on relay timing and is best
> pinned by an instrumented 2-context run (see Phase 0). The *architecture* of
> the bug is certain from the code above; the interim hotfix below makes the
> failure impossible regardless of the exact trigger frame.

---

## 3. Recommendation: ship an URGENT interim hotfix BEFORE the full build

YES — recommend a small, standalone hotfix first. It is independent of the
per-player feature, removes a "breaks both players forever" footgun on the
already-shipped lockstep path, and is regression-testable.

**Hotfix: when in a >1-player netgame (lockstep armed), do NOT apply CV writes
directly into `gamekeydown[]`. Route CV only to the LOCAL consoleplayer slot,
through the same per-slot ticcmd path the keyboard uses — or, as the minimal
v0, IGNORE CV→DOOM entirely while lockstep is active.**

Concretely, smallest correct change:

- In `DoomCard`, expose `lockstepActive` + this peer's `slot` to the factory (or
  gate in the card). When `lockstepActive`, the CV-gate `setParam` path must:
  (a) only affect THIS peer's own slot (it already does, via `localplayer`), and
  (b) be sampled deterministically — easiest interim: **drop CV writes while
  lockstep is armed** (`if (lockstepActive) return;` before `runtime.setKey` in
  the `cv_` branch), so a netgame is keyboard-only until the full design lands.
  Single-player (lockstep off) keeps CV exactly as today.
- Pair with a regression test that DOES exercise the untested round-trip: a
  harness variant of `lockstep-barrier.acceptance.mjs` that drives one sim's
  slot from `readLocalTiccmdAt` (not synthetic input) while feeding CV-style key
  toggles, and asserts no abort + byte-exact checksums for > BACKUPTICS tics.

This is intentionally conservative (no per-slot routing yet) and reversible. The
full design (§4) supersedes it by routing CV correctly per slot.

---

## 4. Per-player-inputs design (problem A) — and how it KILLS the bug class

### Design principle (keep the shared model)

ONE shared patch remains the single source of truth: all nodes/edges live in the
Yjs doc, visible-by-default and deterministic. Per-player-ness is achieved by
three orthogonal layers, NONE of which forks the doc:

1. **Port model — per-slot input groups.** DOOM exposes input groups
   `p1.*`, `p2.*`, `p3.*`, `p4.*` (each the existing 7 gates:
   `up/down/left/right/space/ctrl/alt`), mapping group `pN` → slot `N-1`. So
   `inputs` becomes `for slot in 0..3: for id in CV_GATE_PORT_IDS:
   { id: 'p{slot+1}_{id}', type:'cv', paramTarget:'cv_p{slot+1}_{id}' }`. The
   `KEY_FOR_CV_GATE` table is reused per group; the edge detector keys on
   `(slot, port)`.

2. **Netcode rule — build ticcmd from your OWN slot only.** This is the load-
   bearing determinism rule:
   - Each peer's CV bridge writes only into a **per-slot key buffer for that
     peer's `consoleplayer` slot**. A peer IGNORES every other slot's CV ports
     locally (even though the edges exist in the shared doc and the bridge could
     materialize) — gate `addCvBridge`/the `setParam` apply on
     `targetSlot === consoleplayer`.
   - The local gamepad/LFO/keyboard for slot N drives ONLY slot N's
     `gamekeydown[]`; `G_BuildTiccmd` produces slot N's ticcmd; the pump logs it
     under slot N; the barrier consolidates and replays the IDENTICAL set on
     every peer. No peer ever applies another slot's CV locally — the other
     slots arrive only as logged, consolidated, deterministic ticcmds.
   - This is the existing `localplayer` model (#343) plus a slot filter on CV.

3. **Per-VIEWER UI hiding (cosmetic only).** The card renders only the port row
   for the local viewer's slot (`p{mySlot+1}.*`); other groups' jacks are hidden
   from the panel. **Edges still live in the shared doc** and still render as
   cables on the canvas (graph stays globally consistent); we only hide the
   on-card jack stubs for slots you don't own. A spectator/unseated peer (no
   slot) sees no input group (read-only), matching that it has no ticcmd to
   contribute.

### Why this makes bug-(B)'s class IMPOSSIBLE

- **Determinism by construction**: a peer only ever consumes CV for its OWN
  slot, and that CV flows through the SAME `gamekeydown[] → G_BuildTiccmd →
  log → consolidated TicSet` path as the keyboard. Other slots are never applied
  from local CV — they arrive only as the consolidated, byte-identical log
  entries every peer replays. There is no path by which non-deterministic local
  sampling of another slot's CV can reach a slot it doesn't own.
- **No wrong-slot fan-out**: P1's "p1_up" cable can only ever move slot 0,
  because only the peer whose `consoleplayer == 0` applies it. P2 ignores it.
- **Sampling jitter is contained to your own log entry** — which is exactly the
  authoritative value the barrier distributes, so it can't disagree with what you
  ran. (The interim hotfix de-risks the residual "sample straddles a BuildNewTic
  boundary" timing; for the full feature, sample CV once per tic at the tic
  boundary rather than per rAF — see Risks.)

### Migration of the existing single CV input set

The current single group maps to **p1** (slot 0 = the owner/host default seat).
Existing patches that wired CV → DOOM `up`/`down`/… map to `p1_up`/`p1_down`/…
Provide a `schemaVersion` bump + an edge-rewrite migration (`<port>` → `p1_<port>`)
so old saved racks keep working and continue to drive slot 0. Bump `doomDef`
`schemaVersion` from 1 → 2.

---

## 5. Phasing + relationship to 4-player UI work

- **Phase 0 (URGENT, standalone):** the §3 hotfix (disable/own-slot-only CV under
  lockstep) + the missing build-own-slot-then-log regression harness + an
  instrumented 2-context run to pin the first-divergence tic for the record.
  Ships before anything below. Independent of #347 internals.
- **Phase 1 — port model:** add p1..p4 input groups + `cv_pN_<port>` synthetic
  params + per-slot edge detectors; `schemaVersion`→2 + migration. No netcode
  change yet (groups still all drive local slot as today, but now addressable).
- **Phase 2 — own-slot-only netcode rule:** CV bridge/`setParam` filtered to
  `targetSlot === consoleplayer`; sample CV at the tic boundary, not per rAF.
  Re-enable CV in netgames. This is where bug-(B) becomes structurally
  impossible. Lift the Phase-0 hotfix.
- **Phase 3 — per-viewer UI hiding:** show only the local slot's group on the
  card; keep edges + cables in the shared doc. Align with the 4-player UI work
  (slot badges/color tint already exist from slice 5; per-viewport from the
  4-player plan). Spectator = no group shown.

Relationship to **4-player UI**: this slots directly onto the existing
slot/`consoleplayer`/roster model (#343) and the input-delay barrier — it adds no
new authority concept, only addressable ports + a per-slot CV filter + cosmetic
hiding. It must stay 4-player-general (groups p1..p4, not P1/P2 special-cased).

## 6. Risks / open questions

- **UI hiding vs shared edges**: hiding a slot's jacks while its cables remain on
  the canvas can look odd (a cable into a port you can't see). Decide: dim/ghost
  other slots' jacks rather than fully remove, OR show all jacks but label by
  owner. Edges MUST stay in the doc regardless (consistency).
- **Spectator / unseated peer**: sees no input group, contributes no ticcmd; if
  it later seats into slot N, its group appears and it begins logging slot N.
  Confirm late-join (slice 6) seats the group cleanly at intermission.
- **Keyboard-vs-CV precedence per slot**: keep the existing per-node
  keyboard-inert rule, now **per slot**: if your own slot's group has any CV edge,
  your keyboard is inert for that slot; otherwise keyboard drives your slot.
  Other slots' CV state must not gate your keyboard.
- **CV sample timing**: sample CV at the tic boundary (inside the tick driver),
  not on the video rAF, so the value folded into `gamekeydown[]` for tic G is
  taken at a deterministic point relative to `BuildNewTic`. (Phase 2.)
- **Bridge materialization cost**: 4 groups × 7 gates = 28 potential CV bridges
  per DOOM node; only the local slot's (≤7) should actually tap audio. Filter at
  `addCvBridge` to avoid 21 idle analysers per peer.
