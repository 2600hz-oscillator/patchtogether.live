// present-link.test.ts
//
// THE PROJECTOR'S OWN OPINION OF ITS SOURCE, pinned in both directions.
//
// ⚠ WHY THIS STATE MACHINE HAS TO EXIST AT ALL. The only liveness signal the
// present pipeline used to carry was the opener's `popupDriving`/`lastPullAt`,
// set BEFORE the draw and outside its try/catch. That is correct for the
// watchdog's job (reclaim the clock from a sink that stopped pulling) and blind
// to pixels by construction — a sink pulling on schedule while the opener paints
// pure black kept it green forever. The visible result of a dead source was a
// FROZEN LAST FRAME on a wall, which looks alive.
//
// So each test below comes with its opposite: a leg that must reach the bad
// state, and a leg proving the SAME monitor stays 'live' when the link is fine.
// A monitor that always says 'stalled' is not a fix, it is a different outage
// (a banner over a working show).

import { describe, it, expect } from 'vitest';
import {
  createPresentLinkMonitor,
  DEFAULT_PRESENT_LINK_THRESHOLDS,
  type PresentLinkMonitor,
  type PresentLinkState,
} from './present-link';

/** Feed `n` healthy frames — a source present, painting every pull, which is
 *  what a working link actually does (the opener draws synchronously inside the
 *  pull, so `painted` advances on EVERY tick). */
function healthy(m: PresentLinkMonitor, n: number, from = 0): PresentLinkState {
  let state: PresentLinkState = m.state;
  for (let i = 0; i < n; i++) {
    state = m.tick({ sourcePresent: true, painted: from + i + 1, errors: 0 });
  }
  return state;
}

/** Feed `n` frames where the opener is reachable but paints nothing — the
 *  black-projector case: a null source, a 1×1 source, or a draw that throws. */
function blank(m: PresentLinkMonitor, n: number, painted: number): PresentLinkState {
  let state: PresentLinkState = m.state;
  for (let i = 0; i < n; i++) {
    state = m.tick({ sourcePresent: true, painted, errors: 0 });
  }
  return state;
}

/** Feed `n` frames where `__presentFrame` is gone or throws. */
function noSource(m: PresentLinkMonitor, n: number): PresentLinkState {
  let state: PresentLinkState = m.state;
  for (let i = 0; i < n; i++) state = m.tick({ sourcePresent: false });
  return state;
}

const T = DEFAULT_PRESENT_LINK_THRESHOLDS;

describe('present link monitor — a painting source reads LIVE', () => {
  it('starts as waiting and never claims live before a painted frame', () => {
    const m = createPresentLinkMonitor();
    expect(m.state).toBe('waiting');
    // Pulls happening with nothing painted yet is a cold engine, not a failure.
    expect(blank(m, 10, 0)).toBe('waiting');
    expect(m.everPainted).toBe(false);
  });

  it('one painted frame is enough to go live, and it STAYS live', () => {
    const m = createPresentLinkMonitor();
    expect(healthy(m, 1)).toBe('live');
    // Ten times the stall budget of healthy frames — the monitor must not
    // decay on its own or a long set ends in a banner.
    expect(healthy(m, T.stallFrames * 10, 1)).toBe('live');
    expect(m.ticksSincePaint).toBe(0);
  });
});

describe('present link monitor — a BLACK projector is not a live one', () => {
  it('a link that stops painting goes stalled, in FRAMES not milliseconds', () => {
    const m = createPresentLinkMonitor();
    healthy(m, 5);
    // One frame short of the budget is still live: a hiccup must not flash a
    // banner over a working show.
    expect(blank(m, T.stallFrames - 1, 5)).toBe('live');
    expect(blank(m, 1, 5), 'the budget is spent in frames').toBe('stalled');
    expect(m.ticksSincePaint).toBe(T.stallFrames);
  });

  it('recovers to live the moment a painted frame arrives again', () => {
    // The projector is a performance surface: a source that comes back must
    // clear the notice, not leave it up for the rest of the set.
    const m = createPresentLinkMonitor();
    healthy(m, 5);
    expect(blank(m, T.stallFrames, 5)).toBe('stalled');
    expect(healthy(m, 1, 5)).toBe('live');
  });

  it('a sink that NEVER paints eventually says so rather than sitting black', () => {
    const m = createPresentLinkMonitor();
    expect(blank(m, T.coldFrames - 1, 0)).toBe('waiting');
    expect(blank(m, 1, 0)).toBe('stalled');
  });
});

describe('present link monitor — a VANISHED source reads LOST, and outranks stalled', () => {
  it('a frame function that disappears is lost, not stalled', () => {
    // `__presentFrame` is installed once and removed only in cleanup(), so its
    // absence is not a hiccup — the opener navigated, reloaded or died. It
    // names a different repair from "the source stopped painting", which is why
    // it is a separate state.
    const m = createPresentLinkMonitor();
    healthy(m, 5);
    expect(noSource(m, T.lostFrames - 1)).toBe('live');
    expect(noSource(m, 1)).toBe('lost');
  });

  it('lost wins over stalled when both are true', () => {
    const m = createPresentLinkMonitor();
    healthy(m, 5);
    expect(noSource(m, Math.max(T.lostFrames, T.stallFrames) + 1)).toBe('lost');
  });

  it('a source that was NEVER there does not report lost', () => {
    // A sink whose opener has not finished installing the frame yet is cold,
    // not bereaved. Reporting 'lost' here would fire on every normal open.
    const m = createPresentLinkMonitor();
    expect(noSource(m, T.lostFrames * 2)).toBe('waiting');
  });
});

describe('present link monitor — the UNARMED sink stays quiet', () => {
  it('/present opened by hand never claims a lost source', () => {
    // It has no opener and no session: it is a black canvas by design, and a
    // "SOURCE DISCONNECTED" banner there is a lie about a link that never
    // existed.
    const m = createPresentLinkMonitor({ armed: false });
    expect(noSource(m, T.lostFrames * 5)).toBe('waiting');
    expect(blank(m, T.coldFrames * 2, 0)).toBe('waiting');
  });

  it('POSITIVE CONTROL: the same frames on an ARMED monitor do report', () => {
    // Otherwise "armed:false everywhere" would silence the instrument and every
    // test above would still pass.
    const m = createPresentLinkMonitor({ armed: true });
    expect(blank(m, T.coldFrames, 0)).toBe('stalled');
  });
});

describe('present link monitor — an opener that reports nothing', () => {
  it('degrades honestly instead of faking paint evidence', () => {
    // A cached older /present sink calls a frame function that returns void.
    // There is no paint evidence to be had, so the monitor must not invent any:
    // it stays 'waiting' (never 'live'), and still detects a VANISHED source.
    const m = createPresentLinkMonitor();
    for (let i = 0; i < 50; i++) m.tick({ sourcePresent: true });
    expect(m.state).toBe('waiting');
    expect(m.everPainted).toBe(false);
    expect(m.painted).toBe(0);
    expect(noSource(m, T.lostFrames)).toBe('lost');
  });

  it('counts every tick, so "zero samples" is distinguishable from "all bad"', () => {
    // The continuity gate fails on zero samples. That is only possible if the
    // sink can say how many frames it actually observed.
    const fresh = createPresentLinkMonitor();
    expect(fresh.ticks).toBe(0);
    healthy(fresh, 7);
    expect(fresh.ticks).toBe(7);
  });
});
