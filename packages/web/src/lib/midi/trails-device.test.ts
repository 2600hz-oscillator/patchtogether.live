// packages/web/src/lib/midi/trails-device.test.ts
//
// The Bela Trails DEVICE LAYER, exercised through its own simulated double.
//
// The point of every case below is that the double replaces the USB cable and
// NOTHING ELSE: the port match, the `createMidiInputClaim` handler slot, the
// fan-out to subscribed modules and the real 14-bit assembler all run. A test
// that called the decoder directly would pass on a module that never attached
// to a port at all, which is the shape that has shipped green-and-silent
// modules in this repo before.

import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  __resetTrailsForTest,
  connectTrails,
  installSimulatedTrails,
  listTrailsPortNames,
  subscribeTrailsMidi,
  trailsAvailable,
  trailsStatus,
  TRAILS_PORT_PATTERN,
} from './trails-device';
import { createTrailsDecoder, type TrailsEvent } from './trails-decode';
import type { MidiEventLike } from '$lib/audio/modules/midi-cv-buddy';

afterEach(() => {
  __resetTrailsForTest();
  vi.unstubAllGlobals();
});

/** Collect every frame the device layer fans out, decoded the way the module
 *  factory decodes it — i.e. through the REAL assembler. */
function collectDecoded(): { events: TrailsEvent[]; stop: () => void } {
  const decoder = createTrailsDecoder();
  const events: TrailsEvent[] = [];
  let t = 0;
  const stop = subscribeTrailsMidi((ev: MidiEventLike) => {
    events.push(...decoder.handle(ev.data, (t += 1)));
  });
  return { events, stop };
}

describe('trails-device: the port match', () => {
  it('matches any name containing "trails", in any case', () => {
    for (const name of ['Trails', 'Bela Trails', 'trails MIDI 1', 'MIDIIN2 (TRAILS)']) {
      expect(TRAILS_PORT_PATTERN.test(name), name).toBe(true);
    }
    for (const name of ['Prophet Rev2', 'Push 2 Live Port', '']) {
      expect(TRAILS_PORT_PATTERN.test(name), name).toBe(false);
    }
  });

  it('binds the Trails port and ignores a decoy sharing the same access', async () => {
    const sim = await installSimulatedTrails({ decoyPortName: 'Prophet Rev2' });
    expect(sim.attached()).toBe(true);
    expect(listTrailsPortNames()).toEqual(['Bela Trails']);
    expect(trailsStatus().kind).toBe('bound');
  });

  it('attaches to BOTH halves of a duplicate-named pair (the WinMM shape)', async () => {
    const sim = await installSimulatedTrails({ duplicatePort: true });
    expect(sim.attached()).toBe(true);
    // Collapsed for DISPLAY, but both port objects carry a live handler — a
    // duplicate name is two different data streams on Windows, not one.
    expect(listTrailsPortNames()).toEqual(['Bela Trails']);
    const { events, stop } = collectDecoded();
    sim.touch(1, 1, 1);
    stop();
    // Two attached ports × two axes × (MSB then LSB) = 8 axis events.
    expect(events.filter((e) => e.kind === 'axis')).toHaveLength(8);
  });
});

describe('trails-device: connect never throws', () => {
  it('reports "unsupported" with no Web MIDI at all', async () => {
    vi.stubGlobal('navigator', {});
    expect(trailsAvailable()).toBe(false);
    await expect(connectTrails()).resolves.toBe(false);
    expect(trailsStatus().kind).toBe('unsupported');
  });

  it('reports "denied" when the request rejects, rather than propagating', async () => {
    await expect(
      connectTrails(async () => {
        throw new Error('NotAllowedError');
      }),
    ).resolves.toBe(false);
    const s = trailsStatus();
    expect(s.kind).toBe('denied');
    expect(s.message).toMatch(/refused/i);
  });

  it('reports "no-port" when access is granted but nothing named Trails is present', async () => {
    await connectTrails(async () => ({
      inputs: new Map([
        ['x', { id: 'x', name: 'Prophet Rev2', state: 'connected', onmidimessage: null }],
      ]),
      onstatechange: null,
    }));
    const s = trailsStatus();
    expect(s.kind).toBe('no-port');
    expect(s.message).toMatch(/USB-C/);
  });

  it('is idempotent — a second connect re-resolves and stays bound', async () => {
    const sim = await installSimulatedTrails();
    expect(trailsStatus().kind).toBe('bound');
    await expect(connectTrails()).resolves.toBe(true);
    expect(sim.attached()).toBe(true);
  });
});

describe('trails-device: the simulated device drives the REAL decode path', () => {
  it('a touch arrives as assembled 14-bit axis events on the right channel', async () => {
    const sim = await installSimulatedTrails();
    const { events, stop } = collectDecoded();
    sim.touch(2, 0.75, 0.25);
    stop();
    const axesOut = events.filter(
      (e): e is Extract<TrailsEvent, { kind: 'axis' }> => e.kind === 'axis',
    );
    // Four messages (two axes × MSB+LSB) → four events; the last of each axis
    // carries the fully assembled value.
    expect(axesOut).toHaveLength(4);
    const x = axesOut.filter((e) => e.axis === 'x').at(-1)!;
    const y = axesOut.filter((e) => e.axis === 'y').at(-1)!;
    expect(x.channel).toBe(2);
    expect(x.unit).toBeCloseTo(0.75, 4);
    expect(y.unit).toBeCloseTo(0.25, 4);
  });

  it('gates and clock reach subscribers too', async () => {
    const sim = await installSimulatedTrails();
    const { events, stop } = collectDecoded();
    sim.gateOn(3);
    sim.clock(2);
    sim.start();
    sim.gateOff(3);
    stop();
    expect(events.filter((e) => e.kind === 'clock')).toHaveLength(2);
    expect(events.filter((e) => e.kind === 'gate').map((e) => (e as { high: boolean }).high))
      .toEqual([true, false]);
    expect(events.filter((e) => e.kind === 'transport')).toHaveLength(1);
  });

  it('every subscribed module sees every frame (one claim, many consumers)', async () => {
    // `onmidimessage` is a single slot: per-module claims would evict each
    // other, and the evicted module would sit silent forever.
    const sim = await installSimulatedTrails();
    const a = collectDecoded();
    const b = collectDecoded();
    sim.touch(1, 0.5, 0.5);
    a.stop();
    b.stop();
    expect(a.events.length).toBeGreaterThan(0);
    expect(b.events.length).toBe(a.events.length);
  });

  it('unsubscribing stops delivery without disturbing the other subscribers', async () => {
    const sim = await installSimulatedTrails();
    const a = collectDecoded();
    const b = collectDecoded();
    a.stop();
    sim.touch(1, 0.5, 0.5);
    b.stop();
    expect(a.events).toHaveLength(0);
    expect(b.events.length).toBeGreaterThan(0);
  });

  it('a subscriber that throws does not starve the others', async () => {
    const sim = await installSimulatedTrails();
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const bad = subscribeTrailsMidi(() => {
      throw new Error('boom');
    });
    const good = collectDecoded();
    sim.touch(1, 0.5, 0.5);
    bad();
    good.stop();
    errors.mockRestore();
    expect(good.events.length).toBeGreaterThan(0);
  });

  it('uninstalling releases the claim — the port stops delivering', async () => {
    const sim = await installSimulatedTrails();
    const { events, stop } = collectDecoded();
    sim.uninstall();
    expect(sim.attached()).toBe(false);
    sim.touch(1, 1, 1);
    stop();
    expect(events).toHaveLength(0);
    expect(trailsStatus().kind).toBe('idle');
  });

  it('NEGATIVE CONTROL: with no device installed, a subscriber receives nothing', () => {
    // The instrument above can only be trusted if it can read empty.
    const { events, stop } = collectDecoded();
    stop();
    expect(events).toHaveLength(0);
    expect(trailsStatus().kind).toBe('idle');
  });
});
