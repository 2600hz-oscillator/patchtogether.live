// packages/web/src/lib/doom/doom-gating.ts
//
// DOOM MP round 5 — host-only widget + gated one-click hot-join.
//
// Pure gating predicates extracted from DoomCard.svelte / Canvas.svelte so the
// unit suite can exercise them with no Svelte, no Yjs, no WASM, no DOM. The
// card + canvas import these and feed them their live (Svelte $state / Yjs)
// values; the functions themselves are total + side-effect-free.
//
// The new model (owner-approved, round 5):
//
//   1. Only the rack OWNER can instantiate the DOOM widget. Non-owners can't
//      add a DOOM module — canAddDoom() gates the palette + spawn path.
//   2. Only the owner / P1 plays single-player. (Enforced in the card:
//      playSinglePlayer() is host-only; nothing here changes that.)
//   3. A non-owner's JOIN button is DISABLED unless the host is CURRENTLY
//      running a multiplayer game (in an active MP session, in-level). That
//      "MP is live" signal is a single Yjs-synced field the host writes
//      (computeMpLive) and guests read (canJoinNow / joinDisabledReason).
//   4. Join = immediate HOT-JOIN. When MP is live and a guest clicks the
//      (now-enabled) Join, the guest is taken straight into the running level
//      — one click, no host action. The host's runtime auto-relaunches the
//      current map with the new player count to admit the joiner (the existing
//      promotePending / broadcastGameStart machinery, fired automatically on
//      join). shouldHotJoinRelaunch() decides when that relaunch must fire.

/** DOOM gamestate_t ordinals (doomdef.h). The level is "in progress" while
 *  GS_LEVEL is the live state; GS_INTERMISSION is the between-maps tally. */
export const GS_LEVEL = 0;
export const GS_INTERMISSION = 1;

// ────────────────────────────────────────────────────────────────────────
//  1. Owner-only widget instantiation
// ────────────────────────────────────────────────────────────────────────

/**
 * Whether THIS peer is allowed to ADD a DOOM widget to the rack.
 *
 * Only the rack OWNER may instantiate DOOM. A non-owner attempting to add it
 * is prevented (the palette hides the entry; the spawn path refuses) rather
 * than erroring ugly.
 *
 * Single-user mode (`isRackOwner === undefined`, e.g. the public `/` canvas or
 * a local-only rack with no multiplayer provider attached) has exactly one
 * user who IS the de-facto owner, so adding is allowed there. Only an
 * EXPLICIT `isRackOwner === false` (a known non-owner in a multi-user rack)
 * blocks the add.
 */
export function canAddDoom(isRackOwner: boolean | undefined): boolean {
  return isRackOwner !== false;
}

/** True iff a module type is owner-only (only the rack owner may add it).
 *  DOOM is the only such module today; kept as a list so a future owner-only
 *  module is a one-line add rather than a scattered string compare. */
const OWNER_ONLY_MODULE_TYPES = new Set<string>(['doom']);

export function isOwnerOnlyModule(type: string): boolean {
  return OWNER_ONLY_MODULE_TYPES.has(type);
}

/** Palette / spawn gate: may THIS peer add a module of `type`? Owner-only
 *  modules require ownership (canAddDoom semantics); everything else is
 *  always addable. */
export function canAddModule(type: string, isRackOwner: boolean | undefined): boolean {
  if (!isOwnerOnlyModule(type)) return true;
  return canAddDoom(isRackOwner);
}

// ────────────────────────────────────────────────────────────────────────
//  3. The "MP session is live" signal
// ────────────────────────────────────────────────────────────────────────

/** The host's DOOM session state that a guest reads to enable/disable Join.
 *  Surfaced as ONE Yjs-synced node field (node.data.mpLive) the host writes
 *  authoritatively, so guests never have to infer liveness from racy
 *  awareness churn (frame broadcasts, host election, etc). */
export interface MpLiveInputs {
  /** Host's explicit session mode (node.data.mpMode). */
  mpMode: 'single' | 'multi' | undefined;
  /** The host launched a netgame (a GAMESTART went out). */
  launched: boolean;
  /** The host's polled DOOM gamestate_t (GS_LEVEL while a map runs). */
  gamestate: number;
}

/**
 * Compute the host-authoritative "MP is live" flag from the host's own state.
 * MP is LIVE iff the host is in a multiplayer session AND its WASM is actually
 * in a running level (GS_LEVEL) — i.e. there is a real, joinable game right
 * now. This is the signal the host writes to node.data.mpLive each tick; it is
 * NOT inferred by guests from anything racy.
 *
 * Deliberately requires GS_LEVEL (not merely `launched`): between maps the host
 * sits at GS_INTERMISSION re-picking the next map, during which a hot-join
 * would race the next-map launch — so Join is disabled there until the level
 * is actually running again.
 */
export function computeMpLive(inputs: MpLiveInputs): boolean {
  return inputs.mpMode === 'multi' && inputs.launched && inputs.gamestate === GS_LEVEL;
}

// ────────────────────────────────────────────────────────────────────────
//  Guest-side Join affordance (enable / disable + label)
// ────────────────────────────────────────────────────────────────────────

export interface JoinAffordanceInputs {
  /** This peer is the rack host (the host never sees a Join button — it's
   *  already P1). */
  isHost: boolean;
  /** This peer already holds an active OR pending slot. */
  alreadySeated: boolean;
  /** The combined (active + pending) roster is full (4 players). */
  full: boolean;
  /** The host-written MP-live flag (node.data.mpLive), read off the synced
   *  node. */
  mpLive: boolean;
}

export type JoinState =
  | { show: false }
  | {
      show: true;
      enabled: boolean;
      /** Stable label for the button. */
      label: string;
      /** Human-readable reason, used as the title/tooltip + the disabled-state
       *  copy ("Waiting for host to start a multiplayer game…"). */
      reason: string;
    };

/**
 * The guest-side Join affordance: whether to show the button, whether it is
 * enabled, and the label/reason copy.
 *
 *   - Host / already-seated peers don't see a Join button.
 *   - A non-seated guest ALWAYS sees the button, but it is DISABLED unless the
 *     host is currently running a multiplayer game (mpLive). The disabled copy
 *     reads "Waiting for host to start a multiplayer game…".
 *   - When MP is live, the button is enabled and a click is an immediate
 *     hot-join into the current map.
 *   - A full game disables the button with a "full" reason.
 */
export function joinAffordance(inputs: JoinAffordanceInputs): JoinState {
  if (inputs.isHost || inputs.alreadySeated) return { show: false };
  if (!inputs.mpLive) {
    return {
      show: true,
      enabled: false,
      label: 'Join',
      reason: 'Waiting for host to start a multiplayer game…',
    };
  }
  if (inputs.full) {
    return {
      show: true,
      enabled: false,
      label: 'Full',
      reason: 'DOOM is full (4 players)',
    };
  }
  return {
    show: true,
    enabled: true,
    label: 'Join',
    reason: 'Join — hot-drop into the running map (it reloads with you in it)',
  };
}

/** Convenience predicate: may this guest click Join RIGHT NOW? */
export function canJoinNow(inputs: JoinAffordanceInputs): boolean {
  const s = joinAffordance(inputs);
  return s.show === true && s.enabled === true;
}

// ────────────────────────────────────────────────────────────────────────
//  4. Auto-relaunch on join (hot-join)
// ────────────────────────────────────────────────────────────────────────

export interface HotJoinInputs {
  /** This peer is the session arbiter (rack host = single writer/broadcaster). */
  isArbiter: boolean;
  /** A level is currently running (host gamestate === GS_LEVEL after launch). */
  gameInProgress: boolean;
  /** The slot-assignment pass just added a brand-new ACTIVE player. */
  addedActivePlayer: boolean;
}

/**
 * Whether the arbiter must AUTO-RELAUNCH the current map to admit a just-seated
 * joiner. DOOM can't add players mid-level (the player set is fixed at
 * G_InitNew + the lockstep tic stream assumes a constant playeringame[]), so a
 * mid-level join seats the player ACTIVE and re-broadcasts the CURRENT map's
 * settings with the larger numPlayers — every peer reloads via G_InitNew and
 * the new player spawns at its coop start within ~1-2s.
 *
 * The relaunch fires iff a brand-new active player appeared WHILE a level was
 * running. (At the pre-game lobby or intermission there's no running level to
 * relaunch — the normal launch / next-map path seats them instead.)
 */
export function shouldHotJoinRelaunch(inputs: HotJoinInputs): boolean {
  return inputs.isArbiter && inputs.gameInProgress && inputs.addedActivePlayer;
}
