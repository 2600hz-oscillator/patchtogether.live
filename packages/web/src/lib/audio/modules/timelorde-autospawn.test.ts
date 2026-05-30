// packages/web/src/lib/audio/modules/timelorde-autospawn.test.ts
//
// Unit tests for the pure auto-spawn predicates.

import { describe, it, expect } from 'vitest';
import {
  shouldAutoSpawnTimelorde,
  pickTimelordeDefaultPosition,
} from './timelorde-autospawn';

describe('shouldAutoSpawnTimelorde', () => {
  it('returns true on an empty patch (fresh rackspace)', () => {
    expect(shouldAutoSpawnTimelorde([])).toBe(true);
  });

  it('returns false when a TIMELORDE is already present', () => {
    expect(
      shouldAutoSpawnTimelorde([
        { type: 'analogVco' },
        { type: 'timelorde' },
        { type: 'audioOut' },
      ]),
    ).toBe(false);
  });

  it('returns true when other modules exist but no TIMELORDE', () => {
    // Regression pin: the user's complaint was that even after the
    // singleton + undeletable promise, racks loaded without a
    // TIMELORDE. The predicate must NOT no-op just because the rack has
    // any nodes.
    expect(
      shouldAutoSpawnTimelorde([
        { type: 'analogVco' },
        { type: 'audioOut' },
        { type: 'sequencer' },
      ]),
    ).toBe(true);
  });

  it('case-sensitive match — capitalized variants do not block the spawn', () => {
    // Defensive: type is canonical lowercase 'timelorde'. If a stray
    // capitalized variant ever leaked into a snapshot, the auto-spawn
    // should still kick in so the rack picks up a real TIMELORDE.
    expect(
      shouldAutoSpawnTimelorde([{ type: 'TIMELORDE' }, { type: 'Timelorde' }]),
    ).toBe(true);
  });
});

describe('pickTimelordeDefaultPosition', () => {
  it('returns the fallback inset when no viewport is provided', () => {
    expect(pickTimelordeDefaultPosition()).toEqual({ x: 24, y: 24 });
    expect(pickTimelordeDefaultPosition(null)).toEqual({ x: 24, y: 24 });
  });

  it('pins to top-left of the viewport plus the inset', () => {
    const pos = pickTimelordeDefaultPosition({
      originX: 400,
      originY: 200,
      width: 800,
      height: 600,
    });
    expect(pos).toEqual({ x: 424, y: 224 });
  });

  it('handles non-finite viewport coordinates by falling back', () => {
    // Defensive: SvelteFlow's getViewport returns NaN / Infinity in some
    // mid-mount window-resize races. The fallback keeps the spawn from
    // ending up at NaN coords (which would render the card off-screen
    // and the user couldn't find it).
    const pos = pickTimelordeDefaultPosition({
      originX: NaN,
      originY: 0,
      width: 800,
      height: 600,
    });
    expect(pos).toEqual({ x: 24, y: 24 });
  });
});
