// packages/web/src/lib/doom/doom-player-identity.ts
//
// Slice 5 of the DOOM true-4-player plan: per-player visual identity.
//
// Pure helpers (no Svelte, no DOM, no Yjs) so the unit suite can pin the
// slot→color + slot→label mappings. The DoomCard imports these to tint its
// header/stripe/badge by player slot + render a "Player N — <username>" label.
//
// ────────────────────────────────────────────────────────────────────────
//  Canonical DOOM multiplayer colors
// ────────────────────────────────────────────────────────────────────────
//   Vanilla DOOM remaps the marine sprite's green range to a per-player color
//   via the MT_PLAYER translation tables (see r_things.c / the
//   translationtables built in R_InitTranslationTables): player 0 keeps the
//   default GREEN, player 1 = INDIGO, player 2 = BROWN, player 3 = RED. We use
//   approximate CSS equivalents so a wall of 4 DOOM cards is instantly
//   readable + matches what each player's marine looks like in-game.

/** Per-slot identity descriptor. `color` is the canonical-ish CSS color for
 *  the slot; `name` is the human-readable DOOM color name (used in titles /
 *  a11y labels). */
export interface DoomSlotColor {
  /** DOOM color name for this slot (Green / Indigo / Brown / Red). */
  name: string;
  /** CSS color approximating the vanilla DOOM player translation. */
  color: string;
}

/** Slot index → canonical DOOM player color. Indices match consoleplayer
 *  (0..3). Vanilla order: green, indigo, brown, red. */
export const DOOM_SLOT_COLORS: readonly DoomSlotColor[] = [
  { name: 'Green', color: '#3fa34d' }, // player 0 — default marine green
  { name: 'Indigo', color: '#5b5bd6' }, // player 1 — indigo
  { name: 'Brown', color: '#8a5a2b' }, // player 2 — brown
  { name: 'Red', color: '#c2342b' }, // player 3 — red
] as const;

/** The color for a player slot. Out-of-range / null slots fall back to the
 *  green (slot 0) so a malformed slot never renders an undefined color. */
export function slotColor(slot: number | null): DoomSlotColor {
  if (slot === null || !Number.isInteger(slot) || slot < 0 || slot >= DOOM_SLOT_COLORS.length) {
    return DOOM_SLOT_COLORS[0]!;
  }
  return DOOM_SLOT_COLORS[slot]!;
}

/** Just the CSS color string for a slot (convenience for inline styles). */
export function slotColorCss(slot: number | null): string {
  return slotColor(slot).color;
}

/**
 * Format the player-identity label shown in a DoomCard header.
 *
 *   slot=0, username="alice", isLocal=false  → "Player 1 — alice"
 *   slot=0, username="alice", isLocal=true   → "Player 1 — alice (you)"
 *   slot=2, username=null,    isLocal=false  → "Player 3"
 *   slot=null                                → "" (spectator: no player label)
 *
 * Slots are 0-based internally (consoleplayer) but shown 1-based to humans
 * ("Player 1" = slot 0), matching the DOOM status-bar convention.
 */
export function slotLabel(
  slot: number | null,
  username: string | null | undefined,
  isLocal: boolean,
): string {
  if (slot === null || !Number.isInteger(slot) || slot < 0) return '';
  let label = `Player ${slot + 1}`;
  const name = typeof username === 'string' ? username.trim() : '';
  if (name.length > 0) label += ` — ${name}`;
  if (isLocal) label += ' (you)';
  return label;
}

/** Short badge text for a slot ("P1".."P4"). Empty for a spectator. */
export function slotBadge(slot: number | null): string {
  if (slot === null || !Number.isInteger(slot) || slot < 0) return '';
  return `P${slot + 1}`;
}

// ────────────────────────────────────────────────────────────────────────
//  Slice 6: spectator / pending-late-joiner label states
// ────────────────────────────────────────────────────────────────────────
//
//   A peer that has NOT claimed an active slot is a spectator: it renders the
//   host/arbiter framebuffer (slice 3) and shows a clear "Spectating" badge.
//   A peer that joined an in-progress game holds a PENDING slot — it is still
//   a spectator of the running level, but it knows which slot it will spawn
//   into at the next map, so it shows "Joining as Player N next map". These
//   helpers pin those two states (pure; unit-tested) so the card just renders
//   them.

/** The viewer's multiplayer status, for the spectator/pending affordance.
 *    - 'player'    — holds an active slot, playing now (no spectator badge).
 *    - 'pending'   — reserved a slot during an in-progress game; spectating
 *                    until the next map, then spawns as `slot`.
 *    - 'spectator' — no slot at all (over cap, or hasn't joined). */
export type DoomViewerStatus = 'player' | 'pending' | 'spectator';

/** Short badge text for the spectator/pending affordance.
 *    'pending'   → "P(N)" — the (parenthesized) slot it will take next map.
 *    'spectator' → "SPEC".
 *    'player'    → "" (the slotBadge "PN" is used instead). */
export function spectatorBadge(status: DoomViewerStatus, slot: number | null): string {
  if (status === 'pending' && slot !== null && Number.isInteger(slot) && slot >= 0) {
    return `P${slot + 1}?`;
  }
  if (status === 'spectator' || status === 'pending') return 'SPEC';
  return '';
}

/**
 * The full spectator/pending label shown in a DoomCard for an unjoined or
 * pending peer.
 *
 *   status='spectator'              → "Spectating"
 *   status='pending', slot=1        → "Spectating — joining as Player 2 next map"
 *   status='player'                 → "" (uses slotLabel instead)
 *
 * Slots are shown 1-based ("Player N" = slot N-1), matching slotLabel.
 */
export function spectatorLabel(status: DoomViewerStatus, slot: number | null): string {
  if (status === 'player') return '';
  if (
    status === 'pending' &&
    slot !== null &&
    Number.isInteger(slot) &&
    slot >= 0
  ) {
    return `Spectating — joining as Player ${slot + 1} next map`;
  }
  return 'Spectating';
}
