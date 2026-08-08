// packages/web/src/lib/midi/cc-out.test.ts
//
// THE PERMANENT NEGATIVE CONTROL for outbound CC.
//
// Read the two suppression tests as a PAIR. Together they pin the suppressor
// from both sides on every single run:
//
//   * "unchanged value is suppressed"  fails if the suppressor is wedged OFF
//     (always send) — the flood case.
//   * "changed value is transmitted"   fails if the suppressor is wedged ON
//     (never send) — the silent-device case, which is far worse because
//     everything else in the app still looks correct.
//
// Neither assertion alone can tell a working suppressor from a broken one, and
// a suite carrying only the first would certify a device that never receives
// anything. That is the whole reason they are written as one block with this
// comment attached, rather than filed under "dedupe" somewhere.

import { describe, expect, it } from 'vitest';
import {
  CC14_LSB_OFFSET,
  CC14_MAX_MSB,
  cc14Messages,
  ccMessage,
  createCcTransmitter,
  type CcOutputPort,
  type CcTransmitRecord,
} from './cc-out';

/** A capturing fake port — the unit-lane sibling of the e2e capture mock. */
function fakePort(id = 'p1'): CcOutputPort & { sent: number[][]; fail: boolean } {
  const port = {
    id,
    name: `fake ${id}`,
    sent: [] as number[][],
    fail: false,
    send(data: Uint8Array | number[]) {
      if (port.fail) throw new Error('port went away');
      port.sent.push(Array.from(data));
    },
  };
  return port;
}

function harness(initial?: { port?: CcOutputPort | null; channel?: number }) {
  // `initial?.port ?? fakePort()` would be WRONG: `??` treats an explicit
  // `null` as absent, so the no-port case would silently get a working port and
  // its assertion would test the opposite of what it claims. Presence of the
  // KEY is the question, not truthiness of the value.
  let port: CcOutputPort | null =
    initial && 'port' in initial ? initial.port! : fakePort();
  let channel = initial?.channel ?? 1;
  let clock = 0;
  const tx = createCcTransmitter({
    resolvePort: () => port,
    resolveChannel: () => channel,
    now: () => clock,
  });
  return {
    tx,
    setPort: (p: CcOutputPort | null) => { port = p; },
    setChannel: (c: number) => { channel = c; },
    tick: (ms = 1) => { clock += ms; },
    get port() { return port as ReturnType<typeof fakePort> | null; },
  };
}

const delivered = (r: CcTransmitRecord) => r.delivered;

describe('ccMessage — 7-bit encoding', () => {
  it('channel is 1-BASED on the way in and a 0-based nibble on the wire', () => {
    expect(Array.from(ccMessage(1, 64, 100))).toEqual([0xb0, 64, 100]);
    expect(Array.from(ccMessage(16, 64, 100))).toEqual([0xbf, 64, 100]);
  });

  it('clamps controller and value into 7 bits and rounds fractions', () => {
    expect(Array.from(ccMessage(1, 64, 200))).toEqual([0xb0, 64, 127]);
    expect(Array.from(ccMessage(1, 64, -5))).toEqual([0xb0, 64, 0]);
    expect(Array.from(ccMessage(1, 64, 63.6))).toEqual([0xb0, 64, 64]);
  });

  it('a non-finite value encodes as 0 rather than NaN (total, like the readout formatters)', () => {
    expect(Array.from(ccMessage(1, 64, Number.NaN))).toEqual([0xb0, 64, 0]);
  });
});

describe('cc14Messages — MSB / LSB-at-MSB+32', () => {
  it('splits a 14-bit value MSB-first, LSB on the paired controller', () => {
    const [msb, lsb] = cc14Messages(1, 10, 16383).map((m) => Array.from(m));
    expect(msb).toEqual([0xb0, 10, 127]);
    expect(lsb).toEqual([0xb0, 10 + CC14_LSB_OFFSET, 127]);
  });

  it('MSB carries the coarse value a 7-bit-only device would act on', () => {
    // 8192 = dead centre. A device ignoring the LSB still lands on 64.
    const [msb] = cc14Messages(1, 0, 8192).map((m) => Array.from(m));
    expect(msb).toEqual([0xb0, 0, 64]);
  });

  it('REFUSES a controller whose LSB would collide with a defined function', () => {
    // CC 64 is Sustain; its "LSB" would be CC 96 = Data Increment. Emitting
    // that silently would fire an unrelated function on the target device.
    expect(() => cc14Messages(1, 64, 100)).toThrow(/cannot carry a 14-bit MSB/);
    expect(() => cc14Messages(1, CC14_MAX_MSB, 100)).not.toThrow();
    expect(() => cc14Messages(1, CC14_MAX_MSB + 1, 100)).toThrow();
  });
});

describe('createCcTransmitter — suppression, BOTH directions (the permanent control)', () => {
  it('an UNCHANGED value is suppressed — exactly one message on the wire', () => {
    const h = harness();
    const first = h.tx.send('tilt', 64, 100);
    h.tick();
    const second = h.tx.send('tilt', 64, 100);

    expect(first.delivered, 'the first send reaches the port').toBe(true);
    expect(second.delivered, 'the identical resend does not').toBe(false);
    expect(second.reason).toBe('suppressed-redundant');
    expect(h.port!.sent, 'one message, not two').toEqual([[0xb0, 64, 100]]);
  });

  it('a CHANGED value IS transmitted — a wedged-on suppressor would fail here', () => {
    const h = harness();
    h.tx.send('tilt', 64, 10);
    h.tick();
    h.tx.send('tilt', 64, 20);
    h.tick();
    h.tx.send('tilt', 64, 10); // back to the first value — still a CHANGE

    expect(h.port!.sent).toEqual([
      [0xb0, 64, 10],
      [0xb0, 64, 20],
      [0xb0, 64, 10],
    ]);
  });

  it('suppression is per-CONTROLLER, not global', () => {
    const h = harness();
    h.tx.send('tilt', 64, 100);
    h.tx.send('rate', 66, 100); // same value, different controller
    expect(h.port!.sent).toEqual([
      [0xb0, 64, 100],
      [0xb0, 66, 100],
    ]);
  });

  it('two raw values that ROUND to the same byte count as unchanged', () => {
    // The wire cannot tell 100.2 from 100.4; sending both is exactly the
    // redundancy this exists to remove.
    const h = harness();
    h.tx.send('tilt', 64, 100.2);
    h.tx.send('tilt', 64, 100.4);
    expect(h.port!.sent).toEqual([[0xb0, 64, 100]]);
  });
});

describe('createCcTransmitter — the cache describes ONE destination', () => {
  it('changing PORT re-sends an unchanged value (the new device knows nothing)', () => {
    const a = fakePort('a');
    const b = fakePort('b');
    const h = harness({ port: a });
    h.tx.send('tilt', 64, 100);
    h.setPort(b);
    const afterSwap = h.tx.send('tilt', 64, 100);

    expect(afterSwap.delivered, 'the newly-selected device must be told').toBe(true);
    expect(b.sent, 'value landed on the new port').toEqual([[0xb0, 64, 100]]);
  });

  it('changing CHANNEL re-sends an unchanged value', () => {
    const h = harness();
    h.tx.send('tilt', 64, 100);
    h.setChannel(5);
    const afterSwap = h.tx.send('tilt', 64, 100);

    expect(afterSwap.delivered).toBe(true);
    expect(h.port!.sent).toEqual([
      [0xb0, 64, 100],
      [0xb4, 64, 100], // channel 5 → nibble 4
    ]);
  });

  it('resync() forgets everything, so a full push re-sends unchanged values', () => {
    const h = harness();
    h.tx.send('tilt', 64, 100);
    expect(h.tx.send('tilt', 64, 100).delivered).toBe(false);

    h.tx.resync();
    expect(h.tx.send('tilt', 64, 100).delivered, 'push-state-to-device').toBe(true);
    expect(h.port!.sent).toHaveLength(2);
  });
});

describe('createCcTransmitter — undelivered is RECORDED, never dropped', () => {
  it('no port: the attempt is in the ledger as delivered:false', () => {
    const h = harness({ port: null });
    const r = h.tx.send('tilt', 64, 100);

    expect(r.delivered).toBe(false);
    expect(r.reason).toBe('no-port');
    expect(r.portId).toBeNull();
    // The distinction that matters: this is NOT the same as never trying.
    expect(h.tx.ledger()).toHaveLength(1);
    expect(h.tx.ledger().filter(delivered)).toHaveLength(0);
  });

  it('a port that throws mid-send records send-threw AND forgets the value', () => {
    const h = harness();
    const port = h.port!;
    port.fail = true;
    const failed = h.tx.send('tilt', 64, 100);
    expect(failed.delivered).toBe(false);
    expect(failed.reason).toBe('send-threw');

    // The write never landed, so the suppressor must NOT believe it did —
    // otherwise a reconnect leaves the device stuck at a stale value forever.
    port.fail = false;
    h.tick();
    const retry = h.tx.send('tilt', 64, 100);
    expect(retry.delivered, 'the same value re-sends after a failed attempt').toBe(true);
    expect(port.sent).toEqual([[0xb0, 64, 100]]);
  });

  it('the ledger is bounded — a long session cannot grow without limit', () => {
    let clock = 0;
    const port = fakePort();
    const tx = createCcTransmitter({
      resolvePort: () => port,
      resolveChannel: () => 1,
      now: () => clock++,
      ledgerLimit: 4,
    });
    for (let i = 0; i < 20; i++) tx.send('tilt', 64, i);
    expect(tx.ledger()).toHaveLength(4);
    // …and it keeps the NEWEST, which is what a diagnostic needs.
    expect(tx.ledger().at(-1)!.value).toBe(19);
  });
});

describe('createCcTransmitter — 14-bit path', () => {
  it('emits the MSB/LSB pair as two adjacent messages, MSB first', () => {
    const h = harness();
    const r = h.tx.send('fine', 10, 16383, 14);
    expect(r.delivered).toBe(true);
    expect(h.port!.sent).toEqual([
      [0xb0, 10, 127],
      [0xb0, 10 + CC14_LSB_OFFSET, 127],
    ]);
  });

  it('suppresses on the 14-bit value, so sub-LSB jitter does not double-send', () => {
    const h = harness();
    h.tx.send('fine', 10, 8192, 14);
    h.tx.send('fine', 10, 8192.4, 14);
    expect(h.port!.sent).toHaveLength(2); // one PAIR, not two
  });
});
