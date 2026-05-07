// packages/web/src/lib/audio/audio-gate.svelte.ts
//
// Audio gate state — Svelte 5 rune store that tracks whether the canvas's
// AudioContext is currently `running`, plus a one-shot `resume()` that
// boots the engine on first user gesture and resumes a suspended context
// thereafter.
//
// Why this exists: Chrome's autoplay policy refuses to start an AudioContext
// without a user gesture, so a fresh page load (cold mount, or an F5 mid-
// session) lands with no AudioContext at all — `Canvas.svelte`'s
// `ensureEngine` is gated behind explicit clicks (Add module, Load example,
// Load), which means a user reloading a rack with state already in the Yjs
// doc sees the modules but hears nothing.
//
// `AudioGate.svelte` renders an overlay that consumes this store's
// `running` flag; on click it calls `resume()` which (a) calls the
// caller-provided boot function (typically `ensureEngine()` from
// Canvas.svelte) and (b) resumes the AudioContext if suspended.

type EngineBooter = () => Promise<{ ctx: AudioContext } | { audioCtx: AudioContext } | AudioContext | unknown>;

/** Internal: derive the AudioContext from whatever shape the booter returned. */
function extractCtx(result: unknown): AudioContext | null {
  if (!result || typeof result !== 'object') return null;
  const r = result as Record<string, unknown>;
  if (r.ctx instanceof AudioContext) return r.ctx;
  if (r.audioCtx instanceof AudioContext) return r.audioCtx;
  if (result instanceof AudioContext) return result;
  return null;
}

/**
 * Create a per-rack audio-gate store.
 *
 * The caller wires `bind()` to the live AudioContext once `ensureEngine`
 * has resolved; the gate then watches `state` to keep `running` in sync
 * with browser-side suspends (e.g., tab backgrounding suspends the ctx
 * on some platforms).
 */
export interface AudioGate {
  /** True iff there is an AudioContext AND its state === 'running'. */
  readonly running: boolean;
  /** True while a resume()/boot is in flight (button disabled state). */
  readonly busy: boolean;
  /** Last error from resume(), if any. Cleared on next resume() attempt. */
  readonly error: string | null;
  /**
   * Call from a user-gesture handler (click). Boots the engine via the
   * registered booter if no AudioContext exists yet, then resumes it.
   * Idempotent — repeated calls while running are no-ops.
   */
  resume(): Promise<void>;
  /**
   * Wire the live AudioContext so the gate can react to its state changes.
   * Called by Canvas.svelte once `ensureEngine` resolves. Pass null to
   * detach (e.g., on engine.dispose).
   */
  bind(ctx: AudioContext | null): void;
  /**
   * Register the boot function the gate calls on first resume. Typically
   * `ensureEngine` from Canvas.svelte. Setting it twice replaces the
   * previous; passing null clears it.
   */
  setBooter(booter: EngineBooter | null): void;
}

export function createAudioGate(): AudioGate {
  let running = $state(false);
  let busy = $state(false);
  let error = $state<string | null>(null);
  let ctx: AudioContext | null = null;
  let booter: EngineBooter | null = null;
  let stateListener: (() => void) | null = null;

  function detachListener() {
    if (ctx && stateListener) {
      try {
        ctx.removeEventListener('statechange', stateListener);
      } catch {
        // older Safari may not expose removeEventListener on AudioContext
      }
    }
    stateListener = null;
  }

  function attachListener(c: AudioContext) {
    detachListener();
    stateListener = () => {
      running = c.state === 'running';
    };
    try {
      c.addEventListener('statechange', stateListener);
    } catch {
      // older Safari fallback: poll once via microtask. Worst case, the
      // overlay reflects state lazily but click-to-resume still works.
    }
    running = c.state === 'running';
  }

  return {
    get running() { return running; },
    get busy() { return busy; },
    get error() { return error; },
    async resume() {
      if (busy) return;
      if (running) return;
      busy = true;
      error = null;
      try {
        if (!ctx && booter) {
          const result = await booter();
          const derived = extractCtx(result);
          if (derived) {
            ctx = derived;
            attachListener(derived);
          }
        }
        if (ctx) {
          // ctx.state is a string literal union ('running' | 'suspended' |
          // 'closed' | 'interrupted'); cast through string for the post-
          // resume comparison since TS narrows state away after `await
          // resume()` otherwise (it doesn't know resume mutates state).
          if ((ctx.state as string) !== 'running') {
            await ctx.resume();
          }
          running = (ctx.state as string) === 'running';
        }
      } catch (e) {
        error = e instanceof Error ? e.message : String(e);
      } finally {
        busy = false;
      }
    },
    bind(c: AudioContext | null) {
      detachListener();
      ctx = c;
      if (c) attachListener(c);
      else running = false;
    },
    setBooter(b: EngineBooter | null) {
      booter = b;
    },
  };
}

