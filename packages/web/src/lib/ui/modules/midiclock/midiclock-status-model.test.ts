// packages/web/src/lib/ui/modules/midiclock/midiclock-status-model.test.ts
//
// THE ONLY GATE THAT CAN SEE THESE STRINGS.
//
// `StatusLed`'s `detail` reaches `aria-label` and `title` and NEVER a text
// node — which is exactly why it is allowed on a faceplate, and exactly why it
// is unguarded everywhere else. A dock VRT baseline cannot photograph it. A
// human reviewing that baseline cannot read it. `face-resting-text-source`
// reads the DECLARATION SURFACE and the shell, not a body's markup, and says
// so about its own blind spot. So a sentence here that said the wrong thing
// would ship green and stay green.
//
// The lamp's own correctness (lit vs dark) is a boolean the component owns and
// the e2e reads off `data-lit`. What needs a test is the PROSE beside it, and
// in particular the three distinctions a lazier implementation would collapse.

import { describe, it, expect } from 'vitest';
import {
  midiclockDeviceDetail,
  midiclockDeviceName,
  midiclockTransportDetail,
  type MidiclockDeviceEntry,
} from './midiclock-status-model';

const dev = (id: string, name: string): MidiclockDeviceEntry => ({ id, name, state: 'connected' });

describe('midiclockDeviceName', () => {
  it('uses the port name when there is one', () => {
    expect(midiclockDeviceName(dev('p1', 'Elektron Digitakt II'))).toBe('Elektron Digitakt II');
  });

  it('falls back to the ID rather than rendering a blank row', () => {
    // ⚠ NOT COSMETIC. Web MIDI returns an absent or empty `name` on some
    // platforms; the engine already substitutes the port id for `null`, but an
    // EMPTY STRING survives that substitution. Two blank rows in a picker are
    // indistinguishable to the player, so the pick becomes a guess.
    expect(midiclockDeviceName(dev('port-7', ''))).toBe('port-7');
    expect(midiclockDeviceName(dev('port-7', '   '))).toBe('port-7');
  });
});

describe('midiclockDeviceDetail — the MIDI lamp\'s sentence', () => {
  const base = { connected: false, permissionDenied: false, devices: [], selectedDeviceId: null };

  it('distinguishes NOT-YET-ASKED from REFUSED', () => {
    // ⚠ THE DISTINCTION THAT MATTERS MOST ON THIS MODULE, and the one a single
    // "not connected" string would destroy. `midi-access.ts` exists because a
    // browser that quietly suppresses its own permission prompt is
    // indistinguishable from a broken button — the whole seam is about naming
    // outcomes. A lamp that said the same thing in both states would undo that
    // in the one place a screen reader can hear it.
    expect(midiclockDeviceDetail(base)).toMatch(/press Connect MIDI/i);
    expect(midiclockDeviceDetail({ ...base, permissionDenied: true })).toMatch(/refused|cannot/i);
    expect(midiclockDeviceDetail(base)).not.toBe(
      midiclockDeviceDetail({ ...base, permissionDenied: true }),
    );
  });

  it('distinguishes GRANTED-BUT-NO-HARDWARE from GRANTED-AND-LISTENING', () => {
    // "connected" is genuinely ambiguous on this module: the browser can grant
    // access to a machine with no MIDI ports at all, and a player staring at a
    // silent rack needs to know which of the two they are in.
    const granted = { ...base, connected: true };
    expect(midiclockDeviceDetail(granted)).toMatch(/no MIDI inputs found/i);

    const listening = {
      ...base,
      connected: true,
      devices: [dev('p1', 'Digitakt'), dev('p2', 'MPC')],
      selectedDeviceId: 'p2',
    };
    expect(midiclockDeviceDetail(listening)).toMatch(/listening to MPC/);
  });

  it('names the SELECTED device, not the first one', () => {
    // NEGATIVE CONTROL, and it is the failure mode a `devices[0]` shortcut
    // produces: correct on every one-device machine, wrong on every other, and
    // silent either way.
    const s = {
      ...base,
      connected: true,
      devices: [dev('p1', 'Digitakt'), dev('p2', 'MPC')],
      selectedDeviceId: 'p2',
    };
    expect(midiclockDeviceDetail(s)).not.toMatch(/Digitakt/);
  });

  it('handles a SELECTION THAT NO LONGER RESOLVES', () => {
    // The hot-unplug case. `access.onstatechange` deliberately KEEPS the
    // selection when a device vanishes so it re-attaches on re-plug — correct,
    // and it leaves `selectedDeviceId` pointing at nothing. Reporting
    // "listening to undefined" is the bug this covers.
    const s = { ...base, connected: true, devices: [dev('p1', 'Digitakt')], selectedDeviceId: 'gone' };
    expect(midiclockDeviceDetail(s)).toBe('connected — no input selected yet');
  });
});

describe('midiclockTransportDetail — the RUN lamp, and the finding it carries', () => {
  // ⚠ THIS SENTENCE IS THE ONLY SURVIVING SURFACE FOR A REAL FINDING. The
  // legacy card's `STATE: RUN/STOP` was the ONLY place in the product that
  // showed whether the EXTERNAL transport is running, and it is not redundant
  // with TIMELORDE's own transport: the premise of this module is that
  // something outside the browser is the boss, and `run` is a level a player
  // may not have patched anywhere visible.
  it('says RUNNING and STOPPED differently, and both mention the transport', () => {
    expect(midiclockTransportDetail({ connected: true, running: true })).toMatch(/RUNNING/);
    expect(midiclockTransportDetail({ connected: true, running: false })).toMatch(/STOPPED/);
  });

  it('does NOT claim "stopped" when nothing is connected', () => {
    // ⚠ THE ONE THAT IS EASY TO GET WRONG BY BEING TERSE. Before a grant there
    // is no device, so there is no transport to report — "stopped" would be a
    // positive claim about a machine we have not been allowed to look at, and
    // "unknown" is a different fact. A dark lamp means both; only this string
    // separates them.
    const unbound = midiclockTransportDetail({ connected: false, running: false });
    expect(unbound).toMatch(/unknown/i);
    expect(unbound).not.toMatch(/STOPPED/);
    expect(unbound).not.toBe(midiclockTransportDetail({ connected: true, running: false }));
  });

  it('NEGATIVE CONTROL: it is not a constant', () => {
    // Every assertion above could be satisfied by a function returning one
    // long string containing every keyword. Three distinct outputs is the
    // property, and this is what asserts it.
    const seen = new Set([
      midiclockTransportDetail({ connected: false, running: false }),
      midiclockTransportDetail({ connected: true, running: false }),
      midiclockTransportDetail({ connected: true, running: true }),
    ]);
    expect(seen.size).toBe(3);
  });
});

describe('every string is a SENTENCE, never a bare measurement', () => {
  it('no detail is just a number', () => {
    // The shape check. `detail` is unpainted, but it is SPOKEN — and a screen
    // reader announcing "4128" is the aria-side twin of the readout the ruling
    // deleted. Every string here has to say what it is about.
    const all = [
      midiclockDeviceDetail({ connected: false, permissionDenied: false, devices: [], selectedDeviceId: null }),
      midiclockDeviceDetail({ connected: true, permissionDenied: false, devices: [dev('a', 'A')], selectedDeviceId: 'a' }),
      midiclockTransportDetail({ connected: true, running: true }),
      midiclockTransportDetail({ connected: false, running: false }),
    ];
    for (const s of all) {
      expect(s.trim().length, s).toBeGreaterThan(20);
      expect(/^[0-9.\s]+$/.test(s), s).toBe(false);
    }
  });
});
