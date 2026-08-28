// packages/web/src/lib/electra/broker.test.ts
import { describe, it, expect, vi } from 'vitest';
import {
  ElectraBroker,
  frameSysex,
  framePresetUpload,
  frameLuaUpload,
  framePageSwitch,
  frameIdentityRequest,
  parseIdentity,
  asciiToBytes,
  ccMessage,
  noteOnMessage,
  ELECTRA_MFR,
  type MidiFullAccessLike,
} from './broker';
import type { MidiOutputLike } from '$lib/audio/modules/midi-out-buddy';
import type { MidiInputLike, MidiEventLike } from '$lib/audio/modules/midi-cv-buddy';

describe('SysEx framing', () => {
  it('wraps F0 00 21 45 <cmd> <payload> F7', () => {
    const f = frameSysex([0x01, 0x01], [0x41, 0x42]);
    expect([...f]).toEqual([0xf0, 0x00, 0x21, 0x45, 0x01, 0x01, 0x41, 0x42, 0xf7]);
  });

  it('preset upload uses command 01 01 + 7-bit ASCII payload', () => {
    const f = framePresetUpload('AB');
    expect(f[0]).toBe(0xf0);
    expect([...f.slice(1, 6)]).toEqual([0x00, 0x21, 0x45, 0x01, 0x01]);
    expect([...f.slice(6, 8)]).toEqual([0x41, 0x42]);
    expect(f[f.length - 1]).toBe(0xf7);
  });

  it('Lua upload uses command 01 0C', () => {
    const f = frameLuaUpload('x');
    expect([...f.slice(4, 6)]).toEqual([0x01, 0x0c]);
  });

  it('page switch uses 09 0A <page>', () => {
    const f = framePageSwitch(2);
    expect([...f.slice(4, 7)]).toEqual([0x09, 0x0a, 0x02]);
  });

  it('identity request uses 02 7F', () => {
    const f = frameIdentityRequest();
    expect([...f.slice(4, 6)]).toEqual([0x02, 0x7f]);
  });

  it('asciiToBytes clamps to 7-bit', () => {
    expect(asciiToBytes('A')).toEqual([0x41]);
    // a high-codepoint char masks to its low 7 bits
    expect(asciiToBytes(String.fromCharCode(0xc1))).toEqual([0x41]);
  });

  it('ccMessage / noteOnMessage build correct status bytes', () => {
    expect(ccMessage(0, 7, 100)).toEqual([0xb0, 0x07, 0x64]);
    expect(ccMessage(1, 7, 100)).toEqual([0xb1, 0x07, 0x64]);
    expect(noteOnMessage(0, 60, 127)).toEqual([0x90, 0x3c, 0x7f]);
  });
});

describe('parseIdentity', () => {
  it('recognises the Electra manufacturer id', () => {
    const data = Uint8Array.from([0xf0, ...ELECTRA_MFR, 0x76, 0x33, 0x2e, 0x37, 0xf7]);
    const id = parseIdentity(data);
    expect(id.isElectra).toBe(true);
    expect(id.firmware).toBeTruthy();
  });
  it('rejects a non-Electra SysEx', () => {
    const data = Uint8Array.from([0xf0, 0x7d, 0x00, 0x00, 0xf7]);
    expect(parseIdentity(data).isElectra).toBe(false);
  });
});

// ──────────────────────────── fake device ────────────────────────────

function makeFakeAccess() {
  const sentCtrl: number[][] = [];
  const sentPlay: number[][] = [];
  let inputHandler: ((ev: MidiEventLike) => void) | null = null;

  const ctrlOut: MidiOutputLike = {
    id: 'electra-ctrl', name: 'Electra Controller CTRL', state: 'connected',
    send: (d) => sentCtrl.push([...(d as number[] | Uint8Array)]),
  };
  const playOut: MidiOutputLike = {
    id: 'electra-play', name: 'Electra Controller Port 1 PLAY', state: 'connected',
    send: (d) => sentPlay.push([...(d as number[] | Uint8Array)]),
  };
  const input: MidiInputLike = {
    id: 'electra-in', name: 'Electra Controller CTRL', state: 'connected',
    get onmidimessage() { return inputHandler; },
    set onmidimessage(h) { inputHandler = h; },
  };
  const access: MidiFullAccessLike = {
    inputs: new Map([[input.id, input]]),
    // PLAY first, CTRL second so the name heuristic (not order) must resolve them.
    outputs: new Map([[playOut.id, playOut], [ctrlOut.id, ctrlOut]]),
    onstatechange: null,
  };
  return {
    access, sentCtrl, sentPlay,
    emit: (data: number[]) => inputHandler?.({ data: Uint8Array.from(data), timeStamp: 0 }),
  };
}

// ───────────────── inbound port SCOPE (device crosstalk) ─────────────────
//
// `attachInputs()` used to claim EVERY input on the broker's access, and
// `handleInbound` filters only by STATUS BYTE — never by device, never by
// channel. Downstream, `ElectraAutoconfig.handleCc` looks the CC up in
// `allocByNumber` and WRITES the bound rack param. The preset generator
// allocates CCs from the bottom of the range upward, so its allocations overlap
// the Push 2 map (CC 15, 20-27, 71-79) and a keyboard's mod wheel (CC 1) —
// meaning a Push encoder turn could move an Electra-mapped parameter.
//
// The broker now listens on the Electra's OWN ports, resolved by the same
// name heuristic `resolvePorts()` has always used for the OUTPUT side, with a
// fail-safe fallback to every input when nothing is named for an Electra.

function makeMixedAccess(electraInputName: string | null) {
  const heard: number[][] = [];
  const mk = (id: string, name: string) => {
    let h: ((ev: MidiEventLike) => void) | null = null;
    return {
      port: {
        id, name, state: 'connected',
        get onmidimessage() { return h; },
        set onmidimessage(fn: ((ev: MidiEventLike) => void) | null) { h = fn; },
      } as MidiInputLike,
      fire: (data: number[]) => h?.({ data: Uint8Array.from(data), timeStamp: 0 }),
      attached: () => typeof h === 'function',
    };
  };
  const push = mk('push-in', 'Ableton Push 2 Live Port');
  const inputs = new Map<string, MidiInputLike>([[push.port.id, push.port]]);
  let electra: ReturnType<typeof mk> | null = null;
  if (electraInputName !== null) {
    electra = mk('electra-in', electraInputName);
    inputs.set(electra.port.id, electra.port);
  }
  const out: MidiOutputLike = {
    id: 'electra-ctrl', name: 'Electra Controller CTRL', state: 'connected',
    send: () => {},
  };
  const access: MidiFullAccessLike = {
    inputs,
    outputs: new Map([[out.id, out]]),
    onstatechange: null,
  };
  return { access, push, electra, heard };
}

describe('ElectraBroker inbound scope: the Electra hears its OWN device', () => {
  it('a Push CC does NOT reach the CC listeners when an Electra port is present', () => {
    const f = makeMixedAccess('Electra Controller CTRL');
    const b = new ElectraBroker();
    const seen: number[] = [];
    b.onCC((ev) => seen.push(ev.cc));
    b.__test_setAccess(f.access);

    // CC 27 — allocated by the preset generator AND the Push's SHIFT modifier.
    f.push.fire([0xb0, 27, 127]);
    expect(seen, 'a Push CC must not be read as an Electra CC').toEqual([]);
    expect(f.push.attached(), "the broker never claimed the Push's slot").toBe(false);

    // POSITIVE CONTROL — the same CC on the Electra's own port DOES arrive, so
    // the assertion above is scope, not a dead listener.
    f.electra!.fire([0xb0, 27, 127]);
    expect(seen, "the Electra's own CC still arrives").toEqual([27]);
  });

  it('notes are scoped the same way (the tap pad / button pads)', () => {
    const f = makeMixedAccess('Electra Controller Port 1');
    const b = new ElectraBroker();
    const seen: number[] = [];
    b.onNote((ev) => seen.push(ev.note));
    b.__test_setAccess(f.access);
    f.push.fire([0x90, 36, 100]); // a Push PAD — note 36 is also an Electra pad
    expect(seen).toEqual([]);
    f.electra!.fire([0x90, 36, 100]);
    expect(seen).toEqual([36]);
  });

  it('FAIL-SAFE — with no Electra-named input it still listens to everything', () => {
    // Unknown platform naming, or the pre-identification probe window. Losing
    // identification would be worse than the crosstalk, so the pool falls back.
    const f = makeMixedAccess(null);
    const b = new ElectraBroker();
    const seen: number[] = [];
    b.onCC((ev) => seen.push(ev.cc));
    b.__test_setAccess(f.access);
    f.push.fire([0xb0, 27, 127]);
    expect(seen, 'fallback: every input, exactly as before').toEqual([27]);
  });

  it('setting a null access releases only the slots the broker installed', () => {
    const f = makeMixedAccess('Electra Controller CTRL');
    const foreign = (): void => {};
    f.push.port.onmidimessage = foreign; // another subsystem owns the Push port
    const b = new ElectraBroker();
    b.__test_setAccess(f.access);
    b.__test_setAccess(null);
    expect(f.push.port.onmidimessage, 'a foreign handler survives').toBe(foreign);
  });
});

describe('ElectraBroker with a fake device', () => {
  it('resolves CTRL vs PLAY ports by name + routes sends', () => {
    const fake = makeFakeAccess();
    const b = new ElectraBroker();
    b.__test_setAccess(fake.access);
    b.uploadPreset('AB'); // CTRL
    b.sendNote(60, 127, 'play'); // PLAY
    expect(fake.sentCtrl.length).toBe(1);
    expect(fake.sentCtrl[0]![0]).toBe(0xf0);
    expect(fake.sentPlay.length).toBe(1);
    expect(fake.sentPlay[0]).toEqual([0x90, 60, 127]);
  });

  it('routes management SysEx to CTRL and per-control CC to numbered ports', () => {
    const sent: { p1: number[][]; p2: number[][]; ctrl: number[][] } = { p1: [], p2: [], ctrl: [] };
    const mk = (id: string, name: string, bucket: number[][]): MidiOutputLike => ({
      id, name, state: 'connected',
      send: (d) => bucket.push([...(d as number[] | Uint8Array)]),
    });
    const p1 = mk('e1', 'Electra Controller Port 1', sent.p1);
    const p2 = mk('e2', 'Electra Controller Port 2', sent.p2);
    const ctrl = mk('e3', 'Electra Controller CTRL', sent.ctrl);
    const access: MidiFullAccessLike = {
      inputs: new Map(),
      // Port 2 enumerated FIRST so a port-2 name match can't masquerade as mgmt.
      outputs: new Map([[p2.id, p2], [p1.id, p1], [ctrl.id, ctrl]]),
      onstatechange: null,
    };
    const b = new ElectraBroker();
    b.__test_setAccess(access);
    b.uploadPreset('AB'); // management → CTRL, NOT Port 2
    expect(sent.ctrl.length).toBe(1);
    expect(sent.ctrl[0]![0]).toBe(0xf0);
    expect(sent.p2.length).toBe(0);
    b.sendCcOnPort(2, 7, 100); // PT-CTRL device.port=2 → Port 2
    b.sendCcOnPort(1, 9, 64); //  PT-PLAY device.port=1 → Port 1
    expect(sent.p2).toEqual([[0xb0, 7, 100]]);
    expect(sent.p1).toEqual([[0xb0, 9, 64]]);
    expect(sent.ctrl.length).toBe(1); // CC never leaks onto the mgmt port
  });

  it('fans out inbound CC to onCC listeners', () => {
    const fake = makeFakeAccess();
    const b = new ElectraBroker();
    b.__test_setAccess(fake.access);
    const onCc = vi.fn();
    b.onCC(onCc);
    fake.emit([0xb0, 7, 100]);
    expect(onCc).toHaveBeenCalledWith({ channel: 0, cc: 7, value: 100 });
  });

  it('fans out inbound SysEx to onSysex listeners', () => {
    const fake = makeFakeAccess();
    const b = new ElectraBroker();
    b.__test_setAccess(fake.access);
    const onSysex = vi.fn();
    b.onSysex(onSysex);
    fake.emit([0xf0, ...ELECTRA_MFR, 0xf7]);
    expect(onSysex).toHaveBeenCalledOnce();
  });

  it('hasElectraDevice: name-STRICT — a foreign interface never reads as an Electra', () => {
    const b = new ElectraBroker();
    expect(b.hasElectraDevice(), 'no access yet').toBe(false);

    // Only a generic interface present: electraInputs() would fall back to it
    // for LISTENING, but the auto-flash presence predicate must say NO.
    const generic: MidiOutputLike = {
      id: 'g1', name: 'USB MIDI Interface', state: 'connected', send: () => {},
    };
    const access: MidiFullAccessLike = {
      inputs: new Map(),
      outputs: new Map([[generic.id, generic]]),
      onstatechange: null,
    };
    b.__test_setAccess(access);
    expect(b.hasElectraDevice(), 'generic port is not an Electra').toBe(false);

    // An Electra-named port flips it — and a 'disconnected' one flips it back
    // (Chromium keeps unplugged ports enumerated with state: 'disconnected').
    const electra: MidiOutputLike = {
      id: 'e1', name: 'Electra Controller CTRL', state: 'connected', send: () => {},
    };
    access.outputs.set(electra.id, electra);
    expect(b.hasElectraDevice()).toBe(true);
    electra.state = 'disconnected';
    expect(b.hasElectraDevice()).toBe(false);
  });

  it('onStateChange fans out the single access.onstatechange slot (after re-attach)', () => {
    const fake = makeFakeAccess();
    const b = new ElectraBroker();
    b.__test_setAccess(fake.access);
    const seen = vi.fn();
    const off = b.onStateChange(seen);
    // __test_setAccess wired the slot exactly like connect() does.
    fake.access.onstatechange?.({ port: [...fake.access.inputs.values()][0]! });
    expect(seen).toHaveBeenCalledTimes(1);
    // A port added between events is claimed by the broker's re-attach BEFORE
    // listeners run — a listener that reads the port map sees the new world.
    let attachedAtNotify = false;
    let extraHandler: ((ev: MidiEventLike) => void) | null = null;
    const extra: MidiInputLike = {
      id: 'electra-in-2', name: 'Electra Controller Port 1', state: 'connected',
      get onmidimessage() { return extraHandler; },
      set onmidimessage(h) { extraHandler = h; },
    };
    b.onStateChange(() => { attachedAtNotify = typeof extraHandler === 'function'; });
    fake.access.inputs.set(extra.id, extra);
    fake.access.onstatechange?.({ port: extra });
    expect(attachedAtNotify, 'inputs re-attached before fan-out').toBe(true);
    // Unsubscribe releases the listener.
    off();
    fake.access.onstatechange?.({ port: extra });
    expect(seen).toHaveBeenCalledTimes(2);
  });

  it('identify() resolves true when the device replies with its mfr id', async () => {
    const fake = makeFakeAccess();
    const b = new ElectraBroker();
    b.__test_setAccess(fake.access);
    const p = b.identify(200);
    // Device replies on the input.
    fake.emit([0xf0, ...ELECTRA_MFR, 0x33, 0x2e, 0x37, 0xf7]);
    const id = await p;
    expect(id.isElectra).toBe(true);
    // The identity probe went out on CTRL.
    expect(fake.sentCtrl.some((m) => m[4] === 0x02 && m[5] === 0x7f)).toBe(true);
  });
});
