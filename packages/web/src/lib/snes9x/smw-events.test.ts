// packages/web/src/lib/snes9x/smw-events.test.ts
//
// Pure unit tests for the SMW game-event detection state machine, the
// world/level derivation, and the world→cv1 mapping. All driven by
// synthetic WRAM byte snapshots — no emulator.

import { describe, it, expect } from 'vitest';
import {
  ADDR_GAME_MODE,
  ADDR_LIVES,
  ADDR_PLAYER_ANIM,
  ADDR_TRANSLEVEL,
  ADDR_SUBMAP,
  ADDR_SPRITE_STATUS_BASE,
  GAME_MODE_LEVEL,
  PLAYER_ANIM_DEAD,
  SMW_SUBMAP_COUNT,
  makeSmwDetectorState,
  detectSmwEvents,
  deriveLocation,
  deriveLocationFromTranslevel,
  worldToCv,
  wramReader,
  spriteIsAlive,
  spriteIsKilled,
} from './smw-events';

/** Build a 128 KB WRAM snapshot from an address→value map. */
function wram(values: Record<number, number>): Uint8Array {
  const w = new Uint8Array(0x20000);
  for (const [a, v] of Object.entries(values)) w[Number(a)] = v;
  return w;
}

describe('sprite status helpers', () => {
  it('classifies alive (>=0x08) vs killed (0x02..0x06)', () => {
    expect(spriteIsAlive(0x08)).toBe(true);
    expect(spriteIsAlive(0x0a)).toBe(true);
    expect(spriteIsAlive(0x07)).toBe(false);
    expect(spriteIsAlive(0x00)).toBe(false);
    for (const k of [0x02, 0x03, 0x04, 0x05, 0x06]) expect(spriteIsKilled(k)).toBe(true);
    // empty/init are NOT kills (despawn, not a kill).
    expect(spriteIsKilled(0x00)).toBe(false);
    expect(spriteIsKilled(0x01)).toBe(false);
    expect(spriteIsKilled(0x08)).toBe(false);
  });
});

describe('detectSmwEvents — priming', () => {
  it('emits nothing on the first frame (seeds baselines)', () => {
    const st = makeSmwDetectorState();
    const w = wram({ [ADDR_SPRITE_STATUS_BASE]: 0x09, [ADDR_PLAYER_ANIM]: 0x09 });
    expect(detectSmwEvents(st, wramReader(w))).toEqual([]);
    expect(st.primed).toBe(true);
  });
});

describe('detectSmwEvents — KILL detection', () => {
  it('fires one kill when a sprite slot goes alive→spinjump-killed', () => {
    const st = makeSmwDetectorState();
    // Frame 1: slot 0 alive (0x09).
    detectSmwEvents(st, wramReader(wram({ [ADDR_SPRITE_STATUS_BASE]: 0x09 })));
    // Frame 2: slot 0 → 0x04 (spinjump kill).
    const evs = detectSmwEvents(st, wramReader(wram({ [ADDR_SPRITE_STATUS_BASE]: 0x04 })));
    expect(evs.filter((e) => e.type === 'kill')).toHaveLength(1);
  });

  it('fires per-slot for each killed monster in one frame', () => {
    const st = makeSmwDetectorState();
    detectSmwEvents(st, wramReader(wram({
      [ADDR_SPRITE_STATUS_BASE + 0]: 0x09,
      [ADDR_SPRITE_STATUS_BASE + 1]: 0x0a,
      [ADDR_SPRITE_STATUS_BASE + 2]: 0x08,
    })));
    const evs = detectSmwEvents(st, wramReader(wram({
      [ADDR_SPRITE_STATUS_BASE + 0]: 0x03, // smush
      [ADDR_SPRITE_STATUS_BASE + 1]: 0x04, // spinjump
      [ADDR_SPRITE_STATUS_BASE + 2]: 0x08, // still alive — no kill
    })));
    expect(evs.filter((e) => e.type === 'kill')).toHaveLength(2);
  });

  it('debounces — a slot stuck at a killed status does not re-fire', () => {
    const st = makeSmwDetectorState();
    detectSmwEvents(st, wramReader(wram({ [ADDR_SPRITE_STATUS_BASE]: 0x09 })));
    const f2 = detectSmwEvents(st, wramReader(wram({ [ADDR_SPRITE_STATUS_BASE]: 0x04 })));
    expect(f2.filter((e) => e.type === 'kill')).toHaveLength(1);
    // Frame 3: still 0x04 — no new kill.
    const f3 = detectSmwEvents(st, wramReader(wram({ [ADDR_SPRITE_STATUS_BASE]: 0x04 })));
    expect(f3.filter((e) => e.type === 'kill')).toHaveLength(0);
  });

  it('does NOT count alive→empty (despawn) as a kill', () => {
    const st = makeSmwDetectorState();
    detectSmwEvents(st, wramReader(wram({ [ADDR_SPRITE_STATUS_BASE]: 0x09 })));
    const evs = detectSmwEvents(st, wramReader(wram({ [ADDR_SPRITE_STATUS_BASE]: 0x00 })));
    expect(evs.filter((e) => e.type === 'kill')).toHaveLength(0);
  });
});

describe('detectSmwEvents — DEATH detection', () => {
  it('fires one death on $0071 rising into 0x09', () => {
    const st = makeSmwDetectorState();
    detectSmwEvents(st, wramReader(wram({ [ADDR_PLAYER_ANIM]: 0x00, [ADDR_LIVES]: 4 })));
    const evs = detectSmwEvents(st, wramReader(wram({ [ADDR_PLAYER_ANIM]: PLAYER_ANIM_DEAD, [ADDR_LIVES]: 4 })));
    expect(evs.filter((e) => e.type === 'death')).toHaveLength(1);
  });

  it('does not re-fire while $0071 stays at 0x09', () => {
    const st = makeSmwDetectorState();
    detectSmwEvents(st, wramReader(wram({ [ADDR_PLAYER_ANIM]: 0x00, [ADDR_LIVES]: 4 })));
    detectSmwEvents(st, wramReader(wram({ [ADDR_PLAYER_ANIM]: 0x09, [ADDR_LIVES]: 4 })));
    const f3 = detectSmwEvents(st, wramReader(wram({ [ADDR_PLAYER_ANIM]: 0x09, [ADDR_LIVES]: 4 })));
    expect(f3.filter((e) => e.type === 'death')).toHaveLength(0);
  });

  it('lives-decrement fallback fires a death, de-duped with the anim signal', () => {
    const st = makeSmwDetectorState();
    detectSmwEvents(st, wramReader(wram({ [ADDR_GAME_MODE]: GAME_MODE_LEVEL, [ADDR_PLAYER_ANIM]: 0x00, [ADDR_LIVES]: 4 })));
    // Lives drop 4→3 AND anim goes to 0x09 — must be exactly ONE death.
    const evs = detectSmwEvents(st, wramReader(wram({ [ADDR_GAME_MODE]: GAME_MODE_LEVEL, [ADDR_PLAYER_ANIM]: 0x09, [ADDR_LIVES]: 3 })));
    expect(evs.filter((e) => e.type === 'death')).toHaveLength(1);
  });

  it('lives-decrement alone (no anim) still fires a death while in a playing game mode', () => {
    const st = makeSmwDetectorState();
    detectSmwEvents(st, wramReader(wram({ [ADDR_GAME_MODE]: GAME_MODE_LEVEL, [ADDR_PLAYER_ANIM]: 0x00, [ADDR_LIVES]: 4 })));
    const evs = detectSmwEvents(st, wramReader(wram({ [ADDR_GAME_MODE]: GAME_MODE_LEVEL, [ADDR_PLAYER_ANIM]: 0x00, [ADDR_LIVES]: 3 })));
    expect(evs.filter((e) => e.type === 'death')).toHaveLength(1);
  });

  it('a 1-up (lives increment) is NOT a death', () => {
    const st = makeSmwDetectorState();
    detectSmwEvents(st, wramReader(wram({ [ADDR_GAME_MODE]: GAME_MODE_LEVEL, [ADDR_PLAYER_ANIM]: 0x00, [ADDR_LIVES]: 4 })));
    const evs = detectSmwEvents(st, wramReader(wram({ [ADDR_GAME_MODE]: GAME_MODE_LEVEL, [ADDR_PLAYER_ANIM]: 0x00, [ADDR_LIVES]: 5 })));
    expect(evs.filter((e) => e.type === 'death')).toHaveLength(0);
  });

  it('ignores a lives-"drop" from uninitialised boot RAM (no real game mode)', () => {
    // Regression for the boot phantom death the gameplay e2e surfaced: at boot
    // $7E0DBE reads garbage (e.g. 0x55) then settles to 0x00 while $7E0100 is
    // still a non-playing mode ($00). That MUST NOT register a death.
    const st = makeSmwDetectorState();
    detectSmwEvents(st, wramReader(wram({ [ADDR_GAME_MODE]: 0x00, [ADDR_PLAYER_ANIM]: 0x00, [ADDR_LIVES]: 0x55 })));
    const evs = detectSmwEvents(st, wramReader(wram({ [ADDR_GAME_MODE]: 0x00, [ADDR_PLAYER_ANIM]: 0x00, [ADDR_LIVES]: 0x00 })));
    expect(evs.filter((e) => e.type === 'death')).toHaveLength(0);
  });

  it('ignores a lives-drop when the lives count is out of the valid 0..99 range', () => {
    // Even in a playing mode, an out-of-range lives value (garbage) must not
    // trigger the fallback — only a real, in-range decrement counts.
    const st = makeSmwDetectorState();
    detectSmwEvents(st, wramReader(wram({ [ADDR_GAME_MODE]: GAME_MODE_LEVEL, [ADDR_PLAYER_ANIM]: 0x00, [ADDR_LIVES]: 0xff })));
    const evs = detectSmwEvents(st, wramReader(wram({ [ADDR_GAME_MODE]: GAME_MODE_LEVEL, [ADDR_PLAYER_ANIM]: 0x00, [ADDR_LIVES]: 0x70 })));
    expect(evs.filter((e) => e.type === 'death')).toHaveLength(0);
  });

  it('the anim→0x09 death fires regardless of game mode (primary signal)', () => {
    // The primary death signal (player anim rising into 0x09) is NOT gated on
    // game mode — only the lives-drop FALLBACK is.
    const st = makeSmwDetectorState();
    detectSmwEvents(st, wramReader(wram({ [ADDR_PLAYER_ANIM]: 0x00, [ADDR_LIVES]: 4 })));
    const evs = detectSmwEvents(st, wramReader(wram({ [ADDR_PLAYER_ANIM]: PLAYER_ANIM_DEAD, [ADDR_LIVES]: 4 })));
    expect(evs.filter((e) => e.type === 'death')).toHaveLength(1);
  });
});

describe('detectSmwEvents — LEVEL CHANGE detection', () => {
  it('fires on translevel change', () => {
    const st = makeSmwDetectorState();
    detectSmwEvents(st, wramReader(wram({ [ADDR_TRANSLEVEL]: 0x05 })));
    const evs = detectSmwEvents(st, wramReader(wram({ [ADDR_TRANSLEVEL]: 0x06 })));
    expect(evs.filter((e) => e.type === 'level_change')).toHaveLength(1);
  });

  it('fires on submap change', () => {
    const st = makeSmwDetectorState();
    detectSmwEvents(st, wramReader(wram({ [ADDR_SUBMAP]: 0 })));
    const evs = detectSmwEvents(st, wramReader(wram({ [ADDR_SUBMAP]: 1 })));
    expect(evs.filter((e) => e.type === 'level_change')).toHaveLength(1);
  });

  it('does not fire when neither changes', () => {
    const st = makeSmwDetectorState();
    detectSmwEvents(st, wramReader(wram({ [ADDR_TRANSLEVEL]: 0x05, [ADDR_SUBMAP]: 1 })));
    const evs = detectSmwEvents(st, wramReader(wram({ [ADDR_TRANSLEVEL]: 0x05, [ADDR_SUBMAP]: 1 })));
    expect(evs.filter((e) => e.type === 'level_change')).toHaveLength(0);
  });
});

describe('deriveLocation — world/level mapping', () => {
  it('idle (no translevel, not in level) → world 0 level 0', () => {
    const loc = deriveLocation(wramReader(wram({ [ADDR_GAME_MODE]: 0x07, [ADDR_TRANSLEVEL]: 0 })));
    expect(loc).toEqual({ world: 0, level: 0, inLevel: false });
  });

  it('submap 0 → world 1; translevel low nibble → level', () => {
    const loc = deriveLocation(wramReader(wram({
      [ADDR_GAME_MODE]: GAME_MODE_LEVEL,
      [ADDR_SUBMAP]: 0,
      [ADDR_TRANSLEVEL]: 0x02,
    })));
    expect(loc.world).toBe(1);
    expect(loc.level).toBe(0x02 + 1);
    expect(loc.inLevel).toBe(true);
  });

  it('higher submap → higher world (clamped to SMW_SUBMAP_COUNT)', () => {
    const loc = deriveLocation(wramReader(wram({
      [ADDR_GAME_MODE]: GAME_MODE_LEVEL,
      [ADDR_SUBMAP]: 20, // beyond count → clamps
      [ADDR_TRANSLEVEL]: 0x10,
    })));
    expect(loc.world).toBe(SMW_SUBMAP_COUNT);
    expect(loc.level).toBe((0x10 & 0x0f) + 1);
  });

  it('translevel-only mapping bands worlds by 8', () => {
    const loc = deriveLocationFromTranslevel(wramReader(wram({
      [ADDR_GAME_MODE]: GAME_MODE_LEVEL,
      [ADDR_TRANSLEVEL]: 0x11, // 17 → world floor(17/8)+1 = 3, level 17%8+1=2
    })));
    expect(loc.world).toBe(3);
    expect(loc.level).toBe(2);
  });
});

describe('worldToCv — world → cv1 scaling', () => {
  it('idle world 0 → 0', () => {
    expect(worldToCv(0)).toBe(0);
  });

  it('monotonic: lower world = lower CV, higher = higher', () => {
    let prev = -1;
    for (let w = 1; w <= SMW_SUBMAP_COUNT; w++) {
      const cv = worldToCv(w);
      expect(cv).toBeGreaterThan(prev);
      prev = cv;
    }
  });

  it('world 1 = 1/N, top world = 1.0', () => {
    expect(worldToCv(1)).toBeCloseTo(1 / SMW_SUBMAP_COUNT, 6);
    expect(worldToCv(SMW_SUBMAP_COUNT)).toBe(1);
  });

  it('clamps above the top world', () => {
    expect(worldToCv(99)).toBe(1);
  });
});
