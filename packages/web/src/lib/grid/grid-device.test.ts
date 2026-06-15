// packages/web/src/lib/grid/grid-device.test.ts
//
// Device-singleton tests driven entirely through the simulated-grid hook — no
// hardware, no WebSerial. Exercises the same RX-parse / dispatch / LED-write
// paths a real FTDI grid uses.

import { describe, it, expect, beforeEach } from 'vitest';
import {
  serialAvailable,
  isConnected,
  installSimulatedGrid,
  __test_resetGrid,
  onKey,
  setLed,
  setFrame,
  clearLeds,
  flushWrites,
  disconnect,
  gridFamily,
  gridSize,
  gridDeviceId,
  currentLedFrame,
  type GridKeyEvent,
} from './grid-device.svelte';
import { GRID_CELLS, GRID_WIDTH } from './mext';

beforeEach(() => {
  __test_resetGrid();
});

describe('serialAvailable', () => {
  it('is false in the test (node) environment — no navigator.serial', () => {
    expect(serialAvailable()).toBe(false);
  });
});

describe('installSimulatedGrid', () => {
  it('connects and emits the handshake + blank on attach', async () => {
    expect(isConnected()).toBe(false);
    const sim = await installSimulatedGrid();
    expect(isConnected()).toBe(true);
    const w = sim.writes();
    // query, request-id, request-size, then a padded all-off.
    expect([...w[0]]).toEqual([0x00]);
    expect([...w[1]]).toEqual([0x01]);
    expect([...w[2]]).toEqual([0x05]);
    expect([...w[3].slice(0, 2)]).toEqual([0x19, 0]); // led-all 0, then 0xff pad
  });

  it('is idempotent — second install returns the same handle', async () => {
    const a = await installSimulatedGrid();
    const b = await installSimulatedGrid();
    expect(a).toBe(b);
  });
});

describe('key input', () => {
  it('dispatches press/release to onKey listeners', async () => {
    const sim = await installSimulatedGrid();
    const events: GridKeyEvent[] = [];
    const off = onKey((e) => events.push(e));
    sim.press(3, 5);
    sim.release(3, 5);
    expect(events).toEqual([
      { x: 3, y: 5, s: 1 },
      { x: 3, y: 5, s: 0 },
    ]);
    off();
    sim.press(0, 0);
    expect(events).toHaveLength(2); // unsubscribed
  });
});

describe('LED output (diffed)', () => {
  it('setLed writes a single padded 0x18 and updates the local frame', async () => {
    const sim = await installSimulatedGrid();
    const before = sim.writes().length;
    setLed(2, 1, 12);
    await flushWrites();
    const w = sim.writes();
    expect(w.length).toBe(before + 1);
    expect([...w[before].slice(0, 4)]).toEqual([0x18, 2, 1, 12]);
    expect(sim.ledAt(2, 1)).toBe(12);
    expect(currentLedFrame()[1 * GRID_WIDTH + 2]).toBe(12);
  });

  it('setLed is a no-op when the cell is already at that level', async () => {
    const sim = await installSimulatedGrid();
    setLed(2, 1, 12);
    await flushWrites();
    const n = sim.writes().length;
    setLed(2, 1, 12); // same → no write
    await flushWrites();
    expect(sim.writes().length).toBe(n);
  });

  it('setFrame writes only the changed cells, batched', async () => {
    const sim = await installSimulatedGrid();
    const next = new Uint8Array(GRID_CELLS);
    next[0] = 9; // (0,0)
    next[GRID_WIDTH + 1] = 4; // (1,1)
    const before = sim.writes().length;
    setFrame(next);
    await flushWrites();
    const w = sim.writes();
    expect(w.length).toBe(before + 1); // one batched write
    const run = w[before];
    // Two 0x18 frames (8 command bytes) then 0xff padding.
    expect([...run.slice(0, 8)]).toEqual([0x18, 0, 0, 9, 0x18, 1, 1, 4]);
    expect(sim.ledAt(1, 1)).toBe(4);
  });

  it('setFrame with no changes writes nothing', async () => {
    const sim = await installSimulatedGrid();
    const n = sim.writes().length;
    setFrame(new Uint8Array(GRID_CELLS)); // all zero == current
    await flushWrites();
    expect(sim.writes().length).toBe(n);
  });

  it('clearLeds blanks the frame', async () => {
    await installSimulatedGrid();
    setLed(5, 5, 15);
    await flushWrites();
    clearLeds();
    await flushWrites();
    expect(currentLedFrame().every((v) => v === 0)).toBe(true);
  });
});

describe('handshake responses', () => {
  it('an id response selects the codec family', async () => {
    const sim = await installSimulatedGrid();
    expect(gridFamily()).toBe('mext'); // default
    // series 128 id "m128-302" padded to 32 bytes.
    const id = 'm128-302';
    const bytes = [0x01];
    for (let i = 0; i < 32; i++) bytes.push(i < id.length ? id.charCodeAt(i) : 0);
    sim.feed(bytes);
    expect(gridFamily()).toBe('series');
    expect(gridDeviceId()).toBe('m128-302');
  });

  it('a size response updates the grid dimensions', async () => {
    const sim = await installSimulatedGrid();
    expect(gridSize()).toEqual({ width: 16, height: 8 });
    sim.feed([0x05, 8, 8]); // a 64
    expect(gridSize()).toEqual({ width: 8, height: 8 });
  });
});

describe('disconnect', () => {
  it('tears the connection down', async () => {
    await installSimulatedGrid();
    expect(isConnected()).toBe(true);
    await disconnect();
    expect(isConnected()).toBe(false);
  });
});
