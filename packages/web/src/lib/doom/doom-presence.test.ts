// packages/web/src/lib/doom/doom-presence.test.ts
//
// Pure-function coverage for the Yjs-awareness encode/decode pair +
// the host-migration tie-break. Doesn't spin up an actual Yjs provider —
// that's covered by the multi-tab Playwright spec.

import { describe, it, expect } from 'vitest';
import * as presence from './doom-presence';
import {
  encodeKey,
  decodeKey,
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
      [HOST_CLIENT, { user: { id: HOST_USER } }],
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

    // Host election / cursor / presence churn fires many more 'update' events
    // while the SAME key field is still present. The pre-fix code re-pushed
    // DOWNARROW each time → continuous backward drift. Edge-triggering must
    // yield ZERO further pushes.
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

describe('relay-OOM regression: DOOM never broadcasts a large awareness payload', () => {
  // The host used to base64 its ~1.4 MB BGRA framebuffer into a 'frame'
  // awareness envelope at ~10 Hz so unjoined spectators could mirror the host's
  // screen. That firehose OOM-killed the in-process Hocuspocus relay (exit 137),
  // wiping shared state. The whole framebuffer-over-awareness path was removed:
  // these assertions are the guard that it stays gone.

  it('exposes NO framebuffer encode/decode helpers', () => {
    // The presence module's public surface must not carry any frame helper.
    expect((presence as Record<string, unknown>).encodeFrame).toBeUndefined();
    expect((presence as Record<string, unknown>).decodeFrame).toBeUndefined();
    expect((presence as Record<string, unknown>).decodeFrameBuffer).toBeUndefined();
  });

  it('the only awareness envelope DOOM encodes is a small, bounded key envelope', () => {
    // A key envelope is a handful of scalars — serialized it is tiny (well under
    // 1 KB), never the multi-KB/MB payload a framebuffer mirror was.
    const env = encodeKey({
      kind: 'key',
      moduleId: 'doom-abc',
      srcUserId: 'user-1',
      doomKey: 0xaf,
      pressed: true,
      ts: 1700000000000,
    });
    const serialized = JSON.stringify(env);
    expect(serialized.length).toBeLessThan(512);
    // No framebuffer-bearing field rides on it.
    const fields = env as unknown as Record<string, unknown>;
    expect(fields).not.toHaveProperty('framebufferB64');
    expect(fields).not.toHaveProperty('framebuffer');
    expect(fields.kind).toBe('key');
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

  // ── owner-aware election (the guest-as-host fix) ──────────────────────────
  it('elects the rack OWNER even when their id is NOT lex-smallest', () => {
    // owner sorts LEX-LARGE; a guest sorts lex-small. Pre-fix lex-min picked
    // the guest as host (the "guest seated as P1" bug).
    expect(pickHost(null, ['aaa-guest', 'zzz-owner'], ['zzz-owner'])).toBe('zzz-owner');
  });

  it('reclaims host for the owner even if a guest is the current host', () => {
    // A guest temporarily held the host seat (e.g. joined first); the owner
    // arriving must take it back.
    expect(pickHost('aaa-guest', ['aaa-guest', 'zzz-owner'], ['zzz-owner'])).toBe('zzz-owner');
  });

  it('falls back to lex-min when the owner is absent', () => {
    expect(pickHost(null, ['aaa-guest', 'mmm-guest'], ['zzz-owner'])).toBe('aaa-guest');
  });

  it('keeps the current host when no owner is present (no churn)', () => {
    expect(pickHost('mmm-guest', ['aaa-guest', 'mmm-guest'], [])).toBe('mmm-guest');
  });

  it('picks the lex-smallest owner when more than one claims ownership', () => {
    expect(pickHost(null, ['o-zzz', 'o-aaa', 'guest'], ['o-zzz', 'o-aaa'])).toBe('o-aaa');
  });
});
