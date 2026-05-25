<script lang="ts">
  // DoomCard — UI for the single-instance interactive DOOM video module.
  //
  // KEYBOARD ROUTING (the load-bearing special case):
  //
  // DOOM needs to consume ALL keypresses while its card is the focused/
  // selected SvelteFlow node — otherwise SF's arrow-key node-keyboard-move
  // intercepts arrow keys (and so do canvas pan/zoom shortcuts), so the
  // player can't move in-game and the card visibly slides across the
  // canvas instead. The fix is intentionally module-specific: a window-
  // level keydown/keyup listener at the CAPTURE phase that fires BEFORE
  // SvelteFlow's document-level handlers + before any bubble-phase
  // listeners on the canvas. When a DOOM card is focused/selected, we
  // preventDefault + stopPropagation BEFORE SF can see the event, then
  // route the key to the runtime (host) or relay it via awareness
  // (spectator).
  //
  // We deliberately DO NOT introduce a generalized "keyboard owner"
  // registry — DOOM is the only module today that needs full keyboard
  // capture (every other module is happy with the SF default of arrow-
  // keys-move-the-card). If/when a second module wants the same
  // treatment, refactor into a shared registry then; until then the
  // special case is clearer than the abstraction.
  //
  // Multiplayer (Yjs awareness): the user who spawned the module is the
  // "host" (lex-smallest current rack-member id on host departure;
  // see doom-presence.ts → pickHost). The host runs the WASM, broadcasts
  // a framebuffer envelope at ~10 Hz, and listens for non-self key
  // envelopes (relayed from spectators) → pushes them into the runtime's
  // key queue. Spectators don't load the WASM — they just decode + render
  // the host's framebuffer + relay their own keystrokes back.
  //
  // The runtime + framebuffer broadcast layer is intentionally a thin
  // wrapper around the doom-presence.ts encode/decode helpers — those
  // helpers are exhaustively unit-tested and the card just plumbs them.
  //
  // Sound: stereo audio outputs (audio_l / audio_r) are wired through the
  // new video → audio cross-domain bridge (PR-A) but stay silent in v1
  // because doomgeneric ships with i_sound's null impl. Slice 8 wires
  // real audio.

  import { onMount, onDestroy } from 'svelte';
  import { Handle, Position, type NodeProps } from '@xyflow/svelte';
  import { useEngine } from '$lib/audio/engine-context';
  import { useProvider } from '$lib/multiplayer/provider-context';
  import { patch, ydoc } from '$lib/graph/store';
  import type { VideoEngine } from '$lib/video/engine';
  import type { ModuleNode } from '$lib/graph/types';
  import { doomDef, type DoomHandleExtras } from '$lib/video/modules/doom';
  import { CV_GATE_PORT_IDS } from '$lib/doom/doomkeys';
  import { HeldKeyTracker } from '$lib/doom/held-keys';
  import {
    encodeKey,
    collectIncomingKeyPushes,
    encodeFrame,
    decodeFrame,
    decodeFrameBuffer,
    pickHost,
    type RelayCursor,
  } from '$lib/doom/doom-presence';
  import {
    serializeRoster,
    serializePending,
    slotForUser,
    isFull,
    rosterSize,
    readRosterState,
    combinedRoster,
    assignSlots,
    promotePending,
    pruneRosterState,
    type DoomRoster,
    type DoomRosterState,
  } from '$lib/doom/doom-roster';
  import {
    DoomNetcode,
    type DoomGameSettings,
    type DoomGameMode,
    type GameStartEnvelope,
    type TiccmdEnvelope,
  } from '$lib/doom/doom-netcode';
  import {
    slotColorCss,
    slotLabel,
    slotBadge,
    spectatorLabel,
    spectatorBadge,
    type DoomViewerStatus,
  } from '$lib/doom/doom-player-identity';

  let { id, data }: NodeProps = $props();
  let node = $derived(data?.node as ModuleNode);
  const engineCtx = useEngine();
  const providerCtx = useProvider();

  // ---- UI / lifecycle state ----
  let cardEl: HTMLDivElement | null = $state(null);
  let canvasEl: HTMLCanvasElement | null = $state(null);
  let loadStatus = $state<'idle' | 'loading' | 'ready' | 'error'>('idle');
  let loadError = $state<string | null>(null);
  let isHost = $state(true);          // true on first spawn; recomputed from awareness
  let memberIds = $state<string[]>([]); // including self
  // ---- Slice 3: per-peer instance model + roster ----
  //
  // ONE shared DOOM node lives on the canvas (the host spawned it; every
  // other peer sees it via Yjs node sync and does NOT spawn its own). The
  // node is shared state; the WASM is per-peer. A peer becomes a "player"
  // by claiming a slot in `node.data.players` (the roster) — at which point
  // it loads its OWN runtime + starts its OWN DoomNetcode bound to this one
  // node, giving that player their own POV. Unjoined peers are spectators.
  //
  // Single-player is the lone-peer case: memberIds.length <= 1 means no
  // netcode is ever started; the host runs the WASM exactly as before.
  // Slice 6: the roster is split into ACTIVE (live players this game) and
  // PENDING (late joiners who reserved a slot mid-level + will spawn at the
  // NEXT map). `roster` here is the ACTIVE map (drives numPlayers + the live
  // marines, same as slices 3-5); `pending` is the reservation map.
  let roster = $state<DoomRoster>({});       // node.data.players (active)
  let pending = $state<DoomRoster>({});      // node.data.pending (late joiners)
  let mySlot = $state<number | null>(null);  // this peer's ACTIVE slot, or null
  let myPendingSlot = $state<number | null>(null); // reserved-but-not-live slot
  let netStarted = $state(false);           // our DoomNetcode is running
  let isNetArbiter = $state(false);         // lex-min player == arbiter
  let netcode: DoomNetcode | null = null;
  // ---- Slice 4: New Game dialog + Launch state ----
  //
  // The arbiter (rack host = lex-min member = player 0) picks mode/skill/
  // episode/map + hits Launch. Launch broadcasts the settings via the
  // netcode; every joined peer's onGameStart fires + calls
  // extras.startNetGame(settings, mySlot). Non-arbiter peers see "waiting
  // for host to start…". After Launch, the dialog is locked until the level
  // ends (gamestate == GS_INTERMISSION), where the arbiter can pick the next
  // map.
  let mode = $state<DoomGameMode>('coop');
  let skill = $state(1);     // 0..4 (ITYTD..Nightmare); default skill 2 = idx 1
  let episode = $state(1);   // 1..3 (shareware = episode 1 only)
  let mapNum = $state(1);    // 1..9
  let launched = $state(false);           // a netgame has been launched
  let gamestate = $state<number>(-1);     // polled DOOM gamestate_t (GS_LEVEL=0)
  // ---- Explicit multiplayer-session mode (the operator's "Host Multiplayer"
  //      vs "Single Player" choice) ----
  //
  // The session mode is a HOST decision, stored on the shared node
  // (node.data.mpMode) so every peer agrees on whether a multiplayer game is
  // being run. It replaces the fragile implicit "a 2nd member appeared, so
  // auto-seat the host + show the dialog" detection that left both cards in
  // single-player limbo when presence raced (the "single-user rack" +
  // demo-plays-itself cascade). Values:
  //   undefined → no choice yet (host sees Single Player / Host Multiplayer).
  //   'single'  → single-player: host runs its own WASM, no roster / netcode.
  //   'multi'   → multiplayer lobby open: host seated as player 0, guests get
  //               a Join affordance, an explicit Launch starts the netgame.
  // Mirrored into $state (NOT $derived) and refreshed from the shared node in
  // syncRosterState() — same pattern as `roster`/`pending`, because a node-
  // data edit arrives via the Yjs nodes observer, not Svelte's reactive proxy.
  let mpMode = $state<'single' | 'multi' | undefined>(undefined);
  function readNodeMpMode(): 'single' | 'multi' | undefined {
    const target = patch.nodes[id];
    const m = (target?.data as { mpMode?: unknown } | undefined)?.mpMode;
    return m === 'single' || m === 'multi' ? m : undefined;
  }
  /** Host-only: persist the session mode on the shared node so guests see the
   *  lobby (or single-player) state. Non-LOCAL_ORIGIN session state (not a
   *  Cmd-Z-able edit), same rationale as the roster leaves. */
  function writeNodeMpMode(next: 'single' | 'multi'): void {
    ydoc.transact(() => {
      const target = patch.nodes[id];
      if (!target) return;
      if (!target.data) target.data = {};
      (target.data as Record<string, unknown>).mpMode = next;
    });
  }
  /** Host action: open the multiplayer lobby. Seats the host as player 0 +
   *  starts everyone's roster/netcode path; guests then see Join. */
  async function hostMultiplayer(): Promise<void> {
    if (!isHost) return;
    mpMode = 'multi'; // set locally first so the synchronous assignSlots pass sees it
    writeNodeMpMode('multi');
    await joinGame(); // host auto-seats at slot 0 (owner-first assignment)
  }
  /** Host action: play single-player (no netcode, no roster). */
  async function playSinglePlayer(): Promise<void> {
    if (!isHost) return;
    mpMode = 'single';
    writeNodeMpMode('single');
    if (loadStatus !== 'ready') await tryLoad();
  }
  // DOOM gamestate_t ordinals (doomdef.h): the level is "in progress" while
  // GS_LEVEL is the live state; GS_INTERMISSION is the between-maps tally
  // screen where the arbiter picks + launches the next map (seating pending
  // late joiners). See dgpt_get_gamestate.
  const GS_LEVEL = 0;
  const GS_INTERMISSION = 1;
  // The labels mirror DOOM's difficulty names; index = skill_t value.
  const SKILL_LABELS = ["I'm Too Young To Die", 'Hey, Not Too Rough', 'Hurt Me Plenty', 'Ultra-Violence', 'Nightmare!'];
  const MODE_OPTIONS: DoomGameMode[] = ['coop', 'deathmatch', 'deathmatch-2.0', 'survival'];

  /** The arbiter for SESSION lifecycle (New Game / Launch / slot assignment)
   *  is the rack host — the single writer. (The netcode arbiter, isNetArbiter,
   *  is the lex-min JOINED PLAYER; host is the lex-min MEMBER. They coincide
   *  because the host always auto-joins as player 0, but isHost is the
   *  authoritative single-writer signal for roster + launch.) */
  function isSessionArbiter(): boolean { return isHost; }

  /** True while a level is actively running (so a join goes to PENDING + the
   *  New Game dialog is locked). Drives the late-join routing + dialog lock. */
  function isGameInProgress(): boolean {
    return launched && gamestate === GS_LEVEL;
  }

  /** Build the net_gamesettings_t-equivalent from the dialog selections.
   *  numPlayers is the ACTIVE roster size (pending late joiners are NOT live
   *  yet) — but at a next-map launch the arbiter has already promoted pending
   *  → active (see launchGame), so this counts the newly-seated players too. */
  function buildSettings(): DoomGameSettings {
    // survival = coop + respawning monsters (no distinct DOOM global).
    const deathmatch = mode === 'deathmatch' ? 1 : mode === 'deathmatch-2.0' ? 2 : 0;
    const respawnMonsters = mode === 'survival' ? 1 : 0;
    return {
      deathmatch,
      episode,
      map: mapNum,
      skill,
      nomonsters: 0,
      fastMonsters: 0,
      respawnMonsters,
      numPlayers: Math.max(1, rosterSize(roster)),
    };
  }

  /** Launch (arbiter only): SEAT any pending late joiners (promote pending →
   *  active so they spawn into THIS map), then broadcast the chosen settings
   *  to all joined peers. Each peer (incl. the arbiter + the just-promoted
   *  late joiners) starts its own WASM netgame via the onGameStart callback.
   *
   *  This is the intermission re-seating path: at the end of a level the
   *  arbiter's New Game dialog re-opens (gamestate left GS_LEVEL); when it hits
   *  Launch for the next map, promotePending makes every reserved late joiner a
   *  live player at the same slot it reserved, and the new launch broadcast
   *  carries the larger numPlayers so every peer loads the next map with all of
   *  them spawned. */
  function launchGame(): void {
    if (!isSessionArbiter()) return;
    if (mySlot === null) return;          // arbiter must be a player
    seatPendingAsArbiter();               // promote late joiners into this map
    const settings = buildSettings();     // numPlayers now includes them
    if (netcode) {
      // Multiplayer: broadcast → every joined peer (incl. arbiter) starts.
      netcode.broadcastGameStart(settings);
    } else {
      // Lone peer (single-player, no netcode): start directly.
      applyGameStart({ launchId: 1, settings });
    }
  }

  /** Arbiter-only: promote every pending late joiner to an active slot (next-
   *  map seating) + write the updated rosters to the shared node so all peers
   *  converge before the launch broadcast lands. Single-writer (host) so no
   *  clobber. No-op when nothing is pending. */
  function seatPendingAsArbiter(): void {
    if (!isSessionArbiter()) return;
    const state = readNodeRosterState();
    const { state: next, changed } = promotePending(state);
    if (changed) {
      writeNodeRosterState(next);
      roster = next.active;
      pending = next.pending;
    }
  }

  /** Apply a launch on THIS peer: start the WASM netgame at our own slot.
   *
   *  Slice 6: at a next-map launch the arbiter PROMOTES pending → active +
   *  writes the roster, THEN broadcasts the launch. The two updates arrive on
   *  different channels (node-sync vs awareness) and can race, so we re-read
   *  the LIVE active slot off the node here (not just the reactive mirror) to
   *  catch a just-promoted late joiner whose syncRosterState may not have run
   *  yet. A peer still pending (no active slot) keeps spectating — it does NOT
   *  start a game until a launch carries it as active. */
  function applyGameStart(env: GameStartEnvelope): void {
    const me = resolveLocalUserId();
    const slot = slotForUser(readNodeRoster(), me);
    if (slot !== null) mySlot = slot;     // adopt the promoted slot immediately
    if (slot === null) return;            // spectators / still-pending: no game
    const extras = getExtras();
    if (!extras) return;
    extras.startNetGame(env.settings, slot);
    launched = true;
    // Mirror the chosen settings into the dialog so the arbiter's controls
    // reflect what's running (and the next-map pick starts from here).
    mapNum = env.settings.map;
    episode = env.settings.episode;
    skill = env.settings.skill;
  }
  /** Slice 5: inject a remote peer's ticcmd into our runtime so its marine
   *  moves in our world. Ignores our own slot (the netcode already filters
   *  self, but guard defensively) + spectators (no runtime). */
  function applyRemoteTiccmd(env: TiccmdEnvelope): void {
    if (mySlot !== null && env.slot === mySlot) return;
    const extras = getExtras();
    if (!extras) return;
    extras.injectRemoteTiccmd(env.slot, {
      forwardmove: env.forwardmove,
      sidemove: env.sidemove,
      angleturn: env.angleturn,
      buttons: env.buttons,
    });
  }

  /** Slice 5: broadcast THIS peer's freshly-built local ticcmd over the
   *  netcode each tic so the other joined peers move our marine in their
   *  worlds. Only meaningful for a joined player running a launched netgame
   *  with active peers. */
  function broadcastLocalTiccmd(): void {
    if (!netcode) return;
    if (mySlot === null) return;
    if (!launched) return;
    const extras = getExtras();
    if (!extras) return;
    const cmd = extras.readLocalTiccmd();
    if (!cmd) return;
    netcode.broadcastLocalTiccmd(mySlot, cmd);
  }

  /** Last remote framebuffer received via awareness — spectator path. The
   *  card-side rAF tick prefers this over `extras.snapshotFramebuffer()`
   *  (which is null on spectator pages because they never load WASM). */
  let lastRemoteFrame: Uint8Array | null = null;
  /** Local user id used for host election. Resolved lazily from the
   *  provider's awareness `user.id` field (set by /r/[id]'s presence
   *  init OR by tests calling __setAwarenessUser). Falls back to a
   *  stable random per-tab id when no provider is attached. */
  const randomLocalId = `local-${Math.random().toString(36).slice(2, 10)}`;
  function resolveLocalUserId(): string {
    const provider = providerCtx.get();
    const aw = provider?.awareness;
    if (!aw) return randomLocalId;
    const state = aw.getLocalState() as { user?: { id?: string } } | null;
    const uid = state?.user?.id;
    return typeof uid === 'string' && uid.length > 0 ? uid : randomLocalId;
  }

  /** The set of rack-member user ids that OWN the rackspace, read from the
   *  awareness `user.isRackOwner` flag (published by r/[id]'s presence init).
   *  Used to make the rack owner the DOOM host + player 0 regardless of where
   *  its id sorts (the lex-min election otherwise let a guest hijack host /
   *  P1). Usually 0 or 1 entry; anon racks have none, so the election cleanly
   *  falls back to lex-min there. */
  function resolveOwnerIds(): string[] {
    const provider = providerCtx.get();
    const aw = provider?.awareness;
    if (!aw) return [];
    const out: string[] = [];
    for (const [, state] of aw.getStates()) {
      const u = (state as { user?: { id?: string; isRackOwner?: boolean } }).user;
      if (u?.isRackOwner === true && typeof u.id === 'string' && u.id.length > 0) {
        out.push(u.id);
      }
    }
    return out;
  }

  /** Resolve a rack user's display name from awareness presence (the `user`
   *  field set by multiplayer/presence.ts carries id + displayName). Returns
   *  null when no presence entry / no provider — the identity label then
   *  shows just "Player N". Mirrored into `myUsername` reactively so the
   *  header re-renders when presence arrives. */
  function resolveUsername(userId: string | null): string | null {
    if (!userId) return null;
    const provider = providerCtx.get();
    const aw = provider?.awareness;
    if (!aw) return null;
    for (const [, state] of aw.getStates()) {
      const u = (state as { user?: { id?: string; displayName?: string } }).user;
      if (u?.id === userId && typeof u.displayName === 'string') return u.displayName;
    }
    return null;
  }

  // Slice 5: this peer's identity (color tint + label). Recomputed on
  // awareness churn (syncIdentity) so the username + slot color stay current.
  let myUsername = $state<string | null>(null);
  // Slice 6: the viewer's multiplayer status drives the spectator/pending
  //   affordance. 'player' = active slot now; 'pending' = reserved a slot
  //   mid-level, spectating until the next map; 'spectator' = no slot at all.
  let viewerStatus = $derived<DoomViewerStatus>(
    mySlot !== null ? 'player' : myPendingSlot !== null ? 'pending' : 'spectator',
  );
  // The card header / stripe / badge tint by the local player's slot color.
  // An active player tints by its live slot; a pending late joiner tints by
  // the slot it WILL take (so its identity is already visible); a pure
  // spectator keeps the default video-cable red.
  let slotTint = $derived<string>(
    mySlot !== null
      ? slotColorCss(mySlot)
      : myPendingSlot !== null
        ? slotColorCss(myPendingSlot)
        : 'var(--cable-video, #c33)',
  );
  let identityLabel = $derived<string>(slotLabel(mySlot, myUsername, true));
  let badgeText = $derived<string>(slotBadge(mySlot));
  // Spectator/pending label + badge (empty for an active player).
  let specLabel = $derived<string>(spectatorLabel(viewerStatus, myPendingSlot));
  let specBadge = $derived<string>(spectatorBadge(viewerStatus, myPendingSlot));
  // Slice 6: a peer that has no ACTIVE slot is spectating — it renders the
  // host's framebuffer mirror rather than its own WASM. This covers BOTH the
  // pure spectator (no slot, no loaded WASM) AND the pending late joiner (WASM
  // loaded but its launched netgame hasn't started yet, so its own
  // snapshotFramebuffer would show an idle demo screen — we must show the
  // running game instead). Only an active, launched player renders its own POV.
  let isSpectating = $derived<boolean>(mySlot === null && memberIds.length > 1);

  // Push the spectator/player status down to the video module so it knows
  // whether to render the host mirror (spectator) or tick + render its OWN
  // real-time sim (active player). Critically, this runs on EVERY transition:
  // a peer that spectated (received host frames) and then JOINED must flip
  // back to its own sim — otherwise the module stays pinned to the slow
  // ~10 Hz host mirror (the "player 2 only sees player 1's view, staggeringly
  // slow" bug). $effect re-runs whenever isSpectating changes.
  $effect(() => {
    const spectating = isSpectating;
    const extras = getExtras();
    extras?.setSpectating(spectating);
  });

  function syncIdentity(): void {
    myUsername = resolveUsername(resolveLocalUserId());
  }

  // ---- Extras helper ----
  function getExtras(): DoomHandleExtras | null {
    const e = engineCtx.get();
    if (!e) return null;
    try {
      const videoEngine = e.getDomain<VideoEngine>('video');
      const extras = videoEngine.read(id, 'extras') as DoomHandleExtras | undefined;
      return extras ?? null;
    } catch {
      return null;
    }
  }

  // ---- WASM + WAD load on user-initiated click (avoids autoplay races) ----
  async function tryLoad(): Promise<void> {
    const extras = getExtras();
    if (!extras) return;
    loadStatus = 'loading';
    const err = await extras.ensureLoaded();
    if (err) {
      loadStatus = 'error';
      loadError = err;
    } else {
      loadStatus = 'ready';
      loadError = null;
    }
  }

  // ---- Slice 3: roster + per-peer netcode wiring ----
  //
  // Read the live roster off the shared node. `node.data.players` is the
  // only multiplayer state on the node; it rides the existing Yjs node
  // sync, so every peer converges on the same map.
  function readNodeRoster(): DoomRoster {
    const target = patch.nodes[id];
    return readRosterState(target?.data).active;
  }

  /** Slice 6: read BOTH the active + pending rosters off the shared node. */
  function readNodeRosterState(): DoomRosterState {
    const target = patch.nodes[id];
    return readRosterState(target?.data);
  }

  // Write the roster to the shared node as a primitive JSON-STRING leaf at
  // node.data.players. A string leaf is the pattern that syncs reliably
  // cross-context (cf. multiplayer/module-naming.ts `node.data.name = name`);
  // a freshly-added nested Y.Map does NOT always reach an already-synced
  // remote peer (CI 2-context repro: peer B never saw A's nested-object
  // claim, but sees a string leaf). readRoster() decodes the string.
  // Deliberately NOT LOCAL_ORIGIN — roster join/leave is session state, not a
  // user edit, so Cmd-Z must never un-join a player. node.data is created
  // lazily — most nodes carry none.
  function writeNodeRoster(next: DoomRoster): void {
    const encoded = serializeRoster(next);
    ydoc.transact(() => {
      const target = patch.nodes[id];
      if (!target) return;
      if (!target.data) target.data = {};
      (target.data as Record<string, unknown>).players = encoded;
    });
  }

  /** Slice 6: write BOTH the active (`players`) + pending (`pending`) leaves
   *  in one transaction. Same primitive-JSON-string-leaf rationale + non-
   *  LOCAL_ORIGIN (session state, not a Cmd-Z-able edit) as writeNodeRoster.
   *  Only the arbiter (single writer) ever calls this. */
  function writeNodeRosterState(next: DoomRosterState): void {
    const players = serializeRoster(next.active);
    const pend = serializePending(next.pending);
    ydoc.transact(() => {
      const target = patch.nodes[id];
      if (!target) return;
      if (!target.data) target.data = {};
      (target.data as Record<string, unknown>).players = players;
      (target.data as Record<string, unknown>).pending = pend;
    });
  }

  // ---- Slice 4: arbiter-authoritative slot assignment ----
  //
  // The slice-3 join was last-write-wins on a JSON string leaf: two peers
  // joining at once both read {} → both compute slot 0 → the second write
  // clobbers the first with no Yjs conflict. The fix makes the roster
  // SINGLE-WRITER: a peer wanting to play sets an awareness "join-request"
  // field (its own userId); only the ARBITER (rack host) writes the roster,
  // assigning slots from the batch of outstanding requests in one pass
  // (assignRequestedSlots). Concurrent requests therefore get DISTINCT slots
  // — the arbiter sees both and never clobbers.
  function joinReqField(): string { return `doom:${id}:join-req`; }

  // Join: a peer REQUESTS to play by raising its join-request flag, then
  // brings up its own runtime (a player always runs its own WASM for its
  // POV). The arbiter assigns the actual slot; this peer reads it back from
  // the synced roster (syncRosterState). Idempotent. The arbiter joining
  // itself short-circuits straight to the assignment pass (it IS the writer).
  async function joinGame(): Promise<void> {
    const me = resolveLocalUserId();
    // The HOST clicking Join (or hostMultiplayer) IS the decision to run a
    // multiplayer session — open the lobby so the assignment pass proceeds +
    // guests see Join. (hostMultiplayer also sets this; doing it here too keeps
    // a bare join() self-sufficient — the existing doom e2e specs call join()
    // directly without a separate host-MP step.)
    if (isHost && mpMode !== 'multi') {
      mpMode = 'multi';
      writeNodeMpMode('multi');
    }
    // Already seated (active OR pending)? Just ensure our local instance is up.
    // A pending late joiner still loads its WASM now so it can spawn the moment
    // it's promoted at the next map, but it does NOT drive a marine yet (its
    // active slot stays null until promotion — applyGameStart no-ops for it).
    const combined = combinedRoster(readNodeRosterState());
    if (slotForUser(combined, me) !== null) {
      if (loadStatus !== 'ready') await tryLoad();
      startNetcodeIfNeeded();
      return;
    }
    if (isFull(combined)) return; // game full (active + pending) — no-op
    // Raise the request flag so the arbiter assigns us a slot.
    const provider = providerCtx.get();
    provider?.awareness?.setLocalStateField(joinReqField(), me);
    // Start loading our WASM now (the assignment + sync round-trip lags;
    // having the runtime ready means netcode can start the moment our slot
    // arrives).
    if (loadStatus !== 'ready') await tryLoad();
    // If we ARE the arbiter, run the assignment pass immediately (single
    // writer = no round-trip needed for our own slot).
    if (isSessionArbiter()) assignSlotsAsArbiter();
    startNetcodeIfNeeded();
  }

  /** Arbiter-only: collect outstanding join-requests from awareness + the
   *  arbiter's own auto-join, assign slots authoritatively, and write the
   *  roster (single writer). Runs on every awareness update so requests
   *  that arrive after the arbiter's first pass still get served. */
  function assignSlotsAsArbiter(): void {
    if (!isSessionArbiter()) return;
    const cur = readNodeRosterState();
    // Multiplayer must be EXPLICITLY started by the host (mpMode === 'multi').
    // Until then the roster stays empty — a lone host (or a host that hasn't
    // picked yet) just plays single-player via the no-netcode path, and a 2nd
    // member arriving does NOT auto-seat anyone. This replaces the fragile
    // implicit "2nd member ⇒ auto-join" detection that left both cards stuck
    // in single-player limbo when presence raced. Idempotent: once seated, the
    // roster persists even if mpMode were toggled.
    if (mpMode !== 'multi' && rosterSize(combinedRoster(cur)) === 0) return;
    const provider = providerCtx.get();
    const aw = provider?.awareness;
    const me = resolveLocalUserId();

    // Gather requesters: every member with a raised join-request flag, plus
    // the arbiter itself (the host is always player 0 in a multiplayer
    // session — it is seated when the host opens the lobby via Host
    // Multiplayer; owner-first slot assignment puts it at slot 0).
    const requesters = new Set<string>([me]);
    if (aw) {
      for (const [, state] of aw.getStates()) {
        const s = state as Record<string, unknown> | undefined;
        const req = s?.[joinReqField()];
        if (typeof req === 'string' && req.length > 0) requesters.add(req);
      }
    }
    // Only honour requests from live members (a stale flag from a departed
    // peer must not consume a slot).
    const live = new Set(memberIds);
    const filtered = [...requesters].filter((uid) => live.has(uid) || uid === me);

    // Slice 6: while a level is running, a NEW requester is seated as PENDING
    // (it spectates + spawns at the next map); before a game starts (or while
    // the dialog is open at intermission) it goes straight to ACTIVE. Only the
    // arbiter computes isGameInProgress, and it is the single writer, so the
    // pending/active split is authoritative.
    const { state: next, changed } = assignSlots(
      cur,
      filtered,
      isGameInProgress(),
      resolveOwnerIds(),
    );
    if (changed) {
      writeNodeRosterState(next);
      roster = next.active;
      pending = next.pending;
    }
  }

  // Bring up this peer's DoomNetcode once it is (a) a joined player and
  // (b) there is more than one member in the rack. A lone player needs no
  // netcode — that is the single-player path, untouched. Idempotent.
  function startNetcodeIfNeeded(): void {
    if (netStarted) return;
    // Active players run netcode (play); pending late joiners run it too so
    // they receive the arbiter's next-map GAMESTART broadcast + are ready to
    // spawn the instant they're promoted. Pure spectators (no slot at all)
    // never run netcode — they consume the host's framebuffer mirror.
    if (mySlot === null && myPendingSlot === null) return;
    if (memberIds.length <= 1) return;       // single-player — no transport
    const provider = providerCtx.get();
    if (!provider) return;
    const extras = getExtras();
    const runtime = extras?.getRuntime();
    if (!runtime) return;                    // wait until our WASM is loaded
    netcode = new DoomNetcode({
      provider,
      moduleId: id,
      localUserId: resolveLocalUserId(),
      runtime,
      onArbiter: (isArb) => { isNetArbiter = isArb; },
      // Slice 4: the arbiter's Launch broadcast lands here on EVERY joined
      // peer (arbiter included) → start our WASM netgame at our own slot.
      onGameStart: (env) => { applyGameStart(env); },
      // Slice 5: a remote peer's latest ticcmd → inject it into our sim so
      // that peer's marine moves in OUR world (cross-peer visibility).
      onRemoteTiccmd: (env: TiccmdEnvelope) => { applyRemoteTiccmd(env); },
    });
    netcode.start();
    netStarted = true;
    isNetArbiter = netcode.isArbiter();
  }

  function stopNetcode(): void {
    if (netcode) {
      try { netcode.stop(); } catch { /* provider may be gone */ }
      netcode = null;
    }
    netStarted = false;
    isNetArbiter = false;
  }

  // Arbiter-side roster cleanup: when a player closes their tab they drop
  // out of awareness; the surviving arbiter (lex-min current player, or the
  // host if no players yet) prunes their stale roster entry so the slot is
  // freed for the next joiner. Pure pruneRoster() + a single Yjs write when
  // something actually changed (avoids an awareness/sync feedback loop).
  function reconcileRosterAsArbiter(): void {
    // Only the rack host drives pruning (single writer = no write storms).
    if (!isHost) return;
    const cur = readNodeRosterState();
    const { state: next, changed } = pruneRosterState(cur, memberIds);
    if (changed) {
      writeNodeRosterState(next);
      roster = next.active;
      pending = next.pending;
    }
  }

  // Keep local roster mirror + mySlot in sync with the shared node, and
  // tear down / spin up our netcode as our player status changes.
  function syncRosterState(): void {
    const cur = readNodeRosterState();
    roster = cur.active;
    pending = cur.pending;
    // Refresh the host-chosen session mode (single / multi) from the node so
    // guests' lobby UI tracks the host's explicit choice.
    mpMode = readNodeMpMode();
    const me = resolveLocalUserId();
    mySlot = slotForUser(cur.active, me);
    myPendingSlot = slotForUser(cur.pending, me);
    if (mySlot === null && myPendingSlot === null) {
      // We left / were pruned / are a pure spectator: drop netcode.
      stopNetcode();
    } else {
      // We're a player (active) OR a pending late joiner. Ensure our own WASM
      // is loading (a returning/late player whose slot is already in the
      // synced roster never clicked Join), then bring up netcode once the
      // runtime exists. A pending peer runs netcode to catch the next-map
      // launch but does NOT drive a marine until promoted (mySlot stays null).
      if (loadStatus === 'idle') void tryLoad();
      startNetcodeIfNeeded();
    }
  }

  // Keyboard input — see file header for the full story.
  //
  // Two-step routing decision:
  //   1. shouldClaimKey() — is the card the focused/selected SF node?
  //      (focus alone is not enough — SF's keyboard-move handler fires on
  //      any node that's `.selected` regardless of focus, so we have to
  //      claim the key whenever EITHER condition holds).
  //   2. routeKey() — push to runtime (host) or relay over awareness
  //      (spectator).
  function shouldClaimKey(): boolean {
    if (!cardEl) return false;
    // a) Focus-within: any descendant (incl. the card itself) is
    //    document.activeElement.
    if (cardEl.contains(document.activeElement)) return true;
    // b) SvelteFlow marks the selected node wrapper with .selected. The
    //    card mounts INSIDE that wrapper, so we walk up + check.
    const sfNode = cardEl.closest('.svelte-flow__node');
    if (sfNode?.classList.contains('selected')) return true;
    return false;
  }

  function routeKey(code: string, pressed: boolean): boolean {
    const extras = getExtras();
    if (!extras) return false;
    if (isHost) {
      return extras.pushKeyboardKey(code, pressed);
    }
    relayKeyToHost(code, pressed);
    return true;
  }

  // Tracks keys held on THIS card so we can release them when the card
  // stops owning the keyboard — see held-keys.ts. Without this, holding a
  // movement key and then deselecting the card (the keyup is dropped by
  // the claim gate) or alt-tabbing (no keyup fires at all) leaves the key
  // stuck down in the WASM input queue.
  const heldKeys = new HeldKeyTracker(routeKey);

  // Window-level capture-phase listener. Capture phase runs BEFORE bubble
  // (and before any document-level bubble listener xyflow installs for
  // arrow-key node-move + delete-on-Backspace). preventDefault +
  // stopPropagation here is what keeps the arrow keys from reaching SF's
  // node-move handler and the canvas's pan/zoom shortcuts.
  function onWindowKeyDownCapture(ev: KeyboardEvent): void {
    if (!shouldClaimKey()) return;
    // Don't claim modifier-bearing system shortcuts (cmd-R, ctrl-F, etc.) —
    // the user might want to reload or open devtools while DOOM is focused.
    // The exception is the bare ControlLeft / ControlRight (DOOM's "run"
    // modifier) which carries no other key.
    if ((ev.metaKey || ev.ctrlKey || ev.altKey) && !isModifierOnlyKey(ev.code)) {
      return;
    }
    ev.preventDefault();
    ev.stopPropagation();
    heldKeys.down(ev.code, ev.repeat);
  }
  function onWindowKeyUpCapture(ev: KeyboardEvent): void {
    // Route the release if we currently CLAIM the keyboard OR we were
    // holding this key — the latter covers a keyup that lands after the
    // card was deselected (clicked another node), which the claim gate
    // would otherwise drop, leaving the key stuck down.
    if (!shouldClaimKey() && !heldKeys.has(ev.code)) return;
    if (
      (ev.metaKey || ev.ctrlKey || ev.altKey) &&
      !isModifierOnlyKey(ev.code) &&
      !heldKeys.has(ev.code)
    ) {
      return;
    }
    ev.preventDefault();
    ev.stopPropagation();
    heldKeys.up(ev.code);
  }
  function isModifierOnlyKey(code: string): boolean {
    return (
      code === 'ControlLeft' ||
      code === 'ControlRight' ||
      code === 'AltLeft' ||
      code === 'AltRight' ||
      code === 'ShiftLeft' ||
      code === 'ShiftRight' ||
      code === 'MetaLeft' ||
      code === 'MetaRight'
    );
  }

  function releaseHeldKeys(): void {
    heldKeys.releaseAll();
  }
  function onVisibilityChange(): void {
    if (document.hidden) releaseHeldKeys();
  }

  function relayKeyToHost(code: string, pressed: boolean): void {
    // Spectator → host relay: we look the doomkey up locally and
    // broadcast a KeyEnvelope. The host filters on srcUserId !== self.
    const provider = providerCtx.get();
    if (!provider) return;
    const me = resolveLocalUserId();
    // Reuse the runtime's translation table without instantiating the
    // runtime on the spectator side: we import the keyboard map and
    // map the code to a doomkey directly.
    import('$lib/doom/doomkeys').then((mod) => {
      const dk = mod.KEY_FOR_KEYBOARD_CODE[code];
      if (dk === undefined) return;
      const env = encodeKey({
        kind: 'key',
        moduleId: id,
        srcUserId: me,
        doomKey: dk,
        pressed,
        ts: Date.now(),
      });
      provider.awareness?.setLocalStateField(`doom:${id}:key`, env);
      // Clear immediately so the same key+pressed combination next time
      // re-triggers (awareness is sticky — repeated identical values are
      // deduped). Microtask so a fast follow-up key on the same field
      // doesn't get lost between set + clear.
      queueMicrotask(() => {
        provider.awareness?.setLocalStateField(`doom:${id}:key`, null);
      });
    });
  }

  // ---- Awareness wiring ----
  let frameBroadcastInterval: ReturnType<typeof setInterval> | null = null;
  let awarenessOff: (() => void) | null = null;
  // Edge-trigger cursor for the host-side key relay: last key-envelope ts
  // relayed per source clientID. Without this, the host re-pushes a remote
  // client's still-present key field on every awareness update (incl. its
  // own 10 Hz frame broadcast) — a held/stale DOWNARROW then reads as the
  // player being shoved backward continuously with no key pressed. See
  // doom-presence.ts → collectIncomingKeyPushes.
  const keyRelayCursor: RelayCursor = new Map();
  /** Last frame envelope ts we decoded — guards against re-decoding the
   *  same payload on every rAF tick (the base64 → bytes hop is ~5 ms). */
  let lastDecodedFrameTs = 0;

  function pollLatestRemoteFrame(): void {
    const provider = providerCtx.get();
    const aw = provider?.awareness;
    if (!aw) return;
    let newest: { ts: number; raw: unknown } | null = null;
    aw.getStates().forEach((s) => {
      const raw = (s as Record<string, unknown>)[`doom:${id}:frame`];
      const ts = (raw as { ts?: number } | null)?.ts;
      if (typeof ts !== 'number') return;
      if (!newest || ts > newest.ts) newest = { ts, raw };
    });
    if (!newest) return;
    const newestTs = (newest as { ts: number }).ts;
    if (newestTs <= lastDecodedFrameTs) return;
    const env = decodeFrame((newest as { raw: unknown }).raw);
    if (!env || env.moduleId !== id) return;
    lastRemoteFrame = decodeFrameBuffer(env);
    lastDecodedFrameTs = newestTs;
  }

  function attachAwareness(): void {
    const provider = providerCtx.get();
    if (!provider) return;
    const aw = provider.awareness;
    if (!aw) return;

    function recomputeHost(): void {
      const me = resolveLocalUserId();
      const states = aw!.getStates();
      const ids: string[] = [];
      states.forEach((s) => {
        // We mirror our own user id under 'user.id'; this matches
        // multiplayer/presence.ts's setLocalStateField('user', user) call.
        const uid = (s as { user?: { id?: string } }).user?.id;
        if (typeof uid === 'string') ids.push(uid);
      });
      // Self may not have an entry yet — include defensively.
      if (!ids.includes(me)) ids.push(me);
      memberIds = ids;
      const myField = `doom:${id}:host`;
      // Read all clients' "I am host for module X" claims; tiebreak via
      // pickHost (lex-smallest).
      const candidates: string[] = [];
      states.forEach((s) => {
        const host = (s as Record<string, unknown>)[myField];
        if (typeof host === 'string') candidates.push(host);
      });
      const currentHost = candidates.length > 0 ? candidates.sort()[0]! : null;
      // The rack owner (if present) is always the host; otherwise lex-min.
      const newHost = pickHost(currentHost, ids, resolveOwnerIds());
      isHost = newHost === me;
      // Only write our claim if it actually changed — otherwise every
      // recomputeHost would emit an awareness update which re-fires
      // 'update' which re-enters recomputeHost (infinite loop seen in
      // playwright trace).
      const localState = aw!.getLocalState() as Record<string, unknown> | null;
      const desiredClaim = isHost ? me : null;
      if ((localState?.[myField] ?? null) !== desiredClaim) {
        aw!.setLocalStateField(myField, desiredClaim);
      }
    }

    function onIncomingKey(): void {
      if (!isHost) return;
      const me = resolveLocalUserId();
      // Edge-triggered: only push key envelopes that are NEW since the last
      // awareness update. A still-present (sticky) remote key field is NOT
      // re-injected on unrelated updates (frame broadcasts, host election,
      // cursor churn) — that re-injection was the phantom-movement bug.
      const pushes = collectIncomingKeyPushes({
        states: aw!.getStates() as Map<number, Record<string, unknown>>,
        moduleId: id,
        selfClientId: aw!.clientID,
        selfUserId: me,
        cursor: keyRelayCursor,
      });
      if (pushes.length === 0) return;
      const extras = getExtras();
      if (!extras) return;
      for (const p of pushes) extras.pushDoomKey(p.doomKey, p.pressed);
    }

    function onIncomingFrame(): void {
      if (isHost) return;
      // Slice 3: a JOINED player runs its own WASM + renders its own POV,
      // so it must NOT overwrite its framebuffer with the host's mirror.
      // Only unjoined spectators consume the remote-frame path.
      if (mySlot !== null) return;
      const states = aw!.getStates();
      states.forEach((s) => {
        const raw = (s as Record<string, unknown>)[`doom:${id}:frame`];
        const env = decodeFrame(raw);
        if (!env || env.moduleId !== id) return;
        const buf = decodeFrameBuffer(env);
        // Cache for the card-side render loop (spectator has no runtime,
        // so extras.snapshotFramebuffer() returns null; we draw from this).
        lastRemoteFrame = buf;
        // Also push into the engine for the GL surface path (videoOut
        // mirror, etc.).
        const extras = getExtras();
        if (extras) extras.pushRemoteFramebuffer(buf);
      });
    }

    const update = (): void => {
      recomputeHost();
      onIncomingKey();
      onIncomingFrame();
      // Slice 3: the host prunes roster entries for departed members
      // (leave-by-disconnect).
      reconcileRosterAsArbiter();
      // Slice 4: the arbiter (host) assigns slots from outstanding
      // join-requests (single writer — fixes the slice-3 clobber).
      assignSlotsAsArbiter();
      // Everyone re-reads their own status off the (arbiter-written) roster.
      syncRosterState();
      // Slice 5: refresh identity (username + slot color tint) on presence
      // churn — a peer's displayName may arrive after the roster slot.
      syncIdentity();
    };
    aw.on('update', update);
    awarenessOff = () => aw.off('update', update);

    // Initial host election.
    recomputeHost();
    // Slice 4: if we came up as the host, assign slots straight away so the
    // host auto-occupies player 0 (so its New Game dialog always has a
    // player to launch as).
    assignSlotsAsArbiter();
    // Slice 3: pick up any roster already present on the synced node + spin
    // up our netcode if we're a returning player.
    syncRosterState();
    // Slice 5: initial identity (username + slot color).
    syncIdentity();

    // Host: broadcast a framebuffer ~10 Hz.
    frameBroadcastInterval = setInterval(() => {
      if (!isHost) return;
      const extras = getExtras();
      if (!extras) return;
      const snap = extras.snapshotFramebuffer();
      if (!snap) return;
      try {
        const env = encodeFrame({
          moduleId: id,
          hostUserId: resolveLocalUserId(),
          width: 640,
          height: 400,
          framebuffer: snap,
          ts: Date.now(),
        });
        aw.setLocalStateField(`doom:${id}:frame`, env);
      } catch {
        // Encoding can throw on buffer mismatch — non-fatal, skip frame.
      }
    }, 100);
  }

  function detachAwareness(): void {
    if (awarenessOff) {
      try { awarenessOff(); } catch { /* */ }
      awarenessOff = null;
    }
    if (frameBroadcastInterval !== null) {
      clearInterval(frameBroadcastInterval);
      frameBroadcastInterval = null;
    }
  }

  // ---- Card-side framebuffer render loop ----
  //
  // The video engine renders DOOM into its FBO every frame; this card
  // mirrors the FBO contents into the visible <canvas> via a per-card
  // rAF blit. Same pattern as VideoOutCard but the source is the DOOM
  // module's own surface texture, not engine.canvas. We use a small
  // inline 2D-canvas blit from the live framebuffer view (which is
  // already in CPU memory via the runtime's HEAPU8 view) so the card
  // doesn't have to drive a GL pull from the engine.
  let raf: number | null = null;
  function startRenderLoop(): void {
    if (raf !== null) return;
    function tick(): void {
      // Slice 4: poll the live DOOM gamestate so the New Game dialog can
      // lock during play + re-open at intermission (GS_INTERMISSION) for the
      // arbiter to pick the next map. Only meaningful once a netgame launched
      // + our own WASM is running (a spectator has no runtime).
      if (launched) {
        const ex = getExtras();
        if (ex) gamestate = ex.getGameState();
        // Slice 5: broadcast our latest local ticcmd so peers move our marine
        // in their worlds (cross-peer visibility). Cheap (4 small ints over a
        // sticky awareness field, deduped by seq on receive).
        broadcastLocalTiccmd();
      }
      if (canvasEl) {
        const ctx2d = canvasEl.getContext('2d');
        if (ctx2d) {
          // Active player: pull straight from its own live runtime.
          // Spectator / pending late joiner (isSpectating): render the host's
          // framebuffer mirror — a pure spectator has no runtime, and a pending
          // joiner's runtime is idle (not launched), so in BOTH cases we prefer
          // the remote frame over the local WASM snapshot.
          const extras = getExtras();
          let fb: Uint8Array | Uint8ClampedArray | null = null;
          if (extras && !isSpectating) fb = extras.snapshotFramebuffer();
          if (!fb) {
            // Belt-and-suspenders: the awareness 'update' listener already
            // populates lastRemoteFrame, but under load chromium can drop
            // listener firings between heavy awareness payloads. Re-poll
            // the latest frame envelope on every rAF tick so the canvas
            // stays current even if no 'update' callback fired this frame.
            pollLatestRemoteFrame();
            fb = lastRemoteFrame;
          }
          if (fb) {
            // Upload BGRA → RGBA via inline byte swap. 640×400 = 256k
            // pixels = 1 MB; the swap is ~16ms on a slow laptop but
            // tolerable at 10 Hz. The GL path inside the engine already
            // does this swizzle at zero cost; we accept the cost here
            // for the small CSS-pixel preview, which doesn't need to
            // match the engine output bit-for-bit.
            const img = ctx2d.createImageData(640, 400);
            const out = img.data;
            for (let i = 0; i < fb.length; i += 4) {
              out[i]     = fb[i + 2]!; // R ← B
              out[i + 1] = fb[i + 1]!; // G
              out[i + 2] = fb[i]!;     // B ← R
              out[i + 3] = 255;
            }
            ctx2d.putImageData(img, 0, 0);
          }
        }
      }
      raf = requestAnimationFrame(tick);
    }
    raf = requestAnimationFrame(tick);
  }
  function stopRenderLoop(): void {
    if (raf !== null) cancelAnimationFrame(raf);
    raf = null;
  }

  // Slice 3: observe the shared nodes map so a roster change that arrives
  // purely via Yjs NODE sync (a remote peer joined / the arbiter pruned a
  // slot) re-runs our status check — awareness 'update' does NOT fire for
  // node-data edits, only for presence-field edits.
  let nodesObserver: (() => void) | null = null;
  function attachNodesObserver(): void {
    const nodesMap = ydoc.getMap('nodes');
    const handler = (): void => { syncRosterState(); };
    nodesMap.observeDeep(handler);
    nodesObserver = () => nodesMap.unobserveDeep(handler);
  }
  function detachNodesObserver(): void {
    if (nodesObserver) {
      try { nodesObserver(); } catch { /* */ }
      nodesObserver = null;
    }
  }

  // ---- Mount / unmount ----
  onMount(() => {
    startRenderLoop();
    // Auto-attach awareness if a provider is present (multi-user rack);
    // single-user `/` canvas skips quietly.
    attachAwareness();
    attachNodesObserver();
    // Capture-phase window listeners (see header). Per-card instance,
    // not module-global — if there were ever >1 DOOM card on the rack
    // (maxInstances:1 prevents that today, but defensively…) each card
    // checks shouldClaimKey() on its own cardEl + the SF node it sits
    // inside, so only the focused/selected one actually claims keys.
    window.addEventListener('keydown', onWindowKeyDownCapture, true);
    window.addEventListener('keyup', onWindowKeyUpCapture, true);
    // Switching apps/tabs (alt-tab, cmd-tab) often delivers no keyup, so
    // release everything still held on window blur + tab-hide.
    window.addEventListener('blur', releaseHeldKeys);
    document.addEventListener('visibilitychange', onVisibilityChange);

    // Slice 3 e2e hook: expose this card's multiplayer state + the join
    // entry point keyed by node id, so the 2-context Playwright test can
    // assert the per-peer instance model (roster, netcode-started, arbiter)
    // without scraping the DOM. Mirrors the dev-only window globals Canvas
    // installs; stripped in prod (the registry import is dev-gated there).
    const g = globalThis as unknown as {
      __doomCards?: Record<string, unknown>;
    };
    if (!g.__doomCards) g.__doomCards = {};
    g.__doomCards[id] = {
      join: () => joinGame(),
      // Explicit host-MP start hooks (the operator's Host Multiplayer / Single
      // Player choice) so the real 2-user e2e drives the documented flow.
      hostMultiplayer: () => hostMultiplayer(),
      playSinglePlayer: () => playSinglePlayer(),
      // Slice 4 e2e hooks: pick options + launch from the arbiter, and read
      // the running game's own-player position to prove per-peer instances.
      setOptions: (opts: { mode?: DoomGameMode; skill?: number; episode?: number; map?: number }) => {
        if (opts.mode) mode = opts.mode;
        if (typeof opts.skill === 'number') skill = opts.skill;
        if (typeof opts.episode === 'number') episode = opts.episode;
        if (typeof opts.map === 'number') mapNum = opts.map;
      },
      launch: () => launchGame(),
      // Slice 6 e2e hook: drive the running level to its end so the polled
      // gamestate transitions to GS_INTERMISSION (the card re-opens the dialog
      // there). Lets the 2-context late-join test reach the next-map seating
      // without scripting an in-game exit-line touch.
      exitLevel: () => {
        const ex = getExtras();
        ex?.exitLevel();
      },
      getPlayerState: () => {
        const ex = getExtras();
        return ex ? ex.getConsolePlayerState() : null;
      },
      // Slice 5 e2e hook: read an arbitrary slot's marine position in THIS
      // peer's world (cross-peer-visibility assertion reads the REMOTE slot).
      getSlotState: (slot: number) => {
        const ex = getExtras();
        return ex ? ex.getPlayerSlotState(slot) : null;
      },
      getState: () => ({
        roster: { ...roster },
        // Slice 6: the pending (late-join) map + this peer's pending slot +
        // viewer status, so the 2-context late-join e2e can assert a joiner
        // reserves a pending slot mid-level then is promoted at the next map.
        pending: { ...pending },
        mySlot,
        myPendingSlot,
        viewerStatus,
        netStarted,
        isNetArbiter,
        isHost,
        memberIds: [...memberIds],
        // Explicit session mode + the owner-id set used for host/P0 election,
        // so the real 2-user e2e can assert the lobby state + that the rack
        // owner (not a lex-min guest) is host/player 0.
        mpMode,
        ownerIds: resolveOwnerIds(),
        netcodePeers: netcode ? netcode.debugStats().peers : [],
        launched,
        gamestate,
        // Slice 5 identity (badge + color + label) for e2e assertions.
        slotColor: slotTint,
        badgeText,
        identityLabel,
        username: myUsername,
        // Slice 6 spectator/pending affordance text.
        specLabel,
        specBadge,
      }),
    };
  });

  onDestroy(() => {
    const g = globalThis as unknown as { __doomCards?: Record<string, unknown> };
    if (g.__doomCards) delete g.__doomCards[id];
    stopRenderLoop();
    detachAwareness();
    detachNodesObserver();
    stopNetcode();
    releaseHeldKeys();
    window.removeEventListener('keydown', onWindowKeyDownCapture, true);
    window.removeEventListener('keyup', onWindowKeyUpCapture, true);
    window.removeEventListener('blur', releaseHeldKeys);
    document.removeEventListener('visibilitychange', onVisibilityChange);
  });

  // ---- Param row ----
  function setParam(paramId: string) {
    return (v: number): void => {
      const target = patch.nodes[id];
      if (target) target.params[paramId] = v;
    };
  }
  let running = $derived<number>(
    node?.params['running'] ?? doomDef.params.find((p) => p.id === 'running')?.defaultValue ?? 1,
  );
  function toggleRunning(): void {
    setParam('running')(running > 0.5 ? 0 : 1);
  }
</script>

<!-- role="application" + tabindex="0" + onclick: the card IS an
     interactive application surface (keyboard-driven game). Mirrors
     ScoreCard. The svelte-check rule wants an interactive handler on
     focusable elements; we register a click-to-focus to satisfy it
     (which is also good UX — click anywhere on the card to grab the
     keyboard). Key handling is window-level capture (see <script>
     header) — NOT card-level — because xyflow's own keydown listeners
     fire on the document and we need to preventDefault BEFORE they do
     to keep arrow keys from moving the card on the canvas instead of
     reaching the in-game player. -->
<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<!-- svelte-ignore a11y_click_events_have_key_events -->
<div
  bind:this={cardEl}
  class="mod-card doom-card"
  role="application"
  aria-label="DOOM video module — keyboard input on focus"
  tabindex="0"
  data-card-type="doom"
  data-testid="doom-card"
  onclick={() => cardEl?.focus()}
>
  <!-- Slice 5: the stripe is tinted by the local player's slot color (vanilla
       DOOM player colors — green/indigo/brown/red) so a wall of 4 DOOM cards
       is instantly readable; a spectator keeps the default video-cable red. -->
  <div class="stripe" style="background: {slotTint};"></div>
  <header class="title">
    {#if mySlot !== null}
      <!-- Active player: "Player N — <username> (you)" + a slot-colored badge. -->
      <span
        class="player-badge"
        data-testid="doom-player-badge"
        style="background: {slotTint};"
        title={identityLabel}
      >{badgeText}</span>
      <span class="player-label" data-testid="doom-player-label">{identityLabel}</span>
    {:else if myPendingSlot !== null}
      <!-- Slice 6: pending late joiner — tinted by the slot it WILL take, with
           a "P(N)?" badge + "Spectating — joining as Player N next map" label. -->
      <span
        class="player-badge pending"
        data-testid="doom-spectator-badge"
        style="background: {slotTint};"
        title={specLabel}
      >{specBadge}</span>
      <span class="player-label spectating" data-testid="doom-spectator-label">{specLabel}</span>
    {:else if memberIds.length > 1}
      <!-- Pure spectator (no slot, multi-user rack): clear "Spectating"
           affordance. A lone host in a single-user rack is NOT a spectator —
           it plays single-player — so we keep the plain "DOOM" title there. -->
      <span class="player-badge spectator" data-testid="doom-spectator-badge" title={specLabel}>{specBadge}</span>
      <span class="player-label spectating" data-testid="doom-spectator-label">{specLabel}</span>
    {:else}
      DOOM
    {/if}
    {#if isHost}
      <span class="host-badge" title="You are running the DOOM instance for this rack">HOST</span>
    {:else}
      <span class="spec-badge" title="Spectating — host is running the game">SPEC</span>
    {/if}
  </header>

  <div class="game-area">
    <canvas
      bind:this={canvasEl}
      width="640"
      height="400"
      style="width: 320px; height: 200px;"
      data-viz-passthrough
      data-testid="doom-canvas"
    ></canvas>
    {#if loadStatus === 'idle' && isHost}
      <button class="overlay" onclick={() => void tryLoad()}>
        Click to load DOOM
        <small>(downloads ~4 MB WAD on first spawn)</small>
      </button>
    {:else if loadStatus === 'loading'}
      <div class="overlay">Loading WASM + DOOM1.WAD…</div>
    {:else if loadStatus === 'error'}
      <div class="overlay error">
        <strong>DOOM failed to load:</strong>
        <code>{loadError}</code>
      </div>
    {/if}
    {#if loadStatus === 'ready' && cardEl && document.activeElement !== cardEl}
      <button
        type="button"
        class="focus-hint"
        onclick={() => cardEl?.focus()}
      >
        Click to capture keyboard
      </button>
    {/if}
  </div>

  {#each CV_GATE_PORT_IDS as port, idx (port)}
    {@const top = 56 + idx * 28}
    {@const label = port === 'up' ? '↑'
                  : port === 'down' ? '↓'
                  : port === 'left' ? '←'
                  : port === 'right' ? '→'
                  : port.toUpperCase()}
    <Handle
      type="target"
      position={Position.Left}
      id={port}
      style="top: {top}px; --handle-color: var(--cable-cv);"
    />
    <span class="port-label left" style="top: {top - 6}px;">{label}</span>
  {/each}

  <Handle
    type="source"
    position={Position.Right}
    id="out"
    style="top: 56px; --handle-color: var(--cable-video, #c33);"
  />
  <span class="port-label right" style="top: 50px;">OUT</span>
  <Handle
    type="source"
    position={Position.Right}
    id="audio_l"
    style="top: 96px; --handle-color: var(--cable-audio);"
  />
  <span class="port-label right" style="top: 90px;">A-L</span>
  <Handle
    type="source"
    position={Position.Right}
    id="audio_r"
    style="top: 124px; --handle-color: var(--cable-audio);"
  />
  <span class="port-label right" style="top: 118px;">A-R</span>

  {#if isHost && mpMode === undefined}
    <!-- Explicit host start choice (replaces the implicit "2nd member ⇒
         auto-start" detection). The host decides whether this DOOM session is
         single-player or a multiplayer lobby; the choice is stored on the node
         so guests see the lobby state. -->
    <div class="start-choice" data-testid="doom-start-choice">
      <button
        class="start-btn"
        data-testid="doom-start-single"
        onclick={() => void playSinglePlayer()}
        title="Play DOOM solo (no netgame)"
      >
        Single Player
      </button>
      <button
        class="start-btn primary"
        data-testid="doom-start-multi"
        onclick={() => void hostMultiplayer()}
        title="Open a multiplayer lobby — you are player 1; rack-mates can Join"
      >
        Host Multiplayer
      </button>
    </div>
  {/if}

  <div class="controls-row">
    <button
      class="run-btn"
      onclick={toggleRunning}
      title="Pause / resume the game loop"
    >
      {running > 0.5 ? 'Pause' : 'Run'}
    </button>
    {#if mpMode === 'multi' && mySlot === null && myPendingSlot === null}
      <!-- Join is offered to an unjoined peer once the HOST has opened a
           multiplayer lobby (mpMode === 'multi'). A pending late joiner has
           already claimed a (pending) slot. Fullness is the COMBINED active +
           pending occupancy so a reserved late-join slot counts. While a level
           is running, the join label hints it'll seat at the next map. -->
      {@const full = isFull(combinedRoster({ active: roster, pending }))}
      <button
        class="join-btn"
        data-testid="doom-join-btn"
        disabled={full}
        onclick={() => void joinGame()}
        title={full
          ? 'DOOM is full (4 players)'
          : isGameInProgress()
            ? 'Join — you will spectate, then spawn at the next map'
            : 'Join this DOOM netgame as a player'}
      >
        {full ? 'Full' : isGameInProgress() ? 'Join (next map)' : 'Join'}
      </button>
    {/if}
  </div>

  {#if mpMode === 'multi' && mySlot !== null}
    {@const inLevel = launched && gamestate === GS_LEVEL}
    {@const atIntermission = launched && gamestate === GS_INTERMISSION}
    {@const pendingCount = rosterSize(pending)}
    <div class="newgame" data-testid="doom-newgame">
      {#if isSessionArbiter()}
        <!-- Arbiter (host = player 0): pick mode/skill/episode/map + Launch.
             Locked while a level is actively running; re-opens at the end of
             the level (intermission / finale) to pick the next map. -->
        <div class="ng-row">
          <label>
            Mode
            <select bind:value={mode} disabled={inLevel} data-testid="doom-mode">
              {#each MODE_OPTIONS as m (m)}
                <option value={m}>{m}</option>
              {/each}
            </select>
          </label>
          <label>
            Skill
            <select bind:value={skill} disabled={inLevel} data-testid="doom-skill">
              {#each SKILL_LABELS as label, i (i)}
                <option value={i}>{i + 1} — {label}</option>
              {/each}
            </select>
          </label>
        </div>
        <div class="ng-row">
          <label>
            Ep
            <!-- DOOM1 shareware ships episode 1 only; the picker offers 1-3
                 for full-WAD parity but defaults to + clamps sensibly. -->
            <select bind:value={episode} disabled={inLevel} data-testid="doom-episode">
              {#each [1, 2, 3] as e (e)}
                <option value={e}>{e}</option>
              {/each}
            </select>
          </label>
          <label>
            Map
            <select bind:value={mapNum} disabled={inLevel} data-testid="doom-map">
              {#each [1, 2, 3, 4, 5, 6, 7, 8, 9] as mp (mp)}
                <option value={mp}>{mp}</option>
              {/each}
            </select>
          </label>
          <button
            class="launch-btn"
            data-testid="doom-launch-btn"
            disabled={inLevel}
            onclick={launchGame}
            title={inLevel ? 'Level in progress — pick the next map at the end' : 'Start the game on all joined players'}
          >
            {launched ? (inLevel ? 'In Level' : 'Next Map') : 'Launch'}
          </button>
        </div>
        {#if pendingCount > 0}
          <!-- Slice 6: tell the arbiter how many late joiners are waiting to be
               seated at the next map (Launch / Next Map promotes them). -->
          <div class="ng-pending" data-testid="doom-pending-note">
            {pendingCount} player{pendingCount > 1 ? 's' : ''} joining
            {atIntermission || !inLevel ? 'this map on launch' : 'next map'}
          </div>
        {/if}
      {:else}
        <!-- Non-arbiter joined players: wait for the host to start. -->
        <div class="ng-waiting" data-testid="doom-waiting">
          {#if inLevel}
            In level — playing as P{mySlot + 1}
          {:else}
            Waiting for host to start…
          {/if}
        </div>
      {/if}
    </div>
  {:else if mpMode === 'multi' && myPendingSlot !== null}
    <!-- Slice 6: a pending late joiner spectates the running game + shows when
         it'll be seated. It has no New Game controls (only active players do).
         The header already carries the "joining as Player N next map" label;
         this is the in-body status echo. -->
    <div class="newgame" data-testid="doom-newgame">
      <div class="ng-waiting" data-testid="doom-pending-waiting">
        {specLabel}
      </div>
    </div>
  {/if}

  <footer class="hint">
    {#if memberIds.length > 1}
      <small data-testid="doom-member-hint">
        {memberIds.length} rack-mates · host: {isHost ? 'you' : 'remote'}
        {#if mpMode === 'multi'}
          {#if mySlot !== null}
            · player {mySlot + 1}{netStarted ? (isNetArbiter ? ' · arbiter' : ' · client') : ''}
          {:else if myPendingSlot !== null}
            · joining P{myPendingSlot + 1} next map
          {:else}
            · spectating
          {/if}
        {:else if !isHost}
          · waiting for host to start multiplayer
        {/if}
      </small>
    {:else}
      <small data-testid="doom-member-hint">Single-user rack — you're the host.</small>
    {/if}
  </footer>
</div>

<style>
  .doom-card {
    width: 360px;
    min-height: 320px;
    outline: none;
  }
  .doom-card:focus-within {
    outline: 2px solid var(--cable-video, #c33);
    outline-offset: -2px;
  }
  .doom-card .title {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  /* Push the host/spec status badge to the far right; the optional
     player-badge + identity label sit inline right after the title. The
     label grows to fill the gap so the status badge stays right-aligned. */
  .doom-card .host-badge,
  .doom-card .spec-badge {
    margin-left: auto;
  }
  .doom-card .host-badge,
  .doom-card .spec-badge,
  .doom-card .player-badge {
    font-size: 9px;
    font-weight: 700;
    padding: 2px 5px;
    border-radius: 2px;
    letter-spacing: 0.05em;
  }
  .doom-card .player-badge {
    /* background is set inline by slot color (slice 5) */
    color: white;
  }
  .doom-card .player-label {
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.02em;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    /* grow to fill the header so the host/spec badge stays right-aligned */
    margin-right: auto;
  }
  .doom-card .join-btn {
    font-size: 11px;
    padding: 3px 8px;
    background: color-mix(in oklab, var(--cable-cv, #4a9) 70%, black);
    color: white;
    border: none;
    cursor: pointer;
  }
  .doom-card .join-btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
  .doom-card .host-badge {
    background: var(--cable-video, #c33);
    color: white;
  }
  .doom-card .spec-badge {
    background: color-mix(in oklab, var(--cable-video, #c33) 30%, transparent);
    color: var(--cable-video, #c33);
  }
  .doom-card .game-area {
    display: flex;
    justify-content: center;
    padding: 6px 0 8px;
    position: relative;
  }
  .doom-card canvas {
    display: block;
    image-rendering: pixelated;
    image-rendering: crisp-edges;
    background: #000;
    border: 1px solid color-mix(in oklab, var(--cable-video, #c33) 30%, transparent);
  }
  .doom-card .overlay {
    position: absolute;
    inset: 6px 0 8px 0;
    margin: 0 auto;
    width: 320px;
    height: 200px;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 6px;
    background: rgba(0, 0, 0, 0.7);
    color: white;
    font-size: 13px;
    cursor: pointer;
    border: 1px solid color-mix(in oklab, var(--cable-video, #c33) 50%, transparent);
  }
  .doom-card .overlay small {
    font-size: 10px;
    opacity: 0.8;
  }
  .doom-card .overlay.error code {
    font-size: 10px;
    color: #fbb;
    margin-top: 4px;
  }
  .doom-card .focus-hint {
    position: absolute;
    bottom: 12px;
    left: 50%;
    transform: translateX(-50%);
    background: rgba(0, 0, 0, 0.5);
    color: white;
    font-size: 10px;
    padding: 3px 6px;
    border: 1px solid rgba(255, 255, 255, 0.3);
    cursor: pointer;
  }
  .doom-card .controls-row {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 0 10px 6px;
    flex-wrap: wrap;
  }
  .doom-card .run-btn {
    font-size: 11px;
    padding: 3px 8px;
    background: var(--cable-video, #c33);
    color: white;
    border: none;
    cursor: pointer;
  }
  .doom-card .newgame {
    padding: 0 10px 6px;
    display: flex;
    flex-direction: column;
    gap: 5px;
  }
  .doom-card .ng-row {
    display: flex;
    align-items: flex-end;
    gap: 8px;
    flex-wrap: wrap;
  }
  .doom-card .ng-row label {
    display: flex;
    flex-direction: column;
    font-size: 9px;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    opacity: 0.8;
    gap: 2px;
  }
  .doom-card .ng-row select {
    font-size: 11px;
    padding: 2px 4px;
    background: #181014;
    color: #eee;
    border: 1px solid color-mix(in oklab, var(--cable-video, #c33) 40%, transparent);
  }
  .doom-card .ng-row select:disabled {
    opacity: 0.5;
  }
  .doom-card .launch-btn {
    font-size: 11px;
    font-weight: 700;
    padding: 4px 12px;
    margin-left: auto;
    background: var(--cable-video, #c33);
    color: white;
    border: none;
    cursor: pointer;
  }
  .doom-card .launch-btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
  .doom-card .ng-waiting {
    font-size: 11px;
    font-style: italic;
    opacity: 0.8;
    color: color-mix(in oklab, var(--cable-video, #c33) 70%, white);
    padding: 2px 0;
  }
  /* Slice 6: arbiter's "N players joining next map" note. */
  .doom-card .ng-pending {
    font-size: 10px;
    font-style: italic;
    opacity: 0.85;
    color: color-mix(in oklab, var(--cable-cv, #4a9) 80%, white);
    padding: 2px 0;
  }
  /* Slice 6: pending late joiner badge — dashed to read as "reserved, not
     live yet"; pure-spectator badge uses the muted video-cable tint. */
  .doom-card .player-badge.pending {
    border: 1px dashed rgba(255, 255, 255, 0.6);
    color: white;
  }
  .doom-card .player-badge.spectator {
    background: color-mix(in oklab, var(--cable-video, #c33) 30%, transparent);
    color: var(--cable-video, #c33);
  }
  .doom-card .player-label.spectating {
    font-style: italic;
    opacity: 0.85;
  }
  .doom-card .port-label {
    position: absolute;
    font-size: 9px;
    letter-spacing: 0.05em;
    opacity: 0.85;
    font-family: ui-monospace, monospace;
    pointer-events: none;
  }
  .doom-card .port-label.left  { left: 14px; }
  .doom-card .port-label.right { right: 14px; }
  .doom-card .hint {
    padding: 0 10px 8px;
    color: color-mix(in oklab, var(--cable-video, #c33) 70%, transparent);
    font-size: 10px;
  }
</style>
