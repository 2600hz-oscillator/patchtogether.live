// native.test.ts
//
// The one seam that tells the web app it is inside the native shell.
//
// ⚠ IT MUST FAIL CLOSED. Every consumer treats `true` as "hand display
// placement to the shell and migrate the patch's copy out of the document" — an
// irreversible-ish answer to give on a guess. A partial `window` stub, a bridge
// mid-injection, or a getter that throws must all read `false` and leave the
// browser behaviour exactly as it was.

import { describe, it, expect, afterEach } from 'vitest';
import { nativeAvailable, nativeShellVersion, setNativeAvailableForTests } from './native';

const host = globalThis as unknown as { ptNative?: unknown };

afterEach(() => {
  delete host.ptNative;
  setNativeAvailableForTests(null);
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
