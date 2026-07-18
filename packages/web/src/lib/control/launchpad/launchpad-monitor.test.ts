// packages/web/src/lib/control/launchpad/launchpad-monitor.test.ts
//
// OUT TO LAUNCH — the Launchpad monitor path. Two halves, both pure/hardware-free:
//   1. The video→LED surface mapping (launchpad-sysex): lpMonitorIndex,
//      rgb8ToLp, monitorGridToLeds — the 9×9 grid → programmer-index colour map.
//   2. The monitor DEVICE binding (launchpad-device): bindMonitor claims a
//      device (enters programmer mode), setMonitorFrame emits a diffed batch
//      SysEx, isOutputClaimed enforces one-owner-per-surface, unbindMonitor
//      blanks + releases.

import { describe, it, expect, beforeEach } from 'vitest';
import type { MidiInputLike } from '$lib/audio/modules/midi-cv-buddy';
import type { MidiOutputLike } from '$lib/audio/modules/midi-out-buddy';
import {
  lpMonitorIndex,
  LP_MONITOR_INDICES,
  LP_MONITOR_CELLS,
  LP_MONITOR_COLS,
  LP_MONITOR_ROWS,
  rgb8ToLp,
  monitorGridToLeds,
  encodeEnterProgrammerMode,
  encodeExitProgrammerMode,
  CC_LOGO,
} from './launchpad-sysex';
import {
  bindMonitor,
  unbindMonitor,
  isMonitorBound,
  monitorOutputId,
  isOutputClaimed,
  setMonitorFrame,
  bindUnit,
  __test_setAccess,
  __test_resetLaunchpad,
  type MidiFullAccessLike,
} from './launchpad-device.svelte';

// ── 1. Pure surface mapping ────────────────────────────────────────────────

describe('lpMonitorIndex — 9×9 surface → programmer index', () => {
  it('maps the four corners + the border rows/cols to the right buttons', () => {
    expect(lpMonitorIndex(0, 0)).toBe(11); // bottom-left pad
    expect(lpMonitorIndex(7, 7)).toBe(88); // top-right pad
    expect(lpMonitorIndex(0, 8)).toBe(91); // top row, leftmost CC (▲)
    expect(lpMonitorIndex(7, 8)).toBe(98); // top row, 8th CC
    expect(lpMonitorIndex(8, 0)).toBe(19); // right scene col, bottom
    expect(lpMonitorIndex(8, 7)).toBe(89); // right scene col, top
    expect(lpMonitorIndex(8, 8)).toBe(99); // corner LOGO (top-right)
    expect(lpMonitorIndex(8, 8)).toBe(CC_LOGO);
  });

  it('LP_MONITOR_INDICES covers all 81 addressable LEDs, uniquely', () => {
    expect(LP_MONITOR_INDICES).toHaveLength(LP_MONITOR_CELLS);
    expect(LP_MONITOR_CELLS).toBe(81);
    expect(new Set(LP_MONITOR_INDICES).size).toBe(81);
    // Spot-check the four LED families are all present.
    for (const idx of [11, 88, 91, 98, 19, 89, 99]) {
      expect(LP_MONITOR_INDICES).toContain(idx);
    }
  });
});

describe('rgb8ToLp — 8-bit channel → 7-bit LED value', () => {
  it('maps the endpoints (0→0, 255→127) at unity bright/gamma', () => {
    expect(rgb8ToLp(0, 1, 1)).toBe(0);
    expect(rgb8ToLp(255, 1, 1)).toBe(127);
  });
  it('is monotonic non-decreasing across the input range', () => {
    let prev = -1;
    for (let v = 0; v <= 255; v += 15) {
      const cur = rgb8ToLp(v, 1, 1);
      expect(cur).toBeGreaterThanOrEqual(prev);
      prev = cur;
    }
  });
  it('brightness scales the output; 0 brightness = off', () => {
    expect(rgb8ToLp(255, 0, 1)).toBe(0);
    expect(rgb8ToLp(255, 0.5, 1)).toBe(64); // round(0.5*127)=64
  });
  it('gamma > 1 darkens the mid-tones (a mid input drops below its linear value)', () => {
    const linear = rgb8ToLp(128, 1, 1);
    const gammad = rgb8ToLp(128, 1, 2.2);
    expect(gammad).toBeLessThan(linear);
    // Endpoints are gamma-invariant (0^g=0, 1^g=1).
    expect(rgb8ToLp(0, 1, 2.2)).toBe(0);
    expect(rgb8ToLp(255, 1, 2.2)).toBe(127);
  });
  it('clamps out-of-range + non-finite inputs', () => {
    expect(rgb8ToLp(-10, 1, 1)).toBe(0);
    expect(rgb8ToLp(999, 1, 1)).toBe(127);
    expect(rgb8ToLp(Number.NaN, 1, 1)).toBe(0);
  });
});

/** Build a bottom-origin 9×9 RGBA grid, painting one cell (col,row) a colour. */
function gridWithCell(col: number, row: number, rgb: [number, number, number]): Uint8Array {
  const g = new Uint8Array(LP_MONITOR_CELLS * 4);
  const p = (row * LP_MONITOR_COLS + col) * 4;
  g[p] = rgb[0]; g[p + 1] = rgb[1]; g[p + 2] = rgb[2]; g[p + 3] = 255;
  return g;
}

describe('monitorGridToLeds — 9×9 RGBA readback → LED colour map', () => {
  it('is UPRIGHT: the bottom-left readback pixel lands on pad 11', () => {
    const leds = monitorGridToLeds(gridWithCell(0, 0, [255, 0, 0]));
    expect(leds.get(11)).toEqual([127, 0, 0]);
  });
  it('the top-right readback pixel lands on the corner logo (99)', () => {
    const leds = monitorGridToLeds(gridWithCell(8, 8, [0, 0, 255]));
    expect(leds.get(99)).toEqual([0, 0, 127]);
  });
  it('the top-LEFT readback pixel lands on the top CC row (91)', () => {
    const leds = monitorGridToLeds(gridWithCell(0, 8, [0, 255, 0]));
    expect(leds.get(91)).toEqual([0, 127, 0]);
  });
  it('emits all 81 cells by default; includeLogo:false drops the logo (99)', () => {
    expect(monitorGridToLeds(new Uint8Array(LP_MONITOR_CELLS * 4)).size).toBe(81);
    const noLogo = monitorGridToLeds(new Uint8Array(LP_MONITOR_CELLS * 4), { includeLogo: false });
    expect(noLogo.size).toBe(80);
    expect(noLogo.has(99)).toBe(false);
  });
  it('applies bright + gamma per channel', () => {
    const leds = monitorGridToLeds(gridWithCell(0, 0, [255, 128, 0]), { bright: 0.5, gamma: 1 });
    expect(leds.get(11)).toEqual([rgb8ToLp(255, 0.5, 1), rgb8ToLp(128, 0.5, 1), 0]);
  });
});

// ── 2. Monitor device binding ──────────────────────────────────────────────

function fakeInput(id: string): MidiInputLike {
  return { id, name: 'LPMiniMK3 MIDI In', manufacturer: 'Focusrite - Novation', state: 'connected', onmidimessage: null } as unknown as MidiInputLike;
}
/** A fake output that records every byte run it is sent. */
function recordingOutput(id: string): MidiOutputLike & { sent: Uint8Array[] } {
  const sent: Uint8Array[] = [];
  return {
    id,
    name: 'LPMiniMK3 MIDI Out',
    manufacturer: 'Focusrite - Novation',
    state: 'connected',
    sent,
    send(d: number[] | Uint8Array) { sent.push(d instanceof Uint8Array ? d.slice() : new Uint8Array(d)); },
  } as unknown as MidiOutputLike & { sent: Uint8Array[] };
}
function fakeAccess(inputs: MidiInputLike[], outputs: MidiOutputLike[]): MidiFullAccessLike {
  return {
    inputs: new Map(inputs.map((p) => [p.id, p])),
    outputs: new Map(outputs.map((p) => [p.id, p])),
    onstatechange: null,
  };
}
const bytesEq = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((v, i) => v === b[i]);
const isLightingBatch = (m: Uint8Array) =>
  m[0] === 0xf0 && m[1] === 0x00 && m[2] === 0x20 && m[3] === 0x29 && m[4] === 0x02 && m[5] === 0x0d && m[6] === 0x03;

describe('monitor device binding', () => {
  beforeEach(() => __test_resetLaunchpad());

  it('bindMonitor claims a device + enters programmer mode', () => {
    const out = recordingOutput('outA');
    __test_setAccess(fakeAccess([fakeInput('inA')], [out]));
    expect(bindMonitor('nodeA', 'outA')).toBe(true);
    expect(isMonitorBound('nodeA')).toBe(true);
    expect(monitorOutputId('nodeA')).toBe('outA');
    // First thing sent is the programmer-mode enter SysEx.
    expect(out.sent.length).toBeGreaterThanOrEqual(1);
    expect(bytesEq(out.sent[0], encodeEnterProgrammerMode())).toBe(true);
  });

  it('refuses a device already claimed by ANOTHER monitor (exclusive LED control)', () => {
    __test_setAccess(fakeAccess([fakeInput('inA')], [recordingOutput('outA')]));
    expect(bindMonitor('nodeA', 'outA')).toBe(true);
    expect(isOutputClaimed('outA')).toBe(true);
    expect(bindMonitor('nodeB', 'outA')).toBe(false); // owned by nodeA
    expect(isMonitorBound('nodeB')).toBe(false);
    // …but is idempotent for the SAME token+device.
    expect(bindMonitor('nodeA', 'outA')).toBe(true);
  });

  it('refuses a device already claimed by an L/R clip-launcher unit', () => {
    __test_setAccess(fakeAccess([fakeInput('inA')], [recordingOutput('outA')]));
    expect(bindUnit('L', 'inA', 'outA')).toBe(true);
    expect(isOutputClaimed('outA')).toBe(true);
    expect(bindMonitor('mon', 'outA')).toBe(false);
  });

  it('setMonitorFrame emits a diffed batch SysEx (changed LEDs only)', () => {
    const out = recordingOutput('outA');
    __test_setAccess(fakeAccess([fakeInput('inA')], [out]));
    bindMonitor('nodeA', 'outA');
    out.sent.length = 0; // drop the enter-programmer SysEx

    const frame1 = { leds: new Map<number, [number, number, number]>([[11, [10, 20, 30]]]) };
    setMonitorFrame('nodeA', frame1);
    expect(out.sent.length).toBe(1);
    expect(isLightingBatch(out.sent[0])).toBe(true);

    // Identical frame → diff is empty → nothing sent.
    setMonitorFrame('nodeA', { leds: new Map([[11, [10, 20, 30]]]) });
    expect(out.sent.length).toBe(1);

    // Changed colour → a new batch.
    setMonitorFrame('nodeA', { leds: new Map([[11, [40, 50, 60]]]) });
    expect(out.sent.length).toBe(2);

    // Unbound token → no-op (never throws).
    expect(() => setMonitorFrame('ghost', frame1)).not.toThrow();
  });

  it('unbindMonitor blanks the surface, exits programmer mode, releases the claim', () => {
    const out = recordingOutput('outA');
    __test_setAccess(fakeAccess([fakeInput('inA')], [out]));
    bindMonitor('nodeA', 'outA');
    out.sent.length = 0;
    unbindMonitor('nodeA');
    expect(isMonitorBound('nodeA')).toBe(false);
    expect(isOutputClaimed('outA')).toBe(false);
    // A blank-all batch, then the exit-to-Live SysEx.
    expect(out.sent.length).toBeGreaterThanOrEqual(2);
    expect(isLightingBatch(out.sent[0])).toBe(true);
    expect(bytesEq(out.sent[out.sent.length - 1], encodeExitProgrammerMode())).toBe(true);
    // Idempotent.
    expect(() => unbindMonitor('nodeA')).not.toThrow();
  });

  it('two monitors bind two DIFFERENT devices simultaneously', () => {
    __test_setAccess(fakeAccess(
      [fakeInput('inA'), fakeInput('inB')],
      [recordingOutput('outA'), recordingOutput('outB')],
    ));
    expect(bindMonitor('nodeA', 'outA')).toBe(true);
    expect(bindMonitor('nodeB', 'outB')).toBe(true);
    expect(monitorOutputId('nodeA')).toBe('outA');
    expect(monitorOutputId('nodeB')).toBe('outB');
    expect(LP_MONITOR_ROWS * LP_MONITOR_COLS).toBe(81); // surface sanity
  });
});
