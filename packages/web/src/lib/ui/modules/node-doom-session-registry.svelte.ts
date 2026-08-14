// node-doom-session-registry.svelte.ts
//
// NODE-OWNED MULTIPLAYER SESSION LIFETIME — the registry that keeps a DOOM
// netgame alive when the CARD that started it goes away.
//
// THE BUG THIS EXISTS FOR (#1590, the last row of the #1583 audit). DoomCard
// ran, in `onDestroy`:
//
//     stopNetcode();      // netcode.stop() → closes every WebRTC peer
//                         // connection + `delete Module.PTNet` (unbinds the
//                         // C-side transport from the RUNNING WASM), disarms
//                         // the lockstep barrier, resets the tic cursors
//     stopRenderLoop();   // kills the rAF loop that is ALSO the lockstep PUMP
//
// A card unmounts on COLLAPSE, on dock LRU eviction when a third module is
// expanded, on ESC, on M/E, on navigation — none of which mean the player left
// the game. In a >1-player netgame the freeze is TOTAL and MUTUAL:
//
//   * The rAF pump was the only thing APPENDING this peer's per-tic ticcmds to
//     the shared Yjs lockstep log and DRAINING consolidated TicSets into the
//     WASM barrier. With it dead, every OTHER peer's barrier starves at the
//     next tic and their sims PAUSE — by design (#345: a DOOM freeze is a
//     consistency abort, the lockstep protocol stalling rather than desyncing).
//   * Locally, `setLockstep(false)` disarmed the barrier, so this peer's sim
//     (which the VIDEO ENGINE keeps ticking — the WASM is engine-owned and
//     never died) free-runs AWAY from the shared tic stream.
//   * On re-expand nothing recovered: `launched`/generation/cursors were card
//     $state, so the fresh mount came up idle; the sticky GAMESTART envelope
//     re-fired into a mid-game world (G_InitNew reload at tic 0 against peers
//     at tic N, whose log prefix the arbiter has long pruned). Unrecoverable.
//
// ── THE SHAPE OF THE FIX (5th member of the family: #1531 / #1574 / #1588 /
//    #1590-audioIn) ────────────────────────────────────────────────────────
// The SESSION belongs to the NODE. This registry owns, per node id:
//
//   * the DoomNetcode instance (WebRTC data channels + the WASM's
//     Module.PTNet binding),
//   * the LockstepTransport + every tic cursor + the launch generation,
//   * the session flags a remount must not lose (`launched`, the pending and
//     last-applied GAMESTART envelopes),
//   * THE PUMP LOOP itself — a registry-driven frame loop that keeps calling
//     the session pump while no card exists.
//
// The card ADOPTS and READS. Its closures (election, roster writes, the
// lockstep pump body, netcode event handling) are registered as WIRING; the
// registry keeps the last mount's wiring running after the card unmounts and
// swaps it atomically when a new mount adopts. Because the netcode object
// outlives any mount, its constructor callbacks must never capture one mount's
// closures — they are TRAMPOLINES through `dispatch(id)`, which always
// resolves the CURRENT wiring.
//
// ⚠ THE STRUCTURAL GUARD IS THE ABSENCE OF A CARD-LIFECYCLE METHOD. There is
// no `dispose(id)`, no `teardown(id)`, no `onCardUnmount(id)` — a future
// `onDestroy` cannot re-introduce this defect by calling one, because `tsc`
// refuses the call before a test ever runs. The two legitimate releases are:
//   * `leaveGame(id)` — the USER's intent (this peer lost/gave up its seat:
//     pruned from the roster, became a spectator). Named for the user's
//     action, not the component's lifecycle.
//   * `sweep(liveNodeIds)` — GRAPH lifetime, called from Canvas beside its
//     five sibling registries. A node deleted by ANY route (menu, lasso,
//     undo, a peer's CRDT delete, Clear, a patch load) releases here.
// The unit test asserts that distinction from both directions.
//
// WHAT THIS REGISTRY DELIBERATELY DOES NOT OWN: the WASM runtime (engine-owned
// via the video-module factory — it already had node lifetime), keyboard
// capture (a collapsed card must NOT eat the keyboard), the canvas blit, and
// the edges observer feeding `cvGatePatched` (pure card UI). Their lifecycles
// stay with the card on purpose.

import type {
  DoomNetcode,
  GameStartEnvelope,
  TiccmdEnvelope,
} from '$lib/doom/doom-netcode';
import type { LockstepTransport } from '$lib/doom/doom-lockstep';

/** The per-mount closures the card registers at adopt time. They survive the
 *  card's unmount (that is the whole point) and are REPLACED — never merely
 *  added — when a newer mount adopts, so exactly one wiring is live per node. */
export interface DoomSessionWiring {
  /** The per-frame SESSION pump: gamestate poll, pending-launch retry, the
   *  lockstep append/drain, mpLive refresh. Driven by the registry's own
   *  frame loop so it keeps running while no card exists. */
  pump: () => void;
  /** Detach THIS mount's awareness/nodes observers. Run when a newer mount
   *  replaces the wiring and by the graph sweep — NEVER by a card unmount. */
  detach: () => void;
  /** Netcode event targets. The surviving DoomNetcode instance reaches these
   *  through `dispatch(id)`, so a remount transparently rebinds them. */
  onArbiter: (isArbiter: boolean) => void;
  onGameStart: (env: GameStartEnvelope) => void;
  onRemoteTiccmd: (env: TiccmdEnvelope) => void;
  /** Live engine-side readings for the e2e probe (gametic/gamestate/PTNet
   *  bound…). Kept in the wiring because only the card knows the engine
   *  context; the registry's own fields would be "the registry's opinion",
   *  which is exactly what a probe must not be limited to. */
  probeExtras: () => Record<string, unknown>;
  /** Graph-lifetime extras teardown (disarm the WASM barrier, clear this
   *  peer's published tic floor). Run by sweep() only. */
  onSweep: () => void;
}

/** The session state a card mount reads and writes through `session(id)`.
 *  Everything here used to be card `$state`/locals and died with the mount. */
export interface DoomSessionState {
  netcode: DoomNetcode | null;
  netStarted: boolean;
  isNetArbiter: boolean;
  /** A netgame (or lone single-player launch) has been applied. */
  launched: boolean;
  /** A GAMESTART we received but could not start yet (runtime still loading /
   *  roster slot not synced). Retried from the pump. */
  pendingLaunch: GameStartEnvelope | null;
  /** The last launch actually APPLIED on this peer — what a remounting card
   *  restores its dialog mirrors (map/episode/skill/mode) from. */
  lastLaunch: GameStartEnvelope | null;
  lockstep: LockstepTransport | null;
  lockstepActive: boolean;
  /** Next consolidated tic still awaited (== engine recvtic at last drain). */
  lockstepNextTic: number;
  /** Highest local tic appended to the shared log (gap-free append cursor). */
  lockstepAppendedThru: number;
  /** Launch generation of the active lockstep game (== launchId). */
  lockstepGeneration: number;
  /** Wall-clock ms of the arbiter's last barrier-floor prune. */
  lockstepLastPruneMs: number;
  /** Last recvtic published to awareness (dedupe cursor, issue #348). */
  lastPublishedConsolidatedTic: number;
}

interface Entry extends DoomSessionState {
  wiring: DoomSessionWiring | null;
  /** Handle of the scheduled pump frame (rAF id in the browser). */
  frame: ReturnType<typeof setTimeout> | number | null;
  /** Total pump invocations — the e2e probe's CAUSAL liveness counter: it
   *  advances only when the session pump actually ran (units: pump runs, one
   *  per frame), never merely because wall-clock time passed. */
  pumpRuns: number;
}

/** No-op wiring so netcode trampolines are always callable — a netcode event
 *  landing before the first adopt (cannot happen today, but defensively) is
 *  dropped rather than a TypeError inside the awareness handler. */
const NOOP_WIRING: DoomSessionWiring = {
  pump: () => {},
  detach: () => {},
  onArbiter: () => {},
  onGameStart: () => {},
  onRemoteTiccmd: () => {},
  probeExtras: () => ({}),
  onSweep: () => {},
};

function freshEntry(): Entry {
  return {
    netcode: null,
    netStarted: false,
    isNetArbiter: false,
    launched: false,
    pendingLaunch: null,
    lastLaunch: null,
    lockstep: null,
    lockstepActive: false,
    lockstepNextTic: 0,
    lockstepAppendedThru: -1,
    lockstepGeneration: 0,
    lockstepLastPruneMs: 0,
    lastPublishedConsolidatedTic: -1,
    wiring: null,
    frame: null,
    pumpRuns: 0,
  };
}

class NodeDoomSessionRegistry {
  #entries = $state<Record<string, Entry>>({});

  #ensure(id: string): Entry {
    let e = this.#entries[id];
    if (!e) {
      e = freshEntry();
      this.#entries[id] = e;
      // Read back through the proxy so callers share the reactive object.
      e = this.#entries[id]!;
    }
    return e;
  }

  /** The node's mutable session record. Auto-vivifies (a card reads it during
   *  component init, before its onMount adopt runs) and is REACTIVE — template
   *  reads of e.g. `session(id).launched` re-render on change. Deliberately
   *  typed WITHOUT the wiring/pump internals: the card owns the session's
   *  CONTENT, the registry owns its LIFETIME. */
  session(id: string): DoomSessionState {
    return this.#ensure(id);
  }

  /** Register (or re-register) a mount's wiring. Idempotent and
   *  NON-DESTRUCTIVE to the session: a re-mounted card adopts the netcode /
   *  lockstep / launch state a previous mount left running — that is the whole
   *  point. The PREVIOUS mount's observers are detached here (exactly one
   *  wiring live per node), and the registry's pump loop is started if this is
   *  the node's first adopt. */
  adopt(id: string, wiring: DoomSessionWiring): void {
    const e = this.#ensure(id);
    if (e.wiring && e.wiring !== wiring) {
      try {
        e.wiring.detach();
      } catch {
        /* the old mount's observers may already be gone */
      }
    }
    e.wiring = wiring;
    if (e.frame === null) this.#scheduleFrame(id);
  }

  /** The CURRENT wiring for netcode trampolines. Always callable. */
  dispatch(id: string): DoomSessionWiring {
    return this.#entries[id]?.wiring ?? NOOP_WIRING;
  }

  /** Create-and-start the node's netcode exactly once. A second call — e.g. a
   *  remounted card's startNetcodeIfNeeded — adopts the LIVE instance instead
   *  of constructing a rival transport over the same awareness fields. */
  ensureNetcode(id: string, create: () => DoomNetcode): DoomNetcode {
    const e = this.#ensure(id);
    if (e.netcode) return e.netcode;
    const nc = create();
    e.netcode = nc;
    nc.start();
    e.netStarted = true;
    e.isNetArbiter = nc.isArbiter();
    return nc;
  }

  /**
   * USER-INTENT leave — this peer lost (or gave up) its seat: pruned from the
   * roster, dropped to spectator, or the game ended for it. Stops the netcode
   * (closing its peer connections + unbinding Module.PTNet) and forgets the
   * lockstep transport, mirroring the old card-side `stopNetcode()` field by
   * field. The card-side wrapper additionally disarms the WASM barrier and
   * clears the published tic floor (it owns the engine/provider handles).
   *
   * ⚠ NOT a lifecycle hook, and deliberately not named like one. A card
   * unmount must never reach this: that is the defect (#1590) — mid-netgame it
   * freezes EVERY peer (#345 consistency-abort semantics).
   */
  leaveGame(id: string): void {
    const e = this.#entries[id];
    if (!e) return;
    if (e.netcode) {
      try {
        e.netcode.stop();
      } catch {
        /* provider may be gone */
      }
      e.netcode = null;
    }
    e.netStarted = false;
    e.isNetArbiter = false;
    e.lockstep = null;
    e.lockstepActive = false;
    e.lockstepNextTic = 0;
    e.lockstepAppendedThru = -1;
  }

  /**
   * GRAPH-LIFETIME teardown — the only place the session dies without the user
   * asking. Called from Canvas with the live node ids on every graph change,
   * beside nodeMedia / nodePresent / nodeRecorder / nodeSamsloop /
   * nodeAudioInput.
   */
  sweep(liveNodeIds: Iterable<string>): void {
    const live = liveNodeIds instanceof Set ? liveNodeIds : new Set(liveNodeIds);
    for (const id of Object.keys(this.#entries)) {
      if (live.has(id)) continue;
      const e = this.#entries[id]!;
      this.#cancelFrame(e);
      try {
        e.wiring?.onSweep();
      } catch {
        /* engine/provider may already be gone */
      }
      try {
        e.wiring?.detach();
      } catch {
        /* observers may already be gone */
      }
      if (e.netcode) {
        try {
          e.netcode.stop();
        } catch {
          /* provider may be gone */
        }
      }
      delete this.#entries[id];
    }
  }

  /**
   * E2E probe — the NODE's own record, PLUS live engine-side readings.
   *
   * ⚠ `pumpRuns` is the causal quantity for the multiplayer freeze: it counts
   * actual session-pump invocations (units: pump runs, one per frame), i.e.
   * the exact mechanism whose death starves every peer's lockstep barrier.
   * `probeExtras` contributes readings taken from the WASM/engine at call time
   * (gametic, gamestate, PTNet bound), so the probe is not limited to the
   * registry's opinion of itself.
   */
  probe(id: string): Record<string, unknown> {
    const e = this.#entries[id];
    if (!e) return { hasEntry: false, wired: false, pumpRuns: -1 };
    let extras: Record<string, unknown> = {};
    try {
      extras = e.wiring?.probeExtras() ?? {};
    } catch {
      extras = { probeExtrasThrew: true };
    }
    return {
      hasEntry: true,
      wired: e.wiring !== null,
      pumpRuns: e.pumpRuns,
      netStarted: e.netStarted,
      isNetArbiter: e.isNetArbiter,
      launched: e.launched,
      lockstepActive: e.lockstepActive,
      lockstepGeneration: e.lockstepGeneration,
      hasPendingLaunch: e.pendingLaunch !== null,
      lastLaunch: e.lastLaunch ? { ...e.lastLaunch.settings, launchId: e.lastLaunch.launchId } : null,
      netcodePeers: e.netcode ? e.netcode.debugStats().peers : [],
      ...extras,
    };
  }

  /** One pump frame. rAF in the browser; a 16 ms timeout where rAF does not
   *  exist (vitest/node) so the unit suite can drive the loop deterministically
   *  by stubbing either scheduler. */
  #scheduleFrame(id: string): void {
    const e = this.#entries[id];
    if (!e) return;
    const tick = (): void => {
      const cur = this.#entries[id];
      if (!cur) return; // swept — the loop dies with the entry
      const w = cur.wiring;
      if (w) {
        try {
          w.pump();
          cur.pumpRuns++;
        } catch {
          // A pump throw must not kill the loop: the next frame retries. (The
          // old card rAF died on throw AND on unmount; only the first of those
          // was ever acceptable.)
        }
      }
      cur.frame = null;
      this.#scheduleFrame(id);
    };
    e.frame =
      typeof requestAnimationFrame !== 'undefined'
        ? requestAnimationFrame(tick)
        : setTimeout(tick, 16);
  }

  #cancelFrame(e: Entry): void {
    if (e.frame === null) return;
    if (typeof requestAnimationFrame !== 'undefined' && typeof e.frame === 'number') {
      cancelAnimationFrame(e.frame);
    } else {
      clearTimeout(e.frame as ReturnType<typeof setTimeout>);
    }
    e.frame = null;
  }
}

/** The singleton. Module scope = graph scope, which is the lifetime a running
 *  netgame actually has. */
export const nodeDoomSession = new NodeDoomSessionRegistry();
