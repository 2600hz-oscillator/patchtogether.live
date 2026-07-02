// packages/web/src/lib/ui/meter-frame.ts
//
// ONE shared requestAnimationFrame ticker for card "meter" repaints — the
// per-card scope / playhead / level-meter loops that read an AnalyserNode (or
// the engine) and repaint a canvas once per frame.
//
// WHY: each of ~60 module cards used to run its OWN requestAnimationFrame loop.
// On a busy patch that is ~60 independent rAF callbacks + layout/paint flushes
// every frame, all on the MAIN THREAD — enough sustained contention to starve
// the audio render thread and cause an output-buffer underrun (the audible
// "slowdown" a user hears even on an AUDIO-ONLY patch; see
// .myrobots/plans/audio-slowdown-forensics-2026-07-01.md, root cause C1/#2).
//
// Coalescing them into a single rAF that visits each subscriber once per frame
// collapses that to ONE callback + one paint flush, and lets us SKIP off-screen
// cards entirely (an IntersectionObserver gate): a card scrolled out of view
// stops reading its analyser and repainting. This is the render-side analogue
// of the audio thread's shared scheduler clock — one loop, many subscribers,
// gated by visibility.

export interface MeterFrameHandle {
  /** Stop this subscription. The shared rAF halts once the last one leaves. */
  stop(): void;
}

interface Sub {
  cb: (now: number) => void;
  el: Element | null;
  visible: boolean;
}

const subs = new Set<Sub>();
let rafId: number | null = null;
let io: IntersectionObserver | null = null;

function hasDom(): boolean {
  return typeof window !== 'undefined' && typeof requestAnimationFrame === 'function';
}

function documentHidden(): boolean {
  return typeof document !== 'undefined' && document.hidden === true;
}

function ensureObserver(): IntersectionObserver | null {
  if (io || typeof IntersectionObserver === 'undefined') return io;
  io = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        // n is small (only meter cards subscribe); a linear match keeps the
        // service correct even if two subscribers share one element.
        for (const s of subs) if (s.el === e.target) s.visible = e.isIntersecting;
      }
    },
    // A small margin so a card starts painting just before it scrolls in.
    { rootMargin: '100px' },
  );
  return io;
}

function frame(now: number) {
  // Snapshot: a cb may stop()/subscribe mid-iteration.
  const hidden = documentHidden();
  for (const s of [...subs]) {
    if (s.visible && !hidden) {
      try {
        s.cb(now);
      } catch {
        /* one card's paint error must not kill every other meter */
      }
    }
  }
  rafId = subs.size > 0 && hasDom() ? requestAnimationFrame(frame) : null;
}

/**
 * Subscribe a per-frame meter callback to the shared ticker. `el` is the
 * element whose on-screen visibility gates the callback (typically the card's
 * canvas): while `el` is off-screen the callback is skipped entirely. Pass
 * `null` for a cheap callback that has no repaint to gate (e.g. a sequencer
 * playhead that only updates a step index) — it still benefits from the single
 * coalesced rAF. Returns a handle whose `.stop()` unsubscribes — call it from
 * the card's teardown.
 *
 * SSR / no-rAF environments: the callback never fires and `.stop()` is a no-op.
 */
export function onMeterFrame(el: Element | null, cb: (now: number) => void): MeterFrameHandle {
  if (!hasDom()) return { stop() {} };
  const sub: Sub = { cb, el, visible: true };
  subs.add(sub);
  const obs = el ? ensureObserver() : null;
  if (el) obs?.observe(el);
  if (rafId === null) rafId = requestAnimationFrame(frame);
  return {
    stop() {
      subs.delete(sub);
      if (el) obs?.unobserve(el);
      if (subs.size === 0 && rafId !== null) {
        cancelAnimationFrame(rafId);
        rafId = null;
      }
    },
  };
}

/** Test hook: current subscriber count (0 when idle). */
export function __meterFrameSubscriberCount(): number {
  return subs.size;
}

/** Test hook: hard-reset shared state between tests. */
export function __resetMeterFrameForTests(): void {
  for (const s of [...subs]) subs.delete(s);
  if (rafId !== null && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(rafId);
  rafId = null;
  io?.disconnect();
  io = null;
}
