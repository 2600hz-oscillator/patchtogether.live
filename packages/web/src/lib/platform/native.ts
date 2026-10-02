// platform/native.ts
//
// "Are we running inside the native shell?" — the web app's ONE answer.
//
// The desktop shell loads this same `packages/web` build unmodified and exposes
// a single context-bridge global (`window.ptNative`, apps/desktop/src/preload.ts).
// The web app must never import Electron; this module is the whole seam, and it
// contains the defensive capability probe and native command helpers.
//
// The capability selects display ownership and exposes desktop File → Exit.
// In the browser the patch owns display placement — projector bindings ride the shared Y.Doc and
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
  command?: (op: string, payload?: unknown) => Promise<{ ok: boolean; error?: { message?: string } }>;
  /** Desktop File ▸ Load Patch…: `{ name, bytes }` for a pick main could
   *  read, `{ name, error }` for one it could not. Returns an unsubscribe. */
  onLoadPatchRequested?: (cb: (request: unknown) => void) => () => void;
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

/** Desktop File ▸ Exit; ordinary browsers never receive a quit affordance. */
export async function exitNative(): Promise<void> {
  const bridge = (globalThis as unknown as NativeHost).ptNative;
  if (!nativeAvailable() || typeof bridge?.command !== 'function') {
    throw new Error('Desktop Exit is unavailable in this browser.');
  }
  const reply = await bridge.command('app.quit');
  if (!reply.ok) throw new Error(reply.error?.message ?? 'Could not exit desktop mode.');
}

export interface NativeLoadPatchHandlers {
  /** The picked file, named as it is on disk, for the SAME loader the topbar's
   *  File ▸ Load hands its picked file to. */
  onFile: (file: File) => void;
  /** The shell could not read the pick, refused the loader, or sent a request
   *  this build cannot read. Shown where a bad topbar load is shown. */
  onError: (message: string) => void;
}

/**
 * Desktop File ▸ Load Patch… (⌘O / Ctrl+O).
 *
 * The shell runs the picker AND reads the file — the sandboxed renderer can
 * never name a path — then pushes the bytes over the event envelope. This
 * turns them into a `File` for the ordinary performance loader and tells the
 * shell a loader is listening (`patch.loader`), which is exactly when the menu
 * item is enabled; the returned unsubscribe tells it the loader is gone. A
 * browser, or a bridge without the seam, registers nothing and gets a no-op.
 */
export function subscribeNativeLoadPatch(handlers: NativeLoadPatchHandlers): () => void {
  const bridge = (globalThis as unknown as NativeHost).ptNative;
  if (
    !nativeAvailable() ||
    typeof bridge?.onLoadPatchRequested !== 'function' ||
    typeof bridge.command !== 'function'
  ) {
    return () => {};
  }
  const command = bridge.command;
  const off = bridge.onLoadPatchRequested((raw) => {
    const req = (typeof raw === 'object' && raw !== null ? raw : {}) as {
      name?: unknown;
      bytes?: unknown;
      error?: unknown;
    };
    const name = typeof req.name === 'string' && req.name !== '' ? req.name : 'patch.ptperf.zip';
    if (typeof req.error === 'string') {
      handlers.onError(`${name}: ${req.error}`);
      return;
    }
    const bytes = req.bytes;
    if (bytes instanceof Uint8Array || bytes instanceof ArrayBuffer) {
      handlers.onFile(new File([bytes as BlobPart], name, { type: 'application/zip' }));
      return;
    }
    handlers.onError(`${name}: the shell sent a load request this build cannot read`);
  });
  const announce = (ready: boolean): void => {
    command('patch.loader', { ready })
      .then((reply) => {
        if (ready && !reply.ok) {
          handlers.onError(
            `File ▸ Load Patch… is unavailable: ${reply.error?.message ?? 'the shell refused the loader'}`,
          );
        }
      })
      .catch((err: unknown) => {
        if (ready) {
          handlers.onError(`File ▸ Load Patch… is unavailable: ${err instanceof Error ? err.message : String(err)}`);
        }
      });
  };
  announce(true);
  return () => {
    off();
    announce(false);
  };
}

/** Force the answer (tests only). Pass `null` to go back to probing. */
export function setNativeAvailableForTests(value: boolean | null): void {
  forced = value;
}
