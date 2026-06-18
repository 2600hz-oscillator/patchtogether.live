// packages/web/src/lib/electra/feedback.test.ts
import { describe, it, expect } from 'vitest';
import { FeedbackState, FeedbackPump, ECHO_WINDOW_MS } from './feedback';
import type { ElectraAllocation } from './types';

describe('FeedbackState delta dedupe', () => {
  it('sends a changed value, skips an unchanged repeat', () => {
    const s = new FeedbackState();
    expect(s.shouldSend('k', 64, 0)).toBe(true);
    expect(s.shouldSend('k', 64, 1)).toBe(false); // same value
    expect(s.shouldSend('k', 65, 2)).toBe(true); // changed
  });
});

describe('FeedbackState echo suppression', () => {
  it('suppresses an echo of the device-originated value inside the window', () => {
    const s = new FeedbackState();
    s.noteInbound('k', 100, 0); // device sent us cc 100 at t=0
    // App param now equals 100; the pump would try to echo 100 back → suppress.
    expect(s.shouldSend('k', 100, 50)).toBe(false); // within window
  });

  it('does NOT suppress once the window has elapsed', () => {
    const s = new FeedbackState();
    s.noteInbound('k', 100, 0);
    expect(s.shouldSend('k', 100, ECHO_WINDOW_MS + 1)).toBe(true);
  });

  it('does not suppress a DIFFERENT value (real motorized move)', () => {
    const s = new FeedbackState();
    s.noteInbound('k', 100, 0);
    expect(s.shouldSend('k', 101, 10)).toBe(true);
  });

  it('forget() resets a control', () => {
    const s = new FeedbackState();
    s.shouldSend('k', 64, 0);
    s.forget('k');
    expect(s.shouldSend('k', 64, 1)).toBe(true);
  });
});

describe('FeedbackPump', () => {
  const rw: ElectraAllocation = {
    key: 'mx:ch1_volume', pageId: 2, controlSetId: 1, potId: 1,
    deviceId: 1, messageType: 'cc7', number: 10, min: 0, max: 1, curve: 'linear', role: 'rw',
  };
  const meter: ElectraAllocation = {
    key: 'mx:meter:1', pageId: 2, controlSetId: 3, potId: 1,
    deviceId: 1, messageType: 'cc7', number: 50, role: 'meter',
  };

  it('pumps writable controls as curve-aware CC, deltaed', () => {
    const sent: Array<[number, number, number]> = [];
    let value = 0.5;
    let now = 0;
    const pump = new FeedbackPump([rw], {
      readParamValue: () => value,
      readMeterAmp: () => undefined,
      sendCc: (d, cc, v) => sent.push([d, cc, v]),
      now: () => now,
    });
    pump.pumpControls();
    expect(sent).toEqual([[1, 10, 64]]); // 0.5 → cc 64
    now = 1;
    pump.pumpControls();
    expect(sent.length).toBe(1); // unchanged → no resend
    value = 1;
    now = 2;
    pump.pumpControls();
    expect(sent[1]).toEqual([1, 10, 127]);
  });

  it('echo-suppresses a control the device just moved', () => {
    const sent: Array<[number, number, number]> = [];
    let now = 0;
    const pump = new FeedbackPump([rw], {
      readParamValue: () => 1, // app param now 1 (the device just set it)
      readMeterAmp: () => undefined,
      sendCc: (d, cc, v) => sent.push([d, cc, v]),
      now: () => now,
    });
    pump.noteInbound('mx:ch1_volume', 127); // device sent cc 127
    now = 10;
    pump.pumpControls();
    expect(sent.length).toBe(0); // suppressed
  });

  it('pumps meters as dBFS-mapped CC', () => {
    const sent: Array<[number, number, number]> = [];
    const pump = new FeedbackPump([meter], {
      readParamValue: () => undefined,
      readMeterAmp: () => 1, // full-scale amp → 0 dBFS → cc 127
      sendCc: (d, cc, v) => sent.push([d, cc, v]),
      now: () => 0,
    });
    pump.pumpMeters();
    expect(sent).toEqual([[1, 50, 127]]);
  });

  it('prime() FORCE-sends the current value of every writable control', () => {
    const sent: Array<[number, number, number]> = [];
    const pump = new FeedbackPump([rw], {
      readParamValue: () => 1, // full-scale → cc 127
      readMeterAmp: () => undefined,
      sendCc: (d, cc, v) => sent.push([d, cc, v]),
      now: () => 0,
    });
    expect(pump.prime()).toBe(1);
    expect(sent).toEqual([[1, 10, 127]]); // deviceId 1, cc 10, value 127
  });

  it('prime() RE-SENDS a value the steady pump already deduped (the first-load-0 bug)', () => {
    const sent: Array<[number, number, number]> = [];
    const pump = new FeedbackPump([rw], {
      readParamValue: () => 0.5, // → cc ~64
      readMeterAmp: () => undefined,
      sendCc: (d, cc, v) => sent.push([d, cc, v]),
      now: () => 0,
    });
    pump.pumpControls();            // first send (would be lost if the device isn't ready yet)
    expect(sent).toHaveLength(1);
    pump.pumpControls();            // deduped — value unchanged → NOT re-sent
    expect(sent).toHaveLength(1);
    // prime() resets the dedupe state and force-resends the live value.
    pump.prime();
    expect(sent).toHaveLength(2);
    expect(sent[1]![1]).toBe(10);  // same control's cc re-sent
  });

  it('prime() skips a control whose value is not readable yet (engine not live)', () => {
    const sent: Array<[number, number, number]> = [];
    const pump = new FeedbackPump([rw], {
      readParamValue: () => undefined, // engine not up at click time
      readMeterAmp: () => undefined,
      sendCc: (d, cc, v) => sent.push([d, cc, v]),
      now: () => 0,
    });
    expect(pump.prime()).toBe(0);
    expect(sent).toEqual([]);
  });
});
