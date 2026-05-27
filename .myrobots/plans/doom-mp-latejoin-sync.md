# DOOM multiplayer — late-join position sync (design decision)

Status: design for owner sign-off. The FREEZE half of the live failure is fixed
separately (see PR; C-side consistency-stamp). This doc is about the SECOND live
failure — **position desync on late join** — which is a model problem, not a bug,
and needs an explicit product/architecture decision before we implement.

## The problem, precisely

The C transport runs `net_client_connected == false`. Each peer's DOOM sim
free-runs on its own wall-clock and only **overlays the latest remote ticcmd**
(`dgpt_remote_cmds[slot]`, applied in `DGPT_OverlayRemoteCmds`). **No positions
are ever transferred — only input.** So every peer's view of every OTHER marine
is reconstructed purely by integrating that marine's input stream from the
moment its own sim started.

Late join is a **hot-drop relaunch**: when a guest joins a running game,
`DoomCard.hotDropRelaunchCurrentMap()` re-broadcasts the current map at a larger
`numPlayers`; every peer calls `dgpt_start_netgame` → `G_InitNew`, which
**resets ALL marines to their per-slot spawn points**. Both consequences of this
model are visible to the operator:

1. After P1 has walked away from spawn and P2 joins, the relaunch snaps P1 back
   to spawn on P1's own screen too (everyone restarts the map).
2. Even ignoring the restart, P2's view of P1 can only ever be "spawn + whatever
   input P1 sent since the relaunch" — there is no mechanism to teleport P1's
   marine to its true position, because positions are never on the wire.

The free-running-overlay model **cannot** keep late-joiner positions consistent
without a new mechanism. That is the decision below.

## Options

### (a) Intentional synchronized full-restart-on-join  *(RECOMMENDED)*

Make the hot-drop relaunch an **explicit, announced, clean co-op restart**: when
a player joins, every peer restarts the current map together from spawn, and the
UI says so ("Player N joined — restarting E1M1"). This is essentially what the
code does TODAY, minus the freeze and minus the surprise.

- Pros: zero new netcode; fits the free-running-overlay model exactly (every
  peer deterministically re-runs `G_InitNew` with identical settings, so all
  sims agree on the post-restart world); already implemented + now freeze-free;
  honest about DOOM's "the player set is fixed at level start" constraint.
- Cons: in-progress map progress is lost on every join. Acceptable for drop-in
  co-op (the common case is "friend joins, we start the level together"); poor
  for a long solo run someone wants preserved.
- Mitigation: only restart when `numPlayers` actually changes; debounce multiple
  joins within a short window into one restart; show a 3-2-1 countdown so it is
  never a jarring snap.

### (b) Lockstep with synchronized start

Hold all peers in a true lockstep tic loop with a shared start tic; a joiner
blocks until the next agreed start boundary, then everyone advances in lockstep
so positions stay identical by construction (the classic DOOM netgame model).

- Pros: positions provably identical on every peer with no state transfer
  (deterministic sim + identical input stream).
- Cons: requires `net_client_connected == true` and a real consolidated TicSet
  per tic over the relay — the exact path we deliberately do NOT use (it blocks
  in a spin loop that cannot run inside a cooperatively-scheduled WASM tick; see
  the rationale block atop `d_loop.c` + `dgpt_start_netgame`). It also makes
  every peer only as fast as the slowest peer + the relay RTT — unacceptable
  over a Yjs-awareness relay with multi-hundred-ms coalescing. Would still
  reset to spawn on a mid-game join (DOOM cannot add a player mid-level), so it
  does NOT solve the "preserve progress" complaint — only the per-tic identity
  one, which (a) already gets for the restart case. High effort, low marginal
  win for our transport.

### (c) State-snapshot transfer to the joiner

On join, the arbiter serializes the live world (all mobjs, doors, RNG indices,
leveltime, per-player state) and ships it to the joiner, which loads it instead
of `G_InitNew`-ing to spawn. No restart; the joiner drops into the live map.

- Pros: the only option that preserves in-progress map state AND drops the
  joiner in at the real positions — the operator's literal ask.
- Cons: large, fragile, and ongoing. DOOM has no savegame-grade serializer we
  can trivially reuse cross-peer for an arbitrary mid-level instant (the
  savegame code is close but assumes single-process load, fixed pointer
  reconstruction, and a matching build). The snapshot must then be kept
  consistent under the free-running overlay (the joiner is now a tic behind
  everyone, who keep free-running) — i.e. it re-introduces the lockstep problem
  the moment the snapshot lands. Highest effort, highest risk, and still needs
  (b)-style ongoing sync to not immediately diverge.

## Recommendation

**Adopt (a): intentional synchronized full-restart-on-join, made explicit.**

Rationale given the committed free-running-overlay C model:
- It is the only option that is *consistent by construction* in our model
  (identical `G_InitNew` inputs → identical worlds) with *no new netcode*.
- It matches DOOM's hard constraint that the player set is fixed at level start
  — neither (b) nor (c) can add a player mid-level without a restart anyway.
- The remaining "desync" the operator saw is then **not desync** — it is the
  honest, announced restart. Polishing it is UI work (countdown + "restarting"
  banner + join debounce), not netcode.

Defer (c) (snapshot transfer) to a future "preserve solo progress on join"
feature if users ask; it is a large standalone project and should not block
shipping freeze-free, consistent co-op now.

### Concrete follow-up work for (a) (separate PR, owner sign-off first)
1. Announce the restart: a "Player N joined — restarting <MAP>" banner + a short
   countdown on every peer before `hotDropRelaunchCurrentMap` fires.
2. Debounce: coalesce multiple joins inside ~2s into a single relaunch.
3. Only relaunch when `numPlayers` actually increased (it already gates on a new
   active player; tighten to "active count changed").
4. Optional: a host toggle "restart on join" vs "seat joiners at next map"
   (the old slice-6 PENDING behaviour) for hosts who want to protect a run.
