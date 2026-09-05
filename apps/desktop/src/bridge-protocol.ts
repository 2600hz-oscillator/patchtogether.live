// ptNative bridge protocol — the ONE shape every renderer→main command uses.
//
// Why this exists before it has many callers. The P2 bridge grew as bare
// `ipcRenderer.invoke('pt:quit')` / `invoke('pt:helper-status')` with no
// version, no request id, no error envelope. That is fine for two read-only
// verbs and actively bad for what comes next: P1 (slot assign / unbind /
// retry), P4 (output↔display map), and P5 (pre-flight, device + display
// pickers) are all WRITE paths, and each one will invent its own ad-hoc invoke
// shape if there is no settled envelope to land in. Settling the shape is
// cheap now and expensive after three phases have each guessed.
//
// What is deliberately NOT here: the ops themselves. Declaring `assign` /
// `unbind` / `preflight` before the phase that implements them would be a
// contract nobody can honour — the plan's own contract row already drifted
// that way (it advertises a `slotBindings` get/subscribe that does not exist).
// Phases register their ops on the main-side dispatcher; this file owns the
// envelope, the version, the error vocabulary, and cancellation.
//
// SHAPE
//   command  {v, id, op, payload}
//   result   {v, id, ok:true,  result}
//          | {v, id, ok:false, error:{code, message, retryable}}
//   cancel   {v, id}                     (renderer → main, fire and forget)
//   event    {v, topic, payload}         (main → renderer, unsolicited)

/** Bumped only for a BREAKING envelope change. Handlers reject a mismatch
 *  rather than guessing — a shell and a preload from different builds is
 *  exactly the "is this thing mine?" question the port-ownership work asks on
 *  the socket side, and it deserves the same answer here. */
export const PT_BRIDGE_VERSION = 1;

export const PT_BRIDGE_CHANNELS = {
  command: 'pt:command',
  cancel: 'pt:command-cancel',
  event: 'pt:event',
} as const;

export type PtErrorCode =
  /** No handler registered for this op (a phase that has not shipped). */
  | 'unsupported-op'
  /** Envelope from a different bridge version. */
  | 'protocol-mismatch'
  /** Payload failed the op's own validation. */
  | 'bad-request'
  /** Sender is not the shell origin (see security.ipcSenderAllowed). */
  | 'denied'
  /** The caller aborted before the handler resolved. */
  | 'cancelled'
  /** Handler threw. */
  | 'internal';

export interface PtError {
  code: PtErrorCode;
  message: string;
  /** True when the SAME call is worth repeating (transient), false when it is
   *  not (denied, unsupported-op, bad-request). The pre-flight UI's retry
   *  affordance keys off this instead of string-matching messages. */
  retryable: boolean;
}

export interface PtCommand<P = unknown> {
  v: number;
  /** Correlation id — unique per call, echoed in the result and in cancel. */
  id: string;
  op: string;
  payload: P;
}

export interface PtCancel {
  v: number;
  id: string;
}

export type PtResult<R = unknown> =
  | { v: number; id: string; ok: true; result: R }
  | { v: number; id: string; ok: false; error: PtError };

export interface PtEvent<P = unknown> {
  v: number;
  topic: string;
  payload: P;
}

export function ptOk<R>(id: string, result: R): PtResult<R> {
  return { v: PT_BRIDGE_VERSION, id, ok: true, result };
}

export function ptErr(
  id: string,
  code: PtErrorCode,
  message: string,
  retryable = false,
): PtResult<never> {
  return { v: PT_BRIDGE_VERSION, id, ok: false, error: { code, message, retryable } };
}

/** Structurally validate an incoming command. Returns null when it is fine,
 *  or the error to send back. Runs in MAIN on renderer-supplied data. */
export function validateCommand(raw: unknown): PtError | null {
  if (typeof raw !== 'object' || raw === null) {
    return { code: 'bad-request', message: 'command must be an object', retryable: false };
  }
  const cmd = raw as Partial<PtCommand>;
  if (typeof cmd.id !== 'string' || cmd.id.length === 0) {
    return { code: 'bad-request', message: 'command.id must be a non-empty string', retryable: false };
  }
  if (typeof cmd.op !== 'string' || cmd.op.length === 0) {
    return { code: 'bad-request', message: 'command.op must be a non-empty string', retryable: false };
  }
  if (cmd.v !== PT_BRIDGE_VERSION) {
    return {
      code: 'protocol-mismatch',
      message: `bridge v${String(cmd.v)} != shell v${PT_BRIDGE_VERSION}`,
      retryable: false,
    };
  }
  return null;
}
