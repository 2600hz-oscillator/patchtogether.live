// packages/web/src/lib/control/push2/push2-map.test.ts
//
// The Push 2 PLACEMENT ADAPTER — the translation between Push MIDI and the shipped
// Launchpad control vocabulary. PURE, so fully unit-testable: classify inbound
// Push events (parity → LaunchpadRxEvent; additive → channel/encoder/dpad) and
// translate the outbound LaunchpadFrame → Push LED specs.
import { describe, it, expect } from 'vitest';
import {
  classifyPush2,
  push2FrameToLeds,
  isEncoderCc,
  encoderTarget,
  dpadDir,
  pushCcToLaunchpadTopCc,
  PUSH_CC_PLAY,
  PUSH_CC_SESSION,
  PUSH_CC_NOTE,
  PUSH_CC_SHIFT,
  PUSH_CC_UNDO,
  PUSH_CC_DPAD_UP,
  PUSH_CC_DPAD_LEFT,
  PUSH_CC_ABOVE_DISPLAY_BASE,
  PUSH_CC_BELOW_DISPLAY_BASE,
  PUSH_CC_ENCODER_BASE,
  PUSH_CC_ENCODER_TEMPO,
  PUSH_CC_ENCODER_SWING,
  PUSH_CC_ENCODER_MASTER,
} from './push2-map';
import type { Push2RxEvent } from './push2-sysex';
import { pushPadNote } from './push2-sysex';
import type { LaunchpadFrame } from './push2-types';
import { padNote, CC_UP, CC_LEFT, CC_TOP_SPARE_8, SCENE_CCS } from '$lib/control/launchpad/launchpad-sysex';

// A decoded pad event: a release always carries velocity 0 (mirrors the codec).
const pad = (x: number, y: number, s: 0 | 1, velocity = 100): Push2RxEvent => ({ type: 'pad', x, y, s, velocity: s === 1 ? velocity : 0 });
const cc = (n: number, value: number): Push2RxEvent => ({ type: 'cc', cc: n, s: value > 0 ? 1 : 0, value });

describe('classifyPush2 — parity events into the Launchpad vocabulary', () => {
  it('8×8 pads map cell-for-cell (bottom-origin ↔ bottom-origin)', () => {
    expect(classifyPush2(pad(0, 0, 1, 77))).toEqual({
      kind: 'launchpad',
      ev: { type: 'pad', x: 0, y: 0, s: 1, velocity: 77 },
    });
    expect(classifyPush2(pad(7, 7, 0))).toEqual({
      kind: 'launchpad',
      ev: { type: 'pad', x: 7, y: 7, s: 0, velocity: 0 },
    });
  });

  it('Play → the Launchpad transport top CC (91) — START/STOP moved to Play', () => {
    expect(classifyPush2(cc(PUSH_CC_PLAY, 127))).toEqual({
      kind: 'launchpad',
      ev: { type: 'top', cc: CC_UP, s: 1 },
    });
    expect(CC_UP).toBe(91);
  });

  it('Session/Note reach the GRID/CLIP view switches (top CC 92/93)', () => {
    expect(classifyPush2(cc(PUSH_CC_SESSION, 127))).toEqual({ kind: 'launchpad', ev: { type: 'top', cc: 92, s: 1 } });
    expect(classifyPush2(cc(PUSH_CC_NOTE, 127))).toEqual({ kind: 'launchpad', ev: { type: 'top', cc: CC_LEFT, s: 1 } });
    expect(CC_LEFT).toBe(93);
  });

  it('Undo/Shift reach the top row (96/98)', () => {
    expect(classifyPush2(cc(PUSH_CC_UNDO, 127))).toEqual({ kind: 'launchpad', ev: { type: 'top', cc: 96, s: 1 } });
    expect(classifyPush2(cc(PUSH_CC_SHIFT, 127))).toEqual({ kind: 'launchpad', ev: { type: 'top', cc: CC_TOP_SPARE_8, s: 1 } });
    expect(CC_TOP_SPARE_8).toBe(98);
  });

  it('below-display buttons → the Launchpad scene column (row bottom-origin)', () => {
    // CC 20 (index 0) → SCENE_CCS[0] = 89, which the Launchpad decodes as row 7.
    expect(classifyPush2(cc(PUSH_CC_BELOW_DISPLAY_BASE, 127))).toEqual({
      kind: 'launchpad',
      ev: { type: 'scene', row: 7, cc: SCENE_CCS[0], s: 1 },
    });
    // CC 27 (index 7) → SCENE_CCS[7] = 19 → row 0.
    expect(classifyPush2(cc(PUSH_CC_BELOW_DISPLAY_BASE + 7, 127))).toEqual({
      kind: 'launchpad',
      ev: { type: 'scene', row: 0, cc: SCENE_CCS[7], s: 1 },
    });
  });
});

describe('classifyPush2 — additive Push-only actions', () => {
  it('above-display buttons → select channel 1..8 (press only)', () => {
    expect(classifyPush2(cc(PUSH_CC_ABOVE_DISPLAY_BASE, 127))).toEqual({ kind: 'selectChannel', channel: 0 });
    expect(classifyPush2(cc(PUSH_CC_ABOVE_DISPLAY_BASE + 7, 127))).toEqual({ kind: 'selectChannel', channel: 7 });
    expect(classifyPush2(cc(PUSH_CC_ABOVE_DISPLAY_BASE, 0)), 'release ignored').toBeNull();
  });

  it('display encoders → volume ch1..8; deltas decoded relative', () => {
    expect(classifyPush2(cc(PUSH_CC_ENCODER_BASE, 1))).toEqual({
      kind: 'encoder',
      target: { param: 'volume', channel: 0 },
      delta: 1,
    });
    expect(classifyPush2(cc(PUSH_CC_ENCODER_BASE + 7, 127))).toEqual({
      kind: 'encoder',
      target: { param: 'volume', channel: 7 },
      delta: -1,
    });
  });

  it('Tempo/Swing/Master encoders → sends + master', () => {
    expect(classifyPush2(cc(PUSH_CC_ENCODER_TEMPO, 2))).toEqual({ kind: 'encoder', target: { param: 'send1' }, delta: 2 });
    expect(classifyPush2(cc(PUSH_CC_ENCODER_SWING, 2))).toEqual({ kind: 'encoder', target: { param: 'send2' }, delta: 2 });
    expect(classifyPush2(cc(PUSH_CC_ENCODER_MASTER, 127))).toEqual({ kind: 'encoder', target: { param: 'master' }, delta: -1 });
  });

  it('a zero encoder delta is a no-op', () => {
    expect(classifyPush2(cc(PUSH_CC_ENCODER_BASE, 0))).toBeNull();
  });

  it('D-Pad arrows → nav actions (press only)', () => {
    expect(classifyPush2(cc(PUSH_CC_DPAD_UP, 127))).toEqual({ kind: 'dpad', dir: 'up' });
    expect(classifyPush2(cc(PUSH_CC_DPAD_LEFT, 127))).toEqual({ kind: 'dpad', dir: 'left' });
    expect(classifyPush2(cc(PUSH_CC_DPAD_UP, 0)), 'release ignored').toBeNull();
  });

  it('unbound controls classify to null', () => {
    expect(classifyPush2(cc(86, 127))).toBeNull(); // Record — out of Phase 1
    expect(classifyPush2(cc(3, 127))).toBeNull(); // Tap Tempo etc.
  });
});

describe('helpers', () => {
  it('isEncoderCc covers the 11 encoders only', () => {
    expect(isEncoderCc(PUSH_CC_ENCODER_BASE)).toBe(true);
    expect(isEncoderCc(PUSH_CC_ENCODER_BASE + 7)).toBe(true);
    expect(isEncoderCc(PUSH_CC_ENCODER_TEMPO)).toBe(true);
    expect(isEncoderCc(PUSH_CC_ENCODER_MASTER)).toBe(true);
    expect(isEncoderCc(PUSH_CC_ABOVE_DISPLAY_BASE)).toBe(false);
  });
  it('encoderTarget / dpadDir / pushCcToLaunchpadTopCc classify their CCs', () => {
    expect(encoderTarget(PUSH_CC_ENCODER_BASE + 2)).toEqual({ param: 'volume', channel: 2 });
    expect(dpadDir(PUSH_CC_DPAD_UP)).toBe('up');
    expect(dpadDir(999)).toBeNull();
    expect(pushCcToLaunchpadTopCc(PUSH_CC_PLAY)).toBe(CC_UP);
    expect(pushCcToLaunchpadTopCc(999)).toBeNull();
  });
});

describe('push2FrameToLeds — LaunchpadFrame → Push LED specs', () => {
  it('pad indices → Push pad notes + palette colours', () => {
    const frame: LaunchpadFrame = {
      leds: new Map<number, [number, number, number]>([
        [padNote(0, 0), [0, 127, 0]], // bottom-left green
        [padNote(7, 7), [127, 0, 0]], // top-right red
      ]),
    };
    const leds = push2FrameToLeds(frame);
    expect(leds).toContainEqual({ kind: 'pad', note: pushPadNote(0, 0), palette: 126 });
    expect(leds).toContainEqual({ kind: 'pad', note: pushPadNote(7, 7), palette: 127 });
  });

  it('top-row + scene CCs → mapped Push buttons; the logo is dropped', () => {
    const frame: LaunchpadFrame = {
      leds: new Map<number, [number, number, number]>([
        [CC_UP, [15, 0, 0]], // transport lit → Play button on
        [SCENE_CCS[0], [10, 10, 10]], // scene 0 lit → below-display button on
        [99, [10, 10, 10]], // the logo — no Push home
      ]),
    };
    const leds = push2FrameToLeds(frame);
    expect(leds).toContainEqual({ kind: 'button', cc: PUSH_CC_PLAY, value: 127 });
    expect(leds).toContainEqual({ kind: 'button', cc: PUSH_CC_BELOW_DISPLAY_BASE, value: 127 });
    // nothing maps the logo (99).
    expect(leds.some((l) => l.kind === 'button' && l.cc === 99)).toBe(false);
  });

  it('a black (off) LED emits value 0', () => {
    const frame: LaunchpadFrame = { leds: new Map([[CC_UP, [0, 0, 0]]]) };
    expect(push2FrameToLeds(frame)).toContainEqual({ kind: 'button', cc: PUSH_CC_PLAY, value: 0 });
  });
});
