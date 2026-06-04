// packages/web/src/lib/midi/midi-clock-source.test.ts
//
// REGRESSION: Web-MIDI access must be requested STRICTLY ON DEMAND.
//
// The bug this guards: the app popped the browser "Control and reprogram your
// MIDI devices" permission prompt on page load / on spawning a non-MIDI
// module. Root cause was createMidiClockSource() calling
// navigator.requestMIDIAccess() during CONSTRUCTION — so the first
// getMidiClockSource() consumer (e.g. COCOA DELAY spawned on its default
// System clock) prompted, even though the user never chose MIDI.
//
// The contract now:
//   * Constructing the source NEVER calls requestMIDIAccess.
//   * Holding the source for period math (without reading the tempo) NEVER
//     prompts.
//   * The FIRST getBpm()/getBeatPeriodS() read is the on-demand trigger and
//     fires requestMIDIAccess exactly once; subsequent reads do not re-prompt.
//   * COCOA DELAY's sync bridge only READS the MIDI tempo when the user has
//     selected MIDI as the clock source — System never touches Web MIDI.

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createMidiClockSource,
  __resetMidiClockSourceForTests,
} from './midi-clock-source';
import { resolveSyncPeriodS } from '../audio/modules/cocoadelay';

/** A minimal MIDIAccess-like that resolves with no inputs. */
function fakeAccess(): {
  inputs: Map<string, { onmidimessage: unknown }>;
  onstatechange: unknown;
} {
  return { inputs: new Map(), onstatechange: null };
}

/** Install a spy as navigator.requestMIDIAccess for the duration of a test.
 *  Mirrors the production browserDeps path (which reads navigator directly),
 *  so this exercises the REAL eager-vs-lazy code, not just an injected dep.
 *
 *  Node exposes a getter-only global `navigator`, so we patch its
 *  `requestMIDIAccess` PROPERTY (writable) rather than replacing the object. */
function installNavigatorSpy(): {
  spy: ReturnType<typeof vi.fn>;
  restore: () => void;
} {
  const nav = (globalThis as unknown as {
    navigator?: { requestMIDIAccess?: unknown };
  }).navigator;
  if (!nav) {
    throw new Error('test environment has no global navigator to patch');
  }
  const had = 'requestMIDIAccess' in nav;
  const prev = nav.requestMIDIAccess;
  const spy = vi.fn(async () => fakeAccess());
  nav.requestMIDIAccess = spy;
  return {
    spy,
    restore: () => {
      if (had) {
        nav.requestMIDIAccess = prev;
      } else {
        delete nav.requestMIDIAccess;
      }
    },
  };
}

afterEach(() => {
  __resetMidiClockSourceForTests();
  vi.restoreAllMocks();
});

describe('MIDI clock source: requestMIDIAccess is strictly on-demand', () => {
  it('does NOT request MIDI access on construction (the page-load bug)', () => {
    const { spy, restore } = installNavigatorSpy();
    try {
      // Use the REAL browser deps (only `now` overridden) so the production
      // requestAccess()/available() path against navigator is exercised.
      const src = createMidiClockSource({ now: () => 1000 });
      // The smoking gun: merely constructing must not prompt.
      expect(spy).not.toHaveBeenCalled();
      src.destroy();
    } finally {
      restore();
    }
  });

  it('requests access on the FIRST tempo read, and only once', () => {
    const { spy, restore } = installNavigatorSpy();
    try {
      let t = 1000;
      const src = createMidiClockSource({ now: () => t });
      expect(spy).not.toHaveBeenCalled();

      // First read = on-demand trigger.
      src.getBpm();
      expect(spy).toHaveBeenCalledTimes(1);

      // Subsequent reads must NOT re-prompt (idempotent ensureAccess).
      t += 1;
      src.getBpm();
      src.getBeatPeriodS();
      expect(spy).toHaveBeenCalledTimes(1);

      src.destroy();
    } finally {
      restore();
    }
  });

  it('getBeatPeriodS is the same on-demand trigger as getBpm', () => {
    const { spy, restore } = installNavigatorSpy();
    try {
      const src = createMidiClockSource({ now: () => 1000 });
      expect(spy).not.toHaveBeenCalled();
      src.getBeatPeriodS();
      expect(spy).toHaveBeenCalledTimes(1);
      src.destroy();
    } finally {
      restore();
    }
  });

  it('still works (derives BPM, attaches inputs) once access is granted', async () => {
    // available()=true + a resolving requestAccess: the on-demand path must
    // actually wire up. We feed clocks via ingest() (the same way the live
    // onmidimessage handler does) and confirm BPM derivation is intact.
    let t = 1000;
    const requestAccess = vi.fn(async () => fakeAccess());
    const src = createMidiClockSource({
      now: () => t,
      available: () => true,
      requestAccess,
    });
    // Not yet read → not yet requested.
    expect(requestAccess).not.toHaveBeenCalled();

    // First read triggers the request; let the promise resolve.
    expect(src.getBpm()).toBeNull(); // no clocks yet
    await Promise.resolve();
    await Promise.resolve();
    expect(requestAccess).toHaveBeenCalledTimes(1);

    // 120 BPM → quarter = 500 ms → per-pulse = 500/24 ms.
    const pulseMs = 500 / 24;
    for (let i = 0; i < 48; i++) {
      src.ingest(0xf8, t);
      t += pulseMs;
    }
    expect(src.getBpm()!).toBeCloseTo(120, 0);
    expect(requestAccess).toHaveBeenCalledTimes(1); // still just the one
    src.destroy();
  });
});

describe('COCOA DELAY sync bridge: only the MIDI clock-source touches Web MIDI', () => {
  // The factory itself needs a real AudioContext + worklet (covered by e2e),
  // but the load-bearing logic is "read the MIDI tempo only when MIDI is the
  // chosen clockSource". That gate is what keeps a default-System COCOA DELAY
  // spawn from prompting. We assert the gate directly against the clock source.
  const CLOCK_SOURCE_SYSTEM = 0;
  const CLOCK_SOURCE_MIDI = 1;

  it('System clock (default) never reads the MIDI tempo → never prompts', () => {
    const { spy, restore } = installNavigatorSpy();
    try {
      const src = createMidiClockSource({ now: () => 1000 });
      const nodes = { tl: { type: 'timelorde', params: { bpm: 120 } } };

      // Mirror cocoadelay.pushSyncPeriod's gate: read MIDI ONLY for MIDI src.
      const clockSource = CLOCK_SOURCE_SYSTEM;
      const midiBeatPeriodS =
        clockSource === CLOCK_SOURCE_MIDI ? src.getBeatPeriodS() : null;
      const period = resolveSyncPeriodS(clockSource, nodes, midiBeatPeriodS);

      expect(period).toBeCloseTo(0.5, 6); // 120 BPM system tempo
      expect(spy).not.toHaveBeenCalled(); // <- the regression
      src.destroy();
    } finally {
      restore();
    }
  });

  it('MIDI clock (explicitly selected) DOES read the tempo → prompts', () => {
    const { spy, restore } = installNavigatorSpy();
    try {
      const src = createMidiClockSource({ now: () => 1000 });
      const nodes = {};

      const clockSource = CLOCK_SOURCE_MIDI;
      const midiBeatPeriodS =
        clockSource === CLOCK_SOURCE_MIDI ? src.getBeatPeriodS() : null;
      resolveSyncPeriodS(clockSource, nodes, midiBeatPeriodS);

      expect(spy).toHaveBeenCalledTimes(1); // on-demand prompt is correct here
      src.destroy();
    } finally {
      restore();
    }
  });
});
