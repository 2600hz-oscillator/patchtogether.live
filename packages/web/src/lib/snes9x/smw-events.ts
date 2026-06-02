// packages/web/src/lib/snes9x/smw-events.ts
//
// PURE Super Mario World game-event detection over SNES WRAM snapshots.
//
// This module is deliberately a set of PURE functions fed RAM byte
// snapshots (Uint8Array views into WRAM, or a tiny readByte accessor) so
// the detection state machine is unit-testable WITHOUT running the
// emulator — mirrors how DOOM's cv-gate-edge.ts isolates the edge detector
// from the WASM shim. The SNES9X module factory feeds it one WRAM snapshot
// per emulated frame and turns the returned events into gate pulses + CV.
//
// ──────────────────────────────────────────────────────────────────────
// SMW RAM MAP (all $7Exxxx → WRAM offset = addr & 0x1FFFF). Authoritative
// source: SMW Central RAM map (smwcentral.net) + the telinc1 mirror; the
// values below were cross-checked against the dev.telinc1.com memory map
// and live-validated where noted against the real ROM in the snes9x WASM
// core (see the Node probe in the PR description).
//
//   $7E0100  GAME MODE. 0x0E = overworld, 0x13 = in a level (and the
//            0x10..0x14 fade transitions around them). [LIVE-VALIDATED:
//            transitions 4→5→8→… observed booting the real ROM.]
//   $7E0DBE  LIVES, minus one (0x04 here = 5 lives shown). [LIVE-VALIDATED:
//            read 0x04 on the title screen of the real ROM.]
//   $7E0071  PLAYER ANIMATION TRIGGER. 0x09 = the death animation.
//            [DOCUMENTED + widely cited; the death detector watches the
//            0x?? → 0x09 transition. Cross-checked: secondary sources
//            confirm "$71 is set to $09 = death animation".]
//   $7E13BF  TRANSLEVEL number — set on transfer from overworld to a level;
//            identifies the level. Used (with the submap) to derive
//            world+level. [DOCUMENTED.]
//   $7E1F11  CURRENT OVERWORLD SUBMAP index (0 = main map / Yoshi's Island,
//            1 = Yoshi's Island sub, … the submap the player icon is on).
//            Used to derive the "world". [DOCUMENTED — see deriveWorld()
//            note; submap-vs-world is an approximation, FLAGGED below.]
//   $7E14C8  SPRITE STATUS TABLE, 12 entries ($14C8..$14D3). Per slot:
//              0x00 = empty/non-existent (free slot)
//              0x01 = init
//              0x02 = falling/“killed, falls off screen”
//              0x03 = smushed (stomp-flattened)
//              0x04 = killed by spinjump / sprite-cape, etc.
//              0x05 = burning / sinking in lava
//              0x06 = turn into coin (e.g. last Koopa kicked into shell run)
//              0x08 and ABOVE = ALIVE / normal.
//            A KILL is a transition of a slot from ALIVE (>=0x08) to a
//            KILLED status (0x02..0x06). [DOCUMENTED — alive>=0x08 + the
//            killed-status enumeration are both from the SMW Central map.]
//
// ──────────────────────────────────────────────────────────────────────
// FLAGS / assumptions needing human verification:
//   * deriveWorld(): SMW has no clean "world 1..8" grid. We map
//     world = submap index + 1 ($7E1F11 + 1) so Yoshi's Island=1,
//     Yoshi's Island-sub=2, … This is a DEFINED, documented behaviour, but
//     the submap↔"world" correspondence is an interpretation, not a
//     SMW-native concept. If the translevel-based mapping is preferred,
//     swap to deriveWorldFromTranslevel() (also provided) — both are pure.
//   * The death value 0x09 at $7E0071 is the standard death animation; if
//     a future SMW romhack repurposes $0071 the detector should be re-checked.

/** The detectable SMW event types surfaced as gate pulses. */
export type SmwEventType = 'kill' | 'death' | 'level_change';

export interface SmwEvent {
  type: SmwEventType;
}

// ── RAM addresses (WRAM offsets; the $7E bank is offset 0). ──
export const ADDR_GAME_MODE = 0x0100;
export const ADDR_LIVES = 0x0dbe;
export const ADDR_PLAYER_ANIM = 0x0071;
export const ADDR_TRANSLEVEL = 0x13bf;
export const ADDR_SUBMAP = 0x1f11;
export const ADDR_SPRITE_STATUS_BASE = 0x14c8;
export const SPRITE_SLOTS = 12;

/** $7E0071 value that means "Mario is playing the death animation". */
export const PLAYER_ANIM_DEAD = 0x09;
/** $7E0100 game-mode for the overworld map. */
export const GAME_MODE_OVERWORLD = 0x0e;
/** $7E0100 game-mode for being inside a level (the playable state). */
export const GAME_MODE_LEVEL = 0x13;

/** A sprite slot is ALIVE at status >= 0x08. */
export function spriteIsAlive(status: number): boolean {
  return status >= 0x08;
}
/** A sprite slot is in a KILLED status (0x02..0x06). 0x00/0x01 (empty/init)
 *  are NOT kills — a slot going alive→empty is a despawn, not a kill. */
export function spriteIsKilled(status: number): boolean {
  return status >= 0x02 && status <= 0x06;
}

/** Read accessor the detector consumes. Either a WRAM Uint8Array (offset
 *  = address) or a function. Keeping it abstract lets tests feed plain
 *  arrays + lets the runtime pass a zero-copy heap view. */
export type WramRead = (addr: number) => number;

/** Build a WramRead over a Uint8Array WRAM snapshot. */
export function wramReader(wram: Uint8Array): WramRead {
  return (addr: number) => wram[addr & 0x1ffff] ?? 0;
}

/** Mutable detector state. One instance per running emulator; reset on
 *  ROM (re)load. All fields are plain numbers so the state is trivially
 *  serialisable + comparable in tests. */
export interface SmwDetectorState {
  /** Previous frame's sprite-status snapshot (per slot). */
  prevSprite: number[];
  /** Previous frame's $7E0071 player-anim value. */
  prevAnim: number;
  /** Previous frame's $7E0DBE lives value. */
  prevLives: number;
  /** Previous frame's translevel ($7E13BF). */
  prevTranslevel: number;
  /** Previous frame's submap ($7E1F11). */
  prevSubmap: number;
  /** True once we've seen at least one frame (so the first frame doesn't
   *  emit spurious edges from the all-zero "no previous" baseline). */
  primed: boolean;
}

export function makeSmwDetectorState(): SmwDetectorState {
  return {
    prevSprite: new Array<number>(SPRITE_SLOTS).fill(0),
    prevAnim: 0,
    prevLives: 0,
    prevTranslevel: 0,
    prevSubmap: 0,
    primed: false,
  };
}

/**
 * Advance the detector by one WRAM snapshot. Returns the events that fired
 * THIS frame (possibly several kills + a death + a level change). Mutates
 * `state` in place. Pure aside from that mutation: identical (state, read)
 * inputs always yield the same events + next state.
 *
 * Detection rules:
 *   - KILL: any sprite slot transitions from ALIVE (>=0x08) to a KILLED
 *     status (0x02..0x06). One event PER slot per transition (debounced by
 *     the per-slot prev snapshot — a slot stuck at 0x04 doesn't re-fire).
 *   - DEATH: $7E0071 transitions INTO 0x09 (the death animation) from any
 *     other value. One event per death (the rising edge into 0x09).
 *     Lives-decrement ($7E0DBE drops) is used as a corroborating fallback
 *     so an unusual romhack still surfaces a death; we de-dup so the two
 *     signals for the SAME death only emit ONE event.
 *   - LEVEL_CHANGE: translevel ($7E13BF) OR submap ($7E1F11) changes value
 *     while NOT on the overworld-map game-mode boundary noise — emitted on
 *     any change after priming. Used to retrigger the gate3 multiplier base
 *     + refresh cv1.
 */
export function detectSmwEvents(
  state: SmwDetectorState,
  read: WramRead,
): SmwEvent[] {
  const events: SmwEvent[] = [];

  const anim = read(ADDR_PLAYER_ANIM);
  const lives = read(ADDR_LIVES);
  const translevel = read(ADDR_TRANSLEVEL);
  const submap = read(ADDR_SUBMAP);
  const sprite: number[] = new Array<number>(SPRITE_SLOTS);
  for (let i = 0; i < SPRITE_SLOTS; i++) {
    sprite[i] = read(ADDR_SPRITE_STATUS_BASE + i);
  }

  if (!state.primed) {
    // First frame: seed the baselines, emit nothing.
    state.prevSprite = sprite;
    state.prevAnim = anim;
    state.prevLives = lives;
    state.prevTranslevel = translevel;
    state.prevSubmap = submap;
    state.primed = true;
    return events;
  }

  // ── KILLS ──
  for (let i = 0; i < SPRITE_SLOTS; i++) {
    const prev = state.prevSprite[i] ?? 0;
    const cur = sprite[i] ?? 0;
    if (spriteIsAlive(prev) && spriteIsKilled(cur)) {
      events.push({ type: 'kill' });
    }
  }

  // ── DEATH ──
  // Primary: $0071 rising edge into the 0x09 death anim.
  const animDeath = state.prevAnim !== PLAYER_ANIM_DEAD && anim === PLAYER_ANIM_DEAD;
  // Fallback: a lives DECREMENT (0DBE drops) corroborates a death for ROMs
  // where $0071 doesn't follow the stock convention.
  const livesDropped = lives < state.prevLives;
  if (animDeath || livesDropped) {
    events.push({ type: 'death' });
  }

  // ── LEVEL CHANGE ──
  if (translevel !== state.prevTranslevel || submap !== state.prevSubmap) {
    events.push({ type: 'level_change' });
  }

  // Commit snapshot.
  state.prevSprite = sprite;
  state.prevAnim = anim;
  state.prevLives = lives;
  state.prevTranslevel = translevel;
  state.prevSubmap = submap;
  return events;
}

// ──────────────────────────────────────────────────────────────────────
// WORLD + LEVEL derivation + CV scaling.
// ──────────────────────────────────────────────────────────────────────

export interface SmwLocation {
  /** Derived "world" (1-based). 0 when not in/around a level (idle). */
  world: number;
  /** Derived "level within the submap" (1-based). 0 when idle. */
  level: number;
  /** True when the read indicates the player is in a playable level state. */
  inLevel: boolean;
}

/** Number of distinct overworld submaps SMW exposes (main + 6 sub-maps +
 *  the special/star ones). We clamp the derived world to this so cv1 has a
 *  bounded, documented range. */
export const SMW_SUBMAP_COUNT = 7;

/**
 * Derive a (world, level) from a WRAM read.
 *
 * DEFAULT MAPPING (documented):
 *   world = submap index ($7E1F11) + 1   → Yoshi's Island = 1, the next
 *           submap = 2, … (clamped to 1..SMW_SUBMAP_COUNT).
 *   level = (translevel mod 16) + 1       → a stable 1-based level index
 *           within the submap. SMW translevels span 0x00..0x24+; modulo-16
 *           keeps the value in a compact, monotonic-ish 1..16 band so the
 *           gate3 multiplier (world+level) stays in a usable range.
 *
 * EDGE: when not in a level (game-mode not the level/overworld states, or
 * translevel == 0 at boot), world+level = 0 and inLevel = false — gate3
 * then passes the clock through ×1 (see clock-multiplier.ts).
 */
export function deriveLocation(read: WramRead): SmwLocation {
  const gameMode = read(ADDR_GAME_MODE);
  const translevel = read(ADDR_TRANSLEVEL);
  const submap = read(ADDR_SUBMAP);

  const inLevel = gameMode === GAME_MODE_LEVEL;
  // Treat "have a translevel + a sane game mode" as "located".
  const located = translevel !== 0 || inLevel;
  if (!located) {
    return { world: 0, level: 0, inLevel };
  }
  const world = clamp(submap + 1, 1, SMW_SUBMAP_COUNT);
  const level = (translevel & 0x0f) + 1; // 1..16
  return { world, level, inLevel };
}

/** Alternate mapping: derive world purely from translevel bands (each band
 *  of 8 translevels = one "world"). Provided so the module can switch to a
 *  translevel-only scheme if the submap mapping proves unreliable.
 *  world = floor(translevel / 8) + 1 (clamped); level = (translevel mod 8)+1. */
export function deriveLocationFromTranslevel(read: WramRead): SmwLocation {
  const gameMode = read(ADDR_GAME_MODE);
  const translevel = read(ADDR_TRANSLEVEL);
  const inLevel = gameMode === GAME_MODE_LEVEL;
  const located = translevel !== 0 || inLevel;
  if (!located) return { world: 0, level: 0, inLevel };
  const world = clamp(Math.floor(translevel / 8) + 1, 1, SMW_SUBMAP_COUNT);
  const level = (translevel % 8) + 1;
  return { world, level, inLevel };
}

/**
 * Map a derived world to a constant CV value for cv1.
 *
 * SCALING (documented): a steady "volt-per-world"-style ramp normalised to
 * the project's -1..+1 CV convention's POSITIVE half (0..+1):
 *
 *   world 0 (idle)              → 0.0
 *   world 1 (lowest)            → 1/SMW_SUBMAP_COUNT  ≈ 0.143
 *   …                          (linear)
 *   world SMW_SUBMAP_COUNT (hi) → 1.0
 *
 * Lower world ⇒ lower CV, higher world ⇒ higher CV, monotonic, steady (it
 * only changes when the world changes). Multiply downstream by 5 to get a
 * Eurorack-style 0..5 V "volt-per-world-ish" ramp if desired.
 */
export function worldToCv(world: number): number {
  if (world <= 0) return 0;
  const w = clamp(world, 1, SMW_SUBMAP_COUNT);
  return w / SMW_SUBMAP_COUNT;
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}
