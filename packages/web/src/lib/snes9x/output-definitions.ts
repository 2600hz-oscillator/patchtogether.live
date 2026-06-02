// packages/web/src/lib/snes9x/output-definitions.ts
//
// Per-ROM CV/GATE OUTPUT DEFINITION registry for the SNES9X module.
//
// The right-click "see output definition for CV/GATES" menu item opens a
// panel that, when a ROM is loaded, explains what each of the module's 8
// game-event outputs (gate1..gate4, cv1..cv4) does FOR THAT GAME. This
// registry is the data behind that panel: a map keyed by a per-ROM game id
// → an ordered list of {port, label, description} rows.
//
// The detection logic itself lives in smw-events.ts (pure, RAM-snapshot
// driven). This file is the human-facing documentation of the wiring, kept
// next to the code so the two never drift. The module documents EVERY RAM
// address it reads here too (so the panel doubles as the in-app RAM-map
// reference the spec asks for).
//
// Adding a new ROM = add a `GameOutputDef` entry + (in the module factory)
// the detection wiring. SMW is the first populated game; other ROMs fall
// back to GENERIC_OUTPUT_DEF (outputs present but inert / reserved).

export interface OutputPortDoc {
  /** Output port id on the module (gate1..gate4 / cv1..cv4). */
  port: string;
  /** Short human label, e.g. "KILL". */
  label: string;
  /** What the output does for this game + the RAM address(es) behind it. */
  description: string;
  /** True when this output is ACTIVE for this game; false = reserved/idle. */
  active: boolean;
}

export interface GameOutputDef {
  /** Stable per-game id (the key). */
  id: string;
  /** Display title, e.g. "Super Mario World". */
  title: string;
  /** Ordered output rows (gates then CVs). */
  outputs: OutputPortDoc[];
  /** Free-text notes — world/level mapping, clock-multiplier behaviour, etc. */
  notes: string[];
}

/** Super Mario World (USA) — the first populated game. */
export const SMW_OUTPUT_DEF: GameOutputDef = {
  id: 'smw',
  title: 'Super Mario World',
  outputs: [
    {
      port: 'gate1',
      label: 'KILL',
      description:
        'Pulse when Mario kills a monster. Watches the sprite status table ' +
        '$7E14C8..$7E14D3 (12 slots) for any slot transitioning from ALIVE ' +
        '(status >= $08) to a KILLED status ($02 fall, $03 smush/stomp, ' +
        '$04 spinjump, $05 burn/sink, $06 → coin). One pulse per kill ' +
        '(debounced per slot).',
      active: true,
    },
    {
      port: 'gate2',
      label: 'DEATH',
      description:
        'Pulse when Mario dies. Watches the player animation trigger ' +
        '$7E0071 rising into $09 (the death animation), with a lives-' +
        'decrement fallback ($7E0DBE drops). One pulse per death.',
      active: true,
    },
    {
      port: 'gate3',
      label: 'CLOCK ×(world+level)',
      description:
        'Clock MULTIPLIER. Takes clock_in, measures its period, and outputs ' +
        '(world + level) evenly-spaced pulses per input period. world+level ' +
        'is derived from the overworld submap $7E1F11 (world = submap+1) and ' +
        'the translevel $7E13BF (level = (translevel & $0F)+1). Not in a ' +
        'level / world+level = 0 → passes the clock through ×1.',
      active: true,
    },
    {
      port: 'gate4',
      label: '(reserved)',
      description: 'Reserved for a future SMW signal. Present but idle.',
      active: false,
    },
    {
      port: 'cv1',
      label: 'WORLD CV',
      description:
        'Constant CV for the current world (lower world = lower value). ' +
        'world is derived from the overworld submap $7E1F11 (world = ' +
        'submap+1, clamped 1..7); CV = world / 7 → 0.143 (world 1) up to ' +
        '1.0 (world 7), 0 when idle. Steady — only changes on a world change.',
      active: true,
    },
    { port: 'cv2', label: '(reserved)', description: 'Reserved. Present but idle.', active: false },
    { port: 'cv3', label: '(reserved)', description: 'Reserved. Present but idle.', active: false },
    { port: 'cv4', label: '(reserved)', description: 'Reserved. Present but idle.', active: false },
  ],
  notes: [
    'World/level mapping: SMW has no clean world/level grid. DEFAULT: ' +
      'world = overworld submap $7E1F11 + 1 (Yoshi’s Island = 1, next ' +
      'submap = 2, … clamped 1..7); level = (translevel $7E13BF & $0F) + 1.',
    'RAM addresses used: $7E0100 game mode, $7E0DBE lives (minus one), ' +
      '$7E0071 player animation ($09 = death), $7E13BF translevel, ' +
      '$7E1F11 overworld submap, $7E14C8..$7E14D3 sprite status table.',
    'Clock multiplier: N = world+level; first sub-pulse is in phase with ' +
      'the incoming edge (so ×1 is a clean passthrough); subdivisions ' +
      'replay the just-measured period at period/N spacing (one period of ' +
      'measure-then-multiply latency).',
    'gate4 + cv2/cv3/cv4 are present but inactive for SMW (reserved for ' +
      'future signals / future ROMs).',
  ],
};

/** Generic fallback for ROMs without a populated definition. */
export const GENERIC_OUTPUT_DEF: GameOutputDef = {
  id: 'generic',
  title: 'Unknown ROM',
  outputs: [
    { port: 'gate1', label: 'gate1', description: 'No game-event definition for this ROM yet.', active: false },
    { port: 'gate2', label: 'gate2', description: 'No game-event definition for this ROM yet.', active: false },
    { port: 'gate3', label: 'CLOCK', description: 'Clock multiplier passes clock_in through ×1 (no world/level data for this ROM).', active: false },
    { port: 'gate4', label: 'gate4', description: 'No game-event definition for this ROM yet.', active: false },
    { port: 'cv1', label: 'cv1', description: 'No game-event definition for this ROM yet.', active: false },
    { port: 'cv2', label: 'cv2', description: 'Reserved.', active: false },
    { port: 'cv3', label: 'cv3', description: 'Reserved.', active: false },
    { port: 'cv4', label: 'cv4', description: 'Reserved.', active: false },
  ],
  notes: [
    'This ROM has no per-game output definition. Outputs are present so ' +
      'cables can be wired, but game-event detection is inert. Add a ' +
      'GameOutputDef + detection wiring to populate them.',
  ],
};

/** Registry keyed by game id. */
export const OUTPUT_DEFINITIONS: Record<string, GameOutputDef> = {
  smw: SMW_OUTPUT_DEF,
  generic: GENERIC_OUTPUT_DEF,
};

/**
 * Identify the loaded ROM's game id from its bytes. v1 detects Super Mario
 * World via the SNES internal header title ("SUPER MARIOWORLD") at the
 * standard LoROM header offset $7FC0 (21 bytes, space-padded). Other ROMs
 * return 'generic'. Pure: same bytes → same id.
 */
export function identifyGame(rom: Uint8Array | null): string {
  if (!rom || rom.length < 0x8000) return 'generic';
  const title = readHeaderTitle(rom);
  if (title.replace(/\s+/g, '').toUpperCase().startsWith('SUPERMARIOWORLD')) {
    return 'smw';
  }
  return 'generic';
}

/** Read the 21-byte SNES internal-header game title. Handles the optional
 *  512-byte copier header + both LoROM ($7FC0) and HiROM ($FFC0) layouts;
 *  returns whichever yields the most printable-ASCII title. */
export function readHeaderTitle(rom: Uint8Array): string {
  const hasCopierHeader = rom.length % 1024 === 512;
  const base = hasCopierHeader ? 512 : 0;
  const candidates = [0x7fc0, 0xffc0];
  let best = '';
  let bestScore = -1;
  for (const off of candidates) {
    const start = base + off;
    if (start + 21 > rom.length) continue;
    let s = '';
    let printable = 0;
    for (let i = 0; i < 21; i++) {
      const c = rom[start + i] ?? 0;
      if (c >= 0x20 && c <= 0x7e) printable++;
      s += String.fromCharCode(c);
    }
    if (printable > bestScore) {
      bestScore = printable;
      best = s;
    }
  }
  return best.trim();
}

/** Look up the output definition for a game id (falls back to generic). */
export function getOutputDefinition(gameId: string): GameOutputDef {
  return OUTPUT_DEFINITIONS[gameId] ?? GENERIC_OUTPUT_DEF;
}
