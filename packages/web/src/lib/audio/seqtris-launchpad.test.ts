// The SEQTRIS ↔ Launchpad seam: the owner's control map, the claim, the
// key filtering, and the LED picture of the board.
//
// The scene column is the one place in this module where a wrong CONSTANT is
// silent rather than loud — a control mapped one row off still "works", it just
// does the wrong thing — so the map is asserted against the CC numbers, not
// against itself.

import { describe, it, expect, beforeEach } from 'vitest';
import {
  __test_resetLaunchpad,
  installSimulatedLaunchpadSingle,
  enumerateLaunchpadPorts,
  isUnitBound,
  type SimulatedLaunchpad,
} from '$lib/control/launchpad/launchpad-device.svelte';
import { SCENE_CCS, padNote, LP_HEIGHT } from '$lib/control/launchpad/launchpad-sysex';
import {
  acquireSeqtrisLaunchpad,
  seqtrisActionForScene,
  seqtrisStatusMessage,
  SEQTRIS_SCENE_ACTIONS,
  __test_resetSeqtrisLaunchpadOwner,
} from './seqtris-launchpad';
import {
  SEQTRIS_PIECE_RGB,
  cellIndex,
  createSeqtrisState,
  renderBoard,
  type SeqtrisInput,
  type SeqtrisPieceId,
} from '$lib/audio/modules/seqtris-engine';

describe('the scene-button control map', () => {
  it('is the owner\'s list, top to bottom', () => {
    expect([...SEQTRIS_SCENE_ACTIONS]).toEqual([
      'reset',
      null,
      null,
      'drop',
      'rotateLeft',
      'rotateRight',
      'moveLeft',
      'moveRight',
    ]);
  });

  it('rows 1 and 2 are deliberately dead', () => {
    expect(seqtrisActionForScene(1)).toBeNull();
    expect(seqtrisActionForScene(2)).toBeNull();
  });

  it('is indexed TOP-first, which is the opposite of the decoder\'s bottom-origin row', () => {
    // SCENE_CCS[0] is the TOP button (CC 89) and the owner's list starts at the
    // top, so index 0 must be RESET. `decodeMidiMessage`'s `ev.row` counts from
    // the BOTTOM — using it here would invert the whole controller.
    expect(SCENE_CCS[0]).toBe(89);
    expect(seqtrisActionForScene(0)).toBe('reset');
    expect(SCENE_CCS[7]).toBe(19);
    expect(seqtrisActionForScene(7)).toBe('moveRight');
  });

  it('is total — an out-of-range index is null, never a throw', () => {
    for (const i of [-1, 8, 99, 1.5, NaN]) expect(seqtrisActionForScene(i)).toBeNull();
  });

  it('every non-null action is a real engine input', () => {
    const legal: readonly SeqtrisInput[] = [
      'reset', 'drop', 'rotateLeft', 'rotateRight', 'moveLeft', 'moveRight',
    ];
    for (const a of SEQTRIS_SCENE_ACTIONS) {
      if (a !== null) expect(legal).toContain(a);
    }
  });
});

describe('status prose', () => {
  it('names the device when bound', () => {
    expect(seqtrisStatusMessage('bound', 'LPMiniMK3')).toContain('LPMiniMK3');
  });
  it('says what to do in every unbound state', () => {
    for (const kind of ['unsupported', 'idle', 'listing', 'no-device', 'claimed'] as const) {
      expect(seqtrisStatusMessage(kind, null).length).toBeGreaterThan(10);
    }
  });
});

describe('the binding', () => {
  let sim: SimulatedLaunchpad;

  beforeEach(async () => {
    __test_resetLaunchpad();
    __test_resetSeqtrisLaunchpadOwner();
    sim = await installSimulatedLaunchpadSingle();
  });

  it('CONNECT lists the attached device and leaves the module unbound', async () => {
    const seen: SeqtrisInput[] = [];
    const b = acquireSeqtrisLaunchpad('n1', (i) => seen.push(i));
    expect(b.status().kind).not.toBe('bound');
    await b.connect();
    expect(b.status().ports.length).toBeGreaterThan(0);
    expect(b.status().kind).toBe('idle');
    b.release();
  });

  it('binding claims the device and reports it by name', async () => {
    const b = acquireSeqtrisLaunchpad('n1', () => {});
    await b.connect();
    expect(b.bind(b.status().ports[0]!)).toBe(true);
    expect(b.status().kind).toBe('bound');
    expect(isUnitBound('L')).toBe(true);
    b.release();
  });

  it('a scene PRESS reaches the game; a release does not', async () => {
    const seen: SeqtrisInput[] = [];
    const b = acquireSeqtrisLaunchpad('n1', (i) => seen.push(i));
    await b.connect();
    b.bind(b.status().ports[0]!);

    sim.cc('L', SCENE_CCS[6]!, 127); // move left, DOWN
    expect(seen).toEqual(['moveLeft']);
    sim.cc('L', SCENE_CCS[6]!, 0); // UP — a held button must not repeat
    expect(seen).toEqual(['moveLeft']);

    sim.cc('L', SCENE_CCS[0]!, 127);
    sim.cc('L', SCENE_CCS[3]!, 127);
    expect(seen).toEqual(['moveLeft', 'reset', 'drop']);
    b.release();
  });

  it('the two dead buttons send nothing', async () => {
    const seen: SeqtrisInput[] = [];
    const b = acquireSeqtrisLaunchpad('n1', (i) => seen.push(i));
    await b.connect();
    b.bind(b.status().ports[0]!);
    sim.cc('L', SCENE_CCS[1]!, 127);
    sim.cc('L', SCENE_CCS[2]!, 127);
    expect(seen).toEqual([]);
    b.release();
  });

  it('an 8x8 PAD press is not a control — the grid is the display, not the input', async () => {
    const seen: SeqtrisInput[] = [];
    const b = acquireSeqtrisLaunchpad('n1', (i) => seen.push(i));
    await b.connect();
    b.bind(b.status().ports[0]!);
    sim.press('L', 3, 3);
    expect(seen).toEqual([]);
    b.release();
  });

  it('an UNBOUND module ignores every press — a second seqtris must not shadow the first', async () => {
    const first: SeqtrisInput[] = [];
    const second: SeqtrisInput[] = [];
    const a = acquireSeqtrisLaunchpad('n1', (i) => first.push(i));
    const c = acquireSeqtrisLaunchpad('n2', (i) => second.push(i));
    await a.connect();
    expect(a.bind(a.status().ports[0]!)).toBe(true);

    await c.connect();
    expect(c.bind(c.status().ports[0]!)).toBe(false);
    expect(c.status().kind).toBe('claimed');

    sim.cc('L', SCENE_CCS[7]!, 127);
    expect(first).toEqual(['moveRight']);
    expect(second).toEqual([]);
    a.release();
    c.release();
  });

  it('unbinding frees the claim for the next module', async () => {
    const a = acquireSeqtrisLaunchpad('n1', () => {});
    await a.connect();
    a.bind(a.status().ports[0]!);
    a.unbind();
    expect(a.status().kind).not.toBe('bound');

    const c = acquireSeqtrisLaunchpad('n2', () => {});
    await c.connect();
    expect(c.bind(c.status().ports[0]!)).toBe(true);
    c.release();
  });

  it('release() drops the claim, so a deleted node never strands the hardware', async () => {
    const a = acquireSeqtrisLaunchpad('n1', () => {});
    await a.connect();
    a.bind(a.status().ports[0]!);
    a.release();
    expect(isUnitBound('L')).toBe(false);

    const c = acquireSeqtrisLaunchpad('n2', () => {});
    await c.connect();
    expect(c.bind(c.status().ports[0]!)).toBe(true);
    c.release();
  });

  it('a released binding stops listening', async () => {
    const seen: SeqtrisInput[] = [];
    const b = acquireSeqtrisLaunchpad('n1', (i) => seen.push(i));
    await b.connect();
    b.bind(b.status().ports[0]!);
    b.release();
    sim.cc('L', SCENE_CCS[7]!, 127);
    expect(seen).toEqual([]);
  });
});

describe('the LED picture', () => {
  let sim: SimulatedLaunchpad;

  beforeEach(async () => {
    __test_resetLaunchpad();
    __test_resetSeqtrisLaunchpadOwner();
    sim = await installSimulatedLaunchpadSingle();
  });

  it('paints the falling piece onto the pads, FLIPPED to the hardware\'s bottom origin', async () => {
    const b = acquireSeqtrisLaunchpad('n1', () => {});
    await b.connect();
    b.bind(b.status().ports[0]!);

    const state = createSeqtrisState({ seed: 31, baseDivisor: 8 });
    const board = renderBoard(state);
    b.paint(board);

    let checked = 0;
    for (let row = 0; row < 8; row++) {
      for (let col = 0; col < 8; col++) {
        const id = board[cellIndex(row, col)] as SeqtrisPieceId | null;
        // Board row 0 is the TOP of the well; padNote's y counts from the
        // BOTTOM. Getting this backwards renders the game upside down on the
        // hardware while the card looks perfect.
        const led = sim.ledAt('L', padNote(col, LP_HEIGHT - 1 - row));
        if (id === null) {
          expect(led, `empty cell ${row},${col}`).toBeNull();
        } else {
          expect(led, `filled cell ${row},${col}`).toEqual([...SEQTRIS_PIECE_RGB[id]]);
          checked++;
        }
      }
    }
    expect(checked, 'the fixture must actually have lit some pads').toBeGreaterThan(0);
    b.release();
  });

  it('lights the six live controls and leaves the two dead ones dark', async () => {
    const b = acquireSeqtrisLaunchpad('n1', () => {});
    await b.connect();
    b.bind(b.status().ports[0]!);
    b.paint(renderBoard(createSeqtrisState({ seed: 31, baseDivisor: 8 })));

    for (let i = 0; i < SCENE_CCS.length; i++) {
      const led = sim.ledAt('L', SCENE_CCS[i]!);
      if (seqtrisActionForScene(i) === null) expect(led, `scene ${i}`).toBeNull();
      else expect(led, `scene ${i}`).not.toBeNull();
    }
    b.release();
  });

  it('paints nothing while unbound', async () => {
    const b = acquireSeqtrisLaunchpad('n1', () => {});
    b.paint(renderBoard(createSeqtrisState({ seed: 31, baseDivisor: 8 })));
    expect(sim.ledAt('L', SCENE_CCS[0]!)).toBeNull();
    b.release();
  });
});

describe('the port roster', () => {
  beforeEach(() => {
    __test_resetLaunchpad();
    __test_resetSeqtrisLaunchpadOwner();
  });

  it('is the shared enumeration, so the Windows dual-port filter applies here too', async () => {
    await installSimulatedLaunchpadSingle();
    const b = acquireSeqtrisLaunchpad('n1', () => {});
    await b.connect();
    expect(b.status().ports).toEqual(enumerateLaunchpadPorts());
    b.release();
  });
});
