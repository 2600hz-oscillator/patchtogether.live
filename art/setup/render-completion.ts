// art/setup/render-completion.ts
//
// ⚠ `OfflineAudioContext.startRendering()` IN THE PINNED BINDING CAN RESOLVE TO
// `null`, WITH NO ERROR, ON A GRAPH THAT RENDERED PERFECTLY.
//
// This file is the guard for that, installed on the prototype from
// art/vitest.config.ts `setupFiles` so every render path in this workspace is
// covered — `setup/offline.ts` and the ~40 scenario-local `startRendering()`
// call sites alike — without a list to keep in step.
//
// ---------------------------------------------------------------------------
// THE DEFECT, IN THE BINDING'S OWN WORDS
// ---------------------------------------------------------------------------
//
// node-web-audio-api 1.0.9 hands the rendered buffer to JS on a path that is
// SEPARATE from the promise it returns, and nothing orders the two:
//
//   · `src/offline_audio_context.rs` `start_rendering()` creates a threadsafe
//     function for the `complete` event, then calls `env.execute_tokio_future`
//     for the render. The TSFN callback carries the AudioBuffer; the tokio
//     future carries the promise resolution. Two independent deliveries to the
//     JS thread, drained by libuv in handle order, not in signal order. The
//     Rust source says so out loud:
//
//         // This event is propagated before `startRendering` fulfills
//         // which is wrong, order is fixed on JS side.
//
//   · `js/OfflineAudioContext.js` is that "fix on JS side", and it is an
//     ASSUMPTION, not an ordering primitive:
//
//         this[kNapiObj][kOnComplete] = function (err, rawEvent) {
//           this.#renderedBuffer = new AudioBuffer({ … });   // ← only writer
//         };
//         async startRendering() {
//           await this[kNapiObj].startRendering();
//           await this.audioWorklet[kWorkletRelease]();
//           return this.#renderedBuffer;                     // ← starts null
//         }
//
//     `#renderedBuffer` is initialised to `null`, is written ONLY by that
//     callback, and is never checked. When the callback has not drained by the
//     time the promise settles, `startRendering()` RETURNS NULL — no throw, no
//     rejection, no warning.
//
// ⚠ THE NO-WORKLET GRAPHS ARE THE EXPOSED ONES. `kWorkletRelease` awaits a
// worker `exit` round-trip — a full macrotask turn of slack — but only when a
// worklet was actually added. A pure native graph (GainNode / WaveShaperNode /
// ConstantSourceNode — illogic, moog907a, moog914, the whole `renderOfflineDef`
// population) returns immediately, so it gets no slack at all.
//
// ---------------------------------------------------------------------------
// WHY THIS RECOVERS RATHER THAN JUST FAILING
// ---------------------------------------------------------------------------
//
// The buffer is not lost — it is late. The Rust side dispatches `complete`
// INSIDE `start_rendering().await` (web-audio-api-rs `context/offline.rs` sends
// the event and then calls `event_loop.handle_pending_events()` before
// returning), so the TSFN item is already queued when the promise settles. It
// will drain on a later turn, and the JS wrapper then propagates a `complete`
// event carrying THE SAME `AudioBuffer` instance `startRendering()` would have
// returned. Measured directly (forcing the inversion, DC 0.25 into a 2400-frame
// mono context): `startRendering()` → `null`, and the `complete` event two
// turns later → a 2400-frame buffer reading 0.25. Same data, no re-render, no
// fidelity question, nothing to re-pin.
//
// So this waits on the CONTEXT'S OWN EVENT — observable state, not a sleep, and
// it returns the instant the event arrives. `MAX_TURNS` is a give-up fence, not
// a timing guess: in practice the event lands on turn two (the wrapper itself
// defers propagation by one `setImmediate` after the callback runs).
//
// ⚠ AND IF IT NEVER ARRIVES, THE THROW NAMES THE CAUSE. The whole reason this
// file exists is that the un-guarded version reported
// `TypeError: Cannot read properties of null (reading 'getChannelData')` —
// a message that names neither the module, nor the render, nor the binding.

import { OfflineAudioContext } from 'node-web-audio-api';

/** Event-loop turns to wait for the late `complete` event before giving up.
 *  Not a duration — the wait ends on the event. Two turns is the observed
 *  cost; this is the fence. */
const MAX_TURNS = 64;

const INSTALLED = Symbol.for('art:start-rendering-completion-guard');

type RenderedBuffer = Awaited<ReturnType<OfflineAudioContext['startRendering']>>;

interface CompletionEvent {
  renderedBuffer?: RenderedBuffer;
}

/** What the context was asked to render — the only identity a prototype-level
 *  guard has. `renderOfflineDef` adds the module on top of it. */
function describe(ctx: OfflineAudioContext): string {
  const c = ctx as unknown as { length?: number; sampleRate?: number };
  return `length=${c.length ?? '?'} frames, sampleRate=${c.sampleRate ?? '?'} Hz`;
}

/**
 * Wrap `OfflineAudioContext.prototype.startRendering` so a lost race with the
 * `complete` threadsafe function recovers from the event instead of handing a
 * `null` to the caller. Idempotent — `setupFiles` re-enter per test file.
 */
export function installStartRenderingGuard(): void {
  const proto = OfflineAudioContext.prototype as OfflineAudioContext &
    Record<symbol, unknown>;
  if (proto[INSTALLED]) return;

  const original = proto.startRendering;

  async function guarded(this: OfflineAudioContext): Promise<RenderedBuffer> {
    let late: RenderedBuffer | null = null;
    const onComplete = (event: Event): void => {
      late = (event as unknown as CompletionEvent).renderedBuffer ?? null;
    };
    this.addEventListener('complete', onComplete);

    try {
      const rendered = await original.call(this);
      if (rendered) return rendered;

      for (let turn = 0; turn < MAX_TURNS && late === null; turn++) {
        await new Promise<void>((resolve) => {
          setImmediate(resolve);
        });
      }

      if (late !== null) {
        // Not silent: the frequency of this is the one thing the instrument
        // could not previously see, and a run that recovered is not the same
        // as a run that never raced.
        console.warn(
          `[art] OfflineAudioContext.startRendering() resolved null and the buffer ` +
            `was recovered from the context's own 'complete' event ` +
            `(${describe(this)}). This is the node-web-audio-api 1.0.9 ordering ` +
            `defect, not a graph defect — see art/setup/render-completion.ts.`,
        );
        return late;
      }

      throw new Error(
        `OfflineAudioContext.startRendering() resolved null and no 'complete' event ` +
          `arrived within ${MAX_TURNS} event-loop turns (${describe(this)}). ` +
          `In node-web-audio-api 1.0.9 the rendered buffer reaches JS through the ` +
          `'complete' threadsafe function, NOT through the promise — see ` +
          `art/setup/render-completion.ts. The render itself did not report an error.`,
      );
    } finally {
      this.removeEventListener('complete', onComplete);
    }
  }

  proto.startRendering = guarded;
  proto[INSTALLED] = true;
}

installStartRenderingGuard();
