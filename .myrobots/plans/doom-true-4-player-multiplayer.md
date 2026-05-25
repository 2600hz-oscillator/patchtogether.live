# DOOM — true 4-player networked multiplayer

User ask (2026-05-24 session):

> when the first player starts a game it is inherently a multiplayer game and if someone else in the shared rack makes an instance of doom then they are connected in as another player. DOOM supported up to 4 players over LAN so this should generally work but we'll need LAN simulation layer or something.

This plan replaces the current "shared-input + framebuffer mirror" model (PR #258 + #260) with true per-peer DOOM instances cooperating in a single 4-player netgame. Read this end-to-end before writing code; the slice plan in §5 depends on the architecture choice in §2.

---

## 1. Executive summary

doomgeneric vendors the original `d_loop.c` netplay state machine and the `d_ticcmd.h` per-player command struct, but the `net_*.c` SDL-network implementation files are **NOT vendored** (only the headers are present) and the build script defines neither `FEATURE_MULTIPLAYER` nor compiles any `net_*.c`. The WASM binary today contains only `D_StartNetGame`'s `#else` path which forces `num_players=1`. To get true netplay we need to (a) re-introduce a slimmed-down `d_loop.c`-style lockstep loop in `doomgeneric_patchtogether.c`, (b) replace the missing `net_*.c` implementations with a JS-driven transport that calls back into WASM each tic, and (c) elect a single peer as the **arbiter** that collects all four players' ticcmds and broadcasts the consolidated set back. Recommended transport: **WebRTC data channels with hocuspocus-as-signaling, falling back to a hocuspocus WebSocket relay channel when WebRTC fails (corp NAT, no STUN, etc.)**. The "host" peer (lex-smallest user id, matching today's `pickHost`) is the arbiter; one DOOM module per peer, capped at 4; each peer's WASM runs locally and renders only that peer's first-person view; spectators-when-full see the host's framebuffer (existing v1 path, kept as fallback).

---

## 2. Recommended architecture

### One-line summary

**Per-peer WASM + arbiter-collected lockstep ticcmds over WebRTC data channels (hocuspocus signaling + WS-relay fallback). One DOOM module per peer; 4 modules max per rack; each peer renders their own viewport.**

### Picture

```
   ┌──────────── Peer A (arbiter / "host", lex-smallest userId) ─────────────┐
   │                                                                          │
   │  DOOM WASM                                                               │
   │    │  produces local ticcmd_A every 1/35s (TICRATE=35)                   │
   │    │                                                                     │
   │    ▼                                                                     │
   │  i_pt_net.c (JS bridge)                                                  │
   │    │                                                                     │
   │    ▼                                                                     │
   │  doom-netcode.ts (TS) ─── DataChannel (B,C,D) ──► aggregates ticcmds ─┐  │
   │                                                       │               │  │
   │                                                       ▼               │  │
   │                                              tic N ready when         │  │
   │                                              {A, B, C, D} present     │  │
   │                                                       │               │  │
   │            ◄────────── broadcast TicSet(N) ───────────┘               │  │
   │            (back to all peers including self)                         │  │
   │                                                                       │  │
   │  WASM applies TicSet(N) deterministically → identical world state ◄───┘  │
   │  on all peers                                                            │
   └──────────────────────────────────────────────────────────────────────────┘

   Peers B, C, D: identical pipeline, but their netcode.ts treats peer A as
   the upstream "arbiter" — they SEND their ticcmd_X to A and RECEIVE
   TicSet(N) back. No peer-to-peer fan-out of ticcmds; only arbiter→peer
   and peer→arbiter. (3 data channels at the arbiter; 1 each at the others.)
```

### Why this combination?

| Decision | Choice | Why |
|---|---|---|
| WASM placement | One full instance per peer (not one shared) | Each player needs their first-person view = renderer is per-player by definition; we already pay the ~5 MB WASM cost once anyway; per-peer = no host-migration cliff (anyone can leave; the rest keep playing). |
| Authority model | Arbiter-collected lockstep (host gathers all 4 ticcmds, broadcasts TicSet) | Matches doomgeneric's existing `d_loop.c` shape (the original game already wants `recvtic`-style consolidated tic data from a "server" — see §Appendix A); avoids the n² peer-to-peer ticcmd traffic of pure-P2P doom; one process makes the "everyone is here for tic N" determination so all peers advance identically. |
| Transport | WebRTC data channels (unreliable-ordered) with WS-relay fallback | Per-tic latency requirement is ≤30ms; awareness round-trip is 80-200ms (too slow). WebRTC unreliable-ordered = TCP-like ordering, UDP-like latency, ideal for tic streams. Hocuspocus already in-flight = free signaling. WS relay through hocuspocus is fallback for symmetric NAT / no-STUN (1-2 RTT extra, still under 100ms in practice). |
| Player slot assignment | Lex-sorted user-id → slot index (0..3) | Deterministic, no negotiation; matches today's `pickHost` tie-break logic; player 0 = arbiter. |
| Late-joiner | Spectator-only until next map (see §3 Q3) | Doom has no mid-level join in the upstream protocol — `D_StartNetGame` happens once at session start. We can either intermission-rejoin or stay as spectators; recommend latter for v1 simplicity. |
| `maxInstances` | **Raise from 1 → 4**, with an additional constraint: per-peer instance limit = 1 | Mirrors the per-rack 4-user cap. A peer can't spawn 2 DOOM modules (one slot per peer). Enforce in the spawn path by checking owner-userId against existing instances. |
| Rendering | Each card renders only that peer's local viewport | Matches "card = your screen"; simpler than 4-up; cross-peer "watch your friend's view" deferred. |
| WAD | Single WAD per rack, chosen by player 0 at session start | doomgeneric checks `wad_sha1sum` in `connect_data`; mismatched WADs would desync. Lock it in. |
| Game mode | Coop OR deathmatch, chosen by player 0; locked at session start | doomgeneric's `deathmatch` and `nomonsters` etc. are baked into `LoadGameSettings` at game start. Mode changes require ending the session. |

### What we keep from the current ship

- `doom-runtime.ts` / `doom-presence.ts` / `DoomCard.svelte` stay; **the framebuffer-mirror path becomes the fallback** used when (a) a 5th peer joins (spectator), (b) WebRTC fails AND ws-relay fails (degraded), or (c) the user explicitly turns netplay off for a single-player session.
- `pickHost` lex-min election stays — it now picks the **arbiter**, not the WASM-owner.
- `dgpt_set_key` queue stays — it now feeds the LOCAL `G_BuildTiccmd` path; the relayed ticcmds come in via a new entry point.

### What we throw away

- The 10 Hz framebuffer broadcast over Yjs awareness, in the steady-state 4-player case. Each peer renders their own framebuffer now; no need to ship 1 MB/s of pixel data across awareness. (Spectator-only path keeps it, since the spectator has no WASM running of their own.)

---

## 3. Open questions for the user

These are the things I can't decide without you. Numbered so we can reference them in PR threads.

1. **Player-slot lock-in**: should slot assignment be **stable across the session** (lex-sorted at session-start, never reshuffled even if the alphabetically-earlier user disconnects) or **dynamic** (lex-sorted on current member set, so slots can shift mid-game)? Stable is simpler and matches DOOM (a "player who left" is `playeringame[i] = false` but slot i is reserved). Dynamic feels more "live" but breaks DOOM's slot semantics (corpses, scores, frags). Recommendation: **stable**. Confirm?

2. **Late join**: when player 5 (or a returning player 2) arrives mid-game, they:
   - (a) wait as **spectator** until current level ends, then enter at next intermission (recommended; cleanest);
   - (b) get **rejected with a friendly message** ("game in progress, ask the host to restart");
   - (c) we attempt **mid-level rejoin** (requires a full world-state snapshot + replay; expensive, high desync risk).
   I recommend (a). Your call?

3. **Quitter / disconnect behavior**: when a player drops mid-session, their `playeringame[i]` flips false (vanilla DOOM behavior — their character vanishes). Options:
   - (a) leave their slot empty until next map (DOOM-native);
   - (b) replace with a bot (we don't have AI bot code; would have to port chocolate-doom's `bot_*` if it exists, which it doesn't in vanilla — Crispy/PrBoom have it);
   - (c) freeze their character in-place ("statue" mode).
   I recommend (a). Your call?

4. **5th-peer behavior**: per memory, the rack cap is 4 concurrent connections, which fits exactly. But if the cap ever bumps to 5+ (or some racks are configured larger), the 5th joiner-with-a-DOOM-module is currently undefined. Options:
   - (a) **block module spawn** with "DOOM is full" toast;
   - (b) **spectator-only** (render host's framebuffer, existing path);
   - (c) **5th player slot** (requires patching `MAXPLAYERS` to 8 — feasible since `NET_MAXPLAYERS` is already 8, but breaks vanilla compat; PsyDoom etc. do this).
   I recommend (a) for v1, (b) post-v1. Your call?

5. **Mode / WAD / level selection UX**: player 0 (the arbiter) picks game mode (coop/deathmatch/survival), skill, episode, map at session start via a "New Game" dialog on their DoomCard. Other players see "waiting for player 1 to start the game" until player 0 hits "Launch". Does this match your mental model, or should mode-selection be a vote / consensus thing?

6. **Tic rate vs frame rate decoupling**: DOOM runs at 35 Hz tics; our video engine runs at 60 Hz. The current per-peer model calls `dgpt_tick` per-video-frame; in netplay we MUST run one tic per netcode boundary (gated on `TicSet(N)` arrival), which decouples game time from video time. Risk: dropped video frames if WebRTC stalls. Acceptable, or do we want a "predict locally, rollback on mismatch" GGPO-style model? GGPO is much more code (~3-4 weeks vs ~1-2 for lockstep). I recommend lockstep first; rollback as a follow-up if jitter is unplayable. Your call?

7. **Audio in netplay**: DOOM's i_pcmgen mixer runs locally per-peer. Sound effects are driven by game events the peer observes locally (monster dies, weapon fires). With deterministic lockstep all peers should generate identical SFX at identical tics — confirmed? Or do we want explicit sound-event broadcast for added safety? I recommend "trust determinism, no explicit broadcast"; revisit if drift shows up in QA.

8. **Single-player still works?** A peer alone in a rack with one DOOM module should still play normally (current behavior). The plan keeps this path: 1-player session uses the existing single-WASM no-arbiter flow. **However**, when a 2nd peer spawns DOOM mid-session, do we (a) abort the current 1-player game and restart in multiplayer mode, or (b) keep player 1's game running and tell player 2 "wait, current session is single-player, ask them to restart for coop"? I recommend (b) — DOOM can't gracefully add a player to a running game. Your call?

9. **Save / load**: vanilla DOOM has save/load to file; we don't expose it today. Multiplayer DOOM in the original game didn't allow saves (only single-player did). I recommend: **no save/load in multiplayer**, matching vanilla. Confirm.

10. **WebRTC TURN server**: WebRTC peer-to-peer fails on symmetric NAT (~10-15% of corp / mobile users). STUN-only gets us most users; TURN is needed for the rest. We have hocuspocus-as-WS-relay as a fallback so we don't STRICTLY need TURN — but it adds server load. Do you want us to (a) skip TURN and use ws-relay fallback for ~15% of users, or (b) stand up coturn alongside hocuspocus for true P2P? I recommend (a) for v1; revisit if ws-relay traffic costs become a problem.

11. **Per-peer DOOM module visual identity**: when 4 peers each have a DOOM card on the rack, all 4 cards look identical. Do we (a) add a "Player N — alice/bob/carol" badge in each card header, (b) color-tint each card by player slot, (c) both? I recommend (c). Your call?

12. **Module-spec snapshot determinism**: each peer's DOOM module is now a per-peer node in the shared Yjs graph (so the engine factory runs on each peer). The module-spec snapshot (used for layout persistence) currently encodes only static def fields; do we need to encode the player-slot index, or does the lex-sort give us reproducibility for free? Recommendation: lex-sort + don't persist slot. Your call.

13. **VRT baseline** for DoomCard: today it has 1 host + 1 spec baseline. With 4 peers we'd have 4 viewports; we cannot freeze a deterministic frame across 4 WASM instances reliably (jitter). I recommend skipping VRT for DoomCard entirely (it's already nondeterministic; the value is in the e2e dynamics test, not the pixel snapshot). Your call.

---

## 4. Slice breakdown

Each slice = a few-day chunk, one PR. Slices are ordered for incremental value — slice 0 is a no-op refactor that ships even if nothing else does; slice 3 is the first user-visible multiplayer slice; slice 7 is "shipped" for v1.

| # | Title | LOC est | Days | Depends on | User-visible |
|---|---|---|---|---|---|
| 0 | Vendor real `net_*.c` from chocolate-doom + add `FEATURE_MULTIPLAYER` build flag (disabled by default) | ~3500 LOC vendored + ~50 ours | 2 | — | No |
| 1 | Custom transport module: write `net_pt.c` implementing `net_module_t` against JS-callable hooks | ~400 | 3 | 0 | No |
| 2 | TS netcode layer (`packages/web/src/lib/doom/doom-netcode.ts`) — WebRTC + WS-relay fallback + arbiter election + TicSet aggregation | ~800 | 4 | 1 | No |
| 3 | Module-instance model: raise `maxInstances` to 4, add per-peer-instance cap, wire DoomCard to register its peer's slot | ~250 | 2 | 2 | Yes — multiple DOOM cards |
| 4 | Session lifecycle: New Game dialog (mode/episode/skill/map) on player-0's card; "waiting for host" on others; lock settings until session ends | ~400 + UI | 3 | 3 | Yes — actual multiplayer game starts |
| 5 | Per-card identity: player slot badge, color tint, per-player viewport (each peer renders their OWN framebuffer, no host-mirror in steady state) | ~200 | 1 | 4 | Yes — players see their own POV |
| 6 | Late-joiner spectator path: 5th peer or mid-game joiner sees host's framebuffer (reuses existing v1 framebuffer broadcast); intermission rejoin | ~300 | 2 | 4 | Yes |
| 7 | 4-context Playwright test + flake stabilization + docs page | ~500 e2e + ~150 docs | 3 | 5 | Yes — shipping bar |

**Total**: ~6500 LOC (most of which is vendored chocolate-doom net code, not ours). **Net new patchtogether code**: ~2700 LOC. **Wall time**: ~20 working days, sequential.

### Slice 0 — Vendor `net_*.c` from chocolate-doom

- Pull `net_client.c`, `net_server.c`, `net_io.c`, `net_packet.c`, `net_query.c`, `net_structrw.c`, `net_loop.c`, `net_common.c` from chocolate-doom upstream (matching the SHA the existing headers came from — see `git log` on the headers if available, else use latest stable).
- Do NOT vendor `net_sdl.c`, `net_dedicated.c`, `net_gui.c`, `net_petname.c` — these depend on SDL2 / curses / external libs we don't ship.
- Add `-DFEATURE_MULTIPLAYER` to `build-doom-wasm.sh` CFLAGS, gated behind a new env var (`DOOM_MP=1`) for now so v1 single-player build is unaffected until slice 3 is ready.
- Acceptance: WASM still builds; single-player still works; new symbols `NET_CL_Init`, `NET_SV_Init`, etc. are present in the export table (verify with `wasm-objdump`).

### Slice 1 — Custom `net_pt.c` transport module

- New file `packages/web/native/doomgeneric/doomgeneric/net_pt.c` implementing `net_module_t`:
  ```c
  net_module_t net_pt_module = {
    NET_PT_InitClient,   // calls into JS via EM_ASM_INT("return Module.PTNet.initClient()")
    NET_PT_InitServer,
    NET_PT_SendPacket,   // serializes net_packet_t → uint8_t* + len, calls Module.PTNet.send(addr, data, len)
    NET_PT_RecvPacket,   // polls Module.PTNet.poll(), returns 0/1 + a freshly-allocated net_packet_t
    NET_PT_AddrToString,
    NET_PT_FreeAddress,
    NET_PT_ResolveAddress,
  };
  ```
- JS-side hooks via Emscripten's `EM_JS` (preferred over `EM_ASM` — gives us a typed C signature). The hooks call into a global `Module.PTNet` object that the JS shim populates at init time.
- New exports: `_dgpt_net_register` (let JS install the `Module.PTNet` table after WASM load), `_dgpt_net_inject_packet` (let JS deliver an incoming packet into the WASM-side recv queue without blocking).
- Acceptance: a Node-side unit test instantiates the WASM with a stubbed `PTNet` (loopback to itself, single peer) and verifies that `NET_SV_Init` + `NET_CL_Connect` succeed and exchange `NET_PACKET_TYPE_SYN` / `NET_PACKET_TYPE_ACK`.

### Slice 2 — TS netcode layer

- New module: `packages/web/src/lib/doom/doom-netcode.ts`. Top-level shape:
  ```ts
  export class DoomNetcode {
    constructor(opts: {
      provider: HocuspocusProvider;    // signaling + member presence
      moduleId: string;                // the DOOM card's node id
      localUserId: string;
      runtime: DoomRuntime;            // .injectNetPacket(buf) added in slice 1
      onArbiter: (isArbiter: boolean) => void;
    });
    start(): void;       // open data channels, run arbiter election, register Module.PTNet hooks
    stop(): void;
    // For tests:
    debugStats(): { peers: string[]; ticLag: number; lostFrames: number };
  }
  ```
- Arbiter election: lex-min `localUserId` among rack members (reuses `pickHost`).
- Data channel topology: arbiter opens channels to peers via `RTCPeerConnection`; offers/answers ride on awareness (small payloads — 1-2 SDP messages + a few ICE candidates per pair).
- WS-relay fallback: when an RTCPeerConnection fails to negotiate in 3s, the netcode falls back to a `provider.awareness.setLocalStateField('doom-net:to:<peerId>', { seq, payloadB64 })` path. This is bandwidth-inefficient but works through any NAT.
- TicSet aggregation: arbiter buffers per-tic ticcmds, ships TicSet(N) when all live peers have submitted, ships TicSet with `null` placeholders for missing peers after a 100ms deadline (vanilla DOOM behavior — `playeringame[i] = false`).
- Acceptance: vitest unit tests with a stubbed transport prove (a) lex-min election, (b) TicSet aggregation, (c) timeout-triggered partial TicSet, (d) WS-relay fallback. No actual WebRTC in unit tests — those go in slice 7.

### Slice 3 — Module-instance model

- `video/module-registry.ts`: add an optional `perPeerCap?: number` field; doomDef sets it to 1. Engine's spawn path checks `existingInstances.filter(n => n.ownerUserId === currentUserId).length < perPeerCap`.
- `doomDef.maxInstances` = 4.
- New `node.ownerUserId` field on graph nodes (existing nodes default to `null` = unowned, current behavior). Doom nodes always set ownerUserId on spawn.
- DoomCard: read `node.ownerUserId`; if it matches `localUserId`, this card is "mine" and runs the local WASM + the netcode SEND path; if not, it's "a peer's" and either renders the peer's framebuffer (degraded) or doesn't render at all (steady state — each peer only ever sees their own card's content rendered).
- Acceptance: spawning DOOM as user A then user B in a 2-tab e2e adds two DOOM cards to the shared rack; user A only sees their own card's WASM render; user B only sees theirs. No interaction between them yet (slice 4 wires the netcode).

### Slice 4 — Session lifecycle

- "New Game" dialog on player-0's DoomCard (after their WASM loads): mode (coop / deathmatch / deathmatch-2.0 / survival), skill (ITYTD → Nightmare), episode (1-3), map (1-9). Defaults reasonable.
- "Launch" button broadcasts `net_gamesettings_t` to peers via the netcode arbiter; all peers call `D_StartNetGame(settings)`. After this, ticcmd lockstep begins.
- Peers 1-3 see "Waiting for player 0 to start..." until launch.
- Once launched, the New Game dialog is disabled until `gamestate == GS_FINALE` (end of level) — at intermission, player 0 can pick the next map.
- Acceptance: 2-tab e2e with both peers spawning DOOM, player 0 picking coop+E1M1+ITYTD, hitting Launch — both peers' canvases show the same level intro, both peers move their own player.

### Slice 5 — Per-card identity + per-peer viewport

- Card header shows "Player 1 — <username>" with a color tint matching the doom-engine player color (player 0 = green, 1 = indigo, 2 = brown, 3 = red — vanilla DOOM colors).
- Each card renders its peer's WASM framebuffer; no host-mirror path in steady state.
- Acceptance: 4-tab e2e (Playwright with 4 contexts) where each peer's canvas shows the same map from a different first-person angle; moving in one peer's tab does NOT move the camera in others, but the other peers see your character sprite move past their view.

### Slice 6 — Late-joiner spectator + intermission rejoin

- 5th peer (or a 5th DOOM card if cap somehow bumps) sees a spectator viewport (host's framebuffer broadcast, reusing v1 awareness path).
- At intermission (`gamestate == GS_INTERMISSION`), the netcode arbiter accepts new players and rebuilds `playeringame[]` for the next map.
- Acceptance: e2e with 3 peers playing, 4th peer joins mid-level → sees host's view; reaches end of map → 4th peer gets a player slot on the next map.

### Slice 7 — 4-context Playwright + docs

- Scale `doom-multiplayer.spec.ts` to 4 contexts. Use Playwright's `browser.newContext()` repeated 4 times; one shared rack id.
- Determinism test: record one good 30-second session as a TicSet log; replay on a single-peer harness; assert framebuffer hash matches.
- Docs page `docs/src/content/modules/doom-multiplayer.md`: how to play, how to invite, how to debug.
- Acceptance: 4-tab Playwright test passes on darwin in <60s; recording reproduces deterministically.

---

## 5. Risks

### Technical risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| WebRTC NAT-traversal failures (symmetric NAT, corp firewalls) | High (~15%) | Fallback path required | WS-relay fallback in slice 2; user-facing "degraded netcode" indicator |
| Lockstep stalls when one peer's RAF tab is backgrounded (browser throttles 1 Hz) | High | Game becomes unplayable | Use `BroadcastChannel`/`Visibility API` to detect; arbiter timeouts a backgrounded peer to `playeringame[i] = false` after 1 sec |
| WASM determinism drift between peers (different floats? different libc? different memory layout?) | Medium | Hard desync, world states diverge | Same wasm.binary on all peers (Cache API ensures this); doomgeneric uses fixed-point math for game logic = deterministic; only `random()` is a divergence risk, but it's seeded from the shared `net_gamesettings_t.random` |
| Vendored chocolate-doom `net_*.c` has SDL2 dependencies we missed | Medium | Slice 0 stalls | Audit each .c for `#include "SDL"` and either stub or replace before vendoring; budget +1 day |
| Audio drift across peers (PCM mixers desync) | Low | Cosmetic, not gameplay | i_pcmgen.c is deterministic given identical input events; accept; revisit if QA flags |
| ticcmd compression worth doing? raw is 12 bytes × 35 tics/s × 4 players = 1.6 KB/s per peer | Low | Bandwidth concern | Vanilla DOOM uses `NET_WriteTiccmdDiff` (delta against previous tic). Slice 1 picks this up "for free" by using the vendored `net_packet.c` codecs |

### UX risks

| Risk | Mitigation |
|---|---|
| 4 DOOM cards on one screen overwhelms the rack | Card auto-collapses to small "thumbnail" mode when non-focused; spectator card defaults to collapsed |
| New Game dialog is single-arbiter-owned, feels arbitrary | Slice 4 ships with arbiter-only; future slice can add "request mode change" voting if QA complains |
| Player vanishes when they close their tab mid-fight | Vanilla DOOM behavior; show a small "Player N left" toast on remaining peers' cards |
| Per-peer card cap (1) feels surprising — "why can't I spawn 2 DOOM cards?" | Spawn UI shows greyed-out DOOM in the module palette with tooltip "You can only have one DOOM card per rack" when peer already has one |

### Scope-creep risks

- **GGPO-style rollback** (Q6): tempting but ~3 weeks of work + significant complexity. Lockstep first; if jitter is unplayable in QA, slice 8 = rollback.
- **Voice chat** (push-to-talk over WebRTC): tempting since we already have WebRTC infra; explicitly DEFERRED. Not in this plan.
- **Spectator camera** (free-flying observer view, not pegged to host): would require WASM extensions; deferred to post-v1.
- **More-than-4 players** (PsyDoom-style 8-player): bumping `MAXPLAYERS` from 4 → 8 breaks vanilla save compat (which we don't care about — we don't save in MP) but also breaks demo compat AND requires touching color tables, statusbar widths, and netcode buffer sizes. Out of scope.

---

## 6. Test strategy

### Layer 1: Unit tests (vitest)

- `doom-netcode.test.ts` — arbiter election (lex-min); TicSet aggregation under all-arrived / timeout-partial / single-peer cases; WS-relay fallback trigger; packet codec round-trips (encode/decode `net_packet_t` JSON envelope).
- `doom-runtime.test.ts` (extend existing) — `injectNetPacket(buf)` path puts bytes into the WASM recv queue without blocking; `popOutgoingNetPacket()` returns bytes the WASM wants to send.

### Layer 2: WASM-in-Node determinism (new harness)

- New file `packages/web/native/doomgeneric/tests/lockstep-determinism.ts` — spin up TWO WASM instances in Node, wire their netcode together with a deterministic in-process transport, feed identical ticcmd streams, assert framebuffer hashes match after N tics.
- Catches the "different math on different machines" class of bugs before it hits CI Playwright.

### Layer 3: Playwright multi-context e2e

- 2-context e2e (slice 4 acceptance): one tab is player 0, other tab is player 1; both spawn DOOM; player 0 starts coop game; both move + assert frame divergence (= different POVs).
- 4-context e2e (slice 7 acceptance): four tabs, four DOOM cards, deathmatch on E1M5; all four issue different keypresses; assert all four canvases change; assert TicSet messages flow.
- Flake tolerance: WebRTC handshake takes 200ms-3s depending on STUN; tests use `waitForFunction` with 10s timeout; fallback to ws-relay path if WebRTC fails (asserted as a debug indicator, not a hard fail — both paths are valid).

### Layer 4: Trace-replay (slice 7)

- Record one "good" 30-second 4-player session as a JSONL log of TicSet broadcasts.
- Replay against a single-WASM harness in Node; assert framebuffer hash at t=30s matches recorded.
- This catches regressions in WASM determinism that would manifest as desyncs in production.

### Layer 5: Manual smoke

- 4 humans on 4 laptops in the office on the same LAN: do you actually have fun? (No automation can answer this.)

---

## 7. Appendix A — DOOM netcode primer

This section is for future-you when you sit down to write `net_pt.c` and have forgotten what `recvtic` means.

### Core concepts

- **TICRATE = 35 Hz**. Every game logic tic is 1/35 s. Frame rate is independent (originally 35 Hz on PCs that could keep up; modern engines decouple, like ours does with `dgpt_advance_clock`).
- **ticcmd_t** (12 bytes, see `d_ticcmd.h`): per-player per-tic input. Fields: `forwardmove` (i8), `sidemove` (i8), `angleturn` (i16), `chatchar` (u8), `buttons` (u8 — fire / use / weapon-select bits), `consistancy` (u8 — a checksum used to detect desync), plus Strife/Heretic/Hexen-specific fields (we ignore for DOOM).
- **gametic** (int): the tic the game is currently about to run, on this peer.
- **maketic** (int): the tic our local input is being built for, AHEAD of gametic (we always build ahead so transport latency is hidden).
- **recvtic** (int): the latest tic we've received complete data for, from the server/arbiter.
- **BACKUPTICS = 128**: ring-buffer depth of past ticcmd sets we keep around (for resend / late-arrival handling).
- **`ticdata[BACKUPTICS]`**: ring buffer of `ticcmd_set_t`, each holding `ticcmd_t cmds[NET_MAXPLAYERS]` + `boolean ingame[NET_MAXPLAYERS]`.
- **The game can never run a tic until ticcmds are received for it from ALL players** (`TryRunTics` blocks on `lowtic < gametic/ticdup + counts`). This is the LOCKSTEP guarantee — every peer runs the exact same tic with the exact same inputs.
- **`ticdup`**: input subsampling factor. ticdup=2 means we sample input every 2 tics and just duplicate. Halves bandwidth + halves input granularity. Vanilla DOOM auto-adjusted on slow LANs; we keep it at 1.
- **`extratics`**: number of past tics to re-send in each packet as insurance against drops. Vanilla default = 1.

### Original DOOM client/server flow (chocolate-doom shape)

```
Client                                          Server
  │                                                │
  │ ─── NET_PACKET_TYPE_SYN (with wad_sha1sum) ──► │
  │ ◄── NET_PACKET_TYPE_ACK ────────────────────── │
  │                                                │
  │   (server waits until ALL clients SYN+ACK)     │
  │ ◄── NET_PACKET_TYPE_LAUNCH ──────────────────  │
  │                                                │
  │ ─── NET_PACKET_TYPE_GAMESTART (settings) ────► │
  │ ◄── NET_PACKET_TYPE_GAMESTART (settings) ────  │
  │                                                │
  │   (lockstep begins)                            │
  │ ─── NET_PACKET_TYPE_GAMEDATA (ticcmd N) ─────► │
  │ ◄── NET_PACKET_TYPE_GAMEDATA (TicSet N) ─────  │
  │ ◄── NET_PACKET_TYPE_GAMEDATA (TicSet N+1) ───  │
  │ ─── NET_PACKET_TYPE_GAMEDATA (ticcmd N+1) ───► │
  │     ...                                        │
  │ ─── NET_PACKET_TYPE_GAMEDATA_RESEND (if drop)► │
```

### Packet types we MUST implement

From `net_defs.h`:

- `NET_PACKET_TYPE_SYN` / `ACK` / `REJECTED` — handshake
- `NET_PACKET_TYPE_KEEPALIVE` — heartbeat
- `NET_PACKET_TYPE_GAMESTART` — broadcast `net_gamesettings_t` to all clients
- `NET_PACKET_TYPE_GAMEDATA` — the per-tic carrier
- `NET_PACKET_TYPE_GAMEDATA_ACK` — flow control
- `NET_PACKET_TYPE_GAMEDATA_RESEND` — recovery for lost packets
- `NET_PACKET_TYPE_DISCONNECT` / `DISCONNECT_ACK` — clean leave

We can SKIP for v1:
- `NET_PACKET_TYPE_QUERY` / `QUERY_RESPONSE` — used by master server browser, we have our own discovery (Yjs awareness)
- `NET_PACKET_TYPE_WAITING_DATA` — lobby data, our DoomCard UI replaces this
- `NET_PACKET_TYPE_CONSOLE_MESSAGE` — chat, we have Yjs awareness for chat
- `NET_PACKET_TYPE_LAUNCH` — handshake step we replace with our New Game dialog

### Per-tic packet contents (`NET_PACKET_TYPE_GAMEDATA`)

Server → Client (per `net_server.c:NET_SV_TransmitTic`):
```
  [ack_tic]               u8     low byte of the tic we're ack'ing
  [num_tics]              u8     how many tics we're sending (= extratics + 1 typically)
  for tic in [recvtic..recvtic+num_tics):
    [player_present_mask] u8     bit i = player i was in game at this tic
    [latency]             i16    server-side queuing latency, for client sync
    for player in [0..MAXPLAYERS):
      if player_present_mask & (1<<player):
        [ticcmd_diff]     variable  delta against previous ticcmd, encoded via net_ticcmd_diff_t
```

Client → Server (per `net_client.c:NET_CL_SendTics`):
```
  [ack_tic]               u8     latest tic we've ack'd
  [start_tic]             u8     first tic in this packet
  [num_tics]              u8
  for tic in [start_tic..start_tic+num_tics):
    [ticcmd_diff]         variable
```

Ticcmd diff encoding (per `net_structrw.c`) is field-presence-bits-then-fields, using the `NET_TICDIFF_*` flags from `net_defs.h:193+`. Typical diff is 1-3 bytes vs 12 bytes raw. We get all of this FREE by vendoring `net_structrw.c` (slice 0).

### Arbiter (= server in DOOM parlance) responsibilities

1. Accept SYN, verify wad_sha1sum matches (reject otherwise).
2. Hold all clients in lobby until `num_players` reach a target OR player 0 hits "Launch".
3. Broadcast `NET_PACKET_TYPE_GAMESTART` with `net_gamesettings_t`.
4. Each tic: receive `ticcmd[i]` from player i; once all live players' tic-N ticcmds are in (or 100ms timeout), broadcast TicSet(N) to all.
5. Handle disconnects: flip `playeringame[i] = false`, no more waiting for that slot.

### What "drone" / "spectator" means in DOOM netcode

`connect_data->drone = true` connects a peer that doesn't get a player slot — it just receives all the game data + renders. Original use was for 3-screen Doom (left/center/right monitors); for us it's the spectator path for the 5th-peer and late-joiner cases. NO TICCMD IS BUILT for a drone; it just renders received game state.

This is the cleanest hook for our "5th peer = spectator" case (Q4 option b) — we don't need to invent anything, just set `drone=true` in `connect_data` for the over-cap peer.

---

## 8. Appendix B — what's in the vendored doomgeneric today

To save the future-you a `find` invocation:

- `d_loop.c` — vendored. Contains `TryRunTics`, `BuildNewTic`, `D_ReceiveTic`, etc. The netplay lockstep state machine is HERE; we just need to make the network layer feed it.
- `d_net.c` — vendored. Contains `D_ConnectNetGame`, `D_CheckNetGame`. High-level connect/start. Calls `D_InitNetGame` which is gated on `FEATURE_MULTIPLAYER`.
- `doomfeatures.h` — `FEATURE_MULTIPLAYER` is `#undef`'d. Build script does not define it.
- `net_*.h` — ALL headers vendored. Tells us the API shape we need to provide.
- `net_*.c` — **NONE vendored**. This is the gap slice 0 fills.

doomgeneric's design intent (per upstream README) is: "this fork only implements the minimum needed to draw a frame and read input"; multiplayer was explicitly excluded. We're un-excluding it.

---

## 9. Decision log

- **2026-05-24** — plan v1 drafted. Recommended: arbiter-collected lockstep over WebRTC+WS-relay, per-peer WASM, 4 instances max, lex-min arbiter election (same as today's `pickHost`). 13 open questions documented above for user review.
- **2026-05-24** — slice 4 shipped (New Game dialog + Launch). Notes for future slices:
  - **D_StartNetGame wiring**: the vendored `D_StartNetGame`'s compiled (`#else`, non-ORIGCODE) path hardcodes single-player, and the real ORIGCODE path BLOCKS in a spin loop (`BlockUntilStart` + `I_Sleep`) that can't run inside our cooperatively-scheduled WASM tick. So slice 4 added a new export `dgpt_start_netgame(deathmatch, episode, map, skill, nomonsters, fast, respawn, num_players, consoleplayer)` (in `doomgeneric_patchtogether.c`) that sets DOOM's start globals + `netgame`/`playeringame[]`, sets this peer's `consoleplayer`/`displayplayer` + the lockstep `localplayer` (via a tiny `DGPT_LoopSetLocalPlayer` setter in `d_loop.c`, since `localplayer` is static there), and calls `G_InitNew` to load the level. JS drives the start: the arbiter broadcasts the settings over the netcode (awareness `doom-net:<mid>:gamestart` field) → every joined peer's `onGameStart` calls `runtime.startNetGame(settings, mySlot)`. Deterministic level load on identical (skill, episode, map) + num_players gives every peer the same world with per-slot coop starts; each peer drives its OWN `players[consoleplayer]`. The cross-peer ticcmd exchange that makes peers see each OTHER's marines is slice-5 fidelity work; slice 4 establishes each peer as its own game instance in one configured netgame.
  - **Arbiter-authoritative slot assignment** (fixes the slice-3 clobber): a peer no longer writes the roster to join. It raises an awareness join-request flag (`doom:<id>:join-req` = its userId); the ARBITER (rack host = single writer) collects outstanding requests + assigns slots in one deterministic pass (`assignRequestedSlots` in `doom-roster.ts`, lex-sorted requesters → distinct slots, cap at 4). Since only the arbiter writes `node.data.players`, two simultaneous joins can't collide. Unit-tested in `doom-roster.test.ts` (concurrent → distinct, order-independent, cap-at-4, idempotent).
  - **gamestate lock**: the New Game dialog locks while `gamestate == GS_LEVEL` and re-opens at intermission/finale; the arbiter picks the next map (a new launch bumps `launchId`, re-firing `onGameStart` on all peers).
  - **single-player untouched**: a lone peer (no other members) never calls `dgpt_start_netgame` — `assignSlotsAsArbiter` early-returns when `memberIds.length <= 1`, so no auto-join, no dialog, the surface just ticks DOOM's normal loop. Verified: SP build boots to GS_DEMOSCREEN with the new exports inert.
  - **what's left**: slice 5 = per-POV polish + identity badges (player-slot color tint, cross-peer marine visibility via the lockstep ticcmd cross-feed); slice 6 = late-join / spectator + intermission rejoin; slice 7 = 4-context Playwright + trace-replay determinism test + docs. The slice-4 e2e (`doom-launch.spec.ts`) is the 2-context launch acceptance; the C-side `start-netgame.acceptance.mjs` harness proves both peers enter the level + move independently + end at distinct positions without needing a browser.
- **2026-05-24** — slice 7 shipped (capstone: 4-context e2e + BIT-EXACT lockstep determinism + docs). Notes:
  - **Bit-exact lockstep — already deterministic, no nondeterminism source needed fixing.** The slice-5 harness used a within-25% displacement compare ONLY because of its read-then-inject one-tic lag (each sim built its own local-slot ticcmd via `G_BuildTiccmd` from its own key queue, then JS read `maketic-1` and injected it into the other sim a tic late — so the producer's marine was sampled a tic apart in the two worlds). That was a harness artifact, NOT engine divergence. doomgeneric's gameplay math is fixed-point + the RNG is a shared LUT (`m_random.c` `rndtable[]`) advanced only by in-game events, which — given an identical TicSet — happen identically on every sim.
  - **How slice 7 proves it.** New SCRIPTED-LOCKSTEP mode in `d_loop.c` (`DGPT_LoopSetScripted`): when armed, `DGPT_OverlayRemoteCmds` drives EVERY slot — including the sim's own — from the injected stream, so all sims consume one identical consolidated TicSet (the real arbiter-broadcast shape: one authoritative `{cmd[0..n)}` per tic). The new harness `lockstep-determinism.acceptance.mjs` runs 2 and 4 independent in-process WASM sims on one shared scripted TicSet log + asserts a stable engine checksum (`dgpt_state_checksum`, FNV-1a over every player's mobj x/y/z/angle/momentum + health + `leveltime` + `rndindex`/`prndindex`) is BYTE-IDENTICAL every tic (not within-25%). A re-run of the same seed reproduces the per-tic checksum trace exactly (trace-replay reproducibility). The RNG indices are folded into the digest specifically so the classic lockstep desync (a sim calling `P_Random` a different number of times) would be caught — it stays equal.
  - **One thing the scripted overlay had to handle: DOOM's `consistancy` check.** G_Ticker's netgame desync guard (`g_game.c` ~949) compares `cmd->consistancy` against the engine-computed `consistancy[i][buf]` after `gametic > BACKUPTICS` and `I_Error`s (crashes) on mismatch. Synthetic scripted ticcmds carry no consistancy, so the overlay stamps each injected slot's `consistancy` from the locally-expected value via a new `G_ConsistancyForSlot(slot, buf)` helper — every scripted sim holds identical state so the value matches; the determinism is still verified INDEPENDENTLY by `dgpt_state_checksum`, so this is not cheating the check.
  - **New C exports (inert on SP/default path):** `dgpt_set_scripted`, `dgpt_state_checksum`. Scripted mode defaults OFF + the overlay is a no-op when `dgpt_netgame_players <= 1`; the default SP build still boots to GS_DEMOSCREEN and arming scripted mode there is inert (verified). The `dgpt_inject_remote_ticcmd` local-slot guard now only bails when NOT scripted.
  - **4-context e2e** (`doom-4context.spec.ts`): `@collab` test, FOUR browser contexts → 4 DOOM cards on one rack; A hosts + B/C/D arbiter-assigned to slots 1/2/3 (no clobber); identity badges P1..P4 + DOOM colors green/indigo/brown/red; A launches coop E1M1; all 4 enter the level + spawn their own console player; each drives its own marine + all 4 POVs change. Carries `test.skip(!!process.env.CI, '@collab 4-context — runs locally; CI relay flake per #97')` — 4 contexts is the worst case for the relay dropping peers under shard load; CI relies on the unit suites + C harnesses for the deterministic guarantees.
  - **Docs**: `packages/web/src/routes/docs/modules/doom-multiplayer/+page.svelte` (operator reference: start a game, join, late-join behavior, player colors sourced from `doom-player-identity`, controls from #280), linked from the `/docs` landing "What to read next".
  - **Local `task test` green before push** (server 4 files + web 155 files / 2576 tests). All three C harnesses pass against the real shareware WAD (`net_pt`, `start-netgame`, `lockstep-determinism`).
