import { describe, it, expect, vi } from 'vitest';
import {
  RigBindingStore,
  emptyRigBindings,
  normalizeRigBindings,
  localStorageBackend,
  bridgeBackend,
  type RigBindings,
  type RigStoreBackend,
} from './device-slot-bindings';

const SCREEN = {
  label: 'DELL U2720Q',
  isInternal: false,
  width: 3840,
  height: 2160,
  dpr: 2,
  left: 1920,
  top: 0,
};

/** In-memory backend for store tests; records saves and can push externals. */
function memBackend(initial: RigBindings = emptyRigBindings()): RigStoreBackend & {
  saved: RigBindings[];
  pushExternal: (b: RigBindings) => void;
} {
  let listener: ((b: RigBindings) => void) | null = null;
  const saved: RigBindings[] = [];
  return {
    load: () => initial,
    save: (b) => {
      saved.push(b);
    },
    subscribe: (cb) => {
      listener = cb;
      return () => {
        listener = null;
      };
    },
    saved,
    pushExternal: (b) => listener?.(b),
  };
}

describe('normalizeRigBindings', () => {
  it('coerces a well-formed record and drops junk', () => {
    const out = normalizeRigBindings({
      cameras: { cam1: { deviceId: 'd1', deviceLabel: 'FaceTime' }, camX: { deviceId: 'x' } },
      outputs: { output2: { screen: SCREEN }, output9: { screen: SCREEN } },
      audioOut: { outputDeviceId: 'sink-7' },
      launchpad: { deviceId: 'lp', mode: 'out-to-launch' },
      push: { deviceId: 'push2' },
      ptz: { deviceId: 'ptz1' },
      gamepad: { id: 'Xbox Wireless Controller', index: 0 },
      es9: { pushPolicy: 'always' },
      bogus: 42,
    });
    expect(out.cameras.cam1).toEqual({ deviceId: 'd1', deviceLabel: 'FaceTime' });
    expect((out.cameras as Record<string, unknown>).camX).toBeUndefined(); // not a real slot
    expect(out.outputs.output2?.screen.label).toBe('DELL U2720Q');
    expect((out.outputs as Record<string, unknown>).output9).toBeUndefined();
    expect(out.audioOut?.outputDeviceId).toBe('sink-7');
    expect(out.launchpad).toEqual({ deviceId: 'lp', mode: 'out-to-launch' });
    expect(out.push?.deviceId).toBe('push2');
    expect(out.ptz?.deviceId).toBe('ptz1');
    expect(out.gamepad).toEqual({ id: 'Xbox Wireless Controller', index: 0 });
    expect(out.es9?.pushPolicy).toBe('always');
  });

  it('keeps a gamepad id without an index and drops one with no id', () => {
    expect(normalizeRigBindings({ gamepad: { id: 'Pro Controller' } }).gamepad).toEqual({
      id: 'Pro Controller',
    });
    // A non-string index is dropped (mirrors ptz's string-guard discipline).
    expect(normalizeRigBindings({ gamepad: { id: 'pad', index: 'nope' } }).gamepad).toEqual({
      id: 'pad',
    });
    expect(normalizeRigBindings({ gamepad: { index: 2 } }).gamepad).toBeUndefined();
  });

  it('defaults a bad launchpad mode to tetris and returns empty for garbage', () => {
    expect(normalizeRigBindings({ launchpad: { deviceId: 'lp', mode: 'nope' } }).launchpad).toEqual({
      deviceId: 'lp',
      mode: 'tetris',
    });
    expect(normalizeRigBindings(null)).toEqual(emptyRigBindings());
    expect(normalizeRigBindings('x')).toEqual(emptyRigBindings());
    expect(normalizeRigBindings({ outputs: { output2: { screen: { label: 'x' } } } }).outputs.output2).toBeUndefined();
  });
});

describe('RigBindingStore', () => {
  it('serves synchronous reads and persists on mutation', async () => {
    const backend = memBackend();
    const store = new RigBindingStore(backend);
    await store.whenReady();

    expect(store.getCamera('cam1')).toBeNull();
    store.setCamera('cam1', { deviceId: 'd1', deviceLabel: 'FaceTime' });
    expect(store.getCamera('cam1')).toEqual({ deviceId: 'd1', deviceLabel: 'FaceTime' });
    expect(backend.saved.at(-1)?.cameras.cam1?.deviceId).toBe('d1');

    store.setOutput('output2', { screen: SCREEN });
    expect(store.getOutput('output2')?.screen.width).toBe(3840);

    store.setCamera('cam1', null);
    expect(store.getCamera('cam1')).toBeNull();

    // Gamepad singleton — same get/set/clear + persist path as ptz.
    expect(store.getGamepad()).toBeNull();
    store.setGamepad({ id: 'Xbox Wireless Controller', index: 1 });
    expect(store.getGamepad()).toEqual({ id: 'Xbox Wireless Controller', index: 1 });
    expect(backend.saved.at(-1)?.gamepad?.id).toBe('Xbox Wireless Controller');
    store.setGamepad(null);
    expect(store.getGamepad()).toBeNull();
    store.dispose();
  });

  it('notifies subscribers on local and external change', async () => {
    const backend = memBackend();
    const store = new RigBindingStore(backend);
    await store.whenReady();
    const cb = vi.fn();
    const off = store.subscribe(cb);

    store.setAudioOut({ outputDeviceId: 'sink-1' });
    expect(cb).toHaveBeenCalledTimes(1);

    // an external change (another shell window / tab) updates the cache + fires
    backend.pushExternal({ cameras: { cam3: { deviceId: 'd3' } }, outputs: {} });
    expect(store.getCamera('cam3')?.deviceId).toBe('d3');
    expect(cb).toHaveBeenCalledTimes(2);

    off();
    store.setPtz({ deviceId: 'p' });
    expect(cb).toHaveBeenCalledTimes(2); // unsubscribed
    store.dispose();
  });

  it('hydrates from a backend that loads async', async () => {
    const backend: RigStoreBackend = {
      load: () => Promise.resolve({ cameras: { cam1: { deviceId: 'late' } }, outputs: {} }),
      save: () => {},
      subscribe: () => () => {},
    };
    const store = new RigBindingStore(backend);
    expect(store.getCamera('cam1')).toBeNull(); // not yet hydrated
    await store.whenReady();
    expect(store.getCamera('cam1')?.deviceId).toBe('late');
    store.dispose();
  });
});

describe('localStorageBackend', () => {
  it('round-trips through a stubbed localStorage', async () => {
    const mem = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => mem.get(k) ?? null,
      setItem: (k: string, v: string) => void mem.set(k, v),
    });
    const be = localStorageBackend();
    be.save({ cameras: { cam1: { deviceId: 'z' } }, outputs: {} });
    expect((await be.load()).cameras.cam1?.deviceId).toBe('z');
    vi.unstubAllGlobals();
  });

  it('never throws when localStorage throws (private mode)', async () => {
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('denied');
      },
    });
    const be = localStorageBackend();
    expect(() => be.save(emptyRigBindings())).not.toThrow();
    expect(await be.load()).toEqual(emptyRigBindings());
    vi.unstubAllGlobals();
  });
});

describe('bridgeBackend', () => {
  it('unwraps the ok/result envelope and normalizes it', async () => {
    const command = vi.fn(async (op: string) =>
      op === 'bindings.get'
        ? { ok: true, result: { cameras: { cam2: { deviceId: 'b2' } }, outputs: {} } }
        : { ok: true },
    );
    const be = bridgeBackend({ command, onEvent: () => () => {} });
    expect((await be.load()).cameras.cam2?.deviceId).toBe('b2');
    await be.save({ cameras: {}, outputs: {} });
    expect(command).toHaveBeenCalledWith('bindings.set', { cameras: {}, outputs: {} });
  });

  it('returns empty on a failed envelope', async () => {
    const be = bridgeBackend({ command: async () => ({ ok: false }), onEvent: () => () => {} });
    expect(await be.load()).toEqual(emptyRigBindings());
  });
});
