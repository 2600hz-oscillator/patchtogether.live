# DOOM MP — true deterministic lockstep (design + spike)

Status: **DESIGN for owner sign-off.** No live-netcode behavior changes in the
PR that carries this doc. Optional isolated spike only (does not touch the live
path). Read end-to-end before approving a build.

Author note on context drift: the task brief referenced a `#345` that
"neutralized the consistency-check abort" plus docs (`doom-mp-latejoin-sync.md`,
`doom-mp-latejoin-freeze.spec.ts`) that do **not** exist on this `main`. What
actually exists here is the slice-0..7 line from PR #300 (slice 7) through
#339/#343 (lockstep gap-fill + host-freeze fixes). The findings below are
grounded in the code that is actually checked in, not the brief's assumed state.
The conclusions are unchanged: the **live** path free-runs and does not share
authoritative state. See §1.

---

## 0. TL;DR (for the owner)

- **Confirmed: the live game does NOT share state.** Each peer free-runs its own
  `dgpt_tick` at rAF cadence, advances with no barrier (`net_client_connected =
  false`), and merely *overlays* the latest remote ticcmd from a last-value-wins
  Yjs awareness field. Monsters, pickups, barrels, health, RNG — none are
  shared; they only *appear* consistent because each sim is independently
  deterministic and is fed roughly-matching inputs.
- **We already own the hard part.** Slice 7 (`d_loop.c` scripted-lockstep mode +
  `dgpt_state_checksum` + `lockstep-determinism.acceptance.mjs`) **proves the
  WASM sim is bit-exact across N instances when fed one identical, ordered,
  consolidated TicSet per tic.** True lockstep is therefore a **transport +
  barrier** problem, not a determinism problem.
- **Recommended transport:** a **per-module Yjs shared append-log (`Y.Array`) of
  per-tic ticcmds**, arbiter-consolidated into per-tic TicSets, with **WebRTC
  datachannel** as the low-latency fast-path (the infra is already built in
  `doom-netcode.ts`) and the Yjs log as the ordered/durable fallback. NOT raw
  awareness (it coalesces — that is the root defect).
- **Recommended barrier:** flip `net_client_connected = true`, feed a **real
  per-tic ticcmd queue** into `D_ReceiveTic`/`recvtic`, and let the *existing*
  `GetLowTic`/`TryRunTics` machinery gate advancement — but decouple the tic
  pump from rAF and **never spin-block** (the original freeze class). A stalled
  peer triggers timeout → host pauses (short) → drop-to-spectator (long).
- **Recommended late join:** **coordinated synchronized restart** of the current
  map at an agreed launch tic (the mechanism `doom-late-join.spec.ts` already
  exercises), not snapshot transfer. Determinism makes the restart free.
- **Re-enable the consistency check** (`g_game.c` ~967) as the live correctness
  oracle once real lockstep runs — it is the *original divergence detector* and
  it is currently INTACT in this tree (only *bypassed* because the scripted path
  stamps the expected value). It becomes our canary again.

---

## 1. The problem, confirmed: the three broken legs

The live multiplayer path (DoomCard.svelte render loop → doom-netcode.ts →
doom-runtime.ts → `dgpt_tick`) shares **input overlays**, not **state**. Three
independent design choices break shared state:

### Leg 1 — No barrier: `net_client_connected = false`

`dummy.c:36` hard-codes `boolean net_client_connected = false;`. Consequences,
all visible in `d_loop.c`:

- `GetLowTic()` (line 691) returns `maketic` unchanged — it never clamps to
  `recvtic`. So `TryRunTics` (line 829) computes `availabletics = lowtic -
  gametic/ticdup` purely from the **local** wall clock. There is **no wait for
  remote tics**.
- `BuildNewTic` (line 285) caps the local build-ahead to 2 tics
  (`!net_client_connected && maketic - gameticdiv > 2`) and never calls
  `NET_CL_SendTiccmd` (line 305 is `if (net_client_connected)`).
- `D_ReceiveTic` (line 394) — the function that fills `ticdata[recvtic]` with a
  *consolidated* TicSet for all slots and bumps `recvtic` — is **never called**
  in the live path. `recvtic` stays 0 forever.

So each peer advances `gametic` on its own clock and never blocks on anyone.
That is the opposite of lockstep.

### Leg 2 — Overlay, not authority: per-tic ticcmd is last-value-wins awareness

`doom-netcode.ts` `broadcastLocalTiccmd` (line 1061) writes the local ticcmd to a
**single sticky awareness field** (`ticcmdFieldFor`, one field overwritten every
tic). Awareness is **last-value-wins** — if two tics are produced between two
awareness flushes, the intermediate ticcmd is **silently dropped**. The receiver
(`drainInboundTiccmds`, line 1101) dedupes on a monotonic `seq` and calls
`onRemoteTiccmd` → `injectRemoteTiccmd` → `DGPT_OverlayRemoteCmds` (d_loop.c
174), which writes the remote slot into the *about-to-run* tic set.

Critically, the overlay applies whatever is **currently** in `dgpt_remote_cmds[i]`
to **whatever local `gametic` this peer happens to be on** — there is no notion
of "this ticcmd belongs to tic N." Peer A's tic-1000 input can be overlaid onto
peer B's tic-1003. Inputs are approximately mirrored; they are not the *same
ordered stream applied at the same tic*. Hence sub-tic drift, and zero
guarantee about non-input state (see Leg 3).

`reinjectKnownTiccmds` (#339, line 1159) re-applies the last-known remote input
every tic so an idle/holding peer doesn't appear frozen. This is a *liveness*
band-aid for the coalescing problem — it confirms the transport cannot deliver a
reliable per-tic stream.

### Leg 3 — Divergence detector disabled in practice

`g_game.c` ~967 still contains the stock consistency check
(`consistancy[i][buf] != cmd->consistancy → I_Error`). It is **not deleted**.
But:

- On the **live overlay path**, remote ticcmds are injected with whatever
  consistancy rode along (or none), and because each sim free-runs, the check
  *would* fire on real divergence — which is why the live path keeps
  `net_client_connected = false` and the netgame consistency comparison only
  bites when `netgame && !netdemo` and `gametic > BACKUPTICS`. In the scripted
  harness path it is deliberately satisfied by stamping the locally-expected
  value (`DGPT_OverlayRemoteCmds` → `G_ConsistancyForSlot`).

Net: the only oracle that would scream "your worlds diverged" is **defused** for
the cross-feed, so divergence is invisible. Monsters/barrels/health diverge
freely and nothing complains.

**Conclusion:** all three legs confirmed. The live game is N independent
single-player sims wearing each other's input as a hat.

---

## 2. What slice 7 already gives us (the asset to leverage)

This is the good news and it de-risks the whole build.

- **`d_loop.c` scripted-lockstep mode** (`DGPT_LoopSetScripted`, line 158;
  overlay at 174). When armed, `DGPT_OverlayRemoteCmds` drives **every** slot —
  including the sim's own — from the injected stream. This is exactly the shape
  of a real arbiter TicSet: one authoritative `{cmd[0..n)}` per tic consumed
  identically by every sim. It stamps each slot's `consistancy` from
  `G_ConsistancyForSlot` so the stock check passes *because the state genuinely
  matches*, not as a cheat.
- **`dgpt_state_checksum`** (`doomgeneric_patchtogether.c:550`) — FNV-1a over
  every player's mobj x/y/z/angle/momentum + health, `leveltime`, and **both RNG
  indices `rndindex`/`prndindex`**. The RNG indices are the canonical
  desync canary: if two sims call `P_Random` a different number of times, the
  digest diverges before any position drift is visible. Both exports are in the
  WASM export table (`build-doom-wasm.sh:207-208`).
- **`lockstep-determinism.acceptance.mjs`** runs 2 and 4 in-process WASM sims on
  one shared scripted TicSet log and asserts `dgpt_state_checksum` is
  **byte-identical every tic** (not "within 25%"). Re-running the same seed
  reproduces the per-tic trace exactly.

**The documented finding (decision log, 2026-05-24): the sims are ALREADY
bit-exact given an identical ordered TicSet.** No nondeterminism source needed
fixing; doomgeneric is fixed-point + shared-LUT-RNG. The slice-5 "within-25%"
compare was purely the read-then-inject one-tic lag artifact.

**Therefore the build is: deliver to every live peer the same ordered
consolidated TicSet per tic, and gate advancement on it.** The C engine and the
determinism are done. We need transport + barrier + a clean stall story.

The live path does **NOT** use the scripted/bit-exact path — `dgpt_set_scripted`
is never armed in DoomCard.svelte; the live overlay keeps the local slot built
by `G_BuildTiccmd` and only overlays remote slots last-value. Slice 7's proof is
a Node harness, walled off from the browser game.

---

## 3. Transport for ordered per-tic ticcmds

### Requirement

A **reliable, ordered, per-tic** stream of each peer's ticcmd to the arbiter,
and of the consolidated TicSet from the arbiter back to all peers. "Per-tic"
means tic N's ticcmd must never be silently replaced by tic N+1's — the barrier
needs every tic, in order.

### Options

| Option | Ordered? | Reliable? | Latency | Survives relay restart? | Fits P2P direction? | Verdict |
|---|---|---|---|---|---|---|
| **(a) Yjs `Y.Array` append-log per module** | Yes (CRDT total order) | Yes (CRDT, durable in the doc) | Relay RTT (~40–120ms LAN/region; awareness-class) | **Yes** (Yjs doc persists) | Neutral | **Recommended fallback / source of truth** |
| **(b) Dedicated relay message channel** | Yes if we sequence | Only if we add acks/resend | Low (one WS hop) | No (single stateful process; drifts/OOMs per memory) | No | Reinvents net_server.c over a fragile process |
| **(c) WebRTC datachannel (ordered+reliable)** | Yes (SCTP ordered) | Yes | **Lowest** (P2P, ~5–30ms) | N/A (no relay) | **Yes** (y-webrtc future) | **Recommended fast-path** |
| (d) Current: single sticky awareness field | **No (coalesces)** | No | awareness | n/a | n/a | The bug. Remove from the tic path. |

### Recommendation: WebRTC datachannel fast-path + Yjs append-log fallback/floor

1. **Fast-path: WebRTC ordered+reliable datachannel.** `doom-netcode.ts` ALREADY
   builds star-topology datachannels to the arbiter with awareness signaling +
   STUN, plus a relay fallback (lines 780–982). Create the channel with
   `{ ordered: true }` (already done, `dialPeer`) and **also reliable** (omit
   `maxRetransmits`/`maxPacketLifeTime` — default is reliable). Route
   `GAMEDATA`-shaped packets (peer→arbiter ticcmd, arbiter→peer TicSet) over it.
   This is the original-DOOM transport shape (`NET_CL_SendTiccmd` /
   `NET_SV_TransmitTic`) carried by SCTP. Latency is the lowest available and it
   matches the committed **y-webrtc-primary** future direction.

2. **Floor/fallback: a per-module `Y.Array<TiccmdRecord>` append-log.** When
   WebRTC fails to connect within `RTC_CONNECT_TIMEOUT_MS` (the existing 3s
   demote), peers append `{ slot, tic, fwd, side, ang, btn, seq }` to a shared
   `Y.Array` on the DOOM module's Yjs map. Because it is a CRDT array, **order is
   total and no tic is ever lost or coalesced** — the exact property awareness
   lacks. The arbiter reads the array, consolidates per tic, and appends TicSets
   to a second `Y.Array`. The log is **durable** (survives the single-process
   relay restarting/drifting — see memory note `relay-single-process-and-drift`),
   which the relay-message-channel option (b) cannot offer.

   - **Growth control:** prune entries older than `gametic - BACKUPTICS` (the
     arbiter is the single pruner; matches DOOM's 128-tic ring). The array never
     grows unbounded.
   - **Latency:** Yjs updates ride the same WS as awareness (~awareness-class
     RTT). Acceptable as a *fallback* (degraded), not the steady state.

3. **Why not the awareness field (current):** last-value-wins **by design**. It
   was the right call for the *presence/launch* envelopes (small, idempotent,
   sticky) but is structurally wrong for an ordered stream. Keep awareness for
   signaling/launch/roster; move the **tic stream** off it entirely.

4. **Relay constraint acknowledged:** the Hocuspocus relay is a single stateful
   process pinned to one machine (memory: `relay-single-process-and-drift`). The
   WebRTC fast-path keeps the tic stream **off** the relay entirely in the common
   case; the Yjs-log fallback rides the relay only when P2P fails, and is
   durable across the relay's known drift/restart, so a relay blip pauses rather
   than desyncs.

---

## 4. The lockstep barrier + buffering (without reintroducing the freeze)

### Use the engine's own barrier — but never spin-block

The original freeze class came from `BlockUntilStart`'s `I_Sleep(100)` spin and
`TryRunTics`'s inner `while (… lowtic < gametic+counts) { NetUpdate(); I_Sleep(1); }`
(d_loop.c 890–908) — there is no real `I_Sleep` in a cooperatively-scheduled WASM
tick, so it busy-waited and wedged the tab. Slice 4 dodged this by setting
`net_client_connected = false`. We re-enable lockstep **without** the spin:

1. **Flip `net_client_connected = true`** for netgames (gate it: only when
   `dgpt_netgame_players > 1`; SP/default path stays false → byte-identical SP
   behavior). With it true, `GetLowTic` clamps `lowtic = min(maketic, recvtic)`
   and `TryRunTics` will only run tics ≤ `recvtic`.

2. **Feed a real per-tic ticcmd queue into `D_ReceiveTic`.** Add a thin C entry
   point `dgpt_receive_ticset(tic, cmds[N], mask)` that writes
   `ticdata[tic % BACKUPTICS]` and bumps `recvtic` (the JS arbiter calls it once
   per consolidated tic). This is the legit `recvtic` advance the live path never
   does today. The arbiter's own sim and every peer consume the **same** TicSet
   via this path (this is the scripted-overlay shape, but driven live).

3. **Drive the pump from a bounded loop, not rAF, and return instead of
   sleeping.** Replace the rAF `runTic()` call for netgames with a
   `pumpNetTics()` that runs `min(recvtic - gametic, MAX_CATCHUP)` tics this
   frame and **returns** when starved — exactly like `TryRunTics`'s "Don't stay
   in this loop forever … return to update the screen" early-out (line 902–905),
   but realized in JS so the tab never busy-waits. No `I_Sleep`. Rendering still
   happens every rAF off the latest framebuffer; the *sim* only advances when
   tics are available. This is the key anti-freeze invariant.

4. **Buffering = BACKUPTICS-style local lead.** Keep the existing
   `BuildNewTic` lead cap (≤8 tics, line 290) so a peer builds a little ahead to
   hide RTT. The arbiter consolidates tic N when **all live slots** have
   submitted N (or the timeout below fires). `BACKUPTICS = 128` gives ~3.6s of
   ring at 35Hz — ample.

### Stall handling (a peer stops sending tic N)

- **Short stall (< `PAUSE_MS`, e.g. 500ms):** the arbiter withholds the TicSet;
  every peer naturally *pauses* (their pump starves and returns each frame — the
  screen freezes on the last frame, input still responsive, **no busy-wait, no
  crash**). This is original-DOOM "waiting for player N."
- **Long stall (> `DROP_MS`, e.g. 3s):** the arbiter **drops the peer to
  spectator** — emits the TicSet for tic N with that slot's `mask` bit cleared
  (`players_mask[i] = false` in `D_ReceiveTic`). DOOM's `RunTic` then flips
  `playeringame[i] = false` (the dropped marine vanishes — vanilla behavior).
  The remaining peers resume immediately. Determinism preserved because the drop
  is *itself* an authoritative TicSet event applied identically everywhere.
- **Backgrounded-tab throttle** (browser → 1Hz rAF): treat as a stall; the
  Page Visibility API can proactively tell the arbiter to drop a hidden peer to
  spectator after `DROP_MS` rather than stalling the squad.

### Why this can't re-freeze

The freeze was a **spin inside one tic**. Here the barrier is expressed as
"advance ≤ available tics, then return." Starvation = a paused render, not a hung
thread. The only thing that ever blocks is `gametic` catching up to `recvtic`,
and that is bounded by `MAX_CATCHUP` per frame and resolved by either a new
TicSet or a drop.

---

## 5. Deterministic start + late join

### Start

Already correct: `dgpt_start_netgame` (g_game.c) loads the level via `G_InitNew`
with identical `(skill, episode, map, num_players)` on every peer, set marines at
per-slot coop starts, identical RNG (the shared `rndtable[]` LUT advanced only by
in-game events). The arbiter broadcasts settings + a monotonic `launchId`; all
peers call `startNetGame(settings, mySlot)`. **The missing piece for true
lockstep is only that all peers must agree tic 0 is the same wall moment** — i.e.
the arbiter's first consolidated TicSet is `tic = 0`, and no peer runs a tic
before it receives TicSet 0. With the barrier of §4, that falls out for free:
`recvtic` starts at 0, `gametic` starts at 0, nobody advances until TicSet 0
arrives.

### Late join — recommended: coordinated synchronized restart

DOOM has **no** mid-level join (player set is fixed at `G_InitNew`; the tic
stream assumes constant `playeringame[]`). Two options:

| Approach | Cost | Determinism | Verdict |
|---|---|---|---|
| **Coordinated restart of current map at agreed tic** (everyone `G_InitNew`s the same map, larger `num_players`, joiner spawns at coop start) | Low (~1–2s reload) | **Trivially preserved** — fresh identical start | **Recommended** |
| Gamestate snapshot transfer (serialize all mobjs/specials/RNG, ship to joiner) | High (serializer for the entire P_* world + RNG indices; large payload; fragile) | Hard (must capture *every* deterministic field incl. RNG indices) | Defer |

This is **exactly the mechanism `doom-late-join.spec.ts` already drives**: the
arbiter seats the joiner ACTIVE at the next slot and **re-launches the current
map** (same skill/episode/map, `num_players+1`) via a bumped `launchId`; every
peer reloads via `G_InitNew`. Under true lockstep the only change is that the
relaunch's first TicSet is the new shared tic-0 — so all peers (including the
joiner) restart bit-identically. Progress in the current map is lost on relaunch;
that is the accepted v1 tradeoff (matches the existing spec's "fast reload").

Determinism is preserved because a relaunch is just a *new* deterministic start;
no state is transferred, so there is nothing to get wrong.

---

## 6. Migration / phasing

Each phase is independently testable and independently shippable. The live
free-run path is **not removed** until P3 proves the barrier path is at least as
stable.

### P0 — Spike (this PR, isolated): de-risk transport + barrier in-process
- Extend the slice-7 in-process harness with an **ordered append-log transport
  simulation** + a **barrier** between two sims, and assert
  `dgpt_state_checksum` matches every tic (the real success metric).
- No live-path changes. Proves the transport SHAPE (ordered log + barrier
  consolidation) keeps two sims bit-identical. See §8.

### P1 — Ordered ticcmd log + flip barrier on, 2 peers, fresh game
- Add `Y.Array` append-log transport in `doom-netcode.ts` (behind a
  `lockstepBarrier` flag, default OFF — live path unchanged when off).
- Add C entry point `dgpt_receive_ticset` + gate `net_client_connected = true`
  for `num_players > 1`. Add `pumpNetTics()` (bounded, non-blocking) in
  DoomCard, used only when the flag is on.
- **Test:** extend the @collab repro to assert SHARED STATE — spawn a
  monster/barrel, have P1 kill/explode it, assert P2's `dgpt_state_checksum`
  (or a barrel-count/monster-health export) **MATCHES**. The consistency byte
  must MATCH rather than be stamped-to-pass.

### P2 — Late-join via synchronized restart
- Wire the arbiter relaunch (already in `doom-roster`/`doom-late-join.spec.ts`)
  to the barrier path: relaunch resets `recvtic=gametic=0`, new tic-0 TicSet.
- **Test:** `doom-late-join.spec.ts` extended to assert post-relaunch checksums
  match across all peers.

### P3 — 4 players + flip default
- Validate the 4-context happy path on the barrier; once stable, make the
  barrier the default and **delete the free-run overlay + `reinjectKnownTiccmds`
  band-aid**. Re-enable the live consistency check as the oracle (§7).

### P4 — Latency / jitter handling
- Tune `MAX_CATCHUP`, `PAUSE_MS`, `DROP_MS`, build-ahead. Add the Page
  Visibility drop. Optional: `ticdup` bump under sustained jitter. GGPO-style
  rollback explicitly **deferred** (3+ weeks; lockstep first).

---

## 7. Risks

| Risk | Severity | Mitigation |
|---|---|---|
| **Latency: barrier adds RTT at 35Hz** (28.6ms/tic) | High | WebRTC fast-path (~5–30ms P2P) + build-ahead (≤8 tics) hides typical RTT. Yjs-log fallback is degraded-but-playable. If unplayable under real jitter → P4 rollback. |
| **Relay is a single stateful process** (drifts/OOMs, memory note) | High | Keep tic stream OFF the relay via WebRTC in the common case. Yjs-log fallback is **durable** across relay restart (CRDT), so a relay blip pauses (recoverable) instead of desyncs. Don't run the tic stream over awareness (its coalescing is what OOMs the relay with churn). |
| **WASM determinism drift** (float/RNG/uninit memory) | Low (already disproven) | Slice 7 PROVED bit-exact across N sims w/ identical TicSet. Same `.wasm` on all peers (Cache API). Fixed-point math + shared RNG LUT. Keep `dgpt_state_checksum` (incl. RNG indices) as the live canary. |
| **Re-freeze if a peer stalls** | Medium | §4: barrier is "advance ≤ available, return" — never spin/`I_Sleep`. Stall → pause → drop-to-spectator. No busy-wait possible. |
| **Consistency check (#-defused) firing in production** | Medium→**asset** | RE-ENABLE it (`g_game.c` ~967) as the correctness oracle once lockstep is real — it is the *original divergence detector*, currently intact but bypassed. A fire then = a true desync we must fix, not noise. Wire it to a metric/alert (memory: `observability-priority`) instead of `I_Error` crashing the tab: catch in JS, log + drop to spectator + telemetry. |
| **Late-join relaunch loses in-map progress** | Low | Accepted v1 tradeoff (matches existing spec). Snapshot transfer deferred. |

---

## 8. Optional spike (isolated; does NOT touch the live path)

**Goal:** prove that an **ordered append-log + a consolidation barrier** keeps two
sims' `dgpt_state_checksum` MATCHING — de-risking the §3/§4 transport+barrier
choice before any live-path code is written.

**Shape (throwaway, Node, alongside the existing harness):**
1. Build the MP node artifact (reuse `lockstep-determinism.acceptance.mjs`'s
   loader). Spawn 2 in-process WASM sims, both `dgpt_start_netgame(coop, E1M1,
   …, num_players=2)` and `dgpt_set_scripted(1)`.
2. Model the transport as a shared **ordered array** `log[]` of
   `{ tic, slot, cmd }` — append-only, total order (the `Y.Array` semantics,
   simulated). Each sim "sends" by appending; neither sim reads ahead of the
   barrier.
3. **Barrier:** a tic N is "ready" only when `log` contains slot-0 AND slot-1
   entries for tic N. Consolidate into one TicSet, inject into BOTH sims via the
   scripted overlay, run one tic on each.
4. After every tic assert `simA.dgpt_state_checksum() === simB.dgpt_state_checksum()`.
   Run ~300 tics with divergent scripted inputs per slot (so the worlds actually
   do interesting things — fire, move, hit a barrel).

**Success metric:** checksums equal every tic (NOT "within 25%"). If they match,
the ordered-log + barrier transport is proven sufficient for bit-exact shared
state, and P1 is safe to build.

This spike is **not merged into the live path** and changes no live netcode. It
is gated SKIP-clean when `DOOM1.WAD` is absent (gitignored), like the sibling
harness, so it never wedges CI.

---

## 9. Decision log

- **2026-05-27** — design drafted for owner sign-off. Confirmed the 3 broken
  legs (no barrier / awareness-overlay / defused consistency check). Confirmed
  slice 7 already proves bit-exact determinism given an identical ordered
  TicSet, so the build reduces to transport + barrier + stall story.
  Recommended: WebRTC datachannel fast-path + Yjs `Y.Array` append-log fallback;
  re-enable the engine barrier via `net_client_connected = true` + a real
  `dgpt_receive_ticset` queue, pumped non-blocking from JS (no `I_Sleep`);
  late-join via synchronized restart (no snapshot); re-enable the consistency
  check as the live oracle wired to telemetry, not `I_Error`. Phased P0..P4 with
  the @collab shared-state assertion as the per-phase gate.
