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
  // see doom-presence.ts → pickHost). Each JOINED player runs its OWN WASM
  // and renders its own POV. An unjoined spectator runs no WASM — its surface
  // stays black (the DOOM attract screen) until it JOINS — and relays its own
  // keystrokes to the host over a tiny key envelope.
  //
  // NO FRAMEBUFFER MIRROR (relay-OOM fix): the host used to base64 its ~1.4 MB
  // framebuffer into a Yjs awareness field at ~10 Hz so spectators could watch
  // the host's screen. The Hocuspocus relay holds + rebroadcasts awareness in
  // process memory, so that firehose OOM-killed it (exit 137), wiping shared
  // state. The whole framebuffer-over-awareness path was removed; awareness now
  // carries only tiny fields (key envelopes, host claim, join-request).
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
  import { type DoomHandleExtras } from '$lib/video/modules/doom';
  import { CV_GATE_PORT_IDS, cvGatePortIdForSlot, DOOM_MP_SLOTS, type CvGatePortId } from '$lib/doom/doomkeys';
  import { isOwnSlotCvGatePatched } from '$lib/doom/doom-input-mode';
  import {
    bumpAwarenessUpdate,
    bumpElectionRecompute,
    readCounters,
  } from '$lib/doom/doom-instrumentation';
  import { HeldKeyTracker } from '$lib/doom/held-keys';
  import {
    encodeKey,
    collectIncomingKeyPushes,
    type RelayCursor,
  } from '$lib/doom/doom-presence';
  import { decideHostRole } from '$lib/doom/doom-host-authority';
  import { electionAwarenessSignature } from '$lib/doom/doom-awareness-signature';
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
    LockstepTransport,
    DEFAULT_INPUT_DELAY_TICS,
    consolidatedTicFieldFor,
    computeBarrierFloor,
  } from '$lib/doom/doom-lockstep';
  import {
    slotColorCss,
    slotLabel,
    slotBadge,
    spectatorLabel,
    spectatorBadge,
    type DoomViewerStatus,
  } from '$lib/doom/doom-player-identity';
  import {
    computeMpLive,
    joinAffordance,
    shouldHotJoinRelaunch,
  } from '$lib/doom/doom-gating';
  import { shouldOpenMultiplayer, guestWaitingState } from '$lib/doom/doom-session';

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
  // Storm-throttle instrumentation (the multiplayer-hang guard). The probe
  // reads these via the debug hook to assert that the EXPENSIVE election/roster
  // recompute stays bounded per-second even while awareness updates flood in at
  // the per-tic rate. Kept in MODULE scope (doom-instrumentation, keyed by node
  // id) rather than as per-instance closure vars so they're MONOTONIC across a
  // card remount — a hot-join relaunch (or SvelteFlow node remount) used to
  // reset closure counters to 0 mid-run, which made the probe's
  // (end - baseline) aggregate go NEGATIVE.
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
  // ---- P1: true deterministic lockstep ----
  //
  // When a >1-player netgame launches, every peer runs a TRUE shared simulation:
  // each appends its per-tic ticcmd to a Yjs Y.Array append-log, reads the log,
  // consolidates an ordered per-tic TicSet, and feeds it into the WASM barrier
  // (extras.receiveTicSet). The sim advances only over complete TicSets and
  // PAUSES (never spins) when starved. This replaces the slice-5 last-value
  // awareness overlay + the #339 reinject band-aid on the lockstep path, so
  // monsters/barrels/health/positions are byte-identical across peers. A lone
  // (numPlayers==1) game leaves lockstep OFF → single-player is byte-identical.
  let lockstep: LockstepTransport | null = null;
  let lockstepActive = $state(false);
  // The next consolidated tic we still need to deliver (== engine recvtic).
  let lockstepNextTic = 0;
  // Highest local tic we've appended to the shared log (gap-free append cursor).
  let lockstepAppendedThru = -1;
  // Launch generation of the active lockstep game (== launchId). Namespaces the
  // shared log + the per-peer consolidated-tic awareness floor field so a
  // relaunch starts fresh (issue #348).
  let lockstepGeneration = 0;
  // Throttle the barrier-floor prune so we delete a stale prefix ~1–2×/sec, not
  // every rAF (deleting an empty prefix is a no-op, but recomputing the floor +
  // scanning the log each frame is wasted work). Wall-clock millis of last prune.
  let lockstepLastPruneMs = 0;
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
  // ---- Round 5: host-authoritative "MP is live" signal ----
  //
  // A guest's Join button is enabled IFF the host is currently running a
  // multiplayer game (in an active MP session, in-level). Rather than have the
  // guest INFER that from racy awareness churn, the HOST writes a single Yjs-
  // synced boolean leaf (node.data.mpLive) each tick; the guest reads it.
  // mpLive == (mpMode==='multi' AND launched AND gamestate===GS_LEVEL). It is
  // false at the lobby (no game yet), at intermission (between maps), and in
  // single-player. Mirrored into $state like roster/mpMode (refreshed in
  // syncRosterState) because a node-data edit arrives via the Yjs nodes
  // observer, not Svelte's reactive proxy.
  let mpLive = $state(false);
  function readNodeMpLive(): boolean {
    const target = patch.nodes[id];
    return (target?.data as { mpLive?: unknown } | undefined)?.mpLive === true;
  }
  /** Host-only: persist the MP-live flag on the shared node. Only written when
   *  it actually flips (avoids a per-tick Yjs write storm). Non-LOCAL_ORIGIN
   *  session state, same rationale as mpMode / the roster leaves. */
  function writeNodeMpLive(next: boolean): void {
    if (readNodeMpLive() === next) return; // no-op when unchanged
    ydoc.transact(() => {
      const target = patch.nodes[id];
      if (!target) return;
      if (!target.data) target.data = {};
      (target.data as Record<string, unknown>).mpLive = next;
    });
  }
  /** Host-only: recompute mpLive from our own session state + publish it if it
   *  changed. Called from the render loop (gamestate is polled there) + on the
   *  explicit session-mode transitions. */
  function refreshMpLiveAsHost(): void {
    if (!isHost) return;
    const next = computeMpLive({ mpMode, launched, gamestate });
    mpLive = next;
    writeNodeMpLive(next);
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

  // ---- Custom dropdowns for the New Game dialog ----
  //
  // The native <select> popup is NOT reliably mouse-operable inside a
  // SvelteFlow node: SF captures the pointer on mousedown to start a node-drag,
  // and even with `nodrag` the browser's OS-rendered option list fights SF's
  // pointer capture (the operator's "MODE/SKILL selects won't open by mouse"
  // bug). We replace them with a small purpose-built dropdown — a `nodrag`
  // button that toggles a `nodrag` option list rendered in normal DOM, so a
  // plain click selects an option with no native popup + no SF interference.
  // Only one dropdown is open at a time (openDropdown holds its id, or null).
  let openDropdown = $state<string | null>(null);
  function toggleDropdown(which: string): void {
    openDropdown = openDropdown === which ? null : which;
  }
  function closeDropdowns(): void {
    openDropdown = null;
  }

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

  /** A launch envelope we received but could not start yet because our OWN
   *  WASM runtime wasn't loaded/initialized at the time (the load is async +
   *  can lag the GAMESTART broadcast — on the ARBITER it fires synchronously
   *  inside broadcastGameStart, possibly before init resolves; on a guest the
   *  roster slot can sync a beat after the broadcast). We stash the latest
   *  pending launch + retry it from the render loop until the runtime is ready
   *  AND the C side actually entered GS_LEVEL. This is the fix for the
   *  "host stuck on the title/attract menu after Launch" bug: previously
   *  startNetGame silently no-op'd when the runtime wasn't ready and nothing
   *  ever re-applied it, so the host's WASM kept running the demo loop. */
  let pendingLaunch: GameStartEnvelope | null = null;

  /** Apply a launch on THIS peer: start the WASM netgame at our own slot.
   *
   *  Slice 6: at a next-map launch the arbiter PROMOTES pending → active +
   *  writes the roster, THEN broadcasts the launch. The two updates arrive on
   *  different channels (node-sync vs awareness) and can race, so we re-read
   *  the LIVE active slot off the node here (not just the reactive mirror) to
   *  catch a just-promoted late joiner whose syncRosterState may not have run
   *  yet. A peer still pending (no active slot) keeps spectating — it does NOT
   *  start a game until a launch carries it as active.
   *
   *  Robustness (host-stuck-on-menu fix): the WASM runtime may not be loaded
   *  yet when this fires (the arbiter self-fires synchronously inside Launch;
   *  loads are async). If we can't drive the level NOW we stash `env` in
   *  pendingLaunch + ensure our WASM is loading; the render loop retries until
   *  the C side reports GS_LEVEL. We also verify the C side actually entered
   *  the level (G_InitNew is synchronous, so getGameState() === GS_LEVEL right
   *  after a successful startNetGame) before clearing the retry. */
  function applyGameStart(env: GameStartEnvelope): void {
    const me = resolveLocalUserId();
    const slot = slotForUser(readNodeRoster(), me);
    if (slot !== null) mySlot = slot;     // adopt the promoted slot immediately
    if (slot === null) {
      // No ACTIVE slot yet. This is EITHER a pure spectator OR a peer whose
      // roster slot simply hasn't synced from the arbiter yet (the GAMESTART
      // broadcast + the roster node-sync race; the broadcast can win). We
      // can't tell the two apart here, so we STASH the launch and let
      // syncRosterState re-apply it the moment a slot arrives — that's the fix
      // for "guest renders a spectator mirror instead of becoming active P2".
      // A genuine spectator never gains a slot, so the stash simply never
      // fires for them. pruneRoster clears the stash if we're dropped.
      pendingLaunch = env;
      if (loadStatus === 'idle') void tryLoad();
      return;
    }
    // Mirror the chosen settings into the dialog so the arbiter's controls
    // reflect what's running (and the next-map pick starts from here). Do this
    // even if the runtime isn't ready yet so the UI is correct while we retry.
    mapNum = env.settings.map;
    episode = env.settings.episode;
    skill = env.settings.skill;
    launched = true;

    const extras = getExtras();
    const runtime = extras?.getRuntime();
    if (!extras || !runtime || !runtime.isInitialized()) {
      // Runtime not ready — stash + retry from the render loop. Make sure the
      // WASM is actually loading (a peer whose slot synced before it clicked
      // anything may not have started a load yet).
      pendingLaunch = env;
      if (loadStatus === 'idle') void tryLoad();
      return;
    }
    // Own-slot-only CV routing (#353): bind the factory to this peer's slot so
    // its CV-gate group drives the sim + other slots' CV is ignored locally.
    extras.setOwnSlot(slot);
    extras.startNetGame(env.settings, slot);
    // P1: arm true lockstep for a >1-player game. Both peers start the level at
    // the same shared tic 0 (recvtic=gametic=0 after dgpt_start_netgame) with
    // the same seed/settings (identical skill/episode/map/numPlayers → identical
    // G_InitNew + RNG LUT), so the first consolidated TicSet (tic 0) is the
    // shared start. The launchId is the log GENERATION so a (re)launch uses a
    // fresh shared log. A lone game leaves lockstep OFF (single-player byte-exact).
    setupLockstep(env.settings.numPlayers, slot, env.launchId);
    // G_InitNew runs synchronously inside dgpt_start_netgame, so the level is
    // loaded immediately. If for any reason it didn't take (gamestate still on
    // the demo screen), keep the pending launch so the render loop re-applies.
    if (extras.getGameState() === GS_LEVEL) {
      pendingLaunch = null;
    } else {
      pendingLaunch = env;
    }
  }

  /** P1: (re)arm the lockstep barrier + transport for this launch. For a lone
   *  game (numPlayers <= 1) it disarms lockstep entirely (single-player path).
   *  Idempotent — a relaunch (next map / P2 restart) rebuilds the transport at
   *  the new roster size and resets the shared tic clock to 0. */
  function setupLockstep(numPlayers: number, slot: number, generation: number): void {
    const extras = getExtras();
    if (!extras) return;
    if (numPlayers <= 1) {
      extras.setLockstep(false);
      extras.setInputDelay(0);
      lockstep = null;
      lockstepActive = false;
      clearConsolidatedTicAwareness(lockstepGeneration);
      return;
    }
    extras.setLockstep(true);
    // INPUT-DELAY buffer: build local ticcmds D tics ahead of gametic so each
    // peer's per-tic entry has ~D×28.5ms to propagate through the relay before
    // the barrier needs it — the sim runs at 35Hz instead of stalling every tic
    // waiting on an in-flight remote TicSet. Determinism is preserved (true tic
    // numbers + identical consolidated TicSet per tic). Trade-off: the marine
    // responds D tics (~171ms) later — normal netplay latency.
    extras.setInputDelay(DEFAULT_INPUT_DELAY_TICS);
    // A relaunch uses a fresh generation; clear our stale floor field from the
    // PREVIOUS generation so it can't linger in awareness (issue #348).
    if (generation !== lockstepGeneration) clearConsolidatedTicAwareness(lockstepGeneration);
    lockstep = new LockstepTransport({ doc: ydoc, moduleId: id, slot, numPlayers, generation });
    lockstepActive = true;
    lockstepNextTic = 0;
    lockstepAppendedThru = -1;
    lockstepGeneration = generation;
    lockstepLastPruneMs = 0;
  }

  /** Render-loop hook: if a launch is pending (runtime wasn't ready when the
   *  GAMESTART arrived), re-attempt it now. Cleared by applyGameStart once the
   *  C side reports GS_LEVEL. Idempotent + cheap (a couple of ccalls). */
  function retryPendingLaunchIfNeeded(): void {
    if (!pendingLaunch) return;
    applyGameStart(pendingLaunch);
  }
  /** Slice 5: inject a remote peer's ticcmd into our runtime so its marine
   *  moves in our world. Ignores our own slot (the netcode already filters
   *  self, but guard defensively) + spectators (no runtime). */
  function applyRemoteTiccmd(env: TiccmdEnvelope): void {
    const extras = getExtras();
    if (!extras) return;
    // NEVER let a remote injection drive THIS peer's OWN console-player slot —
    // its locally-built ticcmd (G_BuildTiccmd) is authoritative. This is the
    // host-freeze guard: the per-rAF gap-fill (reinjectKnownTiccmds, #339) re-
    // fires every present peer's last-known envelope each tic; if any of them
    // carried (or a slot race made them appear to carry) OUR slot, re-injecting
    // it would fight/overwrite our own marine's input → the host stops responding
    // to its own keys the instant a remote peer is being re-fed. We compare
    // against the AUTHORITATIVE C consoleplayer (getConsolePlayerState().slot),
    // not just the reactive `mySlot` mirror, so a transient mirror lag during a
    // relaunch can't open a window where a remote drives our own slot. (The C
    // side also guards slot==localplayer; this is the JS-side belt-and-braces the
    // regression test pins.) `mySlot` is kept as the cheap pre-check.
    if (mySlot !== null && env.slot === mySlot) return;
    const ownSlot = extras.getConsolePlayerState()?.slot;
    if (ownSlot !== undefined && env.slot === ownSlot) return;
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

  /** Approach A — lockstep gap-fill. Each tic, re-apply every present remote
   *  peer's last-known ticcmd (via the netcode) so a steady/idle remote peer's
   *  marine stays driven in our world. The netcode fires onRemoteTiccmd →
   *  applyRemoteTiccmd → injectRemoteTiccmd, refreshing the C overlay table.
   *  Only meaningful for a joined player running a launched netgame. */
  function reinjectRemoteTiccmds(): void {
    if (!netcode) return;
    if (mySlot === null) return;
    if (!launched) return;
    netcode.reinjectKnownTiccmds();
  }

  /** P1 true-lockstep pump (replaces broadcast + reinject on the lockstep path).
   *  Each frame: (1) APPEND this peer's freshly-built local ticcmd(s) for the
   *  tics the engine has built (maketic-1) to the shared ordered log; (2) DRAIN
   *  every now-complete consolidated TicSet from the log, IN ORDER, into the
   *  WASM barrier (extras.receiveTicSet). The engine then advances gametic up to
   *  recvtic on its own runTic and PAUSES (never spins) when a TicSet is
   *  missing. (3) The arbiter prunes consumed log entries. The sim never
   *  free-runs and never busy-waits. */
  function pumpLockstep(): void {
    if (!lockstepActive || !lockstep) return;
    if (mySlot === null || !launched) return;
    const extras = getExtras();
    if (!extras) return;

    // (1) Append our local input for EVERY built-but-not-yet-logged tic (not
    // just the latest): the engine can build several tics in one frame, so we
    // walk from the last-appended tic up to maketic-1 and append each, reading
    // that tic's exact ticcmd from the ring. This keeps the per-tic stream
    // GAP-FREE — a gap would stall the barrier forever (the missing tic never
    // consolidates). Each entry is tagged with its engine tic so every peer
    // agrees which input belongs to which tic.
    const maketic = extras.getMaketic();
    for (let t = lockstepAppendedThru + 1; t <= maketic - 1; t++) {
      const c = extras.readLocalTiccmdAt(t);
      if (!c) break; // fell out of the ring (shouldn't happen at our cadence)
      lockstep.appendLocal(t, c);
      lockstepAppendedThru = t;
    }

    // (2) Drain ready TicSets in order, starting at the engine's recvtic. Each
    // delivered set bumps recvtic in the WASM, releasing one more tic for the
    // next runTic to advance.
    lockstepNextTic = extras.getRecvtic();
    lockstepNextTic = lockstep.drainReady(lockstepNextTic, (tic, numPlayers, set) => {
      extras.receiveTicSet(tic, numPlayers, set);
    });

    // (3) Publish OUR highest-consolidated tic (engine recvtic) so the arbiter
    // can compute the barrier floor across all live peers (issue #348). recvtic
    // is the last tic we have a complete TicSet for + have advanced past, so
    // everything below it is consumed on our side.
    publishConsolidatedTic(extras.getRecvtic());

    // (4) Arbiter prunes consumed entries below the BARRIER FLOOR so the log
    // never grows unbounded → relay OOM. The floor = min(consolidated tic) over
    // ALL live peers, computed from the published awareness values: it never
    // drops a tic any live peer still needs (a slow/reconnecting peer holds the
    // floor back; a hopelessly-wedged peer trips the transport's hard cap +
    // must resync via synchronized restart). Throttled to ~2/sec — pruning a
    // consumed prefix doesn't change what any peer simulates (determinism kept).
    if (isNetArbiter) {
      const now = Date.now();
      if (now - lockstepLastPruneMs >= LOCKSTEP_PRUNE_INTERVAL_MS) {
        lockstepLastPruneMs = now;
        const floor = readBarrierFloor();
        lockstep.pruneBelowFloor(floor);
      }
    }
  }

  /** Min interval between barrier-floor prunes (issue #348). ~2/sec keeps the
   *  log bounded without rescanning it every rAF. */
  const LOCKSTEP_PRUNE_INTERVAL_MS = 500;

  /** Publish THIS peer's highest-consolidated tic (recvtic) onto its awareness
   *  state, keyed by module + launch generation. Idempotent-cheap: skips the
   *  write when the value is unchanged so an idle/paused peer doesn't churn
   *  awareness. Read by the arbiter via readBarrierFloor (issue #348). */
  let lastPublishedConsolidatedTic = -1;
  function publishConsolidatedTic(recvtic: number): void {
    const provider = providerCtx.get();
    const aw = provider?.awareness;
    if (!aw) return;
    if (recvtic === lastPublishedConsolidatedTic) return;
    lastPublishedConsolidatedTic = recvtic;
    aw.setLocalStateField(consolidatedTicFieldFor(id, lockstepGeneration), { slot: mySlot, t: recvtic });
  }

  /** Clear our published consolidated-tic field for `generation` (on relaunch /
   *  disarm) so a stale value can't drag a future floor to 0 (issue #348). */
  function clearConsolidatedTicAwareness(generation: number): void {
    const provider = providerCtx.get();
    const aw = provider?.awareness;
    if (!aw) return;
    aw.setLocalStateField(consolidatedTicFieldFor(id, generation), null);
    lastPublishedConsolidatedTic = -1;
  }

  /** Read every live peer's published consolidated tic from awareness and
   *  compute the BARRIER FLOOR = min across all live slots (issue #348). A live
   *  roster slot with no published value forces the floor to 0 (no prune) — the
   *  conservative safety rule (never drop a tic a live peer might still need). */
  function readBarrierFloor(): number {
    const provider = providerCtx.get();
    const aw = provider?.awareness;
    if (!aw) return 0;
    const numPlayers = Math.max(1, rosterSize(roster));
    const field = consolidatedTicFieldFor(id, lockstepGeneration);
    const bySlot: (number | undefined)[] = new Array(numPlayers).fill(undefined);
    for (const [, state] of aw.getStates()) {
      const v = (state as Record<string, unknown>)?.[field] as
        | { slot?: number | null; t?: number }
        | null
        | undefined;
      if (!v || typeof v.t !== 'number') continue;
      const s = v.slot;
      if (typeof s !== 'number' || s < 0 || s >= numPlayers) continue;
      // Lowest report wins per slot if a slot somehow reports twice (shouldn't);
      // conservative for the floor.
      if (bySlot[s] === undefined || v.t < (bySlot[s] as number)) bySlot[s] = v.t;
    }
    return computeBarrierFloor(bySlot, numPlayers);
  }

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

  /** This client's OWN rack ownership, resolved from RELIABLE local identity
   *  (the provider's LOCAL awareness `user.isRackOwner`, which the page set
   *  from server data — NOT received over the network). This is the input that
   *  makes host election split-brain-proof: a client trusts what IT knows about
   *  itself, never a count of (possibly-empty) remote awareness.
   *
   *    true  → confirmed owner (data.rackspace.ownerUserId === currentUserId).
   *    false → confirmed authed NON-owner (the rack has an owner; it's not me).
   *    null  → anon member (no `isRackOwner` field published) OR no provider —
   *            a rack with no owner concept, so the deterministic lex-min
   *            fallback in decideHostRole applies.
   *
   *  multiplayer/presence.ts publishes `isRackOwner: true|false` for authed
   *  users and OMITS the field for anon users, giving exactly this tri-state. */
  function resolveLocalOwnership(): boolean | null {
    const provider = providerCtx.get();
    const aw = provider?.awareness;
    if (!aw) return null;
    const state = aw.getLocalState() as { user?: { isRackOwner?: boolean } } | null;
    const flag = state?.user?.isRackOwner;
    return flag === true ? true : flag === false ? false : null;
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
  // A peer with no ACTIVE slot is an unjoined spectator: it never loaded WASM,
  // so its preview canvas stays black (the DOOM attract screen) until it JOINS
  // and brings up its own runtime + POV. There is no host-framebuffer mirror to
  // render anymore (relay-OOM fix) — a spectator simply shows nothing.

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
      // Own-slot-only CV routing (#353): the runtime now exists, so (re)apply
      // this peer's slot — the $effect that tracks mySlot may have run while
      // getExtras() was still null (WASM loading), so set it again here.
      extras.setOwnSlot(mySlot);
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
    // Round 5: a GUEST can only join when the host is currently running a
    // multiplayer game (mpLive). The Join button is already disabled otherwise,
    // but join() is also reachable via the dev/e2e hook — so guard here too.
    // A guest never implicitly opens MP anymore: the host's "start a
    // multiplayer game" is the single gate; after that, any guest Join is a
    // valid one-click hot-join. (Already-seated guests fall through to the
    // idempotent re-ensure below regardless.)
    if (!isHost) {
      const combinedNow = combinedRoster(readNodeRosterState());
      const seated = slotForUser(combinedNow, me) !== null;
      if (!seated && !mpLive) return; // no live game to hot-join — no-op
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
    const provider = providerCtx.get();
    const aw = provider?.awareness;
    const me = resolveLocalUserId();

    // Collect outstanding join-requests up front: a guest (incl. an anon/invite
    // viewer) signals intent to play by raising this flag. The arbiter — which
    // is the rack owner if present, else the lex-min member (so there is ALWAYS
    // an arbiter among the connected peers, even an all-anon rack) — seats them.
    const outstandingRequests: string[] = [];
    if (aw) {
      for (const [, state] of aw.getStates()) {
        const s = state as Record<string, unknown> | undefined;
        const req = s?.[joinReqField()];
        if (typeof req === 'string' && req.length > 0) outstandingRequests.push(req);
      }
    }

    // Multiplayer is opened EXPLICITLY (host clicks Host Multiplayer →
    // mpMode='multi') OR IMPLICITLY by any peer requesting to Join — the latter
    // is what lets an anon/invite guest actually join when the host hasn't (or
    // can't) press Host Multiplayer first (the operator's "anon sees the widget
    // but no working Join" bug: mpMode stayed undefined, so the roster never
    // opened). A request to play IS the decision to run MP. A host's "Single
    // Player" choice is only honoured on a genuinely SOLO rack. The moment
    // OTHER members are present, a launched game must be JOINABLE (the owner's
    // model: "others can Join IF a multiplayer game is running") — otherwise a
    // host who clicked Single Player (or whose game launched before anyone
    // joined) leaves every guest stuck on "Waiting…" with no working Join,
    // forever (the round-6 deadlock fix). So with members present we always
    // default to multiplayer.
    const wantsMp = shouldOpenMultiplayer({
      mpMode,
      memberCount: memberIds.length,
      outstandingRequests: outstandingRequests.length,
      rosterSize: rosterSize(combinedRoster(cur)),
      hostLaunched: launched,
    });
    if (!wantsMp) return; // solo rack with host on single, or nobody wants MP yet
    // Persist mpMode='multi' (once) so EVERY peer's Join affordance + lobby UI
    // converges, including the requester that triggered this.
    if (mpMode !== 'multi') {
      mpMode = 'multi';
      writeNodeMpMode('multi');
    }

    // Gather requesters: every member with a raised join-request flag, plus
    // the arbiter itself (the arbiter is always player 0 in a multiplayer
    // session; owner-first slot assignment puts the rack owner — or, in an
    // all-anon rack, the lex-min arbiter — at slot 0).
    const requesters = new Set<string>([me, ...outstandingRequests]);
    // Only honour requests from live members (a stale flag from a departed
    // peer must not consume a slot).
    const live = new Set(memberIds);
    const filtered = [...requesters].filter((uid) => live.has(uid) || uid === me);

    // HOT-DROP (operator request): a peer joining mid-level should be playing
    // the CURRENT map within seconds — NOT seated as a next-map reservation
    // (the old slice-6 PENDING behaviour). DOOM has no true mid-level join
    // (the player set is fixed at G_InitNew and the demo/lockstep tic stream
    // assumes a constant playeringame[]), so we take the pragmatic route the
    // brief calls for: seat the joiner as an ACTIVE player and have the arbiter
    // immediately RE-LAUNCH the current map (same skill/episode/map) with the
    // larger numPlayers. Every peer's onGameStart reloads the level via
    // G_InitNew, so the new player spawns at its coop start in the current map
    // (a fast ~1-2s reload) instead of waiting for the next map.
    //
    // So we ALWAYS assign new joiners ACTIVE (gameInProgress=false), and detect
    // below whether a brand-new active player appeared while a level was
    // running → trigger the hot-drop relaunch. (PENDING is still produced by
    // assignSlots for callers that ask for it, but the live game path no longer
    // routes there.)
    const wasInProgress = isGameInProgress();
    const beforeActiveIds = new Set(Object.values(cur.active));
    // SLOT-0 STABILITY (the "P1 becomes P2" flip): the arbiter is the rack host
    // and MUST own slot 0. assignSlots seats owner-first, but its owner signal is
    // resolveOwnerIds() — an awareness read of `user.isRackOwner` that can be
    // momentarily EMPTY at the exact instant a guest's join-request lands (a
    // fresh-connect/relay-backfill gap). If it is empty when BOTH the host and a
    // lex-SMALLER guest are unseated requesters in the same pass, pure lex order
    // hands slot 0 to the guest and bumps the host to slot 1 — the host's own
    // consoleplayer flips to 1 (P1→P2) and its marine appears to "freeze" because
    // it is now driving (and the relaunch reloads it as) the wrong slot. We know
    // authoritatively, without any awareness read, that THIS peer is the arbiter
    // (this function early-returns otherwise) and therefore the session leader →
    // slot 0. So we always include `me` in the owner set fed to assignSlots. This
    // is correct for an OWNED rack (the host is the owner) AND an anon rack (the
    // arbiter is the deterministic lex-min leader, which still rightly takes slot
    // 0). Union with the awareness owners so a DIFFERENT confirmed owner (should
    // never happen for the arbiter, but defensive) is still respected.
    const ownerIds = [...new Set([me, ...resolveOwnerIds()])];
    const { state: next, changed } = assignSlots(
      cur,
      filtered,
      false, // seat ACTIVE even mid-level — hot-drop, not next-map reservation
      ownerIds,
    );
    if (changed) {
      writeNodeRosterState(next);
      roster = next.active;
      pending = next.pending;
      // Round 5: a new ACTIVE player was added while a level is running →
      // AUTOMATIC hot-drop. The arbiter re-launches the current map so the
      // joiner spawns into it now (no manual host Launch step). This is the
      // one-click hot-join: the guest's Join raised a request, the arbiter
      // seated it active here, and this relaunch admits it within ~1-2s.
      const addedActive = Object.values(next.active).some(
        (uid) => !beforeActiveIds.has(uid),
      );
      if (
        shouldHotJoinRelaunch({
          isArbiter: isSessionArbiter(),
          gameInProgress: wasInProgress,
          addedActivePlayer: addedActive,
        })
      ) {
        hotDropRelaunchCurrentMap();
      }
    }
  }

  /** Hot-drop relaunch: re-broadcast the CURRENT map's settings with the new
   *  (larger) active roster so every peer — including the just-seated joiner —
   *  reloads the level via G_InitNew and the joiner spawns into the map within
   *  ~1-2s. Arbiter-only (single writer / single broadcaster). The settings are
   *  rebuilt from the dialog state, which applyGameStart keeps mirrored to
   *  whatever is currently running, so the map/skill/episode are unchanged —
   *  only numPlayers grows. */
  function hotDropRelaunchCurrentMap(): void {
    if (!isSessionArbiter()) return;
    if (mySlot === null) return;
    const settings = buildSettings(); // numPlayers now includes the joiner
    if (netcode) {
      netcode.broadcastGameStart(settings);
    } else {
      applyGameStart({ launchId: Date.now(), settings });
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
    // P1: tear down the lockstep transport + disarm the engine barrier so a
    // dropped/spectating peer doesn't keep a stale barrier armed.
    const ex = getExtras();
    try { ex?.setLockstep(false); } catch { /* runtime may be gone */ }
    lockstep = null;
    lockstepActive = false;
    lockstepNextTic = 0;
    lockstepAppendedThru = -1;
    // Drop our consolidated-tic floor field so we don't pin a future floor at a
    // stale value after we've left the game (issue #348).
    clearConsolidatedTicAwareness(lockstepGeneration);
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
    // Round 5: refresh the host-authoritative "MP is live" flag. The host is
    // the writer (refreshMpLiveAsHost), so it keeps its own computed value;
    // guests adopt whatever the host published.
    if (!isHost) mpLive = readNodeMpLive();
    const me = resolveLocalUserId();
    const prevSlot = mySlot;
    mySlot = slotForUser(cur.active, me);
    myPendingSlot = slotForUser(cur.pending, me);
    if (mySlot === null && myPendingSlot === null) {
      // We left / were pruned / are a pure spectator: drop netcode + any
      // stashed launch (we'll never become active, so there's nothing to
      // re-apply).
      pendingLaunch = null;
      stopNetcode();
    } else {
      // We're a player (active) OR a pending late joiner. Ensure our own WASM
      // is loading (a returning/late player whose slot is already in the
      // synced roster never clicked Join), then bring up netcode once the
      // runtime exists. A pending peer runs netcode to catch the next-map
      // launch but does NOT drive a marine until promoted (mySlot stays null).
      if (loadStatus === 'idle') void tryLoad();
      startNetcodeIfNeeded();
      // We just gained (or changed) an ACTIVE slot and a launch is stashed
      // (the GAMESTART beat the roster sync) → apply it now so this peer
      // actually enters the level as its own player instead of spectating.
      if (mySlot !== null && mySlot !== prevSlot && pendingLaunch) {
        applyGameStart(pendingLaunch);
      }
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
  // STICKY KEYBOARD LATCH (the kb-capture-keeps-dropping fix).
  //
  // Pre-fix shouldClaimKey() was computed live off the transient focus /
  // `.selected` state. Multiplayer awareness churn (frame broadcasts, roster
  // writes, host election, ticcmd feed) re-renders this node ~10×/s; each
  // re-render can momentarily drop the SvelteFlow `.selected` class and/or
  // steal focus, so shouldClaimKey() flickered false and keys stopped reaching
  // the game until the user re-clicked the card. It was WORST FOR THE HOST,
  // which churns the most (it broadcasts + does arbiter roster writes + relays
  // keys). And the window-blur releaseHeldKeys() then dumped held movement keys
  // on every such churn.
  //
  // Fix: an explicit latch. Clicking the card LATCHES keyboard control to DOOM;
  // it stays latched (independent of focus / `.selected`) until an EXPLICIT
  // release — Escape, a real click-away (mousedown outside the card), or a true
  // app/tab switch (document.hidden). Transient re-render blur no longer drops
  // capture or releases held keys.
  let kbLatched = $state(false);
  // Mirror image of the latch: an EXPLICIT release (Escape / click-away /
  // tab-hide) sets this and it OVERRIDES the focus / `.selected` fallback
  // below. Without it, Escape only dropped `kbLatched` but the node is still
  // SvelteFlow-selected (Esc doesn't deselect), so shouldClaimKey() kept
  // claiming via (c) and keys still reached DOOM — i.e. Escape wasn't a clean
  // hand-back and you stayed stuck capturing. Cleared on the next click
  // (latchKeyboard), which is the natural re-engage gesture.
  let kbReleased = $state(false);

  // INPUT-MODE SWITCH (owner-approved): a DOOM node is driven by EITHER
  // CV-gate jacks OR the keyboard, never both. If ANY of this node's
  // CV-gate inputs (up/down/left/right/space/ctrl/alt) has an incoming
  // edge, the node is "patched" → CV owns movement and the keyboard
  // capture is inert (we never claim keys, so the sticky-latch / focus /
  // `.selected` complexity below is short-circuited). Only when NO
  // CV-gate input is patched does the keyboard path run.
  //
  // Recomputes when cables are added/removed. NOTE the edge set lives in a
  // SyncedStore-over-Yjs proxy (patch.edges), which is NOT a Svelte $state rune
  // — reading `patch.edges` inside a $derived does NOT register a Svelte
  // dependency, so the old `void Object.keys(patch.edges).length` touch never
  // re-ran when a cable was patched (the edge arrives via Yjs, not a Svelte
  // signal). That was Bug 4: patching a CV gate did not flip cvGatePatched, so
  // shouldClaimKey() never went inert and the keyboard kept driving DOOM. Fix:
  // bump a real $state signal (edgesVersion) from a Yjs edges-map observer
  // (attachEdgesObserver) and key the $derived on it, so it recomputes on every
  // edge add/remove. The actual predicate is the pure `isCvGatePatched`.
  let edgesVersion = $state(0);
  // PER-SLOT (#353): the keyboard-vs-CV precedence is now per OWN slot. The card
  // goes keyboard-inert only when THIS viewer's own slot group (p{mySlot+1}_*)
  // has a CV edge — another player's CV must not gate your keyboard. A spectator
  // (mySlot null) is never CV-patched (owns no group), so it keeps its keyboard
  // relay path. cvGatePatched depends on both the edge set and mySlot.
  let cvGatePatched = $derived<boolean>(
    (void edgesVersion, isOwnSlotCvGatePatched(Object.values(patch.edges), id, mySlot)),
  );

  // When a CV-gate cable is plugged WHILE keyboard keys are held, the
  // keyboard path goes inert mid-hold and would never deliver the keyup —
  // leaving the key stuck down in the WASM queue. Release everything held
  // the instant we flip into CV-only mode (and drop the sticky latch so a
  // later unpatch re-engages cleanly via a fresh click).
  $effect(() => {
    if (cvGatePatched) {
      kbLatched = false;
      releaseHeldKeys();
    }
    // Bug 4 HARD enforcement: gate the keyboard at the RUNTIME boundary, not
    // just the window listener. `shouldClaimKey()` short-circuits the JS
    // keydown/keyup capture, but the runtime is shared with the CV-gate path
    // and an in-flight / OS-swallowed / autorepeat keypress (or any future
    // caller) could still reach `setKeyForKeyboardCode`. Driving the runtime's
    // keyboard-inert flag makes the keyboard truly inert while patched (and
    // releases any keyboard-origin key still asserted in DOOM's gamekeydown[]
    // so the marine can't keep walking), while the CV path stays live.
    getExtras()?.setKeyboardInert(cvGatePatched);
  });

  // OWN-SLOT-ONLY CV routing (#353 Phase 2): tell the factory which slot this
  // peer drives so the CV-gate path applies ONLY this slot's input group and
  // ignores every other slot's CV locally (the deterministic, lockstep-safe
  // rule). A spectator/unseated peer (mySlot null) drives no slot's CV. Re-runs
  // whenever mySlot changes (join / promotion / drop) — getExtras() is null
  // until the runtime exists, so we also re-apply on load via ensureLoaded's
  // render-loop re-evaluation; this effect catches the steady-state changes.
  $effect(() => {
    getExtras()?.setOwnSlot(mySlot);
  });

  function shouldClaimKey(): boolean {
    if (!cardEl) return false;
    // Patched ⇒ CV-only. A CV-gate cable owns movement; the keyboard is
    // inert (so we don't fight the CV edge-detector or double-drive the
    // game). Unpatched ⇒ the keyboard path below runs as before.
    if (cvGatePatched) return false;
    // a) Latched: the user clicked the card to take keyboard control + has not
    //    explicitly released it. This is the sticky path — it does NOT depend
    //    on the transient focus / `.selected` state that sync churn toggles.
    if (kbLatched) return true;
    // a') Explicitly released (Escape / click-away / tab-hide): hand the
    //     keyboard back even though the node may still be focused/selected.
    //     Re-engage requires a fresh click (which clears this).
    if (kbReleased) return false;
    // b) Focus-within: any descendant (incl. the card itself) is
    //    document.activeElement.
    if (cardEl.contains(document.activeElement)) return true;
    // c) SvelteFlow marks the selected node wrapper with .selected. The
    //    card mounts INSIDE that wrapper, so we walk up + check.
    const sfNode = cardEl.closest('.svelte-flow__node');
    if (sfNode?.classList.contains('selected')) return true;
    return false;
  }

  /** Take keyboard control (sticky). Called on a click anywhere on the card. */
  function latchKeyboard(): void {
    kbLatched = true;
    kbReleased = false;
  }
  /** Release keyboard control + drop any held keys. Called on an EXPLICIT
   *  release only: Escape, a real click-away, or a genuine app/tab switch —
   *  never on a transient re-render blur. Always sets the released flag (even
   *  when we were claiming via focus/`.selected` rather than the latch) so the
   *  gesture is a clean hand-back regardless of how control was held. */
  function unlatchKeyboard(): void {
    kbLatched = false;
    kbReleased = true;
    releaseHeldKeys();
  }
  /** A genuine pointer-down OUTSIDE this card releases the latch (click-away).
   *  A pointer-down INSIDE keeps it (and latchKeyboard re-asserts it anyway). */
  function onPointerDownCapture(ev: PointerEvent): void {
    if (!kbLatched) return;
    const t = ev.target as Node | null;
    if (cardEl && t && cardEl.contains(t)) return; // click inside — stay latched
    unlatchKeyboard();
  }

  function routeKey(code: string, pressed: boolean): boolean {
    const extras = getExtras();
    if (!extras) return false;
    // An ACTIVE player (host OR a joined guest at its own slot) drives its OWN
    // runtime — every player runs their own WASM + POV in the per-peer instance
    // model, so the key must reach the local sim, NOT be relayed to the host.
    // Pre-fix only `isHost` pushed locally and EVERY non-host (incl. a joined
    // P2) relayed to the host instead, so a guest player's marine never moved
    // from its own keyboard (the operator's "neither player can move" bug, for
    // the guest). Only a pure spectator (no slot) relays its keys.
    if (isHost || mySlot !== null) {
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
  /** Modifier-state reconciliation: on every keyboard event, if our tracker
   *  thinks a modifier is held but the event reports it UP, release it (route
   *  the keyup into the game). Catches the swallowed-keyup case (macOS
   *  screenshot shortcut holds Ctrl, fires no blur/visibility, and eats the
   *  keyup → the gun fires forever). Only ever releases MODIFIERS, never
   *  movement keys, so it does not reintroduce the round-4 movement-dump bug.
   *  Run BEFORE the down/up bookkeeping so a release for THIS event's own key
   *  (e.g. an actual Ctrl keyup) is handled normally afterward. */
  function reconcileHeldModifiers(ev: KeyboardEvent): void {
    heldKeys.reconcileModifiers({
      ctrl: ev.ctrlKey,
      alt: ev.altKey,
      shift: ev.shiftKey,
      meta: ev.metaKey,
    });
  }
  function onWindowKeyDownCapture(ev: KeyboardEvent): void {
    reconcileHeldModifiers(ev);
    if (!shouldClaimKey()) return;
    // Escape is the explicit "give back the keyboard" gesture for the sticky
    // latch — release control + drop held keys, and let the event through (do
    // NOT preventDefault) so normal Esc behaviour still works.
    if (ev.code === 'Escape') {
      unlatchKeyboard();
      return;
    }
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
    // Reconcile first: a keyup whose own modifier the OS already dropped (or a
    // keyup for some OTHER key that reveals a previously-swallowed modifier
    // release) frees any stuck modifier here too.
    reconcileHeldModifiers(ev);
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
  // A genuine app/tab switch (the page is actually hidden) releases the latch +
  // drops held keys — an alt-tab away delivers no keyup, so anything held would
  // otherwise stick down. We use visibilitychange (real hide) rather than the
  // raw window 'blur' event, which also fires on transient re-render focus
  // churn + would spuriously dump held movement keys during multiplayer sync.
  function onVisibilityChange(): void {
    if (document.hidden) unlatchKeyboard();
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
  let awarenessOff: (() => void) | null = null;
  // Edge-trigger cursor for the host-side key relay: last key-envelope ts
  // relayed per source clientID. Without this, the host re-pushes a remote
  // client's still-present key field on every awareness update (host election /
  // cursor / presence churn) — a held/stale DOWNARROW then reads as the player
  // being shoved backward continuously with no key pressed. See
  // doom-presence.ts → collectIncomingKeyPushes.
  const keyRelayCursor: RelayCursor = new Map();

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
      // Read all clients' "I am host for module X" claims; used ONLY as the
      // sticky current-host hint for the anon-rack fallback inside
      // decideHostRole. It is NEVER what decides an OWNED rack — that comes
      // from reliable LOCAL ownership, so a guest can't elect itself off a
      // stale/empty claim set (the split-brain root).
      const candidates: string[] = [];
      states.forEach((s) => {
        const host = (s as Record<string, unknown>)[myField];
        if (typeof host === 'string') candidates.push(host);
      });
      const currentHost = candidates.length > 0 ? candidates.sort()[0]! : null;
      // SPLIT-BRAIN-PROOF host authority: trust what THIS client knows about
      // ITSELF (resolveLocalOwnership) over any awareness count. A confirmed
      // owner is host unconditionally; a confirmed guest is NEVER host (it
      // waits for the owner even if its own awareness shows only itself); only
      // a genuinely anon rack falls back to the deterministic lex-min election.
      const decision = decideHostRole({
        localUserId: me,
        localIsOwner: resolveLocalOwnership(),
        currentHost,
        members: ids,
        ownerIds: resolveOwnerIds(),
      });
      isHost = decision.role === 'host';
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

    // STORM THROTTLE (the multiplayer-hang fix). DOOM writes each joined peer's
    // ticcmd to awareness every tic (~35 Hz/player); 2 players ≈ 70 awareness
    // `update` events/sec. The election/roster/slot/identity machinery below is
    // EXPENSIVE and depends ONLY on slow-changing fields (membership, ownership,
    // host-claim, join-request, displayName) — never on the per-tic ticcmd /
    // relay / signaling / key fields. So we compute a cheap signature of just
    // those election-relevant fields and run the heavy recompute ONLY when it
    // actually changed. A pure ticcmd update => signature unchanged => zero
    // election work. This bounds the observer's per-second cost regardless of
    // tic rate (was the root cause of both tabs hanging under active play).
    //
    // The cheap, already-edge-triggered key relay (onIncomingKey, deduped on
    // its own cursor) still runs every update — it is what delivers spectator
    // keypresses and must not be throttled, but it is O(states) + no writes.
    let lastElectionSig: string | null = null;
    const runElectionRecompute = (): void => {
      recomputeHost();
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
      bumpElectionRecompute(id);
    };
    const update = (): void => {
      // Always run the cheap edge-triggered spectator-key relay.
      onIncomingKey();
      // Only run the expensive election/roster pass when an election-relevant
      // awareness field actually changed — NOT for the per-tic ticcmd storm.
      const sig = electionAwarenessSignature(
        aw!.getStates() as Map<number, Record<string, unknown> | undefined>,
        id,
      );
      bumpAwarenessUpdate(id);
      if (sig === lastElectionSig) return;
      lastElectionSig = sig;
      runElectionRecompute();
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

    // NO framebuffer broadcast. The host used to push its ~1.4 MB framebuffer
    // into a `doom:<id>:frame` awareness field at ~10 Hz so unjoined spectators
    // could mirror its screen; the Hocuspocus relay fans + buffers awareness in
    // process memory, so that ~13.7 MB/s firehose OOM-killed the relay (exit
    // 137) → rack freeze + lost-node-on-rejoin. The path is removed: an unjoined
    // spectator shows the DOOM attract/black screen until it JOINS and runs its
    // own per-peer WASM. Awareness now carries only tiny fields.
  }

  function detachAwareness(): void {
    if (awarenessOff) {
      try { awarenessOff(); } catch { /* */ }
      awarenessOff = null;
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
        // Host-stuck-on-menu fix: if a launch arrived before our WASM was
        // ready (the arbiter self-fires synchronously inside Launch), keep
        // retrying until the C side enters GS_LEVEL.
        retryPendingLaunchIfNeeded();
        const ex = getExtras();
        if (ex) gamestate = ex.getGameState();
        if (lockstepActive) {
          // P1 TRUE LOCKSTEP path: append our per-tic ticcmd to the shared
          // ordered log + drain complete consolidated TicSets into the WASM
          // barrier. The sim advances only over complete TicSets and pauses
          // (never spins) when starved — shared state, not an input overlay.
          // Replaces the slice-5 broadcast + #339 reinject band-aid here.
          pumpLockstep();
        } else {
          // Non-lockstep (lone player / legacy free-run): slice-5 last-value
          // awareness overlay + #339 gap-fill. Kept so single-player + any
          // non-lockstep usage is unchanged.
          broadcastLocalTiccmd();
          reinjectRemoteTiccmds();
        }
      }
      // Round 5: the host publishes the "MP is live" flag every frame (the
      // write is a no-op unless it actually flipped) so a guest's Join button
      // enables the instant the host enters GS_LEVEL and disables at
      // intermission / game end. Cheap: one node read + an early-out.
      refreshMpLiveAsHost();
      if (canvasEl) {
        const ctx2d = canvasEl.getContext('2d');
        if (ctx2d) {
          // Pull straight from THIS peer's own live runtime. A joined player
          // (or lone host) has a runtime → its own POV. A pure unjoined
          // spectator never loaded WASM → snapshotFramebuffer() is null → the
          // preview canvas stays black (the DOOM attract screen) until it
          // JOINS. There is no host-framebuffer mirror to fall back to anymore
          // (relay-OOM fix).
          const extras = getExtras();
          const fb: Uint8Array | Uint8ClampedArray | null =
            extras ? extras.snapshotFramebuffer() : null;
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

  // Bug 4 fix: observe the shared EDGES map so a cable add/remove (which
  // arrives via Yjs, NOT a Svelte signal) bumps a real $state — the only thing
  // the cvGatePatched $derived can track. Without this, patching a CV-gate jack
  // never flipped the card into CV-only mode and the keyboard kept driving the
  // game. observeDeep also catches a far-side patch in a multiplayer rack.
  let edgesObserver: (() => void) | null = null;
  function attachEdgesObserver(): void {
    const edgesMap = ydoc.getMap('edges');
    const handler = (): void => { edgesVersion++; };
    edgesMap.observeDeep(handler);
    edgesObserver = () => edgesMap.unobserveDeep(handler);
    // Seed once in case edges are already present at mount (loaded patch).
    edgesVersion++;
  }
  function detachEdgesObserver(): void {
    if (edgesObserver) {
      try { edgesObserver(); } catch { /* */ }
      edgesObserver = null;
    }
  }

  // ---- Mount / unmount ----
  onMount(() => {
    startRenderLoop();
    // Auto-attach awareness if a provider is present (multi-user rack);
    // single-user `/` canvas skips quietly.
    attachAwareness();
    attachNodesObserver();
    attachEdgesObserver();
    // Capture-phase window listeners (see header). Per-card instance,
    // not module-global — if there were ever >1 DOOM card on the rack
    // (maxInstances:1 prevents that today, but defensively…) each card
    // checks shouldClaimKey() on its own cardEl + the SF node it sits
    // inside, so only the focused/selected one actually claims keys.
    window.addEventListener('keydown', onWindowKeyDownCapture, true);
    window.addEventListener('keyup', onWindowKeyUpCapture, true);
    // Click-away releases the sticky keyboard latch (capture phase so we see it
    // before SvelteFlow's own pointer handling). A pointer-down INSIDE the card
    // keeps the latch.
    window.addEventListener('pointerdown', onPointerDownCapture, true);
    // A real app/tab switch (page actually hidden) releases the latch + held
    // keys. We deliberately do NOT listen to the raw window 'blur' event: it
    // also fires on transient re-render focus churn during multiplayer sync,
    // which would spuriously drop held movement keys (the operator's
    // "controls keep dropping" symptom).
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
      // e2e keyboard-claim hook: invoke the SAME sticky latch the card's
      // "Click to capture keyboard" onclick fires (latchKeyboard), WITHOUT a
      // DOM click/focus. A real user clicks to capture; that path is unchanged.
      // This exists because in a 2-context Playwright test only one page holds
      // focus/activeElement — a click+focus-based capture is unreliable for the
      // backgrounded page (shouldClaimKey()'s focus branch flickers false, the
      // dispatched keydown is dropped, and the marine never moves). Calling the
      // latch directly flips kbLatched=true, which shouldClaimKey() honours
      // regardless of focus/foreground, so input routing is deterministic in
      // BOTH contexts. Dev-only (this whole __doomCards hook is stripped in
      // prod); does not change real input/capture behaviour.
      forceClaimKeyboard: () => latchKeyboard(),
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
      // P1 e2e hooks: the deterministic state digest (the SHARED-STATE oracle —
      // two lockstepped peers MUST agree) + the engine tic counters so a test
      // can wait for both sims to reach the same tic before comparing.
      stateChecksum: () => {
        const ex = getExtras();
        return ex ? ex.stateChecksum() : 0;
      },
      getTics: () => {
        const ex = getExtras();
        return ex
          ? { maketic: ex.getMaketic(), gametic: ex.getGametic(), recvtic: ex.getRecvtic() }
          : { maketic: 0, gametic: 0, recvtic: 0 };
      },
      // P1 diagnostic: shared-log size (so a test can see whether both peers'
      // appends are landing in the SAME ordered log).
      getLockstepLogSize: () => (lockstep ? lockstep.size() : -1),
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
        // Round 5: the host-authoritative "MP is live" flag a guest reads to
        // enable/disable Join (host in a multi session, in-level). The real
        // 2-user e2e asserts a guest's Join is disabled until this is true.
        mpLive,
        ownerIds: resolveOwnerIds(),
        netcodePeers: netcode ? netcode.debugStats().peers : [],
        launched,
        lockstepActive,
        gamestate,
        // New Game dialog selections (the custom dropdowns write these). The
        // mouse-pick e2e asserts a non-default MODE/SKILL took effect by
        // reading them here (the native <select> DOM the old test scraped is
        // gone — replaced by the SF-friendly custom dropdown).
        mode,
        skill,
        episode,
        mapNum,
        // Slice 5 identity (badge + color + label) for e2e assertions.
        slotColor: slotTint,
        badgeText,
        identityLabel,
        username: myUsername,
        // Slice 6 spectator/pending affordance text.
        specLabel,
        specBadge,
        // Storm-throttle counters (multiplayer-hang guard): total awareness
        // updates vs. how many actually triggered the expensive election/roster
        // recompute. The probe samples these per-second to prove the heavy work
        // stays bounded under the per-tic ticcmd flood.
        awarenessUpdateCount: readCounters(id).awarenessUpdateCount,
        electionRecomputeCount: readCounters(id).electionRecomputeCount,
        // Real awareness-write rate driver (post-suppression). The probe
        // samples this to measure the genuine per-tic ticcmd write rate.
        ticcmdWriteCount: readCounters(id).ticcmdWriteCount,
        // CV-gate input mode (Bug 4 guard): true => keyboard is inert (CV owns
        // movement). The probe asserts this flips when a CV gate is patched.
        cvGatePatched,
        shouldClaimKey: shouldClaimKey(),
      }),
    };
  });

  onDestroy(() => {
    const g = globalThis as unknown as { __doomCards?: Record<string, unknown> };
    if (g.__doomCards) delete g.__doomCards[id];
    stopRenderLoop();
    detachAwareness();
    detachNodesObserver();
    detachEdgesObserver();
    stopNetcode();
    releaseHeldKeys();
    window.removeEventListener('keydown', onWindowKeyDownCapture, true);
    window.removeEventListener('keyup', onWindowKeyUpCapture, true);
    window.removeEventListener('pointerdown', onPointerDownCapture, true);
    document.removeEventListener('visibilitychange', onVisibilityChange);
  });

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
  onclick={() => { cardEl?.focus(); latchKeyboard(); }}
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
    {:else if mySlot !== null}
      <!-- An ACTIVE joined player that is NOT the rack host is a PLAYER, not a
           spectator. Pre-fix this branch unconditionally rendered SPEC for any
           non-host, so a joined guest (P2) was mis-badged SPEC while in-level.
           Show a slot-tinted PLAYER badge instead. -->
      <span
        class="player-status-badge"
        style="background: {slotTint};"
        title="You are playing as {identityLabel}"
      >PLAYER</span>
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
      <button class="overlay nodrag" onclick={() => void tryLoad()}>
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
    {#if loadStatus === 'ready' && !kbLatched}
      <button
        type="button"
        class="focus-hint nodrag"
        onclick={() => { cardEl?.focus(); latchKeyboard(); }}
      >
        Click to capture keyboard
      </button>
    {/if}
  </div>

  <!-- PER-VIEWER UI HIDING (#353 Phase 3): ALL four slot groups' input handles
       (p1..p4 → 28 jacks) are ALWAYS rendered into the DOM so the rendered
       handle set matches the def (io-spec / modules invariant) AND a cross-peer
       cable into e.g. p2_up still resolves to a real handle position and renders
       as a cable on a peer whose own slot is p1. We only VISUALLY emphasise the
       LOCAL viewer's own slot group (p{mySlot+1}_*) — the OTHER slots' handles
       are present-but-hidden (visibility:hidden, pointer-events:none) via the
       .hidden-slot-port class, so they can't be (dis)connected from this card
       yet still anchor incoming edges. A spectator / unseated peer (mySlot null)
       emphasises no group (read-only) but every handle is still in the DOM.
       This is purely a rendering concern — input DISPATCH is unchanged: the
       factory's own-slot-only rule (setOwnSlot) means a peer only ever feeds its
       OWN consoleplayer slot's CV into the sim. -->
  {#each DOOM_MP_SLOTS as slot (slot)}
    {@const isLocalSlot = slot === mySlot}
    {#each CV_GATE_PORT_IDS as base, idx (base)}
      {@const top = 56 + idx * 28}
      {@const portId = cvGatePortIdForSlot(slot, base as CvGatePortId)}
      {@const label = base === 'up' ? '↑'
                    : base === 'down' ? '↓'
                    : base === 'left' ? '←'
                    : base === 'right' ? '→'
                    : base.toUpperCase()}
      <Handle
        type="target"
        position={Position.Left}
        id={portId}
        data-testid="doom-port-{portId}"
        class={isLocalSlot ? undefined : 'hidden-slot-port'}
        style="top: {top}px; --handle-color: var(--cable-cv);"
      />
      {#if isLocalSlot}
        <span class="port-label left" style="top: {top - 6}px;">{label}</span>
      {/if}
    {/each}
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
    <div class="start-choice nodrag" data-testid="doom-start-choice">
      {#if memberIds.length <= 1}
        <!-- Single Player is offered ONLY on a solo rack. With other members
             present a launched game must be joinable (the owner's model), so we
             don't offer a choice that would strand them on "Waiting…" — the
             host starts a multiplayer session instead (deadlock fix). -->
        <button
          class="start-btn nodrag"
          data-testid="doom-start-single"
          onclick={() => void playSinglePlayer()}
          title="Play DOOM solo (no netgame)"
        >
          Single Player
        </button>
      {/if}
      <button
        class="start-btn primary nodrag"
        data-testid="doom-start-multi"
        onclick={() => void hostMultiplayer()}
        title="Open a multiplayer lobby — you are player 1; rack-mates can Join"
      >
        Host Multiplayer
      </button>
    </div>
  {/if}

  <div class="controls-row">
    {#if !isHost}
      <!-- Round 5: a non-host guest ALWAYS sees the Join button, but it is
           DISABLED unless the host is currently running a multiplayer game
           (mpLive — a host-authoritative Yjs-synced flag, not inferred from
           racy awareness). The disabled state reads "Waiting for host to start
           a multiplayer game…". When MP is live, Join is enabled and a click
           is a ONE-CLICK HOT-JOIN: the arbiter seats the guest active +
           auto-relaunches the current map so the guest drops in within ~1-2s.
           The host never sees a Join button (it's already P1). Already-seated
           peers don't either (joinAffordance returns show:false). -->
      {@const full = isFull(combinedRoster({ active: roster, pending }))}
      {@const join = joinAffordance({
        isHost,
        alreadySeated: mySlot !== null || myPendingSlot !== null,
        full,
        mpLive,
      })}
      {#if join.show}
        <button
          class="join-btn nodrag"
          data-testid="doom-join-btn"
          disabled={!join.enabled}
          onclick={() => void joinGame()}
          title={join.reason}
        >
          {join.label}
        </button>
        {#if !join.enabled && !full}
          <span class="join-waiting" data-testid="doom-join-waiting">{join.reason}</span>
        {/if}
      {/if}
    {/if}
  </div>

  {#if mpMode === 'multi' && mySlot !== null}
    {@const inLevel = launched && gamestate === GS_LEVEL}
    {@const atIntermission = launched && gamestate === GS_INTERMISSION}
    {@const pendingCount = rosterSize(pending)}
    <!-- nodrag on the whole dialog: SvelteFlow treats a node as draggable, so a
         mousedown anywhere inside starts a node-drag + swallows the click
         unless the target carries the noDragClassName ('nodrag'). The
         mode/skill/episode/map pickers are CUSTOM dropdowns (a nodrag button +
         a nodrag option list in normal DOM) rather than native <select>s,
         because the OS-rendered native popup is not reliably openable inside a
         SvelteFlow node — SF's pointer capture on mousedown fights the popup
         even with `nodrag` (the operator's "MODE/SKILL selects won't open by
         mouse" bug). A plain click on a custom-dropdown option selects it with
         no native popup + no SF interference. -->
    <div class="newgame nodrag" data-testid="doom-newgame">
      {#if isSessionArbiter()}
        <!-- Arbiter (host = player 0): pick mode/skill/episode/map + Launch.
             Locked while a level is actively running; re-opens at the end of
             the level (intermission / finale) to pick the next map. -->
        <div class="ng-row">
          <div class="ng-field">
            <span class="ng-label">Mode</span>
            <div class="dropdown nodrag" data-testid="doom-mode" data-value={mode}>
              <button
                type="button"
                class="dd-trigger nodrag"
                data-testid="doom-mode-trigger"
                disabled={inLevel}
                onclick={() => toggleDropdown('mode')}
                title="Game mode"
              >
                <span>{mode}</span><span class="dd-caret">▾</span>
              </button>
              {#if openDropdown === 'mode'}
                <div class="dd-list nodrag" role="listbox">
                  {#each MODE_OPTIONS as m (m)}
                    <button
                      type="button"
                      class="dd-option nodrag"
                      class:selected={mode === m}
                      data-testid="doom-mode-opt-{m}"
                      onclick={() => { mode = m; closeDropdowns(); }}
                    >{m}</button>
                  {/each}
                </div>
              {/if}
            </div>
          </div>
          <div class="ng-field">
            <span class="ng-label">Skill</span>
            <div class="dropdown nodrag" data-testid="doom-skill" data-value={skill}>
              <button
                type="button"
                class="dd-trigger nodrag"
                data-testid="doom-skill-trigger"
                disabled={inLevel}
                onclick={() => toggleDropdown('skill')}
                title="Difficulty"
              >
                <span>{skill + 1} — {SKILL_LABELS[skill]}</span><span class="dd-caret">▾</span>
              </button>
              {#if openDropdown === 'skill'}
                <div class="dd-list nodrag" role="listbox">
                  {#each SKILL_LABELS as label, i (i)}
                    <button
                      type="button"
                      class="dd-option nodrag"
                      class:selected={skill === i}
                      data-testid="doom-skill-opt-{i}"
                      onclick={() => { skill = i; closeDropdowns(); }}
                    >{i + 1} — {label}</button>
                  {/each}
                </div>
              {/if}
            </div>
          </div>
        </div>
        <div class="ng-row">
          <div class="ng-field">
            <span class="ng-label">Ep</span>
            <!-- DOOM1 shareware ships episode 1 only; the picker offers 1-3
                 for full-WAD parity but clamps sensibly. -->
            <div class="dropdown nodrag" data-testid="doom-episode" data-value={episode}>
              <button
                type="button"
                class="dd-trigger nodrag"
                data-testid="doom-episode-trigger"
                disabled={inLevel}
                onclick={() => toggleDropdown('episode')}
                title="Episode"
              >
                <span>{episode}</span><span class="dd-caret">▾</span>
              </button>
              {#if openDropdown === 'episode'}
                <div class="dd-list nodrag" role="listbox">
                  {#each [1, 2, 3] as e (e)}
                    <button
                      type="button"
                      class="dd-option nodrag"
                      class:selected={episode === e}
                      data-testid="doom-episode-opt-{e}"
                      onclick={() => { episode = e; closeDropdowns(); }}
                    >{e}</button>
                  {/each}
                </div>
              {/if}
            </div>
          </div>
          <div class="ng-field">
            <span class="ng-label">Map</span>
            <div class="dropdown nodrag" data-testid="doom-map" data-value={mapNum}>
              <button
                type="button"
                class="dd-trigger nodrag"
                data-testid="doom-map-trigger"
                disabled={inLevel}
                onclick={() => toggleDropdown('map')}
                title="Map"
              >
                <span>{mapNum}</span><span class="dd-caret">▾</span>
              </button>
              {#if openDropdown === 'map'}
                <div class="dd-list nodrag" role="listbox">
                  {#each [1, 2, 3, 4, 5, 6, 7, 8, 9] as mp (mp)}
                    <button
                      type="button"
                      class="dd-option nodrag"
                      class:selected={mapNum === mp}
                      data-testid="doom-map-opt-{mp}"
                      onclick={() => { mapNum = mp; closeDropdowns(); }}
                    >{mp}</button>
                  {/each}
                </div>
              {/if}
            </div>
          </div>
          <button
            class="launch-btn nodrag"
            data-testid="doom-launch-btn"
            disabled={inLevel}
            onclick={() => { closeDropdowns(); launchGame(); }}
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
        <!-- Non-arbiter joined players: reflect the host-authoritative mpLive
             so we NEVER say "Waiting for host to start…" while the host is in
             fact in a live level (round-6 deadlock-copy fix). -->
        {@const waiting = guestWaitingState({ ownInLevel: inLevel, hostMpLive: mpLive })}
        <div class="ng-waiting" data-testid="doom-waiting">
          {#if waiting === 'in-level'}
            In level — playing as P{mySlot + 1}
          {:else if waiting === 'host-live-joining'}
            Host is in a game — joining…
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
  .doom-card .spec-badge,
  .doom-card .player-status-badge {
    margin-left: auto;
  }
  .doom-card .host-badge,
  .doom-card .spec-badge,
  .doom-card .player-status-badge,
  .doom-card .player-badge {
    font-size: 9px;
    font-weight: 700;
    padding: 2px 5px;
    border-radius: 2px;
    letter-spacing: 0.05em;
  }
  .doom-card .player-status-badge {
    /* background tinted inline by slot color */
    color: white;
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
  /* Round 5: "Waiting for host to start a multiplayer game…" copy shown
     beside the disabled Join button so the guest knows why it can't join. */
  .doom-card .join-waiting {
    font-size: 10px;
    font-style: italic;
    opacity: 0.8;
    color: color-mix(in oklab, var(--cable-video, #c33) 70%, white);
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
  /* Host's Single Player / Host Multiplayer choice (added in #314 but never
     styled). Sits below the canvas; pointer-events explicit so SvelteFlow's
     drag never beats the click (nodrag on the elements does the heavy lifting,
     this is belt-and-suspenders for the future ABUSE mouse module). */
  .doom-card .start-choice {
    display: flex;
    gap: 8px;
    padding: 0 10px 6px;
    pointer-events: auto;
  }
  .doom-card .start-btn {
    flex: 1;
    font-size: 11px;
    padding: 5px 8px;
    background: color-mix(in oklab, var(--cable-video, #c33) 25%, #181014);
    color: #eee;
    border: 1px solid color-mix(in oklab, var(--cable-video, #c33) 40%, transparent);
    cursor: pointer;
  }
  .doom-card .start-btn.primary {
    background: var(--cable-video, #c33);
    color: white;
    font-weight: 700;
  }
  .doom-card .start-btn:hover {
    filter: brightness(1.15);
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
  .doom-card .ng-field {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .doom-card .ng-label {
    font-size: 9px;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    opacity: 0.8;
  }
  /* Custom dropdown (replaces the native <select> that SvelteFlow's pointer
     capture wouldn't let open by mouse). */
  .doom-card .dropdown {
    position: relative;
  }
  .doom-card .dd-trigger {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 6px;
    min-width: 70px;
    font-size: 11px;
    padding: 3px 6px;
    background: #181014;
    color: #eee;
    border: 1px solid color-mix(in oklab, var(--cable-video, #c33) 40%, transparent);
    cursor: pointer;
    text-align: left;
    white-space: nowrap;
  }
  .doom-card .dd-trigger:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
  .doom-card .dd-caret {
    font-size: 8px;
    opacity: 0.7;
  }
  .doom-card .dd-list {
    position: absolute;
    top: calc(100% + 2px);
    left: 0;
    z-index: 30;
    display: flex;
    flex-direction: column;
    min-width: 100%;
    max-height: 180px;
    overflow-y: auto;
    background: #181014;
    border: 1px solid color-mix(in oklab, var(--cable-video, #c33) 50%, transparent);
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.5);
  }
  .doom-card .dd-option {
    font-size: 11px;
    padding: 4px 8px;
    background: transparent;
    color: #eee;
    border: none;
    cursor: pointer;
    text-align: left;
    white-space: nowrap;
  }
  .doom-card .dd-option:hover {
    background: color-mix(in oklab, var(--cable-video, #c33) 35%, #181014);
  }
  .doom-card .dd-option.selected {
    background: color-mix(in oklab, var(--cable-video, #c33) 55%, #181014);
    font-weight: 700;
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
  /* Non-local slot input handles: present in the DOM (so the rendered handle
     set matches the def + cross-peer cables into them still anchor + render as
     edges) but visually hidden and non-interactive on this viewer's card. We
     use visibility:hidden (not display:none) so the handle keeps a layout box
     and Svelte Flow can still resolve an edge endpoint position for it. */
  .doom-card :global(.svelte-flow__handle.hidden-slot-port) {
    visibility: hidden;
    pointer-events: none;
  }
  .doom-card .hint {
    padding: 0 10px 8px;
    color: color-mix(in oklab, var(--cable-video, #c33) 70%, transparent);
    font-size: 10px;
  }
</style>
