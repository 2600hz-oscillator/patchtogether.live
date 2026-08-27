import { describe, it, expect } from 'vitest';
import {
  assignScreenIds,
  describeScreen,
  resolveScreens,
  screenKey,
  type ScreenDescriptor,
} from './screen-identity';

function scr(p: Partial<ScreenDescriptor> = {}): ScreenDescriptor {
  return {
    label: 'DELL U2723QE',
    isInternal: false,
    width: 3840,
    height: 2160,
    dpr: 2,
    left: 0,
    top: 0,
    ...p,
  };
}

describe('describeScreen', () => {
  it('tolerates a ScreenDetailed missing every optional field', () => {
    expect(describeScreen({})).toEqual({
      label: '',
      isInternal: false,
      width: 0,
      height: 0,
      dpr: 1,
      left: 0,
      top: 0,
    });
  });
});

describe('screenKey', () => {
  it('ignores position, so rearranging displays does not change identity', () => {
    expect(screenKey(scr({ left: 0 }))).toBe(screenKey(scr({ left: -3840 })));
  });

  it('separates two monitors that differ only in resolution', () => {
    expect(screenKey(scr({ width: 1920 }))).not.toBe(screenKey(scr({ width: 3840 })));
  });
});

describe('assignScreenIds', () => {
  it('gives distinct monitors bare keys and no suffix', () => {
    const ids = assignScreenIds([scr(), scr({ label: 'Built-in Retina Display', isInternal: true })]);
    expect(new Set(ids).size).toBe(2);
    expect(ids.every((i) => !i.includes('#'))).toBe(true);
  });

  it('disambiguates identical monitors by arrangement order, not array order', () => {
    const right = scr({ left: 3840 });
    const left = scr({ left: 0 });
    // Array order deliberately reversed relative to physical order.
    const ids = assignScreenIds([right, left]);
    expect(ids[1]).toBe(`${screenKey(left)}#0`);
    expect(ids[0]).toBe(`${screenKey(right)}#1`);
  });

  it('is stable across a reload that reports the same rig in a different order', () => {
    const a = scr({ left: 0 });
    const b = scr({ left: 3840 });
    const first = assignScreenIds([a, b]);
    const second = assignScreenIds([b, a]);
    expect(second[1]).toBe(first[0]);
    expect(second[0]).toBe(first[1]);
  });
});

describe('resolveScreens', () => {
  const internal = scr({ label: 'Built-in Retina Display', isInternal: true, width: 3456, height: 2234, left: 0 });
  const projector = scr({ label: 'EPSON PJ', width: 1920, height: 1080, dpr: 1, left: 3456 });

  it('matches an unchanged rig exactly', () => {
    expect(resolveScreens([internal, projector], [internal, projector])).toEqual([0, 1]);
  });

  it('still matches when the displays were rearranged after a reboot', () => {
    const movedProjector = { ...projector, left: -1920 };
    expect(resolveScreens([projector], [internal, movedProjector])).toEqual([1]);
  });

  it('falls back to label when the projector reports a new resolution', () => {
    const rescaled = { ...projector, width: 1280, height: 720 };
    expect(resolveScreens([projector], [internal, rescaled])).toEqual([1]);
  });

  it('falls back to geometry when the label went empty', () => {
    const unlabelled = { ...projector, label: '' };
    expect(resolveScreens([projector], [internal, unlabelled])).toEqual([1]);
  });

  it('returns -1 for a display that is simply not connected', () => {
    expect(resolveScreens([projector], [internal])).toEqual([-1]);
  });

  it('never assigns one live screen to two saved bindings', () => {
    const other = scr({ label: 'OTHER', width: 100, height: 100 });
    const got = resolveScreens([projector, other], [projector]);
    expect(got[0]).toBe(0);
    expect(got[1]).toBe(-1);
  });

  it('resolves two IDENTICAL monitors to the right side by arrangement', () => {
    const l = scr({ left: 0 });
    const r = scr({ left: 3840 });
    expect(resolveScreens([r, l], [l, r])).toEqual([1, 0]);
  });

  it('does not guess when an empty label is the only signal', () => {
    const blankA = scr({ label: '', width: 800, height: 600, left: 0 });
    const blankB = scr({ label: '', width: 1024, height: 768, left: 900 });
    // Saved carries neither geometry nor position of either live screen.
    const saved = scr({ label: '', width: 640, height: 480, left: 5000 });
    expect(resolveScreens([saved], [blankA, blankB])).toEqual([-1]);
  });
});
