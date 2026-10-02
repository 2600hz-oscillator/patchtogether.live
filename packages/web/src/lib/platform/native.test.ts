// native.test.ts
//
// The one seam that tells the web app it is inside the native shell.
//
// ⚠ IT MUST FAIL CLOSED. Every consumer treats `true` as "hand display
// placement to the shell and migrate the patch's copy out of the document" — an
// irreversible-ish answer to give on a guess. A partial `window` stub, a bridge
// mid-injection, or a getter that throws must all read `false` and leave the
// browser behaviour exactly as it was.

import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  nativeAvailable,
  nativeShellVersion,
  setNativeAvailableForTests,
  exitNative,
  subscribeNativeLoadPatch,
} from './native';

const host = globalThis as unknown as { ptNative?: unknown };

afterEach(() => {
  delete host.ptNative;
  setNativeAvailableForTests(null);
});

describe('desktop Exit', () => {
  it('uses the existing command bridge', async () => {
    const command = vi.fn().mockResolvedValue({ ok: true, result: {} });
    host.ptNative = { nativeAvailable: () => true, command };
    await exitNative();
    expect(command).toHaveBeenCalledExactlyOnceWith('app.quit');
  });

  it('never issues a quit command in a browser', async () => {
    const command = vi.fn();
    host.ptNative = { nativeAvailable: () => false, command };
    await expect(exitNative()).rejects.toThrow('unavailable');
    expect(command).not.toHaveBeenCalled();
  });

  it('reports a refused command', async () => {
    host.ptNative = { nativeAvailable: () => true,
      command: async () => ({ ok: false, error: { message: 'only the main window may exit the app' } }) };
    await expect(exitNative()).rejects.toThrow('only the main window');
  });
});

describe('desktop File ▸ Load Patch…', () => {
  type Deliver = (request: unknown) => void;
  const PK = [0x50, 0x4b, 0x03, 0x04];

  /** A bridge whose load seam captures the renderer's listener. */
  function bridge(opts: { native?: boolean; reply?: unknown } = {}) {
    const seam = { deliver: null as Deliver | null };
    const off = vi.fn();
    const onLoadPatchRequested = vi.fn((cb: Deliver) => {
      seam.deliver = cb;
      return off;
    });
    const command = vi.fn().mockResolvedValue(opts.reply ?? { ok: true, result: {} });
    host.ptNative = { nativeAvailable: () => opts.native ?? true, command, onLoadPatchRequested };
    return { seam, off, command, onLoadPatchRequested };
  }

  it('hands the shell-read bytes to the loader as a File of the same name', async () => {
    const b = bridge();
    const onFile = vi.fn();
    const onError = vi.fn();
    const unsubscribe = subscribeNativeLoadPatch({ onFile, onError });
    // The shell enables the menu item on exactly this announcement.
    expect(b.command).toHaveBeenCalledExactlyOnceWith('patch.loader', { ready: true });
    b.seam.deliver!({ name: 'set-a.ptperf.zip', bytes: new Uint8Array(PK) });
    expect(onFile).toHaveBeenCalledOnce();
    const file = onFile.mock.calls[0]![0] as File;
    expect(file).toBeInstanceOf(File);
    expect(file.name).toBe('set-a.ptperf.zip');
    expect(Array.from(new Uint8Array(await file.arrayBuffer()))).toEqual(PK);
    expect(onError).not.toHaveBeenCalled();
    // Unsubscribing withdraws the loader so the item greys out again.
    unsubscribe();
    expect(b.off).toHaveBeenCalledOnce();
    expect(b.command).toHaveBeenLastCalledWith('patch.loader', { ready: false });
  });

  it('reports a read error from the shell where a bad load is reported', () => {
    const b = bridge();
    const onFile = vi.fn();
    const onError = vi.fn();
    subscribeNativeLoadPatch({ onFile, onError });
    b.seam.deliver!({ name: 'gone.ptperf.zip', error: 'ENOENT: no such file' });
    expect(onFile).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledExactlyOnceWith('gone.ptperf.zip: ENOENT: no such file');
  });

  it('a request this build cannot read is an error, never a silent drop', () => {
    const b = bridge();
    const onFile = vi.fn();
    const onError = vi.fn();
    subscribeNativeLoadPatch({ onFile, onError });
    for (const bad of [null, 'set.ptperf.zip', { name: 'x.ptperf.zip' }, { name: 'x.ptperf.zip', bytes: 'PK' }]) {
      b.seam.deliver!(bad);
    }
    expect(onFile).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledTimes(4);
    expect(onError.mock.calls[3]![0]).toMatch(/x\.ptperf\.zip: .*cannot read/);
  });

  it('registers nothing in a browser', () => {
    const b = bridge({ native: false });
    const onFile = vi.fn();
    const unsubscribe = subscribeNativeLoadPatch({ onFile, onError: vi.fn() });
    expect(b.onLoadPatchRequested).not.toHaveBeenCalled();
    expect(b.command).not.toHaveBeenCalled();
    expect(() => unsubscribe()).not.toThrow();
    expect(onFile).not.toHaveBeenCalled();
  });

  it('registers nothing on a shell without the load seam', () => {
    const command = vi.fn();
    host.ptNative = { nativeAvailable: () => true, command };
    subscribeNativeLoadPatch({ onFile: vi.fn(), onError: vi.fn() });
    expect(command).not.toHaveBeenCalled();
  });

  it('a loader the shell refuses is said out loud', async () => {
    bridge({ reply: { ok: false, error: { message: 'only the main window may own the patch loader' } } });
    const onError = vi.fn();
    subscribeNativeLoadPatch({ onFile: vi.fn(), onError });
    await vi.waitFor(() => expect(onError).toHaveBeenCalledOnce());
    expect(onError.mock.calls[0]![0]).toMatch(/Load Patch.*unavailable.*only the main window/);
  });
});

describe('nativeAvailable', () => {
  it('is false in a plain browser', () => {
    expect(nativeAvailable()).toBe(false);
    expect(nativeShellVersion()).toBeNull();
  });

  it('is true only when the bridge SAYS true', () => {
    host.ptNative = { nativeAvailable: () => true, shellVersion: () => '0.1.0' };
    expect(nativeAvailable()).toBe(true);
    expect(nativeShellVersion()).toBe('0.1.0');
  });

  it('a bridge that reports false is false', () => {
    host.ptNative = { nativeAvailable: () => false };
    expect(nativeAvailable()).toBe(false);
  });

  it('fails closed on every malformed bridge', () => {
    // A truthy `ptNative` is NOT the question — a half-injected preload, a
    // browser extension squatting the name, or a future bridge that drops the
    // method must all read as "not native" rather than as "take over display
    // placement".
    for (const bad of [null, undefined, {}, { nativeAvailable: true }, 'yes', 42]) {
      host.ptNative = bad;
      expect(nativeAvailable(), `ptNative = ${JSON.stringify(bad)}`).toBe(false);
    }
  });

  it('a bridge that THROWS is false, not an exception', () => {
    host.ptNative = {
      nativeAvailable: () => {
        throw new Error('IPC gone');
      },
      shellVersion: () => {
        throw new Error('IPC gone');
      },
    };
    expect(nativeAvailable()).toBe(false);
    expect(nativeShellVersion()).toBeNull();
  });

  it('a non-boolean truthy answer is still false (=== true, never coerced)', () => {
    host.ptNative = { nativeAvailable: () => 1 as unknown as boolean };
    expect(nativeAvailable()).toBe(false);
  });

  it('the test override wins, and null hands control back to the probe', () => {
    setNativeAvailableForTests(true);
    expect(nativeAvailable()).toBe(true);
    setNativeAvailableForTests(false);
    host.ptNative = { nativeAvailable: () => true };
    expect(nativeAvailable(), 'the override outranks a real bridge').toBe(false);
    setNativeAvailableForTests(null);
    expect(nativeAvailable()).toBe(true);
  });
});
