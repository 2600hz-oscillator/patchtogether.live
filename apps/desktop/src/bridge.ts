// Main-side command dispatcher for the ptNative bridge.
//
// One `ipcMain.handle` for every renderer command, so sender validation is
// written ONCE and cannot be forgotten by the next phase that adds a verb —
// the previous shape (a fresh `ipcMain.handle` per verb, none of them checking
// `event.senderFrame`) made "forgot to validate" the default outcome.
//
// Registration is open: P1/P4/P5 call `register('slots.assign', handler)` and
// inherit the envelope, the sender gate, cancellation and the error vocabulary.

import { ipcMain, type IpcMainInvokeEvent, type WebContents } from 'electron';
import {
  PT_BRIDGE_CHANNELS,
  PT_BRIDGE_VERSION,
  ptErr,
  ptOk,
  validateCommand,
  type PtCancel,
  type PtCommand,
  type PtEvent,
  type PtResult,
} from './bridge-protocol';
import { ipcSenderAllowed } from './security';

// The sandboxed preload cannot `require` a relative module, so it re-declares
// the version and the channel names. This assertion is the seam that keeps the
// two copies honest: drift on either side is a typecheck failure, not a
// silently dead IPC channel discovered on stage. Both imports are TYPE-only —
// nothing here loads preload.js into main.
type PreloadChannels = typeof import('./preload')['PT_PRELOAD_CHANNELS'];
type PreloadVersion = typeof import('./preload')['PT_PRELOAD_BRIDGE_VERSION'];
type Exact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const _channelsAgree: Exact<PreloadChannels, typeof PT_BRIDGE_CHANNELS> = true;
const _versionsAgree: Exact<PreloadVersion, typeof PT_BRIDGE_VERSION> = true;
void _channelsAgree;
void _versionsAgree;

export interface PtHandlerContext {
  /** Aborts when the renderer cancels. Long-running ops MUST check it; short
   *  ones may ignore it and simply have their result dropped. */
  signal: AbortSignal;
  event: IpcMainInvokeEvent;
}

export type PtHandler = (payload: unknown, ctx: PtHandlerContext) => unknown | Promise<unknown>;

export class PtBridge {
  private readonly handlers = new Map<string, PtHandler>();
  private readonly inflight = new Map<string, AbortController>();

  constructor(private readonly shellOrigin: string) {}

  register(op: string, handler: PtHandler): void {
    this.handlers.set(op, handler);
  }

  /** Push an unsolicited event to a renderer, in the same envelope. */
  emit(contents: WebContents, topic: string, payload: unknown): void {
    if (contents.isDestroyed()) return;
    const ev: PtEvent = { v: PT_BRIDGE_VERSION, topic, payload };
    contents.send(PT_BRIDGE_CHANNELS.event, ev);
  }

  /**
   * The whole request path, as a method rather than a closure inside
   * `install()`.
   *
   * That is not decoration: the two arms most worth proving — a cancelled
   * long-running op, and a refusal of an off-origin sender — are unreachable
   * through the shipped op set (the only registered op returns instantly, and
   * the shell window is the shell origin by construction). Making them
   * reachable by adding a slow op or a hostile window to the PRODUCT would be
   * building the hole in order to prove the patch. So the harness drives THIS,
   * with handlers it owns. `event` is only ever read through
   * `ipcSenderAllowed`, hence the minimal structural type.
   */
  async dispatch(
    event: Pick<IpcMainInvokeEvent, 'senderFrame'>,
    raw: unknown,
  ): Promise<PtResult> {
    // The id is only trustworthy AFTER validation; before that, echo a
    // placeholder rather than reflecting arbitrary renderer data.
    const id = typeof (raw as PtCommand | undefined)?.id === 'string' ? (raw as PtCommand).id : '?';

    // Sender gate FIRST: an off-origin frame gets no envelope parsing, no
    // op lookup, and no hint about which ops exist.
    if (!ipcSenderAllowed(event, this.shellOrigin)) {
      console.error(
        `[shell:security] refused IPC command from non-shell frame: ${event.senderFrame?.url ?? '(none)'}`,
      );
      return ptErr(id, 'denied', 'sender is not the shell origin');
    }

    const bad = validateCommand(raw);
    if (bad) return { v: PT_BRIDGE_VERSION, id, ok: false, error: bad };

    const cmd = raw as PtCommand;
    const handler = this.handlers.get(cmd.op);
    if (!handler) return ptErr(cmd.id, 'unsupported-op', `no handler for op '${cmd.op}'`);

    // Request ids may be caller-chosen (that is how cancellation names a
    // call), so collisions are the caller's to avoid — and are reported,
    // never silently allowed to make one cancel abort two commands.
    if (this.inflight.has(cmd.id)) {
      return ptErr(cmd.id, 'bad-request', `request id '${cmd.id}' is already in flight`);
    }

    const controller = new AbortController();
    this.inflight.set(cmd.id, controller);
    try {
      const result = await handler(cmd.payload, {
        signal: controller.signal,
        event: event as IpcMainInvokeEvent,
      });
      if (controller.signal.aborted) return ptErr(cmd.id, 'cancelled', 'cancelled by caller');
      return ptOk(cmd.id, result);
    } catch (err) {
      if (controller.signal.aborted) return ptErr(cmd.id, 'cancelled', 'cancelled by caller');
      return ptErr(cmd.id, 'internal', err instanceof Error ? err.message : String(err), true);
    } finally {
      this.inflight.delete(cmd.id);
    }
  }

  /** Cancel path. Gated on the SAME sender rule as dispatch — otherwise an
   *  off-origin frame that cannot issue a command could still abort ours. */
  handleCancel(event: Pick<IpcMainInvokeEvent, 'senderFrame'>, raw: unknown): void {
    if (!ipcSenderAllowed(event, this.shellOrigin)) return;
    const msg = raw as Partial<PtCancel> | null;
    if (!msg || msg.v !== PT_BRIDGE_VERSION || typeof msg.id !== 'string') return;
    this.inflight.get(msg.id)?.abort();
  }

  install(): void {
    ipcMain.handle(PT_BRIDGE_CHANNELS.command, (event, raw: unknown) => this.dispatch(event, raw));
    ipcMain.on(PT_BRIDGE_CHANNELS.cancel, (event, raw: unknown) => this.handleCancel(event, raw));
  }
}
