// doom-death-ports.test.ts
//
// Locks the static port catalog for the per-monster-type kill gates +
// per-player death gates added in feat/doom-per-type-death-gates.
// Cheap & DECLARATIVE: catches accidental renames, mobjtype-id drift, or
// removal of shareware-floor monsters — any of which would silently mis-
// route a kill event into a dropped gate.

import { describe, it, expect } from 'vitest';
import {
  MONSTER_KILL_PORTS,
  PLAYER_DEATH_PORTS,
  MOBJTYPE_TO_PORT_ID,
  PLAYER_SLOT_TO_DEATH_PORT_ID,
  ALL_NEW_EVT_PORT_IDS,
  NEW_EVT_PORT_COUNT,
  MT_POSSESSED,
  MT_SHOTGUY,
  MT_TROOP,
  MT_SERGEANT,
  MT_SHADOWS,
  MT_SKULL,
  MT_HEAD,
  MT_BRUISER,
  MT_KNIGHT,
  MT_VILE,
  MT_UNDEAD,
  MT_FATSO,
  MT_CHAINGUY,
  MT_PAIN,
  MT_BABY,
  MT_SPIDER,
  MT_CYBORG,
  MT_WOLFSS,
  MT_KEEN,
} from './doom-death-ports';

describe('doom-death-ports — monster mobjtype id constants', () => {
  // Pinned against vendored info.h (mobjtype_t enum). A vendor source
  // shuffle that renumbers the enum breaks this immediately rather than
  // silently shipping a per-type kill event with the WRONG port firing.
  it('mobjtype constants match the vendored info.h enum order', () => {
    expect(MT_POSSESSED).toBe(1);
    expect(MT_SHOTGUY).toBe(2);
    expect(MT_VILE).toBe(3);
    expect(MT_UNDEAD).toBe(5);
    expect(MT_FATSO).toBe(8);
    expect(MT_CHAINGUY).toBe(10);
    expect(MT_TROOP).toBe(11);
    expect(MT_SERGEANT).toBe(12);
    expect(MT_SHADOWS).toBe(13);
    expect(MT_HEAD).toBe(14);
    expect(MT_BRUISER).toBe(15);
    expect(MT_KNIGHT).toBe(17);
    expect(MT_SKULL).toBe(18);
    expect(MT_SPIDER).toBe(19);
    expect(MT_BABY).toBe(20);
    expect(MT_CYBORG).toBe(21);
    expect(MT_PAIN).toBe(22);
    expect(MT_WOLFSS).toBe(23);
    expect(MT_KEEN).toBe(24);
  });

  it('every mobjtype id fits in 12 bits (the payload field)', () => {
    for (const port of MONSTER_KILL_PORTS) {
      expect(port.mobjtype, `${port.portId} mobjtype out of 12-bit range`).toBeLessThan(1 << 12);
      expect(port.mobjtype).toBeGreaterThan(0);
    }
  });
});

describe('doom-death-ports — port catalog shape', () => {
  it('every MONSTER_KILL_PORTS row has a unique portId starting with evt_kill_', () => {
    const seen = new Set<string>();
    for (const port of MONSTER_KILL_PORTS) {
      expect(port.portId.startsWith('evt_kill_'), `${port.portId} should start with evt_kill_`).toBe(true);
      expect(seen.has(port.portId), `duplicate portId ${port.portId}`).toBe(false);
      seen.add(port.portId);
    }
  });

  it('every MONSTER_KILL_PORTS row has a unique mobjtype id', () => {
    const seen = new Set<number>();
    for (const port of MONSTER_KILL_PORTS) {
      expect(seen.has(port.mobjtype), `duplicate mobjtype ${port.mobjtype}`).toBe(false);
      seen.add(port.mobjtype);
    }
  });

  it('shareware E1 monsters are flagged shareware=true (the WAD we ship)', () => {
    // Floor: every monster that can appear in shareware E1 player kills.
    const sharewarePortIds = MONSTER_KILL_PORTS.filter((p) => p.shareware).map((p) => p.portId);
    // 8 monsters from shareware E1.
    expect(sharewarePortIds).toEqual([
      'evt_kill_zombieman', 'evt_kill_shotguy', 'evt_kill_imp',
      'evt_kill_demon', 'evt_kill_spectre', 'evt_kill_lostsoul',
      'evt_kill_caco', 'evt_kill_baron',
    ]);
  });

  it('PLAYER_DEATH_PORTS lists exactly 4 slots in order', () => {
    expect(PLAYER_DEATH_PORTS.map((p) => p.portId)).toEqual([
      'evt_p1_dies', 'evt_p2_dies', 'evt_p3_dies', 'evt_p4_dies',
    ]);
    expect(PLAYER_DEATH_PORTS.map((p) => p.slot)).toEqual([0, 1, 2, 3]);
  });

  it('MOBJTYPE_TO_PORT_ID is consistent with MONSTER_KILL_PORTS', () => {
    expect(MOBJTYPE_TO_PORT_ID.size).toBe(MONSTER_KILL_PORTS.length);
    for (const port of MONSTER_KILL_PORTS) {
      expect(MOBJTYPE_TO_PORT_ID.get(port.mobjtype)).toBe(port.portId);
    }
  });

  it('PLAYER_SLOT_TO_DEATH_PORT_ID maps every slot 0..3', () => {
    expect(PLAYER_SLOT_TO_DEATH_PORT_ID.get(0)).toBe('evt_p1_dies');
    expect(PLAYER_SLOT_TO_DEATH_PORT_ID.get(1)).toBe('evt_p2_dies');
    expect(PLAYER_SLOT_TO_DEATH_PORT_ID.get(2)).toBe('evt_p3_dies');
    expect(PLAYER_SLOT_TO_DEATH_PORT_ID.get(3)).toBe('evt_p4_dies');
  });

  it('ALL_NEW_EVT_PORT_IDS = monster ports ++ player ports, no overlap', () => {
    expect(ALL_NEW_EVT_PORT_IDS).toEqual([
      ...MONSTER_KILL_PORTS.map((p) => p.portId),
      ...PLAYER_DEATH_PORTS.map((p) => p.portId),
    ]);
    expect(new Set(ALL_NEW_EVT_PORT_IDS).size).toBe(ALL_NEW_EVT_PORT_IDS.length);
    expect(NEW_EVT_PORT_COUNT).toBe(ALL_NEW_EVT_PORT_IDS.length);
  });

  it('no new port id collides with the legacy base event gates', () => {
    const legacy = new Set([
      'evt_kill', 'evt_door',
      'evt_gun_p1', 'evt_gun_p2', 'evt_gun_p3', 'evt_gun_p4',
    ]);
    for (const id of ALL_NEW_EVT_PORT_IDS) {
      expect(legacy.has(id), `${id} collides with a legacy base gate`).toBe(false);
    }
  });
});
