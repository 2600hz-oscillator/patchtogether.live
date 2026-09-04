// platform/native.ts
//
// "Are we running inside the native shell?" — the web app's ONE answer.
//
// The desktop shell loads this same `packages/web` build unmodified and exposes
// a single context-bridge global (`window.ptNative`, apps/desktop/src/preload.ts).
// The web app must never import Electron; this module is the whole seam, and it
// is deliberately tiny: a boolean, probed defensively, with a test override.
//
// WHY THE WEB SIDE NEEDS TO KNOW AT ALL. Exactly one thing so far, and it is a
// correctness question, not a cosmetic one: WHO OWNS DISPLAY PLACEMENT. In the
// browser the patch owns it — projector bindings ride the shared Y.Doc and
// Canvas reopens them on load. In the shell the SHELL owns it — its display map
// is local, per-machine, and belongs to the operator's rig rather than to the
// document. Both being live at once means an old patch reopens legacy popups
// while the shell creates its own sinks, on the same monitors, with opposite
// lifetimes. See `presentAuthority` in $lib/ui/modules/present-bindings.
//
// ⚠ CAPABILITY PROBE, NOT AN OBJECT PROBE. The web package's vitest runs under
// `environment: 'node'` where sibling suites install partial `window` stubs on
// globalThis; `'ptNative' in window` and a bare property read behave differently
// across them, and a throw here would take an import chain down. Every access
// below is guarded and returns `false` on anything unexpected.

/** The slice of the preload bridge this module reads. Structural, so the web
 *  build never depends on the shell's types. */
interface NativeBridgeLike {
  nativeAvailable?: () => boolean;
  shellVersion?: () => string;
}

interface NativeHost {
  ptNative?: NativeBridgeLike;
}

/** Test override, so a unit test or an e2e can drive the native branch without
 *  an Electron process. `null` restores the real probe. */
let forced: boolean | null = null;

/** True when the page is running inside the native shell. */
export function nativeAvailable(): boolean {
  if (forced !== null) return forced;
  try {
    const host = globalThis as unknown as NativeHost;
    const bridge = host.ptNative;
    if (!bridge || typeof bridge.nativeAvailable !== 'function') return false;
    return bridge.nativeAvailable() === true;
  } catch {
    return false;
  }
}

/** The shell's version string, or null in a browser. Diagnostic only. */
export function nativeShellVersion(): string | null {
  try {
    const host = globalThis as unknown as NativeHost;
    const v = host.ptNative?.shellVersion?.();
    return typeof v === 'string' && v !== '' ? v : null;
  } catch {
    return null;
  }
}

/** Force the answer (tests only). Pass `null` to go back to probing. */
export function setNativeAvailableForTests(value: boolean | null): void {
  forced = value;
}
