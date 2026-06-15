// packages/web/src/lib/grid/grid-clip-map.test.ts
import { describe, it, expect } from 'vitest';
import {
  padToClipIndex,
  clipIndexToPad,
  isStopPad,
  computeSessionLeds,
  STOP_PAD,
  LED_EMPTY,
  LED_LOADED,
  LED_PLAYING,
  LED_QUEUED_HI,
  LED_QUEUED_LO,
  LED_STOP_IDLE,
  LED_STOP_ACTIVE,
} from './grid-clip-map';
import { GRID_WIDTH } from './mext';

const fi = (x: number, y: number) => y * GRID_WIDTH + x;

describe('pad ↔ clip mapping (left 8×8 quadrant)', () => {
  it('maps left-quadrant pads to clip indices row-major', () => {
    expect(padToClipIndex(0, 0)).toBe(0);
    expect(padToClipIndex(7, 0)).toBe(7);
    expect(padToClipIndex(0, 1)).toBe(8);
    expect(padToClipIndex(7, 7)).toBe(63);
  });
  it('returns null for the right (control) quadrant + out of range', () => {
    expect(padToClipIndex(8, 0)).toBeNull();
    expect(padToClipIndex(15, 7)).toBeNull();
    expect(padToClipIndex(-1, 0)).toBeNull();
  });
  it('clipIndexToPad inverts padToClipIndex', () => {
    for (const i of [0, 7, 8, 33, 63]) {
      const { x, y } = clipIndexToPad(i);
      expect(padToClipIndex(x, y)).toBe(i);
    }
  });
  it('STOP pad is the bottom-right corner', () => {
    expect(STOP_PAD).toEqual({ x: 15, y: 7 });
    expect(isStopPad(15, 7)).toBe(true);
    expect(isStopPad(0, 0)).toBe(false);
  });
});

describe('computeSessionLeds', () => {
  it('empty bank → all clip pads off, stop pad idle', () => {
    const f = computeSessionLeds({}, false);
    expect(f[fi(0, 0)]).toBe(LED_EMPTY);
    expect(f[fi(7, 7)]).toBe(LED_EMPTY);
    expect(f[fi(STOP_PAD.x, STOP_PAD.y)]).toBe(LED_STOP_IDLE);
  });

  it('loaded clip → medium; playing → full; stop pad active while playing', () => {
    const data = {
      clips: { '0': { kind: 'note', steps: [], lengthSteps: 16, root: 48, loop: true }, '9': { kind: 'note', steps: [], lengthSteps: 16, root: 48, loop: true } },
      playing: '9',
    };
    const f = computeSessionLeds(data as never, false);
    expect(f[fi(0, 0)]).toBe(LED_LOADED); // clip 0 loaded, not playing
    // clip 9 → (x=1,y=1) playing → full
    expect(f[fi(1, 1)]).toBe(LED_PLAYING);
    expect(f[fi(STOP_PAD.x, STOP_PAD.y)]).toBe(LED_STOP_ACTIVE);
  });

  it('queued-to-launch blinks dim↔bright', () => {
    const data = { clips: { '5': { kind: 'note', steps: [], lengthSteps: 16, root: 48, loop: true } }, queued: '5' };
    const { x, y } = clipIndexToPad(5);
    expect(computeSessionLeds(data as never, true)[fi(x, y)]).toBe(LED_QUEUED_HI);
    expect(computeSessionLeds(data as never, false)[fi(x, y)]).toBe(LED_QUEUED_LO);
  });

  it('queued-to-stop blinks the playing pad down', () => {
    const data = { clips: { '0': { kind: 'note', steps: [], lengthSteps: 16, root: 48, loop: true } }, playing: '0', queued: 'stop' };
    expect(computeSessionLeds(data as never, false)[fi(0, 0)]).toBe(LED_PLAYING);
    expect(computeSessionLeds(data as never, true)[fi(0, 0)]).toBe(LED_LOADED); // dimmed on the blink
  });
});
