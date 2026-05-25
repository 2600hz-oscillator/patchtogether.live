// packages/web/src/lib/doom/doom-presence.test.ts
//
// Pure-function coverage for the Yjs-awareness encode/decode pair +
// the host-migration tie-break. Doesn't spin up an actual Yjs provider —
// that's covered by the multi-tab Playwright spec.

import { describe, it, expect } from 'vitest';
import {
  encodeKey,
  decodeKey,
  encodeFrame,
  decodeFrame,
  decodeFrameBuffer,
  pickHost,
  collectIncomingKeyPushes,
  type KeyEnvelope,
  type RelayCursor,
} from './doom-presence';

describe('encodeKey / decodeKey — key envelope round-trip', () => {
  it('round-trips a key-down envelope', () => {
    const env: KeyEnvelope = {
      kind: 'key',
      moduleId: 'doom-abc',
      srcUserId: 'user-1',
      doomKey: 0x77,
      pressed: true,
      ts: 1700000000000,
    };
    const decoded = decodeKey(encodeKey(env));
    expect(decoded).toEqual(env);
  });

  it('round-trips a key-up envelope', () => {
    const env: KeyEnvelope = {
      kind: 'key',
      moduleId: 'doom-abc',
      srcUserId: 'user-2',
      doomKey: 0x9d,  // KEY_RCTRL
      pressed: false,
      ts: 1700000001234,
    };
    const decoded = decodeKey(encodeKey(env));
    expect(decoded).toEqual(env);
  });

  it('clamps doomKey to 0..255 even if a buggy caller passes a bigger int', () => {
    const env = encodeKey({
      kind: 'key',
      moduleId: 'x', srcUserId: 'y', doomKey: 0x1ff, pressed: true, ts: 0,
    });
    expect(env.doomKey).toBe(0xff);
  });

  it('returns null on malformed payloads', () => {
    expect(decodeKey(null)).toBeNull();
    expect(decodeKey({})).toBeNull();
    expect(decodeKey({ kind: 'frame' })).toBeNull();
    expect(decodeKey({ kind: 'key', moduleId: 1 })).toBeNull();
    expect(decodeKey({ kind: 'key', moduleId: 'x', srcUserId: 'y', doomKey: 'not a number', pressed: true, ts: 0 })).toBeNull();
    expect(decodeKey({ kind: 'key', moduleId: 'x', srcUserId: 'y', doomKey: 0, pressed: 'truthy', ts: 0 })).toBeNull();
  });
});

describe('collectIncomingKeyPushes — edge-triggered host relay (phantom-input regression)', () => {
  const MODULE = 'doom-1';
  const HOST_CLIENT = 1;
  const HOST_USER = 'aaa-host';
  const SPEC_CLIENT = 2;
  const SPEC_USER = 'bbb-spec';

  function specStateWithKey(env: KeyEnvelope | null): Map<number, Record<string, unknown>> {
    return new Map<number, Record<string, unknown>>([
      [HOST_CLIENT, { user: { id: HOST_USER }, [`doom:${MODULE}:frame`]: { ts: 999 } }],
      [SPEC_CLIENT, { user: { id: SPEC_USER }, [`doom:${MODULE}:key`]: env }],
    ]);
  }

  function key(doomKey: number, pressed: boolean, ts: number): KeyEnvelope {
    return encodeKey({ kind: 'key', moduleId: MODULE, srcUserId: SPEC_USER, doomKey, pressed, ts });
  }

  function collect(states: Map<number, Record<string, unknown>>, cursor: RelayCursor) {
    return collectIncomingKeyPushes({
      states, moduleId: MODULE, selfClientId: HOST_CLIENT, selfUserId: HOST_USER, cursor,
    });
  }

  it('relays a remote key envelope exactly once, NOT on every awareness update', () => {
    const cursor: RelayCursor = new Map();
    // DOWNARROW keydown from the spectator (ts=100).
    const down = key(0xaf, true, 100);
    const states = specStateWithKey(down);

    // First observation: push the keydown.
    expect(collect(states, cursor)).toEqual([{ doomKey: 0xaf, pressed: true }]);

    // The host's 10 Hz frame broadcast (and any other awareness churn) fires
    // many more 'update' events while the SAME key field is still present.
    // The pre-fix code re-pushed DOWNARROW each time → continuous backward
    // drift. Edge-triggering must yield ZERO further pushes.
    for (let i = 0; i < 20; i++) {
      expect(collect(states, cursor)).toEqual([]);
    }
  });

  it('relays a strictly-newer envelope (keyup) once, then stays quiet', () => {
    const cursor: RelayCursor = new Map();
    expect(collect(specStateWithKey(key(0xaf, true, 100)), cursor))
      .toEqual([{ doomKey: 0xaf, pressed: true }]);
    // keyup arrives with a newer ts.
    expect(collect(specStateWithKey(key(0xaf, false, 200)), cursor))
      .toEqual([{ doomKey: 0xaf, pressed: false }]);
    // Re-observing the keyup envelope (sticky field) does nothing.
    expect(collect(specStateWithKey(key(0xaf, false, 200)), cursor)).toEqual([]);
  });

  it('ignores a cleared (null) key field', () => {
    const cursor: RelayCursor = new Map();
    expect(collect(specStateWithKey(null), cursor)).toEqual([]);
  });

  it('never relays the host its own client / own-authored envelopes', () => {
    const cursor: RelayCursor = new Map();
    // Host client carries a key field authored by the host itself.
    const states = new Map<number, Record<string, unknown>>([
      [HOST_CLIENT, {
        user: { id: HOST_USER },
        [`doom:${MODULE}:key`]: encodeKey({ kind: 'key', moduleId: MODULE, srcUserId: HOST_USER, doomKey: 0xaf, pressed: true, ts: 100 }),
      }],
    ]);
    expect(collect(states, cursor)).toEqual([]);
  });

  it('ignores envelopes for a different module id', () => {
    const cursor: RelayCursor = new Map();
    const states = new Map<number, Record<string, unknown>>([
      [SPEC_CLIENT, {
        user: { id: SPEC_USER },
        [`doom:${MODULE}:key`]: encodeKey({ kind: 'key', moduleId: 'OTHER', srcUserId: SPEC_USER, doomKey: 0xaf, pressed: true, ts: 100 }),
      }],
    ]);
    // The field key resolves but the decoded moduleId mismatches → skipped.
    expect(collect(states, cursor)).toEqual([]);
  });
});

describe('encodeFrame / decodeFrame — framebuffer envelope round-trip', () => {
  it('round-trips a small synthetic frame', () => {
    const width = 4;
    const height = 2;
    const buf = new Uint8Array(width * height * 4);
    for (let i = 0; i < buf.length; i++) buf[i] = (i * 7 + 13) & 0xff;
    const env = encodeFrame({
      moduleId: 'doom-x', hostUserId: 'host-1',
      width, height, framebuffer: buf, ts: 1234,
    });
    expect(env.kind).toBe('frame');
    expect(env.width).toBe(width);
    expect(env.height).toBe(height);
    const decoded = decodeFrame(env);
    expect(decoded).toEqual(env);
    const back = decodeFrameBuffer(decoded!);
    expect(back).toEqual(buf);
  });

  it('throws when framebuffer length disagrees with declared dims', () => {
    expect(() => encodeFrame({
      moduleId: 'm', hostUserId: 'h', width: 10, height: 10,
      framebuffer: new Uint8Array(7), ts: 0,
    })).toThrow();
  });

  it('returns null on malformed payloads', () => {
    expect(decodeFrame(null)).toBeNull();
    expect(decodeFrame({})).toBeNull();
    expect(decodeFrame({ kind: 'key' })).toBeNull();
    expect(decodeFrame({ kind: 'frame', moduleId: 1, hostUserId: 'h', width: 1, height: 1, framebufferB64: '', ts: 0 })).toBeNull();
  });

  it('round-trips a more realistic 64x32 framebuffer (chunked b64 path)', () => {
    const width = 64, height = 32;
    const buf = new Uint8Array(width * height * 4);
    // Fill with a deterministic pattern that exercises every byte value.
    for (let i = 0; i < buf.length; i++) buf[i] = i & 0xff;
    const env = encodeFrame({
      moduleId: 'd', hostUserId: 'h', width, height, framebuffer: buf, ts: 0,
    });
    const back = decodeFrameBuffer(decodeFrame(env)!);
    expect(back).toEqual(buf);
  });
});

describe('pickHost — deterministic host migration', () => {
  it('returns null when no members are in the rack', () => {
    expect(pickHost(null, [])).toBeNull();
    expect(pickHost('user-1', [])).toBeNull();
  });

  it('keeps the current host when they are still present', () => {
    expect(pickHost('user-bbb', ['user-aaa', 'user-bbb', 'user-ccc'])).toBe('user-bbb');
  });

  it('elects the lex-smallest member when there is no current host', () => {
    expect(pickHost(null, ['user-bbb', 'user-aaa', 'user-ccc'])).toBe('user-aaa');
  });

  it('elects a new host when the current one is gone', () => {
    expect(pickHost('user-aaa', ['user-bbb', 'user-ccc'])).toBe('user-bbb');
  });

  it('is deterministic across permutations of the member array', () => {
    const set = ['z-user', 'a-user', 'm-user'];
    expect(pickHost(null, set)).toBe('a-user');
    expect(pickHost(null, [...set].reverse())).toBe('a-user');
    expect(pickHost(null, ['m-user', 'z-user', 'a-user'])).toBe('a-user');
  });
});
