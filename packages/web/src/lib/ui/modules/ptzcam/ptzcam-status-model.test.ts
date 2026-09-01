// packages/web/src/lib/ui/modules/ptzcam/ptzcam-status-model.test.ts
//
// The strings the PTZ device body speaks but does not paint.
//
// ⚠ THIS FILE IS THE ONLY INSTRUMENT IN THE TREE THAT CAN SEE MOST OF THEM.
// Reaching a bound camera needs a granted sysex-MIDI origin, a running native
// PT-PTZ helper and a physical PTZ head on USB; no CI runner has any of the
// three, the mocked-port e2e reaches two of the nine link kinds, and the VRT
// scene photographs only the unbound state. Everything past that ships on
// argument — so the argument is written down as executable assertions here,
// where the strings are decided.

import { describe, it, expect } from 'vitest';
import type { PtzStatus } from '$lib/audio/ptz-midi';
import type { PtzAxisCaps, PtzCaps } from '$lib/audio/ptz-sysex';
import {
  PTZ_AXES,
  ptzcamAxisDetail,
  ptzcamAxisIsVelocity,
  ptzcamAxisLamps,
  ptzcamIsBound,
  ptzcamIsProblem,
  ptzcamLinkDetail,
  ptzcamPortOptions,
} from './ptzcam-status-model';

const status = (over: Partial<PtzStatus>): PtzStatus => ({
  kind: 'idle',
  message: 'Not connected. Connect grants MIDI and finds the PT-PTZ helper.',
  caps: null,
  portName: null,
  ...over,
});

const ABS: PtzAxisCaps = { mode: 'abs', min: -612000, max: 612000, res: 1, cur: 0 };
const VEL: PtzAxisCaps = { mode: 'vel', speedMin: 1, speedMax: 1, speedRes: 1 };
const NONE: PtzAxisCaps = { mode: 'none' };

/** The two hardware fixtures the e2e captures byte-for-byte, as caps objects. */
const NEXIGO: PtzCaps = { pan: ABS, tilt: ABS, zoom: ABS };
const LOGITECH: PtzCaps = { pan: VEL, tilt: VEL, zoom: ABS };

describe('ptzcam link detail — all NINE kinds reach the lamp', () => {
  // ⚠ NOT "connected / not connected". `BindingImpl.status()` produces a
  // distinct sentence per kind, and several are the ONLY instruction in the
  // product for getting the helper running ("Start the helper (start_ptz.sh)",
  // "relaunch it with --disable-features=MidiMacUmp"). A model that collapsed
  // them would delete the diagnosis along with the readout — which is exactly
  // what deleting the card's status paragraph would have done if the lamp took
  // a summary instead of the message.
  const KINDS: PtzStatus['kind'][] = [
    'idle',
    'unsupported',
    'denied',
    'no-prompt',
    'no-port',
    'binding',
    'no-reply',
    'bound',
    'camera-absent',
  ];

  it('passes the binding layer\'s own sentence through, whatever the kind', () => {
    for (const kind of KINDS) {
      const msg = `sentence for ${kind}`;
      expect(ptzcamLinkDetail(status({ kind, message: msg })), kind).toBe(msg);
    }
  });

  it('has a sentence with NO status at all — the pre-engine frame', () => {
    // A body can render one frame before the engine handle exists; an empty
    // `aria-label` there would be a lamp that announces nothing.
    expect(ptzcamLinkDetail(null).length).toBeGreaterThan(20);
  });
});

describe('ptzcam link state — lit is BOUND, alert is a FAULT', () => {
  it('lights only on `bound`', () => {
    expect(ptzcamIsBound(status({ kind: 'bound' }))).toBe(true);
    for (const kind of ['idle', 'binding', 'no-port', 'no-reply', 'camera-absent'] as const) {
      expect(ptzcamIsBound(status({ kind })), kind).toBe(false);
    }
  });

  it('⚠ `idle` and `binding` are NOT faults — an error absent when nothing is wrong', () => {
    // The resting-text ruling permits painted ERROR text precisely because it
    // vanishes when nothing is wrong. Treating "nobody has pressed Connect yet"
    // or "handshake in flight" as an alert would make the fault line permanent
    // furniture and defeat that licence — and would fire a screen-reader alert
    // on every spawn.
    expect(ptzcamIsProblem(status({ kind: 'idle' }))).toBe(false);
    expect(ptzcamIsProblem(status({ kind: 'binding' }))).toBe(false);
    expect(ptzcamIsProblem(status({ kind: 'bound' }))).toBe(false);
    expect(ptzcamIsProblem(null)).toBe(false);
  });

  it('every OTHER kind is a fault the player must act on', () => {
    for (const kind of [
      'unsupported',
      'denied',
      'no-prompt',
      'no-port',
      'no-reply',
      'camera-absent',
    ] as const) {
      expect(ptzcamIsProblem(status({ kind })), kind).toBe(true);
    }
  });
});

describe('ptzcam axis lamps — the three-onto-two narrowing, stated', () => {
  it('lights on VELOCITY and only on velocity', () => {
    expect(ptzcamAxisIsVelocity(VEL)).toBe(true);
    expect(ptzcamAxisIsVelocity(ABS)).toBe(false);
    expect(ptzcamAxisIsVelocity(NONE)).toBe(false);
    expect(ptzcamAxisIsVelocity(undefined)).toBe(false);
  });

  it('⚠ NO CAPS ⇒ NO LAMPS — absence, not three dark lamps', () => {
    // THE ASSERTION THAT MATTERS MOST IN THIS FILE. `abs` and `none` both leave
    // a dark lamp, so an unguarded lamp block would render pre-handshake
    // exactly as it renders for a bound all-absolute NexiGo — and the face
    // would be claiming "all three axes are positions" about a module that
    // knows nothing about any camera yet. An empty list is what makes the body's
    // `{#if}` express "unknown" as the indicator's ABSENCE.
    expect(ptzcamAxisLamps(null)).toEqual([]);
    expect(ptzcamAxisLamps(undefined)).toEqual([]);
  });

  it('the NexiGo P610 fixture: three axes, all dark, all ABSOLUTE in the detail', () => {
    const lamps = ptzcamAxisLamps(NEXIGO);
    expect(lamps.map((l) => l.axis)).toEqual([...PTZ_AXES]);
    expect(lamps.every((l) => l.lit)).toBe(false);
    for (const l of lamps) expect(l.detail).toContain('ABSOLUTE');
  });

  it('the Logitech PTZ Pro 2 fixture: pan/tilt LIT, zoom dark', () => {
    // The mixed camera is the whole reason a per-axis lamp beats one badge: on
    // this head PAN and TILT are rates and ZOOM is a position, at the same time.
    const lamps = ptzcamAxisLamps(LOGITECH);
    expect(lamps.map((l) => [l.axis, l.lit])).toEqual([
      ['pan', true],
      ['tilt', true],
      ['zoom', false],
    ]);
  });

  it('a VELOCITY detail names the three things that differ from a knob', () => {
    // Sign is direction, zero is a stop, SLEW does nothing. Those are the facts
    // that make a velocity axis behave unlike every other control in the rack,
    // and the lamp is the only place left that says them.
    const d = ptzcamAxisDetail('pan', VEL);
    expect(d).toMatch(/RATE/);
    expect(d).toMatch(/direction/);
    expect(d).toMatch(/stop/);
    expect(d).toMatch(/SLEW is ignored/);
  });

  it('an ABSOLUTE detail carries the camera\'s own device-unit range', () => {
    expect(ptzcamAxisDetail('pan', ABS)).toContain('-612000..612000');
  });

  it('a `none` axis says the knob is IGNORED — not merely "unknown"', () => {
    // `mode: 'none'` is a real protocol value: the camera reports the axis is
    // not controllable. Sharing the dark lamp with `abs` is the narrowing; the
    // detail is where the two are separated, and "the knob is ignored" is the
    // only sentence that stops a player fighting a dead control.
    for (const axis of PTZ_AXES) {
      expect(ptzcamAxisDetail(axis, NONE)).toContain('not controllable');
      expect(ptzcamAxisDetail(axis, undefined)).toContain('not controllable');
    }
  });
});

describe('ptzcam port options — the `(offline)` row is PARITY, not decoration', () => {
  it('passes a live roster through unchanged', () => {
    expect(ptzcamPortOptions(['PT-PTZ-NEXIGOP6', 'PT-PTZ-PTZPRO2'], null)).toEqual([
      { value: 'PT-PTZ-NEXIGOP6', label: 'PT-PTZ-NEXIGOP6' },
      { value: 'PT-PTZ-PTZPRO2', label: 'PT-PTZ-PTZPRO2' },
    ]);
  });

  it('⚠ SYNTHESIZES the saved-but-absent pick, so reloading cannot silently lose it', () => {
    // `node.data.device` is a saved port NAME. A patch reloaded before the
    // helper starts holds a name the live roster does not contain, and a
    // `<select>` bound to a value with no matching option renders its FIRST
    // option instead — so without this row the player's saved camera would be
    // lost by rendering, and the next change event would persist the loss.
    const opts = ptzcamPortOptions(['PT-PTZ-NEXIGOP6'], 'PT-PTZ-PTZPRO2');
    expect(opts.map((o) => o.value)).toEqual(['PT-PTZ-NEXIGOP6', 'PT-PTZ-PTZPRO2']);
    expect(opts[1]!.label).toBe('PT-PTZ-PTZPRO2 (offline)');
  });

  it('does NOT duplicate a pick that IS present', () => {
    const opts = ptzcamPortOptions(['PT-PTZ-NEXIGOP6'], 'PT-PTZ-NEXIGOP6');
    expect(opts).toHaveLength(1);
    expect(opts[0]!.label).toBe('PT-PTZ-NEXIGOP6');
  });

  it('adds nothing for the AUTO default (null) or an empty saved name', () => {
    expect(ptzcamPortOptions([], null)).toEqual([]);
    expect(ptzcamPortOptions([], '')).toEqual([]);
  });
});
