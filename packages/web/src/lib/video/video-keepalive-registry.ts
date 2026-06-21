// packages/web/src/lib/video/video-keepalive-registry.ts
//
// Identity-guarded PERSISTENT per-element audio keep-alive registry for the
// multi-slot video source modules (VIDEOVARISPEED's 7-slot asset selector).
//
// WHY THIS EXISTS — the multi-slot freeze bug:
//
// `createMediaElementSource(el)` is PERMANENT + once-per-element: calling it a
// second time on the same <video> throws InvalidStateError. And a hidden,
// non-audio-pulled <video> decode-throttles to ~1 fps (see
// video-audio-keepalive.ts). VIDEOVARISPEED's pre-fix engine kept ONE shared
// keep-alive that was torn down + re-created on every slot switch — so after a
// single slot cycle every switched-away slot was frozen on frame 0, and a
// later re-select called createMediaElementSource a SECOND time on the same
// element → InvalidStateError → never recovered.
//
// TOYBOX already solved exactly this for its concurrent layers with an
// identity-guarded persistent per-element Map (toybox.ts:926-946:
// `videoKeepAlives` / `keepAliveEls`, idempotent `wireKeepAlive` with the
// `keepAliveEls.get(idx) === el` guard). This factors that pattern out so the
// invariant — `createMediaElementSource` runs AT MOST ONCE per element, and a
// keep-alive is NEVER torn down on a switch — is shared + unit-testable.
//
// The registry is element-keyed (the engine only ever sees <video> elements
// via attachExternalSource, not slot indices) and DOM-free at the type level:
// it takes a `create` factory so the audio plumbing (createVideoAudioKeepAlive)
// is injected, and a fake create can drive the identity invariant under vitest
// with no real AudioContext / <video>.

/** Minimal shape a keep-alive entry must satisfy so it can be torn down on
 *  dispose. Matches VideoAudioKeepAlive (which has more members the registry
 *  doesn't need to know about). */
export interface DisposableKeepAlive {
  disconnect(): void;
}

/**
 * A persistent, identity-guarded per-element keep-alive registry.
 *
 * `ensure(el)` wires a keep-alive for `el` exactly once. Re-calling it with the
 * SAME element is a no-op (returns the existing keep-alive) — so a slot switch
 * back to a previously-wired element NEVER re-runs `create` and therefore never
 * triggers the once-per-element `createMediaElementSource` throw. There is NO
 * per-element teardown on switch by design: keep-alives persist for every
 * loaded element until the whole module is disposed.
 */
export interface KeepAliveRegistry<K extends DisposableKeepAlive> {
  /** Wire (or reuse) the keep-alive for `el`. Idempotent per element. Returns
   *  the keep-alive, or null when `create` returned null (e.g. no AudioContext)
   *  or threw (e.g. the element already owns a MediaElementSource after HMR). */
  ensure(el: HTMLVideoElement): K | null;
  /** True if `el` currently has a live keep-alive in the registry. */
  has(el: HTMLVideoElement): boolean;
  /** How many distinct elements have a live keep-alive (test/inspection). */
  size(): number;
  /** Disconnect + drop EVERY keep-alive (module dispose only). Idempotent. */
  disposeAll(): void;
}

/**
 * Build a {@link KeepAliveRegistry}.
 *
 * @param create  Factory that builds the keep-alive for an element. The real
 *   caller passes `(el) => createVideoAudioKeepAlive(audioCtx, el)`; tests pass
 *   a fake that counts invocations. May return null (no AudioContext) or throw
 *   (createMediaElementSource on an already-attached element) — both leave the
 *   element UNWIRED so a later `ensure` can retry it.
 */
export function createKeepAliveRegistry<K extends DisposableKeepAlive>(
  create: (el: HTMLVideoElement) => K | null,
): KeepAliveRegistry<K> {
  // WeakMap so a torn-down (GC'd) element doesn't pin a keep-alive; the parallel
  // Set tracks membership for size()/disposeAll without retaining identity if
  // the element is collected.
  const byEl = new WeakMap<HTMLVideoElement, K>();
  const live = new Set<HTMLVideoElement>();

  return {
    ensure(el: HTMLVideoElement): K | null {
      // IDENTITY GUARD: same element already wired → reuse, never re-create.
      const existing = byEl.get(el);
      if (existing) return existing;
      let ka: K | null = null;
      try {
        ka = create(el);
      } catch {
        // createMediaElementSource can throw (element already owns a source
        // after HMR). The decode-throttle defeat is best-effort; leave it
        // unwired so a later ensure() can retry.
        return null;
      }
      if (!ka) return null;
      byEl.set(el, ka);
      live.add(el);
      return ka;
    },
    has(el: HTMLVideoElement): boolean {
      return byEl.has(el);
    },
    size(): number {
      return live.size;
    },
    disposeAll(): void {
      for (const el of live) {
        const ka = byEl.get(el);
        if (ka) { try { ka.disconnect(); } catch { /* */ } byEl.delete(el); }
      }
      live.clear();
    },
  };
}
