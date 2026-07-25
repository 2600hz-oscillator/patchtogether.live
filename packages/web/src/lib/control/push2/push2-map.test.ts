// packages/web/src/lib/control/push2/push2-map.test.ts
//
// The Push 2 PLACEMENT ADAPTER — the translation between Push MIDI and the shipped
// Launchpad control vocabulary. PURE, so fully unit-testable: classify inbound
// Push events (parity → LaunchpadRxEvent; additive → channel/encoder/dpad) and
// translate the outbound LaunchpadFrame → Push LED specs. Pins the OWNER-CONFIRMED
// map: permanent-controls row 20..27 → Launchpad top 91..98, scene column 36..43
// (top 43 … bottom 36), Undo 119, Play 85.
import { describe, it, expect } from 'vitest';
import {
  classifyPush2,
  push2FrameToLeds,
  isEncoderCc,
  encoderTarget,
  dpadDir,
  pushCcToLaunchpadTopCc,
  sceneRowForCc,
  PUSH_CC_PLAY,
  PUSH_CC_SHIFT,
  PUSH_CC_UNDO,
  PUSH_CC_DPAD_UP,
  PUSH_CC_DPAD_LEFT,
  PUSH_CC_ABOVE_DISPLAY_BASE,
  PUSH_CC_PERMANENT_BASE,
  PUSH_CC_SCENE_BASE,
  PUSH_CC_ENCODER_BASE,
  PUSH_CC_ENCODER_TEMPO,
  PUSH_CC_ENCODER_SWING,
  PUSH_CC_ENCODER_MASTER,
} from './push2-map';
import type { Push2RxEvent } from './push2-sysex';
import { pushPadNote, pushColorIndex } from './push2-sysex';
import type { LaunchpadFrame } from './push2-types';
import { padNote, CC_UP, CC_TOP_SPARE_6, CC_TOP_SPARE_8, SCENE_CCS } from '$lib/control/launchpad/launchpad-sysex';

// A decoded pad event: a release always carries velocity 0 (mirrors the codec).
const pad = (x: number, y: number, s: 0 | 1, velocity = 100): Push2RxEvent => ({ type: 'pad', x, y, s, velocity: s === 1 ? velocity : 0 });
const cc = (n: number, value: number): Push2RxEvent => ({ type: 'cc', cc: n, s: value > 0 ? 1 : 0, value });

describe('classifyPush2 — parity events into the Launchpad vocabulary', () => {
  it('8×8 pads map cell-for-cell (bottom-origin ↔ bottom-origin), carrying velocity', () => {
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

  it('the permanent-controls row (CC 20..27) mirrors the Launchpad top row (91..98)', () => {
    // 20 → 91 (transport) … 27 → 98 (shift), in order.
    for (let i = 0; i < 8; i++) {
      expect(classifyPush2(cc(PUSH_CC_PERMANENT_BASE + i, 127))).toEqual({
        kind: 'launchpad',
        ev: { type: 'top', cc: 91 + i, s: 1 },
      });
    }
    // Button 2 (CC 22) → CLIP (note-editor) view = top CC 93.
    expect(classifyPush2(cc(PUSH_CC_PERMANENT_BASE + 2, 127))).toEqual({ kind: 'launchpad', ev: { type: 'top', cc: 93, s: 1 } });
  });

  it('the dedicated Undo (119) / Shift (49) buttons reach the top row (96/98)', () => {
    expect(classifyPush2(cc(PUSH_CC_UNDO, 127))).toEqual({ kind: 'launchpad', ev: { type: 'top', cc: CC_TOP_SPARE_6, s: 1 } });
    expect(classifyPush2(cc(PUSH_CC_SHIFT, 127))).toEqual({ kind: 'launchpad', ev: { type: 'top', cc: CC_TOP_SPARE_8, s: 1 } });
    expect(CC_TOP_SPARE_6).toBe(96);
    expect(CC_TOP_SPARE_8).toBe(98);
  });

  it('scene-launch column (CC 36..43, TOP 43 … BOTTOM 36) → the Launchpad scene column', () => {
    // TOP button (CC 43) → row 7 → SCENE_CCS[0] = 89 (the Launchpad top scene).
    expect(classifyPush2(cc(PUSH_CC_SCENE_BASE + 7, 127))).toEqual({
      kind: 'launchpad',
      ev: { type: 'scene', row: 7, cc: SCENE_CCS[0], s: 1 },
    });
    // BOTTOM button (CC 36) → row 0 → SCENE_CCS[7] = 19.
    expect(classifyPush2(cc(PUSH_CC_SCENE_BASE, 127))).toEqual({
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
  it('encoderTarget / dpadDir classify their CCs', () => {
    expect(encoderTarget(PUSH_CC_ENCODER_BASE + 2)).toEqual({ param: 'volume', channel: 2 });
    expect(dpadDir(PUSH_CC_DPAD_UP)).toBe('up');
    expect(dpadDir(999)).toBeNull();
  });
  it('pushCcToLaunchpadTopCc maps the permanent row + dedicated buttons; null otherwise', () => {
    expect(pushCcToLaunchpadTopCc(PUSH_CC_PERMANENT_BASE)).toBe(CC_UP); // 20 → 91
    expect(pushCcToLaunchpadTopCc(PUSH_CC_PERMANENT_BASE + 7)).toBe(CC_TOP_SPARE_8); // 27 → 98
    expect(pushCcToLaunchpadTopCc(PUSH_CC_PLAY)).toBe(CC_UP);
    expect(pushCcToLaunchpadTopCc(PUSH_CC_UNDO)).toBe(CC_TOP_SPARE_6);
    expect(pushCcToLaunchpadTopCc(999)).toBeNull();
  });
  it('sceneRowForCc maps 36..43 to bottom-origin rows 0..7', () => {
    expect(sceneRowForCc(PUSH_CC_SCENE_BASE)).toBe(0); // 36 → bottom
    expect(sceneRowForCc(PUSH_CC_SCENE_BASE + 7)).toBe(7); // 43 → top
    expect(sceneRowForCc(35)).toBeNull();
    expect(sceneRowForCc(44)).toBeNull();
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

  it('a lit top CC lights BOTH the permanent-controls row + the dedicated button', () => {
    const frame: LaunchpadFrame = {
      leds: new Map<number, [number, number, number]>([
        [CC_UP, [0, 127, 0]], // transport lit GREEN → Play + permanent-row button 0
        [SCENE_CCS[0], [0, 127, 0]], // top scene lit GREEN → scene button (CC 43)
        [99, [10, 10, 10]], // the logo — no Push home
      ]),
    };
    const leds = push2FrameToLeds(frame);
    // REGRESSION: RGB control buttons carry a real PALETTE INDEX (green = 126),
    // NOT a hard-coded 127 (which is the palette's RED anchor → the "all buttons
    // red" bug). Play (85), the permanent-controls row (20..27) and the scene
    // column (36..43) are all full-RGB buttons.
    expect(pushColorIndex(0, 127, 0)).toBe(126); // green anchor
    expect(leds).toContainEqual({ kind: 'button', cc: PUSH_CC_PLAY, value: 126 });
    expect(leds).toContainEqual({ kind: 'button', cc: PUSH_CC_PERMANENT_BASE, value: 126 });
    // The TOP scene (SCENE_CCS[0]) → the TOP Push scene button = CC 43.
    expect(leds).toContainEqual({ kind: 'button', cc: PUSH_CC_SCENE_BASE + 7, value: 126 });
    // No RGB button collapses to red (127) here.
    expect(leds.some((l) => l.kind === 'button' && l.value === 127)).toBe(false);
    // nothing maps the logo (99).
    expect(leds.some((l) => l.kind === 'button' && l.cc === 99)).toBe(false);
  });

  it('an RGB button lit WHITE emits the white palette index (122), not 127', () => {
    const frame: LaunchpadFrame = { leds: new Map<number, [number, number, number]>([[CC_UP, [127, 127, 127]]]) };
    const leds = push2FrameToLeds(frame);
    expect(pushColorIndex(127, 127, 127)).toBe(122); // white anchor
    expect(leds).toContainEqual({ kind: 'button', cc: PUSH_CC_PLAY, value: 122 });
    expect(leds).toContainEqual({ kind: 'button', cc: PUSH_CC_PERMANENT_BASE, value: 122 });
  });

  it('the white/mono dedicated buttons (Undo 119, Shift 49) stay max-white 127', () => {
    // The Launchpad UNDO index (96) lights the RGB permanent-row button 26 AND the
    // white/mono Undo (119); SHIFT (98) lights RGB button 27 AND white/mono Shift (49).
    const frame: LaunchpadFrame = {
      leds: new Map<number, [number, number, number]>([
        [CC_TOP_SPARE_6, [0, 127, 0]], // undo function lit GREEN
        [CC_TOP_SPARE_8, [0, 127, 0]], // shift function lit GREEN
      ]),
    };
    const leds = push2FrameToLeds(frame);
    // White/mono → brightness 127 (unchanged; correct there).
    expect(leds).toContainEqual({ kind: 'button', cc: PUSH_CC_UNDO, value: 127 });
    expect(leds).toContainEqual({ kind: 'button', cc: PUSH_CC_SHIFT, value: 127 });
    // …while their RGB permanent-row twins carry the palette index (green = 126).
    // Undo function = top CC 96 → permanent CC 25 (96−91+20); Shift = 98 → CC 27.
    expect(leds).toContainEqual({ kind: 'button', cc: PUSH_CC_PERMANENT_BASE + 5, value: 126 }); // CC 25
    expect(leds).toContainEqual({ kind: 'button', cc: PUSH_CC_PERMANENT_BASE + 7, value: 126 }); // CC 27
  });

  it('a black (off) LED emits value 0 (both RGB and white/mono buttons)', () => {
    const frame: LaunchpadFrame = {
      leds: new Map<number, [number, number, number]>([
        [CC_UP, [0, 0, 0]], // RGB Play/permanent-row → off
        [CC_TOP_SPARE_8, [0, 0, 0]], // white/mono Shift → off
      ]),
    };
    const leds = push2FrameToLeds(frame);
    expect(leds).toContainEqual({ kind: 'button', cc: PUSH_CC_PLAY, value: 0 });
    expect(leds).toContainEqual({ kind: 'button', cc: PUSH_CC_PERMANENT_BASE, value: 0 });
    expect(leds).toContainEqual({ kind: 'button', cc: PUSH_CC_SHIFT, value: 0 });
  });
});
