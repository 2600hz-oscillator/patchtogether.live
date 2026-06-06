// doom-death-ports.ts
//
// Per-monster-type kill gate + per-player death gate output port catalog.
//
// Wire format:
//   * The C engine (`P_KillMobj` in p_inter.c) emits two events on a counted
//     monster kill: legacy `DGPT_EVT_KILL` (any-monster gate, untouched) and
//     `DGPT_EVT_KILL_TYPED` with the C-side mobjtype_t id in bits 4..15.
//     A player death emits `DGPT_EVT_PLAYER_DIES` with the slot in bits 4..5.
//   * The JS module factory drains the ring once per surface tick and pulses
//     the matching ConstantSourceNode (10 ms HIGH, same shape as the existing
//     event gates → subscribePulse-compatible).
//
// MOBJTYPE_TO_PORT mirrors the `mobjtype_t` enum in
// packages/web/native/doomgeneric/doomgeneric/info.h. We only enumerate the
// counted MONSTER types (those with MF_COUNTKILL): the shareware E1 set
// (Zombieman, Sergeant, Imp, Demon, Spectre, Lost Soul, Cacodemon, Baron of
// Hell) PLUS the Doom-II + ultimate-Doom monsters (Chaingunner, Revenant,
// Mancubus, Arch-Vile, Hell Knight, Pain Elemental, Arachnotron, Spider
// Mastermind, Cyberdemon, Wolfenstein SS, Commander Keen). Non-counted
// things (barrels, projectiles, decorations, pickup items, players) are
// EXCLUDED — they wouldn't fire a typed kill event anyway, so listing them
// here would just bloat the port row.
//
// ORDER MATTERS — the array order is the stable declaration order in
// doomDef.outputs so the engine-bridge sweep + composite VRT pin the same
// port layout across releases. Adding a new monster type appends to the
// END of this array; never insert in the middle (that would shift saved
// patches' edge port-ids under the hood). Removing a type is a breaking
// change for any saved patch wired into it.

/**
 * Monster mobjtype_t enum values from
 * packages/web/native/doomgeneric/doomgeneric/info.h. Lock these to literal
 * numbers (not a re-export) so a stray vendor-source reshuffle would surface
 * as a doom-death-ports test failure rather than silent mis-routing.
 *
 * Values verified 2026-05-29 against vendored info.h (mobjtype_t enum).
 */
export const MT_POSSESSED = 1; // Zombieman
export const MT_SHOTGUY = 2;
export const MT_VILE = 3; // Arch-Vile
export const MT_UNDEAD = 5; // Revenant
export const MT_FATSO = 8; // Mancubus
export const MT_CHAINGUY = 10;
export const MT_TROOP = 11; // Imp
export const MT_SERGEANT = 12; // Demon (pinky)
export const MT_SHADOWS = 13; // Spectre
export const MT_HEAD = 14; // Cacodemon
export const MT_BRUISER = 15; // Baron of Hell
export const MT_KNIGHT = 17; // Hell Knight
export const MT_SKULL = 18; // Lost Soul
export const MT_SPIDER = 19; // Spider Mastermind
export const MT_BABY = 20; // Arachnotron
export const MT_CYBORG = 21; // Cyberdemon
export const MT_PAIN = 22; // Pain Elemental
export const MT_WOLFSS = 23; // Wolfenstein SS
export const MT_KEEN = 24; // Commander Keen

export interface MonsterKillPort {
  /** C-side mobjtype_t enum id. */
  mobjtype: number;
  /** Output port id on doomDef. Pattern: `evt_kill_<short-name>`. */
  portId: string;
  /** Human-readable label for the PatchPanel right-column row. */
  label: string;
  /** True if this monster appears in the shareware E1 IWAD we ship. The
   *  e2e/unit sweep treats this as the floor: a regression that drops one of
   *  these is a hard failure. Non-shareware monsters still get ports
   *  (full-IWAD users patch them), but their absence in a shareware-only run
   *  is expected. */
  shareware: boolean;
}

/**
 * Per-monster kill gate output ports — order is stable across releases.
 *
 * Index in this list = position in doomDef.outputs after the base outputs +
 * the legacy per-player gun gates. New ports APPEND only.
 */
export const MONSTER_KILL_PORTS: readonly MonsterKillPort[] = [
  // ── Shareware E1 monsters (every one MUST fire its gate on a real kill) ──
  { mobjtype: MT_POSSESSED, portId: 'evt_kill_zombieman', label: 'KILL ZOMBIEMAN',  shareware: true },
  { mobjtype: MT_SHOTGUY,   portId: 'evt_kill_shotguy',   label: 'KILL SHOTGUNNER', shareware: true },
  { mobjtype: MT_TROOP,     portId: 'evt_kill_imp',       label: 'KILL IMP',        shareware: true },
  { mobjtype: MT_SERGEANT,  portId: 'evt_kill_demon',     label: 'KILL DEMON',      shareware: true },
  { mobjtype: MT_SHADOWS,   portId: 'evt_kill_spectre',   label: 'KILL SPECTRE',    shareware: true },
  { mobjtype: MT_SKULL,     portId: 'evt_kill_lostsoul',  label: 'KILL LOST SOUL',  shareware: true },
  { mobjtype: MT_HEAD,      portId: 'evt_kill_caco',      label: 'KILL CACO',       shareware: true },
  { mobjtype: MT_BRUISER,   portId: 'evt_kill_baron',     label: 'KILL BARON',      shareware: true },
  // ── DOOM II + Ultimate DOOM monsters (full-IWAD only) ──
  { mobjtype: MT_CHAINGUY,  portId: 'evt_kill_chainguy',  label: 'KILL CHAINGUNNER',   shareware: false },
  { mobjtype: MT_UNDEAD,    portId: 'evt_kill_revenant',  label: 'KILL REVENANT',      shareware: false },
  { mobjtype: MT_FATSO,     portId: 'evt_kill_mancubus',  label: 'KILL MANCUBUS',      shareware: false },
  { mobjtype: MT_VILE,      portId: 'evt_kill_vile',      label: 'KILL ARCH-VILE',     shareware: false },
  { mobjtype: MT_KNIGHT,    portId: 'evt_kill_knight',    label: 'KILL HELL KNIGHT',   shareware: false },
  { mobjtype: MT_PAIN,      portId: 'evt_kill_pain',      label: 'KILL PAIN ELEMENTAL', shareware: false },
  { mobjtype: MT_BABY,      portId: 'evt_kill_arachnotron', label: 'KILL ARACHNOTRON', shareware: false },
  { mobjtype: MT_SPIDER,    portId: 'evt_kill_spidermind', label: 'KILL SPIDER MASTERMIND', shareware: false },
  { mobjtype: MT_CYBORG,    portId: 'evt_kill_cyber',     label: 'KILL CYBERDEMON',    shareware: false },
  { mobjtype: MT_WOLFSS,    portId: 'evt_kill_wolfss',    label: 'KILL WOLF SS',       shareware: false },
  { mobjtype: MT_KEEN,      portId: 'evt_kill_keen',      label: 'KILL COMMANDER KEEN', shareware: false },
] as const;

/** Per-player death gate output ports (evt_p1_dies..evt_p4_dies). */
export interface PlayerDeathPort {
  /** Player slot in the C-side players[] array (0..3). */
  slot: number;
  /** Output port id on doomDef. */
  portId: string;
  /** PatchPanel label. */
  label: string;
}

export const PLAYER_DEATH_PORTS: readonly PlayerDeathPort[] = [
  { slot: 0, portId: 'evt_p1_dies', label: 'P1 DIES' },
  { slot: 1, portId: 'evt_p2_dies', label: 'P2 DIES' },
  { slot: 2, portId: 'evt_p3_dies', label: 'P3 DIES' },
  { slot: 3, portId: 'evt_p4_dies', label: 'P4 DIES' },
] as const;

/** Lookup: mobjtype_t → portId. O(1) dispatch from the C event drain into
 *  the matching ConstantSourceNode pulse. Returns null for non-monster
 *  types or types we don't expose (the legacy `evt_kill` any-monster gate
 *  still fires regardless). */
export const MOBJTYPE_TO_PORT_ID: ReadonlyMap<number, string> = new Map(
  MONSTER_KILL_PORTS.map((p) => [p.mobjtype, p.portId]),
);

/** Lookup: player slot (0..3) → portId. */
export const PLAYER_SLOT_TO_DEATH_PORT_ID: ReadonlyMap<number, string> = new Map(
  PLAYER_DEATH_PORTS.map((p) => [p.slot, p.portId]),
);

/** Union of every new event gate port id (per-monster + per-player). The
 *  module factory iterates this to set up per-port CSNs, subscribers, and
 *  forcePulse handling. */
export const ALL_NEW_EVT_PORT_IDS: readonly string[] = [
  ...MONSTER_KILL_PORTS.map((p) => p.portId),
  ...PLAYER_DEATH_PORTS.map((p) => p.portId),
];

/** Total count for the static port-shape unit test. */
export const NEW_EVT_PORT_COUNT = ALL_NEW_EVT_PORT_IDS.length;
