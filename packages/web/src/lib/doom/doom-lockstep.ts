// doom-lockstep.ts
//
// P1 TRUE DETERMINISTIC LOCKSTEP transport + barrier (browser side).
// Design: .myrobots/plans/doom-mp-true-lockstep.md (PR #346).
//
// THE PROBLEM THIS FIXES
//   The slice-5 live path shipped each peer's per-tic ticcmd over a single
//   last-value-wins Yjs AWARENESS field. Awareness coalesces: if two tics are
//   produced between two flushes, the intermediate ticcmd is silently dropped,
//   and the remote ticcmd is overlaid onto whatever local gametic the peer
//   happens to be on. Result: each peer free-runs an INDEPENDENT gamestate
//   (monsters, barrels, health, RNG never shared). The #345 consistancy stamp
//   only stops that free-run model from crashing.
//
// THE FIX (this module): an ORDERED, DURABLE APPEND-LOG + a CONSOLIDATION
// BARRIER, exactly the shape the spike proved keeps two WASM sims byte-identical
// (doomgeneric/tests/lockstep-barrier-transport.spike.mjs).
//
//   - TRANSPORT: a per-module Yjs `Y.Array<TiccmdLogEntry>`. Each peer APPENDS
//     `{ tic, slot, fwd, side, ang, btn }` for every tic it builds. A CRDT array
//     has TOTAL ORDER and never coalesces or loses an entry — the exact property
//     awareness lacks — and is DURABLE across the single-process relay's known
//     drift/restart (memory: relay-single-process-and-drift). For P1 the Y.Array
//     log is the sole transport (simplest correct option over the existing
//     relay).
//     TODO(P4): add a WebRTC ordered+reliable datachannel fast-path (infra
//     already in doom-netcode.ts) for lower latency; the log stays the durable
//     fallback / source of truth.
//
//   - BARRIER: tic N is only "ready" once the log holds an entry for EVERY live
//     slot at tic N. We consolidate ready tics STRICTLY IN ORDER into a TicSet
//     (one ticcmd per slot) and hand each, in order, to the consumer
//     (runtime.receiveTicSet). The consumer's WASM barrier (d_loop.c) then
//     advances gametic up to recvtic and PAUSES (never spins) when starved.
//
// This module is pure/transport-only: it does NOT touch the WASM directly. It
// is driven by DoomCard each frame (append local tics, drain ready TicSets).
// Unit-testable against a real in-memory Y.Doc (no relay, no WASM).

import type * as Y from 'yjs';

/** One peer's ticcmd for one tic, as it rides in the shared ordered log. Field
 *  names are short to keep the CRDT payload tiny (this is hot, one per tic per
 *  peer). Mirrors DoomTiccmd (fwd/side i8, ang i16, btn u8). */
export interface TiccmdLogEntry {
  /** Engine tic number this input belongs to (the producer's maketic-1). */
  t: number;
  /** Producer's player slot (0..3). */
  s: number;
  fwd: number;
  side: number;
  ang: number;
  btn: number;
}

/** A consolidated per-tic TicSet: ticcmd per slot, null = slot not present this
 *  tic (dropped / spectator). Index = slot. */
export type TicSet = (Ticcmd | null)[];

export interface Ticcmd {
  forwardmove: number;
  sidemove: number;
  angleturn: number;
  buttons: number;
}

/** Stable Y.Array name for a module's per-tic ticcmd log. One log per DOOM
 *  module node PER LAUNCH GENERATION — a (re)launch bumps the generation so each
 *  game (and each synchronized restart) uses a FRESH array, never inheriting the
 *  previous game's tic entries (which would desync the new shared tic 0). Pruned
 *  by the arbiter (single writer of deletions). */
export function ticLogName(moduleId: string, generation = 0): string {
  return `doom-ticlog:${moduleId}:${generation}`;
}

export interface LockstepTransportOpts {
  /** The shared Yjs document (provider.document / graph store ydoc). */
  doc: Y.Doc;
  moduleId: string;
  /** This peer's player slot (0..3). */
  slot: number;
  /** Number of live player slots this game (= roster size at launch). */
  numPlayers: number;
  /** Launch generation (the arbiter's launchId). A new launch / synchronized
   *  restart bumps it so the shared log starts empty at the new tic 0. */
  generation?: number;
}

// Ring large enough to cover DOOM's BACKUPTICS (128) of pending input plus
// headroom. Older entries are pruned by the arbiter; a non-arbiter never
// deletes (avoids CRDT delete races).
const PRUNE_KEEP_TICS = 256;

/** Default INPUT-DELAY (in tics) for the LIVE relay transport — the standard
 *  DOOM/lockstep technique, implemented in the ENGINE (d_loop.c BuildNewTic via
 *  dgpt_set_input_delay), NOT in this transport.
 *
 *  The card passes this to extras.setInputDelay(D): the engine then runs maketic
 *  D tics AHEAD of gametic, so each peer BUILDS + appends its ticcmd for tic G a
 *  full D tics (~D×28.5ms at 35Hz) before gametic reaches G. That head start lets
 *  a remote peer's tic-G entry propagate through the single-process Hocuspocus
 *  relay before the barrier needs it, so the sim advances at 35Hz instead of
 *  stalling every tic — at the cost of D tics of input latency (the marine
 *  responds D tics later; normal netplay behaviour).
 *
 *  Determinism is preserved for free: every peer still appends its ticcmd at its
 *  TRUE tic number and the barrier delivers the IDENTICAL consolidated TicSet per
 *  tic to every peer (the exact transport the C acceptance harness proves
 *  byte-exact). The delay only changes WHEN inputs are produced, never WHICH
 *  input runs at which tic.
 *
 *  ~6 tics ≈ 171ms of lead — enough headroom for a Yjs-Array round-trip through
 *  the relay, while staying well within the BACKUPTICS (128) ring. Tuned
 *  empirically against the @collab repro. */
export const DEFAULT_INPUT_DELAY_TICS = 6;

/**
 * Ordered append-log + consolidation barrier over a Yjs Y.Array.
 *
 * Lifecycle per frame (driven by DoomCard):
 *   1. appendLocal(tic, cmd)  — for each newly-built local tic (maketic-1).
 *   2. drainReady(fromTic, onTicSet) — deliver every consolidated TicSet from
 *      `fromTic` upward that is now complete, IN ORDER, until a gap.
 *   3. (arbiter only) pruneBelow(gametic) — trim consumed entries.
 */
export class LockstepTransport {
  private readonly doc: Y.Doc;
  private readonly arr: Y.Array<TiccmdLogEntry>;
  private readonly slot: number;
  private numPlayers: number;

  /** Highest local tic we've already appended (dedupe re-appends). */
  private appendedThru = -1;

  constructor(opts: LockstepTransportOpts) {
    this.doc = opts.doc;
    this.arr = opts.doc.getArray<TiccmdLogEntry>(ticLogName(opts.moduleId, opts.generation ?? 0));
    this.slot = opts.slot;
    this.numPlayers = Math.max(1, opts.numPlayers);
  }

  /** Adjust the live-slot count (e.g. a P2 synchronized restart at a larger
   *  roster). Determinism is preserved because consolidation reads the count
   *  fresh each drain. */
  setNumPlayers(n: number): void {
    this.numPlayers = Math.max(1, n);
  }

  /** Append THIS peer's ticcmd for `tic` (its own slot) to the shared ordered
   *  log. Idempotent per tic (a re-call for an already-appended tic is ignored)
   *  so a frame that builds no new tic doesn't duplicate. */
  appendLocal(tic: number, cmd: Ticcmd): void {
    if (tic <= this.appendedThru) return;
    // Append every tic from appendedThru+1..tic (normally just `tic`); if the
    // caller skipped, we still only have `cmd` for the latest — but the engine
    // build-ahead cap (≤2) makes a skip impossible in practice, and a missing
    // intermediate tic would simply stall the barrier (correctly) rather than
    // desync. We append only the latest provided.
    this.arr.push([
      { t: tic, s: this.slot, fwd: cmd.forwardmove, side: cmd.sidemove, ang: cmd.angleturn, btn: cmd.buttons },
    ]);
    this.appendedThru = tic;
  }

  /** Build a tic→(slot→entry) index from the whole log. O(n) per drain; n is
   *  bounded by PRUNE_KEEP_TICS × numPlayers. */
  private indexByTic(): Map<number, Map<number, TiccmdLogEntry>> {
    const byTic = new Map<number, Map<number, TiccmdLogEntry>>();
    for (const e of this.arr.toArray()) {
      if (!e || typeof e.t !== 'number' || typeof e.s !== 'number') continue;
      let bySlot = byTic.get(e.t);
      if (!bySlot) {
        bySlot = new Map();
        byTic.set(e.t, bySlot);
      }
      // First write wins for a (tic,slot) pair (a peer never legitimately
      // re-sends a different ticcmd for the same tic; the CRDT total order makes
      // the earliest the canonical one).
      if (!bySlot.has(e.s)) bySlot.set(e.s, e);
    }
    return byTic;
  }

  /** Consolidate + deliver every complete TicSet, IN ORDER, starting at
   *  `fromTic`, stopping at the first incomplete tic (the barrier). Calls
   *  `onTicSet(tic, numPlayers, set)` for each. Returns the next tic still
   *  awaited (== fromTic if the very first tic isn't complete yet). */
  drainReady(fromTic: number, onTicSet: (tic: number, numPlayers: number, set: TicSet) => void): number {
    const byTic = this.indexByTic();
    let tic = fromTic;
    // Cap the per-drain delivery so a huge backlog (after a pause) can't block
    // the frame; the next frame continues. Bounded catch-up.
    const MAX_PER_DRAIN = 64;
    let delivered = 0;
    for (; delivered < MAX_PER_DRAIN; tic++, delivered++) {
      const bySlot = byTic.get(tic);
      if (!bySlot) break; // no entries for this tic yet → barrier holds
      // Tic is ready only when EVERY live slot has submitted.
      let complete = true;
      const set: TicSet = [];
      for (let s = 0; s < this.numPlayers; s++) {
        const e = bySlot.get(s);
        if (!e) {
          complete = false;
          break;
        }
        set[s] = { forwardmove: e.fwd, sidemove: e.side, angleturn: e.ang, buttons: e.btn };
      }
      if (!complete) break; // barrier: withhold until all slots present
      onTicSet(tic, this.numPlayers, set);
    }
    return tic;
  }

  /** Arbiter-only: prune log entries older than `gametic - PRUNE_KEEP_TICS` so
   *  the array never grows unbounded. Single pruner (the arbiter) avoids CRDT
   *  delete races. Safe to call every frame (no-op when nothing to prune). */
  pruneBelow(gametic: number): void {
    const cutoff = gametic - PRUNE_KEEP_TICS;
    if (cutoff <= 0) return;
    const entries = this.arr.toArray();
    // Delete a contiguous prefix of stale entries. Entries are appended in
    // (mostly) tic order; we delete from the front while the front entry's tic
    // is below cutoff. Conservative: stop at the first non-stale entry so we
    // never delete a live tic out from under a slow peer.
    let n = 0;
    for (const e of entries) {
      if (e && typeof e.t === 'number' && e.t < cutoff) n++;
      else break;
    }
    if (n > 0) {
      this.doc.transact(() => this.arr.delete(0, n));
    }
  }

  /** Total log length (test/diagnostic). */
  size(): number {
    return this.arr.length;
  }
}
