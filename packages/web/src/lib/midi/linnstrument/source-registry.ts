// LINNSTRUMENT SOURCE REGISTRY — the seam between the device layer and the
// module runtime, so the two can be built (and tested) independently.
//
//   device layer  →  setLinnstrumentSource(src)        publishes RuntimeEvents
//   runtime       →  subscribeLinnstrumentEvents(fn)   consumes them, with NO
//                                                      face mounted
//   runtime       →  publishLinnstrumentSelection(s)   ACKNOWLEDGED reducer
//                                                      state for the LED writer
//
// One app-wide source at a time (one physical LinnStrument, one User-Mode
// owner — design.md:168 "not a second simultaneous owner"). Replacing the
// source unsubscribes the old one and announces it as disconnected. A late
// subscriber receives the current session snapshot immediately, so a module
// that attaches after the device is bound never infers state from missed
// edges (design.md:221). Listener errors are isolated.
//
// ⚠ Plain `.ts`, no runes; module-level state like the trails singleton.

import type { LinnstrumentSource, RuntimeEvent, RuntimeEventListener, SelectionState, SessionEvent } from './types';

let source: LinnstrumentSource | null = null;
let unsubscribeSource: (() => void) | null = null;
let lastSession: SessionEvent = { kind: 'session', epoch: 0, state: 'disconnected', userMode: false, time: 0 };
const listeners = new Set<RuntimeEventListener>();

function fanOut(event: RuntimeEvent): void {
  if (event.kind === 'session') lastSession = event;
  for (const fn of [...listeners]) {
    try {
      fn(event);
    } catch (err) {
      console.error('[linnstrument] listener threw', err);
    }
  }
}

/** Install (or clear) the app-wide source. Idempotent for the same object. */
export function setLinnstrumentSource(next: LinnstrumentSource | null): void {
  if (next === source) return;
  if (unsubscribeSource) {
    unsubscribeSource();
    unsubscribeSource = null;
  }
  const prev = source;
  source = next;
  if (prev && !next) {
    fanOut({ kind: 'session', epoch: lastSession.epoch, state: 'disconnected', userMode: false, time: lastSession.time });
  }
  if (next) {
    unsubscribeSource = next.subscribe(fanOut);
    fanOut(next.snapshot());
  }
}

export function getLinnstrumentSource(): LinnstrumentSource | null {
  return source;
}

/** Subscribe to runtime events. The current session snapshot is delivered
 *  synchronously on subscribe. Returns the unsubscribe. */
export function subscribeLinnstrumentEvents(fn: RuntimeEventListener): () => void {
  listeners.add(fn);
  try {
    fn(source ? source.snapshot() : lastSession);
  } catch (err) {
    console.error('[linnstrument] listener threw', err);
  }
  return () => {
    listeners.delete(fn);
  };
}

/** Hand acknowledged reducer state to the source (LED painting). The source
 *  paints; it never decides. No-op without a source or when it cannot paint. */
export function publishLinnstrumentSelection(state: SelectionState): void {
  source?.onSelection?.(state);
}

export function linnstrumentSessionSnapshot(): SessionEvent {
  return source ? source.snapshot() : lastSession;
}

/** Test seam: drop the source and every listener. */
export function __resetLinnstrumentSourceForTest(): void {
  if (unsubscribeSource) unsubscribeSource();
  unsubscribeSource = null;
  source = null;
  listeners.clear();
  lastSession = { kind: 'session', epoch: 0, state: 'disconnected', userMode: false, time: 0 };
}
