// packages/web/src/lib/audio/worklet-guard.ts
//
// THE SHARED WORKLET CONSTRUCTION SEAM — and the `processorerror` handler that
// makes a dead processor LOUD instead of silent.
//
// ── The mechanism (this is the "and then it stops" clause) ──────────────────
// Per the Web Audio spec, when an `AudioWorkletProcessor` throws:
//
//     "the processor (and thus the node) will output silence throughout its
//      lifetime."
//
// That is not degradation. It is a LATCH:
//   - PERMANENT for the life of the node — there is no recovery path;
//   - SILENT — with no `processorerror` handler registered, nothing is logged;
//   - INVISIBLE to `ctx.state`, which stays `'running'`, so the click-to-resume
//     overlay never appears and the user's only recourse is a page reload.
//
// The exposure is large: 64 DSP processors, 72 of 171 audio modules carry a
// worklet, and 27 modules are built TWICE under dual-mono. `processorerror` has
// been Baseline widely available since April 2021, and this repo had ZERO
// handlers for it (verified: `git grep processorerror` over `packages/web/src`
// + `packages/dsp/src` = 0 hits).
//
// ⚠ THIS IS A MECHANISM, NOT A DIAGNOSIS. Nobody has shown that a latched
// processor is what actually happened to the owner. Its value is that it costs
// almost nothing and it RULES THE CLASS IN OR OUT — which today we cannot even
// ask about. "The processor never threw" and "the handler was never wired"
// print identically, so the handler is negative-controlled in both directions
// in `worklet-guard.test.ts`.
//
// ── Why a shared seam and not a per-module sprinkle ─────────────────────────
// 62 call sites in `audio/modules/`, one in `engine.ts`, plus the Faust runtime.
// A per-module handler would be forgotten by the 63rd module. So construction
// routes through `createWorkletNode()`, and `worklet-guard.test.ts` enforces it
// at the SOURCE level, DENY-BY-DEFAULT with a named `(file, processor)`
// exemption per instance — a new unguarded node in an already-exempt file still
// reddens, and an exemption naming a site that no longer exists is RED too.
//
// ── Attribution ─────────────────────────────────────────────────────────────
// "Which processor" comes free (it is an argument). "Which module / which node"
// comes from the `owner` argument, which is the `ModuleNode` every audio
// factory already receives as its second parameter — so it is exact, with no
// ambient-context-across-`await` guesswork. Where no owner is available the
// record says `nodeId: undefined` rather than guessing.

/** The two attribution fields an audio-module factory already has in hand. */
export interface WorkletOwner {
  readonly id?: string;
  readonly type?: string;
}

export interface WorkletErrorRecord {
  /** Monotonic, so a probe can ask "since I looked" without clock skew. */
  readonly seq: number;
  /** The registered processor name — always known, it is a constructor arg. */
  readonly processor: string;
  /** The module def type, when an owner was supplied. */
  readonly moduleType?: string;
  /** The graph node id, when an owner was supplied. */
  readonly nodeId?: string;
  /** Best-effort message off the ErrorEvent; '' when the event carried none. */
  readonly message: string;
  /** `Date.now()` at the time the handler fired. */
  readonly at: number;
}

/** Bounded: a processor that throws every quantum must not grow this forever. */
const CAP = 256;

let seq = 0;
let log: WorkletErrorRecord[] = [];
const listeners = new Set<(r: WorkletErrorRecord) => void>();

/** The ledger, oldest first. */
export function workletErrorLog(): readonly WorkletErrorRecord[] {
  return log;
}

/** How many processors have latched this session. The footer reads this. */
export function workletErrorCount(): number {
  return seq;
}

/** Subscribe to latches (the UI badge / the health store). Returns unsubscribe. */
export function onWorkletError(fn: (r: WorkletErrorRecord) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** TEST SEAM: forget everything. Never called from app code. */
export function __resetWorkletErrorLedger(): void {
  seq = 0;
  log = [];
  listeners.clear();
}

/**
 * Record a latch. Exported so the negative control can drive it directly, and
 * so `worklet-guard.test.ts` can prove the LEDGER and the LISTENER move
 * independently of whether a real event ever fires.
 */
export function recordWorkletError(input: Omit<WorkletErrorRecord, 'seq' | 'at'>): WorkletErrorRecord {
  const rec: WorkletErrorRecord = { ...input, seq: ++seq, at: Date.now() };
  log.push(rec);
  if (log.length > CAP) log = log.slice(-CAP);
  // LOUD and ATTRIBUTABLE. This is the whole point — a latched processor is
  // permanent and irrecoverable, so the console line has to name the thing.
  console.error(
    `[worklet-guard] PROCESSOR LATCHED — "${rec.processor}"` +
      `${rec.moduleType ? ` on module ${rec.moduleType}` : ''}` +
      `${rec.nodeId ? ` (node ${rec.nodeId})` : ''}` +
      ' threw and will output SILENCE for the rest of its lifetime' +
      ' (Web Audio spec). Rebuild the module or reload the page.' +
      (rec.message ? ` — ${rec.message}` : ''),
  );
  for (const fn of Array.from(listeners)) {
    try {
      fn(rec);
    } catch (err) {
      console.error('[worklet-guard] error listener threw', err);
    }
  }
  return rec;
}

/** The minimum surface `guardWorkletNode` needs — so a unit test can pass a
 *  plain `EventTarget` and prove the wiring without an AudioContext. */
export interface ProcessorErrorTarget {
  addEventListener(type: 'processorerror', listener: (ev: Event) => void): void;
}

function messageOf(ev: Event): string {
  const e = ev as Partial<ErrorEvent>;
  if (typeof e.message === 'string' && e.message) return e.message;
  if (e.error instanceof Error) return e.error.message;
  return '';
}

/**
 * Attach the latch handler to an already-constructed node.
 *
 * Split out from `createWorkletNode` for the one case that cannot use it: the
 * Faust runtime, whose node is built by `FaustMonoAudioWorkletNode` inside
 * `@grame/faustwasm`. Returns the node so it can be used inline.
 */
export function guardWorkletNode<T extends ProcessorErrorTarget>(
  node: T,
  processor: string,
  owner?: WorkletOwner,
): T {
  try {
    node.addEventListener('processorerror', (ev: Event) => {
      recordWorkletError({
        processor,
        moduleType: owner?.type,
        nodeId: owner?.id,
        message: messageOf(ev),
      });
    });
  } catch {
    // An environment without addEventListener on the node (a stub context in a
    // unit test) must not break module construction. Instrumentation NEVER
    // changes audio behaviour, including in its own failure mode.
  }
  return node;
}

/**
 * Register an ADDITIONAL per-node reaction to a latch — used by the terminal
 * sink to fail over to its hard-clip path. Separate from `guardWorkletNode` so
 * the ledger entry is written by exactly one place, and so the source gate can
 * see recovery being wired.
 */
export function onWorkletNodeError(
  node: ProcessorErrorTarget,
  fn: (ev: Event) => void,
): void {
  try {
    node.addEventListener('processorerror', fn);
  } catch {
    /* see guardWorkletNode */
  }
}

/**
 * THE SEAM. Construct an `AudioWorkletNode` with the latch handler attached.
 *
 * Drop-in for `new AudioWorkletNode(ctx, name, options)` with the owner
 * prepended, so the migration is a pure textual substitution:
 *
 *     new AudioWorkletNode(ctx, 'x', {…})  →  createWorkletNode(node, ctx, 'x', {…})
 *
 * `owner` is the `ModuleNode` the factory received. Pass `null` only where
 * there genuinely is no graph node (the engine's internal gate-edge worklet).
 */
export function createWorkletNode(
  owner: WorkletOwner | null | undefined,
  ctx: BaseAudioContext,
  processor: string,
  options?: AudioWorkletNodeOptions,
): AudioWorkletNode {
  const node = new AudioWorkletNode(ctx, processor, options);
  return guardWorkletNode(node, processor, owner ?? undefined);
}
